# Agent 执行效率优化计划

日期：2026-10-20  
状态：**A/B/C/D/E 批次已实施并通过确定性套件；提速收益未验证（批次 F 需真实任务对照）。**  
源码核对基线：`d87eceb`。  
分析对象：Run `937bb6d0-c17b-448e-9d27-bd8c92a7d056`，任务为实现侧栏历史任务搜索并完成相关验证。

## 1. 目标与结论

本次优化聚焦 Agent 自身的执行机制：减少反复探索、重复验证，以及工具失败后的绕路。模型调用区间占比较高，只说明时间记在哪里，不能据此把慢的原因全部归到模型侧。

三个改造重点：

1. **推进任务**：Harness 根据实际进展管理调查与实施，减少已经具备行动条件之后的反复确认。
2. **可信验证与结果复用**：工具产生可信检查状态，Runtime 保存事实，Harness 使用仍然有效的结论。
3. **工具能力与恢复**：完善大文件定点编辑、临时目录使用和编辑错误恢复，减少临时寻找替代方法的回合。

收益关注重点是减少无效往返；实施时先补可信结果和事实记录，再接进度判断。现阶段不承诺将 42 分钟缩短到 22–25 分钟，也不将未验证的节省时间相加作为收益结论。

本次仅新增计划与文档索引；后续代码实施属于独立工作。

> 实施状态（2026-10-20 晚）：A（edit 上限/错误码/TMPDIR 指引）、B（check 工具＋facts 协议＋
> 完整日志采集）、C（执行证据存储/恢复/复用/身份）、D（Biome 适配＋HEAD 基线比较）、
> E（事实观察＋进度闭环 progress-watch）已落地并有确定性套件覆盖
> （`check-tool` / `execution-evidence` / `check-baseline` / `progress-watch`）。
> 仍未闭环的项：真实任务行为与性能对照（批次 F 的收益测量）、真实 Biome 二进制输出核验、
> 跨平台进程用例（Windows ACL 仅验证 argv 分发）。不要把"计划全部 completed"当收益证据。

## 2. 本轮已核实的数据

Run 时间：2026-10-19 14:58:59.340 至 15:41:23.614（北京时间）。原始依据为本机 `~/.payaso/payaso.db` 中该 Run 的事件、工具参数、结果和最终回答。

| 项目 | 数据 | 解释 |
| --- | --- | --- |
| 总耗时 | 42分24.274秒 | Run 开始到结束 |
| 模型调用 | 81 次 | 不等于工具调用次数 |
| 首条流式事件之后的生成区间 | 33分23.217秒，约78.7% | 包含思考、回复与工具参数生成，不等于写文件 |
| 等待首条流式事件 | 7分55.160秒，约18.7% | 观测到的首个解析事件，不等于原始网络首字节 |
| 整个模型调用区间 | 41分18.893秒，约97.4% | 包含上述等待和生成阶段，以及少量边界开销 |
| 工具结果记录的执行时长合计 | 62.202秒，约2.4% | 工具时间统计，不是全部错误恢复成本 |
| 工具调用 | 135 次 | 48 次 read、19 次 grep、42 次 shell，其余为编辑、计划等 |
| 输出 token | 143,128 | 不能把生成阶段的78.7%写成 token 占比 |
| 工具错误 | 2 次 tool_error | 另有1次参数无效和1次结果无效事件，分类不同 |

最终自动检查通过，真实界面验证未执行。因此，“错误得到恢复”不能扩大为“全部验收已完成”。

### 2.1 反复探索的证据

- 首次实际写入发生在开始后17分35秒；此前已执行54次工具操作。
- 15:09:36 将搜索纯函数实现设为进行中，随后连续6轮仍为读取和搜索，相关模型调用累计约4分40秒。
- 直到15:16:34 才出现首次写入。期间多次表示“探索完成、开始实现”。

这些读取中包含必要补查，不能全部视为浪费；证据说明当前机制未充分区分必要探索与不断延后行动。

### 2.2 检查反馈和重复验证的证据

- 测试命令通过管道连接 `tail`，返回 `[shell-exit-0]`，正文却为 `24 PASS / 1 FAIL`。Agent 随后识别并修复，未漏掉该失败。
- CSS 基线检查未有效得到告警结果，后续关键词统计却被解释为零告警。
- 当前输出中关键词出现9次，被误认为9条告警；工具实际报告3条告警。
- Agent 曾据此判断告警为本次新增，继续排查，最后改用文件检查得到基线也有3条告警。相同数量本身仍不足以证明诊断项相同。
- 相关对比涉及6轮调用，模型调用累计约2分14秒；其中夹杂其他工作，中途也修改过文件，不能将整段时间认定为可节省时间。

### 2.3 工具限制与错误的证据

- `edit` 因文件超过65,536字节拒绝修改文档，随后 Agent 使用 Node 做定点文本替换，没有重新生成整篇文档。
- 一次 Shell 使用硬编码 `/tmp` 路径写临时文件，被沙箱拒绝。
- 一次编辑请求将 CSS 修改放入 TSX 文件的编辑列表，导致文本匹配失败。
- 另有一次编辑参数形状无效。

### 2.4 “少写”的证据边界

本轮只有2次 `write`，均为创建新文件，另有16次 `edit`。那次约138秒的调用输出约1万 token，但文件内容只有2,761字符、3,875字节，同轮还记录了约3.55万字符的思考，实际 `write` 执行约9毫秒。

