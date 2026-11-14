"""Live Grid: telemetry from the two "data center" machines, the grid-day replay, the emergency button,
and the Grid Passport record (PRD F-5, V-1, V-2, section 13).

Real hardware posts to POST /telemetry (bearer TELEMETRY_API_KEY). The workload controller polls
GET /hardware/command to learn about an emergency. When no machine has reported in the last 10 s the
stream falls back to a clearly labeled SIMULATION so the screen is never blank; the Grid Passport records
which it was.
"""
from __future__ import annotations

import json
import math
import secrets
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from . import config
from .db import session

DDL = """
CREATE TABLE IF NOT EXISTS telemetry (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL NOT NULL,
    machine   TEXT NOT NULL,
    watts     REAL,
    progress  REAL,
    state     TEXT,
    source    TEXT NOT NULL,   -- measured | estimated | simulated
    meter     TEXT             -- wall-plug | chip | estimated | none
);
CREATE INDEX IF NOT EXISTS idx_tel_machine_ts ON telemetry(machine, ts);
CREATE TABLE IF NOT EXISTS passports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
"""

MACHINES = ("baseline", "plotstar")
STALE_S = 10.0
REPLAY_S = 60.0                      # one ERCOT day compressed to 60 seconds
IDLE_W, LOAD_W = 10.0, 40.0          # laptop figures from the PRD (team measurement), used only in simulation


def init() -> None:
    with session() as c:
        c.executescript(DDL)


def _now() -> float:
    return time.time()


@dataclass
class Emergency:
    active: bool = False
    started: float | None = None
    until: float | None = None
    requested_reduction: float = 0.5       # share of flexible load to shed
    source: str = "software"                # software | button


@dataclass
class SimMachine:
    progress: float = 0.0
    state: str = "running"
    watts: float = LOAD_W
    finished_at: float | None = None


@dataclass
class State:
    emergency: Emergency = field(default_factory=Emergency)
    replay_start: float = field(default_factory=_now)
    schedule: list[float] | None = None        # optimizer's 24 x grid MW (relative shape), if provided
    sim: dict[str, SimMachine] = field(default_factory=lambda: {m: SimMachine() for m in MACHINES})
    sim_last: float = field(default_factory=_now)
    job_seconds: float = 90.0                   # a fixed amount of work takes this long at full speed
    pre_emergency_watts: dict[str, float] = field(default_factory=dict)
    response_logged_at: float | None = None
    live_passport: dict[str, Any] | None = None
    during_watts: dict[str, float] = field(default_factory=dict)   # lowest watts seen per machine during an event


STATE = State()


# ----------------------------------------------------------------------------- telemetry in

def check_token(auth_header: str | None) -> bool:
    key = config.TELEMETRY_API_KEY
    if not key or not auth_header or not auth_header.startswith("Bearer "):
        return False
    return secrets.compare_digest(auth_header[7:].strip(), key)


def record(machine: str, watts: float | None, progress: float | None, state: str | None,
           source: str, meter: str | None) -> None:
    with session() as c:
        c.execute("INSERT INTO telemetry (ts, machine, watts, progress, state, source, meter) VALUES (?,?,?,?,?,?,?)",
                  (_now(), machine, watts, progress, state, source, meter))


def latest(machine: str) -> dict[str, Any] | None:
    with session() as c:
        row = c.execute("SELECT * FROM telemetry WHERE machine = ? ORDER BY ts DESC LIMIT 1", (machine,)).fetchone()
    return dict(row) if row else None


def history(machine: str, seconds: float = 120.0) -> list[dict[str, Any]]:
    with session() as c:
        rows = c.execute("SELECT ts, watts, progress, state, source FROM telemetry WHERE machine = ? AND ts >= ? ORDER BY ts",
                         (machine, _now() - seconds)).fetchall()
    return [dict(r) for r in rows]


# ----------------------------------------------------------------------------- emergency

def start_emergency(duration_s: float, reduction: float, source: str) -> Emergency:
    e = STATE.emergency
    now = _now()
    STATE.pre_emergency_watts = {m: current(m)["watts"] for m in MACHINES}   # sample BEFORE throttling starts
    STATE.during_watts = {}
    e.active, e.started, e.until, e.requested_reduction, e.source = True, now, now + duration_s, reduction, source
    STATE.response_logged_at = None
    STATE.live_passport = {
        "requested_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "requested_reduction_share": reduction, "requested_duration_s": duration_s, "trigger": source,
        "pre_watts": dict(STATE.pre_emergency_watts),
    }
    return e


def _state_of(machine: str) -> tuple[str | None, str]:
    """(job state, source) without advancing the simulation."""
    row = latest(machine)
    if row and _now() - row["ts"] <= STALE_S:
        return row["state"], row["source"]
    return STATE.sim[machine].state, "simulated"


