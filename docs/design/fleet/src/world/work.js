// 每个 Agent 的活：结合飞船外形，各干各的
import * as THREE from 'three';
import { Beam, Cone, Trail, Pages, SHAPE } from '../gfx/fx.js';
import { Swarm } from '../gfx/pack.js';
import { V, UP, DIR, home, ease, smooth } from './ship.js';

const WHITE = new THREE.Color(1, 1, 1), AMBER = new THREE.Color('#ffb347');
const _v = V(), _w = V(), _q = new THREE.Quaternion(), _s = V(), _m = new THREE.Matrix4();
const bez = (a, b, c, t, o) => { const m = 1 - t; return o.set(a.x * m * m + 2 * b.x * m * t + c.x * t * t, a.y * m * m + 2 * b.y * m * t + c.y * t * t, a.z * m * m + 2 * b.z * m * t + c.z * t * t); };
const look = (f, up = UP, out = new THREE.Quaternion()) => { _m.lookAt(f, _w.set(0, 0, 0), up); return out.setFromRotationMatrix(_m); };
const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // 船体板的正面朝 +Y
const rnd = (a, b) => a + Math.random() * (b - a);
const polar = (r, deg, z) => new THREE.Vector3(Math.cos(deg * Math.PI / 180) * r, Math.sin(deg * Math.PI / 180) * r, z);

class Work {
  constructor(w, ship) { this.w = w; this.ship = ship; this.k = 0; this.group = new THREE.Group(); w.scene.add(this.group); this.center = V(); this.progress = 0; this.gs = []; this.ghost = 0; }
  get active() { return this.ship.state === 'run'; }
  setGhost(k) { this.ghost = k; for (const u of this.gs) u.uGhost.value = k; (this.trails || []).forEach((x) => { x.u.uAlpha.value *= 1 - k; }); }
  step(dt, t) { this.k += ((this.active ? 1 : 0) - this.k) * (1 - Math.exp(-dt * 1.6)); this.ready = this.active && this.ship.mode === 'work' && t - this.ship.modeT > (this.ship.T || 2) * .8; this.update(dt, t); }
  focus() { return { target: this.center, dist: 15 }; }
}

