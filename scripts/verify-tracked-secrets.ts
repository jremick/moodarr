import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface SecretFinding {
  file: string;
  line: number;
  kind: string;
}

const tokenPatterns = [
  { kind: "private key", pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/ },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];

const credentialAssignment = /\b(PLEX_TOKEN|SEERR_API_KEY|OPENAI_API_KEY|MOODARR_ADMIN_TOKEN)\s*(?::|=)\s*["']?([^\s"'#]+)/g;
const contextualCredentialAssignment = /\b(plexToken|seerrApiKey|openaiApiKey|adminToken)\s*(?::|=)\s*["']([^"']+)["']/g;
const placeholderPattern = /^(?:\$|\{|<|\[)|(?:test|fixture|smoke|packaging|example|replace-with|redacted|changeme|your-)|(?:token|key)-secret$/i;

export function detectSecretFindings(file: string, body: string): SecretFinding[] {
  if (body.includes("\0")) return [];
  const findings: SecretFinding[] = [];
  const lines = body.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const candidate of tokenPatterns) {
      if (candidate.pattern.test(line)) findings.push({ file, line: index + 1, kind: candidate.kind });
    }

    for (const pattern of [credentialAssignment, contextualCredentialAssignment]) {
      for (const match of line.matchAll(pattern)) {
        const value = match[2]?.trim() ?? "";
        if (value.length >= 12 && !placeholderPattern.test(value)) {
          findings.push({ file, line: index + 1, kind: `${match[1]} literal` });
        }
      }
    }
  }

  return findings;
}

export function scanTrackedFiles(cwd = process.cwd()): SecretFinding[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  return files.flatMap((file) => detectSecretFindings(file, readFileSync(`${cwd}/${file}`, "utf8")));
}

function main() {
  const findings = scanTrackedFiles();
  if (findings.length > 0) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: possible ${finding.kind}`);
    console.error(`Tracked-content secret scan found ${findings.length} possible secret(s). Values are intentionally not printed.`);
    process.exit(1);
  }
  console.log("Tracked-content secret scan found no credential patterns.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
