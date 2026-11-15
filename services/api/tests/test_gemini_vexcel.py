"""Gemini x Vexcel: obstacle mapping, drone frames, PDF Q&A, renders, neighbour heights, the Gemini specialist.

Every HTTP call (Gemini and Vexcel) is mocked; no key is needed and nothing is spent.
"""
from __future__ import annotations

import base64
import io
import json
import math

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config
from app.sponsors.gemini import client as G
from app.sponsors.gemini import documents, render, vision
from app.sponsors.vexcel import routes as vx

LAT, LON, Z = 30.0, -95.0, 21


def _meta(buffer_m: float) -> dict:
    """XMP-like metadata for an ortho exactly 2 x buffer wide, centred on (LAT, LON), like Vexcel returns."""
    world = 256.0 * 2 ** Z
    la = math.radians(LAT)
    cx = (LON + 180) / 360 * world
    cy = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * world
    half = buffer_m / (vx.EARTH_M_PER_PX0 * math.cos(la) / 2 ** Z)
    return {"pixel-bbox": f"{cx - half:.0f},{cy - half:.0f},{2 * half:.0f},{2 * half:.0f}", "max-zoom": str(Z),
            "center_lat": LAT, "center_lon": LON, "buffer_m": buffer_m, "collection": "test-2026",
            "last-capture-date": "2026-01-01"}


def _jpeg(w: int = 800, h: int = 800) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 120, 80)).save(buf, "JPEG")
    return buf.getvalue()


