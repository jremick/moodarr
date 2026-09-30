import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Release trust after GitHub Actions: versions published by the GitHub-hosted workflow (through beta.6, the
// immutable published baseline) keep that attestation policy; beta.7 onward requires a statement signed by the
// repository-pinned release key, recorded in the transparency log and bound to digest, source, ref, version
// and builder. Signing and registry writes belong to the private controller; this repository owns the trust
// policy, the verifier and the credential-free OCI build. cosign, gh and Docker are recording fakes; Git, jq,
// Node and Bash are real.

type Json = Record<string, any>;

const root = process.cwd();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
// Pin historical fixtures independently of the current application version.
const publishedVersion = "0.1.0-beta.6";
// Fixture checkouts only; the application's package version is not changed.
const localVersion = "0.1.0-beta.7";
const trust = JSON.parse(readFileSync(join(root, ".github/release-trust.json"), "utf8")) as Json;
const pinnedKey = trust.localSigner.keys[0] as Json;
const pinnedKeyBytes = readFileSync(join(root, pinnedKey.publicKey));
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "moodarr-release-signing-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let sequence = 0;
const fresh = (prefix: string) => mkdtempSync(join(scratch, `${prefix}-${sequence++}-`));
const sha256Hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const sha256Base64 = (value: Buffer | string) => createHash("sha256").update(value).digest("base64");
const writeExecutable = (path: string, contents: string) => {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};
const output = (result: SpawnSyncReturns<string>) => `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2_000);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json;
const calls = (bin: string, tool: string) => existsSync(join(bin, `${tool}.calls`)) ? readFileSync(join(bin, `${tool}.calls`), "utf8") : "";

const git = (repo: string, ...args: string[]) => execFileSync(realGit, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
  cwd: repo,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}).trim();
const commitAll = (repo: string, message: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};
const setVersion = (repo: string, value: string) => {
  const path = join(repo, "package.json");
  const pkg = readJson(path);
  pkg.version = value;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
};
const editJson = (path: string, change: (value: Json) => void) => {
  const value = readJson(path);
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const createRepo = (options: { version?: string; adjust?: (repo: string) => void } = {}) => {
  const repo = fresh("repo");
  for (const path of ["scripts", ".vex", ".github/release-revocations.json", ".github/release-trust.json", ".github/release-signers", "package.json", ".gitignore", "CHANGELOG.md", "README.md", "SECURITY.md", "SUPPORT.md", "docs/UNRAID.md", "docs/RELEASE.md", "docs/COMPATIBILITY.md"]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    cpSync(join(root, path), join(repo, path), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"));
  if (options.version) setVersion(repo, options.version);
  options.adjust?.(repo);
  git(repo, "-c", "init.defaultBranch=main", "init", "-q");
  git(repo, "remote", "add", "origin", "https://github.com/jremick/moodarr");
  return { repo, sha: commitAll(repo, "fixture") };
};

const candidateDigest = `sha256:${"c".repeat(64)}`;

const statementFor = (digest: string, revision: string, packageVersion: string): Json => ({
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: "ghcr.io/jremick/moodarr", digest: { sha256: digest.slice("sha256:".length) } }],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: trust.localSigner.buildType,
      externalParameters: {
        source: { uri: trust.localSigner.sourceUri, digest: { gitCommit: revision } },
        releaseMode: "candidate",
        packageVersion,
        candidateTag: `sha-${revision}`
      },
      internalParameters: { mainRevision: revision },
      resolvedDependencies: [{ uri: trust.localSigner.sourceUri, digest: { gitCommit: revision } }]
    },
    runDetails: { builder: { id: trust.localSigner.builderId }, metadata: { invocationId: "publisher-fixture-0001" } }
  }
});

// Same shape as a cosign 3 Sigstore bundle; the fake binds it to the key and the exact statement bytes.
const bundleFor = (statementBytes: Buffer | string, keyBytes: Buffer | string, options: { tlog?: boolean } = {}) => JSON.stringify({
  mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
  verificationMaterial: {
    publicKey: { hint: sha256Hex(keyBytes) },
    tlogEntries: options.tlog === false ? [] : [{ logIndex: "42", kindVersion: { kind: "hashedrekord", version: "0.0.1" }, integratedTime: "1790654339", inclusionProof: { logIndex: "41", treeSize: "100" } }]
  },
  messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: sha256Base64(statementBytes) }, signature: "Zml4dHVyZQ==" }
});

type Fakes = { bin: string; scenario: string; registry: string };

const installFakes = (): Fakes => {
  const bin = fresh("fakes");
  const scenario = join(bin, "scenario");
  const registry = join(bin, "registry");
  mkdirSync(scenario);
  mkdirSync(registry);
  mkdirSync(join(bin, "tools"));
  symlinkSync(process.execPath, join(bin, "tools", "node"));
  writeFileSync(join(scenario, "password"), "fixture-cosign-password");
  writeFileSync(join(scenario, "signer.pub"), pinnedKeyBytes);
  writeExecutable(join(bin, "cosign"), `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenario"
{ printf '%s\\n' "$*"; printf 'env password=%s ghcr=%s\\n' "\${COSIGN_PASSWORD:+set}" "\${LOCAL_RELEASE_GHCR_TOKEN:+set}"; } >> "$here/cosign.calls"
hex_of() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
b64_of() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$1"; }
command="$1"; shift
key=""; bundle=""; last=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="$2"; shift 2 ;;
    --bundle) bundle="$2"; shift 2 ;;
    --json|--yes) shift ;;
    *) last="$1"; shift ;;
  esac
