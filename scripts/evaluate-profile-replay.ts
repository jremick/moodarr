import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

const config = loadConfig({
  ...process.env,
  MOODARR_REQUIRE_ADMIN_TOKEN: process.env.MOODARR_REQUIRE_ADMIN_TOKEN ?? "true"
});
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const result = repository.profileReplayEvaluation();

console.log(JSON.stringify(result, null, 2));

if (result.losses > result.wins && result.compared >= 5) {
  process.exitCode = 1;
}
