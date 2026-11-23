// Social encounters: walk up to a creature and greet it. It performs a short sequence of moves on a beat
// (sing, dance, charm, pose); you repeat them on the same beat with your own abilities. A higher level in a move
// gives a wider timing window and more friendship per move, and your pack joins in for a bonus. Fill the
// friendship meter in three rounds and the whole species becomes your friend.
import { ABILITY, type SocialId } from './abilities';
import type { Actor } from './actors';
import type { Play } from './play';

export type Phase = 'intro' | 'show' | 'ready' | 'play' | 'react' | 'won' | 'lost';
export type Mark = 'great' | 'good' | 'miss' | 'locked' | null;

const ROUNDS = [3, 4, 5];

export class EncounterRun {
	phase: Phase = 'intro';
	round = 0;
	seq: SocialId[] = [];
	marks: Mark[] = [];
	meter = 0;
	t = 0;
	/** start of the current phase's beat 0 (seconds into the phase) */
	beat = 0.82;
	shown = -1;
	idx = 0;
	message = '';
	tutorial: boolean;
	private lastTick = -1;

	constructor(
		readonly pl: Play,
		readonly partner: Actor,
	) {
		this.tutorial = !pl.flags.has('encounter-done');
		this.beat = this.tutorial ? 0.95 : 0.82;
		this.message = `${partner.sp!.name}: 네 실력을 보여 달래!`;
	}

	/** timing window (seconds either side of the beat) for one of your moves */
	window(m: SocialId) {
		const L = this.pl.player.abil.level[m];
		if (L <= 0) return 0;
		return (this.tutorial ? 0.08 : 0) + 0.2 + 0.065 * L;
	}

	private newRound() {
		const sp = this.partner.sp!;
		const n = ROUNDS[this.round];
		this.seq = [];
		for (let i = 0; i < n; i++) {
			// mostly its favourite moves, never three of the same in a row
			let m = sp.moves[Math.floor(Math.random() * sp.moves.length)];
			if (i >= 2 && this.seq[i - 1] === m && this.seq[i - 2] === m) m = sp.moves.find((x) => x !== m) ?? m;
			this.seq.push(m);
		}
		this.marks = this.seq.map(() => null);
		this.idx = 0;
		this.shown = -1;
	}

	private go(p: Phase) {
		this.phase = p;
		this.t = 0;
		this.lastTick = -1;
	}

