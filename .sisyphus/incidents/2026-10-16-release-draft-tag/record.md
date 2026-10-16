# 发行草稿在元数据更新后失去版本关联

日期：2026-10-16，Asia/Shanghai。基线：`8ea47a2403fa8fb4d96bfcb8a3631ddd3a985c11`。root_cause：`api_contract`。

## 任务与故障基线

任务清单：保留失败基线 → 对照官方实现定位原因 → 失败回归 → 最小修复 → 相关测试与交接。仅修改发行脚本、测试及本事件记录 / PMB；不切分支、不提交、不发布、不移动 Git tag。

2026-10-16T10:27:55Z 工作区快照：分支 `codex/release-draft-tag`，初始 `git status --short --branch` 仅输出该分支，diff / stash 均为空。没有本任务创建或有权停止的后台任务。并行 agent 只读查证官方行为；主 agent 管理发行工作流、文档和远程草稿。

```text
调用方                   共享状态 / 耦合                           最后改动锚点
release.yml verify      固定版本 tag 与应用 source SHA              8ea47a2 / 主 agent
release.yml build       按 source SHA 检查、三平台构建与打包应用 E2E  8ea47a2
release.yml draft       prepare → updateDraft；同次 run 的附件        8ea47a2 / 本次脚本修复
updateDraft             Git ref、Release ID/tag/body、附件/digest     8ea47a2 / 本次脚本修复
主 agent                workflow checkout 与既有草稿恢复关联         本次任务交接消息
```

主 agent 提供并复核的真实失败证据：[run 38886368616](https://github.com/alovwang-sys/Read-paper/actions/runs/38886368616)，汇总 job `116927309103`。前置检查和三平台构建 / 打包应用 E2E 均成功，汇总输出 `Prepared 8 release assets` 后失败：

```text
Release is no longer the expected draft
+ 'untagged-9e1df116753ed65036b0'
- 'v0.1.0'
```

草稿 ID `414825955`，名称 `Papertrail v0.1.0 — unsigned preview`，`draft=true`、`prerelease=true`、`target_commitish` 与正文 Source commit 都为基线 SHA，附件为空。Git tag `v0.1.0` 始终指向基线 SHA；这不是 Git tag 被移动。

本地原始测试：

```text
node --test .github/scripts/release.test.mjs
exit 0
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## 定位与失败回归

官方 `gh release edit` [源码](https://github.com/cli/cli/blob/3d7967df5a94052b0554898ffa02526f0f90b8c9/pkg/cmd/release/edit/edit.go#L110-L113) 明确说明：PATCH 不提供 `tag_name` 会移除 Release 的当前 tag，因此主动携带旧值。[上游 draft 请求测试](https://github.com/cli/cli/blob/3d7967df5a94052b0554898ffa02526f0f90b8c9/pkg/cmd/release/edit/edit_test.go#L354-L365) 也要求发送 `tag_name`。这是官方客户端的防御行为与 mock 证据，并非本任务额外创建远程草稿做的服务端实验。

原脚本调用顺序为：POST 创建带版本的草稿 → GET 并通过严格 tag 断言 → PATCH 元数据但省略 `tag_name` → 首次附件上传前 GET 失败。该顺序及空附件与真实失败吻合。原测试把 PATCH 当作普通对象合并，遗漏了平台对缺省字段的处理。

仅增强测试、生产脚本未改时，模拟该官方记录的行为：

```text
node --test --test-name-pattern='a single draft preserves its tag' .github/scripts/release.test.mjs
exit 1
ℹ tests 1
ℹ pass 0
ℹ fail 1
AssertionError [ERR_ASSERTION]: Release is no longer the expected draft
+ 'untagged-9e1df116753ed65036b0'
- 'v0.1.0'
```

新增孤立草稿防重复回归在修复前也 exit 1：旧代码未找到版本标签后发出 POST，随后才因 `untagged` 断言失败；新要求是在写入前停止，提示恢复已有草稿关联。

## 修复与验证

本次子任务已完成本地修复和验证；真实发行重跑由主 agent 接续。

| 文件 | 最小变更 |
| --- | --- |
| `.github/scripts/release.mjs` | PATCH 元数据始终携带已核对的 `tag_name`；发现同版本工具标题但标签不符的草稿时，任何写入前报错，避免重复创建 |
| `.github/scripts/release.test.mjs` | 原完整上传测试模拟缺少 `tag_name` 就清除关联的 API 行为；新增孤立草稿零写入回归 |
| 本记录及 `.sisyphus/PMB.md` | 保留官方依据、失败 / 成功基线与重试边界 |

严格的草稿 tag 断言保持原样，未把 `untagged-*` 视作有效版本。已发布 Release 不写入、运行中人工发布立即停止、远程 tag 固定来源 SHA、来源标记、准确附件集合、大小及 SHA-256 校验均保留。孤立草稿的名称仅用于阻止写入，不能用来接管或自动重绑草稿。

```text
node --test .github/scripts/release.test.mjs
exit 0
✔ an already published release is never mutated
✔ a detached draft for the requested version blocks duplicate creation
✔ a single draft preserves its tag through metadata updates and is never automatically published
✔ manual publication while the job is running stops further writes
✔ tag movement, a draft from another commit and stale assets cause no writes
✔ staged checksums must still match the exact prepared files
✔ uploaded digests and the final asset set must match local staging
ℹ tests 15
ℹ pass 15
ℹ fail 0

node --check .github/scripts/release.mjs
exit 0（无诊断输出）
node --check .github/scripts/release.test.mjs
exit 0（无诊断输出）
git diff --check
exit 0（无诊断输出）
```

上面列出测试输出的相关行，省略每项运行时长；数量包含原有两项 digest / missing 子测试。没有为本修复重新执行应用全量构建、浏览器或三平台 E2E，现有真实 run 的前置成功不能冒充修复后的重新验收。根因归类为第三方 API 缺省字段语义与本地模拟契约不一致；后续 PATCH 继续显式传递 tag，避免把对象合并语义当作平台行为。

工作流耦合也已交接：若 draft job 继续 checkout 应用 tag 的旧 SHA，则即使 main 合入修复，重试旧版本仍运行旧脚本。主 agent 独立将汇总脚本 checkout 固定为本次 `github.workflow_sha`，应用检查 / 构建与 `RELEASE_SHA` 仍用原版本 SHA；本执行 agent 未修改公共工作流或发行文档。

## 退路与边界

代码基线为 `8ea47a2`；本次不改变应用代码、数据 schema 或 Git refs。恢复代码只需撤销本事件对应的脚本 / 测试增量，不覆盖并行 agent 的工作流与文档修改。撤销会重新暴露 PATCH 丢失版本关联的问题。

远程草稿恢复由主 agent 单独执行并复核：在 Chrome 选择现有 `v0.1.0`，保存后 REST 显示同一 ID `414825955`、`tag_name=v0.1.0`、仍为 draft、附件仍为空、source SHA 不变。本执行 agent 未写入远程。

本项目当前 `api_contract` 类事件登记 1 条，全局次数未知；没有全局 PMB 或历史 merge 分类工具，未声称全局去重结果。工作流使用新版脚本重试与真实公开发行由主 agent 后续验收，本记录的本地测试不能替代该结果。
