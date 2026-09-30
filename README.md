# MineGuard

Smart mine-vehicle safety & monitoring platform (SIH26007 — Safe and Efficient Operation of Mine Vehicles in Fog).

MineGuard is a **real-data-only** control room for a sensor truck: an Arduino Nano
with an ultrasonic distance sensor streams **actual measurements** to a Node.js
server over a serial (USB / Bluetooth) bridge, and the dashboard displays **only
what the hardware reports**.

> **Honesty rules (enforced in code and by the test suites):**
>
> - The application **never fabricates data**. There is no simulator, no random
>   generator, no mock fleet, no fake movement, no demo values.
> - If the hardware is silent the app shows **Disconnected / No data / N/A** —
>   it never substitutes a plausible number.
> - This rig has **no speed sensor** → Speed = `N/A — No speed sensor`.
>   TTC needs speed + distance → TTC = `N/A — Speed data unavailable`.
> - Fog intensity is a **PC control value (0–100)**, never a sensor reading.
>   **0–30% = fog-dependent logic OFF · 31–100% = fog-dependent logic ON.**
>
> Prototype thresholds are demo parameters, **not** real mine-safety limits.

## Structure

```
mineguard/
├── start.bat / stop.bat      # double-click launcher / stopper
├── launcher.bat / .ps1       # button window (start/stop, copy link)
├── start.js                  # starts server + serial bridge, opens browser
├── stop.ps1                  # stops launcher, bridge, server (4000)
├── MineGuard/                # Arduino firmware (folder name = sketch name)
│   ├── MineGuard.ino         #   vehicle controller (JSON telemetry, 57600)
│   └── Ssd1306Display.h      #   header-only OLED driver (Wire only, no libs)
├── server/
│   ├── ControlRoomServer.js  # real-data server: risk, events, WS, share links
│   ├── ArduinoBridge.js      # serial bridge: Arduino <-> server (the ONLY data path)
│   ├── Distance.js           # ultrasonic analytics: closing/obstacle speed, object size
│   ├── FogControlCheck.js    # suite: fog gate 0-30 OFF / 31-100 ON
│   ├── ShareLinkCheck.js     # suite: read-only share links, viewer command refusal
│   └── RealDataCheck.js      # suite: nothing is ever fabricated
├── dashboard/                # React/Vite control room (served from dist/)
│   └── src/components/       # MineBackdrop, TruckGraphics, View360, ObjectProfile, DriveTrain
├── data/                     # events.json, telemetry.csv, share token
└── SHARE-LINK.txt            # permanent read-only link (written on boot)
```

Every source file starts with a 2–3 line header saying what it is and why it
exists — built for expert review.

## Run it