// ---------------------------------------------------------------- Claude Code：放出工程无人机，把船体板一块块焊上去
class Build extends Work {
  constructor(w, ship) {
    super(w, ship); this.center = polar(8.1, 116, 5.1); this.n = new THREE.Vector3(-.18, .36, .92).normalize(); this.tx = new THREE.Vector3().crossVectors(UP, this.n).normalize(); this.ty = new THREE.Vector3().crossVectors(this.n, this.tx);
    const S = .66; this.slots = []; for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) { if (Math.abs(q + r) > 2) continue; const x = S * 1.62 * (q + r / 2), y = S * 1.40 * r; const d2 = x * x + y * y; this.slots.push({ p: this.center.clone().addScaledVector(this.tx, x).addScaledVector(this.ty, y).addScaledVector(this.n, -d2 * .03), d: Math.sqrt(d2), st: 0, sk: 1, fl: 0 }); }
    this.slots.sort((a, b) => a.d - b.d + (Math.random() - .5) * .3); this.S = S;
    this.tiles = new Swarm(w.packs.tile, this.slots.length); this.drones = new Swarm(w.packs.drone, 6); this.group.add(this.tiles.mesh, this.drones.mesh); this.tiles.uniforms.uShadowSel.value = -1; this.drones.uniforms.uShadowSel.value = -1;
    this.d = Array.from({ length: 6 }, (_, i) => ({ st: 'home', t: -i * .55, p: ship.p.clone(), v: V(), q: new THREE.Quaternion(), slot: -1, a: V(), b: V(), trail: new Trail(22, ship.def.hot, .035) })); this.d.forEach((x) => this.group.add(x.trail.mesh));
    this.gs = [this.tiles.uniforms, this.drones.uniforms]; this.trails = this.d.map((x) => x.trail); this.done = 0; this.hold = 0; this.q = look(this.n).multiply(TILT); this.wave = -1;
  }
  pose(t) { return { p: new THREE.Vector3(-2.6, 15.6, 8.6), f: new THREE.Vector3(.90, -.14, .42).normalize() }; }
  focus() { return { target: this.center.clone().lerp(this.ship.p, .56), dist: 27, az: 4, el: 8, dir: this.n }; }
  update(dt, t) {
    const col = this.ship.color, sp = this.w.sprites; const S = this.S;
    if (this.done >= this.slots.length) { // 一片拼好：整体上色发光，并入船体
      this.hold += dt; if (this.hold < dt * 1.5) { this.w.rings.emit({ p: this.center.clone().addScaledVector(this.n, .3), n: this.n, r0: 1, r1: 7.5, life: 1.5, w: .05, w1: .01, col, k: 2.2 }); this.w.stationPulse(this.center, col); }
      this.slots.forEach((s, i) => { s.fl = Math.max(0, Math.exp(-Math.pow((this.hold - .1 - s.d * .28) / .16, 2))); }); if (this.hold > 2.6) { const k = ease((this.hold - 2.6) / 1.2); this.slots.forEach((s) => { s.sink = k; }); if (this.hold > 4.2) { this.slots.forEach((s) => { s.st = 0; s.sk = 1; s.sink = 0; s.fl = 0; }); this.done = 0; this.hold = 0; } }
    }
    this.progress = this.done / this.slots.length;
    this.d.forEach((d, i) => {
      d.t += dt; const bay = this.ship.local((i % 2 ? -2.2 : 2.2), -3.4, -3 + i * 1.3, _w); let tgt = null, eng = .5;
      if (d.st === 'home') { d.p.lerp(bay, 1 - Math.exp(-dt * 6)); d.vis = Math.max(0, (d.vis || 0) - dt * 3); if (this.ready && d.t > 0 && this.done < this.slots.length) { const si = this.slots.findIndex((s) => s.st === 0); if (si >= 0) { d.slot = si; this.slots[si].st = 1; d.st = 'carry'; d.t = 0; d.a.copy(bay); d.b.copy(this.center).lerp(bay, .5).addScaledVector(this.n, rnd(2, 4)).addScaledVector(this.tx, rnd(-3, 3)); d.trail.reset(d.p); } else d.t = -.4; } }
      const s = this.slots[d.slot];
      if (d.st === 'carry') { d.vis = Math.min(1, (d.vis || 0) + dt * 4); const u = ease(d.t / 1.9); const end = _w.copy(s.p).addScaledVector(this.n, .95).addScaledVector(this.ty, .2); tgt = bez(d.a, d.b, end, u, V()); eng = 1; if (d.t > 1.9) { d.st = 'weld'; d.t = 0; s.st = 2; } }
      else if (d.st === 'weld') { const jig = Math.sin(t * 9 + i) * .10; tgt = s.p.clone().addScaledVector(this.n, .86).addScaledVector(this.tx, Math.cos(t * 2.1 + i) * .34).addScaledVector(this.ty, Math.sin(t * 2.6 + i * 2) * .3 + jig * .1); const u = Math.min(1, d.t / 1.5); s.sk = 1 - smooth(.35, 1, u); const hit = s.p.clone().addScaledVector(this.tx, Math.cos(t * 2.1 + i) * .3).addScaledVector(this.ty, Math.sin(t * 2.6 + i * 2) * .26).addScaledVector(this.n, .12);
        if (Math.random() < dt * 48) for (let k = 0; k < 2; k++) sp.emit({ p: hit, v: this.n.clone().multiplyScalar(rnd(.6, 2.4)).addScaledVector(this.tx, rnd(-1.7, 1.7)).addScaledVector(this.ty, rnd(-1.7, 1.7)), life: rnd(.25, .7), size: rnd(.02, .04), stretch: .07, shape: SHAPE.spark, col: Math.random() < .5 ? this.ship.hot : AMBER, k: 2.2, drag: 1.8, grav: 1.2 });
        if (Math.random() < dt * 26) sp.emit({ p: hit, life: .08, size: rnd(.07, .13), shape: SHAPE.dot, col: this.ship.hot, k: 1.2 }); if (Math.random() < dt * 6) sp.emit({ p: hit, life: .12, size: rnd(.12, .2), shape: SHAPE.kimi, rot: rnd(0, 3), col: WHITE, k: 1.8 });
        if (u >= 1) { s.sk = 0; s.st = 3; s.fl = .9; this.done++; d.st = 'back'; d.t = 0; d.a.copy(d.p); d.b.copy(this.center).lerp(bay, .6).addScaledVector(this.n, rnd(1, 3)); this.w.rings.emit({ p: s.p.clone().addScaledVector(this.n, .14), n: this.n, r0: .3, r1: 1.2, life: .5, w: .12, w1: .02, col, k: 2 }); } }
      else if (d.st === 'back') { const u = ease(d.t / 1.4); tgt = bez(d.a, d.b, bay, u, V()); if (d.t > 1.4) { d.st = 'home'; d.t = rnd(-.5, .1); d.slot = -1; } }
      if (tgt) { _s.copy(tgt).sub(d.p).divideScalar(Math.max(dt, .001)); d.v.lerp(_s, 1 - Math.exp(-dt * 8)); d.p.copy(tgt); }
      const face = d.st === 'weld' ? this.n.clone().negate() : d.v.lengthSq() > .2 ? d.v.clone().normalize() : this.ship.f; d.q.slerp(look(face), 1 - Math.exp(-dt * 7)); const sc = .5 * (d.vis || 0); this.drones.set(i, d.p, d.q, _s.setScalar(sc)); this.drones.look(i, col, 0, 0, 1, eng);
      d.trail.u.uAlpha.value = (d.st === 'carry' || d.st === 'back') ? .9 : Math.max(0, d.trail.u.uAlpha.value - dt * 2); d.trail.push(d.p, dt);
      if (d.st === 'carry') s.carry = d.p.clone().addScaledVector(d.v.clone().normalize(), .55);
    });
    this.slots.forEach((s, i) => { if (!s.st) { this.tiles.set(i, s.p, this.q, _s.setScalar(.0001)); return; } let p = s.p, q = this.q, sc = S; if (s.st === 1) { p = s.carry || this.ship.p; sc = S * .55; q = _q.copy(this.q); } const k = s.sink || 0; s.fl = this.done >= this.slots.length ? s.fl : Math.max(0, s.fl - dt * 2); this.tiles.set(i, _v.copy(p).addScaledVector(this.n, -k * 1.3), q, _s.setScalar(sc * (1 - k))); this.tiles.look(i, col, s.st === 1 ? 1 : s.sk, s.fl * .85); });
  }
  shots() { return [
    { key: 'weld', T: 9, cam: (t, u, o) => { const a = -.75 + u * .8; o.pos.copy(this.center).addScaledVector(this.n, 7.4 + u * 1.2).addScaledVector(this.tx, Math.sin(a) * 9.5).addScaledVector(this.ty, -4.2 + u * 1.6); o.tgt.copy(this.center).addScaledVector(this.n, .7).addScaledVector(this.ty, .9); o.fov = 46; } },
    { key: 'deck', T: 8, cam: (t, u, o) => { this.ship.local(-17 + u * 7, 10 - u * 2, 27 - u * 3, o.pos); this.ship.local(0, -.4, -1, o.tgt); o.fov = 40; } },
    { key: 'torch', T: 8, cam: (t, u, o) => { const d = this.d.find((x) => x.st === 'weld') || this.d.find((x) => x.st === 'carry') || this.d[0]; const s = this.slots[d.slot]; const p = s ? s.p : this.center; o.pos.copy(p).addScaledVector(this.n, 2.1).addScaledVector(this.tx, -3.6 + u * 1.4).addScaledVector(this.ty, -1.3); o.tgt.copy(p).addScaledVector(this.n, .55).addScaledVector(this.ty, .25); o.fov = 44; o.soft = 1.6; } },
  ]; }
}

