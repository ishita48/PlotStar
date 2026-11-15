# Google Gemini

**Backend** `services/api/app/sponsors/gemini/` · **Frontend** `src/components/sponsors/gemini/` · **Tests**
`services/api/tests/test_gemini_vexcel.py` (all HTTP mocked)

Models are checked against the key's models list (`GET /gemini/status`), not assumed. Defaults, each overridable by env:
`GEMINI_VISION_MODEL=gemini-3.5-flash` (image + PDF input, structured JSON output), `GEMINI_AGENT_MODEL=gemini-3.5-flash`,
`GEMINI_IMAGE_MODEL=gemini-3.1-flash-image`, `GEMINI_MODEL=gemini-3.5-flash-lite` (short text).

| Feature | Where in the Studio | Endpoint | Module |
|---|---|---|---|
| Obstacles on the Vexcel aerial | Explore toolbar, icon button + popover | `POST /gemini/obstacles` | `vision.py` |
| Hazards in a drone frame | Discover, each captured frame card | `POST /gemini/frame` | `vision.py` |
| Zoning / permit PDF Q&A | Define › Requirements › Documents | `POST /gemini/docs`, `/docs/{id}/ask` | `documents.py` |
| AI street-view render | Deliver, beside the exports | `POST /gemini/render` | `render.py` |
| Imagery Analyst subagent | Agent graph (Deep Agents) | via `/agents/*` | `specialist.py` |
| Embeddings, concept summary | Atlas search, `/studio/explain` | — | `client.py` |

## Obstacles: Gemini reads the Vexcel aerial

1. The Vexcel ortho for the site is fetched with the same buffer as the Studio's plan (`min(600, max(W, D) / 2 + 90)` m).
2. Its ground footprint is exact: the image XMP has `pixel-bbox` in zoom-21 Web Mercator pixels, which
   `vexcel.routes.ortho_frame()` turns into metres east/north of the site point. On cached images, the ortho is centred
   on the point to within a pixel and is 2 × buffer wide.
3. The site rectangle plus a margin is cropped and sent to Gemini. Gemini returns boxes as structured JSON
   (`responseJsonSchema`) in its native `box_2d = [ymin, xmin, ymax, xmax]` format, 0–1000 on the crop. Kinds are building,
   structure, trees, water, parking, paving and road.
4. Boxes are converted to the layout engine's site frame: metres from the site rectangle's **south-west corner, x east,
   y north**. Each obstacle's (x, y) is its own south-west corner. Boxes are clipped to the rectangle, and boxes fully
   outside are counted and dropped. Each obstacle has `source: "Gemini on Vexcel ortho"`.
5. Each box comes with a keep/discard suggestion. Roads start discarded because the box around a diagonal road covers
   far more than the road. So do boxes over 35% of the site and boxes under 0.5 confidence. The user decides in the
   popover. **Apply to layouts** sends the kept boxes as `site.obstacles` to `POST /studio/generate` (up to 60). The engine
   avoids them and adds the required check "Clear of mapped obstacles".

**Stated uncertainty.** The aerial's position is exact. The *site rectangle* is assumed centred on the site point and
north-up, as in the plan and 3D views, because the true parcel boundary is not in the data. A box near the edge may
belong to a neighbour, and the popover says so. Kept boxes are stored as metres from the centre, so they are re-fitted
if the rectangle is resized. The popover asks for a re-scan when the size differs from the scanned one.

## Drone frames

The frame card fetches the capture from the bridge and posts it (resized to 1280 px) to `/gemini/frame`. Gemini returns a
two-sentence description, the ground surface, the visibility, and hazards (person, water, wires, vehicle, debris, tree,
structure) with severity and a box. The boxes are drawn on the thumbnail. Results are cached by image hash.

## Zoning and permit documents

The PDF goes to Gemini inline (`application/pdf`, native PDF understanding). The API holds it **in process memory only**:
at most 6 documents for 3 hours, never written to disk. The upload returns an overview (title, kind, pages, summary,
suggested questions). Each question returns an answer plus citations `{page, section, quote}`. Pages are 1-based pages of
the PDF file. Where the PDF's page objects can be counted, any citation to a page that does not exist is flagged.

## Street-view render

The prompt is built only from the engine's concept: building length, depth, height, storeys and floor height, and the
yard items with their count, size and side of the building. A market word such as "Houston" is the only place
reference. It is labelled **"AI render, not a photo"** everywhere.

**On this key (2026-11-15) image generation is not available.** The image models are listed (`gemini-3.1-flash-image`,
`gemini-3-pro-image`, `gemini-2.5-flash-image`, …), but each returns HTTP 429 with free-tier quota `limit: 0`. The API
records that for a day. `/gemini/status` then reports `image_available: false` with the reason, and the Deliver card says
so instead of offering the button. Enabling billing on the Google project turns it on with no code change.

## Imagery Analyst (Deep Agents subagent on Gemini)

`specialist.py` defines `imagery-analyst`. It runs on `ChatGoogleGenerativeAI` (`langchain-google-genai`, already in the
venv) and is registered in `deep_agents/agents.py` the same way as the design editor. Tools:

- `aerial_obstacles`: the Gemini obstacle pipeline above
- `neighbour_heights`: Vexcel DSM − DTM
- `imagery_history`: Vexcel capture dates and obliques

Every tool records evidence (E-ids) like the other specialists. The orchestrator delegates to it for "what is on or
around the site". In the live graph its model nodes show provider `google_genai`. A real run (Sonnet orchestrator → Imagery
Analyst on gemini-3.5-flash → 3 tools) finished in 78 s with every number verified against tool results.

## Privacy

Gemini receives pixels, geometry and the user's own documents and questions. It never receives CoStar names, addresses,
prices, rents, coordinates or ids. The obstacle test asserts that the request body has no parcel id. `GEMINI_API_KEY`
stays server-side.
