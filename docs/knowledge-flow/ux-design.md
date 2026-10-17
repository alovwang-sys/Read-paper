# 知识链路体验方案

状态：设计基线 v2，用户已于 2026-10-17 认可方向，三个待确认问题按建议定稿（见“已确定的决策”）。功能尚未实现。行为要求见[需求](requirements.md)，实施切片见[开发计划](development-plan.md)。可点击原型见 [prototype.html](prototype.html)，使用示例数据。

v1 将左栏设计成编号的“① 资料 → ② 摘录 → ③ 卡片 → ④ 白板 → ⑤ 文稿”，并在每项后显示“待读 / 待整理 / 待核查”计数。用户质疑：真实研究是否会按 1–5 的顺序进行？对照研究文献后，这一设计确实有误，v2 按以下结论修改。

## 调研：真实研究怎样进行

| 来源 | 发现 | 对设计的含义 |
| --- | --- | --- |
| Pirolli & Card（2005），基于情报分析师认知任务分析提出的意义建构模型 | 材料逐步加工：原始资料 → 收集到的材料 → 证据 → 结构 → 假设 → 成品。过程包含“觅食”和“意义建构”两个回路；自下而上（由数据得出想法）与自上而下（由想法回头找数据）的工作会交替进行，次序随情况变化 | **材料的成熟度有方向，人的工作顺序没有固定方向。** 有了假设，研究者会回头补证据、找新资料 |
| Bates 采浆果模型（1989） | 检索不是一次查询得到结果；每读到新东西，问题本身都会改变，研究者顺着脚注和参考文献一点点收集 | 研究问题会随阅读变化，可随时修改；收集贯穿全过程，不只是开头一步 |
| Ellis 信息行为模型（1989）及后续应用研究 | 起始、追溯引用、浏览、筛选、追踪、提取是六类行为特征，不是先后阶段；研究发现追溯、浏览和追踪几乎会同时交替进行 | 导航应提供稳定的入口，不应表达成流水线 |
| Kuhlthau 信息搜寻过程（ISP） | 存在阶段，但主要描述人的理解和情绪：起初模糊、不确定性上升，形成焦点是转折点，之后才能有信心地收集材料 | 真正需要推进的是研究问题越来越清楚，而不是对象逐格往后移动。主页突出问题，并允许它不断变得具体 |
| Tashman & Edwards（CHI 2011），阅读日记研究 | 主动阅读常有搜索、高亮、比较和跳读；读者通常在多篇文档及其片段之间来回切换，并把阅读嵌在写报告等更大的任务中 | 阅读、摘录、写卡片、找依据应能在同一处切换，不必先完成一步再进入下一步 |
| Keshav《How to Read a Paper》 | 三遍读法：第一遍约 5–10 分钟，用来判断要不要继续读；很多论文只读第一遍就够了 | “略读过”是正常的完成状态。把所有未精读的论文都算作“待读”是错误的 |
| Ahrens《How to Take Smart Notes》；Tietze“收藏家谬误” | 写作是做笔记的目的；收藏资料不等于理解。笔记应围绕写作产生 | 鼓励把摘录写成自己的话，但应由写作和论证需要来驱动，而不是靠清空计数 |
| Forte 的 just-in-time；Readwise Reader 的 Shortlist 配置 | 等项目需要时再整理，而不是预先处理所有资料；Readwise 在“收件箱清零”之外，另提供以待读清单为主、无需清空的模式 | 未读资料和未用摘录不应显示为红点或欠账 |

### 结论

1. **v1 混淆了两件事。** 材料从原文到结论确实越来越成熟，这种方向应体现在数据关系和溯源里。但人的工作顺序没有固定方向：写结论时可能发现缺证据，再回去读；读到一半，也可能修改研究问题。左栏不应使用编号，也不应画成单向连线。
2. **“待读 / 待整理”计数会把研究工具变成待办清单。** 研究中的大部分资料只需要略读，大部分摘录只是留着备查。界面只应提醒会影响结论可信度的事。
3. **v1 只支持自下而上的路径。** 真实研究中很重要的一条路径是从论点出发，回头找证据，v1 没有覆盖。

