#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
case "$target" in
  darwin-arm64|darwin-x64|win32-x64) ;;
  *) echo "Unsupported media runtime target: $target" >&2; exit 2 ;;
esac

project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_archive="${FFMPEG_SOURCE_ARCHIVE:-$project_root/release/media-source/ffmpeg-9.0.1.tar.xz}"
build_root="$project_root/release/media-runtime-build/$target"
source_root="$build_root/ffmpeg-9.0.1"

rm -rf "$build_root"
mkdir -p "$build_root"
tar -xf "$source_archive" -C "$build_root"

jobs=2
if command -v nproc >/dev/null 2>&1; then
  jobs="$(nproc)"
elif command -v sysctl >/dev/null 2>&1; then
  jobs="$(sysctl -n hw.logicalcpu)"
fi

configure_args=(
  --disable-gpl
  --disable-version3
  --disable-nonfree
  --disable-doc
  --disable-debug
  --disable-ffplay
  --disable-network
  --disable-autodetect
  --disable-shared
  --enable-static
  --disable-x86asm
  --extra-cflags=-O2
)

if [[ "$target" == "win32-x64" ]]; then
  configure_args+=(--target-os=mingw32 --arch=x86_64)
  build_targets=(ffmpeg.exe ffprobe.exe)
else
  build_targets=(ffmpeg ffprobe)
fi

cd "$source_root"
./configure "${configure_args[@]}"
make -j"$jobs" "${build_targets[@]}"
cd "$project_root"
if [[ "${SKIP_MEDIA_PACKAGE:-0}" != "1" ]]; then
  node scripts/package_media_runtime.cjs "$target" "$source_root"
fi
