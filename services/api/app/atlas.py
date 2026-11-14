"""MongoDB Atlas as PlotStar's data platform: schema, geo, time-series, Atlas Search, Vector Search, change streams.

Collections (database `plotstar`):
  studio_projects  one document per Studio project (store.py) + a Gemini embedding for similarity
  sites            one document per screened CoStar parcel: GeoJSON location, gates, land price, provenance, embedding
  decisions        append-only audit trail of project events (written on every project save)
  grid_telemetry   TIME-SERIES collection of live hardware watts/progress (7-day TTL), written by livegrid.record
  grid_days        cached ERCOT day-ahead price days and the hourly carbon shape
  evidence         metadata of every external evidence fetch (FEMA, WRI Aqueduct, OpenStreetMap, ERCOT, Vexcel)

Every collection has a $jsonSchema validator. Atlas Search gives full-text + facets over sites; Vector Search
(768-d Gemini embeddings, cosine) finds similar sites and projects. Change streams feed a live SSE event feed.
All of it degrades to "unavailable" without MONGODB_URI, exactly like store.py. Nothing here computes a result
that the layout engine owns; this is storage, retrieval and analytics over what the engine and screens produced.
"""
from __future__ import annotations

import json
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import httpx

from . import config, store

EMBED_MODEL = "gemini-embedding-001"
EMBED_DIMS = 768
GEMINI = "https://generativelanguage.googleapis.com/v1beta/models"

# --------------------------------------------------------------------------------------------------- schema
# $jsonSchema validators: "moderate" level so documents that pre-date a rule are not rejected on update.
POINT = {"bsonType": "object", "required": ["type", "coordinates"],
         "properties": {"type": {"enum": ["Point"]},
                        "coordinates": {"bsonType": "array", "minItems": 2, "maxItems": 2, "items": {"bsonType": "double"}}}}
GATE = {"bsonType": "object", "required": ["gate", "status"],
        "properties": {"gate": {"bsonType": "string"}, "status": {"enum": ["Pass", "Fail", "Needs review"]},
                       "label": {"enum": ["Measured", "Sourced", "Estimated", "Simulated", "Unknown"]}}}
SCHEMAS: dict[str, dict[str, Any]] = {
    "studio_projects": {"bsonType": "object", "required": ["name", "market", "mw_it", "status", "updated_at"],
        "properties": {"name": {"bsonType": "string", "maxLength": 120}, "market": {"bsonType": "string"},
                       "mw_it": {"bsonType": ["double", "int", "long"], "minimum": 0, "maximum": 500},
                       "status": {"enum": ["draft", "generated", "decided"]},
                       "site": {"bsonType": "object", "properties": {"loc": POINT}},
                       "brief": {"bsonType": "object"}, "priorities": {"bsonType": "object"}, "edits": {"bsonType": "object"},
                       "history": {"bsonType": "array"}, "embedding": {"bsonType": "array"},
                       "updated_at": {"bsonType": "string"}, "created_at": {"bsonType": "string"}}},
    "sites": {"bsonType": "object", "required": ["parcel_id", "name", "market", "loc", "screen_status", "gates", "provenance"],
        "properties": {"parcel_id": {"bsonType": "string"}, "name": {"bsonType": "string"}, "market": {"bsonType": "string"},
                       "loc": POINT, "lot_acres": {"bsonType": ["double", "int", "null"]},
                       "land_cost": {"bsonType": ["double", "int", "long", "null"]},
                       "land_label": {"enum": ["Sourced", "Estimated", "Unknown", None]},
                       "screen_status": {"enum": ["Pass", "Fail", "Needs review"]},
                       "gates": {"bsonType": "array", "items": GATE}, "provenance": {"bsonType": "string"},
                       "embedding": {"bsonType": "array"}}},
    "decisions": {"bsonType": "object", "required": ["project_id", "event", "at"],
        "properties": {"project_id": {"bsonType": "string"}, "event": {"bsonType": "string"}, "at": {"bsonType": "date"},
                       "by": {"bsonType": ["string", "null"]}, "status": {"bsonType": ["string", "null"]}}},
    "grid_days": {"bsonType": "object", "required": ["date", "hub", "prices"],
        "properties": {"date": {"bsonType": "string"}, "hub": {"bsonType": "string"},
                       "prices": {"bsonType": "array", "minItems": 24, "maxItems": 24}, "carbon": {"bsonType": "array"}}},
    "evidence": {"bsonType": "object", "required": ["key", "source", "retrieved_at"],
        "properties": {"key": {"bsonType": "string"}, "source": {"bsonType": "string"}, "url": {"bsonType": "string"},
                       "retrieved_at": {"bsonType": "string"}, "payload_bytes": {"bsonType": ["int", "long"]}}},
}
SEARCH_INDEXES = [  # Atlas Search / Vector Search definitions (the free tier allows three)
    ("sites", "sites_search", "search", {"mappings": {"dynamic": False, "fields": {
        "name": {"type": "string"}, "address": {"type": "string"}, "property_type": {"type": "stringFacet"},
        "market": {"type": "stringFacet"}, "screen_status": {"type": "stringFacet"},
        "lot_acres": {"type": "number"}, "land_cost": {"type": "number"}}}}),
    ("sites", "sites_vec", "vectorSearch", {"fields": [
        {"type": "vector", "path": "embedding", "numDimensions": EMBED_DIMS, "similarity": "cosine"},
        {"type": "filter", "path": "market"}, {"type": "filter", "path": "screen_status"}]}),
    ("studio_projects", "projects_vec", "vectorSearch", {"fields": [
        {"type": "vector", "path": "embedding", "numDimensions": EMBED_DIMS, "similarity": "cosine"},
        {"type": "filter", "path": "market"}, {"type": "filter", "path": "status"}]}),
]


