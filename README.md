# SiteStar

SiteStar tells a data center developer **which parcel to build on, whether the grid can power it, and how to run it**, as one decision instead of three separate studies. It screens real sites against hard limits, plans power and operations with an optimizer, and proves the operating plan on real hardware. Every number shows where it came from.

Built at HackPrinceton Fall 2026.

## The problem

- Developers buy land before they know when the grid can power it. A site that waits years for a connection leaves capital idle.
- Floodplains, nearby homes and water limits often come up after money is committed.
- Land, power and operations are studied by different teams with different assumptions, so the trade-offs between them get missed.

## Who it's for

Site-acquisition teams at data center developers, and the investors who underwrite them. First use case: **a developer needs 100 MW near Houston**, starting from CoStar's Houston industrial sites.

## Input and output

**In:** capacity (MW), region, land budget, target online date, and the share of computing that can pause (training runs, batch jobs).

**Out:**
- A shortlist of real sites from CoStar's data, each marked pass, fail or needs review, with the reason, the measured value and the limit.
- Grid access for each site: distance to 138 kV and 345 kV substations and lines, and what still needs a utility study.
- The recommended plan: site, cooling, how much flexibility, and an hourly operating schedule.
- Its cost next to the cost-first pick: the cheapest parcel that passes the same limits, run without flexibility.
- The source, timestamp and formula behind every number.

## How it decides

1. **Hard gates (Site Intelligence).** A parcel is out if it's in FEMA's 100-year floodplain, within the homes buffer (default 500 m), in a high water-stress basin, or zoned against it. A low price can't buy back a failed gate.
2. **Power (PowerReady).** Distance to high-voltage infrastructure, plus a firm-capacity scenario: how many MW the utility can guarantee at peak. Real capacity and connection dates need a utility study, so they stay labeled as scenarios.
3. **Optimizer (Flex-to-Connect).** Chooses site × cooling (air, water, hybrid) × flexibility × hourly schedule to minimize lifecycle cost, and shows the result next to the cost-first pick. It's linear programming, not an LLM guess.
4. **AI agent.** Claude on Amazon Bedrock, through LangChain, answers what-if questions by calling the optimizer and explains the result. It never produces numbers itself.

## What CoStar's data gives us

The CoStar kit covers the 3,339 properties on CoStar's Matterport 3D-scan list in Houston and Los Angeles. In Houston that's 1,758 properties, mostly apartments. **121 are industrial, flex or land, and those are our candidates.**

- **Per site:** location and parcel number, lot size, building size, electric service (amps, volts, heavy power), zoning, year built, active listings, and Matterport 3D scans (113 of the 121 have one).
- **What's there:** median lot 2.6 acres, largest 50 acres. 28 sites have heavy power (800 A or more). 2 are land, and none is a data center today. 61 are listed for lease or sale right now.
- **Screened:** 12 are in FEMA's 100-year floodplain and 78 are within 500 m of homes. **38 pass, and 13 of those already have heavy power.** The top one is a 50-acre warehouse built in 2022 with 3,000 A service, listed for lease, outside the floodplain and 470 m from a 345 kV line.
- **Gaps:** most sites are listed for lease without a public rate, so price is rarely known. The kit's sale comps give past sale prices, each with a confidence status.
- CoStar's data stays on the demo laptop. Neither the kit nor the screened sites are in this repo.

## The key idea

Data centers can be flexible, but that's normally decided after the site is bought. SiteStar uses flexibility to choose the site.

If the grid can guarantee only 70 of 100 MW at peak, a normal data center waits for grid upgrades. If 30% of its computing can pause during the few tightest hours, it can connect now, and running that work in cheaper hours lowers the power bill.

Example on real data: Houston, Nov 13, 2026, ERCOT real-time prices, a facility averaging 80 MW, capped at 70 MW in the day's 3 most expensive hours. SiteStar's schedule stays under the cap and costs **$45,558** for the day vs **$48,008** running flat (**−5.1%**).

## Proof on hardware (Live Digital Twin)

- Two computers run the same job. One runs flat; the other follows SiteStar's schedule.
- A grid-emergency signal (the website button or the ESP32 button) makes the SiteStar machine pause flexible work while critical work keeps running.
- We record the measured drop in watts, how fast it happened, and whether the job still finished. Each event becomes a downloadable Grid Passport record.
- An ESP32 miniature grid replays a real ERCOT day.

## Every number is labeled

**Measured** (our hardware) · **Sourced** (named dataset with a timestamp) · **Estimated** (documented method) · **Simulated** (scenario) · **Utility-confirmed** (none yet). On the site, click any number to see its source and formula.

## What we don't claim

- A nearby substation is not available capacity. Connection dates need a utility study.
- Wholesale prices are not a contracted rate.
- Moving work in time changes cost, carbon and peak, not total energy.
- The hardware shows how a workload responds. It doesn't prove a 100 MW interconnection or lower household bills.

## Status

| Part | Status |
|---|---|
| Live ERCOT data: fuel mix, demand, Houston prices | Working |
| Site screening: FEMA flood zone (live), homes nearby and grid access (OpenStreetMap) | Working |
| Hourly schedule optimizer on real ERCOT prices | Working |
| Emergency button, Grid Passport, drone feed | Working; machine watts are simulated until the controllers report |
| ESP32 grid and button | Bridge endpoint ready; firmware not in the repo yet |
| CoStar's Houston sites: screened and ranked on the map | Working, on the demo laptop only (CoStar data isn't in the repo) |
| Matterport 3D tours | Model IDs linked for 113 sites; the viewer needs CoStar's separate Matterport kit |
| Vexcel imagery | Not in the repo yet |
| Full optimizer (site × cooling × flexibility) and financials (cost, NPV, payback) | Not in the repo yet |
| AI agent | Not in the repo yet |
| Water stress and zoning gates | Not in the repo yet |

