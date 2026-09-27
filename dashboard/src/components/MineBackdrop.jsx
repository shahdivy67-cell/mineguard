/**
 * MineBackdrop.jsx — the deep open-pit mine scene (pure SVG, no logic).
 *
 * A hand-drawn vector scene of a deep coal/iron open-pit: terraced benches
 * stepping down into the pit, a switchback haul road, dark coal-seam stripes
 * in the walls, dust haze at the bottom and a working face with a shovel
 * and a haul truck for scale. Used as the backdrop of the simulation and
 * 360° views so the dashboard reads as a real mine control room.
 *
 * Why SVG and not a photo: the scene must render identically offline, on
 * the GitHub Pages build and on any screen — no external image, no licence,
 * no broken link. It is a stylised engineering illustration, not a photo.
 */
export default function MineBackdrop({ className = "" }) {
  return (
    <svg
      className={`mine-backdrop ${className}`}
      viewBox="0 0 800 300"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mb-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b3442" />
          <stop offset="0.55" stopColor="#3a4150" />
          <stop offset="1" stopColor="#4a4a48" />
        </linearGradient>
        <linearGradient id="mb-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5c564c" />
          <stop offset="1" stopColor="#3a352e" />
        </linearGradient>
        <linearGradient id="mb-wall2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4c463d" />
          <stop offset="1" stopColor="#2e2a25" />
        </linearGradient>
        <linearGradient id="mb-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#33302b" />
          <stop offset="1" stopColor="#1c1a17" />
        </linearGradient>
        <linearGradient id="mb-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8a8378" stopOpacity="0" />
          <stop offset="1" stopColor="#8a8378" stopOpacity="0.35" />
        </linearGradient>
      </defs>

      {/* sky */}
      <rect x="0" y="0" width="800" height="300" fill="url(#mb-sky)" />
      {/* distant rim */}
      <path d="M0 78 L60 66 L120 74 L190 60 L260 72 L330 62 L400 74 L470 64 L540 76 L610 66 L680 76 L740 68 L800 78 L800 0 L0 0 Z" fill="#45413a" />
      {/* upper benches (far wall) */}
      <path d="M0 96 L800 96 L800 118 L0 124 Z" fill="url(#mb-wall)" />
      <path d="M0 118 L800 118 L800 124 L0 130 Z" fill="#221f1b" /> {/* seam */}
      <path d="M0 130 L800 124 L800 152 L0 158 Z" fill="url(#mb-wall2)" />
      <path d="M0 152 L800 146 L800 158 L0 164 Z" fill="#1d1a16" /> {/* seam */}
      {/* mid benches */}
      <path d="M0 164 L800 158 L800 196 L0 202 Z" fill="url(#mb-wall)" />
      <path d="M0 196 L800 190 L800 202 L0 208 Z" fill="#221f1b" /> {/* seam */}
      <path d="M0 208 L800 202 L800 240 L0 246 Z" fill="url(#mb-wall2)" />
      {/* pit floor */}
      <path d="M0 246 L800 240 L800 300 L0 300 Z" fill="url(#mb-floor)" />

      {/* haul road: switchback from rim down to the floor */}
      <path
        d="M640 96 L640 130 L520 130 L520 164 L660 164 L660 202 L540 202 L540 240 L430 240"
        fill="none"
        stroke="#57534b"
        strokeWidth="14"
        strokeLinejoin="round"
      />
      <path
        d="M640 96 L640 130 L520 130 L520 164 L660 164 L660 202 L540 202 L540 240 L430 240"
        fill="none"
        stroke="#6b665c"
        strokeWidth="2"
        strokeDasharray="10 12"
      />

      {/* bench detail: rock benches + dump piles */}
      <g fill="#4a453c">
        <path d="M40 100 l14 -6 12 6 -12 6 Z" />
        <path d="M150 104 l18 -7 14 7 -14 7 Z" />
        <path d="M300 100 l16 -6 12 6 -12 6 Z" />
        <path d="M470 106 l18 -7 14 7 -14 7 Z" />
        <path d="M700 102 l16 -6 12 6 -12 6 Z" />
        <path d="M120 168 l16 -6 12 6 -12 6 Z" />
        <path d="M380 172 l18 -7 14 7 -14 7 Z" />
        <path d="M720 170 l16 -6 12 6 -12 6 Z" />
        <path d="M200 212 l18 -7 14 7 -14 7 Z" />
        <path d="M480 216 l16 -6 12 6 -12 6 Z" />
      </g>

      {/* working face: shovel + haul truck silhouettes on the floor */}
      <g fill="#14120f">
        {/* electric rope shovel */}
        <rect x="150" y="252" width="34" height="10" rx="2" />
        <rect x="158" y="238" width="18" height="14" rx="2" />
        <path d="M176 244 L214 226 L216 230 L180 248 Z" />
        <circle cx="216" cy="228" r="4" />
        {/* haul truck */}
        <rect x="250" y="246" width="46" height="14" rx="2" />
        <path d="M250 246 L250 238 L282 238 L282 246 Z" />
        <circle cx="262" cy="262" r="5" />
        <circle cx="286" cy="262" r="5" />
      </g>

      {/* dust haze over the pit floor */}
      <rect x="0" y="230" width="800" height="70" fill="url(#mb-haze)" />
    </svg>
  );
}
