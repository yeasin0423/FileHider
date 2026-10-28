# Limitations

FileHider is a userspace libc-hook module, not a kernel or mount-namespace
solution. It hides the paths you list from normal libc file access inside a
selected process. It does not make a device or an app undetectable.

## Raw syscalls

An app that calls `syscall(SYS_newfstatat, ...)` or another syscall directly
does not pass through `stat`, `open`, or the other hooked symbols. A userspace
libc hook cannot intercept that path.

## Child processes

Children do not inherit the module's libc hooks. FileHider rewrites an exact
hidden path when it appears in `popen` command text or in `execve`/`execv`/
`execvp` argv. It does not rewrite:

- a path assembled only inside the child
- a glob or shell expansion
- a separate daemon that the app contacts
- arbitrary file access performed by the child

`Runtime.exec("ls /system/xbin")` is covered because the path is in the command
text. Access to that directory from inside `ls` for other paths is not.

## PLT fallback coverage

The normal arm/arm64 (ShadowHook) and x86/x86_64 (Dobby) paths patch libc, so
late-loaded native libraries are covered. If inline installation fails, the
scoped PLT fallback covers only selected already-loaded ELFs.

## Translated ARM apps

On x86/x86_64 devices with libhoudini or ndk_translation, an ARM app runs as a
host-ABI process. Zygisk loads the x86/x86_64 module. Java/`libcore` access is
covered, but ARM native code executed through the translator may use
translator-internal paths or raw syscalls and bypass the hooks. Test the
specific app.

## `/proc` metadata

`/proc/self/mountinfo`, `/proc/self/maps`, and similar paths can be added as
advanced presets. Listing one of them hides that exact libc path like any other
rule, but FileHider does not rewrite mount tables or `/proc` contents. Raw
syscalls, alternate `/proc` paths, and metadata read another way still reveal
real state.

## Module visibility

FileHider unloads its library from apps with no matching rules, so
maps/`soinfo`-based detectors do not see it there. If a detector app is itself
configured as a target, the mapped module and resident libc hooks are visible to
native introspection.

On arm/arm64, executable ShadowHook maps are switched to read/execute and their
names are cleared. This removes an RWX/name signature, not the mapped module.
Hiding files from an app and being invisible to that same app's native
introspection cannot both be guaranteed with resident hooks.

## Path-string matching

Common shared-storage aliases are handled. Arbitrary symlinks, bind mounts, and
`/proc/self/root/...` aliases are hidden only if that exact path is also listed.
The browser can resolve a symlink and add both the visible and physical paths.

## Cached listings

Apps that cache directory listings can keep stale entries until they restart.
Force-stop the app after changing rules.

## Module-list status

The status is advisory and coarse. It is set once by the boot reporter and
checks only the module, provider, and device ABI. Provider detection is
heuristic, so **not working** does not prove that hooks are broken. The manager
may also cache `module.prop` until the module page is reopened.

## System processes

Do not add `system_server`, `zygote`, or your launcher unless you are prepared
for boot issues. `system_server` is skipped by design.

## No mount namespace

There is no mount-namespace or overlay layer. If a detector uses a raw syscall,
constructs the hidden path only inside a child, or reads `/proc` metadata
through an unlisted path, these hooks cannot hide it. Do not describe the
module as subprocess-proof or undetectable.