done
case "$command" in
  version) printf '{"gitVersion":"%s"}\\n' "$(cat "$scenario/cosign-version" 2>/dev/null || echo v3.1.3)" ;;
  public-key)
    [ "\${COSIGN_PASSWORD:-}" = "$(cat "$scenario/password")" ] || { echo "decryption failed" >&2; exit 1; }
    cat "$scenario/signer.pub" ;;
  sign-blob)
    [ "\${COSIGN_PASSWORD:-}" = "$(cat "$scenario/password")" ] || { echo "decryption failed" >&2; exit 1; }
    printf '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json","verificationMaterial":{"publicKey":{"hint":"%s"},"tlogEntries":[{"logIndex":"42","kindVersion":{"kind":"hashedrekord","version":"0.0.1"},"integratedTime":"1790654339","inclusionProof":{"logIndex":"41","treeSize":"100"}}]},"messageSignature":{"messageDigest":{"algorithm":"SHA2_256","digest":"%s"},"signature":"Zml4dHVyZQ=="}}\\n' "$(hex_of "$scenario/signer.pub")" "$(b64_of "$last")" > "$bundle" ;;
  verify-blob)
    [ "$(hex_of "$key")" = "$(jq -r '.verificationMaterial.publicKey.hint' "$bundle")" ] || { echo "invalid signature: key mismatch" >&2; exit 1; }
    [ "$(b64_of "$last")" = "$(jq -r '.messageSignature.messageDigest.digest' "$bundle")" ] || { echo "invalid signature: payload mismatch" >&2; exit 1; }
    echo "Verified OK" >&2 ;;
  *) echo "unexpected fake cosign invocation: $command" >&2; exit 64 ;;
esac
`);
  writeExecutable(join(bin, "gh"), `#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$@" > "$here/gh.args"
