"""What a ChatOverflow note changed in GeoStar, where that is known: note id prefix (8 hex chars) -> {changed, where}.

Filled by hand from the code each note shaped (checked with grep when this map was written, 2026-11-15). A note not
listed here is still shown on the page, just without a "what it changed" line. Keep `where` to repo paths.
"""
from __future__ import annotations

IMPACT: dict[str, dict] = {  # keyed by the first 8 characters of the post id, as the CLI and the page show them
    "f2df547a": dict(
        changed="Vexcel 3D context renders: the API serves a pruned root tileset around the site and the viewer loads without siblings.",
        where=["services/api/app/sponsors/vexcel/routes.py", "src/components/sponsors/vexcel/vexcel-context.tsx"]),
    "43e584b3": dict(
        changed="The live agent graph attributes every model and tool call to the right subagent (by lc_subagent_tool_call_id).",
        where=["services/api/app/sponsors/langchain/deep_agents/runtime.py"]),
    "be4f67a1": dict(
        changed="CoStar tool outputs stay in a local vault, out of LangGraph state, so checkpoints and LangSmith traces hold no kit data.",
        where=["services/api/app/sponsors/langchain/copilot.py", "services/api/app/sponsors/langchain/deep_agents/runtime.py"]),
    "2e746f23": dict(
        changed="Model prose is checked number by number against a computed fact sheet (Studio explain, agent verification).",
        where=["services/api/app/routers/studio.py", "services/api/app/sponsors/langchain/deep_agents/agents.py"]),
    "251fba32": dict(
        changed="Gemini calls send the key in the x-goog-api-key header, which accepts the AQ. key format.",
        where=["services/api/app/sponsors/gemini/client.py"]),
    "2f9b4669": dict(
        changed="GeoStar pins gemini-3.5-flash-lite instead of the flash-latest alias, which hung.",
        where=["services/api/app/config.py"]),
    "b5b50e4f": dict(
        changed="Atlas embeddings are paced at eight per batch with backoff and a labelled local fallback.",
        where=["services/api/app/sponsors/mongodb/"]),
    "cd31ec5a": dict(
        changed="The Atlas Search index maps facet fields as both string and stringFacet, so filters and facets both work.",
        where=["services/api/app/sponsors/mongodb/"]),
    "a5960724": dict(
        changed="Atlas Triggers are created from code through the App Services admin API.",
        where=["services/api/scripts/atlas_triggers.py"]),
    "9cf48fd7": dict(
        changed="Deep Agents checkpoints persist in MongoDB Atlas, and tests use in-memory checkpoints.",
        where=["services/api/app/sponsors/langchain/deep_agents/agents.py"]),
    "23cd42fd": dict(
        changed="The CoStar MCP server is written against the mcp 2.x MCPServer API.",
        where=["services/api/app/sponsors/costar/mcp_server.py"]),
    "45e74b93": dict(
        changed="The Atlas TLS handshake failure was the access list, not certificates. Fixed in the Atlas console.",
        where=["services/api/app/sponsors/mongodb/"]),
    "af94d8a9": dict(
        changed="The copilot sets the Claude effort through output_config instead of forcing tool_choice.",
        where=["services/api/app/sponsors/langchain/copilot.py"]),
    "a835ed95": dict(
        changed="The Studio 3D model draws thousands of boxes with one InstancedMesh and drags objects on the ground plane.",
        where=["src/components/studio/model3d.tsx"]),
    "a215785f": dict(
        changed="The facility twin loads meshopt-compressed GLBs through drei useGLTF.",
        where=["src/components/dashboard-2/haven/blackwell-model.tsx"]),
    "f2de104d": dict(
        changed="The twin animates under frameloop='demand' without a constant 60 fps loop.",
        where=["src/components/dashboard-2/twin-canvas.tsx"]),
    "6218eddf": dict(
        changed="The emergency call speaks only the fixed voicemail message (no tool narration).",
        where=["services/api/app/sponsors/cartesia/dispatch.py"]),
    "dcf6dfe7": dict(
        changed="HAVEN dispatch places real outbound calls with Cartesia managed agents, ElevenLabs as fallback.",
        where=["services/api/app/sponsors/cartesia/dispatch.py"]),
    "98d692a6": dict(
        changed="Solar yield calls go to developer.nlr.gov (the old NREL host no longer connects).",
        where=["services/api/app/routers/context.py"]),
    "fcc80ca3": dict(
        changed="The codebase was reorganised by sponsor with a scripted import rewrite, verified in a git worktree.",
        where=["docs/sponsors/README.md"]),
    "f0b5da8a": dict(
        changed="The rename to GeoStar changed visible text and kept the internal plotstar identifiers that data depends on.",
        where=["services/api/app/config.py"]),
    "aeae4e1a": dict(
        changed="The Tello bridge auto-lands and replaces stale video frames with a placeholder.",
        where=["bridge/"]),
    "39d2f192": dict(
        changed="The voice guide uses eleven_flash_v2 and inline client tools.",
        where=["src/components/sponsors/elevenlabs/"]),
    "26429bd7": dict(
        changed="Sponsor docs state only what grep confirms in the code.",
        where=["docs/sponsors/"]),
}

