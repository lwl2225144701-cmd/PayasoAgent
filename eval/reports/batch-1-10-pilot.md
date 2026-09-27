# SWE-bench Verified 评测报告 · 批次 1–10（pilot）

- **日期**：2026-09-25
- **被测 agent**：PayasoAgent（本仓库 `src/cli.ts`），模型 **step-5-preview**（StepFun `step_plan` 端点）
- **题集**：SWE-bench Verified 固定 50 题清单的**前 10 题**（分层抽样、清单写死、可复现）
- **评测模式**：**patch-only / 盲改**（agent 无测试环境，只读代码 + 交 `git diff`；正确性交给官方 harness 判）
- **agent 侧 run**：`eval/runs/2026-09-25T07-08-39-368Z/`；**判分 run_id**：`pilot10-g2`
- **配置**：并发 3 · 单题墙钟 25min · 模型 env 兜底（`--env-file eval/.env`）

> agent 侧驱动方式：外挂 `eval/` 逐题 spawn PayasoAgent CLI（`--workspace <克隆仓库>`），进程退出即权威停止信号；policy 检测改测试 → `git apply --check` 预检 → 决策链。

## 一、总成绩

| 口径 | 数 |
|---|---|
| 官方 harness：**resolved** | **7 / 10** |
| unresolved（patch 干净但没修对） | 2 |
| empty（交的空 patch） | 1 |
| **校正后真实命中**（含 gold 复核，见 §四） | **8 / 10** |

`preds.jsonl` 恰好 10 行（固定分母 10，空卷也计入、不剔除）。

## 二、逐题明细

| 实例 | agent 侧 | 官方判定 | 结论 |
|---|---|---|---|
| astropy__astropy-12907 | ok, 1169B, 12.5min | ✅ resolved | 修对（上轮曾 4.26MB 报废） |
| astropy__astropy-13033 | ok, 2733B, 10.2min | ✅ resolved | 修对 |
| django__django-10880 | ok, 699B, 10.2min | ✅ resolved | 修对 |
| django__django-10914 | ok, 4353B, 19.7min | ✅ resolved | 修对 |
| django__django-10973 | ok, 2547B, 4.5min | ✅ resolved | 修对 |
| django__django-11066 | ok, 827B, 6.3min | ✅ resolved | 修对 |
| django__django-11087 | ok, 2561B, 25.1min **（超时但提交）** | ✅ resolved | 超时未误事 |
| django__django-10097 | ok, 658B, 20.6min | ❌ unresolved | **假阴性**（patch≡gold，见 §四） |
| django__django-10999 | ok, 557B, 9.0min | ❌ unresolved | 真 miss（改法太浅，见 §四） |
| django__django-10554 | **runner_fault, 0B, 25.2min** | ⬜ empty | 超时弃权（孤儿写入，见 §四） |

- agent 侧 9/10 `ok`（提交了干净可 apply 的 patch），仅 10554 弃权。
- astropy-12907 是本批亮点：早前用 60min 墙钟跑到 4.26MB 编译垃圾报废；**改 25min 闸后**同一题交干净 1169B 并 resolved——**砍墙钟防止它滑进"自己编译搭环境"的死胡同**。

## 三、官方判分口径

`swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified`，本地 Docker（amd64 镜像 / arm64 Rosetta 模拟）。一个实例 resolved ⟺ apply 你的 patch 后，其隐藏的 FAIL_TO_PASS 测试从"改前红"变"改后绿"。

## 四、三道"没分题"的定性（关键）

1. **django-10097 = 判分假阴性，不是 agent 错。**
   agent 交的 patch 与 gold **逐字节相同**（`django/core/validators.py` 的 URLValidator user:pass 正则）。但 FAIL_TO_PASS 里 7 个**无关的 `auth_templates` 模板测试**在 Rosetta 下偶发失败。**实跑 gold 也判 unresolved**（`gold-10097-check`），证明是**arm64/Rosetta 环境抖动**，非修复错误 → **本题应计为修对**。
2. **django-10999 = 真 miss。** 改对了文件+函数（`dateparse` 时长正则），但只做表层 lookahead 微调；gold 是加 `sign` 捕获组的正规重构。无回归，但没真修好负时长解析。
3. **django-10554 = 弃权。** 超时（25min 墙钟）后 SIGTERM 只杀了 agent 主进程，其 pip/子进程继续写 worktree →"写入已停止"安全检查拦下未提交 diff → runner_fault / 空。**可通过"超时杀整个进程组"修复避免弃权。**

## 五、结论 & 改进项

- **结论**：patch-only / 盲改（无测试反馈）条件下，agent 实际修对 **8/10**（官方记 7/10，被 Rosetta 假阴性黑 1 分）；1 题真没修对（10999），1 题超时弃权（10554）。前 10 题 django 偏多偏易，是**乐观样本**；真实水位需跑满 50 题。
- **改进项（按收益排序）**：
  1. **修"超时杀进程组"**：`spawn(..., {detached:true})` + 超时 `process.kill(-pid,'SIGTERM')` → 超时题不再弃权（救 10554 这类）。
  2. **判分环境修正**：arm64/Rosetta 偶发假阴性；对"patch≈gold 却 unresolved"的题用 gold 复核，或换 x86 判分，避免低估。
  3. **删 Docker daocloud 镜像源**（`~/.docker/daemon.json` 仍含 daocloud 白名单源）：满 50 判分拉更多镜像时会被白名单挡死。
  4. **冲更高分**：in-container 模式（给测试反馈，patch-only 是保守下限）。

---
*agent 侧产物：`eval/runs/2026-09-25T07-08-39-368Z/`（preds.jsonl / results.json / manifest.json / 逐题 patch.diff+agent.log）。判分报告：`/tmp/swebench-report/step-5-preview.pilot10-g2.json`；gold-10097 复核：`/tmp/swebench-gold-10097/`。*
