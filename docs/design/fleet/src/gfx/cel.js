// 漫画赛璐璐着色：四阶明暗色带 + 面板线 + 遮蔽 + 硬高光 + 轮廓光，同时写出墨线用的法线/分区/深度
import * as THREE from 'three';
import { COMMON, MRT_OUT } from './glsl.js';

export const env = {
  uTime: { value: 0 },
  uSun: { value: new THREE.Vector3(.5, .6, .6).normalize() },
  uFill: { value: new THREE.Vector3(-.7, .25, .5).normalize() },
  uLit: { value: new THREE.Color(1, 1, 1) },
  uShade: { value: new THREE.Color(1, 1, 1) },
  uBounce: { value: new THREE.Color(.2, .25, .3) },
  uHaze: { value: new THREE.Color(.6, .7, .8) },
  uHazeK: { value: 0 },
  uKey: { value: 1 },
  uNight: { value: 0 },
  uShadowA: { value: null }, uShadowB: { value: null },
  uShadowMA: { value: new THREE.Matrix4() }, uShadowMB: { value: new THREE.Matrix4() },
  uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
  uPanel: { value: null }, uDot: { value: 10 },
  uPointPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] }, uPointCol: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] }, uPointR: { value: new THREE.Vector3(10, 10, 10) },
};

const VERT = /* glsl */`
${COMMON}
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform float uUvq, uStretch, uIdOff, uHalf; uniform vec3 uCenter;
in vec4 position; in vec4 aux; in vec2 uv;
out vec3 vN; out vec3 vW; out vec3 vP; out vec2 vUv; out float vAo; out float vZ;
flat out float vId; flat out int vM;
#ifdef INST
in mat4 instanceMatrix; in vec4 iTint; in vec4 iFx; flat out vec4 fTint; flat out vec4 fFx;
#endif
void main(){
  vec3 p=position.xyz;
  vP=p;
  if(uStretch>0.){ p.z-=uStretch*(1.-p.z)*8.; p.xy*=1.-.45*sat(uStretch); }
  #ifdef INST
  fTint=iTint; fFx=iFx; mat4 M=modelMatrix*instanceMatrix*mat4(uHalf,0.,0.,0.,0.,uHalf,0.,0.,0.,0.,uHalf,0.,uCenter.x,uCenter.y,uCenter.z,1.);
  #else
  mat4 M=modelMatrix;
  #endif
  vec4 w=M*vec4(p,1.);
  vW=w.xyz;
  vN=mat3(M)*octDecode(aux.xy/255.);
  vAo=aux.z/255.; vM=int(aux.w+.5); vUv=uv*uUvq;
  vId=fract(position.w*.5+.5+uIdOff);
  vec4 v=viewMatrix*w; vZ=-v.z;
  gl_Position=projectionMatrix*v;
}`;

