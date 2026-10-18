import { useEffect, useState } from 'react';
import { BookOpen, Check, ExternalLink, RefreshCw } from 'lucide-react';
import type { SourceCandidate, SourceDiscovery, WorkspaceScope } from '../../domain/types';
import { collectSource, findSource, resolveSource, isCollectingSource } from '../../services/sources';
import { useWorkspace } from '../../services/workspace';
import { externalSourceUrl } from './SourcesView';
import './library.css';
import './source-intake.css';

export function SourcePreview({ candidate, scope, discovery }: { candidate: SourceCandidate; scope: WorkspaceScope; discovery?: SourceDiscovery }) {
  const { data, saveStatus, actions } = useWorkspace();
  const [source, setSource] = useState(candidate);
  const [loading, setLoading] = useState(false);
  const [resolvingError, setResolvingError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setSource(candidate); setLoading(true); setResolvingError(''); setSaveError('');
    void resolveSource(candidate).then(result => { if (active) setSource(result); }).catch(error => {
      if (active) setResolvingError(error instanceof Error ? error.message : '暂未取得文献信息，可以先保存链接。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [candidate.url, retry]);
  const existing = findSource(source);
  const linked = !!existing && (scope.kind === 'library' || !!data.researches[scope.researchId]?.documentIds.includes(existing.id));
  const collecting = saving || isCollectingSource(source, scope);
  const saved = linked && saveStatus !== 'error' && !collecting;
  const save = async () => {
    setSaving(true); setSaveError('');
    try { await collectSource(source, scope, discovery); }
    catch (error) { setSaveError(error instanceof Error ? error.message : '保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  return <div className="page-content document-detail source-preview">
    <div className="muted">{linked ? '已收录 · 来源预览' : '来源预览 · 尚未收录'}</div>
    <div className="source-preview-kind"><BookOpen size={16}/>{source.kind === 'paper' ? '论文' : '网页'}<span>{new URL(source.url).hostname.replace(/^www\./, '')}</span></div>
    <h1>{source.title}</h1>
    <p className="source-preview-byline">{[source.authors, source.year].filter(Boolean).join(' · ') || '作者与年份暂未取得'}</p>
    <div className="source-preview-toolbar">
      {saved ? <><span className="source-collected"><Check size={15}/>{scope.kind === 'research' ? '已在本研究' : '已存入资料库'}</span><button className="primary" disabled={collecting} onClick={() => actions.openResource({ kind: 'document', id: existing!.id }, { scope, target: 'main' })}>打开资料</button></> : <button className="primary" disabled={collecting} onClick={() => void save()}>{collecting ? '正在保存…' : linked ? '重试保存' : scope.kind === 'research' ? '加入本研究' : '保存到资料库'}</button>}
      <a className="text-button" href={source.url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>打开原网页</a>
    </div>
    {!linked && <p className="muted">收录时会尝试获取全文，未取得也保留资料。</p>}
    {saveError && <p className="source-error" role="alert">{saveError}</p>}
    {loading && <div className="source-intake-status" role="status"><RefreshCw size={15}/>正在读取文献信息…<span>你也可以现在收下链接。</span></div>}
    {(resolvingError || source.warning) && <div className="source-intake-status"><p>{resolvingError || source.warning}</p><p className="muted">可先保存链接，以后在资料详情中补齐信息和 PDF。</p><button className="text-button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重新读取信息</button></div>}
    {!!source.identifiers && <div className="source-identifiers">{Object.entries(source.identifiers).filter(([kind]) => kind !== 'url').map(([kind, value]) => <p key={kind}>{kind === 'arxiv' ? 'arXiv' : kind.toUpperCase()}：{value}</p>)}</div>}
    {source.abstract ? <section className="source-abstract"><h2>{source.kind === 'paper' ? '作者摘要' : '原网页简介'}</h2><p>{source.abstract.text}</p><a className="text-button" href={externalSourceUrl(source.abstract.url)} target="_blank" rel="noreferrer">摘要来源 ↗</a></section> : !loading && <section className="source-abstract"><h2>摘要</h2><p className="muted">原来源暂未提供可读取的摘要。AI 的推荐说明会保留在发现记录中。</p></section>}
    {discovery?.kind === 'ai' && <section className="source-preview-discovery"><h2>发现于 AI 对话</h2><p>{data.conversations[discovery.conversationId ?? '']?.title || '原研究对话'}</p>{discovery.requestId && data.requests[discovery.requestId] && <p className="muted">{data.requests[discovery.requestId].prompt}</p>}{discovery.recommendation && <><h2>AI 推荐说明</h2><p className="source-preview-recommendation">{discovery.recommendation}</p></>}</section>}
  </div>;
}
