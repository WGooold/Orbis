import * as THREE from 'three';
import { Pipeline } from './gfx/post.js';
import { env } from './gfx/cel.js';
import { view } from './gfx/fx.js';
import { World } from './world/world.js';
import { Rig, Director } from './world/camera.js';
import { ease, smooth, V } from './world/ship.js';
import { UI } from './ui/ui.js';
import { Sim } from './sim.js';

const Q = new URLSearchParams(location.search); const $ = (s) => document.querySelector(s); const body = document.body;
const coarse = matchMedia('(pointer:coarse)').matches; const phone = Q.has('phone') || (coarse && Math.min(innerWidth, innerHeight) < 620); if (phone) body.classList.add('phone');
const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;

// 太旧的浏览器：给一句能照做的话，而不是黑屏
const supported = (() => { try { const c = document.createElement('canvas').getContext('webgl2'); return !!c && !!c.getExtension('EXT_color_buffer_float') && 'DecompressionStream' in window; } catch { return false; } })();
if (!supported) { $('#boot').innerHTML = '<p>请用新版 Chrome、Edge 或 Safari 打开</p>'; body.classList.add('paper'); throw new Error('unsupported browser'); }
const gl = $('#gl'); const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: false });
renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace; renderer.setPixelRatio(1); renderer.setClearColor(0, 0);
const maxTex = renderer.capabilities.maxTextureSize; const dprReal = window.devicePixelRatio || 1;
const quality = phone ? { samples: 4, bloomLevels: 5, shadowA: 1536, shadowB: 1024, planet: Math.min(4096, maxTex), aniso: 4, lodPx: 120, dpr: Math.min(2, dprReal) } : { samples: 4, bloomLevels: 6, shadowA: 2048, shadowB: 2048, planet: Math.min(8192, maxTex), aniso: 16, lodPx: 84, dpr: Math.min(2.6, Math.max(2, dprReal)) };
if (Q.has('dpr')) quality.dpr = +Q.get('dpr');

const pipe = new Pipeline(renderer, quality); const world = new World(renderer, quality); const rig = new Rig(world); const dir = new Director(world);
const app = { world, rig, dir, pipe, mode: 'boot', idleT: 0, idleAfter: +(Q.get('idle') || 14), flood: { r: 0, target: 0, c: new THREE.Vector2(.5, .5) }, time: 0, land: false, reduced, phone, quality, slow: 1 };
window.__fleet = app;

// ---------------------------------------------------------------- 尺寸
let W = 1, H = 1, scale = quality.dpr;
function layout() {
  const dev = $('#device'), [w, h] = app.size || (app.land ? [874, 402] : [402, 874]); if (!phone) { const k = Math.min(1.16, (innerHeight - 56) / (app.land ? 402 : 874), (innerWidth - 60) / (app.land ? 874 : 402)); dev.style.setProperty('--k', k.toFixed(4)); dev.classList.toggle('land', app.land); app.k = k; } else app.land = innerWidth > innerHeight;
  body.classList.toggle('land', app.land); const el = $('#screen'); const cw = phone ? el.clientWidth : w, ch = phone ? el.clientHeight : h; app.cw = cw; app.ch = ch; W = Math.round(cw * scale); H = Math.round(ch * scale); renderer.setSize(W, H, false); gl.style.width = cw + 'px'; gl.style.height = ch + 'px'; pipe.resize(W, H); pipe.u.uScale.value = scale; env.uDot.value = 4.6 * scale; view.uRes.value.set(W, H); view.uPx.value = scale; rig.land = dir.land = app.land; ui?.layout(); if (app.mode === 'ambient' && app.lastLand !== app.land && dir.seq != null) dir.next(); app.lastLand = app.land;
}
app.rotate = () => { app.land = !app.land; layout(); }; app.layout = layout;
let ui = null; let rt = 0; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 60); });

