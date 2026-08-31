#!/usr/bin/env bash
# fetch-new-packs — fill the six new style-pack libraries with LICENSED photos.
#
#   export PEXELS_API_KEY=...        # free + instant: https://www.pexels.com/api/
#   tool/fetch-new-packs.sh              # all six packs
#   tool/fetch-new-packs.sh campus       # just one
#
# Several DIFFERENT queries per pack, deliberately. The reference research is
# clear that VARIETY beats raw count — 30-100 varied real photos per pack is
# plenty, and diminishing returns set in past ~150. Six near-identical shots of
# one location produce six near-identical generations, which is the batch
# flow's worst failure mode. Each query also gets its own run tag, so repeats
# add images instead of overwriting each other.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONLY="${1:-}"

run() { # pack, query, count
  [ -n "$ONLY" ] && [ "$ONLY" != "$1" ] && return 0
  echo "── $1 ← \"$2\""
  "$DIR/fetch-references.sh" "$1" "$2" "$3" || echo "   (failed, continuing)"
}

# Campus — the product already ships a College Commitment template with no pack
# behind it. Autumn light, brick and ivy, real student life in frame.
run campus "university campus quad autumn"        40
run campus "college library architecture ivy"     30
run campus "students walking campus path"         30
run campus "graduation cap gown ceremony"         20

# Game Day — the Studio template existed and misrouted to the commitment flow.
run game-day "college football stadium crowd"     40
run game-day "stadium floodlights night game"     30
run game-day "tailgate party parking lot"         25
run game-day "student section cheering"           25

# Alpine — the winter counterpart to euro-summer.
run alpine "ski resort chalet snow mountains"     40
run alpine "apres ski terrace alps"               30
run alpine "snowy mountain village timber"        30
run alpine "ski lift gondola snow"                20

# Tokyo Neon — the night-city counterpart to after-dark.
run tokyo-neon "tokyo street neon night"          40
run tokyo-neon "shibuya crossing night"           30
run tokyo-neon "japanese alley izakaya lanterns"  30
run tokyo-neon "wet street reflection neon signs" 20

# Marrakech — hard sun, deep shade, hand-made surfaces.
run marrakech "marrakech riad courtyard"          40
run marrakech "moroccan tilework architecture"    30
run marrakech "medina souk market morocco"        30
run marrakech "desert palm courtyard pool"        20

# Wellness — the largest current aesthetic in this demographic, and absent.
run wellness "pilates reformer studio"            35
run wellness "matcha ceramic minimal kitchen"     30
run wellness "neutral linen bedroom morning light" 30
run wellness "healthy breakfast bowl daylight"    25

echo
echo "Done. Register + measure them:"
echo "  curl -s -X POST \"https://hkwkxacvcgorhthwyslx.supabase.co/functions/v1/build-shot-specs\" \\"
echo "    -H \"authorization: Bearer \$SUPABASE_SERVICE_ROLE_KEY\" \\"
echo "    -H 'content-type: application/json' -d '{\"sync\":true,\"limit\":50}'"
echo "  (repeat until remaining reaches 0)"