因此，本轮不支持“改成最小 edit 就能省8–10分钟”。后续可观察重复生成，但不能将正常新建文件当作整篇重写问题。

## 3. 分层职责与当前缺口

本文 Harness 特指 `src/harness`，Loop 指 Runtime 的主循环及其接线。

| 层 | 当前职责 | 本次拟补充的职责 |
| --- | --- | --- |
| Tools／执行器 | 读写文件、执行命令、返回结果 | 明确检查对象及实际状态，支持可靠定点编辑和可操作的恢复反馈 |
| Runtime／Loop | 调度、工具生命周期、状态、Trace、Checkpoint | 保存可追溯的执行事实，向 Harness 提供有效进展和检查记录 |
| Harness | 上下文、计划、提醒、重复调用和预算策略 | 结合事实识别重复调查，投影可复用结论，指导下一步 |

目标通路：**工具产生可信事实 → Runtime 记录并保存 → Harness 判断进展和结论有效性 → Loop 执行下一步。**

### 3.1 Harness：补进展判断，保留自主工作方式

当前 [进度提醒](../../src/harness/progress-reminder.ts) 和 [目标审查](../../src/harness/goal-review.ts) 主要按回合、时长触发。[Context Harness](../../src/harness/context-harness.ts) 管理提醒投递和计划；提醒送达不代表任务已经推进。

拟增加对已解决问题、剩余信息缺口和实际成果的使用。连续调查同一问题且没有新增必要证据时，要求下一步说明具体缺口或推进当前工作。

约束：保留计划可选；只读任务可以通过取得必要证据完成；合法补查和正常长任务不能因回合数多就被迫写文件或提前结束。不为每轮进展判断额外增加一次模型审查。

### 3.2 Runtime／Loop：提供事实，不替模型编写任务结论

当前 [主循环](../../src/runtime/agent.ts) 向 Harness 上报 `read / neutral / other`、时长、原始目标和最近一条工具结果的短摘要。`other` 不能直接视为成果，未返回成功 outcome 的调用也会进入该分类。

现有 [Scratchpad](../../src/runtime/scratchpad.ts) 记录工具步骤、失败和无效结果，但不是带失效条件的检查结论记录。[Scratchpad 视图](../../src/harness/scratchpad-view.ts) 有界投影行为信息，也不承担完整验证证据存储。

拟补充实际变更、检查状态及其依据，并沿现有保存／恢复通路持久化。Runtime 只保证事实及版本关系真实，不用“某工具成功调用”推导“用户目标完成”。

### 3.3 Tools／调用管理：先保证执行反馈可靠

当前 [Shell 工具](../../src/tools/runtime-tools.ts) 将整个 Shell 脚本的退出码和输出拼成文本。[工具结果类型](../../src/tools/tools.ts) 主要承载文本和图片，没有独立检查结论字段。

[工具调用管理器](../../src/runtime/tool-invocation/process-manager.ts) 已有参数校验、结果校验、错误分类和恢复记录。应沿现有通路增加检查事实，保持授权、执行、副作用、取消和保存顺序。

工具执行正常与检查通过是两个维度：测试运行完成且发现问题，可以是工具执行成功、检查失败。不能统一把测试失败转换成工具异常并自动重试。

## 4. 实施审查结论与范围

原稿能说明问题和分工，但不足以直接实施：检查入口、状态接口、结果失效、副作用回放和进度触发条件仍需实施者重新设计。本次固定第5至10节的首版决策，再按第11节分批实施。

以下接口、模块、阈值及事件均为**拟议实现，尚未落地**。首版范围如下：

| 事项 | 本次确定的实现范围 | 保留边界 |
| --- | --- | --- |
| 可信检查 | 新增 `check` 工具，以程序和参数数组执行单个进程 | 原 `shell` 保持脚本语义，不推断任意脚本的业务通过状态 |
| 验证结论 | 通用进程保留退出状态；Biome 文件检查增加结构化诊断适配 | 任意日志不自动解析为测试条数、告警数或任务完成 |
| 复用 | 首版只自动复用输入闭包已核实的 Biome 检查，同一 Run 和 resume 内有效 | 通用进程、未知依赖和不完整结果不自动复用 |
| 进度 | 根据返回范围、内容版本、实际变更和检查版本识别机械重复 | 不宣称能自动判断任意问题是否已研究充分 |
| 编辑 | 独立1MiB编辑上限，保留分页读取、精确匹配和原子写入 | 不支持无限大文件，不取消匹配和权限校验 |
| 交付 | 使用实际证据报告已做／未做 | 本轮不扩展为任意业务目标的自动验收器 |

## 5. P0：可信检查协议

### 5.1 工具入口固定为 `check`

新增工具 `check`，在现有工具注册入口加载。普通测试、类型检查和构建优先使用该工具；需要任意 Shell 脚本或后台任务时仍使用现有能力，结果不自动升级为本协议的可信检查。

拟议参数：

