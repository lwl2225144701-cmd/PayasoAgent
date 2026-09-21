# Agent 能力测试公开数据集/基准调研报告

> 调研时间：当前会话 · 说明：本轮调研中直接抓取网页被网络策略拦截，以下信息来自公开检索结果 + 模型已有知识，规模数字可能有小误差，落地前建议以各项目官方页面为准。

## 一、按能力维度全景分类

### 1. 通用综合 Agent（General Assistant / 多步任务）
| 名称 | 规模与特点 | 获取方式 |
|---|---|---|
| **GAIA** | Meta/HF/AutoGPT 出品，466 题（166 dev 带答案 / 300 test 答案隐藏），分 Level 1–3；是目前最通行的"通用助手能力"标准题，HF 榜单最权威 | HF `gaia-benchmark/GAIA` + Leaderboard |
| **GAIA2** | 2025 推出的 GAIA 升级版，环境动态、需在沙箱内真实调用浏览器/终端/手机等工具，约 160 个任务；替代原静态 GAIA 解决污染与饱和问题 | Hugging Face 榜单 |
| **AgentBench** | 清华 THUDM，8 类环境（OS / DB / 知识库 / 网购 / 网页浏览 / 数字卡牌 / 家务 ALFWorld / 网页搜索）、27 个数据集，LLM-as-a-Judge 评分 | github: THUDM/AgentBench |
| **AgentBoard** | 港大等，把上述任务扩展为多轮 agent 评测板，提出 progress rate 做细粒度分析，附带可视化面板 | github: standardgalactic/AgentBoard |

### 2. Web / 浏览器 Agent
| 名称 | 规模与特点 |
|---|---|
| **WebArena** (CMU) | 812 个任务，5 个自托管真实站点（电商/论坛/GitLab/CMS/地图）+ Playwright，功能正确性断言验证 |
| **WebArena Verified** (ServiceNow) | 修复 WebArena 环境 bug 与标注错误后的版本，重跑可信 |
| **Mind2Web** (OSU) | 2350 个任务、137 个真实网站，离线（回放）评测，无需真跑浏览器，适合流程正确性 |
| **Mind2Web 2** (NeurIPS 2025) | 130 个任务，实时网页 + 深度搜索，采用 Agent-as-a-Judge / ORM 打分，更贴近真实搜索 Agent |
| **WebVoyager / WebLINX** | WebVoyager 15 站 643 任务（真跑）；WebLINX 10 万级离线轨迹、155 站点，偏训练+对话式导航 |
| **WebCanvas / VideoWebArena / MMInA** | 分别覆盖：多轮动态网页协作、网页视频理解、多跳多模态网页任务 |

### 3. Computer Use / GUI Agent
| 名称 | 规模与特点 |
|---|---|
| **OSWorld** | 369 个真实 OS 任务，覆盖 Chrome/LibreOffice/GIMP/VLC 等 11 个跨应用场景，可执行验证脚本，当前最强"电脑操作"标准 |
| **Windows Agent Arena** | Windows 平台版本，154 个任务，提供 Azure 虚拟机环境 |
| **AndroidWorld** (Google) | 116 个任务 / 20 个 App，程序化奖励 + 任务动态随机化（参数初始化） |
| **AndroidControl / AitW** | AndroidControl 15,283 条真机离线轨迹（高低层动作）；AitW (Android in the Wild) 约 71.5 万条多设备屏幕轨迹 |
| **Mobile-AgentBench / MobileBench** | 移动端单 App 与跨 App 任务，含失败可恢复性评估 |
| **Gym-Anything / OS-Universe** | 把任意软件打包成 agent 环境，用于扩环境泛化面 |

### 4. 编码 / 软件工程 Agent
| 名称 | 规模与特点 |
|---|---|
| **SWE-bench** | 2,294 个真实 GitHub issue，跑仓库单测判对错；衍生 Verified（500 题人工校验，OpenAI）、Lite（300 题）、Multimodal（517 JS 任务）、Multilingual（多语言）、**Pro**（规模 1,800+，抗污染，长程复杂特征开发，Scale AI） |
| **Terminal-Bench** (Stanford / Laude Institute) | 命令行终端真实难任务，容器化环境，每任务配 rubric 判分 |
| **MLE-bench** (OpenAI) | 75 场 Kaggle 比赛，按奖牌/评分衡量 ML 研发能力 |
| **SWE-Lancer** (OpenAI) | 1,486 个 Upwork 真实外包任务，按悬赏金额评估经济价值 |
| **Aider Polyglot / FeatureBench** | 前者 225 题覆盖 6 语言；后者（ICLR 2026）聚焦"复杂功能开发"而非单点 bug 修复 |

### 5. 工具调用 / Function Calling / MCP
| 名称 | 规模与特点 |
|---|---|
| **BFCL (Berkeley Function Call Leaderboard)** | 事实上的工具调用标准：V1–V4 多轮/并行/多语言 AST 级判对，V4 加入 web 搜索、代码执行、agentic 场景；HF 榜单 |
| **ToolBench / ToolEval** | 覆盖 1.6 万+ 个 RapidAPI 真实 REST API 的指令-标注对，含 Solvable / Insufficient / Realman 子集 |
| **API-Bank / ToolAlpaca / ToolSandbox** | 分别测：工具增强对话的调用正确性、合成工具数据训练、有状态（含邮箱等副作用）工具使用 |
| **MCP-Universe / MCPMark** | 面向 Model Context Protocol 的工具使用，是 2025 年后最贴近"接 MCP 工具"场景的基准 |
| **Seal-Tools / NexusBench** | 2025 年新基准，分别聚焦工具嵌入与否定/泛化场景 |

