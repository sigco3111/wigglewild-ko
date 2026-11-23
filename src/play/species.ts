// The island's species, built in the editor's own terms (spine + parts), each with a clear temperament.
// Every one of them is checked by the animation harness (`npm run anim -- --species`).
import { type Design, type DPart, encodeDesign, normalise, type PartType } from '../creature/design';
import type { SocialId } from './abilities';

export type Temper = 'shy' | 'territorial' | 'hunter' | 'curious' | 'grumpy' | 'epic';

export interface Species {
	id: string;
	name: string;
	/** plural for prompts */
	many: string;
	temper: Temper;
	blurb: string;
	/** members around the nest */
	count: number;
	/** preferred nest spot (searched for open, gentle ground nearby) */
	nest: [number, number];
	/** how far they roam from the nest */
	range: number;
	/** how close you can get before they react (sneaking halves it) */
	notice: number;
	/** the social moves it performs in an encounter (from its own abilities) */
	moves: SocialId[];
	/** how hard it is to impress: friendship per move is scaled by 1/fussy */
	fussy: number;
	befriend: boolean;
	design: Design;
	/** hit points per unit of size^1.2 */
	toughness: number;
}

const P = (t: PartType, s: number, a: number, b: number, k: number, m: boolean, v = '', r = 0): DPart => ({ t, s, a, b, k, m, v, r });
const D = (name: string, size: number, fat: number, spine: Array<[number, number, number]>, parts: DPart[], paint: Design['paint'], pers: Partial<Design['personality']> = {}): Design =>
	normalise({
		v: 1,
		name,
		size,
		fat,
		spine: spine.map(([z, y, r]) => ({ z, y, r })),
		parts,
		paint,
		personality: { speed: 1, bounce: 1, googly: 0.5, shy: 0.4, social: 0.6, curious: 0.5, ...pers },
	});

/** The player's first creature: a springy little omnivore with a song sac, a frill and big feet. */
export const STARTER: Design = D(
	'Pip',
	0.8,
	1.15,
	[
		[-0.55, 0, 1.15],
		[0.7, 0.6, 1.02],
	],
	[
		P('stalk', 1, 0.38, 1.05, 0.95, true),
		P('mouth', 1, 0, -0.5, 1.15, false, 'omni'),
		P('throat', 1, 0, -1.3, 0.7, false, 'song'),
		P('frill', 1, 0, 0.55, 1.0, false),
		P('leg', 0, 1.35, -0.95, 1.05, true, 'digi'),
		P('tail', 0, Math.PI, 0.3, 0.75, false, 'fluff'),
		P('foot', 0, 0, 0, 1.0, false, 'paw'),
	],
	{ base: 1, accent: 9, pattern: 0, kind: 'spots', scale: 0.55 },
	{ bounce: 1.15, googly: 0.7, shy: 0.2, social: 0.8, curious: 0.8 },
);

