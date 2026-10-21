# 白板局部研究的产品参考

调研日期：2026 年 10 月 20 日。证据包括产品官方帮助文档、官方博客和 TikHub 返回的 YouTube 公开检索元信息；没有登录这些竞品操作，也没有观看视频或提取视频全文。以下将能力事实与本项目的设计推论分别说明。

第二轮按用户要求补查 Miro、Google、Elicit、Heptabase 与 Anthropic 的上下文及连续探索规则，来源、事实和采纳边界集中于[第二轮核实](review/context-audit.md)。没有新增 TikHub 数据调用。具体方案以[上下文设计](context-design.md)为准；各产品公开资料没有给出可直接照搬的统一最佳 token 数。

## Heptabase

[Work with AI](https://wiki.heptabase.com/work-with-ai) 的 Overview、Chatting with Cards 与 Chatting with Whiteboards 说明：用户可以从板上卡片开启聊天，选择材料进入上下文，再把有价值的回答收回白板。本地已有的[白板与 AI 图](../references/heptabase/03-board-and-ai.png)和[分区图](../references/heptabase/04-board-sections.png)已实际打开检查。

本项目采用节点附近操作、同一右侧聊天和回答收为卡片。该文档不能证明其具有完整的“任意小问题 → 学术论文搜索 → 全文入库”流程。

[What Space content can the AI Agent access?](https://support.heptabase.com/en/articles/13009956-what-space-content-can-the-ai-agent-access) 还说明，Heptabase 的 Space search 默认开启，关闭后也不等于只能访问手动附件。本项目沿用已有的显式材料与提交快照约定，不照搬其默认全空间探索策略。

## Elicit

[Research Agent](https://support.elicit.com/en/articles/14756886-elicit-s-research-agent)，页面日期 2026-09-17。官方描述了从 Library 或 collection 开始、限定或扩大研究范围、持续追问、区分库内与新发现来源，以及直接保存候选论文并检查重复。努力程度选择器被标为 limited beta，不能据此承诺所有账号都可见。

本项目采用一个局部问题保留一段持续会话、结果可以直接收录，以及库内／新发现状态。未找到其以白板任意节点开启这些操作的直接证据。

## ResearchRabbit

[How to search in ResearchRabbit](https://learn.researchrabbit.ai/en/articles/12454528-how-to-search-in-researchrabbit) 描述以论文作为种子、选中搜索结果作为下一轮种子、保存到 collection，以及返回前一步的探索方式。

[How ResearchRabbit uses AI and where we don't](https://learn.researchrabbit.ai/en/articles/13545485-how-researchrabbit-uses-ai-and-where-we-don-t) 解释核心推荐使用文献网络，不依赖 LLM。

本项目采用逐轮探索和可返回的起点。网络或内容相近只代表值得检查，不能自动标成支持或反对原观点。

## Litmaps

[Do a literature review with Litmaps](https://docs.litmaps.com/en/articles/9082008-do-a-literature-review-with-litmaps) 描述用 More like this 收下推荐，再刷新探索；新收下的文献参与后续推荐。[Create a Litmap](https://docs.litmaps.com/en/articles/9057179-create-a-litmap) 说明可从已选和已导入文章建图。

[Find research gaps](https://docs.litmaps.com/en/articles/9092883-find-research-gaps-with-litmaps) 和[搜索算法](https://docs.litmaps.com/en/articles/9029858-search-algorithms-in-litmaps) 描述 Similar Text 等路径，可以补充纯引用网络的局限。[PDF 下载说明](https://docs.litmaps.com/en/articles/10471794-download-an-article-s-pdf-in-litmaps) 区分公开获取和需要权限的论文。

本项目采用候选由用户接纳后加入研究，继续扩大探索范围；文献收录与 PDF 获取分别显示状态。

## Kosmik

[AI Asset Finder](https://www.kosmik.app/blog/kosmik-ai-asset-finder) 描述选中一组画布内容，再发现主题或视觉方向相关的图片、视频和链接，保留来源。

它适合作为画布内发现材料的交互参考，不能证明学术检索、文献去重或引用论证能力。本项目不采用视觉相似度作为论文支持证据。

## TikHub 公开演示检索

使用用户指定的 [TikHub skill](/Users/amos/.codex/skills/tikhub/SKILL.md)，通过已发现的 `youtube_web_v2_get_general_search_v2` 工具，查询 `Heptabase AI whiteboard research`。仅调用一次数据搜索，读取首页 18 条普通视频，不翻页；没有抓取评论，也不据此推断用户满意度。响应 code 为 200。原始响应中的时间为 `2026-10-20 04:55:49 America/Los_Angeles`，对应北京时间 2026-10-20 19:55:49。

| 返回的官方频道视频 | 视频 ID | 返回的发布时间文字 | 返回的浏览量文字 |
| --- | --- | --- | --- |
| [Organize Your Entire Knowledge Base with AI](https://www.youtube.com/watch?v=BsB7Hr6bFHc) | BsB7Hr6bFHc | 2 months ago | 2,900 views |
| [Upgrade How You Read with AI Skills](https://www.youtube.com/watch?v=UDHKmQhPOWw) | UDHKmQhPOWw | 2 months ago | 2,319 views |
| [Sense-making with whiteboards](https://www.youtube.com/watch?v=HgvR2QkfwG0) | HgvR2QkfwG0 | 2 years ago | 100,305 views |

这些是返回当时的搜索元信息，发布时间保留接口原文，浏览量会变化。视频链接供后续观看，能力结论以以上官方文档为依据。可审阅的返回字段、请求 ID 和分页信息保存在 [TikHub 检索记录](sources/tikhub-youtube.json)；未保存带签名的缓存 URL。

## 检索来源与原型文献

后续实现优先采用 [OpenAlex API](https://help.openalex.org/api/) 的单一来源搜索、筛选和文献记录。它提供可编程元数据查询，不能由此推定每篇都有可下载 PDF；真实接入尚未运行。本轮不承诺固定费用、返回速度或学科召回率。

原型三篇文献的标题、首位作者、年份和链接已核对 arXiv 页面；年份统一使用首次提交年份。显示的“为何相关”为设计示例，只表示阅读线索。

| 文献 | 元信息来源 | 与示例问题的关联 |
| --- | --- | --- |
| Lost in the Middle: How Language Models Use Long Contexts · Nelson F. Liu 等 · 2023 | [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) | 摘要讨论相关信息在上下文中的位置影响，提示需要检查信息组织条件 |
| Corrective Retrieval Augmented Generation · Shi-Qi Yan 等 · 2024 | [arXiv:2401.15884](https://arxiv.org/abs/2401.15884) | 摘要讨论检索质量评估和纠正，提供核查噪声影响的线索 |
| Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection · Akari Asai 等 · 2023 | [arXiv:2310.11511](https://arxiv.org/abs/2310.11511) | 提供按需检索与自我评估方向的阅读线索 |

原型没有实时搜索这三篇论文，没有导入原始 PDF，也没有构建可作为原文证据的页码、摘录或定位矩形。