### 6. 深度检索 / 深度研究 (Deep Research Agent)
| 名称 | 规模与特点 |
|---|---|
| **BrowseComp** (OpenAI) | 1,266 个"极难找到答案"的问题，考察长链路检索 + 持久性 |
| **FRAMES** (Google) | 824 题，多跳事实检索 + 推理链联合评测 |
| **AssistantBench** | 214 个真实耗时网络任务（需跨多站点） |
| **DeepResearch Bench / LiveResearchBench / WideSearch** | 2025–2026 新一代：前者带 rubric 的深度研究报告评估；后两者分别做实时无污染评测与超宽检索覆盖 |
| **VitaBench**（中文） | 日常事务类多轮任务，需与模拟环境 + 用户偏好交互 |

### 7. 多轮对话 / 业务域 Agent
| 名称 | 规模与特点 |
|---|---|
| **τ-bench / τ²-bench** (Sierra) | 零售 + 航空 + 电信域客服，用户模拟器 + 领域政策遵循 + 数据库状态检查；τ²-bench 加强 dual-control 与污染控制 |
| **WorkArena / WorkArena++** (ServiceNow) | 企业 IT 平台（ServiceNow）上的真实企业工作流任务 |
| **CRMArena / CRMArena-Pro** (Salesforce) | CRM 元数据问答、报表生成、对话式分析等 |
| **TheAgentCompany** (CMU) | 模拟软件公司内部（GitLab/RocketChat/Plane/OwnCloud），175 个长程真实工作流 |
| **GDPval** (OpenAI) | 1320 个任务、覆盖 44 个职业的真实知识工作成果物，人工盲评 |
| **MultiChallenge** (OpenAI) | 多轮对话关键信息保持与指令遵循 |

### 8. 多 Agent 协作
| 名称 | 规模与特点 |
|---|---|
| **MultiAgentBench** (ACL 2025) | 覆盖协作与竞争两类场景，5 个应用域，做轨迹级/系统级评估 |
| **Collab-Overcooked 等** | 基于协作博弈环境的通信-协作能力评测 |

### 9. 中文 / 中国团队
| 名称 | 规模与特点 |
|---|---|
| **MSAgent-Bench**（阿里通义 iIC） | 1.1 万+ 中文任务，覆盖工具调用、GUI、搜索等，附带可训练数据 |
| **SuperCLUE-Agent**（CLUE） | 中文十大 Agent 能力评分榜，国内横向对比常用 |
| **C-SimpleQA / BrowseComp-ZH** | 中文简单事实性与中文深度检索补充 |
| **AISBench**（上海AI实验室） | 开源评测框架，已内置 τ²-bench 等多个 agent 基准的复现 |

### 10. AI 研发型 Agent（Automating AI R&D）
- **RE-Bench**（METR）、**MLAgentBench**（2023）、**PaperBench**（OpenAI，复现 ICML/NeurIPS workshop 级别论文）。

## 二、评测基础设施（Harness / 框架）

- **OSWorld / WebArena / AgentBench / BrowserGym / AgentGym**：环境层，可复用同一套 agent 脚手架横评
- **AISBench（OpenCompass 系）/ Inspect（UK AISI）/ HELM（Stanford）/ SWE-bench harness**：判分与榜单基础设施
- **LangSmith、Langfuse、DeepEval、OpenAI Evals**：线上追踪 + 自建评测流水线
- **Agent-as-a-Judge（Mind2Web 2 / GAIA2 采用）**：用 agent 当裁判，减少规则判分覆盖率不足

## 三、选型建议（按你要测的能力）

1. **只想知道"模型行不行"（通用水平）**：GAIA2 + AgentBench/SuperCLUE-Agent
2. **你的产品是浏览器/RPA 类**：WebArena Verified + Mind2Web 2（真跑回放双保险）
3. **你的产品是 Computer Use / GUI**：OSWorld（+ Windows Agent Arena / AndroidWorld 按平台选）
4. **你的产品是 Coding Agent**：SWE-bench Verified（入门）→ SWE-bench Pro + Terminal-Bench（真实性）→ SWE-Lancer / MLE-bench（经济价值）
5. **你的产品核心是调工具/MCP**：BFCL V4 + MCP-Universe + ToolBench
6. **做深度研究/搜索类**：BrowseComp + FRAMES + AssistantBench
7. **客服/业务流落地**：τ²-bench + TheAgentCompany + GDPval
8. **多 Agent 编排**：MultiAgentBench + TheAgentCompany

## 四、使用注意事项

- **污染与饱和**：GAIA、WebArena、SWE-bench Lite 已接近饱和或存在泄漏，优先用 Verified/Pro/GAIA2 这类清洗版本；MLE-bench/BrowseComp 相对更抗污染。
- **test split 答案不可见**：GAIA、BrowseComp 等需要提交服务器评测，做内部选型建议用 dev/验证集。
- **静态回放 vs 真实环境**：Mind2Web 类离线回放便宜但测不出"网页变了怎么办"；真跑浏览器/OS 的可信度高但成本高、方差大（建议 pass@k + 多次运行）。
- **成本**：OSWorld/WebArena 一次完整评测通常需要几十到几百美元级别的 token 开销，多模型横评前先在小抽样上校准流程。
- **判分口径**：优先选带可执行断言（SWE-bench、WebArena）或 DB 状态检查（τ-bench）的基准，避免只看 LLM-as-a-Judge 一次率。
- **自建内部集**：公开 benchmark 只保证横向可比，建议再抽取自己业务场景 50–200 条做私有评测集，作为上线前主指标。
