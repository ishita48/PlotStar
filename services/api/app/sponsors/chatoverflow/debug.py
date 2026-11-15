"""Runtime debugging helper: when an integration call fails, look the error up on ChatOverflow.

When a Vexcel, Matterport, Gemini or CoStar-loader call fails, the API reduces the error to generic text (the
integration's name plus the error's words), searches ChatOverflow for it, and attaches the top matching note ids to the
error response (`chatoverflow` next to `detail`). The UI shows them under the error.

What is sent is built by `scrub`: a whitelist of plain words and HTTP status codes. Removed before anything leaves the
machine: URLs, e-mail addresses, file paths, anything key- or token-like, ids (CoStar `costar:<n>`, UUIDs, long
numbers), coordinates and other decimals, quoted strings (they can hold names or addresses), and this project's,
user's and machine's names. Never keys, CoStar data, or user or project details.

Lookups are cached for a day by query, and the last failures are kept in memory for the "How we built it" page.
"""
from __future__ import annotations

import getpass
import json
import os
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Awaitable, Callable

from app import config
from app.sponsors.chatoverflow import cli

TTL_S = 24 * 3600
WAIT_S = float(os.getenv("CHATOVERFLOW_DEBUG_WAIT_S", "4"))
ENABLED = os.getenv("CHATOVERFLOW_DEBUG", "1") != "0"
POST_URL = "https://chatoverflow.dev/n/{id}"

# (path prefix, integration name, which failures count). Order matters: the first match wins.
WATCH: list[tuple[str, str]] = [
    ("/vexcel", "Vexcel API"),
    ("/matterport", "Matterport API"),
    ("/costar/building", "Matterport API"),
    ("/studio/explain", "Gemini API"),
    ("/gemini", "Gemini API"),
    ("/costar", "CoStar data loader"),
    ("/sites", "CoStar data loader"),
    ("/screen", "CoStar data loader"),
    ("/search", "CoStar data loader"),
    ("/intel", "CoStar data loader"),
]

_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_recent: deque[dict[str, Any]] = deque(maxlen=30)
_lock = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="chatoverflow")

_DROP = [
    re.compile(r"https?://\S+"),                                  # URLs (query strings can carry keys)
    re.compile(r"\S+@\S+"),                                        # e-mail addresses
    re.compile(r"(?:[A-Za-z]:)?[\\/][^\s'\"]*"),                   # file paths and URL paths
    re.compile(r"'[^']*'|\"[^\"]*\"|`[^`]*`"),                     # quoted strings (names, addresses, values)
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I),  # UUIDs
    re.compile(r"\b\w+:\d+\b"),                                    # costar:123, pin:..., host:port
    re.compile(r"-?\d+\.\d+"),                                     # decimals (coordinates, prices)
]
_WORD = re.compile(r"^[A-Za-z][A-Za-z_.-]{0,29}$|^[1-5]\d\d$")    # plain words, or an HTTP status code
_TOKENISH = re.compile(r"[A-Za-z0-9_-]{24,}")                      # keys and tokens


def _private_words() -> set[str]:
    words = {"plotstar", "geostar", config.REPO_ROOT.name.lower(), config.PRODUCT_NAME.lower()}
    for v in (os.getenv("USERNAME"), os.getenv("USER"), os.getenv("COMPUTERNAME")):
        if v:
            words.add(v.lower())
    try:
        words.add(getpass.getuser().lower())
    except Exception:  # noqa: BLE001
        pass
    return {w for w in words if w}


def scrub(integration: str, error: str, max_words: int = 14) -> str:
    """The generic text sent to ChatOverflow: the integration name plus whitelisted words of the error."""
    s = _TOKENISH.sub(" ", str(error or ""))
    for rx in _DROP:
        s = rx.sub(" ", s)
    private = _private_words() | {w.lower() for w in integration.split()}  # the name is prepended once
    words = []
    for w in re.split(r"[\s,;()\[\]{}<>=|]+", s):
        w = w.strip(".:-_")
        if w and _WORD.match(w) and w.lower() not in private and w.lower() not in (x.lower() for x in words):
            words.append(w)
    return " ".join([integration, *words[:max_words]]).strip()


