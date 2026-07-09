import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = "moodarr:smoke";
const containerName = `moodarr-smoke-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), "moodarr-smoke-"));
chmodSync(dataDir, 0o777);
const port = await findAvailablePort();
const adminToken = "smoke-admin-token-secret";
let runExitCode: number | null = null;

try {
  execFileSync("docker", ["build", "-t", image, "."], { stdio: "inherit" });
  const run = spawn(
    "docker",
    [
      "run",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${port}:4401`,
      "-v",
      `${dataDir}:/data`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "MOODARR_REQUIRE_ADMIN_TOKEN=true",
      "-e",
      `MOODARR_ADMIN_TOKEN=${adminToken}`,
      "-e",
      "MOODARR_FIXTURE_MODE=true",
      image
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  run.once("exit", (code) => {
    runExitCode = code;
  });

  try {
    await waitForHealth(port, () => runExitCode);
    await expectStatus(`http://127.0.0.1:${port}/api/health`, 200);
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
  } catch (error) {
    printContainerDiagnostics(containerName);
    throw error;
  } finally {
    run.kill("SIGTERM");
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // The container may already be gone because it runs with --rm.
    }
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Container smoke checks passed.");

async function waitForHealth(portNumber: number, getExitCode: () => number | null) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const exitCode = getExitCode();
    if (exitCode !== null) throw new Error(`Container exited before becoming healthy with status ${exitCode}.`);
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

function printContainerDiagnostics(name: string) {
  for (const args of [
    ["ps", "-a", "--filter", `name=${name}`],
    ["logs", name]
  ]) {
    try {
      execFileSync("docker", args, { stdio: "inherit" });
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