def _db():
    col = store._collection()  # reuses store's client, cooldown and reason
    return None if col is None else col.database


# --------------------------------------------------------------------------------------------------- embeddings
LOCAL_MODEL = "local-hashed-ngram-768"
LAST_EMBED_ERROR: str | None = None


def _gemini_embed(texts: list[str], task: str) -> list[list[float]] | None:
    """Gemini embeddings, paced for the free tier: small batches, backoff on 429. None on failure (reason in LAST_EMBED_ERROR)."""
    global LAST_EMBED_ERROR
    if not config.GEMINI_API_KEY or not texts:
        LAST_EMBED_ERROR = "GEMINI_API_KEY not set"
        return None
    out: list[list[float]] = []
    for i in range(0, len(texts), 8):
        chunk = texts[i:i + 8]
        for attempt in range(4):
            try:
                r = httpx.post(f"{GEMINI}/{EMBED_MODEL}:batchEmbedContents", headers={"x-goog-api-key": config.GEMINI_API_KEY},
                               json={"requests": [{"model": f"models/{EMBED_MODEL}", "content": {"parts": [{"text": t}]},
                                                   "outputDimensionality": EMBED_DIMS, "taskType": task} for t in chunk]}, timeout=60)
                if r.status_code == 429:
                    LAST_EMBED_ERROR = "Gemini quota (429)"
                    time.sleep(15 * (attempt + 1))
                    continue
                r.raise_for_status()
                out += [e["values"] for e in r.json()["embeddings"]]
                break
            except Exception as e:
                LAST_EMBED_ERROR = f"{type(e).__name__}: {str(e)[:120]}"
                time.sleep(3)
        else:
            return None
        if i + 8 < len(texts):
            time.sleep(1.5)
    return out


def _local_embed(texts: list[str]) -> list[list[float]]:
    """Fallback: signed hashing of word uni/bi-grams into 768 dims, L2-normalised. Lexical similarity only, not a
    neural model, and labelled as such wherever it is used."""
    import hashlib
    import math
    import re
    out = []
    for t in texts:
        v = [0.0] * EMBED_DIMS
        toks = re.findall(r"[a-z0-9]+", t.lower())
        for g in toks + [a + "_" + b for a, b in zip(toks, toks[1:])]:
            h = int(hashlib.blake2b(g.encode(), digest_size=8).hexdigest(), 16)
            v[h % EMBED_DIMS] += 1.0 if (h >> 63) & 1 == 0 else -1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / n for x in v])
    return out


def embedding_model() -> str | None:
    """Which model the stored vectors were made with (one model per index, so queries must match)."""
    db = _db()
    if db is None:
        return None
    m = db.meta.find_one({"_id": "embedding"})
    return m["model"] if m else None


