# PlotStar verification

Verified locally on November 14, 2026 (America/New_York).

- `npm.cmd run build`: passes; production compilation, static rendering, API route generation and TypeScript checking complete.
- `npm.cmd run typecheck`: passes independently.
- `npm.cmd test`: 13 tests pass for parsing, distinct rankings, normalized weights, geometry, site bounds, budget response, financial arithmetic, park economics, data center allowances, sensor placement, event rules and contextual reports/assistant responses.
- `npm.cmd run test:e2e`: 6 tests pass against a production server with an isolated SQLite test database, including all three demonstration journeys, authenticated telemetry/device binding/SSE, validation/origin handling, a complete desktop browser journey, mobile landing/dashboard, and mobile project workflow through sensor creation and report export.
- `npm.cmd audit`: zero known vulnerabilities at verification time.
- Generated and parsed report samples for residential, data center and park projects. Rendered all 13 pages, inspected the contact sheet and representative pages, and checked text bounds programmatically: zero blocks outside safe page bounds.
- Browser tests exercise actual React Three Fiber/WebGL rendering using Chromium software WebGL. Desktop model geometry, incident highlighting, mobile layouts and saved edits were inspected. No page errors occurred in the desktop end-to-end journey.
- Main local preview returned HTTP 200 at `http://127.0.0.1:3000`; the normal database contains the three seeded demonstrations. Automated checks use a separate test database.
- The on-demand external Overpass lookup was attempted. It was unavailable in this environment, and the endpoint correctly returned `Illustrative fallback` with zero live points and a visible explanation. Base map tiles are network dependent.

Not verified with external services/equipment: optional LLM calls with a real OpenAI key, flashing the example firmware onto an ESP32, physical sensor calibration and real device connectivity. Hardware HTTP ingestion was verified with authenticated test submissions; this is not a claim of physical hardware connectivity. All site metrics remain illustrative and all designs/safety plans conceptual.

Reviewable outputs: `output/qa/` contains browser captures and rendered report QA; `output/pdf/` contains three sample reports. These files were generated from isolated automated test projects. The application's own **Export PDF** action always uses the current saved project.
