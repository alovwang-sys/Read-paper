import { Check, CircleAlert, LoaderCircle, ShieldAlert, Wrench } from 'lucide-react';
import type { AgentEvent } from '../../domain/types';

const statusLabels = { running: '运行中', done: '已完成', error: '失败' };

export function AgentActivity({ events, generating }: { events: AgentEvent[]; generating: boolean }) {
  if (!events.length) return null;
  const tools = events.filter(event => event.kind === 'tool');
  const running = generating && tools.some(event => event.status === 'running');
  return <details className="ai-agent-events">
    <summary><Wrench size={12} /><span>执行过程 · {events.length}</span><small>{running ? '工具执行中' : `${tools.length} 次工具调用`}</small></summary>
    <div className="ai-execution-list">
      {events.map((event, index) => event.kind === 'tool' ? <details className={`ai-tool-call is-${event.status ?? 'record'}`} key={event.id ?? index}>
        <summary>
          {event.status === 'running' && generating ? <LoaderCircle size={13} className="ai-tool-spinner" /> : event.status === 'done' ? <Check size={13} /> : event.status === 'error' ? <CircleAlert size={13} /> : <Wrench size={13} />}
          <span className="ai-tool-title"><strong>{event.toolName || event.text}</strong>{event.command && <code>{event.command}</code>}</span>
          <span className="ai-tool-state">{event.status ? event.status === 'running' && !generating ? '未完成' : statusLabels[event.status] : '工具记录'}</span>
        </summary>
        <div className="ai-tool-details">
          {event.toolName && <p>{event.text}</p>}
          {event.command && <><small>命令 / 路径</small><pre>{event.command}</pre></>}
          {'exitCode' in event && typeof event.exitCode === 'number' && <small className="ai-tool-exit">退出码 {event.exitCode}</small>}
          {event.output !== undefined && <><small>输出节选</small><pre className="ai-tool-output">{event.output || '未返回文本输出。'}</pre></>}
        </div>
      </details> : <div className={`ai-execution-note is-${event.kind}`} key={event.id ?? index}>
        {event.kind === 'permission' && <ShieldAlert size={13} />}<span>{event.text}</span>
      </div>)}
    </div>
  </details>;
}