def _embed(texts: list[str], task: str = "RETRIEVAL_DOCUMENT") -> list[list[float]] | None:
    """Embeddings for QUERIES: must use the same model as the stored documents. None if that model is unavailable."""
    if not texts:
        return None
    model = embedding_model()
    if model == LOCAL_MODEL:
        return _local_embed(texts)
    return _gemini_embed(texts, task)


def embed_docs(texts: list[str]) -> tuple[list[list[float]] | None, str | None]:
    """Embeddings for DOCUMENTS at seed time. Prefers Gemini; if it is unavailable (free-tier quota) falls back to
    the local hashed embedding and records the choice so every vector in the index shares one model."""
    db = _db()
    if db is None or not texts:
        return None, None
    stored = embedding_model()
    vecs = None if stored == LOCAL_MODEL else _gemini_embed(texts, "RETRIEVAL_DOCUMENT")
    model = EMBED_MODEL if vecs else LOCAL_MODEL
    if not vecs:
        vecs = _local_embed(texts)
    db.meta.update_one({"_id": "embedding"}, {"$set": {"model": model, "dims": EMBED_DIMS, "at": _now(),
                                                       "note": None if model == EMBED_MODEL else f"Gemini unavailable ({LAST_EMBED_ERROR}); lexical fallback"}}, upsert=True)
    return vecs, model


def site_text(s: dict[str, Any]) -> str:
    g = "; ".join(f"{x['gate']} {x['status']}" for x in s.get("gates", []))
    return (f"{s['name']}, {s.get('address') or ''}, {s['market']}. {s.get('property_type') or ''} "
            f"{s.get('property_subtype') or ''}. {s.get('lot_acres') or '?'} acres, {s.get('building_sf') or 0} sq ft building, "
            f"land {s.get('land_cost') or 'unknown'} USD. Screening {s['screen_status']}: {g}.")


def project_text(p: dict[str, Any]) -> str:
    b, sm, st = p.get("brief") or {}, p.get("summary") or {}, p.get("site") or {}
    return (f"{p['name']}: {p['mw_it']} MW IT data center, {b.get('cooling')} cooling, {b.get('redundancy')}, "
            f"{b.get('storeys', 1)} storeys at {st.get('name') or ''} {st.get('address') or ''}, {p['market']}. "
            f"Status {p['status']}; concept {sm.get('concept')}; capex {sm.get('capex')}; NPV {sm.get('npv')}. {p.get('reasons') or ''}")


# --------------------------------------------------------------------------------------------------- setup
def setup() -> dict[str, Any] | None:
    """Create collections, validators, indexes, the time-series collection and the search indexes. Idempotent."""
    db = _db()
    if db is None:
        return None
    existing = {c["name"]: c for c in db.list_collections()}
    report: dict[str, Any] = {"validators": [], "indexes": [], "search_indexes": [], "timeseries": None}
    for name, schema in SCHEMAS.items():
        if name not in existing:
            db.create_collection(name)
        db.command("collMod", name, validator={"$jsonSchema": schema}, validationLevel="moderate", validationAction="error")
        report["validators"].append(name)
    if "grid_telemetry" not in existing:
        db.create_collection("grid_telemetry", timeseries={"timeField": "ts", "metaField": "meta", "granularity": "seconds"},
                             expireAfterSeconds=7 * 86400)
    report["timeseries"] = "grid_telemetry"
    ix = [
        ("sites", [("loc", "2dsphere")], {}), ("sites", [("market", 1), ("screen_status", 1)], {}),
        ("sites", [("lot_acres", -1)], {}), ("sites", [("parcel_id", 1)], {"unique": True}),
        ("decisions", [("project_id", 1), ("at", -1)], {}), ("decisions", [("at", -1)], {}),
        ("grid_days", [("hub", 1), ("date", 1)], {"unique": True}), ("evidence", [("key", 1)], {"unique": True}),
        ("evidence", [("source", 1), ("retrieved_at", -1)], {}),
    ]
    for coll, keys, opts in ix:
        report["indexes"].append(f"{coll}:{db[coll].create_index(keys, **opts)}")
    have = {}
    for coll in {c for c, *_ in SEARCH_INDEXES}:
        try:
            have[coll] = {i["name"] for i in db[coll].list_search_indexes()}
        except Exception:
            have[coll] = set()
    from pymongo.operations import SearchIndexModel
    for coll, name, typ, definition in SEARCH_INDEXES:
        if name in have.get(coll, set()):
            report["search_indexes"].append(f"{coll}:{name} (exists)")
            continue
        try:
            db[coll].create_search_index(SearchIndexModel(definition=definition, name=name, type=typ))
            report["search_indexes"].append(f"{coll}:{name} (created)")
        except Exception as e:
            report["search_indexes"].append(f"{coll}:{name} FAILED {type(e).__name__}: {str(e)[:120]}")
    return report


