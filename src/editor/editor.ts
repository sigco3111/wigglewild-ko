// The Editor: build a creature by hand on a studio pedestal.
//   - drag parts from the palette onto the body (they snap to the skin, mirrored by default), grab a part to slide
//     it over the surface, scroll to resize it, Shift-drag to tilt it, Delete to remove it;
//   - drag the spine handles to bend and stretch the body, + / - for segments;
//   - paint from curated palettes; undo and redo; start from blank, a random seed, any creature, or a mutation;
//   - Test drive: the creature walks, runs, jumps, eats and dances with the same procedural animation as the meadow;
//   - live stats (speed, bite, charm, glide...) from the real body and a sim run;
//   - every build is validated: the compiler keeps parts attached, and a build that would mesh into more than one
//     piece is rolled back.
import * as THREE from 'three';
import type { Game } from '../game';
import { Batches } from '../creature/batches';
import type { Plan } from '../creature/build';
import { designFromPlan } from '../creature/codes';
import { linearToHex } from '../creature/color';
import { Creature, type WorldQuery } from '../creature/creature';
import { accentColor, baseColor, blankDesign, type CompileInfo, compileDesign, decodeDesign, type Design, type DPart, encodeDesign, mutateDesign, normalise, type PartType, patternColor, randomDesign } from '../creature/design';
import { hashSeed } from '../creature/genome';
import { abilityStats, measureStats } from '../creature/stats';
import { abilityPanel } from '../play/abilities';
import { makeStudio } from '../lab/lab';

