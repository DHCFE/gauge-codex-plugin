# Gauge for Claude Code

Gauge 是独立的 Claude Code Mod。在 Claude Mac App 的 **Code** 标签打开本地对话后，点输入框上方的「打开 Gauge」，右侧会显示原生用量面板。点面板右上角的 × 可以收起。也可以用 `/gauge` 打开，或用 `/gauge account` 直接进入账号页。

## 安装

需要 Claude Mac App、可在终端运行的 Claude Code CLI，以及可用的系统 Python 3（`/usr/bin/python3 --version`）。原生面板已在桌面端的 Claude Code 2.1.321 验证。

1. [下载 Claude Code Mod](https://github.com/DHCFE/gauge-codex-plugin/releases/latest/download/Gauge-Claude-Code-Mod.zip) 并解压。也可以克隆此仓库，使用仓库里的 `claude-mod` 目录。
2. 在终端进入包含 `claude-mod` 的目录，运行：

   ```sh
   claude plugin install gauge-usage --marketplace "$PWD/claude-mod" --scope user
   ```

3. 打开 Claude Mac App 的 Code 标签，进入一个本地对话。已有对话可以运行 `/reload-plugins` 加载新版。

保留解压后的目录。后续更新同一目录中的发行文件，再运行 `claude plugin update gauge-usage@gauge-claude-local`。卸载命令为 `claude plugin uninstall gauge-usage@gauge-claude-local`。

## 用量口径

- **对话**提供逐轮、累计与趋势视图。输入、输出、缓存读取和缓存写入按 Anthropic API 费率折算，使用日志里记录的模型和速度档位。
- **账号**提供本机历史、筛选与 CSV 复制，按模型、项目和日期汇总。5 小时与周已用百分比来自 Claude Code。
- **周容量**按当前官方周期内本机已计价金额除以官方已用比例估算。普通 Claude Chat 和其他设备的活动可能影响官方比例，这些活动的逐请求金额不在本机 Code 日志里。
- 统计在本机完成。费用是 API 等价金额。Code Mod 和 Codex 版各自安装，各自读取对应的日志。
