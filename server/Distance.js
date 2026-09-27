/**
 * Distance.js — ultrasonic range analytics (REAL echoes only).
 *
 * What it is: the single maths module behind the "object profile" panel.
 * It turns the stream of REAL HC-SR04 echoes (timestamped cm readings) into
 *   · closing speed        — Δd/Δt over the recent echo window (regression)
 *   · obstacle speed       — only when the truck is KNOWN stationary
 *                           (firmware reports Motor: OFF), because then the
 *                           closing speed IS the obstacle's speed along the
 *                           beam. With the truck moving and no speed sensor,
 *                           the two motions cannot be separated → null.
 *   · object width         — dwell-time × speed while an object CROSSES the
 *                           beam (truck stationary, obstacle moving laterally)
 *   · object length        — dwell-time × speed while an object RECEDES along
 *                           the beam (echo appears, then disappears)
 *   · object height        — always null: one ultrasonic cannot measure it.
 *
 * What it NEVER does: invent numbers. Every null carries a human reason that
 * the dashboard shows verbatim. No random values, no assumed speeds.
 *
 * Used by: server/ControlRoomServer.js (payload.device.object)
 */

// A "run" = consecutive real echoes with cm <= BEAM_ENGAGED_CM (the object is
// inside the beam). Dwell time of a run × obstacle speed = a physical extent.
const BEAM_ENGAGED_CM = 150;
const MIN_RUN_SAMPLES = 2;
const MIN_DWELL_MS = 300;

function recent(series, now, windowMs) {
  return (series || []).filter((s) => s.t >= now - windowMs);
}

// Least-squares slope (cm per ms) over the recent echo window. Timestamps
// are normalised to the first sample — raw epoch-ms values are too large for
// precise float arithmetic.
function slopeCmMsec(samples) {
  const n = samples.length;
  if (n < 2) return null;
  const t0 = samples[0].t;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const s of samples) {
    const x = s.t - t0;
    sx += x; sy += s.cm; sxy += x * s.cm; sxx += x * x;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  return (n * sxy - sx * sy) / den; // cm per ms
}

// Closing speed from real echoes. Positive = object approaching (range shrinking).
function closingSpeed(series, now, windowMs = 3000) {
  const samples = recent(series, now, windowMs);
  const slope = slopeCmMsec(samples);
  if (slope == null) return { kph: null, cmps: null, samples: samples.length, note: "not enough echoes yet" };
  const cmps = slope * 1000; // cm per second (negative = range shrinking = approaching)
  return {
    kph: Math.round(Math.abs(cmps) * 0.036 * 10) / 10,
    cmps: Math.round(cmps * 100) / 100,
    samples: samples.length,
    note: `Δd/Δt over the last ${samples.length} real echoes`,
  };
}

// Obstacle speed — ONLY when the truck is known stationary (motor OFF reported
// by the firmware). Then closing speed = obstacle speed along the beam.
function obstacleSpeed(closing, motorOff) {
  if (motorOff !== true) {
    return {
      kph: null,
      direction: null,
      note: "truck motion unknown (no speed sensor) — only closing speed is real",
    };
  }
  if (closing.kph == null) {
    return { kph: null, direction: null, note: "no closing speed yet" };
  }
  const approaching = (closing.cmps || 0) < 0; // range shrinking = object approaching
  return {
    kph: closing.kph,
    direction: approaching ? "approaching" : "receding",
    note: "truck stationary (motor OFF) → closing speed = obstacle speed along the beam",
  };
}

// The most recent contiguous run of echoes with the object inside the beam.
function lastEngagedRun(series) {
  const run = [];
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].cm != null && series[i].cm <= BEAM_ENGAGED_CM) run.unshift(series[i]);
    else break;
  }
  return run;
}

