# 知识链路验收记录

日期：2026-10-17。本轮实现对应 [KR01–KR10](../../knowledge-flow/requirements.md) 和 [KF0–KF6](../../knowledge-flow/development-plan.md)。测试材料均为项目自制 PDF。分支为 `codex/knowledge-flow`，继承规划提交 `69679f5`；没有发布或调用外部模型。

## 实际实现

- 研究内左栏、研究主页、中央首标签及资源标签、独立资料库会话；1024px 导航抽屉可通过键盘操作并返回焦点。
- 统一添加入口接收本地标识、标题、资料库匹配、多 PDF 和窗口拖放；无全文条目保留稳定 ID，补 PDF 后沿用关联与白板摆放。hash 冲突先展示合并内容，取消不改变关联；标识冲突拒绝合并，避免覆盖。
- 研究内摘录、H/C、撤销、文本高亮、区域摘录、略读/读完、一次读完提示；摘录分组、多选、随手记、不需要/恢复及其他研究摘录。
- 所选摘录可写人工卡片或生成独立 AI 草稿；演示请求只使用明确选择的材料，确认入库幂等，来源显示摘录快照。
- 找依据可从列表或 PDF 选区附加摘录；主页推导四类结论问题；补引用仅插入编号；正文预览与来源编号打开出处链，再回到主区正确 PDF 页。
- schema 3 迁移、旧 v1/v2 恢复缓冲、无全文 ZIP 备份与恢复、研究隔离和失败后的恢复。迁移前副本保存在 IndexedDB `workspace/before-schema-3`，未知或损坏版本不覆盖旧数据。

## 命令与结果

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 15 个测试文件，202 项通过（含安装升级新增 2 项筛选回归） |
| `npm run test:server` | 138 项通过 |
| `npm run test:desktop` | 16 项通过 |
| `npm run build` | 通过；现有大 bundle 提示仍存在，未新增依赖 |
| `npx playwright test --workers=2 --output=test-results-knowledge-final --reporter=line` | 79 项通过，约 1.9 分钟 |
| `npx playwright test tests/e2e/knowledge-trace.spec.ts --grep '阅读器直接补依据' --output=test-results-knowledge-trace-screenshot --reporter=line` | 1/1 通过；等待 PDF 完成后截图 |
| `npm run desktop:package` | 本机 darwin-arm64 应用目录打包通过 |
| `npm run test:desktop:e2e -- --output=test-results-knowledge-desktop-final --reporter=line` | 最终源码打包后 7/7 通过，约 1.1 分钟 |

浏览器 79 项包含本轮 14 项知识链路用例及原有 65 项回归。三个新增文件为 [资料入口](../../../tests/e2e/knowledge-flow.spec.ts)、[阅读与摘录](../../../tests/e2e/knowledge-excerpts.spec.ts)、[找依据与出处链](../../../tests/e2e/knowledge-trace.spec.ts)。单元测试集中于 [迁移](../../../tests/unit/migrations.test.ts)、[备份](../../../tests/unit/backup.test.ts)、[知识链路服务](../../../tests/unit/knowledge-flow.test.ts)、[PDF](../../../tests/unit/pdf.test.ts)、[AI 草稿](../../../tests/unit/ai-reading.test.ts)及[引用导出](../../../tests/unit/export.test.ts)。

桌面回归覆盖独立打包应用、三种双栏组合、模型设置边界、关闭大草稿、保存失败、生成中退出、恢复、原生权限、目录和会话。最终桌面轮 Codex 能力接口返回 502，验证了不可用分支；此前一轮曾返回 200 和 8 个模型，两轮均未发送真实模型请求。测试使用隔离的临时用户目录，截图与 JSON 存入各用例输出目录，未覆盖历史验收材料。

## KV01–KV16 对照

| 验证 | 证据与结果 |
| --- | --- |
| KV01 入口归位 | 旧 65 项用例已适配研究内入口、资料库和中央标签；资料库可筛选未加入研究 |
| KV02 会话隔离 | 标签、页面、阅读位置、面板、找依据及出处链按研究恢复；服务单测、旧持久化与新 trace 用例通过 |
| KV03 研究主页 | 问题保存、接着上次、空研究、四类问题及无问题文案；原工作台与新 trace 用例通过 |
| KV04 标识和复用 | DOI/arXiv/URL 规范化去重、标题条目、跨研究复用同一实体；单元及资料 E2E 通过 |
| KV05 多文件 | 重复文件复用、有效文件保留、坏文件逐项报错及窗口拖放目标；PDF 单元与资料 E2E 通过 |
| KV06 就地补全文 | ID、白板摆放、研究关联不变，刷新可阅读；单元与资料 E2E 通过 |
| KV07 合并 | 冲突前不写资产，预览/取消/确认；关联、打开项、历史、固定与最近资源转移；异常摘录或标识冲突拒绝；单元及 E2E 通过 |
| KV08 阅读状态 | 略读/读完及分组、位置保留、读完提示仅一次、最近阅读记录；摘录 E2E 通过 |
| KV09 摘录 | H、撤销、重复复用、刷新高亮；扫描/文本提取失败与区域路径；新增及旧 E2E 通过 |
| KV10 整理 | 两条摘录写人工卡片、多张卡片复用、随手记、不需要/恢复、其他研究展开；摘录 E2E 通过 |
| KV11 AI 起草 | 只发送所选摘录、迟到响应归原研究、拒绝范围外引用、演示草稿确认幂等；单元及 E2E 通过；真实模型本轮未验证 |
| KV12 找依据 | 列表附加、去资料阅读后选区附加、去重与待核查、切面板/切研究/刷新保留；trace E2E 通过 |
| KV13 出处链 | 四类问题、代码/数学不误判、补引用不改原正文、正文编号预览、正确 PDF 页及高亮、无效编号不写坏面板状态；单元及 trace E2E 通过 |
| KV14 迁移与备份 | schema 1/2→3、实体与引用保留、旧会话映射、来源研究推断、幂等、stub 与新卡片映射 ZIP 往返；单元及备份 E2E 通过 |
| KV15 布局 | 1440×900、1280×800、1024×800；三种工作区组合，无文档横向溢出，1024 主区/右栏并列且抽屉焦点可返回；截图及几何断言通过 |
| KV16 保存恢复 | 摘录与阅读器补依据在写入失败后切面板/切研究/刷新恢复；原未保存卡片与 AI 输入回归通过；补 PDF 资产写入失败重试及合并失败原子性由服务单元覆盖 |

