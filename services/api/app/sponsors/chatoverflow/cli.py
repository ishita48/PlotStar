"""The ChatOverflow CLI (`chatoverflow`, npm), called without a shell.

Only two read-only commands are used: `search "<text>"` and `get <id> ...`; both print JSON. On Windows the npm shim is
a .cmd file, so the CLI's own node script is run directly (no cmd.exe, so nothing in an argument is interpreted).
Callers must pass generic text only: no keys, CoStar data, or user and project details (see debug.scrub).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

TIMEOUT_S = float(os.getenv("CHATOVERFLOW_TIMEOUT_S", "8"))
_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class Unavailable(RuntimeError):
    pass


def command() -> list[str] | None:
    """argv prefix that runs the CLI, or None when it is not installed."""
    override = os.getenv("CHATOVERFLOW_BIN")
    if override:
        return [override]
    found = shutil.which("chatoverflow")
    if not found:
        return None
    p = Path(found)
    if p.suffix.lower() in (".cmd", ".bat", ".ps1", ""):
        script = p.parent / "node_modules" / "chatoverflow" / "bin" / "chatoverflow.js"
        node = shutil.which("node")
        if script.exists() and node:
            return [node, str(script)]
        if p.suffix.lower() in (".cmd", ".bat", ".ps1"):
            return None  # never route arguments through cmd.exe
    return [str(p)]


def _run(args: list[str]) -> dict[str, Any]:
    cmd = command()
    if cmd is None:
        raise Unavailable("The chatoverflow CLI is not installed on the API host (npm i -g chatoverflow).")
    try:
        r = subprocess.run(cmd + args, capture_output=True, text=True, encoding="utf-8", timeout=TIMEOUT_S,
                           stdin=subprocess.DEVNULL, shell=False)
    except subprocess.TimeoutExpired as e:
        raise Unavailable(f"chatoverflow timed out after {TIMEOUT_S:g} s") from e
    except OSError as e:
        raise Unavailable(f"chatoverflow could not start: {type(e).__name__}") from e
    out = (r.stdout or "").strip()
    start = out.find("{")
    if start < 0:
        raise Unavailable(f"chatoverflow returned no JSON (exit {r.returncode})")
    try:
        return json.loads(out[start:])
    except ValueError as e:
        raise Unavailable("chatoverflow returned unreadable JSON") from e


def search(text: str) -> list[dict[str, Any]]:
    """Top matches (the CLI returns five previews): id, title, preview, username, tags, score, relevance."""
    text = " ".join(text.split())[:200]
    if not text:
        return []
    return list(_run(["search", text]).get("results") or [])


def get(ids: list[str]) -> list[dict[str, Any]]:
    ids = [i for i in ids if _ID.match(i)]
    out: list[dict[str, Any]] = []
    for k in range(0, len(ids), 5):  # the CLI takes up to five ids per call
        out += list(_run(["get", *ids[k:k + 5]]).get("posts") or [])
    return out
