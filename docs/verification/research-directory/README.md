# 研究目录与实际文件：实现验收

2026-10-17。已将[研究目录设计](../../agents/research-directory-design.md)接入生产工作台；[原型](../../agents/research-directory-prototype.html)保留为设计基线。代码位于 `codex/knowledge-flow`，应用版本 0.1.2。

## 正式实现

- 新建研究默认创建新目录，也可关联已有目录或稍后设置。桌面通过系统选择器选父位置，浏览器使用本机服务选择器。预览只读，确认后提交稳定 workspace/research/operation ID；双击共用操作，失败保留输入，未知结果重试恢复，不把用户已有目录当新目录覆盖。
- 左侧研究与右侧本机助手共用 `Research.directory`；右侧显示继承提示、统一进入项目设置。切换研究和助手保留原输入、材料和阅读位置。
- 关联后在专用 `Papertrail/` 中保存原始 PDF、图片、文献信息、摘录、卡片、白板、文稿、可读对话和结构化 `research.json`，保留稳定实体 ID/hash。卡片和文稿包含 PDF 页码与相对来源链接；无全文条目保留元数据。
- 自动保存状态和重试入口位于左栏底部及项目设置。未变资产不重传/重写；事务提交和崩溃恢复保护旧文件。用户外改、删除或软链替换会暂停覆盖，原文件保留。单资产 64 MiB、单轮文件总量 256 MiB；应用数据库继续作为业务实体和恢复副本。
- 本机聊天在共同提交路径先等待最新文件保存，失败保留输入且不发模型。同步有界超时；恢复工作区后废弃旧响应、重试和错误状态，未知创建按工作区保留恢复记录。正常关闭先停止生成、保存应用数据并等待目录保存，失败返回工作台重试。

## 验证结果

- 前端单元 **243/243** 通过，覆盖目录创建、超时/取消、待办按工作区恢复、PDF/区域图片与来源文件、迟到同步隔离及本机提问前保存。
- 浏览器全量回归 **85/85** 通过，含新增研究创建6项和旧目录/项目路径；使用明确的测试适配器，不冒充真实模型。随后修正空研究首页误显引用核验成功的提示，相关创建/出处链 **10/10** 复验通过。
- 服务端全量以串行运行 **178/178** 通过；覆盖目录幂等、两种意图、冲突、事务、软链与外改保护、未变资产复用及崩溃恢复。桌面协议单元 **16/16** 通过。
- 打包桌面 **9/9** 通过：隔离数据目录下验证创建/取消、原生选择器 IPC（返回临时路径桩）、绑定与重启恢复、真实 PDF hash/卡片正文/会话索引、UI 修改落盘、未变 PDF inode、外改不覆盖及退出失败后的重试恢复。测试未发送模型请求。最终界面微调后新增桌面2项再次通过。
- 真实 UI 通过内置浏览器操作：新建/已有目录、重名/归属冲突、服务离线、长路径、右侧继承、项目设置；1440×900、1280×800、1024×800 均无整页横向溢出，1024 抽屉、Tab 和 Escape 返回通过。测试目录均位于临时位置，未创建用户研究或发送 UI 模型请求。
- **真实 Codex**：一次生产适配器请求读取随机卡片并正确回答，返回原生 ID，同 cwd list/read 找到同一 Session，原资料 hash 未变。详见[真实探针](codex-files-probe.md)；不等同于第二轮 resume 或独立桌面应用列表已验收。

## 本机安装验证

macOS arm64 的 0.1.2 DMG 已生成，安装前正常退出旧版，对原用户数据 69 个文件逐项校验备份，旧 0.1.1 应用移入废纸篓保留恢复能力，用户数据目录未删除。安装后实际打开，原 `learn-english` 研究、中央标签与 Codex 输入区恢复；实测系统目录选择器打开/取消，以及新建表单取消，不新建用户研究或发送请求。对应[安装后工作台](installed-workspace-macos.jpg)与[安装后创建表单](installed-create-macos.jpg)。最终包与安装 app.asar 的一致性及安装包 hash 见[安装记录](installed-upgrade.json)。

