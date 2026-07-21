import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

export function renderedMarkdownLinkTargets(content: string) {
  const targets = new Set<string>();

  function collectLinks(node: Nodes) {
    if (node.type === "link") targets.add(node.url);
    if ("children" in node) {
      for (const child of node.children) collectLinks(child);
    }
  }

  collectLinks(fromMarkdown(content));
  return targets;
}
