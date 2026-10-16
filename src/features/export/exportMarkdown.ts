import type { Evidence, WorkspaceData } from '../../domain/types';
import { remapCitationNumbers } from '../../domain/citations';
export { remapCitationNumbers } from '../../domain/citations';

export function draftSources(data: WorkspaceData, draftId: string): Evidence[] {
  const draft = data.drafts[draftId];
  if (!draft || !data.researches[draft.researchId])
    throw new Error('结论稿或所属研究已缺失，无法导出。');
  const ids = [...new Set(draft.evidenceIds)];
  remapCitationNumbers(draft.body, ids, ids);
  return ids.map((id) => {
    const evidence = data.evidence[id];
    const document = evidence && data.documents[evidence.documentId];
    if (!evidence || !document || !evidence.quote.trim())
      throw new Error(`引用 ${id} 的原文或文献已缺失，请修复来源后导出。`);
    if (
      !Number.isInteger(evidence.pageIndex) ||
      evidence.pageIndex < 0 ||
      evidence.pageIndex >= document.pageCount
    )
      throw new Error(`引用 ${id} 的 PDF 页码无效，请修复来源后导出。`);
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
      ...evidence.quote.split('\n').map((line) => `> ${line}`),
      '',
    );
  });
  lines.push(
    '---',
    '',
    '本文件保留文献信息、PDF 页码与原文摘录；未附带原始 PDF。',
    '',
  );
  return lines.join('\n');
}
