# 桌面安装包与版本分发

Papertrail 使用同一套 React / TypeScript 界面，通过 Electron 与 Electron Forge 构建 macOS、Windows 安装包。日常开发、安装包验证和正式发布分别管理；macOS、Windows 不建立长期独立代码分支。

项目采用[个人非商业使用许可证](../LICENSE)，商业使用须事先取得作者书面许可。Forge 白名单保留应用根目录的 `LICENSE`，后续构建会将其一并打入 `app.asar`；第三方组件继续适用各自许可。

## 产物与本机构建

先使用 Node.js 24 和 `npm ci` 安装锁定的依赖。以下命令必须在对应操作系统运行；CI 使用三个原生 runner，避免在 Mac 上模拟 Windows 打包环境。

| 命令 | 作用 |
| --- | --- |
| `npm run test:desktop` | 检查桌面运行边界与相关单元测试 |
| `npm run desktop:package` | 构建前端与可运行应用目录，输出至 `out/` |
| `npm run desktop:make` | 构建应用并生成安装文件，输出至 `out/make/` |
| `npm run test:desktop:e2e` | 启动已打包的应用，使用独立临时资料目录进行冒烟验证 |
| `node --test .github/scripts/release.test.mjs` | 检查版本来源、完整产物、校验和与草稿发布保护 |

| 平台 | GitHub runner | 目标架构 | 下载文件 |
| --- | --- | --- | --- |
| macOS / Apple 芯片 | `macos-15` | arm64 | 文件名含 `arm64` 的 `.dmg`；`.zip` 为附加归档 |
| macOS / Intel | `macos-15-intel` | x64 | 文件名含 `x64` 的 `.dmg`；`.zip` 为附加归档 |
| Windows | `windows-2025` | x64 | `Setup.exe`；同时保留 `.nupkg`、`RELEASES` 元数据 |

