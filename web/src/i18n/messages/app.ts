// app 领域消息表：应用外壳层（App.tsx）的 toast / alert / 斜杠命令回执 / 空态。
// key 前缀 `app.`。
// 说明：斜杠命令回执里，命令语法本身（如 `/model <provider/…>`）保持英文原样，
// 只翻译说明性文字——命令名是用户要照着敲的字面量。

export const appMessages = {
  // 会话标题兜底（Host 侧另有同名规则；这里是乐观更新的本地兜底）
  'app.untitledTask': { 'zh-CN': '未命名任务', 'en-US': 'Untitled task' },

  // 设置与默认模型
  'app.defaultModelSaveFailed': {
    'zh-CN': '默认模型保存失败：{message}',
    'en-US': 'Failed to save default model: {message}',
  },

  // Run 创建与队列
  'app.createRunFailed': {
    'zh-CN': '任务创建失败：{message}',
    'en-US': 'Failed to create run: {message}',
  },
  'app.stoppingForQueue': {
    'zh-CN': '正在停止当前任务，准备发送队列消息…',
    'en-US': 'Stopping the current run to send the queued message…',
  },
  'app.sendNowFailed': {
    'zh-CN': '立即发送失败：{message}',
    'en-US': 'Failed to send immediately: {message}',
  },

  // 内置斜杠命令
  'app.needSession': {
    'zh-CN': '请先打开一个会话再使用该命令',
    'en-US': 'Open a session before using this command',
  },
  'app.exportStarted': {
    'zh-CN': '会话日志归档已开始下载',
    'en-US': 'Session log archive download started',
  },
  'app.feedbackUsage': { 'zh-CN': '用法：/feedback <意见>', 'en-US': 'Usage: /feedback <comment>' },
  'app.feedbackRecorded': {
    'zh-CN': '反馈已记录，谢谢！',
    'en-US': 'Feedback recorded — thank you!',
  },
  'app.goalCurrent': { 'zh-CN': '当前目标：{goal}', 'en-US': 'Current goal: {goal}' },
  'app.goalUnset': {
    'zh-CN': '未设置目标；用法 /goal <目标内容>',
    'en-US': 'No goal set; usage: /goal <goal text>',
  },
  'app.goalUpdated': { 'zh-CN': '会话目标已更新', 'en-US': 'Session goal updated' },
  'app.permissionCurrent': {
    'zh-CN': '当前权限：{mode}；用法 /permission read-only | workspace-write | full-access',
    'en-US':
      'Current permission: {mode}; usage: /permission read-only | workspace-write | full-access',
  },
  'app.permissionUnknown': {
    'zh-CN': '无法识别的权限档；可用 read-only / workspace-write / full-access',
    'en-US': 'Unrecognized permission mode; available: read-only / workspace-write / full-access',
  },
  'app.permissionSwitched': {
    'zh-CN': '权限已切换：{mode}（对下一轮生效）',
    'en-US': 'Permission switched to {mode} (applies to the next run)',
  },
  'app.planModeOn': {
    'zh-CN': '已进入计划模式：只读 + 仅产出方案（对下一轮生效）；再次 /plan 退出',
    'en-US': 'Plan mode on: read-only, plan only (applies to the next run); run /plan to exit',
  },
  'app.planModeOff': { 'zh-CN': '已退出计划模式', 'en-US': 'Plan mode off' },
  'app.modelCurrent': {
    'zh-CN': '当前模型：{provider}/{model}；用法 /model <关键词>',
    'en-US': 'Current model: {provider}/{model}; usage: /model <keyword>',
  },
  'app.modelUsage': {
    'zh-CN': '用法：/model <provider/模型关键词>',
    'en-US': 'Usage: /model <provider/model keyword>',
  },
  'app.modelSwitched': {
    'zh-CN': '模型已切换：{provider}/{model}',
    'en-US': 'Model switched to {provider}/{model}',
  },
  'app.modelMatchMany': {
    'zh-CN': '匹配到 {count} 个模型，请更精确：{list}',
    'en-US': 'Matched {count} models — please be more specific: {list}',
  },
  'app.modelNoMatch': {
    'zh-CN': '没有匹配的模型；用 /model <provider/模型关键词> 重试',
    'en-US': 'No matching model; retry with /model <provider/model keyword>',
  },
  'app.commandFailed': {
    'zh-CN': '/{name} 执行失败：{message}',
    'en-US': '/{name} failed: {message}',
  },
  // 列举分隔符：中文用顿号，英文用逗号（不要用顿号硬拼英文）
  'app.listSeparator': { 'zh-CN': '、', 'en-US': ', ' },

  // 工作区与会话管理
  'app.renameFailed': { 'zh-CN': '重命名失败：{message}', 'en-US': 'Rename failed: {message}' },
  'app.renameSucceeded': { 'zh-CN': '重命名成功', 'en-US': 'Renamed' },
  'app.deleteWorkspaceFailed': {
    'zh-CN': '删除工作区失败：{message}',
    'en-US': 'Failed to delete workspace: {message}',
  },
  'app.archived': { 'zh-CN': '已归档', 'en-US': 'Archived' },
  'app.archiveFailed': { 'zh-CN': '归档失败：{message}', 'en-US': 'Archive failed: {message}' },
  'app.openWorkspaceFailed': { 'zh-CN': '打开工作区失败', 'en-US': 'Failed to open workspace' },
  'app.selectWorkspaceFailed': {
    'zh-CN': '选择工作区失败',
    'en-US': 'Failed to select workspace',
  },

  // 空态与首屏
  'app.preparingWorkspace': { 'zh-CN': '正在准备工作区…', 'en-US': 'Preparing workspace…' },
  'app.heroTitle': {
    'zh-CN': '路漫漫其修远兮，吾将上下而求索。',
    'en-US': 'The road ahead is long; I will search high and low.',
  },
  'app.heroPlaceholder': {
    'zh-CN': '描述你想要构建的内容',
    'en-US': 'Describe what you want to build',
  },
} as const;