// ---------------------------------------------------------------- Codex：牵引光把货柜一只只码进船坞
class Haul extends Work {
  constructor(w, ship) {
    super(w, ship); this.base = polar(8.4, -40, 5.6); this.center = this.base.clone().add(new THREE.Vector3(0, .8, 1)); this.slots = []; const s = .78; this.s = s;
    for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) for (let i = 0; i < 3; i++) this.slots.push({ p: this.base.clone().add(new THREE.Vector3((i - 1) * 1.42 * s, j * 1.42 * s - .4, k * 2.7 * s - .2)), st: 0, u: 0, sk: 1, fl: 0 });
    this.crates = new Swarm(w.packs.crate, 12); this.group.add(this.crates.mesh); this.crates.uniforms.uShadowSel.value = -1; this.cone = new Cone(ship.def.hot); this.cone2 = new Cone(ship.def.hot); this.group.add(this.cone.mesh, this.cone2.mesh); this.gs = [this.crates.uniforms]; this.next = 0; this.cool = 0; this.hold = 0; this.q = new THREE.Quaternion(); this.aim = 0;
  }
  pose(t) { return { p: new THREE.Vector3(6.6, -14.2, 11.6), f: new THREE.Vector3(-.92, .06, .30).normalize() }; }
  focus() { return { target: this.center.clone().lerp(this.ship.p, .55), dist: 25, az: -14, el: 9, dir: DIR }; }
  update(dt, t) {
    const col = this.ship.color; this.cool -= dt; const flying = this.slots.filter((s) => s.st === 1);
    if (this.ready && this.cool <= 0 && flying.length < 2 && this.next < 12) { const s = this.slots[this.next++]; s.st = 1; s.u = 0; const side = this.next % 2 ? 1 : -1; s.side = side; s.a = this.ship.local(side * 5.6, -1.2, 2, V()); s.b = s.a.clone().lerp(s.p, .5).add(new THREE.Vector3(rnd(-1, 1), 2.6, 3.2)); this.cool = 1.25; }
    this.slots.forEach((s, i) => {
      if (s.st === 0) { this.crates.set(i, s.p, this.q, _s.setScalar(.0001)); return; }
      if (s.st === 1) { s.u = Math.min(1, s.u + dt / 2.9); if (s.u < .08) this.ship.local(s.side * 5.6, -1.2, 2, s.a); const e = ease(s.u); s.pos = bez(s.a, s.b, s.p, e, s.pos || V()); s.rot = (1 - e) * (1.6 + i); s.sk = 1 - smooth(.5, .92, s.u); if (s.u >= 1) { s.st = 2; s.fl = 1; this.w.rings.emit({ p: s.p.clone(), n: new THREE.Vector3(0, 1, .4), r0: .4, r1: 1.7, life: .55, w: .1, w1: .01, col, k: 2 }); for (let k = 0; k < 7; k++) this.w.sprites.emit({ p: s.p.clone().add(new THREE.Vector3(rnd(-.5, .5), -.5, rnd(-.9, .9))), v: new THREE.Vector3(rnd(-1.4, 1.4), rnd(-.2, .7), rnd(-1.2, 1.2)), life: rnd(.3, .6), size: .1, size1: .34, shape: SHAPE.puff, col: WHITE, k: .55, drag: 3 }); } }
      s.fl = Math.max(0, s.fl - dt * 2.4); let p = s.st === 1 ? s.pos : s.p, sc = this.s, z = 0; if (s.st === 3) { const k = ease((this.hold - 1.2 - i * .09) / .7); p = _v.copy(s.p).addScaledVector(_w.set(-.45, .35, -1), k * 4); sc = this.s * (1 - k); if (k > 0 && k < .12) s.fl = 1; }
      _q.setFromAxisAngle(_w.set(.4, .8, .2).normalize(), s.st === 1 ? s.rot * .8 : 0); this.crates.set(i, p, _q, _s.setScalar(sc)); this.crates.look(i, col, s.sk, s.fl * .8);
    });
    const c = [this.cone, this.cone2]; flying.forEach((s, i) => { if (i > 1) return; const b = c[i]; b.mesh.visible = true; this.ship.local(0, 3.2, 2.65, b.u.uA.value); b.u.uB.value.copy(s.pos || s.p); b.u.uR1.value = 1.05; b.u.uAlpha.value = Math.min(1, s.u * 6) * Math.min(1, (1 - s.u) * 7); }); for (let i = flying.length; i < 2; i++) c[i].mesh.visible = false;
    if (flying[0]?.pos) { const l = flying[0].pos.clone().sub(this.ship.p).applyQuaternion(this.ship.q.clone().invert()); const want = Math.atan2(l.x, l.z); let d = want - this.aim; d = Math.atan2(Math.sin(d), Math.cos(d)); this.aim += d * (1 - Math.exp(-dt * 4)); } else this.aim += dt * .3 * this.k;
    this.ship.model.rig('turret', (n) => { n.rotation.y = this.aim; });
    this.progress = this.slots.filter((s) => s.st >= 2).length / 12;
    if (this.next >= 12 && !flying.length) { this.hold += dt; if (this.hold < dt * 1.5) { this.w.rings.emit({ p: this.center.clone(), n: new THREE.Vector3(.3, .4, 1), r0: 1, r1: 6, life: 1.3, w: .05, col, k: 2.2 }); this.w.stationPulse(this.center, col); } if (this.hold > 1.2) this.slots.forEach((s) => { s.st = 3; }); if (this.hold > 3.6) { this.slots.forEach((s) => { s.st = 0; s.u = 0; s.sk = 1; }); this.next = 0; this.hold = 0; } }
  }
  shots() { return [
    { key: 'stack', T: 9, cam: (t, u, o) => { const a = .95 - u * .9; o.pos.copy(this.center).add(_v.set(Math.sin(a) * 11, -3.4 + u * 4.2, 9.6)); o.tgt.copy(this.center).add(_v.set(0, -1.2, 0)); o.fov = 44; } },
    { key: 'hull', T: 8, cam: (t, u, o) => { this.ship.local(-18 + u * 7, 6.5 + u * 2, 22 - u * 3, o.pos); this.ship.local(0, 0, 2 - u * 3, o.tgt); o.fov = 42; } },
    { key: 'beam', T: 8, cam: (t, u, o) => { this.ship.local(5.5 - u * 2, 8.5, -15 + u * 3, o.pos); o.tgt.copy(this.center).lerp(this.ship.p, .25); o.fov = 50; } },
  ]; }
}

