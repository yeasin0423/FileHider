# AGENTS.md

Guidance for agents working on this repository. Read this before changing code.

## What this is

A Magisk / KernelSU / APatch **Zygisk** module that hides chosen absolute paths
from chosen apps, per app. It is a native C++ module (no Gradle, no Android
Studio) plus a static multi-file WebUI.

Hard requirements (do not regress):

- **Per-app only.** No global mode, no wildcard package. A process must match a
  rule package; `system_server` must never be hooked.
- **App-agnostic inside a selected app.** The user should not need to know how an
  app inspects files. Cover Java/`libcore`, native callers, `stat`/`open`/
  `access`, directory listings, and literal paths in shell child commands.
  Every ABI must fall back to scoped PLT hooks if its inline engine fails.
- Hiding means "invisible": `stat`/`access`/`open` return `ENOENT`, the entry
  is removed from `getdents64`/`readdir` output, and a literal hidden path in a
  child command becomes a missing decoy path.
- Common shared-storage names must stay aliased:
  `/data/media/<n>/...`, `/storage/emulated/<n>/...`,
  `/mnt/user/<n>/primary/...`, `/sdcard/...` (user 0), and
  `/storage/self/primary/...`.
- Support **arm64-v8a, armeabi-v7a, x86_64, x86**.
- Keep all generated artifacts inside the repo (`build/`, `stage/`, `dist/`).
- Keep `README.md` and this file current when behavior changes.

## Verified commands

```bash
./scripts/test.sh          # host matcher + shell/status tests, no NDK needed
./scripts/bootstrap-ndk.sh # NDK r30, SHA1 5107f898313790e449e87eee2183d9a20602dee9
./scripts/build.sh         # all 4 ABIs + verify + dist/FileHider-<version>.zip
./scripts/verify.sh dist/FileHider-<version>.zip
```

`cmake` and `ninja` may only exist in `~/.local/bin` (installed with
`pip3 install --user cmake ninja`). `scripts/build.sh` prepends that directory
to `PATH`.

Overrides: `ABIS="arm64-v8a x86_64"`, `MIN_API=26`,
`ANDROID_NDK_HOME=/path`. NDK lives at `.toolchain/android-ndk` (gitignored,
~2.3 GB).

## Layout

```
zygisk/src/main.cpp      Zygisk entry; reads config, matches nice_name, installs hooks
zygisk/src/matcher.*     pure C++ rule parsing and path matching (host-testable)
zygisk/src/config.*      persistent targets.conf loading
zygisk/src/hooks.*       all hook bodies and the inline/PLT installation engines
zygisk/CMakeLists.txt
zygisk/src/zygisk.hpp    vendored official Zygisk API v5 header
zygisk/third_party/shadowhook/  vendored ShadowHook 2.0.1 (arm/arm64)
zygisk/third_party/dobby/       vendored Dobby (x86/x86_64)
module/webroot/index.html           WebUI markup entry (no build step)
module/webroot/assets/css/          ordered stylesheets
module/webroot/assets/js/           ordered classic scripts
module/{module.prop,customize.sh,post-fs-data.sh,service.sh,uninstall.sh}
scripts/                 bootstrap/build/test/verify/backup
tests/matcher_test.cpp   host matcher tests
tests/status_test.sh     boot-time module-list status tests
docs/                    architecture/config/build/troubleshooting/limitations
backups/                 timestamped local source/backup archives
```

## Hook architecture

| ABI | Engine | Why |
| --- | --- | --- |
| arm64-v8a, armeabi-v7a | ShadowHook inline hooks on `libc.so`, scoped Zygisk PLT fallback | covers Java/native; fallback covers selected loaded ELF callers |
| x86_64, x86 | Dobby inline hooks on `libc.so`, scoped Zygisk PLT fallback | ShadowHook has no x86 backend; Dobby gives x86 the same all-caller coverage |

Never try to build ShadowHook sources for x86/x86_64 — there is no backend.
`CMakeLists.txt` only globs ShadowHook for `arm64-v8a` / `armeabi-v7a`, and only
builds Dobby for `x86` / `x86_64`. Dobby is statically linked (`dobby_static`)
and built with `EXCLUDE_FROM_ALL`; do not package its shared library.

The vendored Dobby is the pre-refactor source (the current upstream x86 headers
reference files removed in a later refactor). Its CMake is set to C++17 so
`inline` logging symbols do not collide, and the logging header uses true inline
definitions. Do not "update" Dobby casually without testing both x86 ABIs.

