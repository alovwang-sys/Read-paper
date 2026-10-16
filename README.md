# Papertrail / Read-paper

单用户论文研究工作台：研究问题 → PDF → 原文证据 → 观点卡片 → 白板论证 → 带引用的结论。

首版使用 React、TypeScript、Vite、PDF.js。应用和 PDF 保存在浏览器的 IndexedDB；编辑与工作区会话同时保留 localStorage 恢复缓冲。人工阅读可独立运行；真实 AI 通过本机 Node 服务调用供应商，密钥不进入浏览器。示例材料全部为自制测试 PDF，不能作为真实研究成果。

桌面版采用 Electron / Electron Forge，共用同一工作台。支持 macOS Apple 芯片、macOS Intel、Windows x64 安装产物；桌面应用自动运行本地 AI 服务，无需用户安装 Node.js。当前构建为未签名预览版，尚未配置开发者签名、公证和自动更新。安装与发布约定见 [桌面分发](docs/desktop-distribution.md)。

## 桌面运行与打包

开发与构建环境使用 Node.js 24、npm；先运行 `npm ci`。

```sh
npm run desktop:dev        # 构建并打开本机桌面应用
npm run desktop:package    # 生成本机应用目录 out/Papertrail-<platform>-<arch>/
npm run test:desktop       # 桌面服务、协议、密钥保存边界
npm run test:desktop:e2e   # 启动上一步生成的真实应用并验证保存/恢复
npm run desktop:make       # 生成本机安装产物 out/make/
```

macOS 生成 DMG 与 ZIP；Windows 生成 Setup.exe 及配套 Squirrel 文件。PR/main 的 GitHub Actions 运行检查及三目标构建，临时 artifacts 保留 14 天。推荐发行入口是仓库 **Actions → Desktop release draft → Run workflow**：选择 `main`，输入与 `package.json.version` 一致的标签（当前为 `v0.1.1`）。标签不存在时，工作流将其固定到本次启动的 main 提交；已有标签不移动，仍可重跑原版本。全部检查与三目标打包应用 E2E 通过后生成带 `SHA256SUMS` 的 **Draft + Pre-release**。草稿尚不公开；获授权的维护者或 agent 核对附件及实际验证记录后，可保留 Pre-release 标记发布公开技术预览，用户从 Releases 下载。预览说明可列出未完成的 Windows / Intel 安装器人工验收和未签名状态；全平台安装、升级及签名验收是稳定版门槛。完整网页步骤、命令行 tag 方式和四层验证见 [桌面分发](docs/desktop-distribution.md)。

桌面版从“文件 → 模型连接…”或设置中的“配置模型连接”填写自己的 API 地址、模型和密钥。密钥由 Electron `safeStorage` 经系统加密后保存在固定用户数据目录 `Papertrail/ai-settings.json`，不会读取或打包工程 `.env.local`，也不返回给工作台页面。保存连接会停止旧连接上的生成；没有配置密钥时仍可人工阅读或选择演示模式。

桌面资料使用固定 `papertrail://app` 来源与持久用户目录：macOS 为 `~/Library/Application Support/Papertrail`，Windows 为 `%APPDATA%/Papertrail`。升级或更换安装位置不清空该目录。关闭窗口与退出前会停止生成并等待最新修改保存；保存失败时保留窗口供重试。

浏览器与桌面资料互相独立。迁移时打开“存储与设置 → 工作区备份与恢复”，导出完整 ZIP，再在目标设备导入、查看统计并确认替换。备份含原 PDF、区域图片和全部工作区资料，不含密钥；恢复前原资料与资产在同一数据库事务中保留一份副本。仅接受应用直接导出的原始 ZIP32，勿重新压缩；总内容最多 256 MiB、单项最多 64 MiB。备份不是跨设备自动同步。

## 运行

需要 Node.js 22.13+ 或 24+、npm。

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:5173 。首次启动含两个研究和三份示例材料，可直接阅读，也可新建研究并导入自己的 PDF。

真实 AI 另开终端运行 `npm run ai`。首次配置将 `.env.example` 复制为 `.env.local`，在本机填写 `AI_API_KEY`；该文件已被 Git 忽略，建议权限设为 `600`。默认使用智谱 `glm-5.3-flash` 的 Chat Completions 接口，供应商地址、模型和图片能力都在服务端配置。修改配置后重启 AI 服务。图片能力须确认模型实际支持后设置 `AI_IMAGES=true`。

AI 服务仅监听 `127.0.0.1:8787`；Vite 开发和 preview 将 `/api/ai` 代理到本机服务。使用其他前端端口时同步设置 `AI_APP_PORT`。生产静态托管需要同路径的受认证后端。没有配置时可在 AI 面板明确选择演示模式；不会自动退回演示或自动重试付费请求。

```sh
npm run check          # TypeScript 检查
npm test               # 迁移、AI 状态与草稿、引用导出、PDF 等单元测试
npm run test:server    # 流式协议、权限、取消、超时、容量与并发
npm run build          # 检查并构建 dist/
npm run preview        # 预览构建
npx playwright install chromium
npm run test:e2e       # 真正的 Chromium 用户路径测试
npm run fixtures      # 重建字节稳定的合法自制样例
```

