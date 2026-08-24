"""Single-request JSON Lines worker."""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol, TextIO

from .conversion import ConversionResult
from .errors import ConversionFailedError, InvalidRequestError, WorkerError
from .request import ConversionRequest


class ConversionService(Protocol):
    def convert(self, request: ConversionRequest) -> ConversionResult:
        """Convert one validated request."""


class JsonLineWorker:
    """Reads one JSON command, writes one JSON response, then exits."""

    MAX_REQUEST_CHARACTERS = 65_536

    def __init__(
        self,
        conversion_service: ConversionService,
        input_stream: TextIO,
        output_stream: TextIO,
        logger: logging.Logger | None = None,
    ) -> None:
        self._conversion_service = conversion_service
        self._input_stream = input_stream
        self._output_stream = output_stream
        self._logger = logger or logging.getLogger(__name__)

    def run_once(self) -> int:
        request_id: str | None = None
        try:
            line = self._input_stream.readline(self.MAX_REQUEST_CHARACTERS + 1)
            if not line:
                raise InvalidRequestError("Expected one JSON request line")
            if len(line) > self.MAX_REQUEST_CHARACTERS:
                raise InvalidRequestError("The request line is too large")

            payload = self._decode_payload(line)
            request_id = self._request_id_from(payload)
            request = ConversionRequest.from_payload(payload)
            result = self._conversion_service.convert(request)
            response: dict[str, Any] = {
                "id": request.request_id,
                "ok": True,
                "markdown": result.markdown,
                "metadata": result.metadata,
            }
        except WorkerError as error:
            self._logger.warning("Worker request failed with %s", error.code)
            response = self._error_response(request_id, error)
        except Exception:
            self._logger.exception("Unexpected worker failure")
            response = self._error_response(request_id, ConversionFailedError())

        self._write_response(response)
        return 0

    @staticmethod
    def _decode_payload(line: str) -> Any:
        try:
            return json.loads(line)
        except (json.JSONDecodeError, UnicodeError) as error:
            raise InvalidRequestError("The request line is not valid JSON") from error

    @staticmethod
    def _request_id_from(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        request_id = payload.get("id")
        return request_id if isinstance(request_id, str) and request_id.strip() else None

    @staticmethod
    def _error_response(request_id: str | None, error: WorkerError) -> dict[str, Any]:
        return {
            "id": request_id,
            "ok": False,
            "error": {"code": error.code, "message": error.public_message},
        }

    def _write_response(self, response: dict[str, Any]) -> None:
        json.dump(
            response,
            self._output_stream,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        self._output_stream.write("\n")
        self._output_stream.flush()
