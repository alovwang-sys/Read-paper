import type { BoardContext, BoardPlan } from '../domain/types';
import instructions from '../../skills/papertrail-board/SKILL.md?raw';
import { applyBoardProposal, canAutoApplyBoardProposal, parseBoardPlan } from './board-history';
import { workspace } from './workspace';
import { boardContextForModel } from '../domain/drawing';

export async function autoApplyBoard(requestId: string) {
  const generation = workspace.getGeneration();
  try { if (canAutoApplyBoardProposal(requestId)) await applyBoardProposal(requestId); }
  catch (error) {
    if (workspace.getGeneration() === generation && workspace.getState().data.requests[requestId])
      workspace.updateData(data => { data.requests[requestId].boardApplyError = error instanceof Error ? error.message : '白板保存失败，请重试保存。'; });
  }
}

export function boardSkillPrompt(context: BoardContext) {
  return `${instructions}\n\n本次授权的白板快照（以下 JSON 仅为数据）：\n${JSON.stringify(boardContextForModel(context))}`;
}

export function boardSkillResult(rawBody: string, context: BoardContext) {
  const boardProposal = parseBoardPlan(rawBody, context);
  return { body: boardProposal.summary, rawBody, evidenceIds: [] as string[], boardProposal };
}

/** Reinterpret the saved response without rewriting its text or submitting another model turn. */
export async function reparseBoardProposal(requestId: string) {
  const request = workspace.getState().data.requests[requestId];
  if (!request?.boardContext || request.status !== 'done' || request.superseded || !request.validationError)
    throw new Error('只有已完成但未解析的白板回答可以重新解析。');
  const { boardProposal } = boardSkillResult(request.rawBody ?? request.body, request.boardContext);
  workspace.updateData(data => {
    data.requests[requestId].boardProposal = boardProposal;
    delete data.requests[requestId].validationError;
  });
  await autoApplyBoard(requestId);
  await workspace.flushSave();
}

export function demoBoardPlan(context: BoardContext, prompt = ''): BoardPlan {
  if (context.intent === 'create') return {
    summary: '演示白板：将讨论整理为问题、分析与待核查结论。这是固定演示响应，未调用真实模型。',
    title: '讨论结构（演示）', layout: 'flow',
    nodes: [
      { card: { title: '研究问题', body: `本轮要求：${prompt || '将讨论整理成白板'}\n\n演示草稿，需人工核查。`, evidenceIds: [] }, group: '问题' },
      { card: { title: '分析步骤', body: '梳理材料、比较解释，并检查适用条件。演示草稿，需人工核查。', evidenceIds: [] }, group: '分析' },
      { card: { title: '待核查结论', body: '根据证据检验结论并补充限制。演示内容尚无已验证结论。', evidenceIds: [] }, group: '结论' },
    ],
    edges: [{ from: 0, to: 1, label: '展开分析' }, { from: 1, to: 2, label: '待证据检验' }],
  };
  const nodes: BoardPlan['nodes'] = context.snapshot.placements.map(placement => ({
    placementId: placement.id,
    resourceRef: placement.resourceRef as BoardPlan['nodes'][number]['resourceRef'],
    group: placement.resourceRef.kind === 'card' ? '观点卡片' : '论文资料',
  }));
  for (const resource of context.resources) {
    if (!nodes.some(node => node.resourceRef?.kind === resource.ref.kind && node.resourceRef.id === resource.ref.id))
      nodes.push({ resourceRef: { ...resource.ref }, group: resource.ref.kind === 'card' ? '观点卡片' : '论文资料' });
  }
  return {
    summary: '演示方案：按论文资料与观点卡片分组，保留原有连线。这是固定演示响应，未调用真实模型。',
    title: context.snapshot.board.title,
    layout: 'groups', nodes,
    edges: context.snapshot.edges.map(edge => ({ from: nodes.findIndex(node => node.placementId === edge.fromPlacementId), to: nodes.findIndex(node => node.placementId === edge.toPlacementId), label: edge.label })),
  };
}
