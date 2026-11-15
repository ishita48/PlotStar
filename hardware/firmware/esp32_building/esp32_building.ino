/*
 * SiteStar PROTECT - ESP32 building node (model dorm on cardboard)
 * -----------------------------------------------------------------
 * Board : ESP32 DevKit (WROOM-32). Arduino-ESP32 core 2.x or 3.x.
 * Libs  : Adafruit SSD1306, Adafruit GFX, DHT sensor library (+ Adafruit Unified Sensor).
 *
 * Rooms on the model (LED pair each, via 74HC595):
 *   R1 2F Bathroom   : water-leak probe + servo shut-off valve
 *   R2 B1 Mechanical : DHT11 (temp/humidity), pipe thermistor, sump level (ultrasonic), exhaust fan
 *   R3 1F Lounge     : light-beam smoke sensor, PIR occupancy
 *   R4 1F Corridor   : strobe (relay + white LEDs)
 *
 * SAFETY DESIGN: the leak reflex lives HERE, not in the AI. Water on the probe closes the
 * valve within ~50 ms even if the laptop is gone. The valve will not reopen while the probe
 * is still wet, whatever the laptop says (interlock). The AI does diagnosis, work orders,
 * vendor dispatch (with human approval) and can reopen only after the leak is cleared.
 *
 * ESP32 -> laptop (every 200 ms):
 *   I leak=812 wet=1 beam=640 base=900 smoke=0 t=24.0 rh=48 pipe=21.5 pir=1 lvl=18.2
 *     valve=0 bseq=2 up=93
 *   (valve: 1 open, 0 closed; any sensor not fitted reports "-")
 * Laptop -> ESP32:
 *   A valve=1 fan=0.60 strobe=0 buzz=0 r=0,2,1,0 agent=1
 *     buzz 0 off / 1 alert chirps / 2 alarm; r = room states 0 ok,1 warn,2 alarm
 *     agent 0 idle / 1 thinking (purple) / 2 waiting for human (yellow) / 3 done (green)
 *   L line0|line1|...|line5   OLED text
 *   TEST | PING | RECAL (re-learn dry-probe and clear-beam baselines)
 */

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#if __has_include("esp_arduino_version.h")
#include "esp_arduino_version.h"
#endif
#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ---------------------------------------------------------------- pin map ---
static const uint8_t PIN_SDA = 21, PIN_SCL = 22;
static const uint8_t PIN_VALVE_SERVO = 23;  // SG90 signal
static const uint8_t PIN_LEAK_DRIVE  = 4;   // probe wire A (driven only while sampling: less corrosion)
static const uint8_t PIN_LEAK_SENSE  = 34;  // probe wire B + 100k to GND
static const uint8_t PIN_BEAM_LED    = 5;   // smoke-beam LED (220R)
static const uint8_t PIN_BEAM_SENSE  = 35;  // photoresistor (to 3V3) / 10k (to GND) junction
static const uint8_t PIN_DHT         = 26;  // DHT11 data
static const uint8_t PIN_PIPE_THERM  = 32;  // 10k (to 3V3) / thermistor (to GND) junction
static const uint8_t PIN_PIR         = 27;  // HC-SR501 OUT
static const uint8_t PIN_US_TRIG     = 2;   // HC-SR04 TRIG
static const uint8_t PIN_US_ECHO     = 39;  // HC-SR04 ECHO through 1k/2k divider (5V -> 3.3V)
static const uint8_t PIN_BUTTON      = 36;  // button to GND + EXTERNAL 10k pull-up (GPIO36 has none)
static const uint8_t PIN_FAN_EN      = 33;  // L293D pin 1 (PWM)
static const uint8_t PIN_STROBE      = 14;  // 1k -> PN2222 base -> relay -> white LEDs
static const uint8_t PIN_BUZZER      = 13;  // active buzzer +
static const uint8_t PIN_SR_DATA = 16, PIN_SR_CLK = 17, PIN_SR_LATCH = 18;  // 74HC595
static const uint8_t PIN_RGB_R = 19, PIN_RGB_G = 15, PIN_RGB_B = 12;         // agent status LED

