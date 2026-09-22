# PayasoAgent 改造思路（v1.8 → v1.10）

> 本文档记录 2026-09 期间从 `dba4101`（改造前基线）到 `0ed4fe4`（最新 commit）
> 这一整段改造的**思路与取舍**：当时为什么觉得 agent 笨、我们判断了哪些根因、
> 按什么原则改、每一层怎么动、用了哪些设计手法、测试怎么守住。
> 它不是代码清单（代码以 `src/` 为准），而是"为什么要这么改"的复盘。
>
> 范围：`dba4101..0ed4fe4`，14 个 commit，52 个文件，+5115 / −486。
> 现状基线见 `architecture-current.md`（机器契约锚点）。

---

## 0. 起点：不是模型笨，是 harness 把模型往下压

最初的直觉是"这个 agent 笨笨的"。我们把 `.data/payaso.db` 里 91 个 run、
474 次工具调用的完整 trace 拉出来和源码对了一遍，结论是：**问题不在模型，
而在模型视图与错误处理这几条边界上**。以下每一条都有 DB 证据：

| 现象 | 证据 |
| --- | --- |
| 空回答被当成"完成" | 81 个 completed 里有 4 个 `result` 为空字符串（模型只输出了 reasoning） |
| read 结果被腰斩 | 66/256 次 read 被 16KB guard 砍成"前 6KB + 后 4KB"，中间整段消失；读过文件的 40 个 run 里 24 个中招 |
| 确定性错误重试 3 次 | 12 个错误组里 10 组把同一个错误重复执行三次（ENOENT、offset 越界） |
| 输出上限被钉死 | 除 MiniMax-M3 外所有模型 `max_tokens` 都是 fallback 4096（DB 实测 step-3.7-flash 256K 窗口 → maxOutput 4096） |
| read-only 下 shell 全废 | 9 次 shell 拒绝全部集中在 read-only 的 run；"帮我跑通测试"注定失败 |
| 测试是假绿 | `grep-tools` / `edit-tools` 的 runner 不 await 异步用例，断言失败也照样 PASS |

**核心判断**：这些是**确定性缺陷**（同样的输入必然同样的错误），不是概率性的
"模型偶尔不听话"。概率性问题只能降方差，确定性缺陷可以根治——而根治的前提是
先给"根治"下定义：**让这类失败从"可能发生"变成"不可能发生，且有测试守住"**，
而不是"这次跑对了"。

---

## 1. 改造总原则

1. **内核定不变量，Harness 定话术**（依赖倒置）
   Runtime 只负责"绝不静默完成空回答"这类硬约束；"用什么话术提示模型继续"、
   "允许恢复几次"由 Harness 策略提供（`AgentContextHarness.emptyTurnPolicy()`）。
   换一个 Harness 实现不改变内核语义。

2. **单一来源（Single Source of Truth）**
   工具输出预算、shell 超时、文件发现 ignore 规则、项目指令/技能发现链，
   全部收敛到一个模块，所有消费方共用。**宣称契约 == 执行契约**——
   read 曾经自述"超过 64KB 截断"，运行时却在 16KB 砍，两条线一分裂就出 bug。

3. **错误方向选对才叫根治**
   错误重试分类：**默认不重试、白名单瞬时错误**。反过来做（默认重试、黑名单
   永久错误）就是无穷打补丁——新错误类型追不完。未知错误自动落在安全侧。

4. **依赖方向恒定**
   共享策略放 `src/` 根（如 `tool-output-budget.ts`），Runtime → tools → leaf；
   Host → Runtime。测试同样遵循：注册表对执行器是"端口注入"，不感知沙箱。

5. **宁可多一次往返，不执行错一次**
   参数不符声明 schema、命令可能是写操作、畸形 JSON——统统 fail 到可恢复的
   错误回传，让模型修正，而不是静默放过。

---

## 2. 分层改造

### 2.1 内核不变量（`src/runtime` / `src/harness`）

