// 渲染管线：MRT → 墨线 → 泛光 → 合成（上色/线稿切换、速度线、冲击帧、分镜）
import * as THREE from 'three';
import { COMMON } from './glsl.js';

const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
TRI.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
const FS_VERT = /* glsl */`precision highp float; in vec3 position; out vec2 vUv; void main(){ vUv=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.); }`;

function pass(frag, uniforms, opt = {}) {
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, ...opt });
}

export class Pipeline {
  constructor(renderer, quality) {
    this.r = renderer; this.q = quality;
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(TRI, null); this.quad.frustumCulled = false; this.scene.add(this.quad);
    this.main = null; this.bloom = [];
    this.u = {
      tColor: { value: null }, tAux: { value: null }, tBloom: { value: null }, uPx: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() },
      uTime: { value: 0 }, uInkCol: { value: new THREE.Color(.012, .02, .045) }, uInkA: { value: 1 }, uLineW: { value: .72 },
      uBloom: { value: .9 }, uVig: { value: .28 }, uGrain: { value: .035 }, uSat: { value: 1 }, uExposure: { value: 1 },
      uFlood: { value: new THREE.Vector4(.5, .5, 4, 0) }, uPaper: { value: new THREE.Color('#f3f1ec') }, uPaperInk: { value: new THREE.Color('#151e33') },
      uSpeed: { value: 0 }, uSpeedC: { value: new THREE.Vector2(.5, .5) }, uImpact: { value: 0 }, uChroma: { value: 0 }, uFade: { value: 0 }, uFadeCol: { value: new THREE.Color(0, 0, 0) },
      uDepthFade: { value: new THREE.Vector2(60, 210) }, uScale: { value: 1 }, uWaveC: { value: new THREE.Vector2(.5, .5) }, uWave: { value: new THREE.Vector4(0, 0, 0, 0) }, uWaveCol: { value: new THREE.Color(1, 1, 1) },
    };
    this.inkMat = pass(INK, this.u);
    this.down = pass(DOWN, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.up = pass(UP, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uK: { value: 1 } }, { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    this.final = pass(FINAL, { ...this.u, tInk: { value: null } });
  }
  resize(w, h) {
    this.w = w; this.h = h;
    this.main?.dispose(); this.ink?.dispose(); this.bloom.forEach((b) => b.dispose());
    this.main = new THREE.WebGLRenderTarget(w, h, { count: 2, samples: this.q.samples, type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, resolveDepthBuffer: false });
    this.main.textures[1].minFilter = this.main.textures[1].magFilter = THREE.NearestFilter;
    this.ink = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < this.q.bloomLevels; i++) {
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
      this.bloom.push(new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false }));
    }
    this.u.uPx.value.set(1 / w, 1 / h); this.u.uRes.value.set(w, h);
  }
  run(mat, target, clear = false) {
    this.quad.material = mat; this.r.setRenderTarget(target);
    if (clear) this.r.clear(true, false, false);
    this.r.render(this.scene, this.cam);
  }
  finish(target = null) {
    const u = this.u;
    u.tColor.value = this.main.textures[0]; u.tAux.value = this.main.textures[1];
    this.run(this.inkMat, this.ink);
    let src = { texture: this.main.textures[0], width: this.w, height: this.h };
    this.bloom.forEach((b, i) => { this.down.uniforms.tSrc.value = src.texture; this.down.uniforms.uPx.value.set(1 / src.width, 1 / src.height); this.down.uniforms.uFirst.value = i === 0 ? 1 : 0; this.run(this.down, b); src = b; });
    for (let i = this.bloom.length - 1; i > 0; i--) { const s = this.bloom[i]; this.up.uniforms.tSrc.value = s.texture; this.up.uniforms.uPx.value.set(1 / s.width, 1 / s.height); this.up.uniforms.uK.value = i > 2 ? 1.1 : .9; this.run(this.up, this.bloom[i - 1]); }
    u.tBloom.value = this.bloom[0].texture; this.final.uniforms.tInk.value = this.ink.texture;
    this.run(this.final, target);
  }
}

