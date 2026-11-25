// 背景：烘焙一张行星图，逐像素解析球面；云用阈值分色 + 断续墨线，上方是星空与水墨星云
import * as THREE from 'three';
import { COMMON, MRT_OUT } from './glsl.js';
import { env } from './cel.js';

const TRI = new THREE.BufferGeometry();
TRI.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
TRI.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

const c = (h) => new THREE.Color(h); // 十六进制按 sRGB 转线性
// 四个时段的配色脚本
export const PALETTES = {
  dawn: { space: c('#06060f'), space2: c('#2a1d3c'), nebula: c('#75568a'), limb: c('#ff9f6e'), limb2: c('#5b6bb0'), haze: c('#ffd9bf'), seaDeep: c('#33517f'), seaFar: c('#c79aa0'), land: c('#8f7f86'), land2: c('#b79d94'), cloudLit: c('#fff0df'), cloudMid: c('#f0bfae'), cloudDark: c('#8f7fa6'), contour: c('#3a3558'), lit: c('#fff0e0'), shade: c('#7d82b4'), bounce: c('#8d7fa8'), ink: c('#0d0f20'), key: 1.0, cover: -.01, night: .25, star: .7, sunEl: 20, sunAz: -78, glint: c('#ffd2a0'), engine: 1 },
  noon: { space: c('#020408'), space2: c('#0a2c48'), nebula: c('#2a86ad'), limb: c('#36a3e6'), limb2: c('#0f4fa0'), haze: c('#d8eef4'), seaDeep: c('#1f6fa3'), seaFar: c('#8cc7dd'), land: c('#4f8f8a'), land2: c('#7fae95'), cloudLit: c('#fbfdfd'), cloudMid: c('#c4dfe9'), cloudDark: c('#7fb0cc'), contour: c('#184a68'), lit: c('#fffdf6'), shade: c('#8498bd'), bounce: c('#6fa6c8'), ink: c('#03070f'), key: 1.06, cover: -.042, night: 0, star: .8, sunEl: 44, sunAz: -58, glint: c('#ffffff'), engine: 1 },
  dusk: { space: c('#050302'), space2: c('#2a1208'), nebula: c('#8a4a26'), limb: c('#f0742a'), limb2: c('#8a2f0c'), haze: c('#f9e2bd'), seaDeep: c('#bf7a3e'), seaFar: c('#f2d3a0'), land: c('#b56a34'), land2: c('#dba764'), cloudLit: c('#fff6e2'), cloudMid: c('#f1d6ab'), cloudDark: c('#c48a54'), contour: c('#5c3116'), lit: c('#fff1d6'), shade: c('#6b6a80'), bounce: c('#d0a06a'), ink: c('#0d0705'), key: 1.08, cover: -.018, night: .2, star: .85, sunEl: 30, sunAz: -64, glint: c('#ffe6b8'), engine: 1 },
  night: { space: c('#02030a'), space2: c('#0a1836'), nebula: c('#3a56a0'), limb: c('#4fb7d8'), limb2: c('#14306e'), haze: c('#1c3352'), seaDeep: c('#081221'), seaFar: c('#12233c'), land: c('#0e1a2a'), land2: c('#142438'), cloudLit: c('#42587f'), cloudMid: c('#2a3d63'), cloudDark: c('#182846'), contour: c('#060d1c'), lit: c('#dfe9ff'), shade: c('#4a5a88'), bounce: c('#1c3157'), ink: c('#02040a'), key: .82, cover: -.03, night: 1, star: 1.25, sunEl: 40, sunAz: 54, glint: c('#bcd2ff'), engine: 1.2 },
};
export const ORDER = ['dawn', 'noon', 'dusk', 'night'];

