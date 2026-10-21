# 多会话修复与验收

2026-10-21。按用户确认实施[会话层级复盘](../../review/session-model/README.md)中的修正，保留现有资料、卡片、白板、文稿和经典工作台。复盘已包含两轮真实 Claude Code 讨论；本次实施没有追加模型讨论，也没有更换研究运行时。

## 实际交互

- 中间默认显示当前会话的全部多轮提问、回答、执行与错误。长成果保存在原有文稿实体，通过消息中的入口打开，修订仍需审阅。
- 右侧“会话列表”显示本研究的多段会话、标题、预览、助手、活动时间和当前标记；可新建，一次点击切换。
- 底部唯一输入明确显示发送到哪个话题。新会话的输入、历史和局部目标为空；切回后恢复各自内容和滚动，刷新继续保留。
- 共享成果和来源可以浏览，浏览不切换发送会话。顶栏“返回会话”回到当前话题；“返回上一处”继续使用原资源返回栈。
- 切换会话、打开列表、从参考面板点“会话”都保持 Agent 工作台；原有 PDF／白板等经典 AI 动作继续明确交给经典工作台。
- 更换助手时，空话题可直接更换；已有内容则明确新开会话，保留旧话题，不跳到该供应商的另一段旧会话。

一轮提交绑定研究、会话和当时目标。A 的迟到结果归 A；B 的输入、局部目标、主区和历史不被替换。不同话题不互相附送消息；既有研究范围与截断预算继续有效，同一会话仅附送最近六轮内、总计不超过 12,000 字符的已完成研究历史。

## 数据与兼容

复用 `Conversation.requestIds`、`input` 和原有实体，增加会话级 `researchFocus`、`researchScrollTop`。旧研究级 `Session.agentFocus` 仅在原 `activeConversationId` 有效时迁移给该会话，已有新字段优先；原归属缺失时不猜测其他话题。迁移沿用本地备份和保存流程，schema 3 不变，旧字段不再运行时共享。

ZIP 备份与研究目录继续序列化同一份会话；新增目标校验包含资源存在和研究归属。导入的原生记录及使用经典上下文的会话可在新版阅读，继续发送需回经典，避免丢弃原生身份或旧材料。原生线程、服务端工具权限及各助手能力本轮未扩展。

## 实际检查

| 检查 | 本次结果 |
| --- | --- |
| `npm run build` | 通过，含 TypeScript 检查；仍有既有大包提示 |
| `npm test` | 29 文件、440 项通过 |
| `npm run test:server` | 211 项通过 |
| `npm run test:desktop` | 16 项协议／存储检查通过 |
| `npx playwright test tests/e2e/agent-workbench.spec.ts tests/e2e/workbench-sessions.spec.ts --reporter=line --output=test-results-session-fix` | 7 条通过，16.8 秒 |
| `git diff --check` | 通过 |

浏览器使用独立测试上下文、本地合成 PDF 和受控模型事件流，实际经过 PDF.js 提取、引用校验、保存与刷新。覆盖三尺寸 1440×900、1280×800、1024×800，输入／发送可用、无横向溢出，未记录页面 JavaScript 错误。回归包括完整多轮、多会话切换、原文和共享成果、旧功能可达、修订冲突、停止、跨研究与同研究不同会话的迟到响应。

开发过程曾因 Vite 热更新的模块地址导致测试读取另一份单例，测试现读取页面实际模块地址；重启本次开发服务后统一验收。并行 Playwright 曾冲突清理共用输出目录，最终单进程使用独立目录。第一次服务端回归与构建／浏览器并跑时有两条 20–25ms 计时用例失败，单独重跑后 211 项通过；没有改动这些测试或运行时来放宽断言。首次失败与最终日志分别记录，见 [checks.json](checks.json)。

关键画面均来自本次真实应用的受控测试数据，**不是实际论文研究成果或真实模型回答**：

- [主区完整当前会话＋右侧多会话列表](screenshots/multiple-sessions-1440.png)
- [刷新恢复输入、目标与滚动](screenshots/restored-session-1440.png)
- [共享成果＋已渲染原文：1440](screenshots/shared-source-1440.png)、[1280](screenshots/shared-source-1280.png)、[1024](screenshots/shared-source-1024.png)
- [A 完成后仍停留 B](screenshots/late-result-stays-b-1440.png)、[切回 A 查看对应成果](screenshots/late-result-owner-1440.png)
- [修订审阅](screenshots/regression/revision-review-1440.png)、[经典白板继续可达](screenshots/regression/legacy-board-1440.png)

本轮未重跑真实 Codex／Claude Code 调用，未打包或安装桌面应用；此前真实 Codex 研究闭环证据保留在[首版记录](../README.md)。完整混合画布、其他助手的研究工具和跨运行时无损续接仍未交付。
