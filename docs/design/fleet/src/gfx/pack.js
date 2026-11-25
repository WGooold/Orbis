// 读取 export_pack.py 生成的 .pack，组装成带可动部件的模型
import * as THREE from 'three';
import { celMaterial, depthMaterial } from './cel.js';

const NOMASK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); NOMASK.needsUpdate = true;
export function parsePack(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x3150464f) throw new Error('bad pack');
  const n = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n)));
  const base = 8 + n;
  head.lods.forEach((parts) => parts.forEach((p) => {
    p.pos = new Int16Array(buf, base + p.v, p.nv * 4);
    p.aux = new Uint8Array(buf, base + p.x, p.nv * 4);
    p.uv = new Int16Array(buf, base + p.t, p.nv * 2);
    p.idx = p.u32 ? new Uint32Array(buf, base + p.i, p.ni) : new Uint16Array(buf, base + p.i, p.ni);
  }));
  const ramp = new THREE.DataTexture(new Uint8Array(buf, base + head.ramp, head.rampW * (head.rampRows || head.mats.length) * 4).slice(), head.rampW, head.rampRows || head.mats.length);
  ramp.colorSpace = THREE.SRGBColorSpace; ramp.magFilter = THREE.LinearFilter; ramp.minFilter = THREE.LinearFilter; ramp.needsUpdate = true;
  const W = 5; const f = new Float32Array(W * head.mats.length * 4);
  head.mats.forEach((m, i) => {
    f.set([m.tex, m.ao, m.spec, m.rough], (i * W + 0) * 4);
    f.set([m.specLo, m.specHi, m.rim, m.alpha], (i * W + 1) * 4);
    f.set([...m.rimCol, m.cls], (i * W + 2) * 4);
    f.set([...m.emit, 0], (i * W + 3) * 4);
    f.set([m.rimLo ?? .64, m.rimHi ?? .72, m.ramp2 != null ? head.mats.length + m.ramp2 : -1, 0], (i * W + 4) * 4);
  });
  const params = new THREE.DataTexture(f, W, head.mats.length, THREE.RGBAFormat, THREE.FloatType);
  params.needsUpdate = true;
  head.rampTex = ramp; head.paramTex = params;
  head.maskTex = NOMASK;
  if (head.mask) { const t = new THREE.Texture(); t.colorSpace = THREE.NoColorSpace; t.flipY = true; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; head.maskTex = t; const url = URL.createObjectURL(new Blob([new Uint8Array(buf, base + head.mask[0], head.mask[1])], { type: 'image/png' })); const im = new Image(); im.onload = () => { t.image = im; t.needsUpdate = true; URL.revokeObjectURL(url); }; im.src = url; }
  return head;
}

function geometry(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.pos, 4, true));
  g.setAttribute('aux', new THREE.BufferAttribute(p.aux, 4, false));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2, true));
  g.setIndex(new THREE.BufferAttribute(p.idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.75);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  return g;
}

