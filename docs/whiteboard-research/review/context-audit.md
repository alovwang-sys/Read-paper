# 白板研究方案的第二轮核实

日期：2026 年 10 月 20 日。范围：实施前的外部官方资料、项目代码、原型状态及 Claude Code 两轮实际审阅与讨论。首次未登录的尝试单独保留。用户随后确认继续，正式实现和当前实际边界见[实施验收](../verification/implementation/README.md)；下列缺口保留作当时的审计基线，不代表仍未实施。

## 结论

采用现有统一工作台和紧凑 AI 输入区，加入新版的节点提问、候选文献及原位收录。第一版原型证明了主路径可以点击，但上下文、历史和探索归属尚不完整；不能直接以第一版原型进入完整功能开发。第二版规则集中到[上下文设计](../context-design.md)，以核对材料、连续问题身份和冻结快照补齐缺口。

“全部白板正文默认发送”不采用；“永远只有当前单卡”也不足以支持研究连续性。采用小份明确背景与选中材料，加上用户允许的集合内按需查找；独立说明本机助手的目录访问能力。

## 官方资料核实

| 来源 | 确认的事实 | 本项目的取舍 |
| --- | --- | --- |
| [Heptabase 内容访问说明](https://support.heptabase.com/en/articles/13009956-what-space-content-can-the-ai-agent-access) | 当前页信息、附件、历史和按需读取可能进入回答；关闭 Space search 不保证只能读取附件，也不是严格权限隔离 | 分开显示附送材料、查找范围和原生目录权限；不照搬默认全空间搜索 |
| [Miro Sidekicks](https://help.miro.com/hc/en-us/articles/30139627329042-Sidekicks)、[统一 Sidekick](https://help.miro.com/hc/en-us/articles/33881743175954-Sidekicks-evolve-AI-creation-in-Miro) | 可在提问前选择白板对象，连续工作和回看聊天；格式切换可保留上下文 | 一个探索会话承载问题、论文和输出变化。官方资料未明确 frame 子项、空间关系及历史收缩的序列化，不能声称可直接复制其机制 |
| [Google 聊天帮助](https://support.google.com/gemininotebook/answer/16179559?hl=en)、[发现新来源](https://support.google.com/gemininotebook/answer/16215270?co=GENIE.Platform%3DDesktop&hl=en-AU) | 可选择来源、回查引用、保留聊天，搜索候选由用户选择导入；当前页面还介绍实验性 agentic 功能 | 分开处理依据问答和外部发现；不宣称该产品所有模式都只用上传资料。所查页面名称为 Gemini Notebook，不推断所有客户端名称已同步 |
| [Elicit Research Agent](https://support.elicit.com/en/articles/14756886-elicit-s-research-agent)、[Session History](https://support.elicit.com/en/articles/14757548-session-history) | 可限定或扩大 collection 范围、区分已存与新发现资料、持续追问和返回会话 | 区分“优先使用本研究”与“仅使用当前材料”；保存论文和对话范围分别管理 |
| [Anthropic 上下文工程](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 建议使用高信息密度的必要内容、引用索引和按需读取；长任务可使用压缩与结构化笔记，并强调压缩丢失信息的风险 | 不默认发送所有资料；首版先做清单、范围和超限控制，自动摘要在验证后引入 |

公开文档没有提供可直接照搬的最佳 token 数，也没有证明取消来源勾选后旧回答中的相关信息会从下一轮消失。产品存储上限、上传文件数量与模型输入窗口分别处理。以上为文档核实，未登录竞品做实时交互测试。

## 项目代码与原型核查

| 缺口 | 代码或已有设计证据 | 修正 |
| --- | --- | --- |
| 单卡提示容易被理解为硬隔离 | `server/agents.mjs:316`、`server/codex-runtime.mjs:559` 使用研究目录；`project-files.ts` 导出本研究中的其他资料和会话；Claude/OpenCode 工具限制不同 | 按适配器说明目录访问，材料面板只声明附送内容 |
| 卡片、摘要、历史缺少总量控制 | `src/services/ai.ts:54` 和 `server/ai.mjs:282` 限额分散，白板快照另有上限 | 在最终请求统一计量，保留现有保护阈值但不冒称 token 容量 |
| 取消材料不等于排除历史 | `historyForConversation` 与 `snapshotContext` 可重新携带历史引用证据 | 区分停止附送和干净分支，分支排除旧助手正文并预览原问题中的转述 |
| 问题切到论文后丢失原问题 | 第一版 `useSelected()` 按节点切 thread | Conversation 保留稳定的原问题，论文只切焦点 |
| 搜索批次未冻结问题与查询 | 第一版 `search()` 只有 requestNumber，放置取操作时的 context | 结果、摆放和返回取搜索批次的原问题快照 |
| 只保存最后一问一答 | 第一版 threads 保存单个 asked/answer | 消息数组、选择历史和每轮发送快照 |
| 卡片编号可能冒充当前原文引用 | 旧卡正文编号与 `citedResult` 的本轮编号规则不相同 | 类型化来源与编号映射，未选原文不取得引用资格 |

该轮由只读代码调查与产品资料调查分别完成，主 agent 集成并核对边界。检查的是当前代码和设计，不将其视为真实模型通过。

## Claude Code 审阅与讨论

本机发现 Claude Code 2.1.281。所有咨询均使用非交互、禁止工具、禁用自定义插件／hooks、不持久化会话的方式，未允许修改工作区。最初调用在认证阶段失败；用户完成登录后才取得下面两轮真实模型回复。

首次返回 `is_error: true`，结果为 `Not logged in · Please run /login`；认证状态为未登录，未返回模型内容。用户明确告知已可讨论后，重新确认登录，随后两轮调用均退出 0、`is_error: false`。首轮模型标识为 `claude-sonnet-5-5`，第二轮为 `claude-opus-5-5`；均沿用 CLI 当时的默认配置，未手动指定模型。两轮输入带完整前序意见和集成方追问，原文保存在 [Claude Code 审阅](claude-code-review.md)。先前未登录状态保留为历史，不再作为当前阻塞。

可审阅的调用状态见 [claude-code-status.json](claude-code-status.json)。模型只审阅提供的设计和代码节选，没有直接核对全仓、竞品实时页面或运行测试，不能写成“Claude 审核通过”或“真实服务通过”。

首轮意见推动了六项具体修正：阻止历史重新附送已取消的原文；将背景、卡片、摘要、原文和历史分别建类型；写清移除／选择历史／分支语义；区分应用新分支与运行层权限；限制默认历史并支持逐轮选择；切焦点替换自动材料，显式加入才持续保留。第二轮进一步提出原生续接会绕过历史勾选、派生卡回流，以及旧引用编号冒充新原文三项问题，均写入设计与 BR0 门槛。

经讨论采用“上一完成轮＋最近原问题焦点轮”的初始历史规则，去重后通常 1–2 轮，避免只带上一轮导致从论文回原问题时丢掉此前结论。两个紧凑入口共享一份请求清单，无需立即把界面改成一个大材料篮。该规则还须与仅上一轮、全部历史做真实六轮对照；Claude 明确建议只进入 BR0 设计与探针，不视为已经通过。生产 PDF-only 类型、引用与原生运行约束仍待实施。

## 新旧方案的采用关系

旧阅读方案保留材料与历史核对、证据来源、草稿确认和单面板返回；最新已实现输入区保留紧凑工具行。新版采用节点附近入口、用户主动补问题、候选文献及原位关联。新版常驻大标题改为只在空态显示的引导，让出画布空间。

第二版原型用于检验这些交互，不新增真实模型、学术搜索、PDF 导入或持久化。第一版保留为 [prototype-v1.html](../prototype-v1.html)，旧截图继续保留；第二版证据使用独立目录，避免覆盖先前验证记录。