const FLAT: WorldQuery = {
	ground(_x: number, _z: number, n?: THREE.Vector3) {
		n?.set(0, 1, 0);
		return 0;
	},
	water() {
		return -1;
	},
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface PaletteItem {
	id: string;
	t: PartType;
	v: string;
	label: string;
	icon: string;
	mirror: boolean;
}

// small inline icons (no emoji)
const I = (body: string) => `<svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="#23263a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const PALETTE: PaletteItem[] = [
	{ id: 'leg2', t: 'leg', v: 'straight', label: '다리', icon: I('<path d="M12 4v12l-3 12M22 4v12l3 12"/><ellipse cx="8" cy="29" rx="4" ry="2" fill="#ffd23f"/><ellipse cx="26" cy="29" rx="4" ry="2" fill="#ffd23f"/>'), mirror: true },
	{ id: 'leg3', t: 'leg', v: 'digi', label: '탄성 다리', icon: I('<path d="M11 4l4 9-6 7 3 8M23 4l-4 9 6 7-3 8"/>'), mirror: true },
	{ id: 'legs', t: 'leg', v: 'insect', label: '곤충 다리', icon: I('<path d="M17 14 7 6 3 26M17 14l10-8 4 20"/>'), mirror: true },
	{ id: 'arm', t: 'arm', v: '', label: '팔', icon: I('<path d="M6 8c3 6 6 9 12 10M28 8c-3 6-6 9-12 10"/><circle cx="6" cy="7" r="3" fill="#ffd23f"/><circle cx="28" cy="7" r="3" fill="#ffd23f"/>'), mirror: true },
	{ id: 'eye', t: 'eye', v: '', label: '눈', icon: I('<circle cx="11" cy="17" r="7" fill="#fff"/><circle cx="23" cy="17" r="7" fill="#fff"/><circle cx="12" cy="18" r="3" fill="#23263a"/><circle cx="24" cy="18" r="3" fill="#23263a"/>'), mirror: true },
	{ id: 'stalk', t: 'stalk', v: '', label: '눈 줄기', icon: I('<path d="M12 30V12M22 30V12"/><circle cx="12" cy="9" r="5" fill="#fff"/><circle cx="22" cy="9" r="5" fill="#fff"/>'), mirror: true },
	{ id: 'herb', t: 'mouth', v: 'herb', label: '초식', icon: I('<path d="M6 14c6 8 16 8 22 0"/><rect x="13" y="16" width="4" height="5" fill="#fff"/><rect x="17" y="16" width="4" height="5" fill="#fff"/>'), mirror: false },
	{ id: 'carn', t: 'mouth', v: 'carn', label: '육식', icon: I('<path d="M6 14c6 8 16 8 22 0"/><path d="M11 17l2 6 2-5M19 18l2 5 2-6" fill="#fff"/>'), mirror: false },
	{ id: 'omni', t: 'mouth', v: 'omni', label: '잡식', icon: I('<ellipse cx="17" cy="17" rx="8" ry="6" fill="#7a2638"/><ellipse cx="17" cy="20" rx="4" ry="2" fill="#ff8fab" stroke="none"/>'), mirror: false },
	{ id: 'tail', t: 'tail', v: 'plain', label: '꼬리', icon: I('<path d="M4 22c10 2 14-12 26-10"/>'), mirror: false },
	{ id: 'tailf', t: 'tail', v: 'fluff', label: '폭신한 꼬리', icon: I('<path d="M4 24c8 0 12-8 18-10"/><circle cx="26" cy="12" r="6" fill="#fff"/>'), mirror: false },
	{ id: 'tailc', t: 'tail', v: 'ball', label: '몽둥이 꼬리', icon: I('<path d="M4 24c8 0 12-8 18-10"/><circle cx="26" cy="12" r="5" fill="#ffd23f"/>'), mirror: false },
	{ id: 'horn', t: 'horn', v: 'straight', label: '뿔', icon: I('<path d="M10 28 13 6l4 22M20 28l4-22 3 22" fill="#fffaf0"/>'), mirror: true },
	{ id: 'curl', t: 'horn', v: 'curl', label: '곱슬 뿔', icon: I('<path d="M8 28c0-12 14-18 18-10s-6 8-6 2"/>'), mirror: true },
	{ id: 'frill', t: 'frill', v: '', label: '주름 장식', icon: I('<path d="M17 28 5 10M17 28l-5-20M17 28V6M17 28l5-20M17 28l12-18"/>'), mirror: false },
	{ id: 'wing', t: 'wing', v: '', label: '날개', icon: I('<path d="M17 20C10 6 4 8 2 12c4 0 8 4 15 8zM17 20c7-14 13-12 15-8-4 0-8 4-15 8z" fill="#b48cff"/>'), mirror: true },
	{ id: 'spike', t: 'spike', v: '', label: '가시', icon: I('<path d="M3 28 9 10l5 18M12 28l5-22 5 22M20 28l5-18 6 18" fill="#ffd23f"/>'), mirror: false },
	{ id: 'paw', t: 'foot', v: 'paw', label: '큰 발', icon: I('<ellipse cx="17" cy="20" rx="12" ry="7" fill="#ffd23f"/>'), mirror: false },
	{ id: 'song', t: 'throat', v: 'song', label: '울음주머니', icon: I('<ellipse cx="17" cy="20" rx="9" ry="8" fill="#9fc3ff"/><path d="M24 6v8M24 6l4 1"/>'), mirror: false },
	{ id: 'spitg', t: 'throat', v: 'spit', label: '침샘', icon: I('<ellipse cx="14" cy="19" rx="8" ry="7" fill="#9be15d"/><circle cx="26" cy="12" r="2.5" fill="#9be15d"/><circle cx="30" cy="8" r="1.5" fill="#9be15d"/>'), mirror: false },
	{ id: 'hand', t: 'hand', v: '', label: '큰 손', icon: I('<circle cx="17" cy="18" r="9" fill="#ffd23f"/><path d="M10 12l-3-4M14 9l-1-5M20 9l1-5"/>'), mirror: false },
];

/** Where each part type lands by default when dropped off the body. */
const DEFAULT_SPOT: Record<string, { seg: 'head' | 'mid' | 'tail'; a: number; b: number }> = {
	leg: { seg: 'mid', a: 1.3, b: -0.9 },
	arm: { seg: 'mid', a: 1.5, b: 0.2 },
	eye: { seg: 'head', a: 0.45, b: 0.35 },
	stalk: { seg: 'head', a: 0.35, b: 1.1 },
	mouth: { seg: 'head', a: 0, b: -0.35 },
	tail: { seg: 'tail', a: Math.PI, b: 0.2 },
	horn: { seg: 'head', a: 0.45, b: 1.0 },
	frill: { seg: 'head', a: 0, b: 0.6 },
	throat: { seg: 'head', a: 0, b: -1.0 },
	wing: { seg: 'mid', a: 1.4, b: 0.7 },
	spike: { seg: 'mid', a: 0, b: 1.3 },
};

export class Editor {
	readonly scene: THREE.Scene;
	readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 200);
	readonly batches = new Batches();
	open = false;
	design: Design = blankDesign();
	plan: Plan | null = null;
	info: CompileInfo = { anchors: [], segs: [], warnings: [] };
	creature: Creature | null = null;
	mirror = true;
	selected = -1;
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private root: HTMLElement;
	private pedestal: THREE.Mesh;
	private uAO: { value: THREE.Vector2 };
	private keyLight: THREE.DirectionalLight;
	private yaw = 0.9;
	private pitch = 0.25;
	private dist = 4;
	private distGoal = 4;
	private target = new THREE.Vector3(0, 0.4, 0);
	private targetGoal = new THREE.Vector3(0, 0.4, 0);
	private handles: THREE.Mesh[] = [];
	private marker: THREE.Mesh;
	private ghost: THREE.Mesh;
	private dragging: { kind: 'palette' | 'part' | 'spine' | 'orbit' | 'tilt'; item?: PaletteItem; index?: number; x: number; y: number; moved: boolean } | null = null;
	private reqId = 0;
	private stats: ReturnType<typeof measureStats> | null = null;
	private abil: ReturnType<typeof abilityStats> | null = null;
	private drive: { t: number; step: string } | null = null;
	private lookUntil = 0;
	private statsTimer = 0;
	private pendingStats = false;
	busy = false;
	builds = 0;

	constructor(readonly game: Game) {
		const st = makeStudio();
		this.scene = st.scene;
		this.pedestal = st.pedestal;
		this.uAO = st.uAO;
		this.keyLight = st.key;
		this.scene.add(this.batches.root);
		const hm = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 });
		for (let i = 0; i < 6; i++) {
			const h = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), hm.clone());
			h.renderOrder = 10;
			h.visible = false;
			h.userData.spine = i;
			this.handles.push(h);
			this.scene.add(h);
		}
		this.marker = new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 32), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true }));
		this.marker.renderOrder = 11;
		this.marker.visible = false;
		this.scene.add(this.marker);
		this.ghost = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false, transparent: true, opacity: 0.7 }));
		this.ghost.renderOrder = 12;
		this.ghost.visible = false;
		this.scene.add(this.ghost);
		this.root = document.createElement('div');
		this.root.id = 'editor';
		this.root.className = 'layer';
		this.root.innerHTML = `
			<div id="ed-top" class="sticker">
				<button class="btn" data-act="undo" title="되돌리기 (Ctrl Z)">되돌리기</button>
				<button class="btn" data-act="redo" title="다시하기 (Ctrl Y)">다시하기</button>
				<button class="btn" data-act="mirror" id="ed-mirror" title="새 부위 대칭 (X)">대칭 켜짐</button>
				<span class="ed-sep"></span>
				<button class="btn" data-act="seg+" title="마디 추가">+ 마디</button>
				<button class="btn" data-act="seg-" title="뒤쪽 마디 제거">− 마디</button>
				<label class="ed-slider">크기<input type="range" id="ed-size" min="0.3" max="2.4" step="0.05"/></label>
				<label class="ed-slider">너비<input type="range" id="ed-fat" min="0.7" max="1.4" step="0.05"/></label>
				<span class="ed-sep"></span>
				<button class="btn" data-act="blank">비우기</button>
				<button class="btn" data-act="random">무작위</button>
				<button class="btn" data-act="mutate">돌연변이</button>
			</div>
			<div id="ed-left" class="sticker"><h3>부위 <span class="sub">몸에 끌어다 놓기</span></h3><div id="ed-palette"></div></div>
			<div id="ed-right" class="sticker"></div>
			<div id="ed-hint" class="sticker">부위를 몸에 끌어다 놓기 · 하얀 점을 끌어 등뼈 모양 바꾸기 · 부위를 클릭하고 스크롤로 크기 조절, Shift-드래그로 기울이기, Delete로 제거</div>
			<div id="ed-drive"></div>`;
		document.body.appendChild(this.root);
		const pal = this.root.querySelector('#ed-palette') as HTMLElement;
		pal.innerHTML = PALETTE.map((p) => `<div class="ed-item" data-pid="${p.id}" title="${esc(p.label)}">${p.icon}<span>${esc(p.label)}</span></div>`).join('');
		pal.querySelectorAll<HTMLElement>('.ed-item').forEach((el) =>
			el.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				const item = PALETTE.find((p) => p.id === el.dataset.pid)!;
				this.dragging = { kind: 'palette', item, x: e.clientX, y: e.clientY, moved: false };
				document.body.classList.add('ed-dragging');
				this.game.mixer.play('select', { bus: 'ui' });
			}),
		);
		this.root.addEventListener('click', (e) => {
			const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
			if (act) {
				e.stopPropagation();
				void this.action(act, e.target as HTMLElement);
			}
		});
		this.root.querySelector('#ed-size')!.addEventListener('change', (e) => this.edit((d) => (d.size = Number((e.target as HTMLInputElement).value))));
		this.root.querySelector('#ed-fat')!.addEventListener('change', (e) => this.edit((d) => (d.fat = Number((e.target as HTMLInputElement).value))));
		// global pointer move/up so drags from the palette work over the canvas
		addEventListener('pointermove', (e) => this.onMove(e));
		addEventListener('pointerup', (e) => this.onUp(e));
	}

	// ------------------------------------------------------------------ open / close

	async show(start?: Design | string) {
		if (typeof start === 'string') this.design = normalise(decodeDesign(start));
		else if (start) this.design = normalise(start);
		this.undoStack = [];
		this.redoStack = [];
		this.selected = -1;
		this.open = true;
		document.body.classList.add('editor-open');
		this.game.path.setScene(this.scene);
		this.game.path.setCamera(this.camera);
		this.scene.add(this.game.fx.root);
		this.renderPanels();
		await this.rebuild(true);
	}

	close() {
		if (!this.open) return;
		this.open = false;
		this.drive = null;
		document.body.classList.remove('editor-open');
		this.game.path.setScene(this.game.scene);
		this.game.path.setCamera(this.game.camera);
		this.game.scene.add(this.game.fx.root);
	}

	// ------------------------------------------------------------------ edits

	/** Apply a change with undo; rolls back if the result would not be one connected body. */
	edit(fn: (d: Design) => void, reaction?: { part?: number; sound?: string }) {
		const before = encodeDesign(this.design);
		const d: Design = JSON.parse(JSON.stringify(this.design));
		fn(d);
		const next = normalise(d);
		if (encodeDesign(next) === before) return;
		this.undoStack.push(before);
		if (this.undoStack.length > 80) this.undoStack.shift();
		this.redoStack = [];
		this.design = next;
		void this.rebuild(false, reaction, before);
	}

	private async rebuild(first = false, reaction?: { part?: number; sound?: string }, rollback?: string) {
		const id = ++this.reqId;
		const info: CompileInfo = { anchors: [], segs: [], warnings: [] };
		const plan = compileDesign(this.design, info);
		this.busy = true;
		const geo = await this.game.pool.geometry(plan.code);
		if (id !== this.reqId) return;
		this.busy = false;
		const comps = (geo.userData.stats as { components?: number } | undefined)?.components ?? 1;
		if (comps > 1 && rollback) {
			// would come apart: refuse, gently
			this.design = decodeDesign(rollback);
			this.undoStack.pop();
			this.toast('거기에는 붙지 않아요. 몸에 더 가까운 곳에 놓아 보세요.');
			this.creature && ((this.creature as unknown as { squash: { v: number } }).squash.v += 2);
			return this.rebuild();
		}
		this.plan = plan;
		this.info = info;
		if (this.creature?.mesh) this.scene.remove(this.creature.mesh);
		const c = new Creature(plan, FLAT, 0, 0, 0);
		c.editorStill = !this.drive;
		c.setMesh(geo, this.game.bodyMat);
		this.scene.add(c.mesh!);
		for (let i = 0; i < 12; i++) c.update(1 / 60);
		this.creature = c;
		this.builds++;
		// pedestal and camera sized to the body
		const r = Math.max(plan.top, plan.footprint[0], plan.footprint[1], 0.35);
		const pedR = Math.max(0.6, Math.max(plan.footprint[0], plan.footprint[1]) * 1.6 + 0.3);
		if (!this.drive) this.pedestal.scale.set(pedR, 1, pedR);
		this.uAO.value.set(Math.max(plan.footprint[0], plan.footprint[1]) * 1.2, 0.4);
		if (first) {
			this.dist = this.distGoal = r * 4.2 + 1;
			this.target.set(0, plan.top * 0.45, 0);
		}
		this.targetGoal.set(0, plan.top * 0.45, 0);
		this.distGoal = Math.max(this.distGoal, r * 3.2 + 0.8);
		this.keyLight.position.set(r * 3, r * 6, r * 4);
		const sc = this.keyLight.shadow.camera;
		sc.left = sc.bottom = -r * 3;
		sc.right = sc.top = r * 3;
		sc.far = r * 30;
		sc.updateProjectionMatrix();
		// reaction: pop with a squash and a sound, look at the new part, wiggle
		if (reaction) {
			(c as unknown as { squash: { v: number } }).squash.v -= 3;
			const a = reaction.part !== undefined ? info.anchors[reaction.part]?.[0] : undefined;
			if (a) {
				c.lookTarget = new THREE.Vector3(...a.p).add(new THREE.Vector3(...a.n).multiplyScalar(0.5));
				this.lookUntil = performance.now() + 1600;
				this.game.fx.sparkle(new THREE.Vector3(...a.p), plan.size * 0.5, '#ffffff');
			}
			c.wag = 1;
			this.game.mixer.play(reaction.sound ?? 'pop', { volume: 0.7, pitch: 1.1 + Math.random() * 0.2 });
		}
		this.pendingStats = true;
		this.statsTimer = 0.25;
		this.renderPanels();
	}

	private updateStats() {
		if (!this.plan || !this.creature?.mesh) return;
		this.stats = measureStats(this.plan, this.creature.mesh.geometry);
		this.abil = abilityStats(this.plan, this.stats);
		this.renderStats();
	}

	// ------------------------------------------------------------------ picking on the body

	private ray(x: number, y: number) {
		const r = this.game.canvas.getBoundingClientRect();
		const rc = new THREE.Raycaster();
		rc.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
		return rc;
	}

	/** Surface hit on the body mesh, mapped back to the design (segment, yaw, pitch). */
	private hitBody(x: number, y: number) {
		const c = this.creature;
		if (!c?.mesh || !this.plan) return null;
		const rc = this.ray(x, y);
		c.mesh.skeleton.update();
		const hits = rc.intersectObject(c.mesh, false);
		if (!hits.length) return null;
		const p = hits[0].point;
		// nearest segment by normalised distance
		let best = 0,
			bd = Infinity;
		this.info.segs.forEach((s, i) => {
			const d = Math.hypot(p.x - s.c[0], p.y - s.c[1], p.z - s.c[2]) / Math.max(...s.r);
			if (d < bd) {
				bd = d;
				best = i;
			}
		});
		const s = this.info.segs[best];
		const dv = new THREE.Vector3(p.x - s.c[0], p.y - s.c[1], p.z - s.c[2]).normalize();
		const f = s.frame;
		const lx = f[0] * dv.x + f[1] * dv.y + f[2] * dv.z,
			ly = f[3] * dv.x + f[4] * dv.y + f[5] * dv.z,
			lz = f[6] * dv.x + f[7] * dv.y + f[8] * dv.z;
		return { seg: best, a: Math.atan2(lx, lz), b: Math.asin(Math.max(-1, Math.min(1, ly))), point: p.clone(), normal: hits[0].face ? hits[0].face.normal.clone() : new THREE.Vector3(0, 1, 0) };
	}

	/** The part whose anchor is under the cursor (within a few pixels). */
	private pickPart(x: number, y: number) {
		let best = -1,
			bd = 26;
		const r = this.game.canvas.getBoundingClientRect();
		this.info.anchors.forEach((list, i) => {
			for (const a of list) {
				const v = new THREE.Vector3(...a.p).project(this.camera);
				const sx = r.left + ((v.x + 1) / 2) * r.width,
					sy = r.top + ((1 - v.y) / 2) * r.height;
				const d = Math.hypot(sx - x, sy - y);
				if (d < bd && v.z < 1) {
					bd = d;
					best = i;
				}
			}
		});
		return best;
	}

	private pickHandle(x: number, y: number) {
		const rc = this.ray(x, y);
		const hits = rc.intersectObjects(this.handles.filter((h) => h.visible), false);
		return hits.length ? (hits[0].object.userData.spine as number) : -1;
	}

	// ------------------------------------------------------------------ input (called by the game)

	pointerDown(x: number, y: number, button: number, shift: boolean) {
		if (this.drive) return;
		const h = this.pickHandle(x, y);
		if (h >= 0) {
			this.dragging = { kind: 'spine', index: h, x, y, moved: false };
			return;
		}
		const p = this.pickPart(x, y);
		if (p >= 0 && button === 0) {
			this.select(p);
			this.dragging = { kind: shift ? 'tilt' : 'part', index: p, x, y, moved: false };
			return;
		}
		this.dragging = { kind: 'orbit', x, y, moved: false };
	}

	private dragUndo: string | null = null;
	private onMove(e: PointerEvent) {
		const d = this.dragging;
		if (!this.open || !d) return;
		const dx = e.clientX - d.x,
			dy = e.clientY - d.y;
		if (Math.hypot(dx, dy) > 3) d.moved = true;
		if (d.kind === 'orbit') {
			if (d.moved) {
				this.yaw -= (e.movementX || 0) * 0.006;
				this.pitch = Math.max(-0.1, Math.min(1.2, this.pitch + (e.movementY || 0) * 0.005));
			}
		} else if (d.kind === 'palette') {
			const hit = this.hitBody(e.clientX, e.clientY);
			this.ghost.visible = !!hit;
			if (hit) {
				this.ghost.position.copy(hit.point);
				this.ghost.scale.setScalar(Math.max(0.03, (this.plan?.R ?? 0.3) * 0.18));
			}
		} else if ((d.kind === 'part' || d.kind === 'tilt') && d.moved && d.index !== undefined) {
			if (!this.dragUndo) this.dragUndo = encodeDesign(this.design);
			if (d.kind === 'tilt') {
				const p = this.design.parts[d.index];
				p.r = Math.max(-1.5, Math.min(1.5, p.r + (e.movementX || 0) * 0.01));
				this.liveRebuild();
			} else {
				const hit = this.hitBody(e.clientX, e.clientY);
				if (hit) {
					const p = this.design.parts[d.index];
					p.s = hit.seg;
					p.a = hit.a;
					p.b = hit.b;
					this.liveRebuild();
				}
			}
		} else if (d.kind === 'spine' && d.index !== undefined && this.plan) {
			if (!this.dragUndo) this.dragUndo = encodeDesign(this.design);
			// move the spine point in the creature's side plane (x = 0)
			const rc = this.ray(e.clientX, e.clientY);
			const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
			const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
			if (hit) {
				const R = this.plan.R;
				const sp = this.design.spine[d.index];
				sp.z = Math.max(-5.5, Math.min(5.5, hit.z / R));
				sp.y = Math.max(-2.5, Math.min(4.5, (hit.y - this.plan.height) / R));
				this.liveRebuild();
			}
		}
		d.x = e.clientX;
		d.y = e.clientY;
	}

	private liveTimer = 0;
	private liveRebuild() {
		// throttle: re-mesh at most every 90 ms while dragging
		const now = performance.now();
		if (now - this.liveTimer < 90) return;
		this.liveTimer = now;
		this.design = normalise(this.design);
		void this.rebuild();
	}

	private onUp(e: PointerEvent) {
		const d = this.dragging;
		this.dragging = null;
		document.body.classList.remove('ed-dragging');
		this.ghost.visible = false;
		if (!this.open || !d) return;
		if (d.kind === 'palette' && d.item) {
			const it = d.item;
			const overCanvas = (e.target as HTMLElement)?.id === 'view';
			const hit = overCanvas ? this.hitBody(e.clientX, e.clientY) : null;
			this.addPart(it, hit);
		} else if ((d.kind === 'part' || d.kind === 'tilt' || d.kind === 'spine') && this.dragUndo) {
			const before = this.dragUndo;
			this.dragUndo = null;
			this.undoStack.push(before);
			this.redoStack = [];
			this.design = normalise(this.design);
			void this.rebuild(false, { part: d.kind === 'spine' ? undefined : d.index, sound: 'popSmall' }, before);
		} else if (d.kind === 'orbit' && !d.moved) {
			// click on empty space or the body: deselect, poke
			this.select(-1);
			const hit = this.hitBody(e.clientX, e.clientY);
			if (hit && this.creature) {
				(this.creature as unknown as { squash: { v: number } }).squash.v -= 3;
				this.game.voice(this.creature, 0.7);
			}
		}
		this.dragUndo = null;
	}

	wheel(dy: number, x: number, y: number) {
		const h = this.pickHandle(x, y);
		if (h >= 0) {
			this.edit((d) => (d.spine[h].r = Math.max(0.3, Math.min(2.1, d.spine[h].r * Math.exp(-dy * 0.0012)))), { sound: 'popSmall' });
			return;
		}
		if (this.selected >= 0) {
			const i = this.selected;
			this.edit((d) => (d.parts[i].k = Math.max(0.35, Math.min(2.9, d.parts[i].k * Math.exp(-dy * 0.0012)))), { part: i, sound: 'popSmall' });
			return;
		}
		this.distGoal = Math.max(0.8, Math.min(20, this.distGoal * Math.exp(dy * 0.0012)));
	}

	onKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
			e.preventDefault();
			void this.action(e.shiftKey ? 'redo' : 'undo');
		} else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
			e.preventDefault();
			void this.action('redo');
		} else if ((e.code === 'Delete' || e.code === 'Backspace') && this.selected >= 0) {
			const i = this.selected;
			this.select(-1);
			this.edit((d) => d.parts.splice(i, 1), { sound: 'thump' });
		} else if (e.code === 'KeyX') void this.action('mirror');
		else if (e.code === 'KeyT') void this.action('drive');
		else if (e.code === 'Escape') {
			if (this.drive) this.drive = null;
			else if (this.selected >= 0) this.select(-1);
			else this.game.closeEditor();
		}
	}

	private select(i: number) {
		this.selected = i;
		this.renderPanels();
	}

	/** Drop a palette part: on the body where it landed, or at its natural spot. */
	addPart(it: PaletteItem, hit: { seg: number; a: number; b: number } | null) {
		const d = this.design;
		const ns = d.spine.length;
		if (it.t === 'foot' || it.t === 'hand') {
			const i = d.parts.findIndex((p) => p.t === it.t);
			this.edit((dd) => {
				if (i >= 0) dd.parts[i].k = Math.min(2.2, dd.parts[i].k * 1.25);
				else dd.parts.push({ t: it.t, s: 0, a: 0, b: 0, k: 1.35, r: 0, m: false, v: it.v });
			}, { sound: 'pop' });
			this.toast(it.t === 'foot' ? '발이 커졌어요!' : '손이 커졌어요!');
			return;
		}
		let spot = hit;
		if (!spot) {
			const def = DEFAULT_SPOT[it.t];
			const seg = def.seg === 'head' ? ns - 1 : def.seg === 'tail' ? 0 : Math.max(0, Math.floor((ns - 1) / 2));
			spot = { seg, a: def.a, b: def.b };
		}
		const mirror = it.mirror && this.mirror;
		const part: DPart = { t: it.t, s: spot.seg, a: spot.a, b: spot.b, k: 1, r: 0, m: mirror, v: it.v };
		// legs want to point down-ish: a leg dropped on the top of the back still hangs from the side
		if (it.t === 'leg' && part.b > -0.3) part.b = -0.5;
		if (mirror && Math.abs(Math.sin(part.a)) < 0.15) part.a = 0.9 * (part.a >= 0 ? 1 : -1);
		const idx = d.parts.length;
		this.edit((dd) => dd.parts.push(part), { part: idx, sound: 'pop' });
		this.selected = idx;
		this.game.events.push({ t: this.game.time.elapsed, type: 'editor-add', part: it.id, onBody: !!hit });
	}

	// ------------------------------------------------------------------ actions

	async action(act: string, el?: HTMLElement) {
		const g = this.game;
		switch (act) {
			case 'undo': {
				const prev = this.undoStack.pop();
				if (!prev) return;
				this.redoStack.push(encodeDesign(this.design));
				this.design = decodeDesign(prev);
				this.selected = -1;
				g.mixer.play('select', { bus: 'ui' });
				return this.rebuild();
			}
			case 'redo': {
				const next = this.redoStack.pop();
				if (!next) return;
				this.undoStack.push(encodeDesign(this.design));
				this.design = decodeDesign(next);
				g.mixer.play('select', { bus: 'ui' });
				return this.rebuild();
			}
			case 'mirror':
				this.mirror = !this.mirror;
				this.renderPanels();
				return;
			case 'seg+':
				return this.edit((d) => {
					if (d.spine.length >= 6) return;
					const b = d.spine[0];
					d.spine.unshift({ z: b.z - b.r * 1.05, y: b.y, r: b.r * 0.92 });
					for (const p of d.parts) p.s++;
				}, { sound: 'pop' });
			case 'seg-':
				return this.edit((d) => {
					if (d.spine.length <= 1) return;
					d.spine.shift();
					d.parts = d.parts.map((p) => ({ ...p, s: Math.max(0, p.s - 1) }));
				}, { sound: 'thump' });
			case 'blank':
				this.undoStack.push(encodeDesign(this.design));
				this.design = blankDesign();
				return this.rebuild(true, { sound: 'pop' });
			case 'random':
				this.undoStack.push(encodeDesign(this.design));
				this.design = randomDesign(Math.floor(Math.random() * 1e9));
				return this.rebuild(true, { sound: 'pop' });
			case 'mutate': {
				this.undoStack.push(encodeDesign(this.design));
				const m = mutateDesign(this.design, Math.floor(Math.random() * 1e9));
				this.design = m.design;
				this.toast(`돌연변이: ${m.changes.join(', ')}`);
				return this.rebuild(false, { sound: 'chime' });
			}
			case 'drive':
				return this.testDrive();
			case 'save':
				return this.save(false);
			case 'release':
				return this.save(true);
			case 'playas': {
				this.save(false);
				const code = encodeDesign(normalise(this.design));
				this.game.events.push({ t: this.game.time.elapsed, type: 'editor-playas', code });
				return this.game.playAs(code);
			}
			case 'copy':
				navigator.clipboard?.writeText(encodeDesign(this.design)).then(
					() => this.toast('공유 코드를 복사했어요: 씨앗 상자에 붙여 넣으면 부화해요'),
					() => this.toast('코드를 선택해 복사하세요'),
				);
				return;
			case 'paint-base':
			case 'paint-accent':
			case 'paint-pattern': {
				const i = Number(el?.dataset.i ?? 0);
				const key = act.slice(6) as 'base' | 'accent' | 'pattern';
				return this.edit((d) => (d.paint[key] = i), { sound: 'popSmall' });
			}
			case 'pattern': {
				const k = (el?.dataset.k ?? 'none') as Design['paint']['kind'];
				return this.edit((d) => (d.paint.kind = k), { sound: 'popSmall' });
			}
			case 'variant': {
				const i = this.selected;
				const v = el?.dataset.v ?? '';
				if (i >= 0) this.edit((d) => (d.parts[i].v = v), { part: i, sound: 'popSmall' });
				return;
			}
			case 'mirrorpart': {
				const i = this.selected;
				if (i >= 0) this.edit((d) => (d.parts[i].m = !d.parts[i].m), { part: i, sound: 'popSmall' });
				return;
			}
			case 'delpart': {
				const i = this.selected;
				this.select(-1);
				if (i >= 0) this.edit((d) => d.parts.splice(i, 1), { sound: 'thump' });
				return;
			}
			case 'close':
				return g.closeEditor();
		}
	}

	/** Save into the Dex, and optionally release it into the meadow. */
	private save(release: boolean) {
		const g = this.game;
		const name = (this.root.querySelector('#ed-name') as HTMLInputElement | null)?.value.trim() || this.design.name || 'Buddy';
		this.design.name = name.slice(0, 18);
		this.design = normalise(this.design);
		const plan = compileDesign(this.design);
		const fresh = g.dex.add({ code: plan.code, name: plan.name, species: plan.species, traits: plan.traits, at: Date.now() });
		g.origins.set(plan.code, { ...(g.origins.get(plan.code) ?? {}) });
		this.toast(fresh ? `도감에 추가됐어요: ${plan.name}` : `이미 도감에 있어요: ${plan.name}`);
		g.mixer.play('confirm', { bus: 'ui' });
		void this.thumbToDex(plan.code);
		if (release) {
			g.closeEditor();
			const p = g.spawnPoint();
			const e = g.spawnFrom(plan, p.x, p.z, {});
			g.events.push({ t: g.time.elapsed, type: 'editor-release', code: plan.code, id: e.c.id });
		}
	}

	private async thumbToDex(code: string) {
		const url = await this.game.lab.portrait(code);
		this.game.dex.setThumb(code, url);
	}

	// ------------------------------------------------------------------ test drive

	testDrive() {
		if (!this.creature || this.drive) return;
		this.drive = { t: 0, step: 'walk' };
		this.creature.editorStill = false;
		this.select(-1);
		const big = Math.max(2.4, (this.plan?.footprint[1] ?? 0.4) * 9 + 1.5);
		this.pedestal.scale.set(big, 1, big);
		this.game.mixer.play('confirm', { bus: 'ui' });
	}

	private runDrive(dt: number) {
		const d = this.drive,
			c = this.creature;
		if (!d || !c || !this.plan) return;
		d.t += dt;
		const P = this.plan;
		const radius = Math.max(0.9, P.footprint[1] * 3 + 0.6);
		const steps: Array<[string, number]> = [
			['walk', 3.2],
			['run', 2.6],
			['jump', 2.4],
			['eat', 1.8],
			['dance', 2.8],
			['home', 2.5],
		];
		let acc = 0,
			step = 'done';
		for (const [s, dur] of steps) {
			if (d.t < acc + dur) {
				step = s;
				break;
			}
			acc += dur;
		}
		const local = d.t - acc;
		if (step !== d.step) {
			d.step = step;
			if (step === 'jump') c.jump();
			if (step === 'eat') c.eat();
			if (step === 'dance') c.dance(2.6);
		}
		// walk and run circles around the pedestal centre
		const ang = Math.atan2(c.pos.x, c.pos.z);
		const tangent = new THREE.Vector2(Math.cos(ang), -Math.sin(ang));
		const toRing = (radius - Math.hypot(c.pos.x, c.pos.z)) * 0.8;
		const dir = new THREE.Vector2(tangent.x + Math.sin(ang) * toRing, tangent.y + Math.cos(ang) * toRing).normalize();
		if (step === 'walk' || step === 'run') {
			c.intentDir.copy(dir);
			c.intentSpeed = step === 'walk' ? P.walkSpeed : P.runSpeed;
		} else if (step === 'jump') {
			c.intentDir.copy(dir);
			c.intentSpeed = P.walkSpeed * 0.6;
			if (local > 1.2 && !c.action) c.jump();
		} else if (step === 'home') {
			const home = new THREE.Vector2(-c.pos.x, -c.pos.z);
			c.intentSpeed = home.length() > P.R + 0.1 ? P.walkSpeed : 0;
			c.intentDir.copy(home.normalize());
			if (c.intentSpeed === 0) c.faceTarget = this.camera.position;
		} else c.intentSpeed = 0;
		if (step === 'done') {
			this.drive = null;
			c.intentSpeed = 0;
			c.faceTarget = null;
			void this.rebuild();
		}
		this.targetGoal.set(c.pos.x * 0.6, P.top * 0.45, c.pos.z * 0.6);
		this.distGoal = Math.max(this.distGoal, radius * 2.6 + 1.5);
		const el = this.root.querySelector('#ed-drive') as HTMLElement;
		el.innerHTML = this.drive ? (['walk', 'run', 'jump', 'eat', 'dance'] as const).map((s) => `<span class="${s === step ? 'on' : ''}">${{ walk: '걷기', run: '달리기', jump: '점프', eat: '먹기', dance: '춤' }[s]}</span>`).join('') : '';
	}

	// ------------------------------------------------------------------ frame

	update(dt: number) {
		const c = this.creature;
		if (!this.open || !c) return;
		if (this.drive) this.runDrive(dt);
		else {
			c.intentSpeed = 0;
			if (performance.now() > this.lookUntil) c.lookTarget = null;
		}
		c.update(dt);
		if (this.pendingStats) {
			this.statsTimer -= dt;
			if (this.statsTimer <= 0 && !this.dragging) {
				this.pendingStats = false;
				this.updateStats();
			}
		}
		if (!this.dragging && !this.drive) this.yaw += dt * 0.08;
		this.target.lerp(this.targetGoal, 1 - Math.exp(-6 * dt));
		this.dist += (this.distGoal - this.dist) * (1 - Math.exp(-6 * dt));
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
		// spine handles and the selection ring
		const R = this.plan?.R ?? 0.3;
		this.handles.forEach((hm, i) => {
			const s = this.info.segs[i];
			hm.visible = !!s && !this.drive;
			if (s) {
				hm.position.set(s.c[0] + Math.max(...s.r) * 1.08, s.c[1], s.c[2]);
				hm.position.x = 0;
				hm.position.y = s.c[1] + s.r[1] * 1.05;
				hm.scale.setScalar(Math.max(0.025, R * 0.11));
			}
		});
		const a = this.selected >= 0 ? this.info.anchors[this.selected]?.[0] : undefined;
		this.marker.visible = !!a && !this.drive;
		if (a) {
			this.marker.position.set(...a.p);
			this.marker.lookAt(this.marker.position.clone().add(new THREE.Vector3(...a.n)));
			this.marker.scale.setScalar(Math.max(0.04, R * 0.28) * (1 + Math.sin(performance.now() / 200) * 0.08));
		}
	}

	// ------------------------------------------------------------------ panels

	private toast(t: string) {
		this.game.ui.toast(esc(t), 'var(--paper)', 2600);
	}

	renderPanels() {
		const d = this.design;
		(this.root.querySelector('#ed-mirror') as HTMLElement).textContent = this.mirror ? '대칭 켜짐' : '대칭 꺼짐';
		(this.root.querySelector('#ed-mirror') as HTMLElement).classList.toggle('on', this.mirror);
		(this.root.querySelector('#ed-size') as HTMLInputElement).value = String(d.size);
		(this.root.querySelector('#ed-fat') as HTMLInputElement).value = String(d.fat);
		const sw = (act: string, cur: number, col: (i: number) => [number, number, number]) => Array.from({ length: 12 }, (_, i) => `<button class="sw${i === cur ? ' on' : ''}" data-act="${act}" data-i="${i}" style="background:${linearToHex(col(i))}" title="색 ${i + 1}"></button>`).join('');
		const sel = this.selected >= 0 ? d.parts[this.selected] : null;
		const variants: Record<string, string[]> = { leg: ['straight', 'digi', 'insect'], mouth: ['herb', 'carn', 'omni'], tail: ['plain', 'ball', 'fluff', 'spade'], horn: ['straight', 'curl'], throat: ['song', 'spit'], foot: ['paw', 'hoof', 'claw'] };
		const vname: Record<string, string> = { straight: '2관절', digi: '3관절', insect: '벌어진', herb: '초식', carn: '육식', omni: '잡식', plain: '평범한', ball: '몽둥이', fluff: '폭신한', spade: '삽', curl: '곱슬', song: '울음주머니', spit: '침샘', paw: '발', hoof: '발굽', claw: '발톱' };
		const right = this.root.querySelector('#ed-right') as HTMLElement;
		right.innerHTML = `
			<div class="lab-title"><input id="ed-name" value="${esc(d.name)}" maxlength="18" spellcheck="false" placeholder="이름 지어 주기"/></div>
			${
				sel
					? `<div class="ed-sel"><b>${(({ leg: '다리', arm: '팔', eye: '눈', stalk: '눈 줄기', mouth: '입', tail: '꼬리', horn: '뿔', frill: '주름 장식', throat: '목', wing: '날개', spike: '가시', foot: '발', hand: '손' }) as Record<string, string>)[sel.t] ?? sel.t}</b> 선택됨 · 크기 ${sel.k.toFixed(2)}
				${variants[sel.t] ? `<div class="ed-vars">${variants[sel.t].map((v) => `<button class="btn${sel.v === v ? ' on' : ''}" data-act="variant" data-v="${v}">${vname[v]}</button>`).join('')}</div>` : ''}
				<div class="ed-vars"><button class="btn${sel.m ? ' on' : ''}" data-act="mirrorpart">${sel.m ? '대칭' : '한쪽'}</button><button class="btn" data-act="delpart">제거</button></div></div>`
					: ''
			}
			<h3>색칠</h3>
			<div class="ed-sw"><span>바탕</span>${sw('paint-base', d.paint.base, baseColor)}</div>
			<div class="ed-sw"><span>포인트</span>${sw('paint-accent', d.paint.accent, accentColor)}</div>
			<div class="ed-sw"><span>무늬</span>${sw('paint-pattern', d.paint.pattern, patternColor)}</div>
			<div class="ed-vars">${(['none', 'spots', 'stripes', 'gradient', 'patches'] as const).map((k) => `<button class="btn${d.paint.kind === k ? ' on' : ''}" data-act="pattern" data-k="${k}">${({ none: '무늬 없음', spots: '점박이', stripes: '줄무늬', gradient: '그라데이션', patches: '얼룩' })[k]}</button>`).join('')}</div>
			<h3>능력 <span class="sub">부위마다 하나의 능력 레벨을 줘요</span></h3>
			<div id="ed-abil"></div>
			<h3>능력치 <span class="sub">몸과 시험 주행으로 실시간 측정</span></h3>
			<div id="ed-stats"></div>
			<div class="lab-actions">
				<button class="btn primary" data-act="playas">이걸로 플레이</button>
				<button class="btn" data-act="drive">시험 주행 <kbd>T</kbd></button>
				<button class="btn" data-act="save">도감에 저장</button>
				<button class="btn" data-act="release">초원에 풀어놓기</button>
				<button class="btn" data-act="copy">공유 코드 복사</button>
				<button class="btn" data-act="close">완료 <kbd>Esc</kbd></button>
			</div>`;
		const ni = right.querySelector('#ed-name') as HTMLInputElement;
		ni.addEventListener('keydown', (e) => e.stopPropagation());
		ni.addEventListener('change', () => this.edit((dd) => (dd.name = ni.value.slice(0, 18))));
		this.renderStats();
	}

	private renderStats() {
		const el = this.root.querySelector('#ed-stats') as HTMLElement | null;
		if (!el) return;
		const ab = this.root.querySelector('#ed-abil') as HTMLElement | null;
		if (ab && this.plan) ab.innerHTML = abilityPanel(this.plan);
		const S = this.stats,
			A = this.abil;
		if (!S || !A) {
			el.innerHTML = '<div class="sub">측정 중…</div>';
			return;
		}
		const bar = (label: string, v: number, text: string, color = 'var(--teal)') => `<div class="statrow"><span>${label}</span><i><b style="width:${Math.round(Math.max(0.04, Math.min(1, v)) * 100)}%;background:${color}"></b></i><em>${text}</em></div>`;
		el.innerHTML = [
			bar('속도', Math.log(1 + S.speed) / Math.log(6), `${S.speed.toFixed(2)} m/s`),
			bar('민첩', S.agility / 360, `${Math.round(S.agility)}°/s`),
			bar(this.plan?.gait.hop ? '점프' : '등반', Math.min(1, S.jump / 1.2), `${Math.round(S.jump * 100)} cm`),
			bar('스태미나', S.stamina, `${Math.round(S.stamina * 100)}%`),
			bar('크기', Math.min(1, Math.log(1 + S.mass) / Math.log(901)), S.mass < 1 ? `${Math.round(S.mass * 1000)} g` : `${S.mass.toFixed(S.mass < 10 ? 1 : 0)} kg`, 'var(--blue)'),
		].join('');
	}
}

export { designFromPlan, hashSeed };