- **空回合不变量**：无 tool_calls 且 content 为空 → 按 Harness 策略有界恢复
  （默认 2 次），用尽抛 `AgentEmptyAnswerError`，**绝不 `completed` 空结果**。
  之前那个"你没做完呀？"的 run 就是这个洞。
- **工具参数契约**：`tools/tool-arguments.ts` 按声明 schema 校验未知/缺失/类型/
  枚举，违规回传 `INVALID_ARGUMENT_SHAPE`。未知参数不再被静默丢弃——模型以为
  传了 `timeout` 就延长了超时，实际被忽略且毫无反馈。
- **错误分类**：`tool-error-classifier.ts` 规则链（Chain of Responsibility），
  默认不重试、白名单瞬时错误；确定性错误只执行一次。

### 2.2 shell 执行环境（`src/sandbox`）

- **受管 scratch**：read-only 下 HOME/TMPDIR 指向沙箱外受管临时目录（0700、
  用完即删），工作区保持只读——`npm/npx/git` 缓存可写，不再连 `git log` 都被拒。
- **可配置超时**：默认 120s / 上限 600s / env 可配 / 模型可用 `timeoutMs` 请求
  并被收敛。
- **动态 effect**：`Tool.resolveEffect(args)` 策略钩子——shell 整体是
  non_idempotent，但只读命令（`git log`、`ls`、`find` 无 `-exec`）effect=read，
  不再被副作用守卫回放缓存；写命令保留三态保护。

### 2.3 工具层（`src/tools`）

- **read 行感知分页**：与 Runtime guard 同一份预算（`tool-output-budget.ts`），
  保留整行首尾 + 精确的中间续读区间；窗口之后仍有内容时两条提示并存。
- **grep 正则 + ignore**：共用 `workspace-scan.ts` 的 walker 与 ignore 策略
  （默认跳过 node_modules/.git/dist），搜索阈值 64KB → 8MB。
- **glob**：按模式找文件（mtime 倒序），模型不用再靠 shell 的 find。
- **loadSkill / 项目指令发现链**：`workspace-instructions.ts` 按
  PAYASO.md → AGENTS.md → CLAUDE.md 合并（来源标题 + 软链去重 + 总量上限）；
  skills 兼容 `.payaso` / `.claude` / `.pi` 三个目录。

### 2.4 模型配置（`src/harness/model-context.ts` + web）

- **输出预留按窗口推导**：窗口 × 8%，夹在 4K–32K，替换固定 4096。
- **设置页可配置 maxOutputTokens**：原来 UI 只存 contextWindow，输出上限根本没
  法配置（前端只读不写回）。

### 2.5 上下文与效率

- **scratchpad 瘦身**：去掉每步 1000 字符的结果和 lastResult（实测 6.3K
  token/请求），只保留进度/失败/无效/下一步等行为信号（20 步 × 1000 字符结果
  仍 < 1.5K token）。结果由 transcript 承载，压缩时由摘要（Tool results 段）
  兜底。

### 2.6 正确性

- **原生适配器畸形参数恢复**：pi-ai 的原生适配器（Anthropic/Google…）只暴露
  已解析对象，畸形 JSON 被解成 `{}` → 静默执行空参数。`llm/tool-call-arguments.ts`
  从 `toolcall_delta` 累积模型原文，只在"解码为空对象且原文非 {}"时接管，交给
  Runtime 统一解析。

### 2.7 能力：后台长任务通道

- `shell {background:true}` 立即返回 jobId，`shellJob` 查询/取回/终止；
- 执行器端口注入（注册表不感知沙箱）；并发上限、输出预算、Run 取消联动、
  `RunManager.finalizeRun` 终态回收——完成的 Run 不留孤儿进程。

---

## 3. 用到的设计手法