## v2 设计原则

- **方向在数据里，不在导航里。** 资料、摘录、卡片、白板和文稿仍然分开建模，并可逐级溯源；左栏只是稳定的入口，不规定使用顺序。
- **双向可走。** 往前可以从摘录写卡片、放上白板、插入文稿；往回可以从文稿找到卡片、摘录和原文；还可以**从论点出发找依据**。
- **只提醒会影响结论的事。** 例如结论中的引用没有原文依据，或引用的卡片尚未核对原文。不提醒未读资料或未使用的摘录。
- **问题会长大。** 研究问题始终显示在主页上，可以随时修改，因为读得越多，问题会越具体。

## 信息架构

### 左栏

```text
当前研究  检索增强生成研究 ▾   …
[搜索 ⌘K]
⌂ 研究主页
阅读
  资料
  摘录
思考与写作
  卡片
  白板
     证据与论证
     实验设定对照
  文稿
     研究结论：……
──────────
资料库
设置
```

- 左栏分为“阅读”和“思考与写作”两组，分别对应 Pirolli & Card 的觅食回路和意义建构回路。组内不编号、不连线，也不显示待办计数。
- 具体白板和文稿缩进显示在类型下，表明“证据与论证”是一块白板，而不是功能栏目。
- 打开的论文、白板和文稿统一放在中央标签栏。1024px 及以下，左栏折叠为抽屉。

### 研究主页

| 区块 | 内容 | 依据 |
| --- | --- | --- |
| 我想回答的问题 | 可随时修改，并提示问题会随阅读变得具体 | Kuhlthau：形成焦点是转折点；Bates：问题会随阅读变化 |
| 接着上次 | 最近在读的论文和页码、文稿和白板。只提供回到原处的入口，不规定下一步 | 阅读日记研究：读者需要知道之前读到哪里、想到什么 |
| 结论站得住吗 | 只列出结论中没有原文依据的引用和尚未核对的卡片，并提供“找依据”或“去核对” | 自上而下补证据；引用可信度是本产品的核心承诺 |
| 最近 | 摘录、补依据、收录资料等记录 | 便于找回上下文 |

v1 的“下一步”提示和五格流程条已经删除。

### 右侧面板

模式为“摘录 / 卡片 / AI”，内容随主区变化。v2 在“卡片”模式中新增“找依据”子视图：

1. 卡片、文稿引用或主页问题列表中，没有依据的论点会显示“找依据”。
2. 右侧先列出本研究已有的摘录，可直接设为依据。
3. 没有合适的摘录时，点击“去资料里找”。右侧继续保留这个论点，用户在主区打开任意论文；选中句子后，工具条会多出“作为「某张卡片」的依据”。
4. 设为依据后，卡片标为待核查；用户确认原文确实支持后，再标为已核查。

这对应研究中带着论点回头读的场景，也是写作推动阅读的具体做法。

## 阅读状态

资料分为**在读 / 未读 / 读过**三组；“读过”包括“读完”和“略读过”。阅读器的按钮由“标为已读”改为“略读过”和“读完”两个按钮。

读完后，界面只出现一次可关闭的提示，例如：“要不要用一两句话记下：这篇对你的问题有什么用？”用户可以选择“写一张要点卡片”或“不用”。界面不再显示“还有 n 条摘录没整理”。

摘录页默认显示全部摘录，按论文分组；筛选项为“还没用到 / 已用于卡片”，不再使用“待整理”。

## 沿用 v1 的部分

