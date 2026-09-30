/*
 * MineGuard V2 — complete vehicle-side controller
 * (SIH26007 — Safe and Efficient Operation of Mine Vehicles in Fog)
 *
 * WHAT THIS FIRMWARE DOES
 *   1. Ranging   : front HC-SR04, median-of-3, 10 Hz  -> obstacleDistance
 *   2. IMU       : MPU6050 over I2C -> tilt (deg) + accel (g), 10 Hz
 *   3. Accident  : tilt >= 28 deg or accel >= 2.4 g latches a local SOS alarm
 *   4. Proximity : local buzzer + LED warnings even with NO laptop connected
 *                  (mirrors the server's demo thresholds: 100 cm / 50 cm)
 *   5. Fog mode  : control room sends "FOG <0-100>" -> local warning margins
 *                  widen automatically (100->160 cm caution, 50->90 cm danger)
 *   6. AI alerts : control room sends "ALERT <0|1|2>" (0 none, 1 caution,
 *                  2 DANGER/"BRAKE") -> distinct urgent alarm pattern.
 *                  This is the physical "AI warns the driver in the cab".
 *   7. E-STOP    : control room sends "ESTOP <0|1>" -> held-vehicle alarm
 *   8. Telemetry : one JSON line every 500 ms (2 Hz) for bridge.js
 *   9. Status light: green/yellow/red traffic LEDs (D4/D5/D6) show
 *                  SAFE / CAUTION / DANGER at a glance. FOG RULE: caution
 *                  (yellow) and danger (red) are SHOWN ONLY when the control
 *                  room's fog intensity is MORE THAN 30% — at 30% or below
 *                  (including fog off) the light holds SAFE green. The
 *                  dashboard still shows true risk at every fog level.
 *  10. Emergency message: control room sends "MSG <text>" -> distinct alarm
 *                  pattern + RED traffic light + the text printed on the
 *                  Serial Monitor (the cab's display); msgCount in telemetry
 *                  is the delivery receipt back to the dashboard.
 *  11. Reporting  : telemetry also reports the REAL traffic-light colour
 *                  ("light") and buzzer state ("buzzer"/"buzzerOn") so the
 *                  dashboard shows what the cab is actually doing. The
 *                  Arduino sends NO speed — there is no speed sensor — and
 *                  the dashboard therefore shows "N/A — No speed sensor".
 *  12. OLED screen : SSD1306 128x64 I2C (A4/A5) shows distance, risk, fog,
 *                  motor, battery and incoming MSG text. If no OLED answers
 *                  on I2C the firmware degrades silently (no screen, all
 *                  functions identical).
 *  13. Motor drive : control room sends "MOTOR FWD|REV <0-255>" / "MOTOR STOP"
 *                  -> ENA PWM on D11, direction on D12/D8 (L298N/DRV8833
 *                  style driver — wiring assumption, see below). The REAL
 *                  motor state is reported back in telemetry ("motor"/"PWM").
 *  14. Battery     : pack voltage on A0 through an assumed 1:1 resistor
 *                  divider (two equal resistors) -> "batteryV" in telemetry.
 *                  The dashboard maps it to a 2S LiPo percentage.
 *
 * Everything is NON-BLOCKING (millis()-driven): alarms keep their rhythm
 * while ranging and telemetry continue. Missing hardware degrades gracefully:
 *   - no echo / nothing in range      -> 400 cm "beam clear"
 *   - MPU6050 not responding          -> imu:0 flag, tilt 0, accel 1.0
 *
 * WIRING (Arduino Nano — matches the physical rig as wired)
 *   HC-SR04      : TRIG -> D9,  ECHO -> D10,  VCC -> 5V,  GND -> GND
 *   Traffic light: GREEN -> D4,  YELLOW -> D5,  RED -> D6
 *                  (each LED anode -> pin, cathode -> 220 ohm resistor -> GND)
 *   Buzzer       : + -> D7 (through 100 ohm if passive piezo),  - -> GND
 *   LED          : built-in D13 = "firmware alive" heartbeat
 *   HC-05        : Arduino RX -> D2,  Arduino TX -> D3 (HC-05 TX -> D2,
 *                  HC-05 RX -> D3 through a 1k/2k divider), VCC -> 5V, GND.
 *                  Telemetry + commands mirror the USB link, so bridge.js
 *                  works over the Bluetooth COM port identically.
 *   (MPU6050 is OPTIONAL and not currently fitted: SDA -> A4, SCL -> A5.
 *    With no IMU the firmware reports "imu":0 and never claims tilt/accel.)
 *   OLED (optional, not wired yet): SSD1306 I2C — SDA -> A4, SCL -> A5
 *    (same I2C bus as the MPU6050; different address 0x3C). No ACK = no
 *    screen — everything else keeps working.
 *   Motor driver (new hardware): ENA -> D11 (PWM), IN1 -> D12, IN2 -> D8
 *    (typical L298N/DRV8833 wiring — ASSUMPTION until confirmed on the rig).
 *    Boot state is always STOP; an unknown command also means STOP.
 *   Battery: pack -> 1:1 divider -> A0 (assumption: two equal resistors,
 *    e.g. 100k/100k, so up to ~10 V is measurable on the 5 V ADC).
 *
 * SERIAL PROTOCOL (57600 baud, newline delimited — both directions)
 *   Arduino -> laptop : {"vehicleId":"MG-01","obstacleDistance":73,...}
 *   laptop  -> Arduino : FOG <0-100> | ALERT <0|1|2> | ESTOP <0|1> | MSG <text> | ACK
 *                      | MOTOR FWD|REV <0-255> | MOTOR STOP
 *
 * FLASHING: no libraries needed beyond the built-in Wire library (the OLED
 * driver Ssd1306Display.h is header-only and ships in this folder).
 *   Arduino IDE -> select your board + port -> Open arduino/MineGuard.ino -> Upload
 *
 * Prototype thresholds only — NOT real mine-safety limits.
 */

