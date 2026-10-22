// trace 领域消息表：执行轨迹页（对话/轨迹切换、Run 分组、模型与工具调用列表）。
// key 前缀 `trace.`。状态词、时长单位复用 common.* / timeline.execution.*，不重复定义。

export const traceMessages = {
  // 内容区标签页（App 会话内容区：对话 / 轨迹）
  'trace.tabsLabel': { 'zh-CN': '内容视图', 'en-US': 'Content view' },
  'trace.tab.chat': { 'zh-CN': '对话', 'en-US': 'Chat' },
  'trace.tab.trace': { 'zh-CN': '轨迹', 'en-US': 'Trace' },

  // 空态
  'trace.empty': { 'zh-CN': '本会话还没有执行记录。', 'en-US': 'No runs in this session yet.' },

  // 工具栏：视图切换 + 搜索
  'trace.view.switchLabel': { 'zh-CN': '轨迹视图', 'en-US': 'Trace view' },
  'trace.view.duration': { 'zh-CN': '时长', 'en-US': 'Duration' },
  'trace.view.turns': { 'zh-CN': '轮次', 'en-US': 'Rounds' },
  'trace.view.calls': { 'zh-CN': '调用', 'en-US': 'Calls' },
  'trace.search.placeholder': { 'zh-CN': '搜索', 'en-US': 'Search' },
  'trace.search.noMatches': {
    'zh-CN': '没有匹配「{query}」的执行记录。',
    'en-US': 'No activity matches "{query}".',
  },

  // 三泳道时间轴
  'trace.timeline.ariaLabel': { 'zh-CN': '执行时间轴', 'en-US': 'Execution timeline' },
  'trace.timeline.laneInput': { 'zh-CN': '输入', 'en-US': 'Input' },
  'trace.timeline.laneModel': { 'zh-CN': '模型', 'en-US': 'Model' },
  'trace.timeline.laneTool': { 'zh-CN': '工具', 'en-US': 'Tools' },
  'trace.timeline.noTiming': {
    'zh-CN': '暂无带时间记录的调用。',
    'en-US': 'No calls with recorded timing yet.',
  },
  'trace.timeline.loading': {
    'zh-CN': '正在加载执行记录……',
    'en-US': 'Loading activity…',
  },

  // Run 分组头
  'trace.run.turn': { 'zh-CN': '第 {turn} 轮', 'en-US': 'Turn {turn}' },
  'trace.run.status.running': { 'zh-CN': '运行中', 'en-US': 'Running' },
  'trace.run.status.stopping': { 'zh-CN': '正在停止', 'en-US': 'Stopping' },
  'trace.run.status.completed': { 'zh-CN': '已完成', 'en-US': 'Completed' },
  'trace.run.status.failed': { 'zh-CN': '失败', 'en-US': 'Failed' },
  'trace.run.status.stopped': { 'zh-CN': '已停止', 'en-US': 'Stopped' },
  'trace.run.status.interrupted': { 'zh-CN': '已中断', 'en-US': 'Interrupted' },
  'trace.calls.summary': {
    'zh-CN': '{model} 次模型调用 · {tool} 次工具调用',
    'en-US': '{model} model calls · {tool} tool calls',
  },

  // 调用行（模型 / 工具共用）
  'trace.call.ariaLabel': { 'zh-CN': '{name}，{status}', 'en-US': '{name}, {status}' },
  'trace.call.status.interrupted': { 'zh-CN': '已中断', 'en-US': 'Interrupted' },
  'trace.duration.unrecorded': { 'zh-CN': '未记录', 'en-US': 'Not recorded' },
  'trace.call.noResult': { 'zh-CN': '（无结果记录）', 'en-US': '(no result recorded)' },

  // 轮次视图
  'trace.turn.user': { 'zh-CN': '用户', 'en-US': 'User' },
  'trace.turn.steps': {
    'zh-CN': '… {steps} 个步骤 · {tools} 个工具调用',
    'en-US': '… {steps} steps · {tools} tool calls',
  },

  // 模型调用
  'trace.model.name': { 'zh-CN': '模型调用', 'en-US': 'Model call' },
  'trace.model.nameWithRound': {
    'zh-CN': '模型调用 · 第 {iteration} 轮',
    'en-US': 'Model call · round {iteration}',
  },
  'trace.model.purpose.final_review': { 'zh-CN': '终稿审查', 'en-US': 'Final review' },
  'trace.model.purpose.final_draft': { 'zh-CN': '终稿撰写', 'en-US': 'Final draft' },
  'trace.model.output': { 'zh-CN': '输出', 'en-US': 'Output' },
  'trace.model.reasoning': { 'zh-CN': '思考', 'en-US': 'Reasoning' },
  'trace.model.usage': { 'zh-CN': 'Token 用量', 'en-US': 'Token usage' },
  'trace.model.usageValues': {
    'zh-CN': '输入 {input} · 输出 {output}',
    'en-US': 'in {input} · out {output}',
  },
  'trace.model.cacheRead': { 'zh-CN': '缓存读 {count}', 'en-US': 'cache read {count}' },
  'trace.model.cacheWrite': { 'zh-CN': '缓存写 {count}', 'en-US': 'cache write {count}' },
  'trace.model.messages': {
    'zh-CN': '上下文 {count} 条消息',
    'en-US': '{count} messages in context',
  },
  'trace.model.waiting': {
    'zh-CN': '正在等待模型响应……',
    'en-US': 'Waiting for model response…',
  },
  'trace.model.transportFailed': {
    'zh-CN': '请求传输失败：{reason}',
    'en-US': 'Request transport failed: {reason}',
  },
} as const;