- **单一添加入口。** 可以粘贴 arXiv、DOI 或链接，搜索资料库，或选择、拖入 PDF。输入框始终显示目标研究。首版只在本地识别标识格式，不联网。
- **就地补全文。** 没有全文的资料只在原条目上显示“添加 PDF”；补上后 ID 和已有引用不变。
- **重复处理。** 相同 hash 的文件直接复用；版本相近时在原条目上提示，不弹出阻断窗口。
- **阅读时一键摘录。** 选中句子后按 `H` 摘录，不打断阅读；需要写卡片时，可直接按 `C` 写成卡片。
- **按结构写作。** 文稿右侧按白板分区列出卡片；插入卡片时自动生成引用，点击 `[n]` 可以展开文稿 → 卡片 → 摘录 → PDF 页的出处链，并在主区定位原文。
- **AI 的边界。** 显式选择材料；AI 起草的卡片需要确认，并默认标为待核查。AI 推荐资料一键加入属于后续能力，依赖 issue #3。

## 对现有实现的影响

| 改动 | 说明 |
| --- | --- |
| 摘录复用 `Evidence` | 新增可选字段，记录摘录所在研究和“不需要”标记；一条摘录可以作为多张卡片的依据 |
| 阅读状态 | `readingStatus` 增加 `skimmed`，需要数据迁移 |
| 资料允许暂时没有全文 | `PaperDocument` 的文件字段改为可选，新增 DOI、arXiv、URL 标识，需要数据迁移 |
| 左栏 | 以“阅读 / 思考与写作”两组入口替换全局集合入口；收件箱归入资料库的“未加入研究”筛选 |
| 找依据 | 右侧子视图，加上阅读器工具条上的“作为……的依据”，复用 `Card.evidenceIds` 和现有校验 |
| 结论健康度 | 由文稿引用、卡片依据和核查状态推导，不新增存储 |
| arXiv / DOI 识别 | 首版只做本地格式识别并保存标识；联网补全与下载开放 PDF 属于后续任务 |

不变的部分包括共享实体与研究关联规则、`placementId` 语义、按研究恢复工作区、保存状态、AI 显式上下文及导出格式。

## 已确定的决策

2026-10-17 用户认可方向，以下三项按建议默认：

1. **左栏分组。** 采用“阅读 / 思考与写作”两组，组内不编号。若试用中发现分组标签造成误解，再改为平铺，入口与顺序不变。
2. **摘录按研究显示。** 摘录记录它在哪个研究中留下。资料页、摘录页和找依据默认只显示当前研究留下的摘录；同一篇论文在其他研究中的摘录收在“其他研究的摘录”里，可展开查看并引用。旧数据无法确定来源研究的摘录，在包含该论文的所有研究中都显示，不隐藏任何已有数据。
3. **首版不联网识别。** 输入框在本地识别 arXiv 编号、DOI 和链接的格式并保存标识，提供“打开原链接”；标题、作者、年份由用户手动填写或补 PDF 后从文件读取。联网补全元数据和自动下载开放 PDF 作为后续任务，需要单独确认服务和隐私说明。

原型中“arXiv 加入后自动下载 PDF”和“AI 推荐的资料一键加入”是后续能力的示意，不属于首版范围；AI 推荐依赖 issue #3 的文献检索。

## 原型验证

使用 Playwright 在 Chromium 中按点击路径测试：添加 arXiv、从资料库复用、为无全文资料补 PDF、阅读时摘录两句、读完后出现可关闭的要点提示、勾选摘录并让 AI 起草卡片、把卡片放上白板、点击文稿 `[1]` 查看出处并回到原文。另外测试了自上而下的路径：从文稿 `[3]` 找依据，去资料里找，在阅读器中把句子设为该卡片的依据。卡片依据已成功写入，并标为待核查。切换研究后，各研究分别恢复自己的标签。过程中没有控制台错误；1280px 和 1024px 下没有横向溢出。

