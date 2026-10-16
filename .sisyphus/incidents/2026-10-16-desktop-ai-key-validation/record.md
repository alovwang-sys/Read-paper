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

打包应用 E2E、安装版更新和用户重新配置后的真实调用：待验证，不能以合成测试替代。

## 隔离与退路

调查期间主 checkout 被并行任务切到 `codex/issue-1-ai-agents` 并出现未提交修改。修复在独立 worktree `desktop-ai-key-validation` 的 `codex/desktop-installers` 分支完成，未恢复或覆盖主目录的工作。

源代码退路为基线 `2350b66`；旧版 DMG 仍保留。修复不修改研究数据库。真实密钥由用户在应用中重新粘贴，不通过聊天传递，也不自动删改其中的字符。

本项目当前同类事件登记 1 条，全局次数未知；未接入全局 PMB 工具。本地经验索引见 `.sisyphus/PMB.md`。
