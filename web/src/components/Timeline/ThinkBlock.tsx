import { useState } from 'react';
import { ThinkIcon, ChevronDownIcon } from '../icons';
import styles from './ThinkBlock.module.css';

interface ThinkBlockProps {
  text: string;
}

export function ThinkBlock({ text }: ThinkBlockProps) {
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, ' ').trim();
  const shortPreview = preview.length > 180 ? `${preview.slice(0, 180)}…` : preview;

  return (
    <section className={styles.block} aria-label="模型思考">
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className={styles.iconSlot} aria-hidden="true">
          <ThinkIcon size={18} className={styles.atomIcon} />
          <ChevronDownIcon size={15} className={styles.hoverIcon} />
        </span>
        <span className={styles.label}>Think</span>
        {!open && (
          <>
            <span className={styles.separator}>·</span>
            <span className={styles.preview}>{shortPreview}</span>
          </>
        )}
      </button>

      {open && <div className={styles.content}>{text}</div>}
    </section>
  );
}
