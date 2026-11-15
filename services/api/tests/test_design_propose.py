"""Design editor proposals: validation, sizing from stated figures, fallback order and what reaches the model.
No paid model calls: the model functions are replaced."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config
from app.engine import assumptions as A
from app.main import app
from app.routers import design_propose as P

client = TestClient(app)
CONCEPT = {
    "site_w": 320, "site_d": 240, "setback": 8,
    "building": {"x": 40, "y": 60, "w": 150, "d": 110},
    "yard": [{"code": "SUB-01", "type": "yard_sub", "x": 200, "y": 150, "w": 40, "d": 30},
             {"code": "GEN", "type": "yard_gen", "x": 200, "y": 60, "w": 24, "d": 70}],
    "checks": [{"name": "Nothing overlaps", "ok": True, "detail": "clear"}],
    # fields a careless client might add; the route must drop them
    "site_name": "1234 Example Rd", "lat": 29.7, "land_cost": 9_000_000,
}


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "test")
    monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "test")


def _fake(objects, reason="Placed."):
    return lambda prompt: ({"reason": reason, "objects": objects}, "gemini-test")


def test_mwh_sets_battery_area_from_engine_assumption(monkeypatch):
    monkeypatch.setattr(P, "_call_gemini", _fake([{"type": "yard_bess", "x": 246, "y": 150, "w": 20, "d": 10, "name": "", "h": 0}]))
    r = client.post("/design/propose", json={"text": "add an 8 MWh battery yard next to the substation", "concept": CONCEPT})
    assert r.status_code == 200, r.text
    o = r.json()["objects"][0]
    assert o["type"] == "yard_bess" and o["code"].startswith("AI-BESS")
    assert o["w"] * o["d"] == pytest.approx(8 / A.value("bess_mwh_per_m2"), rel=0.02)
    assert "8 MWh" in o["estimate"]
    assert r.json()["source"] == "Proposed by Gemini (gemini-test)"


def test_mw_without_duration_is_labelled_an_estimate(monkeypatch):
    monkeypatch.setattr(P, "_call_gemini", _fake([{"type": "yard_bess", "x": 246, "y": 150, "w": 20, "d": 10, "name": "", "h": 0}]))
    o = client.post("/design/propose", json={"text": "add a 2 MW battery", "concept": CONCEPT}).json()["objects"][0]
    assert "assumed" in o["estimate"] and "4 MWh" in o["estimate"]


def test_objects_are_kept_inside_the_setback_and_clear_of_plant(monkeypatch):
    monkeypatch.setattr(P, "_call_gemini", _fake([
        {"type": "yard_water", "x": 315, "y": -5, "w": 14, "d": 14, "name": "", "h": 0},   # outside the site
        {"type": "yard_guard", "x": 210, "y": 155, "w": 6, "d": 5, "name": "", "h": 0},    # on top of the substation
    ]))
    objs = client.post("/design/propose", json={"text": "a tank and a gatehouse", "concept": CONCEPT}).json()["objects"]
    for o in objs:
        assert o["x"] >= 8 and o["y"] >= 8 and o["x"] + o["w"] <= 312 and o["y"] + o["d"] <= 232
    tank, gate = objs
    assert any("setback" in n for n in tank["notes"])
    sub = CONCEPT["yard"][0]
    assert not (gate["x"] < sub["x"] + sub["w"] and gate["x"] + gate["w"] > sub["x"]
                and gate["y"] < sub["y"] + sub["d"] and gate["y"] + gate["d"] > sub["y"])
    assert any("SUB-01" in n for n in gate["notes"])


def test_unknown_types_are_dropped_and_custom_needs_a_height(monkeypatch):
    monkeypatch.setattr(P, "_call_gemini", _fake([
        {"type": "helipad", "x": 20, "y": 20, "w": 20, "d": 20, "name": "", "h": 0},
        {"type": "custom", "x": 20, "y": 200, "w": 8, "d": 8, "name": "Bike shelter", "h": 0},
    ]))
    res = client.post("/design/propose", json={"text": "bike shelter", "concept": CONCEPT}).json()
    assert res["dropped"] == 1 and len(res["objects"]) == 1
    o = res["objects"][0]
    assert o["name"] == "Bike shelter" and o["h"] > 0 and any("height" in n for n in o["notes"])


def test_claude_is_the_fallback(monkeypatch):
    def boom(prompt):
        raise RuntimeError("Gemini failed (HTTPStatusError)")
    monkeypatch.setattr(P, "_call_gemini", boom)
    monkeypatch.setattr(P, "_call_claude", lambda prompt: ({"reason": "r", "objects": [
        {"type": "yard_trees", "x": 8, "y": 220, "w": 304, "d": 12, "name": "", "h": 0}]}, "claude-test"))
    res = client.post("/design/propose", json={"text": "tree buffer along the north boundary", "concept": CONCEPT}).json()
    assert res["source"] == "Proposed by Claude (claude-test)" and "Gemini was unavailable" in res["notes"][0]


def test_both_models_down_is_an_error_not_a_guess(monkeypatch):
    def boom(prompt):
        raise RuntimeError("down")
    monkeypatch.setattr(P, "_call_gemini", boom)
    monkeypatch.setattr(P, "_call_claude", boom)
    assert client.post("/design/propose", json={"text": "add parking", "concept": CONCEPT}).status_code == 502


def test_only_geometry_reaches_the_model(monkeypatch):
    seen = {}
    def spy(prompt):
        seen["p"] = prompt
        return {"reason": "r", "objects": [{"type": "sensor", "x": 30, "y": 30, "w": 1, "d": 1, "name": "", "h": 0}]}, "g"
    monkeypatch.setattr(P, "_call_gemini", spy)
    assert client.post("/design/propose", json={"text": "add a sensor", "concept": CONCEPT}).status_code == 200
    assert "Example Rd" not in seen["p"] and "29.7" not in seen["p"] and "9000000" not in seen["p"]
    assert "SUB-01" in seen["p"] and "SOUTH-WEST" in seen["p"]


def test_figures_parser():
    f = P._figures
    assert f("a 4 MWh battery") == {"mwh": 4.0}
    assert f("2 MW battery for 4 hours")["hours"] == 4 and f("2 MW battery for 4 hours")["mw"] == 2
    assert f("500 kWp solar canopy")["mw"] == 0.5
    assert f("a 1,000 m3 tank")["m3"] == 1000
    assert f("parking for 60 cars")["spaces"] == 60
