// 流式 Markdown 的输入预处理与分块。
//
// 背景：react-markdown 每次都把输入整体 runSync(parse)，成本 O(文本)。流式期间文本
// 每帧都在增长，若每帧全量解析，成本随累计长度线性上涨——这正是第一轮改造把流式
// 分支降级成纯文本的原因。本模块用「分块 + 尾部」把成本降到 O(尾部)，从而让流式
// 也能实时渲染 Markdown，而不必退回纯文本。
//
// 核心观察：Markdown 的块级结构一旦被空行终止就不会再变——后续追加的内容只会形成
// 新块，不会回头改写已终止的块。所以可以把累计文本切成
//   blocks（已定型，可 memo 掉解析结果）+ tail（仍在写入，每帧重解析）
// 唯一会「跨越空行」的块级结构是 fenced code（代码内部可以有空行），因此扫描必须
// 跟踪 fence 状态，绝不把 fence 内部的空行当作块边界。

/**
 * 模型输出的 fenced code 常见三种畸形：
 *   1. fence 标记拼在上一行行尾（如「### 标题 ```mermaid」）→ 解析不出代码块，源码漏成正文
 *   2. fence 行尾带杂文（```mermaid 后面还跟了字）
 *   3. 开合数量不成对 → 后续内容整体被吞进代码块
 * 渲染前统一修复，让 GFM 解析器拿到规整输入。
 */
export function normalizeFences(md: string): string {
  // 1. 行中出现的 ``` 标记推到独立行
  let out = md.replace(/([^\n`])(```+)/g, (_m, prev: string, fence: string) => `${prev}\n${fence}`);
  // 2. fence 行只保留语言标签（```lang 后面的杂文丢弃）
  out = out.replace(
    /^(```+)([\w+-]*)[ \t]+.*$/gm,
    (_m, fence: string, lang: string) => `${fence}${lang}`,
  );
  // 3. 奇数个 fence → 补一个闭合，解除"吞内容"级联
  const openings = (out.match(/^[ \t]*```/gm) ?? []).length;
  if (openings % 2 === 1) out += '\n```';
  return out;
}

export interface StreamingMarkdownSplit {
  /** 已定型的块：内容不会再变，解析结果可以安全 memo 掉 */
  blocks: string[];
  /** 仍在写入的普通 Markdown 尾部；尾部停在未闭合 fence 内时为空串 */
  tail: string;
  /**
   * 未闭合 fenced code 的**代码正文**（不含 ``` 开始行）；`null` 表示尾部不在 fence 内。
   *
   * 必须是正文而非整段源码：开始行渲染出来就是字面的 ` ```ts `，用户会在代码块里看到它。
   *
   * 也不能与 tail 合并后交给 Markdown 解析器：normalizeFences 会给奇数个 fence 补上闭合
   * 标记，把一个「流到一半的 mermaid」当成完整图表交给 MermaidBlock —— 必然语法报错，
   * 用户会看到错误提示闪烁。按纯源码渲染成代码块既正确又便宜。
   *
   * 用 `null` 而非空串表示「没有未闭合 fence」：fence 刚开启、正文还没到字符时正文也是空串，
   * 两者必须区分。
   */
  openFence: string | null;
}

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code !== 32 && code !== 9) return false; // 空格 / 制表符
  }
  return true;
}

/**
 * 该行是否为 fence 开始行。是则返回 `[标记字符, 长度]`，否则 null。
 *
 * 允许最多 3 个前导空格（CommonMark），反引号 fence 的 info string 里不允许再出现
 * 反引号（否则属于行内代码而非 fence）。
 */
function fenceOpen(line: string): [string, number] | null {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  const start = i;
  while (i < line.length && line[i] === char) i++;
  const length = i - start;
  if (length < 3) return null;
  if (char === '`' && line.slice(i).includes('`')) return null;
  return [char, length];
}

/** 该行是否闭合给定的 fence：同字符、不短于开始行、且其后只有空白。 */
function fenceClose(line: string, char: string, length: number): boolean {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  let run = 0;
  while (i < line.length && line[i] === char) {
    i++;
    run++;
  }
  if (run < length) return false;
  for (; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/**
 * 把累计的流式文本切成「已定型块 + 尾部」。
 *
 * 纯函数、单趟扫描、不构造正则：每帧调用一次，成本是廉价的字符扫描，而非 Markdown 解析。
 */
export function splitStreamingMarkdown(text: string): StreamingMarkdownSplit {
  const blocks: string[] = [];
  let blockStart = 0;
  let fenceChar = '';
  let fenceLength = 0;
  let fenceStart = -1;
  // 未闭合 fence 的正文起点（开始行之后），与 fenceStart 同生共死
  let fenceBodyStart = -1;
  let pos = 0;

  while (pos < text.length) {
    const newline = text.indexOf('\n', pos);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(pos, lineEnd);

    if (fenceChar) {
      if (fenceClose(line, fenceChar, fenceLength)) {
        fenceChar = '';
        fenceLength = 0;
        fenceStart = -1;
        fenceBodyStart = -1;
      }
    } else if (isBlank(line)) {
      // 空行且不在 fence 内 → 当前块定型（块本身不含作为分隔符的空行）
      const block = text.slice(blockStart, pos).trimEnd();
      if (block) blocks.push(block);
      blockStart = lineEnd + 1;
    } else {
      const opened = fenceOpen(line);
      if (opened) {
        fenceChar = opened[0];
        fenceLength = opened[1];
        fenceStart = pos;
        fenceBodyStart = lineEnd + 1;
      }
    }
    pos = lineEnd + 1;
  }

  if (fenceStart >= 0) {
    // 文本停在未闭合 fence 内：fence 之前的内容已经冻结（不可能再被插入内容），
    // 直接当作已定型块；fence 正文走源码渲染（不含 ``` 开始行）。
    // 注：fence 闭合后这段冻结前缀会和代码块并入同一个块，导致该块重解析一次——
    // 一次性成本，渲染结果相同。
    const frozen = text.slice(blockStart, fenceStart).trimEnd();
    if (frozen) blocks.push(frozen);
    return { blocks, tail: '', openFence: text.slice(fenceBodyStart) };
  }

  return { blocks, tail: text.slice(blockStart), openFence: null };
}
