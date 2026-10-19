// 模块: 历史任务搜索规则测试（侧栏任务列表筛选，无 LLM）。
// 用法: node --import tsx tests/task-search.test.ts （或随 npm run test:all 运行）
//
// 契约（与需求逐条对应）：
//   1. 搜索范围 = 任务标题 + 工作区名；**不搜聊天正文**（HostSession 里本来就没有正文，
//      这里用断言锁住「正文不进匹配」的边界，防止以后有人顺手把摘要/结果字段塞进来）。
//   2. 中文原样匹配；英文忽略大小写；关键词首尾空白忽略；特殊字符按普通文本（子串）处理。
//   3. 保留工作区分组：只显示命中任务及其所属分组；工作区名命中 → 该组任务全部保留。
//   4. 搜索期间命中分组自动展开（合成覆盖），用户显式覆盖优先；清空搜索后展开态
//      还原到搜索前的判定结果（不需要额外快照）。
//   5. 交互接线（DSH 式）：搜索默认不占地方，点工作区行上的放大镜才展开输入框；
//      × / Esc 收起并清空。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  filterWorkspaceGroupsForSearch,
  isTaskSearchActive,
  normalizeTaskSearchKeyword,
  resolveSearchExpansionOverrides,
  sessionMatchesTaskSearch,
} from '../web/src/components/WorkspaceSection/task-search.js';
import type { WorkspaceGroup } from '../web/src/components/WorkspaceSection/workspace-expansion.js';
import type { HostSession } from '../web/src/types.js';

// 分组名哨兵与 WorkspaceSection 一致（该文件只把它当普通字符串比较，这里复用其比较行为）
const NO_WORKSPACE = '\u0000no-workspace';

// 仓库根：本文件在 tests/ 下，与其它套件（desktop-update / frontend-native-theme）
// 用同样的相对路径读 web/src 源码做契约断言。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.log(`  [FAIL] ${name} — ${(err as Error).message}`);
  }
}

function session(sessionId: string, title: string, workspaceName?: string): HostSession {
  return {
    sessionId,
    title,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    workspace: workspaceName === undefined ? undefined : { name: workspaceName },
  };
}

function group(name: string, sessions: HostSession[]): WorkspaceGroup {
  return { name, sessions };
}

/** 取出「分组名 → 该组展示的任务 id」，便于断言分组保留与任务过滤。 */
function shape(groups: WorkspaceGroup[]): Record<string, string[]> {
  return Object.fromEntries(groups.map((g) => [g.name, g.sessions.map((s) => s.sessionId)]));
}

const WORKSPACES = [
  group('PayasoAgent', [session('s1', '修复预览面板样式'), session('s2', '更新 README 文档')]),
  group('deepseek-harness', [
    session('s3', 'Refactor budget guard'),
    session('s4', '搜索功能调研'),
  ]),
];

// ── 关键词归一化 ────────────────────────────────────────────────────────────

check('归一化：首尾空白去掉、英文转小写', () => {
  assert.equal(normalizeTaskSearchKeyword('  ReFacTor  '), 'refactor');
  assert.equal(normalizeTaskSearchKeyword('   '), '');
  assert.equal(normalizeTaskSearchKeyword(''), '');
});

check('归一化：中文不受小写化影响（无对应大小写概念）', () => {
  assert.equal(normalizeTaskSearchKeyword('  搜索  '), '搜索');
});

check('搜索激活判定：纯空白不算搜索', () => {
  assert.equal(isTaskSearchActive(''), false);
  assert.equal(isTaskSearchActive('   '), false);
  assert.equal(isTaskSearchActive('\t\n'), false);
  assert.equal(isTaskSearchActive('a'), true);
});

// ── 标题匹配 ────────────────────────────────────────────────────────────────

check('标题匹配：中文子串命中', () => {
  assert.equal(sessionMatchesTaskSearch(session('s', '修复预览面板样式'), '预览'), true);
  assert.equal(sessionMatchesTaskSearch(session('s', '修复预览面板样式'), '面板样'), true);
  assert.equal(sessionMatchesTaskSearch(session('s', '修复预览面板样式'), '样式修复'), false);
});

