import { describe, expect, it } from "vitest";
import { readOpenAiFinalText } from "../src/server/ai/responseText";

const content = (text: string) => [{ type: "output_text", text }];

describe("OpenAI final-answer selection", () => {
  it("selects structured final output after commentary, including an SDK combined field", () => {
    expect(readOpenAiFinalText({
      status: "completed",
      output_text: 'Searching now.{"scores":{"c0":90}}',
      output: [
        { type: "message", role: "assistant", phase: "commentary", content: content("Searching now.") },
        { type: "message", role: "assistant", phase: "final_answer", content: content('{"scores":{"c0":90}}') }
      ]
    })).toBe('{"scores":{"c0":90}}');
  });

  it.each(["incomplete", "failed", "in_progress", "cancelled"])("rejects %s responses even when text looks valid", (status) => {
    expect(readOpenAiFinalText({ status, output_text: "{}" })).toBeUndefined();
  });

  it.each(["commentary", "unexpected"])("does not treat %s as a final answer", (phase) => {
    expect(readOpenAiFinalText({ output_text: "{}", output: [{ phase, content: content("{}") }] })).toBeUndefined();
  });

  it("does not fall back to commentary when the final answer is refused or empty", () => {
    for (const parts of [[], [{ type: "refusal", text: "{}" }]]) {
      expect(readOpenAiFinalText({ output_text: "{}", output: [
        { phase: "commentary", content: content("{}") },
        { phase: "final_answer", content: parts }
      ] })).toBeUndefined();
    }
  });

  it("joins final text parts and ignores non-text output", () => {
    expect(readOpenAiFinalText({ output: [
      { type: "reasoning", content: content("not the answer") },
      { type: "message", phase: "final_answer", content: [...content('{"scores":'), ...content("{}}") ] }
    ] })).toBe('{"scores":{}}');
  });

  it("retains compatibility with unphased API and convenience responses", () => {
    expect(readOpenAiFinalText({ output_text: "{}" })).toBe("{}");
    expect(readOpenAiFinalText({ output: [{ content: [{ text: "{}" }] }] })).toBe("{}");
    expect(readOpenAiFinalText({ output: [{ type: "reasoning", content: content("ignore") }, { content: content("{}") }] })).toBe("{}");
  });

  it("ignores tool messages and rejects incomplete final messages", () => {
    expect(readOpenAiFinalText({ output: [{ role: "tool", content: content("{}") }] })).toBeUndefined();
    expect(readOpenAiFinalText({ output: [{ phase: "final_answer", status: "incomplete", content: content("{}") }] })).toBeUndefined();
  });
});
