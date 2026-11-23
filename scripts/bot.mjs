// Playwright bot: plays Wigglewild for ~60 s with real mouse and keyboard under the game host's headers.
// Hatches, selects, pokes, mutates, breeds, drives, calls, opens the Dex, hatches from a typed seed, takes a photo,
// and asserts the game reacted: creatures hatch, walk with real steps, mutants and children differ.
//   node scripts/bot.mjs [--seconds 60] [--out shots/bot]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launch, PROBE_INIT, startPreview, startRecorder, watch } from './lib.mjs';

const out = resolve(String(arg('out', 'shots/bot')));
const W = 1280,
	H = 720;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const server = await startPreview(String(arg('dist', 'dist')));
const browser = await launch();
const context = await browser.newContext({ viewport: { width: W, height: H } });
const page = await context.newPage();
await page.addInitScript(PROBE_INIT);
const w = watch(page, server.url);
const t0 = Date.now();
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const asserts = [];
const check = (name, ok, detail = '') => {
	asserts.push({ name, ok: !!ok, detail });
	say(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
const S = () => page.evaluate(() => window.__game.state());
const L = () => page.evaluate(() => window.__game.list());

const navStart = Date.now();
await page.goto(`${server.url}?mode=meadow&seed=11&count=14`);
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 30000, polling: 50 });
const loadMs = Date.now() - navStart;
say(`ready in ${loadMs} ms`);
check('loads under 10 s', loadMs < 10000, `${loadMs} ms`);
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'title.png') });

