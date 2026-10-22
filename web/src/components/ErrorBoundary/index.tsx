import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translator } from '../../i18n/translate';
import { readLanguageMode } from '../../preferences';
import styles from './ErrorBoundary.module.css';

/**
 * 根级错误边界：任何组件在渲染期抛出的异常都在这里被接住。
 *
 * 为什么必须有：React 的错误传播规则是「没有边界 → 卸载整棵树」。此前的表现是
 * 单个控件（例如回合导航条对一次异常数据调用 `.slice()`）出错，代价却是**整页空白**，
 * 用户看到的是一个白屏和一个只能靠控制台解释的现象。有了这层兜底，代价收敛为
 * 「换成一个可重新加载的提示页」，且异常本身仍然原样打到 console 供排查。
 *
 * 用 class 而不是函数组件是 React 的硬性要求：只有 class 能实现
 * getDerivedStateFromError / componentDidCatch。
 *
 * 语言直接读本地偏好（preferences.readLanguageMode）而不是 useI18n：本组件挂在
 * I18nProvider 之外 —— 崩的那棵树可能就是 Provider 自身所在的树，边界不能再依赖它。
 */
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // i18n-exempt: 纯开发期日志（console.error），不是界面文案
    const logLabel = '[ErrorBoundary] 渲染异常已兜住（页面降级为提示页）:';
    console.error(logLabel, error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const t = translator(readLanguageMode());
    return (
      <div className={styles.root} role="alert">
        <div className={styles.card}>
          <h1 className={styles.title}>{t('app.crash.title')}</h1>
          <p className={styles.hint}>{t('app.crash.hint')}</p>
          <button type="button" className={styles.action} onClick={this.handleReload}>
            {t('app.crash.reload')}
          </button>
        </div>
      </div>
    );
  }
}
