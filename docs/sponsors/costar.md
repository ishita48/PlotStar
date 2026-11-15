# CoStar

**Backend** `services/api/app/sponsors/costar/` · **Frontend** `src/components/sponsors/costar/`

- `loader.py` loads the CoStar hackathon extract (unzipped outside the repo, `COSTAR_KIT_DIR`) into a local SQLite store.
  The kit is licensed and never committed.
- `tools.py` holds the 15 intelligence tools. `mcp_server.py` serves them as the **GeoStar CoStar MCP server**: stdio
  for Claude Code/Desktop (`.mcp.json` → `services/api/run_mcp.py`), and in-process for GeoStar's own agents.
- Analyses: `comps.py` / `valuation.py` / `market.py` (sale comps, value, submarket), `tenancy.py` (occupancy),
  `homes.py` (residential exposure, generator noise), `redevelop.py` (redevelopment screen), `building.py` (building facts,
  Matterport scan scope, conversion check), `deal_room.py` (notes, comp selections, scenarios, audit).
- Routes: `routes_sites.py` (parcels), `routes_building.py` (building, conversion, site walk), `routes_land.py`,
  `routes_site.py`, `routes_intel.py` (tools, MCP audit timeline, deal room, Deal-to-Design).
- UI: the CoStar dossier, Deal Desk, and Existing vs Proposed (the scan next to GeoStar's concept).

## CoStar in the 3D view, across the portfolio, and under every answer

- **Comps in 3D** (`neighbours.py`, `GET /costar/neighbours/{parcel_id}` and `?lat=&lon=`; UI `comps-3d.tsx`): the kit
  properties within a radius of the site as blocks in the Explore 3D scene, metres east and north of the site centre.
  Colour by **asking rent** (area-weighted low asking rate of available lease spaces, $/sf/year) or **availability**
  (marketed lease space / rentable area), with a legend and a hover card. Heights are CoStar storeys x 4.5 m (team
  assumption) or a labelled default; land is a flat pad. The kit says available is not vacant, so the toggle says
  availability, never vacancy. Asking rents are sparse in the kit (about 330 properties have one); blocks without one are grey.
- **Portfolio screening / Ranked list** (`portfolio.py`, `GET /costar/portfolio`, `/costar/portfolio/site/{id}`; UI
  `ranked-sites.tsx`, the Map | Ranked list switch in Define > Site): every candidate parcel in Houston and Los Angeles
  (158) through the same hard gates and pillars as the single-site screen (`app/engine/screening.py`, `siting.py`),
  sortable, with the reasons on each row. Hard-gate status ranks before any score. "Find" also runs Deal-to-Design on the
  top candidates and merges acquisition, NPV, the memo and the tool-call log into the rows. One screen is a few million
  distance checks, so it runs once (single flight), is cached for an hour, and reads public data from the evidence cache.
- **Citations** (`app/sponsors/langchain/deep_agents/citations.py`; UI `citation-chips.tsx`): every CoStar figure in an
  agent answer is tied to its record id and field after the answer is written, from the full tool output kept locally.
  Chips under the answer open the dossier for that record. The model never sees the cited fields.

Tests: `services/api/tests/test_costar_explore.py` (neighbours and portfolio on a synthetic store).

Every result carries `sources` (record references) and a `label` (Sourced, Estimated, Screening, Unknown).
Field reference: [costar-data-dictionary.md](costar-data-dictionary.md).
