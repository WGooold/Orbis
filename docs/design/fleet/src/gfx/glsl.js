// 公用 GLSL 片段
export const COMMON = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
float hash11(float p){p=fract(p*.1031);p*=p+33.33;p*=p+p;return fract(p);}
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec2 hash22(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yzx+33.33);return fract((p3.xx+p3.yz)*p3.zy);}
float hash13(vec3 p3){p3=fract(p3*.1031);p3+=dot(p3,p3.zyx+31.32);return fract((p3.x+p3.y)*p3.z);}
vec3 hash33(vec3 p3){p3=fract(p3*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yxz+33.33);return fract((p3.xxy+p3.yxx)*p3.zyx);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y);}
float gnoise(vec3 p){
  vec3 i=floor(p),f=fract(p);vec3 u=f*f*f*(f*(f*6.-15.)+10.);
  #define G(o) dot(hash33(i+o)*2.-1.,f-o)
  return mix(mix(mix(G(vec3(0,0,0)),G(vec3(1,0,0)),u.x),mix(G(vec3(0,1,0)),G(vec3(1,1,0)),u.x),u.y),mix(mix(G(vec3(0,0,1)),G(vec3(1,0,1)),u.x),mix(G(vec3(0,1,1)),G(vec3(1,1,1)),u.x),u.y),u.z);
  #undef G
}
vec2 octEncode(vec3 n){n/=abs(n.x)+abs(n.y)+abs(n.z);vec2 o=n.xy;if(n.z<0.)o=(1.-abs(n.yx))*vec2(n.x>=0.?1.:-1.,n.y>=0.?1.:-1.);return o*.5+.5;}
vec3 octDecode(vec2 e){e=e*2.-1.;vec3 v=vec3(e,1.-abs(e.x)-abs(e.y));if(v.z<0.)v.xy=(1.-abs(v.yx))*vec2(v.x>=0.?1.:-1.,v.y>=0.?1.:-1.);return normalize(v);}
float sat(float x){return clamp(x,0.,1.);}
vec3 sat(vec3 x){return clamp(x,0.,1.);}
`;
export const MRT_OUT = /* glsl */`
layout(location=0) out highp vec4 oColor;
layout(location=1) out highp vec4 oAux;
`;
