"""SiteStar PROTECT command line.

    python protect/run.py run                    # real ESP32 (auto-detect) + dashboard on :8796
    python protect/run.py run --sim              # built-in fake board, controls on the dashboard
    python protect/run.py run --serial /dev/ttys003
    python protect/run.py fake-board             # fake board in this terminal (keyboard = sensors)
    python protect/run.py plan                   # print the sensor plan from the building model

AI model: AWS credentials -> Claude on Amazon Bedrock; else ANTHROPIC_API_KEY -> Claude API;
else the offline playbook. Force one with --llm bedrock|anthropic|offline.
"""
from __future__ import annotations

import argparse
import os
import sys
import time


def cmd_run(a) -> int:
    import uvicorn

    from .building import load_building
    from .controller import ProtectController
    from .device import NullLink, SerialLink
    from .messaging import Messenger
    from .server import create_app

    os.environ["PROTECT_LLM"] = a.llm
    building = load_building(a.building)
    print(f"[protect] building: {building.project['name']} - {len(building.rooms)} rooms, "
          f"{sum(p.count for p in building.plan)} planned sensors")
    board = None
    port = a.serial
    if a.sim:
        from .sim_board import FakeBuildingBoard

        board = FakeBuildingBoard().start()
        port = board.port
        print(f"[protect] built-in fake board on {port} (controls on the dashboard)")
    from .agent import FS_ROOT

    FS_ROOT.mkdir(parents=True, exist_ok=True)
    log_path = FS_ROOT.parent / "phone_log.jsonl"
    messenger = Messenger(None if a.bridge == "none" else a.bridge, log_path=str(log_path))
    print(f"[protect] every manager message is also saved to {log_path}")
    ref = {}
    link = NullLink() if port == "none" else SerialLink(port, on_line=lambda ln: ref["c"].on_serial_line(ln))
    ctrl = ProtectController(building, link, messenger)
    ctrl.sim = board is not None
    ref["c"] = ctrl
    commander = ctrl.make_commander()
    print(f"[protect] AI incident commander: {commander.mode}"
          + ("" if commander.mode != "offline" else "  (no AWS/Anthropic credentials found: offline playbook)"))
    print(f"[protect] manager messaging: {'Photon bridge at ' + a.bridge if a.bridge != 'none' else 'dashboard phone only'}")
    link.start()
    if port not in ("none",) and not a.sim:
        time.sleep(2.5)   # opening the port resets the ESP32
    ctrl.start()
    print(f"[protect] dashboard: http://{a.host}:{a.http_port}/   (Ctrl-C to stop)")
    try:
        uvicorn.run(create_app(ctrl, board), host=a.host, port=a.http_port, log_level="warning")
    finally:
        ctrl.stop()
        link.stop()
        if board:
            board.stop()
    return 0


def cmd_plan(a) -> int:
    from .building import load_building

    b = load_building(a.building)
    print(f"{b.project['name']} - sensor plan (conceptual; confirm against NFPA 72 / IFC / local AHJ)\n")
    for p in b.plan:
        print(f"  {b.room_name(p.room):<22} {p.kind:<14} x{p.count:<3} {'[on model] ' if p.physical else ''}{p.reason}")
    return 0


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    ap = argparse.ArgumentParser(prog="sitestar_protect")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run PROTECT (board + AI commander + dashboard)")
    r.add_argument("--serial", default="auto", help="serial port, 'auto' or 'none'")
    r.add_argument("--sim", action="store_true", help="use the built-in fake board")
    r.add_argument("--llm", default="auto", choices=["auto", "bedrock", "anthropic", "offline"])
    r.add_argument("--bridge", default="http://127.0.0.1:8797", help="Photon bridge URL or 'none'")
    r.add_argument("--building", default=None, help="building JSON from DESIGN")
    r.add_argument("--host", default="127.0.0.1")
    r.add_argument("--http-port", type=int, default=8796)
    r.set_defaults(func=cmd_run)
    f = sub.add_parser("fake-board", help="fake building board in this terminal")
    f.set_defaults(func=lambda a: __import__("sitestar_protect.sim_board", fromlist=["x"]).run_interactive())
    p = sub.add_parser("plan", help="print the sensor plan")
    p.add_argument("--building", default=None)
    p.set_defaults(func=cmd_plan)
    a = ap.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
