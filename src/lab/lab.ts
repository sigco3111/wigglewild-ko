// The Lab: a specimen view. The creature stands on a turntable pedestal in a studio, idles, blinks and reacts to
// clicks; a naturalist's plate overlays measured lines and callouts; panels show real stats (measured in a sim
// run), gene cards with the parent each trait came from, and a family tree.
import * as THREE from 'three';
import { abilityPanel } from '../play/abilities';
import type { Game } from '../game';
import { Batches } from '../creature/batches';
import { linearToHex } from '../creature/color';
import { Creature, type WorldQuery } from '../creature/creature';
import { GROUP_NAMES } from '../creature/evolve';
import type { Plan } from '../creature/build';
import { planFromCode } from '../creature/codes';
import { measureStats, type Stats } from '../creature/stats';
import { toonMaterial } from '../look/materials';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function makeStudio() {
	const s = new THREE.Scene();
	const uAO = { value: new THREE.Vector2(0.5, 0.6) };
		// studio: a soft gradient cyclorama
		const dome = new THREE.Mesh(
			new THREE.SphereGeometry(60, 32, 16),
			new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true, depthWrite: false, fog: false }),
		);
		const pos = dome.geometry.attributes.position as THREE.BufferAttribute;
		const col = new Float32Array(pos.count * 3);
		const top = new THREE.Color('#f6efe2'),
			mid = new THREE.Color('#e9dcc6'),
			bot = new THREE.Color('#cfd9c4');
		const c = new THREE.Color();
		for (let i = 0; i < pos.count; i++) {
			const y = pos.getY(i) / 60;
			if (y > 0) c.copy(mid).lerp(top, Math.min(1, y * 1.5));
			else c.copy(mid).lerp(bot, Math.min(1, -y * 3));
			col.set([c.r, c.g, c.b], i * 3);
		}
		dome.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
		dome.renderOrder = -10;
		s.add(dome);
		// floor disc and pedestal (top at y = 0)
		const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2).translate(0, -0.32, 0), toonMaterial({ color: '#e4d6bd' }, { key: 'labfloor', edge: [-0.3, 0.3] }));
		floor.receiveShadow = true;
		s.add(floor);
		const ped = new THREE.CylinderGeometry(1, 1.06, 0.32, 64, 1).translate(0, -0.16, 0);
		const pcol = new Float32Array(ped.attributes.position.count * 3);
		for (let i = 0; i < ped.attributes.position.count; i++) {
			const y = ped.attributes.position.getY(i);
			const cc = y > -0.01 ? new THREE.Color('#fffaf0') : new THREE.Color('#e8b96a');
			pcol.set([cc.r, cc.g, cc.b], i * 3);
		}
		ped.setAttribute('color', new THREE.BufferAttribute(pcol, 3));
		const pedMat = toonMaterial(
			{ vertexColors: true },
			{
				key: 'pedestal',
				edge: [-0.3, 0.3],
				rim: 0.2,
				uniforms: { uAO },
				fragmentPars: 'uniform vec2 uAO;',
				// soft contact shadow under the creature, baked into the top face
				fragmentBody: 'if (vWorldPos.y > -0.005) { float d = length(vWorldPos.xz) / max(0.05, uAO.x); diffuseColor.rgb *= 1.0 - uAO.y * (1.0 - smoothstep(0.2, 1.0, d)); }',
			},
		);
		const pedestal = new THREE.Mesh(ped, pedMat);
		pedestal.receiveShadow = true;
		pedestal.castShadow = true;
		s.add(pedestal);
		// studio light: warm key with soft shadows, cool fill from the sky colour (in the shared uniforms)
		const key = new THREE.DirectionalLight(0xfff1dc, 1);
		key.position.set(3, 6, 4);
		key.castShadow = true;
		key.shadow.mapSize.setScalar(2048);
		key.shadow.bias = -0.0004;
		key.shadow.normalBias = 0.02;
		key.shadow.radius = 3;
		s.add(key, key.target);
	return { scene: s, pedestal, key, uAO };
}

export const PEDESTAL_WORLD: WorldQuery = {
	ground(_x: number, _z: number, n?: THREE.Vector3) {
		n?.set(0, 1, 0);
		return 0;
	},
	water() {
		return -1;
	},
};