Static ShadowHook builds do **not** ship `libshadowhook_nothing.so`, which
`sh_linker_init()` needs for its dlopen monitor. `CMakeLists.txt` defines
`SH_CONFIG_NO_LINKER_MONITOR`; `shadowhook.c` then skips `sh_linker_init()` and
`sh_task_init()`. This is safe because only `libc.so` (already loaded) is hooked.
Do not remove that flag without packaging a loadable helper `.so`.

Hooked symbols: `stat`, `lstat`, `fstatat`, `statx`, `access`, `faccessat`,
`open`, `open64`, `__open_2`, `openat`, `openat64`, `__openat_2`, `fopen`,
`fopen64`, `opendir`, `readlink`, `readlinkat`, `getdents64`, `readdir`,
`readdir64`, `popen`, `execve`, `execv`, `execvp`.

Important details:

- `__open_2` and `__openat_2` are bionic's fortify wrappers for two-argument
  `open`/`openat`. NDK release builds compile those calls with
  `_FORTIFY_SOURCE=2`, so hooking only `open`/`openat` misses native JNI
  callers. Keep both wrappers in every engine and in the PLT symbol list.
- Hook originals are **per-symbol function pointers** (`real_stat`, ...). With
  ShadowHook and Dobby inline hooks they are trampolines and must be used;
  calling `::stat` would recurse because libc's prologue is patched. On the PLT
  fallback, originals come from `dlsym(RTLD_DEFAULT, ...)` because libc is not
  patched.
- Subprocess coverage is **text rewriting, not child injection**. `popen`
  rewrites its command string and `execve`/`execv`/`execvp` rewrite their path
  and argv to a deterministic `/.filehider_missing_<hash>` decoy. Only an exact
  hidden path on a path boundary is replaced; do not start substituting fake
  file contents. The child process is not hooked, so paths built only inside
  the child, globs, and raw syscalls bypass this. `note_hidden()` is called on
  a rewrite; the first rewrite in the app process (normally `popen`) logs
  `subprocess path rewrite active`. The forked `exec` child skips logging.
- **The exec hooks must stay vfork-safe.** Android's `ProcessBuilder` uses
  `vfork` on Linux. The exec path uses only stack (`alloca`) buffers, manual
  hex formatting, and no logging/malloc; do not replace it with
  `std::string`/`std::vector` or `__android_log_print`. Child detection is
  `getpid() != g_owner_pid`.
- `install_plt_hooks()` is compiled on every ABI. `main.cpp` tries the inline
  engine first on every ABI and falls back to PLT. `inline_hooks_active()`
  selects the right severity for self-test failures.
- Dobby hooks aliases by address (`open`/`open64`, `openat`/`openat64`,
  `fopen`/`fopen64`, `readdir`/`readdir64`) are deduplicated: the first symbol
  owns the trampoline, later aliases reuse it. Do not call `DobbyHook` twice on
  the same address.
- Dobby's `DobbyHook` can call back into libc while installing. Set the real
  pointer to the `dlsym` address before patching, then replace it with the
  returned trampoline. `g_active` stays false until all installation finishes.
- The PLT fallback is scoped and staged: only `libjavacore`, `libopenjdk`,
  `libart`, `libandroid_runtime`, `app_process`, and app-owned ELFs under
  `/data/app`, `/data/data`, `/data/user`, `/data/local/tmp` are registered
  (excluding `/data/adb`, `libfilehider.so`, and APK `!/` mappings). Do not
  restore the old all-ELF loop; it made Zygisk Next fail `pltHookCommit` on x86.
- `pltHookRegister` expects `dev_t` as `makedev(major, minor)` from
  `/proc/self/maps`; LSPlt parses maps the same way. Pass `nullptr` for
  `oldFunc` (originals come from `dlsym`), otherwise registrations for ELFs that
  do not import a symbol could null out a valid original.
- Set `g_active = true` only after installation finishes. Hooks are pass-through
  until then, which avoids recursion during installer work.
- arm installs both `getdents64` and `readdir`; double filtering is intentional
  and harmless because libc's `readdir` may call the patched `getdents64`.
- Set `DLCLOSE_MODULE_LIBRARY` on every process where no hooks were installed
  (no config, no rule match, `system_server`, bad args). This removes the module
  `.so` from maps/soinfo scans used by native detectors. Never request DLCLOSE
  after any hook installation attempt: a partially installed inline hook still
  points into the module and would crash after unloading.
