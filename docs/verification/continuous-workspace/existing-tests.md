# 既有回归的入口迁移

新界面并未取消相关数据或能力。下列旧脚本需要更新入口和呈现位置；不能删除其引用、草稿、请求归属、重试或持久化断言来获得通过。

| 测试 | 旧假设 | 应如何适配 |
| --- | --- | --- |
| `tests/e2e/workbench-sessions.spec.ts` | 会话列表在右侧，由“会话列表”展开；切会话返回中央主页 | 列表从左侧“研究会话列表”进入；资源页切会话不换资源，完整显示由“展开聊天”选择；保留多会话历史、输入、迟到结果与研究隔离断言 |
| `tests/e2e/chat-inputs.spec.ts`、`drawing-question.spec.ts` | 打开右侧会话列表，关闭右面板后才能查看回答 | 左侧直接选会话；回答始终在当前聊天宿主。保留图片字节、快照范围、失败重试、新草稿、支持能力和跨会话归属断言 |
| `tests/e2e/agent-workbench.spec.ts` | 助手为原生 select；部分发送后需要“返回会话” | “选择研究助手”菜单内选择 option；同一资源页可直接读答案或展开聊天。保留成果引用、人工修改保护、撤销冲突和能力不冒充断言 |
| `tests/e2e/native-session-recovery.spec.ts`、`project-sessions.spec.ts` | 原生/经典记录与研究列表共用旧右栏入口 | 在新左侧列表选择原记录；旧连接仍由相应适配器呈现。保留可续接/不可续接、历史归档与身份边界断言 |
| `tests/e2e/inline-ai.spec.ts`、`annotation-removal.spec.ts`、`knowledge-excerpts.spec.ts`、`tests/desktop/inline-ai.spec.ts` | 解释、摘录、制作卡片或移除操作常驻选区菜单 | 先展开“更多操作”，再执行原动作；“提问/翻译/摘要卡片”为三主入口。保留真实原文定位、引用、来源与回到同一问答的断言 |
| `tests/e2e/drawing*.spec.ts` 等 Agent 界面入口 | 白板标题直接列在侧栏 | 若不在最近打开，从“浏览研究内容 → 白板”打开列表，再打开同一白板；保留原生编辑、绑定、撤销、快照与资产断言 |
| `tests/desktop/helpers.ts`、`composer-controls.spec.ts` | 先等资源 main 可见，面板只在切换 Agent→经典的条件内展开 | 已获授权迁移为先等真实 shell，明确确认经典模式，独立展开参考面板并等待 AI tab；原材料、权限取消、听写 IPC 与草稿重启断言实际通过 |
| `tests/desktop/research-switcher.spec.ts` | 默认启动时资源 main 必须可见 | 已获授权改等实际“当前会话”，适配完整聊天覆盖资源区；名称仍聚焦且未按 Enter 直接退出保存的原断言实际通过 |

经典工作台及 `tests/desktop/helpers.ts` 仍可用于专门验证旧面板路径；不应把所有新界面测试切回经典模式来绕过连续工作区验收。

除明确记载已迁移和执行的项目外，以上为静态入口审计，未声称所有旧脚本已经重跑通过。新增独立验收已经走真实新界面。

2026-10-23 补记：`drawing-question.spec.ts` 已按上表迁移（左侧列表选会话，不再关闭右面板），原断言全部保留；会话 A 预置为白板讨论（`anchor`），以配合新的问 Agent 归属规则（见[会话归属](../../agent-native-evolution/conversation-redesign/conversation-model.md)）。新增单卡片一键进入用例，实际运行 6/6 通过。`continuous-workspace.spec.ts` 新增侧边聊天拖宽用例，10/10 通过。
