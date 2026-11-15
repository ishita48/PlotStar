"""SiteStar live bridge.

Serves the website plus its live feeds:

* Drone: Tello EDU / Talent camera (MJPEG), telemetry, flight commands and
  evidence snapshots.
* Live Grid: workload machines push measured watts; the website or the ESP32
  button raises a grid emergency; every event becomes a Grid Passport record.
* ERCOT: real Texas grid data (fuel mix, demand, Houston prices), refreshed
  every 5 minutes from ercot.com.

    python bridge/server.py --drone                   # finds the drone on whatever Wi-Fi this computer is on
    python bridge/server.py --tello-ip 172.20.10.14   # only ever talk to this address
    python bridge/server.py --mock                    # simulated drone and machines

With --drone the bridge looks for the drone itself, on its own TELLO-XXXXXX Wi-Fi or on your
hotspot, and follows it when its address changes (a phone hands out a new one now and then).

Add --hotspot NAME --tello-ssid TELLO-XXXXXX to enable the site's "Connect drone to hotspot"
button, which re-sends the hotspot to a drone that has fallen back to its own Wi-Fi (hotspot.py).
Those two and the drone's last address are remembered in bridge/.drone.json, so after the first
run a plain "python bridge/server.py" brings the drone up again (--no-drone turns that off).

Then open http://localhost:8000
"""

import argparse
import atexit
import ipaddress
import json
import math
import re
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

import agent

import ercot
import hotspot
import tello_wifi

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
CAPTURE_DIR = ROOT / "captures"
MOVE_CM = 30
TURN_DEG = 45
FPS = 30
RECONNECT_SECONDS = 5
SEARCH_REPLY_S = 1.5         # how long a search waits for the drone to answer
SEARCH_QUICK_TRIES = 12      # searches at RECONNECT_SECONDS before slowing to SEARCH_SLOW_S
SEARCH_SLOW_S = 20
STATE_TIMEOUT_S = 4          # no state packets for this long = drone gone
KEEPALIVE_S = 8              # a Tello lands itself after 15 s without any command
VIDEO_IDLE_S = 10            # close a /video stream that has had no frame for this long
WIFI_POLL_S = 2              # how often the drone is asked for its Wi-Fi signal (wifi?)
WIFI_CELL_CM = 25            # readings closer than this share one spot on the Wi-Fi map
WIFI_MAX_SPOTS = 400
TELEMETRY_FLOOR_HZ = 5      # link scores are relative to the best rate seen, at least this
TELLO_DEFAULT_IP = "192.168.10.1"
# Hold-to-fly: the page sends stick positions (-100..100) while a control is held, the bridge
# passes them to the drone as "rc" speeds, and the drone glides instead of hopping 30 cm at a time.
RC_HZ = 20
RC_MAX = 60                  # the fastest a held control may ask for
RC_SLEW = 6                  # most a stick changes per tick: speed ramps over ~0.3 s, no jerk
RC_STALE_S = 0.5             # no stick update for this long = released (page closed, link lost)
RC_BRAKE_CM = 40             # extra room to stop in, on top of GUARD_CM, when gliding forward
RC_CM_PER_S = 1.0            # rough cm/s (and degrees/s) per stick unit, only for the Wi-Fi map
# Pages allowed to use endpoints that change this computer (switching its Wi-Fi).
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")
GRID_MACHINES = ("baseline", "optimized")
GRID_HISTORY = 480           # samples kept per machine (4 min at 2 Hz)
GRID_STALE_S = 5
PRE_EVENT_S = 10             # window before an emergency used as the "before" level
RESPONSE_DROP = 0.10         # a 10% drop from the before level counts as responding
ERCOT_REFRESH_S = 300

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


# ---------------------------------------------------------------- expansion kit
# The RoboMaster TT kit: a forward ToF distance sensor and an 8x8 dot-matrix display on the
# drone's open-source controller, both driven with "EXT" SDK commands. Everything here is
# optional: without the kit (nothing answers "EXT tof?"), the bridge behaves as before.
GUARD_CM = 50                # a forward move must leave at least this much room ahead
TOF_EMPTY_MM = 8000          # the sensor reports 8190 mm when nothing is in range
TOF_FRESH_S = 3.0
COUNTDOWN_S = 1.0
# While the drone is still (hovering, or on the ground once connected) the dot matrix scrolls this.
IDLE_TEXT = "GEO"
IDLE_COLOR = "b"             # r red, b blue, p purple
IDLE_SCROLL_HZ = 2.5         # how fast the text slides past (the kit takes 0.1-10)
STOP_HOLD_S = 2.0            # the red X stays this long before the display goes back to GEO


def _pattern(rows, color):
    """8 rows of 8 characters ('#' lit) -> the 64-character string 'EXT mled g' takes."""
    return "".join("".join(color if c == "#" else "0" for c in row) for row in rows)


# The display faces forward, toward whoever is in front of the drone, so sideways arrows are
# drawn as those people see them: the drone moving to its left shows an arrow to their right.
DISPLAY = {
    "3": _pattern(["..####..", ".#....#.", "......#.", "...###..", "......#.", ".#....#.", "..####..", "........"], "p"),
    "2": _pattern(["..####..", ".#....#.", "......#.", ".....#..", "...##...", "..#.....", ".######.", "........"], "p"),
    "1": _pattern(["...##...", "..###...", "...##...", "...##...", "...##...", "...##...", "..####..", "........"], "p"),
    "up": _pattern(["...##...", "..####..", ".######.", "...##...", "...##...", "...##...", "...##...", "........"], "b"),
    "down": _pattern(["...##...", "...##...", "...##...", "...##...", ".######.", "..####..", "...##...", "........"], "b"),
    "left": _pattern(["........", "..#.....", ".##.....", "########", ".##.....", "..#.....", "........", "........"], "b"),
    "right": _pattern(["........", ".....#..", ".....##.", "########", ".....##.", ".....#..", "........", "........"], "b"),
    "hover": _pattern(["........", "..####..", ".#....#.", ".#....#.", ".#....#.", ".#....#.", "..####..", "........"], "b"),
    "toward": _pattern(["...##...", "...##...", "...##...", "...##...", "...##...", "........", "...##...", "........"], "r"),
    "stop": _pattern(["#......#", ".#....#.", "..#..#..", "...##...", "...##...", "..#..#..", ".#....#.", "#......#"], "r"),
    "flash": "p" * 64,
    # What the pages draw for the scrolling GEO (they show one still frame), and the fallback
    # for firmware that can't scroll text.
    "G": _pattern(["..####..", ".#....#.", ".#......", ".#..###.", ".#....#.", ".#....#.", "..####..", "........"], "b"),
}
# What the display shows while each command runs (sideways mirrored, see above).
SHOW_FOR = {"up": "up", "down": "down", "left": "right", "right": "left", "forward": "toward",
            "back": "hover", "cw": "hover", "ccw": "hover", "land": "down"}


