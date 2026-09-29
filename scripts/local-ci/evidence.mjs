// Evidence helpers shared by the local CI orchestrator and the controller release publisher.
// Dependency-free so it runs before `npm ci`.
//
//   node scripts/local-ci/evidence.mjs scan <dir> [--secrets-from-stdin]
//   node scripts/local-ci/evidence.mjs manifest <dir> <run-id>
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scanSizeLimitBytes = 64 * 1024 * 1024;
const unlisted = new Set(["result.json", "result.json.tmp", "evidence-manifest.json"]);

export const listFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const relativePath = (directory, path) => relative(directory, path).split(sep).join("/");

// Redacts credential-shaped values (and any exact secret values supplied by the caller) in place.
// Findings name the file, line and kind only, never the value.
export async function scanEvidence(directory, exactSecrets = []) {
  let detectSecretFindings;
  try {
    ({ detectSecretFindings } = await import(pathToFileURL(join(repositoryRoot, "scripts", "verify-tracked-secrets.ts")).href));
  } catch {
    return { status: "unavailable", findings: [], skippedFiles: [] };
  }
  const secrets = exactSecrets.filter((value) => value.length >= 8);
  const findings = [];
  const skippedFiles = [];
  for (const path of listFiles(directory)) {
    const name = relativePath(directory, path);
    const size = statSync(path).size;
    const bytes = size > scanSizeLimitBytes ? null : readFileSync(path);
    const binary = bytes !== null && bytes.subarray(0, 8192).includes(0);
    const fileFindings = [];
    if (bytes === null || binary) {
      skippedFiles.push({ file: name, reason: bytes === null ? "size" : "binary" });
    } else {
      fileFindings.push(...detectSecretFindings(name, bytes.toString("utf8")));
    }
    if (secrets.length > 0) {
      const body = bytes ?? readFileSync(path);
      if (secrets.some((secret) => body.includes(secret))) fileFindings.push({ file: name, line: 0, kind: "supplied credential value" });
    }
    if (fileFindings.length > 0) {
      findings.push(...fileFindings);
      writeFileSync(path, `[redacted by the local CI evidence scan: ${fileFindings.length} credential-shaped value(s)]\n`, { mode: 0o600 });
    }
  }
  return { status: findings.length === 0 ? "passed" : "failed", findings, skippedFiles };
}

export function writeEvidenceManifest(directory, runId) {
  const files = listFiles(directory)
    .filter((path) => !unlisted.has(relativePath(directory, path)))
    .map((path) => {
      const bytes = readFileSync(path);
      return { path: relativePath(directory, path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = `${JSON.stringify({ schemaVersion: "moodarr-local-ci-evidence-manifest-v1", runId, files }, null, 2)}\n`;
  writeFileSync(join(directory, "evidence-manifest.json"), body, { mode: 0o600 });
  return createHash("sha256").update(body).digest("hex");
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, directory, extra] = process.argv.slice(2);
  if (command === "scan" && directory) {
    const secrets = extra === "--secrets-from-stdin" ? (await readStdin()).split("\n").filter(Boolean) : [];
    const result = await scanEvidence(directory, secrets);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.status === "passed" ? 0 : 1);
  } else if (command === "manifest" && directory && extra) {
    process.stdout.write(`${writeEvidenceManifest(directory, extra)}\n`);
  } else {
    process.stderr.write("usage: evidence.mjs scan <dir> [--secrets-from-stdin] | manifest <dir> <run-id>\n");
    process.exit(2);
  }
}
