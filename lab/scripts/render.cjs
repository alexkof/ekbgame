// Рендер моделей лаборатории в PNG (нужен запущенный npm run dev).
// node lab/scripts/render.cjs lab/work/bake 0 city-hall-photo-kit:color:8 city-hall-photo-kit:lines:8
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const [out, ground, ...jobs] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.goto('http://localhost:5173/lab/');
  await p.waitForFunction(() => window.lab, null, { timeout: 15000 });
  const meta = {};
  for (const job of jobs) {
    const [id, mode, ppm] = job.split(':');
    const r = await p.evaluate(
      ([id, mode, ppm, g]) => window.lab.render(id, mode, +ppm, g),
      [id, mode, ppm, ground === '1'],
    );
    const name = `${id}_${mode}_${ppm}`;
    fs.writeFileSync(`${out}/${name}.png`, Buffer.from(r.url.split(',')[1], 'base64'));
    meta[name] = { origin: r.origin, ppm: +ppm };
  }
  fs.writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 1));
  await b.close();
})();
