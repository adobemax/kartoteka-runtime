# kartoteka-runtime

Build inputs and engineering artifacts for the Kartoteka MarkItDown runtime.

## Windows x64 CI

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
7. uploads the unsigned bundle, metadata, and checksums as temporary workflow
   evidence.

The workflow does not publish a GitHub Release. Its output is an unsigned
engineering artifact and is not production-ready.
