import { chat, type ChatMessage, type ModelConfig } from "../llm/llm.js";

export interface ConversationSummaryRequest {
  previousSummary: string;
  messages: ChatMessage[];
  maxSummaryTokens: number;
  signal?: AbortSignal;
}

export interface ConversationSummarizer {
  summarize(request: ConversationSummaryRequest): Promise<string>;
}

function stripThink(text: string): string {
  let output = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (output.includes("<think>")) output = output.split("<think>")[0];
  return output.trim();
}

export class LlmConversationSummarizer implements ConversationSummarizer {
  constructor(private readonly modelConfig?: ModelConfig) {}

  async summarize(request: ConversationSummaryRequest): Promise<string> {
    const previous = request.previousSummary || "(none)";
    const source = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      tool: message.tool_call_id,
    }));
    const prompt = [
      "Update the durable conversation summary for an agent session.",
      `Keep it under ${request.maxSummaryTokens} tokens. Preserve concrete facts only.`,
      "Use these headings: Goal, Decisions, Progress, Tool results, Files, Constraints, Next steps.",
      "Do not invent facts and do not include hidden reasoning.",
      `Previous summary:\n${previous}`,
      `New messages:\n${JSON.stringify(source)}`,
    ].join("\n\n");
    const result = await chat(
      [
        { role: "system", content: "You compact agent conversation history into a precise structured summary." },
        { role: "user", content: prompt },
      ],
      [],
      undefined,
      this.modelConfig,
      request.signal,
    );
    return stripThink(result.content);
  }
}