# ---------------------------------------------------------------- drone

class Drone:
    """Wraps the Tello connection (or a simulated one in mock mode)."""

    def __init__(self, mock: bool, tello_ip: str | None = None, enabled: bool = True,
                 last_ip: str | None = None, on_found=None):
        """tello_ip None: search this computer's network for the drone (last_ip is tried too)."""
        self.mock = mock
        self.search = tello_ip is None
        self.last_ip = last_ip
        self.on_found = on_found or (lambda ip: None)
        self.paused = False          # set while hotspot.py is switching this computer's Wi-Fi
        self.rc_target = (0, 0, 0, 0)  # sticks the page is holding: right, forward, up, clockwise
        self.rc_at = 0.0
        self.rc_now = [0, 0, 0, 0]     # what the drone was last sent, easing toward the target
        self._stepping = False         # a step command (take-off, land, a 30 cm move) is running
        self._misses = 0
        self._last_report = None
        self.disabled = not enabled and not mock
        self.tello = None
        self.frame_read = None
        self.connected = mock
        self.error = "drone disabled (start the bridge with --drone)" if self.disabled else None
        self.command_lock = threading.Lock()
        self.mock_flying = False
        self._last_state = None
        self._last_state_at = 0.0
        self._last_command_at = time.time()
        self.expansion = mock        # the simulated drone has the kit
        self.ahead_mm = None
        self.ahead_at = 0.0
        self.display = None          # the 64-character pattern on the dot matrix, if any
        self.display_name = None     # what is showing: a DISPLAY key, "idle" (scrolling GEO) or None
        self._display_want = None    # what hold-to-fly wants showing; _display_loop puts it up
        self._display_at = 0.0
        self.mock_ahead_cm = 220
        # Wi-Fi map: where the drone is (dead reckoning from its moves since take-off, cm:
        # x right, y forward, yaw clockwise from the take-off heading) and the signal there.
        self.pos_x = self.pos_y = self.yaw = 0.0
        self.wifi_lock = threading.Lock()
        self.wifi_snr = None
        self.wifi_at = 0.0
        self.wifi_spots = {}
        self._wifi_polling = False
        self.wifi_source = None
        self.wifi_rate = None
        self.wifi_best_rate = TELEMETRY_FLOOR_HZ

        if self.disabled:
            return
        threading.Thread(target=self._tof_loop, daemon=True).start()
        threading.Thread(target=self._wifi_loop, daemon=True).start()
        threading.Thread(target=self._rc_loop, daemon=True).start()
        threading.Thread(target=self._display_loop, daemon=True).start()
        if not mock:
            from djitellopy import Tello  # imported lazily so --mock works without it
            try:
                self.tello = Tello(host=tello_ip or last_ip or TELLO_DEFAULT_IP)
            except OSError as exc:  # djitellopy binds UDP 8889, one program at a time
                raise SystemExit(f"Can't open the drone's port ({exc}). Another bridge is probably still "
                                 "running: find it with  lsof -nP -iUDP:8889  and stop it with  kill <PID>.")
            threading.Thread(target=self._connect_loop, daemon=True).start()
            threading.Thread(target=self._keepalive_loop, daemon=True).start()

    def _search(self):
        """Finds the drone on this computer's network and points the connection at it.

        Every address is sent "command" from djitellopy's own socket (port 8889): a Tello only
        listens to the first address and port that spoke to it, so a search from any other
        socket would make it ignore the bridge until it restarts. Raises LookupError if none answers.
        """
        from djitellopy import tello as dj
        try:
            net = tello_wifi.local_subnet()
        except OSError:
            raise LookupError("This computer isn't on a network.")
        # Only addresses on this network: the drone's own-Wi-Fi address can't answer from a hotspot,
        # and a stale reply from it would look like the drone had joined.
        extra = [ip for ip in (self.last_ip, TELLO_DEFAULT_IP) if ip and ipaddress.ip_address(ip) in net]
        hosts = dict.fromkeys([str(h) for h in net.hosts()] + extra)
        for host in hosts:
            # Entries are added but never removed: djitellopy's receiver thread stops for good
            # if an address disappears from this dict between its check and its lookup.
            dj.drones.setdefault(host, {"responses": [], "state": {}})["responses"].clear()
        for host in hosts:
            try:
                dj.client_socket.sendto(b"command", (host, dj.Tello.CONTROL_UDP_PORT))
            except OSError:
                pass  # e.g. the network's broadcast address
        deadline = time.time() + SEARCH_REPLY_S
        found = None
        while found is None and time.time() < deadline:
            time.sleep(0.1)
            found = next((h for h in hosts
                          if any(r.strip().lower() == b"ok" for r in list(dj.drones[h]["responses"]))), None)
        if found is None:
            raise LookupError(f"No drone on this computer's network ({net}). If the drone is on, this "
                              "computer is on a different Wi-Fi, or the drone is back on its own Wi-Fi.")
        dj.drones[found]["responses"].clear()
        if found != self.tello.address[0]:
            print(f"Tello found at {found}")
        self.tello.address = (found, dj.Tello.CONTROL_UDP_PORT)

    def _report(self, message):
        if message != self._last_report:  # the search repeats; say each thing once
            self._last_report = message
            print(message)

    def _connect_loop(self):
        while True:
            wait = RECONNECT_SECONDS
            if not self.connected and not self.paused:
                try:
                    if self.search:
                        self._search()
                    self.tello.connect()
                    self.tello.streamon()
                    # djitellopy reuses its frame reader; after the drone power-cycles that
                    # reader's decoder is dead, so drop it and open a fresh one.
                    if self.tello.background_frame_read is not None:
                        self.tello.background_frame_read.stop()
                        self.tello.background_frame_read = None
                    self.frame_read = self.tello.get_frame_read()
                    self._last_state, self._last_state_at = None, time.time()
                    self._probe_expansion()
                    self.connected = True
                    self.error = None
                    self._misses, self._last_report = 0, None
                    self.last_ip = self.tello.address[0]
                    print(f"Connected to Tello at {self.last_ip}. Battery {self.tello.get_battery()}%")
                    self.on_found(self.last_ip)
                except LookupError as exc:  # the search found nothing
                    self.error = str(exc)
                    self._misses += 1
                    if self._misses > SEARCH_QUICK_TRIES:
                        wait = SEARCH_SLOW_S
                    self._report(f"{exc} Still looking.")
                except Exception as exc:  # drone off, wrong Wi-Fi, etc.
                    self.error = str(exc)
                    self._report(f"Tello at {self.tello.address[0]} not reachable ({exc}); "
                                 f"retrying every {RECONNECT_SECONDS}s")
            time.sleep(wait)

    def on_hotspot(self) -> bool:
        """Connected, and not on the drone's own Wi-Fi (which always uses 192.168.10.x)."""
        return self.connected and (self.mock or not self.tello.address[0].startswith("192.168.10."))

    def pause(self, paused: bool):
        """hotspot.py: stop (or go back to) looking for the drone."""
        self.paused = paused
        if not paused:
            self._misses = 0  # the network just changed; search at the quick pace again

    def _keepalive_loop(self):
        """Without a command every 15 s a hovering Tello lands on its own. A battery query
        counts as a command and works on every Tello firmware ("keepalive" is SDK 3 only)."""
        while True:
            time.sleep(1)
            if not (self.connected and self.tello.is_flying):
                continue
            if time.time() - self._last_command_at < KEEPALIVE_S:
                continue
            if not self.command_lock.acquire(blocking=False):
                continue  # a flight command is running, which already counts
            try:
                self.tello.query_battery()
            except Exception as exc:
                print(f"Tello keepalive failed ({exc})")
            finally:
                self._last_command_at = time.time()
                self.command_lock.release()

    def _alive(self) -> bool:
        """The Tello sends ~10 state packets a second; each one is a new dict."""
        state = self.tello.get_current_state()
        now = time.time()
        if state is not self._last_state:
            self._last_state, self._last_state_at = state, now
        return now - self._last_state_at < STATE_TIMEOUT_S

    def jpeg(self):
        if self.mock:
            frame = mock_frame(self.mock_flying)
        elif self.connected and self.frame_read is not None and self.frame_read.frame is not None:
            frame = self.frame_read.frame
            # djitellopy starts the reader with a black 400x300 placeholder; it is not video.
            if frame.shape[:2] == (300, 400):
                return None
            # djitellopy >= 2.5 returns RGB; OpenCV encodes BGR
            frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        else:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return buf.tobytes() if ok else None

    def status(self):
        base = {"connected": self.connected, "mock": self.mock, "error": self.error}
        if self.disabled:
            return {**base, "disabled": True, "battery": None, "height": None, "temp": None,
                    "flying": False, "video": False, "ip": None}
        base["wifi"] = self._wifi_status()
        if self.mock:
            return {**base, **self._kit_status(), "battery": 87, "height": 120 if self.mock_flying else 0,
                    "temp": 41, "flying": self.mock_flying, "video": True, "ip": None}
        if self.connected and not self._alive():
            self.connected = False
            self.error = "drone stopped sending telemetry"
            print("Tello went quiet; reconnecting")
        if not self.connected:
            return {**base, "connected": False, "battery": None, "height": None,
                    "temp": None, "flying": False, "video": False, "ip": self.tello.address[0]}
        t = self.tello
        return {**base, **self._kit_status(), "battery": t.get_battery(), "height": t.get_height(),
                "temp": t.get_temperature(), "flying": t.is_flying,
                "video": self._has_frame(), "ip": t.address[0]}

    def _has_frame(self) -> bool:
        frame = self.frame_read.frame if self.frame_read is not None else None
        return frame is not None and frame.shape[:2] != (300, 400)

    # ---- hold-to-fly

    def is_flying(self) -> bool:
        return self.mock_flying if self.mock else bool(self.connected and self.tello.is_flying)

    def fly(self, right, forward, up, clockwise):
        """The sticks the page is holding now, each -100..100. Send it again at least every
        RC_STALE_S while held; when updates stop the drone eases to a hover by itself."""
        self.rc_target = tuple(max(-RC_MAX, min(RC_MAX, int(v))) for v in (right, forward, up, clockwise))
        self.rc_at = time.time()

    def _rc_loop(self):
        dt = 1 / RC_HZ
        while True:
            time.sleep(dt)
            try:
                self._rc_tick(dt)
            except Exception as exc:
                print(f"Hold-to-fly tick failed ({exc})")

    def _rc_tick(self, dt):
        held = self.is_flying() and not self._stepping and time.time() - self.rc_at < RC_STALE_S
        want = list(self.rc_target) if held else [0, 0, 0, 0]
        if want[1] > 0 and self.expansion and self.ahead_mm is not None \
                and time.time() - self.ahead_at < TOF_FRESH_S and self.ahead_mm / 10 < GUARD_CM + RC_BRAKE_CM:
            want[1] = 0  # something is close ahead: no more forward, the other sticks still work
        if self._stepping or not self.is_flying():
            self.rc_now = [0, 0, 0, 0]  # a step command owns the drone; never mix speeds into it
            return
        if not any(want) and not any(self.rc_now):
            return  # hovering and nothing held: stay off the air
        self.rc_now = [now + max(-RC_SLEW, min(RC_SLEW, w - now)) for now, w in zip(self.rc_now, want)]
        right, forward, up, clockwise = self.rc_now
        blocked = held and self.rc_target[1] > 0 and want[1] == 0
        self._display_want = "stop" if blocked and not any(self.rc_now) else \
            self._glide_display(self.rc_now) if any(self.rc_now) else "idle"
        if not self.mock:
            self.tello.send_rc_control(right, forward, up, clockwise)
        # Dead reckoning for the Wi-Fi map; much rougher than the step moves.
        rad, k = math.radians(self.yaw), RC_CM_PER_S * dt
        self.pos_x += (forward * math.sin(rad) + right * math.cos(rad)) * k
        self.pos_y += (forward * math.cos(rad) - right * math.sin(rad)) * k
        self.yaw = (self.yaw + clockwise * k) % 360

    @staticmethod
    def _glide_display(sticks):
        """The arrow for the strongest stick, as people in front of the drone see it (see SHOW_FOR)."""
        axis = max(range(4), key=lambda i: abs(sticks[i]))
        v = sticks[axis]
        return [("left" if v > 0 else "right"), ("toward" if v > 0 else "hover"),
                ("up" if v > 0 else "down"), "hover"][axis]

    def _display_loop(self):
        """Puts up what hold-to-fly asked for, between commands, and takes the red X down again."""
        while True:
            time.sleep(0.1)
            if not (self.connected and self.expansion) or self._stepping:
                continue
            if self.display_name == "stop" and self._display_want == "stop" \
                    and time.time() - self._display_at > STOP_HOLD_S:
                self._display_want = "idle"
            want = self._display_want
            if want == self.display_name or not self.command_lock.acquire(blocking=False):
                continue
            try:
                self._show(want)
            except Exception as exc:
                print(f"Display update failed ({exc})")
            finally:
                self.command_lock.release()

    def command(self, action):
        self._last_command_at = time.time()
        self.rc_target = (0, 0, 0, 0)  # any step command lets go of the sticks first
        if action == "emergency":
            # Never blocked by a running command: motors stop immediately.
            if self.mock:
                self.mock_flying = False
            else:
                self.tello.emergency()
            if self.command_lock.acquire(blocking=False):  # the display only if nothing else is talking
                try:
                    self._show("stop")
                finally:
                    self.command_lock.release()
            return
        if action not in ACTIONS:
            raise ValueError(f"unknown action '{action}'")
        if not self.command_lock.acquire(blocking=False):
            # A Wi-Fi reading takes a moment; wait it out rather than refuse the tap.
            if not (self._wifi_polling and self.command_lock.acquire(timeout=3.5)):
                raise BlockingIOError("drone is busy with another command")
        self._stepping = True
        try:
            if any(self.rc_now) and not self.mock:
                self.tello.send_rc_control(0, 0, 0, 0)  # stop gliding before the step starts
                time.sleep(0.3)
            if action == "forward":
                self._guard_forward()
            if action == "takeoff":
                for n in "321":  # tells the people nearby what's coming
                    self._show(n)
                    time.sleep(COUNTDOWN_S)
                self._show("up")
            else:
                self._show(SHOW_FOR.get(action))
            if self.mock:
                time.sleep(0.4)
                self._mock_move(action)
            else:
                ACTIONS[action](self.tello)
            self._move_pose(action)
            self._show("idle")
            if self.expansion:
                self._read_tof()  # the view ahead changed; don't wait for the next poll
        finally:
            self._stepping = False
            self.command_lock.release()

    # ---- Wi-Fi map (the drone's own signal, wifi?, at each spot it flies to)

    def _move_pose(self, action):
        """Dead reckoning: each move is MOVE_CM and each turn TURN_DEG. Take-off starts a new map."""
        if action == "takeoff":
            with self.wifi_lock:
                self.pos_x = self.pos_y = self.yaw = 0.0
                self.wifi_spots.clear()
        elif action in ("forward", "back", "left", "right"):
            d = MOVE_CM if action in ("forward", "right") else -MOVE_CM
            rad = math.radians(self.yaw)
            if action in ("forward", "back"):
                self.pos_x += d * math.sin(rad)
                self.pos_y += d * math.cos(rad)
            else:
                self.pos_x += d * math.cos(rad)
                self.pos_y -= d * math.sin(rad)
        elif action == "cw":
            self.yaw = (self.yaw + TURN_DEG) % 360
        elif action == "ccw":
            self.yaw = (self.yaw - TURN_DEG) % 360

    def _height_cm(self) -> float:
        if self.mock:
            return 120.0 if self.mock_flying else 0.0
        try:
            return float(self.tello.get_height())
        except Exception:
            return 0.0

    def _query_wifi(self):
        """Asks the drone "wifi?". Returns (snr, replied): snr is its signal-to-noise ratio when it
        reports one (it answers 0 in station mode); replied is False when the query got no answer
        and None when a flight command held the link, so nothing was learned."""
        if not self.command_lock.acquire(blocking=False):
            return None, None
        self._wifi_polling = True
        try:
            reply = self.tello.send_command_with_return("wifi?", timeout=3)
            self._last_command_at = time.time()  # a query counts as a command for auto-land
            if str(reply).startswith("Aborting"):
                # A late reply would be read as the next command's answer, so drop anything queued.
                try:
                    self.tello.get_own_udp_object()["responses"].clear()
                except Exception:
                    pass
                return None, False
        except Exception:
            return None, False
        finally:
            self._wifi_polling = False
            self.command_lock.release()
        match = re.match(r"^\s*(\d{1,3})\s*$", str(reply))
        snr = int(match.group(1)) if match else 0
        return (snr or None), True

    def _count_telemetry(self, seconds):
        """Telemetry packets per second over the next few seconds. The Tello sends about 10 a
        second; a weak link loses them. Each packet is a new dict in djitellopy."""
        last = self.tello.get_current_state()
        count, end = 0, time.time() + seconds
        while time.time() < end:
            time.sleep(0.02)
            state = self.tello.get_current_state()
            if state is not last:
                count, last = count + 1, state
        return count / seconds

    def _signal(self):
        """One reading, 0-100, and what it came from: the drone's SNR when it reports one,
        otherwise link quality (telemetry packets arriving, and whether the query was answered)."""
        if self.mock:
            time.sleep(WIFI_POLL_S)
            dist = math.hypot(self.pos_x - 150, self.pos_y - 200, self._height_cm() - 100)
            return max(5, min(95, round(92 - dist / 6 + np.random.uniform(-3, 3)))), "snr", None
        if not self.connected:
            time.sleep(WIFI_POLL_S)
            return None, None, None
        rate = self._count_telemetry(WIFI_POLL_S)
        snr, replied = self._query_wifi()
        if snr:
            return snr, "snr", rate
        if replied is False:
            return 0, "link", rate  # the drone didn't answer at all
        # Scored against the best rate this link has managed, so the map shows it weakening.
        self.wifi_best_rate = max(self.wifi_best_rate, rate)
        return round(100 * min(1.0, rate / self.wifi_best_rate)), "link", rate

    def _wifi_loop(self):
        while True:
            try:
                value, source, rate = self._signal()
            except Exception as exc:
                print(f"Wi-Fi reading failed ({exc})")
                time.sleep(WIFI_POLL_S)
                continue
            if value is None or not self.connected:
                continue
            z = self._height_cm()
            key = (round(self.pos_x / WIFI_CELL_CM), round(self.pos_y / WIFI_CELL_CM), round(z / WIFI_CELL_CM))
            now = time.time()
            with self.wifi_lock:
                self.wifi_snr, self.wifi_at = value, now
                self.wifi_source, self.wifi_rate = source, rate
                spot = self.wifi_spots.get(key)
                if spot:
                    spot["snr"] = round(0.6 * spot["snr"] + 0.4 * value, 1)
                    spot["n"] += 1
                elif len(self.wifi_spots) < WIFI_MAX_SPOTS:
                    self.wifi_spots[key] = {"x": round(self.pos_x), "y": round(self.pos_y), "z": round(z),
                                            "snr": float(value), "n": 1}

    def _wifi_status(self):
        with self.wifi_lock:
            return {"snr": self.wifi_snr if time.time() - self.wifi_at < 10 else None,
                    "source": self.wifi_source,
                    "telemetry_hz": round(self.wifi_rate, 1) if self.wifi_rate is not None else None,
                    "x": round(self.pos_x), "y": round(self.pos_y), "yaw": round(self.yaw),
                    "spots": [dict(s) for s in self.wifi_spots.values()]}

    # ---- expansion kit (dot matrix + ToF)

    def _ext(self, command, timeout=2):
        """An "EXT" command for the kit. Returns the reply, or None if nothing answered."""
        if self.mock:
            return None
        reply = self.tello.send_command_with_return("EXT " + command, timeout=timeout)
        if reply.startswith("Aborting"):
            # A late reply would be read as the next command's answer, so drop anything queued.
            try:
                self.tello.get_own_udp_object()["responses"].clear()
            except Exception:
                pass
            return None
        return reply

    def _probe_expansion(self):
        reply = self._ext("tof?") or ""
        self.expansion = reply.startswith("tof")
        print("Expansion kit (dot matrix + ToF):", "found" if self.expansion else "not attached")
        if self.expansion:
            self._show("idle")

    def _read_tof(self):
        """Distance ahead in mm from the ToF sensor; None when nothing is in range."""
        if self.mock:
            mm = self.mock_ahead_cm * 10
        else:
            match = re.search(r"tof\s+(\d+)", self._ext("tof?") or "")
            if not match:
                return self.ahead_mm
            mm = int(match.group(1))
        self.ahead_at = time.time()
        self.ahead_mm = None if mm >= TOF_EMPTY_MM else mm
        return self.ahead_mm

    def _tof_loop(self):
        """Keeps a fresh distance-ahead reading, between commands (never during one)."""
        while True:
            time.sleep(0.5)
            if not (self.connected and self.expansion):
                continue
            if not self.command_lock.acquire(blocking=False):
                continue
            try:
                self._read_tof()
            except Exception as exc:
                print(f"ToF read failed ({exc})")
            finally:
                self.command_lock.release()

    def _guard_forward(self):
        if not self.expansion:
            return
        mm = self._read_tof()  # a fresh reading, not the last poll
        if mm is not None and mm / 10 - MOVE_CM < GUARD_CM:
            self._show("stop")
            raise ValueError(f"Something is {mm / 1000:.1f} m ahead. Moving forward {MOVE_CM} cm would "
                             f"bring the drone within {GUARD_CM} cm of it. Turn or back up first.")

    def _show(self, name):
        """Puts a pattern on the dot matrix: a DISPLAY key, "idle" for the scrolling GEO, or None
        to clear it. Call it holding command_lock (or from inside a command)."""
        if not self.expansion:
            return
        self.display_name = self._display_want = name
        self._display_at = time.time()
        if name == "idle":
            self.display = DISPLAY["G"]
            if not self.mock:
                reply = self._ext(f"mled l {IDLE_COLOR} {IDLE_SCROLL_HZ} {IDLE_TEXT}")
                if reply is not None and "error" in reply.lower():
                    self._ext("mled g " + DISPLAY["G"])  # no scrolling text on this firmware
            return
        pattern = DISPLAY.get(name) if name else None
        self.display = pattern
        if not self.mock:
            self._ext("mled g " + (pattern or "0" * 64))

    def flash(self):
        """A short flash when a frame is captured."""
        if not self.expansion or not self.command_lock.acquire(blocking=False):
            return
        try:
            before = self.display_name
            self._show("flash")
            time.sleep(0.15)
            self._show(before)
        finally:
            self.command_lock.release()

    def _kit_status(self):
        fresh = self.expansion and time.time() - self.ahead_at < TOF_FRESH_S
        return {"expansion": self.expansion,
                "ahead_cm": round(self.ahead_mm / 10) if fresh and self.ahead_mm is not None else None,
                "display": self.display}

    def _mock_move(self, action):
        """The simulated drone, including a wall ahead that forward moves approach."""
        if action == "takeoff":
            self.mock_flying, self.mock_ahead_cm = True, 220
        elif action == "land":
            self.mock_flying = False
        elif action == "forward":
            self.mock_ahead_cm = max(10, self.mock_ahead_cm - MOVE_CM)
        elif action == "back":
            self.mock_ahead_cm += MOVE_CM
        elif action in ("cw", "ccw"):
            self.mock_ahead_cm = {220: 140, 140: 900, 900: 220}.get(self.mock_ahead_cm, 220)

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


