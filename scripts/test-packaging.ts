import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
includes("docker-compose.example.yml", "OPENAI_MODEL: ${OPENAI_MODEL:-gpt-5.5}");
includes("docker-compose.example.yml", 'MOODARR_ADMIN_AUTO_SESSION: "false"');
includes("unraid/moodarr.xml", "<Name>Moodarr</Name>");
includes("unraid/moodarr.xml", "Default=\"gpt-5.5\"");
includes("unraid/moodarr.xml", 'Target="MOODARR_ADMIN_AUTO_SESSION" Default="false"');
includes(".github/workflows/release-verify.yml", "npm run verify:release");
includes(".github/workflows/publish-image.yml", "uses: ./.github/workflows/release-verify.yml");
includes(".github/workflows/publish-image.yml", "needs: verify");
includes(".github/workflows/publish-image.yml", "sbom: true");
includes(".github/workflows/publish-image.yml", "does not match package version");

for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release-verify.yml", ".github/workflows/publish-image.yml"]) {
  if (/uses:\s+[^\s]+@v\d+/m.test(read(workflow))) failures.push(`${workflow} contains a mutable major action tag`);
}

const unraid = read("unraid/moodarr.xml");
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

try {
  execFileSync("docker", ["compose", "-f", "docker-compose.example.yml", "config"], {
    cwd: root,
    env: {
      ...process.env,
      MOODARR_ADMIN_TOKEN: "packaging-check-admin-token"
    },
    stdio: "pipe"
  });
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