export class Lab {
	readonly scene: THREE.Scene;
	readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
	readonly batches = new Batches();
	open = false;
	creature: Creature | null = null;
	subject: { code: string } | null = null;
	stats: Stats | null = null;
	private yaw = 0.6;
	private pitch = 0.22;
	private dist = 3;
	private distGoal = 3;
	private autoSpin = true;
	private idleT = 0;
	private target = new THREE.Vector3();
	pedestal: THREE.Mesh;
	private pedestalR = 1;
	private root: HTMLElement;
	private svg: SVGSVGElement;
	uAO: { value: THREE.Vector2 };
	key: THREE.DirectionalLight;
	private lookPoint = new THREE.Vector3();
	private lookT = 0;
	private thumbs = new Map<string, string>();

	constructor(readonly game: Game) {
		const st = makeStudio();
		this.scene = st.scene;
		this.pedestal = st.pedestal;
		this.key = st.key;
		this.uAO = st.uAO;
		this.scene.add(this.batches.root);

		// overlay
		this.root = document.createElement('div');
		this.root.id = 'lab';
		this.root.className = 'layer';
		this.root.innerHTML = `
			<svg id="lab-svg" class="layer"></svg>
			<div id="lab-left" class="sticker"></div>
			<div id="lab-right" class="sticker"></div>
			<div id="lab-scale" class="sticker"></div>
			<div id="lab-bar"><button class="btn" data-act="close">${document.body.classList.contains('mode-play') ? '섬으로 돌아가기' : '초원으로 돌아가기'} <kbd>Esc</kbd></button></div>`;
		document.body.appendChild(this.root);
		this.svg = this.root.querySelector('#lab-svg') as SVGSVGElement;
		this.root.addEventListener('click', (e) => {
			const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
			if (act) {
				e.stopPropagation();
				this.action(act);
			}
		});
	}

	// ------------------------------------------------------------------ open / close

	async show(code: string) {
		const g = this.game;
		const plan = planFromCode(code);
		const known = g.herd.entries.find((e) => e.c.plan.code === code)?.c.plan.name;
		if (known) plan.name = known;
		const dexName = g.dex.entries.find((d) => d.code === code)?.name;
		if (dexName) plan.name = dexName;
		const geo = await g.pool.geometry(code);
		if (this.creature?.mesh) this.scene.remove(this.creature.mesh);
		const c = new Creature(plan, PEDESTAL_WORLD, 0, 0, 0.5);
		c.setMesh(geo, g.bodyMat);
		this.scene.add(c.mesh!);
		this.creature = c;
		this.subject = { code };
		this.stats = measureStats(plan, geo);
		this.pedestalR = Math.max(0.55, Math.max(plan.footprint[0], plan.footprint[1]) * 1.45 + 0.25);
		this.pedestal.scale.set(this.pedestalR, 1, this.pedestalR);
		this.uAO.value.set(Math.max(plan.footprint[0], plan.footprint[1]) * 1.25, 0.45);
		const r = Math.max(this.stats.height, this.stats.length * 0.8, this.stats.legSpan * 0.8, 0.4);
		this.dist = this.distGoal = r * 4.2 + 0.8;
		this.target.set(0, this.stats.height * 0.45, 0);
		this.key.position.set(r * 3, r * 6, r * 4);
		const sc = this.key.shadow.camera;
		sc.left = sc.bottom = -r * 2.5;
		sc.right = sc.top = r * 2.5;
		sc.near = 0.1;
		sc.far = r * 20;
		sc.updateProjectionMatrix();
		for (let i = 0; i < 30; i++) c.update(1 / 60);
		this.batches.begin();
		c.draw(this.batches);
		this.batches.end();
		this.open = true;
		document.body.classList.add('lab-open');
		this.game.path.setScene(this.scene);
		this.game.path.setCamera(this.camera);
		this.renderPanels();
		this.renderScale();
		void this.fillThumbs();
		this.game.mixer.play('confirm', { bus: 'ui' });
		this.game.events.push({ t: this.game.time.elapsed, type: 'lab-open', code });
	}

	close() {
		if (!this.open) return;
		this.open = false;
		document.body.classList.remove('lab-open');
		this.game.path.setScene(this.game.scene);
		this.game.path.setCamera(this.game.camera);
		this.svg.innerHTML = '';
	}

	// ------------------------------------------------------------------ frame

