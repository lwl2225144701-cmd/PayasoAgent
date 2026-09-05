// 模块: Tool Output Guard — 限制进入 Runtime 状态 / LLM Context 的 Tool 输出大小
// v1.3.3：Tool 可以产生完整结果，但 Runtime 绝不能把无界 Tool Output 直接带入 Agent Context。
// 原则：
//   - 按 UTF-8 byte 计算，不按 JS string.length
//   - validateResult 必须看到完整 raw result（本模块在其之后调用）
//   - <=16KB 原样返回；>16KB 确定性截断（前 ~6KB + 标记 + 后 ~4KB），不切坏 UTF-8 字符

export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024; // 16KB

const HEAD_BYTES = 6 * 1024; // 保留前 ~6KB
const TAIL_BYTES = 4 * 1024; // 保留后 ~4KB
const TRUNCATION_MARKER = '[OUTPUT TRUNCATED]';

export interface GuardedOutput {
  content: string; // 截断后内容（可能含截断标记）
  truncated: boolean; // 是否发生截断
  originalBytes: number; // 原始 UTF-8 字节数
  returnedBytes: number; // 返回内容 UTF-8 字节数
}

// 取前 n 字节（UTF-8 字符边界安全）：若 end 落在多字节字符内部（buf[end] 是续字节 10xxxxxx），
// 回退到该字符开头，避免切坏 UTF-8 字符
function headSafe(buf: Buffer, n: number): string {
  let end = Math.min(buf.length, n);
  while (end < buf.length && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

// 取后 n 字节（UTF-8 字符边界安全）：若 start 落在多字节字符内部，前进到字符开头
function tailSafe(buf: Buffer, n: number): string {
  let start = Math.max(0, buf.length - n);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++; // buf[start] 是续字节 → 位于某多字节字符内部 → 前进
  }
  return buf.subarray(start).toString('utf8');
}

// 对 Tool 结果做输出限制；<=16KB 原样返回，>16KB 确定性截断
export function guardToolOutput(result: string): GuardedOutput {
  const buf = Buffer.from(result, 'utf8');
  const originalBytes = buf.length;
  if (originalBytes <= MAX_TOOL_OUTPUT_BYTES) {
    return {
      content: result,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }
  const head = headSafe(buf, HEAD_BYTES);
  const tail = tailSafe(buf, TAIL_BYTES);
  const content = head + TRUNCATION_MARKER + tail;
  return {
    content,
    truncated: true,
    originalBytes,
    returnedBytes: Buffer.byteLength(content, 'utf8'),
  };
}
