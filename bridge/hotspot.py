"""Put the drone back on the hotspot from the website (macOS only).

Now and then the drone forgets the hotspot (a Wi-Fi reset, the expansion module going on or
off) and comes back on its own TELLO-XXXXXX Wi-Fi. Sending it the hotspot again needs this
Mac on that Wi-Fi for a few seconds, so the "Connect drone to hotspot" button:

1. joins the drone's Wi-Fi (the Mac is off the internet from here to step 3),
2. sends the hotspot name and password with the SDK "ap" command (the drone reboots),
3. puts the Mac back on the hotspot, whatever happened in 1 and 2,
4. waits for the bridge to see the drone on the hotspot.

Start the bridge with --hotspot NAME --tello-ssid TELLO-XXXXXX once: both are remembered in
bridge/.drone.json (gitignored) with the drone's last address, so later runs need no flags.
--tello-ssid takes several names separated by commas, because a drone with the expansion
module shows up as RMTT-XXXXXX and without it as TELLO-XXXXXX. The password is read from
bridge/.hotspot (gitignored, first line) or $HOTSPOT_PASSWORD.
"""

import json
import os
import sys
import threading
import time
from pathlib import Path

import tello_wifi

TELLO_FIND_S = 75            # keep looking this long: the drone's Wi-Fi takes a while to show up in a scan
TELLO_JOIN_WAIT_S = 15
HOTSPOT_JOIN_TRIES = 5
HOTSPOT_RETRY_GAP_S = 4
HOTSPOT_JOIN_WAIT_S = 40
DRONE_WAIT_S = 90            # reboot plus joining the hotspot
MOCK_STEP_S = 1.5
CONFIG_FILE = Path(__file__).resolve().parent / ".drone.json"


