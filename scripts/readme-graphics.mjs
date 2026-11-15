// Renders the README graphics from docs/graphics/graphics.html into docs/graphics/*.png.
//
//   node scripts/readme-graphics.mjs
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const src = pathToFileURL(resolve('docs/graphics/graphics.html')).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(src, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
for (const id of ['banner', 'acts', 'flow', 'arch', 'agents', 'numbers']) {
  await page.locator(`#${id}`).screenshot({ path: `docs/graphics/${id}.png` });
  console.log('saved', id);
}
await browser.close();
