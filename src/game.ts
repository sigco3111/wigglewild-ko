// Wigglewild: the game object. Owns the scene, render path, world, herd, camera rig, UI, Dex, audio and FX,
// and runs one frame. Creatures are grown from genomes (src/creature), the island lives in src/world.
import * as THREE from 'three';
import { Mixer } from './audio/mixer';
import { config, type QualityName } from './config';
import { Rng } from './core/rng';
import { time } from './core/time';
import { Batches } from './creature/batches';
import { linearToHex } from './creature/color';
import { Creature as CreatureClass, type Creature } from './creature/creature';
import { breedTracked, mutationOrigins, type Origin as OriginKind, type Strength } from './creature/evolve';
import { encode, fromInput, fromSeed, hashSeed, isCode } from './creature/genome';
import { breedDesigns, mutateDesignCode, planFromCode, planFromInput } from './creature/codes';
import { isDesignCode } from './creature/design';
import type { Plan } from './creature/build';
import type { GeneName } from './creature/genome';
import { type Entry, Herd } from './creature/herd';
import { MeshPool } from './creature/mesh-pool';
import { FX } from './fx';
import { GAME } from './game.config';
import { damp } from './juice/spring';
import { CREATURE_FINISH, toonMaterial, U } from './look/materials';
import { SKIN } from './look/creature-skin';
import { createRenderPath } from './render';
import type { RenderPath } from './render/types';
import { Dex, UI } from './ui/ui';
import { Lab } from './lab/lab';
import { Editor } from './editor/editor';
import { designFromPlan } from './creature/codes';
import { blankDesign, type Design } from './creature/design';
import { World } from './world/world';
import { pickPad } from './play/input';
import { Play } from './play/play';

export type Phase = 'loading' | 'title' | 'playing';
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export interface GameEvent {
	t: number;
	type: string;
	[k: string]: unknown;
}

export interface Origin {
	seed?: string;
	/** parent names (display) and codes (family tree) */
	parents?: string[];
	parentCodes?: string[];
	/** which parent each gene group came from: A, B, mix, or new (mutated) */
	from?: Record<string, OriginKind>;
	/** what a mutation changed, in words */
	changes?: string[];
}

/** Orbit / follow camera with smoothing. */
class CameraRig {
	target = new THREE.Vector3(2, 3, 4);
	goal = new THREE.Vector3(2, 3, 4);
	yaw = 0.6;
	pitch = 0.42;
	dist = 14;
	distGoal = 14;
	follow: Creature | null = null;
	constructor(
		readonly camera: THREE.PerspectiveCamera,
		readonly world: World,
	) {}
	update(dt: number) {
		if (this.follow) {
			const c = this.follow;
			this.goal.copy(c.bodyPos);
			this.goal.y += c.plan.R * 0.4;
		}
		const k = this.follow ? 6 : 10;
		this.target.x = damp(this.target.x, this.goal.x, k, dt);
		this.target.y = damp(this.target.y, this.goal.y, k * 0.7, dt);
		this.target.z = damp(this.target.z, this.goal.z, k, dt);
		this.dist = damp(this.dist, this.distGoal, 8, dt);
		const cp = Math.cos(this.pitch);
		const cam = this.camera;
		cam.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
		const g = this.world.ground(cam.position.x, cam.position.z) + 0.35;
		if (cam.position.y < g) cam.position.y = g;
		cam.lookAt(this.target);
		cam.updateMatrixWorld();
	}
}

export class Game {
	phase: Phase = 'loading';
	readonly scene = new THREE.Scene();
	readonly camera = new THREE.PerspectiveCamera(GAME.fov, innerWidth / innerHeight, 0.1, 1500);
	readonly time = time;
	readonly ui = new UI();
	readonly dex = new Dex();
	readonly mixer = new Mixer();
	readonly events: GameEvent[] = [];
	readonly marks: Record<string, number> = {};
	path!: RenderPath;
	world!: World;
	batches!: Batches;
	pool!: MeshPool;
	herd!: Herd;
	fx!: FX;
	rig!: CameraRig;
	lab!: Lab;
	editor!: Editor;
	play: Play | null = null;
	readonly mode = config.mode;
	bodyMat!: THREE.Material;
	quality: QualityName = 'high';
	selected: Creature | null = null;
	breedPick: Creature | null = null;
	photo = false;
	origins = new Map<string, Origin>();
	rng: Rng;
	frameTimes = new Float32Array(600);
	cpuTimes = new Float32Array(600);
	frameCursor = 0;
	frames = 0;
	errors: string[] = [];
	hatched = 0;
	mutations = 0;
	births = 0;
	private keys = new Set<string>();
	private drag: { x: number; y: number; button: number; moved: boolean; t: number } | null = null;
	private titleT = 0;
	private autoQ = { samples: [] as number[], acc: 0, grace: 4 };
	private portraitQueue: Entry[] = [];
	private portraitRT: THREE.WebGLRenderTarget | null = null;
	private pointers = new Map<number, { x: number; y: number }>();
	private pinch = 0;
	private sinceInput = 0;
	private hintsGiven = new Set<string>();
	stepSounds = 0;
	private keyDriving = false;
	private overlayClass = '';

	constructor(readonly canvas: HTMLCanvasElement) {
		this.rng = new Rng(config.seed);
	}

	mark(name: string) {
		this.marks[name] = Math.round(performance.now());
	}

	async boot() {
		this.mark('boot');
		document.body.classList.add(`mode-${this.mode}`);
		this.ui.progress('렌더러 시작 중', 0.08);
		this.path = await createRenderPath(this.canvas, this.scene, this.camera);
		this.mark('renderer');
		this.resize();
		new ResizeObserver(() => this.resize()).observe(this.canvas);
		// a bright, sunny grade: near-neutral white balance, gentle S-curve, warm halation
		Object.assign(this.path.grade, {
			exposure: 1.02,
			whiteBalance: [1.02, 1.0, 0.98],
			saturation: 1.12,
			splitHighlights: [0.025, 0.018, -0.01],
			splitShadows: [-0.012, 0.004, 0.03],
			curve: 0.22,
			vignette: 0.16,
			aberration: 0.0005,
		});
		Object.assign(this.path.grade.bloom, { enabled: true, strength: 0.14, radius: 0.6, threshold: 0.88, tint: [1, 0.9, 0.75] });

		this.ui.progress('초원 가꾸는 중', 0.25);
		await nextFrame();
		this.world = new World();
		this.scene.add(this.world.root);
		this.scene.fog = new THREE.Fog(new THREE.Color(0.7, 0.86, 0.98), 70, 260);
		this.mark('world');

		this.batches = new Batches();
		this.scene.add(this.batches.root);
		this.bodyMat = toonMaterial({ vertexColors: true }, { key: 'body', ...CREATURE_FINISH, ...SKIN });
		this.pool = new MeshPool();
		this.herd = new Herd(this.world, this.pool, this.batches, this.bodyMat, config.seed);
		this.scene.add(this.herd.root);
		this.fx = new FX(this.path);
		this.scene.add(this.fx.root);
		this.rig = new CameraRig(this.camera, this.world);
		this.lab = new Lab(this);
		this.editor = new Editor(this);
		this.wireHerd();

		// the starting herd
		this.ui.progress('무리 부화 중', 0.4);
		const first: Promise<unknown>[] = [];
		if (this.mode === 'play') {
			this.play = new Play(this);
			first.push(...this.play.setup());
			if (config.timeOfDay !== null) this.play.day.t = config.timeOfDay;
		} else if (!config.lab) {
			const center = new THREE.Vector3(2, 0, 4);
			for (let i = 0; i < config.count; i++) {
				const seed = String(Math.floor(this.rng.next() * 99999));
				const p = this.world.randomLand(() => this.rng.next(), center, 16);
				const e = this.spawnFrom(fromSeed(seed), p.x, p.z, { seed }, true);
				first.push(this.pool.geometry(e.c.plan.code));
			}
			if (config.creature) {
				const g = fromInput(config.creature);
				const e = this.spawnFrom(g, 2, 7, isCode(config.creature) ? {} : { seed: config.creature }, true);
				first.push(this.pool.geometry(e.c.plan.code));
				this.select(e.c);
			}
		}
		let done = 0;
		await Promise.all(first.map((p) => p.then(() => this.ui.progress('무리 부화 중', 0.4 + (0.35 * ++done) / Math.max(1, first.length)))));
		this.mark('herd');
		// settle a few frames so meshes are attached and legs are planted
		this.herd.update(1 / 60, this.rig.target, this.camera.position);

		const q = config.quality === 'auto' ? 'high' : config.quality;
		this.setQuality(q);

		this.ui.progress('셰이더 준비 중', 0.82);
		void this.mixer.preload();
		this.placeTitleCamera(0);
		await this.warmup();
		this.mark('compiled');

		this.phase = 'title';
		this.ui.ready();
		this.wireInput();
		if (config.debug) document.body.classList.add('debug');
	}

