#include <cstdio>
#include <string>
#include <vector>

#include "matcher.h"

namespace {

int failures = 0;

void check(bool condition, const char *what) {
    if (!condition) {
        std::printf("FAIL: %s\n", what);
        ++failures;
    }
}

bool contains(const std::vector<std::string> &values, const std::string &needle) {
    for (const std::string &value : values) {
        if (value == needle)
            return true;
    }
    return false;
}

} // namespace

int main() {
    const std::string config =
        "# comment line\n"
        "com.detector\t/system/build.prop\n"
        "com.detector  /system/xbin/  \r\n"
        "\n"
        "com.other /vendor/build.prop\n"
        "com.root /\n"
        "bad-line-without-path\n"
        "com.bad relative/path\n";

    const std::vector<fh::Rule> rules = fh::parse_rules(config);
    check(rules.size() == 3, "parses only valid rules");
    check(rules[0].package == "com.detector", "parses package");
    check(rules[0].path == "/system/build.prop", "parses path");
    check(rules[1].path == "/system/xbin", "strips trailing slash");
    check(rules[2].path == "/vendor/build.prop", "parses second package");
    check(fh::has_rule_text(config), "detects configured rules");
    check(!fh::has_rule_text("# only a comment\n\n   \n# another\n"), "comments-only config");
    check(fh::has_rule_text("this-is-not-a-rule\n"), "detects malformed content");

    // "!package" keeps the app's paths on disk but disables all of them. The
    // directive can appear before or after the path lines.
    const std::string disabledConfig =
        "com.active /system/build.prop\n"
        "!com.disabled\n"
        "com.disabled /system/xbin\n"
        "com.disabled /vendor/build.prop\n"
        "com.late /system/lib64\n"
        "!com.late\n";
    const std::vector<fh::Rule> disabledRules = fh::parse_rules(disabledConfig);
    check(disabledRules.size() == 1, "disabled packages are skipped");
    check(disabledRules[0].package == "com.active", "active package still parsed");
    check(disabledRules[0].path == "/system/build.prop", "active path still parsed");
    check(fh::paths_for_process(disabledRules, "com.disabled").empty(),
          "disabled package has no hidden paths");
    check(fh::paths_for_process(disabledRules, "com.disabled:worker").empty(),
          "disabled subprocess has no hidden paths");
    check(fh::paths_for_process(disabledRules, "com.late").empty(),
          "disabled marker after rules also disables them");
    check(!fh::has_rule_text("!com.disabled\n"), "disabled-only config is not malformed");
    check(fh::has_disabled_packages(disabledConfig), "detects inactive app markers");
    check(!fh::has_disabled_packages(config), "no inactive markers in active config");

    check(fh::package_matches("com.detector", "com.detector"), "exact package match");
    check(fh::package_matches("com.detector:remote", "com.detector"), "subprocess match");
    check(!fh::package_matches("com.detectorx", "com.detector"), "no prefix false positive");
    check(!fh::package_matches("com.other", "com.detector"), "different package");

    const std::vector<std::string> forDetector =
        fh::paths_for_process(rules, "com.detector:worker");
    check(forDetector.size() == 2, "collects paths for subprocess");
    check(forDetector[0] == "/system/build.prop", "first path");
    check(forDetector[1] == "/system/xbin", "second path");

    check(fh::paths_for_process(rules, "com.unlisted").empty(), "unlisted app gets nothing");

    const std::vector<std::string> hidden = {"/system/build.prop", "/system/xbin"};
    check(fh::path_is_hidden(hidden, "/system/build.prop"), "exact file hidden");
    check(fh::path_is_hidden(hidden, "/system/xbin/su"), "child of hidden dir");
    check(fh::path_is_hidden(hidden, "/system/xbin/"), "dir itself hidden");
    check(!fh::path_is_hidden(hidden, "/system/build.prop.bak"), "prefix without slash is visible");
    check(!fh::path_is_hidden(hidden, "/system/xbin2/su"), "sibling prefix is visible");
    check(!fh::path_is_hidden(hidden, "/system/bin/sh"), "unrelated path visible");

    check(fh::normalize_path("/system//xbin///") == "/system/xbin", "normalizes slashes");
    check(fh::normalize_path("/") == "/", "keeps root");
    check(fh::join_path("/", "system") == "/system", "join root");
    check(fh::join_path("/system", "build.prop") == "/system/build.prop", "join child");

    // Shared storage is reachable as /data/media/<n>, /storage/emulated/<n>
    // and /sdcard. A rule for one form must hide all common forms.
    const std::vector<fh::Rule> storageRules = fh::parse_rules(
        "com.storage /data/media/0/secret\n"
        "com.storage /storage/emulated/10/other\n"
        "com.storage /sdcard/sd.txt\n"
        "com.storage /mnt/user/0/primary/mnt.txt\n");
    const std::vector<std::string> storagePaths =
        fh::paths_for_process(storageRules, "com.storage:worker");
    check(contains(storagePaths, "/data/media/0/secret"), "data media rule kept");
    check(contains(storagePaths, "/storage/emulated/0/secret"), "data media aliases storage");
    check(contains(storagePaths, "/sdcard/secret"), "user 0 aliases sdcard");
    check(contains(storagePaths, "/mnt/user/0/primary/secret"), "data media aliases mnt user");
    check(contains(storagePaths, "/storage/emulated/10/other"), "storage rule kept");
    check(contains(storagePaths, "/data/media/10/other"), "storage aliases data media");
    check(contains(storagePaths, "/mnt/user/10/primary/other"), "storage aliases mnt user");
    check(!contains(storagePaths, "/sdcard/other"), "non-zero user has no sdcard alias");
    check(contains(storagePaths, "/sdcard/sd.txt"), "sdcard rule kept");
    check(contains(storagePaths, "/storage/emulated/0/sd.txt"), "sdcard aliases storage");
    check(contains(storagePaths, "/data/media/0/sd.txt"), "sdcard aliases data media");
    check(contains(storagePaths, "/mnt/user/0/primary/mnt.txt"), "mnt user rule kept");
    check(contains(storagePaths, "/storage/emulated/0/mnt.txt"), "mnt user aliases storage");
    check(contains(storagePaths, "/data/media/0/mnt.txt"), "mnt user aliases data media");

    check(fh::path_is_hidden(storagePaths, "/storage/emulated/0/secret"),
          "storage view of a data-media rule is hidden");
    check(fh::path_is_hidden(storagePaths, "/sdcard/secret/child"),
          "sdcard child of a data-media rule is hidden");
    check(fh::path_is_hidden(storagePaths, "/mnt/user/0/primary/secret"),
          "mnt user view of a data-media rule is hidden");
    check(!fh::path_is_hidden(storagePaths, "/storage/emulated/1/secret"),
          "another user is not affected");

    if (failures == 0)
        std::printf("all matcher tests passed\n");
    return failures == 0 ? 0 : 1;
}
