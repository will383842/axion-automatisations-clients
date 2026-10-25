#!/bin/sh
# Test de fumée de l'image dérivée litellm (ADR 0015). Usage : fumee.sh <image locale> <image amont>
set -eu
image=$1
amont=$2
test "$(docker inspect --format '{{.Config.User}}' "$image")" = "$(docker inspect --format '{{.Config.User}}' "$amont")"
test -n "$(docker inspect --format '{{.Config.User}}' "$image")"
test "$(docker inspect --format '{{.Config.User}}' "$image")" != root
test "$(docker inspect --format '{{.Config.User}}' "$image")" != 0
python_run() { docker run --rm --entrypoint python "$image" "$@"; }
python_run -c "import importlib.metadata as m; assert m.version('litellm') == '1.83.14'"
cid=$(docker run -d -p 127.0.0.1:4000:4000 "$image")
trap 'docker rm -f "$cid" >/dev/null' EXIT
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:4000/health/liveliness >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:4000/health/liveliness
