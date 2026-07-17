import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const failures: string[] = [];
const require = createRequire(import.meta.url);
const { load: parseYamlDocument } = require("js-yaml") as { load: (source: string) => unknown };

type Mapping = Record<string, unknown>;

type WorkflowDocument = Mapping & {
  jobs: Record<string, WorkflowJob>;
};

type WorkflowJob = Mapping & {
  steps?: WorkflowStep[];
};

type WorkflowStep = Mapping & {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
};

const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish-image.yml";
const RELEASE_REVOCATIONS_PATH = ".github/release-revocations.json";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const RELEASE_VERIFY_WORKFLOW_PATH = ".github/workflows/release-verify.yml";
const VALIDATE_CANDIDATE_WORKFLOW_PATH = ".github/workflows/validate-beta-candidate.yml";
const BUILD_X_VERSION = "v0.34.1";
const BUILD_X_ASSET_ID = "424359377";
const BUILD_X_SHA256 = "f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b";
const BUILD_KIT_IMAGE = "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f";
const SBOM_GENERATOR = "generator=docker/buildkit-syft-scanner:stable-1@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68";
const CHECKOUT_ACTION = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const SETUP_NODE_ACTION = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const LOGIN_ACTION = "docker/login-action@af1e73f918a031802d376d3c8bbc3fe56130a9b0";
const BUILD_PUSH_ACTION = "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a";
const ATTEST_ACTION = "actions/attest@a1948c3f048ba23858d222213b7c278aabede763";
const SETUP_TRIVY_ACTION = "aquasecurity/setup-trivy@81e514348e19b6112ce2a7e3ecbafe19c1e1f567";
const UPLOAD_ARTIFACT_ACTION = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

const read = (path: string) => readFileSync(join(root, path), "utf8");
const includes = (path: string, value: string) => {
  if (!read(path).includes(value)) failures.push(`${path} does not include ${value}`);
};

const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

const mappingField = (mapping: Mapping, key: string, context: string): Mapping => {
  const value = mapping[key];
  if (!isMapping(value)) throw new Error(`${context}.${key} must be a mapping`);
  return value;
};

