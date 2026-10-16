import { useState } from 'react';
import { ArrowLeft, History, Plus, Search } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';

export function ConversationHistory({ onBack }: { onBack: () => void }) {
  const { data, research, actions } = useWorkspace();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState('');
  const [title, setTitle] = useState('');
  if (!research) return null;
  const entries = Object.values(data.conversations)
    .filter(
      (item) =>
        item.researchId === research.id &&
        !!item.archived === archived &&
        `${item.title ?? ''} ${item.requestIds.map((id) => `${data.requests[id]?.prompt ?? ''} ${data.requests[id]?.body ?? ''}`).join(' ')}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      (b.updatedAt ?? b.createdAt ?? '').localeCompare(
        a.updatedAt ?? a.createdAt ?? '',
      ),
    );
  return (
    <section className="ai-history-view">
      <div className="ai-subhead">
        <button
          className="icon-button"
          aria-label="返回当前对话"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <h3>阅读对话</h3>
        <span className="ai-badge">当前研究</span>
      </div>
      <div className="ai-content-scroll">
        <p className="ai-eyebrow">A RECORD OF YOUR THINKING</p>
        <label className="ai-history-search">
          <Search size={16} />
          <input
            type="search"
            aria-label="搜索会话"
            placeholder="搜索标题或问答内容…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="ai-history-tabs">
          <button aria-pressed={!archived} onClick={() => setArchived(false)}>
            最近对话
          </button>
          <button aria-pressed={archived} onClick={() => setArchived(true)}>
            已归档
          </button>
        </div>
        {!entries.length && (
          <div className="ai-empty">
            <History size={26} />
            <h3>
              {query
                ? '没有找到匹配的对话'
                : archived
                  ? '暂无已归档对话'
                  : '从一个问题开始'}
            </h3>
            <p>
              {query
                ? '可以更换关键词或清除搜索。'
                : '问答、材料和卡片草稿会按研究保留。'}
            </p>
            {query && (
              <button className="text-button" onClick={() => setQuery('')}>
                清除搜索
              </button>
            )}
          </div>
        )}
        {entries.map((entry) => {
          const turns = entry.requestIds
            .map((id) => data.requests[id])
            .filter(
              (item) => item && (!item.purpose || item.purpose === 'chat'),
            );
          const drafts = Object.values(data.cardDrafts).filter(
            (draft) =>
              draft.conversationId === entry.id && draft.status !== 'saved',
          );
          return (
            <article className="ai-history-item" key={entry.id}>
              {renaming === entry.id ? (
                <form
                  className="ai-history-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!title.trim()) return;
                    actions.renameConversation(entry.id, title);
                    setRenaming('');
                  }}
                >
                  <label className="ai-field">
                    对话名称
                    <input
                      autoFocus
                      value={title}
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <div className="ai-actions">
                    <button
                      className="button"
                      type="submit"
                      disabled={!title.trim()}
                    >
                      保存名称
                    </button>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setRenaming('')}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <button
                    className="ai-history-open"
                    onClick={() => {
                      if (entry.archived)
                        actions.archiveConversation(entry.id, false);
                      actions.selectConversation(research.id, entry.id);
                      onBack();
                    }}
                  >
                    <h4>{entry.title || '新的阅读对话'}</h4>
                    <p>{turns.at(-1)?.prompt ?? '尚未发送问题'}</p>
                    <small>
                      {turns.length} 条问答
                      {drafts.length ? ` · ${drafts.length} 份草稿` : ''}
                      {entry.input ? ' · 有未发送输入' : ''}
                    </small>
                  </button>
                  <div className="ai-actions">
                    <small>
                      {entry.updatedAt || entry.createdAt
                        ? new Date(
                            entry.updatedAt ?? entry.createdAt!,
                          ).toLocaleDateString('zh-CN')
                        : '旧会话'}
                    </small>
                    <button
                      className="text-button"
                      onClick={() => {
                        setTitle(entry.title ?? '');
                        setRenaming(entry.id);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        actions.archiveConversation(entry.id, !entry.archived)
                      }
                    >
                      {entry.archived ? '恢复' : '归档'}
                    </button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
      <div className="ai-panel-footer">
        <small>新对话不携带旧材料与历史</small>
        <button
          className="primary"
          onClick={() => {
            actions.createConversation(research.id);
            onBack();
          }}
        >
          <Plus size={15} />
          新对话
        </button>
      </div>
    </section>
  );
}
