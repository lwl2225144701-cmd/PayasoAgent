// 预览面板的标签状态机（对齐 DSH 右侧面板的标签条形态）。
//
// 标签身份分两类（文件标签不在这里 —— Word/PDF 等由 App 层 tabsApi 持有，
// Timeline 点文件也要往同一个集合里塞）：
//   - 'home'    "开始"标签：面板首页（入口卡片）。＋ 新建的就是它；
//   - 'browser' "文件"标签：一棵独立的目录树（各自记住浏览位置/过滤词）。
//
// 交互序列（用户真机截图三步，docs/plans/preview-module-plan.md §9）：
//   ① 面板打开            → 空标签集；strip 显示"开始"入口（无胶囊/无 ×/无 ＋）；
//   ② 点"工作区文件"卡片  → 激活中的"开始"标签转成"文件"标签（没有就新建一个）；
//   ③ 点 ＋               → 新建一个"开始"标签并激活（新标签默认落在开始页）。
// 关掉最后一个标签 → 空集（回到 ① 的首页占位）。
//
// 为什么单独一个纯模块：标签的增删/激活迁移/命名要能脱离 React 单测
// （tests/frontend-preview-registry.test.ts）；组件只消费这里的状态机。

export type DockTabKind = 'home' | 'browser';

export interface DockTab {
  id: number;
  kind: DockTabKind;
}

export interface DockTabs {
  tabs: DockTab[];
  activeId: number | null;
}

/** 初始状态：空（面板打开即首页占位，没有任何真标签）。 */
export function initialDockTabs(): DockTabs {
  return { tabs: [], activeId: null };
}

function nextId(tabs: DockTab[]): number {
  return tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;
}

function appendTab(tabs: DockTabs, kind: DockTabKind): DockTabs {
  const id = nextId(tabs.tabs);
  return { tabs: [...tabs.tabs, { id, kind }], activeId: id };
}

/**
 * 首页"工作区文件"卡片：把当前激活的"开始"标签**转成**"文件"标签
 * （同一页签内导航 —— strip 上"开始"消失，对齐截图 ②）；
 * 没有激活的"开始"标签（空态 / 已经在文件标签上）就新建一个"文件"标签。
 */
export function openFilesTab(tabs: DockTabs): DockTabs {
  if (tabs.activeId !== null) {
    const active = tabs.tabs.find((tab) => tab.id === tabs.activeId);
    if (active && active.kind === 'home') {
      return {
        tabs: tabs.tabs.map((tab) => (tab.id === active.id ? { ...tab, kind: 'browser' } : tab)),
        activeId: tabs.activeId,
      };
    }
  }
  return appendTab(tabs, 'browser');
}

/** ＋：新建一个"开始"标签并激活（新标签默认落在开始页，对齐截图 ③）。 */
export function addStartTab(tabs: DockTabs): DockTabs {
  return appendTab(tabs, 'home');
}

/**
 * 关闭一个标签。
 * - 关的是激活标签 → 激活迁移到右邻，没有右邻则左邻（与编辑器习惯一致）；
 * - 关掉最后一个 → 空集 + activeId null（组件回落到首页占位）。
 */
export function closeDockTab(tabs: DockTabs, id: number): DockTabs {
  const index = tabs.tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return tabs;
  const rest = tabs.tabs.filter((tab) => tab.id !== id);
  if (rest.length === 0) return { tabs: [], activeId: null };
  if (tabs.activeId !== id) return { tabs: rest, activeId: tabs.activeId };
  const neighbor = rest[Math.min(index, rest.length - 1)];
  return { tabs: rest, activeId: neighbor.id };
}

/** 第 ordinal 个"文件"标签的显示名：首个叫「文件」，之后「文件 2」「文件 3」…… */
export function browserTabLabel(
  ordinal: number,
): { key: 'preview.dock.filesTab' } | { key: 'preview.dock.filesTabN'; n: number } {
  return ordinal === 0
    ? { key: 'preview.dock.filesTab' }
    : { key: 'preview.dock.filesTabN', n: ordinal + 1 };
}
