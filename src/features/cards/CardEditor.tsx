import { CircleHelp, History, Layers } from 'lucide-react';
import { useWorkspace, validateEvidence } from '../../services/workspace';
import { EvidenceList } from '../evidence/EvidenceList';
import { conversationAnswerSources } from '../export/exportMarkdown';
import './cards.css';

export function CardEditor({ cardId }: { cardId: string }) {
  const { data, actions, saveStatus } = useWorkspace();
  const card = data.cards[cardId];
  if (!card)
    return (
      <div className="empty-state">
        <Layers size={28} />
        <h3>卡片已缺失</h3>
        <p>请从卡片库重新打开，或恢复本地资料。</p>
      </div>
    );
  const researchTitles = Object.values(data.researches)
    .filter((research) => research.cardIds.includes(cardId))
    .map((research) => research.title);
  const source = card.provenance;
  const answerSources = source ? conversationAnswerSources(source) : [];
  const hasPaperSource = card.evidenceIds.some((id) => {
    try {
      const [evidence] = validateEvidence(data, [id]);
      const snapshot = source?.context.find((item) => item.evidenceId === id);
      return !snapshot?.documentHash || snapshot.documentHash === data.documents[evidence.documentId].hash;
    } catch { return false; }
  });
  const update = (field: 'title' | 'body', value: string) =>
    actions.updateData((data) => {
      if (data.cards[cardId]) data.cards[cardId][field] = value;
    });
  return (
    <section className="card-editor" aria-label="观点卡片编辑器">
      <div className="card-editor-kind">
        <Layers size={14} />
        <span>观点卡片</span>
        <small>
          {saveStatus === 'saved'
            ? '已保存'
            : saveStatus === 'saving'
              ? '保存中'
              : saveStatus === 'error'
                ? '保存失败，内容已保留'
                : '待保存'}
        </small>
      </div>
      <label className="field card-title-field">
        卡片标题
        <input
          aria-label="卡片标题"
          placeholder="用一句话表达一个观点"
          value={card.title}
          onChange={(event) => update('title', event.target.value)}
        />
      </label>
      <label className="field card-body-field">
        你的理解
        <textarea
          aria-label="卡片正文"
          placeholder="用自己的话写下观点、条件或尚待核查的问题…"
          value={card.body}
          onChange={(event) => update('body', event.target.value)}
        />
      </label>
      <label className="card-review-toggle">
        <input
          type="checkbox"
          checked={card.needsReview}
          onChange={(event) =>
            actions.updateData((data) => {
              data.cards[cardId].needsReview = event.target.checked;
            })
          }
        />
        <CircleHelp size={14} />
        待核查
      </label>
      <div className="card-research-info">
        <span className="muted">用于研究</span>
        <p>
          {researchTitles.length
            ? researchTitles.join(' · ')
            : '尚未加入研究，可从卡片库关联。'}
        </p>
      </div>
      {source && !hasPaperSource && <p className="card-unsourced">仅对话来源{card.needsReview ? ' · 待核查' : ''}</p>}
      <EvidenceList evidenceIds={card.evidenceIds} target="inspector" heading="论文依据" snapshots={source?.context} />
      {!card.evidenceIds.length && !source && (
        <p className="card-unsourced">
          此卡片暂无结构化来源。核查观点时请从 PDF 原文创建证据。
        </p>
      )}
      <section className="conversation-source" aria-label="卡片相关对话">
        <h3><History size={15} />相关对话</h3>
        {source ? <>
          <strong>{source.conversationTitle || '阅读对话'}</strong>
          <p className="muted">{source.createdAt}{source.model ? ` · ${source.model}` : ''}</p>
          {source.incomplete && <p className="card-unsourced">来源记录不完整，以下保留创建时的快照。</p>}
          <p>原始问题：{source.prompt}</p>
          <blockquote>{source.selection || source.answer}</blockquote>
          {!!answerSources.length && <div aria-label="原回答引用对照">
            <p className="muted">原回答引用对照：以下为原答的独立编号，不是卡片或结论的引用编号。</p>
            {answerSources.map(({ number, evidenceId, snapshot }) => (
              <div key={`${number}-${evidenceId}`}>
                <strong>原答 [{number}] → {snapshot?.title || '来源快照缺失'}</strong>
                {snapshot ? <>
                  <p className="muted">PDF 第 {snapshot.pageIndex + 1} 页 · {snapshot.kind === 'region' ? '区域证据' : '原文证据'}</p>
                  <blockquote>{snapshot.quote || (snapshot.kind === 'region' ? '保存的 PDF 框选区域，无文字说明。' : '原文摘录未保留。')}</blockquote>
                </> : <p className="card-unsourced">证据 ID：{evidenceId}。原始引用编号已保留，来源内容暂不可用。</p>}
              </div>
            ))}
          </div>}
          <button className="button" onClick={() => actions.openConversationSource(source, { kind: 'card', id: cardId })}>
            <History size={14} />查看相关对话
          </button>
        </> : <p className="muted">此卡片未关联对话。手工卡片与旧版卡片不会自动推断聊天来源。</p>}
      </section>
    </section>
  );
}
