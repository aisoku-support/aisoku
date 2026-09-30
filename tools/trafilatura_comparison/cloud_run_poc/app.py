"""Minimal Cloud Run HTTP service for Trafilatura Precision extraction."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import socket
import time

from auth import AUTH_HEADER, configured_secret, is_authorized
import trafilatura
from lxml import html as lhtml

try:
    MAX_HTML_BYTES = int(os.environ.get("MAX_HTML_BYTES", str(2 * 1024 * 1024)))
except ValueError as exc:
    raise RuntimeError("MAX_HTML_BYTES must be an integer") from exc
if MAX_HTML_BYTES <= 0:
    raise RuntimeError("MAX_HTML_BYTES must be greater than zero")
READ_TIMEOUT_SECONDS = 5


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def extract_precision(raw_html: str) -> dict:
    started = time.perf_counter()
    try:
        extracted_html = trafilatura.extract(
            raw_html,
            output_format="html",
            include_comments=True,
            include_tables=True,
            favor_precision=True,
        ) or ""
    except Exception as exc:
        raise ExtractionError(type(exc).__name__) from None

    try:
        root = lhtml.fromstring(extracted_html or "<div></div>")
        paragraphs = [
            normalize_space("".join(node.itertext()))
            for node in root.xpath(".//p|.//h1|.//h2|.//h3|.//li")
        ]
        paragraphs = [paragraph for paragraph in paragraphs if paragraph]
        body = normalize_space(" ".join(paragraphs))
        paragraph_count = len(paragraphs)
    except Exception:
        body = normalize_space(extracted_html)
        paragraph_count = 0

    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    return {
        "body": body,
        "text_chars": len(body),
        "paragraph_count": paragraph_count,
        "processing_ms": elapsed_ms,
    }


class ExtractionError(Exception):
    """Safe extraction failure that does not retain input or exception text."""


class Handler(BaseHTTPRequestHandler):
    server_version = "TrafilaturaPrecisionPoC/1.0"

    def log_message(self, _format, *_args):
        # Do not emit request bodies, extracted text, or URLs into application logs.
        return

    def send_json(self, status: int, value: dict):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            try:
                secret = configured_secret()
            except RuntimeError:
                self.close_connection = True
                self.log_event(503, error_type="service_unconfigured")
                self.send_json(503, {"error": "service_unconfigured"})
                return
            if not is_authorized(self.headers.get(AUTH_HEADER), secret):
                self.close_connection = True
                self.log_event(401, error_type="unauthorized")
                self.send_json(401, {"error": "unauthorized"})
                return
            self.send_json(200, {"status": "ok", "trafilatura_version": trafilatura.__version__})
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/extract":
            self.send_json(404, {"error": "not_found"})
            return

        try:
            secret = configured_secret()
        except RuntimeError:
            self.close_connection = True
            self.log_event(503, error_type="service_unconfigured")
            self.send_json(503, {"error": "service_unconfigured"})
            return
        if not is_authorized(self.headers.get(AUTH_HEADER), secret):
            self.close_connection = True
            self.log_event(401, error_type="unauthorized")
            self.send_json(401, {"error": "unauthorized"})
            return
        content_encoding = self.headers.get("Content-Encoding", "identity").strip().lower()
        if content_encoding not in ("", "identity"):
            self.close_connection = True
            self.log_event(415, error_type="content_encoding_unsupported")
            self.send_json(415, {"error": "content_encoding_unsupported"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            content_length = -1
        if content_length < 0:
            self.close_connection = True
            self.log_event(411, error_type="content_length_required")
            self.send_json(411, {"error": "content_length_required"})
            return
        if content_length > MAX_HTML_BYTES:
            self.close_connection = True
            self.log_event(413, html_bytes=content_length, error_type="html_too_large")
            self.send_json(413, {"error": "html_too_large", "max_bytes": MAX_HTML_BYTES})
            return

        self.connection.settimeout(READ_TIMEOUT_SECONDS)
        body_started = time.perf_counter()
        body_timeout = False
        try:
            chunks = []
            bytes_read = 0
            while bytes_read < content_length and bytes_read <= MAX_HTML_BYTES:
                chunk = self.rfile.read(min(
                    64 * 1024,
                    content_length - bytes_read,
                    MAX_HTML_BYTES + 1 - bytes_read,
                ))
                if not chunk:
                    break
                chunks.append(chunk)
                bytes_read += len(chunk)
            raw_bytes = b"".join(chunks)
        except (TimeoutError, socket.timeout):
            body_timeout = True
        finally:
            self.connection.settimeout(None)
        if body_timeout or time.perf_counter() - body_started > READ_TIMEOUT_SECONDS:
            self.close_connection = True
            self.log_event(408, error_type="body_read_timeout")
            try:
                self.send_json(408, {"error": "body_read_timeout"})
            except OSError:
                pass
            return
        if len(raw_bytes) > MAX_HTML_BYTES:
            self.close_connection = True
            self.log_event(413, html_bytes=len(raw_bytes), error_type="html_too_large")
            self.send_json(413, {"error": "html_too_large", "max_bytes": MAX_HTML_BYTES})
            return
        if len(raw_bytes) != content_length:
            self.log_event(400, html_bytes=len(raw_bytes), error_type="incomplete_body")
            self.send_json(400, {"error": "incomplete_body"})
            return

        request_started = time.perf_counter()
        raw_html = raw_bytes.decode("utf-8", errors="replace")
        try:
            result = extract_precision(raw_html)
        except ExtractionError as exc:
            self.log_event(422, html_bytes=len(raw_bytes), error_type=str(exc))
            self.send_json(422, {"error": "extraction_failed"})
            return
        result["text_chars"] = len(result["body"])
        result["trafilatura_version"] = trafilatura.__version__
        self.log_event(
            200,
            processing_ms=result["processing_ms"],
            html_bytes=len(raw_bytes),
            text_chars=result["text_chars"],
            extractor=f"trafilatura/{trafilatura.__version__}",
        )
        self.send_json(200, result)

    def log_event(self, status: int, **fields):
        # Only explicitly supplied metrics are emitted; never log headers,
        # request paths, request bodies, or exception messages.
        event = {"status": status, **fields}
        print(json.dumps(event, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    configured_secret()
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
