// 模块 2: 工具注册与执行
// 契约（安全边界）：
// - LLM 永远不能控制 runId/workspaceRoot：两者不出现在任何 Tool Schema 中，由 Runtime 注入。
// - 工具只接收"相对路径"参数；文件类工具必须相对 context.workspaceRoot 解析真实路径。
// - 模型决定"做什么"，Runtime 决定"在哪里执行"。

import type { ToolSchema } from '../llm/llm.js';
import type { NetworkMode } from '../network-mode.js';
import { getNetworkMode } from '../network-mode.js';
import type { PermissionMode } from '../permission-mode.js';
import type { ApprovalPort } from '../runtime/approval-port.js';
import type { RuntimeToolchainCapabilities } from '../sandbox/toolchain-manager.js';

// Runtime 注入的工具上下文（LLM 不可见、不可传入）
export interface ToolContext {
  runId: string; // 当前 Agent Run 的 runId，只能来自 Agent Runtime State
  workspaceRoot: string; // Host/Runtime 授权并 canonicalize 的真实工作根，LLM 不可见不可覆盖
  // Host 在 Run 创建时固化的文件系统能力；缺省仅用于兼容旧 CLI/测试调用。
  // Agent Tool Schema 不包含此字段，LLM 无法自行升级。
  permissionMode?: PermissionMode;
  // v2.0 Network Control：当前全局网络模式（Runtime 注入，LLM 不可控制）。
  // 工具读取它做自身裁定（如 shell 选择 sandbox 网络策略）；Network Capability
  // Check 本身集中在 tools.execute()，不依赖各 Tool 自行判断。
  networkMode?: NetworkMode;
  // v2.0.1 JIT Approval：网络访问即时授权端口（Host 注入；缺省 = 拒绝）。
  // ask 模式下由 Agent pipeline 在执行前调用 request()；工具本身不感知批准。
  approvalPort?: ApprovalPort;
  // True cancellation (v1.6)：Run 的 AbortSignal；长任务工具（shell 及未来 browser/computer）
  // 必须监听并尽快终止，读类/原子文件工具可忽略。与 runId 一样由 Runtime 注入，LLM 不可见。
  signal?: AbortSignal;
  // Runtime-only observation hook; never included in an LLM Tool Schema.
  onSandboxEvent?: (event: ToolSandboxEvent) => void;
  // Startup-discovered, path-free capability snapshot. Runtime-only: the LLM
  // cannot supply or upgrade it, and concrete tools cannot widen the policy.
  toolchain?: RuntimeToolchainCapabilities;
  // 当前 Run 使用的模型是否支持图片输入（Runtime 按模型能力注入，LLM 不可见）。
  // 读图类工具据此返回图片块；为 false 时一律返回文本占位，保证文本模型可用。
  vision?: boolean;
}

// 多模态工具返回：文本说明（模型可见、走 output-guard 截断）+ 图片引用。
// images 只携带工作区相对路径；base64 物化在 Runtime 调用模型前统一完成，
// 工具本身不读图片字节进返回值（避免大对象穿过 trace / checkpoint）。
export interface ToolImage {
  mimeType: string;
  path: string;
}

export interface ToolMultimodalResult {
  content: string;
  images?: ToolImage[];
}

// 工具执行结果：纯文本（向后兼容）或 文本+图片 的多模态结果。
export type ToolResult = string | ToolMultimodalResult;

export function normalizeToolResult(result: ToolResult): {
  text: string;
  images?: ToolImage[];
} {
  return typeof result === 'string'
    ? { text: result }
    : { text: result.content, ...(result.images?.length ? { images: result.images } : {}) };
}

export type ToolSandboxEvent =
  | { type: 'shell_sandbox_started'; platform: 'macos' }
  | { type: 'shell_sandbox_denied'; platform: 'macos'; reason: 'workspace_policy' };

// v1.3 契约收紧：Tool 副作用类别声明
// - read: 纯读取，无副作用
// - idempotent: 可安全重复执行（同参数 → 等价结果）
// - non_idempotent: 高风险副作用，重复执行可能产生不同结果/不可逆影响
export type ToolEffect = 'read' | 'idempotent' | 'non_idempotent';

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema（严禁包含 runId 等 Runtime 内部字段）
  // v1.3 契约收紧：声明副作用类别（必填）
  effect: ToolEffect;
  // v1.9 动态副作用类别：按本次调用参数细化 effect（缺省用静态 effect）。
  // 典型场景：shell 整体是 non_idempotent，但 `git log` / `ls` 这类只读命令
  // 不应被副作用守卫回放缓存结果。分类必须保守：不确定时返回 non_idempotent。
  resolveEffect?: (args: Record<string, unknown>, context?: ToolContext) => ToolEffect;
  // v2.0 Network Control：Tool 注册时显式声明是否具备网络能力。
  // 缺省（undefined）视为无网络能力 —— 不要求网络、也不受网络开关影响。
  // 由 Tool 作者声明，Runtime 绝不猜测（不做 curl/wget/git 字符串识别）。
  capabilities?: {
    network?: boolean;
  };
  // v1.3 契约收紧：显式定义"什么叫同一个操作"（canonical operation key）。
  // non_idempotent 必填（注册期强制校验），禁止回退到 JSON.stringify(args) 猜测；
  // read / idempotent 可省略，回退到 JSON.stringify(args)。
  // v1.5 融合身份机制：getOperationKey 可选接收 ToolContext（运行时注入，含 runId/workspaceRoot），
  //   路径类工具用它做路径归一化（canonicalPathKey），使 ./work/a.txt 与 work/a.txt 归一为同一 key 且不暴露宿主绝对路径。
  getOperationKey?: (args: Record<string, unknown>, context?: ToolContext) => string;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  // v1.2: 可选的业务结果有效性校验。无此字段则默认结果有效。
  // execute 负责"能不能执行成功"；validateResult 负责"结果能不能继续被 Agent 使用"。
  validateResult?: (result: unknown) => boolean | { valid: boolean; reason?: string };
  // v1.7: 向后兼容别名标记。hidden 工具仍可通过 execute() / getTool() 调用，
  // 但不会暴露在 getSchemas()（LLM 可见 schema）中，避免工具数量膨胀。
  hidden?: boolean;
}

