#!/usr/bin/env bash
# Serve a throwaway copy of vdebug/fixture/ for `vdebug.py record` — never the real corpus.
#
#   vdebug/serve_fixture.sh [PORT] [BINARY]     # default 38417, ./kiwifs
#
# The fixture is copied into a fresh temp dir (KiwiFS writes .kiwi/state/ into its root),
# and flow capture writes to a db beside it, outside the served root.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
port="${1:-38417}"
bin="${2:-$here/../kiwifs}"
work="$(mktemp -d /tmp/kiwifs-vdebug-XXXXXX)"
cp -r "$here/fixture" "$work/root"
echo "fixture root: $work/root  flows db: $work/flows.db  url: http://127.0.0.1:$port" >&2
export KIWIFS_VD_FLOWS_DB="$work/flows.db"
exec nice -n 10 "$bin" serve --root "$work/root" --host 127.0.0.1 --port "$port" \
  --versioning none --search sqlite --no-watch
