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

Last full run: 46 passing, 5 files.

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