- After a successful arm/arm64 inline install,
  `neutralize_shadowhook_maps()` scans `/proc/self/maps` for
  `[anon:shadowhook...]`. For executable maps it calls `mprotect(...,
  PROT_READ | PROT_EXEC)` and clears the VMA name for every ShadowHook map.
  This removes ShadowHook's RWX trampoline and name signature without touching
  mapping addresses, code, libc pages, or the mapped module. Run it before
  `g_active = true`, and ignore `mprotect`/`prctl` failures. Do **not** turn
  this into `/proc/self/maps` filtering, `soinfo` surgery, or a
  `dl_iterate_phdr` hook: those are higher-risk and Native Detector also uses
  `process_vm_readv` and mount scanning, so they would not guarantee
  invisibility.
- `getdents64` filtering compacts in place: destination index never exceeds
  source index, so `memmove` within the caller's buffer is safe.
- Relative paths are resolved with `getcwd`/`/proc/self/fd/<n>` using the real
  `readlink` pointer. If resolution fails, skip filtering rather than guessing.

## Config and packaging

- Native reads exactly one file: `/data/adb/filehider/targets.conf`, opened with
  `open()` from `config.cpp`. There is no module-dir copy and no fallback list;
  the persistent file survives module updates.
- The config supports `!<package>` as an inactive marker. The WebUI writes the
  marker before the app's path lines and keeps the paths; `parse_rules()` makes
  a first pass for markers, then skips every rule whose package is marked. A
  marker may appear before or after the paths. Disabled-only directives are not
  malformed config, so `has_rule_text()` ignores them.
- WebUI reads/writes the rule config only at
  `/data/adb/filehider/targets.conf`. Export writes a timestamped copy to
  Downloads; import may read a picker file. Save uses a temporary file in the
  config directory, verifies the byte count, then renames it over the config so
  a failed write cannot truncate existing rules. Set
  `u:object_r:system_file:s0` on the config file.
- `post-fs-data.sh` only enforces `0644` and the SELinux label on the persistent
  file. It must not copy or recreate a module-local config.
- **Never ship `targets.conf` in the zip.** It would overwrite user rules on
  update. `customize.sh` seeds the persistent file with the format guide only
  when it is missing, migrates an old module-local copy once, and removes the
  old module-local copies (`targets.conf`, `config.example.conf`).
- Zip layout must stay flat: `module.prop`, scripts, `webroot/`, `zygisk/<abi>.so`
  at the archive root. ABI file names use Android ABI names exactly
  (`zygisk/arm64-v8a.so`, ...), not `arm64.so`.
- `module.prop` id is `filehider`; paths in scripts and WebUI depend on it.

## Module-list status

The module-list description carries a boot-time capability prefix before the
original description, for example `[✅ FileHider v3.0 · active · arm64]`.

- `module/service.sh` is a **one-shot late-start reporter**, not a watcher or a
  native monitor daemon. `customize.sh` sets `LATESTARTSERVICE=true`, installs
  it `0755`, and creates `module.prop.bak` from the clean `module.prop`.
  `post-fs-data.sh` restores `module.prop.bak` over `module.prop` at every boot.
  Never ship `module.prop.bak` in the zip; it is generated at install time.
- The reporter writes `module.prop` atomically once and exits. It does not poll
  `logcat`, read `targets.conf`, track target apps, or leave a PID/log file. It
  strips any existing status prefix from the base description, so repeated runs
  cannot duplicate the prefix or the `description=` line. `module.prop.bak`
  stays clean.
- Status states: `active` when the module is enabled, a Zygisk provider is
  present, and the device-ABI `zygisk/<abi>.so` exists; `no-zygisk` when no
  provider is detected; `not-working` for a disable marker, unknown ABI, missing
  ABI library, or another boot-check failure. The wording is
  `[✅ FileHider v3.0 · active · arm64]`, `[❌ ... Zygisk not enabled]`, and
  `[❌ ... not working]`. Do not reintroduce pending/working states based on app
  activity.
- Provider detection checks `$ZYGISK_ENABLED`, Magisk's built-in setting
  (`magisk --sqlite "SELECT value FROM settings WHERE key='zygisk'"`), known
  module ids (`zygisksu`, `rezygisk`, `zygisk_next`, `neozygisk`), and other
  enabled modules with a `zygisk/` directory under `/data/adb/modules` or
  `/data/adb/ap/modules`. Do not claim it covers every custom provider layout;
  the status is a boot-time heuristic, not proof that a specific app hooked.
