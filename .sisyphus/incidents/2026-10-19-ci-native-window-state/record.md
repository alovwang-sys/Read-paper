# 全屏验收中的窗口生命周期与恢复基线

2026-10-19，基线 `ca68e9d`，PR #15 合入门禁。root_cause: `test-native-window-state-and-lifecycle`。本项目首次锚定该签名，全局次数未知。只处理隔离桌面测试，不修改产品窗口行为、安装文件或用户研究。

## 故障基线

CI [39144499831](https://github.com/alovwang-sys/Read-paper/actions/runs/39144499831) 中 Linux Checks 全部通过，Intel Mac 桌面 14/14 通过；ARM Mac 与 Windows 桌面均为 13/14 通过，唯一失败是 `tests/desktop/fullscreen.spec.ts`。

```text
macOS ARM: expect(restoredFrame).toMatchObject(...)
Expected normal: true
Received normal: false
fullScreen: false, closable: true, minimizable: true, fullScreenable: true
Windows: electronApplication.evaluate: TypeError: Object has been destroyed
at tests/desktop/fullscreen.spec.ts:65:23
13 passed, 1 failed
Process completed with exit code 1.
```

原始失败日志分别在任务 [117728238169](https://github.com/alovwang-sys/Read-paper/actions/runs/39144499831/job/117728238169)、[117728238308](https://github.com/alovwang-sys/Read-paper/actions/runs/39144499831/job/117728238308)。ARM 失败产物保留为 artifact `12142997010`。独立验收先用未改测试在本机重复三次全部通过；这不是本机已复现 CI 的证据。

可控对照随后在隔离包中先最大化窗口，实测进入前 `normal:false / maximized:true / minimized:false / fullScreen:false`。产品退出全屏后正确保留最大化，旧断言却以同样的 `normal:false` 签名失败，exit 1（3.8s）。本机原始日志 `/tmp/papertrail-fullscreen-maximized-red-20261019.log`。这证明旧断言拒绝合法恢复状态，不能反推原 CI 在进入前一定已经最大化。

## 核对与最小修复

测试关闭设置窗后没有等待原生 `closed`，又扫描所有窗口读取 `webContents` 寻找主窗口，会接触正在销毁的对象。采用 Playwright 为工作台页面提供的明确主窗口句柄，等待设置窗实际关闭后继续，不扫描无关窗口。

恢复检查原本在退出事件后立即读取一次窗口，并假定进入前一定 `normal:true`。改为记录进入前原生普通／最大化／最小化状态，等待实际退出全屏并精确恢复该基线。原本普通窗口仍要求恢复普通窗口；保留原生框架、可关闭／最小化、快捷键事件和草稿检查。基线与恢复状态写入合成审计，避免 CI 失败后没有状态依据。不使用固定 sleep 或删减断言。

## 验收与退路

用例增加“默认窗口”和“显式最大化窗口”两个起点，桌面完整集从 14 项增为 15 项。修复后本机命令 `npx playwright test --config playwright.desktop.config.ts tests/desktop/fullscreen.spec.ts --repeat-each=3 --output /tmp/papertrail-fullscreen-green-20261019` exit 0：`6 passed (30.2s)`；`npx tsc --noEmit` exit 0。

[六次原生审计](local-audit.json)中，默认三次进入前与恢复后均 `normal:true / maximized:false`，显式最大化三次均 `normal:false / maximized:true`；原生框架高度差均为 32，快捷键 enter/leave 事件均为 1/1，未发送模型请求、无页面错误。Windows 的销毁对象签名本机未复现，仍须远端实测；最终三平台完整门禁以 PR #15 修复提交的 CI 为准，全部通过前不合入。

回退此测试修复即可返回 `ca68e9d` 的测试，不涉及数据或运行文件。再次失败时先根据审计检查进入前状态、原生退出事件及窗口句柄生命周期，不能仅允许任意状态或跳过失败平台。
