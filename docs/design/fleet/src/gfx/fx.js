// 特效：讯息粒子、光束、涟漪、尾焰、拖尾、牵引光、传送门、信纸
import * as THREE from 'three';
import { COMMON, MRT_OUT } from './glsl.js';
import { env } from './cel.js';

export const view = { uRes: { value: new THREE.Vector2(1, 1) }, uPx: { value: 1 } };
const HEAD = `${COMMON}uniform mat4 modelMatrix,viewMatrix,projectionMatrix; uniform vec3 cameraPosition; uniform float uTime; uniform vec2 uRes; uniform float uPx;\n`;
export function fxMat(vs, fs, uniforms, opt = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: HEAD + vs, fragmentShader: `${COMMON}${MRT_OUT}uniform float uTime;\n` + fs, uniforms: { uTime: env.uTime, ...view, ...uniforms },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: opt.over ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: opt.over ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor, ...opt.mat,
  });
}
export const SHAPE = { comet: 0, spark: 1, claude: 2, codex: 3, kimi: 4, opencode: 5, openclaw: 6, pi: 7, deepseek: 8, hermes: 9, dot: 10, puff: 11, page: 12 };

// ---------------------------------------------------------------- 粒子
export class Sprites {
  constructor(max = 1400) {
    this.max = max; this.n = 0; this.items = [];
    const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.a = { iPos: mk(3), iVel: mk(3), iData: mk(4), iCol: mk(4) }; for (const k in this.a) g.setAttribute(k, this.a[k]);
    g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); this.g = g;
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`
in vec3 position; in vec3 iPos; in vec3 iVel; in vec4 iData; in vec4 iCol; out vec2 vQ; out vec4 vC; flat out float vS; out float vStretch;
void main(){
  vec4 c=viewMatrix*vec4(iPos,1.); vec3 v=(viewMatrix*vec4(iVel,0.)).xyz; float sp=length(v.xy);
  float size=iData.x; float px=size*projectionMatrix[1][1]*uRes.y*.5/max(-c.z,.01); float al=1.; float mn=1.15*uPx; if(px<mn){ al=px/mn; size*=mn/max(px,.001); }
  float st=iData.y*length(v); vec2 d=sp>1e-4?v.xy/sp:vec2(1.,0.); float ca=cos(iData.w),sa=sin(iData.w);
  vec2 q=position.xy; vec2 p;
  if(iData.y>0.){ p=vec2(q.x*(size+st*.5)-st*.5,q.y*size); p=d*p.x+vec2(-d.y,d.x)*p.y; } else { p=vec2(ca*q.x-sa*q.y,sa*q.x+ca*q.y)*size; }
  c.xy+=p; gl_Position=projectionMatrix*c; vQ=q; vC=iCol*vec4(1.,1.,1.,al); vS=iData.z; vStretch=iData.y>0.?1.+st/size:1.;
}`, /* glsl */`
in vec2 vQ; in vec4 vC; flat in float vS; in float vStretch;
float box(vec2 p,vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.))+min(max(d.x,d.y),0.); }
void main(){
  int s=int(vS+.5); vec2 q=vQ; float a=0.,core=0.; 
  if(s==0){ vec2 p=vec2((q.x*.5+.5)*vStretch,q.y); float L=vStretch; float hx=L-1.; float w=mix(.05,.62,pow(sat(p.x/max(hx,.01)),1.6)); float tail=step(p.x,hx)*(1.-smoothstep(w*.7,w,abs(p.y)))*pow(sat(p.x/max(hx,.01)),1.3); float hd=length(vec2(p.x-hx,p.y)); float head=1.-smoothstep(.5,.62,hd); a=max(tail*.75,head); core=max(1.-smoothstep(.2,.42,hd),tail*.35); a+=exp(-hd*hd*3.)*.25; }
  else if(s==1){ float w=1.-smoothstep(.1,.5,abs(q.y)); float l=smoothstep(-1.,.6,q.x)*(1.-smoothstep(.75,1.,q.x)); a=w*l; core=a*.9; }
  else if(s==2){ float r=length(q); float an=atan(q.y,q.x); float k=abs(fract(an/6.28318*8.)-.5)*2.; float ray=mix(.16,.95,smoothstep(.25,1.,1.-k)); ray=mix(.2,.95,pow(1.-k,1.6)); a=1.-smoothstep(ray-.08,ray+.04,r); core=(1.-smoothstep(.2,.5,r))*a; }
  else if(s==3){ vec2 p=abs(q); float h=max(p.x*.866+p.y*.5,p.y); float o=1.-smoothstep(.74,.82,h); float in_=1.-smoothstep(.40,.48,h); a=o-in_*.85; core=(1.-smoothstep(.06,.2,abs(h-.6)))*o; a=max(a,0.); }
  else if(s==4){ vec2 p=abs(q); float st=pow(p.x,.55)+pow(p.y,.55); a=1.-smoothstep(.86,1.0,st); core=1.-smoothstep(.3,.7,st); }
  else if(s==5){ float d=box(q,vec2(.62)); float o=1.-smoothstep(0.,.07,d); float i=1.-smoothstep(0.,.07,box(q,vec2(.34))); a=o*(1.-i); core=a*.35; a+=i*.12; }
  else if(s==6){ vec2 p=q; float r=length(p); float an=abs(atan(p.y,p.x)); float arc=(1.-smoothstep(.12,.2,abs(r-.62)))*smoothstep(.5,.7,an); a=arc; a=max(a,1.-smoothstep(.2,.28,r)); core=a*.5; }
  else if(s==7){ float d=box(q,vec2(.6,.6)); a=1.-smoothstep(0.,.08,d); core=(1.-smoothstep(0.,.1,box(q,vec2(.3))))*.5; }
  else if(s==8){ float r=length(q); a=(1.-smoothstep(.06,.14,abs(r-.74)))+(1.-smoothstep(.2,.32,r)); core=a*.5; }
  else if(s==9){ vec2 p=abs(q); float d=p.x*1.0+p.y*1.7; a=1.-smoothstep(.82,.92,d); core=1.-smoothstep(.3,.6,d); }
  else if(s==10){ float r=length(q); a=exp(-r*r*4.5)-.011; a=max(a,0.); core=exp(-r*r*18.); }
  else if(s==11){ float r=length(q); float n=vnoise(q*2.6+vC.a*9.); a=1.-smoothstep(.62+n*.3-.05,.62+n*.3,r); core=0.; a*=.55; }
  if(a<.004) discard;
  vec3 col=mix(vC.rgb,vec3(1.)*max(max(vC.r,vC.g),vC.b),core*.85);
  oColor=vec4(col*a*vC.a,0.); oAux=vec4(0.);
}`, {}));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 20;
  }
  // 发射：p 位置 v 速度；fn(item, dt) 可自定义运动，返回 false 结束
  emit(o) { if (this.items.length >= this.max) return null; const it = { p: new THREE.Vector3(), v: new THREE.Vector3(), life: 1, age: 0, size: .2, size1: null, stretch: 0, shape: 10, rot: 0, spin: 0, col: new THREE.Color(1, 1, 1), k: 1.4, drag: 0, grav: 0, fn: null, ...o }; if (o.p) it.p = o.p.clone(); if (o.v) it.v = o.v.clone(); if (o.col) it.col = new THREE.Color(o.col); this.items.push(it); return it; }
  update(dt) {
    const A = this.a; let n = 0; const out = [];
    for (const it of this.items) {
      it.age += dt; if (it.age < 0) { out.push(it); continue; }
      const u = it.age / it.life;
      if (u >= 1) { it.done?.(it); continue; }
      if (it.fn) { if (it.fn(it, dt, u) === false) { it.done?.(it); continue; } }
      else { it.v.multiplyScalar(Math.max(0, 1 - it.drag * dt)); it.v.y -= it.grav * dt; it.p.addScaledVector(it.v, dt); }
      it.rot += it.spin * dt;
      const fade = it.fade ? it.fade(u) : Math.min(1, u * 10) * (1 - Math.pow(u, 3)); const sz = it.size1 == null ? it.size : it.size + (it.size1 - it.size) * u;
      A.iPos.setXYZ(n, it.p.x, it.p.y, it.p.z); A.iVel.setXYZ(n, it.v.x, it.v.y, it.v.z); A.iData.setXYZW(n, sz, it.stretch, it.shape, it.rot); A.iCol.setXYZW(n, it.col.r * it.k, it.col.g * it.k, it.col.b * it.k, fade);
      n++; out.push(it);
    }
    this.items = out; this.g.instanceCount = n; for (const k in A) { A[k].needsUpdate = true; A[k].clearUpdateRanges(); A[k].addUpdateRange(0, n * A[k].itemSize); }
  }
}

