// Wild brains, one per temperament, plus the pack's. Every brain only sets intents (direction, speed, where to look,
// which action to play); the procedural gait does the walking, so feet never slide whatever the brain asks for.
//   shy          grazes near its nest; bolts from anything fast or hunting, lets a slow sneaker come close
//   curious      trots over to look at you, keeps a polite distance, copies your moves
//   territorial  guards its hill: warns (pose, red glow, growl), then charges intruders; the herd defends each other
//   hunter       a pack that roams wide; stalks grazers (and you) when hungry, then rushes and bites; eats the meat
//   grumpy       sits by the pond; spits at anyone who crowds it
//   epic         walks a slow circuit of the island; roars and chases what it sees, stomps the ground
// Everyone but the hunters and the epic goes home to sleep at night.
import * as THREE from 'three';
import { type Actor, type Attack, WINDUP } from './actors';
import type { Play } from './play';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

export function go(pl: Play, a: Actor, dx: number, dz: number, speed: number) {
	const c = a.c;
	const d = tmp.set(dx, 0, dz);
	if (d.lengthSq() < 1e-8 || speed <= 0) {
		c.intentSpeed = 0;
		return;
	}
	d.normalize();
	pl.herd.avoid(c, d);
	c.intentDir.set(d.x, d.z).normalize();
	c.intentSpeed = speed;
}

export function goTo(pl: Play, a: Actor, p: THREE.Vector3, speed: number, stop: number) {
	const d = flat(a.c.pos, p);
	if (d < stop) {
		a.c.intentSpeed = 0;
		return true;
	}
	go(pl, a, p.x - a.c.pos.x, p.z - a.c.pos.z, d < stop * 2 ? speed * 0.6 : speed);
	return false;
}

function away(pl: Play, a: Actor, from: THREE.Vector3, speed: number) {
	// run away, bending toward home so nobody flees into the sea
	let dx = a.c.pos.x - from.x,
		dz = a.c.pos.z - from.z;
	const l = Math.hypot(dx, dz) || 1;
	dx /= l;
	dz /= l;
	if (a.home) {
		const hx = a.home.x - a.c.pos.x,
			hz = a.home.z - a.c.pos.z;
		const hl = Math.hypot(hx, hz);
		if (hl > 4) {
			dx += (hx / hl) * 0.35;
			dz += (hz / hl) * 0.35;
		}
	}
	go(pl, a, dx, dz, speed);
}

function pickWander(pl: Play, a: Actor, range: number) {
	const h = a.home ?? { x: a.c.pos.x, z: a.c.pos.z };
	for (let k = 0; k < 16; k++) {
		const ang = Math.random() * Math.PI * 2;
		const r = Math.sqrt(Math.random()) * range;
		const x = h.x + Math.cos(ang) * r,
			z = h.z + Math.sin(ang) * r;
		if (pl.world.isOpen(x, z, a.c.plan.R + 0.4)) {
			a.target.set(x, 0, z);
			return;
		}
	}
	a.target.set(h.x, 0, h.z);
}

/** wind up a telegraphed attack: a red glow, a growl, then the move */
export function windup(pl: Play, a: Actor, kind: Attack) {
	if (!a.can(kind)) return false;
	a.windup = { kind, t: 0, dur: WINDUP[kind] * (a.young ? 1.25 : 1) };
	pl.sound(kind === 'stomp' ? 'roar' : 'growl', a, kind === 'stomp' ? 1 : 0.55);
	return true;
}

/** the best attack this actor has for a target at distance d */
function chooseAttack(a: Actor, d: number, foe: Actor): Attack | null {
	const reach = a.bodyR + foe.bodyR + a.c.plan.R * 0.9 + 0.2;
	if (a.sp?.temper === 'epic') {
		if (d < 5.2 && a.can('stomp')) return 'stomp';
		if (d < reach + 0.4 && a.can('bite')) return 'bite';
		return null;
	}
	if (d < reach && a.can('bite')) return 'bite';
	if (d < a.bodyR + 2.4 + foe.bodyR && a.can('strike')) return 'strike';
	if (d < 7 && a.can('charge') && (d > reach * 1.2 || a.level('bite') <= 0)) return 'charge';
	if (d > 2 && d < 8 && a.can('spit')) return 'spit';
	if (d < reach && a.can('charge')) return 'charge';
	return null;
}