## 本机 AI 助手

启动 `npm run dev` 与 `npm run ai`，在 AI 面板输入区的“切换 AI 助手”查看 Codex、Claude Code、OpenCode。使用各 CLI 自己的本机登录与订阅，页面不接收或保存 CLI 密钥；本机运行不代表离线推理。每段对话绑定助手，切换恢复各自输入、历史与材料，运行中的回答仍归原研究。原始回答、工具进度和确认后的知识卡片可分别回查。

OpenCode 默认继承本机配置中的模型或 TUI 最近选择的模型，确定后显式传给 `run`，避免非交互运行自行改选免费模型。`OPENCODE_MODEL=供应商/模型` 仅为可选覆盖；通常无需重复填写。平台只读取模型及 provider 连接配置，不继承工具、MCP 或 agents 设置，不改写用户全局配置；本地模型、环境凭据和自定义 provider 不会因 `auth list` 缺少人类可读标签而被阻断，认证与额度以实际请求结果确认。

本轮本机助手接收明确选择的文字证据，不自动发送整个资料库；区域图片仍使用已有图像模型直连。Codex 输入区支持 `/` 操作、`$` 搜索本机技能、模型与 Chat/Plan 选择，原生提问和审批在聊天中答复。两行工具栏提供“＋”添加研究材料、实际可用的推理档位、只读／完全访问选择、麦克风及圆形发送／停止。默认只读；完全访问须明确确认，可修改项目外文件并联网，仅影响此对话后续请求，不改全局设置。麦克风目前提供系统听写入口，尚无内置录音转写。本轮原生 diff 可查看脱敏节选，不代表整个 Git 工作树。控件与能力验证见[输入区验收](docs/verification/native-composer/README.md)。未接入的外部工具依赖仍显示限制，Claude/OpenCode 未开放工具。移除材料不清除旧原生历史，缩小范围、不含历史或重试时开启新 session。中央资源标签可固定、关闭和排序，引用复用论文标签并保留右侧回答。程序版本、配置、状态存放位置、真实冒烟与限制见 [验收记录](docs/verification/agents/README.md) 和 [运行时记录](docs/verification/agents/runtime-notes.md)，设计见 [助手设计](docs/agents/design.md)。

TikHub 已接入：本机安装启用 `tikhub` 技能并保留其 `scripts/tikhub.py`，具备 Python 3 与技能规定的本机凭据后，可在 Codex 技能菜单选择 `$tikhub`。菜单顶部“刷新 Codex 能力”可重新检测。通过原生动态工具发现工具、获取输入结构及发起数据调用，实际数据调用在聊天中授权，可能消耗 TikHub 额度；无需另外安装 npm MCP 客户端或修改全局配置。未接入的其他 MCP 依赖仍显示限制。

## 研究目录与原生对话

第一版已接入研究目录绑定、原生记录发现/读取及显式同 ID 续接通路：

1. 启动前端与本机 AI 服务，打开研究，点击左侧项目名称旁的“…”进入“项目设置”。名称下拉仍用于切换研究。
2. 浏览已有本机目录或输入绝对路径；预览项目名称后点击“使用这个目录”。项目使用真实文件夹名称，完整路径与连接状态保留在设置中。取消不改名、不创建项目关联，也不清空问题。
3. 打开 AI，选择助手并点击“新对话”。旧临时目录的阅读会话保留只读，不自动迁移。
4. 点击“对话记录”查找当前研究的原生记录，可按助手筛选；点击整行只读历史，确认可续接后再发送。用“刷新”或“刷新记录”读取原生端新增内容，不会重复调用模型。外部导入内容可转为人工卡片草稿，不提供原范围重试或重新生成。

研究目录下 `.read-paper` 保存项目标识、请求与材料快照，以及实际读取到的原生历史可读归档。厂商原生客户端继续保存自己的会话日志；论文、区域图片、卡片和结论仍在 IndexedDB。桌面版关联索引固定保存在应用资料目录的 `agents/`；网页本机服务使用 `AI_AGENT_STATE_DIR`，未设置时沿用临时目录，建议配置稳定位置以防系统清理。已有“工作区备份与恢复”ZIP 包含 PDF、图片和聊天显示缓存；它不包含服务端关联索引或厂商原生数据库，不能保证换电脑后继续相同原生身份。复制 `.read-paper` 也不能替代完整工作区备份。

Codex 已实测目录创建、发现、读取及排他 writer 锁；生产短问答约 85 秒未出现可见回答后主动停止，尚未完成真实回复闭环或确认 Desktop 项目列表。OpenCode 已实测创建、发现及用户消息读取，真实回复未完成；Claude Code 本机未认证。外部 OpenCode/Claude Code 占用未知时只读；Codex 可凭已验证的原生 writer 锁尝试原子续接。已知忙碌禁发，停止无法确认则保持只读并允许明确新建对话。完整能力、运行版本、测试与截图见[项目会话验收记录](docs/verification/project-sessions/README.md)。