printf '%s\\n' "$*" >> "$here/gh.calls"
{
  echo "GH_TOKEN=\${GH_TOKEN-unset}"
  echo "GITHUB_TOKEN=\${GITHUB_TOKEN-unset}"
  echo "GH_CONFIG_DIR_ENTRIES=$(ls -A "\${GH_CONFIG_DIR:-/nonexistent}" 2>/dev/null | wc -l | tr -d ' ')"
  echo "GH_CONFIG_DIR_SET=\${GH_CONFIG_DIR:+yes}"
} > "$here/gh.env"
cat "$here/scenario/gh-output.json" 2>/dev/null
exit "$(cat "$here/scenario/gh-exit" 2>/dev/null || echo 0)"
`);
  return { bin, scenario, registry };
};

const fakePath = (fakes: Fakes) => `${fakes.bin}:${join(fakes.bin, "tools")}:/usr/bin:/bin`;

type AttestationRun = { repo: string; sha: string; mainSha?: string; statement?: string | null; bundle?: string | null; fakes?: Fakes };

const runAttestation = ({ repo, sha, mainSha, statement, bundle, fakes = installFakes() }: AttestationRun) => {
  const inputs = fresh("inputs");
  const statementPath = join(inputs, "statement.json");
  const bundlePath = join(inputs, "statement.sigstore.json");
  if (typeof statement === "string") writeFileSync(statementPath, statement);
  if (typeof bundle === "string") writeFileSync(bundlePath, bundle);
  const subjobDir = join(fresh("evidence"), "attestation");
  mkdirSync(subjobDir);
  const result = spawnSync("bash", [join(repo, "scripts/local-ci/jobs.sh"), "attestation"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: fakePath(fakes),
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      GH_TOKEN: "caller-token-must-not-reach-gh",
      GITHUB_TOKEN: "caller-token-must-not-reach-gh",
      LCI_SUBJOB_DIR: subjobDir,
      LCI_CANDIDATE_DIGEST: candidateDigest,
      LCI_SOURCE_SHA: sha,
      LCI_MAIN_SHA: mainSha ?? sha,
      LCI_ATTESTATION_BUNDLE: "",
      LCI_SIGNED_STATEMENT: typeof statement === "string" ? statementPath : "",
      LCI_SIGNATURE_BUNDLE: typeof bundle === "string" ? bundlePath : ""
    } as NodeJS.ProcessEnv
  });
  return { result, subjobDir, fakes };
};

const signed = (statement: Json, keyBytes: Buffer | string = pinnedKeyBytes, options: { tlog?: boolean } = {}) => {
  const text = `${JSON.stringify(statement)}\n`;
  return { statement: text, bundle: bundleFor(text, keyBytes, options) };
};

describe("candidate attestation for versions pinned to the local release signer", () => {
  it("accepts a transparency-logged statement from the pinned key bound to digest, source, ref, version and builder", () => {
    const { repo, sha } = createRepo({ version: localVersion });
    const { result, subjobDir, fakes } = runAttestation({ repo, sha, ...signed(statementFor(candidateDigest, sha, localVersion)) });
    expect(result.status, output(result)).toBe(0);
    expect(readJson(join(subjobDir, "attestation.json"))).toMatchObject({
      policy: "local-signer",
      keyId: pinnedKey.id,
      publicKeyPemSha256: pinnedKey.publicKeyPemSha256,
      candidateImage: `ghcr.io/jremick/moodarr@${candidateDigest}`,
      expectedRevision: sha,
      packageVersion: localVersion,
      builderId: trust.localSigner.builderId,
      transparencyLogIndex: "42"
    });
    expect(readdirSync(subjobDir).sort()).toEqual(["attestation.json", "statement.json", "statement.sigstore.json"]);
    const cosignCall = calls(fakes.bin, "cosign").split("\n").find((line) => line.startsWith("verify-blob "));
    expect(cosignCall).toBeDefined();
    expect(cosignCall).not.toMatch(/insecure-ignore-tlog|private-infrastructure|insecure-ignore-sct/);
    expect(calls(fakes.bin, "cosign")).toContain("env password= ghcr=");
    expect(calls(fakes.bin, "gh")).toBe("");
    expect(sha256Hex(pinnedKeyBytes)).toBe(pinnedKey.publicKeyPemSha256);
  });

  it("rejects tampered bytes, another key, a missing transparency-log entry and every unbound claim", () => {
    const { repo, sha } = createRepo({ version: localVersion });
    const valid = statementFor(candidateDigest, sha, localVersion);
    const variant = (change: (statement: Json) => void) => {
      const copy = structuredClone(valid);
      change(copy);
      return signed(copy);
    };
    const original = signed(valid);
    const cases: Array<{ name: string; statement: string; bundle: string }> = [
      { name: "statement changed after signing", statement: original.statement.replace(`"packageVersion":"${localVersion}"`, '"packageVersion":"0.1.0-beta.99"'), bundle: original.bundle },
      { name: "signed by an unpinned key", ...signed(valid, "-----BEGIN PUBLIC KEY-----\nnot-the-pinned-key\n-----END PUBLIC KEY-----\n") },
      { name: "no transparency-log entry", ...signed(valid, pinnedKeyBytes, { tlog: false }) },
      { name: "legacy envelope for controller signature", ...variant((s) => { s._type = "https://in-toto.io/Statement/v0.1"; }) },
      { name: "another image digest", ...variant((s) => { s.subject[0].digest.sha256 = "d".repeat(64); }) },
      { name: "another repository", ...variant((s) => { s.subject[0].name = "ghcr.io/someone/moodarr"; }) },
      { name: "two subjects", ...variant((s) => { s.subject.push({ name: "ghcr.io/jremick/moodarr", digest: { sha256: "d".repeat(64) } }); }) },
      { name: "another source revision", ...variant((s) => { s.predicate.buildDefinition.externalParameters.source.digest.gitCommit = "b".repeat(40); }) },
      { name: "another ref", ...variant((s) => { s.predicate.buildDefinition.externalParameters.source.uri = "git+https://github.com/jremick/moodarr@refs/heads/dev"; }) },
      { name: "another package version", ...variant((s) => { s.predicate.buildDefinition.externalParameters.packageVersion = "0.1.0-beta.8"; }) },
      { name: "another builder", ...variant((s) => { s.predicate.runDetails.builder.id = "https://github.com/jremick/moodarr/actions/runs/1/attempts/1"; }) },
      { name: "another build type", ...variant((s) => { s.predicate.buildDefinition.buildType = "https://example.invalid/build"; }) },
      { name: "older provenance predicate", ...variant((s) => { s.predicateType = "https://slsa.dev/provenance/v0.2"; }) },
      { name: "promotion claim", ...variant((s) => { s.predicate.buildDefinition.externalParameters.releaseMode = "promotion"; }) },
      { name: "candidate tag for another revision", ...variant((s) => { s.predicate.buildDefinition.externalParameters.candidateTag = `sha-${"b".repeat(40)}`; }) }
    ];
    for (const testCase of cases) {
      const { result, subjobDir } = runAttestation({ repo, sha, statement: testCase.statement, bundle: testCase.bundle });
      expect(result.status, `${testCase.name}: ${output(result)}`).not.toBe(0);
      expect(existsSync(join(subjobDir, "attestation.json")), testCase.name).toBe(false);
    }
  }, 120_000);

  it("never falls back to the GitHub-hosted policy for a version pinned to the local signer", () => {
    const { repo, sha } = createRepo({ version: localVersion });
    const fakes = installFakes();
    writeFileSync(join(fakes.scenario, "gh-output.json"), JSON.stringify([{ verificationResult: {} }]));
    const { result } = runAttestation({ repo, sha, fakes, statement: null, bundle: null });
    expect(result.status, output(result)).not.toBe(0);
    expect(calls(fakes.bin, "gh")).toBe("");
  });

  it("reads the trust policy and key pin from main, so a source commit cannot downgrade or swap them", () => {
    const { repo, sha: downgraded } = createRepo({
      version: localVersion,
      adjust: (fixture) => editJson(join(fixture, ".github/release-trust.json"), (policy) => {
        for (const rule of policy.rules) rule.policy = "github-hosted";
      })
    });
    writeFileSync(join(repo, ".github/release-trust.json"), readFileSync(join(root, ".github/release-trust.json")));
    const main = commitAll(repo, "restore trust policy on main");
    git(repo, "checkout", "-q", "--detach", downgraded);
    const fakes = installFakes();
    writeFileSync(join(fakes.scenario, "gh-output.json"), JSON.stringify([{ verificationResult: {} }]));
    const githubOnly = runAttestation({ repo, sha: downgraded, mainSha: main, fakes, statement: null, bundle: null });
    expect(githubOnly.result.status, output(githubOnly.result)).not.toBe(0);
    expect(calls(fakes.bin, "gh")).toBe("");
    const withSignature = runAttestation({ repo, sha: downgraded, mainSha: main, ...signed(statementFor(candidateDigest, downgraded, localVersion)) });
    expect(withSignature.result.status, output(withSignature.result)).toBe(0);

    const { repo: swapped, sha: base } = createRepo({ version: localVersion });
    writeFileSync(join(swapped, pinnedKey.publicKey), "-----BEGIN PUBLIC KEY-----\nswapped-without-updating-the-pin\n-----END PUBLIC KEY-----\n");
    const swappedMain = commitAll(swapped, "swap key without pin");
    git(swapped, "checkout", "-q", "--detach", base);
    const swapFakes = installFakes();
    const swappedRun = runAttestation({ repo: swapped, sha: base, mainSha: swappedMain, fakes: swapFakes, ...signed(statementFor(candidateDigest, base, localVersion)) });
    expect(swappedRun.result.status, output(swappedRun.result)).not.toBe(0);
    expect(calls(swapFakes.bin, "cosign")).not.toContain("verify-blob");
  }, 60_000);

  it("rejects a revoked signer key and a malformed trust policy on main", () => {
    for (const change of [
      (policy: Json) => { policy.localSigner.keys[0].status = "revoked"; },
      (policy: Json) => { policy.rules = []; },
      (policy: Json) => { policy.rules.push({ fromBeta: 3, throughBeta: 8, policy: "local-signer" }); },
      (policy: Json) => { policy.schemaVersion = "moodarr-release-trust-v0"; }
    ]) {
      const { repo, sha } = createRepo({ version: localVersion });
      editJson(join(repo, ".github/release-trust.json"), change);
      const main = commitAll(repo, "main trust change");
      git(repo, "checkout", "-q", "--detach", sha);
      const { result } = runAttestation({ repo, sha, mainSha: main, ...signed(statementFor(candidateDigest, sha, localVersion)) });
      expect(result.status, output(result)).not.toBe(0);
    }
  }, 60_000);
});

describe("candidate attestation for versions published by the GitHub-hosted workflow", () => {
  it("keeps the published beta.6 on the GitHub-hosted signer, source, ref and hosted-runner policy without caller credentials", () => {
    const { repo, sha } = createRepo({ version: publishedVersion });
    expect(readJson(join(repo, "package.json")).version).toBe(publishedVersion);
    const fakes = installFakes();
    writeFileSync(join(fakes.scenario, "gh-output.json"), JSON.stringify([{ verificationResult: { statement: {} } }]));
    const { result, subjobDir } = runAttestation({ repo, sha, fakes, ...signed(statementFor(candidateDigest, sha, publishedVersion)) });
    expect(result.status, output(result)).toBe(0);
    const args = readFileSync(join(fakes.bin, "gh.args"), "utf8").trim().split("\n");
    const env = readFileSync(join(fakes.bin, "gh.env"), "utf8");
    expect(args.slice(0, 3)).toEqual(["attestation", "verify", `oci://ghcr.io/jremick/moodarr@${candidateDigest}`]);
    const values = (flag: string) => args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));
    expect(values("--repo")).toEqual(["jremick/moodarr"]);
    expect(values("--signer-workflow")).toEqual(["jremick/moodarr/.github/workflows/publish-image.yml"]);
    expect(values("--signer-digest")).toEqual([sha]);
    expect(values("--source-digest")).toEqual([sha]);
    expect(values("--source-ref")).toEqual(["refs/heads/main"]);
    expect(values("--format")).toEqual(["json"]);
    expect(args).toContain("--deny-self-hosted-runners");
    expect(args).toContain("--bundle-from-oci");
    expect(env).toContain("GH_TOKEN=unset");
    expect(env).toContain("GITHUB_TOKEN=unset");
    expect(env).toContain("GH_CONFIG_DIR_SET=yes");
    expect(env).toContain("GH_CONFIG_DIR_ENTRIES=0");
    expect(readJson(join(subjobDir, "attestation.json"))).toMatchObject({ policy: "github-hosted", verifiedAttestationCount: 1, denySelfHostedRunners: true, bundleSource: "oci" });
    expect(readdirSync(subjobDir)).toEqual(["attestation.json"]);
    expect(calls(fakes.bin, "cosign")).toBe("");
  });

  it("uses a controller-supplied attestation bundle and fails closed on verifier failure or empty results", () => {
    const { repo, sha } = createRepo({ version: "0.1.0-beta.5" });
    expect(readJson(join(repo, "package.json")).version).toBe("0.1.0-beta.5");
    const bundleDir = fresh("bundle");
    writeFileSync(join(bundleDir, "bundle.jsonl"), "{}\n");
    const withBundle = installFakes();
    writeFileSync(join(withBundle.scenario, "gh-output.json"), JSON.stringify([{ verificationResult: {} }]));
    const run = spawnSync("bash", [join(repo, "scripts/local-ci/jobs.sh"), "attestation"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: fakePath(withBundle), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        LCI_SUBJOB_DIR: join(fresh("evidence"), "attestation"), LCI_CANDIDATE_DIGEST: candidateDigest, LCI_SOURCE_SHA: sha, LCI_MAIN_SHA: sha,
        LCI_ATTESTATION_BUNDLE: join(bundleDir, "bundle.jsonl"), LCI_SIGNED_STATEMENT: "", LCI_SIGNATURE_BUNDLE: ""
      } as NodeJS.ProcessEnv
    });
    expect(run.status, output(run)).toBe(0);
    const args = readFileSync(join(withBundle.bin, "gh.args"), "utf8").trim().split("\n");
    expect(args).not.toContain("--bundle-from-oci");
    expect(args[args.indexOf("--bundle") + 1]).toBe(join(bundleDir, "bundle.jsonl"));
    for (const [ghOutput, ghExit] of [["", "1"], ["[]", "0"], ["not json", "0"], [JSON.stringify({ verificationResult: {} }), "0"]]) {
      const fakes = installFakes();
      writeFileSync(join(fakes.scenario, "gh-output.json"), ghOutput);
      writeFileSync(join(fakes.scenario, "gh-exit"), ghExit);
      const { result, subjobDir } = runAttestation({ repo, sha, fakes, statement: null, bundle: null });
      expect(result.status, `${ghOutput}: ${output(result)}`).not.toBe(0);
      expect(existsSync(join(subjobDir, "attestation.json"))).toBe(false);
    }
  }, 60_000);
});

