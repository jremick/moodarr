import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures: string[] = [];

const read = (path: string) => readFileSync(join(root, path), "utf8");
const includes = (path: string, value: string) => {
  if (!read(path).includes(value)) failures.push(`${path} does not include ${value}`);
};

includes("Dockerfile", "CMD [\"node\", \"dist/server/index.js\"]");
includes("Dockerfile", "USER moodarr");
includes("Dockerfile", "MOODARR_VERSION=${MOODARR_VERSION}");
includes("Dockerfile", "MOODARR_BUILD_REVISION=${MOODARR_BUILD_REVISION}");
includes("Dockerfile", "node:24-bookworm-slim@sha256:");
includes("Dockerfile", "/usr/local/lib/node_modules/npm");
includes("docker-compose.example.yml", "OPENAI_MODEL: ${OPENAI_MODEL:-gpt-5.5}");
includes("docker-compose.example.yml", 'MOODARR_ADMIN_AUTO_SESSION: "false"');
includes("docker-compose.example.yml", "read_only: true");
includes("docker-compose.example.yml", "no-new-privileges:true");
includes("docker-compose.example.yml", "cap_drop:");
includes("docker-compose.example.yml", "pids_limit: 128");
includes("docker-compose.example.yml", "size=512m");
includes("unraid/moodarr.xml", "<Name>Moodarr</Name>");
includes("unraid/moodarr.xml", "Default=\"gpt-5.5\"");
includes("unraid/moodarr.xml", 'Target="MOODARR_ADMIN_AUTO_SESSION" Default="false"');
includes("unraid/moodarr.xml", 'Target="MOODARR_WEB_ORIGIN" Default=""');
includes(".github/workflows/release-verify.yml", "npm run verify:release");
includes(".github/workflows/publish-image.yml", "uses: ./.github/workflows/release-verify.yml");
includes(".github/workflows/publish-image.yml", "needs: verify");
includes(".github/workflows/publish-image.yml", "sbom: true");
includes(".github/workflows/publish-image.yml", "does not match package version");
includes(".github/workflows/codeql.yml", "javascript-typescript");
includes(".github/workflows/security-scheduled.yml", "--vex .vex/moodarr.openvex.json");
includes(".github/workflows/security-scheduled.yml", "--ignore-unfixed");
includes(".vex/moodarr.openvex.json", "vulnerable_code_not_in_execute_path");

for (const entry of readdirSync(join(root, ".github", "workflows"))) {
  if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
  const workflow = `.github/workflows/${entry}`;
  for (const match of read(workflow).matchAll(/uses:\s+([^\s@]+)@([^\s#]+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(match[2] ?? "")) failures.push(`${workflow} contains an action that is not pinned to a full commit SHA: ${match[1]}`);
  }
}

const unraid = read("unraid/moodarr.xml");
const unraidExtraParams = unraid.match(/<ExtraParams>([^<]+)<\/ExtraParams>/)?.[1] ?? "";
for (const requiredFlag of [
  "--read-only",
  "--tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=128",
  "--memory=2g",
  "--cpus=2",
  "--init",
  "--stop-timeout=30"
]) {
  if (!unraidExtraParams.includes(requiredFlag)) failures.push(`unraid/moodarr.xml does not retain container hardening flag ${requiredFlag}`);
}
for (const secret of ["Admin Token", "Plex Token", "Seerr API Key", "OpenAI API Key"]) {
  const pattern = new RegExp(`<Config Name="${escapeRegExp(secret)}"[^>]+Mask="true"`);
  if (!pattern.test(unraid)) failures.push(`unraid/moodarr.xml does not mask ${secret}`);
}

for (const required of [".env.example", "Dockerfile", "docker-compose.example.yml", "unraid/moodarr.xml"]) {
  if (!existsSync(join(root, required))) failures.push(`${required} is missing`);
}

for (const forbidden of ["public/brand-options.html", "public/ux-proposal.html", "public/brand-options"]) {
  if (existsSync(join(root, forbidden))) failures.push(`${forbidden} should stay out of the production public bundle`);
}

if (!existsSync(join(root, "docs/assets/moodarr-finder.png"))) failures.push("docs/assets/moodarr-finder.png is missing");
if (!existsSync(join(root, "dist/server/searchWorker.js"))) failures.push("dist/server/searchWorker.js is missing from the production server build");

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
        cpus?: number;
        tmpfs?: Array<string | { target?: string }>;
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
  if (service?.cpus !== 2) failures.push("docker-compose.example.yml must retain its two-CPU limit");
  if (!service?.tmpfs?.some((mount) => (typeof mount === "string" ? mount.startsWith("/tmp:") : mount.target === "/tmp"))) {
    failures.push("docker-compose.example.yml must provide a writable /tmp tmpfs");
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
