import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, History, Plus, RefreshCw, Search } from 'lucide-react';
import type { AIConnectionId, NativeSessionSummary } from '../../domain/types';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { connectionLabel, conversationConnection, listProjectSessions, openProjectSession, refreshProjectConversation } from '../../services/agents';

export type ConversationHistoryState = { query: string; archived: boolean; filter: AIConnectionId | 'all'; scrollTop: number };
export const initialHistoryState: ConversationHistoryState = { query: '', archived: false, filter: 'all', scrollTop: 0 };

export function ConversationHistory({ onBack, state, onState }: { onBack: () => void; state: ConversationHistoryState; onState: (next: ConversationHistoryState) => void }) {
  const { data, research, actions } = useWorkspace();
  const [sessions, setSessions] = useState<NativeSessionSummary[]>([]);
  const [errors, setErrors] = useState<{ agentId: string; error: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  const [renaming, setRenaming] = useState('');
  const [title, setTitle] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const version = useRef(0);
  const refreshing = useRef(false);
  const restoreScroll = useRef<number | undefined>(state.scrollTop);
  const previousFilters = useRef({ query: state.query, archived: state.archived, filter: state.filter });
  const researchId = research?.id;
  const directoryId = research?.directory?.projectId;
  const { query, archived, filter } = state;
  const update = (next: Partial<ConversationHistoryState>) => onState({ ...state, ...next });
  const refresh = useCallback(async () => {
    if (!researchId || !directoryId || refreshing.current) return;
    const request = version.current;
    refreshing.current = true;
    setLoading(true);
    try {
      const result = await listProjectSessions(researchId);
      if (request !== version.current) return;
      setSessions(result.sessions);
      setErrors(result.errors);
      setError('');
      setLoaded(true);
    } catch (caught) {
      if (request === version.current) setError(caught instanceof Error ? caught.message : '暂时无法更新，显示上次记录。');
    } finally {
      if (request === version.current) { refreshing.current = false; setLoading(false); }
    }
  }, [researchId, directoryId]);
  useEffect(() => {
    version.current++;
    refreshing.current = false;
    setSessions([]);
    setErrors([]);
    setError('');
    setLoaded(false);
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { version.current++; refreshing.current = false; window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useLayoutEffect(() => {
    if (restoreScroll.current === undefined || (directoryId && !loaded && !error)) return;
    if (scroll.current) scroll.current.scrollTop = restoreScroll.current;
    restoreScroll.current = undefined;
  }, [directoryId, loaded, error]);
  useEffect(() => {
    const previous = previousFilters.current;
    if (query !== previous.query || archived !== previous.archived || filter !== previous.filter) {
      restoreScroll.current = undefined;
      if (scroll.current) scroll.current.scrollTop = 0;
      previousFilters.current = { query, archived, filter };
    }
  }, [query, archived, filter]);
  if (!research) return null;
  const current = getActiveConversation(data, research.id);
  const local = Object.values(data.conversations).filter(item => item.researchId === research.id && (!item.inlineSource || item.inlineSource.promoted));
  const matchingSession = (entry: typeof local[number]) => sessions.find(item => item.agentId === conversationConnection(entry) && (item.id === entry.nativeSessionRef || (!!item.nativeSessionId && item.nativeSessionId === entry.nativeSessionId)));
  const entries = [
    ...local.filter(item => !!item.archived === archived).map(item => ({ id: item.id, local: item, native: matchingSession(item), title: item.title || '新的阅读对话', connectionId: conversationConnection(item), updatedAt: item.updatedAt ?? item.createdAt ?? '' })),
    ...(!archived ? sessions.filter(item => !local.some(entry => item.agentId === conversationConnection(entry) && (entry.nativeSessionRef === item.id || (!!item.nativeSessionId && entry.nativeSessionId === item.nativeSessionId)))).map(item => ({ id: item.id, local: undefined, native: item, title: item.title || '未命名原生对话', connectionId: item.agentId, updatedAt: item.updatedAt })) : []),
  ].filter(entry => (filter === 'all' || entry.connectionId === filter) && `${connectionLabel(entry.connectionId)} ${entry.title} ${entry.local?.requestIds.map(id => `${data.requests[id]?.prompt ?? ''} ${data.requests[id]?.body ?? ''}`).join(' ') ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  async function open(entry: typeof entries[number]) {
    if (opening || !researchId) return;
    setOpening(entry.id);
    setError('');
    try {
      if (entry.local) {
        if (entry.local.archived) actions.archiveConversation(entry.local.id, false);
        actions.selectConversation(researchId, entry.local.id);
        if (entry.local.nativeSessionRef) void refreshProjectConversation(researchId, entry.local.id).catch(() => {});
      } else if (entry.native) await openProjectSession(researchId, entry.native);
      onBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法读取这段对话，请重试。');
    } finally { setOpening(''); }
  }
  return (
    <section className="ai-history-view">
      <div className="ai-subhead">
        <button className="text-button ai-history-back" aria-label="返回当前对话" disabled={!!opening} onClick={onBack}><ArrowLeft size={16} />返回对话</button>
        <h3>对话记录</h3>
        <button className="text-button" disabled={!!opening} onClick={() => { actions.createConversation(research.id); onBack(); }}><Plus size={15} />新对话</button>
      </div>
      <div className="ai-history-tools">
        <label className="ai-history-search"><Search size={16} /><input type="search" aria-label="搜索会话" placeholder="搜索标题或已读取的问答…" value={query} onChange={event => update({ query: event.target.value, scrollTop: 0 })} /></label>
        <div className="ai-history-filters" aria-label="按助手筛选">
          {(['all', 'codex', 'opencode', 'claude'] as const).map(id => <button key={id} aria-pressed={filter === id} onClick={() => update({ filter: id, scrollTop: 0 })}>{id === 'all' ? '全部' : connectionLabel(id)}</button>)}
        </div>
        <div className="ai-history-tabs"><button aria-pressed={!archived} onClick={() => update({ archived: false, scrollTop: 0 })}>最近对话</button><button aria-pressed={archived} onClick={() => update({ archived: true, scrollTop: 0 })}>已归档</button><button className="text-button ai-history-refresh" disabled={loading || !directoryId} onClick={() => void refresh()}><RefreshCw size={14} />{loading ? '读取中…' : '刷新'}</button></div>
      </div>
      <div className="ai-content-scroll" ref={scroll} onScroll={event => update({ scrollTop: event.currentTarget.scrollTop })}>
        {(error || !!errors.length) && <div className="ai-history-error" role="status">{error || '部分助手暂时无法更新，其余记录仍可打开。'}{!!errors.length && <details><summary>查看连接原因</summary>{errors.map(item => <p key={item.agentId}>{connectionLabel(item.agentId as AIConnectionId)}：{item.error}</p>)}</details>}<button className="text-button" disabled={loading || !directoryId} onClick={() => void refresh()}>重新读取记录</button></div>}
        {loading && !loaded && !entries.length && <p className="ai-history-loading" role="status">正在读取对话记录…</p>}
        {!entries.length && !loading && <div className="ai-empty"><History size={26} /><h3>{query || filter !== 'all' ? '没有找到匹配的对话' : archived ? '暂无已归档对话' : '这个研究还没有对话'}</h3><p>{query || filter !== 'all' ? '可以更换关键词或助手筛选。' : '问答、材料和卡片草稿会按研究保留。'}</p>{query && <button className="text-button" onClick={() => update({ query: '', scrollTop: 0 })}>清除搜索</button>}</div>}
        {entries.map(entry => {
          const turns = entry.local?.requestIds.map(id => data.requests[id]).filter(item => item && (!item.purpose || item.purpose === 'chat')) ?? [];
          const drafts = Object.values(data.cardDrafts).filter(draft => draft.conversationId === entry.local?.id && draft.status !== 'saved');
          const running = turns.some(item => item.status === 'generating') || entry.native?.state === 'busy' || entry.local?.nativeState === 'busy';
          const isCurrent = entry.local?.id === current?.id;
          return <article className={`ai-history-item ${isCurrent ? 'is-current' : ''}`} key={entry.id}>
            {renaming === entry.id && entry.local ? <form className="ai-history-rename" onSubmit={event => { event.preventDefault(); if (!title.trim()) return; actions.renameConversation(entry.id, title); setRenaming(''); }}><label className="ai-field">对话名称<input autoFocus value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label><div className="ai-actions"><button className="button" type="submit" disabled={!title.trim()}>保存名称</button><button className="text-button" type="button" onClick={() => setRenaming('')}>取消</button></div></form> : <>
              <button className="ai-history-open" disabled={!!opening} onClick={() => void open(entry)} aria-current={isCurrent ? 'true' : undefined}>
                <span className="ai-history-connection"><span className="ai-badge">{connectionLabel(entry.connectionId)}</span>{isCurrent && <small>当前对话</small>}{running && <span className="ai-running-badge"><span />运行中</span>}</span>
                <h4 title={entry.title}>{entry.title}</h4>
                <p>{turns.at(-1)?.prompt || (entry.native ? '点击读取原生对话历史' : '尚未发送问题')}</p>
                <small>{opening === entry.id ? '正在读取…' : entry.native?.origin === 'native' || entry.local?.nativeImported ? '来自原生客户端' : entry.local?.nativeSessionId && !entry.local.nativeSessionRef ? '旧版阅读对话' : `${turns.length} 条问答`}{drafts.length ? ` · ${drafts.length} 份草稿` : ''}{entry.local?.input ? ' · 有未发送输入' : ''}</small>
              </button>
              <div className="ai-actions"><small>{entry.updatedAt && new Date(entry.updatedAt).getTime() > 0 ? new Date(entry.updatedAt).toLocaleDateString('zh-CN') : '旧会话'}</small>{entry.local && <><button className="text-button" onClick={() => { setTitle(entry.title); setRenaming(entry.id); }}>重命名</button><button className="text-button" onClick={() => actions.archiveConversation(entry.id, !entry.local!.archived)}>{entry.local.archived ? '恢复' : '归档'}</button></>}</div>
            </>}
          </article>;
        })}
      </div>
      <div className="ai-panel-footer"><small>{directoryId ? '按研究目录读取 · 归档只影响本软件列表' : '选择研究目录后，可发现原生客户端对话'}</small></div>
    </section>
  );
}