# --------------------------------------------------------------------------------------------------- seeding
def seed_sites() -> dict[str, Any] | None:
    """Every screened CoStar parcel in both markets -> `sites`, with embeddings. Upserts, so it is safe to re-run."""
    db = _db()
    if db is None:
        return None
    from .routers.screen import Filters, SearchIn, run_search
    docs = []
    for market in ("Houston", "Los Angeles"):
        res = run_search(SearchIn(market=market, filters=Filters(min_acres=0.5), limit=300), offline=True)
        for s in res["sites"]:
            sc = s.get("screen") or {}
            docs.append(dict(
                parcel_id=s["id"], name=s["name"], address=s.get("area"), market=market,
                loc={"type": "Point", "coordinates": [float(s["lng"]), float(s["lat"])]},
                lot_acres=float(s["lotAcres"]) if s.get("lotAcres") else None,
                land_cost=float(s["landCost"]) if s.get("landCost") else None,
                land_label=(s.get("labels") or {}).get("landCost") or "Unknown", land_basis=s.get("landCostBasis"),
                property_type=s.get("propertyType"), property_subtype=s.get("propertySubtype"),
                building_sf=s.get("buildingSf"), availability=s.get("availability"),
                costar_property_id=s.get("costarPropertyId"), matterport_count=s.get("matterportCount", 0),
                supportable_mw=s.get("supportableMw"), screen_status=sc.get("status", "Needs review"),
                gates=[{k: g.get(k) for k in ("gate", "status", "value", "label", "source", "retrieved_at")} for g in sc.get("gates", [])],
                power=sc.get("power") or {}, evidence_gaps=sc.get("evidence_gaps") or [],
                provenance=s.get("provenance") or "CoStar Data Extract", updated_at=_now()))
    vecs, model = embed_docs([site_text(d) for d in docs])
    for i, d in enumerate(docs):
        if vecs:
            d["embedding"], d["embedding_model"] = vecs[i], model
        db.sites.update_one({"parcel_id": d["parcel_id"]}, {"$set": d}, upsert=True)
    return {"sites": len(docs), "embedded": bool(vecs), "embedding_model": model,
            "by_market": {m: sum(1 for d in docs if d["market"] == m) for m in ("Houston", "Los Angeles")}}


def embed_projects() -> int | None:
    db = _db()
    if db is None:
        return None
    rows = list(db.studio_projects.find({}, {"name": 1, "market": 1, "mw_it": 1, "status": 1, "brief": 1, "summary": 1, "site": 1, "reasons": 1}))
    vecs, model = embed_docs([project_text(p) for p in rows])
    if not vecs:
        return 0
    for p, v in zip(rows, vecs):
        db.studio_projects.update_one({"_id": p["_id"]}, {"$set": {"embedding": v, "embedding_model": model}})
    return len(rows)


def seed_grid_days() -> int | None:
    db = _db()
    if db is None:
        return None
    from . import grid
    hit = grid.dam_days(offline=True)
    fm = grid.fuel_mix_day(offline=True)
    carbon = fm["payload"]["carbon_kg_per_mwh"] if fm else None
    n = 0
    for d in (hit["payload"]["days"] if hit else []):
        db.grid_days.update_one({"hub": d["hub"], "date": d["date"]},
                                {"$set": {"prices": d["prices"], "carbon": carbon, "doc_id": d.get("doc_id"),
                                          "source": hit["source"], "retrieved_at": hit["retrieved_at"],
                                          "avg_price": sum(d["prices"]) / 24, "peak_price": max(d["prices"])}}, upsert=True)
        n += 1
    return n


