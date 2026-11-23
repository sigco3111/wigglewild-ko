// Play mode: you are the creature. Owns the island's life (species at their nests, the epic, fruit, the day),
// your creature (third-person control, stamina, health, hunger, abilities), the pack, combat, encounters,
// the first-five-minutes tutorial, and the HUD.
import * as THREE from 'three';
import { time } from '../core/time';
import { planFromCode } from '../creature/codes';
import type { Action } from '../creature/creature';
import { linearToHex } from '../creature/color';
import type { Game } from '../game';
import { ABILITY, type AbilityId, PREDATOR, SOCIAL, type SocialId } from './abilities';
import { Actor, type Attack, COOLDOWN, damageOf, Effects } from './actors';
import { think } from './ai';
import { ThirdPersonCamera } from './camera';
import { EncounterRun } from './encounter';
import { Hud } from './hud';
import { PlayInput } from './input';
import { DayNight, findSpot, makeNest, type Nest, Pantry } from './island';
import { EPIC, memberCode, SPECIES, type Species, starterCode } from './species';

const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const PLAYER_KEY = 'wigglewild.player';

export type Step = 'hatch' | 'eat' | 'meet' | 'fend' | 'explore';

export class Play {
	readonly input: PlayInput;
	readonly cam: ThirdPersonCamera;
	readonly hud: Hud;
	readonly day: DayNight;
	readonly pantry: Pantry;
	readonly effects = new Effects();
	readonly actors: Actor[] = [];
	readonly nests = new Map<string, Nest>();
	readonly allied = new Set<string>();
	readonly pack: Actor[] = [];
	readonly flags = new Set<string>();
	readonly encounter: { active: EncounterRun | null } = { active: null };
	player!: Actor;
	epic: Actor | null = null;
	playerNest!: Nest;
	active = false;
	paused = false;
	stamina = 1;
	private staminaLock = 0;
	hunger = 0.45;
	sprinting = false;
	sneaking = false;
	step: Step = 'hatch';
	stepT = 0;
	lastMove: { move: SocialId; at: number } | null = null;
	private respawns: Array<{ sp: Species; t: number; young: boolean }> = [];
	private faintT = 0;
	private tutorialHunter: Actor | null = null;
	stats = { eaten: 0, befriended: 0, wins: 0, defeated: 0, faints: 0, hits: 0, encounters: 0, epicEscapes: 0, recruited: 0 };
	private rand: () => number;
	private lastFoe: { a: Actor; t: number } | null = null;
	private tmp = new THREE.Vector3();
	private nightWas = false;