// ---- 工具注册表 ----
const registry = new Map<string, Tool>();

export function register(tool: Tool): void {
  // v1.3 契约收紧：non_idempotent（高风险副作用）必须显式声明"什么叫同一个操作"。
  // 不能依赖默认 JSON.stringify(args) 猜测操作身份 → 注册期直接失败（fail-fast）。
  if (tool.effect === 'non_idempotent' && typeof tool.getOperationKey !== 'function') {
    throw new Error(
      `Tool "${tool.name}" 声明为 non_idempotent（高风险副作用）但未实现 getOperationKey，注册失败。` +
        `non_idempotent 必须显式定义 canonical operation key，禁止回退到 JSON.stringify(args)。`,
    );
  }
  registry.set(tool.name, tool);
}

// v1.7: 注册向后兼容别名。别名与主工具共享同一实现，但不出现在 LLM Schema 中。
// 用于 readFile→read、writeFile→write、listDir→ls、searchText→grep 等重命名场景。
export function registerAlias(canonicalName: string, aliasName: string): void {
  const source = registry.get(canonicalName);
  if (!source) {
    throw new Error(`registerAlias 失败：主工具 "${canonicalName}" 未注册`);
  }
  registry.set(aliasName, {
    ...source,
    name: aliasName,
    hidden: true,
  });
}

// 按名称取工具定义（供 Runtime 读取 effect / getOperationKey 等契约字段）
export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

// v1.9：解析一次调用的实际副作用类别（动态 effect 优先于静态声明）。
// 所有副作用判定（回放/重试/begin-persist）必须经过这里，避免各处直接读
// tool.effect 导致动态分类被绕过。
export function resolveToolEffect(
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext,
): ToolEffect {
  return tool.resolveEffect?.(args, context) ?? tool.effect;
}

// v2.0 Network Control：Tool 是否具备网络能力（注册时声明）判断辅助
export function toolRequiresNetwork(tool: Tool): boolean {
  return tool.capabilities?.network === true;
}

// v2.0.1 JIT Approval：ask 模式下网络工具是否需要即时授权。
// 供 Agent pipeline 在执行前判定；批准逻辑集中在 Runtime，工具不感知。
export function needsNetworkApproval(tool: Tool, networkMode: string | undefined): boolean {
  return networkMode === 'ask' && toolRequiresNetwork(tool);
}

// 结构化网络拒绝错误文案（模型可见、稳定、可测试）
export const NETWORK_DENIED_MESSAGE =
  'Network is disabled (network.mode=off) and this tool requires network access. ' +
  'Retry without network or ask the user to enable network.';

// Shell command lookup failed before a known executable could run. This is a
// structured Runtime error so Host can offer the separate, user-approved
// dependency preparation flow without parsing arbitrary tool output.
export class RequiredRuntimeToolUnavailableError extends Error {
  constructor(public readonly toolName: string) {
    super(`Required shell tool "${toolName}" is not available in the current controlled runtime.`);
    this.name = 'RequiredRuntimeToolUnavailableError';
  }
}

// v2.0 Network Capability Check：执行前统一校验。
// - network on → 正常执行
// - network off + tool.capabilities.network === true → 拒绝（抛 NetworkDeniedError）
// - 不需要网络的工具不受影响
// 集中在此一处，Agent Loop 与直接 execute() 调用方都经过这里，配置不散落到各 Tool。
export class NetworkDeniedError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" requires network access: ${NETWORK_DENIED_MESSAGE}`);
    this.name = 'NetworkDeniedError';
  }
}

