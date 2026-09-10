// 通用文案（跨领域复用的短词）：状态、时间、确认类按钮、通用错误前缀。
// key 前缀 `common.`。

export const commonMessages = {
  'common.ok': { 'zh-CN': '确定', 'en-US': 'OK' },
  'common.cancel': { 'zh-CN': '取消', 'en-US': 'Cancel' },
  'common.close': { 'zh-CN': '关闭', 'en-US': 'Close' },
  'common.confirm': { 'zh-CN': '确认', 'en-US': 'Confirm' },
  'common.delete': { 'zh-CN': '删除', 'en-US': 'Delete' },
  'common.edit': { 'zh-CN': '编辑', 'en-US': 'Edit' },
  'common.retry': { 'zh-CN': '重试', 'en-US': 'Retry' },
  'common.save': { 'zh-CN': '保存', 'en-US': 'Save' },
  'common.saving': { 'zh-CN': '保存中…', 'en-US': 'Saving…' },
  'common.loading': { 'zh-CN': '加载中…', 'en-US': 'Loading…' },
  'common.refreshing': { 'zh-CN': '刷新中…', 'en-US': 'Refreshing…' },
  'common.copy': { 'zh-CN': '复制', 'en-US': 'Copy' },
  'common.copied': { 'zh-CN': '已复制', 'en-US': 'Copied' },
  'common.expand': { 'zh-CN': '展开', 'en-US': 'Expand' },
  'common.collapse': { 'zh-CN': '收起', 'en-US': 'Collapse' },

  // Run / 计划项状态
  'common.status.running': { 'zh-CN': '执行中', 'en-US': 'Running' },
  'common.status.completed': { 'zh-CN': '已完成', 'en-US': 'Completed' },
  'common.status.failed': { 'zh-CN': '失败', 'en-US': 'Failed' },
  'common.status.pending': { 'zh-CN': '待办', 'en-US': 'Pending' },
  'common.status.inProgress': { 'zh-CN': '进行中', 'en-US': 'In progress' },

  // 相对时间
  'common.time.justNow': { 'zh-CN': '刚刚', 'en-US': 'Just now' },
  'common.time.minutes': { 'zh-CN': '{count}分钟', 'en-US': '{count}m' },
  'common.time.hours': { 'zh-CN': '{count}小时', 'en-US': '{count}h' },
  'common.time.yesterday': { 'zh-CN': '昨天', 'en-US': 'Yesterday' },
  'common.time.milliseconds': { 'zh-CN': '{value}毫秒', 'en-US': '{value}ms' },
  'common.time.seconds': { 'zh-CN': '{value}秒', 'en-US': '{value}s' },
  'common.time.minutesSeconds': {
    'zh-CN': '{min}分{sec}秒',
    'en-US': '{min}m {sec}s',
  },
} as const;
