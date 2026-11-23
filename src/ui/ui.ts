// DOM UI: title veil, welcome card, toolbar, the selected creature's card, toasts, "try this" hints, and the Dex.
import { linearToHex } from '../creature/color';
import type { Creature } from '../creature/creature';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface DexEntry {
	code: string;
	name: string;
	species: string;
	traits: string[];
	seed?: string;
	parents?: string[];
	parentCodes?: string[];
	from?: Record<string, string>;
	changes?: string[];
	at: number;
	thumb?: string;
}

const DEX_KEY = 'wigglewild.dex.v1';

export class Dex {
	entries: DexEntry[] = [];
	constructor() {
		try {
			const raw = localStorage.getItem(DEX_KEY);
			if (raw) this.entries = JSON.parse(raw);
		} catch {
			this.entries = [];
		}
	}
	has(code: string) {
		return this.entries.some((e) => e.code === code);
	}
	add(e: DexEntry): boolean {
		if (this.has(e.code)) return false;
		this.entries.unshift(e);
		this.save();
		return true;
	}
	setThumb(code: string, thumb: string) {
		const e = this.entries.find((x) => x.code === code);
		if (e && !e.thumb) {
			e.thumb = thumb;
			this.save();
		}
	}
	save() {
		try {
			localStorage.setItem(DEX_KEY, JSON.stringify(this.entries.slice(0, 400)));
		} catch {
			// quota: drop thumbnails of the oldest half and retry once
			try {
				for (const e of this.entries.slice(100)) delete e.thumb;
				localStorage.setItem(DEX_KEY, JSON.stringify(this.entries.slice(0, 400)));
			} catch {}
		}
	}
}

export class UI {
	readonly veil = $('veil');
	readonly card = $('card');
	readonly counter = $('counter');
	readonly hint = $('hint');
	readonly welcome = $('welcome');
	readonly dexEl = $('dex');
	readonly seedIn = $<HTMLInputElement>('seed-in');
	readonly debug = $('debug');
	private hintTimer = 0;
	private hintQueue: string[] = [];
	private shownCard: number | null = null;

	progress(text: string, p: number) {
		$('veil-status').textContent = text;
		$('veil-bar').style.transform = `scaleX(${p})`;
	}
	ready() {
		this.veil.classList.add('ready');
		$('veil-status').textContent = '';
	}
	hideVeil() {
		this.veil.classList.add('gone');
		document.body.classList.add('playing');
	}
	showWelcome(on: boolean) {
		this.welcome.classList.toggle('on', on);
	}
	get welcomeOpen() {
		return this.welcome.classList.contains('on');
	}
	get dexOpen() {
		return this.dexEl.classList.contains('on');
	}

	toast(html: string, color = 'var(--paper)', ms = 2600) {
		const t = document.createElement('div');
		t.className = 'toast sticker';
		t.style.background = color;
		t.innerHTML = html;
		$('toasts').appendChild(t);
		const all = $('toasts').children;
		if (all.length > 4) all[0].remove();
		setTimeout(() => {
			t.classList.add('out');
			setTimeout(() => t.remove(), 320);
		}, ms);
	}

	/** "Try this" prompts, one at a time. */
	tryThis(text: string) {
		if (this.hintQueue.includes(text) || this.hint.textContent === text) return;
		this.hintQueue.push(text);
	}
	setHint(text: string | null) {
		if (!text) {
			this.hint.classList.add('gone');
			this.hintTimer = 0;
			return;
		}
		this.hint.textContent = text;
		this.hint.classList.remove('gone');
		this.hintTimer = 1e9;
	}
	updateHints(dt: number) {
		if (this.hintTimer > 1e8) return;
		this.hintTimer -= dt;
		if (this.hintTimer <= 0) {
			const next = this.hintQueue.shift();
			if (next) {
				this.hint.textContent = next;
				this.hint.classList.remove('gone');
				this.hintTimer = 6;
			} else this.hint.classList.add('gone');
		}
	}

