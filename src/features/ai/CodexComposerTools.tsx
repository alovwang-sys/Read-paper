import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import type { AgentSkill, CodexAccess, CodexCapabilities, CodexSettings } from '../../domain/types';
import { getCodexCapabilities } from '../../services/agents';
import './codex-composer.css';

export type CodexComposerToolsHandle = { handleSubmit(): boolean };
type Props = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  skills: AgentSkill[];
  settings: CodexSettings;
  status: string;
  onInput(value: string): void;
  onSkills(skills: AgentSkill[]): void;
  onSettings(settings: CodexSettings): void;
  onNew(): void;
  children?: ReactNode;
  leadingControls?: ReactNode;
  trailingControls?: ReactNode;
  disabled?: boolean;
  projectPath?: string;
  onCapabilities?: (catalog: CodexCapabilities | undefined) => void;
};
type Menu = 'all' | 'settings' | 'skills' | 'models' | 'effort' | 'permissions' | 'status';
type Choice = { id: string; label: string; description: string; group: string; ariaLabel?: string; selected?: boolean; disabledReason?: string; run(): void };
const accessInfo: Record<CodexAccess, { label: string; description: string }> = {
  'read-only': { label: '只读权限', description: '读取项目资料，不修改文件。' },
  'workspace-write': { label: '项目内写入', description: '允许修改研究目录内的文件；目录外操作仍受连接限制。' },
  'full-access': { label: '完全访问', description: '可以修改项目外文件、执行命令及访问网络，需要再次确认。' },
};
const effortLabel = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

