# PAYASO.md — 仓库约定

## 验证

| 目的 | 命令 |
| --- | --- |
| 单个确定性套件 | `node --import tsx tests/<suite>.test.ts` |
| 全量确定性套件（无 LLM，146 个） | `npm run test:all` |
| 类型检查 | `npx tsc --noEmit` |
| 界面文案检查 | `npx tsx tests/helpers/i18n-check.ts [文件…]` |
| 前端生产构建 | `npm run build:web` |
| Host 集成 / E2E / 压测（需 LLM） | `npm run test:host` / `npm test` / `npm run test:stress` |

先跑与改动相关的单套验证；提交前完成类型检查与全量确定性套件。失败先单独定位，只有新改动或未解决的问题需要时才重跑。

全量日志保存在 `.payaso/logs/run-all-*.log`；复查直接读日志。长命令使用 `shell background=true` 和 `shellJob wait`。并发可用 `PAYASO_TEST_CONCURRENCY` 调整。

组件交互测试可复用 `tests/helpers/component-dom.ts` 的 `createComponentDom(source, options)`：入口按 `web/src` 解析，直接导入真实 React 组件，TSX/CSS 由 esbuild 处理，jsdom 提供 DOM/localStorage；返回的 `dom.window` 可操作事件和异步状态，结束调用 `dom.window.close()`。`options.beforeEvaluate(window)` 可设置测试用 fetch 等环境依赖。示例见 `tests/component-dom.test.ts`；布局及真实浏览器兼容性仍需浏览器验证。

## 维护

- 工具输出预算与切片统一使用 `src/tool-output-budget.ts`。
- 新增或删除工具、Trace 事件时，同步 `docs/architecture-current.md` 的机器契约块。
- 确定性套件数量以 `tests/run-all.ts` 为准；数量变化后同步 README、本文及架构文档。
- 新增或移动手写文档时维护 `docs/README.md` 索引；文档链接相对当前文件。
- 注释与文档使用中文。
