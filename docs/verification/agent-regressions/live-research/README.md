# 真实 Codex 与文献检索冒烟

2026-10-21 20:11:57–20:12:27（北京时间），单次真实运行成功，耗时 30.385 秒。本机 `codex-cli 0.162.1`，实际返回模型 `gpt-6.1-sol`；未用模型或文献结果测试桩，未重试生成。

[探针源码](probe.mjs) 启动独立的临时 HTTP 服务，通过当前 `createResearchHandler` 和真实 Codex app-server 执行一个公开合成问题。请求的 `sources=[]`、`history=[]`，没有读取用户研究或应用工作区，没有收录工具和资料库写入。文献工具仅把模型实际选择的短查询 `retrieval augmented generation evidence selection` 发给现有 `127.0.0.1:8787` OpenAlex HTTP 服务；没有读取或输出 `.env`、令牌或模型配置。整次探针最多 180 秒、研究空闲最多 120 秒、单次文献 HTTP 最多 20 秒。

[完整筛选记录](result.json) 保存合成输入、查询参数、HTTP 状态、真实公开题录、模型正文和 NDJSON 事件。记录保留应用可见文本与工具结果，未记录私有推理；`done` 中的原生会话 ID 只记录是否存在，没有保存实际 ID。该证据只证明本次运行，不代表真实用户资料的分析质量。

实际结果：

- Codex 调用 `search_literature` 一次；文献 HTTP 返回 200 和 10 条真实候选。
- 新研究 HTTP 依次发出候选的 `searching`、`done` 事件，再以模型 `done` 完成。
- 模型回答包含工具返回的前两条题名及对应 DOI／来源 URL，并明确注明尚未读 PDF。
- `readPages=[]`，没有 `artifact` 事件；没有创建文稿或导入资料库。
- 注册工具限定为 `search_literature`、`search_sources`、`read_page`、`submit_result`；本轮没有授权任何论文页。

这次前两条题录标题相同，分别指向[出版版本 DOI](https://doi.org/10.18653/v1/2026.acl-long.1620)和 [arXiv 版本](https://arxiv.org/abs/2605.13277)，拥有不同的 OpenAlex ID。因此验证的是“两条真实记录”，不是“两篇独立论文”；跨版本识别与合并尚未完成，不按相似标题自动合并。

本次没有验证前端点击收录、真实 PDF 下载或安装包升级，这些应使用独立的界面和保存测试。探针已有 `result.json` 防重复执行保护；再次实测需明确建立另一份记录，避免意外重复模型调用。
