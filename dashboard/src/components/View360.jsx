/**
 * View360.jsx — 360° view of the real 3D truck.
 *
 * Drag to orbit around the truck, scroll to zoom; FRONT / SIDE / REAR /
 * LEFT / TOP buttons snap the camera. The live ultrasonic beam and the rock
 * appear only on the truck's nose (the one real sensor) and only while a
 * live echo exists; the caption states that the sides and rear carry no
 * sensor. Real-data rule: no echo → no rock, no beam, honest "No data".
 */
import { useRef } from "react";
import TruckScene3D from "./TruckScene3D.jsx";

const PRESETS = [
  { id: "front", label: "FRONT" },
  { id: "side", label: "SIDE" },
  { id: "rear", label: "REAR" },
  { id: "left", label: "LEFT" },
  { id: "top", label: "TOP" },
];

export default function View360({ distance, linkOk, caution, danger, obstacleState, fogActive, fogIntensity }) {
  const controllerRef = useRef(null);
  const hasData = linkOk && distance != null;
  const viewMax = hasData ? Math.max(120, Math.ceil((distance + 20) / 50) * 50) : 120;
  const badge = (obstacleState || "NO DATA").toLowerCase().replace(/\s+/g, "");
  return (
    <div className="v360">
      <div className="panel-title">
        360° VEHICLE VIEW — 3D MODEL
        <span className="muted">drag to orbit · scroll to zoom · live echo paints only the front</span>
        <span className={`state-badge ${hasData ? badge : "nodata"}`}>
          {hasData ? obstacleState : "NO DATA"}
        </span>
      </div>

      <div className="v360-modes">
        {PRESETS.map((p) => (
          <button key={p.id} className="btn btn-small" onClick={() => controllerRef.current?.setCameraPreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="v360-stage">
        <TruckScene3D
          mode="orbit"
          controllerRef={controllerRef}
          distance={hasData ? distance : null}
          caution={caution}
          danger={danger}
          viewMax={viewMax}
          fogActive={fogActive}
          fogIntensity={fogIntensity}
        />
        {!hasData && <div className="sim-nodata">No data — the live echo paints the front sector</div>}
      </div>

      <div className="muted v360-foot">
        The ultrasonic (cyan dot on the front bumper) is the only sensor — the sides and rear have none.
        Zones: red &lt; {danger} cm · yellow {danger}–{caution} cm · green beyond {caution} cm
        {hasData ? ` · rock at ${Math.round(distance)} cm` : ""}
        {fogActive ? ` · fog ${fogIntensity}% — real distance haze thickening` : ""}
      </div>
    </div>
  );
}
