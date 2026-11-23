// Deterministic playtest harness.
//   window.__game        state hook + control API for bots and the animation lab
//   ?seed=N              world seed        ?clock=fixed   fixed 1/60 s frames
//   ?patch-test=1        self-checks printed as `pass <name>` / `fail <name>: why`
import * as THREE from 'three';
import { time } from '../core/time';
import { buildPlan } from '../creature/build';
import { fromSeed } from '../creature/genome';
import { planFromInput } from '../creature/codes';
import { encodeDesign, randomDesign } from '../creature/design';
import type { Entry } from '../creature/herd';
import type { Game } from '../game';
import { COURSE } from '../world/course';
import { EPIC, memberCode, SPECIES, starterCode } from '../play/species';

/** ?mode=play&patch-test=1 runs these instead */
export const PLAY_CHECKS = ['boot', 'render', 'hatch', 'walk', 'planted-feet', 'drawn', 'trample', 'eat', 'encounter', 'combat', 'dex', 'audio'] as const;
export const CHECKS = ['boot', 'render', 'hatch', 'walk', 'planted-feet', 'no-floating', 'drawn', 'trample', 'mutate', 'breed', 'dex', 'audio'] as const;

export interface GameHook {
	version: string;
	ready: boolean;
	manual: boolean;
	state(): ReturnType<Game['state']>;
	step(n?: number): ReturnType<Game['state']>;
	play(): void;
	start(): void;
	list(): ReturnType<Game['list']>;
	screenOf(id: number): ReturnType<Game['screenOf']>;
	select(id: number): boolean;
	hatch(input?: string): number;
	mutate(strength?: 'subtle' | 'wild'): Promise<number | null>;
	breed(a: number, b: number): number | null;
	follow(on: boolean): void;
	drive(dx: number, dz: number, speed: number): void;
	look(yaw: number, pitch: number, dist: number, x?: number, z?: number): void;
	isFlat(): Promise<{ flat: boolean; spread: number }>;
	events(n?: number): Game['events'];
	lab: Lab;
	audit(): ReturnType<typeof visibilityAudit>;
	/** a random editor build (same generator as Randomise), as its share code */
	designCode(seed: string): string;
	/** the starter, the island species and the epic, as share codes */
	speciesCodes(): Array<{ name: string; code: string }>;
	/** a gene value of a seed's genome (look-dev: find a seed per mouth type) */
	gene(seed: number, name: string): number;
	checks: Record<string, string>;
	errors: string[];
	game: Game;
}