| 截图 | 内容 |
| --- | --- |
| [01](screenshots/01-home-1440.png) | 研究主页：问题、接着上次、结论站得住吗 |
| [02](screenshots/02-add-arxiv-1440.png) · [03](screenshots/03-add-library-1440.png) | 单一添加入口：识别 arXiv；复用资料库中的资料 |
| [04](screenshots/04-sources-1440.png) · [05](screenshots/05-no-fulltext-1440.png) | 资料分组；无全文资料就地补 PDF |
| [06](screenshots/06-reader-select-1440.png) · [07](screenshots/07-reader-done-1440.png) | 选中后摘录；读完后的可关闭提示 |
| [08](screenshots/08-excerpts-select-1440.png) · [09](screenshots/09-ai-card-draft-1440.png) | 摘录多选；AI 起草卡片，等待确认 |
| [11](screenshots/11-board-1440.png) | 白板分区与未摆放卡片 |
| [12](screenshots/12-draft-trace-1440.png) · [16](screenshots/16-draft-trace-1280.png) | 文稿引用的出处链 |
| [17](screenshots/17-find-evidence-1440.png) · [18](screenshots/18-attach-while-reading-1440.png) · [19](screenshots/19-draft-after-attach-1440.png) | 从结论反查依据：先看已有摘录；阅读时设为依据；文稿引用随之更新 |
| [15](screenshots/15-reader-1024.png) · [17-1280](screenshots/17-find-evidence-1280.png) | 1024px 左栏改为抽屉；1280px 找依据 |

右下角的“原型演示”只用于评审时跳转场景、模拟拖入 PDF 和重置示例数据，不属于产品界面（[截图](screenshots/00-demo-menu-1440.png)）。

以上截图来自设计原型，不能作为产品实现的验收证据。

## 参考资料

- Pirolli & Card（2005）模型的二手概述：[UNH VTDP](https://vislab-ccom.unh.edu/VTDP_web_pages/VTDP_Sensemaking.html)、[Stony Brook 课程讲义](https://www3.cs.stonybrook.edu/~mueller/teaching/cse591_visAnalytics/sensemaking.pdf)。原文：*The sensemaking process and leverage points for analyst technology as identified through cognitive task analysis*，International Conference on Intelligence Analysis，2005
- Bates，*The Design of Browsing and Berrypicking Techniques*（1989）：[UCLA PDF](https://www.pages.gseis.ucla.edu/faculty/bates/articles/berrypicking.pdf)
- Ellis（1989）：[Emerald](https://www.emerald.com/insight/content/doi/10.1108/eb026843/full/html)；Google Scholar 应用研究：[JKIP](https://jurnal.unpad.ac.id/jkip/article/view/47204)
- Kuhlthau，Information Search Process：[Rutgers](https://wp.comminfo.rutgers.edu/ckuhlthau/?p=437)
- Tashman & Edwards，*Active Reading and Its Discontents*（CHI 2011）：[PDF](https://sites.cc.gatech.edu/fac/keith/pubs/chi2011-active-reading.pdf)
- Keshav，*How to Read a Paper*：[PDF](https://www.cs.princeton.edu/courses/archive/fall18/cos561/papers/HowToRead05.pdf)
- 文献综述的迭代过程：[Napier](https://bdavison.napier.ac.uk/projects/litreview/process/)、[UW–Madison](https://learn.library.wisc.edu/literature-reviews-in-the-sciences/lesson-3)、[IJDS 2022](https://www.informingscience.org/Publications/5026)
- Tietze，*Collector's Fallacy*：[zettelkasten.de](https://www.zettelkasten.de/posts/collectors-fallacy)；Ahrens 笔记概述：[Matuschak](https://notes.andymatuschak.org/How_to_Take_Smart_Notes_-_Ahrens)
- Readwise Reader 资料库配置：[官方文档](https://docs.readwise.io/reader/guides/workflows/library-configuration)
- Heptabase，Knowledge Lifecycle：[Wiki](https://wiki.heptabase.com/the-knowledge-lifecycle)
