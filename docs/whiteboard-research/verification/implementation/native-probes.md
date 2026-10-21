# 局部研究原生助手真实探针

运行状态：completed。开始：2026-10-20T14:00:53.205Z；完成：2026-10-20T14:02:40.145Z。

路径：真实本机 HTTP createAgentHandler → createClaudeRuntime → 已认证 Claude Code CLI。CLI：2.1.304 (Claude Code)。只用临时隔离研究、自制单页 PDF 和明确标为自制的摘要，没有读取用户研究或凭据文件。CLI 工具、MCP、插件被现有适配器禁用。

| 历史策略 | 完成轮数 | 第六轮观察 | 无当前原文的编号引用轮次 |
| --- | --- | --- | --- |
| latest | 6 | 未回忆出初始代号 | 无 |
| guided | 6 | 回忆出初始代号 | 无 |
| all | 6 | 回忆出初始代号 | 无 |

原生会话每轮新建：true；唯一 ID 数：18。完整输入清单、每轮输出、模型标识和实际 session ID 见 [native-probes.json](native-probes.json)。请求将 reset 写为 false，以核查服务端对 boardResearch 仍强制新运行会话。

这是一组小样本，不足以断言哪种历史策略质量最佳。历史选择由探针按设计构造；客户端 builder 另由单元测试验证。本探针不验证真实文献搜索、PDF 文本提取、UI 或完整持久化。首组 Claude 对照没有覆盖 Codex/OpenCode；下方追加各供应商单次能力探针，分别记录其实际边界。也不因 Claude 禁工具模式成功而宣称其他原生模式有单卡文件隔离。模型 token/cost 没有可靠计量，字符数不是 token。

## 适配器修复与保留的失败记录

最初生产适配器的能力检查显示 ready、CLI 状态显示已登录，但实际请求返回 needs-auth，没有模型正文。经授权只移除 `--restricted` 做一次最小差异探针，取得真实回答；随后将同样的最小修改落入生产适配器。CLI 帮助说明 restricted 会忽略用户／项目的设置，safe-mode 则保留正常认证与模型设置。修复保留 safe-mode、空 tools、空且严格的 MCP 配置、禁 slash、dontAsk 和 permission-prompts none，不读取或改写凭据，也没有重新登录。

一次探针调度曾以三个策略同时请求，触发本机服务现有 concurrency_limit；该次未完整执行，不记通过。完整结果按最多两个请求并发取得。首次认证失败、单参数差异烟测和调度失败均完整保留在 JSON 的 priorAttempts 中，没有用最终成功覆盖旧失败。

最终 18 个实际模型轮次全部完成，模型均为 claude-opus-5-5。仅上一轮策略在第六轮明确表示看不到最初代号；引导策略和全部历史策略回忆出代号，三者都明确本轮没有 PDF 原文依据。摘要阶段没有产生数字页码或有效 PDF 引用；第二轮引用对应自制 PDF 的第 1 页。这只是当前夹具中可观察的区别，不证明引导策略在真实研究中总体更优。

后续补充的历史非 PDF 正文发送由客户端真实 messages 和服务端 compileAgentPrompt 的确定性测试覆盖；本夹具历史仅传问答及所选 PDF 快照，非 PDF 摘要作为当前材料测试，不据此宣称验证了所有材料组合。


## Codex／OpenCode 单次实际能力补测

开始：2026-10-20T14:21:47.564Z；完成：2026-10-20T14:23:56.055Z。沿用生产运行时，经真实本机 HTTP createAgentHandler，两个供应商共用一个临时隔离研究目录和同一自制摘要。只有 runtime.probe() 返回 ready 才执行一次局部问答，不安装、登录或修改配置。Codex 显式 read-only、skillIds 为空；原问题标题只在 boardResearch 中，随机摘录代码只在摘要正文中，context 与 history 为空。测试要求不调用工具或读文件，临时研究目录已删除。