// 一个模型实例：static + 各可动部件，两级精度
export class Model {
  constructor(head, shared, opt = {}) {
    this.head = head; this.root = new THREE.Group(); this.rigs = {}; this.lodGroups = [];
    this.uniforms = {
      uRamp: { value: head.rampTex }, uParam: { value: head.paramTex }, uMask: { value: head.maskTex }, uMatN: { value: head.rampRows || head.mats.length }, uUvq: { value: head.uvq },
      uEngine: { value: .25 }, uWindow: { value: 1 }, uBeacon: { value: 0 }, uTrim: { value: 1 }, uPortal: { value: 0 },
      uSketch: { value: 0 }, uFlash: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) }, uTint: { value: new THREE.Color(1, 1, 1) }, uLine: { value: new THREE.Color(0, 0, 0) },
      uStretch: { value: 0 }, uHalf: { value: head.half }, uCenter: { value: new THREE.Vector3(...head.center) }, uReveal: { value: 1 }, uShadowSel: { value: opt.shadowSel ?? 0 }, uDim: { value: 1 }, uInk: { value: 1 }, uGhost: { value: 0 }, uIdOff: { value: Math.random() * .37 }, uPowerRing: { value: new THREE.Vector4(1, 0, 0, 0) },
    };
    this.mat = celMaterial(this.uniforms, shared);
    this.glassMat = celMaterial(this.uniforms, shared, true);
    this.depthMat = depthMaterial(this.uniforms);
    head.lods.forEach((parts, li) => {
      const lg = new THREE.Group(); this.lodGroups.push(lg); this.root.add(lg);
      parts.forEach((p) => {
        const mesh = new THREE.Mesh(geometry(p), p.glass ? this.glassMat : this.mat);
        mesh.scale.setScalar(head.half);
        mesh.renderOrder = p.glass ? 5 : 0;
        mesh.frustumCulled = true;
        mesh.userData.cast = !p.glass; mesh.userData.depthMat = this.depthMat;
        mesh.castOK = !p.glass;
        let parent = lg;
        if (p.rig !== 'static') {
          const key = p.rig;
          const r = this.rigs[key] || (this.rigs[key] = { nodes: [], pivot: new THREE.Vector3(...p.pivot), axis: p.axis });
          let node = r.nodes[li];
          if (!node) { node = new THREE.Group(); node.position.copy(r.pivot); r.nodes[li] = node; lg.add(node); }
          parent = node;
          mesh.position.set(head.center[0] - r.pivot.x, head.center[1] - r.pivot.y, head.center[2] - r.pivot.z);
        } else mesh.position.set(...head.center);
        parent.add(mesh);
      });
    });
    this.radius = head.half * 1.15;
    this.setLod(opt.lod ?? 0);
  }
  setLod(i) { if (this.lod === i) return; this.lod = i; this.lodGroups.forEach((g, k) => { g.visible = k === i; }); }
  rig(name, fn) { const r = this.rigs[name]; if (r) r.nodes.forEach((n) => fn(n, r)); }
}

// 同一个小件的大量实例：每个实例有自己的颜色、线稿程度、闪光、显现、引擎
export class Swarm {
  constructor(head, count, opt = {}) {
    this.head = head; this.count = count;
    this.uniforms = {
      uRamp: { value: head.rampTex }, uParam: { value: head.paramTex }, uMask: { value: head.maskTex }, uMatN: { value: head.rampRows || head.mats.length }, uUvq: { value: head.uvq },
      uEngine: { value: .8 }, uWindow: { value: 1 }, uBeacon: { value: .6 }, uTrim: { value: 1 }, uPortal: { value: 0 }, uSketch: { value: 0 }, uFlash: { value: 0 }, uFlashCol: { value: new THREE.Color(1, 1, 1) },
      uTint: { value: new THREE.Color(1, 1, 1) }, uLine: { value: new THREE.Color() }, uStretch: { value: 0 }, uReveal: { value: 1 }, uShadowSel: { value: opt.shadow ?? 0 }, uDim: { value: 1 }, uInk: { value: 1 }, uGhost: { value: 0 }, uIdOff: { value: 0 }, uPowerRing: { value: new THREE.Vector4(1, 0, 0, 0) },
      uHalf: { value: head.half }, uCenter: { value: new THREE.Vector3(...head.center) },
    };
    this.mat = celMaterial(this.uniforms, null, false, true);
    const p = head.lods[opt.lod ?? 0].find((x) => !x.glass); const g = geometry(p);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(count * 4).fill(1), 4); this.fx = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    for (let i = 0; i < count; i++) { this.tint.setW(i, 0); this.fx.setXYZW(i, 0, 1, .8, 0); }
    g.setAttribute('iTint', this.tint); g.setAttribute('iFx', this.fx);
    this.mesh = new THREE.InstancedMesh(g, this.mat, count); this.mesh.frustumCulled = false; this.mesh.userData.cast = false; this.mesh.userData.depthMat = this.mat;
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this.zero);
    this._m = new THREE.Matrix4(); this.used = new Array(count).fill(false);
  }
  alloc() { const i = this.used.indexOf(false); if (i >= 0) this.used[i] = true; return i; }
  free(i) { if (i < 0) return; this.used[i] = false; this.mesh.setMatrixAt(i, this.zero); this.mesh.instanceMatrix.needsUpdate = true; }
  set(i, p, q, s) { if (i < 0) return; this._m.compose(p, q, s); this.mesh.setMatrixAt(i, this._m); this.mesh.instanceMatrix.needsUpdate = true; }
  look(i, color, sketch = 0, flash = 0, reveal = 1, engine = .8) { if (i < 0) return; this.tint.setXYZW(i, color.r, color.g, color.b, sketch); this.fx.setXYZW(i, flash, reveal, engine, 0); this.tint.needsUpdate = this.fx.needsUpdate = true; }
}
