# Codex 后台 writer 占用导致正常续聊中断

日期：2026-10-17。基线 `060b93d`，分支 `codex/source-intake`。本项目记录该根因 1 次，全局次数未知。root_cause=session_ownership。

## 故障与证据

用户未主动打开原生对话，工作台仍显示“此原生会话正在其他客户端使用”。现场只读核查确认对应会话文件由 Codex 桌面后台持有；错误来自原生 `-32600 / already has an active writer`，不能据此断定用户打开了界面。没有停止用户进程、删除锁或修改原会话。用户实际内容和会话 ID 不写入仓库。

2026-10-17 接手耦合快照：`server/codex-runtime.mjs run` 在发送前 resume 原 ID → `server/agents.mjs persist` 保存 ID/ref 与服务内并发锁 → `src/services/ai.ts` 保存当前会话与累计材料 → `AgentActivity.tsx` 展示执行状态。以上基线均锚定 `060b93d`。调查 agent 负责 runtime，主 agent 负责共享绑定与前端状态，独立 worker 负责真实 UI 回归；不停止其他用户任务。

新增测试先红：

```text
node --test --test-name-pattern='native writer ownership forks' server/codex-project.test.mjs
exit 1: session_busy，正常续接没有保留历史的恢复路径
npx vitest run tests/unit/agents.test.ts -t '写锁恢复'
exit 1: expected [evidence-a,evidence-b], received [evidence-b]
node --test --test-name-pattern='fork recovery protects' server/project-integration.test.mjs
exit 1: expected session_busy, received undefined，新副本没有并发保护
```

## 最小修复

仅项目会话在 `turn/start` 前遭到精确 writer 错误时 fork 一次。复用当前权限、模型和目录，校验新 ID/cwd/来源，禁止复制的 goal 自动继续。仅给新 ID 发送本轮问题，不抢原 writer。失败保留原关联、历史和输入；普通协议错误、取消和回合开始后的失败不自动复制或重发。

服务先占用新 ID 的保护，再释放自己持有的旧 ID，随后异步保存新的 registry/ref；队列捕获具体 ID 与模型，避免可变状态串写。客户端保留 fork 继承的累计材料，旧消息来源不改。恢复提示默认可见。

## 验证与限制

类型检查 exit 0；单元 261/261；服务器串行执行 214/214。两次全文件并发执行均在既有 40ms 问答夹具的文件准备阶段提前超时，213/214，其他原断言不变。确定为测试时间预算不足后，将测试准备预算改为 400ms，同时把用户等待验证提高到该预算两倍以上，保留全部暂停、非法答复和完成断言；生产超时不变。

原生探针只使用临时 CODEX_HOME 和合成会话。最初 inject 原始消息能证明 fork 与两个 writer 并存，不能证明完整 turn 历史复制：源和副本的可见 turn 均为空。该不足单独记录；后续采用仅 localhost 的模拟 provider 生成真实 turn 复核，实际结果统一记录于 [验收](../../../docs/verification/native-session-recovery/README.md)。不把有新 ID 视为历史保留已验证。

最终真实 CLI 探针 exit 0：localhost provider 1 次、真实模型 0 次；副本问答完整，两个 writer 均可独立使用，副本客户端退出后新客户端仍读回同样问答。浏览器受影响 36/36、打包桌面 12/12。DMG/ZIP 构建 exit 0；独立核验 101 个运行文件零差异。已正常保存退出旧应用并替换安装、重新打开，原工作区和输入恢复；未重发用户内容。实际 hash 和安装证据见上述验收。

## 退路与防复发

保留基线提交与原生源会话；可按本次文件 diff 撤回。未删除用户资料、原会话或凭据。复燃条件：以 UI 是否打开推断原生所有权、fork 未迁移本机锁、或在结果未知时自动重发。

后续同类回归必须同时覆盖 writer、逻辑对话、来源、输入和新 ID 的并发保护。PMB 记录本地经验；不存在可用的全局计数或 PMB 服务，不虚构其状态。
