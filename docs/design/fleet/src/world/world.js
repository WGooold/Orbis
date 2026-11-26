// 场景总装：空间站、舰队、通信、审批闸门、上行/下行讯息
import * as THREE from 'three';
import { env } from '../gfx/cel.js';
import { Sky, ORDER } from '../gfx/sky.js';
import { Shadows } from '../gfx/shadow.js';
import { parsePack, Model, Swarm } from '../gfx/pack.js';
import { Sprites, Beam, Rings, Portal, Trail, fxMat, SHAPE, view } from '../gfx/fx.js';
import { panelTexture } from '../gfx/panel.js';
import { AGENTS } from '../agents.js';
import { Ship, V, UP, DIR, HOME, ease, smooth } from './ship.js';
import { WORKS } from './work.js';

const AMBER = new THREE.Color('#ffae3d'), RED = new THREE.Color('#ff4b3e'), WHITE = new THREE.Color(1, 1, 1);
const PROPS = ['drone', 'shuttle', 'crate', 'tile', 'relay', 'gateseg', 'rock'];
const _v = V(), _w = V(), _q = new THREE.Quaternion(), _s = V();
const rnd = (a, b) => a + Math.random() * (b - a);

export class World {
  constructor(renderer, q) {
    this.r = renderer; this.q = q; this.scene = new THREE.Scene(); this.t = 0; this.ships = []; this.packs = {}; this.byKey = {};
    this.tod = 2; this.todTarget = null; this.scroll = 0; this.route = 'lan'; this.online = 1; this.powerK = 0; this.lights = [0, 0, 0].map(() => ({ k: 0, p: V(), c: new THREE.Color(), r: 10 })); this.li = 0; this.events = {};
    env.uPanel.value = panelTexture(1024, q.aniso);
  }
  on(n, f) { (this.events[n] || (this.events[n] = [])).push(f); }
  fire(n, ...a) { (this.events[n] || []).forEach((f) => f(...a)); }
  async load(get, progress) {
    const keys = AGENTS.map((a) => a.key); const all = ['station', ...PROPS, ...keys]; let n = 0;
    await Promise.all(all.map(async (k) => { const b = await get(k).catch(() => null); if (b) this.packs[k] = parsePack(b); progress?.(++n / all.length); }));
    const sc = this.scene; this.sky = new Sky(this.r, this.q); sc.add(this.sky.mesh); this.shadows = new Shadows(this.r, this.q);
    this.station = new Model(this.packs.station, null, { lod: 0 }); sc.add(this.station.root); this.station.u = this.station.uniforms; this.station.u.uPowerRing.value.x = 0;
    this.buildName('MACBOOK PRO');
    this.sprites = new Sprites(1500); this.rings = new Rings(44); this.portal = new Portal(2.28); sc.add(this.sprites.mesh, this.rings.mesh, this.portal.mesh);
    AGENTS.filter((a) => this.packs[a.key]).forEach((d, i) => { const s = new Ship(d, this.packs[d.key], i); s.p.copy(s.orbitAt(0)); s.f.copy(s.orbitPose(0).f); this.ships.push(s); this.byKey[d.key] = s; sc.add(s.root); s.work = new (WORKS[d.key])(this, s); s.link = new Beam(); s.link.u.uCol.value.copy(s.hot); s.link.u.uW.value = .028; s.link.u.uDash.value = 26; s.link.u.uFlow.value = 1.5; sc.add(s.link.mesh); s.linkK = 0; s.pk = Math.random(); });
    this.buildGate(); this.buildTraffic();
    this.relay = new Model(this.packs.relay, null, { lod: 0 }); this.relay.root.scale.setScalar(.85); this.relay.root.position.set(-9.5, 19.5, -6); sc.add(this.relay.root); this.relay.uniforms.uShadowSel.value = -1; this.relay.uniforms.uTint.value.set('#8fd0ff');
    this.tail = [new Beam(), new Beam(), new Beam()]; this.tail.forEach((b) => { b.u.uMode.value = 1; sc.add(b.mesh); }); this.ti = 0;
  }
  // 电脑的名字，像船名一样漆在环面上
  buildName(text) {
    const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 256; const g = cv.getContext('2d'); const draw = () => { g.clearRect(0, 0, 2048, 256); g.fillStyle = '#fff'; g.font = '800 214px "DIN Condensed","Avenir Next Condensed","Roboto Condensed","Arial Narrow","Helvetica Neue",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; try { g.letterSpacing = '26px'; } catch { } const w = g.measureText(text).width; const k = Math.min(1, 1980 / w); g.save(); g.translate(1024, 206); g.scale(k, 1); g.fillText(text, 0, 0); g.restore(); g.globalCompositeOperation = 'destination-out'; for (let i = 0; i < 46; i++) { const x = Math.random() * 2048, y = Math.random() * 256; g.fillRect(x, y, 4 + Math.random() * 18, 2 + Math.random() * 3); } g.globalCompositeOperation = 'source-over'; }; draw();
    const tx = new THREE.CanvasTexture(cv); tx.anisotropy = this.q.aniso; tx.generateMipmaps = true; tx.minFilter = THREE.LinearMipmapLinearFilter; const N = 64, a0 = 206, a1 = 284, r0 = 8.92, r1 = 7.18; const p = [], uv = [], ix = []; for (let i = 0; i <= N; i++) { const a = (a0 + (a1 - a0) * i / N) * Math.PI / 180; for (const [r, v] of [[r0, 0], [r1, 1]]) { p.push(Math.cos(a) * r, Math.sin(a) * r, 3.985); uv.push(i / N, v); } if (i < N) { const k = i * 2; ix.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); } }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(ix); this.nameU = { tMap: { value: tx }, uInk: { value: new THREE.Color('#1f3157') }, uOn: { value: 1 } };
    const m = new THREE.Mesh(geo, fxMat(/* glsl */`in vec3 position; in vec2 uv; out vec2 vT; out vec3 vN; out float vZ; void main(){ vT=uv; vec4 w=modelMatrix*vec4(position,1.); vec4 v=viewMatrix*w; vZ=-v.z; vN=mat3(viewMatrix)*vec3(0.,0.,1.); gl_Position=projectionMatrix*v; }`, /* glsl */`in vec2 vT; in vec3 vN; in float vZ; uniform sampler2D tMap; uniform vec3 uInk,uLit,uShade,uSun; uniform float uNight,uOn; void main(){ if(texture(tMap,vT).a<.5) discard; float l=smoothstep(.15,.4,uSun.z); vec3 c=uInk*mix(uShade,uLit,l); c=mix(c,vec3(1.,.80,.42)*1.3*uOn+uInk*(1.-uOn),smoothstep(.45,1.,uNight)*.95); oColor=vec4(c,1.); oAux=vec4(octEncode(normalize(vN)),.77,vZ); }`, { ...this.nameU, uLit: env.uLit, uShade: env.uShade, uSun: env.uSun, uNight: env.uNight }, { mat: { blending: THREE.NoBlending, transparent: false, depthWrite: true } })); m.renderOrder = 1; m.frustumCulled = false; this.scene.add(m);
  }
  // ---------------------------------------------------------------- 审批闸门
  buildGate() {
    const g = this.gate = { root: new THREE.Group(), segs: [], k: 0, open: 0, ship: null, p: DIR.clone().multiplyScalar(12.6), flash: 0 }; g.root.position.copy(g.p); g.spin = new THREE.Group(); g.root.rotation.y = HOME; g.root.add(g.spin); this.scene.add(g.root);
    for (let i = 0; i < 6; i++) { const m = new Model(this.packs.gateseg, null, { lod: 0 }); m.uniforms.uShadowSel.value = -1; m.uniforms.uTint.value.copy(AMBER); const piv = new THREE.Group(); piv.rotation.z = i * Math.PI / 3; piv.add(m.root); g.spin.add(piv); g.segs.push(m); }
    g.u = { uOpen: { value: 0 }, uCol: { value: AMBER.clone() }, uK: { value: 0 }, uHold: { value: 0 } };
    g.iris = new THREE.Mesh(new THREE.CircleGeometry(2.62, 72), fxMat(/* glsl */`in vec3 position; out vec2 vQ; void main(){ vQ=position.xy/2.62; gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.); }`, /* glsl */`
in vec2 vQ; uniform float uOpen,uK,uHold; uniform vec3 uCol;
float hex(vec2 p){ p=abs(p); return max(p.x*.866+p.y*.5,p.y); }
void main(){ float r=length(vQ); if(r>1.) discard; float an=atan(vQ.y,vQ.x); float th=an+r*1.1-uOpen*2.4; float bl=fract(th/6.28318*6.); float hole=uOpen*1.08; float blade=smoothstep(.0,.03,bl)*(1.-smoothstep(.97,1.,bl)); float vis=smoothstep(hole-.015,hole+.015,r+.10*(bl-.5)*uOpen);
  vec2 g=vQ*9.; vec2 a=mod(g,vec2(1.732,1.)*1.)-vec2(.866,.5); vec2 b=mod(g+vec2(.866,.5),vec2(1.732,1.))-vec2(.866,.5); vec2 h=dot(a,a)<dot(b,b)?a:b; float hx=hex(h); float ed=smoothstep(.40,.46,hx); float sw=.5+.5*sin(r*7.-uTime*3.2); float scan=step(.93,fract(vQ.y*1.6-uTime*.35));
  float rim=smoothstep(.93,.97,r); float lip=(1.-smoothstep(0.,.06,abs(r-hole)))*uOpen; float hold=step(fract(an/6.28318+.25),uHold)*smoothstep(.80,.83,r)*(1.-smoothstep(.88,.91,r));
  float al=vis*(.06+.18*ed*sw+.10*scan+(1.-blade)*.22)+rim*.55+lip*.9+hold*1.1; oColor=vec4(mix(uCol,vec3(1.),hold*.5+lip*.4)*al*uK*1.5,0.); oAux=vec4(0.); }`, g.u)); g.iris.renderOrder = 13; g.iris.frustumCulled = false; g.spin.add(g.iris);
  }
  gateStep(dt, t) {
    const g = this.gate; const waiting = this.ships.filter((s) => s.state === 'wait'); g.stay = Math.max(0, (g.stay || 0) - dt); const want = waiting.length || g.stay > 0 ? 1 : 0; g.k += (want - g.k) * (1 - Math.exp(-dt * (want ? 2.2 : 1.6))); g.flash = Math.max(0, g.flash - dt * 1.4); if (g.target != null) { g.open += (g.target - g.open) * (1 - Math.exp(-dt * 9)); } else g.open += (0 - g.open) * (1 - Math.exp(-dt * 3));
    g.root.visible = g.k > .01; const e = ease(g.k); g.segs.forEach((m, i) => { const out = (1 - e) * 5 + g.open * .55 + g.flash * .9; m.root.position.set(0, out, 0); m.root.rotation.z = (1 - e) * .9 - g.open * .12; m.uniforms.uTint.value.copy(AMBER).lerp(g.col || WHITE, g.open); m.uniforms.uTrim.value = 1.1 + .5 * Math.sin(t * 5) + g.open * 1.4 + g.flash * 2; m.uniforms.uFlash.value = g.flash * .5; m.uniforms.uReveal.value = Math.min(1, e * 1.3); });
    g.u.uOpen.value = Math.min(1, g.open); g.u.uK.value = e; g.u.uCol.value.copy(AMBER).lerp(g.col || WHITE, Math.min(1, g.open * 1.2)); if (g.deny > 0) { g.deny -= dt; g.u.uCol.value.copy(RED); } g.spin.rotation.z = Math.sin(t * .2) * .05 + g.open * .5;
    g.ship = waiting[0] || null; waiting.forEach((s, i) => { s.queue = i; });
    if (g.ship && g.k > .6 && Math.random() < dt * 9) { const a = rnd(0, 6.28); this.sprites.emit({ p: g.p.clone().add(_v.set(Math.cos(a) * 2.4, Math.sin(a) * 2.4, 0)), v: _w.set(-Math.cos(a) * 1.4, -Math.sin(a) * 1.4, rnd(.4, 1)), life: .9, size: .045, shape: SHAPE.dot, col: AMBER, k: 1.6 }); }
    if (g.ship) { g.req = g.req || 0; g.req += dt; if (!g.token) g.token = this.sprites.emit({ p: g.p, life: 1e9, size: .5, shape: 0, col: AMBER, k: .95, fade: () => Math.min(1, g.k) * (g.open > .75 ? 0 : 1), fn: (it) => { if (!g.ship) { g.token = null; return false; } it.p.copy(g.p).addScaledVector(DIR, .95 + Math.sin(this.t * 2) * .08); it.shape = g.ship.def.shape; it.rot = this.t * 1.1; it.size = .46 + .05 * Math.sin(this.t * 4); } }); if (Math.random() < dt * 8) this.sprites.emit({ p: g.p.clone().addScaledVector(DIR, .95), life: .7, size: .2, size1: .7, shape: SHAPE.dot, col: AMBER, k: .22 }); }
  }
  // ---------------------------------------------------------------- 背景航道
  buildTraffic() {
    const n = 9; this.traffic = new Swarm(this.packs.shuttle, n, { lod: 1 }); this.traffic.uniforms.uShadowSel.value = -1; this.scene.add(this.traffic.mesh);
    this.tf = Array.from({ length: n }, (_, i) => { const tr = new Trail(30, ['#bfe6ff', '#ffd7a0', '#d9d2ff'][i % 3], .05); this.scene.add(tr.mesh); const ang = rnd(0, 6.28); return { i, tr, ang, r: rnd(30, 62), y: rnd(-26, 22), sp: rnd(.05, .11) * (Math.random() < .25 ? -1 : 1), inc: rnd(-.35, .35), p: V(), c: new THREE.Color(['#8fd0ff', '#ffb27a', '#b7a4ff'][i % 3]) }; });
  }
  trafficStep(dt) { for (const f of this.tf) { f.ang += dt * f.sp; const c = Math.cos(f.ang), s = Math.sin(f.ang); f.p.set(c * f.r, f.y + s * f.r * f.inc, s * f.r); const d = _v.set(-s * f.r, c * f.r * f.inc, c * f.r).multiplyScalar(Math.sign(f.sp)).normalize(); _q.setFromRotationMatrix(new THREE.Matrix4().lookAt(d, _w.set(0, 0, 0), UP)); this.traffic.set(f.i, f.p, _q, _s.setScalar(.75)); this.traffic.look(f.i, f.c, 0, 0, 1, 1); f.tr.u.uAlpha.value = .75 * this.online; f.tr.push(f.p, dt, .07); } }
  // ---------------------------------------------------------------- 光照小助手
  light(p, c, r = 9, k = 1) { k *= .62; const l = this.lights[this.li++ % 3]; l.p.copy(p); l.c.copy(c); l.r = r; l.k = k; }
  stationPulse(p, c, k = 1) { this.light(p.clone().add(_v.set(0, 0, 1.2)), c, 9, 1.4 * k); this.station.pulse = Math.max(this.station.pulse || 0, k * .6); }
  portalPulse(c) { this.portal.u.uCol.value.copy(c); this.portal.u.uPulse.value = 1; this.portal.u.uT.value = 0; this.light(_w.set(0, 0, 1.6), c, 8, 1.8); this.light(_w.set(0, 0, -1.6), c, 8, 1.2); for (const z of [1, -1]) this.rings.emit({ p: _v.set(0, 0, z * 1.1), n: _w.set(0, 0, 1), r0: 1.9, r1: 4.8, life: .9, w: .07, w1: .01, col: c, k: 2.2 }); }
  // 一颗沿曲线飞的讯息：带拖光与火花
  shot(a, b, c, d, { T = .7, col, shape = 0, size = .3, done, w = .07, spark = 24, e = ease, k = 3 }) {
    const beam = this.tail[this.ti++ % 3]; beam.set(a, b, c, d); beam.u.uCol.value.copy(col); beam.u.uW.value = w; beam.mesh.visible = true; beam.born = this.t; beam.own = (beam.own || 0) + 1; const own = beam.own; const prev = V().copy(a);
    const it = this.sprites.emit({ p: a, life: T, size, stretch: 0, shape: 10, col, k: k * 1.1, fade: () => 1, fn: (s, dt, u) => { const x = e(u); beam.at(x, s.p); s.v.copy(s.p).sub(prev).divideScalar(Math.max(dt, .001)); prev.copy(s.p); if (beam.own === own) { beam.u.uFrom.value = Math.max(0, x - .42 * (1 - Math.abs(x - .5))); beam.u.uTo.value = x; beam.u.uAlpha.value = 1.2; } if (Math.random() < dt * spark) this.sprites.emit({ p: s.p, v: _v.set(rnd(-.6, .6), rnd(-.6, .6), rnd(-.6, .6)), life: rnd(.3, .7), size: rnd(.03, .07), shape: Math.random() < .5 ? shape : SHAPE.dot, spin: rnd(-4, 4), col, k: 2, drag: 2 }); }, done: () => { if (beam.own === own) beam.fadeOut = this.t; done?.(); } });
    if (it) this.sprites.emit({ p: a, life: T, size: size * .85, shape, spin: 5, col: WHITE, k: 2.2, fade: () => 1, fn: (s, dt, u) => { beam.at(e(u), s.p); } });
    return it;
  }
  hubPath(a, b) { const m = a.distanceTo(b); const d = V().copy(b).sub(a).normalize(); const side = V().crossVectors(d, UP).normalize(); return [a, a.clone().addScaledVector(d, m * .3).addScaledVector(UP, m * .10).addScaledVector(side, m * .08), b.clone().addScaledVector(d, -m * .3).add(_v.set(0, m * .03, Math.sign(a.z || 1) * m * .12)), b]; }
  // 手机 → 枢纽 → 飞船
  uplink(ship, from, done) {
    const hub = V().set(0, 0, from.z > 0 ? .8 : -.8); const col = ship.hot; const go2 = () => { this.portalPulse(ship.color); this.fire('hub', ship); const o = V().set(0, 0, 0), tgt = ship.p; const [a, b, c, d] = this.hubPath(o, tgt.clone()); this.shot(a, b, c, d, { T: .62, col, shape: ship.def.shape, size: .42, w: .085, spark: 40, done: () => { this.receive(ship); done?.(); } }); };
    if (this.route === 'relay') { const r = this.relay.root.position.clone().add(_v.set(0, 0, 1)); this.shot(from, from.clone().lerp(r, .3).add(_v.set(1.5, 2, 2)), from.clone().lerp(r, .7).add(_v.set(1, 2, 1)), r, { T: .55, col: new THREE.Color('#cfe6ff'), shape: 10, size: .38, done: () => { this.rings.emit({ p: r, n: _v.set(0, 0, 1), r0: .4, r1: 3, life: .7, w: .08, col: this.relay.uniforms.uTint.value, k: 2 }); const [a, b, c, d] = this.hubPath(r, hub); this.shot(a, b, c, d, { T: .5, col: new THREE.Color('#cfe6ff'), shape: 10, size: .38, done: go2 }); } }); } else { const b = from.clone().lerp(hub, .34).add(_v.set(0, 2.6, 1)), c = from.clone().lerp(hub, .75).add(_v.set(0, 1.2, 4)); this.shot(from, b, c, hub, { T: .72, col: new THREE.Color('#eaf2ff'), shape: 10, size: .36, w: .08, spark: 36, done: go2 }); }
  }
  receive(ship) { ship.flash = .85; this.rings.emit({ p: ship.p, n: ship.f, r0: ship.radius * .3, r1: ship.radius * 1.5, life: .8, w: .07, w1: .01, col: ship.color, k: 2.4, follow: () => ship.p }); for (let i = 0; i < 22; i++) { const d = _v.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize(); this.sprites.emit({ p: ship.p.clone().addScaledVector(d, ship.radius * .5), v: d.clone().multiplyScalar(rnd(1, 3.4)), life: rnd(.4, 1), size: rnd(.05, .13), shape: ship.def.shape, spin: rnd(-4, 4), col: ship.hot, k: 2.4, drag: 2.4 }); } this.light(ship.p.clone().add(_v.set(0, 2, 2)), ship.hot, 9, 2); }
  // 飞船 → 枢纽 → 手机（每到一颗触发一次回调）
  downlink(ship, to, done) { const hub = V().set(0, 0, .6); const [a, b, c, d] = this.hubPath(ship.p.clone(), hub); this.shot(a, b, c, d, { T: .6, col: ship.hot, shape: ship.def.shape, size: .26, w: .055, spark: 18, done: () => { this.portalPulse(ship.color); const p = to(); this.shot(hub, hub.clone().lerp(p, .35).add(_v.set(0, 1, 3)), hub.clone().lerp(p, .72).add(_v.set(0, 1.4, 0)), p, { T: .58, col: ship.hot, shape: ship.def.shape, size: .24, w: .05, spark: 14, done }); } }); }
  packet(p, col, shape, to) { const prev = p.clone(); this.sprites.emit({ p, life: .9, size: .16, stretch: .05, shape, col, k: 2.4, fn: (s, dt, u) => { s.p.copy(prev).lerp(to.p, ease(u)); } }); }
  // ---------------------------------------------------------------- 通信线
  linkStep(s, dt, t) {
    const on = (s.state === 'run' ? 1 : s.state === 'wait' ? .35 : .0) * this.online * (s.visible ? 1 : 0); s.linkK += (on - s.linkK) * (1 - Math.exp(-dt * 2)); const b = s.link; b.mesh.visible = s.linkK > .02; if (!b.mesh.visible) { if (s.state === 'idle' && this.online && Math.random() < dt * .07) this.ping(s); return; }
    const o = _v.copy(s.p); const sgn = o.z >= 0 ? 1 : -1; const A = s.p.clone(), D = V().set(0, 0, sgn * .9); const m = A.distanceTo(D); const B = A.clone().lerp(D, .3); const d = Math.hypot(A.x, A.y); B.z += sgn * smooth(3, 12, d) * 5 + (Math.abs(A.z) < 4 ? sgn * 4 : 0); const C = D.clone(); C.z += sgn * (3.5 + m * .16); b.set(A, B, C, D); b.u.uAlpha.value = s.linkK * .85; b.u.uCol.value.copy(s.state === 'wait' ? AMBER : s.hot);
    s.pk -= dt * s.linkK; if (s.pk <= 0 && s.state === 'run') { s.pk = rnd(.28, .85); const inb = Math.random() < .4; const T = rnd(1.1, 1.6); const col = s.def.tri ? new THREE.Color(s.def.tri[(Math.random() * 3) | 0]) : s.hot; const prev = V(); this.sprites.emit({ p: inb ? D : A, life: T, size: inb ? .09 : .13, shape: inb ? SHAPE.comet : s.def.shape, stretch: inb ? .03 : 0, spin: inb ? 0 : 3, col: inb ? WHITE.clone().lerp(col, .5) : col, k: 2.2, fn: (it, d2, u) => { prev.copy(it.p); b.at(inb ? 1 - ease(u) : ease(u), it.p); it.v.copy(it.p).sub(prev).divideScalar(Math.max(d2, .001)); }, done: () => { if (!inb) this.light(_w.set(0, 0, sgn * 1.4), col, 5, .5); } }); }
  }
  ping(s) { this.rings.emit({ p: s.p, n: _v.copy(s.f), r0: .2, r1: s.radius * .8, life: 1.6, w: .05, w1: .01, col: s.color, k: 1.2, a: .6, follow: () => s.p }); }
  // ---------------------------------------------------------------- 状态切换
  run(s) { s.state = 'run'; s.go('work', this.t); this.fire('state', s); }
  idle(s) { s.state = 'idle'; s.go('orbit', this.t); this.fire('state', s); }
  wait(s) { s.state = 'wait'; s.go('gate', this.t); this.fire('state', s); }
  approve(s) { const g = this.gate; g.col = s.color; g.target = 1; g.flash = 1; const p = g.p.clone().addScaledVector(DIR, .9); this.rings.emit({ p: g.p, n: DIR, r0: 2.4, r1: 9, life: 1.1, w: .06, w1: .005, col: s.color, k: 2.6 }); for (let i = 0; i < 40; i++) { const a = rnd(0, 6.28); this.sprites.emit({ p: g.p.clone().add(_v.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0)), v: _w.set(Math.cos(a) * rnd(1, 6), Math.sin(a) * rnd(1, 6), rnd(-1.5, 1.5)), life: rnd(.5, 1.2), size: rnd(.04, .11), stretch: .03, shape: SHAPE.spark, col: Math.random() < .5 ? s.hot : AMBER, k: 2.8, drag: 2.2 }); } this.light(g.p, s.hot, 14, 2.2);
    this.shot(p, p.clone().addScaledVector(DIR, -3), DIR.clone().multiplyScalar(4), V().set(0, 0, .6), { T: .55, col: s.hot, shape: s.def.shape, size: .42, w: .1, spark: 50, done: () => { this.portalPulse(s.color); this.station.pulse = 1; this.fire('hub', s); } }); s.state = 'run'; g.stay = 1.5; setTimeout(() => { s.go('work', this.t); }, 800); setTimeout(() => { if (g.target === 1) g.target = null; }, 1300); this.fire('state', s); this.fire('approved', s); }
  deny(s) { const g = this.gate; g.deny = .8; g.target = 0; const p = g.p.clone().addScaledVector(DIR, .9); for (let i = 0; i < 26; i++) this.sprites.emit({ p, v: _w.set(rnd(-3, 3), rnd(-3, 3), rnd(-.5, 3)), life: rnd(.5, 1.1), size: rnd(.05, .12), shape: s.def.shape, spin: rnd(-6, 6), col: RED, k: 2, drag: 1.6 }); this.rings.emit({ p: g.p, n: DIR, r0: 2.6, r1: .6, life: .5, w: .08, col: RED, k: 2 }); g.stay = .9; this.idle(s); s.mode = 'gate'; setTimeout(() => { g.target = null; s.go('orbit', this.t); }, 600); }
  complete(s) { s.flash = .6; this.rings.emit({ p: s.p, n: UP, r0: .6, r1: s.radius * 1.9, life: 1.2, w: .05, w1: .005, col: s.color, k: 2.2, follow: () => s.p }); this.idle(s); this.fire('done', s); }
  // ---------------------------------------------------------------- 每帧
  pose(s, t) {
    if (s.mode === 'work') return s.work.pose(t);
    if (s.mode === 'gate') { const q = s.queue || 0; const p = DIR.clone().multiplyScalar(21.5 + q * 8); p.y = .1 + Math.sin(t * .5) * .15 - q * 1.4; return { p, f: DIR.clone().negate() }; }
    const p = s.orbitPose(t); return { ...p, turn: 1.6 };
  }
  step(dt) {
    this.t += dt; const t = this.t; env.uTime.value = t;
    // 时段
    if (this.todTarget != null) { let d = this.todTarget - this.tod; d = ((d + 6) % 4) - 2; this.tod = (this.tod + d * (1 - Math.exp(-dt * 1.1)) + 4) % 4; if (Math.abs(d) < .002) { this.tod = this.todTarget; this.todTarget = null; } }
    if (this.todSpeed) this.tod = (this.tod + dt * this.todSpeed + 4) % 4;
    const i = Math.floor(this.tod) % 4, f = this.tod - Math.floor(this.tod); this.sky.setTime(ORDER[i], ORDER[(i + 1) % 4], smooth(.22, .78, f)); this.scroll += dt * .0016; this.sky.u.uScroll.value = this.scroll + this.tod * .13; this.dusk = env.uNight.value;
    // 供电
    this.powerK += (this.online - this.powerK) * (1 - Math.exp(-dt * (this.online ? .9 : 2))); const u = this.station.u; u.uPowerRing.value.x = this.powerK > .985 ? 1 : this.powerK; this.station.pulse = Math.max(0, (this.station.pulse || 0) - dt * 1.3); u.uWindow.value = (.9 + this.station.pulse * 1.2) * (.1 + .9 * this.online); u.uTrim.value = 1 + this.station.pulse; u.uBeacon.value = (t % 1.8) < .16 ? 1 : .05; this.station.rig('hub', (n) => { n.rotation.z = t * .12 * 1; }); this.nameU.uOn.value = this.online; this.relay.root.rotation.y = .25 + Math.sin(t * .1) * .1; this.relay.root.rotation.x = .2;
    this.portal.u.uPulse.value = Math.max(0, this.portal.u.uPulse.value - dt * .85); this.portal.u.uT.value += dt; this.portal.u.uOpen.value += ((this.online ? .42 : 0) - this.portal.u.uOpen.value) * (1 - Math.exp(-dt * 2)); if (this.portal.u.uPulse.value <= 0) this.portal.u.uCol.value.lerp(_portalBase, 1 - Math.exp(-dt));
    for (const s of this.ships) { s.work.ship = s; s.step(dt, t, this.pose(s, t)); }
    for (const s of this.ships) { s.work.step(dt, t); this.linkStep(s, dt, t); }
    this.gateStep(dt, t); this.trafficStep(dt); this.shuttleStep(dt, t);
    this.lights.forEach((l, k) => { l.k *= Math.exp(-dt * 2.6); env.uPointPos.value[k].copy(l.p); env.uPointCol.value[k].copy(l.c).multiplyScalar(l.k * 1.6); env.uPointR.value.setComponent(k, l.r); });
    this.tail.forEach((b) => { if (b.fadeOut && b.fadeOut >= b.born) { const k = 1 - (t - b.fadeOut) / .28; b.u.uAlpha.value = Math.max(0, k); b.u.uFrom.value = Math.min(1, b.u.uFrom.value + dt * 2.4); if (k <= 0) { b.mesh.visible = false; b.fadeOut = 0; } } });
    this.sprites.update(dt); this.rings.update(dt);
  }
  // 镜头与主角之间的东西化成网点
  ghostStep(dt, cam, target, hero, on) {
    const a = cam, ab = _v.copy(target).sub(a); const L = ab.length() || 1; ab.divideScalar(L);
    for (const s of this.ships) {
      let g = 0; if (on && s !== hero) { const ap = _w.copy(s.p).sub(a); const along = ap.dot(ab); const d = Math.sqrt(Math.max(0, ap.lengthSq() - along * along)); const R = s.radius * 1.05 + 3.0 + Math.max(0, L - along) * .16; if (along < L + 2.5 && along > -s.radius) g = 1 - smooth(R * .62, R * 1.15, d); const near = a.distanceTo(s.p); g = Math.max(g, 1 - smooth(s.radius * 1.2, s.radius * 2.2, near)); }
      s.gh = (s.gh || 0) + (g - (s.gh || 0)) * (1 - Math.exp(-dt * 5)); if (s.gh < .004) s.gh = 0; s.u.uGhost.value = s.gh; s.plumes.u.uPow.value *= 1 - s.gh; s.work.setGhost(s.gh); if (s.gh > .02) s.link.u.uAlpha.value *= 1 - s.gh;
    }
    const gk = on && hero && hero.state !== 'wait' ? 1 : 0; this.gateGh = (this.gateGh || 0) + (gk - (this.gateGh || 0)) * (1 - Math.exp(-dt * 4)); this.gate.segs.forEach((m) => { m.uniforms.uGhost.value = this.gateGh < .01 ? 0 : this.gateGh; }); this.gate.u.uK.value *= 1 - this.gateGh;
  }
  shadowPass(hero) {
    const S = this.shadows, roots = [this.station.root, ...this.ships.filter((s) => s !== hero && s.p.length() < 30).map((s) => s.root)];
    this.ships.forEach((s) => { s.u.uShadowSel.value = s === hero ? 1 : 0; });
    S.fit(S.A, _center, 18.5, env.uShadowMA.value); S.render(roots, S.A); if (hero) { S.fit(S.B, hero.p, hero.radius * 1.12, env.uShadowMB.value); S.render([hero.root], S.B); }
  }
  lod(cams) { for (const s of this.ships) { let k = 1; for (const c of cams) { const d = c.cam.position.distanceTo(s.p); const px = s.radius / (d * Math.tan(c.cam.fov * Math.PI / 360)) * c.h; if (px > this.q.lodPx) k = 0; } s.model.setLod(k); } }
}
const _portalBase = new THREE.Color('#7fc7ff'); const _center = new THREE.Vector3();

