import type { AppConfig } from "../config";
import type { MediaRepository } from "../db/mediaRepository";
import type { PlexClient } from "../integrations/plexClient";
import type { SeerrClient } from "../integrations/seerrClient";
import { safeErrorMessage } from "../security/redact";

export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private nextRunAt: string | undefined;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MediaRepository,
    private readonly plexClient: PlexClient,
    private readonly seerrClient: SeerrClient
  ) {}

  start() {
    this.stop();
    if (this.config.sync.intervalMinutes <= 0) return;
    const intervalMs = this.config.sync.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  status() {
    return {
      enabled: Boolean(this.timer),
      intervalMinutes: this.config.sync.intervalMinutes,
      syncSeerr: this.config.sync.syncSeerr,
      nextRunAt: this.nextRunAt,
      running: this.running,
      history: this.repository.syncHistory()
    };
  }

  async runOnce() {
    if (this.running) return { ok: false, skipped: "sync already running", history: this.repository.syncHistory() };
    this.running = true;
    let plexCount = 0;
    let plexUnavailableCount = 0;
    try {
      try {
        const plexRecords = await this.plexClient.syncLibrary();
        const plexIds = this.repository.upsertMany(plexRecords);
        plexUnavailableCount = this.repository.markPlexUnavailableExcept(plexIds);
        this.repository.recordSync("library", this.config.fixtureMode ? "fixture" : "plex", "ok", plexRecords.length);
        plexCount = plexRecords.length;
      } catch (error) {
        const message = safeErrorMessage(error, this.config.knownSecrets);
        this.repository.recordSync("library", this.config.fixtureMode ? "fixture" : "plex", "error", 0, message);
        return { ok: false, error: message, plexItems: 0, seerrItems: 0 };
      }

      let seerrCount = 0;
      if (this.config.sync.syncSeerr) {
        try {
          const seerrRecords = await this.seerrClient.syncRequests();
          this.repository.upsertMany(seerrRecords);
          this.repository.recordSync("seerr", this.config.fixtureMode ? "fixture" : "seerr", "ok", seerrRecords.length);
          seerrCount = seerrRecords.length;
        } catch (error) {
          const message = safeErrorMessage(error, this.config.knownSecrets);
          this.repository.recordSync("seerr", this.config.fixtureMode ? "fixture" : "seerr", "error", 0, message);
          return { ok: false, error: message, plexItems: plexCount, seerrItems: 0 };
        }
      }

      this.bumpNextRun();
      return { ok: true, plexItems: plexCount, seerrItems: seerrCount, plexUnavailable: plexUnavailableCount };
    } catch (error) {
      const message = safeErrorMessage(error, this.config.knownSecrets);
      return { ok: false, error: message };
    } finally {
      this.running = false;
    }
  }

  restart() {
    this.start();
  }

  private bumpNextRun() {
    if (this.config.sync.intervalMinutes > 0) {
      this.nextRunAt = new Date(Date.now() + this.config.sync.intervalMinutes * 60 * 1000).toISOString();
    }
  }
}
