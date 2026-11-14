"""Deal room: analyses, comparable selections, scenarios and the tool audit trail, in MongoDB Atlas.

Raw CoStar records stay in the local parcel store (the licensed kit is not copied to the cloud). What is saved here
are PlotStar's analyses of them, keyed by CoStar ids, with source lineage, so a deal can be reviewed later.

Collections (schema_version 1):
  costar_analyses   {kind, parcel_id, params, key, result, sources[], label, project_id, created_at, schema_version}
  comp_selections   {parcel_id, project_id, excluded[], basis, estimate, created_at}
  scenarios         {project_id, parcel_id, assumptions{}, note, created_at}
  audit_log         {tool, via, args, ok, ms, n_sources, error, at}
When Atlas is unreachable everything falls back to process memory and says so; nothing here blocks the analysis.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any

from . import config, store

SCHEMA_VERSION = 1
CACHE_TTL_S = 6 * 3600
_lock = threading.Lock()
_mem: dict[str, Any] = {"audit": deque(maxlen=500), "cache": {}, "docs": {"costar_analyses": [], "comp_selections": [], "scenarios": []}}
_db_override: Any = None
_indexed = False


def use(db: Any) -> None:
    """Tests inject a database (mongomock)."""
    global _db_override, _indexed
    _db_override, _indexed = db, False


def _db():
    global _indexed
    if _db_override is not None:
        db = _db_override
    else:
        col = store._collection()
        if col is None:
            return None
        db = col.database if hasattr(col, "database") else None
        if db is None:
            return None
    if not _indexed:
        try:
            db["costar_analyses"].create_index([("key", 1)], unique=True)
            db["costar_analyses"].create_index([("parcel_id", 1), ("kind", 1), ("created_at", -1)])
            db["costar_analyses"].create_index([("created_at", 1)], expireAfterSeconds=CACHE_TTL_S * 4)
            db["comp_selections"].create_index([("parcel_id", 1), ("created_at", -1)])
            db["scenarios"].create_index([("project_id", 1), ("created_at", -1)])
            db["audit_log"].create_index([("at", -1)])
            db["audit_log"].create_index([("tool", 1), ("at", -1)])
            _indexed = True
        except Exception:  # indexes are an optimisation; never block a request on them
            pass
    return db


def _now() -> datetime:
    return datetime.now(timezone.utc)


def status() -> dict[str, Any]:
    db = _db()
    return {"backend": "MongoDB Atlas" if db is not None else "process memory (Atlas unavailable)",
            "database": config.MONGODB_DB if db is not None else None, "schema_version": SCHEMA_VERSION}


# ---------------------------------------------------------------------------------------------- cache + analyses
def key(kind: str, params: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps({"k": kind, "p": params}, sort_keys=True, default=str).encode()).hexdigest()[:24]


def cached(kind: str, params: dict[str, Any]) -> dict[str, Any] | None:
    k = key(kind, params)
    db = _db()
    if db is not None:
        try:
            doc = db["costar_analyses"].find_one({"key": k}, {"_id": 0})
            if doc and doc["created_at"].replace(tzinfo=timezone.utc) > _now() - timedelta(seconds=CACHE_TTL_S):
                return doc["result"]
        except Exception:
            pass
    hit = _mem["cache"].get(k)
    return hit[1] if hit and time.time() - hit[0] < CACHE_TTL_S else None


def save_analysis(kind: str, params: dict[str, Any], result: dict[str, Any], parcel_id: str | None,
                  sources: list[Any], label: str | None, project_id: str | None = None) -> str:
    k = key(kind, params)
    doc = {"key": k, "kind": kind, "parcel_id": parcel_id, "params": params, "result": result, "sources": sources[:200],
           "label": label, "project_id": project_id, "created_at": _now(), "schema_version": SCHEMA_VERSION}
    _mem["cache"][k] = (time.time(), result)
    db = _db()
    if db is not None:
        try:
            db["costar_analyses"].replace_one({"key": k}, doc, upsert=True)
        except Exception:
            pass
    return k


def analyses(parcel_id: str | None = None, project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    q = {k: v for k, v in {"parcel_id": parcel_id, "project_id": project_id}.items() if v}
    db = _db()
    if db is not None:
        try:
            return [_clean(d) for d in db["costar_analyses"].find(q, {"_id": 0, "result": 0}).sort("created_at", -1).limit(limit)]
        except Exception:
            pass
    return []


# ---------------------------------------------------------------------------------------------- deal records
def _insert(coll: str, doc: dict[str, Any]) -> dict[str, Any]:
    doc = {**doc, "created_at": _now(), "schema_version": SCHEMA_VERSION}
    db = _db()
    if db is not None:
        try:
            db[coll].insert_one(dict(doc))
            return {"saved": True, "backend": "MongoDB Atlas"}
        except Exception as e:
            _mem["docs"][coll].append(doc)
            return {"saved": True, "backend": "process memory", "warning": f"Atlas write failed ({type(e).__name__})"}
    _mem["docs"][coll].append(doc)
    return {"saved": True, "backend": "process memory", "warning": "Atlas unavailable; kept until the API restarts"}


def save_comp_selection(parcel_id: str, excluded: list[str], basis: str | None, estimate: Any, project_id: str | None) -> dict[str, Any]:
    return _insert("comp_selections", {"parcel_id": parcel_id, "project_id": project_id, "excluded": excluded[:200],
                                       "basis": basis, "estimate": estimate})


def save_scenario(project_id: str, parcel_id: str | None, assumptions: dict[str, Any], note: str = "") -> dict[str, Any]:
    return _insert("scenarios", {"project_id": project_id, "parcel_id": parcel_id, "assumptions": assumptions, "note": note[:1000]})


def deal(project_id: str | None = None, parcel_id: str | None = None) -> dict[str, Any]:
    q = {k: v for k, v in {"project_id": project_id, "parcel_id": parcel_id}.items() if v}
    out: dict[str, Any] = {}
    db = _db()
    for coll in ("comp_selections", "scenarios"):
        rows: list[dict[str, Any]] = []
        if db is not None:
            try:
                rows = [_clean(d) for d in db[coll].find(q, {"_id": 0}).sort("created_at", -1).limit(50)]
            except Exception:
                rows = []
        rows += [_clean(d) for d in _mem["docs"][coll] if all(d.get(k) == v for k, v in q.items())]
        out[coll] = rows
    out["analyses"] = analyses(parcel_id, project_id)
    return out


# ---------------------------------------------------------------------------------------------- audit trail
def audit(tool: str, via: str, args: dict[str, Any], ok: bool, ms: float, n_sources: int, error: str | None) -> None:
    rec = {"tool": tool, "via": via, "args": _short(args), "ok": ok, "ms": round(ms, 1), "n_sources": n_sources,
           "error": (error or "")[:300] or None, "at": _now()}
    with _lock:
        _mem["audit"].appendleft(rec)
    db = _db()
    if db is not None:
        try:
            db["audit_log"].insert_one(dict(rec))
        except Exception:
            pass


def audit_log(limit: int = 100, tool: str | None = None) -> dict[str, Any]:
    db = _db()
    if db is not None:
        try:
            q = {"tool": tool} if tool else {}
            return {"backend": "MongoDB Atlas", "calls": [_clean(d) for d in db["audit_log"].find(q, {"_id": 0}).sort("at", -1).limit(limit)]}
        except Exception:
            pass
    calls = [_clean(d) for d in list(_mem["audit"]) if not tool or d["tool"] == tool][:limit]
    return {"backend": "process memory", "calls": calls}


def _short(args: dict[str, Any]) -> dict[str, Any]:
    out = {}
    for k, v in args.items():
        s = json.dumps(v, default=str)
        out[k] = v if len(s) <= 300 else s[:300] + "…"
    return out


def _clean(d: dict[str, Any]) -> dict[str, Any]:
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in d.items() if k != "_id"}
