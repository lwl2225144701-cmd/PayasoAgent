# SWE-bench Verified 评测接入方案

状态：**设计待评审（v1.1，按评审意见修订）**。日期：2026-09-22。模型：**step-5-preview**（用户指定，端点由用户配置）。
修订记录：v1.1 按评审修正 5 处——① prediction 改用官方 `model_name_or_path`；② 执行路径统一为
setWorkspace + RunManager（弃 CLI）；③ patch 捕获基于 base_commit 显式 diff + apply 预检；
④ 测试污染从「告警」升级为「完整性政策」（policy_invalid 不计分）；⑤ 官方端到端验证前置到 1 题阶段。

## 0. TL;DR

把 PayasoAgent 接入 **SWE-bench Verified**：agent 侧在「克隆的实例仓库」里直接改代码，
产出基于 base_commit 的 `git diff` 作为 `model_patch`，按官方 prediction 格式落盘；
判分完全交给官方 harness（Docker 跑 FAIL_TO_PASS/PASS_TO_PASS）。**先跑 50 实例子集**，
目标是「管线跑通 + 可复现的起点分」，不是冲榜。**判分管线在跑第 1 题前就已用 gold patch 验证过。**

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
                    │      （step-5-preview，workspace-write + network on，非 TTY 自动 fail-closed）      │
                    │   4. 等待 Run 终态（completed/failed/stopped），读 Trace 与统计                      │
                    │   5. git add -A && git diff --cached --binary --full-index <base_commit> -- .      │
                    │   6. 干净 checkout 上 git apply --check 预检                                       │
                    │   7. 落盘：preds.jsonl + 每实例 trace/tokens/diff/status                           │
                    └──────────────────────────────────────────────────────────────────────────────────┘
                                                    │ preds.jsonl
                                                    ▼
                    ┌──────────────────────── 判分侧（官方 harness，Docker）─────────────────────────────┐
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

agent 不改装测试依赖、不在仓库环境跑测试（沙箱禁止 workspace 外写、装不了 pip 包）。
**v1 为 patch-only**：盲改交卷，判分侧才跑测试。SWE-bench 上「能跑测试迭代」的 agent 显著占优，
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
  不依赖运行时随机
- **数据集版本 + 官方 harness 版本锁定**（P0 第一件事）：同一份实例 + 同一个 grading harness
  才是可比的分
- manifest 记录：模型指纹（base_url + model + key 脱敏哈希）、数据集/harness 版本、子集定义、
  源码 git 提交 + 未提交改动哈希、预算参数、每实例实际消耗

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
├── preds.jsonl            # 每行 {"instance_id": "...", "model_name_or_path": "step-5-preview", "model_patch": "..."}
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
  `status: patch_invalid`（该题 unresolved，不静默提交坏 patch）。

### 5.3 测试完整性政策（v1.1 新增，替代「告警」）

**policy v1 规则**：

| # | 规则 |
|---|---|
| A1 | agent 可见材料只含 problem_statement + 一行约束；gold patch / test_patch / 测试判分列表一律不出现（§4） |
| A2 | diff 触及以下路径即判 `policy_invalid`：① 测试文件（模式匹配：`test_*.py` / `*_test.py` / `/tests/` / `/test/` / `testing/` / `conftest.py`）；② 测试基础设施与 hook（`pytest.ini` / `tox.ini` / `setup.cfg` 的 test 段 / `pyproject.toml` 的 `[tool.pytest]`）；③ **test_patch 实际触及的路径**（由数据集推导，进 manifest policy 段） |
| A3 | `policy_invalid` 实例：**不计入正式 resolve rate**；原始 patch 与命中规则**保留供审计** |
| A4 | policy 版本号进 manifest；规则演进时旧结果可重判 |

防的是「agent 改测试/改 hook 让测试假绿」这类作弊路径——比「记录了但照样计分」严一代。

## 6. 实施步骤（v1.1 重排：官方验证前置）

| 阶段 | 内容 | 出入口 |
|---|---|---|
| **P0 前置** | .env 配好 step-5-preview（用户负责，附 checklist）；**锁定数据集版本 + 官方 harness 版本**并记录 | 两版本号写进 manifest 模板 |
| **P1 适配器** | `tests/swebench/`：dataset loader、repo checkout、task 包装、setWorkspace+RunManager 接线、patch 捕获/预检、preds/results 落盘、policy 检测 | 产物结构正确，5 实例 dry-run |
| **P2 判分管线验证** | **先用 1 个 gold patch 跑通官方 harness**（Docker/harness/测试环境本身没问题），输出「gold 应全绿」的基线 | gold 实例 resolved（grader 可信） |
| **P3 单题端到端** | Payaso 跑 1 个实例 → **立即官方判分**（不等 50） | patch apply --check 过；判分链路通 |
| **P4 5 题 pilot** | 跑 5 题 + 官方判分，核对成本均值与失败模式 | 单实例成本/时长均值出来；无系统性故障 |
| **P5 50 题全跑** | 按 P4 核算的成本放开跑 + 官方判分出正式起点分 | preds.jsonl 完整 + resolve rate + 过程指标 |
| **P6 可选** | in-container 模式（D3 的反馈循环）/ 全集 500 / 接 CI 回归 | 由 P5 数据决定 |

## 7. 风险与边界

1. **成本**：P4 用 5 题实测单实例均值再核算 50 题总量；token 闸门（D4）是成本保险。
2. **patch 为空 / apply 失败**：照常提交记 `patch_invalid`（unresolved），不重试。
3. **patch-only 天花板**（D3）：低于会跑测试的 agent 是预期；首跑是起点不是排名。
4. **agent 侧沙箱**：本机 macOS 跑则 seatbelt 完整隔离；若迁 Linux CI 需
   `PAYASO_SHELL_UNSANDBOXED=1` 且能力报告如实标 `enforcement: none`（容器即边界）。
5. **网络**：clone repo 与模型调用均需；agent 侧 `--network-mode on`。
6. **policy 误伤**：合法修复改了同名测试工具文件的罕见情况会被 A2 命中——记 policy_invalid + 人工
   复核通道，宁可漏分不放过可疑路径。

## 8. 决议记录（原开放问题）

| 项 | 决议 |
|---|---|
| 模型端点 |  step-5-preview，**由用户配置**（`.env`：OPENAI_BASE_URL/API_KEY/MODEL）；P0 附配置 checklist |
| 子集规模 | **50 实例**，清单写死进 repo |
| 预算 | 总配额不设控（用户确认 50 题吃不掉 codingplan）；**单实例墙钟 60min + token 4M** 防跑飞 + 保可比（D4） |
| patch-only | **接受**（D3）：v1 盲改交卷，官方判分；in-container 为 P6+ 增强 |
