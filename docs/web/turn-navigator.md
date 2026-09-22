# TurnNavigator（回合导航 Rail）实现方案

> **状态**：已实现（2026-09 提交）
> **对标参考**：`packages/client/ui-chat/src/client/chat/TurnNavigator.tsx` —— 贴右缘的竖向导航条，每条横线 = 一个已加载的 Turn（对话回合），最亮最长的那条 = 当前正在阅读的 Turn。
> **前提**：用户已通过截图（170x416px 右缘窄条：4 条短灰线 + 1 条长亮线）确认目标形态，并溯源到参考实现。

## 1. 定位与纠偏

本项目曾将截图误解为「Agent 工具步骤进度指示器」（由 `scratchpad.completedSteps` 驱动）。经溯源参考实现后确认：

- **它不是**：工具步骤进度（工具数会持续增长，无「当前阅读」语义）
- **它是**：会话回合（Turn）导航条 —— 每条线 = 一个已加载回合，点击跳转、hover 预览、当前阅读回合加长加亮

本项目中的「回合」= **Run**（`turnIndex` 语义与参考实现的 Turn 一致）。

## 2. 数据来源映射

| 参考实现 | 本项目对应 | 现状 |
| --- | --- | --- |
| `navigation.items()`（已加载回合列表） | `currentSessionRuns`（`App.tsx:191`，当前会话全部 run，按 `turnIndex` 升序） | ✅ 已有 |
| `activeTurn`（当前阅读回合） | `currentRunId` | ✅ 已有 |
| `navigateToTurn`（点击导航） | 目前无「切换查看历史 run」交互 | ❌ 需新增 |
| `preview`（hover 弹 prompt + 摘要） | run 的 `task`（首条 prompt）+ `result`（回复摘要） | ✅ 数据有，UI 无 |

**关键缺口**：App 当前只能在会话内查看最新 run（`handleSelectSession` 默认选 `turnIndex` 最大者）。历史 run 已渲染在 Timeline 中，但没有 rail 快速跳转入口。TurnNavigator 补此缺口。

## 3. 组件设计

新建 `web/src/components/TurnNavigator/index.tsx` + `TurnNavigator.module.css`。

### 3.1 Props

```ts
interface TurnNavigatorProps {
  runs: HostRun[];                 // 当前会话全部 run（turnIndex 升序）
  activeRunId: string | null;      // 当前阅读的 run
  onNavigate: (runId: string) => void;
}
```

### 3.2 渲染与定位（对标参考实现）

```
.slot  { position: sticky; top: 0; height: 0; z-index: 6; pointer-events: none; }
        /* 不占滚动高度，飘在右 gutter 上 */
.rail  {
  position: absolute;
  top: 50%; transform: translateY(-50%);   /* 可视带内垂直居中 */
  right: 12px;                              /* 贴滚动窗口右缘 */
  width: 28px;
  max-height: 420px;                        /* 上限，多了压缩 */
  cursor: pointer; pointer-events: auto;    /* 整列可点 */
}
@media (max-width: 900px) { .rail { display: none; } }   /* 窄屏隐藏 */
```

自然高度 = `(count-1) × 10px + 2 × 6px`（每条 mark 间距 10px + 上下内边距），与 420px 取 min。

### 3.3 每条横线（mark）

```css
.mark::before {                 /* 静止 tick：12px × 2px 圆角细线 */
  width: 12px; height: 2px;
  border-radius: 999px;
  background: var(--ds-alias-border-l4, rgba(255,255,255,0.10));
}
.markPreview::before { width: 18px; background: var(--ds-alias-label-tertiary, rgba(255,255,255,0.45)); }
.markActive::before  { width: 20px; background: var(--ds-alias-label-primary, #fff); }
```

- 静止 = 历史回合（短灰）
- hover/focus = 预览（中灰加长）
- active = 当前阅读回合（长亮白）

### 3.4 交互

| 交互 | 行为 |
| --- | --- |
| 点击/滑动 rail | `itemAtPointer` 按 y 比例映射到最近 item → `onNavigate(runId)` → 滚动到该 run 的 Timeline，更新 activeRunId |
| hover / 键盘聚焦 | `previewTurn` → tooltip（离条 10px，约 300px 宽）：run.task 2 行 + run.result 摘要 2 行 |
| 键盘 | mark 可聚焦，focus 时 tick 品牌色 + 1px ring |

细节：`mark` 按钮本身 `pointer-events: none`（rail 独占整列指针输入，mark 仅作键盘目的地）。

### 3.5 Memo 前提

`memo(TurnNavigator)`，前提是 props 引用稳定：

- `currentSessionRuns`：由 `runs` state 派生，切换 run 时不变
- `onNavigate`：App 层用 `useCallback` 包住（新闭包会毁掉 memo）
- `activeRunId`：仅点击导航或会话切换时变化

不 memo 的后果：Timeline 流式 delta 每 commit 重渲染 → 长会话为每个回合重建 host 元素。

## 4. App.tsx 接线

```tsx
// 1. 导航回调（useCallback 包住，保证 memo 生效）
const handleNavigateRun = useCallback((runId: string) => {
  setCurrentRunId(runId);
  document.getElementById(`run-${runId}`)?.scrollIntoView({ behavior: 'smooth' });
}, []);

// 2. 渲染位置：main 区域右缘（在 Sidebar 之后、InputBar 之前）
{currentSessionId && (
  <TurnNavigator
    runs={currentSessionRuns}
    activeRunId={currentRunId}
    onNavigate={handleNavigateRun}
  />
)}
```

## 5. 需要微调

1. **Timeline 滚动锚点**：Timeline 外层加 `id={`run-${runId}`}`，供 `scrollIntoView` 定位。
2. **run 数量上限**：`runs.length > 10` 时自然高度压缩（与 420px 取 min），mark 间距自适应 `flex` 排布或按比例缩小间距。
3. **活跃状态**：`activeRunId` 对应 run 的 mark 加亮；点击后主动更新。
4. **空/单 run**：`runs.length <= 1` 时不渲染（导航无意义）。

## 6. 文件清单

| 文件 | 动作 |
| --- | --- |
| `web/src/components/TurnNavigator/index.tsx` | 新建（组件 + memo） |
| `web/src/components/TurnNavigator/TurnNavigator.module.css` | 新建（样式） |
| `web/src/App.tsx` | 加 `handleNavigateRun` + 渲染 `<TurnNavigator />` |
| `web/src/components/Timeline/index.tsx` | 外层加 `id={`run-${runId}`}` 锚点 |

**无需改动**：后端、api.ts、types.ts、useEventStream（数据全部现成）。

## 7. 与 Scratchpad 指示器的关系

本方案**取代**先前基于 `scratchpad.completedSteps` 的「垂直步骤指示器」方向（含 RightPanel 空目录预留及 A/B 接线方案）——那是对截图的误读。项目现有 `web/src/components/RightPanel/` 为空目录（无 git 历史、无引用），实现时可直接删除或将 TurnNavigator 放入，避免遗留误导性空目录。
