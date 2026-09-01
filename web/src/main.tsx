import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyThemeMode, readThemeMode } from './theme';

// 在 React 首次绘制前应用保存的主题，减少刷新时的颜色闪烁。
applyThemeMode(readThemeMode());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
