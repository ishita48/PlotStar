"""CoStar neighbours for the 3D view and portfolio screening, on a tiny synthetic store (no kit needed)."""
from __future__ import annotations

import math
import sqlite3
import threading

import pytest

from app import db as DB
from app.engine.screening import EARTH_R_M
from app.sponsors.costar import loader, neighbours as NB, portfolio as PF, tenancy

LAT0, LON0 = 29.80, -95.40


def _north(m: float) -> float:
    return LAT0 + math.degrees(m / EARTH_R_M)


def _east(m: float) -> float:
    return LON0 + math.degrees(m / (EARTH_R_M * math.cos(math.radians(LAT0))))


@pytest.fixture
def store(tmp_path, monkeypatch):
    path = tmp_path / "t.db"
    monkeypatch.setattr(DB, "DB_PATH", path)
    monkeypatch.setattr(tenancy, "ensure", lambda *a, **k: None)
    c = sqlite3.connect(path)
    c.executescript(loader.SCHEMA)
    c.executescript(tenancy.SCHEMA)

    def parcel(pid, lat, lon, **kw):
        row = dict(parcel_id=f"costar:{pid}", costar_property_id=pid, source_file="data/commercial-property.jsonl", source_row=pid,
                   loaded_at="2026-11-15", lat=lat, lon=lon, market="Houston") | {"availability": "Not listed"} | kw
        c.execute(f"INSERT INTO parcels ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values()))

    parcel(1, LAT0, LON0, name="Subject", property_type="Industrial", stories=1, building_sf=100_000.0)
    parcel(2, _north(300), LON0, name="Tall", property_type="Office", stories=4, building_sf=40_000.0, availability="For lease")
    parcel(3, LAT0, _east(400), name="No storeys", property_type="Flex", building_sf=20_000.0)
    parcel(4, _north(-200), LON0, name="Lot", property_type="Land", lot_acres=2.0)
    parcel(5, _north(5000), LON0, name="Far", property_type="Industrial", stories=1, building_sf=10_000.0)
    c.execute("INSERT INTO property_extra VALUES (2, 40000, 42000, 0, NULL, 2)")
    sp = dict(listing_id=9, property_id=2, kind="lease", listing_type="x", space_id=1, suite="A", space_use="Office", space_type="Relet",
              sf_min=1000, sf_max=10_000, rate_low=1.5, rate_high=2, rate_basis="Monthly", rate_per_sf_year_low=18.0,
              rate_per_sf_year_high=24.0, lease_pending=0, available_on=None, date_on_market=None, asking_price_low=None,
              asking_price_high=None, new_owner_can_occupy_sf=None, source_row=77)
    c.execute(f"INSERT INTO listing_spaces ({','.join(sp)}) VALUES ({','.join('?' * len(sp))})", list(sp.values()))
    c.commit()
    c.close()
    return path


def test_neighbours_shape_position_rent_and_availability(store):
    out = NB.for_parcel("costar:1", radius_m=800)
    by = {p["name"]: p for p in out["properties"]}
    assert set(by) == {"Tall", "No storeys", "Lot"}, "the subject itself and far properties are left out"
    tall = by["Tall"]
    assert abs(tall["north_m"] - 300) < 3 and abs(tall["east_m"]) < 1 and tall["distance_m"] == 300
    assert tall["height_m"] == 18.0 and tall["height_label"] == "Estimated" and "4 storeys" in tall["height_basis"]
    assert tall["rent_per_sf_year"] == 18.0 and tall["available_share"] == 0.25 and tall["listing_rows"] == [77]
    flex = by["No storeys"]
    assert flex["height_label"] == "Default" and flex["height_m"] == NB.DEFAULT_H and abs(flex["east_m"] - 400) < 3
    assert flex["rent_per_sf_year"] is None and flex["available_share"] == 0.0
    land = by["Lot"]
    assert land["height_m"] == NB.LAND_H and land["north_m"] < 0 and land["available_share"] is None
    assert out["ranges"]["rent"] == [18.0, 18.0] and out["counts"] == {"with_rent": 1, "with_availability": 2}
    assert NB.for_parcel("costar:999") is None


# ------------------------------------------------------------------------------------------------ portfolio

def _site(pid, status, overall, acres, fails=()):
    gates = [dict(gate=g, status="Fail" if g in fails else "Pass", value=1, unit="m", reason=f"{g} reason") for g in
             ("Residential proximity", "Flood exposure", "Grid proximity")]
    if status == "Needs review":
        gates[2]["status"] = "Needs review"
    return dict(id=pid, name=pid, area="a", lat=1.0, lng=2.0, lotAcres=acres, landCost=0, labels={"landCost": "Unknown"},
                screen=dict(status=status, gates=gates, power={}, evidence_gaps=[]), provenance="p",
                pillars=dict(people=overall, planet=overall, money=overall, overall=overall))


@pytest.fixture
def fake_engine(monkeypatch):
    PF._cache.clear()
    PF._sites.clear()
    calls = []
    data = {"Houston": [_site("costar:1", "Fail", 99, 50, fails=("Flood exposure",)), _site("costar:2", "Pass", 60, 8),
                        _site("costar:3", "Needs review", 80, 20)],
            "Los Angeles": [_site("costar:4", "Pass", 70, 12)]}
    monkeypatch.setattr(PF, "candidate_pool", lambda market, min_acres=0: [market])
    monkeypatch.setattr(PF, "assemble", lambda market, parcels, t, offline=False: calls.append(market) or data[market])
    return calls


def test_portfolio_ranks_gate_status_before_score_and_gives_reasons(fake_engine):
    out = PF.screen_portfolio()
    assert [r["parcel_id"] for r in out["rows"]] == ["costar:4", "costar:2", "costar:3", "costar:1"]
    assert [r["rank"] for r in out["rows"]] == [1, 2, 3, 4]
    assert out["counts"] == {"Pass": 2, "Needs review": 1, "Fail": 1}
    worst = out["rows"][-1]
    assert worst["hard_fails"] == ["Flood exposure"] and worst["pillars"]["overall"] == 99, "a failed hard gate ranks last whatever the score"
    assert worst["reasons"][0] == dict(gate="Flood exposure", status="Fail", reason="Flood exposure reason", hard=True)
    assert out["rows"][0]["reasons"][-1]["gate"] == "Passed"
    assert PF.site("costar:2")["id"] == "costar:2" and PF.site("costar:404") is None


def test_portfolio_screens_once_for_concurrent_and_filtered_requests(fake_engine):
    got = []
    ths = [threading.Thread(target=lambda: got.append(PF.screen_portfolio())) for _ in range(4)]
    [t.start() for t in ths]
    [t.join() for t in ths]
    assert fake_engine == ["Houston", "Los Angeles"], "four concurrent requests share one screen"
    big = PF.screen_portfolio(min_acres=10)
    assert [r["parcel_id"] for r in big["rows"]] == ["costar:4", "costar:3", "costar:1"] and [r["rank"] for r in big["rows"]] == [1, 2, 3]
    assert fake_engine == ["Houston", "Los Angeles"], "the lot filter reuses the cached screen"
    PF.screen_portfolio(refresh=True)
    assert len(fake_engine) == 4
