/**
 * MineGuard FOG GATE check — real-data server (no simulator anywhere).
 *   node fogcheck.js        (server up on :4000, serial bridge STOPPED)
 *
 * Fog intensity is a PC CONTROL value 0-100 — never a sensor reading.
 * Strict rule: 0-30% = fog-dependent logic OFF (base thresholds),
 *              31-100% = fog-dependent logic ON (margins widen).
 * Thresholds must match the firmware's integer maths exactly:
 *   caution = 40 + floor(gate*60/100),  danger = 15 + floor(gate*40/100)
 *             where gate = intensity when intensity > 30, else 0.
 *
 * Also asserts data/events.json still parses (corruption regression).
 */
const WS_URL = "ws://localhost:4000";
const { readFileSync } = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const WebSocket = require("ws");
  const ws = new WebSocket(WS_URL);
  let state = null;
  ws.on("message", (d) => {
    try {
      const m = JSON.parse(d.toString());
      if (m.type === "state") state = m;
    } catch {}
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });

  const setFog = (v) => ws.send(JSON.stringify({ type: "setFogIntensity", value: v }));
  const settle = async (ms = 700) => {
    await wait(ms);
    return state;
  };

  const expect = async (pct, active, caution, danger) => {
    setFog(pct);
    const s = await settle();
    check(
      `fog ${pct}% -> logic ${active ? "ON" : "OFF"}, thresholds ${caution}/${danger} cm`,
      s &&
        s.fogIntensity === pct &&
        s.fogActive === active &&
        s.thresholds.obstacleCautionCm === caution &&
        s.thresholds.obstacleDangerCm === danger,
      s && `got ${s.fogIntensity}% ${s.fogActive ? "ON" : "OFF"} ${s.thresholds.obstacleCautionCm}/${s.thresholds.obstacleDangerCm}`
    );
    return s;
  };

  try {
    // --- below / at the gate: fog-dependent logic strictly OFF -------------
    //     thresholds: caution 40 / danger 15 (project zone rule), widened by
    //     fog only above the gate: +floor(gate*60/100) / +floor(gate*40/100)
    await expect(0, false, 40, 15);
    await expect(20, false, 40, 15);
    await expect(30, false, 40, 15);
    // --- just above the gate and up: strictly ON, firmware-identical maths --
    await expect(31, true, 58, 27); // 40+floor(18.6) / 15+floor(12.4)
    await expect(65, true, 79, 41);
    await expect(100, true, 100, 55);

    // --- honesty: fog is a CONTROL value, not a sensor ----------------------
    setFog(45);
    const s = await settle();
    check(
      "payload has no fogMode/fog-sensor fields (fog is a PC control value)",
      s && !("fogMode" in s) && !("fogSensor" in s) && s.fogIntensity === 45,
      s && `fogIntensity=${s.fogIntensity}`
    );
    check(
      "device.fogReported is the Arduino's ack (number or null), not a fog sensor",
      s && (s.device.fogReported === null || typeof s.device.fogReported === "number"),
      s && `fogReported=${JSON.stringify(s.device.fogReported)}`
    );
    check(
      "gate documented in payload (fogGatePct = 30)",
      s && s.fogGatePct === 30,
      ""
    );
    // --- fog mentions exist ONLY while the control is above the gate -------
    check(
      "above the gate: AI advice includes the fog instruction (45%)",
      s && s.device.advice && s.device.advice.lines.some((l) => l.includes("Fog 45%")),
      s && JSON.stringify(s.device.advice && s.device.advice.lines)
    );
    check(
      "above the gate: risk factors include the fog line",
      s && s.device.risk.factors.some((f) => f.label.includes("Fog-dependent logic ON")),
      ""
    );
    setFog(20);
    const below = await settle();
    check(
      "below the gate (20%): NO fog line in the risk factors",
      below && !below.device.risk.factors.some((f) => f.label.includes("Fog-dependent")),
      below && JSON.stringify(below.device.risk.factors.map((f) => f.label))
    );
    check(
      "below the gate (20%): AI advice gives NO fog instruction",
      below && below.device.advice && !below.device.advice.lines.some((l) => l.includes("Fog ")),
      below && JSON.stringify(below.device.advice && below.device.advice.lines)
    );

    // --- restore fog OFF ----------------------------------------------------
    setFog(0);
    const back = await settle();
    check("fog restored to 0% (logic OFF)", back && back.fogIntensity === 0 && back.fogActive === false, "");

    // --- data files stay valid ---------------------------------------------
    const events = JSON.parse(
      readFileSync(path.join(__dirname, "..", "data", "events.json"), "utf8")
    );
    check("data/events.json parses", Array.isArray(events), `${events.length} events`);
  } catch (e) {
    fail++;
    console.log(`FAIL  unexpected error — ${e.message}`);
  } finally {
    ws.close();
  }

  console.log(`\nfogcheck: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("fogcheck error:", e.message);
  process.exit(1);
});