- Native `status ...` lines remain useful diagnostics but do **not** drive the
  module description: `status config-missing`, `status no-rules`,
  `status failed target=... abi=... reason=install|self-test`, and
  `status working target=... abi=... engine=inline|plt`. `status working` is
  emitted after the inline self-test passes or after a PLT install; on inline
  self-test failure emit `status failed ... reason=self-test`.
- Do not replace the reporter with a resident native daemon without device
  testing on APatch, KernelSU, and Magisk; do not add per-file-access logging
  to it. Test with `tests/status_test.sh`; its environment overrides are
  `FILEHIDER_MODDIR` and `FILEHIDER_DEVICE_ABI`.

## WebUI

- The page is a static, offline WebUI served from `webroot/`; no external
  requests and no WebUI build step. Keep it that way. `index.html` is markup
  only and loads ordered stylesheets plus classic `defer` scripts from
  `webroot/assets/css/` and `webroot/assets/js/`. Do not wrap individual script
  files in IIFEs or switch to ES modules without checking manager WebView
  support; the current classic scripts intentionally share the global scope.
- Navigation is history-based. The root home entry is installed with
  `replaceState` and is the resting entry. Do **not** keep a permanent home
  sentinel above it: when home is current the manager's `canGoBack` must be
  false so Android back closes the WebUI on the first press. Every route push
  uses a unique fragment (`historyUrl()`). A transient same-route guard is
  pushed only while the home overflow menu is open; it is popped when the menu
  closes and replaced by the target route when a menu action navigates. A back
  that reaches the root entry calls the bridge `exit`/`close` when available.
  Do not add a permanent guard or use same-URL `pushState`; either leaves home
  with a back entry, and the bridge-less fallback shows "Use Android back to
  close this screen" and needs a second press. The top-bar back button stays
  visible on every view. On home it calls the manager bridge `exit`/`close`
  when available. Android hardware back first closes the overflow menu, then a
  sheet, then returns to the previous view. The unsaved-draft guard must run
  before leaving a dirty detail view, including on `popstate`. Never call
  `pushState` while handling `popstate`; Android WebView can update
  `canGoBack` incorrectly and close the activity on the next back. The
  dirty-detail back moves to the previous entry, then uses `history.forward()`
  to re-enter the detail entry before opening the discard dialog. Cancelling
  with hardware back repeats the forward restore.
- Confirmation is an in-page `uiConfirm()` dialog (`#confirmModal`,
  `confirmOpen`, `closeConfirm()`), never `window.confirm()` or
  `window.alert()`. The same dialog handles unsaved changes, reset-all, and
  dangerous presets. By default the dialog installs a **same-route history
  guard** while open, so Android hardware back cancels the dialog instead of
  closing the WebUI or leaving the view. `closeConfirm()` pops that guard when
  dismissed by a button, backdrop, or Escape; `popstate` clears it when the user
  presses hardware back. This guard is not a visible route and must not render
  as one. The unsaved-changes dialog is the exception: it is opened from the
  dirty-detail back flow or a top-bar click and passes `guardHistory: false`
  with `onHistoryBack`, because the detail entry is already in forward history.
  Escape, the backdrop, and the cancel button do the same. Focus starts on
  **Keep editing/Cancel**, and the dialog resolves a promise rather than
  blocking the page.
- The Diagnostics logbox stays chronological (oldest first) and must scroll to
  the newest line at the bottom after every refresh and when first opened.
  `scrollLogsToBottom()` uses `scrollTop = scrollHeight` after layout; do not
  reverse the log order or add per-access hook noise.
- The Diagnostics sheet has one close control: the left back arrow. Do not add
  a duplicate `×` button. The **Clear** action resets only the displayed
  diagnostics and the in-memory/persisted WebUI activity tail; it must not run
  `logcat -c` or clear device logs. The placeholder must say that logcat was
  not cleared and that **Refresh** reloads current logs.
- Only the **home app list** restores its previous scroll position. Detail,
  settings, and help always start at the top. `showView()` saves home's position
  when leaving and restores it on return; opening or closing a sheet over the
  current view must not scroll the background. The overlay scroll lock sets
  `html.overlay-open`/`body.overlay-open` and blocks touch gestures that start
  on the backdrop. Keep `history.scrollRestoration = "manual"` and avoid smooth
  document scrolling for view changes.
- A manually typed path stays in `#pathInput` after **Add** (or Enter) so the
  user can add another path without retyping. Preset, browser, and notice
  additions may clear it.
