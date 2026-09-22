/**
 * CrashLink main ESP32 firmware.
 *
 *   sensorTask (50 Hz, core 0)  MPU6050 tilt/impact/rotation, GPS, buttons,
 *                               LED + buzzer patterns. Never blocks.
 *   loop()      (core 1)        network: clock sync, heartbeats, commands,
 *                               incidents, control polling, SMS, camera.
 *
 * Incident flow (spec 4.5.1, 5.3.6, Appendix E.1.4 ordering):
 *   tilt > 60 deg for 10 s (fall confirmation, fixed)  -> incident
 *   1. report the incident            2. SMS the owner
 *   3. capture the photo              4. rider has 60 s (server deadline):
 *        SAFE button / app SAFE  -> resolved, no contact SMS
 *        SOS button / app HELP / TIMEOUT / offline fallback -> contact SMS
 *   5. upload the photo last          6. re-arm after 5 s upright
 *
 * The backend never sends SMS - this device does (pinned decision).
 */
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>
#include <time.h>
#include "esp_system.h"
#include "mbedtls/md.h"
#include "secrets.h"
#include "network.h"

#define FW_VERSION "1.0.0"

// --- Confirmed pin map (spec Appendix E) --------------------------------------
constexpr int PIN_MPU_SDA = 21, PIN_MPU_SCL = 22;
constexpr int PIN_GPS_RX = 16, PIN_GPS_TX = 17;
constexpr int PIN_SIM_RX = 26, PIN_SIM_TX = 27;
constexpr int PIN_IGNITION_BUTTON = 32, PIN_SAFE_BUTTON = 33, PIN_SOS_BUTTON = 25;
constexpr int PIN_GREEN_LED = 18, PIN_BLUE_LED = 19, PIN_RED_LED = 23;
constexpr int PIN_BUZZER = 13;  // active buzzer, wired directly

// --- Detection parameters (spec 5.3.8 / 5.3.9 defaults) -------------------------
constexpr float FALL_ANGLE_DEG = 60;
constexpr float RECOVER_ANGLE_DEG = 40;
constexpr uint32_t FALL_CONFIRM_MS = 5000;    // team decision 22 Sep: 5 s (was 10 s)
constexpr uint32_t RESPONSE_WINDOW_MS = 60000;  // pinned: 60 s (server-timed when online)
constexpr uint32_t DEADLINE_GRACE_MS = 15000;
constexpr uint32_t REARM_UPRIGHT_MS = 5000;
constexpr float IMPACT_G = 2.5;
constexpr float ROLLOVER_DEG_IN_2S = 150;
constexpr float COLLISION_SPEED_KPH = 20;
constexpr uint32_t SOS_HOLD_MS = 2000;  // team decision 22 Sep: 2 s hold (was 1 s)
constexpr uint32_t CONTROL_POLL_MS = 3000;
constexpr uint32_t HEARTBEAT_MS = 10000;
constexpr size_t IMAGE_CHUNK = 4096;          // one request for a ~4 KB QVGA frame (server allows 8 KB)

HardwareSerial& gpsSerial = Serial2;
HardwareSerial& sim = Serial1;
Preferences nvs;

// ============================================================================
// Shared state (sensor task <-> loop)
// ============================================================================

enum Mode : uint8_t { BOOTING, MONITORING, FALL_CANDIDATE, AWAITING_RESPONSE, ESCALATED, RESOLVED, REARM_WAIT };
const char* modeName(Mode m) {
  static const char* names[] = {"BOOTING", "MONITORING", "FALL_CANDIDATE", "AWAITING_RESPONSE", "ESCALATED", "RESOLVED", "REARM_WAIT"};
  return names[m];
}
volatile Mode mode = BOOTING;
volatile bool ignitionOn = false;
volatile bool netOk = false;
volatile bool netBusy = false;
volatile uint32_t beepUntil = 0;

// Button events, latched by the sensor task and consumed by the loop.
volatile bool evSafe = false, evSos = false, evIgnition = false;

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

struct GpsSnapshot {
  bool everFixed = false;
  bool valid = false;
  double lat = 0, lon = 0;
  float speedKph = 0, hdop = 0;
  int sats = 0;
  uint32_t fixMillis = 0;
  int64_t fixEpoch = 0;  // set when the fix is remembered from before this boot (NVS)
};
GpsSnapshot gpsSnap;

// 100 ms motion buckets: the last 5 s, for peaks and the black-box window.
constexpr int BUCKETS = 50;
struct Bucket {
  float maxAccelG, maxGyroDps, tiltDeg, rotDeg, speedKph;
};
Bucket buckets[BUCKETS];
int bucketHead = 0;  // next slot to write
volatile float tiltNow = 0;

// ============================================================================
// Small utilities
// ============================================================================

void logf(const char* fmt, ...) {
  char buf[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof buf, fmt, args);
  va_end(args);
  Serial.printf("[%7.1f] %s\n", millis() / 1000.0, buf);
}

void beep(uint32_t ms) { beepUntil = millis() + ms; }

String hexOf(const uint8_t* b, size_t n) {
  static const char* h = "0123456789abcdef";
  String s;
  s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) {
    s += h[b[i] >> 4];
    s += h[b[i] & 15];
  }
  return s;
}

void decodeSecret(const char* hex, uint8_t out[32]) {
  for (int i = 0; i < 32; i++) {
    char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    out[i] = (uint8_t)strtoul(pair, nullptr, 16);
  }
}

String sha256Hex(const uint8_t* data, size_t len) {
  uint8_t out[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), data, len, out);
  return hexOf(out, 32);
}

String hmacHex(const char* secretHex, const String& msg) {
  uint8_t key[32], out[32];
  decodeSecret(secretHex, key);
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, (const uint8_t*)msg.c_str(), msg.length(), out);
  return hexOf(out, 32);
}

String randomHex(int bytes) {
  uint8_t b[16];
  for (int i = 0; i < bytes; i++) b[i] = (uint8_t)esp_random();
  return hexOf(b, bytes);
}

/** Incident id == device eventId (pinned). RFC 4122 v4. */
String uuid4() {
  uint8_t b[16];
  for (auto& x : b) x = (uint8_t)esp_random();
  b[6] = (b[6] & 0x0F) | 0x40;
  b[8] = (b[8] & 0x3F) | 0x80;
  String h = hexOf(b, 16);
  return h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-" + h.substring(16, 20) + "-" + h.substring(20);
}

// --- Clock: the device trusts the server's clock (spec 5.3.1) ------------------

int64_t epochAtSync = 0;
uint32_t millisAtSync = 0;
bool clockSynced = false;

int64_t nowEpoch() { return epochAtSync + (int64_t)((millis() - millisAtSync) / 1000); }
int64_t epochAtMillis(uint32_t ms) { return epochAtSync + ((int64_t)ms - (int64_t)millisAtSync) / 1000; }

String isoFromEpoch(int64_t epoch) {
  time_t t = (time_t)epoch;
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[24];
  strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", &tm);
  return String(buf);
}
String isoNow() { return isoFromEpoch(nowEpoch()); }

/** "2026-09-21T06:31:03.123Z" -> epoch seconds (TZ is UTC, set in setup). */
int64_t epochFromIso(const char* iso) {
  if (!iso || strlen(iso) < 19) return 0;
  struct tm tm = {};
  tm.tm_year = atoi(iso) - 1900;
  tm.tm_mon = atoi(iso + 5) - 1;
  tm.tm_mday = atoi(iso + 8);
  tm.tm_hour = atoi(iso + 11);
  tm.tm_min = atoi(iso + 14);
  tm.tm_sec = atoi(iso + 17);
  return (int64_t)mktime(&tm);
}

/** Asia/Colombo (UTC+05:30), "HH:MM DD/MM" for SMS (spec 5.3.10). */
String colomboTime(int64_t epoch) {
  time_t t = (time_t)(epoch + 19800);
  struct tm tm;
  gmtime_r(&t, &tm);
  char buf[16];
  strftime(buf, sizeof buf, "%H:%M %d/%m", &tm);
  return String(buf);
}

// ============================================================================
// Assignment snapshot (NVS) - the numbers the bike texts
// ============================================================================

struct Assignment {
  bool present = false;
  String rentalId, bikeLabel, ownerPhone, driverName, driverPhone, contactName, contactPhone;
  int version = 0;
};
Assignment assignment;
int configVersion = 1;

void loadAssignment() {
  assignment = Assignment();
  if (!nvs.isKey("asgJson")) return;
  String json = nvs.getString("asgJson", "");
  if (json.isEmpty()) return;
  JsonDocument doc;
  if (deserializeJson(doc, json)) return;
  assignment.present = true;
  assignment.rentalId = doc["rentalId"] | "";
  assignment.version = doc["assignmentVersion"] | 0;
  assignment.bikeLabel = doc["bikeLabel"] | "Bike";
  assignment.ownerPhone = doc["ownerPhone"] | "";
  assignment.driverName = doc["driverName"] | "Rider";
  assignment.driverPhone = doc["driverPhone"] | "";
  assignment.contactName = doc["contactName"] | "";
  assignment.contactPhone = doc["contactPhone"] | "";
}

