# AI 对话纵向空间第二轮调整

本页保留功能分支阶段的验证结论；聊天、绘图和导航截图已在最新 main 回归时重拍，完整集成检查与平台边界见[集成验收](../main-integration/README.md)。

2026-10-20。用户再次指出右侧 AI 上下空间不足，本轮收紧固定控件，沿用同一右侧宿主与请求、研究和材料状态；不修改模型或持久化契约。

## 实际变化

- 宿主原本已经占满视口高度，主要浪费来自内部三层顶栏及多排底部工具。现在模式栏 40px，对话顶栏 38px；助手切换、状态、刷新、历史、新建在同一行，完整名称和连接信息可通过提示及助手菜单核对。
- 材料、对话范围、白板工具合并为一行。默认折叠，展开后核对原文、累计上下文、历史及本次白板目标；激活白板修改时自动展开并标明目标。材料列表可用高度上限从 220px 提高到 `min(320px, 40dvh)`。
- 输入框从一行开始并随内容自动长高；同时修复脚本仍强制至少 76px、覆盖 CSS 紧凑高度的问题。短输入 44px，长输入自动增长到 160px，发送控件仍可见。
- Codex 输入工具收为一行。材料、模型、推理强度、语音、发送/停止直接可用；常显的权限设置入口展开权限、技能、Chat/Plan。完全访问保持醒目提示与单独确认，Plan 与已选技能数量常显，技能可在设置中核对或移除。
- 连接异常保留明确状态和重连按钮，安装与详细说明默认折叠。“有新内容”改为消息区内浮动，不再挤占对话高度；发送快捷键放入输入框提示和无障碍说明。

## 同场景高度比较

使用与[第一轮](../ai-space/README.md)相同的长模拟回答、ready Codex、一条显式材料及未发送问题；材料、范围、白板工具折叠。消息字体仍为 14px，未通过缩小回答文字获得空间。

| 视口 | 第一轮消息区 | 本轮消息区 | 新增高度 | 占视口高度 |
| --- | --- | --- | --- | --- |
| 1440×900 | 490.4px | 698px | 207.6px | 77.6% |
| 1280×800 | 416.4px | 598px | 181.6px | 74.8% |
| 1024×800 | 416.4px | 598px | 181.6px | 74.8% |

主动展开材料或设置、输入长文本、出现连接异常或待处理任务时会按内容占用空间；上表不是所有状态的固定高度承诺。

| 截图 | 内容 |
| --- | --- |
| [chat-1440.png](chat-1440.png) | 主区文稿，右侧完整聊天与单行工具 |
| [chat-1280.png](chat-1280.png) | 1280×800 并列布局 |
| [chat-1024.png](chat-1024.png) | 左栏折叠，中央内容与 AI 并列 |
| [materials-1440.png](materials-1440.png) | 展开显式材料，核对论文、PDF 页码及原句 |
| [codex-footer-320.png](codex-footer-320.png) | 320px 侧栏，完全访问、Plan 与 4 个技能仍只占一排 |
| [desktop-composer.png](desktop-composer.png) | 新打包应用的输入工具；隔离环境如实显示未连接状态 |

## 验证

`npm test`：25 个文件、367 项通过。浏览器共 **49 个不同用例验证通过**：

```sh
npx playwright test tests/e2e/ai-space.spec.ts tests/e2e/agents.spec.ts tests/e2e/agent-desktop.spec.ts tests/e2e/ai-source-layout.spec.ts tests/e2e/board-agent.spec.ts tests/e2e/chat-board.spec.ts --output=/tmp/papertrail-ai-expanded-regression-final
npx playwright test tests/e2e/agent-desktop.spec.ts -g '桌面对话引用' --output=/tmp/papertrail-ai-expanded-source-final
npx playwright test tests/e2e/composer-controls.spec.ts tests/e2e/codex-desktop.spec.ts tests/e2e/tikhub.spec.ts --output=/tmp/papertrail-compact-codex-r2
```

第一组 24 项通过，3 项仍断言旧版长摘要，更新为短摘要并补充展开后累计材料完整性断言，第二组 3 项通过；第三组 22 项通过。此前调试轮曾发现助手菜单迁至顶栏后仍向上弹出，修正为向下展开并限制在视口内，最终三尺寸增加菜单完整可见与 Escape 焦点恢复验证；失败轮未计入通过数。

覆盖消息区高度及上下边界、一行输入与长输入自动增长、材料/历史展开、助手切换、菜单键盘返回、权限确认、请求快照、技能选择与移除、320px 侧栏的完全访问＋Plan＋4 个技能最挤状态、生成锁定/停止、研究切换及刷新恢复、原文引用在中央打开而保留右侧回答和草稿、白板生成与修改。

`npm run desktop:package` 已通过，包含生产构建与类型检查；保留已有的大 chunk 提示。生成本机 macOS arm64 可运行包，没有发布或替换已安装的应用。

新包桌面专项 **1 项通过，12.5 秒**：

```sh
npx playwright test --config playwright.desktop.config.ts tests/desktop/composer-controls.spec.ts --output=/tmp/papertrail-compact-codex-desktop
```

真实本机能力元数据读取 200、返回 8 个模型；完全访问的确认已实际打开并取消，没有启用。添加材料取消、系统听写零媒体权限请求、1024px 控件可达、退出重启保留草稿及只读权限均通过，模型请求与页面错误为空。详见[桌面证据](desktop-composer-evidence.json)。隔离 HOME 的登录与目录提示不作为真实模型连接通过的证据。

截图使用隔离样例和模拟回答，无真实模型请求。163 张既有截图在测试前备份，完成后已恢复，本轮新证据独立保存在本目录。Windows 本轮未人工验收。
