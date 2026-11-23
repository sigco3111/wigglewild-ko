// Visible mutation and breeding with provenance.
//
// A mutation picks 1 (subtle) or 3 (wild) meaningful genes from the feature list (body plan, limbs, proportions,
// head features, colour pattern), moves each by a clearly visible amount, adds a small drift on the rest, and then
// checks the result by decoding both bodies: it retries until the diff shows enough visible change, at least one
// change in the silhouette. The diff is also the text the player sees ("legs 4 → 6, longer neck, spots → stripes").
import { hueName } from './color.ts';
import { buildPlan, type Plan } from './build.ts';
import { GENES, type GeneName, type Genes, Prng, quantize } from './genome.ts';
import { field, prepare } from './sdf.ts';

export type Strength = 'subtle' | 'wild';

const SHAPE: GeneName[] = ['legs', 'segs', 'legLen', 'neck', 'headSize', 'headShape', 'snout', 'fat', 'tall', 'horns', 'hornLen', 'ears', 'earLen', 'tail', 'tailLen', 'spikes', 'antennae', 'stalks', 'eyes', 'eyeSize', 'arms', 'size', 'mouth', 'legStyle', 'segLen'];
const COLOUR: GeneName[] = ['pattern', 'hue', 'scheme', 'patternScale'];
const DISCRETE = new Set<GeneName>(['segs', 'legs', 'legStyle', 'hopper', 'arms', 'headShape', 'eyes', 'eyeLayout', 'stalks', 'horns', 'ears', 'spikes', 'mouth', 'teeth', 'blush', 'tail', 'tailTip', 'antennae', 'scheme', 'pattern']);
const MEANINGFUL = new Set<GeneName>([...SHAPE, ...COLOUR]);

const reflect = (v: number) => {
	let x = v;
	while (x < 0 || x >= 1) x = x < 0 ? -x : 1.998 - x;
	return Math.min(0.999, Math.max(0, x));
};

const ARROW = '→';

