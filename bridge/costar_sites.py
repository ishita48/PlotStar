"""Turn the CoStar hackathon kit into screened data center candidate sites.

    python bridge/costar_sites.py                       # kit in Data/costar-kit
    python bridge/costar_sites.py --kit PATH --no-fema  # skip the live flood queries

Reads the kit (never runs anything in it), keeps the Houston industrial, flex and
land properties, screens each one with the same gates as the website (FEMA flood
zone, homes nearby, grid access from web/data/houston-grid.json) and writes
web/data/costar-sites.json.

That file holds CoStar data, so it is gitignored: it stays on the demo laptop.
"""

import argparse
import base64
import collections
import csv
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOUSTON_MARKET = 14
KEEP_TYPES = {"Industrial", "Flex", "Land"}
FEMA = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
USER_AGENT = "SiteStar-hackathon/0.1"
HOMES_BUFFER_KM = 0.5   # same default as the website (team assumption)
SEARCH_KM = 3
KM_LAT = 111.32


def km_lon(lat):
    return 111.32 * math.cos(math.radians(lat))


class Enums:
    def __init__(self, path):
        self.e = json.loads(path.read_text())

    def __call__(self, enum, value):
        return self.e.get(enum, {}).get(str(value)) if value is not None else None


def pretty_subtype(sub, ptype):
    if not sub or sub == "Unknown":
        return ptype
    s = sub.split("_", 1)[-1]
    s = s.replace("RAndD", "R&D").replace("OrColdStorage", " or cold storage")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s).capitalize()


# ---------------------------------------------------------------- screening (mirrors web/js/screener.js)

class Grid:
    def __init__(self, path):
        g = json.loads(path.read_text())
        self.g = g
        self.bits = base64.b64decode(g["residential"]["bits"])

    def inside(self, lat, lon):
        b = self.g["bbox"]
        return b["south"] <= lat <= b["north"] and b["west"] <= lon <= b["east"]

    def homes_km(self, lat, lon):
        r, b = self.g["residential"], self.g["bbox"]
        r0 = math.floor((lat - b["south"]) / r["cell_lat"])
        c0 = math.floor((lon - b["west"]) / r["cell_lon"])
        span = math.ceil(SEARCH_KM / (r["cell_lat"] * KM_LAT)) + 1
        kx = km_lon(lat)
        best = None
        for row in range(r0 - span, r0 + span + 1):
            if not 0 <= row < r["rows"]:
                continue
            for col in range(c0 - span, c0 + span + 1):
                if not 0 <= col < r["cols"]:
                    continue
                i = row * r["cols"] + col
                if not (self.bits[i >> 3] >> (i & 7)) & 1:
                    continue
                la0 = b["south"] + row * r["cell_lat"]
                lo0 = b["west"] + col * r["cell_lon"]
                dy = max(la0 - lat, 0, lat - (la0 + r["cell_lat"])) * KM_LAT
                dx = max(lo0 - lon, 0, lon - (lo0 + r["cell_lon"])) * kx
                d = math.hypot(dx, dy)
                best = d if best is None or d < best else best
        return best if best is not None and best <= SEARCH_KM else None

    def substation(self, lat, lon):
        kx = km_lon(lat)
        best = None
        for slon, slat, kv, name, op in self.g["substations"]:
            d = math.hypot((slon - lon) * kx, (slat - lat) * KM_LAT)
            if best is None or d < best["km"]:
                best = {"km": round(d, 3), "kv": kv, "name": name}
        return best

    def line_km(self, lat, lon, kv="345"):
        kx = km_lon(lat)
        best = math.inf
        for flat in self.g["lines"][kv]:
            for i in range(0, len(flat) - 3, 2):
                ax, ay = (flat[i] - lon) * kx, (flat[i + 1] - lat) * KM_LAT
                bx, by = (flat[i + 2] - lon) * kx, (flat[i + 3] - lat) * KM_LAT
                dx, dy = bx - ax, by - ay
                l2 = dx * dx + dy * dy
                t = max(0.0, min(1.0, -(ax * dx + ay * dy) / l2)) if l2 else 0.0
                best = min(best, math.hypot(ax + t * dx, ay + t * dy))
        return round(best, 3)


