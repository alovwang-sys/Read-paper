import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, History, Network, Undo2, X } from 'lucide-react';
import type { AIRequest, BoardChange, BoardContext, BoardPlan, BoardSnapshot, WorkspaceData } from '../../domain/types';
import { applyBoardProposal, boardChanges, previewBoardPlan, restoreBoardChange, undoBoardCreation } from '../../services/board-history';
import { resourceTitle, useWorkspace, workspace } from '../../services/workspace';
import { orderedBoardSiblings } from '../../domain/board-structure';
import './board-skill.css';

function counts(before: BoardSnapshot, after: BoardSnapshot) {
  const prior = new Map(before.placements.map(item => [item.id, item]));
  const current = new Set(after.placements.map(item => item.id));
  return {
    added: after.placements.filter(item => !prior.has(item.id)).length,
    removed: before.placements.filter(item => !current.has(item.id)).length,
    moved: after.placements.filter(item => { const old = prior.get(item.id); return old && (old.x !== item.x || old.y !== item.y); }).length,
    grouped: after.placements.filter(item => prior.get(item.id)?.group !== item.group).length,
    structured: after.placements.filter(item => { const old = prior.get(item.id); return old && (old.parentPlacementId !== item.parentPlacementId || old.order !== item.order); }).length,
  };
}

function BoardDiff({ before, after, data, plan }: { before: BoardSnapshot; after: BoardSnapshot; data: WorkspaceData; plan?: BoardPlan }) {
  const diff = counts(before, after);
  const title = (snapshot: BoardSnapshot, id?: string) => {
    if (!id) return '根层';
    const index = snapshot.placements.findIndex(p => p.id === id), p = snapshot.placements[index];
    return p ? snapshot === after && plan?.nodes[index]?.card?.title || resourceTitle(data, p.resourceRef) : '已移出节点';
  };
  const changed = after.placements.filter(p => { const old = before.placements.find(item => item.id === p.id); return old && (old.parentPlacementId !== p.parentPlacementId || old.order !== p.order); });
  return <div className="board-proposal-diff" aria-label="白板变更摘要">
    {before.board.title !== after.board.title && <p>标题：{before.board.title} → {after.board.title}</p>}
    <p>新增 {diff.added} · 移出 {diff.removed} · 移动 {diff.moved} · 分组变化 {diff.grouped}</p>
    <p>父级／顺序变化 {diff.structured}{before.board.layout !== after.board.layout ? ` · 布局：${after.board.layout === 'tree' ? '层级整理' : '自由布局'}` : ''}{plan?.nodes.some(n => n.card) ? ` · 新草稿 ${plan.nodes.filter(n => n.card).length}` : ''}</p>
    {!!changed.length && <details><summary>核对父级与顺序</summary><ul>{changed.map(p => { const old = before.placements.find(item => item.id === p.id)!; return <li key={p.id}>{title(after, p.id)}：{title(before, old.parentPlacementId)} → {title(after, p.parentPlacementId)}；同级序号 {old.order === undefined ? '未设置' : old.order + 1} → {p.order === undefined ? '未设置' : p.order + 1}</li>; })}</ul></details>}
    <p>连线 {before.edges.length} → {after.edges.length} · 分组 {new Set(before.placements.map(item => item.group).filter(Boolean)).size} → {new Set(after.placements.map(item => item.group).filter(Boolean)).size}</p>
    {before.board.drawing?.hash !== after.board.drawing?.hash && <p>自由绘图：{!before.board.drawing ? '已添加' : !after.board.drawing ? '已移除' : '版本已更新'}；恢复包含该版本的图形与图片。</p>}
  </div>;
}