// ============================================================================
// Sensor task: MPU6050, GPS, buttons, LEDs, buzzer
// ============================================================================

uint8_t mpuAddr = 0x68;
bool mpuOk = false;
float g0x = 0, g0y = 0, g0z = 1;  // calibrated upright gravity direction

bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuRead(float& ax, float& ay, float& az, float& gyro) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, (uint8_t)14) != 14) return false;
  int16_t raw[7];
  for (int i = 0; i < 7; i++) raw[i] = (Wire.read() << 8) | Wire.read();
  ax = raw[0] / 4096.0f;  // +-8 g
  ay = raw[1] / 4096.0f;
  az = raw[2] / 4096.0f;
  float gx = raw[4] / 65.5f, gy = raw[5] / 65.5f, gz = raw[6] / 65.5f;  // +-500 dps
  gyro = sqrtf(gx * gx + gy * gy + gz * gz);
  return true;
}

bool initMpu() {
  if (!mpuWrite(0x6B, 0x00)) return false;  // wake
  mpuWrite(0x1C, 0x10);                     // accel +-8 g (impacts)
  mpuWrite(0x1B, 0x08);                     // gyro +-500 dps
  mpuWrite(0x1A, 0x03);                     // DLPF ~44 Hz
  delay(100);
  // Calibrate "upright" from the resting orientation at boot (spec 5.3.8:
  // "tilt from calibrated upright") - power the bike on standing up.
  float sx = 0, sy = 0, sz = 0;
  int n = 0;
  for (int i = 0; i < 50; i++) {
    float ax, ay, az, g;
    if (mpuRead(ax, ay, az, g)) {
      sx += ax;
      sy += ay;
      sz += az;
      n++;
    }
    delay(10);
  }
  if (n < 10) return false;
  float m = sqrtf(sx * sx + sy * sy + sz * sz);
  if (m < 0.1f) return false;
  g0x = sx / m;
  g0y = sy / m;
  g0z = sz / m;
  return true;
}

TinyGPSPlus gps;

void sensorTask(void*) {
  const TickType_t period = pdMS_TO_TICKS(20);
  TickType_t wake = xTaskGetTickCount();
  float tiltFiltered = 0;
  Bucket cur = {0, 0, 0, 0, 0};
  int ticksInBucket = 0;
  bool btnLast[3] = {true, true, true};
  uint32_t btnChangeAt[3] = {0, 0, 0};
  uint32_t sosDownAt = 0;
  bool sosFired = false;
  const int btnPins[3] = {PIN_IGNITION_BUTTON, PIN_SAFE_BUTTON, PIN_SOS_BUTTON};

  for (;;) {
    vTaskDelayUntil(&wake, period);
    const uint32_t now = millis();

    // --- motion ---
    float ax, ay, az, gyro;
    if (mpuOk && mpuRead(ax, ay, az, gyro)) {
      float mag = sqrtf(ax * ax + ay * ay + az * az);
      float tilt = 0;
      if (mag > 0.2f) {
        float c = (ax * g0x + ay * g0y + az * g0z) / mag;
        c = constrain(c, -1.0f, 1.0f);
        tilt = acosf(c) * 57.2958f;
      }
      tiltFiltered = tiltFiltered * 0.8f + tilt * 0.2f;
      tiltNow = tiltFiltered;
      cur.maxAccelG = max(cur.maxAccelG, mag);
      cur.maxGyroDps = max(cur.maxGyroDps, gyro);
      cur.rotDeg += gyro * 0.02f;
    }
    if (++ticksInBucket >= 5) {  // 100 ms
      cur.tiltDeg = tiltFiltered;
      portENTER_CRITICAL(&mux);
      cur.speedKph = gpsSnap.valid ? gpsSnap.speedKph : 0;
      buckets[bucketHead] = cur;
      bucketHead = (bucketHead + 1) % BUCKETS;
      portEXIT_CRITICAL(&mux);
      cur = {0, 0, 0, 0, 0};
      ticksInBucket = 0;
    }

    // --- GPS ---
    while (gpsSerial.available()) gps.encode(gpsSerial.read());
    if (gps.location.isUpdated()) {
      portENTER_CRITICAL(&mux);
      gpsSnap.valid = gps.location.isValid() && gps.location.age() < 3000;
      if (gpsSnap.valid) {
        gpsSnap.everFixed = true;
        gpsSnap.lat = gps.location.lat();
        gpsSnap.lon = gps.location.lng();
        gpsSnap.speedKph = gps.speed.isValid() ? gps.speed.kmph() : 0;
        gpsSnap.hdop = gps.hdop.isValid() ? gps.hdop.hdop() : 0;
        gpsSnap.sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
        gpsSnap.fixMillis = now;
      }
      portEXIT_CRITICAL(&mux);
    } else if (gpsSnap.valid && now - gpsSnap.fixMillis > 5000) {
      portENTER_CRITICAL(&mux);
      gpsSnap.valid = false;
      portEXIT_CRITICAL(&mux);
    }

    // --- buttons (active low, 30 ms debounce) ---
    for (int i = 0; i < 3; i++) {
      bool level = digitalRead(btnPins[i]);
      if (level != btnLast[i] && now - btnChangeAt[i] > 30) {
        btnLast[i] = level;
        btnChangeAt[i] = now;
        bool pressed = !level;
        // One press = one toggle: ignore ignition presses within 700 ms (seen bouncing on the model).
        static uint32_t lastIgnitionPress = 0;
        if (i == 0 && pressed && now - lastIgnitionPress > 700) {
          lastIgnitionPress = now;
          evIgnition = true;
        }
        if (i == 1 && pressed) evSafe = true;
        if (i == 2) {
          if (pressed) {
            sosDownAt = now;
            sosFired = false;
          } else {
            sosDownAt = 0;
          }
        }
        if (pressed) beep(50);
      }
    }
    // SOS needs a 2 s hold (team decision; spec 5.3.8 said 1 s) so a bump does not call for help.
    if (sosDownAt && !sosFired && now - sosDownAt >= SOS_HOLD_MS) {
      sosFired = true;
      evSos = true;
      beep(400);
    }

    // --- LEDs + buzzer ---
    const Mode m = mode;
    bool green = false, blue = false, red = false, buzz = now < beepUntil;
    switch (m) {
      case BOOTING:
        green = (now / 150) % 2;
        break;
      case MONITORING:
        green = ignitionOn ? true : (now % 2000) < 150;  // solid = ignition ON, blip = parked
        break;
      case FALL_CANDIDATE:
        red = (now / 250) % 2;
        buzz = buzz || (now % 1000) < 60;
        break;
      case AWAITING_RESPONSE:
        red = (now / 125) % 2;
        buzz = buzz || (now % 1000) < 200;  // "are you safe?" - press SAFE or answer the app
        break;
      case ESCALATED:
        red = true;
        buzz = buzz || (now % 4000) < 120;
        break;
      case RESOLVED:
      case REARM_WAIT:
        green = (now / 100) % 2;
        break;
    }
    blue = netBusy ? (now / 60) % 2 : netOk;
    digitalWrite(PIN_GREEN_LED, green);
    digitalWrite(PIN_BLUE_LED, blue);
    digitalWrite(PIN_RED_LED, red);
    digitalWrite(PIN_BUZZER, buzz);
  }
}

GpsSnapshot gpsCopy() {
  portENTER_CRITICAL(&mux);
  GpsSnapshot s = gpsSnap;
  portEXIT_CRITICAL(&mux);
  return s;
}

struct Peaks {
  float accelG = 0, gyroDps = 0, maxTilt = 0, rot2s = 0;
};
Peaks motionPeaks() {
  Peaks p;
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < BUCKETS; i++) {
    const Bucket& b = buckets[i];
    p.accelG = max(p.accelG, b.maxAccelG);
    p.gyroDps = max(p.gyroDps, b.maxGyroDps);
    p.maxTilt = max(p.maxTilt, b.tiltDeg);
  }
  // Rotation over the most recent 2 s (20 buckets).
  for (int k = 1; k <= 20; k++) p.rot2s += buckets[(bucketHead - k + BUCKETS) % BUCKETS].rotDeg;
  portEXIT_CRITICAL(&mux);
  return p;
}

// ============================================================================
// SIM800L
// ============================================================================

String simRead(uint32_t ms, const char* until1 = "OK", const char* until2 = "ERROR") {
  String out;
  uint32_t start = millis();
  while (millis() - start < ms) {
    while (sim.available()) out += char(sim.read());
    if ((until1 && out.indexOf(until1) >= 0) || (until2 && out.indexOf(until2) >= 0)) break;
    delay(5);
  }
  return out;
}

