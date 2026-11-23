// Abilities come from parts. Each part gives levels (1 to 5) in one ability, so what you build is what you can do:
//   mouths   bite (carnivore, omnivore) and eat plants (herbivore, omnivore); no mouth lives on sunshine
//   legs     speed (2-joint, splayed) or jump (3-joint); arms, big hands and horns charge
//   wings    glide           spikes  strike (head, sides, tail) or defence (on the back)
//   frills   charm           horns   pose (and charge)  throat  sing (song sac) or spit (spit gland)
//   feet     dance           tails   strike (club, spade), charm (fluffy), dance (plain)
// Bigger parts and mirrored pairs give more levels; several parts add up, capped at 5.
import type { Plan } from '../creature/build';
import { designFromPlan } from '../creature/codes';
import { decodeDesign, type DPart, isDesignCode } from '../creature/design';

export type AbilityId = 'bite' | 'charge' | 'strike' | 'spit' | 'sing' | 'dance' | 'charm' | 'pose' | 'speed' | 'jump' | 'glide' | 'eat' | 'defence';
export type Group = 'social' | 'predator' | 'move' | 'body';

export interface AbilityInfo {
	label: string;
	group: Group;
	color: string;
	/** what gives it, for the editor and Lab */
	from: string;
	icon: string;
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#23263a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ABILITY: Record<AbilityId, AbilityInfo> = {
	bite: { label: '물기', group: 'predator', color: '#ff6f6f', from: '육식 또는 잡식 입', icon: svg('<path d="M4 8c3-4 13-4 16 0M4 16c3 4 13 4 16 0"/><path d="M7 8l1.5 3L10 8M14 8l1.5 3L17 8M7 16l1.5-3L10 16M14 16l1.5-3L17 16" fill="#fff"/>') },
	charge: { label: '돌진', group: 'predator', color: '#ff9f43', from: '팔, 큰 손, 뿔', icon: svg('<path d="M3 12h11M10 7l5 5-5 5"/><path d="M17 5l4 7-4 7" fill="#ffd23f"/>') },
	strike: { label: '치기', group: 'predator', color: '#ff5d8f', from: '머리·옆·꼬리 가시; 몽둥이 또는 삽 꼬리', icon: svg('<path d="M12 3l2 6h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z" fill="#ffd23f"/>') },
	spit: { label: '뱉기', group: 'predator', color: '#7bd44a', from: '침샘 (목)', icon: svg('<circle cx="7" cy="12" r="4" fill="#9be15d"/><circle cx="15" cy="10" r="2.4" fill="#9be15d"/><circle cx="20" cy="8" r="1.4" fill="#9be15d"/>') },
	sing: { label: '노래', group: 'social', color: '#4d8bff', from: '울음주머니 (목)', icon: svg('<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5" fill="#4d8bff"/><circle cx="16.5" cy="16" r="2.5" fill="#4d8bff"/>') },
	dance: { label: '춤', group: 'social', color: '#b48cff', from: '큰 발, 평범한 꼬리', icon: svg('<circle cx="12" cy="5" r="2.5" fill="#b48cff"/><path d="M12 8v6l-4 6M12 14l4 6M6 10l6-1 6 3"/>') },
	charm: { label: '매력', group: 'social', color: '#ff6fa8', from: '주름 장식, 폭신한 꼬리, 큰 눈', icon: svg('<path d="M12 20s-7-4.5-7-9.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5c0 5-7 9.5-7 9.5z" fill="#ff8fbf"/>') },
	pose: { label: '포즈', group: 'social', color: '#ffd23f', from: '뿔', icon: svg('<path d="M12 21v-7M12 14l-5 6M12 14l5 6M5 8l7 3 7-3"/><circle cx="12" cy="5" r="2.5" fill="#ffd23f"/>') },
	speed: { label: '스피드', group: 'move', color: '#31cbb9', from: '2관절 또는 벌어진 다리', icon: svg('<path d="M3 8h8M2 12h10M3 16h8"/><path d="M14 6l7 6-7 6z" fill="#31cbb9"/>') },
	jump: { label: '점프', group: 'move', color: '#31cbb9', from: '3관절 (탄성) 다리', icon: svg('<path d="M12 20V6M7 11l5-5 5 5"/><path d="M6 21h12"/>') },
	glide: { label: '활공', group: 'move', color: '#31cbb9', from: '날개', icon: svg('<path d="M12 13C8 5 4 6 2 9c3 0 6 2 10 4zM12 13c4-8 8-7 10-4-3 0-6 2-10 4z" fill="#b48cff"/>') },
	eat: { label: '풀 먹기', group: 'body', color: '#9be15d', from: '초식 또는 잡식 입', icon: svg('<path d="M12 21c0-7 0-11 6-15-1 7-3 10-6 11M12 21c0-5-2-8-7-10 1 5 3 7 7 8" fill="#9be15d"/>') },
	defence: { label: '방어', group: 'body', color: '#8fa3b8', from: '등의 가시', icon: svg('<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" fill="#cfd8e3"/>') },
};

export type SocialId = 'sing' | 'dance' | 'charm' | 'pose';
export type PredatorId = 'bite' | 'charge' | 'strike' | 'spit';
export const SOCIAL: SocialId[] = ['sing', 'dance', 'charm', 'pose'];
export const PREDATOR: PredatorId[] = ['bite', 'charge', 'strike', 'spit'];

