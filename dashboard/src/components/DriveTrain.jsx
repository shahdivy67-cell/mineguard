/**
 * DriveTrain.jsx — motor drive · battery · vehicle speed · AI expected speed.
 *
 * Motor: the control room commands FWD/REV/STOP + throttle (0-255 PWM);
 * the bridge pushes "MOTOR …" over Bluetooth. The firmware's REPORTED
 * state comes back in telemetry — commanded and reported are shown
 * separately and never conflated.
 *
 * Battery: real volts from the firmware's ADC (assumed 1:1 divider),
 * mapped to a 2S LiPo percentage. Null until the firmware reports it.
 *
 * Vehicle speed: the wheels are free (no encoder) — the exact honest
 * text "N/A — No speed sensor" is always shown, next to the AI's
 * rules-based expected speed for the situation.
 */
import { useState } from "react";

export default function DriveTrain({ vehicle, aiSpeed, linkOk, onMotor, isViewer }) {
  const v = vehicle || {};
  const [pwm, setPwm] = useState(180);
  const cmd = v.motorCmd;
  const rep = v.motor;
  const ai = aiSpeed || {};

  return (
    <div className="drive-panel">
      <div className="panel-title">
        DRIVETRAIN — motor · battery · speed
        <span className="muted">commands go to the truck over Bluetooth</span>
      </div>

      <div className="drive-grid">
        <div className="drive-cell">
          <span className="obj-label">MOTOR COMMAND {isViewer ? "(view-only link — disabled)" : ""}</span>
          <div className="drive-btns">
            <button className="btn btn-small" disabled={isViewer} onClick={() => onMotor("FWD", pwm)}>▲ FWD</button>
            <button className="btn btn-small" disabled={isViewer} onClick={() => onMotor("OFF", 0)}>■ STOP</button>
            <button className="btn btn-small" disabled={isViewer} onClick={() => onMotor("REV", pwm)}>▼ REV</button>
          </div>
          <input
            type="range"
            min="0"
            max="255"
            value={pwm}
            disabled={isViewer}
            onChange={(e) => setPwm(Number(e.target.value))}
            className="drive-throttle"
            title={`throttle PWM ${pwm}`}
          />
          <span className="muted">throttle PWM {pwm}</span>
          <div className="drive-state">
            <div>
              <span className="obj-label">COMMANDED</span>
              <b>{cmd ? `${cmd.dir}${cmd.pwm ? ` @ ${cmd.pwm}` : ""}` : "—"}</b>
            </div>
            <div>
              <span className="obj-label">REPORTED BY TRUCK</span>
              <b className={rep ? "u-ok" : "u-nd"}>
                {rep ? `${rep.state}${rep.pwm ? ` @ ${rep.pwm}` : ""}` : linkOk ? "not reported" : "No data"}
              </b>
            </div>
          </div>
        </div>

        <div className="drive-cell">
          <span className="obj-label">BATTERY (2S LiPo)</span>
          {v.batteryV != null ? (
            <>
              <b className="obj-value">{v.batteryV.toFixed(2)} V</b>
              <div className="meter">
                <div
                  className={`meter-fill ${v.batteryPct < 25 ? "bad" : v.batteryPct < 50 ? "warn" : "ok"}`}
                  style={{ width: `${v.batteryPct}%` }}
                />
              </div>
              <span className="muted">{v.batteryPct}% · from the firmware's ADC</span>
            </>
          ) : (
            <b className="obj-value u-nd">No data</b>
          )}
          {v.batteryV == null && <span className="muted">the firmware reports Battery: once MineGuard.ino is flashed</span>}
        </div>

        <div className="drive-cell">
          <span className="obj-label">VEHICLE SPEED</span>
          <b className="obj-value u-nd">{v.speedText || "N/A — No speed sensor"}</b>
          <span className="muted">free wheels, no encoder — speed cannot be monitored</span>
        </div>

        <div className={`drive-cell ai-speed ai-${ai.tone || "stop"}`}>
          <span className="obj-label">AI EXPECTED SPEED</span>
          <b className="obj-value">{ai.label || "0 km/h — STOP"}</b>
          <span className="muted">{ai.reason || "no live data"}</span>
          <span className="muted">rules-based advice from live risk — not a measurement</span>
        </div>
      </div>
    </div>
  );
}
