// 四个面板开关入口共用尺寸：左侧展开/收起、右侧打开/关闭。
// 避免只调整 Launcher，打开面板后又换回 PreviewDock 的旧图标。
import type { ButtonHTMLAttributes } from 'react';
import { PanelLeftIcon, PanelRightIcon } from '../icons';
import styles from './PanelToggleButton.module.css';

interface PanelToggleButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  side: 'left' | 'right';
}

export function PanelToggleButton({
  side,
  className = '',
  type = 'button',
  ...props
}: PanelToggleButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.button} ${className}`}
      data-panel-toggle={side}
    >
      {side === 'left' ? <PanelLeftIcon size={17} /> : <PanelRightIcon size={17} />}
    </button>
  );
}
