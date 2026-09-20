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
