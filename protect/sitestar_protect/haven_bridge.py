"""Pushes real hardware events into the team's main app (Next.js, HAVEN command center in Dashboard 2).

The main app's Protect command center and the iPhone app read the same protection workspace. Its
API only knows demo incidents, so a real event is sent as the matching command:

    our incident            -> main app command
    leak / valve_fault      -> {"action": "trigger", "kind": "leak"}
    smoke                   -> {"action": "trigger", "kind": "fire"}
    overheat                -> {"action": "trigger", "kind": "usage"}
    manager badge approval  -> {"action": "acknowledge", "incidentId": <newest active>}
    everything clear        -> {"action": "reset"}   (the command center then shows Recovering)

Target facility: HAVEN_FACILITY env var (its id), else the most recently deployed non-sample
facility, else the most recent deployed sample. Never raises into the caller; failures are shown
on the dashboard.
"""
from __future__ import annotations

import json
import os
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

KIND_FOR = {"leak": "leak", "valve_fault": "leak", "smoke": "fire", "overheat": "usage"}


class HavenBridge:
    def __init__(self, base_url: Optional[str] = "http://127.0.0.1:3000"):
        self.base = base_url.rstrip("/") if base_url else None
        self.facility: Optional[dict] = None
        self.ok: Optional[bool] = None
        self.error: Optional[str] = None
        self.last: Optional[str] = None
        self.log: list[dict] = []
        self._q: "queue.Queue[dict]" = queue.Queue()
        if self.base:
            threading.Thread(target=self._worker, name="haven-bridge", daemon=True).start()

    # ------------------------------------------------------------------ API
    def incident(self, kind: str, title: str) -> None:
        if self.base and kind in KIND_FOR:
            self._q.put({"action": "trigger", "kind": KIND_FOR[kind], "_why": title})

    def approved(self) -> None:
        if self.base:
            self._q.put({"action": "acknowledge", "_why": "manager badge"})

    def all_clear(self) -> None:
        if self.base:
            self._q.put({"action": "reset", "_why": "all sensors normal"})

    def snapshot(self) -> dict:
        f = self.facility or {}
        return {"url": self.base, "ok": self.ok, "error": self.error, "facility": f.get("name"),
                "facility_id": f.get("id"), "last": self.last, "log": self.log[-8:]}

    # -------------------------------------------------------------- plumbing
    def _http(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode() or "{}")

    def _pick_facility(self) -> dict:
        projects = self._http("GET", "/api/protection").get("projects", [])
        want = os.environ.get("HAVEN_FACILITY")
        if want:
            match = [p for p in projects if p["facility"]["id"] == want]
            if not match:
                raise RuntimeError(f"HAVEN_FACILITY {want} is not a deployed facility")
            return match[0]["facility"]
        real = [p for p in projects if not p.get("sample")]
        pool = real or projects
        if not pool:
            raise RuntimeError("no deployed facility in the main app yet (Protect -> Deploy one)")
        return pool[0]["facility"]

    def _state(self) -> dict:
        f = self.facility
        q = urllib.parse.urlencode({"name": f["name"], "city": f.get("city", ""), "type": f.get("type", "")})
        return self._http("GET", f"/api/protection/{f['id']}?{q}")

    def _send(self, cmd: dict) -> str:
        if self.facility is None:
            self.facility = self._pick_facility()
        state = self._state()
        command = {k: v for k, v in cmd.items() if not k.startswith("_")}
        if command["action"] == "acknowledge":
            active = [i for i in state.get("incidents", []) if i.get("status") == "active"]
            if not active:
                return "nothing to acknowledge"
            command["incidentId"] = active[-1]["id"]
        if command["action"] == "reset" and not [i for i in state.get("incidents", [])
                                                 if i.get("status") != "resolved"]:
            return "already clear"
        body = {"facility": {k: self.facility.get(k, "") for k in ("id", "name", "city", "type")},
                "revision": state.get("revision", 0), "command": command}
        try:
            self._http("PATCH", f"/api/protection/{self.facility['id']}", body)
        except urllib.error.HTTPError as e:
            if e.code == 409:                       # someone clicked in the UI meanwhile: retry once
                body["revision"] = self._state().get("revision", 0)
                self._http("PATCH", f"/api/protection/{self.facility['id']}", body)
            else:
                raise
        return "sent"

    def _worker(self) -> None:
        while True:
            cmd = self._q.get()
            label = f"{cmd['action']} {cmd.get('kind', '')}".strip()
            try:
                result = self._send(cmd)
                self.ok, self.error = True, None
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")[:160]
                result, self.ok, self.error = f"HTTP {e.code}", False, f"{label}: HTTP {e.code} {detail}"
                if e.code == 404:
                    self.facility = None
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                result, self.ok = "main app not reachable", False
                self.error = f"main app not reachable at {self.base} ({getattr(e, 'reason', e)})"
            except Exception as e:  # noqa: BLE001
                result, self.ok, self.error = "error", False, f"{label}: {e}"
            self.last = f"{time.strftime('%H:%M:%S')} {label} ({cmd.get('_why', '')}): {result}"
            self.log.append({"t": time.time(), "text": self.last})
            del self.log[:-50]
            print(f"[haven] {self.last}" + (f"  -- {self.error}" if self.error and not self.ok else ""))
