import { AppBridge, PostMessageTransport, type McpUiHostContext, type McpUiMessageRequest } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { cards, defaultToolResult, type HostCard } from "./fixtures";

export type CapturedCall = { name: string; arguments: Record<string, unknown> };
type ToolBehavior = { mode: "return" | "hold" | "throw"; result?: CallToolResult };
type PendingCall = { name: string; resolve: (result: CallToolResult) => void; reject: (error: Error) => void; fallback: CallToolResult };
type HostSnapshot = { initialized: number; calls: CapturedCall[]; messages: McpUiMessageRequest["params"][]; lifecycle: string[]; protocolMethods: string[]; pending: number; errors: string[] };

const query = new URLSearchParams(location.search);
const scenario = query.get("scenario") ?? "search";
const theme = query.get("theme") === "dark" ? "dark" : "light";
const toolsEnabled = query.get("tools") !== "off";
const messagesEnabled = query.get("messages") !== "off";
const requestedWidth = Number(query.get("width"));
const fixtureWidth = requestedWidth > 0 && requestedWidth <= 2000 ? requestedWidth : Math.min(innerWidth, 760);
const snapshot: HostSnapshot = { initialized: 0, calls: [], messages: [], lifecycle: [], protocolMethods: [], pending: 0, errors: [] };
const behaviors = new Map<string, ToolBehavior>();
const pending: PendingCall[] = [];
let bridge: AppBridge;
let iframe: HTMLIFrameElement;
let sequence = 0;
let currentCard = cards[scenario]?.() ?? cards.search!();
const reviewFiles: Record<string, string> = { "review-search": "/.artifacts/review-search.json", "review-detail": "/.artifacts/review-detail.json" };
if (reviewFiles[scenario]) {
  const response = await fetch(reviewFiles[scenario]);
  if (!response.ok) throw new Error("Prepare the review fixtures with the visual E2E suite first.");
  currentCard = await response.json() as HostCard;
}
document.body.dataset.theme = theme;
if (requestedWidth > 0 && requestedWidth <= 2000) {
  const surface = document.querySelector("main")!;
  surface.style.width = `${fixtureWidth}px`;
  surface.style.maxWidth = "none";
}

function context(card: HostCard): McpUiHostContext {
  return {
    theme, displayMode: "inline", availableDisplayModes: ["inline"], locale: "en-AU", timeZone: "Australia/Melbourne",
    platform: fixtureWidth < 600 ? "mobile" : "desktop", containerDimensions: { maxWidth: fixtureWidth },
    ...(query.get("toolInfo") !== "off" ? { toolInfo: { id: `fixture-tool-${++sequence}`, tool: { name: card.tool, inputSchema: { type: "object" as const } } } } : {})
  };
}

window.addEventListener("message", (event) => {
  if (event.source === iframe?.contentWindow && event.data && typeof event.data.method === "string") {
    snapshot.protocolMethods.push(event.data.method);
  }
});

async function deliver(card: HostCard) {
  currentCard = card;
  bridge.setHostContext(context(card));
  await bridge.sendToolInput({ arguments: card.args });
  await bridge.sendToolResult(card.result);
}

async function mount(sendInitial = true) {
  iframe = document.createElement("iframe");
  iframe.id = "app";
  iframe.title = "Moodarr tool card";
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  document.getElementById("frame-container")!.replaceChildren(iframe);
  bridge = new AppBridge(null, { name: "Moodarr local verification host", version: "1.0.0" }, {
    ...(toolsEnabled ? { serverTools: {} } : {}), ...(messagesEnabled ? { message: { text: {} } } : {}), logging: {}
  }, { hostContext: context(currentCard) });
  bridge.onerror = (error) => snapshot.errors.push(error.message);
  bridge.oninitialized = () => {
    snapshot.initialized++;
    snapshot.lifecycle.push("initialized");
    if (sendInitial) void (async () => {
      await bridge.sendToolInput({ arguments: currentCard.args });
      await bridge.sendToolResult(currentCard.result);
    })().catch((error: unknown) => snapshot.errors.push(String(error)));
  };
  bridge.onmessage = async (params) => { snapshot.messages.push(structuredClone(params)); return {}; };
  bridge.oncalltool = async ({ name, arguments: args = {} }) => {
    snapshot.calls.push({ name, arguments: structuredClone(args) });
    const behavior = behaviors.get(name);
    const fallback = behavior?.result ?? defaultToolResult(name, args);
    if (behavior?.mode === "throw") throw new Error("Synthetic host transport failure after tool dispatch.");
    if (behavior?.mode === "hold") {
      snapshot.pending++;
      return await new Promise<CallToolResult>((resolve, reject) => pending.push({ name, resolve, reject, fallback }));
    }
    return fallback;
  };
  bridge.onsizechange = ({ height }) => { if (height && Number.isFinite(height)) iframe.style.height = `${Math.max(120, Math.min(height, 5000))}px`; };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  if (query.get("entry") === "source") iframe.src = "/index.html";
  else {
    const artifact = await import("../dist/index.html?raw");
    // Host policy for the self-contained resource; does not alter app source or JS.
    const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
    iframe.srcdoc = query.get("csp") === "default"
      ? artifact.default.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
      : artifact.default;
  }
}

export const localHost = {
  snapshot: () => structuredClone(snapshot),
  setBehavior: (name: string, behavior: ToolBehavior) => behaviors.set(name, behavior),
  deliver,
  deliverScenario: (name: string) => deliver(cards[name]!()),
  release: (name: string, result?: CallToolResult) => {
    const index = pending.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Error(`No held ${name} call.`);
    const call = pending.splice(index, 1)[0]!;
    snapshot.pending--;
    call.resolve(result ?? call.fallback);
  },
  reject: (name: string) => {
    const index = pending.findIndex((entry) => entry.name === name);
    if (index < 0) throw new Error(`No held ${name} call.`);
    const call = pending.splice(index, 1)[0]!;
    snapshot.pending--;
    call.reject(new Error("Synthetic transport failure after dispatch."));
  },
  changeContext: (changes: McpUiHostContext) => bridge.setHostContext(changes),
  cancel: () => bridge.sendToolCancelled({ reason: "Local fixture cancellation" }),
  close: async () => { await bridge.close(); snapshot.lifecycle.push("host-closed"); },
  teardown: async (keepFrame = false) => { await bridge.teardownResource({}, { timeout: 2000 }); snapshot.lifecycle.push("teardown-acknowledged"); await bridge.close(); if (!keepFrame) iframe.remove(); },
  remount: () => mount(true)
};

declare global { interface Window { localHost: typeof localHost } }
window.localHost = localHost;
await mount(query.get("initial") !== "none");
