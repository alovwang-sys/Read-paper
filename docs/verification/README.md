# 首版实现与端到端验收

日期：2026-10-15（Asia/Shanghai）。分支：`codex/research-workbench`。

本文保留首版基线。2026-10-16 的真实多轮 AI、区域问答、独立卡片草稿与双来源见[最新验收记录](ai-reading/README.md)。下列同名截图会随回归更新，AI 能力以最新记录为准。

2026-10-20 增量：[AI 面板纵向空间](ai-space/README.md)、[白板自由绘图](drawing/README.md)与[左侧导航层级修复](navigation/README.md)。

根据用户再次反馈，[第二轮 AI 空间调整](ai-space-expanded/README.md)将常态消息区提高至视口约 75%–78%，并更新顶部助手切换与单行输入工具。

从原有规划文档建立可运行应用，实际实现采用 React、TypeScript、Vite、PDF.js、IndexedDB 与 localStorage 恢复缓冲。所有功能复用同一工作台、实体数据和导航服务。原官方截图仅作为结构参考，下面截图均来自本产品。

## 批次状态

| 批次 | 实际交付与验证 | 状态 |
| --- | --- | --- |
| T0 | 稳定资源 ID、业务类型、样例、共享校验、单一持久化入口；证据与摆放实例分离 | 已实现并验证 |
| T1 | 三栏宿主、五个集合、研究/全局独立会话、打开/关闭/固定资源、双侧返回、搜索、面板宽度与抽屉、编辑恢复 | 已实现并验证 |
| T2 | 真实 PDF 导入、SHA-256 去重、分页/缩放/目录/全文搜索、阅读恢复、扫描/损坏/原文件缺失/文本提取失败状态 | 已实现并验证 |
| T3 | 真实文本层选区、证据卡片、共享编辑、来源页及摘录定位、按研究关联 | 已实现并验证 |
| T4 | 卡片与文档摆放、移动、多选分组、实例连线及语义说明、移出/单步撤销、查找、缩放/视口恢复、多白板复用 | 已实现并验证 |
| T5 | 结论编辑、插入观点与结构化引用、编号重映射、失效引用拦截、完整 Markdown 导出 | 已实现并验证 |
| T6 | 显式证据、请求快照、提交研究归属、引用范围与版本校验、生成/失败/重试、可编辑草稿、另存卡片、显式追加结论、未发送输入恢复 | 演示适配器已验证；真实模型未接入 |
| T7 | 三份合法样例的导入到导出主线；研究切换/刷新恢复；三种主区与右侧组合；错误和尺寸验收 | 人工主线与模拟 AI 验收通过；真实模型部分未验证 |

## 实际运行结果

| 命令 | 结果 |
| --- | --- |
| `npm run fixtures` | 自制合法 PDF 生成；字节重复性、页数、摘录页索引和扫描无文本核对通过 |
| `npm run check` | TypeScript 通过 |
| `npm test` | 3 个测试文件、26 项通过 |
| `npm run build` | 生产构建通过，包含本地 PDF worker |
| `npx playwright test tests/e2e/workbench.spec.ts --output=test-results/final-workbench` | 7 项通过，37.8 秒 |
| `npx playwright test tests/e2e/persistence.spec.ts --output=test-results/final-persistence` | 5 项通过，9.2 秒 |
| `npm run preview -- --port 4173` | 在应用浏览器实际打开生产版，确认 PDF 第 3 页、文本就绪、主区 PDF 与右侧卡片可同时使用 |

最终覆盖全部 12 个 Chromium E2E 用例。两组测试使用独立输出目录并行运行，避免 trace 文件冲突；失败 trace 默认保存在被忽略的 `test-results/`。常规复现命令为 `npm run test:e2e`。

主要产物 JS 约 751 kB（gzip 229 kB），PDF worker 约 1.26 MB。Vite 给出 500 kB chunk 提示，构建成功；首版尚未进行 bundle 拆分。

### 端到端覆盖

