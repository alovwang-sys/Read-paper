# 第二版上下文与连续探索原型验证

日期：2026 年 10 月 20 日。对象为 [prototype.html](../../prototype.html)，范围是内存交互原型，记录当时的设计阶段。设计依据见[上下文设计](../../context-design.md)，Claude Code 两轮实际讨论见[审阅记录](../../review/claude-code-review.md)。用户随后确认继续的正式功能另见[实施验收](../implementation/README.md)。

## 验证范围

使用项目已有 Playwright 依赖运行 [verify.mjs](verify.mjs)，20 组检查全部通过，浏览器脚本错误为 0，生成 10 张截图；逐项结果记录在 [checks.json](checks.json)。覆盖 1440×900、1280×800、1024×800。脚本只操作隔离的原型页面，不连接真实模型、搜索服务、PDF 或本地资料库。

检查重点是：稳定原问题与论文焦点、多个轮次的冻结材料、选定历史、材料移除与派生内容提示、自动焦点和明确保留、独立找依据、搜索批次归属、候选入库与加入讨论分开，以及三种尺寸的可操作性。

主 agent 已在 Codex 内置浏览器实际展开下一轮材料清单，核对研究背景、原问题正文和焦点卡片，提交模拟问答并查看该轮“当时材料 / 实际读取”。该记录明确显示字符估计非 token、所选历史及工具读取 0 项，没有声称读取全文或目录文件。最终修订后再次核对首次提问收起引导、独立找依据的范围及候选、完整问答保留和逐轮历史选择；候选出现后没有自动增加问答材料。其他自动化结果与截图以最新 checks.json 为准。

## 复跑

从项目根目录运行：

```sh
npm run dev
```

开发服务可用后，在另一终端运行：

```sh
node docs/whiteboard-research/verification/context-v2/verify.mjs
```

若服务使用其他地址，可通过 `PROTOTYPE_URL` 指定原型完整 URL。脚本会重新生成本目录检查报告与截图；第一版证据不受影响。

## 截图

| 内容 | 证据 |
| --- | --- |
| 整体白板、原问题和紧凑输入控制 | [overview-1440.png](overview-1440.png) |
| 下一轮材料清单 | [materials-1440.png](materials-1440.png) |
| 旧轮不可变材料 | [immutable-snapshot-1440.png](immutable-snapshot-1440.png) |
| 当时材料及模拟读取 | [turn-snapshot-1440.png](turn-snapshot-1440.png) |
| 独立找依据的候选 | [basis-candidates-1440.png](basis-candidates-1440.png) |
| 初始历史策略及逐轮选择 | [history-selection-1440.png](history-selection-1440.png) |
| AI 派生卡来源取消提示 | [derived-source-warning-1440.png](derived-source-warning-1440.png) |
| 论文焦点，1440×900 | [paper-focus-1440.png](paper-focus-1440.png) |
| 论文焦点，1280×800 | [paper-focus-1280.png](paper-focus-1280.png) |
| 论文焦点，1024×800 | [paper-focus-1024.png](paper-focus-1024.png) |

以上为本项目原型截图，不是正式产品验收。旧版基线保存在 [prototype-v1.html](../../prototype-v1.html) 与[第一版验证](../README.md)。

## 尚未证明的能力

模拟文字与读取清单不能证明模型质量、引用有效性、token 容量、全文获取或文件权限。原型刷新清空，不验证研究持久化、ZIP、真实资产 hash 或跨研究隔离。

默认历史策略仍需按设计的六轮脚本在真实模型上对比；原生助手是否确实重建／替换了历史、是否能再次读到研究目录中的旧会话，也需要逐供应商实测。Claude Code 设计审阅的成功不等于产品内 Claude 适配器验收通过。
