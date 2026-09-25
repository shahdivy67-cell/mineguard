/**
 * MineGuard Control Room — REAL DATA ONLY.
 *
 * Every number on this screen comes from the Arduino over the serial bridge
 * (HTTP/WS from the MineGuard server). The app contains no simulator, no
 * random values, no fake movement and no substitute readings: if the hardware
 * is silent the panels say "Disconnected / No data / N/A".
 *
 * The rig has no speed sensor and no positioning sensor, so:
 *   Speed = "N/A — No speed sensor"
 *   TTC   = "N/A — Speed data unavailable"
 * Fog intensity 0-100 is a PC CONTROL value: 0-30% = fog-dependent logic OFF,
 * 31-100% = fog-dependent logic ON.
 */
import { useEffect, useRef, useState } from "react";

// Viewer links work at any depth: "/view/…" locally, "/<repo>/view/…" on
// GitHub Pages project sites.
const VIEW_IDX = window.location.pathname.indexOf("/view/");
// Interactive (operator) mode only where it belongs: locally with the server,
// or at the exact secret control path baked in at build time. On static
// hosting everything else renders read-only, even if someone guesses a path.
const CONTROL_PATH = import.meta.env.VITE_CONTROL_PATH || "";
const IS_VIEWER =
  VIEW_IDX >= 0 ||
  (!!CONTROL_PATH && window.location.pathname.indexOf(CONTROL_PATH) < 0);
const VIEW_PATH = IS_VIEWER
  ? window.location.pathname.slice(VIEW_IDX).replace(/\/+$/, "")
  : "/";
// Optional baked-in live server (VITE_API_BASE build arg). Set it when the
// page is hosted statically (GitHub Pages) but a real MineGuard server with
// the Arduino should feed it. Empty = same-origin (local single-port mode).
const API_OVERRIDE = import.meta.env.VITE_API_BASE || "";
const API_BASE =
  API_OVERRIDE ||
  (window.location.port === "5173" ? "http://localhost:4000" : window.location.origin);
// Pure static GitHub Pages with no configured live server: don't hammer a
// WebSocket that can never exist — render the honest "No data / Disconnected".
const HAS_BACKEND =
  !!API_OVERRIDE || !window.location.hostname.endsWith(".github.io");
const WS_URL = !HAS_BACKEND
  ? null
  : API_OVERRIDE
  ? `${API_OVERRIDE.replace(/^http/, "ws")}${VIEW_PATH}`
  : `${window.location.protocol === "https:" ? "wss" : "ws"}://${
      window.location.port === "5173" ? "localhost:4000" : window.location.host
    }${VIEW_PATH}`;