/** What visibly differs between two bodies, in words. shape = silhouette-level changes. */
export function describeDiff(a: Plan, b: Plan): { shape: string[]; colour: string[] } {
	const shape: string[] = [];
	const colour: string[] = [];
	const word: Record<string, string> = { blob: '블롭', mono: '포고', biped: '이족보행', quad: '사족보행', hexa: '육족보행', octo: '팔족보행' };
	if (a.legs.length !== b.legs.length) shape.push(`다리 ${a.legs.length}개 ${ARROW} ${b.legs.length}개`);
	else if (a.kind !== b.kind) shape.push(`${word[a.kind]} ${ARROW} ${word[b.kind]}`);
	const rel = (x: number, y: number) => (y - x) / Math.max(1e-3, Math.abs(x));
	if (a.legs.length && b.legs.length && a.legs.length === b.legs.length) {
		const d = rel(a.legLength / a.R, b.legLength / b.R);
		if (Math.abs(d) > 0.15) shape.push(d > 0 ? '더 긴 다리' : '더 짧은 다리');
		if (a.legs[0].style !== b.legs[0].style) shape.push({ straight: '곧은 다리', digi: '탄성 다리', insect: '곤충 다리' }[b.legs[0].style]);
	}
	const ds = rel(a.size, b.size);
	if (Math.abs(ds) > 0.18) shape.push(ds > 0 ? '더 커짐' : '더 작아짐');
	const seg = (p: Plan) => p.segBones.length;
	if (seg(a) !== seg(b)) shape.push(seg(b) > seg(a) ? '더 긴 몸' : '더 짧은 몸');
	if (Math.abs(a.genes.fat - b.genes.fat) > 0.22) shape.push(b.genes.fat > a.genes.fat ? '더 통통해짐' : '더 날씬해짐');
	const neck = (p: Plan) => p.genes.neck * p.genes.neck;
	if (Math.abs(neck(a) - neck(b)) > 0.2) shape.push(neck(b) > neck(a) ? '더 긴 목' : '더 짧은 목');
	if (Math.floor(a.genes.headShape * 4) !== Math.floor(b.genes.headShape * 4)) shape.push(['둥근 머리', '넓은 머리', '높은 머리', '긴 머리'][Math.floor(b.genes.headShape * 4)]);
	if (a.genes.snout > 0.45 !== b.genes.snout > 0.45) shape.push(b.genes.snout > 0.45 ? '주둥이 생김' : '주둥이 없어짐');
	if (a.eyes.length !== b.eyes.length) shape.push(`눈 ${a.eyes.length}개 ${ARROW} ${b.eyes.length}개`);
	else if (Math.abs(a.genes.eyeSize - b.genes.eyeSize) > 0.3) shape.push(b.genes.eyeSize > a.genes.eyeSize ? '더 큰 눈' : '더 작은 눈');
	const has = (p: Plan, t: string) => p.traits.some((x) => x.includes(t));
	for (const [t, on, off] of [
		['뿔', '뿔 생김', '뿔 없어짐'],
		['왕관', '왕관 뿔 생김', '왕관 뿔 없어짐'],
		['지느러미', '지느러미 생김', '지느러미 없어짐'],
		['가시투성이', '가시 생김', '가시 없어짐'],
		['더듬이', '더듬이 생김', '더듬이 없어짐'],
		['눈 줄기', '눈 줄기 생김', '눈 줄기 없어짐'],
		['팔', '팔 생김', '팔 없어짐'],
		['엄니', '엄니 생김', '엄니 없어짐'],
		['부리', '부리 생김', '부리 없어짐'],
		['토끼 이빨', '토끼 이빨 생김', '토끼 이빨 없어짐'],
	] as const) {
		if (has(a, t) !== has(b, t)) shape.push(has(b, t) ? on : off);
	}
	const ear = (p: Plan) => p.traits.find((x) => x.endsWith(' 귀')) ?? '귀 없음';
	if (ear(a) !== ear(b)) shape.push(ear(b));
	const tail = (p: Plan) => p.chains.find((c) => c.kind === 'tail');
	const ta = tail(a),
		tb = tail(b);
	if (!!ta !== !!tb) shape.push(tb ? '꼬리 생김' : '꼬리 없어짐');
	else if (ta && tb) {
		if (ta.tip !== tb.tip) shape.push(tb.tip === 'none' ? '평범한 꼬리' : `${{ fluff: '폭신한', ball: '몽둥이', spade: '삽' }[tb.tip] ?? tb.tip} 꼬리`);
		else if (Math.abs(rel(ta.length / a.R, tb.length / b.R)) > 0.25) shape.push(tb.length / b.R > ta.length / a.R ? '더 긴 꼬리' : '더 짧은 꼬리');
	}
	const pn = (k: string) => ({ none: '무늬 없음', spots: '점박이', stripes: '줄무늬', patches: '얼룩', gradient: '그라데이션' })[k] ?? k;
	if (a.pattern.kind !== b.pattern.kind) colour.push(`${pn(a.pattern.kind)} ${ARROW} ${pn(b.pattern.kind)}`);
	const ha = hueName(a.palette.hue),
		hb = hueName(b.palette.hue);
	if (ha !== hb) colour.push(`${ha} ${ARROW} ${hb}`);
	else if (Math.floor(a.genes.scheme * 5) !== Math.floor(b.genes.scheme * 5)) colour.push('새 포인트 색');
	return { shape, colour };
}

/**
 * Rest-pose silhouettes (side and front) on a G x G grid: body SDF, legs, arms, tails and antennae as thick lines,
 * eyes as discs. Returns 1 - IoU averaged over both views (0 = identical outline).
 */
export function silhouetteDiff(a: Plan, b: Plan, G = 32): number {
	const ext = Math.max(a.radius, b.radius, a.top, b.top, ...a.footprint, ...b.footprint) * 2.4;
	const sa = silhouettes(a, ext, G),
		sb = silhouettes(b, ext, G);
	let tot = 0;
	for (let v = 0; v < 2; v++) {
		let inter = 0,
			uni = 0;
		for (let i = 0; i < G * G; i++) {
			if (sa[v][i] && sb[v][i]) inter++;
			if (sa[v][i] || sb[v][i]) uni++;
		}
		tot += 1 - inter / Math.max(1, uni);
	}
	return tot / 2;
}

