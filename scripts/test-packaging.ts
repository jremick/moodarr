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
includes("Dockerfile", "USER feelerr");
includes("docker-compose.example.yml", "OPENAI_MODEL: ${OPENAI_MODEL:-gpt-5.5}");
includes("unraid/feelerr.xml", "<Name>Feelarr</Name>");
includes("unraid/feelerr.xml", "Default=\"gpt-5.5\"");

const unraid = read("unraid/feelerr.xml");
for (const secret of ["Admin Token", "Plex Token", "Seerr API Key", "OpenAI API Key"]) {
  const pattern = new RegExp(`<Config Name="${escapeRegExp(secret)}"[^>]+Mask="true"`);
  if (!pattern.test(unraid)) failures.push(`unraid/feelerr.xml does not mask ${secret}`);
}

for (const required of [".env.example", "Dockerfile", "docker-compose.example.yml", "unraid/feelerr.xml"]) {
  if (!existsSync(join(root, required))) failures.push(`${required} is missing`);
}

try {
  execFileSync("docker", ["compose", "-f", "docker-compose.example.yml", "config"], {
    cwd: root,
    env: {
      ...process.env,
      FEELERR_ADMIN_TOKEN: "packaging-check-admin-token"
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