// ---------------------------------------------------------------------------
// Control-room DANGER alarm (browser sound) — identical on the operator page
// AND on read-only share links: it's a notification, not a control.
// MUTE IS HARD: every tone routes through one master gain, so muting cuts
// off anything already scheduled — no sound can leak out while muted.
// ---------------------------------------------------------------------------
let audioCtx = null;
let masterGain = null;
let alarmMuted = false;
function getAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = alarmMuted ? 0 : 1;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (masterGain) masterGain.gain.value = alarmMuted ? 0 : 1;
    return audioCtx;
  } catch {
    return null;
  }
}
function setAlarmMuted(muted) {
  alarmMuted = muted;
  if (masterGain) masterGain.gain.value = muted ? 0 : 1; // instant silence
}
function alarmTone(freq, ms, vol = 0.16, when = 0) {
  if (alarmMuted) return; // muted = absolutely no voice from the software
  const ctx = getAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  osc.connect(gain).connect(masterGain || ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}
function dangerBurst() {
  alarmTone(880, 140, 0.18, 0);
  alarmTone(660, 140, 0.18, 0.18);
  alarmTone(880, 140, 0.18, 0.36);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(ts).toLocaleTimeString();
}

function Card({ label, value, sub, tone }) {
  return (
    <div className={`card ${tone ? `card-${tone}` : ""}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The physical traffic-light mimic. Primary source: the LED colour the
// Arduino REPORTS in its telemetry. When the sketch doesn't send a colour
// (the current text sketch doesn't), the mimic mirrors the cab's OWN
// reported obstacle state — SAFE -> green, WARNING/CAUTION -> yellow,
// DANGER -> red — labelled as derived, never presented as a raw sensor.
// ---------------------------------------------------------------------------
const CAB_TO_LED = { SAFE: "GREEN", WARNING: "YELLOW", CAUTION: "YELLOW", DANGER: "RED" };
function TrafficMimic({ light, cabState, linkOk }) {
  const source = !linkOk ? null : light || CAB_TO_LED[cabState] || null;
  const how = !linkOk
    ? "no data"
    : light
    ? "reported by the firmware"
    : source
    ? "mirrors cab-reported state"
    : "not reported";
  return (
    <div className="traffic" title="Status LEDs — real reported or cab-reported state">
      <span className={`tl tl-green ${source === "GREEN" ? "on" : ""}`} />
      <span className={`tl tl-yellow ${source === "YELLOW" ? "on" : ""}`} />
      <span className={`tl tl-red ${source === "RED" ? "on" : ""}`} />
      <span className="traffic-label">
        {source || "—"} <em>{how}</em>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Distance bar — real ultrasonic reading against the fog-gated thresholds.
// ---------------------------------------------------------------------------
function RangeBar({ distance, caution, danger, hasData }) {
  const MAX = 200; // scale of the bar; anything beyond reads as "clear"
  const pct = (v) => `${Math.max(0, Math.min(100, (v / MAX) * 100))}%`;
  return (
    <div className="range">
      <div className="range-track">
        {hasData && distance != null && (
          <div
            className={`range-fill ${distance < danger ? "bad" : distance <= caution ? "warn" : "ok"}`}
            style={{ width: pct(distance) }}
          />
        )}
        <div className="range-mark" style={{ left: pct(caution) }} title={`Caution band ≤ ${caution} cm`} />
        <div className="range-mark danger" style={{ left: pct(danger) }} title={`Danger < ${danger} cm`} />
      </div>
      <div className="meter-scale">
        <span>0 cm</span>
        <span>caution {caution} · danger {danger}</span>
        <span>{MAX} cm (clear beyond)</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SIMULATION — a stationary truck and a "big rock", rendered ONLY from the
// real ultrasonic echo: if the sensor reports 20 cm, the rock sits at 20 cm
// ahead of the truck. There is no position sensor, so the truck never moves;
// with no echo (NO READING / Disconnected) the rock is not drawn at all —
// the view says "No data" instead of inventing a rock position.
// ---------------------------------------------------------------------------
function SimView({ distance, linkOk, caution, danger, obstacleState, fogActive, fogIntensity }) {
  const hasData = linkOk && distance != null;
  // Auto-range view (min 120 cm so the fog-widened bands always fit):
  const viewMax = hasData ? Math.max(120, Math.ceil((distance + 20) / 50) * 50) : 120;
  const pct = (cm) => Math.min(100, (cm / viewMax) * 100);
  const rockPct = hasData ? pct(distance) : 0;
  const dPct = pct(danger);
  const cPct = pct(caution);
  const badge = obstacleState.toLowerCase().replace(/\s+/g, "");
  return (
    <div className="sim">
      <div className="sim-head">
        <b>SIMULATION — STATIONARY TRUCK + BIG ROCK</b>
        <span className="muted">front sensor looks forward — the rock is drawn AHEAD of the truck, from the live echo only</span>
        <span className={`state-badge ${hasData ? badge : "nodata"}`}>
          {hasData ? obstacleState : "NO DATA"}
        </span>
      </div>
      <div className="sim-stage">
        {/* the road the truck sits on (asphalt, edge lines, lane markings) */}
        <div className="sim-asphalt">
          <div className="road-edge road-top" />
          <div className="road-edge road-bottom" />
          <div className="road-dash" />
        </div>
        <div className="sim-lane">
          {hasData && (
            <>
              <div className="sim-band bad" style={{ width: `${dPct}%` }} title={`danger < ${danger} cm`} />
              <div className="sim-band warn" style={{ left: `${dPct}%`, width: `${cPct - dPct}%` }} title={`caution band ${danger}–${caution} cm`} />
              <div className="sim-band ok" style={{ left: `${cPct}%`, right: 0 }} title={`clear > ${caution} cm`} />
              <div className="sim-beam" style={{ width: `${rockPct}%` }} />
              <div
                className={`sim-rock ${distance < danger ? "rock-danger" : distance <= caution ? "rock-warn" : "rock-ok"}`}
                style={{ left: `${rockPct}%` }}
              >
                <span className="rock-icon">🪨</span>
                <span className="sim-rock-label">
                  BIG ROCK · {Math.round(distance)} cm
                </span>
              </div>
            </>
          )}
          {/* Real truck (top-down), nose pointing RIGHT — the ultrasonic is
              mounted at the front bumper and looks FORWARD, so the rock is
              always drawn ahead of the truck, never behind it. */}
          <div className="sim-truck" title="Truck — stationary, front ultrasonic faces forward">
            <svg viewBox="0 0 62 64" className="truck-svg">
              {/* wheels */}
              <rect x="5" y="3" width="12" height="7" rx="2" fill="#14161c" />
              <rect x="5" y="54" width="12" height="7" rx="2" fill="#14161c" />
              <rect x="21" y="3" width="12" height="7" rx="2" fill="#14161c" />
              <rect x="21" y="54" width="12" height="7" rx="2" fill="#14161c" />
              <rect x="43" y="3" width="12" height="7" rx="2" fill="#14161c" />
              <rect x="43" y="54" width="12" height="7" rx="2" fill="#14161c" />
              {/* cargo trailer */}
              <rect x="3" y="9" width="34" height="46" rx="3" fill="#b7c0cd" stroke="#7d8798" strokeWidth="1.5" />
              <line x1="11" y1="11" x2="11" y2="53" stroke="#98a2b3" strokeWidth="1" />
              <line x1="19" y1="11" x2="19" y2="53" stroke="#98a2b3" strokeWidth="1" />
              <line x1="27" y1="11" x2="27" y2="53" stroke="#98a2b3" strokeWidth="1" />
              {/* cab (facing right = forward) */}
              <path d="M37 11 h14 a6 6 0 0 1 6 6 v30 a6 6 0 0 1 -6 6 h-14 z" fill="#3f74cf" stroke="#2b56a6" strokeWidth="1.5" />
              <rect x="50.5" y="16" width="5.5" height="32" rx="2.5" fill="#9fd2ff" />
              {/* headlights at the front */}
              <rect x="52.5" y="12.5" width="4" height="6" rx="1.5" fill="#ffd76a" />
              <rect x="52.5" y="45.5" width="4" height="6" rx="1.5" fill="#ffd76a" />
              {/* the ultrasonic sensor (TRIG D9 / ECHO D10) on the front bumper */}
              <circle cx="58.5" cy="32" r="2.8" fill="#40d0ff" stroke="#1b83b5" strokeWidth="1" />
            </svg>
            <span className="sim-truck-tag">STATIONARY</span>
          </div>
        </div>
        {!hasData && (
          <div className="sim-nodata">
            {linkOk ? "NO READING — echo lost, rock position unknown" : "No data — simulation needs a live echo"}
          </div>
        )}
        {fogActive && (
          <div className="sim-fog" style={{ opacity: (fogIntensity / 100) * 0.55 }} title={`fog control ${fogIntensity}%`} />
        )}
        <div className="sim-caption">
          truck fixed — no position sensor · sensor D9/D10 faces forward → rock AHEAD = real distance
          {hasData ? ` ${Math.round(distance)} cm` : " (No data)"}
        </div>
      </div>
      <div className="meter-scale sim-scale">
        <span>0 cm</span>
        <span>caution {caution} · danger {danger}</span>
        <span>view to {viewMax} cm</span>
      </div>
      <div className="muted sim-foot">
        Zones: red &lt; {danger} cm · yellow {danger}–{caution} cm · green beyond {caution} cm
        {fogActive ? ` · white overlay = PC fog control ${fogIntensity}% (logic ON)` : ""}
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [connected, setConnected] = useState(false);
  const [alarmOn, setAlarmOn] = useState(true); // 🔊 audible danger alarm
  const [copied, setCopied] = useState(false); // 🔗 share-link copy feedback
  const [msgText, setMsgText] = useState(""); // 📨 emergency message draft
  const [fogDraft, setFogDraft] = useState(null); // local slider echo

  const device = state?.device || null;
  const linkOk = device?.link === "CONNECTED";
  const riskLevel = device?.risk?.level || "NO DATA";
  const dangerActive = riskLevel === "DANGER"; // real-data risk only

  // Unlock audio on the first user gesture (browser autoplay policy)
  useEffect(() => {
    const unlock = () => getAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Mute is instant and total — master gain 0 kills queued tones too.
  useEffect(() => {
    setAlarmMuted(!alarmOn);
  }, [alarmOn]);

  // Sound while danger persists: klaxon burst on entry, repeats every 1.1 s,
  // stops the instant the reading clears (or the operator mutes it).
  useEffect(() => {
    document.body.dataset.danger = dangerActive ? "1" : "0";
    if (!dangerActive || !alarmOn || alarmMuted) return;
    dangerBurst();
    const id = setInterval(dangerBurst, 1100);
    return () => clearInterval(id);
  }, [dangerActive, alarmOn]);

  const wsRef = useRef(null);
  const retryRef = useRef(null);

  useEffect(() => {
    if (!WS_URL) return; // static hosting, no live server configured
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        retryRef.current = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "state") {
            setState(msg);
            setFogDraft(null); // slider follows the server value again
          }
        } catch {}
      };
    }
    connect();
    return () => {
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  const send = (msg) => {
    if (IS_VIEWER) return; // view-only link: never emit a command
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg));
  };

  // 📨 Emergency message -> the cab (bridge pushes "MSG <text>" over
  // Bluetooth/USB; delivery is confirmed only by the cab's rising msgCount).
  const sendMsg = () => {
    const t = msgText.trim();
    if (!t || !device) return;
    send({ type: "truckMessage", vehicleId: device.id, text: t });
    setMsgText("");
  };

  const setFog = (v) => {
    setFogDraft(v);
    send({ type: "setFogIntensity", value: v });
  };

  // One-click copy of the PERMANENT read-only link (no dialogs — silent copy,
  // prompt only as fallback where the clipboard API is blocked)
  const shareLink = async () => {
    try {
      const r = await fetch(`${API_BASE}/api/share`);
      const { url, permanent } = await r.json();
      const link = permanent || url;
      try {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        window.prompt("Permanent read-only share link:", link);
      }
    } catch {
      alert("Could not reach the MineGuard server for the share link.");
    }
  };

  const exportCsv = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/csv`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mineguard-telemetry.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("CSV export failed — is the MineGuard server running?");
    }
  };

  const fogIntensity = fogDraft ?? state?.fogIntensity ?? 0;
  const fogActive = state?.fogActive ?? false;
  const activeEvents = (state?.events || []).filter(
    (e) => e.status === "active" || e.status === "escalated"
  );
  const riskClass = riskLevel.toLowerCase().replace(/\s+/g, "");
  const bridge = state?.bridge;
  const bridgeText = !bridge || bridge.state === "not-started"
    ? "BRIDGE: not started"
    : `BRIDGE: ${bridge.state === "open" ? "open" : bridge.state} · ${bridge.port || "?"} @ ${bridge.baud || "?"} (${bridge.link || "?"})`;

  // AI action advisory + everything the ultrasonic can yield (real only)
  const advice = device?.advice || null;
  const ultra = device?.ultrasonic || {};
  const dist = linkOk ? device?.distanceCm ?? null : null;
  const cautionCm = state?.thresholds?.obstacleCautionCm ?? 40;
  const withinCaution = dist != null && dist <= cautionCm;
  // Buzzer state: reported value first; otherwise derived from the cab's own
  // reported obstacle state and LABELLED as derived (this sketch has no
  // separate buzzer field).
  const cabAlert = ["WARNING", "CAUTION", "DANGER"].includes(device?.obstacleReported);
  const buzzerDerived = linkOk && cabAlert && device?.buzzerOn == null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⛏</span> MineSafe 360* <span className="muted">MINEGUARD CONTROL ROOM</span>
        </div>
        <div className="topbar-right">
          <span className={`pill ${fogActive ? "pill-fog" : ""}`}>
            {fogActive ? `FOG LOGIC: ON · ${state?.fogIntensity ?? 0}%` : "FOG: OFF"}
          </span>
          <span className={`pill ${linkOk ? "pill-ok" : "pill-bad"}`}>
            {linkOk ? "ARDUINO: LIVE" : "ARDUINO: DISCONNECTED"}
          </span>
          <span className="pill" title="Serial bridge status">{bridgeText}</span>
          <button className="btn btn-export" onClick={exportCsv}>⬇ Export CSV (2 s)</button>
          <button
            className="btn"
            title="Audible klaxon while the real risk level is DANGER (works on share links too)"
            onClick={() => {
              setAlarmOn((s) => !s);
              getAudio();
            }}
          >
            {alarmOn ? "🔊 Danger alarm" : "🔇 Alarm muted"}
          </button>
          {IS_VIEWER ? (
            <span className="pill pill-fog">👁 VIEW ONLY — LIVE DATA</span>
          ) : (
            <button className="btn" onClick={shareLink}>{copied ? "✓ Link copied" : "🔗 Share view-only"}</button>
          )}
          <span className={`pill ${connected ? "pill-ok" : "pill-bad"}`}>
            {connected ? "SERVER CONNECTED" : "SERVER OFFLINE"}
          </span>
        </div>
      </header>

      {!state && (
        <div className="loading">
          {WS_URL
            ? `Waiting for MineGuard server on ${WS_URL} …`
            : "Static demo page — no live MineGuard server configured (set VITE_API_BASE). All values stay honest: No data."}
        </div>
      )}

      {state && device && (
        <>
          {!linkOk && (
            <div className="cab-alert danger">
              <b>⚠ ARDUINO DISCONNECTED</b>
              <span>
                {device.linkDetail} — showing No data. No values are estimated while the
                sensor stream is down.
              </span>
            </div>
          )}

          <main className="layout">
            <section className="mine-panel panel">
              <div className="panel-title">
                ARDUINO / BLUETOOTH — {device.id}
                <span className={`risk-badge ${riskClass}`}>{riskLevel}</span>
                <span className={`comm-badge ${linkOk ? "ok" : "bad"}`}>
                  LINK: {device.link}
                </span>
              </div>

              {/* ---- AI action advisory — orders generated from REAL data ---- */}
              {advice && (
                <div className={`advice advice-${advice.tone}`}>
                  <div className="advice-title">
                    🤖 AI ACTION ADVISORY <em>— generated from live sensor data</em>
                  </div>
                  <div className="advice-head">{advice.headline}</div>
                  <ul className="advice-lines">
                    {advice.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ---- real ultrasonic distance ---- */}
              <div className="distance-hero">
                <div className={`distance-value ${linkOk && device.distanceCm != null ? "" : "nodata"}`}>
                  {linkOk && device.distanceCm != null ? device.distanceCm : "No data"}
                  <span className="unit">{linkOk && device.distanceCm != null ? "cm" : ""}</span>
                </div>
                <div className="distance-side">
                  <span className={`state-badge ${device.obstacleState.toLowerCase().replace(/\s+/g, "")}`}>
                    {device.obstacleState === "NO DATA" ? "OBSTACLE: NO DATA" : `OBSTACLE: ${device.obstacleState}`}
                  </span>
                  {linkOk && device.obstacleReported && (
                    <span className="state-badge cab">CAB REPORTS: {device.obstacleReported}</span>
                  )}
                  <span className="muted">
                    {linkOk
                      ? `Last data: ${ago(device.lastDataAt)}`
                      : "Last data: none / stale — no current reading"}
                  </span>
                  <span className="muted mono">
                    {device.lastDataAt ? new Date(device.lastDataAt).toLocaleString() : "—"}
                  </span>
                </div>
              </div>

              <RangeBar
                distance={device.distanceCm}
                caution={state.thresholds.obstacleCautionCm}
                danger={state.thresholds.obstacleDangerCm}
                hasData={linkOk}
              />

              {/* ---- everything the ultrasonic can yield (real echoes only) ---- */}
              <div className="ultra-strip">
                <div className="ultra-title">ULTRASONIC SENSOR (HC-SR04) — live outputs</div>
                <div className="ultra-grid">
                  <div className="u-item">
                    <span>OBJECT WITHIN {cautionCm} CM</span>
                    <b className={!linkOk || dist == null ? "u-nd" : withinCaution ? "u-bad" : "u-ok"}>
                      {!linkOk || dist == null ? "No data" : withinCaution ? "YES" : "NO"}
                    </b>
                  </div>
                  <div className="u-item">
                    <span>DISTANCE</span>
                    <b className={dist == null ? "u-nd" : ""}>
                      {dist != null ? `${dist} cm · ${(dist / 100).toFixed(2)} m` : "No data"}
                    </b>
                  </div>
                  <div className="u-item">
                    <span>SESSION MIN</span>
                    <b className={ultra.minCm == null ? "u-nd" : ""}>
                      {ultra.minCm != null ? `${ultra.minCm} cm` : "—"}
                    </b>
                  </div>
                  <div className="u-item">
                    <span>SESSION MAX</span>
                    <b className={ultra.maxCm == null ? "u-nd" : ""}>
                      {ultra.maxCm != null ? `${ultra.maxCm} cm` : "—"}
                    </b>
                  </div>
                  <div className="u-item">
                    <span>ECHOES / NO-READING</span>
                    <b>
                      {ultra.readings ?? 0} / {ultra.noReadings ?? 0}
                    </b>
                  </div>
                  <div className="u-item u-spark">
                    <span>LAST {ultra.history?.length ?? 0} ECHOES</span>
                    <div className="spark">
                      {(ultra.history || []).length === 0 && <em className="muted">No data</em>}
                      {(ultra.history || []).map((h, i) => {
                        const max = Math.max(...(ultra.history || [1]), 50);
                        return (
                          <i
                            key={i}
                            className={h <= (state.thresholds.obstacleDangerCm) ? "bad" : h <= cautionCm ? "warn" : "ok"}
                            style={{ height: `${Math.max(8, Math.min(100, (h / max) * 100))}%` }}
                            title={`${h} cm`}
                          />
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* ---- simulation: stationary truck + rock at the REAL distance ---- */}
              <SimView
                distance={dist}
                linkOk={linkOk}
                caution={state.thresholds.obstacleCautionCm}
                danger={state.thresholds.obstacleDangerCm}
                obstacleState={device.obstacleState}
                fogActive={fogActive}
                fogIntensity={state.fogIntensity}
              />

              <div className="grid2">
                <Card label="Speed" value={device.speedText} sub="no speed sensor on this rig" tone="warn" />
                <Card label="TTC (time to collision)" value={device.ttcText} sub="requires speed + distance" tone="warn" />
                <Card
                  label="Status LED (hardware)"
                  value={<TrafficMimic light={device.light} cabState={device.obstacleReported} linkOk={linkOk} />}
                  sub={
                    !linkOk
                      ? "No data"
                      : device.light
                      ? "reported by the firmware"
                      : device.obstacleReported
                      ? "derived from the cab-reported state"
                      : "sketch reports no LED field"
                  }
                />
                <Card
                  label="Buzzer (hardware)"
                  value={
                    !linkOk
                      ? "No data"
                      : device.buzzerOn === 1
                      ? "🔊 SOUNDING"
                      : device.buzzerOn === 0
                      ? "Silent (reported)"
                      : device.buzzer
                      ? device.buzzer
                      : buzzerDerived
                      ? "⚠ ACTIVE"
                      : "not reported"
                  }
                  sub={
                    !linkOk
                      ? "No data"
                      : device.buzzerOn != null
                      ? "reported by the firmware"
                      : buzzerDerived
                      ? "cab in warning — derived state"
                      : "no buzzer field from this sketch"
                  }
                  tone={device.buzzerOn === 1 || buzzerDerived ? "bad" : undefined}
                />
                <Card
                  label="Fog intensity (PC control)"
                  value={`${state.fogIntensity}%`}
                  sub={fogActive ? `fog-dependent logic ON (> ${state.fogGatePct}%)` : `fog-dependent logic OFF (≤ ${state.fogGatePct}%)`}
                  tone={fogActive ? "warn" : "ok"}
                />
                <Card
                  label="Fog applied by Arduino"
                  value={linkOk && device.fogReported != null ? `${device.fogReported}%` : linkOk ? "not reported" : "No data"}
                  sub={
                    linkOk && device.fogActiveReported != null
                      ? `cab's own gate: ${device.fogActiveReported ? "ON" : "OFF"} · from the cab, not a sensor`
                      : "confirmation from the cab, not a sensor"
                  }
                />
                <Card
                  label="IMU"
                  value={device.imu === true ? "fitted" : device.imu === false ? "not fitted" : linkOk ? "not reported" : "No data"}
                  sub="tilt/accel only exist with an MPU6050"
                  tone={device.imu ? undefined : "warn"}
                />
                <Card
                  label="Last real data"
                  value={ago(device.lastDataAt)}
                  sub={linkOk ? "stream live" : "Disconnected — no data"}
                  tone={linkOk ? "ok" : "bad"}
                />
                <Card
                  label="Risk score"
                  value={device.risk.score == null ? "N/A" : `${device.risk.score}/100`}
                  sub={`level ${riskLevel}`}
                  tone={riskClass === "danger" ? "bad" : riskClass === "caution" ? "warn" : riskClass === "safe" ? "ok" : undefined}
                />
                <Card
                  label="Uptime / msg receipt"
                  value={linkOk && device.uptimeSec != null ? `${device.uptimeSec} s` : linkOk ? "—" : "No data"}
                  sub={linkOk ? `msgCount ${device.msgCount}` : "No data"}
                />
              </div>

              {/* Emergency message -> real cab over Bluetooth/USB */}
              <div className="msg-controls">
                <span className="muted">📨 Emergency message:</span>
                <input
                  type="text"
                  maxLength={80}
                  placeholder={`message to ${device.id}…`}
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMsg()}
                  disabled={IS_VIEWER}
                />
                {!IS_VIEWER && <button className="btn btn-warn" onClick={sendMsg}>📨 Send to truck</button>}
                {device.truckMessage && (
                  <span className={`msg-status ${device.truckMessage.delivered ? "ok" : "wait"}`}>
                    {device.truckMessage.delivered
                      ? `✓ delivered — "${device.truckMessage.text}"`
                      : `⏳ sending — "${device.truckMessage.text}" (waiting for the cab's receipt)`}
                  </span>
                )}
              </div>
            </section>

            <aside className="side">
              <section className="panel fog-panel">
                <div className="panel-title">
                  FOG INTENSITY — PC CONTROL
                  <span className={`pill ${fogActive ? "pill-fog" : ""}`}>
                    {fogActive ? "LOGIC ON" : "LOGIC OFF"}
                  </span>
                </div>
                <div className="fog-meter">
                  <div className="fog-meter-value">
                    {state.fogIntensity}<span className="pct">%</span>
                    <em>{fogActive ? `FOG-DEPENDENT LOGIC ACTIVE (> ${state.fogGatePct}%)` : `FOG LOGIC OFF (0–${state.fogGatePct}%)`}</em>
                  </div>
                  <div className="meter">
                    <div className="meter-fill" style={{ width: `${state.fogIntensity}%` }} />
                    <div className="meter-needle" style={{ left: `${state.fogIntensity}%` }} />
                  </div>
                  <div className="meter-scale">
                    <span>0</span><span>{state.fogGatePct} gate</span><span>100</span>
                  </div>
                </div>
                {!IS_VIEWER && (
                  <div className="fog-controls">
                    <button className={`btn ${!fogActive ? "active" : ""}`} onClick={() => setFog(0)}>0 (off)</button>
                    <button className={`btn ${fogActive ? "active" : ""}`} onClick={() => setFog(60)}>60</button>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={fogIntensity}
                      onChange={(e) => setFog(Number(e.target.value))}
                    />
                  </div>
                )}
                <div className="muted pad-sm">
                  A control value from this PC — never a sensor reading. Sent to the Arduino as
                  FOG &lt;0-100&gt;.
                </div>
              </section>

              <section className="panel">
                <div className="panel-title">WHY THIS RISK LEVEL</div>
                <ul className="factors">
                  {(device.risk.factors || []).map((f, i) => (
                    <li key={i} className={`factor-${f.tone}`}>
                      <span>{f.tone === "bad" ? "✖" : f.tone === "warn" ? "!" : "✓"}</span> {f.label}
                      {f.weight > 0 && <em>+{f.weight}</em>}
                    </li>
                  ))}
                </ul>
              </section>
            </aside>

            <section className="events-panel panel">
              <div className="panel-title">
                ALERTS (real observations)
                {activeEvents.length > 0 && <span className="pill pill-bad">{activeEvents.length} ACTIVE</span>}
              </div>
              {state.events.length === 0 && <div className="muted pad">No events yet</div>}
              <ul className="events">
                {state.events.map((ev) => (
                  <li key={ev.id} className={`ev-${ev.severity} ev-${ev.status}`}>
                    <div className="ev-main">
                      <b>{ev.type.replaceAll("_", " ")}</b> · {ev.message}
                      <div className="ev-meta">
                        {ago(ev.at)} · status: {ev.status}
                      </div>
                    </div>
                    {ev.status === "active" && !IS_VIEWER && (
                      <button className="btn btn-small" onClick={() => send({ type: "ack", eventId: ev.id })}>
                        Acknowledge
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </main>
        </>
      )}
    </div>
  );
}