// ---------------------------------------------------------------- 光束：三次贝塞尔带
const STRIP = (() => { const N = 56, p = []; for (let i = 0; i <= N; i++) p.push(i / N, -1, 0, i / N, 1, 0); const ix = []; for (let i = 0; i < N; i++) { const a = i * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); return g; })();
export class Beam {
  constructor() {
    this.u = { uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uC: { value: new THREE.Vector3() }, uD: { value: new THREE.Vector3() }, uW: { value: .05 }, uCol: { value: new THREE.Color() }, uFrom: { value: 0 }, uTo: { value: 1 }, uFlow: { value: 1 }, uDash: { value: 14 }, uAlpha: { value: 1 }, uMode: { value: 0 } };
    this.mesh = new THREE.Mesh(STRIP, fxMat(/* glsl */`
in vec3 position; uniform vec3 uA,uB,uC,uD; uniform float uW,uFrom,uTo; out float vT; out float vS; out float vL;
vec3 bz(float t){ float m=1.-t; return uA*m*m*m+uB*3.*m*m*t+uC*3.*m*t*t+uD*t*t*t; }
void main(){ float t=mix(uFrom,uTo,position.x); vec3 p=bz(t); vec3 d=normalize(bz(min(t+.01,1.001))-bz(max(t-.01,-.001))+1e-6); vec3 v=normalize(cameraPosition-p); vec3 s=normalize(cross(d,v)+1e-6); float dist=length(cameraPosition-p); float mn=.9*uPx*dist*2./(projectionMatrix[1][1]*uRes.y); float w=max(uW,mn); p+=s*position.y*w; vT=t; vS=position.y; vL=length(uD-uA); gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); }`, /* glsl */`
in float vT; in float vS; in float vL; uniform vec3 uCol; uniform float uAlpha,uFlow,uDash,uFrom,uTo; uniform float uMode;
void main(){
  float e=abs(vS); float core=1.-smoothstep(.18,.42,e); float body=1.-smoothstep(.55,1.,e); float a;
  float ends=smoothstep(uFrom,uFrom+.04,vT)*(1.-smoothstep(uTo-.04,uTo+.001,vT));
  if(uMode<.5){ float f=fract(vT*uDash-uTime*uFlow); float d=smoothstep(.0,.06,f)*(1.-smoothstep(.34,.52,f)); a=body*(.16+.9*d); }
  else if(uMode<1.5){ a=body*(.75+.25*sin(vT*60.-uTime*30.)); }
  else { float f=fract(vT*uDash-uTime*uFlow); float tri=1.-abs(f-.5)*2.; a=body*smoothstep(.2,.35,tri-e*.5); }
  vec3 c=mix(uCol,vec3(1.),core*.7); oColor=vec4(c*a*ends*uAlpha,0.); oAux=vec4(0.); }`, this.u)); this.mesh.frustumCulled = false; this.mesh.renderOrder = 18; this.mesh.visible = false;
  }
  set(a, b, c, d) { this.u.uA.value.copy(a); this.u.uB.value.copy(b); this.u.uC.value.copy(c); this.u.uD.value.copy(d); return this; }
  at(t, out) { const m = 1 - t, A = this.u.uA.value, B = this.u.uB.value, C = this.u.uC.value, D = this.u.uD.value; return out.set(0, 0, 0).addScaledVector(A, m * m * m).addScaledVector(B, 3 * m * m * t).addScaledVector(C, 3 * m * t * t).addScaledVector(D, t * t * t); }
}

