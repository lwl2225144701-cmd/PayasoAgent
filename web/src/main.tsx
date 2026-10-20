import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import { applyConversationFontSize, readConversationFontSize } from './preferences';
import { applyThemeMode, readThemeMode } from './theme';

// 在 React 首次绘制前应用保存的主题，减少刷新时的颜色闪烁。
applyThemeMode(readThemeMode());
applyConversationFontSize(readConversationFontSize());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* 根级兜底：渲染期异常此前会直接卸载整棵树 → 整页空白。
        包在 StrictMode 内侧、App 外侧：App 及其所有子树都在保护范围内。 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
