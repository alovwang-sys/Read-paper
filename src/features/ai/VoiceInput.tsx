import { useEffect, useId, useState, type RefObject } from 'react';
import { Mic, X } from 'lucide-react';
import './voice-input.css';

type Props = { inputRef: RefObject<HTMLTextAreaElement | null>; disabled?: boolean };

export function VoiceInput({ inputRef, disabled }: Props) {
  const [opened, setOpened] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const shortcut = /Win/i.test(platform)
    ? 'Windows：按 Win + H 开启系统听写。'
    : /Mac/i.test(platform)
      ? 'macOS：使用系统设置中的听写快捷键，常见设置为连按两次 Fn／🌐。'
      : '请使用操作系统提供的听写功能，将识别文字输入当前草稿。';

  function close() { setOpened(false); inputRef.current?.focus(); }

  async function open() {
    setOpened(true);
    setError('');
    setRequested(false);
    inputRef.current?.focus();
    try {
      setRequested(await window.papertrailDesktop?.startDictation?.() ?? false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '未能请求系统听写，请使用系统快捷键。');
    }
  }

  useEffect(() => {
    if (!opened) return;
    function dismiss(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpened(false);
      inputRef.current?.focus();
    }
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [opened, inputRef]);

  return <div className="ai-voice-input">
    <button type="button" className="ai-voice-button" aria-label="语音输入" title="语音输入 · 使用系统听写" aria-expanded={opened} aria-controls={opened ? id : undefined} disabled={disabled} onClick={() => { if (opened) close(); else void open(); }}>
      <Mic size={16} aria-hidden="true" /><span>语音</span>
    </button>
    {opened && <div id={id} className="ai-voice-hint" role="status">
      <div>
        <strong>使用系统听写</strong>
        {requested && <p>已请求系统听写，请根据系统提示开始说话；若未出现，请使用下方快捷键。</p>}
        {error && <p>{error}</p>}
        <p>识别文字留在草稿，不自动发送。</p>
        <p>{shortcut}</p>
        <small>通过系统听写输入文字，当前助手无需接收录音。可在系统设置 → 键盘中启用或调整听写。</small>
      </div>
      <button type="button" className="ai-voice-dismiss" aria-label="关闭语音输入说明" title="关闭说明 · Esc" onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>}
  </div>;
}