def _shape(r: dict[str, Any]) -> dict[str, Any]:
    return dict(id=r.get("id"), title=r.get("title"), score=r.get("score", 0), tags=(r.get("tags") or [])[:5],
                relevance=r.get("relevance"), url=POST_URL.format(id=r.get("id")))


def lookup(query: str, wait_s: float = WAIT_S) -> dict[str, Any]:
    """Top notes for an already-scrubbed query. Waits up to `wait_s`; a slow search finishes in the background and
    fills the cache for the next failure."""
    key = query.lower()
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < TTL_S:
            return dict(query=query, notes=hit[1], cached=True)

    def go() -> list[dict[str, Any]]:
        notes = [_shape(r) for r in cli.search(query)][:3]
        with _lock:
            _cache[key] = (time.time(), notes)
        return notes

    fut = _pool.submit(go)
    try:
        return dict(query=query, notes=fut.result(timeout=wait_s), cached=False)
    except FutureTimeout:
        return dict(query=query, notes=[], pending=True, note="ChatOverflow is slow; the match will be ready on retry.")
    except cli.Unavailable as e:
        return dict(query=query, notes=[], error=str(e))
    except Exception as e:  # noqa: BLE001  never let the helper break an error response
        return dict(query=query, notes=[], error=type(e).__name__)


def record(integration: str, error: str, *, path: str | None = None, status: int | None = None,
           wait_s: float = WAIT_S) -> dict[str, Any]:
    """Look up one failure and remember it. Safe to call from any code path that caught an integration error."""
    q = scrub(integration, error)
    res = lookup(q, wait_s) if ENABLED else dict(query=q, notes=[], disabled=True)
    with _lock:
        _recent.appendleft(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S"), integration=integration, path=path, status=status,
                                query=q, notes=res.get("notes") or [], error=res.get("error")))
    return dict(integration=integration, **res)


def recent() -> list[dict[str, Any]]:
    with _lock:
        return list(_recent)


def integration_for(path: str) -> str | None:
    return next((name for prefix, name in WATCH if path.startswith(prefix)), None)


def _failure_text(status: int, body: Any) -> str | None:
    """The error text of a failed integration response, or None when the response is not a failure."""
    if status >= 500 or status in (401, 403, 429):
        if isinstance(body, dict):
            d = body.get("detail")
            return d if isinstance(d, str) else json.dumps(d)[:300] if d else f"HTTP {status}"
        return f"HTTP {status}"
    # the Studio explain endpoint keeps working without Gemini and says so in `written_by`
    if status == 200 and isinstance(body, dict) and "not reachable" in str(body.get("written_by") or ""):
        m = re.search(r"Gemini was not reachable \((\w+)\)", body["written_by"])
        return f"Gemini not reachable {m.group(1) if m else ''}".strip()
    return None


def install(app: Any) -> None:
    """Attach the helper to failed integration responses (one middleware; JSON responses on watched paths only)."""
    from starlette.concurrency import run_in_threadpool
    from starlette.requests import Request
    from starlette.responses import Response

    @app.middleware("http")
    async def chatoverflow_hints(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        name = integration_for(request.url.path)
        if not ENABLED or name is None or "application/json" not in response.headers.get("content-type", "") \
                or response.status_code in (404, 422) or (response.status_code < 400 and request.url.path != "/studio/explain"):
            return response
        raw = b"".join([chunk async for chunk in response.body_iterator])  # type: ignore[attr-defined]
        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        try:
            body = json.loads(raw or b"null")
        except ValueError:
            return Response(raw, status_code=response.status_code, headers=headers)
        text = _failure_text(response.status_code, body)
        if text and isinstance(body, dict):
            body["chatoverflow"] = await run_in_threadpool(record, name, text, path=request.url.path,
                                                           status=response.status_code)
            raw = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
        return Response(raw, status_code=response.status_code, headers=headers, media_type="application/json")
