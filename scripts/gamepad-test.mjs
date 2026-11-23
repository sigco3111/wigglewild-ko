// Gamepad check: a virtual pad on the standard mapping (what a PS4 controller reports in Chrome) drives Play:
// left stick moves, right stick turns the camera, R2 sprints (stamina drops), Cross jumps, Square bites,
// and the HUD switches to pad glyphs.
//   node scripts/gamepad-test.mjs
import { arg, launch, startPreview, watch } from './lib.mjs';

const server = await startPreview('dist');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
	const pad = { id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
	window.__pad = pad;
	navigator.getGamepads = () => [pad, null, null, null];
});
const w = watch(page, server.url);
await page.goto(`${server.url}?mode=play&seed=5&autostart=1&nowelcome=1&skiptutorial=1`);
await page.waitForFunction(() => window.__game?.ready && window.__game.state().play && !window.__game.state().play.egg, null, { timeout: 30000 });
const P = () => page.evaluate(() => window.__game.state().play);
const set = (fn) => page.evaluate(fn);
const results = [];
const check = (n, ok, d = '') => {
	results.push({ n, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${d}`);
};
await page.waitForTimeout(800);
const s0 = await P();
await set(() => (window.__pad.axes[1] = -1));
await page.waitForTimeout(1500);
const s1 = await P();
const moved = Math.hypot(s1.pos.x - s0.pos.x, s1.pos.z - s0.pos.z);
check('left stick moves', moved > 1, `${moved.toFixed(2)} m`);
check('HUD shows pad glyphs', await page.evaluate(() => !!document.querySelector('#ph-abil .pad')));
await set(() => (window.__pad.buttons[7] = { pressed: true, touched: true, value: 1 }));
await page.waitForTimeout(1500);
const s2 = await P();
check('R2 sprints (stamina drops)', s2.stamina < 0.95, `stamina ${s2.stamina}`);
await set(() => {
	window.__pad.buttons[7] = { pressed: false, touched: false, value: 0 };
	window.__pad.axes[1] = 0;
});
const yaw0 = (await P()).camYaw;
await set(() => (window.__pad.axes[2] = 1));
await page.waitForTimeout(700);
await set(() => (window.__pad.axes[2] = 0));
const yaw1 = (await P()).camYaw;
check('right stick turns the camera', Math.abs(yaw1 - yaw0) > 0.5, `${yaw0} -> ${yaw1}`);
const j0 = await page.evaluate(() => window.__game.events(999).filter((e) => e.type === 'jump').length);
await set(() => (window.__pad.buttons[0] = { pressed: true, touched: true, value: 1 }));
await page.waitForTimeout(200);
await set(() => (window.__pad.buttons[0] = { pressed: false, touched: false, value: 0 }));
await page.waitForTimeout(300);
const j1 = await page.evaluate(() => window.__game.events(999).filter((e) => e.type === 'jump').length);
check('Cross jumps', j1 > j0);
const a0 = await page.evaluate(() => window.__game.events(999).filter((e) => e.type === 'attack').length);
await set(() => (window.__pad.buttons[2] = { pressed: true, touched: true, value: 1 }));
await page.waitForTimeout(150);
await set(() => (window.__pad.buttons[2] = { pressed: false, touched: false, value: 0 }));
await page.waitForTimeout(300);
const a1 = await page.evaluate(() => window.__game.events(999).filter((e) => e.type === 'attack').length);
check('Square bites', a1 > a0);
check('no console errors', w.errors.length === 0, w.errors.slice(0, 2).join(' | '));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await browser.close();
server.stop();
void arg;