```ts
type CheckArgs = {
  profile: 'process' | 'biome-lint';
  cwd?: string;          // 工作区相对目录，默认 '.'
  program?: string;      // process 必填：可执行名称或工作区相对路径
  args?: string[];       // process 必填；每项作为字面参数传入
  paths?: string[];      // biome-lint 必填，首版只支持 CSS 文件
  baseline?: 'HEAD';     // 仅 biome-lint 支持，执行开始时解析为固定 SHA
  timeoutMs?: number;    // 沿用 Shell 超时解析和上限
  reuse?: boolean;      // 默认 true；process 总是实际执行
};
```

- `profile=process` 时禁止 `paths/baseline`；`profile=biome-lint` 时禁止 `program/args`，由适配器构造参数。
- 首版前台执行，不新增后台作业系统。长任务继续走 `shell background` 和 `shellJob`，其结论不参与自动复用。
- 路径沿用工作区授权解析；不接受模型指定宿主绝对根目录、Run ID或执行器。
- `program/args` 不拼接成模型可控制的 Shell 脚本；`|`、`;`、重定向符等位于参数时只按字面传递。
- 明确拒绝以 `sh/bash/zsh/cmd/powershell/pwsh` 等命令解释器承载脚本的请求，避免包装后再次丢失实际检查对象。需要脚本时回到原 `shell`，保留其脚本级语义。
- 首版支持原生可执行文件和通过 `node` 显式运行的 JS 入口。Windows 的 `.cmd/.bat` 不作为原生进程执行，返回不支持原因，不静默切换执行方式。
- `effect=non_idempotent`，网络能力与现有 Shell 一致，保留当前授权、超时、取消和副作用流程；不因为名字是“检查”就假设任意测试无副作用。

调用示例（拟议接口）：

```json
{"profile":"process","program":"node","args":["--import","tsx","tests/task-search.test.ts"],"cwd":"."}
```

通用进程的 `passed` 只表示该进程按退出协议通过，不代表测试覆盖完整或用户任务已验收。

### 5.2 执行器及日志采集

在现有沙箱入口增加 `executeSandboxedProcess(request)`，使用原生程序与 argv。复用平台选择、工作区、受管 scratch、网络策略和进程树终止，不从 Host 裸 `spawn` 绕开沙箱。

- macOS 在现有 Seatbelt 路径执行目标程序；Windows ACL runner 的 invocation 使用目标程序和参数数组；受控无沙箱路径仍服从既有门控。
- 不重排“授权 → 执行意图持久化 → 执行 → 结果记录 → Checkpoint”。
- 当前底层执行器会先限制 stdout/stderr，所以只修改 Runtime 输出 guard 不足以保存完整检查结果。新增带 stdout/stderr 标记的原始 chunk 回调，在底层截断前采集；原 Shell 回调保持兼容。
- 原始输出流写入单次受管 scratch，退出后复用附件内容存储及 `input/spill/` 发布机制形成日志引用，再清理 scratch。JSON适配只读取 stdout，stderr单独保留。
- 首版日志采集总上限8MiB；超限保留已采集内容，标记 `logsComplete=false`，检查结论为 `inconclusive`，不伪装为完整报告，也不为更换 `tail` 切片重复执行。
- 模型可见文本继续使用统一的 `src/tool-output-budget.ts`，不复制一套截断常量。日志发布失败不丢退出码，但缺少完整证据时禁止复用。

### 5.3 工具结果与状态

扩展现有对象型 `ToolResult`，增加可选 `facts`；字符串和原有文本＋图片返回保持兼容。公共类型置于拟建的 `src/execution-evidence.ts`，该模块不依赖 Runtime、Tools 或 Harness。

```ts
type CheckConclusion = 'passed' | 'failed' | 'inconclusive';
type Diagnostic = {
  path: string; rule: string; severity: 'error' | 'warning' | 'info';
  message: string; primarySnippet: string; relatedSnippets: string[];
  fingerprint: string; // 逻辑路径及语义片段的摘要，不使用临时绝对路径和行号
};
type ReadFact = {
  kind: 'file' | 'grep' | 'ls';
  path: string;
  versionKind: 'content' | 'stat'; version: string;
  queryHash?: string;    // grep/ls的规范化查询与范围；文件读取不需要
  returnedRanges: Array<{ startLine: number; endLine: number }>;
  returnedHash: string; complete: boolean;
};
type MutationFact = {
  path: string; beforeHash: string | null; afterHash: string | null;
};
type ProcessFact = {
  exitCode: number | null;
  timedOut: boolean;
  logsComplete: boolean;
  stdoutRef?: string; stderrRef?: string;
};
type ToolFacts = {
  version: 1;
  process?: ProcessFact;
  check?: {
    profile: 'process' | 'biome-lint';
    conclusion: CheckConclusion;
    diagnostics: Diagnostic[] | null; // null=未取得；[]仅表示有效报告无诊断
    reportComplete: boolean;
  };
  reads?: ReadFact[];
  mutations?: MutationFact[];
};
```

| 情况 | 工具生命周期／检查结论 |
| --- | --- |
| 实际程序正常结束、exit 0，证据完整 | 工具成功；process检查 passed |
| 实际程序正常结束、exit非0 | 工具成功；process检查 failed，不自动重试测试 |
| Biome报告有效 | 根据报告错误与退出状态确定；warning单独记录，不能直接视为新增问题 |
| JSON解析失败、报告缺字段、诊断被省略、配置失败 | 检查 inconclusive；诊断为 null，不写成零告警 |
| 工具缺失、沙箱拒绝、超时 | 保留原有错误／拒绝／超时语义；检查 inconclusive |
| 用户取消 | 按原取消路径退出，不计为检查失败，不生成通过记录 |
| 没有 facts 的旧工具或旧事件 | 保持未知，不从 `[shell-exit-0]` 或 completedSteps 推导检查 passed |

