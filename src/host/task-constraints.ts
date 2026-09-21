// Host 负责用户约束校验、来源版本固定和证据投影；Runtime 不解析文档。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { scopedPath } from '../sandbox/write-scope.js';
import type { TaskConstraints, TaskConstraintsInput } from '../task-constraints.js';

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 240)) {
    throw new Error('约束列表格式不正确');
  }
  const result = value.map(v => v.trim());
  if (new Set(result).size !== result.length) throw new Error('约束列表不能重复');
  return result;
}

export function parseTaskConstraints(value: unknown): TaskConstraintsInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务约束格式不正确');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(k => k !== 'writeScope' && k !== 'evidence')) throw new Error('未知任务约束');
  const result: TaskConstraintsInput = {};
  if (raw.writeScope !== undefined) result.writeScope = strings(raw.writeScope, 32);
  if (raw.evidence !== undefined) {
    const e = raw.evidence as Record<string, unknown>;
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some(k => k !== 'files' && k !== 'items')) throw new Error('证据模式格式不正确');
    result.evidence = { files: strings(e.files, 8), items: strings(e.items, 16) };
    if (!result.evidence.files.length || !result.evidence.items.length) throw new Error('证据模式必须指定文件和所问项目');
    if (result.writeScope?.length) throw new Error('证据模式只读，不能同时授权修改文件');
    result.writeScope = [];
  }
  return result;
}

function source(root: string, relative: string): { sha256: string; lines: string[] } {
  const file = scopedPath(root, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > 1024 * 1024) throw new Error('证据模式单个来源最大 1 MiB');
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error('证据模式仅支持 1 MiB 内 UTF-8 文本');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
    return { sha256: createHash('sha256').update(bytes).digest('hex'), lines: text.split(/\r?\n/u) };
  } finally { fs.closeSync(fd); }
}

export function prepareTaskConstraints(root: string, input: unknown): TaskConstraints | undefined {
  const parsed = parseTaskConstraints(input);
  if (!parsed) return undefined;
  parsed.writeScope?.forEach(file => scopedPath(root, file));
  return {
    ...(parsed.writeScope !== undefined ? { writeScope: [...parsed.writeScope] } : {}),
    ...(parsed.evidence ? { evidence: {
      items: [...parsed.evidence.items],
      sources: parsed.evidence.files.map(file => ({ path: file, sha256: source(root, file).sha256 })),
    } } : {}),
  };
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/\r?\n/g, '<br>');
}

export function renderEvidence(root: string, evidence: NonNullable<TaskConstraints['evidence']>, answer: string): string {
  if (answer.length > 64 * 1024) throw new Error('证据结果过长，无法验证');
  let rows: unknown;
  try { rows = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); }
  catch { throw new Error('证据结果不是有效 JSON，未发布未经验证的答复'); }
  if (!Array.isArray(rows) || rows.length !== evidence.items.length) throw new Error('证据结果缺少所问项目');
  const sources = evidence.sources.map(s => {
    const current = source(root, s.path);
    if (current.sha256 !== s.sha256) throw new Error('来源文件已变化，无法验证本轮引用，请重新提交');
    return current;
  });
  const seen = new Set<number>();
  const rendered = new Map<number, string>();
  let totalLines = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['item', 'citations'].includes(k))
      || !Number.isInteger(row.item) || row.item < 0 || row.item >= evidence.items.length || seen.has(row.item)
      || !Array.isArray(row.citations) || row.citations.length > 8) throw new Error('证据结果包含未授权项目或无效字段');
    seen.add(row.item);
    const quotes: string[] = [];
    for (const c of row.citations) {
      if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['source', 'start', 'end'].includes(k))
        || !Number.isInteger(c.source) || !sources[c.source] || !Number.isInteger(c.start) || !Number.isInteger(c.end)
        || c.start < 1 || c.end < c.start || c.end > sources[c.source].lines.length || c.end - c.start >= 40) {
        throw new Error('证据引用行号或来源无效，未发布未经验证的答复');
      }
      totalLines += c.end - c.start + 1;
      if (totalLines > 160) throw new Error('证据引用总量超过上限');
      const text = sources[c.source].lines.slice(c.start - 1, c.end).join('\n');
      if (text.length > 8000) throw new Error('证据引用过长');
      const file = evidence.sources[c.source].path;
      quotes.push(`${escape(text)}<br>— [${escape(file)}:${c.start}–${c.end}](${file.split('/').map(encodeURIComponent).join('/')})`);
    }
    rendered.set(row.item, quotes.join('<br><br>') || '未找到证据');
  }
  return ['以下为已核对文件版本和行号的原文摘录；相关性与完整性仍需结合问题判断。', '',
    '| 所问项目 | 原文与来源 |', '|---|---|',
    ...evidence.items.map((item, i) => `| ${escape(item)} | ${rendered.get(i)} |`)].join('\n');
}
