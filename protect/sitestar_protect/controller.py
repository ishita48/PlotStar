"""PROTECT controller: readings -> incidents -> instant reflexes -> AI commander; drives the board."""
from __future__ import annotations

import threading
import time
from typing import Optional

from . import device
from .building import Building
from .detector import Detector, History, Incident
from .device import Reading
from .messaging import Messenger

AGENT_LED = {"queued": 1, "thinking": 1, "waiting_approval": 2, "done": 3, "offline": 0, "error": 0}


class ProtectController:
    def __init__(self, building: Building, link, messenger: Messenger, *, tick_hz: float = 10.0,
                 commander=None):
        self.building, self.link, self.messenger = building, link, messenger
        self.history = History()
        self.detector = Detector(building, self.history)
        self.lock = threading.RLock()
        self.reading: Optional[Reading] = None
        self.want_valve_open = True
        self.fan = 0.0
        self.strobe = False
        self.buzz = 0
        self.agent_led = 0
        self.room_state = {r: 0 for r in building.led_rooms}
        self.actions: list[dict] = []
        self.dt = 1.0 / tick_hz
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.commander = commander  # set by make_commander() or tests

    def make_commander(self, **kw):
        from .agent import IncidentCommander

        self.commander = IncidentCommander(self, self.messenger, **kw)
        return self.commander

    # --------------------------------------------------------------- intake
    def on_serial_line(self, line: str) -> None:
        r = device.parse_reading(line)
        if r:
            self.ingest(r)

    def ingest(self, r: Reading) -> None:
        with self.lock:
            prev = self.reading
            self.history.add(r)
            self.reading = r
            new, cleared = self.detector.update(r)
            if prev and prev.valve_open and not r.valve_open:
                self._log("valve closed (firmware)", "board")
        for inc in new:
            self._reflex(inc, r)
            if self.commander:
                self.commander.handle(inc)
        for inc in cleared:
            self._cleared(inc)

    # -------------------------------------------------------------- reflexes
    def _reflex(self, inc: Incident, r: Reading) -> None:
        t0 = time.time()
        acts: list[str] = []
        with self.lock:
            if inc.kind == "leak":
                self.want_valve_open = False
                acts.append("water valve CLOSED by firmware reflex" if not r.valve_open else "close-valve command sent")
                self._room(inc.room, 2)
                below = self.building.below.get(inc.room)
                if below in self.room_state:
                    self._room(below, 1)
                self.buzz = max(self.buzz, 1)
            elif inc.kind == "smoke":
                self.strobe, self.buzz, self.fan = True, 2, 0.0
                acts += ["strobe ON", "alarm sounder ON", "exhaust fan OFF (stop smoke spread)"]
                self._room(inc.room, 2)
                if "1F-CORR" in self.room_state:
                    self._room("1F-CORR", 2)
            elif inc.kind == "overheat":
                self.fan = 1.0
                acts.append("exhaust fan 100%")
                self._room(inc.room, 1)
            elif inc.kind == "humidity_spike":
                self.fan = max(self.fan, 0.6)
                acts.append("exhaust fan 60% (dry the room)")
                self._room(inc.room, 1)
            elif inc.kind == "freeze_risk":
                self._room(inc.room, 1)
                acts.append("flagged for heat-trace check")
            elif inc.kind == "sump_high":
                self.buzz = max(self.buzz, 1)
                self._room(inc.room, 2)
                acts.append("sump alarm")
        latency = int((time.time() - t0) * 1000)
        for a in acts:
            inc.reflex.append({"t": t0, "action": a, "latency_ms": 0 if "firmware" in a else latency})
            self._log(a, f"reflex {inc.id}")
        # The fast human alert goes out before the AI has thought about anything.
        self.messenger.send(f"SiteStar ALERT {time.strftime('%H:%M:%S', time.localtime(inc.started))}: "
                            f"{inc.title} - {inc.room_name}. Auto: {', '.join(acts) or 'monitoring'}. "
                            f"AI is investigating.", kind="alert", incident=inc.id)

    def _cleared(self, inc: Incident) -> None:
        with self.lock:
            still = [i for i in self.detector.active.values() if i.room == inc.room]
            if not still:
                self._room(inc.room, 0)
            if inc.kind == "smoke":
                self.strobe, self.buzz = False, 0
                if "1F-CORR" in self.room_state and not still:
                    self._room("1F-CORR", 0)
            if inc.kind == "leak":
                below = self.building.below.get(inc.room)
                if below in self.room_state:
                    self._room(below, 0)
            if not self.detector.active:
                self.buzz = 0
                if self.fan > 0 and inc.kind in ("overheat", "humidity_spike"):
                    self.fan = 0.0
        self._log(f"{inc.title} cleared", inc.id)
        if inc.kind == "leak" and self.commander:
            self.commander.offer_reopen(inc)
        else:
            self.messenger.send(f"Cleared: {inc.title} - {inc.room_name}.", kind="info", incident=inc.id)

    def _room(self, room: str, state: int) -> None:
        if room in self.room_state:
            self.room_state[room] = state

    # ------------------------------------------------- actions (agent + API)
    def set_fan(self, level: float, by: str = "operator") -> str:
        with self.lock:
            if any(i.kind == "smoke" for i in self.detector.active.values()) and level > 0:
                return "refused: smoke incident active (fans stay off)"
            self.fan = max(0.0, min(1.0, float(level)))
        self._log(f"fan {self.fan:.0%}", by)
        return f"fan set to {self.fan:.0%}"

    def request_valve(self, open_: bool, by: str = "operator") -> str:
        with self.lock:
            if open_ and self.reading and self.reading.wet:
                self._log("valve reopen REFUSED (probe wet, firmware interlock)", by)
                return "refused: leak probe still wet (firmware interlock)"
            self.want_valve_open = bool(open_)
        self._log(f"valve {'OPEN' if open_ else 'CLOSE'} requested", by)
        return f"valve {'opening' if open_ else 'closing'}"

    def on_agent_state(self, state: str) -> None:
        self.agent_led = AGENT_LED.get(state, 0)

    def _log(self, action: str, by: str) -> None:
        self.actions.append({"t": time.time(), "action": action, "by": by})
        del self.actions[:-200]

    def live_status(self) -> dict:
        r = self.reading
        base = {"valve_open": self.want_valve_open if r is None else r.valve_open, "fan": self.fan,
                "strobe": self.strobe, "buzz": self.buzz}
        if r is None:
            return {**base, "board": "no data yet"}
        return {**base, "leak_wet": r.wet, "leak_adc": r.leak, "smoke": r.smoke, "smoke_beam_pct": round(r.beam_pct, 1),
                "mech_temp_c": r.t, "mech_rh_pct": r.rh, "pipe_c": r.pipe, "lounge_occupied": r.pir, "sump_cm": r.lvl,
                "at": time.strftime("%H:%M:%S", time.localtime(r.ts))}

    # ------------------------------------------------------------- hardware
    def oled_lines(self) -> list[str]:
        r = self.reading
        active = list(self.detector.active.values())
        if active:
            top = sorted(active, key=lambda i: (i.severity != "critical", i.started))[0]
            status = f"{top.title[:12].upper()} {top.room}"[:21]
        else:
            status = "ALL CLEAR"
        agent = {0: "AI idle", 1: "AI investigating", 2: "AI: awaiting mgr", 3: "AI: handled"}[self.agent_led]
        valve = "OPEN" if (r.valve_open if r else self.want_valve_open) else "SHUT"
        mech = "--" if not r or r.t is None else f"{r.t:.1f}C {r.rh or 0:.0f}%"
        pipe = "--" if not r or r.pipe is None else f"{r.pipe:.0f}C"
        beam = "--" if not r else f"{r.beam_pct:.0f}%"
        return ["SITESTAR PROTECT", status, f"valve {valve} fan {self.fan:.0%}", agent,
                f"mech {mech}", f"pipe {pipe} beam {beam}"]

    def tick(self) -> None:
        with self.lock:
            rooms = [self.room_state.get(r, 0) for r in self.building.led_rooms]
            self.link.write(device.encode_command(self.want_valve_open, self.fan, self.strobe, self.buzz,
                                                  rooms, self.agent_led))
            self.link.write(device.encode_lines(self.oled_lines()))

    def _loop(self) -> None:
        nxt = time.monotonic()
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001
                print(f"[protect] tick error: {exc!r}")
            nxt += self.dt
            self._stop.wait(max(0.0, nxt - time.monotonic()))

    def start(self) -> "ProtectController":
        self._thread = threading.Thread(target=self._loop, name="protect", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.link.write(device.encode_command(self.want_valve_open, 0, False, 0, [0, 0, 0, 0], 0))
        self.link.write(device.encode_lines(["SITESTAR PROTECT", "stopped"]))

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "live": self.live_status(),
                "rooms": self.room_state,
                "incidents": [i.to_json() for i in reversed(self.detector.all[-30:])],
                "active": [i.id for i in self.detector.active.values()],
                "actions": self.actions[-40:],
                "agent": self.commander.snapshot() if self.commander else None,
                "phone": self.messenger.snapshot(),
                "hardware": {"connected": self.link.connected, "port": self.link.port, "hello": self.link.hello},
                "oled": self.oled_lines(),
                "sim": getattr(self, "sim", False),
            }
