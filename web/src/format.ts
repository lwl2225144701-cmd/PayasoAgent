import type { HostEvent, HostRun } from './types';

export function formatTime(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return '';
  }
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}毫秒`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}秒`;
  const min = Math.floor(sec / 60);
  return `${min}分${Math.round(sec - min * 60)}秒`;
}

export function stripThinkTags(text: string): { visible: string; thinking: string | null } {
  const thinkMatch = text.match(/<think[^>]*>([\s\S]*?)<\/think>/i);
  if (!thinkMatch) return { visible: text.trim(), thinking: null };
  const thinking = thinkMatch[1].trim();
  const visible = text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  return { visible, thinking: thinking || null };
}

export function previewArgs(args: unknown): string {
  if (args && typeof args === 'object') {
    const vals = Object.values(args as Record<string, unknown>)
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
    if (vals.length > 0) {
      const first = String(vals[0]).replace(/\s+/g, ' ').trim();
      return first.length > 80 ? `${first.slice(0, 80)}...` : first;
    }
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export interface RunStats {
  steps: number;
  tools: number;
  durationMs: number;
  endedAt: string | null;
  running: boolean;
}

export function computeRunStats(run: HostRun, events: HostEvent[]): RunStats {
  const steps = events.filter(e => e.type === 'llm_call').length;
  const tools = events.filter(e => e.type === 'tool_call').length;
  const startEv = events.find(e => e.type === 'run_started');
  const endEv = events.find(
    e => e.type === 'run_completed' || e.type === 'run_failed' || e.type === 'run_stopped',
  );
  const startMs = new Date(startEv?.timestamp ?? run.createdAt).getTime();
  const endMs = endEv ? new Date(endEv.timestamp).getTime() : Date.now();
  return {
    steps,
    tools,
    durationMs: Math.max(0, endMs - startMs),
    endedAt: endEv?.timestamp ?? null,
    running: !endEv && run.status === 'running',
  };
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}...${text.slice(-half)}`;
}

// ===== Run status 中文 =====
export const RUN_STATUS_LABELS: Record<HostRun['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export const TOOL_STATUS_LABELS: Record<'running' | 'completed' | 'failed', string> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
};

// ===== Tool → 中文产品化描述 =====
// 动词 + 目标：readFile → 读取，listDir → 检查，exec/run → 执行…
function actionVerb(tool: string): string {
  const t = tool.toLowerCase();
  if (t.includes('read')) return '读取';
  if (t.includes('write') || t.includes('save')) return '写入';
  if (t.includes('list') || t.includes('ls') || t.includes('dir') || t.includes('glob')) return '检查';
  if (t.includes('stat') || t.includes('exists')) return '检查';
  if (t.includes('download') || t.includes('fetch') || t.includes('get') || t.includes('request')) return '获取';
  if (t.includes('exec') || t.includes('run') || t.includes('shell') || t.includes('command') || t.includes('bash') || t.includes('sql')) return '执行';
  if (t.includes('query') || t.includes('select') || t.includes('db') || t.includes('database')) return '查询';
  if (t.includes('calculate') || t.includes('calc') || t.includes('compute')) return '计算';
  if (t.includes('summarize') || t.includes('summary') || /^sum_/.test(t)) return '总结';
  if (t.includes('search')) return '搜索';
  if (t.includes('extract') || t.includes('parse')) return '解析';
  if (t.includes('chart') || t.includes('plot') || t.includes('graph') || t.includes('draw') || t.includes('render')) return '生成图表';
  if (t.includes('mkdir') || t.includes('mk') || t.includes('create') || t.includes('new')) return '创建';
  if (t.includes('delete') || t.includes('remove') || t.includes('rm') || t.includes('unlink')) return '删除';
  if (t.includes('copy') || t.includes('cp')) return '复制';
  if (t.includes('move') || t.includes('mv') || t.includes('rename')) return '移动';
  if (t.includes('convert') || t.includes('trans')) return '转换';
  return '调用';
}

/**
 * 将工具名 + args 转化为用户可理解的产品化单行描述。
 * 例：readFile + {path: 'input/big.txt'} → "读取 input/big.txt"
 */
export function describeTool(tool: string, args: unknown): string {
  const verb = actionVerb(tool);
  const target = extractTarget(args);
  if (target) return `${verb} ${target}`;
  return `${verb} ${tool}`;
}

/**
 * 从 args 对象里提取"目标资源"字符串，优先取有意义的 key。
 */
function extractTarget(args: unknown): string | null {
  if (args == null || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const candidates = [
    'path', 'file', 'filename', 'filepath', 'dir', 'directory', 'folder', 'target',
    'url', 'uri', 'endpoint', 'query', 'sql', 'command', 'cmd', 'script', 'shell', 'expression', 'expr',
    'name', 'title', 'input', 'source', 'dest', 'dst', 'output',
    'task', 'question', 'prompt', 'text', 'content',
  ];
  for (const k of candidates) {
    for (const key of Object.keys(a)) {
      if (key.toLowerCase() === k) {
        const v = a[key];
        if (typeof v === 'string' || typeof v === 'number') {
          const s = String(v).replace(/\s+/g, ' ').trim();
          if (!s) continue;
          return s.length > 60 ? `${s.slice(0, 60)}…` : s;
        }
      }
    }
  }
  // 回退：取第一个字符串/数字值
  const first = Object.values(a).find((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  if (first == null) return null;
  const s = String(first).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/**
 * 根据"这一步已经完成的工具调用"推断思考状态文案。
 * 例：已完成 readFile → "正在检查文件…"
 * 还没任何工具 → "正在分析任务…"
 * 有过 query/exec → "正在处理数据…"
 */
export function reasoningStatusLine(events: HostEvent[], upToStep?: number): string {
  const relevant = events.filter((e): e is HostEvent & { step?: number } => {
    if (!('type' in e)) return false;
    if (upToStep != null && typeof (e as { step?: number }).step === 'number') {
      if ((e as { step: number }).step > upToStep) return false;
    }
    return e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'tool_error';
  });
  if (relevant.length === 0) return '正在分析任务…';
  const lastTool = [...relevant].reverse().find(e => 'tool' in e)?.tool ?? '';
  const hasFile = relevant.some(e => 'tool' in e && /file|dir|read|write|ls|list|path/i.test(e.tool ?? ''));
  const hasDb = relevant.some(e => 'tool' in e && /sql|db|query|database|select/i.test(e.tool ?? ''));
  const hasExec = relevant.some(e => 'tool' in e && /exec|run|shell|command|bash/i.test(e.tool ?? ''));
  if (hasDb) return lastTool ? `正在${actionVerb(lastTool)}数据…` : '正在查询数据…';
  if (hasExec) return lastTool ? `正在${actionVerb(lastTool)}命令…` : '正在执行命令…';
  if (hasFile) return lastTool ? `正在${actionVerb(lastTool)}文件…` : '正在检查文件…';
  return lastTool ? `正在${actionVerb(lastTool)}…` : '正在处理…';
}

/**
 * 检查一段 visible 文本是否与 final_answer 的内容高度相似（用于去重）。
 * 简单做法：比较 normalized 后的前 60 字符重合度。
 */
export function isDuplicateOfFinal(visible: string, finalContent: string | null): boolean {
  if (!finalContent) return false;
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/[，。,.!?！？、]/g, '').slice(0, 80);
  const a = norm(visible);
  const b = norm(finalContent);
  if (!a || !b) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}