function SnapshotPreview({ snapshot, data, resources }: { snapshot: BoardSnapshot; data: WorkspaceData; resources?: BoardContext['resources'] }) {
  const groups = [...new Set(snapshot.placements.map(item => item.group || '未分组'))];
  const title = (id: string) => { const item = snapshot.placements.find(placement => placement.id === id); return item ? resources?.find(resource => resource.ref.id === item.resourceRef.id && resource.ref.kind === item.resourceRef.kind)?.title ?? resourceTitle(data, item.resourceRef) : '资料已缺失'; };
  return <div className="board-snapshot" aria-label={`白板结构：${snapshot.board.title}`}>
    <strong>{snapshot.board.title}</strong>
    <div className="board-snapshot-groups">{groups.map(group => <section key={group}><h4>{group}</h4>{snapshot.placements.filter(item => (item.group || '未分组') === group).map(item => <div className="board-snapshot-node" key={item.id}><span>{title(item.id)}</span><small>{item.resourceRef.kind === 'card' ? '共享卡片' : '论文资料'} · {item.parentPlacementId ? `归属：${title(item.parentPlacementId)}` : '根层'}{item.order !== undefined ? ` · 同级序号 ${item.order + 1}` : ''} · 位置 {Math.round(item.x)}, {Math.round(item.y)}</small></div>)}</section>)}</div>
    {snapshot.board.drawing && <p className="muted">此版本包含自由绘图，恢复后可在画布查看。</p>}
    {!snapshot.placements.length && !snapshot.board.drawing && <p className="muted">此版本为空白板。</p>}
    {!!snapshot.edges.length && <ul className="board-snapshot-edges" aria-label="预览中的连线">{snapshot.edges.map(edge => <li key={edge.id}><span>{title(edge.fromPlacementId)}</span><ArrowRight size={12} /><span>{edge.label || '关联'} · {title(edge.toPlacementId)}</span></li>)}</ul>}
  </div>;
}

