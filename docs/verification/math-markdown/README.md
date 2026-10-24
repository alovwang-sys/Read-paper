# 数学 Markdown 验收

2026-10-24：最终源码浏览器 **1/1** 完整路径通过（7.6 秒，退出码 0）；TypeScript、全量单元 **835/835**、其中数学／引用专项 **25/25**、生产构建均通过。25 项专项包含在 835 项内，不重复相加。

真实 PDF 拖选后接收受控的重要性比／GRPO 回答，验证 5 处 KaTeX（其中 2 个 display）、零 katex-error。覆盖 `\(...\)`、`\[...\]`、`$...$`、`$$...$$`；公式里的 `[0]`／`[99]`不被当作引用，代码与普通括号不猜测转换，远程图片和原始 HTML 不加载或执行。公式外 `[1]` 可以定位原文证据。

1440×900、1280×800、1024×800 均验证长公式可在块内横向滚动，浮窗、输入与页面不被撑破。移到右侧继续仍为同一会话，刷新后公式正常，持久化 body/rawBody 保留原始 TeX 分隔符。长公式采用横向滚动，不自动折行。

为保留缩进代码，四空格或 Tab 开头的行不转换新 TeX 括号；深层缩进列表可继续使用原有 `$...$` 公式。

- 截图：[浮窗 1440](screenshots/inline-formulas-1440.png)、[1280](screenshots/inline-formulas-1280.png)、[1024](screenshots/inline-formulas-1024.png)、[右侧继续](screenshots/side-formulas-1440.png)
- [最终浏览器日志](logs/browser.log)、[全量单元](logs/full-unit.log)、[数学／引用单元](logs/shared-unit.log)、[TypeScript 与生产构建](logs/build.log)、[结构化结果](results.json)

[首轮日志](logs/browser-first.log)保留了 0/1：公式与引用定位断言已经通过，但引用定位会收起原文浮窗，测试仍在已收起的浮窗内查找公式而超时。通过既有“上次提问”找回同一记录后，完整重跑通过，没有放宽数学、布局、引用或持久化断言，没有归档大 trace。

加固前后的两轮成功日志另存为 [browser-before-hardening.log](logs/browser-before-hardening.log) 和 [browser-hardening-display.log](logs/browser-hardening-display.log)；最终日志与四张截图均在最后冻结的源码上重新生成。

```sh
npx playwright test tests/e2e/math-markdown.spec.ts --reporter=line,json
```

只使用合成 PDF 与受控响应，没有调用真实模型、操作已安装 App 或用户数据。4 张截图均在 PDF 渲染完成和本地字体就绪后保存，关键图片已人工查看；截图只写本目录。

本轮未修改服务端研究工具或材料编号扫描，不表示所有后台数学处理路径均已修复。
