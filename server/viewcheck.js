/**
 * MineGuard ACCESS suite — read-only share links on the real-data server.
 *   node viewcheck.js       (server up on :4000)
 *
 * Proves:
 *   1. the server itself serves the dashboard (single-port mode)
 *   2. /api/share + /view/<token> work, wrong tokens are refused (404)
 *   3. a VIEWER websocket receives live state (with the honest N/A speed/TTC
 *      text) but every command is answered {"type":"denied"} and changes
 *      nothing — including fake-data commands like sim/addObstacle/
 *      moveObstacle, which nothing implements any more
 *   4. the CONTROLLER websocket still controls (the refusal is role-based)
 *   5. telemetry ingestion (POST /telemetry) refuses non-loopback callers
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BASE = "http://localhost:4000";
const TOKEN = fs.readFileSync(path.join(__dirname, "..", "data", "share-token.txt"), "utf8").trim();

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
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      })
      .on("error", reject);
  });
}

function post(url, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const req = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function main() {
  // --- 1. single-port dashboard ------------------------------------------
  const root = await get(`${BASE}/`);
  check(
    "server serves the built dashboard on :4000",
    root.status === 200 && /<div id="root">/.test(root.body),
    `status=${root.status}`
  );

  // --- 2. share metadata + token route ------------------------------------
  const share = await get(`${BASE}/api/share`);
  let shareJson = null;
  try {
    shareJson = JSON.parse(share.body);
  } catch {}
  check(
    "/api/share returns url + permanent + token",
    share.status === 200 && shareJson && shareJson.url && shareJson.permanent && shareJson.token === TOKEN,
    `status=${share.status}`
  );
  const view = await get(`${BASE}/view/${TOKEN}`);
  check("GET /view/<token> serves the dashboard", view.status === 200 && /<div id="root">/.test(view.body), `status=${view.status}`);
  const bad = await get(`${BASE}/view/NOT-THE-TOKEN`);
  check("GET /view/<wrong token> -> 404", bad.status === 404, `status=${bad.status}`);

  // --- 3. viewer socket: streams state, refuses everything ----------------
  const viewer = new WebSocket(`ws://localhost:4000/view/${TOKEN}`);
  let vState = null;
  const denied = [];
  viewer.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === "state") vState = m;
      if (m.type === "denied") denied.push(m.of);
    } catch {}
  });
  await new Promise((res, rej) => {
    viewer.on("open", res);
    viewer.on("error", rej);
  });
  await sleep(700);

  check("viewer receives live state", !!vState && vState.type === "state", "");
  check(
    "viewer state carries the honest N/A speed text",
    vState && vState.device && vState.device.speedText === "N/A — No speed sensor",
    vState && `speedText=${JSON.stringify(vState.device.speedText)}`
  );
  check(
    "viewer state carries the honest N/A TTC text",
    vState && vState.device.ttcText === "N/A — Speed data unavailable",
    vState && `ttcText=${JSON.stringify(vState.device.ttcText)}`
  );

  const fogBefore = vState && vState.fogIntensity;
  const msgBefore = JSON.stringify(vState && vState.device.truckMessage);
  const commands = [
    { type: "setFogIntensity", value: 65 },
    { type: "setFog", on: true, intensity: 65 }, // legacy sim-era command
    { type: "truckMessage", vehicleId: "MG-01", text: "viewer should not be able to send this" },
    { type: "ack", eventId: "EV-x" },
    { type: "sim", vehicleId: "MG-01", action: "resume" }, // simulator is gone
    { type: "addObstacle" }, // no obstacles are generated any more
    { type: "moveObstacle" }, // obstacles are unmovable
  ];
  for (const c of commands) viewer.send(JSON.stringify(c));
  await sleep(900);

  check(
    "every viewer command is refused with denied",
    denied.length >= commands.length && commands.every((c) => denied.includes(c.type)),
    `denied=${JSON.stringify(denied)}`
  );

  const after = await get(`${BASE}/api/state`);
  let afterJson = null;
  try {
    afterJson = JSON.parse(after.body);
  } catch {}
  check(
    "viewer commands changed nothing (fog unchanged)",
    afterJson && afterJson.fogIntensity === fogBefore,
    `fog ${fogBefore} -> ${afterJson && afterJson.fogIntensity}`
  );
  check(
    "viewer commands changed nothing (truckMessage unchanged)",
    afterJson && JSON.stringify(afterJson.device.truckMessage) === msgBefore,
    ""
  );

  // --- 4. controller socket still controls (role-based refusal) -----------
  const ctrl = new WebSocket("ws://localhost:4000");
  await new Promise((res, rej) => {
    ctrl.on("open", res);
    ctrl.on("error", rej);
  });
  let cState = null;
  ctrl.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === "state") cState = m;
    } catch {}
  });
  ctrl.send(JSON.stringify({ type: "setFogIntensity", value: 65 }));
  await sleep(700);
  check(
    "controller sets fog 65% -> logic ON (gate > 30)",
    cState && cState.fogIntensity === 65 && cState.fogActive === true,
    cState && `fog=${cState.fogIntensity} active=${cState.fogActive}`
  );
  ctrl.send(JSON.stringify({ type: "setFogIntensity", value: 0 }));
  await sleep(700);
  check(
    "controller restores fog 0% -> logic OFF",
    cState && cState.fogIntensity === 0 && cState.fogActive === false,
    ""
  );
  ctrl.close();
  viewer.close();

  // --- 5. telemetry endpoint robustness (NO state side effects here) -------
  // Malformed body -> 400; the server must not crash and must not change the
  // device state. (A loopback caller with valid JSON is the serial bridge —
  // remote callers are refused by the isLoopback() guard in index.js.)
  const rawPost = await new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}/telemetry`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on("error", reject);
    req.end("{this is not JSON");
  });
  check(
    "POST /telemetry with malformed body -> 400 (no crash)",
    rawPost.status === 400 && /"ok":false/.test(rawPost.body),
    `status=${rawPost.status}`
  );
  const wrongPath = await post(`${BASE}/no-such-endpoint`, {});
  check("unknown endpoints -> 404", wrongPath.status === 404, `status=${wrongPath.status}`);

  console.log(`\nviewcheck: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("viewcheck error:", e.message);
  process.exit(1);
});
