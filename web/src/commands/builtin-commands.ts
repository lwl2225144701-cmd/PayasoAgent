// 内置斜杠命令注册表（对标 DSH 原生命令）：纯数据 + 纯解析，react-free，
// 供 InputBar 补全合并、App 执行器与 node 测试三方复用。
// 与工作区提示词模板（.payaso/prompts/*.md → LLM 提示词）相对：内置命令是
// 真功能，发送时被客户端拦截执行，不会作为任务发给模型。

import type { MessageKey } from '../i18n/messages';
import type { PermissionMode } from '../types';

export interface BuiltinCommand {
  name: string;
  /** 命令一句话说明的消息 key（调用方用 t() 取文案）。 */
  descriptionKey: MessageKey;
  /** 用法示例的消息 key：占位符里的「意见 / 目标内容」等随语言切换。 */
  usageKey: MessageKey;
}

/**
 * 当前启用的内置命令。其余命令保留实现（端点/执行器均在），先不下发展示、
 * 也不拦截发送——重新启用只需把名字加回集合。
 */
const ENABLED_COMMAND_NAMES: ReadonlySet<string> = new Set(['compact']);

export function isEnabledCommand(name: string): boolean {
  return ENABLED_COMMAND_NAMES.has(name);
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    name: 'compact',
    descriptionKey: 'composer.commands.compact.description',
    usageKey: 'composer.commands.compact.usage',
  },
  {
    name: 'export',
    descriptionKey: 'composer.commands.export.description',
    usageKey: 'composer.commands.export.usage',
  },
  {
    name: 'feedback',
    descriptionKey: 'composer.commands.feedback.description',
    usageKey: 'composer.commands.feedback.usage',
  },
  {
    name: 'goal',
    descriptionKey: 'composer.commands.goal.description',
    usageKey: 'composer.commands.goal.usage',
  },
  {
    name: 'permission',
    descriptionKey: 'composer.commands.permission.description',
    usageKey: 'composer.commands.permission.usage',
  },
  {
    name: 'plan',
    descriptionKey: 'composer.commands.plan.description',
    usageKey: 'composer.commands.plan.usage',
  },
  {
    name: 'model',
    descriptionKey: 'composer.commands.model.description',
    usageKey: 'composer.commands.model.usage',
  },
];

export interface BuiltinCommandMatch {
  name: string;
  args: string;
}

/**
 * 解析输入是否为内置命令：首个词 `/name` 与注册表精确匹配（大小写不敏感）。
 * 未匹配（普通消息或未知的 /词）返回 null，走原有发送链路。
 */
export function matchBuiltinCommand(text: string): BuiltinCommandMatch | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIndex = trimmed.search(/\s/);
  const name = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).slice(1).toLowerCase();
  if (!name || !isEnabledCommand(name)) return null;
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  return { name, args };
}

/**
 * 补全候选：内置命令与工作区提示词模板**显式区分**文案来源，
 * 避免把 Host 下发的模板原文当 key 去查消息表。
 */
export interface CommandCandidate {
  name: string;
  builtin: boolean;
  /** 工作区提示词模板的原文描述（Host 下发，非消息 key，直接渲染）。 */
  description?: string;
  /** 内置命令描述的消息 key（渲染时用 t() 取文案）。 */
  descriptionKey?: MessageKey;
}

/** 补全候选：内置命令优先，其后是工作区提示词模板（按前缀过滤）。 */
export function mergeCommandCandidates(
  query: string,
  workspacePrompts: Array<{ name: string; description: string }>,
): CommandCandidate[] {
  const q = query.toLowerCase();
  const builtins = BUILTIN_COMMANDS.filter(
    (cmd) => cmd.name.startsWith(q) && isEnabledCommand(cmd.name),
  ).map((cmd) => ({
    name: cmd.name,
    descriptionKey: cmd.descriptionKey,
    builtin: true,
  }));
  const prompts = workspacePrompts
    .filter(
      (cmd) => cmd.name.toLowerCase().startsWith(q) && !builtins.some((b) => b.name === cmd.name),
    )
    .map((cmd) => ({ name: cmd.name, description: cmd.description, builtin: false }));
  return [...builtins, ...prompts];
}

const PERMISSION_ALIASES: Array<{ mode: PermissionMode; keywords: string[] }> = [
  // i18n-exempt: /permission 的用户输入别名，不是展示文案
  { mode: 'read-only', keywords: ['read-only', 'readonly', 'read', '只读'] },
  {
    mode: 'workspace-write',
    // i18n-exempt: /permission 的用户输入别名，不是展示文案
    keywords: ['workspace-write', 'workspace', 'write', '工作区', '写入'],
  },
  // i18n-exempt: /permission 的用户输入别名，不是展示文案
  { mode: 'full-access', keywords: ['full-access', 'full', '完全'] },
];

/** 权限档模糊匹配：前缀/别名大小写不敏感；无法识别返回 null。 */
export function matchPermissionMode(args: string): PermissionMode | null {
  const q = args.trim().toLowerCase();
  if (!q) return null;
  const hit = PERMISSION_ALIASES.find(
    (entry) => entry.mode === q || entry.keywords.some((keyword) => keyword.startsWith(q)),
  );
  return hit?.mode ?? null;
}

export interface ModelCandidate {
  providerId: string;
  model: string;
}

/**
 * 模型模糊匹配：支持 `provider/model` 精确对、或对 model/providerId/名称的
 * 子串匹配。唯一命中返回 candidates=[]；多个命中把候选带回给调用方提示。
 */
export function matchModelByQuery(
  providers: ReadonlyArray<{ id: string; name?: string; models: readonly string[] }>,
  query: string,
): { match: ModelCandidate | null; candidates: ModelCandidate[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { match: null, candidates: [] };
  const all: ModelCandidate[] = providers.flatMap((provider) =>
    provider.models.map((model) => ({ providerId: provider.id, model })),
  );
  const pair = q.includes('/');
  const exact = all.find(
    (candidate) =>
      `${candidate.providerId}/${candidate.model}`.toLowerCase() === q ||
      candidate.model.toLowerCase() === q,
  );
  if (exact) return { match: exact, candidates: [] };
  const [providerPart, modelPart] = pair ? q.split('/', 2) : [undefined, q];
  const candidates = all.filter((candidate) => {
    const providerText =
      `${candidate.providerId} ${providers.find((p) => p.id === candidate.providerId)?.name ?? ''}`.toLowerCase();
    if (pair) {
      return (
        candidate.providerId.toLowerCase().includes(providerPart ?? '') &&
        candidate.model.toLowerCase().includes(modelPart ?? '')
      );
    }
    return candidate.model.toLowerCase().includes(q) || providerText.includes(q);
  });
  if (candidates.length === 1) return { match: candidates[0], candidates: [] };
  return { match: null, candidates };
}
