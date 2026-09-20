# CrashLink — Solution Architecture, Functional Specification & MVP Build Plan

**Project:** CrashLink — Intelligent Rental Bike Incident Detection and Emergency Alert System
**Team:** IoTrix, Sri Lanka Institute of Information Technology (SLIIT)
**Competition:** InnovIoT CodeFest 2026 — Final round (presentation + live demo)
**Document date:** 20 September 2026
**Document purpose:** Single source of truth for the team *and* a build brief that Claude Code can use to generate the backend, Android app, database, APIs, device gateway, simulator and deployment configuration.

> **How to use this document with Claude Code**
> 1. Put this file in the repository root as `docs/CRASHLINK_SPEC.md`.
> 2. Create `CLAUDE.md` from **Appendix A** (it points Claude Code at this spec and pins the decisions).
> 3. Work sprint by sprint using the prompts in **Phase 6**. Each prompt names the spec sections to implement and the acceptance tests that must pass.
> 4. Anything marked **VERIFY** depends on physical hardware, the SIM/carrier, or the VPS and must be tested, not assumed.

---

## Table of Contents

- [0. Source Reconciliation — Conflicts, **Resolved Information (M1–M12)**, Assumptions, Open Items](#0-source-reconciliation)
- [Phase 1 — Project Analysis Report](#phase-1--project-analysis-report)
- [Phase 1b — Competition Perspective & Feature Recommendations](#phase-1b--competition-perspective--feature-recommendations)
- [Phase 2 — Mobile Application Design](#phase-2--mobile-application-design)
- [Phase 3 — Architecture Options & Selection](#phase-3--architecture-options--selection)
- [Phase 4 — Detailed Technical Architecture](#phase-4--detailed-technical-architecture)
- [Phase 5 — Functional Specification Document (FSD)](#phase-5--functional-specification-document-fsd)
  - [5.1 Overview](#51-overview) · [5.2 User Requirements](#52-user-requirements) · [5.3 Device Protocol](#53-device-protocol) · [5.4 API Specifications](#54-api-specifications) · [5.5 Realtime Events](#55-realtime-events) · [5.6 Database Design](#56-database-design) · [5.7 Security Design](#57-security-design) · [5.8 Deployment Architecture & Contabo Guide](#58-deployment-architecture--contabo-vps-guide) · [5.9 MVP Scope](#59-mvp-scope-for-competition)
- [Phase 6 — Implementation Roadmap (Claude Code)](#phase-6--implementation-roadmap-claude-code)
- [Phase 7 — Demo Runbook, Test Matrix & Judge Q&A](#phase-7--demo-runbook-test-matrix--judge-qa)
- [Appendices](#appendices)

---

## 0. Source Reconciliation

Five sources were analysed:

| # | Source | Date / status | Role in this design |
|---|---|---|---|
| S1 | `35_IoTrix_…pdf` — proposal abstract ("CrashLink") | Submitted proposal | Problem statement, feature promises made to judges |
| S2 | `35_IoTrix_…pptx` — 9-slide deck | Current deck | What judges will see on the day |
| S3 | `InnovIoT_Master_Project_Information.md` | Consolidated 18 Sep 2026 | Hardware inventory, early GPIO/power plan |
| S4 | `InnovIoT_full_chat_transcript.md` | Design conversation | Story (Ravi scenario), decision history, corrections |
| S5 | `InnovIoT_Software_Application_Build_Spec.md` | **Revision 20 Sep 2026 (latest)** | Agreed software/firmware decisions |

**Precedence rule used in this document:** S5 (latest, explicitly "Agreed") > S4 final section > S3 > S2 > S1. Where S1/S2 (what judges read) disagree with S5, the slides must be updated — see §0.1 action items.

### 0.1 Conflicts found between documents (must fix before the demo)

| ID | Topic | What the sources say | Resolution in this design | Action for the team |
|---|---|---|---|---|
| C1 ⚠️ **OPEN** | **Fall confirmation timer** | S1 abstract and S2 slides 5 & 9: **15 seconds**. S4/S5: **10-second** persistent-fall check **plus** a separate **60-second** driver response window from "question sent". | 10 s fall check + 60 s response window (S5 "Agreed"). | **Update slides 5, 7, 9** to "10-second fall confirmation, then 60-second rider response window". Judges will compare the abstract to the demo; be ready to say the design was refined after calibration. |
| C2 ✅ **CLOSED** | **Red LED / buzzer GPIOs** | S3: buzzer GPIO23, LED3 GPIO13. S4 final: red LED **GPIO5** (already wired), buzzer GPIO13. S5: red LED **GPIO23** ("moved from GPIO5"), buzzer GPIO13 via driver. | S5 map (red = GPIO23). | **Resolved (M8): red LED is on GPIO23, confirmed against the wiring photo.** Buzzer is on GPIO13 wired directly — see O2. |
| C3 ✅ **CLOSED** | **SIM800L & GPS UART pins** | S3: SIM800L on GPIO16/17, GPS TBD. S5: GPS GPIO16/17, SIM800L **GPIO26/27**. | S5 map. | **Resolved (M8): GPS on 16/17, SIM800L on 26/27, confirmed by photo and by the working upload sketch.** |
| C4 | **Team member name** | S1: "Ajithan S." S2 slide 1: "Agiththan j." | Not a design issue. | Fix the spelling so both documents match the official registration. |
| C5 | **Product name** | S1: "CrashLink". S2/S3: "Smart Rental Bike Incident Detection…" / "Innov-IoT". | This document uses **CrashLink** (InnovIoT is the competition). | Put "CrashLink" on the slide 1 title and in the app. Consistent branding scores in presentation criteria. |
| C6 ⚠️ **OPEN** | **Charging from motorcycle battery** | S1 & S2 slide 7 claim "regulated charging circuit from the motorcycle battery". S3/S4/S5: 2S LiPo → fuse → two buck converters; **no charging circuit is designed**. | Treated as a *design concept*, not a prototype feature. | On the slide say "production design"; in the demo say the prototype runs on a pre-charged, fused LiPo. Do not claim it is built. |
| C7 | **Rider response channel** | S1: renter responds via the **app**. S4/S5: app **and** physical Safe/SOS buttons on the bike. | Both (S5). | Mention the physical buttons in the pitch — it answers "what if the rider's phone is broken?" |
| C8 | **Number of apps** | S1/S2: separate "owner application" and "customer application". S5: one app with `/owner` and `/driver` routes (PWA). | **One Android APK with role-based UI** (presents as two apps). | Say "one app, two role experiences" — halves build and test effort. |
| C9 | **App platform** | S5 proposed a React PWA. The current brief requires an **Android APK**. | Expo React Native (TypeScript), sideloaded APK. | — |
| C10 | **Features promised in S1 but absent in S5** | S1 promises *parking duration*, *trip distance*, *bike status*, *device tampering detection*. S5 covers distance and status only; tampering and parking duration are undefined. | Added: `ignition_events` table → parking/riding durations; tampering = device-silent-during-rental alert + handling-while-parked rule (§5.3.8). | — |
| C11 | **Photo transport** | S3 left it open; S4 mid-conversation proposed wires; final S4/S5: **ESP32-CAM → local Wi-Fi AP → main ESP32 → SIM800L GPRS → backend**. No hotspot. | Final S4/S5 path. | — |

### 0.2 Missing information — **RESOLVED by the team, 20 Sep 2026**

All twelve items were answered. This section is now the record of fact; the assumptions in §0.3 have been updated accordingly. **Where this section disagrees with any other section, this section wins.**

| ID | Question | Answer given | Effect on the design |
|---|---|---|---|
| M1 | Team's hands-on experience | **React Native** | A3 confirmed. Expo React Native + TypeScript stays. |
| M2 | What firmware works end-to-end | **All modules individually tested and working**: MPU6050 detected, SMS sending, 2G data working, camera working. **Camera → Wi-Fi → main ESP32 → SIM800L → HTTP POST → server proven** (JPEG received at webhook.site, `Content-Type: image/jpeg`, 4030 bytes, `user-agent: SIMCOM_MODULE`). Working sketches supplied (`esp32.txt`, `esp32_cam.txt`). | **Risk R1 (comms unproven) is closed.** No SMS-only demo fallback needed. Remaining firmware work is *integration and state machine*, not bring-up. See Appendix E.1. |
| M3 | SIM800L GPRS reality | **Dialog Sri Lanka, APN `dialogbb`, 2G data works.** Bearer opened with `AT+SAPBR`, upload via `AT+HTTPDATA` / `AT+HTTPACTION=1`. TLS not attempted. | A7 confirmed and narrowed: plain HTTP + HMAC to `/d/v1`. Do **not** spend demo-week time on `AT+HTTPSSL`. |
| M4 | Contabo VPS | **Cloud VPS 6 (2026), 6 vCPU, 12 GB RAM, 200 GB disk, no setup fee.** Domain **not stated**. | Sizing is generous — run Postgres, API and Uptime Kuma comfortably. **Open item:** a DNS name is still required for Let's Encrypt (see §0.4). |
| M5 | Demo devices | **Two Android phones** — one rider, one owner. | One APK, installed twice, role chosen at login. A8 confirmed. |
| M6 | Judging criteria | **None published.** Emphasis: innovation, uniqueness, usefulness, social value, problems solved. | Lead the pitch with §1b (innovation IN1–IN5, impact RW1–RW6) and the live end-to-end alert, not with stack detail. |
| M7 | FCM push | **After the MVP.** | MVP = Socket.IO realtime while the app is open + SMS from the bike. Drop FCM from Sprint 3; keep `deviceTokens` table unused. |
| M8 | Authoritative GPIO map | **Confirmed by photo** — matches S5 exactly, including **red LED = GPIO23**. One change: the **two-pin buzzer is wired directly to GPIO13** (no transistor/MOSFET). | C2 and C3 are closed. Appendix E updated; buzzer current limit noted in §0.4. |
| M9 | Image storage and size | **microSD present on the camera; images under 25 KB.** Measured sample: **≈ 4 KB** at QVGA, quality 20. | Offline image queue goes to SD. Upload time is acceptable (see Appendix E.1 timing). |
| M10 | Battery measurement | **Not measured.** | `Device.batteryPercent` stays nullable; UI shows "Not measured". Remove the battery gauge from the bike-health card or label it clearly. |
| M11 | Password reset | **Not required for demo/MVP.** | FR-AUTH-05 moves to *Future*. Admin creates accounts; seed data supplies demo logins. |
| M12 | Real SMS during the demo | **SMS to teammates' phones is sufficient.** | Owner and emergency contact numbers = two team phones. A9 and A12 confirmed. |

### 0.4 Open items still to close (small, but they will bite)

| # | Item | Why | Suggested action |
|---|---|---|---|
| O1 | **No domain name for the VPS** | Let's Encrypt cannot issue a certificate for a bare IP. The app would have to talk plain HTTP to the API, which Android blocks by default (cleartext traffic). | Register a free **DuckDNS** name (2 minutes) and point it at the Contabo IP, then run certbot as in §5.8. Fallback if that fails: keep the API on HTTP and add `android:usesCleartextTraffic="true"` to the Expo config — acceptable for the demo, called out as a known limitation. |
| O2 | **Buzzer wired directly to GPIO13** | An ESP32 pin sources ~12 mA safely, ~40 mA absolute maximum. A passive two-pin buzzer is usually fine; an active buzzer rated above ~30 mA will brown out or damage the pin over time. | Measure the buzzer current once. If it is above ~20 mA, add the series resistor + NPN transistor from S5 before the demo. Firmware treats GPIO13 as a plain digital output either way, so no code change. |
| O3 | **HTTP response bodies are not read yet** | The proven sketch checks `+HTTPACTION: 1,200,` and stops. The design piggybacks server commands on every device response (§5.3.4), so the firmware must also issue `AT+HTTPREAD`. | One extra AT step in `modemTask`. See Appendix E.1. |
| O4 | **Webhook.site URL is still in the firmware** | It is a public inbox; anyone with the link sees your uploads, and it expires. | Replace `UPLOAD_URL` with the VPS endpoint in Sprint 2. |

### 0.3 Assumptions (explicit)

| ID | Assumption |
|---|---|
| A1 | S5 (Build Spec rev. 20 Sep) is authoritative where sources conflict. |
| A2 | One Android APK with role-based UI satisfies the "owner app" and "customer app" promise. |
| A3 | The team can work in **TypeScript/JavaScript** (S5 already proposed TypeScript for app and API). Claude Code generates this stack very reliably. |
| A4 | **Confirmed (M4):** Contabo Cloud VPS 6 (2026) — 6 vCPU, 12 GB RAM, 200 GB disk. Install Ubuntu 24.04 LTS. Sizing is comfortably above what this stack needs. |
| A5 | **Still open (O1):** no domain was reported. Assumed a free DuckDNS name will be pointed at the VPS so Let's Encrypt can issue a certificate. If not, the app must allow cleartext HTTP. |
| A6 | **Superseded (M7):** FCM is deferred until after the MVP. Notification delivery for the demo = Socket.IO while the app is open, plus SMS from the bike, which does not depend on the app at all. |
| A7 | **Confirmed (M2/M3):** the device talks **plain HTTP** to `/d/v1`, protected by per-device **HMAC-SHA256** signatures, timestamps and nonces. Proven working against a public endpoint over Dialog 2G with `AT+HTTPSSL=0`. TLS on the modem is explicitly out of scope for the demo. |
| A8 | **Confirmed (M5):** two Android phones on mobile data (rider + owner). One laptop mirrors a phone screen to the projector using **scrcpy** (open source). |
| A9 | No paid SMS gateway: **all SMS originate from the bike's SIM800L**. The backend never sends SMS. |
| A10 | The GPS will probably have **no fix indoors** at the venue. A clearly labelled **demo location/speed injection** is required and must be displayed as `DEMO` in the UI. |
| A11 | The miniature bike cannot physically demonstrate speed, towing or cornering. Those events are demonstrated via the device's demo triggers or the simulator, labelled as simulated. |
| A12 | **Confirmed (M12):** all SMS go to team phones. No judge's number is used, and the backend still never sends SMS. |

---
## Phase 1 — Project Analysis Report

### 1.1 Problem Analysis

**What problem are we solving?**
Once a rental motorcycle leaves the owner's premises, the owner is blind to what happens to it and to the rider. If the rider crashes — especially alone, at night, or on a rural road — nobody may know for a long time: the owner does not know an accident happened, where, when, or whether the rider needs help; the rider's family does not know; and afterwards there is little objective evidence of what happened to the bike. Parked bikes can also be knocked over, towed or tampered with without the owner knowing.

**Who are the target users?**

| User | Relationship to the system | Primary need |
|---|---|---|
| **Rental bike owner / operator** (individual owner to small fleet) | Pays for and installs the device; uses the Owner experience | Know immediately when something happens to a bike or rider; have evidence; know where the bike is |
| **Renter / driver** (locals, tourists, gig riders) | Uses the Driver experience during a rental | Get help fast if hurt; avoid false alarms; privacy |
| **Emergency contact** (family/friend nominated by the renter) | Receives SMS only — no app | Be told quickly, with a location, when the rider may need help |
| *Secondary:* insurers, police, road authorities | Consumers of evidence or aggregated data | Objective incident evidence; road-hazard data |

*Assumption (not stated in sources):* tourist-area rentals are a strong early segment because tourists typically do not know local emergency numbers and have no local contacts nearby.

**Current pain points**

1. **Detection delay** — an accident is discovered only when someone happens to call.
2. **Rider may be incapacitated** — cannot phone for help, or the phone is broken/out of reach.
3. **No location** — even when told, the owner/family does not know where to go.
4. **False alarms from naive devices** — tilt-only detectors fire when a bike is parked on its side stand, dropped while stationary, or hits a pothole; owners learn to ignore them.
5. **No evidence** — disputes about damage ("it fell while parked" vs "you crashed it") have no objective record.
6. **Theft/towing/tampering** — the owner learns about it too late.
7. **Connectivity** — rural coverage is patchy; systems that depend only on the rider's smartphone app fail exactly when needed.

**Why is this problem important?**
Motorcyclists are consistently among the most affected road users in Sri Lanka's road-injury figures (use the latest official Sri Lanka Police / WHO numbers on the slide — **VERIFY and cite** rather than quoting from memory). Emergency medicine's widely accepted principle is that the sooner care begins after serious trauma, the better the outcome — so minutes saved in *detection and notification* matter. For owners, the bike is a revenue asset; for the rental ecosystem, visible safety features build trust with renters.

### 1.2 Solution Analysis

**How the solution solves the problem.** A device on the bike fuses motion (MPU6050), location/speed (GPS) and a simulated ignition state to decide *what kind* of event happened rather than reacting to tilt alone. A persistent fall (10 s) during a ride becomes an incident: the owner gets an SMS immediately, a photo is captured, the rider is asked "Are you safe?", and if they ask for help or do not answer within 60 s the rider's emergency contact is texted. Parked falls, towing, tampering, potholes and cornering are recorded as separate, lower-urgency events. Everything is stored and shown in the app with honest status.

**Why the design is strong (lead with these in the pitch):**

- **Context-aware classification** (ignition + pre-event speed + impact + rotation + persistence) → fewer false alarms.
- **Two independent alert channels**: GSM SMS directly from the bike (works without internet) and app/cloud.
- **Two independent response channels**: phone app and physical Safe/SOS buttons on the bike.
- **Offline fallback**: the device escalates on its own if the cloud is unreachable.
- **Per-rental emergency-contact snapshot**: the next renter's incident can never alert the previous renter's family.
- **Honest status**: "SMS submitted to network", not "delivered"; "last known location, 4 min old", not "live".

### 1.3 Hardware vs Software Responsibilities

| Responsibility | Hardware / firmware (bike) | Backend (VPS) | Mobile app |
|---|---|---|---|
| Sense motion, orientation, impact | MPU6050 + main ESP32 (100 Hz sampling, filtering) | — | — |
| Location, speed, time | NEO-6M + main ESP32 (validation, outlier rejection) | Store samples, compute distance, stale detection | Map, "LIVE / LAST KNOWN / DEMO" badges |
| Ignition state | GPIO32 momentary button, debounced toggle, persisted in NVS | Store ignition events → riding/parking durations | Display "Simulated ignition ON/OFF" |
| Event classification & 10 s fall check | **Main ESP32 (authoritative)** | Severity score, category rules, quarantine checks | Display label as *possible* |
| Owner SMS | **SIM800L (only SMS path)** | Record attempt states reported by device | Show SMS timeline |
| Photo capture & transfer | ESP32-CAM → local Wi-Fi → main ESP32 → GPRS | Chunked upload, SHA-256 verify, private storage | Photo pending / available / failed |
| "Are you safe?" question | Buzzer/LED warning; Safe/SOS buttons | **Creates question, owns 60 s deadline when online** | Full-screen prompt, countdown, responses |
| Emergency-contact SMS | **SIM800L** (on server decision, SOS, or offline timer) | Decides TIMEOUT/HELP, exposes decision to device | Shows escalation state |
| Rental assignment | Stores active assignment snapshot in NVS, acknowledges | Rental lifecycle, invariants, command queue | Assign / end rental UI |
| Tampering | Handling-while-parked rule | **Device-silent-during-rental ("dead-man") detector** | Security alert |
| History, analytics, reports | — | Queries, aggregates, PDF (nice-to-have) | Charts, lists, map |
| Security | Per-device secret, HMAC signing, local AP password, camera nonce | JWT auth, RBAC, rate limits, audit | Secure token storage |

### 1.4 Gaps, Risks and Missing Features

| # | Gap / risk | Severity | Mitigation (in this design) |
|---|---|---|---|
| R1 | Slides/abstract disagree with the agreed design (C1–C6) | **High (judging)** | Fix slides today (§0.1). |
| R2 | **Firmware integration not proven** (sensor → incident → SMS → HTTP → camera) | **Critical (schedule)** | Hour-0 SIM800L HTTP smoke test (§6.0); build backend/app against a **device simulator** that uses the exact device API, so software is never blocked by hardware. |
| R3 | 2G GPRS may be weak/unavailable at the venue; plain-HTTP only | High | SMS path is independent of GPRS; simulator fallback; HMAC request signing; later LTE Cat-1 modem. |
| R4 | SIM800L current peaks (up to ~2 A bursts) cause brownouts/resets | High | Separate Buck B for modem (S4), bulk capacitor, test while camera + Wi-Fi active; firmware persists state in NVS so resets are recoverable. |
| R5 | GPS has no fix indoors | High (demo) | `LAST_KNOWN` / `UNAVAILABLE` semantics + labelled `DEMO` location injection. |
| R6 | Model bike cannot show speed, towing, cornering | Medium | Demo triggers & simulator, labelled "simulated". |
| R7 | **If the device is destroyed in the crash, no SMS is sent** (SMS is device-only) | Medium | Server **dead-man detector**: device silent during an active rental → owner push + security incident. Future: server SMS gateway fallback. |
| R8 | Push notifications unreliable (permissions, battery optimisation, no FCM) | Medium | Push is an *attention aid only*; the app uses Socket.IO realtime + polling; the device's own timers never depend on push. |
| R9 | Phone numbers and assignment sent over plain HTTP (A7) | Medium | HMAC protects integrity, not confidentiality. Document the risk; optional AES-GCM payload encryption (Nice-to-have); HTTPS if modem supports it. |
| R10 | Main ESP32 (WROOM, no PSRAM) RAM pressure: Wi-Fi AP + GPRS stack + JPEG buffer | Medium | Cap JPEG at 25 KB, stream to LittleFS, 2 KB upload chunks. |
| R11 | Privacy: continuous location + photos of a scene | Medium | Consent screen at rental start, owner-only photo access, signed short-lived image URLs, retention policy. |
| R12 | Emergency contact not verified | Low (demo) / High (real) | Future: OTP or confirmation-SMS from device. |
| R13 | Race between app "Safe" and device SMS near the deadline | Medium | Server row-lock decides one winner; late responses recorded honestly (§5.3.6). |
| R14 | 2S LiPo 90C pack is capable of very high short-circuit current | Safety | Inline fuse (in S4), insulated connectors, never leave charging unattended. |
| R15 | Tampering and parking duration promised to judges but undefined | Medium | Defined in §5.3.8 and data model. |
| R16 | 2G networks are being retired in many countries | Long-term | Transport-agnostic device API; migration path to LTE Cat-1 modules using the same AT-command architecture. |

---
## Phase 1b — Competition Perspective & Feature Recommendations

Judging criteria were not provided (M6). The recommendations below target the usual IoT-competition dimensions: **innovation, real-world impact, technical depth, scalability, sustainability, UX, and demo reliability**. Difficulty: **L** = < 2 h, **M** = 2–6 h, **H** = > 6 h (with Claude Code assistance). ★ = unlikely to be implemented by competitors.

### 1b.1 Innovation

| ID | Feature | Why it is valuable | Difficulty | Feasible in 2 days? |
|---|---|---|---|---|
| IN1 ★ | **Pre-incident "black-box" replay** — the device keeps a 5 s ring buffer (accel magnitude, gyro magnitude, tilt, speed) and uploads ~25 downsampled points with the incident; the app plots them. | Turns "we detected a fall" into *visible evidence of how it happened*. Very strong on stage. | M (firmware already needs the buffer per S5) | **Yes** — keep to ≤ 25 points × 4 values. |
| IN2 | **Heuristic crash-severity index (0–100)** computed server-side from peak g, peak rotation, pre-event speed and persistence. | Owners triage multiple events; judges see "intelligence". Must be labelled *estimate, not medical*. | L | **Yes** |
| IN3 ★ | **Tamper-evident evidence chain** — SHA-256 of the photo (already required for upload integrity) plus a SHA-256 of the canonical incident record, shown as "Evidence integrity verified". | Evidence usable for insurance/damage disputes; almost free because hashing is already in the upload design. | L | **Yes** |
| IN4 ★ | **Truthful alert-delivery timeline** — per incident: detected → owner SMS queued/submitted/failed → question sent → push accepted → seen by rider → responded → contact SMS. | Most systems just say "alert sent". Honesty about uncertainty is a mature engineering story. | M | **Yes** (core of MVP) |
| IN5 | **Hybrid edge/cloud decision authority** — cloud owns the 60 s deadline when reachable; the device takes over when it is not. | Directly answers the #1 judge question: "what if there's no internet?" | Already designed | **Yes** (explain with the sequence diagram) |

### 1b.2 Real-world impact

| ID | Feature | Why it is valuable | Difficulty | Feasible? |
|---|---|---|---|---|
| RW1 ★ | **One-tap 1990 (Suwa Seriya ambulance) and 119 (Police)** on the Need-Help screen and incident screen. | Localised, practical; tourists rarely know these numbers. Uses the phone dialer (`tel:`) — no cost. | L | **Yes** |
| RW2 | **Google Maps link in every SMS** (`maps.google.com/?q=lat,lon`) | Contact can navigate with one tap from any phone. | L (firmware string) | **Yes** |
| RW3 | **Auto voice call to emergency contact** after the contact SMS (`ATD+94…;`, hang up after ~25 s). | A ringing phone gets attention faster than an SMS. | M (modem arbitration) | **Partial** — only if firmware is stable by Day 2 morning. |
| RW4 | **Tokenised live incident page for the emergency contact** — SMS contains a short link to a no-login page (map, status, last update; no photo), expiring after 24 h. | Contact follows the situation without installing an app. | M | **Partial** (Nice-to-have) |
| RW5 | **Incident evidence report (PDF)** for insurer/police — map, timeline, sensor chart, photo hash. | Real business value for owners. | M | **Partial** (Nice-to-have) |
| RW6 | **Trilingual rider prompt (English / සිංහල / தமிழ்)** in the app. | Inclusive for Sri Lankan riders; judges notice. SMS stays English (UCS-2 SMS on SIM800L cuts length to 70 chars). | L–M | **Yes** (app strings only) |

### 1b.3 Scalability

| ID | Feature | Why | Difficulty | Feasible? |
|---|---|---|---|---|
| SC1 | **Device provisioning + pairing code (QR optional)** — admin provisions `CL-0001` with a secret and pairing code; owner pairs by typing or scanning. | Shows how a fleet of hundreds is onboarded, not hand-configured. | M (manual code L, QR +M) | **Yes** (manual); QR Nice-to-have |
| SC2 | **Transport-agnostic device gateway** — HTTP now; the same service layer can accept MQTT (Mosquitto) or LTE later. | Credible scale story without building it now. | Design only | **Yes** (architecture slide) |
| SC3 | **Multi-owner tenancy & strict ownership scoping** | Platform can serve many rental businesses. | Included | **Yes** |
| SC4 | **Fleet map & status wall** | Operators with 20+ bikes need one screen. | M | **Yes** |

### 1b.4 Sustainability

| ID | Feature | Why | Difficulty | Feasible? |
|---|---|---|---|---|
| SU1 | **Adaptive reporting** — 10 s telemetry when ignition ON, 60 s when OFF, 3 s only during an active incident. | Saves GPRS data and battery; clear green-engineering message. | L | **Yes** |
| SU2 | **Battery voltage monitoring** — two-resistor divider on an **ADC1** pin (e.g. GPIO34; ADC2 is unusable while Wi-Fi runs) → low-battery alert. | Device health; prevents silent failures. | L hardware + L software | **Partial** — hardware change; software field is ready either way. |
| SU3 ★ | **Crowd-sourced pothole map** — `POSSIBLE_POTHOLE` events aggregated across all bikes into a map that could be shared with local authorities. | Turns a safety device into civic road-maintenance data. Very memorable. | M | **Yes** (markers; heatmap Nice-to-have) |
| SU4 | **Data-retention policy** (auto-purge locations after 30 days, images after 90) | Privacy + storage sustainability. | L | **Yes** (config + cron) |
| SU5 | **Migration path from 2G to LTE Cat-1** | Future-proofing narrative. | Doc only | **Yes** (slide) |

### 1b.5 User experience

| ID | Feature | Why | Difficulty | Feasible? |
|---|---|---|---|---|
| UX1 | **Zero-navigation emergency screen** — full-screen, alarm + vibration, two huge buttons, countdown from **server time**. | A hurt rider must not navigate menus. | M | **Yes (Must)** |
| UX2 | **Honest freshness badges** — `LIVE`, `LAST KNOWN · 4 min`, `UNAVAILABLE`, `DEMO` | Prevents dangerous misreading of stale data. | L | **Yes** |
| UX3 | **Judge / guest demo mode** — read-only login with seeded data | Judges can install the APK and explore safely. | L | **Yes** |
| UX4 | **Device health card** (GSM signal, GPS fix, camera link, battery, firmware, last seen) | Operators trust what they can see; great for troubleshooting live. | L | **Yes** |
| UX5 | Dark mode, large text | Accessibility | L | Optional |

### 1b.6 Unique features competitors are unlikely to implement

1. ★ **Dead-man detector** — if a bike goes silent during an active rental, the server raises `DEVICE_OFFLINE_DURING_RENTAL` (covers device destroyed/removed/power cut). *L, Yes.*
2. ★ **Per-rental recipient snapshots** with proof that re-assignment never reuses the previous renter's contact. *Already designed.*
3. ★ **Truthful delivery timeline** (IN4).
4. ★ **Evidence integrity hash** (IN3).
5. ★ **Pothole crowd map** (SU3).
6. ★ **1990 one-tap** (RW1).
7. ★ **Black-box replay chart** (IN1).

### 1b.7 Recommended additions for the 2-day window

Pick these, in this order, after the Must-Have MVP works end-to-end: **RW1 → RW2 → UX2 → UX4 → IN2 → IN3 → Dead-man detector → IN1 → SU3 → UX3 → RW6**. Everything else goes on a "Roadmap" slide.

---
## Phase 2 — Mobile Application Design

**Product form:** one Android APK named **CrashLink**, with role-based experiences (Owner, Driver, Admin, Guest). Package id: `lk.iotrix.crashlink`.

### 2.1 User Roles

| Role | Account? | Description | Key permissions | Key restrictions |
|---|---|---|---|---|
| **OWNER** (Vehicle owner / rental operator) | Yes | Owns bikes, assigns rentals, monitors fleet and incidents | CRUD own bikes; pair devices; assign/end rentals; view own bikes' locations, incidents, photos, SMS states; analytics; device config (non-safety fields) | Cannot see other owners' data; cannot see a driver's emergency contact phone except inside that driver's rental/incident snapshot |
| **DRIVER** (Renter / customer) | Yes | Rides a bike during an active rental | Manage own profile and emergency contact; see own active rental; answer Safe/Help; own history | Cannot assign bikes; cannot see photos (S2: "accident images stay private to the owner"); cannot see other drivers |
| **ADMIN** (Platform operator — the team) | Yes (seeded) | Provisions devices, supports diagnostics, resets demo | Provision/revoke devices; list users/devices; system health; demo reset | Actions are audit-logged |
| **GUEST / JUDGE** | Shared demo login | Read-only exploration of a seeded demo owner account | Read-only owner views on demo data | No mutations; no real phone numbers visible |
| **DEVICE** (machine actor) | Provisioned credential | The bike unit | Report telemetry/incidents/notification states/images; fetch config & commands for itself only | Cannot read any other device, user or rental |
| **EMERGENCY CONTACT** | **No account** | Receives SMS (and optionally a tokenised status link) | — | — |

### 2.2 Navigation Map

```mermaid
flowchart TD
  Splash["Splash / session restore"] --> AuthGate{"Signed in?"}
  AuthGate -- No --> Welcome["Welcome"]
  Welcome --> Login["Login"]
  Welcome --> Register["Register (Owner or Driver)"]
  Welcome --> Guest["Continue as Judge / Guest"]
  Login --> Forgot["Forgot password"] --> Reset["Reset with code"]
  AuthGate -- "Yes: OWNER / GUEST" --> OwnerTabs
  AuthGate -- "Yes: DRIVER" --> DriverTabs
  AuthGate -- "Yes: ADMIN" --> AdminTabs
  subgraph OwnerTabs["Owner tabs"]
    ODash["Dashboard"]
    OBikes["Bikes"] --> OBike["Bike detail"] --> OAssign["Assign rental"]
    OBike --> OConfig["Device settings"]
    OBikes --> OPair["Add bike + pair device"]
    OInc["Incidents"] --> OIncD["Incident detail"]
    OAna["Insights"]
    OSet["Settings"]
  end
  subgraph DriverTabs["Driver tabs"]
    DHome["Home / active rental"]
    DContact["Emergency contact"]
    DHist["History"]
    DSet["Settings"]
  end
  subgraph AdminTabs["Admin"]
    ADev["Devices + provision"]
    AHealth["System health"]
    ADemo["Demo controls"]
  end
  Emergency["FULL-SCREEN: Are you safe?"]
  DriverTabs -. "pending question (realtime / poll / push)" .-> Emergency
  ODash -. "new EMERGENCY incident" .-> OIncD
```

### 2.3 Core Features

#### 2.3.1 Simple Authentication

| Feature | Behaviour | MVP |
|---|---|---|
| **Registration** | Fields: name, email, phone (E.164, `+94…`), password (≥ 8 chars), role (Owner / Driver). Phone normalised with `libphonenumber-js`. Duplicate email/phone → clear error. Consent checkbox (location tracking, emergency SMS, photo capture) required for drivers. | Must |
| **Login** | Email or phone + password. Returns access token (1 h) + refresh token (30 d, rotated). Refresh token in `expo-secure-store`. Auto-refresh on 401 once. | Must |
| **Logout** | Revokes refresh token; unregisters push token. | Must |
| **Password reset** | "Forgot password" → 6-digit code, 15 min expiry, max 5 attempts. Delivered by email if SMTP is configured (Nodemailer + any free SMTP); otherwise `DEMO_MODE` logs the code server-side and an admin can read it. | Nice-to-have |
| **Guest / Judge mode** | "Continue as Judge" → logs into seeded read-only demo owner. Banner: "Demo data · read-only". | Nice-to-have (L) |
| Phone OTP verification | Out of scope for 2 days (would require an SMS gateway). | Future |

#### 2.3.2 Device Management

| Feature | Behaviour | MVP |
|---|---|---|
| **Device provisioning (Admin)** | Admin creates a device → server generates `code` (`CL-0001`), 32-byte HMAC secret (shown **once**, flashed into firmware NVS), and 8-char pairing code (printed on a label / QR). CLI equivalent: `npm run device:provision -- --code CL-0001`. | Must (CLI) / Nice (UI) |
| **Onboarding (Owner): Add bike** | Label (e.g. "Scooter 1"), optional plate number. | Must |
| **Pairing** | Owner enters device code + pairing code (or scans QR `crashlink://pair?code=CL-0001&pc=7H3K9QXA`). Server verifies pairing code hash, links device ↔ bike, bumps config version. A device can be paired to one bike only. Unpair allowed only with no active rental. | Must (manual) / Nice (QR) |
| **Status monitoring** | Online/offline, last seen, firmware, GSM signal (CSQ → bars), GPRS attached, GPS fix/sats/HDOP, camera link, battery V (if measured), queued jobs, config version applied. | Must |
| **Configuration** | Owner-editable: telemetry intervals, cornering sensitivity, auto-call contact (if implemented), demo mode (admin/owner in demo). **Locked (display only):** 10 s fall check, 60 s response window — these are agreed safety parameters (S5). Changes are sent as a `SET_CONFIG` command; UI shows "Pending sync" until the device acks. | Should |

#### 2.3.3 Real-Time Monitoring

| Aspect | Specification |
|---|---|
| **Sensor readings shown** | Latest location (lat/lon, fix time, speed, HDOP, satellites), simulated ignition state + since when, trip distance (current rental), riding time vs parked time, last events. Raw 100 Hz IMU data is **not** streamed (bandwidth); only incident evidence windows. |
| **Device health** | See device status card above. Colour rules: green (all OK), amber (degraded: no GPS fix / weak GSM CSQ < 10 / camera link down), red (offline or revoked). |
| **Online/offline** | `ONLINE` if `now - lastSeenAt ≤ 2.5 × expected interval` (10 s ON → 25 s; 60 s OFF → 150 s). `STALE` up to 5×; beyond that `OFFLINE`. Computed server-side and pushed. |
| **Refresh frequency** | Device → server: 10 s (ignition ON), 60 s (OFF), 3 s control poll during an active incident. Server → app: immediate via Socket.IO. App fallback polling: 5 s on emergency/incident-detail screens, 15 s on dashboard/bike detail, paused in background. Pull-to-refresh everywhere. |
| **Freshness display** | Every location shows a badge: `LIVE` (fix ≤ 30 s), `LAST KNOWN · 4 min`, `UNAVAILABLE`, or `DEMO`. |

#### 2.3.4 Alerts & Notifications

Incident categories drive behaviour:

| Category | Types | Owner | Driver | Emergency contact |
|---|---|---|---|---|
| **EMERGENCY** | `POSSIBLE_COLLISION`, `POSSIBLE_LOW_SPEED_RIDER_DROP`, `POSSIBLE_ROLLOVER`, `MANUAL_SOS` | SMS (device) + push + in-app alarm banner | Full-screen "Are you safe?" (except SOS → "Help is being requested") | SMS on HELP / timeout / offline fallback |
| **SECURITY** | `PARKED_BIKE_FALL`, `POSSIBLE_TOWING`, `POSSIBLE_TAMPERING`, `DEVICE_OFFLINE_DURING_RENTAL` | SMS (device-originated types only) + push | Informational only | — |
| **INFO** | `POSSIBLE_POTHOLE`, `POSSIBLE_DANGEROUS_CORNERING` | In-app feed; push only if enabled | Shown in own history | — |

| Feature | Specification | MVP |
|---|---|---|
| **Threshold-based alerts** | Detection thresholds live on the device (§5.3.8) and are configurable via `SET_CONFIG`. Server-side thresholds: device offline during rental (> 90 s ON / > 300 s OFF), low battery (< 7.0 V for 2S, if measured), weak GSM (CSQ < 8 for 5 min). | Must (device) / Should (server) |
| **Emergency alerts** | Owner: red banner on every screen until acknowledged + alarm sound. Driver: full-screen modal. | Must |
| **Push notifications** | FCM via `expo-notifications`; Android channel `emergency` (max importance, custom alarm sound, vibration), `security` (high), `info` (default). Push is an *attention aid only*: the app always re-fetches truth from the API. Notification-permission denial is shown as a warning card. | Should |
| **Historical alert tracking** | Incident list (filters: category, type, bike, state, date range) and per-incident timeline of every notification state transition. | Must |

#### 2.3.5 Insights & Analytics

| Widget | Data | MVP |
|---|---|---|
| Incidents by type (bar) | Count per type, date range | Should |
| Incidents over time (line) | Daily counts, last 14/30 days | Should |
| Distance per bike (bar) | Sum of rental distances | Should |
| Riding vs parked time (stacked/two bars) | From ignition events | Nice |
| Response outcomes (donut or bars) | SAFE / HELP / TIMEOUT / OFFLINE_FALLBACK counts, median response time | Nice |
| Pothole map ★ | Map markers of `POSSIBLE_POTHOLE` events | Nice |
| Rental history table | Per bike: driver, start, end, distance, incidents | Must (list) |
| Evidence report PDF | Per incident | Nice |

#### 2.3.6 Dashboards

**Owner Home dashboard (top to bottom):**
1. **Emergency banner** (only when an EMERGENCY incident is open): type, bike, time, countdown/state → tap opens incident.
2. **KPI cards (2×2):** Bikes online / total · Active rentals · Open incidents · Incidents today.
3. **Fleet map** (Leaflet in WebView): one marker per bike, colour by status, freshness in popup.
4. **Bike status list:** label, driver, ignition, online dot, last location age.
5. **Recent activity feed:** last 10 events across the fleet.

**Driver Home dashboard:**
1. Active rental card: bike, owner, start time, trip distance, simulated ignition, location freshness, "Bike connected" indicator.
2. Emergency-contact card (name, masked phone) with warning if missing.
3. **"Need help" SOS button** (long-press 2 s to avoid accidental taps) → `MANUAL_SOS` (Nice-to-have; the bike's physical SOS button is the Must).
4. Consent/notice link.

**Incident detail (owner):** header (type label "Possible …", severity chip, state chip) · photo panel (pending/uploading %/available/failed + integrity badge) · map + coordinates + freshness + "Open in Google Maps" · timeline (§IN4) · evidence (pre-event speed, peak g, peak °/s, fallen duration, ignition) · black-box chart (IN1) · rider response panel · actions: **Call driver**, **Call emergency contact**, **Call 1990**, **Acknowledge & close** (with note), Export report (Nice).

#### 2.3.7 Settings

| Group | Settings |
|---|---|
| **User preferences** | Name, phone, language (English / සිංහල / தமிழ்), theme (system/light/dark), units (metric), change password, logout |
| **Notification settings** | Emergency alerts (always on — shown locked), security alerts on/off, info events on/off, alarm sound on/off, test notification button, permission status |
| **Device settings (owner, per bike)** | Telemetry interval ON/OFF, cornering sensitivity, auto-call emergency contact, demo mode; read-only: fall check 10 s, response window 60 s, firmware, config version + sync state |
| **About** | App version, API URL, privacy notice, "This is a prototype, not an emergency service" |

### 2.4 Key Screen Specifications (for code generation)

**Emergency prompt `app/emergency/[incidentId].tsx` (Driver)**
- Opens automatically when `pendingQuestion` exists in the store (from Socket.IO `incident.question`, from push tap, or from polling `GET /drivers/me/pending-question` every 5 s while a rental is active).
- Full-screen, red background, no tab bar, back button disabled until resolved.
- Countdown = `responseDeadlineAt − (Date.now() + clockOffset)`, where `clockOffset = serverTime − localTimeAtResponse`.
- Buttons: **I'M SAFE** (green, ≥ 72 dp tall) and **NEED HELP** (red). Text in selected language.
- Plays alarm loop (`expo-audio`) + vibration pattern until a button is pressed; posts `question-ack` on open.
- Status line states: `Sending…` → `Accepted by server · syncing to bike` → `Synced with bike ✓`; errors: `Too late — emergency contact already notified at 14:33:05`, `Cannot reach server — retrying… (you can also press SAFE on the bike)`.
- After HELP: show "Your emergency contact is being notified", **Call 1990** and **Call 119** buttons, owner phone call button.
- Idempotency: each tap generates a UUID `idempotencyKey`; retried with the same key.

**Assign rental `app/(owner)/bikes/[id]/assign.tsx`**
- Driver lookup by phone or email (`GET /drivers/lookup?q=`), shows name + "has emergency contact ✓/✗" (cannot proceed without).
- Confirm → `POST /rentals` → screen shows `Waiting for bike to confirm…` with spinner + elapsed time; realtime `rental.updated` → `Active ✓ (bike acknowledged at 10:02:11)`.
- If > 60 s without ack: show "Bike has not confirmed. It may be offline." with **Keep waiting** / **Cancel** / (demo only) **Force activate — no SMS recipients guaranteed** (red warning).

---
## Phase 3 — Architecture Options & Selection

Constraints recap: free/open-source, Contabo VPS already available, Android APK, rapid development, demo-grade stability in 2 days, device on **SIM800L 2G GPRS** (weak TLS, slow, high latency per request), device-originated SMS.

### Option 1 — Firebase BaaS (Firestore + Cloud Functions + FCM + Storage)

| Aspect | Assessment |
|---|---|
| Advantages | Very fast auth and realtime; mature Android SDK; FCM integrated. |
| Disadvantages | **Not open source**; Cloud Functions/scheduled jobs need the paid Blaze plan (card required); does not use the Contabo VPS; SIM800L cannot talk to Firebase directly (HTTPS/TLS requirements) so a relay would be needed anyway; server-side transactional deadline logic is awkward. |
| Development speed | High for the app, low for the device path |
| Deployment complexity | Low (managed) |
| Scalability | Very high |
| Competition fit | **Poor** — violates the open-source constraint and still needs a relay for the device. |

### Option 2 — Self-hosted Backend-as-a-Service (PocketBase, or Supabase self-hosted)

| Aspect | Assessment |
|---|---|
| Advantages | PocketBase: single binary, SQLite, built-in auth, admin UI, file storage, realtime (SSE). Very fast CRUD. Supabase: Postgres, auth, realtime, storage. |
| Disadvantages | Custom logic we *need* (HMAC device auth, idempotent incident upserts, row-locked deadline race, chunked image upload with hash verification, command queue) must be written as hooks in an embedded JS runtime (PocketBase) or as edge functions (Supabase), which is less familiar and harder to test. Supabase self-hosted is ~10 containers — heavy for a 2-day setup. PocketBase is pre-1.0 (API churn). React Native SSE needs a polyfill. |
| Development speed | Very high for CRUD; medium-low for the safety-critical flows |
| Deployment complexity | PocketBase low; Supabase medium-high |
| Scalability | PocketBase: single node (SQLite) — fine for hundreds of devices; Supabase high |
| Competition fit | **Medium** — fast start, but the hardest 30 % of the logic is the part that becomes awkward. |

### Option 3 — IoT platform (ThingsBoard CE, or Node-RED + InfluxDB + Grafana)

| Aspect | Assessment |
|---|---|
| Advantages | MQTT/HTTP device ingestion, rule engine, dashboards and alarms out of the box; impressive visuals quickly. |
| Disadvantages | Rentals, driver/owner roles, per-rental emergency-contact snapshots and the 60 s decision race do not fit the platform model; a custom Android app still has to integrate with the platform's REST API; ThingsBoard (Java) wants ≥ 4 GB RAM; learning curve during a 2-day sprint. |
| Development speed | High for dashboards, low for business rules |
| Deployment complexity | Medium |
| Scalability | High |
| Competition fit | **Low–medium** — great charts, wrong domain model. |

### Option 4 — MQTT-centric custom backend (Mosquitto + Node.js subscriber + PostgreSQL + WebSocket to the app)

| Aspect | Assessment |
|---|---|
| Advantages | Server can push commands (Safe/Help decision) to the device instantly; efficient small packets; classic IoT architecture judges recognise. TinyGSM + PubSubClient runs on SIM800L. |
| Disadvantages | Keeping a persistent TCP session alive over 2G GPRS is fragile (NAT timeouts, reconnect storms); the SIM800L must also do SMS and chunked image uploads on the same UART — multiplexing MQTT + HTTP on one modem increases firmware risk; image upload over MQTT needs custom chunking; TLS problem is identical; two protocols to secure and debug. |
| Development speed | Medium (backend) / **low** (firmware) |
| Deployment complexity | Medium (broker ACLs, auth plugin) |
| Scalability | High |
| Competition fit | **Medium** — elegant on paper, but it moves risk into the firmware, which is already the critical path. |

### Option 5 (Recommended) — TypeScript modular monolith + signed-HTTP device gateway + realtime app channel, MQTT-ready

**Shape:** one Node.js (Fastify, TypeScript) service with modules (auth, bikes, devices, rentals, incidents, images, notifications, analytics, admin, demo) + PostgreSQL (Prisma) + local image volume + Socket.IO for the app + in-process DB-backed workers (deadline, dead-man, retention). The device uses short, stateless **HTTP requests signed with HMAC**, and every device response **piggybacks pending commands**, so the device never needs a persistent connection. Nginx terminates TLS for the app and exposes a plain-HTTP `/d/` path for the modem. A Mosquitto container can be added later behind the same service layer (`DeviceIngestService`) without touching business logic.

| Aspect | Assessment |
|---|---|
| Advantages | One language across app, API, shared contracts and simulator; Postgres transactions + row locks give a *provably single* winner for the Safe/timeout race; stateless HTTP is the most reliable pattern on SIM800L (TinyGSM + ArduinoHttpClient are proven); command piggybacking gives near-push behaviour (≤ 3 s during incidents) without MQTT; everything is open source; Claude Code generates Fastify + Prisma + Expo very reliably; the simulator lets the software team finish without the hardware. |
| Disadvantages | Command latency is bounded by the poll interval (3 s during incidents, 10 s otherwise); we write auth/CRUD ourselves (mitigated by Claude Code); plain HTTP for the device (mitigated by HMAC; HTTPS if modem allows). |
| Development speed | **High** |
| Deployment complexity | **Low** — `docker compose` (Postgres + API + Uptime Kuma) + host Nginx + certbot |
| Scalability | Good: a single 4 GB VPS handles hundreds of devices at 10 s intervals (≈ 0.1 req/s per device). Horizontal path: stateless API replicas + Socket.IO Redis adapter + MQTT ingestion + managed Postgres. |
| Competition fit | **Best** |

### Comparison summary

| Criterion | 1 Firebase | 2 PocketBase/Supabase | 3 ThingsBoard | 4 MQTT custom | **5 Recommended** |
|---|---|---|---|---|---|
| Open source / free | ✗ | ✓ | ✓ | ✓ | **✓** |
| Uses Contabo VPS | ✗ | ✓ | ✓ | ✓ | **✓** |
| Fits SIM800L realities | ✗ | ◐ | ◐ | ◐ | **✓** |
| Safety-critical race logic | ◐ | ◐ | ✗ | ✓ | **✓** |
| Dev speed (2 days) | ◐ | ✓ | ◐ | ◐ | **✓** |
| Deployment effort | ✓ | ◐ | ◐ | ◐ | **✓** |
| Scale path | ✓ | ◐ | ✓ | ✓ | **✓** |
| Demo stability | ◐ | ◐ | ◐ | ◐ | **✓** |

### Selected architecture

**Option 5.** Mobile: Expo React Native (TypeScript) → Android APK. Backend: Fastify + Prisma + PostgreSQL 16 + Socket.IO. Device transport: HTTP + HMAC via SIM800L GPRS (HTTPS if proven). Push: FCM via `firebase-admin` (optional; realtime + polling is the guaranteed path). Infra: Contabo VPS, Nginx, Let's Encrypt, Docker Compose, Uptime Kuma. MQTT (Mosquitto) reserved for the scale phase.

**Why not Flutter?** Flutter is equally capable; the choice of React Native is driven by (a) one language with the backend and the shared contracts package, (b) S5 already specified TypeScript, (c) Expo's zero-native-config APK build. If the team is much stronger in Flutter (M1), swap only the mobile layer — the API contract in §5.4 is framework-neutral.

---
## Phase 4 — Detailed Technical Architecture

### 4.1 System Context Diagram

```mermaid
flowchart LR
  subgraph BIKE["Bike unit"]
    MPU["MPU6050"] -- "I2C" --> MAIN["Main ESP32 DevKit"]
    GPS["NEO-6M GPS"] -- "UART GPIO16/17" --> MAIN
    BTN["Ignition / Safe / SOS buttons"] --> MAIN
    MAIN --> IND["LEDs + 5V buzzer via driver"]
    CAM["ESP32-CAM"] <-- "local Wi-Fi AP only" --> MAIN
    MAIN <-- "UART AT GPIO26/27" --> GSM["SIM800L MD0147"]
  end
  GSM -- "GSM SMS" --> OWNERPH["Owner phone"]
  GSM -- "GSM SMS (+ optional call)" --> CONTACT["Emergency contact phone"]
  GSM -- "2G GPRS: HTTP + HMAC to /d/v1" --> NGINX
  subgraph VPS["Contabo VPS (Ubuntu, Docker)"]
    NGINX["Nginx :80 /d/ + :443"] --> API["CrashLink API (Fastify + Socket.IO + workers)"]
    API --> PG[("PostgreSQL 16")]
    API --> FILES[("Image volume /data/images")]
    KUMA["Uptime Kuma"] --> NGINX
  end
  NGINX -- "HTTPS REST + WSS" --> APP["CrashLink Android app (Owner / Driver / Admin)"]
  API -- "FCM push (optional)" --> FCM["Firebase Cloud Messaging"] --> APP
  CONTACT -. "optional tokenised status page" .-> NGINX
```

### 4.2 Mobile Layer

| Concern | Choice | Notes |
|---|---|---|
| Framework | **Expo (React Native) + TypeScript**, latest stable SDK at scaffold time, **Expo Router** (file-based routes) | Build APK locally (`expo prebuild` + Gradle) or with EAS free tier |
| UI kit | **React Native Paper** (Material 3) | Consistent, accessible components fast |
| Server state | **TanStack Query** | Caching, refetch intervals, retries, optimistic updates; persisted with `@tanstack/query-async-storage-persister` so the last dashboard shows offline |
| Client state | **Zustand** | `authStore` (user, tokens), `realtimeStore` (socket status, clock offset), `emergencyStore` (pending question, response status) |
| Forms / validation | react-hook-form + zod (schemas from `packages/contracts`) | Same validation rules as API |
| Secure storage | `expo-secure-store` | Refresh token, device install id |
| Local storage | `@react-native-async-storage/async-storage` | Query cache, preferences, language |
| Realtime | `socket.io-client` | Auth via access token in handshake; auto-reconnect; rooms joined server-side |
| Notifications | `expo-notifications` (FCM on Android) + local notifications | Channels: `emergency` (MAX), `security` (HIGH), `info` (DEFAULT) |
| Maps | `react-native-webview` + **Leaflet** + OpenStreetMap tiles (attribution shown) | No API key; "Open in Google Maps" via `Linking` |
| Charts | `react-native-gifted-charts` (uses `react-native-svg`) | Bar, line, donut |
| Audio / haptics | `expo-audio` (alarm loop), `Vibration` | Emergency screen |
| QR (nice) | `expo-camera` barcode scanning | Device pairing |
| i18n | `i18next` + `react-i18next` | `en`, `si`, `ta` (emergency strings first) |
| Phone utils | `libphonenumber-js` | E.164 normalisation |

**Mobile folder structure**

```text
apps/mobile/
  app.config.ts                 # name CrashLink, package lk.iotrix.crashlink, plugins, EXPO_PUBLIC_API_URL
  app/
    _layout.tsx                 # Providers: Paper, QueryClient, AuthGate, SocketProvider, NotificationBridge, EmergencyWatcher
    (auth)/welcome.tsx login.tsx register.tsx forgot.tsx reset.tsx
    (owner)/_layout.tsx         # Tabs: index, bikes, incidents, insights, settings
    (owner)/index.tsx           # Dashboard
    (owner)/bikes/index.tsx  bikes/add.tsx  bikes/[id]/index.tsx  bikes/[id]/assign.tsx  bikes/[id]/config.tsx
    (owner)/incidents/index.tsx  incidents/[id].tsx
    (owner)/insights.tsx  (owner)/settings.tsx
    (driver)/_layout.tsx        # Tabs: index, contact, history, settings
    (driver)/index.tsx contact.tsx history.tsx settings.tsx
    (admin)/_layout.tsx devices.tsx health.tsx demo.tsx
    emergency/[incidentId].tsx  # full-screen modal
  src/
    api/client.ts               # fetch wrapper, auth header, refresh-once, error mapping
    api/hooks/*.ts              # useBikes, useBike, useIncidents, useIncident, usePendingQuestion, ...
    realtime/socket.ts          # connect, event → queryClient.invalidate / setQueryData
    notifications/index.ts      # register token, channels, tap handling → router.push
    stores/auth.ts realtime.ts emergency.ts
    components/                 # KpiCard, FreshnessBadge, StatusDot, DeviceHealthCard, IncidentTimeline,
                                # PhotoPanel, LeafletMap, BlackBoxChart, EmergencyButtons, CallButtons
    i18n/{en,si,ta}.json
    theme/
```

### 4.3 Backend Layer

| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS (or 22 LTS), TypeScript strict |
| Framework | **Fastify** + `fastify-type-provider-zod` |
| ORM / migrations | **Prisma** (+ one raw SQL migration for partial unique indexes) |
| Auth (users) | `@fastify/jwt` access tokens (HS256, 1 h) + opaque refresh tokens (SHA-256 hashed in DB, 30 d, rotation); passwords with **bcryptjs** (cost 10; pure JS, no native build) |
| Auth (devices) | Custom `deviceAuth` plugin: HMAC-SHA256 signature, timestamp window, nonce replay table (§5.7.4) |
| Realtime | **Socket.IO** on the same HTTP server, path `/socket.io` |
| Workers | In-process loops using DB state (restart-safe): `deadlineWorker` (1 s), `deadManWorker` (15 s), `commandExpiryWorker` (30 s), `retentionWorker` (daily) |
| Push | `firebase-admin` (optional; disabled if `FCM_SERVICE_ACCOUNT_JSON` unset) |
| Email (nice) | Nodemailer (disabled if `SMTP_URL` unset) |
| PDF (nice) | `pdfkit` |
| Logging | pino (JSON), request id on every log line; phone numbers masked |
| Security middleware | `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` |
| Testing | Vitest + `app.inject()`; fake clock for deadline tests; Postgres service in CI |

**Backend module layout**

```text
apps/api/src/
  server.ts app.ts config.ts (zod-validated env)
  plugins/ prisma.ts auth.ts deviceAuth.ts socket.ts errors.ts rateLimit.ts
  modules/
    auth/        routes.ts service.ts schemas.ts
    users/       me, push tokens, settings
    drivers/     emergency contact, active rental, pending question, history, lookup
    bikes/       CRUD, pairing, locations, status, device config
    devices/     device gateway routes (/d/v1), ingest service, command service
    rentals/     assign/end, state machine, snapshots
    incidents/   upsert, decision engine, responses, acknowledge, severity, integrity hash
    images/      upload sessions, chunks, complete, signed URLs
    notifications/ logical notifications + attempts, push dispatch
    analytics/   aggregates
    admin/       device provisioning, users, health
    demo/        reset, scenario triggers (admin/demo only)
    public/      tokenised status page (nice)
  workers/ deadline.ts deadMan.ts commandExpiry.ts retention.ts
  lib/ hmac.ts crypto.ts (AES-GCM for device secrets) geo.ts (haversine, outliers) time.ts sms.ts mask.ts
```

**Business-logic core (the parts that must be exactly right):**
1. **Rental invariants** — at most one open rental per bike and per driver (DB partial unique indexes); snapshots of owner phone, driver name/phone, contact name/phone taken at assignment; device ack moves `PENDING_SYNC → ACTIVE`.
2. **Incident upsert** — idempotent on device `eventId`; recipient snapshot immutable; rental resolved by `(bikeId, assignmentVersion)`; mismatches quarantined, never dropped.
3. **Decision engine** — single-winner row lock among: driver app response, device button response, deadline worker (§5.3.6).
4. **Notification truthfulness** — logical notification unique per `(incidentId, kind)`; physical attempts append-only.
5. **Image integrity** — sequential offsets, size cap, SHA-256 match before `COMPLETE`.

### 4.4 Communication Layer

| Link | Protocol | Direction | Payload | Frequency |
|---|---|---|---|---|
| Device → API | **HTTP/1.1 over GPRS**, JSON, HMAC headers, path `/d/v1/*` | Device-initiated only | Heartbeat/telemetry batch, incidents, notification states, image chunks | 10 s (ON) / 60 s (OFF) / 3 s control poll during incidents |
| API → Device | **Piggybacked commands** in every device response + explicit `GET /control` during incidents | Pull | `SET_ASSIGNMENT`, `CLEAR_ASSIGNMENT`, `SET_CONFIG`, `INCIDENT_DECISION`, `DEMO_TRIGGER` | As above |
| App ↔ API | **HTTPS REST** `/api/v1/*` | Request/response | CRUD, responses | On demand |
| API → App | **WSS Socket.IO** | Server push | `incident.*`, `bike.updated`, `rental.updated`, `device.status` | Immediate |
| API → App | **FCM** | Push | Title/body + `incidentId` | On incident/question |
| Device → phones | **GSM SMS** (`AT+CMGS`), optional voice call (`ATD`) | Device | ≤ 160-char English text | On incident |
| Main ESP32 ↔ ESP32-CAM | **HTTP over local Wi-Fi AP** (WPA2, SSID `CL-<code>`) | Main requests, camera responds | `GET /capture?eventId&nonce&sig` → JPEG | Once per incident (+ retries) |
| MQTT | **Not in MVP.** Mosquitto service defined behind a compose profile for the scale phase; topic design in §5.3.10. | — | — | — |

**Why HTTP instead of MQTT for the device in the MVP:** each SIM800L HTTP transaction is independent (no long-lived session to lose), maps directly onto chunked image upload, and shares one code path for every message. During an incident the 3 s control poll gives the same user-visible latency as MQTT would over 2G.

#### 4.4.1 Incident sequence (online, happy path and timeout)

```mermaid
sequenceDiagram
  autonumber
  participant D as Main ESP32 + SIM800L
  participant C as ESP32-CAM
  participant A as CrashLink API
  participant DR as Driver app
  participant OP as Owner phone
  participant OW as Owner app
  participant EC as Emergency contact
  Note over D: Bike fallen; 10 s persistence confirmed
  D->>D: Create eventId, persist to NVS, buzzer + red LED
  D-->>OP: SMS to owner (AT+CMGS) - highest modem priority
  D->>A: POST notifications OWNER_SMS AT_SUBMITTED
  D->>C: GET /capture (local Wi-Fi)
  C-->>D: JPEG (~20 KB)
  D->>A: PUT /d/v1/incidents/{eventId}
  A->>A: Upsert incident, severity, questionSentAt = now, deadline = +60 s
  A-->>D: decision PENDING, responseDeadlineAt
  A-->>OW: Socket incident.created + FCM
  A-->>DR: Socket incident.question + FCM
  DR->>A: POST question-ack (CLIENT_RECEIVED)
  loop every 3 s until decided
    D->>A: GET /d/v1/incidents/{eventId}/control
    A-->>D: decision PENDING
  end
  alt Driver taps I'M SAFE before deadline
    DR->>A: POST /incidents/{id}/responses SAFE
    A->>A: Row lock: decision SAFE, source APP
    A-->>DR: accepted, syncing to bike
    D->>A: GET control
    A-->>D: decision SAFE, commandId
    D->>A: POST control ack
    A-->>DR: Synced with bike
  else No response by deadline
    A->>A: Deadline worker: decision TIMEOUT, CONTACT_SMS REQUESTED
    D->>A: GET control
    A-->>D: decision TIMEOUT
    D-->>EC: SMS with incident + maps link
    D->>A: POST notifications CONTACT_SMS AT_SUBMITTED
    A-->>OW: incident.updated ESCALATED
  end
  D->>A: Image session, chunks, complete (lowest priority)
  A-->>OW: incident.updated photo AVAILABLE
```

#### 4.4.2 Offline fallback sequence

```mermaid
sequenceDiagram
  autonumber
  participant D as Main ESP32 + SIM800L
  participant A as CrashLink API
  participant EC as Emergency contact
  Note over D: Incident created, GPRS unavailable
  D-->>D: Owner SMS still attempted (SMS does not need GPRS)
  D->>A: PUT incident (fails / times out)
  D->>D: Start local 60 s timer from incident creation, accept only bike buttons
  alt Safe button pressed on bike
    D->>D: Resolve locally, decisionSource DEVICE_BUTTON
  else 60 s elapse
    D-->>EC: Contact SMS, decision OFFLINE_FALLBACK
  end
  Note over D,A: When GPRS returns
  D->>A: PUT incident (same eventId) + local decision + notification attempts
  A->>A: Reconcile by eventId, no second contact SMS, UI shows "No app question was confirmed"
```

#### 4.4.3 Image upload sequence

```mermaid
sequenceDiagram
  participant D as Main ESP32
  participant A as API
  D->>A: POST /d/v1/incidents/{eventId}/image/session {bytes, sha256, chunkSize 2048}
  A-->>D: {sessionId, nextOffset 0}
  loop until all bytes sent
    D->>A: PUT /d/v1/images/{sessionId}/chunks/{offset} (octet-stream)
    A-->>D: {nextOffset}
  end
  D->>A: POST /d/v1/images/{sessionId}/complete
  A->>A: Verify size + SHA-256, move to /data/images/yyyy/mm/{incidentId}.jpg
  A-->>D: {state COMPLETE}
  Note over D,A: Retry after reboot resumes from server nextOffset
```

### 4.5 State Machines

#### 4.5.1 Device incident state machine (main ESP32 — authoritative for detection)

```mermaid
stateDiagram-v2
  [*] --> MONITORING
  MONITORING --> FALL_CANDIDATE: tilt beyond fallAngle
  FALL_CANDIDATE --> MONITORING: recovers below recoverAngle before 10 s
  FALL_CANDIDATE --> INCIDENT: fallen for 10 s
  MONITORING --> ESCALATE: SOS button (MANUAL_SOS)
  INCIDENT --> AWAITING_RESPONSE: owner SMS queued, incident PUT attempted
  AWAITING_RESPONSE --> RESOLVED: SAFE (bike button or server SAFE)
  AWAITING_RESPONSE --> ESCALATE: HELP, server TIMEOUT, SOS, or offline 60 s
  ESCALATE --> ESCALATED: contact SMS submitted (retries bounded)
  RESOLVED --> REARM_WAIT
  ESCALATED --> REARM_WAIT
  REARM_WAIT --> MONITORING: bike upright for 5 s
```

Only a persistent fall **with simulated ignition ON** enters the EMERGENCY path. With ignition OFF the same fall becomes `PARKED_BIKE_FALL` (SECURITY: owner SMS, no driver question).

#### 4.5.2 Server incident state machine

```mermaid
stateDiagram-v2
  [*] --> AWAITING_RESPONSE: EMERGENCY incident with matched rental
  [*] --> ESCALATED: MANUAL_SOS or device already decided HELP/OFFLINE_FALLBACK
  [*] --> OPEN: SECURITY incident, or EMERGENCY without server question (quarantined)
  [*] --> INFO_RECORDED: INFO event
  AWAITING_RESPONSE --> RESOLVED_SAFE: first accepted SAFE
  AWAITING_RESPONSE --> ESCALATED: HELP or deadline TIMEOUT
  RESOLVED_SAFE --> CLOSED: owner acknowledges
  ESCALATED --> CLOSED: owner acknowledges
  OPEN --> CLOSED: owner acknowledges
```

#### 4.5.3 Rental lifecycle

```mermaid
stateDiagram-v2
  [*] --> PENDING_SYNC: owner assigns (SET_ASSIGNMENT queued)
  PENDING_SYNC --> ACTIVE: device ack, or demo force-activate
  PENDING_SYNC --> CANCELLED: owner cancels
  ACTIVE --> ENDING_SYNC: owner ends (CLEAR_ASSIGNMENT queued)
  ENDING_SYNC --> ENDED: device ack, or 10 min timeout with warning
  ENDED --> [*]
  CANCELLED --> [*]
```

### 4.6 Database Layer (summary — full design in §5.6)

- **PostgreSQL 16** — relational integrity for users ↔ bikes ↔ rentals ↔ incidents, partial unique indexes for rental invariants, row locks for the decision race, JSONB for evidence and sensor windows.
- **Storage strategy:** hot relational data in Postgres; images as files on a Docker volume (`/data/images/yyyy/mm/<incidentId>.jpg`) referenced by `storage_key`; location samples bounded by retention (30 days default) and de-duplicated on `(bike_id, fix_at)`.
- **Time:** all timestamps `timestamptz` in UTC; apps render in `Asia/Colombo`.

### 4.7 Infrastructure Layer (Contabo VPS)

```mermaid
flowchart TB
  Internet(("Internet")) --> FW["UFW: 22, 80, 443"]
  FW --> NG["Nginx (host)"]
  NG -- ":443 /api/ /socket.io/ /t/" --> API
  NG -- ":80 /d/ only (device gateway, no redirect)" --> API
  NG -- ":443 status.domain (basic auth)" --> KUMA
  subgraph Docker["docker compose"]
    API["api: Node 20, 127.0.0.1:3000"]
    DB[("db: postgres:16-alpine")]
    KUMA["uptime-kuma: 127.0.0.1:3001"]
    MQ["mosquitto (profile mqtt, future)"]
  end
  API --> DB
  API --> VOL[("volume: images")]
  CERT["certbot (Let's Encrypt, auto-renew)"] --> NG
  CRON["cron: pg_dump nightly + image tar weekly"] --> DB
```

| Component | Choice | Notes |
|---|---|---|
| OS | Ubuntu 24.04 LTS (22.04 fine) | UTC timezone, unattended upgrades |
| Reverse proxy | **Nginx** on host | TLS, WebSocket upgrade, rate limiting, body-size limits, `/d/` over plain HTTP |
| Backend | Docker container `api` | Bound to 127.0.0.1 only |
| MQTT broker | Mosquitto (future, compose profile) | Not exposed in MVP |
| Database | Docker `postgres:16-alpine`, named volume | Nightly `pg_dump` |
| SSL | Let's Encrypt via certbot (`--nginx`) | Needs a DNS name (A5) |
| Monitoring | **Uptime Kuma** (HTTP checks on `/health`, device-gateway `/d/v1/time`, keyword checks), pino logs via `docker compose logs`, `/api/v1/admin/health` (worker lag, stale devices), optional Netdata | Alerts to Telegram/email (Kuma supports both, free) |

---
## Phase 5 — Functional Specification Document (FSD)

### 5.1 Overview

#### 5.1.1 Project background
Rental motorcycles give affordable, flexible mobility, but once a bike leaves the owner's premises nobody knows if the rider has crashed, where, or whether they need help. CrashLink is an IoT safety system for rental motorcycles: a bike unit (ESP32, MPU6050, NEO-6M, SIM800L, ESP32-CAM) detects and classifies incidents using sensor fusion, alerts the owner by SMS and app, asks the rider to confirm safety, and escalates to the rider's registered emergency contact when help is requested or no answer arrives.

#### 5.1.2 Objectives
1. Detect persistent falls (10 s) and classify them by context (ignition, pre-event speed, impact, rotation).
2. Alert the owner by SMS immediately and in the app within seconds, with an honestly qualified location.
3. Ask the rider "Are you safe?" with a 60 s window starting when the question is sent; accept app or bike-button responses.
4. Escalate to the rental-specific emergency contact on HELP, timeout, SOS, or offline fallback — exactly once.
5. Capture and deliver one photo per incident privately to the owner without delaying any SMS.
6. Record separate event types: parked fall, towing, tampering, pothole, dangerous cornering.
7. Maintain rentals, trip distance, riding/parking durations, device health and history.
8. Be demo-stable: simulator, demo mode, honest labels.

#### 5.1.3 Scope

| In scope (this FSD) | Out of scope |
|---|---|
| Android app (Owner, Driver, Admin, Guest), backend API, device gateway protocol, database, deployment on Contabo VPS, device simulator, firmware ↔ backend contract | iOS app; Play Store publishing; payments/booking; phone OTP verification; paid SMS gateway; real ignition-line wiring; charging circuit; medical assessment; integration with real emergency dispatch |

#### 5.1.4 Glossary
**Incident** – any recorded event (EMERGENCY, SECURITY or INFO). **Question** – the "Are you safe?" prompt. **Decision** – SAFE / HELP / TIMEOUT / OFFLINE_FALLBACK. **Snapshot** – recipient phone numbers copied at rental assignment. **Assignment version** – monotonically increasing number per device identifying which rental snapshot the device holds. **Logical notification** – one intended message (e.g., the contact SMS of incident X); **attempt** – one physical try.

### 5.2 User Requirements

Priority: **M** = Must (competition MVP), **S** = Should, **N** = Nice-to-have, **F** = Future.

#### 5.2.1 Functional requirements

**Authentication & accounts**

| ID | Requirement | Pri |
|---|---|---|
| FR-AUTH-01 | Users register as OWNER or DRIVER with name, email, E.164 phone, password (≥ 8). | M |
| FR-AUTH-02 | Users log in with email or phone + password; receive access (1 h) and refresh (30 d) tokens. | M |
| FR-AUTH-03 | Refresh tokens rotate on use; logout revokes. | M |
| FR-AUTH-04 | Password reset with 6-digit code (email or demo log), 15 min expiry, 5 attempts. | N |
| FR-AUTH-05 | Guest/Judge login to a read-only seeded owner account. | N |
| FR-AUTH-06 | Drivers must accept the privacy/consent notice before their first rental. | S |

**Driver profile**

| ID | Requirement | Pri |
|---|---|---|
| FR-DRV-01 | Driver creates/updates one current emergency contact (name, E.164 phone, relationship). Updating creates a new row and marks the old one not current (history preserved). | M |
| FR-DRV-02 | Driver sees own active rental (bike, start, distance, ignition, location freshness, bike connectivity). | M |
| FR-DRV-03 | Driver sees own rentals and own incidents (no photos). | M |
| FR-DRV-04 | Contact changes during an active rental apply to the **next** rental; the UI states this. | M |

**Bikes & devices**

| ID | Requirement | Pri |
|---|---|---|
| FR-DEV-01 | Admin provisions a device (code, HMAC secret shown once, pairing code) via CLI or UI. | M (CLI) |
| FR-DEV-02 | Owner creates bikes (label, plate) and pairs a device using code + pairing code. | M |
| FR-DEV-03 | Owner unpairs a device only when the bike has no open rental. | S |
| FR-DEV-04 | Owner sees device health: online state, last seen, firmware, CSQ, GPRS, GPS fix/sats/HDOP, camera link, battery (nullable), config version applied, queued jobs. | M |
| FR-DEV-05 | Owner edits non-safety device config; changes queue a `SET_CONFIG` command; UI shows pending/applied. Fall check (10 s) and response window (60 s) are read-only. | S |
| FR-DEV-06 | Admin revokes a device; revoked devices get 401 on every call. | S |
| FR-DEV-07 | QR pairing. | N |

**Rentals**

| ID | Requirement | Pri |
|---|---|---|
| FR-RENT-01 | Owner assigns a driver (who has a current emergency contact) to a paired bike. Server snapshots owner phone, driver name/phone, contact name/phone. | M |
| FR-RENT-02 | At most one open rental (`PENDING_SYNC`, `ACTIVE`, `ENDING_SYNC`) per bike and per driver (DB-enforced). | M |
| FR-RENT-03 | Rental becomes ACTIVE only after device ack of `SET_ASSIGNMENT`; UI shows sync state. Demo force-activate is allowed only when `DEMO_MODE=true`, audit-logged and visibly flagged. | M |
| FR-RENT-04 | Owner ends a rental; `CLEAR_ASSIGNMENT` is queued; ENDED on ack (or after 10 min with warning). | M |
| FR-RENT-05 | Trip distance accumulates from valid, plausible consecutive GPS points (≥ 5 m movement, ≤ 150 km/h implied speed, HDOP ≤ 5). | M |
| FR-RENT-06 | Riding time and parked time computed from ignition events; "parked for X min" shown when ignition OFF. | S |

**Monitoring**

| ID | Requirement | Pri |
|---|---|---|
| FR-MON-01 | Device heartbeats update last seen, health, ignition and location; pushed to apps in realtime. | M |
| FR-MON-02 | Online/stale/offline computed per §2.3.3. | M |
| FR-MON-03 | Location freshness badge on every location. Demo-sourced locations always display `DEMO`. | M |
| FR-MON-04 | Fleet map with all owner bikes. | S |

**Incidents & alerts**

| ID | Requirement | Pri |
|---|---|---|
| FR-INC-01 | Device incident upsert is idempotent on `eventId`; duplicates never create second incidents, questions or notifications. | M |
| FR-INC-02 | EMERGENCY incident with a matched active rental creates a driver question: `questionSentAt = now`, `responseDeadlineAt = +60 s`. | M |
| FR-INC-03 | First accepted response before the deadline wins (app or device); later responses stored with `accepted=false, reason`. | M |
| FR-INC-04 | HELP → decision HELP immediately; deadline passed without response → TIMEOUT; both create exactly one logical `CONTACT_SMS`. | M |
| FR-INC-05 | Device-reported decisions (DEVICE_BUTTON, OFFLINE_FALLBACK) are reconciled without duplicating the contact SMS. | M |
| FR-INC-06 | Incident mismatching the device's assignment version is stored and flagged `quarantined`; no question is created; owner alerted. | M |
| FR-INC-07 | Owner sees incident list/detail with type ("Possible …"), severity, location + freshness, timeline, evidence, response, photo state. | M |
| FR-INC-08 | Owner acknowledges/closes an incident with an optional note. | S |
| FR-INC-09 | SECURITY and INFO incidents never create driver questions. | M |
| FR-INC-10 | Server creates `DEVICE_OFFLINE_DURING_RENTAL` when an ACTIVE rental's device is silent > 90 s (ignition ON) or > 300 s (OFF); auto-closes when device returns. | S |
| FR-INC-11 | Severity index 0–100 with label; integrity hash of the canonical incident + photo. | S |
| FR-INC-12 | Black-box sensor window chart. | N |
| FR-INC-13 | Driver app manual SOS → `MANUAL_SOS` incident → `INCIDENT_DECISION HELP` to device. | N |

**Notifications**

| ID | Requirement | Pri |
|---|---|---|
| FR-NOT-01 | Logical notifications `OWNER_SMS`, `CONTACT_SMS`, `CONTACT_CALL`, `DRIVER_PROMPT`, `OWNER_PUSH` unique per incident; attempts append-only with states (§5.6). | M |
| FR-NOT-02 | UI never shows "delivered" unless the state is `NETWORK_CONFIRMED` (SMS) or `CLIENT_RECEIVED` (app). | M |
| FR-NOT-03 | Realtime socket events to owner and driver rooms. | M |
| FR-NOT-04 | FCM push to owner (incident) and driver (question). | S |
| FR-NOT-05 | Driver app polls pending question every 5 s while a rental is active and foregrounded. | M |

**Images**

| ID | Requirement | Pri |
|---|---|---|
| FR-IMG-01 | Resumable chunked upload with SHA-256 verification; max 200 KB per image, chunk ≤ 8 KB. | M |
| FR-IMG-02 | Images served only via short-lived signed URLs to the owning owner (and admin). | M |
| FR-IMG-03 | Photo status shown: NOT_REQUESTED / PENDING / UPLOADING (%) / AVAILABLE / FAILED. | M |

**Analytics**

| ID | Requirement | Pri |
|---|---|---|
| FR-ANA-01 | Dashboard KPIs. | M |
| FR-ANA-02 | Incidents by type, incidents over time, distance per bike. | S |
| FR-ANA-03 | Response outcome stats, riding vs parked time, pothole map. | N |
| FR-ANA-04 | Incident PDF report. | N |

**Admin & demo**

| ID | Requirement | Pri |
|---|---|---|
| FR-ADM-01 | `GET /admin/health`: DB OK, worker last-run times, stale devices, pending commands. | S |
| FR-DEMO-01 | Seed script: admin, demo owner "Nimal", demo driver "Ravi", contact, bike "Scooter 1" paired to `CL-0001`. | M |
| FR-DEMO-02 | Device simulator CLI that speaks the real device protocol (HMAC) and plays scenarios. | M |
| FR-DEMO-03 | Demo reset endpoint/CLI (clears incidents/rentals of demo data only). | M |
| FR-DEMO-04 | `DEMO_TRIGGER` command lets the owner app trigger a scenario on the real device (e.g. towing) — labelled simulated. | N |

#### 5.2.2 Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Latency | Device PUT incident → owner app realtime update ≤ 2 s (server side). Driver response → device learns decision ≤ control poll interval (3 s) + GPRS latency. |
| NFR-02 | Availability (demo) | API up for the whole event day; Uptime Kuma checks every 60 s; `restart: unless-stopped`. |
| NFR-03 | Reliability | All device mutations idempotent; workers restart-safe; no duplicate logical SMS under retries, reboots or concurrent requests. |
| NFR-04 | Honesty | No UI string may claim delivery, liveness or medical status that the data does not prove. Incident labels begin with "Possible" (except MANUAL_SOS and DEVICE_OFFLINE_DURING_RENTAL). |
| NFR-05 | Security | HTTPS for apps; HMAC for devices; RBAC on every endpoint; rate limiting; no secrets in repo; phone numbers masked in logs. |
| NFR-06 | Privacy | Consent notice; photos owner-only; retention: locations 30 d, images 90 d, audit 180 d (configurable). |
| NFR-07 | Performance | Single 4 GB VPS supports ≥ 200 devices at 10 s intervals; p95 API < 300 ms (excluding GPRS). |
| NFR-08 | Usability | Emergency screen reachable with zero taps; primary buttons ≥ 72 dp; text readable at arm's length; trilingual emergency strings (S). |
| NFR-09 | Compatibility | Android 10+ (API 29+); tested on the actual demo phones. |
| NFR-10 | Maintainability | TypeScript strict; shared zod contracts; ≥ 1 automated test per critical rule in §5.3.6. |
| NFR-11 | Observability | Structured logs with request id; `/health`; `/admin/health`; every incident has a complete timeline. |
| NFR-12 | Data efficiency | Device payload ≤ 4 KB per heartbeat; image ≤ 25 KB target, 200 KB hard cap. |

### 5.3 Device Protocol

#### 5.3.1 Transport and base URL
- Base: `http://<API_HOST>/d/v1` (plain HTTP on port 80, served by Nginx without redirect). If `AT+HTTPSSL`/TinyGSM secure client is verified against the VPS, use `https://` — no other change.
- Content: `application/json; charset=utf-8` (image chunks `application/octet-stream`).
- Every JSON body includes `"schema": 1`.
- Timestamps: UTC ISO-8601 with `Z`. Device time source is `GPS`, `SERVER_SYNC` (from `serverTime` in any response) or `UNSYNCED` (then the server uses receive time and marks it).
- Firmware libraries (recommended): TinyGSM (SIM800), ArduinoHttpClient, TinyGPSPlus, ArduinoJson, mbedtls (built into ESP32 core) for HMAC/SHA-256, Preferences (NVS), LittleFS.

#### 5.3.2 Request signing (every endpoint except `GET /time`)

Headers:

```text
X-Device-Id: CL-0001
X-Timestamp: 1790000000            (unix seconds)
X-Nonce: 9f1c2a7b5e3d4c10          (16 hex chars, random per request)
X-Content-SHA256: <hex sha256 of raw body; sha256("") for empty>
X-Signature: <hex HMAC-SHA256(secret, canonical)>
```

Canonical string (fields joined by `\n`):

```text
METHOD
PATH_WITH_QUERY          (e.g. /d/v1/incidents/7a2d.../control)
X-Timestamp
X-Nonce
X-Content-SHA256
```

Server checks: device exists and not revoked → `|now − timestamp| ≤ 300 s` → nonce unused for this device in last 10 min → body hash matches → constant-time signature compare. Errors: `401 BAD_SIGNATURE | STALE_TIMESTAMP | REPLAYED_NONCE | DEVICE_REVOKED`.

`GET /d/v1/time` (unsigned) → `{"serverTime":"2026-09-21T06:30:00Z","epoch":1790000000}` for bootstrap clock sync.

#### 5.3.3 Heartbeat / telemetry — `POST /d/v1/heartbeat`

Request:

```json
{
  "schema": 1,
  "deviceTime": "2026-09-21T06:30:05Z",
  "timeSource": "GPS",
  "fw": "1.0.0",
  "assignmentVersion": 12,
  "configVersion": 4,
  "ignition": { "state": "ON", "changedAt": "2026-09-21T06:10:00Z" },
  "ignitionEvents": [ { "state": "ON", "t": "2026-09-21T06:10:00Z" } ],
  "fixes": [
    { "t": "2026-09-21T06:29:55Z", "lat": 6.914700, "lon": 79.972900, "spd": 18.4, "hdop": 1.1, "sat": 7, "valid": true, "src": "GPS" }
  ],
  "events": [
    { "eventId": "0b8f...", "type": "POSSIBLE_POTHOLE", "t": "2026-09-21T06:29:40Z",
      "evidence": { "peakAccelerationG": 1.9, "durationMs": 180 }, "lat": 6.9146, "lon": 79.9727 }
  ],
  "health": { "csq": 17, "gprs": true, "gpsFix": true, "sats": 7, "hdop": 1.1, "cameraLink": true,
              "batteryV": null, "freeHeap": 81234, "uptimeS": 3600, "queuedJobs": 0, "demoMode": false,
              "resetReason": "POWERON" },
  "state": { "mode": "MONITORING", "activeEventId": null }
}
```

Rules: ≤ 10 fixes and ≤ 5 events per heartbeat; fixes de-duplicated on `(bike, t)`; invalid coordinates (outside ±90/±180, or 0,0) rejected per-item, not per-request; INFO events in `events[]` are upserted as incidents with category INFO. `src: "DEMO"` fixes only accepted when the device config has `demoMode: true`.

Response (all device endpoints return `serverTime`, `configVersion` and `commands`):

```json
{
  "serverTime": "2026-09-21T06:30:06Z",
  "configVersion": 5,
  "nextIntervalSec": 10,
  "commands": [
    { "id": "c1d2...", "type": "SET_ASSIGNMENT", "payload": {
        "rentalId": "88b7...", "assignmentVersion": 13, "bikeLabel": "Scooter 1",
        "ownerPhone": "+94771234567", "driverName": "Ravi", "driverPhone": "+94779876543",
        "contactName": "Kamala", "contactPhone": "+94712223344" } }
  ]
}
```

#### 5.3.4 Commands

| Type | Payload | Device action | Ack |
|---|---|---|---|
| `SET_ASSIGNMENT` | rental snapshot (above) | Persist snapshot + version in NVS atomically; only then ack | `POST /d/v1/commands/{id}/ack {"result":"APPLIED","assignmentVersion":13}` |
| `CLEAR_ASSIGNMENT` | `{ "rentalId", "assignmentVersion" }` | Clear active assignment **after** finishing any in-flight incident (keeps its snapshot) | Same |
| `SET_CONFIG` | full config object (§5.3.9) + `configVersion` | Validate ranges, persist, apply | Same (`"result":"REJECTED","reason":"..."` allowed) |
| `INCIDENT_DECISION` | `{ "eventId", "decision": "SAFE"|"HELP"|"TIMEOUT" }` | As §5.3.6 | `POST /d/v1/incidents/{eventId}/control/{commandId}/ack` |
| `DEMO_TRIGGER` | `{ "scenario": "TOWING"|"CORNERING"|"POTHOLE"|"PARKED_FALL"|"TAMPER" }` | Only if `demoMode`; emits the event with `"simulated": true` in evidence | Same as generic ack |

Commands are delivered in creation order, repeated in every response until acked or expired (default 24 h; `INCIDENT_DECISION` 1 h). Ack is idempotent.

#### 5.3.5 Incident upsert — `PUT /d/v1/incidents/{eventId}`

Request (unknown fields are `null`, never fabricated):

```json
{
  "schema": 1,
  "eventId": "7a2d8994-71ee-4dd7-86aa-17a5f2587a80",
  "rentalId": "88b74d83-d9b2-48c5-a622-61fb6b684a61",
  "assignmentVersion": 13,
  "type": "POSSIBLE_LOW_SPEED_RIDER_DROP",
  "occurredAt": "2026-09-21T06:30:00Z",
  "timeSource": "GPS",
  "ignition": "ON",
  "preEventSpeedKph": 8.5,
  "evidence": { "fallenDurationMs": 10000, "peakAccelerationG": 2.1, "peakRotationDps": 180,
                "maxTiltDeg": 84, "simulated": false },
  "sensorWindow": { "hz": 5, "t0": "2026-09-21T06:29:55Z",
                    "a": [1.0,1.1,2.1,0.9], "g": [5,40,180,12], "tilt": [3,20,84,85], "spd": [9,8.5,2,0] },
  "location": { "kind": "LAST_KNOWN", "lat": 6.9147, "lon": 79.9729,
                "fixAt": "2026-09-21T06:29:20Z", "ageSecondsAtEvent": 40, "src": "GPS" },
  "photoStatus": "PENDING",
  "localDecision": null,
  "recipients": { "ownerPhoneLast4": "4567", "contactPhoneLast4": "3344" }
}
```

`localDecision` (when the device already decided, e.g. after offline fallback): `{ "decision": "OFFLINE_FALLBACK"|"SAFE"|"HELP", "source": "DEVICE_BUTTON"|"DEVICE_OFFLINE_TIMER", "decidedAt": "..." }`.

Server behaviour:
1. If `eventId` exists → return current state (idempotent; merge `localDecision` if server decision is still PENDING).
2. Resolve rental by `(bike, assignmentVersion)`; verify `rentalId` matches. On mismatch → store with `quarantined=true`, no question, owner alert.
3. Category by type; severity computed; snapshots copied **from the rental row** (the device's last-4 digits are a consistency check only).
4. EMERGENCY + matched rental + no `localDecision` → `AWAITING_RESPONSE`, create `DRIVER_PROMPT` + `OWNER_PUSH` notifications, emit sockets, send FCM.
5. `MANUAL_SOS` → `ESCALATED`, decision HELP, `CONTACT_SMS` logical notification REQUESTED.

Response:

```json
{
  "serverTime": "2026-09-21T06:30:03Z",
  "incidentId": "7a2d8994-71ee-4dd7-86aa-17a5f2587a80",
  "state": "AWAITING_RESPONSE",
  "decision": "PENDING",
  "serverQuestion": true,
  "questionSentAt": "2026-09-21T06:30:03Z",
  "responseDeadlineAt": "2026-09-21T06:31:03Z",
  "configVersion": 5,
  "commands": []
}
```

If `serverQuestion` is `false` (quarantined or no rental), the device runs its **local 60 s timer** as in offline fallback.

#### 5.3.6 Decision, control polling and race policy

`GET /d/v1/incidents/{eventId}/control` →

```json
{ "serverTime": "...", "decision": "PENDING", "commandId": null,
  "responseDeadlineAt": "2026-09-21T06:31:03Z", "decidedAt": null }
```

When decided: `"decision": "SAFE"|"HELP"|"TIMEOUT", "commandId": "…", "decidedAt": "…"`. Device acks with `POST /d/v1/incidents/{eventId}/control/{commandId}/ack {"applied": true, "localState": "RESOLVED"}` → server sets `DriverResponse.syncedToDeviceAt` / emits "Synced with bike".

Local button → `POST /d/v1/incidents/{eventId}/local-response {"choice":"SAFE","deviceTime":"…","idempotencyKey":"…"}` → `{"accepted":true,"decision":"SAFE"}` or `{"accepted":false,"reason":"ALREADY_DECIDED","decision":"TIMEOUT"}`.

**Rules (all enforced in one DB transaction with `SELECT … FOR UPDATE` on the incident row):**

| # | Rule |
|---|---|
| D1 | A response (app or device) is accepted only if `decision = PENDING` and `serverNow < responseDeadlineAt`. |
| D2 | The deadline worker sets TIMEOUT only if `decision = PENDING` and `serverNow ≥ responseDeadlineAt`. |
| D3 | HELP and TIMEOUT create the `CONTACT_SMS` logical notification (unique per incident) in the same transaction. |
| D4 | The device polls control every 3 s while AWAITING_RESPONSE. If it has had **no successful control response** by `responseDeadlineAt + 15 s` (grace), it escalates locally (`DEVICE_OFFLINE_TIMER`) and reports later. |
| D5 | A local **SAFE button** press resolves the device locally **unless** the device has already received HELP/TIMEOUT or already submitted the contact SMS. It is reported; the server applies D1. |
| D6 | A local **SOS button** press always escalates immediately (device sends contact SMS) and is reported as HELP / `MANUAL_SOS` if no incident is active. |
| D7 | Responses arriving after a decision are stored with `accepted=false` and shown honestly: e.g. "Safe received after emergency SMS submission". |
| D8 | Offline-fallback reconciliation never creates a second `CONTACT_SMS`; if the server had decided SAFE but the device escalated offline, both facts are shown. |
| D9 | Local Safe with no active incident is logged as informational and never pre-resolves a future incident. |
| D10 | Re-arm only after the bike is upright for 5 s; no repeated incidents while the bike stays down. |

#### 5.3.7 Notification reporting — `POST /d/v1/incidents/{eventId}/notifications`

```json
{ "schema": 1, "kind": "OWNER_SMS", "attemptNo": 1, "state": "AT_SUBMITTED",
  "detail": "+CMGS: 23", "deviceTime": "2026-09-21T06:30:02Z" }
```

States: `QUEUED`, `AT_SUBMITTED` (modem returned `+CMGS`), `NETWORK_CONFIRMED` (only if a delivery report `+CDS` was actually received), `FAILED` (`ERROR`/timeout with certainty), `OUTCOME_UNKNOWN` (e.g., reset mid-command). Retry policy on the device: SMS max 3 attempts, 10 s apart; no retry after `AT_SUBMITTED`. Idempotent on `(eventId, kind, attemptNo, state)`.

#### 5.3.8 Detection and classification rules (firmware starting values — **calibrate on the model**)

| Event | Category | Rule (start values, configurable) | Owner SMS | Driver question |
|---|---|---|---|---|
| Fall candidate | — | Tilt from calibrated upright > `fallAngleDeg` (60°) | — | — |
| Persistent fall | — | Candidate sustained `fallConfirmSec` (**10 s**, fixed); recover if tilt < `recoverAngleDeg` (40°) | — | — |
| `POSSIBLE_COLLISION` | EMERGENCY | Persistent fall, ignition ON, and (peak accel ≥ `impactG` 2.5 g **or** pre-event speed ≥ 20 km/h) | Yes | Yes |
| `POSSIBLE_LOW_SPEED_RIDER_DROP` | EMERGENCY | Persistent fall, ignition ON, pre-event speed < 20 km/h or unknown, peak accel < 2.5 g | Yes | Yes |
| `POSSIBLE_ROLLOVER` | EMERGENCY | Persistent fall, ignition ON, cumulative rotation > 150° within 2 s | Yes | Yes |
| `MANUAL_SOS` | EMERGENCY | SOS button (debounced, 1 s hold) or app SOS | Yes | No (already HELP) |
| `PARKED_BIKE_FALL` | SECURITY | Persistent fall with ignition OFF | Yes | No |
| `POSSIBLE_TOWING` | SECURITY | Ignition OFF, ≥ 3 valid fixes, speed ≥ `towMinSpeedKph` (5) sustained `towMinSec` (30 s) and displacement ≥ 50 m | Yes | No |
| `POSSIBLE_TAMPERING` | SECURITY | Ignition OFF, bike upright, repeated handling (accel variance above threshold for > 5 s) or camera link lost while parked | Yes | No |
| `DEVICE_OFFLINE_DURING_RENTAL` | SECURITY | **Server-side** dead-man rule (FR-INC-10) | No (push) | No |
| `POSSIBLE_POTHOLE` | INFO | Vertical accel spike ≥ 1.8 g for < 300 ms while moving, orientation recovers < 1 s | No | No |
| `POSSIBLE_DANGEROUS_CORNERING` | INFO | Lean > `cornerLeanDeg` (35°) for > 1 s at speed ≥ 15 km/h | No | No |

Evidence must include the numbers that triggered the rule. Model-bike scale: speed-based rules cannot be demonstrated indoors → use `DEMO_TRIGGER` or the simulator, labelled `simulated: true`.

#### 5.3.9 Device configuration object

```json
{
  "configVersion": 5,
  "telemetryOnSec": 10, "telemetryOffSec": 60, "controlPollSec": 3,
  "fallConfirmSec": 10, "responseWindowSec": 60, "offlineFallbackSec": 60, "deadlineGraceSec": 15,
  "fallAngleDeg": 60, "recoverAngleDeg": 40, "rearmUprightSec": 5,
  "impactG": 2.5, "rotationDps": 150, "collisionSpeedKph": 20,
  "potholeG": 1.8, "cornerLeanDeg": 35, "cornerMinSpeedKph": 15,
  "towMinSpeedKph": 5, "towMinSec": 30, "towMinDistanceM": 50,
  "autoCallContact": false, "demoMode": false
}
```

Server validation: `fallConfirmSec` must equal 10 and `responseWindowSec` must equal 60 unless an ADMIN changes them (agreed safety parameters, S5).

#### 5.3.10 SMS templates (≤ 160 GSM-7 characters; firmware builds them)

```text
OWNER (emergency):
CRASHLINK ALERT Scooter 1: Possible collision 11:30 21/09. LIVE loc maps.google.com/?q=6.91470,79.97290 Rider asked if safe.

OWNER (no current fix):
CRASHLINK ALERT Scooter 1: Possible rider drop 11:30 21/09. LAST KNOWN 11:29 maps.google.com/?q=6.91470,79.97290

OWNER (never had a fix):
CRASHLINK ALERT Scooter 1: Possible collision 11:30 21/09. Location unavailable. Check CrashLink app.

EMERGENCY CONTACT:
CRASHLINK: Ravi may need help. Possible bike accident 11:30 21/09 maps.google.com/?q=6.91470,79.97290 No reply to safety check. Ambulance 1990

SECURITY:
CRASHLINK Scooter 1: Possible towing (ignition OFF, moving) 02:14 21/09 maps.google.com/?q=6.91470,79.97290
```

Rules: 5 decimal places; time in `Asia/Colombo` (UTC+5:30); names truncated to 12 chars; if > 160, drop "Ambulance 1990" first, then the name.

#### 5.3.11 Local camera link (main ESP32 ↔ ESP32-CAM)

- Main ESP32: `WiFi.mode(WIFI_AP)`; SSID `CL-<code>`, WPA2 password (per device, from NVS), hidden SSID optional, max 1 client.
- ESP32-CAM: STA; HTTP server on port 80; `GET /capture?eventId=<uuid>&nonce=<hex16>&sig=<hmac(camSecret, eventId+nonce)>` → `image/jpeg`, headers `X-SHA256`, `Content-Length`. Frame size QVGA/VGA, JPEG quality 12–15, target ≤ 25 KB. Optional microSD copy `/<eventId>.jpg`.
- `GET /health` → `{ "ok": true, "psram": true, "sd": false }` every 30 s → `cameraLink` health flag.
- Main board streams the JPEG to LittleFS `/img/<eventId>.jpg`, then uploads in 2 KB chunks with lowest modem priority. Note: **ADC2 pins are unusable while Wi-Fi runs** — use ADC1 (GPIO34/35) for battery sensing.

#### 5.3.12 Future MQTT topic design (not in MVP)

`crashlink/v1/{deviceCode}/up/{heartbeat|incident|notification}` (QoS 1), `crashlink/v1/{deviceCode}/down/commands` (QoS 1, retained last config), per-device username = code, password = derived token, Mosquitto ACL restricting each device to its own topic subtree. The same `DeviceIngestService` functions are called by the HTTP routes and a future MQTT subscriber.

---
### 5.4 API Specifications

#### 5.4.1 Conventions
- Base URL: `https://<API_HOST>/api/v1`. JSON only. UTC ISO-8601 timestamps.
- Auth: `Authorization: Bearer <accessToken>` unless marked **Public**. Role column lists who may call.
- Mutations that the app may retry accept an `Idempotency-Key` header (UUID); the server stores the result for 24 h.
- Pagination: `?limit=20&cursor=<opaque>` → `{ "items": [...], "nextCursor": "..." | null }`.
- Error body (all errors):

```json
{ "code": "RENTAL_ACTIVE_EXISTS", "message": "Bike already has an open rental.", "requestId": "req_8f2c...", "details": {} }
```

| HTTP | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` |
| 401 | `UNAUTHORIZED`, `TOKEN_EXPIRED`, `BAD_SIGNATURE`, `STALE_TIMESTAMP`, `REPLAYED_NONCE`, `DEVICE_REVOKED` |
| 403 | `FORBIDDEN`, `READ_ONLY_GUEST` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `EMAIL_TAKEN`, `PHONE_TAKEN`, `RENTAL_ACTIVE_EXISTS`, `DRIVER_BUSY`, `NO_EMERGENCY_CONTACT`, `DEVICE_NOT_PAIRED`, `DEVICE_ALREADY_PAIRED`, `TOO_LATE`, `ALREADY_DECIDED` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` |

Shared object shapes (returned by many endpoints):

```json
// UserDto
{ "id": "uuid", "role": "OWNER", "name": "Nimal Perera", "email": "nimal@demo.lk", "phone": "+94771234567",
  "language": "en", "isDemo": true, "createdAt": "..." }

// BikeSummaryDto
{ "id": "uuid", "label": "Scooter 1", "plateNo": "WP BCD-1234", "status": "RENTED",
  "device": { "code": "CL-0001", "online": "ONLINE", "lastSeenAt": "...", "configVersion": 5, "configPending": false },
  "ignition": { "state": "ON", "changedAt": "..." },
  "location": { "kind": "LIVE", "lat": 6.9147, "lon": 79.9729, "fixAt": "...", "ageSec": 8, "speedKph": 18.4, "source": "GPS" },
  "activeRental": { "id": "uuid", "state": "ACTIVE", "driverName": "Ravi", "startedAt": "...", "distanceM": 5230 },
  "openIncidentCount": 1 }

// DeviceHealthDto
{ "csq": 17, "signalBars": 3, "gprs": true, "gpsFix": true, "sats": 7, "hdop": 1.1, "cameraLink": true,
  "batteryV": null, "freeHeap": 81234, "uptimeS": 3600, "queuedJobs": 0, "fw": "1.0.0", "demoMode": false }

// IncidentSummaryDto
{ "id": "uuid", "bikeId": "uuid", "bikeLabel": "Scooter 1", "type": "POSSIBLE_COLLISION", "category": "EMERGENCY",
  "label": "Possible collision", "state": "AWAITING_RESPONSE", "decision": "PENDING", "severity": { "score": 72, "label": "HIGH" },
  "occurredAt": "...", "responseDeadlineAt": "...", "photoStatus": "PENDING", "quarantined": false, "isDemo": false }
```

#### 5.4.2 Auth & profile

| Method & path | Role | Request | Response |
|---|---|---|---|
| `POST /auth/register` | Public | `{ "role": "OWNER"|"DRIVER", "name", "email", "phone", "password", "language"?: "en", "consentAccepted"?: true }` | `201 { "user": UserDto, "accessToken", "refreshToken", "expiresIn": 3600 }` |
| `POST /auth/login` | Public | `{ "identifier": "email or phone", "password" }` | `200` same as register |
| `POST /auth/refresh` | Public | `{ "refreshToken" }` | `200 { "accessToken", "refreshToken", "expiresIn" }` (old refresh revoked) |
| `POST /auth/logout` | Any | `{ "refreshToken", "pushToken"? }` | `204` |
| `POST /auth/guest` | Public | `{}` | `200` tokens for the read-only demo owner (only if `GUEST_ENABLED=true`) |
| `POST /auth/password/forgot` | Public | `{ "identifier" }` | `202 { "message": "If the account exists, a code was sent." }` |
| `POST /auth/password/reset` | Public | `{ "identifier", "code", "newPassword" }` | `204` / `400 VALIDATION_FAILED` |
| `GET /me` | Any | — | `UserDto` + `{ "settings": {...}, "hasEmergencyContact": true }` |
| `PATCH /me` | Any | `{ "name"?, "phone"?, "language"? }` | `UserDto` |
| `PUT /me/settings` | Any | `{ "notifySecurity": true, "notifyInfo": false, "alarmSound": true, "theme": "system" }` | settings |
| `POST /me/password` | Any | `{ "currentPassword", "newPassword" }` | `204` |
| `POST /me/push-tokens` | Any | `{ "token": "fcm…", "platform": "android" }` | `204` (upsert) |
| `DELETE /me/push-tokens/:token` | Any | — | `204` |

#### 5.4.3 Driver

| Method & path | Role | Request | Response |
|---|---|---|---|
| `GET /drivers/me/emergency-contact` | DRIVER | — | `{ "id", "name", "phone", "relationship", "updatedAt" }` or `404` |
| `PUT /drivers/me/emergency-contact` | DRIVER | `{ "name": "Kamala", "phone": "+94712223344", "relationship": "Mother" }` | `200` contact; `{ "appliesTo": "NEXT_RENTAL" }` if a rental is open |
| `GET /drivers/me/active-rental` | DRIVER | — | `{ "rental": { "id", "state", "startedAt", "distanceM", "bike": { "label", "ignition", "location", "deviceOnline" }, "ownerName", "ownerPhone" } | null }` |
| `GET /drivers/me/pending-question` | DRIVER | — | `{ "serverTime", "question": { "incidentId", "type", "label", "occurredAt", "questionSentAt", "responseDeadlineAt", "myResponse": null } | null }` |
| `POST /incidents/:id/question-ack` | DRIVER (own) | `{}` | `204` → DRIVER_PROMPT `CLIENT_RECEIVED` |
| `POST /incidents/:id/responses` | DRIVER (own) | `{ "choice": "SAFE"|"HELP", "idempotencyKey": "uuid" }` | `200 { "accepted": true, "decision": "SAFE", "serverAcceptedAt", "deviceSync": "PENDING" }`; `409 TOO_LATE { "details": { "decision": "TIMEOUT", "decidedAt": "..." } }` |
| `POST /drivers/me/sos` (N) | DRIVER | `{ "idempotencyKey", "lat"?, "lon"? }` | `201 { "incidentId", "state": "ESCALATED" }` |
| `GET /drivers/me/rentals` | DRIVER | pagination | `{ items: [{ "id", "bikeLabel", "startedAt", "endedAt", "distanceM", "incidentCount" }] }` |
| `GET /drivers/me/incidents` | DRIVER | pagination | `{ items: IncidentSummaryDto[] }` (no photo fields) |
| `GET /drivers/lookup?q=` | OWNER | phone or email (exact match) | `{ "id", "name", "phoneMasked", "hasEmergencyContact": true, "busy": false } | 404` |

#### 5.4.4 Bikes & devices (owner)

| Method & path | Role | Request | Response |
|---|---|---|---|
| `GET /bikes` | OWNER, GUEST | `?status=` | `{ items: BikeSummaryDto[] }` |
| `POST /bikes` | OWNER | `{ "label": "Scooter 1", "plateNo"?: "WP BCD-1234" }` | `201 BikeSummaryDto` |
| `GET /bikes/:id` | OWNER (own), GUEST | — | `BikeSummaryDto` + `{ "health": DeviceHealthDto, "config": ConfigObject, "ridingSecToday", "parkedSinceSec" }` |
| `PATCH /bikes/:id` | OWNER | `{ "label"?, "plateNo"?, "status"?: "MAINTENANCE"|"AVAILABLE" }` | BikeSummaryDto |
| `POST /bikes/:id/pair` | OWNER | `{ "deviceCode": "CL-0001", "pairingCode": "7H3K9QXA" }` | `200` BikeSummaryDto; `409 DEVICE_ALREADY_PAIRED`; `400` bad code (rate-limited 5/min) |
| `DELETE /bikes/:id/pair` | OWNER | — | `204`; `409 RENTAL_ACTIVE_EXISTS` |
| `GET /bikes/:id/locations` | OWNER, GUEST | `?rentalId=&from=&to=&limit=500` | `{ items: [{ "t", "lat", "lon", "spd", "valid", "src" }] }` (downsampled to ≤ 500) |
| `GET /bikes/:id/ignition-events` | OWNER | `?from=&to=` | `{ items: [{ "state", "changedAt" }], "ridingSec", "parkedSec" }` |
| `PUT /bikes/:id/device-config` | OWNER | partial config (§5.3.9, non-locked fields) | `202 { "configVersion": 6, "status": "PENDING_SYNC" }` |
| `POST /bikes/:id/demo-trigger` (N) | OWNER (demo) | `{ "scenario": "TOWING" }` | `202 { "commandId" }` |

#### 5.4.5 Rentals

| Method & path | Role | Request | Response |
|---|---|---|---|
| `POST /rentals` | OWNER | `{ "bikeId", "driverId", "idempotencyKey" }` | `201 { "id", "state": "PENDING_SYNC", "assignmentVersion": 13, "snapshot": { "driverName", "contactName", "contactPhoneMasked" } }`; `409 RENTAL_ACTIVE_EXISTS | DRIVER_BUSY | NO_EMERGENCY_CONTACT | DEVICE_NOT_PAIRED` |
| `POST /rentals/:id/force-activate` | OWNER (only `DEMO_MODE`) | `{ "confirm": true }` | `200 { "state": "ACTIVE", "demoOverride": true }` |
| `POST /rentals/:id/cancel` | OWNER | — | `200 { "state": "CANCELLED" }` (PENDING_SYNC only) |
| `POST /rentals/:id/end` | OWNER | `{ "idempotencyKey" }` | `200 { "state": "ENDING_SYNC" }` |
| `GET /rentals` | OWNER | `?state=&bikeId=` + pagination | `{ items: [...] }` |
| `GET /rentals/:id` | OWNER, DRIVER (own) | — | rental + snapshot (masked phones for DRIVER), distance, incidents, sync timestamps |

#### 5.4.6 Incidents & images

| Method & path | Role | Request | Response |
|---|---|---|---|
| `GET /incidents` | OWNER, GUEST | `?category=&type=&state=&bikeId=&from=&to=` + pagination | `{ items: IncidentSummaryDto[] }` |
| `GET /incidents/:id` | OWNER (own), DRIVER (own, no photo), GUEST | — | IncidentDetailDto (below) |
| `POST /incidents/:id/acknowledge` | OWNER | `{ "note"?: "Rider called, minor scratches" }` | `200 { "state": "CLOSED", "ownerAckAt" }` |
| `GET /incidents/:id/image-url` | OWNER | — | `{ "url": "/api/v1/files/images/<key>?exp=…&sig=…", "expiresAt", "sha256", "bytes" }` or `404` |
| `GET /files/images/:key` | Signed URL (no bearer) | `?exp&sig` | `image/jpeg`, `Cache-Control: private, max-age=300` |
| `GET /incidents/:id/report.pdf` (N) | OWNER | — | `application/pdf` |
| `POST /incidents/:id/share-link` (N) | OWNER | `{ "ttlHours": 24 }` | `{ "url": "https://<host>/t/<token>" }` |

IncidentDetailDto:

```json
{
  "id": "7a2d…", "type": "POSSIBLE_COLLISION", "label": "Possible collision", "category": "EMERGENCY",
  "state": "ESCALATED", "decision": "TIMEOUT", "decisionSource": "SERVER_TIMER", "decidedAt": "...",
  "severity": { "score": 72, "label": "HIGH", "note": "Heuristic from sensor readings; not a medical assessment." },
  "occurredAt": "...", "receivedAt": "...", "timeSource": "GPS",
  "bike": { "id": "...", "label": "Scooter 1" },
  "rental": { "id": "...", "driverName": "Ravi", "driverPhone": "+94779876543" },
  "contact": { "name": "Kamala", "phone": "+94712223344" },
  "ignitionAtEvent": "ON", "preEventSpeedKph": 24.0,
  "location": { "kind": "LIVE", "lat": 6.9147, "lon": 79.9729, "fixAt": "...", "ageSecondsAtEvent": 3, "source": "GPS" },
  "evidence": { "fallenDurationMs": 10000, "peakAccelerationG": 3.1, "peakRotationDps": 220, "maxTiltDeg": 88, "simulated": false },
  "sensorWindow": { "hz": 5, "t0": "...", "a": [], "g": [], "tilt": [], "spd": [] },
  "question": { "sentAt": "...", "deadlineAt": "...", "promptStates": ["REQUESTED", "PROVIDER_ACCEPTED", "CLIENT_RECEIVED"] },
  "responses": [ { "choice": "SAFE", "source": "APP", "serverAcceptedAt": "...", "accepted": false, "reason": "TOO_LATE" } ],
  "notifications": [
    { "kind": "OWNER_SMS", "state": "AT_SUBMITTED", "recipientMasked": "+94•••••4567",
      "attempts": [ { "attemptNo": 1, "state": "AT_SUBMITTED", "at": "...", "detail": "+CMGS: 23" } ] },
    { "kind": "CONTACT_SMS", "state": "AT_SUBMITTED", "recipientMasked": "+94•••••3344", "attempts": [] }
  ],
  "timeline": [ { "at": "...", "event": "DETECTED", "text": "Bike fallen for 10 s" },
                { "at": "...", "event": "OWNER_SMS_SUBMITTED", "text": "Owner SMS submitted to network" } ],
  "photo": { "status": "AVAILABLE", "bytes": 21504, "sha256": "…", "integrity": "VERIFIED" },
  "integrityHash": "sha256:…",
  "ownerAckAt": null, "ownerNote": null, "quarantined": false, "isDemo": false
}
```

#### 5.4.7 Analytics & dashboard

| Method & path | Role | Response |
|---|---|---|
| `GET /owners/me/dashboard` | OWNER, GUEST | `{ "kpis": { "bikesOnline": 3, "bikesTotal": 4, "activeRentals": 2, "openIncidents": 1, "incidentsToday": 3 }, "openEmergency": IncidentSummaryDto|null, "bikes": BikeSummaryDto[], "recent": IncidentSummaryDto[] }` |
| `GET /analytics/incidents-by-type?from&to` | OWNER, GUEST | `{ items: [{ "type", "label", "count" }] }` |
| `GET /analytics/incidents-timeseries?from&to&bucket=day` | OWNER, GUEST | `{ items: [{ "date": "2026-09-20", "EMERGENCY": 1, "SECURITY": 0, "INFO": 4 }] }` |
| `GET /analytics/distance-by-bike?from&to` | OWNER, GUEST | `{ items: [{ "bikeId", "label", "distanceM" }] }` |
| `GET /analytics/response-outcomes?from&to` (N) | OWNER | `{ "SAFE": 5, "HELP": 1, "TIMEOUT": 2, "OFFLINE_FALLBACK": 0, "medianResponseSec": 14 }` |
| `GET /analytics/potholes?from&to` (N) | OWNER, GUEST | `{ items: [{ "lat", "lon", "at", "peakG" }] }` |

#### 5.4.8 Admin & demo

| Method & path | Role | Request | Response |
|---|---|---|---|
| `POST /admin/devices` | ADMIN | `{ "code"?: "CL-0002" }` | `201 { "id", "code", "secret": "<64 hex — shown once>", "pairingCode": "7H3K9QXA", "cameraSecret", "apPassword" }` |
| `GET /admin/devices` | ADMIN | — | `{ items: [{ "code", "paired", "bikeLabel", "lastSeenAt", "fw", "revoked" }] }` |
| `POST /admin/devices/:id/revoke` | ADMIN | — | `204` |
| `GET /admin/users` | ADMIN | `?role=` | users |
| `GET /admin/health` | ADMIN | — | `{ "db": "ok", "workers": { "deadline": { "lastRunAt", "lagMs" }, ... }, "staleDevices": [...], "pendingCommands": 2, "version": "1.0.0" }` |
| `POST /demo/reset` | ADMIN (`DEMO_MODE`) | — | `204` — deletes demo incidents/rentals/locations, resets bike state |
| `POST /demo/scenario` | ADMIN (`DEMO_MODE`) | `{ "deviceCode": "CL-0001", "scenario": "COLLISION_NO_RESPONSE" }` | `202` — runs the in-process simulator against the device gateway service |

#### 5.4.9 Public & health

| Method & path | Auth | Response |
|---|---|---|
| `GET /health` (root, not under /api/v1) | Public | `{ "status": "ok", "db": "ok", "time": "..." }` |
| `GET /t/:token` (N) | Token | Minimal HTML status page: bike label, "Possible incident at …", map link, state, last update. No photo, no phone numbers. |

#### 5.4.10 Rate limits

| Scope | Limit |
|---|---|
| `/auth/login`, `/auth/password/*` | 10/min per IP; 5 failed logins per account per 15 min → 429 |
| `/bikes/:id/pair` | 5/min per user |
| App API general | 120/min per user |
| Device gateway | 60/min per device (burst 20) — heartbeats and chunks combined |

### 5.5 Realtime Events (Socket.IO)

- Connect: `io(API_URL, { path: "/socket.io", auth: { token: accessToken }, transports: ["websocket"] })`.
- Server joins rooms: `user:<id>`, and for owners `owner:<id>`; admins `admin`.
- On `connect`, the app re-fetches active queries (the socket is a hint; REST is the truth).

| Event | Room | Payload |
|---|---|---|
| `bike.updated` | `owner:<ownerId>` | `BikeSummaryDto` |
| `device.status` | `owner:<ownerId>` | `{ "bikeId", "online", "lastSeenAt", "health": DeviceHealthDto }` |
| `rental.updated` | `owner:<ownerId>`, `user:<driverId>` | `{ "id", "bikeId", "state", "startedAt", "endedAt", "deviceAckAt" }` |
| `incident.created` | `owner:<ownerId>` (+ `user:<driverId>` without photo fields) | `IncidentSummaryDto` |
| `incident.updated` | same | `IncidentSummaryDto` + `{ "changed": ["decision","photoStatus",...] }` |
| `incident.question` | `user:<driverId>` | `{ "incidentId", "label", "occurredAt", "questionSentAt", "responseDeadlineAt", "serverTime" }` |
| `incident.decision` | `user:<driverId>`, `owner:<ownerId>` | `{ "incidentId", "decision", "decidedAt", "deviceSynced": false }` |
| `notification.updated` | `owner:<ownerId>` | `{ "incidentId", "kind", "state" }` |

FCM payloads (data + notification): `{ "type": "INCIDENT_QUESTION"|"INCIDENT_CREATED"|"SECURITY_ALERT", "incidentId": "…" }`, channel `emergency` / `security` / `info`. Tapping opens `emergency/<id>` (driver) or `incidents/<id>` (owner).

---
### 5.6 Database Design

#### 5.6.1 Entity-relationship diagram

```mermaid
erDiagram
  USERS ||--o| USER_SETTINGS : has
  USERS ||--o{ BIKES : owns
  USERS ||--o{ EMERGENCY_CONTACTS : "registers (driver)"
  USERS ||--o{ RENTALS : "rides (driver)"
  USERS ||--o{ RENTALS : "rents out (owner)"
  USERS ||--o{ PUSH_TOKENS : has
  USERS ||--o{ REFRESH_TOKENS : has
  DEVICES ||--o| BIKES : "paired to"
  DEVICES ||--o{ DEVICE_COMMANDS : receives
  DEVICES ||--o{ DEVICE_NONCES : uses
  BIKES ||--o{ RENTALS : "rented in"
  BIKES ||--o{ LOCATION_SAMPLES : reports
  BIKES ||--o{ IGNITION_EVENTS : reports
  BIKES ||--o{ INCIDENTS : has
  EMERGENCY_CONTACTS ||--o{ RENTALS : "snapshotted into"
  RENTALS ||--o{ LOCATION_SAMPLES : tracks
  RENTALS ||--o{ INCIDENTS : "context of"
  INCIDENTS ||--o| INCIDENT_IMAGES : has
  INCIDENTS ||--o{ DRIVER_RESPONSES : receives
  INCIDENTS ||--o{ NOTIFICATIONS : triggers
  NOTIFICATIONS ||--o{ NOTIFICATION_ATTEMPTS : "tried as"
  INCIDENTS ||--o{ SHARE_LINKS : "shared via"

  USERS {
    uuid id PK
    enum role
    string email UK
    string phone_e164 UK
    string password_hash
  }
  DEVICES {
    uuid id PK
    string code UK
    string secret_enc
    int config_version
    json config
    timestamptz last_seen_at
  }
  BIKES {
    uuid id PK
    uuid owner_id FK
    uuid device_id FK
    string label
    enum ignition
    float last_lat
    float last_lon
  }
  RENTALS {
    uuid id PK
    uuid bike_id FK
    uuid driver_id FK
    uuid owner_id FK
    uuid emergency_contact_id FK
    string contact_phone_snapshot
    enum state
    int assignment_version
    float distance_meters
  }
  INCIDENTS {
    uuid id PK "device eventId"
    uuid bike_id FK
    uuid rental_id FK
    enum type
    enum category
    enum state
    enum decision
    timestamptz response_deadline_at
    json evidence
  }
  NOTIFICATIONS {
    uuid id PK
    uuid incident_id FK
    enum kind
    enum state
 
  }

```

#### 5.6.2 Prisma schema (authoritative — `apps/api/prisma/schema.prisma`)

> **Pin Prisma 6.x** (`prisma@^6.19`, `@prisma/client@^6.19`). Prisma 7 removed `url` from the datasource block and requires `prisma.config.ts` + driver adapters; do not let a scaffold silently upgrade. This schema was validated against the Prisma 6.19 schema engine.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  OWNER
  DRIVER
  ADMIN
  GUEST
}

enum IgnitionState {
  ON
  OFF
  UNKNOWN
}

enum BikeStatus {
  AVAILABLE
  RENTED
  MAINTENANCE
  INACTIVE
}

enum RentalState {
  PENDING_SYNC
  ACTIVE
  ENDING_SYNC
  ENDED
  CANCELLED
}

enum IncidentType {
  POSSIBLE_COLLISION
  POSSIBLE_LOW_SPEED_RIDER_DROP
  POSSIBLE_ROLLOVER
  MANUAL_SOS
  PARKED_BIKE_FALL
  POSSIBLE_TOWING
  POSSIBLE_TAMPERING
  DEVICE_OFFLINE_DURING_RENTAL
  POSSIBLE_POTHOLE
  POSSIBLE_DANGEROUS_CORNERING
}

enum IncidentCategory {
  EMERGENCY
  SECURITY
  INFO
}

enum IncidentState {
  OPEN
  AWAITING_RESPONSE
  RESOLVED_SAFE
  ESCALATED
  CLOSED
  INFO_RECORDED
}

enum Decision {
  NOT_APPLICABLE
  PENDING
  SAFE
  HELP
  TIMEOUT
  OFFLINE_FALLBACK
}

enum DecisionSource {
  APP
  DEVICE_BUTTON
  SERVER_TIMER
  DEVICE_OFFLINE_TIMER
}

enum LocationKind {
  LIVE
  LAST_KNOWN
  UNAVAILABLE
}

enum LocationSource {
  GPS
  DEMO
}

enum PhotoStatus {
  NOT_REQUESTED
  PENDING
  UPLOADING
  AVAILABLE
  FAILED
}

enum ImageState {
  RESERVED
  UPLOADING
  COMPLETE
  FAILED
}

enum ResponseChoice {
  SAFE
  HELP
}

enum ResponseSource {
  APP
  DEVICE_BUTTON
}

enum NotificationKind {
  OWNER_SMS
  CONTACT_SMS
  CONTACT_CALL
  DRIVER_PROMPT
  OWNER_PUSH
}

enum NotificationState {
  REQUESTED
  QUEUED
  AT_SUBMITTED
  NETWORK_CONFIRMED
  PROVIDER_ACCEPTED
  CLIENT_RECEIVED
  RESPONDED
  FAILED
  OUTCOME_UNKNOWN
}

enum CommandType {
  SET_ASSIGNMENT
  CLEAR_ASSIGNMENT
  SET_CONFIG
  INCIDENT_DECISION
  DEMO_TRIGGER
}

enum CommandStatus {
  QUEUED
  DELIVERED
  ACKED
  REJECTED
  EXPIRED
}

model User {
  id           String    @id @default(uuid()) @db.Uuid
  role         Role
  name         String
  email        String    @unique
  phoneE164    String?   @unique @map("phone_e164")
  passwordHash String    @map("password_hash")
  language     String    @default("en")
  isDemo       Boolean   @default(false) @map("is_demo")
  consentAt    DateTime? @map("consent_at") @db.Timestamptz
  disabledAt   DateTime? @map("disabled_at") @db.Timestamptz
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  settings          UserSettings?
  bikes             Bike[]             @relation("BikeOwner")
  emergencyContacts EmergencyContact[]
  rentalsAsDriver   Rental[]           @relation("RentalDriver")
  rentalsAsOwner    Rental[]           @relation("RentalOwner")
  incidentsAsDriver Incident[]         @relation("IncidentDriver")
  incidentsAsOwner  Incident[]         @relation("IncidentOwner")
  responses         DriverResponse[]
  pushTokens        PushToken[]
  refreshTokens     RefreshToken[]
  passwordResets    PasswordReset[]

  @@map("users")
}

model UserSettings {
  userId         String   @id @map("user_id") @db.Uuid
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  notifySecurity Boolean  @default(true) @map("notify_security")
  notifyInfo     Boolean  @default(false) @map("notify_info")
  alarmSound     Boolean  @default(true) @map("alarm_sound")
  theme          String   @default("system")
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz

  @@map("user_settings")
}

model EmergencyContact {
  id           String   @id @default(uuid()) @db.Uuid
  driverId     String   @map("driver_id") @db.Uuid
  driver       User     @relation(fields: [driverId], references: [id])
  name         String
  phoneE164    String   @map("phone_e164")
  relationship String
  isCurrent    Boolean  @default(true) @map("is_current")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz

  rentals Rental[]

  @@index([driverId, isCurrent])
  @@map("emergency_contacts")
}

model Device {
  id              String    @id @default(uuid()) @db.Uuid
  code            String    @unique
  secretEnc       String    @map("secret_enc")
  pairingCodeHash String    @map("pairing_code_hash")
  firmwareVersion String?   @map("firmware_version")
  configVersion   Int       @default(1) @map("config_version")
  appliedConfigVersion Int  @default(0) @map("applied_config_version")
  config          Json
  lastSeenAt      DateTime? @map("last_seen_at") @db.Timestamptz
  lastHealth      Json?     @map("last_health")
  lastMode        String?   @map("last_mode")
  revokedAt       DateTime? @map("revoked_at") @db.Timestamptz
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  bike      Bike?
  commands  DeviceCommand[]
  nonces    DeviceNonce[]
  incidents Incident[]

  @@map("devices")
}

model Bike {
  id                 String          @id @default(uuid()) @db.Uuid
  ownerId            String          @map("owner_id") @db.Uuid
  owner              User            @relation("BikeOwner", fields: [ownerId], references: [id])
  deviceId           String?         @unique @map("device_id") @db.Uuid
  device             Device?         @relation(fields: [deviceId], references: [id])
  label              String
  plateNo            String?         @map("plate_no")
  status             BikeStatus      @default(AVAILABLE)
  ignition           IgnitionState   @default(UNKNOWN)
  ignitionChangedAt  DateTime?       @map("ignition_changed_at") @db.Timestamptz
  lastLat            Float?          @map("last_lat")
  lastLon            Float?          @map("last_lon")
  lastFixAt          DateTime?       @map("last_fix_at") @db.Timestamptz
  lastSpeedKph       Float?          @map("last_speed_kph")
  lastLocationSource LocationSource? @map("last_location_source")
  isDemo             Boolean         @default(false) @map("is_demo")
  createdAt          DateTime        @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime        @updatedAt @map("updated_at") @db.Timestamptz

  rentals        Rental[]
  locations      LocationSample[]
  ignitionEvents IgnitionEvent[]
  incidents      Incident[]

  @@index([ownerId])
  @@map("bikes")
}

model Rental {
  id                  String           @id @default(uuid()) @db.Uuid
  bikeId              String           @map("bike_id") @db.Uuid
  bike                Bike             @relation(fields: [bikeId], references: [id])
  driverId            String           @map("driver_id") @db.Uuid
  driver              User             @relation("RentalDriver", fields: [driverId], references: [id])
  ownerId             String           @map("owner_id") @db.Uuid
  owner               User             @relation("RentalOwner", fields: [ownerId], references: [id])
  emergencyContactId  String           @map("emergency_contact_id") @db.Uuid
  emergencyContact    EmergencyContact @relation(fields: [emergencyContactId], references: [id])
  ownerPhoneSnapshot  String           @map("owner_phone_snapshot")
  driverNameSnapshot  String           @map("driver_name_snapshot")
  driverPhoneSnapshot String?          @map("driver_phone_snapshot")
  contactNameSnapshot String           @map("contact_name_snapshot")
  contactPhoneSnapshot String          @map("contact_phone_snapshot")
  state               RentalState      @default(PENDING_SYNC)
  assignmentVersion   Int              @map("assignment_version")
  demoOverride        Boolean          @default(false) @map("demo_override")
  requestedAt         DateTime         @default(now()) @map("requested_at") @db.Timestamptz
  deviceAckAt         DateTime?        @map("device_ack_at") @db.Timestamptz
  startedAt           DateTime?        @map("started_at") @db.Timestamptz
  endRequestedAt      DateTime?        @map("end_requested_at") @db.Timestamptz
  endedAt             DateTime?        @map("ended_at") @db.Timestamptz
  distanceMeters      Float            @default(0) @map("distance_meters")
  lastDistanceLat     Float?           @map("last_distance_lat")
  lastDistanceLon     Float?           @map("last_distance_lon")
  lastDistanceAt      DateTime?        @map("last_distance_at") @db.Timestamptz
  createdAt           DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt           DateTime         @updatedAt @map("updated_at") @db.Timestamptz

  locations      LocationSample[]
  ignitionEvents IgnitionEvent[]
  incidents      Incident[]

  @@unique([bikeId, assignmentVersion])
  @@index([bikeId, state])
  @@index([driverId, state])
  @@map("rentals")
}

model LocationSample {
  id         BigInt         @id @default(autoincrement())
  bikeId     String         @map("bike_id") @db.Uuid
  bike       Bike           @relation(fields: [bikeId], references: [id], onDelete: Cascade)
  rentalId   String?        @map("rental_id") @db.Uuid
  rental     Rental?        @relation(fields: [rentalId], references: [id])
  fixAt      DateTime       @map("fix_at") @db.Timestamptz
  receivedAt DateTime       @default(now()) @map("received_at") @db.Timestamptz
  lat        Float
  lon        Float
  speedKph   Float?         @map("speed_kph")
  hdop       Float?
  satellites Int?
  valid      Boolean
  source     LocationSource @default(GPS)

  @@unique([bikeId, fixAt])
  @@index([rentalId, fixAt])
  @@map("location_samples")
}

model IgnitionEvent {
  id         BigInt        @id @default(autoincrement())
  bikeId     String        @map("bike_id") @db.Uuid
  bike       Bike          @relation(fields: [bikeId], references: [id], onDelete: Cascade)
  rentalId   String?       @map("rental_id") @db.Uuid
  rental     Rental?       @relation(fields: [rentalId], references: [id])
  state      IgnitionState
  changedAt  DateTime      @map("changed_at") @db.Timestamptz
  receivedAt DateTime      @default(now()) @map("received_at") @db.Timestamptz

  @@unique([bikeId, changedAt])
  @@map("ignition_events")
}

model Incident {
  id                   String           @id @db.Uuid
  bikeId               String           @map("bike_id") @db.Uuid
  bike                 Bike             @relation(fields: [bikeId], references: [id])
  deviceId             String?          @map("device_id") @db.Uuid
  device               Device?          @relation(fields: [deviceId], references: [id])
  rentalId             String?          @map("rental_id") @db.Uuid
  rental               Rental?          @relation(fields: [rentalId], references: [id])
  driverId             String?          @map("driver_id") @db.Uuid
  driver               User?            @relation("IncidentDriver", fields: [driverId], references: [id])
  ownerId              String           @map("owner_id") @db.Uuid
  owner                User             @relation("IncidentOwner", fields: [ownerId], references: [id])
  type                 IncidentType
  category             IncidentCategory
  state                IncidentState
  severityScore        Int?             @map("severity_score")
  occurredAt           DateTime         @map("occurred_at") @db.Timestamptz
  receivedAt           DateTime         @default(now()) @map("received_at") @db.Timestamptz
  timeSource           String           @map("time_source")
  ignitionAtEvent      IgnitionState    @default(UNKNOWN) @map("ignition_at_event")
  preEventSpeedKph     Float?           @map("pre_event_speed_kph")
  locationKind         LocationKind     @map("location_kind")
  lat                  Float?
  lon                  Float?
  fixAt                DateTime?        @map("fix_at") @db.Timestamptz
  fixAgeSec            Int?             @map("fix_age_sec")
  locationSource       LocationSource?  @map("location_source")
  evidence             Json
  sensorWindow         Json?            @map("sensor_window")
  assignmentVersion    Int?             @map("assignment_version")
  ownerPhoneSnapshot   String?          @map("owner_phone_snapshot")
  driverNameSnapshot   String?          @map("driver_name_snapshot")
  contactNameSnapshot  String?          @map("contact_name_snapshot")
  contactPhoneSnapshot String?          @map("contact_phone_snapshot")
  serverQuestion       Boolean          @default(false) @map("server_question")
  questionSentAt       DateTime?        @map("question_sent_at") @db.Timestamptz
  responseDeadlineAt   DateTime?        @map("response_deadline_at") @db.Timestamptz
  decision             Decision         @default(NOT_APPLICABLE)
  decisionSource       DecisionSource?  @map("decision_source")
  decidedAt            DateTime?        @map("decided_at") @db.Timestamptz
  photoStatus          PhotoStatus      @default(NOT_REQUESTED) @map("photo_status")
  integrityHash        String?          @map("integrity_hash")
  ownerAckAt           DateTime?        @map("owner_ack_at") @db.Timestamptz
  ownerNote            String?          @map("owner_note")
  closedAt             DateTime?        @map("closed_at") @db.Timestamptz
  quarantined          Boolean          @default(false)
  quarantineReason     String?          @map("quarantine_reason")
  isDemo               Boolean          @default(false) @map("is_demo")
  createdAt            DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime         @updatedAt @map("updated_at") @db.Timestamptz

  image         IncidentImage?
  responses     DriverResponse[]
  notifications Notification[]

  @@index([ownerId, occurredAt])
  @@index([bikeId, occurredAt])
  @@index([state, responseDeadlineAt])
  @@index([driverId, occurredAt])
  @@map("incidents")
}

model IncidentImage {
  id             String     @id @default(uuid()) @db.Uuid
  incidentId     String     @unique @map("incident_id") @db.Uuid
  incident       Incident   @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  state          ImageState @default(RESERVED)
  expectedBytes  Int        @map("expected_bytes")
  receivedBytes  Int        @default(0) @map("received_bytes")
  chunkSize      Int        @map("chunk_size")
  sha256Expected String     @map("sha256_expected")
  sha256Actual   String?    @map("sha256_actual")
  storageKey     String?    @map("storage_key")
  mime           String     @default("image/jpeg")
  failureReason  String?    @map("failure_reason")
  createdAt      DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime   @updatedAt @map("updated_at") @db.Timestamptz
  completedAt    DateTime?  @map("completed_at") @db.Timestamptz

  @@map("incident_images")
}

model DriverResponse {
  id               String         @id @default(uuid()) @db.Uuid
  incidentId       String         @map("incident_id") @db.Uuid
  incident         Incident       @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  choice           ResponseChoice
  source           ResponseSource
  responderUserId  String?        @map("responder_user_id") @db.Uuid
  responder        User?          @relation(fields: [responderUserId], references: [id])
  idempotencyKey   String         @unique @map("idempotency_key")
  deviceTime       DateTime?      @map("device_time") @db.Timestamptz
  serverReceivedAt DateTime       @default(now()) @map("server_received_at") @db.Timestamptz
  accepted         Boolean
  rejectReason     String?        @map("reject_reason")
  syncedToDeviceAt DateTime?      @map("synced_to_device_at") @db.Timestamptz

  @@index([incidentId])
  @@map("driver_responses")
}

model Notification {
  id              String              @id @default(uuid()) @db.Uuid
  incidentId      String              @map("incident_id") @db.Uuid
  incident        Incident            @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  kind            NotificationKind
  state           NotificationState   @default(REQUESTED)
  recipientMasked String?             @map("recipient_masked")
  requestedAt     DateTime            @default(now()) @map("requested_at") @db.Timestamptz
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz

  attempts NotificationAttempt[]

  @@unique([incidentId, kind])
  @@map("notifications")
}

model NotificationAttempt {
  id             String            @id @default(uuid()) @db.Uuid
  notificationId String            @map("notification_id") @db.Uuid
  notification   Notification      @relation(fields: [notificationId], references: [id], onDelete: Cascade)
  attemptNo      Int               @map("attempt_no")
  state          NotificationState
  detail         String?
  deviceTime     DateTime?         @map("device_time") @db.Timestamptz
  createdAt      DateTime          @default(now()) @map("created_at") @db.Timestamptz

  @@unique([notificationId, attemptNo, state])
  @@map("notification_attempts")
}

model DeviceCommand {
  id            String        @id @default(uuid()) @db.Uuid
  deviceId      String        @map("device_id") @db.Uuid
  device        Device        @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  type          CommandType
  payload       Json
  incidentId    String?       @map("incident_id") @db.Uuid
  status        CommandStatus @default(QUEUED)
  result        Json?
  createdAt     DateTime      @default(now()) @map("created_at") @db.Timestamptz
  deliveredAt   DateTime?     @map("delivered_at") @db.Timestamptz
  ackedAt       DateTime?     @map("acked_at") @db.Timestamptz
  expiresAt     DateTime      @map("expires_at") @db.Timestamptz

  @@index([deviceId, status, createdAt])
  @@map("device_commands")
}

model DeviceNonce {
  deviceId  String   @map("device_id") @db.Uuid
  device    Device   @relation(fields: [deviceId], references: [id], onDelete: Cascade)
  nonce     String
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@id([deviceId, nonce])
  @@index([createdAt])
  @@map("device_nonces")
}

model PushToken {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token      String   @unique
  platform   String   @default("android")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  lastSeenAt DateTime @default(now()) @map("last_seen_at") @db.Timestamptz

  @@map("push_tokens")
}

model RefreshToken {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique @map("token_hash")
  expiresAt DateTime  @map("expires_at") @db.Timestamptz
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@map("refresh_tokens")
}

model PasswordReset {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  codeHash  String    @map("code_hash")
  attempts  Int       @default(0)
  expiresAt DateTime  @map("expires_at") @db.Timestamptz
  usedAt    DateTime? @map("used_at") @db.Timestamptz
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@map("password_resets")
}

model IdempotencyRecord {
  key        String   @id
  userId     String?  @map("user_id") @db.Uuid
  route      String
  statusCode Int      @map("status_code")
  response   Json
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@map("idempotency_records")
}

model AuditEvent {
  id         BigInt   @id @default(autoincrement())
  actorType  String   @map("actor_type")
  actorId    String?  @map("actor_id")
  action     String
  targetType String?  @map("target_type")
  targetId   String?  @map("target_id")
  meta       Json?
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([createdAt])
  @@map("audit_events")
}

model ShareLink {
  id         String    @id @default(uuid()) @db.Uuid
  incidentId String    @map("incident_id") @db.Uuid
  tokenHash  String    @unique @map("token_hash")
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@map("share_links")
}
```

#### 5.6.3 Raw SQL migration (constraints Prisma cannot express)

Create `apps/api/prisma/migrations/<timestamp>_invariants/migration.sql` after the initial migration:

```sql
-- One open rental per bike and per driver (FR-RENT-02)
CREATE UNIQUE INDEX rentals_one_open_per_bike
  ON rentals (bike_id) WHERE state IN ('PENDING_SYNC','ACTIVE','ENDING_SYNC');
CREATE UNIQUE INDEX rentals_one_open_per_driver
  ON rentals (driver_id) WHERE state IN ('PENDING_SYNC','ACTIVE','ENDING_SYNC');

-- One current emergency contact per driver
CREATE UNIQUE INDEX emergency_contacts_one_current
  ON emergency_contacts (driver_id) WHERE is_current = true;

-- Coordinate sanity
ALTER TABLE location_samples ADD CONSTRAINT chk_lat CHECK (lat BETWEEN -90 AND 90);
ALTER TABLE location_samples ADD CONSTRAINT chk_lon CHECK (lon BETWEEN -180 AND 180);

-- Decision consistency
ALTER TABLE incidents ADD CONSTRAINT chk_deadline
  CHECK (response_deadline_at IS NULL OR question_sent_at IS NOT NULL);

-- Fast deadline worker scan
CREATE INDEX incidents_pending_deadline
  ON incidents (response_deadline_at) WHERE decision = 'PENDING';
```

#### 5.6.4 Data relationships & rules

| Rule | Enforcement |
|---|---|
| An incident belongs to exactly one owner and bike; optionally a rental/driver | FKs; owner copied from bike at insert |
| Recipient phones on incidents/rentals never change after creation | Service layer never updates `*_snapshot`; test covers reassignment |
| One logical notification per `(incident, kind)` | `@@unique([incidentId, kind])` + upsert |
| Driver responses idempotent | `idempotency_key` unique |
| Location de-duplication | `@@unique([bikeId, fixAt])` + `createMany({ skipDuplicates: true })` |
| Assignment versions unique per bike | `@@unique([bikeId, assignmentVersion])`; next version = `max + 1` inside the assign transaction |
| Incident id = device eventId | Primary key; server-generated UUIDs only for `DEVICE_OFFLINE_DURING_RENTAL` and app `MANUAL_SOS` |

#### 5.6.5 Derived values

**Severity index (0–100)** — heuristic, displayed with the disclaimer:

```text
score = round( 35 * min(peakG / 4.0, 1)
             + 25 * min(peakDps / 300, 1)
             + 25 * min(preEventSpeedKph / 40, 1)     (0 if unknown)
             + 15 * (fallenDurationMs >= 10000 ? 1 : 0) )
label = score < 35 ? "LOW" : score <= 65 ? "MODERATE" : "HIGH"
MANUAL_SOS → label "SOS", score null
```

**Integrity hash** — `sha256` of the canonical JSON (sorted keys) of `{ id, bikeId, type, occurredAt, lat, lon, fixAt, evidence, sensorWindow, photoSha256 }`, recomputed when the photo completes; UI shows "Evidence integrity verified" when the stored hash matches a fresh recomputation.

**Trip distance** — on each valid fix (`valid`, HDOP ≤ 5, source GPS or DEMO in demo mode) for an ACTIVE rental: `d = haversine(last, current)`; add if `d ≥ 5 m` and `d / Δt ≤ 41.7 m/s` (150 km/h); update `last_distance_*`.

**Riding / parked time** — walk `ignition_events` in order; ON→OFF spans are riding, OFF→ON spans are parked; the open span runs to `now`.

**Online state** — `expected = ignition == ON ? telemetryOnSec : telemetryOffSec`; `age = now − lastSeenAt`; `ONLINE` if `age ≤ 2.5 × expected`, `STALE` if `≤ 5 × expected`, else `OFFLINE`.

#### 5.6.6 Storage strategy & retention

| Data | Store | Retention (configurable env) |
|---|---|---|
| Users, bikes, devices, rentals | Postgres | Until deleted |
| Incidents, responses, notifications | Postgres | 365 days |
| Location samples | Postgres | 30 days (`RETENTION_LOCATIONS_DAYS`) |
| Images | Docker volume `/data/images/yyyy/mm/<incidentId>.jpg`, temp uploads `/data/images/tmp/<sessionId>.part` | 90 days (`RETENTION_IMAGES_DAYS`); tmp parts 24 h |
| Device nonces | Postgres | 10 minutes |
| Audit events | Postgres | 180 days |
| Backups | `/opt/crashlink/backups` (nightly `pg_dump -Fc`, keep 7) | 7 days |

#### 5.6.7 Seed data (`npm run db:seed`)

| Entity | Values |
|---|---|
| Admin | `admin@crashlink.lk` / `ADMIN_SEED_PASSWORD` (env) |
| Demo owner | "Nimal Perera", `owner@demo.lk`, `+94770000001` (**replace with a team member's real number for the live demo**) |
| Demo driver | "Ravi Kumar", `ravi@demo.lk`, `+94770000002` |
| Emergency contact | "Kamala", `+94770000003`, "Mother" (**team member's phone for the demo**) |
| Guest | `judge@demo.lk`, role GUEST, read-only view of Nimal's data |
| Device | `CL-0001` (secret printed once to console + written to `firmware/main-esp32/include/secrets.h` template, **gitignored**); `CL-0002` for the simulator |
| Bikes | "Scooter 1" ↔ CL-0001 (real hardware), "Scooter 2" ↔ CL-0002 (simulator) |
| History | 14 days of synthetic rentals, locations around Colombo/Malabe, and ~20 INFO/SECURITY events + 3 closed EMERGENCY incidents, all `isDemo = true`, so analytics screens are not empty |

---
### 5.7 Security Design

#### 5.7.1 Authentication
| Actor | Mechanism |
|---|---|
| App users | bcrypt (cost 10) password hashes; JWT access token (HS256, `JWT_SECRET` ≥ 32 bytes, 1 h, claims `sub`, `role`, `isDemo`); opaque refresh token (32 random bytes, stored as SHA-256, 30 d, rotated, revocable); login throttling (§5.4.10). |
| Devices | Per-device 32-byte secret; HMAC-SHA256 request signatures (§5.3.2); timestamp window ± 300 s; nonce replay protection; secrets stored **encrypted** (AES-256-GCM with `DEVICE_SECRET_KEY` from env) because HMAC verification needs the raw secret. |
| Camera | Separate camera secret; HMAC on `eventId + nonce`; WPA2 AP password per device. |
| Signed file URLs | `sig = HMAC(FILE_URL_SECRET, key + exp)`, `exp` ≤ 5 min. |

#### 5.7.2 Authorization (RBAC + ownership)

| Resource | OWNER | DRIVER | ADMIN | GUEST | DEVICE |
|---|---|---|---|---|---|
| Own profile | RW | RW | RW | R | — |
| Bikes | RW own | — | R all | R demo | — |
| Device health/config | RW own bike | — | RW | R demo | own |
| Rentals | RW own bikes | R own | R | R demo | own snapshot |
| Emergency contact | Snapshot in own rentals/incidents | RW own | R | masked | own snapshot |
| Incidents | R + ack own | R own (no photo) + respond | R | R demo | create/update own |
| Images | R own (signed URL) | ✗ | R | ✗ (placeholder) | upload own |
| Analytics | Own fleet | — | All | Demo | — |
| Device provisioning | — | — | ✓ | — | — |

Every repository query is scoped (`where: { ownerId: user.id }` etc.); a shared `assertOwnsBike()` / `assertOwnsIncident()` helper returns **404** (not 403) for other owners' ids to avoid enumeration. Guest tokens are rejected by a global `preHandler` on all non-GET routes (`403 READ_ONLY_GUEST`).

#### 5.7.3 Data protection
- TLS 1.2+ for all app traffic (Let's Encrypt); HSTS on the app host.
- Phone numbers: stored in E.164; masked (`+94•••••4567`) in lists, logs, audit metadata and driver-facing views; full numbers only in owner incident/rental detail.
- Photos: never public; signed URLs; deleted after retention.
- Secrets only in `.env` on the VPS (`chmod 600`), `.env.example` in repo; firmware secrets in a gitignored `secrets.h` / NVS provisioning.
- Postgres bound to the Docker network (optionally `127.0.0.1`); strong password; nightly encrypted-at-rest backups optional (`gpg`).
- Consent notice recorded (`users.consent_at`); privacy text: location tracking during rentals, emergency SMS to the nominated contact, photo capture on incidents, retention periods.
- Audit events for: login, rental assign/end/force-activate, device provision/revoke, pairing, incident acknowledge, demo reset.

#### 5.7.4 Device security
| Threat | Control |
|---|---|
| Spoofed device messages | HMAC signature with per-device secret |
| Replay of a captured request | Timestamp window + nonce table |
| Eavesdropping on plain HTTP (A7) | **Residual risk**: assignment payloads contain phone numbers. Mitigations: HTTPS if the modem supports it (test first); optional AES-128-GCM encryption of `SET_ASSIGNMENT` payload with a key derived from the device secret (Nice-to-have); no user credentials ever travel on this path. |
| Stolen device / cloned secret | Admin revoke → all requests 401; re-provision new secret |
| Rogue client on the local camera AP | WPA2, one-client limit, HMAC-signed capture requests |
| Oversized/malformed payloads | Nginx `client_max_body_size 32k` on `/d/`; zod validation; per-item rejection; chunk ≤ 8 KB; image ≤ 200 KB |
| Flooding | Nginx `limit_req` + Fastify rate limit per device |
| Assignment confusion | `assignmentVersion` checks, quarantine, snapshots |
| Firmware tampering | Future: ESP32 secure boot + flash encryption, signed OTA |

### 5.8 Deployment Architecture & Contabo VPS Guide

#### 5.8.1 Target layout on the VPS

```text
/opt/crashlink/                 git clone of the monorepo
  .env                          production env (chmod 600)
  deploy/docker-compose.yml
  deploy/nginx/crashlink.conf
  deploy/deploy.sh  deploy/backup.sh
  backups/
Docker volumes: pgdata, images, kuma
```

#### 5.8.2 Step-by-step setup (≈ 60–90 minutes)

**1. DNS.** Create an A record `crashlink.<yourdomain>` → VPS IPv4 (optionally `status.<yourdomain>`). No domain? Register a free DuckDNS name (e.g. `iotrix-crashlink.duckdns.org`) and point it at the VPS IP.

**2. Base hardening (as root, then as the new user):**

```bash
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # if root has your key
timedatectl set-timezone UTC
apt update && apt -y upgrade
apt -y install ufw fail2ban unattended-upgrades git curl
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

**3. Docker Engine + Compose plugin:**

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy     # re-login afterwards
docker compose version
```

**4. Nginx + Certbot (on the host):**

```bash
apt -y install nginx certbot python3-certbot-nginx
mkdir -p /var/www/certbot
```

**5. Code + environment:**

```bash
sudo mkdir -p /opt/crashlink && sudo chown deploy:deploy /opt/crashlink
git clone <repo-url> /opt/crashlink && cd /opt/crashlink
cp .env.example .env && chmod 600 .env && nano .env    # fill values (Appendix B)
```

**6. `deploy/docker-compose.yml`:**

```yaml
name: crashlink
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 20

  api:
    build:
      context: ..
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    env_file: ../.env
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      IMAGE_DIR: /data/images
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - images:/data/images

  uptime-kuma:
    image: louislam/uptime-kuma:1
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - kuma:/app/data

  mosquitto:            # future scale phase only
    image: eclipse-mosquitto:2
    profiles: ["mqtt"]
    restart: unless-stopped
    ports:
      - "1883:1883"
    volumes:
      - ./mosquitto:/mosquitto/config

volumes:
  pgdata:
  images:
  kuma:
```

Run compose with `--env-file ../.env` from `deploy/` (or keep `.env` in `deploy/`) so `${POSTGRES_*}` interpolation works.

**7. `apps/api/Dockerfile`:**

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY . .
# .dockerignore must exclude: **/node_modules, apps/mobile/android, apps/mobile/.expo, firmware, .env*
RUN npm ci --workspace apps/api --workspace packages/contracts --include-workspace-root
RUN npm run build -w packages/contracts \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w apps/api

FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# `prisma` must be in apps/api "dependencies" (not devDependencies) for migrate deploy at start-up
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/server.js"]
```

**8. First start:**

```bash
cd /opt/crashlink/deploy
docker compose --env-file ../.env up -d --build
docker compose --env-file ../.env exec api npm run db:seed -w apps/api
docker compose --env-file ../.env exec api npm run device:provision -w apps/api -- --code CL-0001
curl -s http://127.0.0.1:3000/health
```

**9. Nginx config `deploy/nginx/crashlink.conf`** → symlink to `/etc/nginx/sites-enabled/`:

```nginx
limit_req_zone $binary_remote_addr zone=dev:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=app:10m rate=20r/s;

map $http_upgrade $connection_upgrade { default upgrade; '' close; }

# Port 80: device gateway (plain HTTP for SIM800L) + ACME; everything else → HTTPS
server {
    listen 80;
    server_name crashlink.example.com;

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    location /d/ {
        limit_req zone=dev burst=20 nodelay;
        client_max_body_size 32k;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name crashlink.example.com;
    # ssl_certificate lines are added by certbot

    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 1m;

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location /d/ {                      # also allow HTTPS for devices if the modem supports it
        limit_req zone=dev burst=20 nodelay;
        client_max_body_size 32k;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        limit_req zone=app burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /opt/crashlink/deploy/nginx/crashlink.conf /etc/nginx/sites-enabled/crashlink.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d crashlink.example.com --redirect --agree-tos -m you@example.com
# IMPORTANT: certbot may rewrite the port-80 server to redirect everything.
# Re-check that `location /d/` on port 80 still proxies (no redirect):
curl -i http://crashlink.example.com/d/v1/time
curl -i https://crashlink.example.com/health
```

Certificate renewal is automatic (`systemctl list-timers | grep certbot`).

**10. Monitoring.** Expose Uptime Kuma at `status.<domain>` (separate server block with `auth_basic`) or via SSH tunnel (`ssh -L 3001:127.0.0.1:3001 deploy@vps`). Monitors: HTTPS `/health` (keyword `"ok"`, 60 s), HTTP `/d/v1/time` (60 s), TCP 443; notification to a Telegram bot or email. Logs: `docker compose logs -f --tail=200 api`. Resource view: `docker stats`; optional Netdata.

**11. Backups (`deploy/backup.sh`, cron `0 2 * * *`):**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/crashlink/deploy
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file ../.env exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > ../backups/db-$TS.dump
ls -1t ../backups/db-*.dump | tail -n +8 | xargs -r rm --
```

**12. Updates (`deploy/deploy.sh`):**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/crashlink && git pull --ff-only
cd deploy && docker compose --env-file ../.env up -d --build api
sleep 5 && curl -fsS http://127.0.0.1:3000/health
```

**Freeze rule:** no deploys in the final 3 hours before the demo unless fixing a demo-blocking bug.

#### 5.8.3 Android APK build

Option A — local (free, no queue):

```bash
cd apps/mobile
npx expo install --check
EXPO_PUBLIC_API_URL=https://crashlink.example.com npx expo prebuild -p android --clean
cd android && ./gradlew assembleRelease
# APK: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Requirements: JDK 17, Android SDK (Android Studio), `ANDROID_HOME` set, `google-services.json` in `apps/mobile/` if FCM is enabled. The default template signs release builds with the debug keystore — acceptable for sideloading; create a real keystore for anything beyond the competition.

Option B — EAS Build free tier: `eas.json` profile `preview` with `"android": { "buildType": "apk" }` → `eas build -p android --profile preview`. Queue times vary; use as backup.

Install: `adb install -r app-release.apk` or share the file; enable "Install unknown apps". **Build the first APK on Day 1** to surface native issues early.

#### 5.8.4 CI/CD recommendations

| Pipeline | Trigger | Steps |
|---|---|---|
| `ci.yml` (GitHub Actions) | Push / PR | `npm ci` → typecheck → lint → `vitest` with a Postgres 16 service container → build API |
| `deploy.yml` | Push tag `v*` (or manual `workflow_dispatch`) | SSH into VPS (`appleboy/ssh-action`, key in repo secrets) → `deploy/deploy.sh` |
| `apk.yml` (optional) | Manual | Setup JDK 17 + Node → `expo prebuild` → `./gradlew assembleRelease` → upload APK artifact |

For the competition, manual `deploy.sh` is acceptable; add CI after the event.

### 5.9 MVP Scope for Competition

#### Must Have (demo fails without these)
1. Backend: auth (register/login/refresh), roles, ownership scoping, seed + CLI device provisioning.
2. Bikes, pairing (manual code), device health, online state.
3. Rentals: assign (with snapshots), device ack → ACTIVE, end; one-open-rental invariants; demo force-activate.
4. Device gateway: `/time`, heartbeat (fixes, ignition, events, health), commands + ack, incident upsert, control poll, local response, notification reporting, image session/chunks/complete — all HMAC-signed.
5. Decision engine + deadline worker (single winner, exactly-once contact SMS request).
6. Socket.IO realtime; driver pending-question polling fallback.
7. **Device simulator CLI** with scenarios: `collision-safe`, `collision-timeout`, `collision-help`, `offline-fallback`, `pothole`, `parked-fall`, `towing`.
8. App — Owner: login, dashboard (KPIs, bike list, emergency banner), bike detail (health, map, ignition, rental), assign/end rental, incident list, incident detail (photo, map, freshness, timeline, evidence, response, call buttons).
9. App — Driver: login/register, emergency contact, active rental, **full-screen "Are you safe?"** with server-time countdown and honest sync states.
10. Freshness badges (`LIVE / LAST KNOWN / UNAVAILABLE / DEMO`); "Possible …" labels.
11. **Call 1990 / 119** buttons (RW1).
12. Deployed on Contabo with HTTPS; APK installed on two phones.
13. Firmware (hardware team): 10 s fall → owner SMS → incident PUT → control poll → contact SMS on TIMEOUT/HELP; Safe/SOS buttons; heartbeat. Photo upload is Must-*attempt*, with honest failure display.

#### Nice to Have (only after Must is demo-proven end-to-end)
FCM push; severity index; integrity hash; dead-man detector; black-box chart; analytics charts; pothole map; guest/judge mode; trilingual emergency strings; QR pairing; incident acknowledge notes; auto-call contact; tokenised contact status page; PDF report; password reset by email; device config editing UI; `DEMO_TRIGGER` from app; admin screens.

#### Future Enhancements
MQTT ingestion (Mosquitto) and LTE Cat-1 modem; HTTPS/TLS on device or encrypted payloads; phone OTP verification and emergency-contact confirmation; server-side SMS gateway fallback; OTA firmware updates with signing; secure boot/flash encryption; TinyML incident classifier trained on logged windows; real ignition-line isolation circuit and bike-battery charging; geofencing; insurance/police evidence API; multi-operator admin portal; iOS; Play Store release; Redis adapter + horizontal API scaling; managed Postgres; road-authority pothole data export.

---
## Phase 6 — Implementation Roadmap (Claude Code)

### 6.0 Team lanes and hour-zero de-risking

Four people, two lanes, one shared contract (§5.3/§5.4). Names are not assigned here — map them yourselves.

| Lane | Person | Focus |
|---|---|---|
| HW-1 | Firmware — sensing | MPU calibration, 10 s fall FSM, classification, buttons, LEDs/buzzer, GPS |
| HW-2 | Firmware — comms | SIM800L AT queue (SMS + GPRS HTTP + HMAC), ESP32-CAM AP link, image upload |
| SW-1 | Backend + VPS | API, DB, workers, simulator, deployment |
| SW-2 | Mobile | Expo app, APK builds, demo phones |

**Hour 0 — revised after M2/M3.** The GPRS smoke test that used to sit here is **already passed**: the team has a JPEG travelling camera → Wi-Fi → ESP32 → SIM800L → HTTP POST → server. That was the single biggest schedule risk and it is gone. What remains at hour zero:

1. **Point the same proven upload at your own server.** Change `UPLOAD_URL` from the webhook.site inbox to `http://<vps-ip>/d/v1/ping` and run `python3 -m http.server 80` on the VPS. Confirm the POST arrives from a Sri Lankan mobile IP. This proves routing, firewall and the port-80 device path in ten minutes (O4).
2. **Add `AT+HTTPREAD` to the proven sketch** and print the response body. Everything in §5.3.4 (command piggybacking) depends on it (O3).
3. **Get a DNS name** — DuckDNS, two minutes — and point it at the VPS (O1). Without it there is no HTTPS for the app.
4. **Measure the buzzer current** on GPIO13 (O2). One multimeter reading.
5. Create the monorepo from Appendix C, add this spec as `docs/CRASHLINK_SPEC.md`, add `CLAUDE.md` (Appendix A).
6. Update the slides (§0.1 C1, C4–C11, Appendix F) — 30 minutes, any team member. C2 and C3 are closed.

### 6.1 Timeline

Times are relative (H+0 = start of work). Adjust the start date/time to when you begin.

```mermaid
gantt
  title CrashLink 2-day build (relative hours)
  dateFormat YYYY-MM-DD HH:mm
  axisFormat %d %H:%M
  section Software
  S0 Hour-zero de-risk            :s0, 2026-09-20 18:00, 1h
  S1 Backend foundation            :s1, after s0, 6h
  S2 Device integration + sim      :s2, after s1, 6h
  S3 Mobile app                    :s3, 2026-09-20 19:00, 12h
  S4 Dashboard and analytics       :s4, after s2, 5h
  S5 Test, harden, demo prep       :s5, after s4, 8h
  section Firmware
  Sensing FSM + buttons            :h1, 2026-09-20 19:00, 8h
  SMS + GPRS + HMAC client         :h2, 2026-09-20 19:00, 10h
  Camera link + upload             :h3, after h2, 6h
  Integrated device vs VPS         :h4, after h3, 6h
  section Freeze
  Code freeze and rehearsals       :crit, f1, after s5, 3h
```

### Sprint 1 — Backend Foundation (SW-1, ~6 h)

**Goal:** a deployed API with auth, bikes, devices, rentals and the full database.

| # | Task | Spec refs |
|---|---|---|
| 1.1 | Monorepo (npm workspaces): `apps/api`, `apps/mobile`, `packages/contracts`, `tools/device-sim`, `deploy` | Appendix C |
| 1.2 | `packages/contracts`: zod schemas + enums + DTO types for every payload in §5.3–§5.5 | §5.3, §5.4 |
| 1.3 | Prisma schema + raw SQL invariants migration + seed | §5.6.2–§5.6.7 |
| 1.4 | Fastify app: config (zod env), error handler, request ids, helmet, CORS, rate limits, `/health` | §4.3, §5.4.1 |
| 1.5 | Auth module: register, login, refresh rotation, logout, `/me`, settings, push-token endpoints, guest-read-only guard | §5.4.2, §5.7 |
| 1.6 | Bikes + pairing + driver lookup + emergency contact | §5.4.3–§5.4.4 |
| 1.7 | Rentals: assign (transaction: invariants, snapshot, `assignmentVersion = max+1`, `SET_ASSIGNMENT` command), cancel, end, force-activate (demo) | §5.4.5, §4.5.3 |
| 1.8 | Admin: device provisioning service + CLI `device:provision` (AES-GCM-encrypted secret) | §5.4.8 |
| 1.9 | Dockerfile, compose, nginx, deploy to VPS with TLS | §5.8 |

**Claude Code prompt (Sprint 1):**

```text
Read docs/CRASHLINK_SPEC.md sections 4.3, 5.4.1-5.4.5, 5.4.8, 5.6, 5.7, 5.8 and Appendix C.
Scaffold the npm-workspaces monorepo exactly as Appendix C describes.
Implement packages/contracts (zod schemas + TS types for all enums and DTOs in 5.3-5.5),
then apps/api with Fastify + TypeScript strict + Prisma 6 using the schema in 5.6.2 verbatim,
plus the raw SQL migration in 5.6.3 and the seed in 5.6.7.
Implement modules: auth, users, drivers (emergency contact, lookup), bikes (CRUD, pairing),
rentals (assign/cancel/end/force-activate with the invariants and snapshots described), admin
device provisioning service + CLI script "device:provision".
Every query must be ownership-scoped (return 404 for others' ids). Guest role is read-only.
Write Vitest tests for: register/login/refresh rotation; one-open-rental-per-bike and per-driver
(DB-level, concurrent requests); assign requires emergency contact; snapshots unchanged after the
driver edits their contact; cross-owner access returns 404.
Add Dockerfile, deploy/docker-compose.yml, deploy/nginx/crashlink.conf, deploy/deploy.sh,
deploy/backup.sh and .env.example from sections 5.8 and Appendix B. Do not invent endpoints
not in the spec; if something is ambiguous, add a TODO(spec) comment and choose the safest option.
```

**Acceptance:** `npm test` green; `https://<host>/health` OK on the VPS; seeded owner can log in via curl; assigning Ravi twice fails with `409 DRIVER_BUSY`.

### Sprint 2 — Device Integration (SW-1 with HW-2, ~6 h)

**Goal:** the complete device gateway, decision engine, workers, realtime, and a simulator that exercises all of it.

| # | Task | Spec refs |
|---|---|---|
| 2.1 | `deviceAuth` plugin: HMAC canonical string, timestamp window, nonce table, revoked check | §5.3.2 |
| 2.2 | `/d/v1/time`, `/heartbeat` (fixes → location samples + distance; ignition events; INFO events; health → device + bike; online state), command piggyback + ack | §5.3.3–§5.3.4, §5.6.5 |
| 2.3 | Incident upsert with rental resolution, quarantine, severity, snapshots, question creation | §5.3.5 |
| 2.4 | Decision engine (row lock) + `/control` + control ack + `/local-response` + app `/incidents/:id/responses` + `question-ack` | §5.3.6, §5.4.3 |
| 2.5 | Workers: deadline (1 s), dead-man (15 s), command expiry, nonce/tmp cleanup | §4.3, FR-INC-10 |
| 2.6 | Notification reporting + logical/attempt model | §5.3.7 |
| 2.7 | Image session/chunks/complete, SHA-256, storage, signed URL route | §4.4.3, §5.4.6 |
| 2.8 | Socket.IO rooms + events; optional FCM sender (no-op without credentials) | §5.5 |
| 2.9 | `tools/device-sim` CLI: signs requests like firmware; scenarios; `--image demo.jpg` | FR-DEMO-02 |
| 2.10 | Firmware HTTP client (HW-2) implements the same canonical string; verify against `/d/v1/heartbeat` using the simulator's test vector | §5.3.2 |

**Claude Code prompt (Sprint 2):**

```text
Implement docs/CRASHLINK_SPEC.md sections 5.3 (entire device protocol), 5.4.3 responses/question-ack,
5.4.6 images, 5.5 realtime, and the workers listed in 4.3.
Put all device business logic in a DeviceIngestService (transport-agnostic) called by thin HTTP routes
under /d/v1, so an MQTT subscriber can reuse it later.
The decision engine must use a single Prisma interactive transaction with SELECT ... FOR UPDATE on the
incident row and follow rules D1-D10 exactly. HELP/TIMEOUT create the CONTACT_SMS notification in the
same transaction (unique per incident).
Tests with a controllable clock: SAFE at 30 s wins; HELP immediate; timeout creates exactly one
CONTACT_SMS even with 20 concurrent control polls and a concurrent late SAFE; late SAFE is stored
accepted=false reason TOO_LATE; duplicate PUT incident is idempotent; assignmentVersion mismatch is
quarantined with serverQuestion=false; offline-fallback reconciliation does not duplicate CONTACT_SMS;
bad signature / stale timestamp / replayed nonce are rejected; image with wrong sha256 fails.
Then build tools/device-sim: a Node CLI that loads a device code+secret, signs requests per 5.3.2,
prints a test vector (canonical string + expected signature) for firmware developers, and runs scenarios:
heartbeat-loop, collision-safe, collision-timeout, collision-help, offline-fallback, pothole, parked-fall,
towing, dead-man. It must follow the device state machine in 4.5.1 including 3 s control polling and
uploading ./fixtures/demo.jpg in 2 KB chunks.
```

**Acceptance:** `device-sim collision-timeout` against the VPS produces, within ~65 s, an incident that goes `AWAITING_RESPONSE → ESCALATED (TIMEOUT)`, one CONTACT_SMS logical notification, photo AVAILABLE; firmware signature matches the simulator's test vector.

### Sprint 3 — Mobile Application (SW-2, ~12 h, starts in parallel with Sprint 1 against mocked data, switches to the real API when Sprint 1 deploys)

| # | Task | Spec refs |
|---|---|---|
| 3.1 | Expo + TS + Expo Router + Paper + TanStack Query + Zustand scaffold; API client with refresh-once | §4.2 |
| 3.2 | Auth screens (welcome, login, register with role & consent, guest button) | §2.3.1 |
| 3.3 | Role-based layouts: owner tabs, driver tabs, admin minimal | §2.2 |
| 3.4 | Socket provider (+ query invalidation), polling fallbacks, clock offset | §2.3.3, §5.5 |
| 3.5 | Owner: bikes list, add + pair, bike detail (health card, Leaflet map, ignition, rental), assign/end with sync states | §2.3.2, §2.4 |
| 3.6 | Owner: incidents list + detail (photo via signed URL, map, freshness, timeline, evidence, responses, call buttons incl. 1990/119) | §2.3.6 |
| 3.7 | Driver: home (active rental), emergency contact form, history | §2.3.6 |
| 3.8 | **Emergency screen** with alarm, vibration, countdown, idempotent responses, sync states, HELP follow-up | §2.4 |
| 3.9 | Notifications: channels, FCM token registration, tap routing (behind a feature flag) | §2.3.4 |
| 3.10 | First APK build on Day 1; install on both demo phones | §5.8.3 |

**Claude Code prompt (Sprint 3):**

```text
Build apps/mobile per docs/CRASHLINK_SPEC.md Phase 2 (sections 2.1-2.4) and 4.2, consuming the API in
5.4 and realtime events in 5.5, importing types/schemas from packages/contracts.
Stack: Expo (latest stable SDK) + TypeScript + Expo Router + React Native Paper + TanStack Query +
Zustand + expo-secure-store + socket.io-client + react-native-webview (Leaflet map component using OSM
tiles with attribution) + react-native-gifted-charts + expo-notifications + expo-audio + i18next (en first,
si/ta keys for emergency strings).
Implement the folder structure in 4.2 exactly. Role-based routing: OWNER/GUEST -> (owner), DRIVER ->
(driver), ADMIN -> (admin). GUEST hides all mutation buttons.
The emergency screen (2.4) is the highest priority: it must open automatically from socket event
incident.question, from polling GET /drivers/me/pending-question every 5 s while a rental is active, and from
a notification tap; countdown uses server time offset; SAFE/HELP use idempotency keys with retry; show
states Sending / Accepted by server - syncing to bike / Synced with bike / Too late / Cannot reach server.
Every location must render a FreshnessBadge (LIVE / LAST KNOWN - n min / UNAVAILABLE / DEMO).
Every incident label must start with "Possible" exactly as returned by the API. Never display
"delivered" unless the state is NETWORK_CONFIRMED or CLIENT_RECEIVED.
Add CallButtons (driver, contact, 1990, 119) using Linking tel:.
Configure app.config.ts with name CrashLink, package lk.iotrix.crashlink, EXPO_PUBLIC_API_URL,
Android notification channels emergency/security/info. Provide README steps for a local release APK build.
```

**Acceptance:** On two phones: owner assigns Ravi → "Active ✓"; simulator `collision-safe` → driver phone shows the emergency screen within 3 s; tapping SAFE shows "Synced with bike" after the simulator's next poll; owner incident detail shows the full timeline and photo.

### Sprint 4 — Dashboard & Analytics (SW-1 + SW-2, ~5 h)

| # | Task | Refs |
|---|---|---|
| 4.1 | `/owners/me/dashboard` + app dashboard (emergency banner, KPIs, fleet map, list, feed) | §2.3.6, §5.4.7 |
| 4.2 | Analytics endpoints + Insights screen (by type, timeseries, distance per bike) | §2.3.5 |
| 4.3 | Severity index + integrity hash + UI chips | §5.6.5 |
| 4.4 | Black-box chart on incident detail | IN1 |
| 4.5 | Pothole map; riding vs parked time | SU3, FR-RENT-06 |
| 4.6 | Device health card polish; config screen (read-only locked fields) | §2.3.2 |
| 4.7 | Trilingual emergency strings | RW6 |

**Claude Code prompt (Sprint 4):**

```text
Implement docs/CRASHLINK_SPEC.md 5.4.7 analytics + dashboard endpoints and the owner dashboard/Insights
screens in 2.3.5-2.3.6. Add the severity index and integrity hash from 5.6.5 to incident creation and image
completion, with tests. Add BlackBoxChart (sensorWindow a/g/tilt/spd on a shared time axis) to incident
detail, the pothole map (Leaflet markers) and riding/parked time on bike detail. Keep every chart readable
on a 6-inch phone; empty states must explain what data will appear. Do not add new endpoints beyond 5.4.7.
```

### Sprint 5 — Final Testing & Demo Preparation (all, ~8 h + 3 h freeze)

| # | Task |
|---|---|
| 5.1 | Run the full test matrix (§7.2) on the real device and with the simulator; log results in `docs/test-evidence.md` with timestamps and screenshots |
| 5.2 | Calibrate thresholds on the model bike; record values in firmware config and in the slides |
| 5.3 | Demo reset → re-seed → rehearse the runbook (§7.1) at least 3 times, timed |
| 5.4 | Measure and record: owner SMS latency, incident → app latency, JPEG bytes, upload time over GPRS |
| 5.5 | Prepare fallbacks: simulator on laptop, pre-recorded 60–90 s video of a successful end-to-end run, screenshots |
| 5.6 | Freeze: tag `v1.0-demo`, back up DB, verify certificate expiry > 7 days, charge LiPo, top up SIM credit |
| 5.7 | Update slides with real screenshots, architecture diagram (§4.1), measured numbers, roadmap slide |

**Claude Code prompt (Sprint 5):**

```text
Review the repository against docs/CRASHLINK_SPEC.md sections 5.2 (all Must requirements), 5.3.6 (D1-D10)
and 5.7. Produce docs/compliance-checklist.md listing each Must requirement with PASS/FAIL and evidence
(test name or manual step). Fix every FAIL that is not hardware-dependent. Add an npm script
"demo:reset" (seed demo data, clear demo incidents) and "demo:check" (health, DB, workers lag, devices
online, pending commands, cert expiry) that prints a green/red pre-demo checklist.
```

---

## Phase 7 — Demo Runbook, Test Matrix & Judge Q&A

### 7.1 Live demo runbook (target 6–8 minutes)

**Setup (before judges arrive):** VPS `demo:check` green · two Android phones on mobile data, CrashLink installed, notifications allowed, battery saver OFF · owner phone logged in as Nimal, driver phone as Ravi · laptop running `scrcpy` mirroring the owner phone to the projector · device powered, green LED, heartbeat visible in app · simulator terminal ready · backup video on desktop.

| Step | Action | What judges see | Say |
|---|---|---|---|
| 1 | Owner opens bike "Scooter 1" | Health card: GSM bars, GPS state (`DEMO` or `LAST KNOWN` if indoors), camera link | "The device reports its own health — we never pretend data is live." |
| 2 | Owner assigns Ravi | "Waiting for bike…" → "Active ✓ acknowledged" | "The bike stores this rental's emergency contact locally, so it can alert even without internet." |
| 3 | Press ignition button | Ignition ON in app | "In the prototype a button represents the ignition." |
| 4 | Tap model bike (pothole) | INFO event appears, no alarm | "Short jolt, bike upright → pothole, not an emergency. Fewer false alarms." |
| 5 | Lay bike down < 10 s, lift | Red LED blink, nothing sent | "Recovered before 10 seconds → no incident." |
| 6 | Lay bike down ≥ 10 s | Buzzer; owner phone gets SMS; owner app emergency banner; driver phone full-screen "Are you safe?" with 60 s countdown | "Owner SMS goes first, straight from the bike's SIM." |
| 7a | *Path A:* wait for timeout | Countdown hits 0 → emergency contact phone receives SMS with Maps link; timeline shows every step | "Rider unresponsive → family is alerted with the location." |
| 7b | *Path B (second run):* Ravi taps I'M SAFE | "Accepted · syncing to bike" → "Synced ✓"; no contact SMS | "Two-way sync: the bike itself knows the rider is safe." |
| 8 | Owner opens incident | Photo (or honest "uploading 60 %"), map, severity, black-box chart, timeline, 1990 button | "Evidence the owner can trust — with an integrity hash." |
| 9 | Pull the SIM antenna / show offline scenario via simulator | Offline fallback story | "No internet? The bike escalates by SMS by itself." |
| 10 | Insights + pothole map | Charts | "Every bike becomes a road sensor." |

**If GPRS fails live:** keep the SMS path on the real device (it does not need GPRS) and run the same scenario with `device-sim` on the laptop for the app part; say so openly.

### 7.2 Test matrix (evidence required)

| # | Scenario | Expected |
|---|---|---|
| T1 | Pothole jolt, bike returns upright | INFO `POSSIBLE_POTHOLE`, no SMS, no question |
| T2 | Tilt recovered at 9 s | No incident |
| T3 | Persistent fall 10 s, ignition ON | One EMERGENCY incident, owner SMS `AT_SUBMITTED`, question with deadline = sent + 60 s |
| T4 | Same as T3 with ignition OFF | `PARKED_BIKE_FALL`, owner SMS, no question |
| T5 | App SAFE at ~30 s | Decision SAFE, device ack, no contact SMS |
| T6 | Bike Safe button | Decision SAFE (DEVICE_BUTTON), reported, no contact SMS |
| T7 | App HELP | Immediate contact SMS |
| T8 | SOS button | MANUAL_SOS, immediate contact SMS |
| T9 | No response | TIMEOUT at 60 s, exactly one contact SMS |
| T10 | Late SAFE after TIMEOUT | Stored `accepted=false`, UI "Safe received after emergency SMS submission" |
| T11 | GPRS down during incident | Owner SMS still sent; OFFLINE_FALLBACK contact SMS after 60 s; reconciled on reconnect, no duplicate |
| T12 | Camera unavailable | Incident + SMS unaffected; photo FAILED shown |
| T13 | No GPS fix ever / stale fix | SMS says "Location unavailable" / "LAST KNOWN hh:mm" |
| T14 | Device reboot during countdown | Resumes pending incident from NVS; no duplicate incident |
| T15 | Duplicate incident PUT ×3 | One incident |
| T16 | Reassign bike to a second driver, trigger incident | Uses second driver's contact only |
| T17 | Bad signature / replayed nonce | 401 |
| T18 | Device silent 90 s during rental | `DEVICE_OFFLINE_DURING_RENTAL`, auto-closes on return |
| T19 | Guest login tries a mutation | 403 READ_ONLY_GUEST |
| T20 | Notifications denied on driver phone | Emergency screen still appears via socket/polling; warning card shown |

### 7.3 Likely judge questions — prepared answers

| Question | Answer |
|---|---|
| What if there is no internet? | SMS needs only GSM, not data. The bike holds the rental's recipients and escalates on its own after 60 s (offline fallback). |
| What if the device is destroyed in the crash? | The owner already has the SMS if it was sent; if the device goes silent mid-rental the server raises a "device offline during rental" alert. A server SMS gateway is on the roadmap. |
| How do you avoid false alarms? | Persistence (10 s), context (ignition, pre-event speed), impact + rotation, recovery hysteresis, and a human confirmation step before the family is alerted. |
| Why 10 s and 60 s? | 10 s filters drops that the rider immediately recovers from; 60 s gives an injured-but-conscious rider time to respond. Both are configurable per deployment but locked by default. |
| Is it an emergency service? | No. It is an alerting and evidence system; labels are "possible", and we show 1990/119 one-tap. |
| Privacy? | Consent at sign-up; location only for bikes; photos visible only to the owner; signed URLs; retention limits. |
| Security of the device? | Per-device keys, signed and replay-protected requests, revocation; TLS on the device is on the roadmap because 2G modems have limited TLS support. |
| 2G is being shut down — is this obsolete? | The device API is transport-agnostic; the same AT-command architecture moves to LTE Cat-1 modules. |
| Cost / scale? | Open-source stack on one VPS; ~0.1 requests/s per bike; hundreds of bikes per small server; MQTT and horizontal scaling planned. |
| What is novel? | Context-aware classification, dual alert/response channels, truthful delivery timeline, evidence integrity, pothole crowd-map. |

---
## Appendices

### Appendix A — `CLAUDE.md` (repository root)

```markdown
# CrashLink — instructions for Claude Code

Authoritative spec: docs/CRASHLINK_SPEC.md. Read the sections named in each task before coding.

## Pinned decisions (do not change without the team)
- Fall confirmation 10 s; rider response window 60 s from questionSentAt (server time).
- SMS is sent ONLY by the bike (SIM800L). The backend never sends SMS.
- Device transport: HTTP + HMAC under /d/v1; app API under /api/v1 over HTTPS.
- Device auth is QUERY-STRING based (?dev=&ts=&nonce=&sig=), NOT headers. Canonical string and
  reasoning in spec Appendix E.1.2 - that appendix overrides 5.3.2 where they differ.
- GPRS transport, camera transfer and image upload are ALREADY PROVEN on hardware (spec 0.2 M2/M3
  and Appendix E.1). Do not design SMS-only fallbacks as the primary path.
- No FCM in the MVP (M7). Realtime = Socket.IO while the app is open; SMS from the bike otherwise.
- Battery percent is never measured (M10) - always null, display "Not measured".
- No password reset in the MVP (M11). Admin creates accounts; seeds provide demo logins.
- Backend: Node 20, Fastify, TypeScript strict, Prisma 6.x (NOT 7), PostgreSQL 16, Socket.IO.
- Mobile: Expo React Native + TypeScript + Expo Router + React Native Paper + TanStack Query + Zustand.
- Shared zod schemas/types live in packages/contracts; never duplicate enums.
- Incident id == device eventId. Decisions use a row-locked transaction (rules D1-D10).
- Honest UI: labels start with "Possible"; never claim delivery/liveness the data does not prove.

## Conventions
- UTC everywhere in storage; display Asia/Colombo.
- Errors: { code, message, requestId, details }. Codes from spec 5.4.1 only.
- Every owner/driver query is ownership-scoped; foreign ids return 404.
- Mask phone numbers in logs (+94•••••4567).
- Tests: Vitest; use a fake clock for deadlines; run `npm test` before finishing a task.
- If the spec is ambiguous: choose the safest behaviour, add `// TODO(spec): ...`, and list it in your summary.

## Commands
npm run dev -w apps/api | npm test -w apps/api | npm run db:migrate -w apps/api | npm run db:seed -w apps/api
npm run device:provision -w apps/api -- --code CL-0001
npm run sim -w tools/device-sim -- collision-timeout --device CL-0002
npm run start -w apps/mobile
```

### Appendix B — `.env.example`

```dotenv
# --- Core ---
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=https://crashlink.example.com
DEVICE_BASE_URL=http://crashlink.example.com
TZ_DISPLAY=Asia/Colombo

# --- Database (compose builds DATABASE_URL from these) ---
POSTGRES_DB=crashlink
POSTGRES_USER=crashlink
POSTGRES_PASSWORD=change-me-long-random
DATABASE_URL=postgresql://crashlink:change-me-long-random@db:5432/crashlink

# --- Secrets (generate: openssl rand -hex 32) ---
JWT_SECRET=
DEVICE_SECRET_KEY=          # 32-byte hex, AES-256-GCM key for device secrets at rest
FILE_URL_SECRET=
ADMIN_SEED_PASSWORD=

# --- Tokens ---
ACCESS_TOKEN_TTL_SEC=3600
REFRESH_TOKEN_TTL_DAYS=30

# --- Incident policy (locked defaults) ---
FALL_CONFIRM_SEC=10
RESPONSE_WINDOW_SEC=60
DEADLINE_GRACE_SEC=15
DEADMAN_ON_SEC=90
DEADMAN_OFF_SEC=300

# --- Images ---
IMAGE_DIR=/data/images
IMAGE_MAX_BYTES=204800
IMAGE_CHUNK_MAX_BYTES=8192
SIGNED_URL_TTL_SEC=300

# --- Retention (days) ---
RETENTION_LOCATIONS_DAYS=30
RETENTION_IMAGES_DAYS=90
RETENTION_AUDIT_DAYS=180

# --- Demo ---
DEMO_MODE=true
GUEST_ENABLED=true

# --- Optional integrations (leave empty to disable) ---
FCM_SERVICE_ACCOUNT_JSON=   # base64 of the Firebase service-account JSON
SMTP_URL=                   # smtp://user:pass@host:587
MAIL_FROM="CrashLink <no-reply@example.com>"

# --- Mobile (apps/mobile/.env) ---
EXPO_PUBLIC_API_URL=https://crashlink.example.com
```

### Appendix C — Repository layout & root scripts

```text
crashlink/
  CLAUDE.md
  package.json                 # npm workspaces
  .env.example  .dockerignore  .gitignore
  docs/CRASHLINK_SPEC.md  docs/test-evidence.md  docs/compliance-checklist.md
  packages/contracts/          # zod schemas, enums, DTO types (built to dist/)
  apps/api/                    # Fastify API (§4.3), prisma/, test/, Dockerfile
  apps/mobile/                 # Expo app (§4.2)
  tools/device-sim/            # HMAC-signing simulator CLI + fixtures/demo.jpg
  firmware/main-esp32/         # PlatformIO project (Appendix E)
  firmware/esp32-cam/          # PlatformIO project
  deploy/                      # docker-compose.yml, nginx/, deploy.sh, backup.sh, mosquitto/ (future)
  .github/workflows/ci.yml  deploy.yml  apk.yml
```

Root `package.json`:

```json
{
  "name": "crashlink",
  "private": true,
  "workspaces": ["packages/*", "apps/*", "tools/*"],
  "scripts": {
    "build": "npm run build -w packages/contracts && npm run build -w apps/api",
    "test": "npm test -w apps/api",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "demo:reset": "npm run demo:reset -w apps/api",
    "demo:check": "npm run demo:check -w apps/api"
  }
}
```

`apps/api/package.json` scripts: `dev` (tsx watch), `build` (tsc), `start`, `test` (vitest run), `db:migrate` (prisma migrate dev), `db:deploy`, `db:seed` (tsx prisma/seed.ts), `device:provision` (tsx src/cli/provision.ts), `demo:reset`, `demo:check`.

> Monorepo + Expo note: recent Expo SDKs resolve npm workspaces automatically. If Metro fails to resolve `packages/contracts`, add it to `watchFolders` in `metro.config.js` or, as a last resort, copy the built `dist` types into `apps/mobile/src/contracts`.

### Appendix D — Display labels and emergency strings

| Enum | English label |
|---|---|
| `POSSIBLE_COLLISION` | Possible collision |
| `POSSIBLE_LOW_SPEED_RIDER_DROP` | Possible low-speed rider drop |
| `POSSIBLE_ROLLOVER` | Possible rollover |
| `MANUAL_SOS` | SOS pressed by rider |
| `PARKED_BIKE_FALL` | Parked bike fell over |
| `POSSIBLE_TOWING` | Possible towing / unauthorised movement |
| `POSSIBLE_TAMPERING` | Possible device tampering |
| `DEVICE_OFFLINE_DURING_RENTAL` | Device stopped reporting during rental |
| `POSSIBLE_POTHOLE` | Possible pothole / speed bump |
| `POSSIBLE_DANGEROUS_CORNERING` | Possible dangerous cornering |

Emergency screen strings (**have a native speaker verify before the demo**):

| Key | English | සිංහල | தமிழ் |
|---|---|---|---|
| `emergency.title` | Are you safe? | ඔබ ආරක්ෂිතද? | நீங்கள் பாதுகாப்பாக இருக்கிறீர்களா? |
| `emergency.safe` | I'm safe | මම ආරක්ෂිතයි | நான் பாதுகாப்பாக இருக்கிறேன் |
| `emergency.help` | Need help | උදව් අවශ්‍යයි | உதவி தேவை |
| `emergency.call1990` | Call ambulance 1990 | ගිලන්රථ 1990 අමතන්න | ஆம்புலன்ஸ் 1990 அழைக்கவும் |

### Appendix E — Firmware integration notes (main ESP32)

> Read **Appendix E.1** together with this one. E.1 records what the team has already proven on hardware and overrides §5.3 where they differ.

**Pin constants — CONFIRMED against the wiring photo (M8). These are final.**

```cpp
constexpr int PIN_MPU_SDA = 21, PIN_MPU_SCL = 22;
constexpr int PIN_GPS_RX = 16, PIN_GPS_TX = 17;
constexpr int PIN_SIM_RX = 26, PIN_SIM_TX = 27;
constexpr int PIN_IGNITION_BUTTON = 32, PIN_SAFE_BUTTON = 33, PIN_SOS_BUTTON = 25;
constexpr int PIN_GREEN_LED = 18, PIN_BLUE_LED = 19, PIN_RED_LED = 23;   // confirmed: red is 23, not 5
constexpr int PIN_BUZZER = 13;                                           // two-pin buzzer wired DIRECTLY (see O2)
// Optional battery sense: ADC1 only (e.g. GPIO34) because ADC2 is unavailable while Wi-Fi runs.
```

**FreeRTOS task layout:**

| Task | Rate | Owns |
|---|---|---|
| `sensorTask` | 100 Hz | MPU6050 read, complementary filter, 5 s ring buffer (downsample to 5 Hz for upload) |
| `gpsTask` | continuous | TinyGPSPlus parsing, fix validation, last-known fix |
| `logicTask` | 20 Hz | Incident FSM (§4.5.1), classification (§5.3.8), buttons (debounced edges), LEDs/buzzer patterns |
| `modemTask` | queue-driven | **Sole owner of the SIM800L UART.** Priority queue: 1 SMS, 2 control poll/decision ack, 3 incident PUT/notifications, 4 heartbeat, 5 image chunks |
| `cameraTask` | on demand | SoftAP management, capture request, JPEG → LittleFS |

**NVS keys:** `asgVer`, `asgJson` (snapshot), `ign`, `ignAt`, `cfgVer`, `cfgJson`, `evtId`, `evtJson` (active incident incl. local decision + SMS attempt states), `devCode`, `devSecret`, `camSecret`, `apPass`. Write only on change, not per sample.

**HMAC signing sketch (mbedtls, available in the Arduino-ESP32 core):**

```cpp
#include "mbedtls/md.h"
String hexOf(const uint8_t* b, size_t n){ static const char* h="0123456789abcdef"; String s; s.reserve(n*2);
  for(size_t i=0;i<n;i++){ s+=h[b[i]>>4]; s+=h[b[i]&15]; } return s; }
String sha256Hex(const uint8_t* data, size_t len){ uint8_t out[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), data, len, out); return hexOf(out,32); }
String hmacHex(const String& key, const String& msg){ uint8_t out[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
    (const uint8_t*)key.c_str(), key.length(), (const uint8_t*)msg.c_str(), msg.length(), out);
  return hexOf(out,32); }
// canonical = method + "\n" + pathWithQuery + "\n" + ts + "\n" + nonce + "\n" + sha256Hex(body)
// Verify against the test vector printed by `device-sim vector` before touching the modem.
```

The key is the raw 32-byte secret provisioned as 64 hex characters; decide once whether the HMAC key is the hex *string* or the decoded *bytes*, and implement the same in `lib/hmac.ts` and the simulator (recommended: decoded bytes).

### Appendix E.1 — What the proven sketches tell us (added 20 Sep 2026)

The team supplied two working sketches (`esp32_cam.txt`, `esp32.txt`) and a webhook.site screenshot showing a successful upload. This section records what is now **proven**, and the four changes integration must make to that code. **Where this section disagrees with §5.3, this section wins** — it is grounded in hardware that works.

#### E.1.1 Proven end-to-end path

| Step | Proven detail |
|---|---|
| Camera | ESP32-CAM runs `WiFi.softAP("InnovIoT-CAM","camera1234")`, serves `GET /capture` → `image/jpeg`. QVGA, `jpeg_quality = 20`, `fb_count = 1`. |
| Transfer | Main ESP32 joins that AP as a station, `HTTPClient` GET, validates SOI `FF D8` and EOI `FF D9`, buffers in RAM (`MAX_JPEG_BYTES = 30000`). |
| Upload | `AT+SAPBR=3,1,"CONTYPE","GPRS"` → `AT+SAPBR=3,1,"APN","dialogbb"` → `AT+SAPBR=1,1` (up to 85 s) → `AT+HTTPINIT` → `AT+HTTPSSL=0` → `AT+HTTPPARA="CID",1` → `URL` → `CONTENT`,`image/jpeg` → `AT+HTTPDATA=<len>,120000` → raw bytes in 256-byte chunks → `AT+HTTPACTION=1` → `+HTTPACTION: 1,200,<len>` → `AT+HTTPTERM`. |
| Result | 4030 bytes received server-side from a Dialog mobile IP, `user-agent: SIMCOM_MODULE`. |

**This is the entire device transport.** A JSON incident alert is the same sequence with `CONTENT` set to `application/json` and the JSON string written instead of JPEG bytes. Nothing new needs proving.

#### E.1.2 Change 1 — signature goes in the query string, not in headers

§5.3.2 originally put `X-Device`, `X-Ts`, `X-Nonce` and `X-Sig` in request headers. Custom headers on the SIM800L need `AT+HTTPPARA="USERDATA",...`, which is **only present on some modem firmware revisions** and is exactly the kind of thing that fails at 9 a.m. on demo day. The proven sketch sets no custom headers at all.

**Decision: authenticate every `/d/v1` request with query parameters.** One code path for JSON and images, no dependency on modem firmware revision.

```
POST /d/v1/incidents/EVT-7f21a9/image?dev=CL-0001&ts=1758380000&nonce=a91f3c&sig=<64 hex>
Content-Type: image/jpeg
<raw JPEG bytes>
```

Canonical string signed with the device secret (decoded 32 bytes, per Appendix E):

```
METHOD \n path \n dev \n ts \n nonce \n sha256hex(body)
```

`path` excludes the query string entirely, so the server rebuilds it without parsing order ambiguity. `sha256hex(body)` over an empty body is the SHA-256 of the empty string. The server rejects a request whose `ts` is more than 300 s from server time, or whose `nonce` has been seen before for that device within that window. `lib/hmac.ts`, the simulator and the firmware must all use this same string — verify against `device-sim vector` before touching the modem.

#### E.1.3 Change 2 — read the response body

Every device response carries queued commands (§5.3.4). After a `200`:

```cpp
sim800.println("AT+HTTPREAD");            // returns +HTTPREAD: <len> then the body
String body = readModemUntil("\r\nOK\r\n", 20000);
// parse the JSON after the +HTTPREAD: <len> line, then AT+HTTPTERM
```

Keep server responses to `/d/v1` **under 1 KB**. Long responses are slow to drain at 9600 baud and easy to truncate.

#### E.1.4 Change 3 — keep the bearer open, and never block the sensor loop

Two problems with the sketch as written, both fine for a bring-up test and fatal in the product:

- **`AT+SAPBR=1,1` can take up to 85 s.** Opening the bearer *after* a crash is detected would blow the 60-second response window. Open it once at boot, check it with `AT+SAPBR=2,1` before each use, and reopen only on failure. Do not call `AT+HTTPTERM`+`AT+HTTPINIT` per request more than necessary.
- **Everything runs in `setup()` with blocking waits.** During a 120 s `HTTPDATA` window the device would read no accelerometer samples and no buttons — including the Safe button. Move the modem to the queue-driven `modemTask` in Appendix E, with the sensor and logic tasks running independently.

**Ordering after a confirmed crash** (highest value first, because the modem is a single serial resource):
1. Incident JSON to the server (small, ~1 s of serial time).
2. SMS to the owner.
3. SMS to the emergency contact, if the 60 s window expires with no response.
4. Image upload **last** — it is the slowest and the least time-critical.

#### E.1.5 Change 4 — image size budget

At 9600 baud the modem accepts roughly **960 bytes per second**, so `HTTPDATA` alone costs:

| JPEG size | Serial time | Verdict |
|---|---|---|
| 4 KB (measured) | ≈ 4.2 s | Comfortable — keep QVGA / quality 20 |
| 10 KB | ≈ 10.5 s | Acceptable |
| 25 KB (stated ceiling) | ≈ 26 s | Too slow to sit inside the incident flow |

Keep the demo image at QVGA/quality 20 and **cap uploads at 10 KB**; if a capture exceeds it, re-capture at lower quality rather than sending it. If you want headroom, raise the modem to 38400 with `AT+IPR=38400` and re-test — but only after the demo is working at 9600, which is the more brownout-tolerant rate.

#### E.1.6 Offline image queue (M9)

The camera has a microSD card. When the bearer is down, the main ESP32 writes the JPEG to **LittleFS** (its own flash) if it fits, otherwise asks the camera to retain the capture on SD under the incident ID, and retries on the next successful heartbeat. The server treats a late image as an update to an existing incident (`PUT /d/v1/incidents/{id}` then the image POST), never as a new incident.

#### E.1.7 Two small hardware notes

- **ADC2 is unusable while Wi-Fi is active**, and the main ESP32 turns Wi-Fi on to fetch photos. Any future battery-sense divider must use an ADC1 pin (32–39). Not needed now — M10 says battery is not measured.
- **GPIO16/17 for GPS** are unavailable on ESP32-WROVER modules (they are wired to PSRAM). The GPS is already working on this board, so it is a WROOM — just do not swap in a WROVER board late.

### Appendix F — Slide update checklist (do today)

1. Slide 1: title "CrashLink — …"; fix team member name spelling (C4).
2. Slides 5, 7, 9: "15 seconds" → "10-second fall confirmation + 60-second rider response" (C1).
3. Slide 7: charging from the bike battery → "production design; prototype uses a fused, pre-charged LiPo" (C6).
4. Slide 4: add the §4.1 architecture diagram and the phrase "one app, two role experiences" (C8).
5. Slide 5: mention physical Safe/SOS buttons (C7) and 1990 one-tap.
6. Slide 6: real screenshots — emergency screen, incident timeline, bike health.
7. New slide: "What makes CrashLink different" (§1b.6) and "Roadmap" (§5.9 Future).
8. Replace any road-safety statistic with a cited, verified figure.

### Appendix G — Traceability: promises in the abstract (S1) → implementation

| Abstract promise | Where implemented |
|---|---|
| Distinguishes side-stand parking, parked falls, low-speed drops, potholes, collisions, cornering, rollovers, towing, tampering | §5.3.8 rules; `IncidentType` enum |
| Checks the bike remains fallen before alerting | 10 s persistence (updated from 15 s — C1) |
| Records location and time, captures image | §5.3.5 location object; §5.3.11 camera; §4.4.3 upload |
| Alerts owner through SMS and app | §5.3.10 SMS; §5.5 realtime + FCM |
| Renter responds "Safe" / "Need Help" | §2.4 emergency screen; physical buttons §5.3.6 |
| No response → emergency contact SMS | D2–D4; offline fallback §4.4.2 |
| Parking duration, bike status, trip distance, incident history | §5.6.5 derived values; §2.3.6 screens |
| LiPo charged from motorcycle battery | Design concept only (C6) |
| Reduces false alarms | Persistence, context, hysteresis, human confirmation |

---

*End of document.*
