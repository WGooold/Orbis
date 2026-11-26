// 机位：舰队总览 ↔ 单舰特写（横滑轮播）↔ 分镜漫画
import * as THREE from 'three';
import { V, DIR, ease, smooth } from './ship.js';

const D = Math.PI / 180; const _a = V(), _b = V(), _c = V(), _d = V(); const rnd = (a, b) => a + Math.random() * (b - a);
const newPose = () => ({ pos: V(), tgt: V(), fov: 46, lift: 0, roll: 0, side: 0 });
function slerpDir(a, b, t, out) { const la = a.length(), lb = b.length(); const d = THREE.MathUtils.clamp(a.dot(b) / (la * lb || 1), -1, 1); const th = Math.acos(d); if (th < .001) out.copy(a).lerp(b, t).normalize(); else { const s = Math.sin(th); out.set(0, 0, 0).addScaledVector(a, Math.sin((1 - t) * th) / s / la).addScaledVector(b, Math.sin(t * th) / s / lb); if (th > 3.1) out.y += .3 * Math.sin(t * Math.PI); out.normalize(); } return out.multiplyScalar(la + (lb - la) * t); }
export function mixPose(A, B, t, o, bump = 0) { o.tgt.copy(A.tgt).lerp(B.tgt, t); _a.copy(A.pos).sub(A.tgt); _b.copy(B.pos).sub(B.tgt); slerpDir(_a, _b, t, _c); o.pos.copy(o.tgt).add(_c.multiplyScalar(1 + bump * Math.sin(t * Math.PI))); o.fov = A.fov + (B.fov - A.fov) * t; o.lift = A.lift + (B.lift - A.lift) * t; o.roll = A.roll + (B.roll - A.roll) * t; o.side = (A.side || 0) + ((B.side || 0) - (A.side || 0)) * t; return o; }

export class Lens {
  constructor() { this.cam = new THREE.PerspectiveCamera(46, 1, .25, 900); this.cam.userData.lens = this; this.pos = new THREE.Vector3(0, 10, 70); this.tgt = V(); this.fov = 46; this.lift = 0; this.roll = 0; this.side = 0; this.h = 800; this.shake = 0; this.speed = 0; }
  snap(p) { this.pos.copy(p.pos); this.tgt.copy(p.tgt); this.fov = p.fov; this.lift = p.lift || 0; this.roll = p.roll || 0; this.side = p.side || 0; }
  follow(p, dt, k) { const e = k === Infinity ? 1 : 1 - Math.exp(-dt * k); _d.copy(this.pos); this.pos.lerp(p.pos, e); this.tgt.lerp(p.tgt, e); this.fov += (p.fov - this.fov) * e; this.lift += ((p.lift || 0) - this.lift) * e; this.roll += ((p.roll || 0) - this.roll) * e; this.side += ((p.side || 0) - this.side) * e; this.speed = _d.distanceTo(this.pos) / Math.max(dt, .001); }
  apply(aspect, t) {
    const c = this.cam; let f = this.fov; c.aspect = aspect; const ref = this.shot ? .75 : .46; if (aspect < ref) f = 2 * Math.atan(Math.tan(f * D / 2) * Math.pow(ref / aspect, this.shot ? .62 : .75)) / D; else if (aspect > .75) f = 2 * Math.atan(Math.tan(f * D / 2) * Math.pow(.75 / aspect, .42)) / D; c.fov = Math.min(f, 84); c.position.copy(this.pos); if (this.rig) { const r = this.rig; _a.copy(this.pos).sub(this.tgt); const L = _a.length(); _b.set(_a.z, 0, -_a.x).normalize(); c.position.addScaledVector(_b, r.px * L * .035); c.position.y += r.py * L * .028; }
    if (this.shake > .001) { c.position.x += (Math.sin(t * 61) + Math.sin(t * 37)) * .05 * this.shake; c.position.y += (Math.cos(t * 53) + Math.sin(t * 71)) * .05 * this.shake; }
    c.up.set(Math.sin(this.roll), Math.cos(this.roll), 0); if (this.roll === 0) c.up.set(0, 1, 0); c.lookAt(this.tgt); c.updateProjectionMatrix(); if (this.lift || this.side) { c.projectionMatrix.elements[9] -= this.lift; c.projectionMatrix.elements[8] -= this.side; c.projectionMatrixInverse.copy(c.projectionMatrix).invert(); } c.updateMatrixWorld();
  }
}

