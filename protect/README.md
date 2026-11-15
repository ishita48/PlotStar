# SiteStar PROTECT

**Find It. Design It. Protect It.** This is the third module. DESIGN's floor plan decides where
sensors go. A model dorm on the table runs real sensors. An AI incident commander
(LangChain **Deep Agents** on **Claude via Amazon Bedrock**) investigates, writes the dossier,
plans the repair, and asks the building manager for approval **over iMessage (Photon)**.

```
 DESIGN building.json ──► sensor planner (where sensors go, and why)
                              │
 ESP32 model dorm ──USB──► detector ──► reflexes (instant, deterministic)
   leak probe + valve          │            └─► "ALERT" text in < 1 s
   smoke beam, DHT11,          ▼
   pipe temp, PIR, sump     Deep Agent incident commander (Claude on Bedrock)
                              ├─ diagnostician sub-agent   (history + topology → cause)
                              ├─ maintenance-planner       (vendor + work order)
                              ├─ filesystem: /incidents/<id>/report.md, work_order.md
                              └─ human-in-the-loop: dispatch / reopen valve ──► iMessage YES/NO
```

**Safety design (say this to judges):** the AI is never in the safety loop. Water on the probe
closes the valve **in firmware within ~50 ms**, with no laptop and no AI involved. A hardware
interlock refuses to reopen while the probe is wet, whoever asks. The AI does the judgment work:
it works out cause and risk across rooms, the repair plan, and who to call. A human approves
anything that costs money or re-pressurises a pipe.

## Run it

```bash
.venv/bin/pip install -r protect/requirements.txt
```

No hardware (fake board, controls on the dashboard):

```bash
.venv/bin/python protect/run.py run --sim
```

Real ESP32 (auto-detects the port):

```bash
.venv/bin/python protect/run.py run
```

Dashboard: http://127.0.0.1:8796/. Fake board in its own terminal:
`.venv/bin/python protect/run.py fake-board`. Sensor plan: `.venv/bin/python protect/run.py plan`.

Tests: `cd protect && ../.venv/bin/python -m pytest -q` (13 tests). One of them drives the real
Deep Agents graph through tool calls, the dossier write, and the approval pause and resume.

### AI model
| Credentials found | Model used |
|---|---|
| AWS credentials (`aws configure` or env vars) | Claude on **Amazon Bedrock**, `BEDROCK_MODEL_ID` (default `anthropic.claude-opus-5-5`; confirm the ID in your Bedrock console), `AWS_REGION` (default us-east-1) |
| `ANTHROPIC_API_KEY` | Claude API, `claude-opus-5-5` |
| none, or a model error mid-demo | **Offline playbook**: same dossier, work order, texts and approvals, labelled OFFLINE |

Force one with `--llm bedrock|anthropic|offline`.

### iMessage (Photon track)
1. Create a project at https://app.photon.codes, add an iMessage line, and copy the project ID and secret.
2. Start the bridge:

```bash
cd protect/photon-bridge && npm install && SPECTRUM_PROJECT_ID=... SPECTRUM_PROJECT_SECRET=... npm start
```

3. Text the agent's number "hi" from the manager's phone, or set `MANAGER_PHONE=+1...`.
4. Run PROTECT as usual. Alerts, updates and approvals arrive as iMessages, and a reply of "YES",
   "NO" or a question ("what happened?") goes straight back to the agent.
   If the bridge is down, the dashboard phone panel works the same way.

## Wiring (kit parts only)

**Power:** the ESP32 runs from USB. The power module (on the 9V battery, both jumpers at 5V)
feeds the servo, fan, relay, PIR and ultrasonic. **Connect ESP32 GND to the module GND.**
Sensors that report to the ESP32 run on its **3V3** pin.

