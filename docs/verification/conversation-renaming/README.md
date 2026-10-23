# 会话改名验收

2026-10-23：新增单元测试 **11/11**、浏览器测试 **4/4** 通过，退出码均为 0。浏览器最终整轮 18.1 秒，零失败、零跳过，受控请求未出现意外端点、页面错误或热更新。仅使用合成材料、隔离浏览器存储和确定性响应，未操作真实用户数据或已安装 App。

## 已验证

- Codex、Claude Code、OpenCode、模型直连、演示模式均可本地改名；带原生关联的会话仍保留原生引用。改名不切会话，不消费输入，不修改历史、原文锚点、其他研究或既有卡片来源快照。
- 名称去首尾空白并限制 120 字符；空名、缺失或已删除会话拒绝修改。普通 AI 与研究 Agent 两种首次提交路径均保留用户手动填写的“新会话”，不会被首条问题覆盖。
- 保存重新加载、迁移和真实 ZIP 备份往返保留自定义名称及 titleEdited；旧记录兼容，损坏标记拒绝迁移。卡片讨论的显示与搜索使用自定义名，新锚定讨论继承手动命名状态。
- 实际点击侧栏、当前聊天侧边／浮窗／完整模式、原文旁问答和经典历史改名。取消与 Esc 不保存并恢复焦点，空名禁止提交，Enter 保存。讨论名称同步更新，原文问答改名后刷新仍能找回回答及草稿。
- 改名弹窗覆盖 1440×900、1280×800、1024×800，输入及保存按钮完整可见、无横向溢出。关键截图已人工查看。

中文输入保护使用浏览器 compositionstart/compositionend 事件配合真实 Enter 键验证：组词期间不保存，组词结束后可保存。本轮未调用操作系统中文输入法，也未调用真实原生 Agent 或修改原生客户端中的名称。

## 证据

- [单元日志](logs/unit.log)、[浏览器最终日志](logs/browser.log)、[结构化结果](results.json)、[TypeScript](logs/check.log)
- 弹窗：[1440](screenshots/rename-dialog-1440.png)、[1280](screenshots/rename-dialog-1280.png)、[1024](screenshots/rename-dialog-1024.png)
- 讨论：[侧边](screenshots/renamed-discussion-side-1440.png)、[浮窗](screenshots/renamed-discussion-float-1440.png)、[完整](screenshots/renamed-discussion-main-1440.png)
- [原文旁改名](screenshots/renamed-inline-1440.png)、[经典历史](screenshots/renamed-classic-history-1440.png)

```sh
npx vitest run tests/unit/conversation-renaming.test.ts --reporter=verbose
npx playwright test tests/e2e/conversation-renaming.spec.ts --reporter=line,json
npx tsc --noEmit
```

原始失败记录保留：[单元首轮](logs/unit-first.log)为 10/11，测试把“会话「自定义名」”错误地预期成无装饰文字；[浏览器首轮](logs/browser-first.log)为 2/4，测试误收起已自动展开的讨论分组，并把经典历史的 searchbox 误写为 textbox。只修正测试操作和定位，保留全部业务断言后最终整轮通过，没有为测试修改产品实现或旧测试。

集成负责人另行执行的全量检查见 [integration-check.log](logs/integration-check.log) 与 [integration-unit.log](logs/integration-unit.log)：TypeScript 通过，51 个文件共 801/801 单元测试通过。打包、安装及其他回归由集成负责人单独记录。

## 集成与相关回归

全部改动冻结后，集成检查 `npm run check` 和 `npm test` 均退出0，51个文件共801/801单元测试通过，见[完整单元日志](logs/integration-unit.log)。UI负责人运行删除、标记与连续工作区三文件相关回归16/16通过，退出0，见[日志](logs/regression.log)、[结果](regression-results.json)及[证据保留清单](regression-evidence-preservation.json)。两处旧截图逐文件SHA一致，26张本轮新图另存regression-screenshots。

本记录先验证源码；实际桌面打包与安装状态以[0.1.18本机更新](../local-rebuild-0.1.18/README.md)为准，旧版0.1.17安装验收并不包含本次改名增量。
