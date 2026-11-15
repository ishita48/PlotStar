"""Google Gemini over the REST API.

    embed(texts, task)      gemini-embedding-001 at 768 dimensions, paced for the free tier (8 per batch, backoff on 429)
    generate(prompt)        GEMINI_MODEL (default gemini-3.5-flash-lite); raises on any failure so callers keep their
                            built-in text
    generate_json(parts, schema)   multimodal input (images, PDFs, text) -> JSON that follows `schema` (structured output)
    generate_image(prompt)  an image-generation model -> (bytes, mime, text); raises when the key has no image model

Models are verified against the key's models list (models(), cached) rather than assumed. The key (GEMINI_API_KEY)
stays server-side and is never logged. No function here ever receives CoStar descriptive fields: callers send images,
geometry and the user's own documents and questions.
"""
from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

import httpx

from app import config

BASE = "https://generativelanguage.googleapis.com/v1beta/models"
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIMS = 768
# Vision and documents: a current 3.x Flash (image + PDF input, structured output). Pro is slower and costs more.
VISION_MODEL = os.getenv("GEMINI_VISION_MODEL", "gemini-3.5-flash")
IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")
AGENT_MODEL = os.getenv("GEMINI_AGENT_MODEL", "gemini-3.5-flash")
LAST_ERROR: str | None = None
_MODELS: dict[str, Any] = {}


class GeminiError(RuntimeError):
    """A Gemini call failed (network, quota, safety block or a response we cannot use). The message is safe to show.
    quota_zero: the model exists but this key has no quota for it (not a transient limit)."""

    def __init__(self, message: str, *, quota_zero: bool = False) -> None:
        super().__init__(message)
        self.quota_zero = quota_zero


def available() -> bool:
    return bool(config.GEMINI_API_KEY)


def _headers() -> dict[str, str]:
    return {"x-goog-api-key": config.GEMINI_API_KEY}


def models(refresh: bool = False) -> list[dict[str, Any]]:
    """The models this key can call (name, methods), cached for an hour. Empty when the key is missing or the call fails."""
    if not config.GEMINI_API_KEY:
        return []
    if not refresh and _MODELS.get("at", 0) > time.time() - 3600:
        return _MODELS["list"]
    out: list[dict[str, Any]] = []
    token = None
    try:
        for _ in range(5):
            params: dict[str, Any] = {"pageSize": 1000}
            if token:
                params["pageToken"] = token
            r = httpx.get(BASE, headers=_headers(), params=params, timeout=20)
            r.raise_for_status()
            j = r.json()
            out += [{"name": m["name"].removeprefix("models/"), "methods": m.get("supportedGenerationMethods", []),
                     "input_tokens": m.get("inputTokenLimit")} for m in j.get("models", [])]
            token = j.get("nextPageToken")
            if not token:
                break
    except Exception:  # noqa: BLE001
        return _MODELS.get("list", [])
    _MODELS.update(at=time.time(), list=out)
    return out


def has_model(name: str) -> bool:
    return any(m["name"] == name and "generateContent" in m["methods"] for m in models())


def embed(texts: list[str], task: str, dims: int = EMBED_DIMS) -> list[list[float]] | None:
    """One vector per text, or None on failure (the reason is in LAST_ERROR)."""
    global LAST_ERROR
    if not config.GEMINI_API_KEY or not texts:
        LAST_ERROR = "GEMINI_API_KEY not set"
        return None
    out: list[list[float]] = []
    for i in range(0, len(texts), 8):
        chunk = texts[i:i + 8]
        for attempt in range(4):
            try:
                r = httpx.post(f"{BASE}/{EMBED_MODEL}:batchEmbedContents", headers=_headers(),
                               json={"requests": [{"model": f"models/{EMBED_MODEL}", "content": {"parts": [{"text": t}]},
                                                   "outputDimensionality": dims, "taskType": task} for t in chunk]}, timeout=60)
                if r.status_code == 429:
                    LAST_ERROR = "Gemini quota (429)"
                    time.sleep(15 * (attempt + 1))
                    continue
                r.raise_for_status()
                out += [e["values"] for e in r.json()["embeddings"]]
                break
            except Exception as e:  # noqa: BLE001
                LAST_ERROR = f"{type(e).__name__}: {str(e)[:120]}"
                time.sleep(3)
        else:
            return None
        if i + 8 < len(texts):
            time.sleep(1.5)
    return out


def generate(prompt: str, timeout: float = 25) -> str:
    """The model's text for one prompt. Raises on network, quota or response-shape errors."""
    res = httpx.post(f"{BASE}/{config.GEMINI_MODEL}:generateContent", headers=_headers(),
                     json={"contents": [{"parts": [{"text": prompt}]}]}, timeout=timeout)
    res.raise_for_status()
    return "".join(part.get("text", "") for part in res.json()["candidates"][0]["content"]["parts"]).strip()


