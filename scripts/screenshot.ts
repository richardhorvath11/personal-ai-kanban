// node scripts/screenshot.ts <boardUrl> <out.png> [view: board|next|attention|detail:T-1]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [url, out, view = 'board'] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node scripts/screenshot.ts <url> <out.png> [board|next|attention|detail:T-n]'); process.exit(1); }
const exe = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const br = await chromium.launch({ executablePath: exe, headless: true, args: ['--no-sandbox'] });
try {
  const page = await br.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(url);
  await page.locator('.board, .empty').first().waitFor();
  if (view === 'next') { await page.keyboard.press('2'); await page.getByRole('heading', { name: 'What should I pick up next?' }).waitFor(); }
  if (view === 'attention') { await page.keyboard.press('3'); await page.getByRole('heading', { name: 'Needs your attention' }).waitFor(); }
  if (view.startsWith('detail:')) { await page.locator(`[data-task-id="${view.slice(7)}"]`).click(); await page.locator('.detail .activity').waitFor(); }
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  console.log(`saved ${out}`);
} finally { await br.close(); }
