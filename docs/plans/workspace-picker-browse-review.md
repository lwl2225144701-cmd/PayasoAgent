# PayasoAgent 工作区选择方案评审

> 评审对象：`D:\app\PayasoAgent`（v1.6，LLM tool-calling agent + Host API + React Web UI）
> 问题：浏览器内点"打开/更换工作区"会弹 Windows 系统"浏览文件夹"对话框，且被浏览器窗口遮挡，需最小化浏览器才能看到
> 借鉴参考：`D:\deepseek\deepseek-harness`（dsh）的 Workspace Directory 选择实现
> 评审日期：2026-09-07 ｜ 状态：**待评审确认**

---

## 1. 结论摘要

| 项目 | 结论 |
|---|---|
| 问题性质 | **功能性缺陷 + 体验缺陷**：Host 端"网页内目录浏览"通道缺失，前端能力探测 404 后回退到系统原生对话框 |
| dsh 可否借鉴 | **可以，且 PayasoAgent 前端已按同思路写好一半**（网页 Modal + browse API 契约），只缺 Host 端点 |
| 推荐方案 | 补齐 Host 端 `capability / browse / create-directory / select` 端点，前端自动切换网页内选择器，一次性根治遮挡 |
| 预估改动 | Host ~200 行 + 前端 ~60 行（含可选 Edit path 增强） |
| 风险 | 低~中（无既有测试覆盖 browse 链路；改动集中在新增路由，不影响既有 run/session 流程） |

**一句话**：不是"换一种对话框"能解决的，根因是浏览通道半成品导致前端走了不该走的 native 兜底；正解是把已设计好的网页内选择链路接通。

---

## 2. 问题复现与根因链（代码证据）

### 2.1 现象
浏览器访问 `http://localhost:5173` → 点左下"工作区"栏的文件夹按钮 → 弹出 Windows 原生 `FolderBrowserDialog`（标题"选择 PayasoAgent Workspace"），但被浏览器窗口挡住，最小化后可见。

### 2.2 触发链路
```
用户点击 "打开文件夹"
  → web/src/App.tsx  handleOpenWorkspace()
      ├─ pickerCapability.kind === 'browse'  → 打开网页内 WorkspacePickerModal（理想路径）
      └─ else → POST /workspace/open → Host 调 PowerShell FolderBrowserDialog（实际路径）
```

### 2.3 为什么走了 else（根因）
前端在启动时探测 `GET/POST /workspace/capability`（`web/src/App.tsx:206-208`）：
- **Host 端未注册该端点**（`src/host/routes.ts` 的 workspace 分支只有 open/rename/delete/restore/purge 等，无 capability/browse/create-directory）
- 实测运行环境：`capability → 404`、`browse → 404`、`open → 400`（正常注册）
- 404 触发 `.catch()` → `setPickerCapability({ kind: 'native' })`（兜底）

于是前端所有"打开工作区"都走 native 分支 → `src/host/workspace.ts:44-128` 的 `openWorkspacePicker()`：
- Windows：`PowerShell 5.1 -STA + System.Windows.Forms.FolderBrowserDialog`
- macOS：`osascript choose folder`

这是**独立于浏览器的系统窗口**，由 Windows 焦点层级决定是否置顶 → 最大化浏览器时被遮挡，需最小化浏览器才可见。

### 2.4 前端已就位的"理想路径"
- `web/src/api.ts:104-117`：`getDirectoryPickerCapability()` / `browseDirectory(path)` / `createWorkspaceDirectory(path,name)`，返回契约 `DirectoryListing{path, home, crumbs, entries, truncated}` 已定义
- `web/src/components/WorkspacePickerModal/index.tsx`：完整网页内目录选择器（面包屑导航、双击/按钮选择、对话框内新建目录、取消）
- `web/src/App.tsx:685-694`：`pickerOpen` 时渲染该 Modal

> 结论：**browse 是"设计好、前端写好、后端没实现"的半成品**。这不是偶然的代码路径，capability 探测机制本身就是为切换两条路径设计的。

---

## 3. dsh 的处理办法（借鉴依据）

参考文件：`/d/deepseek/deepseek-harness/apps/web/tests/workspace-management.e2e.ts`

