/**
 * TruckGraphics.jsx — the real toy-truck illustrations (pure SVG, no logic).
 *
 * Four views of the same mining truck, drawn to consistent proportions:
 *   TruckTop   — plan view (what the ultrasonic "sees" from above)
 *   TruckSide  — profile (cab, dump bed, three axles, sonar on the bumper)
 *   TruckFront — head-on (grille, windshield, headlights, sonar centred)
 *   TruckRear  — tailgate (no sensor on this side — labelled in the 360 view)
 *
 * The ultrasonic sensor (TRIG D9 / ECHO D10) is drawn as the cyan dot on the
 * FRONT bumper in every view that can see it — the graphics never show a
 * sensor that is not there.
 */

// Plan view — nose points RIGHT (forward). Wheels, cab, dump bed, sonar dot.
export function TruckTop({ className = "" }) {
  return (
    <svg viewBox="0 0 62 64" className={`truck-top ${className}`} aria-label="Truck — top view">
      {/* wheels (3 axles) */}
      <g fill="#14161c">
        <rect x="5" y="3" width="12" height="7" rx="2" />
        <rect x="5" y="54" width="12" height="7" rx="2" />
        <rect x="21" y="3" width="12" height="7" rx="2" />
        <rect x="21" y="54" width="12" height="7" rx="2" />
        <rect x="43" y="3" width="12" height="7" rx="2" />
        <rect x="43" y="54" width="12" height="7" rx="2" />
      </g>
      <g fill="#3d434f">
        <circle cx="11" cy="6.5" r="2" /><circle cx="11" cy="57.5" r="2" />
        <circle cx="27" cy="6.5" r="2" /><circle cx="27" cy="57.5" r="2" />
        <circle cx="49" cy="6.5" r="2" /><circle cx="49" cy="57.5" r="2" />
      </g>
      {/* dump bed with ribs */}
      <rect x="3" y="9" width="34" height="46" rx="3" fill="#8f9aa8" stroke="#5f6875" strokeWidth="1.5" />
      <g stroke="#6d7683" strokeWidth="1">
        <line x1="11" y1="11" x2="11" y2="53" />
        <line x1="19" y1="11" x2="19" y2="53" />
        <line x1="27" y1="11" x2="27" y2="53" />
      </g>
      {/* cab */}
      <path d="M37 11 h14 a6 6 0 0 1 6 6 v30 a6 6 0 0 1 -6 6 h-14 z" fill="#e8a13a" stroke="#a8742a" strokeWidth="1.5" />
      <rect x="50.5" y="16" width="5.5" height="32" rx="2.5" fill="#bfe0f2" />
      {/* mirrors */}
      <rect x="46" y="5" width="4" height="3" rx="1" fill="#2c313a" />
      <rect x="46" y="56" width="4" height="3" rx="1" fill="#2c313a" />
      {/* headlights */}
      <rect x="52.5" y="12.5" width="4" height="6" rx="1.5" fill="#ffd76a" />
      <rect x="52.5" y="45.5" width="4" height="6" rx="1.5" fill="#ffd76a" />
      {/* ultrasonic sensor on the front bumper */}
      <circle cx="58.5" cy="32" r="2.8" fill="#40d0ff" stroke="#1b83b5" strokeWidth="1" />
    </svg>
  );
}

// Profile — nose points RIGHT. Cab + dump bed + 3 axles + sonar on the bumper.
export function TruckSide({ className = "" }) {
  return (
    <svg viewBox="0 0 200 92" className={`truck-side ${className}`} aria-label="Truck — side view">
      {/* ground shadow */}
      <ellipse cx="100" cy="86" rx="86" ry="4" fill="#000" opacity="0.35" />
      {/* dump bed */}
      <path d="M64 30 L150 30 L150 58 L64 58 Z" fill="#8f9aa8" stroke="#5f6875" strokeWidth="1.5" />
      <g stroke="#6d7683" strokeWidth="1">
        <line x1="76" y1="32" x2="76" y2="56" />
        <line x1="92" y1="32" x2="92" y2="56" />
        <line x1="108" y1="32" x2="108" y2="56" />
        <line x1="124" y1="32" x2="124" y2="56" />
        <line x1="140" y1="32" x2="140" y2="56" />
      </g>
      {/* cab */}
      <path d="M30 34 L64 34 L64 62 L30 62 Z" fill="#e8a13a" stroke="#a8742a" strokeWidth="1.5" />
      <path d="M36 38 L58 38 L58 50 L36 50 Z" fill="#bfe0f2" />
      <line x1="47" y1="38" x2="47" y2="50" stroke="#a8742a" strokeWidth="1" />
      {/* exhaust stack */}
      <rect x="60" y="18" width="4" height="16" rx="1" fill="#3d434f" />
      {/* front bumper + grille */}
      <rect x="22" y="52" width="10" height="10" rx="2" fill="#3d434f" />
      <rect x="24" y="40" width="6" height="12" rx="1" fill="#2c313a" />
      {/* headlight */}
      <rect x="23" y="44" width="4" height="4" rx="1" fill="#ffd76a" />
      {/* ultrasonic sensor on the front bumper */}
      <circle cx="27" cy="57" r="3" fill="#40d0ff" stroke="#1b83b5" strokeWidth="1" />
      {/* fuel tank */}
      <rect x="70" y="56" width="18" height="8" rx="2" fill="#5f6875" />
      {/* wheels: 1 front + 2 rear */}
      <g>
        <circle cx="40" cy="70" r="12" fill="#14161c" /><circle cx="40" cy="70" r="5" fill="#3d434f" />
        <circle cx="96" cy="70" r="12" fill="#14161c" /><circle cx="96" cy="70" r="5" fill="#3d434f" />
        <circle cx="128" cy="70" r="12" fill="#14161c" /><circle cx="128" cy="70" r="5" fill="#3d434f" />
      </g>
      {/* mudflaps */}
      <rect x="52" y="66" width="4" height="10" fill="#2c313a" />
      <rect x="140" y="66" width="4" height="10" fill="#2c313a" />
    </svg>
  );
}