check('标题匹配：英文忽略大小写（标题与关键词两侧）', () => {
  const s = session('s', 'Refactor budget guard');
  assert.equal(sessionMatchesTaskSearch(s, 'refactor'), true);
  assert.equal(sessionMatchesTaskSearch(s, 'BUDGET'), true);
  assert.equal(sessionMatchesTaskSearch(s, 'ReFaCtOr bUdGeT'), true);
});

check('标题匹配：关键词首尾空白被忽略', () => {
  const s = session('s', 'Refactor budget guard');
  assert.equal(sessionMatchesTaskSearch(s, '   refactor   '), true);
  assert.equal(sessionMatchesTaskSearch(s, '\tbudget\n'), true);
});

check('标题匹配：特殊字符按普通文本（子串）处理，不报错', () => {
  assert.equal(sessionMatchesTaskSearch(session('s', 'fix (a+b)  [v2.6]'), '(a+b)'), true);
  assert.equal(sessionMatchesTaskSearch(session('s', 'fix (a+b)  [v2.6]'), '[v2.6]'), true);
  assert.equal(sessionMatchesTaskSearch(session('s', 'fix (a+b)  [v2.6]'), 'v2.6'), true);
  // 正则元字符不当作模式：'.' 只匹配字面点
  assert.equal(sessionMatchesTaskSearch(session('s', 'v2x6'), 'v2.6'), false);
  // 只有关键词本身是元字符时也不抛错，按普通子串比较
  assert.equal(sessionMatchesTaskSearch(session('s', 'a*b'), '*'), true);
  assert.equal(sessionMatchesTaskSearch(session('s', 'ab'), '*'), false);
});

check('标题匹配：空关键词不过滤任何任务', () => {
  assert.equal(sessionMatchesTaskSearch(session('s', 'anything'), ''), true);
  assert.equal(sessionMatchesTaskSearch(session('s', 'anything'), '   '), true);
});

check('标题匹配：空标题用展示文案参与匹配（未命名任务可被搜到）', () => {
  const untitled = '未命名任务';
  assert.equal(sessionMatchesTaskSearch(session('s', ''), '未命名', untitled), true);
  assert.equal(sessionMatchesTaskSearch(session('s', '   '), '未命名', untitled), true);
  // 不传展示文案时，空标题只能被空关键词命中
  assert.equal(sessionMatchesTaskSearch(session('s', ''), '未命名'), false);
});

check('搜索范围不含聊天正文：HostSession 只按标题与工作区判定', () => {
  // 正文/摘要字段若被加进 HostSession，也不会自动进入匹配——本测试锁住这条边界
  const s = session('s', '标题甲');
  assert.equal(sessionMatchesTaskSearch(s, '标题甲'), true);
  assert.equal(sessionMatchesTaskSearch(s, '正文里才有的词'), false);
});

// ── 分组过滤 ────────────────────────────────────────────────────────────────

check('标题命中只留命中任务，分组顺序不变', () => {
  const { groups, matchedSessionCount } = filterWorkspaceGroupsForSearch(WORKSPACES, 'refactor');
  assert.deepEqual(shape(groups), { 'deepseek-harness': ['s3'] });
  assert.equal(matchedSessionCount, 1);
});

check('跨分组标题命中：两个分组都保留，各自只留命中任务', () => {
  // 关键词只命中标题、不命中任何分组名（分组名命中会走「整组保留」另一条规则）
  const cross = [
    group('Alpha', [session('a1', 'Write docs'), session('a2', 'Other thing')]),
    group('Beta', [session('b1', 'Read the docs'), session('b2', 'Another thing')]),
  ];
  const { groups, matchedSessionCount } = filterWorkspaceGroupsForSearch(cross, 'docs');
  assert.deepEqual(shape(groups), { Alpha: ['a1'], Beta: ['b1'] });
  assert.equal(matchedSessionCount, 2);
});

check('分组名命中与标题命中是两条独立规则：分组名含关键词时整组保留', () => {
  // 回归锁定：关键词 'e' 同时命中 'PayasoAgent' 与 'deepseek-harness' 两个分组名，
  // 于是两组任务全部保留 —— 这不是漏过滤，是「工作区名命中」规则的预期结果。
  const { groups, matchedSessionCount } = filterWorkspaceGroupsForSearch(WORKSPACES, 'e');
  assert.deepEqual(shape(groups), shape(WORKSPACES));
  assert.equal(matchedSessionCount, 4);
});

