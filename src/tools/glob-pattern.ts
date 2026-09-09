// Module: Glob Pattern — compile a glob pattern into a RegExp over POSIX-style
// workspace-relative paths.
//
// Supported syntax (deliberately small, fully tested):
//   `*`      any run of characters except `/`
//   `?`      exactly one character except `/`
//   `**`     any number of path segments (as a whole segment)
//   `**/`    zero or more leading segments
//   `{a,b}`  alternation (no nesting)
//   `\x`     literal x
// Everything else is matched literally (regex metacharacters are escaped), so a
// pattern can never accidentally behave as a raw regex.
//
// Why not a dependency: the backend deliberately has no third-party runtime
// deps, and the subset above covers every search pattern an agent needs.

export interface CompiledGlob {
  source: string;
  regex: RegExp;
}

const REGEX_SPECIALS = /[.+^$()|[\]\\]/;

/**
 * Compile one glob pattern. Throws on an unterminated `{` group, because a
 * malformed pattern should surface as a clear tool error rather than silently
 * matching nothing.
 */
export function compileGlob(pattern: string): CompiledGlob {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  let i = 0;

  const compileSegment = (segment: string): string => {
    let out = '';
    for (let k = 0; k < segment.length; k++) {
      const char = segment[k];
      if (char === '*') out += '[^/]*';
      else if (char === '?') out += '[^/]';
      else if (REGEX_SPECIALS.test(char)) out += `\\${char}`;
      else out += char;
    }
    return out;
  };

  const readBraceGroup = (): string => {
    const start = i + 1;
    let depth = 1;
    let j = start;
    while (j < normalized.length && depth > 0) {
      if (normalized[j] === '{') depth++;
      else if (normalized[j] === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) throw new Error(`glob pattern has an unterminated "{" group: ${pattern}`);
    const body = normalized.slice(start, j);
    i = j + 1;
    const alternatives = body.split(',');
    if (alternatives.some((part) => part.includes('{'))) {
      throw new Error(`glob pattern does not support nested "{" groups: ${pattern}`);
    }
    return `(?:${alternatives.map((part) => compileSegment(part)).join('|')})`;
  };

  while (i < normalized.length) {
    const char = normalized[i];
    if (char === '*') {
      const isDouble = normalized[i + 1] === '*';
      if (isDouble) {
        const followedBySlash = normalized[i + 2] === '/';
        if (followedBySlash) {
          // `**/` = zero or more complete segments.
          source += '(?:[^/]+/)*';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
        continue;
      }
      source += '[^/]*';
      i += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      i += 1;
      continue;
    }
    if (char === '{') {
      source += readBraceGroup();
      continue;
    }
    if (char === '/') {
      source += '/';
      i += 1;
      continue;
    }
    source += REGEX_SPECIALS.test(char) ? `\\${char}` : char;
    i += 1;
  }

  return { source, regex: new RegExp(`^${source}$`) };
}

/** True when `relPath` (POSIX-style, workspace-relative) matches the pattern. */
export function matchesGlob(pattern: string, relPath: string): boolean {
  return compileGlob(pattern).regex.test(relPath.replace(/\\/g, '/').replace(/^\.\//, ''));
}
