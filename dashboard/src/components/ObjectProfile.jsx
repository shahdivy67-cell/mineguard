/**
 * ObjectProfile.jsx — what the ultrasonic can REALLY say about the object.
 *
 * Six cells, every value from server/Distance.js (real echoes only):
 *   DEPTH        — the exact live range (the one true measurement)
 *   CLOSING SPEED — Δd/Δt over recent real echoes (relative, always real)
 *   OBSTACLE SPEED— only when the truck is KNOWN stationary (motor OFF);
 *                  with the truck moving and no speed sensor the two motions
 *                  cannot be separated -> N/A with the reason
 *   WIDTH/LENGTH — dwell × speed, only from a crossing / receding echo
 *   HEIGHT       — always N/A: one ultrasonic cannot measure height
 * Every N/A carries its reason verbatim — the panel never invents a number.
 */

function Cell({ label, value, note, tone }) {
  return (
    <div className={`obj-cell ${tone ? `obj-${tone}` : ""}`}>
      <span className="obj-label">{label}</span>
      <b className="obj-value">{value}</b>
      <span className="obj-note">{note}</span>
    </div>
  );
}

export default function ObjectProfile({ object, linkOk }) {
  const o = object || {};
  const nd = !linkOk || o.depthCm == null;
  return (
    <div className="obj-panel">
      <div className="panel-title">
        OBJECT PROFILE — length · width · breadth from the ultrasonic
        <span className="muted">single HC-SR04 — real values, honest N/A</span>
      </div>
      <div className="obj-grid">
        <Cell
          label="DEPTH (live range)"
          value={nd ? "No data" : `${Math.round(o.depthCm)} cm`}
          note={nd ? "no live echo" : "exact range from the echo"}
          tone={nd ? "nd" : "ok"}
        />
        <Cell
          label="CLOSING SPEED"
          value={o.closingKph != null ? `${o.closingKph} km/h` : "No data"}
          note={o.closingNote || "not enough echoes yet"}
          tone={o.closingKph == null ? "nd" : "ok"}
        />
        <Cell
          label="OBSTACLE SPEED"
          value={
            o.obstacleKph != null
              ? `${o.obstacleKph} km/h ${o.obstacleDirection === "approaching" ? "▲ approaching" : "▼ receding"}`
              : "N/A"
          }
          note={o.obstacleNote || "needs a measured closing speed"}
          tone={o.obstacleKph == null ? "nd" : "warn"}
        />
        <Cell
          label="WIDTH"
          value={o.widthCm != null ? `≈ ${o.widthCm} cm` : "N/A"}
          note={o.widthNote || "needs a crossing echo"}
          tone={o.widthCm == null ? "nd" : "ok"}
        />
        <Cell
          label="LENGTH"
          value={o.lengthCm != null ? `≈ ${o.lengthCm} cm` : "N/A"}
          note={o.lengthNote || "needs a receding echo"}
          tone={o.lengthCm == null ? "nd" : "ok"}
        />
        <Cell
          label="HEIGHT / BREADTH"
          value="N/A"
          note={o.heightNote || "a single ultrasonic cannot measure height"}
          tone="nd"
        />
      </div>
      <div className="muted">{o.basis || "computed from real echoes only — nothing estimated without data"}</div>
    </div>
  );
}
