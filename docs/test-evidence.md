# Test evidence

Evidence for the §7.2 test matrix. Each row records what was actually observed,
not what was expected to happen.

## Automated — `npm test`

Run against Postgres 16 (CI service container, or a local one):

```bash
docker run -d --name crashlink-test-db -p 55432:5432 \
  -e POSTGRES_USER=crashlink -e POSTGRES_PASSWORD=crashlink \
  -e POSTGRES_DB=crashlink_test postgres:16-alpine
npm test
```

| Suite | Covers | Status |
|---|---|---|
| `test/auth.test.ts` | FR-AUTH-01..03: register, login by email or phone, refresh rotation, replay detection, logout | 10 passing |
| `test/rentals.invariants.test.ts` | FR-RENT-01..04: snapshots, `SET_ASSIGNMENT`, one-open-rental per bike and per driver (including concurrent requests), idempotency, cancel/end/force-activate | 14 passing |
| `test/snapshots.test.ts` | §5.6.4, FR-DRV-04: recipient snapshots unchanged after the driver edits their contact or renames their account | 4 passing |
| `test/ownership.test.ts` | §5.7.2: cross-owner 404s, role boundaries, read-only GUEST, device provisioning secrecy | 13 passing |
| `test/hmac.test.ts` | Appendix E.1.2 canonical string and signature vectors | 5 passing |
| `test/decision.engine.test.ts` | §5.3.6 D1-D10 with a fake clock: SAFE at 30 s wins; HELP immediate; one CONTACT_SMS under 20 concurrent polls + a concurrent late SAFE; late SAFE stored `accepted=false reason=TOO_LATE`; duplicate PUT idempotent; assignmentVersion mismatch quarantined with `serverQuestion=false`; offline-fallback never duplicates CONTACT_SMS | 17 passing |
| `test/deviceGateway.test.ts` | §5.3: bad signature / stale timestamp / replayed nonce / revoked device rejected; heartbeat ingest, per-item fix rejection, de-duplication, distance; commands + ack -> ACTIVE; §5.3.7 append-only attempts; §4.4.3 chunked upload incl. wrong-SHA failure, resume, size cap; FR-INC-10 dead-man | 21 passing |

| `test/analytics.test.ts` | §5.4.7: range validation (reversed, > 366 d, malformed, `bucket≠day`); by-type ordering and owner scoping; timeseries bucketed by Colombo day with empty days zero-filled; distance by ride start incl. idle bikes; outcome counts and median of accepted responses only; potholes; dashboard KPIs / open emergency / recent; GUEST allowed except response-outcomes, DRIVER refused | 13 passing |
| `test/severity.integrity.test.ts` | §5.6.5: formula worked example, caps, unknown speed, fallen threshold, label boundaries, SOS and non-EMERGENCY unscored; canonical JSON key-order independence; hash stamped on device, SOS and dead-man incidents; refreshed on photo completion (VERIFIED); failed photo excluded; post-hoc evidence edit detected (MISMATCH) | 17 passing |
| `test/ridingTime.test.ts` | §5.6.5 riding/parked: span walk, unknown time never counted, out-of-window events ignored, unordered batches; Colombo day start; plain heartbeats recorded as ignition events; yesterday's state carried into today | 8 passing |
| `test/compliance.test.ts` | Fixes from the compliance review: FR-RENT-04 10-min end timeout and `endConfirmedByDevice`; ADMIN read access and admin image URL; phone masking for GUEST/ADMIN; FR-IMG-03 PENDING and UPLOADING %; per-account login lockout; per-device rate limit and 32 KB body cap; D6; D8 both facts; D9 audit; `/admin/health`; NFR-12 1 KB responses and 4 KB heartbeat; NFR-04 labels | 16 passing |
| `test/evidence.test.ts` | Evidence for Musts that had no direct test: FR-MON-02 thresholds; FR-RENT-05 plausibility; log masking; NFR-05 auth on every route; JWT / bcrypt / refresh parameters; FR-DEV-04 health; FR-DRV-02/03; NFR-06 retention; FR-NOT-03 socket rooms + NFR-01 ≤ 2 s | 17 passing |
| `test/demo.test.ts` | `demo:check` rules (workers, devices, commands, cert, summary); FR-DEMO-01 seed incl. secrets kept on re-seed; FR-DEMO-03 reset clears demo data only and refuses outside DEMO_MODE | 10 passing |
| `apps/mobile/test/honesty.test.ts` | NFR-04 / FR-NOT-02 delivery wording (incl. a scan of every string in `en.json`), FR-MON-03 freshness, FR-IMG-03 photo line | 9 passing |

Last full run (2026-09-21): **165 API tests in 13 files + 9 mobile tests in 1 file, all passing**. `npm test` at the root runs both.

## Manual / hardware

Fill these in as they are executed — leave a row blank rather than guessing.

| # | Scenario | Expected | Observed | Date |
|---|---|---|---|---|
| 1 | Device provision → pair → assign → device ack | Rental PENDING_SYNC → ACTIVE | | |
| 2 | Fall confirmed 10 s, ignition ON | Owner SMS submitted, driver question within 60 s | | |
| 3 | Driver answers "I'm safe" in time | `RESOLVED_SAFE`, no contact SMS | | |
| 4 | No answer within 60 s | `TIMEOUT` → `ESCALATED`, exactly one contact SMS | | |
| 5 | Device offline during the window | Local escalation at deadline + 15 s, reconciled later, no second contact SMS | | |
| 6 | Parked fall (ignition OFF) | `PARKED_BIKE_FALL`, owner SMS, no driver question | | |
| 7 | Image upload after an incident | SHA-256 matches, photo `AVAILABLE` | | |
| 8 | Revoked device | Every `/d/v1` call returns 401 `DEVICE_REVOKED` | | |

## Notes

- Battery percent is never measured (M10) — every screen shows "Not measured".
- SMS is sent only by the bike; the backend never sends SMS. Notification state
  never claims delivery beyond what the modem actually reported (§5.3.7).
