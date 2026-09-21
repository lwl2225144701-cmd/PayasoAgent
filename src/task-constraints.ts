// 本轮用户显式提交的约束；不从自然语言或模型工具参数推导权限。
export interface TaskConstraintsInput {
  writeScope?: string[];
  evidence?: { files: string[]; items: string[] };
}

// Host 固化的来源版本，恢复 Run 时沿用，不能重新绑定到已改变的文件。
export interface TaskConstraints {
  writeScope?: string[];
  evidence?: { sources: Array<{ path: string; sha256: string }>; items: string[] };
}
