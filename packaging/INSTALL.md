# 第一次安装 Gauge

Gauge 是运行在 **Codex Mac 桌面端侧边栏**的插件，核心功能是：

- 查看每轮对话的 tokens 和 API 等价费用，回看历史轮次、累计消耗和趋势。
- 给当前对话设置预算，查看生效后的已用、剩余或超支金额。预算默认关闭，按需开启。

**这份说明从你还没有下载、安装 Gauge 开始。下载和安装交给 Codex 完成。**

## 开始前

- 使用搭载 Apple 芯片的 Mac，例如 M1、M2、M3 或更新型号。可以在「 → 关于本机」查看芯片类型。
- 电脑上安装了支持本地插件的 Codex 桌面客户端，并能正常使用。还没有客户端的话，请先完成客户端的安装和登录。
- 电脑能访问 GitHub 下载文件。安装 Gauge 不需要 GitHub 账号或登录。

Gauge 已包含运行环境，无需准备 API Key、Node、Python 或开发工具。当前没有 Intel Mac、Windows 或 Linux 安装包。

## 1. 把这句话发给 Codex

```text
我第一次使用 Gauge，还没有下载或安装这个插件。请按照下面的说明，帮我完成环境检查、下载、校验和安装，并确认插件已启用。安装后告诉我如何第一次打开它：
https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/INSTALL.md
```

Codex 会下载最新安装包、检查文件完整性并安装。你不需要自己找下载文件或输入终端命令。若客户端要求确认安装或信任，请按客户端提示完成。

## 2. 第一次打开

Codex 确认安装成功后，新开一个聊天，发送：

```text
打开 Gauge 用量面板
```

若仍未出现面板，让 Codex 检查 Gauge 是否已启用；如果客户端提示需要重新打开，请保存当前工作后重新打开客户端，再试一次。

面板会在 Codex Mac 桌面端的侧边栏打开：

- 先看「对话 → 轮次」，这里显示每轮 tokens、API 等价费用及费用拆分，可以选择历史轮次回看。
- 想给这段对话设预算，进入「预算」，开启预算、填写金额并保存，再查看已用和剩余。

全新对话没有用量记录时会显示等待状态，正常使用 Codex 后会自动更新。查看费用无需开启预算；预算是软提醒，不会硬性中断对话。

面板中的金额是按 API 价格估算的等价费用，不会因此向你额外扣费。

## 界面截图

截图使用演示数据，预算图为手动开启后的示例；新安装默认关闭预算。

| 每轮对话的费用与 tokens | 对话预算：已用与剩余 | 设置对话预算 |
| --- | --- | --- |
| <a href="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/round-usage.png"><img src="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/round-usage.png" width="280" alt="Gauge 单轮 API 等价费用与 tokens"></a> | <a href="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/conversation-budget.png"><img src="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/conversation-budget.png" width="280" alt="Gauge 对话预算已用与剩余"></a> | <a href="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/budget-setup.png"><img src="https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/docs/images/budget-setup.png" width="280" alt="Gauge 对话预算设置"></a> |

## 想自己下载安装

[下载 Gauge 安装包](https://github.com/DHCFE/gauge-codex-plugin/releases/latest/download/Gauge-mac-arm64.zip)，解压后双击 `Install.command`，按窗口提示完成，然后按照上面的步骤第一次打开。

## 给负责安装的 agent

用户请求的是从零安装。不要假定 Gauge、它的下载包、插件市场或运行环境已经存在。

1. 先检查操作系统、芯片和桌面客户端。优先使用客户端自带 CLI；CLI 路径可由安装器发现。缺少客户端时说明需要先安装客户端，不要将已有 Gauge 作为前提。
2. 下载并阅读 [安装脚本](https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/install.sh)，然后在本机运行已检查的脚本。脚本负责获取最新版本、下载预编译安装包、检查 SHA-256、注册本地插件市场并安装。无需构建源码、安装开发依赖或运行开发测试。
3. 下载失败时沿用本机已有代理设置重试，不改全局网络或信任设置。不要移除系统安全标记。安装过程保持预算默认关闭。
4. 安装后检查插件列表：Gauge 应已安装并启用。向用户说明安装版本和第一次打开的方法；不要仅凭文件已下载就报告成功，不要擅自关闭客户端。
5. 如果检查时发现本机已经装过 Gauge，保留用户数据，参考 [已有安装的处理说明](https://raw.githubusercontent.com/DHCFE/gauge-codex-plugin/main/UPDATE.md)。这是异常处理，不是新用户的必经步骤。
