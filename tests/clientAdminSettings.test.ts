import { describe, expect, it, vi } from "vitest";
import { changedSettingsSections, replaceSettingsSection, settingsForSection, settleAdminSurface } from "../src/client/features/admin/adminSettingsModel";
import type { AdminSettingsUpdate } from "../src/shared/types";

const saved: AdminSettingsUpdate = { plex: { baseUrl: "http://plex" }, seerr: { baseUrl: "http://seerr" }, ai: { provider: "none" }, sync: { intervalMinutes: 30 }, search: { defaultResultLimit: 50 }, plexAuth: { enabled: false } };

describe("Settings section boundaries", () => {
  it("saves only the chosen section and preserves other unsaved work", () => {
    const draft = { ...saved, plex: { baseUrl: "http://new-plex", token: "fixture-test-value" }, search: { defaultResultLimit: 20 }, plexAuth: { enabled: true } };
    const payload = settingsForSection(draft, "connections");
    expect(payload).toEqual({ plex: draft.plex, seerr: saved.seerr, ai: saved.ai });
    expect(payload).not.toHaveProperty("search");
    expect(payload).not.toHaveProperty("plexAuth");
    const next = replaceSettingsSection(draft, { ...saved, plex: { baseUrl: "http://new-plex" } }, "connections");
    expect(next.search).toEqual({ defaultResultLimit: 20 });
    expect(next.plexAuth).toEqual({ enabled: true });
    expect(next.plex).not.toHaveProperty("token");
    expect(changedSettingsSections(next, { ...saved, plex: { baseUrl: "http://new-plex" } })).toEqual(["preferences", "access"]);
  });

  it("discards one section without dropping another section's draft", () => {
    const draft = { ...saved, sync: { intervalMinutes: 60 }, plexAuth: { enabled: true } };
    expect(replaceSettingsSection(draft, saved, "preferences")).toEqual({ ...saved, plexAuth: { enabled: true } });
  });

  it("makes settings available while a secondary request is pending or failed", async () => {
    const applySettings = vi.fn();
    const applyDiagnostics = vi.fn();
    const failDiagnostics = vi.fn();
    let rejectDiagnostics!: (error: Error) => void;
    const diagnostics = new Promise<never>((_, reject) => { rejectDiagnostics = reject; });
    const all = Promise.allSettled([
      settleAdminSurface(async () => saved, applySettings, vi.fn()),
      settleAdminSurface(() => diagnostics, applyDiagnostics, failDiagnostics)
    ]);
    await vi.waitFor(() => expect(applySettings).toHaveBeenCalledWith(saved));
    expect(applyDiagnostics).not.toHaveBeenCalled();
    rejectDiagnostics(new Error("Diagnostics offline"));
    await all;
    expect(failDiagnostics).toHaveBeenCalledWith("Diagnostics offline");
    expect(applySettings).toHaveBeenCalledTimes(1);
  });
});