function BoardGraph({ snapshot, plan, context, data }: { snapshot: BoardSnapshot; plan: BoardPlan; context: BoardContext; data: WorkspaceData }) {
  const container = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, '');
  const [width, setWidth] = useState(300);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (snapshot.board.layout === 'tree') {
    const describe = (id: string) => {
      const index = snapshot.placements.findIndex(p => p.id === id), item = snapshot.placements[index];
      return plan.nodes[index]?.card?.title ?? context.resources.find(r => r.ref.kind === item.resourceRef.kind && r.ref.id === item.resourceRef.id)?.title ?? resourceTitle(data, item.resourceRef);
    };
    const branch = (parent?: string): React.ReactNode => <ul>{orderedBoardSiblings(snapshot.placements, parent).map(item => <li key={item.id}><span>{describe(item.id)}</span>{plan.nodes[snapshot.placements.indexOf(item)]?.card && <small>新草稿 · 待核查</small>}{snapshot.placements.some(p => p.parentPlacementId === item.id) && branch(item.id)}</li>)}</ul>;
    return <div className="board-tree-preview" aria-label={`白板层级预览：${snapshot.board.title}`}><strong>{snapshot.board.title}</strong>{branch()}<details><summary>交叉关系 {snapshot.edges.length} 条</summary><ul>{snapshot.edges.map(e => <li key={e.id}>{describe(e.fromPlacementId)} → {describe(e.toPlacementId)}：{e.label || '关联'}</li>)}</ul></details></div>;
  }
  const shown = snapshot.placements.slice(0, 6), columns = width < 250 ? 1 : 2;
  const gap = 38, nodeHeight = 112, rowGap = 38, nodeWidth = (width - gap * (columns - 1)) / columns;
  const rows = Math.ceil(shown.length / columns), height = rows * nodeHeight + Math.max(0, rows - 1) * rowGap;
  const position = (index: number) => ({ x: (index % columns) * (nodeWidth + gap), y: Math.floor(index / columns) * (nodeHeight + rowGap) });
  const visibleEdges = snapshot.edges.filter(edge => shown.some(node => node.id === edge.fromPlacementId) && shown.some(node => node.id === edge.toPlacementId));
  return <div className="board-graph-preview" aria-label={`白板关系图：${snapshot.board.title}`}>
    <strong>{snapshot.board.title}</strong>
    <div className="board-chat-graph" ref={container} style={{ minHeight: height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-label="白板预览连线">
        <defs><marker id={marker} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" /></marker></defs>
        {visibleEdges.map(edge => {
          const from = shown.findIndex(node => node.id === edge.fromPlacementId), to = shown.findIndex(node => node.id === edge.toPlacementId);
          const a = position(from), b = position(to), sameRow = a.y === b.y;
          const startX = sameRow ? a.x + (a.x < b.x ? nodeWidth : 0) : a.x + nodeWidth / 2;
          const endX = sameRow ? b.x + (a.x < b.x ? 0 : nodeWidth) : b.x + nodeWidth / 2;
          const startY = a.y + (sameRow ? nodeHeight / 2 : a.y < b.y ? nodeHeight : 0);
          const endY = b.y + (sameRow ? nodeHeight / 2 : a.y < b.y ? 0 : nodeHeight);
          const middleY = (startY + endY) / 2;
          return <g key={edge.id}><title>{edge.label || '关联'}</title><path className="board-graph-edge" d={sameRow ? `M${startX},${startY} L${endX},${endY}` : `M${startX},${startY} C${startX},${middleY} ${endX},${middleY} ${endX},${endY}`} markerEnd={`url(#${marker})`} /><text x={(startX + endX) / 2} y={sameRow ? middleY - 7 : middleY - 4} textAnchor="middle">{(edge.label || '关联').slice(0, 3)}</text></g>;
        })}
      </svg>
      {shown.map((item, index) => {
        const created = plan.nodes[index]?.card;
        const resource = context.resources.find(value => value.ref.kind === item.resourceRef.kind && value.ref.id === item.resourceRef.id);
        const title = created?.title ?? resource?.title ?? resourceTitle(data, item.resourceRef);
        const body = created?.body ?? resource?.body ?? (item.resourceRef.kind === 'card' ? data.cards[item.resourceRef.id]?.body : undefined);
        const at = position(index);
        return <div className="board-graph-node" key={item.id} style={{ left: at.x, top: at.y, width: nodeWidth, height: nodeHeight }} title={[title, body].filter(Boolean).join('\n')}><strong>{title}</strong>{body && <p>{body}</p>}<small>{created ? '新卡片 · 待核查' : item.resourceRef.kind === 'card' ? '共享卡片' : '论文资料'}</small></div>;
      })}
    </div>
    {snapshot.placements.length > shown.length && <p className="muted">预览 {shown.length} / {snapshot.placements.length} 个节点，打开白板查看完整结构。</p>}
    {!shown.length && <p className="muted">此白板暂时没有节点。</p>}
  </div>;
}

export function BoardProposal({ request }: { request: AIRequest }) {
  const { data, actions, saveStatus } = useWorkspace();
  const [preview, setPreview] = useState(request.boardContext?.intent === 'create');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<'apply' | 'undo' | 'restore'>('apply');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const displayedError = error || request.boardApplyError;
  useEffect(() => { if (displayedError) errorRef.current?.scrollIntoView({ block: 'nearest' }); }, [displayedError]);
  const context = request.boardContext, plan = request.boardProposal;
  if (!context || !plan) return null;
  let after: BoardSnapshot;
  try { after = previewBoardPlan(context, plan); }
  catch (problem) { return <p className="ai-error" role="alert">白板提案无法预览：{problem instanceof Error ? problem.message : '格式不正确'}。当前白板未改变。</p>; }
  const applied = Object.values(data.boardChanges ?? {}).find(change => change.requestId === request.id);
  const creating = context.intent === 'create';
  const boardId = applied?.boardId ?? context.boardId;
  const undone = creating && !!applied && !data.boards[boardId];
  const deletion = applied && boardChanges(data, boardId).find(change => change.restores === applied.id && !change.after);
  const restored = deletion && boardChanges(data, boardId).some(change => change.restores === deletion.id);
  const canApply = !undone && ((!applied && !creating) || !!request.boardApplyError || !!error && errorKind === 'apply' || !!applied && saveStatus === 'error' && errorKind === 'apply' && !restored);
  async function apply() {
    setBusy(true); setError(''); setErrorKind('apply');
    try { await applyBoardProposal(request.id); if (!creating) setPreview(false); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '应用失败，提案已保留，请重试。'); }
    finally { setBusy(false); }
  }
  async function undo() {
    setBusy(true); setError(''); setErrorKind('undo');
    try { await undoBoardCreation(request.id); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '撤销失败，白板仍保留，请重试。'); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!deletion) return;
    setBusy(true); setError(''); setErrorKind('restore');
    try { await restoreBoardChange(deletion.id); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '恢复失败，历史已保留，请重试。'); }
    finally { setBusy(false); }
  }
  return <section className="board-proposal" aria-label={creating ? '聊天生成的白板' : '白板整理提案'}>
    <div className="board-proposal-heading"><strong><Network size={15} />{creating ? '已生成白板' : '白板整理'}</strong><span>{undone ? '已撤销创建' : displayedError || applied && saveStatus === 'error' ? '待处理' : applied ? saveStatus === 'saved' ? '已保存' : '保存中' : creating ? '正在保存…' : '等待确认'}</span></div>
    <p>{plan.summary}</p>
    {!creating && <BoardDiff before={context.snapshot} after={after} data={data} plan={plan} />}
    <div className="board-proposal-actions">
      <button className="button" onClick={() => setPreview(!preview)} aria-expanded={preview}>{preview ? creating ? '收起关系图' : '取消预览' : creating ? '查看关系图' : '预览白板整理'}</button>
      {canApply && <button className="primary" disabled={busy || request.status !== 'done' || !!request.validationError} onClick={() => void apply()}>{busy ? '正在保存…' : applied || creating ? '重试保存白板' : '确认应用此批变更'}</button>}
      {applied && !undone && <button className="text-button" onClick={() => actions.openResource({ kind: 'board', id: boardId }, { scope: { kind: 'research', researchId: request.researchId }, target: 'main' })}><Check size={13} />打开白板</button>}
      {creating && applied && !undone && !restored && <button className="text-button" disabled={busy} onClick={() => void undo()}><Undo2 size={13} />撤销创建</button>}
      {undone && saveStatus === 'error' && <button className="text-button" disabled={busy} onClick={() => void undo()}>重试保存撤销</button>}
      {deletion && (undone || restored && (saveStatus === 'error' || !!error && errorKind === 'restore')) && <button className="text-button" disabled={busy} onClick={() => void restore()}>{undone ? '恢复白板' : '重试保存恢复'}</button>}
    </div>
    {preview && <div className="board-proposal-preview"><p className="board-preview-label">{undone ? '历史预览 · 此白板已撤销' : applied ? '已保存的结构 · 在本研究白板中可继续编辑' : creating ? '正在保存到本研究，当前阅读保持不变' : '只读预览 · 已有内容的调整等待确认'}</p><BoardGraph snapshot={after} plan={plan} context={context} data={data} /></div>}
    {displayedError && <p className="ai-error" role="alert" ref={errorRef}>{displayedError}</p>}
  </section>;
}

