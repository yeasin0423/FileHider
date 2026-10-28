#!/system/bin/sh
# The persistent config is the only source of rules. Ensure it stays readable
# by zygote after module updates or manual edits.
MODDIR=${0%/*}
CONF=/data/adb/filehider/targets.conf

# Remove the previous boot's module-list status before service.sh writes this
# boot's check. The backup is the clean description and never receives a prefix.
if [ -f "$MODDIR/module.prop.bak" ]; then
    cp -f "$MODDIR/module.prop.bak" "$MODDIR/module.prop"
    chmod 0644 "$MODDIR/module.prop" 2>/dev/null
fi

if [ -f "$CONF" ]; then
    chmod 0644 "$CONF" 2>/dev/null
    if command -v chcon >/dev/null 2>&1; then
        chcon u:object_r:system_file:s0 "$CONF" 2>/dev/null
    fi
fi