#include <Wire.h>
#include <SoftwareSerial.h>
#include "Ssd1306Display.h"

/* ------------------------------- pins ---------------------------------- */
const uint8_t TRIG_PIN   = 9;
const uint8_t ECHO_PIN   = 10;
const uint8_t BUZZER_PIN = 7;
const uint8_t LED_PIN    = 13; // built-in "alive" heartbeat

// Traffic-light status cluster: green / yellow / red — physical wiring of
// the current rig (D4/D5/D6). Plain on/off writes, no conflict with tone()
// (which only *reads* timer2 for the buzzer on D7).
const uint8_t TRAF_GREEN_PIN  = 4;
const uint8_t TRAF_YELLOW_PIN = 5;
const uint8_t TRAF_RED_PIN    = 6;

// HC-05 Bluetooth: the PC pairs with it and gets ANOTHER COM port —
// bridge.js connects exactly like USB. 9600 = HC-05 factory default baud.
// Wiring of the current rig: HC-05 TX -> D2 (Arduino RX), HC-05 RX -> D3
// (Arduino TX, through a 1k/2k divider).
const uint8_t BT_RX_PIN = 2; // Arduino RX <-  HC-05 TX
const uint8_t BT_TX_PIN = 3; // Arduino TX  ->  HC-05 RX (use 1k/2k divider!)
SoftwareSerial btSerial(BT_RX_PIN, BT_TX_PIN);

// Motor driver (new hardware): ENA = PWM speed, IN1/IN2 = direction.
// Wiring assumption (typical L298N/DRV8833): ENA->D11, IN1->D12, IN2->D8.
const uint8_t MOTOR_ENA_PIN = 11;
const uint8_t MOTOR_IN1_PIN = 12;
const uint8_t MOTOR_IN2_PIN = 8;

// Battery pack voltage on A0 through an assumed 1:1 divider (two equal
// resistors) -> up to ~10 V measurable on the 5 V ADC.
const uint8_t BATTERY_PIN = A0;

/* ---------------------------- constants -------------------------------- */
const char*          VEHICLE_ID   = "MG-01";
const unsigned long  TELEMETRY_MS = 500;      // 2 Hz JSON out
const unsigned long  RANGE_MS     = 100;      // 10 Hz ranging + IMU
const uint16_t       BASE_CAUTION_CM = 100;   // demo thresholds (match server)
const uint16_t       BASE_DANGER_CM  = 50;
const float          ACCIDENT_TILT_DEG = 28.0f;
const float          ACCIDENT_ACCEL_G  = 2.4f;
const unsigned long  CRASH_HOLD_MS = 90000UL; // SOS alarm auto-clears after 90 s
const unsigned long  MSG_HOLD_MS   = 60000UL; // emergency-message alarm shows 60 s
const uint8_t        MSG_MAX_CHARS = 40;      // longest message stored/shown

