// composer 领域消息表：输入区（InputBar / ComposerParts）与内置斜杠命令注册表。
// key 前缀 `composer.`。

export const composerMessages = {
  // 输入框占位符
  'composer.placeholder': {
    'zh-CN': '发消息或做任务... / Enter 发送，Shift+Enter 换行',
    'en-US': 'Send a message or start a task… / Enter to send, Shift+Enter for a new line',
  },
  // 用户只发图不写字时进入模型上下文的兜底任务文案
  'composer.imageOnlyTask': {
    'zh-CN': '请分析附带的图片。',
    'en-US': 'Please analyze the attached image.',
  },

  // 图片附件（粘贴截图）
  'composer.attachment.clipboardName': {
    'zh-CN': '剪贴板图片',
    'en-US': 'Clipboard image',
  },
  'composer.attachment.tooMany': {
    'zh-CN': '最多附带 {count} 张图片',
    'en-US': 'At most {count} images can be attached',
  },
  'composer.attachment.unsupportedType': {
    'zh-CN': '{name}：仅支持 PNG / JPEG / WebP / GIF',
    'en-US': '{name}: only PNG / JPEG / WebP / GIF are supported',
  },
  'composer.attachment.tooLarge': {
    'zh-CN': '{name}：超过 8MB 上限',
    'en-US': '{name}: exceeds the 8MB limit',
  },
  'composer.attachment.remove': {
    'zh-CN': '移除图片',
    'en-US': 'Remove image',
  },
  // 已粘贴图片但当前模型不支持视觉：图片发出去模型也看不到
  'composer.visionWarning': {
    'zh-CN':
      '当前模型未开启视觉能力，模型看不到图片。请在「设置 → 模型」中为该模型打开「视觉」开关，或切换到支持图片的模型。',
    'en-US':
      'The current model has vision disabled, so it cannot see images. Turn on the "Vision" switch for this model in Settings → Models, or switch to a model that supports images.',
  },

  // Workspace 选择（hero 态）
  'composer.workspace.select': {
    'zh-CN': '选择 Workspace',
    'en-US': 'Select workspace',
  },
  'composer.workspace.change': {
    'zh-CN': '更换 Workspace',
    'en-US': 'Change workspace',
  },
  'composer.workspace.opening': {
    'zh-CN': '正在打开…',
    'en-US': 'Opening…',
  },

  // 斜杠命令补全
  'composer.command.builtinBadge': {
    'zh-CN': '内置',
    'en-US': 'Built-in',
  },

  // 发送队列面板
  'composer.queue.title': {
    'zh-CN': '发送队列',
    'en-US': 'Send queue',
  },
  'composer.queue.notice': {
    'zh-CN': '已加入发送队列 · {count} 条消息等待中',
    'en-US': 'Added to the send queue · {count} message(s) waiting',
  },
  'composer.queue.sendNow': {
    'zh-CN': '立即发送',
    'en-US': 'Send now',
  },
  'composer.queue.sendNowHint': {
    'zh-CN': '当前任务结束后优先发送',
    'en-US': 'Send first once the current task finishes',
  },
  'composer.queue.deleteHint': {
    'zh-CN': '从发送队列删除',
    'en-US': 'Remove from the send queue',
  },

  // 模型下拉
  'composer.model.select': {
    'zh-CN': '选择模型',
    'en-US': 'Select model',
  },
  'composer.model.currentTitle': {
    'zh-CN': '当前模型：{provider} · {model}',
    'en-US': 'Current model: {provider} · {model}',
  },
  'composer.model.currentAria': {
    'zh-CN': '{provider} {model} 模型',
    'en-US': '{provider} {model} model',
  },
  'composer.model.contextWindow': {
    'zh-CN': '{value}K 上下文',
    'en-US': '{value}K context',
  },
  'composer.model.maxOutput': {
    'zh-CN': '{value}K 输出',
    'en-US': '{value}K output',
  },
  'composer.model.emptyApiKey': {
    'zh-CN': '请先在设置中配置 API 密钥',
    'en-US': 'Configure an API key in Settings first',
  },

  // 发送 / 停止按钮
  'composer.submit.send': {
    'zh-CN': '发送（Enter）',
    'en-US': 'Send (Enter)',
  },
  'composer.submit.queue': {
    'zh-CN': '立即加入发送队列',
    'en-US': 'Add to the send queue now',
  },
  'composer.submit.queueWithCount': {
    'zh-CN': '立即加入发送队列（已有 {count} 条）',
    'en-US': 'Add to the send queue now ({count} already queued)',
  },
  'composer.submit.stop': {
    'zh-CN': '停止当前任务',
    'en-US': 'Stop the current task',
  },
  'composer.submit.stopping': {
    'zh-CN': '正在停止…',
    'en-US': 'Stopping…',
  },

  // 内置斜杠命令注册表（builtin-commands.ts 的 descriptionKey / usageKey）
  'composer.commands.compact.description': {
    'zh-CN': '压缩更早的对话历史（下一条消息发送时执行）',
    'en-US': 'Compact earlier conversation history (runs when the next message is sent)',
  },
  'composer.commands.compact.usage': {
    'zh-CN': '/compact',
    'en-US': '/compact',
  },
  'composer.commands.export.description': {
    'zh-CN': '下载本会话完整日志归档（ZIP）',
    'en-US': 'Download the full log archive for this session (ZIP)',
  },
  'composer.commands.export.usage': {
    'zh-CN': '/export',
    'en-US': '/export',
  },
  'composer.commands.feedback.description': {
    'zh-CN': '记录对本会话的反馈',
    'en-US': 'Record feedback about this session',
  },
  'composer.commands.feedback.usage': {
    'zh-CN': '/feedback <意见>',
    'en-US': '/feedback <comment>',
  },
  'composer.commands.goal.description': {
    'zh-CN': '设置或查看本会话的长期目标',
    'en-US': 'Set or view the long-term goal of this session',
  },
  'composer.commands.goal.usage': {
    'zh-CN': '/goal [目标内容]',
    'en-US': '/goal [goal text]',
  },
  'composer.commands.permission.description': {
    'zh-CN': '切换权限预设（沙箱模式）',
    'en-US': 'Switch the permission preset (sandbox mode)',
  },
  'composer.commands.permission.usage': {
    'zh-CN': '/permission [read-only|workspace-write|full-access]',
    'en-US': '/permission [read-only|workspace-write|full-access]',
  },
  'composer.commands.plan.description': {
    'zh-CN': '进入/退出计划模式（只读 + 仅产出方案）',
    'en-US': 'Enter/exit plan mode (read-only, plan only)',
  },
  'composer.commands.plan.usage': {
    'zh-CN': '/plan',
    'en-US': '/plan',
  },
  'composer.commands.model.description': {
    'zh-CN': '选择本会话使用的模型',
    'en-US': 'Choose the model this session uses',
  },
  'composer.commands.model.usage': {
    'zh-CN': '/model <provider/模型关键词>',
    'en-US': '/model <provider/model keyword>',
  },
} as const;
