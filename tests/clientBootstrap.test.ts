import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { __appTestInternals, canLoadLibraryStats } from "../src/client/App";

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

  it("renders bootstrap failure as an accessible retry notice instead of a ready view", () => {
    const markup = renderToStaticMarkup(
      createElement(__appTestInternals.BootstrapConnectionNotice, {
        destination: "admin",
        state: { phase: "unavailable", message: "Could not reach the Moodarr server." },
        onRetry: () => undefined
      })
    );

    expect(markup).toContain('id="admin-view"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Moodarr server is unavailable");
    expect(markup).toContain(">Retry</button>");
    expect(markup).not.toContain("Checking this browser session");
  });

  it("announces the initial bootstrap check without exposing a premature Retry action", () => {
    const markup = renderToStaticMarkup(
      createElement(__appTestInternals.BootstrapConnectionNotice, {
        destination: "finder",
        state: { phase: "checking" },
        onRetry: () => undefined
      })
    );

    expect(markup).toContain('id="finder-view"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Connecting to Moodarr");
    expect(markup).not.toContain(">Retry</button>");
  });

  it("redacts markup from unexpected bootstrap failures", () => {
    expect(__appTestInternals.describeBootstrapFailure(new Error("<html>proxy error</html>"))).toBe(
      "Check the Moodarr server or proxy, then try again."
    );
  });
});