## 本产品截图

以下均来自实际应用，不是参考图或原型。

| 场景 | 1440×900 | 1280×800 | 1024×800 |
| --- | --- | --- | --- |
| 研究资料 | [资料](sources-1440.png) | [资料](sources-1280.png) | [资料](sources-1024.png) |
| 主 PDF＋右卡片 | [阅读与卡片](pdf-card-1440.png) | [阅读与卡片](pdf-card-1280.png) | [阅读与卡片](pdf-card-1024.png) |
| 主白板＋右原文 | [白板与原文](board-source-1440.png) | [白板与原文](board-source-1280.png) | [白板与原文](board-source-1024.png) |
| 主文稿＋右 AI | [文稿与 AI](draft-ai-1440.png) | [文稿与 AI](draft-ai-1280.png) | [文稿与 AI](draft-ai-1024.png) |

关键行为另有 [添加资料](add-source-1440.png)、[无全文](no-fulltext-1440.png)、[合并预览](merge-preview-1440.png)、[批量失败](batch-import-error-1440.png)、[阅读摘录](reader-excerpt-1440.png)、[摘录 AI 草稿](excerpts-ai-draft-1440.png)、[找依据](find-evidence-1440.png)和[出处链回原文](trace-source-1440.png)。图片已实际打开目视检查；1024 下 PDF 与右面板继续并列。

## 范围与限制

- 本轮 AI 起草验证使用明确的演示模式及确定性服务测试，未调用真实模型，未验证新的供应商能力。
- 标识只在本地规范化；联网补元数据、自动下载 PDF、AI 推荐资料、OCR 保持后续范围。
- 旧文稿只有 `cardSources` 记录过的卡片能恢复卡片使用记录；原先未记录的纯论文卡片插入无法补造映射，原证据引用仍保留。
- 主页的结论检查为同步纯函数，使用保存的来源元数据；物理资产缺失由阅读器、AI 发送和完整备份读取时检查，并保留摘录及错误提示。
- 本机实际打包与应用回归为 macOS Apple 芯片；本轮没有运行 Windows/Intel 安装器、签名、公证或升级验收，没有推送分支、创建 PR 或发布版本。
- 历史测试自动生成的旧截图已恢复，本轮证据只保存在本目录；测试日志及临时产物未加入提交。


## 本机安装与升级（2026-10-17）

用户要求移除旧安装并使用新版后，已执行 `npm run desktop:make`，从生成的 `out/make/dmg/arm64/Papertrail-0.1.1-macos-arm64.dmg` 只读挂载并复制应用至 `/Applications/Papertrail.app`。旧应用在正常退出、确认保存后移入废纸篓；用户资料目录未删除，升级前另在 `~/Library/Application Support/Papertrail-upgrade-backups/` 保留本机副本。

实际旧库的导航历史暴露一个筛选迁移问题：当前在卡片库、历史中访问过收件箱时，会错误带入“未加入研究”筛选。已把筛选映射限制到当前活动入口，新增原筛选为 undefined / all 的两项回归。修复后全量单元 202/202，通过构建及 DMG/ZIP 生成；安装该最终包后，原研究、三张卡片、PDF 原件和摘录均在真实应用内确认可用，状态显示已保存。此前完整的 79 项浏览器、7 项打包桌面结果仍为上一节所列运行；这处纯迁移补丁没有重复整套 E2E。

最终安装包与 `/Applications` 中 `app.asar` 的 SHA-256 一致：`e59e87fb7658abb8855a90168c1ef7a1b15776428a34c7d30be0c54bfbf726d5`。版本号仍为 0.1.1，不能只凭“关于”版本号区分本次内容更新。应用保留与旧包相同的本地 ad-hoc 签名状态，未配置发行者签名或公证；未修改 Gatekeeper 或系统安全设置。

[实际安装后运行画面](installed-upgrade-macos.png)包含新的研究内导航、原 PDF 与已保存摘录。应用保留打开状态供用户继续使用。