/* ----------------------------- state ----------------------------------- */
float   distanceCm   = 400;  // 400 = beam clear (same convention as the server)
float   tiltDeg      = 0;
float   accelG       = 1.0;
bool    imuOk        = false;

uint8_t fogIntensity = 0;    // FOG command  (0 = off, 1-100)
uint8_t aiAlert      = 0;    // ALERT command (0 none, 1 caution, 2 BRAKE)
bool    eStop        = false;// ESTOP command
bool    crashLatched = false;
unsigned long crashAt = 0;

String   msgText;             // last emergency message from the control room
bool     msgPending = false;  // its alarm is still showing
unsigned long msgAt = 0;
uint16_t msgCount = 0;        // receipt: rises with every MSG received

// Motor + battery (new hardware) — real states, reported in telemetry.
uint8_t  motorPwm  = 0;       // 0-255 commanded PWM
bool     motorFwd  = true;    // direction flag
bool     motorOn   = false;   // false = STOP (boot state — safety first)
float    batteryV  = 0;       // pack volts from the ADC (0 = not read yet)

Ssd1306 oled;                 // cab display (absent OLED = silently unused)
unsigned long oledAt = 0;     // last OLED refresh
unsigned long msgScreenUntil = 0; // show the MSG screen until this time

unsigned long lastRange = 0;
unsigned long lastTele  = 0;

/* ------------------------- alarm sound engine --------------------------- */
enum AlarmMode : uint8_t { A_SILENT, A_CAUTION, A_DANGER, A_AI, A_MSG, A_ESTOP, A_CRASH };

struct Step { uint16_t freq; uint16_t ms; };   // freq 0 = silence (gap)

// Caution      : slow beep      Danger: fast beep
// AI "BRAKE"   : urgent triple beep
// MSG          : four urgent high beeps (control-room emergency message)
// E-STOP       : two long blasts
// Crash        : SOS (3 short, 3 long, 3 short)
const Step P_CAUTION[] = { {880, 80},   {0, 920} };
const Step P_DANGER[]  = { {880, 100},  {0, 200} };
const Step P_AI[]      = { {1300, 90},  {0, 60}, {1300, 90}, {0, 60}, {1300, 90}, {0, 650} };
const Step P_MSG[]     = { {1400, 130}, {0, 80}, {1400, 130}, {0, 80}, {1400, 130}, {0, 80}, {1400, 130}, {0, 950} };
const Step P_ESTOP[]   = { {1500, 350}, {0, 150}, {1500, 350}, {0, 950} };
const Step P_CRASH[] = {
  {1100,150},{0,150},{1100,150},{0,150},{1100,150},{0,150},        // S S S
  {1100,450},{0,150},{1100,450},{0,150},{1100,450},{0,150},        // L L L
  {1100,150},{0,150},{1100,150},{0,150},{1100,150},{0,1200}        // S S S + pause
};

AlarmMode   playedMode = A_SILENT;
const Step* pattern    = nullptr;
uint8_t     patternLen = 0;
uint8_t     stepIdx    = 0;
unsigned long stepAt   = 0;

/* -------------------------- fog-scaled margins -------------------------- */
/* FOG RULE (PC-controlled, 0-100): 0-30% = fog-dependent logic OFF (plain
 * base margins), 31-100% = fog-dependent logic ON (margins widen with the
 * intensity the control room set). The same gate drives the traffic light
 * in serviceTrafficLight() below. */
uint16_t fogScale()   { return fogIntensity > 30 ? (uint16_t)fogIntensity : 0; }
uint16_t cautionCm() { return BASE_CAUTION_CM + (fogScale() * 60) / 100; } // 100..160
uint16_t dangerCm()  { return BASE_DANGER_CM  + (fogScale() * 40) / 100; } //  50.. 90

/* --------------------------- ultrasound --------------------------------- */
long readDistanceOnce() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 25000UL); // ~4.3 m cap
  if (us == 0) return 400;                    // no echo -> beam clear
  return us / 58;
}

