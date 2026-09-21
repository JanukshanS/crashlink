# Compliance checklist

Review of the repository against `docs/CrashLink_Solution_Architecture_FSD.md`:
§5.2 (every **Must** requirement), §5.3.6 (D1–D10) and §5.7 (security design).
Reviewed on 2026-09-21 against the working tree on `master`.

**Status values**

| Status | Meaning |
|---|---|
| **PASS** | Built, with the evidence listed: a test that fails if the rule breaks, or a manual step you can repeat. |
| **PASS (fixed)** | Failed during this review, was fixed, and now has the evidence listed. See [Fixed during this review](#fixed-during-this-review). |
| **HARDWARE** | Depends on firmware or physical hardware that is not in this repo (`firmware/` holds only READMEs and the gitignored `secrets.h`). The server side is covered where one exists. |
| **NOT VERIFIED** | Built or configured, but not measured. No PASS is claimed without evidence. |

**Evidence shorthand.** `A:` = `apps/api/test/`. `M:` = `apps/mobile/test/`. Test names are quoted
exactly, as `describe › it`, so `npx vitest run -t "<it name>"` finds them. `npm test` at the root
runs both packages: **165 API + 9 mobile, all passing** (2026-09-21).

**Summary:** 37 of 37 Must FRs are PASS. Of the NFRs, 10 are PASS, NFR-07 is NOT VERIFIED and NFR-09 is HARDWARE.
D1–D3 and D6–D9 are PASS. D4 and D5 are PASS on the server side and HARDWARE on the device side, and D10 is HARDWARE.
There are **no open non-hardware FAILs.**

---

## 5.2.1 Functional requirements (Must only)

### Authentication & accounts

| ID | Status | Evidence |
|---|---|---|
| FR-AUTH-01 Register OWNER/DRIVER, E.164, password ≥ 8 | PASS | A:auth.test.ts `POST /auth/register › creates an owner and returns a session`; `› rejects a short password and a non-E.164 phone with VALIDATION_FAILED`; `› rejects a duplicate email with EMAIL_TAKEN and a duplicate phone with PHONE_TAKEN` |
| FR-AUTH-02 Login by email or phone; access 1 h, refresh 30 d | PASS | A:auth.test.ts `POST /auth/login › accepts either the email or the phone as the identifier`; A:evidence.test.ts `§5.7.1 token and password parameters › signs HS256 access tokens for 1 h with sub, role and isDemo`; `› hashes passwords with bcrypt cost 10 and keeps refresh tokens 30 days, hashed` |
| FR-AUTH-03 Refresh rotates; logout revokes | PASS | A:auth.test.ts `POST /auth/refresh - rotation (FR-AUTH-03) › issues a new pair and revokes the presented token`; `› rejects a replayed token and revokes the whole family`; `POST /auth/logout › revokes the refresh token so it cannot be rotated again` |

### Driver profile

| ID | Status | Evidence |
|---|---|---|
| FR-DRV-01 One current emergency contact; history kept | PASS | A:snapshots.test.ts `› keeps the old contact row so the historic snapshot stays resolvable`; `› uses the new contact for the next rental` |
| FR-DRV-02 Active rental: bike, start, distance, ignition, freshness, connectivity | PASS (fixed) | API: A:evidence.test.ts `FR-DRV-02 / FR-DRV-03 the driver's own views › shows the active rental with start, distance, ignition, freshness and connectivity`. App: driver home now shows "Started …" (`app/(driver)/index.tsx`). Manual: log in as `janukshan@gmail.com` with an active rental and check the card shows start time, km, ignition chip, freshness badge and "Bike connected/not reporting". |
| FR-DRV-03 Own rentals and incidents, no photos | PASS | A:evidence.test.ts `› never gives a driver photo fields, in the list or the detail`; A:ownership.test.ts `› lets a driver read their own rental but hides another driver rental` |
| FR-DRV-04 Contact change applies to the next rental; UI says so | PASS | A:snapshots.test.ts `Emergency contact edits during an open rental (FR-DRV-04) › leaves the rental snapshot untouched and says the change applies to the next rental`. UI string `driver.contactAppliesNext`. |

### Bikes & devices

| ID | Status | Evidence |
|---|---|---|
| FR-DEV-01 Admin provisions (CLI); secret shown once | PASS | A:ownership.test.ts `Admin device provisioning (FR-DEV-01, §5.4.8) › returns the secret once and stores it encrypted, not in the clear`; `› allocates the next free code when none is given, and refuses a duplicate`. Manual: `npm run device:provision -w apps/api -- --code CL-0009` |
| FR-DEV-02 Owner creates bikes and pairs with code + pairing code | PASS | A:ownership.test.ts `› pairs a bike with the provisioned codes and rejects a wrong pairing code`; `› refuses to pair a device that already belongs to another bike` |
| FR-DEV-04 Device health, battery nullable | PASS | A:evidence.test.ts `FR-DEV-04 device health on bike detail › shows every health field after a heartbeat, battery always null (M10)` |

### Rentals

| ID | Status | Evidence |
|---|---|---|
| FR-RENT-01 Assign driver with contact; snapshot recipients | PASS | A:rentals.invariants.test.ts `› assigns a driver, snapshots the recipients and queues SET_ASSIGNMENT`; `› refuses a driver with no emergency contact (NO_EMERGENCY_CONTACT)`; `› refuses a bike with no paired device (DEVICE_NOT_PAIRED)` |
| FR-RENT-02 One open rental per bike and per driver (DB-enforced) | PASS | A:rentals.invariants.test.ts `› holds under concurrent requests - exactly one rental survives`; `› is enforced by the database even when the service layer is bypassed`; `› holds under concurrent requests across different bikes` |
| FR-RENT-03 ACTIVE only after device ack; demo force-activate audited and flagged | PASS | A:deviceGateway.test.ts `› delivers SET_ASSIGNMENT and activates the rental on ack (FR-RENT-03)`; A:rentals.invariants.test.ts `› force-activate is allowed in DEMO_MODE and is flagged and audited` |
| FR-RENT-04 End → CLEAR_ASSIGNMENT → ENDED on ack, or after 10 min with a warning | PASS (fixed) | A:rentals.invariants.test.ts `› ends an active rental into ENDING_SYNC and queues CLEAR_ASSIGNMENT`; A:compliance.test.ts `FR-RENT-04 ending a rental › ends an ENDING_SYNC rental after 10 minutes without a device ack, and flags it`; `› reports endConfirmedByDevice=true when the bike acked CLEAR_ASSIGNMENT`. App: bike detail shows the `owner.endingSync` warning while ENDING_SYNC. |
| FR-RENT-05 Distance from plausible fixes (≥ 5 m, ≤ 150 km/h, HDOP ≤ 5) | PASS | A:evidence.test.ts `FR-RENT-05 trip distance plausibility (§5.6.5)` (4 tests); A:deviceGateway.test.ts `› accumulates trip distance on an ACTIVE rental (FR-RENT-05)` |

### Monitoring

| ID | Status | Evidence |
|---|---|---|
| FR-MON-01 Heartbeats update last seen, health, ignition, location; pushed realtime | PASS | A:deviceGateway.test.ts `§5.3.3 heartbeat ingest › stores fixes, updates the bike and rejects implausible coordinates per item`; A:ridingTime.test.ts `› records ignition changes from plain heartbeats and walks them into today's totals`. The realtime push (`bike.updated` / `device.status`, `DeviceIngestService.emitBikeUpdate`) has no test of its own; FR-NOT-03 below tests the socket rooms. Manual: `npm run sim -w tools/device-sim -- heartbeat-loop --device CL-0002` and watch the owner dashboard update with no pull-to-refresh. |
| FR-MON-02 Online / stale / offline per §2.3.3 | PASS | A:evidence.test.ts `FR-MON-02 online / stale / offline (§2.3.3)` (3 tests) |
| FR-MON-03 Freshness badge on every location; DEMO always shown | PASS (fixed) | M:honesty.test.ts `FR-MON-03 freshness › says DEMO for simulator fixes, whatever their age`; `› is LIVE only up to 30 s, then LAST KNOWN with minutes`; `› marks an incident fix as at the event`. A:deviceGateway.test.ts `› rejects DEMO-sourced fixes unless the device config allows them`. The incident map now badges its fix as "AT EVENT". |

### Incidents & alerts

| ID | Status | Evidence |
|---|---|---|
| FR-INC-01 Upsert idempotent on eventId | PASS | A:decision.engine.test.ts `FR-INC-01 / FR-INC-06 - idempotency and quarantine › a duplicate PUT returns the same incident and creates nothing new` |
| FR-INC-02 EMERGENCY + active rental → question, deadline +60 s | PASS | A:decision.engine.test.ts `› opens a 60 s window from questionSentAt, on server time` |
| FR-INC-03 First accepted response wins; later ones `accepted=false` | PASS | A:decision.engine.test.ts `D1 - a response inside the window wins › SAFE at 30 s is accepted and resolves the incident`; `› stores a late SAFE with accepted=false and reason TOO_LATE (D7)` |
| FR-INC-04 HELP immediate; TIMEOUT at deadline; exactly one CONTACT_SMS | PASS | A:decision.engine.test.ts `› HELP escalates immediately and requests exactly one CONTACT_SMS (D3)`; `› creates one CONTACT_SMS under 20 concurrent polls and a concurrent late SAFE` |
| FR-INC-05 Device decisions reconciled without a second CONTACT_SMS | PASS | A:decision.engine.test.ts `D8 - offline-fallback reconciliation › does not create a second CONTACT_SMS when the device escalated offline` |
| FR-INC-06 Version mismatch quarantined, no question, owner alerted | PASS | A:decision.engine.test.ts `› quarantines an assignmentVersion mismatch with serverQuestion=false`; `› quarantines a rentalId that does not match the resolved rental` |
| FR-INC-07 Incident list/detail: "Possible …", severity, location + freshness, timeline, evidence, response, photo | PASS | A:compliance.test.ts `NFR-04 honest labels › begins every incident label with "Possible", except SOS and device-offline`; A:severity.integrity.test.ts `› folds the verified photo hash in, and the detail view reports VERIFIED`; A:compliance.test.ts `D8 both facts are shown › records the bike's offline escalation on the timeline …`. Manual: open any seeded incident as `arushan@gmail.com` and check every section of §2.3.6 is present. |
| FR-INC-09 SECURITY and INFO never question the driver | PASS | A:decision.engine.test.ts `› never questions SECURITY or INFO incidents (FR-INC-09)` |

### Notifications

| ID | Status | Evidence |
|---|---|---|
| FR-NOT-01 Logical notifications unique per incident; attempts append-only | PASS | A:deviceGateway.test.ts `§5.3.7 notification reporting › records attempts append-only and never downgrades the logical state`; one-CONTACT_SMS tests under FR-INC-04 |
| FR-NOT-02 "Delivered" only for NETWORK_CONFIRMED / CLIENT_RECEIVED | PASS | M:honesty.test.ts `FR-NOT-02 notification wording` (3 tests, including `› no string in en.json claims delivery, except the two delivered states`) |
| FR-NOT-03 Realtime socket events to owner and driver rooms | PASS | A:evidence.test.ts `FR-NOT-03 realtime rooms and NFR-01 latency › delivers incident.created to the owner and incident.question to the driver within 2 s, and to nobody else` |
| FR-NOT-05 Driver polls pending question every 5 s while active and foregrounded | PASS (fixed) | `usePendingQuestion` polls every 5 s (`REFETCH_INTERVALS.pendingQuestion`) only while a rental is active. The 5 s poll ran in the background because RN never told TanStack about focus. `app/_layout.tsx` now drives `focusManager` from `AppState`. Manual: with an active rental, watch the API log (`GET /api/v1/drivers/me/pending-question` every 5 s), send the app to the background, and see the requests stop; bring it back and they resume. |

### Images

| ID | Status | Evidence |
|---|---|---|
| FR-IMG-01 Resumable chunked upload, SHA-256 verified, ≤ 200 KB, chunk ≤ 8 KB | PASS | A:deviceGateway.test.ts `› accepts a correct upload and serves it through a signed URL`; `› fails the upload when the SHA-256 does not match`; `› resumes from the server offset and rejects an out-of-order chunk`; `› refuses an image larger than the hard cap (FR-IMG-01)` |
| FR-IMG-02 Short-lived signed URLs, owner (and admin) only | PASS (fixed) | A:compliance.test.ts `› lets an ADMIN read any owner's bikes, rentals, incidents and image URL, but not change them`; A:ownership.test.ts cross-owner 404s. The signature is now a real `HMAC(FILE_URL_SECRET, key + exp)` with `exp` ≤ 300 s, checked with `timingSafeEqual`. |
| FR-IMG-03 NOT_REQUESTED / PENDING / UPLOADING (%) / AVAILABLE / FAILED | PASS (fixed) | A:compliance.test.ts `FR-IMG-03 photo status and progress › reports PENDING before any upload session exists`; `› reports UPLOADING with a real percentage`; M:honesty.test.ts `FR-IMG-03 photo status` (2 tests). The app shows the real %, "deleted after the retention period" and an owner-only placeholder for the judge. |

### Analytics, admin & demo

| ID | Status | Evidence |
|---|---|---|
| FR-ANA-01 Dashboard KPIs | PASS | A:analytics.test.ts `GET /owners/me/dashboard › computes KPIs, the open emergency and recent activity for this owner only` |
| FR-DEMO-01 Seed: admin, owner (Arushan; spec: "Nimal"), driver (Janukshan; spec: "Ravi"), contact, Scooter 1 ↔ CL-0001 | PASS (fixed) | A:demo.test.ts `FR-DEMO-01 seed › creates the admin, Nimal, Ravi, the contact, the judge and Scooter 1 paired to CL-0001`; `› keeps device secrets on a re-seed, so the real bike is not locked out` |
| FR-DEMO-02 Simulator speaking the real HMAC protocol | PASS | `tools/device-sim` uses the same `buildCanonicalString` as the server (A:hmac.test.ts). Manual: `npm run sim -w tools/device-sim -- collision-timeout --device CL-0002` → the owner app shows the incident, TIMEOUT at 60 s, and one CONTACT_SMS. Scenarios: heartbeat-loop, collision-safe/-timeout/-help, offline-fallback, parked-fall, dead-man, and more. |
| FR-DEMO-03 Demo reset CLI (demo data only) | PASS (fixed) | A:demo.test.ts `FR-DEMO-03 demo reset › clears demo incidents and rentals, re-seeds, and never touches a real owner's data`; `› refuses to run when DEMO_MODE is off, unless forced`. Manual: `npm run demo:reset` |

---

## 5.2.2 Non-functional requirements

| ID | Status | Evidence |
|---|---|---|
| NFR-01 Latency: PUT incident → owner app ≤ 2 s (server side) | PASS | A:evidence.test.ts `› delivers incident.created to the owner and incident.question to the driver within 2 s, and to nobody else`. The device-side half (≤ poll interval + GPRS) is HARDWARE. |
| NFR-02 Availability: Uptime Kuma, `restart: unless-stopped` | PASS (config) | `deploy/docker-compose.yml`: every service `restart: unless-stopped`; `uptime-kuma` service on 127.0.0.1:3001. Event-day manual step: add a 60 s HTTP monitor on `https://<host>/health` in Kuma, then run `npm run demo:check`. |
| NFR-03 Idempotent mutations, restart-safe workers, no duplicate SMS | PASS | A:decision.engine.test.ts `› creates one CONTACT_SMS under 20 concurrent polls and a concurrent late SAFE`; A:deviceGateway.test.ts `› de-duplicates a resent batch (§5.6.4)`, `› acks are idempotent and stop redelivery`; workers keep all their state in the DB (`workers/*.ts`, `runOnce()`). |
| NFR-04 Honesty; labels begin "Possible" | PASS (fixed) | A:compliance.test.ts `NFR-04 honest labels › …`; M:honesty.test.ts (all 9). `PARKED_BIKE_FALL` now reads "Possible parked bike fall" (see TODO(spec) below). |
| NFR-05 HTTPS, HMAC, RBAC on every endpoint, rate limiting, no secrets in repo, masked phones in logs | PASS (fixed) | A:evidence.test.ts `NFR-05 RBAC on every endpoint › refuses every non-public route without credentials` (walks the whole route table); A:deviceGateway.test.ts §5.3.2 signing (7 tests); A:compliance.test.ts `› limits a device to 60 authenticated requests per minute`; A:evidence.test.ts `§5.7.3 phone masking in logs and metadata` (2 tests). Manual: `git check-ignore -v apps/api/.env firmware/main-esp32/include/secrets.h` prints both rules. |
| NFR-06 Consent; owner-only photos; retention 30 / 90 / 180 d | PASS | A:evidence.test.ts `NFR-06 retention (§5.6.6) › deletes locations after 30 d, audit after 180 d and photos after 90 d - and says so honestly`; A:evidence.test.ts `› never gives a driver photo fields …`. The consent notice (`auth.consent`) is shown at registration, the app requires it for drivers, and the server records `users.consent_at`. The server does not yet refuse a rental for a driver without consent. That is FR-AUTH-06, a Should. |
| NFR-07 200 devices at 10 s on a 4 GB VPS; p95 < 300 ms | **NOT VERIFIED** | No load test has been run. Suggested step: 200 `heartbeat-loop` simulators (one per provisioned code) against the VPS for 10 min, then read p95 from the nginx access log. |
| NFR-08 Emergency screen with zero taps; buttons ≥ 72 dp | PASS | `EmergencyWatcher` opens `emergency/[incidentId]` on socket, poll or notification, with no tap; the buttons are `EMERGENCY_BUTTON_HEIGHT = 84` dp. The trilingual strings (Should) are in `src/i18n/si.json` and `ta.json`. Manual: run `collision-timeout` with the driver app open on any screen. The question appears by itself. |
| NFR-09 Android 10+, tested on the demo phones | **HARDWARE** | The Expo SDK 57 default `minSdkVersion` is below API 29, so Android 10+ is covered. The `expo export --platform android` bundle builds (2026-09-21). It has not been tried on the actual demo phones. Manual: install the APK (see `apps/mobile/README.md`) on each demo phone and run `collision-timeout`. |
| NFR-10 TS strict; shared zod contracts; ≥ 1 test per §5.3.6 rule | PASS | `tsc --noEmit` is clean for the API and mobile; all enums are in `packages/contracts`. Server-side D-rule tests are listed below. D4 device side and D10 are firmware. |
| NFR-11 Structured logs with request id; `/health`; `/admin/health`; complete timeline | PASS (fixed) | A:compliance.test.ts `NFR-11 / FR-ADM-01 GET /admin/health › reports db, workers, stale devices and pending commands to an admin only`; pino logs carry `reqId`; the timeline now includes device-local facts (D8). |
| NFR-12 Heartbeat ≤ 4 KB; image ≤ 200 KB | PASS (fixed) | A:compliance.test.ts `NFR-12 device payload budget › keeps every /d/v1 response under 1 KB by pacing commands, and still delivers them all in order`; `› fits a maximal heartbeat (10 fixes, 5 events) in 4 KB`; the image cap is under FR-IMG-01. |

---

## 5.3.6 Decision rules D1–D10

| Rule | Status | Evidence |
|---|---|---|
| D1 Accept only if PENDING and before the deadline | PASS | A:decision.engine.test.ts `D1 - a response inside the window wins` (3 tests) |
| D2 TIMEOUT only if PENDING and at/after the deadline | PASS | A:decision.engine.test.ts `› does not time out before the deadline`; `› creates one CONTACT_SMS under 20 concurrent polls …` |
| D3 HELP / TIMEOUT create CONTACT_SMS in the same transaction | PASS | A:decision.engine.test.ts `› HELP escalates immediately and requests exactly one CONTACT_SMS (D3)` |
| D4 Device polls every 3 s; escalates locally at deadline + 15 s with no control response | Server PASS / device **HARDWARE** | Server: A:decision.engine.test.ts `§5.3.6 control polling and device sync › reports PENDING before the deadline and the decision after`, and the late report is reconciled (D8). The escalation itself runs in firmware, which is not in this repo. It is simulated by `npm run sim -w tools/device-sim -- offline-fallback --device CL-0002`. |
| D5 Local SAFE resolves locally unless HELP/TIMEOUT already known | Server PASS / device **HARDWARE** | A:decision.engine.test.ts `D5 - the bike button › accepts a local SAFE inside the window and marks it DEVICE_BUTTON`; `› refuses a local SAFE once HELP or TIMEOUT has landed`. The device-side "resolve locally" branch is firmware. |
| D6 Local SOS always escalates; reported as HELP / MANUAL_SOS | PASS | A:compliance.test.ts `D6 bike SOS button › escalates a device MANUAL_SOS immediately: HELP, one CONTACT_SMS, no question` |
| D7 Late responses stored `accepted=false`, shown honestly | PASS | A:decision.engine.test.ts `› stores a late SAFE with accepted=false and reason TOO_LATE (D7)`. The app renders the reason chip in incident detail. |
| D8 No second CONTACT_SMS; both facts shown | PASS (fixed) | A:decision.engine.test.ts `› does not create a second CONTACT_SMS …`; `› keeps the server decision but records both facts when they disagree`; A:compliance.test.ts `D8 both facts are shown › records the bike's offline escalation on the timeline when the server had already decided SAFE` |
| D9 Local SAFE with no incident is informational only | PASS (fixed) | A:decision.engine.test.ts `› D9 - a local SAFE with no active incident never pre-resolves anything`; A:compliance.test.ts `D9 local Safe with no active incident › is logged as informational` |
| D10 Re-arm after 5 s upright; no repeats while down | **HARDWARE** | Firmware-only (`rearmUprightSec` is in the §5.3.9 config the server sends). Manual on the model bike: tip it over, wait for the incident, leave it down for 2 min and confirm one incident only. Stand it up for more than 5 s, tip it again, and confirm a second incident. |

---

## 5.7 Security design

### 5.7.1 Authentication

| Control | Status | Evidence |
|---|---|---|
| bcrypt cost 10 | PASS | A:evidence.test.ts `› hashes passwords with bcrypt cost 10 and keeps refresh tokens 30 days, hashed` |
| JWT HS256, `JWT_SECRET` ≥ 32 bytes, 1 h, claims sub/role/isDemo | PASS | A:evidence.test.ts `› signs HS256 access tokens for 1 h with sub, role and isDemo`; `config.ts` rejects a shorter secret at boot |
| Refresh: 32 random bytes, SHA-256 at rest, 30 d, rotated, revocable | PASS | A:auth.test.ts refresh and logout tests; A:evidence.test.ts (hashed, 30 d) |
| Login throttling (§5.4.10) | PASS (fixed) | Per-IP: `routeRateLimit` on `/auth/login`. Per-account: A:compliance.test.ts `§5.7.1 login throttling per account › locks the account after 5 failed logins in 15 minutes, even for the right password` |
| Device: per-device secret, HMAC-SHA256, ± 300 s, nonce replay, AES-256-GCM at rest | PASS | A:deviceGateway.test.ts `§5.3.2 request signing (Appendix E.1.2)` (7 tests); A:hmac.test.ts (5); A:ownership.test.ts `› returns the secret once and stores it encrypted, not in the clear` |
| Camera: separate secret, HMAC on eventId + nonce, WPA2 | **HARDWARE** | ESP32-CAM firmware (§5.3.11). This was proven on hardware per spec 0.2 M3, but nothing in this repo tests it. |
| Signed file URLs `HMAC(FILE_URL_SECRET, key + exp)`, exp ≤ 5 min | PASS (fixed) | `modules/images/service.ts`; `SIGNED_URL_TTL_SEC` max 300 in `config.ts`; A:deviceGateway.test.ts `› accepts a correct upload and serves it through a signed URL` |

### 5.7.2 Authorization (RBAC + ownership)

| Row | Status | Evidence |
|---|---|---|
| Cross-owner ids → 404 | PASS | A:ownership.test.ts `Cross-owner access returns 404 (§5.7.2)` (5 tests) |
| Role boundaries on every route | PASS | A:ownership.test.ts `Role boundaries (§5.7.2)` (3 tests); A:evidence.test.ts NFR-05 sweep; A:analytics.test.ts `› refuses a DRIVER every analytics route` |
| GUEST read-only, demo data, 403 on non-GET | PASS | A:ownership.test.ts `GUEST is read-only (§5.4.2, §5.7.2) › can read the demo owner fleet but is refused every mutation`; A:analytics.test.ts `› lets a GUEST read the demo owner's analytics, but not response outcomes` |
| ADMIN reads bikes, rentals, incidents, images, analytics (all) | PASS (fixed) | A:compliance.test.ts `§5.7.2 ADMIN read access and FR-IMG-02 admin image access › lets an ADMIN read any owner's bikes, rentals, incidents and image URL, but not change them` |
| Emergency contact masked for GUEST | PASS (fixed) | A:compliance.test.ts `› masks every phone number for GUEST and ADMIN; only the owner sees full numbers` |
| Images: DRIVER ✗, GUEST ✗ (placeholder) | PASS (fixed) | A:evidence.test.ts `› never gives a driver photo fields …`. The judge's app shows `incident.photoOwnerOnly` and never requests the signed URL (M:honesty.test.ts `› shows the image only when available, not expired, and not restricted`). |

### 5.7.3 Data protection

| Control | Status | Evidence |
|---|---|---|
| TLS 1.2+, HSTS on the app host | PASS (fixed, config) | `deploy/nginx/crashlink.conf`: `ssl_protocols TLSv1.2 TLSv1.3` (was left to certbot's defaults) and `Strict-Transport-Security`. Manual: `openssl s_client -connect <host>:443 -tls1_1` must fail. Manual: `npm run demo:check -- --api https://<host>` shows the certificate check, and `curl -sI https://<host>/health \| grep -i strict` shows HSTS. |
| Phones in E.164; masked in lists, logs, audit, driver views; full only in owner detail | PASS (fixed) | A:evidence.test.ts `§5.7.3 phone masking in logs and metadata` (2 tests); A:compliance.test.ts masking test. The ADMIN masking is a TODO(spec) below. |
| Photos never public; signed URLs; deleted after retention | PASS | FR-IMG-02 evidence; A:evidence.test.ts retention test (photo reported `expired`, not silently missing) |
| Secrets only in `.env` / gitignored `secrets.h` | PASS | Manual: `git check-ignore -v apps/api/.env firmware/main-esp32/include/secrets.h`; `git ls-files \| grep -E '\.env$\|secrets\.h$'` prints nothing |
| Postgres bound to the Docker network | PASS (config) | `deploy/docker-compose.yml`: `db` publishes no ports, and the API binds to 127.0.0.1:3000 only |
| Consent recorded | PASS | `users.consent_at` records the time the notice was accepted (`modules/auth/service.ts`). It is never assumed. |
| Audit: login, rental assign/end/force-activate, provision/revoke, pairing, incident ack, demo reset | PASS (fixed) | Actions: `LOGIN_SUCCEEDED/FAILED`, `RENTAL_ASSIGNED`, `RENTAL_END_REQUESTED`, `RENTAL_END_TIMEOUT`, `RENTAL_FORCE_ACTIVATED`, `DEVICE_PROVISIONED`, `DEVICE_REVOKED`, `BIKE_PAIRED/UNPAIRED`, `INCIDENT_ACKNOWLEDGED`, `DEMO_RESET`. Asserted: A:rentals.invariants.test.ts (force-activate), A:compliance.test.ts (login lockout reads `LOGIN_FAILED`; end timeout), A:demo.test.ts (`DEMO_RESET`). |

### 5.7.4 Device security

| Threat | Status | Evidence |
|---|---|---|
| Spoofed messages | PASS | A:deviceGateway.test.ts `› rejects a bad signature with BAD_SIGNATURE`; `› rejects a body altered after signing`; `› answers an unknown device code exactly like a bad signature` |
| Replay | PASS | A:deviceGateway.test.ts `› rejects a stale timestamp with STALE_TIMESTAMP`; `› rejects a replayed nonce with REPLAYED_NONCE` |
| Eavesdropping on plain HTTP (A7) | Residual risk (accepted by spec) | No user credentials travel on `/d/v1`. The optional AES-128-GCM payload encryption is Nice-to-have and not built. |
| Stolen device / cloned secret | PASS | A:deviceGateway.test.ts `› rejects a revoked device with DEVICE_REVOKED (FR-DEV-06)` |
| Rogue client on the camera AP | **HARDWARE** | WPA2, one-client limit and signed capture are firmware (§5.3.11) |
| Oversized / malformed payloads | PASS (fixed) | A:compliance.test.ts `› rejects a device body over 32 KB with PAYLOAD_TOO_LARGE`; nginx `client_max_body_size 32k` on `/d/`; per-item rejection in A:deviceGateway.test.ts; chunk and image caps under FR-IMG-01 |
| Flooding | PASS (fixed) | nginx `limit_req zone=dev`; A:compliance.test.ts `› limits a device to 60 authenticated requests per minute` |
| Assignment confusion | PASS | FR-INC-06 quarantine tests; A:snapshots.test.ts |
| Firmware tampering | Future (per spec) | Secure boot and signed OTA are listed as future work |

---

## Fixed during this review

Each of these was a FAIL when the review started. Each now has the evidence listed above.

| # | Requirement | What was wrong | Fix |
|---|---|---|---|
| 1 | FR-RENT-04 | An ENDING_SYNC rental waited forever if the bike never acked `CLEAR_ASSIGNMENT` | `commandExpiry` worker calls `endStaleRentals(RENTAL_END_TIMEOUT_SEC = 600)`, audits `RENTAL_END_TIMEOUT`, and returns `endConfirmedByDevice=false`. The app warns while ENDING_SYNC. |
| 2 | §5.7.2 / FR-IMG-02 | ADMIN got 403 on bike, rental, incident, image and analytics reads | `ReadScope` in `lib/ownership.ts` (ADMIN all, GUEST demo, OWNER own). Mutations stay owner-only. |
| 3 | §5.7.2 / §5.7.3 | GUEST (and ADMIN) saw full rider and contact phones | Masked unless `canSeeFullPhones` (OWNER only) |
| 4 | FR-IMG-03 | UPLOADING had no percentage, PENDING was not distinct, the app showed "…" | The API returns `progress` (0..1) and `expired`. `PhotoPanel` renders them through `photoLine()`. |
| 5 | §5.7.1 | No per-account lockout, and logins were not audited | 5 `LOGIN_FAILED` in 15 min → 429. `LOGIN_SUCCEEDED/FAILED` are audited. |
| 6 | §5.7.4 | Device rate limit was per IP, so every bike behind CGNAT shared one bucket. Fastify accepted bodies up to 1 MB on `/d/v1`. | Per-device limit counted on authenticated nonces (60/min). 32 KB `bodyLimit` on the device parsers. |
| 7 | §5.7.1 signed URLs | The signature was not the specified `HMAC(key + exp)`, and exp was not capped | Real HMAC, `exp` ≤ 300 s, constant-time compare |
| 8 | D8 | When the server said SAFE and the bike escalated offline, the device's fact was dropped | `DEVICE_LOCAL_DECISION` audit event, shown on the timeline |
| 9 | D9 | A local SAFE with no incident left no trace | `DEVICE_LOCAL_RESPONSE_NO_INCIDENT` audit event |
| 10 | NFR-12 | A backlog of commands could push a device response over the SIM800L's ~1 KB budget | `COMMAND_BYTE_BUDGET = 880`, up to 5 commands, always at least one |
| 11 | FR-ADM-01 / NFR-11 | `/admin/health` lacked worker lag, stale devices and pending commands | Returns db, workers `{lastRunAt, lagMs, intervalMs, lastError}`, staleDevices, pendingCommands, version. Workers run once at start. |
| 12 | NFR-04 | The `PARKED_BIKE_FALL` label did not begin with "Possible" | "Possible parked bike fall" |
| 13 | FR-DEMO-01 | Re-running the seed rotated device secrets, which locked the real CL-0001 out | Secrets are kept unless `--rotate-device-secrets` is passed |
| 14 | FR-DEMO-03 | No demo reset | `npm run demo:reset`: deletes demo data only, re-seeds without rotation, audits `DEMO_RESET`, refuses unless `DEMO_MODE` or `--force` |
| 15 | FR-DRV-02 | The driver app did not show the rental start time | "Started …" in Colombo time on driver home |
| 16 | FR-NOT-05 | The 5 s poll kept running in the background (TanStack never learnt about RN app state) | `focusManager` wired to `AppState` in `app/_layout.tsx` |
| 17 | FR-MON-03 | The incident map's fix did not say it was the location at the event | `FreshnessBadge atEvent` → "LAST KNOWN · n min · AT EVENT" |
| 18 | NFR-06 / FR-IMG-03 | Retention rewrote `photoStatus`, so an expired photo looked "not requested" | The status is kept. The detail view reports `expired: true` and the app says "Photo deleted after the retention period". |
| 19 | §5.7.3 TLS | TLS 1.2+ depended on certbot's include | `ssl_protocols TLSv1.2 TLSv1.3` pinned in `deploy/nginx/crashlink.conf` |

## Pre-demo commands

```bash
npm run demo:reset     # clear rehearsal incidents/rentals, re-seed demo data (keeps device secrets)
npm run demo:check     # green/yellow/red checklist; exit 1 on any red
npm run demo:check -- --api https://crashlink.example.com
```

Both scripts are also available as `-w apps/api`.

`demo:check` checks: API `/health`; DB connectivity and pending/failed migrations; each worker's
lag against its own interval (via `/admin/health`); each demo device online (real hardware offline
is red, the simulator offline is yellow); queued commands (older than 120 s = stuck = red); TLS certificate
expiry for `PUBLIC_BASE_URL` (< 3 days red, < 14 days yellow); demo accounts present; rehearsal
leftovers; `GUEST_ENABLED`. The rules are unit-tested in A:demo.test.ts `demo:check rules`.

## Open TODO(spec) items

| Item | Choice made (safest) |
|---|---|
| `PARKED_BIKE_FALL` label: Appendix D vs NFR-04 | NFR-04 wins: "Possible parked bike fall" (`packages/contracts/src/common.ts`) |
| Late response reason: `TOO_LATE` vs the example `ALREADY_DECIDED` | `TOO_LATE` once the deadline has passed; `ALREADY_DECIDED` when another response won first |
| Severity scope | EMERGENCY falls only; SOS is labelled without a score; SECURITY/INFO unscored |
| Analytics bucket | `bucket=day` only |
| Distance attribution in analytics | By ride start time |
| `response-outcomes` for GUEST | 403 (OWNER/ADMIN only per the §5.4.7 table) |
| ADMIN phone visibility | Masked. §5.7.3 grants full numbers "only in owner incident/rental detail". |
