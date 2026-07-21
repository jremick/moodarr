export function renderedMarkdownLinkTargets(content: string) {
  const targets = new Set<string>();
  const visibleContent = content.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of visibleContent.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const sequence = fenceMatch[1]!;
      const marker = sequence[0] as "`" | "~";
      if (!fence) fence = { marker, length: sequence.length };
      else if (fence.marker === marker && sequence.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;

    const withoutInlineCode = line.replace(/(`+).*?\1/g, "");
    for (const match of withoutInlineCode.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      if (match.index > 0 && withoutInlineCode[match.index - 1] === "!") continue;
      targets.add(match[1]!);
    }
  }

  return targets;
}
