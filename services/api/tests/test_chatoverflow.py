"""ChatOverflow: the scrubber, the debugging lookup and middleware, and the project-notes discovery. The CLI is mocked."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.sponsors.chatoverflow import cli, debug, notes


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    debug._cache.clear()
    debug._recent.clear()
    sent: list[str] = []

    def fake_search(text):
        sent.append(text)
        return [{"id": "11111111-2222-3333-4444-555555555555", "title": "Vexcel 401: header is x-api-key", "score": 3,
                 "tags": ["vexcel"], "relevance": 0.6}]

    monkeypatch.setattr(cli, "search", fake_search)
    yield sent


@pytest.mark.parametrize("raw, banned", [
    ("Vexcel HTTP 401 Invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 at https://api.vexcelgroup.com/v2/ortho?key=SECRET",
     ["sk-ant", "SECRET", "https", "vexcelgroup"]),
    ("Unknown parcel costar:12345 'Acme Warehouse, 12 Main St' at 29.7604, -95.3698", ["12345", "Acme", "Main", "29.76", "95.36"]),
    (r"FileNotFoundError: C:\Users\someone\PlotStar-data\costar-kit not found (PlotStar)", ["someone", "PlotStar", "costar-kit", "Users"]),
    ("Matterport error: Not authorized for model 7f3c2a1e-1111-2222-3333-444455556666 owner bob@example.com",
     ["7f3c2a1e", "bob", "example"]),
])
def test_scrub_keeps_only_generic_words(raw, banned):
    q = debug.scrub("Vexcel API", raw)
    assert q.startswith("Vexcel API")
    for b in banned:
        assert b.lower() not in q.lower(), (b, q)


def test_scrub_keeps_status_codes_and_error_words():
    q = debug.scrub("Gemini API", "Gemini quota reached (HTTP 429). Try again in a minute.")
    assert "429" in q and "quota" in q


def test_record_returns_note_ids_and_remembers_the_failure(_fresh):
    r = debug.record("Vexcel API", "Vexcel HTTP 401 Unauthorized", path="/vexcel/ortho/x/meta", status=401)
    assert r["notes"][0]["id"].startswith("11111111")
    assert r["notes"][0]["url"].endswith("11111111-2222-3333-4444-555555555555")
    assert debug.recent()[0]["integration"] == "Vexcel API"
    debug.record("Vexcel API", "Vexcel HTTP 401 Unauthorized")
    assert len(_fresh) == 1  # the second identical failure is served from the cache


def test_middleware_attaches_hints_to_integration_failures_only(_fresh):
    app = FastAPI()
    debug.install(app)

    @app.get("/vexcel/ortho/{pid}/meta")
    def fail(pid: str):
        raise HTTPException(502, f"Vexcel HTTP 500 upstream error for {pid}")

    @app.get("/vexcel/missing")
    def missing():
        raise HTTPException(404, "nope")

    @app.get("/projects/x")
    def other():
        raise HTTPException(500, "not an integration")

    c = TestClient(app, raise_server_exceptions=False)
    r = c.get("/vexcel/ortho/costar:42/meta")
    assert r.status_code == 502
    body = r.json()
    assert body["detail"].startswith("Vexcel HTTP 500")
    assert body["chatoverflow"]["notes"][0]["id"].startswith("11111111")
    assert "42" not in body["chatoverflow"]["query"]
    assert "chatoverflow" not in c.get("/vexcel/missing").json()
    assert "chatoverflow" not in c.get("/projects/x").json()
    assert len(_fresh) == 1


def test_project_notes_are_found_from_the_hook_log(tmp_path, monkeypatch):
    log = tmp_path / "hook.log"
    log.write_text(
        "[2026-11-14T09:27:10Z] stop nudge: session=aaaaaaaa turns=1 ops=1 delta=1\n"
        "[2026-11-14T09:27:37Z] sync uploaded: 1.json -> 11111111-2222-3333-4444-555555555555\n"
        "[2026-11-14T10:00:00Z] stop nudge: session=bbbbbbbb turns=1 ops=1 delta=1\n"
        "[2026-11-14T10:00:05Z] sync uploaded: 2.json -> 99999999-2222-3333-4444-555555555555\n", encoding="utf-8")
    proj = tmp_path / "projects"
    (proj / "c--Users-x-PlotStar").mkdir(parents=True)
    (proj / "c--Users-x-PlotStar" / "aaaaaaaa-0000-0000-0000-000000000000.jsonl").write_text("", encoding="utf-8")
    (proj / "c--Users-x-Other").mkdir()
    (proj / "c--Users-x-Other" / "bbbbbbbb-0000-0000-0000-000000000000.jsonl").write_text("", encoding="utf-8")
    monkeypatch.setattr(notes, "HOME", tmp_path)
    monkeypatch.setattr(notes, "CLAUDE_PROJECTS", proj)
    monkeypatch.setattr(notes, "CACHE", tmp_path / "cache.json")
    sessions = notes.project_sessions("PlotStar")
    assert sessions == {"aaaaaaaa"}
    monkeypatch.setattr(notes, "project_sessions", lambda repo_name=None: sessions)
    got: list[list[str]] = []
    monkeypatch.setattr(cli, "get", lambda ids: got.append(ids) or [
        {"id": i, "title": "t", "tags": ["deepagents"], "score": 2, "username": "someone", "body": "b"} for i in ids])
    out = notes.project_notes(refresh=True)
    assert got == [["11111111-2222-3333-4444-555555555555"]]
    assert out["count"] == 1 and out["notes"][0]["url"].startswith("https://chatoverflow.dev/n/")
    assert notes.project_notes()["cached"] is True
