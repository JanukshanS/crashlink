/**
 * CrashLink ESP32-CAM capture server (spec 5.3.11, Appendix E.1.1).
 *
 *   Wi-Fi   softAP "CL-<device code>", WPA2 with CL_AP_PASSWORD, max 1 client
 *           (the main ESP32). 192.168.4.1.
 *   GET /capture?eventId=<uuid>&nonce=<hex>&sig=<hex>
 *           sig = HMAC-SHA256(camera secret, eventId + nonce), hex.
 *           -> image/jpeg, headers X-SHA256 and Content-Length.
 *   GET /health -> {"ok":true,"psram":true,"camera":true,"sd":false}
 *
 * Proven settings (E.1.1): QVGA, jpeg_quality 20, fb_count 1, ~4 KB frames.
 * E.1.5 caps uploads at 10 KB, so an oversized frame is re-shot at lower quality.
 */
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "mbedtls/md.h"
#include "secrets.h"

// --- AI-Thinker ESP32-CAM pin map --------------------------------------------
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define FLASH_LED_GPIO 4

constexpr size_t MAX_UPLOAD_BYTES = 10 * 1024;  // E.1.5
constexpr int BASE_QUALITY = 20;                // E.1.1 (higher number = smaller file)

WebServer server(80);
bool cameraOk = false;

// ---------------------------------------------------------------------------

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

/** 64 hex chars -> 32 bytes. Returns false on a malformed secret. */
bool decodeHex(const char* hex, uint8_t* out, size_t outLen) {
  if (strlen(hex) != outLen * 2) return false;
  for (size_t i = 0; i < outLen; i++) {
    char pair[3] = {hex[i * 2], hex[i * 2 + 1], 0};
    char* end = nullptr;
    out[i] = (uint8_t)strtoul(pair, &end, 16);
    if (*end) return false;
  }
  return true;
}

String sha256Hex(const uint8_t* data, size_t len) {
  uint8_t out[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), data, len, out);
  return hexOf(out, 32);
}

/** HMAC keyed with the decoded 32-byte secret (Appendix E: "decoded bytes"). */
String hmacHex(const String& msg) {
  uint8_t key[32];
  if (!decodeHex(CL_CAMERA_SECRET, key, sizeof key)) return "";
  uint8_t out[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), key, sizeof key,
                  (const uint8_t*)msg.c_str(), msg.length(), out);
  return hexOf(out, 32);
}

/** Constant-time compare, so the signature cannot be guessed byte by byte. */
bool equalsConstTime(const String& a, const String& b) {
  if (a.length() != b.length() || a.length() == 0) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) diff |= a[i] ^ b[i];
  return diff == 0;
}

// ---------------------------------------------------------------------------

bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_QVGA;
  c.jpeg_quality = BASE_QUALITY;
  c.fb_count = 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;  // never hand out a stale frame

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("camera init failed: 0x%x (check the ribbon cable and 5 V supply)\n", err);
    return false;
  }
  return true;
}

/** Shoots a frame at `quality`; the first grab after idle can be dark, so it is discarded. */
camera_fb_t* shoot(int quality) {
  sensor_t* s = esp_camera_sensor_get();
  if (s) s->set_quality(s, quality);
  camera_fb_t* warm = esp_camera_fb_get();
  if (warm) esp_camera_fb_return(warm);
  return esp_camera_fb_get();
}

void handleCapture() {
  const String eventId = server.arg("eventId");
  const String nonce = server.arg("nonce");
  const String sig = server.arg("sig");

  if (eventId.length() < 8 || nonce.length() < 8 || sig.length() != 64) {
    server.send(400, "text/plain", "eventId, nonce and sig are required");
    return;
  }
  if (!equalsConstTime(hmacHex(eventId + nonce), sig)) {
    server.send(401, "text/plain", "bad signature");
    return;
  }
  if (!cameraOk) {
    server.send(503, "text/plain", "camera not ready");
    return;
  }

  camera_fb_t* fb = nullptr;
  // E.1.5: re-shoot at lower quality rather than send more than 10 KB.
  for (int quality = BASE_QUALITY; quality <= 40; quality += 10) {
    if (fb) esp_camera_fb_return(fb);
    fb = shoot(quality);
    if (fb && fb->len <= MAX_UPLOAD_BYTES) break;
  }
  if (!fb) {
    server.send(503, "text/plain", "capture failed");
    return;
  }
  if (fb->len > MAX_UPLOAD_BYTES) {
    esp_camera_fb_return(fb);
    server.send(507, "text/plain", "frame over 10 KB even at low quality");
    return;
  }

  const String digest = sha256Hex(fb->buf, fb->len);
  server.sendHeader("X-SHA256", digest);
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  server.sendContent((const char*)fb->buf, fb->len);
  Serial.printf("capture %s: %u bytes sha256 %s\n", eventId.c_str(), (unsigned)fb->len, digest.c_str());
  esp_camera_fb_return(fb);
}

void handleHealth() {
  String body = String("{\"ok\":") + (cameraOk ? "true" : "false") +
                ",\"psram\":" + (psramFound() ? "true" : "false") +
                ",\"camera\":" + (cameraOk ? "true" : "false") + ",\"sd\":false}";
  server.send(200, "application/json", body);
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== CrashLink ESP32-CAM ===");
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);  // the flash LED stays off; it browns out the board

  Serial.printf("PSRAM: %s\n", psramFound() ? "found" : "MISSING (frames go to DRAM)");
  cameraOk = initCamera();
  Serial.printf("camera: %s\n", cameraOk ? "OK" : "FAILED");

  const String ssid = String("CL-") + CL_DEVICE_CODE;
  WiFi.mode(WIFI_AP);
  // channel 1, visible SSID, at most one client: the main ESP32 (5.3.11).
  bool ap = WiFi.softAP(ssid.c_str(), CL_AP_PASSWORD, 1, 0, 1);
  Serial.printf("softAP %s: %s, IP %s\n", ssid.c_str(), ap ? "up" : "FAILED",
                WiFi.softAPIP().toString().c_str());

  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/health", HTTP_GET, handleHealth);
  server.onNotFound([] { server.send(404, "text/plain", "not found"); });
  server.begin();
  Serial.println("ready: GET /health, GET /capture?eventId=&nonce=&sig=");
}

void loop() {
  server.handleClient();
  delay(2);
}