// ---------------------------------------------------------------- 穿梭机：新会话（拖出来时是线稿，落定后上色）
Object.assign(World.prototype, {
  newShuttle() { const m = new Model(this.packs.shuttle, null, { lod: 0 }); m.uniforms.uShadowSel.value = -1; this.scene.add(m.root); m.trail = new Trail(40, '#ffffff', .05); this.scene.add(m.trail.mesh); m.root.visible = false; return m; },
  flyShuttle(m, s, start) { const t0 = this.t; m.uniforms.uTint.value.copy(s.color); m.trail.u.uCol.value.copy(s.hot); m.root.visible = true; const a = start ? start.clone() : s.local(0, -2, 2, V()); m.trail.reset(a); m.trail.u.uAlpha.value = 1; m.q0 = s.q.clone(); m.fly = (dt, t) => { const u = Math.min(1, (t - t0) / 2.6), e = ease(u); const end = s.local(s.head.half * .75, s.head.half * .34, s.head.half * .3, V()); const mid = a.clone().lerp(end, .4).add(_v.copy(s.f).multiplyScalar(5)).add(_w.set(0, 1.2, 0)); const p = V().copy(a).multiplyScalar((1 - e) * (1 - e)).addScaledVector(mid, 2 * e * (1 - e)).addScaledVector(end, e * e); const d = _v.copy(p).sub(m.root.position); if (d.lengthSq() > 1e-6 && u < .98) { const M = new THREE.Matrix4().lookAt(d.normalize(), _w.set(0, 0, 0), UP); m.root.quaternion.slerp(_q.setFromRotationMatrix(M), 1 - Math.exp(-dt * 7)); } else m.root.quaternion.slerp(s.q, 1 - Math.exp(-dt * 3)); m.root.position.copy(p); m.root.scale.setScalar(.62); m.uniforms.uSketch.value = Math.max(0, 1 - u * 2.2); m.uniforms.uEngine.value = 1.2 - u * .7; m.trail.u.uAlpha.value = 1 - smooth(.8, 1, u); m.trail.push(p, dt, .025); if (u >= 1 && !m.hit) { m.hit = true; this.rings.emit({ p, n: s.f, r0: .4, r1: 1.8, life: .6, w: .1, col: s.color, k: 2 }); } }; m.hit = false; this.shuttles = this.shuttles || []; if (!this.shuttles.includes(m)) this.shuttles.push(m); },
  ghostStart(s) { const m = this.gh || (this.gh = this.newShuttle()); this.ghShip = s; m.fly = null; m.uniforms.uSketch.value = 1; m.uniforms.uTint.value.copy(s.color); m.root.visible = true; m.root.scale.setScalar(.01); m.trail.u.uAlpha.value = .8; m.trail.u.uCol.value.copy(s.hot); m.gp = null; },
  ghostMove(p, k) { const m = this.gh; if (!m) return; if (!m.gp) { m.gp = p.clone(); m.trail.reset(p); } m.gp.copy(p); m.gk = k; },
  ghostEnd(ok) { const m = this.gh; if (!m) return; if (ok) { this.rings.emit({ p: m.root.position, n: _v.set(0, 0, 1), r0: .4, r1: 3.4, life: .8, w: .07, col: this.ghShip.color, k: 2.4 }); for (let i = 0; i < 24; i++) this.sprites.emit({ p: m.root.position, v: _v.set(rnd(-3, 3), rnd(-3, 3), rnd(-3, 3)), life: rnd(.4, .9), size: rnd(.06, .14), shape: this.ghShip.def.shape, spin: rnd(-4, 4), col: this.ghShip.hot, k: 2.2, drag: 2 }); this.flyShuttle(m, this.ghShip, m.root.position); } else { m.root.visible = false; m.trail.u.uAlpha.value = 0; } m.gp = null; },
  shuttleStep(dt, t) { (this.shuttles || []).forEach((m) => m.fly?.(dt, t)); const m = this.gh; if (m?.gp) { const p = m.root.position; const d = _v.copy(m.gp).sub(p); p.lerp(m.gp, 1 - Math.exp(-dt * 14)); const M = new THREE.Matrix4().lookAt(_w.copy(d).add(_s.set(0, .4, -.6)).normalize(), _s.set(0, 0, 0), UP); m.root.quaternion.slerp(_q.setFromRotationMatrix(M), 1 - Math.exp(-dt * 6)); const sc = m.root.scale.x; m.root.scale.setScalar(sc + (1.5 - sc) * (1 - Math.exp(-dt * 8))); m.trail.push(p, dt, .025); } },
});
