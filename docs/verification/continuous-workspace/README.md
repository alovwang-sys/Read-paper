# 连续工作区实施验收

范围：真实资源页中的会话、同一会话换位置、PDF 文字及区域选区操作、局部活动记录、文章简要、旧绘图与资料收录保留。

本目录使用合成研究、项目自制 PDF 与受控流式服务响应。浏览器与桌面均隔离测试资料，桌面另隔离 HOME、各 CLI 设置目录和模型环境变量；不会读取用户论文、模型密钥或原生会话历史。固定响应只能验证链路、状态归属、持久化和界面，不能验证真实模型的理解质量。

## 测试入口

- 浏览器：`npx playwright test tests/e2e/continuous-workspace.spec.ts`
- 打包桌面：`npm run test:desktop:e2e -- tests/desktop/continuous-workspace.spec.ts`，需先由集成人确认已构建当前版本。
- 共用受控 fixture：[harness.ts](harness.ts)。原生 PDF 字形选择、Excalidraw 编辑和本地持久化不使用假组件。

## 当前实际结果

2026-10-23，真实生产页面浏览器新增用例 **9/9 通过**，无跳过、无重试后通过、无页面运行错误或未授权模型接口请求；整轮耗时约 30 秒。详细运行记录：[browser-final-run.log](browser-final-run.log)，结构化摘要：[browser-results.json](browser-results.json)。`npm run check` 在 0.1.15 同轮通过；fixture 监测 Vite 热更新并断言为零，最终截图未混入热更新。

| 路径 | 已验证内容 |
| --- | --- |
| 资源旁问答 | PDF 保持原位；发送立即清空输入，回答直接出现在当前侧栏；左侧每条会话不超过 44px，切换保留 PDF 与各自草稿，刷新恢复 |
| 会话换位置 | 同一会话在侧边、浮窗、完整显示之间移动，仅一份输入，ID 与历史不复制；原资源分屏树及草稿保持，刷新仍恢复 |
| 导航无死入口 | 完整聊天后再次打开当前白板列表，列表实际可见；关闭聊天后围绕当前白板追问，侧栏输入重新出现 |
| 卡片与摘录浮窗 | 原文旁编辑共享卡片正文、按本篇筛选摘录、定位原文自动关闭浮窗；PDF 与聊天草稿保持，修改跨刷新保留 |
| 助手和输入 | 同一会话从 Codex 切至文字助手，保留既有研究回答、草稿及图片；不支持的附件阻止提交，移除须手动；听写说明明确文字留草稿、不自动发送 |
| 文字选区 | 实际拖选 PDF 字形，提问、翻译、摘要卡片三入口；翻译与摘要独立任务，摘要可编辑存卡，原位操作记录跨刷新找回 |
| 文章简要 | 同篇两个不同原文位置创建独立会话和证据，共用同一简要 key/v1；真实提取自制 PDF 3/3 页，只产生一次简要请求；简要没有原文 context 或会话历史，进入局部问题时是 background 材料，引用仍只有所选原文 |
| 区域选区 | 实际拖动框选并生成局部 PNG；请求只带该区域证据和图片，框选几何范围保持；关闭后从区域标记找回，刷新保留 |
| 旧能力 | 原生 Excalidraw 创建矩形与箭头，绘图资产跨刷新保持；受控 OpenAlex 题录收录至真实资料实体并关联当前研究，刷新后保持 |

1440×900、1280×800、1024×800 实测无横向溢出，聊天输入和发送可达，局部问答不会越出窗口。

产品截图（均为本产品真实界面及合成资料）：

- 资源与侧栏：[1440](screenshots/resource-chat-1440.png)、[1280](screenshots/resource-chat-1280.png)、[1024](screenshots/resource-chat-1024.png)。
- [卡片编辑浮窗](screenshots/card-editor-over-source-1440.png)、[切助手保留历史与图片](screenshots/assistant-switch-retains-image-and-history.png)。
- [同一会话浮窗与分屏](screenshots/same-conversation-floating-1440.png)、[原文翻译](screenshots/translation-on-source-1440.png)、[独立位置与共享简要](screenshots/shared-brief-independent-source-questions.png)。
- 区域问答：[1440](screenshots/region-question-1440.png)、[1280](screenshots/region-question-1280.png)、[1024](screenshots/region-question-1024.png)。
- [保留 Excalidraw 与聊天](screenshots/existing-drawing-and-chat-1440.png)。

既有关键回归共 **9 个不同用例通过**：系统听写、三格式原图与字节、失败重试及新附件草稿、粘贴拖入和限制、H 摘录撤销与复用及刷新高亮、阅读状态、未知存储版本保护、未发送 AI 草稿、研究与分屏隔离。其中 H 摘录旧脚本首次在不可点击的高亮装饰层失败；获授权后仅改为真实字形坐标点击、展开更多操作，保留所有业务断言，单独重跑通过。见 [摘要](legacy-critical-results.json)、[初轮日志](legacy-critical-run.log)、[修正后日志](legacy-highlight-rerun.log)。

## 打包桌面与本机安装

最终 **0.1.15 arm64** 打包应用新增桌面用例 **2/2 通过**（约 12 秒），覆盖原文旁直接看回答、同一会话换位置、三尺寸与草稿／历史正常退出恢复，以及实际 PDF 字形选区翻译、摘要存卡和原位活动跨重启恢复。确认固定 origin、临时用户目录、包版本、渲染进程无 Node require、正常退出码 0；未授权模型请求和页面错误均为零。日志：[desktop-final-run.log](desktop-final-run.log)，摘要：[desktop-results.json](desktop-results.json)。

额外既有桌面关键用例共 **3 个不同用例最终通过**：研究切换键盘与三尺寸；聚焦研究名称未按 Enter 直接退出保存；经典原生输入控件、权限取消、材料、听写 IPC 与草稿重启。初轮后两项因旧 helper 的主区可见假设／面板展开条件失败；经授权仅迁移等待和入口，全部原业务断言保留，二次运行 2/2 通过（约 10 秒），无需修改运行时。见 [结果](desktop-legacy-results.json)、[初轮](desktop-legacy-run.log)、[修正后](desktop-legacy-rerun.log)。其他旧入口迁移见 [existing-tests.md](existing-tests.md)；本轮未声称全量旧 UI 脚本重跑通过。

桌面截图：[1440](screenshots/desktop-resource-chat-1440.png)、[1280](screenshots/desktop-resource-chat-1280.png)、[1024](screenshots/desktop-resource-chat-1024.png)、[重启后的会话](screenshots/desktop-restarted-conversation.png)、[重启后原位摘要](screenshots/desktop-source-activity-after-restart.png)。

集成人同轮验证：业务单测 **761 项 / 48 文件**、服务 **355 项**、桌面边界单测 **27 项**通过。构建校验和见 [build.json](build.json)，额外 Claude Code 只读审查及处理见 [审查记录](review/disposition.md)。

本机 Papertrail 已替换并实际打开 0.1.15，资料保留和用户私密备份状态见 [本机安装结果](local-install.md)。安装由集成人执行，自动测试始终只操作临时资料。未发布远端 Release；未配置发行者签名／公证，真实模型质量本轮未重测。

本目录不包含真实用户安装备份或本机资料截图；真实研究截图与备份清单不提交仓库。
