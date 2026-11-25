import * as THREE from 'three';
import { Model } from '../gfx/pack.js';
import { Plumes, Trail } from '../gfx/fx.js';

const V = () => new THREE.Vector3();
export const HOME = 18 * Math.PI / 180; export const DIR = new THREE.Vector3(Math.sin(HOME), 0, Math.cos(HOME)); const CH = Math.cos(HOME), SH = Math.sin(HOME);
export const home = (x, y, z, o = new THREE.Vector3()) => o.set(x * CH + z * SH, y, -x * SH + z * CH);
const UP = new THREE.Vector3(0, 1, 0);
const _a = V(), _b = V(), _c = V(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
export const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
export const smooth = (a, b, x) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };

function engines(list) {
  const out = [];
  for (const e of list) { const asp = e.w / Math.max(e.h, .01); if (asp > 2.6) { const n = Math.min(7, Math.round(asp / 1.9)); for (let i = 0; i < n; i++) out.push({ ...e, p: [e.p[0] + (i / (n - 1) - .5) * e.w * .9, e.p[1], e.p[2]], w: e.h * 1.25, h: e.h }); } else out.push(e); }
  return out.length ? out : [];
}

export class Ship {
  constructor(def, head, index) {
    this.def = def; this.key = def.key; this.index = index; this.head = head;
    this.color = new THREE.Color(def.ui); this.hot = new THREE.Color(def.hot);
    this.model = new Model(head, null, { lod: 1 }); this.root = this.model.root; this.root.scale.setScalar(def.scale);
    this.u = this.model.uniforms; this.u.uTint.value.copy(this.color); this.u.uFlashCol.value.copy(this.color).lerp(new THREE.Color(1, 1, 1), .6);
    this.plumes = new Plumes(engines(head.sockets.engines), def.hot); if (head.sockets.engines.length) this.root.add(this.plumes.mesh);
    this.radius = head.half * def.scale; this.length = (head.max[2] - head.min[2]) * def.scale;
    this.p = V(); this.v = V(); this.q = new THREE.Quaternion(); this.f = new THREE.Vector3(0, 0, 1); this.roll = 0; this.acc = V();
    this.mode = 'orbit'; this.modeT = 0; this.T = 1; this.p0 = V(); this.v0 = V(); this.f0 = new THREE.Vector3(0, 0, 1);
    this.state = 'idle'; this.power = .2; this.seed = index * 7.31; this.visible = true; this.warp = 0; this.sketch = 0; this.flash = 0;
    this.sessions = def.sessions.map((s) => ({ ...s, text: s.reply, log: [{ me: true, t: s.ask }, { me: false, t: s.reply }] }));
    this.session = 0;
  }
  get s() { return this.sessions[this.session]; }
  orbitAt(t, out = V()) {
    const o = this.def.orbit, a = o.ph + t * o.w; return home(Math.cos(a) * o.rx * .92, o.y + Math.sin(a * 1.7 + o.ph) * o.dy, Math.sin(a) * o.rz, out);
  }
  orbitPose(t) { const p = this.orbitAt(t), f = this.orbitAt(t + .4).sub(p).normalize(); return { p, f }; }
  go(mode, t, T) { if (mode === this.mode) return; this.mode = mode; this.modeT = t; this.p0.copy(this.p); this.v0.copy(this.v); this.f0.copy(this.f); this.T = T ?? null; }
  // 由世界传入各模式的目标姿态
  step(dt, t, pose) {
    if (this.T == null) this.T = THREE.MathUtils.clamp(this.p0.distanceTo(pose.p) / 6.5, 1.8, 4.6);
    const s = Math.min(1, (t - this.modeT) / this.T), e = ease(s);
    _a.copy(this.p);
    if (s < 1) {
      // 惯性延续 + 缓入目标，稍微绕开空间站
      const mid = _b.copy(this.p0).addScaledVector(this.v0, this.T * .22 * (1 - s) * s * 2);
      this.p.copy(mid).lerp(pose.p, e);
      const d = Math.hypot(this.p.x, this.p.y), zz = Math.abs(this.p.z); const near = smooth(13.5, 8, d) * smooth(7.5, 3, zz) * Math.sin(s * Math.PI); if (near > 0) this.p.z += Math.sign(this.p.z || 1) * near * 5.5;
    } else this.p.copy(pose.p);
    const bob = (this.mode === 'orbit' ? .16 : .09); this.p.x += Math.sin(t * .6 + this.seed) * bob; this.p.y += Math.sin(t * .83 + this.seed * 1.7) * bob; this.p.z += Math.cos(t * .5 + this.seed) * bob;
    _b.copy(this.p).sub(_a).divideScalar(Math.max(dt, 1e-3)); const pv = _c.copy(this.v); this.v.lerp(_b, 1 - Math.exp(-dt * 10)); this.acc.lerp(pv.sub(this.v).multiplyScalar(-1 / Math.max(dt, 1e-3)), 1 - Math.exp(-dt * 4));
    const sp = this.v.length(); const want = _b.copy(pose.f); if (s < 1 && sp > .6) { const w = smooth(.0, .16, s) * (1 - smooth(.7, 1, s)); want.lerp(_c.copy(this.v).normalize(), w).normalize(); }
    const turn = pose.turn ?? 2.6; this.f.lerp(want, 1 - Math.exp(-dt * turn)).normalize();
    const right = _c.crossVectors(UP, this.f).normalize(); const bank = THREE.MathUtils.clamp(-this.acc.dot(right) * .13, -.7, .7) + (pose.roll || 0) + Math.sin(t * .7 + this.seed) * .02; this.roll += (bank - this.roll) * (1 - Math.exp(-dt * 2.2));
    _m.lookAt(this.f, _a.set(0, 0, 0), UP); this.q.setFromRotationMatrix(_m); _q.setFromAxisAngle(_a.set(0, 0, 1), this.roll); this.q.multiply(_q);
    if (pose.q) this.q.slerp(pose.q, pose.qk ?? 1);
    this.root.position.copy(this.p); this.root.quaternion.copy(this.q);
    const base = { idle: .16, run: .5, wait: .12, done: .3 }[this.state] ?? .2; const tgt = THREE.MathUtils.clamp(base + sp * .085 + (pose.thrust || 0), 0, 1.25); this.power += (tgt - this.power) * (1 - Math.exp(-dt * 3));
    this.u.uEngine.value = this.power; this.plumes.u.uPow.value = this.power; this.plumes.u.uLen.value = .5 + Math.min(1.2, sp * .09); this.plumes.u.uWarp.value = this.warp;
    const bl = (t * .9 + this.seed) % 1.6; this.u.uBeacon.value = bl < .12 || (bl > .24 && bl < .34) ? 1 : .08;
    this.u.uTrim.value += (((this.state === 'run' ? 1.1 + .25 * Math.sin(t * 3 + this.seed) : this.state === 'wait' ? .9 + .5 * Math.sin(t * 5) : .62)) * (this.def.glow ?? 1) - this.u.uTrim.value) * (1 - Math.exp(-dt * 4));
    this.flash = Math.max(0, this.flash - dt * 2.2); this.u.uFlash.value = this.flash; this.u.uSketch.value = this.sketch; this.u.uStretch.value = this.warp; this.root.visible = this.visible;
  }
  local(x, y, z, out = V()) { return out.set(x, y, z).multiplyScalar(this.def.scale).applyQuaternion(this.q).add(this.p); }
}
export { V, UP };