export class Rig {
  constructor(world) { this.w = world; this.lens = new Lens(); this.lens.rig = this; this.px = this.py = 0; this.yaw = 18; this.pitch = 21; this.dist = 72; this.vy = 0; this.vp = 0; this.m = 0; this.mTarget = 0; this.u = 0; this.uTarget = 0; this.orbit = 0; this.ov = 0; this.zoom = 1; this.k = 9; this.fleet = newPose(); this.focus = newPose(); this.A = newPose(); this.B = newPose(); this.out = newPose(); this.ty = -.5; this.free = 0; this.land = false; this.sheet = 0; this.drift = 0; this.maxDist = 120; }
  fleetPose(dt) { if (!this.held) { this.yaw += this.vy * dt; this.pitch += this.vp * dt; this.vy *= Math.exp(-dt * 2.2); this.vp *= Math.exp(-dt * 3); this.drift += (1 - this.drift) * (1 - Math.exp(-dt * .4)); this.yaw += dt * 1.5 * this.drift * Math.cos(this.w.t * .13); if (this.goHome) { const k = 1 - Math.exp(-dt * 2); let d = (18 - this.yaw) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; this.yaw += d * k; this.pitch += (21 - this.pitch) * k; this.dist += (72 - this.dist) * k; if (Math.abs(d) < .5) this.goHome = 0; } } else this.goHome = 0; this.pitch = THREE.MathUtils.clamp(this.pitch, -22, 72); const y = this.yaw * D, p = this.pitch * D; const F = this.fleet; F.tgt.set(0, this.ty, 0); const d = this.dist * (this.land ? 1.0 : 1); F.pos.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(d).add(F.tgt); F.fov = 46; F.lift = this.land ? .10 : .02; F.side = 0; F.roll = 0; return F; }
  shipPose(i, o) {
    const ships = this.w.ships; const s = ships[((i % ships.length) + ships.length) % ships.length]; let target = s.p, dist = s.radius * 5.7, az = -32, el = 13, base = null;
    if (s.mode === 'work' && s.state === 'run') { const f = s.work.focus(); target = f.target; dist = f.dist; az = f.az ?? az; el = f.el ?? el; base = f.dir; if (f.chase) { const [x, y, z] = f.chase; const k = s.def.scale; s.local(x / k * this.zoom, y / k * this.zoom, z / k * this.zoom, o.pos); s.local(0, 0, -1.2 / k, o.tgt); o.fov = 42; o.lift = this.land ? 0 : .26 + this.sheet * .24; o.roll = 0; o.side = this.land ? -.34 : 0; return o; } }
    if (s.mode === 'gate') { _d.copy(s.p).addScaledVector(DIR, -2.6); _d.y += .2; target = _d; dist = 27; az = 42; el = 16; base = DIR; }
    const out = base ? _a.copy(base).setY(0) : _a.set(target.x, 0, target.z); if (out.length() < (base ? .1 : 5)) out.copy(DIR); out.normalize(); let y = Math.atan2(out.x, out.z) + (az + this.orbit) * D; const p = THREE.MathUtils.clamp(el + (this.oPitch || 0), -30, 70) * D;
    o.tgt.copy(target); o.pos.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(dist * this.zoom).add(target); o.fov = 42; o.lift = this.land ? 0 : .30 + this.sheet * .24; o.roll = 0; o.side = this.land ? -.34 : 0; if (this.land) { o.pos.sub(target).multiplyScalar(.82).add(target); } return o;
  }
  step(dt, t) {
    this.m += (this.mTarget - this.m) * (1 - Math.exp(-dt * (this.mHeld ? 40 : 4.2))); if (!this.uHeld) this.u += (this.uTarget - this.u) * (1 - Math.exp(-dt * 5.2)); if (!this.held) { this.orbit *= Math.exp(-dt * .7); this.oPitch = (this.oPitch || 0) * Math.exp(-dt * .7); }
    const F = this.fleetPose(dt); const i = Math.floor(this.u), f = this.u - i; this.shipPose(i, this.A); if (f > .0005) { this.shipPose(i + 1, this.B); mixPose(this.A, this.B, ease(f), this.focus, .55); } else Object.assign(this.focus, { fov: this.A.fov, lift: this.A.lift, roll: 0, side: this.A.side || 0 }), this.focus.pos.copy(this.A.pos), this.focus.tgt.copy(this.A.tgt);
    this.focus.roll = (f > .0005 ? Math.sin(f * Math.PI) * .10 : 0); if (this.cine) { const c = this.cine, q = t - c.t0; const w = smooth(0, .42, q) * (1 - smooth(c.T, c.T + .95, q)); if (q > c.T + 1) this.cine = null; else if (w > 0) { const C = this.C || (this.C = newPose()); const sp = c.ship.p; C.tgt.copy(sp).multiplyScalar(.5); const span = sp.length(); const d = Math.max(30, span * 1.75 + 14); _d.copy(DIR).multiplyScalar(.94); _d.y += .30; _d.x += (sp.x < 0 ? .18 : -.18); _d.normalize(); C.pos.copy(C.tgt).addScaledVector(_d, d); C.fov = 48; C.lift = this.land ? .08 : .30; C.roll = 0; C.side = this.land ? -.34 : 0; mixPose(this.focus, C, ease(w), this.focus2 || (this.focus2 = newPose()), .05); Object.assign(this.focus, { fov: this.focus2.fov, lift: this.focus2.lift, roll: this.focus2.roll, side: this.focus2.side }); this.focus.pos.copy(this.focus2.pos); this.focus.tgt.copy(this.focus2.tgt); } }
    const e = ease(this.m); mixPose(F, this.focus, e, this.out, .12 * (this.m > .02 && this.m < .98 ? 1 : 0)); this.lens.follow(this.out, dt, this.k);
    this.px = (this.px || 0) + ((this.par?.x || 0) - (this.px || 0)) * (1 - Math.exp(-dt * 3)); this.py = (this.py || 0) + ((this.par?.y || 0) - (this.py || 0)) * (1 - Math.exp(-dt * 3));
    this.rush = THREE.MathUtils.clamp((this.lens.speed - 26) / 60, 0, 1);
  }
}