const FRAG = /* glsl */`
${COMMON}
precision highp sampler2DShadow;
${MRT_OUT}
uniform mat4 viewMatrix; uniform vec3 cameraPosition;
uniform sampler2D uRamp, uParam, uPanel, uMask; uniform highp sampler2DShadow uShadowA, uShadowB;
uniform mat4 uShadowMA, uShadowMB; uniform vec2 uShadowTexel;
uniform float uGhost, uDot, uUvq; uniform float uMatN, uTime, uEngine, uWindow, uBeacon, uTrim, uPortal, uSketch, uFlash, uReveal, uShadowSel, uDim, uKey, uNight, uHazeK, uInk;
uniform vec3 uSun, uFill, uLit, uShade, uBounce, uHaze, uTint, uLine, uFlashCol, uPointR, uPointPos[3], uPointCol[3];
uniform vec4 uPowerRing;
in vec3 vN; in vec3 vW; in vec3 vP; in vec2 vUv; in float vAo; in float vZ;
flat in float vId; flat in int vM;
#ifdef INST
flat in vec4 fTint; flat in vec4 fFx;
#define TINT fTint.rgb
#define SKETCH fTint.a
#define FLASH fFx.x
#define REVEAL fFx.y
#define ENGINE fFx.z
#else
#define TINT uTint
#define SKETCH uSketch
#define FLASH uFlash
#define REVEAL uReveal
#define ENGINE uEngine
#endif
vec4 prm(int k){return texelFetch(uParam,ivec2(k,vM),0);}
float shadowMap(vec3 N,float ndl){
  if(uShadowSel<-.5) return 1.;
  float bias=mix(.16,.02,sat(ndl));
  if(uShadowSel<.5){
    vec4 s=uShadowMA*vec4(vW+N*bias,1.); vec3 c=s.xyz/s.w*.5+.5;
    if(any(lessThan(c,vec3(0.)))||any(greaterThan(c,vec3(1.)))) return 1.;
    float t=uShadowTexel.x; float r=0.;
    r+=texture(uShadowA,c+vec3(-.7,-.35,0.)*t); r+=texture(uShadowA,c+vec3(.7,-.35,0.)*t); r+=texture(uShadowA,c+vec3(.35,.7,0.)*t); r+=texture(uShadowA,c+vec3(-.35,.7,0.)*t);
    return r*.25;
  }
  vec4 s=uShadowMB*vec4(vW+N*bias*.25,1.); vec3 c=s.xyz/s.w*.5+.5;
  if(any(lessThan(c,vec3(0.)))||any(greaterThan(c,vec3(1.)))) return 1.;
  float t=uShadowTexel.y; float r=0.;
  r+=texture(uShadowB,c+vec3(-.7,-.35,0.)*t); r+=texture(uShadowB,c+vec3(.7,-.35,0.)*t); r+=texture(uShadowB,c+vec3(.35,.7,0.)*t); r+=texture(uShadowB,c+vec3(-.35,.7,0.)*t);
  return r*.25;
}
void main(){
  if(uGhost>.004){ vec2 gc=fract(mat2(.7071,-.7071,.7071,.7071)*gl_FragCoord.xy/uDot)-.5; if(length(gc)<uGhost*.76) discard; }
  vec3 N=normalize(vN); if(!gl_FrontFacing) N=-N;
  vec3 V=normalize(cameraPosition-vW);
  vec4 a=prm(0), b=prm(1), c=prm(2), d=prm(3), e=prm(4);
  if(REVEAL<1.){ float k=hash13(floor(vP*26.)); float q=vP.z*.5+.5; if(q*.86+k*.14>REVEAL) discard; }
  float ndl=dot(N,uSun);
  float sh=shadowMap(N,ndl);
  float key=max(ndl,0.)*sh*uKey;
  float down=max(-N.y*.6+.4,0.);
  float lum=key+.15*max(dot(N,uFill),0.)+dot(uBounce,vec3(.333))*down+.035;
  vec3 col=texture(uRamp,vec2((sat(lum)*127.+.5)/128.,(float(vM)+.5)/uMatN)).rgb;
  // 面板线
  if(a.x>2.5){ vec3 mk=texture(uMask,vUv/uUvq).rgb; float gm=a.x<3.5?mk.r:a.x<4.5?mk.g:mk.b; vec3 r2=texture(uRamp,vec2((sat(lum)*127.+.5)/128.,(e.z+.5)/uMatN)).rgb; col=mix(col,r2,gm); col+=r2*gm*uNight*.35; }
  else if(a.x>.5){ vec4 px=texture(uPanel,vUv); vec3 alb=a.x<1.5?vec3(px.r):vec3(px.g)*vec3(.985,.99,1.); col*=alb; }
  // 遮蔽
  float ao=mix(1.,smoothstep(.12,.86,vAo),min(a.y*2.1+.22,.82));
  col*=mix(vec3(.46,.52,.66),vec3(1.),ao);
  // 分色：亮部偏暖、暗部偏冷
  col*=mix(uShade,uLit,smoothstep(.12,.62,lum));
  col+=uBounce*down*.16*col;
  // 硬高光
  vec3 H=normalize(uSun+V); float sp=pow(max(dot(N,H),0.),mix(150.,18.,sat(a.w*2.2)));
  col+=a.z*1.25*smoothstep(.42,.5,sp)*sh*step(0.,ndl)*uLit;
  // 轮廓光
  float f=1.-sqrt(abs(dot(N,V)));
  col+=c.rgb*b.z*1.1*smoothstep(e.x,e.y,f)*mix(.35,1.,sh);
  // 局部光（传讯时照亮附近）
  for(int i=0;i<3;i++){ vec3 pd=uPointPos[i]-vW; float pl=length(pd); float pt=sat(1.-pl/uPointR[i]); pt*=pt*max(dot(N,pd/pl)*.7+.3,0.); float lm=dot(col,vec3(.3,.6,.1)); col=mix(col,max(col,col*.55+uPointCol[i]*(.35+.65*col)),pt*smoothstep(.02,.35,pt)*sat(dot(uPointCol[i],vec3(.5)))); }
  // 自发光
  int cls=int(c.w+.5);
  if(cls==6) col*=mix(vec3(1.),TINT,.86);
  if(cls>0&&cls!=6){
    float on=1.;
    if(cls==2) on=mix(.16,2.6,ENGINE);
    else if(cls==7) on=uTrim*1.25;
    else if(cls==1){ float tw=hash11(floor(vId*97.)+floor(uTime*.13+vId*11.)); on=uWindow*mix(.75,1.9,uNight)*mix(.55,1.,step(.18,tw)); }
    else if(cls==3) on=.12+uBeacon*2.4;
    else if(cls==4) on=.35+uPortal*1.9;
    else on=uTrim*mix(1.,1.35,uNight);
    if(uPowerRing.x<.999){ float ang=atan(vW.y,vW.x)/6.28318+.5; on*=smoothstep(0.,.03,uPowerRing.x*1.1-ang); }
    vec3 em=d.rgb*on; if(cls==7||(cls==2&&d.r>.99&&d.g>.99&&d.b>.99)) em=mix(TINT,vec3(1.),cls==2?.25:.06)*on*1.35;
    col=em*1.22+col*.12;
  } else if(uPowerRing.x<.999){ float ang=atan(vW.y,vW.x)/6.28318+.5; col*=mix(.3,1.,smoothstep(-.02,.06,uPowerRing.x*1.12-ang)); }
  col*=uDim;
  col=mix(col,uFlashCol*1.6,FLASH);
  col=mix(col,uHaze,uHazeK*smoothstep(30.,150.,vZ));
  float al=1.;
  #ifdef GLASS
    al=mix(b.w,1.,smoothstep(.45,.95,f)*.6);
  #endif
  // 线稿状态：填色退成半透明底，只留彩色线
  if(SKETCH>0.){
    #ifdef GLASS
      al*=1.-SKETCH;
    #else
      float sc=fract(vW.y*1.1-uTime*.35); float scan=smoothstep(.0,.05,sc)*(1.-smoothstep(.06,.14,sc));
      vec3 holo=TINT*(.05+.3*pow(f,1.6)+.22*scan);
      col=mix(col,holo,SKETCH);
    #endif
  }
  oColor=vec4(col,al);
  #ifdef GLASS
    oAux=vec4(0.);
  #else
    vec3 vn=normalize(mat3(viewMatrix)*N);
    float id=floor(vId*250.+1.)/256.;
    oAux=vec4(octEncode(vn),id*uInk+(SKETCH>.5?4.:0.),vZ);
  #endif
}`;

const DEPTH_FRAG = /* glsl */`
precision highp float; out vec4 o; void main(){ o=vec4(1.); }`;

export function celMaterial(uniforms, shared, glass = false, inst = false) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { ...env, ...uniforms }, defines: { ...(glass ? { GLASS: 1 } : {}), ...(inst ? { INST: 1 } : {}) },
    transparent: glass, depthWrite: !glass, side: glass ? THREE.DoubleSide : THREE.FrontSide,
    blending: glass ? THREE.CustomBlending : THREE.NoBlending,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}
export function depthMaterial(uniforms) {
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: DEPTH_FRAG, uniforms: { ...env, ...uniforms }, side: THREE.DoubleSide, colorWrite: false });
}
