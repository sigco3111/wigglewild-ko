// Play HUD, kept small: health, hunger and stamina top left; the goal top right; your abilities along the bottom
// with the right key or pad button on each; a context prompt; your pack; health bars over creatures you fight,
// red "!" over ones about to attack; the quest marker; the encounter panel; the controls card and the pause menu.
import * as THREE from 'three';
import { ABILITY, type AbilityId, pips } from './abilities';
import type { Actor } from './actors';
import { type Button, glyph, padWord } from './input';
import type { Play } from './play';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const MOVE_BTN: Record<string, Button> = { sing: 'sing', dance: 'dance', charm: 'charm', pose: 'pose', bite: 'bite', charge: 'charge', strike: 'strike', spit: 'spit', jump: 'jump', glide: 'jump' };

const GOALS: Record<string, { title: string; hint: (pl: Play) => string }> = {
	hatch: { title: '부화', hint: () => '알이 부화하고 있어요… (Space / Cross로 도와주세요)' },
	eat: { title: '열매 먹기', hint: (pl) => `배가 고파요. 덤불 옆의 열매를 찾아 ${glyph('interact', pl.input.device)} 키로 먹으세요.` },
	meet: { title: '퍼프모스 만나기', hint: (pl) => `겁이 많은 아이들이에요. 천천히 살금살금 다가가서 (${pl.input.device === 'gamepad' ? `<kbd>${padWord('L2')}</kbd>` : '<kbd>C</kbd>'}), then greet one with ${glyph('interact', pl.input.device)}.` },
	fend: { title: '사냥꾼 물리치기', hint: (pl) => `물기(${glyph('bite', pl.input.device)})이나 돌진(${glyph('charge', pl.input.device)})으로 맞서세요. 점프로 회피하세요.` },
	explore: { title: '섬 탐험하기', hint: (pl) => `친구: 5종 중 ${pl.allied.size}종 · 무리 ${pl.pack.length}/2. 인사해서 친구가 되거나, 싸워서 먹이를 얻으세요.` },
};

export class Hud {
	readonly root: HTMLDivElement;
	private el: Record<string, HTMLElement> = {};
	private bars: HTMLDivElement[] = [];
	private tells: HTMLDivElement[] = [];
	private v = new THREE.Vector3();
	private shownAbil = '';
	private lastDevice = '';
	private encShown = '';
	private toastQ: Array<{ html: string; color: string; ms: number }> = [];

