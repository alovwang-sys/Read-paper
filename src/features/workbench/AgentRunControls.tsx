import { X } from 'lucide-react';
import type { AgentRunMode, AIConnectionId, AIRequest, WorkspaceData } from '../../domain/types';
import type { ResearchAgentCapability } from '../../domain/research-agent';
import { connectionLabel } from '../../services/agents';
import { effectiveRunSettings, setAgentRunSettings, setResearchMode } from '../../services/research-agent';
import { getActiveConversation } from '../../services/workspace';

const EFFORT_LABELS: Record<string, string> = { none: '不思考', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限' };
export const effortLabel = (effort: string) => EFFORT_LABELS[effort] ?? effort;
export const MODE_LABELS: Record<AgentRunMode, string> = { auto: '自动', plan: '规划', offline: '仅资料' };
const modeDetail = (mode: AgentRunMode, web: boolean) => mode === 'auto' ? `按需读原文${web ? '、联网检索' : ''}，整理成带出处的成果` : mode === 'plan' ? `先给研究计划和要确认的问题${web ? '（可联网查背景）' : ''}，不保存成果` : '不联网、不检索文献，只用本研究的论文';
const modelLabel = (name: string, isDefault?: boolean, id?: string) => isDefault && id === 'default' ? '默认模型' : name;

/** Composer state for one assistant: what the chips show and what Shift+Tab cycles through. */
export function runControls(data: WorkspaceData, researchId: string, connectionId: AIConnectionId, capability: ResearchAgentCapability | undefined) {
  const conversation = getActiveConversation(data, researchId);
  const settings = effectiveRunSettings(data, connectionId, conversation, capability);
  const models = capability?.research ? capability.models ?? [] : [];
  const target = settings.target;
  const defaultEffort = settings.model ? target?.defaultEffort : capability?.configuredEffort ?? target?.defaultEffort;
  const effort = settings.effort ?? defaultEffort;
  const modes = capability?.research ? capability.modes ?? [] : [];
  return {
    settings, models, modes, defaultEffort, web: capability?.web === true,
    pickable: ['codex', 'claude'].includes(connectionId) && (models.length > 1 || !!target?.efforts.length),
    modelText: target ? `${modelLabel(target.name, target.isDefault, target.id)}${effort ? ` · ${effortLabel(effort)}` : ''}` : '',
    nextMode: modes.length > 1 ? modes[(modes.indexOf(settings.mode) + 1) % modes.length] : undefined,
  };
}

export function RunModelPanel({ researchId, connectionId, capability, data, disabled, onClose }: { researchId: string; connectionId: AIConnectionId; capability: ResearchAgentCapability | undefined; data: WorkspaceData; disabled: boolean; onClose: () => void }) {
  const { settings, models, defaultEffort } = runControls(data, researchId, connectionId, capability);
  const target = settings.target;
  function pick(model: { id: string; isDefault?: boolean; efforts: string[] }) {
    setAgentRunSettings(connectionId, { model: model.isDefault ? undefined : model.id, effort: settings.effort && model.efforts.includes(settings.effort) ? settings.effort : undefined });
  }
  return <div className="research-agent-config research-run-menu" role="dialog" aria-label="模型与思考程度">
    <div className="research-agent-config-heading"><strong>{connectionLabel(connectionId)} 模型</strong><button aria-label="关闭模型选择" onClick={onClose}><X size={16}/></button></div>
    <div className="research-agent-options" role="listbox" aria-label="模型">{models.map(model => {
      const selected = model.id === target?.id;
      return <button type="button" role="option" key={model.id} aria-selected={selected} aria-label={modelLabel(model.name, model.isDefault, model.id)} disabled={disabled} onClick={() => pick(model)}>
        <span className="research-agent-option-main"><span>{modelLabel(model.name, model.isDefault, model.id)}</span><small>{model.isDefault ? '本机默认' : ''}</small>{selected && <span aria-hidden="true">✓</span>}</span>
        {model.description && <span className="research-agent-option-detail">{model.description}</span>}
      </button>;
    })}</div>
    {!!target?.efforts.length && <div className="research-run-efforts" role="radiogroup" aria-label="思考程度"><span>思考程度</span><div>
      <button type="button" role="radio" aria-checked={!settings.effort} disabled={disabled} title="跟随本机配置" onClick={() => setAgentRunSettings(connectionId, { model: settings.model })}>默认{defaultEffort ? `·${effortLabel(defaultEffort)}` : ''}</button>
      {target.efforts.map(effort => <button type="button" role="radio" key={effort} aria-checked={settings.effort === effort} title={effort} disabled={disabled} onClick={() => setAgentRunSettings(connectionId, { model: settings.model, effort })}>{effortLabel(effort)}</button>)}
    </div></div>}
    <p className="research-run-note">像 /model 一样记住这次选择；“本机默认”跟随 {connectionLabel(connectionId)} 自己的配置。</p>
  </div>;
}

export function RunModePanel({ researchId, connectionId, capability, data, disabled, onClose }: { researchId: string; connectionId: AIConnectionId; capability: ResearchAgentCapability | undefined; data: WorkspaceData; disabled: boolean; onClose: () => void }) {
  const { settings, modes, web } = runControls(data, researchId, connectionId, capability);
  return <div className="research-agent-config research-run-menu" role="dialog" aria-label="研究模式">
    <div className="research-agent-config-heading"><strong>模式 <small>Shift+Tab 切换</small></strong><button aria-label="关闭模式选择" onClick={onClose}><X size={16}/></button></div>
    <div className="research-agent-options" role="listbox" aria-label="研究模式">{modes.map(mode => <button type="button" role="option" key={mode} aria-label={MODE_LABELS[mode]} aria-selected={settings.mode === mode} disabled={disabled} onClick={() => { setResearchMode(researchId, mode); onClose(); }}>
      <span className="research-agent-option-main"><span className={`research-run-mode-mark is-${mode}`} aria-hidden="true"/><span>{MODE_LABELS[mode]}</span>{settings.mode === mode && <span aria-hidden="true">✓</span>}</span>
      <span className="research-agent-option-detail">{modeDetail(mode, web)}</span>
    </button>)}</div>
  </div>;
}

/** One line under the assistant name: the model that answered, the effort and a non-default mode. */
export function runSummary(request: AIRequest) {
  const mode = request.runSettings?.mode;
  return [request.model, request.runSettings?.effort && effortLabel(request.runSettings.effort), mode && mode !== 'auto' && MODE_LABELS[mode]].filter(Boolean).join(' · ');
}

export { modeDetail };
