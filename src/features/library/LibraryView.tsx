import { useState } from 'react';
import { ArrowUpRight, BookOpen, FileText, Plus, Search } from 'lucide-react';
import type { CollectionId, ResourceRef } from '../../domain/types';
import { resourceTitle, useWorkspace } from '../../services/workspace';
import { ImportPDFButton } from '../reader/ImportPDFButton';

const names: Record<CollectionId, string> = {
  inbox: '收件箱',
  documents: '论文库',
  researches: '研究空间',
  cards: '卡片库',
  drafts: '研究产出',
};
export function LibraryView({
  collection,
  onNewResearch,
}: {
  collection: CollectionId;
  onNewResearch: () => void;
}) {
  const { data, actions } = useWorkspace();
  const [query, setQuery] = useState('');
  const [targetResearch, setTargetResearch] = useState(
    Object.keys(data.researches)[0] ?? '',
  );
  const [readingFilter, setReadingFilter] = useState('all');
  let refs: ResourceRef[] =
    collection === 'researches'
      ? Object.keys(data.researches).map((id) => ({ kind: 'research', id }))
      : collection === 'cards'
        ? Object.keys(data.cards).map((id) => ({ kind: 'card', id }))
        : collection === 'drafts'
          ? Object.keys(data.drafts).map((id) => ({ kind: 'draft', id }))
          : Object.values(data.documents)
              .filter(
                (doc) =>
                  collection !== 'inbox' ||
                  !Object.values(data.researches).some((research) =>
                    research.documentIds.includes(doc.id),
                  ),
              )
              .filter(
                (doc) =>
                  readingFilter === 'all' ||
                  doc.readingStatus === readingFilter,
              )
              .map((doc) => ({ kind: 'document', id: doc.id }));
  refs = refs.filter((ref) =>
    resourceTitle(data, ref).toLowerCase().includes(query.toLowerCase()),
  );
  const open = (ref: ResourceRef) => {
    const researchId =
      ref.kind === 'research'
        ? ref.id
        : ref.kind === 'draft'
          ? data.drafts[ref.id].researchId
          : undefined;
    actions.openResource(ref, {
      scope: researchId
        ? { kind: 'research', researchId }
        : { kind: 'library' },
      target: 'main',
    });
  };
  return (
    <div className="page-content library-view">
      <div className="eyebrow">YOUR RESEARCH LIBRARY</div>
      <div className="library-heading">
        <div>
          <h1>{names[collection]}</h1>
          <p className="page-lead">
            {collection === 'inbox'
              ? '给新材料一个研究方向。'
              : '收集、理解，再让材料成为你的知识。'}
          </p>
        </div>
        {['documents', 'inbox'].includes(collection) ? (
          <ImportPDFButton />
        ) : collection === 'researches' ? (
          <button className="primary" onClick={onNewResearch}>
            <Plus size={15} />
            新建研究
          </button>
        ) : collection === 'cards' ? (
          <button
            className="primary"
            onClick={() => {
              const id = actions.createCard([]);
              open({ kind: 'card', id });
            }}
          >
            <Plus size={15} />
            新建卡片
          </button>
        ) : null}
      </div>
      <div className="library-filters">
        <label className="search-input">
          <Search size={16} />
          <input
            aria-label="筛选资料"
            placeholder="搜索标题…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {['documents', 'inbox'].includes(collection) && (
          <select
            aria-label="阅读状态筛选"
            value={readingFilter}
            onChange={(event) => setReadingFilter(event.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="unread">待读</option>
            <option value="reading">在读</option>
            <option value="read">已读</option>
          </select>
        )}
        {['documents', 'inbox', 'cards'].includes(collection) && (
          <select
            aria-label="资料加入的研究"
            value={targetResearch}
            onChange={(event) => setTargetResearch(event.target.value)}
          >
            {Object.values(data.researches).map((research) => (
              <option key={research.id} value={research.id}>
                {research.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="section-title">
        <span className="section-heading">
          {refs.length} 个{collection === 'cards' ? '观点' : '条目'}
        </span>
      </div>
      {!refs.length ? (
        <div className="empty-state">
          <BookOpen size={32} />
          <h3>{query ? '没有找到匹配资料' : '这里还没有材料'}</h3>
          <p>
            {collection === 'inbox'
              ? '未归入研究的新 PDF 会出现在这里。'
              : '试着导入论文或建立你的第一个研究。'}
          </p>
        </div>
      ) : (
        <div className="library-grid">
          {refs.map((ref) => (
            <article key={ref.id} className={`library-card ${ref.kind}`}>
              <div className="library-card-meta">
                <span className={`type-label ${ref.kind}`}>
                  {ref.kind === 'document'
                    ? 'PDF PAPER'
                    : ref.kind === 'card'
                      ? 'IDEA CARD'
                      : ref.kind === 'draft'
                        ? 'RESEARCH NOTE'
                        : 'RESEARCH'}
                </span>
                {ref.kind === 'card' && data.cards[ref.id].needsReview && (
                  <span className="badge amber">待核查</span>
                )}
              </div>
              <button className="library-card-title" onClick={() => open(ref)}>
                <FileText size={18} />
                <h3>{resourceTitle(data, ref)}</h3>
              </button>
              <p>
                {ref.kind === 'card'
                  ? data.cards[ref.id].body.slice(0, 130) || '写下你的观点…'
                  : ref.kind === 'research'
                    ? data.researches[ref.id].question
                    : ref.kind === 'draft'
                      ? data.drafts[ref.id].body.slice(0, 130) ||
                        '等待你的第一条结论'
                      : `${data.documents[ref.id].authors} · ${data.documents[ref.id].year} · ${data.documents[ref.id].pageCount} 页`}
              </p>
              <div className="library-card-footer">
                <button className="text-button" onClick={() => open(ref)}>
                  打开 <ArrowUpRight size={14} />
                </button>
                {['document', 'card'].includes(ref.kind) && targetResearch && (
                  <button
                    className="button"
                    onClick={() => {
                      try {
                        ref.kind === 'card'
                          ? actions.associateCard(targetResearch, ref.id)
                          : actions.associateDocument(targetResearch, ref.id);
                        actions.notice('已加入研究');
                      } catch (e) {
                        actions.notice((e as Error).message);
                      }
                    }}
                  >
                    <Plus size={13} />
                    加入研究
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
