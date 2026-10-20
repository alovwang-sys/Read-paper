# Excalidraw 桌面本地字体诊断

2026-10-20；范围：本轮新增 Excalidraw 0.18.1，在打包的 macOS arm64 Papertrail 中验证。接手时工作区包含其它 agent 的绘图、持久化和 AI 改动，本次未重置或清理这些内容。

接手时两次调整字体初始化位置仍未通过桌面绘图测试。保留的[失败基线](font-failed-baseline.json)记录同一测试 `status: failed`：230 条 esm.sh 字体请求、230 条请求失败、230 条 CSP 错误、本地字体响应记录为 0。此摘要取自原始 Playwright 观察文件；原文件路径保留在 JSON 中。

本轮调用关系为 `main.tsx → drawing-assets.ts（设置字体路径）`，随后 `BoardDrawing.tsx → Excalidraw Fonts → FontFace → papertrail 协议 → dist/excalidraw-assets/fonts`。测试的 Playwright 网络观察与 Electron 协议属于不同观察通道。

[实际构造参数探针](font-baseline.json)排除了初始化时序与本地资产缺失：FontFace 注册时已收到 `papertrail://app/excalidraw-assets/fonts/…` 本地源，随后仍附加同文件的 esm.sh fallback；读取本地文件返回 200、`font/woff2`、24,956 字节，独立 FontFace 从该 URL 加载为 `loaded`。Excalidraw 0.18.1 的 `createUrls` 无条件添加 CDN fallback；Chromium 在构造 FontFace 时就对该来源执行 CSP 检查，因此出现 230 条拦截，并不代表 230 个本地字体加载失败。

[只读过滤探针](font-filter-probe.json)在独立临时用户目录验证：去掉匹配本地字体的同文件 CDN fallback 后，Excalifont 与中文 Xiaolai 均为 `loaded`，CSP 错误为 0。Playwright `page.request` 和 Resource Timing 仍未报告 papertrail 字体，而 Electron `session.defaultSession.webRequest` 实际记录了 7 个本地字体请求。因此桌面测试改用 Electron 网络事件观察自定义协议，原有“字体请求大于 0、全部本地、无外域请求、无 CSP 错误及退出重启保留”断言继续保留。

修复只在 `src/drawing-assets.ts` 的 FontFace 构造边界去除已经存在本地副本的 Excalidraw 0.18.1 同文件 fallback；其它字体、不同文件、额外来源、二进制来源、构造器原型和描述符保留。没有修改 node_modules 或放宽外域 CSP。`main.tsx` 已有的首个字体配置 import 保留；本轮没有增加 bootstrap、改动 HTML 或调整协议。

已实际执行：

```text
npm run check
exit 0

npx vitest run tests/unit/drawing-assets.test.ts
Test Files  1 passed (1)
     Tests  4 passed (4)
exit 0

npm run desktop:package
✔ Packaging for arm64 on darwin
✔ Packaging application
exit 0
```

桌面严格测试已通过，`/tmp/papertrail-desktop-drawing-final/.last-run.json` 记录 `status: passed`、`failedTests: []`。命令为：

```text
npx playwright test --config playwright.desktop.config.ts tests/desktop/drawing.spec.ts --output=/tmp/papertrail-desktop-drawing-final --reporter=list
1 passed (4.7s)
exit 0
```

[最终桌面证据](font-desktop-evidence.json)记录 10 个不同的本地字体 URL，首次打开与退出重启共 20 条响应，全部返回 200；字体失败、外域请求、模型请求、页面错误和 CSP 错误均为 0。真实矩形及中文文字已经保存，退出重启后场景、资产 hash 和绘图模式一致，`drawingRetainedAfterRestart: true`。界面截图为 [desktop-drawing.png](desktop-drawing.png)。

退路：本轮无 commit/stash；删除新增的 FontFace 兼容段可恢复接手时的字体路径配置，现有用户数据不受影响；该退路会恢复已记录的 CDN CSP 噪声。兼容段按 0.18.1 的来源序列实现，升级 Excalidraw 时须复核来源格式并运行同一桌面测试。本轮未验证 Windows 打包结果。

复发记录：根因 `dependency-default-external-font-fallback`，本项目本轮锚定 1 次；全局历史计数未知。角色定义不在本次修改范围，未修改；PMB 不可用，以此记录保存本轮证据。
