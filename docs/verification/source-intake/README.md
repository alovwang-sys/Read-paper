# 来源收录验收

2026-10-17，分支 `codex/source-intake`，基于 `origin/main` 的 `8ab3d76`。需求与实现说明见[从 AI 推荐收录研究资料](../../source-intake/README.md)。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 254 项通过，20 个测试文件 |
| `npm run test:server` | 197 项通过 |
| `npm run test:desktop` | 20 项通过 |
| `npm run build` | 通过 |
| 浏览器完整回归 | 91 项通过，含本轮 6 项用户路径 |
| `npm run desktop:make` | macOS arm64 DMG 与 ZIP 构建通过 |
| `npm run test:desktop:e2e` | 最终新包 10 项全部通过（1.3 分钟），含来源收录和重启恢复 |

浏览器使用临时 Playwright 配置，将现有配置的 baseURL 指向本工作树独立 Vite 服务 `http://127.0.0.1:5184`，测试目录、单 worker、视口与项目配置保持一致。完整运行用时 3.6 分钟。新增用例由真实 UI 发送问题，模拟 AI 流式回答与来源接口；PDF 是有效样例字节，实际通过解析、资产保存和画布渲染。

## 用户路径和截图

- 可预览后再加入，也可直接在回答中加入；仅预览不创建文献，不扩大 AI 上下文。验证主区返回、未发送输入保留与 1440×900、1280×800、1024×800 的布局。[1440](source-preview-1440.png) · [1280](source-preview-1280.png) · [1024](source-preview-1024.png)
- 收录回执在持久化成功之后出现，后台取得全文不抢占主区；刷新后仍可本地阅读。[自动获取后阅读](source-readable-1280.png)
- PDF 404、返回登录 HTML 和元数据不可访问时，记录仍在；原摘要及其来源与 AI 推荐说明分别保存。[暂无全文](source-no-fulltext-1440.png) · [保留摘要与发现记录](source-abstract-retained-1440.png)
- 在同一条目手动补充全文，保留文献 ID、研究关联和发现记录。[补齐后窄屏阅读](source-supplemented-1024.png)
- 跨研究复用同一文献，收录备注和发现记录分别保存；迟到元数据不覆盖手改字段，迟到 PDF 不替换手动补入的文件。
- 刷新中断后保留资料，可重试；存储失败不返回成功回执、不开始全文下载。合并保留研究关联、发现记录和不同来源的原摘要。

本轮截图均检查无横向溢出。浏览器完整回归还覆盖既有主区 PDF 与右侧卡片、白板与原文、文稿与 AI、研究切换、返回和刷新恢复。独立浏览器验证细节见[过程记录](verification-notes.md)。

桌面验证运行实际打包应用，使用隔离用户目录。来源接口提供精确 fixture，并阻止模型请求；实际检查 `papertrail://app/pdfjs/wasm/jbig2.wasm` 的状态、MIME 和 WASM 标记，随后走真实 PDF 解析、IndexedDB、关闭与重启。重启后文献 ID、文件 hash、原摘要、研究备注和本地阅读均保留。[桌面截图](desktop-source-1440.png)。二进制接口转发另由桌面协议单测覆盖。

验收另发现并修复既有桌面退出缺口：超时的助手探测、能力读取与原生历史查询会取消应用拥有的任务；退出在工作区保存确认之后等待本机服务清理，并与模型设置切换排好顺序。新增失败基线与回归测试见[退出事件记录](../../../.sisyphus/incidents/2026-10-17-desktop-owned-process-shutdown/record.md)。测试临时目录统一使用有界删除重试，业务断言保持完整。

## 真实公网冒烟

通过实际本机来源处理器和浏览器 UI 输入 DOI `10.1371/journal.pone.0000308`，从收录到本地阅读完整通过；没有模拟来源解析或 PDF 下载。

- Crossref 返回标题 `Sharing Detailed Research Data Is Associated with Increased Citation Rate` 与书目信息。
- 实际取得 PLOS 的 91,408 字节 PDF，解析为 5 页。
- 本地资产 SHA-256：`b52ca44dfd09d240543b80315f0cd43fe9ba7946f2b5650d5580213ed5d9186c`。
- PDF 页面实际渲染，打包解码器加载成功，无解码器警告；文献信息与本研究备注可查看并保存。
- [真实 PDF 阅读](live-public-pdf-1440.png) · [文献信息](live-public-info-1440.png)。原 PDF 不提交到仓库。

另以真实 arXiv `1706.03762v7` 验证元数据：标题、作者、年份和原摘要读取成功，版本保留在来源地址；当次 PDF 请求超时，因此该项只记录元数据成功。网络状态与出版社访问策略会变化，不能据此保证所有文献都能下载。

## 验证边界

本轮没有使用付费模型，AI 回答展示采用确定性响应；来源收录不需要模型密钥。未声称 Agent 自动检索、自动批量收录或任意外部浏览器一键导入已实现。macOS Intel、Windows 安装包与对应运行验证由 PR 的 CI 矩阵继续执行，本地没有冒充这些平台已通过。
