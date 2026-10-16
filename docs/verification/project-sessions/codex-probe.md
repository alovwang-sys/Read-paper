# Codex 项目会话实机探针

2026-10-17，macOS arm64，`/opt/homebrew/bin/codex`，`codex-cli 0.162.1`。完整结构化记录见 [codex-probe.json](codex-probe.json)。

使用同一个新建的系统临时研究目录与唯一自制持久化线程；只通过 `createCodexClient` JSON-RPC 操作。没有扫描用户已有历史、改写数据库、移动原有线程或读取认证内容。原生记录物理位置由 `thread/start` 返回：`~/.codex/sessions/2026/10/17/rollout-…jsonl`，研究归属 `cwd` 与物理存储分别表达。

| 能力 | 真实结果 |
| --- | --- |
| 研究目录创建原生线程 | 通过；返回 cwd 与规范研究目录一致 |
| 另一进程按研究目录发现 | 通过；`thread/list` 携带精确 cwd、`useStateDbOnly: true` 与包含 appServer 的 sourceKinds，返回唯一自制线程 |
| 另一进程读历史 | 通过；metadata 校验 cwd，再 `thread/turns/list` 取得两次测试提交，不 resume、不重执行工具 |
| 同一原生身份加载 | 通过；另一进程在前一进程退出后成功 `thread/resume` 相同 ID |
| 跨进程运行状态 | **不能依赖**；A 已加载为 idle 时 B 仍报告 notLoaded。局部状态不能证明全局空闲 |
| 跨进程并发保护 | **存在原生排他 writer 锁**；A 持有线程，B `thread/resume` 返回 JSON-RPC -32600 `already has an active writer`；无需启动模型即可复测；A 退出后可恢复 |
| 两端完成模型回复 | **未完成验收**；两次合成探针中，第一次工具定义漏了当前 schema 要求的 `type: function`，等待握手 60 秒无结果；第二次由探针在并发 writer 冲突后主动关闭。两次都没有 assistant 回答，不能归因为生产运行时或供应商不可用。另一次生产适配器固定短请求见下文 |
| Codex Desktop 项目列表可定位 | 待人工客户端验收；协议发现成功不能冒充桌面 UI 已确认 |

独立 stdio app-server 的 `thread/read.status` 不共享其他进程运行状态；因此发现接口返回 unknown，局部 active 只可说明已知忙碌。经实机确认的原生 writer 锁作为接续保护：未知状态可以尝试继续，thread/resume 原子取得写入权；其他客户端占用时映射为 session_busy，拒绝发送，不自动新建或重试。只读列表仍无法知道谁占用、是否正在生成或空闲客户端仍持有加载态。本轮不通过读取进程、解析 lock 文件或修改数据库来猜测。

实现使用最近两页、每页最多 50 轮的有界读取；稳定 ID 去重，超出 100 轮、200 条可见消息、单条 60,000 字符或总计 500,000 字符时明确 truncated。只映射 userMessage、agentMessage 与经过既有脱敏的工具过程，不返回开发指令或隐藏推理。

依据：[OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 与本机 `codex app-server generate-json-schema --experimental` 输出。官方提供 cwd 精确过滤、metadata-only thread/read 与分页 turn 历史；跨进程 writer 锁结论来自上述本机实测，不推断为所有旧版本都具备。

独立生产路径冒烟直接调用 `createCodexRuntime.run`，使用另一自制研究目录、空材料和空技能，仅请求固定短回复。创建与回合身份已返回，约 85 秒仍未收到可见回答后主动中止；结果见 [codex-production-probe.json](codex-production-probe.json)。随后在真实应用内浏览器绑定该自制目录，能发现并读取同一会话；没有追加模型调用。完整问答与原生桌面列表仍待验收。