// ---------------------------------------------------------------- 分镜遮罩（写深度挡住格外的像素）
const maskGeo = new THREE.BufferGeometry(); maskGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 6 * 3), 3)); maskGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
const mask = new THREE.Mesh(maskGeo, new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: 'precision highp float; in vec3 position; void main(){ gl_Position=vec4(position.xy,-1.,1.); }', fragmentShader: 'precision highp float; layout(location=0) out vec4 a; layout(location=1) out vec4 b; void main(){ a=vec4(0.); b=vec4(0.); }', colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth, side: THREE.DoubleSide })); mask.frustumCulled = false; mask.renderOrder = -1000; mask.visible = false;
function setMask(poly, rect) {
  const a = maskGeo.attributes.position.array; a.fill(0); let n = 0; const pts = poly.map(([x, y]) => [(x - rect[0]) / rect[2] * 2 - 1, 1 - (y - rect[1]) / rect[3] * 2]); const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; let dx = q[0] - p[0], dy = q[1] - p[1]; const l = Math.hypot(dx, dy); if (l < 1e-4) continue; dx /= l; dy /= l; let nx = dy, ny = -dx; if ((cx - p[0]) * nx + (cy - p[1]) * ny > 0) { nx = -nx; ny = -ny; } const E = 8; const A = [p[0] - dx * E, p[1] - dy * E], B = [q[0] + dx * E, q[1] + dy * E], C = [B[0] + nx * E, B[1] + ny * E], D = [A[0] + nx * E, A[1] + ny * E]; for (const v of [A, B, C, A, C, D]) { a[n++] = v[0]; a[n++] = v[1]; a[n++] = 0; } }
  maskGeo.attributes.position.needsUpdate = true; maskGeo.setDrawRange(0, n / 3);
}
function draw(panels) {
  const rt = pipe.main; rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false; renderer.setRenderTarget(rt); renderer.clear(true, true, false);
  for (const p of panels) {
    const xs = p.poly.map((q) => q[0]), ys = p.poly.map((q) => q[1]); const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; const px = Math.round(rect[0] * W), py = Math.round((1 - rect[1] - rect[3]) * H), pw = Math.round(rect[2] * W), ph = Math.round(rect[3] * H); if (pw < 2 || ph < 2 || py >= H || py + ph <= 0) continue;
    const lens = p.lens; lens.h = ph; lens.apply(pw / ph, world.t); rt.viewport.set(px, py, pw, ph); const sy = Math.max(0, py), sh = Math.min(H, py + ph) - sy, sx = Math.max(0, px), sw = Math.min(W, px + pw) - sx; if (sh <= 0 || sw <= 0) continue; rt.scissor.set(sx, sy, sw, sh); rt.scissorTest = true; renderer.setRenderTarget(rt); renderer.clear(false, true, false); view.uRes.value.set(pw, ph);
    if (p.full) mask.visible = false; else { setMask(p.poly, rect); mask.visible = true; } renderer.render(world.scene, lens.cam);
  }
  mask.visible = false; rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false; view.uRes.value.set(W, H); pipe.finish(null);
}

// ---------------------------------------------------------------- 画面效果
const fx = { impact: 0, wave: null, speed: 0, shake: 0 };
app.impact = (k = 1) => { if (!reduced) fx.impact = .085 * k; fx.shake = 1.2 * k; };
app.wave = (p, col, amp = 1) => { const s = app.project(p); fx.wave = { x: s.x, y: s.y, t: 0, amp }; pipe.u.uWaveCol.value.copy(col).multiplyScalar(.35); };
app.project = (p) => { const v = V().copy(p).project(rig.lens.cam); return { x: v.x * .5 + .5, y: v.y * .5 + .5, z: v.z }; };
app.unproject = (x, y, d) => { const v = new THREE.Vector3(x * 2 - 1, (1 - y) * 2 - 1, .5).unproject(rig.lens.cam); const o = rig.lens.cam.position; return v.sub(o).normalize().multiplyScalar(d).add(o); };
// 连接 / 断开：颜色从枢纽漫开 / 退回线稿
app.connect = () => { if (world.online && app.flood.target > 1) return; world.online = 1; app.flood.target = 1.75; app.offline = false; body.classList.remove('off'); const p = V(); app.wave(p, new THREE.Color('#ffffff'), 1.2); fx.shake = .8; world.portalPulse(new THREE.Color('#bfe6ff')); ui?.net(true); sim?.resume(); };
app.disconnect = () => { if (!world.online) return; world.online = 0; body.classList.add('off'); app.offline = true; app.flood.target = 0; if (app.flood.r > 1.75) app.flood.r = 1.75; ui?.net(false); sim?.pause(); };

