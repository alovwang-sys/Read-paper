# 第二轮复核结论（仅基于本次提供的源码片段）

**结论：本轮片段中没有确认的阻断问题。** 有 1 项条件性问题，是否阻断取决于未提供的 `demoResponder` 实现。其余项目列入"未能核实"。以下判断都来自代码阅读，没有运行测试，也没有查看 UI。

---

## 一、已解决

1. **未知 pageCount 与长 error**
   - `totalPages: doc.pageCount ?? 0` 只出现在 `preparing` 和 `error` 状态。校验器只对 `ready` 和 snapshot 要求 `totalPages >= 1`，两者一致。
   - error 截到 4000 字，与 `text(value.error, 4000)` 对应。

2. **恢复策略**
   - `recover` 模式下，坏的 document 缓存会被 `delete doc.paperBrief`。
   - 残留的 `preparing` 状态转为 `error`。
   - conversation 和 request 上冻结的快照仍严格校验并抛错，符合"仅剥离可重建缓存"的口径。

3. **PDF 等待可取消**
   - `loadPdfDocument`、`getPage`、`getTextContent` 和 responder 都包在 `withAbort` 中。
   - 原始 promise 已挂上 `then(resolve, reject)`，没有未处理拒绝。
   - 120 秒超时会走同一个 controller。

4. **目录与连接范围冻结**
   - brief 侧在 PDF 加载后、模型调用前、落库前各调用一次 `verifyOwner()`。
   - 问题侧在 `attachPaperBrief` 之后执行 generation 检查和 `verifyDirectoryScope()`，然后才调用 responder。

5. **brief 材料组装时机**
   - `runRequest` 在 responder 之前重组 `paper-brief:` 材料，并重新执行 `assertRequestBudget`。
   - retry 继承旧快照时，在请求入口也会重组一次。

6. **退出顺序**
   - `stopAllAI` 先停 `running` 中的问题，再执行 `stopPaperBriefs()`。
   - 之后等待 `running`、`pendingConversations`、`preparingRequests` 清空。
   - 新问题在最后一次 `stoppingAll` 检查到 `preparePaperBrief` 注册 flight 之间全是同步代码，不存在漏停的窗口。

7. **服务端隔离（与前轮一致，不重复展开）**
   - `sessionKey` 对非 chat 请求包含 `purpose` 和 `requestId`。
   - `loadMapping` 只用于 chat；`persist` 对非 chat 只写局部变量。

8. **简要失败的交互**
   - 失败和停止记录都会保留。
   - `skipPaperBrief` 显式跳过后标记为 `selection-only`。
   - 重试时若旧状态是 `error`，会重新尝试 brief；若是 `selection-only`，保持仅按选区。

---

## 二、仍需修复（条件性）

### 演示模式生成的简要可能被真实模型请求复用

- **依据**
  - `runRequest` 在 `connectionId === 'demo'` 或 retry/regenerate 指定 `mode: 'demo'` 时会改用 `demoResponder`，并原样传给 `attachPaperBrief` → `preparePaperBrief`。
  - 缓存键 `paperBriefKey(documentId, hash)` 和复用条件 `doc.paperBrief.key === key && status === 'ready'` 都不区分 demo 和 live。
  - 当 `connectionId` 为 `'model'` 而模式是 demo 时，`record.connectionId` 仍记为 `'model'`，从记录本身无法分辨。

- **触发条件**
  1. `demoResponder` 对 `purpose: 'card'` 返回非空 `result.body`，且 `evidenceIds` 为空。
  2. 在演示模式下对某篇论文做局部提问。
  3. 之后用真实连接对同一篇论文提问。
  4. 演示内容会作为"文章简要（AI 背景）"发给真实模型。

- **能否确认**：只有在条件 1 成立时才是实际问题。`demoResponder` 未提供，所以列为条件性。

- **最小修正**：在 `runRequest` 的 brief 分支中，若 `responder === demoResponder`，直接设 `paperBriefState = 'selection-only'`，不调用 `attachPaperBrief`。不需要改缓存键或缓存结构。

---

## 三、非阻断观察（无需本轮处理）

**单个问题停止或跳过时，共享 brief 不会中止。**
- 依据：`attachPaperBrief` 只是退出 race，flight 的 controller 只由 `stopPaperBriefs` 或 120 秒超时中止。
- 影响：后台 brief 可能继续占用服务端 2 个全局并发名额中的 1 个，最长约 120 秒。这时同时发起的其他请求可能收到 429。
- 判断：这与"一个文档作业服务多个会话"的设计一致，也和已知的并发配额边界属于同类，不构成阻断。若以后要收紧，可以在没有等待者时中止 flight。

---

## 四、未能核实（缺少对应源码）

1. **`demoResponder` 对 card purpose 的输出**：决定第二节的问题是否真实存在。
2. **"仅按选区重试"的入口**
   - `retryAI` 没有参数可以把新请求设为 `selection-only`。
   - 旧状态为 `error` 时重试会再次生成 brief。
   - 该按钮可能另有实现路径（例如先重试、再自动调用 `skipPaperBrief`），本次未见。
3. **codex 局部提问的预算检查**
   - 入口处 codex chat 会跳过 `assertRequestBudget`。
   - 但拿到 brief 后无条件执行 `assertRequestBudget(request)`。
   - 如果 codex 原本有意不走这个预算，可能出现"等完 brief 后才因超预算失败"。需要看 `assertRequestBudget` 对 codex 的阈值才能判断。
4. **`projects.archiveRequest` 对 brief 请求的行为**：该函数对所有 purpose 都会调用，brief 请求附带最多 5 万字的 PDF 正文。其是否写入用户研究目录、是否与以往 card 生成一致，本次无法判断。
5. **`cardResult` 在 `context = []` 时的行为**：未见实现，不确定能否正常返回 `result.body`。
6. **请求快照中的 `documentHash` 字段**：request 校验依赖 `context` 快照里存在 `documentHash`，快照构造代码未见。