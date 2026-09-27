import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { UserRepository, userSessionCookieName } from "../../src/server/auth/userRepository";
import type { SqliteDatabase } from "../../src/server/db/database";

/** HTTP faults for the standalone, disposable browser fixture only. */
export function installBootstrapFixture(app: FastifyInstance, db: SqliteDatabase, webOrigin: string) {
  const users = new UserRepository(db);
  const identity = { providerUserId: "browser-bootstrap", displayName: "Bootstrap original" };
  const user = users.upsertPlexUser(identity, true);
  users.updateUser(user.id, { canRequest: true });
  const session = users.createSession(user.id);
  const counts = { failedReads: 0, heldResponses: 0, releasedResponses: 0, updatedAccounts: 0 };
  let fault: "fail" | "hold" | undefined;
  let phase = "initial";
  let releaseHeld: (() => void) | undefined;
  let signalHeld: () => void;
  const held = new Promise<void>((resolve) => { signalHeld = resolve; });

  app.get("/__browser-test/bootstrap/start", async (_request, reply) => {
    reply.header("Set-Cookie", `${userSessionCookieName}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Strict`);
    return reply.redirect("/admin");
  });
  app.get("/__browser-test/bootstrap/held", async () => {
    await held;
    return { held: counts.heldResponses === 1 };
  });
  app.post<{ Params: { command: string } }>("/__browser-test/bootstrap/:command", async (request, reply) => {
    if (request.headers.origin !== webOrigin) return reply.code(403).send({ error: "Fixture origin required." });
    switch (request.params.command) {
      case "fail":
        if (phase !== "initial") return reply.code(409).send({ error: "Start with a fresh fixture." });
        fault = "fail";
        phase = "failed";
        break;
      case "hold":
        if (counts.failedReads !== 1 || counts.heldResponses !== 0) return reply.code(409).send({ error: "Complete the failed-read scenario first." });
        fault = "hold";
        phase = "holding";
        break;
      case "update":
        if (!releaseHeld || counts.updatedAccounts !== 0) return reply.code(409).send({ error: "Hold the original response first." });
        users.upsertPlexUser({ ...identity, displayName: "Bootstrap current" }, true);
        counts.updatedAccounts += 1;
        phase = "current";
        break;
      case "release":
        if (!releaseHeld || counts.updatedAccounts !== 1) return reply.code(409).send({ error: "Update the held account first." });
        phase = "stale";
        counts.releasedResponses += 1;
        releaseHeld();
        releaseHeld = undefined;
        break;
      default:
        return reply.code(400).send({ error: "Unknown bootstrap fixture command." });
    }
    return { ok: true };
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "GET") return;
    if (["/", "/admin"].includes(request.url)) {
      const html = readFileSync("dist/client/index.html", "utf8");
      return reply.type("text/html").send(html.replace("</head>", '<script src="/__browser-test/bootstrap.js"></script></head>'));
    }
    if (request.url === "/api/auth/session" && fault === "fail") {
      fault = undefined;
      counts.failedReads += 1;
      return reply.code(503).send({ error: "Fixture background session read failed." });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url === "/api/auth/session" && fault === "hold") {
      fault = undefined;
      counts.heldResponses += 1;
      // Hold the real serialized route response, before updating the DB user.
      const released = new Promise<void>((resolve) => { releaseHeld = resolve; });
      signalHeld();
      await released;
    }
    if (request.url === "/api/library/stats" && ["failed", "stale"].includes(phase)) {
      reply.header("X-Browser-Test-Bootstrap", phase);
    }
    return payload;
  });
  app.addHook("preClose", async () => {
    releaseHeld?.();
    signalHeld();
  });
  app.get("/__browser-test/bootstrap.js", async (_request, reply) => reply.type("application/javascript").send(`
    // Observe response consumption without changing bodies, errors, or app state.
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      // Bypass the browser cache lock so two identical GETs can overlap while
      // the older response is held. Bodies still come from the real routes.
      const response = await originalFetch(input, { ...init, cache: "no-store" });
      const phase = response.headers.get("X-Browser-Test-Bootstrap");
      if (phase) {
        const read = response.text.bind(response);
        response.text = async () => {
          const text = await read();
          // Let the API continuation and React rendering run before assertions.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            document.getElementById("bootstrap-fixture-receipt").dataset.consumed = phase;
          }));
          return text;
        };
      }
      return response;
    };
    document.addEventListener("DOMContentLoaded", () => {
      const panel = document.createElement("aside");
      panel.setAttribute("aria-label", "Bootstrap fixture controls");
      panel.style.cssText = "position:fixed;bottom:0;right:0;z-index:10000;background:white;color:black;padding:8px;font:12px monospace";
      const receipt = document.createElement("output");
      receipt.id = "bootstrap-fixture-receipt";
      receipt.textContent = "Bootstrap fixture ready.";
      const actions = [
        ["fail", "Fail background session read"],
        ["hold", "Hold older session response"],
        ["update", "Update fixture account"],
        ["release", "Release older session response"]
      ];
      for (const [command, label] of actions) {
        const button = document.createElement("button");
        button.textContent = label;
        button.addEventListener("click", async () => {
          try {
            const response = await originalFetch("/__browser-test/bootstrap/" + command, { method: "POST" });
            if (!response.ok) throw new Error(await response.text());
            if (command === "fail" || command === "hold") window.dispatchEvent(new Event("focus"));
            if (command === "hold") {
              const response = await originalFetch("/__browser-test/bootstrap/held");
              if (!(await response.json()).held) throw new Error("Original response was not held.");
              receipt.textContent = "Older session response held.";
            } else if (command === "update") receipt.textContent = "Fixture account updated.";
          } catch (error) { receipt.textContent = "Fixture failed: " + error.message; }
        });
        panel.append(button);
      }
      panel.append(receipt);
      document.body.append(panel);
    });
  `));
  return counts;
}
