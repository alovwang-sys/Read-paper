# 独立审查：真实软件集成中的简要、取消与原生 Agent 路径

**结论：有阻断项。** 共 4 条，其中 P1 两条（第 2 条需对照 `liveResponder` 和服务端代码确认），P2 两条。

以下判断只依据本次附上的 `paper-brief.ts`、`reader-actions.ts`、`reader-context.ts` 和 `ai.ts` 片段。我没有运行单测或浏览器流程，也没有看到 `liveResponder`、服务端 `/api/ai/agents/*`、`loadPdfDocument`、`snapshotContext`、工作区加载与保存的实现。凡是依赖这些未见代码的地方，都标了"需核实"。

---

## P1-1　简要记录会写出自己的校验通不过的数据，下次打开工作区可能被拒

**代码位置**
- `preparePaperBrief`：初始记录写的是 `totalPages: doc.pageCount ?? 0`，随后同步写入 `status: 'preparing'`。
- 出错时，`catch` 把 `{...record, status:'error', error: problem.message}` 落盘。
- `validatePaperBrief` 无条件要求 `totalPages > 0`、`error.length <= 4000`。
- `validateReaderContext` 先跑 `validatePaperBrief`，再做 `recover` 时的 preparing→error 转换，而且对 `doc.paperBrief.documentHash === doc.hash` 直接 `check` 抛错。

**触发路径**（`pageCount` 是可选字段，从 `?? 0` 可推断）
1. 某篇论文的 `pageCount` 尚未写入，首问触发简要。
2. 进入 `preparing` 后，周期性的 `retrySave` 已把 `totalPages: 0` 存盘。此后应用崩溃或被强退，或者 `loadPdfDocument` 抛错、走进 catch 写成 error。
3. 重启后，`validatePaperBrief` 在 `recover` 生效之前就抛出"文章简要记录损坏"。
4. 类似情况还有两种：
   - 上游错误信息超过 4000 字符；
   - 论文被替换后 `doc.hash` 变了，但旧的 ready 简要还挂在 `doc` 上。这一点需核实"替换 PDF"路径是否会清掉 `paperBrief`。

**最小修复**
- `totalPages` 取 `Math.max(1, doc.pageCount ?? 1)`。或者让校验只对 ready 记录要求大于 0，preparing 和 error 允许为 0。
- 写入 error 时截断：`message.slice(0, 2000)`。
- `validateReaderContext` 对 `doc.paperBrief` 改为"不合法或 hash 不匹配就删除"，而不是 `throw`。简要只是可重建的缓存，不应拖垮整个工作区的加载。`request.paperBrief` 和 `conversation.paperBrief` 校验失败时，同样剥离这个字段，而不是拒绝加载。
- 建议补一个单测：`pageCount` 为 undefined，在 preparing 状态下序列化，再走 load 和 recover。

---

## P1-2（需核实 liveResponder）　原生 Agent 用 `purpose:'card'` 跑后台简要：绑在用户会话上，取消时不通知服务端

**代码位置**
- `preparePaperBrief` 直接调用 `responder(briefRequest)`，绕开了 `runRequest`。
- `briefRequest.conversationId = request.conversationId`，`connectionId` 直接沿用提问时的值（`codex`、`claude`、`opencode` 都可能出现）。
- 中止时只调用 `controller.abort()`。`stopAI` 发往 `/api/ai/agents/stop` 的是聊天请求的 id，没有任何地方用简要请求的 id 发送 stop。

**风险**
- `briefRequest` 从未写入 `data.requests`，也不在 `running` 里。如果 `liveResponder` 的原生分支按 `requestId` 回写 `nativeRun` 或 `interactions`，或者按 `conversationId` 解析、续用原生 session，会出现两种后果：
  - 写入落空或报错；
  - 简要回合连同那 5 万字提取正文进入该会话的原生历史。这违背了"不继承别处 native 绑定"的要求。
- 超时（120s）、`stopPaperBriefs`、退出时的中止都只断开前端 fetch。服务端的 Codex/Claude 进程可能还在跑。如果服务端对同一 `conversationId` 只允许一个活动回合，紧接着发出的真实问题会被判为"会话忙"。
- 需核实：原生 Agent 在 `purpose:'card'` 时是否会把 JSON 解析成 `response.result`。如果不会，`result?.body` 恒为空，原生连接下每次都会得到"简要格式不正确"。