def seed_evidence() -> int | None:
    """Mirror the metadata of every external fetch in the SQLite evidence cache (not the payloads)."""
    db = _db()
    if db is None:
        return None
    from .db import session
    n = 0
    with session() as c:
        for row in c.execute("SELECT key, source, url, retrieved_at, length(payload_json) AS b FROM evidence_cache"):
            db.evidence.update_one({"key": row["key"]}, {"$set": {"source": row["source"], "url": row["url"],
                                    "retrieved_at": row["retrieved_at"], "payload_bytes": int(row["b"] or 0),
                                    "kind": row["key"].split(":")[0]}}, upsert=True)
            n += 1
    return n


# --------------------------------------------------------------------------------------------------- writes from the app
def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def audit(project_id: str, event: str, doc: dict[str, Any]) -> None:
    """Append one decisions event. Best-effort; never raises into the caller."""
    try:
        db = _db()
        if db is None:
            return
        db.decisions.insert_one({"project_id": project_id, "event": event, "at": datetime.now(timezone.utc),
                                 "by": doc.get("decided_by") or None, "status": doc.get("status"),
                                 "preferred": doc.get("preferred"), "mw_it": doc.get("mw_it"),
                                 "summary": doc.get("summary") or {}})
    except Exception:
        pass


def embed_project(project_id: str, doc: dict[str, Any]) -> None:
    try:
        v = _embed([project_text({**doc, "name": doc["name"], "mw_it": doc["mw_it"], "market": doc["market"], "status": doc["status"]})])
        db = _db()
        if v and db is not None:
            db.studio_projects.update_one({"_id": project_id}, {"$set": {"embedding": v[0]}})
    except Exception:
        pass


def telemetry_point(machine: str, watts: float | None, progress: float | None, state: str | None, source: str, meter: str | None) -> None:
    """One time-series point, written off-thread so the hardware POST never waits on Atlas."""
    def go():
        try:
            db = _db()
            if db is not None:
                db.grid_telemetry.insert_one({"ts": datetime.now(timezone.utc), "meta": {"machine": machine, "source": source, "meter": meter},
                                              "watts": watts, "progress": progress, "state": state})
                from . import triggers  # ingest-time rule: time-series collections cannot have change streams or Atlas Triggers
                triggers.on_telemetry(machine, watts, state, source)
        except Exception:
            pass
    threading.Thread(target=go, daemon=True).start()


def chart_data() -> dict[str, Any] | None:
    """Series for the Data page charts, each one aggregation: watts per minute per machine, the latest ERCOT day,
    gate failures, and project capex vs NPV by cooling."""
    db = _db()
    if db is None:
        return None
    since = datetime.now(timezone.utc) - timedelta(hours=6)
    minutes = [{"minute": r["minute"].isoformat(timespec="minutes"), "machine": r["machine"], "avg_watts": r["avg_watts"],
                "max_watts": r.get("max_watts"), "points": r.get("points"), "source": r.get("source")}
               for r in db.grid_minutes.find({"minute": {"$gte": since}}, {"_id": 0}).sort("minute", 1)]
    raw = [{"ts": r["ts"].isoformat(timespec="seconds"), "machine": r["meta"]["machine"], "watts": r.get("watts")}
           for r in db.grid_telemetry.find({"ts": {"$gte": since}}, {"ts": 1, "meta.machine": 1, "watts": 1}).sort("ts", 1).limit(2000)]
    day = db.grid_days.find_one({}, {"_id": 0, "date": 1, "prices": 1, "carbon": 1, "hub": 1, "source": 1}, sort=[("date", -1)])
    fails = list(db.sites.aggregate([{"$unwind": "$gates"}, {"$match": {"gates.status": "Fail"}},
                                     {"$group": {"_id": "$gates.gate", "fails": {"$sum": 1}}}, {"$sort": {"fails": -1}},
                                     {"$project": {"_id": 0, "gate": "$_id", "fails": 1}}]))
    projects = list(db.studio_projects.aggregate([{"$match": {"summary.capex": {"$exists": True}}},
        {"$project": {"_id": 0, "id": "$_id", "name": 1, "mw_it": 1, "status": 1, "cooling": "$brief.cooling",
                      "capex": "$summary.capex", "npv": "$summary.npv"}}]))
    return {"telemetry_minutes": minutes, "telemetry_raw": raw, "price_day": day, "gate_fails": fails, "projects": projects,
            "computed_by": "Atlas aggregations"}


