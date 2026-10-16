# 桌面安装包与版本分发

Papertrail 使用同一套 React / TypeScript 界面，通过 Electron 与 Electron Forge 构建 macOS、Windows 安装包。日常开发、安装包验证和正式发布分别管理；macOS、Windows 不建立长期独立代码分支。

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

## 日常 CI 与下载预览包

`.github/workflows/ci.yml` 在指向 `main` 的 PR 和 `main` 提交上运行：

1. Linux 执行类型检查、业务单测、AI 服务确定性测试、桌面边界测试、发布保护测试、前端构建和 Chromium 浏览器 E2E。普通 CI 不调用付费模型。
2. 上述检查通过后，分别构建 macOS arm64、macOS x64、Windows x64 安装包，并启动对应打包应用进行桌面 E2E。
3. 各平台冒烟通过后上传 `desktop-macos-arm64`、`desktop-macos-x64`、`desktop-windows-x64` artifacts，保留 14 天；失败证据保留 7 天。
4. `Required checks` 汇总所有结果。任意平台失败或跳过均不能算整条 CI 成功。

在仓库 Actions 页面打开对应运行，下载所需 artifact 并解压即可取得安装文件。artifact 是某次提交的临时构建，不是正式发行版本；14 天后会过期。工作流已写入仓库不等于 GitHub 已运行通过，需查看实际 run。

