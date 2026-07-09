import type { AppConfig } from "../config";
import type { EmbeddingWarmupStatus } from "../../shared/types";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { MediaRepository } from "../db/mediaRepository";
import type { PlexClient } from "../integrations/plexClient";
import type { SeerrClient } from "../integrations/seerrClient";
import { warmProviderEmbeddings } from "../recommendation/embeddingWarmup";
import { safeErrorMessage } from "../security/redact";

export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private nextRunAt: string | undefined;
  private running = false;
  private started = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MediaRepository,
    private readonly plexClient: PlexClient,
    private readonly seerrClient: SeerrClient,
    private readonly embeddingProviderFactory?: () => EmbeddingProvider
  ) {}

  start() {
    this.stop();
    if (this.config.sync.intervalMinutes <= 0) return;
    this.started = true;
    this.scheduleNextRun();
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
  }

  status() {
    return {
      enabled: this.started,
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

      const providerEmbeddings = await this.warmEmbeddings();
      return { ok: true, plexItems: plexCount, seerrItems: seerrCount, plexUnavailable: plexUnavailableCount, providerEmbeddings };
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

  private scheduleNextRun() {
    if (!this.started || this.config.sync.intervalMinutes <= 0) return;
    const intervalMs = this.config.sync.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      this.nextRunAt = undefined;
      await this.runOnce();
      this.scheduleNextRun();
    }, intervalMs);
    this.timer.unref();
  }

  private async warmEmbeddings(): Promise<EmbeddingWarmupStatus> {
    try {
      return await warmProviderEmbeddings(this.repository, this.embeddingProviderFactory?.());
    } catch (error) {
      return {
        configured: true,
        attempted: 0,
        embedded: 0,
        hasMore: true,
        error: safeErrorMessage(error, this.config.knownSecrets)
      };
    }
  }
}
