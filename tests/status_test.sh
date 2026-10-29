#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/module/service.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/filehider-status.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

fail() {
    echo "status test failed: $*" >&2
    exit 1
}

mkdir -p "${TMP}/fakebin" "${TMP}/emptybin"
cat > "${TMP}/fakebin/magisk" <<'EOF'
#!/bin/sh
[ "$1" = "--sqlite" ] && echo 1
EOF
chmod 0755 "${TMP}/fakebin/magisk"

setup_case() {
    local name="$1"
    local dir="${TMP}/${name}"
    mkdir -p "${dir}/zygisk"
    for so in arm64-v8a armeabi-v7a x86_64 x86; do
        : > "${dir}/zygisk/${so}.so"
    done
    cat > "${dir}/module.prop.bak" <<'EOF'
id=filehider
name=File Hider
version=v3.2
versionCode=32
author=yeasin
description=Base description.
EOF
    printf '%s\n' "${dir}"
}

run_once() {
    local dir="$1"
    FILEHIDER_MODDIR="${dir}" \
    FILEHIDER_DEVICE_ABI=arm64 \
    ZYGISK_ENABLED=1 \
    sh "${SCRIPT}"
}

run_once_magisk() {
    local dir="$1"
    FILEHIDER_MODDIR="${dir}" \
    FILEHIDER_DEVICE_ABI=arm64 \
    ZYGISK_ENABLED= \
    PATH="${TMP}/fakebin:${PATH}" \
    sh "${SCRIPT}"
}

run_once_noprovider() {
    local dir="$1"
    FILEHIDER_MODDIR="${dir}" \
    FILEHIDER_DEVICE_ABI=arm64 \
    ZYGISK_ENABLED= \
    PATH="${TMP}/emptybin:${PATH}" \
    sh "${SCRIPT}"
}

description() {
    sed -n 's/^description=//p' "$1/module.prop"
}

expect_desc() {
    local dir="$1"
    local expected="$2"
    local actual
    actual="$(description "${dir}")"
    [ "${actual}" = "${expected}" ] || fail "expected '${expected}' got '${actual}'"
}

# Normal boot: module, provider, and the device ABI library are present.
dir="$(setup_case active)"
run_once "${dir}"
expect_desc "${dir}" '[✅ FileHider v3.2 · active · arm64] Base description.'

# Magisk's built-in Zygisk is detected through magisk --sqlite.
dir="$(setup_case magisk)"
run_once_magisk "${dir}"
expect_desc "${dir}" '[✅ FileHider v3.2 · active · arm64] Base description.'

# No known provider is a boot-time Zygisk failure.
dir="$(setup_case noprovider)"
run_once_noprovider "${dir}"
expect_desc "${dir}" '[❌ FileHider v3.2 · Zygisk not enabled] Base description.'

# A module disable marker is reported as not working when the script can run.
dir="$(setup_case disabled)"
: > "${dir}/disable"
run_once "${dir}"
expect_desc "${dir}" '[❌ FileHider v3.2 · not working] Base description.'

# A missing ABI library is a boot-time failure, not an active module.
dir="$(setup_case missinglib)"
rm -f "${dir}/zygisk/arm64-v8a.so"
run_once "${dir}"
expect_desc "${dir}" '[❌ FileHider v3.2 · not working] Base description.'

# Unknown ABI cannot be called active.
dir="$(setup_case unknownabi)"
FILEHIDER_MODDIR="${dir}" \
FILEHIDER_DEVICE_ABI=unknown \
ZYGISK_ENABLED=1 \
sh "${SCRIPT}"
expect_desc "${dir}" '[❌ FileHider v3.2 · not working] Base description.'

# An old v2.4 status prefix in the backup is stripped before the new status.
dir="$(setup_case legacy)"
sed -i 's/^description=.*/description=[✅ FileHider v2.4 · arm64: working] Base description./' \
    "${dir}/module.prop.bak"
run_once "${dir}"
expect_desc "${dir}" '[✅ FileHider v3.2 · active · arm64] Base description.'

# Re-running must never duplicate the status prefix or description line.
dir="$(setup_case rerun)"
run_once "${dir}"
run_once "${dir}"
expect_desc "${dir}" '[✅ FileHider v3.2 · active · arm64] Base description.'
[ "$(grep -c '^description=' "${dir}/module.prop")" -eq 1 ] || fail "description line duplicated"

# The boot reporter must exit immediately and leave no watcher files.
dir="$(setup_case nowatcher)"
run_once "${dir}"
[ ! -e "${dir}/status.pid" ] || fail "status.pid should not be created"
[ ! -e "${dir}/status.logcat" ] || fail "status.logcat should not be created"

echo "status tests passed"