// ---------------------------------------------------------------- 涟漪
export class Rings {
  constructor(max = 40) {
    this.items = []; this.max = max; const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.a = { iP: mk(4), iQ: mk(4), iC: mk(4), iD: mk(4) }; for (const k in this.a) g.setAttribute(k, this.a[k]); g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); this.g = g;
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`
in vec3 position; in vec4 iP,iQ,iC,iD; out vec2 vQ; out vec4 vC; flat out vec4 vD;
vec3 qr(vec4 q,vec3 v){ return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v); }
void main(){ vec3 p=iP.xyz+qr(iQ,position*iP.w); vQ=position.xy; vC=iC; vD=iD; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); }`, /* glsl */`
in vec2 vQ; in vec4 vC; flat in vec4 vD;
void main(){ float r=length(vQ); if(r>1.) discard; float w=vD.x; float aa=fwidth(r); float ring=smoothstep(1.-w-aa*1.5,1.-w,r)*(1.-smoothstep(1.-aa*2.,1.,r)); float an=atan(vQ.y,vQ.x)/6.28318;
  if(vD.y>.5){ float f=fract(an*vD.y+vD.z); ring*=smoothstep(.12,.16,f)*(1.-smoothstep(.84,.88,f)); }
  float inner=smoothstep(0.,1.,r)*step(r,1.-w)*vD.w*pow(r,6.); float a=ring+inner; if(a<.003) discard; oColor=vec4(mix(vC.rgb,vec3(1.),ring*.35)*a*vC.a,0.); oAux=vec4(0.); }`, {})); this.mesh.frustumCulled = false; this.mesh.renderOrder = 19;
  }
  emit(o) { if (this.items.length >= this.max) this.items.shift(); const it = { p: new THREE.Vector3(), q: new THREE.Quaternion(), r0: .2, r1: 4, life: 1, age: 0, w: .06, w1: null, dash: 0, spin: 0, fill: 0, k: 1.5, a: 1, col: new THREE.Color(1, 1, 1), ease: (u) => 1 - Math.pow(1 - u, 3), ...o }; if (o.p) it.p = o.p.clone(); if (o.n) it.q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.n.clone().normalize()); if (o.col) it.col = new THREE.Color(o.col); this.items.push(it); return it; }
  update(dt) {
    let n = 0; const A = this.a; this.items = this.items.filter((it) => (it.age += dt) < it.life);
    for (const it of this.items) { if (it.age < 0) continue; const u = it.age / it.life, r = it.r0 + (it.r1 - it.r0) * it.ease(u); const w = it.w1 == null ? it.w : it.w + (it.w1 - it.w) * u; if (it.follow) it.p.copy(it.follow()); A.iP.setXYZW(n, it.p.x, it.p.y, it.p.z, r); A.iQ.setXYZW(n, it.q.x, it.q.y, it.q.z, it.q.w); A.iC.setXYZW(n, it.col.r * it.k, it.col.g * it.k, it.col.b * it.k, it.a * (it.fade ? it.fade(u) : 1 - u * u)); A.iD.setXYZW(n, w, it.dash, it.spin * it.age, it.fill); n++; }
    this.g.instanceCount = n; for (const k in A) A[k].needsUpdate = true;
  }
}

