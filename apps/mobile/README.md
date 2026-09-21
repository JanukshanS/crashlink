# CrashLink mobile

Expo (SDK 57) + TypeScript + Expo Router. One Android APK, `lk.iotrix.crashlink`,
with role-based experiences (§2.1): OWNER/GUEST → `(owner)`, DRIVER → `(driver)`,
ADMIN → `(admin)`.

## Quick start

```bash
# 1. Point the app at your API (see "Choosing EXPO_PUBLIC_API_URL" below)
echo "EXPO_PUBLIC_API_URL=http://10.0.2.2:3000" > apps/mobile/.env

# 2. Backend must be running and seeded
npm run db:seed -w apps/api
npm run dev -w apps/api

# 3. Start Metro
npm run start -w apps/mobile
```

Demo logins (from the seed): `owner@demo.lk`, `ravi@demo.lk`, `judge@demo.lk`,
all with password `demo1234`. "Continue as Judge" logs into the read-only guest
account without typing anything.

### Choosing `EXPO_PUBLIC_API_URL`

| Where the app runs | Value |
|---|---|
| Android emulator on this machine | `http://10.0.2.2:3000` (the emulator's alias for the host) |
| Physical phone on the same Wi‑Fi | `http://<your-LAN-IP>:3000`, e.g. `http://192.168.1.137:3000` |
| Deployed VPS | `https://crashlink.example.com` |

`localhost` will **not** work from a phone or emulator - it resolves to the
device itself. Find your LAN IP with `ipconfig` (Windows) or `ip addr` (Linux).

The URL is read at build time and baked into the APK, so an APK built for one
host cannot be repointed afterwards - rebuild with the new value.

## Local release APK (§5.8.3 Option A)

Requirements: **JDK 17**, Android SDK (Android Studio), `ANDROID_HOME` set.

```bash
cd apps/mobile

# 1. Generate the native project (safe to re-run; --clean discards edits)
EXPO_PUBLIC_API_URL=https://crashlink.example.com npx expo prebuild -p android --clean

# 2. Build the release APK
cd android
./gradlew assembleRelease          # Windows: .\gradlew.bat assembleRelease
```

The APK lands at:

```
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Install it with `adb install -r app-release.apk`, or copy the file to the phone
and enable "Install unknown apps".

There is a shortcut for both steps:

```bash
npm run apk -w apps/mobile
```

> The default template signs release builds with the **debug keystore**. That is
> fine for sideloading at the competition; create a real keystore before anything
> beyond it.

Build the first APK on Day 1 - native issues surface at prebuild, not at
`expo start`.

## What the app does

### Emergency screen — the priority (§2.4)

`app/emergency/[incidentId].tsx`. Full-screen, red, back button disabled until
resolved. It opens from **three independent triggers**, which all converge on
`emergencyStore` so it appears exactly once:

1. Socket.IO `incident.question` (fastest path);
2. polling `GET /drivers/me/pending-question` every 5 s while a rental is active
   (`EmergencyWatcher`) - this is what catches a question raised while the
   socket was down;
3. a notification tap (`NotificationBridge`).

The countdown is `responseDeadlineAt − (Date.now() + clockOffset)`, where the
offset comes from every server response the app sees. A handset with a wrong
clock cannot shorten or extend a rider's window.

Answers carry a UUID `idempotencyKey` that is **reused across retries**, so a
flaky link cannot turn one "I'm safe" into two responses. Status line states:

| State | Shown |
|---|---|
| in flight | `Sending…` |
| server accepted | `Accepted by server · syncing to bike` |
| `deviceSync === 'SYNCED'` | `Synced with bike ✓` |
| `409 TOO_LATE` | `Too late — emergency contact already notified at HH:MM:SS` |
| network failure | `Cannot reach server — retrying… (you can also press SAFE on the bike)` |

### Honesty rules enforced in the UI

These are not stylistic - they are the product (NFR-04):

- **`FreshnessBadge`** renders on every location: `LIVE` (≤ 30 s), `LAST KNOWN ·
  n min`, `UNAVAILABLE`, or `DEMO`. A map dot with no badge would claim the bike
  is there *now*.
- **`NotificationStateChip`** never prints "Delivered" unless the state is
  `NETWORK_CONFIRMED` (a real network delivery report) or `CLIENT_RECEIVED`.
  `AT_SUBMITTED` reads "Submitted to network", because that is all the modem
  told us.
- **Incident labels** are rendered verbatim from the API and always begin with
  "Possible" (Appendix D). The app never composes its own wording.
- **Battery** always reads "Not measured" (M10).
- **Severity** always carries its disclaimer: not a medical assessment.
- **Photos** are only shown when the server verified the SHA-256; a failed
  upload says so instead of showing an unverified image.

### Role routing (§2.1)

| Role | Group | Notes |
|---|---|---|
| OWNER | `(owner)` | Dashboard, bikes, incidents, insights, settings |
| GUEST | `(owner)` | Same screens, **read-only**: every mutation control is hidden and a "Demo data · read-only" banner is pinned |
| DRIVER | `(driver)` | Home, emergency contact, history, settings |
| ADMIN | `(admin)` | Devices, health, demo |

## Structure (§4.2)

```
app/
  _layout.tsx                 Paper, QueryClient, AuthGate, SocketProvider,
                              NotificationBridge, EmergencyWatcher
  (auth)/welcome|login|register
  (owner)/_layout|index|insights|settings
  (owner)/bikes/index|add|[id]/index|[id]/assign|[id]/config
  (owner)/incidents/index|[id]
  (driver)/_layout|index|contact|history|settings
  (admin)/_layout|devices|health|demo
  emergency/[incidentId].tsx  full-screen modal
src/
  api/client.ts               fetch wrapper, refresh-once, §5.4.1 error mapping
  api/hooks/                  useAuth, useBikes, useIncidents, useEmergencyResponse
  realtime/socket.ts          §5.5 events → query invalidation
  notifications/              channels emergency/security/info, tap handling
  stores/                     auth, realtime (clock offset), emergency
  components/                 FreshnessBadge, NotificationStateChip, CallButtons,
                              LeafletMap, KpiCard, StatusDot, IncidentTimeline,
                              PhotoPanel, DeviceHealthCard, AuthGate, …
  i18n/{en,si,ta}.json        en complete; si/ta carry the emergency strings
  theme/
```

## Notes and limits

- **Maps** are Leaflet in a WebView over OpenStreetMap tiles. No API key. The OSM
  attribution is required by their tile policy and is not removed.
- **Notifications** are local, raised from socket events. FCM is out of the MVP
  (M7); the channels and tap handling are already FCM-shaped, so adding it later
  is a token registration rather than a rewrite.
- **Insights** reads the §5.4.7 endpoints (`/analytics/*`, `/owners/me/dashboard`)
  with a 7 / 14 / 30-day switch. Categorical charts are horizontal bars so long
  "Possible …" labels are never truncated on a 6-inch screen; the daily chart
  sizes its bars from the measured width and thins its labels to ~6. Every chart
  has an empty state that says what will appear and what produces it.
- **Black box** on incident detail draws `sensorWindow` as four aligned panels
  (acceleration, rotation, tilt, speed) on one shared time axis, labelled
  relative to the event. Separate y scales, because the four units differ by
  two orders of magnitude.
- **Riding vs parked** time is on bike detail. Time before the bike's first
  ignition report is shown as "not reporting", never counted as parked.
- **Password reset** does not exist (M11). The login screen says so rather than
  offering a dead button.
- **si/ta translations** need a native speaker to verify before the demo
  (Appendix D).
