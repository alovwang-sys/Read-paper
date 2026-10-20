import type { Conversation, WorkspaceData } from '../domain/types';

const boardCommand = (text: string) => text.replace(/^(?:(?:请你?|麻烦你?|帮我|帮忙|给我|现在|直接|再|先|继续)\s*)+/, '');

export function isBoardNonAction(prompt: string): boolean {
  const text = prompt.trim();
  if (/^(?:我|我们)(?:已经|刚刚?|曾经|正在|会|将|打算|计划|准备)|^(?:i|we)(?:['’](?:ve|ll|m|re)|\s+(?:already|just|have|had|will|am|are|was|were|created|drew|generated|made|built|plan|intend))\b/i.test(text)) return true;
  if (/不是(?:要|让)|没有(?:要求|让|要)|[“"「][^”"」]*(?:画|绘制|生成|创建)[^”"」]*(?:白板|流程图|架构图|关系图)[^”"」]*[”"」]/.test(text)) return true;
  if (!text || /不要|不用|无需|别(?:再|给|帮|把|画|生成|创建|做|输出|绘制|制作|整理|转换)|暂不|不需要|不想|不(?:生成|画|绘制|输出|创建|制作|新建)|如果|假如|假设|要是|以后|将来|等[^。！？\n]{0,30}再|能不能|能否|可不可以|是否|会不会|支持|怎么|如何|什么是|解释|介绍|含义|什么意思|(?:可以|能|会)[^。！？\n]*[吗？?]/i.test(text)) return true;
  if (/校对|翻译|转述|复述|转发|语病|语法|措辞|检查[^。！？\n]{0,12}(?:句|文本|描述)|已经(?:画|绘制|生成|创建)|(?:画|绘制|生成|创建)[^。！？\n]{0,45}(?:完成了|完毕)/.test(text)) return true;
  const command = boardCommand(text);
  if (/^(?:画(?:成|出|到)?|绘制|生成|创建|制作|新建)(?:了|过)|(?:白板|流程图|架构图|关系图)了[。！!]?$/u.test(command)) return true;
  return /\b(?:can|could|would|should|if|explain|what|how|don't|do not|never|translate|proofread|paraphrase)\b/i.test(text);
}

export function detectBoardIntent(prompt: string): 'create' | 'edit' | undefined {
  if (isBoardNonAction(prompt)) return;
  const text = prompt.trim(), command = boardCommand(text);
  if (/^(?:修改|调整|整理(?!成)|重新布局|重排|编辑|更新|移动|删除)[^。！？\n：:]{0,35}白板|^(?:把|将)(?:这个|当前|现有|已有|原来|原先|选中)?白板[^。！？\n：:]{0,30}(?:修改|调整|整理|重新布局|重排|编辑|更新)/.test(command)) return 'edit';
  if (/^(?:(?:把|将)[^。！？\n：:]{1,45})?(?:画(?:成|出|到)?|绘制|生成|制作|创建|新建|做成|整理成|转成|转换成|输出)[^。！？\n：:]{0,45}(?:白板|流程图|架构图|关系图)/.test(command)) return 'create';
  if (/^(?:(?:please|kindly|just|now|help me)\s+)*(?:draw|create|generate|make|build)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|this)\s+)?(?:(?:new|simple|editable|research|method|system)\s+){0,3}(?:whiteboard|flowchart|architecture diagram|relationship diagram)\b/i.test(text)) return 'create';
}

export function boardSuggestion(data: WorkspaceData, conversation: Conversation): { requestId: string; reason: string } | undefined {
  if (conversation.boardSuggestionDismissed || conversation.boardSuggestionRequestId) return;
  const request = conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1);
  if (!request || request.status !== 'done' || request.boardContext || request.superseded || request.validationError || request.legacy || request.nativeImported || (request.purpose && request.purpose !== 'chat')) return;
  const body = request.body;
  const items = body.split('\n').filter(line => /^\s*(?:[-*+]\s+|\d+[.)、]\s*|\|[^|]+\|)/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line));
  const chain = body.match(/[^\n→]{2,60}\s*→\s*[^\n→]{2,60}\s*→\s*[^\n→]{2,60}/);
  if ((items.length >= 3 || chain) && /步骤|流程|阶段|依赖|输入|输出|对比|比较|优缺点|支持|反例|适用条件|限制|模块|→/.test(body))
    return { requestId: request.id, reason: '这段回答包含多个步骤、关系或对比项，可以整理到白板。' };
}