uint16_t readDistanceMedian() {
  long s[3];
  for (uint8_t i = 0; i < 3; i++) s[i] = readDistanceOnce();
  // median of 3
  long d = (s[0] <= s[1]) ? ((s[1] <= s[2]) ? s[1] : ((s[0] <= s[2]) ? s[2] : s[0]))
                          : ((s[0] <= s[2]) ? s[0] : ((s[1] <= s[2]) ? s[2] : s[1]));
  if (d > 400) d = 400;
  return (uint16_t)d;
}

/* ------------------------------ IMU ------------------------------------- */
void readImu() {
  Wire.beginTransmission(0x68);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) { imuOk = false; return; }
  if (Wire.requestFrom((uint8_t)0x68, (uint8_t)6) != 6) { imuOk = false; return; }

  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();

  float fx = ax / 16384.0f;
  float fy = ay / 16384.0f;
  float fz = az / 16384.0f;

  accelG = sqrtf(fx * fx + fy * fy + fz * fz);
  float roll  = fabsf(atan2f(fy, fz));
  float pitch = fabsf(atan2f(-fx, sqrtf(fy * fy + fz * fz)));
  float r = roll * 57.2957795f;
  float p = pitch * 57.2957795f;
  tiltDeg = (r > p) ? r : p;
  imuOk = true;
}

void detectCrash() {
  if (imuOk && !crashLatched && (tiltDeg >= ACCIDENT_TILT_DEG || accelG >= ACCIDENT_ACCEL_G)) {
    crashLatched = true;
    crashAt = millis();
  }
  if (crashLatched && millis() - crashAt > CRASH_HOLD_MS) crashLatched = false;
}

/* ------------------------- alarm priority ------------------------------- */
AlarmMode currentMode() {
  if (crashLatched) return A_CRASH;               // 1. accident SOS
  if (eStop)        return A_ESTOP;               // 2. automatic E-STOP held
  if (msgPending)   return A_MSG;                 // 3. control-room emergency message
  if (aiAlert >= 2) return A_AI;                  // 4. AI says BRAKE
  if (distanceCm <= dangerCm())  return A_DANGER; // 5. very close obstacle
  if (aiAlert == 1 || distanceCm <= cautionCm()) return A_CAUTION;
  return A_SILENT;
}

void selectPattern(AlarmMode m) {
  switch (m) {
    case A_CAUTION: pattern = P_CAUTION; patternLen = sizeof(P_CAUTION) / sizeof(Step); break;
    case A_DANGER:  pattern = P_DANGER;  patternLen = sizeof(P_DANGER)  / sizeof(Step); break;
    case A_AI:      pattern = P_AI;      patternLen = sizeof(P_AI)      / sizeof(Step); break;
    case A_MSG:     pattern = P_MSG;     patternLen = sizeof(P_MSG)     / sizeof(Step); break;
    case A_ESTOP:   pattern = P_ESTOP;   patternLen = sizeof(P_ESTOP)   / sizeof(Step); break;
    case A_CRASH:   pattern = P_CRASH;   patternLen = sizeof(P_CRASH)   / sizeof(Step); break;
    default:        pattern = nullptr;    patternLen = 0; break;
  }
  stepIdx = 0;
  stepAt  = millis();
  if (patternLen == 0) { noTone(BUZZER_PIN); return; }
  if (pattern[0].freq) tone(BUZZER_PIN, pattern[0].freq);
}

void serviceAlarm() {
  AlarmMode m = currentMode();
  if (m != playedMode) { playedMode = m; selectPattern(m); return; }
  if (patternLen == 0) return;
  unsigned long now = millis();
  if (now - stepAt >= pattern[stepIdx].ms) {
    stepIdx = (stepIdx + 1) % patternLen;
    stepAt  = now;
    if (pattern[stepIdx].freq) tone(BUZZER_PIN, pattern[stepIdx].freq);
    else                       noTone(BUZZER_PIN);
  }
}

/* ---------------- status traffic light (D2/D3/D4) ----------------------- */
/* Green = SAFE · Yellow = CAUTION · Red = DANGER (incl. AI / E-STOP / crash)
 * FOG RULE (demo spec): caution and danger are shown ONLY when control-room
 * fog intensity is MORE THAN 30% — at 30% or below (fog off included) the
 * cab light holds SAFE green, no exceptions. The buzzer/alarm and the
 * dashboard keep reporting true risk at every fog level.
 * Solid colours so the state reads from across the demo room.             */