String at(const String& cmd, uint32_t ms = 2000, const char* until = "OK") {
  while (sim.available()) sim.read();
  sim.println(cmd);
  return simRead(ms, until, "ERROR");
}

int csqCache = -1;
bool modemOk = false;

constexpr uint32_t MODEM_FAST_BAUD = 57600;
uint32_t modemBaud = 9600;

bool modemAt(uint32_t baud, int tries) {
  sim.updateBaudRate(baud);
  delay(50);
  String r;
  for (int i = 0; i < tries && r.indexOf("OK") < 0; i++) r = at("AT", 600);
  return r.indexOf("OK") >= 0;
}

void modemInit() {
  // Speed: 9600 baud moves ~1 KB/s, so a heartbeat body alone cost a second.
  // The modem may already be at the fast rate (the ESP32 rebooted, the modem
  // did not), so look for it at both rates, then switch up for this session.
  // AT+IPR without AT&W is volatile: a modem power cycle falls back safely.
  if (modemAt(9600, 6)) modemBaud = 9600;
  else if (modemAt(MODEM_FAST_BAUD, 4)) modemBaud = MODEM_FAST_BAUD;
  else modemBaud = 0;
  modemOk = modemBaud != 0;
  if (!modemOk) {
    sim.updateBaudRate(9600);
    logf("SIM800L: no reply - SMS will not work");
    return;
  }
  if (modemBaud != MODEM_FAST_BAUD) {
    at("AT+IPR=" + String(MODEM_FAST_BAUD));
    if (modemAt(MODEM_FAST_BAUD, 4)) {
      modemBaud = MODEM_FAST_BAUD;
    } else {
      modemAt(9600, 4);  // the modem did not follow; stay slow but working
    }
  }
  logf("SIM800L UART %lu baud", modemBaud);
  at("ATE0");
  at("AT+CMGF=1");          // SMS text mode
  at("AT+CSCS=\"GSM\"");
  at("AT+CNMI=0,0,0,0,0");  // do not push incoming SMS onto the UART
  String csq = at("AT+CSQ");
  int idx = csq.indexOf("+CSQ: ");
  csqCache = idx >= 0 ? csq.substring(idx + 6).toInt() : -1;
  logf("SIM800L ready, CSQ %d, %s", csqCache, at("AT+CREG?").indexOf(",1") >= 0 ? "registered" : "not registered");
}

struct SmsResult {
  String state;  // AT_SUBMITTED | FAILED | OUTCOME_UNKNOWN
  String detail;
};

SmsResult sendSms(const String& number, const String& text) {
  if (!modemOk || number.isEmpty()) return {"FAILED", "no modem or number"};
  // Seen on the real bike: the first CMGS right after other traffic can miss its
  // "> " prompt. Re-sync and retry the prompt a few times before calling it failed.
  bool prompted = false;
  for (int i = 0; i < 3 && !prompted; i++) {
    at("AT", 500);
    at("AT+CMGF=1");
    prompted = at("AT+CMGS=\"" + number + "\"", 5000, ">").indexOf(">") >= 0;
    if (!prompted) {
      sim.write(0x1B);  // ESC cancels a half-open send
      delay(500);
    }
  }
  if (!prompted) return {"FAILED", "no prompt"};
  sim.print(text);
  sim.write(0x1A);
  String r = simRead(30000, "+CMGS:", "ERROR");
  int idx = r.indexOf("+CMGS:");
  if (idx >= 0) {
    r += simRead(2000);  // the message reference arrives after "+CMGS:"
    int end = r.indexOf('\r', idx);
    String ref = r.substring(idx, end > 0 ? end : r.length());
    ref.trim();
    return {"AT_SUBMITTED", ref};  // the network took it; not proof of delivery
  }
  if (r.indexOf("ERROR") >= 0) return {"FAILED", "CMGS ERROR"};
  return {"OUTCOME_UNKNOWN", "no +CMGS within 30 s"};
}

// ============================================================================
// Transport: Wi-Fi (dev) or SIM800L GPRS (demo). Both sign the same way.
// ============================================================================

struct HttpResult {
  int status = 0;
  String body;
};

