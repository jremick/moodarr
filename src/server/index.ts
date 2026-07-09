import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down Moodarr");
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error, "Moodarr shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.apiPort, host: config.apiHost });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
