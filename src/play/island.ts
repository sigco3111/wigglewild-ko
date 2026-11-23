// The living island's furniture: day and night, nests, fruit on the bushes, and food left after fights.
import * as THREE from 'three';
import type { Batches } from '../creature/batches';
import { toonMaterial, U } from '../look/materials';
import type { RenderPath } from '../render/types';
import type { World } from '../world/world';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ day and night

/** A day lasts DAY seconds: morning, a long day, a golden dusk, a short night, dawn. */
export class DayNight {
	static DAY = 420;
	/** 0..1 through the day; 0.25 morning, 0.5 noon, 0.8 dusk, 0.9 midnight */
	t = 0.3;
	night = 0;
	private day: { sun: THREE.Color; si: number; sky: THREE.Color; rim: THREE.Color; fog: THREE.Color; exp: number; tint: THREE.Color; bounce: THREE.Color } | null = null;
	frozen = false;

	constructor(
		readonly scene: THREE.Scene,
		readonly path: RenderPath,
	) {}

	/** night amount for a time of day */
	static nightAt(t: number) {
		// dusk from 0.72 to 0.82, night to 0.97, dawn to 1.05 (= 0.05)
		const x = t < 0.2 ? t + 1 : t;
		return smooth(0.72, 0.84, x) * (1 - smooth(0.98, 1.08, x));
	}

	get isNight() {
		return this.night > 0.6;
	}

	update(dt: number) {
		if (!this.day) {
			const fog = this.scene.fog as THREE.Fog;
			this.day = { sun: U.uSunColor.value.clone(), si: U.uSunIntensity.value, sky: U.uSkyColor.value.clone(), rim: U.uRimColor.value.clone(), fog: fog.color.clone(), exp: this.path.grade.exposure, tint: U.uShadowTint.value.clone(), bounce: U.uBounceColor.value.clone() };
		}
		if (!this.frozen) this.t = (this.t + dt / DayNight.DAY) % 1;
		this.apply();
	}

	apply() {
		const D = this.day;
		if (!D) return;
		const n = DayNight.nightAt(this.t);
		this.night = n;
		const dusk = n * (1 - n) * 4;
		U.uNight.value = n;
		U.uSunColor.value.copy(D.sun).lerp(new THREE.Color(1.0, 0.62, 0.38), dusk * 0.7).lerp(new THREE.Color(0.55, 0.66, 1.0), smooth(0.5, 1, n));
		U.uSunIntensity.value = D.si * (1 - 0.62 * n);
		U.uSkyColor.value.copy(D.sky).lerp(new THREE.Color(0.18, 0.25, 0.55), n);
		U.uRimColor.value.copy(D.rim).lerp(new THREE.Color(0.55, 0.65, 1.0), n);
		U.uShadowTint.value.copy(D.tint).lerp(new THREE.Color(0.32, 0.36, 0.7), n);
		U.uBounceColor.value.copy(D.bounce).multiplyScalar(1 - 0.6 * n);
		(this.scene.fog as THREE.Fog).color.copy(D.fog).lerp(new THREE.Color(0.95, 0.66, 0.5), dusk * 0.45).lerp(new THREE.Color(0.08, 0.11, 0.24), smooth(0.4, 1, n));
		this.path.grade.exposure = D.exp * (1 - 0.18 * n);
	}

	/** "Morning", "Day", "Dusk", "Night" */
	label() {
		const t = this.t;
		if (this.night > 0.6) return '밤';
		if (t > 0.68 && t < 0.86) return '저녁';
		if (t < 0.2 || t > 0.97) return '새벽';
		return t < 0.4 ? '아침' : '낮';
	}
}

// ------------------------------------------------------------------ nests

export interface Nest {
	id: string;
	x: number;
	z: number;
	y: number;
	r: number;
	color: [number, number, number];
	mesh: THREE.Mesh;
}

let nestMat: THREE.Material | null = null;

