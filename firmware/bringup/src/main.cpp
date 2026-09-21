/**
 * CrashLink main-ESP32 hardware bring-up.
 *
 * Checks each module against the confirmed pin map (spec Appendix E) and prints
 * PASS / FAIL over USB at 115200 baud, then shows a live status line. No
 * backend, no incident logic - this only proves the wiring.
 *
 * Serial commands (type a letter + Enter in the monitor):
 *   l  LED cycle          b  buzzer test         i  I2C/MPU6050 check
 *   m  SIM800L AT check   g  GPRS bearer test    s  send test SMS
 *   p  GPS NMEA dump      c  camera capture      h  help
 */
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "mbedtls/md.h"
#include "secrets.h"  // shared with the camera: device code, camera secret, AP password

// --- Confirmed pin map (spec Appendix E, team wiring table) ------------------
constexpr int PIN_MPU_SDA = 21, PIN_MPU_SCL = 22;
constexpr int PIN_GPS_RX = 16, PIN_GPS_TX = 17;   // GPS TX -> 16, GPS RX <- 17 (optional)
constexpr int PIN_SIM_RX = 26, PIN_SIM_TX = 27;   // SIM800L TXD -> 26, RXD <- 27
constexpr int PIN_IGNITION_BUTTON = 32, PIN_SAFE_BUTTON = 33, PIN_SOS_BUTTON = 25;
constexpr int PIN_GREEN_LED = 18, PIN_BLUE_LED = 19, PIN_RED_LED = 23;
constexpr int PIN_BUZZER = 13;

// SMS test target: the demo owner (Arushan). Sent only when you type "s".
constexpr const char* TEST_SMS_NUMBER = "+94765541123";
constexpr const char* APN = "dialogbb";  // proven in Appendix E.1.1

HardwareSerial& gps = Serial2;
HardwareSerial& sim = Serial1;

uint8_t mpuAddr = 0;
bool gpsSeen = false;
uint32_t gpsLines = 0;
String gpsLine;
String lastGga;
int gpsSats = -1;
int gpsFix = -1;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

void result(const char* name, bool ok, const String& detail = "") {
  Serial.printf("  [%s] %-22s %s\n", ok ? "PASS" : "FAIL", name, detail.c_str());
}

/** Sends an AT command and returns everything the modem said within `ms`. */
String at(const String& cmd, uint32_t ms = 1500, const char* until = "OK") {
  while (sim.available()) sim.read();
  sim.println(cmd);
  String out;
  uint32_t start = millis();
  while (millis() - start < ms) {
    while (sim.available()) out += char(sim.read());
    if (out.indexOf(until) >= 0 || out.indexOf("ERROR") >= 0) break;
    delay(5);
  }
  out.trim();
  out.replace("\r\n", " | ");
  return out;
}

void beep(uint32_t ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

// ---------------------------------------------------------------------------
// module checks
// ---------------------------------------------------------------------------

void checkLeds() {
  Serial.println("\nLEDs: green, blue, red, 400 ms each - watch the board.");
  const int pins[] = {PIN_GREEN_LED, PIN_BLUE_LED, PIN_RED_LED};
  const char* names[] = {"green (18)", "blue (19)", "red (23)"};
  for (int i = 0; i < 3; i++) {
    Serial.printf("  %s on\n", names[i]);
    digitalWrite(pins[i], HIGH);
    delay(400);
    digitalWrite(pins[i], LOW);
  }
}

void checkBuzzer() {
  // Active buzzers sound on a steady HIGH; passive ones need a tone.
  Serial.println("\nBuzzer (13): 1) steady HIGH 300 ms   2) 2 kHz tone 300 ms");
  beep(300);
  delay(300);
  // 2 kHz square wave by hand: Arduino tone() logs a spurious LEDC error on this core.
  for (int i = 0; i < 600; i++) {
    digitalWrite(PIN_BUZZER, i & 1);
    delayMicroseconds(250);
  }
  digitalWrite(PIN_BUZZER, LOW);
  delay(100);
  Serial.println("  Heard 1 only -> active buzzer.  Heard 2 only -> passive.  Nothing -> check wiring.");
}

void checkI2c() {
  Serial.println("\nI2C scan on SDA 21 / SCL 22:");
  int found = 0;
  mpuAddr = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X\n", addr);
      found++;
      if (addr == 0x68 || addr == 0x69) mpuAddr = addr;
    }
  }
  if (!mpuAddr) {
    result("MPU6050", false, found ? "I2C devices found, but not at 0x68/0x69" : "no I2C devices - check SDA/SCL/3.3V/GND");
    return;
  }

  Wire.beginTransmission(mpuAddr);
  Wire.write(0x75);  // WHO_AM_I
  Wire.endTransmission(false);
  Wire.requestFrom(mpuAddr, (uint8_t)1);
  uint8_t who = Wire.available() ? Wire.read() : 0;

  Wire.beginTransmission(mpuAddr);
  Wire.write(0x6B);  // PWR_MGMT_1: wake up
  Wire.write(0x00);
  Wire.endTransmission();

  // 0x68 is the genuine part; clones often report 0x70/0x72/0x98.
  result("MPU6050", true, String("at 0x") + String(mpuAddr, HEX) + ", WHO_AM_I=0x" + String(who, HEX));
}

