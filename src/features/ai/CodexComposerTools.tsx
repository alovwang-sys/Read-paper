import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import type { AgentSkill, CodexCapabilities, CodexSettings } from '../../domain/types';
import { getCodexCapabilities } from '../../services/agents';

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
};
type Menu = 'all' | 'skills' | 'models' | 'status';
type Choice = { id: string; label: string; description: string; group: string; disabledReason?: string; run(): void };

export const CodexComposerTools = forwardRef<CodexComposerToolsHandle, Props>(function CodexComposerTools({ inputRef, value, skills, settings, status, onInput, onSkills, onSettings, onNew }, ref) {
  const [catalog, setCatalog] = useState<CodexCapabilities>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [manual, setManual] = useState<Menu>();
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuSearch = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  async function load() {
    setLoading(true); setError('');
    try { const result = await getCodexCapabilities(); if (alive.current) setCatalog(result); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '无法读取 Codex 的技能与模型，请重试。'); }
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
  const prefix = value.slice(0, Math.min(cursor, value.length));
  const match = /(^|\s)([/$])([^\s]*)$/.exec(prefix);
  const token = match ? { start: match.index + match[1].length, end: prefix.length, symbol: match[2], query: match[3] } : undefined;
  const tokenKey = `${value}:${cursor}`;
  const automatic = focused && token && dismissed !== tokenKey ? token.symbol === '$' ? 'skills' : 'all' : undefined;
  const opened = manual ?? automatic;
  const query = (manual ? search : token?.query ?? '').toLocaleLowerCase();
  function close() { setManual(undefined); setSearch(''); setDismissed(tokenKey); }
  function consumeToken() { if (token) onInput(value.slice(0, token.start) + value.slice(token.end)); }
  function open(kind: Menu) { setManual(kind); setSearch(''); setActive(0); }
  function selectSkill(skill: AgentSkill) {
    if (!skill.enabled || (skills.length >= 4 && !skills.some(selected => selected.id === skill.id))) return;
    if (!skills.some(selected => selected.id === skill.id)) onSkills([...skills, skill]);
    consumeToken(); close(); inputRef.current?.focus();
  }
  const actions: Choice[] = [
    { id: '/new', label: '/new', description: '新建干净对话，保留当前记录', group: '平台动作', run: () => { consumeToken(); close(); onNew(); } },
    { id: '/skills', label: '/skills', description: '搜索并选择 Codex 实际提供的技能', group: '平台动作', run: () => { consumeToken(); open('skills'); } },
    { id: '/model', label: '/model', description: '选择此连接实际提供的模型', group: '平台动作', disabledReason: !catalog?.models.length ? '当前连接尚未提供可选模型' : undefined, run: () => { consumeToken(); open('models'); } },
    { id: '/plan', label: '/plan', description: settings.mode === 'plan' ? '切换回 Chat 模式' : '切换为 Plan 模式', group: '平台动作', disabledReason: !catalog?.plan ? '当前 Codex 连接不支持 Plan 模式' : undefined, run: () => { consumeToken(); onSettings({ ...settings, mode: settings.mode === 'plan' ? 'chat' : 'plan' }); close(); inputRef.current?.focus(); } },
    { id: '/status', label: '/status', description: '查看连接、模型、模式及已选技能', group: '平台动作', run: () => { consumeToken(); open('status'); } },
  ];
  const skillChoices: Choice[] = (catalog?.skills ?? []).map(skill => ({ id: skill.id, label: `$${skill.name}`, description: skill.description, group: 'Codex 技能', disabledReason: !skill.enabled ? skill.disabledReason || '此技能当前不可用' : skills.length >= 4 && !skills.some(selected => selected.id === skill.id) ? '每轮最多选择 4 个技能，请先移除一个已选技能' : undefined, run: () => selectSkill(skill) }));
  const models: Choice[] = (catalog?.models ?? []).map(model => ({ id: model.id, label: model.name, description: `${model.id}${model.isDefault ? ' · 连接默认' : ''}`, group: 'Codex 模型', run: () => { onSettings({ ...settings, model: model.id }); consumeToken(); close(); inputRef.current?.focus(); } }));
  const choices = (opened === 'models' ? models : opened === 'skills' ? skillChoices : opened === 'status' ? [] : [...actions, ...skillChoices]).filter(item => `${item.label} ${item.description}`.toLocaleLowerCase().includes(query));
  const index = Math.min(active, Math.max(0, choices.length - 1));
  function choose(choice?: Choice) { if (!choice || choice.disabledReason) return; choice.run(); }
  function keyDown(event: KeyboardEvent | React.KeyboardEvent) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); inputRef.current?.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % Math.max(1, choices.length)); }
    else if (event.key === 'Enter' && !('nativeEvent' in event ? event.nativeEvent.isComposing : event.isComposing) && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); choose(choices[index]); }
  }
  useImperativeHandle(ref, () => ({ handleSubmit() {
    if (!token || !/^\s*[/$][^\s]*\s*$/.test(value)) return false;
    const exact = [...actions, ...skillChoices].find(item => item.label.toLocaleLowerCase() === `${token.symbol}${token.query}`.toLocaleLowerCase());
    if (exact) choose(exact); else { setDismissed(''); setFocused(true); inputRef.current?.focus(); }
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
  useEffect(() => { if (manual) menuSearch.current?.focus(); }, [manual]);
  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node) && event.target !== inputRef.current) { close(); setFocused(false); } };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); inputRef.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  });
  const panel = root.current?.closest('.reading-ai');
  const bounds = root.current?.getBoundingClientRect();
  const panelBounds = panel?.getBoundingClientRect();
  const modelLabel = catalog?.models.find(model => model.id === settings.model)?.name ?? settings.model ?? catalog?.models.find(model => model.isDefault)?.name ?? '连接默认模型';
  return <div className="codex-composer-tools" ref={root}>
    {!!skills.length && <div className="codex-skill-chips" aria-label="已选 Codex 技能">{skills.map(skill => <span key={skill.id}><strong>${skill.name}</strong><button type="button" aria-label={`移除技能 ${skill.name}`} onClick={() => onSkills(skills.filter(item => item.id !== skill.id))}><X size={11} /></button></span>)}</div>}
    <div className="codex-settings-row">
      <button type="button" onClick={() => open('skills')}><SlidersHorizontal size={12} />技能</button>
      <button type="button" onClick={() => open('models')} title={settings.model}>{modelLabel}<ChevronDown size={11} /></button>
      <button type="button" aria-label="切换 Codex Chat/Plan 模式" aria-pressed={settings.mode === 'plan'} disabled={!catalog?.plan} title={!catalog?.plan ? '当前连接不支持 Plan 模式' : '切换 Chat / Plan'} onClick={() => onSettings({ ...settings, mode: settings.mode === 'plan' ? 'chat' : 'plan' })}>{settings.mode === 'plan' ? 'Plan' : 'Chat'}</button>
      <small>/ 操作 · $ 技能</small>
    </div>
    {opened && bounds && createPortal(<div className="codex-command-menu" role="dialog" aria-label="Codex 操作与技能" ref={menu} style={{ bottom: window.innerHeight - bounds.top + 5, right: Math.max(8, window.innerWidth - (panelBounds?.right ?? bounds.right) + 12), width: Math.min(390, (panelBounds?.width ?? window.innerWidth) - 24), maxHeight: Math.max(170, Math.min(400, bounds.top - (panelBounds?.top ?? 0) - 12)) }}>
      <div className="codex-command-head"><strong>{opened === 'models' ? 'Codex 模型' : opened === 'skills' ? 'Codex 技能' : opened === 'status' ? 'Codex 状态' : 'Codex 操作与技能'}</strong><button className="icon-button" aria-label="刷新 Codex 能力" title="重新读取本机技能、模型及连接状态" disabled={loading} onClick={() => void load()}><RefreshCw size={13} /></button><button className="icon-button" aria-label="关闭 Codex 菜单" onClick={() => { close(); inputRef.current?.focus(); }}><X size={13} /></button></div>
      {manual && opened !== 'status' && <input ref={menuSearch} aria-label="搜索 Codex 操作与技能" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={keyDown} placeholder="输入名称搜索…" />}
      {loading && <p role="status">正在读取本机 Codex 能力…</p>}
      {error && <div className="codex-capability-error" role="alert"><p>{error}</p><button className="text-button" onClick={() => void load()}><RefreshCw size={12} />重新读取能力</button></div>}
      {opened === 'status' ? <dl className="codex-status"><dt>连接</dt><dd>{status}</dd><dt>模型</dt><dd>{modelLabel}</dd><dt>模式</dt><dd>{settings.mode === 'plan' ? 'Plan' : 'Chat'}</dd><dt>技能</dt><dd>{skills.map(skill => skill.name).join('、') || '未选择技能'}</dd></dl> : <div role="listbox" aria-label="Codex 功能搜索结果">{choices.map((choice, choiceIndex) => <div key={`${choice.group}:${choice.id}`}>
        {(choiceIndex === 0 || choices[choiceIndex - 1].group !== choice.group) && <p className="codex-menu-group">{choice.group}</p>}
        <button type="button" role="option" tabIndex={-1} aria-selected={choiceIndex === index} aria-disabled={!!choice.disabledReason} className={choiceIndex === index ? 'is-active' : ''} onMouseEnter={() => setActive(choiceIndex)} onClick={() => choose(choice)}><strong>{choice.label}</strong><small>{choice.disabledReason || choice.description}</small></button>
      </div>)}</div>}
      {!loading && !choices.length && opened !== 'status' && <p className="codex-command-empty">当前连接没有匹配的可用功能。未提供的命令不会被模拟执行。</p>}
    </div>, panel ?? document.body)}
  </div>;
});
