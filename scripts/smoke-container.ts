import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

const image = "moodarr:smoke";
const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const smokeRevision = "0000000000000000000000000000000000000001";
const composeProject = `moodarrsmoke${process.pid}`;
const port = await findAvailablePort();
const adminToken = "smoke-admin-token-secret";
const composeEnv = {
  ...process.env,
  MOODARR_IMAGE: image,
  MOODARR_PORT: String(port),
  MOODARR_DATA_VOLUME: `${composeProject}-data`,
  MOODARR_WEB_ORIGIN: `http://127.0.0.1:${port}`,
  MOODARR_ADMIN_TOKEN: adminToken,
  PLEX_BASE_URL: "",
  PLEX_TOKEN: "",
  SEERR_BASE_URL: "",
  SEERR_API_KEY: "",
  AI_PROVIDER: "none",
  OPENAI_API_KEY: ""
};
const composeArgs = ["compose", "--project-name", composeProject, "--file", "docker-compose.example.yml"];
let composeStarted = false;

try {
  execFileSync(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "--build-arg",
      `MOODARR_VERSION=${packageVersion}`,
      "--build-arg",
      `MOODARR_BUILD_REVISION=${smokeRevision}`,
      "-t",
      image,
      "."
    ],
    { stdio: "inherit" }
  );
  const imageLabels = JSON.parse(
    execFileSync("docker", ["image", "inspect", image, "--format", "{{json .Config.Labels}}"], { encoding: "utf8" })
  ) as Record<string, string>;
  if (
    imageLabels["org.opencontainers.image.version"] !== packageVersion
    || imageLabels["org.opencontainers.image.revision"] !== smokeRevision
  ) {
    throw new Error(
      `Container label identity mismatch: expected ${packageVersion}@${smokeRevision}, received ${imageLabels["org.opencontainers.image.version"] ?? "missing"}@${imageLabels["org.opencontainers.image.revision"] ?? "missing"}.`
    );
  }
  const runtimeIdentity = JSON.parse(
    execFileSync(
      "docker",
      [
        ...composeArgs,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "/nodejs/bin/node",
        "moodarr",
        "-e",
        "console.log(JSON.stringify({ arch: process.arch, uid: process.getuid?.(), gid: process.getgid?.() }))"
      ],
      { env: composeEnv, encoding: "utf8" }
    ).trim()
  ) as { arch?: string; uid?: number; gid?: number };
  if (runtimeIdentity.arch !== "x64" || runtimeIdentity.uid !== 999 || runtimeIdentity.gid !== 999) {
    throw new Error(`Container runtime identity mismatch: ${JSON.stringify(runtimeIdentity)}.`);
  }
  execFileSync("docker", [...composeArgs, "up", "--detach", "--no-build"], { env: composeEnv, stdio: "inherit" });
  composeStarted = true;
  await waitForHealth(port);
  const health = await expectStatus(`http://127.0.0.1:${port}/api/health`, 200);
  const healthBody = (await health.json()) as {
    version?: string;
    revision?: string;
    search?: { ready?: boolean; workerCount?: number; closed?: boolean };
    sync?: { ready?: boolean; workerCount?: number; closed?: boolean };
  };
  if (healthBody.version !== packageVersion || healthBody.revision !== smokeRevision) {
    throw new Error(
      `Container identity mismatch: expected ${packageVersion}@${smokeRevision}, received ${healthBody.version ?? "missing"}@${healthBody.revision ?? "missing"}.`
    );
  }
  if (!healthBody.sync?.ready || healthBody.sync.workerCount !== 1 || healthBody.sync.closed) {
    throw new Error(`Packaged sync worker was not ready: ${JSON.stringify(healthBody.sync ?? null)}.`);
  }
  if (!healthBody.search?.ready || healthBody.search.workerCount !== 2 || healthBody.search.closed) {
    throw new Error(`Packaged search/diagnostics workers were not ready: ${JSON.stringify(healthBody.search ?? null)}.`);
  }
  execFileSync("docker", [
    ...composeArgs,
    "exec",
    "--no-TTY",
    "moodarr",
    "/nodejs/bin/node",
    "-e",
    'const { accessSync, constants } = require("node:fs"); for (const path of ["/app/LICENSE", "/app/THIRD_PARTY_NOTICES.md"]) accessSync(path, constants.R_OK);'
  ], {
    env: composeEnv,
    stdio: "inherit"
  });
  await expectStatus(`http://127.0.0.1:${port}/`, 200);
  await expectStatus(`http://127.0.0.1:${port}/api/admin/settings`, 401);
  const bootstrap = await expectStatus(`http://127.0.0.1:${port}/api/admin/session`, 200);
  if (bootstrap.headers.has("set-cookie")) throw new Error("Admin bootstrap unexpectedly auto-minted a session cookie.");
  const invalidSession = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "wrong-admin-token" })
  });
  if (invalidSession.status !== 401 || invalidSession.headers.has("set-cookie")) {
    throw new Error("Invalid admin session exchange did not fail closed.");
  }
  const session = await fetch(`http://127.0.0.1:${port}/api/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: adminToken })
  });
  if (!session.ok) throw new Error(`Admin session exchange returned HTTP ${session.status}.`);
  const adminCookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!adminCookie) throw new Error("Admin session exchange did not return a cookie.");
  await expectStatus(`http://127.0.0.1:${port}/api/admin/settings`, 200, { Cookie: adminCookie });
  await expectStatus(`http://127.0.0.1:${port}/api/admin/settings`, 200, { "X-Moodarr-Admin-Token": adminToken });
  const search = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Moodarr-Admin-Token": adminToken },
    body: JSON.stringify({ query: "funny fantasy", resultLimit: 3, useAi: false })
  });
  if (!search.ok) throw new Error(`Search smoke failed with HTTP ${search.status}`);
  const body = (await search.json()) as { results?: { posterUrl: string; title: string }[] };
  if (!body.results?.length) throw new Error("Search smoke returned no fixture results.");
  const poster = await fetch(`http://127.0.0.1:${port}${body.results[0]!.posterUrl}`, {
    headers: { "X-Moodarr-Admin-Token": adminToken }
  });
  if (!poster.ok || !poster.headers.get("content-type")?.startsWith("image/")) throw new Error("Poster smoke did not return image content.");
  const syncAccepted = await fetch(`http://127.0.0.1:${port}/api/admin/sync/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Moodarr-Admin-Token": adminToken },
    body: "{}"
  });
  if (syncAccepted.status !== 202) throw new Error(`Packaged sync worker returned HTTP ${syncAccepted.status}; expected 202.`);
  const acceptedBody = (await syncAccepted.json()) as { accepted?: boolean; running?: boolean };
  if (!acceptedBody.accepted || !acceptedBody.running) throw new Error("Packaged sync worker did not acknowledge the accepted run as active.");
  await waitForSync(port, adminToken);
} catch (error) {
  if (composeStarted) printComposeDiagnostics();
  throw error;
} finally {
  try {
    execFileSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], { env: composeEnv, stdio: "ignore" });
  } catch {
    // The project may already be gone after an early Compose failure.
  }
}

console.log("Container smoke checks passed.");

async function waitForHealth(portNumber: number) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the container finishes booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for container health.");
}

async function findAvailablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a local smoke-test port."));
      });
    });
  });
}

async function waitForSync(portNumber: number, token: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${portNumber}/api/admin/sync/status`, {
      headers: { "X-Moodarr-Admin-Token": token }
    });
    if (!response.ok) throw new Error(`Sync status returned HTTP ${response.status}.`);
    const status = (await response.json()) as {
      running?: boolean;
      worker?: { ready?: boolean; workerCount?: number; closed?: boolean };
      lastResult?: { ok?: boolean; plexItems?: number; seerrItems?: number; error?: string };
    };
    if (!status.worker?.ready || status.worker.workerCount !== 1 || status.worker.closed) {
      throw new Error(`Packaged sync worker became unavailable: ${JSON.stringify(status.worker ?? null)}.`);
    }
    if (!status.running && status.lastResult) {
      if (!status.lastResult.ok || status.lastResult.plexItems !== 6 || status.lastResult.seerrItems !== 4) {
        throw new Error(`Packaged fixture sync failed: ${JSON.stringify(status.lastResult)}.`);
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the packaged sync worker.");
}

function printComposeDiagnostics() {
  for (const args of [[...composeArgs, "ps", "--all"], [...composeArgs, "logs", "--no-color", "--tail", "100"]]) {
    try {
      execFileSync("docker", args, { env: composeEnv, stdio: "inherit" });
    } catch {
      // Diagnostics are best-effort; keep the original smoke failure visible.
    }
  }
}

async function expectStatus(url: string, expected: number, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  if (response.status !== expected) throw new Error(`${url} returned HTTP ${response.status}; expected ${expected}.`);
  return response;
}
