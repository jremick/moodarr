import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { betaDataBoundary, CreditsPanel } from "../src/client/CreditsPanel";

describe("About and credits", () => {
  it("renders the strict beta data boundary in a labelled Credits surface", () => {
    const markup = renderToStaticMarkup(createElement(CreditsPanel, { onClose: () => undefined }));

    expect(markup).toContain('id="credits-panel"');
    expect(markup).toContain('aria-labelledby="credits-title"');
    expect(markup).toContain('id="credits-title"');
    expect(markup).toContain(betaDataBoundary);
    expect(markup).toContain("TMDB IDs may be retained only as interoperability identifiers");
    expect(markup).toContain('aria-label="Close About and credits"');
  });

  it("does not claim direct TMDB use or bundle TMDB artwork attribution", () => {
    const markup = renderToStaticMarkup(createElement(CreditsPanel, { onClose: () => undefined }));

    expect(markup).not.toContain("tmdb-logo.svg");
    expect(markup).not.toContain("This product uses TMDB and the TMDB APIs");
  });
});
