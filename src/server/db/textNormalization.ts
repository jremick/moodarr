export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function referenceTitleKey(value: string): string {
  return normalizeTitle(value).replace(/^(?:a|an|the)\s+/, "");
}

/** Exact references win; a sequel prefix must end at a word boundary. */
export function referenceTitleMatches<T extends { title: string }>(items: readonly T[], phrase: string): T[] {
  const key = referenceTitleKey(phrase);
  if (!key) return [];
  const exact = items.filter(item => referenceTitleKey(item.title) === key);
  return exact.length ? exact : items.filter(item => referenceTitleKey(item.title).startsWith(`${key} `));
}