- The home screen is app-centric: app icon, label, package, rule count, and an
  active checkbox. Query live `pm list packages` as the authoritative source for
  reloads; manager `listPackages()` can be cached until the manager activity
  restarts. Use `ksu.getPackagesInfo()` when available for labels and system
  flags, `ksu://icon/<package>` for real icons, and fall back to package names
  plus generated monograms. Feature-detect every bridge method; APatch/KernelSU
  builds differ. Configured system apps stay visible even when "show system
  apps" is off. Configured apps that are no longer installed stay visible with
  the **not installed** badge so their rules remain removable.
- Inactive state is per app and must preserve paths. The home checkbox and the
  detail switch write `!<package>`; the native parser then returns no rules for
  that package. Home toggles auto-save; path edits on the detail page require
  **Save** or **Save & force-stop**, with an unsaved-changes guard on back.
- The Hidden paths card head carries a **Remove all** action. After
  confirmation it deletes only that package's saved paths and `!package`
  inactive marker, clears the draft, and writes the config atomically. It must
  not touch other packages; roll back the in-memory state if the write fails.
- The detail page owns the path draft (`state.draftPaths`), not a global pending
  list. Browser and preset additions update the draft; `saveDetail()` commits it
  to `state.rules` and writes the config. Do not reintroduce a global cartesian
  apply step.
- Common-path presets are grouped as Integrity, Root traces, Emulator,
  Native & maps, System libraries, and Other. Keep the requested preset paths
  (`/system/lib64`, `/system/lib`, `/proc/self/maps`, `/proc/stat`,
  `/proc/cpuinfo`); dangerous presets stay in **Advanced** sections and require
  a confirmation. All groups start collapsed. Track expanded groups in
  `state.presetOpen`, reset that set when opening a different app, and preserve
  it across `renderDetail()` calls so editing does not collapse the group. Do
  not silently add broad system directories.
- Settings and help are full views; diagnostics remains a sheet. Settings
  includes Auto/Dark/Light CSS-only theming, accent choice, app icon shape
  (Circle default, Squircle, Rounded), system-app visibility, config
  copy/export/import/reload, reset with `targets.conf.bak`, and diagnostics.
  Export writes `/data/media/0/Download/FileHider-targets-<timestamp>.conf` and
  verifies the byte count; import accepts pasted text or an Android file-picker
  file. Do not claim Monet support.
- Light theme uses **opaque** surface tokens and disables backdrop blur on
  cards, the topbar/menu, detail hero/action bar, and sheets. Translucent
  surfaces over the manager's dark WebView can produce mixed dark/light blocks
  on Android. Keep warning/danger/safe tints in `--*-soft`/`--*-line` tokens,
  and use the banner/toast tokens instead of hardcoded dark colors. The theme
  must declare `color-scheme: only light` / `only dark` and update
  `<meta name="color-scheme">` in `applyTheme()`. `only` is required to opt out
  of Android WebView Auto Dark; plain `light`/`dark` lets solid cards darken
  while gradient backgrounds stay light. The WebUI logs
  `theme resolved=... autoDark=...` after a theme change.
- Do not name a card surface token `--surface`. APatch/Aster injects its own
  Material Monet variables (including `--surface`) into module WebUIs, which
  overrides the module's value and can leave dark cards in Light mode. Cards
  and the detail hero use `--fh-surface`. Keep host-injected Material names
  out of the token namespace; `--surface-2`/`--surface-3` do not currently
  collide with APatch's `--surfaceVariant`/`--surfaceContainer` names.
- KernelSU and APatch expose the same bridge as `window.ksu`. The **only** valid
  async call is:
  `ksu.exec(commandString, "{}", "globalCallbackNameString")`.
  The callback is a **string name** of a global function, and options are a JSON
  **string**. Passing an options object or a function object silently breaks
  every command (this was a real bug). `run()` in the page implements the
  correct pattern, with a 45 s timeout.
- APatch and KernelSU both use `/data/adb/modules/<id>` (verified from their
  WebUIActivity sources); `/data/adb/ap/modules/<id>` is only a harmless extra
  candidate.
- The page reads/writes the rule config only at
  `/data/adb/filehider/targets.conf` and verifies the saved byte count. Do not
  reintroduce a module-directory copy or another fallback config path.
- `webroot` is served by the manager; do not reference local file paths or fetch
  external URLs.
- The file browser must work even when `/storage/emulated` is empty or
  unreadable from the module shell: it displays the logical
  `/storage/emulated/<user>` path but lists `/data/media/<user>`.
