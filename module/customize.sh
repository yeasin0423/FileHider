SKIPMOUNT=false
PROPFILE=false
POSTFSDATA=true
LATESTARTSERVICE=true

ui_print " "
ui_print "  FileHider"
ui_print "  per-app hiding for any app"
ui_print " "

STORE=/data/adb/filehider/targets.conf

mkdir -p /data/adb/filehider

# The persistent file is the only config. Keep an existing one untouched so
# module updates cannot overwrite the user's rules.
if [ ! -f "$STORE" ]; then
    if [ -f /data/adb/modules/filehider/targets.conf ]; then
        cp -f /data/adb/modules/filehider/targets.conf "$STORE"
    elif [ -f /data/adb/ap/modules/filehider/targets.conf ]; then
        cp -f /data/adb/ap/modules/filehider/targets.conf "$STORE"
    elif [ -f "$MODPATH/targets.conf" ]; then
        cp -f "$MODPATH/targets.conf" "$STORE"
    fi
fi

# First install: seed the file with the format guide. The guide is generated
# here instead of being shipped as a second config file.
if [ ! -f "$STORE" ]; then
    cat > "$STORE" <<'EOF'
# FileHider rules
#
# This is the only configuration file. It lives outside the module directory,
# so it survives module updates.
#
# Format:  <package>  <absolute path>
# One rule per line. '#' starts a comment.
# A directory rule also hides everything below it.
#
# Inactive app: put !<package> on its own line. The app's path lines stay in
# this file but no hooks are installed for that package until the marker is
# removed. The marker may appear before or after the paths.
#
# Examples:
# com.example.detector	/system/build.prop
# com.example.detector	/system/xbin
# com.example.detector	/vendor/build.prop
# !com.example.other
# com.example.other	/proc/cpuinfo
#
# The WebUI writes this file for you. Rules apply per process, including
# ":remote" processes of the listed package.
#
# Shared storage: use /storage/emulated/0/... (what apps see). Rules for
# /data/media/0/..., /sdcard/..., and /storage/self/primary/... are expanded to
# the same common aliases automatically. Per-app only: there is no wildcard.
EOF
fi

# Older releases also kept a copy in the module directory. v1.0.6+ ignores it,
# so remove the old copies after the persistent file is available.
if [ -f "$STORE" ]; then
    rm -f "$MODPATH/targets.conf" "$MODPATH/config.example.conf"
    rm -f /data/adb/modules/filehider/targets.conf
    rm -f /data/adb/modules/filehider/config.example.conf
    rm -f /data/adb/ap/modules/filehider/targets.conf
    rm -f /data/adb/ap/modules/filehider/config.example.conf
fi

if command -v set_perm_recursive >/dev/null 2>&1; then
    set_perm_recursive "$MODPATH" 0 0 0755 0644
    set_perm "$MODPATH/post-fs-data.sh" 0 0 0755
    set_perm "$MODPATH/service.sh" 0 0 0755
else
    find "$MODPATH" -type d -exec chmod 0755 {} +
    find "$MODPATH" -type f -exec chmod 0644 {} +
    chmod 0755 "$MODPATH/customize.sh" "$MODPATH/post-fs-data.sh" "$MODPATH/service.sh" "$MODPATH/uninstall.sh"
fi

# Keep a clean copy of module.prop. post-fs-data.sh restores it at boot and
# service.sh reads it before adding the module-list status prefix.
cp -f "$MODPATH/module.prop" "$MODPATH/module.prop.bak"
chmod 0644 "$MODPATH/module.prop.bak" 2>/dev/null

chmod 0644 "$STORE" 2>/dev/null
if command -v chcon >/dev/null 2>&1; then
    chcon u:object_r:system_file:s0 "$STORE" 2>/dev/null
fi

ui_print "- Config: $STORE"
ui_print "- Open the module WebUI in KernelSU/APatch to choose apps and paths."
ui_print "- Reboot once after the first install."
