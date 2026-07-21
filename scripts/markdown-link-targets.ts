export function renderedMarkdownLinkTargets(content: string) {
  const targets = new Set<string>();
  const visibleContent = content.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let codeSpanLength: number | undefined;

  for (const line of visibleContent.split(/\r?\n/)) {
    if (fence) {
      const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closingFence) {
        const sequence = closingFence[1]!;
        if (sequence[0] === fence.marker && sequence.length >= fence.length) fence = undefined;
      }
      continue;
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      const sequence = openingFence[1]!;
      fence = { marker: sequence[0] as "`" | "~", length: sequence.length };
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;

    let withoutInlineCode = "";
    for (let index = 0; index < line.length;) {
      if (line[index] !== "`") {
        if (codeSpanLength === undefined) withoutInlineCode += line[index];
        index += 1;
        continue;
      }
      let end = index + 1;
      while (line[end] === "`") end += 1;
      const runLength = end - index;
      if (codeSpanLength === undefined) codeSpanLength = runLength;
      else if (runLength === codeSpanLength) codeSpanLength = undefined;
      index = end;
    }
    for (const match of withoutInlineCode.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      if (match.index > 0 && withoutInlineCode[match.index - 1] === "!") continue;
      targets.add(match[1]!);
    }
  }

  return targets;
}