# --------------------------------------------------------------------------------------------- multimodal helpers

def inline(data: bytes, mime: str) -> dict[str, Any]:
    """A request part carrying a file inline (images, PDFs up to ~15 MB)."""
    return {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode("ascii")}}


def text(t: str) -> dict[str, Any]:
    return {"text": t}


def _post(model: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    if not config.GEMINI_API_KEY:
        raise GeminiError("GEMINI_API_KEY is not configured")
    try:
        r = httpx.post(f"{BASE}/{model}:generateContent", headers=_headers(), json=body, timeout=timeout)
    except httpx.HTTPError as e:
        raise GeminiError(f"Gemini unreachable ({type(e).__name__})") from e
    if r.status_code == 429:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except Exception:  # noqa: BLE001
            msg = ""
        if "limit: 0" in msg:  # the model is listed but this key's plan gives it no quota at all
            raise GeminiError(f"'{model}' is not enabled on this Gemini key: its free-tier quota is 0 "
                              "(listed by the API, but billing is needed to call it).", quota_zero=True)
        raise GeminiError("Gemini quota reached (HTTP 429). Try again in a minute.")
    if r.status_code != 200:
        try:
            msg = r.json().get("error", {}).get("message", "")
        except Exception:  # noqa: BLE001
            msg = ""
        raise GeminiError(f"Gemini HTTP {r.status_code}{': ' + msg[:200] if msg else ''}")
    return r.json()


def _parts(resp: dict[str, Any]) -> list[dict[str, Any]]:
    cands = resp.get("candidates") or []
    if not cands:
        reason = (resp.get("promptFeedback") or {}).get("blockReason")
        raise GeminiError(f"Gemini returned no answer{f' (blocked: {reason})' if reason else ''}")
    c = cands[0]
    parts = (c.get("content") or {}).get("parts") or []
    if not parts:
        raise GeminiError(f"Gemini returned an empty answer (finish reason {c.get('finishReason', 'unknown')})")
    return parts


def usage(resp: dict[str, Any]) -> dict[str, Any]:
    u = resp.get("usageMetadata") or {}
    return {"input_tokens": u.get("promptTokenCount"), "output_tokens": u.get("candidatesTokenCount"),
            "thinking_tokens": u.get("thoughtsTokenCount")}


def generate_json(parts: list[dict[str, Any]], schema: dict[str, Any], *, model: str | None = None,
                  system: str | None = None, timeout: float = 90, thinking: str | None = "low") -> tuple[Any, dict[str, Any]]:
    """Structured output: Gemini answers with JSON that follows `schema` (a JSON Schema). Returns (parsed, meta)."""
    model = model or VISION_MODEL
    gen: dict[str, Any] = {"responseMimeType": "application/json", "responseJsonSchema": schema}
    if thinking:
        gen["thinkingConfig"] = {"thinkingLevel": thinking}
    body: dict[str, Any] = {"contents": [{"role": "user", "parts": parts}], "generationConfig": gen}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    t0 = time.time()
    try:
        resp = _post(model, body, timeout)
    except GeminiError as e:
        if thinking and "thinking" in str(e).lower():  # a model without thinking levels: ask again without one
            gen.pop("thinkingConfig", None)
            resp = _post(model, body, timeout)
        else:
            raise
    raw = "".join(p.get("text", "") for p in _parts(resp) if not p.get("thought")).strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise GeminiError("Gemini's answer was not valid JSON") from e
    return parsed, {"model": model, "ms": round((time.time() - t0) * 1000), **usage(resp)}


def generate_image(prompt: str, *, model: str | None = None, aspect: str = "16:9",
                   timeout: float = 120) -> tuple[bytes, str, str, dict[str, Any]]:
    """One generated image -> (bytes, mime, accompanying text, meta). Raises GeminiError when no image comes back."""
    model = model or IMAGE_MODEL
    if not has_model(model):
        raise GeminiError(f"No image-generation model '{model}' on this Gemini key")
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"], "imageConfig": {"aspectRatio": aspect}}}
    t0 = time.time()
    resp = _post(model, body, timeout)
    img, note = None, []
    for p in _parts(resp):
        d = p.get("inlineData") or p.get("inline_data")
        if d and d.get("data") and not p.get("thought"):
            img = (base64.b64decode(d["data"]), d.get("mimeType") or d.get("mime_type") or "image/png")
        elif p.get("text") and not p.get("thought"):
            note.append(p["text"])
    if img is None:
        raise GeminiError("Gemini returned no image")
    return img[0], img[1], " ".join(note).strip(), {"model": model, "ms": round((time.time() - t0) * 1000), **usage(resp)}
