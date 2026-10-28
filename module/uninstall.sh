#!/system/bin/sh
MODDIR=${0%/*}
# v2.4 shipped a logcat watcher. Remove its leftovers if this is an upgrade.
rm -f "$MODDIR/status.pid" "$MODDIR/status.logcat"
rm -rf /data/adb/filehider
