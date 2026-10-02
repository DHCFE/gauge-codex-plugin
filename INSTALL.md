# 安装或更新 Gauge

请帮我安装或更新 Gauge。当前发行版支持 Apple Silicon Mac，需要已安装支持本地插件的 Codex 桌面客户端。

Agent 请按以下流程完成：

如果现有 Gauge 的 `tokenlens-local` 市场来源是本仓库的 Git 地址，使用客户端自带 CLI 执行 `codex plugin marketplace upgrade tokenlens-local`，再执行 `codex plugin install tokenlens-prototype@tokenlens-local` 并核对版本。保留 Git 来源，不运行 ZIP 安装器。其他未知来源不要替换。

1. 下载并阅读安装脚本：https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/install.sh
2. 在本机运行已检查的脚本。它会获取最新稳定版、下载预编译安装包、检查 SHA-256 并调用安装器。安装器也负责更新现有 Gauge，保留统计和预算数据。不要构建源码、安装开发依赖或运行整套开发测试。
3. 检查 Codex 插件列表中 Gauge 已安装且启用，并说明安装版本。若当前聊天尚未载入新工具，提示用户新开一个聊天再打开 Gauge 面板；不要擅自关闭客户端。

安装脚本无需 GitHub 登录或 API Key。预算默认关闭，安装过程不应开启任何对话预算。不要移除系统安全标记、改全局信任设置，或接管含其他插件的已有市场来源。

固定下载地址：https://github.com/DHCFE/gauge-codex-plugin/releases/latest/download/Gauge-mac-arm64.zip

如果脚本无法执行，可下载上述 ZIP，解压后运行 Install.command。