升级前数据备份：`~/Library/Application Support/Papertrail-upgrade-backups/20261017-124301-0.1.1-to-0.1.2/user-data`。原生 Session、登录与 Codex 配置均未移动或删除。

首次打包因缓存命中后仍联网取校验表而失败；改为复用同版本已安装 Electron 的官方 checksums，仍严格验证 SHA-256，随后标准 `npm run desktop:make` 成功。未禁用校验或变更依赖版本。

## 正式界面截图

| 证据 | 内容 |
| --- | --- |
| [新建研究1440](implemented-create-1440.jpg)、[1280](implemented-create-1280.jpg) | 名称、问题、父位置、最终路径与一次关联 |
| [桌面创建](desktop-created-directory.png)、[桌面外改保护](desktop-external-edit-conflict.png) | 最终打包应用，文件系统真实；目录选择器返回值由测试控制 |
| [已有目录](implemented-existing-1440.jpg) | 目录名、关联预览与保留用户已有文件 |
| [PDF＋Codex1440](implemented-pdf-codex-1440.jpg)、[1280](implemented-pdf-codex-1280.jpg)、[1024](implemented-pdf-codex-1024.jpg) | 中央原文保持打开，右侧继承当前研究目录 |
| [长路径](implemented-long-path-1024.jpg)、[继承](implemented-inherited-1024.jpg)、[设置](implemented-settings-1024.jpg)、[抽屉](implemented-drawer-1024.jpg) | 1024布局与键盘可访问性 |
| [归属冲突](implemented-conflict-1280.jpg)、[名称冲突](implemented-duplicate-1280.jpg)、[服务离线](implemented-service-unavailable-1440.jpg) | 具体原因、保留输入和原位恢复 |

## 已知边界

目录文件暂不支持外部编辑回写或独立导入恢复；完整迁移继续用工作区 ZIP。原生 Session 日志与认证仍由助手保存，`sessions/` 是可读历史与原生身份索引，复制文件夹不保证换机续接。外部 Codex 桌面项目/列表自动切换、第二轮原生接续、OpenCode/Claude 真实模型互通未在本轮证明。

---

以下为实施前的设计检查和原型记录，保留用于追溯。

## 实施前基线检查

- 代码基线 `d4818c0`。确认 `Research.directory` 是共享目录来源；右侧请求传 binding ID，服务端查回研究路径作为聊天 cwd，Codex 的线程新建/恢复与回合均使用它。
- 实际打开 `/Applications/Papertrail.app` 的“新建研究”：只有名称、问题和创建按钮，没有位置字段。检查后取消，未创建研究、未绑定目录或发送模型请求。
- [当前安装版表单截图](current-create-macos.jpg) 是实际应用证据；后续 `prototype-*.jpg` 为设计原型截图，两者不能混用。
- 后端允许预览不存在的最后一级目录且不写磁盘；现有 UI 先浏览再预览，导致不能从界面新建目录。已在提案写明调用差异与最小修正位置。
- 业务数据继续使用应用本地数据库；目录包含项目清单、显式材料和可读归档。原型不宣称完整资料迁入目录或外部 Codex 桌面项目已自动同步。

2026-10-17 实际运行：

```sh
node --test server/projects.test.mjs server/project-integration.test.mjs
```

结果：26/26 通过，0 失败、0 跳过。覆盖预览不写入、绑定幂等与冲突、规范路径与清单、研究/助手隔离、重启恢复及项目 cwd 与独立材料目录。运行时使用测试适配器，目录使用临时测试位置，不调用真实模型；这些是已有链路的基线回归，不证明新 UI 已实现。

## 原型验证

原型仅使用内存示例，不访问系统目录、不调用模型、不写入业务数据库。实际通过 Codex 内置浏览器打开本地原型，并按以下路径检查；这些是原型交互结果，不是生产 E2E。

