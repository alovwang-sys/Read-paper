import { BookOpen, Target } from 'lucide-react';
import type { ResourceRef } from '../../domain/types';
import { conclusionIssues, hasFullText, researchEvidence } from '../../domain/knowledge';
import { resourceTitle, useWorkspace } from '../../services/workspace';
import { ImportPDFButton } from '../reader/ImportPDFButton';

export function ResearchView({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const research = data.researches[researchId], session = data.sessions[researchId];
  if (!research || !session) return <div className="empty-state">研究已缺失，请切换研究。</div>;
  const scope = { kind: 'research' as const, researchId };
  const issues = conclusionIssues(data, researchId);
  const hasWriting = Object.values(data.drafts).some(draft => draft.researchId === researchId && draft.body.trim());
  const recent: ResourceRef[] = (session.recentItems ?? session.openItems.slice().reverse()).filter(ref => ['document', 'board', 'draft'].includes(ref.kind)).slice(0, 3);
  const continuing = recent.length ? recent : [
    ...research.documentIds.filter(id => hasFullText(data.documents[id]) && data.documents[id].readingStatus === 'reading').slice(0, 1).map(id => ({ kind: 'document' as const, id })),
    ...Object.values(data.drafts).filter(d => d.researchId === researchId).slice(0, 1).map(d => ({ kind: 'draft' as const, id: d.id })),
    ...Object.values(data.boards).filter(b => b.researchId === researchId).slice(0, 1).map(b => ({ kind: 'board' as const, id: b.id })),
  ];
  const activities = [
    ...research.cardIds.map(id => data.cards[id]).filter(c => c?.evidenceUpdatedAt).map(c => ({ id: c.id, date: c.evidenceUpdatedAt!, text: `补依据 · ${c.title}`, ref: { kind: 'card' as const, id: c.id }, evidenceId: undefined })),
    ...researchEvidence(data, researchId).filter(e => e.createdAt).map(e => ({ id: e.id, date: e.createdAt!, text: `摘录 · ${data.documents[e.documentId]?.title}`, ref: { kind: 'document' as const, id: e.documentId }, evidenceId: e.id })),
    ...research.documentIds.map(id => data.documents[id]).filter(d => d?.updatedAt).map(d => ({ id: d.id, date: d.updatedAt!, text: `${d.readingStatus === 'read' ? '读完' : d.readingStatus === 'skimmed' ? '略读过' : '收录资料'} · ${d.title}`, ref: { kind: 'document' as const, id: d.id }, evidenceId: undefined })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  return <div className="overview page-content">
    <div className="eyebrow">RESEARCH WORKSPACE</div><h1>{research.title}</h1>
    <section className="question-box"><Target size={19} /><div><span className="section-heading">我想回答的问题</span><textarea aria-label="核心研究问题" value={research.question} onChange={event => actions.updateData(next => { next.researches[researchId].question = event.target.value; })} /><small className="muted">问题会随阅读变得更具体，随时可以修改。</small></div></section>
    <section><div className="section-title"><h2>接着上次</h2></div><div className="paper-list">{continuing.map(ref => <button key={`${ref.kind}:${ref.id}`} className="paper-row" onClick={() => actions.openResource(ref, { scope, target: 'main' })}><BookOpen size={18} /><span className="paper-details"><strong>{resourceTitle(data, ref)}</strong><small>{ref.kind === 'document' ? `PDF 第 ${(session.readers[`main:${ref.id}`]?.pageIndex ?? 0) + 1} 页` : ref.kind === 'draft' ? '继续写作' : '回到白板'}</small></span><span>打开 ↗</span></button>)}</div>{!research.documentIds.length && <div className="empty-state compact"><h3>收下一份与你的问题有关的资料</h3><ImportPDFButton /></div>}</section>
    <section aria-label="结论站得住吗"><div className="section-title"><h2>结论站得住吗</h2></div>{!hasWriting ? <p className="muted">写下第一段文稿后，在这里核查引用与出处。</p> : !issues.length ? <p className="healthy-citations">文稿里的每处引用都能回到原文。</p> : <div className="conclusion-issues">{issues.map((issue, i) => <article className="conclusion-issue" key={`${issue.draftId}:${issue.cardId}:${issue.kind}:${i}`}><div><strong>{issue.message}</strong><small className="muted">文稿：{data.drafts[issue.draftId]?.title}</small></div><button className="button" onClick={() => {
      if (issue.kind === 'no-evidence' && issue.cardId && data.cards[issue.cardId]) actions.findEvidence(issue.cardId);
      else if (issue.kind === 'needs-review' && issue.cardId) { actions.updateData(next => { next.sessions[researchId].panel.findEvidenceFor = undefined; next.sessions[researchId].panel.citation = undefined; }); actions.openResource({ kind: 'card', id: issue.cardId }, { scope, target: 'inspector' }); }
      else {
        actions.openResource({ kind: 'draft', id: issue.draftId }, { scope, target: 'main', anchor: issue.kind === 'invalid-citation' ? { citationNumber: issue.citationNumber } : undefined });
        if (issue.cardId) { actions.openResource({ kind: 'card', id: issue.cardId }, { scope, target: 'inspector' }); actions.updateData(next => { next.sessions[researchId].panel.findEvidenceFor = undefined; next.sessions[researchId].panel.citation = undefined; }); }
      }
    }}>{issue.kind === 'no-evidence' ? '找依据' : issue.kind === 'needs-review' ? '去核对' : issue.kind === 'missing-citation' ? '补引用' : '打开文稿'}</button></article>)}</div>}</section>
    <section><div className="section-title"><h2>最近</h2></div>{activities.length ? <div className="recent-activity">{activities.map(activity => <button className="paper-row" key={activity.id} onClick={() => actions.openResource(activity.ref, { scope, target: 'main', anchor: activity.evidenceId ? { evidenceId: activity.evidenceId } : undefined })}><span>{activity.text}</span><time className="muted" dateTime={activity.date}>{new Date(activity.date).toLocaleString('zh-CN')}</time></button>)}</div> : <p className="muted">阅读、摘录和收录资料的记录会出现在这里。</p>}</section>
  </div>;
}