// OCI image layout matching BuildKit's OCI exporter with attestation manifests.
type LayoutOptions = {
  revision: string;
  packageVersion?: string;
  builderId?: string;
  revisionLabel?: string;
  architecture?: string;
  provenanceExtra?: Json;
  omitSbom?: boolean;
  provenanceSubjectDigest?: string;
  statementType?: string;
  provenanceEnvelope?: Json;
  sbomEnvelope?: Json;
};

const buildLayout = (directory: string, options: LayoutOptions) => {
  mkdirSync(join(directory, "blobs", "sha256"), { recursive: true });
  const put = (content: string) => {
    const bytes = Buffer.from(content);
    const hex = sha256Hex(bytes);
    writeFileSync(join(directory, "blobs", "sha256", hex), bytes);
    return { digest: `sha256:${hex}`, size: bytes.length };
  };
  const labels = {
    "org.opencontainers.image.version": options.packageVersion ?? version,
    "org.opencontainers.image.revision": options.revisionLabel ?? options.revision,
    "org.opencontainers.image.source": "https://github.com/jremick/moodarr",
    "org.opencontainers.image.licenses": "Apache-2.0",
    "io.moodarr.ai-provider-policy": "none",
    "io.moodarr.tmdb-content-policy": "none"
  };
  const config = put(JSON.stringify({ os: "linux", architecture: options.architecture ?? "amd64", config: { Labels: labels }, rootfs: { type: "layers", diff_ids: [] } }));
  const layer = put("fixture layer bytes");
  const image = put(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...config },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", ...layer }]
  }));
  const provenancePredicate = {
    buildDefinition: {
      buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
      externalParameters: { request: { frontend: "dockerfile.v0" } },
      resolvedDependencies: [{ uri: "pkg:docker/node@24", digest: { sha256: "3".repeat(64) } }],
      ...(options.provenanceExtra ?? {})
    },
    runDetails: {
      builder: { id: options.builderId ?? trust.localSigner.builderId },
      metadata: { buildkit_metadata: { vcs: { source: "https://github.com/jremick/moodarr", revision: options.revision } } }
    }
  };
  const subject = [{ name: `pkg:docker/ghcr.io/jremick/moodarr@sha-${options.revision}?platform=linux%2Famd64`, digest: { sha256: (options.provenanceSubjectDigest ?? image.digest).slice(7) } }];
  // The pinned BuildKit OCI exporter uses v0.1 for both statement envelopes.
  const statementType = options.statementType ?? "https://in-toto.io/Statement/v0.1";
  const provenance = put(JSON.stringify({ _type: statementType, predicateType: "https://slsa.dev/provenance/v1", subject, predicate: provenancePredicate, ...options.provenanceEnvelope }));
  const sbom = put(JSON.stringify({ _type: statementType, predicateType: "https://spdx.dev/Document", subject, predicate: { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", packages: [{ SPDXID: "SPDXRef-Package-node", name: "node" }] }, ...options.sbomEnvelope }));
  const attestationConfig = put(JSON.stringify({ architecture: "unknown", os: "unknown", config: {}, rootfs: { type: "layers", diff_ids: [] } }));
  const attestationLayers = [
    { mediaType: "application/vnd.in-toto+json", ...provenance, annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" } },
    ...(options.omitSbom ? [] : [{ mediaType: "application/vnd.in-toto+json", ...sbom, annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" } }])
  ];
  const attestation = put(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/vnd.oci.image.config.v1+json", ...attestationConfig }, layers: attestationLayers }));
  const index = put(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", ...image, platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", ...attestation, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image.digest }, platform: { os: "unknown", architecture: "unknown" } }
    ]
  }));
  writeFileSync(join(directory, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(join(directory, "index.json"), JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", ...index, annotations: { "org.opencontainers.image.ref.name": `sha-${options.revision}` } }]
  }));
  return { indexDigest: index.digest, imageDigest: image.digest, provenanceBlob: join(directory, "blobs", "sha256", provenance.digest.slice(7)) };
};

describe("locally built release artifacts are verified before signing", () => {
  const revision = "a".repeat(40);
  const verifyLayout = (layout: string, digest: string, policy: { builderId?: string } = {}) => spawnSync("bash", [join(root, "scripts/local-ci/jobs.sh"), "release-artifact-verify"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, LCI_ARTIFACT_LAYOUT: layout, LCI_CANDIDATE_DIGEST: digest, LCI_SOURCE_SHA: revision, LCI_TRUST_BUILDER_ID: policy.builderId ?? trust.localSigner.builderId }
  });

  it.each(["v0.1", "v1"])("accepts the single linux/amd64 image with bound %s provenance and SBOM envelopes", (statementVersion) => {
    const layout = fresh("layout");
    const { indexDigest } = buildLayout(layout, { revision, statementType: `https://in-toto.io/Statement/${statementVersion}` });
    const result = verifyLayout(layout, indexDigest);
    expect(result.status, output(result)).toBe(0);
  });

  it.each(["provenanceEnvelope", "sbomEnvelope"] as const)("rejects invalid %s identity and descriptor mismatch", (envelope) => {
    const cases: Array<{ name: string; value: Json }> = [
      { name: "unknown statement version", value: { _type: "https://in-toto.io/Statement/v2" } },
      { name: "missing statement type", value: { _type: null } },
      { name: "empty subjects", value: { subject: [] } },
      { name: "malformed subjects", value: { subject: {} } },
      { name: "wrong image subject", value: { subject: [{ name: "another-image", digest: { sha256: "e".repeat(64) } }] } },
      { name: "descriptor predicate mismatch", value: { predicateType: "https://example.invalid/other-predicate" } }
    ];
    for (const statementVersion of ["v0.1", "v1"]) {
      for (const testCase of cases) {
        const layout = fresh("layout");
        const built = buildLayout(layout, { revision, statementType: `https://in-toto.io/Statement/${statementVersion}`, [envelope]: testCase.value });
        const result = verifyLayout(layout, built.indexDigest);
        expect(result.status, `${statementVersion} ${testCase.name}: ${output(result)}`).not.toBe(0);
      }
    }
  }, 60_000);

  it("rejects wrong identity, platform, builder, private paths, missing SBOM, tampered blobs and unbound provenance", () => {
    const cases: Array<{ name: string; options?: Partial<LayoutOptions>; digest?: string; tamper?: (layout: string, built: ReturnType<typeof buildLayout>) => void }> = [
      { name: "revision label mismatch", options: { revisionLabel: "b".repeat(40) } },
      { name: "arm64 image", options: { architecture: "arm64" } },
      { name: "GitHub-run builder", options: { builderId: "https://github.com/jremick/moodarr/actions/runs/1/attempts/1" } },
      { name: "host path in provenance", options: { provenanceExtra: { internalParameters: { buildConfig: { context: "/home/builder/checkout" } } } } },
      { name: "GitHub event data in provenance", options: { provenanceExtra: { internalParameters: { github_actor: "fixture-user" } } } },
      { name: "missing SBOM attestation", options: { omitSbom: true } },
      { name: "provenance for another image", options: { provenanceSubjectDigest: `sha256:${"e".repeat(64)}` } },
      { name: "approved digest differs", digest: `sha256:${"f".repeat(64)}` },
      { name: "tampered provenance blob", tamper: (_layout, built) => writeFileSync(built.provenanceBlob, "{}") }
    ];
    for (const testCase of cases) {
      const layout = fresh("layout");
      const built = buildLayout(layout, { revision, ...testCase.options });
      testCase.tamper?.(layout, built);
      const result = verifyLayout(layout, testCase.digest ?? built.indexDigest);
      expect(result.status, `${testCase.name}: ${output(result)}`).not.toBe(0);
    }
  }, 60_000);
});

describe("supply-chain provenance follows the version's trust policy", () => {
  const runEvidence = (builderId: string, policy: string) => {
    const directory = fresh("supply");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const layout = join(directory, "layout");
    const revision = "a".repeat(40);
    const built = buildLayout(layout, { revision, builderId });
    const blob = (digest: string) => readFileSync(join(layout, "blobs", "sha256", digest.slice(7)), "utf8");
    const index = blob(built.indexDigest);
    const imageManifest = JSON.parse(blob(built.imageDigest)) as Json;
    writeFileSync(join(directory, "manifest.json"), index);
    writeFileSync(join(directory, "image.json"), blob(imageManifest.config.digest));
    const statements = JSON.parse(blob(JSON.parse(index).manifests[1].digest)).layers.map((entry: Json) => JSON.parse(blob(entry.digest)));
    writeFileSync(join(directory, "provenance.json"), JSON.stringify({ SLSA: statements[0].predicate }));
    writeFileSync(join(directory, "sbom.json"), JSON.stringify({ SPDX: statements[1].predicate }));
    writeExecutable(join(bin, "docker"), `#!/usr/bin/env bash
case "$*" in
  *" --raw") cat "${directory}/manifest.json" ;;
  *"{{json .Image}}"*) cat "${directory}/image.json" ;;
  *"{{json .Provenance}}"*) cat "${directory}/provenance.json" ;;
  *"{{json .SBOM}}"*) cat "${directory}/sbom.json" ;;
  *) exit 64 ;;
esac
`);
    const subjobDir = join(directory, "evidence");
    mkdirSync(subjobDir);
    return spawnSync("bash", [join(root, "scripts/local-ci/jobs.sh"), "supply-chain-verify-evidence"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, LCI_SUBJOB_DIR: subjobDir, LCI_CANDIDATE_DIGEST: built.indexDigest, LCI_SOURCE_SHA: revision, LCI_TRUST_POLICY: policy, LCI_TRUST_BUILDER_ID: policy === "local-signer" ? trust.localSigner.builderId : "" }
    });
  };

  it("requires the pinned local builder for local-signer candidates and a GitHub run for GitHub-hosted ones", () => {
    const github = "https://github.com/jremick/moodarr/actions/runs/1/attempts/1";
    expect(runEvidence(trust.localSigner.builderId, "local-signer").status).toBe(0);
    expect(runEvidence(github, "local-signer").status).not.toBe(0);
    expect(runEvidence(trust.localSigner.builderId, "github-hosted").status).not.toBe(0);
    expect(runEvidence(github, "github-hosted").status).toBe(0);
  }, 60_000);
});

describe("release-build refuses to produce a locally signed artifact outside its trust boundary", () => {
  const runBuild = (repo: string, sha: string, adjustFakes?: (fakes: Fakes, dockerConfig: string) => void, mainSha = sha) => {
    const fakes = installFakes();
    const dockerConfig = join(fakes.bin, "docker-config");
    mkdirSync(join(dockerConfig, "cli-plugins"), { recursive: true });
    writeExecutable(join(dockerConfig, "cli-plugins", "docker-buildx"), "not the pinned buildx binary\n");
    writeExecutable(join(fakes.bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(cd "$(dirname "$0")" && pwd)/docker.calls"
case "$1 \${2:-}" in
  "buildx version") echo "github.com/docker/buildx v0.34.1 fixture" ;;
  "buildx inspect") exit 1 ;;
  "image inspect") exit 1 ;;
  "ps "*|"volume ls"|"network ls") ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 64 ;;
esac
`);
    adjustFakes?.(fakes, dockerConfig);
    const evidence = join(fresh("evidence"), "out");
    const result = spawnSync("bash", [join(repo, "scripts/local-ci.sh"), "release-build"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: fakePath(fakes), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DOCKER_CONFIG: dockerConfig, LOCAL_CI_RUN_ID: "release-build-fixture", LOCAL_CI_EVIDENCE_DIR: evidence, LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_MAIN_SHA: mainSha } as NodeJS.ProcessEnv
    });
    const summary = existsSync(join(evidence, "result.json")) ? readJson(join(evidence, "result.json")) : {};
    const source = (summary.subjobs as Json[] | undefined)?.find((entry) => entry.name === "release-source");
    const image = (summary.subjobs as Json[] | undefined)?.find((entry) => entry.name === "release-image");
    const log = existsSync(join(evidence, "logs/release-image.log")) ? readFileSync(join(evidence, "logs/release-image.log"), "utf8") : "";
    return { result, source, image, docker: calls(fakes.bin, "docker"), log };
  };

  // publish-image.yml requires the candidate to be the main dispatch commit, "not merely an older ancestor".
  it("builds only the current main commit, not an older main ancestor that release-check accepts", () => {
    const fixture = createRepo({ version: localVersion });
    writeFileSync(join(fixture.repo, "later-main-change.txt"), "main moved on\n");
    const currentMain = commitAll(fixture.repo, "later main commit");
    git(fixture.repo, "checkout", "-q", "--detach", fixture.sha);
    const { result, source, image, docker, log } = runBuild(fixture.repo, fixture.sha, undefined, currentMain);
    expect(result.status, output(result)).toBe(1);
    expect(source?.status, "the ancestry gate shared with release-check still accepts the older commit").toBe("passed");
    expect(image?.status).toBe("failed");
    expect(log).toMatch(/must equal the current main commit/);
    expect(docker).not.toMatch(/^buildx (build|create) /m);
  }, 60_000);

  it("fails before building for a GitHub-trust version, a non-public origin or an unpinned Buildx", () => {
    const publishedBeta6 = createRepo({ version: publishedVersion });
    const privateOrigin = createRepo({ version: localVersion });
    git(privateOrigin.repo, "remote", "set-url", "origin", "git@example.invalid:mirror/moodarr.git");
    const credentialOrigin = createRepo({ version: localVersion });
    git(credentialOrigin.repo, "remote", "set-url", "origin", "https://fixture-user:fixture-origin-secret@github.com/jremick/moodarr.git");
    const unpinned = createRepo({ version: localVersion });
    for (const [name, fixture, reason] of [
      ["published GitHub-trust beta.6", publishedBeta6, /pinned to the github-hosted publisher/],
      ["non-public origin", privateOrigin, /origin must be the public/],
      ["credential-bearing origin", credentialOrigin, /origin must be the public/],
      ["unpinned Buildx", unpinned, /Buildx plugin does not match/]
    ] as const) {
      const { result, image, docker, log } = runBuild(fixture.repo, fixture.sha);
      expect(result.status, `${name}: ${output(result)}`).toBe(1);
      expect(image?.status, name).toBe("failed");
      expect(log, name).toMatch(reason);
      expect(log, name).not.toContain("fixture-origin-secret");
      expect(docker, name).not.toMatch(/^buildx (build|create) /m);
    }
  }, 120_000);

  it("accepts the .git form of the public origin and builds with the canonical source URL", () => {
    const dotGit = createRepo({ version: localVersion });
    git(dotGit.repo, "remote", "set-url", "origin", "https://github.com/jremick/moodarr.git");
    const { log } = runBuild(dotGit.repo, dotGit.sha);
    expect(log).not.toMatch(/origin must be the public/);
    expect(log).toMatch(/Buildx plugin does not match/);
    // The build step rewrites the .git form for Buildx's `git remote get-url origin` without touching the checkout.
    const canonical = spawnSync(realGit, ["remote", "get-url", "origin"], {
      cwd: dotGit.repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.https://github.com/jremick/moodarr.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/jremick/moodarr.git" }
    });
    expect(canonical.stdout.trim()).toBe("https://github.com/jremick/moodarr");
    expect(git(dotGit.repo, "config", "--get", "remote.origin.url")).toBe("https://github.com/jremick/moodarr.git");
  }, 60_000);
});

describe("verifier commands consumed by the private controller", () => {
  const runStep = (repo: string, command: string, env: Record<string, string>) => {
    const subjobDir = join(fresh("evidence"), command);
    mkdirSync(subjobDir);
    const result = spawnSync("bash", [join(repo, "scripts/local-ci/jobs.sh"), command], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: { PATH: fakePath(installFakes()), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LCI_SUBJOB_DIR: subjobDir, ...env } as NodeJS.ProcessEnv
    });
    return { result, subjobDir };
  };

  it("resolves the main-anchored policy for the checkout version, listing only active pinned keys", () => {
    const published = createRepo({ version: publishedVersion });
    const beta6 = runStep(published.repo, "trust-resolve", { LCI_MAIN_SHA: published.sha });
    expect(beta6.result.status, output(beta6.result)).toBe(0);
    expect(JSON.parse(beta6.result.stdout)).toMatchObject({ packageVersion: publishedVersion, mainRevision: published.sha, policy: "github-hosted" });

    const future = createRepo({ version: localVersion });
    const beta7 = runStep(future.repo, "trust-resolve", { LCI_MAIN_SHA: future.sha });
    expect(beta7.result.status, output(beta7.result)).toBe(0);
    expect(JSON.parse(beta7.result.stdout)).toEqual({
      schemaVersion: "moodarr-release-trust-resolution-v1",
      packageVersion: localVersion,
      mainRevision: future.sha,
      policy: "local-signer",
      builderId: trust.localSigner.builderId,
      buildType: trust.localSigner.buildType,
      sourceUri: trust.localSigner.sourceUri,
      keys: [pinnedKey]
    });

    editJson(join(future.repo, ".github/release-trust.json"), (policy) => { policy.localSigner.keys[0].status = "revoked"; });
    const revokedMain = commitAll(future.repo, "revoke key");
    expect(JSON.parse(runStep(future.repo, "trust-resolve", { LCI_MAIN_SHA: revokedMain }).result.stdout).keys).toEqual([]);
  }, 60_000);

  it("verifies a controller-produced statement with the same contract as candidate-check", () => {
    const future = createRepo({ version: localVersion });
    const inputs = fresh("inputs");
    const { statement, bundle } = signed(statementFor(candidateDigest, future.sha, localVersion));
    writeFileSync(join(inputs, "statement.json"), statement);
    writeFileSync(join(inputs, "statement.sigstore.json"), bundle);
    const env = { LCI_MAIN_SHA: future.sha, LCI_SOURCE_SHA: future.sha, LCI_CANDIDATE_DIGEST: candidateDigest, LCI_SIGNED_STATEMENT: join(inputs, "statement.json"), LCI_SIGNATURE_BUNDLE: join(inputs, "statement.sigstore.json") };
    const valid = runStep(future.repo, "local-signer-verify", env);
    expect(valid.result.status, output(valid.result)).toBe(0);
    expect(readJson(join(valid.subjobDir, "attestation.json"))).toMatchObject({ policy: "local-signer", keyId: pinnedKey.id, packageVersion: localVersion });

    const otherDigest = runStep(future.repo, "local-signer-verify", { ...env, LCI_CANDIDATE_DIGEST: `sha256:${"d".repeat(64)}` });
    expect(otherDigest.result.status, output(otherDigest.result)).not.toBe(0);

    const published = createRepo({ version: publishedVersion });
    const githubVersion = runStep(published.repo, "local-signer-verify", { ...env, LCI_MAIN_SHA: published.sha, LCI_SOURCE_SHA: published.sha });
    expect(githubVersion.result.status, output(githubVersion.result)).not.toBe(0);
    expect(output(githubVersion.result)).toMatch(/not pinned to the local release signer/);
  }, 60_000);
});
