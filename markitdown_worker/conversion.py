"""MarkItDown adapter with normalized conversion failures."""

from __future__ import annotations

import logging
from contextlib import redirect_stdout
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TextIO

from .errors import ConversionFailedError
from .request import ConversionRequest


class LocalDocumentConverter(Protocol):
    def convert_local(self, path: str | Path, **kwargs: Any) -> Any:
        """Convert a local file and return a MarkItDown-compatible result."""


@dataclass(frozen=True)
class ConversionResult:
    markdown: str
    metadata: dict[str, str]


class MarkItDownConversionService:
    """Converts validated local requests without exposing converter exceptions."""

    def __init__(
        self,
        converter: LocalDocumentConverter,
        diagnostic_stream: TextIO,
        logger: logging.Logger | None = None,
    ) -> None:
        self._converter = converter
        self._diagnostic_stream = diagnostic_stream
        self._logger = logger or logging.getLogger(__name__)

    def convert(self, request: ConversionRequest) -> ConversionResult:
        try:
            # Third-party converters must never be able to corrupt the JSONL stdout.
            with redirect_stdout(self._diagnostic_stream):
                raw_result = self._converter.convert_local(request.file_path)
            markdown = getattr(raw_result, "markdown", None)
            if not isinstance(markdown, str):
                raise TypeError("MarkItDown returned a result without Markdown text")

            metadata: dict[str, str] = {}
            title = getattr(raw_result, "title", None)
            if isinstance(title, str) and title:
                metadata["title"] = title
            return ConversionResult(markdown=markdown, metadata=metadata)
        except Exception as error:
            self._logger.error(
                "MarkItDown conversion failed for %s (%s)",
                request.file_path.name,
                type(error).__name__,
            )
            raise ConversionFailedError() from error