**复现**
1. 局部会话连接选 Claude 或Codex，首问进入 preparing。
2. 在简要阶段点停止，或者等它超时，然后立刻再问。
3. 观察服务端是否报会话忙，以及原生会话记录里是否出现简要 prompt。

**最小修复**（二选一）
- (a) 原生连接不承担简要：简要固定走无状态的 model 连接；没有可用的 model 连接时直接降级为 `selection-only`。
- (b) 保留原生连接，但要满足三点：
  - 使用独立的合成 `conversationId`（如 `paper-brief:${documentId}`），并显式声明不续用 session；
  - `controller` 中止时，用 brief 的 `requestId` 和这个合成 `conversationId` 发送 `/api/ai/agents/stop`；
  - 让 `stopAllAI` 等待服务端确认。

---

## P2-3　简要失败会让用户的问题本身失败；无文字 PDF 每次提问都重新整篇提取，然后再失败

**代码位置**
- `attachPaperBrief` 的 `catch` 先把状态记为 `paperBriefState='error'`，然后 `throw problem`。`runRequest` 因此把整个问题标成 `error`。
- `preparePaperBrief` 只在 ready 时命中缓存，error 记录不会阻止下一次重跑。
- 简要附加之后的 `assertRequestBudget(request)` 如果超限，同样会让问题失败。

**触发路径**
1. 打开一篇扫描版 PDF，在局部会话里提问。
2. 简要以"未提取到可核对文字"失败，问题随之变成 error。
3. 再问一次，又整篇 `loadPdfDocument` 加 24 页 `getTextContent`，再次失败。
4. 除非用户每次都手动选"仅按选区"。

另外，校验层允许请求持久化为 `paperBriefState: 'error'`，说明"带着 error 状态继续回答"本来就是设计中合法的状态。

**最小修复**
- `attachPaperBrief` 的 catch 改为：`signal.aborted` 时照旧抛出；其他情况下记 `paperBriefState='error'`、不附简要，然后 return，让问题按选区继续发送。
- 对同一 key 的确定性失败（`pageIndices` 为空的 error）直接快速拒绝，或者直接走 selection-only，不再重新提取。
- 附加简要后如果预算超限，就移除简要材料并标记 `selection-only`，而不是抛错。

---

## P2-4　退出时先中止简要，正在等待简要的提问被记为 error 而不是 stopped

**代码位置**
- `stopAllAI` 先 `await stopPaperBriefs()`，之后才对 `running` 里的请求调用 `stopAI`。
- 等待简要的聊天请求因此先收到共享 flight 的 AbortError。此时它自己的 `controller` 尚未 abort，`runRequest` 的 catch 走 `controller.signal.aborted ? 'stopped' : 'error'`，结果落为 `error`，错误文本是一条技术性的 AbortError 消息。

**影响**
- 关闭时的操作记录里会多出几条"失败"，内容是正常退出造成的。
- 如果关闭因为原生回合未确认而被撤销，用户回来会看到误导性的错误状态。

**最小修复**
- 调换顺序：先对 `running` 里的请求 `stopAI`，再 `stopPaperBriefs`。
- 或者在 catch 中把 `stoppingAll` 或 AbortError 视为 `stopped`。

---

## 已核对、未发现问题的部分

- **共享与取消**：停止一处不会取消共享简要。`cancelled` 只拒绝本请求自己的等待，flight 的 controller 不受影响。
- **迟到写入**：回写前检查 `stored.status === 'generating'`；flight 用 `unchanged()` 校验 generation 和 hash，迟到结果写不进去。
- **singleflight**：以 generation + key 去重，多个会话共享同一份简要，但不共享各自的历史。
- **范围限制**：24 页 / 50000 字符 / 每页 6000 字符的限制与覆盖声明一致，跳过的空白页不会被声明为已覆盖。
- **普通原生会话**：`managed` 判断排除了 `inlineSource`，普通原生会话仍走原有实现；inline 会话走显式历史。
- **活动状态**：只由 `requests` 和 `cardDrafts` 派生，没有另存状态。翻译和选区摘要在 `submitAI` 中被强制设为 `selection-only`，不会生成简要。