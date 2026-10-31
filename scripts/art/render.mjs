// Каркасы моделей для рисунков зданий: art/<id>/guide.png, guide-lines.png, guide-clay.png,
// mask.png, frame.json. Запускает Vite и открывает лабораторию в Chromium (Playwright),
// рисует модель тем же кодом, что и карта. Обычно вызывается из scripts/art/art.py prepare.
//
//   node scripts/art/render.mjs <id> [<id> …]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('node scripts/art/render.mjs <id модели> [...]');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Нужен Playwright: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0 } });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(new URL('lab/', server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => window.lab, null, { timeout: 60000 });
  for (const id of ids) {
    const r = await page.evaluate((id) => window.lab.artGuide(id), id);
    const dir = join(ROOT, 'art', id);
    mkdirSync(dir, { recursive: true });
    const png = (name, url) =>
      writeFileSync(join(dir, name), Buffer.from(url.split(',')[1], 'base64'));
    png('guide.png', r.images.guide);
    png('guide-lines.png', r.images.lines);
    png('guide-clay.png', r.images.clay);
    png('mask.png', r.images.mask);
    delete r.images;
    writeFileSync(join(dir, 'frame.json'), JSON.stringify(r, null, 2) + '\n');
    console.log(`art/${id}: каркас ${r.size.join('×')}, ${r.ppm} px/м`);
  }
} finally {
  await browser.close();
  await server.close();
}
