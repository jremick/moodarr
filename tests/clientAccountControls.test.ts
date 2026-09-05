import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { __appTestInternals } from "../src/client/App";
import type { AuthSessionResponse } from "../src/shared/types";

const base = {
  status: null, authSession: { authenticated: false, plexAuthEnabled: true, allowNewPlexUsers: true } as AuthSessionResponse,
  pendingPlexAuth: null, busy: "", onStartPlexSignIn: async () => undefined, onCompletePlexSignIn: async () => undefined,
  onRestartPlexSignIn: async () => undefined, onCancelPlexSignIn: () => undefined, onLogout: async () => undefined
};

describe("Account access and recovery", () => {
  it("always exposes sign-out to an authenticated viewer, including when new Plex sign-ins are disabled", () => {
    const markup = renderToStaticMarkup(createElement(__appTestInternals.AccountControls, { ...base, authSession: { ...base.authSession, authenticated: true, plexAuthEnabled: false } }));
    expect(markup).toContain('class="account-menu"');
    expect(markup).toContain("Signed in as Plex user");
    expect(markup).toContain("Sign out of Plex");
    expect(markup).not.toContain("Lock Admin");
  });

  it("keeps restart and cancel available for a pending or expired attempt", () => {
    const markup = renderToStaticMarkup(createElement(__appTestInternals.AccountControls, { ...base, pendingPlexAuth: { pinId: "expired-fixture", code: "fixture", createdAt: 0 } }));
    expect(markup).toContain("Check Plex sign-in");
    expect(markup).toContain("Start again");
    expect(markup).toContain("Cancel sign-in");
    expect(markup).not.toContain('disabled=""');
  });
});
