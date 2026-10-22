import type { AIRequest, SourceCandidate } from '../../domain/types';
import type { ResearchLiteratureSearch } from '../../domain/research-agent';
import { sourceCandidate } from '../../services/sources';
import { SourceRecommendations } from '../ai/SourceRecommendations';

export function ResearchLiteratureResults({ request, search }: { request: AIRequest; search: ResearchLiteratureSearch }) {
  const candidates: SourceCandidate[] = search.candidates.map(item => ({
    ...sourceCandidate(item.doi ? `https://doi.org/${item.doi}` : item.url, item.title),
    kind: 'paper', authors: item.authors.join(', '), year: item.year ? String(item.year) : '',
    metadataSource: `https://api.openalex.org/works/${item.providerId}`, resolvedAt: item.retrievedAt,
    ...(item.abstract ? { abstract: { text: item.abstract, url: `https://openalex.org/${item.providerId}`, retrievedAt: item.retrievedAt } } : {}),
    ...(item.pdfUrl ? { pdfUrl: item.pdfUrl } : {}),
  }));
  return <section className="research-agent-literature" aria-label={`文献检索：${search.query}`}>
    <small>OpenAlex · {search.query}{search.yearFrom || search.yearTo ? ` · ${search.yearFrom ?? '不限'}–${search.yearTo ?? '不限'}` : ''}</small>
    {search.status === 'searching' ? <p role="status">正在检索文献…</p> : search.error ? <p role="alert">{search.error}</p> : search.status === 'done' && !candidates.length ? <p>未找到文献，可以在当前会话调整关键词继续。</p> : null}
    {search.warnings?.map((warning, index) => <p className="research-agent-native-note" key={index}>{warning}</p>)}
    <SourceRecommendations request={request} candidates={candidates} heading="检索到的文献"/>
    {!!candidates.length && <small>题录与来源摘要；尚未读取 PDF。选择加入本研究后会保存到资料库，并尝试获取全文。</small>}
  </section>;
}
