#pragma once

#include <string>

namespace fh {

struct ConfigResult {
    std::string text;
    // "data" when /data/adb/filehider/targets.conf was read; empty otherwise.
    std::string source;
    int last_error = 0;
};

// Reads the single persistent config at /data/adb/filehider/targets.conf.
ConfigResult read_targets_config();

} // namespace fh