bool readTilt(float& roll, float& pitch, float& g) {
  if (!mpuAddr) return false;
  Wire.beginTransmission(mpuAddr);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, (uint8_t)6) != 6) return false;
  int16_t ax = (Wire.read() << 8) | Wire.read();
  int16_t ay = (Wire.read() << 8) | Wire.read();
  int16_t az = (Wire.read() << 8) | Wire.read();
  float fx = ax / 16384.0f, fy = ay / 16384.0f, fz = az / 16384.0f;  // +-2 g range
  roll = atan2f(fy, fz) * 57.2958f;
  pitch = atan2f(-fx, sqrtf(fy * fy + fz * fz)) * 57.2958f;
  g = sqrtf(fx * fx + fy * fy + fz * fz);
  return true;
}

void checkSim() {
  Serial.println("\nSIM800L on RX 26 / TX 27 @ 9600 (needs its own 5 V supply from the buck):");
  String r;
  for (int i = 0; i < 5 && r.indexOf("OK") < 0; i++) r = at("AT", 800);  // autobaud sync
  if (r.indexOf("OK") < 0) {
    result("SIM800L AT", false, "no reply - check TXD->26, RXD->27, common GND, 5 V under load");
    return;
  }
  result("SIM800L AT", true, r);
  at("ATE0");
  String cpin = at("AT+CPIN?");
  result("SIM card", cpin.indexOf("READY") >= 0, cpin);
  String csq = at("AT+CSQ");
  int rssi = -1;
  int idx = csq.indexOf("+CSQ: ");
  if (idx >= 0) rssi = csq.substring(idx + 6).toInt();
  result("Signal (CSQ)", rssi >= 10 && rssi != 99, csq + (rssi == 99 ? " (no signal)" : rssi < 10 ? " (weak)" : ""));
  String creg = at("AT+CREG?");
  bool registered = creg.indexOf(",1") >= 0 || creg.indexOf(",5") >= 0;
  result("Network registration", registered, creg + (registered ? "" : " (0,2 = still searching)"));
  Serial.printf("  operator: %s\n", at("AT+COPS?").c_str());
}

