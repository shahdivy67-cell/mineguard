/**
 * SimView.jsx — the proximity simulation in real 3D.
 *
 * A real-sized 3D mining truck (Three.js, TruckScene3D) on a haul road. The
 * rock is placed AHEAD of the truck's front bumper at the REAL ultrasonic
 * distance, the cyan beam shows the live echo, and the road carries the
 * fog-gated red/yellow/green zone strips. No echo → no rock, no beam — the
 * stage honestly says "No data". Schematic scale: the labels carry the
 * exact centimetres.
 */
import TruckScene3D from "./TruckScene3D.jsx";

export default function SimView({ distance, linkOk, caution, danger, obstacleState, fogActive, fogIntensity }) {
  const hasData = linkOk && distance != null;
  // Auto-range view (min 120 cm so the fog-widened bands always fit):
  const viewMax = hasData ? Math.max(120, Math.ceil((distance + 20) / 50) * 50) : 120;
  const badge = (obstacleState || "NO DATA").toLowerCase().replace(/\s+/g, "");
  return (
    <div className="sim">
      <div className="sim-head">
        <b>SIMULATION — 3D TRUCK + REAL OBSTACLE</b>
        <span className="muted">real-sized 3D model · rock placed at the live ultrasonic distance</span>
        <span className={`state-badge ${hasData ? badge : "nodata"}`}>
          {hasData ? obstacleState : "NO DATA"}
        </span>
      </div>
      <div className="sim-stage">
        <TruckScene3D
          mode="sim"
          distance={hasData ? distance : null}
          caution={caution}
          danger={danger}
          viewMax={viewMax}
          fogActive={fogActive}
          fogIntensity={fogIntensity}
        />
        {!hasData && (
          <div className="sim-nodata">
            {linkOk ? "NO READING — echo lost, rock position unknown" : "No data — simulation needs a live echo"}
          </div>
        )}
      </div>
      <div className="muted sim-foot">
        Zones: red &lt; {danger} cm · yellow {danger}–{caution} cm · green beyond {caution} cm · view to {viewMax} cm (schematic scale — labels carry the real cm)
        {fogActive ? ` · white haze = PC fog control ${fogIntensity}% (logic ON)` : ""}
      </div>
    </div>
  );
}
