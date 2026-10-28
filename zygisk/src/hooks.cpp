#include "hooks.h"

#include <android/log.h>
#include <atomic>
#include <cerrno>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <map>
#include <set>
#include <string>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <unistd.h>
#include <vector>

#include "matcher.h"
#include "zygisk.hpp"

#if defined(__x86_64__) || defined(__i386__)
#include <dobby.h>
#define FH_DOBBY_HOOKS 1
#define FH_SHADOWHOOK_HOOKS 0
#else
#include <shadowhook.h>
#define FH_DOBBY_HOOKS 0
#define FH_SHADOWHOOK_HOOKS 1
#endif

#define FH_INLINE_HOOKS (FH_DOBBY_HOOKS || FH_SHADOWHOOK_HOOKS)

#define LOG_TAG "FileHider"
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

std::vector<std::string> g_hidden;
bool g_active = false;
bool g_inline_active = false;
std::atomic<bool> g_first_hit{false};
std::atomic<bool> g_subprocess_logged{false};
pid_t g_owner_pid = 0;
const char *g_inline_engine = "none";

void note_hidden(const char *path) {
    if (!g_first_hit.exchange(true, std::memory_order_relaxed))
        LOGI("first blocked path: %s", path);
}

// ---------------------------------------------------------------------------
// libc entry points
// ---------------------------------------------------------------------------

using stat_fn = int (*)(const char *, struct stat *);
using fstatat_fn = int (*)(int, const char *, struct stat *, int);
using statx_fn = int (*)(int, const char *, int, unsigned int, void *);
using access_fn = int (*)(const char *, int);
using faccessat_fn = int (*)(int, const char *, int, int);
using open_fn = int (*)(const char *, int, ...);
using open2_fn = int (*)(const char *, int);
using openat_fn = int (*)(int, const char *, int, ...);
using openat2_fn = int (*)(int, const char *, int);
using fopen_fn = FILE *(*)(const char *, const char *);
using opendir_fn = DIR *(*)(const char *);
using readlink_fn = ssize_t (*)(const char *, char *, size_t);
using readlinkat_fn = ssize_t (*)(int, const char *, char *, size_t);
using getdents64_fn = int (*)(int, void *, size_t);
using readdir_fn = struct dirent *(*)(DIR *);
using popen_fn = FILE *(*)(const char *, const char *);
using execve_fn = int (*)(const char *, char *const[], char *const[]);
using execv_fn = int (*)(const char *, char *const[]);
using execvp_fn = int (*)(const char *, char *const[]);

stat_fn real_stat = nullptr;
stat_fn real_lstat = nullptr;
fstatat_fn real_fstatat = nullptr;
statx_fn real_statx = nullptr;
access_fn real_access = nullptr;
faccessat_fn real_faccessat = nullptr;
open_fn real_open = nullptr;
open_fn real_open64 = nullptr;
open2_fn real_open_2 = nullptr;
openat_fn real_openat = nullptr;
openat_fn real_openat64 = nullptr;
openat2_fn real_openat_2 = nullptr;
fopen_fn real_fopen = nullptr;
fopen_fn real_fopen64 = nullptr;
opendir_fn real_opendir = nullptr;
readlink_fn real_readlink = nullptr;
readlinkat_fn real_readlinkat = nullptr;
getdents64_fn real_getdents64 = nullptr;
readdir_fn real_readdir = nullptr;
popen_fn real_popen = nullptr;
execve_fn real_execve = nullptr;
execv_fn real_execv = nullptr;
execvp_fn real_execvp = nullptr;

struct linux_dirent64_compat {
    uint64_t d_ino;
    int64_t d_off;
    unsigned short d_reclen;
    unsigned char d_type;
    char d_name[];
};

bool is_dot(const char *name) {
    return name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'));
}

std::string cwd_path() {
    char buffer[4096];
    if (::getcwd(buffer, sizeof(buffer)) == nullptr)
        return {};
    return buffer;
}

std::string resolve_fd_path(int fd) {
    char link[64];
    std::snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    char buffer[4096];
    ssize_t n;
    if (real_readlink != nullptr) {
        n = real_readlink(link, buffer, sizeof(buffer) - 1);
    } else {
        n = ::readlink(link, buffer, sizeof(buffer) - 1);
    }
    if (n <= 0)
        return {};
    buffer[n] = '\0';
    std::string result(buffer);
    const std::string deleted = " (deleted)";
    if (result.size() > deleted.size() &&
        result.compare(result.size() - deleted.size(), deleted.size(), deleted) == 0) {
        result.resize(result.size() - deleted.size());
    }
    return result;
}

std::string resolve_path(int dirfd, const char *path) {
    if (path == nullptr || *path == '/')
        return path != nullptr ? std::string(path) : std::string();
    if (path[0] == '\0')
        return {};

    std::string base;
    if (dirfd == AT_FDCWD)
        base = cwd_path();
    else
        base = resolve_fd_path(dirfd);
    if (base.empty() || base == "/")
        return fh::join_path("/", path);
    return fh::join_path(base, path);
}

// Children spawned by the app (shell pipelines, ProcessBuilder, popen) do not
// run the app's libc hooks. Rewrite an exact hidden path in the child command
// or argv to a path that cannot exist, so cat/grep/shell tests still report
// ENOENT instead of reading the real file. This deliberately does not replace
// file contents: hiding stays "invisible", not "fake data".
bool path_char(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.' || c == '~';
}

size_t missing_decoy_into(const char *path, size_t length, char *out, size_t capacity) {
    static constexpr char kPrefix[] = "/.filehider_missing_";
    static constexpr char kHex[] = "0123456789abcdef";
    constexpr size_t prefix_length = sizeof(kPrefix) - 1;

    if (out == nullptr || capacity < prefix_length + 17)
        return 0;

    uint64_t hash = 1469598103934665603ULL;
    for (size_t i = 0; i < length; ++i) {
        hash ^= static_cast<unsigned char>(path[i]);
        hash *= 1099511628211ULL;
    }

    // Format manually: snprintf can take a locale lock, which is unsafe in a
    // vfork child. This path runs while ProcessBuilder is between vfork and
    // exec.
    char *cursor = out;
    std::memcpy(cursor, kPrefix, prefix_length);
    cursor += prefix_length;
    for (int shift = 60; shift >= 0; shift -= 4)
        *cursor++ = kHex[(hash >> shift) & 0xF];
    *cursor = '\0';
    return static_cast<size_t>(cursor - out);
}

