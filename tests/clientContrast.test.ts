import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

describe("Client action contrast", () => {
  it("keeps the text-only Plex action fully opaque and above the WCAG AA threshold", () => {
    expect(styles).toMatch(/\.plex-tab,\s*\.seerr-tab,\s*\.request-tab\s*\{[^}]*opacity:\s*1;/s);
    expect(contrastRatio("#e5a00d", "#1f2523")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps request text above the WCAG AA normal-text contrast threshold", () => {
    const warning = cssToken("warn");
    const warningInk = cssToken("warn-ink");

    expect(styles).toMatch(/\.request-tab\s*\{[^}]*color:\s*var\(--warn-ink\)/s);
    expect(styles).toMatch(/\.seerr-tab,\s*\.request-tab\s*\{[^}]*opacity:\s*1;/s);
    expect(contrastRatio(warning, warningInk)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps Seerr text above the WCAG AA threshold in resting and interactive states", () => {
    const seerr = cssToken("seerr");
    const seerrHover = cssToken("seerr-hover");

    expect(styles).toMatch(
      /\.result-card:hover \.seerr-tab,\s*\.seerr-tab:hover,\s*\.seerr-tab:focus-visible\s*\{[^}]*background:\s*var\(--seerr-hover\);[^}]*filter:\s*none;/s,
    );
    expect(contrastRatio(seerr, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(seerrHover, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("uses an AA foreground for accent-soft active and status states", () => {
    const accentSoft = cssToken("accent-soft");
    const control = cssToken("control");

    for (const selector of [
      /\.rated-toggle\.active,\s*\.view-toggle\.active/,
      /\.refinement-options button:hover/,
      /\.composer-actions \.voice-button\.listening/,
      /\.feedback-actions button\.active\.positive/,
      /\.admin-tag\.live/,
      /\.legend-badge\.seerr/,
      /\.field-state\.set/,
      /\.review-rating button\.active/
    ]) {
      expect(styles).toMatch(new RegExp(`${selector.source}\\s*\\{[^}]*background:\\s*var\\(--accent-soft\\);[^}]*color:\\s*var\\(--control\\);`, "s"));
    }
    expect(contrastRatio(accentSoft, control)).toBeGreaterThanOrEqual(4.5);
    expect(styles.indexOf(".composer-actions .voice-button.listening")).toBeGreaterThan(
      styles.indexOf(".composer-actions .voice-button {")
    );
  });
});

function cssToken(name: string) {
  const value = styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  if (!value) throw new Error(`Missing CSS token --${name}.`);
  return value;
}

function contrastRatio(left: string, right: string) {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function relativeLuminance(hex: string) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
