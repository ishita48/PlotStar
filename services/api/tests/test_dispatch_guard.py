"""Real emergency calls: refused through the public tunnel unless the GeoStar site's server sends DISPATCH_TOKEN.
The provider is stubbed, so no call is ever placed by these tests."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from app.sponsors.elevenlabs import routes_dispatch as R

TUNNEL = {"cf-ray": "abc", "cf-connecting-ip": "203.0.113.7"}
BODY = {"incident": "Fire detected", "zone": "Hall B", "severity": "critical"}


class _Stub:
    calls: list = []

    def place_call(self, incident):
        self.calls.append(incident)
        return {"conversation_id": "ac_test", "to": "•••• 0000", "message": "Calling", "started_at": "now"}


def _client(monkeypatch, token: str | None):
    stub = _Stub()
    stub.calls = []
    monkeypatch.setattr(R, "_provider", lambda: stub)
    monkeypatch.setattr(R, "_dispatch_token", lambda: token or "")
    return TestClient(app), stub


def test_tunnelled_call_without_token_is_refused(monkeypatch):
    c, stub = _client(monkeypatch, "s" * 48)
    assert c.post("/haven/dispatch/call", json=BODY, headers=TUNNEL).status_code == 403
    assert c.post("/haven/dispatch/call", json=BODY, headers={**TUNNEL, "X-Dispatch-Token": "wrong"}).status_code == 403
    assert c.post("/haven/dispatch/call", json=BODY, headers={"Origin": "https://evil.example"}).status_code == 403
    assert stub.calls == []


def test_site_server_with_token_may_call(monkeypatch):
    c, stub = _client(monkeypatch, "s" * 48)
    r = c.post("/haven/dispatch/call", json=BODY, headers={**TUNNEL, "X-Dispatch-Token": "s" * 48})
    assert r.status_code == 200 and r.json()["conversation_id"] == "ac_test"
    assert len(stub.calls) == 1


def test_no_token_configured_keeps_calls_local_only(monkeypatch):
    c, stub = _client(monkeypatch, None)
    assert c.post("/haven/dispatch/call", json=BODY, headers={**TUNNEL, "X-Dispatch-Token": ""}).status_code == 403
    assert c.post("/haven/dispatch/call", json=BODY).status_code == 200  # a direct local request
    assert len(stub.calls) == 1
