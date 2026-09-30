import { test, expect, type Page, type FrameLocator, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { failure, movie, previewData, result, searchData, tv } from "./fixtures";
import type { CapturedCall, localHost } from "./host";

type Snapshot = ReturnType<typeof localHost.snapshot>;
const app = (page: Page): FrameLocator => page.frameLocator("#app");
const snapshot = (page: Page): Promise<Snapshot> => page.evaluate(() => window.localHost.snapshot());
const calls = async (page: Page, name: string): Promise<CapturedCall[]> => (await snapshot(page)).calls.filter((call) => call.name === name);

async function open(page: Page, scenario = "search", extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ scenario, ...(process.env.MOODARR_UI_TEST_SOURCE === "1" ? { entry: "source" } : {}), ...extra });
  await page.goto(`/tests/host.html?${query}`);
  await expect.poll(async () => (await snapshot(page)).initialized).toBe(1);
  await expect.poll(async () => (await snapshot(page)).errors).toEqual([]);
}

async function hold(page: Page, name: string) {
  await page.evaluate((tool) => window.localHost.setBehavior(tool, { mode: "hold" }), name);
}

async function confirm(page: Page) {
  await app(page).getByRole("checkbox", { name: /I confirm/ }).check();
  await app(page).getByRole("button", { name: "Confirm request", exact: true }).click();
}

async function capture(page: Page, info: TestInfo) {
  if (page.isClosed()) return;
  try {
    const state = await snapshot(page);
    await info.attach("sdk-host-call-trace", { body: JSON.stringify(state, (key, value: unknown) => key === "previewHandle" && typeof value === "string"
      ? { redacted: true, sha256: createHash("sha256").update(value).digest("hex") } : value, 2), contentType: "application/json" });
  } catch { /* A failed navigation has its own Playwright trace. */ }
}

test.afterEach(async ({ page }, info) => capture(page, info));

test("production bundle initializes through SDK and waits when host data is approval gated", async ({ page }) => {
  await open(page, "search", { initial: "none" });
  await expect(app(page).getByText(/waiting|awaiting/i).first()).toBeVisible();
  await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toHaveCount(0);
  expect((await snapshot(page)).calls).toEqual([]);
  expect((await snapshot(page)).protocolMethods).toEqual(expect.arrayContaining(["ui/initialize", "ui/notifications/initialized"]));
  await page.evaluate(() => window.localHost.deliverScenario("search"));
  await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toBeVisible();
});

for (const scenario of ["search", "preview"]) {
  test(`optional host toolInfo can be absent for a valid ${scenario} result`, async ({ page }) => {
    await open(page, scenario, { toolInfo: "off", initial: "none" });
    await expect(app(page).getByText(/waiting|awaiting/i).first()).toBeVisible();
    expect((await snapshot(page)).calls).toEqual([]);
    await page.evaluate((name) => window.localHost.deliverScenario(name), scenario);
    await expect(scenario === "search" ? app(page).getByRole("heading", { name: "Chef", exact: true }) : app(page).getByRole("definition").filter({ hasText: /^Detectorists$/ })).toBeVisible();
    expect((await snapshot(page)).calls).toEqual([]);
  });
}

test("absent toolInfo and unmatched TV input fails closed", async ({ page }) => {
  await open(page, "preview", { toolInfo: "off", initial: "none" });
  await page.evaluate((card) => window.localHost.deliver(card), { tool: "moodarr_preview_request", args: { itemId: tv.id, seasons: [2] }, result: result(previewData()) });
  await expect(app(page).getByText(/unsupported|invalid|could not.*read/i).first()).toBeVisible();
  await expect(app(page).getByRole("button", { name: "Confirm request", exact: true })).toHaveCount(0);
  expect((await snapshot(page)).calls).toEqual([]);
});

