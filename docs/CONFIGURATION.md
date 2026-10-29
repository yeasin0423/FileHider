# Configuration

FileHider has exactly one rule file:

```text
/data/adb/filehider/targets.conf
```

It lives outside the module directory, so module updates do not overwrite your
rules. The WebUI reads and writes the same file. There is no module-local copy
and no fallback list.

## Format

```text
# <package> <absolute path>
com.example.detector	/system/build.prop
com.example.detector	/system/xbin
com.example.other	/vendor/lib/libsecret.so

# Keep this app's paths but install no hooks for it.
!com.example.other
```

Rules are whitespace-separated. `#` starts a comment. Paths must be absolute;
trailing slashes are ignored. A directory rule hides the directory and
everything below it.

There is no wildcard package. A process has to match the package name exactly
or be one of its subprocesses (`com.example.detector:worker`).

## Inactive apps

A line containing only `!<package>` marks that app inactive. Its path lines
stay in the file, but the native parser returns no rules for that package.
The marker may appear before or after the paths.

This is how the WebUI keeps an app's paths when its active checkbox is off.
Turning the app back on removes the marker without re-entering paths.

## Shared-storage aliases

These names resolve to the same hidden file:

```text
/data/media/<user>/...
/storage/emulated/<user>/...
/mnt/user/<user>/primary/...
/sdcard/...                 # user 0
/storage/self/primary/...
```

The WebUI saves the app-visible `/storage/emulated/...` form. The native
matcher expands the aliases, so a rule for one name hides the file under the
others as well. An arbitrary symlink or bind mount is not included unless that
exact path is also listed.

## Applying changes

Rules are read when a target process starts. After saving:

1. Force-stop the target app.
2. Reopen it.
3. Check `adb logcat -s FileHider` if it still sees the path.

The WebUI's **Save & force-stop** action does this for you.

## WebUI

The WebUI is served by KernelSU or APatch from the module's static
`module/webroot/` directory. Magisk has no module WebUI; edit the config file
directly there.

The home page is app-centric. Each row has:

- app icon, label, package name, and rule count
- an **active** checkbox
- a **not installed** badge when a configured package is missing

Open an app to edit its paths. The detail page provides:

- the absolute-path input
- **Browse** and **Internal storage**
- categorized common-path presets
- **Save** and **Save & force-stop**
- **Remove all** for that app only

### Presets

Common paths are grouped into:

- Integrity
- Root traces
- Emulator
- Native & maps
- System libraries
- Other
- Advanced sections for risky paths

Risky entries such as `/system/lib64`, `/system/lib`, `/proc/self/maps`, and
`/proc/self/mountinfo` require confirmation. All groups start collapsed and stay
expanded while editing the same app.

### Browser

The file browser lists folders with native `ls`, filters the current folder
without another shell call, and caches successful listings for the session.
The jump box is the only path display. **Go to up folder** lives in the header;
**Go**, **Refresh**, and **Close** are in the bottom action row.

A symlink shows its target from the listing. Tap it to test whether it is a
folder, use **↗** to resolve the canonical target on demand, and use **Add this
folder** to add both the visible path and the resolved target when they differ.

### Settings

Settings includes:

- Auto, Dark, and Light themes
- accent color
- app icon shape
- show/hide system apps
- config copy, export, import, and reload
- reset all rules with a `targets.conf.bak` backup
- logs

Export writes
`/data/media/0/Download/FileHider-targets-<timestamp>.conf`. Import accepts
pasted text or a file from the Android picker. Saves use a temporary file and a
byte-count check before replacing the config atomically.

### Logs

The **Logs** sheet shows the config contents, ABI, module info, the last 250
`FileHider` log lines, and a bounded WebUI activity log. Logs are
oldest-to-newest and scroll to the newest line. **Copy** falls back to a hidden
textarea on WebViews that block the clipboard API. **Save** writes
`/data/media/0/Download/FileHider-logs-<timestamp>.txt`. The left back arrow is
the only close control. The sheet does not erase device logcat; tap **Refresh**
to load the current logs again.

## Module-list status

The manager description carries a boot-time status prefix:

```text
[✅ FileHider v3.2 · active · arm64] Per-app file and folder hiding ...
```

| Status | Meaning |
| --- | --- |
| `[✅ ... active · arm64]` | Module enabled, a Zygisk provider is present, and the matching ABI library exists. |
| `[❌ ... Zygisk not enabled]` | No known Zygisk provider was detected. |
| `[❌ ... not working]` | Disable marker, unknown ABI, missing ABI library, or another boot check failure. |

`service.sh` runs once at late boot, writes `module.prop` atomically, and
exits. `module.prop.bak` keeps the clean description and is restored at every
boot, so the prefix cannot duplicate.

Provider detection checks `$ZYGISK_ENABLED`, Magisk's built-in Zygisk setting,
known provider module IDs (`zygisksu`, `rezygisk`, `zygisk_next`, `neozygisk`),
and enabled modules with a `zygisk/` directory. It is a boot-time heuristic,
not proof that a particular app was hooked.

## Permissions

The config should be readable by zygote:

```bash
adb shell su -c 'ls -lZ /data/adb/filehider/targets.conf'
# -rw-r--r-- ... u:object_r:system_file:s0 /data/adb/filehider/targets.conf
```

`post-fs-data.sh` enforces `0644` and the SELinux label at boot. The WebUI sets
the same label when it writes the file.
