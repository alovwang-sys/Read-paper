# 桌面模型请求在发送前失败

日期：2026-10-16，Asia/Shanghai。基线提交：`2350b66`。root_cause：`input_validation`。

## 现象与证据

安装版配置模型后显示“已保存”，发送“你好”等消息均提示无法连接模型服务。已安装 Electron 主进程内的脱敏诊断为：

```json
{"configured":true,"hasNonLatin1":true,"hasControl":false,"hasWhitespace":true,"headerError":"TypeError"}
```

没有输出密钥、请求头或用户研究内容。该值不能构造 Authorization 请求头，请求在本机失败。独立 Node 24 与已安装 Electron 的 Node 运行时向同一公开端点发起无认证 GET，均获得 HTTP 401，说明这次失败不能仅凭“无法连接”归因为网络不可达。

合成密钥可在旧版通过 `validateAISettings`，随后构造 Headers 抛 TypeError。回归测试先复现：

```text
node --test server/ai.test.mjs desktop/settings.test.mjs
exit 1；22 tests，18 pass，4 fail
```

## 修复与验证

- 模型设置共享边界统一裁剪外围空白，拒绝内部空白、不可见/非 ASCII 字符及超过 4096 字符的密钥；错误不回显输入。
- 桌面保存复用相同验证，在加密写盘前拒绝非法值；旧配置、密钥和文件保留。旧版非法配置加载后仍可重新配置恢复。
- 保存提示只确认设置已保存，并明确模型连通性需要实际发送验证。

```text
node --test server/ai.test.mjs desktop/settings.test.mjs
exit 0；22 tests，22 pass

npm run test:desktop
exit 0；14 tests，14 pass
```

修复代码提交 `53ad974` 的 [CI run 38871861521](https://github.com/alovwang-sys/Read-paper/actions/runs/38871861521) 已全部通过：基础检查、macOS arm64、macOS x64、Windows x64 构建及各自 5 项打包应用 E2E、Required checks。三个平台附件均已生成。

本机 `npm run desktop:package` exit 0，包含类型检查、前端构建与 arm64 应用打包。确认实际 ASAR 含新增校验与正确状态文案后，正常退出并更新 `/Applications/Papertrail.app`，研究和会话历史重启恢复。

用户重新保存密钥后，现场已出现两轮完整真实回答；更新安装版后，再通过界面对原失败的“你好”按原范围重试，收到 `glm-5.3-flash` 的完整真实回答，状态“回答完成”，保存状态“已保存”。本次重试发送 0 条材料、0 轮历史，没有扩大发送范围。此结果不是演示响应。包含用户会话的截图仅保存在本地忽略目录 `out/verification/installed-live-response.png`，不提交仓库。

## 隔离与退路

调查期间主 checkout 被并行任务切到 `codex/issue-1-ai-agents` 并出现未提交修改。修复在独立 worktree `desktop-ai-key-validation` 的 `codex/desktop-installers` 分支完成，未恢复或覆盖主目录的工作。

源代码退路为基线 `2350b66`；旧版 DMG 仍保留，更新前应用保存在修复 worktree 的 `out/installed-before-53ad/Papertrail.app`。修复不改变研究数据库结构。真实密钥由用户在应用中重新粘贴，不通过聊天传递，也不自动删改其中的字符。

本项目当前同类事件登记 1 条，全局次数未知；未接入全局 PMB 工具。本地经验索引见 `.sisyphus/PMB.md`。
