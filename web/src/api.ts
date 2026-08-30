import type { HostRun, HostSession, FileEntry, HostEvent, WorkspaceView, ModelProviderView, CreateModelProviderInput, UpdateModelProviderInput, DefaultModelView } from './types';

const API_BASE = '';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(API_BASE + url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text || resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

export function createRun(
  task: string,
  sessionId?: string,
  workspaceName?: string,
): Promise<{ runId: string; sessionId: string; status: string }> {
  const url = sessionId ? `/sessions/${sessionId}/runs` : '/runs';
  return jsonFetch(url, {
    method: 'POST',
    body: JSON.stringify(workspaceName ? { task, workspaceName } : { task }),
  });
}

export function listSessions(): Promise<{ sessions: HostSession[] }> {
  return jsonFetch('/sessions', { cache: 'no-store' });
}

export function listSessionRuns(sessionId: string): Promise<{ runs: HostRun[] }> {
  return jsonFetch(`/sessions/${sessionId}/runs`, { cache: 'no-store' });
}

export function getWorkspace(): Promise<{ workspace: WorkspaceView | null }> {
  return jsonFetch('/workspace', { cache: 'no-store' });
}

export function openWorkspace(): Promise<{ workspace: WorkspaceView | null; cancelled: boolean }> {
  return jsonFetch('/workspace/open', { method: 'POST', cache: 'no-store' });
}

export function renameWorkspace(fromName: string, toName: string): Promise<{ updated: number }> {
  return jsonFetch('/workspace/rename', { method: 'POST', body: JSON.stringify({ fromName, toName }) });
}

export function renameSession(sessionId: string, title: string): Promise<{ updatedAt: string }> {
  return jsonFetch(`/sessions/${sessionId}`, { method: 'PATCH', body: JSON.stringify({ title }) });
}

export function archiveSession(sessionId: string): Promise<{ archived: number; updatedAt: string }> {
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

export function readFile(runId: string, filePath: string): Promise<{ runId: string; name: string; content: string }> {
  return jsonFetch(`/runs/${runId}/files/${encodeURIComponent(filePath)}`);
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
    'run_started', 'run_stopping', 'run_completed', 'run_failed', 'run_stopped', 'run_interrupted',
    'assistant_delta', 'reasoning_delta',
    'llm_call', 'tool_call', 'tool_call_invalid', 'tool_result', 'tool_result_invalid',
    'tool_error', 'final_answer', 'context_trim', 'context_usage', 'recovery_decision',
    'side_effect_skip', 'side_effect_uncertain', 'tool_output_truncated',
    'shell_sandbox_started', 'shell_sandbox_denied',
    'scratchpad_update', 'error',
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

  es.onopen = () => { connectedOnce = true; failedAttempts = 0; onConnect?.(); };
  es.onerror = () => {
    // 一旦服务器返回非 200（例如 404/502/握手失败），EventSource 会按 retry:3000 自动重连。
    // 若连续多次连不上，通常就是永久失败（run 不存在、Host 挂了、反代挂了），主动关掉避免 Network 里一直重连。
    if (!connectedOnce) failedAttempts += 1;
    if (failedAttempts >= MAX_FAILS_BEFORE_CLOSE) {
      console.warn(`[SSE] 连续 ${failedAttempts} 次连接失败，关闭 EventSource 以避免无限重连（runId=${runId}）`);
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

export function updateModel(id: string, input: UpdateModelProviderInput): Promise<ModelProviderView> {
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
export function fetchAvailableModels(input: { providerId: string }): Promise<{ models: string[] }> {
  return jsonFetch('/settings/available-models', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// 新增 Provider 时的临时预检：用表单中的 baseUrl + apiKey 拉取模型目录。
// 凭证不落盘、不进日志、不回显；由 Host 走 /settings/available-models/preview（需鉴权、协议白名单）。
export function previewAvailableModels(input: { baseUrl: string; apiKey: string }): Promise<{ models: string[] }> {
  return jsonFetch('/settings/available-models/preview', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
