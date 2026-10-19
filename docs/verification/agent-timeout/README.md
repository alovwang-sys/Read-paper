# Codex 活跃长任务被超时中断

日期：2026-10-19。分支：`codex/fix-reading-workspace`。先按用户反馈修复并更新本机试用包，随后按用户明确要求整合 `main`；本机 0.1.7 验收与后续 0.1.9 整合分别记录。

## 确认的根因

旧版将 180 秒用于整轮任务截止，即使已收到回答或工具进展也不重置。Codex 的原生思考事件未接入活动判断。用户本次选择 `ultra`，请求开始后约 180 秒被中断，而中断前 2.852 秒仍完成了一项原生思考事件；这是应用的固定截止误判，并非该工具命令执行失败。

已只读核对直接关联的请求导出和原生 JSONL 时间线，确认安装包中的处理器与旧源码一致。没有复制用户材料、问题、回答或思考内容。脱敏时间线与命令日志保存在忽略目录 `test-results/agent-timeout/`。

确定性基线将超时缩为 100ms，并持续产生回答及工具活动：

```text
node --test --test-name-pattern='active answer and tool events' server/agent-timeout.test.mjs
exit 1
AssertionError: actual activity must refresh the idle deadline
```

## 修复范围

| 文件 | 行为 |
| --- | --- |
| `server/agents.mjs` | watchdog 改为无活动计时；有效回答／工具活动重置，原生私有活动信号也可重置；存在待答审批或问题时保持暂停 |
| `server/codex-runtime.mjs` | 仅当前 thread 和 turn 的原生思考、工具输出及有效 item 生命周期通知活动；不发送思考内容，不以 usage 或固定心跳冒充进展 |
| `server/agent-timeout.test.mjs` | 新增 8 个虚拟时间回归，检查跨多个原截止点仍完成、真正无活动停止、部分回答保留、等待用户与取消保护 |
| `server/codex-desktop.test.mjs` | 新增 2 个原生事件回归，覆盖有效活动、作用域、空事件和晚到通知；增强既有取消测试 |

生产默认值仍为连续无活动 180 秒。RPC、发现和历史读取的独立超时不变。Claude Code／OpenCode 子进程各自的既有总时限未在本轮调整，不据此宣称所有助手或所有连接错误都已解决。没有新增自动重试或重发。

原生事件名称与字段使用本机 CLI 的 `codex app-server generate-json-schema --out <目录>` 生成结果核对；schema 保存在上述忽略目录，不依赖付费请求。

## 实际验证

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 27 文件、333 项通过 |
| `npm run test:desktop` | 27 项通过 |
| 浏览器助手／恢复回归 | `agents`、`agent-desktop`、`native-session-recovery`，18 项通过 |
| 服务专项 | 5 文件、88 项通过，新增 10 项；`node --test server/agent-timeout.test.mjs server/agent-interactions.test.mjs server/agents.test.mjs server/codex-desktop.test.mjs server/codex-project.test.mjs`，exit 0 |
| `npm run test:server` | 最终源码 248 项通过，exit 0 |
| `npm run desktop:package` | 最终源码构建与 macOS arm64 打包通过，exit 0 |
| 打包桌面输入区冒烟 | 1 项通过；包含 1024px、取消权限和材料、退出及重启草稿恢复；真实模型请求为 0 |
| `git diff --check` | 通过 |

服务专项原始尾部：

```text
ℹ tests 88
ℹ pass 88
ℹ fail 0
```

完整服务最终原始尾部：

```text
ℹ tests 248
ℹ pass 248
ℹ fail 0
```

浏览器覆盖三种窗口尺寸、工具过程显示、权限拒绝、停止、失败保留、恢复与研究切换隔离。使用隔离测试数据与模拟连接。本轮没有向真实模型重发用户任务，尚未做修复后的真实长任务验证。

## 退路与合并状态

服务修改前的源码保存在忽略目录 `test-results/agent-timeout/*.before.mjs`，可只回退本次服务修复，保留此前资料、布局与标记改动。已正常退出旧应用，备份原应用与用户资料，再替换并打开 `/Applications/Papertrail.app`；备份位于本工作树 `out/timeout-upgrade-backup-se2y2v/`。主工作区没有重置或清理。此处为本机 0.1.7 验收，后续整合状态见下文。

本机版本仍为 0.1.7，最终包的桌面入口、5 个服务模块、HTML、JS 和 CSS 共 9 个关键文件与修复源码／构建产物逐字节一致。已安装 `app.asar` SHA-256：`a7f6d956eac0cbcf8893de824bb4c47d8f88485c00f31f07fb43de6674aee099`。独立静态复核无阻塞；本机协议 schema 核对确认已接入事件的当前 thread／turn 字段匹配，不会因本轮过滤丢弃这些真实活动。

实际启动后确认原研究、分屏内容及来源快照恢复，界面显示“已保存到本地”“目录文件已更新”。未改写或重发原问题。

本次 incident 与防复发记录见 [故障记录](../../../.sisyphus/incidents/2026-10-19-agent-timeout/record.md)。

## 与最新 main 的整合

用户随后明确要求合并。`fetch` 得到 `origin/main=d882564`（0.1.9），包含固定原生线程、按 item 排序的回答、后台持续会话、断线观察和输入保留。整合保留这些能力；本轮无活动 watchdog 用于旧非托管通道，不给托管会话重新加整轮期限。托管客户端跨回合更换活动回调，旧回调不会影响新回合；线程级 usage／status 可缺 turnId，继续正常显示但不用于续期。

原生历史的消息和 timeline item 都先剥离自有材料包装再截断；只有匹配真实已接受请求归档的 requestId 才参与去重。合并受影响 8 个服务测试文件 148 项通过，新增跨回合活动回调隔离回归。最终整合验证及 CI 以合并 PR 的实际结果为准，日志位于本地忽略目录 `test-results/merge-main/`。