// ------------------------------------------------------------- tunables ---
static const bool     RGB_COMMON_ANODE = false;
static const uint16_t VALVE_OPEN_US    = 600;   // handle along the pipe
static const uint16_t VALVE_CLOSED_US  = 1550;  // handle across the pipe (90 deg)
static const int      LEAK_ON_DELTA    = 400;   // ADC counts above dry baseline = wet
static const int      LEAK_OFF_DELTA   = 200;
static const uint32_t LEAK_DRY_MS      = 3000;  // must read dry this long before "cleared"
static const float    SMOKE_ON_FRAC    = 0.55f; // beam below 55 % of clear baseline = smoke
static const float    SMOKE_OFF_FRAC   = 0.75f;
static const float    FAN_MIN_DUTY     = 0.38f;
static const float    THERM_R_FIXED = 10000.0f, THERM_R25 = 10000.0f, THERM_BETA = 3950.0f;
static const uint32_t LINK_TIMEOUT_MS  = 3000;

// ------------------------------------------------------- PWM (LEDC) shim ---
static void pwmAttach(uint8_t pin, uint8_t ch, uint32_t freq, uint8_t bits) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)ch; ledcAttach(pin, freq, bits);
#else
  ledcSetup(ch, freq, bits); ledcAttachPin(pin, ch);
#endif
}
static void pwmWrite(uint8_t pin, uint8_t ch, uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)ch; ledcWrite(pin, duty);
#else
  (void)pin; ledcWrite(ch, duty);
#endif
}
enum { CH_SERVO = 0, CH_FAN = 2 };

// ---------------------------------------------------------------- state ---
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
DHT dht(PIN_DHT, DHT11);
bool oledOk = false;

// sensors
int leakRaw = 0, leakDry = 0;  bool leakWet = false; uint32_t leakDrySince = 0;
int beamDelta = 0, beamBase = 0; bool smoke = false; uint32_t smokeSince = 0;
float tempC = NAN, rhPct = NAN, pipeC = NAN, levelCm = NAN;
bool pir = false;
uint32_t btnSeq = 0;

// actuators
bool valveOpen = true;          // what the valve is doing now
bool laptopWantsOpen = true;    // last request from the laptop
float fanLevel = 0;
bool strobeOn = false;
int buzzMode = 0;
uint8_t roomState[4] = {0, 0, 0, 0};
int agentState = 0;

char oledLines[6][22];
bool oledDirty = true, online = false;
uint32_t lastCmdMs = 0;

