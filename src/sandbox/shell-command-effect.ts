// Module: Shell Command Effect — decide, per command, whether a Shell call is
// read-only or may mutate state.
//
// Why this module exists (v1.9):
// `shell` is declared `non_idempotent` as a whole, so the side-effect guard
// replayed the *cached* result for an identical command: running `git status`
// twice in one run returned the first output, and a re-run of `npm test` after
// a fix reported the old failure. The classification is deliberately
// conservative — only commands that are structurally incapable of writing are
// read-only; everything else keeps the full non-idempotent protection.
//
// Conservative rules (all must hold to be read-only):
//   1. no shell composition/redirection metacharacter (; | & > < ` $( newline)
//   2. the first token's basename is on the read-only allowlist
//   3. command-specific arg restrictions (git subcommands, find -exec/-delete)
// A false "mutating" verdict only costs a cache replay (safe); a false
// "read-only" verdict could re-run a side effect (unsafe), so ambiguity always
// resolves to non_idempotent.

export type ShellCommandEffect = 'read' | 'non_idempotent';

export interface ShellCommandClassification {
  effect: ShellCommandEffect;
  reason: string;
}

/** Commands whose plain invocation only reads and prints. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'nl',
  'cut',
  'tr',
  'sort',
  'uniq',
  'column',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'echo',
  'date',
  'whoami',
  'id',
  'uname',
  'hostname',
  'printenv',
  'which',
  'type',
  'command',
  'grep',
  'rg',
  'find',
  'git',
]);

/** git subcommands that never write to the repository. */
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'rev-parse',
  'rev-list',
  'describe',
  'ls-files',
  'ls-tree',
  'cat-file',
  'show-ref',
  'for-each-ref',
  'merge-base',
  'name-rev',
  'whatchanged',
  'reflog',
  'count-objects',
  'fsck',
  'grep',
  'cherry',
]);

/** find flags that turn a read-only walk into an arbitrary executor/writer. */
const FIND_MUTATING_FLAGS: ReadonlySet<string> = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fls',
  '-fprintf',
]);

/** Composition/redirection characters that make a command unanalyzable here. */
const SHELL_METACHARACTER = /[;|&<>`\n\r]|\$\(/;

/** git global flags that may precede the subcommand. */
const GIT_GLOBAL_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '--git-dir',
  '--work-tree',
]);

function basename(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] || token;
}

function splitTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function classifyGit(args: string[]): ShellCommandClassification {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  if (subcommand === undefined) {
    return { effect: 'non_idempotent', reason: 'bare git invocation may mutate state' };
  }
  if (subcommand === 'config') {
    const flags = args.slice(index + 1);
    const readsOnly = flags.some((flag) =>
      ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(flag),
    );
    return readsOnly
      ? { effect: 'read', reason: 'git config read-only query' }
      : { effect: 'non_idempotent', reason: 'git config without a read-only flag may write' };
  }
  return GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)
    ? { effect: 'read', reason: `git ${subcommand} is read-only` }
    : { effect: 'non_idempotent', reason: `git ${subcommand} may mutate state` };
}

function classifyFind(args: string[]): ShellCommandClassification {
  const mutating = args.find((token) => FIND_MUTATING_FLAGS.has(token));
  return mutating === undefined
    ? { effect: 'read', reason: 'find without an executor/writer flag' }
    : { effect: 'non_idempotent', reason: `find ${mutating} can execute or write` };
}

/**
 * Classify one Shell command string. Pure and deterministic; the same command
 * always yields the same effect.
 */
export function classifyShellCommand(command: string): ShellCommandClassification {
  if (SHELL_METACHARACTER.test(command)) {
    return {
      effect: 'non_idempotent',
      reason: 'command composes or redirects shell operators; effect cannot be proven',
    };
  }
  const tokens = splitTokens(command);
  if (tokens.length === 0) {
    return { effect: 'non_idempotent', reason: 'empty command' };
  }
  const program = basename(tokens[0]);
  if (!READ_ONLY_COMMANDS.has(program)) {
    return { effect: 'non_idempotent', reason: `"${program}" is not on the read-only allowlist` };
  }
  const args = tokens.slice(1);
  if (program === 'git') return classifyGit(args);
  if (program === 'find') return classifyFind(args);
  return { effect: 'read', reason: `${program} is read-only` };
}
