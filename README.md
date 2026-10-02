# Gauge

在 Codex 里查看本地 tokens、API 等价费用、账号用量和可选对话预算。支持 Apple Silicon Mac，内置运行环境，不需要 API Key。

## 让 agent 安装

把这句话发给 Codex：

> 帮我安装 Gauge，按这个说明下载、校验并安装：https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/INSTALL.md

[安装说明](INSTALL.md) · [下载最新版](https://github.com/DHCFE/gauge-codex-plugin/releases/latest/download/Gauge-mac-arm64.zip) · [发行记录](https://github.com/DHCFE/gauge-codex-plugin/releases)

安装后，新开一个聊天并说「打开 Gauge 用量面板」。安装和升级保留本地统计、预算及原插件身份。

## 版本与更新

面板显示已安装版本。打开面板时自动读取公开发行版本信息，成功结果在本机缓存 6 小时；有新版时出现「更新」按钮，点击后请求 agent 升级。检查版本不会发送账号信息或聊天内容，也不会自动安装软件。

Git 市场用户也可添加本仓库：

```sh
codex plugin marketplace add DHCFE/gauge-codex-plugin --ref main
codex plugin install tokenlens-prototype@tokenlens-local
```

Codex 可刷新 Git 市场的插件版本。本项目没有验证或承诺原生插件目录的更新徽标和无人值守升级。

## 使用与数据

- 对话页查看轮次、累计和趋势；账号页查看本机可发现的历史对话、模型、项目、日趋势和导出。
- 金额是 Standard API 等价估算，不是订阅账单。周容量估算受本地记录覆盖、账号归属和官方周期数据限制。
- 预算默认关闭。开启后提供软预算提示，需宿主支持并信任插件 Hook；宿主实际送达仍需验证。
- 用量数据从本机 Codex 记录读取，统计缓存不保存聊天正文或凭据。版本检查仅访问本仓库的公开发行元数据。
- 当前没有 Intel Mac、Windows 或 Linux 安装包。需要支持本地插件和 MCP App 的 Codex 桌面客户端。

Gauge 原名 TokenLens。内部插件 ID 沿用以保证升级和数据兼容。

第三方运行时及依赖许可证见 [声明](THIRD-PARTY-NOTICES.md)、THIRD-PARTY-NOTICES.txt 和 plugin/runtime/darwin-arm64/licenses/。
