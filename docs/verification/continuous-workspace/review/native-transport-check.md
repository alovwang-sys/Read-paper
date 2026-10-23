# Claude P1-2：简要的原生请求隔离与取消核实

2026-10-23。对 [第一轮审查](round-01-response.md) 的 P1-2 逐层核对。本次只读检查业务实现，运行现有受控测试；没有更改公共代码，也没有调用真实模型。

## 结论

P1-2 所述“后台简要污染原生聊天”“原生连接不能返回 `response.result`”“中止只断开前端而不取消服务端”在当前实现下均不成立，不应据此阻断交付。简要沿用应用会话 ID，但 `purpose: card` 与每次独立的 request ID 已在服务端形成独立运行身份。没有必要为此新增合成 Conversation 或强制切换用户的模型供应商。

## 实际调用链

| 检查点 | 实现证据 | 结果 |
| --- | --- | --- |
| 真实 responder 分支 | `src/services/ai.ts` 的 `liveResponder` 对 Codex / Claude / OpenCode 进入 `agentResponder`；仅直接模型走 `/api/ai/chat` | 简要可以使用当前真实连接 |
| 请求是否续用原生聊天 | `agentResponder` 只在 `purpose === chat` 时发送 `sessionRef`、Skills、Plan 与访问配置；非 chat 仅可带 Codex 型号；当前 inline 简要还会发送 `reset: true` | 不继承聊天的原生线程或权限 |
| 服务端运行身份 | `server/agents.mjs` 的 `sessionKey` 对非 chat 请求额外加入 `purpose` 与 `requestId` | 同一应用会话的简要与聊天不共用 busy key |
| 原生会话恢复与保存 | 服务端仅对 chat 调用 `loadMapping` / `projects.resume`；非 chat 的 `persist` 直接返回，不保存聊天映射 | 简要不会覆盖或污染用户聊天 session 绑定 |
| 执行目录 | 非 chat 的 `cwd` 为本轮 `materialCwd`，而不是用户研究项目根目录 | 原生简要是独立材料任务 |
| 临时请求未进入 requests | 客户端 session / progress / interaction 回写均先检查 `data.requests[id]` 存在且仍在 generating；未找到直接跳过 | 不会因临时请求回写报错；也不会创建聊天轮次 |
| JSON 结果 | `agentResponder` 收到完整回答后，对非 chat 调用 `cardResult(body, context)`，返回 `{ body, rawBody, evidenceIds, result, model }` | `response.result.body` 可用；不合法 JSON 仍会明确失败 |
| 断连传播 | 非 managed `/api/ai/agents/run` 的 `req.aborted` / `res.close` / `res.error` 调用 `controller.abort()`，该 signal 交给 runtime | abort 不仅停止前端读取 |
| 底层运行停止 | Claude 的进程组发送 SIGTERM，超时后 SIGKILL；Codex 走 turn interrupt 与失败关闭；服务端 finally 等待 `runCompletion` 再释放 active / busy | 底层停止与占用释放有现成实现 |

相关源文件：[ai.ts](../../../../src/services/ai.ts)、[agents.mjs](../../../../server/agents.mjs)、[claude-runtime.mjs](../../../../server/claude-runtime.mjs)、[codex-runtime.mjs](../../../../server/codex-runtime.mjs)。

## 本次实际执行的验证

运行：

```text
node --test --test-name-pattern='card/revision requests|image card model|timeout and browser disconnection' server/agents.test.mjs
```

结果：**3 项通过、0 失败**，总耗时约 1.12 秒。

1. `card/revision requests use separate native sessions and preserve the chat session`：先运行聊天，再运行 card / revision，二者不带旧 nativeSessionId；之后聊天仍续原 session，card prompt 保留 JSON 约束。
2. `image card model is retained without inheriting skills, planning or write access`：非 chat 只保留选定型号，不继承技能、交互、Plan、写权限；无效授权请求在 runtime 前被拒。
3. `timeout and browser disconnection cancel the underlying runtime`：分别验证超时与 fetch abort 导致服务端底层 signal 中止。

这些是实际 HTTP 通道与受控 runtime 测试，没有消费模型额度，不代表三家真实 CLI 的模型输出质量已验收。当前简要单元测试使用可控 responder，并不单独覆盖 `preparePaperBrief → liveResponder → agentResponder → HTTP` 的完整连接链。

## 剩余 ACK 边界

`stopPaperBriefs()` 等待前端共享任务的 promise；`withAbort` 在 abort 时会立即拒绝等待。它不等待服务端返回“底层已经终止”的独立 ACK。服务端自身仍会等 runtime 收尾后释放占用，所以短暂可能占用既有的“两条 Agent 请求”全局配额；该边界不是同一聊天 session 被锁住，也不是原生历史污染。

停止某一处问题不取消其他位置共用的简要任务，是当前设计的明确行为。退出时 `stopPaperBriefs` 才取消全部共享任务。若后续要承诺退出 UI 已确认每个后台任务停止，需要增加 brief 请求身份的停止确认或服务端状态查询，而不应仅靠前端 promise 已结束推断。

最小后续验证是补一条受控完整链路：让 brief 返回规范 JSON，检查 card payload 无 sessionRef / managed / Skills；保持任务未完成后 abort，再确认 runtime 已收到信号、旧聊天可继续。当前已有隔离与断连测试足以反驳本次 P1-2 的假设，没有必要为此先做付费真实 CLI 调用。
