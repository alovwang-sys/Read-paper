import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw, Sparkles, X } from 'lucide-react';
import type { AgentConnection, AIConnectionId } from '../../domain/types';
import { connectionLabel } from '../../services/agents';

export const agentStateLabel: Record<AgentConnection['state'], string> = {
  ready: '就绪',
  'not-installed': '未安装',
  'needs-auth': '需登录',
  error: '连接异常',
};

export function AgentPicker({ current, agents, loading, error, model, configured, onSelect, onRefresh }: {
  current: AIConnectionId;
  agents: AgentConnection[];
  loading: boolean;
  error: string;
  model?: string;
  configured: boolean;
  onSelect: (id: AIConnectionId) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  function select(value: AIConnectionId) {
    onSelect(value);
    setOpen(false);
    trigger.current?.focus();
  }
  const nativeIds = ['codex', 'claude', 'opencode'] as const;
  const bounds = trigger.current?.getBoundingClientRect();
  const panel = root.current?.closest('.reading-ai');
  const panelBounds = panel?.getBoundingClientRect();
  return (
    <div className="ai-agent-picker" ref={root}>
      <button ref={trigger} className="ai-agent-trigger" aria-label="切换 AI 助手" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Sparkles size={14} />
        <span>{connectionLabel(current)}</span>
        <ChevronDown size={13} />
      </button>
      {open && bounds && createPortal(<div ref={menu} className="ai-agent-menu" id={id} role="dialog" aria-label="选择 AI 助手" style={{ bottom: window.innerHeight - bounds.top + 8, right: Math.max(12, window.innerWidth - (panelBounds?.right ?? bounds.right) + 12), width: Math.min(370, (panel?.clientWidth ?? window.innerWidth) - 24) }}>
        <div className="ai-agent-menu-head">
          <div><strong>选择 AI 助手</strong><small>每个助手保留独立对话与输入</small></div>
          <button className="icon-button" aria-label="关闭助手选择" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={15} /></button>
        </div>
        <div className="ai-agent-options">
          <p className="ai-agent-group">本机 Agent</p>
          {loading && <p className="ai-agent-loading" role="status">正在检查本机助手…</p>}
          {error && <p className="ai-error" role="alert">{error}</p>}
          {nativeIds.map(value => {
            const agent = agents.find(item => item.id === value);
            const label = connectionLabel(value);
            return <button key={value} className="ai-agent-option" aria-label={label} aria-describedby={`${id}-${value}-state ${id}-${value}-capabilities`} aria-pressed={current === value} onClick={() => select(value)}>
              <span className="ai-agent-option-main"><strong>{label}</strong><span id={`${id}-${value}-state`} className={`ai-agent-state ${agent?.state === 'ready' ? 'is-ready' : ''}`}>{agent ? agentStateLabel[agent.state] : loading ? '检查中' : '未连接'}</span>{current === value && <Check size={14} />}</span>
              <small id={`${id}-${value}-capabilities`}>{agent?.version ? `${agent.version} · ` : ''}{agent ? agent.capabilities.tools ? '只读工具' : '仅对话' : '连接后查看能力'}{agent ? agent.capabilities.images ? ' · 图片' : ' · 仅文字' : ''}{agent?.capabilities.resume ? ' · 会话续接' : ''}</small>
              {agent?.detail && agent.state !== 'ready' && <small className="ai-agent-detail">{agent.detail}</small>}
            </button>;
          })}
          <p className="ai-agent-group">其他方式</p>
          <button className="ai-agent-option" aria-label="模型直连" aria-pressed={current === 'model'} onClick={() => select('model')}>
            <span className="ai-agent-option-main"><strong>模型直连</strong><span className={`ai-agent-state ${configured ? 'is-ready' : ''}`}>{configured ? '就绪' : '未配置'}</span>{current === 'model' && <Check size={14} />}</span>
            <small>{model || '使用本地服务配置的模型'}</small>
          </button>
          <button className="ai-agent-option" aria-label="演示模式" aria-pressed={current === 'demo'} onClick={() => select('demo')}>
            <span className="ai-agent-option-main"><strong>演示模式</strong>{current === 'demo' && <Check size={14} />}</span>
            <small>预设回答，无真实模型调用</small>
          </button>
        </div>
        <div className="ai-agent-menu-footer"><small>不自动切换助手；本机 Agent 无写入权限。</small><button className="text-button" disabled={loading} onClick={onRefresh}><RefreshCw size={12} />重新检查</button></div>
      </div>, panel ?? document.body)}
    </div>
  );
}