# --------------------------------------------------------------------------------------------------- reads
def status() -> dict[str, Any]:
    db = _db()
    if db is None:
        return {"available": False, "reason": store._state["reason"]}
    out: dict[str, Any] = {"available": True, "database": db.name, "collections": {}}
    for c in db.list_collections():
        name, opts = c["name"], c.get("options", {})
        coll = db[name]
        info: dict[str, Any] = {"documents": coll.estimated_document_count(),
                                "indexes": [i["name"] for i in coll.list_indexes()],
                                "validator": "$jsonSchema" in json.dumps(opts.get("validator", {})),
                                "timeseries": opts.get("timeseries")}
        try:
            info["search_indexes"] = [{"name": i["name"], "type": i.get("type", "search"), "status": i.get("status"),
                                       "queryable": i.get("queryable")} for i in coll.list_search_indexes()]
        except Exception:
            info["search_indexes"] = []
        out["collections"][name] = info
    out["embeddings"] = {"model": EMBED_MODEL, "dims": EMBED_DIMS, "enabled": bool(config.GEMINI_API_KEY)}
    return out


def search_sites(q: str, market: str | None = None, status_: str | None = None, limit: int = 10) -> dict[str, Any] | None:
    """Atlas Search: fuzzy full-text over name/address with facets on market, property type and screening status."""
    db = _db()
    if db is None:
        return None
    must = [{"text": {"query": q, "path": ["name", "address"], "fuzzy": {"maxEdits": 1}}}] if q.strip() else [{"exists": {"path": "name"}}]
    flt = []
    if market:
        flt.append({"text": {"query": market, "path": "market"}})
    if status_:
        flt.append({"text": {"query": status_, "path": "screen_status"}})
    op = {"compound": {"must": must, **({"filter": flt} if flt else {})}}
    hits = list(db.sites.aggregate([
        {"$search": {"index": "sites_search", **op, "highlight": {"path": ["name", "address"]}}},
        {"$limit": limit},
        {"$project": {"_id": 0, "parcel_id": 1, "name": 1, "address": 1, "market": 1, "lot_acres": 1, "land_cost": 1,
                      "screen_status": 1, "property_type": 1, "loc": 1, "score": {"$meta": "searchScore"},
                      "highlights": {"$meta": "searchHighlights"}}}]))
    meta = list(db.sites.aggregate([{"$searchMeta": {"index": "sites_search", "facet": {"operator": op, "facets": {
        "market": {"type": "string", "path": "market"}, "property_type": {"type": "string", "path": "property_type"},
        "screen_status": {"type": "string", "path": "screen_status"}}}}}]))
    facets = (meta[0].get("facet") if meta else {}) or {}
    return {"query": q, "hits": hits, "facets": {k: v.get("buckets", []) for k, v in facets.items()},
            "total": (meta[0].get("count", {}).get("lowerBound") if meta else len(hits)), "index": "sites_search"}


def similar_sites(q: str, market: str | None = None, limit: int = 5, passing_only: bool = False) -> dict[str, Any] | None:
    """Vector Search: embed the question with Gemini, then $vectorSearch over site embeddings."""
    db = _db()
    if db is None:
        return None
    v = _embed([q], task="RETRIEVAL_QUERY")
    if not v:
        return {"query": q, "hits": [], "note": "Embeddings unavailable (GEMINI_API_KEY)"}
    flt: dict[str, Any] = {}
    if market:
        flt["market"] = {"$eq": market}
    if passing_only:
        flt["screen_status"] = {"$eq": "Pass"}
    stage: dict[str, Any] = {"index": "sites_vec", "path": "embedding", "queryVector": v[0], "numCandidates": 100, "limit": limit}
    if flt:
        stage["filter"] = flt
    hits = list(db.sites.aggregate([{"$vectorSearch": stage},
        {"$project": {"_id": 0, "parcel_id": 1, "name": 1, "address": 1, "market": 1, "lot_acres": 1, "land_cost": 1,
                      "screen_status": 1, "property_type": 1, "loc": 1, "score": {"$meta": "vectorSearchScore"}}}]))
    return {"query": q, "hits": hits, "index": "sites_vec", "model": embedding_model(),
            "note": None if embedding_model() == EMBED_MODEL else "Lexical fallback embedding (Gemini quota exhausted); matches wording, not meaning."}


