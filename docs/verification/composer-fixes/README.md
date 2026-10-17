# 对话提交修复与图片能力核查

日期：2026-10-17。分支 `codex/source-intake`，随来源收录 PR #15 交付。

## 行为

- 移除 `submitAI` 在供应商选择前设置的 4,000 字上限，各助手共用修复。服务器原有总输入 120,000 字符、请求体容量及供应商上下文限制保留；卡片修订要求的独立限制不变。
- 资产与研究目录前置检查完成后，问题与输入清空在同一次状态更新中保存。响应结束不再清一次输入，用户可以在生成时起草下一条。
- 前置失败保留原输入；已提交请求失败时，仅在本次确实消费输入、当前输入仍为空且工作区未被恢复替换时回填原始文本，包括空白。已有新草稿不会被覆盖。停止保留已发送问题记录；重试和重新生成不消费当前草稿。
- 异步准备期间恢复备份会取消旧请求；切换研究可继续原研究的请求，迟到结果和输入恢复只归原会话。

## 验证

新增单元测试在修复前真实复现：长问题被 4,000 字规则拦截、生成中输入未清空，共三项失败；修复后通过。

- `npm run check`：通过。
- `npm test`：20 文件、260 项通过，包含准备期间编辑、备份恢复、重复问题草稿与失败恢复。
- 浏览器专项 `tests/e2e/composer-submission.spec.ts`：14 项通过。使用本地确定性流式 HTTP fixture，核对 Codex 和模型直连的长问题请求全文、生成挂起、网络中断、研究切换与刷新恢复。
- `npm run test:e2e`：完整浏览器回归 105 项通过，包含上述专项和来源收录路径。
- 新打包桌面专项 `tests/desktop/composer-submission.spec.ts`：1 项通过；`papertrail://app/` 下 6,908 字中文完整到达请求。隔离用户数据和助手目录，验证挂起清空、成功保留下一条、下一条失败恢复与重启保留，页面异常为 0。见 [机器记录](desktop-evidence.json) 与 [桌面截图](desktop-composer.png)。
- 新包其余桌面回归：`npm run test:desktop:e2e -- --grep-invert '长问题完整提交'`，10 项通过；与新专项合计 11 项，覆盖退出、保存失败、目录、来源收录及重启恢复。
- `npm run desktop:make`：macOS arm64 DMG 与 ZIP 构建通过。

独立核验确认 DMG 有效、架构 arm64，挂载包与已测应用的 `app.asar` 相同，101 个运行文件与本次源码及构建文件全部匹配，见[安装包记录](package-evidence.json)。新试用包导出为 `Papertrail-0.1.2-source-intake-fixes-arm64.dmg`，旧下载目录试用包和校验文件移到废纸篓。应用程序目录中的旧版未自动替换；PR 尚未合入 main。

浏览器三尺寸实际截图：[1440×900](composer-1440.png)、[1280×800](composer-1280.png)、[1024×800](composer-1024.png)。主区 PDF 与右侧 AI 并列，1024 左栏折叠，发送后下一条草稿保持可编辑且控件未越界。

## 图片能力

| 通道 | 当前能力 | 核查结果 |
| --- | --- | --- |
| 模型直连 | PDF 区域图片，要求服务图像配置与模型支持 | 客户端读取已校验图片资产并发送 `image_url`；服务端校验 MIME、签名、容量与数量 |
| Codex / Claude Code / OpenCode | 当前不支持 | 界面、客户端及原生服务端明确拒绝区域图片；Codex 的 turn 输入尚未包含图片项 |
| 演示 | 无真实模型请求 | 不能视为图片发送成功 |
| 输入区 | 尚无通用截图粘贴、图片上传、拖入入口 | “＋”目前选择已有研究证据 |

本机 Codex CLI 0.162.1 的 [App Server 协议](https://learn.chatgpt.com/docs/app-server)提供 `image` / `localImage` 输入与模型 `inputModalities`，但本应用尚未接通。实现还需图片字节传输和校验、模型能力判断，以及 PDF 区域入口按当前供应商判断。仅修改能力开关不能完成发图。

本轮图片核查实际运行四组服务器测试，70/70 通过：`node --test server/agents.test.mjs server/codex-desktop.test.mjs server/other-runtimes.test.mjs server/ai.test.mjs`。包含现有不支持图片的拒绝路径。本轮未做真实模型或视觉理解调用，不将确定性 fixture 记为真实助手调用。
