# 会话删除与原文标记删除验收

2026-10-23：本轮新单元测试 **15/15**、浏览器路径 **5/5** 通过，退出码均为 0。TypeScript 与差异空白检查通过。仅使用合成 PDF、隔离浏览器存储和受控模型响应；未操作已安装 App、真实研究资料或凭据，未打包、安装或调用付费模型。

## 验证内容

- 侧栏和当前会话标题均可删除；取消不改变记录。删除当前会话回到同研究可用会话，最后一条删除后建立安全的空会话。PDF、阅读位置、布局不变。
- 删除保留未发送输入、全部请求、卡片及其来源、卡片草稿、图片附件和绘图快照。显式恢复找回历史与输入；普通选择、取消归档及就地自动发现不能复活已删除记录。
- 生成请求、原生 busy、卡片生成及 managed 未终止状态拒绝删除。浏览器实际挂起一个受控请求后尝试删除，确认出现拒绝原因；完成请求后回答正常展示。资产准备阶段删除则不登记请求、不调用 responder，也不清空草稿。
- 保存、重新加载、迁移与真实 ZIP 备份往返保留删除墓碑和请求。已删除列表按研究隔离。
- 使用真实鼠标选择 PDF 字形、拖动框选区域，提问后直接移除标记、撤销、刷新、找回上次提问并恢复标记。问答、引用、主会话草稿与 contextOnly 状态保持。
- 已删除的原文局部问答从原位记录打开后只读，保留回答及未发送草稿；显式恢复后可继续编辑，恢复本身不触发模型。
- 删除确认、已删除列表和文字标记操作覆盖 1440×900、1280×800、1024×800；检查按钮在视口内且页面无横向溢出。已人工查看关键截图。

## 日志与截图

- [最终单元日志](logs/unit.log)
- [最终浏览器日志（含 JSON 报告）](logs/browser.log)
- [结构化结果与截图校验值](results.json)
- [TypeScript](logs/check.log)、[diff 检查](logs/diff-check.log)（通过时为空）
- [删除确认 1440](screenshots/delete-confirm-1440.png)、[1280](screenshots/delete-confirm-1280.png)、[1024](screenshots/delete-confirm-1024.png)
- [已删除列表 1440](screenshots/deleted-list-1440.png)、[1280](screenshots/deleted-list-1280.png)、[1024](screenshots/deleted-list-1024.png)
- [文字标记已移除 1440](screenshots/mark-hidden-text-1440.png)、[1280](screenshots/mark-hidden-text-1280.png)、[1024](screenshots/mark-hidden-text-1024.png)
- [区域标记已移除](screenshots/mark-hidden-region-1440.png)、[运行中拒删](screenshots/delete-busy-rejected.png)、[已删除局部问答只读](screenshots/deleted-inline-readonly-1440.png)

运行命令：

```sh
npx vitest run tests/unit/conversation-deletion.test.ts --reporter=verbose
npx playwright test tests/e2e/conversation-deletion.spec.ts tests/e2e/reader-mark-removal.spec.ts --reporter=line,json
npx tsc --noEmit
git diff --check
```

保留了[单元首轮日志](logs/unit-first.log)和[浏览器首轮日志](logs/browser-first.log)：前者 13/15，失败是测试漏传资源 scope 和错误文案预期；后者 3/5，失败是种子 busy 经迁移变为 unknown，以及文字选择器包含其他样例标记。已改用真实进行中的请求、限定 evidenceId，并在最终整轮保留全部业务断言通过。未为测试修改产品实现，也未覆盖旧验收截图。

限制：原生 CLI 进程取消与真实模型输出未在本轮浏览器验收中调用；managed 状态保护由单元测试覆盖。未重跑全量浏览器、服务端与桌面安装回归，本次没有修改服务端或桌面宿主。

## 集成检查

集成负责人在全部源码与测试冻结后执行 `npm run check && npm test && npm run build`，整条命令退出码 0：TypeScript 通过，50 个测试文件共 **790/790** 单元测试通过，生产构建成功。包括新增原生历史延迟读取／删除竞态及白板旧讨论重开保护的两个完整测试文件 43/43，以及文字／区域标记删除与引用保留用例。

构建保留了既有大文件分块及 Excalidraw 同时静态／动态导入提示，不影响本次构建完成。该命令生成前端构建产物，没有重建或替换本机0.1.16桌面App。

## 追加既有回归

- 连续工作区：**11/11 通过**，37.6 秒，退出码 0，覆盖发送、草稿隔离、会话移动、分屏、简要、区域提问、Excalidraw 与资料收录。
- 旧 annotation-removal：2 个尺寸因直接定位折叠在“更多操作”中的“写成卡片”而超时；随后中止（退出码 130），第三尺寸中断，另 3 项未运行。**该组未通过**。
- 旧 inline-ai：2 个尺寸因直接定位折叠的“解释这段”而超时，达到 max-failures=2 后结束（退出码 1）；余下 6 项未运行。**该组未通过**。

这两类旧定位器与既有 UI 不兼容。静态核对 HEAD 6fb1f04 中两动作已在 pdf-selection-more 的 details 内，本轮未移动这些入口；这是[源代码核对](logs/regression-head-reference.txt)，没有声称重新运行旧版本 baseline。新测试已用现行真实入口覆盖核心操作。未为旧测试修改实现或测试文件。

[合并原始日志](logs/regression.log)、[连续工作区日志](logs/regression-continuous-workspace.log)、[标记组中断日志](logs/regression-annotation-interrupted.log)、[就地问答日志](logs/regression-inline-ai.log)、[就地失败 traces](regression-artifacts/)。旧证据 29 个 PNG 在每轮结束后均 SHA-256 一致；14 张本轮新图另存 regression-screenshots，旧证据目录无 Git 差异。见[证据恢复清单](logs/regression-evidence.json)。

归档中的两份单元日志仅规整末尾多余空行，命令输出内容保留。
