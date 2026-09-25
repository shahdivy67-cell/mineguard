/**
 * MineGuard REAL-DATA suite — proves the application NEVER fabricates
 * measurements and ingests ONLY what the Arduino reports.
 *
 *   node realcheck.js        (server up on :4000,
 *                             serial bridge STOPPED so link state is
 *                             deterministic: No data / Disconnected)
 *
 * Covers:
 *   1. payload carries ONLY real-data fields (sim-era fields are gone)
 *   2. speed & TTC are always null + the exact N/A text (never numbers)
 *   3. the single data path: POST /telemetry (loopback-only)
 *   4. bogus speed/x/y/heading/ttc posted by anyone are IGNORED
 *   5. obstacle state + risk derive from the real distance + fog gate only
 *   6. stale stream -> Disconnected, distance NOT shown as current data
 *   7. bridge parser refuses non-MineGuard lines, never forwards speed
 *   8. emergency-message receipt happens only via rising msgCount
 *   9. data files (events.json, telemetry.csv) stay valid
 */
const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

const BASE = "http://localhost:4000";

let pass = 0,
  fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b || "null") }));
      })
      .on("error", reject);
  });
}

function post(url, obj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  const state = async () => (await get(`${BASE}/api/state`)).body;

  // -------------------------------------------------------------------------
  // 1. fresh boot with the bridge stopped: honest "no data" baseline
  // -------------------------------------------------------------------------
  let s = await state();
  let d = s.device;
  check("payload has a device node", !!(s && s.device), "");
  check(
    "sim-era payload fields are GONE (vehicles/world/roads/zones/aiStatus/obstacles/sim)",
    s &&
      !("vehicles" in s) &&
      !("world" in s) &&
      !("roads" in s) &&
      !("zones" in s) &&
      !("aiStatus" in s) &&
      !("obstacles" in s) &&
      !("sim" in s),
    s ? `keys=${Object.keys(s).join(",")}` : "no payload"
  );
  check(
    "device has NO position/movement/sim fields (x/y/heading/source/trail/cabAlert/eStop/blockedBy/safety)",
    d &&
      !("x" in d) &&
      !("y" in d) &&
      !("heading" in d) &&
      !("source" in d) &&
      !("trail" in d) &&
      !("cabAlert" in d) &&
      !("eStop" in d) &&
      !("blockedBy" in d) &&
      !("safety" in d),
    ""
  );
  check(
    "speed is null + exact text 'N/A — No speed sensor'",
    d && d.speed === null && d.speedText === "N/A — No speed sensor",
    `speed=${JSON.stringify(d.speed)} text=${JSON.stringify(d.speedText)}`
  );
  check(
    "TTC is null + exact text 'N/A — Speed data unavailable'",
    d && d.ttc === null && d.ttcText === "N/A — Speed data unavailable",
    `ttc=${JSON.stringify(d.ttc)} text=${JSON.stringify(d.ttcText)}`
  );
  check(
    "no bridge -> link DISCONNECTED + distance NOT reported",
    d && d.link === "DISCONNECTED" && d.distanceCm === null && d.obstacleState === "NO DATA",
    `link=${d && d.link} distance=${d && d.distanceCm} obstacle=${d && d.obstacleState}`
  );
  check(
    "no data -> risk level 'NO DATA' with null score (nothing invented)",
    d && d.risk && d.risk.level === "NO DATA" && d.risk.score === null,
    d && `level=${d.risk.level} score=${d.risk.score}`
  );
  check(
    "speed/ttc are null even with no data (never a placeholder number)",
    d && d.speed === null && d.ttc === null,
    ""
  );
  check(
    "AI advisory with no data says STOP (never invents 'proceed')",
    d && d.advice && d.advice.tone === "stop" && d.advice.headline.includes("STOP"),
    d && `tone=${d.advice && d.advice.tone} headline=${d.advice && d.advice.headline}`
  );

  // -------------------------------------------------------------------------
  // 2. ingest: the single real-data path, and the refusal of impossible data
  // -------------------------------------------------------------------------
  const post1 = await post(`${BASE}/telemetry`, {
    vehicleId: "MG-01",
    obstacleDistance: 400, // beam clear
    imu: 0, // no MPU6050 fitted on this rig
    light: "GREEN", // reported LED state
    buzzer: "SILENT",
    buzzerOn: 0,
    fog: 0, // Arduino's applied fog (ack of the FOG command)
    msgCount: 0,
    uptime: 42,
    // Fields this rig CANNOT measure — a malicious/buggy sender may include
    // them; the server must ignore every one:
    speed: 9.9,
    ttc: 3,
    x: 50,
    y: 60,
    heading: 90,
    tilt: 5,
    accel: 1.1,
  });
  check("POST /telemetry accepted (loopback)", post1.status === 200, `status=${post1.status}`);
  await sleep(650);
  s = await state();
  d = s.device;
  check(
    "real distance ingested: 400 cm, link CONNECTED, state CLEAR",
    d.link === "CONNECTED" && d.distanceCm === 400 && d.obstacleState === "CLEAR",
    `link=${d.link} dist=${d.distanceCm} state=${d.obstacleState}`
  );
  check(
    "AI advisory: PROCEED with clear beam (real 400 cm)",
    d.advice && d.advice.tone === "go" && d.advice.headline.includes("PROCEED") && d.advice.headline.includes("400 cm"),
    d.advice && d.advice.headline
  );
  check(
    "reported hardware states arrive: light GREEN, buzzer SILENT, imu false",
    d.light === "GREEN" && d.buzzer === "SILENT" && d.buzzerOn === 0 && d.imu === false,
    `light=${d.light} buzzer=${d.buzzer} imu=${d.imu}`
  );
  check(
    "bogus speed/ttc IGNORED (still null + N/A text)",
    d.speed === null && d.speedText === "N/A — No speed sensor" && d.ttc === null && d.ttcText === "N/A — Speed data unavailable",
    `speed=${JSON.stringify(d.speed)} ttc=${JSON.stringify(d.ttc)}`
  );
  check(
    "bogus position IGNORED (no x/y/heading anywhere on the device)",
    !("x" in d) && !("y" in d) && !("heading" in d),
    ""
  );
  check("last real data timestamp present", typeof d.lastDataAt === "number", `lastDataAt=${d.lastDataAt}`);
  check("risk with clear beam = SAFE (score 0)", d.risk.level === "SAFE" && d.risk.score === 0, `level=${d.risk.level} score=${d.risk.score}`);
  check(
    "risk factors state the N/A facts (no speed, no TTC)",
    d.risk.factors.some((f) => f.label.includes("No speed sensor")) &&
      d.risk.factors.some((f) => f.label.includes("Speed data unavailable")),
    ""
  );

  // -------------------------------------------------------------------------
  // 3. risk from the real distance only (fog at 0: caution 40 / danger 15)
  //    zone rule: d > 40 SAFE · 15 ≤ d ≤ 40 CAUTION · d < 15 DANGER
  // -------------------------------------------------------------------------
  await post(`${BASE}/telemetry`, { vehicleId: "MG-01", obstacleDistance: 10, msgCount: 0 });
  await sleep(650);
  s = await state();
  d = s.device;
  check(
    "10 cm -> obstacle DANGER + risk DANGER (score 60)",
    d.obstacleState === "DANGER" && d.risk.level === "DANGER" && d.risk.score >= 60,
    `state=${d.obstacleState} level=${d.risk.level} score=${d.risk.score}`
  );
  check(
    "AI advisory orders an immediate STOP at 10 cm",
    d.advice && d.advice.tone === "stop" && d.advice.headline.includes("10 cm"),
    d.advice && d.advice.headline
  );
  await sleep(500);
  check(
    "real OBSTACLE_WARNING event raised for the close object",
    (s.events || []).some((e) => e.type === "OBSTACLE_WARNING" && e.message.includes("10 cm")),
    `events=${(s.events || []).map((e) => e.type).join(",")}`
  );

  await post(`${BASE}/telemetry`, { vehicleId: "MG-01", obstacleDistance: 30, msgCount: 0 });
  await sleep(650);
  s = await state();
  d = s.device;
  check(
    "30 cm (15–40 band) -> obstacle CAUTION + risk CAUTION (score 30)",
    d.obstacleState === "CAUTION" && d.risk.level === "CAUTION" && d.risk.score >= 30 && d.risk.score < 60,
    `state=${d.obstacleState} level=${d.risk.level} score=${d.risk.score}`
  );

  // Ultrasonic statistics — everything the sensor can yield, real values only
  check(
    "ultrasonic session stats accumulate real echoes",
    d.ultrasonic && d.ultrasonic.readings >= 3 && d.ultrasonic.minCm != null && d.ultrasonic.maxCm != null &&
      Array.isArray(d.ultrasonic.history) && d.ultrasonic.history.length >= 3,
    d.ultrasonic && `readings=${d.ultrasonic.readings} min=${d.ultrasonic.minCm} max=${d.ultrasonic.maxCm} hist=${d.ultrasonic.history.length}`
  );

  // -------------------------------------------------------------------------
  // 4. emergency message: receipt ONLY from a rising msgCount
  // -------------------------------------------------------------------------
  const ws = new WebSocket("ws://localhost:4000");
  let mState = null;
  ws.on("message", (buf) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m.type === "state") mState = m;
    } catch {}
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "truckMessage", vehicleId: "MG-01", text: "EVACUATE to refuge chamber now" }));
  await sleep(700);
  check(
    "message queued as NOT delivered (no fake receipt exists)",
    mState && mState.device.truckMessage && mState.device.truckMessage.delivered === false,
    mState && `delivered=${mState.device.truckMessage && mState.device.truckMessage.delivered}`
  );
  // The cab answers with a higher msgCount in its next real packet:
  await post(`${BASE}/telemetry`, { vehicleId: "MG-01", obstacleDistance: 70, msgCount: 1 });
  await sleep(700);
  check(
    "rising msgCount -> delivered receipt (real acknowledgement path)",
    mState && mState.device.truckMessage && mState.device.truckMessage.delivered === true,
    mState && `delivered=${mState.device.truckMessage && mState.device.truckMessage.delivered}`
  );
  ws.send(JSON.stringify({ type: "truckMessage", vehicleId: "MG-01", text: " " })); // empty -> clear
  await sleep(600);
  check("message cleared", mState && mState.device.truckMessage === null, "");

  // -------------------------------------------------------------------------
  // 4b. the rig's real "NO READING" state: link alive, distance honestly null
  // -------------------------------------------------------------------------
  await post(`${BASE}/telemetry`, {
    vehicleId: "MG-01",
    obstacleDistance: null, // what the rig prints when the sensor gets no echo
    obstacleReported: "SAFE",
    fog: 0,
    fogActiveReported: false,
  });
  await sleep(650);
  s = await state();
  d = s.device;
  check("NO READING packet keeps link CONNECTED (device is alive)", d.link === "CONNECTED", `link=${d.link}`);
  check("NO READING clears the distance (no stale number shown)", d.distanceCm === null, `distance=${d.distanceCm}`);
  check(
    "NO READING -> obstacle NO DATA + risk NO DATA (never SAFE)",
    d.obstacleState === "NO DATA" && d.risk.level === "NO DATA" && d.risk.score === null,
    `state=${d.obstacleState} level=${d.risk.level} score=${d.risk.score}`
  );
  check(
    "risk factors explain the NO READING condition",
    d.risk.factors.some((f) => f.label.includes("NO READING")),
    ""
  );
  check(
    "AI advisory: STOP — ultrasonic reports NO READING",
    d.advice && d.advice.tone === "stop" && d.advice.headline.includes("NO READING"),
    d.advice && d.advice.headline
  );
  check(
    "ultrasonic NO READING counted honestly",
    d.ultrasonic && d.ultrasonic.noReadings >= 1,
    d.ultrasonic && `noReadings=${d.ultrasonic.noReadings}`
  );
  check(
    "cab-reported states arrive (obstacle SAFE, its own fog gate)",
    d.obstacleReported === "SAFE" && d.fogActiveReported === false,
    `obstacleReported=${d.obstacleReported} fogActiveReported=${d.fogActiveReported}`
  );

  // -------------------------------------------------------------------------
  // 5. stale stream -> Disconnected, distance no longer presented as current
  // -------------------------------------------------------------------------
  // (bridge must be stopped: nothing posts during this window)
  const waitMs = s.thresholds.commTimeoutMs + 700;
  console.log(`  ....  waiting ${(waitMs / 1000).toFixed(1)} s for the link to go stale`);
  await sleep(waitMs);
  s = await state();
  d = s.device;
  check(
    "stale stream -> DISCONNECTED",
    d.link === "DISCONNECTED",
    `link=${d.link} age=${d.dataAgeMs}`
  );
  check(
    "stale distance NOT shown as current (null, state NO DATA)",
    d.distanceCm === null && d.obstacleState === "NO DATA",
    `distance=${d.distanceCm} state=${d.obstacleState}`
  );
  check("stale -> risk NO DATA with null score", d.risk.level === "NO DATA" && d.risk.score === null, `level=${d.risk.level}`);
  check(
    "COMMUNICATION_LOST event raised (real freshness transition)",
    (s.events || []).some((e) => e.type === "COMMUNICATION_LOST" && e.severity === "danger"),
    `events=${(s.events || []).map((e) => e.type).join(",")}`
  );
  check("stale -> speed/TTC still the honest N/A text", d.speedText === "N/A — No speed sensor" && d.ttcText === "N/A — Speed data unavailable", "");

  // -------------------------------------------------------------------------
  // 6. bridge parser contract (unit level, no hardware needed)
  // -------------------------------------------------------------------------
  const { parseTelemetryLine } = require("./bridge.js");
  const good = parseTelemetryLine(
    '{"vehicleId":"MG-01","obstacleDistance":73,"tilt":4.0,"accel":1.02,"crash":0,"eStop":0,"ai":0,"fog":0,"imu":1,"light":"GREEN","buzzer":"CAUTION","buzzerOn":1,"msgCount":2,"uptime":12}'
  );
  check(
    "parser accepts a real firmware line (distance + light + buzzer)",
    good && good.obstacleDistance === 73 && good.light === "GREEN" && good.buzzer === "CAUTION" && good.msgCount === 2,
    JSON.stringify(good)
  );
  check(
    "parser NEVER forwards speed/x/y/heading (even if a line contains them)",
    good && !("speed" in good) && !("x" in good) && !("y" in good) && !("heading" in good),
    ""
  );
  const withSpeed = parseTelemetryLine('{"vehicleId":"MG-01","obstacleDistance":10,"speed":9.9,"x":1,"y":2,"heading":3}');
  check(
    "speed injected into a line is dropped by the parser",
    withSpeed && withSpeed.obstacleDistance === 10 && !("speed" in withSpeed) && !("x" in withSpeed),
    JSON.stringify(withSpeed)
  );
  const noImu = parseTelemetryLine('{"vehicleId":"MG-01","obstacleDistance":200,"imu":0,"tilt":9,"accel":9,"light":"GREEN","buzzer":"SILENT","buzzerOn":0,"fog":0,"msgCount":0,"uptime":1}');
  check(
    "imu:0 -> tilt/accel not forwarded (no IMU means no tilt data)",
    noImu && !("tilt" in noImu) && !("accel" in noImu),
    JSON.stringify(noImu)
  );
  check("parser rejects non-JSON chatter", parseTelemetryLine("hello world") === null, "");
  check("parser rejects JSON without obstacleDistance", parseTelemetryLine('{"foo":1}') === null, "");
  // Dialect B — the sketch currently flashed on the rig (REAL format, from
  // the live COM3 session):
  const textFull = parseTelemetryLine("Distance: 144.7 cm | Fog: 0% | Fog Active: NO | Obstacle: SAFE");
  check(
    "parser accepts the rig's TEXT line (distance/fog/obstacle)",
    textFull &&
      textFull.obstacleDistance === 144.7 &&
      textFull.fog === 0 &&
      textFull.fogActiveReported === false &&
      textFull.obstacleReported === "SAFE",
    JSON.stringify(textFull)
  );
  check(
    "text line carries no speed/x/y/heading",
    textFull && !("speed" in textFull) && !("x" in textFull) && !("y" in textFull) && !("heading" in textFull),
    ""
  );
  const textNoReading = parseTelemetryLine("Distance: NO READING");
  check(
    "parser maps 'NO READING' to an explicit null distance",
    textNoReading && "obstacleDistance" in textNoReading && textNoReading.obstacleDistance === null,
    JSON.stringify(textNoReading)
  );
  const banner = parseTelemetryLine("MineGuard Arduino Nano Ready");
  check("parser recognises the rig's boot banner", banner && typeof banner.boot === "string", JSON.stringify(banner));
  const boot = parseTelemetryLine('{"boot":"MineGuard V2 ready","fw":"1.0"}');
  check("parser recognises the boot banner", boot && typeof boot.boot === "string", JSON.stringify(boot));

  // -------------------------------------------------------------------------
  // 7. data files stay valid with real-only schema
  // -------------------------------------------------------------------------
  const events = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "events.json"), "utf8"));
  check("data/events.json parses (array)", Array.isArray(events), `${events.length} events`);
  const csv = fs.readFileSync(path.join(__dirname, "..", "data", "telemetry.csv"), "utf8");
  const header = csv.split(/\r?\n/)[0];
  check(
    "telemetry.csv header is the real-data schema",
    header === "time,device_id,distance_cm,obstacle_state,link,fog_pct,fog_logic,risk,risk_score,light,buzzer,imu_fitted",
    `header=${header}`
  );
  const rows = csv.trim().split(/\r?\n/).slice(1);
  const badSpeedRow = rows.some((r) => /speed|ttc/i.test(r.split(",").slice(-1)[0]));
  check("no speed/ttc columns ever written to the CSV", !badSpeedRow, `${rows.length} rows`);

  console.log(`\nrealcheck: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("realcheck error:", e.message);
  process.exit(1);
});