bool wifiJoin(const char* ssid, const char* pass, uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

#if CL_TRANSPORT == CL_TRANSPORT_WIFI
bool ensureLink() {
  if (WiFi.status() == WL_CONNECTED) return true;
  logf("Wi-Fi: joining %s", CL_WIFI_SSID);
  bool ok = wifiJoin(CL_WIFI_SSID, CL_WIFI_PASSWORD, 15000);
  if (ok) logf("Wi-Fi: connected, IP %s", WiFi.localIP().toString().c_str());
  return ok;
}

HttpResult httpRaw(const char* method, const String& url, const uint8_t* body, size_t len, const char* contentType) {
  HttpResult r;
  if (!ensureLink()) return r;
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(url);
  if (body) http.addHeader("Content-Type", contentType);
  r.status = strcmp(method, "GET") == 0 ? http.GET() : http.sendRequest(method, (uint8_t*)body, len);
  if (r.status > 0) r.body = http.getString();
  http.end();
  return r;
}
#else
String oneLine(String s) {
  s.replace("\r", " ");
  s.replace("\n", " ");
  s.trim();
  return s;
}

// Speed: after a recent success, skip the bearer check and reuse the open HTTP
// session - each saves several AT round trips per request.
uint32_t lastHttpOk = 0;
bool httpSessionOpen = false;

bool ensureLink() {
  if (lastHttpOk && millis() - lastHttpOk < 30000) return true;
  String st = at("AT+SAPBR=2,1");
  if (st.indexOf("+SAPBR: 1,1") >= 0) return true;
  httpSessionOpen = false;
  // Log why, so a failed link is diagnosable from the serial monitor.
  static uint32_t lastDiag = 0;
  const bool diag = millis() - lastDiag > 15000;
  if (diag) {
    lastDiag = millis();
    logf("GPRS down: %s | %s | %s | %s", oneLine(at("AT+CSQ")).c_str(), oneLine(at("AT+CREG?")).c_str(),
         oneLine(at("AT+CGATT?")).c_str(), oneLine(st).c_str());
  }
  if (at("AT+CREG?").indexOf(",1") < 0 && at("AT+CREG?").indexOf(",5") < 0) return false;  // not on the network yet
  // Appendix E.1.4: open once, check before use, reopen only on failure.
  at("AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"");
  at(String("AT+SAPBR=3,1,\"APN\",\"") + CL_APN + "\"");
  String open = at("AT+SAPBR=1,1", 85000);
  bool ok = at("AT+SAPBR=2,1").indexOf("+SAPBR: 1,1") >= 0;
  logf("GPRS bearer open: %s (%s)", ok ? "OK" : "FAILED", oneLine(open).c_str());
  return ok;
}

/** SIM800L HTTP: only GET and POST exist (AT+HTTPACTION 0/1) - the server accepts POST for PUT routes. */
HttpResult httpRaw(const char* method, const String& url, const uint8_t* body, size_t len, const char* contentType) {
  HttpResult r;
  if (!ensureLink()) return r;
  const bool post = strcmp(method, "GET") != 0;
  // Any failure below closes the session so the next request starts clean.
  auto fail = [&]() -> HttpResult {
    at("AT+HTTPTERM", 1000);
    httpSessionOpen = false;
    lastHttpOk = 0;
    return r;
  };
  if (!httpSessionOpen) {
  at("AT+HTTPTERM", 1000);
  if (at("AT+HTTPINIT").indexOf("OK") < 0) {
    // Seen on the real bike: after a brown-out mid-request the HTTP stack stays
    // "busy" (604) until the modem is reset. Terminate, retry, then full reset.
    at("AT+HTTPTERM", 1000);
    if (at("AT+HTTPINIT").indexOf("OK") < 0) {
      logf("HTTP stack stuck - resetting modem (AT+CFUN=1,1)");
      at("AT+CFUN=1,1", 3000);
      delay(8000);
      modemInit();  // the reset drops the fast baud rate; find the modem again
      for (int i = 0; i < 20 && at("AT+CREG?").indexOf(",1") < 0; i++) delay(1500);
      lastHttpOk = 0;
      return r;  // the caller retries on its next cycle, with a fresh bearer
    }
  }
  at("AT+HTTPPARA=\"CID\",1");
  at("AT+HTTPSSL=0");
  httpSessionOpen = true;
  }
  // A reused session can vanish (modem reset, SMS reboot): fail fast, not after 60 s.
  if (at("AT+HTTPPARA=\"URL\",\"" + url + "\"").indexOf("OK") < 0) return fail();
  if (post) {
    at(String("AT+HTTPPARA=\"CONTENT\",\"") + contentType + "\"");
    if (at("AT+HTTPDATA=" + String(len) + ",20000", 5000, "DOWNLOAD").indexOf("DOWNLOAD") < 0) return fail();
    for (size_t off = 0; off < len; off += 512) {
      sim.write(body + off, min((size_t)512, len - off));
      delay(2);
    }
    simRead(20000);
  }
  if (at(post ? "AT+HTTPACTION=1" : "AT+HTTPACTION=0").indexOf("ERROR") >= 0) return fail();
  String act = simRead(60000, "+HTTPACTION:", nullptr);
  int idx = act.indexOf("+HTTPACTION:");
  if (idx < 0) {
    // "Call Ready"/"SMS Ready" here is the modem's boot banner: it browned out
    // mid-transfer. Put a 470-1000 uF capacitor across SIM800L VCC/GND.
    const bool rebooted = act.indexOf("Call Ready") >= 0 || act.indexOf("SMS Ready") >= 0 || act.indexOf("RDY") >= 0;
    logf("HTTP: no +HTTPACTION%s (%s)", rebooted ? " - MODEM REBOOTED (power dip)" : "", oneLine(act).substring(0, 80).c_str());
    if (rebooted) modemInit();  // it came back at its default rate
    return fail();
  }
  // +HTTPACTION: <method>,<status>,<length> - the match fires on the prefix, so
  // wait for the rest of the line before parsing (seen on the real bike).
  uint32_t lineStart = millis();
  while (act.indexOf('\n', idx) < 0 && millis() - lineStart < 2000) {
    while (sim.available()) act += char(sim.read());
    delay(5);
  }
  int c1 = act.indexOf(',', idx), c2 = act.indexOf(',', c1 + 1);
  r.status = act.substring(c1 + 1, c2).toInt();
  int bodyLen = act.substring(c2 + 1).toInt();
  if (bodyLen > 0) {
    while (sim.available()) sim.read();
    sim.println("AT+HTTPREAD");
    String raw = simRead(20000, "\r\nOK\r\n", "ERROR");
    int h = raw.indexOf("+HTTPREAD:");
    if (h >= 0) {
      int start = raw.indexOf('\n', h) + 1;
      r.body = raw.substring(start, start + bodyLen);
    }
  }
  // Session stays open for the next request (no HTTPTERM/HTTPINIT round trips).
  if (r.status > 0) lastHttpOk = millis();
  else return fail();
  return r;
}
#endif

/** Appendix E.1.2: auth in the query string; canonical METHOD\npath\ndev\nts\nnonce\nsha256(body). */
HttpResult deviceRequest(const char* method, const String& path, const uint8_t* body, size_t len,
                         const char* contentType = "application/json") {
  const String ts = String((long)nowEpoch());
  const String nonce = randomHex(8);
  const String canonical = String(method) + "\n" + path + "\n" + CL_DEVICE_CODE + "\n" + ts + "\n" + nonce + "\n" +
                           sha256Hex(body ? body : (const uint8_t*)"", body ? len : 0);
  const String url = String(CL_API_BASE) + path + "?dev=" + CL_DEVICE_CODE + "&ts=" + ts + "&nonce=" + nonce +
                     "&sig=" + hmacHex(CL_DEVICE_SECRET, canonical);
  netBusy = true;
  const uint32_t started = millis();
  HttpResult r = httpRaw(method, url, body, len, contentType);
  netBusy = false;
  netOk = r.status >= 200 && r.status < 500;
  const String shortPath = path.length() > 40 ? path.substring(0, 22) + "..." + path.substring(path.length() - 12) : path;
  if (r.status != 200) logf("%s %s -> %d in %lu ms %s", method, shortPath.c_str(), r.status, millis() - started, r.body.substring(0, 120).c_str());
  else logf("%s %s -> 200 in %lu ms (%u B)", method, shortPath.c_str(), millis() - started, (unsigned)len);
  return r;
}

HttpResult deviceJson(const char* method, const String& path, JsonDocument& doc) {
  String body;
  serializeJson(doc, body);
  return deviceRequest(method, path, (const uint8_t*)body.c_str(), body.length());
}

bool syncClock() {
  HttpResult r;
#if CL_TRANSPORT == CL_TRANSPORT_WIFI
  netBusy = true;
  r = httpRaw("GET", String(CL_API_BASE) + "/d/v1/time", nullptr, 0, nullptr);
  netBusy = false;
#else
  r = httpRaw("GET", String(CL_API_BASE) + "/d/v1/time", nullptr, 0, nullptr);
#endif
  if (r.status != 200) {
    logf("clock sync failed (%d) - is the API reachable at %s?", r.status, CL_API_BASE);
    netOk = false;
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, r.body)) return false;
  epochAtSync = doc["epoch"].as<int64_t>();
  millisAtSync = millis();
  clockSynced = true;
  netOk = true;
  logf("clock synced: %s", isoNow().c_str());
  return true;
}

// ============================================================================
// Commands (piggybacked on every response, spec 5.3.4)
// ============================================================================

void ackCommand(const String& id, const char* result, int assignmentVersion = -1, int cfgVersion = -1, const char* reason = nullptr) {
  JsonDocument doc;
  doc["result"] = result;
  if (assignmentVersion >= 0) doc["assignmentVersion"] = assignmentVersion;
  if (cfgVersion >= 0) doc["configVersion"] = cfgVersion;
  if (reason) doc["reason"] = reason;
  deviceJson("POST", "/d/v1/commands/" + id + "/ack", doc);
}

void applyCommands(JsonVariantConst commands) {
  if (!commands.is<JsonArrayConst>()) return;
  for (JsonVariantConst c : commands.as<JsonArrayConst>()) {
    const String id = c["id"] | "";
    const String type = c["type"] | "";
    JsonVariantConst payload = c["payload"];
    if (type == "SET_ASSIGNMENT") {
      String json;
      serializeJson(payload, json);
      nvs.putString("asgJson", json);  // persist first, ack second (a reboot must not lose the rider)
      loadAssignment();
      logf("SET_ASSIGNMENT v%d: rider %s, contact %s", assignment.version, assignment.driverName.c_str(), assignment.contactName.c_str());
      beep(150);
      ackCommand(id, "APPLIED", assignment.version);
    } else if (type == "CLEAR_ASSIGNMENT") {
      nvs.remove("asgJson");
      loadAssignment();
      logf("CLEAR_ASSIGNMENT - rental ended");
      ackCommand(id, "APPLIED", payload["assignmentVersion"] | 0);
    } else if (type == "SET_CONFIG") {
      configVersion = payload["configVersion"] | configVersion;
      nvs.putInt("cfgVer", configVersion);
      logf("SET_CONFIG v%d (fall 10 s / window 60 s stay fixed)", configVersion);
      ackCommand(id, "APPLIED", -1, configVersion);
    } else if (type == "INCIDENT_DECISION") {
      // Acked through the incident's control route by the incident flow.
    } else {
      logf("command %s not supported", type.c_str());
      ackCommand(id, "REJECTED", -1, -1, "NOT_SUPPORTED");
    }
  }
}

// ============================================================================
// Heartbeat (spec 5.3.3)
// ============================================================================

struct IgnitionEvent {
  bool on;
  int64_t at;
};
IgnitionEvent ignitionEvents[20];
int ignitionEventCount = 0;
int64_t ignitionChangedAt = 0;
bool cameraLink = false;
String activeEventId;

void heartbeat() {
  if (!clockSynced && !syncClock()) return;
  JsonDocument doc;
  doc["schema"] = 1;
  doc["deviceTime"] = isoNow();
  doc["timeSource"] = "SERVER_SYNC";
  doc["fw"] = FW_VERSION;
  if (assignment.present) doc["assignmentVersion"] = assignment.version;
  else doc["assignmentVersion"] = nullptr;
  doc["configVersion"] = configVersion;
  JsonObject ign = doc["ignition"].to<JsonObject>();
  ign["state"] = ignitionOn ? "ON" : "OFF";
  if (ignitionChangedAt) ign["changedAt"] = isoFromEpoch(ignitionChangedAt);
  else ign["changedAt"] = nullptr;
  JsonArray evs = doc["ignitionEvents"].to<JsonArray>();
  for (int i = 0; i < ignitionEventCount; i++) {
    JsonObject e = evs.add<JsonObject>();
    e["state"] = ignitionEvents[i].on ? "ON" : "OFF";
    e["t"] = isoFromEpoch(ignitionEvents[i].at);
  }
  JsonArray fixes = doc["fixes"].to<JsonArray>();
  GpsSnapshot g = gpsCopy();
  if (g.valid) {
    JsonObject f = fixes.add<JsonObject>();
    f["t"] = isoFromEpoch(epochAtMillis(g.fixMillis));
    f["lat"] = g.lat;
    f["lon"] = g.lon;
    f["spd"] = g.speedKph;
    f["hdop"] = g.hdop;
    f["sat"] = g.sats;
    f["valid"] = true;
    f["src"] = "GPS";
  }
  doc["events"].to<JsonArray>();
  JsonObject h = doc["health"].to<JsonObject>();
  h["csq"] = csqCache >= 0 ? csqCache : (int)-1;
  if (csqCache < 0) h["csq"] = nullptr;
  h["gprs"] = CL_TRANSPORT == CL_TRANSPORT_GPRS && netOk;
  h["gpsFix"] = g.valid;
  h["sats"] = g.sats;
  if (g.valid) h["hdop"] = g.hdop;
  else h["hdop"] = nullptr;
  h["cameraLink"] = cameraLink;
  h["batteryV"] = nullptr;  // M10: never measured
  h["freeHeap"] = (int)ESP.getFreeHeap();
  h["uptimeS"] = (int)(millis() / 1000);
  h["queuedJobs"] = 0;
  h["demoMode"] = false;
  h["resetReason"] = String((int)esp_reset_reason());
  JsonObject st = doc["state"].to<JsonObject>();
  st["mode"] = modeName(mode);
  if (activeEventId.length()) st["activeEventId"] = activeEventId;
  else st["activeEventId"] = nullptr;

  HttpResult r = deviceJson("POST", "/d/v1/heartbeat", doc);
  if (r.status == 200) {
    ignitionEventCount = 0;
    JsonDocument resp;
    if (!deserializeJson(resp, r.body)) {
      applyCommands(resp["commands"]);
      // No fix of our own this boot: remember the server's last known GPS
      // position, so an SMS says "LAST KNOWN 13:59" rather than "unavailable".
      JsonVariantConst lk = resp["lastKnown"];
      if (lk.is<JsonObjectConst>() && !gpsCopy().everFixed) {
        const int64_t at = epochFromIso(lk["fixAt"] | "");
        if (at > 0 && at > nvs.getLong64("lkAt", 0)) {
          nvs.putDouble("lkLat", lk["lat"] | 0.0);
          nvs.putDouble("lkLon", lk["lon"] | 0.0);
          nvs.putLong64("lkAt", at);
        }
      }
    }
  } else if (r.status == 401) {
    clockSynced = false;  // a stale clock is the usual cause; resync next time
  }
}

// ============================================================================
// Camera (ESP32-CAM softAP, signed capture)
// ============================================================================

uint8_t* photo = nullptr;
size_t photoLen = 0;
String photoSha;

void rejoinHomeLink() {
#if CL_TRANSPORT == CL_TRANSPORT_WIFI
  WiFi.disconnect(true);
  ensureLink();
#else
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
#endif
}

bool capturePhoto(const String& eventId) {
  if (photo) {
    free(photo);
    photo = nullptr;
    photoLen = 0;
  }
  const String ssid = String("CL-") + CL_DEVICE_CODE;
  WiFi.disconnect(true);
  delay(100);
  bool ok = false;
  if (wifiJoin(ssid.c_str(), CL_AP_PASSWORD, 10000)) {
    const String nonce = randomHex(8);
    HTTPClient http;
    http.setTimeout(10000);
    http.begin("http://192.168.4.1/capture?eventId=" + eventId + "&nonce=" + nonce + "&sig=" + hmacHex(CL_CAMERA_SECRET, eventId + nonce));
    const char* keys[] = {"X-SHA256"};
    http.collectHeaders(keys, 1);
    int code = http.GET();
    int len = http.getSize();
    if (code == 200 && len > 0 && len <= 10240) {
      photo = (uint8_t*)malloc(len);
      WiFiClient* stream = http.getStreamPtr();
      size_t got = 0;
      uint32_t start = millis();
      while (photo && got < (size_t)len && millis() - start < 8000) {
        int n = stream->readBytes(photo + got, len - got);
        if (n > 0) got += n;
      }
      if (photo && got == (size_t)len && photo[0] == 0xFF && photo[1] == 0xD8 && photo[len - 2] == 0xFF && photo[len - 1] == 0xD9) {
        photoLen = len;
        photoSha = sha256Hex(photo, photoLen);
        ok = photoSha == http.header("X-SHA256");
      }
    } else {
      logf("camera capture HTTP %d (%d bytes)", code, len);
    }
    http.end();
  } else {
    logf("camera: could not join %s", ssid.c_str());
  }
  cameraLink = ok;
  if (!ok && photo) {
    free(photo);
    photo = nullptr;
    photoLen = 0;
  }
  rejoinHomeLink();
  logf("camera: %s", ok ? (String(photoLen) + " bytes, sha " + photoSha.substring(0, 12)).c_str() : "no photo");
  return ok;
}

bool probeCamera() {
  const String ssid = String("CL-") + CL_DEVICE_CODE;
  WiFi.disconnect(true);
  delay(100);
  bool ok = false;
  if (wifiJoin(ssid.c_str(), CL_AP_PASSWORD, 10000)) {
    HTTPClient http;
    http.begin("http://192.168.4.1/health");
    ok = http.GET() == 200 && http.getString().indexOf("\"camera\":true") >= 0;
    http.end();
  }
  cameraLink = ok;
  logf("camera link: %s", ok ? "OK" : "not reachable");
  rejoinHomeLink();
  return ok;
}

bool uploadPhoto(const String& eventId) {
  if (!photo || !photoLen) return false;
  JsonDocument s;
  s["schema"] = 1;
  s["bytes"] = photoLen;
  s["sha256"] = photoSha;
  s["chunkSize"] = IMAGE_CHUNK;
  s["mime"] = "image/jpeg";
  HttpResult r = deviceJson("POST", "/d/v1/incidents/" + eventId + "/image/session", s);
  if (r.status != 200) return false;
  JsonDocument resp;
  deserializeJson(resp, r.body);
  const String sessionId = resp["sessionId"] | "";
  size_t offset = resp["nextOffset"] | 0;
  while (offset < photoLen) {
    size_t n = min(IMAGE_CHUNK, photoLen - offset);
    // POST, not PUT: the SIM800L cannot send PUT (server accepts both).
    HttpResult c = deviceRequest("POST", "/d/v1/images/" + sessionId + "/chunks/" + String(offset), photo + offset, n,
                                 "application/octet-stream");
    if (c.status != 200) return false;
    JsonDocument cr;
    deserializeJson(cr, c.body);
    offset = cr["nextOffset"] | (offset + n);
  }
  JsonDocument done;
  HttpResult f = deviceJson("POST", "/d/v1/images/" + sessionId + "/complete", done);
  logf("photo upload: %s", f.status == 200 ? f.body.substring(0, 80).c_str() : "failed");
  return f.status == 200;
}

// ============================================================================
// Incident flow
// ============================================================================

const char* smsLabel(const String& type) {
  if (type == "POSSIBLE_COLLISION") return "Possible collision";
  if (type == "POSSIBLE_LOW_SPEED_RIDER_DROP") return "Possible rider drop";
  if (type == "POSSIBLE_ROLLOVER") return "Possible rollover";
  if (type == "MANUAL_SOS") return "SOS pressed";
  if (type == "PARKED_BIKE_FALL") return "Possible parked bike fall";
  return "Possible incident";
}

String shortName(const String& s) { return s.length() > 12 ? s.substring(0, 12) : s; }

String mapsOrNone(const GpsSnapshot& g) {
  if (!g.everFixed) return "Location unavailable. Check CrashLink app.";
  char buf[64];
  snprintf(buf, sizeof buf, "maps.google.com/?q=%.5f,%.5f", g.lat, g.lon);
  return String(buf);
}

/** spec 5.3.10: "LIVE loc <link>" / "LAST KNOWN 11:29 <link>" / "Location unavailable...". */
String locationText(const GpsSnapshot& g, int64_t atEpoch) {
  if (!g.everFixed) return mapsOrNone(g);
  const int64_t fixEpoch = g.fixEpoch ? g.fixEpoch : epochAtMillis(g.fixMillis);
  if (atEpoch - fixEpoch <= 30) return "LIVE loc " + mapsOrNone(g);
  return "LAST KNOWN " + colomboTime(fixEpoch).substring(0, 5) + " " + mapsOrNone(g);
}

// --- Last known fix, remembered across reboots (a cold GPS indoors takes minutes) ---
GpsSnapshot lastKnownFix() {
  GpsSnapshot s;
  if (!nvs.isKey("lkAt")) return s;
  s.lat = nvs.getDouble("lkLat", 0);
  s.lon = nvs.getDouble("lkLon", 0);
  s.fixEpoch = nvs.getLong64("lkAt", 0);
  s.everFixed = s.fixEpoch > 0;
  return s;
}

void rememberFix() {
  static uint32_t lastSaved = 0;
  if (!clockSynced || (lastSaved && millis() - lastSaved < 300000)) return;  // every 5 min: spare the flash
  GpsSnapshot g = gpsCopy();
  if (!g.valid) return;
  nvs.putDouble("lkLat", g.lat);
  nvs.putDouble("lkLon", g.lon);
  nvs.putLong64("lkAt", epochAtMillis(g.fixMillis));
  lastSaved = millis();
}

// A photo whose upload failed is retried from the monitoring loop until it lands.
String pendingPhotoEvent;
uint32_t lastPhotoTry = 0;

void reportSms(const String& eventId, const char* kind, int attempt, const SmsResult& r) {
  JsonDocument doc;
  doc["schema"] = 1;
  doc["kind"] = kind;
  doc["attemptNo"] = attempt;
  doc["state"] = r.state;
  doc["detail"] = r.detail;
  doc["deviceTime"] = isoNow();
  deviceJson("POST", "/d/v1/incidents/" + eventId + "/notifications", doc);
}

/** Up to 3 attempts, 10 s apart; never retried once AT_SUBMITTED (spec 5.3.7). */
bool smsWithReporting(const String& eventId, const char* kind, const String& number, String text) {
  if (text.length() > 160) text.replace(" Ambulance 1990", "");
  if (text.length() > 160) text = text.substring(0, 160);
  reportSms(eventId, kind, 1, {"QUEUED", ""});
  for (int attempt = 1; attempt <= 3; attempt++) {
    logf("SMS %s -> %s: %s", kind, number.c_str(), text.c_str());
    SmsResult r = sendSms(number, text);
    reportSms(eventId, kind, attempt, r);
    logf("SMS %s: %s %s", kind, r.state.c_str(), r.detail.c_str());
    if (r.state != "FAILED") return r.state == "AT_SUBMITTED";
    delay(10000);
  }
  return false;
}

struct UpsertResult {
  bool ok = false;
  bool serverQuestion = false;
  int64_t deadlineEpoch = 0;
  String decision;
};

UpsertResult upsertIncident(const String& eventId, const String& type, int64_t occurredAt, bool ign, float preSpeed,
                            bool preSpeedKnown, const Peaks& p, uint32_t fallenMs, const GpsSnapshot& g, const char* photoStatus,
                            const char* localDecision, const char* localSource, int64_t decidedAt) {
  JsonDocument doc;
  doc["schema"] = 1;
  doc["eventId"] = eventId;
  if (assignment.present) {
    doc["rentalId"] = assignment.rentalId;
    doc["assignmentVersion"] = assignment.version;
  } else {
    doc["rentalId"] = nullptr;
    doc["assignmentVersion"] = nullptr;
  }
  doc["type"] = type;
  doc["occurredAt"] = isoFromEpoch(occurredAt);
  doc["timeSource"] = "SERVER_SYNC";
  doc["ignition"] = ign ? "ON" : "OFF";
  if (preSpeedKnown) doc["preEventSpeedKph"] = preSpeed;
  else doc["preEventSpeedKph"] = nullptr;
  JsonObject ev = doc["evidence"].to<JsonObject>();
  ev["fallenDurationMs"] = fallenMs;
  ev["peakAccelerationG"] = roundf(p.accelG * 100) / 100;
  ev["peakRotationDps"] = roundf(p.gyroDps);
  ev["maxTiltDeg"] = roundf(p.maxTilt);
  ev["simulated"] = false;

  // Black box: the last 5 s at 5 Hz (pairs of 100 ms buckets).
  JsonObject w = doc["sensorWindow"].to<JsonObject>();
  w["hz"] = 5;
  w["t0"] = isoFromEpoch(occurredAt - 5);
  JsonArray a = w["a"].to<JsonArray>(), gy = w["g"].to<JsonArray>(), tl = w["tilt"].to<JsonArray>(), sp = w["spd"].to<JsonArray>();
  portENTER_CRITICAL(&mux);
  Bucket copy[BUCKETS];
  int head = bucketHead;
  memcpy(copy, buckets, sizeof copy);
  portEXIT_CRITICAL(&mux);
  for (int k = 0; k < BUCKETS; k += 2) {
    const Bucket& b1 = copy[(head + k) % BUCKETS];
    const Bucket& b2 = copy[(head + k + 1) % BUCKETS];
    a.add(roundf(max(b1.maxAccelG, b2.maxAccelG) * 100) / 100);
    gy.add(roundf(max(b1.maxGyroDps, b2.maxGyroDps)));
    tl.add(roundf(b2.tiltDeg));
    sp.add(roundf(b2.speedKph * 10) / 10);
  }

  JsonObject loc = doc["location"].to<JsonObject>();
  if (g.everFixed) {
    int64_t fixEpoch = g.fixEpoch ? g.fixEpoch : epochAtMillis(g.fixMillis);
    int age = (int)max((int64_t)0, occurredAt - fixEpoch);
    loc["kind"] = age <= 30 ? "LIVE" : "LAST_KNOWN";
    loc["lat"] = g.lat;
    loc["lon"] = g.lon;
    loc["fixAt"] = isoFromEpoch(fixEpoch);
    loc["ageSecondsAtEvent"] = age;
    loc["src"] = "GPS";
  } else {
    loc["kind"] = "UNAVAILABLE";
    loc["lat"] = nullptr;
    loc["lon"] = nullptr;
    loc["fixAt"] = nullptr;
    loc["ageSecondsAtEvent"] = nullptr;
    loc["src"] = nullptr;
  }
  doc["photoStatus"] = photoStatus;
  if (localDecision) {
    JsonObject ld = doc["localDecision"].to<JsonObject>();
    ld["decision"] = localDecision;
    ld["source"] = localSource;
    ld["decidedAt"] = isoFromEpoch(decidedAt);
  } else {
    doc["localDecision"] = nullptr;
  }
  if (assignment.present) {
    JsonObject rc = doc["recipients"].to<JsonObject>();
    rc["ownerPhoneLast4"] = assignment.ownerPhone.substring(assignment.ownerPhone.length() - 4);
    rc["contactPhoneLast4"] = assignment.contactPhone.substring(assignment.contactPhone.length() - 4);
  }

  UpsertResult out;
  for (int attempt = 0; attempt < 3 && !out.ok; attempt++) {
    // POST (not PUT) so the same code works over the SIM800L.
    HttpResult r = deviceJson("POST", "/d/v1/incidents/" + eventId, doc);
    if (r.status == 200) {
      JsonDocument resp;
      if (!deserializeJson(resp, r.body)) {
        out.ok = true;
        out.serverQuestion = resp["serverQuestion"] | false;
        out.deadlineEpoch = epochFromIso(resp["responseDeadlineAt"] | "");
        out.decision = resp["decision"] | "";
        applyCommands(resp["commands"]);
      }
    } else if (r.status >= 400 && r.status < 500 && r.status != 401 && r.status != 429) {
      break;  // a validation error will not fix itself on retry
    } else {
      delay(1500);
    }
  }
  return out;
}

struct Control {
  bool ok = false;
  String decision, commandId;
};

Control pollControl(const String& eventId) {
  Control c;
  HttpResult r = deviceRequest("GET", "/d/v1/incidents/" + eventId + "/control", nullptr, 0);
  if (r.status != 200) return c;
  JsonDocument doc;
  if (deserializeJson(doc, r.body)) return c;
  c.ok = true;
  c.decision = doc["decision"] | "";
  c.commandId = doc["commandId"] | "";
  return c;
}

/** D5: the local button. Returns the decision that stands. */
String localResponse(const String& eventId, const char* choice) {
  JsonDocument doc;
  doc["choice"] = choice;
  doc["deviceTime"] = isoNow();
  doc["idempotencyKey"] = eventId.substring(0, 18) + "-" + choice + "-" + randomHex(3);
  HttpResult r = deviceJson("POST", "/d/v1/incidents/" + eventId + "/local-response", doc);
  if (r.status != 200) return "";
  JsonDocument resp;
  deserializeJson(resp, r.body);
  bool accepted = resp["accepted"] | false;
  String decision = resp["decision"] | "";
  logf("local %s -> %s (%s)", choice, decision.c_str(), accepted ? "accepted" : (const char*)(resp["reason"] | "refused"));
  return decision;
}

void ackDecision(const String& eventId, const String& commandId, const char* localState) {
  if (commandId.isEmpty()) return;
  JsonDocument doc;
  doc["applied"] = true;
  doc["localState"] = localState;
  deviceJson("POST", "/d/v1/incidents/" + eventId + "/control/" + commandId + "/ack", doc);
}

// --- Active incident in NVS (spec Appendix E: evtId/evtJson) ------------------
// Seen on the real bike: a restart mid-incident (power dip on an SMS burst)
// lost the pending contact SMS. The incident is saved, and resumed at boot.
void saveActiveIncident(const String& eventId, const String& type, int64_t occurredAt, int64_t deadline) {
  nvs.putString("evtId", eventId);
  nvs.putString("evtType", type);
  nvs.putLong64("evtAt", occurredAt);
  nvs.putLong64("evtDl", deadline);
  nvs.putBool("evtCS", false);
}
void markContactSmsSent() { nvs.putBool("evtCS", true); }
void clearActiveIncident() {
  nvs.remove("evtId");
  nvs.remove("evtType");
  nvs.remove("evtAt");
  nvs.remove("evtDl");
  nvs.remove("evtCS");
}

String contactSmsText(const String& when, const String& maps, const String& decision) {
  String why = decision == "HELP" ? " Rider asked for help." : " No reply to safety check.";
  return String("CRASHLINK: ") + shortName(assignment.driverName) + " may need help. Possible bike accident " + when + " " + maps +
         why + " Ambulance 1990";
}

/** After a restart: finish an incident that was cut short, so the contact is never left unwarned. */
void resumeActiveIncident() {
  if (!nvs.isKey("evtId")) return;
  const String eventId = nvs.getString("evtId", "");
  const int64_t occurredAt = nvs.getLong64("evtAt", 0);
  const int64_t deadline = nvs.getLong64("evtDl", 0);
  const bool contactSent = nvs.getBool("evtCS", false);
  if (eventId.isEmpty() || contactSent || !clockSynced || nowEpoch() - occurredAt > 1800) {
    clearActiveIncident();
    return;
  }
  logf("RESUMING incident %s after a restart", eventId.substring(0, 8).c_str());
  activeEventId = eventId;
  mode = AWAITING_RESPONSE;
  String decision, commandId;
  const int64_t graceEnd = (deadline ? deadline : occurredAt + RESPONSE_WINDOW_MS / 1000) + DEADLINE_GRACE_MS / 1000;
  bool reachedServer = false;
  while (decision.isEmpty()) {
    if (evSafe) {
      evSafe = false;
      String d = localResponse(eventId, "SAFE");
      decision = d.length() && d != "PENDING" ? d : "SAFE";
      break;
    }
    Control c = pollControl(eventId);
    if (c.ok) {
      reachedServer = true;
      if (c.decision != "PENDING" && c.decision != "NOT_APPLICABLE") {
        decision = c.decision;
        commandId = c.commandId;
        break;
      }
    }
    if (nowEpoch() >= graceEnd && !reachedServer) decision = "OFFLINE_FALLBACK";
    if (nowEpoch() >= graceEnd + 120) decision = "OFFLINE_FALLBACK";  // never wait forever
    delay(CONTROL_POLL_MS);
  }
  logf("resumed decision: %s", decision.c_str());
  if (decision != "SAFE" && assignment.present) {
    GpsSnapshot g = gpsCopy();
    if (!g.everFixed) g = lastKnownFix();
    mode = ESCALATED;
    if (smsWithReporting(eventId, "CONTACT_SMS", assignment.contactPhone,
                         contactSmsText(colomboTime(occurredAt), mapsOrNone(g), decision)))
      markContactSmsSent();
  }
  if (commandId.length()) ackDecision(eventId, commandId, decision == "SAFE" ? "RESOLVED" : "ESCALATED");
  clearActiveIncident();
  activeEventId = "";
  mode = MONITORING;
}

void runIncident(const String& type, bool emergency, bool ign, float preSpeed, bool preSpeedKnown, uint32_t fallenMs) {
  const String eventId = uuid4();
  activeEventId = eventId;
  const int64_t occurredAt = nowEpoch();
  const Peaks peaks = motionPeaks();
  GpsSnapshot g = gpsCopy();
  if (!g.everFixed) g = lastKnownFix();  // no fix since boot: fall back to the remembered one
  const bool sos = type == "MANUAL_SOS";
  const String when = colomboTime(occurredAt);
  const String bike = shortName(assignment.present ? assignment.bikeLabel : String(CL_DEVICE_CODE));
  const String maps = mapsOrNone(g);

  logf("INCIDENT %s %s (peak %.2f g, %.0f dps, tilt %.0f)", type.c_str(), eventId.c_str(), peaks.accelG, peaks.gyroDps, peaks.maxTilt);
  mode = sos ? ESCALATED : (emergency ? AWAITING_RESPONSE : RESOLVED);
  // Clear presses from before the incident now. Presses made while the bike is
  // busy with SMS and the photo below are kept (seen on the real bike: SAFE
  // pressed during the SMS used to be thrown away).
  evSafe = evSos = false;
  beep(600);

  // 1. Report first - it is small and it is what puts the question on the rider's phone.
  UpsertResult up = upsertIncident(eventId, type, occurredAt, ign, preSpeed, preSpeedKnown, peaks, fallenMs, g, "PENDING",
                                   sos ? "HELP" : nullptr, "DEVICE_BUTTON", occurredAt);
  logf("incident reported: %s, serverQuestion=%d", up.ok ? "yes" : "NO (offline - deciding locally)", up.serverQuestion);
  if (emergency) saveActiveIncident(eventId, type, occurredAt, up.serverQuestion ? up.deadlineEpoch : 0);

  // 2. SMS the owner (and for SOS, the contact straight away - D6).
  if (assignment.present) {
    String ownerText = String("CRASHLINK ALERT ") + bike + ": " + smsLabel(type) + " " + when + ". " +
                       locationText(g, occurredAt) + (emergency && !sos ? " Rider asked if safe." : "");
    if (!emergency) ownerText = String("CRASHLINK ") + bike + ": " + smsLabel(type) + " " + when + " " + maps;
    smsWithReporting(eventId, "OWNER_SMS", assignment.ownerPhone, ownerText);
    // The app only asks while it is open (no push in the MVP), so the bike also
    // asks the rider by SMS - it reaches a phone whose app is closed.
    if (emergency && !sos && assignment.driverPhone.length() && !evSafe) {
      smsWithReporting(eventId, "DRIVER_SMS", assignment.driverPhone,
                       String("CRASHLINK: ") + smsLabel(type) + " on " + bike + " at " + when.substring(0, 5) +
                           ". Are you safe? Press SAFE on the bike or open CrashLink. No reply in 60s alerts your contact.");
    }
    if (sos) {
      if (smsWithReporting(eventId, "CONTACT_SMS", assignment.contactPhone,
                           String("CRASHLINK: ") + shortName(assignment.driverName) + " pressed SOS " + when + " " + maps + " Ambulance 1990"))
        markContactSmsSent();
    }
  } else {
    logf("no rental assigned - nobody to text");
  }

  // 3. Photo now (the scene as it is), uploaded last.
  pendingPhotoEvent = "";
  if (!capturePhoto(eventId) && up.ok) {
    // Say so, or the owner sees "Waiting for photo" forever (FR-IMG-03).
    upsertIncident(eventId, type, occurredAt, ign, preSpeed, preSpeedKnown, peaks, fallenMs, g, "FAILED", nullptr, "", 0);
  } else if (up.ok && photo && !uploadPhoto(eventId)) {
    // Uploaded now, not after the decision: the owner sees it within seconds.
    pendingPhotoEvent = eventId;
    lastPhotoTry = millis();
  }

  // 4. The rider's answer (EMERGENCY falls only).
  String decision = sos ? "HELP" : "";
  String commandId;
  const char* localDecision = nullptr;
  if (emergency && !sos) {
    // Server deadline when it asked; otherwise the device's own 60 s (offline / no question).
    const int64_t deadline = up.serverQuestion ? up.deadlineEpoch : occurredAt + RESPONSE_WINDOW_MS / 1000;
    const int64_t graceEnd = deadline + DEADLINE_GRACE_MS / 1000;
    int64_t lastGoodPoll = 0;
    uint32_t lastPoll = 0, lastBeat = millis();
    while (decision.isEmpty()) {
      if (evSafe) {
        evSafe = false;
        String d = up.ok ? localResponse(eventId, "SAFE") : "";
        decision = d.length() && d != "PENDING" ? d : "SAFE";
        if (d.isEmpty()) localDecision = "SAFE";
        break;
      }
      if (evSos) {
        evSos = false;
        String d = up.ok ? localResponse(eventId, "HELP") : "";
        decision = d.length() && d != "PENDING" ? d : "HELP";
        if (d.isEmpty()) localDecision = "HELP";
        break;
      }
      if (up.ok && millis() - lastPoll >= CONTROL_POLL_MS) {
        lastPoll = millis();
        Control c = pollControl(eventId);
        if (c.ok) {
          lastGoodPoll = nowEpoch();
          if (c.decision != "PENDING" && c.decision != "NOT_APPLICABLE") {
            decision = c.decision;
            commandId = c.commandId;
            logf("server decision: %s", decision.c_str());
            break;
          }
        }
      }
      // Keep the device "seen" so the server's dead-man rule does not fire mid-incident.
      if (millis() - lastBeat > HEARTBEAT_MS) {
        lastBeat = millis();
        heartbeat();
      }
      // D4: no successful control response by deadline + 15 s -> escalate locally.
      // Also when the server asked no question at all (e.g. quarantine): the rider may be hurt.
      if (nowEpoch() >= graceEnd && (lastGoodPoll < deadline || !up.serverQuestion)) {
        decision = "OFFLINE_FALLBACK";
        localDecision = "OFFLINE_FALLBACK";
        logf("no decision by deadline + grace - escalating locally");
        break;
      }
      delay(50);
    }

    if (decision == "SAFE") {
      mode = RESOLVED;
      clearActiveIncident();
      logf("rider is SAFE - no contact SMS");
    } else {
      mode = ESCALATED;
      if (assignment.present &&
          smsWithReporting(eventId, "CONTACT_SMS", assignment.contactPhone, contactSmsText(when, maps, decision)))
        markContactSmsSent();
    }
    if (commandId.length()) ackDecision(eventId, commandId, mode == RESOLVED ? "RESOLVED" : "ESCALATED");

    // A decision taken without the server gets reported now (D8 reconciles it).
    if (localDecision) {
      const char* src = strcmp(localDecision, "OFFLINE_FALLBACK") == 0 ? "DEVICE_OFFLINE_TIMER" : "DEVICE_BUTTON";
      UpsertResult again = upsertIncident(eventId, type, occurredAt, ign, preSpeed, preSpeedKnown, peaks, fallenMs, g,
                                          photo ? "PENDING" : "FAILED", localDecision, src, nowEpoch());
      if (again.ok) up.ok = true;
    }
  }

  // 5. Photo last - slowest and least time-critical (E.1.4).
  // Offline at the start: the photo waits for the retry loop once the link is back.
  if (!up.ok && photo) {
    pendingPhotoEvent = eventId;
    lastPhotoTry = millis();
  }

  // 6. Re-arm only after 5 s upright (D10).
  mode = REARM_WAIT;
  uint32_t uprightSince = 0, lastBeat = millis();
  while (true) {
    if (tiltNow < RECOVER_ANGLE_DEG) {
      if (!uprightSince) uprightSince = millis();
      if (millis() - uprightSince >= REARM_UPRIGHT_MS) break;
    } else {
      uprightSince = 0;
    }
    // The bike may lie on its side for minutes: keep reporting, or the server's
    // dead-man rule flags it offline during the rental (seen on the real bike).
    if (millis() - lastBeat > HEARTBEAT_MS) {
      lastBeat = millis();
      heartbeat();
    }
    delay(100);
  }
  clearActiveIncident();
  activeEventId = "";
  evSafe = evSos = false;
  mode = MONITORING;
  logf("re-armed - monitoring");
}

// ============================================================================

void setIgnition(bool on) {
  ignitionOn = on;
  ignitionChangedAt = nowEpoch();
  nvs.putBool("ign", on);
  if (ignitionEventCount < 20) ignitionEvents[ignitionEventCount++] = {on, ignitionChangedAt};
  logf("ignition %s", on ? "ON" : "OFF");
  beep(on ? 200 : 80);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n=== CrashLink %s firmware %s (%s) ===\n", CL_DEVICE_CODE, FW_VERSION,
                CL_TRANSPORT == CL_TRANSPORT_WIFI ? "Wi-Fi" : "GPRS");
  setenv("TZ", "UTC0", 1);
  tzset();

  for (int p : {PIN_GREEN_LED, PIN_BLUE_LED, PIN_RED_LED, PIN_BUZZER}) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  for (int p : {PIN_IGNITION_BUTTON, PIN_SAFE_BUTTON, PIN_SOS_BUTTON}) pinMode(p, INPUT_PULLUP);

  nvs.begin("crashlink", false);
  loadAssignment();
  configVersion = nvs.getInt("cfgVer", 1);
  ignitionOn = nvs.getBool("ign", false);
  logf("assignment: %s", assignment.present ? (assignment.driverName + " on " + assignment.bikeLabel).c_str() : "none");

  Wire.begin(PIN_MPU_SDA, PIN_MPU_SCL);
  mpuOk = initMpu();
  logf("MPU6050: %s (upright calibrated at boot - keep the bike standing)", mpuOk ? "OK" : "FAILED");

  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  sim.setRxBufferSize(1024);
  sim.begin(9600, SERIAL_8N1, PIN_SIM_RX, PIN_SIM_TX);

  xTaskCreatePinnedToCore(sensorTask, "sensor", 6144, nullptr, 2, nullptr, 0);

  delay(1500);  // SIM800L wake-up
  modemInit();
  probeCamera();
  ensureLink();
  syncClock();
  mode = MONITORING;
  heartbeat();
  resumeActiveIncident();
  logf("ready: ignition %s. Press ignition to toggle, hold SOS 1 s, tip past %.0f deg for %lus to trigger.",
       ignitionOn ? "ON" : "OFF", FALL_ANGLE_DEG, FALL_CONFIRM_MS / 1000);
}

