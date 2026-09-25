/**
 * MineGuard one-click launcher.
 * Double-click start.bat (or run: node start.js)
 *
 *   - starts the server (port 4000) if it isn't already running
 *   - the server ITSELF serves the built dashboard (dashboard/dist) on :4000,
 *     so the whole system lives on ONE port — trivial to share on the LAN
 *   - starts the Vite dev dashboard (port 5173) ONLY if dashboard/dist is
 *     missing (dev flow: npm run build inside dashboard/)
 *   - waits until healthy, opens http://localhost:4000 (full control) and
 *     prints the READ-ONLY share link for other devices
 *
 * Flags:
 *   --no-open   don't open the browser (used for automated checks)
 *   --check     only verify both services, print status, exit
 *
 * Leave this window open while demoing — closing it stops MineGuard.
 * (Or use stop.bat to stop everything without this window.)
 */
const { spawn, execSync } = require("child_process");
const net = require("net");
const http = require("http");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const NO_OPEN = args.includes("--no-open");
const CHECK_ONLY = args.includes("--check");
const SERVER_PORT = 4000;
const DASH_PORT = 5173;
const ROOT = __dirname;
const USE_BUILT = fs.existsSync(path.join(ROOT, "dashboard", "dist", "index.html"));
const UI_PORT = USE_BUILT ? SERVER_PORT : DASH_PORT; // where the UI lives

const log = (m) => console.log(`[mineguard] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

function healthy(url, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
  });
}

async function waitUntil(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} — check the log above`);
}

function spawnService(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, shell: true, stdio: "inherit" });
  child.on("exit", (code) => log(`${name} process exited with code ${code}`));
  return child;
}

async function ensureService({ name, port, healthUrl, cmd, args, cwd }) {
  if (await healthy(healthUrl)) {
    log(`${name} already running on :${port}`);
    return;
  }
  if (await portBusy(port)) {
    throw new Error(`port ${port} is occupied by a different application — stop it first`);
  }
  if (CHECK_ONLY) {
    console.error(`[mineguard] ${name} is NOT running`);
    process.exitCode = 1;
    return;
  }
  log(`launching ${name} (${cmd} ${args.join(" ")})…`);
  spawnService(name, cmd, args, cwd);
}

async function main() {
  log("MineGuard launcher starting…");

  await ensureService({
    name: "server",
    port: SERVER_PORT,
    healthUrl: `http://localhost:${SERVER_PORT}/api/state`,
    cmd: "node",
    args: ["index.js"],
    cwd: path.join(ROOT, "server"),
  });

  if (USE_BUILT) {
    log(`built dashboard found — the server serves it on :${SERVER_PORT} (single-port mode)`);
  } else {
    log("dashboard/dist missing — falling back to the Vite dev server");
    await ensureService({
      name: "dashboard",
      port: DASH_PORT,
      healthUrl: `http://localhost:${DASH_PORT}/`,
      cmd: "npm",
      args: ["run", "dev"],
      cwd: path.join(ROOT, "dashboard"),
    });
  }

  // --- serial bridge: the ONLY source of sensor data (the real Arduino) -----
  // It has no port to health-check (it opens a COM port), so it runs its own
  // single-instance guard and retries until the Arduino appears.
  if (args.includes("--no-bridge")) {
    log("--no-bridge: serial bridge skipped (dashboard will show Arduino: DISCONNECTED)");
  } else if (CHECK_ONLY) {
    const alive = (() => {
      try {
        const pid = parseInt(fs.readFileSync(path.join(ROOT, "server", "bridge.pid"), "utf8"), 10);
        if (!pid) return false;
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (alive) log("serial bridge: running");
    else console.error("[mineguard] serial bridge: NOT running (no Arduino data will arrive)");
  } else {
    log("launching serial bridge (real Arduino over Bluetooth/USB)…");
    spawnService("bridge", "node", ["bridge.js"], path.join(ROOT, "server"));
  }

  if (CHECK_ONLY) {
    log(process.exitCode ? "CHECK FAILED — see above" : "CHECK OK — server + dashboard are up");
    return;
  }

  log("waiting for services to become ready…");
  await waitUntil(() => healthy(`http://localhost:${SERVER_PORT}/api/state`), 30000, "server");
  log(`server ready   → http://localhost:${SERVER_PORT}`);
  await waitUntil(() => healthy(`http://localhost:${UI_PORT}/`), 30000, "dashboard");
  log(`dashboard ready → http://localhost:${UI_PORT}`);

  // Print the read-only share link the server generated for other devices
  try {
    const share = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${SERVER_PORT}/api/share`, (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(JSON.parse(b)));
      }).on("error", reject);
    });
    log(`PERMANENT share link (works even after IP changes): ${share.permanent || share.url}`);
    if (share.permanent && share.url) log(`IP fallback: ${share.url}`);
  } catch {}

  if (!NO_OPEN) {
    log("opening the control room in your browser…");
    try {
      execSync(`start "" "http://localhost:${UI_PORT}"`, { shell: true });
    } catch {}
  }

  log("ALL READY — the fleet is live.");
  log("Keep this window open while demoing; closing it stops MineGuard.");
  log("Or run stop.bat anytime to stop it silently.");
}

main().catch((e) => {
  console.error(`[mineguard] ERROR: ${e.message}`);
  process.exit(1);
});
