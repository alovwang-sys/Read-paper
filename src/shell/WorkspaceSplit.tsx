import type { ReactNode } from 'react';
import { BookOpen, Layers, Rows2, X } from 'lucide-react';
import type { ReaderTarget, ResourceRef } from '../domain/types';
import { resourceTitle, useWorkspace } from '../services/workspace';
import './workspace-split.css';

export function WorkspaceSplit({ primary, renderResource }: { primary: ResourceRef; renderResource: (ref: ResourceRef, target: ReaderTarget) => ReactNode }) {
  const { data, session, research, actions } = useWorkspace();
  const rememberedSplit = session.mainSplit;
  const split = rememberedSplit?.open === false ? undefined : rememberedSplit;
  const documents = (research?.documentIds ?? Object.keys(data.documents)).filter(id => data.documents[id]).map(id => ({ kind: 'document' as const, id }));
  const cards = (research?.cardIds ?? Object.keys(data.cards)).filter(id => data.cards[id]).map(id => ({ kind: 'card' as const, id }));
  const choices = [...documents, ...cards];
  const key = (ref: ResourceRef) => `${ref.kind}:${ref.id}`;
  const compare = choices.find(ref => rememberedSplit && key(ref) === key(rememberedSplit.ref))
    ?? (primary.kind === 'document' || primary.kind === 'card' ? primary : choices[0]);
  function select(value: string, target: 'main' | 'main-secondary') {
    const ref = choices.find(item => key(item) === value);
    if (!ref) return;
    try { actions.openResource(ref, { scope: data.scope, target }); }
    catch (problem) { actions.notice(problem instanceof Error ? problem.message : '暂时无法打开，请重试。'); }
  }
  function picker(ref: ResourceRef, target: 'main' | 'main-secondary') {
    return <label className="workspace-pane-picker">
      <span>{target === 'main' ? '阅读位置 1' : '阅读位置 2'}</span>
      <select aria-label={target === 'main' ? '选择主窗内容' : '选择对照内容'} value={key(ref)} onChange={event => select(event.target.value, target)}>
        {!choices.some(item => key(item) === key(ref)) && <option value={key(ref)}>{resourceTitle(data, ref)}</option>}
        {!!documents.length && <optgroup label="论文与资料">{documents.map(item => <option key={key(item)} value={key(item)}>{resourceTitle(data, item)}</option>)}</optgroup>}
        {!!cards.length && <optgroup label="知识卡片">{cards.map(item => <option key={key(item)} value={key(item)}>{resourceTitle(data, item)}</option>)}</optgroup>}
      </select>
    </label>;
  }
  return <section className={`pdf-reader-layout workspace-split ${split ? `pdf-split-${split.layout}` : ''}`} aria-label="中央阅读与对照">
    <div className="pdf-layout-toolbar">
      <span>{primary.kind === 'card' ? <Layers size={13} /> : <BookOpen size={13} />}{split ? '分屏对照' : primary.kind === 'document' ? '连续阅读' : '研究工作区'}</span>
      <div>{!split ? <button className="text-button" aria-label="分屏阅读" disabled={!compare} onClick={() => { if (compare) actions.openResource(compare, { scope: data.scope, target: 'main-secondary' }); }}><Rows2 size={14} />分屏对照</button> : <>
        <label className="pdf-layout-select"><span>对照布局</span><select aria-label="阅读器分屏方向" value={split.layout} onChange={event => actions.setMainSplitLayout(event.target.value as 'horizontal' | 'vertical')}><option value="vertical">上下分屏</option><option value="horizontal">左右（窄屏上下）</option></select></label>
        <button className="text-button" aria-label="关闭阅读器分屏" onClick={() => actions.closeMainSplit()}><X size={13} />关闭分屏</button>
      </>}</div>
    </div>
    <div className="pdf-reading-panes">
      <section className="pdf-reading-pane" aria-label="中央主窗">
        {split && <div className="pdf-pane-label">{picker(primary, 'main')}</div>}
        <div className="workspace-pane-body">{renderResource(primary, 'main')}</div>
      </section>
      {split && <section className="pdf-reading-pane" aria-label="中央对照窗">
        <div className="pdf-pane-label">{picker(split.ref, 'main-secondary')}</div>
        <div className="workspace-pane-body">{renderResource(split.ref, 'main-secondary')}</div>
      </section>}
    </div>
  </section>;
}
