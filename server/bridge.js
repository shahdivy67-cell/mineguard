/**
 * MineGuard Serial Bridge — REAL hardware link (no simulation anywhere).
 *
 * ARDUINO -> SERVER : reads newline JSON telemetry from the COM port and
 *                     forwards it verbatim (POST /telemetry) — 2 Hz, real
 *                     ultrasonic distance + obstacle state + LED/buzzer
 *                     state reported by the firmware.
 * SERVER  -> ARDUINO: pushes text commands to the cab:
 *                       FOG <0-100>   fog intensity from the PC control
 *                                     (0-30 = fog-dependent logic OFF,
 *                                      31-100 = fog-dependent logic ON —
 *                                      the firmware owns that gate)
 *                       MSG <text>    EMERGENCY message from the operator —
 *                                     msgCount in telemetry is the receipt.
 *
 * WHAT THIS BRIDGE NEVER DOES:
 *   - it never invents speed (the Arduino has no speed sensor, so no speed
 *     field is sent at all — the dashboard shows "N/A — No speed sensor")
 *   - it never invents position (no positioning sensor — no x/y/heading)
 *   - it never fabricates sensor values; if the port is silent, the server
 *     simply sees "No data / Disconnected"
 *
 * Usage:
 *   node bridge.js                # auto-detect (Bluetooth port preferred)
 *   node bridge.js COM5           # a specific port (USB … or Bluetooth)
 *   COM=COM5 node bridge.js       # via environment variable
 *
 * Port / baud rules:
 *   - A paired HC-05 shows up in Windows as "Standard Serial over Bluetooth
 *     link (COMn)" and opens at 9600 (HC-05 factory baud).
 *   - USB serial (Arduino onboard / FTDI adapter) opens at 57600 (firmware).
 *
 * Arduino line formats accepted (see parseTelemetryLine):
 *   (A) JSON — arduino/MineGuard.ino V2 firmware:
 *       {"vehicleId":"MG-01","obstacleDistance":73,"imu":0,"light":"GREEN",
 *        "buzzer":"SILENT","buzzerOn":0,"fog":0,"msgCount":0,"uptime":12}
 *   (B) TEXT — the sketch currently flashed on the rig's Nano:
 *       MineGuard Arduino Nano Ready
 *       Distance: 144.7 cm | Fog: 0% | Fog Active: NO | Obstacle: SAFE
 *       Distance: NO READING
 *   Anything else (wrong baud chatter, foreign devices) is dropped.
 *
 * Baud: auto-sniffed — 9600 first (rig sketch / HC-05), then 57600 (JSON fw).
 *
 * Expected from the laptop (this bridge): FOG <0-100> | MSG <text>
 */

const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const SERVER = process.env.SERVER || "http://localhost:4000";
const VEHICLE = process.env.VEHICLE || "MG-01";
const PID_PATH = path.join(__dirname, "bridge.pid");

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

// ---------------------------------------------------------------------------
// Telemetry line parsing — exported so the test suite can verify the exact
// contract against real firmware lines (no hardware needed for THAT test).
// Accepts BOTH known MineGuard dialects:
//   (A) JSON lines (MineGuard.ino V2 firmware):
//         {"vehicleId":"MG-01","obstacleDistance":73,...}
//   (B) TEXT lines (the sketch currently flashed on the rig's Nano):
//         "MineGuard Arduino Nano Ready"          (boot banner)
//         "Distance: 144.7 cm | Fog: 0% | Fog Active: NO | Obstacle: SAFE"
//         "Distance: NO READING"                  (sensor gave no echo)
// Returns null for anything that is not MineGuard telemetry — chatter from a
// wrong baud rate or a foreign device is silently dropped, never invented.
// ---------------------------------------------------------------------------

