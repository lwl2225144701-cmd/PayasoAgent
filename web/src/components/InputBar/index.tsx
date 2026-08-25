import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { PaperclipIcon, SendIcon, KbdEnterIcon } from '../icons';
import styles from './InputBar.module.css';

interface InputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({ onSend, disabled, placeholder = '输入任务…' }: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }, [text]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  }

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <div className={styles.inputBar}>
      <div className={styles.inputWrapper}>
        <button className={styles.attachBtn} title="附件（即将上线）" type="button">
          <PaperclipIcon size={18} />
        </button>
        <textarea
          ref={textareaRef}
          className={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
        />
        <div className={styles.actions}>
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!canSend}
            title="发送（回车）"
            type="button"
          >
            <SendIcon size={16} />
          </button>
          <span className={styles.kbdHint} title="Enter to send · Shift+Enter for new line">
            <KbdEnterIcon size={18} />
          </span>
        </div>
      </div>
    </div>
  );
}