## 使用

- 左栏上部浏览全局资料；下部切换研究、打开资源。相同资源复用打开项，支持固定与关闭。`⌘K` / `Ctrl+K` 搜索，`Esc` 关闭弹层。
- PDF 支持目录、全文搜索、翻页与缩放。拖选文字后可解释、提问、加入当前对话或人工创建卡片；区域模式可框选图表、公式和扫描内容，预览截图后再加入。框选仅截取当前页，不进行 OCR。来源保存文档 hash、从 0 开始的页索引、摘录或区域坐标与图片资产；PDF 页码与印刷页码分开。
- AI 以消息流连续对话，支持 Markdown、代码、表格和公式，停止、原范围重试、最新轮重新生成、会话历史和归档恢复。显式显示本轮材料及历史范围，改变选区不会自动发送。
- 从完整回答整条、按段或拖选知识点，AI 整理为独立草稿。可以手动编辑或让 AI 修订，先预览再采用，可撤销一次采用；确认后才加入卡片。原始问答保留，卡片可分别回查论文依据、原问题、原回答、所选片段及整理/修订记录。
- 白板添加已有卡片和论文，支持拖动、Shift 多选、分组、连线、缩放与平移。卡片单击在右侧编辑，PDF 双击进入主阅读器。`Enter` 打开，方向键移动，`Delete` 移出。移出只删除摆放实例，可单步撤销。
- 结论稿插入卡片观点与结构化来源。正文 `[n]` 对应来源清单，跨卡片/AI 插入会重新编号。Markdown 导出包含研究问题、结论、文献信息、PDF 页码、摘录及插入卡片时的相关对话快照；不包含原 PDF、区域图片或完整聊天。
- 右栏切换证据、参考、信息、AI；可收起、拖动或用方向键调整宽度。右侧打开资源保留主区；转到主区时保留来源页。研究分别恢复打开项、阅读位置、白板视口、面板及上下文，全局资料使用独立会话。

## 数据与边界

PDF 按 SHA-256 去重，支持最大 50 MB、1–2000 页；加密文件需先解密。相同文件可修复缺失资产，并保留原来的文档与证据 ID；不同内容始终建立新资产。扫描件可阅读及区域问答；OCR、复杂表格与公式的专门语义提取仍后置。

自动保存显示 `dirty / saving / saved / error`。保存失败保留编辑缓冲并允许重试；存储读取失败会阻止编辑，避免用示例覆盖原数据。若浏览器同时拒绝 IndexedDB 和恢复缓冲写入，需保持页面打开直到保存成功。清除站点数据或更换浏览器会丢失本地资料，Markdown 导出不是整个数据库备份。

AI 请求绑定提交时的研究、会话、材料和历史快照；迟到响应仍回到原研究。代码检查来源版本、引用 ID 和正文编号，但不判断模型结论是否正确，卡片默认待核查。每次最多 16 条 / 24,000 字材料、80,000 字历史、4 张区域图；服务另限总输入 120,000 字、两路并发和 120 秒超时。缩小范围或另开会话后可继续。

业务数据升级为 schema 2；旧数据先留迁移副本，既有文件、卡片、布局和未发送输入保留。旧演示回答标为 legacy，不伪装成原始模型记录；刷新中的生成标为中断。完整问答仍采用单个 IndexedDB 工作区记录，流式输出合并并周期检查点保存；大记录不再进入恢复缓冲，关闭前应等待“已保存”。

白板仅保留当前浏览器进程中的单步移出撤销，刷新后不保留撤销历史。首版为桌面单用户；无多人同步、分享发布或产品内多 agent 编排。

## 设计与验证

[产品规划](docs/product-plan.md) · [开发清单](docs/agent-backlog.md) · [端到端验收记录](docs/verification/README.md)

协作与合并约定见 [Agent / GitHub 开发流程](docs/development-workflow.md)。

2026-10-16 AI 阅读：[文档入口](docs/ai-reading/README.md) · [产品需求](docs/ai-reading/requirements.md) · [UX 设计](docs/ai-reading/ux-design.md) · [开发计划](docs/ai-reading/development-plan.md) · [交互原型](docs/ai-reading/prototype.html)。设计原型保留为评审基线；真实实现、模型冒烟、测试与截图见 [AI 阅读验收记录](docs/verification/ai-reading/README.md)。

1440×900 与 1280×800 使用三栏布局；1024px 折叠导航并保留中央原文与右侧 AI 并列，低于 1024px 才使用覆盖抽屉。AI 来源点击在中央定位，右侧回答、输入及草稿保留。AI 使用桌面对话布局，完整回答与可展开工具活动分开显示；未安装运行组件时提供官方安装说明。

测试截图保存在 `docs/verification/screenshots/`，实际下载的 Markdown 样例在 `docs/verification/e2e-research-note.md`。官方参考图仅用于结构研究，不作实现证据或产品资产。