// ---------------------------------------------------------------- 分镜导演
const P = (a) => a; // [[x,y]...] 0..1，y 向下
const PAGES = {
  portrait: [
    [P([[0, 0], [1, 0], [1, 1], [0, 1]])],
    [P([[0, 0], [1, 0], [1, .34], [0, .40]]), P([[0, .40], [.56, .366], [.49, 1], [0, 1]]), P([[.56, .366], [1, .34], [1, 1], [.49, 1]])],
    [P([[0, 0], [1, 0], [1, .55], [0, .46]]), P([[0, .46], [1, .55], [1, 1], [0, 1]])],
    [P([[0, 0], [.60, 0], [.52, .42], [0, .46]]), P([[.60, 0], [1, 0], [1, .385], [.52, .42]]), P([[0, .46], [1, .385], [1, .74], [0, .70]]), P([[0, .70], [1, .74], [1, 1], [0, 1]])],
    [P([[0, 0], [1, 0], [1, .64], [0, .70]]), P([[0, .70], [.46, .6724], [.54, 1], [0, 1]]), P([[.46, .6724], [1, .64], [1, 1], [.54, 1]])],
    [P([[0, 0], [1, 0], [1, .30], [0, .24]]), P([[0, .24], [1, .30], [1, .70], [0, .76]]), P([[0, .76], [1, .70], [1, 1], [0, 1]])],
  ],
  landscape: [
    [P([[0, 0], [1, 0], [1, 1], [0, 1]])],
    [P([[0, 0], [.36, 0], [.30, 1], [0, 1]]), P([[.36, 0], [.72, 0], [.68, 1], [.30, 1]]), P([[.72, 0], [1, 0], [1, 1], [.68, 1]])],
    [P([[0, 0], [.64, 0], [.57, 1], [0, 1]]), P([[.64, 0], [1, 0], [1, .48], [.6064, .48]]), P([[.6064, .48], [1, .48], [1, 1], [.57, 1]])],
    [P([[0, 0], [.46, 0], [.54, 1], [0, 1]]), P([[.46, 0], [1, 0], [1, 1], [.54, 1]])],
    [P([[0, 0], [.42, 0], [.40, .5], [0, .5]]), P([[0, .5], [.40, .5], [.38, 1], [0, 1]]), P([[.42, 0], [1, 0], [1, 1], [.38, 1]])],
  ],
};
export class Director {
  constructor(world) { this.w = world; this.page = null; this.old = null; this.n = 0; this.used = {}; this.lenses = Array.from({ length: 8 }, () => { const l = new Lens(); l.shot = true; return l; }); this.li = 0; this.land = false; this.turn = 1; }
  generic(first) { // first：从总览推进去，只用正面机位，不穿过站体
    const w = this.w, a0 = first ? 30 : [-6, 196, 30][this.n % 3]; return [
      { key: 'wide', T: 10, cam: (t, u, o) => { const y = (a0 + u * 24) * D, p = (7 + u * 10) * D; o.pos.set(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(this.land ? 60 : 67 - u * 5); o.tgt.set(0, -1.2, 0); o.fov = this.land ? 46 : 36; } },
      { key: 'low', T: 9, cam: (t, u, o) => { o.pos.set(-15 + u * 9, -12 + u * 2, 31 - u * 4); o.tgt.set(.5, 1.5, 0); o.fov = 46; } },
      { key: 'hub', T: 9, cam: (t, u, o) => { o.pos.set(Math.sin(u * 2) * 1.0, 1.1 - u * 1.0, 15.5 - u * 8.5); o.tgt.set(0, 0, -14); o.fov = 50; o.roll = u * .16; } },
      { key: 'rim', T: 9, cam: (t, u, o) => { const a = (158 - u * 30) * D; o.pos.set(Math.cos(a) * 15.5, Math.sin(a) * 15.5, 11.5); const b = a - .55; o.tgt.set(Math.cos(b) * 8.6, Math.sin(b) * 8.6, 0); o.fov = 44; } },
      { key: 'inner', T: 9, cam: (t, u, o) => { const a = (-30 - u * 30) * D; o.pos.set(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 6.4 - u * .8); const b = a + 2.3; o.tgt.set(Math.cos(b) * 5.4, Math.sin(b) * 5.4, -1.0); o.fov = 48; } },
    ];
  }
  gateShot(s) { return { key: 'gate', T: 9, ship: s, warn: true, cam: (t, u, o) => { const y = (48 - u * 14) * D; o.pos.set(Math.sin(y), .26 - u * .06, Math.cos(y)).multiplyScalar(13.5).addScaledVector(DIR, 17); o.tgt.copy(DIR).multiplyScalar(15.5); o.fov = 46; } }; }
  pick(avoid) {
    const w = this.w; const list = []; w.ships.forEach((s) => { if (s.state === 'run' && s.mode === 'work' && w.t - s.modeT > 2.5) s.work.shots().forEach((h) => list.push({ ...h, ship: s, id: s.key + h.key })); if (s.state === 'wait' && w.gate.k > .5 && this.want > 1) list.push({ ...this.gateShot(s), id: s.key + 'gate', must: 1 }); });
    const c = list.filter((h) => !avoid.some((a) => a.ship === h.ship)); if (!c.length) { const g = this.generic().filter((x) => !avoid.some((a) => a.key === x.key)); const x = g[(Math.random() * g.length) | 0]; return { ...x, id: 'g' + x.key }; }
    c.sort((a, b) => (b.must || 0) - (a.must || 0) || (this.used[a.id] || 0) - (this.used[b.id] || 0) || Math.random() - .5); return c[0];
  }
  make(layout, first) {
    const polys = PAGES[this.land ? 'landscape' : 'portrait'][layout]; this.want = polys.length; const shots = []; const gi = polys.length === 1 ? 0 : polys.length > 2 ? (Math.random() < .55 ? (Math.random() * polys.length) | 0 : -1) : -1;
    const panels = polys.map((poly, i) => { let sh; if (polys.length === 1 || i === gi) { const g = this.generic(first); sh = first ? g[0] : (polys.length === 1 && Math.random() < .55 ? this.pick(shots) : g[(Math.random() * g.length) | 0]); sh.id = sh.id || 'g' + sh.key; } else sh = this.pick(shots); shots.push(sh); this.used[sh.id] = ++this.n; const lens = this.lenses[this.li++ % 8]; return { poly, shot: sh, ship: sh.ship || null, lens, fresh: true }; });
    return { panels, t: 0, T: polys.length === 1 ? 8.5 : 10.5 + polys.length * .4, layout };
  }
  start(fromLens) { this.seq = 0; this.page = this.make(0, true); this.page.T = 7; this.old = null; this.turn = 1; const l = this.page.panels[0].lens; l.pos.copy(fromLens.pos); l.tgt.copy(fromLens.tgt); l.fov = 2 * Math.atan(Math.tan(fromLens.cam.fov * D / 2) / Math.pow(.75 / Math.max(.2, Math.min(.75, fromLens.cam.aspect)), .62)) / D; l.lift = fromLens.lift; l.roll = 0; this.page.panels[0].fresh = false; this.page.panels[0].k = .9; this.seq = 0; }
  next() { const n = PAGES[this.land ? 'landscape' : 'portrait'].length; const order = [1, 2, 0, 3, 4, 0, 5]; let l = order[this.seq++ % order.length] % n; const running = this.w.ships.filter((s) => s.state !== 'idle').length; if (l >= 3 && running < 3) l = 2; this.old = this.page; this.page = this.make(l); this.turn = 0; }
  step(dt, t) {
    if (!this.page) return; const pg = this.page; pg.t += dt; this.turn = Math.min(1, this.turn + dt / .95); if (this.turn >= 1) this.old = null; if (pg.t > pg.T) this.next();
    for (const g of [this.old, this.page]) { if (!g) continue; if (g === this.old) g.t += dt; for (const p of g.panels) { const o = p.o || (p.o = newPose()); o.roll = 0; o.soft = 0; o.lift = 0; p.shot.cam(t, Math.min(1.15, g.t / g.T), o); if (p.fresh) { p.lens.snap(o); p.fresh = false; } else p.lens.follow(o, dt, p.k || o.soft || 14); if (p.k) p.k = Math.min(14, p.k + dt * .6); } }
  }
  offset() { return 1 - ease(this.turn); }
}
