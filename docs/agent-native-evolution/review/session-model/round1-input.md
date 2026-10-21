你是和我们共同设计论文研究产品的Claude Code。用户刚体验首版，问：中间工作台和右侧对话记录为什么只显示单条session，不应该是多条session且每个session有多轮消息吗？要求我们先反思并与你讨论。本轮只评审，不执行开发。

已通过代码与独立浏览器复现的事实：
1 一个Research有资料和共享文稿/白板，多Conversation归researchId。Conversation.requestIds[]是一段会话的多轮；AIRequest才是单轮。另一个代码类型Session只是界面状态，不是聊天。
2 中间主区显示成果或PDF，底部唯一输入只露当前Conversation最新一轮；右侧“对话记录”显示当前Conversation全部轮次。多个Conversation仅藏在select；没有新建会话入口，也不更新话题标题和活动时间。
3 右侧select不只是浏览，它直接selectConversation改下一条消息目标，还因aiView='chat'触发兼容逻辑退回Classic。这是实测bug。
4 selectAgent会跳到该供应商最近会话，不是同一研究话题换引擎，概念混乱。
5 每次Codex研究工具运行是ephemeral独立thread，但应用仍追加同一Conversation，附最近6轮<=12000字历史。不能叫原生session无损续接。
6 我们此前过分强调成果主区/单一输入，可能把研究应有的完整对话连续性削掉了。用户希望少操作和AI native，并不要求隐藏历史。

请独立批评：真正错误是什么？给“研究→多会话→多轮消息→关联共享成果”的准确模型。比较两种具体布局：A中间完整当前会话+成果入口，右侧会话列表/参考按需切；B中间成果，右侧会话列表→详情。选一个推荐，说明唯一输入属于谁，浏览历史是否切换发送目标。不要沿用旧方案自我合理化。中文600字内。