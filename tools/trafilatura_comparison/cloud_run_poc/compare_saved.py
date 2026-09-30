"""POST saved HTML fixtures to a running PoC service; write metrics only."""

import argparse
import csv
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


DEFAULT_HTML_DIR = Path(__file__).resolve().parent / "html"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "poc_results.json"
FIXTURES = [
    ("Sanspo", "598128468a5e594b5023d997d90ad6c4"),
    ("日テレnews Nnn", "3619bcbbccef285d6675f4df7cfe9a86"),
    ("エスデイ通信", "4eca8999a34917f7b964b9a3108320ea"),
    ("Nikkei Shimbun", "94a2824c4876ba705859683d2c48a0b9"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--html-dir", type=Path, default=DEFAULT_HTML_DIR,
                        help="directory containing <article_id>.html fixtures (default: ./html)")
    parser.add_argument("--base-url", default="http://127.0.0.1:8080",
                        help="PoC service base URL")
    parser.add_argument("--secret", default=None,
                        help="shared API secret (defaults to TRAFILATURA_API_SECRET)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="write combined JSON results here (default: ./poc_results.json)")
    args = parser.parse_args()
    secret = args.secret or os.environ.get("TRAFILATURA_API_SECRET")
    if not secret:
        parser.error("set TRAFILATURA_API_SECRET or pass --secret")
    records = []
    for source, article_id in FIXTURES:
        path = args.html_dir / f"{article_id}.html"
        if not path.is_file():
            parser.error(f"fixture not found: {path}; pass --html-dir with the uploaded HTML directory")
        html_bytes = path.read_bytes()
        headers = {
            "Content-Type": "text/html; charset=utf-8",
            "X-Trafilatura-Secret": secret,
        }
        request = Request(
            args.base_url.rstrip("/") + "/extract",
            data=html_bytes,
            headers=headers,
            method="POST",
        )
        try:
            response = urlopen(request, timeout=120)
        except HTTPError as exc:
            status, payload = exc.code, exc.read()
        else:
            status, payload = response.status, response.read()
            response.close()
        result = json.loads(payload)
        record = {
            "source": source,
            "article_id": article_id,
            "http_status": status,
            "html_bytes": result.get("html_bytes", len(html_bytes)),
            "text_chars": result.get("text_chars"),
            "paragraph_count": result.get("paragraph_count"),
            "processing_ms": result.get("processing_ms"),
            "trafilatura_version": result.get("trafilatura_version"),
        }
        records.append(record)
        print(json.dumps(record, ensure_ascii=False))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = args.output.with_suffix(".csv")
    fields = ["source", "article_id", "http_status", "html_bytes", "text_chars",
              "paragraph_count", "processing_ms", "trafilatura_version"]
    with csv_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: row.get(key) for key in fields} for row in records)
    print(f"Wrote {args.output} and {csv_path}")


if __name__ == "__main__":
    main()
