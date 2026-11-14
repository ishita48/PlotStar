// SiteStar live feeds: talks to the local bridge (bridge/server.py).
//
// Bridge discovery order:
//   1. ?bridge=http://host:port in the page URL
//   2. Same origin (when the page is served by the bridge itself)
//   3. http://localhost:8000

const POLL_MS = 2000;
const GRID_POLL_MS = 1000;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const el = {
  img: $("feed-img"),
  offline: $("feed-offline"),
  offlineMsg: $("feed-offline-msg"),
  dot: $("status-dot"),
  statusText: $("status-text"),
  battery: $("t-battery"),
  height: $("t-height"),
  temp: $("t-temp"),
  flight: $("t-flight"),
  controls: document.querySelectorAll("#controls .ctl"),
  cmdMsg: $("cmd-msg"),
  gridLabel: $("grid-label"),
  gridState: $("grid-state"),
  gridBtn: $("grid-emergency"),
  machines: document.querySelectorAll(".machine"),
};

let bridge = null;     // base URL of a reachable bridge ("" = same origin)
let streaming = false;
let emergency = false;

function candidates() {
  const list = [];
  if (params.get("bridge")) list.push(params.get("bridge").replace(/\/$/, ""));
  if (location.protocol.startsWith("http")) list.push("");
  list.push("http://localhost:8000");
  return [...new Set(list)];
}

async function getJSON(path, base = bridge) {
  const res = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`${bridge}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- Drone ---------- */

async function pollDrone() {
  try {
    if (bridge === null) {
      for (const base of candidates()) {
        try {
          const s = await getJSON("/api/status", base);
          if (typeof s.connected !== "boolean") continue; // not a SiteStar bridge
          bridge = base;
          renderDrone(s);
          return;
        } catch { /* try next */ }
      }
      throw new Error("no bridge");
    }
    renderDrone(await getJSON("/api/status"));
  } catch {
    bridge = null;
    renderDroneOffline("Bridge not running. Start it with <code>python bridge/server.py</code>.");
    renderGridOffline();
  } finally {
    setTimeout(pollDrone, POLL_MS);
  }
}

function renderDrone(s) {
  if (!s.connected) {
    renderDroneOffline(s.error
      ? "Bridge is up, but the drone isn't responding. Is the drone on the same Wi-Fi as this laptop?"
      : "Bridge is up. Connecting to drone…");
    return;
  }

  if (!streaming) {
    el.img.src = `${bridge}/video?t=${Date.now()}`;
    el.img.hidden = false;
    el.offline.hidden = true;
    streaming = true;
  }

  el.dot.className = `dot ${s.mock ? "sim" : "live"}`;
  el.statusText.textContent = s.mock ? "Simulated" : "Live";
  el.battery.textContent = s.battery != null ? `${s.battery}%` : "—";
  el.height.textContent = s.height != null ? `${s.height} cm` : "—";
  el.temp.textContent = s.temp != null ? `${s.temp} °C` : "—";
  el.flight.textContent = s.flying ? "Airborne" : "Landed";
  el.controls.forEach((b) => (b.disabled = false));
}

function renderDroneOffline(msgHtml) {
  if (streaming) {
    el.img.removeAttribute("src"); // closes the MJPEG connection
    el.img.hidden = true;
    el.offline.hidden = false;
    streaming = false;
  }
  el.offlineMsg.innerHTML = msgHtml;
  el.dot.className = "dot";
  el.statusText.textContent = "Offline";
  [el.battery, el.height, el.temp, el.flight].forEach((d) => (d.textContent = "—"));
  el.controls.forEach((b) => (b.disabled = true));
}

el.img.addEventListener("error", () => { streaming = false; });

async function sendCommand(action, button) {
  if (bridge === null) return;
  button.disabled = true;
  showMsg(`Sending “${action}”…`);
  try {
    await postJSON("/api/command", { action });
    showMsg(`✓ ${action}`);
  } catch (err) {
    showMsg(`✗ ${action}: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function showMsg(text, isError = false) {
  el.cmdMsg.textContent = text;
  el.cmdMsg.classList.toggle("err", isError);
}

el.controls.forEach((b) =>
  b.addEventListener("click", () => sendCommand(b.dataset.action, b))
);

/* ---------- Live Grid ---------- */

async function pollGrid() {
  if (bridge !== null) {
    try {
      renderGrid(await getJSON("/api/grid"));
    } catch {
      renderGridOffline("Bridge has no Live Grid yet");
    }
  }
  setTimeout(pollGrid, GRID_POLL_MS);
}

function renderGrid(g) {
  emergency = g.emergency;
  const any = Object.values(g.machines).some(Boolean);
  setTag(g.mock ? ["Simulated", "tag-simulated"] : any ? ["Measured", "tag-measured"] : ["Waiting", ""]);

  el.gridBtn.disabled = false;
  el.gridBtn.classList.toggle("active", emergency);
  el.gridBtn.textContent = emergency ? "End grid emergency" : "Trigger grid emergency";
  el.gridState.classList.toggle("alert", emergency);
  el.gridState.textContent = emergency
    ? `Grid emergency · ${Math.round(g.now - g.emergency_since)} s`
    : "Normal operation";

  el.machines.forEach((node) => renderMachine(node, g.machines[node.dataset.machine]));
}

function renderMachine(node, m) {
  const f = (name) => node.querySelector(`[data-f="${name}"]`);
  node.classList.toggle("stale", Boolean(m && m.stale));
  if (!m) {
    f("watts").textContent = "—";
    f("spark").setAttribute("points", "");
    f("bar").style.width = "0";
    f("meta").textContent = "No telemetry yet";
    return;
  }
  f("watts").textContent = m.watts.toFixed(1);
  f("spark").setAttribute("points", sparkPoints(m.history));
  f("bar").style.width = `${Math.round((m.progress ?? 0) * 100)}%`;
  const parts = [];
  if (m.progress != null) parts.push(m.done ? "Job complete" : `Job ${Math.round(m.progress * 100)}%`);
  if (m.measure) parts.push(m.measure === "wall" ? "wall-plug reading" : "chip-level reading");
  if (m.stale) parts.push("no update for 5 s+");
  f("meta").textContent = parts.join(" · ") || "Reporting";
}

function sparkPoints(history) {
  if (history.length < 2) return "";
  const max = Math.max(...history.map(([, w]) => w), 1);
  const t0 = history[0][0];
  const span = history[history.length - 1][0] - t0 || 1;
  return history
    .map(([t, w]) => `${(((t - t0) / span) * 120).toFixed(1)},${(31 - (w / max) * 29).toFixed(1)}`)
    .join(" ");
}

function setTag([text, cls]) {
  el.gridLabel.textContent = text;
  el.gridLabel.className = `tag ${cls}`;
}

function renderGridOffline(state = "Bridge offline") {
  setTag(["Offline", ""]);
  el.gridBtn.disabled = true;
  el.gridState.classList.remove("alert");
  el.gridState.textContent = state;
  el.machines.forEach((node) => renderMachine(node, null));
}

el.gridBtn.addEventListener("click", async () => {
  el.gridBtn.disabled = true;
  try {
    const r = await postJSON("/api/grid/emergency", { active: !emergency });
    emergency = r.emergency;
  } catch (err) {
    el.gridState.textContent = `Couldn't reach the bridge: ${err.message}`;
  } finally {
    el.gridBtn.disabled = false;
  }
});

renderDroneOffline("Looking for the bridge…");
renderGridOffline("Looking for the bridge…");
pollDrone();
pollGrid();