export const CodexComposerTools = forwardRef<CodexComposerToolsHandle, Props>(function CodexComposerTools({ inputRef, value, skills, settings, status, onInput, onSkills, onSettings, onNew, children, leadingControls, trailingControls, disabled = false, projectPath, onCapabilities }, ref) {
  const [catalog, setCatalog] = useState<CodexCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<Menu>();
  const [settingsParent, setSettingsParent] = useState(false);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [active, setActive] = useState(0);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuSearch = useRef<HTMLInputElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  const confirmationTitle = useId();
  async function load() {
    setLoading(true); setError('');
    try { const result = await getCodexCapabilities(); if (alive.current) { setCatalog(result); onCapabilities?.(result); } }
    catch (failure) { if (alive.current) { setError(failure instanceof Error ? failure.message : '无法读取 Codex 的技能与模型，请重试。'); onCapabilities?.(undefined); } }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const update = () => { setCursor(input.selectionStart); setFocused(document.activeElement === input); };
    input.addEventListener('input', update); input.addEventListener('click', update); input.addEventListener('keyup', update); input.addEventListener('focus', update);
    return () => { input.removeEventListener('input', update); input.removeEventListener('click', update); input.removeEventListener('keyup', update); input.removeEventListener('focus', update); };
  }, [inputRef]);
  const model = catalog?.models.find(item => item.id === settings.model) ?? catalog?.models.find(item => item.isDefault) ?? catalog?.models[0];
  const modelLabel = catalog?.models.find(item => item.id === settings.model)?.name ?? settings.model ?? model?.name ?? '连接默认模型';
  const efforts = model?.reasoningEfforts ?? [];
  const effort = efforts.find(item => item.effort === settings.effort)?.effort ?? model?.defaultReasoningEffort;
  const access = catalog?.accessModes?.includes(settings.access ?? 'read-only') ? settings.access ?? 'read-only' : 'read-only';
  const prefix = value.slice(0, Math.min(cursor, value.length));
  const match = /(^|\s)([/$])([^\s]*)$/.exec(prefix);
  const token = match ? { start: match.index + match[1].length, end: prefix.length, symbol: match[2], query: match[3] } : undefined;
  const tokenKey = `${value}:${cursor}`;
  const automatic = !disabled && focused && token && dismissed !== tokenKey ? token.symbol === '$' ? 'skills' : 'all' : undefined;
  const opened = manual ?? automatic;
  const query = (manual ? search : token?.query ?? '').toLocaleLowerCase();
  function restoreFocus() { (returnFocus.current?.isConnected ? returnFocus.current : inputRef.current)?.focus(); }
  function close() { setManual(undefined); setSettingsParent(false); setSearch(''); setDismissed(tokenKey); }
  function dismiss() {
    if (settingsParent) { setManual('settings'); setSettingsParent(false); setSearch(''); setActive(0); }
    else { close(); restoreFocus(); }
  }
  function consumeToken() { if (token) onInput(value.slice(0, token.start) + value.slice(token.end)); }
  function open(kind: Menu) {
    if (disabled) return;
    if (!manual) returnFocus.current = root.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : inputRef.current;
    setSettingsParent(manual === 'settings' && kind !== 'settings');
    setManual(kind); setSearch(''); setActive(0);
  }
  function finishChoice() { consumeToken(); close(); inputRef.current?.focus(); }
  function selectSkill(skill: AgentSkill) {
    if (disabled || !skill.enabled || (skills.length >= 4 && !skills.some(selected => selected.id === skill.id))) return;
    if (!skills.some(selected => selected.id === skill.id)) onSkills([...skills, skill]);
    finishChoice();
  }
  function selectAccess(next: CodexAccess) {
    if (disabled || !catalog?.accessModes?.includes(next)) return;
    if (next === 'full-access' && access !== 'full-access') {
      consumeToken(); close(); returnFocus.current = settingsButton.current; setConfirmFullAccess(true);
    } else { onSettings({ ...settings, access: next }); finishChoice(); }
  }
  const actions: Choice[] = [
    { id: '/new', label: '/new', description: '新建干净对话，保留当前记录', group: '平台动作', run: () => { consumeToken(); close(); onNew(); } },
    { id: '/skills', label: '/skills', description: '搜索并选择 Codex 实际提供的技能', group: '平台动作', run: () => { consumeToken(); open('skills'); } },
    { id: '/model', label: '/model', description: '选择此连接实际提供的模型', group: '平台动作', disabledReason: !catalog?.models.length ? '当前连接尚未提供可选模型' : undefined, run: () => { consumeToken(); open('models'); } },
    { id: '/effort', label: '/effort', description: '选择当前模型支持的推理强度', group: '平台动作', disabledReason: !efforts.length ? '当前模型尚未提供可选推理强度' : undefined, run: () => { consumeToken(); open('effort'); } },
    { id: '/permissions', label: '/permissions', description: '查看或调整当前对话的后续请求权限', group: '平台动作', run: () => { consumeToken(); open('permissions'); } },
    { id: '/plan', label: '/plan', description: settings.mode === 'plan' ? '切换回 Chat 模式' : '切换为 Plan 模式', group: '平台动作', disabledReason: !catalog?.plan ? '当前 Codex 连接不支持 Plan 模式' : undefined, run: () => { onSettings({ ...settings, mode: settings.mode === 'plan' ? 'chat' : 'plan' }); finishChoice(); } },
    { id: '/status', label: '/status', description: '查看连接、模型、推理强度、权限与技能', group: '平台动作', run: () => { consumeToken(); open('status'); } },
  ];
  const skillChoices: Choice[] = (catalog?.skills ?? []).map(skill => ({ id: skill.id, label: `$${skill.name}`, description: skill.description, group: 'Codex 技能', disabledReason: !skill.enabled ? skill.disabledReason || '此技能当前不可用' : skills.length >= 4 && !skills.some(selected => selected.id === skill.id) ? '每轮最多选择 4 个技能，请先移除一个已选技能' : undefined, run: () => selectSkill(skill) }));
  const models: Choice[] = (catalog?.models ?? []).map(item => ({ id: item.id, label: item.name, description: `${item.id}${item.isDefault ? ' · 连接默认' : ''}`, group: 'Codex 模型', selected: item.id === model?.id, run: () => { onSettings({ ...settings, model: item.id, effort: undefined }); finishChoice(); } }));
  const reasoningChoices: Choice[] = efforts.map(item => ({ id: item.effort, label: effortLabel(item.effort), description: item.description, group: '推理强度', selected: item.effort === effort, run: () => { onSettings({ ...settings, effort: item.effort }); finishChoice(); } }));
  const permissions: Choice[] = (catalog?.accessModes?.length ? catalog.accessModes : ['read-only'] as const).map(item => ({ id: item, ...accessInfo[item], group: '对话权限', selected: item === access, disabledReason: !catalog?.accessModes?.length ? '当前连接未提供可选权限，使用只读权限。' : undefined, run: () => selectAccess(item) }));
  const settingChoices: Choice[] = [
    { id: 'permissions', label: accessInfo[access].label, ariaLabel: 'Codex 访问权限', description: '调整当前对话后续请求的访问权限', group: '对话设置', run: () => open('permissions') },
    { id: 'skills', label: skills.length ? `技能 · 已选 ${skills.length} 个` : '选择技能', description: '搜索并选择此连接提供的技能', group: '对话设置', run: () => open('skills') },
    { id: 'mode', label: settings.mode === 'plan' ? 'Plan' : 'Chat', ariaLabel: '切换 Codex Chat/Plan 模式', description: settings.mode === 'plan' ? '切换回 Chat 模式' : '切换为 Plan 模式', group: '对话设置', disabledReason: !catalog?.plan ? '当前 Codex 连接不支持 Plan 模式' : undefined, run: () => { onSettings({ ...settings, mode: settings.mode === 'plan' ? 'chat' : 'plan' }); finishChoice(); } },
  ];
  const choices = (opened === 'settings' ? settingChoices : opened === 'models' ? models : opened === 'skills' ? skillChoices : opened === 'effort' ? reasoningChoices : opened === 'permissions' ? permissions : opened === 'status' ? [] : [...actions, ...skillChoices]).filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(query));
  const index = Math.min(active, Math.max(0, choices.length - 1));
  function choose(choice?: Choice) { if (disabled || !choice || choice.disabledReason) return; choice.run(); }
  function keyDown(event: KeyboardEvent | React.KeyboardEvent) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % Math.max(1, choices.length)); }
    else if (event.key === 'Enter' && !('nativeEvent' in event ? event.nativeEvent.isComposing : event.isComposing) && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); choose(choices[index]); }
  }
  useImperativeHandle(ref, () => ({ handleSubmit() {
    if (!token || !/^\s*[/$][^\s]*\s*$/.test(value)) return false;
    const exact = [...actions, ...skillChoices].find(item => item.label.toLocaleLowerCase() === `${token.symbol}${token.query}`.toLocaleLowerCase());
    if (exact) choose(exact); else if (!disabled) { setDismissed(''); setFocused(true); inputRef.current?.focus(); }
    return true;
  } }));
  useEffect(() => {
    const input = inputRef.current;
    const handler = (event: KeyboardEvent) => keyDown(event);
    input?.addEventListener('keydown', handler);
    return () => input?.removeEventListener('keydown', handler);
  });
  useEffect(() => { setActive(0); }, [query, opened]);
  useEffect(() => { if (opened) menu.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [index, opened, query]);
  useEffect(() => { if (manual) (menuSearch.current ?? menu.current)?.focus(); }, [manual]);
  useEffect(() => { if (disabled) { close(); setConfirmFullAccess(false); } }, [disabled]);
  useEffect(() => { if (confirmFullAccess) confirmation.current?.showModal(); else confirmation.current?.close(); }, [confirmFullAccess]);
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node) && event.target !== inputRef.current) { close(); setFocused(false); } };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  });
  const panel = root.current?.closest('.reading-ai');
  const bounds = root.current?.getBoundingClientRect();
  const panelBounds = panel?.getBoundingClientRect();
  const menuTitle = opened === 'settings' ? 'Codex 对话设置' : opened === 'models' ? 'Codex 模型' : opened === 'skills' ? 'Codex 技能' : opened === 'status' ? 'Codex 状态' : opened === 'effort' ? '推理强度' : opened === 'permissions' ? '访问权限' : 'Codex 操作与技能';
  return <div className="codex-composer-tools" ref={root}>
    {children}
    <div className="codex-composer-toolbar">
      {leadingControls && <div className="codex-leading-controls">{leadingControls}</div>}
      <button type="button" className="codex-model-button" disabled={disabled} aria-label="选择 Codex 模型" title={modelLabel} onClick={() => open('models')}><span>{modelLabel}</span><ChevronDown size={12} /></button>
      {!!efforts.length && <button type="button" className="codex-effort-button" disabled={disabled} aria-label="Codex 推理强度" title={efforts.find(item => item.effort === effort)?.description || '选择此模型支持的推理强度'} onClick={() => open('effort')}>{effort ? effortLabel(effort) : '推理强度'}</button>}
      <button ref={settingsButton} type="button" disabled={disabled} className={`codex-access-button ${access === 'full-access' ? 'is-full-access' : ''}`} aria-label="Codex 对话设置" aria-haspopup="dialog" aria-expanded={manual === 'settings' || settingsParent} title={`${accessInfo[access].label} · ${settings.mode === 'plan' ? 'Plan' : 'Chat'}${skills.length ? ` · 已选 ${skills.length} 个技能` : ''} · 对话设置`} onClick={() => open('settings')}><SlidersHorizontal size={14} /><span>{access === 'read-only' ? '只读' : access === 'workspace-write' ? '写入' : '完全访问'}</span>{settings.mode === 'plan' && <strong className="codex-plan-badge">Plan</strong>}{!!skills.length && <small className="codex-skill-count">{skills.length}</small>}</button>
      {trailingControls && <div className="codex-trailing-controls">{trailingControls}</div>}
    </div>
    {opened && bounds && createPortal(<div className="codex-command-menu" role="dialog" aria-label="Codex 操作与技能" ref={menu} tabIndex={-1} onKeyDown={event => { if (event.target === menu.current) keyDown(event); }} style={{ bottom: window.innerHeight - bounds.top + 5, right: Math.max(8, window.innerWidth - (panelBounds?.right ?? bounds.right) + 12), width: Math.min(390, (panelBounds?.width ?? window.innerWidth) - 24), maxHeight: Math.max(170, Math.min(400, bounds.top - (panelBounds?.top ?? 0) - 12)) }}>
      <div className="codex-command-head">{settingsParent && <button className="icon-button" aria-label="返回 Codex 对话设置" onClick={dismiss}><ArrowLeft size={15} /></button>}<strong>{menuTitle}</strong><button className="icon-button" aria-label="刷新 Codex 能力" title="重新读取本机技能、模型及连接状态" disabled={loading} onClick={() => void load()}><RefreshCw size={14} /></button><button className="icon-button" aria-label="关闭 Codex 菜单" onClick={() => { close(); restoreFocus(); }}><X size={15} /></button></div>
      {manual && opened !== 'status' && opened !== 'settings' && <input ref={menuSearch} aria-label="搜索 Codex 操作与技能" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={keyDown} placeholder="输入名称搜索…" />}
      {loading && <p role="status">正在读取本机 Codex 能力…</p>}
      {error && <div className="codex-capability-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void load()}><RefreshCw size={14} />重新读取能力</button></div>}
      {opened === 'permissions' && <p className="codex-permissions-note">仅影响当前对话的后续请求。{projectPath ? <>研究目录：<span>{projectPath}</span></> : '当前尚未选择研究目录。'}</p>}
      {opened === 'settings' && !!skills.length && <div className="codex-skill-chips" aria-label="已选 Codex 技能">{skills.map(skill => <span key={skill.id}><strong>${skill.name}</strong><button type="button" disabled={disabled} aria-label={`移除技能 ${skill.name}`} onClick={() => { onSkills(skills.filter(item => item.id !== skill.id)); menu.current?.focus(); }}><X size={13} /></button></span>)}</div>}
      {opened === 'status' ? <dl className="codex-status"><dt>连接</dt><dd>{status}</dd><dt>模型</dt><dd>{modelLabel}</dd><dt>推理强度</dt><dd>{effort ? effortLabel(effort) : '连接默认'}</dd><dt>权限</dt><dd>{accessInfo[access].label}</dd><dt>模式</dt><dd>{settings.mode === 'plan' ? 'Plan' : 'Chat'}</dd><dt>技能</dt><dd>{skills.map(skill => skill.name).join('、') || '未选择技能'}</dd></dl> : <div role="listbox" aria-label="Codex 功能搜索结果">{choices.map((choice, choiceIndex) => <div key={`${choice.group}:${choice.id}`}>
        {(choiceIndex === 0 || choices[choiceIndex - 1].group !== choice.group) && <p className="codex-menu-group">{choice.group}</p>}
        <button type="button" role="option" tabIndex={-1} aria-label={choice.ariaLabel} aria-selected={choiceIndex === index} aria-disabled={disabled || !!choice.disabledReason} className={choiceIndex === index ? 'is-active' : ''} onMouseEnter={() => setActive(choiceIndex)} onClick={() => choose(choice)}><span className="codex-choice-label"><strong>{choice.label}</strong>{choice.selected && <Check size={14} />}</span><small>{choice.disabledReason || choice.description}</small></button>
      </div>)}</div>}
      {!loading && !choices.length && opened !== 'status' && <p className="codex-command-empty">当前连接没有匹配的可用功能。未提供的命令不会被模拟执行。</p>}
    </div>, panel ?? document.body)}
    <dialog ref={confirmation} className="codex-access-confirmation" aria-labelledby={confirmationTitle} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); setConfirmFullAccess(false); }} onClose={() => { setConfirmFullAccess(false); restoreFocus(); }}>
      <h3 id={confirmationTitle}>启用完全访问</h3>
      <p>Codex 将可以修改项目外的文件、执行命令及访问网络。</p>
      {projectPath && <p className="codex-confirm-project">研究目录：{projectPath}</p>}
      <p>仅用于当前对话之后发送的请求，不修改全局设置。</p>
      <div><button type="button" autoFocus onClick={() => setConfirmFullAccess(false)}>保留当前权限</button><button type="button" className="codex-confirm-enable" disabled={disabled || !catalog?.accessModes?.includes('full-access')} onClick={() => { onSettings({ ...settings, access: 'full-access' }); setConfirmFullAccess(false); }}>启用完全访问</button></div>
    </dialog>
  </div>;
});