// ---------------------------------------------------------------- Kimi：引力环把深空飘来的书页吸进来，凝成一束光交给空间站
class Read extends Work {
  constructor(w, ship) {
    super(w, ship); this.pages = new Pages(64); this.group.add(this.pages.mesh); this.pages.u.uTint.value.set(ship.def.hot); this.list = Array.from({ length: 64 }, (_, i) => ({ t: -i / 64 * 6.5, side: i % 2 ? 1 : -1, seed: Math.random(), T: rnd(5.5, 7.5) })); this.gs = [this.pages.u]; this.beam = new Beam(); this.group.add(this.beam.mesh); this.beam.u.uCol.value.set(ship.def.hot); this.beam.u.uMode.value = 0; this.beam.u.uDash.value = 7; this.beam.u.uW.value = .07; this.charge = 0; this.spin = 0; this.center = V(); this.tip = new THREE.Vector3(12.15, 12.2, 0);
  }
  pose(t) { return { p: new THREE.Vector3(5.0, 17.0, 5.4), f: new THREE.Vector3(.30, -.10, .95).normalize(), roll: Math.sin(t * .4) * .08 }; }
  focus() { return { target: this.ship.p.clone().add(new THREE.Vector3(-.5, .9, -.6)), dist: 20, az: 30, el: 11, dir: DIR }; }
  update(dt, t) {
    this.center.copy(this.ship.p); this.spin += dt * (1 + this.k * 9); this.ship.model.rig('gravL', (n) => { n.rotation.x = this.spin; }); this.ship.model.rig('gravR', (n) => { n.rotation.x = -this.spin; });
    let n = 0; const A = this.pages.m, D = this.pages.d; const from = _w.set(-38, 13, -46);
    for (const g of this.list) {
      if (this.ready || (g.t > .05 && g.t < 1)) g.t += dt / g.T; else if (g.t < .05) g.t = -g.seed; if (g.t > 1) { g.t = -g.seed * .12; this.charge = Math.min(1, this.charge + .03); if (this.k > .3) { const p = this.ship.local(g.side * 4.7, -.45, -.85, V()); this.w.sprites.emit({ p, life: .28, size: .12, size1: .42, shape: SHAPE.kimi, col: this.ship.hot, k: 2, rot: rnd(0, 2) }); } }
      if (g.t <= 0) continue; const u = g.t, e = u * u * (1.6 - .6 * u); const pod = this.ship.local(g.side * 4.75, -.45, -.85, V()); const p = from.clone().lerp(pod, Math.min(1, e)); const dir = pod.clone().sub(from).normalize(); const a = u * 13 + g.seed * 6.28; const r = (1 - e) * (2.2 + g.seed * 5) * smooth(0, .2, u) + .5 * (1 - smooth(.8, 1, u)); const r1 = _v.crossVectors(dir, UP).normalize().clone(), r2 = r1.clone().cross(dir); p.addScaledVector(r1, Math.cos(a) * r).addScaledVector(r2, Math.sin(a) * r);
      const s = (.26 + g.seed * .20) * smooth(0, .12, u) * (1 - smooth(.93, 1, u) * .9); _q.setFromEuler(new THREE.Euler(a * .7 + g.seed * 5, a * .5, g.seed * 6 + u * 3)); _m.compose(p, _q, _s.setScalar(s * 2.0)); A.array.set(_m.elements, n * 16); D.setXYZW(n, g.seed, 1, smooth(.86, 1, u), this.ready ? 1 : Math.max(0, this.k * 1.4)); n++;
    }
    this.pages.g.instanceCount = n; A.needsUpdate = D.needsUpdate = true; this.progress = this.charge;
    // 凝成的光沿天线塔送进空间站
    const src = this.ship.local(0, -1.6, 2.4, V()); this.beam.mesh.visible = this.k > .05; this.beam.set(src, src.clone().add(_v.set(2.5, 1.2, 1.5)), this.tip.clone().add(_v.set(.6, 2.2, 1.2)), this.tip); this.beam.u.uAlpha.value = this.k * .9; this.beam.u.uFlow.value = 1.6;
    if (this.charge >= 1) { this.charge = 0; const b = this.beam; this.w.sprites.emit({ p: src, life: 1.1, size: .34, stretch: .06, shape: SHAPE.kimi, spin: 6, col: this.ship.hot, k: 3, fade: () => 1, fn: (it, d2, u) => { b.at(ease(u), it.p); }, done: () => { this.w.rings.emit({ p: this.tip, n: new THREE.Vector3(1, 1, .3), r0: .2, r1: 3, life: .9, w: .08, col: this.ship.color, k: 2.2 }); this.w.stationPulse(this.tip, this.ship.color); } }); }
  }
  shots() { return [
    { key: 'pages', T: 9, cam: (t, u, o) => { this.ship.local(23 - u * 5, 6.5, 15 - u * 4, o.pos); this.ship.local(.5, 1.2, -1.2, o.tgt); o.fov = 44; } },
    { key: 'cockpit', T: 8, cam: (t, u, o) => { this.ship.local(9 - u * 6, 5.2, 25 - u * 3, o.pos); this.ship.local(0, .7, .6, o.tgt); o.fov = 38; } },
    { key: 'ring', T: 8, cam: (t, u, o) => { this.ship.local(17.5, 1.2 + u * 2, -9 + u * 6, o.pos); this.ship.local(3.6, 0, -.8, o.tgt); o.fov = 36; } },
  ]; }
}