check('工作区名命中 → 该分组任务全部保留', () => {
  const { groups, matchedSessionCount } = filterWorkspaceGroupsForSearch(WORKSPACES, 'payaso');
  assert.deepEqual(shape(groups), { PayasoAgent: ['s1', 's2'] });
  assert.equal(matchedSessionCount, 2);
});

check('工作区名命中用展示文案比较（哨兵分组翻成「未选择工作区」）', () => {
  const withSentinel = [
    ...WORKSPACES,
    group(NO_WORKSPACE, [session('s5', '某个任务'), session('s6', '另一个任务')]),
  ];
  const { groups } = filterWorkspaceGroupsForSearch(withSentinel, '未选择工作区', {
    groupDisplayName: (name) => (name === NO_WORKSPACE ? '未选择工作区' : name),
  });
  assert.deepEqual(shape(groups), { [NO_WORKSPACE]: ['s5', 's6'] });
  // 不传 groupDisplayName 时哨兵名本身不可被用户搜索到（内部标识不该外泄）
  const raw = filterWorkspaceGroupsForSearch(withSentinel, '未选择工作区');
  assert.equal(raw.groups.length, 0);
});

check('零命中的分组整组不显示', () => {
  const { groups } = filterWorkspaceGroupsForSearch(WORKSPACES, 'zzz-no-such-task');
  assert.equal(groups.length, 0);
});

check('空关键词返回全部分组（不过滤）', () => {
  for (const keyword of ['', '   ', '\t']) {
    const { groups, matchedSessionCount } = filterWorkspaceGroupsForSearch(WORKSPACES, keyword);
    assert.deepEqual(shape(groups), shape(WORKSPACES));
    assert.equal(matchedSessionCount, 4);
  }
});

check('空分组列表：有关键词时零结果，无关键词时仍为空', () => {
  assert.deepEqual(filterWorkspaceGroupsForSearch([], 'anything').groups, []);
  assert.deepEqual(filterWorkspaceGroupsForSearch([], '').groups, []);
});

check('匹配任务在分组内保持原有相对顺序', () => {
  const many = group('w', [
    session('a', '任务 甲 备份'),
    session('b', '任务 乙'),
    session('c', '任务 甲 主'),
  ]);
  const { groups } = filterWorkspaceGroupsForSearch([many], '任务 甲');
  assert.deepEqual(
    groups[0]?.sessions.map((s) => s.sessionId),
    ['a', 'c'],
  );
});

// ── 搜索期间的分组展开与恢复 ────────────────────────────────────────────────

check('搜索期间命中分组自动展开（用户没手动过）', () => {
  const overrides = resolveSearchExpansionOverrides({
    searchActive: true,
    visibleGroups: [group('a', [session('s', 'x')]), group('b', [session('s2', 'y')])],
    userOverrides: new Map(),
  });
  assert.deepEqual(
    [...overrides.entries()],
    [
      ['a', true],
      ['b', true],
    ],
  );
});

check('搜索期间用户显式覆盖优先（手动收起后不被弹回）', () => {
  const overrides = resolveSearchExpansionOverrides({
    searchActive: true,
    visibleGroups: [group('a', [session('s', 'x')])],
    userOverrides: new Map([['a', false]]),
  });
  assert.equal(overrides.get('a'), false);
});

check('未搜索时原样返回用户覆盖（= 搜索前的展开态，无需额外快照）', () => {
  const user = new Map([['a', false]]);
  const overrides = resolveSearchExpansionOverrides({
    searchActive: false,
    visibleGroups: [group('a', [session('s', 'x')])],
    userOverrides: user,
  });
  assert.equal(overrides, user, '未搜索时必须交出同一份用户记录，展开态回到既有判定');
});

check('搜索期间被过滤掉的分组不进入覆盖表', () => {
  const overrides = resolveSearchExpansionOverrides({
    searchActive: true,
    visibleGroups: [group('a', [session('s', 'x')])],
    userOverrides: new Map(),
  });
  assert.equal(overrides.has('b'), false);
});