for (const presentation of [{ name: "desktop", width: 1080, theme: "light" }, { name: "mobile390", width: 390, theme: "light" }, { name: "dark", width: 1080, theme: "dark" }]) {
  test(`shortlist is readable with intentional artwork fallback: ${presentation.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: presentation.width, height: 900 });
    await open(page, "search", { theme: presentation.theme });
    await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toBeVisible();
    await expect(app(page).getByRole("heading", { name: "Detectorists", exact: true })).toBeVisible();
    await expect(app(page).getByRole("button", { name: /View Chef/ })).toBeVisible();
    await expect(app(page).getByRole("img")).toHaveCount(0);
    await expect(app(page).locator("input, textarea")).toHaveCount(0);
    const size = await app(page).locator("html").evaluate((html) => ({ width: html.scrollWidth, viewport: html.clientWidth, theme: html.dataset.theme }));
    expect(size.width).toBeLessThanOrEqual(size.viewport + 1);
    expect(size.theme).toBe(presentation.theme);
    await page.locator("#app").screenshot({ path: info.outputPath(`${presentation.name}.png`) });
    await info.attach(`${presentation.name}-render`, { path: info.outputPath(`${presentation.name}.png`), contentType: "image/png" });
  });
}

test("mobile dense shortlist keeps eight long titles readable without horizontal overflow", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await open(page);
  const results = Array.from({ length: 8 }, (_, index) => ({ ...movie, id: `fixture:long-${index}`, title: `The Extraordinary Adventures of a Quiet Evening and the Friends Who Made It Memorable ${index + 1}`,
    matchExplanation: "An unhurried story about friendship, discovery and a hopeful fresh start. Long catalog descriptions should wrap naturally without taking the actions off screen." }));
  await page.evaluate((card) => window.localHost.deliver(card), { tool: "moodarr_search", args: { query: searchData.query, resultLimit: 8 }, result: result({ ...searchData, summary: "A longer shortlist for a quiet evening with warm company and eight different paths through the same mood.", results }) });
  await expect(app(page).getByRole("button", { name: /View The Extraordinary/ })).toHaveCount(8);
  const width = await app(page).locator("html").evaluate((html) => ({ content: html.scrollWidth, viewport: html.clientWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  for (const title of results) await expect(app(page).getByRole("heading", { name: title.title, exact: true })).toBeVisible();
  await page.locator("#app").screenshot({ path: info.outputPath("mobile390-eight-long-titles.png") });
  await info.attach("mobile390-density-render", { path: info.outputPath("mobile390-eight-long-titles.png"), contentType: "image/png" });
});

test("title navigation uses a host conversation message and preserves the shortlist", async ({ page }) => {
  await open(page);
  await app(page).getByRole("button", { name: /View Chef/ }).click();
  await expect.poll(async () => (await snapshot(page)).messages.length).toBe(1);
  const message = (await snapshot(page)).messages[0]!;
  expect(message.role).toBe("user");
  expect(JSON.stringify(message.content)).toContain("moodarr_get_item");
  expect(JSON.stringify(message.content)).toContain(movie.id);
  expect((await snapshot(page)).calls).toEqual([]);
  await expect(app(page).getByRole("heading", { name: "Detectorists", exact: true })).toBeVisible();
});

test("TV preview navigation includes exactly selected seasons in the host message", async ({ page }) => {
  await open(page, "tv");
  await app(page).getByRole("textbox", { name: /Selected seasons/ }).fill("3, 1, 3");
  await app(page).getByRole("button", { name: "Preview request", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).messages.length).toBe(1);
  const content = JSON.stringify((await snapshot(page)).messages[0]!.content);
  expect(content).toContain("moodarr_preview_request");
  expect(content).toContain(tv.id);
  expect(content.replaceAll("\\\"", '"')).toMatch(/\[1,\s*3\]/);
  expect((await snapshot(page)).calls).toEqual([]);
  await expect(app(page).getByRole("heading", { name: "Detectorists", exact: true })).toBeVisible();
});

test("feedback waits for acknowledgment, submits once with the displayed session, and offers no undo", async ({ page }) => {
  await open(page);
  await hold(page, "moodarr_record_feedback");
  const button = app(page).getByRole("button", { name: /^More like this:/ }).first();
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(async () => (await calls(page, "moodarr_record_feedback")).length).toBe(1);
  const [call] = await calls(page, "moodarr_record_feedback");
  expect(call!.arguments).toMatchObject({ action: "more_like", itemId: movie.id, sessionId: "recommendation:fixture-42", watchContext: "solo" });
  expect(call!.arguments.clientEventId).toEqual(expect.any(String));
  await expect(app(page).getByText(/feedback recorded|preference recorded|saved/i)).toHaveCount(0);
  await page.evaluate(() => window.localHost.release("moodarr_record_feedback"));
  await expect(app(page).getByText(/feedback recorded|preference recorded|saved/i).first()).toBeVisible();
  await expect(app(page).getByRole("button", { name: /undo/i })).toHaveCount(0);
  expect((await calls(page, "moodarr_record_feedback")).length).toBe(1);
});

test("feedback is unavailable without a recommendation session", async ({ page }) => {
  await open(page);
  const noSession: Record<string, unknown> = { ...searchData };
  delete noSession.sessionId;
  await page.evaluate((card) => window.localHost.deliver(card), { tool: "moodarr_search", args: { query: searchData.query, resultLimit: 8 }, result: result(noSession) });
  const controls = app(page).getByRole("button", { name: /More like this|Less like this/ });
  await expect(controls).toHaveCount(0);
  await expect(app(page).getByText("Feedback needs a recommendation session. Ask ChatGPT for a fresh shortlist.", { exact: true })).toBeVisible();
  expect((await snapshot(page)).calls).toEqual([]);
});

test("a second feedback action while one is pending stays undispatched and remains usable", async ({ page }) => {
  await open(page);
  await hold(page, "moodarr_record_feedback");
  await app(page).getByRole("button", { name: /^More like this:/ }).first().click();
  await expect.poll(async () => (await calls(page, "moodarr_record_feedback")).length).toBe(1);
  const second = app(page).getByRole("button", { name: /^More like this:/ }).nth(1);
  await second.evaluate((element: HTMLButtonElement) => element.click());
  expect((await calls(page, "moodarr_record_feedback")).length).toBe(1);
  await expect(app(page).getByText(/outcome unconfirmed/i)).toHaveCount(0);
  await page.evaluate(() => window.localHost.release("moodarr_record_feedback"));
  await expect(second).toBeEnabled();
  await second.click();
  await expect.poll(async () => (await calls(page, "moodarr_record_feedback")).length).toBe(2);
  expect((await calls(page, "moodarr_record_feedback"))[1]!.arguments.itemId).toBe(tv.id);
  await page.evaluate(() => window.localHost.release("moodarr_record_feedback"));
});

test("watchlist waits for a matching receipt and rapid clicks make one call", async ({ page }) => {
  await open(page, "item");
  await hold(page, "moodarr_add_to_watchlist");
  await app(page).getByRole("button", { name: /Add to Plex Watchlist/i }).evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(async () => (await calls(page, "moodarr_add_to_watchlist")).length).toBe(1);
  expect((await calls(page, "moodarr_add_to_watchlist"))[0]!.arguments).toEqual({ itemId: movie.id });
  await expect(app(page).getByText(/added to.*watchlist/i)).toHaveCount(0);
  await page.evaluate(() => window.localHost.release("moodarr_add_to_watchlist"));
  await expect(app(page).getByText(/added to.*watchlist/i).first()).toBeVisible();
});

test("exact TV preview requires explicit confirmation and preserves one create identity", async ({ page }) => {
  await open(page, "preview");
  await expect(app(page).getByRole("definition").filter({ hasText: /^Detectorists$/ })).toBeVisible();
  await expect(app(page).getByText(/seasons.*1.*3/i).first()).toBeVisible();
  await expect(app(page).getByText(/availability.*not.*checked|not.*checked.*availability/i).first()).toBeVisible();
  const create = app(page).getByRole("button", { name: "Confirm request", exact: true });
  await expect(create).toBeDisabled();
  await hold(page, "moodarr_create_request");
  await app(page).getByRole("checkbox", { name: /I confirm/ }).check();
  await create.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
  const [call] = await calls(page, "moodarr_create_request");
  expect(call!.arguments).toEqual({ previewHandle: "fixture-preview-handle.bound-to-detectorists-seasons-1-3", confirmed: true, idempotencyKey: expect.any(String) });
  expect(String(call!.arguments.idempotencyKey)).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,119}$/);
  await page.evaluate(() => window.localHost.release("moodarr_create_request"));
  await expect(app(page).getByText(/request created|request sent/i).first()).toBeVisible();
  await expect(app(page).getByText(/downloaded|ready to play/i)).toHaveCount(0);
});

for (const presentation of [{ name: "preview-mobile390", width: 390, theme: "light" }, { name: "preview-dark", width: 1080, theme: "dark" }]) {
  test(`confirmation preview stays readable: ${presentation.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width: presentation.width, height: 900 });
    await open(page, "preview", { theme: presentation.theme });
    await expect(app(page).getByRole("checkbox", { name: /I confirm.*Detectorists/i })).toBeVisible();
    await expect(app(page).getByRole("button", { name: "Confirm request", exact: true })).toBeVisible();
    const width = await app(page).locator("html").evaluate((html) => ({ content: html.scrollWidth, viewport: html.clientWidth }));
    expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
    await page.locator("#app").screenshot({ path: info.outputPath(`${presentation.name}.png`) });
    await info.attach(`${presentation.name}-render`, { path: info.outputPath(`${presentation.name}.png`), contentType: "image/png" });
  });
}

