// widgets 领域消息表：key 前缀 `widgets.`。
//
// 覆盖通用控件（复制按钮 / 弹窗 / 可折叠文本 / Mermaid 图）与用量类纯函数
// （formatTokenBreakdown / contextGaugeTitle / compactStatusText / RunUsage / 上下文环）。
// 跨领域短词（相对时间、时长、Run 与工具状态词）沿用 common.*，这里不重复定义。

export const widgetsMessages = {
  // ---- 用量分项（formatTokenBreakdown）----
  'widgets.usage.input': { 'zh-CN': '输入 {value}', 'en-US': 'Input {value}' },
  'widgets.usage.output': { 'zh-CN': '输出 {value}', 'en-US': 'Output {value}' },
  'widgets.usage.cacheRead': { 'zh-CN': '缓存读 {value}', 'en-US': 'Cache read {value}' },
  'widgets.usage.cacheWrite': { 'zh-CN': '缓存写 {value}', 'en-US': 'Cache write {value}' },
  'widgets.usage.reasoning': { 'zh-CN': '推理 {value}', 'en-US': 'Reasoning {value}' },

  // ---- 上下文预算悬停明细（contextGaugeTitle / formatBudgetDerivation）----
  'widgets.contextGauge.title.context': {
    'zh-CN': '上下文 {used} / {budget} tokens（{percent}%）',
    'en-US': 'Context {used} / {budget} tokens ({percent}%)',
  },
  'widgets.contextGauge.title.model': { 'zh-CN': '模型 {model}', 'en-US': 'Model {model}' },
  'widgets.contextGauge.title.pressure': {
    'zh-CN': '上次上报真实 {value}',
    'en-US': 'Last reported actual {value}',
  },
  'widgets.contextGauge.title.emergencyTrim': {
    'zh-CN': '已触发紧急裁剪',
    'en-US': 'Emergency trim triggered',
  },
  'widgets.contextGauge.title.fallbackBudget': {
    'zh-CN': '模型能力未知，按保守预算估计',
    'en-US': 'Model limits unknown; estimating with a conservative budget',
  },
  'widgets.contextGauge.budgetDerivation': {
    'zh-CN': '窗口 {window} = 预算 {budget} + 输出预留 {output} + 安全 {safety}',
    'en-US': 'Window {window} = budget {budget} + output reserve {output} + safety {safety}',
  },

  // ---- /compact 状态行（compactStatusText）----
  'widgets.compact.running': { 'zh-CN': '正在压缩…', 'en-US': 'Compacting…' },
  'widgets.compact.done': {
    'zh-CN': '已压缩 {count} 条历史记录（约 {tokens} tokens）',
    'en-US': 'Compacted {count} history records (~{tokens} tokens)',
  },
  'widgets.compact.noCheckpoint': {
    'zh-CN': '该会话没有可用的运行记录（checkpoint），无法压缩',
    'en-US': 'This session has no usable run checkpoint, so it cannot be compacted',
  },
  'widgets.compact.nothingCompactable': {
    'zh-CN': '没有可压缩的历史记录',
    'en-US': 'No history to compact',
  },

  // ---- 轮末用量行（RunUsage）----
  'widgets.runUsage.label': { 'zh-CN': '用量', 'en-US': 'Usage' },
  'widgets.runUsage.partial': { 'zh-CN': '（部分）', 'en-US': ' (partial)' },
  'widgets.runUsage.unrecorded': { 'zh-CN': '未记录', 'en-US': 'Not recorded' },
  'widgets.runUsage.tooltipExact': {
    'zh-CN': '本轮各模型请求的精确用量：{breakdown}（模型上报，非上下文估算）',
    'en-US':
      "Exact usage of this run's model requests: {breakdown} (reported by the provider, not a context estimate)",
  },
  'widgets.runUsage.tooltipCumulative': {
    'zh-CN': '本轮已返回用量的模型请求累计输入与输出 Token；不是上下文占用',
    'en-US':
      "Input and output tokens accumulated from this run's requests that reported usage; not context occupancy",
  },
  'widgets.runUsage.ttftTitle': {
    'zh-CN': '首 token 延迟（run 开始 → 首个内容到达）',
    'en-US': 'Time to first token (run start → first content arrives)',
  },
  'widgets.runUsage.ttft': { 'zh-CN': '首 token {value}', 'en-US': 'First token {value}' },
  'widgets.runUsage.decodeTitle': {
    'zh-CN': '解码速度 = 真实输出 token ÷ 首末增量耗时（{ms}ms）',
    'en-US': 'Decode speed = real output tokens ÷ first-to-last delta time ({ms}ms)',
  },
  'widgets.runUsage.duration': { 'zh-CN': '用时 {value}', 'en-US': 'Duration {value}' },
  'widgets.runUsage.unknown': { 'zh-CN': '未知', 'en-US': 'Unknown' },

  // ---- 上下文占用环（ContextUsageRing）----
  'widgets.contextRing.messagesWithSystem': {
    'zh-CN': '消息（含系统提示词）',
    'en-US': 'Messages (incl. system prompt)',
  },
  'widgets.contextRing.systemPrompt': { 'zh-CN': '系统提示词', 'en-US': 'System prompt' },
  'widgets.contextRing.tools': { 'zh-CN': '工具', 'en-US': 'Tools' },
  'widgets.contextRing.messages': { 'zh-CN': '对话消息', 'en-US': 'Conversation messages' },
  'widgets.contextRing.used': { 'zh-CN': '上下文已用', 'en-US': 'Context used' },
  'widgets.contextRing.anchoredDetail': {
    'zh-CN': '真实上报 {pressure} · 本次请求预估 {estimate}',
    'en-US': 'Reported actual {pressure} · estimated for this request {estimate}',
  },
  'widgets.contextRing.fallbackNotice': {
    'zh-CN': '模型能力未知，当前使用保守预算',
    'en-US': 'Model limits unknown; using a conservative budget',
  },
  'widgets.contextRing.emergencyTrim': {
    'zh-CN': '已进入紧急上下文压缩区间',
    'en-US': 'In the emergency context compaction range',
  },

  // ---- 通用控件 ----
  'widgets.collapsibleText.showMore': { 'zh-CN': '显示更多', 'en-US': 'Show more' },
  'widgets.modal.closeDialog': { 'zh-CN': '关闭对话框', 'en-US': 'Close dialog' },

  // ---- Mermaid 图（加载 / 渲染 / 失败回退）----
  'widgets.mermaid.rendering': { 'zh-CN': '图表渲染中…', 'en-US': 'Rendering diagram…' },
  'widgets.mermaid.timeout': {
    'zh-CN': '渲染超时——页面版本可能已过期，请刷新页面后重试',
    'en-US': 'Render timed out — this page may be stale; refresh the page and try again',
  },
  'widgets.mermaid.loadFailed': {
    'zh-CN': '图表组件加载失败——页面版本已过期，请刷新页面后重试',
    'en-US':
      'Failed to load the diagram component — this page is stale; refresh the page and try again',
  },
  'widgets.mermaid.syntaxError': {
    'zh-CN': 'mermaid 语法有误：{message}',
    'en-US': 'Invalid mermaid syntax: {message}',
  },
} as const;
