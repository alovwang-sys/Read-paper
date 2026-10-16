import { useEffect, useId, useState, type RefObject } from 'react';
import { Mic, X } from 'lucide-react';
import './voice-input.css';

type Props = { inputRef: RefObject<HTMLTextAreaElement | null>; disabled?: boolean };

export function VoiceInput({ inputRef, disabled }: Props) {
  const [opened, setOpened] = useState(false);
  const id = useId();
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const shortcut = /Win/i.test(platform)
    ? 'Windows：按 Win + H 开启系统听写。'
    : /Mac/i.test(platform)
      ? 'macOS：使用系统设置中的听写快捷键，常见设置为连按两次 Fn／🌐。'
      : '请使用操作系统提供的听写功能，将识别文字输入当前草稿。';

  function close() { setOpened(false); inputRef.current?.focus(); }

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
    <button type="button" className="icon-button ai-voice-button" aria-label="语音输入" title="语音输入 · 使用系统听写" aria-expanded={opened} aria-controls={opened ? id : undefined} disabled={disabled} onClick={() => { setOpened(!opened); inputRef.current?.focus(); }}>
      <Mic size={16} aria-hidden="true" />
    </button>
    {opened && <div id={id} className="ai-voice-hint" role="status">
      <div>
        <strong>使用系统听写</strong>
        <p>识别文字留在草稿，不自动发送。</p>
        <p>{shortcut}</p>
        <small>当前连接尚未提供内置录音转写。</small>
      </div>
      <button type="button" className="ai-voice-dismiss" aria-label="关闭语音输入说明" title="关闭说明 · Esc" onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>}
  </div>;
}
