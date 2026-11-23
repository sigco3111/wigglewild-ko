// Quick look: load dist/ headless (muted, pointer lock faked), wait, screenshot, print errors and state.
//   node scripts/peek.mjs --q "autostart=1&seed=3" --wait 4000 --out shots/peek.png [--js "expr"]
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, launch, PROBE_INIT, startPreview, watch } from './lib.mjs';

const q = String(arg('q', 'autostart=1&seed=3'));
const waitMs = Number(arg('wait', 4000));
const out = String(arg('out', 'shots/peek.png'));
const js = arg('js', null);
const W = Number(arg('w', 1280)), H = Number(arg('h', 720));
mkdirSync(dirname(out), { recursive: true });
const server = await startPreview('dist');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(PROBE_INIT);
const w = watch(page, server.url);
const t0 = Date.now();
await page.goto(`${server.url}?${q}`);
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 60000, polling: 50 }).catch(() => {});
console.log('ready ms', Date.now() - t0);
await page.waitForTimeout(waitMs);
if (js) console.log('js:', JSON.stringify(await page.evaluate(String(js))).slice(0, 3000));
await page.waitForTimeout(Number(arg('after', 0)));
await page.screenshot({ path: out });
const st = await page.evaluate(() => window.__game?.state());
console.log(JSON.stringify(st));
console.log('errors', w.errors.slice(0, 10));
console.log('warnings', [...new Set(w.warnings)].slice(0, 10));
console.log('logs', w.logs.slice(0, 20));
console.log('offhost', w.offHost);
await browser.close();
server.stop();