	update(dt: number) {
		const c = this.creature;
		if (!this.open || !c) return;
		// idle life: look at the camera, glance around, sniff now and then, wag
		this.idleT += dt;
		this.lookT -= dt;
		if (this.lookT <= 0) {
			this.lookT = 1.5 + Math.random() * 2.5;
			const r = Math.random();
			if (r < 0.55) this.lookPoint.copy(this.camera.position);
			else this.lookPoint.set((Math.random() - 0.5) * 4, Math.random() * 1.5, (Math.random() - 0.3) * 4);
			c.sniff = Math.random() < 0.15 ? 1 : 0;
		}
		c.lookTarget = this.lookPoint;
		c.intentSpeed = 0;
		c.faceTarget = null;
		c.wag = Math.max(c.wag, 0.3);
		c.update(dt);
		if (this.autoSpin) this.yaw += dt * 0.18;
		this.dist += (this.distGoal - this.dist) * (1 - Math.exp(-8 * dt));
		const cp = Math.cos(this.pitch);
		this.camera.position.set(this.target.x + Math.sin(this.yaw) * cp * this.dist, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(this.yaw) * cp * this.dist);
		this.camera.lookAt(this.target);
		const w = this.game.canvas.clientWidth || innerWidth,
			h = this.game.canvas.clientHeight || innerHeight;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.camera.updateMatrixWorld();
		Creature.view.copy(this.camera.position);
		this.batches.begin();
		c.draw(this.batches);
		this.batches.end();
		this.drawPlate();
	}

	orbit(dx: number, dy: number) {
		this.autoSpin = false;
		this.yaw -= dx * 0.006;
		this.pitch = Math.max(-0.05, Math.min(1.2, this.pitch + dy * 0.005));
		clearTimeout(this.spinTimer);
		this.spinTimer = window.setTimeout(() => (this.autoSpin = true), 4000);
	}
	private spinTimer = 0;
	zoom(d: number) {
		const r = Math.max(this.stats?.height ?? 1, 0.4);
		this.distGoal = Math.max(r * 1.4, Math.min(r * 8 + 2, this.distGoal * Math.exp(d)));
	}

	/** Click on the creature: it reacts (squash, voice, a happy wiggle); elsewhere it looks where you clicked. */
	click(x: number, y: number) {
		const c = this.creature;
		if (!c) return;
		const r = this.game.canvas.getBoundingClientRect();
		const rc = new THREE.Raycaster();
		rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
		const hit = rc.ray.intersectSphere(new THREE.Sphere(c.bodyPos, Math.max(0.25, c.plan.R * 1.5)), new THREE.Vector3()) || rc.ray.intersectSphere(new THREE.Sphere(c.headPos, Math.max(0.2, c.plan.R)), new THREE.Vector3());
		if (hit) {
			(c as unknown as { squash: { v: number } }).squash.v -= 4;
			c.blink = 1;
			c.mood = 'happy';
			c.wag = 1;
			this.game.voice(c, 0.8);
			this.game.fx.sparkle(c.headPos, c.plan.size * 0.5, '#ffffff');
			this.lookPoint.copy(this.camera.position);
			this.lookT = 2;
			setTimeout(() => {
				if (this.creature === c) c.mood = 'calm';
			}, 1500);
		} else {
			rc.ray.at(this.dist, this.lookPoint);
			this.lookT = 1.5;
		}
	}

	// ------------------------------------------------------------------ the naturalist's plate (SVG overlay)

