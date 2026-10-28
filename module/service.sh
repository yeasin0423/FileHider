#!/system/bin/sh
# FileHider boot-time module status reporter.
#
# This script runs once at late boot, writes a compact status prefix into the
# manager's module description, then exits. It does not poll logcat, watch
# target apps, or keep a resident process.
#
# States:
#   active          module is enabled, a Zygisk provider is present, and the
#                   device ABI library exists
#   no-zygisk       no known Zygisk provider was detected
#   not-working     module disable marker, unknown ABI, missing ABI library, or
#                   another boot check failure

MODDIR=${FILEHIDER_MODDIR:-${0%/*}}
BASE="$MODDIR/module.prop.bak"
VERSION="v3.0"
DEVICE_ABI="unknown"
STATE="not-working"

device_abi() {
    abilist="$(getprop ro.system.product.cpu.abilist 2>/dev/null)"
    [ -n "$abilist" ] || abilist="$(getprop ro.product.cpu.abilist 2>/dev/null)"
    [ -n "$abilist" ] || abilist="$(getprop ro.product.cpu.abi 2>/dev/null)"
    case ",$abilist," in
        *,arm64-v8a,*) echo arm64 ;;
        *,armeabi-v7a,*) echo armv7 ;;
        *,x86_64,*) echo x86_64 ;;
        *,x86,*) echo x86 ;;
        *) echo unknown ;;
    esac
}

abi_library() {
    case "$1" in
        arm64) echo "arm64-v8a.so" ;;
        armv7) echo "armeabi-v7a.so" ;;
        x86_64) echo "x86_64.so" ;;
        x86) echo "x86.so" ;;
        *) echo "" ;;
    esac
}

provider_present() {
    case "${ZYGISK_ENABLED:-}" in
        ""|0|false|FALSE) ;;
        *) return 0 ;;
    esac

    # Magisk's built-in Zygisk has no separate module directory.
    magisk_bin=""
    if command -v magisk >/dev/null 2>&1; then
        magisk_bin="magisk"
    elif [ -x /data/adb/magisk/magisk ]; then
        magisk_bin="/data/adb/magisk/magisk"
    fi
    if [ -n "$magisk_bin" ]; then
        enabled="$("$magisk_bin" --sqlite "SELECT value FROM settings WHERE key='zygisk'" 2>/dev/null)"
        [ "$enabled" = "1" ] && return 0
    fi

    for root in /data/adb/modules /data/adb/ap/modules; do
        [ -d "$root" ] || continue
        for id in zygisksu rezygisk zygisk_next neozygisk; do
            dir="$root/$id"
            [ -d "$dir" ] && [ ! -e "$dir/disable" ] && return 0
        done
        for dir in "$root"/*; do
            [ -d "$dir" ] || continue
            [ "$dir" = "$MODDIR" ] && continue
            [ -d "$dir/zygisk" ] && [ ! -e "$dir/disable" ] && return 0
        done
    done
    return 1
}

base_description() {
    desc="$(sed -n 's/^description=//p' "$BASE" 2>/dev/null | head -n1)"
    case "$desc" in
        "[✅ FileHider "*|"[⏳ FileHider "*|"[❌ FileHider "*|"[⚠️ FileHider "*)
            desc="${desc#*] }"
            ;;
    esac
    [ -n "$desc" ] || desc="Per-app file and folder hiding for Java, native, and listing-based detection (Zygisk)."
    echo "$desc"
}

status_text() {
    case "$STATE" in
        active)
            if [ "$DEVICE_ABI" = "unknown" ]; then
                echo "[✅ FileHider $VERSION · active]"
            else
                echo "[✅ FileHider $VERSION · active · $DEVICE_ABI]"
            fi
            ;;
        no-zygisk)
            echo "[❌ FileHider $VERSION · Zygisk not enabled]"
            ;;
        *)
            echo "[❌ FileHider $VERSION · not working]"
            ;;
    esac
}

write_module_prop() {
    [ -f "$BASE" ] || return 0

    desc="$(base_description)"
    newdesc="$(status_text) $desc"

    tmp="$MODDIR/.module.prop.$$"
    seen=0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            description=*)
                printf 'description=%s\n' "$newdesc"
                seen=1
                ;;
            *)
                printf '%s\n' "$line"
                ;;
        esac
    done < "$BASE" > "$tmp" || { rm -f "$tmp"; return 1; }

    if [ "$seen" -eq 0 ]; then
        printf 'description=%s\n' "$newdesc" >> "$tmp"
    fi

    chmod 0644 "$tmp" 2>/dev/null
    if command -v chcon >/dev/null 2>&1; then
        chcon u:object_r:system_file:s0 "$tmp" 2>/dev/null
    fi
    if mv -f "$tmp" "$MODDIR/module.prop"; then
        return 0
    fi
    rm -f "$tmp"
    return 1
}

init_status() {
    if [ ! -f "$BASE" ]; then
        if [ -f "$MODDIR/module.prop" ]; then
            cp -f "$MODDIR/module.prop" "$BASE" 2>/dev/null || BASE="$MODDIR/module.prop"
        fi
    fi
    VERSION="$(sed -n 's/^version=//p' "$BASE" 2>/dev/null | head -n1)"
    [ -n "$VERSION" ] || VERSION="v3.0"
    DEVICE_ABI="${FILEHIDER_DEVICE_ABI:-$(device_abi)}"
    lib="$(abi_library "$DEVICE_ABI")"

    if [ -e "$MODDIR/disable" ]; then
        STATE="not-working"
    elif ! provider_present; then
        STATE="no-zygisk"
    elif [ -z "$lib" ] || [ ! -f "$MODDIR/zygisk/$lib" ]; then
        STATE="not-working"
    else
        STATE="active"
    fi
}

init_status
write_module_prop
exit 0
