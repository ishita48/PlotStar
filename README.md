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

## Website & Live Feeds

The `web/` folder is the SiteStar website (content follows `idea/AFTERLIGHT_PRD_v4.docx`). The `bridge/` folder is a small Python server that serves the site and two live feeds:

- **Aerial site view:** a **Tello EDU** drone's camera, telemetry and flight controls.
- **Live Grid:** measured watts from the baseline and optimized workload machines, plus a grid-emergency switch shared by the website and the ESP32 button.

```
Tello EDU ──UDP──┐
workload PCs ────┼──> bridge/server.py (laptop) ──HTTP──> website
ESP32 button ────┘
```

### Run it

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r bridge/requirements.txt

# No hardware? Simulated drone and grid (labeled "Simulated" on the page):
python bridge/server.py --mock

# Drone, simple: join its TELLO-XXXXXX Wi-Fi, then
python bridge/server.py
```

Open **http://localhost:8000**.

### Drone and internet at the same time (station mode)

On its own hotspot the drone takes over the laptop's Wi-Fi. A Tello EDU can join a normal 2.4 GHz WPA2-Personal network instead (a phone hotspot or travel router; not eduroam or a captive portal):

```bash
python bridge/tello_wifi.py MyHotspot     # while on TELLO-XXXXXX; prompts for the password
# laptop back on MyHotspot, then:
python bridge/tello_wifi.py --find        # prints the drone's new IP
python bridge/server.py --tello-ip <ip>
```

Hold the drone's power button ~5 s to reset it to hotspot mode.

### Live Grid API

| Endpoint | Body | Who calls it |
|---|---|---|
| `POST /api/grid/telemetry` | `{"machine": "baseline"\|"optimized", "watts": 38.2, "progress": 0.4, "done": false, "measure": "chip"\|"wall"}` | Workload controllers, ~1×/s |
| `POST /api/grid/emergency` | `{"active": true}` | Website button, ESP32 |
| `GET /api/grid` | | Website, controllers (to learn about a grid event) |

### Viewing from other devices

- Same network: `python bridge/server.py --host 0.0.0.0` (anyone on that network can then use the controls).
- If the site is hosted elsewhere, it looks for the bridge at `http://localhost:8000`. Override with `?bridge=http://<ip>:8000`.
