cmake_minimum_required(VERSION 3.20)
project(filehider LANGUAGES C CXX ASM)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(SHADOWHOOK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/shadowhook")

add_library(filehider SHARED
    src/main.cpp
    src/matcher.cpp
    src/config.cpp
    src/hooks.cpp
)

target_compile_options(filehider PRIVATE
    -O2
    -fvisibility=hidden
    -fvisibility-inlines-hidden
    -Wall
    -Wextra
    -Wno-unused-parameter
)

target_include_directories(filehider PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(filehider PRIVATE log dl)

# ShadowHook has arm/arm64 backends. x86/x86_64 use Dobby inline hooks; the
# Zygisk PLT engine remains a fallback if the inline engine cannot patch libc.
if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(SH_ARCH "arm64")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(SH_ARCH "arm")
else()
    set(SH_ARCH "")
endif()

if(NOT SH_ARCH STREQUAL "")
    file(GLOB SHADOWHOOK_SOURCES
        "${SHADOWHOOK_DIR}/*.c"
        "${SHADOWHOOK_DIR}/arch/${SH_ARCH}/*.c"
        "${SHADOWHOOK_DIR}/arch/${SH_ARCH}/*.S"
        "${SHADOWHOOK_DIR}/common/*.c"
        "${SHADOWHOOK_DIR}/third_party/*/*.c"
    )
    target_sources(filehider PRIVATE ${SHADOWHOOK_SOURCES})
    # We statically link ShadowHook and do not ship libshadowhook_nothing.so.
    # The dlopen monitor needs that helper, so skip it: only libc (already
    # loaded) is hooked, and catch-all symbol resolution does not need it.
    target_compile_definitions(filehider PRIVATE SH_CONFIG_NO_LINKER_MONITOR=1)
    target_include_directories(filehider PRIVATE
        "${SHADOWHOOK_DIR}"
        "${SHADOWHOOK_DIR}/include"
        "${SHADOWHOOK_DIR}/arch/${SH_ARCH}"
        "${SHADOWHOOK_DIR}/common"
        "${SHADOWHOOK_DIR}/third_party/xdl"
        "${SHADOWHOOK_DIR}/third_party/bsd"
        "${SHADOWHOOK_DIR}/third_party/lss"
    )
endif()

# Dobby has x86/x86_64 inline-hook backends. Build it only for those ABIs.
if(ANDROID_ABI STREQUAL "x86" OR ANDROID_ABI STREQUAL "x86_64")
    set(DOBBY_BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
    set(DOBBY_BUILD_TEST OFF CACHE BOOL "" FORCE)
    set(DOBBY_BUILD_KERNEL_MODE OFF CACHE BOOL "" FORCE)
    set(Plugin.SymbolResolver OFF CACHE BOOL "" FORCE)
    set(Plugin.ImportTableReplace OFF CACHE BOOL "" FORCE)
    add_subdirectory(
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dobby"
        "${CMAKE_CURRENT_BINARY_DIR}/dobby"
        EXCLUDE_FROM_ALL
    )
    target_compile_definitions(filehider PRIVATE FH_DOBBY_HOOKS=1)
    target_include_directories(filehider PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/dobby/include"
    )
    target_link_libraries(filehider PRIVATE dobby_static)
endif()

# Android 15+ ships 16 KB page devices. Aligning every ABI is harmless.
target_link_options(filehider PRIVATE
    -Wl,-z,max-page-size=16384
    -Wl,-z,common-page-size=16384
    -Wl,--gc-sections
)

# Keep the Zygisk entry points and strip everything else.
target_link_options(filehider PRIVATE -Wl,--exclude-libs,ALL)
