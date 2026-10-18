# 桌面退出未等待自有探测进程

日期：2026-10-17。范围：本项目 source-intake 验收中的退出生命周期；项目锚定同类次数未知，全局次数未知。

## 接手快照

分支 `codex/source-intake`，基线 main `8ab3d76`。主 agent 的来源收录实现与其他验收任务持续进行，均保留，不停止其他任务。工作区已有修改由主 agent 集成；本次不提交。

耦合（接手时）：`desktop/main.mjs will-quit` → `desktop/local-ai.mjs stop` → `server/ai.mjs stop` → `server/agents.mjs close`；探测由 `codex/claude/opencode-runtime.mjs` 启动自有进程，原生历史查询由 `projects.mjs nativeQuery` 启动。入口只 void stop，agent close 只取消生成，probe 的 Promise.race 超时不取消真实进程。最后已知修改由主 agent 的工作区派工记录锚定。

## 故障基线

命令与尾部输出见 `baseline.log`。注入真实 OpenCode runtime + 挂起的自有子进程，探测超时 HTTP 已返回；取消信号为空。正式新增测试先红：exit 1。测试只管理自有 fake child，不操作外部共享服务。

## 流水

- 2026-10-17：接收只读调查，新增确定性复现，证实外层超时与底层进程取消脱节。
- 2026-10-17：沿现有调用链补 signal / await，定向与受影响全量检查通过；生产文件冻结交主 agent 重打包。

## 结果

新增确定性测试先红后绿。`npm run test:server` exit 0：197 tests / 197 pass；`npm run test:desktop` exit 0：19 tests / 19 pass；`node --check desktop/main.mjs` exit 0。受影响定向组合 `node --test server/shutdown.test.mjs desktop/local-ai.test.mjs` exit 0：14 tests / 14 pass（增加半包 POST 测试前）；最终 `server/shutdown.test.mjs` 为 8 tests / 8 pass。原来为服务端 189 项、桌面边界 17 项，首轮新增 8 + 2 项；下述 Electron 原生事件轮回归另增 1 项桌面测试。完整安装包与桌面 E2E 由主 agent 统一重建验收，本文不提前声称通过。

生产修复：探测/能力查询拥有 signal、底层任务持续跟踪至结束；超时取消自有 CLI。三种 probe 与 Codex capabilities 接收生命周期取消。研究原生记录查询在 close 时取消并等待读取器。AI stop 等待这些工作及所有在途 handler；生成的 handleAgents finally 仍 await runCompletion。Electron will-quit 先阻止退出，待本机服务 stop 完成再重发 quit；before-quit 的工作区保存确认和取消关闭逻辑保持原状。设置保存服务更换串行完成后才停止最终服务，退出时禁止 activate/设置再建窗。

未增加依赖、未改 forge 白名单（helper 复用已打包的 desktop/local-ai.mjs），未启动或停止任何真实外部共享助手。实际打包关闭、Windows 进程行为和长期共享 daemon 生命周期由相应验收补充。

## 退路

本次修改限于生命周期和对应测试，可按本次文件 diff 撤回；用户与其他 agent 的来源收录代码不变。未丢弃用户数据或既有修改。复燃条件：新自有运行时未传播 signal 或退出未 await 清理。


## 桌面真实退出回归与最小修复

重新打包后的 composer-controls 首例出现 `electronApplication.waitForEvent: Timeout 30000ms exceeded while waiting for event "close"`，业务断言已过。按同一隔离环境的完整路径保留复现副本，`native-quit-baseline.log` 记录 exit 1 与实际日志。原始三份 trace 由验收 agent 另存 `/tmp/papertrail-close-hang-evidence-20261017/`，本次诊断 trace 位于 `/tmp/source-intake-close-diagnostic-results/`。未改 `tests/desktop`，未修改 `out/` 安装产物。

诊断只在本次 owned app 中注入日志：projects.close、agents.close、AI handler.stop 的 allSettled 均已 done，1 秒后无 HTTP Server 或 owned ChildProcess handle；第二次 app.quit 已在 `processTicksAndRejections` 调用，却未再触发 before-quit/will-quit。最后测试自清理 SIGTERM 时 will-quit 不再被阻止，证明 stop 已完成。根因是清理全在微任务中完成，第二次 app.quit 仍处于 Electron 原生取消退出流程退栈期间，被 Electron 忽略（root_cause=async_native_event_reentry）。

修复仅将退出 helper 中的 `quit()` 改为 `setImmediate(quit)`，等待原生事件轮退栈后重发。新增对应单测先红（实际当轮调用 1 次、期望 0），修复后 `npm run test:desktop` exit 0，20 / 20 pass。服务端未再改动，197 / 197 证据仍有效。代码再次冻结，由主 agent 重打包，并使用最终包验证原 composer 单例和完整桌面回归。当前不提前声称这一步通过。

本次只停止两个自有最小诊断宿主 PID 13092、13126（第二个停止时已退出），以及诊断驱动自己创建的测试 app；用户 `/Applications/Papertrail.app` PID 97870 和共享本机助手没有触碰。最小诊断最初因 ESM 顶层 await app.whenReady 导致宿主启动等待，纠正为 void whenReady.then 后该诊断正常运行；这不是产品根因。


## 最终集成验收

主 agent 重新运行 `npm run desktop:make` exit 0，得到包含最终 `setImmediate(quit)` 修复的 macOS arm64 DMG / ZIP。随后实际新包 composer-controls 单例 1/1 通过（8.2 秒），完整 `npm run test:desktop:e2e` exit 0，10/10 通过（1.3 分钟）。关闭、重启后再关闭、来源全文恢复均通过，未出现退出超时或清理失败。最终桌面边界测试为 20/20；服务端为 197/197。Windows 与 macOS Intel 的结果待 PR CI，本地未作已通过声明。