const stringField = (mapping: Mapping, key: string, context: string): string => {
  const value = mapping[key];
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string`);
  return value;
};

const loadWorkflow = (path: string): WorkflowDocument => {
  const document = parseYamlDocument(read(path));
  if (!isMapping(document)) throw new Error(`${path} must parse to a mapping`);
  const jobs = mappingField(document, "jobs", path);
  for (const [jobId, value] of Object.entries(jobs)) {
    if (!isMapping(value)) throw new Error(`${path}.jobs.${jobId} must be a mapping`);
    if (value.steps !== undefined) {
      if (!Array.isArray(value.steps) || !value.steps.every(isMapping)) {
        throw new Error(`${path}.jobs.${jobId}.steps must be a sequence of mappings`);
      }
    }
  }
  return document as WorkflowDocument;
};

const workflowJob = (workflow: WorkflowDocument, jobId: string, path: string): WorkflowJob => {
  const value = workflow.jobs[jobId];
  if (!isMapping(value)) throw new Error(`${path} is missing job ${jobId}`);
  return value;
};

const workflowSteps = (job: WorkflowJob, context: string): WorkflowStep[] => {
  if (!Array.isArray(job.steps) || !job.steps.every(isMapping)) throw new Error(`${context}.steps must be a sequence of mappings`);
  return job.steps;
};

const namedStep = (job: WorkflowJob, name: string, context: string): WorkflowStep => {
  const matches = workflowSteps(job, context).filter((step) => step.name === name);
  if (matches.length !== 1) throw new Error(`${context} must contain exactly one step named ${JSON.stringify(name)}; found ${matches.length}`);
  return matches[0]!;
};

const stepPosition = (job: WorkflowJob, name: string, context: string): number => {
  namedStep(job, name, context);
  return workflowSteps(job, context).findIndex((step) => step.name === name);
};

const expect = (condition: boolean, message: string) => {
  if (!condition) failures.push(message);
};

const expectEqual = (actual: unknown, expected: unknown, message: string) => {
  if (actual !== expected) failures.push(`${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const expectStringSet = (actual: unknown, expected: string[], message: string) => {
  const actualValues = typeof actual === "string" ? [actual] : actual;
  if (!Array.isArray(actualValues) || !actualValues.every((value) => typeof value === "string")) {
    failures.push(`${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }
  const normalizedActual = [...actualValues].sort();
  const normalizedExpected = [...expected].sort();
  expect(JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected), `${message}; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const expectPermissions = (job: Mapping, expected: Record<string, "read" | "write">, context: string) => {
  const permissions = mappingField(job, "permissions", context);
  const actualEntries = Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  expect(JSON.stringify(actualEntries) === JSON.stringify(expectedEntries), `${context}.permissions must be exactly ${JSON.stringify(expected)}`);
};

const expectEmptyPermissions = (workflow: WorkflowDocument, context: string) => {
  const permissions = mappingField(workflow, "permissions", context);
  expectEqual(Object.keys(permissions).length, 0, `${context}.permissions must deny all permissions by default`);
};

const inspectWorkflow = (path: string, inspect: (workflow: WorkflowDocument) => void) => {
  try {
    inspect(loadWorkflow(path));
  } catch (error) {
    failures.push(`${path} semantic inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const expectRunContains = (step: WorkflowStep, fragments: string[], context: string) => {
  const run = stringField(step, "run", context);
  for (const fragment of fragments) expect(run.includes(fragment), `${context}.run must include ${JSON.stringify(fragment)}`);
  return run;
};

const expectStepBefore = (job: WorkflowJob, first: string, second: string, context: string) => {
  expect(stepPosition(job, first, context) < stepPosition(job, second, context), `${context} step ${JSON.stringify(first)} must run before ${JSON.stringify(second)}`);
};

const expectNeedsAuthorize = (job: WorkflowJob, context: string) => {
  const needs = job.needs;
  expect(needs === "authorize" || (Array.isArray(needs) && needs.length === 1 && needs[0] === "authorize"), `${context}.needs must be exactly authorize`);
};

const expectNoSetupBuildxAction = (workflow: WorkflowDocument, context: string) => {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      expect(step.uses !== undefined ? !step.uses.startsWith("docker/setup-buildx-action@") : true, `${context}.jobs.${jobId} must not execute setup-buildx-action before verifying the Buildx binary`);
    }
  }
};

const expectStepUses = (step: WorkflowStep, expected: string, context: string) => {
  expectEqual(step.uses, expected, `${context}.uses must use the approved full commit pin`);
};

const expectStepWith = (step: WorkflowStep, expected: Record<string, unknown>, context: string) => {
  const withValues = mappingField(step, "with", context);
  for (const [key, value] of Object.entries(expected)) expectEqual(withValues[key], value, `${context}.with.${key}`);
  return withValues;
};

const expectPinnedBuilderStep = (step: WorkflowStep, context: string, requirePrivateProvenance: boolean) => {
  expectEqual(step.id, "buildx", `${context}.id`);
  expectEqual(step.shell, "bash", `${context}.shell`);
  expectEqual(step.uses, undefined, `${context} must invoke the already-verified Buildx client directly`);
  const environment = mappingField(step, "env", context);
  expectEqual(environment.BUILDKIT_IMAGE, BUILD_KIT_IMAGE, `${context}.env.BUILDKIT_IMAGE`);
  const run = expectRunContains(step, [
    "docker buildx create",
    "--driver docker-container",
    '--driver-opt "image=$BUILDKIT_IMAGE"',
    "--use",
    "for attempt in 1 2 3; do",
    'if inspect_output="$(docker buildx inspect "$builder_name" --bootstrap 2>&1)"; then',
    'docker buildx inspect "$builder_name" --bootstrap',
    'docker buildx rm -f "$builder_name"',
    'sleep "$attempt"',
    'test "$buildkit_version" = "v0.30.0"',
    'echo "name=$builder_name" >> "$GITHUB_OUTPUT"'
  ], context);
  expect(!run.includes('{ print $3; exit }'), `${context} must consume complete Buildx inspect output without inducing SIGPIPE`);
  if (requirePrivateProvenance) {
    expect(run.includes('--driver-opt "provenance-add-gha=false"'), `${context} must disable GitHub event payload enrichment in public provenance`);
  }
};

const expectVerifiedBuildxInstall = (job: WorkflowJob, loginStepName: string, context: string) => {
  const install = namedStep(job, "Install verified Docker Buildx client", context);
  expectEqual(install.shell, "bash", `${context} verified Buildx install shell`);
  expectEqual(install.uses, undefined, `${context} verified Buildx install must not execute an action`);
  expectEqual(install.run, "bash scripts/install-pinned-buildx.sh", `${context} verified Buildx installer command`);
  expectStepBefore(job, "Install verified Docker Buildx client", loginStepName, context);
};

const expectCandidateBindingStep = (job: WorkflowJob, context: string) => {
  const step = namedStep(job, "Bind candidate provenance and main ancestry", context);
  expectEqual(step.shell, "bash", `${context} provenance binding shell`);
  const run = expectRunContains(step, [
    "command -v gh >/dev/null",
    "git fetch --no-tags --prune origin",
    'git merge-base --is-ancestor "$EXPECTED_REVISION" origin/main',
    'gh attestation verify "oci://$CANDIDATE_IMAGE"',
    "--repo jremick/moodarr",
    "--signer-workflow jremick/moodarr/.github/workflows/publish-image.yml",
    '--signer-digest "$EXPECTED_REVISION"',
    '--source-digest "$EXPECTED_REVISION"',
    "--source-ref refs/heads/main",
    "--deny-self-hosted-runners",
    "--format json",
    'jq -e \'type == "array" and length > 0\' "$attestation_report" >/dev/null'
  ], `${context} provenance binding`);
  expect(!run.includes('test -s "$attestation_report"'), `${context} must not require default gh attestation stdout`);
};

const expectCandidateMainAncestryProof = (job: WorkflowJob, context: string) => {
  const inputValidation = namedStep(job, "Validate immutable candidate input", context);
  const inputValidationRun = expectRunContains(inputValidation, [
    '[[ ! "$CANDIDATE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
    '[[ ! "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]',
    'test "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"',
    'echo "image=ghcr.io/jremick/moodarr@$CANDIDATE_DIGEST" >> "$GITHUB_OUTPUT"'
  ], `${context} immutable input validation`);
  for (const repositoryExecutionMarker of ["scripts/", "npm ", "npx ", "node ", "tsx ", "docker ", "bash ", "source ", "./"]) {
    expect(!inputValidationRun.includes(repositoryExecutionMarker), `${context} immutable input validation must not execute checked-out repository code before ancestry proof`);
  }
  const step = namedStep(job, "Prove candidate source is reachable from current main", context);
  expectEqual(step.shell, "bash", `${context} candidate ancestry proof shell`);
  expectEqual(
    mappingField(step, "env", `${context} candidate ancestry proof`).EXPECTED_REVISION,
    "${{ inputs.expected_revision }}",
    `${context} candidate ancestry proof revision input`
  );
  const run = expectRunContains(step, [
    'resolved_revision="$(git rev-parse HEAD)"',
    '[[ "$resolved_revision" != "$EXPECTED_REVISION" ]]',
    'git fetch --no-tags --prune origin "+refs/heads/main:refs/remotes/origin/main"',
    'git merge-base --is-ancestor "$EXPECTED_REVISION" origin/main'
  ], `${context} candidate ancestry proof`);
  expect(!run.includes("scripts/") && !run.includes("npm ") && !run.includes("docker "), `${context} candidate ancestry proof must use only trusted runner and Git commands`);
  expectEqual(stepPosition(job, "Prove candidate source is reachable from current main", context), 2, `${context} candidate ancestry proof must be the third step, immediately after checkout and immutable input validation`);
  expectStepBefore(job, "Validate immutable candidate input", "Prove candidate source is reachable from current main", context);
  expectStepBefore(job, "Prove candidate source is reachable from current main", "Bind candidate provenance and main ancestry", context);
};

const expectReleaseMainAncestryProof = (job: WorkflowJob, context: string) => {
  const step = namedStep(job, "Prove release source is reachable from current main", context);
  expectEqual(step.shell, "bash", `${context} release ancestry proof shell`);
  expectEqual(
    mappingField(step, "env", `${context} release ancestry proof`).RELEASE_REF,
    "${{ inputs.ref }}",
    `${context} release ancestry proof input`
  );
  const run = expectRunContains(step, [
    'resolved_sha="$(git rev-parse HEAD)"',
    '[[ ! "$resolved_sha" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]',
    '[[ "$resolved_sha" != "$RELEASE_REF" ]]',
    'git fetch --no-tags --prune origin "+refs/heads/main:refs/remotes/origin/main"',
    'git merge-base --is-ancestor "$resolved_sha" origin/main'
  ], `${context} release ancestry proof`);
  expect(!run.includes("scripts/") && !run.includes("npm ") && !run.includes("docker "), `${context} release ancestry proof must use only trusted runner and Git commands`);
  expectEqual(stepPosition(job, "Prove release source is reachable from current main", context), 1, `${context} release ancestry proof must run immediately after checkout`);
};

const singleStepUsing = (job: WorkflowJob, action: string, context: string): WorkflowStep => {
  const matches = workflowSteps(job, context).filter((step) => step.uses === action);
  if (matches.length !== 1) throw new Error(`${context} must contain exactly one step using ${action}; found ${matches.length}`);
  return matches[0]!;
};

const expectPinnedActionReference = (uses: string, context: string) => {
  if (uses.startsWith("./")) return;
  expect(/^[^\s@]+@[0-9a-f]{40}$/.test(uses), `${context} must pin ${JSON.stringify(uses)} to a full lowercase commit SHA`);
};

const auditActionPins = () => {
  for (const entry of readdirSync(join(root, ".github", "workflows"))) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const path = `.github/workflows/${entry}`;
    inspectWorkflow(path, (workflow) => {
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (typeof job.uses === "string") expectPinnedActionReference(job.uses, `${path}.jobs.${jobId}.uses`);
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          if (typeof step.uses === "string") expectPinnedActionReference(step.uses, `${path}.jobs.${jobId}.steps[${stepIndex}].uses`);
        }
      }
    });
  }
};

const auditPinnedBuildxInstaller = () => {
  const path = "scripts/install-pinned-buildx.sh";
  try {
    execFileSync("bash", ["-n", path], { cwd: root, stdio: "pipe" });
  } catch (error) {
    failures.push(`${path} must pass bash syntax validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  const script = read(path);
  expect(script.includes(`readonly buildx_version="${BUILD_X_VERSION}"`), `${path} must pin Buildx ${BUILD_X_VERSION}`);
  expect(script.includes(`readonly buildx_asset_id="${BUILD_X_ASSET_ID}"`), `${path} must address the approved immutable release asset ID`);
  expect(script.includes(`readonly buildx_sha256="${BUILD_X_SHA256}"`), `${path} must pin the approved Linux amd64 Buildx digest`);
  expect(script.includes('"https://api.github.com/repos/docker/buildx/releases/assets/$buildx_asset_id"'), `${path} must download the pinned GitHub release asset by ID`);

  const downloadIndex = script.indexOf('"https://api.github.com/repos/docker/buildx/releases/assets/$buildx_asset_id"');
  const downloadVerificationIndex = script.indexOf('"$buildx_sha256" "$download_path" | sha256sum --check --strict');
  const installIndex = script.indexOf('install -m 0755 "$download_path" "$plugin_path"');
  const installedVerificationIndex = script.indexOf('"$buildx_sha256" "$plugin_path" | sha256sum --check --strict');
  const executionIndex = script.indexOf("docker buildx version");
  expect(
    downloadIndex >= 0
      && downloadVerificationIndex > downloadIndex
      && installIndex > downloadVerificationIndex
      && installedVerificationIndex > installIndex
      && executionIndex > installedVerificationIndex,
    `${path} must verify the downloaded bytes before installing or executing Buildx, then verify the installed bytes again`
  );
};

const auditCiWorkflow = () => {
  inspectWorkflow(CI_WORKFLOW_PATH, (workflow) => {
    const verifyContext = `${CI_WORKFLOW_PATH}.jobs.verify`;
    const verify = workflowJob(workflow, "verify", CI_WORKFLOW_PATH);
    expectEqual(verify["runs-on"], "ubuntu-24.04", `${verifyContext}.runs-on`);
    expectPermissions(verify, { contents: "read" }, verifyContext);
    expectEqual(
      mappingField(verify, "env", verifyContext).SOURCE_SHA,
      "${{ github.event.pull_request.head.sha || github.sha }}",
      `${verifyContext} exact event source`
    );
    const verifyCheckout = singleStepUsing(verify, CHECKOUT_ACTION, verifyContext);
    expectStepWith(verifyCheckout, {
      ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      "persist-credentials": false
    }, `${verifyContext} checkout`);
    const verifySource = namedStep(verify, "Validate exact event source", verifyContext);
    expectRunContains(verifySource, [
      '[[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]',
      'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"'
    ], `${verifyContext} source binding`);
    const releaseVerification = namedStep(verify, "Run release verification", verifyContext);
    expectEqual(releaseVerification.run, "npm run verify:release", `${verifyContext} canonical release command`);
    expectEqual(
      mappingField(releaseVerification, "env", `${verifyContext} canonical release command`).MOODARR_SECRETS_REQUIRE_BUILD,
      "true",
      `${verifyContext} canonical release command must require generated-client secret scanning`
    );
    const verifyRuns = workflowSteps(verify, verifyContext)
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string");
    for (const duplicatedCommand of [
      "npm run verify:docs",
      "npm run lint",
      "npm run typecheck",
      "npm run test",
      "npm run build",
      "npm run verify:secrets:ci",
      "npm run eval:recommendations",
      "npm run eval:moodrank-release-readiness",
      "npm run test:packaging",
      "npm run smoke:container"
    ]) {
      expect(!verifyRuns.includes(duplicatedCommand), `${verifyContext} must not duplicate ${duplicatedCommand} outside verify:release`);
    }

    const scanContext = `${CI_WORKFLOW_PATH}.jobs.container-scan`;
    const scan = workflowJob(workflow, "container-scan", CI_WORKFLOW_PATH);
    expectEqual(scan.if, undefined, `${scanContext} must run for pull requests and main pushes`);
    expectEqual(scan["runs-on"], "ubuntu-24.04", `${scanContext}.runs-on`);
    expectPermissions(scan, { contents: "read" }, scanContext);
    expectEqual(
      mappingField(scan, "env", scanContext).SOURCE_SHA,
      "${{ github.event.pull_request.head.sha || github.sha }}",
      `${scanContext} exact event source`
    );

    const checkout = namedStep(scan, "Check out exact event source", scanContext);
    expectStepUses(checkout, CHECKOUT_ACTION, `${scanContext} checkout`);
    expectStepWith(checkout, {
      ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      "persist-credentials": false
    }, `${scanContext} checkout`);

    const build = namedStep(scan, "Build exact event source image", scanContext);
    expectRunContains(build, [
      'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
      '--build-arg "MOODARR_BUILD_REVISION=$SOURCE_SHA"',
      '--build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none"',
      '--build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none"',
      'test "$image_revision" = "$SOURCE_SHA"',
      'test "$ai_policy" = "none"',
      'test "$tmdb_policy" = "none"',
      "moodarr-container-scan-v2"
    ], `${scanContext} exact source build`);

    const trivyInstall = namedStep(scan, "Install Trivy", scanContext);
    expectStepUses(trivyInstall, SETUP_TRIVY_ACTION, `${scanContext} Trivy install`);
    expectStepWith(trivyInstall, { version: "v0.70.0" }, `${scanContext} Trivy install`);

    const record = namedStep(scan, "Record high and critical runtime findings", scanContext);
    expectRunContains(record, [
      "--scanners vuln",
      "--severity HIGH,CRITICAL",
      "trivy-high-critical.json",
      "--exit-code 0",
      "--vex .vex/moodarr.openvex.json"
    ], `${scanContext} findings record`);
    const actionable = namedStep(scan, "Reject fixable high and critical runtime findings", scanContext);
    expectRunContains(actionable, [
      "--scanners vuln",
      "--severity HIGH,CRITICAL",
      "--ignore-unfixed",
      "trivy-actionable.json",
      "--exit-code 1",
      "--vex .vex/moodarr.openvex.json"
    ], `${scanContext} actionable findings gate`);

    const upload = namedStep(scan, "Upload container-scan evidence", scanContext);
    expectStepUses(upload, UPLOAD_ARTIFACT_ACTION, `${scanContext} evidence upload`);
    expectEqual(upload.if, "always()", `${scanContext} evidence upload condition`);
    const uploadWith = expectStepWith(upload, {
      "if-no-files-found": "error",
      name: "container-scan-${{ github.run_id }}-${{ github.run_attempt }}",
      "retention-days": 30
    }, `${scanContext} evidence upload`);
    expectStringSet(
      stringField(uploadWith, "path", `${scanContext} evidence upload.with`)
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
      [
        "${{ runner.temp }}/moodarr-container-scan/image-identity.json",
        "${{ runner.temp }}/moodarr-container-scan/trivy-high-critical.json",
        "${{ runner.temp }}/moodarr-container-scan/trivy-actionable.json"
      ],
      `${scanContext} evidence upload must use the exact public allowlist`
    );

    const nativeContext = `${CI_WORKFLOW_PATH}.jobs.native-source-validation`;
    const native = workflowJob(workflow, "native-source-validation", CI_WORKFLOW_PATH);
    expectEqual(native.if, undefined, `${nativeContext} must run for pull requests and main pushes`);
    expectEqual(native["runs-on"], "ubuntu-24.04", `${nativeContext}.runs-on`);
    expectEqual(native["timeout-minutes"], 45, `${nativeContext}.timeout-minutes`);
    expectPermissions(native, { contents: "read" }, nativeContext);
    const nativeStrategy = mappingField(native, "strategy", nativeContext);
    expectEqual(nativeStrategy["fail-fast"], false, `${nativeContext}.strategy.fail-fast`);
    expectStringSet(
      mappingField(nativeStrategy, "matrix", `${nativeContext}.strategy`).validation,
      ["clean-install", "alpha21-upgrade-rollback"],
      `${nativeContext} must use the closed native validation matrix`
    );
    const nativeEnvironment = mappingField(native, "env", nativeContext);
    expectEqual(nativeEnvironment.SOURCE_SHA, "${{ github.event.pull_request.head.sha || github.sha }}", `${nativeContext} exact event source`);
    expectEqual(nativeEnvironment.VALIDATION, "${{ matrix.validation }}", `${nativeContext} closed matrix selector`);
    expect(!JSON.stringify(native).includes("secrets."), `${nativeContext} must not consume repository or environment secrets`);

    const nativeCheckout = namedStep(native, "Check out exact event source", nativeContext);
    expectStepUses(nativeCheckout, CHECKOUT_ACTION, `${nativeContext} checkout`);
    expectStepWith(nativeCheckout, {
      ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      "persist-credentials": false
    }, `${nativeContext} checkout`);
    const nativeSource = namedStep(native, "Validate exact event source", nativeContext);
    expectRunContains(nativeSource, [
      '[[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]',
      'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
      'test -z "$(git status --porcelain)"'
    ], `${nativeContext} source binding`);
    const nativeNode = namedStep(native, "Set up Node 24", nativeContext);
    expectStepUses(nativeNode, SETUP_NODE_ACTION, `${nativeContext} Node setup`);
    expectStepWith(nativeNode, { "node-version": 24, cache: "npm" }, `${nativeContext} Node setup`);
    expectEqual(namedStep(native, "Install locked dependencies", nativeContext).run, "npm ci", `${nativeContext} locked dependency install`);

    const nativeBuild = namedStep(native, "Build and inspect exact local linux-amd64 image", nativeContext);
    expectEqual(nativeBuild.id, "image", `${nativeContext} image output step`);
    expectRunContains(nativeBuild, [
      "docker build",
      "--platform linux/amd64",
      '--build-arg "MOODARR_VERSION=$package_version"',
      '--build-arg "MOODARR_BUILD_REVISION=$SOURCE_SHA"',
      '--build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none"',
      '--build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none"',
      'test "$image_os" = "linux"',
      'test "$image_arch" = "amd64"',
      'test "$image_version" = "$package_version"',
      'test "$image_revision" = "$SOURCE_SHA"',
      'test "$ai_policy" = "none"',
      'test "$tmdb_policy" = "none"',
      "moodarr-native-source-image-v1",
      'test -z "$(git status --porcelain)"'
    ], `${nativeContext} exact local image build and identity`);

    const nativeValidation = namedStep(native, "Run and validate release-ineligible native rehearsal", nativeContext);
    const nativeValidationRun = expectRunContains(nativeValidation, [
      'case "$VALIDATION" in',
      "clean-install)",
      "alpha21-upgrade-rollback)",
      "expected_check_count=25",
      "expected_check_count=107",
      "requiredInstallModeCheckCodes",
      "requiredUpgradeCheckCodes",
      "npm run --silent validate:beta-install",
      "npm run --silent validate:beta-upgrade",
      "--allow-local-image",
      "validator_exit=$?",
      '[[ "$validator_exit" -ne 1 ]]',
      '.candidate.kind == "local-rehearsal"',
      '(.checkCodes | length) == 25',
      '(.checks | length) == 107',
      "stubCalls: 35",
      '.incomplete == ["local_rehearsal"]'
    ], `${nativeContext} fail-closed validator contract`);
    expectEqual((nativeValidationRun.match(/--allow-local-image/g) ?? []).length, 2, `${nativeContext} must acknowledge each local image exactly once`);
    expect(!nativeValidationRun.includes("--allow-dirty"), `${nativeContext} must require a clean committed source rehearsal`);
    expect(!nativeValidationRun.includes("--allow-emulation"), `${nativeContext} must require native linux-amd64 execution`);
    expect(!nativeValidationRun.includes("|| true"), `${nativeContext} must never erase validator exit status with an unqualified fallback`);

    const nativeCleanup = namedStep(native, "Prove validator-owned resources are absent", nativeContext);
    expectEqual(nativeCleanup.if, "always()", `${nativeContext} cleanup proof condition`);
    const nativeCleanupRun = expectRunContains(nativeCleanup, [
      "io.moodarr.beta-install.owner",
      "dev.moodarr.beta-upgrade-owner",
      "docker ps -a --filter",
      "docker volume ls --filter",
      "docker network ls --filter"
    ], `${nativeContext} owned-resource cleanup proof`);
    expect(!nativeCleanupRun.includes("docker rm") && !nativeCleanupRun.includes("docker volume rm") && !nativeCleanupRun.includes("docker network rm"), `${nativeContext} CI proof must not mask validator cleanup failures by removing resources itself`);

    const nativeUpload = namedStep(native, "Upload native source validation evidence", nativeContext);
    expectStepUses(nativeUpload, UPLOAD_ARTIFACT_ACTION, `${nativeContext} evidence upload`);
    expectEqual(nativeUpload.if, "always()", `${nativeContext} evidence upload condition`);
    const nativeUploadWith = expectStepWith(nativeUpload, {
      "if-no-files-found": "error",
      name: "native-source-${{ matrix.validation }}-${{ github.run_id }}-${{ github.run_attempt }}",
      "retention-days": 30
    }, `${nativeContext} evidence upload`);
    expectStringSet(
      stringField(nativeUploadWith, "path", `${nativeContext} evidence upload.with`)
        .split("\n")
        .map((path) => path.trim())
        .filter(Boolean),
      [
        "${{ runner.temp }}/moodarr-native-source-validation/report.json",
        "${{ runner.temp }}/moodarr-native-source-validation/image-identity.json"
      ],
      `${nativeContext} evidence upload must contain only the report and compact image identity`
    );
  });
};

const auditPublishWorkflow = () => {
  inspectWorkflow(PUBLISH_WORKFLOW_PATH, (workflow) => {
    expectEmptyPermissions(workflow, PUBLISH_WORKFLOW_PATH);
    expectNoSetupBuildxAction(workflow, PUBLISH_WORKFLOW_PATH);

    const triggers = mappingField(workflow, "on", PUBLISH_WORKFLOW_PATH);
    const dispatch = mappingField(triggers, "workflow_dispatch", `${PUBLISH_WORKFLOW_PATH}.on`);
    const inputs = mappingField(dispatch, "inputs", `${PUBLISH_WORKFLOW_PATH}.on.workflow_dispatch`);
    const releaseModeInput = mappingField(inputs, "release_mode", `${PUBLISH_WORKFLOW_PATH}.on.workflow_dispatch.inputs`);
    expectEqual(releaseModeInput.type, "choice", `${PUBLISH_WORKFLOW_PATH} release_mode input type`);
    expectEqual(releaseModeInput.required, true, `${PUBLISH_WORKFLOW_PATH} release_mode input must be required`);
    expectEqual(releaseModeInput.default, "candidate", `${PUBLISH_WORKFLOW_PATH} release_mode default`);
    expectStringSet(releaseModeInput.options, ["candidate", "promotion"], `${PUBLISH_WORKFLOW_PATH} release_mode must be a closed candidate/promotion choice`);
    const refInput = mappingField(inputs, "ref", `${PUBLISH_WORKFLOW_PATH}.on.workflow_dispatch.inputs`);
    expectEqual(refInput.type, "string", `${PUBLISH_WORKFLOW_PATH} ref input type`);
    expectEqual(refInput.required, true, `${PUBLISH_WORKFLOW_PATH} ref input must be required`);
    expectEqual(refInput.default, undefined, `${PUBLISH_WORKFLOW_PATH} ref input must not default to a branch or semantic tag`);
    const digestInput = mappingField(inputs, "candidate_digest", `${PUBLISH_WORKFLOW_PATH}.on.workflow_dispatch.inputs`);
    expectEqual(digestInput.type, "string", `${PUBLISH_WORKFLOW_PATH} candidate_digest input type`);
    expectEqual(digestInput.required, false, `${PUBLISH_WORKFLOW_PATH} candidate_digest input must remain optional for candidate mode`);
    expectEqual(digestInput.default, "", `${PUBLISH_WORKFLOW_PATH} candidate_digest default`);

    const authorize = workflowJob(workflow, "authorize", PUBLISH_WORKFLOW_PATH);
    const verify = workflowJob(workflow, "verify", PUBLISH_WORKFLOW_PATH);
    const publish = workflowJob(workflow, "publish", PUBLISH_WORKFLOW_PATH);
    expectEqual(authorize["runs-on"], "ubuntu-24.04", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize.runs-on`);
    expectEqual(publish["runs-on"], "ubuntu-24.04", `${PUBLISH_WORKFLOW_PATH}.jobs.publish.runs-on`);
    expectPermissions(authorize, { contents: "read" }, `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    expectPermissions(verify, { contents: "read" }, `${PUBLISH_WORKFLOW_PATH}.jobs.verify`);
    expectNeedsAuthorize(verify, `${PUBLISH_WORKFLOW_PATH}.jobs.verify`);
    expectEqual(verify.uses, "./.github/workflows/release-verify.yml", `${PUBLISH_WORKFLOW_PATH}.jobs.verify.uses`);
    expectStringSet(publish.needs, ["authorize", "verify"], `${PUBLISH_WORKFLOW_PATH}.jobs.publish.needs`);
    const authorizeOutputs = mappingField(authorize, "outputs", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    expectEqual(
      authorizeOutputs.release_environment,
      "${{ steps.classify.outputs.release_environment }}",
      `${PUBLISH_WORKFLOW_PATH}.jobs.authorize.outputs.release_environment`
    );
    expectEqual(
      authorizeOutputs.release_mode,
      "${{ steps.classify.outputs.release_mode }}",
      `${PUBLISH_WORKFLOW_PATH}.jobs.authorize.outputs.release_mode`
    );
    const publishEnvironment = mappingField(publish, "environment", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectEqual(
      publishEnvironment.name,
      "${{ needs.authorize.outputs.release_environment }}",
      `${PUBLISH_WORKFLOW_PATH}.jobs.publish.environment.name must gate semantic promotion behind Tier 3 review`
    );
    expectPermissions(publish, {
      attestations: "write",
      contents: "read",
      "id-token": "write",
      packages: "write"
    }, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepUses(
      namedStep(publish, "Generate artifact attestation", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`),
      ATTEST_ACTION,
      `${PUBLISH_WORKFLOW_PATH}.jobs.publish artifact attestation`
    );

    const classifier = namedStep(authorize, "Classify release input", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    expectEqual(classifier.id, "classify", `${PUBLISH_WORKFLOW_PATH} classifier step id`);
    const classifierScript = expectRunContains(
      classifier,
      [
        '[[ ! "$RELEASE_REF" =~ ^[0-9a-f]{40}$ ]]',
        'case "$RELEASE_MODE" in',
        "candidate)",
        "promotion)",
        '[[ ! "$EXPECTED_CANDIDATE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
        'release_environment="beta-release"',
        'release_environment="candidate-publication"'
      ],
      `${PUBLISH_WORKFLOW_PATH} release input classifier`
    );
    const classifierCases: Array<{
      mode: string;
      ref: string;
      digest: string;
      expectedMode?: string;
      expectedEnvironment?: string;
      shouldPass: boolean;
    }> = [
      { mode: "candidate", ref: "a".repeat(40), digest: "", expectedMode: "candidate", expectedEnvironment: "candidate-publication", shouldPass: true },
      { mode: "promotion", ref: "a".repeat(40), digest: `sha256:${"b".repeat(64)}`, expectedMode: "promotion", expectedEnvironment: "beta-release", shouldPass: true },
      { mode: "candidate", ref: "a".repeat(40), digest: `sha256:${"b".repeat(64)}`, shouldPass: false },
      { mode: "promotion", ref: "a".repeat(40), digest: "", shouldPass: false },
      { mode: "promotion", ref: "a".repeat(40), digest: "sha256:not-a-digest", shouldPass: false },
      { mode: "stable", ref: "a".repeat(40), digest: "", shouldPass: false },
      { mode: "promotion", ref: "v0.1.0-beta.1", digest: `sha256:${"b".repeat(64)}`, shouldPass: false },
      { mode: "candidate", ref: "A".repeat(40), digest: "", shouldPass: false },
      { mode: "candidate", ref: "not-a-release-ref", digest: "", shouldPass: false }
    ];
    for (const testCase of classifierCases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-release-classifier-"));
      try {
        const outputPath = join(directory, "github-output");
        writeFileSync(outputPath, "");
        const result = runShellStep(classifierScript, {
          ...process.env,
          RELEASE_MODE: testCase.mode,
          RELEASE_REF: testCase.ref,
          EXPECTED_CANDIDATE_DIGEST: testCase.digest,
          GITHUB_OUTPUT: outputPath
        });
        expectShellCase(result, testCase.shouldPass, `release classifier case ${JSON.stringify(testCase)}`);
        if (testCase.shouldPass) {
          const output = Object.fromEntries(
            readFileSync(outputPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => line.split("=", 2))
          );
          expectEqual(output.release_mode, testCase.expectedMode, `release classifier mode for ${testCase.ref}`);
          expectEqual(output.release_environment, testCase.expectedEnvironment, `release classifier environment for ${testCase.ref}`);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const policyCheckout = namedStep(authorize, "Check out current release revocation policy", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    expectStepUses(policyCheckout, CHECKOUT_ACTION, `${PUBLISH_WORKFLOW_PATH} release revocation policy checkout`);
    expectStepWith(policyCheckout, {
      ref: "${{ github.sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
      "sparse-checkout": RELEASE_REVOCATIONS_PATH,
      "sparse-checkout-cone-mode": false
    }, `${PUBLISH_WORKFLOW_PATH} release revocation policy checkout`);
    expectStepBefore(authorize, "Classify release input", "Check out current release revocation policy", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    expectStepBefore(authorize, "Check out current release revocation policy", "Reject revoked release candidates", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);

    const revocationStep = namedStep(authorize, "Reject revoked release candidates", `${PUBLISH_WORKFLOW_PATH}.jobs.authorize`);
    const revocationScript = expectRunContains(
      revocationStep,
      [
        'policy="${RELEASE_REVOCATIONS_PATH:-.github/release-revocations.json}"',
        "jq -e -s",
        "length == 1",
        '.[0] | keys == ["candidates", "schemaVersion"]',
        '.[0].schemaVersion == "moodarr-release-revocations-v1"',
        '.[0].candidates | type == "array" and length > 0',
        'test("^[0-9a-f]{40}$")',
        'test("^sha256:[0-9a-f]{64}$")',
        '.revision == $revision',
        '$digest != "" and .digest == $digest',
        "is revoked and cannot be published or promoted"
      ],
      `${PUBLISH_WORKFLOW_PATH} release revocation gate`
    );
    const revocationPolicy = JSON.parse(read(RELEASE_REVOCATIONS_PATH)) as {
      schemaVersion?: unknown;
      candidates?: Array<{ revision?: unknown; digest?: unknown; reason?: unknown }>;
    };
    expectEqual(revocationPolicy.schemaVersion, "moodarr-release-revocations-v1", `${RELEASE_REVOCATIONS_PATH} schema version`);
    expect(Array.isArray(revocationPolicy.candidates) && revocationPolicy.candidates.length > 0, `${RELEASE_REVOCATIONS_PATH} must retain at least one revoked candidate`);
    const abandonedRevision = "4e1be6ff5956b28f9aa440fa66b942471463fe5b";
    const abandonedDigest = "sha256:e0ba1a5a6413b588c63627fa6ca9cb9d8f48cf2aa1db13d759ac3b251d0b5c4a";
    const rejectedRevision = "b5e483ef48f82dcc4859fd692f6f4dc7102288f1";
    const rejectedDigest = "sha256:4b3b9cf14da7273b2259346d600542f9dfc75baf19f2c1a645aaf4611b305030";
    const restrictiveUmaskRevision = "8d3714d873d8e7fdd884afc00855ee03f0eb81d9";
    const restrictiveUmaskDigest = "sha256:dbdc1afa685457f3455c6d20823795297ce95e1ec950e8442bc908edb4aae4aa";
    expect(
      revocationPolicy.candidates?.some((candidate) => candidate.revision === abandonedRevision && candidate.digest === abandonedDigest) === true,
      `${RELEASE_REVOCATIONS_PATH} must permanently revoke the abandoned catalog-identity candidate`
    );
    expect(
      revocationPolicy.candidates?.some((candidate) => candidate.revision === rejectedRevision && candidate.digest === rejectedDigest) === true,
      `${RELEASE_REVOCATIONS_PATH} must permanently revoke the EXP-rejected catalog-recovery candidate`
    );
    expect(
      revocationPolicy.candidates?.some((candidate) => candidate.revision === restrictiveUmaskRevision && candidate.digest === restrictiveUmaskDigest) === true,
      `${RELEASE_REVOCATIONS_PATH} must permanently revoke the abandoned restrictive-umask validator candidate`
    );
    for (const testCase of [
      { ref: "a".repeat(40), digest: "", shouldPass: true },
      { ref: "a".repeat(40), digest: `sha256:${"b".repeat(64)}`, shouldPass: true },
      { ref: abandonedRevision, digest: "", shouldPass: false },
      { ref: "a".repeat(40), digest: abandonedDigest, shouldPass: false },
      { ref: abandonedRevision, digest: `sha256:${"b".repeat(64)}`, shouldPass: false },
      { ref: rejectedRevision, digest: "", shouldPass: false },
      { ref: "a".repeat(40), digest: rejectedDigest, shouldPass: false },
      { ref: rejectedRevision, digest: `sha256:${"b".repeat(64)}`, shouldPass: false },
      { ref: restrictiveUmaskRevision, digest: "", shouldPass: false },
      { ref: "a".repeat(40), digest: restrictiveUmaskDigest, shouldPass: false },
      { ref: restrictiveUmaskRevision, digest: `sha256:${"b".repeat(64)}`, shouldPass: false }
    ]) {
      const result = runShellStep(revocationScript, {
        ...process.env,
        RELEASE_REF: testCase.ref,
        EXPECTED_CANDIDATE_DIGEST: testCase.digest
      });
      expectShellCase(result, testCase.shouldPass, `release revocation case ${JSON.stringify(testCase)}`);
    }
    for (const testCase of [
      {
        name: "empty policy",
        contents: JSON.stringify({ schemaVersion: "moodarr-release-revocations-v1", candidates: [] }),
        shouldPass: false
      },
      {
        name: "multiple JSON documents",
        contents: `${read(RELEASE_REVOCATIONS_PATH)}\n${JSON.stringify({ schemaVersion: "moodarr-release-revocations-v1", candidates: [] })}\n`,
        shouldPass: false
      },
      { name: "zero-byte policy", contents: "", shouldPass: false },
      { name: "malformed policy", contents: "{", shouldPass: false }
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-release-revocation-policy-"));
      try {
        const policyPath = join(directory, "policy.json");
        writeFileSync(policyPath, testCase.contents);
        const result = runShellStep(revocationScript, {
          ...process.env,
          RELEASE_REF: "a".repeat(40),
          EXPECTED_CANDIDATE_DIGEST: "",
          RELEASE_REVOCATIONS_PATH: policyPath
        });
        expectShellCase(result, testCase.shouldPass, `release revocation policy case ${testCase.name}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const resolver = namedStep(publish, "Resolve image tags", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    const resolverEnvironment = mappingField(resolver, "env", `${PUBLISH_WORKFLOW_PATH} exact authorized release resolver`);
    expectEqual(
      resolverEnvironment.AUTHORIZED_RELEASE_MODE,
      "${{ needs.authorize.outputs.release_mode }}",
      `${PUBLISH_WORKFLOW_PATH} resolver must consume the authorized release classification`
    );
    const resolverScript = expectRunContains(
      resolver,
      [
        '[[ "$RELEASE_REF" != "$resolved_sha" ]]',
        '[[ "$AUTHORIZED_RELEASE_MODE" == "promotion" ]]',
        '[[ "$AUTHORIZED_RELEASE_MODE" == "candidate" ]]',
        "This workflow publishes beta prereleases only",
        'git ls-remote --exit-code --tags origin "refs/tags/$release_tag"',
        '[[ "$git_tag_probe_status" == "0" ]]',
        '[[ "$git_tag_probe_status" != "2" ]]'
      ],
      `${PUBLISH_WORKFLOW_PATH} exact authorized release resolver`
    );
    expect(!resolverScript.includes("RELEASE_REF#refs/tags/"), `${PUBLISH_WORKFLOW_PATH} must not normalize refs/tags inputs around Tier 3 classification`);
    expect(!resolverScript.includes("git show-ref"), `${PUBLISH_WORKFLOW_PATH} must not require a semantic Git tag before Tier 3-approved image promotion`);

    for (const releaseMode of ["candidate", "promotion"] as const) {
      for (const testCase of [
        { status: "2", shouldPass: true, expectedError: "" },
        { status: "0", shouldPass: false, expectedError: "must remain absent" },
        { status: "128", shouldPass: false, expectedError: "Could not prove semantic Git tag" }
      ]) {
        const directory = mkdtempSync(join(tmpdir(), "moodarr-prepublication-tag-probe-"));
        try {
          const binDirectory = join(directory, "bin");
          const outputPath = join(directory, "github-output");
          mkdirSync(binDirectory);
          writeFileSync(outputPath, "");
          writeExecutable(join(binDirectory, "git"), `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  rev-parse) printf '%s\n' "$FIXTURE_SHA" ;;
  fetch|merge-base) exit 0 ;;
  ls-remote) exit "$FIXTURE_GIT_LS_REMOTE_STATUS" ;;
  *) echo "unexpected fake git invocation: $*" >&2; exit 64 ;;
esac
`);
          const verifiedSha = "a".repeat(40);
          const result = runShellStep(resolverScript, {
            ...process.env,
            PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
            RELEASE_REF: verifiedSha,
            VERIFIED_SHA: verifiedSha,
            DISPATCH_SHA: verifiedSha,
            EXPECTED_CANDIDATE_DIGEST: releaseMode === "promotion" ? `sha256:${"b".repeat(64)}` : "",
            AUTHORIZED_RELEASE_MODE: releaseMode,
            REGISTRY: "ghcr.io",
            IMAGE_NAME: "jremick/moodarr",
            GITHUB_OUTPUT: outputPath,
            FIXTURE_SHA: verifiedSha,
            FIXTURE_GIT_LS_REMOTE_STATUS: testCase.status
          });
          expectShellCase(result, testCase.shouldPass, `${releaseMode} Git-tag probe exit ${testCase.status}`);
          if (testCase.expectedError) expect(result.output.includes(testCase.expectedError), `${releaseMode} Git-tag probe exit ${testCase.status} must fail for the expected reason`);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }

    expectVerifiedBuildxInstall(publish, "Log in to GitHub Container Registry", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    const install = namedStep(publish, "Install verified Docker Buildx client", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectEqual(install.if, "steps.image.outputs.release_mode == 'candidate'", `${PUBLISH_WORKFLOW_PATH} Buildx installer condition`);
    expectStepUses(
      namedStep(publish, "Log in to GitHub Container Registry", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`),
      LOGIN_ACTION,
      `${PUBLISH_WORKFLOW_PATH} registry login`
    );

    const builder = namedStep(publish, "Create pinned BuildKit builder", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectPinnedBuilderStep(builder, `${PUBLISH_WORKFLOW_PATH} candidate builder`, true);
    expectStepBefore(publish, "Log in to GitHub Container Registry", "Create pinned BuildKit builder", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepBefore(publish, "Create pinned BuildKit builder", "Build and push image", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);

    const metadataStepName = "Generate Docker metadata locally";
    const metadata = namedStep(publish, metadataStepName, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectEqual(metadata.if, "steps.image.outputs.release_mode == 'candidate'", `${PUBLISH_WORKFLOW_PATH} local metadata condition`);
    expectEqual(metadata.id, "meta", `${PUBLISH_WORKFLOW_PATH} local metadata id`);
    expectEqual(metadata.shell, "bash", `${PUBLISH_WORKFLOW_PATH} local metadata shell`);
    expectEqual(metadata.uses, undefined, `${PUBLISH_WORKFLOW_PATH} local metadata must not execute an action`);
    expectEqual(metadata.with, undefined, `${PUBLISH_WORKFLOW_PATH} local metadata must not have action inputs`);
    const metadataEnvironment = mappingField(metadata, "env", `${PUBLISH_WORKFLOW_PATH} local metadata`);
    expectStringSet(
      Object.keys(metadataEnvironment),
      ["CANDIDATE_TAG", "IMAGE", "PACKAGE_VERSION", "REPOSITORY", "VERIFIED_SHA"],
      `${PUBLISH_WORKFLOW_PATH} local metadata environment`
    );
    expectEqual(metadataEnvironment.IMAGE, "${{ steps.image.outputs.image }}", `${PUBLISH_WORKFLOW_PATH} local metadata image binding`);
    expectEqual(metadataEnvironment.CANDIDATE_TAG, "${{ steps.image.outputs.candidate_tag }}", `${PUBLISH_WORKFLOW_PATH} local metadata candidate-tag binding`);
    expectEqual(metadataEnvironment.PACKAGE_VERSION, "${{ steps.image.outputs.package_version }}", `${PUBLISH_WORKFLOW_PATH} local metadata version binding`);
    expectEqual(metadataEnvironment.VERIFIED_SHA, "${{ needs.verify.outputs.commit_sha }}", `${PUBLISH_WORKFLOW_PATH} local metadata revision binding`);
    expectEqual(metadataEnvironment.REPOSITORY, "${{ github.repository }}", `${PUBLISH_WORKFLOW_PATH} local metadata repository binding`);
    const metadataScript = expectRunContains(metadata, [
      '[[ "$REPOSITORY" != "jremick/moodarr" ]]',
      '[[ "$IMAGE" != "ghcr.io/$REPOSITORY" ]]',
      '[[ ! "$VERIFIED_SHA" =~ ^[0-9a-f]{40}$ ]]',
      '[[ "$CANDIDATE_TAG" != "sha-$VERIFIED_SHA" ]]',
      '[[ ! "$PACKAGE_VERSION" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-beta\\.(0|[1-9][0-9]*)$ ]]',
      'resolved_sha="$(git rev-parse HEAD)"',
      '[[ "$resolved_sha" != "$VERIFIED_SHA" ]]',
      'created="$(date -u',
      '[[ ! "$created" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]',
      'tags<<MOODARR_TAGS',
      'labels<<MOODARR_LABELS',
      'org.opencontainers.image.created=$created',
      'org.opencontainers.image.description=Moodarr Plex and Seerr companion app',
      'org.opencontainers.image.licenses=Apache-2.0',
      'org.opencontainers.image.revision=$VERIFIED_SHA',
      'org.opencontainers.image.source=https://github.com/$REPOSITORY',
      'org.opencontainers.image.title=moodarr',
      'org.opencontainers.image.url=https://github.com/$REPOSITORY',
      'org.opencontainers.image.version=$PACKAGE_VERSION'
    ], `${PUBLISH_WORKFLOW_PATH} local metadata`);
    for (const forbidden of [
      /\bcurl\b/,
      /\bwget\b/,
      /\bgh\s/,
      /\bgit\s+(?:fetch|ls-remote|pull|push)\b/,
      /\bdocker\s/,
      /\bnpm\s/,
      /\bnpx\s/
    ]) {
      expect(!forbidden.test(metadataScript), `${PUBLISH_WORKFLOW_PATH} local metadata must not contain network-capable command ${forbidden}`);
    }
    const serializedMetadata = JSON.stringify(metadata);
    for (const forbidden of ["github-token", "GH_TOKEN", "GITHUB_TOKEN", "secrets."]) {
      expect(!serializedMetadata.includes(forbidden), `${PUBLISH_WORKFLOW_PATH} local metadata must not consume ${forbidden}`);
    }
    expectStepBefore(publish, "Create pinned BuildKit builder", metadataStepName, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepBefore(publish, metadataStepName, "Recheck current release revocations before candidate push", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);

    const verifiedMetadataSha = "a".repeat(40);
    const metadataCreated = "2026-07-17T00:00:00Z";
    const expectedMetadataOutput = [
      "tags<<MOODARR_TAGS",
      `ghcr.io/jremick/moodarr:sha-${verifiedMetadataSha}`,
      "MOODARR_TAGS",
      "labels<<MOODARR_LABELS",
      `org.opencontainers.image.created=${metadataCreated}`,
      "org.opencontainers.image.description=Moodarr Plex and Seerr companion app",
      "org.opencontainers.image.licenses=Apache-2.0",
      `org.opencontainers.image.revision=${verifiedMetadataSha}`,
      "org.opencontainers.image.source=https://github.com/jremick/moodarr",
      "org.opencontainers.image.title=moodarr",
      "org.opencontainers.image.url=https://github.com/jremick/moodarr",
      "org.opencontainers.image.version=0.1.0-beta.1",
      "MOODARR_LABELS",
      ""
    ].join("\n");
    const metadataCases: Array<{
      name: string;
      image?: string;
      candidateTag?: string;
      packageVersion?: string;
      verifiedSha?: string;
      repository?: string;
      headSha?: string;
      created?: string;
      shouldPass: boolean;
      expectedError?: string;
    }> = [
      { name: "exact local metadata", shouldPass: true },
      { name: "mismatched image", image: "ghcr.io/jremick/not-moodarr", shouldPass: false, expectedError: "Image must be exactly" },
      { name: "malformed image", image: "https://ghcr.io/jremick/moodarr", shouldPass: false, expectedError: "Image must be exactly" },
      { name: "mismatched candidate tag", candidateTag: `sha-${"b".repeat(40)}`, shouldPass: false, expectedError: "Candidate tag must be exactly" },
      { name: "malformed candidate tag", candidateTag: "sha-not-a-commit", shouldPass: false, expectedError: "Candidate tag must be exactly" },
      { name: "non-beta version", packageVersion: "0.1.0", shouldPass: false, expectedError: "strict beta SemVer" },
      { name: "leading-zero beta version", packageVersion: "0.1.0-beta.01", shouldPass: false, expectedError: "strict beta SemVer" },
      { name: "malformed verified revision", verifiedSha: "A".repeat(40), shouldPass: false, expectedError: "full lowercase" },
      { name: "mismatched repository", repository: "jremick/not-moodarr", shouldPass: false, expectedError: "exactly jremick/moodarr" },
      { name: "malformed repository", repository: "Jremick/moodarr", shouldPass: false, expectedError: "strict lowercase" },
      { name: "mismatched checkout", headSha: "b".repeat(40), shouldPass: false, expectedError: "does not match verified commit" },
      { name: "malformed build time", created: "2026-07-17 00:00:00", shouldPass: false, expectedError: "UTC RFC3339" }
    ];
    for (const testCase of metadataCases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-local-metadata-"));
      try {
        const binDirectory = join(directory, "bin");
        const outputPath = join(directory, "github-output");
        mkdirSync(binDirectory);
        writeFileSync(outputPath, "");
        writeExecutable(join(binDirectory, "git"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == "2" && "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  printf '%s\\n' "$FIXTURE_HEAD_SHA"
else
  echo "unexpected fake git invocation: $*" >&2
  exit 64
fi
`);
        writeExecutable(join(binDirectory, "date"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == "2" && "$1" == "-u" && "$2" == "+%Y-%m-%dT%H:%M:%SZ" ]]; then
  printf '%s\\n' "$FIXTURE_CREATED"
else
  echo "unexpected fake date invocation: $*" >&2
  exit 64
fi
`);
        const caseVerifiedSha = testCase.verifiedSha ?? verifiedMetadataSha;
        const result = runShellStep(metadataScript, {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          IMAGE: testCase.image ?? "ghcr.io/jremick/moodarr",
          CANDIDATE_TAG: testCase.candidateTag ?? `sha-${caseVerifiedSha}`,
          PACKAGE_VERSION: testCase.packageVersion ?? "0.1.0-beta.1",
          VERIFIED_SHA: caseVerifiedSha,
          REPOSITORY: testCase.repository ?? "jremick/moodarr",
          GITHUB_OUTPUT: outputPath,
          FIXTURE_HEAD_SHA: testCase.headSha ?? caseVerifiedSha,
          FIXTURE_CREATED: testCase.created ?? metadataCreated
        });
        expectShellCase(result, testCase.shouldPass, `local metadata case ${testCase.name}`);
        if (testCase.expectedError) expect(result.output.includes(testCase.expectedError), `local metadata case ${testCase.name} must report the expected error`);
        const output = readFileSync(outputPath, "utf8");
        if (testCase.shouldPass) {
          expectEqual(output, expectedMetadataOutput, `local metadata case ${testCase.name} exact tags and ordered labels`);
        } else {
          expectEqual(output, "", `local metadata case ${testCase.name} must fail before writing outputs`);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const build = namedStep(publish, "Build and push image", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    const candidateRevocationRecheck = namedStep(
      publish,
      "Recheck current release revocations before candidate push",
      `${PUBLISH_WORKFLOW_PATH}.jobs.publish`
    );
    expectEqual(candidateRevocationRecheck.if, "steps.image.outputs.release_mode == 'candidate'", `${PUBLISH_WORKFLOW_PATH} candidate revocation recheck condition`);
    expectRunContains(candidateRevocationRecheck, [
      "jq -e -s",
      "length == 1",
      ".[0].candidates | type == \"array\" and length > 0",
      "git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/release-policy-main'",
      'git merge-base --is-ancestor "$DISPATCH_SHA" refs/remotes/origin/release-policy-main',
      "git show refs/remotes/origin/release-policy-main:.github/release-revocations.json",
      "was revoked before candidate publication and cannot be pushed"
    ], `${PUBLISH_WORKFLOW_PATH} candidate current-main revocation recheck`);
    expectStepBefore(publish, "Recheck current release revocations before candidate push", "Build and push image", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepUses(build, BUILD_PUSH_ACTION, `${PUBLISH_WORKFLOW_PATH} candidate build`);
    const buildWith = expectStepWith(build, {
      builder: "${{ steps.buildx.outputs.name }}",
      platforms: "linux/amd64",
      provenance: "mode=max",
      push: true,
      sbom: SBOM_GENERATOR,
      tags: "${{ steps.meta.outputs.tags }}",
      labels: "${{ steps.meta.outputs.labels }}"
    }, `${PUBLISH_WORKFLOW_PATH} candidate build`);
    const buildArguments = stringField(buildWith, "build-args", `${PUBLISH_WORKFLOW_PATH} candidate build.with`);
    for (const requiredArgument of [
      "MOODARR_BUILD_AI_PROVIDER_POLICY=none",
      "MOODARR_BUILD_TMDB_CONTENT_POLICY=none"
    ]) {
      expect(buildArguments.split("\n").map((value) => value.trim()).includes(requiredArgument), `${PUBLISH_WORKFLOW_PATH} candidate build must set ${requiredArgument}`);
    }

    const candidateReadbackName = "Read back published candidate manifest anonymously";
    const candidateReadback = namedStep(publish, candidateReadbackName, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectEqual(candidateReadback.if, "steps.image.outputs.release_mode == 'candidate'", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back condition`);
    expectEqual(candidateReadback.shell, "bash", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back shell`);
    const candidateReadbackEnvironment = mappingField(candidateReadback, "env", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back`);
    expectStringSet(
      Object.keys(candidateReadbackEnvironment),
      ["CANDIDATE_TAG", "EXPECTED_DIGEST", "IMAGE_PATH", "VERSION_TAG"],
      `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back environment`
    );
    expectEqual(candidateReadbackEnvironment.IMAGE_PATH, "${{ github.repository }}", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back image path`);
    expectEqual(candidateReadbackEnvironment.CANDIDATE_TAG, "${{ steps.image.outputs.candidate_tag }}", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back full-SHA tag`);
    expectEqual(candidateReadbackEnvironment.VERSION_TAG, "v${{ steps.image.outputs.package_version }}", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back semantic tag`);
    expectEqual(candidateReadbackEnvironment.EXPECTED_DIGEST, "${{ steps.push.outputs.digest }}", `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back emitted digest`);
    const candidateReadbackScript = expectRunContains(candidateReadback, [
      'image_path="${IMAGE_PATH,,}"',
      'curl_retry=(--connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-max-time 60 --retry-all-errors)',
      'parse_ghcr_token() {',
      'GHCR token response must contain exactly one JSON object',
      '[[ ! "$EXPECTED_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
      '[[ ! "$CANDIDATE_TAG" =~ ^sha-[0-9a-f]{40}$ ]]',
      '--data-urlencode "scope=repository:${image_path}:pull"',
      'anonymous_token="$(parse_ghcr_token "$token_response")"',
      'echo "::add-mask::$anonymous_token"',
      '"https://ghcr.io/v2/${image_path}/manifests/${EXPECTED_DIGEST}"',
      '"https://ghcr.io/v2/${image_path}/manifests/${CANDIDATE_TAG}"',
      'digest_media_type="$(awk',
      'digest_registry_digest="$(awk',
      'digest_computed_digest="sha256:$(sha256sum',
      'candidate_media_type="$(awk',
      'candidate_registry_digest="$(awk',
      'candidate_computed_digest="sha256:$(sha256sum',
      `expected_media_type="application/vnd.oci.image.index.v1+json"`,
      `'.mediaType == $expected'`,
      '! cmp -s "$digest_manifest" "$candidate_manifest"',
      '--header "Accept: */*"',
      '"https://ghcr.io/v2/${image_path}/manifests/${VERSION_TAG}"',
      '[[ "$version_probe_status" == "200" ]]',
      '[[ "$version_probe_status" != "404" ]]'
    ], `${PUBLISH_WORKFLOW_PATH} anonymous candidate manifest read-back`);
    for (const forbidden of ["--user", "GH_TOKEN", "GITHUB_TOKEN", "pull,push", "docker ", "gh "]) {
      expect(!candidateReadbackScript.includes(forbidden), `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back must not use ${forbidden}`);
    }
    expectEqual(
      candidateReadbackScript.split('--header "Accept: $manifest_accept"').length - 1,
      2,
      `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back must use the shared manifest Accept value for digest and full-SHA-tag reads`
    );
    expectEqual(
      candidateReadbackScript.split('--header "Authorization: Bearer $anonymous_token"').length - 1,
      3,
      `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back must authenticate all manifest requests with only the anonymous pull token`
    );
    expectEqual(
      candidateReadbackScript.split('curl "${curl_retry[@]}"').length - 1,
      4,
      `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back must bound and retry every GHCR request`
    );
    expect(!/(^|\s)-u(?:\s|$)/m.test(candidateReadbackScript), `${PUBLISH_WORKFLOW_PATH} candidate manifest read-back must not use curl short-form credentials`);
    expectStepBefore(publish, "Build and push image", "Generate artifact attestation", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepBefore(publish, "Generate artifact attestation", candidateReadbackName, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepBefore(publish, candidateReadbackName, "Summarize image refs", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);

    const locallyRunnableCandidateReadbackScript = candidateReadbackScript.replace('image_path="${IMAGE_PATH,,}"', 'image_path="$IMAGE_PATH"');
    const systemCmp = execFileSync("sh", ["-c", "command -v cmp"], { encoding: "utf8" }).trim();
    expect(systemCmp.length > 0, "candidate manifest read-back fixtures require cmp on PATH");
    const candidateReadbackCases: Array<{
      name: string;
      candidateTag?: string;
      expectedDigest?: string;
      digestManifest?: "exact" | "mismatch" | "invalid-media";
      candidateManifest?: "exact" | "mismatch" | "invalid-media";
      digestHeader?: "exact" | "mismatch";
      candidateHeader?: "exact" | "mismatch";
      digestMediaType?: "exact" | "mismatch";
      candidateMediaType?: "exact" | "mismatch";
      tokenResponse?: "exact" | "multiple" | "newline" | "trailing-newline";
      cmpStatus?: string;
      versionStatus?: string;
      expectedCalls: string[];
      shouldPass: boolean;
      expectedOutput?: string;
    }> = [
      { name: "exact anonymous tag and digest read-back", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE", "VERSION"], shouldPass: true },
      { name: "multiple token documents are refused without exposing the token", tokenResponse: "multiple", expectedCalls: ["TOKEN"], shouldPass: false, expectedOutput: "must contain exactly one JSON object" },
      { name: "newline-bearing token is refused without exposing the token", tokenResponse: "newline", expectedCalls: ["TOKEN"], shouldPass: false, expectedOutput: "token shape is invalid" },
      { name: "trailing-newline token is refused rather than normalized", tokenResponse: "trailing-newline", expectedCalls: ["TOKEN"], shouldPass: false, expectedOutput: "token shape is invalid" },
      { name: "invalid emitted digest is refused before network access", expectedDigest: "sha256:not-a-digest", expectedCalls: [], shouldPass: false, expectedOutput: "Published candidate digest must be" },
      { name: "invalid full-SHA candidate tag is refused before network access", candidateTag: "sha-not-a-full-commit", expectedCalls: [], shouldPass: false, expectedOutput: "Published candidate tag must contain" },
      { name: "digest-addressed body mismatch is refused", digestManifest: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "full-SHA-tag body mismatch is refused", candidateManifest: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "digest-addressed registry digest mismatch is refused", digestHeader: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "full-SHA-tag registry digest mismatch is refused", candidateHeader: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "digest-addressed response media type mismatch is refused", digestMediaType: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "full-SHA-tag response media type mismatch is refused", candidateMediaType: "mismatch", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "manifest JSON media type mismatch is refused", digestManifest: "invalid-media", candidateManifest: "invalid-media", expectedDigest: "invalid-media", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "raw manifest byte mismatch is refused", cmpStatus: "1", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE"], shouldPass: false, expectedOutput: "did not read back anonymously" },
      { name: "existing semantic image tag is refused", versionStatus: "200", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE", "VERSION"], shouldPass: false, expectedOutput: "exists during candidate publication" },
      { name: "uncertain semantic image tag state is refused", versionStatus: "503", expectedCalls: ["TOKEN", "DIGEST", "CANDIDATE", "VERSION"], shouldPass: false, expectedOutput: "Could not prove semantic image tag" }
    ];
    for (const testCase of candidateReadbackCases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-candidate-readback-"));
      try {
        const binDirectory = join(directory, "bin");
        const exactManifestPath = join(directory, "exact-manifest.json");
        const mismatchedManifestPath = join(directory, "mismatched-manifest.json");
        const invalidMediaManifestPath = join(directory, "invalid-media-manifest.json");
        const callsPath = join(directory, "registry-calls");
        mkdirSync(binDirectory);
        const exactManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] });
        const mismatchedManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: `sha256:${"c".repeat(64)}` }] });
        const invalidMediaManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/json", manifests: [] });
        const exactDigest = `sha256:${createHash("sha256").update(exactManifest).digest("hex")}`;
        const invalidMediaDigest = `sha256:${createHash("sha256").update(invalidMediaManifest).digest("hex")}`;
        writeFileSync(exactManifestPath, exactManifest);
        writeFileSync(mismatchedManifestPath, mismatchedManifest);
        writeFileSync(invalidMediaManifestPath, invalidMediaManifest);
        writeExecutable(join(binDirectory, "curl"), `#!/usr/bin/env bash
set -euo pipefail
original_arguments="$*"
if [[ " $original_arguments " == *" --user "* ]] || [[ " $original_arguments " == *" -u "* ]]; then
  echo "anonymous fixture received credentials" >&2
  exit 65
fi
header_file=""
output_file=""
write_out=""
url=""
fail_mode=false
request_headers=("")
for argument in "$@"; do
  if [[ "$argument" == https://* ]]; then url="$argument"; fi
done
while (( $# > 0 )); do
  case "$1" in
    --dump-header) header_file="$2"; shift 2 ;;
    --header) request_headers+=("$2"); shift 2 ;;
    --output) output_file="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    --fail|--fail-with-body) fail_mode=true; shift ;;
    *) shift ;;
  esac
done
authorization_count=0
authorization_header=""
for header in "\${request_headers[@]}"; do
  if [[ "$header" == Authorization:* ]]; then
    authorization_count=$((authorization_count + 1))
    authorization_header="$header"
  fi
done
require_anonymous_bearer() {
  if [[ "$authorization_count" != "1" ]] || [[ "$authorization_header" != "Authorization: Bearer fixture-token" ]]; then
    echo "manifest fixture did not receive exactly the anonymous bearer token" >&2
    exit 67
  fi
}
write_response() {
  local status="$1"
  local source="$2"
  local digest="$3"
  local media_type="$4"
  if [[ -n "$header_file" ]]; then
    printf 'HTTP/1.1 %s Fixture\r\nContent-Type: %s\r\nDocker-Content-Digest: %s\r\n\r\n' "$status" "$media_type" "$digest" > "$header_file"
  fi
  if [[ -n "$output_file" && "$output_file" != "/dev/null" ]]; then
    if [[ -n "$source" ]]; then cp "$source" "$output_file"; else : > "$output_file"; fi
  fi
}
if [[ "$url" == "https://ghcr.io/token" ]]; then
  if [[ "$authorization_count" != "0" ]]; then
    echo "token fixture unexpectedly received an Authorization header" >&2
    exit 68
  fi
  if [[ " $original_arguments " != *" scope=repository:$IMAGE_PATH:pull "* ]]; then
    echo "anonymous fixture received the wrong token scope" >&2
    exit 66
  fi
  printf 'TOKEN\n' >> "$FIXTURE_CALLS"
  if [[ -z "$output_file" ]]; then
    echo "token fixture requires a retry-safe output file" >&2
    exit 69
  fi
  case "$FIXTURE_TOKEN_RESPONSE" in
    exact) printf '%s\n' '{"token":"fixture-token"}' > "$output_file" ;;
    multiple) printf '%s\n' '{"message":"transient"}' '{"token":"fixture-secret-token"}' > "$output_file" ;;
    newline) printf '%s\n' '{"token":"fixture-token\\nfixture-secret-token"}' > "$output_file" ;;
    trailing-newline) printf '%s\n' '{"token":"fixture-token\\n"}' > "$output_file" ;;
    *) echo "unexpected token-response fixture" >&2; exit 70 ;;
  esac
elif [[ "$url" == *"/manifests/$EXPECTED_DIGEST" ]]; then
  require_anonymous_bearer
  printf 'DIGEST\n' >> "$FIXTURE_CALLS"
  write_response "200" "$FIXTURE_DIGEST_MANIFEST" "$FIXTURE_DIGEST_HEADER" "$FIXTURE_DIGEST_MEDIA_TYPE"
elif [[ "$url" == *"/manifests/$CANDIDATE_TAG" ]]; then
  require_anonymous_bearer
  printf 'CANDIDATE\n' >> "$FIXTURE_CALLS"
  write_response "200" "$FIXTURE_CANDIDATE_MANIFEST" "$FIXTURE_CANDIDATE_HEADER" "$FIXTURE_CANDIDATE_MEDIA_TYPE"
elif [[ "$url" == *"/manifests/$VERSION_TAG" ]]; then
  require_anonymous_bearer
  printf 'VERSION\n' >> "$FIXTURE_CALLS"
  write_response "$FIXTURE_VERSION_STATUS" "" "$EXPECTED_DIGEST" "$FIXTURE_MEDIA_TYPE"
  printf '%s' "$FIXTURE_VERSION_STATUS"
  if [[ "$fail_mode" == "true" ]] && (( FIXTURE_VERSION_STATUS >= 400 )); then exit 22; fi
else
  echo "unexpected fake curl invocation: $url" >&2
  exit 64
fi
`);
        writeExecutable(join(binDirectory, "cmp"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FIXTURE_CMP_STATUS" != "0" ]]; then exit "$FIXTURE_CMP_STATUS"; fi
exec "$FIXTURE_SYSTEM_CMP" "$@"
`);
        const mediaType = "application/vnd.oci.image.index.v1+json";
        const expectedDigest = testCase.expectedDigest === "invalid-media"
          ? invalidMediaDigest
          : testCase.expectedDigest ?? exactDigest;
        const fixtureManifest = (kind: "exact" | "mismatch" | "invalid-media" | undefined) => {
          if (kind === "mismatch") return mismatchedManifestPath;
          if (kind === "invalid-media") return invalidMediaManifestPath;
          return exactManifestPath;
        };
        const verifiedSha = "a".repeat(40);
        const result = runShellStep(locallyRunnableCandidateReadbackScript, {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          IMAGE_PATH: "jremick/moodarr",
          CANDIDATE_TAG: testCase.candidateTag ?? `sha-${verifiedSha}`,
          VERSION_TAG: "v0.1.0-beta.1",
          EXPECTED_DIGEST: expectedDigest,
          FIXTURE_CALLS: callsPath,
          FIXTURE_DIGEST_MANIFEST: fixtureManifest(testCase.digestManifest),
          FIXTURE_CANDIDATE_MANIFEST: fixtureManifest(testCase.candidateManifest),
          FIXTURE_DIGEST_HEADER: testCase.digestHeader === "mismatch" ? `sha256:${"d".repeat(64)}` : expectedDigest,
          FIXTURE_CANDIDATE_HEADER: testCase.candidateHeader === "mismatch" ? `sha256:${"e".repeat(64)}` : expectedDigest,
          FIXTURE_DIGEST_MEDIA_TYPE: testCase.digestMediaType === "mismatch" ? "application/json" : mediaType,
          FIXTURE_CANDIDATE_MEDIA_TYPE: testCase.candidateMediaType === "mismatch" ? "application/json" : mediaType,
          FIXTURE_MEDIA_TYPE: mediaType,
          FIXTURE_TOKEN_RESPONSE: testCase.tokenResponse ?? "exact",
          FIXTURE_CMP_STATUS: testCase.cmpStatus ?? "0",
          FIXTURE_SYSTEM_CMP: systemCmp,
          FIXTURE_VERSION_STATUS: testCase.versionStatus ?? "404"
        });
        expectShellCase(result, testCase.shouldPass, `candidate manifest read-back case ${testCase.name}`);
        if (testCase.expectedOutput) expect(result.output.includes(testCase.expectedOutput), `candidate manifest read-back case ${testCase.name} must report the expected outcome`);
        expect(!result.output.includes("fixture-secret-token"), `candidate manifest read-back case ${testCase.name} must not expose a rejected token`);
        if (testCase.tokenResponse && testCase.tokenResponse !== "exact") expect(!result.output.includes("::add-mask::"), `candidate manifest read-back case ${testCase.name} must reject the token before masking`);
        const calls = existsSync(callsPath)
          ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean)
          : [];
        expectEqual(JSON.stringify(calls), JSON.stringify(testCase.expectedCalls), `candidate manifest read-back case ${testCase.name} registry call order`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const promotionRevocationRecheck = namedStep(
      publish,
      "Recheck current release revocations before semantic promotion",
      `${PUBLISH_WORKFLOW_PATH}.jobs.publish`
    );
    expectEqual(promotionRevocationRecheck.if, "steps.image.outputs.release_mode == 'promotion'", `${PUBLISH_WORKFLOW_PATH} promotion revocation recheck condition`);
    expectRunContains(promotionRevocationRecheck, [
      "jq -e -s",
      "length == 1",
      ".[0].candidates | type == \"array\" and length > 0",
      "git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/release-policy-main'",
      'git merge-base --is-ancestor "$DISPATCH_SHA" refs/remotes/origin/release-policy-main',
      "git show refs/remotes/origin/release-policy-main:.github/release-revocations.json",
      "was revoked before semantic promotion and cannot be promoted"
    ], `${PUBLISH_WORKFLOW_PATH} promotion current-main revocation recheck`);
    expectStepBefore(publish, "Recheck current release revocations before semantic promotion", "Verify and promote the exact candidate manifest", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    const promotion = namedStep(publish, "Verify and promote the exact candidate manifest", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    const promotionScript = expectRunContains(promotion, [
      "umask 077",
      'curl_read=(--connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-max-time 60 --retry-all-errors)',
      'curl_write=(--connect-timeout 10 --max-time 30)',
      'parse_ghcr_token() {',
      'GHCR token response must contain exactly one JSON object',
      'token_response="$(mktemp)"',
      '--output "$token_response"',
      'registry_token="$(parse_ghcr_token "$token_response")"',
      'echo "::add-mask::$registry_token"',
      'gh attestation verify "oci://${IMAGE}@${computed_digest}"',
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/publish-image.yml"',
      '--signer-digest "$VERIFIED_SHA"',
      '--source-digest "$VERIFIED_SHA"',
      "--source-ref refs/heads/main",
      "--deny-self-hosted-runners",
      'candidate_readback_registry_digest="$(awk',
      'candidate_readback_media_type="$(awk',
      'version_readback_registry_digest="$(awk',
      'version_readback_media_type="$(awk',
      '[[ "$version_probe_status" == "404" ]]',
      '[[ "$version_probe_status" == "200" ]]',
      'existing_computed_digest="sha256:$(sha256sum "$version_probe_file"',
      '! cmp -s "$manifest_file" "$version_probe_file"',
      "resuming final verification without rewriting it",
      '! cmp -s "$manifest_file" "$candidate_readback_file"',
      '! cmp -s "$manifest_file" "$version_readback_file"',
      'git ls-remote --exit-code --tags origin "refs/tags/$VERSION_TAG"',
      '[[ "$final_git_tag_probe_status" == "0" ]]',
      '[[ "$final_git_tag_probe_status" != "2" ]]'
    ], `${PUBLISH_WORKFLOW_PATH} semantic promotion attestation binding`);
    expectEqual(
      promotionScript.split('--header "Accept: $manifest_accept"').length - 1,
      4,
      `${PUBLISH_WORKFLOW_PATH} promotion must use the shared manifest Accept value for its candidate, version probe, and final read-backs`
    );
    expectEqual(
      promotionScript.split('curl "${curl_read[@]}"').length - 1,
      5,
      `${PUBLISH_WORKFLOW_PATH} promotion must bound and retry only its token and manifest reads`
    );
    expectEqual(
      promotionScript.split('curl "${curl_write[@]}"').length - 1,
      1,
      `${PUBLISH_WORKFLOW_PATH} promotion must bound its single manifest write without an automatic retry`
    );
    expect(promotionScript.split("git ls-remote --exit-code --tags origin").length - 1 === 1, `${PUBLISH_WORKFLOW_PATH} promotion must perform one final semantic Git tag absence read-back`);
    const locallyRunnablePromotionScript = promotionScript.replace('image_path="${IMAGE_PATH,,}"', 'image_path="$IMAGE_PATH"');

    const promotionCases: Array<{
      name: string;
      tokenResponse?: "exact" | "multiple" | "newline" | "trailing-newline";
      versionStatus: string;
      gitStatus: string;
      versionKind: "exact" | "mismatch";
      versionDigest: "exact" | "mismatch";
      versionMediaType: "exact" | "mismatch";
      putStatus?: "success" | "timeout";
      expectedPuts: number;
      shouldPass: boolean;
      expectedOutput: string;
    }> = [
      { name: "404 creates the version tag", versionStatus: "404", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 1, shouldPass: true, expectedOutput: "" },
      { name: "multiple token documents are refused without exposing the write token", tokenResponse: "multiple", versionStatus: "404", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "must contain exactly one JSON object" },
      { name: "newline-bearing write token is refused without exposure", tokenResponse: "newline", versionStatus: "404", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "token shape is invalid" },
      { name: "trailing-newline write token is refused rather than normalized", tokenResponse: "trailing-newline", versionStatus: "404", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "token shape is invalid" },
      { name: "identical existing tag is adopted", versionStatus: "200", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: true, expectedOutput: "resuming final verification without rewriting it" },
      { name: "existing bytes mismatch is refused", versionStatus: "200", gitStatus: "2", versionKind: "mismatch", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "is not the exact approved candidate manifest" },
      { name: "existing registry digest mismatch is refused", versionStatus: "200", gitStatus: "2", versionKind: "exact", versionDigest: "mismatch", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "is not the exact approved candidate manifest" },
      { name: "existing media type mismatch is refused", versionStatus: "200", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "mismatch", expectedPuts: 0, shouldPass: false, expectedOutput: "is not the exact approved candidate manifest" },
      { name: "unexpected probe status is refused", versionStatus: "503", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 0, shouldPass: false, expectedOutput: "Could not establish whether release tag" },
      { name: "uncertain manifest write is attempted once and fails without a digest", versionStatus: "404", gitStatus: "2", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", putStatus: "timeout", expectedPuts: 1, shouldPass: false, expectedOutput: "fixture manifest write timed out" },
      { name: "post-promotion Git tag presence is refused", versionStatus: "404", gitStatus: "0", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 1, shouldPass: false, expectedOutput: "appeared during image promotion" },
      { name: "post-promotion Git probe uncertainty is refused", versionStatus: "404", gitStatus: "128", versionKind: "exact", versionDigest: "exact", versionMediaType: "exact", expectedPuts: 1, shouldPass: false, expectedOutput: "Could not prove semantic Git tag" }
    ];
    for (const testCase of promotionCases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-postpromotion-tag-probe-"));
      try {
        const binDirectory = join(directory, "bin");
        const manifestPath = join(directory, "manifest.json");
        const mismatchedManifestPath = join(directory, "mismatched-manifest.json");
        const callsPath = join(directory, "registry-calls");
        const outputPath = join(directory, "github-output");
        mkdirSync(binDirectory);
        const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] });
        const mismatchedManifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: `sha256:${"c".repeat(64)}` }] });
        const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
        writeFileSync(manifestPath, manifest);
        writeFileSync(mismatchedManifestPath, mismatchedManifest);
        writeFileSync(outputPath, "");
        writeExecutable(join(binDirectory, "curl"), `#!/usr/bin/env bash
	set -euo pipefail
original_arguments="$*"
header_file=""
output_file=""
write_out=""
method="GET"
url=""
for argument in "$@"; do
  if [[ "$argument" == https://* ]]; then url="$argument"; fi
done
while (( $# > 0 )); do
  case "$1" in
    --dump-header) header_file="$2"; shift 2 ;;
    --output) output_file="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    --request) method="$2"; shift 2 ;;
    *) shift ;;
  esac
done
write_response() {
  local status="$1"
  local source="$2"
  local digest="$3"
  local media_type="$4"
  if [[ -n "$header_file" ]]; then
    printf 'HTTP/1.1 %s Fixture\r\nContent-Type: %s\r\nDocker-Content-Digest: %s\r\n\r\n' "$status" "$media_type" "$digest" > "$header_file"
  fi
  if [[ -n "$output_file" && "$output_file" != "/dev/null" ]]; then
    if [[ -n "$source" ]]; then cp "$source" "$output_file"; else : > "$output_file"; fi
  fi
}
if [[ "$url" == "https://ghcr.io/token" ]]; then
  if [[ -z "$output_file" ]]; then
    echo "promotion token fixture requires a retry-safe output file" >&2
    exit 69
  fi
  if [[ " $original_arguments " != *" scope=repository:$IMAGE_PATH:pull,push "* ]]; then
    echo "promotion token fixture received the wrong scope" >&2
    exit 66
  fi
  case "$FIXTURE_TOKEN_RESPONSE" in
    exact) printf '%s\n' '{"token":"fixture-token"}' > "$output_file" ;;
    multiple) printf '%s\n' '{"message":"transient"}' '{"token":"fixture-secret-token"}' > "$output_file" ;;
    newline) printf '%s\n' '{"token":"fixture-token\\nfixture-secret-token"}' > "$output_file" ;;
    trailing-newline) printf '%s\n' '{"token":"fixture-token\\n"}' > "$output_file" ;;
    *) echo "unexpected promotion token-response fixture" >&2; exit 70 ;;
  esac
elif [[ "$method" == "PUT" ]]; then
  printf 'PUT\n' >> "$FIXTURE_CALLS"
  if [[ "$FIXTURE_PUT_STATUS" == "timeout" ]]; then
    echo "fixture manifest write timed out" >&2
    exit 28
  fi
  write_response "201" "" "$FIXTURE_DIGEST" "$FIXTURE_MEDIA_TYPE"
elif [[ "$url" == *"/manifests/$CANDIDATE_TAG" ]]; then
  write_response "200" "$FIXTURE_MANIFEST" "$FIXTURE_DIGEST" "$FIXTURE_MEDIA_TYPE"
elif [[ "$url" == *"/manifests/$VERSION_TAG" && -n "$write_out" ]]; then
  if [[ "$FIXTURE_VERSION_STATUS" == "200" ]]; then
    write_response "200" "$FIXTURE_VERSION_MANIFEST" "$FIXTURE_VERSION_DIGEST" "$FIXTURE_VERSION_MEDIA_TYPE"
  else
    write_response "$FIXTURE_VERSION_STATUS" "" "$FIXTURE_VERSION_DIGEST" "$FIXTURE_VERSION_MEDIA_TYPE"
  fi
  printf '%s' "$FIXTURE_VERSION_STATUS"
elif [[ "$url" == *"/manifests/$VERSION_TAG" ]]; then
  if [[ "$FIXTURE_VERSION_STATUS" == "404" ]]; then
    write_response "200" "$FIXTURE_MANIFEST" "$FIXTURE_DIGEST" "$FIXTURE_MEDIA_TYPE"
  else
    write_response "200" "$FIXTURE_VERSION_MANIFEST" "$FIXTURE_VERSION_DIGEST" "$FIXTURE_VERSION_MEDIA_TYPE"
  fi
else
  echo "unexpected fake curl invocation: $url" >&2
  exit 64
fi
`);
        writeExecutable(join(binDirectory, "gh"), "#!/usr/bin/env bash\nexit 0\n");
        writeExecutable(join(binDirectory, "git"), "#!/usr/bin/env bash\nexit \"$FIXTURE_GIT_LS_REMOTE_STATUS\"\n");
        const verifiedSha = "a".repeat(40);
        const mediaType = "application/vnd.oci.image.index.v1+json";
        const result = runShellStep(locallyRunnablePromotionScript, {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          GH_TOKEN: "fixture-token",
          REGISTRY_USERNAME: "fixture-user",
          IMAGE_PATH: "jremick/moodarr",
          IMAGE: "ghcr.io/jremick/moodarr",
          CANDIDATE_TAG: `sha-${verifiedSha}`,
          VERSION_TAG: "v0.1.0-beta.1",
          EXPECTED_DIGEST: manifestDigest,
          VERIFIED_SHA: verifiedSha,
          GITHUB_REPOSITORY: "jremick/moodarr",
          GITHUB_OUTPUT: outputPath,
          FIXTURE_MANIFEST: manifestPath,
          FIXTURE_DIGEST: manifestDigest,
          FIXTURE_MEDIA_TYPE: mediaType,
          FIXTURE_TOKEN_RESPONSE: testCase.tokenResponse ?? "exact",
          FIXTURE_PUT_STATUS: testCase.putStatus ?? "success",
          FIXTURE_VERSION_STATUS: testCase.versionStatus,
          FIXTURE_VERSION_MANIFEST: testCase.versionKind === "exact" ? manifestPath : mismatchedManifestPath,
          FIXTURE_VERSION_DIGEST: testCase.versionDigest === "exact" ? manifestDigest : `sha256:${"d".repeat(64)}`,
          FIXTURE_VERSION_MEDIA_TYPE: testCase.versionMediaType === "exact" ? mediaType : "application/json",
          FIXTURE_CALLS: callsPath,
          FIXTURE_GIT_LS_REMOTE_STATUS: testCase.gitStatus
        });
        expectShellCase(result, testCase.shouldPass, `semantic promotion case ${testCase.name}`);
        if (testCase.expectedOutput) expect(result.output.includes(testCase.expectedOutput), `semantic promotion case ${testCase.name} must report the expected outcome`);
        expect(!result.output.includes("fixture-secret-token"), `semantic promotion case ${testCase.name} must not expose a rejected registry write token`);
        if (testCase.tokenResponse && testCase.tokenResponse !== "exact") expect(!result.output.includes("::add-mask::"), `semantic promotion case ${testCase.name} must reject the write token before masking`);
        const putCount = existsSync(callsPath)
          ? readFileSync(callsPath, "utf8").split("\n").filter((line) => line === "PUT").length
          : 0;
        expectEqual(putCount, testCase.expectedPuts, `semantic promotion case ${testCase.name} registry PUT count`);
        if (testCase.putStatus === "timeout") expectEqual(readFileSync(outputPath, "utf8"), "", `semantic promotion case ${testCase.name} must not emit a digest after an uncertain write`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    const cleanup = namedStep(publish, "Remove candidate builder", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expect(typeof cleanup.if === "string" && cleanup.if.includes("always()"), `${PUBLISH_WORKFLOW_PATH} candidate builder cleanup must run on failure`);
    expectEqual(cleanup.run, 'docker buildx rm "$BUILDER_NAME"', `${PUBLISH_WORKFLOW_PATH} candidate builder cleanup command`);
  });
};

const auditReleaseVerifyWorkflow = () => {
  inspectWorkflow(RELEASE_VERIFY_WORKFLOW_PATH, (workflow) => {
    for (const jobId of ["verify", "container-scan"]) {
      const job = workflowJob(workflow, jobId, RELEASE_VERIFY_WORKFLOW_PATH);
      const context = `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.${jobId}`;
      expectEqual(job["runs-on"], "ubuntu-24.04", `${context}.runs-on`);
      expectPermissions(job, { contents: "read" }, context);
      const checkout = singleStepUsing(job, CHECKOUT_ACTION, context);
      expectStepWith(checkout, {
        ref: "${{ inputs.ref }}",
        "persist-credentials": false,
        "fetch-depth": 0
      }, `${context} checkout`);
      expectReleaseMainAncestryProof(job, context);
    }
    const verify = workflowJob(workflow, "verify", RELEASE_VERIFY_WORKFLOW_PATH);
    expectStepBefore(verify, "Prove release source is reachable from current main", "Record verified source", `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.verify`);
    const containerScan = workflowJob(workflow, "container-scan", RELEASE_VERIFY_WORKFLOW_PATH);
    expectStepBefore(containerScan, "Prove release source is reachable from current main", "Build exact release-candidate image", `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.container-scan`);
    const build = namedStep(containerScan, "Build exact release-candidate image", `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.container-scan`);
    expectRunContains(
      build,
      [
        '--build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none"',
        '--build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none"',
        'io.moodarr.ai-provider-policy',
        'io.moodarr.tmdb-content-policy'
      ],
      `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.container-scan release policy build`
    );
  });
};

const auditCandidateValidationWorkflow = () => {
  inspectWorkflow(VALIDATE_CANDIDATE_WORKFLOW_PATH, (workflow) => {
    expectEmptyPermissions(workflow, VALIDATE_CANDIDATE_WORKFLOW_PATH);
    expectNoSetupBuildxAction(workflow, VALIDATE_CANDIDATE_WORKFLOW_PATH);

    const anonymousPrerequisite = workflowJob(workflow, "anonymous-pull", VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const anonymousPrerequisiteContext = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.anonymous-pull`;
    expectEqual(anonymousPrerequisite["runs-on"], "ubuntu-24.04", `${anonymousPrerequisiteContext}.runs-on`);
    expectEqual(anonymousPrerequisite["timeout-minutes"], 5, `${anonymousPrerequisiteContext}.timeout-minutes`);
    expectNeedsAuthorize(anonymousPrerequisite, anonymousPrerequisiteContext);
    expectPermissions(anonymousPrerequisite, {}, anonymousPrerequisiteContext);
    const anonymousPrerequisiteSteps = workflowSteps(anonymousPrerequisite, anonymousPrerequisiteContext);
    expect(anonymousPrerequisiteSteps.every((step) => step.uses === undefined), `${anonymousPrerequisiteContext} must not execute an action`);
    const prerequisitePull = namedStep(anonymousPrerequisite, "Verify anonymous public candidate pull prerequisite", anonymousPrerequisiteContext);
    const prerequisitePullEnvironment = mappingField(prerequisitePull, "env", `${anonymousPrerequisiteContext} pull prerequisite`);
    expectStringSet(Object.keys(prerequisitePullEnvironment), ["CANDIDATE_DIGEST", "EXPECTED_REVISION"], `${anonymousPrerequisiteContext} must receive only immutable public inputs`);
    const prerequisitePullScript = expectRunContains(prerequisitePull, [
      'curl_retry=(--connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-max-time 60 --retry-all-errors)',
      'token_response="$temporary_dir/token.json"',
      'parse_ghcr_token() {',
      'GHCR token response must contain exactly one JSON object',
      '[[ ! "$CANDIDATE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
      '[[ ! "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]',
      "https://ghcr.io/token",
      "scope=repository:${image_path}:pull",
      '--output "$token_response"',
      'anonymous_token="$(parse_ghcr_token "$token_response")"',
      "manifests/${CANDIDATE_DIGEST}",
      'echo "::add-mask::$anonymous_token"',
      '[[ "$media_type" != "application/vnd.oci.image.index.v1+json" ]]',
      '[[ "$registry_digest" != "$CANDIDATE_DIGEST" ]]',
      '[[ "$computed_digest" != "$CANDIDATE_DIGEST" ]]'
    ], `${anonymousPrerequisiteContext} credential-free exact-digest public pull`);
    expect(!prerequisitePullScript.includes("--user"), `${anonymousPrerequisiteContext} must not send registry basic credentials`);
    expect(!prerequisitePullScript.includes("GH_TOKEN") && !prerequisitePullScript.includes("GITHUB_TOKEN"), `${anonymousPrerequisiteContext} must not consume a GitHub credential`);
    expectEqual(prerequisitePullScript.split('curl "${curl_retry[@]}"').length - 1, 2, `${anonymousPrerequisiteContext} must bound and retry both anonymous GHCR reads`);

    const candidateJobs = ["clean-install", "upgrade-rollback", "supply-chain"];
    for (const jobId of candidateJobs) {
      const context = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.${jobId}`;
      const job = workflowJob(workflow, jobId, VALIDATE_CANDIDATE_WORKFLOW_PATH);
      expectEqual(job["runs-on"], "ubuntu-24.04", `${context}.runs-on`);
      expectStringSet(job.needs, ["authorize", "anonymous-pull"], `${context}.needs must gate authenticated validation on the anonymous pull prerequisite`);
      expectPermissions(job, { attestations: "read", contents: "read", packages: "read" }, context);
      const checkout = singleStepUsing(job, CHECKOUT_ACTION, context);
      expectStepUses(checkout, CHECKOUT_ACTION, `${context} checkout`);
      expectStepWith(checkout, {
        ref: "${{ inputs.expected_revision }}",
        "persist-credentials": false,
        "fetch-depth": 0
      }, `${context} checkout`);
      expectStepUses(singleStepUsing(job, LOGIN_ACTION, context), LOGIN_ACTION, `${context} registry login`);
      expectCandidateMainAncestryProof(job, context);
      expectCandidateBindingStep(job, context);
    }

    for (const jobId of ["clean-install", "upgrade-rollback"]) {
      const context = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.${jobId}`;
      const job = workflowJob(workflow, jobId, VALIDATE_CANDIDATE_WORKFLOW_PATH);
      expectStepUses(singleStepUsing(job, SETUP_NODE_ACTION, context), SETUP_NODE_ACTION, `${context} Node setup`);
    }

    const supply = workflowJob(workflow, "supply-chain", VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const supplyContext = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.supply-chain`;
    const anonymousPull = namedStep(supply, "Verify anonymous public candidate pull", supplyContext);
    const anonymousPullEnvironment = mappingField(anonymousPull, "env", `${supplyContext} anonymous public pull`);
    expectStringSet(Object.keys(anonymousPullEnvironment), ["CANDIDATE_DIGEST", "CANDIDATE_IMAGE"], `${supplyContext} anonymous public pull must receive no credential environment`);
    const anonymousPullScript = expectRunContains(anonymousPull, [
      'curl_retry=(--connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-max-time 60 --retry-all-errors)',
      'token_response="$temporary_dir/token.json"',
      'parse_ghcr_token() {',
      'GHCR token response must contain exactly one JSON object',
      'https://ghcr.io/token',
      'scope=repository:${image_path}:pull',
      '--output "$token_response"',
      'anonymous_token="$(parse_ghcr_token "$token_response")"',
      'manifests/${CANDIDATE_DIGEST}',
      'echo "::add-mask::$anonymous_token"',
      '[[ "$registry_digest" != "$CANDIDATE_DIGEST" ]]',
      '[[ "$computed_digest" != "$CANDIDATE_DIGEST" ]]',
      'schemaVersion: "moodarr-anonymous-candidate-pull-v1"',
      'anonymousPullVerified: true',
      'anonymous-pull.json'
    ], `${supplyContext} credential-free exact-digest public pull`);
    expect(!anonymousPullScript.includes("--user"), `${supplyContext} anonymous public pull must not send registry basic credentials`);
    expect(!anonymousPullScript.includes("GH_TOKEN") && !anonymousPullScript.includes("GITHUB_TOKEN"), `${supplyContext} anonymous public pull must not consume a GitHub credential`);
    expectEqual(anonymousPullScript.split('curl "${curl_retry[@]}"').length - 1, 2, `${supplyContext} must bound and retry both anonymous GHCR reads`);
    expectStepBefore(supply, "Verify anonymous public candidate pull", "Install verified Docker Buildx client", supplyContext);
    expectStepBefore(supply, "Verify anonymous public candidate pull", "Authenticate for candidate inspection", supplyContext);
    expectVerifiedBuildxInstall(supply, "Authenticate for candidate inspection", supplyContext);
    const builder = namedStep(supply, "Create pinned BuildKit builder", supplyContext);
    expectPinnedBuilderStep(builder, `${supplyContext} builder`, false);
    expectStepBefore(supply, "Authenticate for candidate inspection", "Create pinned BuildKit builder", supplyContext);
    expectStepBefore(supply, "Create pinned BuildKit builder", "Verify evidence toolchain identity", supplyContext);

    const trivyInstall = namedStep(supply, "Install Trivy", supplyContext);
    expectStepUses(trivyInstall, SETUP_TRIVY_ACTION, `${supplyContext} Trivy install`);
    expectStepWith(trivyInstall, { version: "v0.70.0" }, `${supplyContext} Trivy install`);

    const toolchain = namedStep(supply, "Verify evidence toolchain identity", supplyContext);
    const toolchainScript = expectRunContains(toolchain, [
      BUILD_X_SHA256,
      'buildx_version_output="$(docker buildx version)"',
      '[[ "$buildx_version" == v0.34.1* ]]',
      'buildkit_inspect="$(docker buildx inspect --bootstrap)"',
      'trivy_version_output="$(trivy --version)"',
      'NR == 1 && $1 == "Version:"',
      'test "$buildkit_version" = "v0.30.0"',
      'test "$scanner_version" = "0.70.0"'
    ], `${supplyContext} toolchain verification`);
    expect(!toolchainScript.includes('{ print $3; exit }'), `${supplyContext} toolchain verification must consume complete Buildx inspect output without inducing SIGPIPE`);
    expect(!toolchainScript.includes('{ print $2; exit }'), `${supplyContext} toolchain verification must consume complete version output without inducing SIGPIPE`);

    const evidence = namedStep(supply, "Verify published digest, image identity, SBOM, and provenance", supplyContext);
    const evidenceRun = expectRunContains(evidence, [
      'computed_digest="sha256:$(sha256sum "$manifest"',
      `--format '{{json .Image}}'`,
      `--format '{{json .Provenance}}'`,
      `--format '{{json .SBOM}}'`,
      ".SLSA.buildDefinition.buildType",
      ".SLSA.runDetails.metadata.buildkit_metadata.vcs.source",
      ".SLSA.runDetails.metadata.buildkit_metadata.vcs.revision",
      ".SLSA.buildDefinition.resolvedDependencies",
      ".SLSA.runDetails.builder.id",
      'io.moodarr.ai-provider-policy',
      'io.moodarr.tmdb-content-policy',
      '.SPDX.spdxVersion == "SPDX-2.3"',
      ".SPDX.packages"
    ], `${supplyContext} evidence verification`);
    expect(!evidenceRun.includes(".SLSA.buildDefinition.internalParameters.github_"), `${supplyContext} must not require privacy-sensitive GitHub event fields to be present`);

    const scan = namedStep(supply, "Scan the exact published candidate digest", supplyContext);
    expectRunContains(scan, [
      "--scanners vuln",
      "--severity HIGH,CRITICAL",
      '--output "$EVIDENCE_DIR/trivy-high-critical.json"',
      "--ignore-unfixed",
      '--output "$EVIDENCE_DIR/trivy-actionable.json"',
      "--vex .vex/moodarr.openvex.json",
      'trivy --version > "$EVIDENCE_DIR/trivy-version.txt"'
    ], `${supplyContext} exact-digest scan`);

    const compactReport = namedStep(supply, "Record compact supply-chain evidence and enforce policy", supplyContext);
    const compactReportScript = expectRunContains(compactReport, [
      'anonymous_pull="$EVIDENCE_DIR/anonymous-pull.json"',
      '.schemaVersion == "moodarr-anonymous-candidate-pull-v1"',
      '.registryDigest == $candidate_digest',
      '.anonymousPullVerified == true',
      'anonymousPullVerified: true',
      "Anonymous external pull: exact candidate digest and OCI index verified without a GitHub credential"
    ], `${supplyContext} compact anonymous-pull evidence binding`);
    expect(compactReportScript.includes('trivy_version_output="$(trivy --version)"'), `${supplyContext} compact evidence must buffer complete Trivy version output`);
    expect(compactReportScript.includes('NR == 1 && $1 == "Version:"'), `${supplyContext} compact evidence must parse only Trivy's top-level version line`);
    expect(!compactReportScript.includes('{ print $2; exit }'), `${supplyContext} compact evidence must not induce SIGPIPE while reading Trivy version output`);

    const upload = namedStep(supply, "Upload supply-chain evidence", supplyContext);
    expectStepUses(upload, UPLOAD_ARTIFACT_ACTION, `${supplyContext} artifact upload`);
    expectEqual(upload.if, "always()", `${supplyContext} artifact upload condition`);
    const uploadWith = expectStepWith(upload, {
      "if-no-files-found": "error",
      name: "beta-supply-chain-${{ inputs.expected_revision }}",
      "retention-days": 30
    }, `${supplyContext} artifact upload`);
    const uploadPaths = stringField(uploadWith, "path", `${supplyContext} artifact upload.with`)
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    const expectedUploadPaths = [
      "${{ runner.temp }}/moodarr-beta-supply-chain/manifest.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/image-config.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/anonymous-pull.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/sbom.spdx.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/trivy-high-critical.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/trivy-actionable.json",
      "${{ runner.temp }}/moodarr-beta-supply-chain/trivy-version.txt",
      "${{ runner.temp }}/moodarr-beta-supply-chain/supply-chain-report.json"
    ];
    expectStringSet(uploadPaths, expectedUploadPaths, `${supplyContext} artifact upload must use the exact public evidence allowlist`);
    expect(!uploadPaths.some((path) => path.endsWith("/provenance.json") || path.endsWith("/moodarr-beta-supply-chain") || /[*?[]/.test(path)), `${supplyContext} artifact upload must exclude raw provenance, directories, and globs`);

    const cleanup = namedStep(supply, "Remove supply-chain builder", supplyContext);
    expect(typeof cleanup.if === "string" && cleanup.if.includes("always()"), `${supplyContext} builder cleanup must run on failure`);
    expectEqual(cleanup.run, 'docker buildx rm "$BUILDER_NAME"', `${supplyContext} builder cleanup command`);
  });
};

type ShellStepResult = {
  status: number | null;
  output: string;
};

const runShellStep = (script: string, environment: NodeJS.ProcessEnv): ShellStepResult => {
  const result = spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout: 15_000
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-2_000)
  };
};

const expectShellCase = (result: ShellStepResult, shouldPass: boolean, context: string) => {
  const passed = result.status === 0;
  if (passed !== shouldPass) {
    failures.push(`${context} ${shouldPass ? "failed" : "unexpectedly passed"}${result.output ? `: ${result.output}` : ""}`);
  }
};

const writeExecutable = (path: string, contents: string) => {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};

const imageManifestDigestFixture = `sha256:${"1".repeat(64)}`;
const attestationManifestDigestFixture = `sha256:${"2".repeat(64)}`;
const validManifestFixture = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: imageManifestDigestFixture,
      size: 1,
      platform: { os: "linux", architecture: "amd64" }
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: attestationManifestDigestFixture,
      size: 1,
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": imageManifestDigestFixture
      },
      platform: { os: "unknown", architecture: "unknown" }
    }
  ]
};

const expectedRevisionFixture = "a".repeat(40);
const validImageConfigFixture = {
  os: "linux",
  architecture: "amd64",
  config: {
    Labels: {
      "org.opencontainers.image.version": "0.1.0-beta.1",
      "org.opencontainers.image.revision": expectedRevisionFixture,
      "org.opencontainers.image.source": "https://github.com/jremick/moodarr",
      "org.opencontainers.image.licenses": "Apache-2.0",
      "io.moodarr.ai-provider-policy": "none",
      "io.moodarr.tmdb-content-policy": "none"
    }
  }
};

const validProvenanceFixture = (internalParameters?: Mapping) => ({
  SLSA: {
    buildDefinition: {
      buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
      resolvedDependencies: [{ uri: "pkg:docker/node@24", digest: { sha256: "3".repeat(64) } }],
      ...(internalParameters === undefined ? {} : { internalParameters })
    },
    runDetails: {
      builder: { id: "https://github.com/jremick/moodarr/actions/runs/1/attempts/1" },
      metadata: {
        buildkit_metadata: {
          vcs: {
            source: "https://github.com/jremick/moodarr",
            revision: expectedRevisionFixture
          }
        }
      }
    }
  }
});

const validSbomFixture = {
  SPDX: {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    packages: [{ SPDXID: "SPDXRef-Package-node", name: "node" }]
  }
};

const validTrivyFixture = {
  SchemaVersion: 2,
  ArtifactName: "ghcr.io/jremick/moodarr@sha256:fixture",
  ArtifactType: "container_image",
  Metadata: { OS: { Family: "debian", Name: "13" } },
  Results: [{ Target: "debian", Class: "os-pkgs", Type: "debian" }]
};

const runEvidenceVerificationFixtures = () => {
  try {
    const workflow = loadWorkflow(VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const job = workflowJob(workflow, "supply-chain", VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const step = namedStep(job, "Verify published digest, image identity, SBOM, and provenance", `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.supply-chain`);
    const script = stringField(step, "run", "candidate evidence verification step");
    const mismatchedAttachmentFixture = {
      ...validManifestFixture,
      manifests: [
        validManifestFixture.manifests[0],
        {
          ...validManifestFixture.manifests[1],
          annotations: {
            ...validManifestFixture.manifests[1]?.annotations,
            "vnd.docker.reference.digest": `sha256:${"4".repeat(64)}`
          }
        }
      ]
    };
    const invalidBuilderFixture = validProvenanceFixture();
    invalidBuilderFixture.SLSA.runDetails.builder.id = "https://example.invalid/build/1";
    const missingMaterialDigestFixture = validProvenanceFixture();
    Reflect.deleteProperty(missingMaterialDigestFixture.SLSA.buildDefinition.resolvedDependencies[0]!, "digest");
    const invalidMaterialDigestFixture = validProvenanceFixture();
    invalidMaterialDigestFixture.SLSA.buildDefinition.resolvedDependencies = [{ uri: "pkg:docker/node@24", digest: { sha256: "not-a-digest" } }];
    const imageWithoutTmdbPolicy = structuredClone(validImageConfigFixture);
    Reflect.deleteProperty(imageWithoutTmdbPolicy.config.Labels, "io.moodarr.tmdb-content-policy");
    const cases: Array<{ name: string; manifest?: string; imageConfig?: string; provenance?: string; sbom?: string; shouldPass: boolean }> = [
      { name: "valid public evidence", provenance: JSON.stringify(validProvenanceFixture()), sbom: JSON.stringify(validSbomFixture), shouldPass: true },
      { name: "missing TMDB content policy label", imageConfig: JSON.stringify(imageWithoutTmdbPolicy), provenance: JSON.stringify(validProvenanceFixture()), sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "attestation references a different image manifest", manifest: JSON.stringify(mismatchedAttachmentFixture), provenance: JSON.stringify(validProvenanceFixture()), sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "malformed provenance JSON", provenance: "{", sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "missing provenance JSON", sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "invalid provenance builder identity", provenance: JSON.stringify(invalidBuilderFixture), sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "missing material digest", provenance: JSON.stringify(missingMaterialDigestFixture), sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      { name: "invalid material digest", provenance: JSON.stringify(invalidMaterialDigestFixture), sbom: JSON.stringify(validSbomFixture), shouldPass: false },
      {
        name: "privacy-sensitive GitHub provenance payload",
        provenance: JSON.stringify(validProvenanceFixture({ github_actor: "fixture-user", github_event_payload: "{fixture}" })),
        sbom: JSON.stringify(validSbomFixture),
        shouldPass: false
      },
      { name: "malformed SBOM JSON", provenance: JSON.stringify(validProvenanceFixture()), sbom: "{", shouldPass: false },
      { name: "missing SBOM JSON", provenance: JSON.stringify(validProvenanceFixture()), shouldPass: false }
    ];

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-attestation-fixture-"));
      try {
        const binDirectory = join(directory, "bin");
        mkdirSync(binDirectory);
        const manifestPath = join(directory, "manifest.json");
        const imageConfigPath = join(directory, "image-config.json");
        const provenancePath = join(directory, "provenance.json");
        const sbomPath = join(directory, "sbom.json");
        const manifest = testCase.manifest ?? JSON.stringify(validManifestFixture);
        const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
        writeFileSync(manifestPath, manifest);
        writeFileSync(imageConfigPath, testCase.imageConfig ?? JSON.stringify(validImageConfigFixture));
        if (testCase.provenance !== undefined) writeFileSync(provenancePath, testCase.provenance);
        if (testCase.sbom !== undefined) writeFileSync(sbomPath, testCase.sbom);
        writeExecutable(join(binDirectory, "docker"), `#!/usr/bin/env bash
set -euo pipefail
emit_fixture() {
  if [[ -f "$1" ]]; then cat "$1"; fi
}
case "$*" in
  *" --raw") emit_fixture "$FIXTURE_MANIFEST" ;;
  *"{{json .Image}}"*) emit_fixture "$FIXTURE_IMAGE_CONFIG" ;;
  *"{{json .Provenance}}"*) emit_fixture "$FIXTURE_PROVENANCE" ;;
  *"{{json .SBOM}}"*) emit_fixture "$FIXTURE_SBOM" ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 64 ;;
esac
`);
        const result = runShellStep(script, {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: directory,
          CANDIDATE_IMAGE: "ghcr.io/jremick/moodarr@sha256:fixture",
          CANDIDATE_DIGEST: manifestDigest,
          EXPECTED_REVISION: expectedRevisionFixture,
          EXPECTED_VERSION: "0.1.0-beta.1",
          FIXTURE_MANIFEST: manifestPath,
          FIXTURE_IMAGE_CONFIG: imageConfigPath,
          FIXTURE_PROVENANCE: provenancePath,
          FIXTURE_SBOM: sbomPath
        });
        expectShellCase(result, testCase.shouldPass, `candidate evidence case ${JSON.stringify(testCase.name)}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } catch (error) {
    failures.push(`candidate evidence fixtures could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const runTrivyPolicyFixtures = () => {
  try {
    const workflow = loadWorkflow(VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const job = workflowJob(workflow, "supply-chain", VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const step = namedStep(job, "Record compact supply-chain evidence and enforce policy", `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.supply-chain`);
    const script = stringField(step, "run", "candidate Trivy policy step");
    const manifest = JSON.stringify(validManifestFixture);
    const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const candidateImage = "ghcr.io/jremick/moodarr@sha256:fixture";
    const validAnonymousPullFixture = {
      schemaVersion: "moodarr-anonymous-candidate-pull-v1",
      candidateImage,
      candidateDigest: manifestDigest,
      registryDigest: manifestDigest,
      manifestMediaType: "application/vnd.oci.image.index.v1+json",
      anonymousPullVerified: true
    };
    const actionableFixture = {
      ...validTrivyFixture,
      Results: [{
        ...validTrivyFixture.Results[0],
        Vulnerabilities: [{ VulnerabilityID: "CVE-FIXTURE", PkgName: "fixture", Severity: "HIGH", FixedVersion: "2.0.0" }]
      }]
    };
    const nullVulnerabilitiesFixture = {
      ...validTrivyFixture,
      Results: [{ ...validTrivyFixture.Results[0], Vulnerabilities: null }]
    };
    const invalidVulnerabilitiesFixture = {
      ...validTrivyFixture,
      Results: [{ ...validTrivyFixture.Results[0], Vulnerabilities: "not-an-array" }]
    };
    const cases: Array<{ name: string; highCritical?: string; actionable?: string; anonymousPull?: string | null; shouldPass: boolean }> = [
      { name: "valid omitted vulnerability results", highCritical: JSON.stringify(validTrivyFixture), actionable: JSON.stringify(validTrivyFixture), shouldPass: true },
      { name: "valid null vulnerability results", highCritical: JSON.stringify(nullVulnerabilitiesFixture), actionable: JSON.stringify(nullVulnerabilitiesFixture), shouldPass: true },
      { name: "missing anonymous public-pull evidence", highCritical: JSON.stringify(validTrivyFixture), actionable: JSON.stringify(validTrivyFixture), anonymousPull: null, shouldPass: false },
      { name: "malformed anonymous public-pull evidence", highCritical: JSON.stringify(validTrivyFixture), actionable: JSON.stringify(validTrivyFixture), anonymousPull: "{", shouldPass: false },
      {
        name: "mismatched anonymous public-pull digest",
        highCritical: JSON.stringify(validTrivyFixture),
        actionable: JSON.stringify(validTrivyFixture),
        anonymousPull: JSON.stringify({ ...validAnonymousPullFixture, registryDigest: `sha256:${"9".repeat(64)}` }),
        shouldPass: false
      },
      { name: "actionable high vulnerability", highCritical: JSON.stringify(actionableFixture), actionable: JSON.stringify(actionableFixture), shouldPass: false },
      { name: "invalid vulnerability field", highCritical: JSON.stringify(invalidVulnerabilitiesFixture), actionable: JSON.stringify(validTrivyFixture), shouldPass: false },
      { name: "malformed high-critical JSON", highCritical: "{", actionable: JSON.stringify(validTrivyFixture), shouldPass: false },
      { name: "missing high-critical JSON", actionable: JSON.stringify(validTrivyFixture), shouldPass: false },
      { name: "structurally empty high-critical JSON", highCritical: "{}", actionable: JSON.stringify(validTrivyFixture), shouldPass: false },
      { name: "malformed actionable JSON", highCritical: JSON.stringify(validTrivyFixture), actionable: "{", shouldPass: false },
      { name: "missing actionable JSON", highCritical: JSON.stringify(validTrivyFixture), shouldPass: false },
      { name: "structurally empty actionable JSON", highCritical: JSON.stringify(validTrivyFixture), actionable: "{}", shouldPass: false }
    ];

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), "moodarr-trivy-fixture-"));
      try {
        const binDirectory = join(directory, "bin");
        const dockerConfig = join(directory, "docker-config");
        const evidenceDirectory = join(directory, "moodarr-beta-supply-chain");
        mkdirSync(binDirectory);
        mkdirSync(join(dockerConfig, "cli-plugins"), { recursive: true });
        mkdirSync(evidenceDirectory);
        writeExecutable(join(binDirectory, "trivy"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--version" ]]; then
  echo "Version: 0.70.0"
  exit 0
fi
echo "unexpected fake trivy invocation: $*" >&2
exit 64
`);
        writeExecutable(join(dockerConfig, "cli-plugins", "docker-buildx"), "fixture Buildx bytes\n");
        writeFileSync(join(evidenceDirectory, "manifest.json"), manifest);
        writeFileSync(join(evidenceDirectory, "image-config.json"), JSON.stringify(validImageConfigFixture));
        writeFileSync(join(evidenceDirectory, "provenance.json"), JSON.stringify(validProvenanceFixture()));
        writeFileSync(join(evidenceDirectory, "sbom.spdx.json"), JSON.stringify(validSbomFixture));
        writeFileSync(join(evidenceDirectory, "trivy-version.txt"), "Version: 0.70.0\n");
        const anonymousPull = testCase.anonymousPull === undefined ? JSON.stringify(validAnonymousPullFixture) : testCase.anonymousPull;
        if (anonymousPull !== null) writeFileSync(join(evidenceDirectory, "anonymous-pull.json"), anonymousPull);
        if (testCase.highCritical !== undefined) writeFileSync(join(evidenceDirectory, "trivy-high-critical.json"), testCase.highCritical);
        if (testCase.actionable !== undefined) writeFileSync(join(evidenceDirectory, "trivy-actionable.json"), testCase.actionable);
        const summaryPath = join(directory, "summary.md");
        const result = runShellStep(script, {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          DOCKER_CONFIG: dockerConfig,
          RUNNER_TEMP: directory,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "jremick/moodarr",
          GITHUB_RUN_ID: "1",
          GITHUB_STEP_SUMMARY: summaryPath,
          CANDIDATE_IMAGE: candidateImage,
          CANDIDATE_DIGEST: manifestDigest,
          EXPECTED_REVISION: expectedRevisionFixture,
          EXPECTED_VERSION: "0.1.0-beta.1"
        });
        expectShellCase(result, testCase.shouldPass, `Trivy policy case ${JSON.stringify(testCase.name)}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } catch (error) {
    failures.push(`Trivy policy fixtures could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
};

auditPinnedBuildxInstaller();
auditCiWorkflow();
auditPublishWorkflow();
auditReleaseVerifyWorkflow();
auditCandidateValidationWorkflow();
auditActionPins();
runEvidenceVerificationFixtures();
runTrivyPolicyFixtures();

if (process.env.MOODARR_PACKAGING_SUPPLY_CHAIN_ONLY === "1") {
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("Supply-chain packaging checks passed.");
  process.exit(0);
}

includes("Dockerfile", "CMD [\"dist/server/index.js\"]");
includes("Dockerfile", "USER 999:999");
includes("Dockerfile", "MOODARR_VERSION=${MOODARR_VERSION}");
includes("Dockerfile", "MOODARR_BUILD_REVISION=${MOODARR_BUILD_REVISION}");
includes("Dockerfile", 'org.opencontainers.image.version="${MOODARR_VERSION}"');
includes("Dockerfile", 'org.opencontainers.image.revision="${MOODARR_BUILD_REVISION}"');
includes("Dockerfile", 'io.moodarr.ai-provider-policy="${MOODARR_BUILD_AI_PROVIDER_POLICY}"');
includes("Dockerfile", 'io.moodarr.tmdb-content-policy="${MOODARR_BUILD_TMDB_CONTENT_POLICY}"');
includes("Dockerfile", "ARG MOODARR_BUILD_TMDB_CONTENT_POLICY=none");
includes("Dockerfile", "node:24-bookworm-slim@sha256:");
includes("Dockerfile", "gcr.io/distroless/nodejs24-debian13:nonroot@sha256:");
includes("Dockerfile", 'CMD ["/nodejs/bin/node"');
includes("Dockerfile", "/app/LICENSE /app/THIRD_PARTY_NOTICES.md");
includes("Dockerfile", "COPY --from=build --chown=999:999 /app/dist ./dist");
includes("vite.server.config.ts", 'importWikidataCatalog: "scripts/import-wikidata-catalog.ts"');
includes("scripts/smoke-container.ts", "MOODARR_BUILD_REVISION=${smokeRevision}");
includes("scripts/smoke-container.ts", "MOODARR_BUILD_TMDB_CONTENT_POLICY=none");
includes("scripts/smoke-container.ts", "MOODARR_TMDB_CONTENT_POLICY: configurable");
includes("scripts/smoke-container.ts", '"--platform",\n      "linux/amd64"');
includes("scripts/smoke-container.ts", "healthBody.version !== packageVersion");
includes("scripts/smoke-container.ts", 'imageLabels["org.opencontainers.image.version"] !== packageVersion');
includes("scripts/smoke-container.ts", 'imageLabels["org.opencontainers.image.revision"] !== smokeRevision');
includes("scripts/smoke-container.ts", 'imageLabels["io.moodarr.tmdb-content-policy"] !== "none"');
includes("scripts/smoke-container.ts", 'healthBody.policies?.aiProvider !== "none" || healthBody.policies.tmdbContent !== "none"');
includes("scripts/smoke-container.ts", 'runtimeIdentity.arch !== "x64" || runtimeIdentity.uid !== 999 || runtimeIdentity.gid !== 999');
includes("scripts/smoke-container.ts", '"/app/LICENSE", "/app/THIRD_PARTY_NOTICES.md"');
includes("scripts/smoke-container.ts", 'from "./release-bundle-policy"');
includes("scripts/smoke-container.ts", "releaseBundleScanScript()");
includes("scripts/validate-beta-install.ts", 'moodarr-beta-clean-install-v1');
includes("scripts/validate-beta-install.ts", 'scripts/fixtures/beta-install-integrations.mjs');
includes("scripts/validate-beta-install.ts", 'docker-compose.example.yml');
includes("scripts/validate-beta-install.ts", 'candidate_ai_bundle_mismatch');
includes("scripts/validate-beta-install.ts", 'candidate_tmdb_policy_mismatch');
includes("scripts/validate-beta-install.ts", 'MOODARR_TMDB_CONTENT_POLICY", "configurable"');
includes("scripts/validate-beta-install.ts", 'MOODARR_BETA_INSTALL_OWNER", owner');
includes("scripts/validate-beta-install.ts", "io.moodarr.beta-install.owner: ${MOODARR_BETA_INSTALL_OWNER}");
includes("scripts/validate-beta-install.ts", "networkLabels?.[ownerLabel]");
includes("scripts/validate-beta-install.ts", '"tmdb_content_policy_ok"');
includes("scripts/validate-beta-install.ts", 'from "./release-bundle-policy"');
includes("scripts/validate-beta-install.ts", "releaseBundleScanScript()");
includes("scripts/validate-beta-install.ts", "writeSyntheticCatalogFixture(catalogFixture)");
includes("scripts/validate-beta-install.ts", 'writeFileSync(path, syntheticCatalogFixtureBody, { mode: 0o600, flag: "wx" })');
includes("scripts/validate-beta-install.ts", "chmodSync(path, 0o644)");
includes("scripts/validate-beta-install.ts", "catalog_fixture_mode_mismatch");
includes("scripts/validate-beta-install.ts", "writeInstallIntegrationFixture(fixture, readFileSync(sourceFixture, \"utf8\"))");
includes("scripts/validate-beta-install.ts", 'writeFileSync(path, source, { mode: 0o600, flag: "wx" })');
includes("scripts/validate-beta-install.ts", "integration_fixture_mode_mismatch");
includes("scripts/validate-beta-upgrade.ts", "writeUpgradeIntegrationFixture(fixture, fixtureSource)");
includes("scripts/validate-beta-upgrade.ts", 'writeFileSync(path, buildUpgradeIntegrationFixture(source), { mode: 0o600, flag: "wx" })');
includes("scripts/validate-beta-upgrade.ts", "chmodSync(path, 0o644)");
includes("scripts/validate-beta-upgrade.ts", "integration_fixture_mode_mismatch");
includes("scripts/release-bundle-policy.ts", 'withFileTypes:true');
includes("scripts/release-bundle-policy.ts", 'walk(${JSON.stringify(root)})');
for (const marker of [
  "api.openai.com",
  "image.tmdb.org",
  "/api/v1/search?query=",
  "searchSeerrContent",
  "seerrDescriptiveContent",
  "tmdbGenreById",
  "OpenAiBriefParser",
  "OpenAiEmbeddingProvider",
  "OpenAiQueryOptimizer",
  "OpenAiRanker",
  "OpenAiTasteScout"
]) includes("scripts/release-bundle-policy.ts", `"${marker}"`);
includes("scripts/fixtures/beta-install-integrations.mjs", "MOODARR_BETA_STUB_COUNTS");
includes("docker-compose.example.yml", "MOODARR_IMAGE:-ghcr.io/jremick/moodarr:v0.1.0-beta.1");
includes("docker-compose.example.yml", "moodarr-data:/data");
includes("docker-compose.example.yml", "MOODARR_DATA_VOLUME:-moodarr-data");
includes("docker-compose.example.yml", 'MOODARR_ADMIN_AUTO_SESSION: "false"');
includes("docker-compose.example.yml", "read_only: true");
includes("docker-compose.example.yml", "no-new-privileges:true");
includes("docker-compose.example.yml", "cap_drop:");
includes("docker-compose.example.yml", "pids_limit: 128");
includes("docker-compose.example.yml", "size=512m");
includes("unraid/moodarr.xml", "<Name>Moodarr</Name>");
includes("unraid/moodarr.xml", "<WebUI>http://[IP]:[PORT:4401]/</WebUI>");
if (read("unraid/moodarr.xml").includes("<Shell>")) failures.push("unraid/moodarr.xml must not advertise an interactive shell in the distroless runtime");
includes("unraid/moodarr.xml", 'Target="MOODARR_ADMIN_AUTO_SESSION" Default="false"');
includes("unraid/moodarr.xml", 'Target="MOODARR_WEB_ORIGIN" Default=""');
includes("unraid/moodarr.xml", "For direct Unraid access, enter the IP origin opened by the Docker WebUI shortcut");
includes("unraid/moodarr.xml", "If using a hostname or HTTPS reverse proxy, enter that origin and do not use the IP shortcut");
includes("unraid/moodarr.xml", "Before first Apply, pre-create the selected Appdata host path as UID/GID 999:999 with mode 0700");
includes("unraid/moodarr.xml", "Before first Apply, pre-create this exact host path as UID/GID 999:999 with mode 0700 per docs/UNRAID.md");
includes(".github/workflows/release-verify.yml", "npm run verify:release");
includes(".github/workflows/release-verify.yml", "Scan release-candidate runtime image");
includes(".github/workflows/release-verify.yml", "--ignore-unfixed");
includes(".github/workflows/publish-image.yml", "package.json version is not a strict SemVer version");
includes(".github/workflows/publish-image.yml", "This workflow publishes beta prereleases only");
includes(".github/workflows/publish-image.yml", "type: choice");
includes(".github/workflows/publish-image.yml", "release_mode must be candidate or promotion");
includes(".github/workflows/publish-image.yml", "org.opencontainers.image.version=$PACKAGE_VERSION");
includes(".github/workflows/publish-image.yml", "org.opencontainers.image.revision=$VERIFIED_SHA");
includes(".github/workflows/publish-image.yml", 'git merge-base --is-ancestor "$resolved_sha" origin/main');
includes(".github/workflows/publish-image.yml", 'git ls-remote --exit-code --tags origin "refs/tags/$release_tag"');
includes(".github/workflows/publish-image.yml", '[[ "$git_tag_probe_status" != "2" ]]');
includes(".github/workflows/publish-image.yml", '[[ "$final_git_tag_probe_status" != "2" ]]');
includes(".github/workflows/publish-image.yml", 'grep -Fq "Until the first beta is published" docs/COMPATIBILITY.md');
includes(".github/workflows/publish-image.yml", 'grep -Fq "No public beta has been published yet" SECURITY.md');
includes(".github/workflows/publish-image.yml", 'grep -Fq "No public beta has been published yet" SUPPORT.md');
includes(".github/workflows/publish-image.yml", "Require the default-branch workflow definition");
includes(".github/workflows/publish-image.yml", "Check out current release revocation policy");
includes(".github/workflows/publish-image.yml", "Reject revoked release candidates");
includes(".github/release-revocations.json", "4e1be6ff5956b28f9aa440fa66b942471463fe5b");
includes(".github/release-revocations.json", "sha256:e0ba1a5a6413b588c63627fa6ca9cb9d8f48cf2aa1db13d759ac3b251d0b5c4a");
includes(".github/release-revocations.json", "b5e483ef48f82dcc4859fd692f6f4dc7102288f1");
includes(".github/release-revocations.json", "sha256:4b3b9cf14da7273b2259346d600542f9dfc75baf19f2c1a645aaf4611b305030");
includes(".github/release-revocations.json", "8d3714d873d8e7fdd884afc00855ee03f0eb81d9");
includes(".github/release-revocations.json", "sha256:dbdc1afa685457f3455c6d20823795297ce95e1ec950e8442bc908edb4aae4aa");
includes(".github/workflows/publish-image.yml", "Refuse existing candidate tags and require promotion source");
includes(".github/workflows/publish-image.yml", 'candidate_tag="sha-$resolved_sha"');
includes(".github/workflows/publish-image.yml", "DISPATCH_SHA: ${{ github.sha }}");
includes(".github/workflows/publish-image.yml", '"$resolved_sha" != "$DISPATCH_SHA"');
includes(".github/workflows/publish-image.yml", "Semantic promotion requires the exact validated candidate_digest");
includes(".github/workflows/publish-image.yml", "fix it before publishing a versioned SHA candidate");
includes(".github/workflows/publish-image.yml", "Required candidate tag $CANDIDATE_TAG does not exist");
includes(".github/workflows/publish-image.yml", "if: steps.image.outputs.release_mode == 'candidate'");
includes(".github/workflows/publish-image.yml", "if: steps.image.outputs.release_mode == 'promotion'");
includes(".github/workflows/publish-image.yml", 'if [[ "$version_probe_status" == "404" ]]');
includes(".github/workflows/publish-image.yml", 'elif [[ "$version_probe_status" == "200" ]]');
includes(".github/workflows/publish-image.yml", "Existing release tag $VERSION_TAG is not the exact approved candidate manifest and will not be overwritten");
includes(".github/workflows/publish-image.yml", '--data-binary "@$manifest_file"');
includes(".github/workflows/publish-image.yml", "Candidate and promoted release tags did not read back as the exact same validated manifest");
includes(".github/workflows/publish-image.yml", 'contains("\\r") or contains("\\n")');
includes(".github/workflows/publish-image.yml", 'candidate_readback_registry_digest="$(awk');
includes(".github/workflows/publish-image.yml", 'version_readback_registry_digest="$(awk');
includes(".github/workflows/publish-image.yml", "group: publish-image");
includes("docs/RELEASE.md", "review and freeze the new HEAD and publish a new candidate from it; do not move `main` backward solely for publication");
includes("docs/RELEASE.md", 'candidate_commit="<full-40-character-sha>"');
includes("docs/RELEASE.md", '--signer-digest "$candidate_commit"');
includes("docs/RELEASE.md", '--source-digest "$candidate_commit"');
includes("docs/RELEASE.md", "--source-ref refs/heads/main");
includes("docs/RELEASE.md", "Repository package-write permission must remain restricted");
includes("docs/RELEASE.md", "Verify GHCR package access grants write permission only to the Moodarr repository workflow and the minimum required maintainer accounts");
includes("docs/RELEASE.md", "Create the protected Git tag manually only after the approved image-promotion job succeeds");
includes("docs/RELEASE.md", "requests a GHCR pull token without a GitHub credential");
includes("docs/RELEASE.md", "pre-push semantic Git-tag absence check, anonymous full-SHA-tag/digest raw-manifest self-readback, and semantic GHCR version-tag `404`");
includes("docs/RELEASE.md", "Do not rerun candidate publication for an existing full-SHA tag");
includes("docs/RELEASE.md", "The manifest PUT is bounded but deliberately not retried automatically");
includes("docs/RELEASE.md", "Every token response is captured in a mode-`0600` temporary file");
includes("docs/RELEASE.md", "Candidate workflow artifacts are a 30-day transport window, not the sole durable ledger");
includes("docs/RELEASE.md", "A dispatch that fails before the full-SHA tag appears may be repeated only after independently proving that tag is still absent");
includes("docs/RELEASE.md", "a pre-execution SHA/digest was mistyped, or an auxiliary catalog copy was staged incorrectly");
includes("docs/RELEASE.md", "An unexpected, duplicated, or still-unresolved Moodarr-triggered external write after the required reconciliation and cleanup checks");
includes("docs/RELEASE.md", "until `v0.1.0-beta.1` leaves the supported release window");
includes("docs/BETA_RELEASE_CRITERIA.md", "GHCR package-writer access review");
includes("docs/BETA_RELEASE_CRITERIA.md", "Semantic Git tag is absent before Tier 3-approved promotion");
includes("docs/BETA_RELEASE_CRITERIA.md", "Candidate publication pre-push semantic Git-tag absence plus anonymous full-SHA-tag/digest raw-manifest self-readback and semantic GHCR version-tag absence");
includes("docs/BETA_RELEASE_CRITERIA.md", "Every applicable `Candidate validation`, `Pre-promotion`, and `Post-promotion` row must be `Passed`, not exception-approved");
includes("docs/BETA_RELEASE_CRITERIA.md", "a mismatch confirmed in the independently resolved published OCI bytes, labels, platform, or attestation");
includes("docs/BETA_CANDIDATE_MANUAL_VALIDATION.md", "The manual validator's exit `0` requirement is not exception-eligible");
includes("CHANGELOG.md", "Made candidate publication require semantic Git-tag absence before push and fail closed after attestation");
includes("docs/RELEASE.md", "recommendation_profile_sessions_migrated");
includes("docs/RELEASE.md", "canonical_catalog_relationships_preserved");
includes("scripts/validate-beta-install.ts", "sqlite_foreign_keys_ok");

const publishWorkflow = read(".github/workflows/publish-image.yml");
for (const staleTerm of ["Enforce immutable candidate and release tags", "immutable SHA candidate"]) {
  if (publishWorkflow.includes(staleTerm)) failures.push(`publish-image.yml must not describe mutable GHCR tags as ${staleTerm}`);
}
const betaGateIndex = publishWorkflow.indexOf("This workflow publishes beta prereleases only");
const semanticTagGateIndex = publishWorkflow.indexOf('git ls-remote --exit-code --tags origin "refs/tags/$release_tag"');
const copyGateIndex = publishWorkflow.indexOf('if grep -Fq "## $package_version - Unreleased" CHANGELOG.md');
if (betaGateIndex < 0 || semanticTagGateIndex < 0 || copyGateIndex < 0 || betaGateIndex > semanticTagGateIndex) {
  failures.push("publish-image.yml must enforce the beta-only package gate before checking semantic Git-tag absence and release-copy readiness");
}
if (publishWorkflow.includes("git show-ref") || publishWorkflow.includes("git fetch --tags origin")) failures.push("publish-image.yml must not require a semantic Git tag before approved image promotion");
const finalTagProbeIndex = publishWorkflow.indexOf('if [[ "$version_probe_status" == "404" ]]');
const registryPutIndex = publishWorkflow.indexOf("--request PUT");
if (finalTagProbeIndex < 0 || registryPutIndex < 0 || finalTagProbeIndex > registryPutIndex) {
  failures.push("publish-image.yml must create the version tag only from the final GHCR 404 branch");
}
if (publishWorkflow.includes('if grep -Fxq "$VERSION_TAG" "$tags_file"')) {
  failures.push("publish-image.yml must not reject an existing version tag before exact-manifest adoption verification");
}

includes(".github/workflows/validate-beta-candidate.yml", "Verify anonymous public candidate pull");
includes(".github/workflows/validate-beta-candidate.yml", 'scope=repository:${image_path}:pull');
includes(".github/workflows/validate-beta-candidate.yml", 'manifests/${CANDIDATE_DIGEST}');
includes(".github/workflows/validate-beta-candidate.yml", 'schemaVersion: "moodarr-anonymous-candidate-pull-v1"');
includes(".github/workflows/validate-beta-candidate.yml", "anonymous-pull.json");

includes(".github/workflows/ci.yml", "timeout-minutes: 30");
includes(".github/workflows/ci.yml", "cancel-in-progress: true");
includes(".github/workflows/codeql.yml", "javascript-typescript");
includes(".github/workflows/codeql.yml", "runs-on: ubuntu-24.04");
includes(".github/workflows/security-scheduled.yml", "--vex .vex/moodarr.openvex.json");
includes(".github/workflows/security-scheduled.yml", "--ignore-unfixed");
includes(".github/workflows/security-scheduled.yml", "runs-on: ubuntu-24.04");
includes(".github/workflows/security-scheduled.yml", "MOODARR_BUILD_TMDB_CONTENT_POLICY=none");
includes(".github/workflows/validate-beta-candidate.yml", "validate:beta-install");
includes(".github/workflows/validate-beta-candidate.yml", "validate:beta-upgrade");
includes(".github/workflows/validate-beta-candidate.yml", 'contains("\\r") or contains("\\n")');
includes("scripts/benchmark-beta-responsiveness.ts", '"tmdb_content_policy_none"');
includes("scripts/benchmark-beta-responsiveness.ts", '"io.moodarr.tmdb-content-policy"');
includes("docs/BACKUP_AND_RECOVERY.md", 'backup_image="${MOODARR_BACKUP_IMAGE:?Set MOODARR_BACKUP_IMAGE to the exact running image digest}"');
includes("docs/BACKUP_AND_RECOVERY.md", "MOODARR_BACKUP_IMAGE does not identify the image bytes used by the running container.");
includes("docs/BACKUP_AND_RECOVERY.md", 'chmod 600 "$backup_checksum"');
includes("docs/BACKUP_AND_RECOVERY.md", 'sha256sum --check --strict -- "$checksum_name"');
includes("docs/BACKUP_AND_RECOVERY.md", "Checksum sidecar must contain one lowercase SHA-256 entry for the exact safe archive filename.");
includes("docs/BACKUP_AND_RECOVERY.md", 'docker volume create --label "$restore_owner_label=$restore_run_id"');
includes(".vex/moodarr.openvex.json", '"statements": []');

const unraid = read("unraid/moodarr.xml");
const unraidAppdataConfig = unraid.match(/<Config Name="Appdata"[^>]*>[^<]*<\/Config>/)?.[0] ?? "";
for (const required of [
  'Target="/data"',
  'Default="/mnt/user/appdata/moodarr"',
  'Mode="rw"',
  'Type="Path"',
  'Required="true"',
  '>/mnt/user/appdata/moodarr</Config>'
]) {
  if (!unraidAppdataConfig.includes(required)) failures.push(`unraid/moodarr.xml Appdata mapping does not preserve ${required}`);
}
if (!unraidAppdataConfig.includes("pre-create this exact host path as UID/GID 999:999 with mode 0700")) {
  failures.push("unraid/moodarr.xml Appdata mapping does not expose the required pre-Apply ownership boundary");
}
const unraidExtraParams = unraid.match(/<ExtraParams>([^<]+)<\/ExtraParams>/)?.[1] ?? "";
for (const requiredFlag of [
  "--read-only",
  "--tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=128",
  "--memory=2g",
  "--memory-swap=2g",
  "--cpus=2",
  "--init",
  "--stop-timeout=30"
]) {
  if (!unraidExtraParams.includes(requiredFlag)) failures.push(`unraid/moodarr.xml does not retain container hardening flag ${requiredFlag}`);
}
for (const secret of ["Admin Token", "Plex Token", "Seerr API Key"]) {
  const pattern = new RegExp(`<Config Name="${escapeRegExp(secret)}"[^>]+Mask="true"`);
  if (!pattern.test(unraid)) failures.push(`unraid/moodarr.xml does not mask ${secret}`);
}

const unraidGuideSource = read("docs/UNRAID.md");
const unraidPreparationSnippet = unraidGuideSource.match(/### Prepare appdata before first Apply[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];
if (!unraidPreparationSnippet) {
  failures.push("docs/UNRAID.md does not contain the executable fresh-appdata preparation block");
} else {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "moodarr-unraid-appdata-"));
  try {
    const fixtureBin = join(fixtureRoot, "bin");
    mkdirSync(fixtureBin, { mode: 0o700 });
    const installStub = join(fixtureBin, "install");
    const statStub = join(fixtureBin, "stat");
    writeFileSync(installStub, `#!/bin/sh
set -eu
test "$#" -eq 8
test "$1" = -d
test "$2" = -m
test "$3" = 0700
test "$4" = -o
test "$5" = 999
test "$6" = -g
test "$7" = 999
mkdir -p "$8"
chmod 0700 "$8"
: >"$8/.moodarr-test-owner-999"
`);
    writeFileSync(statStub, `#!/bin/sh
set -eu
test "$#" -eq 3
test "$1" = -c
test "$2" = '%u:%g %a'
test -f "$3/.moodarr-test-owner-999"
printf '%s\\n' '999:999 700'
`);
    chmodSync(installStub, 0o700);
    chmodSync(statStub, 0o700);
    const executableSnippet = unraidPreparationSnippet.replace(
      "appdata=/mnt/user/appdata/moodarr",
      'appdata="${MOODARR_TEST_APPDATA:?}"'
    );
    const runSnippet = (shell: "bash" | "sh", appdata: string) => spawnSync(shell, ["-c", executableSnippet], {
      encoding: "utf8",
      env: {
        ...process.env,
        MOODARR_TEST_APPDATA: appdata,
        PATH: `${fixtureBin}:${process.env.PATH ?? ""}`
      }
    });
    for (const shell of ["bash", "sh"] as const) {
      const freshPath = join(fixtureRoot, `${shell}-fresh`);
      const fresh = runSnippet(shell, freshPath);
      expect(fresh.status === 0, `docs/UNRAID.md fresh-appdata block must succeed under ${shell}: ${fresh.stderr}`);
      expect(
        fresh.stdout.includes(`Prepared ${freshPath} as 999:999 700`),
        `docs/UNRAID.md fresh-appdata block must print the verified ${shell} ownership read-back`
      );

      const existingPath = join(fixtureRoot, `${shell}-existing`);
      mkdirSync(existingPath, { mode: 0o700 });
      const sentinel = join(existingPath, "sentinel");
      writeFileSync(sentinel, "preserve\n");
      const existing = runSnippet(shell, existingPath);
      expect(existing.status !== 0, `docs/UNRAID.md fresh-appdata block must refuse an existing path under ${shell}`);
      expect(existing.stderr.includes("Refusing fresh-install setup"), `docs/UNRAID.md existing-path refusal must be visible under ${shell}`);
      expect(existsSync(sentinel), `docs/UNRAID.md existing-path refusal must preserve existing data under ${shell}`);

      const symlinkPath = join(fixtureRoot, `${shell}-dangling-symlink`);
      symlinkSync(join(fixtureRoot, `${shell}-missing-target`), symlinkPath);
      const symlink = runSnippet(shell, symlinkPath);
      expect(symlink.status !== 0, `docs/UNRAID.md fresh-appdata block must refuse a dangling symlink under ${shell}`);
      expect(symlink.stderr.includes("Refusing fresh-install setup"), `docs/UNRAID.md symlink refusal must be visible under ${shell}`);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
for (const [path, forbidden] of [
  ["docker-compose.example.yml", "AI_PROVIDER"],
  ["docker-compose.example.yml", "OPENAI_API_KEY"],
  ["unraid/moodarr.xml", 'Target="AI_PROVIDER"'],
  ["unraid/moodarr.xml", 'Target="OPENAI_API_KEY"']
] as const) {
  if (read(path).includes(forbidden)) failures.push(`${path} must not expose unsupported beta provider setting ${forbidden}`);
}

for (const required of [
  ".env.example",
  "Dockerfile",
  "docker-compose.example.yml",
  "unraid/moodarr.xml",
  "scripts/validate-beta-install.ts",
  "scripts/fixtures/beta-install-integrations.mjs",
  "scripts/validate-beta-upgrade.ts",
  ".github/workflows/validate-beta-candidate.yml"
]) {
  if (!existsSync(join(root, required))) failures.push(`${required} is missing`);
}

for (const forbidden of ["public/brand-options.html", "public/ux-proposal.html", "public/brand-options"]) {
  if (existsSync(join(root, forbidden))) failures.push(`${forbidden} should stay out of the production public bundle`);
}

if (!existsSync(join(root, "dist/server/searchWorker.js"))) failures.push("dist/server/searchWorker.js is missing from the production server build");
if (!existsSync(join(root, "dist/server/syncWorker.js"))) failures.push("dist/server/syncWorker.js is missing from the production server build");
if (!existsSync(join(root, "dist/server/importWikidataCatalog.js"))) {
  failures.push("dist/server/importWikidataCatalog.js is missing from the production server build");
}

try {
  const compose = JSON.parse(execFileSync("docker", ["compose", "-f", "docker-compose.example.yml", "config", "--format", "json"], {
    cwd: root,
    env: {
      ...process.env,
      MOODARR_ADMIN_TOKEN: "packaging-check-admin-token",
      MOODARR_WEB_ORIGIN: "http://127.0.0.1:4401"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })) as {
    services?: {
      moodarr?: {
        read_only?: boolean;
        init?: boolean;
        cap_drop?: string[];
        security_opt?: string[];
        pids_limit?: number;
        mem_limit?: number | string;
        memswap_limit?: number | string;
        cpus?: number;
        tmpfs?: Array<string | { target?: string }>;
        volumes?: Array<{ type?: string; source?: string; target?: string }>;
      };
    };
  };
  const service = compose.services?.moodarr;
  if (!service?.read_only) failures.push("docker-compose.example.yml must use a read-only root filesystem");
  if (!service?.init) failures.push("docker-compose.example.yml must enable the init process");
  if (!service?.cap_drop?.includes("ALL")) failures.push("docker-compose.example.yml must drop all Linux capabilities");
  if (!service?.security_opt?.includes("no-new-privileges:true")) failures.push("docker-compose.example.yml must prevent privilege escalation");
  if (service?.pids_limit !== 128) failures.push("docker-compose.example.yml must retain its PID limit");
  if (Number(service?.mem_limit) !== 2 * 1024 * 1024 * 1024) failures.push("docker-compose.example.yml must retain its 2 GiB memory limit");
  if (Number(service?.memswap_limit) !== 2 * 1024 * 1024 * 1024) failures.push("docker-compose.example.yml must not add swap beyond its 2 GiB memory limit");
  if (service?.cpus !== 2) failures.push("docker-compose.example.yml must retain its two-CPU limit");
  if (!service?.tmpfs?.some((mount) => (typeof mount === "string" ? mount.startsWith("/tmp:") : mount.target === "/tmp"))) {
    failures.push("docker-compose.example.yml must provide a writable /tmp tmpfs");
  }
  const dataMount = service?.volumes?.find((mount) => mount.target === "/data");
  if (dataMount?.type !== "volume" || !dataMount.source?.endsWith("moodarr-data")) {
    failures.push("docker-compose.example.yml must use a named volume for the default /data mount");
  }
} catch (error) {
  failures.push(`docker compose config failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Packaging checks passed.");

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
