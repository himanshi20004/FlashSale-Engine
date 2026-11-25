#!/usr/bin/env bash
# Chaos test: kill Redis primary + restart backend mid-load, then verify zero oversell.
set -uo pipefail
cd "$(dirname "$0")/.."
export HOLD_TTL_SEC=${HOLD_TTL_SEC:-20}
docker compose up -d --build mongo redis redis-bus backend
sleep 8
docker compose --profile load run --rm -e HOLD_FOR=70s k6 &
K6=$!
sleep 25; echo ">>> CHAOS 1: kill Redis (state lost)"; docker compose kill redis; sleep 4; docker compose start redis
sleep 15; echo ">>> CHAOS 2: restart backend"; docker compose restart backend
sleep 15; echo ">>> CHAOS 3: kill Redis again"; docker compose kill redis; sleep 2; docker compose start redis
wait $K6
./scripts/verify.sh drop-1
