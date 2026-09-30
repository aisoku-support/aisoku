"""Local unit/integration tests for the private extraction endpoint."""

import contextlib
import io
import json
import os
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

import app
from auth import AUTH_HEADER, SECRET_ENV


SECRET = "test-only-secret-never-log-this"
FIXTURE = Path(__file__).resolve().parents[2] / "readability_defuddle_comparison" / "runs" / "2026-09-22T07-26-43-315Z" / "html" / "598128468a5e594b5023d997d90ad6c4.html"


class ExtractionTests(unittest.TestCase):
    def test_precision_options_and_version_are_pinned(self):
        with patch.object(app.trafilatura, "extract", return_value="<html><body><p>ok</p></body></html>") as extract:
            result = app.extract_precision("<html><p>ok</p></html>")
        extract.assert_called_once_with(
            "<html><p>ok</p></html>",
            output_format="html",
            include_comments=True,
            include_tables=True,
            favor_precision=True,
        )
        self.assertEqual(result["body"], "ok")
        self.assertEqual(app.trafilatura.__version__, "2.2.0")

    def test_malformed_html_and_empty_extraction_are_nonfatal(self):
        with patch.object(app.trafilatura, "extract", return_value="<p>unfinished"):
            malformed = app.extract_precision("<html><div><p>unfinished")
        with patch.object(app.trafilatura, "extract", return_value=None):
            empty = app.extract_precision("<html></html>")
        self.assertEqual(malformed["paragraph_count"], 1)
        self.assertEqual(empty["body"], "")
        self.assertEqual(empty["text_chars"], 0)
        self.assertEqual(empty["paragraph_count"], 0)


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, body=b"<html><body><p>hello</p></body></html>", secret=SECRET, content_length=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "text/html; charset=utf-8"}
        if secret is not None:
            headers[AUTH_HEADER] = secret
        if content_length is not None:
            headers["Content-Length"] = str(content_length)
        connection.request("POST", "/extract", body=body, headers=headers)
        response = connection.getresponse()
        status, data = response.status, response.read()
        connection.close()
        return status, json.loads(data)

    def test_valid_secret_and_html(self):
        with patch.dict(os.environ, {SECRET_ENV: SECRET}):
            status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(result["body"], "hello")
        self.assertEqual(result["text_chars"], 5)
        self.assertEqual(result["paragraph_count"], 1)
        self.assertEqual(result["trafilatura_version"], "2.2.0")

    def test_health_requires_the_same_secret(self):
        with patch.dict(os.environ, {SECRET_ENV: SECRET}):
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request("GET", "/health")
            self.assertEqual(connection.getresponse().status, 401)
            connection.close()
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request("GET", "/health", headers={AUTH_HEADER: SECRET})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            connection.close()

    def test_missing_or_wrong_secret_is_rejected(self):
        with patch.dict(os.environ, {SECRET_ENV: SECRET}):
            self.assertEqual(self.request(secret=None)[0], 401)
            self.assertEqual(self.request(secret="wrong")[0], 401)

    def test_compressed_request_is_rejected_without_decompression(self):
        with patch.dict(os.environ, {SECRET_ENV: SECRET}):
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request(
                "POST", "/extract", body=b"compressed-data",
                headers={AUTH_HEADER: SECRET, "Content-Encoding": "gzip"},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, 415)
            connection.close()

    def test_unconfigured_service_fails_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                app.configured_secret()
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request("POST", "/extract", body=b"<html></html>")
            response = connection.getresponse()
            status, result = response.status, json.loads(response.read())
            connection.close()
            self.assertEqual(status, 503)
            self.assertEqual(result["error"], "service_unconfigured")

    def test_oversize_rejected_before_body_is_read(self):
        with patch.object(app, "MAX_HTML_BYTES", 16), patch.dict(os.environ, {SECRET_ENV: SECRET}):
            self.assertEqual(self.request(body=b"x" * 17)[0], 413)

    def test_oversize_actual_read_is_rejected_even_if_header_is_smaller(self):
        class OversizedReader:
            def read(self, _limit):
                return b"x" * 17

        class FakeConnection:
            def settimeout(self, _seconds):
                pass

        handler = object.__new__(app.Handler)
        handler.path = "/extract"
        handler.headers = {AUTH_HEADER: SECRET, "Content-Length": "1"}
        handler.connection = FakeConnection()
        handler.rfile = OversizedReader()
        sent = {}
        handler.send_json = lambda status, value: sent.update(status=status, value=value)
        handler.log_event = lambda status, **fields: None
        with patch.object(app, "MAX_HTML_BYTES", 16), patch.dict(os.environ, {SECRET_ENV: SECRET}):
            handler.do_POST()
        self.assertEqual(sent["status"], 413)

    def test_saved_sanspo_fixture_fits_limit_and_is_processed(self):
        if not FIXTURE.is_file():
            self.skipTest("saved Sanspo HTML fixture is not present in this checkout")
        raw = FIXTURE.read_bytes()
        self.assertLessEqual(len(raw), app.MAX_HTML_BYTES)
        with patch.dict(os.environ, {SECRET_ENV: SECRET}):
            status, result = self.request(body=raw)
        self.assertEqual(status, 200)
        self.assertEqual(result["trafilatura_version"], "2.2.0")
        self.assertEqual(result["paragraph_count"], 5)

    def test_logs_do_not_contain_secret_or_html(self):
        output = io.StringIO()
        body = b"<html><p>private article body marker</p></html>"
        with patch.dict(os.environ, {SECRET_ENV: SECRET}), contextlib.redirect_stdout(output):
            self.assertEqual(self.request(body=body)[0], 200)
        self.assertNotIn(SECRET, output.getvalue())
        self.assertNotIn("private article body marker", output.getvalue())
        record = json.loads(output.getvalue().strip())
        self.assertEqual(record["status"], 200)
        self.assertEqual(record["html_bytes"], len(body))


if __name__ == "__main__":
    unittest.main()
