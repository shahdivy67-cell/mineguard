/**
 * MineGuard Server — REAL DATA ONLY.
 *
 * There is NO simulator in this file. Nothing here generates speed, TTC,
 * position, obstacles, fog readings, or any other invented value. The only
 * sensor data that exists comes from the Arduino over the serial bridge
 * (POST /telemetry, local-only), and values the hardware cannot measure
 * are reported as null with explicit "N/A" text.
 *
 * - Ingests real telemetry (HC-SR04 distance + LED/buzzer state reported
 *   by the firmware) via POST /telemetry — local loopback only, so a
 *   device holding a share link cannot inject sensor data.
 * - Risk engine: computed ONLY from available real data
 *     · ultrasonic distance vs fog-gated thresholds
 *     · communication freshness (live / no data)
 *     · the PC-controlled fog intensity (a control value, not a sensor)
 *   Speed and TTC are never computed — the rig has no speed sensor.
 * - Fog: operator sets 0-100 on the PC. 0-30 = fog-dependent logic OFF,
 *   31-100 = fog-dependent logic ON (same gate the firmware uses).
 * - Broadcasts state to the dashboard over WebSocket.
 * - Read-only share links: /view/<token> streams state, refuses commands.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, "..", "data");

const loadJSON = (file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"));

// Device identity comes from config (name only — no routes, no start points).
const deviceCfg = (loadJSON("vehicles.json").vehicles || [])[0] || { id: "MG-01", name: "Sensor truck" };

// Historical events from the simulation era are archived ONCE (marker file);
// after that, the log is REAL history and is preserved across restarts —
// anything still marked "active" from a previous run becomes historical.
const EVENTS_PATH = path.join(DATA_DIR, "events.json");
const EVENTS_MIGRATED = path.join(DATA_DIR, ".events-migrated");
let eventLog = [];
try {
  const old = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
  if (Array.isArray(old) && old.length) {
    if (!fs.existsSync(EVENTS_MIGRATED)) {
      const archive = path.join(DATA_DIR, `events-sim-${Date.now()}.json`);
      fs.writeFileSync(archive, JSON.stringify(old, null, 2));
      fs.writeFileSync(EVENTS_MIGRATED, String(Date.now()));
      console.log(`archived ${old.length} historical (simulation-era) events -> ${path.basename(archive)}`);
    } else {
      eventLog = old.map((e) =>
        e.status === "active" || e.status === "escalated" ? { ...e, status: "resolved" } : e
      );
    }
  }
} catch {}
fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventLog, null, 2));

// ---------------------------------------------------------------------------
// Prototype thresholds (NOT real mine-safety limits). The FIRMWARE uses the
// same formula (cautionCm()/dangerCm() in MineGuard.ino) so the cab lights
// and the dashboard always agree.
// ---------------------------------------------------------------------------
const T = {
  commTimeoutMs: 5000, // no telemetry for 5 s -> "No data / Disconnected"
  // Zone rule (project spec):  d > 40 cm = SAFE · 15 ≤ d ≤ 40 = CAUTION ·
  //                            d < 15 cm = DANGER
  // Fog (only when intensity > 30) widens the bands: +60/+40 cm at 100%.
  baseCautionCm: 40,
  baseDangerCm: 15,
  fogGatePct: 30, // 0-30% = fog logic OFF, 31-100% = fog logic ON
  eventRateLimitMs: 8000,
};

// Honest text for measurements this rig does NOT have. Never replaced by
// numbers — there is no speed sensor and no positioning sensor.
const SPEED_TEXT = "N/A — No speed sensor";
const TTC_TEXT = "N/A — Speed data unavailable";

// ---------------------------------------------------------------------------
// The single real device (the Arduino on the Bluetooth/USB link)
// ---------------------------------------------------------------------------
const device = {
  id: deviceCfg.id,
  name: deviceCfg.name,
  lastDataAt: null, // timestamp of the last real telemetry packet
  distanceCm: null, // real HC-SR04 reading, null = No data
  imu: null, // true/false as reported by the firmware (null = never reported)
  light: null, // "GREEN" | "YELLOW" | "RED" — reported by the firmware
  buzzer: null, // "SILENT" | "CAUTION" | "DANGER" | ... — reported
  buzzerOn: null, // 1 while the buzzer is sounding this instant
  obstacleReported: null, // the cab's OWN obstacle state (e.g. "SAFE")
  fogActiveReported: null, // the cab's OWN fog-gate state (true/false)
  fogReported: null, // the fog intensity the Arduino confirms it applied
  uptimeSec: null,
  msgCount: 0,
  truckMessage: null, // { text, at, delivered } — delivery confirmed by msgCount
  speed: null, // ALWAYS null: no speed sensor exists
  ttc: null, // ALWAYS null: TTC needs speed + distance; no speed sensor exists
  risk: { level: "NO DATA", score: null, factors: [] },
  // Everything the ultrasonic can yield: current echo + session statistics
  ultra: { minCm: null, maxCm: null, readings: 0, noReadings: 0, history: [] },
  lastEventAt: {},
  prevLinkUp: null,
  prevDanger: false,
};

// Bridge process status (POST /bridge): which port, which link, open/closed
let bridgeInfo = { state: "not-started", port: null, baud: null, link: null, at: null };

let fogIntensity = 0; // 0-100, PC CONTROL value (never a sensor reading)
const fogActive = () => fogIntensity > T.fogGatePct; // fog-dependent logic ON?

// Fog-gated thresholds — integer maths identical to the firmware's
// cautionCm()/dangerCm() (C truncates, so Math.floor matches exactly).
const fogGateValue = () => (fogActive() ? fogIntensity : 0);
const cautionCm = () => T.baseCautionCm + Math.floor((fogGateValue() * 60) / 100);
const dangerCm = () => T.baseDangerCm + Math.floor((fogGateValue() * 40) / 100);

// Link freshness — the ONLY source of "connected/disconnected"
const linkFresh = (now = Date.now()) =>
  device.lastDataAt != null && now - device.lastDataAt <= T.commTimeoutMs;
const dataAgeMs = (now = Date.now()) => (device.lastDataAt == null ? null : now - device.lastDataAt);

function obstacleState(now = Date.now()) {
  if (!linkFresh(now) || device.distanceCm == null) return "NO DATA";
  if (device.distanceCm < dangerCm()) return "DANGER"; // < 15 cm
  if (device.distanceCm <= cautionCm()) return "CAUTION"; // 15..40 cm (fog-widened)
  return "CLEAR"; // > 40 cm
}

// ---------------------------------------------------------------------------
// Risk engine — available real data ONLY
// ---------------------------------------------------------------------------
function computeRisk(now) {
  const factors = [];

  if (!linkFresh(now)) {
    factors.push({
      label: device.lastDataAt
        ? `No data from ${device.id} — last packet ${Math.round((now - device.lastDataAt) / 1000)} s ago`
        : `No data received from ${device.id} (serial bridge silent)`,
      weight: 50,
      tone: "bad",
    });
    factors.push({ label: "Distance unknown — risk cannot be assessed", weight: 0, tone: "warn" });
    factors.push({ label: `Speed ${SPEED_TEXT}`, weight: 0, tone: "warn" });
    return { level: "NO DATA", score: null, factors };
  }

  let score = 0;

  // Real ultrasonic distance vs the fog-gated thresholds.
  // A danger-threshold breach must READ as DANGER (score band ≥ 60), and a
  // caution breach as CAUTION — weights chosen so the level never lies.
  const d = device.distanceCm;
  if (d == null) {
    // Link alive but the sensor gives no reading ("NO READING") — the honest
    // assessment is "cannot assess", never SAFE.
    factors.push({ label: `Live link to ${device.id} (${Math.round(dataAgeMs(now))} ms old)`, weight: 0, tone: "ok" });
    factors.push({
      label: "Distance: sensor reports NO READING — obstacle state cannot be assessed",
      weight: 0,
      tone: "bad",
    });
    if (fogActive()) {
      factors.push({
        label: `Fog-dependent logic ON — intensity ${fogIntensity}% (control value)`,
        weight: 0,
        tone: "warn",
      });
    }
    factors.push({ label: `Speed: ${SPEED_TEXT}`, weight: 0, tone: "warn" });
    factors.push({ label: `TTC: ${TTC_TEXT}`, weight: 0, tone: "warn" });
    return { level: "NO DATA", score: null, factors };
  }
  if (d < dangerCm()) {
    score += 60;
    factors.push({ label: `Obstacle at ${Math.round(d)} cm (danger < ${dangerCm()} cm)`, weight: 60, tone: "bad" });
  } else if (d <= cautionCm()) {
    score += 30;
    factors.push({ label: `Obstacle at ${Math.round(d)} cm (caution band ${dangerCm()}–${cautionCm()} cm)`, weight: 30, tone: "warn" });
  } else {
    factors.push({ label: `Obstacle clear — beam sees ${Math.round(d)} cm (> ${cautionCm()} cm)`, weight: 0, tone: "ok" });
  }

  // Communication (live telemetry stream)
  factors.push({ label: `Live data from ${device.id} (${Math.round(dataAgeMs(now))} ms old)`, weight: 0, tone: "ok" });

  // Fog: a PC CONTROL value (0-100), not a sensor reading. Active only >30%.
  // When the fog control is ≤ 30 %, NO fog line appears at all.
  if (fogActive()) {
    const p = Math.round(13 * (fogIntensity / 100));
    score += p;
    factors.push({ label: `Fog-dependent logic ON — intensity ${fogIntensity}%`, weight: p, tone: "warn" });
  }

  // Measurements this rig cannot make — stated, never invented
  factors.push({ label: `Speed: ${SPEED_TEXT}`, weight: 0, tone: "warn" });
  factors.push({ label: `TTC: ${TTC_TEXT}`, weight: 0, tone: "warn" });

  score = Math.min(100, score);
  const level = score >= 60 ? "DANGER" : score >= 30 ? "CAUTION" : "SAFE";
  return { level, score, factors };
}

// ---------------------------------------------------------------------------
// Events (real observations only) + persistence
// ---------------------------------------------------------------------------
let eventsWriting = false;
let eventsDirty = false;
function persistEvents() {
  if (eventsWriting) {
    eventsDirty = true;
    return;
  }
  eventsWriting = true;
  fs.writeFile(EVENTS_PATH, JSON.stringify(eventLog, null, 2), () => {
    eventsWriting = false;
    if (eventsDirty) {
      eventsDirty = false;
      persistEvents();
    }
  });
}

function raiseEvent(type, severity, message, extra = {}, force = false) {
  const now = Date.now();
  if (!force && device.lastEventAt[type] && now - device.lastEventAt[type] < T.eventRateLimitMs) return null;
  device.lastEventAt[type] = now;

  const ev = {
    id: `EV-${now}-${Math.floor(Math.random() * 1000)}`,
    deviceId: device.id,
    type,
    severity, // info | warning | danger
    message,
    time: new Date(now).toISOString(),
    at: now,
    status: "active", // active | acknowledged | resolved
    ...extra,
  };
  eventLog.unshift(ev);
  eventLog = eventLog.slice(0, 200);
  persistEvents();
  return ev;
}

function tickEvents(now) {
  // Communication transitions (real: telemetry freshness)
  const up = linkFresh(now);
  if (device.prevLinkUp === null) device.prevLinkUp = up;
  else if (!up && device.prevLinkUp) {
    raiseEvent("COMMUNICATION_LOST", "danger",
      `Communication lost with ${device.id} — no data for ${T.commTimeoutMs / 1000} s (Disconnected)`);
  } else if (up && !device.prevLinkUp) {
    raiseEvent("COMMUNICATION_LOST", "info", `Communication restored — receiving live data from ${device.id}`,
      { status: "resolved" });
  }
  device.prevLinkUp = up;

  // Real close-obstacle warning (only while data is flowing)
  if (up && device.distanceCm != null && device.distanceCm < dangerCm()) {
    raiseEvent("OBSTACLE_WARNING", "warning",
      `${device.id} obstacle only ${Math.round(device.distanceCm)} cm away`);
  }

  // Risk escalation to DANGER (from real data only)
  if (device.risk.level === "DANGER" && !device.prevDanger) {
    raiseEvent("DANGER_RISK", "danger",
      `${device.id} risk level escalated to DANGER (real sensor data)`, {}, true);
  }
  device.prevDanger = device.risk.level === "DANGER";
}

// ---------------------------------------------------------------------------
// Real telemetry ingestion (Arduino serial/BT bridge — LOCAL ONLY)
// ---------------------------------------------------------------------------
function applyTelemetry(t) {
  const now = Date.now();

  // ANY packet accepted from the bridge proves the device is alive, so the
  // link timestamp advances even when the sensor itself reports NO READING
  // (a live link and an available distance are two different facts).
  device.lastDataAt = now;

  // Cab acknowledgement of an emergency MSG — the firmware counts every
  // message it receives and echoes the counter; a RISE proves it arrived.
  if (typeof t.msgCount === "number") {
    if (t.msgCount < device.msgCount) {
      device.msgCount = t.msgCount; // device rebooted — new baseline
    } else if (t.msgCount > device.msgCount) {
      device.msgCount = t.msgCount;
      if (device.truckMessage && !device.truckMessage.delivered) {
        device.truckMessage = { ...device.truckMessage, delivered: true, deliveredAt: now };
        raiseEvent("TRUCK_MESSAGE_DELIVERED", "info",
          `Cab acknowledged emergency message: "${device.truckMessage.text}"`, {}, true);
      }
    }
  }

  // The only sensor this rig has: the ultrasonic distance (cm).
  // A number = a real echo. An explicit null ("NO READING" from the cab)
  // CLEARS the value — an old reading must never look current.
  if ("obstacleDistance" in t) {
    const v =
      typeof t.obstacleDistance === "number" && isFinite(t.obstacleDistance) ? t.obstacleDistance : null;
    device.distanceCm = v;
    const u = device.ultra;
    if (v != null) {
      u.readings++;
      u.minCm = u.minCm == null ? v : Math.min(u.minCm, v);
      u.maxCm = u.maxCm == null ? v : Math.max(u.maxCm, v);
      u.history.push(Math.round(v * 10) / 10);
      if (u.history.length > 30) u.history.shift();
    } else {
      u.noReadings++; // a real "NO READING" (echo timeout) — counted, honestly
    }
  }

  // States the firmware genuinely reports about its own hardware.
  // NOTE: the firmware emits imu as 0/1 (number) — accept both forms and
  // normalize to a boolean so a real Arduino's flag always arrives.
  if (t.imu === 0 || t.imu === 1 || typeof t.imu === "boolean") device.imu = t.imu === 1 || t.imu === true;
  if (t.light === "GREEN" || t.light === "YELLOW" || t.light === "RED") device.light = t.light;
  if (typeof t.buzzer === "string") device.buzzer = t.buzzer;
  if (typeof t.buzzerOn === "number") device.buzzerOn = t.buzzerOn;
  if (typeof t.fog === "number") device.fogReported = t.fog; // Arduino's applied fog (ack)
  if (typeof t.uptime === "number") device.uptimeSec = t.uptime;

  // The cab's OWN reported states (text sketch on the rig):
  if (typeof t.obstacleReported === "string" && /^[A-Z ]{1,12}$/.test(t.obstacleReported)) {
    device.obstacleReported = t.obstacleReported;
  }
  if (typeof t.fogActiveReported === "boolean") device.fogActiveReported = t.fogActiveReported;

  // Fields this rig cannot measure are DELIBERATELY ignored: a posted
  // speed/x/y/heading never becomes dashboard data.
  device.speed = null;
  device.ttc = null;
}

// ---------------------------------------------------------------------------
// CSV telemetry recorder — real rows only (schema: real fields)
// ---------------------------------------------------------------------------
const csvPath = path.join(DATA_DIR, "telemetry.csv");
const CSV_HEADER =
  "time,device_id,distance_cm,obstacle_state,link,fog_pct,fog_logic,risk,risk_score,light,buzzer,imu_fitted";
let csvRows = 0;
if (!fs.existsSync(csvPath) || fs.readFileSync(csvPath, "utf8").split("\n")[0] !== CSV_HEADER) {
  if (fs.existsSync(csvPath)) {
    fs.renameSync(csvPath, csvPath.replace(/\.csv$/, `-${Date.now()}.csv`));
  }
  fs.writeFileSync(csvPath, CSV_HEADER + "\n");
}

setInterval(() => {
  const now = Date.now();
  const row = [
    new Date(now).toISOString(),
    device.id,
    device.distanceCm == null ? "" : Math.round(device.distanceCm),
    obstacleState(now),
    linkFresh(now) ? "CONNECTED" : "DISCONNECTED",
    fogIntensity,
    fogActive() ? "ON" : "OFF",
    device.risk.level,
    device.risk.score == null ? "" : device.risk.score,
    device.light ?? "",
    device.buzzer ?? "",
    device.imu == null ? "" : device.imu ? 1 : 0,
  ].join(",");
  try {
    fs.appendFileSync(csvPath, row + "\n");
    csvRows++;
  } catch {}
}, 2000);

// ---------------------------------------------------------------------------
// Read-only share links — /view/<token> streams live data but CANNOT mutate:
// the page renders no controls, and its WS connection refuses every command.
// Also: only this machine (loopback) may open the controllable dashboard or
// post telemetry; any other device gets the view link automatically.
// ---------------------------------------------------------------------------
const SHARE_TOKEN_PATH = path.join(DATA_DIR, "share-token.txt");
let SHARE_TOKEN = "";
try { SHARE_TOKEN = fs.readFileSync(SHARE_TOKEN_PATH, "utf8").trim(); } catch {}
if (!SHARE_TOKEN) {
  SHARE_TOKEN = crypto.randomBytes(9).toString("base64url");
  fs.writeFileSync(SHARE_TOKEN_PATH, SHARE_TOKEN);
}
const isLoopback = (addr) =>
  !addr || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
function lanOrigin() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (!i.internal && i.family === "IPv4") return `http://${i.address}:${PORT}`;
    }
  }
  return `http://localhost:${PORT}`;
}
const viewUrl = () => `${lanOrigin()}/view/${SHARE_TOKEN}`;
// PERMANENT link: machine hostname + the persistent token — survives router
// reboots / DHCP IP changes (resolves via mDNS on the same Wi-Fi).
function permanentUrl() {
  let host = "";
  try { host = os.hostname().toLowerCase(); } catch {}
  return host ? `http://${host}.local:${PORT}/view/${SHARE_TOKEN}` : viewUrl();
}

// ---------------------------------------------------------------------------
// Payload for the dashboard — real fields only
// ---------------------------------------------------------------------------
function bridgePayload() {
  const b = { ...bridgeInfo };
  // The bridge heartbeats every 5 s while open — silence means it died, and
  // a dead bridge must never be shown as "open".
  if (b.state === "open" && b.at && Date.now() - b.at > 15000) b.state = "stale";
  return b;
}

// ---------------------------------------------------------------------------
// AI action advisory — plain-language orders for the truck, generated ONLY
// from real data (link freshness, the real ultrasonic distance, the fog
// control value). When data is missing the advice says STOP — it never
// invents a "proceed" from numbers that do not exist.
// ---------------------------------------------------------------------------
function buildAdvice(now) {
  const fresh = linkFresh(now);
  const d = device.distanceCm;
  const lines = [];
  let tone = "go";
  let headline;

  if (!fresh) {
    tone = "stop";
    headline = `STOP — sensor link to ${device.id} is down`;
    lines.push(
      device.lastDataAt
        ? `No telemetry for ${Math.round((now - device.lastDataAt) / 1000)} s — halt the truck until live data resumes.`
        : "No telemetry has arrived from the truck — do not move on an unmonitored sensor."
    );
  } else if (d == null) {
    tone = "stop";
    headline = "STOP — ultrasonic reports NO READING";
    lines.push("The sensor sees nothing (echo timeout). Halt and check the HC-SR04 wiring/power before proceeding.");
  } else if (d < dangerCm()) {
    tone = "stop";
    headline = `STOP IMMEDIATELY — obstacle at ${Math.round(d)} cm`;
    lines.push(`Object inside the danger zone (< ${dangerCm()} cm): full brake, do not advance until the path is clear.`);
  } else if (d <= cautionCm()) {
    tone = "caution";
    headline = `SLOW DOWN — object at ${Math.round(d)} cm`;
    lines.push(`Object in the caution band (${dangerCm()}–${cautionCm()} cm): creep forward at idle speed, ready to stop.`);
  } else {
    tone = "go";
    headline = `PROCEED — path clear to ${Math.round(d)} cm`;
    lines.push(`No object within ${cautionCm()} cm: normal haulage may continue.`);
  }

  // Fog advice appears ONLY while the fog control is > 30 % (logic ON).
  if (fresh && fogActive()) {
    lines.push(
      `Fog ${fogIntensity}% — fog logic ON: widened margins (caution ≤ ${cautionCm()} cm, danger < ${dangerCm()} cm), keep extra following distance.`
    );
  }
  if (fresh) {
    lines.push(`${SPEED_TEXT} — hold a safe manual speed; speed cannot be monitored.`);
  }
  if (fresh && device.truckMessage && !device.truckMessage.delivered) {
    lines.push(`Emergency message pending cab acknowledgement: "${device.truckMessage.text}"`);
  }
  return { tone, headline, lines, at: now };
}

function buildPayload() {
  const now = Date.now();
  const fresh = linkFresh(now);
  return {
    type: "state",
    at: now,
    fogIntensity, // PC control value 0-100
    fogActive: fogActive(), // true when intensity > 30
    fogGatePct: T.fogGatePct,
    telemetrySamples: csvRows,
    bridge: bridgePayload(),
    thresholds: {
      commTimeoutMs: T.commTimeoutMs,
      obstacleCautionCm: cautionCm(),
      obstacleDangerCm: dangerCm(),
    },
    device: {
      id: device.id,
      name: device.name,
      link: fresh ? "CONNECTED" : "DISCONNECTED",
      linkDetail: fresh
        ? `Receiving live telemetry (${Math.round(dataAgeMs(now))} ms ago)`
        : device.lastDataAt
        ? `No data for ${Math.round((now - device.lastDataAt) / 1000)} s — Disconnected`
        : "No data received — serial bridge has delivered no telemetry",
      lastDataAt: device.lastDataAt,
      dataAgeMs: dataAgeMs(now),
      distanceCm: fresh ? device.distanceCm : null, // stale readings are NOT shown as current
      obstacleState: obstacleState(now),
      // The rig measures no speed -> no speed, no TTC. Explicit text, always.
      speed: null,
      speedText: SPEED_TEXT,
      ttc: null,
      ttcText: TTC_TEXT,
      light: device.light, // real LED colour reported by the firmware (null = not reported)
      buzzer: device.buzzer, // real buzzer/alarm pattern reported (null = not reported)
      buzzerOn: device.buzzerOn,
      obstacleReported: device.obstacleReported, // the cab's own obstacle state (null = not reported)
      fogActiveReported: device.fogActiveReported, // the cab's own fog gate (null = not reported)
      imu: device.imu, // false = IMU not fitted
      fogReported: device.fogReported, // the Arduino's confirmation of the FOG command
      uptimeSec: device.uptimeSec,
      msgCount: device.msgCount,
      truckMessage: device.truckMessage || null,
      risk: device.risk,
      advice: buildAdvice(now), // AI action advisory from real data only
      ultrasonic: {
        // Everything the ultrasonic can yield, real values only
        minCm: device.ultra.minCm,
        maxCm: device.ultra.maxCm,
        readings: device.ultra.readings,
        noReadings: device.ultra.noReadings,
        history: device.ultra.history,
      },
      stateColor:
        device.risk.level === "SAFE" ? "green"
        : device.risk.level === "CAUTION" ? "yellow"
        : device.risk.level === "DANGER" ? "red"
        : "gray",
    },
    events: eventLog.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// WebSocket + HTTP
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(buildPayload()));
  }

  // Real telemetry ingestion (Arduino serial/BT bridge — LOCAL ONLY, so a
  // device holding a share link cannot inject fake sensor data)
  if (req.method === "POST" && req.url === "/telemetry") {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "telemetry is local-only" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const t = JSON.parse(body);
        applyTelemetry(t);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, device: device.id }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // Serial-bridge status (which port / which link / open or closed) — local
  if (req.method === "POST" && req.url === "/bridge") {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "local-only" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const s = JSON.parse(body);
        bridgeInfo = {
          state: s.state || "unknown",
          port: s.port || null,
          baud: s.baud || null,
          link: s.link || null,
          error: s.error || null,
          at: Date.now(),
        };
        broadcast();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // CSV export: full telemetry history (sampled every 2 s)
  if (req.method === "GET" && req.url === "/api/csv") {
    let body = "";
    try {
      body = fs.readFileSync(csvPath, "utf8");
    } catch {}
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mineguard-telemetry.csv"',
    });
    return res.end(body);
  }

  // Share metadata (used by the dashboard's "Share view-only" button)
  if (req.method === "GET" && req.url === "/api/share") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ url: viewUrl(), permanent: permanentUrl(), token: SHARE_TOKEN }));
  }

  // ---- dashboard UI (static build) + read-only share route ----------------
  if (req.method === "GET") {
    const url = (req.url || "/").split("?")[0];
    const distDir = path.join(__dirname, "..", "dashboard", "dist");
    const indexHtml = path.join(distDir, "index.html");
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".map": "application/json",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    };

    if (url === "/view/" + SHARE_TOKEN) {
      try {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(indexHtml));
      } catch {}
      res.writeHead(503, { "Content-Type": "text/plain" });
      return res.end("dashboard not built yet — run: cd dashboard && npm run build");
    }
    if (url.startsWith("/view/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("invalid share link");
    }
    // Any OTHER device opening the root automatically gets the read-only view —
    // the controllable dashboard is for this machine (loopback) only.
    if (url === "/" && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(302, { Location: "/view/" + SHARE_TOKEN });
      return res.end();
    }
    if (url === "/" || url.startsWith("/assets/")) {
      const file = url === "/" ? indexHtml : path.resolve(distDir, "." + url);
      if (file.startsWith(distDir + path.sep)) {
        try {
          const ext = path.extname(file);
          res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
          return res.end(fs.readFileSync(file));
        } catch {}
      }
      res.writeHead(503, { "Content-Type": "text/plain" });
      return res.end("dashboard not built yet — run: cd dashboard && npm run build");
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// WebSocket with path-based access control:
//   ws://…/            -> controller (this machine / loopback only)
//   ws://…/view/<tok>  -> read-only viewer (state streams in, commands refused)
//   any other path or bad token -> socket destroyed
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = (req.url || "/").split("?")[0];
  let viewer = false;
  if (url.startsWith("/view/")) {
    if (url !== "/view/" + SHARE_TOKEN) return socket.destroy();
    viewer = true;
  } else if (url !== "/") {
    return socket.destroy();
  } else if (!isLoopback(req.socket.remoteAddress)) {
    return socket.destroy(); // remote devices must use the read-only link
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isViewer = viewer;
    wss.emit("connection", ws, req);
  });
});

function broadcast() {
  const msg = JSON.stringify(buildPayload());
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(buildPayload()));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Read-only share links: state streams IN, every command is refused.
    if (ws.isViewer) {
      ws.send(JSON.stringify({ type: "denied", of: msg.type }));
      return;
    }

    // Fog intensity: a PC CONTROL value 0-100. Gate (0-30 OFF / 31-100 ON)
    // is derived, never uploaded as a "reading".
    if (msg.type === "setFogIntensity") {
      const prevActive = fogActive();
      fogIntensity = Math.max(0, Math.min(100, Math.round(Number(msg.value) || 0)));
      if (fogActive() !== prevActive) {
        raiseEvent(
          fogActive() ? "FOG_MODE_ENABLED" : "FOG_MODE_DISABLED",
          "warning",
          fogActive()
            ? `Fog-dependent logic ON — intensity ${fogIntensity}% (> ${T.fogGatePct}%), warning margins widened`
            : `Fog-dependent logic OFF — intensity ${fogIntensity}% (≤ ${T.fogGatePct}%), base margins restored`,
          { status: "resolved", fogIntensity },
          true
        );
      }
      broadcast();
    }

    // Emergency message from the control room -> the cab.
    // The bridge pushes "MSG <text>" over USB/Bluetooth; the firmware answers
    // with a rising msgCount in its telemetry (that is the delivery receipt).
    // Empty text dismisses the current message.
    if (msg.type === "truckMessage") {
      const text = String(msg.text || "").trim().slice(0, 80);
      if (text) {
        device.truckMessage = { text, at: Date.now(), delivered: false };
        raiseEvent("TRUCK_MESSAGE", "warning",
          `${device.id} ← EMERGENCY MESSAGE: "${text}"`, { message: text }, true);
        // NOTE: no simulated acknowledgement exists — "delivered" appears
        // only when the real Arduino's msgCount rises.
      } else if (device.truckMessage) {
        device.truckMessage = null;
        raiseEvent("TRUCK_MESSAGE_CLEARED", "info", `Message to ${device.id} dismissed`, {}, true);
      }
      broadcast();
    }

    if (msg.type === "ack" && msg.eventId) {
      const ev = eventLog.find((e) => e.id === msg.eventId);
      if (ev && ev.status === "active") {
        ev.status = "acknowledged";
        ev.acknowledgedAt = Date.now();
        persistEvents();
      }
      broadcast();
    }

    // Intentionally refused / ignored message types (they only ever existed
    // for the simulator and there is nothing behind them any more):
    //   sim | addObstacle | moveObstacle | clearEStop | setFog | pause...
  });
});

// Main loop — no simulator runs here; this only refreshes link state, the
// real-data risk engine, real events, and broadcasts.
setInterval(() => {
  const now = Date.now();
  device.risk = computeRisk(now);
  tickEvents(now);
  broadcast();
}, 500);

server.listen(PORT, () => {
  console.log(`MineGuard server running on http://localhost:${PORT}`);
  console.log(`WebSocket ws://localhost:${PORT}`);
  console.log(`Dashboard served from dashboard/dist (single-port mode)`);
  console.log(`Data source: REAL Arduino telemetry via the serial bridge (no simulator)`);
  console.log(`Speed: "${SPEED_TEXT}" | TTC: "${TTC_TEXT}"`);
  console.log(`PERMANENT read-only share link: ${permanentUrl()}`);
  console.log(`IP fallback (changes on router reboot): ${viewUrl()}`);
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, "..", "SHARE-LINK.txt"),
      `MineGuard - PERMANENT read-only share link (open while on the SAME Wi-Fi):\n` +
        `${permanentUrl()}\n\n` +
        `Fallback link (this PC's IP - changes on router reboot):\n${viewUrl()}\n`
    );
    console.log(`Share link saved to SHARE-LINK.txt`);
  } catch {}
});
