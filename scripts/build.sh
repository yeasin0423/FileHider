#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

export PATH="${HOME}/.local/bin:${PATH}"

NDK="${ANDROID_NDK_HOME:-${ROOT}/.toolchain/android-ndk}"
if [ ! -f "${NDK}/build/cmake/android.toolchain.cmake" ]; then
    echo "NDK not found at ${NDK}." >&2
    echo "Run ./scripts/bootstrap-ndk.sh first, or export ANDROID_NDK_HOME." >&2
    exit 1
fi

CMAKE="${CMAKE:-cmake}"
NINJA="${NINJA:-ninja}"
if ! command -v "${CMAKE}" >/dev/null 2>&1; then
    echo "cmake not found. Install it (pip3 install --user cmake ninja) or set CMAKE." >&2
    exit 1
fi

ABIS="${ABIS:-arm64-v8a armeabi-v7a x86_64 x86}"
MIN_API="${MIN_API:-24}"
STRIP="${NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"

VERSION="$(sed -n 's/^version=//p' module/module.prop | head -n1)"
VERSION="${VERSION:-v0.0.0}"

rm -rf build stage
mkdir -p stage dist

for abi in ${ABIS}; do
    echo "==> building ${abi}"
    "${CMAKE}" -S zygisk -B "build/${abi}" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE="${NDK}/build/cmake/android.toolchain.cmake" \
        -DANDROID_ABI="${abi}" \
        -DANDROID_PLATFORM="android-${MIN_API}" \
        -DANDROID_STL=c++_static \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_MAKE_PROGRAM="$(command -v "${NINJA}")" >/dev/null
    "${CMAKE}" --build "build/${abi}"

    mkdir -p stage/zygisk
    cp "build/${abi}/libfilehider.so" "stage/zygisk/${abi}.so"
    if [ -x "${STRIP}" ]; then
        "${STRIP}" --strip-unneeded "stage/zygisk/${abi}.so"
    fi
done

cp module/module.prop stage/
cp module/customize.sh stage/
cp module/post-fs-data.sh stage/
cp module/service.sh stage/
cp module/uninstall.sh stage/
chmod 0755 stage/customize.sh stage/post-fs-data.sh stage/service.sh stage/uninstall.sh
cp -r module/webroot stage/webroot

OUT="dist/FileHider-${VERSION}.zip"
rm -f "${OUT}"
(cd stage && zip -q -9 -r "../${OUT}" .)

echo
echo "Built ${OUT}"
./scripts/verify.sh "${OUT}"