	private project(p: THREE.Vector3) {
		const v = p.clone().project(this.camera);
		const r = this.game.canvas.getBoundingClientRect();
		return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height] as const;
	}

	private drawPlate() {
		const c = this.creature,
			S = this.stats;
		if (!c || !S) return;
		const P = c.plan;
		const m = (v: number) => (v >= 1 ? `${v.toFixed(2)}m` : `${Math.round(v * 100)}cm`);
		// put the measuring lines on the side facing the camera
		const toCam = new THREE.Vector3().subVectors(this.camera.position, c.bodyPos).setY(0).normalize();
		const right = new THREE.Vector3(toCam.z, 0, -toCam.x);
		const side = right.clone().multiplyScalar(this.pedestalR * 0.98);
		const parts: string[] = [];
		const dim = (a: THREE.Vector3, b: THREE.Vector3, label: string, offset: number) => {
			const [x1, y1] = this.project(a),
				[x2, y2] = this.project(b);
			const dx = x2 - x1,
				dy = y2 - y1;
			const l = Math.hypot(dx, dy) || 1;
			const nx = (-dy / l) * 7,
				ny = (dx / l) * 7;
			const mx = (x1 + x2) / 2,
				my = (y1 + y2) / 2;
			parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dim"/><line x1="${x1 - nx}" y1="${y1 - ny}" x2="${x1 + nx}" y2="${y1 + ny}" class="dim"/><line x1="${x2 - nx}" y1="${y2 - ny}" x2="${x2 + nx}" y2="${y2 + ny}" class="dim"/>`);
			parts.push(`<g transform="translate(${mx + (nx / 7) * offset},${my + (ny / 7) * offset})"><rect x="-46" y="-11" width="92" height="22" rx="7" class="tag"/><text text-anchor="middle" y="5">${esc(label)}</text></g>`);
		};
		// height: a vertical rule beside the creature
		const base = new THREE.Vector3(side.x, 0, side.z);
		dim(base, base.clone().setY(S.height), `키 ${m(S.height)}`, 58);
		// length along the creature's body axis, on the floor in front of the pedestal
		const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
		const front = toCam.clone().multiplyScalar(this.pedestalR * 1.02);
		dim(front.clone().addScaledVector(fwd, -S.length / 2), front.clone().addScaledVector(fwd, S.length / 2), `길이 ${m(S.length)}`, 22);
		// leg span across the front feet
		if (c.legs.length >= 2) {
			const pl = c.legs[0].end,
				pr = c.legs[1].end;
			if (pl.distanceTo(pr) > 0.02) dim(pl.clone().setY(0.005), pr.clone().setY(0.005), `다리 폭 ${m(S.legSpan)}`, -24);
		}
		// callouts
		const call = (p: THREE.Vector3, text: string, dx: number, dy: number) => {
			const [x, y] = this.project(p);
			parts.push(`<circle cx="${x}" cy="${y}" r="3.5" class="dot"/><line x1="${x}" y1="${y}" x2="${x + dx}" y2="${y + dy}" class="lead"/><g transform="translate(${x + dx},${y + dy})"><rect x="${dx > 0 ? 0 : -116}" y="-12" width="116" height="24" rx="8" class="tag"/><text x="${dx > 0 ? 58 : -58}" y="5" text-anchor="middle">${esc(text)}</text></g>`);
		};
		call(c.headPos.clone().add(new THREE.Vector3(0, P.R * 0.6, 0)), `눈 ${P.eyes.length}개`, 130, -80);
		if (c.legs.length) call(c.legs[c.legs.length - 1].knee, `${P.legs[0].style === 'insect' ? '곤충 다리' : P.legs[0].style === 'digi' ? '탄성 다리' : '다리'} ${P.legs.length}개`, -120, 40);
		else call(c.bodyPos, P.kind === 'blob' ? '다리 없음: 깡충깡충' : '외다리: 포고', -120, 40);
		const tail = P.chains.find((ch) => ch.kind === 'tail');
		const tipP = c.chainTip('tail');
		if (tail && tipP) call(tipP, `${tail.tip === 'none' ? '' : `${{ fluff: '폭신한', ball: '몽둥이', spade: '삽' }[tail.tip] ?? tail.tip} `}꼬리`, -130, -60);
		this.svg.innerHTML = parts.join('');
	}

	// ------------------------------------------------------------------ panels

	private bar(label: string, v: number, text: string, color = 'var(--teal)') {
		const w = Math.round(Math.max(0.04, Math.min(1, v)) * 100);
		return `<div class="statrow"><span>${esc(label)}</span><i><b style="width:${w}%;background:${color}"></b></i><em>${esc(text)}</em></div>`;
	}

	renderPanels() {
		const c = this.creature,
			S = this.stats;
		if (!c || !S) return;
		const P = c.plan;
		const g = this.game;
		const o = g.origins.get(P.code) ?? {};
		const d = g.dex.entries.find((x) => x.code === P.code);
		const from = o.from ?? d?.from ?? null;
		const parentCodes = o.parentCodes ?? d?.parentCodes ?? [];
		const parentNames = o.parents ?? d?.parents ?? [];
		const pal = P.palette;
		const sw = [pal.body, pal.belly, pal.accent, pal.pattern].map((x) => `<i style="background:${linearToHex(x)}"></i>`).join('');
		const left = this.root.querySelector('#lab-left') as HTMLElement;
		left.innerHTML = `
			<div class="lab-title"><input id="lab-name" value="${esc(P.name)}" maxlength="18" spellcheck="false" title="클릭해서 이름 바꾸기"/><div class="swatches">${sw}</div></div>
			<div class="species">${esc(P.species)}</div>
			<div class="chips">${P.traits.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
			${o.changes?.length || d?.changes?.length ? `<div class="changes">돌연변이: ${esc((o.changes ?? d?.changes ?? []).join(', '))}</div>` : ''}
			<h3>능력치</h3>
			${this.bar('속도', Math.log(1 + S.speed) / Math.log(6), `${S.speed.toFixed(2)} m/s`)}
			${this.bar('민첩', S.agility / 360, `${Math.round(S.agility)}°/s`)}
			${this.bar(P.gait.hop ? '점프' : '등반', Math.min(1, S.jump / 1.2), `${(S.jump * 100).toFixed(0)} cm`)}
			${this.bar('스태미나', S.stamina, `${Math.round(S.stamina * 100)}%`)}
			${this.bar('크기', Math.min(1, Math.log(1 + S.mass) / Math.log(1 + 900)), `${S.mass < 1 ? `${Math.round(S.mass * 1000)} g` : `${S.mass.toFixed(S.mass < 10 ? 1 : 0)} kg`}`)}
			<h3>능력</h3>
			<div class="abil">${abilityPanel(P)}</div>
			<h3>성격</h3>
			${this.bar('데굴눈', P.personality.googly, '', 'var(--yellow)')}
			${this.bar('통통 튐', (P.personality.bounce - 0.5), '', 'var(--yellow)')}
			${this.bar('수줍음', P.personality.shy, '', 'var(--lilac)')}
			${this.bar('사교성', P.personality.social, '', 'var(--pink)')}
			${this.bar('호기심', P.personality.curious, '', 'var(--blue)')}
			<div class="lab-actions">
				<button class="btn" data-act="mutate">돌연변이</button><button class="btn" data-act="wild">야생 돌연변이</button>
				<button class="btn" data-act="breed">교배</button><button class="btn" data-act="copy">코드 복사</button>
				<button class="btn" data-act="edit">에디터에서 수정 <kbd>E</kbd></button>
				<button class="btn primary" data-act="playas">이걸로 플레이</button>
				<button class="btn" data-act="photo">사진</button>
			</div>
			<div class="code" title="${P.code}">${P.code}</div>`;
		const nameIn = left.querySelector('#lab-name') as HTMLInputElement;
		nameIn.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') nameIn.blur();
		});
		nameIn.addEventListener('change', () => this.rename(nameIn.value));
		// gene cards and family tree
		const right = this.root.querySelector('#lab-right') as HTMLElement;
		const who = (k: string | undefined) => {
			if (!from || !k) return { t: o.seed || d?.seed ? '씨앗' : '야생', cls: 'seed' };
			if (k === 'A') return { t: parentNames[0] ?? '부모', cls: 'a' };
			if (k === 'B') return { t: parentNames[1] ?? '부모', cls: 'b' };
			if (k === 'mix') return { t: '양쪽', cls: 'mix' };
			return { t: '새로움', cls: 'new' };
		};
		const desc = (name: string) => traitText(P, name);
		const cards = GROUP_NAMES.map(([name]) => {
			const w = who(from?.[name]);
			return `<div class="gene"><div class="gn">${name}</div><div class="gv">${esc(desc(name))}</div><span class="badge ${w.cls}">${esc(w.t)}</span></div>`;
		}).join('');
		const thumb = (code: string | undefined, label: string) => (code ? `<div class="fam" data-code="${code}"><img alt="" data-thumb="${code}" src="${this.thumbs.get(code) ?? g.dex.entries.find((x) => x.code === code)?.thumb ?? ''}"/><span>${esc(label)}</span></div>` : `<div class="fam none"><div class="ph"></div><span>${esc(label)}</span></div>`);
		const grand = (pc: string | undefined) => {
			if (!pc) return [undefined, undefined];
			const po = g.origins.get(pc) ?? g.dex.entries.find((x) => x.code === pc);
			return [po?.parentCodes?.[0], po?.parentCodes?.[1]];
		};
		const [p0, p1] = [parentCodes[0], parentCodes[1]];
		const gp = [...grand(p0), ...grand(p1)];
		const nameOf = (code?: string) => (code ? (g.dex.entries.find((x) => x.code === code)?.name ?? g.herd.entries.find((e) => e.c.plan.code === code)?.c.plan.name ?? planFromCode(code).name) : '');
		right.innerHTML = `
			<h3>유전자 <span class="sub">각 특징의 출처</span></h3>
			<div class="genes">${cards}</div>
			<h3>가계도</h3>
			<div class="tree">
				${gp.some(Boolean) ? `<div class="gen">${gp.filter((x, i) => x || gp[i ^ 1]).map((x) => thumb(x, x ? nameOf(x) : '야생 출생')).join('')}</div>` : ''}
				${parentCodes.length ? `<div class="gen">${thumb(p0, nameOf(p0))}${parentCodes.length > 1 ? thumb(p1, nameOf(p1)) : ''}</div>` : `<div class="wildborn">야생 출생${o.seed || d?.seed ? ` — 씨앗 <b>${esc(String(o.seed ?? d?.seed))}</b>` : ''}: 아직 부모가 없어요. 교배하거나 돌연변이시켜 가계를 시작하세요.</div>`}
				<div class="gen">${thumb(P.code, P.name)}</div>
			</div>`;
		right.querySelectorAll<HTMLElement>('.fam[data-code]').forEach((el) => {
			el.addEventListener('click', () => {
				const code = el.dataset.code!;
				if (code !== this.subject?.code) void this.show(code);
			});
		});
	}

	/** Thumbnails for the family tree: Dex portraits, or a studio render of the plan. */
	private async fillThumbs() {
		const imgs = Array.from(this.root.querySelectorAll<HTMLImageElement>('img[data-thumb]'));
		for (const img of imgs) {
			const code = img.dataset.thumb!;
			if (img.getAttribute('src')) continue;
			const url = await this.portrait(code);
			this.thumbs.set(code, url);
			this.root.querySelectorAll<HTMLImageElement>(`img[data-thumb="${code}"]`).forEach((i) => (i.src = url));
		}
	}

	/** Render any creature (by code) on the pedestal into a 128 px portrait. */
	async portrait(code: string): Promise<string> {
		const g = this.game;
		const plan = planFromCode(code);
		const geo = await g.pool.geometry(code);
		const tmp = new Creature(plan, PEDESTAL_WORLD, 0, 0, 0.6);
		tmp.setMesh(geo, g.bodyMat);
		for (let i = 0; i < 20; i++) tmp.update(1 / 60);
		const B = new Batches();
		B.begin();
		tmp.draw(B);
		B.end();
		const sc = new THREE.Scene();
		sc.add(...this.scene.children.filter((o) => o !== this.creature?.mesh && o !== this.batches.root).map((o) => o));
		sc.add(tmp.mesh!, B.root);
		const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
		const r = Math.max(plan.top, plan.footprint[1] * 1.4, 0.35);
		cam.position.set(Math.sin(0.7) * r * 3.2, r * 1.4, Math.cos(0.7) * r * 3.2);
		cam.lookAt(0, plan.top * 0.45, 0);
		cam.updateMatrixWorld();
		const R = g.path.renderer as THREE.WebGLRenderer;
		const rt = new THREE.WebGLRenderTarget(256, 256);
		rt.texture.colorSpace = THREE.SRGBColorSpace;
		R.setRenderTarget(rt);
		R.clear(true, true, true);
		R.render(sc, cam);
		const px = new Uint8Array(256 * 256 * 4);
		R.readRenderTargetPixels(rt, 0, 0, 256, 256, px);
		R.setRenderTarget(null);
		rt.dispose();
		// give the studio objects back to the lab scene
		for (const o of [...sc.children]) if (o !== tmp.mesh && o !== B.root) this.scene.add(o);
		const cv = document.createElement('canvas');
		cv.width = cv.height = 256;
		const ctx = cv.getContext('2d')!;
		const img = ctx.createImageData(256, 256);
		for (let y = 0; y < 256; y++) img.data.set(px.subarray((255 - y) * 1024, (256 - y) * 1024), y * 1024);
		ctx.putImageData(img, 0, 0);
		const half = document.createElement('canvas');
		half.width = half.height = 128;
		half.getContext('2d')!.drawImage(cv, 0, 0, 128, 128);
		return half.toDataURL('image/jpeg', 0.85);
	}

	/** A to-scale side silhouette next to a 1.7 m person (rendered once, black on paper). */
	private renderScale() {
		const c = this.creature,
			S = this.stats;
		if (!c || !S) return;
		const g = this.game;
		const R = g.path.renderer as THREE.WebGLRenderer;
		const W = 220,
			H = 160;
		const human = 1.7;
		const tall = Math.max(human, S.height) * 1.12;
		const widthM = (tall * W) / H;
		// the creature sits right of centre, the person stands at the left edge
		const cam = new THREE.OrthographicCamera(-widthM * 0.62, widthM * 0.38, tall, 0, 0.1, 100);
		const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
		const sideDir = new THREE.Vector3(fwd.z, 0, -fwd.x);
		cam.position.copy(sideDir.clone().multiplyScalar(30));
		cam.lookAt(0, 0, 0);
		cam.position.y = 0;
		cam.updateMatrixWorld();
		const shift = 0;
		const black = new THREE.MeshBasicMaterial({ color: 0x23263a, fog: false });
		const sc = new THREE.Scene();
		sc.overrideMaterial = black;
		sc.add(c.mesh!, this.batches.root);
		const rt = new THREE.WebGLRenderTarget(W * 2, H * 2);
		R.setRenderTarget(rt);
		R.setClearColor(0xffffff, 0);
		R.clear(true, true, true);
		R.render(sc, cam);
		const px = new Uint8Array(W * 2 * H * 2 * 4);
		R.readRenderTargetPixels(rt, 0, 0, W * 2, H * 2, px);
		R.setRenderTarget(null);
		rt.dispose();
		this.scene.add(c.mesh!, this.batches.root);
		black.dispose();
		const cv = document.createElement('canvas');
		cv.width = W * 2;
		cv.height = H * 2;
		const ctx = cv.getContext('2d')!;
		const img = ctx.createImageData(W * 2, H * 2);
		for (let y = 0; y < H * 2; y++) img.data.set(px.subarray((H * 2 - 1 - y) * W * 8, (H * 2 - y) * W * 8), y * W * 8);
		ctx.putImageData(img, 0, 0);
		const pxPerM = H / tall;
		const hx = 16 + 0.3 * pxPerM + shift;
		const box = this.root.querySelector('#lab-scale') as HTMLElement;
		const fig = (x: number, h: number) => {
			// a simple standing person, 1.7 m
			const s = h / 1.7;
			return `<g transform="translate(${x},${H}) scale(${s * pxPerM})" fill="#b9ad97"><circle cx="0" cy="-1.58" r="0.12"/><rect x="-0.17" y="-1.44" width="0.34" height="0.62" rx="0.12"/><rect x="-0.15" y="-0.86" width="0.12" height="0.86" rx="0.05"/><rect x="0.03" y="-0.86" width="0.12" height="0.86" rx="0.05"/><rect x="-0.27" y="-1.4" width="0.09" height="0.55" rx="0.04"/><rect x="0.18" y="-1.4" width="0.09" height="0.55" rx="0.04"/></g>`;
		};
		box.innerHTML = `<h3>크기 비교</h3><div class="scalebox" style="width:${W}px;height:${H}px"><img alt="" src="${cv.toDataURL()}" style="width:${W}px;height:${H}px"/><svg width="${W}" height="${H}">${fig(Math.max(14, hx), human)}<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="#23263a" stroke-width="1"/></svg></div><div class="scalecap">${esc(c.plan.name)}와 1.7m 사람</div>`;
	}

	// ------------------------------------------------------------------ actions

	private rename(name: string) {
		const c = this.creature;
		if (!c) return;
		const live = this.game.herd.entries.find((e) => e.c.plan.code === c.plan.code)?.c;
		if (live) this.game.rename(live, name);
		else {
			const d = this.game.dex.entries.find((x) => x.code === c.plan.code);
			if (d) {
				d.name = name.trim().slice(0, 18);
				this.game.dex.save();
			}
		}
		c.plan.name = name.trim().slice(0, 18) || c.plan.name;
		this.renderPanels();
		this.renderScale();
		this.game.mixer.play('select', { bus: 'ui' });
	}

	private liveOrHatch(): Creature | null {
		const c = this.creature;
		if (!c) return null;
		let live = this.game.herd.entries.find((e) => e.c.plan.code === c.plan.code && e.egg === 0)?.c ?? null;
		if (!live) {
			// the specimen isn't out in the meadow (a Dex or family-tree creature): hatch it there first
			const p = this.game.spawnPoint();
			live = this.game.herd.spawn(planFromCode(c.plan.code), p.x, p.z, { instant: true }).c;
		}
		return live;
	}

	async action(act: string) {
		const c = this.creature;
		const g = this.game;
		if (act === 'close') return this.close();
		if (!c) return;
		if (act === 'mutate' || act === 'wild') {
			const live = this.liveOrHatch();
			if (!live) return;
			g.select(live);
			(c as unknown as { squash: { v: number } }).squash.v -= 3;
			const e = await g.mutateSelected(act === 'wild' ? 'wild' : 'subtle');
			if (e) await this.show(e.c.plan.code);
		} else if (act === 'breed') {
			const live = this.liveOrHatch();
			this.close();
			if (live) {
				g.select(live);
				g.startBreed();
			}
		} else if (act === 'copy') {
			navigator.clipboard?.writeText(c.plan.code).then(
				() => g.ui.toast('코드를 복사했어요: 씨앗 상자에 붙여 넣으면 이 크리터를 다시 부화할 수 있어요'),
				() => g.ui.toast('코드 텍스트를 선택해 복사하세요'),
			);
		} else if (act === 'edit') {
			void g.openEditor(c);
		} else if (act === 'playas') {
			g.playAs(c.plan.code);
		} else if (act === 'photo') {
			g.snapPhoto();
		}
	}
}