void checkGprs() {
  Serial.printf("\nGPRS bearer (APN %s) - can take up to 85 s:\n", APN);
  Serial.printf("  attach   %s\n", at("AT+CGATT?").c_str());
  Serial.printf("  contype  %s\n", at("AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"").c_str());
  Serial.printf("  apn      %s\n", at(String("AT+SAPBR=3,1,\"APN\",\"") + APN + "\"").c_str());
  String state = at("AT+SAPBR=2,1");
  Serial.printf("  state    %s\n", state.c_str());
  if (state.indexOf("+SAPBR: 1,1") < 0) {
    Serial.println("  opening bearer...");
    Serial.printf("  open     %s\n", at("AT+SAPBR=1,1", 85000).c_str());
    state = at("AT+SAPBR=2,1", 3000);
  }
  // Empty replies here usually mean the modem rebooted: a GPRS burst draws ~2 A.
  String alive = at("AT", 1000);
  Serial.printf("  modem    %s\n", alive.length() ? alive.c_str() : "(no reply - modem probably reset on a power dip)");
  result("GPRS bearer", state.indexOf("+SAPBR: 1,1") >= 0, state);
}

void sendTestSms() {
  Serial.printf("\nSending test SMS to %s ...\n", TEST_SMS_NUMBER);
  at("AT+CMGF=1");
  at(String("AT+CMGS=\"") + TEST_SMS_NUMBER + "\"", 3000, ">");
  sim.print("CrashLink bring-up test from CL-0001. Wiring OK.");
  sim.write(0x1A);  // Ctrl+Z sends
  String r;
  uint32_t start = millis();
  while (millis() - start < 20000 && r.indexOf("+CMGS") < 0 && r.indexOf("ERROR") < 0) {
    while (sim.available()) r += char(sim.read());
    delay(10);
  }
  r.trim();
  // +CMGS means the network accepted it - not that the phone received it.
  result("SMS submitted", r.indexOf("+CMGS") >= 0, r);
}

void pollGps() {
  while (gps.available()) {
    char c = gps.read();
    if (c == '\n') {
      // Only a real NMEA sentence counts - a floating RX pin reads noise bytes.
      if (!gpsLine.startsWith("$G")) {
        gpsLine = "";
        continue;
      }
      gpsSeen = true;
      gpsLines++;
      if (gpsLine.startsWith("$GPGGA") || gpsLine.startsWith("$GNGGA")) {
        lastGga = gpsLine;
        // $GPGGA,time,lat,N,lon,E,fix,sats,...
        int field = 0, start = 0;
        for (int i = 0; i <= (int)gpsLine.length(); i++) {
          if (i == (int)gpsLine.length() || gpsLine[i] == ',') {
            String v = gpsLine.substring(start, i);
            if (field == 6) gpsFix = v.toInt();
            if (field == 7) gpsSats = v.toInt();
            field++;
            start = i + 1;
          }
        }
      }
      gpsLine = "";
    } else if (c != '\r' && gpsLine.length() < 120) {
      gpsLine += c;
    }
  }
}

void checkGps() {
  Serial.println("\nGPS on RX 16 @ 9600 - listening 3 s:");
  uint32_t before = gpsLines, start = millis();
  while (millis() - start < 3000) pollGps();
  uint32_t n = gpsLines - before;
  result("GPS NMEA stream", n > 0, String(n) + " sentences in 3 s");
  if (lastGga.length()) Serial.printf("  last GGA: %s\n", lastGga.c_str());
  if (n > 0 && gpsFix <= 0) Serial.println("  no fix yet - normal indoors; take it outside for a few minutes.");
}

String hexOf(const uint8_t* b, size_t n) {
  static const char* h = "0123456789abcdef";
  String s;
  for (size_t i = 0; i < n; i++) {
    s += h[b[i] >> 4];
    s += h[b[i] & 15];
  }
  return s;
}

/** HMAC-SHA256 keyed with the decoded 32-byte camera secret, as the camera checks it. */
String cameraSig(const String& msg) {
  uint8_t key[32];
  for (int i = 0; i < 32; i++) {
    char pair[3] = {CL_CAMERA_SECRET[i * 2], CL_CAMERA_SECRET[i * 2 + 1], 0};
    key[i] = (uint8_t)strtoul(pair, nullptr, 16);
  }
  uint8_t out[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, 32, (const uint8_t*)msg.c_str(), msg.length(), out);
  return hexOf(out, 32);
}

/** Joins the camera's softAP and pulls one signed capture, exactly as an incident will. */
void checkCamera() {
  const String ssid = String("CL-") + CL_DEVICE_CODE;
  Serial.printf("\nCamera: joining %s ...\n", ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), CL_AP_PASSWORD);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(200);
  if (WiFi.status() != WL_CONNECTED) {
    result("Camera Wi-Fi", false, "could not join - is the camera powered and running?");
    WiFi.mode(WIFI_OFF);
    return;
  }
  result("Camera Wi-Fi", true, String("joined, RSSI ") + WiFi.RSSI() + " dBm, IP " + WiFi.localIP().toString());

  HTTPClient http;
  http.begin("http://192.168.4.1/health");
  int code = http.GET();
  result("Camera /health", code == 200, String(code) + " " + (code > 0 ? http.getString() : ""));
  http.end();

  // A made-up event id; the real firmware passes the incident's eventId.
  const String eventId = "bringup-" + String((uint32_t)esp_random(), HEX);
  const String nonce = String((uint32_t)esp_random(), HEX) + String((uint32_t)esp_random(), HEX);
  const String url = "http://192.168.4.1/capture?eventId=" + eventId + "&nonce=" + nonce + "&sig=" + cameraSig(eventId + nonce);

  const char* keys[] = {"X-SHA256"};
  http.begin(url);
  http.collectHeaders(keys, 1);
  http.setTimeout(10000);
  start = millis();
  code = http.GET();
  if (code != 200) {
    result("Camera /capture", false, String(code) + " " + (code > 0 ? http.getString() : http.errorToString(code)));
    http.end();
    WiFi.mode(WIFI_OFF);
    return;
  }
  String body = http.getString();
  const size_t n = body.length();
  const uint8_t* jpg = (const uint8_t*)body.c_str();
  uint8_t digest[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), jpg, n, digest);
  const String sha = hexOf(digest, 32);
  const bool shaOk = sha == http.header("X-SHA256");
  // E.1.1: validate JPEG start (FF D8) and end (FF D9) markers.
  const bool jpegOk = n > 4 && jpg[0] == 0xFF && jpg[1] == 0xD8 && jpg[n - 2] == 0xFF && jpg[n - 1] == 0xD9;
  result("Camera /capture", shaOk && jpegOk,
         String(n) + " bytes in " + (millis() - start) + " ms, JPEG " + (jpegOk ? "ok" : "BROKEN") + ", SHA-256 " + (shaOk ? "matches" : "MISMATCH"));
  http.end();

  // A wrong signature must be refused.
  http.begin("http://192.168.4.1/capture?eventId=" + eventId + "&nonce=" + nonce + "&sig=" + cameraSig("not-this-event"));  // right shape, wrong key material
  code = http.GET();
  result("Camera rejects bad sig", code == 401, String(code));
  http.end();

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

void help() {
  Serial.println("\nCommands: l LEDs | b buzzer | i MPU6050 | m SIM800L | g GPRS | s test SMS | p GPS | c camera | h help");
  Serial.println("Buttons (32 ignition, 33 SAFE, 25 SOS) print when pressed.");
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n=== CrashLink main ESP32 bring-up ===");

  for (int p : {PIN_GREEN_LED, PIN_BLUE_LED, PIN_RED_LED, PIN_BUZZER}) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  for (int p : {PIN_IGNITION_BUTTON, PIN_SAFE_BUTTON, PIN_SOS_BUTTON}) pinMode(p, INPUT_PULLUP);

  Wire.begin(PIN_MPU_SDA, PIN_MPU_SCL);
  gps.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
  sim.begin(9600, SERIAL_8N1, PIN_SIM_RX, PIN_SIM_TX);

  checkLeds();
  checkBuzzer();
  checkI2c();
  checkGps();
  delay(2000);  // SIM800L needs a few seconds after power-up
  checkSim();
  help();
  digitalWrite(PIN_GREEN_LED, HIGH);  // alive
}

void loop() {
  static bool last[3] = {true, true, true};
  const int buttons[] = {PIN_IGNITION_BUTTON, PIN_SAFE_BUTTON, PIN_SOS_BUTTON};
  const char* names[] = {"IGNITION (32)", "SAFE (33)", "SOS (25)"};
  for (int i = 0; i < 3; i++) {
    bool now = digitalRead(buttons[i]);
    if (now != last[i]) {
      delay(20);  // debounce
      now = digitalRead(buttons[i]);
      if (now != last[i]) {
        last[i] = now;
        Serial.printf("  button %s %s\n", names[i], now ? "released" : "PRESSED");
        if (!now) beep(60);
      }
    }
  }

  pollGps();

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > 2000) {
    lastStatus = millis();
    float roll = 0, pitch = 0, g = 0;
    bool mpu = readTilt(roll, pitch, g);
    // Blue shows GPS activity; red lights when tilted past the 60 deg fall angle.
    digitalWrite(PIN_BLUE_LED, gpsFix > 0 ? HIGH : LOW);
    bool fallen = mpu && (fabsf(roll) > 60 || fabsf(pitch) > 60);
    digitalWrite(PIN_RED_LED, fallen ? HIGH : LOW);
    Serial.printf("status | tilt roll %6.1f pitch %6.1f |g| %.2f %s | GPS %s fix=%d sats=%d\n",
                  roll, pitch, g, mpu ? (fallen ? "FALLEN" : "upright") : "(no MPU)",
                  gpsSeen ? "data" : "silent", gpsFix, gpsSats);
  }

  if (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 'l': checkLeds(); break;
      case 'b': checkBuzzer(); break;
      case 'i': checkI2c(); break;
      case 'm': checkSim(); break;
      case 'g': checkGprs(); break;
      case 's': sendTestSms(); break;
      case 'p': checkGps(); break;
      case 'c': checkCamera(); break;
      case 'h': help(); break;
      default: break;
    }
  }
}
