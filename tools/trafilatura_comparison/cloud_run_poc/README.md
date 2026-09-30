# Trafilatura Precision extraction service

This folder contains a stateless Cloud Run container for extracting article text from HTML already fetched by its caller. It does not accept URLs, make outbound requests, persist HTML, or log HTML/article text.

## API

`POST /extract` accepts the raw UTF-8 HTML bytes as the request body. The caller must send `X-Trafilatura-Secret` with the shared secret. A future Cloud Run IAM verifier can replace `auth.py` without changing `extract_precision()`.

Successful response:

```json
{
  "body": "normalized extracted text",
  "text_chars": 123,
  "paragraph_count": 3,
  "processing_ms": 12.34,
  "trafilatura_version": "2.2.0"
}
```

An empty extraction returns HTTP 200 with an empty `body`, zero `text_chars`, and zero `paragraph_count`; the caller can then use its title/description fallback. Malformed HTML is passed to Trafilatura and must not terminate the service. Invalid extraction input returns HTTP 422 without including the exception message.

`GET /health` also requires `X-Trafilatura-Secret` and returns the service status and Trafilatura version.

| Status | Meaning |
| --- | --- |
| 200 | Extraction completed, including empty result |
| 400 | Body shorter than declared `Content-Length` |
| 401 | Missing or incorrect secret |
| 408 | Body upload exceeded the five-second read deadline |
| 411 | `Content-Length` is required |
| 413 | HTML exceeds the configured byte limit |
| 415 | Compressed request body is not supported |
| 422 | Extraction failed safely |
| 503 | Service is not configured with a secret |

## Security and limits

- Set `TRAFILATURA_API_SECRET` at deployment/runtime. The process exits during startup if it is unset or empty; it never starts unauthenticated.
- `X-Trafilatura-Secret` is compared with `hmac.compare_digest`.
- `MAX_HTML_BYTES` defaults to **2 MiB**. This gives over four times headroom above the confirmed ~480 KB fixture while remaining far below Cloud Run's HTTP/1 32 MiB platform limit. Set a different positive integer byte count only after reviewing actual input sizes.
- The server requires a declared Content-Length, rejects an oversized declaration before reading, reads in bounded chunks up to max+1, and rejects if actual bytes exceed the configured limit or differ from Content-Length.
- The application does not decompress request content. The caller should send uncompressed HTML and omit `Content-Encoding`.
- Request body reading has a five-second deadline. Configure Cloud Run's request timeout to about five seconds as well.
- Application logs contain only status, safe error type, processing time, byte count, character count, and extractor version. Request paths, headers, secrets, input HTML, extracted text, and exception messages are not logged.
- Cloud Run's platform IAM gateway cannot validate this application header. For this V1 mode, the Cloud Run service must be network-reachable and allow the request through the platform gateway; the application then rejects requests without the secret before reading the body or invoking Trafilatura. Consequently, unauthenticated requests can still reach the container and consume some request/CPU capacity for the 401 path. Set a small max-instance limit, rotate the secret if exposed, and migrate the verifier to IAM/WIF before relying on Google-level invoker protection.

## Extraction configuration

`requirements.txt` pins `trafilatura==2.2.0`. `extract_precision()` retains the existing comparison options:

```python
trafilatura.extract(
    raw_html,
    output_format="html",
    include_comments=True,
    include_tables=True,
    favor_precision=True,
)
```

`body` is normalized from Trafilatura's HTML output using the existing lxml paragraph extraction and whitespace normalization. `text_chars` is the normalized body text length. No minimum text length is used to mark extraction as failed.

## Local verification

```sh
export TRAFILATURA_API_SECRET='set-a-local-test-secret'
python -m unittest -v test_app.py
python app.py
```

For a Docker smoke test, provide the secret through the environment rather than putting it in the Dockerfile or command-line arguments:

```sh
docker build -t trafilatura-precision-poc .
docker run --rm -p 8080:8080 --env TRAFILATURA_API_SECRET trafilatura-precision-poc
```

The saved fixture tests use local files and do not fetch article URLs.

## Future Cloud Run deployment settings (not deployed here)

- Authentication: set Cloud Run platform auth to allow requests through to the service, then require the shared secret in `TRAFILATURA_API_SECRET` at the application layer. Store the value in Secret Manager and reference it as a Cloud Run secret environment variable. Never put it in source, image layers, command arguments, or logs. This V1 mode does not prevent unauthenticated requests from reaching the container; the future IAM/WIF verifier should replace it to add platform-level caller rejection.
- Initial resources: 1 vCPU, 512 MiB, concurrency 1, minimum instances 0, maximum instances 2, request timeout 5 seconds.
- `MAX_HTML_BYTES=2097152` (default).
- Avoid a load balancer, VPC connector, or NAT for this service unless a separately reviewed requirement needs it.
- This PoC folder has not been deployed to Cloud Run.