CI 只使用 `contents: read`，checkout 不保留认证凭据；不使用 `pull_request_target`，不读取签名凭据或模型密钥，只上传 `out/make/` 和指定测试证据目录。Action 固定完整 commit SHA，更新交由 Dependabot PR 审查。[GitHub 安全建议](https://docs.github.com/en/actions/reference/security/secure-use)

## 从 main 生成版本草稿

建议流程：**短期功能分支 → PR → CI 全通过 → 合并 main → 版本 tag → 完整草稿 → 安装验收 → 人工发布**。

1. 在短期分支修改 `package.json` 的版本并同步 `package-lock.json`。例如当前版本之后发布 `0.1.1` 时运行 `npm version 0.1.1 --no-git-tag-version`，经 PR 合入 `main`；版本已经正确则无需重复修改。
2. fetch 并确认本地 `main` 与 `origin/main` 一致、工作区干净。为选定的已合并提交创建精确版本 tag，例如：

   ```sh
   git tag -a v0.1.1 -m "Papertrail v0.1.1"
   git push origin v0.1.1
   ```

   此命令应由获授权的维护者执行。本次实现没有推送 tag 或创建远程 Release。不要重用、移动已经发行的 tag；修复使用新版本。
3. tag 的 `v` 后必须与该提交的 `package.json.version` 完全相同。`Desktop release draft` 会检查 tag 指向的提交属于 `origin/main` 历史，随后对固定 SHA 重跑全部检查和三平台打包。`v0.1.0-beta.1` 等预发布版本也可使用。
4. 必要时在 Actions 手动运行 `Desktop release draft`，工作流分支选择 **main**，输入已经存在的版本 tag。手动操作仍会核对来源并重新构建，不接受任意功能分支作为发行源。
5. 只有完整 CI 与三个平台全部成功，唯一的汇总 job 才获得 `contents: write`，收集同一次 run 的全部安装文件，生成 `SHA256SUMS`，并创建或更新一个 **Draft + Pre-release**。汇总严格核对版本、平台和架构对应的七个 Forge 文件名，拒绝意外 ZIP / EXE；写入前通过 GitHub refs API 解引用 annotated tag 并再次核对固定 SHA，上传后复核远程 tag、完整附件集合、大小和 SHA-256。不调用 Forge 的自动发布，不由各平台各自写 Release。
6. 已经发布的同名 Release、来源 SHA 不同或未记录来源的已有草稿、有意外残留附件的草稿都会令工作流失败，不进行覆盖。上传失败可重跑；仅同一来源草稿内同名、内容改变的附件会被替换。不要在工作流仍运行时人工发布草稿。失败的汇总可能留下不完整草稿，需等待后续成功，不可提前发布。

草稿附源提交 SHA、适用平台、未签名说明及手工验收边界。macOS 文件名必须区分架构，跨平台附件重名时汇总失败；Windows 元数据与 `.nupkg` 保留原文件名，避免破坏彼此引用。草稿创建和发布的区别见 [GitHub Release 管理](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

校验下载完整性：macOS 可运行 `shasum -a 256 -c SHA256SUMS`；Windows 在 PowerShell 使用 `Get-FileHash -Algorithm SHA256 '.\实际安装包名.exe'`，与 `SHA256SUMS` 中对应行比较。校验和不提供软件发布者身份认证。

## 当前分发级别与签名

当前自动产出的是**未配置发行者签名的预览包**。尚未配置 macOS Developer ID / Apple 公证、Windows 代码签名，也未接入应用自动更新；安装操作可能触发系统信任提示。不能把“CI 打包成功”写成“已通过 Apple 公证”或“无警告安装”。

面向普通用户分发前，按 [Electron 代码签名文档](https://www.electronjs.org/docs/latest/tutorial/code-signing)配置证书、Apple 公证和 Windows 发行者签名，并在受保护的发行流程单独接入。证书与密码放 GitHub Secrets，PR 构建继续不接触它们；完成后还需更新草稿说明，不能沿用当前 unsigned 文案假称已签名。当前仓库没有存储证书，也未代申请账号或修改远程仓库设置。

## 发布前的安装验收

CI 的桌面测试启动 `out/` 下的应用目录，**不会自动操作 DMG 安装或 Windows 安装器**。每个架构至少在实际系统完成以下验收，并把操作系统、版本、结果记录进草稿：

- 从对应 DMG 拖入“应用程序”，或运行 Windows `Setup.exe`；从系统入口启动，退出后能再次启动，卸载入口正常。
- 在没有 Node.js、没有本地开发服务器的干净环境中打开应用；离线打开内置示例、导入本地 PDF、翻页与选区、创建卡片、回到原文、白板与结论导出可用。
- 保存论文、证据、卡片和草稿，退出重启后恢复；从上一版本升级后核对资料、阅读位置和未完成编辑。测试先使用可丢弃样本，通过“设置 → 工作区备份与恢复”保留升级前的完整 ZIP。
- 分别确认主区 PDF＋右侧卡片、白板＋右侧原文、结论＋右侧 AI 的相关操作；1440×900、1280×800 和 1024px 下布局可用。
- 使用独立用户配置验证 AI；未配置时显示实际可用状态。安装包不包含项目开发者的 `.env.local` 或模型密钥。真实模型验收单独记录，不以模拟回答替代。
- 记录系统签名与信任提示的真实情况，确认安装包附件齐全且 SHA256SUMS 匹配，再由维护者手动发布；未签名预览应保留 Pre-release 标记和说明。

浏览器站点与桌面应用使用不同资料目录，现有浏览器数据不会自动出现；Windows 和 Mac 之间也不会自动同步。需要迁移时，在原环境的“设置 → 工作区备份与恢复”导出完整 ZIP，再到目标桌面应用的相同入口恢复。ZIP 包含所有研究、原 PDF、区域图片、卡片、白板、结论和聊天，**不含 API key**；总内容上限 256 MiB，单个资产上限 64 MiB。恢复先校验 SHA-256 与引用，再在同一数据库事务中保留 `before-backup-restore` 副本并替换当前资料；它是整库替换，不合并两台电脑各自的新内容。恢复失败保留当前资料。

仅接受应用直接导出的原始 ZIP32，勿重新压缩；不支持加密、分卷或 ZIP64。文字与会话记录最多 16 MiB，全部内容最多 256 MiB、单个资产最多 64 MiB。ZIP 含原始研究材料，应保存在用户信任的位置；迁移后模型配置需重新设置。Markdown 只导出研究产出，不能当作包含原 PDF 的全量备份。跨设备自动同步和应用自动更新尚未实现。