// Dialect B: human-readable lines from the rig's current Nano sketch
function parseTextLine(line, id) {
  if (/^MineGuard/i.test(line)) return { boot: line }; // boot banner
  const m = line.match(/^Distance:\s*(.*)$/i);
  if (!m) return null;
  const rest = m[1];
  const out = { vehicleId: id };
  const dm = rest.match(/^([0-9]+(?:\.[0-9]+)?)\s*cm/i);
  if (dm) {
    out.obstacleDistance = parseFloat(dm[1]);
  } else if (/NO\s+READING/i.test(rest)) {
    out.obstacleDistance = null; // explicitly: the sensor sees nothing
  } else {
    return null; // a "Distance:" line we cannot interpret — do not guess
  }
  const fm = rest.match(/Fog:\s*(\d+)\s*%/i);
  if (fm) out.fog = parseInt(fm[1], 10);
  const fa = rest.match(/Fog\s+Active:\s*(YES|NO)/i);
  if (fa) out.fogActiveReported = fa[1].toUpperCase() === "YES";
  const ob = rest.match(/Obstacle:\s*([A-Za-z ]+)/);
  if (ob) out.obstacleReported = ob[1].trim().toUpperCase();
  // Optional hardware fields — parsed if the sketch sends them (the current
  // text sketch omits them; MineGuard.ino reports them in JSON instead).
  const led = rest.match(/LED:\s*(GREEN|YELLOW|RED)/i);
  if (led) out.light = led[1].toUpperCase();
  const bz = rest.match(/Buzzer:\s*(ON|OFF)/i);
  if (bz) {
    const on = bz[1].toUpperCase() === "ON";
    out.buzzerOn = on ? 1 : 0;
    out.buzzer = on ? "SOUNDING" : "SILENT";
  }
  return out;
}

function parseTelemetryLine(raw, fallbackId = VEHICLE) {
  const line = String(raw).trim();
  if (!line) return null;

  // Dialect B first (the text sketch needs no braces)
  if (!line.startsWith("{")) return parseTextLine(line, fallbackId);

  // Dialect A: JSON firmware
  let t;
  try {
    t = JSON.parse(line);
  } catch {
    return null;
  }
  if (t.boot) return { boot: t.boot };
  if (typeof t.obstacleDistance !== "number") return null; // not our firmware
  const out = {
    vehicleId: t.vehicleId || fallbackId,
    obstacleDistance: t.obstacleDistance,
    imu: t.imu,
    light: t.light,
    buzzer: t.buzzer,
    buzzerOn: t.buzzerOn,
    fog: t.fog,
    msgCount: t.msgCount,
    uptime: t.uptime,
  };
  // Tilt/accel are only real when an IMU actually answered (imu:1) —
  // with no IMU fitted the firmware reports imu:0 and we pass nothing.
  if (t.imu === 1) {
    if (typeof t.tilt === "number") out.tilt = t.tilt;
    if (typeof t.accel === "number") out.accel = t.accel;
  }
  // NOTE: no speed field ever — there is no speed sensor on this rig.
  // NOTE: no x/y/heading ever — there is no positioning sensor on this rig.
  return out;
}

async function forward(payload) {
  try {
    const res = await fetch(`${SERVER}/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log("server rejected telemetry:", res.status);
  } catch (e) {
    log("server unreachable:", e.message);
  }
}

// Tell the server whether the serial link itself is open/closed (so the
// dashboard can show the real Bluetooth/USB connection status).
async function reportBridgeStatus(status) {
  try {
    await fetch(`${SERVER}/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(status),
    });
  } catch {}
}

async function pickPort(explicit) {
  const ports = await SerialPort.list();
  const isBT = (p) => /BTH|Bluetooth/i.test(JSON.stringify(p));
  let found;
  if (explicit) {
    // Look the given COM name up so we still learn whether it's Bluetooth
    found = ports.find((p) => p.path.toUpperCase() === explicit.toUpperCase()) || { path: explicit };
  } else {
    // This rig runs over the HC-05 Bluetooth link: prefer a Bluetooth COM
    // port, then USB/serial adapters, then anything at all.
    found =
      ports.find(isBT) ||
      ports.find((p) => /USB|CH340|CP210|FTDI|Arduino/i.test(p.path + (p.manufacturer || ""))) ||
      ports[0];
  }
  if (!found) return null;
  // HC-05 factory baud is 9600; the firmware's USB link runs 57600
  return { path: found.path, bluetooth: isBT(found) };
}

