#!/usr/bin/env bash
# §5.8.2 step 11 - nightly pg_dump, keep 7 (cron: 0 2 * * *).
set -euo pipefail
cd /opt/crashlink/deploy

# TODO(spec): §5.8.2 uses $POSTGRES_USER/$POSTGRES_DB without sourcing anything,
# which fails under `set -u` in a cron environment. Loading ../.env first keeps
# the documented behaviour and makes the first unattended run actually work.
set -a
# shellcheck disable=SC1091
source ../.env
set +a

mkdir -p ../backups

TS=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file ../.env exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > ../backups/db-$TS.dump
ls -1t ../backups/db-*.dump | tail -n +8 | xargs -r rm --
