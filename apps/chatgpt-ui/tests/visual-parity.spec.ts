import { test, expect, type Page, type BrowserContext, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadReviewAssets, writeReviewArtifacts, reviewMovies, reviewSearch, reviewDetail, type ReviewAsset } from "./visual-fixtures";
import type { HostCard } from "./fixtures";
import { posterJourneyCard } from "./poster-journey-fixture";
import type {} from "./host";

let assets: ReviewAsset[];
const app = (page: Page) => page.frameLocator("#app");
test.beforeAll(async () => { assets = await loadReviewAssets(); await writeReviewArtifacts(assets); });

async function openCard(page: Page, card: HostCard, theme = "light", width?: number, title = "Chef") {
  const query = new URLSearchParams({ scenario: "search", initial: "none", csp: "default", theme,
    ...(width ? { width: String(width) } : {}) });
  await page.goto(`/tests/host.html?${query}`);
  await expect.poll(() => page.evaluate(() => window.localHost.snapshot().initialized)).toBe(1);
  await page.evaluate((next) => window.localHost.deliver(next), card);
  await expect(app(page).getByRole("heading", { name: title, exact: true })).toBeVisible();
}

async function reference(context: BrowserContext, width: number, theme: string) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 1100 });
  for (const asset of assets) await page.route(asset.source, (route) => route.fulfill({ body: asset.bytes, contentType: "image/jpeg" }));
  await page.goto("http://127.0.0.1:4178/");
  await expect(page.getByRole("button", { name: "View Chef", exact: true })).toBeVisible();
  if (theme === "dark") await page.getByRole("button", { name: "Dark appearance", exact: true }).click();
  await expect.poll(() => page.locator("#widget img").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  return page;
}

async function matchWidth(page: Page, target: number) {
  const card = app(page).locator(".tool-card");
  const actual = (await card.boundingBox())!.width;
  await page.evaluate(({ target, actual }) => {
    const host = document.querySelector("main")!;
    host.style.width = `${host.getBoundingClientRect().width + target - actual}px`;
  }, { target, actual });
  await expect.poll(async () => (await card.boundingBox())!.width).toBeCloseTo(target, 1);
}

async function pair(context: BrowserContext, before: Buffer, after: Buffer, info: TestInfo, name: string) {
  await info.attach(`${name}-reference`, { body: before, contentType: "image/png" });
  await info.attach(`${name}-production`, { body: after, contentType: "image/png" });
  const comparison = await context.newPage();
  const width = before.readUInt32BE(16) + after.readUInt32BE(16) + 60;
  const height = Math.max(before.readUInt32BE(20), after.readUInt32BE(20)) + 80;
  await comparison.setViewportSize({ width, height });
  await comparison.setContent(`<html><head><style>body{margin:0;padding:20px;background:#eceeed;font:13px system-ui;color:#2f3d3a}main{display:flex;gap:20px;align-items:flex-start}h1{font-size:14px}img{display:block;max-width:none}</style></head><body><main><section><h1>Approved reference</h1><img src="data:image/png;base64,${before.toString("base64")}"></section><section><h1>Production MCP card</h1><img src="data:image/png;base64,${after.toString("base64")}"></section></main></body></html>`);
  await comparison.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  await comparison.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  await comparison.screenshot({ path: info.outputPath(`${name}-side-by-side.png`) });
  await info.attach(`${name}-comparison`, { path: info.outputPath(`${name}-side-by-side.png`), contentType: "image/png" });
  await comparison.close();
}

async function receipt(info: TestInfo, extra: Record<string, unknown>) {
  const html = await readFile(new URL("../dist/index.html", import.meta.url));
  await info.attach("visual-proof-receipt", { contentType: "application/json", body: JSON.stringify({
    bundleSha256: createHash("sha256").update(html).digest("hex"), bundleBytes: html.length,
    titles: reviewMovies.map(({ title }) => title), ...extra,
    artwork: assets.map(({ itemId, source, sourceSha256, sha256, bytes }) => ({ itemId, source, sourceSha256, fixtureSha256: sha256, fixtureBytes: bytes.length })),
    limits: "Local reference, synthetic catalog, no real media actions; not live ChatGPT proof."
  }, null, 2) });
}