// ---------------------------------------------------------------------------
// Auto-baud sniff: try 9600 first (the rig's text sketch / HC-05 factory
// baud), then 57600 (MineGuard.ino JSON). Returns { port, baud, first } with
// the WINNING port left open, or null if both bauds stay silent. Opening an
// Arduino toggles DTR (board resets and prints its banner) — the window is
// long enough for boot + the first telemetry line.
// ---------------------------------------------------------------------------
const SNIFF_BAUDS = [9600, 57600];
function sniffOpen(portPath, timeoutMs = 4000) {
  const attempt = (baud) =>
    new Promise((resolve) => {
      let port = null;
      let parser = null;
      let timer = null;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result) return resolve({ port, baud, first: result });
        let done = false;
        const bye = () => {
          if (!done) {
            done = true;
            resolve(null);
          }
        };
        try {
          parser && parser.removeAllListeners();
        } catch {}
        try {
          port.close(bye);
          setTimeout(bye, 300); // safety: close() callback may never fire
        } catch {
          bye();
        }
      };
      try {
        port = new SerialPort({ path: portPath, baudRate: baud, autoOpen: true });
      } catch {
        return resolve(null);
      }
      parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (raw) => {
        const p = parseTelemetryLine(raw);
        if (p) finish(p);
      });
      port.on("error", () => finish(null));
      timer = setTimeout(() => finish(null), timeoutMs);
    });

  return (async () => {
    for (const baud of SNIFF_BAUDS) {
      const r = await attempt(baud);
      if (r) {
        log(`sniffed ${portPath} at ${baud} baud`);
        return r;
      }
    }
    return null;
  })();
}

// The serial port the bridge is currently streaming on (null when scanning);
// outbound FOG/MSG commands go through whatever link is open right now.
let currentPort = null;

