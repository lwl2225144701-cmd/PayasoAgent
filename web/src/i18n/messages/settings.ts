// settings 领域消息表：设置弹窗（通用/外观/权限/模型提供方/模型同步/思考档次）。
// key 前缀 `settings.`。

export const settingsMessages = {
  'settings.title': { 'zh-CN': '设置', 'en-US': 'Settings' },
  'settings.tabs.general': { 'zh-CN': '通用设置', 'en-US': 'General' },
  'settings.tabs.models': { 'zh-CN': '模型', 'en-US': 'Models' },
  'settings.tabs.plugins': { 'zh-CN': '插件', 'en-US': 'Plugins' },
  'settings.tabs.agentPresets': { 'zh-CN': 'Agent 预设', 'en-US': 'Agent presets' },

  // 通用设置
  'settings.general.permission': { 'zh-CN': '权限', 'en-US': 'Permissions' },
  'settings.general.permissionDescription': {
    'zh-CN': '选择新会话的默认权限模式',
    'en-US': 'Default permission mode for new sessions',
  },
  'settings.general.permissionAria': {
    'zh-CN': '默认权限模式',
    'en-US': 'Default permission mode',
  },
  'settings.general.language': { 'zh-CN': '语言', 'en-US': 'Language' },
  'settings.general.languageAria': { 'zh-CN': '界面语言', 'en-US': 'Interface language' },
  'settings.general.fontSize': { 'zh-CN': '字号大小', 'en-US': 'Font size' },
  'settings.general.fontSizeDescription': {
    'zh-CN': '仅影响会话内容的字号',
    'en-US': 'Affects conversation content only',
  },
  'settings.general.fontSizeAria': { 'zh-CN': '会话字号', 'en-US': 'Conversation font size' },
  'settings.general.fontSizeTitle': {
    'zh-CN': '可使用鼠标滚轮或上下箭头调整字号',
    'en-US': 'Use the mouse wheel or the up/down arrows to adjust the font size',
  },
  'settings.general.fontSizeIncrease': { 'zh-CN': '增大字号', 'en-US': 'Increase font size' },
  'settings.general.fontSizeDecrease': { 'zh-CN': '减小字号', 'en-US': 'Decrease font size' },

  // Shell 隔离能力（诚实分级；partial 必须可见，不静默放宽）
  'settings.shellIsolation.title': { 'zh-CN': 'Shell 隔离', 'en-US': 'Shell isolation' },
  'settings.shellIsolation.loading': { 'zh-CN': '读取中…', 'en-US': 'Loading…' },
  'settings.shellIsolation.executor.macosSeatbelt': {
    'zh-CN': 'macOS 沙箱（Seatbelt）',
    'en-US': 'macOS sandbox (Seatbelt)',
  },
  'settings.shellIsolation.executor.windowsAcl': {
    'zh-CN': 'Windows ACL 受限令牌',
    'en-US': 'Windows ACL restricted token',
  },
  'settings.shellIsolation.executor.uncontainedGated': {
    'zh-CN': '无沙箱（默认拒绝）',
    'en-US': 'Unsandboxed (denied by default)',
  },
  'settings.shellIsolation.fullNote': {
    'zh-CN': '读写与网络边界由操作系统沙箱强制执行',
    'en-US': 'Read, write and network boundaries are enforced by the OS sandbox',
  },
  'settings.shellIsolation.partialCaveat': {
    'zh-CN':
      '部分写入隔离：写入限制在工作区与受管临时目录，但 Everyone 授权对象与 NTFS 硬链接存在例外；读取不受限制',
    'en-US':
      'Partial write isolation: writes are confined to the workspace and managed scratch, with known Everyone and NTFS hard-link exceptions; reads are unrestricted',
  },
  'settings.shellIsolation.noneNote': {
    'zh-CN': '当前平台无操作系统级沙箱：shell 默认拒绝，需显式设置环境变量才可放行',
    'en-US':
      'No OS-level sandbox on this platform: shell is denied by default and requires an explicit opt-in',
  },
  'settings.shellIsolation.standingAceNote': {
    'zh-CN':
      '注意：Workspace Write 模式会在工作区目录留下持续性授权 ACE（合成 SID，无账户映射，跨会话复用；清理方式见跨平台沙箱文档）',
    'en-US':
      'Note: Workspace Write leaves a standing grant ACE on the workspace directory (a synthetic SID with no account mapping, reused across sessions; see the cross-platform sandbox doc for cleanup)',
  },
  'settings.shellIsolation.networkNote': {
    'zh-CN': '网络访问不受操作系统层限制，由全局网络模式统一管控',
    'en-US': 'Network access is not restricted at the OS level; it follows the global network mode',
  },

  // 外观
  'settings.appearance.title': { 'zh-CN': '外观', 'en-US': 'Appearance' },
  'settings.appearance.themeModeAria': { 'zh-CN': '主题模式', 'en-US': 'Theme mode' },
  'settings.appearance.light': { 'zh-CN': '浅色', 'en-US': 'Light' },
  'settings.appearance.dark': { 'zh-CN': '深色', 'en-US': 'Dark' },
  'settings.appearance.system': { 'zh-CN': '跟随系统', 'en-US': 'System' },

  // 权限下拉（档位名沿用英文，与后端权限模式名一致）
  'settings.permission.filesystemAria': {
    'zh-CN': '文件系统权限',
    'en-US': 'Filesystem permission',
  },
  'settings.permission.ariaFor': { 'zh-CN': '{label} 权限', 'en-US': '{label} permission' },
  'settings.permission.currentTitle': {
    'zh-CN': '当前文件系统权限：{label}',
    'en-US': 'Current filesystem permission: {label}',
  },
  'settings.permission.fullAccessConfirm': {
    'zh-CN':
      'Full access 允许 Agent 读取、修改和删除当前用户可访问的宿主文件。网络权限不会因此开放。\n\n确认启用 Full access？',
    'en-US':
      'Full access lets the Agent read, modify and delete host files the current user can access. Network access is not opened by it.\n\nEnable Full access?',
  },

  // 模型提供方：加载与状态
  'settings.models.loadingProviders': {
    'zh-CN': '加载内置提供方…',
    'en-US': 'Loading built-in providers…',
  },
  'settings.models.chooseProvider': { 'zh-CN': '选择提供方', 'en-US': 'Select a provider' },
  'settings.models.builtinProvider': { 'zh-CN': '内置提供方', 'en-US': 'Built-in provider' },
  'settings.models.modelCount': { 'zh-CN': '{count} 个模型', 'en-US': '{count} models' },
  'settings.models.status.unconfigured': { 'zh-CN': '未配置', 'en-US': 'Not configured' },
  'settings.models.status.configured': { 'zh-CN': '待检测', 'en-US': 'Not checked' },
  'settings.models.status.available': {
    'zh-CN': '可用（已检测）',
    'en-US': 'Available (checked)',
  },
  'settings.models.status.error': { 'zh-CN': '检测失败', 'en-US': 'Check failed' },
  'settings.models.status.checking': { 'zh-CN': '正在检测', 'en-US': 'Checking' },

  // 模型提供方：错误提示
  'settings.models.loadListFailed': {
    'zh-CN': '加载模型列表失败：{message}',
    'en-US': 'Failed to load the model list: {message}',
  },
  'settings.models.loadProvidersFailed': {
    'zh-CN': '加载内置提供方失败：{message}',
    'en-US': 'Failed to load built-in providers: {message}',
  },
  'settings.models.nameRequired': { 'zh-CN': '名称不能为空。', 'en-US': 'Name is required.' },
  'settings.models.nameAndBaseUrlRequired': {
    'zh-CN': '名称和 Base URL 不能为空。',
    'en-US': 'Name and Base URL are required.',
  },
  'settings.models.atLeastOneModel': {
    'zh-CN': '至少需要一个模型标识。',
    'en-US': 'At least one model ID is required.',
  },
  'settings.models.providerRequired': {
    'zh-CN': '请选择一个内置提供方。',
    'en-US': 'Please select a built-in provider.',
  },
  'settings.models.apiKeyRequiredToSave': {
    'zh-CN': '请填写 API 密钥后再保存内置提供方。',
    'en-US': 'Enter the API key before saving the built-in provider.',
  },
  'settings.models.contextWindowPositiveInteger': {
    'zh-CN': '模型 {model} 的上下文窗口必须是正整数。',
    'en-US': 'The context window of model {model} must be a positive integer.',
  },
  'settings.models.maxOutputPositiveInteger': {
    'zh-CN': '模型 {model} 的最大输出必须是正整数。',
    'en-US': 'The max output of model {model} must be a positive integer.',
  },
  'settings.models.saveFailed': {
    'zh-CN': '保存失败：{message}',
    'en-US': 'Save failed: {message}',
  },
  'settings.models.clearApiKeyFailed': {
    'zh-CN': '清除密钥失败：{message}',
    'en-US': 'Failed to clear the API key: {message}',
  },
  'settings.models.deleteFailed': {
    'zh-CN': '删除失败：{message}',
    'en-US': 'Delete failed: {message}',
  },
  'settings.models.noChatModels': {
    'zh-CN': '检测到模型目录，但没有识别到可用于 Agent 的对话模型；请手动添加模型标识。',
    'en-US':
      'A model catalog was detected, but no chat model usable by the Agent was found; add model IDs manually.',
  },
  'settings.models.tooManyModels': {
    'zh-CN': '当前选择 {count} 个模型，最多只能保存 {max} 个，请将选择调整到 {max} 个以内。',
    'en-US':
      'You selected {count} models, but at most {max} can be saved; reduce the selection to {max} or fewer.',
  },
  'settings.models.builtinProviderNotFound': {
    'zh-CN': '内置提供方未找到',
    'en-US': 'Built-in provider not found',
  },
  'settings.models.builtinCatalogRefreshFailed': {
    'zh-CN': '内置模型目录刷新失败：{message}',
    'en-US': 'Failed to refresh the built-in model catalog: {message}',
  },
  'settings.models.detectFailed': {
    'zh-CN': '模型检测失败：{message}',
    'en-US': 'Model detection failed: {message}',
  },
  'settings.models.baseUrlAndApiKeyRequired': {
    'zh-CN': '请填写 API 地址与 API 密钥后再检测模型目录。',
    'en-US': 'Enter the API base URL and API key before detecting the model catalog.',
  },
  'settings.models.saveProviderFirst': {
    'zh-CN': '请先保存 Provider 后再检测模型目录。',
    'en-US': 'Save the provider before detecting the model catalog.',
  },

  // 模型提供方：表单
  'settings.models.addBuiltinProvider': {
    'zh-CN': '添加内置提供方',
    'en-US': 'Add built-in provider',
  },
  'settings.models.addCustomProvider': {
    'zh-CN': '添加自定义提供方',
    'en-US': 'Add custom provider',
  },
  'settings.models.editProvider': { 'zh-CN': '编辑提供方', 'en-US': 'Edit provider' },
  'settings.models.builtinCatalogHint': {
    'zh-CN': '目录来自内置模型库；保存后会按模型的真实 API 协议流式调用。',
    'en-US':
      "The catalog comes from the built-in model library; after saving, requests stream over each model's real API protocol.",
  },
  'settings.models.name': { 'zh-CN': '名称', 'en-US': 'Name' },
  'settings.models.namePlaceholder': { 'zh-CN': '例如 DeepSeek', 'en-US': 'e.g. DeepSeek' },
  'settings.models.apiKey': { 'zh-CN': 'API 密钥', 'en-US': 'API key' },
  'settings.models.apiKeyPlaceholder': {
    'zh-CN': '输入 API 密钥',
    'en-US': 'Enter the API key',
  },
  'settings.models.apiKeyConfiguredPlaceholder': {
    'zh-CN': '已配置——输入新值可替换',
    'en-US': 'Configured — enter a new value to replace it',
  },
  'settings.models.apiKeyUnchangedPlaceholder': {
    'zh-CN': '留空 = 不修改',
    'en-US': 'Leave blank to keep unchanged',
  },
  'settings.models.clearApiKey': { 'zh-CN': '清除密钥', 'en-US': 'Clear API key' },
  'settings.models.customSettings': { 'zh-CN': '自定义设置', 'en-US': 'Custom settings' },
  'settings.models.baseUrl': { 'zh-CN': 'API 地址', 'en-US': 'API base URL' },
  'settings.models.catalog': { 'zh-CN': '模型目录', 'en-US': 'Model catalog' },
  'settings.models.refreshBuiltinModels': {
    'zh-CN': '刷新内置模型',
    'en-US': 'Refresh built-in models',
  },
  'settings.models.detectAndSync': { 'zh-CN': '检测并同步模型', 'en-US': 'Detect and sync models' },
  'settings.models.builtinCatalogSourceHint': {
    'zh-CN': '使用内置模型目录；模型上下文和协议由模型库提供。',
    'en-US':
      'Uses the built-in model catalog; context windows and protocols come from the model library.',
  },
  'settings.models.detectHint': {
    'zh-CN': '检测后自动同步对话模型和上下文窗口；已手动填写的上下文不会覆盖。',
    'en-US':
      'Detection syncs chat models and context windows automatically; manually entered context windows are kept.',
  },
  'settings.models.contextWindow': { 'zh-CN': '上下文窗口', 'en-US': 'Context window' },
  'settings.models.contextWindowTitle': {
    'zh-CN': '上下文窗口（tokens，可选；来自模型供应商文档）',
    'en-US': 'Context window (tokens, optional; from the model vendor documentation)',
  },
  'settings.models.maxOutput': { 'zh-CN': '最大输出', 'en-US': 'Max output' },
  'settings.models.maxOutputTitle': {
    'zh-CN': '单次回复最大输出（tokens，可选）；留空时按上下文窗口推导',
    'en-US':
      'Max output per reply (tokens, optional); derived from the context window when left blank',
  },
  'settings.models.vision': { 'zh-CN': '视觉', 'en-US': 'Vision' },
  'settings.models.visionTitle': {
    'zh-CN': '该模型支持图片输入（视觉能力）；已按模型声明预选',
    'en-US': 'This model accepts image input (vision); pre-checked from the model declaration',
  },
  'settings.models.modelIdPlaceholder': {
    'zh-CN': '输入模型标识',
    'en-US': 'Enter a model ID',
  },
  'settings.models.addModel': { 'zh-CN': '添加模型', 'en-US': 'Add model' },
  'settings.models.emptyList': {
    'zh-CN': '暂无模型提供方，点击上方按钮添加。',
    'en-US': 'No model providers yet — use the buttons above to add one.',
  },

  // 模型提供方：列表卡片
  'settings.models.apiKeySet': { 'zh-CN': 'API Key 已配置', 'en-US': 'API Key set' },
  'settings.models.apiKeyNotSet': { 'zh-CN': 'API Key 未设置', 'en-US': 'API Key not set' },
  'settings.models.sourceCustom': { 'zh-CN': '自定义', 'en-US': 'Custom' },
  'settings.models.defaultBadge': { 'zh-CN': '默认', 'en-US': 'Default' },
  'settings.models.deleteProvider': { 'zh-CN': '删除提供方', 'en-US': 'Delete provider' },
  'settings.models.deleteConfirm': {
    'zh-CN': '确定要删除这个模型提供方吗？此操作不可恢复。',
    'en-US': 'Delete this model provider? This cannot be undone.',
  },
  'settings.models.deleteConfirmAria': {
    'zh-CN': '删除提供方确认',
    'en-US': 'Delete provider confirmation',
  },
  'settings.models.cancelDelete': { 'zh-CN': '取消删除', 'en-US': 'Cancel delete' },

  // 模型同步弹窗
  'settings.sync.title': { 'zh-CN': '选择同步模型', 'en-US': 'Select models to sync' },
  'settings.sync.subtitle': {
    'zh-CN': '检测到 {count} 个对话模型，勾选后才会加入当前提供方。',
    'en-US': 'Detected {count} chat models; only checked ones are added to the current provider.',
  },
  'settings.sync.selectedLabel': { 'zh-CN': '已选择', 'en-US': 'Selected' },
  'settings.sync.selectAll': { 'zh-CN': '全选', 'en-US': 'Select all' },
  'settings.sync.clearAll': { 'zh-CN': '清空', 'en-US': 'Clear' },
  'settings.sync.contextWindowMissing': {
    'zh-CN': '上下文未提供',
    'en-US': 'Context window not provided',
  },
  'settings.sync.contextWindowM': { 'zh-CN': '{value}M 上下文', 'en-US': '{value}M context' },
  'settings.sync.contextWindowK': { 'zh-CN': '{value}K 上下文', 'en-US': '{value}K context' },
  'settings.sync.contextWindowTokens': { 'zh-CN': '{value} 上下文', 'en-US': '{value} context' },
  'settings.sync.vision': { 'zh-CN': '视觉', 'en-US': 'Vision' },
  'settings.sync.overLimit': {
    'zh-CN': '当前选择 {count} 个模型；保存上限为 {max} 个，请继续调整勾选。',
    'en-US':
      '{count} models are currently selected; the save limit is {max}. Please keep adjusting the selection.',
  },
  'settings.sync.willKeep': {
    'zh-CN': '确认后当前表单将保留 {count} 个模型。',
    'en-US': 'After confirming, the form keeps {count} models.',
  },
  'settings.sync.confirm': { 'zh-CN': '同步已选模型', 'en-US': 'Sync selected models' },

  // 思考档次（下拉标签 + 悬停/无障碍说明）
  'settings.thinking.notSet': { 'zh-CN': '默认（不设置）', 'en-US': 'Default (not set)' },
  'settings.thinking.off': { 'zh-CN': '无思考', 'en-US': 'Off' },
  'settings.thinking.minimal': { 'zh-CN': '最低', 'en-US': 'Minimal' },
  'settings.thinking.low': { 'zh-CN': '低', 'en-US': 'Low' },
  'settings.thinking.medium': { 'zh-CN': '中', 'en-US': 'Medium' },
  'settings.thinking.high': { 'zh-CN': '高', 'en-US': 'High' },
  'settings.thinking.xhigh': { 'zh-CN': '最高', 'en-US': 'XHigh' },
  'settings.thinking.max': { 'zh-CN': '最强', 'en-US': 'Max' },
  'settings.thinking.selectTitle': {
    'zh-CN':
      '思考档次（可选）：未设置时不发送任何思考参数，由端点默认行为决定；设置后按厂商协议发送（pi 内置模型按注册表映射，自定义端点发 reasoning_effort）',
    'en-US':
      'Thinking level (optional): when unset, no thinking parameters are sent and the endpoint default applies; when set, parameters follow the vendor protocol (registry mapping for built-in models, reasoning_effort for custom endpoints)',
  },
  'settings.thinking.selectAria': { 'zh-CN': '思考档次', 'en-US': 'Thinking level' },
} as const;
