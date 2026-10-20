import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { boardSuggestion, detectBoardIntent } from '../../src/services/board-intent';

describe('单次白板意图', () => {
  it.each(['帮我把这些内容画成白板', '生成一张方法架构图', '请绘制输入到输出的流程图', '把这段转成关系图', '请将上述步骤整理成白板', '直接生成一张白板', '请帮我生成关系图', 'Draw a flowchart for these steps', 'Please create a simple architecture diagram'])('识别明确创建：%s', prompt => {
    expect(detectBoardIntent(prompt)).toBe('create');
  });
  it.each(['请检查这句话有没有语病：生成一张流程图', '我已经画出流程图了', '生成了一张白板', '画出流程图了。', '把生成一张流程图这句话翻译成英文', '请转述他说要生成白板的意思', 'I created a whiteboard', 'I will create a whiteboard later', 'Please translate: draw a flowchart', 'Please proofread this sentence: create a whiteboard', 'They asked me to create a whiteboard'])('只执行主句画图动作，不执行校对或陈述中的文字：%s', prompt => {
    expect(detectBoardIntent(prompt)).toBeUndefined();
  });
  it.each(['不要生成白板', '别画流程图', '别输出流程图', '不生成白板', '别把内容画成白板', '我不是让你生成白板', '我没有要求画白板', '他说“生成一张架构图”', '如果画成白板会怎样', '你能不能生成架构图？', '你能画一张架构图吗', '可以帮我画白板吗', '如何绘制流程图', '解释什么是架构图', '生成架构图是什么意思', '我们来讨论系统架构', '这个架构有哪些限制', '以后再把它画成白板', '等论文读完再画成白板', 'Can you create a whiteboard?', 'Do not draw a flowchart', "Please don't draw a flowchart", 'Never create a whiteboard'])('不把讨论当执行：%s', prompt => {
    expect(detectBoardIntent(prompt)).toBeUndefined();
  });
  it.each(['调整当前白板的分组', '整理这个白板', '把现有白板重新布局'])('既有白板需要明确目标：%s', prompt => {
    expect(detectBoardIntent(prompt)).toBe('edit');
  });
});

describe('无需额外模型调用的白板建议', () => {
  const fixture = (body: string) => {
    const data = createSeed(), conversation = data.conversations['conversation-research-a'];
    conversation.requestIds = ['answer'];
    data.requests.answer = { id: 'answer', researchId: 'research-a', conversationId: conversation.id, prompt: '解释方法', body, context: [], evidenceIds: [], createdAt: new Date().toISOString(), status: 'done', purpose: 'chat' };
    return { data, conversation };
  };
  it.each(['1. 输入资料\n2. 编码模块\n3. 输出结果', '处理流程：输入文本 → 编码处理 → 输出数字'])('明确多项目结构才建议：%s', body => {
    const { data, conversation } = fixture(body); expect(boardSuggestion(data, conversation)?.requestId).toBe('answer');
  });
  it.each(['很长的普通文字。'.repeat(200), '步骤只有一个：读取输入。', '- 苹果\n- 香蕉\n- 西瓜', '流程还有待研究。'])('长度或普通列表不触发：%s', body => {
    const { data, conversation } = fixture(body); expect(boardSuggestion(data, conversation)).toBeUndefined();
  });
  it('同一会话已认领或忽略后不再产生建议', () => {
    const { data, conversation } = fixture('1. 输入资料\n2. 编码模块\n3. 输出结果');
    conversation.boardSuggestionRequestId = 'answer'; expect(boardSuggestion(data, conversation)).toBeUndefined();
    conversation.boardSuggestionRequestId = undefined; conversation.boardSuggestionDismissed = true;
    expect(boardSuggestion(data, conversation)).toBeUndefined();
  });
  it('未完成回答和白板方案不再建议', () => {
    const { data, conversation } = fixture('1. 输入资料\n2. 编码模块\n3. 输出结果');
    data.requests.answer.status = 'generating'; expect(boardSuggestion(data, conversation)).toBeUndefined();
  });
});
