export interface LatestRequest {
  generation: number;
  signal: AbortSignal;
}

export class LatestRequestLifecycle {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(): LatestRequest {
    this.controller?.abort();
    this.controller = new AbortController();
    this.generation += 1;
    return { generation: this.generation, signal: this.controller.signal };
  }

  isCurrent(generation: number) {
    return generation === this.generation && this.controller?.signal.aborted === false;
  }

  abort() {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
  }
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