// ------------------------------------------------------------------ helpers ---
static int adcAvg(uint8_t pin, int n = 8) { long s = 0; for (int i = 0; i < n; i++) s += analogRead(pin); return s / n; }
static float clamp01(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

static void setValve(bool open) {
  valveOpen = open;
  uint16_t us = open ? VALVE_OPEN_US : VALVE_CLOSED_US;
  pwmWrite(PIN_VALVE_SERVO, CH_SERVO, (uint32_t)(us * 65535.0f / 20000.0f));
}
static void setFan(float f) {
  fanLevel = clamp01(f);
  float duty = fanLevel < 0.05f ? 0.0f : FAN_MIN_DUTY + fanLevel * (1.0f - FAN_MIN_DUTY);
  pwmWrite(PIN_FAN_EN, CH_FAN, (uint32_t)(duty * 255));
}
static void writeRoomLeds() {
  // Q0..Q7 = R1 green, R1 red, R2 green, R2 red, R3 green, R3 red, R4 green, R4 red
  bool blink = (millis() / 300) % 2;
  uint8_t bits = 0;
  for (int i = 0; i < 4; i++) {
    uint8_t s = roomState[i];
    bool g = (s == 0) || (s == 1 && blink);
    bool r = (s == 2) || (s == 1 && !blink);
    if (g) bits |= 1 << (i * 2);
    if (r) bits |= 1 << (i * 2 + 1);
  }
  digitalWrite(PIN_SR_LATCH, LOW);
  shiftOut(PIN_SR_DATA, PIN_SR_CLK, MSBFIRST, bits);
  digitalWrite(PIN_SR_LATCH, HIGH);
}
static void writeRgb() {
  uint32_t t = millis();
  bool r = false, g = false, b = false;
  switch (agentState) {
    case 1: r = b = (t / 250) % 2; break;  // thinking: purple blink
    case 2: r = g = true; break;           // waiting for a human: yellow
    case 3: g = true; break;               // done: green
    default: break;
  }
  if (RGB_COMMON_ANODE) { r = !r; g = !g; b = !b; }
  digitalWrite(PIN_RGB_R, r); digitalWrite(PIN_RGB_G, g); digitalWrite(PIN_RGB_B, b);
}
static void updateBuzzer() {
  uint32_t t = millis();
  bool localAlarm = leakWet || smoke;  // sound even with no laptop
  bool on = false;
  if (buzzMode == 2 || (!online && localAlarm)) on = (t % 500) < 250;
  else if (buzzMode == 1) on = (t % 2000) < 80;
  digitalWrite(PIN_BUZZER, on);
}

// ------------------------------------------------------------------ sensors ---
static int sampleLeak() {
  digitalWrite(PIN_LEAK_DRIVE, HIGH);
  delayMicroseconds(800);
  int v = adcAvg(PIN_LEAK_SENSE, 6);
  digitalWrite(PIN_LEAK_DRIVE, LOW);
  return v;
}
static int sampleBeam() {
  digitalWrite(PIN_BEAM_LED, HIGH); delayMicroseconds(1500);
  int on = adcAvg(PIN_BEAM_SENSE, 6);
  digitalWrite(PIN_BEAM_LED, LOW);  delayMicroseconds(1500);
  int off = adcAvg(PIN_BEAM_SENSE, 6);
  return on - off;  // ambient light cancels out
}
static void calibrateBaselines() {
  long l = 0, b = 0;
  for (int i = 0; i < 16; i++) { l += sampleLeak(); b += sampleBeam(); delay(5); }
  leakDry = l / 16;
  beamBase = max(1L, b / 16);
}

static void readLeakAndReflex() {
  leakRaw = sampleLeak();
  uint32_t now = millis();
  if (!leakWet && leakRaw > leakDry + LEAK_ON_DELTA) {
    leakWet = true;
    setValve(false);             // <<< REFLEX: close now, no laptop or AI needed
    roomState[0] = 2;
  } else if (leakWet) {
    if (leakRaw < leakDry + LEAK_OFF_DELTA) {
      if (!leakDrySince) leakDrySince = now;
      if (now - leakDrySince > LEAK_DRY_MS) { leakWet = false; leakDrySince = 0; }
    } else {
      leakDrySince = 0;
    }
  }
  if (leakWet && valveOpen) setValve(false);  // interlock: never open onto a live leak
}
static void readSmoke() {
  beamDelta = sampleBeam();
  float frac = (float)beamDelta / beamBase;
  uint32_t now = millis();
  if (!smoke) {
    if (frac < SMOKE_ON_FRAC) { if (!smokeSince) smokeSince = now; if (now - smokeSince > 300) smoke = true; }
    else smokeSince = 0;
  } else if (frac > SMOKE_OFF_FRAC) { smoke = false; smokeSince = 0; }
}
static void readPipe() {
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(PIN_PIPE_THERM);
  float v = mv / 8000.0f;
  if (v < 0.05f || v > 3.25f) { pipeC = NAN; return; }
  float r = THERM_R_FIXED * v / (3.3f - v);
  float c = 1.0f / (1.0f / 298.15f + logf(r / THERM_R25) / THERM_BETA) - 273.15f;
  pipeC = isnan(pipeC) ? c : pipeC * 0.7f + c * 0.3f;
}
static void readLevel() {
  digitalWrite(PIN_US_TRIG, LOW); delayMicroseconds(2);
  digitalWrite(PIN_US_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_US_TRIG, LOW);
  unsigned long us = pulseIn(PIN_US_ECHO, HIGH, 25000);
  levelCm = us ? us / 58.0f : NAN;
}
static void readDht() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (!isnan(t)) tempC = t;
  if (!isnan(h)) rhPct = h;
}
bool btnStable = false, btnRawLast = false; uint32_t btnChange = 0;
static void readButton() {
  bool raw = digitalRead(PIN_BUTTON) == LOW;
  if (raw != btnRawLast) { btnRawLast = raw; btnChange = millis(); }
  if (millis() - btnChange > 30 && raw != btnStable) { btnStable = raw; if (raw) btnSeq++; }
}

