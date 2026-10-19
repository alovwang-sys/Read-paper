import { Fragment, useState } from 'react';
import type { AIRequest, NativeTurnItem } from '../../domain/types';
import { remapCitationNumbers } from '../../domain/citations';
import { resumeNativeRuns, steerNativeRun } from '../../services/ai';
import { AgentActivity } from './AgentActivity';
import { AgentInteractionCard } from './AgentInteractionCard';
import { MarkdownContent } from './MarkdownContent';

function itemText(request: AIRequest, item: NativeTurnItem) {
  if (request.status !== 'done' || request.validationError) return { text: item.text ?? '', citations: false };
  try { return { text: remapCitationNumbers(item.text ?? '', request.context.map(source => source.evidenceId), request.evidenceIds), citations: true }; }
  catch { return { text: item.text ?? '', citations: false }; }
}

/** The same native turn can be shown in the reader popover and the AI panel. */
export function NativeRunTimeline({ request, onCitation }: { request: AIRequest; onCitation?: (number: number) => void }) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const run = request.nativeRun;
  if (!run) return <MarkdownContent text={request.body} onCitation={onCitation} />;
  const active = request.status === 'generating';
  const messages = run.items.filter(item => item.type === 'agentMessage');
  const interactions = request.interactions ?? [];
  const knownIds = new Set(run.items.map(item => item.id));
  const supplements = request.supplementalInputs ?? [];
  const supplement = (id: string) => { const input = supplements.find(input => input.id === id)!; return <div className="ai-prompt" key={input.id}><small className="ai-footnote">本轮补充</small><p>{input.text}</p></div>; };
  const status = run.transport === 'offline' ? '暂时无法确认原生回合状态'
    : run.transport === 'reconnecting' ? '正在恢复原生回合…'
    : run.state === 'stopping' ? '正在停止，等待原生回合确认…'
    : run.state === 'unknown' ? '正在核对原生回合状态…'
    : run.state === 'compacting' ? '正在整理上下文，随后继续当前对话…'
    : run.state === 'waiting-input' ? '等待你的答复…'
    : run.delivery === 'pending' ? '正在提交问题…' : '正在回答…';
  const interactionCard = (id: string) => {
    const interaction = interactions.find(item => item.id === id)!;
    return <AgentInteractionCard key={interaction.id} request={request} interaction={interaction} />;
  };
  return <div className="ai-native-timeline">
    {interactions.filter(item => !item.afterItemId || !knownIds.has(item.afterItemId)).map(item => interactionCard(item.id))}
    {supplements.filter(input => !input.afterItemId || !knownIds.has(input.afterItemId)).map(input => supplement(input.id))}
    {run.items.map(item => { const content = itemText(request, item); return <Fragment key={item.id}>
      {item.type === 'agentMessage' ? <div className={`ai-native-message is-${item.phase ?? 'answer'}`}>
        {item.phase === 'commentary' && <small className="ai-footnote">执行进展</small>}
        <MarkdownContent text={content.text} onCitation={content.citations ? onCitation : undefined} />
      </div> : item.type === 'contextCompaction' ? <p className="ai-info" role="status">{item.status === 'running' ? '正在整理上下文…' : '上下文已整理，对话继续。'}</p>
        : item.type === 'plan' ? <details className="ai-agent-events" open={item.status === 'running'}><summary>执行计划</summary><MarkdownContent text={item.text ?? ''} /></details>
          : <AgentActivity generating={active} events={[{ kind: 'tool', id: item.id, text: item.text || item.toolName || item.type, toolName: item.toolName || item.type,
            status: item.status, command: item.command, output: item.output, ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}) }]} />}
      {interactions.filter(interaction => interaction.afterItemId === item.id).map(interaction => interactionCard(interaction.id))}
      {supplements.filter(input => input.afterItemId === item.id).map(input => supplement(input.id))}
    </Fragment>; })}
    {!messages.length && request.body && <MarkdownContent text={request.body} onCitation={request.status === 'done' && !request.validationError ? onCitation : undefined} />}
    {!run.items.length && !!request.events?.length && <AgentActivity events={request.events} generating={active} />}
    {active && <div className="ai-generating" role="status"><span />{status}</div>}
    {active && run.transport === 'offline' && <div className="ai-scope-notice"><p>{request.error || '问题与已收到的内容已保留。恢复连接会继续观察本轮，不会再次发送问题。'}</p>
      <button className="text-button" disabled={restoring} onClick={() => { setRestoring(true); void resumeNativeRuns(request.id).finally(() => setRestoring(false)); }}>{restoring ? '正在恢复…' : '恢复连接'}</button>
    </div>}
    {run.pendingSteer && <div className="ai-scope-notice"><p>上一条补充的送达状态尚未确认，草稿已保留。</p><button className="text-button" disabled={restoring || active && (run.transport !== 'connected' || !['running', 'compacting'].includes(run.state))} onClick={() => {
      setRestoring(true); setError(''); const operation = active ? steerNativeRun(request.id, run.pendingSteer!.text) : resumeNativeRuns(request.id);
      void operation.catch(caught => setError(caught instanceof Error ? caught.message : '暂时无法确认补充状态。')).finally(() => setRestoring(false));
    }}>核对上次补充</button>{error && <p className="ai-error" role="status">{error}</p>}</div>}
  </div>;
}
