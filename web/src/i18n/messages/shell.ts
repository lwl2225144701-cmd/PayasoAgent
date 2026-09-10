// shell 领域消息表：顶栏（ShellBar）、侧栏（Sidebar）、会话项（SessionItem）、
// 工作区分组（WorkspaceSection）、目录选择（WorkspacePickerModal）、
// 回合导航（TurnNavigator）、文件预览（FileModal）。key 前缀 `shell.`。
// 通用短词（确定/取消/复制/加载中…）复用 common.*，这里不重复定义。

export const shellMessages = {
  // 侧栏骨架
  'shell.sidebar.expand': { 'zh-CN': '展开侧栏', 'en-US': 'Expand sidebar' },
  'shell.sidebar.collapse': { 'zh-CN': '收起侧栏', 'en-US': 'Collapse sidebar' },
  'shell.sidebar.settings': { 'zh-CN': '设置', 'en-US': 'Settings' },

  // 侧栏 / 工作区 / 会话菜单共用的动作词
  'shell.action.newTask': { 'zh-CN': '新建任务', 'en-US': 'New task' },
  'shell.action.rename': { 'zh-CN': '重命名', 'en-US': 'Rename' },
  'shell.action.archive': { 'zh-CN': '归档', 'en-US': 'Archive' },
  'shell.action.more': { 'zh-CN': '更多操作', 'en-US': 'More actions' },
  'shell.action.moreFor': { 'zh-CN': '{name} 更多操作', 'en-US': 'More actions for {name}' },

  // 顶栏：运行状态 / 恢复 / 计划模式徽标
  'shell.runStatus.running': { 'zh-CN': '运行中', 'en-US': 'Running' },
  'shell.runStatus.stopping': { 'zh-CN': '停止中…', 'en-US': 'Stopping…' },
  'shell.runStatus.interrupted': { 'zh-CN': '已中断', 'en-US': 'Interrupted' },
  'shell.runStatus.title': { 'zh-CN': '当前运行状态', 'en-US': 'Current run status' },
  'shell.resume.resuming': { 'zh-CN': '正在恢复…', 'en-US': 'Resuming…' },
  'shell.resume.action': { 'zh-CN': '继续运行', 'en-US': 'Resume run' },
  'shell.planMode.title': {
    'zh-CN': '计划模式：只读 + 仅产出方案（/plan 退出）',
    'en-US': 'Plan mode: read-only, plan only (exit with /plan)',
  },

  // 顶栏：会话统计 strip
  'shell.stats.title': {
    'zh-CN': '会话统计（回合/步/调用/用量/耗时）',
    'en-US': 'Session stats (turns / steps / calls / usage / time)',
  },
  'shell.stats.turns': { 'zh-CN': '{count} 回合', 'en-US': '{count} turns' },
  'shell.stats.steps': { 'zh-CN': '{count} 步', 'en-US': '{count} steps' },
  'shell.stats.toolCalls': { 'zh-CN': '{count} 工具', 'en-US': '{count} tools' },
  'shell.stats.ttft': { 'zh-CN': '首token {duration}', 'en-US': 'First token {duration}' },
  'shell.stats.active': { 'zh-CN': '活跃 {duration}', 'en-US': 'Active {duration}' },

  // 会话项
  'shell.session.untitled': { 'zh-CN': '未命名任务', 'en-US': 'Untitled task' },

  // 工作区（分组、菜单、重命名/删除弹窗）
  'shell.workspace.label': { 'zh-CN': '工作区', 'en-US': 'Workspaces' },
  'shell.workspace.tree': { 'zh-CN': '工作区任务', 'en-US': 'Workspace tasks' },
  // 无工作区会话的兜底分组名（内部哨兵由 NO_WORKSPACE_GROUP 承担，这里只是展示文案）
  'shell.workspace.none': { 'zh-CN': '未选择工作区', 'en-US': 'No workspace' },
  'shell.workspace.empty': { 'zh-CN': '暂无历史任务', 'en-US': 'No history yet' },
  'shell.workspace.open': { 'zh-CN': '打开文件夹', 'en-US': 'Open folder' },
  'shell.workspace.change': { 'zh-CN': '更换文件夹', 'en-US': 'Change folder' },
  'shell.workspace.newTaskIn': { 'zh-CN': '在 {name} 中新建任务', 'en-US': 'New task in {name}' },
  'shell.workspace.rename': { 'zh-CN': '重命名工作区', 'en-US': 'Rename workspace' },
  'shell.workspace.delete': { 'zh-CN': '删除工作区', 'en-US': 'Delete workspace' },
  'shell.workspace.deleteConfirm': {
    'zh-CN': '将删除“{name}”下的所有会话与运行记录，此操作不可恢复。',
    'en-US': 'This deletes every session and run under “{name}”. This cannot be undone.',
  },

  // 目录选择弹窗
  'shell.picker.title': { 'zh-CN': '选择文件夹', 'en-US': 'Choose folder' },
  'shell.picker.pathPlaceholder': {
    'zh-CN': '输入或粘贴绝对路径后回车，直达该目录',
    'en-US': 'Type or paste an absolute path and press Enter to jump there',
  },
  'shell.picker.pathLabel': { 'zh-CN': '编辑路径', 'en-US': 'Edit path' },
  'shell.picker.go': { 'zh-CN': '前往', 'en-US': 'Go' },
  'shell.picker.empty': { 'zh-CN': '此文件夹为空', 'en-US': 'This folder is empty' },
  'shell.picker.enterDrive': { 'zh-CN': '进入此盘符', 'en-US': 'Open this drive' },
  'shell.picker.doubleClickSelect': {
    'zh-CN': '双击选择此文件夹',
    'en-US': 'Double-click to select this folder',
  },
  'shell.picker.doubleClickHint': { 'zh-CN': '双击选择', 'en-US': 'Double-click to select' },
  'shell.picker.newFolderPlaceholder': {
    'zh-CN': '新建文件夹名称',
    'en-US': 'New folder name',
  },
  'shell.picker.create': { 'zh-CN': '新建', 'en-US': 'Create' },
  'shell.picker.creating': { 'zh-CN': '创建中…', 'en-US': 'Creating…' },
  'shell.picker.selectCurrent': { 'zh-CN': '选择当前文件夹', 'en-US': 'Select this folder' },
  'shell.picker.loadListFailed': {
    'zh-CN': '无法加载目录列表',
    'en-US': 'Failed to load the directory list',
  },
  'shell.picker.loadFailed': { 'zh-CN': '无法加载目录', 'en-US': 'Failed to load the directory' },
  'shell.picker.createFailed': {
    'zh-CN': '创建文件夹失败',
    'en-US': 'Failed to create the folder',
  },

  // 回合导航条
  'shell.turnNav.label': { 'zh-CN': '回合导航', 'en-US': 'Turn navigation' },
  'shell.turnNav.mark': { 'zh-CN': '回合 {index}：{task}', 'en-US': 'Turn {index}: {task}' },

  // 文件预览弹窗
  'shell.file.preview': { 'zh-CN': '文件预览', 'en-US': 'File preview' },
  'shell.file.loadFailed': {
    'zh-CN': '加载文件内容失败。',
    'en-US': 'Failed to load the file content.',
  },

  // 图片预处理（image-prepare 的异常文案：入参 language 决定语言）
  'shell.image.canvasUnavailable': {
    'zh-CN': 'canvas 2d 上下文不可用',
    'en-US': 'canvas 2d context unavailable',
  },
  'shell.image.encodeFailed': { 'zh-CN': '图片编码失败', 'en-US': 'Image encoding failed' },
} as const;
