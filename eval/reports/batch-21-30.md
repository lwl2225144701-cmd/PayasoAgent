# SWE-bench Verified 评测报告 · 批次 21–30

- **日期**：2026-09-25
- **被测 agent**：PayasoAgent（`src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan`）
- **题集**：固定 50 题清单第 21–30 题（`--offset 20 --limit 10`；本批混入 matplotlib / requests，不再是纯 django）
- **模式**：**patch-only / 盲改**（无测试环境，只读代码 + 交 `git diff`，正确性交官方 harness）
- **agent 侧 run**：`eval/runs/2026-09-25T14-10-48-847Z/`；**判分 run_id**：`batch21-30-g1`
- **配置**：并发 3 · 单题墙钟 25min · **超时杀进程组（本轮新上）**

## 一、总成绩

| 口径 | 数 |
|---|---|
| 官方 harness：**resolved** | **6 / 10** |
| unresolved | 2 |
| empty（空/未交） | 2 |
| **本批无 Rosetta 假阴性**（见 §四） | — |

这是三批中最低的一批——**符合预期**:本批起混入 matplotlib / requests（比 django 难啃），盲改天花板更低。`preds.jsonl` 10 行（固定分母）。

## 二、逐题明细

| 实例 | repo | agent 侧 | 官方判定 | 结论 |
|---|---|---|---|---|
| django-11239 | django | ok, 4164B, 10.1min | ✅ resolved | 修对 |
| django-11211 | django | ok, 1233B, 17.4min | ✅ resolved | 修对 |
| django-11276 | django | ok, 4397B, 13.2min (exit-nonzero) | ✅ resolved | 修对 |
| django-11292 | django | ok, 1377B, 25.1min **（超时）** | ❌ unresolved | 改错文件（见 §四） |
| django-11265 | django | ok, **966754B**, 25.5min **（超时）** | ❌ unresolved | 垃圾 patch，没改真源码（见 §四） |
| matplotlib-13989 | matplotlib | ok, 542B, 2.6min | ✅ resolved | 修对（最快） |
| matplotlib-14623 | matplotlib | ok, 6407B, 14.4min | ✅ resolved | 修对 |
| requests-1142 | requests | ok, 1385B, 14.0min | ✅ resolved | 修对 |
| matplotlib-20488 | matplotlib | **empty_patch, 0B, 25.1min（超时）** | ⬜ empty | 超时但没改一行代码 |
| matplotlib-20676 | matplotlib | **runner_fault, 0B, 25.1min（超时）** | ⬜ empty | 子进程逃出进程组→弃权 |

agent 侧 8/10 `ok`（交了可 apply 的 patch），2 个空（20488 无改动、20676 弃权）。

## 三、超时杀进程组修复：部分生效

- ✅ **11265、11292 超时 → 收上了 diff 并提交**（未弃权）——修复有效;
- ⚠️ **20676 仍 runner_fault**：其某个子进程**逃出了进程组**（自成 session），杀组没杀到 → 仍判定"还在写" → 弃权。这是该修复的**已知局限**（逃离组的进程需额外兜底，如按 PID 树遍历杀）。
- 20488：超时但**纯读代码、没做任何编辑** → 空卷（盲改迷路的一种）。

## 四、两道"没分题"的定性（均真 miss，无假阴性）

1. **django-11265 = 忙着搭测试脚手架，没修真源码。** agent 的 966KB patch 全是复现/日志文件（`_query_patched.py` / `_fails_with_patch.txt` / `_run_*.log` 等）；gold 改的是 `django/db/models/sql/query.py`。**没测试反馈 → 沉迷于"自己搭环境验证" → 忘了改源码 → 交一坨垃圾**（也是 patch-only 捕获构建产物的老毛病，被 966KB 放大）。
2. **django-11292 = 修错地方（改文档没改代码）。** agent 改的是 `docs/ref/django-admin.txt` + `docs/releases/3.0.txt`（文档/发行注记）；gold 改的是 `django/core/management/base.py`（代码）。**把 bug 理解成文档问题** → 无回归但没修对。
   - 二者 agent patch 与 gold **不同文件**，判定为**真 miss**（无需 gold 复核，区别于 pilot-10097 的假阴性）。

## 五、结论 & 改进项

- **结论**：盲改 6/10。三批累计 **官方 21/30**（pilot 7 + 11-20 批 8 + 本批 6）；校正 pilot-10097 假阴性后 **真实 22/30**。难度曲线开始显现（非 django 批次下降）。
- **本批暴露的两个新失败模式**（无测试反馈的典型坑）：
  1. **沉迷自建验证环境、不修源码**（11265；类似 astropy-12907 编译 astropy）;
  2. **修错对象——改文档不改代码**（11292）。
- **改进项**：
  1. **patch 捕获排除构建/复现产物**（`_run_*.log` / `_query_patched.py` / `*.pyc` / build dir 等）——否则超时题的垃圾卷污染 preds（11265 拖到 ~1MB）；
  2. **超时杀进程组补"逃逸进程"兜底**（PID 树遍历）——救 20676 这类；
  3. **in-container 给测试反馈** —— 直击本批两类 miss（沉迷自验、修错文件）：有反馈才能收敛，是提分主路径。

---
*agent 产物：`eval/runs/2026-09-25T14-10-48-847Z/`；判分报告：`/tmp/swebench-report/step-5-preview.batch21-30-g1.json`。前两批报告：`eval/reports/batch-1-10-pilot.md`、`eval/reports/batch-11-20.md`。*
