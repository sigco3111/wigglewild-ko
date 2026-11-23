// The animation-quality bar on the player creature in Play, under a fixed 1/60 s clock with real key presses:
// sprint starts and stops, hard turns and reversals, the big hill up and down, jumps, sneaking, knockback from hits.
// Each segment reports foot slide, penetration, knee pops, over-extension, jitter and floating parts.
//   node scripts/player-course.mjs [--creature <code>] [--out shots/v040/course]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launch, startPreview, watch } from './lib.mjs';

const out = resolve(String(arg('out', 'shots/v040/course')));
mkdirSync(out, { recursive: true });
const codes = arg('creature', null) ? String(arg('creature')).split(',') : [null];
const server = await startPreview('dist');
const browser = await launch();
const all = [];
for (const code of codes) {
	const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
	if (code) await page.addInitScript((c) => localStorage.setItem('wigglewild.player', c), code);
	const w = watch(page, server.url);
	await page.goto(`${server.url}?mode=play&seed=5&autostart=1&nowelcome=1&skiptutorial=1&clock=fixed&time=0.35`);
	await page.waitForFunction(() => window.__game?.ready && window.__game.state().play, null, { timeout: 30000 });
	const step = (n) => page.evaluate((k) => window.__game.step(k), n);
	await step(150);
	const P = () => page.evaluate(() => window.__game.state().play);
	// keep the wild ones away so the course measures locomotion, not fights
	await page.evaluate(() => {
		const pl = window.__game.game.play;
		for (const a of pl.actors) if (a !== pl.player) a.c.place(a.c.pos.x + 200, a.c.pos.z, a.c.yaw);
	});
	const held = new Set();
	const hold = async (keys) => {
		for (const k of [...held]) if (!keys.includes(k)) {
			await page.keyboard.up(k);
			held.delete(k);
		}
		for (const k of keys) if (!held.has(k)) {
			await page.keyboard.down(k);
			held.add(k);
		}
	};
	const run = async (keys, frames) => {
		await hold(keys);
		for (let f = 0; f < frames; f += 6) await step(6);
	};
	const keysFor = (dx, dz, camYaw) => {
		const fx = -Math.sin(camYaw),
			fz = -Math.cos(camYaw);
		const f = dx * fx + dz * fz,
			r = dx * -fz + dz * fx;
		const sector = Math.round(Math.atan2(r, f) / (Math.PI / 4));
		return { 0: ['KeyW'], 1: ['KeyW', 'KeyD'], 2: ['KeyD'], 3: ['KeyS', 'KeyD'], 4: ['KeyS'], '-4': ['KeyS'], '-3': ['KeyS', 'KeyA'], '-2': ['KeyA'], '-1': ['KeyW', 'KeyA'] }[sector];
	};
	const goTo = async (x, z, extra = [], maxF = 1800) => {
		for (let f = 0; f < maxF; f += 6) {
			const s = await P();
			const dx = x - s.pos.x,
				dz = z - s.pos.z;
			if (Math.hypot(dx, dz) < 1.5) break;
			await hold([...keysFor(dx, dz, s.camYaw), ...extra]);
			await step(6);
		}
	};
	const seg = async (name, fn) => {
		await page.evaluate(() => window.__game.game.play.measure(true));
		await fn();
		await hold([]);
		await step(60);
		const r = await page.evaluate(() => window.__game.game.play.report());
		const fails = [];
		if (r.slideMaxCm >= 1) fails.push(`slide ${r.slideMaxCm}cm`);
		if (r.penetrationCm >= 1) fails.push(`feet ${r.penetrationCm}cm under`);
		if (r.kneeBelowCm >= 2) fails.push(`knee ${r.kneeBelowCm}cm under`);
		if (r.bodyBelowCm >= 1) fails.push(`belly ${r.bodyBelowCm}cm under`);
		if (r.overExtPct > 0.5) fails.push(`over-extended ${r.overExtPct}%`);
		if (r.pops > 0) fails.push(`${r.pops} knee pops`);
		if (r.floatMaxMm >= 10) fails.push(`${r.floatWhat} floats ${r.floatMaxMm}mm`);
		if (r.jitterP99mm >= 1.0) fails.push(`jitter ${r.jitterP99mm}mm`);
		const row = { creature: r.name, segment: name, ...r, fails };
		all.push(row);
		console.log(`${r.name.padEnd(12)} ${name.padEnd(16)} dist ${r.distance}m steps ${r.steps} slide ${r.slideMaxCm}cm pen ${r.penetrationCm} knee ${r.kneeBelowCm} belly ${r.bodyBelowCm} ext ${r.overExtPct}% pops ${r.pops}(${r.popMax} ${r.pops ? r.popAt : ""}) jit ${r.jitterP99mm}mm float ${r.floatMaxMm}mm ${fails.length ? `FAIL ${fails.join(', ')}` : 'ok'}`);
	};
	await seg('sprint-stop', async () => {
		for (let i = 0; i < 4; i++) {
			await run(['KeyW', 'ShiftLeft'], 72);
			await run([], 48);
		}
	});
	await seg('hard-turns', async () => {
		for (let i = 0; i < 3; i++) {
			await run(['KeyW'], 60);
			await run(['KeyS'], 60);
			await run(['KeyA'], 48);
			await run(['KeyD', 'ShiftLeft'], 48);
		}
	});
	await seg('hill', async () => {
		await goTo(-20, 16, ['ShiftLeft']);
		await goTo(-30, 22);
		await goTo(-14, 8, ['ShiftLeft']);
	});
	await seg('jumps', async () => {
		for (let i = 0; i < 4; i++) {
			await run(['KeyW', 'ShiftLeft'], 30);
			await page.keyboard.down('Space');
			await run(['KeyW', 'ShiftLeft'], 50);
			await page.keyboard.up('Space');
			await run(['KeyW'], 30);
		}
	});
	await seg('sneak', async () => {
		await run(['KeyW', 'KeyC'], 120);
		await run(['KeyA', 'KeyC'], 60);
		await run([], 40);
	});
	await seg('knockback', async () => {
		for (let i = 0; i < 4; i++) {
			await run(['KeyW'], 30);
			await page.evaluate((k) => {
				const c = window.__game.game.play.player.c;
				const a = c.yaw + Math.PI * (k % 2 ? 0.5 : 1);
				c.push.set(Math.sin(a) * 3, 0, Math.cos(a) * 3);
				c.act('hit');
			}, i);
			await run([], 50);
		}
	});
	if (w.errors.length) console.log('errors', w.errors.slice(0, 5));
	await page.close();
}
writeFileSync(join(out, 'results.json'), JSON.stringify({ passed: all.filter((r) => !r.fails.length).length, total: all.length, segments: all }, null, 1));
console.log(`${all.filter((r) => !r.fails.length).length}/${all.length} segments clean`);
await browser.close();
server.stop();
