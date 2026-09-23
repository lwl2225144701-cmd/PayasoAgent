# SWE-bench Verified 评测接入方案

状态：**设计待评审（v1.1，按评审意见修订）**。日期：2026-09-22。模型：**step-5-preview**（用户指定，端点由用户配置）。
修订记录：v1.1 按评审修正 5 处——① prediction 改用官方 `model_name_or_path`；② 执行路径统一为
setWorkspace + RunManager（弃 CLI）；③ patch 捕获基于 base_commit 显式 diff + apply 预检；
④ 测试污染从「告警」升级为「完整性政策」（policy_invalid 不计分）；⑤ 官方端到端验证前置到 1 题阶段。

## 0. TL;DR

把 PayasoAgent 接入 **SWE-bench Verified**：agent 侧在「克隆的实例仓库」里直接改代码，
产出基于 base_commit 的 `git diff` 作为 `model_patch`，按官方 prediction 格式落盘；
判分交给官方开源的 harness。**先跑 50 实例子集**，目标是「管线跑通 + 可复现的起点分」，
不是冲榜。**判分管线在跑第 1 题前就已用 gold patch 验证过。**

> **术语澄清（防误读）**：「官方 harness」= princeton-nlp/SWE-bench 开源仓库里的判分代码
> （Python 包）。流程是 `pip install` 到本地 + 本地 Docker 运行，**全程在本机完成，
> 不存在提交给外部服务或排队等待的环节**；agent 交卷到判分出结果都是分钟级。
> 用他们的代码是为了分数与榜单同标准（自己写判分 = 自己给自己打分，数字无外部意义）。

## 1. 目标与非目标

**目标**
- 用 step-5-preview 驱动 PayasoAgent，对 SWE-bench Verified 产出可提交的 prediction
- 拿到可复现的起点分（resolve rate）+ 过程指标（token/耗时/工具调用/agent 步数）
- 全程非交互、可重跑；manifest 记录模型指纹、数据集/harness 版本与子集定义
- 评测诚信：agent 只见 problem_statement；碰测试的实例按政策作废

**非目标（v1 明确不做）**
- 不冲榜、不跑全集 500（pilot 后由数据决定）
- 不做 in-container agent（agent 跑官方评测镜像、能跑测试拿反馈）——见 D3，列为 P6+
- 不改 agent 核心；适配全部是增量代码

## 2. 总体架构

```
                    ┌──────────────────────── agent 侧（我们的环境，无 Docker）────────────────────────┐
SWE-bench Verified  │  per instance（逐题隔离，workspace = 克隆的实例仓库）：                              │
  50 实例子集        │   1. git clone repo → checkout base_commit（版本锁定，见 P0）                       │
  (HF/swe-bench.org)│   2. setWorkspace(该仓库)                                                        │
                    │   3. RunManager.createInSession(problem_statement)  ← 与 baseline 同一路径           │
                    │      （step-5-preview，workspace-write + 显式 network on，接线见 D6）                │
                    │   4. 等待 Run 终态，并验收「写入已停止」：① 终态事件（run_completed/failed/   │
│      stopped）② 该 Run 执行 Promise 真正结束（agentPromise，权威信号——checkpoint 在       │
│      tool_result 时也保存、不能证明 Agent 已停止）③ 后台任务结束确认（无公开查询接口，      │
│      经 mtime 静默窗口 + trace 兜底，mtime 只是辅助）——确认不了记 runner 故障、交空 patch， │
│      不交可能仍在变化的 patch                                                │
                    │   5. git add -A && git diff --cached --binary --full-index <base_commit> -- .      │
                    │   6. 干净 checkout 上 git apply --check 预检                                       │
                    │   7. 落盘：preds.jsonl + 每实例 trace/tokens/diff/status                           │
                    └──────────────────────────────────────────────────────────────────────────────────┘
                                                    │ preds.jsonl
                                                    ▼
                    ┌──────────────────────── 判分侧（官方开源 harness，本地 Docker 运行）───────────────┐
                    │  swebench.harness.run_evaluation --predictions_path preds.jsonl                   │
                    │  → 每实例 apply model_patch → apply test_patch → 跑测试 → resolved 判定              │
                    └──────────────────────────────────────────────────────────────────────────────────┘
```

## 3. 关键设计决策

### D1 执行模式：prediction submission，而非 in-container agent

