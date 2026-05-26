const templatedSummaryPatterns = [
  /^\s*(?:you(?:'|’)re|you are)\s+(?:looking for|asking for|after|in the mood for)\b/i,
  /^\s*i(?:'|’)m\s+(?:filtering for|looking for|searching for)\b/i,
  /^\s*(?:filtered for|searching for|looking for)\b/i
];

export function cleanConversationalSummary(summary: string | undefined) {
  const trimmed = summary?.trim();
  if (!trimmed) return undefined;
  if (templatedSummaryPatterns.some((pattern) => pattern.test(trimmed))) return undefined;
  return trimmed;
}