// ---------------------------------------------------------------- OpenCode：线框方块穿过门，出来就是实物
class Forge extends Work {
  constructor(w, ship) { super(w, ship); this.N = 9; this.crates = new Swarm(w.packs.crate, 9); this.tiles = new Swarm(w.packs.tile, 9); this.group.add(this.crates.mesh, this.tiles.mesh); this.crates.uniforms.uShadowSel.value = this.tiles.uniforms.uShadowSel.value = -1; this.b = Array.from({ length: 9 }, (_, i) => ({ u: -i / 9, kind: i % 3 === 1, fl: 0, seed: Math.random() * 6 })); this.center = V(); this.pulse = 0; this.made = 0; this.gs = [this.crates.uniforms, this.tiles.uniforms]; }
  pose(t) { return { p: new THREE.Vector3(9.4, -1.6, 11.4), f: new THREE.Vector3(-.52, .0, .85).normalize() }; }
  focus() { return { target: this.ship.p.clone().add(new THREE.Vector3(-.2, .1, -.2)), dist: 23, az: 16, el: 13, dir: DIR }; }
  update(dt, t) {
    this.center.copy(this.ship.p); this.pulse = Math.max(0, this.pulse - dt * 1.6); this.ship.u.uPortal.value = this.k * (.35 + .12 * Math.sin(t * 4)) + this.pulse * 1.2; const lat = _v.set(1, 0, 0).applyQuaternion(this.ship.q).clone(); if (lat.x > 0) lat.negate(); const c = this.ship.local(0, 0, -.5, V()); const dock = polar(8.4, -6, 4.3);
    this.b.forEach((b, i) => {
      const sw = b.kind ? this.tiles : this.crates, ot = b.kind ? this.crates : this.tiles; ot.set(i, c, this.ship.q, _s.setScalar(.0001)); const prev = b.u; if (this.ready || b.u > 0) b.u += dt / 9.5; if (b.u > 1) { b.u = 0; b.kind = Math.random() < .4; this.made++; } if (b.u <= 0) { sw.set(i, c, this.ship.q, _s.setScalar(.0001)); return; }
      const x = (b.u / .56 - 1) * 11; const p = V(); if (b.u < .68) { p.copy(c).addScaledVector(lat, x).addScaledVector(UP, Math.sin(b.u * 7 + b.seed) * .35 * (1 - smooth(.35, .56, b.u))); } else { const s0 = c.clone().addScaledVector(lat, (.68 / .56 - 1) * 11); bez(s0, s0.clone().addScaledVector(lat, 3), dock, ease((b.u - .68) / .32), p); }
      const pass = smooth(.535, .585, b.u); if (prev < .56 && b.u >= .56) { b.fl = 1; this.pulse = 1; const qn = lat.clone(); this.w.rings.emit({ p: c.clone(), n: qn, r0: .5, r1: 2.1, life: .7, w: .12, w1: .02, dash: 4, spin: 1, col: this.ship.color, k: 2.4 }); for (let k = 0; k < 10; k++) this.w.sprites.emit({ p: p.clone(), v: lat.clone().multiplyScalar(rnd(.5, 2.5)).add(new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1))), life: rnd(.4, .9), size: rnd(.04, .1), shape: SHAPE.opencode, spin: rnd(-4, 4), col: this.ship.hot, k: 2, drag: 1.6 }); }
      b.fl = Math.max(0, b.fl - dt * 1.8); const k = smooth(.97, 1, b.u); _q.setFromEuler(new THREE.Euler(b.seed + t * .5 * (1 - pass), b.seed * 2 + t * .35, b.seed)); const tq = this.ship.q.clone(); _q.slerp(tq, pass); sw.set(i, p, _q, _s.setScalar((b.kind ? .72 : .58) * smooth(0, .07, b.u) * (1 - k))); sw.look(i, this.ship.color, 1 - pass, b.fl * .9); if (prev < .985 && b.u >= .985) { this.w.rings.emit({ p: dock, n: new THREE.Vector3(-.4, 0, 1), r0: .3, r1: 1.6, life: .6, w: .1, col: this.ship.color, k: 1.8 }); this.w.stationPulse(dock, this.ship.color, .5); }
    }); this.progress = (this.made % 9) / 9;
  }
  shots() { return [
    { key: 'gate', T: 9, cam: (t, u, o) => { this.ship.local(-21 + u * 5, 6 - u * 2.5, 18 - u * 3, o.pos); this.ship.local(0, 0, -.8, o.tgt); o.fov = 42; } },
    { key: 'through', T: 8, cam: (t, u, o) => { this.ship.local(-17 + u * 2, 3.6, -8 + u * 3, o.pos); this.ship.local(1, 0, -.4, o.tgt); o.fov = 44; } },
    { key: 'stern', T: 8, cam: (t, u, o) => { this.ship.local(20 - u * 5, 10, -33 + u * 3, o.pos); this.ship.local(0, 0, -2, o.tgt); o.fov = 38; } },
  ]; }
}