// ── 需求 7：重命名 / 归档后搜索结果及时更新 ─────────────────────────────────
//
// 过滤是 sessions 的纯投影：App 的乐观更新（重命名改 title、归档移除会话）改的是同一份
// 数据源，搜索结果随重算自然更新 —— 不需要缓存失效逻辑。这里直接验证「换一份 sessions
// 得到新结果」。
check('数据源变化即重新筛选：重命名后旧词失配、新词命中', () => {
  const before = [session('s1', '旧标题')];
  assert.deepEqual(shape(filterWorkspaceGroupsForSearch([group('w', before)], '旧标题').groups), {
    w: ['s1'],
  });
  // App.handleRenameSession 的乐观更新形态：同 sessionId，title 换掉
  const renamed = before.map((s) => ({ ...s, title: '新标题' }));
  assert.deepEqual(filterWorkspaceGroupsForSearch([group('w', renamed)], '旧标题').groups, []);
  assert.deepEqual(shape(filterWorkspaceGroupsForSearch([group('w', renamed)], '新标题').groups), {
    w: ['s1'],
  });
});

check('数据源变化即重新筛选：归档后从搜索结果中消失', () => {
  const archived = [session('s1', '要归档的任务'), session('s2', '保留的任务')];
  const before = filterWorkspaceGroupsForSearch([group('w', archived)], '任务');
  assert.deepEqual(shape(before.groups), { w: ['s1', 's2'] });
  // App.handleArchiveSession 的乐观更新形态：整条移除
  const after = archived.filter((s) => s.sessionId !== 's1');
  assert.deepEqual(shape(filterWorkspaceGroupsForSearch([group('w', after)], '任务').groups), {
    w: ['s2'],
  });
});

check('归档到整组为空时该分组消失', () => {
  const only = [session('s1', '仅此一条')];
  assert.deepEqual(shape(filterWorkspaceGroupsForSearch([group('w', only)], '仅此').groups), {
    w: ['s1'],
  });
  assert.deepEqual(filterWorkspaceGroupsForSearch([group('w', [])], '仅此').groups, []);
});

// ── 需求 1/4/6：交互接线契约（DSH 式「点放大镜展开」）────────────────────────
//
// 筛选规则是纯函数，交互在组件里。没有浏览器/jsdom 可用，这里沿用仓库既有的
// 「读源码 + 断言」契约风格（同 desktop-update / frontend-native-theme），把关键接线
// 钉住：搜索入口在工作区行、标题行与搜索条叠放互斥、收起时关键词一并清空。

check('接线：搜索条与标题行叠放（展开时原地覆盖，不插入新行）', () => {
  const section = readSource('web', 'src', 'components', 'WorkspaceSection', 'index.tsx');
  // size={15} 的花括号必须转义：不转义的话 {15} 会被当成「前一个字符重复 15 次」
  assert.match(section, /<SearchIcon size=\{15\} \/>/, '工作区行要有放大镜入口');
  assert.match(section, /aria-expanded=\{searchOpen\}/, '开关要向读屏软件暴露展开态');
  assert.match(section, /className=\{styles\.headerSlot\}/, '标题行与搜索条要共用叠放槽位');
  // 叠放互斥由 data-search-open 驱动（CSS 里 .header[data-search-open='true'] 选择器）
  assert.match(
    section,
    /data-search-open=\{searchOpen \? 'true' : 'false'\}/,
    '头部要暴露叠放状态',
  );
});