for (const view of [{ name: "desktop", width: 1080, theme: "light" }, { name: "mobile390", width: 390, theme: "light" }, { name: "dark", width: 1080, theme: "dark" }]) {
  test(`approved three-poster search parity at matching card width: ${view.name}`, async ({ page, context }, info) => {
    await page.setViewportSize({ width: view.width, height: 1100 });
    const original = await reference(context, view.width, view.theme);
    const referenceBox = (await original.locator("#widget").boundingBox())!;
    await openCard(page, reviewSearch(assets), view.theme, referenceBox.width);
    await matchWidth(page, referenceBox.width);
    const images = app(page).locator(".tool-card img");
    await expect(images).toHaveCount(3);
    await expect.poll(() => images.evaluateAll((posters) => posters.every((poster) => (poster as HTMLImageElement).naturalWidth > 0))).toBe(true);
    for (const movie of reviewMovies) {
      const card = app(page).getByRole("article", { name: movie.title, exact: true });
      await expect(card.getByText(movie.reason, { exact: true })).toBeVisible();
      await expect(card.getByText(String(movie.year), { exact: false })).toBeVisible();
      await expect(card.getByText(movie.contentRating, { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: `View ${movie.title}`, exact: true })).toBeVisible();
    }
    const posters = await app(page).locator(".poster").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    for (const poster of posters) expect(poster.width / poster.height).toBeCloseTo(2 / 3, 2);
    if (view.width > 490) {
      expect(posters[1]!.y).toBeCloseTo(posters[0]!.y, 1);
      expect(posters[2]!.y).toBeCloseTo(posters[0]!.y, 1);
      expect(posters[1]!.x - posters[0]!.x - posters[0]!.width).toBeCloseTo(17, 1);
      expect(posters[0]!.x).toBeCloseTo(25, 1); // 24px content padding + border.
    } else {
      for (const poster of posters) expect(poster.width).toBeCloseTo(97, 1);
      expect(posters[1]!.y).toBeGreaterThan(posters[0]!.y + posters[0]!.height);
    }
    const noOverflow = await app(page).locator("html").evaluate((html) => html.scrollWidth <= html.clientWidth + 1);
    expect(noOverflow).toBe(true);
    const before = await original.locator("#widget").screenshot();
    const after = await app(page).locator(".tool-card").screenshot();
    await pair(context, before, after, info, `search-${view.name}`);
    await receipt(info, { theme: view.theme, outerViewport: view.width, referenceWidth: referenceBox.width,
      productionWidth: (await app(page).locator(".tool-card").boundingBox())!.width, posterRectangles: posters, defaultCsp: true });
    await original.close();
  });
}

