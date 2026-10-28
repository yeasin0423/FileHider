#pragma once

#include <string>
#include <vector>

namespace fh {

struct Rule {
    std::string package;
    std::string path;
};

// Parses "package<TAB>path" (whitespace separated) lines. Blank lines and
// lines starting with '#' are ignored. A line containing only "!package"
// marks that package inactive: its path rules stay in the file (so the WebUI
// can restore them later) but are not returned here. Trailing slashes are
// stripped so that "/system/xbin/" and "/system/xbin" behave identically.
std::vector<Rule> parse_rules(const std::string &text);

// True when `process_name` belongs to `package`. Also matches subprocesses
// such as "com.example:remote".
bool package_matches(const std::string &process_name, const std::string &package);

// True when the config contains at least one usable rule line. Disabled-only
// directives and comments are ignored, so an all-inactive config is treated as
// "nothing enabled yet" rather than malformed.
bool has_rule_text(const std::string &text);

// True when the config contains at least one "!package" directive.
bool has_disabled_packages(const std::string &text);

// Collects the hidden paths that apply to this process. Read-only after load.
std::vector<std::string> paths_for_process(const std::vector<Rule> &rules,
                                           const std::string &process_name);

// Exact match, or any descendant of a hidden directory.
bool path_is_hidden(const std::vector<std::string> &hidden, const std::string &path);

std::string normalize_path(const std::string &path);
std::string join_path(const std::string &dir, const std::string &name);

} // namespace fh
