#!/usr/bin/env bash
# import-pack-references — bulk-import HUNDREDS of real reference photos into a
# style pack's global reference library, so generate-scene can recreate a real
# image ~90% (the founder's "reference library per style" quality strategy)
# instead of imagining the scene from a prompt.
#
# Images land in the private `inspiration` bucket under _global/packs/<packId>/
# (or _global/realism for the global capture-quality set). generate-scene lists
# up to 1000 per pack and picks one per generated image via environmentRef.
#
# Usage:
#   tool/import-pack-references.sh <packId> <folder-of-images> [--realism]
#
#   tool/import-pack-references.sh dubai ~/refs/dubai-luxe
#   tool/import-pack-references.sh boat  ~/refs/boat-day
#   tool/import-pack-references.sh _  ~/refs/real-iphone-photos --realism
#
# Valid packs: euro-summer, dubai, old-money, luxury-cars, beach-club, boat,
# dark-luxe, after-dark. Use --realism for the global capture-quality set.
#
# Safe + resumable: images already uploaded (by name) are SKIPPED, so you can
# re-run after adding more. AI renders (files with 'render' in the name) are
# excluded — references must be REAL photos. Uploads run in parallel.
set -uo pipefail

REF="hkwkxacvcgorhthwyslx"
MAX_DIM="${GEMS_REF_MAX_DIM:-1600}"   # longest edge, px
JPEG_Q="${GEMS_REF_JPEG_Q:-82}"
PARALLEL="${GEMS_REF_PARALLEL:-6}"

PACK="${1:-}"
SRC="${2:-}"
MODE="${3:-}"
if [ -z "$PACK" ] || [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: $0 <packId> <folder> [--realism]" >&2
  exit 1
fi

if [ "$MODE" = "--realism" ]; then
  PREFIX="_global/realism"
else
  PREFIX="_global/packs/$PACK"
fi

command -v sips >/dev/null 2>&1 || { echo "needs sips (macOS)"; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "needs supabase CLI"; exit 1; }
supabase link --project-ref "$REF" >/dev/null 2>&1 || true

# What's already there (skip-existing → resumable).
echo ">> reading existing references under inspiration/$PREFIX ..."
EXISTING="$(supabase storage ls "ss:///inspiration/$PREFIX/" --linked --experimental 2>/dev/null \
  | tr ',' '\n' | grep -oE '[^"/]+\.(jpg|jpeg|png|webp)' | sort -u || true)"
EXISTING_COUNT="$(printf '%s\n' "$EXISTING" | grep -c . || true)"
echo "   already present: ${EXISTING_COUNT:-0}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
MANIFEST="$TMP/manifest"; : > "$MANIFEST"   # NUL-separated source paths

# The destination name for a source path: basename, spaces→_, forced .jpg.
dest_name() { local b; b="$(basename "$1")"; printf '%s' "${b%.*}.jpg" | tr ' ' '_'; }

# Gather candidate images (recurse), skip AI renders + already-uploaded.
n_total=0; n_skip=0
while IFS= read -r -d '' src; do
  base="$(basename "$src")"
  case "$base" in *[Rr][Ee][Nn][Dd][Ee][Rr]*) continue ;; esac
  name="$(dest_name "$src")"
  n_total=$((n_total+1))
  if printf '%s\n' "$EXISTING" | grep -qxF "$name"; then
    n_skip=$((n_skip+1)); continue
  fi
  printf '%s\0' "$src" >> "$MANIFEST"
done < <(find "$SRC" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.heic' \) -print0)

n_new="$(tr -cd '\0' < "$MANIFEST" | wc -c | tr -d ' ')"
echo ">> $n_total images found · $n_skip already uploaded · ${n_new:-0} to import into $PREFIX"
[ "${n_new:-0}" -eq 0 ] && { echo "nothing to do."; exit 0; }

# Resize + upload in parallel. Worker re-derives the destination name from the
# source path (no fragile field-splitting), so paths with spaces are safe.
export REF PREFIX TMP MAX_DIM JPEG_Q
upload_one() {
  local src="$1" name out
  local b; b="$(basename "$src")"; name="$(printf '%s' "${b%.*}.jpg" | tr ' ' '_')"
  out="$TMP/$name"
  if ! sips -Z "$MAX_DIM" -s format jpeg -s formatOptions "$JPEG_Q" "$src" --out "$out" >/dev/null 2>&1; then
    echo "  skip (bad image): $src" >&2; return 0
  fi
  if supabase storage cp "$out" "ss:///inspiration/$PREFIX/$name" --linked --experimental >/dev/null 2>&1; then
    echo "  up: $name"
  else
    echo "  FAIL: $name" >&2
  fi
  rm -f "$out"
}
export -f upload_one

# NUL-delimited → xargs -0 -P for safe parallel dispatch.
xargs -0 -P "$PARALLEL" -I{} bash -c 'upload_one "$@"' _ {} < "$MANIFEST"

echo ">> done. Library now contains:"
supabase storage ls "ss:///inspiration/$PREFIX/" --linked --experimental 2>/dev/null \
  | tr ',' '\n' | grep -coE '[^"/]+\.(jpg|jpeg|png|webp)' || true
echo "   references under inspiration/$PREFIX"