官方支持两种接入：①提交 `model_patch`（榜单提交的标准路径，agent 在参赛方自己的基础设施跑）；
②harness 在评测镜像内驱动 agent。**选 ①**：agent 侧完全不需要评测镜像（那镜像带全套测试依赖，
GB 级），我们的沙箱 + node 就够；复杂度与成本下降一个数量级；判分（正确性关键的环节）仍由官方
harness 完成，不牺牲公正性。

### D2 执行路径：setWorkspace + RunManager（v1.1 修订）

**不经过 CLI**——CLI 无 `--workspace` 与显式 Provider 参数，无法直接在克隆的实例仓库中运行，
也不能逐题绑定隔离的模型配置。v1 统一走 baseline 同款路径：

```
setWorkspace(<克隆的实例仓库>)  →  RunManager.createInSession(task)  →  轮询终态  →  读 Trace/统计
```

`tests/baseline/run.ts` 就是这个模式的现成实现（mkdtemp → setWorkspace → createInSession →
status 轮询 → 逐题产物），新增 `tests/swebench/` 只写差异段：数据集加载、repo checkout、
task 包装、patch 捕获与预检、prediction/results 落盘。

### D3 agent 侧环境是「裸 repo + 我们的沙箱」——patch-only，接受这个分数天花板

agent 侧**没有预装官方测试环境**（评测镜像是判分侧的事），测试运行不保证——这不是当前代码的
硬限制，是 v1 的部署约定。**v1 不承诺「严格盲改」**：Trace 检测只能事后记录 agent 跑过测试，
不能事前阻止；真正的执行前拦截（如 shell 命令denylist）属 agent 核心能力，v1 非目标、列为后续。
因此口径是：*允许 agent 尝试运行环境中已有的测试，尝试行为记录于 trace 备查*。
**v1 为 patch-only**：盲改交卷为主，判分侧才做权威判定。SWE-bench 上「能跑测试迭代」的 agent 显著占优，
首跑分数低于榜单是**结构性预期**，不是模型不行。官方端到端验证前置（§6 P2）保证我们至少知道
每一分丢在哪。后续增强 = in-container 模式（P6+）。

### D4 预算模型：墙钟 + token 双闸门（防跑飞 + 可比性，不是配额控制）

总配额不是关注点（50 实例吃不掉一个 coding plan，用户已确认）。单实例闸门管三件事：

1. **防跑飞**：Runtime 无固定迭代上限（模型持续产工具调用循环就继续）——没有墙钟上限，
   一个卡死的实例会把整场评测挂死；
2. **公平性**：统一预算 = 统一考试时间，各版本横向可比；
3. **总时长可控**：串行 50 题需要知道何时跑完。

默认值（宽松，约等于「不设限、只防飞」）：**每实例墙钟 60 min + token 4M**，超限强停、
产出当前 diff、记 `status: timeout|budget_exceeded`。并发可配（baseline 的 concurrency 参数），
瓶颈转为模型端限流。

### D5 子集固定 + 版本锁定 + 模型指纹，保证可复现

- 子集清单（instance_id 列表）**写死进 repo**（`tests/swebench/instances.sprint1.json`），
  不依赖运行时随机；**且选取规则本身固定**（否则「为什么是这 50 题」不可回答）：
  **分层抽样——按 repo 在数据集中的实例数占比分配 50 个名额（最大余额法），repo 内按
  instance_id 字典序取前 K**。无随机种子、无人工挑选，换人来跑得到同一清单；清单的
  sha256 与数据集 revision 进 manifest。
- **5 题 pilot 从这 50 题中预先确定**（同序取前 5，写死在 pilot 清单文件），
  禁止看过 50 题结果再换 pilot 题——防 cherry-pick。
- **数据集版本 + 官方 harness 版本锁定**（P0 第一件事）：同一份实例 + 同一个 grading harness
  才是可比的分
- manifest 记录：模型指纹（base_url + model + key 脱敏哈希）、数据集/harness 版本、子集定义、
  源码 git 提交 + 未提交改动哈希、预算参数、每实例实际消耗

### D6 无人值守接线：network mode / 审批 / 预检（v1.2 新增）

方案已弃用 CLI（D2），`--network-mode` 是 CLI 参数——RunManager 路径上必须由 adapter 显式
接线，不能沿用宿主进程的隐式状态：

1. **显式设置全局 network mode**：adapter 启动时 `setNetworkMode('on')`（`network-mode.ts`
   的全局单例）。不依赖默认值（当前默认恰为 on，但默认值会变、宿主进程可能被别处改过），
   实际模式记入 manifest。
