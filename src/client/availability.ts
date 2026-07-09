import type { AvailabilityGroup } from "../shared/types";

export const availabilityLabels: Record<AvailabilityGroup, string> = {
  available_in_plex: "Available in Plex",
  not_in_plex_requestable: "Not in Plex but requestable",
  already_requested: "Already requested",
  partially_available: "Partially available",
  unavailable: "Unavailable"
};

const summaryLabels: Record<AvailabilityGroup, string> = {
  available_in_plex: "Plex",
  not_in_plex_requestable: "requestable",
  already_requested: "requested",
  partially_available: "partial",
  unavailable: "unavailable"
};

export function summarizeAvailability(counts: Array<{ group: AvailabilityGroup; count: number }>, renderedCount: number) {
  const nonEmptyCounts = counts.filter(({ count }) => count > 0);
  const total = nonEmptyCounts.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) return { total, heading: "Ready", detail: "Ask for a mood to start" };
  const heading = nonEmptyCounts.length > 1 ? "Mixed availability" : availabilityLabels[nonEmptyCounts[0].group];
  const availability = nonEmptyCounts.map(({ group, count }) => `${count} ${summaryLabels[group]}`).join(" · ");
  const load = renderedCount < total ? `${renderedCount} of ${total} loaded` : `${total} shown`;
  return { total, heading, detail: `${load} · ${availability}` };
}
