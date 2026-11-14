"""Wire protocol for esp32_building.ino plus a USB serial link with auto-detect/reconnect."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

OLED_COLS, OLED_ROWS = 21, 6


@dataclass
class Reading:
    leak: int = 0
    wet: bool = False
    beam: int = 0
    base: int = 1
    smoke: bool = False
    t: Optional[float] = None       # mechanical room temperature, C (DHT11)
    rh: Optional[float] = None      # mechanical room humidity, % (DHT11)
    pipe: Optional[float] = None    # pipe surface temperature, C (thermistor)
    pir: bool = False
    lvl: Optional[float] = None     # distance to sump water surface, cm (ultrasonic)
    valve_open: bool = True
    bseq: int = 0
    up: int = 0
    ts: float = field(default_factory=time.time)

    @property
    def beam_pct(self) -> float:
        return 100.0 * self.beam / max(1, self.base)


def _num(v: str) -> Optional[float]:
    return None if v in ("-", "") else float(v)


def parse_reading(line: str) -> Optional[Reading]:
    line = line.strip()
    if not line.startswith("I "):
        return None
    kv = dict(tok.split("=", 1) for tok in line[2:].split() if "=" in tok)
    try:
        return Reading(
            leak=int(kv.get("leak", 0)), wet=kv.get("wet") == "1",
            beam=int(kv.get("beam", 0)), base=max(1, int(kv.get("base", 1))), smoke=kv.get("smoke") == "1",
            t=_num(kv.get("t", "-")), rh=_num(kv.get("rh", "-")), pipe=_num(kv.get("pipe", "-")),
            pir=kv.get("pir") == "1", lvl=_num(kv.get("lvl", "-")),
            valve_open=kv.get("valve", "1") == "1", bseq=int(kv.get("bseq", 0)), up=int(kv.get("up", 0)),
        )
    except ValueError:
        return None


def encode_command(valve_open: bool, fan: float, strobe: bool, buzz: int, rooms: list[int], agent: int) -> bytes:
    r = ",".join(str(max(0, min(2, x))) for x in (rooms + [0, 0, 0, 0])[:4])
    return (f"A valve={int(valve_open)} fan={max(0.0, min(1.0, fan)):.2f} strobe={int(strobe)} "
            f"buzz={int(buzz)} r={r} agent={int(agent)}\n").encode()


def encode_lines(lines: list[str]) -> bytes:
    def clean(s: str) -> str:
        return "".join(c if 32 <= ord(c) < 127 and c != "|" else " " for c in s)[:OLED_COLS]

    rows = [clean(x) for x in lines[:OLED_ROWS]] + [""] * max(0, OLED_ROWS - len(lines))
    return ("L " + "|".join(rows) + "\n").encode()


# ----------------------------------------------------------------- serial link
USB_HINTS = ("usbserial", "slab_usbtouart", "wchusbserial", "cp210", "ch340", "ch910",
             "ttyusb", "ttyacm", "usbmodem", "silicon labs", "uart")


def find_port() -> Optional[str]:
    from serial.tools import list_ports

    for p in list_ports.comports():
        text = f"{p.device} {p.description} {p.manufacturer or ''}".lower()
        if any(h in text for h in USB_HINTS) and "bluetooth" not in text:
            return p.device
    return None


class SerialLink:
    def __init__(self, port: str = "auto", baud: int = 115200, on_line: Optional[Callable[[str], None]] = None):
        self.port_arg, self.baud, self.on_line = port, baud, on_line
        self.port: Optional[str] = None
        self.hello: Optional[str] = None
        self._ser = None
        self._warned: Optional[str] = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="serial", daemon=True)

    @property
    def connected(self) -> bool:
        return self._ser is not None

    def start(self) -> "SerialLink":
        self._thread.start()
        return self

    def _warn(self, msg: str) -> None:
        if self._warned != msg:
            self._warned = msg
            print(f"[serial] WARNING: {msg}")

    def _open(self) -> bool:
        import serial

        port = find_port() if self.port_arg == "auto" else self.port_arg
        if not port:
            self._warn("no ESP32 found on USB (data cable? driver?); retrying every 2 s")
            return False
        try:
            ser = serial.Serial(port, self.baud, timeout=0.2)
        except (serial.SerialException, OSError) as exc:
            reason = "does not exist" if "No such file" in str(exc) else str(exc)
            self._warn(f"cannot open {port}: {reason}; retrying every 2 s (Serial Monitor open? wrong port?)")
            return False
        with self._lock:
            self._ser, self.port, self._warned = ser, port, None
        print(f"[serial] connected to ESP32 on {port}")
        return True

    def _run(self) -> None:
        buf = b""
        while not self._stop.is_set():
            if self._ser is None and not self._open():
                self._stop.wait(2.0)
                continue
            try:
                chunk = self._ser.read(256)
            except Exception:
                print("[serial] ESP32 disconnected; retrying")
                self._close()
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode(errors="replace").strip()
                if line.startswith("HELLO"):
                    self.hello = line
                    print(f"[serial] {line}")
                elif line.startswith(("TEST", "RECAL", "PONG")):
                    print(f"[serial] {line}")
                if line and self.on_line:
                    self.on_line(line)

    def write(self, data: bytes) -> bool:
        with self._lock:
            if self._ser is None:
                return False
            try:
                self._ser.write(data)
                return True
            except Exception:
                pass
        self._close()
        return False

    def _close(self) -> None:
        with self._lock:
            if self._ser is not None:
                try:
                    self._ser.close()
                except Exception:
                    pass
            self._ser = None

    def stop(self) -> None:
        self._stop.set()
        self._close()


class NullLink:
    connected, port, hello = False, None, None

    def start(self):
        return self

    def write(self, data: bytes) -> bool:
        return False

    def stop(self) -> None:
        pass
