import type { PermissionMode } from "../permission-mode.js";

export const BASE_SYSTEM_PROMPT = `你是一个助手，可以使用工具帮助用户完成任务。
遇到任何计算任务，必须调用 calculator 工具获取结果，禁止自行计算。
当不需要工具时，直接给出最终答案。`;

export function permissionSystemPrompt(mode: PermissionMode): string {
  if (mode === "read-only") {
    return "当前文件系统权限为 Read Only：只能读取当前 Workspace，禁止创建、修改、移动或删除文件；Shell 同样不可写。网络权限独立且当前不可用。";
  }
  if (mode === "full-access") {
    return "当前文件系统权限为 Full access：可以使用绝对路径读写当前宿主用户有权访问的文件，仍受 macOS 用户权限、ACL、TCC 与 SIP 限制。网络权限独立且当前不可用。";
  }
  return "当前文件系统权限为 Workspace Write：可以读写当前 Workspace，禁止访问 Workspace 外文件。网络权限独立且当前不可用。";
}
