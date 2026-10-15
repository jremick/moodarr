/* global URL, console, process */
// Runs `npm audit` and fails on any advisory not listed in ../audit-allowlist.json.
// Allowlist entries also fail once their reviewBy date passes, forcing a re-review.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const allow = JSON.parse(readFileSync(new URL("../audit-allowlist.json", import.meta.url), "utf8")).advisories;
const today = new Date().toISOString().slice(0, 10);
const expired = allow.filter((a) => a.reviewBy < today);
let report;
try {
  report = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
} catch (error) {
  report = error.stdout;
}
const vulnerabilities = JSON.parse(report).vulnerabilities ?? {};
const ids = new Set();
for (const vulnerability of Object.values(vulnerabilities)) {
  for (const via of vulnerability.via) {
    if (typeof via === "object") ids.add(via.url.split("/").pop());
  }
}
const allowed = new Set(allow.map((a) => a.id));
const unexpected = [...ids].filter((id) => !allowed.has(id));
for (const a of expired) console.error(`Audit allowlist entry ${a.id} passed its reviewBy date (${a.reviewBy}); re-review it.`);
if (unexpected.length) console.error(`Unallowlisted advisories: ${unexpected.join(", ")}. Run npm audit for details.`);
if (expired.length || unexpected.length) process.exit(1);
console.log(`npm audit: no advisories beyond the reviewed allowlist (${[...ids].join(", ") || "none"}).`);