// ---------------------------------------------------------------- 模式
app.touchIdle = () => { app.idleT = 0; };
app.toFleet = () => { app.touchIdle(); app.mode = 'fleet'; rig.mTarget = 0; rig.goHome = 1; body.classList.remove('focus', 'ambient'); ui.mode('fleet'); };
app.toFocus = (i, jump) => { app.touchIdle(); const n = world.ships.length; if (app.mode === 'focus') { let d = i - (((rig.uTarget % n) + n) % n); if (d > n / 2) d -= n; if (d < -n / 2) d += n; rig.uTarget = Math.round(rig.uTarget) + d; } else { rig.u = rig.uTarget = i; } rig.zoom = 1; rig.orbit = 0; app.mode = 'focus'; rig.mTarget = 1; if (jump) rig.m = 1; body.classList.remove('ambient'); body.classList.add('focus'); ui.mode('focus'); ui.ship(world.ships[i]); };
app.cur = () => { const n = world.ships.length; return world.ships[((Math.round(rig.uTarget) % n) + n) % n]; };
app.toAmbient = () => { if (app.mode === 'ambient' || app.offline) return; app.prev = app.mode; app.mode = 'ambient'; body.classList.remove('focus'); body.classList.add('ambient'); rig.mTarget = 0; dir.start(rig.lens); world.todSpeed = .011; ui.mode('ambient'); app.wake(true); };
app.leaveAmbient = (x, y) => {
  let hit = null; const pg = dir.page; if (pg && dir.turn >= 1) for (const p of pg.panels) if (inside(p.poly, x, y)) hit = p; world.todSpeed = 0; app.wake(false); app.mode = 'fleet'; body.classList.remove('ambient'); const src = hit || pg.panels[0];
  app.zoomPanel = { poly: src.poly.map((q) => [...q]), from: src.poly.map((q) => [...q]), t: 0, others: pg.panels.filter((p) => p !== src) }; const L = src.lens; rig.lens.pos.copy(L.pos); rig.lens.tgt.copy(L.tgt); rig.lens.fov = L.cam.fov; rig.lens.lift = L.lift; rig.k = .8; dir.page = dir.old = null; if (src.ship) app.toFocus(src.ship.index, true); else { rig.m = 0; app.toFleet(); } ui.frames([]);
};
app.wake = async (on) => { try { if (on && phone) app.lock = await navigator.wakeLock?.request('screen'); else { await app.lock?.release(); app.lock = null; } } catch { } };
const inside = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

