# SWE-bench Verified 评测报告 · 批次 31–40

- **日期**：2026-09-25 / 27
- **被测 agent**：PayasoAgent（`src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan`）
- **题集**：固定 50 题清单第 31–40 题（`--offset 30 --limit 10`；xarray / pylint / pytest / scikit-learn / sphinx，无 django）
- **模式**：**patch-only / 盲改**（无测试环境，只读代码 + 交 `git diff`，正确性交官方 harness）
- **agent 侧 run**：`eval/runs/2026-09-25T16-26-01-890Z/`；**判分 run_id**：`batch31-40-g2`
- **配置**：并发 3 · 单题墙钟 25min · 超时杀进程组 · **clone/ENOBUFS 自动重试（本轮新上）**

## 一、总成绩

| 口径 | 数 |
|---|---|
| 官方 harness：**resolved** | **6 / 10** |
| unresolved | **0** |
| empty（空 / 未交） | 4 |
| **提交的 patch 命中率** | **6 / 6 = 100%** |

**本批最亮眼的一点：agent 只要交了卷就全对**（6 个非空 patch 全部 resolved，unresolved = 0）。失分全部来自"没交卷"（4 空），没有一个"交错了"。

## 二、逐题明细

| 实例 | repo | agent 侧 | 官方判定 | 结论 |
|---|---|---|---|---|
| scikit-learn-10297 | sklearn | ok, 1613B, 2.5min | ✅ resolved | 修对 |
| scikit-learn-10844 | sklearn | ok, 693B, 5.3min | ✅ resolved | 修对 |
| scikit-learn-10908 | sklearn | ok, 1463B, 13.4min | ✅ resolved | 修对 |
| pylint-4551 | pylint | ok, 4725B, 25.9min（超时） | ✅ resolved | 修对 |
| pytest-10081 | pytest | ok, 1011B, 25.1min（超时） | ✅ resolved | 修对 |
| xarray-2905 | xarray | ok, 625B, 25.5min（超时） | ✅ resolved | 修对 |
| xarray-3095 | xarray | **empty_patch, 0B**（超时） | ⬜ empty | 读了 25min 没改一行 |
| sphinx-10323 | sphinx | **empty_patch, 0B**（超时） | ⬜ empty | 同上 |
| sphinx-10435 | sphinx | **empty_patch, 0B**（超时） | ⬜ empty | 同上 |
| pytest-10051 | pytest | **policy_invalid, 1892B** | ⬜ empty | 碰了测试文件（A2 拦） |

## 三、本轮基建异常的处理（记录在案）

1. **首跑时 sphinx ×2 `git clone` 失败、xarray-3095 `git ENOBUFS`**（`spawnSync git ENOBUFS` 系统缓冲区耗尽）→ 记为 runner_fault。
2. **处置**：给 eval 加了 **clone/ENOBUFS 自动重试**（`gitRetry`）+ **`--only <ids>` 单点重跑**开关；sphinx 克隆重试第 1 次即成功。
3. **重跑 3 题结论**：基建修复生效（sphinx 从"0.0min 秒挂"变为"真跑满 25min"），但这 3 题 agent **纯读代码、一个 patch 都没写** → 最终 `empty_patch`。**不是基建冤枉，是盲改在 sphinx/xarray 难题上空手而归。**

## 四、"没分题"定性（4 空，均非"判错"）

- **xarray-3095 / sphinx-10323 / sphinx-10435 = 空手而归**：25min 内只读不改，交 0B。盲改天花板在难题上的表现——**不是改错，是没敢改/没改出来**。（同 astropy-12907 打转型，但那次至少交了一坨，这次连一坨都没有。）
- **pytest-10051 = policy 拦截**：agent 建了 `test_repro.py`（复现脚本），A2 政策按"改测试文件"作废交空。策略正确，但连坐了可能存在的源码修复。

## 五、结论 & 改进项

- **结论**：盲改 6/10，**提交即全对（6/6）**。四批累计 **官方 27/40**（7+8+6+6）；校正 pilot-10097 假阴性后 **真实 28/40（~70%）**。离开 django 后难度上升，但 agent 的**精度（precision）极高、召回（recall）受限于"没验证 → 不敢交/交不出"**。
- **改进项（按收益）**：
  1. **in-container 给测试反馈** —— 直击本批核心矛盾：agent "提交必对"说明它会改，但难题上没反馈就不敢/不会落到可提交的修改，空卷拖低 recall。这是提分主路径。
  2. **patch 捕获排除构建/复现产物** —— 治 pytest-10051 那类 `test_repro.py` 被连坐（以及 21-30 批 11265 的 966KB 垃圾卷）。
  3. **超时杀进程组补"PID 树遍历"兜底** —— 治逃逸子进程导致的弃权（本批 xarray-3095 早期 ENOBUFS 也属同类资源问题，已由重试缓解）。

---
*agent 产物：`eval/runs/2026-09-25T16-26-01-890Z/`；判分报告：`/tmp/swebench-report/step-5-preview.batch31-40-g2.json`；重跑（3 题）：`eval/runs/2026-09-27T06-52-03-825Z/`。前几批报告见 `eval/reports/`。*