	/** Compile every material behind the veil: draw the effects and batches once from several views. */
	private async warmup() {
		const at = new THREE.Vector3(2, this.world.ground(2, 4) + 1, 4);
		this.fx.hatch(at, 1, '#ffd23f');
		this.fx.love(at);
		this.batches.begin();
		this.herd.draw(this.camera);
		this.batches.end();
		this.world.beginContacts(at);
		this.herd.contacts();
		this.world.renderContacts(this.path.renderer);
		this.fx.update(0.016, this.camera);
		await this.path.compile(this.scene, this.camera);
		const saved: THREE.Object3D[] = [];
		this.scene.traverse((o) => {
			if (o.frustumCulled) {
				o.frustumCulled = false;
				saved.push(o);
			}
		});
		for (let i = 0; i < 4; i++) {
			this.camera.position.set(2 + Math.sin(i * 1.7) * 18, 8, 4 + Math.cos(i * 1.7) * 18);
			this.camera.lookAt(2, 2, 4);
			this.camera.updateMatrixWorld();
			this.path.render(0.016);
			await nextFrame();
		}
		for (const o of saved) o.frustumCulled = true;
		this.fx.update(5, this.camera);
	}

	setQuality(q: QualityName) {
		this.quality = q;
		const size = { low: 1024, medium: 2048, high: 4096 }[q];
		if (this.world.sun.shadow.mapSize.x !== size) {
			this.world.sun.shadow.mapSize.setScalar(size);
			this.world.sun.shadow.map?.dispose();
			(this.world.sun.shadow as unknown as { map: null }).map = null;
		}
		this.path.setQuality(q);
		this.world.grass.mesh.geometry.setDrawRange(0, q === 'low' ? 60000 * 3 : Number.POSITIVE_INFINITY);
		this.resize();
		this.events.push({ t: time.elapsed, type: 'quality', q });
	}