	showCard(c: Creature | null, extra: { seed?: string; parents?: string[]; following: boolean; strength?: 'subtle' | 'wild' }) {
		if (!c) {
			this.card.classList.remove('show');
			this.shownCard = null;
			return;
		}
		const P = c.plan;
		const pal = P.palette;
		const sw = [pal.body, pal.belly, pal.accent, pal.pattern].map((x) => `<i style="background:${linearToHex(x)}"></i>`).join('');
		const seedLine = extra.seed ? `씨앗 <b>${esc(extra.seed)}</b>` : extra.parents?.length ? `부모: ${extra.parents.map(esc).join(', ')}` : '돌연변이';
		this.card.innerHTML = `
			<div style="display:flex;align-items:flex-start;gap:8px">
				<div style="min-width:0;flex:1"><div class="name" style="font-size:${P.name.length > 10 ? Math.max(18, 26 - (P.name.length - 10) * 1.6) : 26}px">${esc(P.name)}</div><div class="species">${esc(P.species)}</div></div>
				<div class="swatches">${sw}</div>
			</div>
			<div class="chips">${P.traits.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
			<div style="font-size:12px;font-weight:700;margin-bottom:6px">${seedLine}</div>
			<div class="code"><span title="${P.code}">${P.code}</span><button data-act="copy">복사</button></div>
			<div class="row">
				<button class="btn primary" data-act="lab" title="연구소에서 보기 (L)">연구소 <kbd>L</kbd></button>
				<button class="btn" data-act="edit" title="에디터에서 수정 (E)">수정 <kbd>E</kbd></button>
				<button class="btn" data-act="mutate">돌연변이 <kbd>M</kbd></button>
				<span class="seg"><button class="${extra.strength !== 'wild' ? 'on' : ''}" data-act="subtle">살짝</button><button class="${extra.strength === 'wild' ? 'on' : ''}" data-act="wild">야생</button></span>
				<button class="btn" data-act="breed">교배 <kbd>B</kbd></button>
				<button class="btn${extra.following ? ' on' : ''}" data-act="follow">${extra.following ? '따라가는 중' : '따라가기'} <kbd>F</kbd></button>
				<button class="btn" data-act="release" title="야생으로 돌려보내기 (Delete)">놓아주기</button>
			</div>`;
		if (this.shownCard !== c.id) {
			this.card.classList.remove('show');
			void this.card.offsetWidth;
		}
		this.card.classList.add('show');
		this.shownCard = c.id;
	}

	setCounter(alive: number, dex: number) {
		this.counter.textContent = `크리터 ${alive} · 도감 ${dex}`;
	}

	renderDex(d: Dex, onHatch: (code: string, lab?: boolean | 'play') => void) {
		$('dex-sub').textContent = `${d.entries.length}마리 발견`;
		const grid = $('dex-grid');
		grid.innerHTML = d.entries.length
			? d.entries
					.map(
						(e, i) => `<div class="dexcard">${e.thumb ? `<img alt="" src="${e.thumb}">` : '<div class="ph"></div>'}<div class="n">${esc(e.name)}</div><div class="s">${esc(e.species)}</div><div class="s">${e.seed ? `씨앗 ${esc(e.seed)}` : e.parents?.length ? '교배' : '돌연변이'}</div><div style="display:flex;gap:4px;flex-wrap:wrap"><button class="btn" data-i="${i}" style="flex:1">${playMode() ? '이걸로 플레이' : '부화'}</button><button class="btn" data-lab="${i}" style="flex:1">연구소</button>${playMode() ? '' : `<button class="btn" data-play="${i}" style="flex:1 0 100%">이걸로 플레이</button>`}</div></div>`,
					)
					.join('')
			: '<div style="font-weight:700;opacity:.7;padding:20px">아직 없어요. 크리터를 부화시켜 도감을 시작하세요.</div>';
		grid.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) => {
			b.onclick = () => onHatch(d.entries[Number(b.dataset.i)].code);
		});
		grid.querySelectorAll<HTMLButtonElement>('button[data-play]').forEach((b) => {
			b.onclick = () => onHatch(d.entries[Number(b.dataset.play)].code, 'play');
		});
		grid.querySelectorAll<HTMLButtonElement>('button[data-lab]').forEach((b) => {
			b.onclick = () => onHatch(d.entries[Number(b.dataset.lab)].code, true);
		});
	}

	flash() {
		const f = $('flash');
		f.classList.add('on');
		requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
	}
}

const playMode = () => document.body.classList.contains('mode-play');
