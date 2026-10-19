import { useMemo, useState } from 'react';
import { BookOpen, Check, ChevronDown, Plus } from 'lucide-react';
import type { AIRequest, SourceCandidate, SourceDiscovery } from '../../domain/types';
import { collectSource, extractSourceLinks, findSource, isCollectingSource, sourceRecommendation } from '../../services/sources';
import { useWorkspace } from '../../services/workspace';
import '../library/source-intake.css';

export function SourceRecommendations({ request }: { request: AIRequest }) {
  const { data, saveStatus, actions } = useWorkspace();
  const sources = useMemo(() => extractSourceLinks(request.body), [request.body]);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!sources.length) return null;
  const scope = { kind: 'research' as const, researchId: request.researchId };
  const discovery = (candidate: SourceCandidate): SourceDiscovery => {
    const recommendation = sourceRecommendation(request.body, candidate);
    return { url: candidate.url, kind: 'ai', conversationId: request.conversationId, requestId: request.id, recommendation, createdAt: request.createdAt };
  };
  const collect = async (candidate: SourceCandidate) => {
    setPending(current => [...current, candidate.url]);
    setErrors(current => ({ ...current, [candidate.url]: '' }));
    try { await collectSource(candidate, scope, discovery(candidate)); }
    catch (error) { setErrors(current => ({ ...current, [candidate.url]: error instanceof Error ? error.message : '保存失败，资料线索仍在，可重试。' })); }
    finally { setPending(current => current.filter(url => url !== candidate.url)); }
  };
  return <section className="source-recommendations" aria-label="回答中的资料">
    <div className="source-recommendations-heading"><BookOpen size={14}/><strong>回答中的资料</strong><span>{sources.length}</span></div>
    {(expanded ? sources : sources.slice(0, 3)).map(candidate => {
      const existing = findSource(candidate);
      const linked = !!existing && !!data.researches[request.researchId]?.documentIds.includes(existing.id);
      const busy = pending.includes(candidate.url) || isCollectingSource(candidate, scope);
      const saved = linked && saveStatus !== 'error' && !busy;
      return <article className="source-recommendation" key={candidate.url}>
        <strong className="source-recommendation-title">{existing?.title || candidate.title}</strong>
        <small>{(existing?.sourceKind ?? candidate.kind) === 'paper' ? '论文' : '网页'} · {new URL(candidate.url).hostname.replace(/^www\./, '')}</small>
        <div className="source-recommendation-actions">
          <button className="text-button" onClick={() => actions.openSourcePreview(candidate, scope, discovery(candidate))}>查看文献</button>
          {saved ? <><span className="source-collected"><Check size={12}/>已在本研究</span><button className="text-button" onClick={() => actions.openResource({ kind: 'document', id: existing!.id }, { scope, target: 'main' })}>打开</button></> : <button className="source-collect-button" disabled={busy} onClick={() => void collect(candidate)}><Plus size={12}/>{busy ? '正在保存…' : linked ? '重试保存' : '加入本研究'}</button>}
        </div>
        {errors[candidate.url] && <p className="source-error" role="alert">{errors[candidate.url]}</p>}
      </article>;
    })}
    {sources.length > 3 && <button className="text-button source-recommendations-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown size={13} className={expanded ? 'is-expanded' : ''}/>{expanded ? '收起' : `展开其余 ${sources.length - 3} 项`}</button>}
    <p className="source-recommendations-footnote">保存文献信息，并尝试获取全文。</p>
  </section>;
}
