import { describe, expect, it } from "vitest";
import { canLoadLibraryStats } from "../src/client/App";

describe("client bootstrap access", () => {
  it("does not request protected library stats before the user unlocks or signs in", () => {
    expect(
      canLoadLibraryStats({
        adminSessionAvailable: false,
        adminAuthRequired: true,
        userAuthenticated: false
      })
    ).toBe(false);
  });

  it.each([
    { adminSessionAvailable: true, adminAuthRequired: true, userAuthenticated: false },
    { adminSessionAvailable: false, adminAuthRequired: true, userAuthenticated: true },
    { adminSessionAvailable: false, adminAuthRequired: false, userAuthenticated: false }
  ])("loads stats when an authorized or unprotected path exists", (input) => {
    expect(canLoadLibraryStats(input)).toBe(true);
  });
});
