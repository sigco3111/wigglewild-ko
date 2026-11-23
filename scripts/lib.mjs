// Shared bits for the Playwright scripts: muted Chromium with WebGPU, the preview server, page probes.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { guard as noPointerLock } from './no-pointer-lock.mjs';
noPointerLock(chromium);

// Which Chromium to use: PATCH_CHROME, or Playwright's own (npx playwright install chromium).
export const CHROME = process.env.PATCH_CHROME;
// Always muted. WebGPU on Windows needs the other three flags.
export const CHROME_ARGS = ['--mute-audio', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const here = dirname(fileURLToPath(import.meta.url));

export function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return fallback;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
}

export function freePort() {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = s.address().port;
			s.close(() => res(p));
		});
	});
}

/** Starts scripts/preview.mjs (game host headers) on a free port; resolves to { url, stop }. */
export async function startPreview(folder) {
	const port = await freePort();
	const child = spawn(process.execPath, [join(here, 'preview.mjs'), folder, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
	await new Promise((res, rej) => {
		child.stdout.on('data', (d) => String(d).includes('http://') && res());
		child.on('exit', (c) => rej(new Error(`preview exited ${c}`)));
	});
	return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

export async function launch({ headed = false } = {}) {
	return chromium.launch({ executablePath: CHROME, headless: !headed, args: CHROME_ARGS });
}

/** Wires console/page errors, failed responses and off-host requests on a page. */
export function watch(page, url) {
	const out = { errors: [], warnings: [], logs: [], offHost: [] };
	const host = new URL(url).host;
	page.on('console', (m) => {
		const t = m.text();
		if (m.type() === 'error') out.errors.push(t);
		else if (m.type() === 'warning') out.warnings.push(t);
		else out.logs.push(t);
	});
	page.on('pageerror', (e) => out.errors.push(`pageerror: ${e.message}`));
	page.on('response', (r) => {
		if (r.status() >= 400) out.errors.push(`HTTP ${r.status()} ${r.url()}`);
	});
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (!['data:', 'blob:'].includes(u.protocol) && u.host !== host) out.offHost.push(r.url());
	});
	return out;
}

/** Long-task + main-thread-block probes; read back with page.evaluate(() => window.__probe). */
export const PROBE_INIT = () => {
	const p = { longtasks: [], blocks: [] };
	window.__probe = p;
	try {
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) p.longtasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) });
		}).observe({ type: 'longtask', buffered: true });
	} catch {}
	let last = performance.now();
	setInterval(() => {
		const n = performance.now();
		if (n - last > 250) p.blocks.push({ at: Math.round(last), ms: Math.round(n - last - 50) });
		last = n;
	}, 50);
};

/**
 * Records the page with CDP screencast frames piped into the system ffmpeg at a constant frame rate.
 * (Playwright's recordVideo needs its own ffmpeg download; this uses the one on PATH and gives h264 directly.)
 */
export async function startRecorder(page, file, { fps = 30, width = 1280, height = 720, ffmpeg = 'ffmpeg' } = {}) {
	const { spawn } = await import('node:child_process');
	const cdp = await page.context().newCDPSession(page);
	const ff = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', file], { stdio: ['pipe', 'ignore', 'inherit'] });
	let latest = null;
	let frames = 0;
	cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
		latest = Buffer.from(data, 'base64');
		frames++;
		cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
	});
	await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
	const timer = setInterval(() => {
		if (latest && ff.stdin.writable) ff.stdin.write(latest);
	}, 1000 / fps);
	return {
		frames: () => frames,
		async stop() {
			clearInterval(timer);
			await cdp.send('Page.stopScreencast').catch(() => {});
			ff.stdin.end();
			await new Promise((r) => ff.on('close', r));
		},
	};
}