def similar_projects(project_id: str, limit: int = 4) -> dict[str, Any] | None:
    db = _db()
    if db is None:
        return None
    p = db.studio_projects.find_one({"_id": project_id}, {"embedding": 1, "name": 1})
    if not p or not p.get("embedding"):
        return {"project": project_id, "hits": [], "note": "No embedding stored for this project yet"}
    hits = list(db.studio_projects.aggregate([
        {"$vectorSearch": {"index": "projects_vec", "path": "embedding", "queryVector": p["embedding"], "numCandidates": 50, "limit": limit + 1}},
        {"$match": {"_id": {"$ne": project_id}}}, {"$limit": limit},
        {"$project": {"id": "$_id", "_id": 0, "name": 1, "market": 1, "mw_it": 1, "status": 1, "summary": 1, "score": {"$meta": "vectorSearchScore"}}}]))
    return {"project": p["name"], "hits": hits, "index": "projects_vec"}


def near_sites(lat: float, lon: float, km: float = 10, limit: int = 10, status_: str | None = None) -> list[dict[str, Any]] | None:
    """$geoNear on the 2dsphere index, with the real distance in metres."""
    db = _db()
    if db is None:
        return None
    stage: dict[str, Any] = {"near": {"type": "Point", "coordinates": [lon, lat]}, "distanceField": "distance_m",
                             "maxDistance": km * 1000, "spherical": True}
    if status_:
        stage["query"] = {"screen_status": status_}
    return list(db.sites.aggregate([{"$geoNear": stage}, {"$limit": limit},
        {"$project": {"_id": 0, "parcel_id": 1, "name": 1, "address": 1, "lot_acres": 1, "screen_status": 1, "land_cost": 1,
                      "distance_m": {"$round": ["$distance_m", 0]}, "loc": 1}}]))