/** One line per gene group for the gene cards. */
export function traitText(P: Plan, group: string): string {
	const G = P.genes;
	const word = { blob: '블롭', mono: '포고', biped: '이족보행', quad: '사족보행', hexa: '육족보행', octo: '팔족보행' }[P.kind];
	switch (group) {
		case '크기':
			return P.size < 0.48 ? '아주 작음' : P.size < 0.8 ? '작음' : P.size < 1.35 ? '보통' : P.size < 1.9 ? '큼' : '거대';
		case '몸':
			return `${word}, 마디 ${P.segBones.length}개, ${G.fat > 0.6 ? '통통' : G.fat < 0.35 ? '날씬' : '둥글'}`;
		case '다리':
			return P.legs.length ? `${P.legs[0].style === 'insect' ? '곤충' : P.legs[0].style === 'digi' ? '탄성' : '곧은'} ${P.legs.length}개, ${G.legLen > 0.6 ? '김' : G.legLen < 0.3 ? '짧음' : '보통'}` : '없음';
		case '팔':
			return P.arms.length ? (P.traits.includes('아주 작은 팔') ? '아주 작은 팔' : '두 팔') : '없음';
		case '머리':
			return `${['둥근', '넓은', '높은', '긴'][Math.floor(G.headShape * 4)]}${G.snout > 0.45 ? ', 주둥이' : ''}${G.neck > 0.6 ? ', 긴 목' : ''}`;
		case '눈':
			return `${P.eyes.length}개${P.eyes.some((e) => e.stalk >= 0) ? ' (줄기 위)' : ''}, ${G.eyeSize > 0.6 ? '큼' : G.eyeSize < 0.3 ? '작음' : '보통'}`;
		case '뿔':
			return P.traits.find((t) => t === '뿔' || t === '외뿔' || t === '왕관 뿔') ?? '없음';
		case '귀':
			return P.traits.find((t) => t.endsWith(' 귀') || t === '지느러미') ?? '없음';
		case '가시':
			return P.traits.includes('가시투성이') ? '등 가시' : '없음';
		case '입':
			return P.traits.find((t) => ['부리', '엄니', '토끼 이빨'].includes(t)) ?? (Math.floor(G.mouth * 5) === 1 ? '벌어진 입' : '미소');
		case '꼬리': {
			const t = P.chains.find((c) => c.kind === 'tail');
			return t ? `${{ none: '평범한', fluff: '폭신한', ball: '몽둥이', spade: '삽', eye: '눈알' }[t.tip] ?? t.tip}, ${t.length > P.R * 2.4 ? '김' : '짧음'}` : '없음';
		}
		case '더듬이':
			return P.traits.includes('더듬이') ? '더듬이 두 개' : '없음';
		case '색':
			return P.species.split(' ').slice(-2, -1)[0] ?? '';
		case '무늬':
			return P.pattern.kind === 'none' ? '무늬 없음' : ({ spots: '점박이', stripes: '줄무늬', patches: '얼룩', gradient: '그라데이션' })[P.pattern.kind] ?? P.pattern.kind;
		case '성격': {
			const p = P.personality;
			const top = [
				['데굴눈', p.googly],
				['통통 튐', (p.bounce - 0.5) / 1],
				['수줍음', p.shy],
				['사교성', p.social],
				['호기심', p.curious],
			].sort((a, b) => (b[1] as number) - (a[1] as number));
			return `${top[0][0]}, ${top[1][0]}`;
		}
	}
	return '';
}