// --------------------------------------------------------------------- OLED ---
static void setLine(int i, const char* s) { strncpy(oledLines[i], s, 21); oledLines[i][21] = 0; }
static void oledRender() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.fillRect(0, 0, 128, 10, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setTextColor(SSD1306_BLACK); oled.setCursor(1, 1); oled.print(oledLines[0]);
  oled.setTextColor(SSD1306_WHITE);
  for (int i = 1; i < 6; i++) { oled.setCursor(0, 12 + (i - 1) * 10); oled.print(oledLines[i]); }
  oled.display();
}
static void fmt(char* out, size_t n, float v, const char* unit) {
  if (isnan(v)) snprintf(out, n, "--%s", unit); else snprintf(out, n, "%.1f%s", v, unit);
}
static void showLocal() {
  char b[22], t[10], h[10], p[10];
  setLine(0, online ? "SITESTAR PROTECT" : "PROTECT  OFFLINE");
  snprintf(b, sizeof b, "leak %s valve %s", leakWet ? "WET" : "dry", valveOpen ? "OPEN" : "SHUT"); setLine(1, b);
  snprintf(b, sizeof b, "smoke %s beam %d%%", smoke ? "YES" : "no", (int)(100L * beamDelta / beamBase)); setLine(2, b);
  fmt(t, sizeof t, tempC, "C"); fmt(h, sizeof h, rhPct, "%");
  snprintf(b, sizeof b, "mech %s %s", t, h); setLine(3, b);
  fmt(p, sizeof p, pipeC, "C");
  snprintf(b, sizeof b, "pipe %s pir %d", p, pir ? 1 : 0); setLine(4, b);
  setLine(5, online ? "" : "waiting for laptop..");
  oledRender();
}

// --------------------------------------------------------------- self-test ---
static void selfTest() {
  Serial.println("TEST begin");
  for (int i = 0; i < 4; i++) roomState[i] = 2; writeRoomLeds(); delay(400);
  for (int i = 0; i < 4; i++) roomState[i] = 0; writeRoomLeds();
  setValve(false); delay(700); setValve(true); delay(700);
  setFan(1); delay(1200); setFan(0);
  digitalWrite(PIN_STROBE, HIGH); digitalWrite(PIN_BUZZER, HIGH); delay(150);
  digitalWrite(PIN_BUZZER, LOW); delay(650); digitalWrite(PIN_STROBE, LOW);
  for (int s = 1; s <= 3; s++) { agentState = s; writeRgb(); delay(400); }
  agentState = 0; writeRgb();
  Serial.println("TEST done");
}

// ------------------------------------------------------------ serial input ---
char rx[256]; size_t rxLen = 0;

static void handleCommand(char* args) {
  char* save;
  for (char* tok = strtok_r(args, " ", &save); tok; tok = strtok_r(nullptr, " ", &save)) {
    char* eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char* k = tok; char* v = eq + 1;
    if (!strcmp(k, "valve")) laptopWantsOpen = atoi(v) == 1;
    else if (!strcmp(k, "fan")) setFan(atof(v));
    else if (!strcmp(k, "strobe")) { strobeOn = atoi(v) == 1; digitalWrite(PIN_STROBE, strobeOn); }
    else if (!strcmp(k, "buzz")) buzzMode = atoi(v);
    else if (!strcmp(k, "agent")) agentState = atoi(v);
    else if (!strcmp(k, "r")) {
      int i = 0;
      for (char* p = v; *p && i < 4; p++) if (*p >= '0' && *p <= '2') roomState[i++] = *p - '0';
    }
  }
  // Laptop may close any time; it may only OPEN when the probe is dry (interlock).
  if (!laptopWantsOpen && valveOpen) setValve(false);
  if (laptopWantsOpen && !valveOpen && !leakWet) setValve(true);
  lastCmdMs = millis();
  if (!online) { online = true; oledDirty = true; }
}
static void handleLines(char* text) {
  int i = 0; char* start = text;
  for (char* p = text;; p++) {
    if (*p == '|' || *p == 0) {
      bool end = (*p == 0); *p = 0;
      if (i < 6) setLine(i++, start);
      if (end) break;
      start = p + 1;
    }
  }
  while (i < 6) setLine(i++, "");
  oledDirty = true;
}
static void handleLine(char* line) {
  if (line[0] == 'A' && line[1] == ' ') handleCommand(line + 2);
  else if (line[0] == 'L' && line[1] == ' ') handleLines(line + 2);
  else if (!strcmp(line, "TEST")) selfTest();
  else if (!strcmp(line, "RECAL")) { calibrateBaselines(); Serial.println("RECAL ok"); }
  else if (!strcmp(line, "PING")) Serial.println("PONG");
}
static void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { rx[rxLen] = 0; if (rxLen) handleLine(rx); rxLen = 0; }
    else if (rxLen < sizeof(rx) - 1) rx[rxLen++] = c;
    else rxLen = 0;
  }
}
static void printNum(const char* key, float v) {
  if (isnan(v)) Serial.printf(" %s=-", key); else Serial.printf(" %s=%.1f", key, v);
}
static void sendInputs() {
  Serial.printf("I leak=%d wet=%d beam=%d base=%d smoke=%d", leakRaw, leakWet ? 1 : 0, beamDelta, beamBase, smoke ? 1 : 0);
  printNum("t", tempC); printNum("rh", rhPct); printNum("pipe", pipeC);
  Serial.printf(" pir=%d", pir ? 1 : 0);
  printNum("lvl", levelCm);
  Serial.printf(" valve=%d bseq=%lu up=%lu\n", valveOpen ? 1 : 0, (unsigned long)btnSeq, (unsigned long)(millis() / 1000));
}

