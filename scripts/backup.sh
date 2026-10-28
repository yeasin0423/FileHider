#!/usr/bin/env bash
# Create a self-contained local backup of source, tests, docs, and dist.
# Atomic enough for load shedding: write a temp archive, move it into place,
# then record the checksum.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p backups

stamp="$(date +%Y%m%d-%H%M%S)"
out="backups/FileHider-${stamp}.tar.gz"
tmp="backups/.FileHider-${stamp}.tar.gz.tmp"

tar -czf "$tmp" \
    --exclude='./backups' \
    --exclude='./build' \
    --exclude='./stage' \
    --exclude='./.toolchain' \
    ./.github ./module ./zygisk ./scripts ./tests ./docs ./dist \
    ./README.md ./AGENTS.md ./CHANGELOG.md ./LICENSE \
    ./.editorconfig ./.gitattributes ./.gitignore

mv -f "$tmp" "$out"
sha256sum "$out" >> backups/SHA256SUMS
sync
echo "Backup: $out"