std::string missing_decoy(const std::string &hidden) {
    char buffer[64];
    const size_t length = missing_decoy_into(hidden.data(), hidden.size(),
                                             buffer, sizeof(buffer));
    return length != 0 ? std::string(buffer, length) : std::string();
}

bool rewrite_hidden_paths(const std::string &input, std::string &output) {
    output.clear();
    if (input.empty() || g_hidden.empty())
        return false;

    bool changed = false;
    size_t pos = 0;
    while (pos < input.size()) {
        bool replaced = false;
        for (const std::string &hidden : g_hidden) {
            if (hidden.size() < 2 || hidden[0] != '/')
                continue;
            if (input.compare(pos, hidden.size(), hidden) != 0)
                continue;

            const bool start_ok =
                pos == 0 || !path_char(input[pos - 1]);
            const size_t end = pos + hidden.size();
            const bool end_ok =
                end == input.size() || !path_char(input[end]);
            if (!start_ok || !end_ok)
                continue;

            output += missing_decoy(hidden);
            pos = end;
            replaced = true;
            changed = true;
            if (g_owner_pid == 0 || ::getpid() == g_owner_pid) {
                note_hidden(hidden.c_str());
                if (!g_subprocess_logged.exchange(true, std::memory_order_relaxed)) {
                    LOGI("subprocess path rewrite active (popen/exec)");
                }
            }
            break;
        }
        if (!replaced)
            output.push_back(input[pos++]);
    }
    return changed;
}

bool contains_hidden_path(const char *input) {
    if (input == nullptr || g_hidden.empty())
        return false;
    for (const std::string &hidden : g_hidden) {
        if (hidden.size() < 2 || hidden[0] != '/')
            continue;
        const char *cursor = input;
        while ((cursor = std::strstr(cursor, hidden.c_str())) != nullptr) {
            const size_t pos = static_cast<size_t>(cursor - input);
            const size_t end = pos + hidden.size();
            const bool start_ok = pos == 0 || !path_char(input[pos - 1]);
            const bool end_ok = input[end] == '\0' || !path_char(input[end]);
            if (start_ok && end_ok)
                return true;
            ++cursor;
        }
    }
    return false;
}

// Buffer-based variant used after fork: no malloc, no logging locks. If the
// output does not fit, the caller leaves the original command untouched.
bool rewrite_hidden_paths_into(const char *input, char *out, size_t capacity,
                               size_t *out_length, bool *overflow) {
    if (out_length != nullptr)
        *out_length = 0;
    if (overflow != nullptr)
        *overflow = false;
    if (out == nullptr || capacity == 0) {
        if (overflow != nullptr)
            *overflow = true;
        return false;
    }
    if (input == nullptr) {
        out[0] = '\0';
        return false;
    }

    size_t pos = 0;
    size_t length = 0;
    bool changed = false;
    while (input[pos] != '\0') {
        bool replaced = false;
        for (const std::string &hidden : g_hidden) {
            if (hidden.size() < 2 || hidden[0] != '/')
                continue;
            if (std::strncmp(input + pos, hidden.c_str(), hidden.size()) != 0)
                continue;

            const bool start_ok = pos == 0 || !path_char(input[pos - 1]);
            const size_t end = pos + hidden.size();
            const bool end_ok = !path_char(input[end]);
            if (!start_ok || !end_ok)
                continue;

            char decoy[64];
            const size_t decoy_length =
                missing_decoy_into(hidden.data(), hidden.size(), decoy, sizeof(decoy));
            if (decoy_length == 0 || length + decoy_length + 1 > capacity) {
                if (overflow != nullptr)
                    *overflow = true;
                return false;
            }
            std::memcpy(out + length, decoy, decoy_length);
            length += decoy_length;
            pos = end;
            replaced = true;
            changed = true;

            // A forked child only calls exec; avoid logging from that context.
            if (g_owner_pid == 0 || ::getpid() == g_owner_pid) {
                note_hidden(hidden.c_str());
                if (!g_subprocess_logged.exchange(true, std::memory_order_relaxed)) {
                    LOGI("subprocess path rewrite active (popen/exec)");
                }
            }
            break;
        }
        if (!replaced) {
            if (length + 2 > capacity) {
                if (overflow != nullptr)
                    *overflow = true;
                return false;
            }
            out[length++] = input[pos++];
        }
    }
    out[length] = '\0';
    if (out_length != nullptr)
        *out_length = length;
    return changed;
}

bool exec_needs_rewrite(const char *path, char *const argv[], size_t *argc,
                        size_t *bytes) {
    bool needed = contains_hidden_path(path);
    size_t count = 0;
    size_t total = 0;
    if (argv != nullptr) {
        while (argv[count] != nullptr) {
            if (argv[count] != nullptr) {
                needed = needed || contains_hidden_path(argv[count]);
                total += std::strlen(argv[count]) + 1;
            }
            ++count;
        }
    }
    if (argc != nullptr)
        *argc = count;
    if (bytes != nullptr)
        *bytes = total;
    return needed;
}

// Copies argv into caller-provided stack storage, rewriting hidden paths.
// Storage is allocated by the hook with alloca() so execv after fork does not
// take the malloc lock.
bool rewrite_exec_argv(char *const argv[], char **out, char *buffer,
                       size_t capacity, size_t argc) {
    if (argv == nullptr)
        return false;
    size_t used = 0;
    for (size_t i = 0; i < argc; ++i) {
        size_t length = 0;
        bool overflow = false;
        rewrite_hidden_paths_into(argv[i] != nullptr ? argv[i] : "",
                                  buffer + used, capacity - used,
                                  &length, &overflow);
        if (overflow)
            return false;
        out[i] = buffer + used;
        used += length + 1;
        if (used > capacity)
            return false;
    }
    out[argc] = nullptr;
    return true;
}

