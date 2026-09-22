# PayasoAgent 文档索引

> 本文档是 `docs/` 目录的导航入口。目录按主题分类，`architecture-current.md` 作为「活基线」留在根目录。

## 快速入口

| 你想…… | 看这里 |
|---|---|
| 搞清楚系统现在长什么样 | [`architecture-current.md`](./architecture-current.md) |
| 理解沙箱是怎么守住的 | [`sandbox/sandbox-mental-model.md`](./sandbox/sandbox-mental-model.md) |
| 查某个方案的实施计划 / 状态 | [`plans/`](./plans/) 下对应文档 |
| 查发布 / 打包怎么操作 | [`distribute/npm-publish-runbook.md`](./distribute/npm-publish-runbook.md) |
| 查第三方库用法 | [`guides/pi-ai-使用指南.md`](./guides/pi-ai-使用指南.md) |

## 目录结构

```
docs/
├── architecture-current.md   # 当前架构基线（活文档，docs-contract 测试锁它）
│
├── architecture/             # 历史设计基线（描述“曾经怎么设计 / 冻结的边界”）
│   ├── v1.0-design.md
│   ├── v1-baseline.md
│   ├── runtime-kernel-freeze.md
│   ├── harness-boundary.md
│   ├── refactoring-v1.8-v1.10.md
│   └── architecture-v1.0.svg
│
├── sandbox/                  # 沙箱与安全
│   ├── sandbox-mental-model.md           # 分层心智模型（理解入口）
│   ├── cross-platform-sandbox-plan.md    # 跨平台实施 + Windows ACL 细节
│   └── windows-mac-compat.md             # Windows 兼容性
│
├── plans/                    # 方案 / 计划 / 状态 / 审计（“要做什么、做到哪”）
│   ├── harness-phase2-plan.md / harness-phase2-status.md
│   ├── long-task-timeout-plan.md
│   ├── agent-plan-and-task-status.md
│   ├── quality-hard-boundaries-plan.md / quality-repair-closure-plan.md
│   ├── next-phase-quality-plan.md
│   ├── large-file-responsibility-split-plan.md
│   ├── task-delivery-and-reuse-plan.md
│   ├── thinking-level-plan.md
│   ├── phase2-session-persistence.md
│   └── workspace-picker-browse-review.md
│
├── web/                      # 前端 / UI
│   ├── streaming-markdown-incremental.md
│   ├── streaming-render-optimization.md
│   ├── session-smoothness-audit.md
│   ├── turn-navigator.md
│   ├── pwa-desktop-install.md
│   └── multimodal-format-preview.{png,svg}
│
├── distribute/               # 发布 / 分发
│   ├── npx-distribution-plan.md
│   └── npm-publish-runbook.md
│
├── guides/                   # 使用指南 / 操作手册
│   ├── pi-ai-使用指南.md
│   └── task-constraints-usage.md
│
└── attachment/               # 附件处理
    └── attachment-v2-content-store.md
```

## 约定

- **`architecture-current.md` 永远在根目录**：`tests/docs-contract.test.ts` 硬编码检查它，
  它是「当前系统真相」的单一来源，新增工具/事件必须同步更新其中的契约块。
- **历史基线进 `architecture/`，进行中的计划进 `plans/`**：属性不同，别混放。
- 文档间引用一律用**带 `docs/` 前缀的完整路径**（如 `docs/sandbox/sandbox-mental-model.md`），
  避免跨目录相对路径失效。代码注释引用 docs 时同理。
- `archify/`（架构图产物）与 `baseline/`（基线输出）为生成产物，不参与手写文档分类。