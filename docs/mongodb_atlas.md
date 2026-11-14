# MongoDB Atlas in PlotStar

PlotStar uses Atlas (cluster `PlotStar`, database `plotstar`) as its data platform. Everything below is
built and verified from code in `services/api/app/atlas.py` and `store.py`; the last section lists the
console-only Atlas features and exactly how to turn them on.

## Collections and schema

| Collection | What | Schema | Indexes |
|---|---|---|---|
| `studio_projects` | one document per Studio project: brief, site (GeoJSON point), priorities, edits, preferred concept, reasons, decider, history, summary, embedding | `$jsonSchema` (status enum, MW range, point) | `updated_at`, `site.loc` 2dsphere, `status+updated_at`, `market`, Vector Search `projects_vec` |
| `sites` | every screened CoStar parcel in both markets (126): location, lot, land price with label, gates with sources, power signals, provenance, embedding | `$jsonSchema` (gate status enum, label enum, point) | `loc` 2dsphere, `market+screen_status`, `lot_acres`, unique `parcel_id`, Atlas Search `sites_search`, Vector Search `sites_vec` |
| `decisions` | append-only audit event per project save (who, what, when, summary) | `$jsonSchema` | `project_id+at`, `at` |
| `grid_telemetry` | **time-series** collection (timeField `ts`, metaField `meta`, seconds, 7-day TTL) of live hardware watts/progress | time-series options | automatic bucketing |
| `grid_days` | cached ERCOT day-ahead price days (24 hourly prices) + hourly carbon shape | `$jsonSchema` (24 prices) | unique `hub+date` |
| `evidence` | metadata of every external evidence fetch (FEMA, WRI Aqueduct, OSM, PVWatts…) | `$jsonSchema` | unique `key`, `source+retrieved_at` |
| `meta` | which embedding model the stored vectors use | — | — |

Validation level is `moderate` so older documents are not rejected on update; new writes must conform.

## Embeddings

Documents are embedded with Gemini `gemini-embedding-001` (768-d, cosine). The free tier throttles batches
(HTTP 429); the embedder paces 8 at a time with backoff. If Gemini is unavailable, it falls back to a local
signed-hash n-gram embedding and records that in `meta` — queries then use the same fallback so the index
stays consistent, and the UI labels results "lexical fallback". Re-run `POST /atlas/seed?sites=true&projects=true`
once quota resets to replace them with Gemini vectors.

## Endpoints (`/atlas/*`)

| Endpoint | Atlas feature |
|---|---|
| `GET /atlas/status` | collections, counts, indexes, validators, time-series, search-index build status |
| `POST /atlas/setup` · `POST /atlas/seed` | idempotent create/upgrade and data load |
| `GET /atlas/search?q=&market=&status=` | **Atlas Search**: fuzzy `compound` query + `$searchMeta` facets |
| `GET /atlas/similar?q=` | **Vector Search**: embed the question, `$vectorSearch` with market/status filters |
| `GET /atlas/projects/{id}/similar` | `$vectorSearch` over project embeddings |
| `GET /atlas/near?lat&lon&km` | `$geoNear` on the 2dsphere index, real distances |
| `GET /atlas/analytics` | `$facet` / `$bucket` / `$group` pipelines over sites, projects, grid days, telemetry, evidence |
| `GET /atlas/decisions` | audit trail |
| `GET /atlas/stream` | **change stream** over projects/decisions/sites as Server-Sent Events |

The judge-facing page `/studio/data` shows all of it live.

## Writes from the app

- `store.save` (every Studio save) → upsert project, push `history`, append a `decisions` event, refresh the embedding.
- `livegrid.record` (every hardware telemetry POST) → one time-series point, written off-thread.

## MongoDB MCP server for Claude Code

Registered locally (not committed) as `mongodb` with `MDB_MCP_READ_ONLY=true`, using `npx -y mongodb-mcp-server`.
Claude Code can then run `find`, `aggregate`, `count`, `list-collections`, `collection-schema` and friends
against the cluster in a new session. To re-register: `claude mcp add --scope local mongodb -e MDB_MCP_CONNECTION_STRING=<uri> -e MDB_MCP_READ_ONLY=true -- npx -y mongodb-mcp-server`.

## Console-only Atlas features (not provisionable from the app)

- **Triggers** (App Services): Database → Triggers → Add → collection `decisions`, operation Insert, function:
  send a webhook/Slack message with `fullDocument.project_id` and `.by`. Also useful: an insert trigger on
  `grid_telemetry` that writes an alert document when `watts > 900`.
- **Charts (Visualization)**: Data Visualization → add dashboard on `plotstar` → suggested charts: sites by
  `screen_status` (donut), `gates.gate` fails (bar), `lot_acres` histogram, `studio_projects` capex vs NPV
  (scatter, colour by `brief.cooling`), `grid_telemetry` watts over time (line, by `meta.machine`).
- **Stream Processing**: needs a Stream Processing Instance (paid tier). A natural use is a windowed
  `$tumblingWindow` over `grid_telemetry` to emit minute averages into a `grid_minutes` collection.
- **Data Federation**: can expose the CoStar extract files in S3 as a federated collection; not used because
  the kit is licensed and kept off cloud storage.
- **Search & Vector Search**: already created from code (three indexes, the free-tier maximum).
