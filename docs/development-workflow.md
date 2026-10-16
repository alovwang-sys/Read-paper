# Agent 开发与 GitHub 合并流程

本项目采用轻量 GitHub Flow：一个可交付功能对应一个短期分支和一个 PR，`main` 保持可运行。不设长期 `develop` 分支，也不把每个 agent 的临时任务都变成独立 PR。

## 开始开发

1. 读取 `AGENTS.md`、产品规划和当前批次，检查已有改动和远程主分支。
2. 从最新 `origin/main` 创建描述功能的分支，如 `codex/ai-reading`。一个用户目标可以包含多个小提交。
3. 多 agent 有共享文件时，由集成负责人维护契约和依赖，执行者按文件所有权协作。需要同时运行独立 Git 分支时使用不同 worktree，避免在共享目录互相切换分支。

## 提交与 PR

1. 只提交当前功能的代码、测试、配置模板和文档，检查暂存清单与密钥。`.env.local`、真实 PDF/私人材料和本地运行产物不上传；本项目自制测试资料可随测试提交。
2. 运行实际已有命令：`npm run check`、`npm test`、`npm run test:server`、`npm run test:desktop`、`npm run build`；涉及用户路径时运行 `npm run test:e2e`。修改发布脚本时运行 `node --test .github/scripts/release.test.mjs`；桌面验收先 `npm run desktop:make`，再 `npm run test:desktop:e2e`。真实模型冒烟和确定性测试分开记录，不让普通 CI 依赖付费模型或真实凭据。
3. 推送功能分支，以 `main` 为目标开 PR。标题描述最终行为，正文写清问题、结果、验证、截图位置和已知边界。未完成时使用 Draft。
4. 独立 agent 可做代码复核；它的结论是辅助证据，不冒充 GitHub 上的人工批准。修复实际阻断问题，更新 PR。

## 合并与收尾

1. 确认 PR 头提交与已验证版本一致，没有冲突，仓库要求的检查或评审已满足。已有保护规则不能绕过。
2. 当前任务明确授权合并后，默认 **Squash and merge**，让 `main` 中一个提交对应一个完整功能。仅要求实现、尚未授权合并时交付 PR。
3. 合并后 fetch，切回本地 `main`，仅快进到 `origin/main`；核对内容、提交和干净状态。
4. 已合并分支不继续开发。确认没有其他 PR 或 worktree 使用后，删除远程功能分支；本地分支在确认全部内容已合入后清理。下一项任务重新从最新 `main` 开分支。

Squash 后新提交的编号与开发分支不同是正常行为。不能仅凭“祖先关系未合并”就认为文件丢失，也不能因此直接强推主分支；应核对 PR 的合并状态及合入内容。

## CI、主分支保护与版本发布

仓库已提供 `.github/workflows/ci.yml`：PR 与 `main` 提交运行类型检查、单测、服务测试、桌面边界与发布保护测试、构建、浏览器 E2E，再在 macOS arm64、macOS Intel x64、Windows x64 分别构建安装包并运行打包应用冒烟。成功产物保留 14 天；是否通过以 GitHub 上对应提交的实际 run 为准。完整矩阵汇总为 `Required checks`。

工作流默认只读，不依赖真实模型密钥和代码签名凭据。第三方 Action 使用经过官方仓库核对的完整 SHA；Dependabot 每周以 PR 提交 npm / Actions 更新，不自动合并。`.github/pull_request_template.md` 提供轻量交付清单。

首次 CI 真正通过后，建议维护者在 GitHub 的 main ruleset 中要求 PR 和实际显示的 `Required checks` 状态，禁止 force push 与删除主分支。单维护者无需强制“另一人批准”，也无需引入长期 `develop`、`mac`、`windows` 分支。仓库保护和自动合并属于远程设置，本次没有代为启用；不要在检查尚未出现时配置错误名称锁住维护者。

发行版本使用 `v<package.json.version>` tag，指向已合入 `main` 的提交。`.github/workflows/release.yml` 重验来源并对固定 SHA 重跑全部 CI，三个平台全部成功后才由单个 job 建立一个带 `SHA256SUMS` 的 Draft + Pre-release。已发布版本不覆盖，工作流不自动正式发布。目前是 unsigned 预览构建，签名、公证与安装器人工验收仍需处理。具体命令、artifact 下载、签名边界与安装清单见[桌面分发说明](desktop-distribution.md)。

本次代码实现没有远程推送 tag、发布 Release、自动 merge 或修改仓库保护设置。之后的正式发布应在完整安装验收后单独授权执行。

参考：[GitHub Flow](https://docs.github.com/en/get-started/using-github/github-flow)、[PR 合并方式](https://docs.github.com/en/pull-requests/reference/pull-request-merges)。