- Browser rows are virtualized. `loadBrowser()` does **one** shell listing
  using `/system/bin/ls -a -1` for names and `ls -la` for types/symlink
  targets, then pairs the output in JavaScript. It must not run `readlink` per
  entry. Keep the legacy shell loop as a fallback when `ls` is unavailable or
  the two outputs do not line up. Keep the stale-request token so a slow
  response cannot overwrite a newer folder.
- Cache successful folder listings for the session (bounded LRU, short TTL).
  A cache hit must render without another shell call. The **Refresh** button
  forces a fresh listing.
- Symlink targets come from the `ls -la` line and are displayed immediately.
  A symlink row is treated as `L`; on tap, run one `[ -d "$path" ]` check to
  decide whether to open it as a folder or add it as a path. The **↗** button
  resolves the canonical target with one `readlink -f` call on demand. Do not
  add a per-symlink stat to the initial listing.
- Debounce fallback symlink resolution until scrolling has been idle (~300 ms);
  native listings should normally need no second `readlink` pass.
- The filter box narrows the current folder without another shell call.
  Clicking a folder opens it (symlinks are followed by `cd`); every row has a
  **＋** button for the entry path and symlink rows have **↗** for the resolved
  target (resolved on demand).
- The **Browse** button reopens the last folder so the listing cache is useful;
  **Internal storage** still opens `/storage/emulated/0`. `openBrowser()` must
  not clear the cache. Add a **Refresh** action for stale folder contents.
- The jump box is the **single** current-path display. Do not reintroduce a
  separate crumb row. Keep **Go to up folder** in the browser header and put
  **Close** in the bottom action row after **Refresh**. **Go**, **Refresh**, and
  **Close** use the visible `button.tool` style. The browser sheet has a fixed
  `88vh` height (capped at 760px) so a folder with few entries does not shrink
  the panel; the listing area scrolls instead. When a symlinked folder resolves
  elsewhere, show `Opens at <physical>` in `#resolvedPath` (`pwd -P`);
  `Add this folder` adds both the visible path and the resolved target when
  they differ.
- `addDraftPath()` normalizes storage paths to the app-visible
  `/storage/emulated/<user>/...` form before saving. After adding a shared
  storage rule, show the alias notice (`/data/media`, `/mnt/user`, `/sdcard`)
  so the user knows every name hidden by native expansion.
- Do not hardcode arbitrary symlink targets in the browser. Resolve them from
  the filesystem (`pwd -P`, `readlink -f` with a plain fallback).
- The Diagnostics **Copy** button tries `navigator.clipboard`, then a hidden
  textarea plus `document.execCommand("copy")`. If both fail it selects the log
  text so the long-press menu can copy it. Keep `-webkit-user-select: text` on
  `.logbox`; Bliss OS blocks the clipboard API.
- The Diagnostics **Save** button writes the displayed log to
  `/data/media/0/Download/FileHider-diagnostics-<timestamp>.txt` using
  `base64 -d`, `chmod 0644`, and a byte-count check. If the write fails or there
  is no bridge, fall back to clipboard copy. Do not save a partial or
  still-loading log; refresh first when the logbox shows `Loading diagnostics…`.
- The three-dot menu carries show-system-apps, help, diagnostics, settings, and
  reload. Settings has its own reset/import/export controls; do not bury them in
  the menu.

## Diagnostics (do not remove)

Logging is a feature of this module. The user tests on-device and needs to send
back actionable logs. Keep these, and extend them when adding behavior:

- `onLoad` logs version, ABI, pointer bits, api and env pointers.
- Every `preAppSpecialize` logs the process name at DEBUG. Matched processes
  also log `process=<pkg> abi=<abi> bits=<32|64> bridge=<houdini|ndk_translation|none>`.
- Config logging: source (`data`), byte count, rule count, and `last_errno` when
  nothing was found.
- Match logging: `target=<pkg> paths=<n> [paths...]`; paths include storage
  aliases.
- Pre-install check: `pre <path> lstat=<r> errno=<e> (exists|zygote EACCES|missing)`.
  `EACCES` is informational (common for shared storage); `missing` is a warning
  because the rule would have no effect.
