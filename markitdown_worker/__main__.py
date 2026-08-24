"""CLI entry point for the development MarkItDown worker."""

from __future__ import annotations

import logging
import sys
from contextlib import redirect_stdout

from .conversion import MarkItDownConversionService
from .worker import JsonLineWorker


def configure_standard_streams() -> None:
    """Use a stable pipe encoding on every supported desktop platform."""

    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


def main() -> int:
    configure_standard_streams()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    with redirect_stdout(sys.stderr):
        # Keep third-party import and initialization diagnostics off protocol stdout.
        from markitdown import MarkItDown

        converter = MarkItDown()
    service = MarkItDownConversionService(converter, sys.stderr)
    worker = JsonLineWorker(service, sys.stdin, sys.stdout)
    return worker.run_once()


if __name__ == "__main__":
    raise SystemExit(main())