test("request identity stays stable after remounting the exact same preview", async ({ page }) => {
  await open(page, "preview");
  await confirm(page);
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
  const first = (await calls(page, "moodarr_create_request"))[0]!;
  await page.evaluate(async () => { await window.localHost.close(); await window.localHost.remount(); });
  await expect.poll(async () => (await snapshot(page)).initialized).toBe(2);
  await confirm(page);
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(2);
  expect((await calls(page, "moodarr_create_request"))[1]!.arguments).toEqual(first.arguments);
});

for (const scenario of ["expired", "blocked"]) {
  test(`${scenario} preview cannot create a request`, async ({ page }) => {
    await open(page, scenario);
    await expect(app(page).getByText(new RegExp(scenario === "expired" ? "expir" : "cannot request", "i")).first()).toBeVisible();
    for (const button of await app(page).getByRole("button", { name: "Confirm request", exact: true }).all()) await expect(button).toBeDisabled();
    expect((await snapshot(page)).calls).toEqual([]);
  });
}

test("cancelled preview has no mutation and cannot later be confirmed", async ({ page }) => {
  await open(page, "preview");
  await app(page).getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(app(page).getByText(/cancelled|canceled/i).first()).toBeVisible();
  for (const button of await app(page).getByRole("button", { name: "Confirm request", exact: true }).all()) await expect(button).toBeDisabled();
  expect((await snapshot(page)).calls).toEqual([]);
});

