# 0.1.9 输入保留验收

右侧 AI 与原文小窗在 React 的 `input` 捕获阶段同步保存输入。原生 textarea 监听器随后引起其他工作区更新时，重新渲染读取的已是新草稿。保留 `onChange` 作为兼容入口；两个入口先比较共享状态中的最新值，相同文本不重复写入。

## 可复现的问题与验证

受控条件只使用公开界面操作：给 textarea 添加一次性原生 `input` 监听器，在其微任务里点击现有“收起左栏”按钮。这个无关导航更新会重新渲染工作区，测试不直接调用 React fiber、内部组件回调或工作区服务。

- 旧生产打包应用：`fill` 正常返回，但完整文字在 React 冒泡处理前被旧空值回写；原桌面恢复用例的 15 秒强断言失败。原生窗口与 renderer 均有焦点，textarea 身份未变。
- 0.1.9 候选：同一 Electron 44.8 运行复制应用与候选生产 bundle，相同公开操作下，原完整恢复用例通过。事件顺序为输入捕获 → 保存新草稿 → 收起左栏更新仍保留新草稿 → 冒泡后的 DOM、React value 与持久化输入一致。
- 候选事件中写入两次恢复记录，分别对应输入和收起左栏；没有额外的 `onChange` 重复写入，也没有将新草稿写回空字符串。

红绿日志分别位于 `/tmp/papertrail-intel-input-debug/public-red.log` 与 `public-green.log`；两组 `*-results/` 中保存了输入事件、value setter、节点身份、焦点、React value 与持久化采样。候选源码构建和 TypeScript 检查通过。

永久回归是 [composer-input-order.spec.ts](../../../tests/e2e/composer-input-order.spec.ts) 的两个独立用例：

1. 主区文稿＋右侧 AI：无关导航更新时文字仍进入共享状态，继续逐字输入、保存、刷新后继续输入均保持一致。
2. 主区 PDF＋原文小窗＋右侧 AI：同样验证输入顺序，并断言小窗与右侧草稿相互独立、刷新后仍可找回。

两个用例还模拟 `compositionstart/input/compositionend` 与组合输入期间的 Enter，断言不创建请求、模型调用次数为零。该验证使用 DOM 组合输入事件，不声称完成了真实操作系统输入法验收。没有增加超时或重试，也没有跳过、缩短或削弱原断言。

```sh
npx playwright test tests/e2e/composer-input-order.spec.ts
npm run check
```

本机结果：**2/2 通过，7.6 秒**。测试不依赖其他文件的执行顺序；每项独立建立工作区、连接响应与请求计数。追加文字前明确将光标定位到全文末尾，避免响应式换行下 End 键只移动到视觉行尾。

## 截图

以下图片均为本产品实际页面，已逐张打开检查。输入框、提交控件及小窗均在可视边界内；截图中的问题未发送。

| 尺寸 | 主区文稿＋右侧草稿 | 主区 PDF＋小窗和右侧独立草稿 |
| --- | --- | --- |
| 1440×900 | [writing-ai-1440.png](writing-ai-1440.png) | [pdf-inline-1440.png](pdf-inline-1440.png) |
| 1280×800 | [writing-ai-1280.png](writing-ai-1280.png) | [pdf-inline-1280.png](pdf-inline-1280.png) |
| 1024×800 | [writing-ai-1024.png](writing-ai-1024.png) | [pdf-inline-1024.png](pdf-inline-1024.png) |

## 019 集成检查

集成负责人已在同一工作区完成：TypeScript 检查、338 项前端单测、264 项服务测试、27 项桌面单测，以及真实 0.1.9 安装产物的完整 ARM 桌面验收 **16/16 通过**。桌面验收日志为 `/tmp/papertrail-v019-desktop-e2e.log`。这里记录的是本机结果，不代表尚未完成的远端 CI、Intel 安装产物或新版发行。

## 已知证据边界

此前两次自然 Intel 失败都表现为 `fill` 后输入为空；第二次已由强断言定位到关闭之前。随后真实 Intel 诊断运行的 5 份自然样本全部正常：节点始终为同一个 textarea，native/webContents/document 焦点正常，每次输入恰有一次新草稿持久化，未出现空值回写。因此**已确认并修复的是上述可复现的受控输入竞态，尚未证明它就是两次自然 Intel 失败的原因**。

另一个诊断探针在 `document capture` 阶段主动更新 store，早于本次 React 捕获处理，仍能制造旧值回写；它额外安装了早期诊断监听器。本次公开 UI 回归针对当前 textarea target 监听链引起的更新，不把这个更早的人工干预算作已修复范围。
