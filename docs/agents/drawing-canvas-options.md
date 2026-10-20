# 白板直接绘图方案调研

日期：2026-10-20。状态：选型后已接入首个 Excalidraw 切片，实际验证与边界见[绘图验收](../verification/drawing/README.md)。

用户希望在研究白板里像 [Excalidraw](https://excalidraw.com/) 一样直接画图。选型后已将 `@excalidraw/excalidraw` 0.18.1 接入中央工作区，提供画笔、形状、文字、箭头和撤销，并复用研究卡片、论文入口与右侧面板。旧白板默认保留卡片布局，用户点击“绘图”进入共享资源与图形同屏的画布，不强制转换旧数据。

## 候选比较

下表的功能与许可来自官方来源；“对接成本”是结合本项目结构的工程判断，不是已完成的集成结果。

| 方案 | 当前许可与使用条件 | 绘图与 React 嵌入 | 离线保存 | 与研究卡片、PDF 摆放的对接 |
| --- | --- | --- | --- | --- |
| **Excalidraw，首选** | MIT，可用于商用，分发时保留版权与许可声明 | 官方 React 组件；手绘、形状、文字、箭头等现成；当前仓库包配置声明支持 React 19 | `onChange` 提供元素、应用状态和附件；宿主负责保存，支持 JSON 恢复 | 中等。元素可带 `customData` 引用既有资源；`renderEmbeddable` 可替换嵌入元素的渲染，但资源卡片交互、连线和导出需实测 |
| **Drawnix / Plait，备选** | Drawnix 与 Plait 为 MIT，保留版权与许可声明 | 自由画、流程图、思维导图；已有 React 视图层，基于插件与 Slate 文本体系 | 官方应用支持浏览器自动保存及 `.drawnix` JSON 导出 | 中高。可通过插件扩展资源，但需要适配其元素、富文本与交互体系 |
| **React Flow / `@xyflow/react`** | 核心 MIT；官方 Freehand Draw 示例另属 **xyflow Pro License**，不能当作 MIT 示例直接搬用 | React 自定义节点很适合卡片与论文；节点连线成熟，完整绘图工具仍需组装 | nodes、edges、viewport 可序列化保存 | 卡片对接较容易；达到 Excalidraw 的直接绘图体验需额外开发，不是现有白板的低成本替换 |
| **tldraw** | SDK 为 **source available，自定义许可，不是宽松开源**；默认仅允许开发环境；生产需要 trial、commercial 或 hobby 授权及有效密钥 | 画笔、形状、文字、箭头与自定义 React/HTML shape 能力强 | `persistenceKey` 使用 IndexedDB，也支持 JSON snapshot；密钥可离线验证 | 自定义资源 shape 的 API 很合适，但生产授权不符合优先选择自由开源依赖的目标 |

本项目当前使用 React 19 与自研 DOM/SVG 白板，没有现成 React Flow 依赖。Excalidraw 最接近用户指明的画图体验，且无需新增生产授权流程，因此列为首选。Drawnix 更适合后续把思维导图也列为重点时再评估。以上判断不代表依赖体积、性能或离线桌面适配已经通过。

## 接入边界

1. **共享实体与笔画分别保存。** 保留稳定的 `researchId / boardId / placementId / resourceRef`；卡片正文与 PDF 资产继续由共享服务管理，绘图 scene 保存笔画、形状及其布局。元素中的资源引用只做映射，不复制卡片正文为第二份可编辑事实。移动、移出和研究关联继续作用于 `placementId`；普通手绘箭头不自动变成语义 `BoardEdge`。
2. **scene 单独存储。** 本切片采用标准 Excalidraw JSON 内嵌图片附件，整个文件使用稳定 ID、内容 hash 与引用校验；更改内容生成新版本，不覆盖历史资产。`onChange` 的高频事件先留在编辑缓冲，在手势结束或节流后的保存边界提交，避免每个采样点调用整库 `updateData`。历史快照引用不可变 scene 版本及资产，避免每笔重复内嵌二进制和复制整段 scene；失败缓冲、恢复和重试须统一设计。
3. **资源仍使用共享实体。** 自定义 embeddable 显示实时卡片和 PDF 入口，移动与删除作用于 `placementId`；原生撤销可恢复实例及其语义关系。选中后的入口继续复用右侧卡片、原文及中央阅读器。普通图形箭头与原布局中的语义关系分别管理。原生 PNG/SVG 导出不会烘焙 React 卡片正文，完整迁移使用工作区 ZIP；外部 `.excalidraw` 导入尚未提供。
4. **保持离线桌面约束。** 本机桌面协议设置 `font-src 'self' data:`、`connect-src 'self'`、`frame-src 'none'`，不允许 iframe 或外域字体。字体随应用打包；`data:` 用于库内置的字体度量数据。打包桌面的字体加载与离线绘图单独验收，不靠放行字体 CDN 解决兼容问题。
5. **AI 仍使用显式材料。** 本切片不自动把绘图或绘图引用发送给模型，仍沿用所选原文证据和资料关系。内部请求保留绘图版本引用用于冲突校验；发送副本仅包含卡片布局与授权资料。改变绘图不修改已提交快照；绘画内容本身不成为原文证据。
6. **完整生命周期后再标完成。** `BoardSnapshot` 的 board 增加可选绘图资产引用，当前切片同步覆盖 schema 迁移、旧板转换、scene/附件持久化、ZIP 备份与恢复、`Papertrail/` 目录导出、历史比较与撤销恢复、研究切换、刷新恢复和缺失资源处理；不得仅增加局部页面 state 就声称接入完成。

本切片的验收路径为：一张共享卡片、一个 PDF 入口和自由绘图共同存在，完成移动与来源跳转、保存刷新、历史恢复、ZIP 往返与离线桌面验证。验收覆盖 1440×900、1280×800、1024px，以及“主区白板＋右侧原文/AI”；实际命令与结果见[绘图验收](../verification/drawing/README.md)。

## 官方来源

以下来源于 2026-10-20 核查，后续安装时还需按锁定版本复核依赖、许可证和 API。

- Excalidraw：[MIT 许可证](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)、[React 包与 peerDependencies](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/package.json)、[组件嵌入](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration)、[customData 与 onChange](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props)、[renderEmbeddable](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/render-props)、[JSON 保存与恢复工具](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils)。
- Drawnix / Plait：[Drawnix 功能与架构](https://github.com/plait-board/drawnix)、[Drawnix MIT 许可证](https://github.com/plait-board/drawnix/blob/develop/LICENSE)、[Plait 框架与 React 视图层](https://github.com/worktile/plait)。
- React Flow：[核心 MIT 许可证](https://github.com/xyflow/xyflow/blob/main/LICENSE)、[React 自定义节点](https://reactflow.dev/learn/customization/custom-nodes)、[保存与恢复](https://reactflow.dev/examples/interaction/save-and-restore)、[Freehand Draw 与 Pro License 标注](https://reactflow.dev/examples/whiteboard/freehand-draw)。
- tldraw：[授权政策及 source available 说明](https://tldraw.dev/community/license)、[SDK 许可证原文](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)、[自定义 shape](https://tldraw.dev/docs/shapes)、[本地持久化与 snapshot](https://tldraw.dev/docs/persistence)。
