// Play input: keyboard + mouse and gamepads (standard mapping; a PS4 pad reads as the standard layout), merged into
// one set of intents each frame. The HUD shows the glyphs of whichever device was used last.
//
//   Keyboard            Gamepad (PS4)         Action
//   WASD / arrows       left stick            move (camera-relative)
//   mouse (locked) /    right stick           look
//     drag
//   Shift               R2 / L3               sprint (stamina)
//   C                   L2                    sneak
//   Space               Cross                 jump (hold to glide with wings)
//   Left click / J      Square                bite
//   Right click / K     Circle                charge
//   R                   R1                    strike
//   T                   L1                    spit
//   F                   Triangle              interact: eat, greet, recruit, the egg
//   1 2 3 4             D-pad up/right/down/left  sing, dance, charm, pose
//   Tab                 Share                 Dex
//   H                   touchpad              controls card
//   Esc                 Options               pause menu
//   G                   R3                    call creatures over
// On an Xbox-style pad the same buttons are A, B, X, Y, RB, LB, RT, LT, View and Menu, and the glyphs say so.

export type Button = 'jump' | 'bite' | 'charge' | 'strike' | 'spit' | 'interact' | 'sing' | 'dance' | 'charm' | 'pose' | 'dex' | 'help' | 'pause' | 'call';
export type Device = 'keyboard' | 'gamepad';

const KEYMAP: Record<string, Button> = {
	Space: 'jump',
	KeyJ: 'bite',
	KeyK: 'charge',
	KeyR: 'strike',
	KeyT: 'spit',
	KeyF: 'interact',
	Digit1: 'sing',
	Digit2: 'dance',
	Digit3: 'charm',
	Digit4: 'pose',
	KeyH: 'help',
	Escape: 'pause',
	KeyG: 'call',
};
const PADMAP: Record<number, Button> = { 0: 'jump', 2: 'bite', 1: 'charge', 5: 'strike', 4: 'spit', 3: 'interact', 12: 'sing', 15: 'dance', 13: 'charm', 14: 'pose', 8: 'dex', 17: 'help', 9: 'pause', 11: 'call' };
/** Whose button names the pad in use wears, from its id (vendor 054c is Sony); glyph() draws them. */
export let padKind: 'ps' | 'xbox' = 'ps';
const kindOf = (id: string): 'ps' | 'xbox' => (/054c|playstation|dualshock|dualsense/i.test(id) || !id ? 'ps' : 'xbox');
/** The pad to read: the first with the standard layout, which PADMAP assumes, else the first connected. */
export function pickPad(): Gamepad | null {
	const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
	let g: Gamepad | null = null;
	for (const p of pads) {
		if (!p || !p.connected) continue;
		if (p.mapping === 'standard') {
			g = p;
			break;
		}
		g ??= p;
	}
	if (g) padKind = kindOf(g.id);
	return g;
}
/** A PlayStation button name in the pad's own words (R2 is RT on an Xbox pad). */
export function padWord(ps: string): string {
	const X: Record<string, string> = { R2: 'RT', L2: 'LT', R1: 'RB', L1: 'LB', R3: 'RS', L3: 'LS', Share: 'View', Options: 'Menu' };
	return padKind === 'xbox' ? (X[ps] ?? ps) : ps;
}

export class PlayInput {
	/** -1..1 strafe, forward */
	move = { x: 0, y: 0 };
	/** look delta this frame (radians) */
	look = { yaw: 0, pitch: 0 };
	sprint = false;
	sneak = false;
	device: Device = 'keyboard';
	padName = '';
	private keys = new Set<string>();
	private held = new Set<Button>();
	private pressedQ = new Set<Button>();
	private padPrev: boolean[] = [];
	/** pad buttons a menu used: ignored until let go, so the button that closes a card doesn't also jump */
	private swallowed = new Set<number>();
	private mouseDX = 0;
	private mouseDY = 0;
	private mouseButtons = new Set<number>();
	enabled = false;
	/** self-checks and tests can push the stick */
	forceMove: { x: number; y: number } | null = null;
	/** true when the last look came from the mouse or a pad (pauses the camera's auto-follow) */
	lookedAt = 0;

