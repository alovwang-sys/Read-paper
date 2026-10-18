# Codex 后台会话占用恢复

2026-10-17，分支 `codex/source-intake`，随 PR #15 交付。本轮修复正常续聊遇到原生后台 writer 占用时没有恢复路径的问题；后台持锁不能推断为用户主动打开了对话。

## 处理路径

1. 先按原 ID 续接；仅精确 `session_busy` 且尚未 `turn/start` 时恢复一次。
2. 用 `thread/fork` 保留原生历史与当前目录、权限、模型配置；`deferGoalContinuation:true` 防止复制的 goal 自行续跑。校验新 ID、项目 cwd 与来源，不抢占或停止原 writer。
3. 当前问题只向新 ID 发起一轮；逻辑研究/对话不变，旧消息来源不改。原生端可看到独立副本，之后工作台沿用副本的 ID/ref，保留累计材料。
4. 回答旁默认展示“已恢复对话”。复制失败时原关联、记录与输入保留，已有下一条草稿优先；普通错误、取消和已开始回合后的错误均不自动复制或重发。

新 ID 的本机保护先取得再释放原 ID，后续异步保存捕获具体 ID/ref，避免并发串写。原生会话、引用与用户凭据不删除。

## 实际验证

- `npm run check`：exit 0。
- `npm test`：20 文件，261/261，通过 fork 后累计材料、旧来源与下一轮新 ref。
- `node --test --test-concurrency=1 server/*.test.mjs`：214/214，包含 fork 成功/失败、非法 ID/目录、原权限与配置、取消、已开始回合不重发、新 ID 并发保护与重启映射。
- 时间夹具稳定后，标准 `npm run test:server` 全文件并发执行：214/214。
- 浏览器受影响回归：新 `native-session-recovery.spec.ts` 6/6，既有 `agents.spec.ts`、`project-sessions.spec.ts`、`composer-submission.spec.ts` 合计 30/30。覆盖常显恢复提示、失败两种草稿、研究切换隔离、刷新与下一问的新 ref。
- `npm run desktop:make`：macOS arm64 DMG/ZIP 成功。
- 打包桌面新增专项 1/1，其他原有桌面 11/11，合计 12 项。真实 `papertrail://app/` 与 IndexedDB 验证常显提示、原记录与累计材料、退出/重启后的新 ref 和草稿；[截图](desktop-session-recovery.png)、[机器记录](desktop-session-recovery.json)。新用例初次因第二次启动缺少目录 fixture 而退出保存失败，补齐同一 fixture 后保留完整持久化断言通过，未改生产保存逻辑。

最初全文件并发服务器运行中，既有 40ms 问答夹具在文件准备完成前就超时（213/214），串行原断言全部通过。将这两项测试的准备预算改为 400ms，同时把等待用户答复的验证提高到该期限的两倍以上，保留暂停超时、非法答复与继续完成的全部断言；生产超时不变。全站 105 项浏览器基线已在前一提交通过；本轮运行上述受影响路径，不将其写为全站重跑。

三尺寸：[1440×900](browser-1440.png)、[1280×800](browser-1280.png)、[1024×800](browser-1024.png)。实际打开检查主区 PDF 与右侧 AI 并列、恢复提示常显、窄屏不越界，均为本产品合成资料。

新包独立校验 DMG 有效，包内 101 个运行文件与磁盘源码/dist 全部相同。已正常退出旧应用、等待保存，将 272 个 bundle 条目完整核对后替换 `/Applications/Papertrail.app` 并重新打开；原工作区、会话与未发送输入保留，界面“已保存”、Codex“就绪”、发送可用。旧 app 与上次试用安装包移至可恢复废纸篓；用户资料目录未被安装程序改动。新安装包 `Papertrail-0.1.2-session-recovery-arm64.dmg` 位于 Downloads，hash 及安装记录见[机器记录](package-evidence.json)。未自动重发用户问题；旧报错记录仍保留。

## 真实 CLI 协议探针

命令：`node docs/verification/native-session-recovery/codex-fork-probe.mjs`。本机 Codex CLI 0.162.1，exit 0。

```text
completed-synthetic-turn: localhostProviderRequests=1, realModelCalls=0
resume-blocked-with-active-writer: pass
fork-retains-completed-question-and-answer: pass, itemCount=2
independent-source-and-fork-writers: pass
persisted-fork-history-readable-after-client-restart: pass
own-clients-and-server-closed-temporary-state-removed
```

脚本只使用临时 `CODEX_HOME`、临时项目和 localhost 模拟 Responses provider。真实 CLI 完成一轮合成问答，另一自有客户端的 resume 被写锁拒绝，随后 fork 并读回问答；原客户端仍能写入原会话。关闭副本客户端后，全新客户端再次读回同一副本的完整问答，验证持久化。全部临时进程、HTTP 服务和状态在 `finally` 清理；未向真实模型发送数据或使用用户已有线程。

早期探针的 raw `inject_items` 不构成可见对话 turn；paginated rollout 文件也不是完整问答存储，不能据此证明复制成功。最终以完成回合及跨客户端 API 精确读回问答验证，未弱化问答断言。协议依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

本轮没有重发用户原问题，也未验证真实付费模型回答。只在确认尚未开始本轮生成时恢复，不将超时、断线或停止未确认视为可以自动重发。