def end_emergency() -> dict[str, Any] | None:
    e = STATE.emergency
    if not e.active:
        return None
    e.active = False                       # first, so nothing below re-enters this function
    now = _now()
    p = STATE.live_passport or {}
    pre = STATE.pre_emergency_watts
    during = {m: STATE.during_watts.get(m, pre.get(m)) for m in MACHINES}
    states = {m: _state_of(m) for m in MACHINES}
    p.update({
        "ended_at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"),
        "duration_s": round(now - (e.started or now), 1),
        "response_time_s": None if STATE.response_logged_at is None else round(STATE.response_logged_at - (e.started or now), 1),
        "watts_during": during,
        "reduction_measured": {m: (None if not pre.get(m) or during[m] is None else round(1 - during[m] / pre[m], 3))
                               for m in MACHINES},
        "source": {m: states[m][1] for m in MACHINES},
        "job_state": {m: states[m][0] for m in MACHINES},
        "methodology": "Watts are per-machine readings (meter type recorded per sample); the reduction uses the lowest "
                       "reading during the event against the reading just before it. Simulated values model the "
                       "schedule and are not measurements. Scaling to a 100 MW site is modeled.",
    })
    with session() as c:
        c.execute("INSERT INTO passports (created_at, payload_json) VALUES (?,?)",
                  (datetime.now(timezone.utc).isoformat(timespec="seconds"), json.dumps(p)))
    STATE.live_passport = None
    STATE.during_watts = {}
    return p


def command() -> dict[str, Any]:
    e = STATE.emergency
    if e.active and e.until and _now() > e.until:
        end_emergency()
    return {"emergency": e.active, "until": e.until, "requested_reduction": e.requested_reduction,
            "replay_hour": replay_hour()}


def latest_passport() -> dict[str, Any] | None:
    with session() as c:
        row = c.execute("SELECT * FROM passports ORDER BY id DESC LIMIT 1").fetchone()
    return {"created_at": row["created_at"], **json.loads(row["payload_json"])} if row else None


# ----------------------------------------------------------------------------- replay + simulation

def replay_hour() -> float:
    return ((_now() - STATE.replay_start) % REPLAY_S) / REPLAY_S * 24.0


def grid_now(price: list[float], carbon: list[float], mix: list[dict[str, float]] | None) -> dict[str, Any]:
    h = replay_hour()
    i = int(h) % 24
    out = {"hour": round(h, 2), "price": price[i], "carbon": carbon[i]}
    if mix:
        out["mix"] = mix[i]
    return out


def _advance_sim() -> None:
    now = _now()
    dt = max(0.0, min(5.0, now - STATE.sim_last))
    STATE.sim_last = now
    e = STATE.emergency
    if e.active and e.until and now > e.until:
        end_emergency()
    for m, s in STATE.sim.items():
        if s.state == "done":
            s.watts = IDLE_W
            continue
        if m == "plotstar" and e.active:
            # defer the flexible share: throttle to the requested reduction
            rate = 1.0 - e.requested_reduction
            s.state = "throttled"
            if STATE.response_logged_at is None:
                STATE.response_logged_at = now
        else:
            rate = 1.0
            s.state = "running"
        s.watts = IDLE_W + (LOAD_W - IDLE_W) * rate
        s.progress = min(1.0, s.progress + dt * rate / STATE.job_seconds)
        if s.progress >= 1.0:
            s.state, s.finished_at = "done", now


def current(machine: str) -> dict[str, Any]:
    row = latest(machine)
    if row and _now() - row["ts"] <= STALE_S:
        if machine == "plotstar" and STATE.emergency.active and STATE.response_logged_at is None \
           and STATE.pre_emergency_watts.get(machine) and row["watts"] is not None \
           and row["watts"] < 0.9 * STATE.pre_emergency_watts[machine]:
            STATE.response_logged_at = row["ts"]
        if STATE.emergency.active and row["watts"] is not None:
            STATE.during_watts[machine] = min(STATE.during_watts.get(machine, row["watts"]), row["watts"])
        return {"machine": machine, "watts": row["watts"], "progress": row["progress"], "state": row["state"],
                "source": row["source"], "meter": row["meter"], "age_s": round(_now() - row["ts"], 1)}
    _advance_sim()
    s = STATE.sim[machine]
    if STATE.emergency.active:
        STATE.during_watts[machine] = min(STATE.during_watts.get(machine, s.watts), s.watts)
    return {"machine": machine, "watts": round(s.watts, 1), "progress": round(s.progress, 3), "state": s.state,
            "source": "simulated", "meter": "none", "age_s": 0.0}


def reset_simulation() -> None:
    STATE.sim = {m: SimMachine() for m in MACHINES}
    STATE.sim_last = _now()
    STATE.replay_start = _now()
    STATE.emergency = Emergency()


def snapshot(price: list[float], carbon: list[float], mix: list[dict[str, float]] | None) -> dict[str, Any]:
    cmd = command()
    machines = {m: current(m) for m in MACHINES}
    return {
        "t": _now(),
        "grid": grid_now(price, carbon, mix),
        "machines": machines,
        "emergency": {**asdict(STATE.emergency), "remaining_s": None if not cmd["emergency"] or not cmd["until"]
                      else round(max(0.0, cmd["until"] - _now()), 1)},
        "passport_live": STATE.live_passport,
        "labels": {m: ("Measured" if machines[m]["source"] == "measured" else
                       "Estimated" if machines[m]["source"] == "estimated" else "Simulated") for m in MACHINES},
        "telemetry_configured": bool(config.TELEMETRY_API_KEY),
    }