// ---------------------------------------------------------------- OpenClaw：钳住漂来的碎石，拖到枢纽里化成光
class Salvage extends Work {
  constructor(w, ship) {
    super(w, ship); this.rocks = new Swarm(w.packs.rock, 7); this.group.add(this.rocks.mesh); this.rocks.uniforms.uShadowSel.value = -1; this.r = Array.from({ length: 7 }, (_, i) => ({ home: new THREE.Vector3(-9.5 + i * 1.9 + rnd(-.5, .5), -16.6 + (i % 3) * 1.5 + rnd(-.4, .4), 10.5 + (i % 2) * 3.2 + rnd(-.8, .8)), p: V(), s: rnd(.55, .95), seed: rnd(0, 6), st: 0, k: 1, spin: rnd(-.3, .3), a: 0 })); this.r.forEach((r) => r.p.copy(r.home)); this.gs = [this.rocks.uniforms]; this.ph = 'idle'; this.t = 0; this.cur = 0; this.open = .1; this.P = new THREE.Vector3(-4.5, -13.4, 11); this.F = new THREE.Vector3(.3, .5, -.8).normalize(); this.center = V(); this.hub = new THREE.Vector3(0, 0, 0); this.A = V(); this.B = V();
  }
  pose(t) { return { p: this.P.clone(), f: this.F.clone(), turn: 3, thrust: this.ph === 'tow' ? .35 : 0 }; }
  focus() { return { target: this.ship.p.clone().addScaledVector(this.F, -.9), dist: 19, az: 26, el: 24, dir: DIR }; }
  update(dt, t) {
    this.center.copy(this.ship.p); this.t += dt; const r = this.r[this.cur]; const L = 3.0; let want = .12;
    if (this.ready || this.ph !== 'idle') {
      if (this.ph === 'idle') { if (this.ready) { this.ph = 'go'; this.t = 0; this.A.copy(this.P); } }
      else if (this.ph === 'go') { const f = this.hub.clone().add(_v.set(0, 0, 4)).sub(r.p).normalize(); this.F.lerp(f, 1 - Math.exp(-dt * 1.6)).normalize(); const e = ease(this.t / 3.2); this.P.copy(this.A).lerp(_v.copy(r.p).addScaledVector(f, L), e); want = .42 * smooth(1.2, 2.4, this.t); if (this.t > 3.4) { this.ph = 'grip'; this.t = 0; } }
      else if (this.ph === 'grip') { want = .42 - .62 * ease(this.t / .8); if (this.t > .85 && !r.held) { r.held = true; this.w.rings.emit({ p: r.p, n: this.F, r0: .4, r1: 1.9, life: .5, w: .1, col: this.ship.color, k: 2 }); for (let k = 0; k < 12; k++) this.w.sprites.emit({ p: r.p.clone().add(new THREE.Vector3(rnd(-.8, .8), rnd(-.4, .4), rnd(-.8, .8))), v: new THREE.Vector3(rnd(-1.5, 1.5), rnd(-1, 1), rnd(-1.5, 1.5)), life: rnd(.4, .9), size: .05, shape: SHAPE.spark, stretch: .06, col: AMBER, k: 2.4, drag: 1.5 }); } if (this.t > 1.2) { this.ph = 'tow'; this.t = 0; this.A.copy(this.P); this.B.copy(DIR).multiplyScalar(14.5); this.B.y = -5.4; this.B.x -= rnd(2.2, 3.2); } }
      else if (this.ph === 'tow') { want = -.2; const e = ease(this.t / 4.2); this.P.copy(this.A).lerp(this.B, e); const f = _v.copy(this.hub).sub(this.P).normalize(); this.F.lerp(f, 1 - Math.exp(-dt * 1.3)).normalize(); if (this.t > 4.3) { this.ph = 'drop'; this.t = 0; this.A.copy(this.P); r.held = false; r.st = 2; r.v = this.F.clone().multiplyScalar(2.4); } }
      else if (this.ph === 'drop') { want = .42 * (1 - smooth(1.2, 2, this.t)); const e = ease(this.t / 2.2); this.P.copy(this.A).addScaledVector(_v.set(-.8, -.5, .3), e * 4.6); if (this.t > 2.3) { this.ph = 'idle'; this.t = 0; this.cur = (this.cur + 1) % 7; } }
    }
    this.open += (want - this.open) * (1 - Math.exp(-dt * 7)); this.ship.model.rig('clawL', (n) => { n.rotation.y = -this.open; }); this.ship.model.rig('clawR', (n) => { n.rotation.y = this.open; });
    this.r.forEach((r, i) => {
      r.a += r.spin * dt; if (r.held) { r.p.lerp(this.ship.local(0, .2, -8.2, V()), 1 - Math.exp(-dt * 12)); } else if (r.st === 2) { _w.copy(this.hub).sub(r.p); const d = _w.length(); r.v.addScaledVector(_w.normalize(), dt * 7).multiplyScalar(1 - dt * .5); r.p.addScaledVector(r.v, dt); r.a += dt * 3; if (d < 1.5 || r.p.z < .4) { r.st = 3; r.k = 0; this.w.portalPulse(this.ship.color); for (let k = 0; k < 34; k++) { const an = rnd(0, 6.28); this.w.sprites.emit({ p: r.p.clone(), v: new THREE.Vector3(Math.cos(an) * rnd(1, 5), Math.sin(an) * rnd(1, 5), rnd(-.5, 1.5)), life: rnd(.6, 1.4), size: rnd(.05, .14), shape: SHAPE.openclaw, spin: rnd(-5, 5), col: this.ship.hot, k: 2.4, drag: 2.2 }); } this.w.stationPulse(this.hub, this.ship.color); } }
      else if (r.st === 3) { r.wait = (r.wait || 0) + dt; if (r.wait > 3) { r.wait = 0; r.st = 0; r.p.copy(r.home).add(_v.set(-14, -6, 6)); } }
      else { r.p.lerp(_v.copy(r.home).add(_w.set(Math.sin(t * .3 + r.seed) * .5, Math.cos(t * .4 + r.seed) * .4, 0)), 1 - Math.exp(-dt * .6)); r.k += (this.k - r.k) * (1 - Math.exp(-dt * 1.5)); }
      _q.setFromEuler(new THREE.Euler(r.a + r.seed, r.a * .7, r.seed)); this.rocks.set(i, r.p, _q, _s.setScalar(r.s * r.k + .0001)); this.rocks.look(i, this.ship.color, 0, 0);
    }); this.progress = ({ idle: 0, go: .2, grip: .45, tow: .7, drop: 1 })[this.ph];
  }
  shots() { return [
    { key: 'grip', T: 9, cam: (t, u, o) => { this.ship.local(-19 + u * 9, 13 - u * 4, -24 + u * 2, o.pos); this.ship.local(0, -.4, -4.8, o.tgt); o.fov = 42; } },
    { key: 'bow', T: 8, cam: (t, u, o) => { this.ship.local(15 - u * 20, 9, 25, o.pos); this.ship.local(0, 0, -2, o.tgt); o.fov = 40; } },
    { key: 'top', T: 8, cam: (t, u, o) => { this.ship.local(6 - u * 9, 27, -15 + u * 3, o.pos); this.ship.local(0, 0, -3.4, o.tgt); o.fov = 42; } },
  ]; }
}

