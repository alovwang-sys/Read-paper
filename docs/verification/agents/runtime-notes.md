# Claude Code / OpenCode 原生运行时核验

核验日期：2026-10-16。代码：`server/claude-runtime.mjs`、`server/opencode-runtime.mjs`；自动检查：`node --test server/other-runtimes.test.mjs`。

这两个连接运行用户自己安装的原版 CLI，使用各自管理的认证与会话，没有把其他模型 API 包装成对应 Agent。当前切片只开放明确发送的文字，能力始终标记为 `images: false / tools: false / resume: true / permissions: read-only`。真实可用性与模拟协议测试分开记录。

| 运行时 | 本机实测版本 | 原生协议 | 会话恢复 |
| --- | --- | --- | --- |
| Claude Code | 2.1.281 | `--print --output-format stream-json --verbose --include-partial-messages` | 原生 `session_id` 与 `--resume` |
| OpenCode | v2.0.18 | `run --standalone --format json`，每轮独占原生服务 | 原生 `sessionID` 与 `--session` |

实际版本、参数来自本机 `--version`、`--help`、`run --help`；实现同时核对了 [Claude Code 非交互文档](https://code.claude.com/docs/en/headless)、[OpenCode CLI](https://opencode.ai/docs/cli/)、[OpenCode 服务](https://opencode.ai/docs/server/)。OpenCode 本机 v2 接口已使用 `/api/...`，通用服务文档展示的 `/doc` 在本机返回网页；因此实现采用本机已存在的原生 JSON CLI，不照抄旧 HTTP 路径。相关原生实现见 [run.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/run/run.ts)、[noninteractive.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/run/noninteractive.ts)、[standalone.ts](https://github.com/anomalyco/opencode/blob/dev/packages/cli/src/services/standalone.ts)。

认证与配置：

- Claude 使用 `claude auth status --json` 检测，只接受明确的 `loggedIn: true`。本机结果为未认证，界面应为 `needs-auth`；没有启动登录，也没有读取或输出 token。
- OpenCode 将 `OPENCODE_MODEL=供应商/模型` 作为可选覆盖；未设置时解析本机配置中的 `model` 或 TUI 最近选择的模型，再显式传给 `run`，避免非交互运行自行选择免费模型。不以 `opencode auth list` 的人类可读标签匹配阻断连接，本地模型、环境凭据和自定义 provider 可以没有 stored-auth 标签。`ready` 表示本机安装、协议与模型解析就绪，不证明认证或额度有效，实际可用性以请求结果确认。原生配置默认模型和单次 `--model` 覆盖的说明见 [OpenCode v2 模型文档](https://opencode.ai/v2/docs/models/)。
- 可用 `CLAUDE_BIN`、`OPENCODE_BIN` 指定原生可执行路径；没有配置时先发现本机常见安装位置，再使用 PATH。

只读边界：

- 所有进程固定参数、`shell: false`；用户文字经 stdin 发送，原生会话 ID 先校验。OpenCode 的 `PWD` 强制与服务端材料目录一致，避免继承父服务路径。
- Claude 开启 `--safe-mode --restricted`，禁用技能、所有内置工具与 MCP，使用 `dontAsk` 和 `--permission-prompts none`。不使用 bypass。参考 [Claude Code 权限](https://code.claude.com/docs/en/permissions)。
- OpenCode 只继承选定模型及 provider 连接配置，不继承用户工具、MCP 或 agents 设置；使用独立临时配置目录，关闭项目、Claude 自定义配置发现，注入全局及专用 Agent 的全拒绝权限，移除原生工具、MCP、环境指令及兼容技能插件。检测到系统托管配置时不能保证其不会覆盖限制，因此禁用此连接并给出原因。参考 [OpenCode 权限](https://opencode.ai/docs/permissions/)、[配置顺序](https://opencode.ai/docs/config/)、[原生权限配置实现](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/plugin/agent.ts)。
- 停止和超时终止自有进程组，超出宽限时间升级 SIGKILL；OpenCode `--standalone` 服务的 stdin 租约在 CLI 退出后结束，不连接、停止或修改用户既有后台服务。临时配置目录在退出后清除。
- 仅公开文本正文、原生会话标识和简短状态，过滤推理内容；原始 stderr 与上游错误不发送到浏览器。图片和结构化输入不支持；权限请求拒绝，不能通过 UI 批准额外工具。

自动验证已通过 18 项：版本及登录状态、UTF-8 分段、原生 JSON 解析、最终完成判定、推理过滤、重复文本去重、固定安全参数与 stdin、配置/最近模型及 variant 继承、私有 provider 合并与权限保留、无免费模型回退、错误脱敏和原生模型冻结、原生恢复参数及拒绝意外切换会话、认证与 429 错误脱敏、工具执行异常、取消与超时回收。此测试使用 fake process，不能证明模型真实调用成功。

历史真实调用记录（模型继承修正前）：

- Claude Code：因本机未认证，没有进行模型问答，不标记真实调用通过。
- OpenCode 当时未指定模型、也未继承本机选择的最小问答：服务创建原生会话后返回 403，提示免费层只支持其原生应用。该诊断暴露了非交互运行与本机交互式模型选择可能不一致，不表示必须设置 `OPENCODE_MODEL`；本轮修正为继承本机选择后显式传给 `run`。
- OpenCode 显式 `zhipuai-coding-plan/glm-5.3-flash`：已收到原生会话与多条 `step_start`，45 秒仍无完整正文，终止后不标记成功。输入只有固定连接检测短句，没有本机材料或写入请求。
- OpenCode 经本项目适配器显式 `zhipuai-coding-plan/glm-4.6v`：同样创建原生会话并收到 6 条进度后，于 45 秒安全超时；没有得到正文，未执行后续恢复问答。超时后未残留 `serve --stdio` 进程。该次未获得完整回答，也未完成恢复验证；不以 fake-process 结果代替，不据此判断模型继承修正后的结果。

随后按同一 `zhipuai-coding-plan/glm-5.3-flash` 做了一次最长 90 秒的诊断，没有切换模型、修改用户全局设置或发送本机材料。原生进程于 83.753 秒自行失败，stdin 与固定的 98 字符检测语句完全匹配。原生 stdout 共收到 10 条 `step_start` 和 1 条 `error`，没有 `text` 事件。最终事件的脱敏投影如下：

```json
{"type":"error","error":{"type":"provider.rate-limit","status":429}}
```

这确认了当时该显式模型请求遇到供应商限流或额度限制，适配器没有丢弃原生正文；不能据此判断用户当前本机所选模型的可用性，也不代表模型继承修正后的最新调用结果。禁用项仅覆盖 `opencode.tool.*`、`opencode.tools` 及配置中的兼容技能、环境指令与 MCP，不包括 provider 或输出解析器；适配器将该原生错误映射为可重试的 `rate_limited`，不输出供应商原始错误文本。原生 stderr 也仅在内存内统计并丢弃，没有保存认证信息或完整日志。

本次模型继承修正文档同步没有进行新的模型调用，修正后的真实问答与恢复结果待单独复验记录。

许可与账户使用边界：Claude Code 按用户账户对应的 Anthropic 条款使用；本项目只调用未修改的本机 CLI，由用户完成供应商自己的认证，不收集、转售或中转用户登录凭据。参见 [Anthropic 官方许可与认证说明](https://code.claude.com/docs/en/legal-and-compliance)。OpenCode 代码采用 [MIT 许可](https://github.com/anomalyco/opencode/blob/dev/LICENSE)，模型供应商的账户、费用和使用条件仍独立适用。


模型继承修正后的实测：未设置 `OPENCODE_MODEL` 时，本机探测读取原生配置和状态，选择 `zhipuai-coding-plan/glm-5.3-flash#high`，返回就绪。供应商配置来自独立原生 `api --standalone GET /api/config`，只在服务内存中保留；`debug config` 会把私有 key/header 脱敏，不能用于重建连接。已有 session 保存原模型，旧映射无模型时由原 session 自己保留选择。

实际浏览器仅发送一条固定连接短句，0 条论文材料、0 轮历史；原生层返回 10 条状态后进入供应商限流/额度错误，未得到回答。本轮确认了错误的强制环境变量门槛已移除，没有把配置就绪当作问答成功，也未继续重试或替换模型。截图见 [最新 OpenCode 验收](live-opencode-inherited-model.jpg)。
