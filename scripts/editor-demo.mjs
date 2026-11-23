// Editor demo with real mouse input: build a creature from blank (drag parts from the palette onto the body,
// drag spine handles, resize, paint), test-drive it, save it and release it. Records a muted clip and stage shots.
//   node scripts/editor-demo.mjs [--out shots/v030]
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launch, startPreview, startRecorder, watch } from './lib.mjs';

const out = resolve(String(arg('out', 'shots/v030')));
mkdirSync(out, { recursive: true });
const W = 1600,
	H = 900;
const server = await startPreview('dist');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const w = watch(page, server.url);
await page.goto(`${server.url}?mode=meadow&autostart=1&nowelcome=1&seed=5&count=8`);
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const ev = (f, a) => page.evaluate(f, a);
const rec = await startRecorder(page, join(out, 'editor-build.mp4'), { width: 1600, height: 900 });
const asserts = [];
const check = (n, ok, d = '') => {
	asserts.push({ n, ok: !!ok, d });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);
};

// open the editor from the toolbar
await page.keyboard.press('KeyE');
await page.waitForTimeout(400);
await ev(() => window.__game.game.editor.action('blank'));
await page.waitForTimeout(900);
const wait = (ms) => page.waitForTimeout(ms);
const busy = async () => {
	for (let i = 0; i < 40 && (await ev(() => window.__game.game.editor.busy)); i++) await wait(50);
	await wait(250);
};
/** screen position of a body point: the segment centre pushed toward its surface (side, top, front) */
const bodyPoint = (seg, ox, oy, oz) =>
	ev(
		([seg, ox, oy, oz]) => {
			const E = window.__game.game.editor;
			const s = E.info.segs[seg < 0 ? E.info.segs.length + seg : seg];
			const p = new (E.camera.position.constructor)(s.c[0] + ox * s.r[0], s.c[1] + oy * s.r[1], s.c[2] + oz * s.r[2]).project(E.camera);
			const r = document.getElementById('view').getBoundingClientRect();
			return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
		},
		[seg, ox, oy, oz],
	);
async function dragPart(id, target) {
	const box = await page.locator(`.ed-item[data-pid="${id}"]`).boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	const steps = 18;
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(box.x + box.width / 2 + ((target.x - box.x - box.width / 2) * i) / steps, box.y + box.height / 2 + ((target.y - box.y - box.height / 2) * i) / steps);
		await wait(16);
	}
	await wait(120);
	await page.mouse.up();
	await busy();
}
const parts = () => ev(() => window.__game.game.editor.design.parts.length);

// set a friendlier camera: side three-quarter
await ev(() => {
	const E = window.__game.game.editor;
	E.yaw = 1.15;
	E.pitch = 0.22;
});
await wait(600);
await page.screenshot({ path: join(out, 'ed-1-blank.png') });

// 1. stretch the spine: drag the head handle forward and up
{
	const h = await ev(() => {
		const E = window.__game.game.editor;
		const hm = E.handles[E.info.segs.length - 1];
		const p = hm.position.clone().project(E.camera);
		const r = document.getElementById('view').getBoundingClientRect();
		return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
	});
	await page.mouse.move(h.x, h.y);
	await page.mouse.down();
	for (let i = 1; i <= 14; i++) {
		await page.mouse.move(h.x - i * 4, h.y - i * 5);
		await wait(30);
	}
	await page.mouse.up();
	await busy();
}
const spineMoved = await ev(() => window.__game.game.editor.design.spine.at(-1).y);
check('spine handle drag bends the body', spineMoved > 0.4, `head y ${spineMoved.toFixed(2)}`);

// 2. eyes and a mouth on the head, legs on the body, a tail on the back
await dragPart('eye', await bodyPoint(-1, 0.45, 0.55, 0.6));
check('eyes snap onto the head', (await parts()) === 1);
await dragPart('carn', await bodyPoint(-1, 0, -0.35, 0.95));
await page.screenshot({ path: join(out, 'ed-2-face.png') });
await dragPart('leg2', await bodyPoint(0, 0.8, -0.6, 0));
await dragPart('leg2', await bodyPoint(1, 0.8, -0.6, 0.2));
await dragPart('tailf', await bodyPoint(0, 0, 0.2, -1));
check('five parts placed', (await parts()) === 5, `${await parts()} parts`);
await page.screenshot({ path: join(out, 'ed-3-legs.png') });