1. 新建研究，导入三篇样例，验证按 hash 复用全局文档。
2. 在真实 PDF 第 3 页的文本层建立 DOM Range（阅读 agent 另外实际用鼠标拖选），创建证据卡片，右侧编辑，主区 PDF 保留。
3. 添加卡片与 PDF 到白板，多选分组、连接并编辑说明，进入专用阅读器、返回白板，在右侧核查来源页。
4. 写结论、插入卡片、实际下载 Markdown，核对核心问题、观点、文献、PDF 第 3 页和摘录。
5. 同一卡片在两个白板同步编辑；移动、视口、缩放刷新恢复；移出一个 placement 不删除卡片或另一个 placement，撤销同时恢复相关连线。
6. 两条证据组成 AI 快照，提交后切研究，迟到响应归原研究；另存编辑卡片、插入已有引用的结论时正确重新编号。
7. 双栏 PDF 真实选区、搜索、缩放、刷新；扫描件无文本；非 PDF 与损坏 PDF 的导入提示；主区/右侧各自返回，来源转到主区保留页码，手动翻页刷新保留新位置。
8. 原文件缺失后重新导入同 hash PDF，阅读器自动恢复，文档/证据身份与元数据保持。
9. 延迟导入后切换研究：关联原研究，当前工作区不会被切回。
10. 保存失败后关闭资源、切研究、切面板、刷新仍能恢复编辑缓冲。不支持的存储版本阻止编辑与写回，保留原数据。
11. 文本提取失败时仍可阅读；AI 请求错误允许重试，结论正文不会被自动覆盖。
12. 未发送的 AI 输入按研究保存；切模式、切研究、刷新后恢复。键盘搜索、弹层关闭与 1024px 导航抽屉可操作。

单元测试另验证：无效来源/页索引、研究关联、上下文范围外引用、来源版本改变、原 PDF 缺失、上下文容量限制、正文引用编号越界、全局资料复用、模型失败和迟到响应。

文本提取异常、保存配额异常和 AI 请求异常采用测试注入产生确定性错误。AI 的成功与失败验证均基于演示适配器或测试适配器，不能视为真实模型或供应商网络验证。

## 截图与导出证据

| 文件 | 场景 |
| --- | --- |
| [00-empty-research-1440x900.png](screenshots/00-empty-research-1440x900.png) | 新建研究的空状态 |
| [01-pdf-card-1440x900.png](screenshots/01-pdf-card-1440x900.png) | 主区 PDF 第 3 页＋右侧证据卡片 |
| [02-board-source-1280x800.png](screenshots/02-board-source-1280x800.png) | 分组、连线白板＋右侧原文页 |
| [03-writing-ai-1440x900.png](screenshots/03-writing-ai-1440x900.png) | 主区结论＋右侧 AI，标题可见 |
| [04-writing-ai-1024x800.png](screenshots/04-writing-ai-1024x800.png) | 1024px 右侧覆盖抽屉 |
| [05-writing-ai-context-1440x900.png](screenshots/05-writing-ai-context-1440x900.png) | 两条上下文、独立卡片草稿与结论引用编号 |
| [06-two-column-selection-1440x900.png](screenshots/06-two-column-selection-1440x900.png) | 双栏 PDF 真实文本层选区 |
| [07-scanned-pdf-1440x900.png](screenshots/07-scanned-pdf-1440x900.png) | 扫描件阅读与无文本层提示 |
| [08-pdf-import-error-1440x900.png](screenshots/08-pdf-import-error-1440x900.png) | 导入错误及重选入口 |
| [09-missing-source-1440x900.png](screenshots/09-missing-source-1440x900.png) | 原文件缺失及修复入口 |
| [10-overview-1440x900.png](screenshots/10-overview-1440x900.png) | 研究概览与完整左栏 |
| [11-library-1280x800.png](screenshots/11-library-1280x800.png) | 全局论文库 |
| [12-left-collapsed-1280x800.png](screenshots/12-left-collapsed-1280x800.png) | 左栏折叠 |
| [13-narrow-navigation-1024x800.png](screenshots/13-narrow-navigation-1024x800.png) | 窄屏导航抽屉 |
| [save-error.png](screenshots/save-error.png) | 保存失败时仍可恢复编辑 |
| [text-extraction-error.png](screenshots/text-extraction-error.png) | 提取失败但阅读就绪 |
| [ai-request-error.png](screenshots/ai-request-error.png) | 请求失败与重试 |

实际下载文件：[e2e-research-note.md](e2e-research-note.md)。样例自制说明与生成脚本见 [public/samples](../../public/samples/README.md) 和 [create-fixtures.mjs](../../scripts/create-fixtures.mjs)。

所有最终 workbench 截图已逐张实际打开检查，无 loading 占位、保存完成；错误截图故意保留相应错误状态。

## 已知边界

- 没有真实模型供应商配置，未接入真实 AI 调用；T6/T7 相关部分仍待完成。
- 本次自动验收使用 Chromium；未做 Safari/Firefox 专门验收。
- 扫描件无 OCR，复杂公式/表格只做 PDF 原样显示。
- 单步移出撤销不跨刷新保留；无完整撤销历史。
- PDF 与数据库保存在此浏览器；Markdown 不带原 PDF，也不是完整资料备份。
- 正文整数 `[n]` 保留为引用标记；模型或用户输入的失效编号会阻止保存为引用草稿或导出。
