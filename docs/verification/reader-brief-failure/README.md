# 原文提问被文章简要阻断：专项验收

2026-10-24：新增单元测试 **16/16**、浏览器测试 **4/4** 通过，退出码均为 0。浏览器整轮 10.8 秒，零失败、零跳过、零页面错误、零意外请求及热更新。5 张截图均等待 PDF 页面渲染完成后保存，覆盖 1440×900、1280×800、1024×800。最终来源边界审查后只追加专项单元，没有重新启动浏览器。

## 问题与修复边界

原链路先为原文旁提问生成隐藏的文章简要，却把该任务设成 card，要求模型输出 title/body/evidenceIds JSON。简要的卡片格式校验失败会继续抛出，导致用户真正的原文问题根本没有发送。界面因而出现“文章简要暂不可用”和“卡片标题、正文或来源格式不正确”，虽然用户只在提问。

修复后，简要使用独立 brief 请求，输出普通 Markdown；卡片和 revision 仍严格校验 JSON。简要一般生成／提取失败或内部超时，会明确显示“文章简要暂不可用 · 本轮仅使用选区”，继续发送本次显式文字或区域图片，不附送失败简要。原文 hash、原研究目录、连接、工作区变更以及用户停止属于硬边界，不允许借降级继续发送。单纯切换当前研究仍允许已绑定请求归原研究完成，不能污染新研究。

## 实际覆盖

- 使用真实 liveResponder 配合受控 fetch，穿过实际响应解析，验证 brief Markdown 不再被要求生成卡片 JSON；正式卡片和 revision 的无效来源仍被拒绝。
- 模拟用户遇到的原卡片格式错误，文字及区域问题都只发送一次。冻结的文档、页码、选区证据和区域 PNG 字节保持，失败简要不进入背景材料，不产生卡片草稿。
- 真正的问题失败时保留输入，按原快照重试；浏览器连续点击重试仍只新增一轮真正问题。主会话的独立草稿不混入局部问答。刷新能找回结果与可见的选区降级说明。
- 内部简要超时可以降级；停止后零迟到问题，空输入恢复原问题，后来新写的草稿不被覆盖。目录、连接、原文 hash、工作区重新加载以及 hash 变化与模型失败同时发生的竞态均禁止迟到发送。
- 最终独立审查还覆盖真实 PDF loader 直接以普通 Error 拒绝原文件 hash 校验：即使文档元数据 hash 没变，也必须阻止简要和问题发送并保留问题。只有 PDF 已成功加载后的 getTextContent 普通提取错误才允许仅选区提问。内部简要超时仍可降级。
- 浏览器实际拖选 PDF 字形、框选区域并导出 PNG，不用伪造 DOM 选区。三尺寸均验证输入在视口内且页面无横向溢出。已人工查看区域 1280／1024 及失败重试图，结果与输入清晰可读。

## 证据与真实失败记录

- [来源边界审查后单元日志（16项）](logs/unit-source-boundaries.log)、[此前专项单元日志（14项）](logs/unit.log)、[浏览器日志](logs/browser.log)、[结果与截图校验值](results.json)、[TypeScript](logs/check-final.log)
- [文字降级](screenshots/text-brief-fallback-1440.png)
- 区域降级：[1440](screenshots/region-brief-fallback-1440.png)、[1280](screenshots/region-brief-fallback-1280.png)、[1024](screenshots/region-brief-fallback-1024.png)
- [真正问题失败后重试](screenshots/retry-retains-original-question.png)

[单元首轮](logs/unit-first.log)为 7/10：两处测试假设需要修正（文字快照默认省略 kind；工作区加载优先采用恢复 journal），另发现隐藏简要阶段停止后，空输入没有回填原问题。集成负责人修复回填条件，并增加“不覆盖新草稿”保护，当时 14 项全部通过；随后来源边界补审新增两项，专项最终为 16/16。

[浏览器首次启动](logs/browser-first.log)为 0/4，原因是缺少当前 Playwright 所需的 Chromium headless 测试缓存，业务路径没有执行。已仅补齐测试缓存，记录在 [browser-install.log](logs/browser-install.log)，没有改动项目依赖或真实 App。

之后[业务首轮](logs/browser-before-stop-fix.log)为 3/4：**验证停止时恢复输入的修复过程中**发现，停止按钮同步重渲染后复用为 submit，同一次 click 又产生了第二次简要请求。该现象不代表原版本必现：原先空输入会使发送按钮禁用。通过在停止处理前 preventDefault 阻止默认提交后，最终整轮严格验证“仅一次 brief、零 chat”通过。保留了[完整 trace](artifacts/stop-double-brief/trace.zip)、[失败上下文](artifacts/stop-double-brief/error-context.md)与[三个请求的 URL、ID、时间](artifacts/stop-double-brief/requests.json)，没有放宽断言。

## 集成检查与范围

最终独立审查发现，真实 loadPdfDocument 在原文件 hash 校验失败时直接抛普通 Error，原先的一般错误降级会把这类错误误当正文提取失败。集成负责人已将 PDF 加载／校验失败转为硬边界；新增两项专项回归均通过，日志为 unit-source-boundaries.log，另有使用真实 PDF 字节的 hash 不匹配回归。此次最终来源边界调整以单元验证，没有另外重跑浏览器。

集成负责人已在最终来源边界修复源码下重新执行 TypeScript、全量单元 **818/818（52 文件）**及生产构建，均通过；服务端 **360/360** 也已通过。日志：[最终 TypeScript](logs/check-final.log)、[最终全量单元](logs/full-unit-final.log)、[服务端](logs/full-server.log)、[最终构建](logs/build-final.log)。构建仍有既有 chunk 体积和 Excalidraw 静态／动态导入提示，首次 815 项全量检查日志也保留在本目录。

兼容性负责人另跑既有 continuous-workspace 回归 **11/11**（38.4 秒，退出码 0），与专项 4 项合计本轮浏览器 **15/15** 通过。16 项专项单元已包含在 818 项全量单元内，不重复相加。兼容性[日志与 JSON](compat-logs/)、[本轮截图](compat-screenshots/screenshots/)、[旧证据恢复清单](compat-logs/continuous-evidence-preservation.json)均已归档；旧目录 20 张 PNG 按 SHA 原字节恢复，14 张本轮新图另存。

```sh
npx vitest run tests/unit/reader-brief-failure.test.ts --reporter=verbose
npx playwright test tests/e2e/reader-brief-failure.spec.ts --reporter=line,json
```

全部材料为合成 PDF，项目目录和模型／Agent 端点均受控；结果用于验证链路，不表示真实模型已解释用户截图中的公式。未读取用户论文、密钥或原生会话，未调用真实模型，未操作已安装 App，未打包重装。专项截图只写本目录，其他兼容性回归由集成负责人另行记录。

归档日志已去除终端颜色与行尾空白；通过／失败结果与请求内容不变。
