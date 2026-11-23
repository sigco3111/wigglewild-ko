// Runs Patch's submit-time file checks locally (patterns copied from Patch's rules of
// 2026-10-25): PA-110 size, PA-111 native files, PA-120/121 secrets, PA-130 loads from other hosts.
// Also checks the shipping contract: index.html, LICENSE, CREDITS.md, patch-credits.js, relative asset paths.
//   node scripts/check-dist.mjs [dist]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const MB = 1024 * 1024;
const TEXT = new Set(['cfg', 'cjs', 'css', 'csv', 'env', 'htm', 'html', 'ini', 'js', 'json', 'jsx', 'map', 'md', 'mjs', 'svg', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml']);
const PAGE = new Set(['htm', 'html']);
const SCRIPT = new Set(['cjs', 'js', 'jsx', 'mjs', 'ts', 'tsx']);
const NATIVE = new Set(['app', 'bat', 'cmd', 'com', 'dll', 'dylib', 'exe', 'jar', 'msi', 'ps1', 'scr', 'sh', 'so', 'vbs']);
const SECRETS = [
	['a private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
	['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
	['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
	['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
	['a Stripe live key', /\b[rs]k_live_[A-Za-z0-9]{20,}/],
	['an API key (sk-ant)', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
	['an API key (sk-proj)', /\bsk-proj-[A-Za-z0-9_-]{20,}/],
	['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
	['a Patch API key', /\bpch_[A-Za-z0-9_-]{20,}/],
	['an API key (id:secret)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/],
];
const LOADS = [
	{ in: PAGE, how: "an element's src", re: /<(?:script|img|iframe|audio|video|source|embed|object|track|input)\b[^>]*?\s(?:src|data|poster)\s*=\s*["']?((?:https?:|wss?:)?\/\/[^\s"'>]+)/gi },
	{ in: PAGE, how: 'a <link>', re: /<link\b(?=[^>]*\srel\s*=\s*["']?[^"'>]*(?:stylesheet|preload|modulepreload|prefetch|icon|manifest))[^>]*\shref\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)/gi },
	{ in: new Set([...PAGE, 'css']), how: 'CSS', re: /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?((?:https?:)?\/\/[^\s"')]+)/gi },
	{
		in: new Set([...PAGE, ...SCRIPT]),
		how: 'a script',
		re: /(?:\bimport\s*\(\s*|\bimport\b[^;"'`]*?\bfrom\s*|\bimport\s+|\bfetch\s*\(\s*|\bnew\s+(?:WebSocket|EventSource|Worker|SharedWorker)\s*\(\s*|\bsendBeacon\s*\(\s*|\bimportScripts\s*\(\s*|\.open\s*\(\s*["'`][A-Za-z]+["'`]\s*,\s*|\.src\s*=\s*|\blocation(?:\.href)?\s*=\s*)["'`]((?:https?:|wss?:)?\/\/[^"'`\s]+)/g,
	},
];

const files = [];
(function walk(d) {
	for (const n of readdirSync(d)) {
		const f = join(d, n);
		if (statSync(f).isDirectory()) walk(f);
		else files.push({ full: f, path: relative(dist, f).split(sep).join('/'), size: statSync(f).size });
	}
})(dist);

const found = [];
const total = files.reduce((a, f) => a + f.size, 0);
if (total > 500 * MB) found.push(['PA-110', null, `total ${(total / MB).toFixed(1)} MB > 500 MB`]);
let scanned = 0;
const skipped = [];
for (const f of files) {
	const ext = extname(f.path).slice(1).toLowerCase();
	if (NATIVE.has(ext)) found.push(['PA-111', f.path, 'native program']);
	if (/(^|\/)\.env(\.|$)/.test(f.path) || /\.(pem|key|p12|pfx)$/.test(f.path)) found.push(['PA-120', f.path, 'secret file']);
	if (!TEXT.has(ext)) continue;
	if (f.size > 2 * MB) {
		skipped.push(f.path);
		continue;
	}
	scanned += f.size;
	const text = readFileSync(f.full, 'utf8');
	for (const [kind, re] of SECRETS) if (re.test(text)) found.push(['PA-121', f.path, `looks like ${kind}`]);
	for (const rule of LOADS) {
		if (!rule.in.has(ext)) continue;
		for (const m of text.matchAll(rule.re)) found.push(['PA-130', f.path, `loads from ${m[1].slice(0, 80)} (${rule.how})`]);
	}
}
// the big files Patch skips (PA-199) still must not load from other hosts: scan them too, as warnings
const warnings = [];
for (const p of skipped) {
	const text = readFileSync(join(dist, p), 'utf8');
	for (const rule of LOADS) {
		if (!rule.in.has(extname(p).slice(1))) continue;
		for (const m of text.matchAll(rule.re)) warnings.push(`${p}: loads from ${m[1].slice(0, 80)} (${rule.how})`);
	}
}

const need = ['index.html', 'LICENSE', 'CREDITS.md', 'patch-credits.js'];
for (const n of need) if (!files.some((f) => f.path === n)) found.push(['SHIP', n, 'missing']);
const index = files.find((f) => f.path === 'index.html');
if (index) {
	const html = readFileSync(index.full, 'utf8');
	if (!/<script src="patch-credits\.js" defer><\/script>/.test(html)) found.push(['SHIP', 'index.html', 'credits overlay script tag missing']);
	if (/(?:src|href)="\/(?!\/)/.test(html)) found.push(['SHIP', 'index.html', 'absolute /path reference (use base ./)']);
}

const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
console.log(`files ${files.length}, total ${(total / MB).toFixed(2)} MB, scanned ${(scanned / MB).toFixed(2)} MB of text`);
console.log(`largest: ${largest.map((f) => `${f.path} ${(f.size / MB).toFixed(2)} MB`).join(', ')}`);
if (skipped.length) console.log(`PA-199 (info): too big for Patch to scan: ${skipped.join(', ')}`);
for (const w of warnings) console.log(`warning ${w}`);
for (const [id, p, msg] of found) console.log(`${id} ${p ?? ''}: ${msg}`);
if (found.length) {
	console.log(`FAIL ${found.length} blocking finding(s)`);
	process.exit(1);
}
console.log('PASS dist is self-contained and ships the credits, LICENSE and CREDITS.md');