| 供应商 | probe 状态／CLI 版本 | 实际请求数 | 观察结果 |
| --- | --- | --- | --- |
| opencode | ready / opencode v2.0.18 | 1 | 6.57秒后 stream_interrupted；可读正文完整，原问题与摘要代码正确，说明无全文／页码，无数字引用；没有 done，不计通过。 |
| codex | ready / 0.162.1 | 1 | 120秒 timeout；半段正文原问题与摘要代码正确，无数字引用，末句截断；没有 done，不计通过。 |

完整请求、编译后的 runtime 输入、事件与正文在 JSON 的 additionalProviderProbes 中；原 Claude 18 轮和 priorAttempts 均保留。本次仅观察到两者确实接收原问题和摘要，尚未取得成功完成的运行状态；不代表真实文献检索、全文读取、六轮历史、所有模型或文件级隔离通过。Codex 的只读权限不应解释为只可读取当前卡片；研究目录访问范围与发送清单仍须分开表述。

最初两次均无工具或权限进度事件，未扩大权限，各只调用一次；后续 OpenCode 仅在确证协议问题并修复后复验一次。OpenCode 会话事件报告模型 zhipuai-coding-plan/glm-5.3-flash#high；Codex 在超时前的应用事件没有返回模型标识；随后定向只读该测试会话，原生 turn_context 确认为 gpt-6.1-sol、low。临时研究与适配状态目录已删除；原生 CLI 可能保留这两次新建的自制测试会话记录，没有删除任何用户会话。

### Codex 超时的定向诊断

没有重新调用模型。仅以生产 createCodexClient 对这次自制会话执行 thread/read，并只读其返回的该次 rollout 路径，记录事件类型／时间／模型，未读取凭据或其他用户会话。原生 turn 状态为 interrupted，只有 userMessage，没有已完成 assistant item；原生记录包含 14:21:53 task_started、14:22:09 turn_context、14:23:49 turn_aborted（reason=interrupted），没有 task_complete。它与应用 120秒截止后主动中止一致，不能归因为应用漏关联已完成事件，也不能据此放宽超时或伪造 done。上游低速、网络或供应商内部原因仍无法区分。没有改动 Codex 运行时或发起第二次请求；安全时间线保留于 codex.diagnostic。

### OpenCode 完成状态修复后的唯一一次复验

开始：2026-10-20T14:36:41.908Z；完成：2026-10-20T14:36:48.402Z。真实完成（HTTP 200，最终事件 done），耗时 5.80秒。原问题逐字复述、摘要代码正确，没有数字 PDF 引用，没有工具或权限进度事件。模型 zhipuai-coding-plan/glm-5.3-flash#high。采用当前生产适配器，经真实 createAgentHandler 与已登录 OpenCode，使用新的临时研究和自制摘要，context/history 为空；没有放宽超时、权限或工具限制。

输入与完整事件追加在 JSON targetedProviderRechecks；首次 stream_interrupted、Codex timeout、原 Claude 18轮及 priorAttempts 均保留。临时目录已清理，原生 CLI 可能留存新建测试会话。此结果仅覆盖当前 OpenCode 版本／模型的一次材料问答，不证明真实检索、多轮历史、所有供应商或文件级隔离通过；Codex 未重跑。

OpenCode 首次失败的定向原生证据：同一 session 的 outcome=succeeded，准确 assistant messageID 为 msg_159b276dc001JG8iGJtPGnCR63，finish/rawFinish 均为 stop，completed=1792506236032，早于 session idle=1792506236034。安装版 v2.0.18 的完成消息回填可能不补发 step_finish。修复仅在正文绑定同一本轮准确 messageID 时，再核对原生 session 成功、该 assistant 消息 stop／时间／正文完全一致；缺少或不符仍报中断。该兼容修复由 paper_products 实现，31 项相关协议／项目运行时测试通过后才执行上述唯一一次真实复验；诊断安全片段位于初次 opencode.diagnostic。