export function silhouettes(p: Plan, ext: number, G: number): [Uint8Array, Uint8Array] {
	const solid = p.parts.filter((q) => q.op !== 'paint');
	prepare(solid);
	const cell = ext / G;
	const side = new Uint8Array(G * G);
	const front = new Uint8Array(G * G);
	const ix = (v: number) => Math.floor(v / cell + G / 2);
	const iy = (v: number) => Math.floor(v / cell);
	const put = (x: number, y: number, z: number, rr: number) => {
		for (let dy = -rr; dy <= rr; dy++)
			for (let dx = -rr; dx <= rr; dx++) {
				const yy = iy(y) + dy;
				if (yy < 0 || yy >= G) continue;
				const zz = ix(z) + dx,
					xx = ix(x) + dx;
				if (zz >= 0 && zz < G) side[zz + yy * G] = 1;
				if (xx >= 0 && xx < G) front[xx + yy * G] = 1;
			}
	};
	for (let k = 0; k < G; k++)
		for (let j = 0; j < G; j++)
			for (let i = 0; i < G; i++) {
				const x = (i - G / 2 + 0.5) * cell,
					y = (j + 0.5) * cell,
					z = (k - G / 2 + 0.5) * cell;
				if (field(solid, x, y, z) < 0) {
					side[k + j * G] = 1;
					front[i + j * G] = 1;
				}
			}
	const line = (a: readonly number[], b: readonly number[], r: number) => {
		const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (cell * 0.5)) + 1;
		const rr = Math.max(0, Math.round(r / cell));
		for (let s = 0; s <= steps; s++) {
			const t = s / steps;
			put(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, rr);
		}
	};
	for (const l of p.legs) {
		const knee = [(l.hip[0] + l.foot[0]) / 2, (l.hip[1] + l.footR) / 2, (l.hip[2] + l.foot[2]) / 2];
		line(l.hip, knee, l.thick);
		line(knee, [l.foot[0], l.footR, l.foot[2]], l.thick * 0.7);
		put(l.foot[0], l.footR * 0.6, l.foot[2], Math.max(0, Math.round(l.footR / cell)));
	}
	for (const a of p.arms) line(a.shoulder, [a.shoulder[0] + a.side * (a.upper + a.lower) * 0.3, a.shoulder[1] - (a.upper + a.lower) * 0.8, a.shoulder[2]], a.thick);
	for (const c of p.chains) line(c.anchor, [c.anchor[0] + c.dir[0] * c.length, c.anchor[1] + c.dir[1] * c.length, c.anchor[2] + c.dir[2] * c.length], (c.r0 + c.r1) / 2);
	for (const e of p.eyes) if (e.stalk < 0) put(e.pos[0], e.pos[1], e.pos[2], Math.max(0, Math.round(e.r / cell)));
	return [side, front];
}

/** How much each kind of change reads at a glance (silhouette weight). */
export function visibleWeight(change: string): number {
	if (change.startsWith('legs ') || /biped|quadruped|hexapod|octopod|pogo|blob/.test(change)) return 1;
	if (/bigger|smaller|longer body|shorter body/.test(change)) return 0.7;
	if (/legs|neck|chubbier|slimmer|head|snout|tail/.test(change)) return 0.5;
	if (/eyes|stalks|arms|fins|ears|crown/.test(change)) return 0.35;
	if (/horns|spikes|antennae|beak|tusks|teeth/.test(change)) return 0.3;
	return 0.25; // colour and pattern
}

export interface MutationResult {
	genes: Genes;
	changes: string[];
	shapeChanges: number;
	touched: GeneName[];
}

