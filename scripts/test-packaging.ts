import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    'docker buildx inspect "$builder_name" --bootstrap',
    'test "$buildkit_version" = "v0.30.0"',
    'echo "name=$builder_name" >> "$GITHUB_OUTPUT"'
  ], context);
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
  expectRunContains(step, [
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
    'test -s "$attestation_report"'
  ], `${context} provenance binding`);
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
  });
};

const auditPublishWorkflow = () => {
  inspectWorkflow(PUBLISH_WORKFLOW_PATH, (workflow) => {
    expectEmptyPermissions(workflow, PUBLISH_WORKFLOW_PATH);
    expectNoSetupBuildxAction(workflow, PUBLISH_WORKFLOW_PATH);

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
    expectPermissions(publish, {
      attestations: "write",
      contents: "read",
      "id-token": "write",
      packages: "write"
    }, `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);

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

    const build = namedStep(publish, "Build and push image", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectStepUses(build, BUILD_PUSH_ACTION, `${PUBLISH_WORKFLOW_PATH} candidate build`);
    const buildWith = expectStepWith(build, {
      builder: "${{ steps.buildx.outputs.name }}",
      platforms: "linux/amd64",
      provenance: "mode=max",
      push: true,
      sbom: SBOM_GENERATOR
    }, `${PUBLISH_WORKFLOW_PATH} candidate build`);
    const buildArguments = stringField(buildWith, "build-args", `${PUBLISH_WORKFLOW_PATH} candidate build.with`);
    for (const requiredArgument of [
      "MOODARR_BUILD_AI_PROVIDER_POLICY=none",
      "MOODARR_BUILD_TMDB_CONTENT_POLICY=none"
    ]) {
      expect(buildArguments.split("\n").map((value) => value.trim()).includes(requiredArgument), `${PUBLISH_WORKFLOW_PATH} candidate build must set ${requiredArgument}`);
    }

    const promotion = namedStep(publish, "Verify and promote the exact candidate manifest", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expectRunContains(promotion, [
      'gh attestation verify "oci://${IMAGE}@${computed_digest}"',
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/publish-image.yml"',
      '--signer-digest "$VERIFIED_SHA"',
      '--source-digest "$VERIFIED_SHA"',
      "--source-ref refs/heads/main",
      "--deny-self-hosted-runners"
    ], `${PUBLISH_WORKFLOW_PATH} semantic promotion attestation binding`);

    const cleanup = namedStep(publish, "Remove candidate builder", `${PUBLISH_WORKFLOW_PATH}.jobs.publish`);
    expect(typeof cleanup.if === "string" && cleanup.if.includes("always()"), `${PUBLISH_WORKFLOW_PATH} candidate builder cleanup must run on failure`);
    expectEqual(cleanup.run, 'docker buildx rm "$BUILDER_NAME"', `${PUBLISH_WORKFLOW_PATH} candidate builder cleanup command`);
  });
};

const auditReleaseVerifyWorkflow = () => {
  inspectWorkflow(RELEASE_VERIFY_WORKFLOW_PATH, (workflow) => {
    for (const jobId of ["verify", "container-scan"]) {
      const job = workflowJob(workflow, jobId, RELEASE_VERIFY_WORKFLOW_PATH);
      expectEqual(job["runs-on"], "ubuntu-24.04", `${RELEASE_VERIFY_WORKFLOW_PATH}.jobs.${jobId}.runs-on`);
    }
    const containerScan = workflowJob(workflow, "container-scan", RELEASE_VERIFY_WORKFLOW_PATH);
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

    const candidateJobs = ["clean-install", "upgrade-rollback", "supply-chain"];
    for (const jobId of candidateJobs) {
      const context = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.${jobId}`;
      const job = workflowJob(workflow, jobId, VALIDATE_CANDIDATE_WORKFLOW_PATH);
      expectEqual(job["runs-on"], "ubuntu-24.04", `${context}.runs-on`);
      expectNeedsAuthorize(job, context);
      expectPermissions(job, { attestations: "read", contents: "read", packages: "read" }, context);
      expectStepUses(singleStepUsing(job, CHECKOUT_ACTION, context), CHECKOUT_ACTION, `${context} checkout`);
      expectStepUses(singleStepUsing(job, LOGIN_ACTION, context), LOGIN_ACTION, `${context} registry login`);
      expectCandidateBindingStep(job, context);
    }

    for (const jobId of ["clean-install", "upgrade-rollback"]) {
      const context = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.${jobId}`;
      const job = workflowJob(workflow, jobId, VALIDATE_CANDIDATE_WORKFLOW_PATH);
      expectStepUses(singleStepUsing(job, SETUP_NODE_ACTION, context), SETUP_NODE_ACTION, `${context} Node setup`);
    }

    const supply = workflowJob(workflow, "supply-chain", VALIDATE_CANDIDATE_WORKFLOW_PATH);
    const supplyContext = `${VALIDATE_CANDIDATE_WORKFLOW_PATH}.jobs.supply-chain`;
    expectVerifiedBuildxInstall(supply, "Authenticate for candidate inspection", supplyContext);
    const builder = namedStep(supply, "Create pinned BuildKit builder", supplyContext);
    expectPinnedBuilderStep(builder, `${supplyContext} builder`, false);
    expectStepBefore(supply, "Authenticate for candidate inspection", "Create pinned BuildKit builder", supplyContext);
    expectStepBefore(supply, "Create pinned BuildKit builder", "Verify evidence toolchain identity", supplyContext);

    const trivyInstall = namedStep(supply, "Install Trivy", supplyContext);
    expectStepUses(trivyInstall, SETUP_TRIVY_ACTION, `${supplyContext} Trivy install`);
    expectStepWith(trivyInstall, { version: "v0.70.0" }, `${supplyContext} Trivy install`);

    const toolchain = namedStep(supply, "Verify evidence toolchain identity", supplyContext);
    expectRunContains(toolchain, [
      BUILD_X_SHA256,
      '[[ "$buildx_version" == v0.34.1* ]]',
      'test "$buildkit_version" = "v0.30.0"',
      'test "$scanner_version" = "0.70.0"'
    ], `${supplyContext} toolchain verification`);

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
    const cases: Array<{ name: string; highCritical?: string; actionable?: string; shouldPass: boolean }> = [
      { name: "valid omitted vulnerability results", highCritical: JSON.stringify(validTrivyFixture), actionable: JSON.stringify(validTrivyFixture), shouldPass: true },
      { name: "valid null vulnerability results", highCritical: JSON.stringify(nullVulnerabilitiesFixture), actionable: JSON.stringify(nullVulnerabilitiesFixture), shouldPass: true },
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
          CANDIDATE_IMAGE: "ghcr.io/jremick/moodarr@sha256:fixture",
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
includes("scripts/validate-beta-install.ts", '"tmdb_content_policy_ok"');
includes("scripts/validate-beta-install.ts", 'from "./release-bundle-policy"');
includes("scripts/validate-beta-install.ts", "releaseBundleScanScript()");
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
if (read("unraid/moodarr.xml").includes("<Shell>")) failures.push("unraid/moodarr.xml must not advertise an interactive shell in the distroless runtime");
includes("unraid/moodarr.xml", 'Target="MOODARR_ADMIN_AUTO_SESSION" Default="false"');
includes("unraid/moodarr.xml", 'Target="MOODARR_WEB_ORIGIN" Default=""');
includes(".github/workflows/release-verify.yml", "npm run verify:release");
includes(".github/workflows/release-verify.yml", "Scan release-candidate runtime image");
includes(".github/workflows/release-verify.yml", "--ignore-unfixed");
includes(".github/workflows/publish-image.yml", "package.json version is not a strict SemVer release version");
includes(".github/workflows/publish-image.yml", "org.opencontainers.image.version=${{ steps.image.outputs.package_version }}");
includes(".github/workflows/publish-image.yml", "org.opencontainers.image.revision=${{ needs.verify.outputs.commit_sha }}");
includes(".github/workflows/publish-image.yml", 'git merge-base --is-ancestor "$resolved_sha" origin/main');
includes(".github/workflows/publish-image.yml", 'git show-ref --verify --quiet "refs/tags/$version_tag"');
includes(".github/workflows/publish-image.yml", 'grep -Fq "Until the first beta is published" docs/COMPATIBILITY.md');
includes(".github/workflows/publish-image.yml", 'grep -Fq "No public beta has been published yet" SECURITY.md');
includes(".github/workflows/publish-image.yml", 'grep -Fq "No public beta has been published yet" SUPPORT.md');
includes(".github/workflows/publish-image.yml", "Require the default-branch workflow definition");
includes(".github/workflows/publish-image.yml", "Refuse known existing candidate and release tags");
includes(".github/workflows/publish-image.yml", 'candidate_tag="sha-$resolved_sha"');
includes(".github/workflows/publish-image.yml", "DISPATCH_SHA: ${{ github.sha }}");
includes(".github/workflows/publish-image.yml", '"$resolved_sha" != "$DISPATCH_SHA"');
includes(".github/workflows/publish-image.yml", "Semantic promotion requires the exact validated candidate_digest");
includes(".github/workflows/publish-image.yml", "fix it before publishing a versioned SHA candidate");
includes(".github/workflows/publish-image.yml", "Required candidate tag $CANDIDATE_TAG does not exist");
includes(".github/workflows/publish-image.yml", "if: steps.image.outputs.release_mode == 'candidate'");
includes(".github/workflows/publish-image.yml", "if: steps.image.outputs.release_mode == 'promotion'");
includes(".github/workflows/publish-image.yml", 'if [[ "$version_probe_status" != "404" ]]');
includes(".github/workflows/publish-image.yml", '--data-binary "@$manifest_file"');
includes(".github/workflows/publish-image.yml", "Promoted release tag did not read back as the exact candidate manifest");
includes(".github/workflows/publish-image.yml", "group: publish-image");
includes("docs/RELEASE.md", "review and freeze the new HEAD and publish a new candidate from it; do not move `main` backward solely for publication");
includes("docs/RELEASE.md", 'candidate_commit="<full-40-character-sha>"');
includes("docs/RELEASE.md", '--signer-digest "$candidate_commit"');
includes("docs/RELEASE.md", '--source-digest "$candidate_commit"');
includes("docs/RELEASE.md", "--source-ref refs/heads/main");
includes("docs/RELEASE.md", "repository package-write permission must remain restricted");
includes("docs/RELEASE.md", "Verify GHCR package access grants write permission only to the Moodarr repository workflow and the minimum required maintainer accounts");
includes("docs/BETA_RELEASE_CRITERIA.md", "GHCR package-writer access review");
includes("docs/RELEASE.md", "recommendation_profile_sessions_migrated");
includes("docs/RELEASE.md", "canonical_catalog_relationships_preserved");
includes("scripts/validate-beta-install.ts", "sqlite_foreign_keys_ok");

const publishWorkflow = read(".github/workflows/publish-image.yml");
for (const staleTerm of ["Enforce immutable candidate and release tags", "immutable SHA candidate"]) {
  if (publishWorkflow.includes(staleTerm)) failures.push(`publish-image.yml must not describe mutable GHCR tags as ${staleTerm}`);
}
const copyGateIndex = publishWorkflow.indexOf('if grep -Fq "## $package_version - Unreleased" CHANGELOG.md');
const semanticTagGateIndex = publishWorkflow.indexOf("git fetch --tags origin");
if (copyGateIndex < 0 || semanticTagGateIndex < 0 || copyGateIndex > semanticTagGateIndex) {
  failures.push("publish-image.yml must reject candidate-only copy before the semantic-only tag gate so SHA publication cannot create an unusable candidate");
}
const manifestAccept = "Accept: $manifest_accept";
if (publishWorkflow.split(manifestAccept).length - 1 !== 3) {
  failures.push("publish-image.yml must use one shared manifest Accept value for candidate fetch, final absence probe, and promotion read-back");
}
const finalTagProbeIndex = publishWorkflow.indexOf('if [[ "$version_probe_status" != "404" ]]');
const registryPutIndex = publishWorkflow.indexOf("--request PUT");
if (finalTagProbeIndex < 0 || registryPutIndex < 0 || finalTagProbeIndex > registryPutIndex) {
  failures.push("publish-image.yml must require a final GHCR 404 absence check immediately before the manifest PUT");
}

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
