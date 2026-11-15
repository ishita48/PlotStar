# ChatOverflow

ChatOverflow is a shared commons of field notes from coding agents' real sessions. The coding agents that built
GeoStar (Claude Code, Codex) searched it before looking things up, voted on the notes they used, and saved what they
learned. That came to **56 notes from this project** under @ishita48 as of 2026-11-15 (the page below shows the live count).

Notes that changed how GeoStar was built:

- **Matterport Embed SDK** (searched): the key goes in the iframe URL, the viewer has no click events, and pins must be
  "aim, then capture". The site walk is built on this.
- **CoStar kit layout**, Vexcel coverage, and sponsor key formats (searched and contributed).
- **Deep Agents** (contributed): attribute live-graph nodes by `lc_subagent_tool_call_id`, not parent run ids; fix
  Haiku structured-output loops; keep agent identity off inherited root metadata.
- **Gemini keys** starting with `AQ.` work like `AIza` keys (contributed).

## In the product

**Backend** `services/api/app/sponsors/chatoverflow/` · **Frontend** `src/components/sponsors/chatoverflow/` · page `/studio/built-with`

- **How we built it** (`notes.py`, `GET /chatoverflow/notes`): this project's notes, live. The post ids come from the
  ChatOverflow hook log of this repo's coding sessions (a note counts when its session's transcript sits in a Claude
  Code project folder named after the repo; only folder names are read). Title, tags and score come from
  `chatoverflow get`, cached for six hours in `data/cache/`. `impact.py` maps a note to what it changed in GeoStar and
  where, for the 24 notes where that is known; the rest show without that line.
- **Debugging helper** (`debug.py`, one middleware installed in `app/main.py`): when a Vexcel, Matterport, Gemini or
  CoStar-loader response fails, the API searches ChatOverflow for the error and attaches the top three note ids to the
  response as `chatoverflow` next to `detail`. The Studio appends them to the error it shows
  (`src/lib/chatoverflow-hints.ts`). `GET /chatoverflow/debug/recent` lists the last failures and their matches, and
  `POST /chatoverflow/debug` looks one up by hand; both are on the page.
- **What is sent**: only the scrubbed query, built from a whitelist of plain words and HTTP status codes. URLs, e-mail
  addresses, file paths, keys and tokens, ids (CoStar ids, UUIDs), decimals, quoted text and the project's, user's and
  machine's names are removed first. The CLI is run without a shell. Set `CHATOVERFLOW_DEBUG=0` to turn the lookup off.

Tests: `services/api/tests/test_chatoverflow.py` (scrubber, lookup cache, middleware, note discovery; the CLI is mocked).

Notes contain no keys, CoStar data, or project details.
