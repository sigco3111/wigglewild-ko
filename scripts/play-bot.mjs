// Play-mode bot: plays the island with real keyboard and mouse input (no game hooks drive anything; the hook is
// only read, to know where things are). It hatches at the nest, eats a fruit, sneaks up on the shy Puffmoss and
// wins the encounter by pressing the moves on the beat, fights off the young Snapjaw, checks the new friend follows,
// runs an agility course (sprint starts and stops, hard turns, the hill, jumps), then finds the Thunderback, gets
// chased and escapes. The animation-quality metrics run on your creature the whole time.
//   node scripts/play-bot.mjs [--out shots/v040/bot] [--record clip.mp4] [--shots]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launch, PROBE_INIT, startPreview, startRecorder, watch } from './lib.mjs';

const out = resolve(String(arg('out', 'shots/v040/bot')));
const record = arg('record', null);
const shots = !!arg('shots', false);
const code = arg('creature', null);
const W = 1920,
	H = 1080;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const server = await startPreview('dist');
const browser = await launch();
const context = await browser.newContext({ viewport: { width: Number(arg('w', W)), height: Number(arg('h', H)) } });
const page = await context.newPage();
await page.addInitScript(PROBE_INIT);
if (code) await page.addInitScript((c) => localStorage.setItem('wigglewild.player', c), code);
const w = watch(page, server.url);
const t0 = Date.now();
const say = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const asserts = [];
const check = (name, ok, detail = '') => {
	asserts.push({ name, ok: !!ok, detail });
	say(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
const P = () => page.evaluate(() => window.__game.state().play);
const ev = (type) => page.evaluate((t) => window.__game.events(400).filter((e) => e.type === t).length, type);
// --fixed <dir>: a fixed 1/60 s clock stepped by the bot, capturing every other frame of the highlights (encounter,
// fight, pack, the Thunderback) into <dir> for a smooth clip; the inputs are the same real key presses.
const fixedDir = arg('fixed', null);
let capturing = false;
let shot = 0;
async function advance(ms) {
	const frames = Math.max(1, Math.round((ms / 1000) * 60));
	for (let f = 0; f < frames; f += 2) {
		await page.evaluate(() => window.__game.step(2));
		if (capturing) await page.screenshot({ path: join(String(fixedDir), `f${String(shot++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
	}
}
const sleep = (ms) => (fixedDir ? advance(ms) : page.waitForTimeout(ms));
const vw = Number(arg('w', W)),
	vh = Number(arg('h', H));

const nav0 = Date.now();
if (fixedDir) {
	rmSync(String(fixedDir), { recursive: true, force: true });
	mkdirSync(String(fixedDir), { recursive: true });
}
await page.goto(`${server.url}?mode=play&seed=7${fixedDir ? '&clock=fixed' : ''}`);
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 30000, polling: 50 });
const loadMs = Date.now() - nav0;
check('loads under 10 s', loadMs < 10000, `${loadMs} ms`);
await sleep(500);
if (shots) await page.screenshot({ path: join(out, 'title.png') });
let rec = null;
let recT0 = Date.now();
const marks = [];
const mark = (name) => {
	marks.push({ name, t: +((Date.now() - recT0) / 1000).toFixed(2), frame: shot });
	if (fixedDir) capturing = name.endsWith('-start');
};
if (record) {
	rec = await startRecorder(page, resolve(String(record)), { fps: 30, width: 1280, height: 720 });
	recT0 = Date.now();
}
// start (Enter on the title), close the controls card (Enter), lock the mouse with a click
await page.keyboard.press('Enter');
await sleep(700);
if (shots) await page.screenshot({ path: join(out, 'controls.png') });
await page.keyboard.press('Enter');
await page.mouse.click(vw / 2, vh / 2);
await page.evaluate(() => window.__game.game.play.measure(true));
if (fixedDir) await page.evaluate(() => window.__game.step(1));

// ---- helpers: steer with WASD relative to the camera ----
const held = new Set();
async function hold(keys) {
	for (const k of [...held]) if (!keys.includes(k)) {
		await page.keyboard.up(k);
		held.delete(k);
	}
	for (const k of keys) if (!held.has(k)) {
		await page.keyboard.down(k);
		held.add(k);
	}
}
const release = () => hold([]);
/** keys that move toward world direction (dx, dz) given the camera yaw */
function keysFor(dx, dz, camYaw) {
	const fx = -Math.sin(camYaw),
		fz = -Math.cos(camYaw);
	const rx = -fz,
		rz = fx;
	const f = dx * fx + dz * fz,
		r = dx * rx + dz * rz;
	const a = Math.atan2(r, f);
	const sector = Math.round(a / (Math.PI / 4));
	const map = { 0: ['KeyW'], 1: ['KeyW', 'KeyD'], 2: ['KeyD'], 3: ['KeyS', 'KeyD'], 4: ['KeyS'], '-4': ['KeyS'], '-3': ['KeyS', 'KeyA'], '-2': ['KeyA'], '-1': ['KeyW', 'KeyA'] };
	return map[sector];
}
let mx = vw / 2;
async function goTo(target, { stop = 1.2, sprint = false, sneakWithin = 0, timeout = 40000, until = null, holdLook = false } = {}) {
	const tEnd = Date.now() + timeout;
	let it = 0;
	while (Date.now() < tEnd) {
		// keep the view where we turned it (tiny mouse nudges count as looking)
		if (holdLook && it++ % 4 === 0) {
			mx += it % 8 === 1 ? 2 : -2;
			await page.mouse.move(mx, vh / 2);
		}
		const s = await P();
		const t = typeof target === 'function' ? target(s) : target;
		if (!t) break;
		const dx = t.x - s.pos.x,
			dz = t.z - s.pos.z;
		const d = Math.hypot(dx, dz);
		if (d < stop || (until && until(s))) {
			await release();
			return s;
		}
		const keys = keysFor(dx, dz, s.camYaw);
		if (sneakWithin && d < sneakWithin) keys.push('KeyC');
		else if (sprint && s.stamina > 0.15) keys.push('ShiftLeft');
		await hold(keys);
		await sleep(90);
	}
	await release();
	return P();
}
const actor = (s, pred) => s.actors.filter(pred).sort((a, b) => Math.hypot(a.x - s.pos.x, a.z - s.pos.z) - Math.hypot(b.x - s.pos.x, b.z - s.pos.z))[0];

// ---- 1. hatch ----
for (let i = 0; i < 120 && (await P()).step === 'hatch'; i++) await sleep(125);
let s = await P();
check('hatches at the nest', !s.egg && s.step === 'eat', `step ${s.step}`);
if (shots) await page.screenshot({ path: join(out, 'hatched.png') });

// ---- 2. eat a fruit ----
s = await goTo((st) => (st.objective ? { x: st.objective[0], z: st.objective[2] } : null), { stop: 0.5, until: (st) => st.prompt === 'eat', timeout: 45000 });
for (let i = 0; i < 8 && (await P()).prompt !== 'eat'; i++) await sleep(150);
await page.keyboard.press('KeyF');
await sleep(1500);
check('eats a fruit', (await ev('eat')) > 0, `hunger ${(await P()).hunger}`);

// ---- 3. befriend the Puffmoss (sneak up, greet, play the moves on the beat) ----
const KEY = { sing: 'Digit1', dance: 'Digit2', charm: 'Digit3', pose: 'Digit4' };
async function encounter() {
	let pressed = -1;
	let round = -1;
	let shot = false;
	const tEnd = Date.now() + 60000;
	while (Date.now() < tEnd) {
		const st = await P();
		const e = st.encounter;
		if (!e) break;
		if (e.round !== round) {
			round = e.round;
			pressed = -1;
		}
		if (e.phase === 'show' && shots && !shot && e.round === 0) {
			await page.screenshot({ path: join(out, 'encounter-show.png') });
			shot = true;
		}
		if (e.phase === 'play' && e.idx < e.seq.length && e.idx > pressed) {
			const T = e.idx * e.beat;
			// the beat lands in (T - e.t) seconds: wait for it, then press
			const wait = (T - e.t) * 1000 - 25;
			if (wait < 120) {
				if (wait > 0) await sleep(wait);
				await page.keyboard.press(KEY[e.seq[e.idx]]);
				pressed = e.idx;
				if (shots && e.round === 0 && e.idx === 2) await page.screenshot({ path: join(out, 'encounter-play.png') });
				continue;
			}
		}
		await sleep(20);
	}
}
for (let attempt = 0; attempt < 3; attempt++) {
	s = await P();
	if (s.allied.includes('puffmoss')) break;
	await goTo((st) => {
		const a = actor(st, (x) => x.species === 'puffmoss' && x.alive && !x.ally);
		return a ? { x: a.x, z: a.z } : null;
	}, { stop: 1.6, sneakWithin: 9, until: (st) => st.prompt === 'greet', timeout: 50000 });
	for (let i = 0; i < 10 && (await P()).prompt !== 'greet'; i++) {
		const st = await P();
		const a = actor(st, (x) => x.species === 'puffmoss' && x.alive);
		if (a) await hold([...keysFor(a.x - st.pos.x, a.z - st.pos.z, st.camYaw), 'KeyC']);
		await sleep(160);
		await release();
	}
	await page.keyboard.press('KeyF');
	await sleep(300);
	if ((await P()).encounter) {
		mark('encounter-start');
		await encounter();
		mark('encounter-end');
	}
	await sleep(2500);
}
s = await P();
check('befriends a species (encounter won)', s.allied.includes('puffmoss'), `allied ${s.allied.join(',')}`);
check('recruits an ally', s.pack.length >= 1, `pack ${s.pack.length}`);

// ---- 4. fend off the young Snapjaw ----
for (let i = 0; i < 120 && !(await ev('tutorial-hunter')); i++) await sleep(125);
let fightShot = false;
mark('fight-start');
const tFight = Date.now() + 60000;
while (Date.now() < tFight) {
	s = await P();
	if (s.step === 'explore') break;
	const h = actor(s, (x) => x.species === 'snapjaw' && x.alive && x.young && x.foe === 'player') ?? actor(s, (x) => x.species === 'snapjaw' && x.alive);
	if (!h) {
		await sleep(200);
		continue;
	}
	const dx = h.x - s.pos.x,
		dz = h.z - s.pos.z;
	const d = Math.hypot(dx, dz);
	if (d > 1.3) await hold(keysFor(dx, dz, s.camYaw));
	else await release();
	if (d < 2.4) {
		await page.mouse.down();
		await page.mouse.up();
		if (shots && !fightShot && (await ev('hit')) > 2) {
			await page.screenshot({ path: join(out, 'fight.png') });
			fightShot = true;
		}
	}
	await sleep(140);
}
mark('fight-end');
await release();
s = await P();
check('wins a fight (hunter fended off)', s.step === 'explore', `hits ${s.stats.hits}, wins ${s.stats.wins}`);
await sleep(1500);

// ---- 5. the pack follows ----
{
	mark('pack-start');
	const start = await P();
	const dir = { x: Math.sin(start.yaw), z: Math.cos(start.yaw) };
	// look to the side with the mouse (like a player checking on a friend), walk, stop and let it catch up, twice
	mx = 30;
	await page.mouse.move(mx, vh / 2, { steps: 14 });
	await goTo({ x: start.pos.x + dir.x * 7, z: start.pos.z + dir.z * 7 }, { stop: 1.5, timeout: 10000, holdLook: true });
	await sleep(1600);
	await goTo({ x: start.pos.x + dir.x * 14, z: start.pos.z + dir.z * 14 }, { stop: 1.5, timeout: 10000, holdLook: true });
	await sleep(1800);
	const st = await P();
	const ally = st.actors.find((a) => a.ally);
	const d = ally ? Math.hypot(ally.x - st.pos.x, ally.z - st.pos.z) : 99;
	mark('pack-end');
	check('the ally follows', ally && d < 7, `ally ${d.toFixed(1)} m away`);
	if (shots) await page.screenshot({ path: join(out, 'pack.png') });
}

// ---- 6. agility course: sprint starts and stops, hard turns, slopes, jumps ----
{
	const st = await P();
	const hill = st.nests.find((n) => n.id === 'tusket');
	const via = { x: (st.pos.x + -26) / 2, z: (st.pos.z + 18) / 2 };
	for (let i = 0; i < 3; i++) {
		await hold(['KeyW', 'ShiftLeft']);
		await sleep(900);
		await release();
		await sleep(500);
		await hold(['KeyS']);
		await sleep(700);
		await hold(['KeyA']);
		await sleep(600);
		await hold(['KeyD', 'ShiftLeft']);
		await sleep(700);
		await page.keyboard.press('Space');
		await sleep(500);
		await release();
		await sleep(400);
	}
	// up and down the big hill's flank (stay off the Tuskets' nest)
	await goTo(via, { stop: 2, sprint: true, timeout: 20000 });
	await goTo({ x: -18, z: 24 }, { stop: 2, timeout: 25000 });
	await goTo({ x: -8, z: 14 }, { stop: 2, sprint: true, timeout: 20000 });
	void hill;
	const r = await page.evaluate(() => window.__game.game.play.report());
	say(`player metrics so far: ${JSON.stringify(r)}`);
}

// ---- 7. the Thunderback: get noticed, run, escape ----
{
	let chased = false;
	const tEnd = Date.now() + 70000;
	while (Date.now() < tEnd && !chased) {
		const st = await P();
		const e = st.actors.find((a) => a.species === 'thunderback');
		if (!e) break;
		if (e.state === 'chase') {
			chased = true;
			break;
		}
		await goTo({ x: e.x, z: e.z }, { stop: 9, timeout: 1500, until: (x) => x.actors.find((a) => a.species === 'thunderback')?.state === 'chase' });
	}
	mark('epic-start');
	check('the Thunderback notices you', chased);
	if (shots) await page.screenshot({ path: join(out, 'epic.png') });
	// run: away from it, sprinting, jumping over stomps
	const tRun = Date.now() + 30000;
	let escaped = false;
	while (Date.now() < tRun) {
		const st = await P();
		if (st.down) break;
		const e = st.actors.find((a) => a.species === 'thunderback');
		if (!e || e.state !== 'chase') {
			escaped = !st.down;
			break;
		}
		let dx = st.pos.x - e.x,
			dz = st.pos.z - e.z;
		// bend toward the island's middle, never into the sea
		const r = Math.hypot(st.pos.x, st.pos.z);
		if (r > 30) {
			dx -= (st.pos.x / r) * 1.2;
			dz -= (st.pos.z / r) * 1.2;
		}
		const keys = keysFor(dx, dz, st.camYaw);
		if (st.stamina > 0.05) keys.push('ShiftLeft');
		await hold(keys);
		if (Math.hypot(dx, dz) < 6 && Math.random() < 0.3) await page.keyboard.press('Space');
		await sleep(110);
	}
	mark('epic-end');
	await release();
	s = await P();
	check('survives the Thunderback', escaped && !s.down && s.stats.faints === 0, `escaped ${escaped}, faints ${s.stats.faints}, hp ${s.hp}`);
}

// ---- results ----
await sleep(800);
if (rec) await rec.stop();
const st = await page.evaluate(() => window.__game.state());
const report = await page.evaluate(() => window.__game.game.play.report());
const fails = [];
if (report.slideMaxCm >= 1) fails.push(`slide ${report.slideMaxCm} cm`);
if (report.penetrationCm >= 1) fails.push(`feet ${report.penetrationCm} cm under`);
if (report.bodyBelowCm >= 1) fails.push(`belly ${report.bodyBelowCm} cm under`);
if (report.pops > 0) fails.push(`${report.pops} knee pops`);
if (report.overExtPct > 0.5) fails.push(`over-extended ${report.overExtPct}%`);
check('player animation: no slide, no pops', !fails.length, fails.join(', ') || `slide ${report.slideMaxCm} cm, pops ${report.pops}, jitter ${report.jitterP99mm} mm`);
check('60 fps', st.perf.fps > 55, `fps ${st.perf.fps.toFixed(1)}, cpu p50 ${st.perf.cpuP50} p95 ${st.perf.cpuP95} ms`);
check('no console errors', w.errors.length === 0, w.errors.slice(0, 3).join(' | '));
check('no off-host requests', w.offHost.length === 0, w.offHost.slice(0, 3).join(' | '));
const passed = asserts.filter((a) => a.ok).length;
writeFileSync(join(out, 'results.json'), JSON.stringify({ passed, total: asserts.length, asserts, marks, playerMetrics: report, perf: st.perf, stats: st.play.stats, loadMs }, null, 1));
say(`${passed}/${asserts.length} passed`);
await browser.close();
server.stop();
process.exit(passed === asserts.length ? 0 : 1);
