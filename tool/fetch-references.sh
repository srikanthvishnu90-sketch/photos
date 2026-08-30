#!/usr/bin/env bash
# fetch-references — pull LICENSED real photos (Pexels or Unsplash) for a search
# query and load them straight into a style pack's reference library. Real,
# free-to-use photos are the right conditioning source; AI renders teach the fake
# look and are never used.
#
# Usage:
#   tool/fetch-references.sh <packId> "<search query>" [count] [--realism]
#
#   tool/fetch-references.sh dubai        "dubai marina skyline luxury" 80
#   tool/fetch-references.sh beach-club   "mediterranean beach club daybed" 80
#   tool/fetch-references.sh luxury-cars  "supercar city street" 80
#   tool/fetch-references.sh _  "candid iphone snapshot people street" 60 --realism
#
# Needs ONE free API key in the environment (either works; Pexels is the fastest
# to get — instant, no review — at https://www.pexels.com/api/):
#   export PEXELS_API_KEY=...           # https://www.pexels.com/api/
#   export UNSPLASH_ACCESS_KEY=...      # https://unsplash.com/developers
set -uo pipefail

PACK="${1:-}"; QUERY="${2:-}"; COUNT="${3:-80}"; MODE="${4:-}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$PACK" ] || [ -z "$QUERY" ]; then
  echo "usage: $0 <packId> \"<search query>\" [count] [--realism]" >&2
  exit 1
fi
case "$COUNT" in ''|*[!0-9]*) echo "count must be a number" >&2; exit 1;; esac

command -v python3 >/dev/null 2>&1 || { echo "needs python3"; exit 1; }
command -v curl    >/dev/null 2>&1 || { echo "needs curl"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/imgs"; mkdir -p "$OUT"

fetch_pexels() {
  local page=1 got=0 per=80
  while [ "$got" -lt "$COUNT" ]; do
    local resp; resp="$(curl -s -H "Authorization: $PEXELS_API_KEY" \
      "https://api.pexels.com/v1/search?query=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$QUERY")&per_page=$per&page=$page")"
    # Extract the large image URLs.
    local urls; urls="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for p in d.get("photos",[]):
    u=(p.get("src") or {}).get("large2x") or (p.get("src") or {}).get("large")
    if u: print(u)
')"
    [ -z "$urls" ] && break
    while IFS= read -r u; do
      [ "$got" -ge "$COUNT" ] && break
      got=$((got+1))
      curl -s -L "$u" -o "$OUT/pexels-$page-$got.jpg" && echo "  fetched pexels-$page-$got"
    done <<< "$urls"
    page=$((page+1))
    [ "$page" -gt 25 ] && break
  done
}

fetch_unsplash() {
  local page=1 got=0 per=30
  while [ "$got" -lt "$COUNT" ]; do
    local resp; resp="$(curl -s -H "Authorization: Client-ID $UNSPLASH_ACCESS_KEY" \
      "https://api.unsplash.com/search/photos?query=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$QUERY")&per_page=$per&page=$page&orientation=portrait")"
    local urls; urls="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for r in d.get("results",[]):
    u=(r.get("urls") or {}).get("regular")
    if u: print(u)
')"
    [ -z "$urls" ] && break
    while IFS= read -r u; do
      [ "$got" -ge "$COUNT" ] && break
      got=$((got+1))
      curl -s -L "$u" -o "$OUT/unsplash-$page-$got.jpg" && echo "  fetched unsplash-$page-$got"
    done <<< "$urls"
    page=$((page+1))
    [ "$page" -gt 34 ] && break
  done
}

echo ">> fetching up to $COUNT licensed photos for: \"$QUERY\""
if [ -n "${PEXELS_API_KEY:-}" ]; then
  echo "   source: Pexels"; fetch_pexels
elif [ -n "${UNSPLASH_ACCESS_KEY:-}" ]; then
  echo "   source: Unsplash"; fetch_unsplash
else
  cat >&2 <<'EOF'
No API key found. Set one (either works; Pexels is instant to get):
  export PEXELS_API_KEY=...       # https://www.pexels.com/api/
  export UNSPLASH_ACCESS_KEY=...  # https://unsplash.com/developers
EOF
  exit 1
fi

n="$(find "$OUT" -type f -name '*.jpg' | wc -l | tr -d ' ')"
echo ">> downloaded $n photos → importing into the '$PACK' library"
[ "$n" -eq 0 ] && { echo "nothing downloaded (bad key or no results)"; exit 1; }

if [ "$MODE" = "--realism" ]; then
  bash "$DIR/import-pack-references.sh" "$PACK" "$OUT" --realism
else
  bash "$DIR/import-pack-references.sh" "$PACK" "$OUT"
fi
