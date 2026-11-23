// Fast check of every render path: loads dist/ under the game host's headers with ?patch-test=1 and
// reports the self-checks, console errors, off-host requests and boot timings.
//   node scripts/smoke.mjs [--paths webgpu,webgl2,webgl] [--extra "&vfx=quarks"] [--headed]
import { arg, launch, PROBE_INIT, startPreview, watch } from './lib.mjs';

const paths = String(arg('paths', 'webgl')).split(',');
const extra = arg('extra', '') || '';
const server = await startPreview('dist');
const browser = await launch({ headed: !!arg('headed', false) });
let failed = 0;
for (const kind of paths) {
	const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
	await page.addInitScript(PROBE_INIT);
	const w = watch(page, server.url);
	const t0 = Date.now();
	await page.goto(`${server.url}?patch-test=1&seed=3${extra}`);
	await page.waitForFunction(() => window.__game?.ready && Object.keys(window.__game.checks).length >= 11, null, { timeout: 60000 }).catch(() => {});
	const readyMs = Date.now() - t0;
	await page.waitForTimeout(1500);
	const st = await page.evaluate(() => ({ checks: window.__game?.checks, state: window.__game?.state(), probe: window.__probe }));
	const passes = w.logs.filter((l) => /^(pass|fail) /.test(l));
	const longest = Math.max(0, ...(st.probe?.longtasks ?? []).map((t) => t.ms));
	console.log(`\n== ${kind}: ${st.state?.renderer}`);
	console.log(passes.join('\n'));
	console.log(`ready ${readyMs} ms; marks ${JSON.stringify(st.state?.marks)}; longest task ${longest} ms`);
	if (extra) console.log(`quarks: ${JSON.stringify(st.state?.quarks)}`);
	if (w.errors.length) console.log(`console errors:\n  ${w.errors.slice(0, 10).join('\n  ')}`);
	if (w.warnings.length) console.log(`warnings (${w.warnings.length}):\n  ${[...new Set(w.warnings)].slice(0, 8).join('\n  ')}`);
	if (w.offHost.length) console.log(`off-host requests: ${w.offHost.join(', ')}`);
	const bad = passes.some((l) => l.startsWith('fail')) || passes.length < 11 || w.errors.length || w.offHost.length;
	if (bad) failed++;
	await page.close();
}
await browser.close();
server.stop();
console.log(failed ? `\nFAIL on ${failed} path(s)` : '\nPASS all paths');
process.exit(failed ? 1 : 0);