`failed/inconclusive` 是有效的检查记录，不等于 ToolResult 协议无效。现有 `successfulToolCalls`、`failedToolCalls` 和 `invalidToolResults` 不改口径。

`facts` 的消费规则固定为：先校验版本、字段类型、工作区相对路径和大小；再记录；最后生成文本视图。无法识别的facts不产生通过事实，旧文本仍按原通路返回。单条记录最多128个诊断、32个变更和16个读取事实；超过诊断上限时标记报告不完整、禁止比较与复用，完整依据仍可读日志。文本字段和片段使用统一预算作有界展示，不能把大段源码搬入Checkpoint。

## 6. P1-A：事实存储、恢复与执行身份

### 6.1 唯一数据归属

拟建 `src/runtime/execution-evidence-store.ts`，由 `createAgentContext()` 创建；事实属于 Runtime，不放进计划文本或 conversationSummary。

`CheckpointSnapshot` 新增可选 `executionEvidence?: ExecutionEvidenceSnapshot`。`agent-context.ts` 保存和恢复该字段；文件 Checkpoint 已透传 Snapshot，沿用其原子保存方式。首版不新增数据库表，不复制到 `AgentState` 或 `HarnessState`。

拟议快照至少包含：`version:1`、调用序号、检查记录、读取指纹及未决执行记录。缺字段或未知版本按空记录／未知处理，不能恢复出通过状态。新 Run 清空，即使继承会话历史也不继承这些结论；resume保留记录，但复用前重新核对版本。

检查总记录最多32条，读取指纹最多256条、最近文件变化最多64条；优先LRU淘汰已完成且不被当前迭代引用的检查。未决／uncertain及当前迭代引用的记录不为腾位置删除；全部不可淘汰时拒绝新检查并说明原因。复用只更新原检查访问时间并记录调用关联，不为同一份结果创建重复检查实体。日志正文留在内容存储，Checkpoint只存引用和有界诊断。

### 6.2 检查记录固定字段

| 字段 | 产生方与用途 |
| --- | --- |
| `checkId / invocationId / origin` | Runtime生成；origin关联迭代、tool_call与批次位置；模型不能传入 |
| `specHash` | 规范化profile、程序／参数、cwd、paths、固定baseline SHA、解析后的超时和适配器版本的摘要；reuse不参与 |
| `inputFingerprint / scopeComplete` | Runtime／固定适配器核对；模型自报inputs不视为依赖闭包 |
| `executionState` | pending / running / settled / uncertain，区分是否真正开始执行 |
| `conclusion / process / diagnostics` | 来自通过协议校验的工具事实，不从自然语言报告提取 |
| `source` | executed / reused；复用记录指向原checkId，不伪造新执行时间 |
| `startedAt / finishedAt / logRefs` | 时间、完整依据和日志可达性 |
| `reusable / invalidationReason` | 只有依赖闭包完整、有效结束且证据完整的受支持检查可以复用 |

`ToolInvocationProcessManager` 在原始结果归一化后、文本截断与最终保存前校验并记录 facts。异常、拒绝等出口在最终保存前记录未通过状态。现有统一调用观察仍一次调用上报一次，内部重试不重复累计。

存储模块对外固定提供 `restore(snapshot)`、`getOrCreateInvocation(origin, spec)`、`findReusable(spec, fingerprint)`、`recordResult(invocationId, facts)`、`recordUncertain(invocationId, reason)`、`snapshot()` 和 `view()`。origin使用Runtime提供的迭代号、批次位置、tool_call_id和规范化参数摘要定位；序号在执行意图保存时一并持久化，不依赖模型传入nonce。

### 6.3 副作用回放不能代替验证复用

当前 `side-effect.ts` 会对相同操作身份回放结果。检查工具若只以命令作key，代码改了以后仍可能拿到旧结果，必须在P1接线中处理。

固定顺序：参数与授权校验 → 根据当前版本查可复用检查 → 无可复用结果时分配执行身份 → 沿原副作用保护实际执行。

- 同一origin恢复：使用已持久化的invocationId。已settled则回放该次结果；running／uncertain不自动重新执行。
- 新工具调用：输入闭包和适配器版本均匹配才返回 `source=reused`；否则分配新invocationId，允许对修改后的代码重新检查。
- `check.getOperationKey()` 使用Runtime注入的invocationId，不只使用命令。该字段只在ToolContext中存在，不进入模型Schema。
- 同一检查规格仍有未决副作用时，新调用也不能靠换invocationId绕过保护；先沿现有恢复流程确认现场，不能自动重跑。
- `reuse=false` 仅绕过已完成结论复用，不绕过running／uncertain保护、权限或审批。
- 通用process不自动复用；新调用可以在上次已明确结束后执行，超时／取消后的恢复继续服从副作用保护。
- 原 `shell`、文件编辑和其他工具的操作身份保持原契约，不借此改变全体工具的去重行为。

## 7. P1-B：Biome诊断与基线比较

### 7.1 已验证的本地前提