bool hidden_at(int dirfd, const char *path) {
    if (!g_active || path == nullptr || path[0] == '\0')
        return false;
    if (path[0] == '/') {
        if (!fh::path_is_hidden(g_hidden, path))
            return false;
        note_hidden(path);
        return true;
    }
    const std::string resolved = resolve_path(dirfd, path);
    if (!fh::path_is_hidden(g_hidden, resolved))
        return false;
    note_hidden(resolved.c_str());
    return true;
}

mode_t open_mode(int flags, va_list args) {
    mode_t mode = 0;
#ifdef O_TMPFILE
    if (flags & (O_CREAT | O_TMPFILE))
#else
    if (flags & O_CREAT)
#endif
    {
        mode = static_cast<mode_t>(va_arg(args, int));
    }
    return mode;
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

int hook_stat(const char *path, struct stat *buf) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_stat(path, buf);
}

int hook_lstat(const char *path, struct stat *buf) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_lstat(path, buf);
}

int hook_fstatat(int dirfd, const char *path, struct stat *buf, int flags) {
    if (!(flags & AT_EMPTY_PATH) && hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_fstatat(dirfd, path, buf, flags);
}

int hook_statx(int dirfd, const char *path, int flags, unsigned int mask, void *buf) {
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_statx(dirfd, path, flags, mask, buf);
}

int hook_access(const char *path, int mode) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_access(path, mode);
}

int hook_faccessat(int dirfd, const char *path, int mode, int flags) {
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_faccessat(dirfd, path, mode, flags);
}

int hook_open(const char *path, int flags, ...) {
    va_list args;
    va_start(args, flags);
    mode_t mode = open_mode(flags, args);
    va_end(args);
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_open(path, flags, mode);
}

int hook_open64(const char *path, int flags, ...) {
    va_list args;
    va_start(args, flags);
    mode_t mode = open_mode(flags, args);
    va_end(args);
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_open64(path, flags, mode);
}

// Bionic's fortify wrappers for two-argument open/openat. Native JNI
// libraries built by the NDK commonly call these instead of open/openat.
int hook_open_2(const char *path, int flags) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_open_2(path, flags);
}

int hook_openat(int dirfd, const char *path, int flags, ...) {
    va_list args;
    va_start(args, flags);
    mode_t mode = open_mode(flags, args);
    va_end(args);
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_openat(dirfd, path, flags, mode);
}

int hook_openat64(int dirfd, const char *path, int flags, ...) {
    va_list args;
    va_start(args, flags);
    mode_t mode = open_mode(flags, args);
    va_end(args);
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_openat64(dirfd, path, flags, mode);
}

int hook_openat_2(int dirfd, const char *path, int flags) {
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_openat_2(dirfd, path, flags);
}

FILE *hook_fopen(const char *path, const char *mode) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return nullptr;
    }
    return real_fopen(path, mode);
}

FILE *hook_fopen64(const char *path, const char *mode) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return nullptr;
    }
    return real_fopen64(path, mode);
}

DIR *hook_opendir(const char *path) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return nullptr;
    }
    return real_opendir(path);
}

