# Agent 开发与 GitHub 合并流程

本项目采用轻量 GitHub Flow：一个可交付功能对应一个短期分支和一个 PR，`main` 保持可运行。不设长期 `develop` 分支，也不把每个 agent 的临时任务都变成独立 PR。

## 开始开发

1. 读取 `AGENTS.md`、产品规划和当前批次，检查已有改动和远程主分支。
2. 从最新 `origin/main` 创建描述功能的分支，如 `codex/ai-reading`。一个用户目标可以包含多个小提交。
3. 多 agent 有共享文件时，由集成负责人维护契约和依赖，执行者按文件所有权协作。需要同时运行独立 Git 分支时使用不同 worktree，避免在共享目录互相切换分支。

## 提交与 PR

1. 只提交当前功能的代码、测试、配置模板和文档，检查暂存清单与密钥。`.env.local`、真实 PDF/私人材料和本地运行产物不上传；本项目自制测试资料可随测试提交。
2. 运行实际已有命令：`npm run check`、`npm test`、`npm run test:server`、`npm run build`；涉及用户路径时运行 `npm run test:e2e`。真实模型冒烟和确定性测试分开记录，不让普通 CI 依赖付费模型或真实凭据。
3. 推送功能分支，以 `main` 为目标开 PR。标题描述最终行为，正文写清问题、结果、验证、截图位置和已知边界。未完成时使用 Draft。
4. 独立 agent 可做代码复核；它的结论是辅助证据，不冒充 GitHub 上的人工批准。修复实际阻断问题，更新 PR。

## 合并与收尾

1. 确认 PR 头提交与已验证版本一致，没有冲突，仓库要求的检查或评审已满足。已有保护规则不能绕过。
2. 当前任务明确授权合并后，默认 **Squash and merge**，让 `main` 中一个提交对应一个完整功能。仅要求实现、尚未授权合并时交付 PR。
3. 合并后 fetch，切回本地 `main`，仅快进到 `origin/main`；核对内容、提交和干净状态。
4. 已合并分支不继续开发。确认没有其他 PR 或 worktree 使用后，删除远程功能分支；本地分支在确认全部内容已合入后清理。下一项任务重新从最新 `main` 开分支。

Squash 后新提交的编号与开发分支不同是正常行为。不能仅凭“祖先关系未合并”就认为文件丢失，也不能因此直接强推主分支；应核对 PR 的合并状态及合入内容。

## 当前仓库的边界

目前没有 GitHub Actions CI。本轮合并依赖已执行的本地检查、浏览器验收和 PR 记录，不把空检查列表当成 CI 成功。

后续适合增加一个只读权限的 PR CI，执行上述确定性检查，再考虑把它设为主分支必需检查。主分支保护和自动合并属于仓库设置，需单独配置；本次不擅自更改。

参考：[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)、[PR 合并方式](https://docs.github.com/en/pull-requests/reference/pull-request-merges)。
