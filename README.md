# kartoteka-runtime

Build inputs and engineering artifacts for the Kartoteka MarkItDown runtime.

## Windows x64 RC3 candidate CI

The manually triggered `Build Windows x64 runtime` workflow runs on the pinned
GitHub-hosted `windows-2025` x64 image. It:

1. downloads the fixed CPython 3.12.13 Windows x64 runtime;
2. verifies the upstream archive size and SHA-256 before extraction;
3. creates a temporary build `venv` and installs only binary wheels from the
   pinned requirements and constraints;
4. creates a full runtime bundle with `runtime/`, `packages/`, `worker/`, and
   `metadata/` directories;
5. verifies Python `3.12.13`, MarkItDown `0.1.6`, and machine `AMD64`;
6. converts all ten fixtures and runs the JSONL worker smoke;
7. uploads the unsigned RC3 candidate bundle, metadata, and target checksum as
   temporary workflow evidence for the planned `runtime-v1.4.0-rc.3` release.

The workflow does not publish or modify a GitHub Release. Its output is an
unsigned engineering artifact and is not production-ready. The common RC3
manifest and `SHA256SUMS.txt` are assembled separately only after both macOS
targets and this Windows target pass their build and fresh-extract checks.
