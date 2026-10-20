# 白板 Skill 验证记录

日期：2026-10-19。实现设计见[现有助手驱动白板整理](../../agents/whiteboard-skill.md)。测试使用项目自制资料，不使用真实研究数据。

本文保留首轮“选 Skill 后整理已有板”的历史验收。当前交互已更新为聊天内生成与一次性编辑，最新范围、结果和截图以[聊天白板验收](../chat-board/README.md)为准；下文旧界面和计数不代表本轮结果。

## 确定性验证

| 检查 | 本次结果 |
| --- | --- |
| `npm run check`、`npm run build` | 通过；沿用既有 bundle 大小提示 |
| `npm test` | 21 个文件、266 项通过 |
| `npm run test:server` | 181 项通过 |
| `npm run test:desktop` | 16 项通过 |
| `npx playwright test tests/e2e/board-agent.spec.ts --output test-results-board-agent` | 4 项通过，使用明确标注的演示适配器 |
| 既有相关 AI / 工作台 UI 回归 | 12 项中首轮 11 项通过；PDF 同 hash 重导入用例首次超时，单独复跑通过，未修改 PDF 模块 |
| `npm run desktop:package` | macOS arm64 打包通过；app.asar 中已核验唯一 Skill 文件存在 |
| 打包桌面基础路径 `desktop.spec.ts` 的安装产物用例 | 1 项通过：独立启动、PDF/双栏、模型设置、关闭保存、重启恢复；不算真实白板模型调用 |

单元与服务测试覆盖三类助手路由、模型直连、保持当前设置、请求快照、原生范围收缩/关闭/换板、停止迟到响应、重试与重新生成；覆盖不写入预览、应用/恢复幂等、保存失败重试、人工修改历史、跨研究归属、恢复冲突/副本、越界资料/无效连线/危险 ID、ZIP 往返与研究目录历史隔离。

UI 验证：选择 Skill、目标和材料，输入并生成提案；预览/取消不修改白板；应用后刷新保留；人工修改后拒绝过期提案；版本比较；安全恢复及冲突副本；保存失败可重试且仅一条批次；后续修改使旧移出撤销失效；切换研究保留输入及结果归属。1024px 左栏折叠，发送与停止仍可操作。

## 实际界面证据

- [1440×900 只读预览](proposal-1440.png)
- [1280×800 只读预览](proposal-1280.png)
- [1024px 折叠导航与预览](proposal-1024.png)
- [应用后的白板](applied-1440.png)
- [历史恢复冲突与保留当前](history-conflict-1440.png)

图片来自实际产品中的演示管线，不是交互原型，也不作为真实模型调用证据。

## 真实助手验证边界

`scripts/verify-board-skill-codex.mjs` 使用生产 `compileAgentPrompt`、`createCodexRuntime` 和真实 `parseBoardPlan / previewBoardPlan`；临时合成三节点资料，只读执行并核验原文件 hash。`--self-check` 不请求模型；`--run` 会产生真实模型请求。

首次真实 Codex 请求得到原生 Session/Turn ID，但在 90 秒截止内没有完整回答，主动停止；未得到可验证 JSON。首次记录保存于 [codex-probe-timeout.json](codex-probe-timeout.json)，最终诊断见 [codex-probe.json](codex-probe.json)。不能仅因拿到会话 ID 就认定真实白板生成成功。

唯一补充诊断保留默认模型，仅本次请求使用 low 推理，120 秒内仍未完成，已停止且不再重试。两次均没有工具调用，合成原文件 hash 保持一致。原因不能仅凭超时确定；真实白板提案、同会话后续修改仍未验收，详见[探针说明](codex-probe.md)。

Claude Code / OpenCode 本轮只有确定性适配器验证，未完成真实模型白板生成。没有将演示结果、桌面打包或通用聊天测试算作这三家原生模型的白板能力验收。issue #6 的卡片正文、全知识对象版本和任意架构节点未实施。
