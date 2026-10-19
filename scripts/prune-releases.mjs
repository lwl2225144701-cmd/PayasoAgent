#!/usr/bin/env node
// 清理 GitHub 历史 Release 与对应 tag，只保留最近 N 个版本。
//
// 为什么存在：桌面端发版节奏快（一天数版），每版 DMG/zip/exe 加起来约 800MiB，
// 旧 Release 既占 Releases 页也占仓库存储配额；而用户侧升级只依赖「最新 Release 的
// feed」（latest-mac.yml / latest.yml），历史版本没有留存价值 —— 发版记录本身留在
// git tag 与 docs/plans 手账里，不依赖 Release 页。
//
// 契约：
// - 规划（dry-run）可不带 token；`--yes` 真正删除时必须带 GITHUB_TOKEN，
//   因为匿名 API 既没有写权限、也看不到草稿 Release（删不干净）。
// - 永远保留被标记为 latest 的 Release：electron-updater 的 feed 挂在它上面。
// - 永远保留 Casks/payasoagent.rb 锁定的版本：Homebrew 通道指向它。
// - 删 tag 前校验目标提交是默认分支的祖先，否则跳过（除非 --force），
//   避免 tag 一删提交变成没人引用的孤儿。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_REPO = 'lwl2225144701-cmd/PayasoAgent';
const DEFAULT_BRANCH = 'main';

const USAGE = `用法：
  node scripts/prune-releases.mjs [--keep 4] [--yes] [--force] [--prune-local]
                                   [--include-non-release-tags] [--repo owner/name]

  默认 dry-run：只盘点并打印删除计划，不动远端。
  --yes                        真正删除（必须提供 GITHUB_TOKEN）。
  --keep N                     保留最近 N 个版本，默认 4。
  --force                      目标提交不在默认分支祖先链上也强制删 tag。
  --prune-local                远端 tag 删掉后，同步删掉本地同名 tag。
  --include-non-release-tags   连「没有对应 Release」的历史 tag（v2.2.0 /
                               v1.0.0-local-mvp）一起删；默认保留。
  环境变量：GITHUB_TOKEN（或 GH_TOKEN）、GITHUB_REPOSITORY。
`;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    keep: 4,
    dryRun: true,
    force: false,
    pruneLocal: false,
    includeNonReleaseTags: false,
    repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPO,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === '--yes' || arg === '-y') {
      opts.dryRun = false;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--prune-local') {
      opts.pruneLocal = true;
    } else if (arg === '--include-non-release-tags') {
      opts.includeNonReleaseTags = true;
    } else if (arg === '--keep') {
      opts.keep = Number(argv[(i += 1)]);
    } else if (arg === '--repo') {
      opts.repo = argv[(i += 1)];
    } else {
      fail(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) fail(`--keep 必须是正整数，收到：${opts.keep}`);
  return opts;
}

/** 语义版本拆解；认不出形状的返回 null（排序时垫底，优先被清掉）。 */
function parseSemver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** 新的在前；预发布排在同名正式版之前（0.4.16-rc1 视为比 0.4.15 旧）。 */
function compareTagDesc(a, b) {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa && sb) {
    if (sa.major !== sb.major) return sb.major - sa.major;
    if (sa.minor !== sb.minor) return sb.minor - sa.minor;
    if (sa.patch !== sb.patch) return sb.patch - sa.patch;
    if (sa.pre && !sb.pre) return 1;
    if (!sa.pre && sb.pre) return -1;
    if (sa.pre && sb.pre) return sa.pre < sb.pre ? 1 : -1;
    return 0;
  }
  if (sa) return -1;
  if (sb) return 1;
  return a < b ? 1 : -1;
}

async function api(method, path, { token, body } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'payaso-agent-release-prune',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining === '0' && res.status === 403) {
    const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    const waitMs = Math.max(0, reset - Date.now()) + 2000;
    throw new Error(`GitHub API 配额用尽，${Math.round(waitMs / 1000)}s 后重置（认证请求是 5000 次/小时）`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留 text 兜底 */
  }
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) {
    const detail = json?.message ?? text.slice(0, 200);
    throw new Error(`GitHub API ${method} ${path} → ${res.status} ${detail}`);
  }
  return { status: res.status, body: json };
}

async function listAll(path, token) {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const { body } = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, { token });
    if (!Array.isArray(body) || body.length === 0) break;
    out.push(...body);
    if (body.length < 100) break;
  }
  return out;
}

/** Homebrew cask 钉住的版本，删了 brew 装不了。 */
function caskTag() {
  try {
    const text = readFileSync('Casks/payasoagent.rb', 'utf8');
    const m = /^\s*version\s+"([^"]+)"/m.exec(text);
    return m ? `v${m[1]}` : null;
  } catch {
    return null;
  }
}