// ---------------------------------------------------------------- 尾焰：沿船尾方向的面片
export class Plumes {
  constructor(engines, color, scale = 1) {
    const n = engines.length; const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
    const e = new Float32Array(n * 4), s = new Float32Array(n); engines.forEach((k, i) => { e.set([k.p[0], k.p[1], k.z ?? k.p[2], Math.max(.16, Math.min(k.w, k.h) * .5)], i * 4); s[i] = Math.random() * 10; });
    g.setAttribute('iE', new THREE.InstancedBufferAttribute(e, 4)); g.setAttribute('iS', new THREE.InstancedBufferAttribute(s, 1)); g.instanceCount = n; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.u = { uPow: { value: .4 }, uCol: { value: new THREE.Color(color) }, uLen: { value: 1 }, uWarp: { value: 0 }, uGain: { value: 1 / (1 + .16 * Math.max(0, n - 2)) } };
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`
in vec3 position; in vec4 iE; in float iS; uniform float uPow,uLen,uWarp; out vec2 vQ; out float vSeed;
void main(){ vec3 o=(modelMatrix*vec4(iE.xyz,1.)).xyz; vec3 d=normalize((modelMatrix*vec4(0.,0.,-1.,0.)).xyz); float sc=length((modelMatrix*vec4(0.,0.,1.,0.)).xyz); float r=iE.w*sc; float L=r*(2.2+uPow*uPow*11.*uLen)+uWarp*18.;
  vec3 v=normalize(cameraPosition-o); vec3 s=normalize(cross(d,v)+1e-6); float dist=length(cameraPosition-o); float mn=1.1*uPx*dist*2./(projectionMatrix[1][1]*uRes.y); float w=max(r*1.25,mn*1.4); vec3 p=o+d*(position.x*L-r*.2)+s*position.y*w; vQ=position.xy; vSeed=iS; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); }`, /* glsl */`
in vec2 vQ; in float vSeed; uniform vec3 uCol; uniform float uPow, uGain;
void main(){ float x=vQ.x,y=abs(vQ.y); float fl=vnoise(vec2(uTime*22.+vSeed*7.,x*5.-uTime*9.)); float wob=.86+.14*fl;
  float wOut=mix(.95,.10,pow(x,.5))*wob; float wIn=mix(.62,.0,pow(x*1.55,.62)); float wLine=.10*(1.-x);
  float o=(1.-smoothstep(wOut*.72,wOut,y))*(1.-smoothstep(.25,.95,x)); float i=(1.-smoothstep(wIn*.8,wIn+.02,y))*step(x,.66); float ln=(1.-smoothstep(wLine*.5,wLine,y))*(1.-smoothstep(.5,1.,x));
  float dia=.5+.5*sin(x*34.-uTime*40.); i*=.82+.18*dia; float a=o*.5+ln*.55; vec3 c=uCol*a*1.5+mix(uCol,vec3(1.),.82)*i*1.9; oColor=vec4(c*uGain*smoothstep(0.,.22,uPow)*(.45+.75*min(uPow,1.)),0.); oAux=vec4(0.); }`, this.u)); this.mesh.frustumCulled = false; this.mesh.renderOrder = 17;
  }
}