def load_config() -> dict:
    """What earlier runs remembered: hotspot, tello_ssids, last_ip. Empty when there is none."""
    try:
        data = json.loads(CONFIG_FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(**changes):
    config = load_config()
    if all(config.get(k) == v for k, v in changes.items()):
        return
    try:
        CONFIG_FILE.write_text(json.dumps({**config, **changes}, indent=2) + "\n")
    except OSError as exc:
        print(f"Could not save {CONFIG_FILE.name} ({exc})")


class HotspotJoiner:
    """Runs the steps above in a background thread and reports progress for the page."""

    def __init__(self, ssid, tello_ssids, password_file, mock, drone_connected, pause_drone=None):
        self.ssid = ssid
        self.tello_ssids = list(tello_ssids or [])
        self.tello_ssid = " or ".join(self.tello_ssids)  # for messages
        self.password_file = Path(password_file)
        self.mock = mock
        self.drone_connected = drone_connected  # () -> bool
        # (bool) -> None: stops the bridge looking for the drone while the Mac changes Wi-Fi, so
        # it doesn't grab the drone on its own Wi-Fi just before the drone is told to leave it.
        self.pause_drone = pause_drone or (lambda paused: None)
        self.lock = threading.Lock()
        self.running = False
        self.step = None
        self.ok = None
        self.message = None

    def _password(self):
        if os.environ.get("HOTSPOT_PASSWORD"):
            return os.environ["HOTSPOT_PASSWORD"]
        try:
            return self.password_file.read_text().splitlines()[0].strip() or None
        except (OSError, IndexError):
            return None

    def problem(self):
        """Why the button can't run here, or None."""
        if self.mock:
            return None
        if sys.platform != "darwin":
            return "This switches the computer's Wi-Fi, which the bridge can only do on a Mac."
        if not self.ssid or not self.tello_ssids:
            return "Start the bridge with --hotspot <name> --tello-ssid TELLO-XXXXXX to use this."
        password = self._password()
        if not password:
            return f"No hotspot password: put it in {self.password_file} or set HOTSPOT_PASSWORD."
        if " " in self.ssid or " " in password:
            return "The drone can't use a hotspot name or password with spaces in it."
        return None

    def state(self):
        problem = self.problem()
        with self.lock:
            return {"ssid": self.ssid, "tello_ssid": self.tello_ssid, "problem": problem,
                    "running": self.running, "step": self.step, "ok": self.ok, "message": self.message}

    def start(self):
        problem = self.problem()
        if problem:
            raise ValueError(problem)
        if not self.mock and self.drone_connected():
            raise ValueError("The drone is already connected.")
        with self.lock:
            if self.running:
                raise BlockingIOError("Already connecting the drone.")
            self.running, self.ok, self.message, self.step = True, None, None, "Starting…"
        threading.Thread(target=self._run, daemon=True).start()

    # ---- the steps

    def _set_step(self, step):
        print(f"Hotspot: {step}")
        with self.lock:
            self.step = step

    def _run(self):
        try:
            ok, message = self._simulate() if self.mock else self._repair()
        except Exception as exc:  # networksetup missing, unexpected reply, ...
            ok, message = False, f"Something went wrong: {exc}"
        print(f"Hotspot: {'done' if ok else 'failed'}: {message}")
        with self.lock:
            self.running, self.step, self.ok, self.message = False, None, ok, message

    def _repair(self):
        password = self._password()
        dev = tello_wifi.wifi_device()
        self.pause_drone(True)
        try:
            problem = self._send(dev, password)
        finally:
            try:
                self._set_step(f"Putting this Mac back on {self.ssid}…")
                back = self._back_on_hotspot(dev, password)
            finally:
                self.pause_drone(False)
        if not back:
            return False, (f"This Mac didn't get back onto {self.ssid}: pick it in the Wi-Fi menu. "
                           + (problem or ""))
        if problem:
            return False, problem
        self._set_step(f"Sent. Waiting for the drone to restart onto {self.ssid}…")
        deadline = time.time() + DRONE_WAIT_S
        while time.time() < deadline:
            if self.drone_connected():
                return True, f"The drone is on {self.ssid}."
            time.sleep(1)
        return False, (f"The drone took the {self.ssid} details but hasn't joined yet. On the iPhone, "
                       "check Personal Hotspot has Allow Others to Join and Maximize Compatibility on, "
                       "then restart the drone.")

    def _back_on_hotspot(self, dev, password):
        for attempt in range(HOTSPOT_JOIN_TRIES):
            if attempt:
                time.sleep(HOTSPOT_RETRY_GAP_S)  # an idle iPhone hotspot stops advertising for a while
            if tello_wifi.join_mac_wifi(dev, self.ssid, password, None, timeout=HOTSPOT_JOIN_WAIT_S):
                return True
        return False

    def _send(self, dev, password):
        """Steps 1 and 2. Returns what went wrong, or None once the drone has the hotspot."""
        self._set_step(f"Joining the drone's Wi-Fi ({self.tello_ssid})…")
        deadline = time.time() + TELLO_FIND_S
        while not any(tello_wifi.join_mac_wifi(dev, ssid, None, "192.168.10.", timeout=TELLO_JOIN_WAIT_S)
                      for ssid in self.tello_ssids):
            if time.time() > deadline:
                return (f"This Mac can't see {self.tello_ssid}. Turn the drone on, wait until its Wi-Fi "
                        "shows up in the Wi-Fi menu, and try again.")
            time.sleep(3)
        time.sleep(1)
        self._set_step(f"Sending {self.ssid} to the drone…")
        if tello_wifi.join(self.ssid, password) != 0:
            return f"The drone didn't answer on {self.tello_ssid}. Restart it and try again."
        return None

    def _simulate(self):
        for step in ("Joining the drone's Wi-Fi (simulated)…", "Sending the hotspot to the drone (simulated)…",
                     "Putting this Mac back on the hotspot (simulated)…"):
            self._set_step(step)
            time.sleep(MOCK_STEP_S)
        return True, "Simulated: no Wi-Fi settings were changed."