	constructor(readonly pl: Play) {
		const r = document.createElement('div');
		r.id = 'play-hud';
		r.className = 'layer';
		r.innerHTML = `
			<div id="ph-vitals" class="sticker">
				<div class="vrow"><span class="vico">${heart}</span><i class="vbar"><b id="ph-hp" style="background:var(--pink)"></b></i></div>
				<div class="vrow"><span class="vico">${apple}</span><i class="vbar"><b id="ph-food" style="background:#9be15d"></b></i></div>
				<div class="vrow" id="ph-stam-row"><span class="vico">${bolt}</span><i class="vbar thin"><b id="ph-stam" style="background:var(--yellow)"></b></i></div>
			</div>
			<div id="ph-goal" class="sticker"><div class="gt"><span id="ph-goal-title"></span><span id="ph-clock"></span></div><div id="ph-goal-hint"></div></div>
			<div id="ph-pack"></div>
			<div id="ph-prompt" class="sticker gone"></div>
			<div id="ph-abil"></div>
			<div id="ph-marker" class="gone"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 22 4 8a8 8 0 1 1 16 0z" fill="#ffd23f" stroke="#23263a" stroke-width="2"/><circle cx="12" cy="8" r="3" fill="#23263a"/></svg><span id="ph-marker-d"></span></div>
			<div id="ph-enc" class="sticker gone"></div>
			<div id="ph-say"></div>
			<div id="ph-faint" class="gone"><div>기절했어요…</div></div>
			<div id="ph-lock" class="gone">화면을 클릭하면 마우스로 둘러볼 수 있어요</div>
			<div id="ph-controls" class="layer modal"><div class="card sticker" id="ph-controls-card"></div></div>
			<div id="ph-pause" class="layer modal"><div class="card sticker">
				<h2>일시정지</h2>
				<div class="pmenu">
					<button class="btn primary" data-p="resume">계속하기</button>
					<button class="btn" data-p="controls">조작법</button>
					<button class="btn" data-p="editor">크리터 바꾸기 (에디터)</button>
					<button class="btn" data-p="lab">내 크리터를 연구소에서 보기</button>
					<button class="btn" data-p="dex">도감</button>
					<button class="btn" data-p="meadow">초원 샌드박스</button>
				</div>
			</div></div>`;
		document.body.appendChild(r);
		this.root = r;
		for (const n of r.querySelectorAll<HTMLElement>('[id]')) this.el[n.id.replace('ph-', '')] = n;
		r.querySelector('#ph-pause')!.addEventListener('click', (e) => {
			const p = (e.target as HTMLElement).closest('[data-p]')?.getAttribute('data-p');
			if (!p) return;
			this.pause(false);
			const g = this.pl.game;
			if (p === 'controls') this.controls(true);
			else if (p === 'editor') void g.openEditor(this.pl.player.c);
			else if (p === 'lab') void g.openLab(this.pl.player.c);
			else if (p === 'dex') g.openDex(true);
			else if (p === 'meadow') g.setMode('meadow');
		});
		this.el.controls.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('[data-c]') || e.target === this.el.controls) this.controls(false);
		});
		this.el.abil.addEventListener('click', (e) => {
			const id = (e.target as HTMLElement).closest('[data-ab]')?.getAttribute('data-ab');
			if (id && MOVE_BTN[id]) this.pl.input.press(MOVE_BTN[id]);
		});
	}

	show(on: boolean) {
		this.root.classList.toggle('on', on);
	}

	controls(on = !this.el.controls.classList.contains('on')) {
		const d = this.pl.input.device;
		const row = (b: Button | string, what: string, pad?: string) => `<div><span class="k">${typeof b === 'string' && !(b in MOVE_BTN) && b !== 'interact' && b !== 'dex' && b !== 'help' && b !== 'pause' && b !== 'call' ? b : glyph(b as Button, 'keyboard')}</span><span class="k">${pad ?? glyph(b as Button, 'gamepad')}</span><span>${what}</span></div>`;
		this.el['controls-card'].innerHTML = `
			<h2>조작법</h2>
			<div class="ctl"><div class="hd"><span>키보드 + 마우스</span><span>게임패드</span><span></span></div>
			${row('<kbd>WASD</kbd>', '이동', '<kbd>왼쪽 스틱</kbd>')}
			${row('<kbd>마우스</kbd>', '시점 (먼저 화면을 클릭)', '<kbd>오른쪽 스틱</kbd>')}
			${row('<kbd>Shift</kbd>', '달리기 (스태미나 소모)', `<kbd>${padWord('R2')}</kbd>`)}
			${row('<kbd>C</kbd>', '살금살금: 크리터가 덜 알아채요', `<kbd>${padWord('L2')}</kbd>`)}
			${row('jump', '점프; 날개가 있으면 길게 눌러 활공')}
			${row('interact', '먹기, 인사, 동료 영입, 알에서 크리터 바꾸기')}
			${row('bite', '물기')}
			${row('charge', '돌진')}
			${row('strike', '치기')}
			${row('spit', '뱉기')}
			${row('<kbd>1 2 3 4</kbd>', '노래, 춤, 매력, 포즈 (인사 교환)', '<kbd>십자키</kbd>')}
			${row('call', '크리터 불러오기')}
			${row('dex', '도감')}
			${row('help', '이 카드')}
			${row('pause', '일시정지 메뉴')}
			</div>
			<p class="sub">모든 능력은 몸의 부위에서 나와요. 둥지에서 크리터를 바꾸면 새 능력을 얻을 수 있어요.</p>
			<button class="btn primary" data-c="1">알겠어요 ${d === 'gamepad' ? glyph('jump', 'gamepad') : '<kbd>Enter</kbd>'}</button>`;
		this.el.controls.classList.toggle('on', on);
		this.pl.paused = on || this.el.pause.classList.contains('on');
	}
	get controlsOpen() {
		return this.el.controls.classList.contains('on');
	}

	pause(on: boolean) {
		this.el.pause.classList.toggle('on', on);
		this.pl.paused = on || this.controlsOpen;
		if (on && document.pointerLockElement) document.exitPointerLock?.();
	}

	faint(on: boolean) {
		this.el.faint.classList.toggle('gone', !on);
	}

	say(html: string, color = 'var(--paper)', ms = 3000) {
		const box = this.el.say;
		// one at a time, newest wins quickly
		while (box.children.length > 2) box.firstElementChild?.remove();
		if ([...box.children].some((c) => (c as HTMLElement).dataset.h === html)) return;
		const d = document.createElement('div');
		d.className = 'sticker say';
		d.dataset.h = html;
		d.style.background = color;
		d.innerHTML = html;
		box.appendChild(d);
		setTimeout(() => d.classList.add('out'), ms);
		setTimeout(() => d.remove(), ms + 400);
		void this.toastQ;
	}

	objective(flash = false) {
		const g = GOALS[this.pl.step];
		this.el['goal-title'].innerHTML = g.title;
		this.el['goal-hint'].innerHTML = g.hint(this.pl);
		if (flash) {
			this.el.goal.classList.remove('pop');
			void this.el.goal.offsetWidth;
			this.el.goal.classList.add('pop');
			this.pl.sound('confirm', null, 0.5);
		}
	}

	rebuildAbilities() {
		this.shownAbil = '';
	}

	rebuildPack() {
		const el = this.el.pack;
		if (!el) return;
		el.innerHTML = this.pl.pack
			.map((a) => {
				const th = this.pl.game.dex.entries.find((d) => d.code === a.c.plan.code)?.thumb;
				return `<div class="pk sticker" data-id="${a.id}">${th ? `<img alt="" src="${th}"/>` : '<div class="ph"></div>'}<div><b>${esc(a.c.plan.name)}</b><i class="vbar thin"><b style="background:var(--pink);width:${Math.round((a.hp / a.maxHp) * 100)}%"></b></i></div></div>`;
			})
			.join('');
	}

	encounter(on: boolean) {
		this.el.enc.classList.toggle('gone', !on);
		this.encShown = '';
	}

	update(dt: number) {
		const pl = this.pl;
		const me = pl.player;
		const dev = pl.input.device;
		(this.el.hp as HTMLElement).style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
		this.el.food.style.width = `${pl.hunger * 100}%`;
		this.el.food.parentElement!.parentElement!.style.display = me.abil.diet === 'sunshine' ? 'none' : '';
		this.el.stam.style.width = `${pl.stamina * 100}%`;
		this.el['stam-row'].style.opacity = pl.stamina < 0.99 ? '1' : '0.35';
		this.el.vitals.classList.toggle('low', me.hp < me.maxHp * 0.3 || pl.hunger < 0.12);
		this.el.clock.textContent = pl.day.label();
		if (dev !== this.lastDevice) {
			this.lastDevice = dev;
			this.shownAbil = '';
			this.objective();
		}
		if (pl.step === 'explore' && Math.random() < dt * 2) this.objective();
		// ability bar
		const bar = pl.abilityBar();
		const key = `${me.c.plan.code}|${dev}|${bar.map((b) => b.level).join('')}`;
		if (key !== this.shownAbil) {
			this.shownAbil = key;
			this.el.abil.innerHTML = bar
				.map((b) => {
					const I = b.id === 'jump' ? ABILITY.jump : b.id === 'glide' ? ABILITY.glide : ABILITY[b.id as AbilityId];
					const off = b.level <= 0;
					return `<div class="ab sticker${off ? ' off' : ''}${['sing', 'bite'].includes(b.id) ? ' gap' : ''}" data-ab="${b.id}" title="${I.label}${off ? `: ${I.from} 필요` : ''}"><span class="abi" style="background:${I.color}55">${I.icon}</span><span class="abl">${b.id === 'glide' ? '활공 (길게 누르기)' : I.label}</span>${pips(b.level, I.color)}<span class="abk">${glyph(MOVE_BTN[b.id], dev)}</span><i class="cdm"></i></div>`;
				})
				.join('');
		}
		const cells = this.el.abil.children;
		bar.forEach((b, i) => {
			const m = cells[i]?.querySelector('.cdm') as HTMLElement | null;
			if (m) m.style.height = `${Math.round(Math.min(1, b.cd) * 100)}%`;
		});
		// context prompt
		const p = pl.prompt();
		this.el.prompt.classList.toggle('gone', !p);
		if (p) this.el.prompt.innerHTML = `${p.what === 'wait' || p.what === 'cant' ? '' : glyph('interact', dev)} ${esc(p.text)}`;
		// pointer lock hint
		this.el.lock.classList.toggle('gone', !(dev === 'keyboard' && document.pointerLockElement !== pl.game.canvas && !pl.paused && pl.stepT > 4 && pl.step !== 'hatch'));
		// pack hp
		for (const div of this.el.pack.children) {
			const a = pl.pack.find((x) => String(x.id) === (div as HTMLElement).dataset.id);
			const b = div.querySelector('.vbar b') as HTMLElement | null;
			if (a && b) b.style.width = `${Math.max(0, (a.hp / a.maxHp) * 100)}%`;
		}
		if (this.el.pack.querySelector('.ph') && Math.random() < dt) this.rebuildPack();
		this.overheads();
		this.marker();
		this.encounterPanel();
	}

	private project(p: THREE.Vector3) {
		const cam = this.pl.game.camera;
		this.v.copy(p).project(cam);
		const r = this.pl.game.canvas.getBoundingClientRect();
		return { x: r.left + ((this.v.x + 1) / 2) * r.width, y: r.top + ((1 - this.v.y) / 2) * r.height, behind: this.v.z > 1, w: r.width, h: r.height };
	}

	/** health bars over creatures you're fighting, a red "!" over ones winding up */
	private overheads() {
		const pl = this.pl;
		const show: Array<{ a: Actor; p: ReturnType<Hud['project']> }> = [];
		const tell: Array<ReturnType<Hud['project']>> = [];
		for (const a of pl.actors) {
			if (a === pl.player || !a.alive) continue;
			if (a.c.pos.distanceTo(pl.player.c.pos) > 28) continue;
			const top = this.v.copy(a.c.bodyPos);
			top.y = a.c.pos.y + a.c.plan.top + 0.25 + a.c.plan.R * 0.4;
			const p = this.project(top);
			if (p.behind) continue;
			if (a.barT > 0 || (a.foe === pl.player && a.state === 'attack')) show.push({ a, p });
			if (a.windup || (a.state === 'threaten' && a.foe !== pl.player)) tell.push(p);
		}
		while (this.bars.length < show.length) {
			const d = document.createElement('div');
			d.className = 'ovbar';
			d.innerHTML = '<b></b>';
			this.root.appendChild(d);
			this.bars.push(d);
		}
		this.bars.forEach((d, i) => {
			const s = show[i];
			d.style.display = s ? '' : 'none';
			if (!s) return;
			d.style.transform = `translate(${s.p.x - 26}px, ${s.p.y - 14}px)`;
			(d.firstElementChild as HTMLElement).style.width = `${Math.max(0, (s.a.hp / s.a.maxHp) * 100)}%`;
			d.classList.toggle('ally', s.a.ally);
		});
		while (this.tells.length < tell.length) {
			const d = document.createElement('div');
			d.className = 'tell';
			d.textContent = '!';
			this.root.appendChild(d);
			this.tells.push(d);
		}
		this.tells.forEach((d, i) => {
			const p = tell[i];
			d.style.display = p ? '' : 'none';
			if (p) d.style.transform = `translate(${p.x - 12}px, ${p.y - 52}px)`;
		});
	}

	/** the goal marker: above the target, or pinned to the screen edge pointing at it */
	private marker() {
		const pl = this.pl;
		const t = pl.objectivePos();
		const m = this.el.marker;
		if (!t || pl.encounter.active || pl.paused) {
			m.classList.add('gone');
			return;
		}
		m.classList.remove('gone');
		const p = this.project(this.v.copy(t).setY(t.y + 0.5));
		let { x, y } = p;
		const pad = 50;
		// keep clear of the vitals and goal cards (top) and the ability bar (bottom)
		const top = 120,
			bottom = 130;
		const inside = !p.behind && x > pad && x < p.w - pad && y > top && y < p.h - bottom;
		if (!inside) {
			// direction from the screen centre, clamped to the edge
			let dx = x - p.w / 2,
				dy = y - p.h / 2;
			if (p.behind) {
				dx = -dx;
				dy = Math.abs(dy) + 1;
			}
			const s = Math.min((p.w / 2 - pad) / Math.max(1e-3, Math.abs(dx)), (dy < 0 ? p.h / 2 - top : p.h / 2 - bottom) / Math.max(1e-3, Math.abs(dy)));
			x = p.w / 2 + dx * s;
			y = p.h / 2 + dy * s;
		}
		m.classList.toggle('edge', !inside);
		m.style.transform = `translate(${x - 15}px, ${y - 30}px)`;
		const d = Math.hypot(t.x - pl.player.c.pos.x, t.z - pl.player.c.pos.z);
		this.el['marker-d'].textContent = d > 4 ? `${Math.round(d)}m` : '';
	}

	private encounterPanel() {
		const run = this.pl.encounter.active;
		if (!run) return;
		const dev = this.pl.input.device;
		const sp = run.partner.sp!;
		const B = run.beat;
		const icons = run.seq
			.map((m, i) => {
				const I = ABILITY[m];
				const lit = run.phase === 'show' && run.shown === i;
				const now = run.phase === 'play' && run.idx === i;
				const mark = run.marks[i];
				const L = this.pl.player.abil.level[m];
				return `<div class="em${lit ? ' lit' : ''}${now ? ' now' : ''}${mark ? ` ${mark}` : ''}" style="--c:${I.color}"><span class="emi">${I.icon}</span><span class="eml">${I.label}</span>${run.phase === 'play' || run.phase === 'ready' ? `<span class="emk">${L > 0 ? glyph(MOVE_BTN[m], dev) : '<kbd>잠김</kbd>'}</span>` : ''}${mark && mark !== 'locked' ? `<span class="emm">${mark === 'great' ? '완벽!' : mark === 'good' ? '좋아요' : '빗나감'}</span>` : ''}</div>`;
			})
			.join('');
		// the beat: a ring that closes on each beat during your turn
		const phaseT = run.phase === 'play' ? (run.t % B) / B : run.phase === 'ready' ? (run.t % B) / B : 0;
		const key = `${run.phase}|${run.round}|${run.idx}|${run.shown}|${run.marks.join()}|${Math.round(run.meter)}|${dev}`;
		if (key !== this.encShown) {
			this.encShown = key;
			this.el.enc.innerHTML = `
				<div class="eh"><b>${esc(sp.name)}</b><span class="sub">라운드 ${run.round + 1}/3</span></div>
				<div class="meter"><i style="width:${run.meter}%"></i><span>${heart} 친밀도 ${Math.round(run.meter)}%</span></div>
				<div class="emsg">${esc(run.message)}</div>
				<div class="eseq">${icons}</div>
				${run.tutorial && (run.phase === 'ready' || run.phase === 'play') ? `<div class="sub">링이 닫힐 때 각 동작을 누르세요. 동작 레벨이 높을수록 타이밍이 쉬워져요.</div>` : ''}
				<div class="beat"><i></i></div>`;
		}
		const ring = this.el.enc.querySelector('.beat i') as HTMLElement | null;
		if (ring) {
			const k = run.phase === 'play' || run.phase === 'ready' ? 1 - phaseT : 0;
			ring.style.transform = `scale(${0.35 + 0.65 * k})`;
			ring.style.opacity = run.phase === 'play' || run.phase === 'ready' ? '1' : '0';
		}
	}
}

const heart = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z" fill="#ff6fa8" stroke="#23263a" stroke-width="2"/></svg>';
const apple = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 7c-5-3-9 1-8 6 1 6 5 9 8 7 3 2 7-1 8-7 1-5-3-9-8-6z" fill="#9be15d" stroke="#23263a" stroke-width="2"/><path d="M12 7c0-2 1-4 3-4" stroke="#23263a" stroke-width="2" fill="none"/></svg>';
const bolt = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="#ffd23f" stroke="#23263a" stroke-width="2" stroke-linejoin="round"/></svg>';
