import type { CardProvenance, Draft, Evidence, WorkspaceData } from '../../domain/types';
import { remapCitationNumbers } from '../../domain/citations';
import { hasFullText } from '../../domain/knowledge';
import { researchMaterialsMarkdown } from '../../domain/research';
import { linkCard, validateEvidence } from '../../services/workspace';
export { remapCitationNumbers } from '../../domain/citations';

export function insertCardReference(
  data: WorkspaceData,
  draftId: string,
  cardId: string,
  start?: number,
  end = start,
): number {
  const draft = data.drafts[draftId], card = data.cards[cardId];
  if (!draft || !card) throw new Error('结论稿或卡片已缺失。');
  const evidenceIds = [...new Set([...draft.evidenceIds, ...card.evidenceIds])];
  const body = remapCitationNumbers(card.body.trim() || card.title, card.evidenceIds, evidenceIds);
  const markers = [...new Set(card.evidenceIds)]
    .map((id) => `[${evidenceIds.indexOf(id) + 1}]`)
    .filter((marker) => !body.includes(marker)).join('');
  const first = start ?? draft.body.length, last = end ?? first;
  const insertion = `${first > 0 ? '\n\n' : ''}${body}${markers ? ` ${markers}` : ''}${last < draft.body.length ? '\n\n' : ''}`;
  const source = card.provenance && { cardId, title: card.title, provenance: structuredClone(card.provenance) };
  linkCard(data, draft.researchId, cardId);
  draft.cardRefs = [...(draft.cardRefs ?? []), { cardId, insertedAt: new Date().toISOString(), evidenceIds: [...card.evidenceIds] }];
  draft.updatedAt = new Date().toISOString();
  draft.evidenceIds = evidenceIds;
  draft.body = draft.body.slice(0, first) + insertion + draft.body.slice(last);
  if (source) draft.cardSources = [...(draft.cardSources ?? []), source];
  return first + insertion.length;
}

export function insertEvidenceReferences(data: WorkspaceData, draftId: string, evidenceIds: string[], start?: number, end = start) {
  const draft = data.drafts[draftId];
  if (!draft) throw new Error('文稿已缺失。');
  const evidence = validateEvidence(data, evidenceIds);
  if (evidence.some(e => !data.researches[draft.researchId]?.documentIds.includes(e.documentId))) throw new Error('请先将来源加入本研究。');
  draft.evidenceIds = [...new Set([...draft.evidenceIds, ...evidenceIds])];
  const insertion = [...new Set(evidenceIds)].map(id => `[${draft.evidenceIds.indexOf(id) + 1}]`).join('');
  const first = start ?? draft.body.length, last = end ?? first;
  draft.body = draft.body.slice(0, first) + insertion + draft.body.slice(last);
  draft.updatedAt = new Date().toISOString();
  return first + insertion.length;
}

export function draftConversationSources(draft: Draft) {
  const sources = new Map<string, { provenance: CardProvenance; cardIds: string[]; titles: string[] }>();
  for (const source of draft.cardSources ?? []) {
    if (source.provenance.origin === 'excerpts') continue;
    const key = JSON.stringify([source.provenance.requestId, source.provenance.selection || source.provenance.answer]);
    const existing = sources.get(key);
    if (existing) {
      if (!existing.cardIds.includes(source.cardId)) existing.cardIds.push(source.cardId);
      if (!existing.titles.includes(source.title)) existing.titles.push(source.title);
    } else sources.set(key, { provenance: source.provenance, cardIds: [source.cardId], titles: [source.title] });
  }
  return [...sources.values()];
}

export function conversationAnswerSources(source: CardProvenance) {
  const ids = source.answerEvidenceIds ?? source.context.map((item) => item.evidenceId);
  return ids.map((evidenceId, index) => ({
    number: index + 1,
    evidenceId,
    snapshot: source.context.find((item) => item.evidenceId === evidenceId),
  }));
}

export function draftSources(data: WorkspaceData, draftId: string): Evidence[] {
  const draft = data.drafts[draftId];
  if (!draft || !data.researches[draft.researchId])
    throw new Error('结论稿或所属研究已缺失，无法导出。');
  const ids = [...new Set(draft.evidenceIds)];
  remapCitationNumbers(draft.body, ids, ids);
  return ids.map((id) => {
    const evidence = data.evidence[id];
    const document = evidence && data.documents[evidence.documentId];
    if (!evidence || !hasFullText(document))
      throw new Error(`引用 ${id} 的原文或文献已缺失，请修复来源后导出。`);
    if (
      !Number.isInteger(evidence.pageIndex) ||
      evidence.pageIndex < 0 ||
      evidence.pageIndex >= document.pageCount
    )
      throw new Error(`引用 ${id} 的 PDF 页码无效，请修复来源后导出。`);
    try { validateEvidence(data, [id]); } catch {
      throw new Error(`引用 ${id} 的${evidence.kind === 'region' ? '区域来源' : '原文'}无效，请修复来源后导出。`);
    }
    if (!data.researches[draft.researchId].documentIds.includes(document.id))
      throw new Error(`引用 ${id} 的论文尚未加入当前研究，请修复关联后导出。`);
    return evidence;
  });
}

