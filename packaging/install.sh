#!/bin/bash
set -euo pipefail

# Published installer: only downloads the immutable, versioned Gauge release.
REPOSITORY="DHCFE/gauge-codex-plugin"
if [[ "$(/usr/bin/uname -s)" != Darwin || "$(/usr/bin/uname -m)" != arm64 ]]; then
  echo "Gauge 当前支持 Apple Silicon Mac。" >&2
  exit 1
fi
if [[ -z "${HTTPS_PROXY:-${https_proxy:-}}" ]]; then
  SETTINGS=$(/usr/sbin/scutil --proxy)
  ENABLED=$(printf '%s\n' "$SETTINGS" | /usr/bin/awk '$1=="HTTPSEnable" {print $3}')
  PROXY_HOST=$(printf '%s\n' "$SETTINGS" | /usr/bin/awk '$1=="HTTPSProxy" {print $3}')
  PROXY_PORT=$(printf '%s\n' "$SETTINGS" | /usr/bin/awk '$1=="HTTPSPort" {print $3}')
  if [[ "$ENABLED" == 1 && -n "$PROXY_HOST" && -n "$PROXY_PORT" ]]; then
    if [[ "$PROXY_HOST" == *:* ]]; then PROXY_HOST="[$PROXY_HOST]"; fi
    export HTTPS_PROXY="http://$PROXY_HOST:$PROXY_PORT"
  fi
fi
TASK_TMP=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/gauge-install.XXXXXX")
trap '/bin/rm -rf "$TASK_TMP"' EXIT
download() {
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --retry 2 --retry-delay 1 --output "$2" "$1"
}
echo "正在获取 Gauge 最新版…"
download "https://github.com/$REPOSITORY/releases/latest/download/version.json" "$TASK_TMP/version.json"
if [[ $(/usr/bin/stat -f %z "$TASK_TMP/version.json") -gt 8192 ]]; then echo "版本信息无效。" >&2; exit 1; fi
field() { /usr/bin/plutil -extract "$1" raw -o - "$TASK_TMP/version.json"; }
VERSION=$(field version)
DIGEST=$(field sha256)
if [[ $(field product) != Gauge || $(field platform) != darwin-arm64 || $(field asset) != Gauge-mac-arm64.zip \
  || ! "$VERSION" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ || ! "$DIGEST" =~ ^[a-f0-9]{64}$ ]]; then
  echo "版本信息无效。" >&2
  exit 1
fi
download "https://github.com/$REPOSITORY/releases/download/v$VERSION/Gauge-mac-arm64.zip" "$TASK_TMP/Gauge.zip"
ACTUAL=$(/usr/bin/shasum -a 256 "$TASK_TMP/Gauge.zip")
if [[ "${ACTUAL%% *}" != "$DIGEST" ]]; then echo "下载校验失败，请重试。" >&2; exit 1; fi
NAME="Gauge-$VERSION-mac-arm64"
# Reject traversal or extra roots before extraction.
while IFS= read -r entry; do
  if [[ "$entry" != "$NAME/"* || "$entry" == *"../"* || "$entry" == *"/.." || "$entry" == *\\* ]]; then
    echo "安装包路径无效。" >&2; exit 1
  fi
done < <(/usr/bin/unzip -Z1 "$TASK_TMP/Gauge.zip")
/usr/bin/unzip -q "$TASK_TMP/Gauge.zip" -d "$TASK_TMP/unpacked"
PAYLOAD="$TASK_TMP/unpacked/$NAME"
if [[ $(/usr/bin/plutil -extract version raw -o - "$PAYLOAD/plugin/.codex-plugin/plugin.json") != "$VERSION" \
  || $(/usr/bin/plutil -extract interface.displayName raw -o - "$PAYLOAD/plugin/.codex-plugin/plugin.json") != Gauge ]]; then
  echo "安装包身份不匹配。" >&2; exit 1
fi
TOKENLENS_NO_PAUSE=1 /bin/bash "$PAYLOAD/Install.command"
