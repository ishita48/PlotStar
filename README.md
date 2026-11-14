# SiteStar

**SiteStar is an AI-powered platform that helps companies decide where to build data centers, whether the investment is profitable, and how to operate them efficiently.**

## Core Modules

1. **Site Intelligence:** Finds suitable land and evaluates environmental and infrastructure risks.
2. **PowerReady:** Estimates electricity availability, construction costs, timelines, and investment returns. Actual grid capacity and connection dates require utility confirmation.
3. **Flex-to-Connect:** Optimizes computing schedules, electricity costs, cooling, and grid demand.
4. **AI Intelligence:** Answers what-if questions, compares scenarios, tracks evidence, and generates investment recommendations.
5. **Live Digital Twin:** Uses real computing hardware, sensors, and an ESP32-powered miniature grid to demonstrate energy optimization.

## The Big Idea

Instead of choosing land, securing electricity, and planning operations separately, **SiteStar optimizes all three together**.

## Mission

Help businesses make smarter billion-dollar infrastructure decisions while reducing costs, grid strain, and environmental impact.

## 30-Second Pitch

Companies spend enormous amounts building data centers, but cheap land doesn't always mean a profitable project. A site might have expensive electricity, limited grid capacity, or environmental restrictions. SiteStar uses AI to find suitable properties, analyze investment costs and infrastructure risks, and determine the best way to operate a data center. It optimizes location and energy usage together, then demonstrates the operating strategy using real computing hardware.

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

CoStar parcels: drop records into `web/data/parcels.json` (`[{"id", "name", "lat", "lon", "acres", "price", "source"}]`) and they appear as pins that screen on click.

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