// start: click the title card (the gesture that unlocks audio)
await page.mouse.click(W / 2, H / 2);
await page.waitForTimeout(500);
let st = await S();
check('starts playing', st.phase === 'playing', st.phase);
const welcome = await page.evaluate(() => document.getElementById('welcome').classList.contains('on'));
check('welcome card shows', welcome);
await page.screenshot({ path: join(out, 'welcome.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const recorder = await startRecorder(page, join(out, 'clip.mp4'), { width: W, height: H });

// hatch with N
const n0 = st.creatures;
await page.keyboard.press('KeyN');
await page.waitForTimeout(2600);
st = await S();
check('N hatches an egg', st.creatures === n0 + 1 && st.hatched >= 1, `${n0} -> ${st.creatures}, hatched ${st.hatched}`);

// click a creature on screen to select it
async function clickCreature(exclude = []) {
	const list = await L();
	for (const c of list) {
		if (c.egg || exclude.includes(c.id)) continue;
		const p = await page.evaluate((id) => window.__game.screenOf(id), c.id);
		if (p?.onScreen && p.x > 340 && p.x < W - 60 && p.y > 80 && p.y < H - 120) {
			await page.mouse.click(p.x, p.y);
			return c.id;
		}
	}
	return null;
}
const selId = await clickCreature();
await page.waitForTimeout(400);
st = await S();
check('click selects a creature', !!selId && st.selected?.id === selId, `${selId} vs ${st.selected?.id}`);
const cardText = await page.evaluate(() => document.getElementById('card').innerText);
check('card shows name and origin', cardText.includes(st.selected?.name ?? '-none-') && /Seed|Child|Mutant/.test(cardText));
await page.screenshot({ path: join(out, 'play-1.png') });

// mutate with M
const before = await L();
await page.keyboard.press('KeyM');
await page.waitForTimeout(2600);
const afterM = await L();
const mutant = afterM.find((c) => !before.some((b) => b.id === c.id));
const parentCode = before.find((c) => c.id === st.selected?.id)?.code;
check('M lays a mutant with a different genome', mutant && mutant.code !== parentCode, mutant ? mutant.name : 'none');

// breed: B, then click a partner
await page.keyboard.press('KeyB');
await page.waitForTimeout(200);
const partner = await clickCreature([st.selected?.id, mutant?.id]);
await page.waitForTimeout(3600);
const afterB = await L();
const child = afterB.find((c) => !afterM.some((b) => b.id === c.id));
const pc = afterM.find((c) => c.id === partner)?.code;
check('B + click breeds a new child', child && child.code !== parentCode && child.code !== pc, child ? child.name : 'none');
await page.screenshot({ path: join(out, 'play-2.png') });

// follow and drive with WASD
await page.keyboard.press('KeyF');
await page.waitForTimeout(500);
const p0 = (await L()).find((c) => c.id === st.selected?.id);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1600);
await page.keyboard.down('KeyD');
await page.waitForTimeout(900);
await page.keyboard.up('KeyD');
await page.waitForTimeout(800);
await page.keyboard.up('KeyW');
const p1 = (await L()).find((c) => c.id === st.selected?.id);
const drove = p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : 0;
check('F + WASD drives the creature', drove > 0.5, `${drove.toFixed(2)} m`);
await page.screenshot({ path: join(out, 'play-3.png') });

// call the herd, stop following
await page.keyboard.press('KeyC');
await page.waitForTimeout(1500);
await page.keyboard.press('KeyF');

// orbit with a mouse drag and zoom
await page.mouse.move(W / 2, H / 2);
await page.mouse.down();
await page.mouse.move(W / 2 + 220, H / 2 + 30, { steps: 12 });
await page.mouse.up();
await page.mouse.wheel(0, 300);
await page.waitForTimeout(400);

// type a seed
await page.click('#seed-in');
await page.keyboard.type('wiggle');
await page.keyboard.press('Enter');
await page.waitForTimeout(2600);
const seeded = (await page.evaluate(() => window.__game.events(80))).find((e) => e.type === 'hatch-seed' && e.seed === 'wiggle');
check('typed seed hatches', !!seeded, seeded?.code ?? '');

// dex
await page.keyboard.press('Tab');
await page.waitForTimeout(500);
const dexCards = await page.evaluate(() => document.querySelectorAll('#dex-grid .dexcard').length);
await page.screenshot({ path: join(out, 'dex.png') });
check('Dex lists discovered creatures', dexCards >= 3, `${dexCards} cards`);
await page.keyboard.press('Tab');

// photo mode toggles the HUD off
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
const photo = await page.evaluate(() => document.body.classList.contains('photo'));
await page.screenshot({ path: join(out, 'photo.png') });
await page.keyboard.press('KeyP');
check('photo mode hides the HUD', photo);

// let the meadow run and check the herd walks with real steps
const steps0 = (await S()).steps;
const spread = await page.evaluate(() => window.__game.list().map((c) => [c.x, c.z]));
const remaining = Math.max(8000, Number(arg('seconds', 60)) * 1000 - (Date.now() - t0));
await page.waitForTimeout(Math.min(remaining, 25000));
st = await S();
const moved = await page.evaluate((spread) => {
	const l = window.__game.list();
	return l.slice(0, spread.length).filter((c, i) => Math.hypot(c.x - spread[i][0], c.z - spread[i][1]) > 1).length;
}, spread);
check('creatures walk with steps', st.steps - steps0 > 100 && moved >= 5, `${st.steps - steps0} steps, ${moved} moved > 1 m`);
await page.screenshot({ path: join(out, 'play-4.png') });
await recorder.stop();

const probe = await page.evaluate(() => window.__probe);
const playTasks = probe.longtasks.filter((t) => t.at > st.marks.play + 1500);
check('60 fps', st.perf.fps > 57, `${st.perf.fps.toFixed(1)} fps, cpu p50 ${st.perf.cpuP50} p95 ${st.perf.cpuP95} ms`);
check('no console errors', w.errors.length === 0 && st.errors === 0, w.errors.slice(0, 3).join(' | '));
check('no requests to other hosts', w.offHost.length === 0, w.offHost.join(', '));
const results = { loadMs, perf: st.perf, draws: st.draws, creatures: st.creatures, dex: st.dex, longestPlayTask: Math.max(0, ...playTasks.map((t) => t.ms)), errors: w.errors, offHost: w.offHost, warnings: [...new Set(w.warnings)], asserts };
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
const failed = asserts.filter((a) => !a.ok).length;
say(`${asserts.length - failed}/${asserts.length} assertions pass`);
await browser.close();
server.stop();
process.exit(failed ? 1 : 0);
