/**
 * View360.jsx — 360° vehicle view (drag-to-orbit + angle buttons).
 *
 * ORBIT mode: the truck sits centre-stage and the world rotates around it —
 * drag (or the FRONT/RIGHT/REAR/LEFT buttons) to look around the vehicle.
 * The LIVE ultrasonic beam is painted only on the truck's nose (the one real
 * sensor); the other three sides honestly read "NO SENSOR".
 *
 * FRONT / SIDE / REAR modes: elevation drawings of the real toy truck. FRONT
 * and SIDE show the live beam and the rock at the real distance; REAR shows
 * the tailgate and states that no sensor exists on that side.
 *
 * Real-data rule: the beam length and the rock position come ONLY from the
 * live echo. No echo -> no beam, no rock, honest "No data".
 */
import { useRef, useState } from "react";
import MineBackdrop from "./MineBackdrop.jsx";
import { TruckTop, TruckSide, TruckFront, TruckRear } from "./TruckGraphics.jsx";

const MODES = [
  { id: "orbit", label: "ORBIT" },
  { id: "front", label: "FRONT" },
  { id: "side", label: "SIDE" },
  { id: "rear", label: "REAR" },
];

export default function View360({ distance, linkOk, caution, danger, obstacleState }) {
  const [bearing, setBearing] = useState(0); // camera angle: 0 = front
  const [mode, setMode] = useState("orbit");
  const dragRef = useRef(null);

  const hasData = linkOk && distance != null;
  const viewMax = hasData ? Math.max(120, Math.ceil((distance + 20) / 50) * 50) : 120;
  const pct = (cm) => Math.min(100, (cm / viewMax) * 100);
  const rockPct = hasData ? pct(distance) : 0;
  const badge = (obstacleState || "NO DATA").toLowerCase().replace(/\s+/g, "");

  const snap = (deg) => setBearing(((deg % 360) + 360) % 360);
  const onPointerDown = (e) => {
    dragRef.current = { x: e.clientX, b: bearing };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    setBearing((dragRef.current.b + dx * 0.6 + 360) % 360);
  };
  const onPointerUp = () => (dragRef.current = null);

  return (
    <div className="v360">
      <div className="panel-title">
        360° VEHICLE VIEW
        <span className="muted">drag to orbit · live echo paints only the front sector</span>
        <span className={`state-badge ${hasData ? badge : "nodata"}`}>
          {hasData ? obstacleState : "NO DATA"}
        </span>
      </div>

      <div className="v360-modes">
        {MODES.map((m) => (
          <button key={m.id} className={`btn btn-small ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "orbit" && (
        <div
          className="v360-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          title="Drag to orbit around the truck"
        >
          {/* rotating world */}
          <div className="v360-world" style={{ transform: `rotate(${-bearing}deg)` }}>
            <MineBackdrop className="v360-ground" />
            {/* compass ticks ride with the world */}
            <span className="v360-compass n">N·FRONT</span>
            <span className="v360-compass e">E</span>
            <span className="v360-compass s">S</span>
            <span className="v360-compass w">W</span>
            {/* the rock rides with the world at the REAL distance */}
            {hasData && (
              <div className="v360-rock" style={{ top: `${100 - rockPct}%` }}>
                <span className="rock-icon">🪨</span>
                <span className="sim-rock-label">BIG ROCK · {Math.round(distance)} cm</span>
              </div>
            )}
          </div>
          {/* fixed truck + live beam (the sensor is on the nose) */}
          <div className="v360-truck">
            <TruckTop />
          </div>
          {hasData && <div className="v360-beam" style={{ height: `${rockPct}%` }} />}
          <span className="v360-nosensor left">NO SENSOR</span>
          <span className="v360-nosensor right">NO SENSOR</span>
          <span className="v360-nosensor bottom">NO SENSOR</span>
          {!hasData && <div className="sim-nodata">No data — the live echo paints the front sector</div>}
        </div>
      )}

      {mode === "orbit" && (
        <div className="v360-snap">
          <span className="muted">CAMERA {Math.round(bearing)}°</span>
          <button className="btn btn-small" onClick={() => snap(0)}>FRONT 0°</button>
          <button className="btn btn-small" onClick={() => snap(90)}>RIGHT 90°</button>
          <button className="btn btn-small" onClick={() => snap(180)}>REAR 180°</button>
          <button className="btn btn-small" onClick={() => snap(270)}>LEFT 270°</button>
        </div>
      )}

      {mode === "front" && (
        <div className="v360-elev">
          <MineBackdrop className="v360-ground" />
          <TruckFront className="v360-elev-svg" />
          {hasData && (
            <div className="v360-waves" title={`live beam ${Math.round(distance)} cm`}>
              <i /><i /><i />
              <span>beam {Math.round(distance)} cm</span>
            </div>
          )}
          <div className="muted">FRONT — the ultrasonic (cyan dot) looks forward{hasData ? ` · rock at ${Math.round(distance)} cm` : ""}</div>
        </div>
      )}

      {mode === "side" && (
        <div className="v360-elev">
          <TruckSide className="v360-elev-svg" />
          {hasData && (
            <div className="v360-elev-beam" style={{ width: `${rockPct}%` }}>
              <span>beam {Math.round(distance)} cm</span>
            </div>
          )}
          <div className="muted">SIDE — sensor on the front bumper{hasData ? ` · rock at ${Math.round(distance)} cm` : ""}</div>
        </div>
      )}

      {mode === "rear" && (
        <div className="v360-elev">
          <TruckRear className="v360-elev-svg" />
          <div className="muted">REAR — tailgate · no sensor on this side</div>
        </div>
      )}

      <div className="muted v360-foot">
        Zones: red &lt; {danger} cm · yellow {danger}–{caution} cm · green beyond {caution} cm · view to {viewMax} cm
      </div>
    </div>
  );
}
