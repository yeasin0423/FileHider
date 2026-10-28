#!/usr/bin/env bash
# Verify the packaged flashable zip before it is uploaded or released.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

ZIP="${1:-}"
if [ -z "${ZIP}" ]; then
    ZIP="$(ls -1t dist/FileHider-*.zip 2>/dev/null | head -n1 || true)"
fi

if [ -z "${ZIP}" ] || [ ! -f "${ZIP}" ]; then
    echo "No FileHider zip found. Build first with ./scripts/build.sh." >&2
    exit 1
fi

NDK="${ANDROID_NDK_HOME:-${ROOT}/.toolchain/android-ndk}"
TOOLBIN="${NDK}/toolchains/llvm/prebuilt/linux-x86_64/bin"
NM="${TOOLBIN}/llvm-nm"
READELF="${TOOLBIN}/llvm-readelf"

if [ ! -x "${NM}" ] || [ ! -x "${READELF}" ]; then
    echo "NDK tools not found under ${TOOLBIN}." >&2
    echo "Run ./scripts/bootstrap-ndk.sh first, or export ANDROID_NDK_HOME." >&2
    exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/filehider-verify.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

fail() {
    echo "verify failed: $*" >&2
    exit 1
}

require_entry() {
    printf '%s\n' "${ENTRIES}" | grep -Fxq "$1" || fail "missing zip entry: $1"
}

echo "==> checking zip integrity"
unzip -tq "${ZIP}" >/dev/null || fail "zip is corrupt"

ENTRIES="$(unzip -Z1 "${ZIP}")"

for file in \
    module.prop \
    customize.sh \
    post-fs-data.sh \
    service.sh \
    uninstall.sh \
    webroot/index.html; do
    require_entry "${file}"
done

for file in module/webroot/assets/css/*.css module/webroot/assets/js/*.js; do
    [ -f "${file}" ] || fail "missing WebUI source: ${file}"
    require_entry "${file#module/}"
done

for abi in arm64-v8a armeabi-v7a x86_64 x86; do
    require_entry "zygisk/${abi}.so"
done

if printf '%s\n' "${ENTRIES}" | grep -Eq '(^|/)(targets\.conf|config\.example\.conf|module\.prop\.bak|status\.pid|status\.logcat)$'; then
    fail "zip contains a local-only or user-config file"
fi

if ! zipinfo -l "${ZIP}" service.sh | grep -q '^-rwx'; then
    fail "service.sh is not executable in the zip"
fi

echo "==> checking zygisk entry points"
for abi in arm64-v8a armeabi-v7a x86_64 x86; do
    unzip -p "${ZIP}" "zygisk/${abi}.so" > "${TMP}/${abi}.so"
    "${NM}" -D --defined-only "${TMP}/${abi}.so" | grep -q 'zygisk_module_entry' \
        || fail "zygisk/${abi}.so is missing zygisk_module_entry"
done

echo "==> checking arm64 16 KB page alignment"
ALIGN="$("${READELF}" -l "${TMP}/arm64-v8a.so" | awk '/LOAD/{print $NF; exit}')"
[ "${ALIGN}" = "0x4000" ] || fail "arm64 LOAD alignment is ${ALIGN}, expected 0x4000"

echo
echo "Verified: ${ZIP}"
echo "Entries:  $(printf '%s\n' "${ENTRIES}" | wc -l)"
echo "Size:     $(du -h "${ZIP}" | cut -f1)"
echo "SHA-256:  $(sha256sum "${ZIP}" | cut -d' ' -f1)"
