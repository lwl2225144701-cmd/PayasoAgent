// 受控工具链准备协议。
//
// 这不是 Shell 的扩权接口：模型只能请求固定白名单中的工具，不能传入
// brew 命令、参数、路径或安装源。真正的安装动作由 Host 在用户明确批准后
// 交给 macOS 专用 preparer 执行。

export type ToolchainPreparationSource = 'homebrew';

export interface ToolchainPreparationPlan {
  toolName: 'git' | 'node' | 'npm';
  packageName: string;
  source: ToolchainPreparationSource;
  displayName: string;
}

export interface ToolchainPreparationRequest {
  runId: string;
  toolName: ToolchainPreparationPlan['toolName'];
  packageName: string;
  source: ToolchainPreparationSource;
  timestamp: string;
}

export type ToolchainPreparationPhase = 'checking' | 'installing' | 'verifying';
export type ToolchainPreparationObserver = (phase: ToolchainPreparationPhase) => void;

export type ToolchainPreparationStatus =
  | 'prepared'
  | 'denied'
  | 'unavailable'
  | 'failed'
  | 'aborted'
  | 'timed_out';

export interface ToolchainPreparationResult {
  approved: boolean;
  prepared: boolean;
  status: ToolchainPreparationStatus;
  // 稳定、可展示的诊断文案；禁止放入宿主绝对路径或安装器原始输出。
  message?: string;
  // v1.6 工具链闭环 ①：prepared 时由 Host 填充刷新后的全局能力快照
  // （经准备结果通道流回 agent，刷新当前 Run 的 Harness 模型视图）。
  capabilities?: import('./toolchain-manager.js').RuntimeToolchainCapabilities;
}

export interface ToolchainPreparationPort {
  request(
    req: ToolchainPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ToolchainPreparationResult>;
}

// Host-side runner contract. Keeping this beside the approval protocol lets
// tests inject a deterministic runner without coupling RunManager to Homebrew.
export type ToolchainPreparationRunner = (
  plan: ToolchainPreparationPlan,
  signal?: AbortSignal,
  onPhase?: ToolchainPreparationObserver,
) => Promise<ToolchainPreparationResult>;

const PLANS: Record<string, ToolchainPreparationPlan> = {
  git: {
    toolName: 'git',
    packageName: 'git',
    source: 'homebrew',
    displayName: 'Git',
  },
  node: {
    toolName: 'node',
    packageName: 'node',
    source: 'homebrew',
    displayName: 'Node.js',
  },
  npm: {
    toolName: 'npm',
    packageName: 'node',
    source: 'homebrew',
    displayName: 'npm（随 Node.js 提供）',
  },
};

/** Return a copy of the fixed plan, or undefined for an unsupported command. */
export function getToolchainPreparationPlan(
  toolName: string,
): ToolchainPreparationPlan | undefined {
  const plan = PLANS[toolName];
  return plan === undefined ? undefined : { ...plan };
}

export const denyAllToolchainPreparationPort: ToolchainPreparationPort = {
  async request() {
    return {
      approved: false,
      prepared: false,
      status: 'denied',
      message: 'Dependency preparation was not authorized.',
    };
  },
};
