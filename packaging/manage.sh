#!/bin/bash
set -euo pipefail
umask 077
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BASE="$HOME/Library/Application Support/Gauge"
TARGET="$BASE/marketplace"
MODE=${1:-install}
STAGE=""; BACKUP=""; LOCKED=0; REPLACED=0
PREVIOUS_LOCAL_SOURCE=""; SOURCE_SWITCHED=0; WAS_INSTALLED=0
finish() {
  status=$?
  [ -z "$STAGE" ] || /bin/rm -rf -- "$STAGE"
  if [ "$status" -ne 0 ] && [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    /bin/rm -rf -- "$TARGET"
    /bin/mv -- "$BACKUP" "$TARGET"
    echo '安装失败，已恢复原发行文件。可重跑安装器完成客户端注册。' >&2
  elif [ "$status" -ne 0 ] && [ "$REPLACED" -eq 1 ]; then
    echo '客户端注册未完成。发行文件已保留，可重跑安装器重试。' >&2
  fi
  if [ "$status" -ne 0 ] && [ "$SOURCE_SWITCHED" -eq 1 ]; then
    # Restore the source only after restoring its previous payload, if any.
    "$CODEX_BIN" plugin marketplace remove tokenlens-local >/dev/null 2>&1 || true
    if "$CODEX_BIN" plugin marketplace add "$PREVIOUS_LOCAL_SOURCE"; then
      if [ "$WAS_INSTALLED" -eq 1 ]; then
        if ! "$CODEX_BIN" plugin add tokenlens-prototype@tokenlens-local; then
          echo '原插件来源已恢复，但安装副本恢复失败，请重新安装 Gauge。' >&2
        fi
      fi
      echo '已恢复原 Gauge 插件来源。' >&2
    else
      echo '原 Gauge 插件来源恢复失败，请重新添加原来源。' >&2
    fi
  fi
  if [ "$LOCKED" -eq 1 ]; then /bin/rmdir "$BASE/.install-lock"; fi
  if [ -t 0 ] && [ "${TOKENLENS_NO_PAUSE:-0}" != 1 ]; then
    echo; read -r -p '按回车关闭此窗口…' _ || true
  fi
  exit "$status"
}
trap finish EXIT
case "$MODE" in install|update|uninstall) ;; *) echo '无效操作' >&2; exit 2;; esac
if [ "$(/usr/bin/uname -s)-$(/usr/bin/uname -m)" != Darwin-arm64 ]; then
  echo '此包仅支持 Apple Silicon Mac，Intel / Windows / Linux 尚无发行包。' >&2; exit 1
fi

# Prefer the desktop app's native CLI; no separate CLI, Node or npm install.
CODEX_BIN=${TOKENLENS_CODEX:-}
if [ -z "$CODEX_BIN" ]; then
  for APP_ROOT in /Applications "$HOME/Applications"; do
    for APP_NAME in Codex ChatGPT; do
      CANDIDATE="$APP_ROOT/$APP_NAME.app/Contents/Resources/codex-cli/bin/codex"
      if [ -x "$CANDIDATE" ]; then CODEX_BIN=$CANDIDATE; break 2; fi
    done
  done
fi
if [ -z "$CODEX_BIN" ]; then
  APP_PATH=$(/usr/bin/mdfind 'kMDItemCFBundleIdentifier == "com.openai.codex"' | /usr/bin/head -n 1)
  CANDIDATE="$APP_PATH/Contents/Resources/codex-cli/bin/codex"
  if [ -n "$APP_PATH" ] && [ -x "$CANDIDATE" ]; then CODEX_BIN=$CANDIDATE; fi
fi
if [ -z "$CODEX_BIN" ] || [ ! -x "$CODEX_BIN" ]; then
  echo '未找到受支持的 Codex 桌面客户端。请先安装/更新客户端，再重试；无需安装 Node 或 Python。' >&2; exit 1
fi
/bin/mkdir -p "${CODEX_HOME:-$HOME/.codex}"
"$CODEX_BIN" plugin marketplace add --help >/dev/null
/bin/mkdir -p "$BASE"
if ! /bin/mkdir "$BASE/.install-lock" 2>/dev/null; then
  echo '另一个 Gauge 安装器正在运行。若上次被强制关闭，请移除 Gauge/.install-lock 空文件夹后重试。' >&2; exit 1
fi
LOCKED=1
if [ "$MODE" = uninstall ]; then
  "$CODEX_BIN" plugin remove tokenlens-prototype@tokenlens-local
  MARKETPLACES=$("$CODEX_BIN" plugin marketplace list --json)
  if /usr/bin/grep -Eq '"name"[[:space:]]*:[[:space:]]*"tokenlens-local"' <<< "$MARKETPLACES"; then
    "$CODEX_BIN" plugin marketplace remove tokenlens-local
  fi
  /bin/rm -rf -- "$TARGET"
  echo 'Gauge 已卸载。Codex 聊天记录和统计缓存保留。请重新打开客户端。'
  exit 0
fi
if [ ! -f "$SOURCE/PAYLOAD.sha256" ]; then
  echo '请使用完整的 Gauge Mac 发行包，不要从源码目录运行此安装器。' >&2; exit 1
