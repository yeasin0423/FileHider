#include <jni.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "config.h"
#include "hooks.h"
#include "matcher.h"
#include "zygisk.hpp"

#define LOG_TAG "FileHider"
#define FH_VERSION "v3.1"
#include <android/log.h>
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

constexpr size_t kSelfTestPaths = 3;

const char *module_abi() {
#if defined(__aarch64__)
    return "arm64-v8a";
#elif defined(__arm__)
    return "armeabi-v7a";
#elif defined(__x86_64__)
    return "x86_64";
#elif defined(__i386__)
    return "x86";
#else
    return "unknown";
#endif
}

// Zygisk injects the host ABI on Bliss OS/libhoudini, not necessarily the
// app's primaryCpuAbi. Seeing the bridge here explains translated apps.
std::string native_bridge() {
    FILE *maps = ::fopen("/proc/self/maps", "re");
    if (maps == nullptr)
        return "unknown";
    std::string result = "none";
    char *line = nullptr;
    size_t capacity = 0;
    while (::getline(&line, &capacity, maps) > 0) {
        if (std::strstr(line, "libhoudini") != nullptr) {
            result = "houdini";
            break;
        }
        if (std::strstr(line, "libndk_translation") != nullptr) {
            result = "ndk_translation";
            break;
        }
    }
    std::free(line);
    ::fclose(maps);
    return result;
}

std::string join_paths(const std::vector<std::string> &paths, size_t limit) {
    std::string out;
    for (size_t i = 0; i < paths.size() && i < limit; ++i) {
        if (!out.empty())
            out += ", ";
        out += paths[i];
    }
    if (paths.size() > limit)
        out += ", …";
    return out;
}

class FileHiderModule : public zygisk::ModuleBase {
public:
    void onLoad(zygisk::Api *api, JNIEnv *env) override {
        api_ = api;
        env_ = env;
        LOGD("onLoad: %s abi=%s bits=%zu api=%p env=%p", FH_VERSION, module_abi(),
             sizeof(void *) * 8, (void *)api, (void *)env);
    }

