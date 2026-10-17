# Windows 打包测试缺少明确的 Documents 测试目录

日期：2026-10-17，Asia/Shanghai。代码基线：本地 `5a3ec805eaf25bb12e7a1bb73b945314138efe8d`，远端 PR #14 `e13c820b2f7c93b844ba0cd5c445e70393ffb543`，文件树相同。root_cause：`test_environment`（默认位置依赖为当前诊断，Windows 修复后 CI 待主 agent 复核）。

## 范围与接手快照

任务：保留失败基线 → 检查 artifact 与调用链 → 本机受控探针 → 最小 fixture 修复 → 目标验证 → 交回主 agent 重跑三平台。仅修改 `tests/desktop/research-directory.spec.ts`、本记录及本项目 PMB，不修改生产代码、共享接口、依赖、工作流，不提交或写远端。

接手时工作区没有 tracked 修改；已有大量 `test-results-*` 未跟踪目录均保留。没有本子任务创建且仍运行的后台任务需要停止；不停止用户、主 agent 或其他 agent 的进程。

2026-10-17 现场调用链快照：

```text
调用方                         共享状态 / 依赖                         最后改动锚点
research-directory fixture     空 HOME / USERPROFILE、独立 userData     5a3ec80 / 本子任务
CreateResearchDialog.defaults  getDirectoryDefaults 返回 parent         5a3ec80 / 主 agent 保持不动
research-directory service     desktop.getProjectLocation 原生 IPC       5a3ec80 / 主 agent 保持不动
desktop main                   app.getPath('documents')                 5a3ec80 / 主 agent 保持不动
主 agent                       PR、CI、main 合并与发行                    本次派工消息
```

## 故障基线

[CI run 39005130066](https://github.com/alovwang-sys/Read-paper/actions/runs/39005130066)，Windows job `117317109418`，执行 `npm run test:desktop:e2e`，exit 1：9 条中 8 条通过，新增目录创建测试在第一次调用目录选择器前失败。两种 Mac 的同次 CI 通过。原始输出尾部不超过 30 行保存在 [failure-baseline.log](failure-baseline.log)。

```text
Error: expect(locator).toBeEnabled() failed
Locator: getByRole('dialog', { name: '新建研究', exact: true }).getByRole('button', { name: '创建并关联', exact: true })
Expected: enabled
Received: disabled
Timeout: 15000ms
at openNew (tests\\desktop\\research-directory.spec.ts:82:76)
1 failed
8 passed (1.3m)
Process completed with exit code 1.
```

已下载并检查 [失败 artifact 12090676999](https://github.com/alovwang-sys/Read-paper/actions/runs/39005130066/artifacts/12090676999)，ZIP SHA-256 为 `d33ef838912d0e8d383d6190612ad2fd6aa63c61affc46259966316e50062e4b`；本机临时副本 `/tmp/papertrail-windows-directory-failure.zip`。`error-context.md` 只有禁用按钮的局部快照，`trace.zip` 只有测试 API 操作轨迹，没有完整 DOM 快照或 IPC 拒绝文本。Windows 原始 `getPath` 错误不能从这些材料确认。

同一原始测试在本机 macOS arm64 未修改时：

```text
npx playwright test --config playwright.desktop.config.ts tests/desktop/research-directory.spec.ts --grep '原生目录' --output /tmp/papertrail-directory-baseline --reporter=list
exit 0
1 passed (7.2s)
```

本机无法执行 Windows 二进制，未声称复现 Windows 系统 API 的原始错误。

## 诊断与最小修复

原 fixture 创建空 `isolated-home` 并设置 `USERPROFILE`，却依赖宿主系统的 Documents 路径。表单在原生 `app.getPath('documents')` 返回前不能创建；路径读取失败时会保留表单并允许用户更换位置，提交保持禁用。测试在更换位置前要求按钮可用，因此隐含要求该系统默认路径能正常解析。

本机对打包应用做受控探针：仅让主进程 `getPath('documents')` 抛错，实际原生 IPC 与生产表单照常运行，得到：

```text
MISSING_DOCUMENTS_ALERT 暂时未能关联目录
Error invoking remote method 'papertrail:project-location': Error: Failed to get documents path (controlled unavailable Documents)
MISSING_DOCUMENTS_BUTTON_DISABLED true
```

该探针确认缺少默认位置会产生同类禁用状态，不证明 Windows 原始异常文本。探针后续通用 DOM 选择器等待超时，未将该步计作修复验证；探针自己的应用和临时目录均已关闭清理。正式验证以下面的目标测试为准。

修复在 fixture 内创建 `isolated-home/Documents`，并通过 Electron `app.setPath('documents', ...)` 明确设置测试应用的 Documents。新增真实 preload → IPC 返回路径断言，原有按钮启用、原生选择取消、无残留、目录一致、文件同步、外部冲突与重启恢复断言全部保留。没有增加超时、删测试或放宽断言；未改生产默认位置或写入用户 Documents。

## 修复后的实际验证

```text
npx playwright test --config playwright.desktop.config.ts tests/desktop/research-directory.spec.ts --output /tmp/papertrail-directory-fixture-fixed --reporter=list
exit 0
✓ 打包桌面：原生目录选择取消无残留，创建后左右沿用同一目录且重启恢复 (6.1s)
✓ 打包桌面：真实PDF与卡片写入研究目录，UI修改同步，外部编辑冲突保护并可恢复退出 (6.5s)
2 passed (13.0s)

npm run check
exit 0
> tsc --noEmit

git diff --check
exit 0
```

使用现有 macOS arm64 打包应用；该修复只有测试 fixture，不改变应用二进制。目标截图与产物留在 `/tmp/papertrail-directory-fixture-fixed`。Windows、Mac x64 与完整 CI 由主 agent 在新 PR head 上执行，未在此记录中冒充已通过。

## 退路与后续

- 代码退路：撤销本记录所列 fixture 增量即可回到 `5a3ec80` 的测试；不重置工作区或其他 agent 修改。
- 数据损失：无。只使用测试独立目录，关闭后清理；用户及历史验收目录保留。
- 复燃条件：新 head 的 Windows 仍有同一签名时，须收集完整对话框和 `getProjectLocation` 返回/拒绝诊断，重新判断；不以重跑或增大等待代替定位。

本项目现有 incident 记录中 `test_environment` 类本次登记 1 条，全局次数未知。本地 `.sisyphus/PMB.md` 已补一条经验；没有可用的全局 PMB / `record_batch`，未虚构全局写入或历史分类。