fi
echo '校验 Gauge 发行文件…'
(cd "$SOURCE" && /usr/bin/shasum -a 256 -c PAYLOAD.sha256 >/dev/null)
while IFS=$'\t' read -r LINK DESTINATION; do
  [ -n "$LINK" ] || continue
  if [ ! -L "$SOURCE/$LINK" ] || [ "$(/usr/bin/readlink "$SOURCE/$LINK")" != "$DESTINATION" ]; then
    echo "发行包符号链接校验失败：$LINK" >&2; exit 1
  fi
done < "$SOURCE/PAYLOAD-LINKS.tsv"

# A developer or earlier installer may have registered the same marketplace
# name from another local folder. Inspect before replacing any files and only
# migrate this single-plugin marketplace; never remove unrelated entries.
MARKETPLACES=$("$CODEX_BIN" plugin marketplace list --json)
INDEX=0
while NAME=$(/usr/bin/plutil -extract "marketplaces.$INDEX.name" raw -o - - <<< "$MARKETPLACES" 2>/dev/null); do
  if [ "$NAME" = tokenlens-local ]; then
    ROOT=$(/usr/bin/plutil -extract "marketplaces.$INDEX.root" raw -o - - <<< "$MARKETPLACES")
    TARGET_ROOT="$TARGET"
    if [ -d "$TARGET" ]; then TARGET_ROOT=$(CDPATH= cd -- "$TARGET" && pwd -P); fi
    if [ "$ROOT" != "$TARGET_ROOT" ]; then
      TYPE=$(/usr/bin/plutil -extract "marketplaces.$INDEX.marketplaceSource.sourceType" raw -o - - <<< "$MARKETPLACES" 2>/dev/null || true)
      if [ "$TYPE" != local ] || [ ! -d "$ROOT" ]; then
        echo 'Gauge 已从另一种来源注册。请先在客户端确认原来源，再使用下载包安装。' >&2; exit 1
      fi
      CATALOG="$ROOT/.agents/plugins/marketplace.json"
      if [ ! -f "$CATALOG" ]; then CATALOG="$ROOT/.claude-plugin/marketplace.json"; fi
      CATALOG_NAME=$(/usr/bin/plutil -extract name raw -o - "$CATALOG" 2>/dev/null || true)
      if [ "$CATALOG_NAME" != tokenlens-local ]; then
        echo '无法确认原 Gauge 插件目录，安装器不会替换它。' >&2; exit 1
      fi
      ENTRY=0
      while PLUGIN_NAME=$(/usr/bin/plutil -extract "plugins.$ENTRY.name" raw -o - "$CATALOG" 2>/dev/null); do
        if [ "$PLUGIN_NAME" != tokenlens-prototype ]; then
          echo '同名插件来源还包含其他插件，安装器不会替换它。请先在客户端确认来源。' >&2; exit 1
        fi
        ENTRY=$((ENTRY + 1))
      done
      if [ "$ENTRY" -ne 1 ]; then
        echo '原 Gauge 插件目录不完整，安装器不会替换它。' >&2; exit 1
      fi
      PLUGINS=$("$CODEX_BIN" plugin list --marketplace tokenlens-local --json)
      for GROUP in installed available; do
        ENTRY=0
        while PLUGIN_NAME=$(/usr/bin/plutil -extract "$GROUP.$ENTRY.name" raw -o - - <<< "$PLUGINS" 2>/dev/null); do
          if [ "$PLUGIN_NAME" != tokenlens-prototype ]; then
            echo '同名插件来源还包含其他插件，安装器不会替换它。请先在客户端确认来源。' >&2; exit 1
          fi
          if [ "$GROUP" = installed ]; then WAS_INSTALLED=1; fi
          ENTRY=$((ENTRY + 1))
        done
      done
      PREVIOUS_LOCAL_SOURCE="$ROOT"
    fi
    break
  fi
  INDEX=$((INDEX + 1))
done
STAGE=$(/usr/bin/mktemp -d "$BASE/.stage.XXXXXX")
/bin/cp -R "$SOURCE/plugin" "$STAGE/plugin"
/bin/mkdir -p "$STAGE/.agents/plugins"
/bin/cp "$SOURCE/.agents/plugins/marketplace.json" "$STAGE/.agents/plugins/marketplace.json"
if [ -d "$TARGET" ]; then
  if [ -e "$BASE/.previous" ]; then echo '发现上次更新恢复目录，请先检查 Gauge/.previous。' >&2; exit 1; fi
  BACKUP="$BASE/.previous"
  /bin/mv "$TARGET" "$BACKUP"
fi
/bin/mv "$STAGE" "$TARGET"; STAGE=""; REPLACED=1
if [ -n "$PREVIOUS_LOCAL_SOURCE" ]; then
  echo '将现有 Gauge 本地来源迁移到下载包安装目录…'
  "$CODEX_BIN" plugin marketplace remove tokenlens-local
  SOURCE_SWITCHED=1
fi
"$CODEX_BIN" plugin marketplace add "$TARGET"
"$CODEX_BIN" plugin add tokenlens-prototype@tokenlens-local
if [ -n "$BACKUP" ]; then /bin/rm -rf -- "$BACKUP"; BACKUP=""; fi
echo 'Gauge 已安装/更新。请完全退出并重新打开客户端，然后在插件面板打开 Gauge。'
echo '若客户端弹出信任或权限确认，请按客户端提示完成。统计无需额外账号或 API Key。'
