// 模块: Prompt 命令 —— 工作区 .payaso/prompts/*.md 的扫描、frontmatter 解析与参数插值。
//
// 为什么单独存在：RunManager 里混着「产品层状态管理」与「Prompt 文件纯函数解析」
// 两类职责。本模块是纯函数、零状态，扫描与插值规则有唯一 owner；RunManager 只
// 保留注册表查询（listPromptCommands）与创建 Run 时的展开调用。

import fs from 'node:fs';
import path from 'node:path';

export interface PromptCommand {
  name: string;
  description: string;
  template: string;
  argumentHint?: string;
}

export function scanPromptCommands(workspaceRoot: string, permissionMode: string): PromptCommand[] {
  if (permissionMode === 'read-only') return [];
  const promptsDir = path.join(workspaceRoot, '.payaso', 'prompts');
  let files: string[];
  try {
    files = fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
  const commands: PromptCommand[] = [];
  for (const name of files) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
    try {
      const filePath = path.join(promptsDir, `${name}.md`);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > 64 * 1024) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const fm = parsePromptFrontmatter(content);
      const body = stripFrontmatter(content);
      commands.push({
        name: fm.name || name,
        description: fm.description || '',
        template: body.trim(),
        ...(fm.argumentHint ? { argumentHint: fm.argumentHint } : {}),
      });
    } catch {
      /* 单个命令损坏不影响整体 */
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

function parsePromptFrontmatter(content: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  const block = content.slice(4, end);
  const result: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return {
    name: result.name,
    description: result.description,
    argumentHint: result['argument-hint'],
  };
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end < 0) return content;
  const markerEnd = content.indexOf('\n', end + 4);
  return markerEnd < 0 ? '' : content.slice(markerEnd + 1);
}

// 参数插值：支持 $1 $2 ... / $@ / ${1:-default}
function interpolatePrompt(template: string, args: string[]): string {
  return template.replace(
    /\$\{(\d+):-([^}]*)\}|\$(\d+)|\$@/g,
    (match, withDefault, fallback, plain) => {
      if (match === '$@') return args.join(' ');
      return args[Number(withDefault ?? plain) - 1] ?? fallback ?? '';
    },
  );
}

// 展开 /cmd 命令：匹配成功返回展开后的 user message，失败返回 null。
export function expandPromptCommand(task: string, commands: PromptCommand[]): string | null {
  if (!task.startsWith('/')) return null;
  const firstLine = task.split('\n')[0];
  const parts = firstLine.trim().split(/\s+/);
  const cmdName = parts[0].slice(1);
  const args = parts.slice(1);
  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) return null;
  const body = task.slice(firstLine.length + 1); // 去掉第一行后的内容（追加到 $@ 尾部更灵活——这里直接追加到模板末尾）
  const expanded = interpolatePrompt(cmd.template, args) + (body ? `\n${body}` : '');
  return expanded.trim();
}