三个 runner 的系统版本是构建与测试环境，不代表已验证所有较旧系统。Windows ARM、Linux 和 macOS 通用二进制未纳入当前矩阵。平台架构以 [GitHub runner 官方清单](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)为准；Forge 的 [`package` 和 `make`](https://www.electronforge.io/core-concepts/build-lifecycle)分别负责应用目录与安装格式。

## 日常 CI 与临时构建下载

`.github/workflows/ci.yml` 在指向 `main` 的 PR 和 `main` 提交上运行：

1. Linux 执行类型检查、业务单测、AI 服务确定性测试、桌面边界测试、发布保护测试、前端构建和 Chromium 浏览器 E2E。普通 CI 不调用付费模型。
2. 上述检查通过后，分别构建 macOS arm64、macOS x64、Windows x64 安装包，并启动对应打包应用进行桌面 E2E。
3. 各平台冒烟通过后上传 `desktop-macos-arm64`、`desktop-macos-x64`、`desktop-windows-x64` artifacts，保留 14 天；失败证据保留 7 天。
4. `Required checks` 汇总所有结果。任意平台失败或跳过均不能算整条 CI 成功。

在仓库 Actions 页面打开对应运行，下载所需 artifact 并解压即可取得安装文件。artifact 是某次提交的临时构建，14 天后会过期；公开版本从仓库 **Releases → 对应版本 → Assets** 下载，不受 Actions 的 14 天保留期限制。工作流已写入仓库不等于 GitHub 已运行通过，需查看实际 run。

验证分四层，后一层不能由前一层替代：

| 层级 | 验证内容 | 能证明什么 |
| --- | --- | --- |
| 1. 代码与服务 | 类型检查、单测、AI 服务确定性测试、桌面边界与发布保护测试、构建 | 代码、数据和服务边界按测试预期运行 |
| 2. 浏览器 E2E | Chromium 中完成工作台用户路径 | 浏览器界面的集成行为 |
| 3. 三目标打包应用 E2E | 在 macOS arm64、macOS x64、Windows x64 启动真实打包应用 | 三目标能构建，应用目录可启动并完成自动冒烟 |
| 4. 安装与升级人工验收 | 对应系统操作 DMG / Setup.exe、检查系统信任提示、干净环境及升级资料保留 | 用户取得安装包后的实际安装与升级体验 |

前 3 层是生成完整发行草稿的自动门槛；第 4 层和发行者签名 / 公证是稳定版门槛。技术预览可以保留尚未完成的第 4 层项目，但须逐项公开标明，不能写成全部通过。

CI 只使用 `contents: read`，checkout 不保留认证凭据；不使用 `pull_request_target`，不读取签名凭据或模型密钥，只上传 `out/make/` 和指定测试证据目录。Action 固定完整 commit SHA，更新交由 Dependabot PR 审查。[GitHub 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)

## 从 main 生成并发布技术预览

推荐流程：**短期功能分支 → PR → CI 全通过 → 合并 main → 网页运行发行工作流 → 完整草稿 → 核对实际验证 → 发布 Pre-release**。版本 tag 固定来源，Release 提供面向用户的版本说明和下载附件。

1. 在短期分支修改 `package.json` 的版本并同步 `package-lock.json`，经 PR 合入 `main`。发行输入为 `v<package.json.version>`，例如包版本 `0.1.2` 对应 `v0.1.2`；后续修复先运行 `npm version <新版本> --no-git-tag-version` 再提交。
2. 打开仓库 **Actions → Desktop release draft → Run workflow**，工作流分支选择 **main**，tag 输入 `v<package.json.version>`，然后运行。若 tag 不存在，工作流将它创建在**本次工作流启动时的 main SHA**，后续 main 前进不会改变本次来源。已有 tag 不移动、不重建；输入旧 tag 可重跑其原提交，不要求它等于最新 main。手动运行不接受功能分支作为发行源。
3. tag 的 `v` 后必须与所指提交的 `package.json.version` 完全相同。工作流检查该提交属于 `origin/main` 历史，再对固定 SHA 重跑全部检查、浏览器 E2E、三目标打包及打包应用 E2E。`v0.1.0-beta.1` 等 tag 也可使用，但该提交中的包版本必须同为 `0.1.0-beta.1`。版本号是否带预发布后缀，与 GitHub 的 Pre-release 标记分别管理；`v0.1.0` 也可作为技术预览发布。
4. 完整 CI 和三个平台全部成功后，由单个汇总 job 收集同一次 run 的全部安装文件，生成 `SHA256SUMS`，并创建或更新一个 **Draft + Pre-release**。汇总严格核对版本、平台和架构对应的七个 Forge 文件名，拒绝意外 ZIP / EXE；写入前通过 GitHub refs API 解引用 annotated tag 并再次核对固定 SHA，上传后复核远程 tag、完整附件集合、大小和 SHA-256。不调用 Forge 的自动发布，不由各平台各自写 Release。
5. 等待整次工作流成功后，在仓库 Releases 打开草稿，核对源 SHA、七个安装相关文件及 `SHA256SUMS`，补充实际运行过的测试、安装结果和已知限制。草稿带有 Pre-release 标记仍然**尚不公开**。失败的汇总可能留下不完整草稿，不能提前发布；上传失败可重跑，同一来源草稿内同名且内容改变的附件才会替换。
6. 用户已授权公开发行时，由维护者或 agent 检查后选择 **Publish release**，保留 **Set as a pre-release**。这会成为公开技术预览，用户即可从 Releases 下载。当前未签名，Windows / Intel 安装器人工验收如果尚未完成，应明确列出系统、架构与未验证项目；不得宣称已通过。公开预览不要求先完成全部平台的安装器人工验收，稳定版要求完成下文全部安装、升级及签名验收。

已经发布的同名 Release、来源 SHA 不同或未记录来源的已有草稿、有意外残留附件的草稿都会令工作流失败，不进行覆盖。不要重用或移动已经发行的 tag，也不要在工作流仍运行时发布草稿；修复使用新版本。

汇总阶段使用本次工作流自身固定提交（`github.workflow_sha`）中的发行脚本，安装包来源仍固定为版本 tag 的 SHA。这样从 main 手动重跑旧 tag 时，可以使用已经修复的发行工具，而不移动版本标签或改变应用来源。

命令行也可创建 tag 触发同一工作流。先 fetch，确认选定提交已经合入 main、本地与远程状态一致且工作区干净，再由获授权的维护者执行，例如首次发行：

```sh
git tag -a v0.1.0 -m "Papertrail v0.1.0"
git push origin v0.1.0
```

三种状态的区别如下：

| 状态 | 对外可见性与用途 | 门槛 |
| --- | --- | --- |
| Draft + Pre-release | 未公开的待审草稿 | 前 3 层自动验证通过，附件完整 |
| 已发布 Pre-release | 公开技术预览，适合自愿试用 | 获授权发布；核对附件与实际验证说明，如实列出未签名及未验收项目 |
| 已发布稳定版 | 面向稳定使用的公开版本，不勾选 Pre-release | 完成各目标系统安装、干净环境、升级资料保留验收及签名 / 公证 |

草稿附源提交 SHA、适用平台、未签名说明及手工验收边界。macOS 文件名必须区分架构，跨平台附件重名时汇总失败；Windows 元数据与 `.nupkg` 保留原文件名，避免破坏彼此引用。草稿创建和发布的区别见 [GitHub Release 管理](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

校验下载完整性：macOS 可运行 `shasum -a 256 -c SHA256SUMS`；Windows 在 PowerShell 使用 `Get-FileHash -Algorithm SHA256 '.\实际安装包名.exe'`，与 `SHA256SUMS` 中对应行比较。校验和不提供软件发布者身份认证。

## 当前分发级别与签名

当前自动产出的是**未配置发行者签名的预览包**。尚未配置 macOS Developer ID / Apple 公证、Windows 代码签名，也未接入应用自动更新；安装操作可能触发系统信任提示。不能把“CI 打包成功”写成“已通过 Apple 公证”或“无警告安装”。

模型连接设置的“已保存”仅确认格式校验与本机加密保存，连通性需返回工作台发送消息验证。API 密钥只粘贴控制台中的密钥本体；允许裁剪外围空白，内部空白、中文、不可见字符等会在保存前被拒绝。旧版本已经保存非法密钥时，原设置文件保留，可在“模型连接”重新粘贴正确密钥恢复。

发布稳定版前，按 [Electron 代码签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing)配置证书、Apple 公证和 Windows 发行者签名，并在受保护的发行流程单独接入。证书与密码放 GitHub Secrets，PR 构建继续不接触它们；完成后还需更新草稿说明，不能沿用当前 unsigned 文案假称已签名。当前仓库没有存储证书，也未代申请账号或修改远程仓库设置。

## 稳定版发布前的安装验收

CI 的桌面测试启动 `out/` 下的应用目录，**不会自动操作 DMG 安装或 Windows 安装器**。稳定版要求每个架构至少在实际系统完成以下验收，并把操作系统、版本、结果记录进版本说明。技术预览可将未完成项标为待验收，例如 Windows x64 / macOS Intel 的安装器、系统信任提示、干净环境或升级检查；已验证项仍需记录实际证据：

- 从对应 DMG 拖入“应用程序”，或运行 Windows `Setup.exe`；从系统入口启动，退出后能再次启动，卸载入口正常。
- 在没有 Node.js、没有本地开发服务器的干净环境中打开应用；离线打开内置示例、导入本地 PDF、翻页与选区、创建卡片、回到原文、白板与结论导出可用。
- 保存论文、证据、卡片和草稿，退出重启后恢复；从上一版本升级后核对资料、阅读位置和未完成编辑。测试先使用可丢弃样本，通过“设置 → 工作区备份与恢复”保留升级前的完整 ZIP。
- 分别确认主区 PDF＋右侧卡片、白板＋右侧原文、结论＋右侧 AI 的相关操作；1440×900、1280×800 和 1024px 下布局可用。
- 使用独立用户配置验证 AI；未配置时显示实际可用状态。安装包不包含项目开发者的 `.env.local` 或模型密钥。真实模型验收单独记录，不以模拟回答替代。
- 记录系统签名与信任提示的真实情况，确认安装包附件齐全且 SHA256SUMS 匹配。稳定版须完成签名 / 公证；未签名技术预览保留 Pre-release 标记和说明。

浏览器站点与桌面应用使用不同资料目录，现有浏览器数据不会自动出现；Windows 和 Mac 之间也不会自动同步。需要迁移时，在原环境的“设置 → 工作区备份与恢复”导出完整 ZIP，再到目标桌面应用的相同入口恢复。ZIP 包含所有研究、原 PDF、区域图片、卡片、白板、结论和聊天，**不含 API key**；总内容上限 256 MiB，单个资产上限 64 MiB。恢复先校验 SHA-256 与引用，再在同一数据库事务中保留 `before-backup-restore` 副本并替换当前资料；它是整库替换，不合并两台电脑各自的新内容。恢复失败保留当前资料。

仅接受应用直接导出的原始 ZIP32，勿重新压缩；不支持加密、分卷或 ZIP64。文字与会话记录最多 16 MiB，全部内容最多 256 MiB、单个资产最多 64 MiB。ZIP 含原始研究材料，应保存在用户信任的位置；迁移后模型配置需重新设置。Markdown 只导出研究产出，不能当作包含原 PDF 的全量备份。跨设备自动同步和应用自动更新尚未实现。