2. **无人值守审批语义（两类，都已核实现状）**：
   - **网络审批**：`ApprovalPort.request` 仅 NetworkApprovalRequest，且
     `needsNetworkApproval` 仅在 networkMode === 'ask' 时为真 ⇒ mode='on' 下永不被请求。
   - **工具链准备审批**：RunManager 另注入 `toolchainPreparationPort`——
     **缺受管工具（Node/npm）时 `ToolchainPreparationCoordinator` 发起
     `toolchain_preparation_requested` 并走同一条 60s fail-closed 超时**
     （APPROVAL_TIMEOUT_MS，唯一裁决路径同为 HTTP 端点）。这是 D6 初版漏掉的第二类。
   - **程序化处置（已核实现状）**：RunManager 公开 `resolveApproval` /
     `resolveToolchainPreparation`——adapter 监听事件，一旦出现审批请求**立即以
     denied 自动驳回**（不等 60s）并记 **runner 故障**；preflight 先消除触发条件
     （git/node/npm 实测可用 + network on），双管齐下：消除为主、自动驳回兜底。
3. **预检（P1 第一站，agent 启动前）**：node 版本、git 可用、模型端点连通（一次最小
   chat completion 探活）、数据集缓存与实例清单完好、实例 repo 可 clone。任一不过即
   整个批次拒绝启动——不在第 30 题才发现端点是坏的。
4. 判分侧前置（Docker/harness）是 P2 的事，P1 只预检 agent 侧依赖（D1 的部署形态决定
   两者天然分离）。

## 4. 数据集

- 来源：SWE-bench Verified（500 实例）。官方：`swe-bench.org` / HF `princeton-nlp/SWE-bench_Verified`
- 使用字段：`instance_id` / `repo` / `base_commit` / `problem_statement`
- **不进入 agent 可见范围**：`hint_text`（榜单可比性要求）、`patch`（gold）、`test_patch`、
  `FAIL_TO_PASS` / `PASS_TO_PASS` 测试列表——gold 字段只用于判分侧与完整性政策的**路径清单推导**，
  绝不写入 agent 工作区或 task；test_patch 触及路径只以路径清单形式进 manifest 的 policy 段（不含内容）

## 5. 产出物规范

```
docs/swebench/<UTC时间>/
├── manifest.json          # 模型指纹、数据集/harness 版本、子集定义、预算、源码哈希、policy 版本
├── preds.jsonl            # 恰好 50 行（每个选中实例必有且仅有一条）：{"instance_id": "...", "model_name_or_path": "step-5-preview", "model_patch": "..."}
├── results.json           # 逐实例：status、tokens、duration、工具调用数、agent 步数、
│                          #   diff 统计、policy 判定（ok / policy_invalid + 命中规则）
└── <instance_id>/
    ├── task.md            # 实际交给 agent 的 problem_statement
    ├── turn-N.json        # 每轮完整回复与 Trace
    └── patch.diff         # 该实例最终 diff（policy_invalid 的也原样保留，供审计）
```

### 5.1 prediction 格式（v1.1 修订）

```json
{"instance_id": "django__django-11099", "model_name_or_path": "step-5-preview", "model_patch": "diff --git ..."}
```

字段名用官方 harness 要求的 **`model_name_or_path`**（非 `model_name`）。

### 5.2 patch 捕获与预检（v1.1 修订）

```bash
git add -A
git diff --cached --binary --full-index <base_commit> -- .
```

- 基于**显式 base_commit** 而非 HEAD——agent 若中途 commit，`git diff --cached`（对 HEAD）会漏掉；
- `--binary`：仓库含二进制改动时不可少；
- `--full-index`：保证 patch 在干净 checkout 上可 apply；
- **预检**：在「同一 base_commit 的干净 checkout」上 `git apply --check`，不过记
  `status: patch_invalid`；**正式 predictions 中该实例以空 patch 提交**（SWE-bench 惯例：
  空 patch = 无改动，合法且判为 unresolved），原始坏 patch 留档供审计。规则统一见 §5.4。

### 5.3 测试完整性政策（v1.1 新增，替代「告警」）

**policy v1 规则**：

