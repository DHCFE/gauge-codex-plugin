# 已安装 Gauge 后如何更新

这份说明适用于已经成功安装 Gauge 的用户。第一次使用请看 [从零安装说明](INSTALL.md)。

打开 Gauge 面板，有新版时会出现「更新」按钮。点击后，agent 会帮助升级，保留本地统计和预算数据。你也可以直接让 Codex「帮我把 Gauge 更新到最新版」。

## 给负责更新的 agent

1. 检查现有 `tokenlens-local` 市场来源，保留用户数据和插件身份。
2. 若来源是本仓库 `DHCFE/gauge-codex-plugin` 的 Git 地址，使用客户端自带 CLI 执行 `codex plugin marketplace upgrade tokenlens-local`，再执行 `codex plugin install tokenlens-prototype@tokenlens-local`，核对版本并保留 Git 来源。
3. 若来源是本插件的单插件本地目录，下载并阅读 https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/install.sh，然后运行脚本完成升级。不要要求用户先卸载。来源不明或目录中包含其他插件时，不替换该来源。
4. 检查 Gauge 已安装并启用，再说明版本和重新打开的方法。不要擅自关闭客户端，不修改预算状态。

## 版本提醒

版本提醒显示在 Gauge 面板中。打开时检查公开版本信息，成功结果在本机缓存 6 小时；只有点击按钮才会请求 agent 升级。原生插件列表的更新标记和无人值守升级尚未验证。
