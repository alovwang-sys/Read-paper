# 本机 AI 助手验收

日期：2026-10-16。分支 `codex/issue-1-ai-agents`，起点 `origin/main` 的 `502f7f9`。关联 [issue #1](https://github.com/alovwang-sys/Read-paper/issues/1)；产品决策与需求 #2 B0 最小契约见 [助手设计](../../agents/design.md)。本轮交付可运行切片，issue #1 的完整三运行时验收仍未通过，保持开放。

## 实现与能力

输入区唯一助手切换入口；每个研究内的对话绑定助手，分别保留历史、材料、未发送输入和卡片草稿。切换期间原任务保持归属，历史能查看运行中任务并返回停止。保留模型直连与明确的演示模式，不静默降级。

本机服务统一探测、编译显式材料、管理受控原生 session，输出正文与工具/权限事件。按工作区随机 ID、研究、会话和连接隔离映射；材料或历史范围缩小、仅当前材料、重试和重新生成开启新原生 session。卡片整理/修订使用独立任务，不把内部 JSON 整理混入聊天 session。知识写入仍由应用既有共享服务校验并幂等确认。

| 能力 | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 本机版本 | 0.162.1 | 2.1.281 | v2.0.18 |
| 原生接法 | App Server JSON-RPC stdio | 程序化 stream-json CLI | 原生 standalone JSON CLI |
| 本机状态 | 已认证、就绪 | 未认证，需用户登录 | 默认需显式配置模型；指定智谱模型实测上游 429 |
| 文字问答 | 真实通过 | 解析/协议模拟通过；真实未验证 | 解析/协议模拟通过；真实未通过 |
| 工具 | OS 限定只读材料目录、禁写入与工具联网 | 不开放，仅对话 | 不开放，仅对话 |
| 图片 | 不支持，UI 明示 | 不支持 | 不支持 |
| 原生恢复 | 真实通过 | 原生参数/ID模拟验证 | 原生参数/ID模拟验证 |
| 停止 | 真实工具中止通过，等待自管进程退出 | 自管子进程取消模拟通过 | 实际超时后未残留服务；取消模拟通过 |
| 权限/结构化输入 | 显式拒绝并展示原因，不提供提升权限入口 | 拒绝，工具关闭 | 拒绝，工具关闭 |

本机进程不代表模型离线运行。认证由各运行时自己管理，应用不接收其登录密钥。详细 CLI 条件、官方协议依据、许可与 OpenCode 限流诊断见 [运行时记录](runtime-notes.md)。

## 已运行检查

- `npm run check`：通过。
- `npm test`：74 项通过，覆盖新增助手切换、输入保留、迟到响应隔离、草稿来源及幂等、无效引用、停止、重试身份、done-only 续接和旧数据恢复。
- `npm run test:server`：37 项通过，覆盖模型服务、本机 session 管理与 CLI 协议。
- `npm run build`：通过；现有主包体积大于 500 kB 的提示保留，没有新增依赖。
- `npm run test:e2e`：全量重跑 20/21 通过；一条旧测试依赖 HMR 前的模块单例，已改为真实页面操作配合确定性 HTTP 响应，随后 `npx playwright test tests/e2e/persistence.spec.ts -g '文本提取失败'` 单项通过。21 条路径均有通过记录，覆盖新增助手场景及原阅读、卡片、白板、结论、刷新、研究隔离、保存失败恢复。
- 独立代码审查：发现并修复历史打开 Codex 后 PDF 解释误读旧演示偏好、续接 done-only 漏存原生身份和累计材料；增加回归后无剩余阻断项。

普通测试使用确定性响应与 fake process，不依赖真实凭据，不证明供应商真实可用。

## 真实验证

Codex App Server 在本机完成 initialize、account/read、thread/start、turn/start、agentMessage 流式消息、工具事件、thread/resume 和工具运行中停止。权限哨兵验证材料目录内读取成功、目录外自建测试文件读取失败、写入失败；均为 OS 拒绝。停止测试在工具执行中触发，28 ms 后 run 结束并等待自管进程退出。没有接管用户既有 Codex 任务。

实际浏览器以自制 PDF 第 3 页文字证据完成：加入 AI → 选择 Codex → 工具读取 `materials.md` → 两句话带 [1] 回答 → Codex 整理独立草稿 → 人工改标题并确认 → 查看 PDF 原文 → 刷新恢复已保存卡片和阅读页码。卡片保存题名“接入验收：检索提升事实准确性的适用条件”，仅为软件验证资料，不作为真实研究结果。

开发时真实 UI 首次暴露 `environments: []` 会关闭 Codex 执行工具的问题，移除该参数后重新建立原生 session，工具调用通过；没有将初次无工具结果冒充验收成功。

Claude 未登录，没有进行真实问答。OpenCode 显式智谱模型在原生层返回 `provider.rate-limit / 429`，未获得正文，不能标记其问答或恢复通过。不登录、不自动重试到其他模型，不修改用户全局 CLI 设置。

## 截图

| 文件 | 证据类型与场景 |
| --- | --- |
| [live-assistant-picker-1440.jpg](live-assistant-picker-1440.jpg) | 真实本机安装/登录状态，1440×900，主区 PDF＋助手菜单 |
| [live-codex-tool-and-citation.jpg](live-codex-tool-and-citation.jpg) | 真实工具事件、回答与有效引用，1440×900 |
| [live-codex-saved-card.jpg](live-codex-saved-card.jpg) | 真实卡片确认及刷新恢复，1440×900，双来源保留 |
| [assistant-picker-1440.png](assistant-picker-1440.png) | 确定性状态样例，1440×900，结论＋AI |
| [assistant-picker-1280.png](assistant-picker-1280.png) | 确定性状态样例，1280×800 |
| [assistant-picker-1024.png](assistant-picker-1024.png) | 确定性状态样例，1024×800，右侧抽屉 |
| [native-materials.png](native-materials.png) | 本轮文字材料，主区 PDF＋AI |
| [native-context-scope.png](native-context-scope.png) | 本轮与累计范围、历史说明（模拟响应） |
| [permission-denied.png](permission-denied.png) | 权限拒绝与保留内容（模拟错误） |

已逐张打开检查。原回归刷新了 `docs/verification/screenshots/` 中4张AI相关旧截图；随机ID的Markdown下载样例未作为本次差异提交。

## 运行与存储

执行 `npm run dev`、`npm run ai` 后访问 http://127.0.0.1:5173 。Codex 使用 PATH 中的 `codex`；Claude/OpenCode 支持 `CLAUDE_BIN`、`OPENCODE_BIN` 显式可执行路径。OpenCode 需要在本机服务环境明确设置 `OPENCODE_MODEL=供应商/模型`，例如 `zhipuai-coding-plan/glm-5.3-flash`；这只选择模型，不承诺额度或连接成功。修改环境后重启本机服务并重新检测。

默认映射、当前材料快照与请求归档存于系统临时目录 `read-paper-agents-<uid>`（仅当前用户可读）。需要跨系统清理保留时，通过 `AI_AGENT_STATE_DIR` 指定私有持久目录。这些快照包含已明确发送的材料/问答，应与研究资料同样保管；不是完整知识备份。默认临时目录被清理后会建立新原生 session，不会声称恢复了旧 session。原生运行时另外保留自己的历史。

本机接口仅监听127.0.0.1，校验Host/Origin/JSON、长度和并发；固定可执行参数且不启动shell拼接问题。仅终止本服务启动的进程组。取消等原生进程退出后才释放session锁。未知原生ID、跨项目session复用和重复request均受校验。

## 未完成范围

Claude 真实登录后的问答/恢复、OpenCode 限流解除后的问答/恢复、两者受控只读工具能力及原生授权交互仍待后续验收。因此不关闭 issue #1，也不声称 A3 已整体完成。图像助手、任意旧桌面任务接管、自动跨项目检索、项目长期记忆、跨设备同步与多 agent 自主协作未在本轮实现。当前真实 OS 权限测试仅覆盖 macOS；其他系统遇到不支持的权限配置会明确禁用连接，未作平台可用性承诺。