void serviceTrafficLight() {
  bool g = false, y = false, r = false;
  if (fogIntensity > 30) {
    switch (playedMode) {
      case A_SILENT:  g = true; break;                  // all clear
      case A_CAUTION: y = true; break;                  // warning zone / fog margin
      default:        r = true; break;                  // DANGER · AI · MSG · E-STOP · CRASH
    }
  } else {
    g = true;                                           // safe green — always
  }
  digitalWrite(TRAF_GREEN_PIN,  g ? HIGH : LOW);
  digitalWrite(TRAF_YELLOW_PIN, y ? HIGH : LOW);
  digitalWrite(TRAF_RED_PIN,    r ? HIGH : LOW);
}

/* Built-in D13 = "firmware alive" heartbeat (state is shown by the light) */
void serviceLed() {
  unsigned long now = millis();
  digitalWrite(LED_PIN, ((now % 3000) < 60) ? HIGH : LOW);
}

/* ------------- what the cab is ACTUALLY doing (reported) ---------------- */
/* The same decisions serviceTrafficLight()/serviceAlarm() make — reported
 * to the dashboard as facts, so the PC shows the REAL LED colour and buzzer
 * state instead of guessing them. */
const char* lightName() {
  if (fogIntensity <= 30) return "GREEN";         // fog logic OFF: solid green
  switch (playedMode) {
    case A_SILENT:  return "GREEN";
    case A_CAUTION: return "YELLOW";
    default:        return "RED";
  }
}
const char* alarmName() {
  switch (playedMode) {
    case A_SILENT:  return "SILENT";
    case A_CAUTION: return "CAUTION";
    case A_DANGER:  return "DANGER";
    case A_AI:      return "AI";
    case A_MSG:     return "MSG";
    case A_ESTOP:   return "ESTOP";
    case A_CRASH:   return "CRASH";
    default:        return "SILENT";
  }
}

/* --------------------- commands from the control room ------------------- */
String cmdLine;
void handleCommand(String s) {
  s.trim();
  if (s.startsWith("FOG ")) {
    fogIntensity = (uint8_t)constrain(s.substring(4).toInt(), 0, 100);
  } else if (s.startsWith("ALERT ")) {
    aiAlert = (uint8_t)constrain(s.substring(6).toInt(), 0, 2);
  } else if (s.startsWith("ESTOP ")) {
    eStop = s.substring(6).toInt() != 0;
  } else if (s.startsWith("MSG ")) {
    // Emergency message from the control room: show it, alarm for it, count it
    // (the count is what the dashboard reads back as the delivery receipt).
    msgText = s.substring(4);
    msgText.trim();
    if (msgText.length() > MSG_MAX_CHARS) msgText = msgText.substring(0, MSG_MAX_CHARS);
    msgPending = true;
    msgAt = millis();
    msgCount++;
    msgScreenUntil = millis() + 8000; // OLED shows the message for 8 s
    // The cab has no screen of its own — the laptop Serial Monitor IS the
    // display, so the text prints on both links for whoever sits in the cab.
    Serial.print(F("MSG FROM CONTROL ROOM: "));
    Serial.println(msgText);
    btSerial.print(F("MSG FROM CONTROL ROOM: "));
    btSerial.println(msgText);
  } else if (s == "ACK") {
    crashLatched = false;   // operator acknowledged — silence the SOS
  } else if (s.startsWith("MOTOR ")) {
    // Drive command for the toy truck's motor. Boot/unknown => STOP.
    String rest = s.substring(6);
    rest.trim();
    if (rest.startsWith("FWD")) {
      motorPwm = (uint8_t)constrain(rest.substring(3).toInt(), 0, 255);
      motorFwd = true;
      motorOn = motorPwm > 0;
    } else if (rest.startsWith("REV")) {
      motorPwm = (uint8_t)constrain(rest.substring(3).toInt(), 0, 255);
      motorFwd = false;
      motorOn = motorPwm > 0;
    } else {
      motorOn = false;      // "MOTOR STOP" (or anything unrecognised)
      motorPwm = 0;
    }
    if (motorOn) {
      digitalWrite(MOTOR_IN1_PIN, motorFwd ? HIGH : LOW);
      digitalWrite(MOTOR_IN2_PIN, motorFwd ? LOW : HIGH);
      analogWrite(MOTOR_ENA_PIN, motorPwm);
    } else {
      digitalWrite(MOTOR_IN1_PIN, LOW);
      digitalWrite(MOTOR_IN2_PIN, LOW);
      analogWrite(MOTOR_ENA_PIN, 0);
    }
  }
}

