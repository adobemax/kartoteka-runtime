#!/usr/bin/env bash
set -euo pipefail

source_directory="${1:-release/media-source}"
archive="$source_directory/ffmpeg-9.0.1.tar.xz"
signature="$source_directory/ffmpeg-9.0.1.tar.xz.asc"
key="$source_directory/ffmpeg-devel.asc"

expected_archive_sha256="cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635"
expected_signature_sha256="b613a00005232a1245ace7080088781ac23a916119d3e5b0d6c042368eee0177"
expected_key_sha256="397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5"
expected_fingerprint="FCF986EA15E6E293A5644F10B4322F04D67658D8"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_digest() {
  actual="$(sha256 "$1")"
  if [[ "$actual" != "$2" ]]; then
    echo "SHA-256 mismatch for $(basename "$1")" >&2
    exit 1
  fi
}

verify_digest "$archive" "$expected_archive_sha256"
verify_digest "$signature" "$expected_signature_sha256"
verify_digest "$key" "$expected_key_sha256"

if ! command -v gpg >/dev/null 2>&1; then
  echo "gpg is required to verify the official FFmpeg release signature" >&2
  exit 1
fi

verification_home="$(mktemp -d "${TMPDIR:-/tmp}/marknot-ffmpeg-gpg.XXXXXX")"
trap 'rm -rf "$verification_home"' EXIT
chmod 700 "$verification_home"
gpg --batch --homedir "$verification_home" --import "$key" >/dev/null 2>&1
fingerprints="$(gpg --batch --homedir "$verification_home" --with-colons --fingerprint | awk -F: '$1 == "fpr" { print $10 }')"
if ! grep -Fxq "$expected_fingerprint" <<<"$fingerprints"; then
  echo "FFmpeg release key fingerprint mismatch" >&2
  exit 1
fi
gpg --batch --homedir "$verification_home" --verify "$signature" "$archive"
