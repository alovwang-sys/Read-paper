# 0.1.19 macOS 本机试用包

2026-10-26 按用户要求，将当前工作区源码打包为 macOS Apple 芯片（arm64）0.1.19。包含 PDF 跨页文字／区域选择、自动滚动、逐页证据，以及白板改名、来源讨论折叠和列表主体点击；也包含此前文章简要与公式显示修复。Word 引用仍仅有方案，未开发加载项。

安装文件位于项目根目录下：

- `out/make/dmg/arm64/Papertrail-0.1.19-macos-arm64.dmg`
- `out/make/zip/darwin/arm64/Papertrail-darwin-arm64-0.1.19.zip`

打包阶段未替换本机安装版。随后用户明确要求安装，现已将 `/Applications/Papertrail.app` 从0.1.18更新为0.1.19，并完成原资料恢复与重启检查；完整备份和实际边界见[安装记录](local-install.md)。没有创建 tag、提交、推送或公开发行。应用与安装包仍是未配置发行者签名／公证的技术预览。

## 本轮实际验证

- `npm run desktop:make`：类型检查、前端构建、Electron 打包及 DMG／ZIP 制作通过。第一次下载 Electron 遇到 `fetch failed`，原命令开启诊断后重试成功；下载文件 SHA256 与已安装依赖的校验表一致，没有改下载源、依赖或打包配置。见[首次记录](build.log)和[成功记录](build-retry.log)。现有大分块与无效动态导入警告仍保留。
- `npm run test:desktop:e2e -- tests/desktop/continuous-workspace.spec.ts`：真实打包应用 **4/4通过**，每项均正常退出并重启，断言版本0.1.19、固定应用协议、隔离资料目录与进程正常退出。覆盖同一会话换位置与草稿恢复、原文选择翻译／摘要卡片及操作记录、会话改名保护，以及本轮白板列表留白点击、标题同步、讨论折叠和草稿重启恢复。白板、关系、会话及另一研究数据保持断言通过。AI 使用受控响应，没有调用真实模型。见[运行记录](desktop-tests.log)。
- 逐一校验包内 **499个构建文件**，与当前 `dist` 字节校验一致；确认跨页逐页入口、白板改名及来源讨论折叠代码进入应用，且不包含项目源码、测试、文档、Git目录或环境配置文件。见[包内容检查](package-content-check.json)。
- DMG 校验、ZIP 全量压缩数据检查通过。只读挂载 DMG 并读取 ZIP，确认二者版本均为0.1.19，核心应用归档 SHA256 与测试用 App 一致；挂载已卸载。见[DMG检查](dmg-check.log)、[ZIP检查](zip-check.log)、[安装包内容检查](artifact-content-check.json)及[SHA256SUMS](SHA256SUMS)。
- 实际检查本轮桌面截图；会话视图覆盖1440×900、1280×800及1024×800，白板专项为1440×900。见[白板重启后](screenshots/desktop-board-after-restart.png)、[PDF与聊天1280](screenshots/desktop-resource-chat-1280.png)和[1024](screenshots/desktop-resource-chat-1024.png)。

本轮没有重新执行完整源码测试集；跨页正反拖选、超限、刷新、逐页回查和研究隔离的源码阶段验证见[专项记录](../cross-page-selection/README.md)。本轮4项桌面测试没有重新覆盖全部跨页拖选场景，包内校验不能替代这些交互测试。没有验证真实模型回答质量或Windows／Intel安装；真实资料升级后的界面与重启另见[安装记录](local-install.md)。

2026-10-28 提交前复核：本机开发依赖目录已不存在，类型与单元检查因缺少 `tsc`／`vitest` 未能启动，未将本次复核计为测试通过；保留上述实际已完成的验证结果。公开构建日志仅整理机器路径与行尾，不改变命令结果；含私有备份路径的详细安装记录仅留本机，已加入忽略规则。