本次细化时对当前安装的Biome进行了只读探测：`lint --reporter=json <文件>` 返回可解析的 `summary/diagnostics/command`，当前CSS为3条warning、exit 0；加 `--stdin-file-path` 后仍返回“contents aren't fixed”，exit 1且stdout不是JSON。

因此首版固定使用**文件模式**。JSON reporter有实验性提示，解析器必须核对字段，未知格式一律inconclusive；不能再次用stdin失败结果做零告警基线。

### 7.2 单次检查与比较流程

`profile=biome-lint` 由固定适配器解析工作区已安装工具入口和版本，构造无 `--write` 的文件检查；不让模型自行拼接报告参数。首版只支持CSS路径，不推广为所有语言的语义验收。

`baseline=HEAD` 时在一个工具调用内完成以下流程：

1. 在授权工作区内解析HEAD为固定SHA，记录目标路径、工具版本与配置依据。
2. 在受管scratch中建立两个隔离视图，保留相同工作区相对路径：baseline使用固定SHA内容，current使用当前内容；不checkout／stash／覆盖真实工作区。
3. 视图保持各自完整配置与相对扩展关系。首版通过工作区Git清单构建视图，包含跟踪文件和非忽略的未跟踪文件，排除 `.git`、依赖目录、已知构建和运行时产物。配置引用被排除内容、工作区外资源或无法解析的依赖时，不猜测补齐，比较为inconclusive。
4. 依赖工具使用已经核实的只读安装路径，两个视图使用同一工具版本。遇到无法安全保持语义的symlink、配置外部引用或相对依赖时返回明确不支持原因。
5. 使用两个视图中的同一逻辑路径运行文件模式JSON检查。配置及工具依据不同则只保留各自结果，禁止给出新增／既有结论。
6. 校验报告完整性：summary字段有效、目标确实被检查、`diagnosticsNotPrinted=0`、所有诊断可解析。只得到计数而无完整诊断时不能比较来源。
7. 诊断按“逻辑路径＋规则＋主选择器／源片段＋相关选择器／片段＋消息”生成指纹；忽略行号移动，按多重集合比较，不能只比条数。缺少必要关联信息时保留来源未知。
8. 返回 current、baseline、introduced、resolved、unchanged及各自checkId和日志引用。任一前提不满足则比较结论为unknown，附具体原因，不建议模型靠换命令反复尝试同一失败路径。

所有Git子进程也走既有受控执行器；复制源文件仍服从授权路径解析。视图上限为20,000文件／64MiB源内容，超限明确不支持。两个限制是首版资源边界，不是实测容量结论。

### 7.3 指纹和失效规则

- current指纹覆盖本次隔离视图内容清单、配置、已安装工具版本／入口、平台和执行环境摘要、适配器版本；视图不完整时 `scopeComplete=false`，禁止复用。
- baseline以固定SHA、目标路径、工具及完整配置／环境依据建立独立key。当前CSS变化只使current失效；基线及其依据未变时可复用baseline。
- 配置、依赖安装、锁文件、工具版本、执行环境或适配器变化均触发失效。hash只用于一致性，不把环境明文放进模型视图。
- 命中前检查日志引用仍可读、记录有效且没有未决副作用；历史failed可以作为该版本的有效失败结论复用，inconclusive不复用。
- 先采用宽输入范围保证正确性，不通过猜测依赖提升命中率。通用测试／构建仍标记不可自动复用。
- 隔离视图建立前后及结果使用前核对真实输入。检查期间工作区已变化时，保留“旧视图版本的结果”，标记stale，不能据此报告当前版本通过；resume同样重新核对。

输入清单核对与视图创建只发生在检查请求及复用判定，不在每个模型回合复制或全量hash工作区。平时收到变更或未知写入事实时保守标stale；投影注明结果对应的版本和核验时间。另行计量指纹、视图和执行耗时，防止新记录机制成为主要开销。

## 8. P2：可机械验证的进度闭环

### 8.1 事实产生和“新增”定义

`ToolFacts` 由工具实现产生，Runtime校验；模型回复“开始实现／已完成”及计划打勾不产生进展事实。

| 事实 | 首版判定规则 |
| --- | --- |
| ReadFact | 实际路径、版本依据、真正返回的行范围、输出摘要；新版本或未覆盖范围算新增。请求范围大于实际返回范围时以实际为准 |
| grep／ls | 规范化查询、扫描范围、完整性、内容／结果摘要；扫描不完整不能标记该问题已查清 |
| MutationFact | 实际路径、beforeHash、afterHash；成功提交且hash变化才算修改，`无修改`不算 |
| CheckFact | specHash＋inputFingerprint＋有效结论首次出现才算新增；相同版本重复执行不算新成果 |
| 失败、拒绝、无效参数、无效结果 | 记录失败事实，不算有效成果，不清零“未推进”计数 |
| updatePlan | 中性动作，不当成文件或验证进展 |
| 无结构化事实的其他工具 | 标记未知；不能仅因成功或effect为other就判定推进，也不能据此硬判停滞 |

首版只对 `read/grep/ls/write/edit/check` 提供上述事实。其他工具保持原行为；出现未知活动时停止本轮机械停滞推断，避免误判正常业务动作。

读取不为生成事实而重复全文件扫描：1MiB以内文件可用内容hash；更大文件使用前后stat版本及实际返回片段hash，标记 `versionKind=stat`。弱版本只用于进度启发，不用于验证复用或宣称文件已完整读完。扫描不完整的grep/ls不产生“全范围已解决”的证据。