/** close in and attack; returns false when it has nothing to attack with */
function fight(pl: Play, a: Actor, foe: Actor, dt: number, speedK = 1) {
	const c = a.c;
	const d = flat(c.pos, foe.c.pos);
	c.lookTarget = foe.c.headPos;
	if (a.windup || a.charging > 0 || (c.action && c.action !== 'jump')) {
		c.intentSpeed = 0;
		c.faceTarget = foe.c.pos;
		return true;
	}
	// packs and herds take turns: one telegraphed attack at a time on the same foe, so every hit is readable
	const busy = pl.actors.some((m) => m !== a && m.sp === a.sp && m.foe === foe && (m.windup || m.charging > 0 || (m.c.action && m.c.action !== 'jump' && m.c.action !== 'pose' && m.sinceAttack < 0.6)));
	const k = busy ? null : chooseAttack(a, d, foe);
	if (busy && d < a.bodyR + foe.bodyR + 1.2) {
		// circle at a little distance while waiting a turn
		const ang = Math.atan2(c.pos.x - foe.c.pos.x, c.pos.z - foe.c.pos.z) + 0.8;
		go(pl, a, foe.c.pos.x + Math.sin(ang) * (a.bodyR + foe.bodyR + 1.8) - c.pos.x, foe.c.pos.z + Math.cos(ang) * (a.bodyR + foe.bodyR + 1.8) - c.pos.z, c.plan.walkSpeed);
		return true;
	}
	if (k) {
		c.intentSpeed = 0;
		c.faceTarget = foe.c.pos;
		// face it first, then telegraph
		const ang = Math.atan2(foe.c.pos.x - c.pos.x, foe.c.pos.z - c.pos.z) - c.yaw;
		if (Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang))) < 0.5) windup(pl, a, k);
		return true;
	}
	const hasAny = (['bite', 'charge', 'strike', 'spit', 'stomp'] as Attack[]).some((x) => a.level(x) > 0);
	if (!hasAny) return false;
	// keep a spitting distance, or close in
	const want = a.level('bite') > 0 || a.level('strike') > 0 ? a.bodyR + foe.bodyR + c.plan.R * 0.5 : 4;
	if (d > want) go(pl, a, foe.c.pos.x - c.pos.x, foe.c.pos.z - c.pos.z, Math.min(c.plan.runSpeed, pl.chaseCap(a)) * speedK);
	else {
		c.intentSpeed = 0;
		c.faceTarget = foe.c.pos;
	}
	void dt;
	return true;
}