// ---------------------------------------------------------------- 拖尾
export class Trail {
  constructor(n = 48, color = '#fff', width = .06) {
    this.n = n; this.pts = []; const g = new THREE.BufferGeometry(); this.pos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage); this.nxt = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage); const s = new Float32Array(n * 2 * 2); for (let i = 0; i < n; i++) { s.set([i / (n - 1), -1, i / (n - 1), 1], i * 4); }
    const ix = []; for (let i = 0; i < n - 1; i++) { const a = i * 2; ix.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } g.setAttribute('position', this.pos); g.setAttribute('nxt', this.nxt); g.setAttribute('ts', new THREE.BufferAttribute(s, 2)); g.setIndex(ix); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.u = { uCol: { value: new THREE.Color(color) }, uW: { value: width }, uAlpha: { value: 1 }, uFlat: { value: 0 } };
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`
in vec3 position,nxt; in vec2 ts; uniform float uW; out vec2 vT;
void main(){ vec3 d=normalize(position-nxt+1e-6); vec3 v=normalize(cameraPosition-position); vec3 s=normalize(cross(d,v)+1e-6); float dist=length(cameraPosition-position); float mn=.75*uPx*dist*2./(projectionMatrix[1][1]*uRes.y); float w=max(uW*mix(1.,.25,ts.x),mn); vT=ts; gl_Position=projectionMatrix*viewMatrix*vec4(position+s*ts.y*w,1.); }`, /* glsl */`
in vec2 vT; uniform vec3 uCol; uniform float uAlpha; void main(){ float e=abs(vT.y); float b=1.-smoothstep(.55,1.,e); float c=1.-smoothstep(.1,.4,e); float f=pow(1.-vT.x,1.5); oColor=vec4(mix(uCol,vec3(1.),c*.45*f)*b*f*uAlpha,0.); oAux=vec4(0.); }`, this.u)); this.mesh.frustumCulled = false; this.mesh.renderOrder = 16; this.acc = 0;
  }
  reset(p) { this.pts = Array.from({ length: this.n }, () => p.clone()); this.write(); }
  push(p, dt, step = .03) { if (!this.pts.length) return this.reset(p); this.acc += dt; this.pts[0].copy(p); if (this.acc > step) { this.acc = 0; const last = this.pts.pop(); last.copy(p); this.pts.unshift(last); } this.write(); }
  write() { const a = this.pos.array, b = this.nxt.array; for (let i = 0; i < this.n; i++) { const p = this.pts[i], q = this.pts[Math.min(i + 1, this.n - 1)]; const r = i === this.n - 1 ? this.pts[i - 1] : null; for (let k = 0; k < 2; k++) { const j = (i * 2 + k) * 3; a[j] = p.x; a[j + 1] = p.y; a[j + 2] = p.z; if (r) { b[j] = 2 * p.x - r.x; b[j + 1] = 2 * p.y - r.y; b[j + 2] = 2 * p.z - r.z; } else { b[j] = q.x; b[j + 1] = q.y; b[j + 2] = q.z; } } } this.pos.needsUpdate = this.nxt.needsUpdate = true; }
}

