# Codex 原生连续对话验收

日期：2026-10-19。基线为 `v0.1.7` / `40d9d98`，工作分支 `codex/native-conversation-runtime`。当前为 0.1.8 候选版，尚未正式发布，不代表已有 v0.1.7 安装包包含这些改动。设计与恢复边界见[原生连续对话](../../agents/native-continuity.md)。

## 实现范围

- Codex 产品对话固定原生 threadId，跨轮复用受管理的 App Server client；占用时明确拒绝，不再自动 fork。
- 服务持久化运行意图、snapshot、seq、文字/item、交互、补充及终态；HTTP 断流和页面刷新重新观察原运行，不重复提交。
- 运行中可“补充本轮”，绑定 expectedTurnId 和稳定 inputId；停止先请求原生中断，收到确认才完成，接收/停止未知时保留核对状态。
- 增量问题与材料、请求关联代替嵌套历史；有序活动、完成正文校正、引用状态分离、历史分页和同 turn 补充去重。
- 原文小窗可沿用研究当前选择的 Codex，继续到右侧保留同一会话；等待答复及下一问草稿按现有持久化路径保留。

当前仍使用用户已安装并登录的 Codex 0.162.1；没有将 Codex 二进制加入安装包，没有独立账号授权界面，也没有复制用户凭据目录。HTTP/UI 没有开放手动压缩；下述真实压缩直接调用运行时能力。

## 真实模型探针

开发机独立真实探针使用生产 `createAgentHandler` 与 `createCodexRuntime`，独立临时研究目录、服务映射和 HTTP 端口。运行于 2026-10-19 07:59:20–08:01:37 UTC（北京时间 15:59:20–16:01:37），结果 `success: true`。

该探针使用本机已有授权，未修改用户 Codex 配置、移动既有原生日志或连接用户已运行的 daemon。问题为测试口令，不使用真实论文或用户资料。

三轮原生 threadId 均为 `01a1532c-1f9f-7273-81d4-2e82fde387c0`：

| 步骤 | 原生 turnId | 实际结果 |
| --- | --- | --- |
| round-1：要求记住测试口令 | `01a1532c-221e-7d61-9880-edc065dcb740` | 回答“已记住”；收到首个 delta 后主动取消 HTTP reader，经 observe 恢复完成，未重发问题 |
| round-2：仅询问此前口令 | `01a1532d-efc9-7dc1-93dd-3d60d6385558` | 回答“海盐松鼠731”，线程保持，turn 与首轮不同 |
| 直接调用 runtime.control compact | 原生压缩在同一线程执行 | 收到 progress、session、contextCompaction 开始/结束、progress，等待原生完成后继续 |
| round-3：压缩后再询问口令 | `01a1532e-21fe-7031-b7b4-e0c3789ace37` | 仍回答“海盐松鼠731”，线程保持 |

已保存[脱敏真实结果](real-probe.json)，只包含时间、版本、测试线程/回合身份、合成口令结果和验证边界；不含临时绝对路径、用户环境或账号信息。原始日志由开发机保留，不作为安装包内容。

首轮原始事件摘录说明观察恢复：

```text
snapshot seq=0 state=running
session seq=2 hasTurn=true
delta seq=5
（HTTP reader 断开，再调用 observe）
snapshot seq=9 state=running hasTurn=true
done seq=13 hasTurn=true
snapshot seq=13 state=completed hasTurn=true
```

这证明一次真实 HTTP 断流恢复、三轮同线程续聊和一次手动压缩后的记忆保持。**未触发模型上下文阈值引起的自动压缩，未实测真实 steer、停止、审批或跨客户端交接，不能用该探针代替这些项目。**

## 确定性检查

独立运行时检查命令：

```sh
node --test server/codex-managed.test.mjs server/codex-desktop.test.mjs server/codex-project.test.mjs
```