check('接线：搜索条常驻 DOM，收起态隐藏且退出 Tab 顺序', () => {
  const section = readSource('web', 'src', 'components', 'WorkspaceSection', 'index.tsx');
  // **不能**改成 {searchOpen && ...} 条件渲染：那样收起动画没有起始帧，只能硬切。
  assert.ok(
    !/\{searchOpen && \(/.test(section),
    '搜索条不许按 searchOpen 条件渲染（否则收起无法过渡）',
  );
  // **不能**用 hidden 属性 / display:none：元素一旦离开渲染树，收起动画就没有起始帧，
  // 只能硬切。而且 .searchBar 写了 display:flex，会覆盖 UA 的 [hidden]{display:none}，
  // 这个属性要么无效、要么在优先级变化时突然生效把动画打断 —— 两种都是坑。
  // 断言要排除 aria-hidden=（那是要保留的无障碍属性）：\b 在 '-' 与 'h' 之间也算
  // 词边界，用 (?<![-\w]) 反向排除才准。
  assert.ok(!/(?<![-\w])hidden=/.test(section), '搜索条不许用 hidden 属性（会让收起动画硬切）');
  assert.match(section, /aria-hidden=\{!searchOpen\}/, '收起态要对读屏软件隐藏');
  // 收起态不能占 Tab：hidden 通常已足够，但 input/button 显式 -1 更稳
  const tabIndexCount = section.match(/tabIndex=\{searchOpen \? undefined : -1\}/g) ?? [];
  assert.equal(tabIndexCount.length, 2, '输入框与 × 按钮都要在收起态退出 Tab 顺序');
});

check('接线：叠放与动画的 CSS 契约（scaleX 从左伸展，全局 reduce 已覆盖）', () => {
  const css = readSource(
    'web',
    'src',
    'components',
    'WorkspaceSection',
    'WorkspaceSection.module.css',
  );
  // 两层必须占同一网格单元，否则"覆盖"变成"上下两行"
  assert.match(css, /\.headerSlot > \*\s*\{[^}]*grid-area: 1 \/ 1/, '两层要叠在同一网格单元');
  // transform-origin 设左侧：少了它 scaleX 是"原地放大"而非"伸展"
  assert.match(css, /transform-origin: left center/, '搜索条要从左往右伸展');
  assert.match(css, /transform: scaleX\(0\.7\)/, '收起态要有收缩帧');
  assert.match(css, /transition:[^;]*visibility[^;]*;/, 'visibility 要参与过渡（避免中途消失）');
  // 全局 index.css 已用 !important 压 transition-duration，这里只需确认没人删它
  const global = readSource('web', 'src', 'index.css');
  assert.match(global, /transition-duration: 0\.01ms !important/, '全局 reduce 规则必须保留');
});

check('接线：收起 = 关键词一并清空（不会「框没了但列表还筛着」）', () => {
  const section = readSource('web', 'src', 'components', 'WorkspaceSection', 'index.tsx');
  assert.match(
    section,
    /const closeSearch = useCallback\(\(\) => \{[\s\S]*?setSearchOpen\(false\);[\s\S]*?setSearchKeyword\(''\);/,
    'closeSearch 要同时收起并清空',
  );
  assert.match(section, /onClick=\{closeSearch\}/, '× 按钮要调 closeSearch');
});

check('接线：侧栏不再自带常驻搜索框（避免两份入口）', () => {
  const sidebar = readSource('web', 'src', 'components', 'Sidebar', 'index.tsx');
  assert.ok(!/<input\b/.test(sidebar), 'Sidebar 不该再渲染输入框');
  assert.ok(!/searchKeyword/.test(sidebar), 'Sidebar 不该再持有搜索关键词');
  assert.ok(!/SearchIcon/.test(sidebar), '搜索入口已迁到 WorkspaceSection');
});

check('接线：中英文案齐全（占位符、无结果提示、开关 tooltip）', () => {
  const messages = readSource('web', 'src', 'i18n', 'messages', 'shell.ts');
  for (const key of ['shell.search.toggle', 'shell.search.placeholder', 'shell.search.noResults']) {
    assert.ok(messages.includes(`'${key}'`), `缺 i18n key: ${key}`);
    // 条目窗口：从 key 取到条目收尾的「},\n」。不能用 [^}]* 之类的正则按 } 切 ——
    // 文案本身带 {keyword} 占位符，第一个 } 就把条目截断了；这里改用字符串查找，
    // 也避开正则转义在编辑链路里被吃掉的坑。
    const start = messages.indexOf(`'${key}':`);
    assert.ok(start >= 0, `缺 i18n key: ${key}`);
    const end = messages.indexOf('},\n', start);
    const entry = messages.slice(start, end === -1 ? start + 400 : end);
    assert.ok(entry.includes("'zh-CN':"), `${key} 缺中文案`);
    assert.ok(entry.includes("'en-US':"), `${key} 缺英文案`);
  }
});

console.log(`\nTask search tests: ${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
