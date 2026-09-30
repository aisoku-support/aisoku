"""Authentication boundary for the Trafilatura extraction service.

Keep this module independent from extraction so Cloud Run IAM can replace the
shared-secret verifier without changing the extraction implementation.
"""

import hmac
import os


SECRET_ENV = "TRAFILATURA_API_SECRET"
AUTH_HEADER = "X-Trafilatura-Secret"


def configured_secret() -> str:
    secret = os.environ.get(SECRET_ENV, "")
    if not secret:
        raise RuntimeError(f"required environment variable {SECRET_ENV} is not set")
    return secret


def is_authorized(provided: str | None, expected: str) -> bool:
    if not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
