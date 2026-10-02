#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA=${TOKENLENS_DATA:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-${CODEX_HOME:-$HOME/.codex}/plugins/data/tokenlens-local/tokenlens-prototype}}}
if [ "${1:-}" = "--budget-hook" ] && [ ! -f "$DATA/budgets-v1.json" ]; then exit 0; fi
case "$(/usr/bin/uname -s)-$(/usr/bin/uname -m)" in
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  *) echo 'Gauge 发行包目前只支持 Apple Silicon Mac；其他平台请使用开发版。' >&2; exit 1 ;;
esac
RUNTIME="$ROOT/runtime/$PLATFORM"
NODE="$DATA/runtime/node-22.23.3-$PLATFORM"
ENGINE="$ROOT/runtime/$PLATFORM/usage-engine/tokenlens-usage"
if [ ! -f "$RUNTIME/node.gz" ] || [ ! -f "$RUNTIME/node.sha256" ] || [ ! -x "$ENGINE" ]; then
  echo 'Gauge 内置运行时不完整，请重新下载完整 Mac 发行包。' >&2
  exit 1
fi
umask 077
EXPECTED=$(cat "$RUNTIME/node.sha256")
valid_node() {
  [ -x "$1" ] || return 1
  ACTUAL=$(/usr/bin/shasum -a 256 "$1")
  [ "${ACTUAL%% *}" = "$EXPECTED" ]
}
if ! valid_node "$NODE"; then
  /bin/mkdir -p "$DATA/runtime"
  TEMP=$(/usr/bin/mktemp "$DATA/runtime/.node.XXXXXX")
  trap '/bin/rm -f "$TEMP"' EXIT HUP INT TERM
  /usr/bin/gzip -dc "$RUNTIME/node.gz" > "$TEMP"
  /bin/chmod 700 "$TEMP"
  if ! valid_node "$TEMP"; then echo 'Gauge 运行时校验失败，请重新下载。' >&2; exit 1; fi
  /bin/mv -f "$TEMP" "$NODE"
  trap - EXIT HUP INT TERM
fi
export TOKENLENS_DATA="$DATA"
if [ "${1:-}" = "--budget-hook" ]; then
  shift
  exec "$NODE" "$ROOT/budget-hook.mjs" "$@"
fi
exec "$NODE" "$ROOT/server.mjs" "$@"
