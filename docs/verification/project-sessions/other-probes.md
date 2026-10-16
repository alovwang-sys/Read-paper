# OpenCode 与 Claude Code 项目会话探针

2026-10-17。本轮只使用新建临时研究目录与固定测试问题；不改写用户已有会话，不安装依赖、不登录、不切换用户模型、不改全局配置。原生认证值和供应商配置未输出。

## 本机结果

| 能力 | OpenCode v2.0.18 | Claude Code v2.1.281 |
| --- | --- | --- |
| 项目新会话的原生归属 | 通过：共享 background service 创建的两条测试会话都属于指定 canonical 目录 | CLI 参数沿用真实项目 `cwd`；本机未登录，真实新问答未验证 |
| 按目录发现 | 通过：独立 CLI API 能发现本轮两条会话；空临时目录返回 0 条 | 已实现官方已知目录的本地 JSONL 发现；本机该临时目录无历史，返回空列表 |
| 历史读取 | 通过：按原生 ID 读回测试用户问题及稳定消息 ID | 确定性 JSONL 用例通过；本机没有认证后的测试回答记录，未声称真实双向读取通过 |
| 真实回答与同会话续接 | 两次固定问题均在限时内没有收到供应商回答；只验证用户消息落入原生记录，未验证完整双向问答 | 未登录，未运行模型请求 |
| 运行状态 | 真实 `/api/session/active` 能观察本轮共享服务任务；随后任务退出，不能据此排除独立服务进程 | `claude agents --json --cwd` 在本机能运行，不要求登录；匹配原生 UUID 与 canonical cwd 的 busy/waiting/working/blocked 记录才标忙碌 |
| 外部历史安全续接 | `canResume=false`：共享 daemon 活动快照无法证明没有其他独立进程占用 | `canResume=false`：原生允许两终端交错写同一记录，没有可原子核验的排他续接接口 |
| 原生桌面应用显示 | 共享原生 API 记录可定位，未操控桌面客户端，未声称桌面列表已验收 | 按官方 `/resume` 交接说明定位；未验证 Desktop 的独立列表 |

测试目录：`/private/var/folders/4h/v1n8jbvn71l4g_lqch26qcm40000gn/T/read-paper-project-native-probe-7aMFTA`。

仅本轮新建的原生 OpenCode 会话：`ses_eba6d6048ffefR2aJbgQ1ryCUH`、`ses_eba667887ffeeZAg49oMZAtpz3`。记录保留用于复核，未删除或移动。

## 已实现的边界

两个适配器均提供 `listSessions({cwd, signal})` 和 `readSession({cwd, sessionId, signal})`。只访问明确绑定的目录，按 canonical cwd 精确校验；读取会话时再次校验归属，稳定原生 ID 保留在消息中。列表最多 100 条，历史最多 500 条并限制文本体积，截断有标记。思考内容不展示，附件或工具块显示未展开说明，不执行历史工具。

OpenCode 使用 `opencode api GET /api/session?directory=…&limit=100`。本机发现 `--param directory=… GET /api/session` 没有应用过滤，故生产路径将 query 固定在 URL 中，并对返回结果再次按目录过滤。API 配置读取仍保持私有服务隔离，绝不把含凭据配置返回浏览器；项目会话创建与运行则使用用户共享 background service，不使用 `--standalone` 冒充桌面互通。新会话有原生全 deny 工具权限，继续本软件自己的项目会话前核对目录、权限和已知活动状态；不修改外部会话权限。已有非项目临时会话沿用旧隔离运行路径。

本软件自己的已映射会话保留原生多轮参数；外部发现项当前只读，由主服务区分。OpenCode 取消共享运行时不能只等待 CLI 退出：适配器显式向本轮会话发送 `/interrupt?resume=false` 并复核活动状态，失败返回 `stop_unconfirmed`，不声称已停止、不结束用户 daemon。该修复的活动取消路径有确定性协议测试；真实探针只执行了 `/interrupt` 的 idle no-op（`interrupted=false`），尚未再次发起付费问答验证 active interrupt。

Claude 使用官方默认 `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<uuid>.jsonl`。不扫描其他项目，拒绝符号链接日志、错误 session ID、目录不匹配、超过 8 MB 和损坏的完整 JSON 行；最后一个未写完的片段只标记不完整。超过 200 字符的版本相关目录 hash 暂不猜测，明确报不支持。JSONL 是版本相关内部格式，未知内容保留未展开提示。活动查询使用官方 CLI；活动列表为空仍标 unknown。Read-paper 提问包装保留在原生消息中，列表标题提取真正用户问题。

## 检查

`node --test server/project-runtimes.test.mjs server/other-runtimes.test.mjs`：29 项通过（11 项新增项目用例及 18 项原有运行时用例）。包括精确目录、symlink 别名、外部占用未知、共享新建、权限改变、仅本轮取消和停止未确认、分页、稳定 ID 去重、思考隐藏、损坏/超大/符号链接历史。

## 协议依据

- [OpenCode V2 API](https://opencode.ai/v2/docs/api)：项目过滤、会话及消息分页、当前服务活动列表、原生权限、interrupt。
- [OpenCode 官方 handler](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/handlers/session.ts)：prompt 的 409 对应消息 ID 冲突，不能解读为跨进程 busy 锁。
- [Claude Code 会话与存储](https://code.claude.com/docs/en/sessions)：目录编码、JSONL 内部格式限制，以及同时续接可交错写入的边界。
- [Claude Code agents JSON](https://code.claude.com/docs/en/agent-view#list-sessions-as-json)：cwd、sessionId、status/state 字段与活动状态含义。
- [Claude Code Desktop 交接](https://code.claude.com/docs/en/desktop#coming-from-the-cli)：CLI 关闭后通过 `/resume` 定位，不将独立桌面列表当作已验收。