	constructor(readonly game: Game) {
		this.input = new PlayInput(game.canvas);
		this.cam = new ThirdPersonCamera(game.camera, game.world, game.camera.fov);
		this.day = new DayNight(game.scene, game.path);
		this.pantry = new Pantry(game.world);
		this.hud = new Hud(this);
		let s = 20261027;
		this.rand = () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 4294967296;
		};
	}

	get herd() {
		return this.game.herd;
	}
	get world() {
		return this.game.world;
	}

	/** Lay out the island: nests, species, the epic, and the player's egg. Returns the mesh promises to wait on. */
	setup(): Promise<unknown>[] {
		const g = this.game;
		this.herd.ownMaterials = true;
		const waits: Promise<unknown>[] = [];
		const nestAt = (id: string, x: number, z: number, r: number, color: [number, number, number], eggs: number) => {
			const p = findSpot(this.world, x, z, r + 1.5, this.rand);
			const n = makeNest(this.world, id, p.x, p.z, r, color, eggs);
			this.world.root.add(n.mesh);
			this.nests.set(id, n);
			return n;
		};
		this.playerNest = nestAt('player', 4, 9, 0.9, [1, 0.9, 0.6], 1);
		for (const sp of [...SPECIES, EPIC]) {
			const plan = planFromCode(memberCode(sp));
			const nest = nestAt(sp.id, sp.nest[0], sp.nest[1], Math.max(0.6, plan.R * 2.2), plan.palette.accent, sp === EPIC ? 2 : 3);
			for (let i = 0; i < sp.count; i++) {
				const young = sp !== EPIC && i === sp.count - 1;
				const a = this.spawnMember(sp, nest, young, true);
				waits.push(g.pool.geometry(a.c.plan.code));
			}
		}
		// your creature: the last one you played as, or the starter
		let code = starterCode();
		try {
			const saved = localStorage.getItem(PLAYER_KEY);
			if (saved && /^[DC]1[A-Za-z0-9_-]+$/.test(saved)) code = saved;
		} catch {}
		this.spawnPlayer(code, true);
		waits.push(g.pool.geometry(this.player.c.plan.code));
		return waits;
	}

	spawnMember(sp: Species, nest: Nest, young: boolean, instant: boolean, at?: THREE.Vector3, scale?: number) {
		const code = memberCode(sp, scale ?? (young ? 0.72 : 1));
		const p = at ?? this.world.randomLand(this.rand, new THREE.Vector3(nest.x, 0, nest.z), 3 + nest.r * 2 + sp.range * 0.25);
		const plan = planFromCode(code);
		plan.name = sp.name;
		plan.species = sp.name;
		const e = this.herd.spawn(plan, p.x, p.z, { instant });
		e.brain.state = 'scripted';
		const a = new Actor(e, sp, nest, 'wild', sp.toughness * (young ? 0.8 : 1));
		a.young = young;
		this.actors.push(a);
		this.wire(a);
		if (sp === EPIC) this.epic = a;
		return a;
	}

	private wire(a: Actor) {
		a.c.onStrike = (_c, what) => this.strike(a, what);
		a.c.onStep = (c, p, s) => {
			if (a.sp === EPIC) {
				// the giant's footfalls shake the ground near you
				const d = p.distanceTo(this.player.c.pos);
				if (d < 26) this.cam.shake(0.12 * (1 - d / 26));
				if (d < 30 && Math.random() < 0.5) this.sound('rumble', a, 0.35 * (1 - d / 30));
				this.game.fx.dust(p, 0.8, c.plan.size);
			} else (this.game as unknown as { onStep(c: unknown, p: unknown, s: number): void }).onStep(c, p, s);
		};
	}

	spawnPlayer(code: string, egg: boolean) {
		const n = this.playerNest;
		const old = this.player;
		const yaw = old ? old.c.yaw : Math.PI * 0.9;
		const x = old && !egg ? old.c.pos.x : n.x + 0.9 + n.r,
			z = old && !egg ? old.c.pos.z : n.z;
		if (old) {
			this.herd.remove(old.c);
			this.actors.splice(this.actors.indexOf(old), 1);
		}
		const e = this.herd.spawn(planFromCode(code), x, z, { instant: !egg, yaw });
		if (egg) {
			e.egg = 1e9; // hatches when the game starts
			e.eggPos.set(n.x, this.world.ground(n.x, n.z) + n.r * 0.15, n.z);
			e.c.place(n.x, n.z, yaw);
		}
		e.brain.state = 'scripted';
		const a = new Actor(e, null, n, 'player', 1.2);
		a.state = 'player';
		this.actors.push(a);
		this.player = a;
		this.wire(a);
		// quick on two legs; many-legged bodies turn at their own pace (fast spins fold their knees)
		const P0 = a.c.plan;
		a.c.turnBoost = P0.legs.length <= 2 ? 1.4 : P0.legs.length <= 4 ? 1.1 : 1;
		try {
			localStorage.setItem(PLAYER_KEY, code);
		} catch {}
		this.cam.snap(a.c);
		this.hud.rebuildAbilities();
		return a;
	}

	/** "Play as": swap your creature for any code (from the editor, the Dex or the Lab); it hatches at your nest. */
	playAs(code: string) {
		const keepHp = this.player ? this.player.hp / this.player.maxHp : 1;
		this.spawnPlayer(code, false);
		const n = this.playerNest;
		this.player.c.place(n.x + n.r + 1, n.z, this.player.c.yaw);
		this.player.e.egg = 1.2;
		this.player.e.eggPos.set(n.x, this.world.ground(n.x, n.z) + n.r * 0.15, n.z);
		this.player.hp = Math.max(1, Math.round(this.player.maxHp * Math.max(0.6, keepHp)));
		this.emit('play-as', { code });
		this.hud.say(`이제 <b>${this.player.c.plan.name}</b>(으)로 플레이해요. 아래에서 새 능력을 확인하세요.`, 'var(--teal)');
	}

	start() {
		this.active = true;
		this.input.enabled = true;
		this.step = 'hatch';
		this.stepT = 0;
		this.player.e.egg = 1.6;
		this.cam.snap(this.player.c);
		this.cam.yaw = Math.PI * 0.15;
		this.cam.pitch = 0.42;
		this.hud.show(true);
		this.hud.objective();
	}

	// ------------------------------------------------------------------ helpers for brains and the HUD

	emit(type: string, extra: Record<string, unknown>) {
		if (type === 'epic-escaped') this.stats.epicEscapes++;
		this.game.events.push({ t: time.elapsed, type, ...extra });
	}

	/** how loud the player is: sneaking halves notice distances, sprinting and fighting stretch them */
	playerNoise() {
		if (this.sneaking) return 0.45;
		let k = 1;
		if (this.sprinting && this.player.c.speed > 0.2) k = 1.35;
		if (this.player.sinceAttack < 2) k = 1.5;
		return k;
	}

	/** hunters only go for you once the tutorial has reached the fight */
	huntsPlayer() {
		return this.step === 'explore' || this.flags.has('fend-done');
	}

	/** near your nest during the tutorial nothing hunts */
	protectedSpot(p: THREE.Vector3) {
		return this.step !== 'explore' && Math.hypot(p.x - this.playerNest.x, p.z - this.playerNest.z) < 16;
	}

	/** the epic's chase speed never quite matches your sprint: you can always get away */
	chaseCap(a: Actor) {
		if (a.sp !== EPIC) return 99;
		return Math.max(0.6, this.player.c.maxSpeed * 0.82);
	}

	playerFoe(): Actor | null {
		if (this.lastFoe && performance.now() - this.lastFoe.t < 6000 && this.lastFoe.a.alive) return this.lastFoe.a;
		const me = this.player;
		if (me.hurtBy && me.sinceHurt < 6 && me.hurtBy.alive && me.hurtBy !== this.epic) return me.hurtBy;
		return null;
	}

	teleportBehind(a: Actor) {
		const me = this.player.c;
		const x = me.pos.x - Math.sin(me.yaw) * 4,
			z = me.pos.z - Math.cos(me.yaw) * 4;
		if (this.world.isOpen(x, z, 0.5)) a.c.place(x, z, me.yaw);
	}

	/** put a straggler just behind the camera (out of view), from where it runs back to you */
	catchUp(a: Actor) {
		const cam = this.game.camera.position;
		const me = this.player.c.pos;
		const dx = cam.x - me.x,
			dz = cam.z - me.z;
		const l = Math.hypot(dx, dz) || 1;
		for (const k of [1.6, 1.3, 1.0, 0.7]) {
			const x = me.x + (dx / l) * (l * k + 1),
				z = me.z + (dz / l) * (l * k + 1);
			if (this.world.isOpen(x, z, 0.5)) {
				a.c.place(x, z, Math.atan2(-dx, -dz));
				return;
			}
		}
		this.teleportBehind(a);
	}

	zzz(a: Actor) {
		const p = this.tmp.copy(a.c.headPos).setY(a.c.headPos.y + a.c.plan.R * 0.8);
		this.game.fx.puffs.emit({ count: 1, at: p, cone: 0.3, dir: new THREE.Vector3(0.3, 1, 0).normalize(), speed: [0.2, 0.35], life: [1.4, 1.8], size: [0.05, 0.08], grow: 2.2, color: '#dfe8ff', alpha: 0.7, drag: 0.5, gravity: -0.1 });
	}

	/** a sound at an actor (or the UI bus), with size-scaled pitch for creature voices */
	sound(name: string, a: Actor | null, volume = 0.7, pitch?: number) {
		const m = this.game.mixer;
		if (!a) {
			m.play(name, { bus: 'ui', volume, pitch: pitch ?? 1 });
			return;
		}
		if (name === 'voice') {
			this.game.voice(a.c, volume);
			return;
		}
		const S = a.size;
		const p = pitch ?? (name === 'growl' || name === 'roar' || name === 'yelp' || name === 'croak' ? Math.min(1.8, Math.max(0.45, 1 / Math.sqrt(S))) : 1);
		m.play(name, { at: a.c.headPos, volume, pitch: p, pitchVar: 0.06 });
	}

	/** the sound of a social move: notes for singing, thumps for dancing, chirps for charming, a fanfare for posing */
	moveSound(m: AbilityId, a: Actor, k: number) {
		const scale = [1, 1.122, 1.26, 1.335, 1.498, 1.682];
		const base = Math.min(1.6, Math.max(0.6, 1 / Math.sqrt(a.size)));
		if (m === 'sing') {
			this.game.mixer.play('chime', { at: a.c.headPos, volume: 0.6, pitch: base * scale[(k * 2) % scale.length] });
			this.game.fx.note(this.tmp.copy(a.c.headPos).setY(a.c.headPos.y + a.c.plan.R));
		} else if (m === 'dance') {
			this.game.mixer.play('thump', { at: a.c.pos, volume: 0.7, pitch: base });
			this.game.fx.dust(a.c.pos, 0.6, a.size);
		} else if (m === 'charm') {
			this.game.voice(a.c, 0.6);
			this.game.fx.love(a.c.headPos, a.size * 0.6);
		} else if (m === 'pose') {
			this.game.mixer.play('confirm', { at: a.c.headPos, volume: 0.5, pitch: base * 0.9 });
			this.game.fx.sparkle(a.c.headPos, a.size * 0.6, '#ffd23f');
		}
	}

	// ------------------------------------------------------------------ combat

	/** start an attack (player or brain); wild ones wind up first, in ai.windup */
	attack(a: Actor, kind: Attack) {
		if (!a.can(kind)) return false;
		const c = a.c;
		a.cd[kind] = COOLDOWN[kind] * (1 - 0.06 * Math.max(0, a.level(kind) - 1));
		a.sinceAttack = 0;
		if (kind === 'charge') {
			c.act('charge', 0.95);
			a.chargeHit.clear();
		} else c.act(kind === 'stomp' ? 'stomp' : kind);
		if (kind === 'bite') {
			// a little lunge
			c.push.x += Math.sin(c.yaw) * (0.8 + c.plan.R * 2);
			c.push.z += Math.cos(c.yaw) * (0.8 + c.plan.R * 2);
			this.sound('whoosh', a, 0.25, 1.4);
		}
		if (kind === 'strike') this.sound('whoosh', a, 0.5, 0.9);
		if (a === this.player) this.cam.kick(kind === 'charge' ? 0 : 1.5);
		return true;
	}

	/** an attack's blow lands now (from the creature's animation) */
	private strike(a: Actor, what: Action) {
		const c = a.c;
		if (what === 'charge') {
			a.charging = 1.4;
			this.sound('whoosh', a, 0.7, 0.75);
			if (a === this.player) this.cam.kick(7);
			return;
		}
		if (what === 'spit') {
			const head = c.headPos;
			let tx = Math.sin(c.yaw),
				tz = Math.cos(c.yaw);
			let ty = 0.12;
			const foe = a === this.player ? this.aimTarget(9) : a.foe;
			if (foe) {
				const d = Math.max(0.5, head.distanceTo(foe.c.bodyPos));
				tx = (foe.c.bodyPos.x - head.x) / d;
				tz = (foe.c.bodyPos.z - head.z) / d;
				ty = (foe.c.bodyPos.y - head.y) / d + d * 0.03;
			}
			const sp = 9;
			this.effects.globs.push({ pos: head.clone(), vel: new THREE.Vector3(tx, ty, tz).normalize().multiplyScalar(sp), from: a, life: 1.6, r: Math.max(0.05, c.plan.R * 0.25) });
			this.sound('spit', a, 0.7);
			return;
		}
		if (what === 'stomp') {
			this.effects.ripples.push({ at: c.pos.clone(), t: 0, R: 5.2, from: a, hit: new Set() });
			this.sound('thump', a, 1, 0.5);
			this.sound('rumble', a, 0.9);
			this.game.fx.dust(c.pos, 1, c.plan.size * 1.5);
			const d = c.pos.distanceTo(this.player.c.pos);
			if (d < 20) this.cam.shake(0.7 * (1 - d / 20));
			return;
		}
		const fwdX = Math.sin(c.yaw),
			fwdZ = Math.cos(c.yaw);
		// a bite lands on one mouthful: the foe it was aimed at (or the nearest thing in front of the mouth)
		const biteOnly = what === 'bite' ? (a === this.player ? this.aimTarget(2.5 + a.bodyR) : a.foe) : null;
		for (const o of this.actors) {
			if (o === a || !o.alive || !this.hostile(a, o)) continue;
			if (what === 'bite') {
				if (biteOnly && o !== biteOnly) continue;
				const hx = c.headPos.x + fwdX * c.plan.R * 0.5,
					hz = c.headPos.z + fwdZ * c.plan.R * 0.5;
				const d = Math.hypot(o.c.bodyPos.x - hx, o.c.bodyPos.z - hz);
				const dy = Math.abs(o.c.bodyPos.y - c.headPos.y);
				if (d < o.bodyR + c.plan.R * 0.9 + 0.25 && dy < o.c.plan.top + 0.5) this.damage(o, damageOf(a, 'bite'), a, 'bite');
			} else if (what === 'strike') {
				const d = flat(o.c.pos, c.pos);
				if (d < o.bodyR + a.bodyR + c.plan.R * 1.4 + 0.6) this.damage(o, damageOf(a, 'strike'), a, 'strike');
			}
		}
		if (what === 'bite') this.sound('chomp', a, 0.6);
		if (what === 'strike') {
			this.game.fx.sparkle(c.bodyPos, a.size * 0.8, '#ffd23f');
			this.effects.ripples.push({ at: c.pos.clone(), t: 0.2, R: a.bodyR + c.plan.R * 1.4 + 0.6, from: a, hit: new Set(this.actors.map((x) => x.id)) });
		}
	}

	/** who may hurt whom */
	hostile(a: Actor, b: Actor) {
		if (a === b) return false;
		const aFriend = a.team === 'player' || a.ally;
		const bFriend = b.team === 'player' || b.ally;
		if (aFriend && bFriend) return false;
		if (aFriend) return true; // you can attack anyone wild (friendly species flinch and run)
		if (bFriend) {
			// wild ones only attack you when they mean it
			return a.foe === b || a.foe === this.player || a.sp === EPIC;
		}
		// wild vs wild: hunters vs their prey, and the epic vs anything
		return a.foe === b || a.sp === EPIC;
	}

	aimTarget(range: number): Actor | null {
		const c = this.player.c;
		let best: Actor | null = null,
			bs = -1e9;
		for (const o of this.actors) {
			if (o === this.player || !o.alive || o.ally) continue;
			const d = flat(o.c.pos, c.pos);
			if (d > range + o.bodyR) continue;
			const ang = Math.atan2(o.c.pos.x - c.pos.x, o.c.pos.z - c.pos.z) - c.yaw;
			const off = Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang)));
			if (off > 1.3) continue;
			const s = -d - off * 2 + (o === this.lastFoe?.a ? 2 : 0) + (o.foe === this.player ? 1.5 : 0);
			if (s > bs) {
				bs = s;
				best = o;
			}
		}
		return best;
	}

	damage(o: Actor, amount: number, from: Actor, kind: Attack) {
		if (!o.alive) return;
		const def = o.abil.level.defence;
		let dmg = amount * (1 - 0.1 * def);
		// you're the hero: wild hits land softer on you (and softer still in the tutorial)
		if (o === this.player) dmg *= this.step !== 'explore' ? 0.45 : 0.7;
		o.hp -= dmg;
		o.sinceHurt = 0;
		o.hurtBy = from;
		o.barT = 4;
		this.stats.hits++;
		const c = o.c;
		if (!c.airborne && o.charging <= 0 && !o.windup) c.act('hit');
		c.flash = 1;
		// knockback, heavier from bigger attackers
		const dx = c.pos.x - from.c.pos.x,
			dz = c.pos.z - from.c.pos.z;
		const dl = Math.hypot(dx, dz) || 1;
		const k = { bite: 1.6, charge: 4.4, strike: 2.8, spit: 0.9, stomp: 4.5 }[kind] * clamp(Math.sqrt(from.size / o.size), 0.4, 2.4);
		c.push.x += (dx / dl) * k;
		c.push.z += (dz / dl) * k;
		// sparks, sounds, a beat of hitstop when you're in it
		const at = this.tmp.copy(c.bodyPos).lerp(from.c.headPos, 0.35);
		this.game.fx.sparkle(at, Math.max(0.5, o.size * 0.7), '#ffffff');
		this.game.fx.puffs.emit({ count: 6, at, cone: Math.PI, speed: [0.5, 1.6], life: [0.25, 0.45], size: [0.06, 0.12], grow: 2, color: '#fffaf0', alpha: 0.8, drag: 5 });
		this.sound('hit', o, Math.min(1, 0.5 + dmg / 40), clamp(1.15 / Math.sqrt(o.size), 0.6, 1.6));
		this.sound('yelp', o, 0.55);
		if (o === this.player || from === this.player) {
			const heavy = kind === 'charge' || kind === 'stomp' || dmg > 25;
			time.hitstop(heavy ? 90 : 50);
			this.cam.shake(o === this.player ? (heavy ? 0.55 : 0.32) : heavy ? 0.3 : 0.16);
		}
		if (from === this.player || from.ally) this.lastFoe = { a: o, t: performance.now() };
		// spikes on the back bite back
		if (kind === 'bite' && def > 0 && from.alive) {
			from.hp -= 1.5 * def;
			from.c.flash = 0.7;
			from.barT = 4;
		}
		this.onHurt(o, from);
		this.emit('hit', { target: o.id, from: from.id, kind, dmg: Math.round(dmg), player: o === this.player ? 'hurt' : from === this.player ? 'hit' : '' });
		if (o.hp <= 0) this.defeat(o, from);
		else if (from.hp <= 0 && from.alive) this.defeat(from, o);
	}

	/** reactions to being hurt: grazers bolt, fighters fight back, the herd defends its own */
	private onHurt(o: Actor, from: Actor) {
		if (o === this.player || o.ally || !o.sp) return;
		if (this.encounter.active?.partner === o) this.endEncounter(false, true);
		const sp = o.sp;
		const low = o.hp < o.maxHp * 0.35;
		const canFight = (['bite', 'charge', 'strike', 'spit', 'stomp'] as Attack[]).some((k) => o.level(k) > 0);
		if (sp.temper === 'epic') {
			o.state = 'chase';
			o.foe = from;
			o.timer = 10;
			return;
		}
		if (low || !canFight || sp.temper === 'shy' || (sp.temper === 'curious' && Math.random() < 0.7)) {
			o.state = 'flee';
			o.threat = from;
			o.timer = 3 + Math.random() * 2;
			o.foe = null;
			if (o === this.tutorialHunter && low) this.fended();
			return;
		}
		o.state = 'attack';
		o.foe = from;
		o.timer = 12;
		// the herd (and the pack) piles in
		if (sp.temper === 'territorial' || sp.temper === 'hunter')
			for (const m of this.actors)
				if (m.sp === sp && m !== o && m.alive && !m.ally && flat(m.c.pos, o.c.pos) < 14 && m.state !== 'attack') {
					m.state = 'attack';
					m.foe = from;
					m.timer = 12;
				}
	}

	private defeat(o: Actor, from: Actor) {
		if (o === this.player) return this.faint();
		o.down = true;
		o.downT = 0;
		o.state = 'down';
		o.c.intentSpeed = 0;
		o.c.sitTarget = 1;
		o.c.mood = 'sleepy';
		o.windup = null;
		o.charging = 0;
		if (o.ally) {
			// your pack never dies: it runs home to rest and comes back
			this.hud.say(`${o.c.plan.name}이(가) 지쳐서 둥지로 돌아가 쉬어요.`, 'var(--yellow)');
		} else {
			this.stats.defeated++;
			if (from === this.player || from.ally) this.stats.wins++;
		}
		if (o === this.tutorialHunter) this.fended();
		this.emit('defeat', { target: o.id, species: o.sp?.id, by: from === this.player ? 'player' : from.ally ? 'ally' : from.sp?.id });
	}

	private faint() {
		const me = this.player;
		if (me.down) return;
		me.down = true;
		me.downT = 0;
		this.faintT = 0;
		this.stats.faints++;
		me.c.intentSpeed = 0;
		me.c.sitTarget = 1;
		me.c.mood = 'sleepy';
		if (this.encounter.active) this.endEncounter(false, true);
		this.hud.faint(true);
		this.sound('faint', null, 0.7);
		this.emit('faint', {});
		for (const a of this.actors) if (a.foe === me) {
			a.foe = null;
			a.state = a.sp === EPIC ? 'roam' : 'idle';
			a.timer = 2;
		}
	}

	private fended() {
		if (this.flags.has('fend-done')) return;
		this.flags.add('fend-done');
		this.emit('fended', {});
	}

	// ------------------------------------------------------------------ friendship

	befriend(partner: Actor) {
		const sp = partner.sp!;
		const first = !this.allied.has(sp.id);
		this.allied.add(sp.id);
		this.stats.befriended++;
		this.flags.add('encounter-done');
		const c = partner.c;
		this.game.fx.love(c.headPos, c.plan.size * 1.4);
		this.game.fx.sparkle(c.headPos, c.plan.size, '#ffd23f');
		this.sound('friend', null, 0.8);
		setTimeout(() => this.game.mixer.play('chime', { bus: 'ui', volume: 0.6, pitch: 1.5 }), 160);
		setTimeout(() => this.game.mixer.play('chime', { bus: 'ui', volume: 0.6, pitch: 2 }), 320);
		for (const m of this.actors) if (m.sp === sp && m.alive) {
			m.state = 'idle';
			m.foe = null;
			m.greetCd = 3 + Math.random() * 4;
		}
		this.emit('befriend', { species: sp.id, first });
		this.game.discover(partner.e);
		// it joins your pack if there's room, or waits at your nest
		this.recruit(partner, true);
	}

	recruit(a: Actor, auto = false) {
		if (a.ally) return;
		if (this.pack.length >= 2) {
			if (!auto) this.hud.say('무리가 가득 찼어요 (지금은 두 마리까지). 나머지는 둥지에서 기다려요.', 'var(--yellow)');
			a.home = this.playerNest;
			a.state = 'home';
			a.timer = 30;
			return;
		}
		a.ally = true;
		a.slot = [0, 1].find((s) => !this.pack.some((p) => p.slot === s)) ?? 0;
		a.state = 'follow';
		this.pack.push(a);
		this.stats.recruited++;
		this.hud.say(`<b>${a.c.plan.name}</b>이(가) 무리에 합류했어요! 친구는 따라다니고, 함께 싸우고, 인사 교환에도 참여해요.`, 'var(--teal)', 4200);
		this.emit('recruit', { species: a.sp?.id, id: a.id });
		this.hud.rebuildPack();
	}

	dismiss(a: Actor) {
		const i = this.pack.indexOf(a);
		if (i < 0) return;
		this.pack.splice(i, 1);
		a.ally = false;
		a.home = this.playerNest;
		a.state = 'home';
		a.timer = 30;
		this.hud.say(`${a.c.plan.name}이(가) 둥지에서 기다려요.`, 'var(--paper)');
		this.hud.rebuildPack();
	}

	startEncounter(a: Actor) {
		if (this.encounter.active || !a.sp?.befriend) return;
		const run = new EncounterRun(this, a);
		this.encounter.active = run;
		a.state = 'encounter';
		a.c.intentSpeed = 0;
		this.cam.pair = a.c;
		this.stats.encounters++;
		this.hud.encounter(true);
		this.sound('confirm', null, 0.6);
		this.emit('encounter', { species: a.sp.id, id: a.id });
		this.game.discover(a.e);
	}

	endEncounter(won: boolean, interrupted = false) {
		const run = this.encounter.active;
		if (!run) return;
		this.encounter.active = null;
		this.cam.pair = null;
		this.hud.encounter(false);
		const a = run.partner;
		if (a.state === 'encounter') {
			a.state = 'idle';
			a.timer = 1;
		}
		if (!won) {
			a.encounterCd = interrupted ? 6 : 20;
			if (!interrupted && a.sp?.temper === 'shy') {
				a.state = 'wander';
				a.timer = 6;
				a.target.set(a.home?.x ?? a.c.pos.x, 0, a.home?.z ?? a.c.pos.z);
			}
		}
		this.player.c.faceTarget = null;
		this.emit('encounter-end', { won, species: a.sp?.id });
	}

	// ------------------------------------------------------------------ the frame

	update(dt: number, realDt: number) {
		if (!this.active) return;
		const me = this.player;
		const inp = this.input;
		inp.poll(realDt);
		if (inp.pressed('pause')) this.hud.pause(!this.paused);
		if (inp.pressed('help')) this.hud.controls();
		if (inp.pressed('dex')) this.game.openDex();
		if (this.paused) {
			inp.endFrame();
			return;
		}
		this.day.update(dt);
		if (this.day.isNight !== this.nightWas) {
			this.nightWas = this.day.isNight;
			this.hud.say(this.day.isNight ? '밤이 찾아왔어요. 대부분 집으로 자러 가요… 하지만 사냥꾼은 깨어 있어요.' : '아침이에요! 섬이 깨어나요.', 'var(--lilac)');
			this.game.mixer.setAmbience(this.day.isNight ? 'night' : 'day');
		}
		this.controlPlayer(dt, realDt);
		// night: fireflies drift up around you, owls call now and then
		if (this.day.night > 0.5) {
			const me = this.player.c;
			if (Math.random() < dt * 6 * this.day.night) {
				const a = Math.random() * Math.PI * 2,
					r = 2 + Math.random() * 9;
				const x = me.pos.x + Math.cos(a) * r,
					z = me.pos.z + Math.sin(a) * r;
				this.game.fx.stars.emit({ count: 1, at: this.tmp.set(x, this.world.ground(x, z) + 0.3 + Math.random() * 1.2, z), cone: Math.PI, speed: [0.05, 0.25], life: [2.5, 4.5], size: [0.035, 0.06], color: '#e9ff7a', colorEnd: '#7dff9a', intensity: 3, drag: 0.4, gravity: -0.05, fadeIn: 0.3 });
			}
			if (Math.random() < dt * 0.05) this.game.mixer.play('owl', { volume: 0.35, pitch: 0.9 + Math.random() * 0.2 });
		}
		// brains
		for (const a of this.actors) {
			a.c.tell = Math.max(0, a.c.tell - dt * 3);
			if (a === me) continue;
			think(this, a, dt);
		}
		if (this.encounter.active) this.encounter.active.update(dt);
		this.tickActors(dt);
		this.tickEffects(dt);
		this.pantry.update(dt);
		this.tickRespawns(dt);
		this.tutorial(dt);
		// camera
		const manual = performance.now() - inp.lookedAt < 1500;
		const foe = this.playerFoe() ?? this.actors.find((a) => a.alive && a.foe === me && (a.state === 'attack' || a.windup) && a !== this.epic) ?? null;
		this.cam.update(me.c, realDt, { lookYaw: inp.look.yaw, lookPitch: inp.look.pitch, manual, sprinting: this.sprinting && me.c.speed > me.c.plan.walkSpeed, charging: me.charging > 0, foe: foe?.c ?? null, threat: this.epic && this.epic.state === 'chase' && this.epic.foe === me && this.epic.c.pos.distanceTo(me.c.pos) < 24 ? this.epic.c : null });
		this.game.rig.target.copy(me.c.pos);
		this.hud.update(realDt);
		inp.endFrame();
	}

	private controlPlayer(dt: number, realDt: number) {
		const me = this.player;
		const c = me.c;
		const P = c.plan;
		const inp = this.input;
		if (me.e.egg > 0) {
			c.intentSpeed = 0;
			// the egg hatches on its own; Space hatches it sooner
			if (inp.pressed('jump') && me.e.egg > 0.3 && me.e.egg < 1e8) me.e.egg = 0.3;
			return;
		}
		if (me.down) {
			this.faintT += dt;
			c.intentSpeed = 0;
			if (this.faintT > 2.6) {
				// wake up at your nest
				const n = this.playerNest;
				c.place(n.x + n.r + 1, n.z, c.yaw);
				me.down = false;
				me.hp = Math.round(me.maxHp * 0.6);
				this.hunger = Math.max(this.hunger, 0.4);
				c.sitTarget = 0;
				c.mood = 'calm';
				this.cam.snap(c);
				this.hud.faint(false);
				for (const a of this.pack) a.c.place(n.x - 1 - a.slot, n.z + 1, c.yaw);
				this.hud.say('둥지에서 안전하게 깨어났어요.', 'var(--teal)');
			}
			return;
		}
		// hunger and health
		const sun = me.abil.diet === 'sunshine';
		if (!sun) this.hunger = Math.max(0, this.hunger - dt / (this.sprinting ? 200 : 360));
		if (this.hunger <= 0) {
			me.hp -= dt * 1.2;
			if (me.hp <= 0) this.faint();
		} else if (me.sinceHurt > 5 && me.hp < me.maxHp) me.hp = Math.min(me.maxHp, me.hp + dt * (this.hunger > 0.3 || sun ? 2.5 : 0.6));

		const enc = this.encounter.active;
		// movement relative to the camera
		const f = this.cam.forward();
		const rx = -f.z,
			rz = f.x;
		let mx = inp.move.x,
			my = inp.move.y;
		const mag = Math.min(1, Math.hypot(mx, my));
		if (enc) {
			// moving away ends an encounter, gently
			if (mag > 0.5 && enc.phase !== 'won') this.leaveT += dt;
			else this.leaveT = 0;
			if (this.leaveT > 0.6) this.endEncounter(false, true);
			mx = my = 0;
		}
		const dx = f.x * my + rx * mx,
			dz = f.z * my + rz * mx;
		this.sneaking = inp.sneak && !enc;
		const wantSprint = inp.sprint && !this.sneaking && mag > 0.2 && this.staminaLock <= 0;
		// stamina: sprinting drains it (more legs on the ground tire less), it comes back when you ease off
		const drain = 0.13 / (0.6 + 0.6 * Math.min(1, P.legs.length / 4));
		if (wantSprint && this.stamina > 0) {
			this.stamina = Math.max(0, this.stamina - drain * dt);
			if (this.stamina <= 0) {
				this.staminaLock = 1.2;
				this.hud.say('숨이 차요!', 'var(--yellow)');
			}
		} else this.stamina = Math.min(1, this.stamina + dt * (c.speed < 0.1 ? 0.3 : 0.18));
		this.staminaLock -= dt;
		this.sprinting = wantSprint && this.stamina > 0;
		c.crouch = this.sneaking ? 1 : 0;
		let speed = 0;
		if (mag > 0.05) {
			// a brisk jog by default (most of the island is crossed at this pace), the full gait at a sprint
			const walk = Math.min(c.maxSpeed, Math.max(P.walkSpeed * 1.35, c.maxSpeed * 0.7));
			speed = this.sneaking ? P.walkSpeed * 0.55 * mag : this.sprinting ? c.maxSpeed * mag : walk * mag;
			c.intentDir.set(dx, dz).normalize();
		}
		// attacks steer toward the nearest foe in front (a gentle aim assist)
		const attacking = c.action === 'bite' || c.action === 'strike' || c.action === 'spit' || (c.action === 'charge' && me.charging <= 0);
		if (attacking) {
			const t = this.aimTarget(3 + me.bodyR);
			if (t) {
				c.intentDir.set(t.c.pos.x - c.pos.x, t.c.pos.z - c.pos.z).normalize();
				speed = Math.max(speed * 0.3, 0.05);
			} else speed *= 0.4;
		}
		if (me.charging > 0) {
			// the rush: full tilt, steerable a little
			speed = c.maxSpeed;
			if (mag > 0.2) {
				const want = Math.atan2(dx, dz);
				c.intentDir.set(Math.sin(c.yaw * 0.7 + want * 0.3), Math.cos(c.yaw * 0.7 + want * 0.3));
			} else c.intentDir.set(Math.sin(c.yaw), Math.cos(c.yaw));
			if (Math.random() < 0.5) this.game.fx.dust(c.pos, 0.6, P.size);
		}
		if (enc) speed = 0;
		c.intentSpeed = speed;
		if (!enc) {
			c.faceTarget = null;
			const foe = this.playerFoe();
			c.lookTarget = foe && flat(foe.c.pos, c.pos) < 10 ? foe.c.headPos : null;
		}
		// jump (and glide while held)
		c.glideHeld = inp.isHeld('jump');
		if (inp.pressed('jump') && !enc && c.action !== 'jump' && !c.airborne) {
			const L = P.legLength || P.R * 1.4;
			const lvl = me.abil.level.jump;
			c.jump(Math.max(0.12, L * (0.3 + 0.13 * lvl)) * (this.sneaking ? 0.6 : 1));
			this.sound('whoosh', me, 0.25, 1.6);
			if (P.wings) this.game.mixer.play('flap', { at: c.pos, volume: 0.5 });
			this.emit('jump', {});
		}
		if (c.gliding && Math.random() < realDt * 3) this.game.mixer.play('flap', { at: c.pos, volume: 0.25, pitch: 0.8 });
		// attacks
		for (const k of PREDATOR) {
			if (!inp.pressed(k)) continue;
			if (enc) continue;
			if (me.level(k) <= 0) {
				this.hud.say(`${ABILITY[k].label}: 아직 사용할 수 없어요. 필요한 부위: ${ABILITY[k].from}. 둥지에서 크리터를 바꾸세요.`, 'var(--yellow)');
				continue;
			}
			if (this.attack(me, k)) this.emit('attack', { kind: k });
		}
		// social moves: in an encounter they're your answers; anywhere else, a show (curious ones copy you)
		for (const m of SOCIAL) {
			if (!inp.pressed(m)) continue;
			if (enc) enc.input(m);
			else if (!c.action || c.action === 'eat') {
				if (me.abil.level[m] <= 0) {
					this.hud.say(`${ABILITY[m].label}: 아직 사용할 수 없어요. 필요한 부위: ${ABILITY[m].from}.`, 'var(--yellow)');
					continue;
				}
				c.act(m);
				this.moveSound(m, me, Math.floor(Math.random() * 4));
				this.lastMove = { move: m, at: performance.now() };
				for (const a of this.pack) if (a.abil.level[m] > 0 && !a.c.action) setTimeout(() => a.c.act(m), 250 + a.slot * 150);
			}
		}
		if (inp.pressed('interact') && !enc) this.interact();
		if (inp.pressed('call')) {
			for (const a of this.pack) this.teleportBehind(a);
		}
		me.sinceAttack += dt;
	}
	private leaveT = 0;

	/** what F / Triangle would do here */
	prompt(): { text: string; act: () => void; what: string } | null {
		const me = this.player;
		if (!me.alive || this.encounter.active) return null;
		const c = me.c;
		// greet a creature
		let best: Actor | null = null,
			bd = 1e9;
		for (const o of this.actors) {
			if (o === me || !o.alive || o.ally || !o.sp) continue;
			const d = flat(o.c.pos, c.pos) - o.bodyR - me.bodyR;
			if (d < 2.2 && d < bd) {
				bd = d;
				best = o;
			}
		}
		if (best) {
			const o = best;
			const sp = o.sp!;
			if (this.allied.has(sp.id)) return { text: `${o.c.plan.name}에게 무리 합류 청하기`, what: 'recruit', act: () => this.recruit(o) };
			if (!sp.befriend) return null;
			const hostileNow = o.state === 'attack' || o.state === 'hunt' || o.state === 'threaten' || o.state === 'flee' || o.state === 'chase';
			if (o.encounterCd > 0) return { text: `${sp.name}: 잠시 쉬는 중`, what: 'wait', act: () => {} };
			if (!hostileNow) return { text: `${sp.name}에게 인사하기`, what: 'greet', act: () => this.startEncounter(o) };
		}
		// eat
		const reach = me.bodyR + 0.55;
		const food = this.pantry.nearest(c.pos, reach + 0.2, me.abil.diet, true);
		if (food) {
			const can = me.abil.diet === 'both' || (food.kind === 'fruit' ? me.abil.diet === 'plants' : me.abil.diet === 'meat');
			if (!can) return { text: me.abil.diet === 'sunshine' ? '입이 없어요: 햇살로 살아요' : food.kind === 'fruit' ? '고기만 먹을 수 있는 입이에요' : '풀만 먹을 수 있는 입이에요', what: 'cant', act: () => {} };
			return { text: food.kind === 'fruit' ? '열매 먹기' : '고기 먹기', what: 'eat', act: () => this.eat(food) };
		}
		// your egg, at your nest
		const n = this.playerNest;
		if (this.step !== 'hatch' && this.step !== 'eat' && Math.hypot(c.pos.x - n.x, c.pos.z - n.z) < n.r + me.bodyR + 1.2) return { text: '크리터 바꾸기 (에디터)', what: 'egg', act: () => void this.game.openEditor(this.player.c) };
		// pack friends: send one home
		for (const a of this.pack) if (flat(a.c.pos, c.pos) < a.bodyR + me.bodyR + 1.2) return { text: `${a.c.plan.name}을(를) 둥지에서 기다리게 하기`, what: 'dismiss', act: () => this.dismiss(a) };
		return null;
	}

	private interact() {
		const p = this.prompt();
		if (p) p.act();
	}

	eat(f: ReturnType<Pantry['nearest']> & {}) {
		const me = this.player;
		const c = me.c;
		c.faceTarget = f.pos;
		c.act('eat', 1.2);
		this.pantry.eat(f);
		const L = Math.max(1, me.abil.level.eat || me.abil.level.bite);
		this.hunger = Math.min(1, this.hunger + (f.kind === 'fruit' ? 0.28 : 0.45) * (0.85 + 0.15 * L));
		me.hp = Math.min(me.maxHp, me.hp + 8);
		this.stats.eaten++;
		this.sound('munch', me, 0.7);
		this.game.fx.bits.emit({ count: 8, at: f.pos.clone().setY(f.pos.y + 0.1), cone: 1, dir: new THREE.Vector3(0, 1, 0), speed: [0.6, 1.4], life: [0.4, 0.7], size: [0.025, 0.05], color: linearToHex(f.color), alpha: 1, gravity: 7, drag: 0.6 });
		this.emit('eat', { kind: f.kind });
	}

	private tickActors(dt: number) {
		for (const a of this.actors) {
			for (const k of Object.keys(a.cd) as Attack[]) a.cd[k] = Math.max(0, a.cd[k] - dt);
			a.sinceHurt += dt;
			a.barT = Math.max(0, a.barT - dt);
			const c = a.c;
			// wind-ups: glow, face the foe, then the move
			if (a.windup) {
				a.windup.t += dt;
				c.tell = Math.max(c.tell, 0.5 + 0.5 * Math.sin(a.windup.t * 30));
				if (a.foe) c.faceTarget = a.foe.c.pos;
				c.intentSpeed = 0;
				if (a.windup.t >= a.windup.dur) {
					const k = a.windup.kind;
					a.windup = null;
					if (a.alive) this.attack(a, k);
				}
			}
			// the rush of a charge: whoever it touches gets bowled over
			c.accelBoost = a.charging > 0 ? 4 : 1;
			if (a.charging > 0) {
				a.charging -= dt;
				if (a !== this.player) {
					c.intentSpeed = c.maxSpeed;
					c.intentDir.set(Math.sin(c.yaw), Math.cos(c.yaw));
					if (a.foe) {
						const want = Math.atan2(a.foe.c.pos.x - c.pos.x, a.foe.c.pos.z - c.pos.z);
						c.intentDir.set(Math.sin(want), Math.cos(want));
					}
				}
				for (const o of this.actors) {
					if (o === a || !o.alive || a.chargeHit.has(o.id) || !this.hostile(a, o)) continue;
					if (flat(o.c.pos, c.pos) < o.bodyR + a.bodyR + 0.45 + c.speed * 0.12) {
						a.chargeHit.add(o.id);
						this.damage(o, damageOf(a, 'charge'), a, 'charge');
						a.charging = Math.min(a.charging, 0.12);
					}
				}
				if (a.charging <= 0) c.intentSpeed = 0;
			}
			// wild ones heal slowly when left alone
			if (a !== this.player && !a.down && a.sinceHurt > 8) a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.02 * dt);
			// defeated: a moment on the ground, then a poof and the food it leaves
			if (a.down && a !== this.player) {
				a.downT += dt;
				if (a.downT > 1.1 && a.e.egg <= 0) {
					const at = c.bodyPos.clone();
					this.game.fx.hatch(at, c.plan.size, '#ffffff');
					this.sound('poof', a, 0.6);
					if (a.ally) {
						const i = this.pack.indexOf(a);
						if (i >= 0) this.pack.splice(i, 1);
						this.respawnAlly(a);
					} else {
						this.pantry.dropMeat(c.pos, 1 + a.size * 1.5);
						if (a.sp) this.respawns.push({ sp: a.sp, t: a.sp === EPIC ? 180 : 50, young: a.young });
						this.removeActor(a);
					}
				}
			}
		}
	}

	private respawnAlly(a: Actor) {
		// friends come back from your nest after a rest, still in the pack
		const sp = a.sp!;
		const slot = a.slot;
		this.removeActor(a);
		setTimeout(() => {
			if (!this.active) return;
			const n = this.playerNest;
			const b = this.spawnMember(sp, this.nests.get(sp.id) ?? n, a.young, false, new THREE.Vector3(n.x - 1.5, 0, n.z + 1));
			b.ally = true;
			b.slot = slot;
			b.state = 'follow';
			if (this.pack.length < 2) this.pack.push(b);
			this.hud.rebuildPack();
		}, 15000);
		this.hud.rebuildPack();
	}

	private removeActor(a: Actor) {
		const i = this.actors.indexOf(a);
		if (i >= 0) this.actors.splice(i, 1);
		this.herd.remove(a.c);
		if (a === this.epic) this.epic = null;
		for (const o of this.actors) {
			if (o.foe === a) o.foe = null;
			if (o.threat === a) o.threat = null;
			if (o.hurtBy === a) o.hurtBy = null;
		}
		if (this.lastFoe?.a === a) this.lastFoe = null;
	}

	private tickRespawns(dt: number) {
		for (let i = this.respawns.length - 1; i >= 0; i--) {
			const r = this.respawns[i];
			r.t -= dt;
			if (r.t > 0) continue;
			this.respawns.splice(i, 1);
			const nest = this.nests.get(r.sp.id);
			if (!nest) continue;
			// a new one hatches at its nest (out of sight if possible)
			const a = this.spawnMember(r.sp, nest, r.young, false);
			void a;
		}
	}

	private tickEffects(dt: number) {
		const W = this.world;
		for (let i = this.effects.globs.length - 1; i >= 0; i--) {
			const g = this.effects.globs[i];
			g.vel.y -= 4 * dt;
			g.pos.addScaledVector(g.vel, dt);
			g.life -= dt;
			let hit = g.life <= 0 || g.pos.y < W.ground(g.pos.x, g.pos.z);
			for (const o of this.actors) {
				if (hit || o === g.from || !o.alive || !this.hostile(g.from, o)) continue;
				if (g.pos.distanceTo(o.c.bodyPos) < o.bodyR + g.r + 0.1) {
					this.damage(o, damageOf(g.from, 'spit'), g.from, 'spit');
					hit = true;
				}
			}
			if (hit) {
				this.game.fx.puffs.emit({ count: 8, at: g.pos, cone: Math.PI, speed: [0.5, 1.5], life: [0.3, 0.5], size: [0.05, 0.1], grow: 2, color: '#9be15d', alpha: 0.85, drag: 4 });
				this.sound('splat', g.from, 0.5);
				this.effects.globs.splice(i, 1);
			}
		}
		for (let i = this.effects.ripples.length - 1; i >= 0; i--) {
			const w = this.effects.ripples[i];
			w.t += dt;
			const rad = w.R * Math.min(1, w.t / 0.45);
			for (const o of this.actors) {
				if (w.hit.has(o.id) || o === w.from || !o.alive || !this.hostile(w.from, o)) continue;
				const d = flat(o.c.pos, w.at);
				if (d < rad + o.bodyR) {
					w.hit.add(o.id);
					// jumping over the ripple dodges it
					if (o.c.airborne) {
						if (o === this.player) this.emit('dodge', {});
						continue;
					}
					this.damage(o, damageOf(w.from, 'stomp') * (1 - 0.5 * (d / (w.R + 1))), w.from, 'stomp');
				}
			}
			if (w.t > 0.65) this.effects.ripples.splice(i, 1);
		}
	}

	// ------------------------------------------------------------------ the first five minutes

	private tutorial(dt: number) {
		this.stepT += dt;
		const me = this.player;
		const ev = (type: string) => this.game.events.some((e) => e.type === type && e.t > this.stepSince);
		switch (this.step) {
			case 'hatch':
				if (me.e.egg <= 0 && me.c.scaleIn >= 1) this.next('eat');
				break;
			case 'eat':
				if (ev('eat') || me.abil.diet === 'sunshine') this.next('meet');
				break;
			case 'meet':
				if (this.allied.has('puffmoss') || (this.stats.befriended > 0 && this.stepT > 1)) this.next('fend');
				break;
			case 'fend':
				if (!this.tutorialHunter && this.stepT > 2.5) this.sendHunter();
				if (this.flags.has('fend-done') && this.stepT > 1) this.next('explore');
				// a stuck tutorial hunter (fell behind, got lost) comes back
				if (this.tutorialHunter && !this.actors.includes(this.tutorialHunter) && !this.flags.has('fend-done')) this.fended();
				break;
		}
	}
	private stepSince = 0;

	private next(s: Step) {
		this.step = s;
		this.stepT = 0;
		this.stepSince = time.elapsed;
		this.emit('step', { step: s });
		this.hud.objective(true);
		if (s === 'explore') this.hud.say('해냈어요! 이제 섬을 탐험하세요: 친구를 사귀거나 싸우거나. 선더백을 조심하세요.', 'var(--teal)', 5000);
	}

	/** ?skiptutorial=1: everything the first five minutes would have done */
	skipTutorial() {
		this.player.e.egg = 0.05;
		this.flags.add('fend-done');
		this.flags.add('encounter-done');
		this.next('explore');
	}

	private sendHunter() {
		const sp = SPECIES.find((s) => s.id === 'snapjaw')!;
		const me = this.player.c;
		// from behind the camera's view edge, a dozen meters off
		let p: THREE.Vector3 | null = null;
		for (let k = 0; k < 24 && !p; k++) {
			const a = this.cam.yaw + Math.PI + (k % 2 ? 1 : -1) * (0.6 + k * 0.08);
			const x = me.pos.x - Math.sin(a) * 11,
				z = me.pos.z - Math.cos(a) * 11;
			if (this.world.isOpen(x, z, 0.8)) p = new THREE.Vector3(x, 0, z);
		}
		p ??= this.world.randomLand(this.rand, me.pos, 10);
		const a = this.spawnMember(sp, this.nests.get('snapjaw')!, true, false, p, 0.88);
		a.state = 'hunt';
		a.foe = this.player;
		a.timer = 60;
		a.hunger = 1;
		this.tutorialHunter = a;
		this.hud.say('어린 <b>스냅조</b>가 당신을 사냥해요! 물기(클릭 / Square)나 돌진으로 맞서세요.', 'var(--pink)', 4200);
		this.sound('growl', a, 0.9);
		this.emit('tutorial-hunter', { id: a.id });
	}

	/** nests press the grass flat (and cast a soft contact shadow) */
	contacts() {
		const W = this.world;
		for (const n of this.nests.values()) W.contact(n.x, n.y, n.z, n.r * 1.35, 0.9);
		this.pantry.contacts(W);
	}

	/** quest marker target for the HUD */
	objectivePos(): THREE.Vector3 | null {
		const me = this.player.c;
		switch (this.step) {
			case 'eat': {
				const f = this.pantry.nearest(me.pos, 80, this.player.abil.diet);
				return f ? f.pos : null;
			}
			case 'meet': {
				let best: Actor | null = null,
					bd = 1e9;
				for (const a of this.actors)
					if (a.sp?.id === 'puffmoss' && a.alive) {
						const d = flat(a.c.pos, me.pos);
						if (d < bd) {
							bd = d;
							best = a;
						}
					}
				return best ? best.c.headPos : null;
			}
			case 'fend':
				return this.tutorialHunter && this.tutorialHunter.alive ? this.tutorialHunter.c.headPos : null;
		}
		return null;
	}

	/** state for bots and the HUD */
	snapshot() {
		const me = this.player;
		const run = this.encounter.active;
		return {
			step: this.step,
			hp: Math.round(me.hp),
			maxHp: me.maxHp,
			hunger: +this.hunger.toFixed(3),
			stamina: +this.stamina.toFixed(3),
			down: me.down,
			egg: me.e.egg > 0,
			pos: { x: +me.c.pos.x.toFixed(2), y: +me.c.pos.y.toFixed(2), z: +me.c.pos.z.toFixed(2) },
			yaw: +me.c.yaw.toFixed(3),
			camYaw: +this.cam.yaw.toFixed(3),
			speed: +me.c.speed.toFixed(2),
			airborne: me.c.airborne,
			gliding: me.c.gliding,
			abilities: me.abil.level,
			diet: me.abil.diet,
			code: me.c.plan.code,
			name: me.c.plan.name,
			allied: [...this.allied],
			pack: this.pack.map((a) => ({ id: a.id, species: a.sp?.id, hp: Math.round(a.hp) })),
			night: +this.day.night.toFixed(2),
			time: +this.day.t.toFixed(3),
			prompt: this.prompt()?.what ?? null,
			encounter: run ? { phase: run.phase, round: run.round, seq: run.seq, idx: run.idx, t: +run.t.toFixed(3), beat: run.beat, meter: Math.round(run.meter), marks: run.marks, partner: run.partner.id, species: run.partner.sp?.id } : null,
			objective: this.objectivePos()?.toArray().map((v) => +v.toFixed(2)) ?? null,
			stats: this.stats,
			actors: this.actors.filter((a) => a !== me).map((a) => ({ id: a.id, species: a.sp?.id ?? 'player', x: +a.c.pos.x.toFixed(2), z: +a.c.pos.z.toFixed(2), hp: Math.round(a.hp), maxHp: a.maxHp, state: a.state, ally: a.ally, alive: a.alive, foe: a.foe === me ? 'player' : a.foe ? a.foe.id : null, young: a.young })),
			nests: [...this.nests.values()].map((n) => ({ id: n.id, x: +n.x.toFixed(2), z: +n.z.toFixed(2) })),
		};
	}

	/** the animation-quality metrics on your creature while you play (same bar as the lab: no slide, no pops) */
	measure(on: boolean) {
		this.herd.measureOnly = this.player.e;
		this.herd.measuring = on;
		if (on) this.herd.resetMetrics();
	}
	report() {
		return this.herd.report(this.player.e);
	}

	/** keep the player's intents when an overlay (editor, Lab) is open */
	freeze() {
		this.input.clear();
		for (const a of this.actors) a.c.intentSpeed = 0;
	}

	/** what the HUD's ability bar shows */
	abilityBar(): Array<{ id: AbilityId | 'jump' | 'glide' | 'eat'; level: number; cd: number }> {
		const me = this.player;
		const L = me.abil.level;
		const out: Array<{ id: AbilityId; level: number; cd: number }> = [];
		for (const id of [...SOCIAL, ...PREDATOR] as AbilityId[]) out.push({ id, level: L[id], cd: (PREDATOR as string[]).includes(id) ? me.cd[id as Attack] / COOLDOWN[id as Attack] : 0 });
		out.push({ id: 'jump', level: Math.max(1, L.jump), cd: 0 });
		if (L.glide > 0) out.push({ id: 'glide', level: L.glide, cd: 0 });
		return out;
	}

}