export class Sky {
  constructor(renderer, q) {
    this.u = {
      uTime: env.uTime, uSun: env.uSun, uMap: { value: null }, uNeb: { value: null }, uDetail: { value: null },
      uInvP: { value: new THREE.Matrix4() }, uInvV: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uRes: { value: new THREE.Vector2(1, 1) },
      uScroll: { value: 0 }, uAlt: { value: .105 }, uRoll: { value: 0 }, uNight: env.uNight, uStar: { value: 1 }, uPxScale: { value: 1 }, uCloudInk: { value: 1 }, uCover: { value: 0 },
    };
    this.pal = {};
    for (const k of ['space', 'space2', 'nebula', 'limb', 'limb2', 'haze', 'seaDeep', 'seaFar', 'land', 'land2', 'cloudLit', 'cloudMid', 'cloudDark', 'contour', 'glint']) { this.u['c_' + k] = { value: new THREE.Color() }; }
    this.mat = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: /* glsl */`precision highp float; in vec3 position; out vec2 vP; void main(){ vP=position.xy; gl_Position=vec4(position.xy,.99999,1.); }`, fragmentShader: SKY, uniforms: this.u, depthWrite: false, depthTest: true, depthFunc: THREE.LessEqualDepth, blending: THREE.NoBlending });
    this.mesh = new THREE.Mesh(TRI, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    this.mesh.onBeforeRender = (r, s, cam) => { this.u.uInvP.value.copy(cam.projectionMatrixInverse); this.u.uInvV.value.copy(cam.matrixWorld); this.u.uCam.value.setFromMatrixPosition(cam.matrixWorld); this.mat.uniformsNeedUpdate = true; };
    this.bake(renderer, q);
    this.setTime('dusk', 'dusk', 0);
  }
  bake(r, q) {
    const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const go = (w, h, frag, opt = {}) => {
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: opt.wrapT ?? THREE.ClampToEdgeWrapping, anisotropy: q.aniso, ...opt });
      const m = new THREE.Mesh(TRI, new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: /* glsl */`precision highp float; in vec3 position; out vec2 vUv; void main(){ vUv=position.xy*.5+.5; gl_Position=vec4(position.xy,0.,1.); }`, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending }));
      m.frustumCulled = false; scene.clear(); scene.add(m);
      const prev = r.getRenderTarget(); r.setRenderTarget(rt); r.render(scene, cam); r.setRenderTarget(prev); m.material.dispose();
      return rt.texture;
    };
    this.u.uMap.value = go(q.planet, Math.round(q.planet * .1875), BAKE_PLANET);
    this.u.uNeb.value = go(1024, 512, BAKE_NEBULA);
    this.u.uDetail.value = go(512, 512, BAKE_DETAIL, { wrapT: THREE.RepeatWrapping });
  }
  // 在两个时段之间插值
  setTime(a, b, t) {
    const A = PALETTES[a], B = PALETTES[b], u = this.u;
    for (const k in u) if (k.startsWith('c_')) u[k].value.lerpColors(A[k.slice(2)], B[k.slice(2)], t);
    env.uLit.value.lerpColors(A.lit, B.lit, t); env.uShade.value.lerpColors(A.shade, B.shade, t); env.uBounce.value.lerpColors(A.bounce, B.bounce, t); env.uHaze.value.lerpColors(A.haze, B.haze, t);
    const L = (k) => A[k] + (B[k] - A[k]) * t;
    env.uKey.value = L('key'); env.uNight.value = L('night'); u.uStar.value = L('star'); u.uCover.value = L('cover');
    const el = L('sunEl') * Math.PI / 180, az = L('sunAz') * Math.PI / 180;
    env.uSun.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    env.uFill.value.set(-env.uSun.value.x, .2, env.uSun.value.z * .6 + .3).normalize();
    this.ink = this.ink || new THREE.Color(); this.ink.lerpColors(A.ink, B.ink, t);
  }
}