独立运行时轮次记录 42 项通过。覆盖 20 轮同 client/thread、跨会话并发与绑定隔离、逐轮交互回调、停止确认与未确认、发送确认丢失、clientUserMessageId、item 顺序和 final_answer 校正、合法无文字完成、计划/用量/压缩事件、steer/compact、空闲回收后同线程恢复及历史分页。确定性协议替身不代表真实模型行为全部通过。

服务集成专项在 `server/managed-runs.test.mjs`，覆盖观察断开、相同请求幂等、身份隔离、无整轮固定超时、等待交互恢复、未知运行对账、永久回执、坏状态文件、补充接收未知不重发及截断历史不覆盖完整回答。界面专项在 `tests/e2e/native-continuity.spec.ts`，覆盖断流恢复、同线程下一轮、补充/拒绝保草稿、等待用户时刷新、工具顺序、压缩和停止状态，以及小窗继续到右侧。完整集成检查结果由主集成轮次补录，不沿用旧版本数字。

最终本机检查：`npm run check`、`npm test`（338 项）、`npm run test:server`（264 项）、`npm run test:desktop`（27 项）及 `npm run desktop:make` 通过。最新 macOS ARM 安装产物的 `npm run test:desktop:e2e` 整轮 16 项通过，生产协议确实将 observe/control 转发到本机服务，关键服务模块的包内字节与源码匹配。

浏览器全量最近一轮共 174 项，172 项通过、2 项旧测试时序失败：一个在请求真正完成前就检查无停止按钮，另一个在预览滚动位置尚未持久化前捕获取消前状态。已增加对真实完成和滚动保存的等待；引用布局三尺寸各重复 3 次（9 项）通过，补全文取消同例重复 3 次通过，原有完整状态不变断言保留。原生连续会话 4 项和旧恢复 6 项均在最近整轮通过。这里区分整轮结果与修复后的专项结果，不声称最后本机全量一次通过。

[本机验证及安装包校验](validation.json)记录上述范围。未测试 Intel／Windows 真实 Codex，也未进行这些平台的人工安装验收。

## 三尺寸界面证据

以下为真实工作台页面配确定性 HTTP 原生响应替身，展示中央 PDF 与右侧 Codex 等待用户答复。刷新后问题答复草稿、下一问草稿和原生运行身份保持；图片不是模型真实推理截图。三种尺寸及小窗图片均已实际打开核查；待答复选项、提交按钮和内部滚动已按可点击路径验证。

| 尺寸 | 证据 |
| --- | --- |
| 1440×900 | [等待答复并恢复](waiting-restored-1440.png) |
| 1280×800 | [等待答复并恢复](waiting-restored-1280.png) |
| 1024×800 | [等待答复并恢复](waiting-restored-1024.png) |

另见[原文小窗工具与提问](inline-managed-1440.png)、同线程续聊 [1440](same-thread-1440.png)／[1280](same-thread-1280.png)／[1024](same-thread-1024.png)。这些图片只证明对应界面状态，不代表真实模型推理。

## 已知边界与后续

- 运行时捆绑仅做只读可行性核验。官方锁版本分平台包和校验来源存在，但本轮未加入依赖或资源，没有完成配套第三方声明、三平台签名和安装验收。
- 原生自动压缩事件已接入，自动阈值压缩尚未实测。手动压缩目前只在 runtime 层，服务控制入口明确拒绝，不存在可点击按钮。
- 页面刷新可重新观察；真正退出应用仍走停止并保存。没有新增系统常驻服务，不承诺退出后继续生成。
- 原生进程或本机服务意外退出时不能承诺运行继续。可信原生终态可以恢复，未知状态保留核对限制；不靠重新发送问题恢复。
- 外部 writer 占用、旧线程动态工具声明、历史显示容量与附件缺失按实际原生能力处理。完整历史、完整原生数据库备份和模型当前有效上下文不是同一概念。
- 独立 Codex 桌面列表和双向交接、Windows/Intel 真实 Codex 调用、跨设备原生身份恢复、长时使用与完整客户端菜单仍未由本轮探针验证。
- Claude Code、OpenCode、模型直连和独立卡片整理任务不因 Codex managed 聊天通过而自动获得相同交互与恢复能力。