	update(dt: number) {
		this.t += dt;
		const pl = this.pl;
		const B = this.beat;
		const pc = this.partner.c;
		const me = pl.player.c;
		pc.faceTarget = me.pos;
		pc.lookTarget = me.headPos;
		pc.intentSpeed = 0;
		me.faceTarget = pc.pos;
		me.lookTarget = pc.headPos;
		switch (this.phase) {
			case 'intro':
				if (this.t > 1.4) {
					this.newRound();
					this.go('show');
					this.message = '잘 봐…';
				}
				break;
			case 'show': {
				const k = Math.floor(this.t / B);
				if (k !== this.shown && k < this.seq.length) {
					this.shown = k;
					pc.act(this.seq[k], B * 0.95);
					pl.moveSound(this.seq[k], this.partner, k);
				}
				if (this.t > this.seq.length * B + B * 0.3) {
					this.go('ready');
					this.message = '네 차례!';
				}
				break;
			}
			case 'ready': {
				// two count-in ticks
				const k = Math.floor(this.t / B);
				if (k !== this.lastTick && k < 2) {
					this.lastTick = k;
					pl.sound('tick', null, k === 1 ? 0.8 : 0.55, k === 1 ? 1.5 : 1.2);
				}
				if (this.t >= 2 * B) this.go('play');
				break;
			}
			case 'play': {
				// a soft tick on every beat you have to hit
				const k = Math.floor((this.t + 0.0001) / B);
				if (k !== this.lastTick && k < this.seq.length) {
					this.lastTick = k;
					pl.sound('tick', null, 0.3, 1.3);
				}
				// misses: beats that passed outside their window
				while (this.idx < this.seq.length) {
					const T = this.idx * B;
					const w = this.window(this.seq[this.idx]);
					if (this.t > T + Math.max(0.12, w)) {
						this.marks[this.idx] = w > 0 ? 'miss' : 'locked';
						this.meter = Math.max(0, this.meter - 3);
						pl.sound('miss', null, 0.5);
						this.idx++;
					} else break;
				}
				if (this.idx >= this.seq.length && this.t > this.seq.length * B) {
					this.go('react');
					const hits = this.marks.filter((m) => m === 'great' || m === 'good').length;
					const good = hits >= Math.ceil(this.seq.length * 0.6);
					if (good) {
						pc.jump(Math.max(0.08, (pc.plan.legLength || pc.plan.R) * 0.35));
						pl.game.fx.love(pc.headPos, pc.plan.size);
						pl.sound('voice', this.partner, 0.8);
						this.message = hits === this.seq.length ? '완벽해! 정말 마음에 들어 했어!' : '마음에 들어 했어!';
					} else {
						pc.act('hit', 0.5);
						this.message = '별로 감동하지 못한 것 같아…';
					}
				}
				break;
			}
			case 'react':
				if (this.t > 1.5) {
					if (this.meter >= 100) {
						this.go('won');
						this.message = `${this.partner.sp!.many} 무리가 너의 친구가 됐어!`;
						pl.befriend(this.partner);
					} else if (this.round >= ROUNDS.length - 1) {
						this.go('lost');
						this.message = `가 버렸어. 다시 시도하거나, 에디터에서 더 좋은 ${this.partner.sp!.moves.map((m) => ABILITY[m].label).join(', ')} 부위를 달아 줘.`;
						pl.sound('miss', null, 0.6, 0.8);
					} else {
						this.round++;
						this.newRound();
						this.go('show');
						this.message = '잘 봐…';
					}
				}
				break;
			case 'won':
			case 'lost':
				if (this.t > 2.6) pl.endEncounter(this.phase === 'won');
				break;
		}
	}

	/** the player pressed a social move */
	input(m: SocialId) {
		if (this.phase !== 'play' || this.idx >= this.seq.length) return;
		const pl = this.pl;
		const T = this.idx * this.beat;
		const want = this.seq[this.idx];
		const w = this.window(want);
		const off = Math.abs(this.t - T);
		// a press far before the beat is ignored (too early to count)
		if (this.t < T - Math.max(0.25, w * 1.6)) return;
		const L = pl.player.abil.level[m];
		pl.player.c.act(m, this.beat * 0.9);
		pl.moveSound(m, pl.player, this.idx);
		if (L <= 0) {
			pl.hud.say(`${ABILITY[m].label}: 아직 사용할 수 없어. 필요한 부위: ${ABILITY[m].from}.`, 'var(--yellow)');
		}
		if (m === want && L > 0 && off <= w) {
			const great = off <= w * 0.45;
			const allies = pl.pack.filter((a) => a.alive).length;
			const pts = ((8 + 4 * L) * (great ? 1.25 : 1)) / this.partner.sp!.fussy + allies * 4;
			this.meter = Math.min(100, this.meter + pts);
			this.marks[this.idx] = great ? 'great' : 'good';
			pl.sound(great ? 'great' : 'good', null, 0.55, 1 + this.idx * 0.06);
			pl.game.fx.sparkle(pl.player.c.headPos, pl.player.size * 0.6, ABILITY[m].color);
			// the pack performs with you
			for (const a of pl.pack) if (a.alive && !a.c.action) a.c.act(m, this.beat * 0.9);
		} else {
			this.marks[this.idx] = 'miss';
			this.meter = Math.max(0, this.meter - 4);
			pl.sound('miss', null, 0.5);
		}
		this.idx++;
	}
}