- Hook installation: per-symbol success/skip (`hook <sym> ok/skipped` or
  `failed`), `inline hooks installed: n/24` on arm/arm64, and
  `Dobby inline hooks installed: n/24 (aliases=... skipped=...)` on x86.
  A successful install also logs
  `subprocess hooks: popen=<0|1> execve=<0|1> execv=<0|1> execvp=<0|1>`;
  a missing `popen` or incomplete exec set warns that shell children may still
  read paths (`exec hooks incomplete: ...`). These flags come from the install
  result, not from a non-null original pointer. On arm/arm64,
  `hardened ShadowHook maps: n RX, cleared=n` means executable ShadowHook maps
  were switched to read/execute and their names were cleared; absence means
  none were found or the operations were rejected. Neither is proof that a
  target detector cannot see the module.
  If inline fails, `inline hooks unavailable; falling back to Zygisk PLT hooks`,
  then `PLT scan: N ELFs, selected N (javacore=... art=... runtime=...
  app_process=... app=...)`, per-symbol dlsym origin, one
  `PLT stage <name>: ... commit=<0|1>` line per stage,
  `PLT hooks: n/24 ... commit=1`, and a clear error when every stage fails.
  `PLT stage javacore failed; retrying with minimal symbol set` is expected
  diagnostic output when the provider rejects the full set.
- Self-test after install: inline engines call `lstat`, `access`, and `open` on
  the first three hidden paths and log `post ... -> BLOCKED|still visible`.
  Verify paths that were visible or `EACCES` before; skip only those that were
  `ENOENT`. The `open` check catches missed fortify/native open paths.
  Inline failures are errors. PLT installations skip this test because PLT hooks
  cover caller ELFs, not the module's own calls; log
  `self-test skipped: PLT hooks cover caller ELFs...`.
- Status lines remain diagnostics and are **not consumed** by `service.sh`:
  `status config-missing process=...`, `status no-rules process=...`,
  `status failed target=... abi=... reason=install`,
  `status failed target=... abi=... reason=self-test`, and
  `status working target=... abi=... engine=inline|plt`. Emit `status working`
  only after a successful inline self-test or PLT install. Keep the reason
  tokens stable for log reading; the boot-time module description does not
  change based on them.
- First successful interception logs `first blocked path: <path>` (from
  `note_hidden` in hooks.cpp). This is the proof that runtime blocking works.
  Directory filtering, subprocess path rewriting, and normal file hooks all
  call it.
- Processes with no matching rules log
  `module unload requested (no hooks installed)` and request
  `DLCLOSE_MODULE_LIBRARY`. The module `.so` should then be absent from that
  process's maps/soinfo. Never request DLCLOSE after hook installation. A config
  whose only rules are `!package` inactive entries logs
  `config has inactive app rules only; no hooks` and also unloads.
- The first `popen`/exec rewrite also logs
  `subprocess path rewrite active (popen/exec)` when it happens in the app
  process (`popen`). `ProcessBuilder` calls `execv` in a forked child; the
  rewrite intentionally avoids logging there to stay fork-safe, so use the
  `subprocess hooks:` install line and the app's own `first blocked path` for
  diagnostics.

Log tags are all `FileHider`. `adb logcat -s FileHider` shows everything;
`:I` filters to matches/results. The WebUI's **Diagnostics** sheet captures
`module.prop`, ABI, module/config listings, the config contents, the last 250
log lines, and the bounded WebUI activity log, and can force-stop configured
apps. Keep `webLog()` coverage for navigation, app reloads (source/count/diff),
config load/save/import/export, browser loads, and JavaScript errors. The WebUI
log stays in memory; do not write per-access hook noise into it. A bounded tail
of `nav`, `ui`, `theme`, `error`, and `webui` lines is also kept in
`localStorage` under `fh.uiTail`; startup moves the previous tail into memory
and clears the key, and Diagnostics shows it as **previous WebUI activity**.
This is deliberate so a WebUI close (for example a failed hardware-back guard)
does not erase the evidence.

Do not log per file-access in hooks (too noisy); only the first hit.

## Build checks

Before handing off a build, run:

```bash
./scripts/test.sh
./scripts/build.sh
./scripts/verify.sh dist/FileHider-*.zip
unzip -l dist/FileHider-*.zip
```

The zip must contain exactly the expected files (no `targets.conf`, no
`config.example.conf`, no `module.prop.bak`, no `status.pid`/`status.logcat`),
`service.sh`, all four `zygisk/*.so`, and the complete `webroot/index.html` +
`webroot/assets/css/*.css` + `webroot/assets/js/*.js` tree. Verify `service.sh`
is executable in the staged/zip tree. `./scripts/test.sh` runs both the host
matcher test and `tests/status_test.sh`. For each `.so`, verify:

