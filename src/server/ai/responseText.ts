export interface OpenAiTextResponse {
  status?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    role?: string;
    phase?: string | null;
    status?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

// A structured final answer may follow plain-text commentary. Never feed the
// commentary (or an SDK's concatenation of both messages) into a JSON parser.
export function readOpenAiFinalText(data: OpenAiTextResponse): string | undefined {
  if (data.status !== undefined && data.status !== "completed") return undefined;
  if (data.output !== undefined && !Array.isArray(data.output)) throw new Error("invalid_openai_output_shape");
  const messages = Array.isArray(data.output) ? data.output : [];
  const final = messages.findLast((message) => message?.phase === "final_answer");
  if (final) return messageText(final);
  if (messages.some((message) => message?.phase != null)) return undefined;

  // Older Responses payloads and the SDK convenience field have no phase.
  if (typeof data.output_text === "string") return data.output_text || undefined;
  for (const message of messages) {
    const text = messageText(message);
    if (text) return text;
  }
  return undefined;
}

function messageText(message: NonNullable<OpenAiTextResponse["output"]>[number]): string | undefined {
  if (!message || (message.type !== undefined && message.type !== "message")
    || (message.role !== undefined && message.role !== "assistant")
    || (message.status !== undefined && message.status !== "completed")
    || !Array.isArray(message.content)
    || message.content.some((part) => part?.type === "refusal")) return undefined;
  const text = message.content
    .filter((part) => part && (part.type === undefined || part.type === "output_text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return text || undefined;
}