// 执行工具；工具不存在或执行抛错时向上抛出（由调用方捕获重试）
// context 由 Runtime 注入（含 runId），工具的路径类参数必须以相对路径表达
export async function execute(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool "${name}" not found`);

  // v2.0 Network Capability Check（集中式）：
  // - mode === "off" + 网络工具 → 拒绝（NetworkDeniedError，shell 绝不执行）
  // - mode === "ask"          → 放行（批准已在 Agent pipeline 前置完成；
  //                             工具本身不感知批准，也无需二次判断）
  // - mode === "on"           → 正常执行
  // - 非网络工具               → 不受任何模式影响
  if (getNetworkMode() === 'off' && toolRequiresNetwork(tool)) {
    throw new NetworkDeniedError(name);
  }

  return tool.execute(args, context);
}

// 导出为 OpenAI tools 参数格式（排除 hidden 别名，保持 LLM 视角工具集精简）
export function getSchemas(): ToolSchema[] {
  return [...registry.values()]
    .filter((t) => !t.hidden)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
}

// v1.2: 运行 Tool 的 validateResult（若存在）；无声明默认结果有效。
// 返回 { valid, reason? }，供 Agent Loop 区分"执行成功"与"结果有效"两个维度。
export function validateToolResult(
  name: string,
  result: unknown,
): { valid: boolean; reason?: string } {
  const tool = registry.get(name);
  if (!tool || !tool.validateResult) return { valid: true };
  const r = tool.validateResult(result);
  if (typeof r === 'boolean') return { valid: r };
  return r;
}

// v1.3 契约收紧：解析一次工具调用的 canonical operation key（"什么叫同一个操作"）。
// - 显式 getOperationKey → 使用它（canonical key，权威身份；context 可选透传给路径归一化工具）
// - read / idempotent     → 允许回退 JSON.stringify(args)
// - non_idempotent        → 禁止回退；无 getOperationKey 直接抛错（注册期已拦截，此处防御兜底）
export function resolveOperationKey(
  tool: Tool,
  args: Record<string, unknown>,
  context?: ToolContext,
): string {
  if (tool.getOperationKey) return tool.getOperationKey(args, context);
  if (tool.effect !== 'non_idempotent') return JSON.stringify(args);
  throw new Error(
    `Tool "${tool.name}" 为 non_idempotent 但未实现 getOperationKey，禁止回退到 JSON.stringify(args)`,
  );
}

// ---- v1.6 Tool Call Invocation Validation ----
// 模型生成的 tool_call 在执行前经过统一管线：Parse → Validate → Resolve →
// Side-effect preparation → Execute。Parse/Validate/Resolve 失败是
// **可恢复的 invocation error**（结构化错误回传模型修正），不是 Runtime fatal。
// 与 Execution Error（文件系统/shell/业务失败，走既有 retry+recovery）严格分离。

export type ToolCallErrorCode =
  | 'INVALID_ARGUMENT_JSON' // arguments 不是合法 JSON（含空/缺失）
  | 'INVALID_ARGUMENTS' // 合法 JSON 但不是 object
  | 'INVALID_ARGUMENT_SHAPE' // 符合 object 但违反 Tool 声明的 schema（未知/缺失/类型/枚举）
  | 'TOOL_NOT_FOUND'; // 注册表中不存在该工具

export interface ToolCallError {
  code: ToolCallErrorCode;
  // 面向模型的稳定文案（不含解析器内部细节，跨 Node 版本稳定、可测试）
  message: string;
}

const INVALID_ARGUMENT_JSON_MESSAGE =
  'Tool arguments are not valid JSON. Retry this tool call with arguments as one valid JSON object.';
const INVALID_ARGUMENTS_MESSAGE =
  'Tool arguments must be a single JSON object, e.g. {"key": "value"}.';

export type ToolArgumentParseResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: ToolCallError };

// 统一入口：streaming 与 non-streaming 两条传输路径最终都经过这里，
// 不存在各自的 JSON.parse 分支。不做任何自动修复（不猜模型意图）。
export function parseToolArguments(
  rawArguments: string | undefined | null,
): ToolArgumentParseResult {
  const raw = typeof rawArguments === 'string' ? rawArguments.trim() : '';
  if (!raw) {
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENT_JSON', message: INVALID_ARGUMENT_JSON_MESSAGE },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 解析器内部细节只进 trace（由调用方记录），模型只看到稳定文案
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENT_JSON', message: INVALID_ARGUMENT_JSON_MESSAGE },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // null / 数组 / 字符串 / 数字：合法 JSON 但不符合 Tool Contract（必须是 object）
    return {
      ok: false,
      error: { code: 'INVALID_ARGUMENTS', message: INVALID_ARGUMENTS_MESSAGE },
    };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

export function toolNotFoundError(toolName: string): ToolCallError {
  return {
    code: 'TOOL_NOT_FOUND',
    message: `Tool "${toolName}" does not exist. Retry with one of the available tools.`,
  };
}

// v1.8：schema 级校验失败（未知参数 / 缺必填 / 类型错 / 枚举错）。
// 与 JSON 解析失败同级：工具不执行、不创建副作用，结构化错误回传模型修正。
export function invalidToolArgumentsError(message: string): ToolCallError {
  return { code: 'INVALID_ARGUMENT_SHAPE', message };
}

// 标准化 tool result 内容（保留 tool_call_id 关联由 messages 层负责）
export function formatToolCallError(error: ToolCallError): string {
  return JSON.stringify({ error: { code: error.code, message: error.message } });
}
