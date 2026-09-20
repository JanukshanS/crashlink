#!/usr/bin/env bash
# §5.8.2 step 12 - pull, rebuild the api service, verify health.
set -euo pipefail
cd /opt/crashlink && git pull --ff-only
cd deploy && docker compose --env-file ../.env up -d --build api
sleep 5 && curl -fsS http://127.0.0.1:3000/health