// Head-on — grille, windshield, headlights, sonar centred on the bumper.
export function TruckFront({ className = "" }) {
  return (
    <svg viewBox="0 0 120 100" className={`truck-front ${className}`} aria-label="Truck — front view">
      <ellipse cx="60" cy="94" rx="52" ry="4" fill="#000" opacity="0.35" />
      {/* cab */}
      <rect x="26" y="18" width="68" height="46" rx="4" fill="#e8a13a" stroke="#a8742a" strokeWidth="1.5" />
      <rect x="34" y="24" width="52" height="20" rx="2" fill="#bfe0f2" />
      {/* grille */}
      <rect x="34" y="48" width="52" height="12" rx="2" fill="#2c313a" />
      <g stroke="#4a515c" strokeWidth="1.5">
        <line x1="40" y1="50" x2="40" y2="58" />
        <line x1="50" y1="50" x2="50" y2="58" />
        <line x1="60" y1="50" x2="60" y2="58" />
        <line x1="70" y1="50" x2="70" y2="58" />
        <line x1="80" y1="50" x2="80" y2="58" />
      </g>
      {/* headlights */}
      <rect x="28" y="44" width="8" height="6" rx="1.5" fill="#ffd76a" />
      <rect x="84" y="44" width="8" height="6" rx="1.5" fill="#ffd76a" />
      {/* bumper */}
      <rect x="22" y="62" width="76" height="10" rx="3" fill="#3d434f" />
      {/* ultrasonic sensor centred on the bumper */}
      <circle cx="60" cy="67" r="4" fill="#40d0ff" stroke="#1b83b5" strokeWidth="1" />
      {/* wheels peeking out */}
      <rect x="14" y="60" width="14" height="26" rx="4" fill="#14161c" />
      <rect x="92" y="60" width="14" height="26" rx="4" fill="#14161c" />
      {/* mirrors */}
      <rect x="18" y="26" width="6" height="10" rx="2" fill="#2c313a" />
      <rect x="96" y="26" width="6" height="10" rx="2" fill="#2c313a" />
    </svg>
  );
}

// Tailgate — no sensor on this side.
export function TruckRear({ className = "" }) {
  return (
    <svg viewBox="0 0 120 100" className={`truck-rear ${className}`} aria-label="Truck — rear view">
      <ellipse cx="60" cy="94" rx="52" ry="4" fill="#000" opacity="0.35" />
      {/* dump bed tailgate */}
      <rect x="24" y="16" width="72" height="52" rx="4" fill="#8f9aa8" stroke="#5f6875" strokeWidth="1.5" />
      <g stroke="#6d7683" strokeWidth="1.5">
        <line x1="38" y1="20" x2="38" y2="64" />
        <line x1="54" y1="20" x2="54" y2="64" />
        <line x1="70" y1="20" x2="70" y2="64" />
        <line x1="86" y1="20" x2="86" y2="64" />
      </g>
      {/* taillights */}
      <rect x="28" y="56" width="10" height="6" rx="1.5" fill="#e0503f" />
      <rect x="82" y="56" width="10" height="6" rx="1.5" fill="#e0503f" />
      {/* bumper */}
      <rect x="22" y="68" width="76" height="10" rx="3" fill="#3d434f" />
      {/* wheels */}
      <rect x="14" y="66" width="14" height="26" rx="4" fill="#14161c" />
      <rect x="92" y="66" width="14" height="26" rx="4" fill="#14161c" />
    </svg>
  );
}
