import time

import pytest

from sitestar_protect.agent import IncidentCommander
from sitestar_protect.building import load_building
from sitestar_protect.controller import ProtectController
from sitestar_protect.device import NullLink, Reading, encode_command, parse_reading
from sitestar_protect.messaging import Messenger, parse_decision


class RecLink(NullLink):
    def __init__(self):
        self.sent = []

    def write(self, data):
        self.sent.append(data.decode())
        return True


def wait_for(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def rig(tmp_path, link=None):
    b = load_building()
    m = Messenger(None)
    c = ProtectController(b, link or NullLink(), m)
    c.commander = IncidentCommander(c, m, fs_root=tmp_path, model=None, mode="offline")
    return c, m


def reading(**kw):
    base = dict(leak=80, wet=False, beam=880, base=900, smoke=False, t=23.5, rh=46.0, pipe=21.0, pir=False,
                lvl=30.0, valve_open=True)
    base.update(kw)
    return Reading(**base)


# ----------------------------------------------------------------- protocol
def test_parse_reading_and_missing_sensors():
    r = parse_reading("I leak=2600 wet=1 beam=260 base=900 smoke=1 t=- rh=- pipe=3.5 pir=1 lvl=- valve=0 bseq=2 up=9")
    assert r.wet and r.smoke and r.t is None and r.pipe == 3.5 and r.pir and not r.valve_open
    assert round(r.beam_pct) == 29


def test_encode_command():
    assert encode_command(False, 1.4, True, 2, [2, 0, 1], 1).decode() == \
        "A valve=0 fan=1.00 strobe=1 buzz=2 r=2,0,1,0 agent=1\n"


def test_parse_decision():
    assert parse_decision("YES") == "approve" and parse_decision("yes please") == "approve"
    assert parse_decision("no, wait") == "reject" and parse_decision("what happened?") is None


# --------------------------------------------------------------- building
def test_sensor_plan_uses_floor_plan():
    b = load_building()
    kinds = {(p.room, p.kind) for p in b.plan}
    assert ("2F-BATH", "shutoff_valve") in kinds and ("1F-KITCH", "heat") in kinds
    assert ("1F-KITCH", "smoke") not in kinds                  # heat, not smoke, in kitchens
    valve = next(p for p in b.plan if p.room == "2F-BATH" and p.kind == "shutoff_valve")
    assert "1F Lounge" in valve.reason and valve.physical       # knows what is below
    assert all("NFPA 72" in p.code_note for p in b.plan)


# ---------------------------------------------------------------- reflexes
def test_leak_reflex_alerts_before_ai(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading())
    c.ingest(reading(leak=2600, wet=True, valve_open=False, pir=True))
    inc = c.detector.all[0]
    assert inc.kind == "leak" and inc.room == "2F-BATH"
    assert c.want_valve_open is False
    assert c.room_state["2F-BATH"] == 2 and c.room_state["1F-LOUNGE"] == 1   # room below flagged
    assert m.transcript[0]["kind"] == "alert" and "AI is investigating" in m.transcript[0]["text"]
    assert any("firmware" in r["action"] for r in inc.reflex)


def test_smoke_turns_fan_off_and_refuses_fan(tmp_path):
    c, _ = rig(tmp_path)
    c.fan = 0.8
    c.ingest(reading(beam=260, smoke=True, pir=True))
    assert c.strobe and c.buzz == 2 and c.fan == 0.0
    assert c.set_fan(1.0).startswith("refused")


def test_valve_interlock_refuses_reopen_while_wet(tmp_path):
    c, _ = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    assert c.request_valve(True).startswith("refused")
    assert c.want_valve_open is False


def test_humidity_spike_from_breath(tmp_path):
    c, _ = rig(tmp_path)
    for rh in (46, 47, 50, 55, 61):
        c.ingest(reading(rh=float(rh)))
    assert any(i.kind == "humidity_spike" for i in c.detector.all)
    assert c.fan >= 0.6


# ------------------------------------------------------- offline commander
def test_offline_flow_dossier_approval_dispatch(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False, pir=True))
    inc = c.detector.all[0]
    assert wait_for(lambda: inc.agent_state == "waiting_approval")
    report = (tmp_path / "incidents" / inc.id / "report.md").read_text()
    assert "1F Lounge" in report and "OCCUPIED" in report
    assert (tmp_path / "incidents" / inc.id / "work_order.md").exists()
    assert m.transcript[-1]["kind"] == "approval"
    m.receive("YES", channel="imessage")
    assert wait_for(lambda: c.commander.dispatches)
    assert wait_for(lambda: inc.agent_state == "done")
    assert "dispatched" in m.transcript[-1]["text"]


