import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyConversationFontSize, readConversationFontSize } from './preferences';
import { applyThemeMode, readThemeMode } from './theme';

// 在 React 首次绘制前应用保存的主题，减少刷新时的颜色闪烁。
applyThemeMode(readThemeMode());
applyConversationFontSize(readConversationFontSize());

// 标记运行环境（桌面壳的平台 / 纯浏览器）。Windows 壳没有系统标题栏，
// 顶栏要靠它给右上角的窗口按钮（WCO）让位 —— 必须首帧前定好，否则按钮会压住顶栏元素。
document.documentElement.dataset.shellPlatform = window.payasoDesktop?.platform ?? 'web';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