### 8.2 接口、状态与投影

- `ToolInvocationContext` 增加可选事实收集口，覆盖成功、失败、回放、拒绝等出口。主循环不再用 `undefined outcome → other` 当作实际进展依据。
- `ToolTurnProgress` 增加可选 `facts: ToolTurnFacts`，保留旧字段兼容；Runtime将本轮所有工具事实汇总后传入 `observeToolTurn()`。
- `prepareTurn()` 在现有signal参数之后增加可选只读 `evidenceView`；Harness只消费视图，不自行读文件、跑检查或修改事实存储。
- 拟建 `src/harness/progress-watch.ts` 实现纯策略。`ContextHarnessState` 增加可选 `progressWatch`，只存计数、事实epoch和提醒投递状态；原始执行证据仍在Runtime。
- 动态证据放入现有尾部 `[Context]`，不新增user消息。最多投影最近8个有效检查摘要和当前停滞依据，合计不超过2KiB，并受现有总上下文预算约束；不足时省略旧摘要而非放宽预算。
- 投影明确区分passed、failed、inconclusive、stale及原始日志引用。文本摘要不能覆盖结构化状态。

`ToolTurnFacts` 固定包含 `coverage: complete|partial|unknown`、`newReadCount`、`changedFileCount`、`newCheckCount`、`repeatCount`、`failedCount`、`neutralOnly` 和有界evidenceIds。成功但不支持facts的工具使coverage=unknown，重置机械停滞连续性；中性计划回合保留计数但不累积回合或时长。已明确失败的受支持调用不产生新增事实，但可以累计未推进回合。

### 8.3 初始策略及闭环

首版工程起点固定为：连续4个已完成工具回合没有新增有效事实，且累计活动时间不少于120秒，触发事实型进度审查。该值需行为验证，不作为已证明的最佳阈值。

1. 第一次提醒列出最近重复范围、已确认检查及仍未知事项，要求下一步说明具体信息缺口或执行可推进的行动。
2. 送达只更新delivery状态；继续观察后续工具事实，只有新增有效事实才关闭本次未推进周期。
3. 送达后又连续4回合无新增事实，升级一次提醒，附未推进依据和可用结论；同一周期最多2次，避免提醒本身形成重复输出。
4. 新增必要证据、真实修改或新版本检查结果时关闭该周期；新内容的深入阅读允许正常继续。
5. 与原goal review／只读提醒同时满足条件时合并投影，保留原审计信息，不叠加三段同义提示。
6. 不硬禁止读取、不强制写文件、不解析计划标题猜阶段、不要求必须建计划，也不因停滞提醒直接认定任务完成。

首版不声称能判断任意“信息缺口”的语义充分性。因此，本轮首次写入前的54次操作不能全部自动归为可删除回合；P2先解决有据可查的重复，再用真实任务评估推进效果。

## 9. P3：编辑能力与可操作恢复

### 9.1 大文件编辑

- 在 `filesystem.ts` 新增独立 `MAX_EDIT_BYTES=1*1024*1024`；读取分页上限保持64KiB。编辑前文件大小、编辑后内容大小均受1MiB限制。
- 复用现有唯一匹配、保守空白容错、重叠检测、BOM／CRLF保留与 `atomicWriteContent()`；先定位并验证全部edit，再写入，任一失败不产生部分修改。
- 编辑产生MutationFact，记录原始字节的beforeHash／afterHash。无实际变化不生成变更事实。
- 写入前复核读取快照，检测到外部变更时拒绝覆盖并要求重新读取。这里不宣称提供跨进程事务锁。
- 超限返回包含路径、实际大小、限制和恢复建议的有界错误，不建议默认整篇重写，不放宽无限文件大小。

### 9.2 参数与匹配错误

沿原错误通路增加机器可识别code和有界details：`EDIT_NOT_FOUND`、`EDIT_AMBIGUOUS`、`EDIT_OVERLAP`、`EDIT_TOO_LARGE`、`EDIT_STALE`。保留人类可读说明及原生命周期，不新增自动重试业务编辑。

匹配失败附实际目标路径、失败的edit序号、旧片段有界预览和当前文件最接近的行范围。无法证明正确目标文件时不自动把CSS移到另一个文件，只明确指出本次目标及匹配依据，供下一轮纠正。

### 9.3 临时目录与错误恢复

`executeContainedShell()` 的沙箱拒绝反馈增加已有能力说明：同次调用临时文件使用注入的 `TMPDIR`；跨调用文件按权限放工作区允许目录。保持不暴露宿主私有路径。

保留现有shell scratch生命周期；不新建跨Run临时文件系统，也不把任意 `/tmp` 路径加白名单。该项可独立提前落地。

## 10. 文件级改造清单

