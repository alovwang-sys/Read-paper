# 多窗格浏览器专项验收

2026-10-17，本轮在独立 Vite 端口 `5194` 运行 Chromium 浏览器路径；18 项全部通过，耗时 1.1 分钟。配置为 `/tmp/read-paper-workspace-panes.playwright.config.mjs`，输出目录为 `/tmp/read-paper-workspace-panes-results`，运行日志为 `/tmp/read-paper-workspace-panes-final.log`。

实际命令：

```sh
npx playwright test --config /tmp/read-paper-workspace-panes.playwright.config.mjs
```

该配置沿用项目的单 worker、默认 1440×900 视口、默认 60 秒用例上限和失败 trace；四边拖动用例单独为 90 秒，端口与输出目录独立。可使用项目默认端口重跑相同文件：

```sh
npx playwright test tests/e2e/workspace-split.spec.ts tests/e2e/reader-continuous.spec.ts tests/e2e/resource-tabs.spec.ts
```

## 覆盖与判定

| 文件 | 数量 | 实际验证 |
| --- | --- | --- |
| `workspace-split.spec.ts` | 8 | 三至六个递归不均匀窗格；四方向拆分；分隔条键盘与指针；放大还原；真实拖动的移动、Option 复制与四边落位；加载期间替换 PDF 的落位；四类资源与共享卡片编辑；聚焦窗格承接打开；研究隔离及刷新；三尺寸 |
| `reader-continuous.spec.ts` | 6 | 滚动跨页后立即分窗保留页内位置；第二页原文摘录仍为页索引 1；同篇独立翻页与缩放；收拢后两个视图 ID 和阅读位置保留；重新拆分、刷新和切研究恢复；60 页文档画布虚拟化；三尺寸 |
| `resource-tabs.spec.ts` | 4 | 每窗格固定、排序、键盘切换与关闭；未发送 AI 草稿与文稿保留；研究隔离；引用复用文献标签且定位 PDF 第 3 页；另一篇第 2 页及刷新恢复；三尺寸 |

阅读页索引、缩放、视图 ID、资源引用、分隔比例和树结构精确断言。跨研究刷新后的页内 `offset` 独立允许不超过 `0.002` 的差异，用于实际 PDF 几何与浏览器滚动像素舍入；页码不采用模糊匹配。长文页内位置另沿用小数点后两位的恢复断言。

最小窗格菜单使用真实键盘 `End` 聚焦最后一项，检查该项完全在菜单边界内，随后 `Escape` 退出。1024px 下保持原分割结构，可放大当前窗格后恢复；三种尺寸均断言页面没有横向溢出，右侧 AI 保持可用。

## 加载中落位的真实事件证明

测试拦住第二篇示例 PDF 的响应，在目标仍显示 `.pdf-loading` 时从另一窗格拖入标签。鼠标到目标中心后，界面显示“移动到此窗格”预览；此时保留透明接收层的 DOM 引用，然后释放 PDF 响应，等待真实解析及画布出现，确认加载提示消失、原接收层仍连接且预览持续。最后才执行真实 `mouse.up()`。

完成后断言原视图 ID 从来源窗格移除，并出现在目标窗格且被选中，阅读器显示 PDF 第 1 页。整条路径使用浏览器的 HTML5 `dragstart / dragover / drop` 链，没有构造 `DataTransfer` 或用脚本派发 `drop`。普通移动与四边 Option 复制同样使用鼠标手势，并在放手前断言预览。

## 截图

已实际打开三尺寸三窗格图、1024px 连续阅读图和六窗菜单图检查布局；全部截图来自本产品运行界面。

- 三窗： [1440×900](three-panes-1440.png) · [1280×800](three-panes-1280.png) · [1024×800](three-panes-1024.png)
- 连续阅读： [1440×900](continuous-1440.png) · [1280×800](continuous-1280.png) · [1024×800](continuous-1024.png)
- 引用与标签： [1440×900](resource-tabs-1440.png) · [1280×800](resource-tabs-1280.png) · [1024×800](resource-tabs-1024.png)
- [六个不均匀窗格与最小窗格菜单](six-panes-menu.png)

## 边界

本专项使用有效本地 PDF 与确定性 AI/项目接口，没有真实模型调用或用户原生历史访问。Electron 打包应用、安装包一致性、全屏窗口行为和全项目回归由集成验收单独记录；不把本次浏览器通过等同于这些项目已验证。