def mock_frame(flying: bool, w=960, h=720):
    """Synthetic 'aerial survey' frame for testing without a drone."""
    t = time.time()
    frame = np.zeros((h, w, 3), np.uint8)
    frame[:] = (24, 22, 20)
    step = 60
    ox, oy = int(t * 40) % step, int(t * 25) % step
    for x in range(-step, w + step, step):
        cv2.line(frame, (x + ox, 0), (x + ox, h), (60, 58, 54), 1)
    for y in range(-step, h + step, step):
        cv2.line(frame, (0, y + oy), (w, y + oy), (60, 58, 54), 1)
    cx = int(w / 2 + math.sin(t / 3) * 120)
    cy = int(h / 2 + math.cos(t / 4) * 80)
    cv2.rectangle(frame, (cx - 160, cy - 110), (cx + 160, cy + 110), (52, 104, 235), 2)
    cv2.putText(frame, "PARCEL A", (cx - 150, cy - 120), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (52, 104, 235), 2)
    cv2.drawMarker(frame, (w // 2, h // 2), (236, 239, 240), cv2.MARKER_CROSS, 28, 1)
    label = "SIMULATED FEED  |  " + ("AIRBORNE" if flying else "LANDED")
    cv2.putText(frame, label, (24, h - 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (236, 239, 240), 2)
    cv2.putText(frame, time.strftime("%H:%M:%S"), (w - 140, h - 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (236, 239, 240), 1)
    return frame


# ---------------------------------------------------------------- live grid

class Grid:
    """Per-machine watts, the grid-emergency flag and the Grid Passport log.

    Workload controllers POST readings; the site and controllers GET the state.
    """

    def __init__(self, mock: bool):
        self.mock = mock
        self.lock = threading.Lock()
        self.emergency = False
        self.emergency_since = None
        self.machines = {m: None for m in GRID_MACHINES}
        self.history = {m: deque(maxlen=GRID_HISTORY) for m in GRID_MACHINES}
        self.events = []      # finished Grid Passport records, oldest first
        self.active = None    # the event in progress
        self.real_seen = {}   # machine -> time of its last real reading
        if mock:
            threading.Thread(target=self._mock_loop, daemon=True).start()

    # readings
    def record(self, machine, watts, progress=None, done=None, measure=None, real=True):
        if machine not in GRID_MACHINES:
            raise ValueError(f"machine must be one of {', '.join(GRID_MACHINES)}")
        watts = float(watts)
        if not math.isfinite(watts) or watts < 0:
            raise ValueError("watts must be a non-negative number")
        if progress is not None:
            progress = min(max(float(progress), 0.0), 1.0)
        if measure not in (None, "chip", "wall", "system"):
            raise ValueError("measure must be 'chip', 'wall' or 'system'")
        now = time.time()
        with self.lock:
            if real:
                self.real_seen[machine] = now
            self.machines[machine] = {
                "watts": round(watts, 2), "progress": progress, "done": bool(done),
                "measure": measure, "updated": now, "simulated": not real,
            }
            self.history[machine].append((round(now, 2), round(watts, 2)))
            if machine == "optimized" and done:
                # Close out the job record of any event that ended before the job finished.
                for ev in self.events[-5:]:
                    if ev["job"]["finished_at"] is None:
                        ev["job"]["finished_at"] = round(now, 2)

    def _avg(self, machine, t0, t1):
        vals = [w for t, w in self.history[machine] if t0 <= t <= t1]
        return round(sum(vals) / len(vals), 2) if vals else None

    # emergency + passport
    def set_emergency(self, active: bool, source: str = "web"):
        with self.lock:
            now = time.time()
            if active and not self.emergency:
                opt = self.machines["optimized"] or {}
                self.active = {
                    "id": len(self.events) + 1, "started": round(now, 2), "source": source,
                    "before": {m: self._avg(m, now - PRE_EVENT_S, now) for m in GRID_MACHINES},
                    "progress_start": opt.get("progress"),
                }
                self.emergency_since = now
            elif not active and self.emergency and self.active:
                self.events.append(self._close_event(now))
                self.events = self.events[-50:]
                self.active = None
                self.emergency_since = None
            self.emergency = active

    def _close_event(self, now):
        ev = self.active
        start = ev["started"]
        machines = {}
        for m in GRID_MACHINES:
            before = ev["before"][m]
            during = self._avg(m, start, now)
            cur = self.machines[m] or {}
            machines[m] = {
                "before_w": before, "during_w": during,
                "change_pct": round((during - before) / before * 100, 1) if before and during is not None else None,
                "measure": cur.get("measure"), "simulated": bool(cur.get("simulated")),
                "samples": sum(1 for t, _ in self.history[m] if start <= t <= now),
            }
        response_s = None
        before = ev["before"]["optimized"]
        if before:
            for t, w in self.history["optimized"]:
                if t >= start and w <= before * (1 - RESPONSE_DROP):
                    response_s = round(t - start, 2)
                    break
        opt = self.machines["optimized"] or {}
        return {
            "id": ev["id"], "started": start, "ended": round(now, 2),
            "duration_s": round(now - start, 1), "source": ev["source"], "mock": bool(opt.get("simulated", self.mock)),
            "machines": machines, "response_s": response_s,
            "response_rule": f"first reading {int(RESPONSE_DROP * 100)}% below the {PRE_EVENT_S}-second pre-event average",
            "job": {"progress_start": ev["progress_start"], "progress_end": opt.get("progress"),
                    "finished_at": round(now, 2) if opt.get("done") else None},
        }

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
            live = [c for c in self.machines.values() if c and now - c["updated"] <= GRID_STALE_S]
            simulated = bool(live) and all(c.get("simulated") for c in live)
            return {"mock": simulated, "mock_mode": self.mock, "emergency": self.emergency,
                    "emergency_since": self.emergency_since, "active": self.active,
                    "events": self.events[-10:][::-1], "machines": machines, "now": now}

    def _mock_loop(self):
        """Simulated readings so the page can be tested without workload machines."""
        progress = {m: 0.0 for m in GRID_MACHINES}
        while True:
            for m in GRID_MACHINES:
                if time.time() - self.real_seen.get(m, 0) < 5:
                    continue  # a real machine is reporting: don't overwrite it
                deferring = m == "optimized" and self.emergency
                watts = (12 if deferring else 38) + math.sin(time.time() * 1.7 + len(m)) * 1.5
                progress[m] = 0.0 if progress[m] >= 1 else progress[m] + (0.0 if deferring else 0.004)
                self.record(m, watts, progress=progress[m], done=progress[m] >= 1, measure="chip", real=False)
            time.sleep(0.5)


# ---------------------------------------------------------------- ERCOT

class ErcotFeed:
    """Keeps a fresh copy of the real ERCOT data (see ercot.py)."""

    def __init__(self, enabled: bool = True):
        self.data, self.error, self.fetched = None, None, None
        self.lock = threading.Lock()
        if enabled:
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                data = ercot.build()
                with self.lock:
                    self.data, self.error, self.fetched = data, None, time.time()
            except Exception as exc:  # offline, ERCOT down, format change
                with self.lock:
                    self.error = str(exc)
                print(f"ERCOT refresh failed: {exc}")
            time.sleep(ERCOT_REFRESH_S if self.error is None else 60)

    def get(self):
        with self.lock:
            return self.data, self.error


# ---------------------------------------------------------------- app

def create_app(drone: Drone, grid: Grid, feed: ErcotFeed, joiner: hotspot.HotspotJoiner) -> Flask:
    app = Flask(__name__, static_folder=None)

    @app.after_request
    def cors(resp):
        # Lets a separately hosted copy of the site reach this local bridge.
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    def body():
        return request.get_json(silent=True) or {}

    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.get("/<path:path>")
    def static_files(path):
        return send_from_directory(WEB_DIR, path)

    # drone
    @app.get("/api/status")
    def status():
        return jsonify({**drone.status(), "hotspot": joiner.state()})

    @app.route("/api/drone/hotspot", methods=["POST", "OPTIONS"])
    def drone_hotspot():
        """Sends the hotspot to a drone that is back on its own Wi-Fi (see hotspot.py)."""
        if request.method == "OPTIONS":
            return "", 204
        origin = request.headers.get("Origin")
        if origin and not LOCAL_ORIGIN.match(origin) and request.host_url.rstrip("/") != origin:
            return jsonify(error="only a page on this computer can switch its Wi-Fi"), 403
        try:
            joiner.start()
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except BlockingIOError as exc:
            return jsonify(error=str(exc)), 409
        return jsonify(joiner.state()), 202

    @app.route("/api/command", methods=["POST", "OPTIONS"])
    def command():
        if request.method == "OPTIONS":
            return "", 204
        action = body().get("action", "")
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

    @app.route("/api/rc", methods=["POST", "OPTIONS"])
    def rc():
        """Hold-to-fly. Body: {"right": 0, "forward": 40, "up": 0, "clockwise": 0}, each -100..100
        (capped at RC_MAX). Repeat it while the control is held; all zeros (or silence) stops."""
        if request.method == "OPTIONS":
            return "", 204
        if not drone.connected:
            return jsonify(error="drone not connected"), 503
        b = body()
        try:
            drone.fly(*(b.get(k) or 0 for k in ("right", "forward", "up", "clockwise")))
        except (TypeError, ValueError):
            return jsonify(error="right, forward, up and clockwise must be numbers"), 400
        return jsonify(ok=True, flying=drone.is_flying())

    @app.get("/video")
    def video():
        def stream():
            # Ends after VIDEO_IDLE_S without frames, so a stream opened while the drone is
            # away does not hold a server thread forever; the page reopens it on reconnect.
            last_frame = time.time()
            while time.time() - last_frame < VIDEO_IDLE_S:
                jpg = drone.jpeg()
                if jpg:
                    last_frame = time.time()
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
                time.sleep(1 / FPS)

        return Response(stream(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.route("/api/drone/snapshot", methods=["POST", "OPTIONS"])
    def snapshot():
        if request.method == "OPTIONS":
            return "", 204
        jpg = drone.jpeg()
        if not jpg:
            return jsonify(error="no camera frame available"), 503
        drone.flash()
        CAPTURE_DIR.mkdir(exist_ok=True)
        # Milliseconds in the name: a survey can capture twice within one second.
        now = time.time()
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now)) + f"-{int(now * 1000) % 1000:03d}"
        name = stamp + ("-sim" if drone.mock else "") + ".jpg"
        (CAPTURE_DIR / name).write_bytes(jpg)
        return jsonify(snapshot_info(name))

    @app.get("/api/drone/snapshots")
    def snapshots():
        if not CAPTURE_DIR.exists():
            return jsonify([])
        files = sorted(CAPTURE_DIR.glob("*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
        return jsonify([snapshot_info(p.name) for p in files[:12]])

    @app.get("/captures/<path:name>")
    def capture_file(name):
        return send_from_directory(CAPTURE_DIR, name)

    # live grid
    @app.get("/api/grid")
    def grid_state():
        return jsonify(grid.state())

    @app.route("/api/grid/telemetry", methods=["POST", "OPTIONS"])
    def grid_telemetry():
        """Body: {"machine": "baseline"|"optimized", "watts": 38.2,
        "progress": 0.0-1.0, "done": false, "measure": "chip"|"wall"|"system"}"""
        if request.method == "OPTIONS":
            return "", 204
        b = body()
        try:
            grid.record(b.get("machine"), b.get("watts"), b.get("progress"), b.get("done"), b.get("measure"))
        except (TypeError, ValueError) as exc:
            return jsonify(error=str(exc)), 400
        return jsonify(ok=True, emergency=grid.emergency)

    @app.route("/api/grid/emergency", methods=["POST", "OPTIONS"])
    def grid_emergency():
        """Body: {"active": true|false, "source": "web"|"esp32"|...}"""
        if request.method == "OPTIONS":
            return "", 204
        b = body()
        active = b.get("active")
        if not isinstance(active, bool):
            return jsonify(error="'active' must be true or false"), 400
        source = str(b.get("source") or "api")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", source):
            return jsonify(error="'source' must be a short name like 'web' or 'esp32'"), 400
        grid.set_emergency(active, source)
        return jsonify(ok=True, emergency=grid.emergency)

    # ERCOT
    @app.get("/api/ercot")
    def ercot_data():
        data, error = feed.get()
        if data is None:
            return jsonify(error=error or "ERCOT data not loaded yet"), 503
        return jsonify({**data, "live": True, "refresh_error": error})

    # inspection agent (Claude). Streams Server-Sent Events; ?mode=replay plays the last saved run.
    @app.get("/api/agent/status")
    def agent_status():
        return jsonify(agent.status())

    @app.get("/api/agent/inspect/<int:site_id>")
    def agent_inspect(site_id):
        mode = request.args.get("mode", "live")
        try:
            pod = float(request.args["pod"]) if request.args.get("pod") else None
            flex = float(request.args.get("flex", 0.5))
        except ValueError:
            return jsonify(error="pod and flex must be numbers"), 400
        if mode == "live" and not agent.status()["available"]:
            return jsonify(error=agent.status()["reason"]), 503

        def stream():
            events = agent.replay(site_id) if mode == "replay" else agent.inspect(site_id, pod, flex)
            for ev in events:
                yield f"data: {json.dumps(ev)}\n\n"

        return Response(stream_with_context(stream()), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def snapshot_info(name: str) -> dict:
    p = CAPTURE_DIR / name
    return {"url": f"/captures/{name}", "time": round(p.stat().st_mtime, 2), "simulated": "-sim" in name}


def main():
    parser = argparse.ArgumentParser(description="SiteStar live bridge (drone, Live Grid, ERCOT)")
    parser.add_argument("--mock", action="store_true",
                        help="simulated drone and workload machines, no hardware needed")
    parser.add_argument("--mock-grid", action="store_true",
                        help="simulate only the two workload machines (real drone, fake watts)")
    parser.add_argument("--drone", action="store_true",
                        help="connect to the Tello drone, finding it on this computer's network "
                             "(on by default once bridge/.drone.json exists)")
    parser.add_argument("--no-drone", action="store_true", help="don't connect to the drone")
    parser.add_argument("--tello-ip", default=None,
                        help="only talk to the drone at this address instead of searching (implies --drone)")
    parser.add_argument("--hotspot", help="hotspot name for the site's 'Connect drone to hotspot' button (remembered)")
    parser.add_argument("--tello-ssid",
                        help="the drone's own Wi-Fi name(s) for that button, comma-separated, "
                             "e.g. TELLO-ABC123,RMTT-ABC123 (remembered)")
    parser.add_argument("--hotspot-password-file", default=str(Path(__file__).resolve().parent / ".hotspot"),
                        help="file with the hotspot password on its first line (default: bridge/.hotspot)")
    parser.add_argument("--no-ercot", action="store_true", help="don't fetch live ERCOT data")
    parser.add_argument("--host", default="127.0.0.1",
                        help="use 0.0.0.0 to let other devices on the network view the site")
    parser.add_argument("--port", type=int, default=8000)  # 5000 clashes with macOS AirPlay
    args = parser.parse_args()

    agent.load_env_file()
    config = hotspot.load_config()
    hotspot_name = args.hotspot or config.get("hotspot")
    tello_ssids = ([s.strip() for s in args.tello_ssid.split(",") if s.strip()] if args.tello_ssid
                   else config.get("tello_ssids") or [])
    if args.hotspot or args.tello_ssid:
        hotspot.save_config(hotspot=hotspot_name, tello_ssids=tello_ssids)
    remembered = bool(config) or bool(args.hotspot or args.tello_ssid)
    use_drone = not args.no_drone and (args.drone or args.tello_ip is not None or remembered)
    drone = Drone(mock=args.mock, tello_ip=args.tello_ip, enabled=use_drone, last_ip=config.get("last_ip"),
                  on_found=lambda ip: hotspot.save_config(last_ip=ip))
    grid = Grid(mock=args.mock or args.mock_grid)
    feed = ErcotFeed(enabled=not args.no_ercot)
    joiner = hotspot.HotspotJoiner(hotspot_name, tello_ssids, args.hotspot_password_file, mock=args.mock,
                                   drone_connected=drone.on_hotspot, pause_drone=drone.pause)
    atexit.register(drone.shutdown)
    mode = "mock" if args.mock else (f"Tello at {args.tello_ip}" if args.tello_ip else "finding the Tello" if use_drone else "no drone") + (
        ", simulated machines" if args.mock_grid else "")
    a = agent.status()
    mode += f"; inspection agent {'on (' + a['model'] + ')' if a['available'] else 'off: ' + a['reason']}"
    print(f"SiteStar bridge on http://{args.host}:{args.port}  ({mode})")
    create_app(drone, grid, feed, joiner).run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