const LAT = .56;
const BAKE_PLANET = /* glsl */`
${COMMON}
in vec2 vUv; layout(location=0) out vec4 o;
float fbm(vec3 p,int n){ float a=.5,s=0.; for(int i=0;i<n;i++){ s+=a*gnoise(p); p=p*2.03+vec3(17.1,-9.2,5.3); a*=.5; } return s; }
float ridge(vec3 p,int n){ float a=.5,s=0.; for(int i=0;i<n;i++){ s+=a*(1.-abs(gnoise(p))*2.); p=p*2.07+11.7; a*=.5; } return s; }
vec3 rot(vec3 p,vec3 k,float a){ return p*cos(a)+cross(k,p)*sin(a)+k*dot(k,p)*(1.-cos(a)); }
void main(){
  float lo=(vUv.x-.5)*6.2831853, la=(vUv.y-.5)*2.*${LAT};
  vec3 n=vec3(sin(la),cos(la)*cos(lo),cos(la)*sin(lo));
  vec3 q=n;
  for(int i=0;i<14;i++){ float fi=float(i); float cl=(fi+.5+.6*(hash11(fi*3.1)-.5))/14.*6.2831853; float ca=(hash11(fi+9.3)-.5)*1.0; vec3 c=vec3(sin(ca),cos(ca)*cos(cl),cos(ca)*sin(cl)); float d=acos(clamp(dot(q,c),-1.,1.)); float R=.075+.1*hash11(fi+.5); q=rot(q,c,(hash11(fi*7.7)>.5?1.:-1.)*3.0*exp(-d*d/(R*R))); }
  vec3 w=vec3(fbm(q*4.2+3.1,4),fbm(q*4.2+vec3(9.2,1.7,4.4),4),fbm(q*4.2+vec3(2.8,7.7,-3.4),4));
  vec3 ww=vec3(fbm(q*9.+w*2.+1.,3),fbm(q*9.+w*2.+vec3(5.2),3),fbm(q*9.+w*2.-4.,3));
  vec3 sq=vec3(1.75,1.,1.);
  float c1=fbm(q*sq*5.2+w*1.5+ww*.55,7);
  float c2=fbm(q*sq*13.+ww*1.9,6);
  float big=fbm(n*2.6+vec3(7.3,2.1,-4.),3);
  float cov=sat(.5+c1*1.3+c2*.42+big*.36);
  float wisp=sat(.5+fbm(q*vec3(58.,26.,26.)+ww*3.2,5)*1.35);
  float e=fbm(n*3.6+vec3(4.2,1.1,-2.3)+w*.35,7)*1.25+.02;
  float land=sat(.5+e*1.1);
  float cells=1e3; vec3 p=n*64.; vec3 ip=floor(p);
  for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){ vec3 g=ip+vec3(x,y,z); vec3 r=g+hash33(g); float d=length(p-r); cells=min(cells,d/(.2+1.25*pow(hash13(g+3.),2.5))); }
  float web=smoothstep(.84,1.02,ridge(n*30.+ww*1.2,4));
  float city=sat(exp(-cells*cells*2.2)*1.0+web*.34)*smoothstep(.47,.60,land)*smoothstep(-.18,.3,fbm(n*15.,4)+.12);
  o=vec4(cov,wisp,land,city);
}`;
const BAKE_NEBULA = /* glsl */`
${COMMON}
in vec2 vUv; layout(location=0) out vec4 o;
float fbm(vec3 p,int n){ float a=.5,s=0.; for(int i=0;i<n;i++){ s+=a*gnoise(p); p=p*2.03+vec3(17.1,-9.2,5.3); a*=.5; } return s; }
void main(){
  float lo=(vUv.x-.5)*6.2831853, la=(vUv.y-.5)*3.14159265; vec3 n=vec3(cos(la)*cos(lo),sin(la),cos(la)*sin(lo));
  vec3 w=vec3(fbm(n*1.6+2.,4),fbm(n*1.6+7.,4),fbm(n*1.6-5.,4));
  float a=sat(.5+1.5*fbm(n*2.1+w*1.8,6)); float band=exp(-pow(dot(n,normalize(vec3(.45,.72,-.5)))*2.1+w.x*.9,2.));
  float b=sat(.5+1.4*fbm(n*5.+w*2.6+4.,6)); float dust=sat(.5+1.6*fbm(n*9.+w*3.,5));
  o=vec4(a*band,b*band,dust,band);
}`;
const BAKE_DETAIL = /* glsl */`
${COMMON}
in vec2 vUv; layout(location=0) out vec4 o;
float pn(vec2 p,float per){ vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f); vec2 a=mod(i,per),b=mod(i+1.,per); return mix(mix(hash12(a),hash12(vec2(b.x,a.y)),f.x),mix(hash12(vec2(a.x,b.y)),hash12(b),f.x),f.y); }
float pf(vec2 p,float per){ float a=.5,s=0.; for(int i=0;i<6;i++){ s+=a*pn(p*per,per); per*=2.; a*=.5; } return s; }
void main(){ float a=pf(vUv,6.); float b=pf(vUv+vec2(.37,.11),9.); float c=pf(vUv+vec2(a,b)*.12,5.); o=vec4(a,b,c,pn(vUv*64.,64.)); }`;

