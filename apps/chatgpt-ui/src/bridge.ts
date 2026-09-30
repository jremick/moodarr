import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { ContractFault, isMutation, isToolName, parseToolInput, parseToolResult, uncertainResult,
  type MoodarrResult, type ToolInputMap, type ToolName } from "./contracts";

export type DisplayMode = "inline" | "fullscreen" | "pip";
export interface BridgeSnapshot {
  phase: "idle" | "connecting" | "ready" | "unavailable" | "error" | "closed";
  /** A dispatched write lost its confirmation. Contains no operation identity or data. */
  interruptedMutation: boolean;
  host: {
    theme: "light" | "dark"; locale?: string; displayMode: DisplayMode; availableDisplayModes: DisplayMode[];
    canCallTools: boolean; canOpenLinks: boolean; canSendMessages: boolean; canUpdateModelContext: boolean;
  };
  /** In-memory data only. Never log, serialize, or persist this snapshot. */
  tool: {
    epoch: number; state: "waiting" | "pending" | "complete" | "cancelled" | "error";
    name?: ToolName; input?: ToolInputMap[ToolName]; result?: MoodarrResult;
  };
  error?: string;
}
export interface SelectionContext { itemId: string; title: string; sessionId?: string }
export interface MoodarrBridge {
  connect(): Promise<void>;
  getSnapshot(): BridgeSnapshot;
  subscribe(listener: () => void): () => void;
  callTool<K extends ToolName>(name: K, args: ToolInputMap[K], options?: { signal?: AbortSignal }): Promise<MoodarrResult>;
  requestNavigation<K extends "moodarr_get_item" | "moodarr_preview_request">(name: K, args: ToolInputMap[K]): Promise<boolean>;
  requestDisplayMode(mode: "inline" | "fullscreen"): Promise<boolean>;
  updateSelectionContext(selection: SelectionContext): Promise<boolean>;
  openExternalLink(url: string): Promise<boolean>;
  dispose(): Promise<void>;
}
export class BridgeFault extends Error {
  constructor(public readonly code: "unavailable" | "unsupported" | "cancelled" | "stale_result" | "busy" | "invalid_response", message: string) {
    super(message); this.name = "BridgeFault";
  }
}

const selectionSchema = z.strictObject({
  itemId: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/), title: z.string().min(1).max(300),
  sessionId: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/).optional(),
});
const displayModes: DisplayMode[] = ["inline", "fullscreen", "pip"];
const initialSnapshot = (): BridgeSnapshot => ({ phase: "idle", interruptedMutation: false, host: {
  theme: "light", displayMode: "inline", availableDisplayModes: [],
  canCallTools: false, canOpenLinks: false, canSendMessages: false, canUpdateModelContext: false,
}, tool: { epoch: 0, state: "waiting" } });

/**
 * The host holds authentication. This bridge has no fetch, token, endpoint, or storage path.
 * Only the official SDK owns postMessage and its window-source validation.
 * External links require an explicit deployment-owned HTTPS origin allowlist; the MVP has none.
 */
