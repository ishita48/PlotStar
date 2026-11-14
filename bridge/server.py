"""SiteStar live bridge.

Serves the website plus two live feeds:

* Drone: connects to a Tello EDU, decodes its H.264 camera stream and serves
  it as MJPEG, along with telemetry and flight commands.
* Live Grid: workload machines push measured watts here, and anything (the
  website, the ESP32 button) can raise a grid emergency that machines poll for.

    python bridge/server.py                      # drone on its own TELLO-XXXXXX Wi-Fi
    python bridge/server.py --tello-ip 10.0.0.42 # drone joined a router (see tello_wifi.py)
    python bridge/server.py --mock               # simulated drone and grid, no hardware

Then open http://localhost:8000
"""

import argparse
import atexit
import math
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MOVE_CM = 30
TURN_DEG = 45
FPS = 30
RECONNECT_SECONDS = 5
TELLO_DEFAULT_IP = "192.168.10.1"
GRID_MACHINES = ("baseline", "optimized")
GRID_HISTORY = 120   # samples kept per machine for the sparkline
GRID_STALE_S = 5     # a machine with no update for this long shows as stale

ACTIONS = {
    "takeoff": lambda t: t.takeoff(),
    "land": lambda t: t.land(),
    "up": lambda t: t.move_up(MOVE_CM),
    "down": lambda t: t.move_down(MOVE_CM),
    "left": lambda t: t.move_left(MOVE_CM),
    "right": lambda t: t.move_right(MOVE_CM),
    "forward": lambda t: t.move_forward(MOVE_CM),
    "back": lambda t: t.move_back(MOVE_CM),
    "cw": lambda t: t.rotate_clockwise(TURN_DEG),
    "ccw": lambda t: t.rotate_counter_clockwise(TURN_DEG),
}


class Drone:
    """Wraps the Tello connection (or a simulated one in mock mode)."""

    def __init__(self, mock: bool, tello_ip: str = TELLO_DEFAULT_IP):
        self.mock = mock
        self.tello = None
        self.frame_read = None
        self.connected = mock
        self.error = None
        self.command_lock = threading.Lock()
        self.mock_flying = False

        if not mock:
            from djitellopy import Tello  # imported lazily so --mock works without it
            self.tello = Tello(host=tello_ip)
            threading.Thread(target=self._connect_loop, daemon=True).start()

    def _connect_loop(self):
        while True:
            if not self.connected:
                try:
                    self.tello.connect()
                    self.tello.streamon()
                    self.frame_read = self.tello.get_frame_read()
                    self.connected = True
                    self.error = None
                    print(f"Connected to Tello. Battery {self.tello.get_battery()}%")
                except Exception as exc:  # drone off, wrong Wi-Fi, etc.
                    self.error = str(exc)
                    print(f"Tello at {self.tello.address[0]} not reachable ({exc}); "
                          f"retrying in {RECONNECT_SECONDS}s")
            time.sleep(RECONNECT_SECONDS)

    # Video
    def jpeg(self):
        if self.mock:
            frame = mock_frame(self.mock_flying)
        elif self.frame_read is not None and self.frame_read.frame is not None:
            # djitellopy >= 2.5 returns RGB; OpenCV encodes BGR
            frame = cv2.cvtColor(self.frame_read.frame, cv2.COLOR_RGB2BGR)
        else:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes() if ok else None

    # Telemetry
    def status(self):
        base = {"connected": self.connected, "mock": self.mock, "error": self.error}
        if self.mock:
            return {**base, "battery": 87, "height": 120 if self.mock_flying else 0,
                    "temp": 41, "flying": self.mock_flying}
        if not self.connected:
            return {**base, "battery": None, "height": None, "temp": None, "flying": False}
        t = self.tello
        return {**base, "battery": t.get_battery(), "height": t.get_height(),
                "temp": t.get_temperature(), "flying": t.is_flying}

    # Commands
    def command(self, action):
        if action == "emergency":
            # Never blocked by a running command: motors stop immediately.
            if self.mock:
                self.mock_flying = False
            else:
                self.tello.emergency()
            return
        if action not in ACTIONS:
            raise ValueError(f"unknown action '{action}'")
        if not self.command_lock.acquire(blocking=False):
            raise BlockingIOError("drone is busy with another command")
        try:
            if self.mock:
                time.sleep(0.4)
                if action == "takeoff":
                    self.mock_flying = True
                elif action == "land":
                    self.mock_flying = False
            else:
                ACTIONS[action](self.tello)
        finally:
            self.command_lock.release()

    def shutdown(self):
        if self.mock or not self.connected:
            return
        try:
            if self.tello.is_flying:
                self.tello.land()
            self.tello.streamoff()
            self.tello.end()
        except Exception:
            pass


