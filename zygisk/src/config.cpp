#include "config.h"

#include <cerrno>
#include <fcntl.h>
#include <unistd.h>

namespace fh {

namespace {

constexpr size_t kMaxConfigSize = 1u << 20; // 1 MiB is plenty

struct Loaded {
    bool ok = false;
    std::string text;
    int error = 0;
};

bool read_all(int fd, std::string &out, int &error) {
    char buffer[4096];
    out.clear();
    for (;;) {
        ssize_t n = ::read(fd, buffer, sizeof(buffer));
        if (n == 0)
            return true;
        if (n < 0) {
            if (errno == EINTR)
                continue;
            error = errno;
            return false;
        }
        if (out.size() + static_cast<size_t>(n) > kMaxConfigSize) {
            error = EFBIG;
            return false;
        }
        out.append(buffer, static_cast<size_t>(n));
    }
}

Loaded load_path(const char *path) {
    Loaded loaded;
    const int fd = ::open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        loaded.error = errno;
        return loaded;
    }
    if (!read_all(fd, loaded.text, loaded.error)) {
        ::close(fd);
        return loaded;
    }
    ::close(fd);
    loaded.ok = true;
    return loaded;
}

} // namespace

ConfigResult read_targets_config() {
    ConfigResult result;

    Loaded data = load_path("/data/adb/filehider/targets.conf");
    if (!data.ok) {
        result.last_error = data.error;
        return result;
    }

    result.text = data.text;
    result.source = "data";
    return result;
}

} // namespace fh