/** A woven ring of twigs with a soft lining and a few speckled eggs. */
export function makeNest(world: World, id: string, x: number, z: number, r: number, egg: [number, number, number], eggs = 3): Nest {
	nestMat ??= toonMaterial({ vertexColors: true, side: THREE.DoubleSide }, { key: 'nest', contact: true, edge: [-0.2, 0.3], rim: 0.25 });
	const geos: THREE.BufferGeometry[] = [];
	const rnd = mulberry(Math.floor(x * 131 + z * 71));
	const twig = new THREE.CylinderGeometry(1, 1, 1, 5, 1);
	const col = new THREE.Color();
	const put = (g: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color) => {
		const gg = g.clone().applyMatrix4(m);
		const n = gg.attributes.position.count;
		const cols = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			cols[i * 3] = c.r;
			cols[i * 3 + 1] = c.g;
			cols[i * 3 + 2] = c.b;
		}
		gg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
		geos.push(gg.index ? gg.toNonIndexed() : gg);
	};
	const gy = (px: number, pz: number) => world.ground(x + px, z + pz);
	const y0 = gy(0, 0);
	// twigs: three loose layers around the rim, tilted along the ring
	for (let layer = 0; layer < 3; layer++) {
		const n = Math.round(22 + r * 16);
		for (let i = 0; i < n; i++) {
			const a = (i / n) * Math.PI * 2 + layer * 0.37 + rnd() * 0.2;
			const rr = r * (0.82 + rnd() * 0.18);
			const px = Math.cos(a) * rr,
				pz = Math.sin(a) * rr;
			const len = r * (0.5 + rnd() * 0.35);
			const th = r * 0.028 * (0.8 + rnd() * 0.5);
			const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2 + (rnd() - 0.5) * 0.5, 0, 0));
			const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a + (rnd() - 0.5) * 0.5);
			const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).cross(new THREE.Vector3(0, 1, 0)).normalize(), 0.35 + layer * 0.12);
			const m = new THREE.Matrix4().compose(new THREE.Vector3(px, gy(px, pz) - y0 + r * (0.06 + layer * 0.09), pz), tilt.multiply(yawQ).multiply(q), new THREE.Vector3(th, len, th));
			col.setHSL(0.08 + rnd() * 0.03, 0.42 + rnd() * 0.15, 0.32 + rnd() * 0.12 + layer * 0.03);
			put(twig, m, col);
		}
	}
	// lining: a flattened soft bowl
	const bowl = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45);
	put(bowl, new THREE.Matrix4().compose(new THREE.Vector3(0, r * 0.32, 0), new THREE.Quaternion(), new THREE.Vector3(r * 0.85, r * 0.3, r * 0.85)), new THREE.Color(0.86, 0.74, 0.52));
	// eggs: cream with the species' colour as speckle-coloured eggs
	const eggG = new THREE.SphereGeometry(1, 14, 10);
	for (let i = 0; i < eggs; i++) {
		const a = (i / Math.max(1, eggs)) * Math.PI * 2 + 0.6;
		const d = eggs === 1 ? 0 : r * 0.32;
		const er = r * 0.17;
		const m = new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * d, r * 0.1 + er * 1.1, Math.sin(a) * d), new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.5, 0, (rnd() - 0.5) * 0.5)), new THREE.Vector3(er * 0.85, er * 1.15, er * 0.85));
		put(eggG, m, new THREE.Color(egg[0] * 0.35 + 0.62, egg[1] * 0.35 + 0.6, egg[2] * 0.35 + 0.55));
	}
	const merged = mergeGeos(geos);
	merged.computeVertexNormals();
	const mesh = new THREE.Mesh(merged, nestMat);
	mesh.position.set(x, y0, z);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = `nest-${id}`;
	return { id, x, z, y: y0, r, color: egg, mesh };
}