class Grid:
    """Latest Live Grid state: per-machine watts and the grid-emergency flag.

    Workload controllers POST readings; the site and controllers GET the state.
    """

    def __init__(self, mock: bool):
        self.mock = mock
        self.lock = threading.Lock()
        self.emergency = False
        self.emergency_since = None
        self.machines = {m: None for m in GRID_MACHINES}
        self.history = {m: deque(maxlen=GRID_HISTORY) for m in GRID_MACHINES}
        if mock:
            threading.Thread(target=self._mock_loop, daemon=True).start()

    def record(self, machine, watts, progress=None, done=None, measure=None):
        if machine not in GRID_MACHINES:
            raise ValueError(f"machine must be one of {', '.join(GRID_MACHINES)}")
        watts = float(watts)
        if not math.isfinite(watts) or watts < 0:
            raise ValueError("watts must be a non-negative number")
        if progress is not None:
            progress = min(max(float(progress), 0.0), 1.0)
        if measure not in (None, "chip", "wall"):
            raise ValueError("measure must be 'chip' or 'wall'")
        now = time.time()
        with self.lock:
            self.machines[machine] = {
                "watts": round(watts, 2), "progress": progress, "done": bool(done),
                "measure": measure, "updated": now,
            }
            self.history[machine].append((round(now, 2), round(watts, 2)))

    def set_emergency(self, active: bool):
        with self.lock:
            if active and not self.emergency:
                self.emergency_since = time.time()
            elif not active:
                self.emergency_since = None
            self.emergency = active

    def state(self):
        now = time.time()
        with self.lock:
            machines = {}
            for m in GRID_MACHINES:
                cur = self.machines[m]
                machines[m] = None if cur is None else {
                    **cur, "stale": now - cur["updated"] > GRID_STALE_S,
                    "history": list(self.history[m]),
                }
            return {"mock": self.mock, "emergency": self.emergency,
                    "emergency_since": self.emergency_since, "machines": machines, "now": now}

    def _mock_loop(self):
        """Simulated readings so the page can be tested without workload machines."""
        progress = {m: 0.0 for m in GRID_MACHINES}
        while True:
            for m in GRID_MACHINES:
                deferring = m == "optimized" and self.emergency
                watts = (12 if deferring else 38) + math.sin(time.time() * 1.7 + len(m)) * 1.5
                progress[m] = 0.0 if progress[m] >= 1 else progress[m] + (0.0 if deferring else 0.004)
                self.record(m, watts, progress=progress[m], done=progress[m] >= 1, measure="chip")
            time.sleep(0.5)