	constructor(readonly canvas: HTMLCanvasElement) {
		addEventListener('keydown', (e) => {
			if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return;
			this.device = 'keyboard';
			if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
			this.keys.add(e.code);
			const b = KEYMAP[e.code];
			if (b && !e.repeat) {
				this.pressedQ.add(b);
				this.held.add(b);
			}
		});
		addEventListener('keyup', (e) => {
			this.keys.delete(e.code);
			const b = KEYMAP[e.code];
			if (b) this.held.delete(b);
		});
		addEventListener('blur', () => {
			this.keys.clear();
			this.held.clear();
			this.mouseButtons.clear();
		});
		canvas.addEventListener('mousemove', (e) => {
			if (!this.enabled) return;
			const locked = document.pointerLockElement === canvas;
			if (locked || this.mouseButtons.size) {
				this.mouseDX += e.movementX;
				this.mouseDY += e.movementY;
			}
		});
	}

	/** mouse buttons from the game's pointer handlers (so a drag to look never counts as an attack) */
	mouseDown(button: number) {
		this.device = 'keyboard';
		this.mouseButtons.add(button);
		if (document.pointerLockElement === this.canvas) {
			if (button === 0) this.pressedQ.add('bite');
			if (button === 2) this.pressedQ.add('charge');
		}
	}
	mouseUp(button: number, click: boolean) {
		this.mouseButtons.delete(button);
		// unlocked: a plain click (no drag) still attacks
		if (click && document.pointerLockElement !== this.canvas) {
			if (button === 0) this.pressedQ.add('bite');
			if (button === 2) this.pressedQ.add('charge');
		}
	}

	pressed(b: Button) {
		return this.pressedQ.has(b);
	}
	isHeld(b: Button) {
		return this.held.has(b);
	}
	/** Ignore the pad buttons held now until they're let go. */
	swallow() {
		pickPad()?.buttons.forEach((b, i) => {
			if (b.pressed) this.swallowed.add(i);
		});
	}
	/** inject a press (on-screen buttons, tests) */
	press(b: Button) {
		this.pressedQ.add(b);
	}

	/** Read devices for this frame. Call once per frame before using the intents; call endFrame() after. */
	poll(dt: number) {
		const k = this.keys;
		let x = 0,
			y = 0;
		if (k.has('KeyW') || k.has('ArrowUp')) y += 1;
		if (k.has('KeyS') || k.has('ArrowDown')) y -= 1;
		if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
		if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
		const kl = Math.hypot(x, y);
		if (kl > 1) {
			x /= kl;
			y /= kl;
		}
		this.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
		// (not Ctrl: Ctrl+W closes the tab)
		this.sneak = k.has('KeyC');
		const sens = 0.0024;
		this.look.yaw = -this.mouseDX * sens;
		this.look.pitch = this.mouseDY * sens * 0.8;
		if (this.mouseDX || this.mouseDY) this.lookedAt = performance.now();
		this.mouseDX = this.mouseDY = 0;
		// gamepads
		const p = pickPad();
		if (p) {
			for (const i of this.swallowed) if (!p.buttons[i]?.pressed) this.swallowed.delete(i);
			const dz = (ax: number, ay: number, d = 0.16) => {
				const m = Math.hypot(ax, ay);
				if (m < d) return [0, 0];
				const s = Math.min(1, (m - d) / (1 - d)) / m;
				return [ax * s, ay * s];
			};
			const [lx, ly] = dz(p.axes[0] ?? 0, p.axes[1] ?? 0);
			const [rx, ry] = dz(p.axes[2] ?? 0, p.axes[3] ?? 0, 0.12);
			const btn = (i: number) => !!p.buttons[i]?.pressed && !this.swallowed.has(i);
			const val = (i: number) => (this.swallowed.has(i) ? 0 : (p.buttons[i]?.value ?? 0));
			// a resting stick that drifts a little doesn't flip the glyphs back from the keyboard
			const any = Math.hypot(p.axes[0] ?? 0, p.axes[1] ?? 0) > 0.5 || Math.hypot(p.axes[2] ?? 0, p.axes[3] ?? 0) > 0.5 || p.buttons.some((b) => b.pressed);
			if (any) {
				this.device = 'gamepad';
				this.padName = p.id;
			}
			if (Math.hypot(lx, ly) > Math.hypot(x, y)) {
				x = lx;
				y = -ly;
			}
			if (rx || ry) {
				// response curve: fine aim near the centre, fast turns at the edge
				this.look.yaw -= Math.sign(rx) * rx * rx * 3.0 * dt;
				this.look.pitch += Math.sign(ry) * ry * ry * 1.8 * dt;
				this.lookedAt = performance.now();
			}
			if (val(7) > 0.35 || btn(10)) this.sprint = true;
			if (val(6) > 0.35) this.sneak = true;
			for (const [i, b] of Object.entries(PADMAP)) {
				const n = Number(i);
				const down = btn(n);
				if (down && !this.padPrev[n]) this.pressedQ.add(b);
				if (down) this.held.add(b);
				else if (this.padPrev[n]) this.held.delete(b);
				this.padPrev[n] = down;
			}
		}
		if (this.forceMove) {
			x = this.forceMove.x;
			y = this.forceMove.y;
		}
		this.move.x = x;
		this.move.y = y;
	}

