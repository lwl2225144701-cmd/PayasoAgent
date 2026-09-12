// Module: Workspace Instructions — discover the project-level guidance and
// skill registry a repository actually provides.
//
// Why this module exists (v1.9):
// Only `PAYASO.md` and `.payaso/skills/` were recognized. Repositories that use
// the industry conventions (`AGENTS.md`, `CLAUDE.md`, `.claude/skills`) got no
// project guidance at all: the agent behaved as if it had never seen the
// repo's build/test/commit rules. This module owns one discovery policy for
// both, so host bootstrap and the `loadSkill` tool cannot disagree.
//
// Contract:
// - Priority-ordered, first wins; a file reached through a symlink to an
//   already-loaded file is skipped (no double injection).
// - Read-only mode loads nothing (same gate as before).
// - Every read is best-effort: a broken file degrades to "not loaded" and never
//   blocks Run creation.

import fs from 'node:fs';
import path from 'node:path';
import {
  isValidWorkspaceSkillName,
  MAX_SKILL_FILE_BYTES,
  resolveSkillRelativePath,
  SKILL_DIRS,
} from '../tools/workspace-skill-path.js';

export { MAX_SKILL_FILE_BYTES, resolveSkillRelativePath, SKILL_DIRS };

/** Project instruction files, highest priority first. */
export const PROJECT_INSTRUCTION_FILES = ['PAYASO.md', 'AGENTS.md', 'CLAUDE.md'] as const;

/** Per-file and total caps; the instruction segment is budgeted separately. */
export const MAX_INSTRUCTION_FILE_BYTES = 32 * 1024;
export const MAX_INSTRUCTION_TOTAL_BYTES = 32 * 1024;

export interface LoadedInstructionFile {
  /** File name as found in the workspace, e.g. `AGENTS.md`. */
  source: string;
  content: string;
}

/**
 * Read every recognized project instruction file in priority order.
 * The returned content is already merged (each file prefixed with its name) so
 * the model can tell which convention a rule comes from.
 */
export function loadProjectInstructionFiles(
  workspaceRoot: string,
  permissionMode: string,
): LoadedInstructionFile[] {
  if (permissionMode === 'read-only') return [];
  const loaded: LoadedInstructionFile[] = [];
  const seenRealPaths = new Set<string>();
  let totalBytes = 0;

  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    if (totalBytes >= MAX_INSTRUCTION_TOTAL_BYTES) break;
    const filePath = path.join(workspaceRoot, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_INSTRUCTION_FILE_BYTES) continue;
    // 去重：CLAUDE.md 常是 AGENTS.md 的软链，重复注入只会浪费上下文。
    let realPath: string;
    try {
      realPath = fs.realpathSync.native(filePath);
    } catch {
      continue;
    }
    if (seenRealPaths.has(realPath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    if (content.trim().length === 0) continue;
    seenRealPaths.add(realPath);
    totalBytes += Buffer.byteLength(content, 'utf8');
    loaded.push({ source: fileName, content });
  }
  return loaded;
}

/**
 * Merged project instructions for the system prompt. Empty string when the
 * workspace provides none. Each source keeps a heading so rules stay
 * attributable.
 */
export function readProjectInstructions(workspaceRoot: string, permissionMode: string): string {
  const files = loadProjectInstructionFiles(workspaceRoot, permissionMode);
  if (files.length === 0) return '';
  if (files.length === 1) return files[0].content.trim();
  return files.map((file) => `## ${file.source}\n\n${file.content.trim()}`).join('\n\n---\n\n');
}

export interface SkillManifest {
  name: string;
  description: string;
  /** Directory the skill was found in, for diagnostics/tests. */
  sourceDir: string;
}

/**
 * Scan every recognized skill directory. A skill name defined in a
 * higher-priority directory shadows the same name elsewhere.
 */
export function scanWorkspaceSkills(
  workspaceRoot: string,
  permissionMode: string,
): SkillManifest[] {
  if (permissionMode === 'read-only') return [];
  const manifests: SkillManifest[] = [];
  const seenNames = new Set<string>();

  for (const dir of SKILL_DIRS) {
    const skillsDir = path.join(workspaceRoot, dir);
    let entries: string[];
    try {
      entries = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const skillDir of entries) {
      if (!isValidWorkspaceSkillName(skillDir)) continue;
      try {
        const filePath = path.join(skillsDir, skillDir, 'SKILL.md');
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const frontmatter = parseSkillFrontmatter(content);
        const name = frontmatter.name || skillDir;
        if (seenNames.has(name)) continue;
        seenNames.add(name);
        manifests.push({ name, description: frontmatter.description || '', sourceDir: dir });
      } catch {
        /* 单个 skill 损坏不影响整体 */
      }
    }
  }
  return manifests;
}

/** 极简 frontmatter 解析：只认 name / description / version，未知字段忽略（fail-closed）。 */
export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  version?: string;
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
  return { name: result.name, description: result.description, version: result.version };
}
