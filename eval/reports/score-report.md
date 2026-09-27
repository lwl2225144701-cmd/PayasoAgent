# SWE-bench Verified · 跑分报告（50 题）

> 被测：**PayasoAgent**（`src/cli.ts`）· 模型 **step-5-preview**（StepFun `step_plan`）
> 模式：**patch-only / 盲改**（agent 无测试环境，只读代码交 `git diff`；判定全部由**官方 harness** 在 Docker 中完成）
> 题集：SWE-bench Verified 固定 50 题子集（分层抽样、清单写死、可复现）
> 判分：`swebench==5.0.2` · `SWE-bench/SWE-bench_Verified` · amd64 镜像 / arm64 Rosetta

---

## 一、总分

| 指标 | 值 |
|---|---|
| **官方 resolved** | **32 / 50 = 64.0%** |
| 校正后（含 Rosetta 假阴性复核） | **33 / 50 = 66.0%** |
| 交卷但没修对（unresolved） | 6 |
| 空卷 / 未交（empty） | 12 |

> 口径：**分母恒为 50**（空卷不剔除，计入 unresolved）；分子只认官方 harness 的 resolved。

## 二、分批成绩

| 批次 | 题构成 | 官方 | 说明 |
|---|---|---|---|
| 1–10 | django + astropy | **7 / 10** | 含 1 例 Rosetta 假阴性（10097） |
| 11–20 | 纯 django | **8 / 10** | 本评测最佳批 |
| 21–30 | django + matplotlib + requests | **6 / 10** | 开始混入非 django |
| 31–40 | sklearn / pytest / pylint / xarray / sphinx | **6 / 10** | 出现过克隆/ENOBUFS 基建故障（已修+重跑） |
| 41–50 | sphinx + sympy | **5 / 10** | 全 50 最难批 |

## 三、按仓库（难度梯度）

| repo | resolved | 率 |
|---|---|---|
| scikit-learn | 3 / 3 | **100%** |
| astropy | 2 / 2 | **100%** |
| psf (requests) | 1 / 1 | **100%** |
| pylint-dev | 1 / 1 | **100%** |
| django | 16 / 23 | 69.6% |
| sympy | 5 / 8 | 62.5% |
| matplotlib | 2 / 4 | 50.0% |
| pydata (xarray) | 1 / 2 | 50.0% |
| pytest-dev | 1 / 2 | 50.0% |
| **sphinx-doc** | **0 / 4** | **0.0%** |

**规律**：题量最大的 django 最稳（69.6%）；sphinx 全灭（2 例克隆故障 + 1 例空手归 + 1 例只交脚手架）。

## 四、过程指标

| 指标 | 值 |
|---|---|
| 单题用时（均值 / 中位 / 最大） | 15.5min / 15.5min / 26.0min |
| 用满 25min 墙钟（超时） | **18 / 50** |
| 0B 空 patch | 8 |
| 超大 patch（>50KB，脏卷） | 5 题：58MB / 2.9MB / 2.5MB / 966KB / 114KB |
| agent 侧 `ok`（可 apply） | 38 / 50 |
| agent 侧 runner_fault | 6（超时弃权 / 克隆失败 / ENOBUFS） |
| agent 侧 policy_invalid | 4（碰测试文件） |

## 五、失分归因（18 题未 resolved = 6 交错 + 12 空卷）

**A. 交卷但没修对（6 题，其中 1 例为环境假阴性）**

| 题 | 真实原因 |
|---|---|
| django-10097 | ⚠️ **假阴性**：patch 与 gold **逐字节相同**，但 Rosetta 下 7 个无关模板测试偶发失败（实跑 gold 也 unresolved）→ 校正后应计 resolved |
| django-10999 | 改法太浅：正则只调 lookahead，gold 是加 sign 捕获组的重构 |
| django-11141 | 半成品：做了"删空目录判断"那半，漏了 `migrated_apps` 核心条件逻辑 |
| django-11265 | **搭环境没修源码**：交的是 `_query_patched.py`/`_run_*.log` 等复现脚手架（966KB 脏卷） |
| django-11292 | **改错对象**：改了 `docs/ref/*.txt` 文档，gold 改的是 `core/management/base.py` 代码 |
| sphinx-10449 | **搭环境没修源码**：交 `scratch.sh`/`setup_and_build.sh`，gold 改 `sphinx/ext/autodoc/typehints.py` |

**B. 空卷 / 未交（12 题）**

| 类别 | 题 | 原因 |
|---|---|---|
| 超时弃权（子进程继续写 → 抓不到 diff） | django-10554、django-11149、matplotlib-20676 | 已修"杀进程组"；残余逃逸进程仍会漏 |
| 空手而归（25min 只读不改） | matplotlib-20488、sphinx-10323、sphinx-10435、sphinx-10466 | 盲改在难题上"不敢/没能落笔" |
| 政策拦截（碰测试文件） | pytest-10051、sympy-12419、sympy-12481、sympy-13091 | 写了 `test_repro.py` 或被巨脏卷带入测试文件 → `policy_invalid` |
| 基建故障 | pydata-xarray-3095 | `spawnSync git ENOBUFS`（系统缓冲区耗尽） |

## 六、能力画像

**高精度、低召回**：

- **38/50 交出了可 apply 的 patch，其中 32 个判 resolved**（提交命中率 ≈ 84%）；"交卷却改错"仅 **5 题（10%）**；
- **12/50（24%）根本没交出可用 patch** —— 这是主要失分源，且**根源几乎全是"没有测试反馈"**（搭脚手架、空手归、改错对象、碰测试）。

**盲改（patch-only）天花板**：分数受"能不能在不运行测试的情况下落笔"主导，而非受"会不会改"主导。

## 七、校正与可复现性

- **校正依据**：django-10097 的 agent patch 与官方 gold **逐字节相同**；实测**同一环境下 gold 也判 unresolved**（模板类测试 Rosetta 抖动）→ 该题按"实际修对"计入（+1）。
- **复现档案**：

| 项 | 值 |
|---|---|
| 50 题清单 | `eval/instances.sprint1.json`（sha256 `018a0867…`） |
| 数据集 | `princeton-nlp/SWE-bench_Verified`，revision `verified-500-astropy__astropy-12907-sympy__sympy-24661`，sha256 `38723791…` |
| 判分 harness | `swebench==5.0.2`（`SWE-bench/SWE-bench_Verified`） |
| 逐批 run | `eval/runs/2026-09-25T07-08-39-368Z`（1-10）· `…T13-06-21-734Z`（11-20）· `…T14-10-48-847Z`（21-30）· `…T16-26-01-890Z`（31-40）· `2026-09-27T08-51-09-002Z`（41-50） |
| 判分 run_id | `pilot10-g2` · `batch11-20-g1` · `batch21-30-g1` · `batch31-40-g2` · `batch41-50-g2` |
| 分批报告 | `eval/reports/batch-*.md` + `final-50-summary.md` |

## 八、结论

盲改模式在 SWE-bench Verified 固定 50 题子集上取得 **32/50（64%）**（校正后 66%）的**可复现起点分**。agent 表现出**很高的提交精度**（提交即 ~84% 命中）与**明显的召回瓶颈**（24% 无提交），后者由"缺少测试反馈"直接导致——**提升分数的最短路径是 in-container 模式（给测试反馈），其次是修 patch 捕获排除构建产物**。
