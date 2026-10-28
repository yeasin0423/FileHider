# Changelog

All notable changes to FileHider are recorded here. The module version comes
from [`module/module.prop`](module/module.prop).

## v3.0 — 2026-10-28

### Changed

- Restructured the repository: native code now lives under `zygisk/`, packaged
  module files stay under `module/`, and detailed documentation lives under
  `docs/`.
- Rewrote the README as a project landing page with install, configuration,
  architecture, build, and troubleshooting entry points.
- Replaced the build workflow with a test → build → verify → upload pipeline.
  It uploads the zip and `SHA256SUMS` as a workflow artifact; GitHub releases
  are created manually.
- Added `scripts/verify.sh` for zip contents, all four ABI libraries, exported
  Zygisk entry points, arm64 16 KB page alignment, and the executable bit on
  `service.sh`.
- Added MIT license, changelog, editor defaults, git attributes, and proper
  ignores for local build/report artifacts.

`v3.0` is a repository and release-engineering update. The runtime hiding
behavior, config format, WebUI, and flat flashable-zip layout are unchanged
from `v2.9`.

## v2.9 — 2026-10-28

- Added the per-app **Remove all** action to the Hidden paths card.
- Fixed WebUI history so Android back closes the home screen on the first press.
- Kept Light theme surfaces opaque and opted out of WebView Auto Dark.
- Removed the stray `Configure via WebUI.` suffix from the module description
  and status fallback.
- Verified all four ABIs and the 16 KB arm64 page alignment.