| ESP32 pin | Part | Notes |
|---|---|---|
| 21 / 22 | OLED SDA / SCL | 3V3 |
| 23 | SG90 valve servo signal | servo red to 5V; tape a paper valve handle on the horn |
| 4 | leak probe wire A | bare jumper end |
| 34 | leak probe wire B **and** 100k to GND | lay both bare ends on a paper towel, 5 mm apart |
| 5 | 220Ω → white LED (smoke-beam source) | point it straight at the photoresistor |
| 35 | photoresistor (other leg to 3V3) **and** 10k to GND | 2–4 cm gap = the "smoke chamber" |
| 26 | DHT11 data | DHT11 on 3V3 |
| 32 | 10k (to 3V3) / thermistor (to GND) junction | tape the thermistor to a "pipe" (straw) |
| 27 | PIR OUT | PIR on 5V; output is 3.3 V, safe |
| 2 | ultrasonic TRIG | sensor on 5V |
| 39 | ultrasonic ECHO via **1k (from ECHO) / 2k (to GND)** divider | 5 V → 3.3 V |
| 36 | button to GND + **10k pull-up to 3V3** | GPIO36 has no internal pull-up |
| 33 | L293D pin 1 (EN) | IN1 (pin 2) → 5V, IN2 (pin 7) → GND, pins 8+16 → 5V, 4/5/12/13 → GND, motor on 3/6 |
| 14 | 1k → PN2222 base | relay coil 5V → collector, diode across coil (stripe to 5V); relay COM 5V, NO → white strobe LEDs |
| 13 | active buzzer + | − to GND |
| 16 / 17 / 18 | 74HC595 DS (14) / SH_CP (11) / ST_CP (12) | VCC 16 + MR 10 → 3V3; GND 8 + OE 13 → GND |
| 74HC595 Q0–Q7 | room LEDs: R1 green, R1 red, R2 green, R2 red, R3 green, R3 red, R4 green, R4 red | 220Ω each to GND |
| 19 / 15 / 12 | RGB LED R / G / B (common cathode to GND) | 220Ω each; AI status: purple thinking, yellow needs you, green done |

Rooms: **R1** 2F Bathroom (probe and valve) · **R2** B1 Mechanical (DHT11, pipe, sump, fan) ·
**R3** 1F Lounge (smoke beam, PIR), directly below R1 · **R4** 1F Corridor (strobe).
Build a two-storey cardboard dorm with the bathroom on top of the lounge. That stacking is the
point: the AI reasons that water above means risk below.

Flash `hardware/firmware/esp32_building/esp32_building.ino` (needs Adafruit SSD1306, Adafruit GFX,
and DHT sensor library). Verified: compiles on esp32 core 3.3.12. **Power up with the probe dry
and the beam clear**, because those become its baselines. Hold the button at power-up for the self-test.

## Things a judge can do at the table
| Do this | What happens |
|---|---|
| Drip water on the paper towel | valve snaps shut in ~50 ms, bathroom LED red, lounge LED amber (it's below), iMessage alert, AI investigates, plumber approval on your phone |
| Hold a hand or paper in the smoke beam | strobe + alarm, **fan forced OFF** (smoke spread), lounge + corridor red, evacuation note if the PIR sees someone |
| Breathe on the DHT11 | humidity spike → fan 60%, AI checks for steam or a slow leak |
| Pinch the DHT11 | overheat → fan 100% |
| Ice cube on the pipe thermistor | freeze-risk warning → plumbing work order |
| Text "what happened?" | the agent answers from the incident thread |

## 3-minute demo (PROTECT is the last 60 seconds)
1. *(DISCOVER, 60 s)* "200-bed dorm near Rice": the agent ranks Houston parcels from CoStar.
2. *(DESIGN, 50 s)* pick a parcel: the Vexcel footprint becomes the massing and floor plan.
3. *(PROTECT, 60 s)* "Here's that building." The sensor plan comes from the floor plan. A judge drips
   water: the valve shuts **before the AI even starts**, the phone buzzes, and the AI says the lounge
   below is occupied. The judge's phone gets "Approve plumber, $185?" They reply YES and it's dispatched.
4. *(10 s)* "From idea, to land, to design, to a building that protects itself."