**Done when:**
1. At least 3 real CoStar sites are screened, each with its source and the reason for any rejection. **Done: all 121.**
2. The optimizer finds a plan that beats the cost-first pick under the same limits.
3. On the hardware, measured power drops after the emergency signal and the job still finishes.

## Demo (3 minutes)

1. Open on the live Texas grid.
2. Show CoStar's 121 Houston sites narrowing to the 13 that pass with heavy power, then open the top one.
3. Screen "By a 345 kV substation, NW": close to the grid with no neighbors, but it fails on FEMA flood zone AE.
4. Set the grid limit to 70 MW: the flat plan can't connect; SiteStar's can, and it costs less.
5. Press the emergency button: measured watts fall, the job finishes, and a Grid Passport is recorded.
6. Click any number to show where it came from.

## Business

Customers: data center developers, infrastructure investors, industrial land brokers. Revenue: a fee per project analysis, plus a subscription for screening many sites. Pricing isn't validated yet.

## Website

`web/` is the SiteStar site. It reads like the demo script, and every interactive part runs on real data:

| Section | What a judge can do | Data |
|---|---|---|
| Hero | See the Texas grid right now, with a run / ease-off signal for flexible compute | ERCOT fuel mix, demand and Houston prices (live via the bridge, else `web/data/ercot.json`) |
| 01 Where | Click anywhere in Houston to screen a site against hard gates | FEMA flood zones (live per click), OpenStreetMap substations, 138/345 kV lines and residential areas |
| 02 How | Move sliders and watch the optimizer re-plan a real ERCOT day | ERCOT hourly prices and fuel mix; the hourly-schedule LP is solved exactly in the browser |
| 03 Live | Trigger a grid emergency and watch measured watts fall; each event becomes a Grid Passport record | Workload machines and ESP32 via the bridge; Tello camera |
| 04 Evidence | Click any underlined number to see its source, timestamp, formula and label | — |

Presenter tips: keys **1–4** jump between sections, **0** goes back to the top. Links like `?site=zenith`, `?site=channelview`, `?site=brays` or `?site=downtown` open with that example already screened.

CoStar sites: unzip the CoStar kit into `Data/costar-kit/` and run `python bridge/costar_sites.py`. It screens every Houston industrial, flex and land property and writes `web/data/costar-sites.json`, which the map shows as pins plus a ranked shortlist. Both the kit and that file are gitignored: CoStar's data stays on the demo laptop.

### Run it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r bridge/requirements.txt

python bridge/server.py --mock                          # no hardware: simulated drone and machines
python bridge/server.py --tello-ip 172.20.10.14         # drone on your hotspot (see below)
python bridge/server.py --tello-ip <ip> --mock-grid     # real drone, simulated machines
```

Open **http://localhost:8000**. Anything simulated is labeled "Simulated" on the page.

### Refresh the saved data (before the demo)

```bash
python bridge/ercot.py       # web/data/ercot.json: fallback when the bridge or internet is down
python bridge/osm_grid.py    # web/data/houston-grid.json: substations, lines, residential areas (2-4 min)
python bridge/costar_sites.py  # web/data/costar-sites.json: CoStar sites screened (needs Data/costar-kit, ~1 min)
```

### Bridge

```
Tello EDU ──UDP──┐
workload PCs ────┤
ESP32 button ────┼──> bridge/server.py (demo laptop) ──HTTP──> website
ercot.com ───────┘
```

| Endpoint | Body | Who calls it |
|---|---|---|
| `POST /api/grid/telemetry` | `{"machine": "baseline"\|"optimized", "watts": 38.2, "progress": 0.4, "done": false, "measure": "chip"\|"wall"}` | Workload controllers, about once a second |
| `POST /api/grid/emergency` | `{"active": true, "source": "esp32"}` | Website button, ESP32 |
| `GET /api/grid` | | Website; controllers poll it to learn about a grid event. Includes the Grid Passport `events` |
| `GET /api/ercot` | | Website (live ERCOT data, refreshed every 5 minutes) |
| `POST /api/drone/snapshot` | | Website "Capture" button; saves a frame to `captures/` |

### Drone and internet at the same time (station mode)

On its own hotspot the drone takes over the laptop's Wi-Fi. A Tello EDU or Talent can join a 2.4 GHz WPA2-Personal network instead (a phone hotspot or travel router; not eduroam or a captive portal):

```bash
python bridge/tello_wifi.py MyHotspot     # while on TELLO-XXXXXX; prompts for the password
# laptop back on MyHotspot, then:
python bridge/tello_wifi.py --find        # prints the drone's new IP
python bridge/server.py --tello-ip <ip>
```

- iPhone hotspots: turn on **Maximize Compatibility** (2.4 GHz) and use a name without spaces.
- Power-cycle the drone if anything other than the bridge has sent it commands; it locks onto the first sender.
- Hold the drone's power button ~5 s to reset it to hotspot mode.

### Viewing from other devices

- Same network: `python bridge/server.py --host 0.0.0.0` (anyone on that network can then use the controls).
- If the site is hosted elsewhere, it looks for the bridge at `http://localhost:8000`. Override with `?bridge=http://<ip>:8000`.
