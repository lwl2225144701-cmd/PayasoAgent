# SWE-bench Verified · 满 50 题总结报告

- **日期**：2026-09-25 ~ 09-27
- **被测对象**：PayasoAgent（本仓库 `src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan`）
- **题集**：SWE-bench Verified 固定 50 题子集（分层抽样、清单写死、可复现）
- **模式**：**patch-only / 盲改**——agent 无测试环境，只读代码、交 `git diff`；正确性全部交**官方 harness** 判
- **驱动**：`eval/` 外挂逐题 spawn agent CLI（进程退出即停止信号）；判分在本地 Docker（amd64 镜像 / arm64 Rosetta）
- **配置**：并发 3 · 单题墙钟 25min · 超时杀进程组 · clone/ENOBUFS 自动重试

---

## 一、最终成绩

| 批次 | 题构成 | 官方 resolved | 校正后 |
|---|---|---|---|
| 1–10 | django + astropy | 7 / 10 | **8 / 10**（10097 为 Rosetta 假阴性） |
| 11–20 | 纯 django | 8 / 10 | 8 / 10 |
| 21–30 | django + matplotlib + requests | 6 / 10 | 6 / 10 |
| 31–40 | sklearn / pytest / pylint / xarray / sphinx | 6 / 10 | 6 / 10 |
| 41–50 | sphinx + sympy | 5 / 10 | 5 / 10 |
| **合计** | | **32 / 50 = 64%** | **33 / 50 = 66%** |

**结果分布（50 题）**：`resolved 32 · 交卷但没修对 6 · 空卷/未交 12`

---

## 二、agent 的能力画像（本次评测最重要结论）

**高精度、低召回**：

- **交了卷基本就对**：31–40 批 **6/6** 命中、11–20 批 8/9——unresolved 里只有 10097 是环境假阴性。50 题里"交卷但改错"只有 **5 题**（10%）。
- **但 12/50（24%）根本没交出可用 patch**——这是分数的主要损失来源，且**几乎全因"没有测试反馈"**：
  1. **沉迷搭环境、忘了修源码**（django-11265、sphinx-10449）：交出 `_run_*.log` / `scratch.sh` / `$TMPDIR/setup_and_build.sh` 等脚手架，真源码一行没动；
  2. **空手而归**（matplotlib-20488、sphinx-10323/10435/10466）：25min 只读不改，交 0B；
  3. **改错对象**（django-11292）：把 bug 当文档问题，改 `docs/*.txt` 而非 `django/core/management/base.py`；
  4. **碰测试文件被政策拦**（pytest-10051、sympy-12419/12481/13091）：写了 `test_repro.py` 或巨脏卷里含测试文件 → `policy_invalid` 交空。

**难度梯度**：django 密集批 7–8/10；一旦进入 matplotlib / sklearn / sphinx / sympy 就降到 5–6/10。盲改对"依赖运行时行为/测试反馈"的题明显吃亏。

---

## 三、评测过程中发现并解决/待解决的技术问题

| # | 问题 | 状态 |
|---|---|---|
| 1 | **超时弃权**：SIGTERM 只杀 agent 主进程，pip/shell 子进程继续写 worktree → "写入已停止"检查不过 → diff 抓不到、交空卷 | ✅ 已修（`detached` + 杀进程组 `killTree(-pid)`）;⚠️ 残留：逃出进程组的子进程仍会漏（sphinx 一次），需 PID 树遍历兜底 |
| 2 | **基建瞬时故障**：sphinx `git clone` 失败、xarray `spawnSync git ENOBUFS`（系统缓冲区耗尽） | ✅ 已修（`gitRetry` 自动重试 + `--only <ids>` 单点重跑） |
| 3 | **patch 捕获卷入构建/复现产物**：`git add -A` 把 `_query_patched.py`、`_run_*.log`、编译产物全算进 patch，最大到 **58MB** | ❌ **未修，最高优先级**——直接造成多题 policy_invalid / 脏卷不可判 |
| 4 | **Rosetta 假阴性**：arm64 模拟下模板类测试偶发失败，连 gold 都判 unresolved（已用 gold 复核实证 10097） | ⚠️ 判分侧需对"patch≈gold 却 unresolved"的题做 gold 复核，或换 x86 判分 |
| 5 | daocloud 镜像源白名单 403 / 偶发挂起，镜像拉取反复失败 | ⚠️ 建议移除该源；已用重试+补拉绕过 |

---

## 四、下一步优先级建议

1. **修 patch 捕获**（排除构建/复现产物：`_run_*.log`、`*.pyc`、build/、`test_repro.py` 等）——成本低、直接回收被 policy 误伤与脏卷拖低的分数；
2. **上 in-container 模式**（给 agent 测试反馈）——直击 §二 的四类失败（搭环境/空手归/改错对象/碰测试），是**提分主路径**；
3. **超时杀进程组补 PID 树遍历**——消灭残余弃权；
4. **判分环境修正**（gold 复核 / x86 判分）——消除 Rosetta 低估。

---

## 五、可复现性档案

| 项 | 值 |
|---|---|
| 50 题清单 | `eval/instances.sprint1.json`（sha256 `018a0867…`，分层抽样，写死） |
| 数据集 | `princeton-nlp/SWE-bench_Verified`，锁定 revision `verified-500-astropy__astropy-12907-sympy__sympy-24661`，sha256 `38723791…` |
| 判分数据集 | `SWE-bench/SWE-bench_Verified`（含 image/eval_script 字段） |
| 判分 harness | `swebench==5.0.2`（本地 Docker） |
| 逐批 agent 产物 | `eval/runs/<UTC>/`（preds.jsonl / results.json / manifest.json / 逐题 patch.diff+agent.log） |
| 逐批判分报告 | `/tmp/swebench-report/step-5-preview.batch*.json` |
| 分批报告 | `eval/reports/batch-1-10-pilot.md`、`batch-11-20.md`、`batch-21-30.md`、`batch-31-40.md`、`batch-41-50.md` |

*按批次纪律：manifest 记录模型指纹（base_url + key 脱敏哈希）、数据集/harness 版本、50 题清单 sha、预算参数；每次改 predictions 换新 `run_id`。*
