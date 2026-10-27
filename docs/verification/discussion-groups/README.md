# 讨论来源分组折叠

2026-10-24 源码增量，未重建安装包。

每篇论文、每块白板使用稳定来源 ID 分组；卡片保留既有总组。点击标题或箭头收起／展开，状态按研究保存。首次只展开当前讨论或中央资源对应的来源；新回答与白板改名不改开合状态。显式打开讨论展开其来源，搜索临时展示匹配结果，清空后恢复之前的来源和父分组状态。跨页原文讨论显示全部来源页码。

涉及文件：`ResearchAgentWorkbench.tsx`、`workbench.css`、`research-agent.ts`；显式选择的开合更新复用共享 `workspace.selectConversation`，状态字段为 `Session.discussionGroups`。

## 已完成验证

- `npm test -- tests/unit/conversation-lists.test.ts tests/unit/conversation-renaming.test.ts tests/unit/research-agent.test.ts`：84 项通过，含同名来源分离、改名与活动排序后的稳定 ID、跨页页码、研究隔离和既有会话行为。
- `npm run check`：通过。
- `discussion-groups.spec.ts` 曾在本机 Chrome、独立端口 5183 下无热更新通过 1/1。该版本覆盖来源默认开合、各自折叠、来源搜索恢复、显式重开、手动收起后新回答、刷新、研究切换与三个尺寸。
- 最终主 agent 在冻结源码与独立输出目录下复跑 1/1 通过，包含“父分组原本关闭→搜索→清空恢复关闭”和“显式重开同时展开父分组”。开发期带热更新的运行不计为最终证据。

多个 History 宿主初始化使用同一研究当前来源；更新回调逐键以 `??=` 补缺，不覆盖另一个宿主已写入的开合或用户的显式选择。不同研究分别更新各自 session。

## 截图与范围

开发期截图位于 [screenshots/](screenshots/)：`groups-1440.png`、`groups-1280.png`、`groups-1024.png`。已实际查看，1024px 使用既有左侧抽屉。截图已由最终冻结源码的通过运行重新生成。

E2E 使用合成论文和受控回答，未调用真实模型；本模块未运行全量 E2E、桌面打包或真实 Word 验证。最终集成结果由本轮总验收补充。
