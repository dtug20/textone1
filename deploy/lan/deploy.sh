#!/usr/bin/env bash
# Build the LAN context locally, sync it to the GPU host and restart only the
# TexTone containers. `.env` and the model cache on the host are never touched.
set -euo pipefail
HOST="${TEXTONE_LAN_HOST:-atin-tts@192.168.1.198}"
DIR="${TEXTONE_LAN_DIR:-/home/atin-tts/dang/tung/textone-lan}"
KEY="${TEXTONE_LAN_KEY:-$HOME/.ssh/id_ed25519_textone_lan}"
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes)
root="$(cd "$(dirname "$0")/../.." && pwd)"
build="/tmp/textone-lan-build"

rm -rf "$build"
python3 "$root/deploy/lan/build_context.py" "$build"
"${SSH[@]}" "$HOST" "mkdir -p '$DIR' && test -f '$DIR/.env' || echo 'WARNING: $DIR/.env is missing; create it as described in deploy/lan/README.md'"
rsync -az --delete --exclude .env --exclude models/ -e "ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes" "$build/" "$HOST:$DIR/"
"${SSH[@]}" "$HOST" "cd '$DIR' && docker compose build && docker compose up -d && docker compose ps"