def _gemini_json(payload: dict) -> httpx.Response:
    body = {"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]}}],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5}}
    return httpx.Response(200, json=body, request=httpx.Request("POST", "https://x"))


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(vision, "CACHE", tmp_path / "gemini")
    monkeypatch.setattr(render, "CACHE", tmp_path / "renders")
    monkeypatch.setattr(render, "BLOCKED", tmp_path / "renders" / "image_blocked.json")
    monkeypatch.setattr(vx, "CACHE", tmp_path / "vexcel")
    monkeypatch.setattr(G, "_MODELS", {"at": 1e18, "list": [{"name": G.IMAGE_MODEL, "methods": ["generateContent"]},
                                                           {"name": G.VISION_MODEL, "methods": ["generateContent"]}]})


# ------------------------------------------------------------------------------------------------ the site frame

def test_ortho_frame_is_exact_from_pixel_bbox():
    f = vx.ortho_frame(_meta(190), (800, 800))
    assert f["exact"] is True
    assert f["west"] == pytest.approx(-190, abs=0.2) and f["east"] == pytest.approx(190, abs=0.2)
    assert f["north"] == pytest.approx(190, abs=0.2) and f["south"] == pytest.approx(-190, abs=0.2)
    assert f["m_per_px"] == pytest.approx(380 / 800, rel=1e-3)
    # no pixel-bbox: an honest fallback
    assert vx.ortho_frame({"buffer_m": 100, "center_lat": LAT, "center_lon": LON}, (400, 400))["exact"] is False


def test_box_maps_to_south_west_origin_with_y_north():
    frame = {"west": -100.0, "north": 100.0, "m_per_px": 0.5}
    crop = (0, 0, 400, 400)  # the whole 200 m image
    # Gemini's top-left quarter (rows from the top) is the north-west quarter of the ground
    w, s, e, n = vision.box_to_local([0, 0, 500, 500], crop, frame)
    assert (w, s, e, n) == pytest.approx((-100, 0, 0, 100))
    o = vision.to_site(w, s, e, n, 120, 80)  # a 120 x 80 m site centred on the point
    assert o == {"x": 0.0, "y": 40.0, "w": 60.0, "d": 40.0}  # SW corner of the box is (0, 40): north half, west half
    assert vision.to_site(-100, -100, -90, -90, 120, 80) is None  # entirely outside the rectangle


def test_find_obstacles_end_to_end(monkeypatch):
    monkeypatch.setattr(vx, "_ortho", lambda ref, buf, *a: (_jpeg(), _meta(buf)))
    sent = {}

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        sent.update(url=url, body=json)
        return _gemini_json({"scene": "A paved lot with one shed.", "items": [
            {"kind": "building", "label": "shed", "box_2d": [0, 0, 500, 500], "confidence": 0.9},
            {"kind": "road", "label": "street", "box_2d": [0, 0, 1000, 1000], "confidence": 0.8},
            {"kind": "trees", "label": "far trees", "box_2d": [0, 0, 5, 5], "confidence": 0.7},
        ]})

    monkeypatch.setattr(G.httpx, "post", fake_post)
    r = vision.find_obstacles("costar:1", 200, 100)
    assert sent["url"].endswith(f"{G.VISION_MODEL}:generateContent")
    gen = sent["body"]["generationConfig"]
    assert gen["responseMimeType"] == "application/json" and "items" in gen["responseJsonSchema"]["properties"]
    parts = sent["body"]["contents"][0]["parts"]
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg"
    assert "costar" not in json.dumps(sent["body"]).lower()  # no ids, names or coordinates to Gemini
    shed, road = r["obstacles"]
    assert shed["source"] == "Gemini on Vexcel ortho" and shed["kind"] == "building"
    # the crop is the 200 x 100 site + a 12 m margin; its NW quarter -> x 0..~100, y ~50..100 in the site frame
    assert shed["x"] == pytest.approx(0, abs=0.6) and shed["w"] == pytest.approx(100, abs=1.5)
    assert shed["y"] == pytest.approx(50, abs=1.5) and shed["y"] + shed["d"] == pytest.approx(100, abs=0.6)
    assert shed["suggest_keep"] is True
    assert road["suggest_keep"] is False and road["clipped"] is True  # box over the whole site starts discarded
    assert r["outside_site"] == 1  # the far trees sit in the margin, outside the rectangle
    assert r["mapping"]["image_footprint"] == "exact"
    assert r["image"]["x0"] == pytest.approx(100 - 190, abs=0.2) and r["image"]["y1"] == pytest.approx(50 + 190, abs=0.2)
    # cached: a second call does not reach Gemini
    monkeypatch.setattr(G.httpx, "post", lambda *a, **k: pytest.fail("should be cached"))
    assert vision.find_obstacles("costar:1", 200, 100)["cached"] is True


def test_describe_frame_boxes_normalised(monkeypatch):
    monkeypatch.setattr(G.httpx, "post", lambda *a, **k: _gemini_json({
        "summary": "A car park.", "ground": "asphalt", "visibility": "good",
        "hazards": [{"kind": "vehicle", "label": "van", "severity": "medium", "why": "moving", "box_2d": [100, 200, 300, 600]}]}))
    r = vision.describe_frame(_jpeg(640, 480))
    h = r["hazards"][0]
    assert h["box"] == pytest.approx({"x": 0.2, "y": 0.1, "w": 0.4, "h": 0.2})
    assert r["label"] == "AI-detected"


# ------------------------------------------------------------------------------------------------ documents

def test_pdf_upload_and_cited_answer(monkeypatch):
    calls = []

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        calls.append(json)
        if len(calls) == 1:
            return _gemini_json({"title": "LI-2", "kind": "zoning", "pages": 2, "summary": "s", "topics": ["height"],
                                 "suggested_questions": ["q"]})
        return _gemini_json({"found": True, "answer": "75 feet.", "citations": [{"page": 2, "quote": "75 feet"},
                                                                                 {"page": 9, "quote": "bogus"}]})

    monkeypatch.setattr(G.httpx, "post", fake_post)
    pdf = b"%PDF-1.4\n1 0 obj <</Type /Page>> endobj 2 0 obj <</Type /Page>> endobj 3 0 obj <</Type /Pages>> endobj"
    d = documents.add("zoning.pdf", pdf)
    assert d["pages"] == 2 and d["pages_from"] == "PDF page objects"
    assert calls[0]["contents"][0]["parts"][0]["inline_data"]["mime_type"] == "application/pdf"
    a = documents.ask(d["id"], "Maximum height?")
    assert a["found"] and [c["page_ok"] for c in a["citations"]] == [True, False]
    assert documents.remove(d["id"]) and documents.get(d["id"]) is None
    with pytest.raises(ValueError):
        documents.add("x.pdf", b"not a pdf")


# ------------------------------------------------------------------------------------------------ renders

CONCEPT = {"building": {"x": 100, "y": 80, "w": 80, "d": 60, "h": 12, "storeys": 2, "floor_h": 6},
           "yard": [{"type": "yard_gen", "x": 200, "y": 90, "w": 12, "d": 3}, {"type": "yard_gen", "x": 200, "y": 95, "w": 12, "d": 3}],
           "equipment": []}


def test_render_prompt_from_geometry_and_image(monkeypatch):
    img = base64.b64encode(_jpeg(16, 9)).decode()
    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        seen["prompt"] = json["contents"][0]["parts"][0]["text"]
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "image/jpeg", "data": img}}]}}]},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(G.httpx, "post", fake_post)
    r = render.render(CONCEPT, {"mw_it": 20, "cooling": "liquid", "site_w": 320, "site_d": 240}, "south", "Houston")
    assert "80 m long and 60 m deep" in seen["prompt"] and "2-storey" in seen["prompt"]
    assert "diesel backup generator enclosures (2 items" in seen["prompt"] and "east of the building" in seen["prompt"]
    assert r["label"] == "AI render, not a photo" and r["image"].startswith("data:image/jpeg;base64,")


