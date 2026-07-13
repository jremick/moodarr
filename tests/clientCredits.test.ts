import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreditsPanel, tmdbAttributionNotice } from "../src/client/CreditsPanel";

const officialTmdbNotice = "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";
const officialTmdbLogoContentSha256 = "8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c";
const vendoredTmdbLogoSha256 = "6d8a6bcec835649ece77876b6cef964d2b2939d988dbfc798c7842d6a6b5da64";

describe("About and credits", () => {
  it("renders the exact TMDB notice in a labelled Credits surface", () => {
    const markup = renderToStaticMarkup(createElement(CreditsPanel, { onClose: () => undefined }));

    expect(tmdbAttributionNotice).toBe(officialTmdbNotice);
    expect(markup).toContain('id="credits-panel"');
    expect(markup).toContain('aria-labelledby="credits-title"');
    expect(markup).toContain('id="credits-title"');
    expect(markup).toContain(officialTmdbNotice);
    expect(markup).toContain('aria-label="Close About and credits"');
  });

  it("links an accessible approved TMDB logo without changing its source artwork", () => {
    const markup = renderToStaticMarkup(createElement(CreditsPanel, { onClose: () => undefined }));
    const logo = readFileSync(new URL("../public/tmdb-logo.svg", import.meta.url));

    expect(markup).toContain('href="https://www.themoviedb.org"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).toContain('src="/tmdb-logo.svg"');
    expect(markup).toContain('alt="The Movie Database (TMDB)"');
    expect(createHash("sha256").update(logo).digest("hex")).toBe(vendoredTmdbLogoSha256);
    expect(createHash("sha256").update(logo.toString("utf8").trimEnd()).digest("hex")).toBe(officialTmdbLogoContentSha256);
  });
});