**Double-click `start.bat`** — it starts the server (port 4000), starts the
serial bridge (auto-detects the Arduino's COM port and baud), waits for
health, and opens `http://localhost:4000`. `stop.bat` stops everything.

Manual mode (single port — the server serves the built dashboard itself):

```
cd server
npm install        # first run only
node ControlRoomServer.js   # server on :4000
node ArduinoBridge.js       # serial bridge (or: node ArduinoBridge.js COM3)
```

## Data path (the only way data enters the system)

```
Arduino Nano (HC-SR04 real distance)
      │  Bluetooth ONLY: paired HC-05 (auto-detected BT COM port, 9600)
      ▼
server/ArduinoBridge.js  -- Bluetooth-only (never a USB port), sniff 9600 then 57600
      │            ── parses telemetry, DROPS anything unknown
      │            ── POST /telemetry  (loopback only — remote devices can't inject)
      ▼
server/ControlRoomServer.js   ── link freshness (5 s), fog gate, risk from real data only
      │            ── events, CSV log (every 2 s) + Distance.js analytics
      ▼
WebSocket state  ──►  dashboard (operator)  +  /view/<token> (read-only viewers)
      │
      └── FOG <0-100>, MSG <text>, MOTOR FWD|REV <0-255> | MOTOR STOP ──► bridge ──► Arduino
```

### Expected data format from the Arduino

The bridge accepts **both** known dialects and rejects everything else:

**(A) TEXT — the sketch currently flashed on the rig's Nano:**

```
MineGuard Arduino Nano Ready
Distance: 144.7 cm | Fog: 0% | Fog Active: NO | Obstacle: SAFE
Distance: NO READING
```

- `Distance: <n> cm` → real ultrasonic reading (cm)
- `Distance: NO READING` → sensor got no echo → dashboard shows **No data**
- `Fog: <n>%` → the cab's applied fog value (echo)
- `Fog Active: YES|NO` → the cab's own fog gate state
- `Obstacle: SAFE|…` → the cab's own obstacle state

**(B) JSON — `arduino/MineGuard.ino` (optional, richer):**

```
{"vehicleId":"MG-01","obstacleDistance":73,"imu":0,"light":"GREEN",
 "buzzer":"SILENT","buzzerOn":0,"fog":0,"msgCount":0,"uptime":12}
```

Laptop → Arduino: `FOG <0-100>` · `MSG <text>` · `MOTOR FWD|REV <0-255> | MOTOR STOP`.

The bridge **never** sends speed or position — the rig measures neither.

## What the dashboard shows

| panel | source |
|---|---|
| **Team brand: MineGuard** (title bar + page title) | static |
| **AI ACTION ADVISORY — what the truck should do** (STOP / SLOW DOWN / PROCEED + steps) | generated **only** from real link state, real distance and the fog gate |
| Arduino / Bluetooth status (CONNECTED · DISCONNECTED, port, baud, age) | telemetry freshness + bridge heartbeat |
| Real ultrasonic distance (cm / m) or **No data** | `Distance:` line |
| Obstacle state — **> 40 cm SAFE · 15–40 cm CAUTION · < 15 cm DANGER** (fog widens the bands) | distance vs fog-gated thresholds |
| `CAB REPORTS: …` chip | the cab's own `Obstacle:` state |
| **SIMULATION — stationary truck + big rock** | rock sits at the **real** ultrasonic distance (echo 20 cm → rock at 20 cm); auto-range view, red/yellow/green zones, fog overlay while the PC fog control is >30 %; **no echo → no rock**, the stage says "No data" |
| **360° VEHICLE VIEW** — drag-to-orbit + FRONT/SIDE/REAR buttons | the live beam is painted **only on the truck's nose** (the one real sensor); other angles honestly read "NO SENSOR"; FRONT/SIDE show the rock at the real distance |
| **OBJECT PROFILE — length · width · breadth** | depth = exact live range; closing speed = Δd/Δt over real echoes; obstacle speed **only when the truck is known stationary**; width/length from dwell × speed; height = N/A with the reason — every null explained |
| **DRIVETRAIN — motor · battery · speed** | motor FWD/REV/STOP + throttle (operator only), commanded vs **reported** state; battery volts from the firmware's ADC; vehicle speed = honest N/A (free wheels, no encoder) |
| **AI EXPECTED SPEED** | rules-based recommendation (0 STOP / ≤5 creep / ≤20, ≤10 in fog) — labelled advice, never a measurement |
| **Message to truck → OLED** | admin text (and AI advisory headlines) go over Bluetooth to the cab's OLED; delivery receipt via the firmware's `msgCount` |
| Ultrasonic outputs strip: object within 40 cm, distance, session min/max, echoes / NO-READING counts, last-30-echo sparkline | accumulated real echoes |
| Fog intensity slider 0–100 + LOGIC ON/OFF (>30) — **below the gate no fog warning is shown anywhere** | **PC control value** |
| Fog applied by Arduino + cab's own gate | `Fog:` / `Fog Active:` echo |
| Status LED (traffic-light mimic) | firmware `LED:`/light field if reported, otherwise **mirrors the cab-reported state** (labelled as derived) |
| Buzzer | firmware `Buzzer:`/buzzerOn if reported, otherwise **derived from the cab's warning state** (labelled) |
| Risk level + "Why this risk level" factors | distance + link freshness + fog gate only |
| Speed / TTC | always the honest N/A text |
| Last real data timestamp | last packet time |
| Alerts (real observations only) | OBSTACLE_WARNING, COMMUNICATION_LOST, FOG gate changes, DANGER_RISK, messages |

**Fog rule:** thresholds use the project's zones widened by fog —
`caution = 40 + floor(gate·60/100)`, `danger = 15 + floor(gate·40/100)`,
where `gate = intensity` only when **intensity > 30**, else `0`
(0/20/30% → 40/15 cm · 31% → 58/27 · 65% → 79/41 · 100% → 100/55).
At or below the gate there is **no fog line in the risk factors and no fog
instruction in the AI advisory**.

**Mobile:** the page carries `viewport width=device-width` and responsive
breakpoints at 980/760/480 px, so the operator page *and* the read-only
share link lay out correctly on phones.

## Physical rig (current wiring — matches MineGuard.ino)

| part | pins |
|---|---|
| HC-SR04 ultrasonic | TRIG → D9, ECHO → D10, VCC → 5V, GND → GND |
| Green LED | D4 (220 Ω to GND) |
| Yellow LED | D5 (220 Ω to GND) |
| Red LED | D6 (220 Ω to GND) |
| Buzzer | + → D7 (100 Ω for a passive piezo), − → GND |
| HC-05 Bluetooth | HC-05 TX → D2 (Arduino RX), HC-05 RX → D3 (Arduino TX, 1k/2k divider) |
| LED | built-in D13 = firmware heartbeat |
| OLED SSD1306 (new, not wired yet) | SDA → A4, SCL → A5 (I2C, same bus as MPU6050) |
| Motor driver (new, wiring assumed) | ENA → D11 (PWM), IN1 → D12, IN2 → D8 (L298N/DRV8833 style) |
| Battery pack (new, divider assumed) | pack → 1:1 resistor divider → A0 |
| Wheels (new) | free-rolling — **no speed sensor**, so vehicle speed stays N/A |

`MineGuard/MineGuard.ino` compiles clean for Nano (`arduino-cli`, 70% flash,
53% RAM) and adds: median-of-3 ranging, fog-scaled margins with the strict
>30 gate, green/yellow/red traffic light, reported `light`/`buzzer`/`buzzerOn`
fields, `MSG` emergency text with a `msgCount` delivery receipt, `FOG` command
handling, **OLED cab screen** (header-only `Ssd1306Display.h`, degrades silently
when no display is fitted), **motor drive** (`MOTOR FWD|REV <0-255> / STOP`,
boot = STOP) and **battery volts** on A0. Telemetry gains `motor`, `motorPwm`,
`batteryV`. **Compiled but NOT flashed** — the rig still runs the older text
sketch until you upload it (Arduino IDE → MineGuard folder → Nano → Upload).

## Honest hardware status (verified on this machine)

Verified by direct test — not assumed:

- ✅ **COM3 (FTDI USB serial) delivers real telemetry** at **9600 baud**
  (auto-sniffed): boot banner + live distances (`163.6`, `162.3`, `162.7`,
  `183.5`, `162.9` cm …) interleaved with honest `NO READING` when the sensor
  gets no echo.
- ✅ The dashboard shows that stream live: LINK CONNECTED, distance updating
  (or **No data** during `NO READING`), risk computed from the reading only.
- ⚠️ **The flashed sketch ignores `FOG` commands** (tested: `FOG 65`,
  `Fog: 65`, `fog 65`, `FOG=65` all leave it echoing `Fog: 0%`). PC-side fog
  control (slider → thresholds → risk) works; the cab does not yet apply it.
  Flashing `MineGuard.ino` enables cab-side FOG/MSG/LED reporting.
- ⚠️ **No Bluetooth COM port is paired right now** — Windows shows only the
  FTDI USB port. Pair the HC-05 ("Standard Serial over Bluetooth link (COMn)")
  and the bridge picks it up automatically at 9600.
- ⚠️ The flashed sketch sends **no `msgCount`**, so an emergency message shows
  `⏳ sending` (no receipt exists — nothing is faked). `MineGuard.ino`
  provides the receipt.
- ⚠️ LED/buzzer state is `not reported` — the flashed sketch doesn't send it.

## Share a read-only link (permanent)

- **This machine (full control):** `http://localhost:4000/`
- **Everyone else (view only):** `http://<host>.local:4000/view/<token>`
  (permanent — hostname + persistent token; IP fallback printed too)

The link is printed at boot, saved to **`SHARE-LINK.txt`**, and copied by the
dashboard's **🔗 Share view-only** button (`GET /api/share`). Viewers receive
live state — including the honest N/A text — but no controls render, and every
command on their WebSocket is refused server-side (`{"type":"denied"}`).
`POST /telemetry` and `POST /bridge` are loopback-only: a share-link holder
cannot inject sensor data. Token lives in `data/share-token.txt` (delete to
rotate). Devices must be on the same Wi-Fi (`.local` resolves via mDNS).

**Launcher buttons (`launcher.bat`):** ▶ Start / ■ Stop · 🌐 Control room ·
🔗 Copy link / 📱 Open share link · 📁 Open SHARE-LINK.txt.

### Pairing the HC-05 (battery + Bluetooth power)

The rig now runs on battery with the HC-05 as the data link (no USB cable):
1. Power the Arduino (battery) — the HC-05 LED blinks.
2. Windows → **Settings → Bluetooth & devices → Add device → Bluetooth**.
3. Select **HC-05**, enter the PIN **1234** (or 0000).
4. Windows creates a COM port ("Standard Serial over Bluetooth link (COMn)").
5. The bridge **auto-detects it** (prefers Bluetooth ports) and connects at
   9600 — the dashboard flips to `LINK: CONNECTED` within seconds. No restart.

### Why the browser says "Not secure"

Plain HTTP on your own LAN — no logins, no passwords, no personal data, no
cookies. A self-signed certificate would trigger a full-page red warning
(worse than the grey tag); public CAs don't issue certificates for `.local`
names or private IPs. A real deployment would run behind the mine's
intranet/VPN with TLS at the gateway.

## Tests (98 checks — run with the serial bridge stopped for determinism)

```
cd server
node FogControlCheck.js    # 15 checks — fog gate honesty (0/20/30 OFF, 31/65/100 ON)
node ShareLinkCheck.js     # 14 checks — share links, viewer command refusal
node RealDataCheck.js      # 69 checks — nothing fabricated, ingest, staleness, parser,
                           #   Distance.js math, object/AI-speed/drivetrain honesty
```

`realcheck` proves: sim-era payload fields are gone; speed/TTC are always
null + exact N/A text; bogus `speed/x/y/heading` posts are ignored; risk comes
from distance + link + fog gate only; stale stream → Disconnected with the
distance hidden; `NO READING` → link alive but risk `NO DATA` (never SAFE);
the parser refuses foreign lines and never forwards speed; the message
receipt happens only via a rising `msgCount`.

## Protocol

WebSocket `ws://localhost:4000` — server pushes `{ type: "state", ... }` at 2 Hz.

| client → server message | effect |
|---|---|
| `{type:"setFogIntensity", value:0..100}` | PC fog control (gate derived: >30 = ON) |
| `{type:"ack", eventId}` | acknowledge an alert |
| `{type:"truckMessage", vehicleId, text}` | emergency text to the cab (→ OLED); empty `text` clears |
| `{type:"setMotor", dir:"FWD"|"REV"|"OFF", pwm:0..255}` | drive command; the bridge pushes `MOTOR …` to the truck |

Payload highlights: top level `fogIntensity`, `fogActive`, `fogGatePct`,
`thresholds`, `bridge` (port/state), `events`; `device` holds `link`,
`linkDetail`, `lastDataAt`, `dataAgeMs`, `distanceCm`, `obstacleState`,
`obstacleReported`, `light`, `buzzer`, `fogReported`, `fogActiveReported`,
`imu`, `speed: null` + `speedText`, `ttc: null` + `ttcText`, `truckMessage`,
`risk {level, score, factors}`, `stateColor`.

Events (real only): `OBSTACLE_WARNING`, `COMMUNICATION_LOST`, `DANGER_RISK`,
`FOG_MODE_ENABLED/DISABLED`, `TRUCK_MESSAGE`, `TRUCK_MESSAGE_DELIVERED`,
`TRUCK_MESSAGE_CLEARED`.

Unknown/sim-era message types (`sim`, `addObstacle`, `moveObstacle`,
`clearEStop`, `setFog`, `pause…`) are silently ignored — nothing implements
them any more.

## Status

1. ✅ Project setup · dashboard · server · risk system
2. ✅ Arduino firmware (`MineGuard.ino`, compiles Nano 70%/53%, JSON telemetry)
3. ✅ Bidirectional bridge (auto-baud, both telemetry dialects, FOG/MSG/MOTOR out)
4. ✅ Real-data dashboard (no simulator anywhere)
5. ✅ Read-only permanent share links
6. ✅ **Live hardware verified on COM3 (9600): real distances end-to-end**
7. ✅ 360° vehicle view · object profile (L/W/B) · drivetrain · AI expected speed
8. ✅ GitHub hosting: public read-only page + private interactive control link
9. ⬜ Cab-side FOG/MSG/LED/OLED/motor/battery — flash `MineGuard.ino` (compiled, not flashed)
10. ⬜ HC-05 Bluetooth pairing (Windows COM port) — bridge ready, auto-connects at 9600
11. ⬜ Speed/TTC — needs a real speed source (wheel encoder), then code can change

## Hosting (GitHub) — 24/7 online

- **Repository:** https://github.com/shahdivy67-cell/mineguard (public; source of truth for server, bridge, dashboard, firmware and the honesty test suites)
- **Always-online read-only dashboard:** https://shahdivy67-cell.github.io/mineguard/ — the root URL instantly redirects to the **uninteractable** view link (`/view/BRVmiLzctt5y/`), so any link you share can be watched but never controlled. Rebuilt and republished automatically by `.github/workflows/pages.yml` on every push to `main`.
- **Private interactive control room:** https://shahdivy67-cell.github.io/mineguard/control/bae479c5a10840f587c9b845b8b980eb/ — secret path (GitHub Actions secret `CONTROL_PATH`, not in git history, `noindex`); every other path renders read-only. Controls activate once a live server is wired (`VITE_API_BASE`).
- **Honest by design on static hosting:** with no live server configured the page says exactly that — *"Static demo page — no live MineGuard server configured. All values stay honest: No data."* It never invents distances, obstacles or TTC.
- **Privacy:** `data/` (all telemetry), `SHARE-LINK.txt` (share token), `node_modules/`, build output and PID files are gitignored — sensor data and tokens never leave your machine via Git.
- **Want live Arduino data on the public page?** GitHub cannot plug into a serial port — the bridge must keep running on the PC the Arduino is connected to. Expose that server over public HTTPS (e.g. a free Cloudflare Tunnel) and set the repository secret `VITE_API_BASE` to its URL; the next push rebuilds the page so it feeds from the real rig 24/7.