void feedCommandChar(char c) {
  if (c == '\n' || c == '\r') {
    if (cmdLine.length() > 0) { handleCommand(cmdLine); cmdLine = ""; }
  } else if (cmdLine.length() < 48) {
    cmdLine += c;
  }
}

void readCommands() {
  // Commands arrive on EITHER link: USB serial or the HC-05 Bluetooth port.
  while (Serial.available()) feedCommandChar((char)Serial.read());
  while (btSerial.available()) feedCommandChar((char)btSerial.read());
}

/* --------------------------- telemetry out ------------------------------ */
// Every telemetry byte goes out on BOTH links — USB (cable bridge) and the
// HC-05 Bluetooth COM port (wireless bridge). Same JSON, same 2 Hz, either
// or even both connected at once.
void emitP(const __FlashStringHelper* s) { Serial.print(s);   btSerial.print(s); }
void emitP(const char* s)               { Serial.print(s);   btSerial.print(s); }
void emitP(char c)                      { Serial.print(c);   btSerial.print(c); }
void emitP(int v)                       { Serial.print(v);   btSerial.print(v); }
void emitP(unsigned int v)              { Serial.print(v);   btSerial.print(v); }
void emitP(long v)                      { Serial.print(v);   btSerial.print(v); }
void emitP(unsigned long v)             { Serial.print(v);   btSerial.print(v); }
void emitP(double v, int d)             { Serial.print(v, d); btSerial.print(v, d); }
void emitPL(char c)                     { Serial.println(c); btSerial.println(c); }

void emitTelemetry() {
  // JSON via print pieces (AVR printf has no %f — this always works)
  emitP(F("{\"vehicleId\":\""));
  emitP(VEHICLE_ID);
  emitP(F("\",\"obstacleDistance\":"));
  emitP((uint16_t)distanceCm);
  emitP(F(",\"tilt\":"));
  emitP(tiltDeg, 1);
  emitP(F(",\"accel\":"));
  emitP(accelG, 2);
  emitP(F(",\"crash\":"));
  emitP(crashLatched ? 1 : 0);
  emitP(F(",\"eStop\":"));
  emitP(eStop ? 1 : 0);
  emitP(F(",\"ai\":"));
  emitP(aiAlert);
  emitP(F(",\"fog\":"));
  emitP(fogIntensity);
  emitP(F(",\"imu\":"));
  emitP(imuOk ? 1 : 0);
  emitP(F(",\"light\":\""));
  emitP(lightName());                      // real traffic-light colour
  emitP(F("\",\"buzzer\":\""));
  emitP(alarmName());                      // real alarm pattern playing now
  emitP(F("\",\"buzzerOn\":"));
  emitP(patternLen > 0 ? 1 : 0);           // actively sounding this instant
  emitP(F(",\"msgCount\":"));
  emitP(msgCount); // delivery receipts for control-room messages
  emitP(F(",\"motor\":\""));
  emitP(motorOn ? (motorFwd ? "FWD" : "REV") : "OFF"); // real motor state
  emitP(F("\",\"motorPwm\":"));
  emitP(motorPwm);
  emitP(F(",\"batteryV\":"));
  emitP(batteryV, 2); // real pack volts from the ADC
  emitP(F(",\"uptime\":"));
  emitP(millis() / 1000);
  emitPL('}');
}

/* --------------------------- OLED cab screen --------------------------- */
/* Refreshes the SSD1306 at 4 Hz. Three screens: boot (first 2.5 s), the
 * incoming MSG text (8 s after it arrives — from the admin or the AI), and
 * the status screen (real values only: distance, risk, fog, motor, battery).
 * AVR printf has no %f — floats go through dtostrf. */
