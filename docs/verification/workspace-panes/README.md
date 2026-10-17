# 多窗格工作区验收

2026-10-17，`codex/source-intake`，随 PR #15 更新。用户确认以可递归分屏与每组标签替代固定两窗；[产品与交互设计](../../panes/README.md)。本页是当前批次的结果，早期两窗记录保留作历史。

## 已验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 21 文件、279 项通过 |
| `npm run test:server` | 221 项通过 |
| `npm run test:desktop` | 27 项通过 |
| 浏览器全部 131 项 | 首轮 129 通过；两项仍定位旧标签栏的测试适配后，`npx playwright test --last-failed` 2/2 通过，未改生产逻辑或放宽断言 |
| 多窗与连续阅读、标签专项 | 18/18，通过真实鼠标拖放；[专项记录与十张截图](browser-verification.md) |
| 完整研究链路复跑 | `knowledge-flow.spec.ts`＋`workbench.spec.ts` 13/13 通过，保留页码、引用、实体 ID 与文件 hash 断言 |
| `npm run desktop:make` | macOS arm64 DMG 与 ZIP 成功 |
| 最终打包桌面 `npm run test:desktop:e2e` | 14/14；[机器记录](desktop-verification.json) |
| 产物一致性 | 104 个 desktop/server/dist 文件逐字节一致，DMG 有效且只读挂载 ASAR 相同，无测试或 `.env`；[核验记录](package-evidence.json) |

验证覆盖四方向继续分窗、不对称六窗、中心移动与 Option 复制、标签排序/关闭/固定、分隔条拖动与键盘、放大还原、收拢后保留同篇多个视图、共享卡片、文稿及白板、按研究恢复和未发送草稿。1440×900、1280×800、1024×800 均实际运行和查看本产品截图；窄窗口保留树结构，可收起侧栏或放大当前窗格。

真实拖放新增了加载期间的回归：目标 PDF 仍在加载时开始拖动，在预览期间完成 PDF 解析并替换底层 DOM，再松开鼠标，原视图仍成功迁入。接收层在整次内部拖动期间保持稳定，研究 scope 在落下时校验。

单元回归覆盖同篇多视图备份完整往返、旧版后台标签阅读位置迁移、取消摘录后清理定位，以及白板打开资料的摆放来源。移出白板只清理已失效定位，保留资料实体；错误的资源映射仍被拒绝。

## 桌面证据

最终包正常退出重启后，布局树、两个视图 ID、页码、缩放与页内偏移一致。真实区域 PNG 与冻结来源 hash 相同；已有区域引用不会将复制/移动后的非零阅读偏移重置到旧高亮位置。

- [阅读与图片](desktop-reader-images.png) · [阅读位置、布局和 PNG 记录](desktop-reader-images.json)
- [PDF＋卡片](desktop-pdf-card-1440x900.png) · [白板＋原文](desktop-board-source-1280x800.png)
- [文稿＋AI 1440](desktop-writing-ai-1440x900.png) · [1024](desktop-writing-ai-1024x800.png)
- [全屏退出入口](desktop-fullscreen.png) · [恢复窗口](desktop-window-restored.png) · [原生输入及窗口记录](desktop-fullscreen.json)

快捷键使用 Electron `webContents.sendInputEvent` 经过真实 `before-input-event` 与 enter/leave-full-screen 事件，不将 CDP 输入等同于物理键盘验证。所有公开截图均为合成研究资料。

## 安装包

本机 Downloads：`Papertrail-0.1.2-workspace-panes-arm64.dmg`，157,991,697 字节。

- DMG SHA-256：`769b5f8641247d477c7c05f5eb6fe3916dd4dbf8038772e50135f7e10e93fbdd`
- ASAR SHA-256：`f543ced7c1ab5d6834609018351e8d1d6d536d15b5773b51e34732083880435c`

已替换 `/Applications/Papertrail.app` 并实际打开。原研究、12 条提问记录、空草稿和 PDF 第 1/14 页两处阅读位置保留；实际进入原生全屏后，使用可见退出按钮恢复窗口及系统按钮。旧应用、两份旧 DMG 与校验文件、未安装的旧暂存包共六项移至可恢复废纸篓，未清空废纸篓。完整应用数据留有本机私有备份。详见[安装证据](installation-evidence.json)。

## 已知边界

同一白板的视口仍共用原有研究会话；文献阅读位置按视图独立。未新增跨系统窗口拖放、通用图片粘贴、触屏分屏或浏览器扩展。本轮 AI 使用确定性接口，没有验证新的真实模型视觉回答或实际系统听写识别；一次真实 Codex 能力探测返回 502，已有错误处理生效，不能算在线服务验收。Windows 与 Intel Mac 未在本机人工验证。

更新时发现旧版的目录同步失败会被泛化为“本机 Agent 连接失败”，且错误后的退出窗口只允许返回。具体底层 errno 未取得，本轮没有修改该服务逻辑，也不宣称已修复此问题；安装过程保留应用数据备份，并将维护退出与正常 Quit 区分记录。