| 文件 | 具体修改 |
| --- | --- |
| 拟建 `src/execution-evidence.ts` | 公共DTO：ToolFacts、CheckRecord、读取／变更事实、快照及只读视图 |
| `src/tools/tools.ts` | 对象型ToolResult／normalize增加可选facts；ToolContext增加Runtime-only调用身份 |
| 拟建 `src/tools/check.ts` | check Schema、互斥参数校验、超时／能力声明与结果摘要 |
| 拟建 `src/tools/check-runner.ts` | 单进程执行、流式采集、日志发布和process结论 |
| 拟建 `src/tools/check-baseline.ts` | Biome文件适配、隔离视图、配置可比性及诊断多重集合比较 |
| `src/tools/runtime-tools.ts` | 注册check；复用受管执行装配；补充临时目录拒绝反馈 |
| `src/sandbox/shell-executor.ts` | 新增原生process入口和原始带流标记的chunk回调，沿用平台选择 |
| `src/sandbox/macos-sandbox.ts`、`src/sandbox/windows-acl-sandbox.ts`、`src/sandbox/shell-host.ts` | 支持受控argv目标和完整采集；旧Shell接口不变 |
| 拟建 `src/runtime/execution-evidence-store.ts` | 每Run记录、身份分配、复用核对、容量和恢复归一化 |
| `src/runtime/checkpoint-port.ts`、`src/runtime/agent-context.ts` | 增加可选快照字段，装配、保存、恢复和新Run清空 |
| `src/runtime/tool-invocation/process-manager.ts` | 复用查询／执行身份接线，facts校验与落盘；各出口单次上报 |
| `src/runtime/agent.ts` | 传递调用origin，汇总ToolTurnFacts，prepareTurn传只读视图 |
| 拟建 `src/harness/progress-watch.ts` | 机械进展、停滞周期与提醒去重纯策略 |
| `src/harness/context-harness.ts`、`src/harness/context-state.ts`、`src/harness/progress-reminder.ts` | 新状态、可选接口扩展、事实投影和提醒合并 |
| `src/tools/filesystem.ts` | 独立编辑上限、变更／读取事实、匹配失败详情 |
| `src/runtime/trace.ts` | 增加check_result、progress_watch事件，不附完整日志或环境明文 |
| `tests/run-all.ts`、`docs/architecture-current.md`、`README.md`、`PAYASO.md` | 随实际新增套件重算计数；工具／事件机器契约及架构说明同步 |

`check_result` 至少含checkId、profile、conclusion、source、原checkId、耗时和有界日志引用；`progress_watch` 含触发回合、活动时长、重复事实数、epoch与提醒等级。Host／Web先沿通用事件通路透传，验证旧客户端兼容，不新增性能面板。

## 11. 实施批次、测试与退出条件

### 11.1 实施批次

| 批次 | 可独立交付的内容 | 依赖及退出条件 |
| --- | --- | --- |
| A | P3编辑上限、匹配反馈、TMPDIR指引 | 不依赖新策略；旧编辑及权限回归通过，可先落地 |
| B | P0 check＋facts协议＋完整日志采集 | 单进程真实退出码可达；跨平台载体、超时和取消验证通过；接入期间工具暂不暴露给真实模型 |
| C | P1-A存储、恢复及副作用身份 | 同版本记录可追溯；修改后可重新检查；uncertain不能重放；旧Checkpoint兼容。完成后才开放process检查入口 |
| D | P1-B Biome适配、比较与自动复用 | 基线配置可比、诊断完整、失效与恢复用例通过；不支持的情况明确unknown |
| E | P2事实观察、投影、停滞闭环 | 失败不冒充进展、正常只读不误阻断、提醒数量有界、上下文预算未放宽 |
| F | 同任务行为与性能对照 | 验收范围一致，记录真实调用链及界面验证，独立报告收益与未验证项 |

每批只修改相关模块。A可提前做，B至E按依赖实施。任一退出条件不满足，保留已通过批次并报告未完成项，不把“计划全部completed”当交付证据。

A先交付限制和错误反馈，MutationFact在证据协议引入后随E接线。C只暴露process profile，D完成后再暴露biome-lint及baseline参数，避免模型调用尚未实现的分支。

### 11.2 必须覆盖的确定性用例

