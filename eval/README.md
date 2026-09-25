# eval/ —— SWE-bench Verified 评测外挂

把 **PayasoAgent 当作被测对象**、从外部驱动它跑 SWE-bench Verified，产出可提交的
prediction 与过程产物。**零 agent 源码依赖**：不 `import` 任何 `src/`，也不连 Host HTTP
API——逐题把 agent 的 **CLI 当子进程拉起**（`src/cli.ts --workspace <克隆仓库>`），进程退出
即权威的「agent 已停止」信号，再抓 `git diff` 走判分链。

> agent 内部随便重构，只要 CLI 契约（`--workspace/--permission-mode/--network-mode/--run-id`）
> 不变，本评测器就不受影响；被测对象可以是本仓库 dev 版，也可以是将来发布的 npm 版。

## 前置

1. Node ≥ 22.5；仓库根 `npm install`（含 tsx）。
2. `eval/.env`（cp 自 `.env.example`）填 step-5-preview 的 base_url / key。
3. 判分侧需要 Docker + 官方 harness（见 `docs/plans/swebench-progress.md`），与 agent 侧解耦——
   agent 侧不需要 Docker。

## 用法

```bash
# 首次：锁定数据集（从 HuggingFace 拉 500 条，含 gold；只进 eval/.cache，gitignore）
tsx --env-file=eval/.env eval/run.ts --lock
tsx --env-file=eval/.env eval/run.ts --check-list   # 校验 repo 内 50 题清单与抽样一致

# 免费自检：不调模型，验 clone→workspace→policy→apply→决策链（会 clone astropy 仓库）
tsx eval/run.ts --dry-run --limit 1

# 真跑：逐题 spawn agent CLI（step-5-preview），进程退出抓 diff
tsx --env-file=eval/.env eval/run.ts --pilot --limit 1   # 第 1 题
tsx --env-file=eval/.env eval/run.ts --pilot              # 5 题 pilot
tsx --env-file=eval/.env eval/run.ts                     # 50 题
```

live 启动前 preflight 会校验 git/node/npm、`agent CLI` 存在、`.env` 存在，并做一次**最小
chat completion 端点探活**（坏 key/端点直接拒绝启动，不白跑）。

## 每道实例怎么跑

1. 从 `github.com/<repo>` 全量 clone 到 `eval/.cache/repos`（repo 级缓存，50 题省 ~10 倍 clone）；
   `git worktree add --detach <base_commit>` 得到隔离工作区。
2. spawn：
   `node --import tsx --env-file eval/.env src/cli.ts --workspace <worktree> \
    --permission-mode workspace-write --network-mode on --run-id <instance_id> "<problem_statement + 约束>"`
   （`cwd` 固定仓库根，让 tsx 从 agent 的 node_modules 解析；`PAYASO_HOME` 隔离到 `eval/.ai-home`。）
3. 进程退出 → 静默窗口兜底 → `git add -A && git diff --cached --binary --full-index <base_commit>`。
4. A2 测试污染检测（policy）→ 干净 checkout 上 `git apply --check` 预检 → `decideSubmission`。

## 判分口径（§5.4）

分母恒为 50，分子只认官方 harness 的 resolved。提交决策唯一优先级：
`runner 故障/空 diff/policy 命中/apply 不过 → 空 patch`；只有全部干净才交实际 patch。
`timeout`/agent 非零退出只是**过程标签**，不参与判定（超时的 diff 仍照常过检提交）。
原始（含坏/违规）patch 全程留档。**50 行进、50 行出。**

## 产物（eval/runs/<UTC>/，gitignore）

```
manifest.json     # 被测 agent git commit / 模型指纹(base_url+脱敏hash) / 数据集revision+sha / 50题清单sha / 预算 / eval源码sha
preds.jsonl       # 恰好 N 行：{instance_id, model_name_or_path, model_patch}
results.json      # 逐实例 status / agentExitCode / timeout / policyHits / changedPaths / durationMs
<instance_id>/    # task.md, patch.diff(原始), agent.log(被测CLI的stdout/stderr), faults.json
```

## 判分交接

`preds.jsonl` 交给官方 harness（本地 Docker）：

```bash
HF_HOME=/tmp/swebench-hf <venv>/bin/python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --predictions_path <eval/runs/<UTC>/preds.jsonl> \
  --instance_ids ... --run_id <每次改 predictions 换新 id> --report_dir /tmp/swebench-report
```

每次改 predictions 必须换新 `--run_id`，并在 manifest 记 `grading_run_id ↔ predictions sha256`
（官方 harness 有同 run_id 复用旧结果的缓存陷阱）。