for (const outcome of ["uncertain", "transport", "malformed", "wrong-target"]) {
  test(`create ${outcome} outcome blocks resend and invented status recovery`, async ({ page }) => {
    await open(page, "preview");
    if (outcome === "transport") await page.evaluate(() => window.localHost.setBehavior("moodarr_create_request", { mode: "throw" }));
    else {
      const response = outcome === "uncertain" ? failure("outcome_unconfirmed", "Verify the same attempt before retrying.", true)
        : outcome === "malformed" ? result({ status: "created", ok: true })
        : result({ status: "created", ok: true, request: { mediaType: "tv", mediaId: 999, title: "Another title", seasons: [2] }, seerr: { status: "pending" }, automaticRetryAllowed: false });
      await page.evaluate((response) => window.localHost.setBehavior("moodarr_create_request", { mode: "return", result: response }), response);
    }
    await confirm(page);
    await expect(app(page).getByText(/outcome unconfirmed|not confirmed|could not confirm/i).first()).toBeVisible();
    await expect(app(page).getByText(/verify.*Moodarr|check.*Moodarr|manual.*verif/i).first()).toBeVisible();
    for (const button of await app(page).getByRole("button", { name: /confirm request|retry|check request status/i }).all()) await expect(button).toBeDisabled();
    expect((await calls(page, "moodarr_create_request")).length).toBe(1);
    expect((await snapshot(page)).calls.every((call) => call.name !== "moodarr_request_status")).toBe(true);
  });
}

