// Run with a Codex/Comet tab and its documented Playwright locator interface.
// No browser dependency or live integration credentials are needed.
import assert from "node:assert/strict";
import { URL } from "node:url";

export async function runWorkflows(tab, observer, { baseUrl, uncertain = false }) {
  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1", "Only run against the disposable loopback fixture");
  const p = tab.playwright;
  const visible = (text) => p.getByText(text, { exact: true }).waitFor({ state: "visible" });
  async function state() {
    await observer.goto(`${url.origin}/__browser-test/state`);
    return JSON.parse(await observer.playwright.locator("pre").innerText());
  }
  async function unlock() {
    await tab.goto(`${url.origin}/admin`);
    await p.getByLabel("Admin token", { exact: true }).fill("browser-fixture-admin");
    await p.getByRole("button", { name: "Unlock Admin", exact: true }).click();
    await p.getByRole("heading", { name: "Overview", exact: true }).waitFor({ state: "visible" });
  }
  async function search() {
    await p.getByRole("button", { name: "Open Finder chat" }).click();
    await p.getByRole("textbox", { name: "Finder chat prompt" }).fill("fantasy adventure");
    await p.getByRole("textbox", { name: "Finder chat prompt" }).press("Enter");
    await p.getByRole("article", { name: "Stardust", exact: true }).waitFor({ state: "visible" });
  }

  await tab.goto(`${url.origin}/admin`);
  if (!(await p.getByLabel("Admin token", { exact: true }).isVisible())) {
    await p.getByRole("link", { name: "Access & Users", exact: true }).click();
    await p.getByRole("button", { name: "Lock Admin", exact: true }).click();
  }
  await unlock();
  await p.getByRole("link", { name: "Preferences", exact: true }).click();
  const limitInput = p.getByRole("spinbutton", { name: "Default results Choose between 1 and 200 titles.", exact: true });
  const resultLimit = await limitInput.getAttribute("value") === "12" ? "13" : "12";
  await limitInput.fill(resultLimit);
  await p.getByRole("button", { name: "Save preferences", exact: true }).click();
  await p.getByRole("form", { name: "Preferences", exact: true }).getByText("Settings are up to date.", { exact: true }).waitFor({ state: "visible" });
  await tab.reload();
  assert.equal(await p.getByRole("spinbutton", { name: "Default results Choose between 1 and 200 titles.", exact: true }).getAttribute("value"), resultLimit);
  await p.getByRole("link", { name: "Access & Users", exact: true }).click();
  await p.getByRole("button", { name: "Lock Admin", exact: true }).click();
  await p.getByRole("heading", { name: "Protected Finder", exact: true }).waitFor({ state: "visible" });
  await unlock();
  await p.getByRole("button", { name: "Open finder", exact: true }).click();
  const filters = p.getByText("Filters and view", { exact: true });
  if (await filters.isVisible()) await filters.click();
  await visible("Together uses a shared profile. Feedback on Together results can change recommendations for everyone using this Moodarr.");
  await p.getByRole("button", { name: "Recommendation context for me", exact: true }).click();
  await search();
  const groupScope = "Feedback on these results updates the shared Together profile for everyone using this Moodarr.";
  await visible(groupScope);
  // Changing the next search must not mislabel or redirect feedback on the existing slate.
  await p.getByRole("button", { name: "Recommendation context together", exact: true }).click();
  await visible(groupScope);
  await p.getByRole("button", { name: "More like Stardust", exact: true }).click();
  await p.locator('button[aria-label="More like Stardust"][aria-pressed="true"]').waitFor({ state: "visible" });
  assert.deepEqual((await state()).feedbackContexts, ["group"]);
  await p.getByRole("combobox", { name: "Type", exact: true }).selectOption("movie");
  await p.getByRole("textbox", { name: "Finder chat prompt" }).press("Enter");
  await visible("Feedback on these results updates the For Me profile.");
  assert.equal(await p.getByRole("article", { name: "Over the Garden Wall", exact: true }).count(), 0);
  assert.deepEqual((await state()).searchContexts, ["group", "solo"]);

  const preview = p.getByRole("button", { name: "Preview Seerr request for The Princess Bride", exact: true });
  await preview.click();
  await p.getByRole("button", { name: "Confirm Request", exact: true }).waitFor({ state: "visible" });
  assert.equal((await state()).upstreamWrites, 0, "Preview must not write upstream");
  await p.getByRole("button", { name: "Cancel Request", exact: true }).click();
  assert.equal((await state()).upstreamWrites, 0, "Cancel must not write upstream");
  await preview.click();
  if (uncertain) {
    await p.getByRole("button", { name: "Confirm Request", exact: true }).click();
    await visible("Seerr did not return a confirmed request outcome. Moodarr will reconcile before any retry and will not resend automatically.");
    await p.getByRole("button", { name: "Confirm Request", exact: true }).click();
    await visible("The earlier Seerr request outcome is uncertain. Moodarr did not resend it; verify in Seerr or retry later to reconcile again.");
  } else {
    await p.getByRole("button", { name: "Confirm Request", exact: true }).dblclick();
    await visible("Request created.");
    assert.equal(await p.getByRole("button", { name: "Confirm Request", exact: true }).count(), 0);
  }
  const result = await state();
  assert.equal(result.upstreamWrites, 1, "Confirmation and retries must produce only one fixture write");
  assert.equal(result.previewCalls, 2);
  assert.ok(result.confirmationCalls >= (uncertain ? 2 : 1));
  return { scenario: uncertain ? "uncertain-retry" : "confirmed-request", passed: true, ...result };
}