export function think(pl: Play, a: Actor, dt: number) {
	const c = a.c;
	const sp = a.sp;
	if (!sp) return;
	a.timer -= dt;
	a.greetCd -= dt;
	a.encounterCd -= dt;
	c.sitTarget = 0;
	c.faceTarget = null;
	c.crouch = 0;
	if (a.down) {
		c.intentSpeed = 0;
		return;
	}
	if (a.state === 'encounter') return;
	if (a.ally) return thinkAlly(pl, a, dt);
	const P = c.plan;
	const me = pl.player;
	const dP = me.alive ? flat(c.pos, me.c.pos) : 1e9;
	const friendly = pl.allied.has(sp.id);
	const asleep = a.state === 'sleep';
	// awareness of the player: sneaking halves how far they notice you, sprinting and attacking stretch it
	const loud = pl.playerNoise();
	const noticeR = sp.notice * loud * (pl.day.isNight ? 0.75 : 1) * (asleep ? 0.3 : 1);
	a.aware = Math.max(0, Math.min(1, a.aware + (dP < noticeR ? dt * 2.2 : -dt * 0.4)));

	// everyone (but the epic) runs from the epic when it comes close
	const E = pl.epic;
	if (sp.temper !== 'epic' && E && E.alive && flat(c.pos, E.c.pos) < 10 + E.bodyR + (E.state === 'chase' ? 5 : 0)) {
		if (a.state !== 'flee') pl.sound('yelp', a, 0.5);
		a.state = 'flee';
		a.threat = E;
		a.timer = 3;
	}
	// grazers run from a hunter on the prowl
	if ((sp.temper === 'shy' || sp.temper === 'curious') && a.state !== 'flee') {
		for (const h of pl.actors)
			if (h.alive && h.sp?.temper === 'hunter' && h.foe === a && flat(c.pos, h.c.pos) < 9) {
				a.state = 'flee';
				a.threat = h;
				a.timer = 3;
				pl.sound('yelp', a, 0.5);
			}
	}

	// hurt: fight back or run (handled once in onHurt), wake up
	// night: home to sleep (hunters and the epic stay up)
	const sleepy = pl.day.isNight && sp.temper !== 'hunter' && sp.temper !== 'epic';
	if (sleepy && !['flee', 'attack', 'threaten', 'sleep', 'home'].includes(a.state)) {
		a.state = 'home';
		a.timer = 20;
	}
	if (!pl.day.isNight && (a.state === 'sleep' || a.state === 'home') && a.timer > 1) a.timer = Math.min(a.timer, 1);

	switch (a.state) {
		case 'flee': {
			const t = a.threat;
			if (t) {
				away(pl, a, t.c.pos, P.runSpeed);
				c.lookTarget = t.c.headPos;
			}
			c.mood = 'scared';
			if (a.timer <= 0) {
				const still = t && t.alive && flat(c.pos, t.c.pos) < 8;
				if (still) a.timer = 1.5;
				else {
					a.state = 'idle';
					a.timer = 1 + Math.random();
					c.mood = 'calm';
					a.threat = null;
				}
			}
			return;
		}
		case 'home': {
			const h = a.home;
			if (!h) {
				a.state = 'idle';
				break;
			}
			const off = tmp2.set(h.x + Math.cos(a.id * 2.4) * (h.r + 0.6 + P.R), 0, h.z + Math.sin(a.id * 2.4) * (h.r + 0.6 + P.R));
			if (goTo(pl, a, off, P.walkSpeed, 0.6 + P.R) || a.timer <= 0) {
				if (pl.day.isNight) {
					a.state = 'sleep';
					a.timer = 5;
				} else {
					a.state = 'idle';
					a.timer = 1;
				}
			}
			return;
		}
		case 'sleep': {
			c.intentSpeed = 0;
			c.sitTarget = 1;
			c.mood = 'sleepy';
			c.lookTarget = null;
			if (Math.random() < dt * 0.4) pl.zzz(a);
			// a loud visitor right beside it wakes it up
			if (!friendly && dP < 2 + P.R * 2 && loud > 0.8 && sp.temper !== 'shy') {
				a.state = sp.temper === 'territorial' || sp.temper === 'grumpy' ? 'threaten' : 'alert';
				a.timer = 2;
			} else if (!pl.day.isNight && a.timer <= 0) {
				a.state = 'idle';
				a.timer = 1;
				c.mood = 'calm';
			}
			return;
		}
	}

	// friends: come and say hello now and then
	if (friendly && sp.temper !== 'epic') {
		if (a.state === 'greet') {
			c.mood = 'happy';
			c.wag = 1;
			c.lookTarget = me.c.headPos;
			if (goTo(pl, a, me.c.pos, P.walkSpeed * 1.5, 1.2 + a.bodyR + me.bodyR) || a.timer <= 0) {
				if (a.timer > 0) {
					c.jump(Math.max(0.06, (P.legLength || P.R) * 0.25));
					pl.sound('voice', a, 0.6);
					pl.game.fx.love(c.headPos, P.size);
				}
				a.state = 'idle';
				a.timer = 2;
				a.greetCd = 45 + Math.random() * 30;
			}
			return;
		}
		if (dP < 8 && a.greetCd <= 0 && !asleep && pl.encounter.active === null) {
			a.state = 'greet';
			a.timer = 6;
			return;
		}
	}

	switch (sp.temper) {
		case 'shy': {
			if (!friendly && a.aware > 0.5 && dP < noticeR) {
				const rushing = me.c.speed > me.c.plan.walkSpeed * 1.15 || me.sinceAttack < 2;
				if (rushing && dP < noticeR * 0.9) {
					a.state = 'flee';
					a.threat = me;
					a.timer = 2.5;
					pl.sound('yelp', a, 0.6);
					pl.emit('spooked', { species: sp.id });
					return;
				}
				// a slow, quiet visitor: freeze and watch
				c.intentSpeed = 0;
				c.lookTarget = me.c.headPos;
				c.faceTarget = dP < 5 ? me.c.pos : null;
				c.mood = 'curious';
				return;
			}
			break;
		}
		case 'curious': {
			if (!friendly && a.aware > 0.4 && dP < noticeR * 1.4 && dP > 1) {
				c.lookTarget = me.c.headPos;
				c.mood = 'curious';
				const keep = 2.6 + a.bodyR + me.bodyR;
				if (dP > keep + 1.5) go(pl, a, me.c.pos.x - c.pos.x, me.c.pos.z - c.pos.z, Math.min(P.runSpeed * 0.7, P.walkSpeed * 1.6));
				else {
					c.intentSpeed = 0;
					c.faceTarget = me.c.pos;
				}
				// copy the player's moves
				if (pl.lastMove && performance.now() - pl.lastMove.at < 900 && performance.now() - pl.lastMove.at > 400 && !c.action && a.timer < 0) {
					c.act(pl.lastMove.move);
					a.timer = 2;
				}
				return;
			}
			break;
		}
		case 'territorial': {
			const h = a.home;
			const terr = sp.range * 0.75;
			const intruding = h && Math.hypot(me.c.pos.x - h.x, me.c.pos.z - h.z) < terr && me.alive;
			if (a.state === 'attack' && a.foe) {
				const fh = h ? Math.hypot(a.foe.c.pos.x - h.x, a.foe.c.pos.z - h.z) : 0;
				if (!a.foe.alive || fh > terr * 1.9 || a.timer <= 0) {
					a.state = 'recover';
					a.timer = 2;
					a.foe = null;
				} else if (!fight(pl, a, a.foe, dt)) a.state = 'idle';
				return;
			}
			if (a.state === 'threaten') {
				c.intentSpeed = 0;
				c.faceTarget = me.c.pos;
				c.lookTarget = me.c.headPos;
				c.tell = Math.max(c.tell, 0.35 + 0.35 * Math.sin(performance.now() / 90));
				if (!c.action && Math.random() < dt * 1.2) c.act('pose');
				if (!intruding || friendly) {
					a.state = 'idle';
					a.timer = 1;
				} else if (a.timer <= 0) {
					a.state = 'attack';
					a.foe = me;
					a.timer = 14;
					pl.emit('territory-attack', { species: sp.id });
				}
				return;
			}
			if (intruding && !friendly && a.aware > 0.5 && a.state !== 'recover') {
				a.state = 'threaten';
				a.timer = 2.6;
				pl.sound('growl', a, 0.7);
				pl.hud.say(`${sp.many} 무리는 언덕에 널 원하지 않아!`, 'var(--pink)');
				return;
			}
			if (a.state === 'recover') {
				if (h) goTo(pl, a, tmp2.set(h.x, 0, h.z), P.walkSpeed, 2 + P.R);
				if (a.timer <= 0) a.state = 'idle';
				return;
			}
			break;
		}
		case 'hunter': {
			a.hunger = Math.min(1, a.hunger + dt / 110);
			// meat nearby: go and eat it
			const meat = pl.pantry.nearest(c.pos, 14, 'meat');
			if (meat && a.state !== 'attack' && a.state !== 'hunt') {
				if (goTo(pl, a, meat.pos, P.walkSpeed * 1.4, 0.5 + P.R)) {
					if (!c.action) {
						c.act('eat', 1.4);
						pl.pantry.eat(meat);
						a.hunger = 0;
						pl.sound('munch', a, 0.5);
					}
				}
				c.lookTarget = meat.pos;
				return;
			}
			if ((a.state === 'hunt' || a.state === 'attack') && a.foe) {
				const f = a.foe;
				const far = flat(c.pos, f.c.pos);
				if (!f.alive || far > 30 || a.timer <= 0 || (f === me && friendly)) {
					a.state = 'roam';
					a.foe = null;
					a.timer = 3;
					return;
				}
				if (a.state === 'hunt' && far > 6) {
					// stalk: low and slow, then the rush
					c.crouch = 0.7;
					c.lookTarget = f.c.headPos;
					go(pl, a, f.c.pos.x - c.pos.x, f.c.pos.z - c.pos.z, P.walkSpeed * 0.8);
					if (far < 9 && Math.random() < dt) pl.sound('growl', a, 0.35);
					return;
				}
				a.state = 'attack';
				if (!fight(pl, a, f, dt)) a.state = 'roam';
				return;
			}
			// pick a target: the player (if we noticed it) or a grazer, when hungry
			if (a.hunger > 0.55 || (a.aware > 0.7 && !friendly && pl.huntsPlayer())) {
				let prey: Actor | null = null;
				let pd = 22;
				if (!friendly && pl.huntsPlayer() && me.alive && dP < Math.max(noticeR, 6)) {
					prey = me;
					pd = dP;
				}
				if (!prey && a.hunger > 0.55)
					for (const o of pl.actors) {
						if (!o.alive || o.ally || !o.sp || (o.sp.temper !== 'shy' && o.sp.temper !== 'curious')) continue;
						if (pl.protectedSpot(o.c.pos)) continue;
						const d = flat(c.pos, o.c.pos);
						if (d < pd && o.size < a.size * 1.3) {
							pd = d;
							prey = o;
						}
					}
				if (prey) {
					// the whole pack joins
					for (const m of pl.actors)
						if (m.sp === sp && m.alive && !m.ally && (m === a || flat(m.c.pos, c.pos) < 12) && m.state !== 'attack') {
							m.state = 'hunt';
							m.foe = prey;
							m.timer = 25;
						}
					if (prey === me) pl.emit('hunted', { species: sp.id });
					return;
				}
			}
			// roam with the pack: the first one leads, the others trail it
			const lead = pl.actors.find((m) => m.sp === sp && m.alive && !m.ally && m.state !== 'encounter');
			if (lead && lead !== a) {
				const keep = 1.8 + a.bodyR * 2;
				const d = flat(c.pos, lead.c.pos);
				if (d > keep) go(pl, a, lead.c.pos.x - c.pos.x + Math.cos(a.id) * 1.2, lead.c.pos.z - c.pos.z + Math.sin(a.id) * 1.2, d > keep * 3 ? P.runSpeed * 0.7 : P.walkSpeed * 1.1);
				else c.intentSpeed = 0;
				c.mood = 'calm';
				return;
			}
			if (a.state !== 'roam' || a.timer <= 0 || flat(c.pos, a.target) < 1 + P.R) {
				a.state = 'roam';
				a.timer = 14;
				pickWander(pl, a, sp.range);
			}
			go(pl, a, a.target.x - c.pos.x, a.target.z - c.pos.z, P.walkSpeed);
			return;
		}
		case 'grumpy': {
			if (a.state === 'attack' && a.foe) {
				if (!a.foe.alive || flat(c.pos, a.foe.c.pos) > 10 || a.timer <= 0) {
					a.state = 'idle';
					a.foe = null;
					a.timer = 2;
				} else if (!fight(pl, a, a.foe, dt, 0.6)) a.state = 'idle';
				return;
			}
			if (a.state === 'threaten') {
				c.intentSpeed = 0;
				c.faceTarget = me.c.pos;
				c.lookTarget = me.c.headPos;
				c.tell = Math.max(c.tell, 0.3 + 0.3 * Math.sin(performance.now() / 100));
				if (dP > 6 || friendly) {
					a.state = 'idle';
					a.timer = 1;
				} else if (a.timer <= 0) {
					a.state = 'attack';
					a.foe = me;
					a.timer = 8;
				}
				return;
			}
			if (!friendly && dP < 3.2 + a.bodyR && loud > 0.6 && a.aware > 0.6) {
				a.state = 'threaten';
				a.timer = 1.8;
				pl.sound('croak', a, 0.8);
				return;
			}
			break;
		}
		case 'epic':
			return thinkEpic(pl, a, dt, dP, noticeR);
	}

	// grazing life: wander near home, stop to eat, idle and look around
	switch (a.state) {
		case 'wander': {
			if (goTo(pl, a, a.target, P.walkSpeed * 0.9, 0.6 + P.R) || a.timer <= 0) {
				a.state = Math.random() < 0.5 ? 'graze' : 'idle';
				a.timer = 2 + Math.random() * 4;
			}
			c.mood = 'calm';
			return;
		}
		case 'graze': {
			c.intentSpeed = 0;
			if (!c.action && Math.random() < dt * 0.5) c.act('eat', 1.6);
			if (a.timer <= 0) {
				a.state = 'idle';
				a.timer = 1 + Math.random() * 2;
			}
			return;
		}
		default: {
			c.intentSpeed = 0;
			if (a.state !== 'idle') {
				a.state = 'idle';
				a.timer = 1 + Math.random() * 2;
			}
			// glance at a neighbour, or the player when it's close
			if (dP < 6) c.lookTarget = me.c.headPos;
			if (a.timer <= 0) {
				a.state = 'wander';
				a.timer = 12;
				pickWander(pl, a, sp.range);
				// herding: stay with the group
				const mates = pl.actors.filter((m) => m.sp === sp && m.alive && m !== a && !m.ally);
				if (mates.length && Math.random() < 0.6) {
					const cx = mates.reduce((s, m) => s + m.c.pos.x, 0) / mates.length,
						cz = mates.reduce((s, m) => s + m.c.pos.z, 0) / mates.length;
					a.target.x = a.target.x * 0.5 + cx * 0.5;
					a.target.z = a.target.z * 0.5 + cz * 0.5;
				}
			}
		}
	}
}

