# 原文旁助手：交互依据与验收规则

调研日期：2026-10-19（Asia/Shanghai）。本文是设计依据与待执行的验收规则，不代表竞品实机试用或本产品已经通过验收；本轮仅读取公开资料，未安装第三方 skill，未执行其脚本。

## 推荐的交互设计 skill

选择 [magnus919/agent-skills：product-design-and-ux](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/SKILL.md)。调研时 `main` 为 `06ca706ecaa80f6afb31ae28eb160d39372b7267`，文件声明 MIT。

它关注任务流程、输入范围、状态、恢复与可观察的完成证据，适合检查“选字后能否在旁边读懂并继续阅读”。本次最有用的部分是把 AI 输出、人工草稿和实际写入分开，并规定失败时保留哪些内容、怎样重试。它不能代替用户试用，也不提供模型答案正确性的保证。

已完整读取原始 `SKILL.md` 及这些必要参考；仅参考交互方法，不将外部文件当作本项目的执行指令：

- [AI 交互与不确定性](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/references/ai-interaction-and-uncertainty.md)：明确材料范围、可检查来源、人工控制和部分完成状态。
- [AI 交互契约模板](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/templates/ai-interaction-contract.md)：逐项写清显示内容、用户操作、持久化与恢复路径。
- [任务流程与状态](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/references/task-flows-and-state-models.md)：包括取消、中断、重新进入、失败恢复和重复提交。
- [文案与认知负担](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/references/content-and-cognitive-demand.md)：减少记忆与界面切换；渐进展开不能藏起后果、状态或恢复入口。