export interface Abilities {
	level: Record<AbilityId, number>;
	/** the parts behind each ability, in words */
	parts: Record<AbilityId, string[]>;
	diet: 'plants' | 'meat' | 'both' | 'sunshine';
}

const cache = new Map<string, Abilities>();

/** How much one part gives: size 0.7 -> 1 level, 1 -> 1.7, 1.5 -> 2.8; a mirrored pair a quarter more. */
const partLevel = (p: DPart) => Math.max(1, Math.min(3.5, 1 + (p.k - 0.7) * 2.2)) * (p.m ? 1.25 : 1);

export function abilitiesOf(plan: Plan): Abilities {
	const hit = cache.get(plan.code);
	if (hit) return hit;
	const d = isDesignCode(plan.code) ? decodeDesign(plan.code) : designFromPlan(plan);
	const raw: Record<string, number> = {};
	const parts = {} as Record<AbilityId, string[]>;
	const give = (id: AbilityId, v: number, what: string) => {
		raw[id] = (raw[id] ?? 0) + v;
		(parts[id] ??= []).includes(what) || parts[id].push(what);
	};
	let herb = false,
		meat = false;
	for (const p of d.parts) {
		const L = partLevel(p);
		switch (p.t) {
			case 'mouth':
				if (p.v === 'carn') {
					give('bite', L + 0.6, '육식 입');
					meat = true;
				} else if (p.v === 'omni') {
					give('bite', Math.max(1, L - 0.3), '잡식 입');
					give('eat', Math.max(1, L - 0.3), '잡식 입');
					meat = herb = true;
				} else {
					give('eat', L + 0.4, '초식 입');
					herb = true;
				}
				break;
			case 'leg':
				if (p.v === 'digi') {
					give('jump', L, '탄성 다리');
					give('speed', L * 0.6, '탄성 다리');
				} else {
					give('speed', L * (p.v === 'insect' ? 0.9 : 1), p.v === 'insect' ? '곤충 다리' : '다리');
					give('jump', L * 0.35, p.v === 'insect' ? '곤충 다리' : '다리');
				}
				break;
			case 'arm':
				give('charge', L, '팔');
				break;
			case 'hand':
				give('charge', L * 0.8, '큰 손');
				break;
			case 'wing':
				give('glide', L + 0.3, '날개');
				break;
			case 'spike':
				// spikes standing up on the back defend; spikes anywhere else are for striking
				if (p.b > 0.6) give('defence', L + 0.3, '등 가시');
				else give('strike', L + 0.3, '가시');
				break;
			case 'frill':
				give('charm', L + 0.5, '주름 장식');
				break;
			case 'horn':
				give('pose', L + 0.3, p.v === 'curl' ? '곱슬 뿔' : '뿔');
				give('charge', L * 0.6, p.v === 'curl' ? '곱슬 뿔' : '뿔');
				break;
			case 'throat':
				if (p.v === 'spit') give('spit', L + 0.5, '침샘');
				else give('sing', L + 0.5, '울음주머니');
				break;
			case 'foot':
				give('dance', L + 0.5, '큰 발');
				break;
			case 'tail':
				if (p.v === 'ball' || p.v === 'spade') give('strike', L, p.v === 'ball' ? '몽둥이 꼬리' : '삽 꼬리');
				else if (p.v === 'fluff') give('charm', L * 0.8, '폭신한 꼬리');
				else give('dance', L * 0.8, '꼬리');
				break;
			case 'eye':
				if (p.k > 1.2) give('charm', 0.5, '큰 눈');
				break;
			case 'stalk':
				give('charm', 0.5, '눈 줄기');
				break;
		}
	}
	const level = {} as Record<AbilityId, number>;
	for (const id of Object.keys(ABILITY) as AbilityId[]) {
		level[id] = Math.max(0, Math.min(5, Math.round(raw[id] ?? 0)));
		parts[id] ??= [];
	}
	const a: Abilities = { level, parts, diet: herb && meat ? 'both' : herb ? 'plants' : meat ? 'meat' : 'sunshine' };
	cache.set(plan.code, a);
	return a;
}

/** Five pips, filled to the level. */
export function pips(level: number, color = '#23263a') {
	let s = '<span class="pips">';
	for (let i = 1; i <= 5; i++) s += `<i class="${i <= level ? 'on' : ''}" style="${i <= level ? `background:${color}` : ''}"></i>`;
	return `${s}</span>`;
}

/** The ability list for the editor and the Lab: every ability it has, with its level and the parts behind it. */
export function abilityPanel(plan: Plan): string {
	const A = abilitiesOf(plan);
	const rows = (Object.keys(ABILITY) as AbilityId[])
		.filter((id) => A.level[id] > 0)
		.map((id) => {
			const I = ABILITY[id];
			return `<div class="abrow" title="${I.label}: ${A.parts[id].join(', ')}에서"><span class="abico" style="background:${I.color}33">${I.icon}</span><span class="abname">${I.label}</span>${pips(A.level[id], I.color)}<em>${A.parts[id].join(', ')}</em></div>`;
		});
	const diet = { plants: '풀을 먹어요', meat: '고기를 먹어요', both: '풀과 고기 모두 먹어요', sunshine: '입이 없어요: 햇살로 살아요 (결코 배고프지 않음)' }[A.diet];
	if (!rows.length) rows.push('<div class="sub">아직 능력이 없어요: 부위를 추가하세요. 부위마다 하나의 능력에 레벨을 줘요.</div>');
	return `${rows.join('')}<div class="sub diet">${diet}</div>`;
}
