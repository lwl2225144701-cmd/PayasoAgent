import type { PermissionMode } from "../permission-mode.js";
import type { NetworkMode } from "../network-mode.js";

export const BASE_SYSTEM_PROMPT = `你是一个助手，可以使用工具帮助用户完成任务。
遇到任何计算任务，必须调用 calculator 工具获取结果，禁止自行计算。
当不需要工具时，直接给出最终答案。
画架构图、流程图、时序图、状态图时，必须输出 \`\`\`mermaid 代码块（前端会渲染成矢量图，主题自适应）；禁止用 ASCII 字符画——中文字符在网页等宽字体下无法对齐，框线必花。
Markdown 表格使用标准 GFM 管道语法，每行独立成行（表头行、|---|分隔行、数据行各占一行），不要把表格塞进段落。`;

// 文件系统权限提示只描述文件系统语义；网络状态独立（networkSystemPrompt）。
export function permissionSystemPrompt(mode: PermissionMode): string {
  if (mode === "read-only") {
    return "当前文件系统权限为 Read Only：只能读取当前 Workspace，禁止创建、修改、移动或删除文件；Shell 同样不可写。";
  }
  if (mode === "full-access") {
    return "当前文件系统权限为 Full access：可以使用绝对路径读写当前宿主用户有权访问的文件，仍受 macOS 用户权限、ACL、TCC 与 SIP 限制。";
  }
  return "当前文件系统权限为 Workspace Write：可以读写当前 Workspace，禁止访问 Workspace 外文件。";
}

// 网络权限独立于文件系统权限（v2.0 Network Control）：全局三态 on/off/ask，
// 由 Host/测试注入全局开关；每次拼装 system 消息时按当前模式动态生成，
// 运行中切换全局开关后提示词保持准确。
export function networkSystemPrompt(mode: NetworkMode): string {
  if (mode === "off") {
    return "当前网络权限为 Off：具备网络能力的工具会被直接拒绝，无法联网；不要尝试联网方案。";
  }
  if (mode === "ask") {
    return "当前网络权限为 Ask：具备网络能力的工具在执行前需要用户即时批准；批准前不要假设网络可用。";
  }
  return "当前网络权限为 On：可以联网，所有网络访问均有审计记录。";
}
