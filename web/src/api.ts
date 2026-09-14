import type {
  CreateModelProviderInput,
  DefaultModelView,
  FileEntry,
  HostEvent,
  HostRun,
  HostSession,
  ModelProviderView,
  ModelSelection,
  PermissionMode,
  PiAiProviderInfo,
  PromptCommand,
  ProviderModelInfo,
  SessionStats,
  ShellIsolationCapabilities,
  UpdateModelProviderInput,
  WorkspaceView,
} from './types';

const API_BASE = '';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // mode:'cors' 确保同源请求也携带 Origin header（规范行为：cors 模式总是发送 Origin）。
  // 否则同源 GET 不带 Origin，会被 Host 误判为"非浏览器请求"而要求 token 鉴权。
  const resp = await fetch(API_BASE + url, {
    ...init,
    mode: 'cors',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

/** createRun 线上报的图片附件：base64 负载仅在本次请求中传输，落盘后只留工作区路径 */
export interface CreateRunAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export function createRun(
  task: string,
  sessionId?: string,
  workspaceName?: string,
  permissionMode: PermissionMode = 'workspace-write',
  modelSelection?: Pick<ModelSelection, 'providerId' | 'model'>,
  attachments?: CreateRunAttachment[],
): Promise<{ runId: string; sessionId: string; status: string; permissionMode: PermissionMode }> {
  const url = sessionId ? `/sessions/${sessionId}/runs` : '/runs';
  const modelFields = modelSelection
    ? { providerId: modelSelection.providerId, model: modelSelection.model }
    : {};
  const attachmentFields = attachments && attachments.length > 0 ? { attachments } : {};
  return jsonFetch(url, {
    method: 'POST',
    body: JSON.stringify(
      workspaceName
        ? { task, workspaceName, permissionMode, ...modelFields, ...attachmentFields }
        : { task, permissionMode, ...modelFields, ...attachmentFields },
    ),
  });
}

/** 工作区内文件（含图片）的二进制访问地址；图片扩展名由 Host 直接返回二进制，可供 <img> 使用 */
export function workspaceFileUrl(runId: string, relPath: string): string {
  return `/runs/${runId}/files/${encodeURIComponent(relPath)}`;
}

export function listSessions(): Promise<{ sessions: HostSession[] }> {
  return jsonFetch('/sessions', { cache: 'no-store' });
}

/** 当前平台的 Shell 隔离能力（诚实分级；partial 必须对 UI 可见）。 */
export function fetchShellIsolation(): Promise<ShellIsolationCapabilities> {
  return jsonFetch<{ shellIsolation?: ShellIsolationCapabilities }>('/runtime/capabilities', {
    cache: 'no-store',
  }).then((resp) => {
    if (!resp.shellIsolation) throw new Error('Host did not return shellIsolation capabilities');
    return resp.shellIsolation;
  });
}

export function listSessionRuns(sessionId: string): Promise<{ runs: HostRun[] }> {
  return jsonFetch(`/sessions/${sessionId}/runs`, { cache: 'no-store' });
}

/** 会话级统计投影（底部统计条 StatsBar 数据源）。 */
export function fetchSessionStats(sessionId: string): Promise<SessionStats> {
  return jsonFetch(`/sessions/${sessionId}/stats`, { cache: 'no-store' });
}

// ---- 内置斜杠命令（/compact /export /goal /plan /feedback）----

/** 压缩后模型视图的输入占用（即时刷新上下文占用环）。 */
export interface CompactViewUsage {
  messageTokens: number;
  systemTokens?: number;
  toolSchemaTokens: number;
  estimatedInputTokens: number;
  inputBudgetTokens: number;
  usageRatio: number;
}

export function requestSessionCompact(sessionId: string): Promise<{
  ok: boolean;
  summarizedMessages: number;
  totalSummarizedMessages: number;
  compactedTokens: number;
  reason?: 'no_checkpoint' | 'nothing_compactable';
  usage?: CompactViewUsage;
}> {
  return jsonFetch(`/sessions/${sessionId}/compact`, { method: 'POST' });
}

export function getSessionGoal(sessionId: string): Promise<{ goal: string | null }> {
  return jsonFetch(`/sessions/${sessionId}/goal`, { cache: 'no-store' });
}

export function setSessionGoal(sessionId: string, goal: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/sessions/${sessionId}/goal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
}

export function getSessionPlanMode(sessionId: string): Promise<{ planMode: boolean }> {
  return jsonFetch(`/sessions/${sessionId}/plan`, { cache: 'no-store' });
}

export function setSessionPlanMode(sessionId: string, enabled: boolean): Promise<{ ok: boolean }> {
  return jsonFetch(`/sessions/${sessionId}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function sendSessionFeedback(sessionId: string, comment: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/sessions/${sessionId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
}

/** 触发浏览器下载会话日志 ZIP（端点带 Content-Disposition，免鉴权 GET）。 */
export function downloadSessionExport(sessionId: string): void {
  const anchor = document.createElement('a');
  anchor.href = `/sessions/${sessionId}/export`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function getWorkspace(): Promise<{ workspace: WorkspaceView | null }> {
  return jsonFetch('/workspace', { cache: 'no-store' });
}

/** 当前工作区的 Prompt 命令列表（输入框 / 补全用；无工作区返回空数组） */
export function listPromptCommands(): Promise<{ prompts: PromptCommand[] }> {
  return jsonFetch('/prompts', { cache: 'no-store' });
}

export function openWorkspace(): Promise<{ workspace: WorkspaceView | null; cancelled: boolean }> {
  return jsonFetch('/workspace/open', { method: 'POST', cache: 'no-store' });
}

/** 网页内目录选择后采纳该目录为当前 Workspace（等价 native picker 的宿主切换） */
export function selectWorkspace(path: string): Promise<{ workspace: WorkspaceView | null }> {
  return jsonFetch('/workspace/select', {
    method: 'POST',
    body: JSON.stringify({ path }),
    cache: 'no-store',
  });
}

export interface DirectoryPickerCapability {
  kind: 'native' | 'browse';
}

export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  home: string;
  crumbs: DirectoryEntry[];
  entries: DirectoryEntry[];
  truncated: boolean;
}

export function getDirectoryPickerCapability(): Promise<{ capability: DirectoryPickerCapability }> {
  return jsonFetch('/workspace/capability', { cache: 'no-store' });
}

export function browseDirectory(path?: string): Promise<DirectoryListing> {
  return jsonFetch('/workspace/browse', {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

export function createWorkspaceDirectory(path: string, name: string): Promise<{ path: string }> {
  return jsonFetch('/workspace/create-directory', {
    method: 'POST',
    body: JSON.stringify({ path, name }),
  });
}

export function renameWorkspace(fromName: string, toName: string): Promise<{ updated: number }> {
  return jsonFetch('/workspace/rename', {
    method: 'POST',
    body: JSON.stringify({ fromName, toName }),
  });
}

export function renameSession(sessionId: string, title: string): Promise<{ updatedAt: string }> {
  return jsonFetch(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ title }) });
}

export function archiveSession(
  sessionId: string,
): Promise<{ archived: number; updatedAt: string }> {
  return jsonFetch(`/sessions/${sessionId}/archive`, { method: 'POST' });
}

export function deleteWorkspaceGroup(name: string): Promise<{ deleted: number }> {
  return jsonFetch('/workspace/delete', { method: 'POST', body: JSON.stringify({ name }) });
}

export function listRuns(): Promise<{ runs: HostRun[] }> {
  return jsonFetch('/runs');
}

export function getRun(runId: string): Promise<HostRun> {
  return jsonFetch(`/runs/${runId}`);
}

export function stopRun(runId: string): Promise<{ runId: string; status: string }> {
  return jsonFetch(`/runs/${runId}/stop`, { method: 'POST' });
}

export function resumeRun(runId: string): Promise<{ runId: string; status: string }> {
  return jsonFetch(`/runs/${runId}/resume`, { method: 'POST' });
}

export function listFiles(runId: string): Promise<{ runId: string; files: FileEntry[] }> {
  return jsonFetch(`/runs/${runId}/files`);
}

export function readFile(
  runId: string,
  filePath: string,
): Promise<{ runId: string; name: string; content: string }> {
  return jsonFetch(`/runs/${runId}/files/${encodeURIComponent(filePath)}`);
}

export function openFileInDefaultBrowser(
  runId: string,
  filePath: string,
): Promise<{ runId: string; name: string; opened: true }> {
  return jsonFetch(`/runs/${runId}/files/${encodeURIComponent(filePath)}/open`, { method: 'POST' });
}

/**
 * 在途快照请求的合并表。
 *
 * React StrictMode 在开发构建下会「挂载 → 卸载 → 再挂载」，组件 effect 因此执行两次，
 * 同一个 Run 的快照会被请求两遍（终态 Run 的事件可达数百 KB，长会话下是成倍的浪费）。
 * 这里只合并**在途**请求：请求一落定立刻从表中移除，所以不存在拿到陈旧数据的可能，
 * 生产构建（StrictMode 不双执行）行为完全不变。
 */
const inFlightRunEvents = new Map<string, Promise<{ events: HostEvent[] }>>();

/**
 * 一次性取回 Run 的完整事件日志（已终态 Run 的只读快照）。
 *
 * 已完成 Run 的事件不会再变，用普通请求取回即可，无需 EventSource 长连接：
 * 浏览器对同源只有 6 条并发连接，长会话里每个历史回合各占一条 SSE 会互相排队，
 * 连正在流式的 Run 都拿不到连接。取回顺序与 SSE 回放一致（按 seq 升序）。
 */
export function fetchRunEvents(runId: string): Promise<{ events: HostEvent[] }> {
  const inFlight = inFlightRunEvents.get(runId);
  if (inFlight) return inFlight;
  const request = jsonFetch<{ events: HostEvent[] }>(`/runs/${runId}/events/snapshot`, {
    cache: 'no-store',
  }).finally(() => {
    inFlightRunEvents.delete(runId);
  });
  inFlightRunEvents.set(runId, request);
  return request;
}

// SSE 事件连接：订阅所有事件类型，回调收到 HostEvent
// 返回 cleanup 函数（close）
export function connectSSE(
  runId: string,
  live: boolean,
  onEvent: (ev: HostEvent, seq: number) => void,
  onConnect?: () => void,
  onError?: () => void,
): () => void {
  const url = `/runs/${runId}/events${live ? '' : '?live=0'}`;
  const es = new EventSource(url);

  const eventTypes = [
    'run_started',
    'run_stopping',
    'run_completed',
    'run_failed',
    'run_stopped',
    'run_interrupted',
    'assistant_delta',
    'reasoning_delta',
    'llm_call',
    'llm_call_started',
    'llm_request_sent',
    'tool_call',
    'tool_call_invalid',
    'tool_result',
    'tool_result_invalid',
    'tool_error',
    'final_answer',
    'context_trim',
    'context_usage',
    'context_compaction',
    'recovery_decision',
    'empty_turn_recovered',
    'finalization_guard',
    'side_effect_skip',
    'side_effect_uncertain',
    'tool_output_truncated',
    'shell_sandbox_started',
    'shell_sandbox_denied',
    'scratchpad_update',
    'plan_update',
    'plan_incomplete_at_finish',
    'background_job_notified',
    'error',
    'approval_requested',
    'approval_resolved',
    'toolchain_preparation_requested',
    'toolchain_preparation_started',
    'toolchain_preparation_progress',
    'toolchain_preparation_resolved',
  ];

  const handler = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as HostEvent;
      const seq = Number(e.lastEventId);
      onEvent(data, Number.isSafeInteger(seq) && seq > 0 ? seq : 0);
    } catch {
      // ignore parse errors
    }
  };

  for (const t of eventTypes) {
    es.addEventListener(t, handler as EventListener);
  }

  let failedAttempts = 0;
  const MAX_FAILS_BEFORE_CLOSE = 5;
  let connectedOnce = false;

  es.onopen = () => {
    connectedOnce = true;
    failedAttempts = 0;
    onConnect?.();
  };
  es.onerror = () => {
    // 一旦服务器返回非 200（例如 404/502/握手失败），EventSource 会按 retry:3000 自动重连。
    // 若连续多次连不上，通常就是永久失败（run 不存在、Host 挂了、反代挂了），主动关掉避免 Network 里一直重连。
    if (!connectedOnce) failedAttempts += 1;
    if (failedAttempts >= MAX_FAILS_BEFORE_CLOSE) {
      console.warn(
        // i18n-exempt: 开发期日志，非界面文案
        `[SSE] 连续 ${failedAttempts} 次连接失败，关闭 EventSource 以避免无限重连（runId=${runId}）`,
      );
      es.close();
    }
    if (!live) es.close();
    onError?.();
  };

  return () => {
    for (const t of eventTypes) {
      es.removeEventListener(t, handler as EventListener);
    }
    es.close();
  };
}

// ===== v2.0.1 JIT Approval =====

// 用户裁决网络访问批准请求（允许/拒绝回传 Host）
export function resolveApproval(
  runId: string,
  requestId: string,
  approved: boolean,
): Promise<{ runId: string; requestId: string; approved: boolean; resolved: true }> {
  return jsonFetch(`/runs/${runId}/approval`, {
    method: 'POST',
    body: JSON.stringify({ requestId, approved }),
  });
}

// 用户批准/拒绝受控 macOS 工具链准备（固定 Homebrew 计划，不接受安装命令）。
export function resolveToolchainPreparation(
  runId: string,
  requestId: string,
  approved: boolean,
): Promise<{ runId: string; requestId: string; approved: boolean; resolved: true }> {
  return jsonFetch(`/runs/${runId}/toolchain-preparation`, {
    method: 'POST',
    body: JSON.stringify({ requestId, approved }),
  });
}

// 取消已经批准、但仍在 Host 上执行的受控工具链准备。
export function cancelToolchainPreparation(
  runId: string,
  requestId: string,
): Promise<{ runId: string; requestId: string; cancelled: true }> {
  return jsonFetch(`/runs/${runId}/toolchain-preparation`, {
    method: 'POST',
    body: JSON.stringify({ requestId, cancel: true }),
  });
}

// ===== Models CRUD =====

export function listModels(): Promise<{ models: ModelProviderView[] }> {
  return jsonFetch('/settings/models', { cache: 'no-store' });
}

export function createModel(input: CreateModelProviderInput): Promise<ModelProviderView> {
  return jsonFetch('/settings/models', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// pi-ai 内置 Provider 的公开目录。只返回模型能力和默认地址，不包含任何凭证。
export function listPiAiProviders(): Promise<{ providers: PiAiProviderInfo[] }> {
  return jsonFetch('/settings/pi-ai/providers', { cache: 'no-store' });
}

export function updateModel(
  id: string,
  input: UpdateModelProviderInput,
): Promise<ModelProviderView> {
  return jsonFetch(`/settings/models/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteModel(id: string): Promise<{ deleted: true }> {
  return jsonFetch(`/settings/models/${id}`, {
    method: 'DELETE',
  });
}

// ===== 默认模型（provider + model 成对） =====

export function getDefaultModel(): Promise<DefaultModelView> {
  return jsonFetch('/settings', { cache: 'no-store' });
}

export function setDefaultModel(providerId: string, model: string): Promise<DefaultModelView> {
  return jsonFetch('/settings/default', {
    method: 'POST',
    body: JSON.stringify({ providerId, model }),
  });
}

// 拉取 OpenAI 兼容端点的可用模型目录。
// 仅使用服务端已保存的 Provider 配置（providerId），由 Host 读取其 baseUrl 与 apiKey。
// 不允许前端传入 baseUrl 或 apiKey（SSRF / Secret 外带防线）。
export function fetchAvailableModels(input: {
  providerId: string;
}): Promise<{ models: string[]; catalog?: ProviderModelInfo[] }> {
  return jsonFetch('/settings/available-models', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// 新增 Provider 时的临时预检：用表单中的 baseUrl + apiKey 拉取模型目录。
// 凭证不落盘、不进日志、不回显；由 Host 走 /settings/available-models/preview（需鉴权、协议白名单）。
export function previewAvailableModels(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<{ models: string[]; catalog?: ProviderModelInfo[] }> {
  return jsonFetch('/settings/available-models/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
