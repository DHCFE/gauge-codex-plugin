# Gauge 开发与发行维护

面向维护者。第一次安装请看 [新用户安装说明](INSTALL.md)。

## GitHub 仓库 marketplace

官方最短注册方式：

```sh
codex plugin marketplace add DHCFE/gauge-codex-plugin --ref main
codex plugin add tokenlens-prototype@tokenlens-local
```

公开仓库包含 `.agents/plugins/marketplace.json`、完整 `plugin/`（含内置运行时）。安装目录路径全为相对路径，不用手动改配置。兼容旧版标识 `tokenlens-prototype@tokenlens-local`，显示名为 Gauge，避免升级产生第二个插件。

这条路径需要能运行官方 CLI，以及 Git marketplace 所需的 Git 环境。普通 Mac 用户优先使用下载包，安装器调用客户端内置 CLI 并使用本地 marketplace，无需额外 Git/开发工具。官方文档说明仓库市场与公共目录分开，且各客户端面的可用性可能不同；不能承诺只粘贴 GitHub URL 就能在所有 UI 完成安装。

更新 Git 安装：`codex plugin marketplace upgrade tokenlens-local`，再运行 `codex plugin add tokenlens-prototype@tokenlens-local` 并核对版本。固定 tag/ref 时需重新注册新版 ref 后再安装。卸载：`codex plugin remove tokenlens-prototype@tokenlens-local`，再运行 `codex plugin marketplace remove tokenlens-local`。这些命令只针对 Gauge。

官网依据：[Package your plugin](https://developers.openai.com/plugins/build/plugins)。本次已核实 Mac 客户端内置 CLI 0.159.2 具备 add/list/upgrade/remove 命令。公开仓库为 DHCFE/gauge-codex-plugin。

## 维护者构建

在 Apple Silicon Mac 上使用 Python 3.11 和 Node 22+：

```sh
npm ci --ignore-scripts
npm run runtime:mac
npm run build
npm test
npm run release:mac
npm run test:release
```

`runtime:mac` 校验官方 Node 22.23.3 下载摘要，用锁定的 PyInstaller 6.22.3 构建只读计数引擎，收集许可证，并把打包器符号链接转换为普通文件以兼容客户端缓存。Node 压缩存放，插件第一次启动时校验并解压到自己的私有数据目录；不联网或搜索系统运行时。每次启动校验已解压 Node，损坏时从包内重建。所有运行时文件低于 GitHub 单文件 100 MiB 限制，无需 Git LFS。

`release:mac` 每次从当前 `web/` 和 `src/` 构建，校验内置引擎对应当前三份 Python 源码，仅打包明确清单与运行时。产物在 `dist/`，附 ZIP SHA-256 与内部逐文件 SHA-256。ZIP 的哈希用于完整性检查，不替代发布者签名。修改 Python 统计代码后必须重新执行 `runtime:mac`。`test:release` 在隔离用户目录测试实际安装器和随包运行时，不读取真实用户会话。

后续发布：构建并完成 [发行验收](../RELEASE-ACCEPTANCE.md) 后运行 `node packaging/prepare-public-release.mjs`，提交 `.build/public-repository` 的发行文件和版本 tag，再将 `dist/public-assets/` 中的六个文件（含首次安装与更新说明）上传到同一正式 Release。保留固定资产名 Gauge-mac-arm64.zip 和 version.json，才能让安装链接与新版检查继续生效。第三方许可随包保留；本次由用户授权公开发行，不另行指定 Gauge 源代码许可证。若之后需要 Apple Developer ID 签名/公证，另需 Apple 的发布者账号。

运行时参考：[Node 22.23.3](https://nodejs.org/en/blog/release/v22.23.3)、[PyInstaller macOS 签名](https://pyinstaller.org/en/stable/feature-notes.html#macos-binary-code-signing)。

0.5.8 预算默认关闭。插件局部 Hook 需要宿主支持及用户信任；不改全局提示词或 Hook 配置。费用来自 Codex 原始本地记录，额度来自 Codex 官方接口。本地观测容量按范围和假设标示，不是官方美元余额。


## 0.5.8 计价与更新

`plugin/data/prices.json` 收录 GPT-6.1 Terra 的 Standard、Fast、Batch 和 Flex 费率，按每个请求判断 272K 长上下文。缓存写入表采用 30 分钟默认保留期；不能从聚合 token 数反推其他保留期。价格变更后，从请求账本重新计算费用，无需删除用户数据。

面板中的未知费用显示「未计价」，保留已知费用时显示下界；不能把未收录模型当作免费。增加新模型时必须核对官方单价并加入回归测试。顶部手动检查绕过缓存，一键更新绑定所选版本并重新验证最新 manifest，下载不可变 tag 下的 ZIP，校验 SHA-256 和包身份后调用原安装器。

发布前运行 `npm test`、隔离的 `npm run test:startup` 和 `npm run test:release`；`tests/update-actual.mjs` 使用发行 ZIP 在临时用户目录升级，验证安装和预算数据保留。发布 tag、Release 资产与源代码应保持同一版本；不要覆盖已发布的 tag，修复应发新版本。