	resize() {
		if (!this.path) return;
		const w = this.canvas.clientWidth || innerWidth,
			h = this.canvas.clientHeight || innerHeight;
		const tier = { low: 1, medium: 1.25, high: 1.5 }[this.quality];
		this.path.setSize(w, h, Math.min(devicePixelRatio || 1, tier));
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	start() {
		if (this.phase !== 'title') return;
		this.mixer.unlock();
		this.mixer.play('pop', { bus: 'ui', volume: 0.6 });
		this.canvas.focus();
		this.phase = 'playing';
		this.ui.hideVeil();
		time.resync();
		this.mark('play');
		this.events.push({ t: time.elapsed, type: 'start' });
		this.rig.goal.set(2, this.world.ground(2, 4) + 0.6, 4);
		this.rig.distGoal = 13;
		if (this.play) {
			this.play.start();
			if (config.skipTutorial) this.play.skipTutorial();
			else if (!config.noWelcome) this.play.hud.controls(true);
			return;
		}
		if (!config.noWelcome) this.ui.showWelcome(true);
		else this.queueStarterHints();
	}

	private queueStarterHints() {
		this.ui.tryThis('해 보기: 크리터를 클릭해 만나 보세요');
		this.ui.tryThis('해 보기: N 키로 새 알을 부화시키세요');
	}

	/** add a creature met in Play to the Dex (with its portrait) */
	discover(e: Entry) {
		const c = e.c;
		if (this.dex.has(c.plan.code)) return;
		this.dex.add({ code: c.plan.code, name: c.plan.name, species: c.plan.species, traits: c.plan.traits, at: Date.now() });
		e.discovered = true;
		this.portraitQueue.push(e);
		this.ui.toast(`도감에 새로 등록: <b>${c.plan.name}</b>`, 'var(--paper)');
	}

	/** the editor, the Lab or the Dex is up (Play holds still underneath) */
	get overlayOpen() {
		return this.editor.open || this.lab.open || this.ui.dexOpen;
	}

	/** switch between Play and the Meadow sandbox (a fresh page keeps the two worlds apart) */
	setMode(mode: 'play' | 'meadow') {
		const q = new URLSearchParams(location.search);
		q.set('mode', mode);
		q.delete('patch-test');
		q.set('nowelcome', '1');
		location.search = q.toString();
	}

	/** "Play as": become this creature on the island */
	playAs(code: string) {
		if (this.editor.open) this.closeEditor();
		if (this.lab.open) this.closeLab();
		this.openDex(false);
		if (!this.play) {
			try {
				localStorage.setItem('wigglewild.player', code);
			} catch {}
			this.setMode('play');
			return;
		}
		this.play.playAs(code);
	}

	// ------------------------------------------------------------------ spawning

	spawnFrom(genes: ReturnType<typeof fromSeed> | Plan, x: number, z: number, origin: Origin, instant = false, yaw?: number): Entry {
		const e = this.herd.spawn(genes, x, z, { instant, yaw });
		this.origins.set(e.c.plan.code, { ...this.origins.get(e.c.plan.code), ...origin });
		if (!instant) this.mixer.play('pop', { at: e.eggPos, volume: 0.25, pitch: 0.7 });
		return e;
	}

	/** Spawn point in front of the camera on open ground. */
	spawnPoint(offset = 0): THREE.Vector3 {
		const fwd = new THREE.Vector3(Math.sin(this.rig.yaw + Math.PI), 0, Math.cos(this.rig.yaw + Math.PI));
		const base = this.rig.target.clone().addScaledVector(fwd, -2 + offset);
		for (let i = 0; i < 30; i++) {
			const a = this.rng.next() * Math.PI * 2;
			const r = i === 0 ? 0 : 1 + this.rng.next() * (3 + i * 0.3);
			const x = base.x + Math.cos(a) * r,
				z = base.z + Math.sin(a) * r;
			// keep eggs apart from each other and from creatures
			const crowded = this.herd.entries.some((e) => Math.hypot((e.egg > 0 ? e.eggPos.x : e.c.pos.x) - x, (e.egg > 0 ? e.eggPos.z : e.c.pos.z) - z) < 1.2 + e.c.plan.R * 2);
			if (!crowded && this.world.isOpen(x, z, 0.8)) return new THREE.Vector3(x, this.world.ground(x, z), z);
		}
		return this.world.randomLand(() => this.rng.next(), base, 10);
	}

	hatchRandom() {
		const seed = String(Math.floor(this.rng.next() * 99999));
		const p = this.spawnPoint();
		const e = this.spawnFrom(fromSeed(seed), p.x, p.z, { seed });
		this.events.push({ t: time.elapsed, type: 'hatch-random', seed, code: e.c.plan.code });
		this.hintOnce('dex', '해 보기: Tab 키로 도감을 여세요');
		return e;
	}

	hatchInput(text: string) {
		const t = text.trim();
		if (!t) return null;
		const g = planFromInput(t);
		const p = this.spawnPoint();
		const e = this.spawnFrom(g, p.x, p.z, isCode(t) || isDesignCode(t) ? {} : { seed: t });
		this.events.push({ t: time.elapsed, type: 'hatch-seed', seed: t, code: e.c.plan.code });
		return e;
	}

	mutStrength: Strength = 'subtle';

	/** Mutate the selected creature: the worker picks visible gene changes, and the mutant hatches beside it. */
	async mutateSelected(strength: Strength = this.mutStrength) {
		const c = this.selected;
		if (!c) {
			this.ui.toast('먼저 크리터를 선택하고 M 키를 누르세요', 'var(--yellow)');
			return null;
		}
		this.fx.sparkle(c.bodyPos, c.plan.size, linearToHex(c.plan.palette.accent));
		this.mixer.play('chime', { at: c.bodyPos, volume: 0.7, pitch: strength === 'wild' ? 1.2 : 1.5 });
		const mseed = hashSeed(`${c.plan.code}:${++this.mutations}:${config.seed}`);
		const m = isDesignCode(c.plan.code) ? { ...mutateDesignCode(c.plan.code, mseed), touched: [] as string[] } : await this.pool.mutate(c.plan.code, mseed, strength);
		if (!this.herd.entries.some((e) => e.c === c)) return null;
		const side = new THREE.Vector3(Math.cos(c.yaw), 0, -Math.sin(c.yaw)).multiplyScalar(Math.max(1, c.plan.R * 3 + 0.6));
		let x = c.pos.x + side.x,
			z = c.pos.z + side.z;
		if (!this.world.isOpen(x, z, 0.5)) {
			x = c.pos.x - side.x;
			z = c.pos.z - side.z;
		}
		const origin: Origin = { parents: [c.plan.name], parentCodes: [c.plan.code], from: mutationOrigins(m.touched as GeneName[]), changes: m.changes };
		const e = this.spawnFrom(planFromCode(m.code), x, z, origin, false, c.yaw);
		this.origins.set(e.c.plan.code, origin);
		this.events.push({ t: time.elapsed, type: 'mutate', from: c.plan.code, code: e.c.plan.code, strength, changes: m.changes });
		this.ui.toast(`<b>${c.plan.name}</b> 에게서 ${strength === 'wild' ? '야생 ' : ''}돌연변이가 태어났어요: ${m.changes.join(', ')}`, 'var(--lilac)', 4200);
		this.onMutated?.(e, m.changes);
		return e;
	}
	onMutated: ((e: Entry, changes: string[]) => void) | null = null;

	/** Open a creature (or any genome code) in the Lab. */
	async openLab(c: Creature | string | null) {
		const code = typeof c === 'string' ? c : c?.plan.code;
		if (!code) {
			this.ui.toast('먼저 크리터를 선택하고 L 키를 누르세요', 'var(--yellow)');
			return;
		}
		if (this.photo) this.togglePhoto(false);
		this.openDex(false);
		await this.lab.show(code);
		this.lab.scene.add(this.fx.root);
	}

	/** Open the editor: blank, a design, or any creature (converted to an editable design). */
	async openEditor(start?: Design | Creature | string | null) {
		if (this.lab.open) this.closeLab();
		if (this.photo) this.togglePhoto(false);
		this.openDex(false);
		let d: Design | string | undefined;
		if (!start) d = this.editor.design ?? blankDesign();
		else if (typeof start === 'string') d = designFromPlan(planFromCode(start));
		else if ('plan' in start) d = designFromPlan(start.plan);
		else d = start;
		await this.editor.show(d);
		this.events.push({ t: time.elapsed, type: 'editor-open' });
	}

	closeEditor() {
		this.editor.close();
	}

	closeLab() {
		this.lab.close();
		this.scene.add(this.fx.root);
	}

	rename(c: Creature, name: string) {
		const n = name.trim().slice(0, 18);
		if (!n) return;
		c.plan.name = n;
		const d = this.dex.entries.find((x) => x.code === c.plan.code);
		if (d) {
			d.name = n;
			this.dex.save();
		}
		this.refreshCard();
	}

	startBreed() {
		if (!this.selected) {
			this.ui.toast('먼저 첫 번째 부모를 선택하고 B 키를 누르세요', 'var(--yellow)');
			return;
		}
		this.breedPick = this.selected;
		this.canvas.classList.add('picking');
		this.ui.setHint(`이제 ${this.selected.plan.name}의 짝을 클릭하세요 (Esc 취소)`);
	}

	breedWith(b: Creature) {
		const a = this.breedPick;
		this.breedPick = null;
		this.canvas.classList.remove('picking');
		this.ui.setHint(null);
		if (!a || a === b) return null;
		return this.breedPair(a, b);
	}

	breedPair(a: Creature, b: Creature) {
		const bseed = hashSeed(`${a.plan.code}+${b.plan.code}:${++this.births}`);
		const designs = isDesignCode(a.plan.code) || isDesignCode(b.plan.code);
		const bred = designs ? { genes: null, from: {} as Record<string, OriginKind> } : breedTracked(a.plan.genes, b.plan.genes, bseed);
		const g = designs ? planFromCode(breedDesigns(a.plan, b.plan, bseed)) : bred.genes!;
		const mid = a.pos.clone().lerp(b.pos, 0.5);
		let x = mid.x,
			z = mid.z;
		if (!this.world.isOpen(x, z, 0.4)) {
			const p = this.world.randomLand(() => this.rng.next(), mid, 3);
			x = p.x;
			z = p.z;
		}
		// parents face each other
		for (const [p, q] of [
			[a, b],
			[b, a],
		] as const) {
			const e = this.herd.entryOf(p);
			if (e) {
				e.brain.state = 'idle';
				e.brain.timer = 3;
				e.brain.other = q;
				p.lookTarget = q.headPos;
				p.mood = 'happy';
				p.wag = 1;
			}
			this.fx.love(p.headPos, p.plan.size);
		}
		this.mixer.play('chime', { at: mid, volume: 0.8, duck: 0.2 });
		setTimeout(() => this.mixer.play('chime', { at: mid, volume: 0.7, pitch: 1.26 }), 170);
		const origin: Origin = { parents: [a.plan.name, b.plan.name], parentCodes: [a.plan.code, b.plan.code], from: bred.from };
		const e = this.spawnFrom(g, x, z, origin);
		this.origins.set(e.c.plan.code, origin);
		e.egg += 0.6;
		this.events.push({ t: time.elapsed, type: 'breed', a: a.plan.code, b: b.plan.code, code: e.c.plan.code });
		this.ui.toast(`<b>${a.plan.name}</b> + <b>${b.plan.name}</b> 의 알이 생겼어요!`, 'var(--pink)');
		return e;
	}

	/** A creature's voice: squeaks for small ones, quacks for medium, croaks for big, pitched by size. */
	voice(c: Creature, volume = 0.7) {
		const S = c.plan.size;
		const name = S < 0.8 ? 'squeak' : S < 1.6 ? 'quack' : 'croak';
		const base = name === 'squeak' ? 0.85 / Math.sqrt(S) : name === 'quack' ? 1.25 / Math.sqrt(S) : 1.3 / Math.sqrt(S);
		this.mixer.play(name, { at: c.headPos, volume, pitch: Math.min(2.2, Math.max(0.55, base)) });
	}

	select(c: Creature | null) {
		if (this.selected) this.selected.selected = false;
		this.selected = c;
		if (c) {
			c.selected = true;
			this.voice(c, 0.7);
			this.hintOnce('mutate', 'Try this: press M to mutate it, or B to breed it with another');
			this.hintOnce('follow', 'Try this: press F to follow it, then drive with WASD');
		} else if (this.rig.follow) this.setFollow(false);
		this.refreshCard();
	}

	refreshCard() {
		const c = this.selected;
		const o = c ? this.origins.get(c.plan.code) : undefined;
		this.ui.showCard(c, { seed: o?.seed, parents: o?.parents, following: !!c && this.rig.follow === c, strength: this.mutStrength });
	}

	setFollow(on: boolean) {
		if (on && this.selected) {
			this.rig.follow = this.selected;
			this.herd.driven = this.selected;
			this.rig.distGoal = Math.max(2.6, Math.min(16, this.selected.plan.radius * 6 + 2));
			this.ui.toast(`<b>${this.selected.plan.name}</b> 따라가는 중: WASD 조종, Shift 달리기`, 'var(--teal)');
		} else {
			if (this.rig.follow) this.rig.goal.copy(this.rig.follow.bodyPos);
			this.rig.follow = null;
			this.herd.driven = null;
		}
		this.refreshCard();
	}

	release(c: Creature) {
		if (this.selected === c) this.select(null);
		this.fx.hatch(c.bodyPos, c.plan.size, '#ffffff');
		this.herd.remove(c);
	}

	callHerd() {
		const at = this.rig.follow ? this.rig.follow.pos.clone() : this.rig.target.clone();
		this.herd.call(at);
		this.mixer.play('quack', { volume: 0.5, bus: 'ui', pitch: 1.5 });
		setTimeout(() => this.mixer.play('quack', { volume: 0.45, bus: 'ui', pitch: 1.7 }), 220);
		this.fx.note(at.clone().setY(at.y + 1));
		this.events.push({ t: time.elapsed, type: 'call' });
	}

	togglePhoto(on = !this.photo) {
		this.photo = on;
		document.body.classList.toggle('photo', on);
		if (on) this.ui.setHint(null);
	}

	snapPhoto() {
		this.ui.flash();
		this.mixer.play('ui', { bus: 'ui' });
		this.path.render(0);
		try {
			this.canvas.toBlob((b) => {
				if (!b) return;
				const a = document.createElement('a');
				a.href = URL.createObjectURL(b);
				a.download = `wigglewild-${Date.now()}.png`;
				a.click();
				setTimeout(() => URL.revokeObjectURL(a.href), 2000);
			});
		} catch {}
		this.events.push({ t: time.elapsed, type: 'photo' });
	}

	openDex(on = !this.ui.dexOpen) {
		this.ui.dexEl.classList.toggle('on', on);
		if (on)
			this.ui.renderDex(this.dex, (code, lab) => {
				if (lab === 'play') {
					this.playAs(code);
					return;
				}
				if (lab) {
					void this.openLab(code);
					return;
				}
				if (this.play) {
					this.playAs(code);
					return;
				}
				this.openDex(false);
				const p = this.spawnPoint();
				this.spawnFrom(planFromCode(code), p.x, p.z, this.dex.entries.find((e) => e.code === code)?.seed ? { seed: this.dex.entries.find((e) => e.code === code)!.seed } : {});
			});
	}

	private hintOnce(key: string, text: string) {
		if (this.hintsGiven.has(key)) return;
		this.hintsGiven.add(key);
		this.ui.tryThis(text);
	}

	// ------------------------------------------------------------------ events from the herd

	private wireHerd() {
		this.herd.onHatch = (e) => {
			const c = e.c;
			this.hatched++;
			const at = c.bodyPos.clone();
			at.copy(e.eggPos).setY(e.eggPos.y + c.plan.R);
			this.fx.hatch(at, c.plan.size, linearToHex(c.plan.palette.body));
			this.mixer.play('pop', { at, volume: 0.8, pitch: 1.2 / Math.sqrt(c.plan.size) });
			c.onStep ??= (cc, p, s) => this.onStep(cc, p, s);
			const o = this.origins.get(c.plan.code) ?? {};
			const isNew = this.dex.add({ code: c.plan.code, name: c.plan.name, species: c.plan.species, traits: c.plan.traits, seed: o.seed, parents: o.parents, parentCodes: o.parentCodes, from: o.from, changes: o.changes, at: Date.now() });
			e.discovered = isNew;
			if (isNew && this.phase === 'playing') this.ui.toast(`도감에 새로 등록: <b>${c.plan.name}</b>`, 'var(--paper)');
			this.portraitQueue.push(e);
			this.events.push({ t: time.elapsed, type: 'hatched', code: c.plan.code, kind: c.plan.kind });
		};
		this.herd.onEvent = (type, e, at) => {
			if (type === 'poke') {
				this.voice(e.c, 0.85);
				this.fx.sparkle(at, e.c.plan.size * 0.5, '#ffffff');
			} else if (type === 'play') this.fx.note(at.clone().setY(at.y + e.c.plan.top));
			else if (type === 'flee') this.mixer.play('flap', { at, volume: 0.35, pitch: 1.3 / Math.sqrt(e.c.plan.size) });
		};
		for (const e of this.herd.entries) e.c.onStep = (cc, p, s) => this.onStep(cc, p, s);
	}

	onStep(c: Creature, p: THREE.Vector3, s: number) {
		// soft taps for close creatures (bounded voices), dust for big feet and hops
		if (this.phase !== 'playing') return;
		if (c.plan.size > 1.4 || c.plan.gait.hop) this.fx.dust(p, Math.min(1, s * c.plan.size * 0.6), c.plan.size);
		if (this.stepSounds < 6 && p.distanceTo(this.camera.position) < 12) {
			this.stepSounds++;
			this.mixer.play('step', { at: p, volume: Math.min(0.5, 0.1 + c.plan.size * 0.18), pitch: 1.3 / Math.sqrt(c.plan.size), pitchVar: 0.12 });
		}
	}

	// ------------------------------------------------------------------ input

	private wireInput() {
		const cv = this.canvas;
		this.ui.veil.addEventListener('click', () => this.start());
		const veilBtn = (id: string, fn: () => void) =>
			document.getElementById(id)?.addEventListener('click', (ev) => {
				ev.stopPropagation();
				fn();
			});
		if (!this.play) {
			document.getElementById('veil-play')!.innerHTML = '초원에서 놀기 <kbd>Enter</kbd>';
			document.getElementById('veil-meadow')!.textContent = '섬에서 놀기';
		}
		veilBtn('veil-meadow', () => this.setMode(this.play ? 'meadow' : 'play'));
		veilBtn('veil-build', () => {
			this.start();
			void this.openEditor(this.play ? this.play.player.c : undefined);
		});
		// the mode bar: Play, Editor, Lab, Dex, Meadow
		const bar = document.getElementById('modebar')!;
		bar.querySelector(`[data-mode="${this.mode}"]`)?.classList.add('on');
		bar.addEventListener('click', (ev) => {
			const m = (ev.target as HTMLElement).closest('[data-mode]')?.getAttribute('data-mode');
			if (!m) return;
			ev.stopPropagation();
			this.mixer.play('uiSoft', { bus: 'ui' });
			if (m === 'play') {
				if (!this.play) return this.setMode('play');
				if (this.editor.open) this.closeEditor();
				if (this.lab.open) this.closeLab();
				this.openDex(false);
			} else if (m === 'meadow') {
				if (this.play) this.setMode('meadow');
				else {
					if (this.editor.open) this.closeEditor();
					if (this.lab.open) this.closeLab();
					this.openDex(false);
				}
			} else if (m === 'editor') void this.openEditor(this.play ? this.play.player.c : (this.selected ?? undefined));
			else if (m === 'lab') void this.openLab(this.play ? this.play.player.c : this.selected ?? this.herd.entries.find((e) => e.egg <= 0)?.c ?? null);
			else if (m === 'dex') this.openDex();
		});
		document.getElementById('b-go')!.addEventListener('click', () => this.closeWelcome());
		const on = (id: string, fn: () => void) =>
			document.getElementById(id)!.addEventListener('click', (ev) => {
				ev.stopPropagation();
				this.mixer.play('uiSoft', { bus: 'ui' });
				fn();
			});
		on('b-hatch', () => this.hatchRandom());
		on('b-seed', () => this.hatchInput(this.ui.seedIn.value));
		on('b-mutate', () => void this.mutateSelected());
		on('b-breed', () => this.startBreed());
		on('b-follow', () => this.setFollow(!this.rig.follow));
		on('b-call', () => this.callHerd());
		on('b-dex', () => this.openDex());
		on('b-photo', () => this.togglePhoto());
		on('b-help', () => this.ui.showWelcome(true));
		on('b-build', () => void this.openEditor(this.selected ?? undefined));
		on('b-snap', () => this.snapPhoto());
		on('b-photo-exit', () => this.togglePhoto(false));
		on('b-dex-close', () => this.openDex(false));
		this.ui.counter.addEventListener('click', () => this.openDex(true));
		this.ui.dexEl.addEventListener('click', (e) => {
			if (e.target === this.ui.dexEl) this.openDex(false);
		});
		this.ui.card.addEventListener('click', (ev) => {
			const act = (ev.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
			if (!act || !this.selected) return;
			this.mixer.play('uiSoft', { bus: 'ui' });
			if (act === 'mutate') void this.mutateSelected();
			else if (act === 'subtle' || act === 'wild') {
				this.mutStrength = act;
				this.refreshCard();
			} else if (act === 'lab') this.openLab(this.selected);
			else if (act === 'edit') void this.openEditor(this.selected);
			else if (act === 'breed') this.startBreed();
			else if (act === 'follow') this.setFollow(this.rig.follow !== this.selected);
			else if (act === 'release') this.release(this.selected);
			else if (act === 'copy') {
				const code = this.selected.plan.code;
				navigator.clipboard?.writeText(code).then(
					() => this.ui.toast('코드를 복사했어요: 씨앗 상자에 붙여 넣으면 이 크리터를 다시 부화할 수 있어요'),
					() => this.ui.toast('코드 텍스트를 선택해 복사하세요'),
				);
			}
		});
		this.ui.seedIn.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				this.hatchInput(this.ui.seedIn.value);
				this.ui.seedIn.blur();
			} else if (e.key === 'Escape') this.ui.seedIn.blur();
		});

