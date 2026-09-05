import type { AdminSettingsUpdate } from "../../../shared/types";

export const adminSettingSections = {
  connections: ["plex", "seerr", "ai"],
  preferences: ["fixtureMode", "sync", "search", "reviewQueue"],
  access: ["plexAuth"]
} as const;
export type AdminSettingsSection = keyof typeof adminSettingSections;

export function settingsForSection(draft: AdminSettingsUpdate, section: AdminSettingsSection): AdminSettingsUpdate {
  return Object.fromEntries(adminSettingSections[section].filter((key) => draft[key] !== undefined).map((key) => [key, draft[key]]));
}

export function replaceSettingsSection(draft: AdminSettingsUpdate, saved: AdminSettingsUpdate, section: AdminSettingsSection): AdminSettingsUpdate {
  const next = { ...draft };
  for (const key of adminSettingSections[section]) delete next[key];
  return { ...next, ...settingsForSection(saved, section) };
}

export function changedSettingsSections(draft: AdminSettingsUpdate, saved: AdminSettingsUpdate): AdminSettingsSection[] {
  return (Object.keys(adminSettingSections) as AdminSettingsSection[]).filter((section) => JSON.stringify(settingsForSection(draft, section)) !== JSON.stringify(settingsForSection(saved, section)));
}

// A failed optional surface must not suppress another surface's successful data.
export async function settleAdminSurface<T>(load: () => Promise<T>, apply: (value: T) => void, fail: (message: string) => void) {
  try { apply(await load()); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
}