// ---------------------------------------------------------------- Pi：三色光带高速绕站巡查，飞过哪里哪里的灯就亮
class Patrol extends Work {
  constructor(w, ship) { super(w, ship); this.tr = [[1.4, 0, -8.2], [4.2, 0, 8.4], [-4.1, 0, 8.6]].map((l, i) => { const x = new Trail(96, ship.def.tri?.[i] || ship.def.hot, .085); this.group.add(x.mesh); return { x, l }; }); this.trails = this.tr.map((q) => q.x); this.a = 0; this.sp = 0; this.center = V(); this.next = 0; }
  at(a, o = V()) { return home(Math.cos(a) * 12.2, 7.6 * Math.sin(a * 2 - 1.2) + 2.8, Math.sin(a) * 16.8, o); }
  pose(t) { const p = this.at(this.a), f = this.at(this.a + .04).sub(p).normalize(); return { p, f, turn: 8, thrust: .5 }; }
  focus() { return { target: this.ship.p, dist: 13, az: 30, el: 16, chase: [5.2, 2.6, 11.5] }; }
  update(dt, t) {
    this.center.copy(this.ship.p); const want = this.ready ? .62 : this.active ? .3 : .12; this.sp += (want - this.sp) * (1 - Math.exp(-dt * 1.2)); this.a += dt * this.sp;
    const al = Math.max(0, Math.min(1, (this.ship.v.length() - 1.2) / 3)); this.tr.forEach(({ x, l }) => { x.u.uAlpha.value += (al * 1.15 * (this.ship.mode === 'work' ? 1 : .55) - x.u.uAlpha.value) * (1 - Math.exp(-dt * 3)); x.push(this.ship.local(...l, _v), dt, .022); });
    if (this.ready && t > this.next) { this.next = t + 1.15; const d = this.ship.p.clone(); const rr = Math.hypot(d.x, d.y) || 1; const hit = new THREE.Vector3(d.x / rr * 8.6, d.y / rr * 8.6, Math.sign(d.z) * 3.6); const c = new THREE.Color(this.ship.def.tri[(Math.random() * 3) | 0]); this.w.rings.emit({ p: hit, n: new THREE.Vector3(hit.x * .1, hit.y * .1, Math.sign(d.z)), r0: .3, r1: 2.6, life: .9, w: .08, w1: .01, dash: 6, spin: .5, col: c, k: 2 }); this.w.sprites.emit({ p: d, life: .5, size: .13, stretch: .05, shape: SHAPE.pi, col: c, k: 2.4, fn: (it, dd, u) => { it.p.copy(d).lerp(hit, ease(u)); } }); this.w.stationPulse(hit, c, .35); }
    this.progress = (this.a / 6.28) % 1;
  }
  shots() { return [
    { key: 'chase', T: 8, cam: (t, u, o) => { this.ship.local(17 - u * 9, 10, 31, o.pos); this.ship.local(0, 0, -5, o.tgt); o.fov = 46; o.roll = this.ship.roll * .4; o.soft = 9; } },
    { key: 'flyby', T: 8, cam: (t, u, o) => { home(3 - u * 5, 2, 31, o.pos); o.tgt.copy(this.ship.p).multiplyScalar(.75); o.fov = 44; o.soft = 4; } },
  ]; }
}

