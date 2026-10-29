# Troubleshooting

The module logs its decisions for every matching app process. Use the WebUI's
**Diagnostics** sheet or watch adb:

```bash
adb logcat -s FileHider        # everything, including per-process debug lines
adb logcat -s FileHider:I      # matches and hook results only
```

## Successful arm/arm64 install

Values vary by Android version and ABI:

```text
FileHider: onLoad: v3.1 abi=arm64-v8a bits=64 api=0x... env=0x...
FileHider: com.example.detector: config=data bytes=58 rules=2
FileHider: target=com.example.detector paths=2 [/system/build.prop, /system/xbin]
FileHider: process=com.example.detector abi=arm64-v8a bits=64 bridge=none
FileHider: pre  /system/build.prop lstat=0 errno=0 (exists)
FileHider: inline hooks installed: 22/24
FileHider: subprocess hooks: popen=1 execve=1 execv=1 execvp=1
FileHider: hardened ShadowHook maps: 1 RX, cleared=1
FileHider: first blocked path: /system/build.prop
FileHider: post /system/build.prop lstat=-1 errno=2 access=-1 errno=2 open=-1 errno=2 -> BLOCKED
FileHider: status working target=com.example.detector abi=arm64-v8a engine=inline
FileHider: hooks active (inline/ShadowHook), 2 hidden path(s)
```

## Successful x86/x86_64 install

```text
FileHider: onLoad: v3.1 abi=x86 bits=32 api=0x... env=0x...
FileHider: process=com.example.detector abi=x86 bits=32 bridge=none
FileHider: Dobby inline hooks installed: 19/24 (aliases=4 skipped=1)
FileHider: subprocess hooks: popen=1 execve=1 execv=1 execvp=1
FileHider: status working target=com.example.detector abi=x86 bits=32 engine=inline
FileHider: hooks active (inline/Dobby), 2 hidden path(s)
```

## Scoped PLT fallback

If the inline engine fails, the module logs:

```text
FileHider: inline hooks unavailable; falling back to Zygisk PLT hooks
FileHider: PLT scan: 234 ELFs, selected 4 (javacore=1 art=1 runtime=1 app_process=1 app=0)
FileHider: PLT stage javacore: 1 ELFs x 23 symbols (23 registrations), commit=1
FileHider: PLT stage art: 1 ELFs x 23 symbols (23 registrations), commit=1
FileHider: PLT hooks: 23/24 symbols over 4 selected ELFs, commit=1
FileHider: hooks active (PLT), 2 hidden path(s)
```

`PLT stage javacore failed; retrying with minimal symbol set` is expected when
the provider rejects the full set.

## Common failures

| Log line | Meaning / fix |
| --- | --- |
| No `FileHider` lines | Module not loaded. Check Zygisk is enabled, the zip was flashed, and the ABI `.so` exists. |
| `no targets.conf (last_errno=...)` | Config missing or unreadable. Save a rule in the WebUI or check the file permissions. |
| `config has non-comment lines but no valid rules` | Wrong format. Use `<package><TAB><absolute path>`. |
| `no rule matches this process` | Package mismatch. Use `pm list packages`; remember subprocesses are `pkg:name`. |
| `module unload requested (no hooks installed)` | Expected for unaffected apps. The module is removed from that process. |
| `pre ... is not visible before hooks` | The path does not exist for zygote. Verify the real path on the device. |
| `pre ... zygote EACCES` | Expected for shared storage. The rule still matches when the app uses the path. |
| `inline hooks installed: 0/24` or `Dobby inline hooks installed: 0/24` | Inline patching failed. The PLT fallback should run next; include the full log if both fail. |
| `pltHookCommit failed` / `commit=0` | Provider too old or rejected every selected stage. Check that the provider supports Zygisk PLT API v5. |
| `subprocess path rewrite active` | A `popen` command contained a hidden path. The child sees the decoy path. |
| `exec hooks incomplete: ...` | One or more exec hooks failed. Other hooks still work; include the log. |
| `first blocked path` missing but hooks say active | The app may use a raw syscall, a constructed child path, or an unlisted alias. See [Limitations](LIMITATIONS.md). |
| `self-test skipped: PLT hooks cover caller ELFs` | Expected for the fallback. Check `first blocked path` in the target app. |
| `self-test ... still visible` with inline | The entry point was not actually patched. Include the full log. |
| Module description says **Zygisk not enabled** | Enable Zygisk or install/enable a provider, then reboot. |
| Module description says **not working** | Check the module is enabled, the boot ABI is known, and `zygisk/<abi>.so` exists. |

## Hooks install but the app still sees files

- Force-stop the app after saving. Rules are read at process spawn.
- Verify the rule path is exactly what the app accesses.
- Check whether the app uses a raw syscall, a path built inside a child, or an
  unlisted symlink/bind-mount alias.
- Clear the app's cached directory listings by force-stopping it.
- Inline hooks cover late-loaded native libraries; the PLT fallback covers only
  selected already-loaded ELFs.

## Config permissions

```bash
adb shell su -c 'ls -lZ /data/adb/filehider/targets.conf'
```

Expected: readable (`0644`) and labeled `u:object_r:system_file:s0`.
`post-fs-data.sh` enforces this at boot.

## Module-list status is wrong

The description is set by a one-shot boot reporter. It is a coarse capability
check, not proof that a rule worked. If a target app logs
`status working target=...`, the hooks are active even if the description says
**not working**. Reopen the manager's module page to refresh its cached
`module.prop`.

## Collecting a useful report

Include:

- device model, Android version, and ABI
- root manager and Zygisk provider versions
- `adb logcat -s FileHider` lines from app start through the first access
- the relevant rules from `/data/adb/filehider/targets.conf`
- whether the app uses Java, native code, or a shell child
