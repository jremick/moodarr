import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { InstallValidationError, parseInstallArgs, runBeta4UpgradeValidation } from "./validate-beta-install";

async function main() {
  try {
    const report = await runBeta4UpgradeValidation(parseInstallArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.releaseEligible ? 0 : 1;
  } catch (error) {
    const code = error instanceof InstallValidationError ? error.code : "beta4_upgrade_incomplete";
    process.stdout.write(`${JSON.stringify({ schema: "moodarr-beta4-upgrade-v1", passed: false, releaseEligible: false, incomplete: [code] })}\n`);
    process.exitCode = 2;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main();
