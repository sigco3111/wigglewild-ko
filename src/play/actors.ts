// Everyone on the island in Play mode is an Actor: the player, the pack and the wild species. Actors have health,
// abilities from their parts, attack cooldowns, and a combat model: telegraphed wind-ups, hits that flash and
// squash, knockback, hitstop and shake, spit globs that fly, and stomps that ripple across the ground.
import * as THREE from 'three';
import type { Batches } from '../creature/batches';
import type { Creature } from '../creature/creature';
import type { Entry } from '../creature/herd';
import { type Abilities, abilitiesOf } from './abilities';
import type { Nest } from './island';
import type { Species } from './species';

export type Attack = 'bite' | 'charge' | 'strike' | 'spit' | 'stomp';
export type AIState = 'idle' | 'wander' | 'graze' | 'flee' | 'alert' | 'threaten' | 'attack' | 'recover' | 'hunt' | 'curious' | 'greet' | 'follow' | 'encounter' | 'sleep' | 'down' | 'eatfood' | 'home' | 'player' | 'roam' | 'chase';

let NEXT = 1;

export class Actor {
	readonly id = NEXT++;
	readonly abil: Abilities;
	hp: number;
	maxHp: number;
	state: AIState = 'idle';
	timer = 1 + Math.random() * 2;
	readonly target = new THREE.Vector3();
	foe: Actor | null = null;
	threat: Actor | null = null;
	cd: Record<Attack, number> = { bite: 0, charge: 0, strike: 0, spit: 0, stomp: 0 };
	/** a wind-up before an attack (wild ones telegraph: glow, a growl, the "!" marker) */
	windup: { kind: Attack; t: number; dur: number } | null = null;
	/** charging: seconds left in the rush, and who it already hit */
	charging = 0;
	chargeHit = new Set<number>();
	sinceHurt = 99;
	sinceAttack = 99;
	hurtBy: Actor | null = null;
	down = false;
	downT = 0;
	/** 0..1 how aware it is of the player */
	aware = 0;
	greetCd = 0;
	encounterCd = 0;
	/** in the player's pack */
	ally = false;
	young = false;
	/** meters of the player's wander-off before an ally catches up */
	slot = 0;
	hunger = Math.random() * 0.5;
	/** shown health bar fade */
	barT = 0;

	constructor(
		readonly e: Entry,
		readonly sp: Species | null,
		public home: Nest | null,
		readonly team: 'player' | 'wild',
		toughness = 1,
	) {
		this.abil = abilitiesOf(e.c.plan);
		const S = e.c.plan.size;
		this.maxHp = Math.round((40 + 45 * S ** 1.2) * toughness);
		this.hp = this.maxHp;
	}

	get c(): Creature {
		return this.e.c;
	}
	get size() {
		return this.e.c.plan.size;
	}
	get R() {
		return Math.max(this.e.c.plan.R, this.e.c.plan.footprint[0] * 0.8);
	}
	/** reach of the body, for contact tests */
	get bodyR() {
		const P = this.e.c.plan;
		return Math.max(P.R * 1.15, Math.max(P.footprint[0], P.footprint[1]) * 0.9);
	}
	get alive() {
		return !this.down && this.e.egg <= 0;
	}
	level(a: Attack) {
		return a === 'stomp' ? 5 : this.abil.level[a];
	}
	can(a: Attack) {
		return this.level(a) > 0 && this.cd[a] <= 0 && !this.windup && this.charging <= 0 && this.alive;
	}
}

/** Damage of an attack: grows with the ability level and (gently) with body size. */
export function damageOf(a: Actor, kind: Attack) {
	const L = a.level(kind);
	const base = { bite: 7 + 5 * L, charge: 6 + 5 * L, strike: 5 + 4 * L, spit: 4 + 3 * L, stomp: 34 }[kind];
	const sizeK = Math.max(0.6, Math.min(2.2, Math.sqrt(a.size / 0.8)));
	return base * sizeK * (a.young ? 0.55 : 1);
}

export const COOLDOWN: Record<Attack, number> = { bite: 0.55, charge: 2.4, strike: 1.5, spit: 1.1, stomp: 4 };
/** wild attackers wind up this long first (readable telegraphs) */
export const WINDUP: Record<Attack, number> = { bite: 0.5, charge: 0.75, strike: 0.6, spit: 0.55, stomp: 0.9 };

export interface Glob {
	pos: THREE.Vector3;
	vel: THREE.Vector3;
	from: Actor;
	life: number;
	r: number;
}

export interface Ripple {
	at: THREE.Vector3;
	t: number;
	R: number;
	from: Actor;
	hit: Set<number>;
}

/** Projectiles and shockwaves, drawn with the shared blob batch. */
export class Effects {
	readonly globs: Glob[] = [];
	readonly ripples: Ripple[] = [];
	private q = new THREE.Quaternion();
	private s = new THREE.Vector3();
	private p = new THREE.Vector3();

	draw(B: Batches, ground: (x: number, z: number) => number) {
		for (const g of this.globs) {
			const r = g.r;
			B.blobs.add(g.pos, this.q.identity(), this.s.set(r, r, r), [0.55, 0.9, 0.3]);
			B.blobs.add(this.p.copy(g.pos).addScaledVector(g.vel, -0.03), this.q, this.s.set(r * 0.6, r * 0.6, r * 0.6), [0.7, 0.95, 0.45]);
		}
		for (const w of this.ripples) {
			// a ring of dirt clods racing outward
			const rad = w.R * Math.min(1, w.t / 0.45);
			const n = 28;
			const fade = 1 - Math.min(1, w.t / 0.6);
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				const x = w.at.x + Math.cos(a) * rad,
					z = w.at.z + Math.sin(a) * rad;
				const r = (0.12 + 0.1 * Math.sin(i * 3.7)) * fade * Math.min(2, w.R / 4);
				if (r <= 0.01) continue;
				B.blobs.add(this.p.set(x, ground(x, z) + r * 0.3, z), this.q.identity(), this.s.set(r, r * 0.6, r), [0.62, 0.5, 0.34]);
			}
		}
	}
}
