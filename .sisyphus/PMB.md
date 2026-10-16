# 本地故障经验

- 2026-10-16 | desktop-ai-key-validation | root_cause=input_validation | 密钥先经统一格式校验再加密保存；“已保存”与“可连通”分别表达。合成回归、三平台打包应用测试及更新后真实调用均已验证。证据：[事件记录](incidents/2026-10-16-desktop-ai-key-validation/record.md)。
- 2026-10-16 | release-draft-tag | root_cause=api_contract | GitHub Release 元数据 PATCH 必须重发 `tag_name`，缺省会清除草稿关联；保留严格版本断言，孤立同版本草稿写前停止。本地回归先失败，修复后发行测试 15/15 通过；真实发行重跑由主 agent 接续。证据：[事件记录](incidents/2026-10-16-release-draft-tag/record.md)。
