import { describe, expect, it } from "vitest";
import { renderedMarkdownLinkTargets } from "../scripts/markdown-link-targets";

const ledgerUrl = "https://github.com/jremick/moodarr/issues/32";

describe("rendered Markdown link targets", () => {
  it("collects an exact rendered link destination", () => {
    expect(renderedMarkdownLinkTargets(`[issue #32](${ledgerUrl})`)).toEqual(new Set([ledgerUrl]));
  });

  it.each([
    [`<!-- [hidden](${ledgerUrl}) -->`, "an HTML comment"],
    [`<!-- comment starts\n[hidden](${ledgerUrl})\n-->`, "a multiline HTML comment"],
    [`\`\`\`markdown\n[example](${ledgerUrl})\n\`\`\``, "a fenced code block"],
    [`\`\`\`markdown\n\`\`\`not-a-closing-fence\n[example](${ledgerUrl})\n\`\`\``, "content after a would-be closing fence"],
    [`~~~markdown\n[example](${ledgerUrl})\n~~~`, "a tilde code block"],
    [`    [example](${ledgerUrl})`, "an indented code block"],
    [`\`[example](${ledgerUrl})\``, "inline code"],
    [`\`\`code starts\n[example](${ledgerUrl})\ncode ends\`\``, "a multiline code span"],
    [`![image](${ledgerUrl})`, "an image target"],
    [`[prefixed](https://example.invalid/${ledgerUrl})`, "a prefixed destination"],
    [`[suffixed](${ledgerUrl}/extra)`, "a suffixed destination"]
  ])("does not treat %s as the required rendered link", (markdown) => {
    expect(renderedMarkdownLinkTargets(markdown)).not.toContain(ledgerUrl);
  });
});