// 墨线：法线折角 + 分区边界 + 深度轮廓，写成遮罩，合成时再柔化叠上
const INK = /* glsl */`
${COMMON}
in vec2 vUv; layout(location=0) out highp vec4 o;
uniform sampler2D tColor, tAux; uniform vec2 uPx; uniform float uTime, uInkA, uLineW, uScale; uniform vec2 uDepthFade;
vec4 A(vec2 d){ return texture(tAux,vUv+d*uPx); }
void main(){
  vec4 a=texture(tAux,vUv);
  float w=max(uLineW*uScale*.5,.5);
  vec4 s0=A(vec2(w,w)), s1=A(vec2(-w,-w)), s2=A(vec2(-w,w)), s3=A(vec2(w,-w));
  float far=1e4;
  float zc=a.w<.01?far:a.w, z0=s0.w<.01?far:s0.w, z1=s1.w<.01?far:s1.w, z2=s2.w<.01?far:s2.w, z3=s3.w<.01?far:s3.w;
  float nearZ=min(zc,min(min(z0,z1),min(z2,z3)));
  float dz=max(abs(z0+z1-2.*zc),abs(z2+z3-2.*zc))/nearZ;
  float sil=smoothstep(.016,.05,dz);
  float cr=0., pid=0., sk=0.;
  if(nearZ<far*.5){
    vec3 n0=octDecode(s0.xy),n1=octDecode(s1.xy),n2=octDecode(s2.xy),n3=octDecode(s3.xy);
    float dn=max(1.-dot(n0,n1),1.-dot(n2,n3));
    cr=smoothstep(.05,.42,dn)*step(.01,s0.w*s1.w*s2.w*s3.w);
    vec4 sz=vec4(s0.z,s1.z,s2.z,s3.z); vec4 ks=step(3.,sz); sk=max(step(3.,a.z),max(max(ks.x,ks.y),max(ks.z,ks.w)));
    vec4 id=sz-4.*ks;
    float di=max(abs(id.x-id.y),abs(id.z-id.w));
    pid=smoothstep(.003,.02,di);
  }
  float fade=1.-smoothstep(uDepthFade.x,uDepthFade.y,nearZ);
  float wob=.82+.18*vnoise(gl_FragCoord.xy/uScale*.21);
  float line=max(sil*mix(.6,1.,fade),max(cr*.7,pid*.82)*mix(.3,1.,fade))*uInkA*wob;
  float hot=max(texture(tColor,vUv).r,max(texture(tColor,vUv).g,texture(tColor,vUv).b));
  line*=1.-.9*smoothstep(1.05,1.6,hot);
  float sl=max(sil,max(cr,pid))*step(.5,sk);
  o=vec4(line*(1.-step(.5,sk)),sl,step(.01,a.w),1.);
}`;

const DOWN = /* glsl */`
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D tSrc; uniform vec2 uPx; uniform float uFirst;
vec3 S(vec2 d){ vec3 c=texture(tSrc,vUv+d*uPx).rgb; if(uFirst>.5){ c=min(c,vec3(9.)); float m=max(c.r,max(c.g,c.b)); c*=smoothstep(1.16,1.9,m); } return c; }
void main(){ vec3 c=S(vec2(0.))*4.; c+=S(vec2(1.,1.))+S(vec2(-1.,1.))+S(vec2(1.,-1.))+S(vec2(-1.,-1.)); c+=(S(vec2(2.,0.))+S(vec2(-2.,0.))+S(vec2(0.,2.))+S(vec2(0.,-2.)))*.5; o=vec4(c/10.,1.); }`;
const UP = /* glsl */`
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D tSrc; uniform vec2 uPx; uniform float uK;
void main(){ vec3 c=texture(tSrc,vUv).rgb*4.; c+=(texture(tSrc,vUv+vec2(uPx.x,0.)).rgb+texture(tSrc,vUv-vec2(uPx.x,0.)).rgb+texture(tSrc,vUv+vec2(0.,uPx.y)).rgb+texture(tSrc,vUv-vec2(0.,uPx.y)).rgb)*2.; c+=texture(tSrc,vUv+uPx).rgb+texture(tSrc,vUv-uPx).rgb+texture(tSrc,vUv+vec2(uPx.x,-uPx.y)).rgb+texture(tSrc,vUv+vec2(-uPx.x,uPx.y)).rgb; o=vec4(c/16.*uK,1.); }`;

