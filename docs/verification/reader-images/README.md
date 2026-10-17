# 连续阅读、同篇对照、区域图片与系统听写

2026-10-17，`codex/source-intake`，随 PR #15 更新。以下记录实际实现、验证与本机安装结果。

## 产品行为

- PDF 默认纵向连续阅读。顶部页码随滚动更新，输入页码、目录、全文搜索和引用可定位页面。只为可见范围附近与当前选区保留 canvas，每窗最多 6 个，长文献不一次渲染全部页面。
- “分屏阅读”在同一中央标签打开同篇的第二位置，各自滚动、缩放、框选与摘录，共用文献和证据。默认上下，可切左右；中央窄于 760px 时自动上下。引用打开主位置，保留第二位置；关闭后再打开继续第二位置，按研究恢复页码、页内进度、缩放与布局。
- Codex 根据本机模型目录的 `inputModalities` 检查所选型号；未知能力不冒充支持图片。只发送冻结上下文中明确选定的区域，以及所选历史中被引用、合并到当前上下文的区域；不扫描并附加历史所有图片。切为文字型号保留草稿和证据并说明原因。
- 图片通过 `{evidenceId,dataUrl}` 到本机边界，逐项校验来源 hash、格式、数量与大小，再写只读材料文件，以 Codex `localImage` 输入。客户端不能指定本机文件路径，原生标准输出不承载大段 dataURL。最多 4 张、每张 8 MiB；文本预算不含 base64，run 读取/执行合计最多 2 路。
- “语音”在 macOS 桌面聚焦草稿并请求系统听写。反馈为“已请求”，不声称录音已开始；系统未启用时保留设置与快捷键指引。Web/Windows/Linux 提供各自指引。只允许已聚焦工作台主框架请求固定原生命令，不开放任意 selector，识别文字不自动发送。

## 已完成检查

- `npm test`：265/265；覆盖模型能力、真实区域字节请求、未知/文字助手拒绝、双位置独立与研究隔离、引用不改第二位置、备份与旧数据兼容。
- `npm run test:server`：221/221；图片一一映射、hash/签名/体积限制、超过 1 MB 的真实字节传输、原生 localImage、只读材料及原聊天回归。
- 原生图片转卡片、区域摘录直接起草及修订冻结所选图像型号，不继承聊天技能、计划模式或完全访问权限。
- `npm run test:desktop`：24/24；新增听写窗口/焦点/IPC 边界，并验证图片 helper 位于安装白名单。
- 图片、输入区与系统听写浏览器专项：15/15；截图字节的 SHA-256 与持久化区域一致，切模型不丢草稿，语音不自动发送或在测试中录音。

- 连续阅读专项 6/6：滚轮跨页、第二页摘录、60 页 PDF 每窗最多 6 个 canvas、页内偏移、两位置/缩放/方向切换、关闭重开与刷新、研究隔离。1440×900、1280×800、1024×800 三尺寸实际查看，每窗阅读区至少 245px。
- 浏览器全量运行 123 项，122 通过、1 项旧单页选择器失败；将撤销高亮断言限定到被撤销的证据 ID（预加载页的既有摘录应保留）后，该文件 4/4 重跑通过，全部用例已通过本轮回归。其他原有单 canvas 选择器与选区定位按连续页适配，没有放宽来源/撤销断言。
- `npm run desktop:make` 成功生成 macOS arm64 DMG/ZIP；`npm run test:desktop:e2e` 13/13 通过。新增专项核对真实 PNG、区域 hash、第二页索引；正常退出重启后两个位置、图像资产、型号与下一条草稿完整恢复，页面错误 0。

截图：[1440](reader-split-1440.png)、[1280](reader-split-1280.png)、[1024](reader-split-1024.png)、[Codex 区域材料](codex-region.png)、[打包桌面](desktop-reader-images.png)；[桌面机器记录](desktop-reader-images.json)。均使用本产品合成资料，未保存用户真实工作区截图。

## 打包与本机安装

独立检查包内 103 个运行文件（desktop 13、server 10、dist 80）与当前磁盘完全一致；新图片和听写模块已包含，无测试或 `.env` 文件。DMG `hdiutil verify` 有效，只读挂载中的 ASAR 与 out.app 一致，自有挂载已卸载。[包核验](package-evidence.json)。

已正常退出旧应用，保存后用逐项核对的 272 个 bundle 条目替换 `/Applications/Papertrail.app` 并重新打开、置前。实际界面阅读就绪、Codex 就绪、已保存，区域图片拦截提示消失；输入的可访问性值与退出前一致，未自动发送问题或启动听写。旧应用和旧试用 DMG/校验文件移至可恢复废纸篓，用户资料保留。

新安装包 `~/Downloads/Papertrail-0.1.2-reader-images-arm64.dmg`，157,977,092 字节，SHA-256 `35f345a1b79774429b536c1457e1796264305725cf9a0cf02546409f0747e1c3`。安装 ASAR SHA-256 `c7f566f9c2c03125f231ddbe5a73e4f4f8527ca07eb9290db594a9866a0c9077`。[安装机器记录](installation-evidence.json)。

本机只读模型目录查询确认 7 个可用型号均声明 image，包括默认 `gpt-6.1-sol`；未通过该查询生成回答。源码仍在 PR #15，尚未合入 main；本地未验证 Windows/macOS Intel。

## 真实 CLI 图片探针

`node docs/verification/reader-images/codex-image-probe.mjs` 使用真实 `codex-cli 0.162.1`、临时 `CODEX_HOME` 和 localhost 模拟 Responses provider。实际读取 3,147,780 字节 PNG，provider 端字节及 SHA-256 完全一致；0400 图片与 0500 材料目录可读、写入拒绝。回显不包含 base64，最大通知 1,348 字节。1 次本机 provider 请求、0 次真实模型调用、0 次用户会话访问；自有进程、服务与临时状态已清理。[机器记录](codex-image-probe-output.jsonl)、[可复现脚本](codex-image-probe.mjs)。

## 验证边界

合成回答不能证明真实视觉模型的理解质量。系统听写的启动和识别由操作系统设置决定；本轮不自动录音，也不验证识别准确率。未接入 Claude Code/OpenCode 图片、通用图片粘贴上传或独立录音转写服务。

原生协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。系统动作依据：[Electron Menu API](https://www.electronjs.org/docs/latest/api/menu)、[Chromium 系统听写 selector](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/cocoa/accelerators_cocoa_browsertest.mm)。
