---
title: "Starting with import std: Modern C++ Toolchain Best Practices"
date: "2026-10-06 14:40:30"
updated: "2026-10-08 09:01:36"
zhihu_article_id: "2090994886531100694"
zhihu_url: https://zhuanlan.zhihu.com/p/2090994886531100694
---

> TL;DR: [xclang](https://github.com/clice-io/xclang) is a cross-compiling Clang toolchain we developed for clice—essentially rustup for Clang. It bundles the compiler, linker, and sysroots with prebuilt runtimes for all six x64 and arm64 targets across Linux, Windows, and macOS into a single archive under 100 MB, so cross-compiling just takes passing `--target`. Compiled binaries statically link the C++ runtime: copy a single file over and it runs on Linux with glibc 2.17+, Windows 10+, and macOS 13+. Apple and Microsoft SDKs are not bundled; users can download them from official sources with `xclang sdk fetch`, making it possible to build for macOS and MSVC targets even on Linux. It integrates directly with CMake and Bazel, with `import std` working out of the box. The compiler itself is built with PGO + ThinLTO, matching official LLVM releases in C++ compilation speed and running even faster on Windows.

In [Building an Elegant Cross-Platform C++ Development and Build Workflow](https://www.ykiko.me/en/articles/1985940996270339378), we used pixi to unify clice's development environment across all three platforms, eliminating any dependency on system toolchains on Linux. However, that post left one problem unsolved at the end: Windows and macOS SDKs cannot be redistributed due to licensing restrictions, so developers still had to install MSVC and the Windows SDK, or the Xcode Command Line Tools themselves. At the time, my conclusion was that "there is no ideal workaround for this yet." Recently we built xclang, finally giving this problem a fairly complete solution.

## Background

That setup actually had another problem beyond the SDKs. clice was using three different C++ standard libraries across the three platforms: MSVC STL on Windows, libstdc++ on Linux, and libc++ on macOS. Meanwhile, clice planned to migrate to C++20 modules (after all, we need to support modules ourselves), and getting `import std` working reliably across all three platforms is impossible when juggling three different standard libraries. Right now, Clang has the best module support and libc++ has the most complete `std` module, so the best path forward is using Clang + libc++ across all three platforms.

Why not use Clang with the system libstdc++ on Linux? libstdc++ also provides a `std` module, which seems like a natural choice. Honestly, we went down that path before and hit a ton of pitfalls, mostly due to compiler bugs in the modules implementation. It is hard for tests to cover every edge case—each compiler is tested most thoroughly against its own standard library—and standard libraries are full of complex templates, so I do not recommend pairing Clang with libstdc++'s `std` module. I won't go into the details here; we will write a dedicated post about modules later.

So we needed a toolchain that uses Clang + libc++ on all three platforms, targets an older glibc on Linux, and has a way to handle the Windows and macOS SDK issue. That led to [xclang](https://github.com/clice-io/xclang), an out-of-the-box cross-compiling Clang toolchain that bundles the entire toolchain together: compiler, linker, binary utilities, and sysroots plus runtimes for six targets. Those six targets are Linux x64 and arm64 (glibc 2.17), Windows x64 and arm64 (MinGW-w64 + UCRT), and macOS arm64 and x64. Prebuilt libc++, libc++abi, libunwind, and compiler-rt are included for every target, along with C library headers and libraries for the Linux and MinGW targets, while the macOS C library comes from Apple's SDK. Cross-compiling only takes passing `--target`, for example

```bash
clang++ --target=aarch64-w64-mingw32 hello.cpp -o hello.exe
```

Starting with 23.1.2.7, it also supports MSVC targets—Windows x64 and arm64 using Microsoft's CRT and STL—which can be built from any host. The compiler is vanilla LLVM plus a few patches that are being upstreamed, with packages available for all six hosts (x64 and arm64 across Linux, Windows, and macOS). Each package is only 86 to 94 MB; by comparison, official LLVM release archives are 0.9 to 2 GB, only include runtimes for the host itself, and ship no sysroots for other targets.

Previously, cross-compiling usually meant setting up a separate toolchain per target—distro packages, MinGW GCC, or Docker images—each running a different compiler version. With xclang, all targets share the exact same compiler: when a compiler bug is fixed or a warning is added, every target gets it at once.

xclang was built for clice, and clice's release builds were the first to use it. [catter](https://github.com/clice-io/catter) also builds with it, and xclang's own CI cross-compiles [kotatsu](https://github.com/clice-io/kotatsu)'s tests for Windows on Linux and then runs them on Windows.

## import std

Many people know C++20 introduced modules, but aren't sure what they actually look like in practice or whether they are usable today. The good news is that you can try them right now. Create a new directory and add the following `CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.28)

include(FetchContent)
FetchContent_Declare(xclang
    GIT_REPOSITORY https://github.com/clice-io/xclang
    GIT_TAG latest)
FetchContent_MakeAvailable(xclang)
include(${xclang_SOURCE_DIR}/packages/cmake/xclang.cmake)

project(hello LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(xclang REQUIRED CONFIG)

add_executable(hello main.cpp)
target_link_libraries(hello PRIVATE xclang::std)
```

and `main.cpp`

```cpp
import std;

int main() {
    std::vector<std::string> targets{"windows", "linux", "macos"};
    std::ranges::sort(targets);
    try {
        throw std::runtime_error(std::format("{} targets, the first {}", targets.size(), targets[0]));
    } catch (const std::exception& e) {
        std::println("hello from xclang: {}", e.what());
    }
}
```

Then run

```bash
cmake -G Ninja -B build
cmake --build build
```

During configuration, FetchContent downloads the toolchain for the current host into the user cache directory (`GIT_TAG latest` is a branch pointing to the latest release), so nothing needs to be pre-installed on the machine other than CMake 3.28 and Ninja 1.11. To cross-compile for another target, pass the toolchain file `lib/cmake/xclang/toolchain.cmake` from the xclang directory along with `-DXCLANG_TARGET=x86_64-w64-mingw32`, and `xclang::std` will be built for that target as well. Besides CMake, Bazel works out of the box too: just add `@xclang//bazel:std` to `deps` (requires Bazel 9 with `--experimental_cpp_modules` enabled). You can also install xclang via pixi/conda, release archives, or the Bazel registry—all of them give you the exact same toolchain. See the [documentation](https://docs.clice.io/xclang/) for details.

Getting a toy `import std` demo running isn't actually hard—the CMake documentation, LLVM, and GCC all have ready-made examples. The real challenge is using it in production. In [Beyond the Language Server](https://www.ykiko.me/en/articles/2069934520514749368), I quoted the saying: "Modules are a solved problem in the compiler frontend, and an unsolved problem everywhere else." Usable modules require the compiler, build system, and build cache to work together. clice is a fairly large project that has now migrated to modules, and we ran into plenty of corner cases along the way.

First, the `std` module must be compiled with the same flags as the translation units that import it, which means you cannot simply ship a precompiled `std` module. If language options used when building a module file—such as `-std`, GNU extensions, `-fno-exceptions`, or `-fno-rtti`—differ from those of the importing file, Clang flat-out refuses to load it (macros, include search paths, and optimization levels can differ, though). If a CMake target requests a newer language standard than the one `std` was built with, you get errors like `C++26 was disabled in precompiled file`. That is why xclang compiles `std` and `std.compat` during each build using that build's flags, exposing them as a regular library target you link against—`xclang::std` in the example above. If a specific CMake target uses different flags from the rest, you can call `xclang_add_std(<name>)` to generate a dedicated one for it.

`xclang::std` doesn't rely on CMake's experimental gates either. CMake's built-in `import std` support still requires enabling `CMAKE_EXPERIMENTAL_CXX_IMPORT_STD` as of 4.4, and the value required for that variable changes across CMake versions. By contrast, `xclang::std` is just an ordinary library target whose sources happen to be module interface units, so standard CMake 3.28 module support is all it needs.

Next is build caching. ccache does not support modules yet—it doesn't hash the contents of module files when computing cache keys, so it can't be used on modularized projects. Bazel, on the other hand, supports modules because it computes keys from the contents of all inputs to each action, module files included. When compiling modules, xclang also passes `-fmodule-file-home-is-cwd` so paths embedded inside module files are relative to the execution root, allowing all machines to share a single cache. clice's CI builds with Bazel.

> Note: neither CMake nor Bazel currently builds header units (`import <vector>;`)

## Design

### Config files

Clang locates each target's sysroot and runtimes through configuration files. When compiling for a target, Clang reads the matching config file—for instance, `--target=aarch64-w64-mingw32` reads `aarch64-w64-windows-gnu.cfg` next to `clang++`. xclang places one in `bin/` for every target. For example, a Linux target's config file sets that target's `--sysroot`, `-rtlib=compiler-rt -unwindlib=libunwind -stdlib=libc++`, `-static-libstdc++ -static-libgcc`, and `-fuse-ld=lld`. All paths inside are relative, so the toolchain works wherever you extract it. These config files apply to native builds as well: running `clang++ main.cpp` directly on Linux still targets glibc 2.17, regardless of the host machine's glibc.

In our earliest release (23.1.2.1), we actually baked these defaults directly into Clang at build time (via options like `CLANG_DEFAULT_CXX_STDLIB`). However, those defaults live in the driver, and libclang also contains a copy of the driver. To find header search paths, clice uses Clang's driver in place of `g++` commands in the compilation database; with those defaults compiled in, the driver computed libc++ header paths instead of libstdc++ for `g++` commands. Starting in 23.1.2.2, we moved all defaults into config files so the driver inside libclang behaves identically to upstream Clang, and passing `--no-default-config` gives you a stock Clang.

The sysroots themselves are just plain directories—any Clang of the same major version can cross-compile with them once pointed to `--sysroot` and `-resource-dir`. The config files are plain text as well, so you can open them up to see the exact flags used for any target.

### Hermeticity

By hermeticity here, we mean that compiled binaries at runtime only depend on OS-provided libraries that cannot be redistributed with the application—such as glibc on Linux, libSystem on macOS, and system DLLs plus UCRT on Windows—while everything else is statically linked into the binary, and at build time the only external input besides the toolchain itself is the vendor SDK. As a result, a compiled program is a single file that you can copy to any machine running Linux with glibc 2.17+, Windows 10+, or macOS 13+ and run directly. The trade-off is a larger binary size, and the fact that each shared library gets its own copy of libc++. On Linux and macOS, a standard library exception thrown in one shared library can only be caught with `catch (...)` in another, so interfaces between shared libraries are best kept as C APIs.

### Vendor SDKs

Now back to the question left open at the end of that workflow post. Both Apple's SDK license and the Visual Studio license permit usage but prohibit redistribution, so xclang does not distribute SDKs; instead, users download them directly from the vendors. Starting with 23.1.2.7, every archive includes an `xclang` command written in Rust. Once the user accepts the license (`--accept-license`), `xclang sdk fetch` downloads the SDK at a pinned version and sha256, keeping xclang's own packages freely redistributable. You need to fetch SDKs this way when building for MSVC targets, or when cross-compiling for macOS on Linux and Windows; on macOS, xclang uses Xcode's SDK directly.

Downloading the SDKs does not require installing Xcode or Visual Studio. Apple's SDK is actually inside the Command Line Tools installer package, which can be downloaded directly from Apple's servers without an Apple ID. The installer is in xar format, containing pbzx (made up of xz chunks), which in turn contains cpio. xclang reads all three layers with its own code—just a few hundred lines in total—so it can download and extract the SDK on any host. That said, SDKs for iOS and other devices only ship inside the full Xcode bundle and require an Apple ID; that is an unavoidable limitation.

On the Microsoft side, the CRT and STL come from Visual Studio's own `.vsix` packages, while the Windows SDK comes from `Microsoft.Windows.SDK.CPP` on NuGet. Both are zip archives that can be extracted on any host. A well-known tool that does something similar is xwin, which takes the route of unpacking MSI/CAB files and doesn't have binaries for macOS or Windows arm64—two platforms xclang specifically needs to run on.

For MSVC targets, xclang uses what Microsoft calls the hybrid CRT: the VC runtime and STL are linked statically (equivalent to `/MT`), while the UCRT uses `ucrtbase.dll`, which is built into Windows 10 and later. This way, the binary only loads Windows's own DLLs, while sharing the same heap, `errno`, and stdio across all DLLs it loads.

### PGO

How fast the compiler itself runs largely determines how long builds take. In 23.1.2.1, if the compiler was built without a profile, compiling fmt took 1.15x to 1.37x as long as the official LLVM release, whereas applying a profile cut compile times by 16% to 34%. xclang's Clang and lld are built with PGO + ThinLTO on every host, using the same profile collected on Linux.

During training, instrumented builds of Clang, clang-scan-deps, and lld run what they actually run in day-to-day use: compiling C and C++ codebases like sqlite and abseil with `-O0 -g` and `-O2`, building precompiled headers and preambles used by editors, compiling C++20 modules (including libc++'s `std` and `std.compat`), running P1689 dependency scans invoked by CMake, serving code completion requests, and running ELF, ThinLTO, and COFF links through lld. The full training run invokes the compiler around 1,700 times and takes 23 minutes, producing one profile per release that is published alongside the release.

Why is a single profile from Linux enough? That comes down to the two instrumentation modes. IR instrumentation (`-fprofile-generate`) inserts counters on LLVM IR after early optimization passes and identifies functions using a hash of the control flow graph at that point. Because those passes use the target platform's cost model, the same function does not have the same control flow graph on x86-64 and arm64, so a profile collected on one platform won't match on another. Frontend instrumentation (`-fprofile-instr-generate`, i.e. `LLVM_BUILD_INSTRUMENTED=Frontend`), on the other hand, places counters on Clang's AST and hashes functions from the source code, which is identical across all platforms.

xclang uses frontend instrumentation. In experiments prior to 23.1.2.1, a profile collected on Linux x64 had only 0 or 1 mismatched functions out of 113,000 across all six hosts, and the speed difference compared to merging separate IR profiles from all six hosts was within noise—for example, when compiling abseil on Linux x64, the time ratio relative to a non-PGO build was 0.725 for the former and 0.722 for the latter. This way, training only needs to run once on a Linux runner, without building and training instrumented binaries on each host separately or needing an emulator.

There is still one catch here: profiles look up functions by their mangled names, and `size_t` and `uint64_t` are `unsigned long` (`m`) on Linux, whereas on Windows they are `unsigned long long` (`y`); `uint64_t` on macOS is also `unsigned long long`, and `int64_t` likewise differs between `l` and `x`. As a result, a function taking a `size_t` parameter gets a different mangled name on Windows and receives no profile counts at all. xclang passes a `toolchain/pgo/remap.txt` via `-fprofile-remapping-file` to tell the compiler that these manglings are equivalent. With that added, the compile-time ratio for abseil and LLVM's `Sema` dropped from 0.896 / 0.923 to 0.794 / 0.845 on macOS arm64, and went from 0.787 / 0.824 to 0.772 / 0.829 on Windows x64.

Benchmarks run on code not seen during training: ten tests from fmt, lua's C sources, and precompiling libc++'s `std` module, each compiled one file at a time with `-fsyntax-only`, `-O0 -g`, and `-O2`. The compilers take turns running on the same machine across multiple rounds; we take the median across rounds, and then the median across five runners per host, comparing against the official LLVM release build of the same version. Below is the time ratio of 23.1.2.6 relative to LLVM 23.1.2, where less than 1 means faster

| host          | fmt (syntax / O0 / O2) | lua (syntax / O0 / O2) | std (O0 / O2) |
| ------------- | ---------------------- | ---------------------- | ------------- |
| Linux x64     | 1.035 / 1.009 / 1.069  | 1.118 / 1.062 / 1.109  | 1.013 / 1.022 |
| Linux arm64   | 1.000 / 0.976 / 1.042  | 1.082 / 1.011 / 1.075  | 0.970 / 0.994 |
| macOS arm64   | 0.902 / 0.935 / 1.014  | 1.169 / 0.971 / 0.959  | 0.980 / 0.890 |
| Windows x64   | 0.798 / 0.825 / 0.890  | 1.083 / 1.050 / 1.001  | 0.777 / 0.849 |
| Windows arm64 | 0.888 / 0.906 / 0.954  | 1.271 / 1.212 / 1.167  | 0.925 / 0.940 |

Note that runner noise is significant, so differences of a few percentage points don't really mean much. On Linux x64, the official LLVM release applies BOLT on top, so xclang is slightly slower there; on Windows, the official Clang is built with MSVC with PGO only and no LTO. On Windows, `clang++.exe` is just a launcher stub that spawns `llvm.exe` to do the actual work, adding an extra process creation that is noticeable on small C files. Compared against Apple's own Clang on both macOS architectures, Apple Clang takes 17% to 29% longer than xclang to compile fmt, while compiling lua's C code ranges from 25% faster to 5% slower.

## Comparison

The tool closest in approach to xclang is zig cc. Below is a comparison with it and the official LLVM releases

|                                  | xclang                                                    | zig cc                                           | Official LLVM Release                             |
| -------------------------------- | --------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| Targets                          | x64 and arm64 on Linux, Windows (MinGW, MSVC), macOS      | Dozens                                           | Host only                                         |
| sysroot and SDK                  | Bundled sysroot, SDK downloaded by user                   | Ships libc sources and stubs, built on first use | None                                              |
| C++ runtime in binaries          | Statically linked libc++ (Microsoft STL for MSVC targets) | Statically linked libc++                         | Host runtime only                                 |
| glibc required by Linux binaries | 2.17+                                                     | Selectable per target, 2.31 default              | Build machine version (Ubuntu 22.04)              |
| Compiler PGO                     | PGO + ThinLTO on all hosts                                | Unspecified                                      | PGO + ThinLTO on Linux/macOS, PGO only on Windows |
| Download size                    | 86–94 MB                                                  | 55 MB                                            | 0.9–2 GB                                          |

zig cc also works right after downloading and cross-compiles by passing `-target`. The difference is that zig ships the sources for libc++, libc++abi, libunwind, compiler-rt, and several C libraries, building them on the spot the first time a target is used and caching the result, which keeps its download archive very small. xclang instead ships prebuilt runtimes for all six targets directly, so there is no wait on first use and everyone gets byte-for-byte identical runtimes. Two of the reasons I passed on zig cc back in that workflow post were tied to how it packages its libraries: it puts headers from all glibc versions together and differentiates them with macros, causing `__has_include` to misfire; and when it builds libc++ on the fly, it doesn't build modules, nor could I get it to use a libc++ module I built myself, leaving `import std` unusable.

That said, zig cc does currently support more targets, such as musl, various BSDs, and WASI, and lets you pick any glibc version per target (for example `x86_64-linux-gnu.2.17`). It can compile for macOS targets from any host using Apple's libc headers and a `libSystem` stub, whereas xclang uses the official Apple SDK downloaded by the user. In addition, zig 0.17.0 uses LLVM 22 and disables loop vectorization to work around a regression, while xclang tracks LLVM releases and uses vanilla Clang aside from the few patches mentioned earlier; zig also omits the ASan runtime, and its `windows-msvc` target requires Visual Studio to be installed locally.

Most other solutions only cover part of the picture. cross-rs runs cargo with GCC cross-toolchains inside Docker images (glibc 2.31, or 2.17 in the `:centos` image), and provides no images for Apple targets "due to licensing reasons"—the exact same problem we ran into originally. llvm-mingw only supports Windows and links the libc++ DLL unless you pass `-static`. conda-forge's compilers (which pixi used in that workflow post) add the C++ runtime from the conda package to the binary's runtime dependencies via `run_exports`; that is fine inside a conda environment, but once the binary is taken outside the conda environment, nothing is there to install those dependencies. Android NDK and wasi-sdk do bundle Clang and sysroots together just like xclang, except xclang targets desktop platforms. For a more complete comparison, see [xclang's documentation](https://docs.clice.io/xclang/).

## How it was built

All of xclang's code was written by agents, using Opus 5.5 throughout. The first commit was on September 21, 2026, and as of October 7 there are 177 commits and 8 releases from 23.1.2.1 through 23.1.2.8. The whole process ran across 1 lead session and 23 worker sessions, using 294 subagents and making 9,403 tool calls, 7,623 of which were shell commands. It produced roughly 19,000 lines of code—including scripts, tests, CMake and Bazel configurations, the CLI tool in Rust, and CI workflows—plus around 42,000 words of documentation.

This kind of work is actually particularly well-suited for agents. Building LLVM once takes around two hours, and tracking down an issue often takes many iterations. If I were doing it myself, most of the time would be spent waiting on CI, and I couldn't possibly watch it non-stop, whereas an agent can keep trying 24 hours a day. In fact, nearly half of all tool calls happened between midnight and 6 a.m. Beijing time. On work like this, agents are far more efficient than humans: for instance, one major documentation overhaul covered 37 pages, with every single command actually run across six machines, and was finished in a single night.

Heavy builds are all offloaded to CI while only lightweight work happens locally. When an agent needs to build and test on Windows, macOS, or Linux, it rents real GitHub Actions runners via `box`. Cross-compiled binaries are also copied to real machines of the target platform to run, without using emulators, all of which relies heavily on CI concurrency. GitHub's free tier runs at most 20 concurrent jobs (and only 5 on macOS), so we specifically bought GitHub Enterprise to raise concurrency to 500 jobs (50 on macOS), which improved efficiency tremendously in practice. So far, CI has run 278 workflows and 4,988 jobs totaling roughly 499 runner hours, including 75 runs of the full release pipeline.

Along the way, the agents ran a lot of experiments, for example

- Exception handling issue in ld64.lld: In testing for the first version, a program compiled and linked with ThinLTO failed to catch an exception it threw itself on arm64 macOS and called terminate directly. Switching to the official LLVM ld64.lld did the same thing, so we temporarily switched the macOS target linker to Apple's ld. We eventually tracked it down to an empty object file produced by the LTO backend whose sole symbol `ltmp0` had the same address as `main`, causing ld64.lld to let it take `main`'s slot in `__unwind_info`. With the upstream fix applied, macOS switched back to ld64.lld starting in 23.1.2.5
- ThinLTO caching: For libclang-based tools, ThinLTO link caching makes a huge difference—relinking clice on Linux x64 takes 353 seconds, vs. around 6 seconds with a warm cache. The agent also found that when GitHub Actions restores a cache, it sets the access time of every file to the restoration time, so the linker's cache pruning never triggers and the cache only grows larger, with clice's cache reaching 350 to 650 MB
- Reproducible builds: Each host's package is built once on each of two machines and required to be byte-for-byte identical (sorting tar entries, using the commit timestamp, stripping owners, and chunking xz into fixed-size blocks)
- Package size: Clang, lld, and most binary utilities are combined into a single `llvm` binary with each tool name being a link to it. Together with a few other changes, this brought the Windows x64 package down from a 540 MB zip to 82 MB, and Linux x64 from 148 MB down to 83 MB (sizes at the time). A shared libLLVM was also considered, but we decided against it for speed reasons

We also ran into quite a few upstream bugs. Currently xclang carries 8 patches on top of LLVM, mainly covering:

- Clang: partial ordering of templates (triggering code completion inside a class template crashed Clang), code completion (two fixes), finding Visual Studio via the Setup API in MinGW-built Clang, and line numbers for raw string literals under CRLF in `clang -E`
- libc++: when `std::format_to` writes into a container, an argument whose length is an exact multiple of 256 writes past the 256-code-unit stack buffer
- lld: the Mach-O unwind issue mentioned above
- TextAPI: reading `arm64e.x1` in the macOS 27 SDK

Once official LLVM releases include the corresponding fixes, these patches will be dropped.

## Roadmap

Right now xclang ships with the six most commonly used targets; going forward, additional targets will be packaged separately and downloaded on demand via `xclang target add`. For options not covered by the prebuilt runtimes, such as MemorySanitizer and libc++ hardening, we plan to support building runtimes from source when needed. Among new targets, musl Linux x64 and arm64 (which can produce fully static binaries) are already planned, while newer glibc versions, more Linux architectures, WebAssembly, Android, BSD, and bare-metal targets are under consideration, and the iOS family is being investigated.

MSVC targets will later support using libc++ as the C++ standard library. xclang's Bazel module currently cannot build MSVC targets or build macOS targets on Linux and Windows—those only work with CMake right now, and Bazel support will be added later. The PGO training set will also continue to expand to include Objective-C, clang-cl, Mach-O linking, and clang-tidy checks, with BOLT under investigation. We will also keep tracking upstream LLVM versions, including 23.1.3 with the `arm64e.x1` fix, and 24.x after that.

Finally, a quick word on clice. clice has now migrated to C++ modules, following the direction set in [clice in the Agent Era](https://www.ykiko.me/en/articles/2034883949630059124); we will cover the pitfalls we ran into during the migration in detail in that upcoming post on modules.

Thanks for reading! If you're interested, feel free to join our QQ group: [https://qm.qq.com/q/tSD3D81fpu](https://qm.qq.com/q/tSD3D81fpu), and if you run into any issues with xclang, feel free to open an issue directly on [GitHub](https://github.com/clice-io/xclang).
