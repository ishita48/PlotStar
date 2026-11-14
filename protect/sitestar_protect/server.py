"""PROTECT API + dashboard.

GET  /api/state              live snapshot (sensors, rooms, incidents, agent trace, phone transcript)
GET  /api/building           building model + sensor plan (from DESIGN)
GET  /api/incidents/{id}/files   the agent's dossier files for one incident
POST /api/manager/reply      {"text": "YES", "channel": "imessage"}  (Photon bridge posts here)
POST /api/sim/key/{k}        drive the built-in fake board (only with --sim)
WS   /ws                     snapshot pushed 4x per second
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

STATIC = Path(__file__).resolve().parent / "static"


class Reply(BaseModel):
    text: str
    sender: Optional[str] = "manager"
    channel: Optional[str] = "dashboard"


def create_app(ctrl, sim_board=None) -> FastAPI:
    app = FastAPI(title="SiteStar PROTECT")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/api/state")
    def state():
        return ctrl.snapshot()

    @app.get("/api/building")
    def building():
        return ctrl.building.to_json()

    @app.get("/api/incidents/{incident_id}/files")
    def files(incident_id: str):
        if not incident_id.replace("-", "").isalnum():
            raise HTTPException(400, "bad id")
        root = ctrl.commander.fs_root / "incidents" / incident_id if ctrl.commander else None
        if not root or not root.exists():
            return {"files": []}
        return {"files": [{"name": p.name, "text": p.read_text()[:20000]} for p in sorted(root.glob("*.md"))]}

    @app.post("/api/manager/reply")
    def reply(body: Reply):
        ctrl.messenger.receive(body.text, body.sender or "manager", body.channel or "dashboard")
        return {"ok": True}

    @app.post("/api/sim/key/{k}")
    def sim_key(k: str):
        if sim_board is None:
            raise HTTPException(409, "not running with --sim")
        sim_board.key(k[:1])
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        try:
            while True:
                await sock.send_json(ctrl.snapshot())
                await asyncio.sleep(0.25)
        except (WebSocketDisconnect, RuntimeError):
            pass

    return app
