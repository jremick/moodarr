import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const image = "moodarr:smoke";
const containerName = `moodarr-smoke-${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), "moodarr-smoke-"));
const port = 4499;
const adminToken = "smoke-admin-token-secret";

try {
  execFileSync("docker", ["build", "-t", image, "."], { stdio: "inherit" });
  const run = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `${port}:4401`,
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
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  try {
    await waitForHealth(port);
    await expectStatus(`http://127.0.0.1:${port}/api/health`, 200);
    await expectStatus(`http://127.0.0.1:${port}/`, 200);
    await expectStatus(`http://127.0.0.1:${port}/api/admin/settings`, 401);
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

async function expectStatus(url: string, expected: number, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  if (response.status !== expected) throw new Error(`${url} returned HTTP ${response.status}; expected ${expected}.`);
}