	endFrame() {
		this.pressedQ.clear();
	}

	clear() {
		this.keys.clear();
		this.held.clear();
		this.pressedQ.clear();
		this.move.x = this.move.y = 0;
	}
}

/** Glyph for a button on the current device: keyboard keys, or the pad's face buttons drawn in SVG (PlayStation shapes,
 * or Xbox letters). */
export function glyph(b: Button, device: Device): string {
	if (device === 'keyboard') {
		const K: Partial<Record<Button, string>> = { jump: 'Space', bite: '클릭', charge: '우클릭', strike: 'R', spit: 'T', interact: 'F', sing: '1', dance: '2', charm: '3', pose: '4', dex: 'Tab', help: 'H', pause: 'Esc', call: 'G' };
		return `<kbd>${K[b] ?? b}</kbd>`;
	}
	const face = (shape: string, color: string) => `<span class="pad"><svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="9" fill="#23263a"/>${shape.replace(/C/g, color)}</svg></span>`;
	if (padKind === 'xbox') {
		const letter = (l: string, color: string) => `<span class="pad"><svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="9" fill="#23263a"/><text x="10" y="14.2" text-anchor="middle" font-size="11.5" font-weight="700" font-family="system-ui,sans-serif" fill="${color}">${l}</text></svg></span>`;
		const XF: Partial<Record<Button, string>> = { jump: letter('A', '#7bd88f'), charge: letter('B', '#ff7c8a'), bite: letter('X', '#8fb8ff'), interact: letter('Y', '#ffd36b') };
		const XT: Partial<Record<Button, string>> = { strike: 'RB', spit: 'LB', sing: 'D-up', dance: 'D-right', charm: 'D-down', pose: 'D-left', dex: 'View', help: 'Menu, 조작법', pause: 'Menu', call: 'RS' };
		return XF[b] ?? `<kbd>${XT[b] ?? b}</kbd>`;
	}
	const P: Partial<Record<Button, string>> = {
		jump: face('<path d="M6 6l8 8M14 6l-8 8" stroke="C" stroke-width="2.2" stroke-linecap="round"/>', '#8fb8ff'),
		charge: face('<circle cx="10" cy="10" r="4.5" fill="none" stroke="C" stroke-width="2.2"/>', '#ff7c8a'),
		bite: face('<rect x="5.5" y="5.5" width="9" height="9" fill="none" stroke="C" stroke-width="2.2"/>', '#f4a6ff'),
		interact: face('<path d="M10 5l5.2 9H4.8z" fill="none" stroke="C" stroke-width="2.1" stroke-linejoin="round"/>', '#59e0b8'),
	};
	const T: Partial<Record<Button, string>> = { strike: 'R1', spit: 'L1', sing: 'D-up', dance: 'D-right', charm: 'D-down', pose: 'D-left', dex: 'Share', help: 'Pad', pause: 'Options', call: 'R3' };
	return P[b] ?? `<kbd>${T[b] ?? b}</kbd>`;
}
