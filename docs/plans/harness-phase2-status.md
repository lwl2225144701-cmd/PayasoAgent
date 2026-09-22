# Harness Phase 2 — 实施状态

> **规划文档**：见 `harness-phase2-plan.md`（原规划稿）
> **版本锚点**：v2.2（Step 1-4 全部完成）
> **基线**：Runtime Kernel 不变；所有改动落在 Harness / Host / Bootstrap

---

## 实施总览

| Step | 名称 | 状态 | 新增文件 | 修改文件 |
|------|------|------|----------|----------|
| 1 | InstructionComposer 段落化 | ✅ 已完成（先于本实施批次落地） | `src/harness/instruction-composer.ts` | `src/harness/instructions.ts` / `context-harness.ts` / `model-context.ts` |
| 2 | PAYASO.md 项目级指令 | ✅ 已完成 | — | `src/runtime/contracts.ts` / `src/bootstrap/runtime-bootstrap.ts` / `src/host/run-manager.ts` / `src/harness/instructions.ts` / `src/harness/context-harness.ts` |
| 3 | Skills 渐进披露 + `loadSkill` 工具 | ✅ 已完成 | — | `src/tools/runtime-tools.ts` / `src/harness/context-harness.ts` / `src/host/run-manager.ts` |
| 4 | Prompt 命令（`/cmd`） | ✅ 已完成 | — | `src/host/run-manager.ts` |

---

## Step 1: InstructionComposer 段落化

**状态**：提前完成（Phase 2 规划稿阶段已落地）。

- 接口：`SystemSegment { id, priority, content, budgetTokens, mutability }`
- 核心方法：`addSegment` / `updateContent` / `removeSegment` / `compose(maxTokens)` / `diagnostics()`
- 预算策略：段内自截断 → 总计超预算时从低 priority 段整段丢弃 → `kernel.base` 永不丢
- 静态段在前，动态段在后，最大化 prompt cache 命中率

已注册段（按 priority 升序）：

| id | priority | mutability | 来源 |
|----|----------|-----------|------|
| `kernel.base` | 10 | static | `BASE_SYSTEM_PROMPT` |
| `model.adaptation` | 20 | static | `MODEL_CAPABILITIES[].promptNotes` |
| `project.instructions` | 30 | per_run | PAYASO.md（Step 2） |
| `skills.index` | 40 | per_run | Skill 索引（Step 3） |
| `platform.permission` | 50 | per_run | `permissionSystemPrompt()` |
| `platform.toolchain` | 60 | dynamic | `toolchainSystemPrompt()` |
| `platform.network` | 70 | dynamic | `networkSystemPrompt()` |
| `env.context` | 90 | dynamic | `envContextPrompt()` |

---

## Step 2: PAYASO.md 项目级指令

**状态**：✅ 已完成。

**文件位置**：workspace 根目录 `PAYASO.md`（纯 Markdown，无 frontmatter）。

**注入方式**：作为 `<project_instructions>` 标签包裹的段，插入 system prompt 第 3 位（priority 30）。Budget 8192 tokens。

**安全门（Trust 简化版）**：

| permission mode | 是否加载 PAYASO.md |
|-----------------|---------------------|
| `read-only` | ❌ 不加载 |
| `workspace-write` | ✅ 加载 |
| `full-access` | ✅ 加载 |

**Host 侧实现**：
- `readProjectInstructions(workspaceRoot, permissionMode)`：同步读取，文件不存在/超 32KB/权限不足均返回空串（fail-closed 对内容降级，对权限严格）
- Run 启动时快照，运行中不变（per_run 语义）

**Harness 侧 API**：
- `DefaultContextHarness.setProjectInstructions(content)`：动态更新 / 移除项目指令段

---

## Step 3: Skills 渐进披露

**状态**：✅ 已完成。

**目录结构**：`<workspace>/.payaso/skills/<skill-name>/SKILL.md`

**SKILL.md 格式**：frontmatter（name / description / version） + Markdown 正文。未知字段忽略（fail-closed）。

**加载流程**：
1. Host 启动时扫描 `.payaso/skills/`，每个目录解析 frontmatter，生成 `SkillManifest[]`
2. 注入 Harness → 注册 `skills.index` 段（单行 name+description 列表）
3. LLM 通过 `loadSkill` 工具按需加载完整 SKILL.md
4. Skill 正文作为 **tool 消息** 进入 transcript，复用裁剪 / 摘要 / checkpoint 全套机制

**`loadSkill` 工具**：
- 效果：`read`（只读）
- 参数：`name`（kebab-case，`/^[a-z][a-z0-9-]{0,63}$/`）
- 路径安全：严格字符集 + 归一化，逃逸直接拒绝
- 大小上限：32KB（超限截断），transcript output guard 二次保险

**去重**：同 name 的 `loadSkill` 由现有 `operationIdentity` 机制保证幂等。

**安全门**：read-only 模式不扫描也不暴露 skills 索引。

---

## Step 4: Prompt 命令（`/cmd`）

**状态**：✅ 已完成。

**目录结构**：`<workspace>/.payaso/prompts/<cmd-name>.md`

**Prompt 格式**：frontmatter（name / description） + Markdown 模板正文。

**参数插值语法**（与 pi-agent 一致）：

| 语法 | 含义 |
|------|------|
| `$1`, `$2`, ... | 第 n 个参数 |
| `$@` | 所有参数（空格连接） |
| `${1:-default}` | 第 1 个参数，缺省值为 default |

**执行流程**：
1. Host 启动 Run 时扫描 `.payaso/prompts/`，构建命令注册表
2. 用户输入以 `/` 开头 → 尝试匹配命令名
3. 匹配成功：参数插值展开为完整 user message → 进入 transcript
4. 匹配失败：原样作为普通 user message（不报错，降级自然）

**安全门**：read-only 模式不加载。

**注意**：前端自动补全（命令列表 API）尚未实现（当前为纯 Host 侧展开）。后续补充 `/prompts` API 端点。

---

## 测试状态

全量套件：**47 / 48 PASS**

唯一失败：`runtime-tools` 套件 1 个用例（sandbox-exec 环境限制，既有问题，非 Phase 2 引入）。

Step 级测试覆盖：
- Step 1 InstructionComposer：通过 context-harness / toolchain-refresh / toolchain-manager 间接覆盖
- Step 2 PAYASO.md：通过 RunManager 集成路径 + Harness composer 间接覆盖
- Step 3 Skills / loadSkill：通过 runtime-tools 注册 + Harness setSkills 间接覆盖
- Step 4 Prompt 命令：通过 RunManager createInSession 路径间接覆盖

---

## 已知未做（与规划一致）

- 全局 `~/.payaso/` 目录（规划属 v2）
- `SYSTEM.md` 整体替换（规划属 v2，风险高）
- 多级 project 指令合并（子目录覆盖）
- TS Extensions 插件系统
- MCP / 外部工具协议
- 前端 Prompt 命令自动补全 API（待补）
- Memory / RAG / 长期记忆

---

## 向后兼容

所有新能力**默认关闭**：
- 无 `PAYASO.md` → 无 project.instructions 段
- 无 `.payaso/skills/` → 无 skills.index 段，`loadSkill` 工具不返回任何 skill
- 无 `.payaso/prompts/` → `/xxx` 作为普通消息处理
- `read-only` 模式下三项全部不加载，行为与 Phase 2 前完全一致

Runtime Agent Loop 语义零变更。
