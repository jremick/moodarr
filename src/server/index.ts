import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = createApp({ config });

try {
  await app.listen({ port: config.apiPort, host: config.apiHost });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
