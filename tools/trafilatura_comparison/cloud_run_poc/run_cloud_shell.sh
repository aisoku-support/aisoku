#!/usr/bin/env bash
set -euo pipefail

# Self-contained Cloud Shell runner. Run from the uploaded cloud_run_poc folder.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PORT="${PORT:-8080}"
IMAGE="${IMAGE:-trafilatura-precision-poc:local}"
CONTAINER="${CONTAINER:-trafilatura-precision-poc}"
URL="http://127.0.0.1:${PORT}"
if [[ -z "${TRAFILATURA_API_SECRET:-}" ]]; then
  read -r -s -p "Trafilatura API secret: " TRAFILATURA_API_SECRET
  echo
fi
export TRAFILATURA_API_SECRET

for file in app.py compare_saved.py Dockerfile requirements.txt; do
  [[ -f "$SCRIPT_DIR/$file" ]] || { echo "Missing required file: $SCRIPT_DIR/$file" >&2; exit 2; }
done

# Find all four required HTML fixtures anywhere under the uploaded folder,
# including html/, an extracted archive directory, or files beside the script.
HTML_DIR="$(python3 - "$SCRIPT_DIR" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
ids = ["598128468a5e594b5023d997d90ad6c4", "3619bcbbccef285d6675f4df7cfe9a86",
       "4eca8999a34917f7b964b9a3108320ea", "94a2824c4876ba705859683d2c48a0b9"]
found = {}
for aid in ids:
    matches = sorted(root.rglob(aid + ".html"))
    if not matches:
        print(f"Missing HTML fixture {aid}.html under {root}", file=sys.stderr)
        raise SystemExit(3)
    if len(matches) > 1:
        # Prefer canonical html/ then the shallowest path; no manual choice required.
        matches.sort(key=lambda p: ("html" not in p.parts, len(p.parts), str(p)))
    found[aid] = matches[0].parent
parents = set(found.values())
if len(parents) != 1:
    # Normalize into a private staging folder to support fixtures uploaded in
    # different nested folders while keeping source files untouched.
    stage = root / ".poc_html"
    stage.mkdir(exist_ok=True)
    for aid, parent in found.items():
        target = stage / (aid + ".html")
        if target.resolve() != (parent / (aid + ".html")).resolve():
            target.write_bytes((parent / (aid + ".html")).read_bytes())
    print(stage)
else:
    print(next(iter(parents)))
PY
)" || { echo "Could not locate the four saved HTML fixtures." >&2; exit 3; }

echo "Using fixture directory: $HTML_DIR"

health_ok() {
  python3 - "$URL/health" "$TRAFILATURA_API_SECRET" <<'PY' >/dev/null 2>&1
import sys, urllib.request
req = urllib.request.Request(sys.argv[1], headers={"X-Trafilatura-Secret": sys.argv[2]})
with urllib.request.urlopen(req, timeout=3) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
}

if health_ok; then
  echo "Reusing PoC already responding on port $PORT."
else
  if python3 - "$URL/health" <<'PY' >/dev/null 2>&1
import sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=3) as response:
    raise SystemExit(0 if response.status == 200 else 1)
PY
  then
    echo "An unauthenticated service is responding on port $PORT; refusing to submit the secret or fixtures." >&2
    exit 7
  fi
  if command -v docker >/dev/null 2>&1; then
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      # Reuse a previously built image with the known PoC name if tagged differently.
      candidate="$(docker images --format '{{.Repository}}:{{.Tag}}' | awk '$0 ~ /trafilatura.*poc/ && $0 !~ /<none>/ {print; exit}')"
      if [[ -n "$candidate" ]]; then IMAGE="$candidate"; else docker build -t "$IMAGE" "$SCRIPT_DIR"; fi
    fi
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      echo "Existing container '$CONTAINER' cannot be safely assigned the supplied secret; use a new CONTAINER name." >&2
      exit 6
    else
      docker run -d --name "$CONTAINER" -p "${PORT}:8080" \
        -e TRAFILATURA_API_SECRET -e MAX_HTML_BYTES "$IMAGE" >/dev/null
    fi
  else
    echo "Docker is required by this runner; build/run the included container so the runtime secret can be injected safely." >&2
    exit 4
  fi
  for _ in $(seq 1 30); do
    if health_ok; then break; fi
    sleep 1
  done
  if ! health_ok; then
    echo "PoC service did not become healthy at $URL/health." >&2
    [[ -f poc_server.log ]] && tail -50 poc_server.log >&2
    exit 5
  fi
fi

python3 compare_saved.py --html-dir "$HTML_DIR" --base-url "$URL" --output "$SCRIPT_DIR/poc_results.json"
echo "Results saved: $SCRIPT_DIR/poc_results.json and $SCRIPT_DIR/poc_results.csv"
