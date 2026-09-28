// Render the static PNGs from the SVGs that build.py writes.
//
//   docs/demo.png            complete demo card, dark theme, 2080 px wide
//   docs/social-preview.png  1280 x 640 link card
//   docs/icon.png            512 x 512 app icon, transparent corners
//
// Usage (from the repo root, after build.py):
//   node docs/art/render.cjs
// Needs the playwright package; set CHROMIUM to a Chromium binary if
// playwright's own browser is not installed.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const docs = path.resolve(__dirname, '..');

const jobs = [
  { src: 'demo-dark.svg', out: 'demo.png', scale: 2080 / 1280 },
  { src: 'art/social-preview.svg', out: 'social-preview.png', scale: 1 },
  { src: 'art/icon.svg', out: 'icon.png', scale: 1, transparent: true },
];

(async () => {
  const opts = process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {};
  const browser = await chromium.launch(opts);
  for (const job of jobs) {
    const file = path.join(docs, job.src);
    const svg = fs.readFileSync(file, 'utf8');
    const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/).map(Number);
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: job.scale });
    // Reduced motion shows every element in its resting, complete state.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('file://' + file);
    await page.screenshot({
      path: path.join(docs, job.out),
      clip: { x: 0, y: 0, width: w, height: h },
      omitBackground: !!job.transparent,
    });
    await page.close();
    console.log('wrote docs/' + job.out);
  }
  await browser.close();
})();
