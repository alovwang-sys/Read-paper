# 真实 Codex 白板 Skill 探针

2026-10-19 执行。结果：**未通过真实生成验收**。本轮共尝试两次真实请求：默认推理设置在 90 秒总预算内没有完成；唯一补充诊断保持本机默认模型选择，仅为本次请求显式设置 `effort=low`，120 秒内仍未完成。两次均已取消，均得到原生会话与回合 ID；没有有效方案，也没有继续重试。

使用生产 `compileAgentPrompt` 和 `createCodexRuntime`，只发送临时合成的三张卡片：输入数据、编码模块、输出结果。保持聊天目的与只读权限，没有选择原生 Skill ID；内置规则由应用附加。生产 `parseBoardPlan`、`previewBoardPlan`、`validateBoardSnapshot` 使用项目已有 TypeScript 编译器转译后直接加载，没有复制校验逻辑。

| 检查 | 结果 |
| --- | --- |
| 本地生产解析与预览自检 | 通过；未请求模型 |
| 真实原生会话与回合 ID | 两次均已返回 |
| 默认设置的第一轮方案 | 90 秒内未完成，已取消 |
| low 推理的单轮诊断 | 120 秒内未完成，已取消 |
| 第二轮同一会话局部修改 | 未运行 |
| 原文件 hash 保持不变 | 两次均通过 |
| 临时合成目录清理 | 已完成 |

未拿到完成输出，因此未验证 commentary 与最终 JSON 是否混合，也没有宽松截取 JSON。不能仅凭两次截止判定是推理延迟或运行时故障。未操作真实用户研究、原生已有会话或独立 Codex 桌面 UI；没有改写用户模型配置。两个合成测试会话由 Codex 原生存储保留。

复跑入口：

```sh
node scripts/verify-board-skill-codex.mjs --self-check
node scripts/verify-board-skill-codex.mjs --run
node scripts/verify-board-skill-codex.mjs --run --single
```

普通 `--run` 最多发起两次真实模型请求，共用 90 秒终止预算，第一轮失败即停止；两轮解析、预览、同一原生会话和原文件不变全部成立才通过。`--single` 为一次显式 `low` 推理诊断，120 秒硬截止，续接检查用 `null` 标示未运行；只验证单轮可用性。

本轮两次预算已用完。每次复跑会覆盖最新报告，首次记录另行保留：

- [首次 90 秒结果](codex-probe-timeout.json)
- [最后一次 120 秒 low 诊断](codex-probe.json)
