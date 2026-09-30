// Reproduce a comparison from already-captured PNGs, without revisiting the product.
/* global document, requestAnimationFrame */
import process from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Pass the outside-repository correction/captures directory.');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const name of ['search-dark', 'detail-desktop']) {
    const before = await readFile(resolve(directory, `${name}-reference.png`));
    const after = await readFile(resolve(directory, `${name}-production.png`));
    const width = before.readUInt32BE(16) + after.readUInt32BE(16) + 60;
    const height = Math.max(before.readUInt32BE(20), after.readUInt32BE(20)) + 80;
    const page = await browser.newPage({ viewport: { width, height } });
    const html = `<html><head><style>body{margin:0;padding:20px;background:#eceeed;font:13px system-ui;color:#2f3d3a}main{display:flex;gap:20px;align-items:flex-start}h1{font-size:14px}img{display:block;max-width:none}</style></head><body><main><section><h1>Approved reference</h1><img src="data:image/png;base64,${before.toString('base64')}"></section><section><h1>Production MCP card</h1><img src="data:image/png;base64,${after.toString('base64')}"></section></main></body></html>`;
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: resolve(directory, `${name}-side-by-side.png`) });
    await writeFile(resolve(directory, `${name}-comparison.html`), html);
    await page.close();
    process.stdout.write(`${name}: repaired comparison from existing source PNGs\n`);
  }
} finally { await browser.close(); }