// ---------------------------------------------------------------- 牵引光 / 扫描扇面
export class Cone {
  constructor(color) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3)); g.setIndex([0, 2, 1, 1, 2, 3]); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.u = { uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uR0: { value: .06 }, uR1: { value: .7 }, uCol: { value: new THREE.Color(color) }, uAlpha: { value: 0 } };
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`
in vec3 position; uniform vec3 uA,uB; uniform float uR0,uR1; out vec2 vQ; out float vW;
void main(){ vec3 d=normalize(uB-uA); vec3 p=mix(uA,uB,position.x); vec3 s=normalize(cross(d,normalize(cameraPosition-p))+1e-6); float r=mix(uR0,uR1,position.x); p+=s*position.y*r; vQ=position.xy; vW=r; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); gl_Position*=1.; }`, /* glsl */`
in vec2 vQ; uniform vec3 uCol; uniform float uAlpha; void main(){ float e=abs(vQ.y); float edge=smoothstep(.86,.96,e)*(1.-smoothstep(.98,1.,e)); float st=fract(vQ.x*9.+uTime*1.6); float bars=smoothstep(.0,.08,st)*(1.-smoothstep(.22,.34,st)); float a=.10*(1.-vQ.x*.4)+edge*.5+bars*.22*(1.-e*.5); a*=smoothstep(0.,.06,vQ.x)*(1.-smoothstep(.97,1.,vQ.x)*.6); oColor=vec4(uCol*a*uAlpha*1.4,0.); oAux=vec4(0.); }`, this.u)); this.mesh.frustumCulled = false; this.mesh.renderOrder = 15; this.mesh.visible = false;
  }
}

// ---------------------------------------------------------------- 枢纽门面：讯息穿过时的水面
export class Portal {
  constructor(r = 2.6) {
    const g = new THREE.CircleGeometry(r, 64); this.u = { uCol: { value: new THREE.Color(.5, .8, 1) }, uOpen: { value: 0 }, uPulse: { value: 0 }, uT: { value: 0 } };
    this.mesh = new THREE.Mesh(g, fxMat(/* glsl */`in vec3 position; out vec2 vQ; void main(){ vQ=position.xy/${r.toFixed(2)}; gl_Position=projectionMatrix*viewMatrix*modelMatrix*vec4(position,1.); }`, /* glsl */`
in vec2 vQ; uniform vec3 uCol; uniform float uOpen,uPulse,uT; void main(){ float r=length(vQ); if(r>1.) discard; float an=atan(vQ.y,vQ.x); float sw=sin(an*3.+r*9.-uTime*2.2)*.5+.5; float sw2=sin(an*5.-r*14.+uTime*3.1)*.5+.5; float ed=smoothstep(.80,.99,r); float rp=0.; for(int i=0;i<3;i++){ float k=uT*1.25-float(i)*.16; if(k>0.){ rp+=(1.-smoothstep(.0,.05,abs(r-k)))*exp(-k*1.6); } }
  float q=floor(sw*3.)/3.*.5+floor(sw2*3.)/3.*.3; float da=fract(an/6.28318*14.+uTime*.05); float rimd=smoothstep(.90,.915,r)*(1.-smoothstep(.955,.97,r))*smoothstep(.08,.12,da)*(1.-smoothstep(.80,.84,da)); float r2=smoothstep(.60,.61,r)*(1.-smoothstep(.622,.632,r)); float a=(q*.2+ed*.4+.05+rimd*.9+r2*.22)*uOpen+rp*.95*uPulse+exp(-r*r*7.)*uPulse*.4; oColor=vec4(mix(uCol,vec3(1.),rp*.4*uPulse)*a*1.5,0.); oAux=vec4(0.); }`, this.u)); this.mesh.renderOrder = 14; this.mesh.frustumCulled = false;
  }
}

