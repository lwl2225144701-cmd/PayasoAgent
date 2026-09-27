# SWE-bench Verified 评测报告 · 批次 41–50（末批）

- **日期**：2026-09-27
- **被测 agent**：PayasoAgent（`src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan`）
- **题集**：固定 50 题清单第 41–50 题（`--offset 40 --limit 10`；sphinx 尾 + sympy 为主，全 50 里最难）
- **模式**：**patch-only / 盲改**（无测试环境，只读代码 + 交 `git diff`，正确性交官方 harness）
- **agent 侧 run**：`eval/runs/2026-09-27T08-51-09-002Z/`；**判分 run_id**：`batch41-50-g2`
- **配置**：并发 3 · 单题墙钟 25min · 超时杀进程组 · clone/ENOBUFS 自动重试

## 一、总成绩

| 口径 | 数 |
|---|---|
| 官方 harness：**resolved** | **5 / 10** |
| unresolved | 1 |
| empty（空 / 未交） | 4 |
| 提交命中率 | 5 / 6 ≈ 83% |

## 二、逐题明细

| 实例 | agent 侧 | 官方判定 | 结论 |
|---|---|---|---|
| sympy-11618 | ok, 1303B, 15.5min | ✅ resolved | 修对 |
| sympy-12096 | ok, 601B, 25.1min（超时） | ✅ resolved | 修对 |
| sympy-12489 | ok, 9296B, 15.4min | ✅ resolved | 修对 |
| sympy-13031 | ok, 114495B, 25.1min（超时） | ✅ resolved | 修对（patch 偏大） |
| sympy-13372 | ok, 832B, 14.5min | ✅ resolved | 修对 |
| sphinx-10449 | ok, 3879B, 25.4min（超时） | ❌ unresolved | 交了脚手架没修源码（见 §四） |
| sphinx-10466 | **empty_patch, 0B**（超时） | ⬜ empty | 读了 25min 没改一行 |
| sympy-12419 | **policy_invalid, 58MB!** | ⬜ empty | 巨脏卷 + 碰测试 |
| sympy-12481 | **policy_invalid, 2.9MB** | ⬜ empty | 巨脏卷 + 碰测试 |
| sympy-13091 | **policy_invalid, 2.5MB** | ⬜ empty | 巨脏卷 + 碰测试 |

## 三、本批最突出的问题：**patch 污染在 sympy 上失控**

3 题 policy_invalid 的 patch 体积分别是 **58MB / 2.9MB / 2.5MB**——agent 在 sympy 上反复构建/跑测试，`git add -A` 把生成物全卷进来，还顺带碰到测试文件（被 A2 拦）。这是"**捕获不排除构建产物**"这个已知缺陷在 sympy 上的极端放大。

即便未被 policy 拦，几十 MB 的脏卷也几乎不可能在判分侧干净 apply + 通过测试。**这是当前 eval 最该修的一项**（下一批/正式跑前必做）。

## 四、未解题定性（真 miss）

- **sphinx-10449 = 忙着搭环境，没修源码。** agent 交的是 `scratch.sh`、`$TMPDIR/setup_and_build.sh` 等脚手架脚本；gold 改的是 `sphinx/ext/autodoc/typehints.py`（真源码）。与 21-30 批的 django-11265 **完全同型**：没测试反馈 → 沉迷自建验证 → 忘了改源码。
- **sphinx-10466 = 空手而归**（25min 只读不改）。
- **sympy-12419/12481/13091 = policy 拦截**（巨脏卷 + 碰测试）。

## 五、结论

- 盲改 5/10（提交命中 5/6）。**末批最难的 sympy 仍拿下 5 题**（sympy-11618/12096/12489/13031/13372），说明 agent 的**数学/符号类源码理解力不弱**；失分主要来自"没验证 → 搭脚手架/巨脏卷/空手归"。
- 与全 50 合计见 `eval/reports/final-50-summary.md`。

---
*agent 产物：`eval/runs/2026-09-27T08-51-09-002Z/`；判分报告：`/tmp/swebench-report/step-5-preview.batch41-50-g2.json`。*