export function createMoodarrBridge(options: { allowedLinkOrigins?: readonly string[] } = {}): MoodarrBridge {
  let snapshot = initialSnapshot();
  let app: App | undefined;
  let connectPromise: Promise<void> | undefined;
  let originatingIdentity: string | undefined;
  // Optional toolInfo can be absent. This is never published or used to authorize an action.
  let untypedHostInput: unknown;
  let hostMutationPending = false;
  let requestNumber = 0;
  const listeners = new Set<() => void>();
  const latestReads = new Map<ToolName, number>();
  const mutationLocks = new Set<ToolName>();
  const pending = new Set<AbortController>();
  const allowedOrigins = new Set((options.allowedLinkOrigins ?? []).flatMap((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol === "https:" && !url.username && !url.password && url.origin === origin ? [origin] : [];
    } catch { return []; }
  }));
  function publish(next: BridgeSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  function abortPending(): void { for (const controller of pending) controller.abort(); }
  function hasInterruptedMutation(): boolean {
    return snapshot.interruptedMutation || mutationLocks.size > 0 || hostMutationPending;
  }
  function markInterruptedMutation(): void {
    if (!snapshot.interruptedMutation) publish({ ...snapshot, interruptedMutation: true });
  }
  function advanceTool(state: BridgeSnapshot["tool"]["state"] = "waiting"): void {
    const interruptedMutation = hasInterruptedMutation();
    abortPending();
    untypedHostInput = undefined;
    hostMutationPending = false;
    publish({ ...snapshot, interruptedMutation, tool: { epoch: snapshot.tool.epoch + 1, state, name: snapshot.tool.name }, error: undefined });
  }
  function synchronizeHost(): void {
    if (!app || snapshot.phase === "closed") return;
    const context = app.getHostContext();
    const capabilities = app.getHostCapabilities();
    const name = context?.toolInfo?.tool.name;
    const identity = context?.toolInfo?.id === undefined ? undefined : `${typeof context.toolInfo.id}:${context.toolInfo.id}`;
    if (originatingIdentity !== undefined && identity !== undefined && identity !== originatingIdentity) advanceTool();
    originatingIdentity = identity;
    const theme = context?.theme === "dark" ? "dark" : "light";
    const availableDisplayModes = (context?.availableDisplayModes ?? []).filter((mode) => displayModes.includes(mode));
    const mode = context?.displayMode;
    applyDocumentTheme(theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    publish({ ...snapshot, host: {
      theme, locale: context?.locale, displayMode: mode && displayModes.includes(mode) ? mode : "inline", availableDisplayModes,
      canCallTools: Boolean(capabilities?.serverTools), canOpenLinks: Boolean(capabilities?.openLinks),
      canSendMessages: Boolean(capabilities?.message?.text), canUpdateModelContext: Boolean(capabilities?.updateModelContext?.structuredContent),
    }, tool: { ...snapshot.tool, name: context?.toolInfo ? (isToolName(name) ? name : undefined) : snapshot.tool.name } });
  }
  function markContractError(): void {
    const interruptedMutation = hasInterruptedMutation();
    abortPending();
    hostMutationPending = false;
    untypedHostInput = undefined;
    publish({ ...snapshot, interruptedMutation, tool: { epoch: snapshot.tool.epoch, name: snapshot.tool.name, state: "error" },
      error: "Moodarr returned unsupported data. Ask ChatGPT to run the tool again." });
  }
  function requireApp(): App {
    if (!app || snapshot.phase !== "ready") throw new BridgeFault("unavailable", "Open Moodarr through its connected MCP app in ChatGPT.");
    return app;
  }
  function hostInput(input: unknown): void {
    synchronizeHost();
    const originName = app?.getHostContext()?.toolInfo?.tool.name;
    const name = isToolName(originName) ? originName : undefined;
    // Arguments are deliberately absent before approval. Partial inputs never authorize actions.
    if (input === undefined) return;
    advanceTool("pending");
    if (originName !== undefined && !name) { markContractError(); return; }
    if (!name) {
      // Wait for the authoritative result before selecting and validating a contract.
      untypedHostInput = input;
      // Only unambiguous write inputs can establish this without toolInfo; itemId also belongs to reads.
      for (const write of ["moodarr_record_feedback", "moodarr_create_request"] as const) {
        try { parseToolInput(write, input); hostMutationPending = true; break; } catch { /* Other input contract. */ }
      }
      publish({ ...snapshot, tool: { ...snapshot.tool, name: undefined } });
      return;
    }
    try {
      const parsed = parseToolInput(name, input);
      hostMutationPending = isMutation(name);
      publish({ ...snapshot, tool: { ...snapshot.tool, name,
        // A signed handle contains private confirmation fields despite being opaque to this UI.
        input: name === "moodarr_create_request" ? undefined : parsed } });
    } catch { markContractError(); }
  }
  function hostResult(result: unknown): void {
    synchronizeHost();
    if (snapshot.tool.state === "cancelled" || snapshot.tool.state === "error" || snapshot.tool.state === "complete") return;
    const originName = app?.getHostContext()?.toolInfo?.tool.name;
    if (originName !== undefined && !isToolName(originName)) { markContractError(); return; }
    try {
      let parsed = parseToolResult(result, snapshot.tool.name, snapshot.tool.input);
      let name = snapshot.tool.name;
      let input = snapshot.tool.input;
      if (!name && parsed.kind !== "error") {
        const inferred = {
          search: "moodarr_search", item: "moodarr_get_item", stats: "moodarr_library_stats", feedback: "moodarr_record_feedback",
          preview: "moodarr_preview_request", request: "moodarr_create_request", watchlist: "moodarr_add_to_watchlist",
        } as const;
        name = inferred[parsed.kind];
        if (parsed.kind === "preview" && typeof untypedHostInput === "object" && untypedHostInput !== null
          && Object.hasOwn(untypedHostInput, "previewHandle")) name = "moodarr_create_request";
        if (untypedHostInput !== undefined) {
          input = parseToolInput(name, untypedHostInput);
          parsed = parseToolResult(result, name, input);
        }
      }
      const interruptedMutation = snapshot.interruptedMutation || (hostMutationPending && parsed.kind === "error" && parsed.data.status === "uncertain");
      untypedHostInput = undefined;
      hostMutationPending = false;
      publish({ ...snapshot, interruptedMutation, tool: { ...snapshot.tool, name, input: name === "moodarr_create_request" ? undefined : input,
        state: "complete", result: parsed }, error: undefined });
    } catch { markContractError(); }
  }
  function hostCancelled(): void {
    advanceTool("cancelled");
  }
  function closeState(): void {
    const interruptedMutation = hasInterruptedMutation();
    abortPending();
    hostMutationPending = false;
    untypedHostInput = undefined;
    publish({ ...initialSnapshot(), phase: "closed", interruptedMutation, tool: { epoch: snapshot.tool.epoch + 1, state: "cancelled" } });
  }

  const bridge: MoodarrBridge = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      if (connectPromise) return connectPromise;
      if (snapshot.phase === "closed") return Promise.resolve();
      if (typeof window === "undefined" || window.parent === window) {
        publish({ ...snapshot, phase: "unavailable", error: "Connect the public HTTPS Moodarr MCP endpoint in ChatGPT, then open a Moodarr result." });
        return Promise.resolve();
      }
      publish({ ...snapshot, phase: "connecting" });
      app = new App({ name: "Moodarr", version: "0.1.0" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: true });
      app.addEventListener("toolinput", ({ arguments: input }) => hostInput(input));
      app.addEventListener("toolresult", hostResult);
      app.addEventListener("toolcancelled", hostCancelled);
      app.addEventListener("hostcontextchanged", () => synchronizeHost());
      app.onteardown = async () => { closeState(); return {}; };
      app.onclose = () => { if (snapshot.phase !== "closed" && snapshot.phase !== "error") closeState(); };
      // Do not relay raw SDK errors: they can contain the rejected envelope or tool arguments.
      app.onerror = () => { if (snapshot.phase === "ready") markContractError(); };
      connectPromise = app.connect(undefined, { timeout: 10_000 }).then(() => {
        if (snapshot.phase === "closed") return;
        synchronizeHost();
        publish({ ...snapshot, phase: "ready" });
      }).catch(async () => {
        if (snapshot.phase === "closed") return;
        publish({ ...initialSnapshot(), phase: "error", interruptedMutation: hasInterruptedMutation(),
          error: "Moodarr could not connect to the host. Reopen the app from ChatGPT." });
        await app?.close();
      });
      return connectPromise;
    },
    async callTool(name, args, callOptions = {}) {
      const hostApp = requireApp();
      if (!snapshot.host.canCallTools) throw new BridgeFault("unsupported", "This host cannot call Moodarr tools from the app.");
      const input = parseToolInput(name, args);
      if (callOptions.signal?.aborted) throw new BridgeFault("cancelled", "The action was cancelled before it began.");
      const mutation = isMutation(name);
      if (mutation && mutationLocks.has(name)) throw new BridgeFault("busy", "This Moodarr action is already pending.");
      const epoch = snapshot.tool.epoch;
      const requestId = ++requestNumber;
      if (mutation) mutationLocks.add(name); else latestReads.set(name, requestId);
      const controller = new AbortController();
      pending.add(controller);
      const relayAbort = () => controller.abort();
      callOptions.signal?.addEventListener("abort", relayAbort, { once: true });
      try {
        const result = await hostApp.callServerTool({ name, arguments: input }, { signal: controller.signal, timeout: mutation ? 45_000 : 30_000 });
        if (snapshot.phase !== "ready" || epoch !== snapshot.tool.epoch || controller.signal.aborted) {
          if (mutation) { markInterruptedMutation(); return uncertainResult("stale_session_outcome"); }
          throw new BridgeFault(controller.signal.aborted ? "cancelled" : "stale_result", "A newer Moodarr interaction replaced this result.");
        }
        if (!mutation && latestReads.get(name) !== requestId) throw new BridgeFault("stale_result", "A newer Moodarr interaction replaced this result.");
        const parsed = parseToolResult(result, name, input);
        if (mutation && parsed.kind === "error" && parsed.data.status === "uncertain") markInterruptedMutation();
        return parsed;
      } catch (error) {
        if (mutation) { markInterruptedMutation(); return uncertainResult(); }
        if (error instanceof BridgeFault) throw error;
        if (controller.signal.aborted) throw new BridgeFault("cancelled", "The Moodarr tool call was cancelled.");
        throw new BridgeFault(error instanceof ContractFault ? "invalid_response" : "unavailable",
          error instanceof ContractFault ? "Moodarr returned unsupported data." : "Moodarr did not return a result. Ask ChatGPT to run the tool again.");
      } finally {
        pending.delete(controller);
        callOptions.signal?.removeEventListener("abort", relayAbort);
        mutationLocks.delete(name);
      }
    },
    async requestNavigation(name, args) {
      if (snapshot.phase !== "ready" || !snapshot.host.canSendMessages || !app) return false;
      // Runtime allowlist also protects callers that bypass TypeScript.
      if (name !== "moodarr_get_item" && name !== "moodarr_preview_request") return false;
      try {
        const input = parseToolInput(name, args);
        const intent = name === "moodarr_get_item"
          ? "Show this Moodarr title in a separate title card."
          : "Preview this exact Moodarr request in a separate confirmation card. Do not create the request.";
        const response = await app.sendMessage({ role: "user", content: [{ type: "text", text: `${intent} Call ${name} with ${JSON.stringify(input)}.` }] }, { timeout: 10_000 });
        return response.isError !== true;
      } catch { return false; }
    },
    async requestDisplayMode(mode) {
      if (snapshot.phase !== "ready" || !app || !snapshot.host.availableDisplayModes.includes(mode)) return false;
      if (mode !== "inline" && mode !== "fullscreen") return false;
      try {
        const response = await app.requestDisplayMode({ mode }, { timeout: 10_000 });
        synchronizeHost();
        return response.mode === mode;
      } catch { return false; }
    },
    async updateSelectionContext(selection) {
      if (snapshot.phase !== "ready" || !snapshot.host.canUpdateModelContext || !app) return false;
      const parsed = selectionSchema.safeParse(selection);
      if (!parsed.success) return false;
      try {
        // Explicit projection excludes handles, credentials, endpoint/account metadata and receipts.
        await app.updateModelContext({ structuredContent: { selectedMoodarrItem: parsed.data } }, { timeout: 10_000 });
        return true;
      } catch { return false; }
    },
    async openExternalLink(value) {
      if (snapshot.phase !== "ready" || !snapshot.host.canOpenLinks || !app) return false;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || !allowedOrigins.has(url.origin)) return false;
        // URL query data is not accepted for this MVP: no credential-bearing deep links.
        if (url.search || url.hash) return false;
        const response = await app.openLink({ url: url.href }, { timeout: 10_000 });
        return response.isError !== true;
      } catch { return false; }
    },
    async dispose() {
      closeState();
      await app?.close();
      listeners.clear();
    },
  };
  return bridge;
}
