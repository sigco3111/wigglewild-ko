// Animation-quality harness. For many seeds: put the creature on the lab course (steep hill, hairpin turn, stop,
// turn on the spot, run over rocks), step at a fixed 1/60 s, measure foot slide, penetration, over-extension,
// knee pops, body jitter and floating parts, and render a contact sheet (4 moments per creature).
//   node scripts/anim.mjs [--from 1] [--count 48] [--frames 900] [--out shots/anim] [--clip 1,2,3]
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launch, startPreview, watch } from './lib.mjs';

const from = Number(arg('from', 1));
const count = Number(arg('count', 48));
const frames = Number(arg('frames', 900));
const out = resolve(String(arg('out', 'shots/anim')));
const clipSeeds = String(arg('clip', '')).split(',').filter(Boolean).map((v) => (/^\d+$/.test(v) ? Number(v) : v));
const fuzz = Number(arg('fuzz', 0));
const names = arg('names', null) ? String(arg('names')).split(',') : null;
const species = !!arg('species', null);
let seedList = names ? names : fuzz ? Array.from({ length: fuzz }, (_, i) => `fuzz-${from + i}`) : arg('seeds', null) ? String(arg('seeds')).split(',').map(Number) : Array.from({ length: count }, (_, i) => from + i);
const W = 400, H = 300;
rmSync(join(out, 'frames'), { recursive: true, force: true });
mkdirSync(join(out, 'frames'), { recursive: true });

const server = await startPreview('dist');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const w = watch(page, server.url);
await page.goto(`${server.url}?lab=1&autostart=1&seed=1&quality=high`);
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 60000 });
await page.evaluate(() => {
	document.body.classList.add('photo');
	document.getElementById('veil').style.display = 'none';
	document.getElementById('photo-bar').style.display = 'none';
	document.getElementById('photo-frame').style.display = 'none';
	window.__game.step(1);
});

if (species) {
	const only = typeof arg('species') === 'string' && arg('species') !== '1' ? String(arg('species')).split(',') : null;
	seedList = (await page.evaluate(() => window.__game.speciesCodes())).filter((s) => !only || only.includes(s.name)).map((s) => s.code);
}
const results = [];
const shotsPer = 4;
let fi = 0;
for (const seed of seedList) {
	const info = await page.evaluate((s) => window.__game.lab.begin(typeof s === 'string' && !/^[DC]1/.test(s) ? window.__game.designCode(s) : s), seed);
	const per = Math.floor(frames / shotsPer);
	for (let k = 0; k < shotsPer; k++) {
		await page.evaluate((n) => window.__game.lab.drive(n), per);
		await page.evaluate((k) => window.__game.lab.shot([2.2, 1.4, 3.6, 0.9][k], 0.62, 0.42), k);
		await page.screenshot({ path: join(out, 'frames', `f${String(fi++).padStart(4, '0')}.jpg`), quality: 85, type: 'jpeg' });
	}
	const r = await page.evaluate(() => window.__game.lab.report());
	const fails = [];
	if (r.slideMaxCm >= 1) fails.push(`slide ${r.slideMaxCm}cm`);
	if (r.penetrationCm >= 1) fails.push(`feet ${r.penetrationCm}cm under`);
	if (r.kneeBelowCm >= 2) fails.push(`knee ${r.kneeBelowCm}cm under`);
	if (r.bodyBelowCm >= 1) fails.push(`belly ${r.bodyBelowCm}cm under`);
	if (r.overExtPct > 0.5) fails.push(`over-extended ${r.overExtPct}%`);
	if (r.pops > 0) fails.push(`${r.pops} knee pops`);
	if (r.floatMaxMm >= 10) fails.push(`${r.floatWhat} floats ${r.floatMaxMm}mm`);
	if (r.jitterP99mm >= 1.0) fails.push(`jitter ${r.jitterP99mm}mm`);
	if (r.distance < 3) fails.push(`only moved ${r.distance}m`);
	results.push({ seed, ...info, ...r, fails });
	console.log(`${String(seed).padStart(8)} ${info.name.padEnd(14)} ${info.kind.padEnd(6)} legs ${r.legs} size ${r.size} dist ${r.distance}m steps ${r.steps} slide ${r.slideMaxCm}cm pen ${r.penetrationCm}cm knee ${r.kneeBelowCm} belly ${r.bodyBelowCm} hover ${r.footHoverCm} ext ${r.overExtPct}% emerg ${r.emergencySteps} early ${r.earlySteps} pops ${r.pops}(${r.popMax}) jit ${r.jitterP99mm}mm float ${r.floatMaxMm}mm ${fails.length ? `FAIL: ${fails.join(', ')}` : 'ok'}`);
}

// short muted clips: a few creatures on the course (uphill, hairpin, stop and turn), camera orbiting slowly
for (const seed of clipSeeds) {
	const dir = join(out, `clip-${seed}`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	await page.setViewportSize({ width: 640, height: 360 });
	await page.evaluate((s) => window.__game.lab.begin(typeof s === 'string' && !/^[DC]1/.test(s) ? window.__game.designCode(s) : s), seed);
	await page.evaluate((n) => window.__game.lab.drive(n), 150);
	for (let i = 0; i < 210; i++) {
		await page.evaluate(() => window.__game.lab.drive(2));
		await page.evaluate((i) => window.__game.lab.shot(1.9 + i * 0.006, 0.7, 0.32), i);
		await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.jpg`), quality: 88, type: 'jpeg' });
	}
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(dir, 'f%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-an', join(out, `clip-${seed}.mp4`)]);
	rmSync(dir, { recursive: true, force: true });
	await page.setViewportSize({ width: W, height: H });
	console.log(`clip ${seed} -> clip-${seed}.mp4`);
}

// contact sheet: rows of creatures, 4 moments each (two creatures per row)
const cols = shotsPer * 2;
const rows = Math.ceil(fi / cols);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(out, 'frames', 'f%04d.jpg'), '-vf', `tile=${cols}x${rows}:padding=4:color=white`, '-frames:v', '1', join(out, 'sheet.jpg')]);

const passed = results.filter((r) => !r.fails.length).length;
const agg = (k, f = Math.max) => results.reduce((m, r) => f(m, r[k]), 0);
const summary = {
	seeds: results.length,
	passed,
	failed: results.length - passed,
	worst: {
		slideMaxCm: agg('slideMaxCm'),
		penetrationCm: agg('penetrationCm'),
		kneeBelowCm: agg('kneeBelowCm'),
		bodyBelowCm: agg('bodyBelowCm'),
		overExtPct: agg('overExtPct'),
		pops: agg('pops', (a, b) => a + b),
		jitterP99mm: agg('jitterP99mm'),
		floatMaxMm: agg('floatMaxMm'),
	},
	kinds: results.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {}),
	errors: w.errors,
	offHost: w.offHost,
};
writeFileSync(join(out, 'results.json'), JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
server.stop();
