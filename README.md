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
├── arduino/MineGuard.ino     # optional full firmware (JSON telemetry)
├── server/
│   ├── index.js              # real-data server: risk, events, WS, share links
│   ├── bridge.js             # serial bridge: Arduino <-> server (the ONLY data path)
│   ├── fogcheck.js           # suite: fog gate 0-30 OFF / 31-100 ON
│   ├── viewcheck.js          # suite: read-only share links
│   └── realcheck.js          # suite: nothing is ever fabricated
├── dashboard/                # React/Vite control room (served from dist/)
├── data/                     # events.json, telemetry.csv, share token
└── SHARE-LINK.txt            # permanent read-only link (written on boot)
```

## Run it

**Double-click `start.bat`** — it starts the server (port 4000), starts the
serial bridge (auto-detects the Arduino's COM port and baud), waits for
health, and opens `http://localhost:4000`. `stop.bat` stops everything.

Manual mode (single port — the server serves the built dashboard itself):

```
cd server
npm install        # first run only
node index.js      # server on :4000
node bridge.js     # serial bridge (or: node bridge.js COM3)
```

## Data path (the only way data enters the system)

```
Arduino Nano (HC-SR04 real distance)
      │  serial: USB or paired HC-05 Bluetooth (auto-detected COM port)
      ▼
server/bridge.js  ── auto-baud sniff (9600 first, then 57600)
      │            ── parses telemetry, DROPS anything unknown
      │            ── POST /telemetry  (loopback only — remote devices can't inject)
      ▼
server/index.js   ── link freshness (5 s), fog gate, risk from real data only
      │            ── events, CSV log (every 2 s)
      ▼
WebSocket state  ──►  dashboard (operator)  +  /view/<token> (read-only viewers)
      │
      └── FOG <0-100>, MSG <text> ──► bridge ──► Arduino
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

Laptop → Arduino: `FOG <0-100>` · `MSG <text>`.

The bridge **never** sends speed or position — the rig measures neither.

## What the dashboard shows

| panel | source |
|---|---|
| **Team brand: MineSafe 360\*** (title bar + page title) | static |
| **AI ACTION ADVISORY — what the truck should do** (STOP / SLOW DOWN / PROCEED + steps) | generated **only** from real link state, real distance and the fog gate |
| Arduino / Bluetooth status (CONNECTED · DISCONNECTED, port, baud, age) | telemetry freshness + bridge heartbeat |
| Real ultrasonic distance (cm / m) or **No data** | `Distance:` line |
| Obstacle state — **> 40 cm SAFE · 15–40 cm CAUTION · < 15 cm DANGER** (fog widens the bands) | distance vs fog-gated thresholds |
| `CAB REPORTS: …` chip | the cab's own `Obstacle:` state |
| **SIMULATION — stationary truck 🚛 + big rock 🪨** | rock sits at the **real** ultrasonic distance (echo 20 cm → rock at 20 cm); auto-range view, red/yellow/green zones, fog overlay while the PC fog control is >30 %; **no echo → no rock**, the stage says "No data" |
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

`arduino/MineGuard.ino` compiles for Uno **and** Nano (`arduino-cli`, 52% flash)
and adds: median-of-3 ranging, fog-scaled margins with the strict >30 gate,
green/yellow/red traffic light, reported `light`/`buzzer`/`buzzerOn` fields,
`MSG` emergency text with a `msgCount` delivery receipt, `FOG` command handling.

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

### Why the browser says "Not secure"

Plain HTTP on your own LAN — no logins, no passwords, no personal data, no
cookies. A self-signed certificate would trigger a full-page red warning
(worse than the grey tag); public CAs don't issue certificates for `.local`
names or private IPs. A real deployment would run behind the mine's
intranet/VPN with TLS at the gateway.

## Tests (71 checks — run with the serial bridge stopped for determinism)

```
cd server
node fogcheck.js     # 11 checks — fog gate honesty (0/20/30 OFF, 31/65/100 ON)
node viewcheck.js    # 14 checks — share links, viewer command refusal
node realcheck.js    # 46 checks — nothing fabricated, ingest, staleness, parser
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
| `{type:"truckMessage", vehicleId, text}` | emergency text to the cab; empty `text` clears |

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
2. ✅ Arduino firmware (`MineGuard.ino`, compiles Uno/Nano)
3. ✅ Bidirectional bridge (auto-baud, both telemetry dialects, FOG/MSG out)
4. ✅ Real-data dashboard (no simulator anywhere)
5. ✅ Read-only permanent share links
6. ✅ **Live hardware verified on COM3 (9600): real distances end-to-end**
7. ⬜ Cab-side FOG/MSG/LED reporting — flash `MineGuard.ino`
8. ⬜ HC-05 Bluetooth pairing (Windows COM port) — bridge ready
9. ⬜ Speed/TTC — needs a real speed source (encoder / UWB), then code can change