test("expiry after dispatch prevents another create and exact late receipt confirms the attempt", async ({ page }) => {
  await page.clock.install();
  await open(page, "preview");
  const expiresAt = new Date(Date.now() + 2000).toISOString();
  await page.evaluate((card) => window.localHost.deliver(card), { tool: "moodarr_preview_request", args: { itemId: tv.id, seasons: [1, 3] }, result: result(previewData(expiresAt)) });
  await hold(page, "moodarr_create_request");
  await confirm(page);
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
  await page.clock.fastForward(3000);
  await expect(app(page).getByText(/sending this request/i).first()).toBeVisible();
  await page.evaluate(() => window.localHost.release("moodarr_create_request"));
  await expect(app(page).getByText(/request created/i).first()).toBeVisible();
  expect((await calls(page, "moodarr_create_request")).length).toBe(1);
});

test("actual SDK mutation timeout blocks resend and never acknowledges a late success", async ({ page }) => {
  await page.clock.install();
  await open(page, "preview");
  await hold(page, "moodarr_create_request");
  await confirm(page);
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
  await page.clock.fastForward(45_100);
  await expect(app(page).getByText(/outcome unconfirmed|not confirmed|could not confirm/i).first()).toBeVisible();
  await page.evaluate(() => window.localHost.release("moodarr_create_request"));
  await expect(app(page).getByText(/request created|request sent/i)).toHaveCount(0);
  expect((await calls(page, "moodarr_create_request")).length).toBe(1);
});

for (const interruption of ["cancel", "teardown", "replacement"]) {
  test(`interrupted dispatched create retains unknown-outcome instruction: ${interruption}`, async ({ page }, info) => {
    await open(page, "preview");
    await hold(page, "moodarr_create_request");
    await confirm(page);
    await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
    if (interruption === "cancel") await page.evaluate(() => window.localHost.cancel());
    else if (interruption === "teardown") await page.evaluate(() => window.localHost.teardown(true));
    else await page.evaluate(() => window.localHost.deliverScenario("preview"));
    await expect(app(page).getByText("Outcome unconfirmed", { exact: true }).first()).toBeVisible();
    await expect(app(page).getByText(/verify.*Moodarr/i).first()).toBeVisible();
    await expect(app(page).getByText(/cancelled before.*sent|canceled before.*sent/i)).toHaveCount(0);
    expect((await calls(page, "moodarr_create_request")).length).toBe(1);
    for (const button of await app(page).getByRole("button", { name: "Confirm request", exact: true }).all()) await expect(button).toBeDisabled();
    if (interruption === "cancel") {
      await page.locator("#app").screenshot({ path: info.outputPath("interrupted-create-unknown-outcome.png") });
      await info.attach("interrupted-create-render", { path: info.outputPath("interrupted-create-unknown-outcome.png"), contentType: "image/png" });
    }
    await page.evaluate(() => window.localHost.release("moodarr_create_request"));
    await expect(app(page).getByText(/request created|request sent/i)).toHaveCount(0);
  });
}

test("dropped host after dispatch reaches actual SDK deadline and blocks resend", async ({ page }) => {
  await page.clock.install();
  await open(page, "preview");
  await hold(page, "moodarr_create_request");
  await confirm(page);
  await expect.poll(async () => (await calls(page, "moodarr_create_request")).length).toBe(1);
  await page.evaluate(() => window.localHost.close());
  await page.clock.fastForward(45_100);
  await expect(app(page).getByText("Outcome unconfirmed", { exact: true }).first()).toBeVisible();
  await expect(app(page).getByText(/verify.*Moodarr/i).first()).toBeVisible();
  expect((await calls(page, "moodarr_create_request")).length).toBe(1);
});