| 手法 | 用在哪 | 为什么 |
| --- | --- | --- |
| 单一来源 | `tool-output-budget.ts`、`shell-timeout.ts`、`workspace-scan.ts`、`workspace-instructions.ts` | 多消费方不会漂移；宣称契约 == 执行契约 |
| 端口注入（Port/Adapter） | `background-jobs` 的 executor、Harness 的 `emptyTurnPolicy`、`AgentContextHarness` | 测试注入假实现即可全覆盖，生产接真实现 |
| 策略钩子（Strategy） | `Tool.resolveEffect`（动态副作用类别） | 调用级语义（只读/写）不该被工具级静态声明锁死 |
| 责任链（Chain of Responsibility） | `tool-error-classifier` 规则列表 | 新错误类型 = 追加一条规则，不改核心 |
| 依赖倒置 | Runtime 定不变量、Harness 定话术 | 内核语义与实现细节解耦 |
| 能力条件测试（capability-conditional） | os-sandbox / shell-execution / keychain | 环境不可用（如嵌套沙箱）时如实 SKIP，而不是假绿 |

---

## 4. 测试策略

1. **确定性套件为主**：`npm run test:all` 从 51 → **62** 套件，全部无 LLM、
   子进程隔离、秒级。
2. **共享 mock 运行器**：`tests/helpers/mock-runner.ts` 脚本化 mock LLM +
   请求体捕获，多个集成套件共用，不再复制 transport 装配。
3. **契约测试**：`docs-contract` 锁定"工具清单 / Trace 事件"与文档 JSON 一致；
   新增工具或事件不同步文档 → 红。
4. **修掉假绿 runner**：`grep-tools` / `edit-tools` 的 runner 不 await 异步用例，
   断言永远不会失败——比没有测试更危险。改后暴露出 5 个真实问题，全部修正。
5. **真机 E2E 条件执行**：sandbox-exec 相关套件在能力可用时跑完整遏制矩阵 +
   read-only scratch + 后台作业；不可用（如 DSH 嵌套沙箱）时跳过并如实说明。

---

## 5. 与 pi agent 学习的关联

本项目借鉴 `@earendil-works/pi-ai`（pi 的 LLM 层）。本次改造中从 pi 及其生态
吸收的思路（仅参考，未照搬）：

- **抽象与依赖方向**：pi 的 agent-harness 用 Port/Adapter 隔离工具与执行器
  （`ExecutionToolContext`、文件系统走 env 端口），本改造在 background-jobs、
  Harness 策略上采用了同样的"端口注入"手法。
- **可测性优先**：pi 的测试大量用脚本化假传输/假 env，本改造的
  `mock-runner.ts` 与之同思路。
- **保留自身边界**：payaso 没有照抄 pi 的 TypeBox schema 体系，继续用手写
  JSON Schema + 自研校验，避免引入不必要依赖。

> 注：pi 仓库本身在 `~` 目录之外由用户另行维护，本文档只记录对本项目有指导
> 意义的思路，不作为 pi 的实现文档。

---

## 6. 遗留与后续方向（按优先级）

| 项 | 类型 | 说明 |
| --- | --- | --- |
| web search / fetch | 能力 | agent 目前无法获取外部信息 |
| 后台作业流式输出 | 能力 | 现在是完成后一次性取回，未做 streaming 输出 |
| 多路径 grep / 文件监听 | 能力 | grep 目前单路径；无 watcher |
| 增量上下文（delta） | 能力 | 上下文预算已按轮管理，未做真正增量续写 |

这些是产品能力扩展，不是缺陷修复；是否做、优先级如何，由产品决策，不在本次
"根治缺陷"范围内。

---

## 7. 如何让本文档不漂移

- 本文档描述的是**思路**，不是接口契约；接口契约以 `docs/architecture-current.md`
  的机器契约块为准。
- 新增/删除工具或 Trace 事件必须同步 `architecture-current.md` 的
  `docs-contract:tools` / `docs-contract:events`，否则 `tests/docs-contract` 红。
- 改造涉及不变量时，遵循 `architecture-current.md §4.1.1` 的表格：每行不变量
  必须对应一个守住它的确定性测试。