// ---------------------------------------------------------------- 主循环
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]]; let sim = null; let last = 0, fpsT = 0, fpsN = 0, slowN = 0; const halo = $('#halo'), hc = halo.getContext('2d', { alpha: false }); halo.width = 64; halo.height = 64;
function frame(now) {
  requestAnimationFrame(frame); if (document.hidden) return; if (phone && app.mode === 'ambient' && now - last < 30) return; let dt = Math.min(.05, (now - last) / 1000 || .016); last = now; if (app.freeze) dt = 0; dt *= app.slow; app.time += dt; tick(dt);
}
function tick(dt) {
  world.step(dt); sim?.step(dt); if (app.mode !== 'boot') { app.idleT += dt; if (app.mode !== 'ambient' && app.idleT > app.idleAfter && !ui.busy() && !app.offline && !app.demo) app.toAmbient(); }
  rig.k += (9 - rig.k) * (1 - Math.exp(-dt * .9)); rig.step(dt, world.t); if (app.mode === 'ambient') dir.step(dt, world.t);
  world.ghostStep(dt, rig.lens.pos, rig.lens.tgt, app.mode === 'focus' ? app.cur() : null, app.mode === 'focus' && rig.m > .3);
  // 面板
  let panels;
  if (app.mode === 'ambient' && dir.page) { const o = dir.offset(), g = 1.018; panels = []; const sh = (poly, k) => app.land ? poly.map(([x, y]) => [x + k, y]) : poly.map(([x, y]) => [x, y + k]); if (dir.old) for (const p of dir.old.panels) panels.push({ poly: sh(p.poly, -(1 - o) * g), lens: p.lens, full: false, p }); for (const p of dir.page.panels) panels.push({ poly: sh(p.poly, o * g), lens: p.lens, full: dir.page.panels.length === 1 && o < .0005, p }); ui.frames(panels); ui.captions(dir); }
  else if (app.zoomPanel) { const z = app.zoomPanel; z.t = Math.min(1, z.t + dt / .55); const e = ease(z.t); const src = z.from; const to = src.length === 4 ? cornerMatch(src) : FULL; const poly = src.map((q, i) => [q[0] + (to[i][0] - q[0]) * e, q[1] + (to[i][1] - q[1]) * e]); panels = []; z.others.forEach((p) => panels.push({ poly: p.poly, lens: p.lens, full: false })); panels.push({ poly, lens: rig.lens, full: z.t >= 1 }); ui.frames(z.t >= 1 ? [] : panels); if (z.t >= 1) app.zoomPanel = null; }
  else panels = [{ poly: FULL, lens: rig.lens, full: true }];
  const shipsIn = panels.map((p) => p.p?.ship).filter(Boolean); const hero = app.mode === 'focus' && rig.m > .35 ? app.cur() : shipsIn[0] || null;
  for (const p of panels) p.lens.cam.position.copy(p.lens.pos); world.lod(panels.map((p) => { p.lens.h = H * Math.max(.2, Math.max(...p.poly.map((q) => q[1])) - Math.min(...p.poly.map((q) => q[1]))); return p.lens; })); app.fi = (app.fi || 0) + 1; if (!quality.lite || app.fi % 3 === 0 || hero !== app.lastHero) { world.shadowPass(hero); app.lastHero = hero; }
  // 后期
  const u = pipe.u; u.uTime.value = world.t; u.uInkCol.value.copy(world.sky.ink); fx.impact = Math.max(0, fx.impact - dt); u.uImpact.value = fx.impact > .045 ? 1 : fx.impact > 0 ? .3 : 0; fx.shake *= Math.exp(-dt * 5); rig.lens.shake = reduced ? 0 : fx.shake; if (fx.wave) { const w = fx.wave; w.t += dt / .95; u.uWaveC.value.set(w.x, w.y); u.uWave.value.set(ease(Math.min(1, w.t)) * 1.5, .06 + w.t * .10, Math.max(0, 1 - w.t) * w.amp, 0); if (w.t >= 1) { fx.wave = null; u.uWave.value.z = 0; } }
  const sp = app.mode === 'ambient' || reduced || app.mode === 'boot' ? 0 : rig.rush || 0; fx.speed += (sp - fx.speed) * (1 - Math.exp(-dt * (sp > fx.speed ? 14 : 5))); u.uSpeed.value = fx.speed; u.uChroma.value = fx.speed * .8; u.uSpeedC.value.set(.5, .56);
  const F = app.flood; const tgt = F.target; if (F.r !== tgt) { const rate = tgt > F.r ? .20 + F.r * .62 : 1.0; F.r = tgt > F.r ? Math.min(tgt, F.r + dt * rate) : Math.max(tgt, F.r - dt * rate); } const c = app.project(_o); if (app.mode === 'ambient') { u.uFlood.value.z = 4; } else { u.uFlood.value.set(THREE.MathUtils.clamp(c.x, .1, .9), THREE.MathUtils.clamp(c.y, .1, .9), F.r >= 1.74 ? 4 : F.r, tgt > F.r ? 1 : .4); } const paper = F.r < .62; if (paper !== app.paper) { app.paper = paper; body.classList.toggle('paper', paper); }
  draw(panels); ui.step(dt);
  if (!phone && (app.hn = (app.hn || 0) + 1) % 5 === 0) { hc.drawImage(gl, 0, 0, 64, 64); }
  if (!app.freeze) perf();
}
const _o = new THREE.Vector3();
const cornerMatch = (src) => { // 让四角各自去最近的屏幕角
  const cs = FULL; const cx = src.reduce((s, p) => s + p[0], 0) / 4, cy = src.reduce((s, p) => s + p[1], 0) / 4; return src.map(([x, y]) => [x < cx ? 0 : 1, y < cy ? 0 : 1]); };
// 自适应：掉帧先降分辨率，降到底还不够就进省力档（采样、阴影、泛光都减半）
function perf() {
  const now = performance.now(); if (!fpsT) fpsT = now; fpsN++; const T = (now - fpsT) / 1000; if (T < 1.2) return; const fps = fpsN / T; app.fps = fps; fpsT = now; fpsN = 0; if (T > 3 || (phone && app.mode === 'ambient')) return; // 切到后台的间隔不算
  const want = fps < 24 ? 2 : fps < 42 ? 1 : 0; if (!want) { slowN = 0; return; } if (++slowN < 2 && want < 2) return; slowN = 0;
  if (scale > 1.05) { scale = Math.max(1, want === 2 ? scale * .62 : scale - .25); layout(); } else if (!quality.lite) { quality.lite = true; quality.samples = 2; quality.bloomLevels = 4; quality.lodPx = 170; layout(); } else if (fps < 24 && scale > .7) { scale = .7; layout(); }
}
// 显卡上下文丢失（切后台、驱动重启）后重新烘焙背景
gl.addEventListener('webglcontextrestored', () => setTimeout(() => { try { world.sky.bake(renderer, quality); layout(); } catch { location.reload(); } }, 60));
app.setScale = (k) => { scale = k; layout(); };

