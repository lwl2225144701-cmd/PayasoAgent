# SWE-bench Verified 评测接入 · 执行状态

状态：**P1/P2 已完成；P0③ 待用户配置；P3 待启动**。日期：2026-09-23。
设计正本：`docs/plans/swebench-integration-plan.md`（四轮修订定稿）；本文只记执行状态与实测数据。

## 阶段总览

| 阶段 | 状态 | 证据/产物 |
|---|---|---|
| 方案设计（四轮修订） | ✅ | `docs/plans/swebench-integration-plan.md`，提交 67c9cd4 / 380edc4 / 52d515b / d4c471c |
| P1 适配器 | ✅ | `tests/swebench/`（dataset/sampling/policy/decision/run），commit `400bc37`；单测 18 例（sampling 6/policy 6/decision 6）注册进 test:all；dry-run 自检全过 |
| P0① Docker | ✅ 用户已装 | Docker Desktop **29.8.0**，arm64；CLI 在 `~/.docker/bin/docker`（PATH 需自带） |
| P0② Python | ✅ **无需 3.12** | harness 5.0.2 在系统 **Python 3.14.2** 直接运行（原计划装 python@3.12，实测不需要） |
| P0④ 版本锁定 | ✅ | harness `swebench==5.0.2`；数据集新格式 `SWE-bench/SWE-bench_Verified`（HF，split=test） |
| P0③ .env 配 step-5-preview | ⬜ **唯一卡点**（用户） | 配好后即为 P3 发令枪 |
| **P2 判分管线验证** | ✅ **gold resolved** | 见下节证据 |
| P3 单题端到端 | ⏳ 待 P0③ | pilot 第 1 题 astropy__astropy-12907 |
| P4 5 题 pilot | ⏳ | 需再拉 2-3 个（repo,version）镜像 |
| P5 50 题全跑 | ⏳ | 磁盘是约束，见「磁盘账」 |

## P2 证据（gold 实例判分链路）

命令（注意两个沙箱适配项：`HF_HOME` 必须指到可写目录，否则 harness 写 `~/.cache/huggingface` 被 EPERM 拦；`--report_dir` 同）：

```bash
HF_HOME=/tmp/swebench-hf /tmp/swebench-venv/bin/python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --predictions_path gold \
  --instance_ids astropy__astropy-12907 \
  --run_id gold-verify-astropy-12907 \
  --report_dir /tmp/swebench-report
```

结果（报告 `/tmp/swebench-report/gold.gold-verify-astropy-12907.json`）：

```
Instances submitted: 1 / completed: 1 / resolved: 1 / unresolved: 0 / errors: 0
```

- `--predictions_path gold` 是官方入参（直接用数据集 gold patch，无需手工构造 preds）。
- 结论（按方案 P2 的期望边界）：**该实例的判分链路可用**；单条 gold 通过不证明整个 grader 全绿——全量可信度由 P4 pilot 的结果分布支撑。
- 已知无害噪音：收尾打印 `FileNotFoundError: 'docker'`——harness 清理钩子调用裸 `docker` 命令，PATH 里没有；判定完成后才走清理，不影响结果。

## 环境实测数据（P1 阶段未知、P2 期间获得）

| 项 | 实测 |
|---|---|
| 镜像获取方式 | **Docker Hub 官方预构建**：`swebench/sweb.eval.x86_64.<repo>_1776_<instance>:latest`（`__`→`_1776_`）；数据集 `image` 字段直接给出名字 |
| harness 架构（5.0.2） | 新数据集格式要求 `image`/`eval_script`/`log_parser`/`eval_type` 字段——经典 `princeton-nlp/*` 数据集不含，**必须用 `SWE-bench/SWE-bench_Verified`**；镜像按 instance 命名（同 repo+version 的实例共享层，内容寻址去重） |
| arm64 兼容 | **amd64 镜像可在本机 arm64 运行**（Rosetta 模拟）：`uname -m`=x86_64、Python 3.11.5、astropy 精确导入 base_commit 版本；拉取需 `--platform linux/amd64` |
| 单镜像实测 | astropy v4.3 **4.16GB / 拉取 2m19s**；django v3.0 **4.41GB / 拉取 5m31s** |
| 50 题的磁盘账 | 16 个（repo,version）组合，不同 repo 的镜像几乎不共享层 ⇒ 预估 **50-65GB vs 可用 54GB（P5 触顶）**。两条路：按 repo 分批「拉→判→删」，或先清磁盘 |

## 后续动作

1. **P0③（用户）**：`.env` 配 step-5-preview（OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL=step-5-preview）。
2. **P3（我）**：配好后跑 pilot 第 1 题：`npx tsx tests/swebench/run.ts --pilot --limit 1`（agent 侧）→ `HF_HOME=... python -m swebench.harness.run_evaluation --predictions_path <preds.jsonl> ... --run_id <新id>`（判分侧）。
3. **P4（我）**：5 题 pilot + 官方判分，核算单实例成本/时长均值（同时实测 Rosetta 模拟下 1800s 超时是否够）。
4. **P5 前决策**：磁盘方案（分批拉删 vs 清盘），并确认 16 镜像的判分并发（max_workers ≤ CPU 75%）。
5. 纪律提醒（方案 §8）：每次改 predictions 必须换新 `--run_id`，并在 manifest 记录 `grading_run_id ↔ predictions sha256`。