test("native keyboard confirmation and visible focus keep explicit create controllable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "preview");
  const checkbox = app(page).getByRole("checkbox", { name: /I confirm/ });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await page.keyboard.press("Tab");
  const button = app(page).getByRole("button", { name: "Confirm request", exact: true });
  await expect(button).toBeFocused();
  const outline = await button.evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(app(page).getByText("Request created", { exact: true })).toBeVisible();
  expect((await calls(page, "moodarr_create_request")).length).toBe(1);
});

test("host without conversation message capability offers truthful manual navigation", async ({ page }) => {
  await open(page, "tv", { messages: "off" });
  await app(page).getByRole("textbox", { name: "Selected seasons", exact: true }).fill("1, 3");
  await app(page).getByRole("button", { name: "Preview request", exact: true }).click();
  await expect(app(page).getByText(/preview.*Detectorists/i).first()).toBeVisible();
  expect((await snapshot(page)).messages).toEqual([]);
  expect((await snapshot(page)).calls).toEqual([]);
});

test("same preview replay in one card session retains acknowledgment and cannot create again", async ({ page }) => {
  await open(page, "preview");
  await confirm(page);
  await expect(app(page).getByText("Request created", { exact: true })).toBeVisible();
  await page.evaluate(() => window.localHost.deliverScenario("preview"));
  await app(page).locator("body").evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(app(page).getByText("Request created", { exact: true })).toBeVisible();
  await expect(app(page).getByRole("button", { name: "Confirm request", exact: true })).toHaveCount(0);
  expect((await calls(page, "moodarr_create_request")).length).toBe(1);
});

test("late feedback cannot acknowledge a newer recommendation session", async ({ page }) => {
  await open(page);
  await hold(page, "moodarr_record_feedback");
  await app(page).getByRole("button", { name: /^More like this:/ }).first().click();
  await expect.poll(async () => (await calls(page, "moodarr_record_feedback")).length).toBe(1);
  await page.evaluate((card) => window.localHost.deliver(card), { tool: "moodarr_search", args: { query: "New session" }, result: result({ ...searchData, query: "New session", sessionId: "recommendation:new", summary: "New session shortlist.", results: [tv] }) });
  await expect(app(page).getByText("New session shortlist.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.localHost.release("moodarr_record_feedback"));
  await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toHaveCount(0);
  await expect(app(page).getByText(/feedback recorded|preference recorded|saved/i)).toHaveCount(0);
});

for (const error of [{ code: "insufficient_scope", text: "This connection does not grant the required permission." }, { code: "reconnect_required", text: "Reconnect Moodarr to continue." }, { code: "invalid_preview", text: "The preview is invalid or expired. Preview the item again." }]) {
  test(`tool error ${error.code} stays explicit and does not claim success`, async ({ page }) => {
    await open(page, "preview");
    await page.evaluate((response) => window.localHost.setBehavior("moodarr_create_request", { mode: "return", result: response }), failure(error.code, error.text));
    await confirm(page);
    await expect(app(page).getByText(/permission|access|reconnect|preview.*again|expir/i).first()).toBeVisible();
    await expect(app(page).getByText(/request created|request sent/i)).toHaveCount(0);
    expect((await calls(page, "moodarr_create_request")).length).toBe(1);
  });
}

test("malformed host result is unsupported rather than a fabricated shortlist", async ({ page }) => {
  await open(page, "invalid");
  await expect(app(page).getByText(/unsupported|invalid|could not.*read/i).first()).toBeVisible();
  await expect(app(page).getByRole("button", { name: /More like this|Confirm request|Add to Plex/ })).toHaveCount(0);
  expect((await snapshot(page)).calls).toEqual([]);
});

test("untrusted valid title renders as text and envelope metadata never becomes DOM or storage", async ({ page }) => {
  const remoteRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "127.0.0.1" && requestUrl.protocol !== "data:") { remoteRequests.push(requestUrl.href); await route.abort(); }
    else await route.continue();
  });
  await open(page);
  const canary = "SYNTHETIC_SECRET_CANARY_DO_NOT_DISPLAY";
  const maliciousTitle = '<img src="https://unsafe.invalid/poster" onerror="window.fixtureExecuted=true">';
  await page.evaluate((card) => window.localHost.deliver(card), {
    tool: "moodarr_search", args: { query: searchData.query }, result: { ...result({ ...searchData, results: [{ ...movie, title: maliciousTitle }] }), _meta: { token: canary, posterUrl: "https://unsafe.invalid/poster", instanceUrl: "javascript:alert(1)" } }
  });
  await expect(app(page).getByRole("heading", { name: maliciousTitle, exact: true })).toBeVisible();
  await expect(app(page).getByRole("img")).toHaveCount(0);
  await expect(app(page).locator("a[href^='javascript:'], [src*='unsafe.invalid']")).toHaveCount(0);
  expect(await app(page).locator("body").innerText()).not.toContain(canary);
  const storage = await app(page).locator("body").evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, executed: (window as Window & { fixtureExecuted?: boolean }).fixtureExecuted }));
  expect(JSON.stringify(storage)).not.toContain(canary);
  expect(storage.executed).toBeUndefined();
  expect(remoteRequests).toEqual([]);
  expect(JSON.stringify((await snapshot(page)).calls)).not.toContain(canary);
});

