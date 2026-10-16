# 本机 AI 助手验收

日期：2026-10-16。分支 `codex/issue-1-ai-agents`，起点 `origin/main` 的 `502f7f9`。关联 [issue #1](https://github.com/alovwang-sys/Read-paper/issues/1)；产品决策与需求 #2 B0 最小契约见 [助手设计](../../agents/design.md)。本轮交付可运行切片，issue #1 的完整三运行时验收仍未通过，保持开放。

## 实现与能力

按用户最新修正，使用桌面风格对话：用户消息靠右，完整 Markdown 回答靠左，工具过程折叠展示实际命令、状态、退出码及有界脱敏输出，底部固定输入。历史与累计范围设置默认收纳，摘要保留发送范围数量，800px 高度下为回答留出空间。没有嵌入厂商桌面窗口，不提供终端页签。未安装时给出官方运行组件安装入口，明确仅安装桌面应用不代表运行组件可用。

AI 回答引用、发送材料、草稿论文依据和相关对话引用均在中央 PDF 定位；右侧回答、未发送输入、草稿、滚动位置保留。1024px 起并排，低于 1024px 为抽屉。

最新增量：Codex 输入区接入真实技能/模型目录、`$` 技能选择、`/` 平台动作及 Chat/Plan；原生审批和结构化问题显示交互卡，等待答复后继续。每轮冻结技能与设置，重试保留原快照，停止/断连/刷新让旧交互失效。中央资源标签复用同一打开项状态，可关闭、固定、拖动与键盘排序，引用复用论文标签。

输入区唯一助手切换入口；每个研究内的对话绑定助手，分别保留历史、材料、未发送输入和卡片草稿。切换期间原任务保持归属，历史能查看运行中任务并返回停止。保留模型直连与明确的演示模式，不静默降级。

本机服务统一探测、编译显式材料、管理受控原生 session，输出正文与工具/权限事件。按工作区随机 ID、研究、会话和连接隔离映射；材料或历史范围缩小、仅当前材料、重试和重新生成开启新原生 session。卡片整理/修订使用独立任务，不把内部 JSON 整理混入聊天 session。知识写入仍由应用既有共享服务校验并幂等确认。

| 能力 | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 本机版本 | 0.162.1 | 2.1.281 | v2.0.18 |
| 原生接法 | App Server JSON-RPC stdio | 程序化 stream-json CLI | 原生 standalone JSON CLI |
| 本机状态 | 已认证、就绪 | 未认证，需用户登录 | 继承本机配置或 TUI 最近选择；认证与额度以实际请求确认 |
| 文字问答 | 真实通过 | 解析/协议模拟通过；真实未验证 | 协议模拟通过；继承模型启动通过；固定短句实测供应商限流/额度错误 |
| 工具 | OS 默认只读材料与所选技能目录；额外权限需用户答复 | 不开放，仅对话 | 不开放，仅对话 |
| 图片 | 不支持，UI 明示 | 不支持 | 不支持 |
| 原生恢复 | 真实通过 | 原生参数/ID模拟验证 | 原生参数/ID模拟验证 |
| 停止 | 真实工具中止通过，等待自管进程退出 | 自管子进程取消模拟通过 | 实际超时后未残留服务；取消模拟通过 |
| 权限/结构化输入 | 单次命令/完整文件变更及本回合权限审批；原生问题答复 | 拒绝，工具关闭 | 拒绝，工具关闭 |

本机进程不代表模型离线运行。认证由各运行时自己管理，应用不接收其登录密钥。详细 CLI 条件、官方协议依据、许可与 OpenCode 限流诊断见 [运行时记录](runtime-notes.md)。

## 已运行检查

- `npm run check`：通过。
- `npm test`：79 项通过，含新增技能/设置冻结、重试、卡片隔离、跨研究答复归属、停止/断流交互失效与返回关闭标签的回归。
- `npm run test:server`：65 项通过，含真实 RPC 形状、技能/模型校验、纯本地插件技能独立加载、Plan、单次/回合审批、完整命令/diff 边界、问题映射、原身份与重复回应、停止、多个待答复交互共同暂停超时。
- `npm run build`：通过；现有主包体积大于 500 kB 的提示保留，没有新增依赖。
- `npm run test:e2e -- --output=test-results-desktop`：最终全量 39/39 通过，含新增技能/模型/Plan 菜单、四技能上限、键盘操作、不支持命令不发送、问题草稿与答复归属、审批、中央标签管理及三尺寸布局；已有阅读、白板、写作、引用和恢复路径均通过。
- 独立代码审查：发现并修复历史打开 Codex 后 PDF 解释误读旧演示偏好、续接 done-only 漏存原生身份和累计材料；增加回归后无剩余阻断项。

以上检查均已在最新 Codex 交互与中央标签增量完成后执行。普通测试使用确定性响应与 fake process，不依赖真实凭据，不证明供应商真实可用。

## 真实验证

最新切片在实际浏览器新建空材料对话，选择本机 `ponytail:ponytail` 后由真实 `gpt-6.1-sol` 成功回答，保留技能芯片与发送快照，见 [真实 Skill 截图](live-codex-skill.jpg)。已通过原生 `skills/extraRoots/set` 验证：在分发插件工具仍关闭时，所选纯本地技能文件可独立加载；MCP/外部连接依赖仍不开放。

Plan 真实服务协议冒烟通过：原生 `request_user_input` 提出“按主题 / 按时间”，按主题答复后继续并完成两句计划，记录见 [真实 Plan 结果](live-codex-plan.json)。浏览器工具连接在另一次 Plan 界面实测前中断，该次没有发送；本项真实结果通过应用 HTTP broker 调用本机 Codex，界面提问/答复与审批另由流式 HTTP 模拟 E2E 验证。没有把模拟审批称为真实文件写入或联网授权通过。

最新桌面对话增量再次在真实浏览器提交自制材料，Codex 完成 `/bin/zsh -lc 'cat materials.md'`；真实 item ID 合并为一条工具记录，状态已完成、退出码 0、实际材料输出与回答分开可读，点击 [1] 后中央仍定位 PDF 第 3 页。

Codex App Server 在本机完成 initialize、account/read、thread/start、turn/start、agentMessage 流式消息、工具事件、thread/resume 和工具运行中停止。权限哨兵验证材料目录内读取成功、目录外自建测试文件读取失败、写入失败；均为 OS 拒绝。停止测试在工具执行中触发，28 ms 后 run 结束并等待自管进程退出。没有接管用户既有 Codex 任务。

实际浏览器以自制 PDF 第 3 页文字证据完成：加入 AI → 选择 Codex → 工具读取 `materials.md` → 两句话带 [1] 回答 → Codex 整理独立草稿 → 人工改标题并确认 → 查看 PDF 原文 → 刷新恢复已保存卡片和阅读页码。卡片保存题名“接入验收：检索提升事实准确性的适用条件”，仅为软件验证资料，不作为真实研究结果。

开发时真实 UI 首次暴露 `environments: []` 会关闭 Codex 执行工具的问题，移除该参数后重新建立原生 session，工具调用通过；没有将初次无工具结果冒充验收成功。

Claude 未登录，没有进行真实问答。历史诊断中，OpenCode 显式指定的智谱模型在原生层返回 `provider.rate-limit / 429`，未获得正文；该记录不能代表用户当前本机模型或本次模型继承修正后的调用结果。修正后真实探测已就绪，读取到 TUI 最近模型 `zhipuai-coding-plan/glm-5.3-flash#high`，无需 `OPENCODE_MODEL`。实际浏览器仅发送“连接验收”固定短句（0 条论文材料、0 轮历史），收到 10 条原生状态事件，最终返回供应商限流/额度错误，未获得回答；不标记问答或恢复通过。不登录、不自动重试到其他模型，不修改用户全局 CLI 设置。

## 截图

| 文件 | 证据类型与场景 |
| --- | --- |
| [codex-desktop-menu-1440.png](codex-desktop-menu-1440.png) / [1280](codex-desktop-menu-1280.png) / [1024](codex-desktop-menu-1024.png) | 新技能菜单、默认只读与逐次审批说明，中央 PDF 并列（模拟目录） |
| [codex-desktop-question-1440.png](codex-desktop-question-1440.png) / [1280](codex-desktop-question-1280.png) / [1024](codex-desktop-question-1024.png) | 原生问题交互卡和 PDF 对照（模拟流式事件） |
| [resource-tabs-1440.png](resource-tabs-1440.png) / [1280](resource-tabs-1280.png) / [1024](resource-tabs-1024.png) | 中央论文标签复用、分页与右侧回答保留 |
| [live-opencode-inherited-model.jpg](live-opencode-inherited-model.jpg) | 本机模型继承修复后就绪，固定短句真实调用的供应商限流/额度错误；没有冒充问答成功 |
| [live-desktop-codex-1440.jpg](live-desktop-codex-1440.jpg) | 最新真实 Codex 桌面对话、回答引用与中央 PDF，1440×900 |
| [live-desktop-codex-tools-1440.jpg](live-desktop-codex-tools-1440.jpg) | 真实工具命令、退出码与材料输出 |
| [desktop-chat-tools.png](desktop-chat-tools.png) | 工具卡成功/失败、输出和权限说明（模拟响应） |
| [desktop-chat-1440.png](desktop-chat-1440.png) / [1280](desktop-chat-1280.png) / [1024](desktop-chat-1024.png) | 确定性桌面对话、完整 Markdown 与引用同屏、刷新恢复 |
| [desktop-chat-install.png](desktop-chat-install.png) | 未安装时官方入口和仅复制命令，不自动安装（模拟状态） |
| [reference-main-1440.png](reference-main-1440.png) / [1280](reference-main-1280.png) / [1024](reference-main-1024.png) | 四处 AI 来源入口在中央打开，保留右侧回答、草稿及输入 |
| [live-assistant-picker-1440.jpg](live-assistant-picker-1440.jpg) | 真实本机安装/登录状态，1440×900，主区 PDF＋助手菜单（首次接入记录） |
| [live-codex-tool-and-citation.jpg](live-codex-tool-and-citation.jpg) | 真实工具事件、回答与有效引用，1440×900（首次接入记录） |
| [live-codex-saved-card.jpg](live-codex-saved-card.jpg) | 真实卡片确认及刷新恢复，1440×900，双来源保留 |
| [assistant-picker-1440.png](assistant-picker-1440.png) | 确定性状态样例，1440×900，结论＋AI |
| [assistant-picker-1280.png](assistant-picker-1280.png) | 确定性状态样例，1280×800 |
| [assistant-picker-1024.png](assistant-picker-1024.png) | 确定性状态样例，1024×800，导航折叠、原文与右侧并排 |
| [native-materials.png](native-materials.png) | 本轮文字材料，主区 PDF＋AI |
| [native-context-scope.png](native-context-scope.png) | 本轮与累计范围、历史说明（模拟响应） |
| [permission-denied.png](permission-denied.png) | 权限拒绝与保留内容（模拟错误） |

已逐张打开检查。原回归同步刷新了 AI 相关旧截图；随机 ID 的 Markdown 下载样例未作为本次差异提交。

## 运行与存储

执行 `npm run dev`、`npm run ai` 后访问 http://127.0.0.1:5173 。Codex 使用 PATH 中的 `codex`；Claude/OpenCode 支持 `CLAUDE_BIN`、`OPENCODE_BIN` 显式可执行路径。OpenCode 默认继承本机配置的模型或 TUI 最近选择，并显式传给 `run`；`OPENCODE_MODEL=供应商/模型` 仅用于可选覆盖，无需重复填写已有选择。通过独立的原生 `api --standalone GET /api/config` 读取连接配置（私有内容只留服务内存），不使用会脱敏 key/header 的 `debug config` 重建连接。只继承模型与 provider 连接配置，不继承工具、MCP 或 agents 设置；认证不以 `auth list` 的标签匹配硬阻断，环境凭据、本地及自定义 provider 的可用性以实际请求确认。修改环境后重启本机服务并重新检测。

默认映射、当前材料快照与请求归档存于系统临时目录 `read-paper-agents-<uid>`（仅当前用户可读）。需要跨系统清理保留时，通过 `AI_AGENT_STATE_DIR` 指定私有持久目录。这些快照包含已明确发送的材料/问答，应与研究资料同样保管；不是完整知识备份。默认临时目录被清理后会建立新原生 session，不会声称恢复了旧 session。原生运行时另外保留自己的历史。

本机接口仅监听127.0.0.1，校验Host/Origin/JSON、长度和并发；固定可执行参数且不启动shell拼接问题。仅终止本服务启动的进程组。取消等原生进程退出后才释放session锁。未知原生ID、跨项目session复用和重复request均受校验。

## 未完成范围

Claude 真实登录后的问答/恢复、OpenCode 模型继承修正后的问答/恢复、两者受控只读工具能力及原生授权交互仍待后续验收。因此不关闭 issue #1，也不声称 A3 已整体完成。图像助手、任意旧桌面任务接管、自动跨项目检索、项目长期记忆、跨设备同步与多 agent 自主协作未在本轮实现。当前真实 OS 权限测试仅覆盖 macOS；其他系统遇到不支持的权限配置会明确禁用连接，未作平台可用性承诺。