app.debugShot = (key, i, u) => { const s = key === 'g' ? null : world.byKey[key]; const h = key === 'g' ? dir.generic()[i] : key === 'gate' ? dir.gateShot(world.ships.find((x) => x.state === 'wait')) : s.work.shots()[i]; if (!h) return null; app.mode = 'ambient'; body.classList.add('ambient'); body.classList.remove('focus'); dir.old = null; dir.turn = 1; const lens = dir.lenses[0]; dir.page = { panels: [{ poly: FULL, shot: { ...h, cam: (t, _, o) => h.cam(t, u, o) }, ship: s, lens, fresh: true }], t: 0, T: 1e9 }; return h.key; };
// ---------------------------------------------------------------- 启动
// 单文件版：模型以 gzip+base64 内嵌；开发版：从 packs/ 读取
async function getPack(k) { const el = document.getElementById('pk-' + k); if (el) { const b64 = el.textContent; el.remove(); let a; if (Uint8Array.fromBase64) a = Uint8Array.fromBase64(b64); else { const bin = atob(b64); a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); } return new Response(new Blob([a]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); } if (window.__SINGLE) throw 0; if (!getPack.list) getPack.list = fetch('packs/index.json').then((r) => r.json()); if (!(await getPack.list).includes(k)) throw 0; const r = await fetch('packs/' + k + '.pack'); if (!r.ok) throw 0; return r.arrayBuffer(); }
(async () => {
  body.classList.add('booting', 'paper'); app.paper = true; layout(); const boot = $('#boot'); await world.load(getPack, (p) => boot.firstElementChild.style.setProperty('--p', p.toFixed(3))); world.scene.add(mask);
  const hr = new Date().getHours(); app.localTod = hr < 5 || hr >= 20 ? 3 : hr < 8 ? 0 : hr < 16 ? 1 : 2; world.tod = Q.has('tod') ? +Q.get('tod') : app.localTod; world.online = 0; world.powerK = 0; pipe.u.uBloom.value = .72;
  ui = app.ui = new UI(app); sim = app.sim = new Sim(app); layout(); boot.style.opacity = 0; rig.dist = 96; rig.yaw = -8; rig.lens.snap(rig.fleetPose(0)); app.flood.r = 0; pipe.u.uInkA.value = 0; last = performance.now(); requestAnimationFrame(frame);
  const skip = Q.has('skip'); const tw = (T, f) => new Promise((res) => { const t0 = app.time; const go = () => { const u = Math.min(1, (app.time - t0) / T); f(u); u < 1 ? requestAnimationFrame(go) : res(); }; go(); });
  if (skip) { world.online = 1; world.powerK = 1; app.flood.r = app.flood.target = 4; pipe.u.uInkA.value = 1; rig.dist = 72; rig.yaw = 18; rig.lens.snap(rig.fleetPose(0)); app.mode = 'fleet'; body.classList.remove('booting'); sim.begin(); app.ready = true; return; }
  tw(1.5, (u) => { pipe.u.uInkA.value = ease(u); }); const d0 = rig.dist, y0 = rig.yaw; tw(4.6, (u) => { const e = ease(u); rig.dist = d0 + (72 - d0) * e; rig.yaw = y0 + (18 - y0) * e; });
  await tw(1.5, () => {}); const from = app.unproject(.5, .93, 14); world.shot(from, from.clone().lerp(_o, .35).add(new THREE.Vector3(0, 3, 1)), from.clone().lerp(_o, .75).add(new THREE.Vector3(0, 2, 4)), new THREE.Vector3(0, 0, .8), { T: .8, col: new THREE.Color('#3f6fb8'), shape: 10, size: .5, w: .09, done: () => { app.connect(); } });
  await tw(2.4, () => {}); app.mode = 'fleet'; body.classList.remove('booting'); sim.begin(); app.ready = true;
})();