def analytics() -> dict[str, Any] | None:
    """One $facet pipeline per collection: Atlas does the grouping, bucketing and averaging, not Python."""
    db = _db()
    if db is None:
        return None
    sites = list(db.sites.aggregate([{"$facet": {
        "by_market": [{"$group": {"_id": "$market", "sites": {"$sum": 1}, "acres": {"$sum": {"$ifNull": ["$lot_acres", 0]}},
                                  "passing": {"$sum": {"$cond": [{"$eq": ["$screen_status", "Pass"]}, 1, 0]}}}}, {"$sort": {"_id": 1}}],
        "by_status": [{"$group": {"_id": "$screen_status", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}],
        "lot_buckets": [{"$bucket": {"groupBy": {"$ifNull": ["$lot_acres", -1]}, "boundaries": [0, 5, 10, 20, 50, 100, 10000],
                                     "default": "unknown", "output": {"n": {"$sum": 1}}}}],
        "land_per_acre": [{"$match": {"land_cost": {"$gt": 0}, "lot_acres": {"$gt": 0}}},
                          {"$group": {"_id": "$market", "usd_per_acre": {"$avg": {"$divide": ["$land_cost", "$lot_acres"]}},
                                      "priced": {"$sum": 1}}}, {"$sort": {"_id": 1}}],
        "gate_fails": [{"$unwind": "$gates"}, {"$match": {"gates.status": "Fail"}},
                       {"$group": {"_id": "$gates.gate", "fails": {"$sum": 1}}}, {"$sort": {"fails": -1}}],
        "largest": [{"$match": {"lot_acres": {"$ne": None}}}, {"$sort": {"lot_acres": -1}}, {"$limit": 5},
                    {"$project": {"_id": 0, "name": 1, "address": 1, "lot_acres": 1, "market": 1, "screen_status": 1}}],
    }}]))[0]
    projects = list(db.studio_projects.aggregate([{"$facet": {
        "by_cooling": [{"$group": {"_id": "$brief.cooling", "n": {"$sum": 1}, "mw": {"$sum": "$mw_it"}}}, {"$sort": {"mw": -1}}],
        "by_redundancy": [{"$group": {"_id": "$brief.redundancy", "n": {"$sum": 1}}}],
        "npv_buckets": [{"$match": {"summary.npv": {"$exists": True}}},
                        {"$bucket": {"groupBy": "$summary.npv", "boundaries": [-1e10, -1e9, -5e8, -1e8, 0, 1e8, 1e10],
                                     "default": "other", "output": {"n": {"$sum": 1}}}}],
        "totals": [{"$group": {"_id": None, "projects": {"$sum": 1}, "mw": {"$sum": "$mw_it"},
                               "capex": {"$sum": {"$ifNull": ["$summary.capex", 0]}},
                               "decided": {"$sum": {"$cond": [{"$eq": ["$status", "decided"]}, 1, 0]}}}}, {"$project": {"_id": 0}}],
        "deciders": [{"$match": {"decided_by": {"$nin": ["", None]}}}, {"$group": {"_id": "$decided_by", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}],
    }}]))[0]
    grid = list(db.grid_days.aggregate([{"$group": {"_id": "$hub", "days": {"$sum": 1}, "avg_price": {"$avg": "$avg_price"},
                                                     "max_peak": {"$max": "$peak_price"}, "first": {"$min": "$date"}, "last": {"$max": "$date"}}}]))
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    tel = list(db.grid_telemetry.aggregate([{"$match": {"ts": {"$gte": since}}},
        {"$group": {"_id": "$meta.machine", "points": {"$sum": 1}, "avg_watts": {"$avg": "$watts"}, "max_watts": {"$max": "$watts"},
                    "last": {"$max": "$ts"}}}]))
    ev = list(db.evidence.aggregate([{"$group": {"_id": "$kind", "fetches": {"$sum": 1}, "bytes": {"$sum": "$payload_bytes"}}}, {"$sort": {"fetches": -1}}]))
    return {"sites": sites, "projects": projects, "grid_days": grid, "telemetry_24h": tel, "evidence": ev, "computed_by": "Atlas aggregation pipelines"}


def recent_decisions(limit: int = 20) -> list[dict[str, Any]] | None:
    db = _db()
    if db is None:
        return None
    out = []
    for d in db.decisions.find({}, {"_id": 0}).sort("at", -1).limit(limit):
        d["at"] = d["at"].isoformat(timespec="seconds") if isinstance(d["at"], datetime) else d["at"]
        out.append(d)
    return out


# --------------------------------------------------------------------------------------------------- change streams
def watch(stop: threading.Event, out: "queue.Queue[dict[str, Any]]", collections: tuple[str, ...] = ("studio_projects", "decisions", "sites")) -> None:
    """Tail the database change stream into a queue until `stop` is set. Runs in its own thread."""
    db = _db()
    if db is None:
        out.put({"type": "unavailable", "reason": store._state["reason"]})
        return
    pipeline = [{"$match": {"ns.coll": {"$in": list(collections)}}}]
    try:
        with db.watch(pipeline, full_document="updateLookup", max_await_time_ms=1000) as stream:
            out.put({"type": "open", "collections": list(collections), "at": _now()})
            while not stop.is_set():
                ch = stream.try_next()
                if ch is None:
                    continue
                doc = ch.get("fullDocument") or {}
                brief = {k: doc.get(k) for k in ("name", "market", "mw_it", "status", "preferred", "event", "project_id", "parcel_id", "screen_status") if k in doc}
                if "at" in doc and isinstance(doc["at"], datetime):
                    brief["at"] = doc["at"].isoformat(timespec="seconds")
                out.put({"type": ch["operationType"], "collection": ch["ns"]["coll"], "id": str((ch.get("documentKey") or {}).get("_id")),
                         "doc": brief, "at": _now()})
    except Exception as e:
        out.put({"type": "error", "error": f"{type(e).__name__}: {str(e)[:160]}"})


def events(timeout_s: float = 600) -> Iterator[dict[str, Any]]:
    """Generator of change events for an SSE response; heartbeats every 15 s."""
    q: "queue.Queue[dict[str, Any]]" = queue.Queue()
    stop = threading.Event()
    t = threading.Thread(target=watch, args=(stop, q), daemon=True)
    t.start()
    t0 = time.time()
    try:
        while time.time() - t0 < timeout_s:
            try:
                yield q.get(timeout=15)
            except queue.Empty:
                yield {"type": "heartbeat", "at": _now()}
    finally:
        stop.set()
