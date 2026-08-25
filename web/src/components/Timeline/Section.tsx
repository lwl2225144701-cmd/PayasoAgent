import type { ReactNode } from 'react';
import styles from './Timeline.module.css';

export type SectionVariant = 'default' | 'user' | 'assistant' | 'tools' | 'final';

interface SectionProps {
  icon?: ReactNode;
  label?: string;
  filled?: boolean;
  variant?: SectionVariant;
  children: ReactNode;
}

export function Section({ icon, label, filled, variant = 'default', children }: SectionProps) {
  const sectionClass =
    variant === 'user' ? styles.sectionUser :
    variant === 'assistant' ? styles.sectionAssistant :
    variant === 'tools' ? styles.sectionTools :
    variant === 'final' ? styles.sectionFinal :
    styles.sectionDefault;

  const hasChrome = !!(icon && label);

  return (
    <section className={sectionClass}>
      {hasChrome && (
        <div className={styles.sectionIconCol}>
          <span className={`${styles.sectionIcon} ${filled ? styles.sectionIconFilled : ''}`}>
            {icon}
          </span>
        </div>
      )}
      <div className={styles.sectionBody}>
        {hasChrome && <div className={styles.sectionLabel}>{label}</div>}
        {children}
      </div>
    </section>
  );
}