// Use a fresh fixture started with --slow-requests to observe pending-state controls.
export async function runTvRequests(tab, observer, { baseUrl, uncertain = false }) {
  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  const p = tab.playwright;
  async function state() {
    await observer.goto(`${url.origin}/__browser-test/state`);
    return JSON.parse(await observer.playwright.locator("pre").innerText());
  }
  await tab.goto(`${url.origin}/admin`);
  if (!(await p.getByLabel("Admin token", { exact: true }).isVisible())) {
    await p.getByRole("link", { name: "Access & Users", exact: true }).click();
    await p.getByRole("button", { name: "Lock Admin", exact: true }).click();
  }
  await tab.goto(`${url.origin}/admin`);
  await p.getByLabel("Admin token", { exact: true }).fill("browser-fixture-admin");
  await p.getByRole("button", { name: "Unlock Admin", exact: true }).click();
  await p.getByRole("button", { name: "Open finder", exact: true }).click();
  const filters = p.getByText("Filters and view", { exact: true });
  if (await filters.isVisible()) await filters.click();
  await p.getByRole("combobox", { name: "Type", exact: true }).selectOption("tv");
  await p.getByRole("button", { name: "Open Finder chat", exact: true }).click();
  await p.getByRole("textbox", { name: "Finder chat prompt", exact: true }).fill("Fawlty Towers");
  await p.getByRole("textbox", { name: "Finder chat prompt", exact: true }).press("Enter");
  const card = p.getByRole("article", { name: "Fawlty Towers", exact: true });
  await card.waitFor({ state: "visible" });
  const seasons = card.getByRole("textbox", { name: "Seasons for Fawlty Towers", exact: true });
  const preview = card.getByRole("button", { name: "Preview Seerr request for Fawlty Towers", exact: true });
  assert.equal(await preview.isEnabled(), false);
  for (const invalid of ["0", "1,,2", "1001"]) {
    await seasons.fill(invalid);
    assert.equal(await seasons.getAttribute("aria-invalid"), "true");
    assert.equal(await preview.isEnabled(), false);
  }
  assert.equal((await state()).previewCalls, 0);
  await seasons.fill("2, 1, 2");
  await preview.click();
  assert.equal(await seasons.isEnabled(), false, "Season edits are locked during preview");
  await card.getByRole("button", { name: "Confirm Request", exact: true }).waitFor({ state: "visible" });
  await card.getByText("Ready to request: Fawlty Towers, seasons 1, 2", { exact: true }).waitFor({ state: "visible" });
  assert.deepEqual((await state()).previewSeasons, [[1, 2]]);
  await seasons.fill("2");
  assert.equal(await card.getByRole("button", { name: "Confirm Request", exact: true }).count(), 0);
  await p.getByText("Seasons changed. Preview the request again before confirming.", { exact: true }).waitFor({ state: "visible" });
  await preview.click();
  await card.getByText("Ready to request: Fawlty Towers, season 2", { exact: true }).waitFor({ state: "visible" });
  await card.getByRole("button", { name: "Cancel Request", exact: true }).click();
  assert.equal((await state()).upstreamWrites, 0);
  await seasons.fill("1, 2");
  await preview.click();
  const confirm = card.getByRole("button", { name: "Confirm Request", exact: true });
  await confirm.waitFor({ state: "visible" });
  if (uncertain) {
    await confirm.click();
    assert.equal(await seasons.isEnabled(), false, "Season edits are locked during creation");
    await p.getByText("Seerr did not return a confirmed request outcome. Moodarr will reconcile before any retry and will not resend automatically.", { exact: true }).waitFor({ state: "visible" });
    await confirm.click();
    await p.getByText("The earlier Seerr request outcome is uncertain. Moodarr did not resend it; verify in Seerr or retry later to reconcile again.", { exact: true }).waitFor({ state: "visible" });
  } else {
    await confirm.dblclick();
    await p.getByText("Request created.", { exact: true }).waitFor({ state: "visible" });
  }
  const result = await state();
  assert.deepEqual(result.previewSeasons, [[1, 2], [2], [1, 2]]);
  assert.deepEqual(result.upstreamRequests, [{ mediaType: "tv", mediaId: 2207, seasons: [1, 2] }]);
  assert.equal(result.upstreamWrites, 1);
  assert.equal(result.confirmationCalls, uncertain ? 2 : 1);
  return { scenario: uncertain ? "tv-uncertain-retry" : "tv-multiseason", passed: true, ...result };
}