    void preAppSpecialize(zygisk::AppSpecializeArgs *args) override {
        if (api_ == nullptr || env_ == nullptr || args == nullptr || args->nice_name == nullptr) {
            LOGD("preAppSpecialize: missing api/env/nice_name");
            unload_module();
            return;
        }

        const char *raw = env_->GetStringUTFChars(args->nice_name, nullptr);
        std::string process = raw != nullptr ? raw : "";
        if (raw != nullptr)
            env_->ReleaseStringUTFChars(args->nice_name, raw);
        if (process.empty()) {
            LOGD("preAppSpecialize: empty process name");
            unload_module();
            return;
        }
        if (process == "system_server") {
            LOGD("preAppSpecialize: refusing to hook system_server");
            unload_module();
            return;
        }

        const fh::ConfigResult config = fh::read_targets_config();

        if (config.source.empty()) {
            LOGW("%s: no targets.conf (last_errno=%d)", process.c_str(), config.last_error);
            LOGW("status config-missing process=%s", process.c_str());
            unload_module();
            return;
        }

        const std::vector<fh::Rule> rules = fh::parse_rules(config.text);
        LOGD("%s: config=%s bytes=%zu rules=%zu", process.c_str(),
             config.source.c_str(), config.text.size(), rules.size());

        if (rules.empty()) {
            if (fh::has_disabled_packages(config.text)) {
                LOGD("%s: config has inactive app rules only; no hooks", process.c_str());
            } else if (fh::has_rule_text(config.text)) {
                LOGW("%s: config has non-comment lines but no valid rules; expected "
                     "'<package> <absolute path>'",
                     process.c_str());
            } else {
                LOGD("%s: config has no rules yet", process.c_str());
            }
            LOGW("status no-rules process=%s", process.c_str());
            unload_module();
            return;
        }

        const std::vector<std::string> hidden = fh::paths_for_process(rules, process);
        if (hidden.empty()) {
            LOGD("%s: no rule matches this process", process.c_str());
            unload_module();
            return;
        }

        LOGI("target=%s paths=%zu [%s]", process.c_str(), hidden.size(),
             join_paths(hidden, 6).c_str());
        LOGI("process=%s abi=%s bits=%zu bridge=%s", process.c_str(), module_abi(),
             sizeof(void *) * 8, native_bridge().c_str());

        // Check visibility before installing hooks, so the post-check has a baseline.
        const size_t checks = hidden.size() < kSelfTestPaths ? hidden.size() : kSelfTestPaths;
        std::vector<int> pre_errno;
        pre_errno.reserve(checks);
        for (size_t i = 0; i < checks; ++i) {
            struct stat st {};
            errno = 0;
            const int lr = ::lstat(hidden[i].c_str(), &st);
            const int le = errno;
            pre_errno.push_back(le);
            const char *state = lr == 0 ? "exists"
                                        : (le == EACCES ? "zygote EACCES" : "missing");
            LOGI("pre  %s lstat=%d errno=%d (%s)", hidden[i].c_str(), lr, le, state);
            if (lr != 0 && le == EACCES) {
                LOGI("pre  %s is not accessible to zygote (EACCES). For shared storage, "
                     "apps normally use /storage/emulated/0/...; the rule also matches "
                     "that form.",
                     hidden[i].c_str());
            } else if (lr != 0) {
                LOGW("pre  %s is not visible before hooks; hiding it will not change "
                     "what the app sees. Check the path.",
                     hidden[i].c_str());
            }
        }

        bool ok = fh::install_inline_hooks(hidden);
        if (!ok) {
            LOGW("inline hooks unavailable; falling back to Zygisk PLT hooks");
            ok = fh::install_plt_hooks(api_, hidden);
        }
        if (!ok) {
            LOGE("hook installation failed for %s", process.c_str());
            LOGE("status failed target=%s abi=%s reason=install", process.c_str(),
                 module_abi());
            // Do not request DLCLOSE here. A failed inline attempt can leave
            // some libc symbols patched; unmapping our replacement code would
            // crash the next call into those symbols.
            return;
        }

        const bool inline_engine = fh::inline_hooks_active();
        if (!inline_engine) {
            LOGI("self-test skipped: PLT hooks cover caller ELFs, not module code; "
                 "watch for the app's first blocked path instead");
        }

        // Self-test: call the libc entry points again and look for ENOENT.
        // PLT installations cannot block the module's own calls, so only run
        // this when libc itself was patched by an inline engine.
        bool self_test_failed = false;
        for (size_t i = 0; inline_engine && i < checks; ++i) {
            struct stat st {};
            errno = 0;
            const int lr = ::lstat(hidden[i].c_str(), &st);
            const int le = errno;
            errno = 0;
            const int ar = ::access(hidden[i].c_str(), F_OK);
            const int ae = errno;
            errno = 0;
            const int orr = ::open(hidden[i].c_str(), O_RDONLY | O_CLOEXEC);
            const int oe = errno;
            if (orr >= 0)
                ::close(orr);
            if (pre_errno[i] == ENOENT) {
                LOGI("post %s absent before hooks (lstat=%d errno=%d access=%d errno=%d "
                     "open=%d errno=%d); nothing to verify",
                     hidden[i].c_str(), lr, le, ar, ae, orr, oe);
                continue;
            }
            const bool blocked = (lr != 0 && le == ENOENT) &&
                                 (ar != 0 && ae == ENOENT) &&
                                 (orr < 0 && oe == ENOENT);
            LOGI("post %s lstat=%d errno=%d access=%d errno=%d open=%d errno=%d -> %s",
                 hidden[i].c_str(), lr, le, ar, ae, orr, oe,
                 blocked ? "BLOCKED" : "still visible");
            if (!blocked) {
                self_test_failed = true;
                LOGE("self-test: %s is still visible after hooks; hiding will not work",
                     hidden[i].c_str());
            }
        }

        if (self_test_failed) {
            LOGE("status failed target=%s abi=%s reason=self-test", process.c_str(),
                 module_abi());
        } else {
            LOGI("status working target=%s abi=%s engine=%s", process.c_str(),
                 module_abi(), inline_engine ? "inline" : "plt");
        }
    }

    void preServerSpecialize(zygisk::ServerSpecializeArgs *args) override {
        (void)args; // never touch system_server
        unload_module();
    }

private:
    // Safely unmap the module from processes where no hooks were installed.
    // This prevents the module itself from appearing in Native Detector's
    // soinfo/maps scan. Never call it after hook installation.
    void unload_module() {
        if (api_ != nullptr) {
            LOGD("module unload requested (no hooks installed)");
            api_->setOption(zygisk::Option::DLCLOSE_MODULE_LIBRARY);
        }
    }

    zygisk::Api *api_ = nullptr;
    JNIEnv *env_ = nullptr;
};

} // namespace

REGISTER_ZYGISK_MODULE(FileHiderModule)