test("unknown body URL or credential fields reject the result without exposing values", async ({ page }) => {
  await open(page);
  const canary = "SYNTHETIC_SECRET_CANARY_DO_NOT_DISPLAY";
  await page.evaluate((card) => window.localHost.deliver(card), {
    tool: "moodarr_search", args: { query: searchData.query }, result: result({ ...searchData, token: canary, instanceUrl: "javascript:alert(1)", results: [{ ...movie, posterUrl: "https://unsafe.invalid/poster", credential: canary }] })
  });
  await expect(app(page).getByText(/unsupported|supported result|invalid|could not.*read/i).first()).toBeVisible();
  expect(await app(page).locator("body").innerText()).not.toContain(canary);
  await expect(app(page).locator("a[href^='javascript:'], [src*='unsafe.invalid']")).toHaveCount(0);
  expect((await snapshot(page)).calls).toEqual([]);
});

test("inline-only host without tool capability blocks mutations", async ({ page }) => {
  await open(page, "preview", { tools: "off" });
  await expect(app(page).getByRole("button", { name: "Confirm request", exact: true })).toBeDisabled();
  expect((await snapshot(page)).calls).toEqual([]);
});

test("host context theme changes and teardown acknowledge through SDK lifecycle", async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.localHost.changeContext({ theme: "dark" }));
  await expect(app(page).locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => window.localHost.teardown());
  await expect(page.locator("#app")).toHaveCount(0);
  expect((await snapshot(page)).lifecycle).toContain("teardown-acknowledged");
  await page.evaluate(() => window.localHost.remount());
  await expect.poll(async () => (await snapshot(page)).initialized).toBe(2);
  await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toBeVisible();
  expect((await snapshot(page)).calls).toEqual([]);
});

test("production resource receipt records exact bytes and excludes host fixtures", async ({ page }, info) => {
  expect(page.isClosed()).toBe(false);
  const html = await readFile(new URL("../dist/index.html", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const text = html.toString("utf8");
  const sha256 = createHash("sha256").update(html).digest("hex");
  expect(manifest).toMatchObject({ schemaVersion: 1, mimeType: "text/html;profile=mcp-app", sha256, bytes: html.length, uri: `ui://moodarr/${sha256}/app.html` });
  expect(text).not.toContain("fixture-preview-handle");
  expect(text).not.toContain("recommendation:fixture-42");
  expect(text).not.toContain("localHost");
  expect(text).not.toContain("SYNTHETIC_SECRET_CANARY");
  await info.attach("production-resource-receipt", { body: JSON.stringify({ sha256, bytes: html.length, mimeType: "text/html;profile=mcp-app", manifest, entry: "dist/index.html", evidence: "local SDK host browser verification only" }, null, 2), contentType: "application/json" });
});