		addEventListener('keydown', (e) => {
			if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
			if (this.phase === 'title' && (e.code === 'Enter' || e.code === 'Space')) {
				this.start();
				return;
			}
			if (this.phase !== 'playing') return;
			this.sinceInput = 0;
			if (this.editor.open) {
				this.editor.onKey(e);
				return;
			}
			if (this.lab.open) {
				if (e.code === 'KeyE') void this.openEditor(this.lab.creature);
				else if (e.code === 'Escape' || e.code === 'KeyL') this.closeLab();
				else if (e.code === 'KeyM') void this.lab.action(e.shiftKey ? 'wild' : 'mutate');
				else if (e.code === 'KeyP') void this.lab.action('photo');
				return;
			}
			if (this.ui.welcomeOpen) {
				if (e.code === 'Enter' || e.code === 'Escape' || e.code === 'Space') this.closeWelcome();
				return;
			}
			if (e.code === 'Tab') {
				e.preventDefault();
				this.openDex();
				return;
			}
			if (this.ui.dexOpen) {
				if (e.code === 'Escape') this.openDex(false);
				return;
			}
			if (this.play) {
				// Play reads its own keys (src/play/input.ts); Enter closes the controls card
				if (this.play.hud.controlsOpen && (e.code === 'Enter' || e.code === 'Escape' || e.code === 'Space')) {
					e.preventDefault();
					this.play.hud.controls(false);
					this.play.input.clear();
				}
				return;
			}
			if (this.photo) {
				if (e.code === 'Space') {
					e.preventDefault();
					this.snapPhoto();
				}
				if (e.code === 'KeyP' || e.code === 'Escape') this.togglePhoto(false);
			}
			this.keys.add(e.code);
			if (e.repeat) return;
			switch (e.code) {
				case 'KeyN':
					this.hatchRandom();
					break;
				case 'KeyM':
					void this.mutateSelected(e.shiftKey ? 'wild' : this.mutStrength);
					break;
				case 'KeyB':
					this.startBreed();
					break;
				case 'KeyF':
					this.setFollow(!this.rig.follow);
					break;
				case 'KeyC':
					this.callHerd();
					break;
				case 'KeyP':
					if (!this.photo) this.togglePhoto(true);
					break;
				case 'KeyH':
					this.ui.showWelcome(true);
					break;
				case 'KeyL':
					void this.openLab(this.selected);
					break;
				case 'KeyE':
					void this.openEditor(this.selected ?? undefined);
					break;
				case 'Delete':
				case 'Backspace':
					if (this.selected) this.release(this.selected);
					break;
				case 'Escape':
					if (this.breedPick) {
						this.breedPick = null;
						this.canvas.classList.remove('picking');
						this.ui.setHint(null);
					} else this.select(null);
					break;
				case 'Enter':
					this.ui.seedIn.focus();
					break;
				case 'F2':
					this.cycleQuality();
					break;
			}
		});
		addEventListener('keyup', (e) => this.keys.delete(e.code));
		addEventListener('blur', () => this.keys.clear());