// ---------------------------------------------------------------- DeepSeek：像鲸一样在站下深潜，一圈圈声呐扫过海面，把发现带上来
class Dive extends Work {
  constructor(w, ship) { super(w, ship); this.next = 0; this.up = 0; this.center = V(); this.spin = 0; this.found = 0; }
  at(t, o = V()) { return home(-2.6 + 6.2 * Math.sin(t * .21), -19.4 - 2.6 * Math.sin(t * .16 + 1), -8.5 + 4.6 * Math.cos(t * .21), o); }
  pose(t) { const p = this.at(t), f = this.at(t + .5).sub(p).normalize(); f.y += -.10 + Math.sin(t * .5) * .10; return { p, f: f.normalize(), roll: Math.sin(t * .42) * .16, turn: 1.4 }; }
  focus() { return { target: this.ship.p, dist: 21, az: -34, el: 24, dir: DIR }; }
  update(dt, t) {
    this.center.copy(this.ship.p); this.spin += dt * (1.2 + this.k * 7); this.ship.model.rig('turbL', (n) => { n.rotation.x = this.spin; }); this.ship.model.rig('turbR', (n) => { n.rotation.x = -this.spin; });
    const sw = Math.sin(t * 1.9) * (.07 + .07 * this.k); this.ship.model.rig('tailL', (n) => { n.rotation.z = sw; n.rotation.x = sw * .6; }); this.ship.model.rig('tailR', (n) => { n.rotation.z = -sw; n.rotation.x = sw * .6; });
    if (this.ready && t > this.next) { this.next = t + 2.3; for (let i = 0; i < 4; i++) this.w.rings.emit({ p: this.ship.local(0, -2.2, 5, V()).add(_v.set(0, -.6, 0)), n: new THREE.Vector3(0, 1, 0), r0: .3, r1: 9.5, life: 3.0, age: -i * .26, w: .022, w1: .004, col: this.ship.color, k: 1.5, a: .9, ease: (u) => 1 - Math.pow(1 - u, 1.8) }); this.w.light(this.ship.local(0, -3, 5, _w), this.ship.hot, 7, 1); }
    if (this.ready && t > this.up) { this.up = t + rnd(.5, 1.1); const a = this.ship.local(rnd(-12, 12), -26, rnd(-4, 22), V()); const ship = this.ship; this.w.sprites.emit({ p: a, life: rnd(1.5, 2.2), size: rnd(.08, .16), shape: SHAPE.deepseek, col: ship.hot, k: 2, fn: (it, d, u) => { it.p.copy(a).lerp(ship.local(0, -1.6, 8.6, _w), ease(u)); it.p.x += Math.sin(u * 9 + a.x) * .4 * (1 - u); }, done: () => { this.found = Math.min(1, this.found + .05); this.w.sprites.emit({ p: ship.local(0, -1.6, 9, _w), life: .3, size: .1, size1: .4, shape: SHAPE.deepseek, col: ship.color, k: 1.6 }); } }); }
    if (this.found >= 1) { this.found = 0; const [a, b, c, d] = this.w.hubPath(this.ship.p.clone(), new THREE.Vector3(0, 0, -.6)); this.w.shot(a, b, c, d, { T: .9, col: this.ship.hot, shape: SHAPE.deepseek, size: .34, w: .07, done: () => { this.w.portalPulse(this.ship.color); this.w.stationPulse(d, this.ship.color); } }); }
    this.progress = this.found;
  }
  shots() { return [
    { key: 'dive', T: 9, cam: (t, u, o) => { this.ship.local(19 - u * 6, 10, 23 - u * 2, o.pos); this.ship.local(0, -.6, 0, o.tgt); o.fov = 42; } },
    { key: 'sonar', T: 9, cam: (t, u, o) => { o.pos.copy(this.ship.p).add(_v.set(-9 + u * 7, 9.0, -14.5)); o.tgt.copy(this.ship.p).add(_w.set(0, -1.6, 1)); o.fov = 44; o.soft = 5; } },
    { key: 'tail', T: 8, cam: (t, u, o) => { this.ship.local(11 - u * 6, 8, -27 + u * 2, o.pos); this.ship.local(0, 1, 2, o.tgt); o.fov = 40; } },
  ]; }
}
// ---------------------------------------------------------------- Hermes：扇着刻满铭文的翼，在各舰之间送信，拖出金色航迹
class Courier extends Work {
  constructor(w, ship) { super(w, ship); this.trails = [[8.6, 0, -5], [-8.6, 0, -5]].map((l) => { const x = new Trail(120, ship.def.hot, .055); x.l = l; this.group.add(x.mesh); return x; }); this.t = 0; this.to = null; this.A = V(); this.center = V(); this.P = ship.p.clone(); this.F = new THREE.Vector3(0, 0, 1); this.fl = 0; this.n = 0; }
  pose() { return { p: this.P.clone(), f: this.F.clone(), turn: 4, thrust: .35 }; }
  focus() { return { target: this.ship.p, dist: 21, az: 24, el: 14, chase: [12, 7, 21] }; }
  update(dt, t) {
    this.center.copy(this.ship.p); const sp = this.ship.v.length(); this.fl += dt * (1.2 + sp * .22); const a = Math.sin(this.fl * 2.1) * (.05 + Math.min(.12, sp * .014)) + .03; this.ship.model.rig('wingL', (n) => { n.rotation.z = a; }); this.ship.model.rig('wingR', (n) => { n.rotation.z = -a; });
    if (!this.active) { this.P.copy(this.ship.p); this.F.copy(this.ship.f); this.to = null; this.t = 0; }
    else if (this.ship.mode === 'work') {
      this.t += dt; const T = 4.6;
      if (!this.to || this.t > T) { if (this.to) { const s = this.to; this.n++; this.w.sprites.emit({ p: this.ship.local(0, -.6, 8, V()), life: .8, size: .26, shape: SHAPE.hermes, spin: 5, col: this.ship.hot, k: 2.2, fade: () => 1, fn: ((p0) => (it, d, u) => { p0 = p0 || it.p.clone(); it.p.copy(p0).lerp(s.p, ease(u)); })(null), done: () => { if (!s.root) return; this.w.rings.emit({ p: s.p, n: UP, r0: .4, r1: s.radius * 1.1, life: .8, w: .07, w1: .01, col: this.ship.color, k: 2, follow: () => s.p }); s.flash = Math.max(s.flash, .35); } }); } const o = this.w.ships.filter((s) => s !== this.ship && s !== this.to && s.key !== 'pi' && s.mode !== 'gate'); this.to = o[(Math.random() * o.length) | 0] || { p: V(), radius: 3 }; this.t = 0; this.A.copy(this.P); this.off = new THREE.Vector3(rnd(-2, 2), 3.2 + this.to.radius * .45, 4.2); this.side = Math.random() < .5 ? -1 : 1; }
      const goal = _v.copy(this.to.p).add(this.off); const prev = _w.copy(this.P); const u = ease(this.t / (T * .86)); this.P.copy(this.A).lerp(goal, u); const arc = Math.sin(u * Math.PI); this.P.addScaledVector(DIR, arc * 6.5); this.P.x += this.side * arc * 3.2; this.P.y += arc * 1.6; const d = this.P.clone().sub(prev); if (d.lengthSq() > 2e-5) this.F.lerp(d.normalize(), 1 - Math.exp(-dt * 3.2)).normalize();
    }
    const al = Math.min(1, Math.max(0, (sp - .8) / 3)) * this.k; this.trails.forEach((x) => { x.u.uAlpha.value += (al * .95 - x.u.uAlpha.value) * (1 - Math.exp(-dt * 3)); x.push(this.ship.local(...x.l, _s), dt, .016); }); if (al > .3 && Math.random() < dt * 14) this.w.sprites.emit({ p: this.ship.local(rnd(-8, 8), 0, -8, V()), life: rnd(.6, 1.3), size: rnd(.03, .07), shape: SHAPE.hermes, spin: rnd(-3, 3), col: this.ship.hot, k: 1.8 }); this.progress = (this.n % 8) / 8;
  }
  shots() { return [
    { key: 'glide', T: 8, cam: (t, u, o) => { this.ship.local(21 - u * 9, 10, 29, o.pos); this.ship.local(0, 0, -1, o.tgt); o.fov = 44; o.soft = 7; } },
    { key: 'wing', T: 8, cam: (t, u, o) => { this.ship.local(-24 + u * 4, 13 - u * 3, 9 - u * 10, o.pos); this.ship.local(3, 0, 0, o.tgt); o.fov = 42; o.soft = 7; } },
    { key: 'above', T: 8, cam: (t, u, o) => { this.ship.local(9 - u * 14, 30, 6, o.pos); this.ship.local(0, 0, 0, o.tgt); o.fov = 40; o.soft = 6; } },
  ]; }
}
export const WORKS = { claude: Build, codex: Haul, kimi: Read, opencode: Forge, openclaw: Salvage, pi: Patrol, deepseek: Dive, hermes: Courier };
