import { type ChatMessage, chat, type ModelConfig, type ToolSchema } from '../llm/llm.js';

/** P2-E：复现"上一请求的真前缀"，让 provider 的 KV 缓存命中。 */
export interface ConversationSummaryPrefix {
  /** 上一请求的 system 文本（内核指令）。 */
  system: string;
  /**
   * 上一请求的 tools。OpenAI 兼容接口把 tools 放在 messages 之前，所以它的
   * 序列化结果也是前缀的一部分——不一致就会在第一个字节处 miss，整段白读。
   */
  tools: ToolSchema[];
}

export interface ConversationSummaryRequest {
  previousSummary: string;
  messages: ChatMessage[];
  maxSummaryTokens: number;
  signal?: AbortSignal;
  /** 省略时退回"整段 JSON 塞进一条 user 消息"的冷启动写法。 */
  prefix?: ConversationSummaryPrefix;
}

export interface ConversationSummarizer {
  summarize(request: ConversationSummaryRequest): Promise<string>;
}

export interface SummaryConversation {
  messages: ChatMessage[];
  tools: ToolSchema[];
  /** true = 走了"复现上一请求真前缀"的快路径（provider 缓存可命中）。 */
  cacheAligned: boolean;
}

const COLD_SYSTEM = 'You compact agent conversation history into a precise structured summary.';

function stripThink(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  if (output.includes('<think>')) output = output.split('<think>')[0];
  return output.trim();
}

function summaryHeader(request: ConversationSummaryRequest): string[] {
  return [
    'Update the durable conversation summary for an agent session.',
    `Keep it under ${request.maxSummaryTokens} tokens. Preserve concrete facts only.`,
    'Use these headings: Goal, Decisions, Progress, Tool results, Files, Constraints, Next steps.',
    'Do not invent facts and do not include hidden reasoning.',
    `Previous summary:\n${request.previousSummary || '(none)'}`,
  ];
}

/**
 * 能否原样重放：以 tool 开头的切片会被 provider 视为"没有对应调用的结果"而拒收，
 * 这种情况退回 JSON 写法（拿不到缓存，但一定可用）。
 */
function replayable(messages: ChatMessage[]): boolean {
  return messages.length > 0 && messages[0].role !== 'tool';
}

/**
 * 重放时剥掉图片与思考字段：摘要请求不走 materializeMessagesForModel（拿不到
 * workspace 去读 base64），而带 path 的图片块对 provider 是非法输入，会 400 掉
 * 整个摘要调用。代价是"含图的那条消息之后前缀不再逐字节一致"——少命中一截缓存，
 * 但摘要必然可用。
 */
function forReplay(message: ChatMessage): ChatMessage {
  const { images: _images, reasoning_content: _reasoning, ...rest } = message;
  return rest;
}

/**
 * 构造摘要请求（纯函数，便于直接断言前缀是否真的对齐）。
 *
 * 快路径把被压缩的消息**原样重放**（同一 system / tools / role / content），
 * 于是这一段的 KV 缓存直接复用——摘要调用从"整段冷启动"变成"只算新增的指令"。
 */
export function buildSummaryConversation(request: ConversationSummaryRequest): SummaryConversation {
  if (request.prefix && replayable(request.messages)) {
    return {
      messages: [
        { role: 'system', content: request.prefix.system },
        ...request.messages.map(forReplay),
        {
          role: 'user',
          content: [
            ...summaryHeader(request),
            'The conversation above is the history being compacted. Summarize it now.',
          ].join('\n\n'),
        },
      ],
      tools: request.prefix.tools,
      cacheAligned: true,
    };
  }
  const source = request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    tool: message.tool_call_id,
  }));
  return {
    messages: [
      { role: 'system', content: COLD_SYSTEM },
      {
        role: 'user',
        content: [...summaryHeader(request), `New messages:\n${JSON.stringify(source)}`].join(
          '\n\n',
        ),
      },
    ],
    tools: [],
    cacheAligned: false,
  };
}

export class LlmConversationSummarizer implements ConversationSummarizer {
  constructor(private readonly modelConfig?: ModelConfig) {}

  async summarize(request: ConversationSummaryRequest): Promise<string> {
    const { messages, tools } = buildSummaryConversation(request);
    const result = await chat(messages, tools, undefined, this.modelConfig, request.signal);
    return stripThink(result.content);
  }
}