ssize_t hook_readlink(const char *path, char *buf, size_t size) {
    if (hidden_at(AT_FDCWD, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_readlink(path, buf, size);
}

ssize_t hook_readlinkat(int dirfd, const char *path, char *buf, size_t size) {
    if (hidden_at(dirfd, path)) {
        errno = ENOENT;
        return -1;
    }
    return real_readlinkat(dirfd, path, buf, size);
}

int hook_getdents64(int fd, void *dirp, size_t count) {
    int n = real_getdents64(fd, dirp, count);
    if (n <= 0 || !g_active)
        return n;

    const std::string dir = resolve_fd_path(fd);
    if (dir.empty())
        return n;

    char *base = static_cast<char *>(dirp);
    int read_pos = 0;
    int write_pos = 0;
    while (read_pos < n) {
        auto *entry = reinterpret_cast<linux_dirent64_compat *>(base + read_pos);
        if (entry->d_reclen == 0)
            break;
        const std::string full = is_dot(entry->d_name)
                                     ? std::string()
                                     : fh::join_path(dir, entry->d_name);
        const bool hide = !full.empty() && fh::path_is_hidden(g_hidden, full);
        if (hide)
            note_hidden(full.c_str());
        if (!hide) {
            if (write_pos != read_pos)
                std::memmove(base + write_pos, base + read_pos, entry->d_reclen);
            write_pos += entry->d_reclen;
        }
        read_pos += entry->d_reclen;
    }
    return write_pos;
}

struct dirent *hook_readdir(DIR *dir) {
    if (!g_active || dir == nullptr)
        return real_readdir(dir);

    const int fd = ::dirfd(dir);
    const std::string dir_path = fd >= 0 ? resolve_fd_path(fd) : std::string();
    if (dir_path.empty())
        return real_readdir(dir);

    for (;;) {
        struct dirent *entry = real_readdir(dir);
        if (entry == nullptr)
            return nullptr;
        if (is_dot(entry->d_name))
            return entry;
        const std::string full = fh::join_path(dir_path, entry->d_name);
        if (!fh::path_is_hidden(g_hidden, full))
            return entry;
        note_hidden(full.c_str());
    }
}

// ---------------------------------------------------------------------------
// child-process hooks
// ---------------------------------------------------------------------------

FILE *hook_popen(const char *command, const char *type) {
    if (real_popen == nullptr)
        return nullptr;
    if (!g_active || command == nullptr)
        return real_popen(command, type);

    std::string rewritten;
    if (!rewrite_hidden_paths(command, rewritten))
        return real_popen(command, type);
    return real_popen(rewritten.c_str(), type);
}

constexpr size_t kExecRewriteLimit = 128 * 1024;

int hook_execve(const char *path, char *const argv[], char *const envp[]) {
    if (real_execve == nullptr) {
        errno = ENOSYS;
        return -1;
    }
    if (!g_active || path == nullptr)
        return real_execve(path, argv, envp);

    size_t argc = 0;
    size_t bytes = 0;
    if (!exec_needs_rewrite(path, argv, &argc, &bytes) ||
        bytes > kExecRewriteLimit) {
        return real_execve(path, argv, envp);
    }

    char *buffer = static_cast<char *>(
        __builtin_alloca(bytes + 4096 < kExecRewriteLimit
                             ? bytes + 4096
                             : kExecRewriteLimit));
    char **new_argv = static_cast<char **>(
        __builtin_alloca((argc + 1) * sizeof(char *)));
    if (argv != nullptr &&
        !rewrite_exec_argv(argv, new_argv, buffer,
                           bytes + 4096 < kExecRewriteLimit
                               ? bytes + 4096
                               : kExecRewriteLimit,
                           argc)) {
        return real_execve(path, argv, envp);
    }

    char path_buffer[4096];
    const char *final_path = path;
    if (contains_hidden_path(path)) {
        bool overflow = false;
        rewrite_hidden_paths_into(path, path_buffer, sizeof(path_buffer),
                                  nullptr, &overflow);
        if (overflow)
            return real_execve(path, argv, envp);
        final_path = path_buffer;
    }

    return real_execve(final_path, argv != nullptr ? new_argv : nullptr, envp);
}

int hook_execv(const char *path, char *const argv[]) {
    if (real_execv == nullptr) {
        errno = ENOSYS;
        return -1;
    }
    if (!g_active || path == nullptr)
        return real_execv(path, argv);

    size_t argc = 0;
    size_t bytes = 0;
    if (!exec_needs_rewrite(path, argv, &argc, &bytes) ||
        bytes > kExecRewriteLimit) {
        return real_execv(path, argv);
    }

    char *buffer = static_cast<char *>(
        __builtin_alloca(bytes + 4096 < kExecRewriteLimit
                             ? bytes + 4096
                             : kExecRewriteLimit));
    char **new_argv = static_cast<char **>(
        __builtin_alloca((argc + 1) * sizeof(char *)));
    if (argv != nullptr &&
        !rewrite_exec_argv(argv, new_argv, buffer,
                           bytes + 4096 < kExecRewriteLimit
                               ? bytes + 4096
                               : kExecRewriteLimit,
                           argc)) {
        return real_execv(path, argv);
    }

    char path_buffer[4096];
    const char *final_path = path;
    if (contains_hidden_path(path)) {
        bool overflow = false;
        rewrite_hidden_paths_into(path, path_buffer, sizeof(path_buffer),
                                  nullptr, &overflow);
        if (overflow)
            return real_execv(path, argv);
        final_path = path_buffer;
    }

    return real_execv(final_path, argv != nullptr ? new_argv : nullptr);
}

int hook_execvp(const char *file, char *const argv[]) {
    if (real_execvp == nullptr) {
        errno = ENOSYS;
        return -1;
    }
    if (!g_active || file == nullptr)
        return real_execvp(file, argv);

    size_t argc = 0;
    size_t bytes = 0;
    if (!exec_needs_rewrite(file, argv, &argc, &bytes) ||
        bytes > kExecRewriteLimit) {
        return real_execvp(file, argv);
    }

    char *buffer = static_cast<char *>(
        __builtin_alloca(bytes + 4096 < kExecRewriteLimit
                             ? bytes + 4096
                             : kExecRewriteLimit));
    char **new_argv = static_cast<char **>(
        __builtin_alloca((argc + 1) * sizeof(char *)));
    if (argv != nullptr &&
        !rewrite_exec_argv(argv, new_argv, buffer,
                           bytes + 4096 < kExecRewriteLimit
                               ? bytes + 4096
                               : kExecRewriteLimit,
                           argc)) {
        return real_execvp(file, argv);
    }

    char file_buffer[4096];
    const char *final_file = file;
    if (contains_hidden_path(file)) {
        bool overflow = false;
        rewrite_hidden_paths_into(file, file_buffer, sizeof(file_buffer),
                                  nullptr, &overflow);
        if (overflow)
            return real_execvp(file, argv);
        final_file = file_buffer;
    }

    return real_execvp(final_file, argv != nullptr ? new_argv : nullptr);
}

// ---------------------------------------------------------------------------
// installation
// ---------------------------------------------------------------------------

#if FH_SHADOWHOOK_HOOKS

template <typename T>
bool install_symbol(const char *symbol, void *replacement, T *original) {
    void *stub = shadowhook_hook_sym_name("libc.so", symbol, replacement,
                                          reinterpret_cast<void **>(original));
    if (stub == nullptr) {
        int error = shadowhook_get_errno();
        LOGW("  hook %-10s skipped (%d: %s)", symbol, error, shadowhook_to_errmsg(error));
        return false;
    }
    LOGD("  hook %-10s ok, orig=%p", symbol, *reinterpret_cast<void **>(original));
    return true;
}

bool install_all_shadowhook() {
    LOGD("initializing ShadowHook %s...", shadowhook_get_version());
    if (shadowhook_init(SHADOWHOOK_MODE_UNIQUE, false) != 0) {
        int error = shadowhook_get_errno();
        LOGE("shadowhook_init failed (%d: %s)", error, shadowhook_to_errmsg(error));
        if (error == SHADOWHOOK_ERRNO_INIT_LINKER) {
            LOGE("ShadowHook linker init was not disabled at build time; expected "
                 "SH_CONFIG_NO_LINKER_MONITOR for this static build");
        }
        return false;
    }

    static constexpr int kTotalSymbols = 24;
    int installed = 0;
    installed += install_symbol("stat", (void *)hook_stat, &real_stat);
    installed += install_symbol("lstat", (void *)hook_lstat, &real_lstat);
    installed += install_symbol("fstatat", (void *)hook_fstatat, &real_fstatat);
    installed += install_symbol("statx", (void *)hook_statx, &real_statx);
    installed += install_symbol("access", (void *)hook_access, &real_access);
    installed += install_symbol("faccessat", (void *)hook_faccessat, &real_faccessat);
    installed += install_symbol("open", (void *)hook_open, &real_open);
    installed += install_symbol("open64", (void *)hook_open64, &real_open64);
    installed += install_symbol("__open_2", (void *)hook_open_2, &real_open_2);
    installed += install_symbol("openat", (void *)hook_openat, &real_openat);
    installed += install_symbol("openat64", (void *)hook_openat64, &real_openat64);
    installed += install_symbol("__openat_2", (void *)hook_openat_2, &real_openat_2);
    installed += install_symbol("fopen", (void *)hook_fopen, &real_fopen);
    installed += install_symbol("fopen64", (void *)hook_fopen64, &real_fopen64);
    installed += install_symbol("opendir", (void *)hook_opendir, &real_opendir);
    installed += install_symbol("readlink", (void *)hook_readlink, &real_readlink);
    installed += install_symbol("readlinkat", (void *)hook_readlinkat, &real_readlinkat);
    installed += install_symbol("getdents64", (void *)hook_getdents64, &real_getdents64);
    installed += install_symbol("readdir", (void *)hook_readdir, &real_readdir);
    installed += install_symbol("readdir64", (void *)hook_readdir, &real_readdir);
    const bool popen_hooked = install_symbol("popen", (void *)hook_popen, &real_popen);
    const bool execve_hooked =
        install_symbol("execve", (void *)hook_execve, &real_execve);
    const bool execv_hooked =
        install_symbol("execv", (void *)hook_execv, &real_execv);
    const bool execvp_hooked =
        install_symbol("execvp", (void *)hook_execvp, &real_execvp);
    installed += popen_hooked + execve_hooked + execv_hooked + execvp_hooked;

    LOGI("inline hooks installed: %d/%d", installed, kTotalSymbols);
    if (installed == 0)
        LOGE("no libc hooks installed; ShadowHook could not patch anything");
    if (real_getdents64 == nullptr && real_readdir == nullptr)
        LOGW("directory listing hooks are missing; hidden entries may still be listed");
    if (!popen_hooked)
        LOGW("popen hook is missing; shell children may still read hidden paths");
    if (!execve_hooked || !execv_hooked || !execvp_hooked) {
        LOGW("exec hooks incomplete: execve=%d execv=%d execvp=%d; some child "
             "commands may still read hidden paths",
             execve_hooked ? 1 : 0, execv_hooked ? 1 : 0, execvp_hooked ? 1 : 0);
    }
    if (popen_hooked || execve_hooked || execv_hooked || execvp_hooked) {
        LOGI("subprocess hooks: popen=%d execve=%d execv=%d execvp=%d",
             popen_hooked ? 1 : 0, execve_hooked ? 1 : 0,
             execv_hooked ? 1 : 0, execvp_hooked ? 1 : 0);
    }

    const bool can_stat = real_stat != nullptr || real_lstat != nullptr ||
                          real_fstatat != nullptr || real_statx != nullptr;
    const bool can_open = real_open != nullptr || real_open64 != nullptr ||
                          real_open_2 != nullptr || real_openat != nullptr ||
                          real_openat64 != nullptr || real_openat_2 != nullptr ||
                          real_fopen != nullptr || real_fopen64 != nullptr;
    if (!can_stat || !can_open) {
        LOGE("ShadowHook did not cover both stat and open paths; falling back is safer");
        return false;
    }
    return installed > 0;
}

// ShadowHook creates RWX trampoline pages and names them in /proc/self/maps.
// After all hooks are installed those pages are code-only, so drop write
// permission and clear the obvious ShadowHook name. The mapping addresses and
// executable contents are untouched.
int neutralize_shadowhook_maps() {
    FILE *maps = ::fopen("/proc/self/maps", "re");
    if (maps == nullptr)
        return 0;

    char *line = nullptr;
    size_t capacity = 0;
    int hardened = 0;
    int cleared = 0;
    while (::getline(&line, &capacity, maps) > 0) {
        unsigned long long start = 0, end = 0;
        char perms[8] = {};
        int path_offset = 0;
        const int matched = std::sscanf(
            line, "%llx-%llx %7s %*s %*s %*s %n",
            &start, &end, perms, &path_offset);
        if (matched < 3 || path_offset <= 0 || end <= start)
            continue;
        const char *path = line + path_offset;
        if (std::strncmp(path, "[anon:shadowhook", 16) != 0)
            continue;

        const bool executable = std::strchr(perms, 'x') != nullptr;
        if (executable &&
            ::mprotect(reinterpret_cast<void *>(start),
                       static_cast<size_t>(end - start),
                       PROT_READ | PROT_EXEC) == 0) {
            ++hardened;
        }
        if (::prctl(PR_SET_VMA, PR_SET_VMA_ANON_NAME,
                    static_cast<unsigned long>(start),
                    static_cast<unsigned long>(end - start), "") == 0)
            ++cleared;
    }
    std::free(line);
    ::fclose(maps);
    if (hardened > 0 || cleared > 0)
        LOGD("hardened ShadowHook maps: %d RX, cleared=%d", hardened, cleared);
    return hardened;
}

#endif // FH_SHADOWHOOK_HOOKS

#if FH_DOBBY_HOOKS

struct DobbyHookSpec {
    const char *name;
    void *replacement;
    void **original;
};

bool install_all_dobby() {
    const char *version = DobbyGetVersion();
    LOGD("initializing Dobby %s...",
         version != nullptr && version[0] != '\0' ? version : "(x86 backend)");

    const DobbyHookSpec specs[] = {
        {"stat", (void *)hook_stat, reinterpret_cast<void **>(&real_stat)},
        {"lstat", (void *)hook_lstat, reinterpret_cast<void **>(&real_lstat)},
        {"fstatat", (void *)hook_fstatat, reinterpret_cast<void **>(&real_fstatat)},
        {"statx", (void *)hook_statx, reinterpret_cast<void **>(&real_statx)},
        {"access", (void *)hook_access, reinterpret_cast<void **>(&real_access)},
        {"faccessat", (void *)hook_faccessat, reinterpret_cast<void **>(&real_faccessat)},
        {"open", (void *)hook_open, reinterpret_cast<void **>(&real_open)},
        {"open64", (void *)hook_open64, reinterpret_cast<void **>(&real_open64)},
        {"__open_2", (void *)hook_open_2, reinterpret_cast<void **>(&real_open_2)},
        {"openat", (void *)hook_openat, reinterpret_cast<void **>(&real_openat)},
        {"openat64", (void *)hook_openat64, reinterpret_cast<void **>(&real_openat64)},
        {"__openat_2", (void *)hook_openat_2, reinterpret_cast<void **>(&real_openat_2)},
        {"fopen", (void *)hook_fopen, reinterpret_cast<void **>(&real_fopen)},
        {"fopen64", (void *)hook_fopen64, reinterpret_cast<void **>(&real_fopen64)},
        {"opendir", (void *)hook_opendir, reinterpret_cast<void **>(&real_opendir)},
        {"readlink", (void *)hook_readlink, reinterpret_cast<void **>(&real_readlink)},
        {"readlinkat", (void *)hook_readlinkat, reinterpret_cast<void **>(&real_readlinkat)},
        {"getdents64", (void *)hook_getdents64, reinterpret_cast<void **>(&real_getdents64)},
        {"readdir", (void *)hook_readdir, reinterpret_cast<void **>(&real_readdir)},
        {"readdir64", (void *)hook_readdir, reinterpret_cast<void **>(&real_readdir)},
        {"popen", (void *)hook_popen, reinterpret_cast<void **>(&real_popen)},
        {"execve", (void *)hook_execve, reinterpret_cast<void **>(&real_execve)},
        {"execv", (void *)hook_execv, reinterpret_cast<void **>(&real_execv)},
        {"execvp", (void *)hook_execvp, reinterpret_cast<void **>(&real_execvp)},
    };

    static constexpr int kTotalSymbols = sizeof(specs) / sizeof(specs[0]);
    std::map<void *, void *> hooked;
    std::set<void *> attempted;
    int installed = 0;
    int aliases = 0;
    int skipped = 0;
    bool popen_hooked = false;
    bool execve_hooked = false;
    bool execv_hooked = false;
    bool execvp_hooked = false;
    auto mark_subprocess = [&](const char *name, bool ok) {
        if (std::strcmp(name, "popen") == 0)
            popen_hooked = ok;
        else if (std::strcmp(name, "execve") == 0)
            execve_hooked = ok;
        else if (std::strcmp(name, "execv") == 0)
            execv_hooked = ok;
        else if (std::strcmp(name, "execvp") == 0)
            execvp_hooked = ok;
    };

    for (const DobbyHookSpec &spec : specs) {
        void *address = ::dlsym(RTLD_DEFAULT, spec.name);
        if (address == nullptr) {
            LOGI("  hook %-10s skipped (not exported)", spec.name);
            ++skipped;
            continue;
        }

        const auto alias = hooked.find(address);
        if (alias != hooked.end()) {
            // open/open64, fopen/fopen64, readdir/readdir64, ... are often the
            // same symbol on 32-bit bionic. Reuse the first trampoline instead
            // of asking Dobby to hook the same address twice.
            *spec.original = alias->second;
            mark_subprocess(spec.name, true);
            LOGD("  hook %-10s alias of %p, orig=%p", spec.name, address, alias->second);
            ++aliases;
            continue;
        }

        if (attempted.find(address) != attempted.end()) {
            // A previous alias failed. Do not patch the same address twice;
            // keep the dlsym address as a pass-through original.
            *spec.original = address;
            mark_subprocess(spec.name, false);
            LOGW("  hook %-10s skipped (alias of failed %p)", spec.name, address);
            ++skipped;
            continue;
        }
        attempted.insert(address);

        // Keep a pass-through original available while Dobby patches. The
        // process is single-threaded here, but this also protects against a
        // Dobby internal call into a function that is already hooked.
        *spec.original = address;
        void *trampoline = nullptr;
        const int rc = DobbyHook(address, spec.replacement, &trampoline);
        if (rc != 0 || trampoline == nullptr) {
            LOGW("  hook %-10s failed (rc=%d addr=%p)", spec.name, rc, address);
            ++skipped;
            continue;
        }
        *spec.original = trampoline;
        hooked.emplace(address, trampoline);
        mark_subprocess(spec.name, true);
        LOGD("  hook %-10s ok, orig=%p", spec.name, trampoline);
        ++installed;
    }

    LOGI("Dobby inline hooks installed: %d/%d (aliases=%d skipped=%d)",
         installed, kTotalSymbols, aliases, skipped);
    if (installed == 0)
        LOGE("no libc hooks installed; Dobby could not patch anything");
    if (real_getdents64 == nullptr && real_readdir == nullptr)
        LOGW("directory listing hooks are missing; hidden entries may still be listed");
    if (!popen_hooked)
        LOGW("popen hook is missing; shell children may still read hidden paths");
    if (!execve_hooked || !execv_hooked || !execvp_hooked) {
        LOGW("exec hooks incomplete: execve=%d execv=%d execvp=%d; some child "
             "commands may still read hidden paths",
             execve_hooked ? 1 : 0, execv_hooked ? 1 : 0, execvp_hooked ? 1 : 0);
    }
    if (popen_hooked || execve_hooked || execv_hooked || execvp_hooked) {
        LOGI("subprocess hooks: popen=%d execve=%d execv=%d execvp=%d",
             popen_hooked ? 1 : 0, execve_hooked ? 1 : 0,
             execv_hooked ? 1 : 0, execvp_hooked ? 1 : 0);
    }

    const bool can_stat = real_stat != nullptr || real_lstat != nullptr ||
                          real_fstatat != nullptr || real_statx != nullptr;
    const bool can_open = real_open != nullptr || real_open64 != nullptr ||
                          real_open_2 != nullptr || real_openat != nullptr ||
                          real_openat64 != nullptr || real_openat_2 != nullptr ||
                          real_fopen != nullptr || real_fopen64 != nullptr;
    if (!can_stat || !can_open) {
        LOGE("Dobby did not cover both stat and open paths; falling back is safer");
        return false;
    }
    return installed > 0;
}

#endif // FH_DOBBY_HOOKS

// ---------------------------------------------------------------------------
// Zygisk PLT engine
//
// This is a fallback for when the inline engine cannot patch libc. Registering
// every mapped ELF (the old behaviour) overwhelmed Zygisk Next's PLT commit on
// x86: it only needs the Java runtime and the app's own native libraries.
// Keep the set scoped, and commit it in stages so one bad ELF does not discard
// the useful hooks.
// ---------------------------------------------------------------------------

struct ElfId {
    dev_t dev;
    ino_t inode;
    bool operator<(const ElfId &other) const {
        return dev < other.dev || (dev == other.dev && inode < other.inode);
    }
};

std::map<ElfId, std::string> scan_elves() {
    std::map<ElfId, std::string> elves;
    FILE *maps = ::fopen("/proc/self/maps", "re");
    if (maps == nullptr) {
        LOGE("open /proc/self/maps failed: %d", errno);
        return elves;
    }

    char *line = nullptr;
    size_t capacity = 0;
    while (::getline(&line, &capacity, maps) > 0) {
        unsigned long long start = 0, end = 0, offset = 0, inode = 0;
        unsigned int major = 0, minor = 0;
        char perms[8] = {0};
        int path_offset = 0;
        int matched = std::sscanf(line,
                                  "%llx-%llx %7s %llx %x:%x %llu %n",
                                  &start, &end, perms, &offset, &major, &minor, &inode,
                                  &path_offset);
        if (matched < 7)
            continue;
        const char *path = line + path_offset;
        if (path[0] != '/')
            continue;
        if (std::strstr(path, ".so") == nullptr && std::strstr(path, "app_process") == nullptr)
            continue;
        if (inode == 0)
            continue;
        const ElfId id{static_cast<dev_t>(makedev(major, minor)),
                       static_cast<ino_t>(inode)};
        if (elves.find(id) == elves.end())
            elves.emplace(id, path);
    }
    std::free(line);
    ::fclose(maps);
    return elves;
}

bool is_primary_plt_elf(const std::string &path) {
    return path.find("libjavacore.so") != std::string::npos ||
           path.find("libopenjdk.so") != std::string::npos ||
           path.find("libart.so") != std::string::npos ||
           path.find("libandroid_runtime.so") != std::string::npos ||
           path.find("/app_process") != std::string::npos;
}

bool is_app_plt_elf(const std::string &path) {
    if (path.find("libfilehider.so") != std::string::npos)
        return false;
    if (path.rfind("/data/adb/", 0) == 0)
        return false;
    // An APK mapping has a "!/" suffix and cannot be parsed as a standalone
    // ELF by LSPlt. App-owned extracted libraries are normal paths.
    if (path.find("!/") != std::string::npos)
        return false;
    return path.rfind("/data/app/", 0) == 0 ||
           path.rfind("/data/data/", 0) == 0 ||
           path.rfind("/data/user/", 0) == 0 ||
           path.rfind("/data/local/tmp/", 0) == 0;
}

bool is_selected_plt_elf(const std::string &path) {
    return is_primary_plt_elf(path) || is_app_plt_elf(path);
}

int plt_group_for_path(const std::string &path) {
    if (path.find("libjavacore.so") != std::string::npos ||
        path.find("libopenjdk.so") != std::string::npos)
        return 0;
    if (path.find("libart.so") != std::string::npos)
        return 1;
    if (path.find("libandroid_runtime.so") != std::string::npos)
        return 2;
    if (path.find("/app_process") != std::string::npos)
        return 3;
    return 4; // app-owned native library
}

bool install_all_plt(zygisk::Api *api) {
    const std::map<ElfId, std::string> elves = scan_elves();
    if (elves.empty()) {
        LOGE("no ELF mappings found in /proc/self/maps");
        return false;
    }

    struct PltGroup {
        const char *label;
        std::vector<ElfId> elfs;
    };
    std::vector<PltGroup> groups = {
        {"javacore", {}},
        {"art", {}},
        {"runtime", {}},
        {"app_process", {}},
        {"app", {}},
    };

    size_t selected = 0;
    for (const auto &entry : elves) {
        const std::string &path = entry.second;
        if (!is_selected_plt_elf(path))
            continue;
        const int group = plt_group_for_path(path);
        groups[group].elfs.push_back(entry.first);
        LOGD("  PLT target: %s", path.c_str());
        ++selected;
    }

    LOGI("PLT scan: %zu ELFs, selected %zu (javacore=%zu art=%zu runtime=%zu "
         "app_process=%zu app=%zu)",
         elves.size(), selected, groups[0].elfs.size(), groups[1].elfs.size(),
         groups[2].elfs.size(), groups[3].elfs.size(), groups[4].elfs.size());
    if (selected == 0) {
        LOGE("no libjavacore/libart/libandroid_runtime/app_process/app ELF selected");
        return false;
    }
    if (groups[0].elfs.empty())
        LOGW("libjavacore.so is not mapped; Java file APIs may not be intercepted");

    struct PltSymbol {
        const char *name;
        void *replacement;
        void **original;
    };
    const PltSymbol symbols[] = {
        {"stat", (void *)hook_stat, reinterpret_cast<void **>(&real_stat)},
        {"lstat", (void *)hook_lstat, reinterpret_cast<void **>(&real_lstat)},
        {"fstatat", (void *)hook_fstatat, reinterpret_cast<void **>(&real_fstatat)},
        {"statx", (void *)hook_statx, reinterpret_cast<void **>(&real_statx)},
        {"access", (void *)hook_access, reinterpret_cast<void **>(&real_access)},
        {"faccessat", (void *)hook_faccessat, reinterpret_cast<void **>(&real_faccessat)},
        {"open", (void *)hook_open, reinterpret_cast<void **>(&real_open)},
        {"open64", (void *)hook_open64, reinterpret_cast<void **>(&real_open64)},
        {"__open_2", (void *)hook_open_2, reinterpret_cast<void **>(&real_open_2)},
        {"openat", (void *)hook_openat, reinterpret_cast<void **>(&real_openat)},
        {"openat64", (void *)hook_openat64, reinterpret_cast<void **>(&real_openat64)},
        {"__openat_2", (void *)hook_openat_2, reinterpret_cast<void **>(&real_openat_2)},
        {"fopen", (void *)hook_fopen, reinterpret_cast<void **>(&real_fopen)},
        {"fopen64", (void *)hook_fopen64, reinterpret_cast<void **>(&real_fopen64)},
        {"opendir", (void *)hook_opendir, reinterpret_cast<void **>(&real_opendir)},
        {"readlink", (void *)hook_readlink, reinterpret_cast<void **>(&real_readlink)},
        {"readlinkat", (void *)hook_readlinkat, reinterpret_cast<void **>(&real_readlinkat)},
        {"getdents64", (void *)hook_getdents64, reinterpret_cast<void **>(&real_getdents64)},
        {"readdir", (void *)hook_readdir, reinterpret_cast<void **>(&real_readdir)},
        {"readdir64", (void *)hook_readdir, reinterpret_cast<void **>(&real_readdir)},
        {"popen", (void *)hook_popen, reinterpret_cast<void **>(&real_popen)},
        {"execve", (void *)hook_execve, reinterpret_cast<void **>(&real_execve)},
        {"execv", (void *)hook_execv, reinterpret_cast<void **>(&real_execv)},
        {"execvp", (void *)hook_execvp, reinterpret_cast<void **>(&real_execvp)},
    };

    std::vector<const PltSymbol *> usable;
    for (const PltSymbol &symbol : symbols) {
        // PLT hooks leave libc itself unpatched, so dlsym gives the real function.
        void *original = ::dlsym(RTLD_DEFAULT, symbol.name);
        if (original == nullptr) {
            LOGI("  sym %-10s not exported, skipped", symbol.name);
            continue;
        }
        *symbol.original = original;
        usable.push_back(&symbol);
        LOGD("  sym %-10s orig=%p", symbol.name, original);
    }
    if (usable.empty())
        return false;

    auto commit_group = [&](const char *label, const std::vector<ElfId> &elfs,
                            const std::vector<const PltSymbol *> &syms) -> bool {
        if (elfs.empty() || syms.empty())
            return false;
        int registrations = 0;
        for (const PltSymbol *symbol : syms) {
            for (const ElfId &elf : elfs) {
                api->pltHookRegister(elf.dev, elf.inode, symbol->name,
                                     symbol->replacement, nullptr);
                ++registrations;
            }
        }
        const bool committed = api->pltHookCommit();
        LOGI("PLT stage %s: %zu ELFs x %zu symbols (%d registrations), commit=%d",
             label, elfs.size(), syms.size(), registrations, committed ? 1 : 0);
        return committed;
    };

    // If javacore rejects the full symbol set, retry with the entries Java
    // file/list operations actually use. Other groups are not retried: the
    // app libraries are optional coverage, and repeated commits add noise.
    std::vector<const PltSymbol *> minimal;
    static const char *const kMinimalNames[] = {
        "stat", "lstat", "access", "open", "openat", "opendir", "readdir",
    };
    for (const PltSymbol *symbol : usable) {
        for (const char *name : kMinimalNames) {
            if (std::strcmp(symbol->name, name) == 0) {
                minimal.push_back(symbol);
                break;
            }
        }
    }

    bool any_committed = false;
    for (PltGroup &group : groups) {
        if (group.elfs.empty())
            continue;
        bool committed = commit_group(group.label, group.elfs, usable);
        if (!committed && std::strcmp(group.label, "javacore") == 0 &&
            !minimal.empty()) {
            LOGW("PLT stage javacore failed; retrying with minimal symbol set");
            committed = commit_group("javacore-min", group.elfs, minimal);
        }
        any_committed = any_committed || committed;
    }

    LOGI("PLT hooks: %zu/%zu symbols over %zu selected ELFs, commit=%d",
         usable.size(), sizeof(symbols) / sizeof(symbols[0]), selected,
         any_committed ? 1 : 0);
    if (!any_committed)
        LOGE("pltHookCommit failed for every selected stage (Zygisk API v5 is required)");
    return any_committed;
}

} // namespace

namespace fh {

bool install_inline_hooks(const std::vector<std::string> &hidden_paths) {
#if FH_DOBBY_HOOKS
    g_hidden = hidden_paths;
    g_inline_engine = "Dobby";
    const bool installed = install_all_dobby();
#elif FH_SHADOWHOOK_HOOKS
    g_hidden = hidden_paths;
    g_inline_engine = "ShadowHook";
    const bool installed = install_all_shadowhook();
#else
    (void)hidden_paths;
    const bool installed = false;
#endif
    if (!installed) {
        g_hidden.clear();
        g_active = false;
        g_inline_active = false;
        g_inline_engine = "none";
        return false;
    }
#if FH_SHADOWHOOK_HOOKS
    neutralize_shadowhook_maps();
#endif
    g_owner_pid = ::getpid();
    g_active = true;
    g_inline_active = true;
    LOGI("hooks active (inline/%s), %zu hidden path(s)", g_inline_engine,
         g_hidden.size());
    return true;
}

bool install_plt_hooks(void *zygisk_api, const std::vector<std::string> &hidden_paths) {
    if (zygisk_api == nullptr)
        return false;
    g_hidden = hidden_paths;
    if (!install_all_plt(static_cast<zygisk::Api *>(zygisk_api))) {
        g_hidden.clear();
        g_active = false;
        return false;
    }
    g_owner_pid = ::getpid();
    g_active = true;
    g_inline_active = false;
    LOGI("hooks active (PLT), %zu hidden path(s)", g_hidden.size());
    return true;
}

bool inline_hooks_active() {
    return g_inline_active;
}

} // namespace fh