export function BoardHistoryPanel({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const { data, actions } = useWorkspace();
  const changes = boardChanges(data, boardId);
  const [selectedId, setSelectedId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  const selected = changes.find(change => change.id === selectedId);
  async function restore(change: BoardChange, mode: 'safe' | 'copy' = 'safe') {
    setBusy(true); setError(''); setConflict(false);
    try {
      const restoredId = await restoreBoardChange(change.id, mode);
      const scope = workspace.getState().data.scope;
      if (scope.kind === 'research' && scope.researchId === change.researchId) {
        if (mode === 'copy') actions.openResource({ kind: 'board', id: restoredId }, { scope, target: 'main' });
        actions.notice(mode === 'copy' ? '已恢复为独立白板，当前白板保留。' : '已恢复该次变更前的白板，并新增恢复记录。');
      }
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : '恢复失败，请重试。';
      setError(message);
      setConflict(mode === 'safe' && message.includes('冲突'));
    } finally { setBusy(false); }
  }
  return <section className="board-history-panel" aria-label="白板版本历史">
    <div className="board-history-heading"><strong><History size={15} />白板版本历史</strong><button className="icon-button" aria-label="关闭白板历史" onClick={onClose}><X size={16} /></button></div>
    <p className="muted">查看每批修改；恢复会新建记录。卡片正文与原文始终共享。</p>
    {!changes.length && <p>还没有变更记录。整理或编辑白板后，修改将记录在这里。</p>}
    <div className="board-history-content"><ol className="board-history-list">{changes.map(change => <li key={change.id}><button className={`board-history-item ${selectedId === change.id ? 'is-active' : ''}`} aria-pressed={selectedId === change.id} onClick={() => { setSelectedId(change.id); setError(''); setConflict(false); }}><strong>{change.summary}</strong><span>{change.actor} · {new Date(change.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></button></li>)}</ol>
      {selected && <div className="board-history-detail"><h3>{selected.summary}</h3>{selected.before && selected.after && <BoardDiff before={selected.before} after={selected.after} data={data} />}<div className="board-history-versions"><section><h4>修改前</h4>{selected.before ? <SnapshotPreview snapshot={selected.before} data={data} /> : <p>此白板尚未创建。</p>}</section><section><h4>修改后</h4>{selected.after ? <SnapshotPreview snapshot={selected.after} data={data} /> : <p>此白板已移除。</p>}</section></div>
        <div className="board-proposal-actions"><button className="button" disabled={busy || !selected.before} onClick={() => void restore(selected)}>{busy ? '恢复并保存中…' : '恢复此次变更前'}</button></div>
        {error && <div className="board-history-conflict" role="alert" ref={errorRef}><p>{error}</p>{conflict && selected.before && <><p>保留当前白板，可将历史版本恢复为独立副本。</p><button className="button" disabled={busy} onClick={() => void restore(selected, 'copy')}>保留当前，恢复为副本</button></>}</div>}
      </div>}
    </div>
  </section>;
}
