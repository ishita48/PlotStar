"""This project's ChatOverflow notes, for the "How we built it" page.

Which notes are GeoStar's: the ChatOverflow hook on the build machine logs every upload as
`sync uploaded: <file> -> <post id>`, after the `session=<id>` line of the coding session that wrote it. A note belongs
to this project when that session's transcript sits in a Claude Code project folder named after this repo (only folder
names are checked, never their contents). The posts themselves (title, tags, score, comments) come from
`chatoverflow get` and are cached in data/cache/chatoverflow_notes.json. Only post ids are sent to ChatOverflow.

On a machine without the hook log, the cached file (or CHATOVERFLOW_NOTE_IDS, comma-separated) is used.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

from app import config
from app.sponsors.chatoverflow import cli
from app.sponsors.chatoverflow.impact import IMPACT

HOME = Path(os.getenv("CHATOVERFLOW_HOME", Path.home() / ".config" / "chatoverflow"))
CLAUDE_PROJECTS = Path(os.getenv("CLAUDE_PROJECTS_DIR", Path.home() / ".claude" / "projects"))
CACHE = config.CACHE_DIR / "chatoverflow_notes.json"
TTL_S = 6 * 3600
PROFILE = "https://chatoverflow.dev/u/{user}"
POST_URL = "https://chatoverflow.dev/n/{id}"  # redirects to the slugged note page
_lock = threading.Lock()

_UPLOAD = re.compile(r"^\[(?P<at>[^\]]+)\] sync uploaded: \S+ -> (?P<id>[0-9a-f-]{36})")
_SESSION = re.compile(r"session=(?P<s>[0-9a-f]{8})")


def project_sessions(repo_name: str | None = None) -> set[str]:
    """8-character Claude Code session ids whose transcripts live in a project folder named after this repo."""
    name = (repo_name or config.REPO_ROOT.name).lower()
    out: set[str] = set()
    if not CLAUDE_PROJECTS.exists():
        return out
    for d in CLAUDE_PROJECTS.iterdir():
        if d.is_dir() and name in d.name.lower():
            out |= {f.name[:8] for f in d.glob("*.jsonl")}
    return out


def uploads(log: Path | None = None, sessions: set[str] | None = None) -> list[dict[str, str]]:
    """[{id, at, session}] for every note uploaded from one of `sessions` (all uploads when sessions is None)."""
    log = log or HOME / "hook.log"
    if not log.exists():
        return []
    out, last = [], None
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        m = _SESSION.search(line)
        if m:
            last = m.group("s")
        u = _UPLOAD.match(line)
        if u and (sessions is None or last in sessions):
            out.append(dict(id=u.group("id"), at=u.group("at"), session=last or ""))
    return out


def _read_cache() -> dict[str, Any] | None:
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _shape(p: dict[str, Any], at: str | None) -> dict[str, Any]:
    body = p.get("body") or ""
    imp = IMPACT.get(p["id"][:8]) or {}
    return dict(id=p["id"], title=p.get("title"), tags=p.get("tags") or [], score=p.get("score", 0),
                comments=p.get("comment_count", 0), posted=p.get("posted"), uploaded_at=at, username=p.get("username"),
                url=POST_URL.format(id=p["id"]), summary=(body[:320] + "…") if len(body) > 320 else body,
                changed=imp.get("changed"), where=imp.get("where") or [])


def _with_impact(out: dict[str, Any]) -> dict[str, Any]:
    """Apply the hand-written impact map at read time, so an edit to impact.py shows without refetching."""
    notes = [n | {"changed": (IMPACT.get(n["id"][:8]) or {}).get("changed"), "where": (IMPACT.get(n["id"][:8]) or {}).get("where") or []}
             for n in out.get("notes", [])]
    return out | {"notes": notes, "with_impact": sum(1 for n in notes if n["changed"])}


def project_notes(refresh: bool = False) -> dict[str, Any]:
    """The notes with their live title, tags and score. Cached for six hours; `refresh` re-reads them."""
    return _with_impact(_project_notes(refresh))


def _project_notes(refresh: bool) -> dict[str, Any]:
    with _lock:
        cached = _read_cache()
        if cached and not refresh and time.time() - cached.get("fetched", 0) < TTL_S:
            return cached | {"cached": True}
        found = uploads(sessions=project_sessions())
        if not found and os.getenv("CHATOVERFLOW_NOTE_IDS"):
            found = [dict(id=i.strip(), at=None, session="") for i in os.environ["CHATOVERFLOW_NOTE_IDS"].split(",") if i.strip()]
        if not found and cached:
            found = [dict(id=n["id"], at=n.get("uploaded_at"), session="") for n in cached.get("notes", [])]
        at = {u["id"]: u["at"] for u in found}
        try:
            posts = cli.get(list(dict.fromkeys(u["id"] for u in found)))
        except cli.Unavailable as e:
            if cached:
                return cached | {"cached": True, "stale": True, "error": str(e)}
            return dict(notes=[], count=0, fetched=time.time(), error=str(e), user=None, profile=None, cached=False)
        notes = sorted((_shape(p, at.get(p["id"])) for p in posts), key=lambda n: n.get("uploaded_at") or "", reverse=True)
        user = next((n["username"] for n in notes if n.get("username")), None)
        tags: dict[str, int] = {}
        for n in notes:
            for t in n["tags"]:
                tags[t] = tags.get(t, 0) + 1
        out = dict(notes=notes, count=len(notes), fetched=time.time(), user=user,
                   profile=PROFILE.format(user=user) if user else None,
                   top_tags=sorted(tags.items(), key=lambda kv: -kv[1])[:16],
                   with_impact=sum(1 for n in notes if n["changed"]),
                   method="Post ids from the ChatOverflow hook log of this repo's coding sessions; posts via `chatoverflow get`.",
                   cached=False)
        try:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
        return out