// 3. horns and a frill; select a horn and scroll it bigger
await dragPart('curl', await bodyPoint(-1, 0.35, 0.95, 0.2));
await dragPart('frill', await bodyPoint(-1, 0, 0.7, -0.5));
const kBefore = await ev(() => window.__game.game.editor.design.parts.at(-2).k);
{
	const a = await ev(() => {
		const E = window.__game.game.editor;
		const an = E.info.anchors[E.design.parts.length - 2][0];
		const p = new (E.camera.position.constructor)(...an.p).project(E.camera);
		const r = document.getElementById('view').getBoundingClientRect();
		return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
	});
	await page.mouse.click(a.x, a.y);
	await wait(200);
	for (let i = 0; i < 4; i++) {
		await page.mouse.move(a.x, a.y);
		await page.mouse.wheel(0, -160);
		await wait(120);
	}
	await busy();
}
const kAfter = await ev(() => window.__game.game.editor.design.parts.at(-2).k);
check('scroll resizes the selected part', kAfter > kBefore * 1.2, `${kBefore.toFixed(2)} -> ${kAfter.toFixed(2)}`);

// 4. paint
await page.click('#ed-right .sw[data-act="paint-base"][data-i="9"]');
await busy();
await page.click('#ed-right .sw[data-act="paint-accent"][data-i="2"]');
await busy();
await page.click('#ed-right .btn[data-act="pattern"][data-k="spots"]');
await busy();
await page.screenshot({ path: join(out, 'ed-4-painted.png') });

// undo / redo
const codeA = await ev(() => window.__game.game.editor.plan.code);
await page.keyboard.press('Control+KeyZ');
await busy();
const codeB = await ev(() => window.__game.game.editor.plan.code);
await page.keyboard.press('Control+KeyY');
await busy();
const codeC = await ev(() => window.__game.game.editor.plan.code);
check('undo and redo', codeA !== codeB && codeA === codeC);

// name it, test drive
await page.fill('#ed-name', 'Snaggle');
await page.press('#ed-name', 'Enter');
await busy();
await page.keyboard.press('KeyT');
const stepsSeen = new Set();
const p0 = await ev(() => window.__game.game.editor.creature.stepEvents);
for (let i = 0; i < 34; i++) {
	await wait(400);
	stepsSeen.add(await ev(() => document.querySelector('#ed-drive .on')?.textContent ?? ''));
	if (i === 6) await page.screenshot({ path: join(out, 'ed-5-testdrive.png') });
	if (i === 15) await page.screenshot({ path: join(out, 'ed-6-jump.png') });
}
const p1 = await ev(() => window.__game.game.editor.creature.stepEvents);
check('test drive walks, runs, jumps, eats, dances', ['walk', 'run', 'jump', 'eat', 'dance'].every((s) => stepsSeen.has(s)) && p1 - p0 > 10, `${[...stepsSeen].join(',')}; ${p1 - p0} steps`);
await busy();
await page.screenshot({ path: join(out, 'ed-7-done.png') });

// save and release into the meadow
const code = await ev(() => window.__game.game.editor.plan.code);
await page.click('#ed-right .btn[data-act="release"]');
await wait(2600);
const inDex = await ev((code) => window.__game.game.dex.has(code), code);
const inMeadow = await ev((code) => window.__game.list().some((c) => c.code === code), code);
check('saved to the Dex and released', inDex && inMeadow);
// the share code reproduces it exactly
const same = await ev((code) => {
	const id = window.__game.hatch(code);
	return window.__game.list().find((c) => c.id === id)?.code === code;
}, code);
check('share code re-hatches the same creature', same);
await wait(2500);
await rec.stop();
console.log(`${asserts.filter((a) => a.ok).length}/${asserts.length} pass; code ${code}`);
console.log('errors', w.errors, 'offhost', w.offHost);
await browser.close();
server.stop();
