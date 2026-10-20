# 白板自由绘图验收

本页保留功能分支阶段的验证结论；聊天、绘图和导航截图已在最新 main 回归时重拍，完整集成检查与平台边界见[集成验收](../main-integration/README.md)。

日期：2026-10-20。采用锁定的 `@excalidraw/excalidraw` 0.18.1；[选型与官方来源](../../agents/drawing-canvas-options.md)。本记录只描述实际接入范围，右侧 AI 的空间调整另见[布局验收](../ai-space/README.md)。

后续修复了用户从截图指出的左侧导航缩进与图标问题，浏览器截图已更新，三尺寸及绘图回归见[导航验收](../navigation/README.md)。桌面字体截图保留为此前打包验证的证据。

## 使用与保存

打开研究白板，点击“绘图”，可直接画线、形状、箭头、中文文字或添加图片。现有卡片与 PDF 入口在同一画布中显示；选中资料可在右侧打开卡片或核对原文。点击“卡片布局”返回分组与语义关系编辑。旧白板仍默认打开卡片布局。

卡片正文和论文继续引用共享实体，移动、复制、移出操作使用摆放实例 ID；移出不会删除资料库中的卡片或 PDF。语义关系在绘图中展示并跟随资源位置，自由箭头独立保存。绘图模式的“整理资料关系”只向助手提供授权卡片与论文，不自动发送手绘内容。

绘图事件合并后自动保存到独立、带 SHA-256 的不可变 JSON 资产；资产写入成功才提交白板引用。选择与平移不生成绘图版本。模式和视口按研究恢复；关闭标签、切换研究或模式时继续保存未完成缓冲。失败显示错误并可重试；退出或刷新前应等待“绘图已保存”和全局“已保存”。桌面退出、工作区备份和研究目录同步会等待绘图写入。

绘图历史包含资产引用，支持差异查看、恢复或恢复为副本；副本中的资源摆放重新分配 ID。ZIP 备份包含当前、历史及请求快照引用的场景和内嵌图片，并校验文件 hash 与结构。研究目录导出到 `Papertrail/drawings/*.excalidraw`，白板 JSON 记录相对路径；目录仍没有单独导入回应用的入口。

## 验证范围

- 真实鼠标画矩形、连续手绘和中文文字；原生撤销、重做。
- 共享卡片及 PDF 与图形共存，选中、移动、打开右侧资料或原文；移出后共享实体保留，撤销恢复实例与关系。
- 切换布局、研究、刷新恢复模式、图形、附件及视口；历史恢复回到正确绘图引用。
- 1440×900、1280×800、1024×800 的绘图与右侧 AI/原文组合，无整页横向溢出。
- 资产先写后提交、节流合并、写入时继续编辑、保存失败保留缓冲并重试；损坏资产、图片或引用拒绝载入。
- ZIP 场景与图片往返，历史及请求引用不遗漏；研究目录仅导出本研究资产，缓存不能掩盖损坏场景。

## 运行结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm run desktop:package` | macOS arm64 打包通过，含生产构建与类型检查 |
| `npm test` | 25 个文件、367 项通过 |
| `npm run test:server` | 183 项通过 |
| `npm run test:desktop` | 16 项通过 |
| 浏览器绘图专项 | 4 项通过，27.6 秒 |
| 原有工作台、AI 与白板相关回归 | 28 个不同用例全部验证通过，分两轮完成，见下文 |
| 打包桌面绘图专项 | 1 项通过，4.7 秒；退出重启保留中文、图形和模式 |

复现命令：

```sh
npx playwright test tests/e2e/drawing.spec.ts --output=/tmp/papertrail-drawing-browser-final
npx playwright test tests/e2e/workbench.spec.ts tests/e2e/ai-space.spec.ts tests/e2e/board-agent.spec.ts tests/e2e/chat-board.spec.ts tests/e2e/composer-controls.spec.ts --output=/tmp/papertrail-drawing-regression
npx playwright test tests/e2e/workbench.spec.ts -g '完整研究路径' --output=/tmp/papertrail-drawing-workbench-final
npx playwright test --config playwright.desktop.config.ts tests/desktop/drawing.spec.ts --output=/tmp/papertrail-desktop-drawing-final --reporter=list
```

相关回归首轮 27 项通过，完整 PDF 路径因选区浮层消失而超时；trace 同时记录运行期间字体源码及打包产物触发开发服务器 full reload。冻结源码与打包后，未修改产品或该用例，单独复验通过（11.9 秒）。不能将受干扰的首轮记为一次性全通过。本轮最终覆盖 32 个不同浏览器用例及 1 个打包桌面用例。

桌面字体最终有 10 个不同本地 woff2 URL、两次启动共 20 条 200 响应，字体失败、外域请求、模型调用、CSP 与页面错误均为零，重启后场景、引用及 hash 一致。详见[实际网络与重启证据](font-desktop-evidence.json)及[字体诊断](font-diagnosis.md)。字体随包分发，许可保存在 `public/excalidraw-licenses/`；保留外域字体和 iframe 的限制。

测试均使用自制论文及隔离数据；AI 结果采用确定性适配器，不代表真实模型调用。已实际打开开发工作台检查绘图入口；本轮截图也已打开复核。旧批次的截图在相关回归前保留并于完成后恢复。

## 实际截图

| 场景 | 文件 |
| --- | --- |
| 绘图、卡片、PDF 与右侧 AI，1440×900 | [board-1440.png](board-1440.png) |
| 同一画布，1280×800 | [board-1280.png](board-1280.png) |
| 左栏折叠、绘图工具适配，1024×800 | [board-1024.png](board-1024.png) |
| 绘图保留，右侧核对原文，1440×900 | [board-source-1440.png](board-source-1440.png) |
| 打包桌面，中文绘图与本地字体 | [desktop-drawing.png](desktop-drawing.png) |

## 限制

- 原生 PNG/SVG 导出不会烘焙 React 实时卡片正文；`.excalidraw` 中的资源引用也不代替完整实体资料。完整迁移请使用工作区 ZIP。
- 尚未提供外部 `.excalidraw` 文件导入、多人协作、OCR 或把手绘直接加入 AI 上下文；外部网页 iframe 不可嵌入。
- 单场景上限 32 MiB、20,000 个元素。当前每个不可变场景内嵌图片，长期含大图的多版本历史会重复占用存储。
- 工具库按需加载，生产构建仍有大 chunk 提示；尚未进行大型白板或长期内存压力验收。
- 仅验收 Chromium 与本机 macOS arm64。Windows、Intel macOS 以及 Safari/Firefox 未做本轮人工验证。生成本地可运行包未发布或替换用户已安装的应用。