export const SPECIES: Species[] = [
	{
		id: 'puffmoss',
		name: '퍼프모스',
		many: '퍼프모스',
		temper: 'shy',
		blurb: '수줍은 풀 뜯는 아이들. 급하게 다가가면 도망가요: 천천히 살금살금.',
		count: 5,
		nest: [20, 16],
		range: 12,
		notice: 7,
		moves: ['sing', 'charm'],
		fussy: 0.8,
		befriend: true,
		toughness: 0.8,
		design: D(
			'Puffmoss',
			0.55,
			1.2,
			[
				[-0.45, 0, 1.15],
				[0.7, 0.35, 0.95],
			],
			[
				P('eye', 1, 0.42, 0.3, 1.45, true),
				P('mouth', 1, 0, -0.45, 0.9, false, 'herb'),
				P('throat', 1, 0, -1.0, 0.85, false, 'song'),
				P('leg', 0, 0.75, -1.0, 0.75, true, 'straight'),
				P('leg', 0, 2.3, -1.0, 0.75, true, 'straight'),
				P('tail', 0, Math.PI, 0.35, 1.25, false, 'fluff'),
			],
			{ base: 3, accent: 2, pattern: 11, kind: 'patches', scale: 0.5 },
			{ shy: 0.95, social: 0.9, bounce: 1.2, googly: 0.8, curious: 0.2 },
		),
	},
	{
		id: 'bobble',
		name: '바블',
		many: '바블',
		temper: 'curious',
		blurb: '호기심 많은 깡충이들. 졸졸 따라다니고 춤을 좋아해요.',
		count: 4,
		nest: [-8, -14],
		range: 14,
		notice: 12,
		moves: ['dance', 'sing'],
		fussy: 1.0,
		befriend: true,
		toughness: 0.9,
		design: D(
			'Bobble',
			0.7,
			0.95,
			[
				[-0.2, 0, 1.0],
				[0.15, 1.15, 0.85],
			],
			[
				P('stalk', 1, 0.35, 1.1, 1.1, true),
				P('mouth', 1, 0, -0.3, 1.0, false, 'herb'),
				P('throat', 1, 0, -0.9, 0.8, false, 'song'),
				P('leg', 0, 1.4, -1.0, 1.15, true, 'digi'),
				P('foot', 0, 0, 0, 1.25, false, 'paw'),
				P('tail', 0, Math.PI, 0.1, 1.2, false, 'plain'),
			],
			{ base: 8, accent: 10, pattern: 11, kind: 'stripes', scale: 0.45 },
			{ bounce: 1.5, curious: 1, shy: 0.1, social: 0.9, googly: 0.9 },
		),
	},
	{
		id: 'tusket',
		name: '터스킷',
		many: '터스킷',
		temper: 'territorial',
		blurb: '언덕을 지키는 자랑스러운 무리. 포즈를 뽐내 보이거나, 돌진을 각오하세요.',
		count: 4,
		nest: [-24, 14],
		range: 11,
		notice: 9,
		moves: ['pose', 'dance'],
		fussy: 1.25,
		befriend: true,
		toughness: 1.3,
		design: D(
			'Tusket',
			1.25,
			1.05,
			[
				[-1.0, 0, 1.0],
				[0.1, 0.12, 1.1],
				[1.1, 0.35, 0.8],
			],
			[
				P('eye', 2, 0.6, 0.35, 0.8, true),
				P('mouth', 2, 0, -0.4, 1.05, false, 'herb'),
				P('horn', 2, 0.5, 0.9, 1.3, true, 'curl', 0.2),
				P('spike', 1, 0, 1.3, 1.0, false),
				P('leg', 0, 1.0, -1.0, 1.0, true, 'straight'),
				P('leg', 1, 1.0, -1.0, 1.0, true, 'straight'),
				P('foot', 0, 0, 0, 1.1, false, 'hoof'),
				P('tail', 0, Math.PI, 0.3, 0.8, false, 'plain'),
			],
			{ base: 11, accent: 1, pattern: 1, kind: 'gradient', scale: 0.6 },
			{ shy: 0.1, social: 0.8, bounce: 0.7, googly: 0.3, curious: 0.4 },
		),
	},
	{
		id: 'snapjaw',
		name: '스냅조',
		many: '스냅조',
		temper: 'hunter',
		blurb: '큰 턱을 가진 무리 사냥꾼. 풀 뜯는 아이들도, 당신도 노려요. 물어뜯으며 맞서세요!',
		count: 3,
		nest: [-30, -22],
		range: 22,
		notice: 11,
		moves: ['pose', 'dance'],
		fussy: 1.5,
		befriend: true,
		toughness: 1.0,
		design: D(
			'Snapjaw',
			0.8,
			0.9,
			[
				[-1.0, -0.1, 0.85],
				[0.05, 0.25, 1.0],
				[1.15, 0.7, 0.9],
			],
			[
				P('eye', 2, 0.55, 0.45, 0.85, true),
				P('mouth', 2, 0, -0.3, 1.25, false, 'carn'),
				P('horn', 2, 0.35, 1.1, 0.7, true, 'straight', -0.3),
				P('leg', 1, 1.3, -0.95, 1.15, true, 'digi'),
				P('foot', 0, 0, 0, 1.0, false, 'claw'),
				P('tail', 0, Math.PI, 0.15, 1.35, false, 'spade'),
			],
			{ base: 0, accent: 7, pattern: 7, kind: 'stripes', scale: 0.4 },
			{ shy: 0.05, social: 0.6, bounce: 0.9, googly: 0.2, curious: 0.7, speed: 1.2 },
		),
	},
	{
		id: 'croaker',
		name: '크로커',
		many: '크로커',
		temper: 'grumpy',
		blurb: '연못에 앉아 있는 심술쟁이들. 가만히 두세요, 아니면 침을 맞아요.',
		count: 3,
		nest: [28, -22],
		range: 7,
		notice: 6,
		moves: ['charm', 'dance'],
		fussy: 1.1,
		befriend: true,
		toughness: 1.1,
		design: D(
			'Croaker',
			0.95,
			1.35,
			[
				[-0.3, 0, 1.2],
				[0.75, 0.15, 1.0],
			],
			[
				P('eye', 1, 0.55, 0.75, 1.2, true),
				P('mouth', 1, 0, -0.2, 1.3, false, 'omni'),
				P('throat', 1, 0, -0.85, 1.1, false, 'spit'),
				P('frill', 1, 0, 0.7, 0.8, false),
				P('leg', 0, 1.0, -1.0, 0.8, true, 'insect'),
				P('leg', 0, 2.1, -1.0, 0.8, true, 'insect'),
				P('tail', 0, Math.PI, -0.1, 0.7, false, 'plain'),
			],
			{ base: 4, accent: 2, pattern: 5, kind: 'spots', scale: 0.7 },
			{ shy: 0.3, social: 0.3, bounce: 0.6, googly: 0.6, curious: 0.2, speed: 0.8 },
		),
	},
];

