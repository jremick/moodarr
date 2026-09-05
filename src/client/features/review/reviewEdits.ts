import type { QueryReviewQueueItem } from "../../../shared/types";

export function hasReviewIntent(item: QueryReviewQueueItem) {
  return Boolean(item.query.trim()) && !/^\[redacted-query:[^\]]+\]$/.test(item.query);
}

export function reconcileReviewEdits<T>(current: Record<string, T>, items: QueryReviewQueueItem[], dirtyIds: ReadonlySet<string>, savedValue: (item: QueryReviewQueueItem) => T): Record<string, T> {
  const next = { ...current };
  for (const item of items) if (!dirtyIds.has(item.id)) next[item.id] = savedValue(item);
  return next;
}
