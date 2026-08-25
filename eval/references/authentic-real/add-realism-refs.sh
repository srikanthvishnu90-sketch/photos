#!/usr/bin/env bash
# Add more real photos to the GLOBAL realism reference set.
#
# These are attached as QUALITY-ONLY references on every scene generation, so the
# output inherits real amateur-iPhone imperfection (grain, exposure, haze). Use
# genuine, imperfect phone photos — underexposed, harsh-lit, hazy, noisy — NOT
# polished shots. The generate-scene function auto-picks up whatever is in the
# folder; no redeploy needed.
#
# Usage (from anywhere):
#   ./eval/references/authentic-real/add-realism-refs.sh photo1.jpg photo2.png ...
#
# Requires: supabase CLI + sips (macOS). Uploads to inspiration/_global/realism/.
set -euo pipefail

PROJECT_REF="hkwkxacvcgorhthwyslx"
PREFIX="_global/realism"
# Resolve the gems-app project root (two levels up from this script's dir).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <image> [image ...]" >&2
  exit 1
fi

cd "$ROOT"
supabase link --project-ref "$PROJECT_REF" >/dev/null 2>&1 || true

n=0
for src in "$@"; do
  if [ ! -f "$src" ]; then echo "skip (not found): $src" >&2; continue; fi
  n=$((n+1))
  # Unique, collision-proof name (timestamp + counter).
  name="realism-$(date +%s)-$n.jpg"
  sips -Z 1280 -s format jpeg -s formatOptions 80 "$src" --out "$TMP/$name" >/dev/null 2>&1
  supabase storage cp "$TMP/$name" "ss:///inspiration/$PREFIX/$name" --linked --experimental >/dev/null
  echo "uploaded: $PREFIX/$name  (from $src)"
done

echo "---"
echo "Global realism set now contains:"
supabase storage ls "ss:///inspiration/$PREFIX" --linked --experimental -r 2>/dev/null \
  | tr ',' '\n' | grep -o '/inspiration/'"$PREFIX"'/[^"]*' || true