/** The epic: huge, slow to anger, and very dangerous. Too wild to befriend. */
export const EPIC: Species = {
	id: 'thunderback',
	name: '선더백',
	many: '선더백',
	temper: 'epic',
	blurb: '섬의 거인. 나타나면 모두 도망쳐요. 당신도요.',
	count: 1,
	nest: [0, 32],
	range: 40,
	notice: 12,
	moves: ['pose'],
	fussy: 9,
	befriend: false,
	toughness: 6,
	design: D(
		'Thunderback',
		2.6,
		1.1,
		[
			[-1.6, 0, 0.95],
			[-0.5, 0.15, 1.1],
			[0.6, 0.25, 1.05],
			[1.6, 0.4, 0.8],
		],
		[
			P('eye', 3, 0.6, 0.4, 0.7, true),
			P('mouth', 3, 0, -0.35, 1.3, false, 'carn'),
			P('horn', 3, 0.55, 0.8, 1.5, true, 'curl', 0.1),
			P('spike', 1, 0, 1.3, 1.3, false),
			P('spike', 2, 0, 1.3, 1.2, false),
			P('leg', 0, 1.0, -1.0, 1.1, true, 'straight'),
			P('leg', 1, 1.1, -1.0, 1.1, true, 'straight'),
			P('leg', 2, 1.0, -1.0, 1.1, true, 'straight'),
			P('tail', 0, Math.PI, 0.25, 1.3, false, 'ball'),
		],
		{ base: 7, accent: 0, pattern: 7, kind: 'stripes', scale: 0.55 },
		{ shy: 0, social: 0.2, bounce: 0.5, googly: 0.1, curious: 0.3, speed: 0.85 },
	),
};

/** A member's code: the species body at a slightly different size (young ones are smaller). */
export function memberCode(sp: Species, scale = 1): string {
	const d = structuredClone(sp.design);
	d.size = Math.max(0.3, Math.min(2.6, d.size * scale));
	return encodeDesign(d);
}

export const starterCode = () => encodeDesign(STARTER);