export function mutateVisible(g: Genes, seed: number, strength: Strength = 'subtle'): MutationResult {
	const r = new Prng(seed ^ 0x77aa11);
	const parent = buildPlan(g);
	const want = strength === 'wild' ? 3 : 1;
	let best: MutationResult | null = null;
	let bestScore = -1;
	for (let attempt = 0; attempt < 30; attempt++) {
		const o = { ...g };
		const touched: GeneName[] = [];
		const n = strength === 'wild' ? 3 + (r.next() < 0.35 ? 1 : 0) : 1 + (r.next() < 0.3 ? 1 : 0);
		while (touched.length < n) {
			// the first pick is always a silhouette gene
			const src = touched.length === 0 || r.next() < 0.75 ? SHAPE : COLOUR;
			const k = r.pick(src);
			if (!touched.includes(k)) touched.push(k);
		}
		for (const k of touched) {
			if (DISCRETE.has(k)) {
				// jump to a clearly different position on the gene (a different trait)
				let v = r.next();
				for (let t = 0; t < 8 && Math.abs(v - o[k]) < 0.22; t++) v = r.next();
				o[k] = v;
			} else {
				const lo = strength === 'wild' ? 0.35 : 0.24,
					hi = strength === 'wild' ? 0.6 : 0.4;
				const dir = o[k] > 0.7 ? -1 : o[k] < 0.3 ? 1 : r.next() < 0.5 ? -1 : 1;
				o[k] = reflect(o[k] + dir * r.range(lo, hi));
			}
		}
		// small drift on everything else that is continuous (personality included)
		const drift = strength === 'wild' ? 0.05 : 0.025;
		for (const k of GENES) if (!touched.includes(k) && !DISCRETE.has(k) && !MEANINGFUL.has(k)) o[k] = reflect(o[k] + r.gauss() * drift);
		const q = quantize(o);
		const d = describeDiff(parent, buildPlan(q));
		const changes = [...d.shape, ...d.colour];
		const res: MutationResult = { genes: q, changes, shapeChanges: d.shape.length, touched };
		const weight = d.shape.reduce((m, c) => m + visibleWeight(c), 0);
		let ok = d.shape.length >= 1 && changes.length >= want && weight >= (strength === 'wild' ? 1.3 : 0.5) && (strength === 'subtle' ? changes.length <= 3 : true);
		// and the outline must really change (a coarse silhouette, a few ms)
		const sil = ok || attempt > 20 ? silhouetteDiff(parent, buildPlan(q), 28) : 0;
		if (ok && sil < (strength === 'wild' ? 0.2 : 0.08)) ok = false;
		if (ok) return res;
		const score = weight + sil * 3 + changes.length * 0.01;
		if (score > bestScore) {
			bestScore = score;
			best = res;
		}
	}
	return best!;
}

/** Gene groups, named for the Lab's gene cards. */
export const GROUP_NAMES: Array<[string, GeneName[]]> = [
	['크기', ['size']],
	['몸', ['segs', 'segLen', 'fat', 'tall', 'taper', 'arch']],
	['다리', ['legs', 'legLen', 'legThick', 'legStyle', 'footSize', 'hopper']],
	['팔', ['arms', 'armLen']],
	['머리', ['neck', 'headSize', 'headShape', 'snout']],
	['눈', ['eyes', 'eyeSize', 'eyeLayout', 'stalks']],
	['뿔', ['horns', 'hornLen', 'hornCurl']],
	['귀', ['ears', 'earLen']],
	['가시', ['spikes', 'spikeSize']],
	['입', ['mouth', 'teeth', 'blush']],
	['꼬리', ['tail', 'tailLen', 'tailThick', 'tailTip']],
	['더듬이', ['antennae']],
	['색', ['hue', 'scheme', 'chroma', 'light']],
	['무늬', ['pattern', 'patternScale']],
	['성격', ['speed', 'bounce', 'googly', 'shy', 'social', 'curious']],
];

export type Origin = 'A' | 'B' | 'mix' | 'new';

/** Two parents give a child: whole groups from one parent, some continuous groups blended, sometimes a surprise. */
export function breedTracked(a: Genes, b: Genes, seed: number): { genes: Genes; from: Record<string, Origin> } {
	const r = new Prng(seed ^ 0xb7eed);
	const o = {} as Genes;
	const from: Record<string, Origin> = {};
	for (const [name, group] of GROUP_NAMES) {
		const pickA = r.next() < 0.5;
		const blend = r.next() < 0.3 && group.some((k) => !DISCRETE.has(k));
		const t = r.range(0.3, 0.7);
		for (const k of group) o[k] = blend && !DISCRETE.has(k) ? a[k] * (1 - t) + b[k] * t : pickA ? a[k] : b[k];
		from[name] = blend ? 'mix' : pickA ? 'A' : 'B';
	}
	if (r.next() < 0.5) {
		const k = r.pick(SHAPE.filter((x) => !DISCRETE.has(x)));
		o[k] = reflect(o[k] + (r.next() < 0.5 ? -1 : 1) * r.range(0.12, 0.25));
		const g = GROUP_NAMES.find(([, ks]) => ks.includes(k));
		if (g) from[g[0]] = 'new';
	}
	return { genes: quantize(o), from };
}

/** For a mutant: every group the mutation touched is "new", the rest came from its one parent. */
export function mutationOrigins(touched: GeneName[]): Record<string, Origin> {
	const from: Record<string, Origin> = {};
	for (const [name, ks] of GROUP_NAMES) from[name] = ks.some((k) => touched.includes(k)) ? 'new' : 'A';
	return from;
}