		cv.addEventListener('contextmenu', (e) => e.preventDefault());
		cv.addEventListener('dblclick', (e) => {
			if (this.phase !== 'playing' || this.lab.open || this.editor.open || this.play) return;
			const c = this.herd.pick(this.ray(e.clientX, e.clientY));
			if (c) void this.openLab(c);
		});
		cv.addEventListener('pointerdown', (e) => {
			if (this.phase !== 'playing') return;
			if (this.editor.open) {
				this.editor.pointerDown(e.clientX, e.clientY, e.button, e.shiftKey);
				return;
			}
			if (this.play && !this.lab.open) {
				// first click locks the mouse for looking around; then clicks attack
				if (document.pointerLockElement !== cv && !this.play.paused) {
					try {
						const r = cv.requestPointerLock?.() as unknown as Promise<void> | undefined;
						r?.catch?.(() => {});
					} catch {}
				}
				this.play.input.mouseDown(e.button);
				this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, t: performance.now() };
				return;
			}
			this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (this.pointers.size === 2) {
				const [a, b] = [...this.pointers.values()];
				this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
			}
			this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, t: performance.now() };
			try {
				cv.setPointerCapture(e.pointerId);
			} catch {}
		});
		cv.addEventListener('pointermove', (e) => {
			if (this.editor.open) return;
			if (this.play && !this.lab.open) {
				if (this.drag && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
				return;
			}
			if (!this.drag || !this.pointers.has(e.pointerId)) return;
			const prev = this.pointers.get(e.pointerId)!;
			const dx = e.clientX - prev.x,
				dy = e.clientY - prev.y;
			this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (this.pointers.size === 2) {
				const [a, b] = [...this.pointers.values()];
				const d = Math.hypot(a.x - b.x, a.y - b.y);
				if (this.pinch > 0) this.zoom((this.pinch - d) * 0.01);
				this.pinch = d;
				this.drag.moved = true;
				return;
			}
			if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4) this.drag.moved = true;
			if (!this.drag.moved) return;
			cv.classList.add('dragging');
			if (this.lab.open) this.lab.orbit(dx, dy);
			else if (this.drag.button === 2 || e.shiftKey) this.pan(dx, dy);
			else {
				this.rig.yaw -= dx * 0.006;
				this.rig.pitch = Math.max(0.05, Math.min(1.35, this.rig.pitch + dy * 0.005));
			}
			this.sinceInput = 0;
		});
		const up = (e: PointerEvent) => {
			this.pointers.delete(e.pointerId);
			if (this.editor.open) {
				this.drag = null;
				return;
			}
			if (this.play && !this.lab.open) {
				const d = this.drag;
				this.drag = null;
				this.play.input.mouseUp(e.button, !!d && !d.moved && !this.play.paused);
				return;
			}
			if (this.pointers.size < 2) this.pinch = 0;
			cv.classList.remove('dragging');
			const d = this.drag;
			this.drag = null;
			if (!d || d.moved || this.phase !== 'playing') return;
			if (d.button === 0) {
				if (this.lab.open) this.lab.click(e.clientX, e.clientY);
				else this.click(e.clientX, e.clientY);
			}
		};
		cv.addEventListener('pointerup', up);
		cv.addEventListener('pointercancel', up);
		cv.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault();
				if (this.editor.open) this.editor.wheel(e.deltaY, e.clientX, e.clientY);
				else if (this.lab.open) this.lab.zoom(e.deltaY * 0.0012);
				else if (this.play) this.play.cam.zoom = Math.max(0.55, Math.min(2.4, this.play.cam.zoom * Math.exp(e.deltaY * 0.0012)));
				else this.zoom(e.deltaY * 0.0012);
			},
			{ passive: false },
		);
	}

	private closeWelcome() {
		this.ui.showWelcome(false);
		this.queueStarterHints();
	}

	private zoom(d: number) {
		this.rig.distGoal = Math.max(1.6, Math.min(70, this.rig.distGoal * Math.exp(d)));
	}

	private pan(dx: number, dy: number) {
		if (this.rig.follow) this.setFollow(false);
		const s = this.rig.dist * 0.0018;
		const right = new THREE.Vector3(Math.cos(this.rig.yaw), 0, -Math.sin(this.rig.yaw));
		const fwd = new THREE.Vector3(-Math.sin(this.rig.yaw), 0, -Math.cos(this.rig.yaw));
		this.rig.goal.addScaledVector(right, -dx * s).addScaledVector(fwd, dy * s);
		this.clampGoal();
	}

	private clampGoal() {
		const g = this.rig.goal;
		const r = Math.hypot(g.x, g.z);
		const max = this.world.terrain.islandRadius * 1.05;
		if (r > max) g.multiplyScalar(max / r);
		g.y = this.world.ground(g.x, g.z) + 0.6;
	}

	private ray(x: number, y: number) {
		const r = this.canvas.getBoundingClientRect();
		const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
		const rc = new THREE.Raycaster();
		rc.setFromCamera(ndc, this.camera);
		return rc.ray;
	}

	click(x: number, y: number) {
		const c = this.herd.pick(this.ray(x, y));
		if (this.breedPick) {
			if (c && c !== this.breedPick) this.breedWith(c);
			return;
		}
		if (c) {
			if (c === this.selected) this.herd.poke(c);
			else this.select(c);
		} else if (!this.rig.follow) this.select(null);
	}

	cycleQuality() {
		this.autoQ.grace = 1e9;
		const order: QualityName[] = ['high', 'medium', 'low'];
		this.setQuality(order[(order.indexOf(this.quality) + 1) % 3]);
	}

	// ------------------------------------------------------------------ frame

	/** A pad alone gets through the title, the cards and Play's pause menu (see padMenu). */
	private pad = { prev: [] as boolean[], at: 0, open: false, dir: '', repeatAt: 0 };
	/**
	 * A or Start on the title; A, B or Start closes the welcome and controls cards, B or View the Dex; in the pause menu
	 * the D-pad or left stick moves between its buttons, A presses one and B resumes. A button a menu used is ignored in
	 * play until it's let go. The editor, the Lab and the Meadow's tools stay keyboard and mouse.
	 */
	private padMenu() {
		const p = pickPad();
		if (!p) return;
		const prev = this.pad.prev;
		const b = (i: number) => !!p.buttons[i]?.pressed;
		const bp = (i: number) => b(i) && !prev[i];
		this.pad.prev = p.buttons.map((x) => x.pressed);
		const play = this.play;
		const used = () => play?.input.swallow();
		if (this.phase === 'title') {
			if (bp(0) || bp(9)) {
				this.start();
				used();
			}
			return;
		}
		if (this.phase !== 'playing') return;
		if (this.ui.welcomeOpen) {
			if (bp(0) || bp(1) || bp(9)) this.closeWelcome();
			return;
		}
		if (this.ui.dexOpen) {
			if (bp(1) || bp(8)) {
				this.openDex(false);
				used();
			}
			return;
		}
		if (!play || this.editor.open || this.lab.open) return;
		if (play.hud.controlsOpen) {
			if (bp(0) || bp(1) || bp(9)) {
				play.hud.controls(false);
				play.input.clear();
				used();
			}
			return;
		}
		const menu = document.getElementById('ph-pause');
		const items = menu?.classList.contains('on') ? [...menu.querySelectorAll<HTMLElement>('[data-p]')] : [];
		for (const el of document.querySelectorAll('.padfocus')) el.classList.remove('padfocus');
		if (!items.length) {
			this.pad.open = false;
			return;
		}
		if (!this.pad.open) {
			this.pad.open = true;
			this.pad.at = 0;
		}
		const lx = p.axes[0] ?? 0;
		const ly = p.axes[1] ?? 0;
		const dir = b(12) || b(14) || ly < -0.5 || lx < -0.5 ? 'prev' : b(13) || b(15) || ly > 0.5 || lx > 0.5 ? 'next' : '';
		const now = performance.now();
		let step = 0;
		if (dir !== this.pad.dir) {
			this.pad.dir = dir;
			step = dir === 'prev' ? -1 : dir === 'next' ? 1 : 0;
			this.pad.repeatAt = now + 350;
		} else if (dir && now >= this.pad.repeatAt) {
			step = dir === 'prev' ? -1 : 1;
			this.pad.repeatAt = now + 120;
		}
		this.pad.at = (this.pad.at + step + items.length) % items.length;
		const at = items[this.pad.at];
		at.classList.add('padfocus');
		if (bp(0)) {
			at.click();
			used();
		} else if (bp(1)) {
			play.hud.pause(false);
			used();
		}
	}

	frame() {
		const t0 = performance.now();
		time.tick();
		this.padMenu();
		const realDt = time.realDt;
		const dt = Math.min(1 / 20, time.dt);
		this.stepSounds = Math.max(0, this.stepSounds - realDt * 12);
		this.sinceInput += realDt;
		U.uTime.value += dt;

		if (this.phase === 'title') {
			this.titleT += realDt;
			this.placeTitleCamera(this.titleT);
		} else if (this.phase === 'playing') {
			if (this.play) {
				if (!this.overlayOpen) this.play.update(dt, realDt);
			} else {
				this.controls(realDt);
				this.rig.update(realDt);
			}
		}
		// in Play the island holds still while the editor, the Lab, the Dex or the pause menu is open
		if (!(this.play && this.phase === 'playing' && (this.overlayOpen || this.play.paused))) this.herd.update(dt, this.rig.target, this.camera.position);

		const ov = this.editor.open ? 'editor' : this.lab.open ? 'lab' : '';
		if (ov !== this.overlayClass) {
			document.body.classList.toggle('editor-open', ov === 'editor');
			document.body.classList.toggle('lab-open', ov === 'lab');
			this.overlayClass = ov;
			if (this.play && !ov) this.play.input.clear();
		}
		if (this.editor.open) {
			this.editor.update(realDt);
			this.fx.update(dt, this.editor.camera);
			this.ui.updateHints(realDt);
			this.path.render(dt);
		} else if (this.lab.open) {
			this.lab.update(realDt);
			this.fx.update(dt, this.lab.camera);
			this.ui.updateHints(realDt);
			this.path.render(dt);
		} else this.renderView(dt);
		this.portraits();
		this.autoQuality(realDt);
		this.frames++;
		const ms = performance.now() - t0;
		this.cpuTimes[this.frameCursor % this.cpuTimes.length] = ms;
		this.frameTimes[this.frameCursor++ % this.frameTimes.length] = realDt * 1000;
		if (config.debug && this.frames % 15 === 0) this.debugText(ms);
	}

	/** Contacts, sun box, batches, effects, UI and the render (no simulation). */
	renderView(dt: number) {
		const realDt = time.realDt;
		// contact map and the sun's shadow box follow the focus
		const focus = this.phase === 'title' ? new THREE.Vector3(2, 0, 4) : this.rig.target;
		this.world.fitSun(focus, Math.max(26, Math.min(60, this.rig.dist * 1.6)));
		// draw first (it decides which creatures are visible), then only drawn creatures write contacts
		this.batches.begin();
		this.herd.draw(this.camera);
		if (this.play) {
			this.play.pantry.draw(this.batches, this.camera);
			this.play.effects.draw(this.batches, (x, z) => this.world.ground(x, z));
		}
		this.batches.end();
		this.world.beginContacts(focus);
		this.herd.contacts();
		this.play?.contacts();
		this.world.renderContacts(this.path.renderer);
		U.uFocus.value.set(this.camera.position.x * 0.5 + focus.x * 0.5, this.camera.position.z * 0.5 + focus.z * 0.5);
		this.fx.update(dt, this.camera);
		this.mixer.updateListener(this.camera);
		this.ui.updateHints(realDt);
		if (this.frames % 20 === 0) this.ui.setCounter(this.herd.entries.length, this.dex.entries.length);
		if (this.selected && this.frames % 30 === 0 && !this.herd.entries.some((e) => e.c === this.selected)) this.select(null);
		this.path.render(dt);
	}

	/** Simulation only (the animation lab runs many seeds fast, rendering only the frames it captures). */
	frameSim(dt: number) {
		U.uTime.value += dt;
		this.herd.update(dt, this.rig.target, this.camera.position);
	}

	private controls(dt: number) {
		const k = this.keys;
		let x = 0,
			z = 0;
		if (k.has('KeyW') || k.has('ArrowUp')) z += 1;
		if (k.has('KeyS') || k.has('ArrowDown')) z -= 1;
		if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
		if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
		if (k.has('KeyQ')) this.rig.yaw += dt * 1.6;
		if (k.has('KeyE')) this.rig.yaw -= dt * 1.6;
		const run = k.has('ShiftLeft') || k.has('ShiftRight');
		const yaw = this.rig.yaw;
		// camera forward on the ground plane (the camera looks from yaw toward the target)
		const fx = -Math.sin(yaw),
			fz = -Math.cos(yaw);
		const rx = Math.cos(yaw),
			rz = -Math.sin(yaw);
		const dx = fx * z + rx * x,
			dz = fz * z + rz * x;
		const driven = this.herd.driven;
		if (driven && driven === this.rig.follow) {
			if (x !== 0 || z !== 0) {
				driven.intentDir.set(dx, dz).normalize();
				driven.intentSpeed = run ? driven.plan.runSpeed : driven.plan.walkSpeed * 1.25;
				driven.lookTarget = null;
				this.keyDriving = true;
			} else if (this.keyDriving) {
				driven.intentSpeed = 0;
				this.keyDriving = false;
			}
		} else if (!this.rig.follow && (x !== 0 || z !== 0)) {
			const s = (run ? 26 : 12) * Math.max(0.6, this.rig.dist / 14) * dt;
			const l = Math.hypot(dx, dz);
			this.rig.goal.x += (dx / l) * s;
			this.rig.goal.z += (dz / l) * s;
			this.clampGoal();
		}
	}

	private placeTitleCamera(t: number) {
		const a = 0.9 + t * 0.06;
		this.rig.target.set(2, this.world.ground(2, 4) + 0.8, 4);
		this.rig.goal.copy(this.rig.target);
		this.rig.yaw = a;
		this.rig.pitch = 0.32;
		this.rig.dist = this.rig.distGoal = 15;
		this.rig.update(0);
	}

	private autoQuality(realDt: number) {
		const q = this.autoQ;
		if (config.quality !== 'auto' || this.phase !== 'playing') return;
		if (q.grace > 0) {
			q.grace -= realDt;
			return;
		}
		q.samples.push(realDt * 1000);
		q.acc += realDt;
		if (q.acc < 2) return;
		const s = q.samples.sort((a, b) => a - b);
		const p90 = s[Math.floor(s.length * 0.9)];
		q.samples = [];
		q.acc = 0;
		if (p90 > 19 && this.quality !== 'low') {
			this.setQuality(this.quality === 'high' ? 'medium' : 'low');
			q.grace = 3;
		}
	}

	/** Dex thumbnails: render the live scene from a portrait camera into a small target, once per new creature. */
	private portraits() {
		if (!this.portraitQueue.length) return;
		const e = this.portraitQueue[0];
		if (!this.herd.entries.includes(e)) {
			this.portraitQueue.shift();
			return;
		}
		const c = e.c;
		if (c.scaleIn < 1 || !c.mesh) return;
		this.portraitQueue.shift();
		if (!e.discovered) return;
		// rendered at 2x without MSAA (reading back a multisampled target returns the previous resolve), then halved
		const S = 256;
		if (!this.portraitRT) {
			this.portraitRT = new THREE.WebGLRenderTarget(S, S);
			this.portraitRT.texture.colorSpace = THREE.SRGBColorSpace;
		}
		const cam = new THREE.PerspectiveCamera(35, 1, 0.02, 400);
		const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
		const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
		const r = Math.max(c.plan.radius, c.plan.top - c.pos.y + 0.1, 0.25);
		const center = c.bodyPos.clone();
		center.y = c.pos.y + (c.plan.top) * 0.5;
		cam.position.copy(center).addScaledVector(fwd, r * 2.5).addScaledVector(side, r * 1.3).add(new THREE.Vector3(0, r * 1.3 + 0.15, 0));
		cam.lookAt(center);
		cam.updateMatrixWorld();
		const R = this.path.renderer as THREE.WebGLRenderer;
		// push the fog away rather than removing it (removing it would recompile every material: a 0.5 s hitch)
		const fog = this.scene.fog as THREE.Fog;
		const [fn, ff] = [fog.near, fog.far];
		fog.near = 1e4;
		fog.far = 2e4;
		this.world.grass.mesh.visible = false;
		// only the subject: other bodies hidden, the shared batches rebuilt with just this creature
		const hidden: THREE.Object3D[] = [];
		for (const m of this.herd.root.children) if (m !== c.mesh && m.visible) {
			m.visible = false;
			hidden.push(m);
		}
		this.fx.root.visible = false;
		CreatureClass.view.copy(cam.position);
		this.batches.begin();
		c.draw(this.batches);
		this.batches.end();
		R.setRenderTarget(this.portraitRT);
		// the post chain turns autoClear off; clear colour and depth ourselves or every portrait shows the first
		R.clear(true, true, true);
		R.render(this.scene, cam);
		const px = new Uint8Array(S * S * 4);
		R.readRenderTargetPixels(this.portraitRT, 0, 0, S, S, px);
		R.setRenderTarget(null);
		fog.near = fn;
		fog.far = ff;
		this.world.grass.mesh.visible = true;
		for (const m of hidden) m.visible = true;
		this.fx.root.visible = true;
		this.batches.begin();
		this.herd.draw(this.camera);
		this.batches.end();
		const cv = document.createElement('canvas');
		cv.width = cv.height = S;
		const g = cv.getContext('2d')!;
		const img = g.createImageData(S, S);
		for (let y = 0; y < S; y++) img.data.set(px.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), y * S * 4);
		g.putImageData(img, 0, 0);
		const half = document.createElement('canvas');
		half.width = half.height = S / 2;
		const hg = half.getContext('2d')!;
		hg.imageSmoothingQuality = 'high';
		hg.drawImage(cv, 0, 0, S / 2, S / 2);
		try {
			this.dex.setThumb(c.plan.code, half.toDataURL('image/jpeg', 0.82));
		} catch {}
	}

	private debugText(cpuMs: number) {
		const s = this.path.stats();
		const ft = this.perf();
		this.ui.debug.textContent = `${this.path.backend}\nquality ${this.quality}\nfps ${ft.fps.toFixed(0)}  p95 ${ft.p95.toFixed(1)} ms\ncpu ${cpuMs.toFixed(2)} ms\ncalls ${s.calls}  tris ${s.triangles}\ncreatures ${this.herd.entries.length}  tube verts ${this.batches.tubes.vertexCount}\nmeshed ${this.pool.stats.meshed} avg ${(this.pool.stats.totalMs / Math.max(1, this.pool.stats.meshed)).toFixed(0)} ms`;
	}

	perf() {
		const n = Math.min(this.frames, this.frameTimes.length);
		const arr = Array.from(this.frameTimes.subarray(0, n)).sort((a, b) => a - b);
		const avg = arr.reduce((a, b) => a + b, 0) / Math.max(1, n);
		const cpu = Array.from(this.cpuTimes.subarray(0, n)).sort((a, b) => a - b);
		return {
			fps: avg > 0 ? 1000 / avg : 0,
			cpuP50: +(cpu[Math.floor(n * 0.5)] ?? 0).toFixed(2),
			cpuP95: +(cpu[Math.floor(n * 0.95)] ?? 0).toFixed(2),
			p50: arr[Math.floor(n * 0.5)] ?? 0,
			p95: arr[Math.floor(n * 0.95)] ?? 0,
			max: arr[n - 1] ?? 0,
		};
	}

	state() {
		const walking = this.herd.entries.filter((e) => e.egg === 0 && e.c.speed > 0.05).length;
		return {
			phase: this.phase,
			frame: this.frames,
			time: +time.elapsed.toFixed(3),
			renderer: this.path?.backend,
			quality: this.quality,
			seed: config.seed,
			creatures: this.herd?.entries.length ?? 0,
			eggs: this.herd?.entries.filter((e) => e.egg > 0).length ?? 0,
			meshed: this.herd?.entries.filter((e) => !!e.c.mesh).length ?? 0,
			walking,
			steps: this.herd?.entries.reduce((s, e) => s + e.c.stepEvents, 0) ?? 0,
			selected: this.selected ? { id: this.selected.id, name: this.selected.plan.name, code: this.selected.plan.code } : null,
			following: !!this.rig?.follow,
			dex: this.dex.entries.length,
			hatched: this.hatched,
			photo: this.photo,
			fx: this.fx?.alive ?? 0,
			audio: { state: this.mixer.state, played: this.mixer.played },
			perf: this.perf(),
			marks: this.marks,
			draws: this.path?.stats(),
			errors: this.errors.length,
			mode: this.mode,
			play: this.play?.active ? this.play.snapshot() : null,
		};
	}

	/** Creature list for bots and tools. */
	list() {
		return this.herd.entries.map((e) => ({ id: e.c.id, name: e.c.plan.name, code: e.c.plan.code, kind: e.c.plan.kind, egg: e.egg > 0, x: +e.c.pos.x.toFixed(2), z: +e.c.pos.z.toFixed(2), speed: +e.c.speed.toFixed(2), steps: e.c.stepEvents, state: e.brain.state }));
	}

	/** Screen position of a creature (for bots that click it). */
	screenOf(id: number) {
		const e = this.herd.entries.find((x) => x.c.id === id);
		if (!e) return null;
		const p = e.c.bodyPos.clone().project(this.camera);
		const r = this.canvas.getBoundingClientRect();
		return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, onScreen: Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1 };
	}

	codeOf(c: Creature) {
		return encode(c.plan.genes);
	}
}
