// Renders scripts/og-image.html to public/og.png (1200x630).
// Run from the repo root: node scripts/generate-og-image.mjs

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const html = fileURLToPath(new URL('./og-image.html', import.meta.url));
const out = fileURLToPath(new URL('../public/og.png', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`file://${html}`);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