def mock_frame(flying: bool, w=960, h=720):
    """Synthetic 'aerial survey' frame for testing without a drone."""
    t = time.time()
    frame = np.zeros((h, w, 3), np.uint8)
    frame[:] = (28, 22, 14)  # dark navy (BGR)
    step = 60
    ox, oy = int(t * 40) % step, int(t * 25) % step
    for x in range(-step, w + step, step):
        cv2.line(frame, (x + ox, 0), (x + ox, h), (70, 55, 40), 1)
    for y in range(-step, h + step, step):
        cv2.line(frame, (0, y + oy), (w, y + oy), (70, 55, 40), 1)
    # A candidate parcel drifting under the camera
    cx = int(w / 2 + math.sin(t / 3) * 120)
    cy = int(h / 2 + math.cos(t / 4) * 80)
    cv2.rectangle(frame, (cx - 160, cy - 110), (cx + 160, cy + 110), (66, 185, 245), 2)
    cv2.putText(frame, "PARCEL A", (cx - 150, cy - 120), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (66, 185, 245), 2)
    # Crosshair
    cv2.drawMarker(frame, (w // 2, h // 2), (232, 236, 245), cv2.MARKER_CROSS, 28, 1)
    label = "SIMULATED FEED  |  " + ("AIRBORNE" if flying else "LANDED")
    cv2.putText(frame, label, (24, h - 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (240, 201, 76), 2)
    cv2.putText(frame, time.strftime("%H:%M:%S"), (w - 140, h - 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (232, 236, 245), 1)
    return frame


def create_app(drone: Drone, grid: Grid) -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.after_request
    def cors(resp):
        # Lets a separately hosted copy of the site reach this local bridge.
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        return send_from_directory(WEB_DIR, path)

    @app.get("/api/status")
    def status():
        return jsonify(drone.status())

    @app.route("/api/command", methods=["POST", "OPTIONS"])
    def command():
        if request.method == "OPTIONS":
            return "", 204
        action = (request.get_json(silent=True) or {}).get("action", "")
        if not drone.connected:
            return jsonify(error="drone not connected"), 503
        try:
            drone.command(action)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except BlockingIOError as exc:
            return jsonify(error=str(exc)), 409
        except Exception as exc:  # Tello rejected the command (low battery, etc.)
            return jsonify(error=str(exc)), 502
        return jsonify(ok=True, action=action)

    @app.get("/api/grid")
    def grid_state():
        return jsonify(grid.state())

    @app.route("/api/grid/telemetry", methods=["POST", "OPTIONS"])
    def grid_telemetry():
        """Body: {"machine": "baseline"|"optimized", "watts": 38.2,
        "progress": 0.0-1.0, "done": false, "measure": "chip"|"wall"}"""
        if request.method == "OPTIONS":
            return "", 204
        body = request.get_json(silent=True) or {}
        try:
            grid.record(body.get("machine"), body.get("watts"), body.get("progress"),
                        body.get("done"), body.get("measure"))
        except (TypeError, ValueError) as exc:
            return jsonify(error=str(exc)), 400
        return jsonify(ok=True, emergency=grid.emergency)

    @app.route("/api/grid/emergency", methods=["POST", "OPTIONS"])
    def grid_emergency():
        """Body: {"active": true|false}. Used by the website and the ESP32 button."""
        if request.method == "OPTIONS":
            return "", 204
        active = (request.get_json(silent=True) or {}).get("active")
        if not isinstance(active, bool):
            return jsonify(error="'active' must be true or false"), 400
        grid.set_emergency(active)
        return jsonify(ok=True, emergency=grid.emergency)

    @app.get("/video")
    def video():
        def stream():
            while True:
                jpg = drone.jpeg()
                if jpg:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
                time.sleep(1 / FPS)

        return Response(stream(), mimetype="multipart/x-mixed-replace; boundary=frame")

    return app


def main():
    parser = argparse.ArgumentParser(description="SiteStar live bridge (drone + Live Grid)")
    parser.add_argument("--mock", action="store_true",
                        help="simulated drone and grid feeds, no hardware needed")
    parser.add_argument("--tello-ip", default=TELLO_DEFAULT_IP,
                        help="drone IP when it has joined a router via tello_wifi.py")
    parser.add_argument("--host", default="127.0.0.1",
                        help="use 0.0.0.0 to let other devices on the network view the feed")
    parser.add_argument("--port", type=int, default=8000)  # 5000 clashes with macOS AirPlay
    args = parser.parse_args()

    drone = Drone(mock=args.mock, tello_ip=args.tello_ip)
    grid = Grid(mock=args.mock)
    atexit.register(drone.shutdown)
    mode = "mock" if args.mock else f"Tello at {args.tello_ip}"
    print(f"SiteStar bridge on http://{args.host}:{args.port}  ({mode})")
    create_app(drone, grid).run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
