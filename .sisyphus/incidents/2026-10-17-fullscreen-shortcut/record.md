# 原生全屏快捷键验收使用了错误的输入通道

日期：2026-10-17。会诊快照基线 `39b917b`，工作区 `codex/source-intake`；生产修改由主 agent 维护。本次仅新增本记录，未启动用户应用、重跑已有探针或停止其他任务。本项目该测试根因记录 1 次，全局次数未知。`root_cause=verification_transport`。

## 基线与耦合关系

用户反馈原生全屏时找不到退出入口。主 agent 已增加常显“退出全屏”和可信主窗口 IPC；协作 agent 已在真实打包 Electron 44.8.0 中验证进入全屏、全屏刷新及按钮退出。这里会诊的是随后两次快捷键测试超时，不能用这个测试失败替代用户原始故障的根因。

2026-10-17 17:24–17:26（UTC+8）只读快照：

```text
tests/desktop/fullscreen.spec.ts
  → Electron webContents 输入
  → desktop/window-shortcuts.mjs before-input-event
  → BrowserWindow.setFullScreen
  → enter-full-screen / leave-full-screen
  → desktop/main.mjs IPC 状态通知
  → src/shell/DesktopWindowControls.tsx
```

协作 agent `voice_entry_diagnosis` 报告：初始 `page.keyboard.press('Control+Meta+f')` 两次等待原生进入事件超时；窗口和 webContents 均聚焦，`before-input-event` 审计 `inputs=[]`，`entered=0`。未收到输入不能证明 matcher 错误，也不能据此断定用户的物理键盘或原菜单快捷键失效。早期失败终端输出由执行 agent 持有，本会诊未独立复跑、未虚构退出码。

独立读取本机 Playwright 1.64.1 实现：`node_modules/playwright-core/lib/coreBundle.js:37162`、`:37178` 的 Chromium `RawKeyboardImpl.keydown/keyup` 使用 CDP `Input.dispatchKeyEvent`。此实现与上述原生 hook 未被触发的实际审计一致。本结论限定于本轮版本和运行环境。

## 最小修正及实际证据

协作 agent 将测试输入改为 Electron 官方 `webContents.sendInputEvent`，注入带 `control`、`meta` 的 F 按键；保留真实 `enter-full-screen` / `leave-full-screen` 断言。没有手动 emit 原生事件，没有用菜单 click 或直接 `setFullScreen` 冒充快捷键。测试前的直接进入全屏只用于创建退出按钮和刷新恢复场景。

独立读取 2026-10-17 17:24:19 生成的 [原生审计](../../../docs/verification/fullscreen/desktop-fullscreen.json)：

```text
keyboardTransport: Electron webContents.sendInputEvent
focused: true, contentsFocused: true
entered: 1, left: 1, fullScreen: false
inputs: 两个 keyDown，key=f / code=KeyF，control=true / meta=true
isAutoRepeat=false, isComposing=false
restoredFrame: normal=true, closable=true, minimizable=true,
               fullScreenable=true, frameInset=32
actualModelCalls: 0, pageErrors: []
test-results-desktop/.last-run.json: status=passed, failedTests=[]
```

独立查看 [全屏截图](../../../docs/verification/fullscreen/desktop-fullscreen.png)和[退出后截图](../../../docs/verification/fullscreen/desktop-window-restored.png)：全屏顶栏退出按钮清晰可见；退出后按钮消失，未发送草稿仍在。Playwright 页面截图不包含 macOS 原生窗口装饰；框架恢复应引用上面的原生属性，不能把页面截图说成系统红黄绿按钮浮出证据。审计未出现 keyUp 的具体原因未单独验证，不作推断。

## 官方契约与结论边界

- [Electron before-input-event](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event)：位于页面键盘事件之前，`preventDefault` 同时阻止菜单快捷键。当前 matcher 的 keyDown、精确修饰键、排除 IME、阻止长按重复切换及消费菜单处理符合这一契约。
- [Electron sendInputEvent](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent)：要求所属窗口聚焦；审计已验证窗口和内容焦点。
- [Electron setFullScreen](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag)：macOS 转换异步，依赖实际 enter/leave 事件；当前集成测试保留此要求。

本轮证据证明已打包应用的原生输入 hook → 全屏切换 → UI 状态链路，以及退出时草稿和标准窗口属性的保留。未验证用户物理键盘、macOS 菜单栏自动浮出、外接屏差异或 Windows 实机；不修改用户系统设置。

## 退路与防复发

本会诊只新增此记录，删除该记录即可撤回，没有改动生产文件、资料或后台任务。生产回退由主 agent 按实际 diff 处理，保留其他人的修改。

复燃条件：再次把 renderer/CDP 输入当成已覆盖原生菜单和 window hook，或用手工 emit / 直接窗口切换替代快捷键链路。后续验收应同时保留输入审计、原生 enter/leave、最终窗口状态和草稿断言；不能仅凭 UI 按钮出现判定系统标题栏行为。

无可用 PMB 服务，全局事故次数未知；使用本文件保存本地经验，不虚构外部记录。
