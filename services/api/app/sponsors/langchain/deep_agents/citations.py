"""CoStar citations for an agent answer: every CoStar figure in the answer, tied to its record id and field.

Runs locally after the answer is written, over the full CoStar tool outputs kept as evidence (never over what the
model saw, and never traced: this function is deliberately not @traceable, because it reads kit data). For each number
in the answer it finds the CoStar evidence leaves with that value (allowing the rounding and $M / k scaling the
verification step allows) and cites the record (`costar:<PropertyId>`), the field, the value and the source row. Every
CoStar evidence id the answer cites (E3, ...) also gets a citation for the record it describes.

The UI renders each citation as a chip that opens the CoStar dossier for that record.
"""
from __future__ import annotations

import re
from typing import Any, Iterator

from app.provenance import FIELD_SOURCES

_NUM = re.compile(r"(?<![A-Za-z])-?\d[\d,]*(?:\.\d+)?")
_RECORD_KEYS = ("parcel_id", "costar_property_id", "property_id")
_SKIP = {"costar_property_id", "property_id", "source_row", "listing_rows", "rows", "ms", "mcp_ms", "rank", "n", "count", "id", "lat", "lon", "lng", "east_m",
         "north_m", "seq", "t", "at", "submarket_id", "market_id", "county_id", "asking_listing_id", "last_sale_comp_id",
         "comp_id", "entity_id", "listing_id", "space_id", "tenant_location_id"}
MAX_PER_FIGURE = 1
MAX_CITATIONS = 16
# What counts as a CoStar record field (rather than a GeoStar-computed value inside a CoStar tool's output): a fact row
# tagged Sourced, a parcel field with a provenance mapping, or a field named like the kit's own measures.
_COSTAR_FIELD = re.compile(r"(^|_)(price|rent|rate|acres|sf|sqft|year_built|stories|asking|sold|sale|amps|volts|units|"
                           r"ceiling_height_ft|tenancies|occupied|vacant|available)($|_)")
_GEOSTAR_FIELD = re.compile(r"^(min|max|need|limit|threshold|required|target)_|_(dc|needed|required|limit)$|"
                            r"score|ratio|share|coverage|npv|capex")


def is_costar_field(lf: dict[str, Any]) -> bool:
    f = lf["field"]
    if str(lf.get("tag") or "").startswith("Sourced") and lf.get("label"):
        return True
    return f in FIELD_SOURCES or (bool(_COSTAR_FIELD.search(f)) and not _GEOSTAR_FIELD.search(f))


def _record_of(d: dict[str, Any], current: str | None) -> str | None:
    for k in _RECORD_KEYS:
        v = d.get(k)
        if isinstance(v, str) and v.startswith("costar:"):
            return v
        if isinstance(v, int) and not isinstance(v, bool) and k in ("costar_property_id", "property_id"):
            return f"costar:{v}"
    return current


def leaves(data: Any, record: str | None = None, path: str = "", source: str | None = None) -> Iterator[dict[str, Any]]:
    """Numeric leaves of a CoStar tool output with the record they belong to, the field name and the nearest source."""
    if isinstance(data, dict):
        record = _record_of(data, record)
        src = data.get("source") if isinstance(data.get("source"), str) else data.get("property") if isinstance(data.get("property"), str) else source
        if data.get("source_row") is not None:
            src = f"{data.get('source_file') or 'CoStar Data Extract'} row {data['source_row']}"
        if "key" in data and "value" in data and isinstance(data.get("key"), str):  # facts: {key, label, value, tag}
            v = data["value"]
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                yield dict(record=record, field=data["key"], label=data.get("label"), value=v, tag=data.get("tag"), source=src, path=path)
            return
        for k, v in data.items():
            if k in _SKIP:
                continue
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                yield dict(record=record, field=k, label=None, value=v, tag=None, source=src, path=f"{path}.{k}".strip("."))
            elif isinstance(v, (dict, list)):
                yield from leaves(v, record, f"{path}.{k}".strip("."), src)
    elif isinstance(data, list):
        for i, x in enumerate(data[:400]):
            yield from leaves(x, record, f"{path}[{i}]", source)


def _figures(text: str) -> list[tuple[str, float]]:
    out = []
    for m in _NUM.finditer(re.sub(r"\bE\d+\b|costar:\d+", "", text)):  # evidence ids and record ids are not figures
        try:
            out.append((m.group(0), float(m.group(0).replace(",", ""))))
        except ValueError:
            pass
    return out


def _match(x: float, v: float) -> bool:
    ax, av = abs(x), abs(v)
    if av == 0:
        return False
    for scale in (1.0, 1e6, 1e3, 0.01):
        y = av / scale
        if abs(ax - y) <= max(0.051 if y < 100 else 0.51, 0.006 * y):
            return True
    return False


def cite(evidence: dict[str, dict[str, Any]], answer: str) -> list[dict[str, Any]]:
    """Citations for `answer` from the run's evidence (id -> {tool, provider, data, ...})."""
    costar = {eid: e for eid, e in evidence.items() if str(e.get("provider", "")).startswith("costar") and e.get("data") is not None}
    if not costar or not answer:
        return []
    pool = [(eid, e["tool"], lf) for eid, e in costar.items() for lf in leaves(e["data"]) if lf["record"] and is_costar_field(lf)]
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add(c: dict[str, Any]) -> None:
        key = (c["record_id"], c["field"])
        if key not in seen and len(out) < MAX_CITATIONS:
            seen.add(key)
            out.append(c)

    for text, x in _figures(answer):
        if abs(x) <= 10 and float(x).is_integer():
            continue  # small counts match too much by chance; the verification step treats them the same way
        hits = [(eid, tool, lf) for eid, tool, lf in pool if _match(x, float(lf["value"]))]
        hits.sort(key=lambda h: (h[2]["field"] not in FIELD_SOURCES, h[2]["tag"] is None, len(h[2]["path"])))
        for eid, tool, lf in hits[:MAX_PER_FIGURE]:
            add(dict(kind="figure", figure=text, evidence_id=eid, tool=tool, record_id=lf["record"], field=lf["field"],
                     label=lf["label"] or lf["field"].replace("_", " "), value=lf["value"], tag=lf["tag"] or "Sourced",
                     source=lf["source"], audit=lf["field"] in FIELD_SOURCES))
    for eid in sorted(set(re.findall(r"\bE\d+\b", answer)), key=lambda s: int(s[1:])):
        e = costar.get(eid)
        if not e:
            continue
        rec = next((lf["record"] for lf in leaves(e["data"]) if lf["record"]), None)
        if rec is None and isinstance(e["data"], dict):
            rec = _record_of(e["data"], None)
        if rec:
            add(dict(kind="evidence", figure=None, evidence_id=eid, tool=e["tool"], record_id=rec, field="record",
                     label=f"{e['tool'].replace('_', ' ')} record", value=None, tag=e.get("label") or "Sourced",
                     source=(e.get("sources") or [None])[0], audit=False))
    return out