void loop() {
  static uint32_t lastBeat = 0, lastCsq = 0, lastStatus = 0, candidateAt = 0, lastClock = 0;
  static float candidateSpeed = 0;
  static bool candidateSpeedKnown = false;
  static bool candidateIgnition = false;
  const uint32_t now = millis();

  if (evIgnition) {
    evIgnition = false;
    if (mode == MONITORING) {
      setIgnition(!ignitionOn);
      lastBeat = 0;  // tell the server now
    }
  }

  switch (mode) {
    case MONITORING:
      if (evSos) {
        evSos = false;
        runIncident("MANUAL_SOS", true, ignitionOn, 0, false, 0);
        return;
      }
      evSafe = false;  // a stray SAFE press with no incident is ignored (D9 is server-side)
      if (tiltNow > FALL_ANGLE_DEG) {
        GpsSnapshot g = gpsCopy();
        candidateAt = now;
        candidateSpeed = g.speedKph;
        candidateSpeedKnown = g.valid;
        candidateIgnition = ignitionOn;
        mode = FALL_CANDIDATE;
        logf("FALL_CANDIDATE (tilt %.0f) - confirming for %lus", tiltNow, FALL_CONFIRM_MS / 1000);
      }
      break;

    case FALL_CANDIDATE:
      if (tiltNow < RECOVER_ANGLE_DEG) {
        mode = MONITORING;
        logf("recovered upright - no incident");
      } else if (now - candidateAt >= FALL_CONFIRM_MS) {
        const Peaks p = motionPeaks();
        String type;
        bool emergency = candidateIgnition;
        if (!candidateIgnition) type = "PARKED_BIKE_FALL";  // SECURITY: owner SMS, no rider question
        else if (p.rot2s > ROLLOVER_DEG_IN_2S) type = "POSSIBLE_ROLLOVER";
        else if (p.accelG >= IMPACT_G || (candidateSpeedKnown && candidateSpeed >= COLLISION_SPEED_KPH)) type = "POSSIBLE_COLLISION";
        else type = "POSSIBLE_LOW_SPEED_RIDER_DROP";
        runIncident(type, emergency, candidateIgnition, candidateSpeed, candidateSpeedKnown, now - candidateAt);
        return;
      }
      break;

    default:
      break;
  }

  if (mode == MONITORING && now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    heartbeat();
  }
  if (mode == MONITORING) rememberFix();
  if (mode == MONITORING && pendingPhotoEvent.length() && now - lastPhotoTry > 20000) {
    lastPhotoTry = now;
    logf("retrying photo upload for %s", pendingPhotoEvent.substring(0, 8).c_str());
    if (uploadPhoto(pendingPhotoEvent)) pendingPhotoEvent = "";
  }
  if (now - lastClock > 10UL * 60 * 1000) {
    lastClock = now;
    if (clockSynced) syncClock();
  }
  if (modemOk && mode == MONITORING && now - lastCsq > 60000) {
    lastCsq = now;
    String csq = at("AT+CSQ");
    int idx = csq.indexOf("+CSQ: ");
    if (idx >= 0) csqCache = csq.substring(idx + 6).toInt();
  }
  if (now - lastStatus > 5000) {
    lastStatus = now;
    GpsSnapshot g = gpsCopy();
    // GPS diagnosis: chars=0 -> no data (power/wiring); chars>0 but 0 sats -> no sky view / antenna.
    logf("%s | ign %s | tilt %.0f | GPS %s %d sats, %lu chars | net %s | rider %s", modeName(mode), ignitionOn ? "ON" : "OFF", tiltNow,
         g.valid ? "fix" : "no fix", g.sats, (unsigned long)gps.charsProcessed(), netOk ? "ok" : "down",
         assignment.present ? assignment.driverName.c_str() : "-");
  }
  delay(20);
}
