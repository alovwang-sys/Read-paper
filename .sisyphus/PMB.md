# 本地故障经验

- 2026-10-17 | native-session-recovery | root_cause=session_ownership | 后台持有 writer 不等于用户打开会话；仅在 turn/start 前的精确占用拒绝允许保留历史 fork 一次，随后原子迁移 ID 保护与引用。结果未知禁止自动重发，复制 goal 必须延迟继续。证据：[事件记录](incidents/2026-10-17-native-session-recovery/record.md)。

- 2026-10-17 | windows-research-directory | root_cause=test_environment | 隔离 HOME / USERPROFILE 的桌面测试需同时提供真实 Documents 并用 app.setPath 明确配置；保留原生 IPC 与全部业务断言。macOS arm64 目标测试 2/2 通过，Windows 新 head CI 待主 agent 复核；原 artifact 缺少 IPC 错误文本。证据：[事件记录](incidents/2026-10-17-windows-research-directory/record.md)。

- 2026-10-17 | desktop-package-input-type | root_cause=process_invocation | `node --input-type=module` 会经 `fork()` 传给文件入口子进程，导致 Forge rebuilder 启动前报 ERR_INPUT_TYPE_NOT_ALLOWED；改用普通 Node 动态 import 后真实 macOS arm64 打包 exit 0。未改依赖或放宽安装策略。证据：[事件记录](incidents/2026-10-17-desktop-package-input-type/record.md)。
- 2026-10-17 | desktop-package-cached-checksums | root_cause=network_access | Electron ZIP 命中缓存后仍可能联网取校验表；最终包遇到 GitHub 超时，使用锁定 Electron npm 包附带的官方 checksums 做进程内正常校验后打包 exit 0。最终 asar 与当前服务、桌面源码及 dist 逐文件 hash 一致。证据：[续验记录](incidents/2026-10-17-desktop-package-input-type/record.md#最终包续验离线使用已校验的官方缓存)。

- 2026-10-16 | desktop-ai-key-validation | root_cause=input_validation | 密钥先经统一格式校验再加密保存；“已保存”与“可连通”分别表达。合成回归、三平台打包应用测试及更新后真实调用均已验证。证据：[事件记录](incidents/2026-10-16-desktop-ai-key-validation/record.md)。
- 2026-10-16 | release-draft-tag | root_cause=api_contract | GitHub Release 元数据 PATCH 必须重发 `tag_name`，缺省会清除草稿关联；保留严格版本断言，孤立同版本草稿写前停止。本地回归先失败，修复后发行测试 15/15 通过；真实发行重跑由主 agent 接续。证据：[事件记录](incidents/2026-10-16-release-draft-tag/record.md)。

- 2026-10-17 | update-directory-sync-blocker | root_cause=error-misattribution-and-no-safe-exit-after-durable-save | 目录同步错误不能统一归因为 CLI；已保存与目录未同步应分别表达。旧版正常 Quit/SIGTERM 均阻塞，完整数据私有备份并即时核验稳定后维护退出，原子安装与真实恢复通过；底层 errno 和目录同步故障仍待单独定位。证据：[事件记录](incidents/2026-10-17-update-directory-sync-blocker/record.md)。
