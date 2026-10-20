import { Network, X } from 'lucide-react';
import type { Conversation } from '../../domain/types';
import { captureBoardContext } from '../../services/board-history';
import { useWorkspace } from '../../services/workspace';
import './board-skill.css';

export function BoardSkillPanel({ conversation, disabled, canCreate, onCreate }: { conversation: Conversation; disabled: boolean; canCreate: boolean; onCreate: () => void }) {
  const { data, actions } = useWorkspace();
  const boards = Object.values(data.boards).filter(board => board.researchId === conversation.researchId);
  const skill = conversation.boardSkill;
  let resources: ReturnType<typeof captureBoardContext>['resources'] = [], problem = '';
  if (skill) {
    try { resources = captureBoardContext(data, conversation.researchId, skill.boardId, skill.scope, { allowNewCards: skill.allowNewCards }).resources; }
    catch (error) { problem = error instanceof Error ? error.message : '无法读取白板材料。'; }
  }
  function update(value: Conversation['boardSkill']) {
    actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].boardSkill = value; });
  }
  return <section className="board-chat-tools" aria-label="聊天白板工具">
    <div className="board-chat-tool-row"><button className="text-button" title="使用当前对话与本轮材料生成白板" disabled={!canCreate} onClick={onCreate}><Network size={14} />生成白板</button>
      {!!boards.length && !skill && <details className="board-target-picker"><summary>修改已有白板</summary><label>仅本次修改<select aria-label="选择要修改的白板" value="" disabled={disabled} onChange={event => { if (event.target.value) update({ boardId: event.target.value, scope: 'board', allowNewCards: true }); }}><option value="">选择目标白板…</option>{boards.map(board => <option value={board.id} key={board.id}>{board.title}</option>)}</select></label></details>}
    </div>
    {skill && <div className="board-skill">
      <div className="board-skill-toggle"><strong>仅本次修改已有白板</strong><button className="icon-button" aria-label="取消本次白板修改" disabled={disabled} onClick={() => update(undefined)}><X size={13} /></button></div>
      <div className="board-skill-fields">
        <label>目标白板<select aria-label="整理目标白板" value={skill.boardId} disabled={disabled} onChange={event => update({ ...skill, boardId: event.target.value })}>{!boards.some(board => board.id === skill.boardId) && <option value={skill.boardId}>原白板已缺失</option>}{boards.map(board => <option value={board.id} key={board.id}>{board.title}</option>)}</select></label>
        <label>材料范围<select aria-label="白板整理材料范围" value={skill.scope} disabled={disabled} onChange={event => update({ ...skill, scope: event.target.value as 'board' | 'research' })}><option value="board">白板上的资料</option><option value="research">本研究资料和卡片</option></select></label>
      </div>
      {problem ? <p className="ai-error" role="alert">{problem}</p> : <details className="board-skill-materials"><summary>将发送 {resources.length} 项资料快照</summary><p>卡片含标题、正文和证据标识；论文仅含标题。原文内容以“本轮材料”为准。</p><ul>{resources.map(resource => <li key={`${resource.ref.kind}:${resource.ref.id}`}>{resource.title}<span>{resource.evidenceIds.length} 条证据标识</span></li>)}</ul>{!resources.length && <p>范围内没有资料，可先添加资料或改用本研究范围。</p>}</details>}
      <label className="board-skill-drafts"><input type="checkbox" checked={skill.allowNewCards === true} disabled={disabled} onChange={event => update({ ...skill, allowNewCards: event.target.checked })} />允许补充方法、计划和待验证问题草稿</label>
      <p>补充草稿、改变已有层级、顺序或位置，均先确认差异。已有卡片正文保持原样；新卡引用只取自“本轮材料”。</p>
    </div>}
  </section>;
}
