#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="r30"
SHA1="5107f898313790e449e87eee2183d9a20602dee9"
URL="https://dl.google.com/android/repository/android-ndk-${VERSION}-linux.zip"
DEST="${ROOT}/.toolchain/android-ndk"
ZIP="${ROOT}/.toolchain/android-ndk-${VERSION}-linux.zip"

mkdir -p "${ROOT}/.toolchain"

if [ -f "${DEST}/build/cmake/android.toolchain.cmake" ]; then
    echo "NDK already present: ${DEST}"
    exit 0
fi

echo "Downloading Android NDK ${VERSION} (~738 MB)…"
curl -L --fail --progress-bar -o "${ZIP}" "${URL}"

echo "Verifying checksum…"
echo "${SHA1}  ${ZIP}" | sha1sum -c -

echo "Extracting…"
rm -rf "${ROOT}/.toolchain/android-ndk-${VERSION}"
unzip -q "${ZIP}" -d "${ROOT}/.toolchain"
mv "${ROOT}/.toolchain/android-ndk-${VERSION}" "${DEST}"
rm -f "${ZIP}"

echo "NDK ready: ${DEST}"
