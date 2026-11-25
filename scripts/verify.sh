#!/usr/bin/env bash
# Prints the oversell invariant check for an item. Exit 1 if violated.
ITEM=${1:-drop-1}; BASE=${BASE:-http://localhost:8080}; ADMIN=${ADMIN_TOKEN:-admin-secret}
OUT=$(curl -s -H "x-admin-token: $ADMIN" "$BASE/admin/verify/$ITEM")
echo "$OUT"
echo "$OUT" | grep -q '"noOversell":true' || { echo "OVERSELL DETECTED"; exit 1; }
echo "$OUT" | grep -q '"ok":true' && echo "PASS: zero oversell, seats conserved" || echo "WARN: seats not conserved yet (holds may still be expiring) - rerun in HOLD_TTL_SEC"
