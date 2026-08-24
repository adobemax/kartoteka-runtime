"""Validated conversion request model."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, Mapping

from .errors import (
    FileNotFoundWorkerError,
    InvalidRequestError,
    UnsupportedFormatError,
)


@dataclass(frozen=True)
class ConversionRequest:
    """A validated request for one local document conversion."""

    request_id: str
    file_path: Path

    ALLOWED_EXTENSIONS: ClassVar[frozenset[str]] = frozenset(
        {
            ".pdf",
            ".docx",
            ".pptx",
            ".xls",
            ".html",
            ".htm",
            ".txt",
            ".csv",
            ".json",
            ".xml",
        }
    )
    ALLOWED_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"id", "command", "filePath"}
    )

    @classmethod
    def from_payload(cls, payload: Any) -> "ConversionRequest":
        if not isinstance(payload, Mapping):
            raise InvalidRequestError("The request must be a JSON object")

        unexpected_fields = set(payload) - cls.ALLOWED_FIELDS
        if unexpected_fields:
            raise InvalidRequestError("The request contains unsupported fields")

        request_id = payload.get("id")
        if not isinstance(request_id, str) or not request_id.strip():
            raise InvalidRequestError("The request id must be a non-empty string")

        if payload.get("command") != "convert":
            raise InvalidRequestError("The command must be 'convert'")

        raw_path = payload.get("filePath")
        if (
            not isinstance(raw_path, str)
            or not raw_path.strip()
            or "\x00" in raw_path
        ):
            raise InvalidRequestError("filePath must be a non-empty path string")

        file_path = Path(raw_path)
        if not file_path.is_absolute() or cls._is_unc_path(file_path):
            raise InvalidRequestError("filePath must be an absolute local path")

        extension = file_path.suffix.lower()
        if extension not in cls.ALLOWED_EXTENSIONS:
            raise UnsupportedFormatError(extension)

        if not file_path.is_file():
            raise FileNotFoundWorkerError()

        return cls(request_id=request_id, file_path=file_path)

    @staticmethod
    def _is_unc_path(file_path: Path) -> bool:
        anchor = file_path.anchor.replace("/", "\\")
        return anchor.startswith("\\\\")