def test_render_reports_a_zero_quota_key(monkeypatch):
    def fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        return httpx.Response(429, json={"error": {"message": "Quota exceeded ... limit: 0, model: x"}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(G.httpx, "post", fake_post)
    with pytest.raises(G.GeminiError) as e:
        render.render(CONCEPT, {})
    assert e.value.quota_zero and render.blocked() is not None
    monkeypatch.setattr(G.httpx, "post", lambda *a, **k: pytest.fail("blocked key should not be called again"))
    with pytest.raises(G.GeminiError):
        render.render(CONCEPT, {})


# ------------------------------------------------------------------------------------------------ Vexcel

def test_neighbour_heights_dsm_minus_dtm(monkeypatch):
    monkeypatch.setattr(vx, "_parcel_point", lambda pid: (LAT, LON))
    d = 0.0002  # ~20 m square building north-east of the centre
    ring = f"POLYGON (({LON} {LAT}, {LON + d} {LAT}, {LON + d} {LAT + d}, {LON} {LAT + d}, {LON} {LAT}))"

    def fake_get(url, params=None, headers=None, timeout=None):
        req = httpx.Request("GET", url)
        if url.endswith("/structure/extract"):
            return httpx.Response(200, json={"features": [{"properties": {"footprint.wkt": ring, "footprint.area": 400,
                                                                         "building-type.class": "commercial"}}]}, request=req)
        n = params["wkt"].count("(") - 1
        z = 30.0 if "/dsm/" in url else 18.0
        return httpx.Response(200, json={"wkt": "MULTIPOINT Z(" + ",".join(f"({LON} {LAT} {z})" for _ in range(n)) + ")"},
                              request=req)

    monkeypatch.setattr(vx.httpx, "get", fake_get)
    monkeypatch.setattr(config, "VEXCEL_API_KEY", "test")
    r = vx.neighbour_heights("costar:1", 100)
    s = r["structures"][0]
    assert s["height_m"] == 12.0 and s["ground_m"] == 18.0 and s["storeys_est"] == 3 and s["samples"] >= 3
    assert 5 < s["centre"][0] < 15 and 5 < s["centre"][1] < 15  # metres east / north of the site centre
    assert r["label"] == "Measured"


def test_routes_registered_and_status(monkeypatch):
    from app.main import app
    paths = set(app.openapi()["paths"])
    assert {"/gemini/obstacles", "/gemini/frame", "/gemini/docs", "/gemini/render", "/vexcel/captures/{parcel_id}",
            "/vexcel/oblique/{parcel_id}.jpg", "/vexcel/neighbours/{parcel_id}"} <= paths
    monkeypatch.setattr(vision, "describe_frame", lambda data: {"summary": "ok", "hazards": []})
    c = TestClient(app)
    assert c.get("/gemini/status").json()["vision_available"] is True
    assert c.post("/gemini/frame", files={"file": ("f.jpg", _jpeg(), "image/jpeg")}).json()["summary"] == "ok"


def test_imagery_analyst_is_a_registered_gemini_specialist():
    from app.sponsors.langchain.deep_agents import agents as A
    spec = next(s for s in A.SPECIALISTS if s["name"] == "imagery-analyst")
    assert spec["model_name"] == G.AGENT_MODEL and A.AGENT_INFO["imagery-analyst"]["model"] == G.AGENT_MODEL
    from app.sponsors.gemini import specialist
    assert set(spec["tools"]) == set(specialist.tools())
    assert "imagery-analyst" in A.ORCH_PROMPT
