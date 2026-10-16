import { useEffect, useRef, useState } from 'react';
import { HelpCircle, ShieldCheck } from 'lucide-react';
import type { AgentInteraction, AIRequest } from '../../domain/types';
import { respondToAgent } from '../../services/ai';
import { useWorkspace } from '../../services/workspace';

const labels = { pending: '等待答复', answered: '已答复', denied: '已拒绝', expired: '已失效' };

export function AgentInteractionCard({ request, interaction }: { request: AIRequest; interaction: AgentInteraction }) {
  const { actions } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const active = interaction.status === 'pending' && request.status === 'generating';
  const drafts = interaction.answerDrafts ?? {};
  function updateAnswer(questionId: string, values: string[]) {
    actions.updateData(data => {
      const original = data.requests[request.id];
      const target = original?.interactions?.find(item => item.id === interaction.id);
      if (original?.status !== 'generating' || target?.status !== 'pending') return;
      target.answerDrafts = { ...target.answerDrafts, [questionId]: values };
    });
  }
  async function reply(value: { decision: 'allowOnce' | 'deny' } | { answers: Record<string, string[]> }) {
    if (!active || busy) return;
    setBusy(true); setError('');
    try { await respondToAgent(request.id, interaction.id, value); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '答复没有提交成功，内容已保留，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const answers = Object.fromEntries((interaction.questions ?? []).map(question => [question.id, (drafts[question.id] ?? []).filter(value => value.trim() && (question.allowOther !== false || question.options.some(option => option.label === value)))]));
  const complete = !!interaction.questions?.length && interaction.questions.every(question => answers[question.id]?.length);
  return <section className={`agent-interaction-card is-${interaction.status}`} aria-label={interaction.kind === 'approval' ? 'Codex 工具审批' : 'Codex 问题答复'}>
    <div className="agent-interaction-heading">{interaction.kind === 'approval' ? <ShieldCheck size={16} /> : <HelpCircle size={16} />}<strong>{interaction.title}</strong><small>{interaction.status === 'pending' && !active ? '请求已结束' : labels[interaction.status]}</small></div>
    {interaction.detail && <p>{interaction.detail}</p>}
    {interaction.command && <pre>{interaction.command}</pre>}
    {interaction.kind === 'approval' ? <>
      <div className="agent-interaction-actions"><button className="primary" disabled={!active || busy} onClick={() => void reply({ decision: 'allowOnce' })}>允许本次</button><button className="button" disabled={!active || busy} onClick={() => void reply({ decision: 'deny' })}>拒绝</button></div>
      <small>只答复这条请求，不修改全局权限。</small>
    </> : <>
      {interaction.questions?.map(question => {
        const answers = drafts[question.id] ?? [];
        const custom = answers.filter(answer => !question.options.some(option => option.label === answer)).join('\n');
        return <fieldset disabled={!active || busy} key={question.id}>
          <legend>{question.header && <strong>{question.header} · </strong>}{question.question}</legend>
          <div className="agent-question-options">{question.options.map(option => <label key={option.label}>
            <input type="checkbox" checked={answers.includes(option.label)} onChange={event => updateAnswer(question.id, event.target.checked ? [...new Set([...answers, option.label])] : answers.filter(answer => answer !== option.label))} />
            <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          </label>)}</div>
          {question.allowOther !== false && <textarea aria-label={`补充回答：${question.header || question.id}`} placeholder="也可以写下自己的回答…" value={custom} onChange={event => updateAnswer(question.id, [...answers.filter(answer => question.options.some(option => option.label === answer)), ...(event.target.value ? [event.target.value] : [])])} />}
        </fieldset>;
      })}
      <button className="primary" disabled={!active || busy || !complete} onClick={() => void reply({ answers })}>{busy ? '正在提交…' : '提交答复'}</button>
    </>}
    {!active && interaction.status === 'pending' && <p className="agent-interaction-ended">原请求已结束，当前问题不能继续提交；草稿仍保留。</p>}
    {error && <p className="ai-error" role="alert">{error}</p>}
  </section>;
}