void serviceOled() {
  if (!oled.ok) return; // no OLED fitted — everything else keeps working
  unsigned long now = millis();
  if (now - oledAt < 250) return;
  oledAt = now;
  oled.clear();
  char line[22];
  if (now < 2500) {
    oled.text(1, "MineGuard");
    oled.text(3, "SIH26007");
    oled.text(5, "MineGuard truck");
  } else if (now < msgScreenUntil && msgText.length() > 0) {
    oled.text(0, "MSG FROM CONTROL:");
    oled.text(2, msgText.substring(0, 21).c_str());
    if (msgText.length() > 21) oled.text(3, msgText.substring(21, 42).c_str());
  } else {
    if (distanceCm >= 400) snprintf(line, sizeof(line), "DIST   NO ECHO");
    else snprintf(line, sizeof(line), "DIST   %d CM", (int)distanceCm);
    oled.text(0, line);
    const char* risk = "CLEAR";
    if (playedMode == A_CAUTION) risk = "CAUTION";
    else if (playedMode != A_SILENT) risk = "DANGER";
    snprintf(line, sizeof(line), "RISK   %s", risk);
    oled.text(1, line);
    snprintf(line, sizeof(line), "FOG    %d%%", fogIntensity);
    oled.text(2, line);
    snprintf(line, sizeof(line), "MOT    %s", motorOn ? (motorFwd ? "FWD" : "REV") : "OFF");
    oled.text(3, line);
    snprintf(line, sizeof(line), "PWM    %d", motorPwm);
    oled.text(4, line);
    if (batteryV > 0) {
      char vbuf[7];
      dtostrf(batteryV, 4, 2, vbuf);
      snprintf(line, sizeof(line), "BAT    %sV", vbuf);
      oled.text(5, line);
    } else {
      oled.text(5, "BAT    --");
    }
  }
}

/* ------------------------------ setup/loop ------------------------------ */
void setup() {
  Serial.begin(57600);
  btSerial.begin(9600);   // HC-05 factory baud — pair & open it as a COM port
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(TRAF_GREEN_PIN, OUTPUT);
  pinMode(TRAF_YELLOW_PIN, OUTPUT);
  pinMode(TRAF_RED_PIN, OUTPUT);
  pinMode(MOTOR_ENA_PIN, OUTPUT);
  pinMode(MOTOR_IN1_PIN, OUTPUT);
  pinMode(MOTOR_IN2_PIN, OUTPUT);
  pinMode(BATTERY_PIN, INPUT);
  motorOn = false; // boot state = STOP (safety)
  digitalWrite(MOTOR_IN1_PIN, LOW);
  digitalWrite(MOTOR_IN2_PIN, LOW);
  analogWrite(MOTOR_ENA_PIN, 0);
  digitalWrite(LED_PIN, LOW);
  digitalWrite(TRAF_GREEN_PIN, HIGH);  // boot state = SAFE until told otherwise
  digitalWrite(TRAF_YELLOW_PIN, LOW);
  digitalWrite(TRAF_RED_PIN, LOW);

  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x6B);
  Wire.write(0);                     // wake MPU6050 from sleep
  imuOk = (Wire.endTransmission(true) == 0);

  oled.begin(); // SSD1306 on I2C — false result = no screen, keep working

  // startup chirp so you know the vehicle side is alive
  tone(BUZZER_PIN, 1200, 80);
  delay(120);
  tone(BUZZER_PIN, 1600, 80);
  delay(200);

  Serial.println(F("{\"boot\":\"MineGuard v2 firmware ready\"}"));
  btSerial.println(F("{\"boot\":\"MineGuard v2 firmware ready\"}"));
}

void loop() {
  readCommands();

  unsigned long now = millis();

  // Emergency-message alarm expires after its display window
  if (msgPending && now - msgAt > MSG_HOLD_MS) {
    msgPending = false;
    msgText = "";
  }

  if (now - lastRange >= RANGE_MS) {
    lastRange = now;
    distanceCm = readDistanceMedian();
    batteryV = analogRead(BATTERY_PIN) * (5.0 / 1023.0) * 2.0; // 1:1 divider
    readImu();
    detectCrash();
  }

  serviceAlarm();
  serviceTrafficLight();
  serviceLed();
  serviceOled();

  if (now - lastTele >= TELEMETRY_MS) {
    lastTele = now;
    emitTelemetry();
  }
}
