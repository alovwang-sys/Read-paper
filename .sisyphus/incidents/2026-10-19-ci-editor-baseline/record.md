# CI 中的编辑器恢复基线不完整

2026-10-19，基线 `f2cfa78`，PR #15 合入验收。root_cause: `test-baseline-before-editor-flush`。本项目首次锚定该签名，全局次数未知。

## 故障基线

GitHub Actions [39143355806](https://github.com/alovwang-sys/Read-paper/actions/runs/39143355806) 的 Checks 任务失败，浏览器测试 155/158 通过。唯一错误签名为 `workspace-split.spec.ts / 三窗格布局保持结构 / unexpected new view state draft:draft-a:title.selectionDirection`，在 1440、1280、1024 三个尺寸出现。类型、单元、服务端、桌面边界、发布检查及构建步骤已通过；后续桌面打包矩阵因依赖失败而跳过。

失败输出：

```text
Error: unexpected new view state draft:draft-a:title.selectionDirection
Expected: true
Received: false
155 passed
3 failed
Process completed with exit code 1.
```

## 根因与最小修复

测试在标题未获得焦点、尚未完成保存时抓取布局基线。放大操作随后刷新全部编辑器，把平台实际返回的原生选区方向补入状态；Linux 返回的 `forward` 不符合测试仅允许新增零／`none` 默认值的约定。独立审查确认现有证据不表明正文、光标或布局丢失。

只在该三尺寸用例中真实聚焦标题，随后填写正文并切到 AI，让原有 blur 保存标题状态；等待保存后再抓取基线。既有状态仍严格深比较，页码、缩放、布局、正文和选区起止及方向的检查均保留。未修改产品代码，也未放宽默认方向白名单。

## 验证与退路

本机受影响用例：`npx playwright test --config=/tmp/read-paper-merge-focused.playwright.config.ts --grep=三窗格布局`，exit 0：`3 passed (9.5s)`。完整浏览器回归另行执行；远端 Linux 与三平台桌面验收结果以 PR #15 当前提交的 CI 为准，合入前须全部通过。

回退此测试修复可恢复到 `f2cfa78` 的用例；不涉及数据迁移、运行文件或已安装应用。若相同错误再次出现，先检查基线是否已经包含实际 DOM 选区，不能通过允许任意新增方向规避。
