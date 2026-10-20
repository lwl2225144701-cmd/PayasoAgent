// Preview 域消息表（key 前缀 preview.）。契约：两种语言都必须有
// （satisfies MessageTable 类型强制）；用户可见位置不得残留中文
// （tests/frontend-i18n-coverage.test.ts 是总闸门）。
//
// 声明形式跟随同目录其它消息表：裸对象字面量 + as const —— 加 `: MessageTable`
// 注解会把 key 抹成索引签名，keyof typeof MESSAGES 就丢了这批 key。

import type { MessageTable } from './types';

export const previewMessages = {
  'preview.dock.title': { 'zh-CN': '文件预览', 'en-US': 'File Preview' },
  'preview.dock.close': { 'zh-CN': '关闭预览面板', 'en-US': 'Close preview panel' },
  'preview.dock.fullscreen': { 'zh-CN': '全屏', 'en-US': 'Fullscreen' },
  'preview.dock.restore': { 'zh-CN': '还原', 'en-US': 'Restore' },
  'preview.dock.closeTab': { 'zh-CN': '关闭标签', 'en-US': 'Close tab' },
  'preview.dock.open': { 'zh-CN': '打开文件预览', 'en-US': 'Open file preview' },
  // 面板首页两格：浏览器、文件。
  'preview.dock.home.browser': { 'zh-CN': '浏览器', 'en-US': 'Browser' },
  'preview.dock.home.title': { 'zh-CN': '开始', 'en-US': 'Start' },
  // 标签条：一个"文件"标签 = 一棵独立的目录树（对齐 DSH 的面板标签形态）
  'preview.dock.filesTab': { 'zh-CN': '文件', 'en-US': 'Files' },
  'preview.dock.filesTabN': { 'zh-CN': '文件 {n}', 'en-US': 'Files {n}' },
  'preview.dock.webTab': { 'zh-CN': '浏览器', 'en-US': 'Browser' },
  'preview.dock.webTabN': { 'zh-CN': '浏览器 {n}', 'en-US': 'Browser {n}' },
  'preview.browser.address': { 'zh-CN': '网址', 'en-US': 'Address' },
  'preview.browser.addressPlaceholder': {
    'zh-CN': '输入网址',
    'en-US': 'Enter a URL',
  },
  'preview.browser.back': { 'zh-CN': '后退', 'en-US': 'Back' },
  'preview.browser.forward': { 'zh-CN': '前进', 'en-US': 'Forward' },
  'preview.browser.reload': { 'zh-CN': '重新加载', 'en-US': 'Reload' },
  'preview.browser.invalid': {
    'zh-CN': '请输入 http 或 https 网址',
    'en-US': 'Enter an http or https URL',
  },
  'preview.browser.empty': {
    'zh-CN': '输入网址后打开',
    'en-US': 'Enter a URL to open it',
  },
  'preview.browser.frame': { 'zh-CN': '内嵌网页', 'en-US': 'Embedded page' },
  'preview.dock.newTab': { 'zh-CN': '新建标签', 'en-US': 'New tab' },
  // 文件预览视图顶部的操作条（路径 + 刷新 + 在应用中打开）
  'preview.fileBar.path': { 'zh-CN': '文件路径', 'en-US': 'File path' },
  'preview.fileBar.openIn': { 'zh-CN': '在应用中打开', 'en-US': 'Open in app' },
  'preview.fileBar.openWith': { 'zh-CN': '用 {app} 打开', 'en-US': 'Open with {app}' },
  'preview.fileBar.reveal': { 'zh-CN': '显示文件位置', 'en-US': 'Show in File Manager' },
  'preview.fileBar.revealed': {
    'zh-CN': '已在文件管理器中显示',
    'en-US': 'Revealed in File Manager',
  },
  'preview.launcher.menu': { 'zh-CN': '预览菜单', 'en-US': 'Preview menu' },
  'preview.launcher.opened': { 'zh-CN': '已在外部工具中打开', 'en-US': 'Opened in external tool' },
  'preview.launcher.openDefault': {
    'zh-CN': '用 {app} 打开工作区',
    'en-US': 'Open workspace in {app}',
  },
  'preview.launcher.loadFailed': {
    'zh-CN': '应用列表加载失败',
    'en-US': 'Failed to load app list',
  },
  'preview.launcher.empty': {
    'zh-CN': '未检测到已安装的应用',
    'en-US': 'No installed apps detected',
  },
  'preview.launcher.defaultSuffix': { 'zh-CN': '（默认）', 'en-US': ' (default)' },

  'preview.tree.root': { 'zh-CN': '工作区文件', 'en-US': 'Workspace Files' },
  'preview.tree.refresh': { 'zh-CN': '刷新', 'en-US': 'Refresh' },
  'preview.tree.showIgnored': { 'zh-CN': '显示忽略目录', 'en-US': 'Show ignored' },
  'preview.tree.filter': { 'zh-CN': '过滤文件名', 'en-US': 'Filter files' },
  'preview.tree.loading': { 'zh-CN': '加载中…', 'en-US': 'Loading…' },
  'preview.tree.empty': { 'zh-CN': '空目录', 'en-US': 'Empty directory' },
  'preview.tree.truncated': {
    'zh-CN': '条目过多，仅显示前 {max} 项',
    'en-US': 'Too many entries, showing first {max}',
  },
  'preview.tree.error.no_workspace': {
    'zh-CN': '请先选择工作区',
    'en-US': 'Select a workspace first',
  },
  'preview.tree.error.not_found': {
    'zh-CN': '目录不存在或已被删除',
    'en-US': 'Directory not found or deleted',
  },
  'preview.tree.error.outside_workspace': {
    'zh-CN': '无权访问该目录',
    'en-US': 'Access denied for this directory',
  },
  'preview.tree.error.invalid_path': {
    'zh-CN': '目录路径无效',
    'en-US': 'Invalid directory path',
  },
  'preview.tree.error.generic': {
    'zh-CN': '目录加载失败',
    'en-US': 'Failed to load directory',
  },
  'preview.tree.selectWorkspace': { 'zh-CN': '选择工作区', 'en-US': 'Select workspace' },

  'preview.viewer.loading': { 'zh-CN': '加载中…', 'en-US': 'Loading…' },
  'preview.viewer.download': { 'zh-CN': '下载', 'en-US': 'Download' },
  'preview.viewer.reason.pending': {
    'zh-CN': '该类型的可视化预览即将支持，可先下载查看',
    'en-US': 'Visual preview for this type is coming soon — download to view',
  },
  'preview.viewer.reason.unsupported': {
    'zh-CN': '暂不支持预览该文件类型',
    'en-US': 'Preview is not supported for this file type',
  },
  'preview.viewer.reason.not_found': {
    'zh-CN': '文件不存在或已被删除',
    'en-US': 'File not found or deleted',
  },
  'preview.viewer.reason.permission_denied': {
    'zh-CN': '当前工作区为只读，无法写回',
    'en-US': 'Workspace is read-only; write-back is disabled',
  },
  'preview.viewer.reason.outside_workspace': {
    'zh-CN': '文件路径越出工作区',
    'en-US': 'File path escapes the workspace',
  },
  'preview.viewer.reason.invalid_path': {
    'zh-CN': '文件路径无效',
    'en-US': 'Invalid file path',
  },
  'preview.viewer.reason.no_workspace': {
    'zh-CN': '请先选择工作区',
    'en-US': 'Select a workspace first',
  },
  'preview.viewer.reason.loadFailed': {
    'zh-CN': '加载失败',
    'en-US': 'Failed to load',
  },
  'preview.viewer.image.zoomIn': { 'zh-CN': '放大', 'en-US': 'Zoom in' },
  'preview.viewer.image.zoomOut': { 'zh-CN': '缩小', 'en-US': 'Zoom out' },
  'preview.viewer.image.reset': { 'zh-CN': '复位', 'en-US': 'Reset' },
  'preview.viewer.pdf.page': { 'zh-CN': '页码', 'en-US': 'Page' },
  'preview.viewer.sheet.rows': { 'zh-CN': '{count} 行', 'en-US': '{count} rows' },
  'preview.viewer.sheet.columns': { 'zh-CN': '{count} 列', 'en-US': '{count} columns' },
  'preview.viewer.sheet.header': {
    'zh-CN': '首列「{first}」',
    'en-US': 'first column "{first}"',
  },
} as const satisfies MessageTable;