def fema(lat, lon):
    q = urllib.parse.urlencode({
        "geometry": f"{lon:.6f},{lat:.6f}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF",
        "returnGeometry": "false", "f": "json",
    })
    req = urllib.request.Request(f"{FEMA}?{q}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            j = json.load(resp)
        feats = sorted((f["attributes"] for f in j.get("features", [])), key=lambda a: a.get("SFHA_TF") != "T")
        a = feats[0] if feats else {}
        return {"zone": a.get("FLD_ZONE"), "subtype": a.get("ZONE_SUBTY"), "sfha": a.get("SFHA_TF")}
    except Exception as exc:  # network trouble: leave it for review
        return {"error": str(exc)}


def flood_status(f):
    if f is None or "error" in f or not f.get("zone"):
        return "review"
    z, sub = f["zone"].upper(), (f.get("subtype") or "").upper()
    if "FLOODWAY" in sub or z.startswith(("A", "V")) or f.get("sfha") == "T" or z == "OPEN WATER":
        return "fail"
    return "review" if z == "D" else "pass"


# ---------------------------------------------------------------- build

def build(kit: Path, grid: Grid, use_fema: bool):
    en = Enums(kit / "schemas" / "enums.json")

    props = []
    with open(kit / "data" / "commercial-property.jsonl") as f:
        for line in f:
            r = json.loads(line)
            a = r.get("primaryAddress") or {}
            ptype = en("PropertyType", r.get("propertyType"))
            if a.get("researchMarketId") == HOUSTON_MARKET and ptype in KEEP_TYPES and a.get("latitude"):
                props.append(r)
    ids = {r["id"] for r in props}

    listings = collections.defaultdict(list)
    with open(kit / "data" / "commercial-listing-summary.jsonl") as f:
        for line in f:
            l = json.loads(line)
            if l.get("propertyId") in ids:
                listings[l["propertyId"]].append(l)

    models = collections.Counter()
    with open(kit / "commercial-properties.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("MatterportModelId") and row.get("PropertyId", "").isdigit() and int(row["PropertyId"]) in ids:
                models[int(row["PropertyId"])] += 1

    sites = []
    for n, r in enumerate(props, 1):
        a = r["primaryAddress"]
        lat, lon = a["latitude"], a["longitude"]
        ptype = en("PropertyType", r.get("propertyType"))
        block = r.get("propertyIndustrial") or r.get("propertyFlex") or {}
        el = block.get("electric") or {}
        unit = str(en("MeasurementUnit", r.get("lotSizeMeasurementType")) or "")
        lot = r.get("lotSize")
        acres = lot if "Acre" in unit else lot / 43560 if lot and "Feet" in unit else None
        years = [e.get("year") for e in r.get("constructionEvents") or [] if e.get("year")]
        street = " ".join(str(p) for p in (a.get("streetNumber"), a.get("streetName"), a.get("streetType")) if p)

        active = [l for l in listings.get(r["id"], []) if en("ListingStatus", l.get("listingStatus")) == "Active"]
        kinds = sorted({"for sale" if "Sale" in str(en("ListingType", l.get("listingType"))) or "Auction" in str(en("ListingType", l.get("listingType"))) else "for lease" for l in active})
        asking = [p for l in active for p in ((l.get("forSaleSummary") or {}).get("askingPriceLow"), (l.get("forSaleSummary") or {}).get("askingPriceHigh")) if p]

        inside = grid.inside(lat, lon)
        homes = grid.homes_km(lat, lon) if inside else None
        flood = fema(lat, lon) if use_fema else None
        if use_fema:
            time.sleep(0.15)  # be polite to FEMA's server
        fstat = flood_status(flood)
        hstat = "review" if not inside else "fail" if homes is not None and homes <= HOMES_BUFFER_KM else "pass"
        verdict = "fail" if "fail" in (fstat, hstat) else "review" if "review" in (fstat, hstat) else "pass"

        sites.append({
            "id": r["id"],
            "name": r.get("buildingName") or street or f"Property {r['id']}",
            "address": f"{street}, {a.get('city')}, {a.get('state')}".strip(", "),
            "city": a.get("city"),
            "lat": lat, "lon": lon,
            "type": ptype,
            "use": pretty_subtype(en("PropertySubtype", r.get("propertySubtype")), ptype),
            "lot_acres": round(acres, 2) if acres else None,
            "building_sf": r.get("rentableBuildingAreaSquareFeet") or r.get("grossBuildingAreaSquareFeet"),
            "year_built": min(years) if years else None,
            "zoning": r.get("zoningDescription"),
            "power": {
                "heavy": el.get("hasHeavyPower"),
                "amps": el.get("ampsHigh") or el.get("ampsLow"),
                "volts": el.get("voltsHigh") or el.get("voltsLow"),
                "phases": el.get("numElectricCurrentPhases"),
            },
            "listing": {"active": kinds, "asking_low": min(asking) if asking else None, "asking_high": max(asking) if asking else None},
            "parcels": (r.get("parcelNumbers") or [])[:3],
            "matterport_models": models.get(r["id"], 0),
            "screen": {
                "inside_map": inside,
                "flood": flood, "flood_status": fstat,
                "homes_km": None if homes is None else round(homes, 3), "homes_status": hstat,
                "substation": grid.substation(lat, lon) if inside else None,
                "line345_km": grid.line_km(lat, lon) if inside else None,
                "verdict": verdict,
            },
            "source": {"dataset": "CoStar Data Extract (HackPrinceton kit)", "file": "data/commercial-property.jsonl", "property_id": r["id"]},
        })
        if n % 20 == 0:
            print(f"  screened {n}/{len(props)}", flush=True)

    # Shortlist order: passes the gates, then heavy power, then lot size, then distance to 345 kV.
    heavy_rank = {True: 0, None: 1, False: 2}
    sites.sort(key=lambda s: (
        {"pass": 0, "review": 1, "fail": 2}[s["screen"]["verdict"]],
        heavy_rank.get(s["power"]["heavy"], 1),
        -(s["lot_acres"] or 0),
        s["screen"]["line345_km"] if s["screen"]["line345_km"] is not None else 99,
    ))
    for i, s in enumerate(sites, 1):
        s["rank"] = i

    c = collections.Counter(s["screen"]["verdict"] for s in sites)
    lots = [s["lot_acres"] for s in sites if s["lot_acres"]]
    summary = {
        "houston_properties_in_kit": None,
        "sites": len(sites),
        "by_type": dict(collections.Counter(s["type"] for s in sites)),
        "heavy_power": sum(1 for s in sites if s["power"]["heavy"] is True),
        "amps_2000_plus": sum(1 for s in sites if (s["power"]["amps"] or 0) >= 2000),
        "lots_10_acres_plus": sum(1 for a in lots if a >= 10),
        "largest_lot_acres": max(lots) if lots else None,
        "median_lot_acres": sorted(lots)[len(lots) // 2] if lots else None,
        "listed_now": sum(1 for s in sites if s["listing"]["active"]),
        "with_3d_scan": sum(1 for s in sites if s["matterport_models"]),
        "verdicts": dict(c),
        "flood_fails": sum(1 for s in sites if s["screen"]["flood_status"] == "fail"),
        "homes_fails": sum(1 for s in sites if s["screen"]["homes_status"] == "fail"),
        "pass_with_heavy_power": sum(1 for s in sites if s["screen"]["verdict"] == "pass" and s["power"]["heavy"] is True),
    }
    return sites, summary


def main():
    ap = argparse.ArgumentParser(description="Screen CoStar's Houston industrial sites for data center use")
    ap.add_argument("--kit", type=Path, default=ROOT / "Data" / "costar-kit")
    ap.add_argument("--grid", type=Path, default=ROOT / "web" / "data" / "houston-grid.json")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "data" / "costar-sites.json")
    ap.add_argument("--no-fema", action="store_true", help="skip live FEMA flood queries")
    args = ap.parse_args()

    if not (args.kit / "data" / "commercial-property.jsonl").exists():
        sys.exit(f"CoStar kit not found at {args.kit} (unzip it there first)")
    sites, summary = build(args.kit, Grid(args.grid), not args.no_fema)

    houston = 0
    with open(args.kit / "data" / "commercial-property.jsonl") as f:
        for line in f:
            if '"researchMarketId": 14' in line or '"researchMarketId":14' in line:
                houston += 1
    summary["houston_properties_in_kit"] = houston

    out = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "CoStar Data Extract, HackPrinceton Fall 2026 kit (Houston research market)",
        "screening": {
            "flood": "FEMA National Flood Hazard Layer, queried when this file was built",
            "homes": f"OpenStreetMap residential areas; fail within {int(HOMES_BUFFER_KM * 1000)} m (team assumption)",
            "grid": "OpenStreetMap substations and 345 kV lines (straight-line distance)",
            "shortlist_order": "passes the gates, then heavy power, then lot size, then distance to a 345 kV line",
        },
        "summary": summary,
        "sites": sites,
    }
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    print(json.dumps(summary, indent=1))
    print(f"Saved {args.out} ({args.out.stat().st_size // 1024} KB). It holds CoStar data: keep it out of git.")


if __name__ == "__main__":
    main()