def test_leak_cleared_offers_reopen_needs_approval(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    inc = c.detector.all[0]
    assert wait_for(lambda: inc.agent_state == "waiting_approval")
    m.receive("no")                                   # decline the vendor
    assert wait_for(lambda: inc.agent_state == "done")
    c.ingest(reading(valve_open=False))               # probe dry -> cleared
    assert wait_for(lambda: any("REOPEN" in x["text"] for x in m.transcript))
    assert c.want_valve_open is False                 # still shut until approved
    m.receive("yes")
    assert wait_for(lambda: c.want_valve_open is True)


def test_question_gets_an_answer(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    inc = c.detector.all[0]
    assert wait_for(lambda: inc.agent_state == "waiting_approval")
    m.receive("what's going on?")                    # not yes/no while approval pending
    assert wait_for(lambda: "Reply YES or NO" in m.transcript[-1]["text"])


def test_yes_with_nothing_pending_says_so(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    inc = c.detector.all[0]
    assert wait_for(lambda: inc.agent_state == "waiting_approval")
    m.receive("YES")
    assert wait_for(lambda: c.commander.dispatches)
    n = len(c.commander.dispatches)
    m.receive("YES")                                          # extra tap
    assert wait_for(lambda: "Nothing needs your approval" in m.transcript[-1]["text"])
    assert len(c.commander.dispatches) == n                   # no double dispatch


def test_restart_continues_numbering_and_keeps_old_dossiers(tmp_path):
    old = tmp_path / "incidents" / "INC-0007"
    old.mkdir(parents=True)
    (old / "report.md").write_text("evidence from an earlier run")
    c, _ = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    assert c.detector.all[0].id == "INC-0008"
    assert (old / "report.md").read_text() == "evidence from an earlier run"


def test_phone_log_survives_restart(tmp_path):
    import json

    log = tmp_path / "phone.jsonl"
    m = Messenger(None, log_path=str(log))
    m.send("hello", kind="alert")
    m.receive("YES")
    lines = [json.loads(x) for x in log.read_text().splitlines()]
    assert [x["dir"] for x in lines] == ["out", "in"] and lines[1]["text"] == "YES"


def test_reopen_decision_recorded_in_dossier(tmp_path):
    c, m = rig(tmp_path)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    inc = c.detector.all[0]
    assert wait_for(lambda: inc.agent_state == "waiting_approval")
    m.receive("yes")
    assert wait_for(lambda: inc.agent_state == "done")
    c.ingest(reading(valve_open=False))
    assert wait_for(lambda: any("REOPEN" in x["text"] for x in m.transcript))
    m.receive("yes")
    assert wait_for(lambda: c.want_valve_open is True)
    report = (tmp_path / "incidents" / inc.id / "report.md").read_text()
    assert wait_for(lambda: "Valve reopen" in (tmp_path / "incidents" / inc.id / "report.md").read_text())
    assert "Vendor dispatch" in report


# ------------------------------------------------------------- hardware out
def test_tick_drives_board(tmp_path):
    link = RecLink()
    c, _ = rig(tmp_path, link)
    c.ingest(reading(leak=2600, wet=True, valve_open=False))
    c.tick()
    assert link.sent[0].startswith("A valve=0") and "r=2,0,1,0" in link.sent[0]
    assert link.sent[1].startswith("L SITESTAR PROTECT|WATER LEAK")