export function exportMarkdown(data: WorkspaceData, draftId: string): string {
  const sources = draftSources(data, draftId);
  const draft = data.drafts[draftId],
    research = data.researches[draft.researchId];
  const lines = [
    `# ${draft.title.trim() || '研究结论'}`,
    '',
    `研究：${research.title}`,
    '',
    '## 核心问题',
    '',
    research.question.trim() || '尚未填写核心问题。',
    '',
    '## 结论',
    '',
    draft.body.trim() || '尚未撰写结论。',
    '',
    '## 引用与原文证据',
    '',
  ];
  if (!sources.length) lines.push('本稿尚未附加原文证据。', '');
  sources.forEach((evidence, index) => {
    const document = data.documents[evidence.documentId];
    lines.push(
      `### [${index + 1}] ${document.title}`,
      '',
      `作者：${document.authors || '未记录'}  \n年份：${document.year || '未记录'}  \n文件：${document.filename}  \n文献 ID：${document.id}  \nPDF 第 ${evidence.pageIndex + 1} 页${evidence.printedPage ? `（印刷页码：${evidence.printedPage}）` : ''}  \n证据 ID：${evidence.id}`,
      '',
      ...(evidence.kind === 'region' && evidence.region ? [
        `区域说明：${evidence.quote.trim() || '框选区域（未提供文字说明）'}`,
        '',
        `区域坐标（页面归一化）：x=${evidence.region.rect.x}, y=${evidence.region.rect.y}, width=${evidence.region.rect.width}, height=${evidence.region.rect.height}  \n旋转：${evidence.region.rotation}°  \n图片尺寸：${evidence.region.width} × ${evidence.region.height} 像素  \n区域资产 ID：${evidence.region.assetId}  \n区域图片 hash：${evidence.region.hash}`,
      ] : evidence.quote.split('\n').map((line) => `> ${line}`)),
      '',
    );
  });
  const conversations = draftConversationSources(draft);
  if (conversations.length) {
    lines.push('## 相关对话来源', '', '以下为插入卡片时保存的来源快照。对话保留解释过程，不能替代论文依据；完整聊天未随本文件导出。', '');
    conversations.forEach(({ provenance: source, cardIds, titles }, index) => {
      lines.push(
        `### 对话来源 ${index + 1}：${titles.join(' / ')}`,
        '',
        `卡片 ID：${cardIds.join('、')}  \n来源研究 ID：${source.researchId}  \n会话：${source.conversationTitle || '阅读对话'}  \n会话 ID：${source.conversationId}  \n请求 ID：${source.requestId}  \n时间：${source.createdAt}${source.model ? `  \n模型：${source.model}` : ''}${source.generationRequestIds.length ? `  \n整理与修订请求 ID：${source.generationRequestIds.join('、')}` : ''}`,
        '',
        '用户问题：', '', ...source.prompt.split('\n').map((line) => `> ${line}`), '',
        '保留的回答片段：', '', ...(source.selection || source.answer).split('\n').map((line) => `> ${line}`), '',
        ...(source.incomplete ? ['来源记录不完整，仅保留以上创建时快照。', ''] : []),
      );
      const answerSources = conversationAnswerSources(source);
      if (source.materials?.length) lines.push('形成时的背景、卡片与来源摘要（与 PDF 原文依据分开）：', '', researchMaterialsMarkdown(source.materials), '');
      if (answerSources.length) {
        lines.push('原回答引用对照（独立编号，不是结论的引用编号）：', '');
        answerSources.forEach(({ number, evidenceId, snapshot }) => {
          if (!snapshot) {
            lines.push(`原答 [${number}] → 来源快照缺失（证据 ID：${evidenceId}）`, '');
            return;
          }
          lines.push(
            `原答 [${number}] → ${snapshot.title} · PDF 第 ${snapshot.pageIndex + 1} 页`,
            '',
            `文献 ID：${snapshot.documentId}  \n证据 ID：${evidenceId}`,
            '',
            ...(snapshot.kind === 'region'
              ? [`区域说明：${snapshot.quote.trim() || '保存的 PDF 框选区域，无文字说明。'}`, '',
                ...(snapshot.region ? [`区域图片 hash：${snapshot.region.hash}  \n区域坐标（页面归一化）：x=${snapshot.region.rect.x}, y=${snapshot.region.rect.y}, width=${snapshot.region.rect.width}, height=${snapshot.region.rect.height}`, ''] : [])]
              : snapshot.quote.split('\n').map((line) => `> ${line}`)),
            '',
          );
        });
      }
    });
  }
  lines.push(
    '---',
    '',
    '本文件保留文献信息、PDF 页码、原文摘录及可用的区域说明；未附带原始 PDF，未附带区域图片。区域图像需在保存原件的本地应用中查看。',
    '以上本地对象 ID 用于应用内追溯，不是可在其他设备打开的云链接。',
    '',
  );
  return lines.join('\n');
}
