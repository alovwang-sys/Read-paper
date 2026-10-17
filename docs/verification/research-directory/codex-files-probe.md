# 真实 Codex 研究目录探针

执行时间：2026-10-17T04:23:29.650Z。结果：**passed**。本次仅尝试 1 次真实模型请求；总执行 17676 ms，模型/历史操作共用 60 秒终止预算。

使用生产 `createCodexRuntime`，只读临时合成研究中的卡片，标题为随机值且未放入问题。生成的 README、research.json、卡片和单页 PDF 先经生产 `writeProjectFiles` 写入。未使用任何真实用户资料。

| 检查 | 结果 |
| --- | --- |
| filesMaterialized | 通过 |
| realReadCommandSucceeded | 通过 |
| realAnswerMatchesCard | 通过 |
| nativeSessionReturned | 通过 |
| sameCwdListed | 通过 |
| sameCwdRead | 通过 |
| nativeHistoryAnswerMatches | 通过 |
| originalFilesUnchanged | 通过 |

本机版本：codex-cli 0.162.1。原生 Session ID：01a14819-c1a1-7e22-984d-df71e95ddade。

同目录列表与读取均使用生产适配器，适配器核对原生 thread.cwd 后才返回会话；通过标准要求真实文件读取、回答、原生 ID、同 cwd list/read 与原生历史的精确最终回答同时匹配。生产流会合并 commentary 与最终回答，因此流文本只要求以实际标题结尾，原生历史仍要求最终 assistant 消息严格等于标题。

本次观察到流正文包含“我会只读取指定卡片的第一行。”随后追加正确标题；原生历史保留两条 assistant 消息，最终消息精确匹配标题。初版探针将合并后的流正文也要求完全等于标题，随后仅根据这次已保存结果修正检查标准，没有再次请求模型。没有复制 Markdown 归档来冒充原生 Session 恢复，也没有发起第二轮模型请求。

临时研究文件已清理；Codex 自己创建的合成测试会话保留在原生存储。未修改用户 Codex 配置、既有会话或 daemon。未操作独立 Codex 桌面 UI，因此桌面中的项目切换/展示和第二轮原生 resume 仍未验收。

重跑会再次产生真实模型请求：`node scripts/verify-research-directory-codex.mjs --run`。只校验本地合成文件而不调用模型：`--self-check`。脱敏细节见 [JSON 记录](codex-files-probe.json)。