// -------------------------------------------------------------------- setup ---
void setup() {
  Serial.begin(115200);
  pinMode(PIN_LEAK_DRIVE, OUTPUT); digitalWrite(PIN_LEAK_DRIVE, LOW);
  pinMode(PIN_BEAM_LED, OUTPUT);   digitalWrite(PIN_BEAM_LED, LOW);
  pinMode(PIN_PIR, INPUT);
  pinMode(PIN_US_TRIG, OUTPUT);    digitalWrite(PIN_US_TRIG, LOW);
  pinMode(PIN_US_ECHO, INPUT);
  pinMode(PIN_BUTTON, INPUT);
  pinMode(PIN_STROBE, OUTPUT);     digitalWrite(PIN_STROBE, LOW);
  pinMode(PIN_BUZZER, OUTPUT);     digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_SR_DATA, OUTPUT); pinMode(PIN_SR_CLK, OUTPUT); pinMode(PIN_SR_LATCH, OUTPUT);
  pinMode(PIN_RGB_R, OUTPUT); pinMode(PIN_RGB_G, OUTPUT); pinMode(PIN_RGB_B, OUTPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_LEAK_SENSE, ADC_11db);
  analogSetPinAttenuation(PIN_BEAM_SENSE, ADC_11db);
  analogSetPinAttenuation(PIN_PIPE_THERM, ADC_11db);

  pwmAttach(PIN_VALVE_SERVO, CH_SERVO, 50, 16);
  pwmAttach(PIN_FAN_EN, CH_FAN, 20000, 8);
  setValve(true); setFan(0);
  writeRoomLeds(); writeRgb();

  Wire.begin(PIN_SDA, PIN_SCL); Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C) || oled.begin(SSD1306_SWITCHCAPVCC, 0x3D);
  dht.begin();

  // Probe must be DRY and the beam CLEAR at power-up: these become the baselines.
  calibrateBaselines();
  Serial.printf("HELLO sitestar-protect v1 oled=%d dry=%d beam=%d\n", oledOk ? 1 : 0, leakDry, beamBase);
  if (digitalRead(PIN_BUTTON) == LOW) selfTest();
}

// --------------------------------------------------------------------- loop ---
void loop() {
  static uint32_t tFast = 0, tMed = 0, tSlow = 0, tDht = 0;
  uint32_t now = millis();
  pollSerial();
  updateBuzzer();
  writeRgb();

  if (now - tFast >= 50) {       // 20 Hz: leak reflex, smoke, button, room LEDs
    tFast = now;
    readLeakAndReflex();
    readSmoke();
    readButton();
    pir = digitalRead(PIN_PIR) == HIGH;
    writeRoomLeds();
  }
  if (now - tMed >= 200) {       // 5 Hz: report, watchdog, OLED
    tMed = now;
    sendInputs();
    if (online && now - lastCmdMs > LINK_TIMEOUT_MS) {
      online = false; buzzMode = 0; agentState = 0; setFan(0);
      digitalWrite(PIN_STROBE, smoke ? HIGH : LOW);
      for (int i = 0; i < 4; i++) roomState[i] = 0;
    }
    if (!online) {               // standalone: local alarms still work
      roomState[0] = leakWet ? 2 : 0;
      roomState[2] = smoke ? 2 : 0;
      digitalWrite(PIN_STROBE, smoke ? HIGH : LOW);
      showLocal();
    } else if (oledDirty) { oledRender(); oledDirty = false; }
  }
  if (now - tSlow >= 500) { tSlow = now; readPipe(); readLevel(); }
  if (now - tDht >= 2000) { tDht = now; readDht(); }
}