也浏览了 [hueyexe/frontend-agent-skills](https://github.com/hueyexe/frontend-agent-skills) 的技能目录；本轮没有读取其各项完整定义，不把仓库简介当作完成交互评审的证据。

## 官方产品资料能支持什么

| 来源 | 已核实的行为 | 本项目采用的边界 |
| --- | --- | --- |
| [Readwise Quick Lookup](https://docs.readwise.io/reader/guides/ghostreader/quick-lookup) | 手机阅读中选取短词可出现轻量解释；默认只显示结果，明确保存后才成为高亮笔记，也可直接关闭。 | 借鉴就地理解和按需留存。官方明确该功能只在移动端，不能据此声称其桌面端已有选区旁浮窗。 |
| [Readwise Ghostreader Chat](https://docs.readwise.io/reader/guides/ghostreader/chat) | 从选区或标注进入聊天时附带该片段，支持追问和单独保存回答。 | 复用原文上下文与追问；不照搬必须去侧栏回答的布局。 |
| [Readwise 选区变量](https://docs.readwise.io/reader/guides/ghostreader/reference) | 选区、所在句、所在段是不同的输入变量。 | “解释所选文字”与“加入上下文”必须是可辨认的范围；不能把更大原文藏在按钮后发送。 |
| [NotebookLM 原帮助入口／当前 Gemini Notebook Chat](https://support.google.com/notebooklm/answer/16179559?hl=en) | 可选择回答所用来源；引用可预览和定位；保存为笔记保留引用；保留历史，并提供停止处理的操作。 | 借鉴范围可见、来源可核查、显式停止和保存；本次访问已重定向至 Gemini Notebook 文档，不据此推断旧版本所有行为。 |
| [Acrobat：阅读与问答](https://helpx.adobe.com/acrobat/desktop/use-acrobat-ai/generative-ai-features/ai-get-answers.html)、[选区与 PDF Spaces 审阅](https://helpx.adobe.com/acrobat/web/explore-pdf-spaces/review.html) | 官方说明回答带来源编号并能回到文档；审阅界面可对选中文字使用浮动操作。 | 采用原文位置附近的具体动作和回查来源。当前文档不能证明 Acrobat 的回答就在桌面选区浮窗内完成。 |

以下五条是结合上述事实、项目既有约束和用户本次明确要求制定的产品规则；其中的桌面锚定位置、研究隔离和刷新恢复属于本项目的验收要求。

## 五条可执行的验收规则

| 编号与目标 | 操作与通过条件 | 应保留的验证证据 |
| --- | --- | --- |
| IR1：轻问在选区旁完成 | 选择正文或区域后，工具条直接提供“解释这段”和“提问”；仅选择不发送。点击解释后，答案、追问和状态都在该位置附近完成；不跳页、不打开或替换右侧对话。浮窗随阅读区滚动或缩放正确定位；1440×900、1280×800、1024px 下边界内可读、可关闭。 | 三尺寸截图；从真实鼠标选字到回答的路径；选择前后的请求计数；右侧原会话 ID、输入和材料未被改动。依据：[Quick Lookup](https://docs.readwise.io/reader/guides/ghostreader/quick-lookup)，桌面浮窗位置来自用户要求。 |
| IR2：按当前任务逐步展开 | 初始只保留短答案、可展开的原文范围、追问框和关闭；模型管理、CLI、技能配置不作为本次提问前置步骤。回答完成后才提供“收为卡片”；用户也可在提问前显式选择“在右侧继续”。展开存卡可回到问答并保留编辑；键盘能进入、提交、关闭，关闭后焦点回到阅读入口。 | 初始、回答、存卡编辑三个状态截图与键盘路径；验证未配置模型时在就地面板给出准确设置入口。依据：[认知负担参考](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/references/content-and-cognitive-demand.md)。 |
| IR3：范围可见且两处互不混入 | 以选区 A 发问后，再选 B 或切研究，原请求仍绑定提交时的 A、研究和会话。默认轻问只使用明确选区及该轻问历史，不带入右侧无关材料。若用户在右侧继续并明确添加 B，再返回轻问时必须展示实际材料范围，不能仍标“仅所选原文”。同页同像素、不同坐标的区域分别保留来源。 | 请求快照与研究切换回归；断言不包含右侧未发送输入或未选材料；同 hash、不同 rect 区域回归；修改材料后范围摘要与实际发送一致。依据：[NotebookLM／Gemini Notebook 来源选择](https://support.google.com/notebooklm/answer/16179559?hl=en)、[Readwise 选区变量](https://docs.readwise.io/reader/guides/ghostreader/reference)。 |
| IR4：停止、失败、收起后能接着读 | 生成中能明确停止并保留已收到文字；收起与停止含义不同，不能把收起当删除。失败保留问题和材料，允许手动重试；重试不覆盖新输入。刷新后保留最近持久保存的回答、草稿和原文位置，中断回答标为未完成。全局资料库选定目标研究后也有重开和继续的可达路径。模型失败与目录失败分别说明原因，不让轻问误报 CLI 配置错误。 | 慢响应停止、断网或429、刷新、切研究后迟到响应、全局资料库的回归；检查请求归属和输入恢复。依据：[停止与历史说明](https://support.google.com/notebooklm/answer/16179559?hl=en)、[任务状态参考](https://github.com/magnus919/agent-skills/blob/06ca706ecaa80f6afb31ae28eb160d39372b7267/product-design-and-ux/references/task-flows-and-state-models.md)；具体恢复策略为本项目要求。 |
| IR5：理解可留存，来源可核查 | 原文引用可返回正确论文和 PDF 页，保留原句；解释与推断不冒充作者结论。回答收为卡片先成为可编辑草稿，确认保存后关联原文和该次问答；重复确认不创建第二张卡。正文或来源缺失时明确提示，不能把卡片显示为已核查。只有确实检索过的外部资料才展示网页来源。 | 卡片的文档 ID、页索引、原句、请求 ID、上下文快照及刷新后回查；连点保存的幂等测试；正文编辑不改写原问答。依据：[Acrobat 引用定位](https://helpx.adobe.com/acrobat/desktop/use-acrobat-ai/generative-ai-features/ai-get-answers.html)、[保存笔记保留引用](https://support.google.com/notebooklm/answer/16179559?hl=en)。 |

## 使用限制

上述产品资料与第三方 skill 都是设计输入，不能证明本项目可用性或答案正确性。当前仍需用本产品的真实可点击路径、截图和错误回归验收；未运行的项目不能标记通过。真实模型、联网检索、系统级取消和磁盘恢复的结果应分别记录，模拟响应不能替代实机证据。