const FINAL = /* glsl */`
${COMMON}
in vec2 vUv; layout(location=0) out highp vec4 o;
uniform sampler2D tInk, tColor, tAux, tBloom; uniform vec2 uRes, uPx, uSpeedC, uWaveC; uniform vec3 uInkCol; uniform float uTime, uBloom, uVig, uGrain, uSat, uExposure, uSpeed, uImpact, uChroma, uFade, uScale;
uniform vec4 uFlood, uWave; uniform vec3 uPaper, uPaperInk, uFadeCol, uWaveCol;
vec3 toSrgb(vec3 c){ c=max(c,0.); return mix(12.92*c,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c)); }
vec3 curve(vec3 c){ // 1 以下几乎不动，保住赛璐璐原色；高光柔和收住
  vec3 x=max(c-.82,0.); vec3 r=.82+.18*(x/(x+.18))*1.0; return mix(c,r,step(.82,c)); }
void main(){
  float asp=uRes.x/uRes.y; vec2 uv=vUv;
  // 冲击波折射
  vec2 wd=(uv-uWaveC)*vec2(asp,1.); float wl=length(wd);
  float wv=0.;
  if(uWave.z>0.){ wv=exp(-pow((wl-uWave.x)/max(uWave.y,.001),2.))*uWave.z; uv-=normalize(wd+1e-5)/vec2(asp,1.)*wv*.035; }
  vec3 col;
  if(uChroma>.001){ vec2 d=(uv-.5)*uChroma*.02; col=vec3(texture(tColor,uv+d).r,texture(tColor,uv).g,texture(tColor,uv-d).b); }
  else col=texture(tColor,uv).rgb;
  vec2 hp=uPx*.5; vec4 ik=(texture(tInk,uv+vec2(hp.x,hp.y))+texture(tInk,uv+vec2(-hp.x,hp.y))+texture(tInk,uv+vec2(hp.x,-hp.y))+texture(tInk,uv+vec2(-hp.x,-hp.y)))*.25;
  float line=ik.r; float Lc=dot(col,vec3(.3,.6,.1));
  col=mix(col,uInkCol*(.55+.5*sat(Lc*2.)),line);
  if(ik.g>.001){ vec3 hue=col/max(max(col.r,max(col.g,col.b)),.02); float flick=.82+.18*hash12(floor(gl_FragCoord.xy/3.)+floor(uTime*9.)); col+=hue*ik.g*1.5*flick; }
  vec3 bl=texture(tBloom,uv).rgb;
  col+=bl*uBloom;
  col+=uWaveCol*wv*.9;
  col*=uExposure;
  // 速度线
  if(uSpeed>.002){
    vec2 d=(vUv-uSpeedC)*vec2(asp,1.); float r=length(d); float an=atan(d.y,d.x);
    float seg=floor(an*46.); float n=hash12(vec2(seg,floor(uTime*18.))); float n2=hash12(vec2(seg*1.7,floor(uTime*18.)+3.));
    float f=abs(fract(an*46.)-.5)*2.; float s=(1.-smoothstep(.2,.9,f))*step(1.-uSpeed*.62,n)*smoothstep(.16+.3*n2,.62+.25*n2,r);
    col=mix(col,vec3(1.35),s*.75*uSpeed);
    col+=vec3(.5,.55,.6)*uSpeed*.25*smoothstep(.3,.9,r);
  }
  float g=dot(col,vec3(.299,.587,.114));
  col=mix(vec3(g),col,uSat);
  // 线稿 ↔ 上色：颜色从某一点漫开
  vec2 fd=(vUv-uFlood.xy)*vec2(asp,1.);
  if(uFlood.z<3.5){
    vec2 fp=vUv*vec2(asp,1.); float wn=(vnoise(fp*4.2+3.)-.5)*.20+(vnoise(fp*11.+7.)-.5)*.10+(vnoise(fp*31.)-.5)*.045+(vnoise(fp*90.)-.5)*.018;
    float dist=length(fd)+wn*smoothstep(0.,.3,uFlood.z);
    float drop=vnoise(fp*52.+13.); float spl=step(dist-.085*smoothstep(0.,.09,uFlood.z)*smoothstep(.62,.9,drop),uFlood.z);
    float m=max(1.-smoothstep(uFlood.z-.003,uFlood.z+.003,dist),spl)*step(.002,uFlood.z);
    float rim=exp(-pow((dist-uFlood.z)/.010,2.));
    // 线稿：纸色 + 墨线 + 依明度排线
    vec4 ax=texture(tAux,vUv); float obj=step(.01,ax.w);
    float L=sat(dot(texture(tColor,vUv).rgb,vec3(.3,.6,.1)));
    vec2 px=gl_FragCoord.xy/uScale; float boil=floor(uTime*6.)*.37;
    float wb=vnoise(px*.06+boil)*1.4; float h1=1.-smoothstep(.10,.24,abs(fract((px.x+px.y)*.20+wb*.16)-.5)); float h2=1.-smoothstep(.08,.20,abs(fract((px.x-px.y)*.20-wb*.16)-.5));
    float shade=obj*((1.-smoothstep(.16,.34,L))*h1*.42+(1.-smoothstep(.03,.12,L))*h2*.4);
    float gs=dot(texture(tColor,vUv).rgb,vec3(.3,.6,.1)); float gx=dot(texture(tColor,vUv+vec2(uPx.x*1.2,0.)).rgb,vec3(.3,.6,.1)), gy=dot(texture(tColor,vUv+vec2(0.,uPx.y*1.2)).rgb,vec3(.3,.6,.1)); float bgl=(1.-obj)*smoothstep(.035,.16,max(abs(gs-gx),abs(gs-gy)))*.5*step(gs,1.2);
    float inkA=sat(line*.92+shade*(1.-line)*.8+bgl);
    vec2 gp=abs(fract(px/22.)-.5); float grid=0.;
    vec3 paper=mix(uPaper,uPaperInk,inkA*.92); paper*=1.-.025*vnoise(px*.7);
    paper=mix(paper,uPaper*.955,(1.-obj)*smoothstep(.04,.2,gs)*.8);
    vec3 pl=pow(paper,vec3(2.2));
    col=mix(pl,col,m);
    col=mix(col,uPaperInk*.6,rim*.0);
    col=mix(col,vec3(.96,.95,.92),rim*.55*uFlood.w*step(.02,uFlood.z));
  }
  // 冲击帧：短暂反相成黑白
  if(uImpact>.001){ float gg=dot(col,vec3(.3,.6,.1)); vec3 iv=vec3(step(.36,gg)); col=mix(col,mix(iv*1.2,1.-iv,step(.5,uImpact)),step(.02,uImpact)); }
  col=curve(col);
  vec2 q=vUv-.5; col*=1.-uVig*smoothstep(.25,.95,dot(q,q)*1.9);
  col=mix(col,uFadeCol,uFade);
  col=toSrgb(col);
  col+=(hash12(gl_FragCoord.xy+fract(uTime)*61.)-.5)*uGrain;
  o=vec4(col,1.);
}`;