const SKY = /* glsl */`
${COMMON}
${MRT_OUT}
in vec2 vP;
uniform mat4 uInvP,uInvV; uniform vec3 uSun,uCam; uniform vec2 uRes; uniform sampler2D uMap,uNeb,uDetail;
uniform float uTime,uScroll,uAlt,uRoll,uNight,uStar,uPxScale,uCloudInk,uCover;
uniform vec3 c_space,c_space2,c_nebula,c_limb,c_limb2,c_haze,c_seaDeep,c_seaFar,c_land,c_land2,c_cloudLit,c_cloudMid,c_cloudDark,c_contour,c_glint;
vec2 sph(vec3 n){ return vec2(atan(n.z,n.x)/6.2831853+.5, asin(clamp(n.y,-1.,1.))/3.14159265+.5); }
vec2 gmap(vec3 n){ return vec2(atan(n.z,n.y)/6.2831853+.5+uScroll, asin(clamp(n.x,-1.,1.))/(2.*${LAT})+.5); }
vec3 ry(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); }
vec3 rx(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z); }
vec3 rz(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(c*p.x-s*p.y,s*p.x+c*p.y,p.z); }
float cloudF(vec4 mp,vec4 d1,vec4 d2,vec4 d3,float nearK){
  float f=mp.x+(mp.y-.5)*.15+(d1.x-.5)*.16+(d2.y-.5)*.10+(d3.x-.5)*.045-.535;
  float pf=d1.y*.5+d2.x*.36+d3.y*.14; float msk=smoothstep(.36,.60,mp.x+(mp.y-.5)*.3); float cu=(pf-.64+msk*.085)*.75;
  float ci=(mp.y-.60+(d2.z-.5)*.10+(mp.x-.5)*.22)*.5;
  return max(f,max(cu*nearK,ci*.7))+uCover;
}
float starLayer(vec3 d,float s,float th,float size,out float seed){
  vec3 p=d*s; vec3 ip=floor(p); vec3 r=hash33(ip); seed=hash13(ip+7.); if(seed<th) return 0.;
  vec3 c=ip+.25+.5*r; vec3 cd=normalize(c); float an=acos(clamp(dot(d,cd),-1.,1.)); float px=an/size; return px;
}
void main(){
  vec4 vd=uInvP*vec4(vP,1.,1.); vec3 rd=normalize((uInvV*vec4(normalize(vd.xyz/vd.w),0.)).xyz);
  // 行星：单位球，机位在上方 uAlt 处；平移给一点点视差
  float R=1.; vec3 ro=vec3(0.,1.+uAlt,0.)+uCam*vec3(.00010,.00006,.00010);
  float b=dot(ro,rd), c=dot(ro,ro)-1.; float h=b*b-c; vec3 col;
  float px=length(fwidth(rd));
  if(b<0.&&h>0.){
    float t=-b-sqrt(h); vec3 n=normalize(ro+rd*t);
    vec2 uv=gmap(ry(n,.55));
    vec3 sn=normalize(uSun-n*dot(uSun,n)); float nl=dot(n,uSun);
    vec2 us=gmap(ry(normalize(n+sn*.0042),.55))-uv; vec2 uo=gmap(ry(normalize(n+sn*.012),.55))-uv;
    vec2 K=vec2(60.,60.*2.*${LAT}/6.2831853);
    vec4 mp=texture(uMap,uv); vec4 d1=texture(uDetail,uv*K), d2=texture(uDetail,uv*K*4.3+3.1), d3=texture(uDetail,uv*K*15.+1.7);
    float mu=max(dot(n,-rd),0.); float far=pow(1.-mu,2.4); float nearK=smoothstep(.0,.35,mu);
    float f0=cloudF(mp,d1,d2,d3,nearK);
    vec4 q1=texture(uDetail,(uv+us)*K), q2=texture(uDetail,(uv+us)*K*4.3+3.1), q3=texture(uDetail,(uv+us)*K*15.+1.7);
    float f1=cloudF(texture(uMap,uv+us),q1,q2,q3,nearK);
    float f2=cloudF(texture(uMap,uv+uo),texture(uDetail,(uv+uo)*K),d2,d3,nearK);
    float aa=max(fwidth(f0),.0015); float cl=smoothstep(-aa,aa,f0);
    // 海与陆：平涂分档 + 干笔触
    float brush=(d1.z-.5)*.55+(d2.x-.5)*.35; float dry=(d2.z-.5)+(d3.z-.5)*.6;
    float seaT=sat(far*1.02+brush*.3+(mp.z-.5)*.5+.04); float sq=floor(seaT*6.+.5+dry*.35)/6.; seaT=mix(seaT,sq,.8);
    vec3 sea=mix(c_seaDeep,c_seaFar,seaT);
    float lnd=mp.z+(d1.x-.5)*.16+(d2.y-.5)*.12+(d3.x-.5)*.05; float la=max(fwidth(lnd),.0015); float lt=smoothstep(.58-la,.58+la,lnd);
    float lt2=smoothstep(.635-la,.635+la,lnd+dry*.04), lt3=smoothstep(.60-la,.60+la,lnd-dry*.05);
    vec3 ground=mix(sea,mix(mix(c_land,c_land2,lt2),mix(sea,c_seaFar,.6),far*.8),lt*mix(.75,1.,lt3));
    float coast=(1.-smoothstep(la*.5,la*2.,abs(lnd-.58)))*smoothstep(.35,.6,d1.y);
    ground=mix(ground,c_contour,coast*.55*(1.-far)*uCloudInk);
    // 地形短排线
    float hat=smoothstep(.62,.8,abs(fract((uv.x*K.x*9.+uv.y*K.y*13.)+dry*.5)-.5)*2.)*lt*lt2*smoothstep(.5,.7,d2.w)*nearK; ground=mix(ground,c_contour,hat*.22*uCloudInk);
    vec3 hf=normalize(uSun-rd); float gl=pow(max(dot(n,hf),0.),46.)*(1.-lt); ground=mix(ground,c_glint,smoothstep(.22,.5,gl+dry*.22*gl)*.55*(1.-uNight*.5));
    float shd=smoothstep(-.015,.05,f2)*(1.-cl); ground*=1.-.34*shd*(1.-far*.7);
    // 云：三档明暗，受光坡亮、背光坡暗
    float rise=(f1-f0); float tone=sat(.60+f0*1.15-rise*6.5+dry*.10);
    float t1=smoothstep(.36,.39,tone), t2=smoothstep(.60,.63,tone), t3=smoothstep(.18,.21,tone);
    vec3 cloud=mix(mix(c_cloudDark*.86,c_cloudDark,t3),c_cloudMid,t1); cloud=mix(cloud,c_cloudLit,t2);
    col=mix(ground,cloud,cl*mix(.98,.9,far));
    // 断续墨线
    float brk=smoothstep(.40,.56,d2.y*.6+d1.y*.4); float cw=max(aa*1.5,.0012);
    float ct=(1.-smoothstep(cw*.35,cw*1.3,abs(f0)))*brk; float lee=smoothstep(-.01,.02,rise);
    float in1=(1.-smoothstep(cw*.3,cw,abs(tone-.375)*.16))*smoothstep(.52,.68,d2.z)*cl;
    col=mix(col,c_contour,sat(ct*mix(.3,.95,lee)+in1*.35)*(1.-smoothstep(.45,.98,far))*uCloudInk*.8);
    // 夜灯
    if(uNight>.01){ float city=mp.w; float grain=smoothstep(.40,.62,d3.w*.5+d2.w*.2+city*.5); vec3 cc=mix(vec3(1.,.50,.16),vec3(1.,.80,.46),smoothstep(.25,.6,city)); col+=cc*(grain*1.5+.28)*smoothstep(.06,.5,city)*uNight*(1.-cl*.86)*(1.-far*.5); }
    // 近地平线的空气
    float hz=pow(1.-mu,5.); col=mix(col,c_haze,sat(hz*1.05+far*.18));
    col=mix(col,mix(c_haze,c_limb,.45),(1.-smoothstep(0.,.22,mu))*.65);
  } else {
    // 太空
    float bp=b<0.?sqrt(max(dot(ro,ro)-b*b,0.))-1.:uAlt; float alt=max(bp,0.);
    float up=sat(rd.y*1.1+.25);
    col=mix(c_space2,c_space,1.-exp(-alt*16.));
    vec2 nuv=sph(rz(rd,.5)); vec4 nb=texture(uNeb,nuv);
    float q1=smoothstep(.30,.36,nb.x),q2=smoothstep(.42,.50,nb.x),q3=smoothstep(.34,.48,nb.y);
    float soft=smoothstep(.1,.75,nb.x)*.5+smoothstep(.2,.8,nb.y)*.35;
    col+=c_nebula*(smoothstep(.12,.7,nb.x)*.16+q1*.05+q2*.13+q3*.07)*(.25+.75*nb.z)*smoothstep(.0,.25,alt*4.);
    // 星
    float sd; float fade=smoothstep(.0,.06,alt/ .06);
    float s1=starLayer(rd,70.,.62,px*.8,sd); if(s1>0.){ float sz=mix(.7,1.25,hash11(sd*91.)); col+=vec3(1.)*(1.-smoothstep(sz*.45,sz,s1))*.75*uStar*(.7+.3*sin(uTime*1.3+sd*70.)); }
    float s2=starLayer(rd,26.,.72,px*.9,sd); if(s2>0.){ float sz=mix(1.1,2.0,hash11(sd*37.)); vec3 tint=mix(vec3(.75,.88,1.),vec3(1.,.86,.7),step(.6,hash11(sd*13.))); col+=tint*(1.-smoothstep(sz*.5,sz,s2))*uStar*1.1; }
    float s3=starLayer(rd,7.,.80,px,sd); if(s3>0.){ vec3 ip=floor(rd*7.); vec3 cd=normalize(ip+.25+.5*hash33(ip)); vec3 rr=normalize(cross(cd,vec3(.2,1.,.1))); vec3 uu=cross(rr,cd); vec2 q=vec2(dot(rd,rr),dot(rd,uu))/px; float tw=.75+.25*sin(uTime*2.+sd*40.); float L=mix(9.,20.,hash11(sd*7.))*tw; float cr=max((1.-smoothstep(0.,L,abs(q.x)))*(1.-smoothstep(.2,1.5,abs(q.y))),(1.-smoothstep(0.,L,abs(q.y)))*(1.-smoothstep(.2,1.5,abs(q.x)))); col+=vec3(1.,.97,.92)*(cr+(1.-smoothstep(1.1,2.6,length(q))))*uStar*1.5; }
    // 大气弧：细亮线 + 饱和色带 + 渐隐
    float a=alt/.011; vec3 air=mix(c_haze,c_limb,smoothstep(.0,.55,a)); air=mix(air,c_limb2,smoothstep(.5,1.6,a));
    float am=exp(-a*1.25)*1.0; float bandq=(1.-smoothstep(0.,2.6,a));
    col=mix(col,air,sat(am)*bandq*step(b,0.));
    col+=c_limb*exp(-a*.55)*.16*step(b,0.);
    col+=c_limb2*exp(-a*.17)*.10*step(b,0.);
  }
  // 太阳
  float sd=max(dot(rd,uSun),0.); float nightCut=1.-uNight*.75;
  { float an=acos(clamp(sd,-1.,1.)); vec3 sx=normalize(cross(uSun,vec3(0.,1.,0.))); vec3 sy=cross(sx,uSun); float ra=atan(dot(rd,sy),dot(rd,sx)); float rays=pow(.5+.5*sin(ra*9.+.6*sin(ra*4.)),5.)*exp(-an*16.); float disc=1.-smoothstep(.026,.0285,an); float ringg=(1.-smoothstep(.0,.0035,abs(an-.043)))*.35; float open=(h<0.||b>0.)?1.:0.; col+=(c_glint*(disc*2.6+exp(-an*26.)*.5+rays*.38+ringg)+c_limb*exp(-an*7.)*.18)*nightCut*open; }
  oColor=vec4(col,1.); oAux=vec4(.5,.5,0.,0.);
}`;
