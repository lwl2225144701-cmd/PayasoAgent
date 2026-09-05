import { type ReactNode, useState } from 'react';
import { ChevronRightIcon } from '../icons';
import styles from './Collapse.module.css';

interface CollapseProps {
  /** 头部内容（不含箭头），支持函数形式获取当前展开状态 */
  header: ReactNode | ((expanded: boolean) => ReactNode);
  /** 是否默认展开（非受控模式） */
  defaultExpanded?: boolean;
  /** 受控展开状态 */
  expanded?: boolean;
  /** 切换回调（提供此值则进入受控模式） */
  onToggle?: (expanded: boolean) => void;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  /** 是否显示内置箭头（默认 true；隐藏时由调用方自行提供指示符） */
  arrow?: boolean;
}

export function Collapse({
  header,
  defaultExpanded = false,
  expanded: controlled,
  onToggle,
  children,
  className = '',
  headerClassName = '',
  contentClassName = '',
  arrow = true,
}: CollapseProps) {
  const [internal, setInternal] = useState(defaultExpanded);
  const isExpanded = controlled !== undefined ? controlled : internal;

  const handleClick = () => {
    const next = !isExpanded;
    if (controlled === undefined) setInternal(next);
    onToggle?.(next);
  };

  return (
    <div className={`${styles.collapse} ${className}`}>
      {/* 自绘折叠头：已实现键盘（Enter/空格）+ aria-expanded，div 承载复杂布局 */}
      {/* biome-ignore lint/a11y/useSemanticElements: 折叠头为自绘交互控件，button 会引入默认样式覆盖成本 */}
      <div
        role="button"
        tabIndex={0}
        className={`${styles.header} ${headerClassName}`}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        aria-expanded={isExpanded}
      >
        {arrow && (
          <span className={`${styles.arrow} ${isExpanded ? styles.expanded : ''}`}>
            <ChevronRightIcon size={14} />
          </span>
        )}
        <span className={styles.headerContent}>
          {typeof header === 'function' ? header(isExpanded) : header}
        </span>
      </div>
      {isExpanded && <div className={`${styles.content} ${contentClassName}`}>{children}</div>}
    </div>
  );
}
