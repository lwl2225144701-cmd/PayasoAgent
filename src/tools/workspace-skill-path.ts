import fs from 'node:fs';
import path from 'node:path';

/** Skill registry directories, highest priority first. */
export const SKILL_DIRS = ['.payaso/skills', '.claude/skills', '.pi/skills'] as const;

export const MAX_SKILL_FILE_BYTES = 64 * 1024;

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidWorkspaceSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/** Workspace-relative path of a skill's SKILL.md, or null when it does not exist. */
export function resolveSkillRelativePath(workspaceRoot: string, name: string): string | null {
  if (!isValidWorkspaceSkillName(name)) return null;
  for (const dir of SKILL_DIRS) {
    const relPath = path.posix.join(dir, name, 'SKILL.md');
    try {
      if (fs.statSync(path.join(workspaceRoot, relPath)).isFile()) return relPath;
    } catch {
      /* try next directory */
    }
  }
  return null;
}