### 3.1 交互（纯网页内，无任何系统原生窗口）
```
[Add workspace] 按钮
  → 网页内 dialog "Select Workspace Directory"
      ├─ 目录列表浏览（面包屑/两栏 panes）
      ├─ [Edit path]  直接填/改绝对路径，回车跳转（可直达已知路径）
      ├─ [New folder] 在对话框内新建目录（唯一建新工作区入口）
      └─ [Open] 采纳当前目录 → workspace.create RPC 注册 + 新 Session attach
```
目录枚举由**宿主进程**（本机后端，scaffold.ctx 同级）完成，浏览器端只拿结构化目录数据，不进沙箱、不碰系统 UI。

### 3.2 可借鉴点
| # | dsh 特性 | 对 PayasoAgent 的价值 |
|---|---|---|
| 1 | 目录选择全走宿主 RPC + 网页 UI | 从机制上消灭"系统对话框被浏览器遮挡" |
| 2 | **Edit path 绝对路径直填** | 已知路径（如 `D:\app\PayasoAgent`）一键直达，不用层层点面包屑 |
| 3 | New folder 在对话框内完成 | 创建新工作区目录不离开上下文 |
| 4 | 采纳后宿主 `workspace.create`（含路径注册+会话 attach） | 语义闭环：选目录 = Host 真正切换工作区 |

### 3.3 dsh 没有做的（不需要抄）
- 它不在浏览器场景调用任何原生目录对话框（desktop 仅是加载同一 Web GUI 的 Electron 薄壳，见 `apps/desktop/src/main.ts`，无渲染逻辑）

---

## 4. 差距盘点：PayasoAgent vs dsh

| 能力 | dsh | PayasoAgent 现状 | 差距 |
|---|---|---|---|
| 网页内目录浏览 | ✅ | ✅ 前端已有 Modal；❌ Host 无 browse 端点 | 补 Host 端点 |
| 目录采纳 → 宿主切换工作区 | ✅ workspace.create 注册+attach | ❌ browse 选择后仅前端 `setWorkspace({name:path})`（App.tsx:689），未落 Host `currentWorkspace` | 需 select 端点闭环 |
| capability 探测 | — | ✅ 机制已设计；❌ 端点缺失 → 兜底 native | 补 capability 端点 |
| 路径直填 Edit path | ✅ | ❌ 仅面包屑逐层点 | 可选增强 |
| 系统原生兜底 | 无 | native（FolderBrowserDialog）被遮挡 | 改为 browse 优先，native 仅作可选项 |

---

## 5. 方案选项

### 方案 A（推荐）：接通 Host browse 通道 + 前端兜底改 browse
一次性根治，最小且完整地激活已写好的前端链路。

**Host 新增 4 个端点**（`src/host/routes.ts` workspace 分支内，复用 `checkOrigin`/`requireAuth` 与 `workspace.ts` 校验链）：
1. `POST /workspace/capability` → `{ capability: { kind: 'browse' } }`（声明本环境支持网页内浏览）
2. `POST /workspace/browse` `{ path? }` → `DirectoryListing`（目录枚举，契约见前端 api.ts）
3. `POST /workspace/create-directory` `{ path, name }` → `{ path }`（新建目录）
4. `POST /workspace/select` `{ path }` → `{ workspace }`（复用 open 的 `canonicalizeWorkspaceRoot`+exists+isDirectory+realpath 校验，写入 `currentWorkspace`，**不弹任何原生框**）

**前端微调**：
- `web/src/App.tsx` capability 探测失败时默认值由 `native` 改为 `browse`（双保险，即使探测请求异常也走网页内选择器）
- `WorkspacePickerModal` 的 `onSelect` 回调由 `setWorkspace({name:path})` 改为调用新的 `selectWorkspace(path)` API，实现 Host 真正切换

**目录枚举实现要点（browse 端点）**：
- 起始目录 = 用户 home；`path` 缺省回到 home
- 面包屑 `crumbs` 按 path 逐级拆分（对齐前端渲染）
- 过滤隐藏项；条目超过阈值（建议 500）置 `truncated:true`
- 每个被访问路径经 `realpath` 校验存在且为目录，异常路径回退 home 或返回明确错误
- 禁止遍历系统目录不在此列——工作区本来就需要任意授权目录（与 native picker 权限语义一致：用户显式选择即授权）

