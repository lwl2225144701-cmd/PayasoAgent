// 预览由 Host 使用与执行相同的插值函数生成，避免浏览器维护第二套模板语义。
import { useEffect, useState } from 'react';
import { previewPromptCommand } from '../../api';
import { useI18n } from '../../i18n';
import type { PermissionMode, PromptCommand } from '../../types';
import styles from './InputBar.module.css';

export function PromptPreview({
  task,
  command,
  permissionMode,
  onApply,
}: {
  task: string;
  command: PromptCommand;
  permissionMode: PermissionMode;
  onApply: (text: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setPreview(undefined);
    setFailed(false);
    if (!open) return;
    let active = true;
    const timer = setTimeout(() => {
      previewPromptCommand(task, permissionMode)
        .then(({ text }) => {
          if (active) setPreview(text);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [task, permissionMode, open]);
  return (
    <div className={styles.templatePreview}>
      {command.argumentHint && <small>{command.argumentHint}</small>}
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {t('delivery.previewTemplate')}
      </button>
      {open && (
        <>
          {failed || preview === null ? (
            <p>{t('delivery.previewFailed')}</p>
          ) : preview === undefined ? (
            <p>{t('common.loading')}</p>
          ) : (
            <>
              <pre>{preview}</pre>
              <button type="button" onClick={() => onApply(preview)}>
                {t('delivery.applyTemplate')}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
