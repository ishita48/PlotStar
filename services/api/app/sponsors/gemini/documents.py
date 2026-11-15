"""Zoning and permit documents: upload a PDF, ask Gemini questions about it, get answers with page citations.

The PDF is held in this process's memory only (never written to disk, never sent anywhere but Gemini), at most
MAX_DOCS documents for TTL_S each. Gemini reads the PDF natively (inline application/pdf, text and page images).
Citations are the pages Gemini reports; each quote is checked against the page range so an impossible page is flagged.
"""
from __future__ import annotations

import re
import threading
import time
import uuid
from typing import Any

from app.sponsors.gemini import client as G

MAX_BYTES = 15 * 1024 * 1024  # inline request limit is ~20 MB after base64
MAX_DOCS = 6
TTL_S = 3 * 3600
_DOCS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()

OVERVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "kind": {"type": "string", "description": "e.g. zoning ordinance, permit, deed restriction, site plan, other"},
        "pages": {"type": "integer", "description": "Number of pages in the PDF"},
        "summary": {"type": "string", "description": "Two sentences"},
        "topics": {"type": "array", "items": {"type": "string"}, "description": "Up to 6 topics a site planner would ask about"},
        "suggested_questions": {"type": "array", "items": {"type": "string"}, "description": "Three questions this document can answer"},
    },
    "required": ["title", "kind", "pages", "summary", "topics", "suggested_questions"],
}
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean", "description": "false when the document does not answer the question"},
        "answer": {"type": "string", "description": "Plain language, under 120 words, only from the document"},
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"page": {"type": "integer", "description": "1-based page of the PDF file"},
                               "section": {"type": "string", "description": "Section number or heading, if any"},
                               "quote": {"type": "string", "description": "The exact words, under 40 words"}},
                "required": ["page", "quote"],
            },
        },
    },
    "required": ["found", "answer", "citations"],
}
SYSTEM = ("You answer questions about one document a site planner uploaded (zoning code, permit, deed restriction). "
          "Use only the document. Cite every claim with the 1-based page number of the PDF file (the first page of the file "
          "is page 1, whatever number is printed on it) and an exact quote. If the document does not answer the question, "
          "set found to false and say what it does cover instead. Never use outside knowledge of any city's rules.")


def _pdf_page_hint(data: bytes) -> int | None:
    """Page count from the PDF's page objects when they are not compressed; None when it cannot tell."""
    n = len(re.findall(rb"/Type\s*/Page(?!s)", data))
    return n or None


def _prune() -> None:
    now = time.time()
    for k in [k for k, d in _DOCS.items() if now - d["at"] > TTL_S]:
        _DOCS.pop(k, None)
    while len(_DOCS) >= MAX_DOCS:
        _DOCS.pop(min(_DOCS, key=lambda k: _DOCS[k]["at"]), None)


def add(name: str, data: bytes) -> dict[str, Any]:
    if not data.startswith(b"%PDF"):
        raise ValueError("That file is not a PDF")
    if len(data) > MAX_BYTES:
        raise ValueError(f"PDF is larger than {MAX_BYTES // (1024 * 1024)} MB")
    raw, info = G.generate_json([G.inline(data, "application/pdf"),
                                 G.text("Give an overview of this document for a site planner.")], OVERVIEW_SCHEMA,
                                system=SYSTEM)
    hint = _pdf_page_hint(data)
    pages = hint or (int(raw.get("pages")) if str(raw.get("pages") or "").isdigit() or isinstance(raw.get("pages"), int) else None)
    doc = {"id": uuid.uuid4().hex[:12], "name": re.sub(r"[^\w .()-]", "", name)[:80] or "document.pdf", "bytes": len(data),
           "pages": pages, "pages_from": "PDF page objects" if hint else "Gemini",
           "title": str(raw.get("title") or "")[:160], "kind": str(raw.get("kind") or "")[:60],
           "summary": str(raw.get("summary") or "")[:600], "topics": [str(t)[:60] for t in (raw.get("topics") or [])][:6],
           "suggested": [str(q)[:160] for q in (raw.get("suggested_questions") or [])][:3], "model": info["model"]}
    with _LOCK:
        _prune()
        _DOCS[doc["id"]] = {"data": data, "at": time.time(), "meta": doc}
    return {**doc, "storage": "In API memory only, for up to 3 hours. Not saved to disk."}


def get(doc_id: str) -> dict[str, Any] | None:
    with _LOCK:
        d = _DOCS.get(doc_id)
        if d:
            d["at"] = time.time()
        return d


def remove(doc_id: str) -> bool:
    with _LOCK:
        return _DOCS.pop(doc_id, None) is not None


def ask(doc_id: str, question: str) -> dict[str, Any]:
    d = get(doc_id)
    if d is None:
        raise KeyError("Document not found (it is kept in memory for 3 hours; upload it again)")
    q = question.strip()[:600]
    if not q:
        raise ValueError("Ask a question")
    raw, info = G.generate_json([G.inline(d["data"], "application/pdf"), G.text(f"Question: {q}")], ANSWER_SCHEMA,
                                system=SYSTEM)
    pages = d["meta"].get("pages")
    cites = []
    for c in raw.get("citations") or []:
        try:
            page = int(c.get("page"))
        except (TypeError, ValueError):
            continue
        cites.append({"page": page, "section": str(c.get("section") or "")[:80], "quote": str(c.get("quote") or "")[:300],
                      "page_ok": pages is None or 1 <= page <= pages})
    return {"question": q, "found": bool(raw.get("found")), "answer": str(raw.get("answer") or ""), "citations": cites,
            "model": info["model"], "ms": info["ms"], "document": d["meta"]["name"],
            "label": "AI answer from your document. Check the cited pages."}
