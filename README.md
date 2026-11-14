# PlotStar

**PlotStar is an AI-powered platform that helps companies decide where to build data centers, whether the investment is profitable, and how to operate them efficiently.**

## Core Modules

1. **Site Intelligence:** Finds suitable land and evaluates environmental and infrastructure risks.
2. **PowerReady:** Estimates electricity availability, construction costs, timelines, and investment returns. Actual grid capacity and connection dates require utility confirmation.
3. **Flex-to-Connect:** Optimizes computing schedules, electricity costs, cooling, and grid demand.
4. **AI Intelligence:** Answers what-if questions, compares scenarios, tracks evidence, and generates investment recommendations.
5. **Live Digital Twin:** Uses real computing hardware, sensors, and an ESP32-powered miniature grid to demonstrate energy optimization.

## The Big Idea

Instead of choosing land, securing electricity, and planning operations separately, **PlotStar optimizes all three together**.

## Mission

Help businesses make smarter billion-dollar infrastructure decisions while reducing costs, grid strain, and environmental impact.

## 30-Second Pitch

Companies spend enormous amounts building data centers, but cheap land doesn't always mean a profitable project. A site might have expensive electricity, limited grid capacity, or environmental restrictions. PlotStar uses AI to find suitable properties, analyze investment costs and infrastructure risks, and determine the best way to operate a data center. It optimizes location and energy usage together, then demonstrates the operating strategy using real computing hardware.

---

## Build status

The product is built from `AFTERLIGHT_PRD_v4.docx` (the PRD calls the product AFTERLIGHT; the product name is now **PlotStar**), phase by phase (PRD Appendix A).

| Phase | Scope | Status |
|---|---|---|
| 0 | Monorepo scaffold, landing page, six-tab dashboard, design tokens, mock-free empty states | ✅ Done |
| 1 | CoStar loader → normalized parcels with provenance, data dictionary, map in Site Explorer, Matterport 3D | ✅ Done, except Vexcel imagery (waiting on quickstart) |
| 2 | Hard-gate screening (homes, water, flood, cooling, zoning), OSM substations | Next |
| 3 | PowerReady: grid feasibility + underwriting model with tests | |
| 4 | Optimizer (enumeration + hourly LP), cost-first baseline, `/optimize` | |
| 5 | LangChain agent on Bedrock with tool trace | |
| 6 | Live Grid: controller, telemetry, ESP32 emergency | |
| 7 | Reports and full audit trail | |

## Repository layout

```
apps/web/            Next.js 16 + React 19 + Tailwind 4: landing page and dashboard
services/api/        FastAPI: CoStar ingestion, sites, audit, projects, Matterport proxy
  app/costar/loader.py   CoStar extract → SQLite (data/cache/plotstar.db)
  tests/                 pytest (synthetic fixture kit, never real data)
docs/                costar_data_dictionary.md (intake findings and schema)
data/cache/          local SQLite evidence store (gitignored)
```

## Run locally

Prerequisites: Python 3.12+, Node 20+, and the CoStar kit extracted **outside the repo**.

```bash
# 1. Secrets and data location
cp .env.example .env          # fill in keys; set COSTAR_KIT_DIR to the extracted kit

# 2. API (port 8000)
cd services/api
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m app.costar.loader          # builds data/cache/plotstar.db (~3 s)
.venv/Scripts/python -m pytest -q
.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# 3. Web (port 3000)
cd apps/web
npm install
npm run dev                   # http://localhost:3000
```

API docs: http://localhost:8000/docs. Key endpoints: `GET /sites`, `GET /sites/{id}`,
`GET /audit/parcel/{id}/{field}`, `GET /data/summary`, `POST /projects`, `GET /matterport/models/{id}`.

## Ground rules (from the PRD)

- Never fabricate data. Missing values are **Unknown** and listed as evidence gaps.
- Every displayed number carries a label: Measured, Sourced, Estimated, Simulated or Utility-confirmed.
- Secrets live in `.env` only. The CoStar kit and SQLite cache are never committed.
- The optimizer decides; the language model explains.
