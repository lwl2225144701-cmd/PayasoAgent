# SWE-bench Verified 评测报告 · 批次 11–20

- **日期**：2026-09-25
- **被测 agent**：PayasoAgent（`src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan`）
- **题集**：固定 50 题清单的**第 11–20 题**（`--offset 10 --limit 10`；本批为 django-11095 ~ 11206）
- **模式**：**patch-only / 盲改**（无测试环境，只读代码 + 交 `git diff`，正确性交官方 harness）
- **agent 侧 run**：`eval/runs/2026-09-25T13-06-21-734Z/`；**判分 run_id**：`batch11-20-g1`
- **配置**：并发 3 · 单题墙钟 25min · 模型 env 兜底

## 一、总成绩

| 口径 | 数 |
|---|---|
| 官方 harness：**resolved** | **8 / 10** |
| unresolved | 1 |
| empty（空 patch） | 1 |
| **本批无 Rosetta 假阴性**（见 §四） | — |

`preds.jsonl` 恰 10 行（固定分母）。**本批比 pilot（7/10）高一档。**

## 二、逐题明细

| 实例 | agent 侧 | 官方判定 | 结论 |
|---|---|---|---|
| django__django-11095 | ok, 3176B, 4.6min | ✅ resolved | 修对 |
| django__django-11099 | ok, 961B, 4.0min | ✅ resolved | 修对 |
| django__django-11119 | ok, 545B, 4.7min | ✅ resolved | 修对 |
| django__django-11133 | ok, 1376B, 2.9min | ✅ resolved | 修对 |
| django__django-11138 | ok, 13861B, 25.1min **（超时仍提交）** | ✅ resolved | 超时未误事 |
| django__django-11163 | ok, 630B, 1.9min | ✅ resolved | 修对 |
| django__django-11179 | ok, 674B, 6.6min | ✅ resolved | 修对 |
| django__django-11206 | ok, 1096B, 11.0min | ✅ resolved | 修对 |
| django__django-11141 | ok, 837B, 15.6min | ❌ unresolved | 半成品（见 §四） |
| django__django-11149 | **runner_fault, 0B, 25.2min** | ⬜ empty | 超时弃权 |

agent 侧 9/10 `ok`（交了干净 patch），仅 11149 弃权。

## 三、官方判分口径

`swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified`，本地 Docker（amd64 镜像 / arm64 Rosetta）；resolved ⟺ apply patch 后隐藏 FAIL_TO_PASS 测试由红转绿。

## 四、两道"没分题"的定性

1. **django-11141 = 真 miss（半成品修复）。** 本题 gold 有两处改动：①删掉"空目录即 namespace"块；②把 `migrated_apps.add()` 改为「有 `migration_names`（或 `ignore_no_migrations`）才算 migrated，否则 unmigrated」的**核心条件逻辑**。agent **只做了第①处（表层删除），漏了第②处（核心逻辑）** → 没修好。与 pilot 的 django-10999 同型：**改了表层、漏了核心**。
2. **django-11149 = 弃权。** 超时（25min）SIGTERM 后，agent 的 pip/子进程仍在写 worktree →"写入已停止"安全收尾拦下未提交 diff → runner_fault / 空。**可通过"超时杀整个进程组"修复，避免弃权。**

- **本批无 pilot 那种 Rosetta 假阴性**（8/10 是干净真分）。

## 五、结论 & 改进项

- **结论**：盲改条件 8/10（本批 10 题全 django、偏易，仍是乐观样本）。与 pilot 合计 **官方 15/20**；校正 pilot-10097 假阴性后 **真实 16/20**。
- **agent 的稳定失败模式**（两批共见）：
  1. **表层改动、漏核心逻辑**（10999、11141）：改到相关文件/函数，但只做了表面 hunk，漏掉让测试转绿的关键逻辑。
  2. **超时弃权**（10554、11149）：卡在无验证的死循环里打转，撞墙钟又有孤儿写入 → 交不出卷。
- **改进项**：
  1. **修"超时杀进程组"**：超时题不再弃权（救 10554/11149 这类 → 潜在 +2/20）。
  2. **给测试反馈（in-container）**：两批的 miss 多是"没验证→猜/表层"，有反馈能显著减少表层 miss——这是提分主路径。
  3. **判分 Rosetta 校正**：满 50 判分时对"patch≈gold 却 unresolved"的题用 gold 复核（pilot-10097 已中招一次）。

---
*agent 产物：`eval/runs/2026-09-25T13-06-21-734Z/`（preds.jsonl / results.json / manifest.json / 逐题 patch.diff+agent.log）。判分报告：`/tmp/swebench-report/step-5-preview.batch11-20-g1.json`。前 10 题报告：`eval/reports/batch-1-10-pilot.md`。*