function thinkEpic(pl: Play, a: Actor, dt: number, dP: number, noticeR: number) {
	const c = a.c;
	const P = c.plan;
	const me = pl.player;
	if (a.state === 'chase' && a.foe) {
		const d = flat(c.pos, a.foe.c.pos);
		if (!a.foe.alive || d > 26 || a.timer <= 0) {
			if (a.foe === me && me.alive) pl.emit('epic-escaped', {});
			a.state = 'roam';
			a.foe = null;
			a.greetCd = 40;
			a.timer = 2;
			pl.hud.say('선더백이 흥미를 잃었어…', 'var(--teal)');
			return;
		}
		fight(pl, a, a.foe, dt);
		return;
	}
	// spots you: a roar, then the chase
	if (me.alive && dP < noticeR && a.aware > 0.6 && a.greetCd <= 0 && !pl.protectedSpot(me.c.pos)) {
		a.state = 'chase';
		a.foe = me;
		a.timer = 11;
		c.act('roar');
		pl.sound('roar', a, 1);
		pl.cam.shake(0.45);
		pl.emit('epic-chase', {});
		pl.hud.say('선더백이 와! 도망쳐!', 'var(--pink)');
		return;
	}
	// a slow circuit around the island
	if (a.state !== 'roam' || flat(c.pos, a.target) < 2 + P.R || a.timer <= 0) {
		a.state = 'roam';
		a.timer = 30;
		const ang = Math.atan2(c.pos.z, c.pos.x) + 0.55;
		const r = 34 + Math.sin(ang * 3) * 6;
		const x = Math.cos(ang) * r,
			z = Math.sin(ang) * r;
		a.target.set(x, 0, z);
		if (!pl.world.isOpen(x, z, 2)) a.target.set(x * 0.8, 0, z * 0.8);
	}
	go(pl, a, a.target.x - c.pos.x, a.target.z - c.pos.z, P.walkSpeed * 0.8);
	c.lookTarget = dP < 20 ? me.c.headPos : null;
}