### 方案 B（最小止血，不推荐长期）：仅改前端兜底
capability 探测 404 时默认 `browse` → 打开网页 Modal → 但 Host 无 browse 端点 → Modal 报"无法加载目录列表"。**不可行**，除非 Modal 入口能复用现有 open（但那又弹原生框，回到原点）。结论：必须补 Host 端点，B 没有独立价值。

### 方案 C（锦上添花，建议与 A 同批做）：Edit path 路径直填
`WorkspacePickerModal` 顶部加一个路径输入框（回车即 `browseDirectory(path)` 跳转），照搬 dsh 的交互。改动 ~40 行纯前端。对"已知路径"和粘贴路径场景体验提升明显。

---

## 6. 推荐实施计划

| 步骤 | 改动 | 影响面 | 验证 |
|---|---|---|---|
| 1 | Host：新增 browse 端点（目录枚举） | 仅新增路由 | curl browse + 单元/契约测试 |
| 2 | Host：新增 capability / create-directory / select 端点 | 仅新增路由 | curl + 复用 `tests/workspace.test.ts` 风格补充 |
| 3 | 前端：onSelect 走 selectWorkspace(path) | `App.tsx` + `api.ts` | 手动点击打开/更换工作区 |
| 4 | 前端：capability 兜底改 browse | `App.tsx:208` 一处 | 重启后验证不再出现原生框 |
| 5 | 前端（可选 C）：Edit path 输入框 | WorkspacePickerModal | 填路径回车直达 |

> 前置约定（沿用项目既有要求）：**代码改动先跑测试再确认**。涉及新增路由，建议先补 `tests/workspace.test.ts` 同风格的最小契约测试再联调。

---

## 7. 风险与边界

| 风险 | 等级 | 说明 / 缓解 |
|---|---|---|
| browse 无既有测试覆盖 | 低 | 新增端点自带契约测试；不影响 run/session/沙箱既有路径 |
| capability 语义变化 | 低 | 仅影响"打开工作区"按钮路径选择，open(native) 端点保留可继续用 |
| 目录枚举性能 | 低 | 单层 readdir + 截断，不递归 |
| 符号链接/越权 | 低 | select 复用 canonicalize 校验链（realpath），browse 展示路径由用户导航产生 |
| 与"工作区=会话分组名"语义的耦合 | 中 | 需评审确认：browse 选择后是否要等价于 native picker 的"全局切换"（见决策点 D1） |
| 远程/非本机访问 Host | 低 | `checkOrigin` 已限制来源；browse 天然只在受信 Host 生效 |

---

## 8. 评审决策点（请拍板）

- **D1（语义）**：网页内选目录后，是否应等价于现有 native picker 的"切换全局工作区"（写入 `currentWorkspace`、影响后续新会话的 workspaceRoot）？还是仅作为会话级 workspaceName 选择？（推荐：前者，与 open 行为对齐）
- **D2（范围）**：本次只做 A（接通 browse+select），还是 A+C（含 Edit path）一次做完？
- **D3（native 兜底保留）**：保留 `POST /workspace/open`（系统对话框）作为可选入口，还是完全隐藏、只走 browse？（推荐保留但不作为默认）
- **D4（安全）**：目录枚举是否需要在某个根（如 home）下约束，还是与 native picker 一样允许浏览任意盘符？（推荐后者——与用户显式选择即授权的现有语义一致）

---

## 9. 附：证据文件清单

- `web/src/App.tsx:206-208`（capability 探测 404 → native 兜底）、`:554-571`（handleOpenWorkspace 分支）、`:685-694`（Modal 渲染与 onSelect）
- `web/src/api.ts:77-118`（openWorkspace / capability / browseDirectory / createWorkspaceDirectory）
- `web/src/components/WorkspacePickerModal/index.tsx`（网页内选择器完整实现）
- `src/host/routes.ts:729+`（workspace 路由分支，无 capability/browse/create-directory）
- `src/host/workspace.ts:44-128`（native picker：PowerShell FolderBrowserDialog / osascript）
- 运行时实测：`capability → 404`、`browse → 404`、`open → 400`
- dsh 参考：`apps/web/tests/workspace-management.e2e.ts`（Select Workspace Directory 网页对话框全流程）