| # | 规则 |
|---|---|
| A1 | **数据集字段层面**只向 agent 提供 problem_statement + 一行约束；gold patch / test_patch / 测试判分列表一律不出现（§4）。**注意**：RunManager 还会从克隆仓库加载项目指令（PAYASO.md/AGENTS.md/CLAUDE.md）与 skills 注入模型（现行行为）——非数据集污染但是环境变量，manifest **逐实例记录**该仓库存在哪些指令文件、是否发现 skills，保证可解释 |
| A2 | **提交的 diff** 触及以下路径即判 `policy_invalid`：① 测试文件（模式匹配：`test_*.py` / `*_test.py` / `/tests/` / `/test/` / `testing/` / `conftest.py`）；② 测试基础设施与 hook（`pytest.ini` / `tox.ini` / `setup.cfg` 的 test 段 / `pyproject.toml` 的 `[tool.pytest]`）；③ **test_patch 实际触及的路径**（由数据集推导，进 manifest policy 段）。注：diff 是最终提交物，对它的检测是可靠的；trace 里的测试*执行*只作记录，不作判定依据（执行无法事前拦截，见 D3） |
| A3 | `policy_invalid` 实例：**计为未解决**（不从分母剔除——剔分母会虚高分数）；正式预测以空 patch 提交，原始 patch 与命中规则留档；违规数量单独报告 |
| A4 | policy 版本号进 manifest；规则演进时旧结果可重判 |

防的是「agent 改测试/改 hook 让测试假绿」这类作弊路径——比「记录了但照样计分」严一代。
**能力边界（不装全）**：A2 只覆盖*已知模式*的测试污染，不能宣称覆盖所有让测试假绿的
方式（如冷门方式禁用测试、篡改 fixtures 数据等）。因此追加：**所有 resolved patch
逐条人工复核后才采信**——policy 检测 + 人工复核双轨。

### 5.4 计分与提交规则（v1.2 统一，诚信口径）

**分母固定，分子只取官方判定**：

- 正式分数 = `官方 harness 判 resolved 数 / 50`——**分母恒为 50**（选中实例全集），绝不剔除；
  **分子只认官方 grading 的 resolved 判定**，我们不自作解释。
- `timeout` / `budget_exceeded` 是**过程标签**（告诉我们 agent 侧发生了什么），**不是计分概念**：
  一个通过两道检查的超时 diff 照常提交，官方判 resolved 就计 resolved——「超时即未解决」的
  旧表述已废。
- 报告字段**对齐官方报告结构**，互不混淆：`submitted`、`resolved_ids`、`unresolved_ids`、
  **`empty_patch` 单列**（官方不把它并进 unresolved_ids）；我们的过程标签
  （timeout/policy_invalid/patch_invalid/runner_fault）另建一节，只作诊断。

**preds.jsonl 提交契约**：

| 实例状态 | preds.jsonl 里的 model_patch | results.json 记录 |
|---|---|---|
| `ok`（apply --check 通过、policy 干净） | 实际 patch | status + 指标 |
| `patch_invalid`（apply 不过） | **空 patch** | status: patch_invalid + 失败原因 |
| `policy_invalid`（碰测试） | **空 patch** | status: policy_invalid + 命中规则 |
| `timeout` / `budget_exceeded` | diff **先过 policy + apply 预检**：都过才照交（未完成也合法）；任一不过 → 空 patch | status + 已跑时长/tokens |
| 空 diff（agent 没改任何东西） | 空 patch | status: empty_patch |

- 原始（含坏/违规）patch **全部留档**在 `<instance_id>/patch.diff` 与 `raw/` 供审计，
  predictions 与档案分离：档案求真，提交求净。
- **50 行进、50 行出**：每个选中实例无论结局如何在 preds.jsonl 中都占一行——这是「固定分母」
  在数据层面的落地。
- **判定优先级（唯一）**：无论何种收尾状态（completed/timeout/budget_exceeded），交不交实际 patch
  **只由两道检查决定**——① policy 干净 ② `git apply --check` 通过。两道都过才交实际 diff，
  任一不过一律空 patch。超时不构成免检金牌。

## 6. 实施步骤（v1.1 重排：官方验证前置）

