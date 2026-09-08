// 内置斜杠命令注册表（对标 DSH 原生命令）：纯数据 + 纯解析，react-free，
// 供 InputBar 补全合并、App 执行器与 node 测试三方复用。
// 与工作区提示词模板（.payaso/prompts/*.md → LLM 提示词）相对：内置命令是
// 真功能，发送时被客户端拦截执行，不会作为任务发给模型。

import type { PermissionMode } from '../types';

export interface BuiltinCommand {
  name: string;
  description: string;
  usage: string;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: 'compact', description: '压缩更早的对话历史（下一条消息发送时执行）', usage: '/compact' },
  { name: 'export', description: '下载本会话完整日志归档（ZIP）', usage: '/export' },
  { name: 'feedback', description: '记录对本会话的反馈', usage: '/feedback <意见>' },
  { name: 'goal', description: '设置或查看本会话的长期目标', usage: '/goal [目标内容]' },
  {
    name: 'permission',
    description: '切换权限预设（沙箱模式）',
    usage: '/permission [read-only|workspace-write|full-access]',
  },
  { name: 'plan', description: '进入/退出计划模式（只读 + 仅产出方案）', usage: '/plan' },
  { name: 'model', description: '选择本会话使用的模型', usage: '/model <provider/模型关键词>' },
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
  if (!name || !BUILTIN_COMMANDS.some((cmd) => cmd.name === name)) return null;
  const args = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  return { name, args };
}

/** 补全候选：内置命令优先，其后是工作区提示词模板（按前缀过滤）。 */
export function mergeCommandCandidates(
  query: string,
  workspacePrompts: Array<{ name: string; description: string }>,
): Array<{ name: string; description: string; builtin: boolean }> {
  const q = query.toLowerCase();
  const builtins = BUILTIN_COMMANDS.filter((cmd) => cmd.name.startsWith(q)).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
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
  { mode: 'read-only', keywords: ['read-only', 'readonly', 'read', '只读'] },
  {
    mode: 'workspace-write',
    keywords: ['workspace-write', 'workspace', 'write', '工作区', '写入'],
  },
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
