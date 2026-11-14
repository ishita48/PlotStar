# SiteStar

SiteStar finds the existing Houston buildings that can become AI data centers soonest. It inspects each one across CoStar's records, 3D scans and aerial photos, and proves on real hardware the grid flexibility that gets it powered.

Built at HackPrinceton Fall 2026.

## Why

- **Power is the bottleneck.** ERCOT is tracking more than 438 GW of large-load requests, nearly 89% of them data centers ([ERCOT, June 2026](https://www.ercot.com/files/docs/2026/06/18/ERCOT-Trending-Topic-New-Batch-Connection-Process-for-Large-Electricity-Users.pdf)). New campuses wait years.
- **The fastest AI sites are conversions.** Prologis turned a warehouse into a 32 MW data center with Skybox; Lambda is converting a Kansas City building into a 24 MW AI factory.
- **Picking the building takes a site visit today.** It needs the records, the inside, the outside and the power picture together.

## What it does

1. **Find.** Fixed rules cut CoStar's 121 Houston industrial, flex and land buildings to **8 finalists**:
   - 121 → **38** outside FEMA's 100-year floodplain and at least 500 m from homes
   - → **14** with a clear height of 24 ft or more
   - → **8** that also have heavy electrical service on site
2. **Inspect.** An agent (Claude) works through each building with tools:
   - CoStar's record
   - the public Matterport 3D scan (it reads the images)
   - an aerial photo (it reads this image too)
   - the flood map and the high-voltage grid
   - the power gap and the pause budget

   It writes a passport. The rules decide pass or fail; the agent explains what it sees and flags what to verify on site.
3. **Power.** The building's own service is a fraction of what AI racks draw, so it needs grid power, and utilities can connect load sooner when it pauses during the tightest hours. From ERCOT's 2025 hourly load:
   - **110 pause hours a year (1.3%) on 37 days**, catching all four summer peaks that set Texas transmission charges (June 19, July 30, August 18 and September 4, 4–6 PM).
   - **About $64 per kW-year** in transmission charges avoided (estimated).
4. **Prove.** Two machines run the same job. On a grid event (website or ESP32 button), the SiteStar machine pauses its flexible work, its measured power falls, and the job still finishes. The Grid Passport record attaches to the building's passport.

The top finalist is a 1.23M sq ft warehouse built in 2022: 40 ft clear height, 3,000 A service, 470 m from a 345 kV line, listed for lease. Its gap is about 2.5 MVA of service today against a 30 MW first phase.

## How it decides

| Check | Rule | Data | Label |
|---|---|---|---|
| Flood | Fail in FEMA zones A or V | FEMA National Flood Hazard Layer (point query) | Sourced |
| Homes | Fail within 500 m of a mapped residential area | OpenStreetMap residential outlines (~110 m cells) | Estimated |
| Shell | Clear height of at least 24 ft | CoStar | Sourced |
| Power | Heavy electrical service (800 A or more) | CoStar | Sourced |
| Also shown | Slab, column spacing, sprinklers, docks, service size, 345 kV and substation distance, listing, 3D scan | CoStar, OpenStreetMap | Sourced or Estimated |

**Agent.** Claude Opus 5.5 (`claude-opus-5-5`, effort medium) runs a tool-use loop over SiteStar's own data (`bridge/agent.py`):
- Tool results carry the aerial photo and the scan snapshots as images.
- Numbers must come from tools.
- The final `submit_passport` call has a strict schema.
- Server-side refusal fallback is on (`fallbacks: "default"`).
- Each run is saved to `bridge/.cache/agent/` and can be replayed if the network fails.
- Without credentials, the page runs the same inspection with rules only and says so.

**Every number is labeled** Measured, Sourced, Estimated, Simulated or Utility-confirmed (none yet). Click any underlined number for its source and formula.

## Run it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r bridge/requirements.txt

# data (once): CoStar kit unzipped into Data/costar-kit
python bridge/costar_sites.py --media    # screen 121 buildings; cache scans and aerials for the finalists (~1 min)
python bridge/pause_budget.py            # ERCOT 2025 hourly load -> web/data/pause-budget.json (committed)

python bridge/server.py --mock-grid      # open http://localhost:8000
```

- **Claude agent.** Put `ANTHROPIC_API_KEY=...` in `bridge/.env` (gitignored) and restart the bridge.
  - Before a demo, warm the replay cache with `python bridge/agent.py --all`.
  - Another model: `SITESTAR_MODEL=...`.
- **Real machine.** Run `sudo -v`, then `python bridge/controller.py --machine optimized`.
  - It runs a numpy job on every core and reports chip power from `powermetrics` once a second.
  - On a second laptop: `python bridge/controller.py --machine baseline --bridge http://<demo-laptop-ip>:8000`, with the bridge started using `--host 0.0.0.0`.
  - With one laptop, the flat machine stays simulated and labeled as such.
- **ESP32 button.** `POST /api/grid/emergency` with `{"active": true, "source": "esp32"}`.
- **No hardware at all:** `python bridge/server.py --mock`.

Presenter keys: **1–5** jump between sections, **0** to the top. `?site=<CoStar id>` opens a finalist; `&inspect=1` starts its inspection.

## Status

| Part | Status |
|---|---|
| Funnel, map, finalists, readiness checklist | Working, on CoStar's data (local only) |
| Inspection, rules-only | Working; includes a live FEMA check |
| Inspection, Claude agent | Built and tested with a scripted client; **not yet run against the live API** (no key on the build laptop) |
| 3D scans and aerial photos | Working: public Matterport snapshots and Esri World Imagery, cached for the 8 finalists; Vexcel and the Matterport SDK need their keys |
| Pause budget (ERCOT 2025) | Working |
| Grid event, Grid Passport, passport attachment | Working |
| Real power measurement | Controller tested with a test meter; `powermetrics` needs `sudo -v` at demo time |
| Printable passport (`passport.html`) | Working |
| Drone | Off by default (`--drone`); not part of this demo |

## What we don't claim

- Distance to a substation is not capacity. Only CenterPoint's study says what it can deliver, and when.
- Slab thickness is recorded for 9 of 121 buildings, and service size for 24. Both need a site visit.
- Pause hours are picked after the fact from 2025 data. Operators act on day-ahead peak alerts.
- The transmission rate is CenterPoint's listed Primary-service TCRF; the listing shows no date, so check the current tariff.
- Laptop watts show how a workload responds to a grid signal. They don't prove a multi-megawatt interconnection.

## Data handling

CoStar's data stays on the demo laptop. The kit (`/Data/`), the screened buildings (`web/data/costar-sites.json`) and the cached scans and aerials (`web/data/media/`) are gitignored. So are API keys (`bridge/.env`) and agent runs (`bridge/.cache/`).

## Bridge endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/agent/status` | Is the Claude agent available, which runs are saved |
| `GET /api/agent/inspect/<id>?mode=live\|replay&pod=&flex=` | The inspection as Server-Sent Events |
| `GET /api/grid` | Machines, grid event, Grid Passport records |
| `POST /api/grid/telemetry` | `{"machine": "baseline"\|"optimized", "watts": 31.2, "progress": 0.4, "done": false, "measure": "chip"\|"wall"\|"system"}` |
| `POST /api/grid/emergency` | `{"active": true, "source": "web"\|"esp32"}` |
