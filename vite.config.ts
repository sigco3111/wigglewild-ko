import { defineConfig } from 'vite';

// Self-contained static build: relative base so dist/ works at any path, no CDN, no module-preload polyfill fetches.
export default defineConfig({
	base: './',
	server: {
		// same isolation as Patch's game host, so SharedArrayBuffer / WASM threads behave the same in dev
		headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
	},
	build: {
		target: 'es2022',
		outDir: 'dist',
		sourcemap: false,
		chunkSizeWarningLimit: 8000,
		modulePreload: { polyfill: false },
	},
});