async function main() {
  const explicit = process.argv[2] || process.env.COM;

  // Single-instance guard: two bridges on one COM port would corrupt the link
  try {
    const oldPid = parseInt(fs.readFileSync(PID_PATH, "utf8"), 10);
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, 0); // throws if that process is gone
      log(`serial bridge already running (pid ${oldPid}) — exiting.`);
      log(`(if that is stale, delete ${PID_PATH})`);
      return;
    }
  } catch {}
  try {
    fs.writeFileSync(PID_PATH, String(process.pid));
  } catch {}
  process.on("exit", () => {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
  });

  // Serial link: connect, and whenever the link dies (USB unplug/adapter
  // reset) re-run the whole port+baud scan instead of exiting — a hardware
  // glitch must not kill the bridge for the rest of the session.
  connectControlRoom();
  for (;;) {
    await openSerial(explicit);
    log("serial link lost — re-scanning for the Arduino in 3 s (bridge stays alive)…");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// One serial connection: scan ports, sniff the baud, stream telemetry.
// Resolves when the port closes or errors, so main() can re-scan and retry.
// ---------------------------------------------------------------------------
async function openSerial(explicit) {
  return new Promise(async (resolve) => {
  // Re-scan until a port appears: plugging the Arduino in later "just works".
  let pick = await pickPort(explicit);
  while (!pick) {
    log("no serial port yet — waiting for the Arduino/HC-05 to appear (retrying in 3 s)…");
    await new Promise((r) => setTimeout(r, 3000));
    pick = await pickPort(explicit);
  }
  let portPath = pick.path;
  const bluetooth = pick.bluetooth;
  const linkName = bluetooth ? "Bluetooth" : "USB";

  // Auto-baud sniff: the rig's Nano speaks 9600 (text sketch / HC-05 factory
  // baud), MineGuard.ino V2 would speak 57600 (JSON). Sniff 9600 first, then
  // 57600 — the first port/baud pair that yields a valid MineGuard line wins
  // and stays open. If the port is silent/wedged, retry the whole cycle.
  reportBridgeStatus({ state: "scanning", port: portPath, baud: null, link: linkName });
  let opened = await sniffOpen(portPath);
  while (!opened) {
    log(`no MineGuard telemetry on ${portPath} at 9600/57600 — is the Arduino powered/flashed? (retry in 3 s)`);
    await new Promise((r) => setTimeout(r, 3000));
    pick = await pickPort(explicit);
    if (!pick) continue;
    portPath = pick.path;
    reportBridgeStatus({ state: "scanning", port: portPath, baud: null, link: linkName });
    opened = await sniffOpen(portPath);
  }
  const { port, baud: baudRate } = opened;
  currentPort = port;
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  // The sniff consumed the winning line — deliver it too (unless it was the
  // boot banner, which is logged below as soon as the handler sees it).
  if (opened.first) {
    if (opened.first.boot) log("Arduino says:", opened.first.boot);
    else forward(opened.first);
  }
  port.on("open", () => {
    log(`bridge open on ${portPath} @${baudRate} (${linkName}) -> ${SERVER}`);
    reportBridgeStatus({ state: "open", port: portPath, baud: baudRate, link: linkName });
  });
  // Heartbeat: the server marks the bridge "stale" if these stop arriving,
  // so the dashboard never shows a dead bridge as open.
  const hb = setInterval(() => {
    reportBridgeStatus({ state: "open", port: portPath, baud: baudRate, link: linkName });
  }, 5000);

  // The link ending (USB yanked, adapter reset, serial error) resolves this
  // connection so main() can scan and reconnect — the bridge NEVER exits
  // just because the cable blinked.
  let ended = false;
  const end = (why, state) => {
    if (ended) return;
    ended = true;
    clearInterval(hb);
    try { port.close(); } catch {}
    currentPort = null;
    log(why);
    reportBridgeStatus({ state, port: portPath, baud: baudRate, link: linkName });
    resolve();
  };
  port.on("error", (e) => end(`serial error: ${e.message} — link lost`, "error"));
  port.on("close", () => end("serial port closed — link lost, reconnecting", "closed"));

  let lines = 0;
  parser.on("data", (raw) => {
    const parsed = parseTelemetryLine(raw);
    if (!parsed) return; // ignore anything that is not our firmware's JSON
    if (parsed.boot) {
      log("Arduino says:", parsed.boot);
      return;
    }
    lines++;
    forward(parsed);
    if (lines % 10 === 0) {
      log(
        `line ${lines}: distance=${parsed.obstacleDistance == null ? "NO READING" : parsed.obstacleDistance + " cm"}` +
          ` fog=${parsed.fog != null ? parsed.fog + "%" : "-"}` +
          (parsed.obstacleReported ? ` cab=${parsed.obstacleReported}` : "") +
          (parsed.light ? ` light=${parsed.light} buzzer=${parsed.buzzer}` : "")
      );
    }
  });

    log("waiting for Arduino telemetry…");
  });
}

// --- outbound: control-room state -> Arduino commands (over the open link) --
let lastSent = { fog: null, msgAt: 0 };
function sendCmd(line) {
  if (currentPort && currentPort.isOpen) {
    currentPort.write(line + "\n");
    log(`-> Arduino: ${line}`);
  }
}

function connectControlRoom() {
  const wsUrl = SERVER.replace(/^http/, "ws");
  const ws = new WebSocket(wsUrl);
  ws.on("open", () => {
    log(`control-room link ${wsUrl} — fog / emergency messages now reach the cab`);
    lastSent = { fog: null, msgAt: 0 }; // resend the fog state on (re)connect
  });
  ws.on("message", (raw) => {
    try {
      const s = JSON.parse(raw);
      if (s.type !== "state") return;

      // Fog intensity is a PC control value 0-100 (never a sensor reading).
      const fog = Math.max(0, Math.min(100, Math.round(Number(s.fogIntensity) || 0)));
      if (fog !== lastSent.fog) {
        lastSent.fog = fog;
        sendCmd(`FOG ${fog}`);
      }

      // Emergency message: send each NEW one once (re-sent on reconnect
      // until the cab's msgCount proves it was delivered)
      const tm = s.device?.truckMessage;
      if (tm && !tm.delivered && tm.at !== lastSent.msgAt) {
        lastSent.msgAt = tm.at;
        sendCmd(`MSG ${tm.text}`);
      }
    } catch {
      /* ignore malformed frames */
    }
  });
  ws.on("close", () => setTimeout(connectControlRoom, 2000));
  ws.on("error", () => ws.close());
}

if (require.main === module) {
  main().catch((e) => {
    console.error("bridge error:", e.message);
    process.exit(1);
  });
}

module.exports = { parseTelemetryLine };