function mergeGeos(gs: THREE.BufferGeometry[]) {
	let n = 0;
	for (const g of gs) n += g.attributes.position.count;
	const pos = new Float32Array(n * 3),
		col = new Float32Array(n * 3);
	let o = 0;
	for (const g of gs) {
		pos.set(g.attributes.position.array as Float32Array, o * 3);
		col.set(g.attributes.color.array as Float32Array, o * 3);
		o += g.attributes.position.count;
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	out.setAttribute('color', new THREE.BufferAttribute(col, 3));
	return out;
}

function mulberry(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Find open, gentle ground near a preferred spot. */
export function findSpot(world: World, x: number, z: number, margin: number, rand: () => number): THREE.Vector3 {
	const n = new THREE.Vector3();
	for (let i = 0; i < 400; i++) {
		const r = i === 0 ? 0 : 1 + (i / 400) * 18;
		const a = rand() * Math.PI * 2;
		const px = x + Math.cos(a) * r,
			pz = z + Math.sin(a) * r;
		if (!world.isOpen(px, pz, margin)) continue;
		world.ground(px, pz, n);
		if (n.y < 0.93) continue;
		let ok = true;
		for (const o of world.scenery.obstacles) if (Math.hypot(o.x - px, o.z - pz) < o.r + margin) ok = false;
		if (ok) return new THREE.Vector3(px, world.ground(px, pz), pz);
	}
	return new THREE.Vector3(x, world.ground(x, z), z);
}

// ------------------------------------------------------------------ food

export interface Food {
	id: number;
	kind: 'fruit' | 'meat';
	pos: THREE.Vector3;
	/** on a bush: grows back after being eaten */
	bush: number;
	alive: boolean;
	regrow: number;
	color: [number, number, number];
	size: number;
	/** pop-in scale */
	k: number;
	life: number;
}

const FRUIT_COLORS: Array<[number, number, number]> = [
	[0.95, 0.18, 0.2],
	[1.0, 0.5, 0.1],
	[0.62, 0.22, 0.85],
	[1.0, 0.78, 0.12],
];

export class Pantry {
	readonly items: Food[] = [];
	private nextId = 1;
	private q = new THREE.Quaternion();
	private s = new THREE.Vector3();
	private p = new THREE.Vector3();
	constructor(readonly world: World) {
		// fruit around the bushes, sitting low on the leaves and in the grass under them
		let bi = 0;
		for (const o of world.scenery.obstacles) {
			if (o.kind !== 'bush') continue;
			bi++;
			if (bi % 3 === 2) continue;
			const n = 2 + (bi % 3);
			const col = FRUIT_COLORS[bi % FRUIT_COLORS.length];
			for (let i = 0; i < n; i++) {
				const a = bi * 2.3 + i * ((Math.PI * 2) / n) + (i % 2) * 0.3;
				const rr = o.r * (0.95 + (i % 2) * 0.25);
				const x = o.x + Math.cos(a) * rr,
					z = o.z + Math.sin(a) * rr;
				const y = world.ground(x, z) + (i % 2 === 0 ? o.top * 0.35 : 0.08);
				this.items.push({ id: this.nextId++, kind: 'fruit', pos: new THREE.Vector3(x, y, z), bush: bi, alive: true, regrow: 0, color: col, size: 0.085 + (i % 3) * 0.012, k: 1, life: Infinity });
			}
		}
	}

	dropMeat(at: THREE.Vector3, amount: number) {
		const n = Math.max(1, Math.min(3, Math.round(amount)));
		for (let i = 0; i < n; i++) {
			const a = i * 2.1 + Math.random();
			const x = at.x + Math.cos(a) * 0.25 * i,
				z = at.z + Math.sin(a) * 0.25 * i;
			this.items.push({ id: this.nextId++, kind: 'meat', pos: new THREE.Vector3(x, this.world.ground(x, z) + 0.06, z), bush: -1, alive: true, regrow: 0, color: [0.9, 0.38, 0.42], size: 0.12, k: 0, life: 90 });
		}
	}

	/** nearest edible food within reach, for a diet */
	nearest(at: THREE.Vector3, reach: number, diet: 'plants' | 'meat' | 'both' | 'sunshine', anyKind = false): Food | null {
		let best: Food | null = null,
			bd = reach;
		for (const f of this.items) {
			if (!f.alive) continue;
			if (!anyKind && !edible(f, diet)) continue;
			const d = Math.hypot(f.pos.x - at.x, f.pos.z - at.z);
			if (d < bd) {
				bd = d;
				best = f;
			}
		}
		return best;
	}

	eat(f: Food) {
		f.alive = false;
		f.regrow = f.kind === 'fruit' ? 50 + Math.random() * 30 : 0;
		f.k = 0;
	}

	update(dt: number) {
		for (let i = this.items.length - 1; i >= 0; i--) {
			const f = this.items[i];
			if (f.kind === 'meat') {
				f.life -= dt;
				if (!f.alive || f.life <= 0) {
					this.items.splice(i, 1);
					continue;
				}
			}
			if (!f.alive && f.kind === 'fruit') {
				f.regrow -= dt;
				if (f.regrow <= 0) f.alive = true;
			}
			if (f.alive) f.k = Math.min(1, f.k + dt * 3);
		}
	}

	draw(B: Batches, cam: THREE.Camera) {
		const t = performance.now() / 1000;
		for (const f of this.items) {
			if (!f.alive) continue;
			if (f.pos.distanceToSquared(cam.position) > 90 * 90) continue;
			const k = f.k < 1 ? 1 + 2.70158 * (f.k - 1) ** 3 + 1.70158 * (f.k - 1) ** 2 : 1;
			if (f.kind === 'fruit') {
				const r = f.size * k;
				this.q.setFromAxisAngle(this.s.set(0, 1, 0), f.id);
				B.blobs.add(this.p.copy(f.pos).setY(f.pos.y + r * 0.9), this.q, this.s.set(r, r * 0.92, r), f.color);
				// a little leaf
				B.blobs.add(this.p.set(f.pos.x + r * 0.3, f.pos.y + r * 1.85, f.pos.z), this.q, this.s.set(r * 0.42, r * 0.12, r * 0.22), [0.3, 0.65, 0.18]);
			} else {
				const r = f.size * k;
				const bob = Math.sin(t * 3 + f.id) * 0.01;
				this.q.setFromAxisAngle(this.s.set(0, 1, 0), f.id * 1.7);
				B.blobs.add(this.p.copy(f.pos).setY(f.pos.y + r * 0.7 + bob), this.q, this.s.set(r * 1.25, r * 0.75, r), f.color);
				// the bone
				const bx = Math.cos(f.id * 1.7) * r * 1.4,
					bz = -Math.sin(f.id * 1.7) * r * 1.4;
				B.blobs.add(this.p.set(f.pos.x + bx, f.pos.y + r * 0.75 + bob, f.pos.z + bz), this.q, this.s.set(r * 0.32, r * 0.32, r * 0.32), [0.97, 0.94, 0.86]);
				B.blobs.add(this.p.set(f.pos.x + bx * 1.35, f.pos.y + r * 0.75 + bob, f.pos.z + bz * 1.35), this.q, this.s.set(r * 0.3, r * 0.3, r * 0.3), [0.97, 0.94, 0.86]);
			}
		}
	}

	contacts(world: World) {
		for (const f of this.items) if (f.alive && f.pos.y - world.ground(f.pos.x, f.pos.z) < 0.15) world.contact(f.pos.x, f.pos.y, f.pos.z, f.size * 2.2, 0.5);
	}
}

export const edible = (f: Food, diet: 'plants' | 'meat' | 'both' | 'sunshine') => diet === 'both' || (diet === 'plants' && f.kind === 'fruit') || (diet === 'meat' && f.kind === 'meat');
