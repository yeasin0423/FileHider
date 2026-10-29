# Building

FileHider is a native CMake project. There is no Gradle, Android Studio
project, or WebUI build step.

## Requirements

| Tool | Notes |
| --- | --- |
| Linux host | The scripts target a Linux build host. |
| Android NDK r30 | Downloaded by `./scripts/bootstrap-ndk.sh`; SHA-1 pinned. |
| CMake 3.20+ | `~/.local/bin` is added to `PATH` by the build script. |
| Ninja | Build generator. |
| C++17 host compiler | Used by the matcher tests. |
| `zip`, `unzip`, `curl` | Packaging and NDK bootstrap. |

The NDK is placed in `.toolchain/android-ndk` and is gitignored (~2.3 GB).
`cmake` and `ninja` can be installed without root:

```bash
pip3 install --user cmake ninja
```

## Local build

```bash
./scripts/bootstrap-ndk.sh   # download and verify NDK r30
./scripts/test.sh            # host matcher + shell/status tests
./scripts/build.sh           # all 4 ABIs + verify + package
```

The output is:

```text
dist/FileHider-v3.1.zip
```

`scripts/build.sh` runs `scripts/verify.sh` automatically. To verify an
existing archive directly:

```bash
./scripts/verify.sh dist/FileHider-v3.1.zip
```

The verifier checks:

- zip integrity and required entries
- no `targets.conf`, `config.example.conf`, `module.prop.bak`, or status files
- all four `zygisk/*.so` files
- `zygisk_module_entry` in every ABI library
- arm64 `0x4000` LOAD alignment
- executable `service.sh`
- SHA-256 output

## Overrides

```bash
ABIS="arm64-v8a x86_64" ./scripts/build.sh
MIN_API=26 ./scripts/build.sh
ANDROID_NDK_HOME=/path/to/ndk ./scripts/build.sh
CMAKE=/path/to/cmake NINJA=/path/to/ninja ./scripts/build.sh
```

Example single-ABI build:

```bash
ABIS="arm64-v8a" ./scripts/build.sh
```

## Artifact layout

The zip is flat. Its root contains the module files and the WebUI:

```text
module.prop
customize.sh
post-fs-data.sh
service.sh
uninstall.sh
webroot/index.html
webroot/assets/css/*.css
webroot/assets/js/*.js
zygisk/arm64-v8a.so
zygisk/armeabi-v7a.so
zygisk/x86_64.so
zygisk/x86.so
```

The ABI file names are Android ABI names, not shortened names such as
`arm64.so`.

## GitHub Actions

The workflow at `.github/workflows/build.yml` runs on:

- pushes to `main` or `master`
- pull requests
- manual dispatch

It runs the host tests, restores or downloads the pinned NDK, builds all four
ABIs, verifies the package, and uploads a workflow artifact containing:

```text
FileHider-v3.1.zip
SHA256SUMS
```

The workflow does **not** create GitHub releases. Download the artifact from
the Actions run and publish the release manually.

## Reproducibility and checks

The NDK download is verified against:

```text
SHA1 5107f898313790e449e87eee2183d9a20602dee9
```

To inspect the final archive manually:

```bash
unzip -l dist/FileHider-v3.1.zip
unzip -Z -l dist/FileHider-v3.1.zip | grep service.sh
sha256sum dist/FileHider-v3.1.zip
```

## Clean

Build output is disposable:

```bash
rm -rf build stage dist
```

`dist/`, `build/`, `stage/`, `.toolchain/`, `backups/`, and other local
artifacts are ignored by Git.
