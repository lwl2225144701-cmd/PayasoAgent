// timeline 领域消息表：对话时间线（Timeline 主体与执行面板）、计划面板（PlanPanel）、
// 思考块（ThinkBlock）、工具行（ToolActionRow）、计划变更说明（plan-state）与
// 工具链重试消息（preparation-retry）。key 前缀 `timeline.`。
// 通用短词（计划项状态词、时长单位、确定取消）复用 common.*，这里不重复定义。

export const timelineMessages = {
  // 时间线空态
  'timeline.empty': {
    'zh-CN': '选择或创建一个任务开始。',
    'en-US': 'Select or create a task to get started.',
  },

  // 执行面板：按钮上的状态标题
  'timeline.execution.statusRunning': { 'zh-CN': '正在执行', 'en-US': 'Running' },
  'timeline.execution.statusFailed': { 'zh-CN': '执行失败', 'en-US': 'Execution failed' },
  'timeline.execution.statusStopping': { 'zh-CN': '正在停止', 'en-US': 'Stopping' },
  'timeline.execution.statusStopped': { 'zh-CN': '已停止', 'en-US': 'Stopped' },
  'timeline.execution.statusInterrupted': { 'zh-CN': '已中断', 'en-US': 'Interrupted' },
  'timeline.execution.statusDone': { 'zh-CN': '本轮结束', 'en-US': 'Run finished' },

  // 执行面板：摘要行（操作数 / 用时 / 失败数）
  'timeline.execution.toolCount': {
    'zh-CN': '已执行 {count} 个操作',
    'en-US': 'Ran {count} operations',
  },
  'timeline.execution.duration': { 'zh-CN': '用时 {duration}', 'en-US': 'elapsed {duration}' },
  'timeline.execution.failedCount': { 'zh-CN': '{count} 个失败', 'en-US': '{count} failed' },
  'timeline.tools.ariaLabel': { 'zh-CN': '工具', 'en-US': 'Tools' },

  // 执行面板：等待模型（阶段文案 / 首包秒数 / 大上下文提示 / 不足 1 秒的耗时）
  'timeline.wait.thinking': { 'zh-CN': '正在思考', 'en-US': 'Thinking' },
  'timeline.wait.analyzing': { 'zh-CN': '正在分析', 'en-US': 'Analyzing' },
  'timeline.wait.complexTask': {
    'zh-CN': '正在处理复杂任务',
    'en-US': 'Working on a complex task',
  },
  'timeline.wait.firstPacket': {
    'zh-CN': '等待模型首包 · 第 {iteration} 轮 · 已等待 {seconds}s',
    'en-US': 'Waiting for first packet · round {iteration} · {seconds}s elapsed',
  },
  'timeline.wait.attemptSuffix': {
    'zh-CN': '（第 {attempt} 次请求）',
    'en-US': ' (request #{attempt})',
  },
  'timeline.wait.preparing': {
    'zh-CN': '正在准备请求 · 第 {iteration} 轮 · {seconds}s',
    'en-US': 'Preparing request · round {iteration} · {seconds}s',
  },
  'timeline.wait.largeContextHint': {
    'zh-CN': '本轮上下文约 {k}K tokens，prefill 较慢；可用 /compact 压缩会话历史',
    'en-US':
      'About {k}K tokens of context this turn, so prefill is slow; use /compact to shrink the session history',
  },
  'timeline.duration.underOneSecond': { 'zh-CN': '<1秒', 'en-US': '<1s' },

  // 内务说明：上下文压缩（弱化说明行，不成卡片）
  'timeline.compaction.note': {
    'zh-CN': '上下文已压缩 · {count} 条早期对话已摘要保留要点',
    'en-US': 'Context compacted · {count} earlier messages summarized',
  },

  // 批准卡片：网络访问
  'timeline.approval.networkTitle': {
    'zh-CN': '网络访问批准请求',
    'en-US': 'Network access approval request',
  },
  'timeline.approval.networkBody': { 'zh-CN': '请求网络访问', 'en-US': 'requests network access' },
  'timeline.approval.allow': { 'zh-CN': '允许', 'en-US': 'Allow' },
  'timeline.approval.deny': { 'zh-CN': '拒绝', 'en-US': 'Deny' },
  'timeline.approval.submitting': { 'zh-CN': '提交中…', 'en-US': 'Submitting…' },

  // 批准卡片：受控运行时依赖准备
  'timeline.preparation.title': {
    'zh-CN': '需要准备运行时依赖',
    'en-US': 'Runtime dependencies need preparation',
  },
  'timeline.preparation.missingPrefix': {
    'zh-CN': '当前受控运行时缺少',
    'en-US': 'The controlled runtime is missing',
  },
  'timeline.preparation.missingSuffix': { 'zh-CN': '。', 'en-US': '.' },
  'timeline.preparation.detail': {
    'zh-CN': '允许后将使用受控的 {source} 计划安装 {packageName}，不会执行模型提供的安装命令。',
    'en-US':
      'Once allowed, {packageName} is installed from the controlled {source} plan; install commands provided by the model are never executed.',
  },
  'timeline.preparation.approve': { 'zh-CN': '允许准备', 'en-US': 'Approve preparation' },
  'timeline.preparation.cancel': { 'zh-CN': '取消准备', 'en-US': 'Cancel preparation' },
  'timeline.preparation.cancelling': { 'zh-CN': '取消中…', 'en-US': 'Cancelling…' },
  'timeline.preparation.checking': {
    'zh-CN': '正在检查受控运行时…',
    'en-US': 'Checking the controlled runtime…',
  },
  'timeline.preparation.installing': {
    'zh-CN': '正在安装依赖…',
    'en-US': 'Installing dependencies…',
  },
  'timeline.preparation.verifying': {
    'zh-CN': '正在验证工具链…',
    'en-US': 'Verifying the toolchain…',
  },

  // 批准卡片：依赖准备完成 → 用户显式重试
  'timeline.prepared.title': { 'zh-CN': '依赖准备完成', 'en-US': 'Dependencies ready' },
  'timeline.prepared.body': {
    'zh-CN':
      '受控依赖已安装并通过验证，当前会话的工具链视图已刷新。原命令不会自动重试（副作用安全）；确认后可重新执行。',
    'en-US':
      'The controlled dependencies are installed and verified, and the toolchain view of this session has been refreshed. The original command is not retried automatically (side-effect safety); re-run it after confirming.',
  },
  'timeline.prepared.noFailedCommand': {
    'zh-CN': '未在本次执行中找到失败的 shell 命令。',
    'en-US': 'No failed shell command was found in this execution.',
  },
  'timeline.prepared.retry': {
    'zh-CN': '重新执行刚才的命令',
    'en-US': 'Re-run the previous command',
  },
  'timeline.prepared.retryBlockedRunning': {
    'zh-CN': '等待当前执行退出后可重试',
    'en-US': 'Wait for the current execution to end before retrying',
  },
  'timeline.prepared.retryBlockedNoCommand': {
    'zh-CN': '未找到失败的 shell 命令',
    'en-US': 'No failed shell command found',
  },

  // 产物文件
  'timeline.files.changedCount': {
    'zh-CN': '已修改 {count} 个文件',
    'en-US': '{count} files changed',
  },
  'timeline.files.andMore': { 'zh-CN': '{name} 等', 'en-US': '{name} and others' },
  'timeline.files.view': { 'zh-CN': '查看', 'en-US': 'View' },
  'timeline.files.open': { 'zh-CN': '打开', 'en-US': 'Open' },
  'timeline.files.opened': { 'zh-CN': '已打开', 'en-US': 'Opened' },
  'timeline.files.openError': {
    'zh-CN': '无法使用默认浏览器打开该文件。',
    'en-US': 'Could not open this file in the default browser.',
  },

  // 思考块
  'timeline.think.ariaLabel': { 'zh-CN': '模型思考', 'en-US': 'Model thinking' },
  'timeline.think.label': { 'zh-CN': '思考过程', 'en-US': 'Thinking process' },

  // 工具行
  'timeline.tool.ariaLabel': {
    'zh-CN': '{tool}：{args}，{status}',
    'en-US': '{tool}: {args}, {status}',
  },
  'timeline.tool.args': { 'zh-CN': '参数', 'en-US': 'Arguments' },
  'timeline.tool.result': { 'zh-CN': '结果', 'en-US': 'Result' },
  // v2.4 前台 shell 运行中的实时输出预览
  'timeline.tool.liveOutput': { 'zh-CN': '实时输出', 'en-US': 'Live output' },
  'timeline.tool.error': { 'zh-CN': '错误', 'en-US': 'Error' },
  'timeline.tool.truncated': {
    'zh-CN': '…（已截断，完整内容请查看日志）',
    'en-US': '… (truncated; see the logs for the full content)',
  },

  // 计划面板（折叠摘要）
  'timeline.plan.title': { 'zh-CN': '计划', 'en-US': 'Plan' },
  'timeline.plan.ariaLabel': { 'zh-CN': '任务计划', 'en-US': 'Task plan' },
  'timeline.plan.summaryAllDone': {
    'zh-CN': '全部完成（{count} 项）',
    'en-US': 'All done ({count} items)',
  },
  'timeline.plan.summaryIncomplete': {
    'zh-CN': '结束时仍有 {count} 项未完成',
    'en-US': '{count} items still unfinished at the end',
  },
  'timeline.plan.summaryActive': { 'zh-CN': '进行中：{title}', 'en-US': 'In progress: {title}' },
  'timeline.plan.summaryPending': { 'zh-CN': '待办 {count} 项', 'en-US': '{count} pending' },

  // 计划变更说明（挂在发生变更的那个 step 上）
  'timeline.planNote.created': {
    'zh-CN': '计划已建立 · {count} 项',
    'en-US': 'Plan created · {count} items',
  },
  'timeline.planNote.cleared': { 'zh-CN': '计划已清空', 'en-US': 'Plan cleared' },
  'timeline.planNote.updated': {
    'zh-CN': '计划已更新 · {completed}/{total} 完成',
    'en-US': 'Plan updated · {completed}/{total} done',
  },
  'timeline.planNote.completed': { 'zh-CN': '✅ 完成：{titles}', 'en-US': '✅ Done: {titles}' },
  'timeline.planNote.started': { 'zh-CN': '▶ 开始：{title}', 'en-US': '▶ Started: {title}' },
  'timeline.planNote.titleJoiner': { 'zh-CN': '、', 'en-US': ', ' },
  'timeline.planNote.summary': {
    'zh-CN': '{parts}（{completed}/{total}）',
    'en-US': '{parts} ({completed}/{total})',
  },

  // 工具链重试消息（作为新会话轮次的用户消息发给模型）
  'timeline.retry.intro': {
    'zh-CN': '依赖已安装完成，请重新执行之前失败的命令：',
    'en-US': 'Dependencies are installed; please re-run the command that failed earlier:',
  },
  'timeline.retry.note': {
    'zh-CN': '（这是我在依赖准备完成后明确发起的重试；如果该命令仍不可用，请告诉我原因。）',
    'en-US':
      '(This is an explicit retry I initiated after dependency preparation finished; if the command is still unavailable, tell me why.)',
  },
  'delivery.files': { 'zh-CN': '交付文件', 'en-US': 'Deliverables' },
  'delivery.recorded': { 'zh-CN': '已记录写入', 'en-US': 'Recorded write' },
  'delivery.reported': { 'zh-CN': 'Agent 报告的文件', 'en-US': 'Agent-reported file' },
  'delivery.available': { 'zh-CN': '可用', 'en-US': 'Available' },
  'delivery.changed': { 'zh-CN': '结束后有修改', 'en-US': 'Modified after this run' },
  'delivery.unavailable': { 'zh-CN': '不可用', 'en-US': 'Unavailable' },
  'delivery.currentFiles': {
    'zh-CN': '打开和下载的是工作区当前文件，不是历史快照。',
    'en-US': 'Open and download access current workspace files, not historical snapshots.',
  },
  'delivery.refresh': { 'zh-CN': '刷新交付信息', 'en-US': 'Refresh delivery' },
  'delivery.loadFailed': {
    'zh-CN': '交付信息加载失败，请重试。',
    'en-US': 'Could not load delivery information. Please retry.',
  },
  'delivery.evidence': { 'zh-CN': '完成依据', 'en-US': 'Completion evidence' },
  'delivery.noChecks': {
    'zh-CN': '未识别到检查命令，请结合执行记录判断。',
    'en-US': 'No check commands identified; consult the execution records.',
  },
  'delivery.checkNote': {
    'zh-CN': '以下为疑似检查命令及实际退出状态；退出成功不等于任务已验证完成。',
    'en-US':
      'Candidate check commands and observed exit status; a successful exit does not prove task completion.',
  },
  'delivery.passed': { 'zh-CN': '退出成功', 'en-US': 'Exited successfully' },
  'delivery.failed': { 'zh-CN': '执行失败', 'en-US': 'Failed' },
  'delivery.unknown': { 'zh-CN': '尚无确定结果', 'en-US': 'No confirmed result' },
  'delivery.unfinished': { 'zh-CN': '计划中未完成事项', 'en-US': 'Unfinished plan items' },
  'delivery.noUnfinished': {
    'zh-CN': '无未完成计划记录；其他缺口以最终回复为准。',
    'en-US': 'No unfinished plan items recorded; see the final response for other gaps.',
  },
  'delivery.interrupted': {
    'zh-CN': '本轮未正常完成，请结合错误或停止原因检查剩余工作。',
    'en-US': 'This run did not complete normally; review its error or stop reason.',
  },
  'delivery.diagnostics': { 'zh-CN': '执行诊断', 'en-US': 'Execution diagnostics' },
  'delivery.stats': {
    'zh-CN': '工具 {calls} 次 · 工具耗时 {seconds}s · 已记录 token {tokens}',
    'en-US': '{calls} tool calls · {seconds}s tool time · {tokens} recorded tokens',
  },
  'delivery.diagnosticNote': {
    'zh-CN': '提示仅供排查，不拦截执行。步骤编号对应本轮执行记录；读取修改后的文件可能是正常复查。',
    'en-US':
      'Hints do not block execution. Step numbers refer to this run; rereading changed files may be appropriate.',
  },
  'delivery.repeatRead': { 'zh-CN': '疑似重复读取', 'en-US': 'Possible repeated read' },
  'delivery.repeatFailure': {
    'zh-CN': '相同参数再次失败',
    'en-US': 'Repeated failure with identical arguments',
  },
  'delivery.slow': { 'zh-CN': '调用耗时较长', 'en-US': 'Slow call' },
  'delivery.step': { 'zh-CN': '步骤 {step}', 'en-US': 'Step {step}' },
  'delivery.actionFailed': {
    'zh-CN': '文件操作失败，已刷新文件状态。',
    'en-US': 'File action failed; file status refreshed.',
  },
  'delivery.binary': {
    'zh-CN': '此文件请下载后用对应应用打开。',
    'en-US': 'Download this file and open it in its application.',
  },
  'delivery.previewTemplate': { 'zh-CN': '预览展开后的任务', 'en-US': 'Preview expanded task' },
  'delivery.previewFailed': {
    'zh-CN': '模板不可用或预览失败。',
    'en-US': 'Template unavailable or preview failed.',
  },
  'delivery.applyTemplate': {
    'zh-CN': '使用此内容并继续编辑',
    'en-US': 'Use this content and edit',
  },
  'delivery.record': { 'zh-CN': '查看对应调用记录', 'en-US': 'View corresponding call' },
} as const;