| 阶段 | 内容 | 出入口 |
|---|---|---|
| **P0 前置** | 环境 checklist（全部本地）：① **Docker**（用户负责安装——Docker Desktop 或 Colima，装完 `docker ps` 验证 daemon）；② `brew install python@3.12` + harness 专用 venv（Homebrew 默认 3.14 不被 harness 依赖支持）；③ .env 配 step-5-preview（用户负责，附 checklist）；④ **锁定数据集版本 + 官方 harness 版本**（commit 级）；⑤ **判分环境可行性确认**：官方建议 **~120GB 可用存储**、**arm64 判分支持为实验性**——本机 arm64，P2-P5 能否本机判分需实测，不行则远程 x86 判分 | 五项全过，版本号写进 manifest 模板 |
| **P1 适配器** | `tests/swebench/`：dataset loader、repo checkout、task 包装、setWorkspace+RunManager 接线、patch 捕获/预检、preds/results 落盘、policy 检测 | 产物结构正确，5 实例 dry-run（**不依赖 Docker/Python harness，P0 未完也可开工**） |
| **P2 判分管线验证** | 选 1 条 gold patch 跑通官方 harness，验证 Docker/harness/命令链路。**gold 不是「构造保证可通过」——须实际验证**：跑 gold → resolved 才采用为该管线基线实例；未过就换一条重试，直到有一条通过；最终实例 ID 与验证证据写进报告。完整命令：`python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Verified --instance_ids <instance_id> --predictions_path <gold_pred.json> --run_id <run_id>`（gold_pred.json 直接从锁定数据集的 gold `patch` 字段构造，`--predictions_path` 官方入参，无需另行准备） | 选定 gold 实例 resolved（附证据）。**边界**：单条 gold 通过只证明这一实例的判分链路可用，不证明整个 grader 全绿——全量可信度由 P4 pilot 5 题的结果分布支撑 |
| **P3 单题端到端** | Payaso 跑 1 个实例（pilot 第 1 题）→ **立即官方判分**（predictions **1 行**） | patch apply --check 过；判分链路通 |
| **P4 5 题 pilot** | 跑 5 题（预定 pilot 清单）+ 官方判分（predictions **5 行**），核对成本均值与失败模式 | 单实例成本/时长均值出来；无系统性故障 |
| **P5 50 题全跑** | 按 P4 核算的成本放开跑 + 官方判分出正式起点分（predictions **50 行**） | preds.jsonl 完整 + resolve rate + 过程指标 |
| **P6 可选** | in-container 模式（D3 的反馈循环）/ 全集 500 / 接 CI 回归 | 由 P5 数据决定 |

## 7. 风险与边界

1. **成本**：P4 用 5 题实测单实例均值再核算 50 题总量；token 闸门（D4）是成本保险。
2. **patch 为空 / apply 失败 / policy_invalid**：preds.jsonl 对每个选中实例**必有且仅有一条记录**，无效或违规题用空 patch；原因写进 results.json，原始 patch 留档；不重试。规则见 §5.4。
3. **patch-only 天花板**（D3）：低于会跑测试的 agent 是预期；首跑是起点不是排名。
4. **agent 侧沙箱**：本机 macOS 跑则 seatbelt 完整隔离；若迁 Linux CI 需
   `PAYASO_SHELL_UNSANDBOXED=1` 且能力报告如实标 `enforcement: none`（容器即边界）。
5. **网络**：clone repo 与模型调用均需；agent 侧由 adapter `setNetworkMode('on')`（D6；CLI 已弃用，无 `--network-mode` 参数）。
6. **policy 误伤**：合法修复改了同名测试工具文件的罕见情况会被 A2 命中——记 policy_invalid + 人工
   复核通道，宁可漏分不放过可疑路径。
7. **判分环境**：本机 arm64，官方 harness 的 arm64 支持实验性、建议 ~120GB 存储；P2 第一件事
   实测本机判分可行性，不通则远程 x86。
8. **判分缓存陷阱**：同一 `run_id` + 实例可能复用旧判分结果——**即使 patch 变了**。纪律：
   每次修改 predictions 后必须用**新的 grading run_id**，manifest 记录
   `grading_run_id ↔ predictions 文件 sha256` 对照，旧结果不得混入新报告。

## 8. 决议记录（原开放问题）

| 项 | 决议 |
|---|---|
| 模型端点 |  step-5-preview，**由用户配置**（`.env`：OPENAI_BASE_URL/API_KEY/MODEL）；P0 附配置 checklist |
| 子集规模 | **50 实例**，清单写死进 repo |
| 预算 | 总配额不设控（用户确认 50 题吃不掉 codingplan）；**单实例墙钟 60min + token 4M** 防跑飞 + 保可比（D4） |
| patch-only | **接受**（D3）：v1 盲改交卷，本地官方 harness 判分；in-container 为 P6+ 增强 |
| 运行环境 | **Docker 由用户安装**（判分侧唯一支持的运行方式，`docker ps` 验证）；harness 用 `python@3.12` venv（Homebrew 默认 3.14 不被依赖支持）。两项均 P0 关口，P1 适配器不依赖它们、可先行 |