```bash
NDK=.toolchain/android-ndk/toolchains/llvm/prebuilt/linux-x86_64/bin
$NDK/llvm-nm -D build/arm64-v8a/libfilehider.so | grep zygisk_module_entry
$NDK/llvm-readelf -l build/arm64-v8a/libfilehider.so | awk '/LOAD/{print $NF; exit}'  # 0x4000
```

16 KB page alignment (`0x4000`) is required for Android 15+ arm64 devices.

## Testing on device

There is no device in this environment. The user tests on APatch + Zygisk Next,
KernelSU + Zygisk Next, and later Magisk built-in Zygisk. Ask them for:

```bash
adb logcat -s FileHider
```

On match expect `target=<pkg> paths=<n> [..]`, `process=... bridge=...`, a
pre-check, then `inline hooks installed: <n>/24` (arm) or
`Dobby inline hooks installed: <n>/24 (...)` (x86), the
`subprocess hooks: popen=... execve=...` summary, or the fallback
`inline hooks unavailable` + `PLT scan: ... selected ...` + staged
`PLT stage ... commit=1` + `PLT hooks: ... commit=1`. Then look for
`post ... -> BLOCKED` and `first blocked path: ...` when the self-test (or the
app) first touches the path. For a `popen`-based detector, expect
`subprocess path rewrite active (popen/exec)` followed by the app's first
blocked path; `ProcessBuilder` exec rewrites in the child without that log.
`bridge=houdini` confirms an ARM app is running
through the x86/x86_64 translator; Java access is covered, translated native
code may not be.
`pre ... zygote EACCES` is expected for shared storage. If `pre` says `missing`,
the rule path is wrong. If nothing logs, the process name did not match; check
the package name and remember subprocesses are `pkg:name`. Also expect
`status working target=... abi=... engine=...` after the self-test/PLT install.
That is a diagnostic log line only; the module description was already decided
by the one-shot boot reporter. If the description says **not working** but the
target app logs a successful install, include the boot reporter's module and
ABI details plus the `FileHider` status lines in the report. A failed status
line is usually followed by the real install/self-test error just above it.

## Known limitations (documented in docs/LIMITATIONS.md)

- libc hooks do not cover raw syscalls. Child processes do not inherit the
  hooks; only an exact hidden path in `popen` command text or exec argv is
  rewritten. A path built only inside the child, a glob, a shell expansion, or
  a separate daemon can still read it. `/proc` metadata is not rewritten:
  listing `/proc/self/mountinfo` or `/proc/self/maps` hides that exact path
  through normal libc calls, but alternate `/proc` paths, raw syscalls, and
  metadata read another way still reveal real state.
- The inline engines (ShadowHook/Dobby) cover late-loaded native libraries too.
  The PLT fallback covers only selected already-loaded ELFs. ARM-translated
  native code (libhoudini/ndk_translation) may bypass the host-ABI hooks.
- No mount-namespace/overlay layer exists yet. Do not claim subprocess-proof
  hiding or "undetectable" behavior.
- Module-list status is advisory and coarse, set once by the boot reporter.
  **Not working** is not proof that hooks are broken: provider detection is
  heuristic (known ids, `$ZYGISK_ENABLED`, Magisk's setting, or an enabled
  module with `zygisk/`), so an unusual provider layout may show not working
  while a target app still hooks correctly. The manager may cache
  `module.prop` until its module page is reopened.
- FileHider unloads its library from processes with no matching rules, so
  maps/soinfo-based detectors do not see the module in those apps. If a
  detector app is itself configured as a target, the resident hooks and the
  mapped module are visible to native introspection. Switching ShadowHook's
  executable maps to RX and clearing the trampoline name removes one RWX/name
  signature but does not hide the module; do not claim otherwise. Hiding from a
  detector and hiding files from that detector inside its own process cannot
  both be guaranteed with resident hooks.
- Common shared-storage aliases are handled. Arbitrary symlinks, bind mounts, or
  `/proc/self/root/...` access are only hidden if that exact path is listed.

## Style

- C++17, 4-space indent, `namespace fh` for shared helpers, `snake_case`
  functions, `g_` globals, `real_*` for hook originals.
- Keep `matcher.cpp` free of Android headers so `scripts/test.sh` can build it
  on the host with `g++`.
- No new dependencies unless necessary; the WebUI must stay static, offline
  files under `webroot/` with no external requests or build step.
- Prefer `ENOENT` over `EACCES` for hidden paths so existence is not leaked.
