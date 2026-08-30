#!/usr/bin/env bash
# Apply the generation-integrity backend migrations to the LIVE Gems database,
# in order, VERBATIM from the committed files (nothing retyped).
#
# Safety already verified against production (2026-08-30):
#   • New tables only add data (generation_jobs, generated_assets,
#     generation_attempts, generation_identity_evaluations, credit_reservations).
#   • projects kind/status constraints already allow every value the app writes
#     (scene/moodboard/dump, ready/draft); the one existing row passes.
#   • profiles + projects guard triggers only block plan changes / scene-project
#     edits by non-service roles — no client path does either.
#   • inspiration_assets is empty, so its new constraints validate trivially.
# Each migration runs in a single transaction: a failure changes nothing.
#
# Run it yourself (you own the production change):
#   ! bash supabase/apply-generation-integrity.sh
set -euo pipefail

REF="hkwkxacvcgorhthwyslx"
PAT="$(cat "$HOME/.supabase/access-token")"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/migrations"

apply() {
  local file="$1"
  echo ">> applying $(basename "$file")"
  local body
  body="$(python3 -c "import json,sys;print(json.dumps({'query':open(sys.argv[1]).read()}))" "$file")"
  local resp
  resp="$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" --data "$body")"
  # A successful DDL batch returns [] or an object; an error returns {"message":...}.
  if echo "$resp" | grep -q '"message"'; then
    echo "!! FAILED: $resp"
    exit 1
  fi
  echo "   ok"
}

apply "$DIR/20260828000000_generation_integrity_v1.sql"
apply "$DIR/20260828005000_generation_recovery_transition.sql"
echo "== both migrations applied. =="
