#pragma once

#include <string>
#include <vector>

namespace fh {

// arm/arm64: ShadowHook; x86/x86_64: Dobby. Both patch libc inline, so they
// cover Java/libcore and native callers.
bool install_inline_hooks(const std::vector<std::string> &hidden_paths);

// Scoped Zygisk PLT hooks. Fallback for every ABI when inline patching fails.
bool install_plt_hooks(void *zygisk_api, const std::vector<std::string> &hidden_paths);

// True when the libc inline engine is the one currently installed.
bool inline_hooks_active();

} // namespace fh