for (const view of [{ name: "desktop", width: 1080, theme: "light" }, { name: "mobile390", width: 390, theme: "light" }]) {
  test(`rich Chef detail retains approved source content and poster: ${view.name}`, async ({ page, context }, info) => {
    await page.setViewportSize({ width: view.width, height: 1100 });
    const original = await reference(context, view.width, view.theme);
    await original.getByRole("button", { name: "View Chef", exact: true }).click();
    await expect(original.getByRole("dialog")).toBeVisible();
    const referenceBox = (await original.locator("#title-dialog").boundingBox())!;
    await openCard(page, reviewDetail(assets), view.theme, referenceBox.width);
    await matchWidth(page, referenceBox.width);
    await expect(app(page).getByText(reviewMovies[0].summary, { exact: true })).toBeVisible();
    await expect(app(page).getByText(reviewMovies[0].match, { exact: true })).toBeVisible();
    await expect(app(page).getByText(/Jon Favreau/)).toBeVisible();
    await expect(app(page).getByText(/Comedy.*Drama/).first()).toBeVisible();
    await expect(app(page).getByRole("button", { name: "Add to Plex Watchlist", exact: true })).toBeVisible();
    const poster = app(page).locator(".poster").first();
    await expect.poll(() => poster.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    const posterBox = (await poster.boundingBox())!;
    expect(posterBox.width).toBeCloseTo(view.width === 390 ? 95 : 220, 1);
    const before = await original.locator("#title-dialog").screenshot();
    const after = await app(page).locator(".tool-card").screenshot();
    await pair(context, before, after, info, `detail-${view.name}`);
    await receipt(info, { theme: view.theme, outerViewport: view.width, referenceWidth: referenceBox.width,
      productionWidth: (await app(page).locator(".tool-card").boundingBox())!.width, posterWidth: posterBox.width, defaultCsp: true });
    await original.close();
  });
}

for (const invalid of ["missing", "bad-bytes", "unsafe-url", "oversize", "unrelated", "mime-mismatch", "duplicate", "corrupt-raster"]) {
  test(`artwork ${invalid} preserves title, fallback and navigation under default CSP`, async ({ page }, info) => {
    const card = reviewSearch();
    const first = { itemId: reviewMovies[0].id, mimeType: "image/jpeg", data: assets[0]!.bytes.toString("base64") };
    let entries: Record<string, unknown>[] = [];
    if (invalid === "bad-bytes") entries = [{ ...first, data: Buffer.from("not a raster").toString("base64") }];
    else if (invalid === "unsafe-url") entries = [{ ...first, data: "https://user:SYNTHETIC_SECRET_CANARY@unsafe.invalid/poster" }];
    else if (invalid === "oversize") entries = [{ ...first, data: Buffer.alloc(256 * 1024 + 1).toString("base64") }];
    else if (invalid === "unrelated") entries = [{ ...first, itemId: "plex:unrelated" }];
    else if (invalid === "mime-mismatch") entries = [{ ...first, mimeType: "image/png" }];
    else if (invalid === "duplicate") entries = [first, first];
    else if (invalid === "corrupt-raster") entries = [{ ...first, data: Buffer.from("ffd8ffc00011080003000203011100021100031100ffd9", "hex").toString("base64") }];
    if (invalid !== "missing") card.result._meta = { "moodarr/posters": { version: 1, items: entries } };
    const outsideRequests: string[] = [];
    page.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:4188/")) outsideRequests.push(request.url()); });
    await openCard(page, card);
    const chef = app(page).getByRole("article", { name: "Chef", exact: true });
    await expect(chef.locator("img")).toHaveCount(0);
    await expect(chef.getByText("Poster unavailable", { exact: true })).toBeVisible();
    await expect(chef.getByRole("button", { name: "View Chef", exact: true })).toBeVisible();
    await expect(chef.getByText(reviewMovies[0].reason, { exact: true })).toBeVisible();
    expect(await app(page).locator("body").innerText()).not.toContain("SYNTHETIC_SECRET_CANARY");
    await expect(app(page).locator("[src*='unsafe.invalid']")).toHaveCount(0);
    await chef.getByRole("button", { name: "View Chef", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.localHost.snapshot().messages.length)).toBe(1);
    expect(outsideRequests).toEqual([]);
    await info.attach("artwork-fallback-call-trace", { body: JSON.stringify(await page.evaluate(() => window.localHost.snapshot()), null, 2), contentType: "application/json" });
  });
}

test("authenticated poster journey result renders bounded artwork in SDK host", async ({ page }, info) => {
  const { card, source, boundary } = await posterJourneyCard();
  const data = card.result.structuredContent as { results: { id: string; title: string }[] };
  expect(data.results).toHaveLength(5);
  await openCard(page, card, "light", 734, data.results[0]!.title);
  await expect(app(page).locator(".tool-card img")).toHaveCount(3);
  const dimensions = await app(page).locator(".tool-card img").evaluateAll((images) => images.map((image) => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })));
  expect(dimensions).toEqual([{ width: 1, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }]);
  for (const item of data.results.slice(3)) {
    const title = app(page).getByRole("article", { name: item.title, exact: true });
    await expect(title.locator("img")).toHaveCount(0);
    await expect(title.getByText("Poster unavailable", { exact: true })).toBeVisible();
    await expect(title.getByRole("button", { name: `View ${item.title}`, exact: true })).toBeVisible();
  }
  const title = app(page).getByRole("article", { name: data.results[0]!.title, exact: true });
  await title.getByRole("button", { name: `View ${data.results[0]!.title}`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.localHost.snapshot().messages.length)).toBe(1);
  await info.attach("authenticated-poster-browser-receipt", { body: JSON.stringify({ sourceArtifact: source, itemIds: data.results.map(({ id }) => id), imageDimensions: dimensions, defaultCsp: true,
    calls: await page.evaluate(() => window.localHost.snapshot().calls), evidence: boundary }, null, 2), contentType: "application/json" });
});

test("fixed local review URLs show approved artwork without injecting host data", async ({ page }, info) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith("http://127.0.0.1:4188/")) externalRequests.push(request.url()); });
  for (const scenario of ["review-search", "review-detail"]) {
    await page.goto(`/tests/host.html?scenario=${scenario}&width=${scenario === "review-search" ? 734 : 820}&csp=default`);
    await expect(page.getByText("Local preview · synthetic data · no live actions", { exact: true })).toBeVisible();
    await expect(app(page).getByRole("heading", { name: "Chef", exact: true })).toBeVisible();
    await expect(app(page).locator(".tool-card img")).toHaveCount(scenario === "review-search" ? 3 : 1);
    await expect.poll(() => app(page).locator(".tool-card img").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0 && image.getAttribute("src")?.startsWith("data:image/jpeg;base64,")))).toBe(true);
    if (scenario === "review-search") for (const movie of reviewMovies) await expect(app(page).getByRole("heading", { name: movie.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.localHost.snapshot().calls)).toEqual([]);
  }
  expect(externalRequests).toEqual([]);
  await info.attach("fixed-review-preview-receipt", { contentType: "application/json", body: JSON.stringify({ scenarios: ["review-search", "review-detail"], titles: reviewMovies.map(movie => movie.title), externalRequests, toolCalls: [], defaultCsp: true }) });
});
