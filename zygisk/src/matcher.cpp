#include "matcher.h"

#include <algorithm>
#include <cctype>
#include <utility>

namespace fh {

namespace {

std::string trim(const std::string &s) {
    size_t begin = 0;
    while (begin < s.size() && std::isspace(static_cast<unsigned char>(s[begin])))
        ++begin;
    size_t end = s.size();
    while (end > begin && std::isspace(static_cast<unsigned char>(s[end - 1])))
        --end;
    return s.substr(begin, end - begin);
}

bool all_digits(const std::string &s) {
    if (s.empty())
        return false;
    return std::all_of(s.begin(), s.end(),
                       [](unsigned char c) { return std::isdigit(c) != 0; });
}

void add_unique(std::vector<std::string> &paths, const std::string &path) {
    if (path.empty() || path == "/")
        return;
    if (std::find(paths.begin(), paths.end(), path) == paths.end())
        paths.push_back(path);
}

// Returns the normalized text of a config line, with CR and comments removed.
// Keeping this in one place makes the disabled-package pass and the rule pass
// agree about what counts as a line.
std::string config_line(std::string line) {
    if (!line.empty() && line.back() == '\r')
        line.pop_back();
    size_t comment = line.find('#');
    if (comment != std::string::npos)
        line.erase(comment);
    return trim(line);
}

// A disabled package is written as a single "!package" token. The WebUI uses
// this to keep an app's paths while temporarily turning hiding off for it.
bool disabled_package(const std::string &line, std::string &package) {
    if (line.size() < 2 || line[0] != '!')
        return false;
    const std::string value = trim(line.substr(1));
    if (value.empty())
        return false;
    for (unsigned char c : value) {
        if (std::isspace(c))
            return false;
    }
    package = value;
    return true;
}

std::vector<std::string> disabled_packages(const std::string &text) {
    std::vector<std::string> disabled;
    size_t pos = 0;
    while (pos <= text.size()) {
        size_t eol = text.find('\n', pos);
        std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
        pos = (eol == std::string::npos) ? text.size() + 1 : eol + 1;

        line = config_line(std::move(line));
        std::string package;
        if (!line.empty() && disabled_package(line, package) &&
            std::find(disabled.begin(), disabled.end(), package) == disabled.end()) {
            disabled.push_back(package);
        }
    }
    return disabled;
}

// Splits "/prefix/<user><rest>" where <user> is numeric.
bool split_user_storage(const std::string &path, const std::string &prefix,
                        std::string &user, std::string &rest) {
    if (path.compare(0, prefix.size(), prefix) != 0)
        return false;
    const size_t begin = prefix.size();
    const size_t slash = path.find('/', begin);
    user = path.substr(begin, slash == std::string::npos ? std::string::npos : slash - begin);
    if (!all_digits(user))
        return false;
    rest = slash == std::string::npos ? std::string() : path.substr(slash);
    return true;
}

// Splits "/mnt/user/<user>/primary<rest>".
bool split_mnt_user_primary(const std::string &path, std::string &user, std::string &rest) {
    static const std::string prefix = "/mnt/user/";
    static const std::string primary = "/primary";
    if (path.compare(0, prefix.size(), prefix) != 0)
        return false;
    const size_t begin = prefix.size();
    const size_t slash = path.find('/', begin);
    user = path.substr(begin, slash == std::string::npos ? std::string::npos : slash - begin);
    if (!all_digits(user) || slash == std::string::npos)
        return false;
    if (path.compare(slash, primary.size(), primary) != 0)
        return false;
    const size_t after = slash + primary.size();
    if (after < path.size() && path[after] != '/')
        return false;
    rest = path.substr(after);
    return true;
}

// Android exposes the same storage under several names. Apps use different
// ones depending on API level, root access, or how they were written, so a
// rule for one form must match all common forms.
std::vector<std::string> storage_aliases(const std::string &path) {
    std::vector<std::string> out;
    add_unique(out, path);

    auto add_emulated = [&out](const std::string &user, const std::string &rest) {
        add_unique(out, "/storage/emulated/" + user + rest);
        add_unique(out, "/data/media/" + user + rest);
        add_unique(out, "/mnt/user/" + user + "/primary" + rest);
        if (user == "0")
            add_unique(out, "/sdcard" + rest);
    };

    std::string user;
    std::string rest;
    if (split_user_storage(path, "/data/media/", user, rest) ||
        split_user_storage(path, "/storage/emulated/", user, rest) ||
        split_mnt_user_primary(path, user, rest)) {
        add_emulated(user, rest);
    } else if (path == "/sdcard" || path == "/storage/self/primary") {
        add_emulated("0", "");
    } else if (path.compare(0, 8, "/sdcard/") == 0) {
        add_emulated("0", "/" + path.substr(8));
    } else if (path.compare(0, 22, "/storage/self/primary/") == 0) {
        add_emulated("0", "/" + path.substr(22));
    }

    return out;
}

} // namespace

std::string normalize_path(const std::string &path) {
    if (path.empty())
        return path;
    std::string out = path;
    // Collapse duplicate slashes without touching the leading one.
    std::string compact;
    compact.reserve(out.size());
    for (size_t i = 0; i < out.size(); ++i) {
        if (out[i] == '/' && !compact.empty() && compact.back() == '/')
            continue;
        compact.push_back(out[i]);
    }
    while (compact.size() > 1 && compact.back() == '/')
        compact.pop_back();
    return compact;
}

std::string join_path(const std::string &dir, const std::string &name) {
    if (dir.empty() || dir == "/")
        return "/" + name;
    return dir + "/" + name;
}

std::vector<Rule> parse_rules(const std::string &text) {
    const std::vector<std::string> disabled = disabled_packages(text);
    std::vector<Rule> rules;
    size_t pos = 0;
    while (pos <= text.size()) {
        size_t eol = text.find('\n', pos);
        std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
        pos = (eol == std::string::npos) ? text.size() + 1 : eol + 1;

        line = config_line(std::move(line));
        if (line.empty())
            continue;

        std::string disabled_name;
        if (disabled_package(line, disabled_name))
            continue;

        size_t sep = 0;
        while (sep < line.size() && !std::isspace(static_cast<unsigned char>(line[sep])))
            ++sep;
        if (sep == 0 || sep >= line.size())
            continue;

        std::string package = line.substr(0, sep);
        std::string path = trim(line.substr(sep));
        if (package.empty() || path.empty() || path[0] != '/')
            continue;
        if (std::find(disabled.begin(), disabled.end(), package) != disabled.end())
            continue; // inactive app: keep the file, skip its rules
        path = normalize_path(path);
        if (path == "/")
            continue; // hiding everything would make the app unusable
        rules.push_back(Rule{package, path});
    }
    return rules;
}

bool package_matches(const std::string &process_name, const std::string &package) {
    if (package.empty() || process_name.empty())
        return false;
    if (process_name == package)
        return true;
    return process_name.size() > package.size() &&
           process_name.compare(0, package.size(), package) == 0 &&
           process_name[package.size()] == ':';
}

bool has_rule_text(const std::string &text) {
    size_t pos = 0;
    while (pos <= text.size()) {
        size_t eol = text.find('\n', pos);
        std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
        pos = (eol == std::string::npos) ? text.size() + 1 : eol + 1;

        line = config_line(std::move(line));
        if (line.empty())
            continue;
        // Disabled directives alone are not malformed config. They describe
        // an app with no enabled rules, the same as an unconfigured app.
        std::string package;
        if (disabled_package(line, package))
            continue;
        return true;
    }
    return false;
}

bool has_disabled_packages(const std::string &text) {
    return !disabled_packages(text).empty();
}

std::vector<std::string> paths_for_process(const std::vector<Rule> &rules,
                                           const std::string &process_name) {
    std::vector<std::string> paths;
    for (const Rule &rule : rules) {
        if (!package_matches(process_name, rule.package))
            continue;
        for (const std::string &path : storage_aliases(rule.path))
            add_unique(paths, path);
    }
    return paths;
}

bool path_is_hidden(const std::vector<std::string> &hidden, const std::string &path) {
    if (hidden.empty() || path.empty())
        return false;
    const std::string candidate = normalize_path(path);
    for (const std::string &entry : hidden) {
        if (candidate == entry)
            return true;
        if (candidate.size() > entry.size() &&
            candidate.compare(0, entry.size(), entry) == 0 &&
            candidate[entry.size()] == '/') {
            return true;
        }
    }
    return false;
}

} // namespace fh