// Object WIDTH: an object crossing the beam laterally while the truck is
// stationary. dwell × speed = lateral extent. Real only.
function objectWidthCm(series, obstacle) {
  if (obstacle.kph == null) {
    return { cm: null, note: "needs a measured obstacle speed (truck stationary)" };
  }
  const run = lastEngagedRun(series);
  if (run.length < MIN_RUN_SAMPLES) {
    return { cm: null, note: "needs a crossing echo (object passing through the beam)" };
  }
  const dwellMs = run[run.length - 1].t - run[0].t;
  if (dwellMs < MIN_DWELL_MS) {
    return { cm: null, note: "crossing echo too short to size" };
  }
  const cm = Math.round(((obstacle.kph / 3.6) * 100 * dwellMs) / 1000);
  return { cm, note: `dwell ${Math.round(dwellMs)} ms × speed ${obstacle.kph} km/h (crossing echo)` };
}

// Object LENGTH along the beam: an object RECEEDING (echo appears at closest
// range, then disappears past the beam edge). dwell × speed = extent.
function objectLengthCm(series, obstacle) {
  if (obstacle.kph == null || obstacle.direction !== "receding") {
    return { cm: null, note: "needs a receding echo while the truck is stationary" };
  }
  const run = lastEngagedRun(series);
  if (run.length < MIN_RUN_SAMPLES) {
    return { cm: null, note: "needs a receding echo (object leaving the beam)" };
  }
  const dwellMs = run[run.length - 1].t - run[0].t;
  if (dwellMs < MIN_DWELL_MS) {
    return { cm: null, note: "receding echo too short to size" };
  }
  const cm = Math.round(((obstacle.kph / 3.6) * 100 * dwellMs) / 1000);
  return { cm, note: `dwell ${Math.round(dwellMs)} ms × speed ${obstacle.kph} km/h (receding echo)` };
}

// Full object profile — every value real, every null explained.
// fresh = link freshness: a stale echo is NOT shown as a live depth.
function analyzeObject(series, now, motorOff, fresh = true) {
  const closing = closingSpeed(series, now);
  const obstacle = obstacleSpeed(closing, motorOff);
  const width = objectWidthCm(series, obstacle);
  const length = objectLengthCm(series, obstacle);
  const last = (series || []).length ? series[series.length - 1] : null;
  return {
    depthCm: fresh && last ? last.cm : null, // live range — the one exact measurement
    closingKph: closing.kph,
    closingNote: closing.note,
    obstacleKph: obstacle.kph,
    obstacleDirection: obstacle.direction,
    obstacleNote: obstacle.note,
    widthCm: width.cm,
    widthNote: width.note,
    lengthCm: length.cm,
    lengthNote: length.note,
    heightCm: null,
    heightNote: "a single ultrasonic cannot measure height",
    basis: "computed from real echoes only — nothing estimated without data",
  };
}

// AI EXPECTED SPEED — a rules-based recommendation (advice, never a
// measurement). 0 = stop. Derived only from real risk + the fog control.
function expectedSpeedKph({ linkOk, distanceCm, riskLevel, fogActive }) {
  if (!linkOk) {
    return { kph: 0, label: "0 km/h — STOP", reason: "no live data from the truck", tone: "stop" };
  }
  if (distanceCm == null) {
    return { kph: 0, label: "0 km/h — STOP", reason: "ultrasonic reports NO READING", tone: "stop" };
  }
  if (riskLevel === "DANGER") {
    return { kph: 0, label: "0 km/h — STOP IMMEDIATELY", reason: "object inside the danger zone", tone: "stop" };
  }
  if (riskLevel === "CAUTION") {
    return { kph: 5, label: "≤ 5 km/h — creep", reason: "object in the caution band", tone: "caution" };
  }
  const kph = fogActive ? 10 : 20;
  return {
    kph,
    label: `≤ ${kph} km/h`,
    reason: fogActive ? "path clear, fog logic ON — reduced speed" : "path clear",
    tone: "go",
  };
}

module.exports = {
  analyzeObject,
  closingSpeed,
  obstacleSpeed,
  objectWidthCm,
  objectLengthCm,
  expectedSpeedKph,
};
