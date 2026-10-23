# 阅读摘录与卡片预览验收

2026-10-23，隔离 Playwright / Chromium 验证本地阅读预览。**9 项通过，0 项失败，0 个运行错误，0 个外域或 API 请求**。结果见 [results.json](results.json)，七个预览源文件起止哈希一致，包含新增 `workspace-paper-notes.jsx`。

运行方式（仓库已有 Vite 在 `127.0.0.1:5173` 运行）：

```sh
node docs/agent-native-evolution/conversation-redesign/verify-workspace-reader-notes.mjs
```

已验证真实鼠标选择两段不同原文、重复摘录去重、PDF 第 12 / 13 页对应 `pageIndex` 11 / 12、卡片正文编辑与引用复用、稍后继续／关闭／Escape 后恢复未保存草稿、切资源及双阅读视图共用摘录和卡片、来源回页与独立页码、操作不改变会话和未发送输入，以及 1440×900、1280×800、1024×800 的按钮命中和键盘路径。

本次核对修掉跨段引用丢失段落换行、来源无法匹配时可能沿用旧选区的问题。最终冻结版严格验证：保存 quote 与原生选文完全相等（含段落分隔），点击来源后精确选回同一完整 quote。`quoteOffsets` 另有精确匹配、空白位置映射、空引用与未匹配返回 `null` 的纯函数断言，未为测试改写页面原文。

已实际打开并检查最终图片：[1440px 卡片编辑](reader-card-editor-1440.png)、[保存后的卡片](reader-card-saved.png)、[1024px 编辑器](reader-editor-1024.png)、[跨段引用定位](cross-paragraph-source.png)。其他证据：[不同摘录及页索引](different-selection-excerpts.png)、[双视图共享保存项](shared-reader-evidence.png)。

旧 17 项回归中，第 14 项此前固定的短示例句已同步为现在实际携带的完整高亮原句；仅更新此文本 fixture，保留原断言类型、去重、选区携带、输入与消息检查。此前 16/17 不计为最终通过；同步后最终回归 **17/17 通过**、源码稳定，结果单独保存在原目录。拖拽 **6/6** 已原样通过，统计不合并为生产测试。新专项七源哈希包含新增阅读模块，补充旧回归六源列表的范围。

PDF 正文和资料为合成内容，保存项和草稿仅在页面内存中。没有读取用户浏览器资料、连接真实模型、验证真实 PDF 引擎或正式产品持久化，也未打开安装的 Papertrail。外域与 `/api/` 请求均被阻断。