function thinkAlly(pl: Play, a: Actor, dt: number) {
	const c = a.c;
	const P = c.plan;
	const me = pl.player;
	c.mood = 'happy';
	if (!me.alive) {
		c.intentSpeed = 0;
		return;
	}
	// help in a fight: the player's foe (or whoever is attacking the player)
	const foe = pl.playerFoe();
	if (foe && foe.alive && flat(foe.c.pos, me.c.pos) < 14) {
		if (fight(pl, a, foe, dt)) return;
	}
	if (pl.encounter.active) {
		// stand beside you and watch the show
		const side = a.slot === 0 ? 1 : -1;
		const fx = Math.sin(me.c.yaw),
			fz = Math.cos(me.c.yaw);
		const spot = tmp2.set(me.c.pos.x - fx * 1.2 + fz * side * (1.4 + a.bodyR * 2), 0, me.c.pos.z - fz * 1.2 - fx * side * (1.4 + a.bodyR * 2));
		if (goTo(pl, a, spot, P.walkSpeed * 1.4, 0.5)) {
			c.faceTarget = pl.encounter.active.partner.c.pos;
			c.lookTarget = pl.encounter.active.partner.c.headPos;
		}
		return;
	}
	// follow: a little behind and to the side, matching your pace
	const side = a.slot === 0 ? 1 : -1;
	const fx = Math.sin(me.c.yaw),
		fz = Math.cos(me.c.yaw);
	const back = 1.4 + a.bodyR + me.bodyR + a.slot * 0.8;
	const spot = tmp2.set(me.c.pos.x - fx * back + fz * side * (1 + a.bodyR), 0, me.c.pos.z - fz * back - fx * side * (1 + a.bodyR));
	const d = flat(c.pos, spot);
	// fallen far behind and out of sight: it catches up from just off-screen and runs back into view
	if (d > 40 || (d > 9 && !c.visible)) {
		pl.catchUp(a);
		return;
	}
	const speed = d > 6 ? P.runSpeed : d > 2 ? Math.max(P.walkSpeed * 1.2, me.c.speed * 1.05) : me.c.speed > 0.1 ? me.c.speed : 0;
	if (d > 0.7) go(pl, a, spot.x - c.pos.x, spot.z - c.pos.z, speed);
	else {
		c.intentSpeed = 0;
		c.lookTarget = me.c.headPos;
	}
	if (me.c.action === 'jump' && !c.action && Math.random() < 0.02) c.jump();
}
