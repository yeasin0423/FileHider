#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

mkdir -p build
g++ -std=c++17 -O2 -Wall -Wextra -I zygisk/src \
    zygisk/src/matcher.cpp tests/matcher_test.cpp \
    -o build/matcher_test

./build/matcher_test
echo "matcher tests passed"

sh -n module/customize.sh
sh -n module/post-fs-data.sh
sh -n module/service.sh
sh -n module/uninstall.sh
bash -n scripts/bootstrap-ndk.sh
bash -n scripts/build.sh
bash -n scripts/verify.sh
bash -n scripts/backup.sh
bash tests/status_test.sh
