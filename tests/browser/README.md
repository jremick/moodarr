# Browser workflow regression

This suite drives the real built client and Fastify routes through a Codex or Comet browser tab. It uses disposable in-memory data, bundled media fixtures, a fixed test-only admin token, and an instrumented fixture Seerr client. Server-side outbound fetches fail. It does not use production credentials, an external Seerr instance, or a paid provider. It is an operator-run browser suite, not a CI browser job.

From the repository root, using Node 24 or later and the locked npm dependencies:

```sh
npm run build:client
node --import tsx scripts/browser-regression-server.ts 14401
```

In a separate terminal, start the independent lost-response scenario:

```sh
node --import tsx scripts/browser-regression-server.ts 14402 --uncertain
```

Using the initialized CUA browser runtime, import the module by its absolute checkout path, create two browser tabs, and run:

```js
const suite = await import("/absolute/checkout/tests/browser/workflows.mjs");
const appTab = await cua.createBrowserTab("iab", "http://127.0.0.1:14401", { visible: false });
const evidenceTab = await cua.createBrowserTab("iab", "http://127.0.0.1:14401/__browser-test/state", { visible: false });
const success = await suite.runWorkflows(appTab, evidenceTab, { baseUrl: "http://127.0.0.1:14401" });
const uncertain = await suite.runWorkflows(appTab, evidenceTab, { baseUrl: "http://127.0.0.1:14402", uncertain: true });
nodeRepl.write({ success, uncertain });
```

Use the browser tool's required first-call initialization separately. Run each scenario against a fresh fixture process; restart the corresponding process before retrying a partial or completed run. The suite deliberately checks exact counters rather than erasing earlier evidence. An imported module may be cached by the browser runtime; reload the runtime or import a fresh local copy after editing it.

The suite verifies saved Admin preferences survive reload; locking returns to the protected Finder; unlock restores access; group feedback remains attached to the displayed group slate after changing pending context; a movie refinement changes the visible slate; previews and cancellation make zero fixture writes; double confirmation makes one write; and retrying an uncertain operation performs reconciliation without resending.

Capture desktop/mobile screenshots and check overflow, keyboard focus, and console errors separately. These fixture checks do not establish real Plex-client launches, live Seerr behavior, AI quality, or public-release eligibility. Stop both fixture processes with SIGINT/SIGTERM after use; they close the database and remove their own temporary settings directories.
