# 原生历史状态与白板本地恢复验收

2026-10-20，在整合工作树中验证；全部使用隔离浏览器数据与模拟服务，未打开实际安装应用、读取用户会话或发送真实模型请求。

原生记录明确 `inProgress` 时显示正在运行，并继续只读刷新同一条记录；明确中断显示已中断，未知结束状态与截断预览提示核对，只有明确失败使用错误告警。查看外部进行中记录没有停止、重试或重新生成按钮，不发送控制操作。已有请求身份不完整时不按问题文本猜测合并。

已完成但因无标签连线解析失败的白板可点击“重新解析白板”。本地重新读取保存的模型结果并保存白板，保留原始正文、原生回合、研究与材料快照；界面显示白板摘要。重新解析不创建模型请求。

| 验证 | 结果 |
| --- | --- |
| `npx vitest run tests/unit/project-sessions.test.ts` | 29 / 29；先复现运行中误判、中断文案及未知状态误判，再修复 |
| `CI=1 npx playwright test tests/e2e/project-sessions.spec.ts --output=test-results-native-history-state` | 11 / 11；外部原生进行中自动刷新至完成、保持同一记录、刷新恢复草稿、三助手既有路径 |
| `CI=1 npx playwright test tests/e2e/chat-board-reparse.spec.ts --output=test-results-board-reparse` | 1 / 1；先复现白板错误误标为引用问题，再验证本地恢复及零模型/回合操作请求 |
| `npm run check`、`git diff --check` | 通过 |

白板恢复测试覆盖缺省及 `null` 连线说明归一为空字符串、3 个节点/2 条连线保存、单条请求/版本记录、原始 `body`/`rawBody` 不变、原生线程与回合不变、未发送草稿与主区 PDF 保留、刷新恢复。

截图已实际查看：

- [1440×900 运行中](running-1440.png)、[1280×800 运行中](running-1280.png)、[1024×800 运行中](running-1024.png)：主区 PDF 与右侧历史并列，窄屏左栏折叠。
- [已中断提示](interrupted-preview-1440.png)、[明确失败告警](confirmed-failure-1440.png)。
- [白板本地恢复](board-reparsed-1440.png)。

边界：本记录不证明真实 Codex 任务、客户端之间写入锁交接或安装替换已验证；持续托管连接的服务回归由对应测试另行覆盖。
