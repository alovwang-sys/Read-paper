import { CircleHelp, Layers } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import { EvidenceList } from '../evidence/EvidenceList';
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
      <EvidenceList evidenceIds={card.evidenceIds} target="inspector" />
      {!card.evidenceIds.length && (
        <p className="card-unsourced">
          此卡片暂无结构化来源。核查观点时请从 PDF 原文创建证据。
        </p>
      )}
    </section>
  );
}
