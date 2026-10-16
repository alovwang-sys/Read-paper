# 桌面安装与 GitHub 流程验收

日期：2026-10-16。基线：`main` 的 `502f7f9`，实现分支 `codex/desktop-installers`。本记录区分本机实际验证、GitHub CI 与正式分发；不把存在打包配置当作跨平台已经验收。

## 本机已经执行

环境：macOS Apple 芯片、Node.js 24.21.0、Electron 44.8.0、Electron Forge 8.0.1。所有模型相关自动化使用确定性测试或演示响应，本轮没有调用付费模型。

| 命令/操作 | 实际结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 85 项通过；包含备份 15 项、等待保存和保存失败恢复 |
| `npm run test:server` | 15 项通过 |
| `npm run test:desktop` | 11 项通过；本地随机端口与 token、取消、协议路径、加密设置、打包白名单与剪贴板权限 |
| `node --test .github/scripts/release.test.mjs` | 12 项通过；版本/main 来源、完整资产、草稿幂等、已发布拒写、tag 漂移和校验和 |
| `npm run test:e2e` | Chromium 16 项全部通过 |
| `npm run desktop:make` | 生成 macOS arm64 DMG 与 ZIP |
| `npm run test:desktop:e2e` | 核心真实打包应用 4 项通过，另新增剪贴板权限定向 1 项通过 |
| 挂载 DMG → `ditto` 复制到独立临时安装目录 → 卸载镜像 → 从复制后的 `.app` 运行首项桌面测试 | 通过（1 项）；未依赖 Vite 或开发 AI 服务 |
| Actionlint 1.7.11、YAML 解析、`git diff --check` | 通过；Actions SHA 已通过官方仓库核对 |

桌面核心四项与剪贴板定向覆盖：

1. 固定 `papertrail://app/`，主区不能读取模型密钥，未开放 Node；实际 ASAR 不含 `.env`、证书、Git、测试、文档或私人资料。内置 PDF/worker 可渲染，三个主区与右侧组合可操作；模型连接写入系统加密文件，客户端 config 不返回密钥；1440×900、1280×800、1024px 均截图。超过 1.5MB 恢复缓冲限制的正文，编辑后立即退出并重启仍保留。
2. 注入 IndexedDB 配额错误，退出不关闭窗口且保留最新文字；恢复写入并重试后可退出。
3. 演示流式生成中退出，收到的文字保留，状态为 stopped，仍归原研究。
4. 丢弃 renderer 的关闭回应，10 秒后保留工作台，只有模拟用户明确选择“强制关闭”才退出；不超时自动放行。
5. 仅工作台主框架可写剪贴板，模型设置窗口和读取权限保持拒绝；打开并关闭设置后仍正确。仅在可丢弃 CI 系统中实际写入/读取复制结果，本机只验证权限，不触碰用户剪贴板。

备份浏览器 E2E 覆盖真实 PDF ZIP、损坏 ZIP 拒绝、确认前不替换、确认后所有资产 SHA-256/研究/引用/布局一致、刷新恢复，以及同事务的 `before-backup-restore` 原资料副本。保存失败时仍能将内存最新文字导出，数据库与保存错误状态不伪装成功。

## 本机产物

构建目录（Git 忽略，安装文件不提交仓库）：

- `out/make/dmg/arm64/Papertrail-0.1.0-macos-arm64.dmg`
- `out/make/zip/darwin/arm64/Papertrail-darwin-arm64-0.1.0.zip`

当前为未配置发行者签名的预览构建。DMG 的本机挂载/复制/运行验证不等于从互联网下载后已通过 Gatekeeper；本轮未将预览包写入用户的系统“应用程序”目录，也未覆盖现有安装。

## 截图

- [PDF＋右侧卡片，1440×900](01-pdf-card-1440x900.png)
- [白板＋右侧原文，1280×800](02-board-source-1280x800.png)
- [结论＋右侧 AI，1440×900](03-writing-ai-1440x900.png)
- [1024px 折叠与抽屉](04-writing-ai-1024x800.png)
- [桌面存储与备份](05-storage-1280x800.png)
- [备份替换预览，1440](backup-preview-1440.png)、[1280](backup-preview-1280.png)、[1024](backup-preview-1024.png)
- [保存失败后仍可备份](backup-save-error.png)

以上均为本产品的真实运行截图。AI 演示/模型能力 stub 仅用于可重复验证，不代表桌面版真实付费模型冒烟。

## GitHub 与分发边界

PR/main CI 在 Linux 执行全部确定性检查，之后在 macOS arm64、macOS x64、Windows x64 构建并启动各自应用；结果以本 PR 的 GitHub Checks/Actions 为准。本记录中的本机数据不替代其余两个架构的云端结果。通过后的安装包在该 run 的 artifacts 下载，保留 14 天。

首轮 CI 的基础检查与浏览器 16 项已通过，macOS arm64 DMG/ZIP 已生成；桌面测试在受限的云端显示分辨率下等待已折叠左栏的按钮而失败。trace 证实工作台已正常显示；测试已改为先设置 1440×900 逻辑视口，再验证入口，并在启动断言失败时关闭测试进程。1024px 折叠场景仍单独验证，不能通过隐藏该场景来伪造通过。最终是否全部通过仍以 PR 当前 head 的 Checks 为准。

版本 tag 必须与 package 版本一致且指向 main 历史。全部检查和平台成功后，单个只做资产处理的写权限 job 创建 Draft + Pre-release；不会自动正式发布。不推送功能分支 tag，不覆写已发布版本，不把预览包提交到 Git。

尚未完成：Apple Developer ID / 公证、Windows 发行者签名、干净系统的安装器/卸载界面和旧版升级验收、真实桌面模型冒烟、自动更新和跨设备自动同步。现有完整备份只接受原始 ZIP32，文字/对话 16 MiB、总内容 256 MiB、单个资产 64 MiB；数据库中保留上次恢复前副本，尚无单独 UI 提取该副本，因此恢复前仍建议先导出 ZIP。

`npm audit` 当前报告 4 个 high、4 个 low：high 来自开发打包工具 `appdmg → image-size` 的 ICNS 解析拒绝服务漏洞，依赖链暂无兼容修复；只使用仓库自有图标/背景，不解析用户提供的安装美术，该工具不随 ASAR 分发。low 来自既有数学渲染依赖的传递 KaTeX 版本。本轮未使用 `audit fix --force` 破坏性降级，后续通过 Dependabot/上游修复跟踪。