export function installErrorCapture(): string[] {
	const errors: string[] = [];
	addEventListener('error', (e) => errors.push(`error: ${e.message}`));
	addEventListener('unhandledrejection', (e) => errors.push(`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
	const orig = console.error.bind(console);
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(' ').slice(0, 300));
		orig(...args);
	};
	return errors;
}

/**
 * The animation lab: puts one creature on a course (up the big hill's steep side, a hairpin turn, down, a
 * stop, a turn on the spot, a run over rocks) under fixed 1/60 s steps, and reports the quality metrics.
 */
export class Lab {
	entry: Entry | null = null;
	private waypoints: THREE.Vector3[] = [];
	private wi = 0;
	private t = 0;
	private stopT = 0;
	constructor(private game: Game) {}

	course() {
		const W = this.game.world;
		return COURSE.map(([x, z]) => new THREE.Vector3(x, W.ground(x, z), z));
	}

	/** Spawn a creature at the course start (instant, no egg), wait for its mesh. */
	async begin(input: string | number) {
		const g = this.game;
		g.herd.clear();
		const genes = typeof input === 'number' ? fromSeed(input) : planFromInput(input);
		this.waypoints = this.course();
		const s = this.waypoints[0];
		const dir = this.waypoints[1].clone().sub(s);
		const e = g.herd.spawn(genes, s.x, s.z, { instant: true, yaw: Math.atan2(dir.x, dir.z) });
		e.brain.state = 'scripted';
		this.entry = e;
		this.wi = 1;
		this.t = 0;
		this.stopT = 0;
		await g.pool.geometry(e.c.plan.code);
		for (let i = 0; i < 5 && !e.c.mesh; i++) await new Promise((r) => setTimeout(r, 20));
		g.herd.measuring = true;
		g.herd.resetMetrics();
		return { name: e.c.plan.name, code: e.c.plan.code, kind: e.c.plan.kind };
	}

	/** Drive along the course for n frames (fixed step). Speeds vary: walk, run, stop, turn in place. */
	drive(n: number) {
		const e = this.entry;
		if (!e) return null;
		const c = e.c;
		for (let f = 0; f < n; f++) {
			this.t += 1 / 60;
			const wp = this.waypoints[this.wi];
			if (this.stopT > 0) {
				// stand, then turn on the spot toward the next waypoint
				this.stopT -= 1 / 60;
				c.intentSpeed = 0;
				c.faceTarget = this.stopT < 1.2 ? wp : null;
				c.lookTarget = wp;
			} else if (wp) {
				const d = wp.clone().sub(c.pos).setY(0);
				const dist = d.length();
				d.normalize();
				c.intentDir.set(d.x, d.z);
				const leg = this.wi;
				c.intentSpeed = leg === 2 || leg === 5 ? c.plan.runSpeed * 0.9 : c.plan.walkSpeed * 1.1;
				c.faceTarget = null;
				c.lookTarget = null;
				if (dist < 0.6 + c.plan.R) {
					this.wi++;
					if (this.wi === 4) this.stopT = 2.4;
					if (this.wi >= this.waypoints.length) this.wi = 1;
				}
			}
			this.game.frameSim(1 / 60);
		}
		return this.report();
	}

	report() {
		return this.entry ? this.game.herd.report(this.entry) : null;
	}

	/** Render the current state from a 3/4 camera around the creature (no simulation). */
	shot(yawOff = 2.3, distMul = 1, pitch = 0.3) {
		const e = this.entry;
		if (!e) return;
		const g = this.game;
		const c = e.c;
		g.rig.follow = c;
		const r = Math.max(0.3, c.plan.radius);
		g.rig.goal.copy(c.bodyPos);
		g.rig.goal.y += c.plan.R * 0.4;
		g.rig.target.copy(g.rig.goal);
		g.rig.yaw = c.yaw + yawOff;
		g.rig.pitch = pitch;
		g.rig.dist = g.rig.distGoal = (r * 3.6 + 1.0) * distMul;
		g.rig.update(0);
		g.renderView(1 / 60);
	}

	/** Look-dev camera (no simulation): 'face' close on the head, 'mid' 3/4 body, 'far' in its surroundings. */
	look(kind: 'face' | 'mid' | 'far' | 'mouth', side = 0.45) {
		const e = this.entry;
		if (!e) return;
		const g = this.game;
		const c = e.c;
		const cam = g.camera;
		const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
		const right = new THREE.Vector3(Math.cos(c.yaw), 0, -Math.sin(c.yaw));
		const head = c.headPos.clone();
		const R = c.plan.R;
		let at: THREE.Vector3, D: number;
		if (kind === 'face' || kind === 'mouth') {
			at = head.clone();
			if (kind === 'mouth' && c.mouthWorld) at.copy(c.mouthWorld);
			D = kind === 'mouth' ? R * 2.4 + 0.12 : R * 4.2 + 0.25;
		} else {
			at = c.bodyPos.clone();
			at.y = c.pos.y + c.plan.top * 0.5;
			D = (Math.max(0.3, c.plan.radius) * 3.2 + 0.8) * (kind === 'far' ? 3 : 1);
		}
		const dir = fwd.clone().multiplyScalar(Math.cos(side)).addScaledVector(right, Math.sin(side));
		cam.position.copy(at).addScaledVector(dir, D);
		cam.position.y += D * (kind === 'far' ? 0.35 : kind === 'mid' ? 0.32 : 0.15);
		// above the grass tips, so no blade fills the frame
		const gy = g.world.ground(cam.position.x, cam.position.z) + (kind === 'mid' || kind === 'far' ? 0.55 : 0.1);
		if (cam.position.y < gy) cam.position.y = gy;
		cam.fov = 40;
		cam.updateProjectionMatrix();
		cam.lookAt(at);
		cam.updateMatrixWorld();
		g.rig.target.copy(c.pos);
		g.rig.dist = D;
		g.renderView(0);
	}

	/** Plan-level checks without running: rest-pose sanity for many seeds (fast). */
	plans(from: number, count: number) {
		const out: Array<{ seed: number; kind: string; legs: number; eyes: number; traits: string[] }> = [];
		for (let s = from; s < from + count; s++) {
			const p = buildPlan(fromSeed(s));
			out.push({ seed: s, kind: p.kind, legs: p.legs.length, eyes: p.eyes.length, traits: p.traits });
		}
		return out;
	}
}

export function installHarness(game: Game): GameHook {
	const lab = new Lab(game);
	const find = (id: number) => game.herd.entries.find((e) => e.c.id === id)?.c ?? null;
	const hook: GameHook = {
		version: '1',
		ready: false,
		manual: false,
		state: () => game.state(),
		step(n = 1) {
			hook.manual = true;
			const wasFixed = time.fixed;
			time.fixed = true;
			for (let i = 0; i < n; i++) game.frame();
			time.fixed = wasFixed;
			return game.state();
		},
		play() {
			hook.manual = false;
			time.resync();
		},
		start: () => game.start(),
		list: () => game.list(),
		screenOf: (id) => game.screenOf(id),
		select(id) {
			const c = find(id);
			game.select(c);
			return !!c;
		},
		hatch(input) {
			const e = input ? game.hatchInput(input) : game.hatchRandom();
			return e ? e.c.id : -1;
		},
		async mutate(strength) {
			return (await game.mutateSelected(strength))?.c.id ?? null;
		},
		breed(a, b) {
			const ca = find(a),
				cb = find(b);
			if (!ca || !cb) return null;
			return game.breedPair(ca, cb)?.c.id ?? null;
		},
		follow: (on) => game.setFollow(on),
		drive(dx, dz, speed) {
			const c = game.rig.follow ?? game.selected;
			if (!c) return;
			c.intentDir.set(dx, dz).normalize();
			c.intentSpeed = speed;
		},
		look(yaw, pitch, dist, x, z) {
			game.rig.yaw = yaw;
			game.rig.pitch = pitch;
			game.rig.dist = game.rig.distGoal = dist;
			if (x !== undefined && z !== undefined) {
				game.rig.goal.set(x, game.world.ground(x, z) + 0.6, z);
				game.rig.target.copy(game.rig.goal);
			}
		},
		isFlat: () => game.path.isFlat(),
		events: (n = 50) => game.events.slice(-n),
		lab,
		audit: () => visibilityAudit(game),
		designCode: (seed) => encodeDesign(randomDesign(seed)),
		gene: (seed, name) => (fromSeed(seed) as unknown as Record<string, number>)[name],
		speciesCodes: () => [{ name: 'starter', code: starterCode() }, ...[...SPECIES, EPIC].flatMap((sp) => [{ name: sp.id, code: memberCode(sp) }, { name: `${sp.id}-young`, code: memberCode(sp, 0.72) }]), { name: 'snapjaw-tutorial', code: memberCode(SPECIES[3], 0.88) }],
		checks: {},
		errors: game.errors,
		game,
	};
	(window as unknown as { __game: GameHook }).__game = hook;
	return hook;
}

/**
 * Every creature in view is really drawn, and every grass-trample / contact-shadow blob sits under a drawn creature.
 *  - ID render: each creature body gets a flat ID colour, everything else is hidden, the frame is read back and
 *    every on-screen creature must own pixels (a culled or meshless body owns none).
 *  - Contact map read-back: at each drawn creature the map must be occupied, and no occupied texel may be more
 *    than a body-length from a drawn creature (a mirrored or stale map leaves trample with nobody on it).
 */
export function visibilityAudit(game: Game) {
	const R = game.path.renderer as THREE.WebGLRenderer;
	const cam = game.camera;
	game.renderView(0);
	const W = Math.max(64, Math.floor(R.domElement.width / 4)),
		H = Math.max(36, Math.floor(R.domElement.height / 4));
	const rt = new THREE.WebGLRenderTarget(W, H);
	const saved = new Map<THREE.Object3D, { visible: boolean; material?: THREE.Material | THREE.Material[] }>();
	const bodies = new Map<THREE.Object3D, number>();
	game.herd.entries.forEach((e, i) => {
		if (e.c.mesh) bodies.set(e.c.mesh, i + 1);
	});
	game.scene.traverse((o) => {
		const m = o as THREE.Mesh;
		if (!m.isMesh) return;
		saved.set(o, { visible: o.visible, material: m.material });
		const id = bodies.get(o);
		if (id === undefined) o.visible = false;
		else m.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(id / 255, 170 / 255, 0, THREE.LinearSRGBColorSpace), fog: false });
	});
	const fog = game.scene.fog;
	game.scene.fog = null;
	const bg = game.scene.background;
	game.scene.background = null;
	R.setRenderTarget(rt);
	R.setClearColor(0x000000, 0);
	R.clear(true, true, true);
	R.render(game.scene, cam);
	const px = new Uint8Array(W * H * 4);
	R.readRenderTargetPixels(rt, 0, 0, W, H, px);
	R.setRenderTarget(null);
	rt.dispose();
	game.scene.fog = fog;
	game.scene.background = bg;
	for (const [o, sv] of saved) {
		o.visible = sv.visible;
		if (sv.material && bodies.has(o)) {
			((o as THREE.Mesh).material as THREE.Material).dispose();
			(o as THREE.Mesh).material = sv.material;
		}
	}
	const owned = new Map<number, number>();
	for (let i = 0; i < px.length; i += 4) if (px[i + 1] > 150 && px[i + 1] < 190 && px[i] > 0) owned.set(px[i], (owned.get(px[i]) ?? 0) + 1);
	const missing: string[] = [];
	let inView = 0;
	const v = new THREE.Vector3();
	game.herd.entries.forEach((e, i) => {
		if (e.egg > 0 || e.c.scaleIn < 1) return;
		v.copy(e.c.bodyPos).project(cam);
		const dist = e.c.bodyPos.distanceTo(cam.position);
		if (Math.abs(v.x) > 0.9 || Math.abs(v.y) > 0.9 || v.z > 1 || dist > 60) return;
		inView++;
		if (!(owned.get(i + 1) ?? 0)) missing.push(`${e.c.plan.name} (${e.c.mesh ? 'mesh not drawn' : 'no mesh'})`);
	});
	// contact map read-back
	game.world.beginContacts(game.rig.target);
	game.herd.contacts();
	const at = game.world.readContacts(R);
	const drawn = game.herd.entries.filter((e) => e.egg > 0 || (e.c.mesh?.visible && e.c.scaleIn > 0.01));
	const undercovered: string[] = [];
	for (const e of drawn) {
		if (e.egg > 0) continue;
		if (at(e.c.pos.x, e.c.pos.z) < 0.1) undercovered.push(e.c.plan.name);
	}
	let orphans = 0,
		samples = 0;
	const cx = game.rig.target.x,
		cz = game.rig.target.z;
	for (let j = 0; j < 64; j++)
		for (let i = 0; i < 64; i++) {
			const x = cx + (i / 63 - 0.5) * 60,
				z = cz + (j / 63 - 0.5) * 60;
			if (at(x, z) < 0.25) continue;
			samples++;
			const near = drawn.some((e) => {
				const p = e.egg > 0 ? e.eggPos : e.c.pos;
				return Math.hypot(p.x - x, p.z - z) < Math.max(e.c.plan.footprint[0], e.c.plan.footprint[1]) * 1.6 + 0.6;
			});
			if (!near) orphans++;
		}
	return { inView, missing, onScreenIds: owned.size, undercovered, tramplePoints: samples, orphanTrample: orphans };
}

/** Self-checks through the game's own actions, then the game keeps running. */
export async function runSelfChecks(game: Game, hook: GameHook) {
	const report = (name: string, ok: boolean, why = '') => {
		hook.checks[name] = ok ? 'pass' : `fail: ${why}`;
		console.log(ok ? `pass ${name}` : `fail ${name}: ${why}`);
	};
	const wait = async (cond: () => boolean, frames: number) => {
		for (let i = 0; i < frames && !cond(); i++) {
			hook.step(1);
			if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
		}
		return cond();
	};
	if (game.play) return runPlayChecks(game, hook, report, wait);
	try {
		if (game.phase === 'title') game.start();
		game.ui.showWelcome(false);
		report('boot', hook.ready, 'not ready');
		const flatP = hook.isFlat();
		hook.step(1);
		const flat = await flatP;
		report('render', !flat.flat, `frame is one flat colour (spread ${flat.spread})`);

		// hatch
		const dex0 = game.dex.entries.length;
		const id = hook.hatch('patch-selftest');
		const hatched = await wait(() => {
			const e = game.herd.entries.find((x) => x.c.id === id);
			return !!e && e.egg === 0 && !!e.c.mesh && e.c.scaleIn >= 1;
		}, 400);
		report('hatch', hatched, 'egg did not hatch into a meshed creature in 400 frames');

		// walk: drive it 4 s and check it moved with real steps
		const c = game.herd.entries.find((x) => x.c.id === id)?.c;
		if (c) {
			game.select(c);
			game.setFollow(true);
			const p0 = c.pos.clone();
			const s0 = c.stepEvents;
			game.herd.measuring = true;
			game.herd.resetMetrics();
			for (let i = 0; i < 240; i++) {
				hook.drive(Math.sin(i / 50), Math.cos(i / 50), c.plan.walkSpeed * 1.2);
				hook.step(1);
				if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
			}
			const moved = c.pos.distanceTo(p0);
			const steps = c.stepEvents - s0;
			report('walk', moved > Math.min(1, c.plan.walkSpeed * 1.5) && (steps > 4 || c.plan.legs.length === 0), `moved ${moved.toFixed(2)} m with ${steps} steps`);
			const e = game.herd.entryOf(c)!;
			const r = game.herd.report(e);
			report('planted-feet', r.slideMaxCm < 1 && r.penetrationCm < 1, `slide ${r.slideMaxCm} cm, penetration ${r.penetrationCm} cm`);
			report('no-floating', r.floatMaxMm < 10, `${r.floatWhat} drifted ${r.floatMaxMm} mm from the skin`);
			game.herd.measuring = false;
			game.setFollow(false);
		} else {
			report('walk', false, 'no creature');
			report('planted-feet', false, 'no creature');
			report('no-floating', false, 'no creature');
		}

		{
			const a = visibilityAudit(game);
			report('drawn', a.missing.length === 0 && a.inView > 0, `${a.missing.length} of ${a.inView} in-view creatures not drawn: ${a.missing.slice(0, 3).join(', ')}`);
			report('trample', a.orphanTrample === 0 && a.undercovered.length === 0, `${a.orphanTrample} trample points with no creature, ${a.undercovered.length} creatures without trample`);
		}

		// mutate
		const mid = await hook.mutate('subtle');
		const m = game.herd.entries.find((x) => x.c.id === mid);
		const ch = (game.origins.get(m?.c.plan.code ?? '')?.changes ?? []).length;
		report('mutate', !!m && !!c && m.c.plan.code !== c.plan.code && ch >= 1, `mutant ${m ? 'differs' : 'missing'}, ${ch} visible changes`);

		// breed with another creature
		const other = game.herd.entries.find((x) => x.c !== c && x.egg === 0);
		const bid = other && c ? hook.breed(c.id, other.c.id) : null;
		const b = game.herd.entries.find((x) => x.c.id === bid);
		report('breed', !!b && !!c && !!other && b.c.plan.code !== c.plan.code && b.c.plan.code !== other.c.plan.code, 'child equals a parent or no partner');
		await wait(() => game.herd.entries.every((x) => x.egg === 0), 400);
		report('dex', game.dex.entries.length > dex0 || game.dex.has(c?.plan.code ?? ''), `dex ${dex0} -> ${game.dex.entries.length}`);

		{
			// recorded sounds: all decoded, none silent
			for (let i = 0; i < 200 && (game.mixer.manifest.length === 0 || game.mixer.loaded < game.mixer.manifest.length); i++) await new Promise((r) => setTimeout(r, 25));
			const lv = game.mixer.levels();
			const silent = Object.entries(lv).filter(([, v]) => v < 0.02).map(([k]) => k);
			report('audio', game.mixer.loaded >= 15 && silent.length === 0, `${game.mixer.loaded}/${game.mixer.manifest.length} recordings decoded, silent: ${silent.join(', ')}`);
		}
		console.log(game.errors.length === 0 ? 'pass no-errors' : `fail no-errors: ${game.errors.slice(0, 3).join(' | ')}`);
	} catch (e) {
		console.log(`fail selftest: ${(e as Error).message}`);
	} finally {
		hook.play();
	}
}

/** Play-mode self-checks: hatch at the nest, walk on the stick, eat, win an encounter, land bites, Dex, sounds. */
async function runPlayChecks(game: Game, hook: GameHook, report: (n: string, ok: boolean, why?: string) => void, wait: (c: () => boolean, f: number) => Promise<boolean>) {
	const pl = game.play!;
	const yieldNow = () => new Promise((r) => setTimeout(r, 0));
	try {
		if (game.phase === 'title') game.start();
		pl.hud.controls(false);
		report('boot', hook.ready, 'not ready');
		const flatP = hook.isFlat();
		hook.step(1);
		const flat = await flatP;
		report('render', !flat.flat, `frame is one flat colour (spread ${flat.spread})`);
		const me = pl.player;
		const hatched = await wait(() => me.e.egg <= 0 && !!me.c.mesh && me.c.scaleIn >= 1, 400);
		report('hatch', hatched, 'your egg did not hatch in 400 frames');
		// walk on the (forced) stick, in a slow circle, measuring the feet
		pl.measure(true);
		const p0 = me.c.pos.clone();
		const s0 = me.c.stepEvents;
		for (let i = 0; i < 240; i++) {
			pl.input.forceMove = { x: Math.sin(i / 60), y: Math.cos(i / 60) };
			hook.step(1);
			if (i % 20 === 0) await yieldNow();
		}
		pl.input.forceMove = null;
		hook.step(30);
		const moved = me.c.pos.distanceTo(p0);
		report('walk', moved > 1 && me.c.stepEvents - s0 > 4, `moved ${moved.toFixed(2)} m, ${me.c.stepEvents - s0} steps`);
		const r = pl.report();
		report('planted-feet', r.slideMaxCm < 1 && r.penetrationCm < 1 && r.pops === 0, `slide ${r.slideMaxCm} cm, penetration ${r.penetrationCm} cm, pops ${r.pops}`);
		pl.measure(false);
		{
			const a = visibilityAudit(game);
			report('drawn', a.missing.length === 0 && a.inView > 0, `${a.missing.length} of ${a.inView} in-view creatures not drawn`);
			report('trample', a.undercovered.length === 0, `${a.undercovered.length} creatures without trample`);
		}
		// eat the nearest fruit
		const f = pl.pantry.nearest(me.c.pos, 200, me.abil.diet);
		if (f) {
			me.c.place(f.pos.x + 0.4, f.pos.z, -Math.PI / 2);
			hook.step(2);
			const h0 = pl.hunger;
			const p = pl.prompt();
			p?.act();
			hook.step(10);
			report('eat', p?.what === 'eat' && pl.hunger > h0 && !f.alive, `prompt ${p?.what}, hunger ${h0.toFixed(2)} -> ${pl.hunger.toFixed(2)}`);
		} else report('eat', me.abil.diet === 'sunshine', 'no fruit on the island');
		// an encounter: greet a Puffmoss, press its moves on the beat
		const puff = pl.actors.find((a) => a.sp?.id === 'puffmoss' && a.alive);
		if (puff) {
			me.c.place(puff.c.pos.x + puff.bodyR + me.bodyR + 0.8, puff.c.pos.z, -Math.PI / 2);
			hook.step(2);
			pl.startEncounter(puff);
			let pressed = -1;
			for (let i = 0; i < 3000 && pl.encounter.active; i++) {
				const run = pl.encounter.active;
				if (run.phase === 'play' && run.idx < run.seq.length && run.idx > pressed && Math.abs(run.t - run.idx * run.beat) < 0.03) {
					run.input(run.seq[run.idx]);
					pressed = run.idx - 1;
				}
				if (run.phase !== 'play') pressed = -1;
				hook.step(1);
				if (i % 30 === 0) await yieldNow();
			}
			report('encounter', pl.allied.has('puffmoss') && pl.pack.length > 0, `allied ${[...pl.allied].join(',') || 'none'}, pack ${pl.pack.length}`);
		} else report('encounter', false, 'no Puffmoss');
		// combat: a young Snapjaw beside you takes your bites (flash, knockback, health down)
		{
			const sj = pl.actors.find((a) => a.sp?.id === 'snapjaw' && a.alive);
			if (sj) {
				sj.c.place(me.c.pos.x + Math.sin(me.c.yaw) * (me.bodyR + sj.bodyR + 0.3), me.c.pos.z + Math.cos(me.c.yaw) * (me.bodyR + sj.bodyR + 0.3), me.c.yaw + Math.PI);
				const hp0 = sj.hp;
				const hits0 = pl.stats.hits;
				for (let k = 0; k < 4; k++) {
					pl.input.press('bite');
					hook.step(40);
					await yieldNow();
				}
				report('combat', sj.hp < hp0 && pl.stats.hits > hits0, `snapjaw hp ${Math.round(hp0)} -> ${Math.round(sj.hp)}, hits ${pl.stats.hits - hits0}`);
			} else report('combat', false, 'no Snapjaw');
		}
		report('dex', game.dex.has(me.c.plan.code) || game.dex.entries.length > 0, `dex ${game.dex.entries.length}`);
		{
			for (let i = 0; i < 200 && (game.mixer.manifest.length === 0 || game.mixer.loaded < game.mixer.manifest.length); i++) await new Promise((r) => setTimeout(r, 25));
			const lv = game.mixer.levels();
			const silent = Object.entries(lv).filter(([, v]) => v < 0.02).map(([k]) => k);
			report('audio', game.mixer.loaded >= 30 && silent.length === 0, `${game.mixer.loaded}/${game.mixer.manifest.length} recordings decoded, silent: ${silent.join(', ')}`);
		}
		console.log(game.errors.length === 0 ? 'pass no-errors' : `fail no-errors: ${game.errors.slice(0, 3).join(' | ')}`);
	} catch (e) {
		console.log(`fail selftest: ${(e as Error).message}`);
	} finally {
		pl.input.forceMove = null;
		hook.play();
	}
}
