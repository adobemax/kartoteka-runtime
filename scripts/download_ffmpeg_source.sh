#!/usr/bin/env bash
set -euo pipefail

destination="${1:-release/media-source}"
mkdir -p "$destination"

download() {
  url="$1"
  target="$2"
  temporary="$target.part"
  rm -f "$temporary"
  curl --fail --location --silent --show-error "$url" --output "$temporary"
  mv "$temporary" "$target"
}

download "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz" "$destination/ffmpeg-9.0.1.tar.xz"
download "https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz.asc" "$destination/ffmpeg-9.0.1.tar.xz.asc"
download "https://ffmpeg.org/ffmpeg-devel.asc" "$destination/ffmpeg-devel.asc"