| 检查 | 实际结果 |
| --- | --- |
| 新建研究 | 改名称和问题、选择父位置、核对最终路径，一次确认后左侧与右侧显示同一研究，右侧“沿用研究目录” |
| 已有目录 | 选“论文复现”示例目录，名称提前变成真实文件夹名并只读，完整路径可见 |
| 方式切换 | 键盘左右切换新建/已有方式，返回后保留手动填写的新建名称 |
| 取消与子层返回 | 选择器 Escape 只关子层，回到原表单与“更改”按钮；表单 Escape 返回触发处 |
| 输入与材料隔离 | 创建示例研究，写输入并加入示例摘录；切 B 再回原研究，原输入与材料恢复，未发送请求 |
| 创建失败 | 勾选下次失败，创建后保留问题、名称和位置；“重试”后原位完成 |
| 已有关联冲突 | 目录已属于其他研究时禁用主创建动作；“打开已有研究”按路径找到对应研究，另用 B 的同名路径验证不会总跳 A |
| 权限与重名 | 无权限可更换位置后解除错误，问题/名称保留；名称冲突可改名恢复操作 |
| 稍后设置 | 创建未绑定研究，右侧统一进入项目设置补绑；原输入保留，没有第二套 Codex 目录状态 |
| 目录失联 | 输入可编辑、发送禁用；设置保留原路径，模拟重连后恢复同一研究及输入；不改其他目录 |
| 设置焦点 | 正常设置初始焦点到“完成”，缺目录/失联时到对应恢复按钮；关闭返回触发处 |
| 键盘围栏 | 弹窗首尾 Tab/Shift+Tab 循环；1024 导航抽屉的首尾 Tab、Escape 返回菜单通过；关闭的导航不能获得焦点 |
| 三尺寸 | 1440×900、1280×800、1024×800 无整页横向溢出；创建操作区在视口内，长路径预览换行且无横向溢出；1024 导航为抽屉 |

原型脚本经 `vm.Script` 解析通过；HTML 静态检查未发现重复静态 ID、远程资源或持久化/请求 API。未运行整套应用构建、浏览器和桌面 E2E，因为生产代码和依赖没有变化。

## 截图索引

| 证据 | 类型与内容 |
| --- | --- |
| [current-create-macos.jpg](current-create-macos.jpg) | 现有安装版真实表单，缺少目录步骤 |
| [prototype-create-1440.jpg](prototype-create-1440.jpg) | 新建研究，名称、问题、父位置与最终预览 |
| [prototype-bound-1440.jpg](prototype-bound-1440.jpg) | 一次关联后的工作台与 Codex 继承行 |
| [prototype-existing-1440.jpg](prototype-existing-1440.jpg) | 使用已有目录并提前显示最终名称 |
| [prototype-create-1280.jpg](prototype-create-1280.jpg)、[prototype-bound-1280.jpg](prototype-bound-1280.jpg) | 1280 表单与三栏布局 |
| [prototype-create-long-path-1024.jpg](prototype-create-long-path-1024.jpg)、[prototype-bound-1024.jpg](prototype-bound-1024.jpg) | 1024 长路径表单与折叠后的主区/右栏 |
| [prototype-drawer-1024.jpg](prototype-drawer-1024.jpg) | 1024 导航抽屉 |
| [prototype-unbound-1024.jpg](prototype-unbound-1024.jpg)、[prototype-lost-settings-1024.jpg](prototype-lost-settings-1024.jpg) | 未绑定与原目录失联恢复 |
| [prototype-duplicate-1280.jpg](prototype-duplicate-1280.jpg)、[prototype-permission-1024.jpg](prototype-permission-1024.jpg) | 冲突、权限错误与恢复动作 |

## 设计阶段当时的交付边界

实施前该轮未开发 RD0–RD3，未调用模型、搬迁资料、打包或安装。当时列出的选择器、失败恢复、重启和三尺寸检查已在本文上方按正式实现重新记录；三类外部桌面客户端完整互通仍单列。