function localTagCommit(tag) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function isAncestorOf(commit, branch) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, branch], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!opts.dryRun && !token) {
    fail('真正删除必须提供 GITHUB_TOKEN（或 GH_TOKEN）：\n  GITHUB_TOKEN=ghp_xxx node scripts/prune-releases.mjs --yes\n不带 token 先跑一次 dry-run 看计划。');
  }
  if (!token) {
    console.log('⚠ 未提供 token：匿名盘点只能看到「已发布」Release，草稿 Release 不在清单里。');
  }

  const releases = await listAll(`/repos/${opts.repo}/releases`, token);
  if (releases.length === 0) fail(`仓库 ${opts.repo} 一个 Release 都没读到，检查 --repo 与 token。`);
  const remoteTags = await listAll(`/repos/${opts.repo}/tags`, token);

  const latest = await api('GET', `/repos/${opts.repo}/releases/latest`, { token });
  const latestTag = latest.status === 200 ? latest.body?.tag_name ?? null : null;
  const pinned = caskTag();

  const sorted = [...releases].sort((a, b) => compareTagDesc(a.tag_name, b.tag_name));
  const keepTags = new Set(sorted.slice(0, opts.keep).map((r) => r.tag_name));
  if (latestTag) keepTags.add(latestTag); // updater feed 所在，绝不删
  if (pinned) keepTags.add(pinned); // Homebrew 通道，绝不删

  const doomed = sorted.filter((r) => !keepTags.has(r.tag_name));
  const releaseTags = new Set(releases.map((r) => r.tag_name));
  const orphanTags = remoteTags
    .map((t) => t.name)
    .filter((t) => !releaseTags.has(t) && !keepTags.has(t))
    .sort(compareTagDesc);

  const width = Math.max(...sorted.map((r) => r.tag_name.length), 8);
  const rows = sorted.map((r) => {
    const bytes = (r.assets ?? []).reduce((sum, a) => sum + (a.size ?? 0), 0);
    const kind = r.draft ? '草稿' : '已发布';
    const action = keepTags.has(r.tag_name) ? '保留' : '删除';
    return {
      tag: r.tag_name,
      kind,
      assets: (r.assets ?? []).length,
      bytes,
      action,
    };
  });

  console.log(`\n仓库：${opts.repo}（共 ${releases.length} 个 Release、${remoteTags.length} 个 tag）`);
  console.log(`保留 ${opts.keep} 个最新版本${latestTag ? ` + latest(${latestTag})` : ''}${pinned ? ` + cask(${pinned})` : ''}`);
  console.log(`\n${'版本'.padEnd(width)}  类型    资产   体积      动作`);
  for (const row of rows) {
    console.log(
      `${row.tag.padEnd(width)}  ${row.kind}   ${String(row.assets).padStart(2)}    ${gib(row.bytes).padStart(8)}  ${row.action}`,
    );
  }

  const doomedBytes = doomed.reduce((sum, r) => sum + (r.assets ?? []).reduce((s, a) => s + (a.size ?? 0), 0), 0);
  console.log(
    `\n计划：删除 ${doomed.length} 个 Release（释放约 ${gib(doomedBytes)}）` +
      `${orphanTags.length > 0 ? `；另有 ${orphanTags.length} 个无 Release 的 tag：${orphanTags.join(' ')}` : ''}`,
  );
  if (opts.includeNonReleaseTags) console.log('（--include-non-release-tags：上面那批 tag 也删）');

  if (opts.dryRun) {
    console.log('\ndry-run 结束，远端未做任何改动。确认计划后加 --yes 执行。');
    return;
  }

  let failures = 0;
  for (const release of doomed) {
    const { id } = release;
    try {
      await api('DELETE', `/repos/${opts.repo}/releases/${id}`, { token });
      console.log(`✓ 删除 Release ${release.tag_name}`);
    } catch (error) {
      failures += 1;
      console.error(`✗ 删除 Release ${release.tag_name} 失败：${error.message}`);
      continue; // Release 没删掉就不动它的 tag，避免只掉一半
    }
    const commit = localTagCommit(release.tag_name);
    if (commit && !isAncestorOf(commit, DEFAULT_BRANCH) && !opts.force) {
      failures += 1;
      console.error(`✗ 跳过 tag ${release.tag_name}：提交 ${commit.slice(0, 8)} 不在 ${DEFAULT_BRANCH} 祖先链上（--force 可强删）`);
      continue;
    }
    try {
      const res = await api('DELETE', `/repos/${opts.repo}/git/refs/tags/${release.tag_name}`, { token });
      if (res.status === 404) {
        console.log(`· tag ${release.tag_name} 远端不存在（草稿 Release 本来就没 tag），跳过`);
      } else {
        console.log(`✓ 删除 tag ${release.tag_name}`);
        if (opts.pruneLocal) {
          try {
            execFileSync('git', ['tag', '-d', release.tag_name], { stdio: 'ignore' });
            console.log(`✓ 删除本地 tag ${release.tag_name}`);
          } catch {
            console.error(`✗ 删除本地 tag ${release.tag_name} 失败`);
          }
        }
      }
    } catch (error) {
      failures += 1;
      console.error(`✗ 删除 tag ${release.tag_name} 失败：${error.message}`);
    }
  }

  if (opts.includeNonReleaseTags) {
    for (const tag of orphanTags) {
      const commit = localTagCommit(tag);
      if (commit && !isAncestorOf(commit, DEFAULT_BRANCH) && !opts.force) {
        failures += 1;
        console.error(`✗ 跳过 tag ${tag}：提交 ${commit.slice(0, 8)} 不在 ${DEFAULT_BRANCH} 祖先链上`);
        continue;
      }
      try {
        await api('DELETE', `/repos/${opts.repo}/git/refs/tags/${tag}`, { token });
        console.log(`✓ 删除 tag ${tag}（无对应 Release）`);
      } catch (error) {
        failures += 1;
        console.error(`✗ 删除 tag ${tag} 失败：${error.message}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n完成，但有 ${failures} 处失败，请逐条重试。`);
    process.exit(1);
  }
  console.log(`\n完成：剩 ${keepTags.size} 个版本（${[...keepTags].sort(compareTagDesc).join(' ')}）。`);
  console.log('本机同步：git fetch --prune-tags origin（或 --prune-local 已代劳）。');
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
