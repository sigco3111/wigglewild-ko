// Runtime flags, read once from the URL.
//   ?quality=low|medium|high|auto   quality tier (default auto)
//   ?seed=123                       world seed: the starting herd and every random hatch (and Math.random)
//   ?creature=<seed or code>        hatch this creature first, selected
//   ?count=12                       size of the starting herd
//   ?clock=fixed                    every frame advances exactly 1/60 s (deterministic captures)
//   ?patch-test=1                   run self-checks and print `pass <name>` / `fail <name>: why`
//   ?debug=1                        perf overlay
//   ?autostart=1                    skip the title veil (bots)
//   ?nowelcome=1                    skip the welcome card
//   ?lab=1                          animation lab: empty meadow, no wandering herd (the harness drives creatures)
//   ?mode=play|meadow               Play (the island, you are the creature; default) or the Meadow sandbox
//                                   (?lab=1 defaults to the meadow; ?patch-test=1 runs the mode's own self-checks)
//   ?time=0.5                       Play: time of day (0..1; 0.5 noon, 0.9 midnight)
//   ?skiptutorial=1                 Play: start with the tutorial done
export type QualityName = 'low' | 'medium' | 'high';

const q = new URLSearchParams(location.search);
const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
	v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export const config = {
	quality: pick(q.get('quality'), ['low', 'medium', 'high', 'auto'] as const, 'auto'),
	seed: Number.parseInt(q.get('seed') ?? '', 10) || Math.floor(Math.random() * 1e6),
	seeded: q.has('seed'),
	creature: q.get('creature'),
	count: Math.max(0, Math.min(60, Number.parseInt(q.get('count') ?? '14', 10) || 0)),
	fixedClock: q.get('clock') === 'fixed',
	patchTest: q.get('patch-test') === '1',
	debug: q.has('debug'),
	autostart: q.has('autostart'),
	noWelcome: q.has('nowelcome') || q.has('autostart'),
	lab: q.has('lab'),
	mode: pick(q.get('mode'), ['play', 'meadow'] as const, q.has('lab') ? 'meadow' : 'play'),
	timeOfDay: q.has('time') ? Math.max(0, Math.min(1, Number(q.get('time')) || 0)) : null,
	skipTutorial: q.has('skiptutorial'),
	reduceMotion: q.has('reduce-motion') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches),
};
