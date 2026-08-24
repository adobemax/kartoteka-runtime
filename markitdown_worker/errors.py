"""Stable protocol errors for the MarkItDown worker."""

from __future__ import annotations

from typing import Final


class WorkerError(Exception):
    """Base error whose code and public message are safe for JSON responses."""

    code: str

    def __init__(self, code: str, public_message: str) -> None:
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message


class InvalidRequestError(WorkerError):
    CODE: Final = "INVALID_REQUEST"

    def __init__(self, message: str = "The conversion request is invalid") -> None:
        super().__init__(self.CODE, message)


class UnsupportedFormatError(WorkerError):
    CODE: Final = "UNSUPPORTED_FORMAT"

    def __init__(self, extension: str) -> None:
        label = extension or "<none>"
        super().__init__(self.CODE, f"Unsupported document format: {label}")


class FileNotFoundWorkerError(WorkerError):
    CODE: Final = "FILE_NOT_FOUND"

    def __init__(self) -> None:
        super().__init__(self.CODE, "The input file was not found")


class ConversionFailedError(WorkerError):
    CODE: Final = "CONVERSION_FAILED"

    def __init__(self) -> None:
        super().__init__(self.CODE, "Document conversion failed")
