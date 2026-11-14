"""Studio layout engine: geometry is consistent and the numbers follow from the brief."""
from __future__ import annotations

import math

import pytest

from app import layout_engine as L

GRID = {"price": [30 + (i % 12) * 3 for i in range(24)], "carbon": [350 + (i % 6) * 20 for i in range(24)]}
SITE = {"gates": [{"gate": "Residential proximity", "status": "Pass", "value": 400},
                  {"gate": "Grid proximity", "status": "Pass", "value": 1.5}]}


def brief(**kw):
    b = dict(mw_it=20, rack_kw=20, redundancy="N+1", cooling="liquid", site_w=320, site_d=240, setback_m=8,
             expansion_pct=10, flexible_share=0)
    b.update(kw)
    return b


def run(**kw):
    return L.generate(brief(**kw), SITE, GRID, {"money": 1, "people": 1, "planet": 1, "resources": 1})


def test_three_distinct_concepts_place_every_rack():
    r = run()
    assert r["brief"]["racks"] == 1000 and r["brief"]["halls"] == 4
    assert [c["id"] for c in r["concepts"]] == ["long-halls", "service-bands", "opposed-banks"]
    for c in r["concepts"]:
        assert c["metrics"]["placed_racks"] == 1000
        assert c["metrics"]["rack_positions"] >= 1000
        assert c["feasible"], c["checks"]
    assert len({c["metrics"]["footprint_m2"] for c in r["concepts"]}) > 1
    assert sorted(c["rank"] for c in r["concepts"]) == [1, 2, 3]


def test_rooms_stay_inside_the_building_and_do_not_overlap():
    for c in run()["concepts"]:
        b = c["building"]
        rooms = c["rooms"]
        for q in rooms:
            assert q["x"] >= b["x"] - 0.05 and q["y"] >= b["y"] - 0.05
            assert q["x"] + q["w"] <= b["x"] + b["w"] + 0.05 and q["y"] + q["d"] <= b["y"] + b["d"] + 0.05
        for i, a in enumerate(rooms):
            for o in rooms[i + 1:]:
                ox = min(a["x"] + a["w"], o["x"] + o["w"]) - max(a["x"], o["x"])
                oy = min(a["y"] + a["d"], o["y"] + o["d"]) - max(a["y"], o["y"])
                assert ox <= 0.05 or oy <= 0.05, (c["id"], a["code"], o["code"])


def test_rack_rows_sit_inside_their_hall():
    for c in run()["concepts"]:
        for h in (q for q in c["rooms"] if q["type"] == "data_hall"):
            assert sum(w["n"] for w in h["rows"]) == h["racks"]
            for w in h["rows"]:
                assert w["x"] >= h["x"] and w["x"] + w["w"] <= h["x"] + h["w"] + 0.05
                assert w["y"] >= h["y"] and w["y"] + w["d"] <= h["y"] + h["d"] + 0.05


def test_money_adds_up_and_flexibility_never_costs_more():
    flat, flex = run(), run(flexible_share=0.3)
    for a, b in zip(flat["concepts"], flex["concepts"]):
        m = a["money"]
        assert m["capex"] == pytest.approx(m["shell"] + m["equipment"] + m["distribution"] + m["interconnect"], abs=3)
        assert b["money"]["energy_per_year"] < a["money"]["energy_per_year"]
        assert b["money"]["energy_per_year_flat"] == a["money"]["energy_per_year"]
    assert flex["operating"]["price_flex"] < flex["operating"]["price_flat"]


def test_redundancy_and_cooling_change_the_design():
    n, two = run(redundancy="N"), run(redundancy="2N")
    assert two["brief"]["generators"] == 2 * n["brief"]["generators"]
    assert two["concepts"][0]["money"]["capex"] > n["concepts"][0]["money"]["capex"]
    air, liquid = run(cooling="air"), run(cooling="liquid")
    assert air["concepts"][0]["resources"]["energy_mwh_per_year"] > liquid["concepts"][0]["resources"]["energy_mwh_per_year"]
    water = run(cooling="water")
    assert water["concepts"][0]["resources"]["water_m3_per_year"] > liquid["concepts"][0]["resources"]["water_m3_per_year"]
    assert any(y["type"] == "yard_water" for y in water["concepts"][0]["yard"])


def test_a_site_that_is_too_small_is_reported_not_hidden():
    r = run(mw_it=60, site_w=200, site_d=150)
    assert not any(c["feasible"] for c in r["concepts"])
    assert any(not k["ok"] for k in r["concepts"][0]["checks"])


def test_noise_follows_distance():
    near = L.generate(brief(), {"gates": [{"gate": "Residential proximity", "value": 50}]}, GRID, {})
    far = L.generate(brief(), {"gates": [{"gate": "Residential proximity", "value": 800}]}, GRID, {})
    assert near["concepts"][0]["people"]["noise_at_home_dba"] > far["concepts"][0]["people"]["noise_at_home_dba"]
    unknown = L.generate(brief(), {"gates": []}, GRID, {})
    assert unknown["concepts"][0]["people"]["noise_at_home_dba"] is None
    assert math.isfinite(unknown["concepts"][0]["people"]["noise_at_boundary_dba"])