// ---------------------------------------------------------------- 信纸：被引力环吸入的页
export class Pages {
  constructor(max = 70) {
    this.max = max; const g = new THREE.InstancedBufferGeometry(); const pl = new THREE.PlaneGeometry(1, 1.36, 4, 6); g.setAttribute('position', pl.attributes.position); g.setIndex(pl.index); this.m = new THREE.InstancedBufferAttribute(new Float32Array(max * 16), 16); this.m.setUsage(THREE.DynamicDrawUsage); this.d = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); g.setAttribute('iM', this.m); g.setAttribute('iD', this.d); g.instanceCount = 0; g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); this.g = g;
    this.u = { uTint: { value: new THREE.Color('#8fb6ff') }, uGhost: { value: 0 } };
    this.mesh = new THREE.Mesh(g, new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, side: THREE.DoubleSide, uniforms: { ...env, ...this.u }, vertexShader: `${COMMON}uniform mat4 viewMatrix,projectionMatrix; uniform float uTime; in vec3 position; in mat4 iM; in vec4 iD; out vec2 vQ; out vec3 vN; out float vZ; out vec3 vW; flat out vec4 vD;
void main(){ vec3 p=position; float b=sin(p.x*3.+p.y*2.+uTime*5.+iD.x*20.)*.12*iD.y; p.z+=b; vec4 w=iM*vec4(p,1.); vec4 v=viewMatrix*w; vQ=position.xy; vN=normalize(mat3(iM)*vec3(-cos(p.x*3.+p.y*2.+uTime*5.+iD.x*20.)*.3*iD.y,0.,1.)); vZ=-v.z; vW=w.xyz; vD=iD; gl_Position=projectionMatrix*v; }`, fragmentShader: `${COMMON}${MRT_OUT}uniform mat4 viewMatrix; uniform vec3 cameraPosition,uSun,uLit,uShade,uTint; uniform float uGhost,uDot; in vec2 vQ; in vec3 vN; in float vZ; in vec3 vW; flat in vec4 vD;
void main(){ if(uGhost>.004){ vec2 gc=fract(mat2(.7071,-.7071,.7071,.7071)*gl_FragCoord.xy/uDot)-.5; if(length(gc)<uGhost*.76) discard; } vec3 N=normalize(vN); if(dot(N,cameraPosition-vW)<0.) N=-N; float l=dot(N,uSun)*.5+.5; vec3 c=mix(mix(uShade,uLit,.3),uLit,smoothstep(.42,.5,l)); vec2 q=vQ*vec2(1.,1./1.36)+.5; float ln=0.; float row=q.y*13.; float ri=floor(row); float w=.28+.62*hash11(ri+vD.x*50.); if(ri>1.&&ri<12.&&q.x>.12&&q.x<.12+w*.76) ln=smoothstep(.3,.36,fract(row))*(1.-smoothstep(.62,.68,fract(row))); c=mix(c,vec3(.2,.26,.42),ln*.7); if(ri>=11.&&ri<12.5&&q.x>.12&&q.x<.5) c=mix(c,uTint,.75); c=mix(c,uTint*1.7,vD.z); if(vD.w<.999&&hash12(floor(vQ*40.)+vD.x)>vD.w) discard; oColor=vec4(c,1.); vec3 vn=normalize(mat3(viewMatrix)*N); oAux=vec4(octEncode(vn),fract(vD.x*7.3)*.9+.05,vZ); }` })); this.mesh.frustumCulled = false;
  }
}
