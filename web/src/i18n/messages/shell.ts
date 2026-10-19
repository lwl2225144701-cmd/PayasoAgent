// shell 领域消息表：顶栏（ShellBar）、侧栏（Sidebar）、会话项（SessionItem）、
// 工作区分组（WorkspaceSection）、目录选择（WorkspacePickerModal）、
// 回合导航（TurnNavigator）。key 前缀 `shell.`。
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

  // 底部统计条（StatsBar）：两枚 pill + 上下文环，读数口径见 session-stats-view.ts
  'shell.stats.title': {
    'zh-CN': '会话统计（回合/步/吞吐/用量/缓存）',
    'en-US': 'Session stats (turns / steps / throughput / usage / cache)',
  },
  'shell.stats.turns': { 'zh-CN': '{count} 回合', 'en-US': '{count} turns' },
  'shell.stats.steps': { 'zh-CN': '{count} 步', 'en-US': '{count} steps' },
  'shell.stats.toolCalls': { 'zh-CN': '{count} 工具', 'en-US': '{count} tools' },
  'shell.stats.llmCalls': { 'zh-CN': '{count} LLM', 'en-US': '{count} LLM' },
  // 吞吐率：模型输出 token ÷ 解码耗时（首增量 → 末增量）
  'shell.stats.tokensPerSecond': { 'zh-CN': '{value} tok/s', 'en-US': '{value} tok/s' },
  // 缓存命中率：命中缓存的输入 ÷ 全部输入（新增 + 命中 + 写入）
  'shell.stats.cacheHit': { 'zh-CN': '缓存命中 {percent}%', 'en-US': '{percent}% cached' },
  'shell.stats.ttft': { 'zh-CN': '首token {duration}', 'en-US': 'First token {duration}' },
  'shell.stats.active': { 'zh-CN': '活跃 {duration}', 'en-US': 'Active {duration}' },

  // 展开面板（点击统计条的两枚 pill 弹出）—— 会话统计卡
  'shell.stats.modelTime': { 'zh-CN': '模型用时', 'en-US': 'Model time' },
  'shell.stats.toolTime': { 'zh-CN': '工具调用用时', 'en-US': 'Tool time' },
  'shell.stats.ttftAvg': { 'zh-CN': '首 token 平均（TTFT）', 'en-US': 'Avg first token (TTFT)' },
  'shell.stats.tps': { 'zh-CN': '输出速度（TPS）', 'en-US': 'Output speed (TPS)' },
  'shell.stats.activeLabel': { 'zh-CN': '活跃时长', 'en-US': 'Active time' },

  // 展开面板 —— Token 用量卡
  'shell.stats.cacheRead': { 'zh-CN': '缓存读取', 'en-US': 'Cache read' },
  'shell.stats.uncachedInput': { 'zh-CN': '未缓存输入', 'en-US': 'Uncached input' },
  'shell.stats.outputTokens': { 'zh-CN': '输出', 'en-US': 'Output' },
  'shell.stats.cacheHitLabel': { 'zh-CN': '缓存命中率', 'en-US': 'Cache hit rate' },
  'shell.stats.panelSession': { 'zh-CN': '会话统计', 'en-US': 'Session stats' },
  'shell.stats.panelTokens': { 'zh-CN': 'Token 用量', 'en-US': 'Token usage' },

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

  // 历史任务搜索（工作区行上的放大镜 → 点开展开输入框，点 × 收起并清空）：
  // 范围 = 任务标题 + 工作区名，不搜聊天正文。规则（含大小写 / 首尾空格 /
  // 特殊字符 / 分组保留）见 web/src/components/WorkspaceSection/task-search.ts。
  'shell.search.toggle': {
    'zh-CN': '搜索历史任务',
    'en-US': 'Search history',
  },
  'shell.search.placeholder': {
    'zh-CN': '搜索任务或工作区',
    'en-US': 'Search tasks or workspaces',
  },
  // 无匹配提示：带上用户实际输入的关键词（已去首尾空格），比单纯「没有结果」可诊断
  'shell.search.noResults': {
    'zh-CN': '没有匹配“{keyword}”的任务',
    'en-US': 'No tasks match “{keyword}”',
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

  // 图片预处理（image-prepare 的异常文案：入参 language 决定语言）
  'shell.image.canvasUnavailable': {
    'zh-CN': 'canvas 2d 上下文不可用',
    'en-US': 'canvas 2d context unavailable',
  },
  'shell.image.encodeFailed': { 'zh-CN': '图片编码失败', 'en-US': 'Image encoding failed' },

  // 侧边栏更新条目（自更新；只在桌面壳里有桥，浏览器里永远不显示）
  // 放在底部「设置」同一行右侧，已下载的更新保留操作入口。
  'shell.update.available': { 'zh-CN': '新版本', 'en-US': 'Update' },
  'shell.update.checking': { 'zh-CN': '检查中…', 'en-US': 'Checking…' },
  'shell.update.installing': { 'zh-CN': '准备安装…', 'en-US': 'Preparing…' },
  'shell.update.install': { 'zh-CN': '安装更新', 'en-US': 'Install update' },
  'shell.update.openPackage': { 'zh-CN': '打开更新包', 'en-US': 'Open update' },
  'shell.update.readyHint': {
    'zh-CN': 'v{version} 已下载，点击安装并重启，无需重新下载',
    'en-US': 'v{version} is downloaded. Click to install and restart.',
  },
  'shell.update.manualHint': {
    'zh-CN': 'v{version} 已下载，点击打开更新包并手动替换应用',
    'en-US': 'v{version} is downloaded. Open the package to replace the app manually.',
  },
  'shell.update.availableHint': {
    'zh-CN': '新版本 v{version}，点击下载',
    'en-US': 'Update v{version} available. Click to download.',
  },
  'shell.update.downloadingHint': {
    'zh-CN': '正在下载 v{version}，完成后会询问是否重启安装',
    'en-US': 'Downloading v{version}. You will be asked to restart and install.',
  },
} as const;