新增拟建套件：`tests/check-tool.test.ts`、`tests/check-baseline.test.ts`、`tests/execution-evidence.test.ts`、`tests/progress-watch.test.ts`。以下断言测行为和不变量，不只检查实现文本。

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| C01 | fixture输出24 PASS／1 FAIL并exit 1 | check=failed；展示截断不改变状态；不得执行tail决定结果 |
| C02 | argv含空格、引号、分号、管道或美元符号 | 原样到达子进程；不能生成额外命令或文件 |
| C03 | 缺程序、拒绝、超时、取消 | 状态分类正确；无通过记录；进程树停止，uncertain保持保护 |
| C04 | 输出超过旧底层预算但小于8MiB | 完整日志可读；JSON可解析；模型文本仍符合统一预算 |
| C05 | 超过采集上限、日志发布失败、JSON缺字段 | 结论或复用状态保持不完整；不能返回零诊断或缓存通过 |
| C06 | 旧字符串／图片ToolResult | 行为兼容，无凭空新增check=passed |
| R01 | 同origin重复处理／resume | 不启动第二次进程；原执行或uncertain可追溯 |
| R02 | 新调用且源文件变化 | 重新执行，不能被旧命令的副作用结果覆盖 |
| R03 | reuse=false且存在uncertain | 仍拒绝自动重跑，不能绕保护 |
| R04 | 新Run继承历史／旧Checkpoint | 检查记录清空或未知；resume重新核对有效性 |
| R05 | 输入、配置、工具、依赖、平台或适配器变化 | 复用失效；相同命令不等于相同检查 |
| B01 | CSS基线有3条、当前同3条但行号移动 | 相同诊断归为unchanged，不能按行号误报新增 |
| B02 | 两侧各3条但规则或关联选择器不同 | 按诊断差异返回introduced／resolved，不按数量认定既有 |
| B03 | stdin错误、报告省略、配置不同或视图不完整 | 比较为unknown；不能得到“基线0条” |
| B04 | 配置含相对extends、路径覆盖、被忽略目标 | 同路径视图语义保持或明确不支持；不能静默跑不同配置 |
| B05 | current文件变化、baseline未变 | current重跑；基线依据一致时可以复用；真实工作区无checkout／stash／覆盖 |
| P01 | 相同版本、相同读取范围重复4轮且达120秒 | 触发一次事实型提醒；送达后继续计量，不当成已推进 |
| P02 | 后续再4轮无新增／有新证据 | 前者升级一次，后者关闭周期；同周期最多两次 |
| P03 | 翻页新范围、内容变化、首次有效失败检查 | 识别为新增证据；同版本重复检查不算新成果 |
| P04 | 编辑失败、拒绝、无修改、updatePlan | 不计实际成果，不能通过other清零计数 |
| P05 | 无计划只读调查、未知工具、合法深入阅读 | 正常继续，无强制写入或提前结束 |
| P06 | 提醒并发触发、消息裁剪、resume | 提醒合并且不丢状态，视图有界，不新增user角色消息 |
| E01 | 64KiB以上、1MiB以内文件定点修改 | 无需整篇生成；内容、BOM／CRLF及原子性正确 |
| E02 | 多处匹配、重叠、超限、外部改变或目标文件错误 | 任一失败不产生部分修改，错误指向实际目标与恢复范围 |
| E03 | TMPDIR同次使用／跨调用误用／越界写入 | 临时生命周期如实，权限边界保持，拒绝反馈能指导恢复 |

平台进程用例分别在macOS和Windows支持的执行器验证；本机mock只能证明参数与分发，不能声称另一平台已运行。真实执行fixture放临时工作区，不使用生产仓库或真实远端副作用。

### 11.3 检查命令与契约同步

先运行新增相关套件及受影响的现有套件：`runtime-tools`、`shell-executor`、`tool-contract`、`tool-argument-validation`、`filesystem-tools`、`tool-invocation-state-machine`、`side-effect`、`cancellation`、`scratchpad-view`、`context-compaction`、`progress-reminder`、`goal-review`、`repeat-call-policy`、`convergence-reminder`和`plan-loop`，按批次选择，不每批重复全量。

新增套件以 `tests/run-all.ts` 为计数来源，同步 `README.md`、`PAYASO.md` 和 `docs/architecture-current.md`；新增check工具和两个事件时同步tools／events机器契约。接口影响Host映射、投影或持久化时补对应定向回归；不提前把未实现工具写入当前架构的机器契约。

全部实施批次完成、准备提交时执行 `npx tsc --noEmit` 和 `npm run test:all`。文档修改执行docs-index、docs-code-paths，并专项核对本计划的实际路径，因为通用路径测试豁免plans目录。

## 12. 性能验收与回退

- 对原Run使用相同起始代码、任务文字、验收要求和可比运行条件；另外覆盖无计划只读调查及必要多轮开发，至少各3次对照，记录所有结果而非只选最快一次。
- 记录总耗时、模型调用次数、首个有效成果时间、重复检查实际执行次数、日志复查次数、恢复回合、提醒次数及完整验收情况。按相同诊断指纹和版本区分真正重复，不能继续把所有Shell计入读取。
- 报告中位数和范围；回放只证明策略触发，不证明真实提速。不预设22–25分钟，不把重叠回合重复计为收益。
- 性能改善只有在验收不减少、必要探索未被提前打断、权限／取消／恢复通过时才成立。界面验证缺失仍需单列，不能用“自动检查全绿”替代。
- P1增加SDK选项 `checkReuse:false` 与环境开关 `PAYASO_CHECK_REUSE=off`，关闭自动复用后仍保留事实和原执行保护；P2增加 `progressWatch:false` 与 `PAYASO_PROGRESS_WATCH=off`，关闭新策略后沿用原目标审查与预算。两项默认值先在确定性验收后开启，再进行真实行为对照。
- 回退按批次恢复代码和工具注册；读取到新版本Checkpoint时保留旧字段兼容，不能将未知新记录解释为通过。协议数据不要求迁移数据库表，日志沿现有内容存储生命周期回收。
- 回退到不能理解新副作用key的旧程序前，不继续自动resume未决的check执行；保留现场和日志，防止旧版本忽略新记录后重复执行。回退验证至少包含一次有未决检查的恢复场景。

## 13. 与现有方案的关系及交付状态

- 本计划补充 [执行不收敛治理方案](./execution-convergence-governance-plan.md)，沿用预算、调用观察和恢复机制。
- 保留 [按需规划调整](./agent-adaptive-planning-recommendations-20261019.md)：计划可选、按阶段更新，计划状态不代替交付证据。
- 本轮不调整模型配置、推理强度或上下文缓存策略，也不把工具并行执行作为分钟级收益的主要依据。
- 当前仅完成实施规格细化和文档检查。A至F均未实施；全部拟建接口、工具和事件不能作为当前能力对外说明。
