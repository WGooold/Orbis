var px="160",ui={LEFT:0,MIDDLE:1,RIGHT:2,ROTATE:0,DOLLY:1,PAN:2},di={ROTATE:0,PAN:1,DOLLY_PAN:2,DOLLY_ROTATE:3},mx=0,gx=1,_x=2,xx=3,vx=0,yx=1,Sx=2,Mx=3,Nc=0,Dc=1,Uc=2,bx=2,Fc=0,Tx=1,Oc=2,Ax=3,Ex=4,wx=5,Rx=100,Cx=101,Px=102,Lx=103,Ix=104,Nx=200,Dx=201,Ux=202,Fx=203,Ox=204,Bx=205,zx=206,kx=207,Gx=208,Hx=209,Wx=210,Vx=211,Xx=212,qx=213,Yx=214,Zx=0,Kx=1,Jx=2,$x=3,jx=4,Qx=5,ev=6,tv=7,nv=0,iv=1,sv=2,rv=0,Bc=1,zc=2,kc=3,Gc=4,av=5,Hc=6,ov="attached",lv="detached",cv=300,hv=301,uv=302,dv=303,fv=304,pv=306,Pr=1000,Wc=1001,Vc=1002,Xc=1003,qc=1004,mv=1004,Yc=1005,gv=1005,Qa=1006,Zc=1007,_v=1007,eo=1008,xv=1008,vv=1009,yv=1010,Sv=1011,Mv=1012,bv=1013,Tv=1014,Av=1015,Zi=1016,Ev=1017,wv=1018,Rv=1020,Cv=1021,Pv=1023,Lv=1024,Iv=1025,Nv=1026,Dv=1027,Uv=1028,Fv=1029,Ov=1030,Bv=1031,zv=1033,kv=33776,Gv=33777,Hv=33778,Wv=33779,Vv=35840,Xv=35841,qv=35842,Yv=35843,Zv=36196,Kv=37492,Jv=37496,$v=37808,jv=37809,Qv=37810,ey=37811,ty=37812,ny=37813,iy=37814,sy=37815,ry=37816,ay=37817,oy=37818,ly=37819,cy=37820,hy=37821,uy=36492,dy=36494,fy=36495,py=36283,my=36284,gy=36285,_y=36286,xy=2200,vy=2201,yy=2202,Kc=2300,to=2301,Sy=2302,My=2400,by=2401,Ty=2402,Ay=2500,Ey=2501,Jc=0,Lr=1,As=2,wy=3000,Ry=3001,Cy=3200,Py=3201,Ly=0,Iy=1,Ny="",Ki="srgb",dn="srgb-linear",Dy="display-p3",Uy="display-p3-linear",Fy="linear",$c="srgb",Oy="rec709",By="p3",zy=0,ky=7680,Gy=7681,Hy=7682,Wy=7683,Vy=34055,Xy=34056,qy=5386,Yy=512,Zy=513,Ky=514,Jy=515,$y=516,jy=517,Qy=518,eS=519,tS=512,nS=513,iS=514,sS=515,rS=516,aS=517,oS=518,lS=519,cS=35044,hS=35048,uS=35040,dS=35045,fS=35049,pS=35041,mS=35046,gS=35050,_S=35042,xS="100",vS="300 es",yS=1035,SS=2000,MS=2001;class nn{addEventListener(e,t){if(this._listeners===void 0)this._listeners={};let n=this._listeners;if(n[e]===void 0)n[e]=[];if(n[e].indexOf(t)===-1)n[e].push(t)}hasEventListener(e,t){if(this._listeners===void 0)return!1;let n=this._listeners;return n[e]!==void 0&&n[e].indexOf(t)!==-1}removeEventListener(e,t){if(this._listeners===void 0)return;let i=this._listeners[e];if(i!==void 0){let s=i.indexOf(t);if(s!==-1)i.splice(s,1)}}dispatchEvent(e){if(this._listeners===void 0)return;let n=this._listeners[e.type];if(n!==void 0){e.target=this;let i=n.slice(0);for(let s=0,r=i.length;s<r;s++)i[s].call(this,e);e.target=null}}}var It=["00","01","02","03","04","05","06","07","08","09","0a","0b","0c","0d","0e","0f","10","11","12","13","14","15","16","17","18","19","1a","1b","1c","1d","1e","1f","20","21","22","23","24","25","26","27","28","29","2a","2b","2c","2d","2e","2f","30","31","32","33","34","35","36","37","38","39","3a","3b","3c","3d","3e","3f","40","41","42","43","44","45","46","47","48","49","4a","4b","4c","4d","4e","4f","50","51","52","53","54","55","56","57","58","59","5a","5b","5c","5d","5e","5f","60","61","62","63","64","65","66","67","68","69","6a","6b","6c","6d","6e","6f","70","71","72","73","74","75","76","77","78","79","7a","7b","7c","7d","7e","7f","80","81","82","83","84","85","86","87","88","89","8a","8b","8c","8d","8e","8f","90","91","92","93","94","95","96","97","98","99","9a","9b","9c","9d","9e","9f","a0","a1","a2","a3","a4","a5","a6","a7","a8","a9","aa","ab","ac","ad","ae","af","b0","b1","b2","b3","b4","b5","b6","b7","b8","b9","ba","bb","bc","bd","be","bf","c0","c1","c2","c3","c4","c5","c6","c7","c8","c9","ca","cb","cc","cd","ce","cf","d0","d1","d2","d3","d4","d5","d6","d7","d8","d9","da","db","dc","dd","de","df","e0","e1","e2","e3","e4","e5","e6","e7","e8","e9","ea","eb","ec","ed","ee","ef","f0","f1","f2","f3","f4","f5","f6","f7","f8","f9","fa","fb","fc","fd","fe","ff"],sl=1234567,ai=Math.PI/180,qi=180/Math.PI;function Xt(){let e=Math.random()*4294967295|0,t=Math.random()*4294967295|0,n=Math.random()*4294967295|0,i=Math.random()*4294967295|0;return(It[e&255]+It[e>>8&255]+It[e>>16&255]+It[e>>24&255]+"-"+It[t&255]+It[t>>8&255]+"-"+It[t>>16&15|64]+It[t>>24&255]+"-"+It[n&63|128]+It[n>>8&255]+"-"+It[n>>16&255]+It[n>>24&255]+It[i&255]+It[i>>8&255]+It[i>>16&255]+It[i>>24&255]).toLowerCase()}function ft(e,t,n){return Math.max(t,Math.min(n,e))}function no(e,t){return(e%t+t)%t}function ed(e,t,n,i,s){return i+(e-t)*(s-i)/(n-t)}function td(e,t,n){if(e!==t)return(n-e)/(t-e);else return 0}function ps(e,t,n){return(1-n)*e+n*t}function nd(e,t,n,i){return ps(e,t,1-Math.exp(-n*i))}function id(e,t=1){return t-Math.abs(no(e,t*2)-t)}function sd(e,t,n){if(e<=t)return 0;if(e>=n)return 1;return e=(e-t)/(n-t),e*e*(3-2*e)}function rd(e,t,n){if(e<=t)return 0;if(e>=n)return 1;return e=(e-t)/(n-t),e*e*e*(e*(e*6-15)+10)}function ad(e,t){return e+Math.floor(Math.random()*(t-e+1))}function od(e,t){return e+Math.random()*(t-e)}function ld(e){return e*(0.5-Math.random())}function cd(e){if(e!==void 0)sl=e;let t=sl+=1831565813;return t=Math.imul(t^t>>>15,t|1),t^=t+Math.imul(t^t>>>7,t|61),((t^t>>>14)>>>0)/4294967296}function hd(e){return e*ai}function ud(e){return e*qi}function Xa(e){return(e&e-1)===0&&e!==0}function dd(e){return Math.pow(2,Math.ceil(Math.log(e)/Math.LN2))}function Rr(e){return Math.pow(2,Math.floor(Math.log(e)/Math.LN2))}function fd(e,t,n,i,s){let{cos:r,sin:a}=Math,o=r(n/2),l=a(n/2),c=r((t+i)/2),h=a((t+i)/2),u=r((t-i)/2),d=a((t-i)/2),f=r((i-t)/2),g=a((i-t)/2);switch(s){case"XYX":e.set(o*h,l*u,l*d,o*c);break;case"YZY":e.set(l*d,o*h,l*u,o*c);break;case"ZXZ":e.set(l*u,l*d,o*h,o*c);break;case"XZX":e.set(o*h,l*g,l*f,o*c);break;case"YXY":e.set(l*f,o*h,l*g,o*c);break;case"ZYZ":e.set(l*g,l*f,o*h,o*c);break;default:console.warn("THREE.MathUtils: .setQuaternionFromProperEuler() encountered an unknown order: "+s)}}function kt(e,t){switch(t.constructor){case Float32Array:return e;case Uint32Array:return e/4294967295;case Uint16Array:return e/65535;case Uint8Array:return e/255;case Int32Array:return Math.max(e/2147483647,-1);case Int16Array:return Math.max(e/32767,-1);case Int8Array:return Math.max(e/127,-1);default:throw Error("Invalid component type.")}}function Ve(e,t){switch(t.constructor){case Float32Array:return e;case Uint32Array:return Math.round(e*4294967295);case Uint16Array:return Math.round(e*65535);case Uint8Array:return Math.round(e*255);case Int32Array:return Math.round(e*2147483647);case Int16Array:return Math.round(e*32767);case Int8Array:return Math.round(e*127);default:throw Error("Invalid component type.")}}var Ir={DEG2RAD:ai,RAD2DEG:qi,generateUUID:Xt,clamp:ft,euclideanModulo:no,mapLinear:ed,inverseLerp:td,lerp:ps,damp:nd,pingpong:id,smoothstep:sd,smootherstep:rd,randInt:ad,randFloat:od,randFloatSpread:ld,seededRandom:cd,degToRad:hd,radToDeg:ud,isPowerOfTwo:Xa,ceilPowerOfTwo:dd,floorPowerOfTwo:Rr,setQuaternionFromProperEuler:fd,normalize:Ve,denormalize:kt};class W{constructor(e=0,t=0){W.prototype.isVector2=!0,this.x=e,this.y=t}get width(){return this.x}set width(e){this.x=e}get height(){return this.y}set height(e){this.y=e}set(e,t){return this.x=e,this.y=t,this}setScalar(e){return this.x=e,this.y=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;default:throw Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;default:throw Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y)}copy(e){return this.x=e.x,this.y=e.y,this}add(e){return this.x+=e.x,this.y+=e.y,this}addScalar(e){return this.x+=e,this.y+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this}subScalar(e){return this.x-=e,this.y-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this}multiply(e){return this.x*=e.x,this.y*=e.y,this}multiplyScalar(e){return this.x*=e,this.y*=e,this}divide(e){return this.x/=e.x,this.y/=e.y,this}divideScalar(e){return this.multiplyScalar(1/e)}applyMatrix3(e){let t=this.x,n=this.y,i=e.elements;return this.x=i[0]*t+i[3]*n+i[6],this.y=i[1]*t+i[4]*n+i[7],this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this}clamp(e,t){return this.x=Math.max(e.x,Math.min(t.x,this.x)),this.y=Math.max(e.y,Math.min(t.y,this.y)),this}clampScalar(e,t){return this.x=Math.max(e,Math.min(t,this.x)),this.y=Math.max(e,Math.min(t,this.y)),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(e,Math.min(t,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this}negate(){return this.x=-this.x,this.y=-this.y,this}dot(e){return this.x*e.x+this.y*e.y}cross(e){return this.x*e.y-this.y*e.x}lengthSq(){return this.x*this.x+this.y*this.y}length(){return Math.sqrt(this.x*this.x+this.y*this.y)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)}normalize(){return this.divideScalar(this.length()||1)}angle(){return Math.atan2(-this.y,-this.x)+Math.PI}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ft(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y;return t*t+n*n}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this}equals(e){return e.x===this.x&&e.y===this.y}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this}rotateAround(e,t){let n=Math.cos(t),i=Math.sin(t),s=this.x-e.x,r=this.y-e.y;return this.x=s*n-r*i+e.x,this.y=s*i+r*n+e.y,this}random(){return this.x=Math.random(),this.y=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y}}class Ze{constructor(e,t,n,i,s,r,a,o,l){if(Ze.prototype.isMatrix3=!0,this.elements=[1,0,0,0,1,0,0,0,1],e!==void 0)this.set(e,t,n,i,s,r,a,o,l)}set(e,t,n,i,s,r,a,o,l){let c=this.elements;return c[0]=e,c[1]=i,c[2]=a,c[3]=t,c[4]=s,c[5]=o,c[6]=n,c[7]=r,c[8]=l,this}identity(){return this.set(1,0,0,0,1,0,0,0,1),this}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],this}extractBasis(e,t,n){return e.setFromMatrix3Column(this,0),t.setFromMatrix3Column(this,1),n.setFromMatrix3Column(this,2),this}setFromMatrix4(e){let t=e.elements;return this.set(t[0],t[4],t[8],t[1],t[5],t[9],t[2],t[6],t[10]),this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,i=t.elements,s=this.elements,r=n[0],a=n[3],o=n[6],l=n[1],c=n[4],h=n[7],u=n[2],d=n[5],f=n[8],g=i[0],_=i[3],m=i[6],p=i[1],x=i[4],v=i[7],b=i[2],R=i[5],M=i[8];return s[0]=r*g+a*p+o*b,s[3]=r*_+a*x+o*R,s[6]=r*m+a*v+o*M,s[1]=l*g+c*p+h*b,s[4]=l*_+c*x+h*R,s[7]=l*m+c*v+h*M,s[2]=u*g+d*p+f*b,s[5]=u*_+d*x+f*R,s[8]=u*m+d*v+f*M,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[3]*=e,t[6]*=e,t[1]*=e,t[4]*=e,t[7]*=e,t[2]*=e,t[5]*=e,t[8]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[1],i=e[2],s=e[3],r=e[4],a=e[5],o=e[6],l=e[7],c=e[8];return t*r*c-t*a*l-n*s*c+n*a*o+i*s*l-i*r*o}invert(){let e=this.elements,t=e[0],n=e[1],i=e[2],s=e[3],r=e[4],a=e[5],o=e[6],l=e[7],c=e[8],h=c*r-a*l,u=a*o-c*s,d=l*s-r*o,f=t*h+n*u+i*d;if(f===0)return this.set(0,0,0,0,0,0,0,0,0);let g=1/f;return e[0]=h*g,e[1]=(i*l-c*n)*g,e[2]=(a*n-i*r)*g,e[3]=u*g,e[4]=(c*t-i*o)*g,e[5]=(i*s-a*t)*g,e[6]=d*g,e[7]=(n*o-l*t)*g,e[8]=(r*t-n*s)*g,this}transpose(){let e,t=this.elements;return e=t[1],t[1]=t[3],t[3]=e,e=t[2],t[2]=t[6],t[6]=e,e=t[5],t[5]=t[7],t[7]=e,this}getNormalMatrix(e){return this.setFromMatrix4(e).invert().transpose()}transposeIntoArray(e){let t=this.elements;return e[0]=t[0],e[1]=t[3],e[2]=t[6],e[3]=t[1],e[4]=t[4],e[5]=t[7],e[6]=t[2],e[7]=t[5],e[8]=t[8],this}setUvTransform(e,t,n,i,s,r,a){let o=Math.cos(s),l=Math.sin(s);return this.set(n*o,n*l,-n*(o*r+l*a)+r+e,-i*l,i*o,-i*(-l*r+o*a)+a+t,0,0,1),this}scale(e,t){return this.premultiply(ca.makeScale(e,t)),this}rotate(e){return this.premultiply(ca.makeRotation(-e)),this}translate(e,t){return this.premultiply(ca.makeTranslation(e,t)),this}makeTranslation(e,t){if(e.isVector2)this.set(1,0,e.x,0,1,e.y,0,0,1);else this.set(1,0,e,0,1,t,0,0,1);return this}makeRotation(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,n,t,0,0,0,1),this}makeScale(e,t){return this.set(e,0,0,0,t,0,0,0,1),this}equals(e){let t=this.elements,n=e.elements;for(let i=0;i<9;i++)if(t[i]!==n[i])return!1;return!0}fromArray(e,t=0){for(let n=0;n<9;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e}clone(){return new this.constructor().fromArray(this.elements)}}var ca=new Ze;function jc(e){for(let t=e.length-1;t>=0;--t)if(e[t]>=65535)return!0;return!1}var pd={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array};function Gi(e,t){return new pd[e](t)}function vs(e){return document.createElementNS("http://www.w3.org/1999/xhtml",e)}function md(){let e=vs("canvas");return e.style.display="block",e}var rl={};function ms(e){if(e in rl)return;rl[e]=!0,console.warn(e)}var al=new Ze().set(0.8224621,0.177538,0,0.0331941,0.9668058,0,0.0170827,0.0723974,0.9105199),ol=new Ze().set(1.2249401,-0.2249404,0,-0.0420569,1.0420571,0,-0.0196376,-0.0786361,1.0982735),Us={["srgb-linear"]:{transfer:"linear",primaries:"rec709",toReference:(e)=>e,fromReference:(e)=>e},["srgb"]:{transfer:"srgb",primaries:"rec709",toReference:(e)=>e.convertSRGBToLinear(),fromReference:(e)=>e.convertLinearToSRGB()},["display-p3-linear"]:{transfer:"linear",primaries:"p3",toReference:(e)=>e.applyMatrix3(ol),fromReference:(e)=>e.applyMatrix3(al)},["display-p3"]:{transfer:"srgb",primaries:"p3",toReference:(e)=>e.convertSRGBToLinear().applyMatrix3(ol),fromReference:(e)=>e.applyMatrix3(al).convertLinearToSRGB()}},gd=new Set(["srgb-linear","display-p3-linear"]),nt={enabled:!0,_workingColorSpace:"srgb-linear",get workingColorSpace(){return this._workingColorSpace},set workingColorSpace(e){if(!gd.has(e))throw Error(`Unsupported working color space, "${e}".`);this._workingColorSpace=e},convert:function(e,t,n){if(this.enabled===!1||t===n||!t||!n)return e;let i=Us[t].toReference,s=Us[n].fromReference;return s(i(e))},fromWorkingColorSpace:function(e,t){return this.convert(e,this._workingColorSpace,t)},toWorkingColorSpace:function(e,t){return this.convert(e,t,this._workingColorSpace)},getPrimaries:function(e){return Us[e].primaries},getTransfer:function(e){if(e==="")return"linear";return Us[e].transfer}};function Xi(e){return e<0.04045?e*0.0773993808:Math.pow(e*0.9478672986+0.0521327014,2.4)}function ha(e){return e<0.0031308?e*12.92:1.055*Math.pow(e,0.41666)-0.055}var yi;class io{static getDataURL(e){if(/^data:/i.test(e.src))return e.src;if(typeof HTMLCanvasElement>"u")return e.src;let t;if(e instanceof HTMLCanvasElement)t=e;else{if(yi===void 0)yi=vs("canvas");yi.width=e.width,yi.height=e.height;let n=yi.getContext("2d");if(e instanceof ImageData)n.putImageData(e,0,0);else n.drawImage(e,0,0,e.width,e.height);t=yi}if(t.width>2048||t.height>2048)return console.warn("THREE.ImageUtils.getDataURL: Image converted to jpg for performance reasons",e),t.toDataURL("image/jpeg",0.6);else return t.toDataURL("image/png")}static sRGBToLinear(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap){let t=vs("canvas");t.width=e.width,t.height=e.height;let n=t.getContext("2d");n.drawImage(e,0,0,e.width,e.height);let i=n.getImageData(0,0,e.width,e.height),s=i.data;for(let r=0;r<s.length;r++)s[r]=Xi(s[r]/255)*255;return n.putImageData(i,0,0),t}else if(e.data){let t=e.data.slice(0);for(let n=0;n<t.length;n++)if(t instanceof Uint8Array||t instanceof Uint8ClampedArray)t[n]=Math.floor(Xi(t[n]/255)*255);else t[n]=Xi(t[n]);return{data:t,width:e.width,height:e.height}}else return console.warn("THREE.ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."),e}}var _d=0;class si{constructor(e=null){this.isSource=!0,Object.defineProperty(this,"id",{value:_d++}),this.uuid=Xt(),this.data=e,this.version=0}set needsUpdate(e){if(e===!0)this.version++}toJSON(e){let t=e===void 0||typeof e==="string";if(!t&&e.images[this.uuid]!==void 0)return e.images[this.uuid];let n={uuid:this.uuid,url:""},i=this.data;if(i!==null){let s;if(Array.isArray(i)){s=[];for(let r=0,a=i.length;r<a;r++)if(i[r].isDataTexture)s.push(ua(i[r].image));else s.push(ua(i[r]))}else s=ua(i);n.url=s}if(!t)e.images[this.uuid]=n;return n}}function ua(e){if(typeof HTMLImageElement<"u"&&e instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&e instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&e instanceof ImageBitmap)return io.getDataURL(e);else if(e.data)return{data:Array.from(e.data),width:e.width,height:e.height,type:e.data.constructor.name};else return console.warn("THREE.Texture: Unable to serialize Texture."),{}}var xd=0;class ht extends nn{constructor(e=ht.DEFAULT_IMAGE,t=ht.DEFAULT_MAPPING,n=1001,i=1001,s=1006,r=1008,a=1023,o=1009,l=ht.DEFAULT_ANISOTROPY,c=""){super();if(this.isTexture=!0,Object.defineProperty(this,"id",{value:xd++}),this.uuid=Xt(),this.name="",this.source=new si(e),this.mipmaps=[],this.mapping=t,this.channel=0,this.wrapS=n,this.wrapT=i,this.magFilter=s,this.minFilter=r,this.anisotropy=l,this.format=a,this.internalFormat=null,this.type=o,this.offset=new W(0,0),this.repeat=new W(1,1),this.center=new W(0,0),this.rotation=0,this.matrixAutoUpdate=!0,this.matrix=new Ze,this.generateMipmaps=!0,this.premultiplyAlpha=!1,this.flipY=!0,this.unpackAlignment=4,typeof c==="string")this.colorSpace=c;else ms("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=c===3001?"srgb":"";this.userData={},this.version=0,this.onUpdate=null,this.isRenderTargetTexture=!1,this.needsPMREMUpdate=!1}get image(){return this.source.data}set image(e=null){this.source.data=e}updateMatrix(){this.matrix.setUvTransform(this.offset.x,this.offset.y,this.repeat.x,this.repeat.y,this.rotation,this.center.x,this.center.y)}clone(){return new this.constructor().copy(this)}copy(e){return this.name=e.name,this.source=e.source,this.mipmaps=e.mipmaps.slice(0),this.mapping=e.mapping,this.channel=e.channel,this.wrapS=e.wrapS,this.wrapT=e.wrapT,this.magFilter=e.magFilter,this.minFilter=e.minFilter,this.anisotropy=e.anisotropy,this.format=e.format,this.internalFormat=e.internalFormat,this.type=e.type,this.offset.copy(e.offset),this.repeat.copy(e.repeat),this.center.copy(e.center),this.rotation=e.rotation,this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrix.copy(e.matrix),this.generateMipmaps=e.generateMipmaps,this.premultiplyAlpha=e.premultiplyAlpha,this.flipY=e.flipY,this.unpackAlignment=e.unpackAlignment,this.colorSpace=e.colorSpace,this.userData=JSON.parse(JSON.stringify(e.userData)),this.needsUpdate=!0,this}toJSON(e){let t=e===void 0||typeof e==="string";if(!t&&e.textures[this.uuid]!==void 0)return e.textures[this.uuid];let n={metadata:{version:4.6,type:"Texture",generator:"Texture.toJSON"},uuid:this.uuid,name:this.name,image:this.source.toJSON(e).uuid,mapping:this.mapping,channel:this.channel,repeat:[this.repeat.x,this.repeat.y],offset:[this.offset.x,this.offset.y],center:[this.center.x,this.center.y],rotation:this.rotation,wrap:[this.wrapS,this.wrapT],format:this.format,internalFormat:this.internalFormat,type:this.type,colorSpace:this.colorSpace,minFilter:this.minFilter,magFilter:this.magFilter,anisotropy:this.anisotropy,flipY:this.flipY,generateMipmaps:this.generateMipmaps,premultiplyAlpha:this.premultiplyAlpha,unpackAlignment:this.unpackAlignment};if(Object.keys(this.userData).length>0)n.userData=this.userData;if(!t)e.textures[this.uuid]=n;return n}dispose(){this.dispatchEvent({type:"dispose"})}transformUv(e){if(this.mapping!==300)return e;if(e.applyMatrix3(this.matrix),e.x<0||e.x>1)switch(this.wrapS){case 1000:e.x=e.x-Math.floor(e.x);break;case 1001:e.x=e.x<0?0:1;break;case 1002:if(Math.abs(Math.floor(e.x)%2)===1)e.x=Math.ceil(e.x)-e.x;else e.x=e.x-Math.floor(e.x);break}if(e.y<0||e.y>1)switch(this.wrapT){case 1000:e.y=e.y-Math.floor(e.y);break;case 1001:e.y=e.y<0?0:1;break;case 1002:if(Math.abs(Math.floor(e.y)%2)===1)e.y=Math.ceil(e.y)-e.y;else e.y=e.y-Math.floor(e.y);break}if(this.flipY)e.y=1-e.y;return e}set needsUpdate(e){if(e===!0)this.version++,this.source.needsUpdate=!0}get encoding(){return ms("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace==="srgb"?3001:3000}set encoding(e){ms("THREE.Texture: Property .encoding has been replaced by .colorSpace."),this.colorSpace=e===3001?"srgb":""}}ht.DEFAULT_IMAGE=null;ht.DEFAULT_MAPPING=300;ht.DEFAULT_ANISOTROPY=1;class at{constructor(e=0,t=0,n=0,i=1){at.prototype.isVector4=!0,this.x=e,this.y=t,this.z=n,this.w=i}get width(){return this.z}set width(e){this.z=e}get height(){return this.w}set height(e){this.w=e}set(e,t,n,i){return this.x=e,this.y=t,this.z=n,this.w=i,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this.w=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setW(e){return this.w=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;case 3:this.w=t;break;default:throw Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;case 3:return this.w;default:throw Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z,this.w)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this.w=e.w!==void 0?e.w:1,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this.w+=e.w,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this.w+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this.w=e.w+t.w,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this.w+=e.w*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this.w-=e.w,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this.w-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this.w=e.w-t.w,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this.w*=e.w,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this.w*=e,this}applyMatrix4(e){let t=this.x,n=this.y,i=this.z,s=this.w,r=e.elements;return this.x=r[0]*t+r[4]*n+r[8]*i+r[12]*s,this.y=r[1]*t+r[5]*n+r[9]*i+r[13]*s,this.z=r[2]*t+r[6]*n+r[10]*i+r[14]*s,this.w=r[3]*t+r[7]*n+r[11]*i+r[15]*s,this}divideScalar(e){return this.multiplyScalar(1/e)}setAxisAngleFromQuaternion(e){this.w=2*Math.acos(e.w);let t=Math.sqrt(1-e.w*e.w);if(t<0.0001)this.x=1,this.y=0,this.z=0;else this.x=e.x/t,this.y=e.y/t,this.z=e.z/t;return this}setAxisAngleFromRotationMatrix(e){let t,n,i,s,r=0.01,a=0.1,o=e.elements,l=o[0],c=o[4],h=o[8],u=o[1],d=o[5],f=o[9],g=o[2],_=o[6],m=o[10];if(Math.abs(c-u)<0.01&&Math.abs(h-g)<0.01&&Math.abs(f-_)<0.01){if(Math.abs(c+u)<0.1&&Math.abs(h+g)<0.1&&Math.abs(f+_)<0.1&&Math.abs(l+d+m-3)<0.1)return this.set(1,0,0,0),this;t=Math.PI;let x=(l+1)/2,v=(d+1)/2,b=(m+1)/2,R=(c+u)/4,M=(h+g)/4,C=(f+_)/4;if(x>v&&x>b)if(x<0.01)n=0,i=0.707106781,s=0.707106781;else n=Math.sqrt(x),i=R/n,s=M/n;else if(v>b)if(v<0.01)n=0.707106781,i=0,s=0.707106781;else i=Math.sqrt(v),n=R/i,s=C/i;else if(b<0.01)n=0.707106781,i=0.707106781,s=0;else s=Math.sqrt(b),n=M/s,i=C/s;return this.set(n,i,s,t),this}let p=Math.sqrt((_-f)*(_-f)+(h-g)*(h-g)+(u-c)*(u-c));if(Math.abs(p)<0.001)p=1;return this.x=(_-f)/p,this.y=(h-g)/p,this.z=(u-c)/p,this.w=Math.acos((l+d+m-1)/2),this}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this.w=Math.min(this.w,e.w),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this.w=Math.max(this.w,e.w),this}clamp(e,t){return this.x=Math.max(e.x,Math.min(t.x,this.x)),this.y=Math.max(e.y,Math.min(t.y,this.y)),this.z=Math.max(e.z,Math.min(t.z,this.z)),this.w=Math.max(e.w,Math.min(t.w,this.w)),this}clampScalar(e,t){return this.x=Math.max(e,Math.min(t,this.x)),this.y=Math.max(e,Math.min(t,this.y)),this.z=Math.max(e,Math.min(t,this.z)),this.w=Math.max(e,Math.min(t,this.w)),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(e,Math.min(t,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this.w=Math.floor(this.w),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this.w=Math.ceil(this.w),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this.w=Math.round(this.w),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this.w=Math.trunc(this.w),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this.w=-this.w,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z+this.w*e.w}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z+this.w*this.w)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)+Math.abs(this.w)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this.w+=(e.w-this.w)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this.w=e.w+(t.w-e.w)*n,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z&&e.w===this.w}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this.w=e[t+3],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e[t+3]=this.w,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this.w=e.getW(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this.w=Math.random(),this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z,yield this.w}}class Qc extends nn{constructor(e=1,t=1,n={}){super();this.isRenderTarget=!0,this.width=e,this.height=t,this.depth=1,this.scissor=new at(0,0,e,t),this.scissorTest=!1,this.viewport=new at(0,0,e,t);let i={width:e,height:t,depth:1};if(n.encoding!==void 0)ms("THREE.WebGLRenderTarget: option.encoding has been replaced by option.colorSpace."),n.colorSpace=n.encoding===3001?"srgb":"";n=Object.assign({generateMipmaps:!1,internalFormat:null,minFilter:1006,depthBuffer:!0,stencilBuffer:!1,depthTexture:null,samples:0},n),this.texture=new ht(i,n.mapping,n.wrapS,n.wrapT,n.magFilter,n.minFilter,n.format,n.type,n.anisotropy,n.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.flipY=!1,this.texture.generateMipmaps=n.generateMipmaps,this.texture.internalFormat=n.internalFormat,this.depthBuffer=n.depthBuffer,this.stencilBuffer=n.stencilBuffer,this.depthTexture=n.depthTexture,this.samples=n.samples}setSize(e,t,n=1){if(this.width!==e||this.height!==t||this.depth!==n)this.width=e,this.height=t,this.depth=n,this.texture.image.width=e,this.texture.image.height=t,this.texture.image.depth=n,this.dispose();this.viewport.set(0,0,e,t),this.scissor.set(0,0,e,t)}clone(){return new this.constructor().copy(this)}copy(e){this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.texture=e.texture.clone(),this.texture.isRenderTargetTexture=!0;let t=Object.assign({},e.texture.image);if(this.texture.source=new si(t),this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,e.depthTexture!==null)this.depthTexture=e.depthTexture.clone();return this.samples=e.samples,this}dispose(){this.dispatchEvent({type:"dispose"})}}class Ct extends Qc{constructor(e=1,t=1,n={}){super(e,t,n);this.isWebGLRenderTarget=!0}}class Nr extends ht{constructor(e=null,t=1,n=1,i=1){super(null);this.isDataArrayTexture=!0,this.image={data:e,width:t,height:n,depth:i},this.magFilter=1003,this.minFilter=1003,this.wrapR=1001,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}class vd extends Ct{constructor(e=1,t=1,n=1,i={}){super(e,t,i);this.isWebGLArrayRenderTarget=!0,this.depth=n,this.texture=new Nr(null,e,t,n),this.texture.isRenderTargetTexture=!0}}class so extends ht{constructor(e=null,t=1,n=1,i=1){super(null);this.isData3DTexture=!0,this.image={data:e,width:t,height:n,depth:i},this.magFilter=1003,this.minFilter=1003,this.wrapR=1001,this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}class yd extends Ct{constructor(e=1,t=1,n=1,i={}){super(e,t,i);this.isWebGL3DRenderTarget=!0,this.depth=n,this.texture=new so(null,e,t,n),this.texture.isRenderTargetTexture=!0}}class Sd extends Ct{constructor(e=1,t=1,n=1,i={}){super(e,t,i);this.isWebGLMultipleRenderTargets=!0;let s=this.texture;this.texture=[];for(let r=0;r<n;r++)this.texture[r]=s.clone(),this.texture[r].isRenderTargetTexture=!0}setSize(e,t,n=1){if(this.width!==e||this.height!==t||this.depth!==n){this.width=e,this.height=t,this.depth=n;for(let i=0,s=this.texture.length;i<s;i++)this.texture[i].image.width=e,this.texture[i].image.height=t,this.texture[i].image.depth=n;this.dispose()}this.viewport.set(0,0,e,t),this.scissor.set(0,0,e,t)}copy(e){if(this.dispose(),this.width=e.width,this.height=e.height,this.depth=e.depth,this.scissor.copy(e.scissor),this.scissorTest=e.scissorTest,this.viewport.copy(e.viewport),this.depthBuffer=e.depthBuffer,this.stencilBuffer=e.stencilBuffer,e.depthTexture!==null)this.depthTexture=e.depthTexture.clone();this.texture.length=0;for(let t=0,n=e.texture.length;t<n;t++)this.texture[t]=e.texture[t].clone(),this.texture[t].isRenderTargetTexture=!0;return this}}class _t{constructor(e=0,t=0,n=0,i=1){this.isQuaternion=!0,this._x=e,this._y=t,this._z=n,this._w=i}static slerpFlat(e,t,n,i,s,r,a){let o=n[i+0],l=n[i+1],c=n[i+2],h=n[i+3],u=s[r+0],d=s[r+1],f=s[r+2],g=s[r+3];if(a===0){e[t+0]=o,e[t+1]=l,e[t+2]=c,e[t+3]=h;return}if(a===1){e[t+0]=u,e[t+1]=d,e[t+2]=f,e[t+3]=g;return}if(h!==g||o!==u||l!==d||c!==f){let _=1-a,m=o*u+l*d+c*f+h*g,p=m>=0?1:-1,x=1-m*m;if(x>Number.EPSILON){let b=Math.sqrt(x),R=Math.atan2(b,m*p);_=Math.sin(_*R)/b,a=Math.sin(a*R)/b}let v=a*p;if(o=o*_+u*v,l=l*_+d*v,c=c*_+f*v,h=h*_+g*v,_===1-a){let b=1/Math.sqrt(o*o+l*l+c*c+h*h);o*=b,l*=b,c*=b,h*=b}}e[t]=o,e[t+1]=l,e[t+2]=c,e[t+3]=h}static multiplyQuaternionsFlat(e,t,n,i,s,r){let a=n[i],o=n[i+1],l=n[i+2],c=n[i+3],h=s[r],u=s[r+1],d=s[r+2],f=s[r+3];return e[t]=a*f+c*h+o*d-l*u,e[t+1]=o*f+c*u+l*h-a*d,e[t+2]=l*f+c*d+a*u-o*h,e[t+3]=c*f-a*h-o*u-l*d,e}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get w(){return this._w}set w(e){this._w=e,this._onChangeCallback()}set(e,t,n,i){return this._x=e,this._y=t,this._z=n,this._w=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._w)}copy(e){return this._x=e.x,this._y=e.y,this._z=e.z,this._w=e.w,this._onChangeCallback(),this}setFromEuler(e,t=!0){let{_x:n,_y:i,_z:s,_order:r}=e,{cos:a,sin:o}=Math,l=a(n/2),c=a(i/2),h=a(s/2),u=o(n/2),d=o(i/2),f=o(s/2);switch(r){case"XYZ":this._x=u*c*h+l*d*f,this._y=l*d*h-u*c*f,this._z=l*c*f+u*d*h,this._w=l*c*h-u*d*f;break;case"YXZ":this._x=u*c*h+l*d*f,this._y=l*d*h-u*c*f,this._z=l*c*f-u*d*h,this._w=l*c*h+u*d*f;break;case"ZXY":this._x=u*c*h-l*d*f,this._y=l*d*h+u*c*f,this._z=l*c*f+u*d*h,this._w=l*c*h-u*d*f;break;case"ZYX":this._x=u*c*h-l*d*f,this._y=l*d*h+u*c*f,this._z=l*c*f-u*d*h,this._w=l*c*h+u*d*f;break;case"YZX":this._x=u*c*h+l*d*f,this._y=l*d*h+u*c*f,this._z=l*c*f-u*d*h,this._w=l*c*h-u*d*f;break;case"XZY":this._x=u*c*h-l*d*f,this._y=l*d*h-u*c*f,this._z=l*c*f+u*d*h,this._w=l*c*h+u*d*f;break;default:console.warn("THREE.Quaternion: .setFromEuler() encountered an unknown order: "+r)}if(t===!0)this._onChangeCallback();return this}setFromAxisAngle(e,t){let n=t/2,i=Math.sin(n);return this._x=e.x*i,this._y=e.y*i,this._z=e.z*i,this._w=Math.cos(n),this._onChangeCallback(),this}setFromRotationMatrix(e){let t=e.elements,n=t[0],i=t[4],s=t[8],r=t[1],a=t[5],o=t[9],l=t[2],c=t[6],h=t[10],u=n+a+h;if(u>0){let d=0.5/Math.sqrt(u+1);this._w=0.25/d,this._x=(c-o)*d,this._y=(s-l)*d,this._z=(r-i)*d}else if(n>a&&n>h){let d=2*Math.sqrt(1+n-a-h);this._w=(c-o)/d,this._x=0.25*d,this._y=(i+r)/d,this._z=(s+l)/d}else if(a>h){let d=2*Math.sqrt(1+a-n-h);this._w=(s-l)/d,this._x=(i+r)/d,this._y=0.25*d,this._z=(o+c)/d}else{let d=2*Math.sqrt(1+h-n-a);this._w=(r-i)/d,this._x=(s+l)/d,this._y=(o+c)/d,this._z=0.25*d}return this._onChangeCallback(),this}setFromUnitVectors(e,t){let n=e.dot(t)+1;if(n<Number.EPSILON)if(n=0,Math.abs(e.x)>Math.abs(e.z))this._x=-e.y,this._y=e.x,this._z=0,this._w=n;else this._x=0,this._y=-e.z,this._z=e.y,this._w=n;else this._x=e.y*t.z-e.z*t.y,this._y=e.z*t.x-e.x*t.z,this._z=e.x*t.y-e.y*t.x,this._w=n;return this.normalize()}angleTo(e){return 2*Math.acos(Math.abs(ft(this.dot(e),-1,1)))}rotateTowards(e,t){let n=this.angleTo(e);if(n===0)return this;let i=Math.min(1,t/n);return this.slerp(e,i),this}identity(){return this.set(0,0,0,1)}invert(){return this.conjugate()}conjugate(){return this._x*=-1,this._y*=-1,this._z*=-1,this._onChangeCallback(),this}dot(e){return this._x*e._x+this._y*e._y+this._z*e._z+this._w*e._w}lengthSq(){return this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w}length(){return Math.sqrt(this._x*this._x+this._y*this._y+this._z*this._z+this._w*this._w)}normalize(){let e=this.length();if(e===0)this._x=0,this._y=0,this._z=0,this._w=1;else e=1/e,this._x=this._x*e,this._y=this._y*e,this._z=this._z*e,this._w=this._w*e;return this._onChangeCallback(),this}multiply(e){return this.multiplyQuaternions(this,e)}premultiply(e){return this.multiplyQuaternions(e,this)}multiplyQuaternions(e,t){let{_x:n,_y:i,_z:s,_w:r}=e,{_x:a,_y:o,_z:l,_w:c}=t;return this._x=n*c+r*a+i*l-s*o,this._y=i*c+r*o+s*a-n*l,this._z=s*c+r*l+n*o-i*a,this._w=r*c-n*a-i*o-s*l,this._onChangeCallback(),this}slerp(e,t){if(t===0)return this;if(t===1)return this.copy(e);let n=this._x,i=this._y,s=this._z,r=this._w,a=r*e._w+n*e._x+i*e._y+s*e._z;if(a<0)this._w=-e._w,this._x=-e._x,this._y=-e._y,this._z=-e._z,a=-a;else this.copy(e);if(a>=1)return this._w=r,this._x=n,this._y=i,this._z=s,this;let o=1-a*a;if(o<=Number.EPSILON){let d=1-t;return this._w=d*r+t*this._w,this._x=d*n+t*this._x,this._y=d*i+t*this._y,this._z=d*s+t*this._z,this.normalize(),this}let l=Math.sqrt(o),c=Math.atan2(l,a),h=Math.sin((1-t)*c)/l,u=Math.sin(t*c)/l;return this._w=r*h+this._w*u,this._x=n*h+this._x*u,this._y=i*h+this._y*u,this._z=s*h+this._z*u,this._onChangeCallback(),this}slerpQuaternions(e,t,n){return this.copy(e).slerp(t,n)}random(){let e=Math.random(),t=Math.sqrt(1-e),n=Math.sqrt(e),i=2*Math.PI*Math.random(),s=2*Math.PI*Math.random();return this.set(t*Math.cos(i),n*Math.sin(s),n*Math.cos(s),t*Math.sin(i))}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._w===this._w}fromArray(e,t=0){return this._x=e[t],this._y=e[t+1],this._z=e[t+2],this._w=e[t+3],this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._w,e}fromBufferAttribute(e,t){return this._x=e.getX(t),this._y=e.getY(t),this._z=e.getZ(t),this._w=e.getW(t),this._onChangeCallback(),this}toJSON(){return this.toArray()}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._w}}class T{constructor(e=0,t=0,n=0){T.prototype.isVector3=!0,this.x=e,this.y=t,this.z=n}set(e,t,n){if(n===void 0)n=this.z;return this.x=e,this.y=t,this.z=n,this}setScalar(e){return this.x=e,this.y=e,this.z=e,this}setX(e){return this.x=e,this}setY(e){return this.y=e,this}setZ(e){return this.z=e,this}setComponent(e,t){switch(e){case 0:this.x=t;break;case 1:this.y=t;break;case 2:this.z=t;break;default:throw Error("index is out of range: "+e)}return this}getComponent(e){switch(e){case 0:return this.x;case 1:return this.y;case 2:return this.z;default:throw Error("index is out of range: "+e)}}clone(){return new this.constructor(this.x,this.y,this.z)}copy(e){return this.x=e.x,this.y=e.y,this.z=e.z,this}add(e){return this.x+=e.x,this.y+=e.y,this.z+=e.z,this}addScalar(e){return this.x+=e,this.y+=e,this.z+=e,this}addVectors(e,t){return this.x=e.x+t.x,this.y=e.y+t.y,this.z=e.z+t.z,this}addScaledVector(e,t){return this.x+=e.x*t,this.y+=e.y*t,this.z+=e.z*t,this}sub(e){return this.x-=e.x,this.y-=e.y,this.z-=e.z,this}subScalar(e){return this.x-=e,this.y-=e,this.z-=e,this}subVectors(e,t){return this.x=e.x-t.x,this.y=e.y-t.y,this.z=e.z-t.z,this}multiply(e){return this.x*=e.x,this.y*=e.y,this.z*=e.z,this}multiplyScalar(e){return this.x*=e,this.y*=e,this.z*=e,this}multiplyVectors(e,t){return this.x=e.x*t.x,this.y=e.y*t.y,this.z=e.z*t.z,this}applyEuler(e){return this.applyQuaternion(ll.setFromEuler(e))}applyAxisAngle(e,t){return this.applyQuaternion(ll.setFromAxisAngle(e,t))}applyMatrix3(e){let t=this.x,n=this.y,i=this.z,s=e.elements;return this.x=s[0]*t+s[3]*n+s[6]*i,this.y=s[1]*t+s[4]*n+s[7]*i,this.z=s[2]*t+s[5]*n+s[8]*i,this}applyNormalMatrix(e){return this.applyMatrix3(e).normalize()}applyMatrix4(e){let t=this.x,n=this.y,i=this.z,s=e.elements,r=1/(s[3]*t+s[7]*n+s[11]*i+s[15]);return this.x=(s[0]*t+s[4]*n+s[8]*i+s[12])*r,this.y=(s[1]*t+s[5]*n+s[9]*i+s[13])*r,this.z=(s[2]*t+s[6]*n+s[10]*i+s[14])*r,this}applyQuaternion(e){let t=this.x,n=this.y,i=this.z,{x:s,y:r,z:a,w:o}=e,l=2*(r*i-a*n),c=2*(a*t-s*i),h=2*(s*n-r*t);return this.x=t+o*l+r*h-a*c,this.y=n+o*c+a*l-s*h,this.z=i+o*h+s*c-r*l,this}project(e){return this.applyMatrix4(e.matrixWorldInverse).applyMatrix4(e.projectionMatrix)}unproject(e){return this.applyMatrix4(e.projectionMatrixInverse).applyMatrix4(e.matrixWorld)}transformDirection(e){let t=this.x,n=this.y,i=this.z,s=e.elements;return this.x=s[0]*t+s[4]*n+s[8]*i,this.y=s[1]*t+s[5]*n+s[9]*i,this.z=s[2]*t+s[6]*n+s[10]*i,this.normalize()}divide(e){return this.x/=e.x,this.y/=e.y,this.z/=e.z,this}divideScalar(e){return this.multiplyScalar(1/e)}min(e){return this.x=Math.min(this.x,e.x),this.y=Math.min(this.y,e.y),this.z=Math.min(this.z,e.z),this}max(e){return this.x=Math.max(this.x,e.x),this.y=Math.max(this.y,e.y),this.z=Math.max(this.z,e.z),this}clamp(e,t){return this.x=Math.max(e.x,Math.min(t.x,this.x)),this.y=Math.max(e.y,Math.min(t.y,this.y)),this.z=Math.max(e.z,Math.min(t.z,this.z)),this}clampScalar(e,t){return this.x=Math.max(e,Math.min(t,this.x)),this.y=Math.max(e,Math.min(t,this.y)),this.z=Math.max(e,Math.min(t,this.z)),this}clampLength(e,t){let n=this.length();return this.divideScalar(n||1).multiplyScalar(Math.max(e,Math.min(t,n)))}floor(){return this.x=Math.floor(this.x),this.y=Math.floor(this.y),this.z=Math.floor(this.z),this}ceil(){return this.x=Math.ceil(this.x),this.y=Math.ceil(this.y),this.z=Math.ceil(this.z),this}round(){return this.x=Math.round(this.x),this.y=Math.round(this.y),this.z=Math.round(this.z),this}roundToZero(){return this.x=Math.trunc(this.x),this.y=Math.trunc(this.y),this.z=Math.trunc(this.z),this}negate(){return this.x=-this.x,this.y=-this.y,this.z=-this.z,this}dot(e){return this.x*e.x+this.y*e.y+this.z*e.z}lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}length(){return Math.sqrt(this.x*this.x+this.y*this.y+this.z*this.z)}manhattanLength(){return Math.abs(this.x)+Math.abs(this.y)+Math.abs(this.z)}normalize(){return this.divideScalar(this.length()||1)}setLength(e){return this.normalize().multiplyScalar(e)}lerp(e,t){return this.x+=(e.x-this.x)*t,this.y+=(e.y-this.y)*t,this.z+=(e.z-this.z)*t,this}lerpVectors(e,t,n){return this.x=e.x+(t.x-e.x)*n,this.y=e.y+(t.y-e.y)*n,this.z=e.z+(t.z-e.z)*n,this}cross(e){return this.crossVectors(this,e)}crossVectors(e,t){let{x:n,y:i,z:s}=e,{x:r,y:a,z:o}=t;return this.x=i*o-s*a,this.y=s*r-n*o,this.z=n*a-i*r,this}projectOnVector(e){let t=e.lengthSq();if(t===0)return this.set(0,0,0);let n=e.dot(this)/t;return this.copy(e).multiplyScalar(n)}projectOnPlane(e){return da.copy(this).projectOnVector(e),this.sub(da)}reflect(e){return this.sub(da.copy(e).multiplyScalar(2*this.dot(e)))}angleTo(e){let t=Math.sqrt(this.lengthSq()*e.lengthSq());if(t===0)return Math.PI/2;let n=this.dot(e)/t;return Math.acos(ft(n,-1,1))}distanceTo(e){return Math.sqrt(this.distanceToSquared(e))}distanceToSquared(e){let t=this.x-e.x,n=this.y-e.y,i=this.z-e.z;return t*t+n*n+i*i}manhattanDistanceTo(e){return Math.abs(this.x-e.x)+Math.abs(this.y-e.y)+Math.abs(this.z-e.z)}setFromSpherical(e){return this.setFromSphericalCoords(e.radius,e.phi,e.theta)}setFromSphericalCoords(e,t,n){let i=Math.sin(t)*e;return this.x=i*Math.sin(n),this.y=Math.cos(t)*e,this.z=i*Math.cos(n),this}setFromCylindrical(e){return this.setFromCylindricalCoords(e.radius,e.theta,e.y)}setFromCylindricalCoords(e,t,n){return this.x=e*Math.sin(t),this.y=n,this.z=e*Math.cos(t),this}setFromMatrixPosition(e){let t=e.elements;return this.x=t[12],this.y=t[13],this.z=t[14],this}setFromMatrixScale(e){let t=this.setFromMatrixColumn(e,0).length(),n=this.setFromMatrixColumn(e,1).length(),i=this.setFromMatrixColumn(e,2).length();return this.x=t,this.y=n,this.z=i,this}setFromMatrixColumn(e,t){return this.fromArray(e.elements,t*4)}setFromMatrix3Column(e,t){return this.fromArray(e.elements,t*3)}setFromEuler(e){return this.x=e._x,this.y=e._y,this.z=e._z,this}setFromColor(e){return this.x=e.r,this.y=e.g,this.z=e.b,this}equals(e){return e.x===this.x&&e.y===this.y&&e.z===this.z}fromArray(e,t=0){return this.x=e[t],this.y=e[t+1],this.z=e[t+2],this}toArray(e=[],t=0){return e[t]=this.x,e[t+1]=this.y,e[t+2]=this.z,e}fromBufferAttribute(e,t){return this.x=e.getX(t),this.y=e.getY(t),this.z=e.getZ(t),this}random(){return this.x=Math.random(),this.y=Math.random(),this.z=Math.random(),this}randomDirection(){let e=(Math.random()-0.5)*2,t=Math.random()*Math.PI*2,n=Math.sqrt(1-e**2);return this.x=n*Math.cos(t),this.y=n*Math.sin(t),this.z=e,this}*[Symbol.iterator](){yield this.x,yield this.y,yield this.z}}var da=new T,ll=new _t;class Rt{constructor(e=new T(1/0,1/0,1/0),t=new T(-1/0,-1/0,-1/0)){this.isBox3=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromArray(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t+=3)this.expandByPoint(Qt.fromArray(e,t));return this}setFromBufferAttribute(e){this.makeEmpty();for(let t=0,n=e.count;t<n;t++)this.expandByPoint(Qt.fromBufferAttribute(e,t));return this}setFromPoints(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){let n=Qt.copy(t).multiplyScalar(0.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}setFromObject(e,t=!1){return this.makeEmpty(),this.expandByObject(e,t)}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=this.min.z=1/0,this.max.x=this.max.y=this.max.z=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y||this.max.z<this.min.z}getCenter(e){return this.isEmpty()?e.set(0,0,0):e.addVectors(this.min,this.max).multiplyScalar(0.5)}getSize(e){return this.isEmpty()?e.set(0,0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}expandByObject(e,t=!1){e.updateWorldMatrix(!1,!1);let n=e.geometry;if(n!==void 0){let s=n.getAttribute("position");if(t===!0&&s!==void 0&&e.isInstancedMesh!==!0)for(let r=0,a=s.count;r<a;r++){if(e.isMesh===!0)e.getVertexPosition(r,Qt);else Qt.fromBufferAttribute(s,r);Qt.applyMatrix4(e.matrixWorld),this.expandByPoint(Qt)}else{if(e.boundingBox!==void 0){if(e.boundingBox===null)e.computeBoundingBox();Fs.copy(e.boundingBox)}else{if(n.boundingBox===null)n.computeBoundingBox();Fs.copy(n.boundingBox)}Fs.applyMatrix4(e.matrixWorld),this.union(Fs)}}let i=e.children;for(let s=0,r=i.length;s<r;s++)this.expandByObject(i[s],t);return this}containsPoint(e){return e.x<this.min.x||e.x>this.max.x||e.y<this.min.y||e.y>this.max.y||e.z<this.min.z||e.z>this.max.z?!1:!0}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y&&this.min.z<=e.min.z&&e.max.z<=this.max.z}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y),(e.z-this.min.z)/(this.max.z-this.min.z))}intersectsBox(e){return e.max.x<this.min.x||e.min.x>this.max.x||e.max.y<this.min.y||e.min.y>this.max.y||e.max.z<this.min.z||e.min.z>this.max.z?!1:!0}intersectsSphere(e){return this.clampPoint(e.center,Qt),Qt.distanceToSquared(e.center)<=e.radius*e.radius}intersectsPlane(e){let t,n;if(e.normal.x>0)t=e.normal.x*this.min.x,n=e.normal.x*this.max.x;else t=e.normal.x*this.max.x,n=e.normal.x*this.min.x;if(e.normal.y>0)t+=e.normal.y*this.min.y,n+=e.normal.y*this.max.y;else t+=e.normal.y*this.max.y,n+=e.normal.y*this.min.y;if(e.normal.z>0)t+=e.normal.z*this.min.z,n+=e.normal.z*this.max.z;else t+=e.normal.z*this.max.z,n+=e.normal.z*this.min.z;return t<=-e.constant&&n>=-e.constant}intersectsTriangle(e){if(this.isEmpty())return!1;this.getCenter(ns),Os.subVectors(this.max,ns),Si.subVectors(e.a,ns),Mi.subVectors(e.b,ns),bi.subVectors(e.c,ns),wn.subVectors(Mi,Si),Rn.subVectors(bi,Mi),qn.subVectors(Si,bi);let t=[0,-wn.z,wn.y,0,-Rn.z,Rn.y,0,-qn.z,qn.y,wn.z,0,-wn.x,Rn.z,0,-Rn.x,qn.z,0,-qn.x,-wn.y,wn.x,0,-Rn.y,Rn.x,0,-qn.y,qn.x,0];if(!fa(t,Si,Mi,bi,Os))return!1;if(t=[1,0,0,0,1,0,0,0,1],!fa(t,Si,Mi,bi,Os))return!1;return Bs.crossVectors(wn,Rn),t=[Bs.x,Bs.y,Bs.z],fa(t,Si,Mi,bi,Os)}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,Qt).distanceTo(e)}getBoundingSphere(e){if(this.isEmpty())e.makeEmpty();else this.getCenter(e.center),e.radius=this.getSize(Qt).length()*0.5;return e}intersect(e){if(this.min.max(e.min),this.max.min(e.max),this.isEmpty())this.makeEmpty();return this}union(e){return this.min.min(e.min),this.max.max(e.max),this}applyMatrix4(e){if(this.isEmpty())return this;return pn[0].set(this.min.x,this.min.y,this.min.z).applyMatrix4(e),pn[1].set(this.min.x,this.min.y,this.max.z).applyMatrix4(e),pn[2].set(this.min.x,this.max.y,this.min.z).applyMatrix4(e),pn[3].set(this.min.x,this.max.y,this.max.z).applyMatrix4(e),pn[4].set(this.max.x,this.min.y,this.min.z).applyMatrix4(e),pn[5].set(this.max.x,this.min.y,this.max.z).applyMatrix4(e),pn[6].set(this.max.x,this.max.y,this.min.z).applyMatrix4(e),pn[7].set(this.max.x,this.max.y,this.max.z).applyMatrix4(e),this.setFromPoints(pn),this}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}}var pn=[new T,new T,new T,new T,new T,new T,new T,new T],Qt=new T,Fs=new Rt,Si=new T,Mi=new T,bi=new T,wn=new T,Rn=new T,qn=new T,ns=new T,Os=new T,Bs=new T,Yn=new T;function fa(e,t,n,i,s){for(let r=0,a=e.length-3;r<=a;r+=3){Yn.fromArray(e,r);let o=s.x*Math.abs(Yn.x)+s.y*Math.abs(Yn.y)+s.z*Math.abs(Yn.z),l=t.dot(Yn),c=n.dot(Yn),h=i.dot(Yn);if(Math.max(-Math.max(l,c,h),Math.min(l,c,h))>o)return!1}return!0}var Md=new Rt,is=new T,pa=new T;class At{constructor(e=new T,t=-1){this.isSphere=!0,this.center=e,this.radius=t}set(e,t){return this.center.copy(e),this.radius=t,this}setFromPoints(e,t){let n=this.center;if(t!==void 0)n.copy(t);else Md.setFromPoints(e).getCenter(n);let i=0;for(let s=0,r=e.length;s<r;s++)i=Math.max(i,n.distanceToSquared(e[s]));return this.radius=Math.sqrt(i),this}copy(e){return this.center.copy(e.center),this.radius=e.radius,this}isEmpty(){return this.radius<0}makeEmpty(){return this.center.set(0,0,0),this.radius=-1,this}containsPoint(e){return e.distanceToSquared(this.center)<=this.radius*this.radius}distanceToPoint(e){return e.distanceTo(this.center)-this.radius}intersectsSphere(e){let t=this.radius+e.radius;return e.center.distanceToSquared(this.center)<=t*t}intersectsBox(e){return e.intersectsSphere(this)}intersectsPlane(e){return Math.abs(e.distanceToPoint(this.center))<=this.radius}clampPoint(e,t){let n=this.center.distanceToSquared(e);if(t.copy(e),n>this.radius*this.radius)t.sub(this.center).normalize(),t.multiplyScalar(this.radius).add(this.center);return t}getBoundingBox(e){if(this.isEmpty())return e.makeEmpty(),e;return e.set(this.center,this.center),e.expandByScalar(this.radius),e}applyMatrix4(e){return this.center.applyMatrix4(e),this.radius=this.radius*e.getMaxScaleOnAxis(),this}translate(e){return this.center.add(e),this}expandByPoint(e){if(this.isEmpty())return this.center.copy(e),this.radius=0,this;is.subVectors(e,this.center);let t=is.lengthSq();if(t>this.radius*this.radius){let n=Math.sqrt(t),i=(n-this.radius)*0.5;this.center.addScaledVector(is,i/n),this.radius+=i}return this}union(e){if(e.isEmpty())return this;if(this.isEmpty())return this.copy(e),this;if(this.center.equals(e.center)===!0)this.radius=Math.max(this.radius,e.radius);else pa.subVectors(e.center,this.center).setLength(e.radius),this.expandByPoint(is.copy(e.center).add(pa)),this.expandByPoint(is.copy(e.center).sub(pa));return this}equals(e){return e.center.equals(this.center)&&e.radius===this.radius}clone(){return new this.constructor().copy(this)}}var mn=new T,ma=new T,zs=new T,Cn=new T,ga=new T,ks=new T,_a=new T;class On{constructor(e=new T,t=new T(0,0,-1)){this.origin=e,this.direction=t}set(e,t){return this.origin.copy(e),this.direction.copy(t),this}copy(e){return this.origin.copy(e.origin),this.direction.copy(e.direction),this}at(e,t){return t.copy(this.origin).addScaledVector(this.direction,e)}lookAt(e){return this.direction.copy(e).sub(this.origin).normalize(),this}recast(e){return this.origin.copy(this.at(e,mn)),this}closestPointToPoint(e,t){t.subVectors(e,this.origin);let n=t.dot(this.direction);if(n<0)return t.copy(this.origin);return t.copy(this.origin).addScaledVector(this.direction,n)}distanceToPoint(e){return Math.sqrt(this.distanceSqToPoint(e))}distanceSqToPoint(e){let t=mn.subVectors(e,this.origin).dot(this.direction);if(t<0)return this.origin.distanceToSquared(e);return mn.copy(this.origin).addScaledVector(this.direction,t),mn.distanceToSquared(e)}distanceSqToSegment(e,t,n,i){ma.copy(e).add(t).multiplyScalar(0.5),zs.copy(t).sub(e).normalize(),Cn.copy(this.origin).sub(ma);let s=e.distanceTo(t)*0.5,r=-this.direction.dot(zs),a=Cn.dot(this.direction),o=-Cn.dot(zs),l=Cn.lengthSq(),c=Math.abs(1-r*r),h,u,d,f;if(c>0)if(h=r*o-a,u=r*a-o,f=s*c,h>=0)if(u>=-f)if(u<=f){let g=1/c;h*=g,u*=g,d=h*(h+r*u+2*a)+u*(r*h+u+2*o)+l}else u=s,h=Math.max(0,-(r*u+a)),d=-h*h+u*(u+2*o)+l;else u=-s,h=Math.max(0,-(r*u+a)),d=-h*h+u*(u+2*o)+l;else if(u<=-f)h=Math.max(0,-(-r*s+a)),u=h>0?-s:Math.min(Math.max(-s,-o),s),d=-h*h+u*(u+2*o)+l;else if(u<=f)h=0,u=Math.min(Math.max(-s,-o),s),d=u*(u+2*o)+l;else h=Math.max(0,-(r*s+a)),u=h>0?s:Math.min(Math.max(-s,-o),s),d=-h*h+u*(u+2*o)+l;else u=r>0?-s:s,h=Math.max(0,-(r*u+a)),d=-h*h+u*(u+2*o)+l;if(n)n.copy(this.origin).addScaledVector(this.direction,h);if(i)i.copy(ma).addScaledVector(zs,u);return d}intersectSphere(e,t){mn.subVectors(e.center,this.origin);let n=mn.dot(this.direction),i=mn.dot(mn)-n*n,s=e.radius*e.radius;if(i>s)return null;let r=Math.sqrt(s-i),a=n-r,o=n+r;if(o<0)return null;if(a<0)return this.at(o,t);return this.at(a,t)}intersectsSphere(e){return this.distanceSqToPoint(e.center)<=e.radius*e.radius}distanceToPlane(e){let t=e.normal.dot(this.direction);if(t===0){if(e.distanceToPoint(this.origin)===0)return 0;return null}let n=-(this.origin.dot(e.normal)+e.constant)/t;return n>=0?n:null}intersectPlane(e,t){let n=this.distanceToPlane(e);if(n===null)return null;return this.at(n,t)}intersectsPlane(e){let t=e.distanceToPoint(this.origin);if(t===0)return!0;if(e.normal.dot(this.direction)*t<0)return!0;return!1}intersectBox(e,t){let n,i,s,r,a,o,l=1/this.direction.x,c=1/this.direction.y,h=1/this.direction.z,u=this.origin;if(l>=0)n=(e.min.x-u.x)*l,i=(e.max.x-u.x)*l;else n=(e.max.x-u.x)*l,i=(e.min.x-u.x)*l;if(c>=0)s=(e.min.y-u.y)*c,r=(e.max.y-u.y)*c;else s=(e.max.y-u.y)*c,r=(e.min.y-u.y)*c;if(n>r||s>i)return null;if(s>n||isNaN(n))n=s;if(r<i||isNaN(i))i=r;if(h>=0)a=(e.min.z-u.z)*h,o=(e.max.z-u.z)*h;else a=(e.max.z-u.z)*h,o=(e.min.z-u.z)*h;if(n>o||a>i)return null;if(a>n||n!==n)n=a;if(o<i||i!==i)i=o;if(i<0)return null;return this.at(n>=0?n:i,t)}intersectsBox(e){return this.intersectBox(e,mn)!==null}intersectTriangle(e,t,n,i,s){ga.subVectors(t,e),ks.subVectors(n,e),_a.crossVectors(ga,ks);let r=this.direction.dot(_a),a;if(r>0){if(i)return null;a=1}else if(r<0)a=-1,r=-r;else return null;Cn.subVectors(this.origin,e);let o=a*this.direction.dot(ks.crossVectors(Cn,ks));if(o<0)return null;let l=a*this.direction.dot(ga.cross(Cn));if(l<0)return null;if(o+l>r)return null;let c=-a*Cn.dot(_a);if(c<0)return null;return this.at(c/r,s)}applyMatrix4(e){return this.origin.applyMatrix4(e),this.direction.transformDirection(e),this}equals(e){return e.origin.equals(this.origin)&&e.direction.equals(this.direction)}clone(){return new this.constructor().copy(this)}}class De{constructor(e,t,n,i,s,r,a,o,l,c,h,u,d,f,g,_){if(De.prototype.isMatrix4=!0,this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],e!==void 0)this.set(e,t,n,i,s,r,a,o,l,c,h,u,d,f,g,_)}set(e,t,n,i,s,r,a,o,l,c,h,u,d,f,g,_){let m=this.elements;return m[0]=e,m[4]=t,m[8]=n,m[12]=i,m[1]=s,m[5]=r,m[9]=a,m[13]=o,m[2]=l,m[6]=c,m[10]=h,m[14]=u,m[3]=d,m[7]=f,m[11]=g,m[15]=_,this}identity(){return this.set(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1),this}clone(){return new De().fromArray(this.elements)}copy(e){let t=this.elements,n=e.elements;return t[0]=n[0],t[1]=n[1],t[2]=n[2],t[3]=n[3],t[4]=n[4],t[5]=n[5],t[6]=n[6],t[7]=n[7],t[8]=n[8],t[9]=n[9],t[10]=n[10],t[11]=n[11],t[12]=n[12],t[13]=n[13],t[14]=n[14],t[15]=n[15],this}copyPosition(e){let t=this.elements,n=e.elements;return t[12]=n[12],t[13]=n[13],t[14]=n[14],this}setFromMatrix3(e){let t=e.elements;return this.set(t[0],t[3],t[6],0,t[1],t[4],t[7],0,t[2],t[5],t[8],0,0,0,0,1),this}extractBasis(e,t,n){return e.setFromMatrixColumn(this,0),t.setFromMatrixColumn(this,1),n.setFromMatrixColumn(this,2),this}makeBasis(e,t,n){return this.set(e.x,t.x,n.x,0,e.y,t.y,n.y,0,e.z,t.z,n.z,0,0,0,0,1),this}extractRotation(e){let t=this.elements,n=e.elements,i=1/Ti.setFromMatrixColumn(e,0).length(),s=1/Ti.setFromMatrixColumn(e,1).length(),r=1/Ti.setFromMatrixColumn(e,2).length();return t[0]=n[0]*i,t[1]=n[1]*i,t[2]=n[2]*i,t[3]=0,t[4]=n[4]*s,t[5]=n[5]*s,t[6]=n[6]*s,t[7]=0,t[8]=n[8]*r,t[9]=n[9]*r,t[10]=n[10]*r,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromEuler(e){let t=this.elements,{x:n,y:i,z:s}=e,r=Math.cos(n),a=Math.sin(n),o=Math.cos(i),l=Math.sin(i),c=Math.cos(s),h=Math.sin(s);if(e.order==="XYZ"){let u=r*c,d=r*h,f=a*c,g=a*h;t[0]=o*c,t[4]=-o*h,t[8]=l,t[1]=d+f*l,t[5]=u-g*l,t[9]=-a*o,t[2]=g-u*l,t[6]=f+d*l,t[10]=r*o}else if(e.order==="YXZ"){let u=o*c,d=o*h,f=l*c,g=l*h;t[0]=u+g*a,t[4]=f*a-d,t[8]=r*l,t[1]=r*h,t[5]=r*c,t[9]=-a,t[2]=d*a-f,t[6]=g+u*a,t[10]=r*o}else if(e.order==="ZXY"){let u=o*c,d=o*h,f=l*c,g=l*h;t[0]=u-g*a,t[4]=-r*h,t[8]=f+d*a,t[1]=d+f*a,t[5]=r*c,t[9]=g-u*a,t[2]=-r*l,t[6]=a,t[10]=r*o}else if(e.order==="ZYX"){let u=r*c,d=r*h,f=a*c,g=a*h;t[0]=o*c,t[4]=f*l-d,t[8]=u*l+g,t[1]=o*h,t[5]=g*l+u,t[9]=d*l-f,t[2]=-l,t[6]=a*o,t[10]=r*o}else if(e.order==="YZX"){let u=r*o,d=r*l,f=a*o,g=a*l;t[0]=o*c,t[4]=g-u*h,t[8]=f*h+d,t[1]=h,t[5]=r*c,t[9]=-a*c,t[2]=-l*c,t[6]=d*h+f,t[10]=u-g*h}else if(e.order==="XZY"){let u=r*o,d=r*l,f=a*o,g=a*l;t[0]=o*c,t[4]=-h,t[8]=l*c,t[1]=u*h+g,t[5]=r*c,t[9]=d*h-f,t[2]=f*h-d,t[6]=a*c,t[10]=g*h+u}return t[3]=0,t[7]=0,t[11]=0,t[12]=0,t[13]=0,t[14]=0,t[15]=1,this}makeRotationFromQuaternion(e){return this.compose(bd,e,Td)}lookAt(e,t,n){let i=this.elements;if(Ht.subVectors(e,t),Ht.lengthSq()===0)Ht.z=1;if(Ht.normalize(),Pn.crossVectors(n,Ht),Pn.lengthSq()===0){if(Math.abs(n.z)===1)Ht.x+=0.0001;else Ht.z+=0.0001;Ht.normalize(),Pn.crossVectors(n,Ht)}return Pn.normalize(),Gs.crossVectors(Ht,Pn),i[0]=Pn.x,i[4]=Gs.x,i[8]=Ht.x,i[1]=Pn.y,i[5]=Gs.y,i[9]=Ht.y,i[2]=Pn.z,i[6]=Gs.z,i[10]=Ht.z,this}multiply(e){return this.multiplyMatrices(this,e)}premultiply(e){return this.multiplyMatrices(e,this)}multiplyMatrices(e,t){let n=e.elements,i=t.elements,s=this.elements,r=n[0],a=n[4],o=n[8],l=n[12],c=n[1],h=n[5],u=n[9],d=n[13],f=n[2],g=n[6],_=n[10],m=n[14],p=n[3],x=n[7],v=n[11],b=n[15],R=i[0],M=i[4],C=i[8],D=i[12],S=i[1],w=i[5],U=i[9],J=i[13],ae=i[2],I=i[6],z=i[10],X=i[14],ne=i[3],V=i[7],q=i[11],ee=i[15];return s[0]=r*R+a*S+o*ae+l*ne,s[4]=r*M+a*w+o*I+l*V,s[8]=r*C+a*U+o*z+l*q,s[12]=r*D+a*J+o*X+l*ee,s[1]=c*R+h*S+u*ae+d*ne,s[5]=c*M+h*w+u*I+d*V,s[9]=c*C+h*U+u*z+d*q,s[13]=c*D+h*J+u*X+d*ee,s[2]=f*R+g*S+_*ae+m*ne,s[6]=f*M+g*w+_*I+m*V,s[10]=f*C+g*U+_*z+m*q,s[14]=f*D+g*J+_*X+m*ee,s[3]=p*R+x*S+v*ae+b*ne,s[7]=p*M+x*w+v*I+b*V,s[11]=p*C+x*U+v*z+b*q,s[15]=p*D+x*J+v*X+b*ee,this}multiplyScalar(e){let t=this.elements;return t[0]*=e,t[4]*=e,t[8]*=e,t[12]*=e,t[1]*=e,t[5]*=e,t[9]*=e,t[13]*=e,t[2]*=e,t[6]*=e,t[10]*=e,t[14]*=e,t[3]*=e,t[7]*=e,t[11]*=e,t[15]*=e,this}determinant(){let e=this.elements,t=e[0],n=e[4],i=e[8],s=e[12],r=e[1],a=e[5],o=e[9],l=e[13],c=e[2],h=e[6],u=e[10],d=e[14],f=e[3],g=e[7],_=e[11],m=e[15];return f*(+s*o*h-i*l*h-s*a*u+n*l*u+i*a*d-n*o*d)+g*(+t*o*d-t*l*u+s*r*u-i*r*d+i*l*c-s*o*c)+_*(+t*l*h-t*a*d-s*r*h+n*r*d+s*a*c-n*l*c)+m*(-i*a*c-t*o*h+t*a*u+i*r*h-n*r*u+n*o*c)}transpose(){let e=this.elements,t;return t=e[1],e[1]=e[4],e[4]=t,t=e[2],e[2]=e[8],e[8]=t,t=e[6],e[6]=e[9],e[9]=t,t=e[3],e[3]=e[12],e[12]=t,t=e[7],e[7]=e[13],e[13]=t,t=e[11],e[11]=e[14],e[14]=t,this}setPosition(e,t,n){let i=this.elements;if(e.isVector3)i[12]=e.x,i[13]=e.y,i[14]=e.z;else i[12]=e,i[13]=t,i[14]=n;return this}invert(){let e=this.elements,t=e[0],n=e[1],i=e[2],s=e[3],r=e[4],a=e[5],o=e[6],l=e[7],c=e[8],h=e[9],u=e[10],d=e[11],f=e[12],g=e[13],_=e[14],m=e[15],p=h*_*l-g*u*l+g*o*d-a*_*d-h*o*m+a*u*m,x=f*u*l-c*_*l-f*o*d+r*_*d+c*o*m-r*u*m,v=c*g*l-f*h*l+f*a*d-r*g*d-c*a*m+r*h*m,b=f*h*o-c*g*o-f*a*u+r*g*u+c*a*_-r*h*_,R=t*p+n*x+i*v+s*b;if(R===0)return this.set(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);let M=1/R;return e[0]=p*M,e[1]=(g*u*s-h*_*s-g*i*d+n*_*d+h*i*m-n*u*m)*M,e[2]=(a*_*s-g*o*s+g*i*l-n*_*l-a*i*m+n*o*m)*M,e[3]=(h*o*s-a*u*s-h*i*l+n*u*l+a*i*d-n*o*d)*M,e[4]=x*M,e[5]=(c*_*s-f*u*s+f*i*d-t*_*d-c*i*m+t*u*m)*M,e[6]=(f*o*s-r*_*s-f*i*l+t*_*l+r*i*m-t*o*m)*M,e[7]=(r*u*s-c*o*s+c*i*l-t*u*l-r*i*d+t*o*d)*M,e[8]=v*M,e[9]=(f*h*s-c*g*s-f*n*d+t*g*d+c*n*m-t*h*m)*M,e[10]=(r*g*s-f*a*s+f*n*l-t*g*l-r*n*m+t*a*m)*M,e[11]=(c*a*s-r*h*s-c*n*l+t*h*l+r*n*d-t*a*d)*M,e[12]=b*M,e[13]=(c*g*i-f*h*i+f*n*u-t*g*u-c*n*_+t*h*_)*M,e[14]=(f*a*i-r*g*i-f*n*o+t*g*o+r*n*_-t*a*_)*M,e[15]=(r*h*i-c*a*i+c*n*o-t*h*o-r*n*u+t*a*u)*M,this}scale(e){let t=this.elements,{x:n,y:i,z:s}=e;return t[0]*=n,t[4]*=i,t[8]*=s,t[1]*=n,t[5]*=i,t[9]*=s,t[2]*=n,t[6]*=i,t[10]*=s,t[3]*=n,t[7]*=i,t[11]*=s,this}getMaxScaleOnAxis(){let e=this.elements,t=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],n=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],i=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];return Math.sqrt(Math.max(t,n,i))}makeTranslation(e,t,n){if(e.isVector3)this.set(1,0,0,e.x,0,1,0,e.y,0,0,1,e.z,0,0,0,1);else this.set(1,0,0,e,0,1,0,t,0,0,1,n,0,0,0,1);return this}makeRotationX(e){let t=Math.cos(e),n=Math.sin(e);return this.set(1,0,0,0,0,t,-n,0,0,n,t,0,0,0,0,1),this}makeRotationY(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,0,n,0,0,1,0,0,-n,0,t,0,0,0,0,1),this}makeRotationZ(e){let t=Math.cos(e),n=Math.sin(e);return this.set(t,-n,0,0,n,t,0,0,0,0,1,0,0,0,0,1),this}makeRotationAxis(e,t){let n=Math.cos(t),i=Math.sin(t),s=1-n,{x:r,y:a,z:o}=e,l=s*r,c=s*a;return this.set(l*r+n,l*a-i*o,l*o+i*a,0,l*a+i*o,c*a+n,c*o-i*r,0,l*o-i*a,c*o+i*r,s*o*o+n,0,0,0,0,1),this}makeScale(e,t,n){return this.set(e,0,0,0,0,t,0,0,0,0,n,0,0,0,0,1),this}makeShear(e,t,n,i,s,r){return this.set(1,n,s,0,e,1,r,0,t,i,1,0,0,0,0,1),this}compose(e,t,n){let i=this.elements,{_x:s,_y:r,_z:a,_w:o}=t,l=s+s,c=r+r,h=a+a,u=s*l,d=s*c,f=s*h,g=r*c,_=r*h,m=a*h,p=o*l,x=o*c,v=o*h,{x:b,y:R,z:M}=n;return i[0]=(1-(g+m))*b,i[1]=(d+v)*b,i[2]=(f-x)*b,i[3]=0,i[4]=(d-v)*R,i[5]=(1-(u+m))*R,i[6]=(_+p)*R,i[7]=0,i[8]=(f+x)*M,i[9]=(_-p)*M,i[10]=(1-(u+g))*M,i[11]=0,i[12]=e.x,i[13]=e.y,i[14]=e.z,i[15]=1,this}decompose(e,t,n){let i=this.elements,s=Ti.set(i[0],i[1],i[2]).length(),r=Ti.set(i[4],i[5],i[6]).length(),a=Ti.set(i[8],i[9],i[10]).length();if(this.determinant()<0)s=-s;e.x=i[12],e.y=i[13],e.z=i[14],en.copy(this);let l=1/s,c=1/r,h=1/a;return en.elements[0]*=l,en.elements[1]*=l,en.elements[2]*=l,en.elements[4]*=c,en.elements[5]*=c,en.elements[6]*=c,en.elements[8]*=h,en.elements[9]*=h,en.elements[10]*=h,t.setFromRotationMatrix(en),n.x=s,n.y=r,n.z=a,this}makePerspective(e,t,n,i,s,r,a=2000){let o=this.elements,l=2*s/(t-e),c=2*s/(n-i),h=(t+e)/(t-e),u=(n+i)/(n-i),d,f;if(a===2000)d=-(r+s)/(r-s),f=-2*r*s/(r-s);else if(a===2001)d=-r/(r-s),f=-r*s/(r-s);else throw Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: "+a);return o[0]=l,o[4]=0,o[8]=h,o[12]=0,o[1]=0,o[5]=c,o[9]=u,o[13]=0,o[2]=0,o[6]=0,o[10]=d,o[14]=f,o[3]=0,o[7]=0,o[11]=-1,o[15]=0,this}makeOrthographic(e,t,n,i,s,r,a=2000){let o=this.elements,l=1/(t-e),c=1/(n-i),h=1/(r-s),u=(t+e)*l,d=(n+i)*c,f,g;if(a===2000)f=(r+s)*h,g=-2*h;else if(a===2001)f=s*h,g=-1*h;else throw Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: "+a);return o[0]=2*l,o[4]=0,o[8]=0,o[12]=-u,o[1]=0,o[5]=2*c,o[9]=0,o[13]=-d,o[2]=0,o[6]=0,o[10]=g,o[14]=-f,o[3]=0,o[7]=0,o[11]=0,o[15]=1,this}equals(e){let t=this.elements,n=e.elements;for(let i=0;i<16;i++)if(t[i]!==n[i])return!1;return!0}fromArray(e,t=0){for(let n=0;n<16;n++)this.elements[n]=e[n+t];return this}toArray(e=[],t=0){let n=this.elements;return e[t]=n[0],e[t+1]=n[1],e[t+2]=n[2],e[t+3]=n[3],e[t+4]=n[4],e[t+5]=n[5],e[t+6]=n[6],e[t+7]=n[7],e[t+8]=n[8],e[t+9]=n[9],e[t+10]=n[10],e[t+11]=n[11],e[t+12]=n[12],e[t+13]=n[13],e[t+14]=n[14],e[t+15]=n[15],e}}var Ti=new T,en=new De,bd=new T(0,0,0),Td=new T(1,1,1),Pn=new T,Gs=new T,Ht=new T,cl=new De,hl=new _t;class Dr{constructor(e=0,t=0,n=0,i=Dr.DEFAULT_ORDER){this.isEuler=!0,this._x=e,this._y=t,this._z=n,this._order=i}get x(){return this._x}set x(e){this._x=e,this._onChangeCallback()}get y(){return this._y}set y(e){this._y=e,this._onChangeCallback()}get z(){return this._z}set z(e){this._z=e,this._onChangeCallback()}get order(){return this._order}set order(e){this._order=e,this._onChangeCallback()}set(e,t,n,i=this._order){return this._x=e,this._y=t,this._z=n,this._order=i,this._onChangeCallback(),this}clone(){return new this.constructor(this._x,this._y,this._z,this._order)}copy(e){return this._x=e._x,this._y=e._y,this._z=e._z,this._order=e._order,this._onChangeCallback(),this}setFromRotationMatrix(e,t=this._order,n=!0){let i=e.elements,s=i[0],r=i[4],a=i[8],o=i[1],l=i[5],c=i[9],h=i[2],u=i[6],d=i[10];switch(t){case"XYZ":if(this._y=Math.asin(ft(a,-1,1)),Math.abs(a)<0.9999999)this._x=Math.atan2(-c,d),this._z=Math.atan2(-r,s);else this._x=Math.atan2(u,l),this._z=0;break;case"YXZ":if(this._x=Math.asin(-ft(c,-1,1)),Math.abs(c)<0.9999999)this._y=Math.atan2(a,d),this._z=Math.atan2(o,l);else this._y=Math.atan2(-h,s),this._z=0;break;case"ZXY":if(this._x=Math.asin(ft(u,-1,1)),Math.abs(u)<0.9999999)this._y=Math.atan2(-h,d),this._z=Math.atan2(-r,l);else this._y=0,this._z=Math.atan2(o,s);break;case"ZYX":if(this._y=Math.asin(-ft(h,-1,1)),Math.abs(h)<0.9999999)this._x=Math.atan2(u,d),this._z=Math.atan2(o,s);else this._x=0,this._z=Math.atan2(-r,l);break;case"YZX":if(this._z=Math.asin(ft(o,-1,1)),Math.abs(o)<0.9999999)this._x=Math.atan2(-c,l),this._y=Math.atan2(-h,s);else this._x=0,this._y=Math.atan2(a,d);break;case"XZY":if(this._z=Math.asin(-ft(r,-1,1)),Math.abs(r)<0.9999999)this._x=Math.atan2(u,l),this._y=Math.atan2(a,s);else this._x=Math.atan2(-c,d),this._y=0;break;default:console.warn("THREE.Euler: .setFromRotationMatrix() encountered an unknown order: "+t)}if(this._order=t,n===!0)this._onChangeCallback();return this}setFromQuaternion(e,t,n){return cl.makeRotationFromQuaternion(e),this.setFromRotationMatrix(cl,t,n)}setFromVector3(e,t=this._order){return this.set(e.x,e.y,e.z,t)}reorder(e){return hl.setFromEuler(this),this.setFromQuaternion(hl,e)}equals(e){return e._x===this._x&&e._y===this._y&&e._z===this._z&&e._order===this._order}fromArray(e){if(this._x=e[0],this._y=e[1],this._z=e[2],e[3]!==void 0)this._order=e[3];return this._onChangeCallback(),this}toArray(e=[],t=0){return e[t]=this._x,e[t+1]=this._y,e[t+2]=this._z,e[t+3]=this._order,e}_onChange(e){return this._onChangeCallback=e,this}_onChangeCallback(){}*[Symbol.iterator](){yield this._x,yield this._y,yield this._z,yield this._order}}Dr.DEFAULT_ORDER="XYZ";class Ur{constructor(){this.mask=1}set(e){this.mask=(1<<e|0)>>>0}enable(e){this.mask|=1<<e|0}enableAll(){this.mask=-1}toggle(e){this.mask^=1<<e|0}disable(e){this.mask&=~(1<<e|0)}disableAll(){this.mask=0}test(e){return(this.mask&e.mask)!==0}isEnabled(e){return(this.mask&(1<<e|0))!==0}}var Ad=0,ul=new T,Ai=new _t,gn=new De,Hs=new T,ss=new T,Ed=new T,wd=new _t,dl=new T(1,0,0),fl=new T(0,1,0),pl=new T(0,0,1),Rd={type:"added"},Cd={type:"removed"};class et extends nn{constructor(){super();this.isObject3D=!0,Object.defineProperty(this,"id",{value:Ad++}),this.uuid=Xt(),this.name="",this.type="Object3D",this.parent=null,this.children=[],this.up=et.DEFAULT_UP.clone();let e=new T,t=new Dr,n=new _t,i=new T(1,1,1);function s(){n.setFromEuler(t,!1)}function r(){t.setFromQuaternion(n,void 0,!1)}t._onChange(s),n._onChange(r),Object.defineProperties(this,{position:{configurable:!0,enumerable:!0,value:e},rotation:{configurable:!0,enumerable:!0,value:t},quaternion:{configurable:!0,enumerable:!0,value:n},scale:{configurable:!0,enumerable:!0,value:i},modelViewMatrix:{value:new De},normalMatrix:{value:new Ze}}),this.matrix=new De,this.matrixWorld=new De,this.matrixAutoUpdate=et.DEFAULT_MATRIX_AUTO_UPDATE,this.matrixWorldAutoUpdate=et.DEFAULT_MATRIX_WORLD_AUTO_UPDATE,this.matrixWorldNeedsUpdate=!1,this.layers=new Ur,this.visible=!0,this.castShadow=!1,this.receiveShadow=!1,this.frustumCulled=!0,this.renderOrder=0,this.animations=[],this.userData={}}onBeforeShadow(){}onAfterShadow(){}onBeforeRender(){}onAfterRender(){}applyMatrix4(e){if(this.matrixAutoUpdate)this.updateMatrix();this.matrix.premultiply(e),this.matrix.decompose(this.position,this.quaternion,this.scale)}applyQuaternion(e){return this.quaternion.premultiply(e),this}setRotationFromAxisAngle(e,t){this.quaternion.setFromAxisAngle(e,t)}setRotationFromEuler(e){this.quaternion.setFromEuler(e,!0)}setRotationFromMatrix(e){this.quaternion.setFromRotationMatrix(e)}setRotationFromQuaternion(e){this.quaternion.copy(e)}rotateOnAxis(e,t){return Ai.setFromAxisAngle(e,t),this.quaternion.multiply(Ai),this}rotateOnWorldAxis(e,t){return Ai.setFromAxisAngle(e,t),this.quaternion.premultiply(Ai),this}rotateX(e){return this.rotateOnAxis(dl,e)}rotateY(e){return this.rotateOnAxis(fl,e)}rotateZ(e){return this.rotateOnAxis(pl,e)}translateOnAxis(e,t){return ul.copy(e).applyQuaternion(this.quaternion),this.position.add(ul.multiplyScalar(t)),this}translateX(e){return this.translateOnAxis(dl,e)}translateY(e){return this.translateOnAxis(fl,e)}translateZ(e){return this.translateOnAxis(pl,e)}localToWorld(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(this.matrixWorld)}worldToLocal(e){return this.updateWorldMatrix(!0,!1),e.applyMatrix4(gn.copy(this.matrixWorld).invert())}lookAt(e,t,n){if(e.isVector3)Hs.copy(e);else Hs.set(e,t,n);let i=this.parent;if(this.updateWorldMatrix(!0,!1),ss.setFromMatrixPosition(this.matrixWorld),this.isCamera||this.isLight)gn.lookAt(ss,Hs,this.up);else gn.lookAt(Hs,ss,this.up);if(this.quaternion.setFromRotationMatrix(gn),i)gn.extractRotation(i.matrixWorld),Ai.setFromRotationMatrix(gn),this.quaternion.premultiply(Ai.invert())}add(e){if(arguments.length>1){for(let t=0;t<arguments.length;t++)this.add(arguments[t]);return this}if(e===this)return console.error("THREE.Object3D.add: object can't be added as a child of itself.",e),this;if(e&&e.isObject3D){if(e.parent!==null)e.parent.remove(e);e.parent=this,this.children.push(e),e.dispatchEvent(Rd)}else console.error("THREE.Object3D.add: object not an instance of THREE.Object3D.",e);return this}remove(e){if(arguments.length>1){for(let n=0;n<arguments.length;n++)this.remove(arguments[n]);return this}let t=this.children.indexOf(e);if(t!==-1)e.parent=null,this.children.splice(t,1),e.dispatchEvent(Cd);return this}removeFromParent(){let e=this.parent;if(e!==null)e.remove(this);return this}clear(){return this.remove(...this.children)}attach(e){if(this.updateWorldMatrix(!0,!1),gn.copy(this.matrixWorld).invert(),e.parent!==null)e.parent.updateWorldMatrix(!0,!1),gn.multiply(e.parent.matrixWorld);return e.applyMatrix4(gn),this.add(e),e.updateWorldMatrix(!1,!0),this}getObjectById(e){return this.getObjectByProperty("id",e)}getObjectByName(e){return this.getObjectByProperty("name",e)}getObjectByProperty(e,t){if(this[e]===t)return this;for(let n=0,i=this.children.length;n<i;n++){let r=this.children[n].getObjectByProperty(e,t);if(r!==void 0)return r}return}getObjectsByProperty(e,t,n=[]){if(this[e]===t)n.push(this);let i=this.children;for(let s=0,r=i.length;s<r;s++)i[s].getObjectsByProperty(e,t,n);return n}getWorldPosition(e){return this.updateWorldMatrix(!0,!1),e.setFromMatrixPosition(this.matrixWorld)}getWorldQuaternion(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(ss,e,Ed),e}getWorldScale(e){return this.updateWorldMatrix(!0,!1),this.matrixWorld.decompose(ss,wd,e),e}getWorldDirection(e){this.updateWorldMatrix(!0,!1);let t=this.matrixWorld.elements;return e.set(t[8],t[9],t[10]).normalize()}raycast(){}traverse(e){e(this);let t=this.children;for(let n=0,i=t.length;n<i;n++)t[n].traverse(e)}traverseVisible(e){if(this.visible===!1)return;e(this);let t=this.children;for(let n=0,i=t.length;n<i;n++)t[n].traverseVisible(e)}traverseAncestors(e){let t=this.parent;if(t!==null)e(t),t.traverseAncestors(e)}updateMatrix(){this.matrix.compose(this.position,this.quaternion,this.scale),this.matrixWorldNeedsUpdate=!0}updateMatrixWorld(e){if(this.matrixAutoUpdate)this.updateMatrix();if(this.matrixWorldNeedsUpdate||e){if(this.parent===null)this.matrixWorld.copy(this.matrix);else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix);this.matrixWorldNeedsUpdate=!1,e=!0}let t=this.children;for(let n=0,i=t.length;n<i;n++){let s=t[n];if(s.matrixWorldAutoUpdate===!0||e===!0)s.updateMatrixWorld(e)}}updateWorldMatrix(e,t){let n=this.parent;if(e===!0&&n!==null&&n.matrixWorldAutoUpdate===!0)n.updateWorldMatrix(!0,!1);if(this.matrixAutoUpdate)this.updateMatrix();if(this.parent===null)this.matrixWorld.copy(this.matrix);else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix);if(t===!0){let i=this.children;for(let s=0,r=i.length;s<r;s++){let a=i[s];if(a.matrixWorldAutoUpdate===!0)a.updateWorldMatrix(!1,!0)}}}toJSON(e){let t=e===void 0||typeof e==="string",n={};if(t)e={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}},n.metadata={version:4.6,type:"Object",generator:"Object3D.toJSON"};let i={};if(i.uuid=this.uuid,i.type=this.type,this.name!=="")i.name=this.name;if(this.castShadow===!0)i.castShadow=!0;if(this.receiveShadow===!0)i.receiveShadow=!0;if(this.visible===!1)i.visible=!1;if(this.frustumCulled===!1)i.frustumCulled=!1;if(this.renderOrder!==0)i.renderOrder=this.renderOrder;if(Object.keys(this.userData).length>0)i.userData=this.userData;if(i.layers=this.layers.mask,i.matrix=this.matrix.toArray(),i.up=this.up.toArray(),this.matrixAutoUpdate===!1)i.matrixAutoUpdate=!1;if(this.isInstancedMesh){if(i.type="InstancedMesh",i.count=this.count,i.instanceMatrix=this.instanceMatrix.toJSON(),this.instanceColor!==null)i.instanceColor=this.instanceColor.toJSON()}if(this.isBatchedMesh){if(i.type="BatchedMesh",i.perObjectFrustumCulled=this.perObjectFrustumCulled,i.sortObjects=this.sortObjects,i.drawRanges=this._drawRanges,i.reservedRanges=this._reservedRanges,i.visibility=this._visibility,i.active=this._active,i.bounds=this._bounds.map((a)=>({boxInitialized:a.boxInitialized,boxMin:a.box.min.toArray(),boxMax:a.box.max.toArray(),sphereInitialized:a.sphereInitialized,sphereRadius:a.sphere.radius,sphereCenter:a.sphere.center.toArray()})),i.maxGeometryCount=this._maxGeometryCount,i.maxVertexCount=this._maxVertexCount,i.maxIndexCount=this._maxIndexCount,i.geometryInitialized=this._geometryInitialized,i.geometryCount=this._geometryCount,i.matricesTexture=this._matricesTexture.toJSON(e),this.boundingSphere!==null)i.boundingSphere={center:i.boundingSphere.center.toArray(),radius:i.boundingSphere.radius};if(this.boundingBox!==null)i.boundingBox={min:i.boundingBox.min.toArray(),max:i.boundingBox.max.toArray()}}function s(a,o){if(a[o.uuid]===void 0)a[o.uuid]=o.toJSON(e);return o.uuid}if(this.isScene){if(this.background){if(this.background.isColor)i.background=this.background.toJSON();else if(this.background.isTexture)i.background=this.background.toJSON(e).uuid}if(this.environment&&this.environment.isTexture&&this.environment.isRenderTargetTexture!==!0)i.environment=this.environment.toJSON(e).uuid}else if(this.isMesh||this.isLine||this.isPoints){i.geometry=s(e.geometries,this.geometry);let a=this.geometry.parameters;if(a!==void 0&&a.shapes!==void 0){let o=a.shapes;if(Array.isArray(o))for(let l=0,c=o.length;l<c;l++){let h=o[l];s(e.shapes,h)}else s(e.shapes,o)}}if(this.isSkinnedMesh){if(i.bindMode=this.bindMode,i.bindMatrix=this.bindMatrix.toArray(),this.skeleton!==void 0)s(e.skeletons,this.skeleton),i.skeleton=this.skeleton.uuid}if(this.material!==void 0)if(Array.isArray(this.material)){let a=[];for(let o=0,l=this.material.length;o<l;o++)a.push(s(e.materials,this.material[o]));i.material=a}else i.material=s(e.materials,this.material);if(this.children.length>0){i.children=[];for(let a=0;a<this.children.length;a++)i.children.push(this.children[a].toJSON(e).object)}if(this.animations.length>0){i.animations=[];for(let a=0;a<this.animations.length;a++){let o=this.animations[a];i.animations.push(s(e.animations,o))}}if(t){let a=r(e.geometries),o=r(e.materials),l=r(e.textures),c=r(e.images),h=r(e.shapes),u=r(e.skeletons),d=r(e.animations),f=r(e.nodes);if(a.length>0)n.geometries=a;if(o.length>0)n.materials=o;if(l.length>0)n.textures=l;if(c.length>0)n.images=c;if(h.length>0)n.shapes=h;if(u.length>0)n.skeletons=u;if(d.length>0)n.animations=d;if(f.length>0)n.nodes=f}return n.object=i,n;function r(a){let o=[];for(let l in a){let c=a[l];delete c.metadata,o.push(c)}return o}}clone(e){return new this.constructor().copy(this,e)}copy(e,t=!0){if(this.name=e.name,this.up.copy(e.up),this.position.copy(e.position),this.rotation.order=e.rotation.order,this.quaternion.copy(e.quaternion),this.scale.copy(e.scale),this.matrix.copy(e.matrix),this.matrixWorld.copy(e.matrixWorld),this.matrixAutoUpdate=e.matrixAutoUpdate,this.matrixWorldAutoUpdate=e.matrixWorldAutoUpdate,this.matrixWorldNeedsUpdate=e.matrixWorldNeedsUpdate,this.layers.mask=e.layers.mask,this.visible=e.visible,this.castShadow=e.castShadow,this.receiveShadow=e.receiveShadow,this.frustumCulled=e.frustumCulled,this.renderOrder=e.renderOrder,this.animations=e.animations.slice(),this.userData=JSON.parse(JSON.stringify(e.userData)),t===!0)for(let n=0;n<e.children.length;n++){let i=e.children[n];this.add(i.clone())}return this}}et.DEFAULT_UP=new T(0,1,0);et.DEFAULT_MATRIX_AUTO_UPDATE=!0;et.DEFAULT_MATRIX_WORLD_AUTO_UPDATE=!0;var tn=new T,_n=new T,xa=new T,xn=new T,Ei=new T,wi=new T,ml=new T,va=new T,ya=new T,Sa=new T,Ws=!1;class Vt{constructor(e=new T,t=new T,n=new T){this.a=e,this.b=t,this.c=n}static getNormal(e,t,n,i){i.subVectors(n,t),tn.subVectors(e,t),i.cross(tn);let s=i.lengthSq();if(s>0)return i.multiplyScalar(1/Math.sqrt(s));return i.set(0,0,0)}static getBarycoord(e,t,n,i,s){tn.subVectors(i,t),_n.subVectors(n,t),xa.subVectors(e,t);let r=tn.dot(tn),a=tn.dot(_n),o=tn.dot(xa),l=_n.dot(_n),c=_n.dot(xa),h=r*l-a*a;if(h===0)return s.set(0,0,0),null;let u=1/h,d=(l*o-a*c)*u,f=(r*c-a*o)*u;return s.set(1-d-f,f,d)}static containsPoint(e,t,n,i){if(this.getBarycoord(e,t,n,i,xn)===null)return!1;return xn.x>=0&&xn.y>=0&&xn.x+xn.y<=1}static getUV(e,t,n,i,s,r,a,o){if(Ws===!1)console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),Ws=!0;return this.getInterpolation(e,t,n,i,s,r,a,o)}static getInterpolation(e,t,n,i,s,r,a,o){if(this.getBarycoord(e,t,n,i,xn)===null){if(o.x=0,o.y=0,"z"in o)o.z=0;if("w"in o)o.w=0;return null}return o.setScalar(0),o.addScaledVector(s,xn.x),o.addScaledVector(r,xn.y),o.addScaledVector(a,xn.z),o}static isFrontFacing(e,t,n,i){return tn.subVectors(n,t),_n.subVectors(e,t),tn.cross(_n).dot(i)<0?!0:!1}set(e,t,n){return this.a.copy(e),this.b.copy(t),this.c.copy(n),this}setFromPointsAndIndices(e,t,n,i){return this.a.copy(e[t]),this.b.copy(e[n]),this.c.copy(e[i]),this}setFromAttributeAndIndices(e,t,n,i){return this.a.fromBufferAttribute(e,t),this.b.fromBufferAttribute(e,n),this.c.fromBufferAttribute(e,i),this}clone(){return new this.constructor().copy(this)}copy(e){return this.a.copy(e.a),this.b.copy(e.b),this.c.copy(e.c),this}getArea(){return tn.subVectors(this.c,this.b),_n.subVectors(this.a,this.b),tn.cross(_n).length()*0.5}getMidpoint(e){return e.addVectors(this.a,this.b).add(this.c).multiplyScalar(0.3333333333333333)}getNormal(e){return Vt.getNormal(this.a,this.b,this.c,e)}getPlane(e){return e.setFromCoplanarPoints(this.a,this.b,this.c)}getBarycoord(e,t){return Vt.getBarycoord(e,this.a,this.b,this.c,t)}getUV(e,t,n,i,s){if(Ws===!1)console.warn("THREE.Triangle.getUV() has been renamed to THREE.Triangle.getInterpolation()."),Ws=!0;return Vt.getInterpolation(e,this.a,this.b,this.c,t,n,i,s)}getInterpolation(e,t,n,i,s){return Vt.getInterpolation(e,this.a,this.b,this.c,t,n,i,s)}containsPoint(e){return Vt.containsPoint(e,this.a,this.b,this.c)}isFrontFacing(e){return Vt.isFrontFacing(this.a,this.b,this.c,e)}intersectsBox(e){return e.intersectsTriangle(this)}closestPointToPoint(e,t){let n=this.a,i=this.b,s=this.c,r,a;Ei.subVectors(i,n),wi.subVectors(s,n),va.subVectors(e,n);let o=Ei.dot(va),l=wi.dot(va);if(o<=0&&l<=0)return t.copy(n);ya.subVectors(e,i);let c=Ei.dot(ya),h=wi.dot(ya);if(c>=0&&h<=c)return t.copy(i);let u=o*h-c*l;if(u<=0&&o>=0&&c<=0)return r=o/(o-c),t.copy(n).addScaledVector(Ei,r);Sa.subVectors(e,s);let d=Ei.dot(Sa),f=wi.dot(Sa);if(f>=0&&d<=f)return t.copy(s);let g=d*l-o*f;if(g<=0&&l>=0&&f<=0)return a=l/(l-f),t.copy(n).addScaledVector(wi,a);let _=c*f-d*h;if(_<=0&&h-c>=0&&d-f>=0)return ml.subVectors(s,i),a=(h-c)/(h-c+(d-f)),t.copy(i).addScaledVector(ml,a);let m=1/(_+g+u);return r=g*m,a=u*m,t.copy(n).addScaledVector(Ei,r).addScaledVector(wi,a)}equals(e){return e.a.equals(this.a)&&e.b.equals(this.b)&&e.c.equals(this.c)}}var eh={aliceblue:15792383,antiquewhite:16444375,aqua:65535,aquamarine:8388564,azure:15794175,beige:16119260,bisque:16770244,black:0,blanchedalmond:16772045,blue:255,blueviolet:9055202,brown:10824234,burlywood:14596231,cadetblue:6266528,chartreuse:8388352,chocolate:13789470,coral:16744272,cornflowerblue:6591981,cornsilk:16775388,crimson:14423100,cyan:65535,darkblue:139,darkcyan:35723,darkgoldenrod:12092939,darkgray:11119017,darkgreen:25600,darkgrey:11119017,darkkhaki:12433259,darkmagenta:9109643,darkolivegreen:5597999,darkorange:16747520,darkorchid:10040012,darkred:9109504,darksalmon:15308410,darkseagreen:9419919,darkslateblue:4734347,darkslategray:3100495,darkslategrey:3100495,darkturquoise:52945,darkviolet:9699539,deeppink:16716947,deepskyblue:49151,dimgray:6908265,dimgrey:6908265,dodgerblue:2003199,firebrick:11674146,floralwhite:16775920,forestgreen:2263842,fuchsia:16711935,gainsboro:14474460,ghostwhite:16316671,gold:16766720,goldenrod:14329120,gray:8421504,green:32768,greenyellow:11403055,grey:8421504,honeydew:15794160,hotpink:16738740,indianred:13458524,indigo:4915330,ivory:16777200,khaki:15787660,lavender:15132410,lavenderblush:16773365,lawngreen:8190976,lemonchiffon:16775885,lightblue:11393254,lightcoral:15761536,lightcyan:14745599,lightgoldenrodyellow:16448210,lightgray:13882323,lightgreen:9498256,lightgrey:13882323,lightpink:16758465,lightsalmon:16752762,lightseagreen:2142890,lightskyblue:8900346,lightslategray:7833753,lightslategrey:7833753,lightsteelblue:11584734,lightyellow:16777184,lime:65280,limegreen:3329330,linen:16445670,magenta:16711935,maroon:8388608,mediumaquamarine:6737322,mediumblue:205,mediumorchid:12211667,mediumpurple:9662683,mediumseagreen:3978097,mediumslateblue:8087790,mediumspringgreen:64154,mediumturquoise:4772300,mediumvioletred:13047173,midnightblue:1644912,mintcream:16121850,mistyrose:16770273,moccasin:16770229,navajowhite:16768685,navy:128,oldlace:16643558,olive:8421376,olivedrab:7048739,orange:16753920,orangered:16729344,orchid:14315734,palegoldenrod:15657130,palegreen:10025880,paleturquoise:11529966,palevioletred:14381203,papayawhip:16773077,peachpuff:16767673,peru:13468991,pink:16761035,plum:14524637,powderblue:11591910,purple:8388736,rebeccapurple:6697881,red:16711680,rosybrown:12357519,royalblue:4286945,saddlebrown:9127187,salmon:16416882,sandybrown:16032864,seagreen:3050327,seashell:16774638,sienna:10506797,silver:12632256,skyblue:8900331,slateblue:6970061,slategray:7372944,slategrey:7372944,snow:16775930,springgreen:65407,steelblue:4620980,tan:13808780,teal:32896,thistle:14204888,tomato:16737095,turquoise:4251856,violet:15631086,wheat:16113331,white:16777215,whitesmoke:16119285,yellow:16776960,yellowgreen:10145074},Ln={h:0,s:0,l:0},Vs={h:0,s:0,l:0};function Ma(e,t,n){if(n<0)n+=1;if(n>1)n-=1;if(n<0.16666666666666666)return e+(t-e)*6*n;if(n<0.5)return t;if(n<0.6666666666666666)return e+(t-e)*6*(0.6666666666666666-n);return e}class ue{constructor(e,t,n){return this.isColor=!0,this.r=1,this.g=1,this.b=1,this.set(e,t,n)}set(e,t,n){if(t===void 0&&n===void 0){let i=e;if(i&&i.isColor)this.copy(i);else if(typeof i==="number")this.setHex(i);else if(typeof i==="string")this.setStyle(i)}else this.setRGB(e,t,n);return this}setScalar(e){return this.r=e,this.g=e,this.b=e,this}setHex(e,t="srgb"){return e=Math.floor(e),this.r=(e>>16&255)/255,this.g=(e>>8&255)/255,this.b=(e&255)/255,nt.toWorkingColorSpace(this,t),this}setRGB(e,t,n,i=nt.workingColorSpace){return this.r=e,this.g=t,this.b=n,nt.toWorkingColorSpace(this,i),this}setHSL(e,t,n,i=nt.workingColorSpace){if(e=no(e,1),t=ft(t,0,1),n=ft(n,0,1),t===0)this.r=this.g=this.b=n;else{let s=n<=0.5?n*(1+t):n+t-n*t,r=2*n-s;this.r=Ma(r,s,e+0.3333333333333333),this.g=Ma(r,s,e),this.b=Ma(r,s,e-0.3333333333333333)}return nt.toWorkingColorSpace(this,i),this}setStyle(e,t="srgb"){function n(s){if(s===void 0)return;if(parseFloat(s)<1)console.warn("THREE.Color: Alpha component of "+e+" will be ignored.")}let i;if(i=/^(\w+)\(([^\)]*)\)/.exec(e)){let s,r=i[1],a=i[2];switch(r){case"rgb":case"rgba":if(s=/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setRGB(Math.min(255,parseInt(s[1],10))/255,Math.min(255,parseInt(s[2],10))/255,Math.min(255,parseInt(s[3],10))/255,t);if(s=/^\s*(\d+)\%\s*,\s*(\d+)\%\s*,\s*(\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setRGB(Math.min(100,parseInt(s[1],10))/100,Math.min(100,parseInt(s[2],10))/100,Math.min(100,parseInt(s[3],10))/100,t);break;case"hsl":case"hsla":if(s=/^\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\%\s*,\s*(\d*\.?\d+)\%\s*(?:,\s*(\d*\.?\d+)\s*)?$/.exec(a))return n(s[4]),this.setHSL(parseFloat(s[1])/360,parseFloat(s[2])/100,parseFloat(s[3])/100,t);break;default:console.warn("THREE.Color: Unknown color model "+e)}}else if(i=/^\#([A-Fa-f\d]+)$/.exec(e)){let s=i[1],r=s.length;if(r===3)return this.setRGB(parseInt(s.charAt(0),16)/15,parseInt(s.charAt(1),16)/15,parseInt(s.charAt(2),16)/15,t);else if(r===6)return this.setHex(parseInt(s,16),t);else console.warn("THREE.Color: Invalid hex color "+e)}else if(e&&e.length>0)return this.setColorName(e,t);return this}setColorName(e,t="srgb"){let n=eh[e.toLowerCase()];if(n!==void 0)this.setHex(n,t);else console.warn("THREE.Color: Unknown color "+e);return this}clone(){return new this.constructor(this.r,this.g,this.b)}copy(e){return this.r=e.r,this.g=e.g,this.b=e.b,this}copySRGBToLinear(e){return this.r=Xi(e.r),this.g=Xi(e.g),this.b=Xi(e.b),this}copyLinearToSRGB(e){return this.r=ha(e.r),this.g=ha(e.g),this.b=ha(e.b),this}convertSRGBToLinear(){return this.copySRGBToLinear(this),this}convertLinearToSRGB(){return this.copyLinearToSRGB(this),this}getHex(e="srgb"){return nt.fromWorkingColorSpace(Nt.copy(this),e),Math.round(ft(Nt.r*255,0,255))*65536+Math.round(ft(Nt.g*255,0,255))*256+Math.round(ft(Nt.b*255,0,255))}getHexString(e="srgb"){return("000000"+this.getHex(e).toString(16)).slice(-6)}getHSL(e,t=nt.workingColorSpace){nt.fromWorkingColorSpace(Nt.copy(this),t);let{r:n,g:i,b:s}=Nt,r=Math.max(n,i,s),a=Math.min(n,i,s),o,l,c=(a+r)/2;if(a===r)o=0,l=0;else{let h=r-a;switch(l=c<=0.5?h/(r+a):h/(2-r-a),r){case n:o=(i-s)/h+(i<s?6:0);break;case i:o=(s-n)/h+2;break;case s:o=(n-i)/h+4;break}o/=6}return e.h=o,e.s=l,e.l=c,e}getRGB(e,t=nt.workingColorSpace){return nt.fromWorkingColorSpace(Nt.copy(this),t),e.r=Nt.r,e.g=Nt.g,e.b=Nt.b,e}getStyle(e="srgb"){nt.fromWorkingColorSpace(Nt.copy(this),e);let{r:t,g:n,b:i}=Nt;if(e!=="srgb")return`color(${e} ${t.toFixed(3)} ${n.toFixed(3)} ${i.toFixed(3)})`;return`rgb(${Math.round(t*255)},${Math.round(n*255)},${Math.round(i*255)})`}offsetHSL(e,t,n){return this.getHSL(Ln),this.setHSL(Ln.h+e,Ln.s+t,Ln.l+n)}add(e){return this.r+=e.r,this.g+=e.g,this.b+=e.b,this}addColors(e,t){return this.r=e.r+t.r,this.g=e.g+t.g,this.b=e.b+t.b,this}addScalar(e){return this.r+=e,this.g+=e,this.b+=e,this}sub(e){return this.r=Math.max(0,this.r-e.r),this.g=Math.max(0,this.g-e.g),this.b=Math.max(0,this.b-e.b),this}multiply(e){return this.r*=e.r,this.g*=e.g,this.b*=e.b,this}multiplyScalar(e){return this.r*=e,this.g*=e,this.b*=e,this}lerp(e,t){return this.r+=(e.r-this.r)*t,this.g+=(e.g-this.g)*t,this.b+=(e.b-this.b)*t,this}lerpColors(e,t,n){return this.r=e.r+(t.r-e.r)*n,this.g=e.g+(t.g-e.g)*n,this.b=e.b+(t.b-e.b)*n,this}lerpHSL(e,t){this.getHSL(Ln),e.getHSL(Vs);let n=ps(Ln.h,Vs.h,t),i=ps(Ln.s,Vs.s,t),s=ps(Ln.l,Vs.l,t);return this.setHSL(n,i,s),this}setFromVector3(e){return this.r=e.x,this.g=e.y,this.b=e.z,this}applyMatrix3(e){let t=this.r,n=this.g,i=this.b,s=e.elements;return this.r=s[0]*t+s[3]*n+s[6]*i,this.g=s[1]*t+s[4]*n+s[7]*i,this.b=s[2]*t+s[5]*n+s[8]*i,this}equals(e){return e.r===this.r&&e.g===this.g&&e.b===this.b}fromArray(e,t=0){return this.r=e[t],this.g=e[t+1],this.b=e[t+2],this}toArray(e=[],t=0){return e[t]=this.r,e[t+1]=this.g,e[t+2]=this.b,e}fromBufferAttribute(e,t){return this.r=e.getX(t),this.g=e.getY(t),this.b=e.getZ(t),this}toJSON(){return this.getHex()}*[Symbol.iterator](){yield this.r,yield this.g,yield this.b}}var Nt=new ue;ue.NAMES=eh;var Pd=0;class xt extends nn{constructor(){super();this.isMaterial=!0,Object.defineProperty(this,"id",{value:Pd++}),this.uuid=Xt(),this.name="",this.type="Material",this.blending=1,this.side=0,this.vertexColors=!1,this.opacity=1,this.transparent=!1,this.alphaHash=!1,this.blendSrc=204,this.blendDst=205,this.blendEquation=100,this.blendSrcAlpha=null,this.blendDstAlpha=null,this.blendEquationAlpha=null,this.blendColor=new ue(0,0,0),this.blendAlpha=0,this.depthFunc=3,this.depthTest=!0,this.depthWrite=!0,this.stencilWriteMask=255,this.stencilFunc=519,this.stencilRef=0,this.stencilFuncMask=255,this.stencilFail=7680,this.stencilZFail=7680,this.stencilZPass=7680,this.stencilWrite=!1,this.clippingPlanes=null,this.clipIntersection=!1,this.clipShadows=!1,this.shadowSide=null,this.colorWrite=!0,this.precision=null,this.polygonOffset=!1,this.polygonOffsetFactor=0,this.polygonOffsetUnits=0,this.dithering=!1,this.alphaToCoverage=!1,this.premultipliedAlpha=!1,this.forceSinglePass=!1,this.visible=!0,this.toneMapped=!0,this.userData={},this.version=0,this._alphaTest=0}get alphaTest(){return this._alphaTest}set alphaTest(e){if(this._alphaTest>0!==e>0)this.version++;this._alphaTest=e}onBuild(){}onBeforeRender(){}onBeforeCompile(){}customProgramCacheKey(){return this.onBeforeCompile.toString()}setValues(e){if(e===void 0)return;for(let t in e){let n=e[t];if(n===void 0){console.warn(`THREE.Material: parameter '${t}' has value of undefined.`);continue}let i=this[t];if(i===void 0){console.warn(`THREE.Material: '${t}' is not a property of THREE.${this.type}.`);continue}if(i&&i.isColor)i.set(n);else if(i&&i.isVector3&&(n&&n.isVector3))i.copy(n);else this[t]=n}}toJSON(e){let t=e===void 0||typeof e==="string";if(t)e={textures:{},images:{}};let n={metadata:{version:4.6,type:"Material",generator:"Material.toJSON"}};if(n.uuid=this.uuid,n.type=this.type,this.name!=="")n.name=this.name;if(this.color&&this.color.isColor)n.color=this.color.getHex();if(this.roughness!==void 0)n.roughness=this.roughness;if(this.metalness!==void 0)n.metalness=this.metalness;if(this.sheen!==void 0)n.sheen=this.sheen;if(this.sheenColor&&this.sheenColor.isColor)n.sheenColor=this.sheenColor.getHex();if(this.sheenRoughness!==void 0)n.sheenRoughness=this.sheenRoughness;if(this.emissive&&this.emissive.isColor)n.emissive=this.emissive.getHex();if(this.emissiveIntensity&&this.emissiveIntensity!==1)n.emissiveIntensity=this.emissiveIntensity;if(this.specular&&this.specular.isColor)n.specular=this.specular.getHex();if(this.specularIntensity!==void 0)n.specularIntensity=this.specularIntensity;if(this.specularColor&&this.specularColor.isColor)n.specularColor=this.specularColor.getHex();if(this.shininess!==void 0)n.shininess=this.shininess;if(this.clearcoat!==void 0)n.clearcoat=this.clearcoat;if(this.clearcoatRoughness!==void 0)n.clearcoatRoughness=this.clearcoatRoughness;if(this.clearcoatMap&&this.clearcoatMap.isTexture)n.clearcoatMap=this.clearcoatMap.toJSON(e).uuid;if(this.clearcoatRoughnessMap&&this.clearcoatRoughnessMap.isTexture)n.clearcoatRoughnessMap=this.clearcoatRoughnessMap.toJSON(e).uuid;if(this.clearcoatNormalMap&&this.clearcoatNormalMap.isTexture)n.clearcoatNormalMap=this.clearcoatNormalMap.toJSON(e).uuid,n.clearcoatNormalScale=this.clearcoatNormalScale.toArray();if(this.iridescence!==void 0)n.iridescence=this.iridescence;if(this.iridescenceIOR!==void 0)n.iridescenceIOR=this.iridescenceIOR;if(this.iridescenceThicknessRange!==void 0)n.iridescenceThicknessRange=this.iridescenceThicknessRange;if(this.iridescenceMap&&this.iridescenceMap.isTexture)n.iridescenceMap=this.iridescenceMap.toJSON(e).uuid;if(this.iridescenceThicknessMap&&this.iridescenceThicknessMap.isTexture)n.iridescenceThicknessMap=this.iridescenceThicknessMap.toJSON(e).uuid;if(this.anisotropy!==void 0)n.anisotropy=this.anisotropy;if(this.anisotropyRotation!==void 0)n.anisotropyRotation=this.anisotropyRotation;if(this.anisotropyMap&&this.anisotropyMap.isTexture)n.anisotropyMap=this.anisotropyMap.toJSON(e).uuid;if(this.map&&this.map.isTexture)n.map=this.map.toJSON(e).uuid;if(this.matcap&&this.matcap.isTexture)n.matcap=this.matcap.toJSON(e).uuid;if(this.alphaMap&&this.alphaMap.isTexture)n.alphaMap=this.alphaMap.toJSON(e).uuid;if(this.lightMap&&this.lightMap.isTexture)n.lightMap=this.lightMap.toJSON(e).uuid,n.lightMapIntensity=this.lightMapIntensity;if(this.aoMap&&this.aoMap.isTexture)n.aoMap=this.aoMap.toJSON(e).uuid,n.aoMapIntensity=this.aoMapIntensity;if(this.bumpMap&&this.bumpMap.isTexture)n.bumpMap=this.bumpMap.toJSON(e).uuid,n.bumpScale=this.bumpScale;if(this.normalMap&&this.normalMap.isTexture)n.normalMap=this.normalMap.toJSON(e).uuid,n.normalMapType=this.normalMapType,n.normalScale=this.normalScale.toArray();if(this.displacementMap&&this.displacementMap.isTexture)n.displacementMap=this.displacementMap.toJSON(e).uuid,n.displacementScale=this.displacementScale,n.displacementBias=this.displacementBias;if(this.roughnessMap&&this.roughnessMap.isTexture)n.roughnessMap=this.roughnessMap.toJSON(e).uuid;if(this.metalnessMap&&this.metalnessMap.isTexture)n.metalnessMap=this.metalnessMap.toJSON(e).uuid;if(this.emissiveMap&&this.emissiveMap.isTexture)n.emissiveMap=this.emissiveMap.toJSON(e).uuid;if(this.specularMap&&this.specularMap.isTexture)n.specularMap=this.specularMap.toJSON(e).uuid;if(this.specularIntensityMap&&this.specularIntensityMap.isTexture)n.specularIntensityMap=this.specularIntensityMap.toJSON(e).uuid;if(this.specularColorMap&&this.specularColorMap.isTexture)n.specularColorMap=this.specularColorMap.toJSON(e).uuid;if(this.envMap&&this.envMap.isTexture){if(n.envMap=this.envMap.toJSON(e).uuid,this.combine!==void 0)n.combine=this.combine}if(this.envMapIntensity!==void 0)n.envMapIntensity=this.envMapIntensity;if(this.reflectivity!==void 0)n.reflectivity=this.reflectivity;if(this.refractionRatio!==void 0)n.refractionRatio=this.refractionRatio;if(this.gradientMap&&this.gradientMap.isTexture)n.gradientMap=this.gradientMap.toJSON(e).uuid;if(this.transmission!==void 0)n.transmission=this.transmission;if(this.transmissionMap&&this.transmissionMap.isTexture)n.transmissionMap=this.transmissionMap.toJSON(e).uuid;if(this.thickness!==void 0)n.thickness=this.thickness;if(this.thicknessMap&&this.thicknessMap.isTexture)n.thicknessMap=this.thicknessMap.toJSON(e).uuid;if(this.attenuationDistance!==void 0&&this.attenuationDistance!==1/0)n.attenuationDistance=this.attenuationDistance;if(this.attenuationColor!==void 0)n.attenuationColor=this.attenuationColor.getHex();if(this.size!==void 0)n.size=this.size;if(this.shadowSide!==null)n.shadowSide=this.shadowSide;if(this.sizeAttenuation!==void 0)n.sizeAttenuation=this.sizeAttenuation;if(this.blending!==1)n.blending=this.blending;if(this.side!==0)n.side=this.side;if(this.vertexColors===!0)n.vertexColors=!0;if(this.opacity<1)n.opacity=this.opacity;if(this.transparent===!0)n.transparent=!0;if(this.blendSrc!==204)n.blendSrc=this.blendSrc;if(this.blendDst!==205)n.blendDst=this.blendDst;if(this.blendEquation!==100)n.blendEquation=this.blendEquation;if(this.blendSrcAlpha!==null)n.blendSrcAlpha=this.blendSrcAlpha;if(this.blendDstAlpha!==null)n.blendDstAlpha=this.blendDstAlpha;if(this.blendEquationAlpha!==null)n.blendEquationAlpha=this.blendEquationAlpha;if(this.blendColor&&this.blendColor.isColor)n.blendColor=this.blendColor.getHex();if(this.blendAlpha!==0)n.blendAlpha=this.blendAlpha;if(this.depthFunc!==3)n.depthFunc=this.depthFunc;if(this.depthTest===!1)n.depthTest=this.depthTest;if(this.depthWrite===!1)n.depthWrite=this.depthWrite;if(this.colorWrite===!1)n.colorWrite=this.colorWrite;if(this.stencilWriteMask!==255)n.stencilWriteMask=this.stencilWriteMask;if(this.stencilFunc!==519)n.stencilFunc=this.stencilFunc;if(this.stencilRef!==0)n.stencilRef=this.stencilRef;if(this.stencilFuncMask!==255)n.stencilFuncMask=this.stencilFuncMask;if(this.stencilFail!==7680)n.stencilFail=this.stencilFail;if(this.stencilZFail!==7680)n.stencilZFail=this.stencilZFail;if(this.stencilZPass!==7680)n.stencilZPass=this.stencilZPass;if(this.stencilWrite===!0)n.stencilWrite=this.stencilWrite;if(this.rotation!==void 0&&this.rotation!==0)n.rotation=this.rotation;if(this.polygonOffset===!0)n.polygonOffset=!0;if(this.polygonOffsetFactor!==0)n.polygonOffsetFactor=this.polygonOffsetFactor;if(this.polygonOffsetUnits!==0)n.polygonOffsetUnits=this.polygonOffsetUnits;if(this.linewidth!==void 0&&this.linewidth!==1)n.linewidth=this.linewidth;if(this.dashSize!==void 0)n.dashSize=this.dashSize;if(this.gapSize!==void 0)n.gapSize=this.gapSize;if(this.scale!==void 0)n.scale=this.scale;if(this.dithering===!0)n.dithering=!0;if(this.alphaTest>0)n.alphaTest=this.alphaTest;if(this.alphaHash===!0)n.alphaHash=!0;if(this.alphaToCoverage===!0)n.alphaToCoverage=!0;if(this.premultipliedAlpha===!0)n.premultipliedAlpha=!0;if(this.forceSinglePass===!0)n.forceSinglePass=!0;if(this.wireframe===!0)n.wireframe=!0;if(this.wireframeLinewidth>1)n.wireframeLinewidth=this.wireframeLinewidth;if(this.wireframeLinecap!=="round")n.wireframeLinecap=this.wireframeLinecap;if(this.wireframeLinejoin!=="round")n.wireframeLinejoin=this.wireframeLinejoin;if(this.flatShading===!0)n.flatShading=!0;if(this.visible===!1)n.visible=!1;if(this.toneMapped===!1)n.toneMapped=!1;if(this.fog===!1)n.fog=!1;if(Object.keys(this.userData).length>0)n.userData=this.userData;function i(s){let r=[];for(let a in s){let o=s[a];delete o.metadata,r.push(o)}return r}if(t){let s=i(e.textures),r=i(e.images);if(s.length>0)n.textures=s;if(r.length>0)n.images=r}return n}clone(){return new this.constructor().copy(this)}copy(e){this.name=e.name,this.blending=e.blending,this.side=e.side,this.vertexColors=e.vertexColors,this.opacity=e.opacity,this.transparent=e.transparent,this.blendSrc=e.blendSrc,this.blendDst=e.blendDst,this.blendEquation=e.blendEquation,this.blendSrcAlpha=e.blendSrcAlpha,this.blendDstAlpha=e.blendDstAlpha,this.blendEquationAlpha=e.blendEquationAlpha,this.blendColor.copy(e.blendColor),this.blendAlpha=e.blendAlpha,this.depthFunc=e.depthFunc,this.depthTest=e.depthTest,this.depthWrite=e.depthWrite,this.stencilWriteMask=e.stencilWriteMask,this.stencilFunc=e.stencilFunc,this.stencilRef=e.stencilRef,this.stencilFuncMask=e.stencilFuncMask,this.stencilFail=e.stencilFail,this.stencilZFail=e.stencilZFail,this.stencilZPass=e.stencilZPass,this.stencilWrite=e.stencilWrite;let t=e.clippingPlanes,n=null;if(t!==null){let i=t.length;n=Array(i);for(let s=0;s!==i;++s)n[s]=t[s].clone()}return this.clippingPlanes=n,this.clipIntersection=e.clipIntersection,this.clipShadows=e.clipShadows,this.shadowSide=e.shadowSide,this.colorWrite=e.colorWrite,this.precision=e.precision,this.polygonOffset=e.polygonOffset,this.polygonOffsetFactor=e.polygonOffsetFactor,this.polygonOffsetUnits=e.polygonOffsetUnits,this.dithering=e.dithering,this.alphaTest=e.alphaTest,this.alphaHash=e.alphaHash,this.alphaToCoverage=e.alphaToCoverage,this.premultipliedAlpha=e.premultipliedAlpha,this.forceSinglePass=e.forceSinglePass,this.visible=e.visible,this.toneMapped=e.toneMapped,this.userData=JSON.parse(JSON.stringify(e.userData)),this}dispose(){this.dispatchEvent({type:"dispose"})}set needsUpdate(e){if(e===!0)this.version++}}class wt extends xt{constructor(e){super();this.isMeshBasicMaterial=!0,this.type="MeshBasicMaterial",this.color=new ue(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=0,this.reflectivity=1,this.refractionRatio=0.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}}var yn=Ld();function Ld(){let e=new ArrayBuffer(4),t=new Float32Array(e),n=new Uint32Array(e),i=new Uint32Array(512),s=new Uint32Array(512);for(let l=0;l<256;++l){let c=l-127;if(c<-27)i[l]=0,i[l|256]=32768,s[l]=24,s[l|256]=24;else if(c<-14)i[l]=1024>>-c-14,i[l|256]=1024>>-c-14|32768,s[l]=-c-1,s[l|256]=-c-1;else if(c<=15)i[l]=c+15<<10,i[l|256]=c+15<<10|32768,s[l]=13,s[l|256]=13;else if(c<128)i[l]=31744,i[l|256]=64512,s[l]=24,s[l|256]=24;else i[l]=31744,i[l|256]=64512,s[l]=13,s[l|256]=13}let r=new Uint32Array(2048),a=new Uint32Array(64),o=new Uint32Array(64);for(let l=1;l<1024;++l){let c=l<<13,h=0;while((c&8388608)===0)c<<=1,h-=8388608;c&=-8388609,h+=947912704,r[l]=c|h}for(let l=1024;l<2048;++l)r[l]=939524096+(l-1024<<13);for(let l=1;l<31;++l)a[l]=l<<23;a[31]=1199570944,a[32]=2147483648;for(let l=33;l<63;++l)a[l]=2147483648+(l-32<<23);a[63]=3347054592;for(let l=1;l<64;++l)if(l!==32)o[l]=1024;return{floatView:t,uint32View:n,baseTable:i,shiftTable:s,mantissaTable:r,exponentTable:a,offsetTable:o}}function zt(e){if(Math.abs(e)>65504)console.warn("THREE.DataUtils.toHalfFloat(): Value out of range.");e=ft(e,-65504,65504),yn.floatView[0]=e;let t=yn.uint32View[0],n=t>>23&511;return yn.baseTable[n]+((t&8388607)>>yn.shiftTable[n])}function fs(e){let t=e>>10;return yn.uint32View[0]=yn.mantissaTable[yn.offsetTable[t]+(e&1023)]+yn.exponentTable[t],yn.floatView[0]}var bS={toHalfFloat:zt,fromHalfFloat:fs},gt=new T,Xs=new W;class tt{constructor(e,t,n=!1){if(Array.isArray(e))throw TypeError("THREE.BufferAttribute: array should be a Typed Array.");this.isBufferAttribute=!0,this.name="",this.array=e,this.itemSize=t,this.count=e!==void 0?e.length/t:0,this.normalized=n,this.usage=35044,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.gpuType=1015,this.version=0}onUploadCallback(){}set needsUpdate(e){if(e===!0)this.version++}get updateRange(){return console.warn("THREE.BufferAttribute: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.name=e.name,this.array=new e.array.constructor(e.array),this.itemSize=e.itemSize,this.count=e.count,this.normalized=e.normalized,this.usage=e.usage,this.gpuType=e.gpuType,this}copyAt(e,t,n){e*=this.itemSize,n*=t.itemSize;for(let i=0,s=this.itemSize;i<s;i++)this.array[e+i]=t.array[n+i];return this}copyArray(e){return this.array.set(e),this}applyMatrix3(e){if(this.itemSize===2)for(let t=0,n=this.count;t<n;t++)Xs.fromBufferAttribute(this,t),Xs.applyMatrix3(e),this.setXY(t,Xs.x,Xs.y);else if(this.itemSize===3)for(let t=0,n=this.count;t<n;t++)gt.fromBufferAttribute(this,t),gt.applyMatrix3(e),this.setXYZ(t,gt.x,gt.y,gt.z);return this}applyMatrix4(e){for(let t=0,n=this.count;t<n;t++)gt.fromBufferAttribute(this,t),gt.applyMatrix4(e),this.setXYZ(t,gt.x,gt.y,gt.z);return this}applyNormalMatrix(e){for(let t=0,n=this.count;t<n;t++)gt.fromBufferAttribute(this,t),gt.applyNormalMatrix(e),this.setXYZ(t,gt.x,gt.y,gt.z);return this}transformDirection(e){for(let t=0,n=this.count;t<n;t++)gt.fromBufferAttribute(this,t),gt.transformDirection(e),this.setXYZ(t,gt.x,gt.y,gt.z);return this}set(e,t=0){return this.array.set(e,t),this}getComponent(e,t){let n=this.array[e*this.itemSize+t];if(this.normalized)n=kt(n,this.array);return n}setComponent(e,t,n){if(this.normalized)n=Ve(n,this.array);return this.array[e*this.itemSize+t]=n,this}getX(e){let t=this.array[e*this.itemSize];if(this.normalized)t=kt(t,this.array);return t}setX(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize]=t,this}getY(e){let t=this.array[e*this.itemSize+1];if(this.normalized)t=kt(t,this.array);return t}setY(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+1]=t,this}getZ(e){let t=this.array[e*this.itemSize+2];if(this.normalized)t=kt(t,this.array);return t}setZ(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+2]=t,this}getW(e){let t=this.array[e*this.itemSize+3];if(this.normalized)t=kt(t,this.array);return t}setW(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+3]=t,this}setXY(e,t,n){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array);return this.array[e+0]=t,this.array[e+1]=n,this}setXYZ(e,t,n,i){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array);return this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=i,this}setXYZW(e,t,n,i,s){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array),s=Ve(s,this.array);return this.array[e+0]=t,this.array[e+1]=n,this.array[e+2]=i,this.array[e+3]=s,this}onUpload(e){return this.onUploadCallback=e,this}clone(){return new this.constructor(this.array,this.itemSize).copy(this)}toJSON(){let e={itemSize:this.itemSize,type:this.array.constructor.name,array:Array.from(this.array),normalized:this.normalized};if(this.name!=="")e.name=this.name;if(this.usage!==35044)e.usage=this.usage;return e}}class Id extends tt{constructor(e,t,n){super(new Int8Array(e),t,n)}}class Nd extends tt{constructor(e,t,n){super(new Uint8Array(e),t,n)}}class Dd extends tt{constructor(e,t,n){super(new Uint8ClampedArray(e),t,n)}}class Ud extends tt{constructor(e,t,n){super(new Int16Array(e),t,n)}}class ro extends tt{constructor(e,t,n){super(new Uint16Array(e),t,n)}}class Fd extends tt{constructor(e,t,n){super(new Int32Array(e),t,n)}}class ao extends tt{constructor(e,t,n){super(new Uint32Array(e),t,n)}}class Od extends tt{constructor(e,t,n){super(new Uint16Array(e),t,n);this.isFloat16BufferAttribute=!0}getX(e){let t=fs(this.array[e*this.itemSize]);if(this.normalized)t=kt(t,this.array);return t}setX(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize]=zt(t),this}getY(e){let t=fs(this.array[e*this.itemSize+1]);if(this.normalized)t=kt(t,this.array);return t}setY(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+1]=zt(t),this}getZ(e){let t=fs(this.array[e*this.itemSize+2]);if(this.normalized)t=kt(t,this.array);return t}setZ(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+2]=zt(t),this}getW(e){let t=fs(this.array[e*this.itemSize+3]);if(this.normalized)t=kt(t,this.array);return t}setW(e,t){if(this.normalized)t=Ve(t,this.array);return this.array[e*this.itemSize+3]=zt(t),this}setXY(e,t,n){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array);return this.array[e+0]=zt(t),this.array[e+1]=zt(n),this}setXYZ(e,t,n,i){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array);return this.array[e+0]=zt(t),this.array[e+1]=zt(n),this.array[e+2]=zt(i),this}setXYZW(e,t,n,i,s){if(e*=this.itemSize,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array),s=Ve(s,this.array);return this.array[e+0]=zt(t),this.array[e+1]=zt(n),this.array[e+2]=zt(i),this.array[e+3]=zt(s),this}}class Ae extends tt{constructor(e,t,n){super(new Float32Array(e),t,n)}}class Bd extends tt{constructor(e,t,n){super(new Float64Array(e),t,n)}}var zd=0,Yt=new De,ba=new et,Ri=new T,Wt=new Rt,rs=new Rt,Tt=new T;class ze extends nn{constructor(){super();this.isBufferGeometry=!0,Object.defineProperty(this,"id",{value:zd++}),this.uuid=Xt(),this.name="",this.type="BufferGeometry",this.index=null,this.attributes={},this.morphAttributes={},this.morphTargetsRelative=!1,this.groups=[],this.boundingBox=null,this.boundingSphere=null,this.drawRange={start:0,count:1/0},this.userData={}}getIndex(){return this.index}setIndex(e){if(Array.isArray(e))this.index=new((jc(e))?ao:ro)(e,1);else this.index=e;return this}getAttribute(e){return this.attributes[e]}setAttribute(e,t){return this.attributes[e]=t,this}deleteAttribute(e){return delete this.attributes[e],this}hasAttribute(e){return this.attributes[e]!==void 0}addGroup(e,t,n=0){this.groups.push({start:e,count:t,materialIndex:n})}clearGroups(){this.groups=[]}setDrawRange(e,t){this.drawRange.start=e,this.drawRange.count=t}applyMatrix4(e){let t=this.attributes.position;if(t!==void 0)t.applyMatrix4(e),t.needsUpdate=!0;let n=this.attributes.normal;if(n!==void 0){let s=new Ze().getNormalMatrix(e);n.applyNormalMatrix(s),n.needsUpdate=!0}let i=this.attributes.tangent;if(i!==void 0)i.transformDirection(e),i.needsUpdate=!0;if(this.boundingBox!==null)this.computeBoundingBox();if(this.boundingSphere!==null)this.computeBoundingSphere();return this}applyQuaternion(e){return Yt.makeRotationFromQuaternion(e),this.applyMatrix4(Yt),this}rotateX(e){return Yt.makeRotationX(e),this.applyMatrix4(Yt),this}rotateY(e){return Yt.makeRotationY(e),this.applyMatrix4(Yt),this}rotateZ(e){return Yt.makeRotationZ(e),this.applyMatrix4(Yt),this}translate(e,t,n){return Yt.makeTranslation(e,t,n),this.applyMatrix4(Yt),this}scale(e,t,n){return Yt.makeScale(e,t,n),this.applyMatrix4(Yt),this}lookAt(e){return ba.lookAt(e),ba.updateMatrix(),this.applyMatrix4(ba.matrix),this}center(){return this.computeBoundingBox(),this.boundingBox.getCenter(Ri).negate(),this.translate(Ri.x,Ri.y,Ri.z),this}setFromPoints(e){let t=[];for(let n=0,i=e.length;n<i;n++){let s=e[n];t.push(s.x,s.y,s.z||0)}return this.setAttribute("position",new Ae(t,3)),this}computeBoundingBox(){if(this.boundingBox===null)this.boundingBox=new Rt;let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingBox.set(new T(-1/0,-1/0,-1/0),new T(1/0,1/0,1/0));return}if(e!==void 0){if(this.boundingBox.setFromBufferAttribute(e),t)for(let n=0,i=t.length;n<i;n++){let s=t[n];if(Wt.setFromBufferAttribute(s),this.morphTargetsRelative)Tt.addVectors(this.boundingBox.min,Wt.min),this.boundingBox.expandByPoint(Tt),Tt.addVectors(this.boundingBox.max,Wt.max),this.boundingBox.expandByPoint(Tt);else this.boundingBox.expandByPoint(Wt.min),this.boundingBox.expandByPoint(Wt.max)}}else this.boundingBox.makeEmpty();if(isNaN(this.boundingBox.min.x)||isNaN(this.boundingBox.min.y)||isNaN(this.boundingBox.min.z))console.error('THREE.BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.',this)}computeBoundingSphere(){if(this.boundingSphere===null)this.boundingSphere=new At;let e=this.attributes.position,t=this.morphAttributes.position;if(e&&e.isGLBufferAttribute){console.error('THREE.BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere. Alternatively set "mesh.frustumCulled" to "false".',this),this.boundingSphere.set(new T,1/0);return}if(e){let n=this.boundingSphere.center;if(Wt.setFromBufferAttribute(e),t)for(let s=0,r=t.length;s<r;s++){let a=t[s];if(rs.setFromBufferAttribute(a),this.morphTargetsRelative)Tt.addVectors(Wt.min,rs.min),Wt.expandByPoint(Tt),Tt.addVectors(Wt.max,rs.max),Wt.expandByPoint(Tt);else Wt.expandByPoint(rs.min),Wt.expandByPoint(rs.max)}Wt.getCenter(n);let i=0;for(let s=0,r=e.count;s<r;s++)Tt.fromBufferAttribute(e,s),i=Math.max(i,n.distanceToSquared(Tt));if(t)for(let s=0,r=t.length;s<r;s++){let a=t[s],o=this.morphTargetsRelative;for(let l=0,c=a.count;l<c;l++){if(Tt.fromBufferAttribute(a,l),o)Ri.fromBufferAttribute(e,l),Tt.add(Ri);i=Math.max(i,n.distanceToSquared(Tt))}}if(this.boundingSphere.radius=Math.sqrt(i),isNaN(this.boundingSphere.radius))console.error('THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',this)}}computeTangents(){let e=this.index,t=this.attributes;if(e===null||t.position===void 0||t.normal===void 0||t.uv===void 0){console.error("THREE.BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");return}let n=e.array,i=t.position.array,s=t.normal.array,r=t.uv.array,a=i.length/3;if(this.hasAttribute("tangent")===!1)this.setAttribute("tangent",new tt(new Float32Array(4*a),4));let o=this.getAttribute("tangent").array,l=[],c=[];for(let S=0;S<a;S++)l[S]=new T,c[S]=new T;let h=new T,u=new T,d=new T,f=new W,g=new W,_=new W,m=new T,p=new T;function x(S,w,U){h.fromArray(i,S*3),u.fromArray(i,w*3),d.fromArray(i,U*3),f.fromArray(r,S*2),g.fromArray(r,w*2),_.fromArray(r,U*2),u.sub(h),d.sub(h),g.sub(f),_.sub(f);let J=1/(g.x*_.y-_.x*g.y);if(!isFinite(J))return;m.copy(u).multiplyScalar(_.y).addScaledVector(d,-g.y).multiplyScalar(J),p.copy(d).multiplyScalar(g.x).addScaledVector(u,-_.x).multiplyScalar(J),l[S].add(m),l[w].add(m),l[U].add(m),c[S].add(p),c[w].add(p),c[U].add(p)}let v=this.groups;if(v.length===0)v=[{start:0,count:n.length}];for(let S=0,w=v.length;S<w;++S){let U=v[S],{start:J,count:ae}=U;for(let I=J,z=J+ae;I<z;I+=3)x(n[I+0],n[I+1],n[I+2])}let b=new T,R=new T,M=new T,C=new T;function D(S){M.fromArray(s,S*3),C.copy(M);let w=l[S];b.copy(w),b.sub(M.multiplyScalar(M.dot(w))).normalize(),R.crossVectors(C,w);let J=R.dot(c[S])<0?-1:1;o[S*4]=b.x,o[S*4+1]=b.y,o[S*4+2]=b.z,o[S*4+3]=J}for(let S=0,w=v.length;S<w;++S){let U=v[S],{start:J,count:ae}=U;for(let I=J,z=J+ae;I<z;I+=3)D(n[I+0]),D(n[I+1]),D(n[I+2])}}computeVertexNormals(){let e=this.index,t=this.getAttribute("position");if(t!==void 0){let n=this.getAttribute("normal");if(n===void 0)n=new tt(new Float32Array(t.count*3),3),this.setAttribute("normal",n);else for(let u=0,d=n.count;u<d;u++)n.setXYZ(u,0,0,0);let i=new T,s=new T,r=new T,a=new T,o=new T,l=new T,c=new T,h=new T;if(e)for(let u=0,d=e.count;u<d;u+=3){let f=e.getX(u+0),g=e.getX(u+1),_=e.getX(u+2);i.fromBufferAttribute(t,f),s.fromBufferAttribute(t,g),r.fromBufferAttribute(t,_),c.subVectors(r,s),h.subVectors(i,s),c.cross(h),a.fromBufferAttribute(n,f),o.fromBufferAttribute(n,g),l.fromBufferAttribute(n,_),a.add(c),o.add(c),l.add(c),n.setXYZ(f,a.x,a.y,a.z),n.setXYZ(g,o.x,o.y,o.z),n.setXYZ(_,l.x,l.y,l.z)}else for(let u=0,d=t.count;u<d;u+=3)i.fromBufferAttribute(t,u+0),s.fromBufferAttribute(t,u+1),r.fromBufferAttribute(t,u+2),c.subVectors(r,s),h.subVectors(i,s),c.cross(h),n.setXYZ(u+0,c.x,c.y,c.z),n.setXYZ(u+1,c.x,c.y,c.z),n.setXYZ(u+2,c.x,c.y,c.z);this.normalizeNormals(),n.needsUpdate=!0}}normalizeNormals(){let e=this.attributes.normal;for(let t=0,n=e.count;t<n;t++)Tt.fromBufferAttribute(e,t),Tt.normalize(),e.setXYZ(t,Tt.x,Tt.y,Tt.z)}toNonIndexed(){function e(a,o){let{array:l,itemSize:c,normalized:h}=a,u=new l.constructor(o.length*c),d=0,f=0;for(let g=0,_=o.length;g<_;g++){if(a.isInterleavedBufferAttribute)d=o[g]*a.data.stride+a.offset;else d=o[g]*c;for(let m=0;m<c;m++)u[f++]=l[d++]}return new tt(u,c,h)}if(this.index===null)return console.warn("THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."),this;let t=new ze,n=this.index.array,i=this.attributes;for(let a in i){let o=i[a],l=e(o,n);t.setAttribute(a,l)}let s=this.morphAttributes;for(let a in s){let o=[],l=s[a];for(let c=0,h=l.length;c<h;c++){let u=l[c],d=e(u,n);o.push(d)}t.morphAttributes[a]=o}t.morphTargetsRelative=this.morphTargetsRelative;let r=this.groups;for(let a=0,o=r.length;a<o;a++){let l=r[a];t.addGroup(l.start,l.count,l.materialIndex)}return t}toJSON(){let e={metadata:{version:4.6,type:"BufferGeometry",generator:"BufferGeometry.toJSON"}};if(e.uuid=this.uuid,e.type=this.type,this.name!=="")e.name=this.name;if(Object.keys(this.userData).length>0)e.userData=this.userData;if(this.parameters!==void 0){let o=this.parameters;for(let l in o)if(o[l]!==void 0)e[l]=o[l];return e}e.data={attributes:{}};let t=this.index;if(t!==null)e.data.index={type:t.array.constructor.name,array:Array.prototype.slice.call(t.array)};let n=this.attributes;for(let o in n){let l=n[o];e.data.attributes[o]=l.toJSON(e.data)}let i={},s=!1;for(let o in this.morphAttributes){let l=this.morphAttributes[o],c=[];for(let h=0,u=l.length;h<u;h++){let d=l[h];c.push(d.toJSON(e.data))}if(c.length>0)i[o]=c,s=!0}if(s)e.data.morphAttributes=i,e.data.morphTargetsRelative=this.morphTargetsRelative;let r=this.groups;if(r.length>0)e.data.groups=JSON.parse(JSON.stringify(r));let a=this.boundingSphere;if(a!==null)e.data.boundingSphere={center:a.center.toArray(),radius:a.radius};return e}clone(){return new this.constructor().copy(this)}copy(e){this.index=null,this.attributes={},this.morphAttributes={},this.groups=[],this.boundingBox=null,this.boundingSphere=null;let t={};this.name=e.name;let n=e.index;if(n!==null)this.setIndex(n.clone(t));let i=e.attributes;for(let l in i){let c=i[l];this.setAttribute(l,c.clone(t))}let s=e.morphAttributes;for(let l in s){let c=[],h=s[l];for(let u=0,d=h.length;u<d;u++)c.push(h[u].clone(t));this.morphAttributes[l]=c}this.morphTargetsRelative=e.morphTargetsRelative;let r=e.groups;for(let l=0,c=r.length;l<c;l++){let h=r[l];this.addGroup(h.start,h.count,h.materialIndex)}let a=e.boundingBox;if(a!==null)this.boundingBox=a.clone();let o=e.boundingSphere;if(o!==null)this.boundingSphere=o.clone();return this.drawRange.start=e.drawRange.start,this.drawRange.count=e.drawRange.count,this.userData=e.userData,this}dispose(){this.dispatchEvent({type:"dispose"})}}var gl=new De,Zn=new On,qs=new At,_l=new T,Ci=new T,Pi=new T,Li=new T,Ta=new T,Ys=new T,Zs=new W,Ks=new W,Js=new W,xl=new T,vl=new T,yl=new T,$s=new T,js=new T;class Je extends et{constructor(e=new ze,t=new wt){super();this.isMesh=!0,this.type="Mesh",this.geometry=e,this.material=t,this.updateMorphTargets()}copy(e,t){if(super.copy(e,t),e.morphTargetInfluences!==void 0)this.morphTargetInfluences=e.morphTargetInfluences.slice();if(e.morphTargetDictionary!==void 0)this.morphTargetDictionary=Object.assign({},e.morphTargetDictionary);return this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let i=t[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,r=i.length;s<r;s++){let a=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}getVertexPosition(e,t){let n=this.geometry,i=n.attributes.position,s=n.morphAttributes.position,r=n.morphTargetsRelative;t.fromBufferAttribute(i,e);let a=this.morphTargetInfluences;if(s&&a){Ys.set(0,0,0);for(let o=0,l=s.length;o<l;o++){let c=a[o],h=s[o];if(c===0)continue;if(Ta.fromBufferAttribute(h,e),r)Ys.addScaledVector(Ta,c);else Ys.addScaledVector(Ta.sub(t),c)}t.add(Ys)}return t}raycast(e,t){let n=this.geometry,i=this.material,s=this.matrixWorld;if(i===void 0)return;if(n.boundingSphere===null)n.computeBoundingSphere();if(qs.copy(n.boundingSphere),qs.applyMatrix4(s),Zn.copy(e.ray).recast(e.near),qs.containsPoint(Zn.origin)===!1){if(Zn.intersectSphere(qs,_l)===null)return;if(Zn.origin.distanceToSquared(_l)>(e.far-e.near)**2)return}if(gl.copy(s).invert(),Zn.copy(e.ray).applyMatrix4(gl),n.boundingBox!==null){if(Zn.intersectsBox(n.boundingBox)===!1)return}this._computeIntersections(e,t,Zn)}_computeIntersections(e,t,n){let i,s=this.geometry,r=this.material,a=s.index,o=s.attributes.position,l=s.attributes.uv,c=s.attributes.uv1,h=s.attributes.normal,{groups:u,drawRange:d}=s;if(a!==null)if(Array.isArray(r))for(let f=0,g=u.length;f<g;f++){let _=u[f],m=r[_.materialIndex],p=Math.max(_.start,d.start),x=Math.min(a.count,Math.min(_.start+_.count,d.start+d.count));for(let v=p,b=x;v<b;v+=3){let R=a.getX(v),M=a.getX(v+1),C=a.getX(v+2);if(i=Qs(this,m,e,n,l,c,h,R,M,C),i)i.faceIndex=Math.floor(v/3),i.face.materialIndex=_.materialIndex,t.push(i)}}else{let f=Math.max(0,d.start),g=Math.min(a.count,d.start+d.count);for(let _=f,m=g;_<m;_+=3){let p=a.getX(_),x=a.getX(_+1),v=a.getX(_+2);if(i=Qs(this,r,e,n,l,c,h,p,x,v),i)i.faceIndex=Math.floor(_/3),t.push(i)}}else if(o!==void 0)if(Array.isArray(r))for(let f=0,g=u.length;f<g;f++){let _=u[f],m=r[_.materialIndex],p=Math.max(_.start,d.start),x=Math.min(o.count,Math.min(_.start+_.count,d.start+d.count));for(let v=p,b=x;v<b;v+=3){let R=v,M=v+1,C=v+2;if(i=Qs(this,m,e,n,l,c,h,R,M,C),i)i.faceIndex=Math.floor(v/3),i.face.materialIndex=_.materialIndex,t.push(i)}}else{let f=Math.max(0,d.start),g=Math.min(o.count,d.start+d.count);for(let _=f,m=g;_<m;_+=3){let p=_,x=_+1,v=_+2;if(i=Qs(this,r,e,n,l,c,h,p,x,v),i)i.faceIndex=Math.floor(_/3),t.push(i)}}}}function kd(e,t,n,i,s,r,a,o){let l;if(t.side===1)l=i.intersectTriangle(a,r,s,!0,o);else l=i.intersectTriangle(s,r,a,t.side===0,o);if(l===null)return null;js.copy(o),js.applyMatrix4(e.matrixWorld);let c=n.ray.origin.distanceTo(js);if(c<n.near||c>n.far)return null;return{distance:c,point:js.clone(),object:e}}function Qs(e,t,n,i,s,r,a,o,l,c){e.getVertexPosition(o,Ci),e.getVertexPosition(l,Pi),e.getVertexPosition(c,Li);let h=kd(e,t,n,i,Ci,Pi,Li,$s);if(h){if(s)Zs.fromBufferAttribute(s,o),Ks.fromBufferAttribute(s,l),Js.fromBufferAttribute(s,c),h.uv=Vt.getInterpolation($s,Ci,Pi,Li,Zs,Ks,Js,new W);if(r)Zs.fromBufferAttribute(r,o),Ks.fromBufferAttribute(r,l),Js.fromBufferAttribute(r,c),h.uv1=Vt.getInterpolation($s,Ci,Pi,Li,Zs,Ks,Js,new W),h.uv2=h.uv1;if(a){if(xl.fromBufferAttribute(a,o),vl.fromBufferAttribute(a,l),yl.fromBufferAttribute(a,c),h.normal=Vt.getInterpolation($s,Ci,Pi,Li,xl,vl,yl,new T),h.normal.dot(i.direction)>0)h.normal.multiplyScalar(-1)}let u={a:o,b:l,c,normal:new T,materialIndex:0};Vt.getNormal(Ci,Pi,Li,u.normal),h.face=u}return h}class Bn extends ze{constructor(e=1,t=1,n=1,i=1,s=1,r=1){super();this.type="BoxGeometry",this.parameters={width:e,height:t,depth:n,widthSegments:i,heightSegments:s,depthSegments:r};let a=this;i=Math.floor(i),s=Math.floor(s),r=Math.floor(r);let o=[],l=[],c=[],h=[],u=0,d=0;f("z","y","x",-1,-1,n,t,e,r,s,0),f("z","y","x",1,-1,n,t,-e,r,s,1),f("x","z","y",1,1,e,n,t,i,r,2),f("x","z","y",1,-1,e,n,-t,i,r,3),f("x","y","z",1,-1,e,t,n,i,s,4),f("x","y","z",-1,-1,e,t,-n,i,s,5),this.setIndex(o),this.setAttribute("position",new Ae(l,3)),this.setAttribute("normal",new Ae(c,3)),this.setAttribute("uv",new Ae(h,2));function f(g,_,m,p,x,v,b,R,M,C,D){let S=v/M,w=b/C,U=v/2,J=b/2,ae=R/2,I=M+1,z=C+1,X=0,ne=0,V=new T;for(let q=0;q<z;q++){let ee=q*w-J;for(let oe=0;oe<I;oe++){let O=oe*S-U;V[g]=O*p,V[_]=ee*x,V[m]=ae,l.push(V.x,V.y,V.z),V[g]=0,V[_]=0,V[m]=R>0?1:-1,c.push(V.x,V.y,V.z),h.push(oe/M),h.push(1-q/C),X+=1}}for(let q=0;q<C;q++)for(let ee=0;ee<M;ee++){let oe=u+ee+I*q,O=u+ee+I*(q+1),te=u+(ee+1)+I*(q+1),ge=u+(ee+1)+I*q;o.push(oe,O,ge),o.push(O,te,ge),ne+=6}a.addGroup(d,ne,D),d+=ne,u+=X}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Bn(e.width,e.height,e.depth,e.widthSegments,e.heightSegments,e.depthSegments)}}function Yi(e){let t={};for(let n in e){t[n]={};for(let i in e[n]){let s=e[n][i];if(s&&(s.isColor||s.isMatrix3||s.isMatrix4||s.isVector2||s.isVector3||s.isVector4||s.isTexture||s.isQuaternion))if(s.isRenderTargetTexture)console.warn("UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms() or mergeUniforms()."),t[n][i]=null;else t[n][i]=s.clone();else if(Array.isArray(s))t[n][i]=s.slice();else t[n][i]=s}}return t}function Bt(e){let t={};for(let n=0;n<e.length;n++){let i=Yi(e[n]);for(let s in i)t[s]=i[s]}return t}function Gd(e){let t=[];for(let n=0;n<e.length;n++)t.push(e[n].clone());return t}function th(e){if(e.getRenderTarget()===null)return e.outputColorSpace;return nt.workingColorSpace}var zn={clone:Yi,merge:Bt},Hd=`void main() {
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`,Wd=`void main() {
	gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
}`;class Et extends xt{constructor(e){super();if(this.isShaderMaterial=!0,this.type="ShaderMaterial",this.defines={},this.uniforms={},this.uniformsGroups=[],this.vertexShader=Hd,this.fragmentShader=Wd,this.linewidth=1,this.wireframe=!1,this.wireframeLinewidth=1,this.fog=!1,this.lights=!1,this.clipping=!1,this.forceSinglePass=!0,this.extensions={derivatives:!1,fragDepth:!1,drawBuffers:!1,shaderTextureLOD:!1,clipCullDistance:!1},this.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv1:[0,0]},this.index0AttributeName=void 0,this.uniformsNeedUpdate=!1,this.glslVersion=null,e!==void 0)this.setValues(e)}copy(e){return super.copy(e),this.fragmentShader=e.fragmentShader,this.vertexShader=e.vertexShader,this.uniforms=Yi(e.uniforms),this.uniformsGroups=Gd(e.uniformsGroups),this.defines=Object.assign({},e.defines),this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.fog=e.fog,this.lights=e.lights,this.clipping=e.clipping,this.extensions=Object.assign({},e.extensions),this.glslVersion=e.glslVersion,this}toJSON(e){let t=super.toJSON(e);t.glslVersion=this.glslVersion,t.uniforms={};for(let i in this.uniforms){let r=this.uniforms[i].value;if(r&&r.isTexture)t.uniforms[i]={type:"t",value:r.toJSON(e).uuid};else if(r&&r.isColor)t.uniforms[i]={type:"c",value:r.getHex()};else if(r&&r.isVector2)t.uniforms[i]={type:"v2",value:r.toArray()};else if(r&&r.isVector3)t.uniforms[i]={type:"v3",value:r.toArray()};else if(r&&r.isVector4)t.uniforms[i]={type:"v4",value:r.toArray()};else if(r&&r.isMatrix3)t.uniforms[i]={type:"m3",value:r.toArray()};else if(r&&r.isMatrix4)t.uniforms[i]={type:"m4",value:r.toArray()};else t.uniforms[i]={value:r}}if(Object.keys(this.defines).length>0)t.defines=this.defines;t.vertexShader=this.vertexShader,t.fragmentShader=this.fragmentShader,t.lights=this.lights,t.clipping=this.clipping;let n={};for(let i in this.extensions)if(this.extensions[i]===!0)n[i]=!0;if(Object.keys(n).length>0)t.extensions=n;return t}}class Fr extends et{constructor(){super();this.isCamera=!0,this.type="Camera",this.matrixWorldInverse=new De,this.projectionMatrix=new De,this.projectionMatrixInverse=new De,this.coordinateSystem=2000}copy(e,t){return super.copy(e,t),this.matrixWorldInverse.copy(e.matrixWorldInverse),this.projectionMatrix.copy(e.projectionMatrix),this.projectionMatrixInverse.copy(e.projectionMatrixInverse),this.coordinateSystem=e.coordinateSystem,this}getWorldDirection(e){return super.getWorldDirection(e).negate()}updateMatrixWorld(e){super.updateMatrixWorld(e),this.matrixWorldInverse.copy(this.matrixWorld).invert()}updateWorldMatrix(e,t){super.updateWorldMatrix(e,t),this.matrixWorldInverse.copy(this.matrixWorld).invert()}clone(){return new this.constructor().copy(this)}}class yt extends Fr{constructor(e=50,t=1,n=0.1,i=2000){super();this.isPerspectiveCamera=!0,this.type="PerspectiveCamera",this.fov=e,this.zoom=1,this.near=n,this.far=i,this.focus=10,this.aspect=t,this.view=null,this.filmGauge=35,this.filmOffset=0,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.fov=e.fov,this.zoom=e.zoom,this.near=e.near,this.far=e.far,this.focus=e.focus,this.aspect=e.aspect,this.view=e.view===null?null:Object.assign({},e.view),this.filmGauge=e.filmGauge,this.filmOffset=e.filmOffset,this}setFocalLength(e){let t=0.5*this.getFilmHeight()/e;this.fov=qi*2*Math.atan(t),this.updateProjectionMatrix()}getFocalLength(){let e=Math.tan(ai*0.5*this.fov);return 0.5*this.getFilmHeight()/e}getEffectiveFOV(){return qi*2*Math.atan(Math.tan(ai*0.5*this.fov)/this.zoom)}getFilmWidth(){return this.filmGauge*Math.min(this.aspect,1)}getFilmHeight(){return this.filmGauge/Math.max(this.aspect,1)}setViewOffset(e,t,n,i,s,r){if(this.aspect=e/t,this.view===null)this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1};this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=r,this.updateProjectionMatrix()}clearViewOffset(){if(this.view!==null)this.view.enabled=!1;this.updateProjectionMatrix()}updateProjectionMatrix(){let e=this.near,t=e*Math.tan(ai*0.5*this.fov)/this.zoom,n=2*t,i=this.aspect*n,s=-0.5*i,r=this.view;if(this.view!==null&&this.view.enabled){let{fullWidth:o,fullHeight:l}=r;s+=r.offsetX*i/o,t-=r.offsetY*n/l,i*=r.width/o,n*=r.height/l}let a=this.filmOffset;if(a!==0)s+=e*a/this.getFilmWidth();this.projectionMatrix.makePerspective(s,s+i,t,t-n,e,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);if(t.object.fov=this.fov,t.object.zoom=this.zoom,t.object.near=this.near,t.object.far=this.far,t.object.focus=this.focus,t.object.aspect=this.aspect,this.view!==null)t.object.view=Object.assign({},this.view);return t.object.filmGauge=this.filmGauge,t.object.filmOffset=this.filmOffset,t}}var Ii=-90,Ni=1;class nh extends et{constructor(e,t,n){super();this.type="CubeCamera",this.renderTarget=n,this.coordinateSystem=null,this.activeMipmapLevel=0;let i=new yt(Ii,Ni,e,t);i.layers=this.layers,this.add(i);let s=new yt(Ii,Ni,e,t);s.layers=this.layers,this.add(s);let r=new yt(Ii,Ni,e,t);r.layers=this.layers,this.add(r);let a=new yt(Ii,Ni,e,t);a.layers=this.layers,this.add(a);let o=new yt(Ii,Ni,e,t);o.layers=this.layers,this.add(o);let l=new yt(Ii,Ni,e,t);l.layers=this.layers,this.add(l)}updateCoordinateSystem(){let e=this.coordinateSystem,t=this.children.concat(),[n,i,s,r,a,o]=t;for(let l of t)this.remove(l);if(e===2000)n.up.set(0,1,0),n.lookAt(1,0,0),i.up.set(0,1,0),i.lookAt(-1,0,0),s.up.set(0,0,-1),s.lookAt(0,1,0),r.up.set(0,0,1),r.lookAt(0,-1,0),a.up.set(0,1,0),a.lookAt(0,0,1),o.up.set(0,1,0),o.lookAt(0,0,-1);else if(e===2001)n.up.set(0,-1,0),n.lookAt(-1,0,0),i.up.set(0,-1,0),i.lookAt(1,0,0),s.up.set(0,0,1),s.lookAt(0,1,0),r.up.set(0,0,-1),r.lookAt(0,-1,0),a.up.set(0,-1,0),a.lookAt(0,0,1),o.up.set(0,-1,0),o.lookAt(0,0,-1);else throw Error("THREE.CubeCamera.updateCoordinateSystem(): Invalid coordinate system: "+e);for(let l of t)this.add(l),l.updateMatrixWorld()}update(e,t){if(this.parent===null)this.updateMatrixWorld();let{renderTarget:n,activeMipmapLevel:i}=this;if(this.coordinateSystem!==e.coordinateSystem)this.coordinateSystem=e.coordinateSystem,this.updateCoordinateSystem();let[s,r,a,o,l,c]=this.children,h=e.getRenderTarget(),u=e.getActiveCubeFace(),d=e.getActiveMipmapLevel(),f=e.xr.enabled;e.xr.enabled=!1;let g=n.texture.generateMipmaps;n.texture.generateMipmaps=!1,e.setRenderTarget(n,0,i),e.render(t,s),e.setRenderTarget(n,1,i),e.render(t,r),e.setRenderTarget(n,2,i),e.render(t,a),e.setRenderTarget(n,3,i),e.render(t,o),e.setRenderTarget(n,4,i),e.render(t,l),n.texture.generateMipmaps=g,e.setRenderTarget(n,5,i),e.render(t,c),e.setRenderTarget(h,u,d),e.xr.enabled=f,n.texture.needsPMREMUpdate=!0}}class Es extends ht{constructor(e,t,n,i,s,r,a,o,l,c){e=e!==void 0?e:[],t=t!==void 0?t:301;super(e,t,n,i,s,r,a,o,l,c);this.isCubeTexture=!0,this.flipY=!1}get images(){return this.image}set images(e){this.image=e}}class ih extends Ct{constructor(e=1,t={}){super(e,e,t);this.isWebGLCubeRenderTarget=!0;let n={width:e,height:e,depth:1},i=[n,n,n,n,n,n];if(t.encoding!==void 0)ms("THREE.WebGLCubeRenderTarget: option.encoding has been replaced by option.colorSpace."),t.colorSpace=t.encoding===3001?"srgb":"";this.texture=new Es(i,t.mapping,t.wrapS,t.wrapT,t.magFilter,t.minFilter,t.format,t.type,t.anisotropy,t.colorSpace),this.texture.isRenderTargetTexture=!0,this.texture.generateMipmaps=t.generateMipmaps!==void 0?t.generateMipmaps:!1,this.texture.minFilter=t.minFilter!==void 0?t.minFilter:1006}fromEquirectangularTexture(e,t){this.texture.type=t.type,this.texture.colorSpace=t.colorSpace,this.texture.generateMipmaps=t.generateMipmaps,this.texture.minFilter=t.minFilter,this.texture.magFilter=t.magFilter;let n={uniforms:{tEquirect:{value:null}},vertexShader:`

				varying vec3 vWorldDirection;

				vec3 transformDirection( in vec3 dir, in mat4 matrix ) {

					return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );

				}

				void main() {

					vWorldDirection = transformDirection( position, modelMatrix );

					#include <begin_vertex>
					#include <project_vertex>

				}
			`,fragmentShader:`

				uniform sampler2D tEquirect;

				varying vec3 vWorldDirection;

				#include <common>

				void main() {

					vec3 direction = normalize( vWorldDirection );

					vec2 sampleUV = equirectUv( direction );

					gl_FragColor = texture2D( tEquirect, sampleUV );

				}
			`},i=new Bn(5,5,5),s=new Et({name:"CubemapFromEquirect",uniforms:Yi(n.uniforms),vertexShader:n.vertexShader,fragmentShader:n.fragmentShader,side:1,blending:0});s.uniforms.tEquirect.value=t;let r=new Je(i,s),a=t.minFilter;if(t.minFilter===1008)t.minFilter=1006;return new nh(1,10,this).update(e,r),t.minFilter=a,r.geometry.dispose(),r.material.dispose(),this}clear(e,t,n,i){let s=e.getRenderTarget();for(let r=0;r<6;r++)e.setRenderTarget(this,r),e.clear(t,n,i);e.setRenderTarget(s)}}var Aa=new T,Vd=new T,Xd=new Ze;class ln{constructor(e=new T(1,0,0),t=0){this.isPlane=!0,this.normal=e,this.constant=t}set(e,t){return this.normal.copy(e),this.constant=t,this}setComponents(e,t,n,i){return this.normal.set(e,t,n),this.constant=i,this}setFromNormalAndCoplanarPoint(e,t){return this.normal.copy(e),this.constant=-t.dot(this.normal),this}setFromCoplanarPoints(e,t,n){let i=Aa.subVectors(n,t).cross(Vd.subVectors(e,t)).normalize();return this.setFromNormalAndCoplanarPoint(i,e),this}copy(e){return this.normal.copy(e.normal),this.constant=e.constant,this}normalize(){let e=1/this.normal.length();return this.normal.multiplyScalar(e),this.constant*=e,this}negate(){return this.constant*=-1,this.normal.negate(),this}distanceToPoint(e){return this.normal.dot(e)+this.constant}distanceToSphere(e){return this.distanceToPoint(e.center)-e.radius}projectPoint(e,t){return t.copy(e).addScaledVector(this.normal,-this.distanceToPoint(e))}intersectLine(e,t){let n=e.delta(Aa),i=this.normal.dot(n);if(i===0){if(this.distanceToPoint(e.start)===0)return t.copy(e.start);return null}let s=-(e.start.dot(this.normal)+this.constant)/i;if(s<0||s>1)return null;return t.copy(e.start).addScaledVector(n,s)}intersectsLine(e){let t=this.distanceToPoint(e.start),n=this.distanceToPoint(e.end);return t<0&&n>0||n<0&&t>0}intersectsBox(e){return e.intersectsPlane(this)}intersectsSphere(e){return e.intersectsPlane(this)}coplanarPoint(e){return e.copy(this.normal).multiplyScalar(-this.constant)}applyMatrix4(e,t){let n=t||Xd.getNormalMatrix(e),i=this.coplanarPoint(Aa).applyMatrix4(e),s=this.normal.applyMatrix3(n).normalize();return this.constant=-i.dot(s),this}translate(e){return this.constant-=e.dot(this.normal),this}equals(e){return e.normal.equals(this.normal)&&e.constant===this.constant}clone(){return new this.constructor().copy(this)}}var Kn=new At,er=new T;class ws{constructor(e=new ln,t=new ln,n=new ln,i=new ln,s=new ln,r=new ln){this.planes=[e,t,n,i,s,r]}set(e,t,n,i,s,r){let a=this.planes;return a[0].copy(e),a[1].copy(t),a[2].copy(n),a[3].copy(i),a[4].copy(s),a[5].copy(r),this}copy(e){let t=this.planes;for(let n=0;n<6;n++)t[n].copy(e.planes[n]);return this}setFromProjectionMatrix(e,t=2000){let n=this.planes,i=e.elements,s=i[0],r=i[1],a=i[2],o=i[3],l=i[4],c=i[5],h=i[6],u=i[7],d=i[8],f=i[9],g=i[10],_=i[11],m=i[12],p=i[13],x=i[14],v=i[15];if(n[0].setComponents(o-s,u-l,_-d,v-m).normalize(),n[1].setComponents(o+s,u+l,_+d,v+m).normalize(),n[2].setComponents(o+r,u+c,_+f,v+p).normalize(),n[3].setComponents(o-r,u-c,_-f,v-p).normalize(),n[4].setComponents(o-a,u-h,_-g,v-x).normalize(),t===2000)n[5].setComponents(o+a,u+h,_+g,v+x).normalize();else if(t===2001)n[5].setComponents(a,h,g,x).normalize();else throw Error("THREE.Frustum.setFromProjectionMatrix(): Invalid coordinate system: "+t);return this}intersectsObject(e){if(e.boundingSphere!==void 0){if(e.boundingSphere===null)e.computeBoundingSphere();Kn.copy(e.boundingSphere).applyMatrix4(e.matrixWorld)}else{let t=e.geometry;if(t.boundingSphere===null)t.computeBoundingSphere();Kn.copy(t.boundingSphere).applyMatrix4(e.matrixWorld)}return this.intersectsSphere(Kn)}intersectsSprite(e){return Kn.center.set(0,0,0),Kn.radius=0.7071067811865476,Kn.applyMatrix4(e.matrixWorld),this.intersectsSphere(Kn)}intersectsSphere(e){let t=this.planes,n=e.center,i=-e.radius;for(let s=0;s<6;s++)if(t[s].distanceToPoint(n)<i)return!1;return!0}intersectsBox(e){let t=this.planes;for(let n=0;n<6;n++){let i=t[n];if(er.x=i.normal.x>0?e.max.x:e.min.x,er.y=i.normal.y>0?e.max.y:e.min.y,er.z=i.normal.z>0?e.max.z:e.min.z,i.distanceToPoint(er)<0)return!1}return!0}containsPoint(e){let t=this.planes;for(let n=0;n<6;n++)if(t[n].distanceToPoint(e)<0)return!1;return!0}clone(){return new this.constructor().copy(this)}}function sh(){let e=null,t=!1,n=null,i=null;function s(r,a){n(r,a),i=e.requestAnimationFrame(s)}return{start:function(){if(t===!0)return;if(n===null)return;i=e.requestAnimationFrame(s),t=!0},stop:function(){e.cancelAnimationFrame(i),t=!1},setAnimationLoop:function(r){n=r},setContext:function(r){e=r}}}function qd(e,t){let n=t.isWebGL2,i=new WeakMap;function s(c,h){let{array:u,usage:d}=c,f=u.byteLength,g=e.createBuffer();e.bindBuffer(h,g),e.bufferData(h,u,d),c.onUploadCallback();let _;if(u instanceof Float32Array)_=e.FLOAT;else if(u instanceof Uint16Array)if(c.isFloat16BufferAttribute)if(n)_=e.HALF_FLOAT;else throw Error("THREE.WebGLAttributes: Usage of Float16BufferAttribute requires WebGL2.");else _=e.UNSIGNED_SHORT;else if(u instanceof Int16Array)_=e.SHORT;else if(u instanceof Uint32Array)_=e.UNSIGNED_INT;else if(u instanceof Int32Array)_=e.INT;else if(u instanceof Int8Array)_=e.BYTE;else if(u instanceof Uint8Array)_=e.UNSIGNED_BYTE;else if(u instanceof Uint8ClampedArray)_=e.UNSIGNED_BYTE;else throw Error("THREE.WebGLAttributes: Unsupported buffer data format: "+u);return{buffer:g,type:_,bytesPerElement:u.BYTES_PER_ELEMENT,version:c.version,size:f}}function r(c,h,u){let{array:d,_updateRange:f,updateRanges:g}=h;if(e.bindBuffer(u,c),f.count===-1&&g.length===0)e.bufferSubData(u,0,d);if(g.length!==0){for(let _=0,m=g.length;_<m;_++){let p=g[_];if(n)e.bufferSubData(u,p.start*d.BYTES_PER_ELEMENT,d,p.start,p.count);else e.bufferSubData(u,p.start*d.BYTES_PER_ELEMENT,d.subarray(p.start,p.start+p.count))}h.clearUpdateRanges()}if(f.count!==-1){if(n)e.bufferSubData(u,f.offset*d.BYTES_PER_ELEMENT,d,f.offset,f.count);else e.bufferSubData(u,f.offset*d.BYTES_PER_ELEMENT,d.subarray(f.offset,f.offset+f.count));f.count=-1}h.onUploadCallback()}function a(c){if(c.isInterleavedBufferAttribute)c=c.data;return i.get(c)}function o(c){if(c.isInterleavedBufferAttribute)c=c.data;let h=i.get(c);if(h)e.deleteBuffer(h.buffer),i.delete(c)}function l(c,h){if(c.isGLBufferAttribute){let d=i.get(c);if(!d||d.version<c.version)i.set(c,{buffer:c.buffer,type:c.type,bytesPerElement:c.elementSize,version:c.version});return}if(c.isInterleavedBufferAttribute)c=c.data;let u=i.get(c);if(u===void 0)i.set(c,s(c,h));else if(u.version<c.version){if(u.size!==c.array.byteLength)throw Error("THREE.WebGLAttributes: The size of the buffer attribute's array buffer does not match the original size. Resizing buffer attributes is not supported.");r(u.buffer,c,h),u.version=c.version}}return{get:a,remove:o,update:l}}class Or extends ze{constructor(e=1,t=1,n=1,i=1){super();this.type="PlaneGeometry",this.parameters={width:e,height:t,widthSegments:n,heightSegments:i};let s=e/2,r=t/2,a=Math.floor(n),o=Math.floor(i),l=a+1,c=o+1,h=e/a,u=t/o,d=[],f=[],g=[],_=[];for(let m=0;m<c;m++){let p=m*u-r;for(let x=0;x<l;x++){let v=x*h-s;f.push(v,-p,0),g.push(0,0,1),_.push(x/a),_.push(1-m/o)}}for(let m=0;m<o;m++)for(let p=0;p<a;p++){let x=p+l*m,v=p+l*(m+1),b=p+1+l*(m+1),R=p+1+l*m;d.push(x,v,R),d.push(v,b,R)}this.setIndex(d),this.setAttribute("position",new Ae(f,3)),this.setAttribute("normal",new Ae(g,3)),this.setAttribute("uv",new Ae(_,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Or(e.width,e.height,e.widthSegments,e.heightSegments)}}var Yd=`#ifdef USE_ALPHAHASH
	if ( diffuseColor.a < getAlphaHashThreshold( vPosition ) ) discard;
#endif`,Zd=`#ifdef USE_ALPHAHASH
	const float ALPHA_HASH_SCALE = 0.05;
	float hash2D( vec2 value ) {
		return fract( 1.0e4 * sin( 17.0 * value.x + 0.1 * value.y ) * ( 0.1 + abs( sin( 13.0 * value.y + value.x ) ) ) );
	}
	float hash3D( vec3 value ) {
		return hash2D( vec2( hash2D( value.xy ), value.z ) );
	}
	float getAlphaHashThreshold( vec3 position ) {
		float maxDeriv = max(
			length( dFdx( position.xyz ) ),
			length( dFdy( position.xyz ) )
		);
		float pixScale = 1.0 / ( ALPHA_HASH_SCALE * maxDeriv );
		vec2 pixScales = vec2(
			exp2( floor( log2( pixScale ) ) ),
			exp2( ceil( log2( pixScale ) ) )
		);
		vec2 alpha = vec2(
			hash3D( floor( pixScales.x * position.xyz ) ),
			hash3D( floor( pixScales.y * position.xyz ) )
		);
		float lerpFactor = fract( log2( pixScale ) );
		float x = ( 1.0 - lerpFactor ) * alpha.x + lerpFactor * alpha.y;
		float a = min( lerpFactor, 1.0 - lerpFactor );
		vec3 cases = vec3(
			x * x / ( 2.0 * a * ( 1.0 - a ) ),
			( x - 0.5 * a ) / ( 1.0 - a ),
			1.0 - ( ( 1.0 - x ) * ( 1.0 - x ) / ( 2.0 * a * ( 1.0 - a ) ) )
		);
		float threshold = ( x < ( 1.0 - a ) )
			? ( ( x < a ) ? cases.x : cases.y )
			: cases.z;
		return clamp( threshold , 1.0e-6, 1.0 );
	}
#endif`,Kd=`#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
#endif`,Jd=`#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,$d=`#ifdef USE_ALPHATEST
	if ( diffuseColor.a < alphaTest ) discard;
#endif`,jd=`#ifdef USE_ALPHATEST
	uniform float alphaTest;
#endif`,Qd=`#ifdef USE_AOMAP
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
	reflectedLight.indirectDiffuse *= ambientOcclusion;
	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD )
		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
	#endif
#endif`,ef=`#ifdef USE_AOMAP
	uniform sampler2D aoMap;
	uniform float aoMapIntensity;
#endif`,tf=`#ifdef USE_BATCHING
	attribute float batchId;
	uniform highp sampler2D batchingTexture;
	mat4 getBatchingMatrix( const in float i ) {
		int size = textureSize( batchingTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( batchingTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( batchingTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( batchingTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( batchingTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,nf=`#ifdef USE_BATCHING
	mat4 batchingMatrix = getBatchingMatrix( batchId );
#endif`,sf=`vec3 transformed = vec3( position );
#ifdef USE_ALPHAHASH
	vPosition = vec3( position );
#endif`,rf=`vec3 objectNormal = vec3( normal );
#ifdef USE_TANGENT
	vec3 objectTangent = vec3( tangent.xyz );
#endif`,af=`float G_BlinnPhong_Implicit( ) {
	return 0.25;
}
float D_BlinnPhong( const in float shininess, const in float dotNH ) {
	return RECIPROCAL_PI * ( shininess * 0.5 + 1.0 ) * pow( dotNH, shininess );
}
vec3 BRDF_BlinnPhong( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in vec3 specularColor, const in float shininess ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( specularColor, 1.0, dotVH );
	float G = G_BlinnPhong_Implicit( );
	float D = D_BlinnPhong( shininess, dotNH );
	return F * ( G * D );
} // validated`,of=`#ifdef USE_IRIDESCENCE
	const mat3 XYZ_TO_REC709 = mat3(
		 3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);
	vec3 Fresnel0ToIor( vec3 fresnel0 ) {
		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );
	}
	vec3 IorToFresnel0( vec3 transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );
	}
	float IorToFresnel0( float transmittedIor, float incidentIor ) {
		return pow2( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ));
	}
	vec3 evalSensitivity( float OPD, vec3 shift ) {
		float phase = 2.0 * PI * OPD * 1.0e-9;
		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );
		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - pow2( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * pow2( phase ) );
		xyz /= 1.0685e-7;
		vec3 rgb = XYZ_TO_REC709 * xyz;
		return rgb;
	}
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {
		vec3 I;
		float iridescenceIOR = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
		float sinTheta2Sq = pow2( outsideIOR / iridescenceIOR ) * ( 1.0 - pow2( cosTheta1 ) );
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {
			return vec3( 1.0 );
		}
		float cosTheta2 = sqrt( cosTheta2Sq );
		float R0 = IorToFresnel0( iridescenceIOR, outsideIOR );
		float R12 = F_Schlick( R0, 1.0, cosTheta1 );
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIOR < outsideIOR ) phi12 = PI;
		float phi21 = PI - phi12;
		vec3 baseIOR = Fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) );		vec3 R1 = IorToFresnel0( baseIOR, iridescenceIOR );
		vec3 R23 = F_Schlick( R1, 1.0, cosTheta2 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[ 0 ] < iridescenceIOR ) phi23[ 0 ] = PI;
		if ( baseIOR[ 1 ] < iridescenceIOR ) phi23[ 1 ] = PI;
		if ( baseIOR[ 2 ] < iridescenceIOR ) phi23[ 2 ] = PI;
		float OPD = 2.0 * iridescenceIOR * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = pow2( T121 ) * R23 / ( vec3( 1.0 ) - R123 );
		vec3 C0 = R12 + Rs;
		I = C0;
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {
			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;
		}
		return max( I, vec3( 0.0 ) );
	}
#endif`,lf=`#ifdef USE_BUMPMAP
	uniform sampler2D bumpMap;
	uniform float bumpScale;
	vec2 dHdxy_fwd() {
		vec2 dSTdx = dFdx( vBumpMapUv );
		vec2 dSTdy = dFdy( vBumpMapUv );
		float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;
		float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;
		float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;
		return vec2( dBx, dBy );
	}
	vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
		vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
		vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
		vec3 vN = surf_norm;
		vec3 R1 = cross( vSigmaY, vN );
		vec3 R2 = cross( vN, vSigmaX );
		float fDet = dot( vSigmaX, R1 ) * faceDirection;
		vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
		return normalize( abs( fDet ) * surf_norm - vGrad );
	}
#endif`,cf=`#if NUM_CLIPPING_PLANES > 0
	vec4 plane;
	#pragma unroll_loop_start
	for ( int i = 0; i < UNION_CLIPPING_PLANES; i ++ ) {
		plane = clippingPlanes[ i ];
		if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;
	}
	#pragma unroll_loop_end
	#if UNION_CLIPPING_PLANES < NUM_CLIPPING_PLANES
		bool clipped = true;
		#pragma unroll_loop_start
		for ( int i = UNION_CLIPPING_PLANES; i < NUM_CLIPPING_PLANES; i ++ ) {
			plane = clippingPlanes[ i ];
			clipped = ( dot( vClipPosition, plane.xyz ) > plane.w ) && clipped;
		}
		#pragma unroll_loop_end
		if ( clipped ) discard;
	#endif
#endif`,hf=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
	uniform vec4 clippingPlanes[ NUM_CLIPPING_PLANES ];
#endif`,uf=`#if NUM_CLIPPING_PLANES > 0
	varying vec3 vClipPosition;
#endif`,df=`#if NUM_CLIPPING_PLANES > 0
	vClipPosition = - mvPosition.xyz;
#endif`,ff=`#if defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor;
#elif defined( USE_COLOR )
	diffuseColor.rgb *= vColor;
#endif`,pf=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR )
	varying vec3 vColor;
#endif`,mf=`#if defined( USE_COLOR_ALPHA )
	varying vec4 vColor;
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	varying vec3 vColor;
#endif`,gf=`#if defined( USE_COLOR_ALPHA )
	vColor = vec4( 1.0 );
#elif defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
	vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
	vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.xyz *= instanceColor.xyz;
#endif`,_f=`#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define EPSILON 1e-6
#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
#define whiteComplement( a ) ( 1.0 - saturate( a ) )
float pow2( const in float x ) { return x*x; }
vec3 pow2( const in vec3 x ) { return x*x; }
float pow3( const in float x ) { return x*x*x; }
float pow4( const in float x ) { float x2 = x*x; return x2*x2; }
float max3( const in vec3 v ) { return max( max( v.x, v.y ), v.z ); }
float average( const in vec3 v ) { return dot( v, vec3( 0.3333333 ) ); }
highp float rand( const in vec2 uv ) {
	const highp float a = 12.9898, b = 78.233, c = 43758.5453;
	highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
	return fract( sin( sn ) * c );
}
#ifdef HIGH_PRECISION
	float precisionSafeLength( vec3 v ) { return length( v ); }
#else
	float precisionSafeLength( vec3 v ) {
		float maxComponent = max3( abs( v ) );
		return length( v / maxComponent ) * maxComponent;
	}
#endif
struct IncidentLight {
	vec3 color;
	vec3 direction;
	bool visible;
};
struct ReflectedLight {
	vec3 directDiffuse;
	vec3 directSpecular;
	vec3 indirectDiffuse;
	vec3 indirectSpecular;
};
#ifdef USE_ALPHAHASH
	varying vec3 vPosition;
#endif
vec3 transformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( matrix * vec4( dir, 0.0 ) ).xyz );
}
vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
	return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
}
mat3 transposeMat3( const in mat3 m ) {
	mat3 tmp;
	tmp[ 0 ] = vec3( m[ 0 ].x, m[ 1 ].x, m[ 2 ].x );
	tmp[ 1 ] = vec3( m[ 0 ].y, m[ 1 ].y, m[ 2 ].y );
	tmp[ 2 ] = vec3( m[ 0 ].z, m[ 1 ].z, m[ 2 ].z );
	return tmp;
}
float luminance( const in vec3 rgb ) {
	const vec3 weights = vec3( 0.2126729, 0.7151522, 0.0721750 );
	return dot( weights, rgb );
}
bool isPerspectiveMatrix( mat4 m ) {
	return m[ 2 ][ 3 ] == - 1.0;
}
vec2 equirectUv( in vec3 dir ) {
	float u = atan( dir.z, dir.x ) * RECIPROCAL_PI2 + 0.5;
	float v = asin( clamp( dir.y, - 1.0, 1.0 ) ) * RECIPROCAL_PI + 0.5;
	return vec2( u, v );
}
vec3 BRDF_Lambert( const in vec3 diffuseColor ) {
	return RECIPROCAL_PI * diffuseColor;
}
vec3 F_Schlick( const in vec3 f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
}
float F_Schlick( const in float f0, const in float f90, const in float dotVH ) {
	float fresnel = exp2( ( - 5.55473 * dotVH - 6.98316 ) * dotVH );
	return f0 * ( 1.0 - fresnel ) + ( f90 * fresnel );
} // validated`,xf=`#ifdef ENVMAP_TYPE_CUBE_UV
	#define cubeUV_minMipLevel 4.0
	#define cubeUV_minTileSize 16.0
	float getFace( vec3 direction ) {
		vec3 absDirection = abs( direction );
		float face = - 1.0;
		if ( absDirection.x > absDirection.z ) {
			if ( absDirection.x > absDirection.y )
				face = direction.x > 0.0 ? 0.0 : 3.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		} else {
			if ( absDirection.z > absDirection.y )
				face = direction.z > 0.0 ? 2.0 : 5.0;
			else
				face = direction.y > 0.0 ? 1.0 : 4.0;
		}
		return face;
	}
	vec2 getUV( vec3 direction, float face ) {
		vec2 uv;
		if ( face == 0.0 ) {
			uv = vec2( direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 1.0 ) {
			uv = vec2( - direction.x, - direction.z ) / abs( direction.y );
		} else if ( face == 2.0 ) {
			uv = vec2( - direction.x, direction.y ) / abs( direction.z );
		} else if ( face == 3.0 ) {
			uv = vec2( - direction.z, direction.y ) / abs( direction.x );
		} else if ( face == 4.0 ) {
			uv = vec2( - direction.x, direction.z ) / abs( direction.y );
		} else {
			uv = vec2( direction.x, direction.y ) / abs( direction.z );
		}
		return 0.5 * ( uv + 1.0 );
	}
	vec3 bilinearCubeUV( sampler2D envMap, vec3 direction, float mipInt ) {
		float face = getFace( direction );
		float filterInt = max( cubeUV_minMipLevel - mipInt, 0.0 );
		mipInt = max( mipInt, cubeUV_minMipLevel );
		float faceSize = exp2( mipInt );
		highp vec2 uv = getUV( direction, face ) * ( faceSize - 2.0 ) + 1.0;
		if ( face > 2.0 ) {
			uv.y += faceSize;
			face -= 3.0;
		}
		uv.x += face * faceSize;
		uv.x += filterInt * 3.0 * cubeUV_minTileSize;
		uv.y += 4.0 * ( exp2( CUBEUV_MAX_MIP ) - faceSize );
		uv.x *= CUBEUV_TEXEL_WIDTH;
		uv.y *= CUBEUV_TEXEL_HEIGHT;
		#ifdef texture2DGradEXT
			return texture2DGradEXT( envMap, uv, vec2( 0.0 ), vec2( 0.0 ) ).rgb;
		#else
			return texture2D( envMap, uv ).rgb;
		#endif
	}
	#define cubeUV_r0 1.0
	#define cubeUV_m0 - 2.0
	#define cubeUV_r1 0.8
	#define cubeUV_m1 - 1.0
	#define cubeUV_r4 0.4
	#define cubeUV_m4 2.0
	#define cubeUV_r5 0.305
	#define cubeUV_m5 3.0
	#define cubeUV_r6 0.21
	#define cubeUV_m6 4.0
	float roughnessToMip( float roughness ) {
		float mip = 0.0;
		if ( roughness >= cubeUV_r1 ) {
			mip = ( cubeUV_r0 - roughness ) * ( cubeUV_m1 - cubeUV_m0 ) / ( cubeUV_r0 - cubeUV_r1 ) + cubeUV_m0;
		} else if ( roughness >= cubeUV_r4 ) {
			mip = ( cubeUV_r1 - roughness ) * ( cubeUV_m4 - cubeUV_m1 ) / ( cubeUV_r1 - cubeUV_r4 ) + cubeUV_m1;
		} else if ( roughness >= cubeUV_r5 ) {
			mip = ( cubeUV_r4 - roughness ) * ( cubeUV_m5 - cubeUV_m4 ) / ( cubeUV_r4 - cubeUV_r5 ) + cubeUV_m4;
		} else if ( roughness >= cubeUV_r6 ) {
			mip = ( cubeUV_r5 - roughness ) * ( cubeUV_m6 - cubeUV_m5 ) / ( cubeUV_r5 - cubeUV_r6 ) + cubeUV_m5;
		} else {
			mip = - 2.0 * log2( 1.16 * roughness );		}
		return mip;
	}
	vec4 textureCubeUV( sampler2D envMap, vec3 sampleDir, float roughness ) {
		float mip = clamp( roughnessToMip( roughness ), cubeUV_m0, CUBEUV_MAX_MIP );
		float mipF = fract( mip );
		float mipInt = floor( mip );
		vec3 color0 = bilinearCubeUV( envMap, sampleDir, mipInt );
		if ( mipF == 0.0 ) {
			return vec4( color0, 1.0 );
		} else {
			vec3 color1 = bilinearCubeUV( envMap, sampleDir, mipInt + 1.0 );
			return vec4( mix( color0, color1, mipF ), 1.0 );
		}
	}
#endif`,vf=`vec3 transformedNormal = objectNormal;
#ifdef USE_TANGENT
	vec3 transformedTangent = objectTangent;
#endif
#ifdef USE_BATCHING
	mat3 bm = mat3( batchingMatrix );
	transformedNormal /= vec3( dot( bm[ 0 ], bm[ 0 ] ), dot( bm[ 1 ], bm[ 1 ] ), dot( bm[ 2 ], bm[ 2 ] ) );
	transformedNormal = bm * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = bm * transformedTangent;
	#endif
#endif
#ifdef USE_INSTANCING
	mat3 im = mat3( instanceMatrix );
	transformedNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	transformedNormal = im * transformedNormal;
	#ifdef USE_TANGENT
		transformedTangent = im * transformedTangent;
	#endif
#endif
transformedNormal = normalMatrix * transformedNormal;
#ifdef FLIP_SIDED
	transformedNormal = - transformedNormal;
#endif
#ifdef USE_TANGENT
	transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;
	#ifdef FLIP_SIDED
		transformedTangent = - transformedTangent;
	#endif
#endif`,yf=`#ifdef USE_DISPLACEMENTMAP
	uniform sampler2D displacementMap;
	uniform float displacementScale;
	uniform float displacementBias;
#endif`,Sf=`#ifdef USE_DISPLACEMENTMAP
	transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale + displacementBias );
#endif`,Mf=`#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif`,bf=`#ifdef USE_EMISSIVEMAP
	uniform sampler2D emissiveMap;
#endif`,Tf="gl_FragColor = linearToOutputTexel( gl_FragColor );",Af=`
const mat3 LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 = mat3(
	vec3( 0.8224621, 0.177538, 0.0 ),
	vec3( 0.0331941, 0.9668058, 0.0 ),
	vec3( 0.0170827, 0.0723974, 0.9105199 )
);
const mat3 LINEAR_DISPLAY_P3_TO_LINEAR_SRGB = mat3(
	vec3( 1.2249401, - 0.2249404, 0.0 ),
	vec3( - 0.0420569, 1.0420571, 0.0 ),
	vec3( - 0.0196376, - 0.0786361, 1.0982735 )
);
vec4 LinearSRGBToLinearDisplayP3( in vec4 value ) {
	return vec4( value.rgb * LINEAR_SRGB_TO_LINEAR_DISPLAY_P3, value.a );
}
vec4 LinearDisplayP3ToLinearSRGB( in vec4 value ) {
	return vec4( value.rgb * LINEAR_DISPLAY_P3_TO_LINEAR_SRGB, value.a );
}
vec4 LinearTransferOETF( in vec4 value ) {
	return value;
}
vec4 sRGBTransferOETF( in vec4 value ) {
	return vec4( mix( pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92, vec3( lessThanEqual( value.rgb, vec3( 0.0031308 ) ) ) ), value.a );
}
vec4 LinearToLinear( in vec4 value ) {
	return value;
}
vec4 LinearTosRGB( in vec4 value ) {
	return sRGBTransferOETF( value );
}`,Ef=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vec3 cameraToFrag;
		if ( isOrthographic ) {
			cameraToFrag = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToFrag = normalize( vWorldPosition - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( cameraToFrag, worldNormal );
		#else
			vec3 reflectVec = refract( cameraToFrag, worldNormal, refractionRatio );
		#endif
	#else
		vec3 reflectVec = vReflect;
	#endif
	#ifdef ENVMAP_TYPE_CUBE
		vec4 envColor = textureCube( envMap, vec3( flipEnvMap * reflectVec.x, reflectVec.yz ) );
	#else
		vec4 envColor = vec4( 0.0 );
	#endif
	#ifdef ENVMAP_BLENDING_MULTIPLY
		outgoingLight = mix( outgoingLight, outgoingLight * envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_MIX )
		outgoingLight = mix( outgoingLight, envColor.xyz, specularStrength * reflectivity );
	#elif defined( ENVMAP_BLENDING_ADD )
		outgoingLight += envColor.xyz * specularStrength * reflectivity;
	#endif
#endif`,wf=`#ifdef USE_ENVMAP
	uniform float envMapIntensity;
	uniform float flipEnvMap;
	#ifdef ENVMAP_TYPE_CUBE
		uniform samplerCube envMap;
	#else
		uniform sampler2D envMap;
	#endif
	
#endif`,Rf=`#ifdef USE_ENVMAP
	uniform float reflectivity;
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		varying vec3 vWorldPosition;
		uniform float refractionRatio;
	#else
		varying vec3 vReflect;
	#endif
#endif`,Cf=`#ifdef USE_ENVMAP
	#if defined( USE_BUMPMAP ) || defined( USE_NORMALMAP ) || defined( PHONG ) || defined( LAMBERT )
		#define ENV_WORLDPOS
	#endif
	#ifdef ENV_WORLDPOS
		
		varying vec3 vWorldPosition;
	#else
		varying vec3 vReflect;
		uniform float refractionRatio;
	#endif
#endif`,Pf=`#ifdef USE_ENVMAP
	#ifdef ENV_WORLDPOS
		vWorldPosition = worldPosition.xyz;
	#else
		vec3 cameraToVertex;
		if ( isOrthographic ) {
			cameraToVertex = normalize( vec3( - viewMatrix[ 0 ][ 2 ], - viewMatrix[ 1 ][ 2 ], - viewMatrix[ 2 ][ 2 ] ) );
		} else {
			cameraToVertex = normalize( worldPosition.xyz - cameraPosition );
		}
		vec3 worldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
		#ifdef ENVMAP_MODE_REFLECTION
			vReflect = reflect( cameraToVertex, worldNormal );
		#else
			vReflect = refract( cameraToVertex, worldNormal, refractionRatio );
		#endif
	#endif
#endif`,Lf=`#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
#endif`,If=`#ifdef USE_FOG
	varying float vFogDepth;
#endif`,Nf=`#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`,Df=`#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`,Uf=`#ifdef USE_GRADIENTMAP
	uniform sampler2D gradientMap;
#endif
vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
	float dotNL = dot( normal, lightDirection );
	vec2 coord = vec2( dotNL * 0.5 + 0.5, 0.0 );
	#ifdef USE_GRADIENTMAP
		return vec3( texture2D( gradientMap, coord ).r );
	#else
		vec2 fw = fwidth( coord ) * 0.5;
		return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
	#endif
}`,Ff=`#ifdef USE_LIGHTMAP
	vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
	vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
	reflectedLight.indirectDiffuse += lightMapIrradiance;
#endif`,Of=`#ifdef USE_LIGHTMAP
	uniform sampler2D lightMap;
	uniform float lightMapIntensity;
#endif`,Bf=`LambertMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularStrength = specularStrength;`,zf=`varying vec3 vViewPosition;
struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Lambert
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert`,kf=`uniform bool receiveShadow;
uniform vec3 ambientLightColor;
#if defined( USE_LIGHT_PROBES )
	uniform vec3 lightProbe[ 9 ];
#endif
vec3 shGetIrradianceAt( in vec3 normal, in vec3 shCoefficients[ 9 ] ) {
	float x = normal.x, y = normal.y, z = normal.z;
	vec3 result = shCoefficients[ 0 ] * 0.886227;
	result += shCoefficients[ 1 ] * 2.0 * 0.511664 * y;
	result += shCoefficients[ 2 ] * 2.0 * 0.511664 * z;
	result += shCoefficients[ 3 ] * 2.0 * 0.511664 * x;
	result += shCoefficients[ 4 ] * 2.0 * 0.429043 * x * y;
	result += shCoefficients[ 5 ] * 2.0 * 0.429043 * y * z;
	result += shCoefficients[ 6 ] * ( 0.743125 * z * z - 0.247708 );
	result += shCoefficients[ 7 ] * 2.0 * 0.429043 * x * z;
	result += shCoefficients[ 8 ] * 0.429043 * ( x * x - y * y );
	return result;
}
vec3 getLightProbeIrradiance( const in vec3 lightProbe[ 9 ], const in vec3 normal ) {
	vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
	vec3 irradiance = shGetIrradianceAt( worldNormal, lightProbe );
	return irradiance;
}
vec3 getAmbientLightIrradiance( const in vec3 ambientLightColor ) {
	vec3 irradiance = ambientLightColor;
	return irradiance;
}
float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {
	#if defined ( LEGACY_LIGHTS )
		if ( cutoffDistance > 0.0 && decayExponent > 0.0 ) {
			return pow( saturate( - lightDistance / cutoffDistance + 1.0 ), decayExponent );
		}
		return 1.0;
	#else
		float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
		if ( cutoffDistance > 0.0 ) {
			distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );
		}
		return distanceFalloff;
	#endif
}
float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {
	return smoothstep( coneCosine, penumbraCosine, angleCosine );
}
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
	void getDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
		light.color = directionalLight.color;
		light.direction = directionalLight.direction;
		light.visible = true;
	}
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = pointLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float lightDistance = length( lVector );
		light.color = pointLight.color;
		light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );
		light.visible = ( light.color != vec3( 0.0 ) );
	}
#endif
#if NUM_SPOT_LIGHTS > 0
	struct SpotLight {
		vec3 position;
		vec3 direction;
		vec3 color;
		float distance;
		float decay;
		float coneCos;
		float penumbraCos;
	};
	uniform SpotLight spotLights[ NUM_SPOT_LIGHTS ];
	void getSpotLightInfo( const in SpotLight spotLight, const in vec3 geometryPosition, out IncidentLight light ) {
		vec3 lVector = spotLight.position - geometryPosition;
		light.direction = normalize( lVector );
		float angleCos = dot( light.direction, spotLight.direction );
		float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );
		if ( spotAttenuation > 0.0 ) {
			float lightDistance = length( lVector );
			light.color = spotLight.color * spotAttenuation;
			light.color *= getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay );
			light.visible = ( light.color != vec3( 0.0 ) );
		} else {
			light.color = vec3( 0.0 );
			light.visible = false;
		}
	}
#endif
#if NUM_RECT_AREA_LIGHTS > 0
	struct RectAreaLight {
		vec3 color;
		vec3 position;
		vec3 halfWidth;
		vec3 halfHeight;
	};
	uniform sampler2D ltc_1;	uniform sampler2D ltc_2;
	uniform RectAreaLight rectAreaLights[ NUM_RECT_AREA_LIGHTS ];
#endif
#if NUM_HEMI_LIGHTS > 0
	struct HemisphereLight {
		vec3 direction;
		vec3 skyColor;
		vec3 groundColor;
	};
	uniform HemisphereLight hemisphereLights[ NUM_HEMI_LIGHTS ];
	vec3 getHemisphereLightIrradiance( const in HemisphereLight hemiLight, const in vec3 normal ) {
		float dotNL = dot( normal, hemiLight.direction );
		float hemiDiffuseWeight = 0.5 * dotNL + 0.5;
		vec3 irradiance = mix( hemiLight.groundColor, hemiLight.skyColor, hemiDiffuseWeight );
		return irradiance;
	}
#endif`,Gf=`#ifdef USE_ENVMAP
	vec3 getIBLIrradiance( const in vec3 normal ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
			return PI * envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness ) {
		#ifdef ENVMAP_TYPE_CUBE_UV
			vec3 reflectVec = reflect( - viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
			reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
			return envMapColor.rgb * envMapIntensity;
		#else
			return vec3( 0.0 );
		#endif
	}
	#ifdef USE_ANISOTROPY
		vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy ) {
			#ifdef ENVMAP_TYPE_CUBE_UV
				vec3 bentNormal = cross( bitangent, viewDir );
				bentNormal = normalize( cross( bentNormal, bitangent ) );
				bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
				return getIBLRadiance( viewDir, bentNormal, roughness );
			#else
				return vec3( 0.0 );
			#endif
		}
	#endif
#endif`,Hf=`ToonMaterial material;
material.diffuseColor = diffuseColor.rgb;`,Wf=`varying vec3 vViewPosition;
struct ToonMaterial {
	vec3 diffuseColor;
};
void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in ToonMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_Toon
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Toon`,Vf=`BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
material.specularColor = specular;
material.specularShininess = shininess;
material.specularStrength = specularStrength;`,Xf=`varying vec3 vViewPosition;
struct BlinnPhongMaterial {
	vec3 diffuseColor;
	vec3 specularColor;
	float specularShininess;
	float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct				RE_Direct_BlinnPhong
#define RE_IndirectDiffuse		RE_IndirectDiffuse_BlinnPhong`,qf=`PhysicalMaterial material;
material.diffuseColor = diffuseColor.rgb * ( 1.0 - metalnessFactor );
vec3 dxy = max( abs( dFdx( nonPerturbedNormal ) ), abs( dFdy( nonPerturbedNormal ) ) );
float geometryRoughness = max( max( dxy.x, dxy.y ), dxy.z );
material.roughness = max( roughnessFactor, 0.0525 );material.roughness += geometryRoughness;
material.roughness = min( material.roughness, 1.0 );
#ifdef IOR
	material.ior = ior;
	#ifdef USE_SPECULAR
		float specularIntensityFactor = specularIntensity;
		vec3 specularColorFactor = specularColor;
		#ifdef USE_SPECULAR_COLORMAP
			specularColorFactor *= texture2D( specularColorMap, vSpecularColorMapUv ).rgb;
		#endif
		#ifdef USE_SPECULAR_INTENSITYMAP
			specularIntensityFactor *= texture2D( specularIntensityMap, vSpecularIntensityMapUv ).a;
		#endif
		material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );
	#else
		float specularIntensityFactor = 1.0;
		vec3 specularColorFactor = vec3( 1.0 );
		material.specularF90 = 1.0;
	#endif
	material.specularColor = mix( min( pow2( ( material.ior - 1.0 ) / ( material.ior + 1.0 ) ) * specularColorFactor, vec3( 1.0 ) ) * specularIntensityFactor, diffuseColor.rgb, metalnessFactor );
#else
	material.specularColor = mix( vec3( 0.04 ), diffuseColor.rgb, metalnessFactor );
	material.specularF90 = 1.0;
#endif
#ifdef USE_CLEARCOAT
	material.clearcoat = clearcoat;
	material.clearcoatRoughness = clearcoatRoughness;
	material.clearcoatF0 = vec3( 0.04 );
	material.clearcoatF90 = 1.0;
	#ifdef USE_CLEARCOATMAP
		material.clearcoat *= texture2D( clearcoatMap, vClearcoatMapUv ).x;
	#endif
	#ifdef USE_CLEARCOAT_ROUGHNESSMAP
		material.clearcoatRoughness *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
	#endif
	material.clearcoat = saturate( material.clearcoat );	material.clearcoatRoughness = max( material.clearcoatRoughness, 0.0525 );
	material.clearcoatRoughness += geometryRoughness;
	material.clearcoatRoughness = min( material.clearcoatRoughness, 1.0 );
#endif
#ifdef USE_IRIDESCENCE
	material.iridescence = iridescence;
	material.iridescenceIOR = iridescenceIOR;
	#ifdef USE_IRIDESCENCEMAP
		material.iridescence *= texture2D( iridescenceMap, vIridescenceMapUv ).r;
	#endif
	#ifdef USE_IRIDESCENCE_THICKNESSMAP
		material.iridescenceThickness = (iridescenceThicknessMaximum - iridescenceThicknessMinimum) * texture2D( iridescenceThicknessMap, vIridescenceThicknessMapUv ).g + iridescenceThicknessMinimum;
	#else
		material.iridescenceThickness = iridescenceThicknessMaximum;
	#endif
#endif
#ifdef USE_SHEEN
	material.sheenColor = sheenColor;
	#ifdef USE_SHEEN_COLORMAP
		material.sheenColor *= texture2D( sheenColorMap, vSheenColorMapUv ).rgb;
	#endif
	material.sheenRoughness = clamp( sheenRoughness, 0.07, 1.0 );
	#ifdef USE_SHEEN_ROUGHNESSMAP
		material.sheenRoughness *= texture2D( sheenRoughnessMap, vSheenRoughnessMapUv ).a;
	#endif
#endif
#ifdef USE_ANISOTROPY
	#ifdef USE_ANISOTROPYMAP
		mat2 anisotropyMat = mat2( anisotropyVector.x, anisotropyVector.y, - anisotropyVector.y, anisotropyVector.x );
		vec3 anisotropyPolar = texture2D( anisotropyMap, vAnisotropyMapUv ).rgb;
		vec2 anisotropyV = anisotropyMat * normalize( 2.0 * anisotropyPolar.rg - vec2( 1.0 ) ) * anisotropyPolar.b;
	#else
		vec2 anisotropyV = anisotropyVector;
	#endif
	material.anisotropy = length( anisotropyV );
	if( material.anisotropy == 0.0 ) {
		anisotropyV = vec2( 1.0, 0.0 );
	} else {
		anisotropyV /= material.anisotropy;
		material.anisotropy = saturate( material.anisotropy );
	}
	material.alphaT = mix( pow2( material.roughness ), 1.0, pow2( material.anisotropy ) );
	material.anisotropyT = tbn[ 0 ] * anisotropyV.x + tbn[ 1 ] * anisotropyV.y;
	material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
#endif`,Yf=`struct PhysicalMaterial {
	vec3 diffuseColor;
	float roughness;
	vec3 specularColor;
	float specularF90;
	#ifdef USE_CLEARCOAT
		float clearcoat;
		float clearcoatRoughness;
		vec3 clearcoatF0;
		float clearcoatF90;
	#endif
	#ifdef USE_IRIDESCENCE
		float iridescence;
		float iridescenceIOR;
		float iridescenceThickness;
		vec3 iridescenceFresnel;
		vec3 iridescenceF0;
	#endif
	#ifdef USE_SHEEN
		vec3 sheenColor;
		float sheenRoughness;
	#endif
	#ifdef IOR
		float ior;
	#endif
	#ifdef USE_TRANSMISSION
		float transmission;
		float transmissionAlpha;
		float thickness;
		float attenuationDistance;
		vec3 attenuationColor;
	#endif
	#ifdef USE_ANISOTROPY
		float anisotropy;
		float alphaT;
		vec3 anisotropyT;
		vec3 anisotropyB;
	#endif
};
vec3 clearcoatSpecularDirect = vec3( 0.0 );
vec3 clearcoatSpecularIndirect = vec3( 0.0 );
vec3 sheenSpecularDirect = vec3( 0.0 );
vec3 sheenSpecularIndirect = vec3(0.0 );
vec3 Schlick_to_F0( const in vec3 f, const in float f90, const in float dotVH ) {
    float x = clamp( 1.0 - dotVH, 0.0, 1.0 );
    float x2 = x * x;
    float x5 = clamp( x * x2 * x2, 0.0, 0.9999 );
    return ( f - vec3( f90 ) * x5 ) / ( 1.0 - x5 );
}
float V_GGX_SmithCorrelated( const in float alpha, const in float dotNL, const in float dotNV ) {
	float a2 = pow2( alpha );
	float gv = dotNL * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNV ) );
	float gl = dotNV * sqrt( a2 + ( 1.0 - a2 ) * pow2( dotNL ) );
	return 0.5 / max( gv + gl, EPSILON );
}
float D_GGX( const in float alpha, const in float dotNH ) {
	float a2 = pow2( alpha );
	float denom = pow2( dotNH ) * ( a2 - 1.0 ) + 1.0;
	return RECIPROCAL_PI * a2 / pow2( denom );
}
#ifdef USE_ANISOTROPY
	float V_GGX_SmithCorrelated_Anisotropic( const in float alphaT, const in float alphaB, const in float dotTV, const in float dotBV, const in float dotTL, const in float dotBL, const in float dotNV, const in float dotNL ) {
		float gv = dotNL * length( vec3( alphaT * dotTV, alphaB * dotBV, dotNV ) );
		float gl = dotNV * length( vec3( alphaT * dotTL, alphaB * dotBL, dotNL ) );
		float v = 0.5 / ( gv + gl );
		return saturate(v);
	}
	float D_GGX_Anisotropic( const in float alphaT, const in float alphaB, const in float dotNH, const in float dotTH, const in float dotBH ) {
		float a2 = alphaT * alphaB;
		highp vec3 v = vec3( alphaB * dotTH, alphaT * dotBH, a2 * dotNH );
		highp float v2 = dot( v, v );
		float w2 = a2 / v2;
		return RECIPROCAL_PI * a2 * pow2 ( w2 );
	}
#endif
#ifdef USE_CLEARCOAT
	vec3 BRDF_GGX_Clearcoat( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material) {
		vec3 f0 = material.clearcoatF0;
		float f90 = material.clearcoatF90;
		float roughness = material.clearcoatRoughness;
		float alpha = pow2( roughness );
		vec3 halfDir = normalize( lightDir + viewDir );
		float dotNL = saturate( dot( normal, lightDir ) );
		float dotNV = saturate( dot( normal, viewDir ) );
		float dotNH = saturate( dot( normal, halfDir ) );
		float dotVH = saturate( dot( viewDir, halfDir ) );
		vec3 F = F_Schlick( f0, f90, dotVH );
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
		return F * ( V * D );
	}
#endif
vec3 BRDF_GGX( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, const in PhysicalMaterial material ) {
	vec3 f0 = material.specularColor;
	float f90 = material.specularF90;
	float roughness = material.roughness;
	float alpha = pow2( roughness );
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float dotVH = saturate( dot( viewDir, halfDir ) );
	vec3 F = F_Schlick( f0, f90, dotVH );
	#ifdef USE_IRIDESCENCE
		F = mix( F, material.iridescenceFresnel, material.iridescence );
	#endif
	#ifdef USE_ANISOTROPY
		float dotTL = dot( material.anisotropyT, lightDir );
		float dotTV = dot( material.anisotropyT, viewDir );
		float dotTH = dot( material.anisotropyT, halfDir );
		float dotBL = dot( material.anisotropyB, lightDir );
		float dotBV = dot( material.anisotropyB, viewDir );
		float dotBH = dot( material.anisotropyB, halfDir );
		float V = V_GGX_SmithCorrelated_Anisotropic( material.alphaT, alpha, dotTV, dotBV, dotTL, dotBL, dotNV, dotNL );
		float D = D_GGX_Anisotropic( material.alphaT, alpha, dotNH, dotTH, dotBH );
	#else
		float V = V_GGX_SmithCorrelated( alpha, dotNL, dotNV );
		float D = D_GGX( alpha, dotNH );
	#endif
	return F * ( V * D );
}
vec2 LTC_Uv( const in vec3 N, const in vec3 V, const in float roughness ) {
	const float LUT_SIZE = 64.0;
	const float LUT_SCALE = ( LUT_SIZE - 1.0 ) / LUT_SIZE;
	const float LUT_BIAS = 0.5 / LUT_SIZE;
	float dotNV = saturate( dot( N, V ) );
	vec2 uv = vec2( roughness, sqrt( 1.0 - dotNV ) );
	uv = uv * LUT_SCALE + LUT_BIAS;
	return uv;
}
float LTC_ClippedSphereFormFactor( const in vec3 f ) {
	float l = length( f );
	return max( ( l * l + f.z ) / ( l + 1.0 ), 0.0 );
}
vec3 LTC_EdgeVectorFormFactor( const in vec3 v1, const in vec3 v2 ) {
	float x = dot( v1, v2 );
	float y = abs( x );
	float a = 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y;
	float b = 3.4175940 + ( 4.1616724 + y ) * y;
	float v = a / b;
	float theta_sintheta = ( x > 0.0 ) ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( v1, v2 ) * theta_sintheta;
}
vec3 LTC_Evaluate( const in vec3 N, const in vec3 V, const in vec3 P, const in mat3 mInv, const in vec3 rectCoords[ 4 ] ) {
	vec3 v1 = rectCoords[ 1 ] - rectCoords[ 0 ];
	vec3 v2 = rectCoords[ 3 ] - rectCoords[ 0 ];
	vec3 lightNormal = cross( v1, v2 );
	if( dot( lightNormal, P - rectCoords[ 0 ] ) < 0.0 ) return vec3( 0.0 );
	vec3 T1, T2;
	T1 = normalize( V - N * dot( V, N ) );
	T2 = - cross( N, T1 );
	mat3 mat = mInv * transposeMat3( mat3( T1, T2, N ) );
	vec3 coords[ 4 ];
	coords[ 0 ] = mat * ( rectCoords[ 0 ] - P );
	coords[ 1 ] = mat * ( rectCoords[ 1 ] - P );
	coords[ 2 ] = mat * ( rectCoords[ 2 ] - P );
	coords[ 3 ] = mat * ( rectCoords[ 3 ] - P );
	coords[ 0 ] = normalize( coords[ 0 ] );
	coords[ 1 ] = normalize( coords[ 1 ] );
	coords[ 2 ] = normalize( coords[ 2 ] );
	coords[ 3 ] = normalize( coords[ 3 ] );
	vec3 vectorFormFactor = vec3( 0.0 );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 0 ], coords[ 1 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 1 ], coords[ 2 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 2 ], coords[ 3 ] );
	vectorFormFactor += LTC_EdgeVectorFormFactor( coords[ 3 ], coords[ 0 ] );
	float result = LTC_ClippedSphereFormFactor( vectorFormFactor );
	return vec3( result );
}
#if defined( USE_SHEEN )
float D_Charlie( float roughness, float dotNH ) {
	float alpha = pow2( roughness );
	float invAlpha = 1.0 / alpha;
	float cos2h = dotNH * dotNH;
	float sin2h = max( 1.0 - cos2h, 0.0078125 );
	return ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
}
float V_Neubelt( float dotNV, float dotNL ) {
	return saturate( 1.0 / ( 4.0 * ( dotNL + dotNV - dotNL * dotNV ) ) );
}
vec3 BRDF_Sheen( const in vec3 lightDir, const in vec3 viewDir, const in vec3 normal, vec3 sheenColor, const in float sheenRoughness ) {
	vec3 halfDir = normalize( lightDir + viewDir );
	float dotNL = saturate( dot( normal, lightDir ) );
	float dotNV = saturate( dot( normal, viewDir ) );
	float dotNH = saturate( dot( normal, halfDir ) );
	float D = D_Charlie( sheenRoughness, dotNH );
	float V = V_Neubelt( dotNV, dotNL );
	return sheenColor * ( D * V );
}
#endif
float IBLSheenBRDF( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	float r2 = roughness * roughness;
	float a = roughness < 0.25 ? -339.2 * r2 + 161.4 * roughness - 25.9 : -8.48 * r2 + 14.3 * roughness - 9.95;
	float b = roughness < 0.25 ? 44.0 * r2 - 23.7 * roughness + 3.26 : 1.97 * r2 - 3.27 * roughness + 0.72;
	float DG = exp( a * dotNV + b ) + ( roughness < 0.25 ? 0.0 : 0.1 * ( roughness - 0.25 ) );
	return saturate( DG * RECIPROCAL_PI );
}
vec2 DFGApprox( const in vec3 normal, const in vec3 viewDir, const in float roughness ) {
	float dotNV = saturate( dot( normal, viewDir ) );
	const vec4 c0 = vec4( - 1, - 0.0275, - 0.572, 0.022 );
	const vec4 c1 = vec4( 1, 0.0425, 1.04, - 0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( - 9.28 * dotNV ) ) * r.x + r.y;
	vec2 fab = vec2( - 1.04, 1.04 ) * a004 + r.zw;
	return fab;
}
vec3 EnvironmentBRDF( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness ) {
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	return specularColor * fab.x + specularF90 * fab.y;
}
#ifdef USE_IRIDESCENCE
void computeMultiscatteringIridescence( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float iridescence, const in vec3 iridescenceF0, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#else
void computeMultiscattering( const in vec3 normal, const in vec3 viewDir, const in vec3 specularColor, const in float specularF90, const in float roughness, inout vec3 singleScatter, inout vec3 multiScatter ) {
#endif
	vec2 fab = DFGApprox( normal, viewDir, roughness );
	#ifdef USE_IRIDESCENCE
		vec3 Fr = mix( specularColor, iridescenceF0, iridescence );
	#else
		vec3 Fr = specularColor;
	#endif
	vec3 FssEss = Fr * fab.x + specularF90 * fab.y;
	float Ess = fab.x + fab.y;
	float Ems = 1.0 - Ess;
	vec3 Favg = Fr + ( 1.0 - Fr ) * 0.047619;	vec3 Fms = FssEss * Favg / ( 1.0 - Ems * Favg );
	singleScatter += FssEss;
	multiScatter += Fms * Ems;
}
#if NUM_RECT_AREA_LIGHTS > 0
	void RE_Direct_RectArea_Physical( const in RectAreaLight rectAreaLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
		vec3 normal = geometryNormal;
		vec3 viewDir = geometryViewDir;
		vec3 position = geometryPosition;
		vec3 lightPos = rectAreaLight.position;
		vec3 halfWidth = rectAreaLight.halfWidth;
		vec3 halfHeight = rectAreaLight.halfHeight;
		vec3 lightColor = rectAreaLight.color;
		float roughness = material.roughness;
		vec3 rectCoords[ 4 ];
		rectCoords[ 0 ] = lightPos + halfWidth - halfHeight;		rectCoords[ 1 ] = lightPos - halfWidth - halfHeight;
		rectCoords[ 2 ] = lightPos - halfWidth + halfHeight;
		rectCoords[ 3 ] = lightPos + halfWidth + halfHeight;
		vec2 uv = LTC_Uv( normal, viewDir, roughness );
		vec4 t1 = texture2D( ltc_1, uv );
		vec4 t2 = texture2D( ltc_2, uv );
		mat3 mInv = mat3(
			vec3( t1.x, 0, t1.y ),
			vec3(    0, 1,    0 ),
			vec3( t1.z, 0, t1.w )
		);
		vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
		reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
		reflectedLight.directDiffuse += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
	}
#endif
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	vec3 irradiance = dotNL * directLight.color;
	#ifdef USE_CLEARCOAT
		float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );
		vec3 ccIrradiance = dotNLcc * directLight.color;
		clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );
	#endif
	reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Physical( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectSpecular_Physical( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
	#ifdef USE_CLEARCOAT
		clearcoatSpecularIndirect += clearcoatRadiance * EnvironmentBRDF( geometryClearcoatNormal, geometryViewDir, material.clearcoatF0, material.clearcoatF90, material.clearcoatRoughness );
	#endif
	#ifdef USE_SHEEN
		sheenSpecularIndirect += irradiance * material.sheenColor * IBLSheenBRDF( geometryNormal, geometryViewDir, material.sheenRoughness );
	#endif
	vec3 singleScattering = vec3( 0.0 );
	vec3 multiScattering = vec3( 0.0 );
	vec3 cosineWeightedIrradiance = irradiance * RECIPROCAL_PI;
	#ifdef USE_IRIDESCENCE
		computeMultiscatteringIridescence( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.iridescence, material.iridescenceFresnel, material.roughness, singleScattering, multiScattering );
	#else
		computeMultiscattering( geometryNormal, geometryViewDir, material.specularColor, material.specularF90, material.roughness, singleScattering, multiScattering );
	#endif
	vec3 totalScattering = singleScattering + multiScattering;
	vec3 diffuse = material.diffuseColor * ( 1.0 - max( max( totalScattering.r, totalScattering.g ), totalScattering.b ) );
	reflectedLight.indirectSpecular += radiance * singleScattering;
	reflectedLight.indirectSpecular += multiScattering * cosineWeightedIrradiance;
	reflectedLight.indirectDiffuse += diffuse * cosineWeightedIrradiance;
}
#define RE_Direct				RE_Direct_Physical
#define RE_Direct_RectArea		RE_Direct_RectArea_Physical
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Physical
#define RE_IndirectSpecular		RE_IndirectSpecular_Physical
float computeSpecularOcclusion( const in float dotNV, const in float ambientOcclusion, const in float roughness ) {
	return saturate( pow( dotNV + ambientOcclusion, exp2( - 16.0 * roughness - 1.0 ) ) - 1.0 + ambientOcclusion );
}`,Zf=`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
#ifdef USE_CLEARCOAT
	geometryClearcoatNormal = clearcoatNormal;
#endif
#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif
IncidentLight directLight;
#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )
	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
		pointLight = pointLights[ i ];
		getPointLightInfo( pointLight, geometryPosition, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )
	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;
	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
		spotLight = spotLights[ i ];
		getSpotLightInfo( spotLight, geometryPosition, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )
	RectAreaLight rectAreaLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {
		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if defined( RE_IndirectDiffuse )
	vec3 iblIrradiance = vec3( 0.0 );
	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
	#if defined( USE_LIGHT_PROBES )
		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );
	#endif
	#if ( NUM_HEMI_LIGHTS > 0 )
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
		}
		#pragma unroll_loop_end
	#endif
#endif
#if defined( RE_IndirectSpecular )
	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );
#endif`,Kf=`#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;
		irradiance += lightMapIrradiance;
	#endif
	#if defined( USE_ENVMAP ) && defined( STANDARD ) && defined( ENVMAP_TYPE_CUBE_UV )
		iblIrradiance += getIBLIrradiance( geometryNormal );
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	#ifdef USE_ANISOTROPY
		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );
	#else
		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#endif
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif`,Jf=`#if defined( RE_IndirectDiffuse )
	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif
#if defined( RE_IndirectSpecular )
	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
#endif`,$f=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	gl_FragDepthEXT = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif`,jf=`#if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
	uniform float logDepthBufFC;
	varying float vFragDepth;
	varying float vIsPerspective;
#endif`,Qf=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		varying float vFragDepth;
		varying float vIsPerspective;
	#else
		uniform float logDepthBufFC;
	#endif
#endif`,ep=`#ifdef USE_LOGDEPTHBUF
	#ifdef USE_LOGDEPTHBUF_EXT
		vFragDepth = 1.0 + gl_Position.w;
		vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
	#else
		if ( isPerspectiveMatrix( projectionMatrix ) ) {
			gl_Position.z = log2( max( EPSILON, gl_Position.w + 1.0 ) ) * logDepthBufFC - 1.0;
			gl_Position.z *= gl_Position.w;
		}
	#endif
#endif`,tp=`#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = vec4( mix( pow( sampledDiffuseColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), sampledDiffuseColor.rgb * 0.0773993808, vec3( lessThanEqual( sampledDiffuseColor.rgb, vec3( 0.04045 ) ) ) ), sampledDiffuseColor.w );
	
	#endif
	diffuseColor *= sampledDiffuseColor;
#endif`,np=`#ifdef USE_MAP
	uniform sampler2D map;
#endif`,ip=`#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
	#if defined( USE_POINTS_UV )
		vec2 uv = vUv;
	#else
		vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;
	#endif
#endif
#ifdef USE_MAP
	diffuseColor *= texture2D( map, uv );
#endif
#ifdef USE_ALPHAMAP
	diffuseColor.a *= texture2D( alphaMap, uv ).g;
#endif`,sp=`#if defined( USE_POINTS_UV )
	varying vec2 vUv;
#else
	#if defined( USE_MAP ) || defined( USE_ALPHAMAP )
		uniform mat3 uvTransform;
	#endif
#endif
#ifdef USE_MAP
	uniform sampler2D map;
#endif
#ifdef USE_ALPHAMAP
	uniform sampler2D alphaMap;
#endif`,rp=`float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
	metalnessFactor *= texelMetalness.b;
#endif`,ap=`#ifdef USE_METALNESSMAP
	uniform sampler2D metalnessMap;
#endif`,op=`#if defined( USE_MORPHCOLORS ) && defined( MORPHTARGETS_TEXTURE )
	vColor *= morphTargetBaseInfluence;
	for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
		#if defined( USE_COLOR_ALPHA )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ) * morphTargetInfluences[ i ];
		#elif defined( USE_COLOR )
			if ( morphTargetInfluences[ i ] != 0.0 ) vColor += getMorph( gl_VertexID, i, 2 ).rgb * morphTargetInfluences[ i ];
		#endif
	}
#endif`,lp=`#ifdef USE_MORPHNORMALS
	objectNormal *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) objectNormal += getMorph( gl_VertexID, i, 1 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		objectNormal += morphNormal0 * morphTargetInfluences[ 0 ];
		objectNormal += morphNormal1 * morphTargetInfluences[ 1 ];
		objectNormal += morphNormal2 * morphTargetInfluences[ 2 ];
		objectNormal += morphNormal3 * morphTargetInfluences[ 3 ];
	#endif
#endif`,cp=`#ifdef USE_MORPHTARGETS
	uniform float morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		uniform float morphTargetInfluences[ MORPHTARGETS_COUNT ];
		uniform sampler2DArray morphTargetsTexture;
		uniform ivec2 morphTargetsTextureSize;
		vec4 getMorph( const in int vertexIndex, const in int morphTargetIndex, const in int offset ) {
			int texelIndex = vertexIndex * MORPHTARGETS_TEXTURE_STRIDE + offset;
			int y = texelIndex / morphTargetsTextureSize.x;
			int x = texelIndex - y * morphTargetsTextureSize.x;
			ivec3 morphUV = ivec3( x, y, morphTargetIndex );
			return texelFetch( morphTargetsTexture, morphUV, 0 );
		}
	#else
		#ifndef USE_MORPHNORMALS
			uniform float morphTargetInfluences[ 8 ];
		#else
			uniform float morphTargetInfluences[ 4 ];
		#endif
	#endif
#endif`,hp=`#ifdef USE_MORPHTARGETS
	transformed *= morphTargetBaseInfluence;
	#ifdef MORPHTARGETS_TEXTURE
		for ( int i = 0; i < MORPHTARGETS_COUNT; i ++ ) {
			if ( morphTargetInfluences[ i ] != 0.0 ) transformed += getMorph( gl_VertexID, i, 0 ).xyz * morphTargetInfluences[ i ];
		}
	#else
		transformed += morphTarget0 * morphTargetInfluences[ 0 ];
		transformed += morphTarget1 * morphTargetInfluences[ 1 ];
		transformed += morphTarget2 * morphTargetInfluences[ 2 ];
		transformed += morphTarget3 * morphTargetInfluences[ 3 ];
		#ifndef USE_MORPHNORMALS
			transformed += morphTarget4 * morphTargetInfluences[ 4 ];
			transformed += morphTarget5 * morphTargetInfluences[ 5 ];
			transformed += morphTarget6 * morphTargetInfluences[ 6 ];
			transformed += morphTarget7 * morphTargetInfluences[ 7 ];
		#endif
	#endif
#endif`,up=`float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
#ifdef FLAT_SHADED
	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );
#else
	vec3 normal = normalize( vNormal );
	#ifdef DOUBLE_SIDED
		normal *= faceDirection;
	#endif
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )
	#ifdef USE_TANGENT
		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;
	#endif
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	#ifdef USE_TANGENT
		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );
	#else
		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );
	#endif
	#if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;
	#endif
#endif
vec3 nonPerturbedNormal = normal;`,dp=`#ifdef USE_NORMALMAP_OBJECTSPACE
	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef FLIP_SIDED
		normal = - normal;
	#endif
	#ifdef DOUBLE_SIDED
		normal = normal * faceDirection;
	#endif
	normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif`,fp=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,pp=`#ifndef FLAT_SHADED
	varying vec3 vNormal;
	#ifdef USE_TANGENT
		varying vec3 vTangent;
		varying vec3 vBitangent;
	#endif
#endif`,mp=`#ifndef FLAT_SHADED
	vNormal = normalize( transformedNormal );
	#ifdef USE_TANGENT
		vTangent = normalize( transformedTangent );
		vBitangent = normalize( cross( vNormal, vTangent ) * tangent.w );
	#endif
#endif`,gp=`#ifdef USE_NORMALMAP
	uniform sampler2D normalMap;
	uniform vec2 normalScale;
#endif
#ifdef USE_NORMALMAP_OBJECTSPACE
	uniform mat3 normalMatrix;
#endif
#if ! defined ( USE_TANGENT ) && ( defined ( USE_NORMALMAP_TANGENTSPACE ) || defined ( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY ) )
	mat3 getTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
		vec3 q0 = dFdx( eye_pos.xyz );
		vec3 q1 = dFdy( eye_pos.xyz );
		vec2 st0 = dFdx( uv.st );
		vec2 st1 = dFdy( uv.st );
		vec3 N = surf_norm;
		vec3 q1perp = cross( q1, N );
		vec3 q0perp = cross( N, q0 );
		vec3 T = q1perp * st0.x + q0perp * st1.x;
		vec3 B = q1perp * st0.y + q0perp * st1.y;
		float det = max( dot( T, T ), dot( B, B ) );
		float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
		return mat3( T * scale, B * scale, N );
	}
#endif`,_p=`#ifdef USE_CLEARCOAT
	vec3 clearcoatNormal = nonPerturbedNormal;
#endif`,xp=`#ifdef USE_CLEARCOAT_NORMALMAP
	vec3 clearcoatMapN = texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0;
	clearcoatMapN.xy *= clearcoatNormalScale;
	clearcoatNormal = normalize( tbn2 * clearcoatMapN );
#endif`,vp=`#ifdef USE_CLEARCOATMAP
	uniform sampler2D clearcoatMap;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform sampler2D clearcoatNormalMap;
	uniform vec2 clearcoatNormalScale;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform sampler2D clearcoatRoughnessMap;
#endif`,yp=`#ifdef USE_IRIDESCENCEMAP
	uniform sampler2D iridescenceMap;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform sampler2D iridescenceThicknessMap;
#endif`,Sp=`#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`,Mp=`vec3 packNormalToRGB( const in vec3 normal ) {
	return normalize( normal ) * 0.5 + 0.5;
}
vec3 unpackRGBToNormal( const in vec3 rgb ) {
	return 2.0 * rgb.xyz - 1.0;
}
const float PackUpscale = 256. / 255.;const float UnpackDownscale = 255. / 256.;
const vec3 PackFactors = vec3( 256. * 256. * 256., 256. * 256., 256. );
const vec4 UnpackFactors = UnpackDownscale / vec4( PackFactors, 1. );
const float ShiftRight8 = 1. / 256.;
vec4 packDepthToRGBA( const in float v ) {
	vec4 r = vec4( fract( v * PackFactors ), v );
	r.yzw -= r.xyz * ShiftRight8;	return r * PackUpscale;
}
float unpackRGBAToDepth( const in vec4 v ) {
	return dot( v, UnpackFactors );
}
vec2 packDepthToRG( in highp float v ) {
	return packDepthToRGBA( v ).yx;
}
float unpackRGToDepth( const in highp vec2 v ) {
	return unpackRGBAToDepth( vec4( v.xy, 0.0, 0.0 ) );
}
vec4 pack2HalfToRGBA( vec2 v ) {
	vec4 r = vec4( v.x, fract( v.x * 255.0 ), v.y, fract( v.y * 255.0 ) );
	return vec4( r.x - r.y / 255.0, r.y, r.z - r.w / 255.0, r.w );
}
vec2 unpackRGBATo2Half( vec4 v ) {
	return vec2( v.x + ( v.y / 255.0 ), v.z + ( v.w / 255.0 ) );
}
float viewZToOrthographicDepth( const in float viewZ, const in float near, const in float far ) {
	return ( viewZ + near ) / ( near - far );
}
float orthographicDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return depth * ( near - far ) - near;
}
float viewZToPerspectiveDepth( const in float viewZ, const in float near, const in float far ) {
	return ( ( near + viewZ ) * far ) / ( ( far - near ) * viewZ );
}
float perspectiveDepthToViewZ( const in float depth, const in float near, const in float far ) {
	return ( near * far ) / ( ( far - near ) * depth - far );
}`,bp=`#ifdef PREMULTIPLIED_ALPHA
	gl_FragColor.rgb *= gl_FragColor.a;
#endif`,Tp=`vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`,Ap=`#ifdef DITHERING
	gl_FragColor.rgb = dithering( gl_FragColor.rgb );
#endif`,Ep=`#ifdef DITHERING
	vec3 dithering( vec3 color ) {
		float grid_position = rand( gl_FragCoord.xy );
		vec3 dither_shift_RGB = vec3( 0.25 / 255.0, -0.25 / 255.0, 0.25 / 255.0 );
		dither_shift_RGB = mix( 2.0 * dither_shift_RGB, -2.0 * dither_shift_RGB, grid_position );
		return color + dither_shift_RGB;
	}
#endif`,wp=`float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );
	roughnessFactor *= texelRoughness.g;
#endif`,Rp=`#ifdef USE_ROUGHNESSMAP
	uniform sampler2D roughnessMap;
#endif`,Cp=`#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform sampler2D pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
	float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
		return step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
	}
	vec2 texture2DDistribution( sampler2D shadow, vec2 uv ) {
		return unpackRGBATo2Half( texture2D( shadow, uv ) );
	}
	float VSMShadow (sampler2D shadow, vec2 uv, float compare ){
		float occlusion = 1.0;
		vec2 distribution = texture2DDistribution( shadow, uv );
		float hard_shadow = step( compare , distribution.x );
		if (hard_shadow != 1.0 ) {
			float distance = compare - distribution.x ;
			float variance = max( 0.00000, distribution.y * distribution.y );
			float softness_probability = variance / (variance + distance * distance );			softness_probability = clamp( ( softness_probability - 0.3 ) / ( 0.95 - 0.3 ), 0.0, 1.0 );			occlusion = clamp( max( hard_shadow, softness_probability ), 0.0, 1.0 );
		}
		return occlusion;
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		float shadow = 1.0;
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
		if ( frustumTest ) {
		#if defined( SHADOWMAP_TYPE_PCF )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx0 = - texelSize.x * shadowRadius;
			float dy0 = - texelSize.y * shadowRadius;
			float dx1 = + texelSize.x * shadowRadius;
			float dy1 = + texelSize.y * shadowRadius;
			float dx2 = dx0 / 2.0;
			float dy2 = dy0 / 2.0;
			float dx3 = dx1 / 2.0;
			float dy3 = dy1 / 2.0;
			shadow = (
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy2 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, dy3 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy1 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
			) * ( 1.0 / 17.0 );
		#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float dx = texelSize.x;
			float dy = texelSize.y;
			vec2 uv = shadowCoord.xy;
			vec2 f = fract( uv * shadowMapSize + 0.5 );
			uv -= f * texelSize;
			shadow = (
				texture2DCompare( shadowMap, uv, shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( dx, 0.0 ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + vec2( 0.0, dy ), shadowCoord.z ) +
				texture2DCompare( shadowMap, uv + texelSize, shadowCoord.z ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, 0.0 ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 0.0 ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( -dx, dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, dy ), shadowCoord.z ),
					 f.x ) +
				mix( texture2DCompare( shadowMap, uv + vec2( 0.0, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( 0.0, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( texture2DCompare( shadowMap, uv + vec2( dx, -dy ), shadowCoord.z ),
					 texture2DCompare( shadowMap, uv + vec2( dx, 2.0 * dy ), shadowCoord.z ),
					 f.y ) +
				mix( mix( texture2DCompare( shadowMap, uv + vec2( -dx, -dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, -dy ), shadowCoord.z ),
						  f.x ),
					 mix( texture2DCompare( shadowMap, uv + vec2( -dx, 2.0 * dy ), shadowCoord.z ),
						  texture2DCompare( shadowMap, uv + vec2( 2.0 * dx, 2.0 * dy ), shadowCoord.z ),
						  f.x ),
					 f.y )
			) * ( 1.0 / 9.0 );
		#elif defined( SHADOWMAP_TYPE_VSM )
			shadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );
		#else
			shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );
		#endif
		}
		return shadow;
	}
	vec2 cubeToUV( vec3 v, float texelSizeY ) {
		vec3 absV = abs( v );
		float scaleToCube = 1.0 / max( absV.x, max( absV.y, absV.z ) );
		absV *= scaleToCube;
		v *= scaleToCube * ( 1.0 - 2.0 * texelSizeY );
		vec2 planar = v.xy;
		float almostATexel = 1.5 * texelSizeY;
		float almostOne = 1.0 - almostATexel;
		if ( absV.z >= almostOne ) {
			if ( v.z > 0.0 )
				planar.x = 4.0 - v.x;
		} else if ( absV.x >= almostOne ) {
			float signX = sign( v.x );
			planar.x = v.z * signX + 2.0 * signX;
		} else if ( absV.y >= almostOne ) {
			float signY = sign( v.y );
			planar.x = v.x + 2.0 * signY + 2.0;
			planar.y = v.z * signY - 2.0;
		}
		return vec2( 0.125, 0.25 ) * planar + vec2( 0.375, 0.75 );
	}
	float getPointShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		vec2 texelSize = vec2( 1.0 ) / ( shadowMapSize * vec2( 4.0, 2.0 ) );
		vec3 lightToPosition = shadowCoord.xyz;
		float dp = ( length( lightToPosition ) - shadowCameraNear ) / ( shadowCameraFar - shadowCameraNear );		dp += shadowBias;
		vec3 bd3D = normalize( lightToPosition );
		#if defined( SHADOWMAP_TYPE_PCF ) || defined( SHADOWMAP_TYPE_PCF_SOFT ) || defined( SHADOWMAP_TYPE_VSM )
			vec2 offset = vec2( - 1, 1 ) * shadowRadius * texelSize.y;
			return (
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yyx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxy, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.xxx, texelSize.y ), dp ) +
				texture2DCompare( shadowMap, cubeToUV( bd3D + offset.yxx, texelSize.y ), dp )
			) * ( 1.0 / 9.0 );
		#else
			return texture2DCompare( shadowMap, cubeToUV( bd3D, texelSize.y ), dp );
		#endif
	}
#endif`,Pp=`#if NUM_SPOT_LIGHT_COORDS > 0
	uniform mat4 spotLightMatrix[ NUM_SPOT_LIGHT_COORDS ];
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		struct SpotLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		uniform mat4 pointShadowMatrix[ NUM_POINT_LIGHT_SHADOWS ];
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif
#endif`,Lp=`#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) || ( NUM_SPOT_LIGHT_COORDS > 0 )
	vec3 shadowWorldNormal = inverseTransformDirection( transformedNormal, viewMatrix );
	vec4 shadowWorldPosition;
#endif
#if defined( USE_SHADOWMAP )
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );
			vDirectionalShadowCoord[ i ] = directionalShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
			shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * pointLightShadows[ i ].shadowNormalBias, 0 );
			vPointShadowCoord[ i ] = pointShadowMatrix[ i ] * shadowWorldPosition;
		}
		#pragma unroll_loop_end
	#endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
		shadowWorldPosition = worldPosition;
		#if ( defined( USE_SHADOWMAP ) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
			shadowWorldPosition.xyz += shadowWorldNormal * spotLightShadows[ i ].shadowNormalBias;
		#endif
		vSpotLightCoord[ i ] = spotLightMatrix[ i ] * shadowWorldPosition;
	}
	#pragma unroll_loop_end
#endif`,Ip=`float getShadowMask() {
	float shadow = 1.0;
	#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLight = directionalLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHT_SHADOWS; i ++ ) {
		spotLight = spotLightShadows[ i ];
		shadow *= receiveShadow ? getShadow( spotShadowMap[ i ], spotLight.shadowMapSize, spotLight.shadowBias, spotLight.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
		pointLight = pointLightShadows[ i ];
		shadow *= receiveShadow ? getPointShadow( pointShadowMap[ i ], pointLight.shadowMapSize, pointLight.shadowBias, pointLight.shadowRadius, vPointShadowCoord[ i ], pointLight.shadowCameraNear, pointLight.shadowCameraFar ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif
	#endif
	return shadow;
}`,Np=`#ifdef USE_SKINNING
	mat4 boneMatX = getBoneMatrix( skinIndex.x );
	mat4 boneMatY = getBoneMatrix( skinIndex.y );
	mat4 boneMatZ = getBoneMatrix( skinIndex.z );
	mat4 boneMatW = getBoneMatrix( skinIndex.w );
#endif`,Dp=`#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	mat4 getBoneMatrix( const in float i ) {
		int size = textureSize( boneTexture, 0 ).x;
		int j = int( i ) * 4;
		int x = j % size;
		int y = j / size;
		vec4 v1 = texelFetch( boneTexture, ivec2( x, y ), 0 );
		vec4 v2 = texelFetch( boneTexture, ivec2( x + 1, y ), 0 );
		vec4 v3 = texelFetch( boneTexture, ivec2( x + 2, y ), 0 );
		vec4 v4 = texelFetch( boneTexture, ivec2( x + 3, y ), 0 );
		return mat4( v1, v2, v3, v4 );
	}
#endif`,Up=`#ifdef USE_SKINNING
	vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
	vec4 skinned = vec4( 0.0 );
	skinned += boneMatX * skinVertex * skinWeight.x;
	skinned += boneMatY * skinVertex * skinWeight.y;
	skinned += boneMatZ * skinVertex * skinWeight.z;
	skinned += boneMatW * skinVertex * skinWeight.w;
	transformed = ( bindMatrixInverse * skinned ).xyz;
#endif`,Fp=`#ifdef USE_SKINNING
	mat4 skinMatrix = mat4( 0.0 );
	skinMatrix += skinWeight.x * boneMatX;
	skinMatrix += skinWeight.y * boneMatY;
	skinMatrix += skinWeight.z * boneMatZ;
	skinMatrix += skinWeight.w * boneMatW;
	skinMatrix = bindMatrixInverse * skinMatrix * bindMatrix;
	objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = vec4( skinMatrix * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
#endif`,Op=`float specularStrength;
#ifdef USE_SPECULARMAP
	vec4 texelSpecular = texture2D( specularMap, vSpecularMapUv );
	specularStrength = texelSpecular.r;
#else
	specularStrength = 1.0;
#endif`,Bp=`#ifdef USE_SPECULARMAP
	uniform sampler2D specularMap;
#endif`,zp=`#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#endif`,kp=`#ifndef saturate
#define saturate( a ) clamp( a, 0.0, 1.0 )
#endif
uniform float toneMappingExposure;
vec3 LinearToneMapping( vec3 color ) {
	return saturate( toneMappingExposure * color );
}
vec3 ReinhardToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	return saturate( color / ( vec3( 1.0 ) + color ) );
}
vec3 OptimizedCineonToneMapping( vec3 color ) {
	color *= toneMappingExposure;
	color = max( vec3( 0.0 ), color - 0.004 );
	return pow( ( color * ( 6.2 * color + 0.5 ) ) / ( color * ( 6.2 * color + 1.7 ) + 0.06 ), vec3( 2.2 ) );
}
vec3 RRTAndODTFit( vec3 v ) {
	vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
	vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
vec3 ACESFilmicToneMapping( vec3 color ) {
	const mat3 ACESInputMat = mat3(
		vec3( 0.59719, 0.07600, 0.02840 ),		vec3( 0.35458, 0.90834, 0.13383 ),
		vec3( 0.04823, 0.01566, 0.83777 )
	);
	const mat3 ACESOutputMat = mat3(
		vec3(  1.60475, -0.10208, -0.00327 ),		vec3( -0.53108,  1.10813, -0.07276 ),
		vec3( -0.07367, -0.00605,  1.07602 )
	);
	color *= toneMappingExposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return saturate( color );
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
	vec3( 1.6605, - 0.1246, - 0.0182 ),
	vec3( - 0.5876, 1.1329, - 0.1006 ),
	vec3( - 0.0728, - 0.0083, 1.1187 )
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 )
);
vec3 agxDefaultContrastApprox( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2
		- 40.14 * x4 * x
		+ 31.96 * x4
		- 6.868 * x2 * x
		+ 0.4298 * x2
		+ 0.1191 * x
		- 0.00232;
}
vec3 AgXToneMapping( vec3 color ) {
	const mat3 AgXInsetMatrix = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 )
	);
	const mat3 AgXOutsetMatrix = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 )
	);
	const float AgxMinEv = - 12.47393;	const float AgxMaxEv = 4.026069;
	color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
	color *= toneMappingExposure;
	color = AgXInsetMatrix * color;
	color = max( color, 1e-10 );	color = log2( color );
	color = ( color - AgxMinEv ) / ( AgxMaxEv - AgxMinEv );
	color = clamp( color, 0.0, 1.0 );
	color = agxDefaultContrastApprox( color );
	color = AgXOutsetMatrix * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
	return color;
}
vec3 CustomToneMapping( vec3 color ) { return color; }`,Gp=`#ifdef USE_TRANSMISSION
	material.transmission = transmission;
	material.transmissionAlpha = 1.0;
	material.thickness = thickness;
	material.attenuationDistance = attenuationDistance;
	material.attenuationColor = attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;
	#endif
	#ifdef USE_THICKNESSMAP
		material.thickness *= texture2D( thicknessMap, vThicknessMapUv ).g;
	#endif
	vec3 pos = vWorldPosition;
	vec3 v = normalize( cameraPosition - pos );
	vec3 n = inverseTransformDirection( normal, viewMatrix );
	vec4 transmitted = getIBLVolumeRefraction(
		n, v, material.roughness, material.diffuseColor, material.specularColor, material.specularF90,
		pos, modelMatrix, viewMatrix, projectionMatrix, material.ior, material.thickness,
		material.attenuationColor, material.attenuationDistance );
	material.transmissionAlpha = mix( material.transmissionAlpha, transmitted.a, material.transmission );
	totalDiffuse = mix( totalDiffuse, transmitted.rgb, material.transmission );
#endif`,Hp=`#ifdef USE_TRANSMISSION
	uniform float transmission;
	uniform float thickness;
	uniform float attenuationDistance;
	uniform vec3 attenuationColor;
	#ifdef USE_TRANSMISSIONMAP
		uniform sampler2D transmissionMap;
	#endif
	#ifdef USE_THICKNESSMAP
		uniform sampler2D thicknessMap;
	#endif
	uniform vec2 transmissionSamplerSize;
	uniform sampler2D transmissionSamplerMap;
	uniform mat4 modelMatrix;
	uniform mat4 projectionMatrix;
	varying vec3 vWorldPosition;
	float w0( float a ) {
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - a + 3.0 ) - 3.0 ) + 1.0 );
	}
	float w1( float a ) {
		return ( 1.0 / 6.0 ) * ( a *  a * ( 3.0 * a - 6.0 ) + 4.0 );
	}
	float w2( float a ){
		return ( 1.0 / 6.0 ) * ( a * ( a * ( - 3.0 * a + 3.0 ) + 3.0 ) + 1.0 );
	}
	float w3( float a ) {
		return ( 1.0 / 6.0 ) * ( a * a * a );
	}
	float g0( float a ) {
		return w0( a ) + w1( a );
	}
	float g1( float a ) {
		return w2( a ) + w3( a );
	}
	float h0( float a ) {
		return - 1.0 + w1( a ) / ( w0( a ) + w1( a ) );
	}
	float h1( float a ) {
		return 1.0 + w3( a ) / ( w2( a ) + w3( a ) );
	}
	vec4 bicubic( sampler2D tex, vec2 uv, vec4 texelSize, float lod ) {
		uv = uv * texelSize.zw + 0.5;
		vec2 iuv = floor( uv );
		vec2 fuv = fract( uv );
		float g0x = g0( fuv.x );
		float g1x = g1( fuv.x );
		float h0x = h0( fuv.x );
		float h1x = h1( fuv.x );
		float h0y = h0( fuv.y );
		float h1y = h1( fuv.y );
		vec2 p0 = ( vec2( iuv.x + h0x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p1 = ( vec2( iuv.x + h1x, iuv.y + h0y ) - 0.5 ) * texelSize.xy;
		vec2 p2 = ( vec2( iuv.x + h0x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		vec2 p3 = ( vec2( iuv.x + h1x, iuv.y + h1y ) - 0.5 ) * texelSize.xy;
		return g0( fuv.y ) * ( g0x * textureLod( tex, p0, lod ) + g1x * textureLod( tex, p1, lod ) ) +
			g1( fuv.y ) * ( g0x * textureLod( tex, p2, lod ) + g1x * textureLod( tex, p3, lod ) );
	}
	vec4 textureBicubic( sampler2D sampler, vec2 uv, float lod ) {
		vec2 fLodSize = vec2( textureSize( sampler, int( lod ) ) );
		vec2 cLodSize = vec2( textureSize( sampler, int( lod + 1.0 ) ) );
		vec2 fLodSizeInv = 1.0 / fLodSize;
		vec2 cLodSizeInv = 1.0 / cLodSize;
		vec4 fSample = bicubic( sampler, uv, vec4( fLodSizeInv, fLodSize ), floor( lod ) );
		vec4 cSample = bicubic( sampler, uv, vec4( cLodSizeInv, cLodSize ), ceil( lod ) );
		return mix( fSample, cSample, fract( lod ) );
	}
	vec3 getVolumeTransmissionRay( const in vec3 n, const in vec3 v, const in float thickness, const in float ior, const in mat4 modelMatrix ) {
		vec3 refractionVector = refract( - v, normalize( n ), 1.0 / ior );
		vec3 modelScale;
		modelScale.x = length( vec3( modelMatrix[ 0 ].xyz ) );
		modelScale.y = length( vec3( modelMatrix[ 1 ].xyz ) );
		modelScale.z = length( vec3( modelMatrix[ 2 ].xyz ) );
		return normalize( refractionVector ) * thickness * modelScale;
	}
	float applyIorToRoughness( const in float roughness, const in float ior ) {
		return roughness * clamp( ior * 2.0 - 2.0, 0.0, 1.0 );
	}
	vec4 getTransmissionSample( const in vec2 fragCoord, const in float roughness, const in float ior ) {
		float lod = log2( transmissionSamplerSize.x ) * applyIorToRoughness( roughness, ior );
		return textureBicubic( transmissionSamplerMap, fragCoord.xy, lod );
	}
	vec3 volumeAttenuation( const in float transmissionDistance, const in vec3 attenuationColor, const in float attenuationDistance ) {
		if ( isinf( attenuationDistance ) ) {
			return vec3( 1.0 );
		} else {
			vec3 attenuationCoefficient = -log( attenuationColor ) / attenuationDistance;
			vec3 transmittance = exp( - attenuationCoefficient * transmissionDistance );			return transmittance;
		}
	}
	vec4 getIBLVolumeRefraction( const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
		const in vec3 specularColor, const in float specularF90, const in vec3 position, const in mat4 modelMatrix,
		const in mat4 viewMatrix, const in mat4 projMatrix, const in float ior, const in float thickness,
		const in vec3 attenuationColor, const in float attenuationDistance ) {
		vec3 transmissionRay = getVolumeTransmissionRay( n, v, thickness, ior, modelMatrix );
		vec3 refractedRayExit = position + transmissionRay;
		vec4 ndcPos = projMatrix * viewMatrix * vec4( refractedRayExit, 1.0 );
		vec2 refractionCoords = ndcPos.xy / ndcPos.w;
		refractionCoords += 1.0;
		refractionCoords /= 2.0;
		vec4 transmittedLight = getTransmissionSample( refractionCoords, roughness, ior );
		vec3 transmittance = diffuseColor * volumeAttenuation( length( transmissionRay ), attenuationColor, attenuationDistance );
		vec3 attenuatedColor = transmittance * transmittedLight.rgb;
		vec3 F = EnvironmentBRDF( n, v, specularColor, specularF90, roughness );
		float transmittanceFactor = ( transmittance.r + transmittance.g + transmittance.b ) / 3.0;
		return vec4( ( 1.0 - F ) * attenuatedColor, 1.0 - ( 1.0 - transmittedLight.a ) * transmittanceFactor );
	}
#endif`,Wp=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_SPECULARMAP
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Vp=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	varying vec2 vUv;
#endif
#ifdef USE_MAP
	uniform mat3 mapTransform;
	varying vec2 vMapUv;
#endif
#ifdef USE_ALPHAMAP
	uniform mat3 alphaMapTransform;
	varying vec2 vAlphaMapUv;
#endif
#ifdef USE_LIGHTMAP
	uniform mat3 lightMapTransform;
	varying vec2 vLightMapUv;
#endif
#ifdef USE_AOMAP
	uniform mat3 aoMapTransform;
	varying vec2 vAoMapUv;
#endif
#ifdef USE_BUMPMAP
	uniform mat3 bumpMapTransform;
	varying vec2 vBumpMapUv;
#endif
#ifdef USE_NORMALMAP
	uniform mat3 normalMapTransform;
	varying vec2 vNormalMapUv;
#endif
#ifdef USE_DISPLACEMENTMAP
	uniform mat3 displacementMapTransform;
	varying vec2 vDisplacementMapUv;
#endif
#ifdef USE_EMISSIVEMAP
	uniform mat3 emissiveMapTransform;
	varying vec2 vEmissiveMapUv;
#endif
#ifdef USE_METALNESSMAP
	uniform mat3 metalnessMapTransform;
	varying vec2 vMetalnessMapUv;
#endif
#ifdef USE_ROUGHNESSMAP
	uniform mat3 roughnessMapTransform;
	varying vec2 vRoughnessMapUv;
#endif
#ifdef USE_ANISOTROPYMAP
	uniform mat3 anisotropyMapTransform;
	varying vec2 vAnisotropyMapUv;
#endif
#ifdef USE_CLEARCOATMAP
	uniform mat3 clearcoatMapTransform;
	varying vec2 vClearcoatMapUv;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	uniform mat3 clearcoatNormalMapTransform;
	varying vec2 vClearcoatNormalMapUv;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	uniform mat3 clearcoatRoughnessMapTransform;
	varying vec2 vClearcoatRoughnessMapUv;
#endif
#ifdef USE_SHEEN_COLORMAP
	uniform mat3 sheenColorMapTransform;
	varying vec2 vSheenColorMapUv;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	uniform mat3 sheenRoughnessMapTransform;
	varying vec2 vSheenRoughnessMapUv;
#endif
#ifdef USE_IRIDESCENCEMAP
	uniform mat3 iridescenceMapTransform;
	varying vec2 vIridescenceMapUv;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	uniform mat3 iridescenceThicknessMapTransform;
	varying vec2 vIridescenceThicknessMapUv;
#endif
#ifdef USE_SPECULARMAP
	uniform mat3 specularMapTransform;
	varying vec2 vSpecularMapUv;
#endif
#ifdef USE_SPECULAR_COLORMAP
	uniform mat3 specularColorMapTransform;
	varying vec2 vSpecularColorMapUv;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	uniform mat3 specularIntensityMapTransform;
	varying vec2 vSpecularIntensityMapUv;
#endif
#ifdef USE_TRANSMISSIONMAP
	uniform mat3 transmissionMapTransform;
	varying vec2 vTransmissionMapUv;
#endif
#ifdef USE_THICKNESSMAP
	uniform mat3 thicknessMapTransform;
	varying vec2 vThicknessMapUv;
#endif`,Xp=`#if defined( USE_UV ) || defined( USE_ANISOTROPY )
	vUv = vec3( uv, 1 ).xy;
#endif
#ifdef USE_MAP
	vMapUv = ( mapTransform * vec3( MAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ALPHAMAP
	vAlphaMapUv = ( alphaMapTransform * vec3( ALPHAMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_LIGHTMAP
	vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_AOMAP
	vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_BUMPMAP
	vBumpMapUv = ( bumpMapTransform * vec3( BUMPMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_NORMALMAP
	vNormalMapUv = ( normalMapTransform * vec3( NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_DISPLACEMENTMAP
	vDisplacementMapUv = ( displacementMapTransform * vec3( DISPLACEMENTMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_EMISSIVEMAP
	vEmissiveMapUv = ( emissiveMapTransform * vec3( EMISSIVEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_METALNESSMAP
	vMetalnessMapUv = ( metalnessMapTransform * vec3( METALNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ROUGHNESSMAP
	vRoughnessMapUv = ( roughnessMapTransform * vec3( ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_ANISOTROPYMAP
	vAnisotropyMapUv = ( anisotropyMapTransform * vec3( ANISOTROPYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOATMAP
	vClearcoatMapUv = ( clearcoatMapTransform * vec3( CLEARCOATMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_NORMALMAP
	vClearcoatNormalMapUv = ( clearcoatNormalMapTransform * vec3( CLEARCOAT_NORMALMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_CLEARCOAT_ROUGHNESSMAP
	vClearcoatRoughnessMapUv = ( clearcoatRoughnessMapTransform * vec3( CLEARCOAT_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCEMAP
	vIridescenceMapUv = ( iridescenceMapTransform * vec3( IRIDESCENCEMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_IRIDESCENCE_THICKNESSMAP
	vIridescenceThicknessMapUv = ( iridescenceThicknessMapTransform * vec3( IRIDESCENCE_THICKNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_COLORMAP
	vSheenColorMapUv = ( sheenColorMapTransform * vec3( SHEEN_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SHEEN_ROUGHNESSMAP
	vSheenRoughnessMapUv = ( sheenRoughnessMapTransform * vec3( SHEEN_ROUGHNESSMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULARMAP
	vSpecularMapUv = ( specularMapTransform * vec3( SPECULARMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_COLORMAP
	vSpecularColorMapUv = ( specularColorMapTransform * vec3( SPECULAR_COLORMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_SPECULAR_INTENSITYMAP
	vSpecularIntensityMapUv = ( specularIntensityMapTransform * vec3( SPECULAR_INTENSITYMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_TRANSMISSIONMAP
	vTransmissionMapUv = ( transmissionMapTransform * vec3( TRANSMISSIONMAP_UV, 1 ) ).xy;
#endif
#ifdef USE_THICKNESSMAP
	vThicknessMapUv = ( thicknessMapTransform * vec3( THICKNESSMAP_UV, 1 ) ).xy;
#endif`,qp=`#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
	vec4 worldPosition = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		worldPosition = batchingMatrix * worldPosition;
	#endif
	#ifdef USE_INSTANCING
		worldPosition = instanceMatrix * worldPosition;
	#endif
	worldPosition = modelMatrix * worldPosition;
#endif`,Yp=`varying vec2 vUv;
uniform mat3 uvTransform;
void main() {
	vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	gl_Position = vec4( position.xy, 1.0, 1.0 );
}`,Zp=`uniform sampler2D t2D;
uniform float backgroundIntensity;
varying vec2 vUv;
void main() {
	vec4 texColor = texture2D( t2D, vUv );
	#ifdef DECODE_VIDEO_TEXTURE
		texColor = vec4( mix( pow( texColor.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), texColor.rgb * 0.0773993808, vec3( lessThanEqual( texColor.rgb, vec3( 0.04045 ) ) ) ), texColor.w );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Kp=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,Jp=`#ifdef ENVMAP_TYPE_CUBE
	uniform samplerCube envMap;
#elif defined( ENVMAP_TYPE_CUBE_UV )
	uniform sampler2D envMap;
#endif
uniform float flipEnvMap;
uniform float backgroundBlurriness;
uniform float backgroundIntensity;
varying vec3 vWorldDirection;
#include <cube_uv_reflection_fragment>
void main() {
	#ifdef ENVMAP_TYPE_CUBE
		vec4 texColor = textureCube( envMap, vec3( flipEnvMap * vWorldDirection.x, vWorldDirection.yz ) );
	#elif defined( ENVMAP_TYPE_CUBE_UV )
		vec4 texColor = textureCubeUV( envMap, vWorldDirection, backgroundBlurriness );
	#else
		vec4 texColor = vec4( 0.0, 0.0, 0.0, 1.0 );
	#endif
	texColor.rgb *= backgroundIntensity;
	gl_FragColor = texColor;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,$p=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
	gl_Position.z = gl_Position.w;
}`,jp=`uniform samplerCube tCube;
uniform float tFlip;
uniform float opacity;
varying vec3 vWorldDirection;
void main() {
	vec4 texColor = textureCube( tCube, vec3( tFlip * vWorldDirection.x, vWorldDirection.yz ) );
	gl_FragColor = texColor;
	gl_FragColor.a *= opacity;
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,Qp=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vHighPrecisionZW;
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vHighPrecisionZW = gl_Position.zw;
}`,em=`#if DEPTH_PACKING == 3200
	uniform float opacity;
#endif
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
varying vec2 vHighPrecisionZW;
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#if DEPTH_PACKING == 3200
		diffuseColor.a = opacity;
	#endif
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <logdepthbuf_fragment>
	float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
	#if DEPTH_PACKING == 3200
		gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );
	#elif DEPTH_PACKING == 3201
		gl_FragColor = packDepthToRGBA( fragCoordZ );
	#endif
}`,tm=`#define DISTANCE
varying vec3 vWorldPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <skinbase_vertex>
	#ifdef USE_DISPLACEMENTMAP
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <worldpos_vertex>
	#include <clipping_planes_vertex>
	vWorldPosition = worldPosition.xyz;
}`,nm=`#define DISTANCE
uniform vec3 referencePosition;
uniform float nearDistance;
uniform float farDistance;
varying vec3 vWorldPosition;
#include <common>
#include <packing>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <clipping_planes_pars_fragment>
void main () {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( 1.0 );
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	float dist = length( vWorldPosition - referencePosition );
	dist = ( dist - nearDistance ) / ( farDistance - nearDistance );
	dist = saturate( dist );
	gl_FragColor = packDepthToRGBA( dist );
}`,im=`varying vec3 vWorldDirection;
#include <common>
void main() {
	vWorldDirection = transformDirection( position, modelMatrix );
	#include <begin_vertex>
	#include <project_vertex>
}`,sm=`uniform sampler2D tEquirect;
varying vec3 vWorldDirection;
#include <common>
void main() {
	vec3 direction = normalize( vWorldDirection );
	vec2 sampleUV = equirectUv( direction );
	gl_FragColor = texture2D( tEquirect, sampleUV );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`,rm=`uniform float scale;
attribute float lineDistance;
varying float vLineDistance;
#include <common>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	vLineDistance = scale * lineDistance;
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,am=`uniform vec3 diffuse;
uniform float opacity;
uniform float dashSize;
uniform float totalSize;
varying float vLineDistance;
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	if ( mod( vLineDistance, totalSize ) > dashSize ) {
		discard;
	}
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,om=`#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )
		#include <beginnormal_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>
	#endif
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <fog_vertex>
}`,lm=`uniform vec3 diffuse;
uniform float opacity;
#ifndef FLAT_SHADED
	varying vec3 vNormal;
#endif
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#ifdef USE_LIGHTMAP
		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		reflectedLight.indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI;
	#else
		reflectedLight.indirectDiffuse += vec3( 1.0 );
	#endif
	#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= diffuseColor.rgb;
	vec3 outgoingLight = reflectedLight.indirectDiffuse;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,cm=`#define LAMBERT
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,hm=`#define LAMBERT
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_lambert_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,um=`#define MATCAP
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <color_pars_vertex>
#include <displacementmap_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
	vViewPosition = - mvPosition.xyz;
}`,dm=`#define MATCAP
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D matcap;
varying vec3 vViewPosition;
#include <common>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	vec3 viewDir = normalize( vViewPosition );
	vec3 x = normalize( vec3( viewDir.z, 0.0, - viewDir.x ) );
	vec3 y = cross( viewDir, x );
	vec2 uv = vec2( dot( x, normal ), dot( y, normal ) ) * 0.495 + 0.5;
	#ifdef USE_MATCAP
		vec4 matcapColor = texture2D( matcap, uv );
	#else
		vec4 matcapColor = vec4( vec3( mix( 0.2, 0.8, uv.y ) ), 1.0 );
	#endif
	vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,fm=`#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	vViewPosition = - mvPosition.xyz;
#endif
}`,pm=`#define NORMAL
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
	varying vec3 vViewPosition;
#endif
#include <packing>
#include <uv_pars_fragment>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	#include <logdepthbuf_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	gl_FragColor = vec4( packNormalToRGB( normal ), opacity );
	#ifdef OPAQUE
		gl_FragColor.a = 1.0;
	#endif
}`;var mm=`#define PHONG
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <envmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <envmap_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,gm=`#define PHONG
uniform vec3 diffuse;
uniform vec3 emissive;
uniform vec3 specular;
uniform float shininess;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_phong_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <specularmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <specularmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_phong_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;
	#include <envmap_fragment>
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,_m=`#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
	varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
#ifdef USE_TRANSMISSION
	vWorldPosition = worldPosition.xyz;
#endif
}`,xm=`#define STANDARD
#ifdef PHYSICAL
	#define IOR
	#define USE_SPECULAR
#endif
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float roughness;
uniform float metalness;
uniform float opacity;
#ifdef IOR
	uniform float ior;
#endif
#ifdef USE_SPECULAR
	uniform float specularIntensity;
	uniform vec3 specularColor;
	#ifdef USE_SPECULAR_COLORMAP
		uniform sampler2D specularColorMap;
	#endif
	#ifdef USE_SPECULAR_INTENSITYMAP
		uniform sampler2D specularIntensityMap;
	#endif
#endif
#ifdef USE_CLEARCOAT
	uniform float clearcoat;
	uniform float clearcoatRoughness;
#endif
#ifdef USE_IRIDESCENCE
	uniform float iridescence;
	uniform float iridescenceIOR;
	uniform float iridescenceThicknessMinimum;
	uniform float iridescenceThicknessMaximum;
#endif
#ifdef USE_SHEEN
	uniform vec3 sheenColor;
	uniform float sheenRoughness;
	#ifdef USE_SHEEN_COLORMAP
		uniform sampler2D sheenColorMap;
	#endif
	#ifdef USE_SHEEN_ROUGHNESSMAP
		uniform sampler2D sheenRoughnessMap;
	#endif
#endif
#ifdef USE_ANISOTROPY
	uniform vec2 anisotropyVector;
	#ifdef USE_ANISOTROPYMAP
		uniform sampler2D anisotropyMap;
	#endif
#endif
varying vec3 vViewPosition;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <iridescence_fragment>
#include <cube_uv_reflection_fragment>
#include <envmap_common_pars_fragment>
#include <envmap_physical_pars_fragment>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_physical_pars_fragment>
#include <transmission_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <clearcoat_pars_fragment>
#include <iridescence_pars_fragment>
#include <roughnessmap_pars_fragment>
#include <metalnessmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	#include <clearcoat_normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
	#include <transmission_fragment>
	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
	#ifdef USE_SHEEN
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );
		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;
	#endif
	#ifdef USE_CLEARCOAT
		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );
		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );
		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;
	#endif
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,vm=`#define TOON
varying vec3 vViewPosition;
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	vViewPosition = - mvPosition.xyz;
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,ym=`#define TOON
uniform vec3 diffuse;
uniform vec3 emissive;
uniform float opacity;
#include <common>
#include <packing>
#include <dithering_pars_fragment>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <aomap_pars_fragment>
#include <lightmap_pars_fragment>
#include <emissivemap_pars_fragment>
#include <gradientmap_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <lights_toon_pars_fragment>
#include <shadowmap_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	vec3 totalEmissiveRadiance = emissive;
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <color_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <emissivemap_fragment>
	#include <lights_toon_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
	#include <dithering_fragment>
}`,Sm=`uniform float size;
uniform float scale;
#include <common>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
#ifdef USE_POINTS_UV
	varying vec2 vUv;
	uniform mat3 uvTransform;
#endif
void main() {
	#ifdef USE_POINTS_UV
		vUv = ( uvTransform * vec3( uv, 1 ) ).xy;
	#endif
	#include <color_vertex>
	#include <morphcolor_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <project_vertex>
	gl_PointSize = size;
	#ifdef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
	#endif
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <worldpos_vertex>
	#include <fog_vertex>
}`,Mm=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <color_pars_fragment>
#include <map_particle_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_particle_fragment>
	#include <color_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
	#include <premultiplied_alpha_fragment>
}`,bm=`#include <common>
#include <batching_pars_vertex>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <shadowmap_pars_vertex>
void main() {
	#include <batching_vertex>
	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>
}`,Tm=`uniform vec3 color;
uniform float opacity;
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <logdepthbuf_pars_fragment>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,Am=`uniform float rotation;
uniform vec2 center;
#include <common>
#include <uv_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
	#include <uv_vertex>
	vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec2 scale;
	scale.x = length( vec3( modelMatrix[ 0 ].x, modelMatrix[ 0 ].y, modelMatrix[ 0 ].z ) );
	scale.y = length( vec3( modelMatrix[ 1 ].x, modelMatrix[ 1 ].y, modelMatrix[ 1 ].z ) );
	#ifndef USE_SIZEATTENUATION
		bool isPerspective = isPerspectiveMatrix( projectionMatrix );
		if ( isPerspective ) scale *= - mvPosition.z;
	#endif
	vec2 alignedPosition = ( position.xy - ( center - vec2( 0.5 ) ) ) * scale;
	vec2 rotatedPosition;
	rotatedPosition.x = cos( rotation ) * alignedPosition.x - sin( rotation ) * alignedPosition.y;
	rotatedPosition.y = sin( rotation ) * alignedPosition.x + cos( rotation ) * alignedPosition.y;
	mvPosition.xy += rotatedPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>
	#include <fog_vertex>
}`,Em=`uniform vec3 diffuse;
uniform float opacity;
#include <common>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
	#include <clipping_planes_fragment>
	vec3 outgoingLight = vec3( 0.0 );
	vec4 diffuseColor = vec4( diffuse, opacity );
	#include <logdepthbuf_fragment>
	#include <map_fragment>
	#include <alphamap_fragment>
	#include <alphatest_fragment>
	#include <alphahash_fragment>
	outgoingLight = diffuseColor.rgb;
	#include <opaque_fragment>
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}`,qe={alphahash_fragment:Yd,alphahash_pars_fragment:Zd,alphamap_fragment:Kd,alphamap_pars_fragment:Jd,alphatest_fragment:$d,alphatest_pars_fragment:jd,aomap_fragment:Qd,aomap_pars_fragment:ef,batching_pars_vertex:tf,batching_vertex:nf,begin_vertex:sf,beginnormal_vertex:rf,bsdfs:af,iridescence_fragment:of,bumpmap_pars_fragment:lf,clipping_planes_fragment:cf,clipping_planes_pars_fragment:hf,clipping_planes_pars_vertex:uf,clipping_planes_vertex:df,color_fragment:ff,color_pars_fragment:pf,color_pars_vertex:mf,color_vertex:gf,common:_f,cube_uv_reflection_fragment:xf,defaultnormal_vertex:vf,displacementmap_pars_vertex:yf,displacementmap_vertex:Sf,emissivemap_fragment:Mf,emissivemap_pars_fragment:bf,colorspace_fragment:Tf,colorspace_pars_fragment:Af,envmap_fragment:Ef,envmap_common_pars_fragment:wf,envmap_pars_fragment:Rf,envmap_pars_vertex:Cf,envmap_physical_pars_fragment:Gf,envmap_vertex:Pf,fog_vertex:Lf,fog_pars_vertex:If,fog_fragment:Nf,fog_pars_fragment:Df,gradientmap_pars_fragment:Uf,lightmap_fragment:Ff,lightmap_pars_fragment:Of,lights_lambert_fragment:Bf,lights_lambert_pars_fragment:zf,lights_pars_begin:kf,lights_toon_fragment:Hf,lights_toon_pars_fragment:Wf,lights_phong_fragment:Vf,lights_phong_pars_fragment:Xf,lights_physical_fragment:qf,lights_physical_pars_fragment:Yf,lights_fragment_begin:Zf,lights_fragment_maps:Kf,lights_fragment_end:Jf,logdepthbuf_fragment:$f,logdepthbuf_pars_fragment:jf,logdepthbuf_pars_vertex:Qf,logdepthbuf_vertex:ep,map_fragment:tp,map_pars_fragment:np,map_particle_fragment:ip,map_particle_pars_fragment:sp,metalnessmap_fragment:rp,metalnessmap_pars_fragment:ap,morphcolor_vertex:op,morphnormal_vertex:lp,morphtarget_pars_vertex:cp,morphtarget_vertex:hp,normal_fragment_begin:up,normal_fragment_maps:dp,normal_pars_fragment:fp,normal_pars_vertex:pp,normal_vertex:mp,normalmap_pars_fragment:gp,clearcoat_normal_fragment_begin:_p,clearcoat_normal_fragment_maps:xp,clearcoat_pars_fragment:vp,iridescence_pars_fragment:yp,opaque_fragment:Sp,packing:Mp,premultiplied_alpha_fragment:bp,project_vertex:Tp,dithering_fragment:Ap,dithering_pars_fragment:Ep,roughnessmap_fragment:wp,roughnessmap_pars_fragment:Rp,shadowmap_pars_fragment:Cp,shadowmap_pars_vertex:Pp,shadowmap_vertex:Lp,shadowmask_pars_fragment:Ip,skinbase_vertex:Np,skinning_pars_vertex:Dp,skinning_vertex:Up,skinnormal_vertex:Fp,specularmap_fragment:Op,specularmap_pars_fragment:Bp,tonemapping_fragment:zp,tonemapping_pars_fragment:kp,transmission_fragment:Gp,transmission_pars_fragment:Hp,uv_pars_fragment:Wp,uv_pars_vertex:Vp,uv_vertex:Xp,worldpos_vertex:qp,background_vert:Yp,background_frag:Zp,backgroundCube_vert:Kp,backgroundCube_frag:Jp,cube_vert:$p,cube_frag:jp,depth_vert:Qp,depth_frag:em,distanceRGBA_vert:tm,distanceRGBA_frag:nm,equirect_vert:im,equirect_frag:sm,linedashed_vert:rm,linedashed_frag:am,meshbasic_vert:om,meshbasic_frag:lm,meshlambert_vert:cm,meshlambert_frag:hm,meshmatcap_vert:um,meshmatcap_frag:dm,meshnormal_vert:fm,meshnormal_frag:pm,meshphong_vert:mm,meshphong_frag:gm,meshphysical_vert:_m,meshphysical_frag:xm,meshtoon_vert:vm,meshtoon_frag:ym,points_vert:Sm,points_frag:Mm,shadow_vert:bm,shadow_frag:Tm,sprite_vert:Am,sprite_frag:Em},fe={common:{diffuse:{value:new ue(16777215)},opacity:{value:1},map:{value:null},mapTransform:{value:new Ze},alphaMap:{value:null},alphaMapTransform:{value:new Ze},alphaTest:{value:0}},specularmap:{specularMap:{value:null},specularMapTransform:{value:new Ze}},envmap:{envMap:{value:null},flipEnvMap:{value:-1},reflectivity:{value:1},ior:{value:1.5},refractionRatio:{value:0.98}},aomap:{aoMap:{value:null},aoMapIntensity:{value:1},aoMapTransform:{value:new Ze}},lightmap:{lightMap:{value:null},lightMapIntensity:{value:1},lightMapTransform:{value:new Ze}},bumpmap:{bumpMap:{value:null},bumpMapTransform:{value:new Ze},bumpScale:{value:1}},normalmap:{normalMap:{value:null},normalMapTransform:{value:new Ze},normalScale:{value:new W(1,1)}},displacementmap:{displacementMap:{value:null},displacementMapTransform:{value:new Ze},displacementScale:{value:1},displacementBias:{value:0}},emissivemap:{emissiveMap:{value:null},emissiveMapTransform:{value:new Ze}},metalnessmap:{metalnessMap:{value:null},metalnessMapTransform:{value:new Ze}},roughnessmap:{roughnessMap:{value:null},roughnessMapTransform:{value:new Ze}},gradientmap:{gradientMap:{value:null}},fog:{fogDensity:{value:0.00025},fogNear:{value:1},fogFar:{value:2000},fogColor:{value:new ue(16777215)}},lights:{ambientLightColor:{value:[]},lightProbe:{value:[]},directionalLights:{value:[],properties:{direction:{},color:{}}},directionalLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},directionalShadowMap:{value:[]},directionalShadowMatrix:{value:[]},spotLights:{value:[],properties:{color:{},position:{},direction:{},distance:{},coneCos:{},penumbraCos:{},decay:{}}},spotLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{}}},spotLightMap:{value:[]},spotShadowMap:{value:[]},spotLightMatrix:{value:[]},pointLights:{value:[],properties:{color:{},position:{},decay:{},distance:{}}},pointLightShadows:{value:[],properties:{shadowBias:{},shadowNormalBias:{},shadowRadius:{},shadowMapSize:{},shadowCameraNear:{},shadowCameraFar:{}}},pointShadowMap:{value:[]},pointShadowMatrix:{value:[]},hemisphereLights:{value:[],properties:{direction:{},skyColor:{},groundColor:{}}},rectAreaLights:{value:[],properties:{color:{},position:{},width:{},height:{}}},ltc_1:{value:null},ltc_2:{value:null}},points:{diffuse:{value:new ue(16777215)},opacity:{value:1},size:{value:1},scale:{value:1},map:{value:null},alphaMap:{value:null},alphaMapTransform:{value:new Ze},alphaTest:{value:0},uvTransform:{value:new Ze}},sprite:{diffuse:{value:new ue(16777215)},opacity:{value:1},center:{value:new W(0.5,0.5)},rotation:{value:0},map:{value:null},mapTransform:{value:new Ze},alphaMap:{value:null},alphaMapTransform:{value:new Ze},alphaTest:{value:0}}},cn={basic:{uniforms:Bt([fe.common,fe.specularmap,fe.envmap,fe.aomap,fe.lightmap,fe.fog]),vertexShader:qe.meshbasic_vert,fragmentShader:qe.meshbasic_frag},lambert:{uniforms:Bt([fe.common,fe.specularmap,fe.envmap,fe.aomap,fe.lightmap,fe.emissivemap,fe.bumpmap,fe.normalmap,fe.displacementmap,fe.fog,fe.lights,{emissive:{value:new ue(0)}}]),vertexShader:qe.meshlambert_vert,fragmentShader:qe.meshlambert_frag},phong:{uniforms:Bt([fe.common,fe.specularmap,fe.envmap,fe.aomap,fe.lightmap,fe.emissivemap,fe.bumpmap,fe.normalmap,fe.displacementmap,fe.fog,fe.lights,{emissive:{value:new ue(0)},specular:{value:new ue(1118481)},shininess:{value:30}}]),vertexShader:qe.meshphong_vert,fragmentShader:qe.meshphong_frag},standard:{uniforms:Bt([fe.common,fe.envmap,fe.aomap,fe.lightmap,fe.emissivemap,fe.bumpmap,fe.normalmap,fe.displacementmap,fe.roughnessmap,fe.metalnessmap,fe.fog,fe.lights,{emissive:{value:new ue(0)},roughness:{value:1},metalness:{value:0},envMapIntensity:{value:1}}]),vertexShader:qe.meshphysical_vert,fragmentShader:qe.meshphysical_frag},toon:{uniforms:Bt([fe.common,fe.aomap,fe.lightmap,fe.emissivemap,fe.bumpmap,fe.normalmap,fe.displacementmap,fe.gradientmap,fe.fog,fe.lights,{emissive:{value:new ue(0)}}]),vertexShader:qe.meshtoon_vert,fragmentShader:qe.meshtoon_frag},matcap:{uniforms:Bt([fe.common,fe.bumpmap,fe.normalmap,fe.displacementmap,fe.fog,{matcap:{value:null}}]),vertexShader:qe.meshmatcap_vert,fragmentShader:qe.meshmatcap_frag},points:{uniforms:Bt([fe.points,fe.fog]),vertexShader:qe.points_vert,fragmentShader:qe.points_frag},dashed:{uniforms:Bt([fe.common,fe.fog,{scale:{value:1},dashSize:{value:1},totalSize:{value:2}}]),vertexShader:qe.linedashed_vert,fragmentShader:qe.linedashed_frag},depth:{uniforms:Bt([fe.common,fe.displacementmap]),vertexShader:qe.depth_vert,fragmentShader:qe.depth_frag},normal:{uniforms:Bt([fe.common,fe.bumpmap,fe.normalmap,fe.displacementmap,{opacity:{value:1}}]),vertexShader:qe.meshnormal_vert,fragmentShader:qe.meshnormal_frag},sprite:{uniforms:Bt([fe.sprite,fe.fog]),vertexShader:qe.sprite_vert,fragmentShader:qe.sprite_frag},background:{uniforms:{uvTransform:{value:new Ze},t2D:{value:null},backgroundIntensity:{value:1}},vertexShader:qe.background_vert,fragmentShader:qe.background_frag},backgroundCube:{uniforms:{envMap:{value:null},flipEnvMap:{value:-1},backgroundBlurriness:{value:0},backgroundIntensity:{value:1}},vertexShader:qe.backgroundCube_vert,fragmentShader:qe.backgroundCube_frag},cube:{uniforms:{tCube:{value:null},tFlip:{value:-1},opacity:{value:1}},vertexShader:qe.cube_vert,fragmentShader:qe.cube_frag},equirect:{uniforms:{tEquirect:{value:null}},vertexShader:qe.equirect_vert,fragmentShader:qe.equirect_frag},distanceRGBA:{uniforms:Bt([fe.common,fe.displacementmap,{referencePosition:{value:new T},nearDistance:{value:1},farDistance:{value:1000}}]),vertexShader:qe.distanceRGBA_vert,fragmentShader:qe.distanceRGBA_frag},shadow:{uniforms:Bt([fe.lights,fe.fog,{color:{value:new ue(0)},opacity:{value:1}}]),vertexShader:qe.shadow_vert,fragmentShader:qe.shadow_frag}};cn.physical={uniforms:Bt([cn.standard.uniforms,{clearcoat:{value:0},clearcoatMap:{value:null},clearcoatMapTransform:{value:new Ze},clearcoatNormalMap:{value:null},clearcoatNormalMapTransform:{value:new Ze},clearcoatNormalScale:{value:new W(1,1)},clearcoatRoughness:{value:0},clearcoatRoughnessMap:{value:null},clearcoatRoughnessMapTransform:{value:new Ze},iridescence:{value:0},iridescenceMap:{value:null},iridescenceMapTransform:{value:new Ze},iridescenceIOR:{value:1.3},iridescenceThicknessMinimum:{value:100},iridescenceThicknessMaximum:{value:400},iridescenceThicknessMap:{value:null},iridescenceThicknessMapTransform:{value:new Ze},sheen:{value:0},sheenColor:{value:new ue(0)},sheenColorMap:{value:null},sheenColorMapTransform:{value:new Ze},sheenRoughness:{value:1},sheenRoughnessMap:{value:null},sheenRoughnessMapTransform:{value:new Ze},transmission:{value:0},transmissionMap:{value:null},transmissionMapTransform:{value:new Ze},transmissionSamplerSize:{value:new W},transmissionSamplerMap:{value:null},thickness:{value:0},thicknessMap:{value:null},thicknessMapTransform:{value:new Ze},attenuationDistance:{value:0},attenuationColor:{value:new ue(0)},specularColor:{value:new ue(1,1,1)},specularColorMap:{value:null},specularColorMapTransform:{value:new Ze},specularIntensity:{value:1},specularIntensityMap:{value:null},specularIntensityMapTransform:{value:new Ze},anisotropyVector:{value:new W},anisotropyMap:{value:null},anisotropyMapTransform:{value:new Ze}}]),vertexShader:qe.meshphysical_vert,fragmentShader:qe.meshphysical_frag};var tr={r:0,b:0,g:0};function wm(e,t,n,i,s,r,a){let o=new ue(0),l=r===!0?0:1,c,h,u=null,d=0,f=null;function g(m,p){let x=!1,v=p.isScene===!0?p.background:null;if(v&&v.isTexture)v=(p.backgroundBlurriness>0?n:t).get(v);if(v===null)_(o,l);else if(v&&v.isColor)_(v,1),x=!0;let b=e.xr.getEnvironmentBlendMode();if(b==="additive")i.buffers.color.setClear(0,0,0,1,a);else if(b==="alpha-blend")i.buffers.color.setClear(0,0,0,0,a);if(e.autoClear||x)e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil);if(v&&(v.isCubeTexture||v.mapping===306)){if(h===void 0)h=new Je(new Bn(1,1,1),new Et({name:"BackgroundCubeMaterial",uniforms:Yi(cn.backgroundCube.uniforms),vertexShader:cn.backgroundCube.vertexShader,fragmentShader:cn.backgroundCube.fragmentShader,side:1,depthTest:!1,depthWrite:!1,fog:!1})),h.geometry.deleteAttribute("normal"),h.geometry.deleteAttribute("uv"),h.onBeforeRender=function(R,M,C){this.matrixWorld.copyPosition(C.matrixWorld)},Object.defineProperty(h.material,"envMap",{get:function(){return this.uniforms.envMap.value}}),s.update(h);if(h.material.uniforms.envMap.value=v,h.material.uniforms.flipEnvMap.value=v.isCubeTexture&&v.isRenderTargetTexture===!1?-1:1,h.material.uniforms.backgroundBlurriness.value=p.backgroundBlurriness,h.material.uniforms.backgroundIntensity.value=p.backgroundIntensity,h.material.toneMapped=nt.getTransfer(v.colorSpace)!=="srgb",u!==v||d!==v.version||f!==e.toneMapping)h.material.needsUpdate=!0,u=v,d=v.version,f=e.toneMapping;h.layers.enableAll(),m.unshift(h,h.geometry,h.material,0,0,null)}else if(v&&v.isTexture){if(c===void 0)c=new Je(new Or(2,2),new Et({name:"BackgroundMaterial",uniforms:Yi(cn.background.uniforms),vertexShader:cn.background.vertexShader,fragmentShader:cn.background.fragmentShader,side:0,depthTest:!1,depthWrite:!1,fog:!1})),c.geometry.deleteAttribute("normal"),Object.defineProperty(c.material,"map",{get:function(){return this.uniforms.t2D.value}}),s.update(c);if(c.material.uniforms.t2D.value=v,c.material.uniforms.backgroundIntensity.value=p.backgroundIntensity,c.material.toneMapped=nt.getTransfer(v.colorSpace)!=="srgb",v.matrixAutoUpdate===!0)v.updateMatrix();if(c.material.uniforms.uvTransform.value.copy(v.matrix),u!==v||d!==v.version||f!==e.toneMapping)c.material.needsUpdate=!0,u=v,d=v.version,f=e.toneMapping;c.layers.enableAll(),m.unshift(c,c.geometry,c.material,0,0,null)}}function _(m,p){m.getRGB(tr,th(e)),i.buffers.color.setClear(tr.r,tr.g,tr.b,p,a)}return{getClearColor:function(){return o},setClearColor:function(m,p=1){o.set(m),l=p,_(o,l)},getClearAlpha:function(){return l},setClearAlpha:function(m){l=m,_(o,l)},render:g}}function Rm(e,t,n,i){let s=e.getParameter(e.MAX_VERTEX_ATTRIBS),r=i.isWebGL2?null:t.get("OES_vertex_array_object"),a=i.isWebGL2||r!==null,o={},l=m(null),c=l,h=!1;function u(I,z,X,ne,V){let q=!1;if(a){let ee=_(ne,X,z);if(c!==ee)c=ee,f(c.object);if(q=p(I,ne,X,V),q)x(I,ne,X,V)}else{let ee=z.wireframe===!0;if(c.geometry!==ne.id||c.program!==X.id||c.wireframe!==ee)c.geometry=ne.id,c.program=X.id,c.wireframe=ee,q=!0}if(V!==null)n.update(V,e.ELEMENT_ARRAY_BUFFER);if(q||h){if(h=!1,D(I,z,X,ne),V!==null)e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,n.get(V).buffer)}}function d(){if(i.isWebGL2)return e.createVertexArray();return r.createVertexArrayOES()}function f(I){if(i.isWebGL2)return e.bindVertexArray(I);return r.bindVertexArrayOES(I)}function g(I){if(i.isWebGL2)return e.deleteVertexArray(I);return r.deleteVertexArrayOES(I)}function _(I,z,X){let ne=X.wireframe===!0,V=o[I.id];if(V===void 0)V={},o[I.id]=V;let q=V[z.id];if(q===void 0)q={},V[z.id]=q;let ee=q[ne];if(ee===void 0)ee=m(d()),q[ne]=ee;return ee}function m(I){let z=[],X=[],ne=[];for(let V=0;V<s;V++)z[V]=0,X[V]=0,ne[V]=0;return{geometry:null,program:null,wireframe:!1,newAttributes:z,enabledAttributes:X,attributeDivisors:ne,object:I,attributes:{},index:null}}function p(I,z,X,ne){let V=c.attributes,q=z.attributes,ee=0,oe=X.getAttributes();for(let O in oe)if(oe[O].location>=0){let ge=V[O],ve=q[O];if(ve===void 0){if(O==="instanceMatrix"&&I.instanceMatrix)ve=I.instanceMatrix;if(O==="instanceColor"&&I.instanceColor)ve=I.instanceColor}if(ge===void 0)return!0;if(ge.attribute!==ve)return!0;if(ve&&ge.data!==ve.data)return!0;ee++}if(c.attributesNum!==ee)return!0;if(c.index!==ne)return!0;return!1}function x(I,z,X,ne){let V={},q=z.attributes,ee=0,oe=X.getAttributes();for(let O in oe)if(oe[O].location>=0){let ge=q[O];if(ge===void 0){if(O==="instanceMatrix"&&I.instanceMatrix)ge=I.instanceMatrix;if(O==="instanceColor"&&I.instanceColor)ge=I.instanceColor}let ve={};if(ve.attribute=ge,ge&&ge.data)ve.data=ge.data;V[O]=ve,ee++}c.attributes=V,c.attributesNum=ee,c.index=ne}function v(){let I=c.newAttributes;for(let z=0,X=I.length;z<X;z++)I[z]=0}function b(I){R(I,0)}function R(I,z){let X=c.newAttributes,ne=c.enabledAttributes,V=c.attributeDivisors;if(X[I]=1,ne[I]===0)e.enableVertexAttribArray(I),ne[I]=1;if(V[I]!==z)(i.isWebGL2?e:t.get("ANGLE_instanced_arrays"))[i.isWebGL2?"vertexAttribDivisor":"vertexAttribDivisorANGLE"](I,z),V[I]=z}function M(){let I=c.newAttributes,z=c.enabledAttributes;for(let X=0,ne=z.length;X<ne;X++)if(z[X]!==I[X])e.disableVertexAttribArray(X),z[X]=0}function C(I,z,X,ne,V,q,ee){if(ee===!0)e.vertexAttribIPointer(I,z,X,V,q);else e.vertexAttribPointer(I,z,X,ne,V,q)}function D(I,z,X,ne){if(i.isWebGL2===!1&&(I.isInstancedMesh||ne.isInstancedBufferGeometry)){if(t.get("ANGLE_instanced_arrays")===null)return}v();let V=ne.attributes,q=X.getAttributes(),ee=z.defaultAttributeValues;for(let oe in q){let O=q[oe];if(O.location>=0){let te=V[oe];if(te===void 0){if(oe==="instanceMatrix"&&I.instanceMatrix)te=I.instanceMatrix;if(oe==="instanceColor"&&I.instanceColor)te=I.instanceColor}if(te!==void 0){let ge=te.normalized,ve=te.itemSize,Ee=n.get(te);if(Ee===void 0)continue;let{buffer:Ie,type:ke,bytesPerElement:we}=Ee,Ge=i.isWebGL2===!0&&(ke===e.INT||ke===e.UNSIGNED_INT||te.gpuType===1013);if(te.isInterleavedBufferAttribute){let P=te.data,ce=P.stride,j=te.offset;if(P.isInstancedInterleavedBuffer){for(let Q=0;Q<O.locationSize;Q++)R(O.location+Q,P.meshPerAttribute);if(I.isInstancedMesh!==!0&&ne._maxInstanceCount===void 0)ne._maxInstanceCount=P.meshPerAttribute*P.count}else for(let Q=0;Q<O.locationSize;Q++)b(O.location+Q);e.bindBuffer(e.ARRAY_BUFFER,Ie);for(let Q=0;Q<O.locationSize;Q++)C(O.location+Q,ve/O.locationSize,ke,ge,ce*we,(j+ve/O.locationSize*Q)*we,Ge)}else{if(te.isInstancedBufferAttribute){for(let P=0;P<O.locationSize;P++)R(O.location+P,te.meshPerAttribute);if(I.isInstancedMesh!==!0&&ne._maxInstanceCount===void 0)ne._maxInstanceCount=te.meshPerAttribute*te.count}else for(let P=0;P<O.locationSize;P++)b(O.location+P);e.bindBuffer(e.ARRAY_BUFFER,Ie);for(let P=0;P<O.locationSize;P++)C(O.location+P,ve/O.locationSize,ke,ge,ve*we,ve/O.locationSize*P*we,Ge)}}else if(ee!==void 0){let ge=ee[oe];if(ge!==void 0)switch(ge.length){case 2:e.vertexAttrib2fv(O.location,ge);break;case 3:e.vertexAttrib3fv(O.location,ge);break;case 4:e.vertexAttrib4fv(O.location,ge);break;default:e.vertexAttrib1fv(O.location,ge)}}}}M()}function S(){J();for(let I in o){let z=o[I];for(let X in z){let ne=z[X];for(let V in ne)g(ne[V].object),delete ne[V];delete z[X]}delete o[I]}}function w(I){if(o[I.id]===void 0)return;let z=o[I.id];for(let X in z){let ne=z[X];for(let V in ne)g(ne[V].object),delete ne[V];delete z[X]}delete o[I.id]}function U(I){for(let z in o){let X=o[z];if(X[I.id]===void 0)continue;let ne=X[I.id];for(let V in ne)g(ne[V].object),delete ne[V];delete X[I.id]}}function J(){if(ae(),h=!0,c===l)return;c=l,f(c.object)}function ae(){l.geometry=null,l.program=null,l.wireframe=!1}return{setup:u,reset:J,resetDefaultState:ae,dispose:S,releaseStatesOfGeometry:w,releaseStatesOfProgram:U,initAttributes:v,enableAttribute:b,disableUnusedAttributes:M}}function Cm(e,t,n,i){let s=i.isWebGL2,r;function a(h){r=h}function o(h,u){e.drawArrays(r,h,u),n.update(u,r,1)}function l(h,u,d){if(d===0)return;let f,g;if(s)f=e,g="drawArraysInstanced";else if(f=t.get("ANGLE_instanced_arrays"),g="drawArraysInstancedANGLE",f===null){console.error("THREE.WebGLBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}f[g](r,h,u,d),n.update(u,r,d)}function c(h,u,d){if(d===0)return;let f=t.get("WEBGL_multi_draw");if(f===null)for(let g=0;g<d;g++)this.render(h[g],u[g]);else{f.multiDrawArraysWEBGL(r,h,0,u,0,d);let g=0;for(let _=0;_<d;_++)g+=u[_];n.update(g,r,1)}}this.setMode=a,this.render=o,this.renderInstances=l,this.renderMultiDraw=c}function Pm(e,t,n){let i;function s(){if(i!==void 0)return i;if(t.has("EXT_texture_filter_anisotropic")===!0){let C=t.get("EXT_texture_filter_anisotropic");i=e.getParameter(C.MAX_TEXTURE_MAX_ANISOTROPY_EXT)}else i=0;return i}function r(C){if(C==="highp"){if(e.getShaderPrecisionFormat(e.VERTEX_SHADER,e.HIGH_FLOAT).precision>0&&e.getShaderPrecisionFormat(e.FRAGMENT_SHADER,e.HIGH_FLOAT).precision>0)return"highp";C="mediump"}if(C==="mediump"){if(e.getShaderPrecisionFormat(e.VERTEX_SHADER,e.MEDIUM_FLOAT).precision>0&&e.getShaderPrecisionFormat(e.FRAGMENT_SHADER,e.MEDIUM_FLOAT).precision>0)return"mediump"}return"lowp"}let a=typeof WebGL2RenderingContext<"u"&&e.constructor.name==="WebGL2RenderingContext",o=n.precision!==void 0?n.precision:"highp",l=r(o);if(l!==o)console.warn("THREE.WebGLRenderer:",o,"not supported, using",l,"instead."),o=l;let c=a||t.has("WEBGL_draw_buffers"),h=n.logarithmicDepthBuffer===!0,u=e.getParameter(e.MAX_TEXTURE_IMAGE_UNITS),d=e.getParameter(e.MAX_VERTEX_TEXTURE_IMAGE_UNITS),f=e.getParameter(e.MAX_TEXTURE_SIZE),g=e.getParameter(e.MAX_CUBE_MAP_TEXTURE_SIZE),_=e.getParameter(e.MAX_VERTEX_ATTRIBS),m=e.getParameter(e.MAX_VERTEX_UNIFORM_VECTORS),p=e.getParameter(e.MAX_VARYING_VECTORS),x=e.getParameter(e.MAX_FRAGMENT_UNIFORM_VECTORS),v=d>0,b=a||t.has("OES_texture_float"),R=v&&b,M=a?e.getParameter(e.MAX_SAMPLES):0;return{isWebGL2:a,drawBuffers:c,getMaxAnisotropy:s,getMaxPrecision:r,precision:o,logarithmicDepthBuffer:h,maxTextures:u,maxVertexTextures:d,maxTextureSize:f,maxCubemapSize:g,maxAttributes:_,maxVertexUniforms:m,maxVaryings:p,maxFragmentUniforms:x,vertexTextures:v,floatFragmentTextures:b,floatVertexTextures:R,maxSamples:M}}function Lm(e){let t=this,n=null,i=0,s=!1,r=!1,a=new ln,o=new Ze,l={value:null,needsUpdate:!1};this.uniform=l,this.numPlanes=0,this.numIntersection=0,this.init=function(u,d){let f=u.length!==0||d||i!==0||s;return s=d,i=u.length,f},this.beginShadows=function(){r=!0,h(null)},this.endShadows=function(){r=!1},this.setGlobalState=function(u,d){n=h(u,d,0)},this.setState=function(u,d,f){let{clippingPlanes:g,clipIntersection:_,clipShadows:m}=u,p=e.get(u);if(!s||g===null||g.length===0||r&&!m)if(r)h(null);else c();else{let x=r?0:i,v=x*4,b=p.clippingState||null;l.value=b,b=h(g,d,v,f);for(let R=0;R!==v;++R)b[R]=n[R];p.clippingState=b,this.numIntersection=_?this.numPlanes:0,this.numPlanes+=x}};function c(){if(l.value!==n)l.value=n,l.needsUpdate=i>0;t.numPlanes=i,t.numIntersection=0}function h(u,d,f,g){let _=u!==null?u.length:0,m=null;if(_!==0){if(m=l.value,g!==!0||m===null){let p=f+_*4,x=d.matrixWorldInverse;if(o.getNormalMatrix(x),m===null||m.length<p)m=new Float32Array(p);for(let v=0,b=f;v!==_;++v,b+=4)a.copy(u[v]).applyMatrix4(x,o),a.normal.toArray(m,b),m[b+3]=a.constant}l.value=m,l.needsUpdate=!0}return t.numPlanes=_,t.numIntersection=0,m}}function Im(e){let t=new WeakMap;function n(a,o){if(o===303)a.mapping=301;else if(o===304)a.mapping=302;return a}function i(a){if(a&&a.isTexture){let o=a.mapping;if(o===303||o===304)if(t.has(a)){let l=t.get(a).texture;return n(l,a.mapping)}else{let l=a.image;if(l&&l.height>0){let c=new ih(l.height/2);return c.fromEquirectangularTexture(e,a),t.set(a,c),a.addEventListener("dispose",s),n(c.texture,a.mapping)}else return null}}return a}function s(a){let o=a.target;o.removeEventListener("dispose",s);let l=t.get(o);if(l!==void 0)t.delete(o),l.dispose()}function r(){t=new WeakMap}return{get:i,dispose:r}}class kn extends Fr{constructor(e=-1,t=1,n=1,i=-1,s=0.1,r=2000){super();this.isOrthographicCamera=!0,this.type="OrthographicCamera",this.zoom=1,this.view=null,this.left=e,this.right=t,this.top=n,this.bottom=i,this.near=s,this.far=r,this.updateProjectionMatrix()}copy(e,t){return super.copy(e,t),this.left=e.left,this.right=e.right,this.top=e.top,this.bottom=e.bottom,this.near=e.near,this.far=e.far,this.zoom=e.zoom,this.view=e.view===null?null:Object.assign({},e.view),this}setViewOffset(e,t,n,i,s,r){if(this.view===null)this.view={enabled:!0,fullWidth:1,fullHeight:1,offsetX:0,offsetY:0,width:1,height:1};this.view.enabled=!0,this.view.fullWidth=e,this.view.fullHeight=t,this.view.offsetX=n,this.view.offsetY=i,this.view.width=s,this.view.height=r,this.updateProjectionMatrix()}clearViewOffset(){if(this.view!==null)this.view.enabled=!1;this.updateProjectionMatrix()}updateProjectionMatrix(){let e=(this.right-this.left)/(2*this.zoom),t=(this.top-this.bottom)/(2*this.zoom),n=(this.right+this.left)/2,i=(this.top+this.bottom)/2,s=n-e,r=n+e,a=i+t,o=i-t;if(this.view!==null&&this.view.enabled){let l=(this.right-this.left)/this.view.fullWidth/this.zoom,c=(this.top-this.bottom)/this.view.fullHeight/this.zoom;s+=l*this.view.offsetX,r=s+l*this.view.width,a-=c*this.view.offsetY,o=a-c*this.view.height}this.projectionMatrix.makeOrthographic(s,r,a,o,this.near,this.far,this.coordinateSystem),this.projectionMatrixInverse.copy(this.projectionMatrix).invert()}toJSON(e){let t=super.toJSON(e);if(t.object.zoom=this.zoom,t.object.left=this.left,t.object.right=this.right,t.object.top=this.top,t.object.bottom=this.bottom,t.object.near=this.near,t.object.far=this.far,this.view!==null)t.object.view=Object.assign({},this.view);return t}}var Hi=4,Sl=[0.125,0.215,0.35,0.446,0.526,0.582],ii=20,Ea=new kn,Ml=new ue,wa=null,Ra=0,Ca=0,ni=(1+Math.sqrt(5))/2,Di=1/ni,bl=[new T(1,1,1),new T(-1,1,1),new T(1,1,-1),new T(-1,1,-1),new T(0,ni,Di),new T(0,ni,-Di),new T(Di,0,ni),new T(-Di,0,ni),new T(ni,Di,0),new T(-ni,Di,0)];class qa{constructor(e){this._renderer=e,this._pingPongRenderTarget=null,this._lodMax=0,this._cubeSize=0,this._lodPlanes=[],this._sizeLods=[],this._sigmas=[],this._blurMaterial=null,this._cubemapMaterial=null,this._equirectMaterial=null,this._compileMaterial(this._blurMaterial)}fromScene(e,t=0,n=0.1,i=100){wa=this._renderer.getRenderTarget(),Ra=this._renderer.getActiveCubeFace(),Ca=this._renderer.getActiveMipmapLevel(),this._setSize(256);let s=this._allocateTargets();if(s.depthBuffer=!0,this._sceneToCubeUV(e,n,i,s),t>0)this._blur(s,0,0,t);return this._applyPMREM(s),this._cleanup(s),s}fromEquirectangular(e,t=null){return this._fromTexture(e,t)}fromCubemap(e,t=null){return this._fromTexture(e,t)}compileCubemapShader(){if(this._cubemapMaterial===null)this._cubemapMaterial=El(),this._compileMaterial(this._cubemapMaterial)}compileEquirectangularShader(){if(this._equirectMaterial===null)this._equirectMaterial=Al(),this._compileMaterial(this._equirectMaterial)}dispose(){if(this._dispose(),this._cubemapMaterial!==null)this._cubemapMaterial.dispose();if(this._equirectMaterial!==null)this._equirectMaterial.dispose()}_setSize(e){this._lodMax=Math.floor(Math.log2(e)),this._cubeSize=Math.pow(2,this._lodMax)}_dispose(){if(this._blurMaterial!==null)this._blurMaterial.dispose();if(this._pingPongRenderTarget!==null)this._pingPongRenderTarget.dispose();for(let e=0;e<this._lodPlanes.length;e++)this._lodPlanes[e].dispose()}_cleanup(e){this._renderer.setRenderTarget(wa,Ra,Ca),e.scissorTest=!1,nr(e,0,0,e.width,e.height)}_fromTexture(e,t){if(e.mapping===301||e.mapping===302)this._setSize(e.image.length===0?16:e.image[0].width||e.image[0].image.width);else this._setSize(e.image.width/4);wa=this._renderer.getRenderTarget(),Ra=this._renderer.getActiveCubeFace(),Ca=this._renderer.getActiveMipmapLevel();let n=t||this._allocateTargets();return this._textureToCubeUV(e,n),this._applyPMREM(n),this._cleanup(n),n}_allocateTargets(){let e=3*Math.max(this._cubeSize,112),t=4*this._cubeSize,n={magFilter:1006,minFilter:1006,generateMipmaps:!1,type:1016,format:1023,colorSpace:"srgb-linear",depthBuffer:!1},i=Tl(e,t,n);if(this._pingPongRenderTarget===null||this._pingPongRenderTarget.width!==e||this._pingPongRenderTarget.height!==t){if(this._pingPongRenderTarget!==null)this._dispose();this._pingPongRenderTarget=Tl(e,t,n);let{_lodMax:s}=this;({sizeLods:this._sizeLods,lodPlanes:this._lodPlanes,sigmas:this._sigmas}=Nm(s)),this._blurMaterial=Dm(s,e,t)}return i}_compileMaterial(e){let t=new Je(this._lodPlanes[0],e);this._renderer.compile(t,Ea)}_sceneToCubeUV(e,t,n,i){let a=new yt(90,1,t,n),o=[1,-1,1,1,1,1],l=[1,1,1,-1,-1,-1],c=this._renderer,{autoClear:h,toneMapping:u}=c;c.getClearColor(Ml),c.toneMapping=0,c.autoClear=!1;let d=new wt({name:"PMREM.Background",side:1,depthWrite:!1,depthTest:!1}),f=new Je(new Bn,d),g=!1,_=e.background;if(_){if(_.isColor)d.color.copy(_),e.background=null,g=!0}else d.color.copy(Ml),g=!0;for(let m=0;m<6;m++){let p=m%3;if(p===0)a.up.set(0,o[m],0),a.lookAt(l[m],0,0);else if(p===1)a.up.set(0,0,o[m]),a.lookAt(0,l[m],0);else a.up.set(0,o[m],0),a.lookAt(0,0,l[m]);let x=this._cubeSize;if(nr(i,p*x,m>2?x:0,x,x),c.setRenderTarget(i),g)c.render(f,a);c.render(e,a)}f.geometry.dispose(),f.material.dispose(),c.toneMapping=u,c.autoClear=h,e.background=_}_textureToCubeUV(e,t){let n=this._renderer,i=e.mapping===301||e.mapping===302;if(i){if(this._cubemapMaterial===null)this._cubemapMaterial=El();this._cubemapMaterial.uniforms.flipEnvMap.value=e.isRenderTargetTexture===!1?-1:1}else if(this._equirectMaterial===null)this._equirectMaterial=Al();let s=i?this._cubemapMaterial:this._equirectMaterial,r=new Je(this._lodPlanes[0],s),a=s.uniforms;a.envMap.value=e;let o=this._cubeSize;nr(t,0,0,3*o,2*o),n.setRenderTarget(t),n.render(r,Ea)}_applyPMREM(e){let t=this._renderer,n=t.autoClear;t.autoClear=!1;for(let i=1;i<this._lodPlanes.length;i++){let s=Math.sqrt(this._sigmas[i]*this._sigmas[i]-this._sigmas[i-1]*this._sigmas[i-1]),r=bl[(i-1)%bl.length];this._blur(e,i-1,i,s,r)}t.autoClear=n}_blur(e,t,n,i,s){let r=this._pingPongRenderTarget;this._halfBlur(e,r,t,n,i,"latitudinal",s),this._halfBlur(r,e,n,n,i,"longitudinal",s)}_halfBlur(e,t,n,i,s,r,a){let o=this._renderer,l=this._blurMaterial;if(r!=="latitudinal"&&r!=="longitudinal")console.error("blur direction must be either latitudinal or longitudinal!");let c=3,h=new Je(this._lodPlanes[i],l),u=l.uniforms,d=this._sizeLods[n]-1,f=isFinite(s)?Math.PI/(2*d):2*Math.PI/(2*ii-1),g=s/f,_=isFinite(s)?1+Math.floor(c*g):ii;if(_>ii)console.warn(`sigmaRadians, ${s}, is too large and will clip, as it requested ${_} samples when the maximum is set to ${ii}`);let m=[],p=0;for(let M=0;M<ii;++M){let C=M/g,D=Math.exp(-C*C/2);if(m.push(D),M===0)p+=D;else if(M<_)p+=2*D}for(let M=0;M<m.length;M++)m[M]=m[M]/p;if(u.envMap.value=e.texture,u.samples.value=_,u.weights.value=m,u.latitudinal.value=r==="latitudinal",a)u.poleAxis.value=a;let{_lodMax:x}=this;u.dTheta.value=f,u.mipInt.value=x-n;let v=this._sizeLods[i],b=3*v*(i>x-Hi?i-x+Hi:0),R=4*(this._cubeSize-v);nr(t,b,R,3*v,2*v),o.setRenderTarget(t),o.render(h,Ea)}}function Nm(e){let t=[],n=[],i=[],s=e,r=e-Hi+1+Sl.length;for(let a=0;a<r;a++){let o=Math.pow(2,s);n.push(o);let l=1/o;if(a>e-Hi)l=Sl[a-e+Hi-1];else if(a===0)l=0;i.push(l);let c=1/(o-2),h=-c,u=1+c,d=[h,h,u,h,u,u,h,h,u,u,h,u],f=6,g=6,_=3,m=2,p=1,x=new Float32Array(_*g*f),v=new Float32Array(m*g*f),b=new Float32Array(p*g*f);for(let M=0;M<f;M++){let C=M%3*2/3-1,D=M>2?0:-1,S=[C,D,0,C+0.6666666666666666,D,0,C+0.6666666666666666,D+1,0,C,D,0,C+0.6666666666666666,D+1,0,C,D+1,0];x.set(S,_*g*M),v.set(d,m*g*M);let w=[M,M,M,M,M,M];b.set(w,p*g*M)}let R=new ze;if(R.setAttribute("position",new tt(x,_)),R.setAttribute("uv",new tt(v,m)),R.setAttribute("faceIndex",new tt(b,p)),t.push(R),s>Hi)s--}return{lodPlanes:t,sizeLods:n,sigmas:i}}function Tl(e,t,n){let i=new Ct(e,t,n);return i.texture.mapping=306,i.texture.name="PMREM.cubeUv",i.scissorTest=!0,i}function nr(e,t,n,i,s){e.viewport.set(t,n,i,s),e.scissor.set(t,n,i,s)}function Dm(e,t,n){let i=new Float32Array(ii),s=new T(0,1,0);return new Et({name:"SphericalGaussianBlur",defines:{n:ii,CUBEUV_TEXEL_WIDTH:1/t,CUBEUV_TEXEL_HEIGHT:1/n,CUBEUV_MAX_MIP:`${e}.0`},uniforms:{envMap:{value:null},samples:{value:1},weights:{value:i},latitudinal:{value:!1},dTheta:{value:0},mipInt:{value:0},poleAxis:{value:s}},vertexShader:oo(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;
			uniform int samples;
			uniform float weights[ n ];
			uniform bool latitudinal;
			uniform float dTheta;
			uniform float mipInt;
			uniform vec3 poleAxis;

			#define ENVMAP_TYPE_CUBE_UV
			#include <cube_uv_reflection_fragment>

			vec3 getSample( float theta, vec3 axis ) {

				float cosTheta = cos( theta );
				// Rodrigues' axis-angle rotation
				vec3 sampleDirection = vOutputDirection * cosTheta
					+ cross( axis, vOutputDirection ) * sin( theta )
					+ axis * dot( axis, vOutputDirection ) * ( 1.0 - cosTheta );

				return bilinearCubeUV( envMap, sampleDirection, mipInt );

			}

			void main() {

				vec3 axis = latitudinal ? poleAxis : cross( poleAxis, vOutputDirection );

				if ( all( equal( axis, vec3( 0.0 ) ) ) ) {

					axis = vec3( vOutputDirection.z, 0.0, - vOutputDirection.x );

				}

				axis = normalize( axis );

				gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
				gl_FragColor.rgb += weights[ 0 ] * getSample( 0.0, axis );

				for ( int i = 1; i < n; i++ ) {

					if ( i >= samples ) {

						break;

					}

					float theta = dTheta * float( i );
					gl_FragColor.rgb += weights[ i ] * getSample( -1.0 * theta, axis );
					gl_FragColor.rgb += weights[ i ] * getSample( theta, axis );

				}

			}
		`,blending:0,depthTest:!1,depthWrite:!1})}function Al(){return new Et({name:"EquirectangularToCubeUV",uniforms:{envMap:{value:null}},vertexShader:oo(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			varying vec3 vOutputDirection;

			uniform sampler2D envMap;

			#include <common>

			void main() {

				vec3 outputDirection = normalize( vOutputDirection );
				vec2 uv = equirectUv( outputDirection );

				gl_FragColor = vec4( texture2D ( envMap, uv ).rgb, 1.0 );

			}
		`,blending:0,depthTest:!1,depthWrite:!1})}function El(){return new Et({name:"CubemapToCubeUV",uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:oo(),fragmentShader:`

			precision mediump float;
			precision mediump int;

			uniform float flipEnvMap;

			varying vec3 vOutputDirection;

			uniform samplerCube envMap;

			void main() {

				gl_FragColor = textureCube( envMap, vec3( flipEnvMap * vOutputDirection.x, vOutputDirection.yz ) );

			}
		`,blending:0,depthTest:!1,depthWrite:!1})}function oo(){return`

		precision mediump float;
		precision mediump int;

		attribute float faceIndex;

		varying vec3 vOutputDirection;

		// RH coordinate system; PMREM face-indexing convention
		vec3 getDirection( vec2 uv, float face ) {

			uv = 2.0 * uv - 1.0;

			vec3 direction = vec3( uv, 1.0 );

			if ( face == 0.0 ) {

				direction = direction.zyx; // ( 1, v, u ) pos x

			} else if ( face == 1.0 ) {

				direction = direction.xzy;
				direction.xz *= -1.0; // ( -u, 1, -v ) pos y

			} else if ( face == 2.0 ) {

				direction.x *= -1.0; // ( -u, v, 1 ) pos z

			} else if ( face == 3.0 ) {

				direction = direction.zyx;
				direction.xz *= -1.0; // ( -1, v, -u ) neg x

			} else if ( face == 4.0 ) {

				direction = direction.xzy;
				direction.xy *= -1.0; // ( -u, -1, v ) neg y

			} else if ( face == 5.0 ) {

				direction.z *= -1.0; // ( u, v, -1 ) neg z

			}

			return direction;

		}

		void main() {

			vOutputDirection = getDirection( uv, faceIndex );
			gl_Position = vec4( position, 1.0 );

		}
	`}function Um(e){let t=new WeakMap,n=null;function i(o){if(o&&o.isTexture){let l=o.mapping,c=l===303||l===304,h=l===301||l===302;if(c||h)if(o.isRenderTargetTexture&&o.needsPMREMUpdate===!0){o.needsPMREMUpdate=!1;let u=t.get(o);if(n===null)n=new qa(e);return u=c?n.fromEquirectangular(o,u):n.fromCubemap(o,u),t.set(o,u),u.texture}else if(t.has(o))return t.get(o).texture;else{let u=o.image;if(c&&u&&u.height>0||h&&u&&s(u)){if(n===null)n=new qa(e);let d=c?n.fromEquirectangular(o):n.fromCubemap(o);return t.set(o,d),o.addEventListener("dispose",r),d.texture}else return null}}return o}function s(o){let l=0,c=6;for(let h=0;h<c;h++)if(o[h]!==void 0)l++;return l===c}function r(o){let l=o.target;l.removeEventListener("dispose",r);let c=t.get(l);if(c!==void 0)t.delete(l),c.dispose()}function a(){if(t=new WeakMap,n!==null)n.dispose(),n=null}return{get:i,dispose:a}}function Fm(e){let t={};function n(i){if(t[i]!==void 0)return t[i];let s;switch(i){case"WEBGL_depth_texture":s=e.getExtension("WEBGL_depth_texture")||e.getExtension("MOZ_WEBGL_depth_texture")||e.getExtension("WEBKIT_WEBGL_depth_texture");break;case"EXT_texture_filter_anisotropic":s=e.getExtension("EXT_texture_filter_anisotropic")||e.getExtension("MOZ_EXT_texture_filter_anisotropic")||e.getExtension("WEBKIT_EXT_texture_filter_anisotropic");break;case"WEBGL_compressed_texture_s3tc":s=e.getExtension("WEBGL_compressed_texture_s3tc")||e.getExtension("MOZ_WEBGL_compressed_texture_s3tc")||e.getExtension("WEBKIT_WEBGL_compressed_texture_s3tc");break;case"WEBGL_compressed_texture_pvrtc":s=e.getExtension("WEBGL_compressed_texture_pvrtc")||e.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc");break;default:s=e.getExtension(i)}return t[i]=s,s}return{has:function(i){return n(i)!==null},init:function(i){if(i.isWebGL2)n("EXT_color_buffer_float"),n("WEBGL_clip_cull_distance");else n("WEBGL_depth_texture"),n("OES_texture_float"),n("OES_texture_half_float"),n("OES_texture_half_float_linear"),n("OES_standard_derivatives"),n("OES_element_index_uint"),n("OES_vertex_array_object"),n("ANGLE_instanced_arrays");n("OES_texture_float_linear"),n("EXT_color_buffer_half_float"),n("WEBGL_multisampled_render_to_texture")},get:function(i){let s=n(i);if(s===null)console.warn("THREE.WebGLRenderer: "+i+" extension not supported.");return s}}}function Om(e,t,n,i){let s={},r=new WeakMap;function a(u){let d=u.target;if(d.index!==null)t.remove(d.index);for(let g in d.attributes)t.remove(d.attributes[g]);for(let g in d.morphAttributes){let _=d.morphAttributes[g];for(let m=0,p=_.length;m<p;m++)t.remove(_[m])}d.removeEventListener("dispose",a),delete s[d.id];let f=r.get(d);if(f)t.remove(f),r.delete(d);if(i.releaseStatesOfGeometry(d),d.isInstancedBufferGeometry===!0)delete d._maxInstanceCount;n.memory.geometries--}function o(u,d){if(s[d.id]===!0)return d;return d.addEventListener("dispose",a),s[d.id]=!0,n.memory.geometries++,d}function l(u){let d=u.attributes;for(let g in d)t.update(d[g],e.ARRAY_BUFFER);let f=u.morphAttributes;for(let g in f){let _=f[g];for(let m=0,p=_.length;m<p;m++)t.update(_[m],e.ARRAY_BUFFER)}}function c(u){let d=[],f=u.index,g=u.attributes.position,_=0;if(f!==null){let x=f.array;_=f.version;for(let v=0,b=x.length;v<b;v+=3){let R=x[v+0],M=x[v+1],C=x[v+2];d.push(R,M,M,C,C,R)}}else if(g!==void 0){let x=g.array;_=g.version;for(let v=0,b=x.length/3-1;v<b;v+=3){let R=v+0,M=v+1,C=v+2;d.push(R,M,M,C,C,R)}}else return;let m=new((jc(d))?ao:ro)(d,1);m.version=_;let p=r.get(u);if(p)t.remove(p);r.set(u,m)}function h(u){let d=r.get(u);if(d){let f=u.index;if(f!==null){if(d.version<f.version)c(u)}}else c(u);return r.get(u)}return{get:o,update:l,getWireframeAttribute:h}}function Bm(e,t,n,i){let s=i.isWebGL2,r;function a(f){r=f}let o,l;function c(f){o=f.type,l=f.bytesPerElement}function h(f,g){e.drawElements(r,g,o,f*l),n.update(g,r,1)}function u(f,g,_){if(_===0)return;let m,p;if(s)m=e,p="drawElementsInstanced";else if(m=t.get("ANGLE_instanced_arrays"),p="drawElementsInstancedANGLE",m===null){console.error("THREE.WebGLIndexedBufferRenderer: using THREE.InstancedBufferGeometry but hardware does not support extension ANGLE_instanced_arrays.");return}m[p](r,g,o,f*l,_),n.update(g,r,_)}function d(f,g,_){if(_===0)return;let m=t.get("WEBGL_multi_draw");if(m===null)for(let p=0;p<_;p++)this.render(f[p]/l,g[p]);else{m.multiDrawElementsWEBGL(r,g,0,o,f,0,_);let p=0;for(let x=0;x<_;x++)p+=g[x];n.update(p,r,1)}}this.setMode=a,this.setIndex=c,this.render=h,this.renderInstances=u,this.renderMultiDraw=d}function zm(e){let t={geometries:0,textures:0},n={frame:0,calls:0,triangles:0,points:0,lines:0};function i(r,a,o){switch(n.calls++,a){case e.TRIANGLES:n.triangles+=o*(r/3);break;case e.LINES:n.lines+=o*(r/2);break;case e.LINE_STRIP:n.lines+=o*(r-1);break;case e.LINE_LOOP:n.lines+=o*r;break;case e.POINTS:n.points+=o*r;break;default:console.error("THREE.WebGLInfo: Unknown draw mode:",a);break}}function s(){n.calls=0,n.triangles=0,n.points=0,n.lines=0}return{memory:t,render:n,programs:null,autoReset:!0,reset:s,update:i}}function km(e,t){return e[0]-t[0]}function Gm(e,t){return Math.abs(t[1])-Math.abs(e[1])}function Hm(e,t,n){let i={},s=new Float32Array(8),r=new WeakMap,a=new at,o=[];for(let c=0;c<8;c++)o[c]=[c,0];function l(c,h,u){let d=c.morphTargetInfluences;if(t.isWebGL2===!0){let f=h.morphAttributes.position||h.morphAttributes.normal||h.morphAttributes.color,g=f!==void 0?f.length:0,_=r.get(h);if(_===void 0||_.count!==g){let I=function(){J.dispose(),r.delete(h),h.removeEventListener("dispose",I)};if(_!==void 0)_.texture.dispose();let x=h.morphAttributes.position!==void 0,v=h.morphAttributes.normal!==void 0,b=h.morphAttributes.color!==void 0,R=h.morphAttributes.position||[],M=h.morphAttributes.normal||[],C=h.morphAttributes.color||[],D=0;if(x===!0)D=1;if(v===!0)D=2;if(b===!0)D=3;let S=h.attributes.position.count*D,w=1;if(S>t.maxTextureSize)w=Math.ceil(S/t.maxTextureSize),S=t.maxTextureSize;let U=new Float32Array(S*w*4*g),J=new Nr(U,S,w,g);J.type=1015,J.needsUpdate=!0;let ae=D*4;for(let z=0;z<g;z++){let X=R[z],ne=M[z],V=C[z],q=S*w*4*z;for(let ee=0;ee<X.count;ee++){let oe=ee*ae;if(x===!0)a.fromBufferAttribute(X,ee),U[q+oe+0]=a.x,U[q+oe+1]=a.y,U[q+oe+2]=a.z,U[q+oe+3]=0;if(v===!0)a.fromBufferAttribute(ne,ee),U[q+oe+4]=a.x,U[q+oe+5]=a.y,U[q+oe+6]=a.z,U[q+oe+7]=0;if(b===!0)a.fromBufferAttribute(V,ee),U[q+oe+8]=a.x,U[q+oe+9]=a.y,U[q+oe+10]=a.z,U[q+oe+11]=V.itemSize===4?a.w:1}}_={count:g,texture:J,size:new W(S,w)},r.set(h,_),h.addEventListener("dispose",I)}let m=0;for(let x=0;x<d.length;x++)m+=d[x];let p=h.morphTargetsRelative?1:1-m;u.getUniforms().setValue(e,"morphTargetBaseInfluence",p),u.getUniforms().setValue(e,"morphTargetInfluences",d),u.getUniforms().setValue(e,"morphTargetsTexture",_.texture,n),u.getUniforms().setValue(e,"morphTargetsTextureSize",_.size)}else{let f=d===void 0?0:d.length,g=i[h.id];if(g===void 0||g.length!==f){g=[];for(let v=0;v<f;v++)g[v]=[v,0];i[h.id]=g}for(let v=0;v<f;v++){let b=g[v];b[0]=v,b[1]=d[v]}g.sort(Gm);for(let v=0;v<8;v++)if(v<f&&g[v][1])o[v][0]=g[v][0],o[v][1]=g[v][1];else o[v][0]=Number.MAX_SAFE_INTEGER,o[v][1]=0;o.sort(km);let _=h.morphAttributes.position,m=h.morphAttributes.normal,p=0;for(let v=0;v<8;v++){let b=o[v],R=b[0],M=b[1];if(R!==Number.MAX_SAFE_INTEGER&&M){if(_&&h.getAttribute("morphTarget"+v)!==_[R])h.setAttribute("morphTarget"+v,_[R]);if(m&&h.getAttribute("morphNormal"+v)!==m[R])h.setAttribute("morphNormal"+v,m[R]);s[v]=M,p+=M}else{if(_&&h.hasAttribute("morphTarget"+v)===!0)h.deleteAttribute("morphTarget"+v);if(m&&h.hasAttribute("morphNormal"+v)===!0)h.deleteAttribute("morphNormal"+v);s[v]=0}}let x=h.morphTargetsRelative?1:1-p;u.getUniforms().setValue(e,"morphTargetBaseInfluence",x),u.getUniforms().setValue(e,"morphTargetInfluences",s)}}return{update:l}}function Wm(e,t,n,i){let s=new WeakMap;function r(l){let c=i.render.frame,h=l.geometry,u=t.get(l,h);if(s.get(u)!==c)t.update(u),s.set(u,c);if(l.isInstancedMesh){if(l.hasEventListener("dispose",o)===!1)l.addEventListener("dispose",o);if(s.get(l)!==c){if(n.update(l.instanceMatrix,e.ARRAY_BUFFER),l.instanceColor!==null)n.update(l.instanceColor,e.ARRAY_BUFFER);s.set(l,c)}}if(l.isSkinnedMesh){let d=l.skeleton;if(s.get(d)!==c)d.update(),s.set(d,c)}return u}function a(){s=new WeakMap}function o(l){let c=l.target;if(c.removeEventListener("dispose",o),n.remove(c.instanceMatrix),c.instanceColor!==null)n.remove(c.instanceColor)}return{update:r,dispose:a}}class lo extends ht{constructor(e,t,n,i,s,r,a,o,l,c){if(c=c!==void 0?c:1026,c!==1026&&c!==1027)throw Error("DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat");if(n===void 0&&c===1026)n=1014;if(n===void 0&&c===1027)n=1020;super(null,i,s,r,a,o,c,n,l);this.isDepthTexture=!0,this.image={width:e,height:t},this.magFilter=a!==void 0?a:1003,this.minFilter=o!==void 0?o:1003,this.flipY=!1,this.generateMipmaps=!1,this.compareFunction=null}copy(e){return super.copy(e),this.compareFunction=e.compareFunction,this}toJSON(e){let t=super.toJSON(e);if(this.compareFunction!==null)t.compareFunction=this.compareFunction;return t}}var rh=new ht,ah=new lo(1,1);ah.compareFunction=515;var oh=new Nr,lh=new so,ch=new Es,wl=[],Rl=[],Cl=new Float32Array(16),Pl=new Float32Array(9),Ll=new Float32Array(4);function Ji(e,t,n){let i=e[0];if(i<=0||i>0)return e;let s=t*n,r=wl[s];if(r===void 0)r=new Float32Array(s),wl[s]=r;if(t!==0){i.toArray(r,0);for(let a=1,o=0;a!==t;++a)o+=n,e[a].toArray(r,o)}return r}function St(e,t){if(e.length!==t.length)return!1;for(let n=0,i=e.length;n<i;n++)if(e[n]!==t[n])return!1;return!0}function Mt(e,t){for(let n=0,i=t.length;n<i;n++)e[n]=t[n]}function Br(e,t){let n=Rl[t];if(n===void 0)n=new Int32Array(t),Rl[t]=n;for(let i=0;i!==t;++i)n[i]=e.allocateTextureUnit();return n}function Vm(e,t){let n=this.cache;if(n[0]===t)return;e.uniform1f(this.addr,t),n[0]=t}function Xm(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y)e.uniform2f(this.addr,t.x,t.y),n[0]=t.x,n[1]=t.y}else{if(St(n,t))return;e.uniform2fv(this.addr,t),Mt(n,t)}}function qm(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z)e.uniform3f(this.addr,t.x,t.y,t.z),n[0]=t.x,n[1]=t.y,n[2]=t.z}else if(t.r!==void 0){if(n[0]!==t.r||n[1]!==t.g||n[2]!==t.b)e.uniform3f(this.addr,t.r,t.g,t.b),n[0]=t.r,n[1]=t.g,n[2]=t.b}else{if(St(n,t))return;e.uniform3fv(this.addr,t),Mt(n,t)}}function Ym(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z||n[3]!==t.w)e.uniform4f(this.addr,t.x,t.y,t.z,t.w),n[0]=t.x,n[1]=t.y,n[2]=t.z,n[3]=t.w}else{if(St(n,t))return;e.uniform4fv(this.addr,t),Mt(n,t)}}function Zm(e,t){let n=this.cache,i=t.elements;if(i===void 0){if(St(n,t))return;e.uniformMatrix2fv(this.addr,!1,t),Mt(n,t)}else{if(St(n,i))return;Ll.set(i),e.uniformMatrix2fv(this.addr,!1,Ll),Mt(n,i)}}function Km(e,t){let n=this.cache,i=t.elements;if(i===void 0){if(St(n,t))return;e.uniformMatrix3fv(this.addr,!1,t),Mt(n,t)}else{if(St(n,i))return;Pl.set(i),e.uniformMatrix3fv(this.addr,!1,Pl),Mt(n,i)}}function Jm(e,t){let n=this.cache,i=t.elements;if(i===void 0){if(St(n,t))return;e.uniformMatrix4fv(this.addr,!1,t),Mt(n,t)}else{if(St(n,i))return;Cl.set(i),e.uniformMatrix4fv(this.addr,!1,Cl),Mt(n,i)}}function $m(e,t){let n=this.cache;if(n[0]===t)return;e.uniform1i(this.addr,t),n[0]=t}function jm(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y)e.uniform2i(this.addr,t.x,t.y),n[0]=t.x,n[1]=t.y}else{if(St(n,t))return;e.uniform2iv(this.addr,t),Mt(n,t)}}function Qm(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z)e.uniform3i(this.addr,t.x,t.y,t.z),n[0]=t.x,n[1]=t.y,n[2]=t.z}else{if(St(n,t))return;e.uniform3iv(this.addr,t),Mt(n,t)}}function eg(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z||n[3]!==t.w)e.uniform4i(this.addr,t.x,t.y,t.z,t.w),n[0]=t.x,n[1]=t.y,n[2]=t.z,n[3]=t.w}else{if(St(n,t))return;e.uniform4iv(this.addr,t),Mt(n,t)}}function tg(e,t){let n=this.cache;if(n[0]===t)return;e.uniform1ui(this.addr,t),n[0]=t}function ng(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y)e.uniform2ui(this.addr,t.x,t.y),n[0]=t.x,n[1]=t.y}else{if(St(n,t))return;e.uniform2uiv(this.addr,t),Mt(n,t)}}function ig(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z)e.uniform3ui(this.addr,t.x,t.y,t.z),n[0]=t.x,n[1]=t.y,n[2]=t.z}else{if(St(n,t))return;e.uniform3uiv(this.addr,t),Mt(n,t)}}function sg(e,t){let n=this.cache;if(t.x!==void 0){if(n[0]!==t.x||n[1]!==t.y||n[2]!==t.z||n[3]!==t.w)e.uniform4ui(this.addr,t.x,t.y,t.z,t.w),n[0]=t.x,n[1]=t.y,n[2]=t.z,n[3]=t.w}else{if(St(n,t))return;e.uniform4uiv(this.addr,t),Mt(n,t)}}function rg(e,t,n){let i=this.cache,s=n.allocateTextureUnit();if(i[0]!==s)e.uniform1i(this.addr,s),i[0]=s;let r=this.type===e.SAMPLER_2D_SHADOW?ah:rh;n.setTexture2D(t||r,s)}function ag(e,t,n){let i=this.cache,s=n.allocateTextureUnit();if(i[0]!==s)e.uniform1i(this.addr,s),i[0]=s;n.setTexture3D(t||lh,s)}function og(e,t,n){let i=this.cache,s=n.allocateTextureUnit();if(i[0]!==s)e.uniform1i(this.addr,s),i[0]=s;n.setTextureCube(t||ch,s)}function lg(e,t,n){let i=this.cache,s=n.allocateTextureUnit();if(i[0]!==s)e.uniform1i(this.addr,s),i[0]=s;n.setTexture2DArray(t||oh,s)}function cg(e){switch(e){case 5126:return Vm;case 35664:return Xm;case 35665:return qm;case 35666:return Ym;case 35674:return Zm;case 35675:return Km;case 35676:return Jm;case 5124:case 35670:return $m;case 35667:case 35671:return jm;case 35668:case 35672:return Qm;case 35669:case 35673:return eg;case 5125:return tg;case 36294:return ng;case 36295:return ig;case 36296:return sg;case 35678:case 36198:case 36298:case 36306:case 35682:return rg;case 35679:case 36299:case 36307:return ag;case 35680:case 36300:case 36308:case 36293:return og;case 36289:case 36303:case 36311:case 36292:return lg}}function hg(e,t){e.uniform1fv(this.addr,t)}function ug(e,t){let n=Ji(t,this.size,2);e.uniform2fv(this.addr,n)}function dg(e,t){let n=Ji(t,this.size,3);e.uniform3fv(this.addr,n)}function fg(e,t){let n=Ji(t,this.size,4);e.uniform4fv(this.addr,n)}function pg(e,t){let n=Ji(t,this.size,4);e.uniformMatrix2fv(this.addr,!1,n)}function mg(e,t){let n=Ji(t,this.size,9);e.uniformMatrix3fv(this.addr,!1,n)}function gg(e,t){let n=Ji(t,this.size,16);e.uniformMatrix4fv(this.addr,!1,n)}function _g(e,t){e.uniform1iv(this.addr,t)}function xg(e,t){e.uniform2iv(this.addr,t)}function vg(e,t){e.uniform3iv(this.addr,t)}function yg(e,t){e.uniform4iv(this.addr,t)}function Sg(e,t){e.uniform1uiv(this.addr,t)}function Mg(e,t){e.uniform2uiv(this.addr,t)}function bg(e,t){e.uniform3uiv(this.addr,t)}function Tg(e,t){e.uniform4uiv(this.addr,t)}function Ag(e,t,n){let i=this.cache,s=t.length,r=Br(n,s);if(!St(i,r))e.uniform1iv(this.addr,r),Mt(i,r);for(let a=0;a!==s;++a)n.setTexture2D(t[a]||rh,r[a])}function Eg(e,t,n){let i=this.cache,s=t.length,r=Br(n,s);if(!St(i,r))e.uniform1iv(this.addr,r),Mt(i,r);for(let a=0;a!==s;++a)n.setTexture3D(t[a]||lh,r[a])}function wg(e,t,n){let i=this.cache,s=t.length,r=Br(n,s);if(!St(i,r))e.uniform1iv(this.addr,r),Mt(i,r);for(let a=0;a!==s;++a)n.setTextureCube(t[a]||ch,r[a])}function Rg(e,t,n){let i=this.cache,s=t.length,r=Br(n,s);if(!St(i,r))e.uniform1iv(this.addr,r),Mt(i,r);for(let a=0;a!==s;++a)n.setTexture2DArray(t[a]||oh,r[a])}function Cg(e){switch(e){case 5126:return hg;case 35664:return ug;case 35665:return dg;case 35666:return fg;case 35674:return pg;case 35675:return mg;case 35676:return gg;case 5124:case 35670:return _g;case 35667:case 35671:return xg;case 35668:case 35672:return vg;case 35669:case 35673:return yg;case 5125:return Sg;case 36294:return Mg;case 36295:return bg;case 36296:return Tg;case 35678:case 36198:case 36298:case 36306:case 35682:return Ag;case 35679:case 36299:case 36307:return Eg;case 35680:case 36300:case 36308:case 36293:return wg;case 36289:case 36303:case 36311:case 36292:return Rg}}class hh{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.setValue=cg(t.type)}}class uh{constructor(e,t,n){this.id=e,this.addr=n,this.cache=[],this.type=t.type,this.size=t.size,this.setValue=Cg(t.type)}}class dh{constructor(e){this.id=e,this.seq=[],this.map={}}setValue(e,t,n){let i=this.seq;for(let s=0,r=i.length;s!==r;++s){let a=i[s];a.setValue(e,t[a.id],n)}}}var Pa=/(\w+)(\])?(\[|\.)?/g;function Il(e,t){e.seq.push(t),e.map[t.id]=t}function Pg(e,t,n){let i=e.name,s=i.length;Pa.lastIndex=0;while(!0){let r=Pa.exec(i),a=Pa.lastIndex,o=r[1],l=r[2]==="]",c=r[3];if(l)o=o|0;if(c===void 0||c==="["&&a+2===s){Il(n,c===void 0?new hh(o,e,t):new uh(o,e,t));break}else{let u=n.map[o];if(u===void 0)u=new dh(o),Il(n,u);n=u}}}class gs{constructor(e,t){this.seq=[],this.map={};let n=e.getProgramParameter(t,e.ACTIVE_UNIFORMS);for(let i=0;i<n;++i){let s=e.getActiveUniform(t,i),r=e.getUniformLocation(t,s.name);Pg(s,r,this)}}setValue(e,t,n,i){let s=this.map[t];if(s!==void 0)s.setValue(e,n,i)}setOptional(e,t,n){let i=t[n];if(i!==void 0)this.setValue(e,n,i)}static upload(e,t,n,i){for(let s=0,r=t.length;s!==r;++s){let a=t[s],o=n[a.id];if(o.needsUpdate!==!1)a.setValue(e,o.value,i)}}static seqWithValue(e,t){let n=[];for(let i=0,s=e.length;i!==s;++i){let r=e[i];if(r.id in t)n.push(r)}return n}}function Nl(e,t,n){let i=e.createShader(t);return e.shaderSource(i,n),e.compileShader(i),i}var Lg=37297,Ig=0;function Ng(e,t){let n=e.split(`
`),i=[],s=Math.max(t-6,0),r=Math.min(t+6,n.length);for(let a=s;a<r;a++){let o=a+1;i.push(`${o===t?">":" "} ${o}: ${n[a]}`)}return i.join(`
`)}function Dg(e){let t=nt.getPrimaries(nt.workingColorSpace),n=nt.getPrimaries(e),i;if(t===n)i="";else if(t==="p3"&&n==="rec709")i="LinearDisplayP3ToLinearSRGB";else if(t==="rec709"&&n==="p3")i="LinearSRGBToLinearDisplayP3";switch(e){case"srgb-linear":case"display-p3-linear":return[i,"LinearTransferOETF"];case"srgb":case"display-p3":return[i,"sRGBTransferOETF"];default:return console.warn("THREE.WebGLProgram: Unsupported color space:",e),[i,"LinearTransferOETF"]}}function Dl(e,t,n){let i=e.getShaderParameter(t,e.COMPILE_STATUS),s=e.getShaderInfoLog(t).trim();if(i&&s==="")return"";let r=/ERROR: 0:(\d+)/.exec(s);if(r){let a=parseInt(r[1]);return n.toUpperCase()+`

`+s+`

`+Ng(e.getShaderSource(t),a)}else return s}function Ug(e,t){let n=Dg(t);return`vec4 ${e}( vec4 value ) { return ${n[0]}( ${n[1]}( value ) ); }`}function Fg(e,t){let n;switch(t){case 1:n="Linear";break;case 2:n="Reinhard";break;case 3:n="OptimizedCineon";break;case 4:n="ACESFilmic";break;case 6:n="AgX";break;case 5:n="Custom";break;default:console.warn("THREE.WebGLProgram: Unsupported toneMapping:",t),n="Linear"}return"vec3 "+e+"( vec3 color ) { return "+n+"ToneMapping( color ); }"}function Og(e){return[e.extensionDerivatives||!!e.envMapCubeUVHeight||e.bumpMap||e.normalMapTangentSpace||e.clearcoatNormalMap||e.flatShading||e.shaderID==="physical"?"#extension GL_OES_standard_derivatives : enable":"",(e.extensionFragDepth||e.logarithmicDepthBuffer)&&e.rendererExtensionFragDepth?"#extension GL_EXT_frag_depth : enable":"",e.extensionDrawBuffers&&e.rendererExtensionDrawBuffers?"#extension GL_EXT_draw_buffers : require":"",(e.extensionShaderTextureLOD||e.envMap||e.transmission)&&e.rendererExtensionShaderTextureLod?"#extension GL_EXT_shader_texture_lod : enable":""].filter(Wi).join(`
`)}function Bg(e){return[e.extensionClipCullDistance?"#extension GL_ANGLE_clip_cull_distance : require":""].filter(Wi).join(`
`)}function zg(e){let t=[];for(let n in e){let i=e[n];if(i===!1)continue;t.push("#define "+n+" "+i)}return t.join(`
`)}function kg(e,t){let n={},i=e.getProgramParameter(t,e.ACTIVE_ATTRIBUTES);for(let s=0;s<i;s++){let r=e.getActiveAttrib(t,s),a=r.name,o=1;if(r.type===e.FLOAT_MAT2)o=2;if(r.type===e.FLOAT_MAT3)o=3;if(r.type===e.FLOAT_MAT4)o=4;n[a]={type:r.type,location:e.getAttribLocation(t,a),locationSize:o}}return n}function Wi(e){return e!==""}function Ul(e,t){let n=t.numSpotLightShadows+t.numSpotLightMaps-t.numSpotLightShadowsWithMaps;return e.replace(/NUM_DIR_LIGHTS/g,t.numDirLights).replace(/NUM_SPOT_LIGHTS/g,t.numSpotLights).replace(/NUM_SPOT_LIGHT_MAPS/g,t.numSpotLightMaps).replace(/NUM_SPOT_LIGHT_COORDS/g,n).replace(/NUM_RECT_AREA_LIGHTS/g,t.numRectAreaLights).replace(/NUM_POINT_LIGHTS/g,t.numPointLights).replace(/NUM_HEMI_LIGHTS/g,t.numHemiLights).replace(/NUM_DIR_LIGHT_SHADOWS/g,t.numDirLightShadows).replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g,t.numSpotLightShadowsWithMaps).replace(/NUM_SPOT_LIGHT_SHADOWS/g,t.numSpotLightShadows).replace(/NUM_POINT_LIGHT_SHADOWS/g,t.numPointLightShadows)}function Fl(e,t){return e.replace(/NUM_CLIPPING_PLANES/g,t.numClippingPlanes).replace(/UNION_CLIPPING_PLANES/g,t.numClippingPlanes-t.numClipIntersection)}var Gg=/^[ \t]*#include +<([\w\d./]+)>/gm;function Ya(e){return e.replace(Gg,Wg)}var Hg=new Map([["encodings_fragment","colorspace_fragment"],["encodings_pars_fragment","colorspace_pars_fragment"],["output_fragment","opaque_fragment"]]);function Wg(e,t){let n=qe[t];if(n===void 0){let i=Hg.get(t);if(i!==void 0)n=qe[i],console.warn('THREE.WebGLRenderer: Shader chunk "%s" has been deprecated. Use "%s" instead.',t,i);else throw Error("Can not resolve #include <"+t+">")}return Ya(n)}var Vg=/#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;function Ol(e){return e.replace(Vg,Xg)}function Xg(e,t,n,i){let s="";for(let r=parseInt(t);r<parseInt(n);r++)s+=i.replace(/\[\s*i\s*\]/g,"[ "+r+" ]").replace(/UNROLLED_LOOP_INDEX/g,r);return s}function Bl(e){let t="precision "+e.precision+` float;
precision `+e.precision+" int;";if(e.precision==="highp")t+=`
#define HIGH_PRECISION`;else if(e.precision==="mediump")t+=`
#define MEDIUM_PRECISION`;else if(e.precision==="lowp")t+=`
#define LOW_PRECISION`;return t}function qg(e){let t="SHADOWMAP_TYPE_BASIC";if(e.shadowMapType===1)t="SHADOWMAP_TYPE_PCF";else if(e.shadowMapType===2)t="SHADOWMAP_TYPE_PCF_SOFT";else if(e.shadowMapType===3)t="SHADOWMAP_TYPE_VSM";return t}function Yg(e){let t="ENVMAP_TYPE_CUBE";if(e.envMap)switch(e.envMapMode){case 301:case 302:t="ENVMAP_TYPE_CUBE";break;case 306:t="ENVMAP_TYPE_CUBE_UV";break}return t}function Zg(e){let t="ENVMAP_MODE_REFLECTION";if(e.envMap)switch(e.envMapMode){case 302:t="ENVMAP_MODE_REFRACTION";break}return t}function Kg(e){let t="ENVMAP_BLENDING_NONE";if(e.envMap)switch(e.combine){case 0:t="ENVMAP_BLENDING_MULTIPLY";break;case 1:t="ENVMAP_BLENDING_MIX";break;case 2:t="ENVMAP_BLENDING_ADD";break}return t}function Jg(e){let t=e.envMapCubeUVHeight;if(t===null)return null;let n=Math.log2(t)-2,i=1/t;return{texelWidth:1/(3*Math.max(Math.pow(2,n),112)),texelHeight:i,maxMip:n}}function $g(e,t,n,i){let s=e.getContext(),{defines:r,vertexShader:a,fragmentShader:o}=n,l=qg(n),c=Yg(n),h=Zg(n),u=Kg(n),d=Jg(n),f=n.isWebGL2?"":Og(n),g=Bg(n),_=zg(r),m=s.createProgram(),p,x,v=n.glslVersion?"#version "+n.glslVersion+`
`:"";if(n.isRawShaderMaterial){if(p=["#define SHADER_TYPE "+n.shaderType,"#define SHADER_NAME "+n.shaderName,_].filter(Wi).join(`
`),p.length>0)p+=`
`;if(x=[f,"#define SHADER_TYPE "+n.shaderType,"#define SHADER_NAME "+n.shaderName,_].filter(Wi).join(`
`),x.length>0)x+=`
`}else p=[Bl(n),"#define SHADER_TYPE "+n.shaderType,"#define SHADER_NAME "+n.shaderName,_,n.extensionClipCullDistance?"#define USE_CLIP_DISTANCE":"",n.batching?"#define USE_BATCHING":"",n.instancing?"#define USE_INSTANCING":"",n.instancingColor?"#define USE_INSTANCING_COLOR":"",n.useFog&&n.fog?"#define USE_FOG":"",n.useFog&&n.fogExp2?"#define FOG_EXP2":"",n.map?"#define USE_MAP":"",n.envMap?"#define USE_ENVMAP":"",n.envMap?"#define "+h:"",n.lightMap?"#define USE_LIGHTMAP":"",n.aoMap?"#define USE_AOMAP":"",n.bumpMap?"#define USE_BUMPMAP":"",n.normalMap?"#define USE_NORMALMAP":"",n.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",n.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",n.displacementMap?"#define USE_DISPLACEMENTMAP":"",n.emissiveMap?"#define USE_EMISSIVEMAP":"",n.anisotropy?"#define USE_ANISOTROPY":"",n.anisotropyMap?"#define USE_ANISOTROPYMAP":"",n.clearcoatMap?"#define USE_CLEARCOATMAP":"",n.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",n.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",n.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",n.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",n.specularMap?"#define USE_SPECULARMAP":"",n.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",n.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",n.roughnessMap?"#define USE_ROUGHNESSMAP":"",n.metalnessMap?"#define USE_METALNESSMAP":"",n.alphaMap?"#define USE_ALPHAMAP":"",n.alphaHash?"#define USE_ALPHAHASH":"",n.transmission?"#define USE_TRANSMISSION":"",n.transmissionMap?"#define USE_TRANSMISSIONMAP":"",n.thicknessMap?"#define USE_THICKNESSMAP":"",n.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",n.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",n.mapUv?"#define MAP_UV "+n.mapUv:"",n.alphaMapUv?"#define ALPHAMAP_UV "+n.alphaMapUv:"",n.lightMapUv?"#define LIGHTMAP_UV "+n.lightMapUv:"",n.aoMapUv?"#define AOMAP_UV "+n.aoMapUv:"",n.emissiveMapUv?"#define EMISSIVEMAP_UV "+n.emissiveMapUv:"",n.bumpMapUv?"#define BUMPMAP_UV "+n.bumpMapUv:"",n.normalMapUv?"#define NORMALMAP_UV "+n.normalMapUv:"",n.displacementMapUv?"#define DISPLACEMENTMAP_UV "+n.displacementMapUv:"",n.metalnessMapUv?"#define METALNESSMAP_UV "+n.metalnessMapUv:"",n.roughnessMapUv?"#define ROUGHNESSMAP_UV "+n.roughnessMapUv:"",n.anisotropyMapUv?"#define ANISOTROPYMAP_UV "+n.anisotropyMapUv:"",n.clearcoatMapUv?"#define CLEARCOATMAP_UV "+n.clearcoatMapUv:"",n.clearcoatNormalMapUv?"#define CLEARCOAT_NORMALMAP_UV "+n.clearcoatNormalMapUv:"",n.clearcoatRoughnessMapUv?"#define CLEARCOAT_ROUGHNESSMAP_UV "+n.clearcoatRoughnessMapUv:"",n.iridescenceMapUv?"#define IRIDESCENCEMAP_UV "+n.iridescenceMapUv:"",n.iridescenceThicknessMapUv?"#define IRIDESCENCE_THICKNESSMAP_UV "+n.iridescenceThicknessMapUv:"",n.sheenColorMapUv?"#define SHEEN_COLORMAP_UV "+n.sheenColorMapUv:"",n.sheenRoughnessMapUv?"#define SHEEN_ROUGHNESSMAP_UV "+n.sheenRoughnessMapUv:"",n.specularMapUv?"#define SPECULARMAP_UV "+n.specularMapUv:"",n.specularColorMapUv?"#define SPECULAR_COLORMAP_UV "+n.specularColorMapUv:"",n.specularIntensityMapUv?"#define SPECULAR_INTENSITYMAP_UV "+n.specularIntensityMapUv:"",n.transmissionMapUv?"#define TRANSMISSIONMAP_UV "+n.transmissionMapUv:"",n.thicknessMapUv?"#define THICKNESSMAP_UV "+n.thicknessMapUv:"",n.vertexTangents&&n.flatShading===!1?"#define USE_TANGENT":"",n.vertexColors?"#define USE_COLOR":"",n.vertexAlphas?"#define USE_COLOR_ALPHA":"",n.vertexUv1s?"#define USE_UV1":"",n.vertexUv2s?"#define USE_UV2":"",n.vertexUv3s?"#define USE_UV3":"",n.pointsUvs?"#define USE_POINTS_UV":"",n.flatShading?"#define FLAT_SHADED":"",n.skinning?"#define USE_SKINNING":"",n.morphTargets?"#define USE_MORPHTARGETS":"",n.morphNormals&&n.flatShading===!1?"#define USE_MORPHNORMALS":"",n.morphColors&&n.isWebGL2?"#define USE_MORPHCOLORS":"",n.morphTargetsCount>0&&n.isWebGL2?"#define MORPHTARGETS_TEXTURE":"",n.morphTargetsCount>0&&n.isWebGL2?"#define MORPHTARGETS_TEXTURE_STRIDE "+n.morphTextureStride:"",n.morphTargetsCount>0&&n.isWebGL2?"#define MORPHTARGETS_COUNT "+n.morphTargetsCount:"",n.doubleSided?"#define DOUBLE_SIDED":"",n.flipSided?"#define FLIP_SIDED":"",n.shadowMapEnabled?"#define USE_SHADOWMAP":"",n.shadowMapEnabled?"#define "+l:"",n.sizeAttenuation?"#define USE_SIZEATTENUATION":"",n.numLightProbes>0?"#define USE_LIGHT_PROBES":"",n.useLegacyLights?"#define LEGACY_LIGHTS":"",n.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",n.logarithmicDepthBuffer&&n.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 modelMatrix;","uniform mat4 modelViewMatrix;","uniform mat4 projectionMatrix;","uniform mat4 viewMatrix;","uniform mat3 normalMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;","#ifdef USE_INSTANCING","\tattribute mat4 instanceMatrix;","#endif","#ifdef USE_INSTANCING_COLOR","\tattribute vec3 instanceColor;","#endif","attribute vec3 position;","attribute vec3 normal;","attribute vec2 uv;","#ifdef USE_UV1","\tattribute vec2 uv1;","#endif","#ifdef USE_UV2","\tattribute vec2 uv2;","#endif","#ifdef USE_UV3","\tattribute vec2 uv3;","#endif","#ifdef USE_TANGENT","\tattribute vec4 tangent;","#endif","#if defined( USE_COLOR_ALPHA )","\tattribute vec4 color;","#elif defined( USE_COLOR )","\tattribute vec3 color;","#endif","#if ( defined( USE_MORPHTARGETS ) && ! defined( MORPHTARGETS_TEXTURE ) )","\tattribute vec3 morphTarget0;","\tattribute vec3 morphTarget1;","\tattribute vec3 morphTarget2;","\tattribute vec3 morphTarget3;","\t#ifdef USE_MORPHNORMALS","\t\tattribute vec3 morphNormal0;","\t\tattribute vec3 morphNormal1;","\t\tattribute vec3 morphNormal2;","\t\tattribute vec3 morphNormal3;","\t#else","\t\tattribute vec3 morphTarget4;","\t\tattribute vec3 morphTarget5;","\t\tattribute vec3 morphTarget6;","\t\tattribute vec3 morphTarget7;","\t#endif","#endif","#ifdef USE_SKINNING","\tattribute vec4 skinIndex;","\tattribute vec4 skinWeight;","#endif",`
`].filter(Wi).join(`
`),x=[f,Bl(n),"#define SHADER_TYPE "+n.shaderType,"#define SHADER_NAME "+n.shaderName,_,n.useFog&&n.fog?"#define USE_FOG":"",n.useFog&&n.fogExp2?"#define FOG_EXP2":"",n.map?"#define USE_MAP":"",n.matcap?"#define USE_MATCAP":"",n.envMap?"#define USE_ENVMAP":"",n.envMap?"#define "+c:"",n.envMap?"#define "+h:"",n.envMap?"#define "+u:"",d?"#define CUBEUV_TEXEL_WIDTH "+d.texelWidth:"",d?"#define CUBEUV_TEXEL_HEIGHT "+d.texelHeight:"",d?"#define CUBEUV_MAX_MIP "+d.maxMip+".0":"",n.lightMap?"#define USE_LIGHTMAP":"",n.aoMap?"#define USE_AOMAP":"",n.bumpMap?"#define USE_BUMPMAP":"",n.normalMap?"#define USE_NORMALMAP":"",n.normalMapObjectSpace?"#define USE_NORMALMAP_OBJECTSPACE":"",n.normalMapTangentSpace?"#define USE_NORMALMAP_TANGENTSPACE":"",n.emissiveMap?"#define USE_EMISSIVEMAP":"",n.anisotropy?"#define USE_ANISOTROPY":"",n.anisotropyMap?"#define USE_ANISOTROPYMAP":"",n.clearcoat?"#define USE_CLEARCOAT":"",n.clearcoatMap?"#define USE_CLEARCOATMAP":"",n.clearcoatRoughnessMap?"#define USE_CLEARCOAT_ROUGHNESSMAP":"",n.clearcoatNormalMap?"#define USE_CLEARCOAT_NORMALMAP":"",n.iridescence?"#define USE_IRIDESCENCE":"",n.iridescenceMap?"#define USE_IRIDESCENCEMAP":"",n.iridescenceThicknessMap?"#define USE_IRIDESCENCE_THICKNESSMAP":"",n.specularMap?"#define USE_SPECULARMAP":"",n.specularColorMap?"#define USE_SPECULAR_COLORMAP":"",n.specularIntensityMap?"#define USE_SPECULAR_INTENSITYMAP":"",n.roughnessMap?"#define USE_ROUGHNESSMAP":"",n.metalnessMap?"#define USE_METALNESSMAP":"",n.alphaMap?"#define USE_ALPHAMAP":"",n.alphaTest?"#define USE_ALPHATEST":"",n.alphaHash?"#define USE_ALPHAHASH":"",n.sheen?"#define USE_SHEEN":"",n.sheenColorMap?"#define USE_SHEEN_COLORMAP":"",n.sheenRoughnessMap?"#define USE_SHEEN_ROUGHNESSMAP":"",n.transmission?"#define USE_TRANSMISSION":"",n.transmissionMap?"#define USE_TRANSMISSIONMAP":"",n.thicknessMap?"#define USE_THICKNESSMAP":"",n.vertexTangents&&n.flatShading===!1?"#define USE_TANGENT":"",n.vertexColors||n.instancingColor?"#define USE_COLOR":"",n.vertexAlphas?"#define USE_COLOR_ALPHA":"",n.vertexUv1s?"#define USE_UV1":"",n.vertexUv2s?"#define USE_UV2":"",n.vertexUv3s?"#define USE_UV3":"",n.pointsUvs?"#define USE_POINTS_UV":"",n.gradientMap?"#define USE_GRADIENTMAP":"",n.flatShading?"#define FLAT_SHADED":"",n.doubleSided?"#define DOUBLE_SIDED":"",n.flipSided?"#define FLIP_SIDED":"",n.shadowMapEnabled?"#define USE_SHADOWMAP":"",n.shadowMapEnabled?"#define "+l:"",n.premultipliedAlpha?"#define PREMULTIPLIED_ALPHA":"",n.numLightProbes>0?"#define USE_LIGHT_PROBES":"",n.useLegacyLights?"#define LEGACY_LIGHTS":"",n.decodeVideoTexture?"#define DECODE_VIDEO_TEXTURE":"",n.logarithmicDepthBuffer?"#define USE_LOGDEPTHBUF":"",n.logarithmicDepthBuffer&&n.rendererExtensionFragDepth?"#define USE_LOGDEPTHBUF_EXT":"","uniform mat4 viewMatrix;","uniform vec3 cameraPosition;","uniform bool isOrthographic;",n.toneMapping!==0?"#define TONE_MAPPING":"",n.toneMapping!==0?qe.tonemapping_pars_fragment:"",n.toneMapping!==0?Fg("toneMapping",n.toneMapping):"",n.dithering?"#define DITHERING":"",n.opaque?"#define OPAQUE":"",qe.colorspace_pars_fragment,Ug("linearToOutputTexel",n.outputColorSpace),n.useDepthPacking?"#define DEPTH_PACKING "+n.depthPacking:"",`
`].filter(Wi).join(`
`);if(a=Ya(a),a=Ul(a,n),a=Fl(a,n),o=Ya(o),o=Ul(o,n),o=Fl(o,n),a=Ol(a),o=Ol(o),n.isWebGL2&&n.isRawShaderMaterial!==!0)v=`#version 300 es
`,p=[g,"precision mediump sampler2DArray;","#define attribute in","#define varying out","#define texture2D texture"].join(`
`)+`
`+p,x=["precision mediump sampler2DArray;","#define varying in",n.glslVersion==="300 es"?"":"layout(location = 0) out highp vec4 pc_fragColor;",n.glslVersion==="300 es"?"":"#define gl_FragColor pc_fragColor","#define gl_FragDepthEXT gl_FragDepth","#define texture2D texture","#define textureCube texture","#define texture2DProj textureProj","#define texture2DLodEXT textureLod","#define texture2DProjLodEXT textureProjLod","#define textureCubeLodEXT textureLod","#define texture2DGradEXT textureGrad","#define texture2DProjGradEXT textureProjGrad","#define textureCubeGradEXT textureGrad"].join(`
`)+`
`+x;let b=v+p+a,R=v+x+o,M=Nl(s,s.VERTEX_SHADER,b),C=Nl(s,s.FRAGMENT_SHADER,R);if(s.attachShader(m,M),s.attachShader(m,C),n.index0AttributeName!==void 0)s.bindAttribLocation(m,0,n.index0AttributeName);else if(n.morphTargets===!0)s.bindAttribLocation(m,0,"position");s.linkProgram(m);function D(J){if(e.debug.checkShaderErrors){let ae=s.getProgramInfoLog(m).trim(),I=s.getShaderInfoLog(M).trim(),z=s.getShaderInfoLog(C).trim(),X=!0,ne=!0;if(s.getProgramParameter(m,s.LINK_STATUS)===!1)if(X=!1,typeof e.debug.onShaderError==="function")e.debug.onShaderError(s,m,M,C);else{let V=Dl(s,M,"vertex"),q=Dl(s,C,"fragment");console.error("THREE.WebGLProgram: Shader Error "+s.getError()+" - VALIDATE_STATUS "+s.getProgramParameter(m,s.VALIDATE_STATUS)+`

Program Info Log: `+ae+`
`+V+`
`+q)}else if(ae!=="")console.warn("THREE.WebGLProgram: Program Info Log:",ae);else if(I===""||z==="")ne=!1;if(ne)J.diagnostics={runnable:X,programLog:ae,vertexShader:{log:I,prefix:p},fragmentShader:{log:z,prefix:x}}}s.deleteShader(M),s.deleteShader(C),S=new gs(s,m),w=kg(s,m)}let S;this.getUniforms=function(){if(S===void 0)D(this);return S};let w;this.getAttributes=function(){if(w===void 0)D(this);return w};let U=n.rendererExtensionParallelShaderCompile===!1;return this.isReady=function(){if(U===!1)U=s.getProgramParameter(m,Lg);return U},this.destroy=function(){i.releaseStatesOfProgram(this),s.deleteProgram(m),this.program=void 0},this.type=n.shaderType,this.name=n.shaderName,this.id=Ig++,this.cacheKey=t,this.usedTimes=1,this.program=m,this.vertexShader=M,this.fragmentShader=C,this}var jg=0;class fh{constructor(){this.shaderCache=new Map,this.materialCache=new Map}update(e){let{vertexShader:t,fragmentShader:n}=e,i=this._getShaderStage(t),s=this._getShaderStage(n),r=this._getShaderCacheForMaterial(e);if(r.has(i)===!1)r.add(i),i.usedTimes++;if(r.has(s)===!1)r.add(s),s.usedTimes++;return this}remove(e){let t=this.materialCache.get(e);for(let n of t)if(n.usedTimes--,n.usedTimes===0)this.shaderCache.delete(n.code);return this.materialCache.delete(e),this}getVertexShaderID(e){return this._getShaderStage(e.vertexShader).id}getFragmentShaderID(e){return this._getShaderStage(e.fragmentShader).id}dispose(){this.shaderCache.clear(),this.materialCache.clear()}_getShaderCacheForMaterial(e){let t=this.materialCache,n=t.get(e);if(n===void 0)n=new Set,t.set(e,n);return n}_getShaderStage(e){let t=this.shaderCache,n=t.get(e);if(n===void 0)n=new ph(e),t.set(e,n);return n}}class ph{constructor(e){this.id=jg++,this.code=e,this.usedTimes=0}}function Qg(e,t,n,i,s,r,a){let o=new Ur,l=new fh,c=[],{isWebGL2:h,logarithmicDepthBuffer:u,vertexTextures:d,precision:f}=s,g={MeshDepthMaterial:"depth",MeshDistanceMaterial:"distanceRGBA",MeshNormalMaterial:"normal",MeshBasicMaterial:"basic",MeshLambertMaterial:"lambert",MeshPhongMaterial:"phong",MeshToonMaterial:"toon",MeshStandardMaterial:"physical",MeshPhysicalMaterial:"physical",MeshMatcapMaterial:"matcap",LineBasicMaterial:"basic",LineDashedMaterial:"dashed",PointsMaterial:"points",ShadowMaterial:"shadow",SpriteMaterial:"sprite"};function _(S){if(S===0)return"uv";return`uv${S}`}function m(S,w,U,J,ae){let I=J.fog,z=ae.geometry,X=S.isMeshStandardMaterial?J.environment:null,ne=(S.isMeshStandardMaterial?n:t).get(S.envMap||X),V=!!ne&&ne.mapping===306?ne.image.height:null,q=g[S.type];if(S.precision!==null){if(f=s.getMaxPrecision(S.precision),f!==S.precision)console.warn("THREE.WebGLProgram.getParameters:",S.precision,"not supported, using",f,"instead.")}let ee=z.morphAttributes.position||z.morphAttributes.normal||z.morphAttributes.color,oe=ee!==void 0?ee.length:0,O=0;if(z.morphAttributes.position!==void 0)O=1;if(z.morphAttributes.normal!==void 0)O=2;if(z.morphAttributes.color!==void 0)O=3;let te,ge,ve,Ee;if(q){let Ft=cn[q];te=Ft.vertexShader,ge=Ft.fragmentShader}else te=S.vertexShader,ge=S.fragmentShader,l.update(S),ve=l.getVertexShaderID(S),Ee=l.getFragmentShaderID(S);let Ie=e.getRenderTarget(),ke=ae.isInstancedMesh===!0,we=ae.isBatchedMesh===!0,Ge=!!S.map,P=!!S.matcap,ce=!!ne,j=!!S.aoMap,Q=!!S.lightMap,Z=!!S.bumpMap,xe=!!S.normalMap,Se=!!S.displacementMap,be=!!S.emissiveMap,E=!!S.metalnessMap,y=!!S.roughnessMap,B=S.anisotropy>0,ie=S.clearcoat>0,Y=S.iridescence>0,se=S.sheen>0,Le=S.transmission>0,pe=B&&!!S.anisotropyMap,Te=ie&&!!S.clearcoatMap,Re=ie&&!!S.clearcoatNormalMap,Fe=ie&&!!S.clearcoatRoughnessMap,K=Y&&!!S.iridescenceMap,L=Y&&!!S.iridescenceThicknessMap,re=se&&!!S.sheenColorMap,ye=se&&!!S.sheenRoughnessMap,le=!!S.specularMap,_e=!!S.specularColorMap,Oe=!!S.specularIntensityMap,Xe=Le&&!!S.transmissionMap,je=Le&&!!S.thicknessMap,rt=!!S.gradientMap,de=!!S.alphaMap,N=S.alphaTest>0,he=!!S.alphaHash,me=!!S.extensions,Ne=!!z.attributes.uv1,Ce=!!z.attributes.uv2,it=!!z.attributes.uv3,ot=0;if(S.toneMapped){if(Ie===null||Ie.isXRRenderTarget===!0)ot=e.toneMapping}return{isWebGL2:h,shaderID:q,shaderType:S.type,shaderName:S.name,vertexShader:te,fragmentShader:ge,defines:S.defines,customVertexShaderID:ve,customFragmentShaderID:Ee,isRawShaderMaterial:S.isRawShaderMaterial===!0,glslVersion:S.glslVersion,precision:f,batching:we,instancing:ke,instancingColor:ke&&ae.instanceColor!==null,supportsVertexTextures:d,outputColorSpace:Ie===null?e.outputColorSpace:Ie.isXRRenderTarget===!0?Ie.texture.colorSpace:"srgb-linear",map:Ge,matcap:P,envMap:ce,envMapMode:ce&&ne.mapping,envMapCubeUVHeight:V,aoMap:j,lightMap:Q,bumpMap:Z,normalMap:xe,displacementMap:d&&Se,emissiveMap:be,normalMapObjectSpace:xe&&S.normalMapType===1,normalMapTangentSpace:xe&&S.normalMapType===0,metalnessMap:E,roughnessMap:y,anisotropy:B,anisotropyMap:pe,clearcoat:ie,clearcoatMap:Te,clearcoatNormalMap:Re,clearcoatRoughnessMap:Fe,iridescence:Y,iridescenceMap:K,iridescenceThicknessMap:L,sheen:se,sheenColorMap:re,sheenRoughnessMap:ye,specularMap:le,specularColorMap:_e,specularIntensityMap:Oe,transmission:Le,transmissionMap:Xe,thicknessMap:je,gradientMap:rt,opaque:S.transparent===!1&&S.blending===1,alphaMap:de,alphaTest:N,alphaHash:he,combine:S.combine,mapUv:Ge&&_(S.map.channel),aoMapUv:j&&_(S.aoMap.channel),lightMapUv:Q&&_(S.lightMap.channel),bumpMapUv:Z&&_(S.bumpMap.channel),normalMapUv:xe&&_(S.normalMap.channel),displacementMapUv:Se&&_(S.displacementMap.channel),emissiveMapUv:be&&_(S.emissiveMap.channel),metalnessMapUv:E&&_(S.metalnessMap.channel),roughnessMapUv:y&&_(S.roughnessMap.channel),anisotropyMapUv:pe&&_(S.anisotropyMap.channel),clearcoatMapUv:Te&&_(S.clearcoatMap.channel),clearcoatNormalMapUv:Re&&_(S.clearcoatNormalMap.channel),clearcoatRoughnessMapUv:Fe&&_(S.clearcoatRoughnessMap.channel),iridescenceMapUv:K&&_(S.iridescenceMap.channel),iridescenceThicknessMapUv:L&&_(S.iridescenceThicknessMap.channel),sheenColorMapUv:re&&_(S.sheenColorMap.channel),sheenRoughnessMapUv:ye&&_(S.sheenRoughnessMap.channel),specularMapUv:le&&_(S.specularMap.channel),specularColorMapUv:_e&&_(S.specularColorMap.channel),specularIntensityMapUv:Oe&&_(S.specularIntensityMap.channel),transmissionMapUv:Xe&&_(S.transmissionMap.channel),thicknessMapUv:je&&_(S.thicknessMap.channel),alphaMapUv:de&&_(S.alphaMap.channel),vertexTangents:!!z.attributes.tangent&&(xe||B),vertexColors:S.vertexColors,vertexAlphas:S.vertexColors===!0&&!!z.attributes.color&&z.attributes.color.itemSize===4,vertexUv1s:Ne,vertexUv2s:Ce,vertexUv3s:it,pointsUvs:ae.isPoints===!0&&!!z.attributes.uv&&(Ge||de),fog:!!I,useFog:S.fog===!0,fogExp2:I&&I.isFogExp2,flatShading:S.flatShading===!0,sizeAttenuation:S.sizeAttenuation===!0,logarithmicDepthBuffer:u,skinning:ae.isSkinnedMesh===!0,morphTargets:z.morphAttributes.position!==void 0,morphNormals:z.morphAttributes.normal!==void 0,morphColors:z.morphAttributes.color!==void 0,morphTargetsCount:oe,morphTextureStride:O,numDirLights:w.directional.length,numPointLights:w.point.length,numSpotLights:w.spot.length,numSpotLightMaps:w.spotLightMap.length,numRectAreaLights:w.rectArea.length,numHemiLights:w.hemi.length,numDirLightShadows:w.directionalShadowMap.length,numPointLightShadows:w.pointShadowMap.length,numSpotLightShadows:w.spotShadowMap.length,numSpotLightShadowsWithMaps:w.numSpotLightShadowsWithMaps,numLightProbes:w.numLightProbes,numClippingPlanes:a.numPlanes,numClipIntersection:a.numIntersection,dithering:S.dithering,shadowMapEnabled:e.shadowMap.enabled&&U.length>0,shadowMapType:e.shadowMap.type,toneMapping:ot,useLegacyLights:e._useLegacyLights,decodeVideoTexture:Ge&&S.map.isVideoTexture===!0&&nt.getTransfer(S.map.colorSpace)==="srgb",premultipliedAlpha:S.premultipliedAlpha,doubleSided:S.side===2,flipSided:S.side===1,useDepthPacking:S.depthPacking>=0,depthPacking:S.depthPacking||0,index0AttributeName:S.index0AttributeName,extensionDerivatives:me&&S.extensions.derivatives===!0,extensionFragDepth:me&&S.extensions.fragDepth===!0,extensionDrawBuffers:me&&S.extensions.drawBuffers===!0,extensionShaderTextureLOD:me&&S.extensions.shaderTextureLOD===!0,extensionClipCullDistance:me&&S.extensions.clipCullDistance&&i.has("WEBGL_clip_cull_distance"),rendererExtensionFragDepth:h||i.has("EXT_frag_depth"),rendererExtensionDrawBuffers:h||i.has("WEBGL_draw_buffers"),rendererExtensionShaderTextureLod:h||i.has("EXT_shader_texture_lod"),rendererExtensionParallelShaderCompile:i.has("KHR_parallel_shader_compile"),customProgramCacheKey:S.customProgramCacheKey()}}function p(S){let w=[];if(S.shaderID)w.push(S.shaderID);else w.push(S.customVertexShaderID),w.push(S.customFragmentShaderID);if(S.defines!==void 0)for(let U in S.defines)w.push(U),w.push(S.defines[U]);if(S.isRawShaderMaterial===!1)x(w,S),v(w,S),w.push(e.outputColorSpace);return w.push(S.customProgramCacheKey),w.join()}function x(S,w){S.push(w.precision),S.push(w.outputColorSpace),S.push(w.envMapMode),S.push(w.envMapCubeUVHeight),S.push(w.mapUv),S.push(w.alphaMapUv),S.push(w.lightMapUv),S.push(w.aoMapUv),S.push(w.bumpMapUv),S.push(w.normalMapUv),S.push(w.displacementMapUv),S.push(w.emissiveMapUv),S.push(w.metalnessMapUv),S.push(w.roughnessMapUv),S.push(w.anisotropyMapUv),S.push(w.clearcoatMapUv),S.push(w.clearcoatNormalMapUv),S.push(w.clearcoatRoughnessMapUv),S.push(w.iridescenceMapUv),S.push(w.iridescenceThicknessMapUv),S.push(w.sheenColorMapUv),S.push(w.sheenRoughnessMapUv),S.push(w.specularMapUv),S.push(w.specularColorMapUv),S.push(w.specularIntensityMapUv),S.push(w.transmissionMapUv),S.push(w.thicknessMapUv),S.push(w.combine),S.push(w.fogExp2),S.push(w.sizeAttenuation),S.push(w.morphTargetsCount),S.push(w.morphAttributeCount),S.push(w.numDirLights),S.push(w.numPointLights),S.push(w.numSpotLights),S.push(w.numSpotLightMaps),S.push(w.numHemiLights),S.push(w.numRectAreaLights),S.push(w.numDirLightShadows),S.push(w.numPointLightShadows),S.push(w.numSpotLightShadows),S.push(w.numSpotLightShadowsWithMaps),S.push(w.numLightProbes),S.push(w.shadowMapType),S.push(w.toneMapping),S.push(w.numClippingPlanes),S.push(w.numClipIntersection),S.push(w.depthPacking)}function v(S,w){if(o.disableAll(),w.isWebGL2)o.enable(0);if(w.supportsVertexTextures)o.enable(1);if(w.instancing)o.enable(2);if(w.instancingColor)o.enable(3);if(w.matcap)o.enable(4);if(w.envMap)o.enable(5);if(w.normalMapObjectSpace)o.enable(6);if(w.normalMapTangentSpace)o.enable(7);if(w.clearcoat)o.enable(8);if(w.iridescence)o.enable(9);if(w.alphaTest)o.enable(10);if(w.vertexColors)o.enable(11);if(w.vertexAlphas)o.enable(12);if(w.vertexUv1s)o.enable(13);if(w.vertexUv2s)o.enable(14);if(w.vertexUv3s)o.enable(15);if(w.vertexTangents)o.enable(16);if(w.anisotropy)o.enable(17);if(w.alphaHash)o.enable(18);if(w.batching)o.enable(19);if(S.push(o.mask),o.disableAll(),w.fog)o.enable(0);if(w.useFog)o.enable(1);if(w.flatShading)o.enable(2);if(w.logarithmicDepthBuffer)o.enable(3);if(w.skinning)o.enable(4);if(w.morphTargets)o.enable(5);if(w.morphNormals)o.enable(6);if(w.morphColors)o.enable(7);if(w.premultipliedAlpha)o.enable(8);if(w.shadowMapEnabled)o.enable(9);if(w.useLegacyLights)o.enable(10);if(w.doubleSided)o.enable(11);if(w.flipSided)o.enable(12);if(w.useDepthPacking)o.enable(13);if(w.dithering)o.enable(14);if(w.transmission)o.enable(15);if(w.sheen)o.enable(16);if(w.opaque)o.enable(17);if(w.pointsUvs)o.enable(18);if(w.decodeVideoTexture)o.enable(19);S.push(o.mask)}function b(S){let w=g[S.type],U;if(w){let J=cn[w];U=zn.clone(J.uniforms)}else U=S.uniforms;return U}function R(S,w){let U;for(let J=0,ae=c.length;J<ae;J++){let I=c[J];if(I.cacheKey===w){U=I,++U.usedTimes;break}}if(U===void 0)U=new $g(e,w,S,r),c.push(U);return U}function M(S){if(--S.usedTimes===0){let w=c.indexOf(S);c[w]=c[c.length-1],c.pop(),S.destroy()}}function C(S){l.remove(S)}function D(){l.dispose()}return{getParameters:m,getProgramCacheKey:p,getUniforms:b,acquireProgram:R,releaseProgram:M,releaseShaderCache:C,programs:c,dispose:D}}function e_(){let e=new WeakMap;function t(r){let a=e.get(r);if(a===void 0)a={},e.set(r,a);return a}function n(r){e.delete(r)}function i(r,a,o){e.get(r)[a]=o}function s(){e=new WeakMap}return{get:t,remove:n,update:i,dispose:s}}function t_(e,t){if(e.groupOrder!==t.groupOrder)return e.groupOrder-t.groupOrder;else if(e.renderOrder!==t.renderOrder)return e.renderOrder-t.renderOrder;else if(e.material.id!==t.material.id)return e.material.id-t.material.id;else if(e.z!==t.z)return e.z-t.z;else return e.id-t.id}function zl(e,t){if(e.groupOrder!==t.groupOrder)return e.groupOrder-t.groupOrder;else if(e.renderOrder!==t.renderOrder)return e.renderOrder-t.renderOrder;else if(e.z!==t.z)return t.z-e.z;else return e.id-t.id}function kl(){let e=[],t=0,n=[],i=[],s=[];function r(){t=0,n.length=0,i.length=0,s.length=0}function a(u,d,f,g,_,m){let p=e[t];if(p===void 0)p={id:u.id,object:u,geometry:d,material:f,groupOrder:g,renderOrder:u.renderOrder,z:_,group:m},e[t]=p;else p.id=u.id,p.object=u,p.geometry=d,p.material=f,p.groupOrder=g,p.renderOrder=u.renderOrder,p.z=_,p.group=m;return t++,p}function o(u,d,f,g,_,m){let p=a(u,d,f,g,_,m);if(f.transmission>0)i.push(p);else if(f.transparent===!0)s.push(p);else n.push(p)}function l(u,d,f,g,_,m){let p=a(u,d,f,g,_,m);if(f.transmission>0)i.unshift(p);else if(f.transparent===!0)s.unshift(p);else n.unshift(p)}function c(u,d){if(n.length>1)n.sort(u||t_);if(i.length>1)i.sort(d||zl);if(s.length>1)s.sort(d||zl)}function h(){for(let u=t,d=e.length;u<d;u++){let f=e[u];if(f.id===null)break;f.id=null,f.object=null,f.geometry=null,f.material=null,f.group=null}}return{opaque:n,transmissive:i,transparent:s,init:r,push:o,unshift:l,finish:h,sort:c}}function n_(){let e=new WeakMap;function t(i,s){let r=e.get(i),a;if(r===void 0)a=new kl,e.set(i,[a]);else if(s>=r.length)a=new kl,r.push(a);else a=r[s];return a}function n(){e=new WeakMap}return{get:t,dispose:n}}function i_(){let e={};return{get:function(t){if(e[t.id]!==void 0)return e[t.id];let n;switch(t.type){case"DirectionalLight":n={direction:new T,color:new ue};break;case"SpotLight":n={position:new T,direction:new T,color:new ue,distance:0,coneCos:0,penumbraCos:0,decay:0};break;case"PointLight":n={position:new T,color:new ue,distance:0,decay:0};break;case"HemisphereLight":n={direction:new T,skyColor:new ue,groundColor:new ue};break;case"RectAreaLight":n={color:new ue,position:new T,halfWidth:new T,halfHeight:new T};break}return e[t.id]=n,n}}}function s_(){let e={};return{get:function(t){if(e[t.id]!==void 0)return e[t.id];let n;switch(t.type){case"DirectionalLight":n={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new W};break;case"SpotLight":n={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new W};break;case"PointLight":n={shadowBias:0,shadowNormalBias:0,shadowRadius:1,shadowMapSize:new W,shadowCameraNear:1,shadowCameraFar:1000};break}return e[t.id]=n,n}}}var r_=0;function a_(e,t){return(t.castShadow?2:0)-(e.castShadow?2:0)+(t.map?1:0)-(e.map?1:0)}function o_(e,t){let n=new i_,i=s_(),s={version:0,hash:{directionalLength:-1,pointLength:-1,spotLength:-1,rectAreaLength:-1,hemiLength:-1,numDirectionalShadows:-1,numPointShadows:-1,numSpotShadows:-1,numSpotMaps:-1,numLightProbes:-1},ambient:[0,0,0],probe:[],directional:[],directionalShadow:[],directionalShadowMap:[],directionalShadowMatrix:[],spot:[],spotLightMap:[],spotShadow:[],spotShadowMap:[],spotLightMatrix:[],rectArea:[],rectAreaLTC1:null,rectAreaLTC2:null,point:[],pointShadow:[],pointShadowMap:[],pointShadowMatrix:[],hemi:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};for(let h=0;h<9;h++)s.probe.push(new T);let r=new T,a=new De,o=new De;function l(h,u){let d=0,f=0,g=0;for(let J=0;J<9;J++)s.probe[J].set(0,0,0);let _=0,m=0,p=0,x=0,v=0,b=0,R=0,M=0,C=0,D=0,S=0;h.sort(a_);let w=u===!0?Math.PI:1;for(let J=0,ae=h.length;J<ae;J++){let I=h[J],{color:z,intensity:X,distance:ne}=I,V=I.shadow&&I.shadow.map?I.shadow.map.texture:null;if(I.isAmbientLight)d+=z.r*X*w,f+=z.g*X*w,g+=z.b*X*w;else if(I.isLightProbe){for(let q=0;q<9;q++)s.probe[q].addScaledVector(I.sh.coefficients[q],X);S++}else if(I.isDirectionalLight){let q=n.get(I);if(q.color.copy(I.color).multiplyScalar(I.intensity*w),I.castShadow){let ee=I.shadow,oe=i.get(I);oe.shadowBias=ee.bias,oe.shadowNormalBias=ee.normalBias,oe.shadowRadius=ee.radius,oe.shadowMapSize=ee.mapSize,s.directionalShadow[_]=oe,s.directionalShadowMap[_]=V,s.directionalShadowMatrix[_]=I.shadow.matrix,b++}s.directional[_]=q,_++}else if(I.isSpotLight){let q=n.get(I);q.position.setFromMatrixPosition(I.matrixWorld),q.color.copy(z).multiplyScalar(X*w),q.distance=ne,q.coneCos=Math.cos(I.angle),q.penumbraCos=Math.cos(I.angle*(1-I.penumbra)),q.decay=I.decay,s.spot[p]=q;let ee=I.shadow;if(I.map){if(s.spotLightMap[C]=I.map,C++,ee.updateMatrices(I),I.castShadow)D++}if(s.spotLightMatrix[p]=ee.matrix,I.castShadow){let oe=i.get(I);oe.shadowBias=ee.bias,oe.shadowNormalBias=ee.normalBias,oe.shadowRadius=ee.radius,oe.shadowMapSize=ee.mapSize,s.spotShadow[p]=oe,s.spotShadowMap[p]=V,M++}p++}else if(I.isRectAreaLight){let q=n.get(I);q.color.copy(z).multiplyScalar(X),q.halfWidth.set(I.width*0.5,0,0),q.halfHeight.set(0,I.height*0.5,0),s.rectArea[x]=q,x++}else if(I.isPointLight){let q=n.get(I);if(q.color.copy(I.color).multiplyScalar(I.intensity*w),q.distance=I.distance,q.decay=I.decay,I.castShadow){let ee=I.shadow,oe=i.get(I);oe.shadowBias=ee.bias,oe.shadowNormalBias=ee.normalBias,oe.shadowRadius=ee.radius,oe.shadowMapSize=ee.mapSize,oe.shadowCameraNear=ee.camera.near,oe.shadowCameraFar=ee.camera.far,s.pointShadow[m]=oe,s.pointShadowMap[m]=V,s.pointShadowMatrix[m]=I.shadow.matrix,R++}s.point[m]=q,m++}else if(I.isHemisphereLight){let q=n.get(I);q.skyColor.copy(I.color).multiplyScalar(X*w),q.groundColor.copy(I.groundColor).multiplyScalar(X*w),s.hemi[v]=q,v++}}if(x>0)if(t.isWebGL2)if(e.has("OES_texture_float_linear")===!0)s.rectAreaLTC1=fe.LTC_FLOAT_1,s.rectAreaLTC2=fe.LTC_FLOAT_2;else s.rectAreaLTC1=fe.LTC_HALF_1,s.rectAreaLTC2=fe.LTC_HALF_2;else if(e.has("OES_texture_float_linear")===!0)s.rectAreaLTC1=fe.LTC_FLOAT_1,s.rectAreaLTC2=fe.LTC_FLOAT_2;else if(e.has("OES_texture_half_float_linear")===!0)s.rectAreaLTC1=fe.LTC_HALF_1,s.rectAreaLTC2=fe.LTC_HALF_2;else console.error("THREE.WebGLRenderer: Unable to use RectAreaLight. Missing WebGL extensions.");s.ambient[0]=d,s.ambient[1]=f,s.ambient[2]=g;let U=s.hash;if(U.directionalLength!==_||U.pointLength!==m||U.spotLength!==p||U.rectAreaLength!==x||U.hemiLength!==v||U.numDirectionalShadows!==b||U.numPointShadows!==R||U.numSpotShadows!==M||U.numSpotMaps!==C||U.numLightProbes!==S)s.directional.length=_,s.spot.length=p,s.rectArea.length=x,s.point.length=m,s.hemi.length=v,s.directionalShadow.length=b,s.directionalShadowMap.length=b,s.pointShadow.length=R,s.pointShadowMap.length=R,s.spotShadow.length=M,s.spotShadowMap.length=M,s.directionalShadowMatrix.length=b,s.pointShadowMatrix.length=R,s.spotLightMatrix.length=M+C-D,s.spotLightMap.length=C,s.numSpotLightShadowsWithMaps=D,s.numLightProbes=S,U.directionalLength=_,U.pointLength=m,U.spotLength=p,U.rectAreaLength=x,U.hemiLength=v,U.numDirectionalShadows=b,U.numPointShadows=R,U.numSpotShadows=M,U.numSpotMaps=C,U.numLightProbes=S,s.version=r_++}function c(h,u){let d=0,f=0,g=0,_=0,m=0,p=u.matrixWorldInverse;for(let x=0,v=h.length;x<v;x++){let b=h[x];if(b.isDirectionalLight){let R=s.directional[d];R.direction.setFromMatrixPosition(b.matrixWorld),r.setFromMatrixPosition(b.target.matrixWorld),R.direction.sub(r),R.direction.transformDirection(p),d++}else if(b.isSpotLight){let R=s.spot[g];R.position.setFromMatrixPosition(b.matrixWorld),R.position.applyMatrix4(p),R.direction.setFromMatrixPosition(b.matrixWorld),r.setFromMatrixPosition(b.target.matrixWorld),R.direction.sub(r),R.direction.transformDirection(p),g++}else if(b.isRectAreaLight){let R=s.rectArea[_];R.position.setFromMatrixPosition(b.matrixWorld),R.position.applyMatrix4(p),o.identity(),a.copy(b.matrixWorld),a.premultiply(p),o.extractRotation(a),R.halfWidth.set(b.width*0.5,0,0),R.halfHeight.set(0,b.height*0.5,0),R.halfWidth.applyMatrix4(o),R.halfHeight.applyMatrix4(o),_++}else if(b.isPointLight){let R=s.point[f];R.position.setFromMatrixPosition(b.matrixWorld),R.position.applyMatrix4(p),f++}else if(b.isHemisphereLight){let R=s.hemi[m];R.direction.setFromMatrixPosition(b.matrixWorld),R.direction.transformDirection(p),m++}}}return{setup:l,setupView:c,state:s}}function Gl(e,t){let n=new o_(e,t),i=[],s=[];function r(){i.length=0,s.length=0}function a(u){i.push(u)}function o(u){s.push(u)}function l(u){n.setup(i,u)}function c(u){n.setupView(i,u)}return{init:r,state:{lightsArray:i,shadowsArray:s,lights:n},setupLights:l,setupLightsView:c,pushLight:a,pushShadow:o}}function l_(e,t){let n=new WeakMap;function i(r,a=0){let o=n.get(r),l;if(o===void 0)l=new Gl(e,t),n.set(r,[l]);else if(a>=o.length)l=new Gl(e,t),o.push(l);else l=o[a];return l}function s(){n=new WeakMap}return{get:i,dispose:s}}class co extends xt{constructor(e){super();this.isMeshDepthMaterial=!0,this.type="MeshDepthMaterial",this.depthPacking=3200,this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.setValues(e)}copy(e){return super.copy(e),this.depthPacking=e.depthPacking,this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this}}class ho extends xt{constructor(e){super();this.isMeshDistanceMaterial=!0,this.type="MeshDistanceMaterial",this.map=null,this.alphaMap=null,this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.setValues(e)}copy(e){return super.copy(e),this.map=e.map,this.alphaMap=e.alphaMap,this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this}}var c_=`void main() {
	gl_Position = vec4( position, 1.0 );
}`,h_=`uniform sampler2D shadow_pass;
uniform vec2 resolution;
uniform float radius;
#include <packing>
void main() {
	const float samples = float( VSM_SAMPLES );
	float mean = 0.0;
	float squared_mean = 0.0;
	float uvStride = samples <= 1.0 ? 0.0 : 2.0 / ( samples - 1.0 );
	float uvStart = samples <= 1.0 ? 0.0 : - 1.0;
	for ( float i = 0.0; i < samples; i ++ ) {
		float uvOffset = uvStart + i * uvStride;
		#ifdef HORIZONTAL_PASS
			vec2 distribution = unpackRGBATo2Half( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( uvOffset, 0.0 ) * radius ) / resolution ) );
			mean += distribution.x;
			squared_mean += distribution.y * distribution.y + distribution.x * distribution.x;
		#else
			float depth = unpackRGBAToDepth( texture2D( shadow_pass, ( gl_FragCoord.xy + vec2( 0.0, uvOffset ) * radius ) / resolution ) );
			mean += depth;
			squared_mean += depth * depth;
		#endif
	}
	mean = mean / samples;
	squared_mean = squared_mean / samples;
	float std_dev = sqrt( squared_mean - mean * mean );
	gl_FragColor = pack2HalfToRGBA( vec2( mean, std_dev ) );
}`;function u_(e,t,n){let i=new ws,s=new W,r=new W,a=new at,o=new co({depthPacking:3201}),l=new ho,c={},h=n.maxTextureSize,u={[0]:1,[1]:0,[2]:2},d=new Et({defines:{VSM_SAMPLES:8},uniforms:{shadow_pass:{value:null},resolution:{value:new W},radius:{value:4}},vertexShader:c_,fragmentShader:h_}),f=d.clone();f.defines.HORIZONTAL_PASS=1;let g=new ze;g.setAttribute("position",new tt(new Float32Array([-1,-1,0.5,3,-1,0.5,-1,3,0.5]),3));let _=new Je(g,d),m=this;this.enabled=!1,this.autoUpdate=!0,this.needsUpdate=!1,this.type=1;let p=this.type;this.render=function(M,C,D){if(m.enabled===!1)return;if(m.autoUpdate===!1&&m.needsUpdate===!1)return;if(M.length===0)return;let S=e.getRenderTarget(),w=e.getActiveCubeFace(),U=e.getActiveMipmapLevel(),J=e.state;J.setBlending(0),J.buffers.color.setClear(1,1,1,1),J.buffers.depth.setTest(!0),J.setScissorTest(!1);let ae=p!==3&&this.type===3,I=p===3&&this.type!==3;for(let z=0,X=M.length;z<X;z++){let ne=M[z],V=ne.shadow;if(V===void 0){console.warn("THREE.WebGLShadowMap:",ne,"has no shadow.");continue}if(V.autoUpdate===!1&&V.needsUpdate===!1)continue;s.copy(V.mapSize);let q=V.getFrameExtents();if(s.multiply(q),r.copy(V.mapSize),s.x>h||s.y>h){if(s.x>h)r.x=Math.floor(h/q.x),s.x=r.x*q.x,V.mapSize.x=r.x;if(s.y>h)r.y=Math.floor(h/q.y),s.y=r.y*q.y,V.mapSize.y=r.y}if(V.map===null||ae===!0||I===!0){let oe=this.type!==3?{minFilter:1003,magFilter:1003}:{};if(V.map!==null)V.map.dispose();V.map=new Ct(s.x,s.y,oe),V.map.texture.name=ne.name+".shadowMap",V.camera.updateProjectionMatrix()}e.setRenderTarget(V.map),e.clear();let ee=V.getViewportCount();for(let oe=0;oe<ee;oe++){let O=V.getViewport(oe);a.set(r.x*O.x,r.y*O.y,r.x*O.z,r.y*O.w),J.viewport(a),V.updateMatrices(ne,oe),i=V.getFrustum(),b(C,D,V.camera,ne,this.type)}if(V.isPointLightShadow!==!0&&this.type===3)x(V,D);V.needsUpdate=!1}p=this.type,m.needsUpdate=!1,e.setRenderTarget(S,w,U)};function x(M,C){let D=t.update(_);if(d.defines.VSM_SAMPLES!==M.blurSamples)d.defines.VSM_SAMPLES=M.blurSamples,f.defines.VSM_SAMPLES=M.blurSamples,d.needsUpdate=!0,f.needsUpdate=!0;if(M.mapPass===null)M.mapPass=new Ct(s.x,s.y);d.uniforms.shadow_pass.value=M.map.texture,d.uniforms.resolution.value=M.mapSize,d.uniforms.radius.value=M.radius,e.setRenderTarget(M.mapPass),e.clear(),e.renderBufferDirect(C,null,D,d,_,null),f.uniforms.shadow_pass.value=M.mapPass.texture,f.uniforms.resolution.value=M.mapSize,f.uniforms.radius.value=M.radius,e.setRenderTarget(M.map),e.clear(),e.renderBufferDirect(C,null,D,f,_,null)}function v(M,C,D,S){let w=null,U=D.isPointLight===!0?M.customDistanceMaterial:M.customDepthMaterial;if(U!==void 0)w=U;else if(w=D.isPointLight===!0?l:o,e.localClippingEnabled&&C.clipShadows===!0&&Array.isArray(C.clippingPlanes)&&C.clippingPlanes.length!==0||C.displacementMap&&C.displacementScale!==0||C.alphaMap&&C.alphaTest>0||C.map&&C.alphaTest>0){let J=w.uuid,ae=C.uuid,I=c[J];if(I===void 0)I={},c[J]=I;let z=I[ae];if(z===void 0)z=w.clone(),I[ae]=z,C.addEventListener("dispose",R);w=z}if(w.visible=C.visible,w.wireframe=C.wireframe,S===3)w.side=C.shadowSide!==null?C.shadowSide:C.side;else w.side=C.shadowSide!==null?C.shadowSide:u[C.side];if(w.alphaMap=C.alphaMap,w.alphaTest=C.alphaTest,w.map=C.map,w.clipShadows=C.clipShadows,w.clippingPlanes=C.clippingPlanes,w.clipIntersection=C.clipIntersection,w.displacementMap=C.displacementMap,w.displacementScale=C.displacementScale,w.displacementBias=C.displacementBias,w.wireframeLinewidth=C.wireframeLinewidth,w.linewidth=C.linewidth,D.isPointLight===!0&&w.isMeshDistanceMaterial===!0){let J=e.properties.get(w);J.light=D}return w}function b(M,C,D,S,w){if(M.visible===!1)return;if(M.layers.test(C.layers)&&(M.isMesh||M.isLine||M.isPoints)){if((M.castShadow||M.receiveShadow&&w===3)&&(!M.frustumCulled||i.intersectsObject(M))){M.modelViewMatrix.multiplyMatrices(D.matrixWorldInverse,M.matrixWorld);let ae=t.update(M),I=M.material;if(Array.isArray(I)){let z=ae.groups;for(let X=0,ne=z.length;X<ne;X++){let V=z[X],q=I[V.materialIndex];if(q&&q.visible){let ee=v(M,q,S,w);M.onBeforeShadow(e,M,C,D,ae,ee,V),e.renderBufferDirect(D,null,ae,ee,M,V),M.onAfterShadow(e,M,C,D,ae,ee,V)}}}else if(I.visible){let z=v(M,I,S,w);M.onBeforeShadow(e,M,C,D,ae,z,null),e.renderBufferDirect(D,null,ae,z,M,null),M.onAfterShadow(e,M,C,D,ae,z,null)}}}let J=M.children;for(let ae=0,I=J.length;ae<I;ae++)b(J[ae],C,D,S,w)}function R(M){M.target.removeEventListener("dispose",R);for(let D in c){let S=c[D],w=M.target.uuid;if(w in S)S[w].dispose(),delete S[w]}}}function d_(e,t,n){let i=n.isWebGL2;function s(){let N=!1,he=new at,me=null,Ne=new at(0,0,0,0);return{setMask:function(Ce){if(me!==Ce&&!N)e.colorMask(Ce,Ce,Ce,Ce),me=Ce},setLocked:function(Ce){N=Ce},setClear:function(Ce,it,ot,vt,Ft){if(Ft===!0)Ce*=vt,it*=vt,ot*=vt;if(he.set(Ce,it,ot,vt),Ne.equals(he)===!1)e.clearColor(Ce,it,ot,vt),Ne.copy(he)},reset:function(){N=!1,me=null,Ne.set(-1,0,0,0)}}}function r(){let N=!1,he=null,me=null,Ne=null;return{setTest:function(Ce){if(Ce)we(e.DEPTH_TEST);else Ge(e.DEPTH_TEST)},setMask:function(Ce){if(he!==Ce&&!N)e.depthMask(Ce),he=Ce},setFunc:function(Ce){if(me!==Ce){switch(Ce){case 0:e.depthFunc(e.NEVER);break;case 1:e.depthFunc(e.ALWAYS);break;case 2:e.depthFunc(e.LESS);break;case 3:e.depthFunc(e.LEQUAL);break;case 4:e.depthFunc(e.EQUAL);break;case 5:e.depthFunc(e.GEQUAL);break;case 6:e.depthFunc(e.GREATER);break;case 7:e.depthFunc(e.NOTEQUAL);break;default:e.depthFunc(e.LEQUAL)}me=Ce}},setLocked:function(Ce){N=Ce},setClear:function(Ce){if(Ne!==Ce)e.clearDepth(Ce),Ne=Ce},reset:function(){N=!1,he=null,me=null,Ne=null}}}function a(){let N=!1,he=null,me=null,Ne=null,Ce=null,it=null,ot=null,vt=null,Ft=null;return{setTest:function(st){if(!N)if(st)we(e.STENCIL_TEST);else Ge(e.STENCIL_TEST)},setMask:function(st){if(he!==st&&!N)e.stencilMask(st),he=st},setFunc:function(st,an,on){if(me!==st||Ne!==an||Ce!==on)e.stencilFunc(st,an,on),me=st,Ne=an,Ce=on},setOp:function(st,an,on){if(it!==st||ot!==an||vt!==on)e.stencilOp(st,an,on),it=st,ot=an,vt=on},setLocked:function(st){N=st},setClear:function(st){if(Ft!==st)e.clearStencil(st),Ft=st},reset:function(){N=!1,he=null,me=null,Ne=null,Ce=null,it=null,ot=null,vt=null,Ft=null}}}let o=new s,l=new r,c=new a,h=new WeakMap,u=new WeakMap,d={},f={},g=new WeakMap,_=[],m=null,p=!1,x=null,v=null,b=null,R=null,M=null,C=null,D=null,S=new ue(0,0,0),w=0,U=!1,J=null,ae=null,I=null,z=null,X=null,ne=e.getParameter(e.MAX_COMBINED_TEXTURE_IMAGE_UNITS),V=!1,q=0,ee=e.getParameter(e.VERSION);if(ee.indexOf("WebGL")!==-1)q=parseFloat(/^WebGL (\d)/.exec(ee)[1]),V=q>=1;else if(ee.indexOf("OpenGL ES")!==-1)q=parseFloat(/^OpenGL ES (\d)/.exec(ee)[1]),V=q>=2;let oe=null,O={},te=e.getParameter(e.SCISSOR_BOX),ge=e.getParameter(e.VIEWPORT),ve=new at().fromArray(te),Ee=new at().fromArray(ge);function Ie(N,he,me,Ne){let Ce=new Uint8Array(4),it=e.createTexture();e.bindTexture(N,it),e.texParameteri(N,e.TEXTURE_MIN_FILTER,e.NEAREST),e.texParameteri(N,e.TEXTURE_MAG_FILTER,e.NEAREST);for(let ot=0;ot<me;ot++)if(i&&(N===e.TEXTURE_3D||N===e.TEXTURE_2D_ARRAY))e.texImage3D(he,0,e.RGBA,1,1,Ne,0,e.RGBA,e.UNSIGNED_BYTE,Ce);else e.texImage2D(he+ot,0,e.RGBA,1,1,0,e.RGBA,e.UNSIGNED_BYTE,Ce);return it}let ke={};if(ke[e.TEXTURE_2D]=Ie(e.TEXTURE_2D,e.TEXTURE_2D,1),ke[e.TEXTURE_CUBE_MAP]=Ie(e.TEXTURE_CUBE_MAP,e.TEXTURE_CUBE_MAP_POSITIVE_X,6),i)ke[e.TEXTURE_2D_ARRAY]=Ie(e.TEXTURE_2D_ARRAY,e.TEXTURE_2D_ARRAY,1,1),ke[e.TEXTURE_3D]=Ie(e.TEXTURE_3D,e.TEXTURE_3D,1,1);o.setClear(0,0,0,1),l.setClear(1),c.setClear(0),we(e.DEPTH_TEST),l.setFunc(3),be(!1),E(1),we(e.CULL_FACE),xe(0);function we(N){if(d[N]!==!0)e.enable(N),d[N]=!0}function Ge(N){if(d[N]!==!1)e.disable(N),d[N]=!1}function P(N,he){if(f[N]!==he){if(e.bindFramebuffer(N,he),f[N]=he,i){if(N===e.DRAW_FRAMEBUFFER)f[e.FRAMEBUFFER]=he;if(N===e.FRAMEBUFFER)f[e.DRAW_FRAMEBUFFER]=he}return!0}return!1}function ce(N,he){let me=_,Ne=!1;if(N){if(me=g.get(he),me===void 0)me=[],g.set(he,me);if(N.isWebGLMultipleRenderTargets){let Ce=N.texture;if(me.length!==Ce.length||me[0]!==e.COLOR_ATTACHMENT0){for(let it=0,ot=Ce.length;it<ot;it++)me[it]=e.COLOR_ATTACHMENT0+it;me.length=Ce.length,Ne=!0}}else if(me[0]!==e.COLOR_ATTACHMENT0)me[0]=e.COLOR_ATTACHMENT0,Ne=!0}else if(me[0]!==e.BACK)me[0]=e.BACK,Ne=!0;if(Ne)if(n.isWebGL2)e.drawBuffers(me);else t.get("WEBGL_draw_buffers").drawBuffersWEBGL(me)}function j(N){if(m!==N)return e.useProgram(N),m=N,!0;return!1}let Q={[100]:e.FUNC_ADD,[101]:e.FUNC_SUBTRACT,[102]:e.FUNC_REVERSE_SUBTRACT};if(i)Q[103]=e.MIN,Q[104]=e.MAX;else{let N=t.get("EXT_blend_minmax");if(N!==null)Q[103]=N.MIN_EXT,Q[104]=N.MAX_EXT}let Z={[200]:e.ZERO,[201]:e.ONE,[202]:e.SRC_COLOR,[204]:e.SRC_ALPHA,[210]:e.SRC_ALPHA_SATURATE,[208]:e.DST_COLOR,[206]:e.DST_ALPHA,[203]:e.ONE_MINUS_SRC_COLOR,[205]:e.ONE_MINUS_SRC_ALPHA,[209]:e.ONE_MINUS_DST_COLOR,[207]:e.ONE_MINUS_DST_ALPHA,[211]:e.CONSTANT_COLOR,[212]:e.ONE_MINUS_CONSTANT_COLOR,[213]:e.CONSTANT_ALPHA,[214]:e.ONE_MINUS_CONSTANT_ALPHA};function xe(N,he,me,Ne,Ce,it,ot,vt,Ft,st){if(N===0){if(p===!0)Ge(e.BLEND),p=!1;return}if(p===!1)we(e.BLEND),p=!0;if(N!==5){if(N!==x||st!==U){if(v!==100||M!==100)e.blendEquation(e.FUNC_ADD),v=100,M=100;if(st)switch(N){case 1:e.blendFuncSeparate(e.ONE,e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA);break;case 2:e.blendFunc(e.ONE,e.ONE);break;case 3:e.blendFuncSeparate(e.ZERO,e.ONE_MINUS_SRC_COLOR,e.ZERO,e.ONE);break;case 4:e.blendFuncSeparate(e.ZERO,e.SRC_COLOR,e.ZERO,e.SRC_ALPHA);break;default:console.error("THREE.WebGLState: Invalid blending: ",N);break}else switch(N){case 1:e.blendFuncSeparate(e.SRC_ALPHA,e.ONE_MINUS_SRC_ALPHA,e.ONE,e.ONE_MINUS_SRC_ALPHA);break;case 2:e.blendFunc(e.SRC_ALPHA,e.ONE);break;case 3:e.blendFuncSeparate(e.ZERO,e.ONE_MINUS_SRC_COLOR,e.ZERO,e.ONE);break;case 4:e.blendFunc(e.ZERO,e.SRC_COLOR);break;default:console.error("THREE.WebGLState: Invalid blending: ",N);break}b=null,R=null,C=null,D=null,S.set(0,0,0),w=0,x=N,U=st}return}if(Ce=Ce||he,it=it||me,ot=ot||Ne,he!==v||Ce!==M)e.blendEquationSeparate(Q[he],Q[Ce]),v=he,M=Ce;if(me!==b||Ne!==R||it!==C||ot!==D)e.blendFuncSeparate(Z[me],Z[Ne],Z[it],Z[ot]),b=me,R=Ne,C=it,D=ot;if(vt.equals(S)===!1||Ft!==w)e.blendColor(vt.r,vt.g,vt.b,Ft),S.copy(vt),w=Ft;x=N,U=!1}function Se(N,he){N.side===2?Ge(e.CULL_FACE):we(e.CULL_FACE);let me=N.side===1;if(he)me=!me;be(me),N.blending===1&&N.transparent===!1?xe(0):xe(N.blending,N.blendEquation,N.blendSrc,N.blendDst,N.blendEquationAlpha,N.blendSrcAlpha,N.blendDstAlpha,N.blendColor,N.blendAlpha,N.premultipliedAlpha),l.setFunc(N.depthFunc),l.setTest(N.depthTest),l.setMask(N.depthWrite),o.setMask(N.colorWrite);let Ne=N.stencilWrite;if(c.setTest(Ne),Ne)c.setMask(N.stencilWriteMask),c.setFunc(N.stencilFunc,N.stencilRef,N.stencilFuncMask),c.setOp(N.stencilFail,N.stencilZFail,N.stencilZPass);B(N.polygonOffset,N.polygonOffsetFactor,N.polygonOffsetUnits),N.alphaToCoverage===!0?we(e.SAMPLE_ALPHA_TO_COVERAGE):Ge(e.SAMPLE_ALPHA_TO_COVERAGE)}function be(N){if(J!==N){if(N)e.frontFace(e.CW);else e.frontFace(e.CCW);J=N}}function E(N){if(N!==0){if(we(e.CULL_FACE),N!==ae)if(N===1)e.cullFace(e.BACK);else if(N===2)e.cullFace(e.FRONT);else e.cullFace(e.FRONT_AND_BACK)}else Ge(e.CULL_FACE);ae=N}function y(N){if(N!==I){if(V)e.lineWidth(N);I=N}}function B(N,he,me){if(N){if(we(e.POLYGON_OFFSET_FILL),z!==he||X!==me)e.polygonOffset(he,me),z=he,X=me}else Ge(e.POLYGON_OFFSET_FILL)}function ie(N){if(N)we(e.SCISSOR_TEST);else Ge(e.SCISSOR_TEST)}function Y(N){if(N===void 0)N=e.TEXTURE0+ne-1;if(oe!==N)e.activeTexture(N),oe=N}function se(N,he,me){if(me===void 0)if(oe===null)me=e.TEXTURE0+ne-1;else me=oe;let Ne=O[me];if(Ne===void 0)Ne={type:void 0,texture:void 0},O[me]=Ne;if(Ne.type!==N||Ne.texture!==he){if(oe!==me)e.activeTexture(me),oe=me;e.bindTexture(N,he||ke[N]),Ne.type=N,Ne.texture=he}}function Le(){let N=O[oe];if(N!==void 0&&N.type!==void 0)e.bindTexture(N.type,null),N.type=void 0,N.texture=void 0}function pe(){try{e.compressedTexImage2D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Te(){try{e.compressedTexImage3D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Re(){try{e.texSubImage2D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Fe(){try{e.texSubImage3D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function K(){try{e.compressedTexSubImage2D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function L(){try{e.compressedTexSubImage3D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function re(){try{e.texStorage2D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function ye(){try{e.texStorage3D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function le(){try{e.texImage2D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function _e(){try{e.texImage3D.apply(e,arguments)}catch(N){console.error("THREE.WebGLState:",N)}}function Oe(N){if(ve.equals(N)===!1)e.scissor(N.x,N.y,N.z,N.w),ve.copy(N)}function Xe(N){if(Ee.equals(N)===!1)e.viewport(N.x,N.y,N.z,N.w),Ee.copy(N)}function je(N,he){let me=u.get(he);if(me===void 0)me=new WeakMap,u.set(he,me);let Ne=me.get(N);if(Ne===void 0)Ne=e.getUniformBlockIndex(he,N.name),me.set(N,Ne)}function rt(N,he){let Ne=u.get(he).get(N);if(h.get(he)!==Ne)e.uniformBlockBinding(he,Ne,N.__bindingPointIndex),h.set(he,Ne)}function de(){if(e.disable(e.BLEND),e.disable(e.CULL_FACE),e.disable(e.DEPTH_TEST),e.disable(e.POLYGON_OFFSET_FILL),e.disable(e.SCISSOR_TEST),e.disable(e.STENCIL_TEST),e.disable(e.SAMPLE_ALPHA_TO_COVERAGE),e.blendEquation(e.FUNC_ADD),e.blendFunc(e.ONE,e.ZERO),e.blendFuncSeparate(e.ONE,e.ZERO,e.ONE,e.ZERO),e.blendColor(0,0,0,0),e.colorMask(!0,!0,!0,!0),e.clearColor(0,0,0,0),e.depthMask(!0),e.depthFunc(e.LESS),e.clearDepth(1),e.stencilMask(4294967295),e.stencilFunc(e.ALWAYS,0,4294967295),e.stencilOp(e.KEEP,e.KEEP,e.KEEP),e.clearStencil(0),e.cullFace(e.BACK),e.frontFace(e.CCW),e.polygonOffset(0,0),e.activeTexture(e.TEXTURE0),e.bindFramebuffer(e.FRAMEBUFFER,null),i===!0)e.bindFramebuffer(e.DRAW_FRAMEBUFFER,null),e.bindFramebuffer(e.READ_FRAMEBUFFER,null);e.useProgram(null),e.lineWidth(1),e.scissor(0,0,e.canvas.width,e.canvas.height),e.viewport(0,0,e.canvas.width,e.canvas.height),d={},oe=null,O={},f={},g=new WeakMap,_=[],m=null,p=!1,x=null,v=null,b=null,R=null,M=null,C=null,D=null,S=new ue(0,0,0),w=0,U=!1,J=null,ae=null,I=null,z=null,X=null,ve.set(0,0,e.canvas.width,e.canvas.height),Ee.set(0,0,e.canvas.width,e.canvas.height),o.reset(),l.reset(),c.reset()}return{buffers:{color:o,depth:l,stencil:c},enable:we,disable:Ge,bindFramebuffer:P,drawBuffers:ce,useProgram:j,setBlending:xe,setMaterial:Se,setFlipSided:be,setCullFace:E,setLineWidth:y,setPolygonOffset:B,setScissorTest:ie,activeTexture:Y,bindTexture:se,unbindTexture:Le,compressedTexImage2D:pe,compressedTexImage3D:Te,texImage2D:le,texImage3D:_e,updateUBOMapping:je,uniformBlockBinding:rt,texStorage2D:re,texStorage3D:ye,texSubImage2D:Re,texSubImage3D:Fe,compressedTexSubImage2D:K,compressedTexSubImage3D:L,scissor:Oe,viewport:Xe,reset:de}}function f_(e,t,n,i,s,r,a){let o=s.isWebGL2,l=t.has("WEBGL_multisampled_render_to_texture")?t.get("WEBGL_multisampled_render_to_texture"):null,c=typeof navigator>"u"?!1:/OculusBrowser/g.test(navigator.userAgent),h=new WeakMap,u,d=new WeakMap,f=!1;try{f=typeof OffscreenCanvas<"u"&&new OffscreenCanvas(1,1).getContext("2d")!==null}catch(E){}function g(E,y){return f?new OffscreenCanvas(E,y):vs("canvas")}function _(E,y,B,ie){let Y=1;if(E.width>ie||E.height>ie)Y=ie/Math.max(E.width,E.height);if(Y<1||y===!0)if(typeof HTMLImageElement<"u"&&E instanceof HTMLImageElement||typeof HTMLCanvasElement<"u"&&E instanceof HTMLCanvasElement||typeof ImageBitmap<"u"&&E instanceof ImageBitmap){let se=y?Rr:Math.floor,Le=se(Y*E.width),pe=se(Y*E.height);if(u===void 0)u=g(Le,pe);let Te=B?g(Le,pe):u;return Te.width=Le,Te.height=pe,Te.getContext("2d").drawImage(E,0,0,Le,pe),console.warn("THREE.WebGLRenderer: Texture has been resized from ("+E.width+"x"+E.height+") to ("+Le+"x"+pe+")."),Te}else{if("data"in E)console.warn("THREE.WebGLRenderer: Image in DataTexture is too big ("+E.width+"x"+E.height+").");return E}return E}function m(E){return Xa(E.width)&&Xa(E.height)}function p(E){if(o)return!1;return E.wrapS!==1001||E.wrapT!==1001||E.minFilter!==1003&&E.minFilter!==1006}function x(E,y){return E.generateMipmaps&&y&&E.minFilter!==1003&&E.minFilter!==1006}function v(E){e.generateMipmap(E)}function b(E,y,B,ie,Y=!1){if(o===!1)return y;if(E!==null){if(e[E]!==void 0)return e[E];console.warn("THREE.WebGLRenderer: Attempt to use non-existing WebGL internal format '"+E+"'")}let se=y;if(y===e.RED){if(B===e.FLOAT)se=e.R32F;if(B===e.HALF_FLOAT)se=e.R16F;if(B===e.UNSIGNED_BYTE)se=e.R8}if(y===e.RED_INTEGER){if(B===e.UNSIGNED_BYTE)se=e.R8UI;if(B===e.UNSIGNED_SHORT)se=e.R16UI;if(B===e.UNSIGNED_INT)se=e.R32UI;if(B===e.BYTE)se=e.R8I;if(B===e.SHORT)se=e.R16I;if(B===e.INT)se=e.R32I}if(y===e.RG){if(B===e.FLOAT)se=e.RG32F;if(B===e.HALF_FLOAT)se=e.RG16F;if(B===e.UNSIGNED_BYTE)se=e.RG8}if(y===e.RGBA){let Le=Y?"linear":nt.getTransfer(ie);if(B===e.FLOAT)se=e.RGBA32F;if(B===e.HALF_FLOAT)se=e.RGBA16F;if(B===e.UNSIGNED_BYTE)se=Le==="srgb"?e.SRGB8_ALPHA8:e.RGBA8;if(B===e.UNSIGNED_SHORT_4_4_4_4)se=e.RGBA4;if(B===e.UNSIGNED_SHORT_5_5_5_1)se=e.RGB5_A1}if(se===e.R16F||se===e.R32F||se===e.RG16F||se===e.RG32F||se===e.RGBA16F||se===e.RGBA32F)t.get("EXT_color_buffer_float");return se}function R(E,y,B){if(x(E,B)===!0||E.isFramebufferTexture&&E.minFilter!==1003&&E.minFilter!==1006)return Math.log2(Math.max(y.width,y.height))+1;else if(E.mipmaps!==void 0&&E.mipmaps.length>0)return E.mipmaps.length;else if(E.isCompressedTexture&&Array.isArray(E.image))return y.mipmaps.length;else return 1}function M(E){if(E===1003||E===1004||E===1005)return e.NEAREST;return e.LINEAR}function C(E){let y=E.target;if(y.removeEventListener("dispose",C),S(y),y.isVideoTexture)h.delete(y)}function D(E){let y=E.target;y.removeEventListener("dispose",D),U(y)}function S(E){let y=i.get(E);if(y.__webglInit===void 0)return;let B=E.source,ie=d.get(B);if(ie){let Y=ie[y.__cacheKey];if(Y.usedTimes--,Y.usedTimes===0)w(E);if(Object.keys(ie).length===0)d.delete(B)}i.remove(E)}function w(E){let y=i.get(E);e.deleteTexture(y.__webglTexture);let B=E.source,ie=d.get(B);delete ie[y.__cacheKey],a.memory.textures--}function U(E){let y=E.texture,B=i.get(E),ie=i.get(y);if(ie.__webglTexture!==void 0)e.deleteTexture(ie.__webglTexture),a.memory.textures--;if(E.depthTexture)E.depthTexture.dispose();if(E.isWebGLCubeRenderTarget)for(let Y=0;Y<6;Y++){if(Array.isArray(B.__webglFramebuffer[Y]))for(let se=0;se<B.__webglFramebuffer[Y].length;se++)e.deleteFramebuffer(B.__webglFramebuffer[Y][se]);else e.deleteFramebuffer(B.__webglFramebuffer[Y]);if(B.__webglDepthbuffer)e.deleteRenderbuffer(B.__webglDepthbuffer[Y])}else{if(Array.isArray(B.__webglFramebuffer))for(let Y=0;Y<B.__webglFramebuffer.length;Y++)e.deleteFramebuffer(B.__webglFramebuffer[Y]);else e.deleteFramebuffer(B.__webglFramebuffer);if(B.__webglDepthbuffer)e.deleteRenderbuffer(B.__webglDepthbuffer);if(B.__webglMultisampledFramebuffer)e.deleteFramebuffer(B.__webglMultisampledFramebuffer);if(B.__webglColorRenderbuffer){for(let Y=0;Y<B.__webglColorRenderbuffer.length;Y++)if(B.__webglColorRenderbuffer[Y])e.deleteRenderbuffer(B.__webglColorRenderbuffer[Y])}if(B.__webglDepthRenderbuffer)e.deleteRenderbuffer(B.__webglDepthRenderbuffer)}if(E.isWebGLMultipleRenderTargets)for(let Y=0,se=y.length;Y<se;Y++){let Le=i.get(y[Y]);if(Le.__webglTexture)e.deleteTexture(Le.__webglTexture),a.memory.textures--;i.remove(y[Y])}i.remove(y),i.remove(E)}let J=0;function ae(){J=0}function I(){let E=J;if(E>=s.maxTextures)console.warn("THREE.WebGLTextures: Trying to use "+E+" texture units while this GPU supports only "+s.maxTextures);return J+=1,E}function z(E){let y=[];return y.push(E.wrapS),y.push(E.wrapT),y.push(E.wrapR||0),y.push(E.magFilter),y.push(E.minFilter),y.push(E.anisotropy),y.push(E.internalFormat),y.push(E.format),y.push(E.type),y.push(E.generateMipmaps),y.push(E.premultiplyAlpha),y.push(E.flipY),y.push(E.unpackAlignment),y.push(E.colorSpace),y.join()}function X(E,y){let B=i.get(E);if(E.isVideoTexture)Se(E);if(E.isRenderTargetTexture===!1&&E.version>0&&B.__version!==E.version){let ie=E.image;if(ie===null)console.warn("THREE.WebGLRenderer: Texture marked for update but no image data found.");else if(ie.complete===!1)console.warn("THREE.WebGLRenderer: Texture marked for update but image is incomplete");else{ve(B,E,y);return}}n.bindTexture(e.TEXTURE_2D,B.__webglTexture,e.TEXTURE0+y)}function ne(E,y){let B=i.get(E);if(E.version>0&&B.__version!==E.version){ve(B,E,y);return}n.bindTexture(e.TEXTURE_2D_ARRAY,B.__webglTexture,e.TEXTURE0+y)}function V(E,y){let B=i.get(E);if(E.version>0&&B.__version!==E.version){ve(B,E,y);return}n.bindTexture(e.TEXTURE_3D,B.__webglTexture,e.TEXTURE0+y)}function q(E,y){let B=i.get(E);if(E.version>0&&B.__version!==E.version){Ee(B,E,y);return}n.bindTexture(e.TEXTURE_CUBE_MAP,B.__webglTexture,e.TEXTURE0+y)}let ee={[1000]:e.REPEAT,[1001]:e.CLAMP_TO_EDGE,[1002]:e.MIRRORED_REPEAT},oe={[1003]:e.NEAREST,[1004]:e.NEAREST_MIPMAP_NEAREST,[1005]:e.NEAREST_MIPMAP_LINEAR,[1006]:e.LINEAR,[1007]:e.LINEAR_MIPMAP_NEAREST,[1008]:e.LINEAR_MIPMAP_LINEAR},O={[512]:e.NEVER,[519]:e.ALWAYS,[513]:e.LESS,[515]:e.LEQUAL,[514]:e.EQUAL,[518]:e.GEQUAL,[516]:e.GREATER,[517]:e.NOTEQUAL};function te(E,y,B){if(B){if(e.texParameteri(E,e.TEXTURE_WRAP_S,ee[y.wrapS]),e.texParameteri(E,e.TEXTURE_WRAP_T,ee[y.wrapT]),E===e.TEXTURE_3D||E===e.TEXTURE_2D_ARRAY)e.texParameteri(E,e.TEXTURE_WRAP_R,ee[y.wrapR]);e.texParameteri(E,e.TEXTURE_MAG_FILTER,oe[y.magFilter]),e.texParameteri(E,e.TEXTURE_MIN_FILTER,oe[y.minFilter])}else{if(e.texParameteri(E,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(E,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),E===e.TEXTURE_3D||E===e.TEXTURE_2D_ARRAY)e.texParameteri(E,e.TEXTURE_WRAP_R,e.CLAMP_TO_EDGE);if(y.wrapS!==1001||y.wrapT!==1001)console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.wrapS and Texture.wrapT should be set to THREE.ClampToEdgeWrapping.");if(e.texParameteri(E,e.TEXTURE_MAG_FILTER,M(y.magFilter)),e.texParameteri(E,e.TEXTURE_MIN_FILTER,M(y.minFilter)),y.minFilter!==1003&&y.minFilter!==1006)console.warn("THREE.WebGLRenderer: Texture is not power of two. Texture.minFilter should be set to THREE.NearestFilter or THREE.LinearFilter.")}if(y.compareFunction)e.texParameteri(E,e.TEXTURE_COMPARE_MODE,e.COMPARE_REF_TO_TEXTURE),e.texParameteri(E,e.TEXTURE_COMPARE_FUNC,O[y.compareFunction]);if(t.has("EXT_texture_filter_anisotropic")===!0){let ie=t.get("EXT_texture_filter_anisotropic");if(y.magFilter===1003)return;if(y.minFilter!==1005&&y.minFilter!==1008)return;if(y.type===1015&&t.has("OES_texture_float_linear")===!1)return;if(o===!1&&(y.type===1016&&t.has("OES_texture_half_float_linear")===!1))return;if(y.anisotropy>1||i.get(y).__currentAnisotropy)e.texParameterf(E,ie.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(y.anisotropy,s.getMaxAnisotropy())),i.get(y).__currentAnisotropy=y.anisotropy}}function ge(E,y){let B=!1;if(E.__webglInit===void 0)E.__webglInit=!0,y.addEventListener("dispose",C);let ie=y.source,Y=d.get(ie);if(Y===void 0)Y={},d.set(ie,Y);let se=z(y);if(se!==E.__cacheKey){if(Y[se]===void 0)Y[se]={texture:e.createTexture(),usedTimes:0},a.memory.textures++,B=!0;Y[se].usedTimes++;let Le=Y[E.__cacheKey];if(Le!==void 0){if(Y[E.__cacheKey].usedTimes--,Le.usedTimes===0)w(y)}E.__cacheKey=se,E.__webglTexture=Y[se].texture}return B}function ve(E,y,B){let ie=e.TEXTURE_2D;if(y.isDataArrayTexture||y.isCompressedArrayTexture)ie=e.TEXTURE_2D_ARRAY;if(y.isData3DTexture)ie=e.TEXTURE_3D;let Y=ge(E,y),se=y.source;n.bindTexture(ie,E.__webglTexture,e.TEXTURE0+B);let Le=i.get(se);if(se.version!==Le.__version||Y===!0){n.activeTexture(e.TEXTURE0+B);let pe=nt.getPrimaries(nt.workingColorSpace),Te=y.colorSpace===""?null:nt.getPrimaries(y.colorSpace),Re=y.colorSpace===""||pe===Te?e.NONE:e.BROWSER_DEFAULT_WEBGL;e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,y.flipY),e.pixelStorei(e.UNPACK_PREMULTIPLY_ALPHA_WEBGL,y.premultiplyAlpha),e.pixelStorei(e.UNPACK_ALIGNMENT,y.unpackAlignment),e.pixelStorei(e.UNPACK_COLORSPACE_CONVERSION_WEBGL,Re);let Fe=p(y)&&m(y.image)===!1,K=_(y.image,Fe,!1,s.maxTextureSize);K=be(y,K);let L=m(K)||o,re=r.convert(y.format,y.colorSpace),ye=r.convert(y.type),le=b(y.internalFormat,re,ye,y.colorSpace,y.isVideoTexture);te(ie,y,L);let _e,Oe=y.mipmaps,Xe=o&&y.isVideoTexture!==!0&&le!==36196,je=Le.__version===void 0||Y===!0,rt=R(y,K,L);if(y.isDepthTexture){if(le=e.DEPTH_COMPONENT,o)if(y.type===1015)le=e.DEPTH_COMPONENT32F;else if(y.type===1014)le=e.DEPTH_COMPONENT24;else if(y.type===1020)le=e.DEPTH24_STENCIL8;else le=e.DEPTH_COMPONENT16;else if(y.type===1015)console.error("WebGLRenderer: Floating point depth texture requires WebGL2.");if(y.format===1026&&le===e.DEPTH_COMPONENT){if(y.type!==1012&&y.type!==1014)console.warn("THREE.WebGLRenderer: Use UnsignedShortType or UnsignedIntType for DepthFormat DepthTexture."),y.type=1014,ye=r.convert(y.type)}if(y.format===1027&&le===e.DEPTH_COMPONENT){if(le=e.DEPTH_STENCIL,y.type!==1020)console.warn("THREE.WebGLRenderer: Use UnsignedInt248Type for DepthStencilFormat DepthTexture."),y.type=1020,ye=r.convert(y.type)}if(je)if(Xe)n.texStorage2D(e.TEXTURE_2D,1,le,K.width,K.height);else n.texImage2D(e.TEXTURE_2D,0,le,K.width,K.height,0,re,ye,null)}else if(y.isDataTexture)if(Oe.length>0&&L){if(Xe&&je)n.texStorage2D(e.TEXTURE_2D,rt,le,Oe[0].width,Oe[0].height);for(let de=0,N=Oe.length;de<N;de++)if(_e=Oe[de],Xe)n.texSubImage2D(e.TEXTURE_2D,de,0,0,_e.width,_e.height,re,ye,_e.data);else n.texImage2D(e.TEXTURE_2D,de,le,_e.width,_e.height,0,re,ye,_e.data);y.generateMipmaps=!1}else if(Xe){if(je)n.texStorage2D(e.TEXTURE_2D,rt,le,K.width,K.height);n.texSubImage2D(e.TEXTURE_2D,0,0,0,K.width,K.height,re,ye,K.data)}else n.texImage2D(e.TEXTURE_2D,0,le,K.width,K.height,0,re,ye,K.data);else if(y.isCompressedTexture)if(y.isCompressedArrayTexture){if(Xe&&je)n.texStorage3D(e.TEXTURE_2D_ARRAY,rt,le,Oe[0].width,Oe[0].height,K.depth);for(let de=0,N=Oe.length;de<N;de++)if(_e=Oe[de],y.format!==1023)if(re!==null)if(Xe)n.compressedTexSubImage3D(e.TEXTURE_2D_ARRAY,de,0,0,0,_e.width,_e.height,K.depth,re,_e.data,0,0);else n.compressedTexImage3D(e.TEXTURE_2D_ARRAY,de,le,_e.width,_e.height,K.depth,0,_e.data,0,0);else console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else if(Xe)n.texSubImage3D(e.TEXTURE_2D_ARRAY,de,0,0,0,_e.width,_e.height,K.depth,re,ye,_e.data);else n.texImage3D(e.TEXTURE_2D_ARRAY,de,le,_e.width,_e.height,K.depth,0,re,ye,_e.data)}else{if(Xe&&je)n.texStorage2D(e.TEXTURE_2D,rt,le,Oe[0].width,Oe[0].height);for(let de=0,N=Oe.length;de<N;de++)if(_e=Oe[de],y.format!==1023)if(re!==null)if(Xe)n.compressedTexSubImage2D(e.TEXTURE_2D,de,0,0,_e.width,_e.height,re,_e.data);else n.compressedTexImage2D(e.TEXTURE_2D,de,le,_e.width,_e.height,0,_e.data);else console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .uploadTexture()");else if(Xe)n.texSubImage2D(e.TEXTURE_2D,de,0,0,_e.width,_e.height,re,ye,_e.data);else n.texImage2D(e.TEXTURE_2D,de,le,_e.width,_e.height,0,re,ye,_e.data)}else if(y.isDataArrayTexture)if(Xe){if(je)n.texStorage3D(e.TEXTURE_2D_ARRAY,rt,le,K.width,K.height,K.depth);n.texSubImage3D(e.TEXTURE_2D_ARRAY,0,0,0,0,K.width,K.height,K.depth,re,ye,K.data)}else n.texImage3D(e.TEXTURE_2D_ARRAY,0,le,K.width,K.height,K.depth,0,re,ye,K.data);else if(y.isData3DTexture)if(Xe){if(je)n.texStorage3D(e.TEXTURE_3D,rt,le,K.width,K.height,K.depth);n.texSubImage3D(e.TEXTURE_3D,0,0,0,0,K.width,K.height,K.depth,re,ye,K.data)}else n.texImage3D(e.TEXTURE_3D,0,le,K.width,K.height,K.depth,0,re,ye,K.data);else if(y.isFramebufferTexture){if(je)if(Xe)n.texStorage2D(e.TEXTURE_2D,rt,le,K.width,K.height);else{let de=K.width,N=K.height;for(let he=0;he<rt;he++)n.texImage2D(e.TEXTURE_2D,he,le,de,N,0,re,ye,null),de>>=1,N>>=1}}else if(Oe.length>0&&L){if(Xe&&je)n.texStorage2D(e.TEXTURE_2D,rt,le,Oe[0].width,Oe[0].height);for(let de=0,N=Oe.length;de<N;de++)if(_e=Oe[de],Xe)n.texSubImage2D(e.TEXTURE_2D,de,0,0,re,ye,_e);else n.texImage2D(e.TEXTURE_2D,de,le,re,ye,_e);y.generateMipmaps=!1}else if(Xe){if(je)n.texStorage2D(e.TEXTURE_2D,rt,le,K.width,K.height);n.texSubImage2D(e.TEXTURE_2D,0,0,0,re,ye,K)}else n.texImage2D(e.TEXTURE_2D,0,le,re,ye,K);if(x(y,L))v(ie);if(Le.__version=se.version,y.onUpdate)y.onUpdate(y)}E.__version=y.version}function Ee(E,y,B){if(y.image.length!==6)return;let ie=ge(E,y),Y=y.source;n.bindTexture(e.TEXTURE_CUBE_MAP,E.__webglTexture,e.TEXTURE0+B);let se=i.get(Y);if(Y.version!==se.__version||ie===!0){n.activeTexture(e.TEXTURE0+B);let Le=nt.getPrimaries(nt.workingColorSpace),pe=y.colorSpace===""?null:nt.getPrimaries(y.colorSpace),Te=y.colorSpace===""||Le===pe?e.NONE:e.BROWSER_DEFAULT_WEBGL;e.pixelStorei(e.UNPACK_FLIP_Y_WEBGL,y.flipY),e.pixelStorei(e.UNPACK_PREMULTIPLY_ALPHA_WEBGL,y.premultiplyAlpha),e.pixelStorei(e.UNPACK_ALIGNMENT,y.unpackAlignment),e.pixelStorei(e.UNPACK_COLORSPACE_CONVERSION_WEBGL,Te);let Re=y.isCompressedTexture||y.image[0].isCompressedTexture,Fe=y.image[0]&&y.image[0].isDataTexture,K=[];for(let de=0;de<6;de++){if(!Re&&!Fe)K[de]=_(y.image[de],!1,!0,s.maxCubemapSize);else K[de]=Fe?y.image[de].image:y.image[de];K[de]=be(y,K[de])}let L=K[0],re=m(L)||o,ye=r.convert(y.format,y.colorSpace),le=r.convert(y.type),_e=b(y.internalFormat,ye,le,y.colorSpace),Oe=o&&y.isVideoTexture!==!0,Xe=se.__version===void 0||ie===!0,je=R(y,L,re);te(e.TEXTURE_CUBE_MAP,y,re);let rt;if(Re){if(Oe&&Xe)n.texStorage2D(e.TEXTURE_CUBE_MAP,je,_e,L.width,L.height);for(let de=0;de<6;de++){rt=K[de].mipmaps;for(let N=0;N<rt.length;N++){let he=rt[N];if(y.format!==1023)if(ye!==null)if(Oe)n.compressedTexSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N,0,0,he.width,he.height,ye,he.data);else n.compressedTexImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N,_e,he.width,he.height,0,he.data);else console.warn("THREE.WebGLRenderer: Attempt to load unsupported compressed texture format in .setTextureCube()");else if(Oe)n.texSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N,0,0,he.width,he.height,ye,le,he.data);else n.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N,_e,he.width,he.height,0,ye,le,he.data)}}}else{if(rt=y.mipmaps,Oe&&Xe){if(rt.length>0)je++;n.texStorage2D(e.TEXTURE_CUBE_MAP,je,_e,K[0].width,K[0].height)}for(let de=0;de<6;de++)if(Fe){if(Oe)n.texSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,0,0,0,K[de].width,K[de].height,ye,le,K[de].data);else n.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,0,_e,K[de].width,K[de].height,0,ye,le,K[de].data);for(let N=0;N<rt.length;N++){let me=rt[N].image[de].image;if(Oe)n.texSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N+1,0,0,me.width,me.height,ye,le,me.data);else n.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N+1,_e,me.width,me.height,0,ye,le,me.data)}}else{if(Oe)n.texSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,0,0,0,ye,le,K[de]);else n.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,0,_e,ye,le,K[de]);for(let N=0;N<rt.length;N++){let he=rt[N];if(Oe)n.texSubImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N+1,0,0,ye,le,he.image[de]);else n.texImage2D(e.TEXTURE_CUBE_MAP_POSITIVE_X+de,N+1,_e,ye,le,he.image[de])}}}if(x(y,re))v(e.TEXTURE_CUBE_MAP);if(se.__version=Y.version,y.onUpdate)y.onUpdate(y)}E.__version=y.version}function Ie(E,y,B,ie,Y,se){let Le=r.convert(B.format,B.colorSpace),pe=r.convert(B.type),Te=b(B.internalFormat,Le,pe,B.colorSpace);if(!i.get(y).__hasExternalTextures){let Fe=Math.max(1,y.width>>se),K=Math.max(1,y.height>>se);if(Y===e.TEXTURE_3D||Y===e.TEXTURE_2D_ARRAY)n.texImage3D(Y,se,Te,Fe,K,y.depth,0,Le,pe,null);else n.texImage2D(Y,se,Te,Fe,K,0,Le,pe,null)}if(n.bindFramebuffer(e.FRAMEBUFFER,E),xe(y))l.framebufferTexture2DMultisampleEXT(e.FRAMEBUFFER,ie,Y,i.get(B).__webglTexture,0,Z(y));else if(Y===e.TEXTURE_2D||Y>=e.TEXTURE_CUBE_MAP_POSITIVE_X&&Y<=e.TEXTURE_CUBE_MAP_NEGATIVE_Z)e.framebufferTexture2D(e.FRAMEBUFFER,ie,Y,i.get(B).__webglTexture,se);n.bindFramebuffer(e.FRAMEBUFFER,null)}function ke(E,y,B){if(e.bindRenderbuffer(e.RENDERBUFFER,E),y.depthBuffer&&!y.stencilBuffer){let ie=o===!0?e.DEPTH_COMPONENT24:e.DEPTH_COMPONENT16;if(B||xe(y)){let Y=y.depthTexture;if(Y&&Y.isDepthTexture){if(Y.type===1015)ie=e.DEPTH_COMPONENT32F;else if(Y.type===1014)ie=e.DEPTH_COMPONENT24}let se=Z(y);if(xe(y))l.renderbufferStorageMultisampleEXT(e.RENDERBUFFER,se,ie,y.width,y.height);else e.renderbufferStorageMultisample(e.RENDERBUFFER,se,ie,y.width,y.height)}else e.renderbufferStorage(e.RENDERBUFFER,ie,y.width,y.height);e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,E)}else if(y.depthBuffer&&y.stencilBuffer){let ie=Z(y);if(B&&xe(y)===!1)e.renderbufferStorageMultisample(e.RENDERBUFFER,ie,e.DEPTH24_STENCIL8,y.width,y.height);else if(xe(y))l.renderbufferStorageMultisampleEXT(e.RENDERBUFFER,ie,e.DEPTH24_STENCIL8,y.width,y.height);else e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_STENCIL,y.width,y.height);e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.RENDERBUFFER,E)}else{let ie=y.isWebGLMultipleRenderTargets===!0?y.texture:[y.texture];for(let Y=0;Y<ie.length;Y++){let se=ie[Y],Le=r.convert(se.format,se.colorSpace),pe=r.convert(se.type),Te=b(se.internalFormat,Le,pe,se.colorSpace),Re=Z(y);if(B&&xe(y)===!1)e.renderbufferStorageMultisample(e.RENDERBUFFER,Re,Te,y.width,y.height);else if(xe(y))l.renderbufferStorageMultisampleEXT(e.RENDERBUFFER,Re,Te,y.width,y.height);else e.renderbufferStorage(e.RENDERBUFFER,Te,y.width,y.height)}}e.bindRenderbuffer(e.RENDERBUFFER,null)}function we(E,y){if(y&&y.isWebGLCubeRenderTarget)throw Error("Depth Texture with cube render targets is not supported");if(n.bindFramebuffer(e.FRAMEBUFFER,E),!(y.depthTexture&&y.depthTexture.isDepthTexture))throw Error("renderTarget.depthTexture must be an instance of THREE.DepthTexture");if(!i.get(y.depthTexture).__webglTexture||y.depthTexture.image.width!==y.width||y.depthTexture.image.height!==y.height)y.depthTexture.image.width=y.width,y.depthTexture.image.height=y.height,y.depthTexture.needsUpdate=!0;X(y.depthTexture,0);let ie=i.get(y.depthTexture).__webglTexture,Y=Z(y);if(y.depthTexture.format===1026)if(xe(y))l.framebufferTexture2DMultisampleEXT(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.TEXTURE_2D,ie,0,Y);else e.framebufferTexture2D(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.TEXTURE_2D,ie,0);else if(y.depthTexture.format===1027)if(xe(y))l.framebufferTexture2DMultisampleEXT(e.FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.TEXTURE_2D,ie,0,Y);else e.framebufferTexture2D(e.FRAMEBUFFER,e.DEPTH_STENCIL_ATTACHMENT,e.TEXTURE_2D,ie,0);else throw Error("Unknown depthTexture format")}function Ge(E){let y=i.get(E),B=E.isWebGLCubeRenderTarget===!0;if(E.depthTexture&&!y.__autoAllocateDepthBuffer){if(B)throw Error("target.depthTexture not supported in Cube render targets");we(y.__webglFramebuffer,E)}else if(B){y.__webglDepthbuffer=[];for(let ie=0;ie<6;ie++)n.bindFramebuffer(e.FRAMEBUFFER,y.__webglFramebuffer[ie]),y.__webglDepthbuffer[ie]=e.createRenderbuffer(),ke(y.__webglDepthbuffer[ie],E,!1)}else n.bindFramebuffer(e.FRAMEBUFFER,y.__webglFramebuffer),y.__webglDepthbuffer=e.createRenderbuffer(),ke(y.__webglDepthbuffer,E,!1);n.bindFramebuffer(e.FRAMEBUFFER,null)}function P(E,y,B){let ie=i.get(E);if(y!==void 0)Ie(ie.__webglFramebuffer,E,E.texture,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,0);if(B!==void 0)Ge(E)}function ce(E){let y=E.texture,B=i.get(E),ie=i.get(y);if(E.addEventListener("dispose",D),E.isWebGLMultipleRenderTargets!==!0){if(ie.__webglTexture===void 0)ie.__webglTexture=e.createTexture();ie.__version=y.version,a.memory.textures++}let Y=E.isWebGLCubeRenderTarget===!0,se=E.isWebGLMultipleRenderTargets===!0,Le=m(E)||o;if(Y){B.__webglFramebuffer=[];for(let pe=0;pe<6;pe++)if(o&&y.mipmaps&&y.mipmaps.length>0){B.__webglFramebuffer[pe]=[];for(let Te=0;Te<y.mipmaps.length;Te++)B.__webglFramebuffer[pe][Te]=e.createFramebuffer()}else B.__webglFramebuffer[pe]=e.createFramebuffer()}else{if(o&&y.mipmaps&&y.mipmaps.length>0){B.__webglFramebuffer=[];for(let pe=0;pe<y.mipmaps.length;pe++)B.__webglFramebuffer[pe]=e.createFramebuffer()}else B.__webglFramebuffer=e.createFramebuffer();if(se)if(s.drawBuffers){let pe=E.texture;for(let Te=0,Re=pe.length;Te<Re;Te++){let Fe=i.get(pe[Te]);if(Fe.__webglTexture===void 0)Fe.__webglTexture=e.createTexture(),a.memory.textures++}}else console.warn("THREE.WebGLRenderer: WebGLMultipleRenderTargets can only be used with WebGL2 or WEBGL_draw_buffers extension.");if(o&&E.samples>0&&xe(E)===!1){let pe=se?y:[y];B.__webglMultisampledFramebuffer=e.createFramebuffer(),B.__webglColorRenderbuffer=[],n.bindFramebuffer(e.FRAMEBUFFER,B.__webglMultisampledFramebuffer);for(let Te=0;Te<pe.length;Te++){let Re=pe[Te];B.__webglColorRenderbuffer[Te]=e.createRenderbuffer(),e.bindRenderbuffer(e.RENDERBUFFER,B.__webglColorRenderbuffer[Te]);let Fe=r.convert(Re.format,Re.colorSpace),K=r.convert(Re.type),L=b(Re.internalFormat,Fe,K,Re.colorSpace,E.isXRRenderTarget===!0),re=Z(E);e.renderbufferStorageMultisample(e.RENDERBUFFER,re,L,E.width,E.height),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0+Te,e.RENDERBUFFER,B.__webglColorRenderbuffer[Te])}if(e.bindRenderbuffer(e.RENDERBUFFER,null),E.depthBuffer)B.__webglDepthRenderbuffer=e.createRenderbuffer(),ke(B.__webglDepthRenderbuffer,E,!0);n.bindFramebuffer(e.FRAMEBUFFER,null)}}if(Y){n.bindTexture(e.TEXTURE_CUBE_MAP,ie.__webglTexture),te(e.TEXTURE_CUBE_MAP,y,Le);for(let pe=0;pe<6;pe++)if(o&&y.mipmaps&&y.mipmaps.length>0)for(let Te=0;Te<y.mipmaps.length;Te++)Ie(B.__webglFramebuffer[pe][Te],E,y,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X+pe,Te);else Ie(B.__webglFramebuffer[pe],E,y,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X+pe,0);if(x(y,Le))v(e.TEXTURE_CUBE_MAP);n.unbindTexture()}else if(se){let pe=E.texture;for(let Te=0,Re=pe.length;Te<Re;Te++){let Fe=pe[Te],K=i.get(Fe);if(n.bindTexture(e.TEXTURE_2D,K.__webglTexture),te(e.TEXTURE_2D,Fe,Le),Ie(B.__webglFramebuffer,E,Fe,e.COLOR_ATTACHMENT0+Te,e.TEXTURE_2D,0),x(Fe,Le))v(e.TEXTURE_2D)}n.unbindTexture()}else{let pe=e.TEXTURE_2D;if(E.isWebGL3DRenderTarget||E.isWebGLArrayRenderTarget)if(o)pe=E.isWebGL3DRenderTarget?e.TEXTURE_3D:e.TEXTURE_2D_ARRAY;else console.error("THREE.WebGLTextures: THREE.Data3DTexture and THREE.DataArrayTexture only supported with WebGL2.");if(n.bindTexture(pe,ie.__webglTexture),te(pe,y,Le),o&&y.mipmaps&&y.mipmaps.length>0)for(let Te=0;Te<y.mipmaps.length;Te++)Ie(B.__webglFramebuffer[Te],E,y,e.COLOR_ATTACHMENT0,pe,Te);else Ie(B.__webglFramebuffer,E,y,e.COLOR_ATTACHMENT0,pe,0);if(x(y,Le))v(pe);n.unbindTexture()}if(E.depthBuffer)Ge(E)}function j(E){let y=m(E)||o,B=E.isWebGLMultipleRenderTargets===!0?E.texture:[E.texture];for(let ie=0,Y=B.length;ie<Y;ie++){let se=B[ie];if(x(se,y)){let Le=E.isWebGLCubeRenderTarget?e.TEXTURE_CUBE_MAP:e.TEXTURE_2D,pe=i.get(se).__webglTexture;n.bindTexture(Le,pe),v(Le),n.unbindTexture()}}}function Q(E){if(o&&E.samples>0&&xe(E)===!1){let y=E.isWebGLMultipleRenderTargets?E.texture:[E.texture],{width:B,height:ie}=E,Y=e.COLOR_BUFFER_BIT,se=[],Le=E.stencilBuffer?e.DEPTH_STENCIL_ATTACHMENT:e.DEPTH_ATTACHMENT,pe=i.get(E),Te=E.isWebGLMultipleRenderTargets===!0;if(Te)for(let Re=0;Re<y.length;Re++)n.bindFramebuffer(e.FRAMEBUFFER,pe.__webglMultisampledFramebuffer),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0+Re,e.RENDERBUFFER,null),n.bindFramebuffer(e.FRAMEBUFFER,pe.__webglFramebuffer),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0+Re,e.TEXTURE_2D,null,0);n.bindFramebuffer(e.READ_FRAMEBUFFER,pe.__webglMultisampledFramebuffer),n.bindFramebuffer(e.DRAW_FRAMEBUFFER,pe.__webglFramebuffer);for(let Re=0;Re<y.length;Re++){if(se.push(e.COLOR_ATTACHMENT0+Re),E.depthBuffer)se.push(Le);let Fe=pe.__ignoreDepthValues!==void 0?pe.__ignoreDepthValues:!1;if(Fe===!1){if(E.depthBuffer)Y|=e.DEPTH_BUFFER_BIT;if(E.stencilBuffer)Y|=e.STENCIL_BUFFER_BIT}if(Te)e.framebufferRenderbuffer(e.READ_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.RENDERBUFFER,pe.__webglColorRenderbuffer[Re]);if(Fe===!0)e.invalidateFramebuffer(e.READ_FRAMEBUFFER,[Le]),e.invalidateFramebuffer(e.DRAW_FRAMEBUFFER,[Le]);if(Te){let K=i.get(y[Re]).__webglTexture;e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,K,0)}if(e.blitFramebuffer(0,0,B,ie,0,0,B,ie,Y,e.NEAREST),c)e.invalidateFramebuffer(e.READ_FRAMEBUFFER,se)}if(n.bindFramebuffer(e.READ_FRAMEBUFFER,null),n.bindFramebuffer(e.DRAW_FRAMEBUFFER,null),Te)for(let Re=0;Re<y.length;Re++){n.bindFramebuffer(e.FRAMEBUFFER,pe.__webglMultisampledFramebuffer),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0+Re,e.RENDERBUFFER,pe.__webglColorRenderbuffer[Re]);let Fe=i.get(y[Re]).__webglTexture;n.bindFramebuffer(e.FRAMEBUFFER,pe.__webglFramebuffer),e.framebufferTexture2D(e.DRAW_FRAMEBUFFER,e.COLOR_ATTACHMENT0+Re,e.TEXTURE_2D,Fe,0)}n.bindFramebuffer(e.DRAW_FRAMEBUFFER,pe.__webglMultisampledFramebuffer)}}function Z(E){return Math.min(s.maxSamples,E.samples)}function xe(E){let y=i.get(E);return o&&E.samples>0&&t.has("WEBGL_multisampled_render_to_texture")===!0&&y.__useRenderToTexture!==!1}function Se(E){let y=a.render.frame;if(h.get(E)!==y)h.set(E,y),E.update()}function be(E,y){let{colorSpace:B,format:ie,type:Y}=E;if(E.isCompressedTexture===!0||E.isVideoTexture===!0||E.format===1035)return y;if(B!=="srgb-linear"&&B!=="")if(nt.getTransfer(B)==="srgb"){if(o===!1)if(t.has("EXT_sRGB")===!0&&ie===1023)E.format=1035,E.minFilter=1006,E.generateMipmaps=!1;else y=io.sRGBToLinear(y);else if(ie!==1023||Y!==1009)console.warn("THREE.WebGLTextures: sRGB encoded textures have to use RGBAFormat and UnsignedByteType.")}else console.error("THREE.WebGLTextures: Unsupported texture color space:",B);return y}this.allocateTextureUnit=I,this.resetTextureUnits=ae,this.setTexture2D=X,this.setTexture2DArray=ne,this.setTexture3D=V,this.setTextureCube=q,this.rebindTextures=P,this.setupRenderTarget=ce,this.updateRenderTargetMipmap=j,this.updateMultisampleRenderTarget=Q,this.setupDepthRenderbuffer=Ge,this.setupFrameBufferTexture=Ie,this.useMultisampledRTT=xe}function p_(e,t,n){let i=n.isWebGL2;function s(r,a=""){let o,l=nt.getTransfer(a);if(r===1009)return e.UNSIGNED_BYTE;if(r===1017)return e.UNSIGNED_SHORT_4_4_4_4;if(r===1018)return e.UNSIGNED_SHORT_5_5_5_1;if(r===1010)return e.BYTE;if(r===1011)return e.SHORT;if(r===1012)return e.UNSIGNED_SHORT;if(r===1013)return e.INT;if(r===1014)return e.UNSIGNED_INT;if(r===1015)return e.FLOAT;if(r===1016){if(i)return e.HALF_FLOAT;if(o=t.get("OES_texture_half_float"),o!==null)return o.HALF_FLOAT_OES;else return null}if(r===1021)return e.ALPHA;if(r===1023)return e.RGBA;if(r===1024)return e.LUMINANCE;if(r===1025)return e.LUMINANCE_ALPHA;if(r===1026)return e.DEPTH_COMPONENT;if(r===1027)return e.DEPTH_STENCIL;if(r===1035)if(o=t.get("EXT_sRGB"),o!==null)return o.SRGB_ALPHA_EXT;else return null;if(r===1028)return e.RED;if(r===1029)return e.RED_INTEGER;if(r===1030)return e.RG;if(r===1031)return e.RG_INTEGER;if(r===1033)return e.RGBA_INTEGER;if(r===33776||r===33777||r===33778||r===33779)if(l==="srgb")if(o=t.get("WEBGL_compressed_texture_s3tc_srgb"),o!==null){if(r===33776)return o.COMPRESSED_SRGB_S3TC_DXT1_EXT;if(r===33777)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT;if(r===33778)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT;if(r===33779)return o.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT}else return null;else if(o=t.get("WEBGL_compressed_texture_s3tc"),o!==null){if(r===33776)return o.COMPRESSED_RGB_S3TC_DXT1_EXT;if(r===33777)return o.COMPRESSED_RGBA_S3TC_DXT1_EXT;if(r===33778)return o.COMPRESSED_RGBA_S3TC_DXT3_EXT;if(r===33779)return o.COMPRESSED_RGBA_S3TC_DXT5_EXT}else return null;if(r===35840||r===35841||r===35842||r===35843)if(o=t.get("WEBGL_compressed_texture_pvrtc"),o!==null){if(r===35840)return o.COMPRESSED_RGB_PVRTC_4BPPV1_IMG;if(r===35841)return o.COMPRESSED_RGB_PVRTC_2BPPV1_IMG;if(r===35842)return o.COMPRESSED_RGBA_PVRTC_4BPPV1_IMG;if(r===35843)return o.COMPRESSED_RGBA_PVRTC_2BPPV1_IMG}else return null;if(r===36196)if(o=t.get("WEBGL_compressed_texture_etc1"),o!==null)return o.COMPRESSED_RGB_ETC1_WEBGL;else return null;if(r===37492||r===37496)if(o=t.get("WEBGL_compressed_texture_etc"),o!==null){if(r===37492)return l==="srgb"?o.COMPRESSED_SRGB8_ETC2:o.COMPRESSED_RGB8_ETC2;if(r===37496)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ETC2_EAC:o.COMPRESSED_RGBA8_ETC2_EAC}else return null;if(r===37808||r===37809||r===37810||r===37811||r===37812||r===37813||r===37814||r===37815||r===37816||r===37817||r===37818||r===37819||r===37820||r===37821)if(o=t.get("WEBGL_compressed_texture_astc"),o!==null){if(r===37808)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR:o.COMPRESSED_RGBA_ASTC_4x4_KHR;if(r===37809)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_5x4_KHR:o.COMPRESSED_RGBA_ASTC_5x4_KHR;if(r===37810)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_5x5_KHR:o.COMPRESSED_RGBA_ASTC_5x5_KHR;if(r===37811)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_6x5_KHR:o.COMPRESSED_RGBA_ASTC_6x5_KHR;if(r===37812)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_6x6_KHR:o.COMPRESSED_RGBA_ASTC_6x6_KHR;if(r===37813)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x5_KHR:o.COMPRESSED_RGBA_ASTC_8x5_KHR;if(r===37814)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x6_KHR:o.COMPRESSED_RGBA_ASTC_8x6_KHR;if(r===37815)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_8x8_KHR:o.COMPRESSED_RGBA_ASTC_8x8_KHR;if(r===37816)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x5_KHR:o.COMPRESSED_RGBA_ASTC_10x5_KHR;if(r===37817)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x6_KHR:o.COMPRESSED_RGBA_ASTC_10x6_KHR;if(r===37818)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x8_KHR:o.COMPRESSED_RGBA_ASTC_10x8_KHR;if(r===37819)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_10x10_KHR:o.COMPRESSED_RGBA_ASTC_10x10_KHR;if(r===37820)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_12x10_KHR:o.COMPRESSED_RGBA_ASTC_12x10_KHR;if(r===37821)return l==="srgb"?o.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR:o.COMPRESSED_RGBA_ASTC_12x12_KHR}else return null;if(r===36492||r===36494||r===36495)if(o=t.get("EXT_texture_compression_bptc"),o!==null){if(r===36492)return l==="srgb"?o.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT:o.COMPRESSED_RGBA_BPTC_UNORM_EXT;if(r===36494)return o.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT;if(r===36495)return o.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT}else return null;if(r===36283||r===36284||r===36285||r===36286)if(o=t.get("EXT_texture_compression_rgtc"),o!==null){if(r===36492)return o.COMPRESSED_RED_RGTC1_EXT;if(r===36284)return o.COMPRESSED_SIGNED_RED_RGTC1_EXT;if(r===36285)return o.COMPRESSED_RED_GREEN_RGTC2_EXT;if(r===36286)return o.COMPRESSED_SIGNED_RED_GREEN_RGTC2_EXT}else return null;if(r===1020){if(i)return e.UNSIGNED_INT_24_8;if(o=t.get("WEBGL_depth_texture"),o!==null)return o.UNSIGNED_INT_24_8_WEBGL;else return null}return e[r]!==void 0?e[r]:null}return{convert:s}}class mh extends yt{constructor(e=[]){super();this.isArrayCamera=!0,this.cameras=e}}class hn extends et{constructor(){super();this.isGroup=!0,this.type="Group"}}var m_={type:"move"};class wr{constructor(){this._targetRay=null,this._grip=null,this._hand=null}getHandSpace(){if(this._hand===null)this._hand=new hn,this._hand.matrixAutoUpdate=!1,this._hand.visible=!1,this._hand.joints={},this._hand.inputState={pinching:!1};return this._hand}getTargetRaySpace(){if(this._targetRay===null)this._targetRay=new hn,this._targetRay.matrixAutoUpdate=!1,this._targetRay.visible=!1,this._targetRay.hasLinearVelocity=!1,this._targetRay.linearVelocity=new T,this._targetRay.hasAngularVelocity=!1,this._targetRay.angularVelocity=new T;return this._targetRay}getGripSpace(){if(this._grip===null)this._grip=new hn,this._grip.matrixAutoUpdate=!1,this._grip.visible=!1,this._grip.hasLinearVelocity=!1,this._grip.linearVelocity=new T,this._grip.hasAngularVelocity=!1,this._grip.angularVelocity=new T;return this._grip}dispatchEvent(e){if(this._targetRay!==null)this._targetRay.dispatchEvent(e);if(this._grip!==null)this._grip.dispatchEvent(e);if(this._hand!==null)this._hand.dispatchEvent(e);return this}connect(e){if(e&&e.hand){let t=this._hand;if(t)for(let n of e.hand.values())this._getHandJoint(t,n)}return this.dispatchEvent({type:"connected",data:e}),this}disconnect(e){if(this.dispatchEvent({type:"disconnected",data:e}),this._targetRay!==null)this._targetRay.visible=!1;if(this._grip!==null)this._grip.visible=!1;if(this._hand!==null)this._hand.visible=!1;return this}update(e,t,n){let i=null,s=null,r=null,a=this._targetRay,o=this._grip,l=this._hand;if(e&&t.session.visibilityState!=="visible-blurred"){if(l&&e.hand){r=!0;for(let g of e.hand.values()){let _=t.getJointPose(g,n),m=this._getHandJoint(l,g);if(_!==null)m.matrix.fromArray(_.transform.matrix),m.matrix.decompose(m.position,m.rotation,m.scale),m.matrixWorldNeedsUpdate=!0,m.jointRadius=_.radius;m.visible=_!==null}let c=l.joints["index-finger-tip"],h=l.joints["thumb-tip"],u=c.position.distanceTo(h.position),d=0.02,f=0.005;if(l.inputState.pinching&&u>d+f)l.inputState.pinching=!1,this.dispatchEvent({type:"pinchend",handedness:e.handedness,target:this});else if(!l.inputState.pinching&&u<=d-f)l.inputState.pinching=!0,this.dispatchEvent({type:"pinchstart",handedness:e.handedness,target:this})}else if(o!==null&&e.gripSpace){if(s=t.getPose(e.gripSpace,n),s!==null){if(o.matrix.fromArray(s.transform.matrix),o.matrix.decompose(o.position,o.rotation,o.scale),o.matrixWorldNeedsUpdate=!0,s.linearVelocity)o.hasLinearVelocity=!0,o.linearVelocity.copy(s.linearVelocity);else o.hasLinearVelocity=!1;if(s.angularVelocity)o.hasAngularVelocity=!0,o.angularVelocity.copy(s.angularVelocity);else o.hasAngularVelocity=!1}}if(a!==null){if(i=t.getPose(e.targetRaySpace,n),i===null&&s!==null)i=s;if(i!==null){if(a.matrix.fromArray(i.transform.matrix),a.matrix.decompose(a.position,a.rotation,a.scale),a.matrixWorldNeedsUpdate=!0,i.linearVelocity)a.hasLinearVelocity=!0,a.linearVelocity.copy(i.linearVelocity);else a.hasLinearVelocity=!1;if(i.angularVelocity)a.hasAngularVelocity=!0,a.angularVelocity.copy(i.angularVelocity);else a.hasAngularVelocity=!1;this.dispatchEvent(m_)}}}if(a!==null)a.visible=i!==null;if(o!==null)o.visible=s!==null;if(l!==null)l.visible=r!==null;return this}_getHandJoint(e,t){if(e.joints[t.jointName]===void 0){let n=new hn;n.matrixAutoUpdate=!1,n.visible=!1,e.joints[t.jointName]=n,e.add(n)}return e.joints[t.jointName]}}class gh extends nn{constructor(e,t){super();let n=this,i=null,s=1,r=null,a="local-floor",o=1,l=null,c=null,h=null,u=null,d=null,f=null,g=t.getContextAttributes(),_=null,m=null,p=[],x=[],v=new W,b=null,R=new yt;R.layers.enable(1),R.viewport=new at;let M=new yt;M.layers.enable(2),M.viewport=new at;let C=[R,M],D=new mh;D.layers.enable(1),D.layers.enable(2);let S=null,w=null;this.cameraAutoUpdate=!0,this.enabled=!1,this.isPresenting=!1,this.getController=function(O){let te=p[O];if(te===void 0)te=new wr,p[O]=te;return te.getTargetRaySpace()},this.getControllerGrip=function(O){let te=p[O];if(te===void 0)te=new wr,p[O]=te;return te.getGripSpace()},this.getHand=function(O){let te=p[O];if(te===void 0)te=new wr,p[O]=te;return te.getHandSpace()};function U(O){let te=x.indexOf(O.inputSource);if(te===-1)return;let ge=p[te];if(ge!==void 0)ge.update(O.inputSource,O.frame,l||r),ge.dispatchEvent({type:O.type,data:O.inputSource})}function J(){i.removeEventListener("select",U),i.removeEventListener("selectstart",U),i.removeEventListener("selectend",U),i.removeEventListener("squeeze",U),i.removeEventListener("squeezestart",U),i.removeEventListener("squeezeend",U),i.removeEventListener("end",J),i.removeEventListener("inputsourceschange",ae);for(let O=0;O<p.length;O++){let te=x[O];if(te===null)continue;x[O]=null,p[O].disconnect(te)}S=null,w=null,e.setRenderTarget(_),d=null,u=null,h=null,i=null,m=null,oe.stop(),n.isPresenting=!1,e.setPixelRatio(b),e.setSize(v.width,v.height,!1),n.dispatchEvent({type:"sessionend"})}this.setFramebufferScaleFactor=function(O){if(s=O,n.isPresenting===!0)console.warn("THREE.WebXRManager: Cannot change framebuffer scale while presenting.")},this.setReferenceSpaceType=function(O){if(a=O,n.isPresenting===!0)console.warn("THREE.WebXRManager: Cannot change reference space type while presenting.")},this.getReferenceSpace=function(){return l||r},this.setReferenceSpace=function(O){l=O},this.getBaseLayer=function(){return u!==null?u:d},this.getBinding=function(){return h},this.getFrame=function(){return f},this.getSession=function(){return i},this.setSession=async function(O){if(i=O,i!==null){if(_=e.getRenderTarget(),i.addEventListener("select",U),i.addEventListener("selectstart",U),i.addEventListener("selectend",U),i.addEventListener("squeeze",U),i.addEventListener("squeezestart",U),i.addEventListener("squeezeend",U),i.addEventListener("end",J),i.addEventListener("inputsourceschange",ae),g.xrCompatible!==!0)await t.makeXRCompatible();if(b=e.getPixelRatio(),e.getSize(v),i.renderState.layers===void 0||e.capabilities.isWebGL2===!1){let te={antialias:i.renderState.layers===void 0?g.antialias:!0,alpha:!0,depth:g.depth,stencil:g.stencil,framebufferScaleFactor:s};d=new XRWebGLLayer(i,t,te),i.updateRenderState({baseLayer:d}),e.setPixelRatio(1),e.setSize(d.framebufferWidth,d.framebufferHeight,!1),m=new Ct(d.framebufferWidth,d.framebufferHeight,{format:1023,type:1009,colorSpace:e.outputColorSpace,stencilBuffer:g.stencil})}else{let te=null,ge=null,ve=null;if(g.depth)ve=g.stencil?t.DEPTH24_STENCIL8:t.DEPTH_COMPONENT24,te=g.stencil?1027:1026,ge=g.stencil?1020:1014;let Ee={colorFormat:t.RGBA8,depthFormat:ve,scaleFactor:s};h=new XRWebGLBinding(i,t),u=h.createProjectionLayer(Ee),i.updateRenderState({layers:[u]}),e.setPixelRatio(1),e.setSize(u.textureWidth,u.textureHeight,!1),m=new Ct(u.textureWidth,u.textureHeight,{format:1023,type:1009,depthTexture:new lo(u.textureWidth,u.textureHeight,ge,void 0,void 0,void 0,void 0,void 0,void 0,te),stencilBuffer:g.stencil,colorSpace:e.outputColorSpace,samples:g.antialias?4:0});let Ie=e.properties.get(m);Ie.__ignoreDepthValues=u.ignoreDepthValues}m.isXRRenderTarget=!0,this.setFoveation(o),l=null,r=await i.requestReferenceSpace(a),oe.setContext(i),oe.start(),n.isPresenting=!0,n.dispatchEvent({type:"sessionstart"})}},this.getEnvironmentBlendMode=function(){if(i!==null)return i.environmentBlendMode};function ae(O){for(let te=0;te<O.removed.length;te++){let ge=O.removed[te],ve=x.indexOf(ge);if(ve>=0)x[ve]=null,p[ve].disconnect(ge)}for(let te=0;te<O.added.length;te++){let ge=O.added[te],ve=x.indexOf(ge);if(ve===-1){for(let Ie=0;Ie<p.length;Ie++)if(Ie>=x.length){x.push(ge),ve=Ie;break}else if(x[Ie]===null){x[Ie]=ge,ve=Ie;break}if(ve===-1)break}let Ee=p[ve];if(Ee)Ee.connect(ge)}}let I=new T,z=new T;function X(O,te,ge){I.setFromMatrixPosition(te.matrixWorld),z.setFromMatrixPosition(ge.matrixWorld);let ve=I.distanceTo(z),Ee=te.projectionMatrix.elements,Ie=ge.projectionMatrix.elements,ke=Ee[14]/(Ee[10]-1),we=Ee[14]/(Ee[10]+1),Ge=(Ee[9]+1)/Ee[5],P=(Ee[9]-1)/Ee[5],ce=(Ee[8]-1)/Ee[0],j=(Ie[8]+1)/Ie[0],Q=ke*ce,Z=ke*j,xe=ve/(-ce+j),Se=xe*-ce;te.matrixWorld.decompose(O.position,O.quaternion,O.scale),O.translateX(Se),O.translateZ(xe),O.matrixWorld.compose(O.position,O.quaternion,O.scale),O.matrixWorldInverse.copy(O.matrixWorld).invert();let be=ke+xe,E=we+xe,y=Q-Se,B=Z+(ve-Se),ie=Ge*we/E*be,Y=P*we/E*be;O.projectionMatrix.makePerspective(y,B,ie,Y,be,E),O.projectionMatrixInverse.copy(O.projectionMatrix).invert()}function ne(O,te){if(te===null)O.matrixWorld.copy(O.matrix);else O.matrixWorld.multiplyMatrices(te.matrixWorld,O.matrix);O.matrixWorldInverse.copy(O.matrixWorld).invert()}this.updateCamera=function(O){if(i===null)return;if(D.near=M.near=R.near=O.near,D.far=M.far=R.far=O.far,S!==D.near||w!==D.far)i.updateRenderState({depthNear:D.near,depthFar:D.far}),S=D.near,w=D.far;let te=O.parent,ge=D.cameras;ne(D,te);for(let ve=0;ve<ge.length;ve++)ne(ge[ve],te);if(ge.length===2)X(D,R,M);else D.projectionMatrix.copy(R.projectionMatrix);V(O,D,te)};function V(O,te,ge){if(ge===null)O.matrix.copy(te.matrixWorld);else O.matrix.copy(ge.matrixWorld),O.matrix.invert(),O.matrix.multiply(te.matrixWorld);if(O.matrix.decompose(O.position,O.quaternion,O.scale),O.updateMatrixWorld(!0),O.projectionMatrix.copy(te.projectionMatrix),O.projectionMatrixInverse.copy(te.projectionMatrixInverse),O.isPerspectiveCamera)O.fov=qi*2*Math.atan(1/O.projectionMatrix.elements[5]),O.zoom=1}this.getCamera=function(){return D},this.getFoveation=function(){if(u===null&&d===null)return;return o},this.setFoveation=function(O){if(o=O,u!==null)u.fixedFoveation=O;if(d!==null&&d.fixedFoveation!==void 0)d.fixedFoveation=O};let q=null;function ee(O,te){if(c=te.getViewerPose(l||r),f=te,c!==null){let ge=c.views;if(d!==null)e.setRenderTargetFramebuffer(m,d.framebuffer),e.setRenderTarget(m);let ve=!1;if(ge.length!==D.cameras.length)D.cameras.length=0,ve=!0;for(let Ee=0;Ee<ge.length;Ee++){let Ie=ge[Ee],ke=null;if(d!==null)ke=d.getViewport(Ie);else{let Ge=h.getViewSubImage(u,Ie);if(ke=Ge.viewport,Ee===0)e.setRenderTargetTextures(m,Ge.colorTexture,u.ignoreDepthValues?void 0:Ge.depthStencilTexture),e.setRenderTarget(m)}let we=C[Ee];if(we===void 0)we=new yt,we.layers.enable(Ee),we.viewport=new at,C[Ee]=we;if(we.matrix.fromArray(Ie.transform.matrix),we.matrix.decompose(we.position,we.quaternion,we.scale),we.projectionMatrix.fromArray(Ie.projectionMatrix),we.projectionMatrixInverse.copy(we.projectionMatrix).invert(),we.viewport.set(ke.x,ke.y,ke.width,ke.height),Ee===0)D.matrix.copy(we.matrix),D.matrix.decompose(D.position,D.quaternion,D.scale);if(ve===!0)D.cameras.push(we)}}for(let ge=0;ge<p.length;ge++){let ve=x[ge],Ee=p[ge];if(ve!==null&&Ee!==void 0)Ee.update(ve,te,l||r)}if(q)q(O,te);if(te.detectedPlanes)n.dispatchEvent({type:"planesdetected",data:te});f=null}let oe=new sh;oe.setAnimationLoop(ee),this.setAnimationLoop=function(O){q=O},this.dispose=function(){}}}function g_(e,t){function n(m,p){if(m.matrixAutoUpdate===!0)m.updateMatrix();p.value.copy(m.matrix)}function i(m,p){if(p.color.getRGB(m.fogColor.value,th(e)),p.isFog)m.fogNear.value=p.near,m.fogFar.value=p.far;else if(p.isFogExp2)m.fogDensity.value=p.density}function s(m,p,x,v,b){if(p.isMeshBasicMaterial)r(m,p);else if(p.isMeshLambertMaterial)r(m,p);else if(p.isMeshToonMaterial)r(m,p),u(m,p);else if(p.isMeshPhongMaterial)r(m,p),h(m,p);else if(p.isMeshStandardMaterial){if(r(m,p),d(m,p),p.isMeshPhysicalMaterial)f(m,p,b)}else if(p.isMeshMatcapMaterial)r(m,p),g(m,p);else if(p.isMeshDepthMaterial)r(m,p);else if(p.isMeshDistanceMaterial)r(m,p),_(m,p);else if(p.isMeshNormalMaterial)r(m,p);else if(p.isLineBasicMaterial){if(a(m,p),p.isLineDashedMaterial)o(m,p)}else if(p.isPointsMaterial)l(m,p,x,v);else if(p.isSpriteMaterial)c(m,p);else if(p.isShadowMaterial)m.color.value.copy(p.color),m.opacity.value=p.opacity;else if(p.isShaderMaterial)p.uniformsNeedUpdate=!1}function r(m,p){if(m.opacity.value=p.opacity,p.color)m.diffuse.value.copy(p.color);if(p.emissive)m.emissive.value.copy(p.emissive).multiplyScalar(p.emissiveIntensity);if(p.map)m.map.value=p.map,n(p.map,m.mapTransform);if(p.alphaMap)m.alphaMap.value=p.alphaMap,n(p.alphaMap,m.alphaMapTransform);if(p.bumpMap){if(m.bumpMap.value=p.bumpMap,n(p.bumpMap,m.bumpMapTransform),m.bumpScale.value=p.bumpScale,p.side===1)m.bumpScale.value*=-1}if(p.normalMap){if(m.normalMap.value=p.normalMap,n(p.normalMap,m.normalMapTransform),m.normalScale.value.copy(p.normalScale),p.side===1)m.normalScale.value.negate()}if(p.displacementMap)m.displacementMap.value=p.displacementMap,n(p.displacementMap,m.displacementMapTransform),m.displacementScale.value=p.displacementScale,m.displacementBias.value=p.displacementBias;if(p.emissiveMap)m.emissiveMap.value=p.emissiveMap,n(p.emissiveMap,m.emissiveMapTransform);if(p.specularMap)m.specularMap.value=p.specularMap,n(p.specularMap,m.specularMapTransform);if(p.alphaTest>0)m.alphaTest.value=p.alphaTest;let x=t.get(p).envMap;if(x)m.envMap.value=x,m.flipEnvMap.value=x.isCubeTexture&&x.isRenderTargetTexture===!1?-1:1,m.reflectivity.value=p.reflectivity,m.ior.value=p.ior,m.refractionRatio.value=p.refractionRatio;if(p.lightMap){m.lightMap.value=p.lightMap;let v=e._useLegacyLights===!0?Math.PI:1;m.lightMapIntensity.value=p.lightMapIntensity*v,n(p.lightMap,m.lightMapTransform)}if(p.aoMap)m.aoMap.value=p.aoMap,m.aoMapIntensity.value=p.aoMapIntensity,n(p.aoMap,m.aoMapTransform)}function a(m,p){if(m.diffuse.value.copy(p.color),m.opacity.value=p.opacity,p.map)m.map.value=p.map,n(p.map,m.mapTransform)}function o(m,p){m.dashSize.value=p.dashSize,m.totalSize.value=p.dashSize+p.gapSize,m.scale.value=p.scale}function l(m,p,x,v){if(m.diffuse.value.copy(p.color),m.opacity.value=p.opacity,m.size.value=p.size*x,m.scale.value=v*0.5,p.map)m.map.value=p.map,n(p.map,m.uvTransform);if(p.alphaMap)m.alphaMap.value=p.alphaMap,n(p.alphaMap,m.alphaMapTransform);if(p.alphaTest>0)m.alphaTest.value=p.alphaTest}function c(m,p){if(m.diffuse.value.copy(p.color),m.opacity.value=p.opacity,m.rotation.value=p.rotation,p.map)m.map.value=p.map,n(p.map,m.mapTransform);if(p.alphaMap)m.alphaMap.value=p.alphaMap,n(p.alphaMap,m.alphaMapTransform);if(p.alphaTest>0)m.alphaTest.value=p.alphaTest}function h(m,p){m.specular.value.copy(p.specular),m.shininess.value=Math.max(p.shininess,0.0001)}function u(m,p){if(p.gradientMap)m.gradientMap.value=p.gradientMap}function d(m,p){if(m.metalness.value=p.metalness,p.metalnessMap)m.metalnessMap.value=p.metalnessMap,n(p.metalnessMap,m.metalnessMapTransform);if(m.roughness.value=p.roughness,p.roughnessMap)m.roughnessMap.value=p.roughnessMap,n(p.roughnessMap,m.roughnessMapTransform);if(t.get(p).envMap)m.envMapIntensity.value=p.envMapIntensity}function f(m,p,x){if(m.ior.value=p.ior,p.sheen>0){if(m.sheenColor.value.copy(p.sheenColor).multiplyScalar(p.sheen),m.sheenRoughness.value=p.sheenRoughness,p.sheenColorMap)m.sheenColorMap.value=p.sheenColorMap,n(p.sheenColorMap,m.sheenColorMapTransform);if(p.sheenRoughnessMap)m.sheenRoughnessMap.value=p.sheenRoughnessMap,n(p.sheenRoughnessMap,m.sheenRoughnessMapTransform)}if(p.clearcoat>0){if(m.clearcoat.value=p.clearcoat,m.clearcoatRoughness.value=p.clearcoatRoughness,p.clearcoatMap)m.clearcoatMap.value=p.clearcoatMap,n(p.clearcoatMap,m.clearcoatMapTransform);if(p.clearcoatRoughnessMap)m.clearcoatRoughnessMap.value=p.clearcoatRoughnessMap,n(p.clearcoatRoughnessMap,m.clearcoatRoughnessMapTransform);if(p.clearcoatNormalMap){if(m.clearcoatNormalMap.value=p.clearcoatNormalMap,n(p.clearcoatNormalMap,m.clearcoatNormalMapTransform),m.clearcoatNormalScale.value.copy(p.clearcoatNormalScale),p.side===1)m.clearcoatNormalScale.value.negate()}}if(p.iridescence>0){if(m.iridescence.value=p.iridescence,m.iridescenceIOR.value=p.iridescenceIOR,m.iridescenceThicknessMinimum.value=p.iridescenceThicknessRange[0],m.iridescenceThicknessMaximum.value=p.iridescenceThicknessRange[1],p.iridescenceMap)m.iridescenceMap.value=p.iridescenceMap,n(p.iridescenceMap,m.iridescenceMapTransform);if(p.iridescenceThicknessMap)m.iridescenceThicknessMap.value=p.iridescenceThicknessMap,n(p.iridescenceThicknessMap,m.iridescenceThicknessMapTransform)}if(p.transmission>0){if(m.transmission.value=p.transmission,m.transmissionSamplerMap.value=x.texture,m.transmissionSamplerSize.value.set(x.width,x.height),p.transmissionMap)m.transmissionMap.value=p.transmissionMap,n(p.transmissionMap,m.transmissionMapTransform);if(m.thickness.value=p.thickness,p.thicknessMap)m.thicknessMap.value=p.thicknessMap,n(p.thicknessMap,m.thicknessMapTransform);m.attenuationDistance.value=p.attenuationDistance,m.attenuationColor.value.copy(p.attenuationColor)}if(p.anisotropy>0){if(m.anisotropyVector.value.set(p.anisotropy*Math.cos(p.anisotropyRotation),p.anisotropy*Math.sin(p.anisotropyRotation)),p.anisotropyMap)m.anisotropyMap.value=p.anisotropyMap,n(p.anisotropyMap,m.anisotropyMapTransform)}if(m.specularIntensity.value=p.specularIntensity,m.specularColor.value.copy(p.specularColor),p.specularColorMap)m.specularColorMap.value=p.specularColorMap,n(p.specularColorMap,m.specularColorMapTransform);if(p.specularIntensityMap)m.specularIntensityMap.value=p.specularIntensityMap,n(p.specularIntensityMap,m.specularIntensityMapTransform)}function g(m,p){if(p.matcap)m.matcap.value=p.matcap}function _(m,p){let x=t.get(p).light;m.referencePosition.value.setFromMatrixPosition(x.matrixWorld),m.nearDistance.value=x.shadow.camera.near,m.farDistance.value=x.shadow.camera.far}return{refreshFogUniforms:i,refreshMaterialUniforms:s}}function __(e,t,n,i){let s={},r={},a=[],o=n.isWebGL2?e.getParameter(e.MAX_UNIFORM_BUFFER_BINDINGS):0;function l(x,v){let b=v.program;i.uniformBlockBinding(x,b)}function c(x,v){let b=s[x.id];if(b===void 0)g(x),b=h(x),s[x.id]=b,x.addEventListener("dispose",m);let R=v.program;i.updateUBOMapping(x,R);let M=t.render.frame;if(r[x.id]!==M)d(x),r[x.id]=M}function h(x){let v=u();x.__bindingPointIndex=v;let b=e.createBuffer(),{__size:R,usage:M}=x;return e.bindBuffer(e.UNIFORM_BUFFER,b),e.bufferData(e.UNIFORM_BUFFER,R,M),e.bindBuffer(e.UNIFORM_BUFFER,null),e.bindBufferBase(e.UNIFORM_BUFFER,v,b),b}function u(){for(let x=0;x<o;x++)if(a.indexOf(x)===-1)return a.push(x),x;return console.error("THREE.WebGLRenderer: Maximum number of simultaneously usable uniforms groups reached."),0}function d(x){let v=s[x.id],{uniforms:b,__cache:R}=x;e.bindBuffer(e.UNIFORM_BUFFER,v);for(let M=0,C=b.length;M<C;M++){let D=Array.isArray(b[M])?b[M]:[b[M]];for(let S=0,w=D.length;S<w;S++){let U=D[S];if(f(U,M,S,R)===!0){let J=U.__offset,ae=Array.isArray(U.value)?U.value:[U.value],I=0;for(let z=0;z<ae.length;z++){let X=ae[z],ne=_(X);if(typeof X==="number"||typeof X==="boolean")U.__data[0]=X,e.bufferSubData(e.UNIFORM_BUFFER,J+I,U.__data);else if(X.isMatrix3)U.__data[0]=X.elements[0],U.__data[1]=X.elements[1],U.__data[2]=X.elements[2],U.__data[3]=0,U.__data[4]=X.elements[3],U.__data[5]=X.elements[4],U.__data[6]=X.elements[5],U.__data[7]=0,U.__data[8]=X.elements[6],U.__data[9]=X.elements[7],U.__data[10]=X.elements[8],U.__data[11]=0;else X.toArray(U.__data,I),I+=ne.storage/Float32Array.BYTES_PER_ELEMENT}e.bufferSubData(e.UNIFORM_BUFFER,J,U.__data)}}}e.bindBuffer(e.UNIFORM_BUFFER,null)}function f(x,v,b,R){let M=x.value,C=v+"_"+b;if(R[C]===void 0){if(typeof M==="number"||typeof M==="boolean")R[C]=M;else R[C]=M.clone();return!0}else{let D=R[C];if(typeof M==="number"||typeof M==="boolean"){if(D!==M)return R[C]=M,!0}else if(D.equals(M)===!1)return D.copy(M),!0}return!1}function g(x){let v=x.uniforms,b=0,R=16;for(let C=0,D=v.length;C<D;C++){let S=Array.isArray(v[C])?v[C]:[v[C]];for(let w=0,U=S.length;w<U;w++){let J=S[w],ae=Array.isArray(J.value)?J.value:[J.value];for(let I=0,z=ae.length;I<z;I++){let X=ae[I],ne=_(X),V=b%R;if(V!==0&&R-V<ne.boundary)b+=R-V;J.__data=new Float32Array(ne.storage/Float32Array.BYTES_PER_ELEMENT),J.__offset=b,b+=ne.storage}}}let M=b%R;if(M>0)b+=R-M;return x.__size=b,x.__cache={},this}function _(x){let v={boundary:0,storage:0};if(typeof x==="number"||typeof x==="boolean")v.boundary=4,v.storage=4;else if(x.isVector2)v.boundary=8,v.storage=8;else if(x.isVector3||x.isColor)v.boundary=16,v.storage=12;else if(x.isVector4)v.boundary=16,v.storage=16;else if(x.isMatrix3)v.boundary=48,v.storage=48;else if(x.isMatrix4)v.boundary=64,v.storage=64;else if(x.isTexture)console.warn("THREE.WebGLRenderer: Texture samplers can not be part of an uniforms group.");else console.warn("THREE.WebGLRenderer: Unsupported uniform value type.",x);return v}function m(x){let v=x.target;v.removeEventListener("dispose",m);let b=a.indexOf(v.__bindingPointIndex);a.splice(b,1),e.deleteBuffer(s[v.id]),delete s[v.id],delete r[v.id]}function p(){for(let x in s)e.deleteBuffer(s[x]);a=[],s={},r={}}return{bind:l,update:c,dispose:p}}class _h{constructor(e={}){let{canvas:t=md(),context:n=null,depth:i=!0,stencil:s=!0,alpha:r=!1,antialias:a=!1,premultipliedAlpha:o=!0,preserveDrawingBuffer:l=!1,powerPreference:c="default",failIfMajorPerformanceCaveat:h=!1}=e;this.isWebGLRenderer=!0;let u;if(n!==null)u=n.getContextAttributes().alpha;else u=r;let d=new Uint32Array(4),f=new Int32Array(4),g=null,_=null,m=[],p=[];this.domElement=t,this.debug={checkShaderErrors:!0,onShaderError:null},this.autoClear=!0,this.autoClearColor=!0,this.autoClearDepth=!0,this.autoClearStencil=!0,this.sortObjects=!0,this.clippingPlanes=[],this.localClippingEnabled=!1,this._outputColorSpace="srgb",this._useLegacyLights=!1,this.toneMapping=0,this.toneMappingExposure=1;let x=this,v=!1,b=0,R=0,M=null,C=-1,D=null,S=new at,w=new at,U=null,J=new ue(0),ae=0,{width:I,height:z}=t,X=1,ne=null,V=null,q=new at(0,0,I,z),ee=new at(0,0,I,z),oe=!1,O=new ws,te=!1,ge=!1,ve=null,Ee=new De,Ie=new W,ke=new T,we={background:null,fog:null,environment:null,overrideMaterial:null,isScene:!0};function Ge(){return M===null?X:1}let P=n;function ce(A,F){for(let G=0;G<A.length;G++){let H=A[G],k=t.getContext(H,F);if(k!==null)return k}return null}try{let A={alpha:!0,depth:i,stencil:s,antialias:a,premultipliedAlpha:o,preserveDrawingBuffer:l,powerPreference:c,failIfMajorPerformanceCaveat:h};if("setAttribute"in t)t.setAttribute("data-engine","three.js r160");if(t.addEventListener("webglcontextlost",rt,!1),t.addEventListener("webglcontextrestored",de,!1),t.addEventListener("webglcontextcreationerror",N,!1),P===null){let F=["webgl2","webgl","experimental-webgl"];if(x.isWebGL1Renderer===!0)F.shift();if(P=ce(F,A),P===null)if(ce(F))throw Error("Error creating WebGL context with your selected attributes.");else throw Error("Error creating WebGL context.")}if(typeof WebGLRenderingContext<"u"&&P instanceof WebGLRenderingContext)console.warn("THREE.WebGLRenderer: WebGL 1 support was deprecated in r153 and will be removed in r163.");if(P.getShaderPrecisionFormat===void 0)P.getShaderPrecisionFormat=function(){return{rangeMin:1,rangeMax:1,precision:1}}}catch(A){throw console.error("THREE.WebGLRenderer: "+A.message),A}let j,Q,Z,xe,Se,be,E,y,B,ie,Y,se,Le,pe,Te,Re,Fe,K,L,re,ye,le,_e,Oe;function Xe(){j=new Fm(P),Q=new Pm(P,j,e),j.init(Q),le=new p_(P,j,Q),Z=new d_(P,j,Q),xe=new zm(P),Se=new e_,be=new f_(P,j,Z,Se,Q,le,xe),E=new Im(x),y=new Um(x),B=new qd(P,Q),_e=new Rm(P,j,B,Q),ie=new Om(P,B,xe,_e),Y=new Wm(P,ie,B,xe),L=new Hm(P,Q,be),Re=new Lm(Se),se=new Qg(x,E,y,j,Q,_e,Re),Le=new g_(x,Se),pe=new n_,Te=new l_(j,Q),K=new wm(x,E,y,Z,Y,u,o),Fe=new u_(x,Y,Q),Oe=new __(P,xe,Q,Z),re=new Cm(P,j,xe,Q),ye=new Bm(P,j,xe,Q),xe.programs=se.programs,x.capabilities=Q,x.extensions=j,x.properties=Se,x.renderLists=pe,x.shadowMap=Fe,x.state=Z,x.info=xe}Xe();let je=new gh(x,P);this.xr=je,this.getContext=function(){return P},this.getContextAttributes=function(){return P.getContextAttributes()},this.forceContextLoss=function(){let A=j.get("WEBGL_lose_context");if(A)A.loseContext()},this.forceContextRestore=function(){let A=j.get("WEBGL_lose_context");if(A)A.restoreContext()},this.getPixelRatio=function(){return X},this.setPixelRatio=function(A){if(A===void 0)return;X=A,this.setSize(I,z,!1)},this.getSize=function(A){return A.set(I,z)},this.setSize=function(A,F,G=!0){if(je.isPresenting){console.warn("THREE.WebGLRenderer: Can't change size while VR device is presenting.");return}if(I=A,z=F,t.width=Math.floor(A*X),t.height=Math.floor(F*X),G===!0)t.style.width=A+"px",t.style.height=F+"px";this.setViewport(0,0,A,F)},this.getDrawingBufferSize=function(A){return A.set(I*X,z*X).floor()},this.setDrawingBufferSize=function(A,F,G){I=A,z=F,X=G,t.width=Math.floor(A*G),t.height=Math.floor(F*G),this.setViewport(0,0,A,F)},this.getCurrentViewport=function(A){return A.copy(S)},this.getViewport=function(A){return A.copy(q)},this.setViewport=function(A,F,G,H){if(A.isVector4)q.set(A.x,A.y,A.z,A.w);else q.set(A,F,G,H);Z.viewport(S.copy(q).multiplyScalar(X).floor())},this.getScissor=function(A){return A.copy(ee)},this.setScissor=function(A,F,G,H){if(A.isVector4)ee.set(A.x,A.y,A.z,A.w);else ee.set(A,F,G,H);Z.scissor(w.copy(ee).multiplyScalar(X).floor())},this.getScissorTest=function(){return oe},this.setScissorTest=function(A){Z.setScissorTest(oe=A)},this.setOpaqueSort=function(A){ne=A},this.setTransparentSort=function(A){V=A},this.getClearColor=function(A){return A.copy(K.getClearColor())},this.setClearColor=function(){K.setClearColor.apply(K,arguments)},this.getClearAlpha=function(){return K.getClearAlpha()},this.setClearAlpha=function(){K.setClearAlpha.apply(K,arguments)},this.clear=function(A=!0,F=!0,G=!0){let H=0;if(A){let k=!1;if(M!==null){let Me=M.texture.format;k=Me===1033||Me===1031||Me===1029}if(k){let Me=M.texture.type,Pe=Me===1009||Me===1014||Me===1012||Me===1020||Me===1017||Me===1018,Ue=K.getClearColor(),Be=K.getClearAlpha(),{r:Ye,g:He,b:We}=Ue;if(Pe)d[0]=Ye,d[1]=He,d[2]=We,d[3]=Be,P.clearBufferuiv(P.COLOR,0,d);else f[0]=Ye,f[1]=He,f[2]=We,f[3]=Be,P.clearBufferiv(P.COLOR,0,f)}else H|=P.COLOR_BUFFER_BIT}if(F)H|=P.DEPTH_BUFFER_BIT;if(G)H|=P.STENCIL_BUFFER_BIT,this.state.buffers.stencil.setMask(4294967295);P.clear(H)},this.clearColor=function(){this.clear(!0,!1,!1)},this.clearDepth=function(){this.clear(!1,!0,!1)},this.clearStencil=function(){this.clear(!1,!1,!0)},this.dispose=function(){if(t.removeEventListener("webglcontextlost",rt,!1),t.removeEventListener("webglcontextrestored",de,!1),t.removeEventListener("webglcontextcreationerror",N,!1),pe.dispose(),Te.dispose(),Se.dispose(),E.dispose(),y.dispose(),Y.dispose(),_e.dispose(),Oe.dispose(),se.dispose(),je.dispose(),je.removeEventListener("sessionstart",vt),je.removeEventListener("sessionend",Ft),ve)ve.dispose(),ve=null;st.stop()};function rt(A){A.preventDefault(),console.log("THREE.WebGLRenderer: Context Lost."),v=!0}function de(){console.log("THREE.WebGLRenderer: Context Restored."),v=!1;let A=xe.autoReset,F=Fe.enabled,G=Fe.autoUpdate,H=Fe.needsUpdate,k=Fe.type;Xe(),xe.autoReset=A,Fe.enabled=F,Fe.autoUpdate=G,Fe.needsUpdate=H,Fe.type=k}function N(A){console.error("THREE.WebGLRenderer: A WebGL context could not be created. Reason: ",A.statusMessage)}function he(A){let F=A.target;F.removeEventListener("dispose",he),me(F)}function me(A){Ne(A),Se.remove(A)}function Ne(A){let F=Se.get(A).programs;if(F!==void 0){if(F.forEach(function(G){se.releaseProgram(G)}),A.isShaderMaterial)se.releaseShaderCache(A)}}this.renderBufferDirect=function(A,F,G,H,k,Me){if(F===null)F=we;let Pe=k.isMesh&&k.matrixWorld.determinant()<0,Ue=Ju(A,F,G,H,k);Z.setMaterial(H,Pe);let Be=G.index,Ye=1;if(H.wireframe===!0){if(Be=ie.getWireframeAttribute(G),Be===void 0)return;Ye=2}let He=G.drawRange,We=G.attributes.position,pt=He.start*Ye,Gt=(He.start+He.count)*Ye;if(Me!==null)pt=Math.max(pt,Me.start*Ye),Gt=Math.min(Gt,(Me.start+Me.count)*Ye);if(Be!==null)pt=Math.max(pt,0),Gt=Math.min(Gt,Be.count);else if(We!==void 0&&We!==null)pt=Math.max(pt,0),Gt=Math.min(Gt,We.count);let bt=Gt-pt;if(bt<0||bt===1/0)return;_e.setup(k,H,Ue,G,Be);let fn,lt=re;if(Be!==null)fn=B.get(Be),lt=ye,lt.setIndex(fn);if(k.isMesh)if(H.wireframe===!0)Z.setLineWidth(H.wireframeLinewidth*Ge()),lt.setMode(P.LINES);else lt.setMode(P.TRIANGLES);else if(k.isLine){let Ke=H.linewidth;if(Ke===void 0)Ke=1;if(Z.setLineWidth(Ke*Ge()),k.isLineSegments)lt.setMode(P.LINES);else if(k.isLineLoop)lt.setMode(P.LINE_LOOP);else lt.setMode(P.LINE_STRIP)}else if(k.isPoints)lt.setMode(P.POINTS);else if(k.isSprite)lt.setMode(P.TRIANGLES);if(k.isBatchedMesh)lt.renderMultiDraw(k._multiDrawStarts,k._multiDrawCounts,k._multiDrawCount);else if(k.isInstancedMesh)lt.renderInstances(pt,bt,k.count);else if(G.isInstancedBufferGeometry){let Ke=G._maxInstanceCount!==void 0?G._maxInstanceCount:1/0,ra=Math.min(G.instanceCount,Ke);lt.renderInstances(pt,bt,ra)}else lt.render(pt,bt)};function Ce(A,F,G){if(A.transparent===!0&&A.side===2&&A.forceSinglePass===!1)A.side=1,A.needsUpdate=!0,Ds(A,F,G),A.side=0,A.needsUpdate=!0,Ds(A,F,G),A.side=2;else Ds(A,F,G)}this.compile=function(A,F,G=null){if(G===null)G=A;if(_=Te.get(G),_.init(),p.push(_),G.traverseVisible(function(k){if(k.isLight&&k.layers.test(F.layers)){if(_.pushLight(k),k.castShadow)_.pushShadow(k)}}),A!==G)A.traverseVisible(function(k){if(k.isLight&&k.layers.test(F.layers)){if(_.pushLight(k),k.castShadow)_.pushShadow(k)}});_.setupLights(x._useLegacyLights);let H=new Set;return A.traverse(function(k){let Me=k.material;if(Me)if(Array.isArray(Me))for(let Pe=0;Pe<Me.length;Pe++){let Ue=Me[Pe];Ce(Ue,G,k),H.add(Ue)}else Ce(Me,G,k),H.add(Me)}),p.pop(),_=null,H},this.compileAsync=function(A,F,G=null){let H=this.compile(A,F,G);return new Promise((k)=>{function Me(){if(H.forEach(function(Pe){if(Se.get(Pe).currentProgram.isReady())H.delete(Pe)}),H.size===0){k(A);return}setTimeout(Me,10)}if(j.get("KHR_parallel_shader_compile")!==null)Me();else setTimeout(Me,10)})};let it=null;function ot(A){if(it)it(A)}function vt(){st.stop()}function Ft(){st.start()}let st=new sh;if(st.setAnimationLoop(ot),typeof self<"u")st.setContext(self);this.setAnimationLoop=function(A){it=A,je.setAnimationLoop(A),A===null?st.stop():st.start()},je.addEventListener("sessionstart",vt),je.addEventListener("sessionend",Ft),this.render=function(A,F){if(F!==void 0&&F.isCamera!==!0){console.error("THREE.WebGLRenderer.render: camera is not an instance of THREE.Camera.");return}if(v===!0)return;if(A.matrixWorldAutoUpdate===!0)A.updateMatrixWorld();if(F.parent===null&&F.matrixWorldAutoUpdate===!0)F.updateMatrixWorld();if(je.enabled===!0&&je.isPresenting===!0){if(je.cameraAutoUpdate===!0)je.updateCamera(F);F=je.getCamera()}if(A.isScene===!0)A.onBeforeRender(x,A,F,M);if(_=Te.get(A,p.length),_.init(),p.push(_),Ee.multiplyMatrices(F.projectionMatrix,F.matrixWorldInverse),O.setFromProjectionMatrix(Ee),ge=this.localClippingEnabled,te=Re.init(this.clippingPlanes,ge),g=pe.get(A,m.length),g.init(),m.push(g),an(A,F,0,x.sortObjects),g.finish(),x.sortObjects===!0)g.sort(ne,V);if(this.info.render.frame++,te===!0)Re.beginShadows();let G=_.state.shadowsArray;if(Fe.render(G,A,F),te===!0)Re.endShadows();if(this.info.autoReset===!0)this.info.reset();if(K.render(g,A),_.setupLights(x._useLegacyLights),F.isArrayCamera){let H=F.cameras;for(let k=0,Me=H.length;k<Me;k++){let Pe=H[k];on(g,A,Pe,Pe.viewport)}}else on(g,A,F);if(M!==null)be.updateMultisampleRenderTarget(M),be.updateRenderTargetMipmap(M);if(A.isScene===!0)A.onAfterRender(x,A,F);if(_e.resetDefaultState(),C=-1,D=null,p.pop(),p.length>0)_=p[p.length-1];else _=null;if(m.pop(),m.length>0)g=m[m.length-1];else g=null};function an(A,F,G,H){if(A.visible===!1)return;if(A.layers.test(F.layers)){if(A.isGroup)G=A.renderOrder;else if(A.isLOD){if(A.autoUpdate===!0)A.update(F)}else if(A.isLight){if(_.pushLight(A),A.castShadow)_.pushShadow(A)}else if(A.isSprite){if(!A.frustumCulled||O.intersectsSprite(A)){if(H)ke.setFromMatrixPosition(A.matrixWorld).applyMatrix4(Ee);let Pe=Y.update(A),Ue=A.material;if(Ue.visible)g.push(A,Pe,Ue,G,ke.z,null)}}else if(A.isMesh||A.isLine||A.isPoints){if(!A.frustumCulled||O.intersectsObject(A)){let Pe=Y.update(A),Ue=A.material;if(H){if(A.boundingSphere!==void 0){if(A.boundingSphere===null)A.computeBoundingSphere();ke.copy(A.boundingSphere.center)}else{if(Pe.boundingSphere===null)Pe.computeBoundingSphere();ke.copy(Pe.boundingSphere.center)}ke.applyMatrix4(A.matrixWorld).applyMatrix4(Ee)}if(Array.isArray(Ue)){let Be=Pe.groups;for(let Ye=0,He=Be.length;Ye<He;Ye++){let We=Be[Ye],pt=Ue[We.materialIndex];if(pt&&pt.visible)g.push(A,Pe,pt,G,ke.z,We)}}else if(Ue.visible)g.push(A,Pe,Ue,G,ke.z,null)}}}let Me=A.children;for(let Pe=0,Ue=Me.length;Pe<Ue;Pe++)an(Me[Pe],F,G,H)}function on(A,F,G,H){let{opaque:k,transmissive:Me,transparent:Pe}=A;if(_.setupLightsView(G),te===!0)Re.setGlobalState(x.clippingPlanes,G);if(Me.length>0)Ku(k,Me,F,G);if(H)Z.viewport(S.copy(H));if(k.length>0)Ns(k,F,G);if(Me.length>0)Ns(Me,F,G);if(Pe.length>0)Ns(Pe,F,G);Z.buffers.depth.setTest(!0),Z.buffers.depth.setMask(!0),Z.buffers.color.setMask(!0),Z.setPolygonOffset(!1)}function Ku(A,F,G,H){if((G.isScene===!0?G.overrideMaterial:null)!==null)return;let Me=Q.isWebGL2;if(ve===null)ve=new Ct(1,1,{generateMipmaps:!0,type:j.has("EXT_color_buffer_half_float")?1016:1009,minFilter:1008,samples:Me?4:0});if(x.getDrawingBufferSize(Ie),Me)ve.setSize(Ie.x,Ie.y);else ve.setSize(Rr(Ie.x),Rr(Ie.y));let Pe=x.getRenderTarget();if(x.setRenderTarget(ve),x.getClearColor(J),ae=x.getClearAlpha(),ae<1)x.setClearColor(16777215,0.5);x.clear();let Ue=x.toneMapping;x.toneMapping=0,Ns(A,G,H),be.updateMultisampleRenderTarget(ve),be.updateRenderTargetMipmap(ve);let Be=!1;for(let Ye=0,He=F.length;Ye<He;Ye++){let We=F[Ye],{object:pt,geometry:Gt,material:bt,group:fn}=We;if(bt.side===2&&pt.layers.test(H.layers)){let lt=bt.side;bt.side=1,bt.needsUpdate=!0,Qo(pt,G,H,Gt,bt,fn),bt.side=lt,bt.needsUpdate=!0,Be=!0}}if(Be===!0)be.updateMultisampleRenderTarget(ve),be.updateRenderTargetMipmap(ve);x.setRenderTarget(Pe),x.setClearColor(J,ae),x.toneMapping=Ue}function Ns(A,F,G){let H=F.isScene===!0?F.overrideMaterial:null;for(let k=0,Me=A.length;k<Me;k++){let Pe=A[k],{object:Ue,geometry:Be}=Pe,Ye=H===null?Pe.material:H,He=Pe.group;if(Ue.layers.test(G.layers))Qo(Ue,F,G,Be,Ye,He)}}function Qo(A,F,G,H,k,Me){if(A.onBeforeRender(x,F,G,H,k,Me),A.modelViewMatrix.multiplyMatrices(G.matrixWorldInverse,A.matrixWorld),A.normalMatrix.getNormalMatrix(A.modelViewMatrix),k.onBeforeRender(x,F,G,H,A,Me),k.transparent===!0&&k.side===2&&k.forceSinglePass===!1)k.side=1,k.needsUpdate=!0,x.renderBufferDirect(G,F,H,k,A,Me),k.side=0,k.needsUpdate=!0,x.renderBufferDirect(G,F,H,k,A,Me),k.side=2;else x.renderBufferDirect(G,F,H,k,A,Me);A.onAfterRender(x,F,G,H,k,Me)}function Ds(A,F,G){if(F.isScene!==!0)F=we;let H=Se.get(A),k=_.state.lights,Me=_.state.shadowsArray,Pe=k.state.version,Ue=se.getParameters(A,k.state,Me,F,G),Be=se.getProgramCacheKey(Ue),Ye=H.programs;if(H.environment=A.isMeshStandardMaterial?F.environment:null,H.fog=F.fog,H.envMap=(A.isMeshStandardMaterial?y:E).get(A.envMap||H.environment),Ye===void 0)A.addEventListener("dispose",he),Ye=new Map,H.programs=Ye;let He=Ye.get(Be);if(He!==void 0){if(H.currentProgram===He&&H.lightsStateVersion===Pe)return tl(A,Ue),He}else Ue.uniforms=se.getUniforms(A),A.onBuild(G,Ue,x),A.onBeforeCompile(Ue,x),He=se.acquireProgram(Ue,Be),Ye.set(Be,He),H.uniforms=Ue.uniforms;let We=H.uniforms;if(!A.isShaderMaterial&&!A.isRawShaderMaterial||A.clipping===!0)We.clippingPlanes=Re.uniform;if(tl(A,Ue),H.needsLights=ju(A),H.lightsStateVersion=Pe,H.needsLights)We.ambientLightColor.value=k.state.ambient,We.lightProbe.value=k.state.probe,We.directionalLights.value=k.state.directional,We.directionalLightShadows.value=k.state.directionalShadow,We.spotLights.value=k.state.spot,We.spotLightShadows.value=k.state.spotShadow,We.rectAreaLights.value=k.state.rectArea,We.ltc_1.value=k.state.rectAreaLTC1,We.ltc_2.value=k.state.rectAreaLTC2,We.pointLights.value=k.state.point,We.pointLightShadows.value=k.state.pointShadow,We.hemisphereLights.value=k.state.hemi,We.directionalShadowMap.value=k.state.directionalShadowMap,We.directionalShadowMatrix.value=k.state.directionalShadowMatrix,We.spotShadowMap.value=k.state.spotShadowMap,We.spotLightMatrix.value=k.state.spotLightMatrix,We.spotLightMap.value=k.state.spotLightMap,We.pointShadowMap.value=k.state.pointShadowMap,We.pointShadowMatrix.value=k.state.pointShadowMatrix;return H.currentProgram=He,H.uniformsList=null,He}function el(A){if(A.uniformsList===null){let F=A.currentProgram.getUniforms();A.uniformsList=gs.seqWithValue(F.seq,A.uniforms)}return A.uniformsList}function tl(A,F){let G=Se.get(A);G.outputColorSpace=F.outputColorSpace,G.batching=F.batching,G.instancing=F.instancing,G.instancingColor=F.instancingColor,G.skinning=F.skinning,G.morphTargets=F.morphTargets,G.morphNormals=F.morphNormals,G.morphColors=F.morphColors,G.morphTargetsCount=F.morphTargetsCount,G.numClippingPlanes=F.numClippingPlanes,G.numIntersection=F.numClipIntersection,G.vertexAlphas=F.vertexAlphas,G.vertexTangents=F.vertexTangents,G.toneMapping=F.toneMapping}function Ju(A,F,G,H,k){if(F.isScene!==!0)F=we;be.resetTextureUnits();let Me=F.fog,Pe=H.isMeshStandardMaterial?F.environment:null,Ue=M===null?x.outputColorSpace:M.isXRRenderTarget===!0?M.texture.colorSpace:"srgb-linear",Be=(H.isMeshStandardMaterial?y:E).get(H.envMap||Pe),Ye=H.vertexColors===!0&&!!G.attributes.color&&G.attributes.color.itemSize===4,He=!!G.attributes.tangent&&(!!H.normalMap||H.anisotropy>0),We=!!G.morphAttributes.position,pt=!!G.morphAttributes.normal,Gt=!!G.morphAttributes.color,bt=0;if(H.toneMapped){if(M===null||M.isXRRenderTarget===!0)bt=x.toneMapping}let fn=G.morphAttributes.position||G.morphAttributes.normal||G.morphAttributes.color,lt=fn!==void 0?fn.length:0,Ke=Se.get(H),ra=_.state.lights;if(te===!0){if(ge===!0||A!==D){let qt=A===D&&H.id===C;Re.setState(H,A,qt)}}let ut=!1;if(H.version===Ke.__version){if(Ke.needsLights&&Ke.lightsStateVersion!==ra.state.version)ut=!0;else if(Ke.outputColorSpace!==Ue)ut=!0;else if(k.isBatchedMesh&&Ke.batching===!1)ut=!0;else if(!k.isBatchedMesh&&Ke.batching===!0)ut=!0;else if(k.isInstancedMesh&&Ke.instancing===!1)ut=!0;else if(!k.isInstancedMesh&&Ke.instancing===!0)ut=!0;else if(k.isSkinnedMesh&&Ke.skinning===!1)ut=!0;else if(!k.isSkinnedMesh&&Ke.skinning===!0)ut=!0;else if(k.isInstancedMesh&&Ke.instancingColor===!0&&k.instanceColor===null)ut=!0;else if(k.isInstancedMesh&&Ke.instancingColor===!1&&k.instanceColor!==null)ut=!0;else if(Ke.envMap!==Be)ut=!0;else if(H.fog===!0&&Ke.fog!==Me)ut=!0;else if(Ke.numClippingPlanes!==void 0&&(Ke.numClippingPlanes!==Re.numPlanes||Ke.numIntersection!==Re.numIntersection))ut=!0;else if(Ke.vertexAlphas!==Ye)ut=!0;else if(Ke.vertexTangents!==He)ut=!0;else if(Ke.morphTargets!==We)ut=!0;else if(Ke.morphNormals!==pt)ut=!0;else if(Ke.morphColors!==Gt)ut=!0;else if(Ke.toneMapping!==bt)ut=!0;else if(Q.isWebGL2===!0&&Ke.morphTargetsCount!==lt)ut=!0}else ut=!0,Ke.__version=H.version;let Vn=Ke.currentProgram;if(ut===!0)Vn=Ds(H,F,k);let nl=!1,ts=!1,aa=!1,Lt=Vn.getUniforms(),Xn=Ke.uniforms;if(Z.useProgram(Vn.program))nl=!0,ts=!0,aa=!0;if(H.id!==C)C=H.id,ts=!0;if(nl||D!==A){Lt.setValue(P,"projectionMatrix",A.projectionMatrix),Lt.setValue(P,"viewMatrix",A.matrixWorldInverse);let qt=Lt.map.cameraPosition;if(qt!==void 0)qt.setValue(P,ke.setFromMatrixPosition(A.matrixWorld));if(Q.logarithmicDepthBuffer)Lt.setValue(P,"logDepthBufFC",2/(Math.log(A.far+1)/Math.LN2));if(H.isMeshPhongMaterial||H.isMeshToonMaterial||H.isMeshLambertMaterial||H.isMeshBasicMaterial||H.isMeshStandardMaterial||H.isShaderMaterial)Lt.setValue(P,"isOrthographic",A.isOrthographicCamera===!0);if(D!==A)D=A,ts=!0,aa=!0}if(k.isSkinnedMesh){Lt.setOptional(P,k,"bindMatrix"),Lt.setOptional(P,k,"bindMatrixInverse");let qt=k.skeleton;if(qt)if(Q.floatVertexTextures){if(qt.boneTexture===null)qt.computeBoneTexture();Lt.setValue(P,"boneTexture",qt.boneTexture,be)}else console.warn("THREE.WebGLRenderer: SkinnedMesh can only be used with WebGL 2. With WebGL 1 OES_texture_float and vertex textures support is required.")}if(k.isBatchedMesh)Lt.setOptional(P,k,"batchingTexture"),Lt.setValue(P,"batchingTexture",k._matricesTexture,be);let oa=G.morphAttributes;if(oa.position!==void 0||oa.normal!==void 0||oa.color!==void 0&&Q.isWebGL2===!0)L.update(k,G,Vn);if(ts||Ke.receiveShadow!==k.receiveShadow)Ke.receiveShadow=k.receiveShadow,Lt.setValue(P,"receiveShadow",k.receiveShadow);if(H.isMeshGouraudMaterial&&H.envMap!==null)Xn.envMap.value=Be,Xn.flipEnvMap.value=Be.isCubeTexture&&Be.isRenderTargetTexture===!1?-1:1;if(ts){if(Lt.setValue(P,"toneMappingExposure",x.toneMappingExposure),Ke.needsLights)$u(Xn,aa);if(Me&&H.fog===!0)Le.refreshFogUniforms(Xn,Me);Le.refreshMaterialUniforms(Xn,H,X,z,ve),gs.upload(P,el(Ke),Xn,be)}if(H.isShaderMaterial&&H.uniformsNeedUpdate===!0)gs.upload(P,el(Ke),Xn,be),H.uniformsNeedUpdate=!1;if(H.isSpriteMaterial)Lt.setValue(P,"center",k.center);if(Lt.setValue(P,"modelViewMatrix",k.modelViewMatrix),Lt.setValue(P,"normalMatrix",k.normalMatrix),Lt.setValue(P,"modelMatrix",k.matrixWorld),H.isShaderMaterial||H.isRawShaderMaterial){let qt=H.uniformsGroups;for(let la=0,Qu=qt.length;la<Qu;la++)if(Q.isWebGL2){let il=qt[la];Oe.update(il,Vn),Oe.bind(il,Vn)}else console.warn("THREE.WebGLRenderer: Uniform Buffer Objects can only be used with WebGL 2.")}return Vn}function $u(A,F){A.ambientLightColor.needsUpdate=F,A.lightProbe.needsUpdate=F,A.directionalLights.needsUpdate=F,A.directionalLightShadows.needsUpdate=F,A.pointLights.needsUpdate=F,A.pointLightShadows.needsUpdate=F,A.spotLights.needsUpdate=F,A.spotLightShadows.needsUpdate=F,A.rectAreaLights.needsUpdate=F,A.hemisphereLights.needsUpdate=F}function ju(A){return A.isMeshLambertMaterial||A.isMeshToonMaterial||A.isMeshPhongMaterial||A.isMeshStandardMaterial||A.isShadowMaterial||A.isShaderMaterial&&A.lights===!0}if(this.getActiveCubeFace=function(){return b},this.getActiveMipmapLevel=function(){return R},this.getRenderTarget=function(){return M},this.setRenderTargetTextures=function(A,F,G){Se.get(A.texture).__webglTexture=F,Se.get(A.depthTexture).__webglTexture=G;let H=Se.get(A);if(H.__hasExternalTextures=!0,H.__hasExternalTextures){if(H.__autoAllocateDepthBuffer=G===void 0,!H.__autoAllocateDepthBuffer){if(j.has("WEBGL_multisampled_render_to_texture")===!0)console.warn("THREE.WebGLRenderer: Render-to-texture extension was disabled because an external texture was provided"),H.__useRenderToTexture=!1}}},this.setRenderTargetFramebuffer=function(A,F){let G=Se.get(A);G.__webglFramebuffer=F,G.__useDefaultFramebuffer=F===void 0},this.setRenderTarget=function(A,F=0,G=0){M=A,b=F,R=G;let H=!0,k=null,Me=!1,Pe=!1;if(A){let Be=Se.get(A);if(Be.__useDefaultFramebuffer!==void 0)Z.bindFramebuffer(P.FRAMEBUFFER,null),H=!1;else if(Be.__webglFramebuffer===void 0)be.setupRenderTarget(A);else if(Be.__hasExternalTextures)be.rebindTextures(A,Se.get(A.texture).__webglTexture,Se.get(A.depthTexture).__webglTexture);let Ye=A.texture;if(Ye.isData3DTexture||Ye.isDataArrayTexture||Ye.isCompressedArrayTexture)Pe=!0;let He=Se.get(A).__webglFramebuffer;if(A.isWebGLCubeRenderTarget){if(Array.isArray(He[F]))k=He[F][G];else k=He[F];Me=!0}else if(Q.isWebGL2&&A.samples>0&&be.useMultisampledRTT(A)===!1)k=Se.get(A).__webglMultisampledFramebuffer;else if(Array.isArray(He))k=He[G];else k=He;S.copy(A.viewport),w.copy(A.scissor),U=A.scissorTest}else S.copy(q).multiplyScalar(X).floor(),w.copy(ee).multiplyScalar(X).floor(),U=oe;if(Z.bindFramebuffer(P.FRAMEBUFFER,k)&&Q.drawBuffers&&H)Z.drawBuffers(A,k);if(Z.viewport(S),Z.scissor(w),Z.setScissorTest(U),Me){let Be=Se.get(A.texture);P.framebufferTexture2D(P.FRAMEBUFFER,P.COLOR_ATTACHMENT0,P.TEXTURE_CUBE_MAP_POSITIVE_X+F,Be.__webglTexture,G)}else if(Pe){let Be=Se.get(A.texture),Ye=F||0;P.framebufferTextureLayer(P.FRAMEBUFFER,P.COLOR_ATTACHMENT0,Be.__webglTexture,G||0,Ye)}C=-1},this.readRenderTargetPixels=function(A,F,G,H,k,Me,Pe){if(!(A&&A.isWebGLRenderTarget)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not THREE.WebGLRenderTarget.");return}let Ue=Se.get(A).__webglFramebuffer;if(A.isWebGLCubeRenderTarget&&Pe!==void 0)Ue=Ue[Pe];if(Ue){Z.bindFramebuffer(P.FRAMEBUFFER,Ue);try{let Be=A.texture,{format:Ye,type:He}=Be;if(Ye!==1023&&le.convert(Ye)!==P.getParameter(P.IMPLEMENTATION_COLOR_READ_FORMAT)){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in RGBA or implementation defined format.");return}let We=He===1016&&(j.has("EXT_color_buffer_half_float")||Q.isWebGL2&&j.has("EXT_color_buffer_float"));if(He!==1009&&le.convert(He)!==P.getParameter(P.IMPLEMENTATION_COLOR_READ_TYPE)&&!(He===1015&&(Q.isWebGL2||j.has("OES_texture_float")||j.has("WEBGL_color_buffer_float")))&&!We){console.error("THREE.WebGLRenderer.readRenderTargetPixels: renderTarget is not in UnsignedByteType or implementation defined type.");return}if(F>=0&&F<=A.width-H&&(G>=0&&G<=A.height-k))P.readPixels(F,G,H,k,le.convert(Ye),le.convert(He),Me)}finally{let Be=M!==null?Se.get(M).__webglFramebuffer:null;Z.bindFramebuffer(P.FRAMEBUFFER,Be)}}},this.copyFramebufferToTexture=function(A,F,G=0){let H=Math.pow(2,-G),k=Math.floor(F.image.width*H),Me=Math.floor(F.image.height*H);be.setTexture2D(F,0),P.copyTexSubImage2D(P.TEXTURE_2D,G,0,0,A.x,A.y,k,Me),Z.unbindTexture()},this.copyTextureToTexture=function(A,F,G,H=0){let k=F.image.width,Me=F.image.height,Pe=le.convert(G.format),Ue=le.convert(G.type);if(be.setTexture2D(G,0),P.pixelStorei(P.UNPACK_FLIP_Y_WEBGL,G.flipY),P.pixelStorei(P.UNPACK_PREMULTIPLY_ALPHA_WEBGL,G.premultiplyAlpha),P.pixelStorei(P.UNPACK_ALIGNMENT,G.unpackAlignment),F.isDataTexture)P.texSubImage2D(P.TEXTURE_2D,H,A.x,A.y,k,Me,Pe,Ue,F.image.data);else if(F.isCompressedTexture)P.compressedTexSubImage2D(P.TEXTURE_2D,H,A.x,A.y,F.mipmaps[0].width,F.mipmaps[0].height,Pe,F.mipmaps[0].data);else P.texSubImage2D(P.TEXTURE_2D,H,A.x,A.y,Pe,Ue,F.image);if(H===0&&G.generateMipmaps)P.generateMipmap(P.TEXTURE_2D);Z.unbindTexture()},this.copyTextureToTexture3D=function(A,F,G,H,k=0){if(x.isWebGL1Renderer){console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: can only be used with WebGL2.");return}let Me=A.max.x-A.min.x+1,Pe=A.max.y-A.min.y+1,Ue=A.max.z-A.min.z+1,Be=le.convert(H.format),Ye=le.convert(H.type),He;if(H.isData3DTexture)be.setTexture3D(H,0),He=P.TEXTURE_3D;else if(H.isDataArrayTexture||H.isCompressedArrayTexture)be.setTexture2DArray(H,0),He=P.TEXTURE_2D_ARRAY;else{console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: only supports THREE.DataTexture3D and THREE.DataTexture2DArray.");return}P.pixelStorei(P.UNPACK_FLIP_Y_WEBGL,H.flipY),P.pixelStorei(P.UNPACK_PREMULTIPLY_ALPHA_WEBGL,H.premultiplyAlpha),P.pixelStorei(P.UNPACK_ALIGNMENT,H.unpackAlignment);let We=P.getParameter(P.UNPACK_ROW_LENGTH),pt=P.getParameter(P.UNPACK_IMAGE_HEIGHT),Gt=P.getParameter(P.UNPACK_SKIP_PIXELS),bt=P.getParameter(P.UNPACK_SKIP_ROWS),fn=P.getParameter(P.UNPACK_SKIP_IMAGES),lt=G.isCompressedTexture?G.mipmaps[k]:G.image;if(P.pixelStorei(P.UNPACK_ROW_LENGTH,lt.width),P.pixelStorei(P.UNPACK_IMAGE_HEIGHT,lt.height),P.pixelStorei(P.UNPACK_SKIP_PIXELS,A.min.x),P.pixelStorei(P.UNPACK_SKIP_ROWS,A.min.y),P.pixelStorei(P.UNPACK_SKIP_IMAGES,A.min.z),G.isDataTexture||G.isData3DTexture)P.texSubImage3D(He,k,F.x,F.y,F.z,Me,Pe,Ue,Be,Ye,lt.data);else if(G.isCompressedArrayTexture)console.warn("THREE.WebGLRenderer.copyTextureToTexture3D: untested support for compressed srcTexture."),P.compressedTexSubImage3D(He,k,F.x,F.y,F.z,Me,Pe,Ue,Be,lt.data);else P.texSubImage3D(He,k,F.x,F.y,F.z,Me,Pe,Ue,Be,Ye,lt);if(P.pixelStorei(P.UNPACK_ROW_LENGTH,We),P.pixelStorei(P.UNPACK_IMAGE_HEIGHT,pt),P.pixelStorei(P.UNPACK_SKIP_PIXELS,Gt),P.pixelStorei(P.UNPACK_SKIP_ROWS,bt),P.pixelStorei(P.UNPACK_SKIP_IMAGES,fn),k===0&&H.generateMipmaps)P.generateMipmap(He);Z.unbindTexture()},this.initTexture=function(A){if(A.isCubeTexture)be.setTextureCube(A,0);else if(A.isData3DTexture)be.setTexture3D(A,0);else if(A.isDataArrayTexture||A.isCompressedArrayTexture)be.setTexture2DArray(A,0);else be.setTexture2D(A,0);Z.unbindTexture()},this.resetState=function(){b=0,R=0,M=null,Z.reset(),_e.reset()},typeof __THREE_DEVTOOLS__<"u")__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}get coordinateSystem(){return 2000}get outputColorSpace(){return this._outputColorSpace}set outputColorSpace(e){this._outputColorSpace=e;let t=this.getContext();t.drawingBufferColorSpace=e==="display-p3"?"display-p3":"srgb",t.unpackColorSpace=nt.workingColorSpace==="display-p3-linear"?"display-p3":"srgb"}get outputEncoding(){return console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace==="srgb"?3001:3000}set outputEncoding(e){console.warn("THREE.WebGLRenderer: Property .outputEncoding has been removed. Use .outputColorSpace instead."),this.outputColorSpace=e===3001?"srgb":"srgb-linear"}get useLegacyLights(){return console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights}set useLegacyLights(e){console.warn("THREE.WebGLRenderer: The property .useLegacyLights has been deprecated. Migrate your lighting according to the following guide: https://discourse.threejs.org/t/updates-to-lighting-in-three-js-r155/53733."),this._useLegacyLights=e}}class xh extends _h{}xh.prototype.isWebGL1Renderer=!0;class uo{constructor(e,t=0.00025){this.isFogExp2=!0,this.name="",this.color=new ue(e),this.density=t}clone(){return new uo(this.color,this.density)}toJSON(){return{type:"FogExp2",name:this.name,color:this.color.getHex(),density:this.density}}}class fo{constructor(e,t=1,n=1000){this.isFog=!0,this.name="",this.color=new ue(e),this.near=t,this.far=n}clone(){return new fo(this.color,this.near,this.far)}toJSON(){return{type:"Fog",name:this.name,color:this.color.getHex(),near:this.near,far:this.far}}}class zr extends et{constructor(){super();if(this.isScene=!0,this.type="Scene",this.background=null,this.environment=null,this.fog=null,this.backgroundBlurriness=0,this.backgroundIntensity=1,this.overrideMaterial=null,typeof __THREE_DEVTOOLS__<"u")__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("observe",{detail:this}))}copy(e,t){if(super.copy(e,t),e.background!==null)this.background=e.background.clone();if(e.environment!==null)this.environment=e.environment.clone();if(e.fog!==null)this.fog=e.fog.clone();if(this.backgroundBlurriness=e.backgroundBlurriness,this.backgroundIntensity=e.backgroundIntensity,e.overrideMaterial!==null)this.overrideMaterial=e.overrideMaterial.clone();return this.matrixAutoUpdate=e.matrixAutoUpdate,this}toJSON(e){let t=super.toJSON(e);if(this.fog!==null)t.object.fog=this.fog.toJSON();if(this.backgroundBlurriness>0)t.object.backgroundBlurriness=this.backgroundBlurriness;if(this.backgroundIntensity!==1)t.object.backgroundIntensity=this.backgroundIntensity;return t}}class fi{constructor(e,t){this.isInterleavedBuffer=!0,this.array=e,this.stride=t,this.count=e!==void 0?e.length/t:0,this.usage=35044,this._updateRange={offset:0,count:-1},this.updateRanges=[],this.version=0,this.uuid=Xt()}onUploadCallback(){}set needsUpdate(e){if(e===!0)this.version++}get updateRange(){return console.warn("THREE.InterleavedBuffer: updateRange() is deprecated and will be removed in r169. Use addUpdateRange() instead."),this._updateRange}setUsage(e){return this.usage=e,this}addUpdateRange(e,t){this.updateRanges.push({start:e,count:t})}clearUpdateRanges(){this.updateRanges.length=0}copy(e){return this.array=new e.array.constructor(e.array),this.count=e.count,this.stride=e.stride,this.usage=e.usage,this}copyAt(e,t,n){e*=this.stride,n*=t.stride;for(let i=0,s=this.stride;i<s;i++)this.array[e+i]=t.array[n+i];return this}set(e,t=0){return this.array.set(e,t),this}clone(e){if(e.arrayBuffers===void 0)e.arrayBuffers={};if(this.array.buffer._uuid===void 0)this.array.buffer._uuid=Xt();if(e.arrayBuffers[this.array.buffer._uuid]===void 0)e.arrayBuffers[this.array.buffer._uuid]=this.array.slice(0).buffer;let t=new this.array.constructor(e.arrayBuffers[this.array.buffer._uuid]),n=new this.constructor(t,this.stride);return n.setUsage(this.usage),n}onUpload(e){return this.onUploadCallback=e,this}toJSON(e){if(e.arrayBuffers===void 0)e.arrayBuffers={};if(this.array.buffer._uuid===void 0)this.array.buffer._uuid=Xt();if(e.arrayBuffers[this.array.buffer._uuid]===void 0)e.arrayBuffers[this.array.buffer._uuid]=Array.from(new Uint32Array(this.array.buffer));return{uuid:this.uuid,buffer:this.array.buffer._uuid,type:this.array.constructor.name,stride:this.stride}}}var Ot=new T;class Mn{constructor(e,t,n,i=!1){this.isInterleavedBufferAttribute=!0,this.name="",this.data=e,this.itemSize=t,this.offset=n,this.normalized=i}get count(){return this.data.count}get array(){return this.data.array}set needsUpdate(e){this.data.needsUpdate=e}applyMatrix4(e){for(let t=0,n=this.data.count;t<n;t++)Ot.fromBufferAttribute(this,t),Ot.applyMatrix4(e),this.setXYZ(t,Ot.x,Ot.y,Ot.z);return this}applyNormalMatrix(e){for(let t=0,n=this.count;t<n;t++)Ot.fromBufferAttribute(this,t),Ot.applyNormalMatrix(e),this.setXYZ(t,Ot.x,Ot.y,Ot.z);return this}transformDirection(e){for(let t=0,n=this.count;t<n;t++)Ot.fromBufferAttribute(this,t),Ot.transformDirection(e),this.setXYZ(t,Ot.x,Ot.y,Ot.z);return this}setX(e,t){if(this.normalized)t=Ve(t,this.array);return this.data.array[e*this.data.stride+this.offset]=t,this}setY(e,t){if(this.normalized)t=Ve(t,this.array);return this.data.array[e*this.data.stride+this.offset+1]=t,this}setZ(e,t){if(this.normalized)t=Ve(t,this.array);return this.data.array[e*this.data.stride+this.offset+2]=t,this}setW(e,t){if(this.normalized)t=Ve(t,this.array);return this.data.array[e*this.data.stride+this.offset+3]=t,this}getX(e){let t=this.data.array[e*this.data.stride+this.offset];if(this.normalized)t=kt(t,this.array);return t}getY(e){let t=this.data.array[e*this.data.stride+this.offset+1];if(this.normalized)t=kt(t,this.array);return t}getZ(e){let t=this.data.array[e*this.data.stride+this.offset+2];if(this.normalized)t=kt(t,this.array);return t}getW(e){let t=this.data.array[e*this.data.stride+this.offset+3];if(this.normalized)t=kt(t,this.array);return t}setXY(e,t,n){if(e=e*this.data.stride+this.offset,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array);return this.data.array[e+0]=t,this.data.array[e+1]=n,this}setXYZ(e,t,n,i){if(e=e*this.data.stride+this.offset,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array);return this.data.array[e+0]=t,this.data.array[e+1]=n,this.data.array[e+2]=i,this}setXYZW(e,t,n,i,s){if(e=e*this.data.stride+this.offset,this.normalized)t=Ve(t,this.array),n=Ve(n,this.array),i=Ve(i,this.array),s=Ve(s,this.array);return this.data.array[e+0]=t,this.data.array[e+1]=n,this.data.array[e+2]=i,this.data.array[e+3]=s,this}clone(e){if(e===void 0){console.log("THREE.InterleavedBufferAttribute.clone(): Cloning an interleaved buffer attribute will de-interleave buffer data.");let t=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[i+s])}return new tt(new this.array.constructor(t),this.itemSize,this.normalized)}else{if(e.interleavedBuffers===void 0)e.interleavedBuffers={};if(e.interleavedBuffers[this.data.uuid]===void 0)e.interleavedBuffers[this.data.uuid]=this.data.clone(e);return new Mn(e.interleavedBuffers[this.data.uuid],this.itemSize,this.offset,this.normalized)}}toJSON(e){if(e===void 0){console.log("THREE.InterleavedBufferAttribute.toJSON(): Serializing an interleaved buffer attribute will de-interleave buffer data.");let t=[];for(let n=0;n<this.count;n++){let i=n*this.data.stride+this.offset;for(let s=0;s<this.itemSize;s++)t.push(this.data.array[i+s])}return{itemSize:this.itemSize,type:this.array.constructor.name,array:t,normalized:this.normalized}}else{if(e.interleavedBuffers===void 0)e.interleavedBuffers={};if(e.interleavedBuffers[this.data.uuid]===void 0)e.interleavedBuffers[this.data.uuid]=this.data.toJSON(e);return{isInterleavedBufferAttribute:!0,itemSize:this.itemSize,data:this.data.uuid,offset:this.offset,normalized:this.normalized}}}}class po extends xt{constructor(e){super();this.isSpriteMaterial=!0,this.type="SpriteMaterial",this.color=new ue(16777215),this.map=null,this.alphaMap=null,this.rotation=0,this.sizeAttenuation=!0,this.transparent=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.rotation=e.rotation,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}}var Ui,as=new T,Fi=new T,Oi=new T,Bi=new W,os=new W,vh=new De,ir=new T,ls=new T,sr=new T,Hl=new W,La=new W,Wl=new W;class yh extends et{constructor(e=new po){super();if(this.isSprite=!0,this.type="Sprite",Ui===void 0){Ui=new ze;let t=new Float32Array([-0.5,-0.5,0,0,0,0.5,-0.5,0,1,0,0.5,0.5,0,1,1,-0.5,0.5,0,0,1]),n=new fi(t,5);Ui.setIndex([0,1,2,0,2,3]),Ui.setAttribute("position",new Mn(n,3,0,!1)),Ui.setAttribute("uv",new Mn(n,2,3,!1))}this.geometry=Ui,this.material=e,this.center=new W(0.5,0.5)}raycast(e,t){if(e.camera===null)console.error('THREE.Sprite: "Raycaster.camera" needs to be set in order to raycast against sprites.');if(Fi.setFromMatrixScale(this.matrixWorld),vh.copy(e.camera.matrixWorld),this.modelViewMatrix.multiplyMatrices(e.camera.matrixWorldInverse,this.matrixWorld),Oi.setFromMatrixPosition(this.modelViewMatrix),e.camera.isPerspectiveCamera&&this.material.sizeAttenuation===!1)Fi.multiplyScalar(-Oi.z);let n=this.material.rotation,i,s;if(n!==0)s=Math.cos(n),i=Math.sin(n);let r=this.center;rr(ir.set(-0.5,-0.5,0),Oi,r,Fi,i,s),rr(ls.set(0.5,-0.5,0),Oi,r,Fi,i,s),rr(sr.set(0.5,0.5,0),Oi,r,Fi,i,s),Hl.set(0,0),La.set(1,0),Wl.set(1,1);let a=e.ray.intersectTriangle(ir,ls,sr,!1,as);if(a===null){if(rr(ls.set(-0.5,0.5,0),Oi,r,Fi,i,s),La.set(0,1),a=e.ray.intersectTriangle(ir,sr,ls,!1,as),a===null)return}let o=e.ray.origin.distanceTo(as);if(o<e.near||o>e.far)return;t.push({distance:o,point:as.clone(),uv:Vt.getInterpolation(as,ir,ls,sr,Hl,La,Wl,new W),face:null,object:this})}copy(e,t){if(super.copy(e,t),e.center!==void 0)this.center.copy(e.center);return this.material=e.material,this}}function rr(e,t,n,i,s,r){if(Bi.subVectors(e,n).addScalar(0.5).multiply(i),s!==void 0)os.x=r*Bi.x-s*Bi.y,os.y=s*Bi.x+r*Bi.y;else os.copy(Bi);e.copy(t),e.x+=os.x,e.y+=os.y,e.applyMatrix4(vh)}var ar=new T,Vl=new T;class Sh extends et{constructor(){super();this._currentLevel=0,this.type="LOD",Object.defineProperties(this,{levels:{enumerable:!0,value:[]},isLOD:{value:!0}}),this.autoUpdate=!0}copy(e){super.copy(e,!1);let t=e.levels;for(let n=0,i=t.length;n<i;n++){let s=t[n];this.addLevel(s.object.clone(),s.distance,s.hysteresis)}return this.autoUpdate=e.autoUpdate,this}addLevel(e,t=0,n=0){t=Math.abs(t);let i=this.levels,s;for(s=0;s<i.length;s++)if(t<i[s].distance)break;return i.splice(s,0,{distance:t,hysteresis:n,object:e}),this.add(e),this}getCurrentLevel(){return this._currentLevel}getObjectForDistance(e){let t=this.levels;if(t.length>0){let n,i;for(n=1,i=t.length;n<i;n++){let s=t[n].distance;if(t[n].object.visible)s-=s*t[n].hysteresis;if(e<s)break}return t[n-1].object}return null}raycast(e,t){if(this.levels.length>0){ar.setFromMatrixPosition(this.matrixWorld);let i=e.ray.origin.distanceTo(ar);this.getObjectForDistance(i).raycast(e,t)}}update(e){let t=this.levels;if(t.length>1){ar.setFromMatrixPosition(e.matrixWorld),Vl.setFromMatrixPosition(this.matrixWorld);let n=ar.distanceTo(Vl)/e.zoom;t[0].object.visible=!0;let i,s;for(i=1,s=t.length;i<s;i++){let r=t[i].distance;if(t[i].object.visible)r-=r*t[i].hysteresis;if(n>=r)t[i-1].object.visible=!1,t[i].object.visible=!0;else break}this._currentLevel=i-1;for(;i<s;i++)t[i].object.visible=!1}}toJSON(e){let t=super.toJSON(e);if(this.autoUpdate===!1)t.object.autoUpdate=!1;t.object.levels=[];let n=this.levels;for(let i=0,s=n.length;i<s;i++){let r=n[i];t.object.levels.push({object:r.object.uuid,distance:r.distance,hysteresis:r.hysteresis})}return t}}var Xl=new T,ql=new at,Yl=new at,x_=new T,Zl=new De,or=new T,Ia=new At,Kl=new De,Na=new On;class kr extends Je{constructor(e,t){super(e,t);this.isSkinnedMesh=!0,this.type="SkinnedMesh",this.bindMode="attached",this.bindMatrix=new De,this.bindMatrixInverse=new De,this.boundingBox=null,this.boundingSphere=null}computeBoundingBox(){let e=this.geometry;if(this.boundingBox===null)this.boundingBox=new Rt;this.boundingBox.makeEmpty();let t=e.getAttribute("position");for(let n=0;n<t.count;n++)this.getVertexPosition(n,or),this.boundingBox.expandByPoint(or)}computeBoundingSphere(){let e=this.geometry;if(this.boundingSphere===null)this.boundingSphere=new At;this.boundingSphere.makeEmpty();let t=e.getAttribute("position");for(let n=0;n<t.count;n++)this.getVertexPosition(n,or),this.boundingSphere.expandByPoint(or)}copy(e,t){if(super.copy(e,t),this.bindMode=e.bindMode,this.bindMatrix.copy(e.bindMatrix),this.bindMatrixInverse.copy(e.bindMatrixInverse),this.skeleton=e.skeleton,e.boundingBox!==null)this.boundingBox=e.boundingBox.clone();if(e.boundingSphere!==null)this.boundingSphere=e.boundingSphere.clone();return this}raycast(e,t){let n=this.material,i=this.matrixWorld;if(n===void 0)return;if(this.boundingSphere===null)this.computeBoundingSphere();if(Ia.copy(this.boundingSphere),Ia.applyMatrix4(i),e.ray.intersectsSphere(Ia)===!1)return;if(Kl.copy(i).invert(),Na.copy(e.ray).applyMatrix4(Kl),this.boundingBox!==null){if(Na.intersectsBox(this.boundingBox)===!1)return}this._computeIntersections(e,t,Na)}getVertexPosition(e,t){return super.getVertexPosition(e,t),this.applyBoneTransform(e,t),t}bind(e,t){if(this.skeleton=e,t===void 0)this.updateMatrixWorld(!0),this.skeleton.calculateInverses(),t=this.matrixWorld;this.bindMatrix.copy(t),this.bindMatrixInverse.copy(t).invert()}pose(){this.skeleton.pose()}normalizeSkinWeights(){let e=new at,t=this.geometry.attributes.skinWeight;for(let n=0,i=t.count;n<i;n++){e.fromBufferAttribute(t,n);let s=1/e.manhattanLength();if(s!==1/0)e.multiplyScalar(s);else e.set(1,0,0,0);t.setXYZW(n,e.x,e.y,e.z,e.w)}}updateMatrixWorld(e){if(super.updateMatrixWorld(e),this.bindMode==="attached")this.bindMatrixInverse.copy(this.matrixWorld).invert();else if(this.bindMode==="detached")this.bindMatrixInverse.copy(this.bindMatrix).invert();else console.warn("THREE.SkinnedMesh: Unrecognized bindMode: "+this.bindMode)}applyBoneTransform(e,t){let n=this.skeleton,i=this.geometry;ql.fromBufferAttribute(i.attributes.skinIndex,e),Yl.fromBufferAttribute(i.attributes.skinWeight,e),Xl.copy(t).applyMatrix4(this.bindMatrix),t.set(0,0,0);for(let s=0;s<4;s++){let r=Yl.getComponent(s);if(r!==0){let a=ql.getComponent(s);Zl.multiplyMatrices(n.bones[a].matrixWorld,n.boneInverses[a]),t.addScaledVector(x_.copy(Xl).applyMatrix4(Zl),r)}}return t.applyMatrix4(this.bindMatrixInverse)}boneTransform(e,t){return console.warn("THREE.SkinnedMesh: .boneTransform() was renamed to .applyBoneTransform() in r151."),this.applyBoneTransform(e,t)}}class Rs extends et{constructor(){super();this.isBone=!0,this.type="Bone"}}class oi extends ht{constructor(e=null,t=1,n=1,i,s,r,a,o,l=1003,c=1003,h,u){super(null,r,a,o,l,c,i,s,h,u);this.isDataTexture=!0,this.image={data:e,width:t,height:n},this.generateMipmaps=!1,this.flipY=!1,this.unpackAlignment=1}}var Jl=new De,v_=new De;class Cs{constructor(e=[],t=[]){this.uuid=Xt(),this.bones=e.slice(0),this.boneInverses=t,this.boneMatrices=null,this.boneTexture=null,this.init()}init(){let e=this.bones,t=this.boneInverses;if(this.boneMatrices=new Float32Array(e.length*16),t.length===0)this.calculateInverses();else if(e.length!==t.length){console.warn("THREE.Skeleton: Number of inverse bone matrices does not match amount of bones."),this.boneInverses=[];for(let n=0,i=this.bones.length;n<i;n++)this.boneInverses.push(new De)}}calculateInverses(){this.boneInverses.length=0;for(let e=0,t=this.bones.length;e<t;e++){let n=new De;if(this.bones[e])n.copy(this.bones[e].matrixWorld).invert();this.boneInverses.push(n)}}pose(){for(let e=0,t=this.bones.length;e<t;e++){let n=this.bones[e];if(n)n.matrixWorld.copy(this.boneInverses[e]).invert()}for(let e=0,t=this.bones.length;e<t;e++){let n=this.bones[e];if(n){if(n.parent&&n.parent.isBone)n.matrix.copy(n.parent.matrixWorld).invert(),n.matrix.multiply(n.matrixWorld);else n.matrix.copy(n.matrixWorld);n.matrix.decompose(n.position,n.quaternion,n.scale)}}}update(){let e=this.bones,t=this.boneInverses,n=this.boneMatrices,i=this.boneTexture;for(let s=0,r=e.length;s<r;s++){let a=e[s]?e[s].matrixWorld:v_;Jl.multiplyMatrices(a,t[s]),Jl.toArray(n,s*16)}if(i!==null)i.needsUpdate=!0}clone(){return new Cs(this.bones,this.boneInverses)}computeBoneTexture(){let e=Math.sqrt(this.bones.length*4);e=Math.ceil(e/4)*4,e=Math.max(e,4);let t=new Float32Array(e*e*4);t.set(this.boneMatrices);let n=new oi(t,e,e,1023,1015);return n.needsUpdate=!0,this.boneMatrices=t,this.boneTexture=n,this}getBoneByName(e){for(let t=0,n=this.bones.length;t<n;t++){let i=this.bones[t];if(i.name===e)return i}return}dispose(){if(this.boneTexture!==null)this.boneTexture.dispose(),this.boneTexture=null}fromJSON(e,t){this.uuid=e.uuid;for(let n=0,i=e.bones.length;n<i;n++){let s=e.bones[n],r=t[s];if(r===void 0)console.warn("THREE.Skeleton: No bone found with UUID:",s),r=new Rs;this.bones.push(r),this.boneInverses.push(new De().fromArray(e.boneInverses[n]))}return this.init(),this}toJSON(){let e={metadata:{version:4.6,type:"Skeleton",generator:"Skeleton.toJSON"},bones:[],boneInverses:[]};e.uuid=this.uuid;let t=this.bones,n=this.boneInverses;for(let i=0,s=t.length;i<s;i++){let r=t[i];e.bones.push(r.uuid);let a=n[i];e.boneInverses.push(a.toArray())}return e}}class bn extends tt{constructor(e,t,n,i=1){super(e,t,n);this.isInstancedBufferAttribute=!0,this.meshPerAttribute=i}copy(e){return super.copy(e),this.meshPerAttribute=e.meshPerAttribute,this}toJSON(){let e=super.toJSON();return e.meshPerAttribute=this.meshPerAttribute,e.isInstancedBufferAttribute=!0,e}}var zi=new De,$l=new De,lr=[],jl=new Rt,y_=new De,cs=new Je,hs=new At;class Gr extends Je{constructor(e,t,n){super(e,t);this.isInstancedMesh=!0,this.instanceMatrix=new bn(new Float32Array(n*16),16),this.instanceColor=null,this.count=n,this.boundingBox=null,this.boundingSphere=null;for(let i=0;i<n;i++)this.setMatrixAt(i,y_)}computeBoundingBox(){let e=this.geometry,t=this.count;if(this.boundingBox===null)this.boundingBox=new Rt;if(e.boundingBox===null)e.computeBoundingBox();this.boundingBox.makeEmpty();for(let n=0;n<t;n++)this.getMatrixAt(n,zi),jl.copy(e.boundingBox).applyMatrix4(zi),this.boundingBox.union(jl)}computeBoundingSphere(){let e=this.geometry,t=this.count;if(this.boundingSphere===null)this.boundingSphere=new At;if(e.boundingSphere===null)e.computeBoundingSphere();this.boundingSphere.makeEmpty();for(let n=0;n<t;n++)this.getMatrixAt(n,zi),hs.copy(e.boundingSphere).applyMatrix4(zi),this.boundingSphere.union(hs)}copy(e,t){if(super.copy(e,t),this.instanceMatrix.copy(e.instanceMatrix),e.instanceColor!==null)this.instanceColor=e.instanceColor.clone();if(this.count=e.count,e.boundingBox!==null)this.boundingBox=e.boundingBox.clone();if(e.boundingSphere!==null)this.boundingSphere=e.boundingSphere.clone();return this}getColorAt(e,t){t.fromArray(this.instanceColor.array,e*3)}getMatrixAt(e,t){t.fromArray(this.instanceMatrix.array,e*16)}raycast(e,t){let n=this.matrixWorld,i=this.count;if(cs.geometry=this.geometry,cs.material=this.material,cs.material===void 0)return;if(this.boundingSphere===null)this.computeBoundingSphere();if(hs.copy(this.boundingSphere),hs.applyMatrix4(n),e.ray.intersectsSphere(hs)===!1)return;for(let s=0;s<i;s++){this.getMatrixAt(s,zi),$l.multiplyMatrices(n,zi),cs.matrixWorld=$l,cs.raycast(e,lr);for(let r=0,a=lr.length;r<a;r++){let o=lr[r];o.instanceId=s,o.object=this,t.push(o)}lr.length=0}}setColorAt(e,t){if(this.instanceColor===null)this.instanceColor=new bn(new Float32Array(this.instanceMatrix.count*3),3);t.toArray(this.instanceColor.array,e*3)}setMatrixAt(e,t){t.toArray(this.instanceMatrix.array,e*16)}updateMorphTargets(){}dispose(){this.dispatchEvent({type:"dispose"})}}function S_(e,t){return e.z-t.z}function M_(e,t){return t.z-e.z}class Mh{constructor(){this.index=0,this.pool=[],this.list=[]}push(e,t){let n=this.pool,i=this.list;if(this.index>=n.length)n.push({start:-1,count:-1,z:-1});let s=n[this.index];i.push(s),this.index++,s.start=e.start,s.count=e.count,s.z=t}reset(){this.list.length=0,this.index=0}}var ki="batchId",In=new De,Ql=new De,b_=new De,ec=new De,Da=new ws,cr=new Rt,Jn=new At,us=new T,Ua=new Mh,Dt=new Je,hr=[];function T_(e,t,n=0){let i=t.itemSize;if(e.isInterleavedBufferAttribute||e.array.constructor!==t.array.constructor){let s=e.count;for(let r=0;r<s;r++)for(let a=0;a<i;a++)t.setComponent(r+n,a,e.getComponent(r,a))}else t.array.set(e.array,n*i);t.needsUpdate=!0}class bh extends Je{get maxGeometryCount(){return this._maxGeometryCount}constructor(e,t,n=t*2,i){super(new ze,i);this.isBatchedMesh=!0,this.perObjectFrustumCulled=!0,this.sortObjects=!0,this.boundingBox=null,this.boundingSphere=null,this.customSort=null,this._drawRanges=[],this._reservedRanges=[],this._visibility=[],this._active=[],this._bounds=[],this._maxGeometryCount=e,this._maxVertexCount=t,this._maxIndexCount=n,this._geometryInitialized=!1,this._geometryCount=0,this._multiDrawCounts=new Int32Array(e),this._multiDrawStarts=new Int32Array(e),this._multiDrawCount=0,this._visibilityChanged=!0,this._matricesTexture=null,this._initMatricesTexture()}_initMatricesTexture(){let e=Math.sqrt(this._maxGeometryCount*4);e=Math.ceil(e/4)*4,e=Math.max(e,4);let t=new Float32Array(e*e*4),n=new oi(t,e,e,1023,1015);this._matricesTexture=n}_initializeGeometry(e){let t=this.geometry,n=this._maxVertexCount,i=this._maxGeometryCount,s=this._maxIndexCount;if(this._geometryInitialized===!1){for(let a in e.attributes){let o=e.getAttribute(a),{array:l,itemSize:c,normalized:h}=o,u=new l.constructor(n*c),d=new o.constructor(u,c,h);d.setUsage(o.usage),t.setAttribute(a,d)}if(e.getIndex()!==null){let a=n>65536?new Uint32Array(s):new Uint16Array(s);t.setIndex(new tt(a,1))}let r=i>65536?new Uint32Array(n):new Uint16Array(n);t.setAttribute(ki,new tt(r,1)),this._geometryInitialized=!0}}_validateGeometry(e){if(e.getAttribute(ki))throw Error(`BatchedMesh: Geometry cannot use attribute "${ki}"`);let t=this.geometry;if(Boolean(e.getIndex())!==Boolean(t.getIndex()))throw Error('BatchedMesh: All geometries must consistently have "index".');for(let n in t.attributes){if(n===ki)continue;if(!e.hasAttribute(n))throw Error(`BatchedMesh: Added geometry missing "${n}". All geometries must have consistent attributes.`);let i=e.getAttribute(n),s=t.getAttribute(n);if(i.itemSize!==s.itemSize||i.normalized!==s.normalized)throw Error("BatchedMesh: All attributes must have a consistent itemSize and normalized value.")}}setCustomSort(e){return this.customSort=e,this}computeBoundingBox(){if(this.boundingBox===null)this.boundingBox=new Rt;let e=this._geometryCount,t=this.boundingBox,n=this._active;t.makeEmpty();for(let i=0;i<e;i++){if(n[i]===!1)continue;this.getMatrixAt(i,In),this.getBoundingBoxAt(i,cr).applyMatrix4(In),t.union(cr)}}computeBoundingSphere(){if(this.boundingSphere===null)this.boundingSphere=new At;let e=this._geometryCount,t=this.boundingSphere,n=this._active;t.makeEmpty();for(let i=0;i<e;i++){if(n[i]===!1)continue;this.getMatrixAt(i,In),this.getBoundingSphereAt(i,Jn).applyMatrix4(In),t.union(Jn)}}addGeometry(e,t=-1,n=-1){if(this._initializeGeometry(e),this._validateGeometry(e),this._geometryCount>=this._maxGeometryCount)throw Error("BatchedMesh: Maximum geometry count reached.");let i={vertexStart:-1,vertexCount:-1,indexStart:-1,indexCount:-1},s=null,r=this._reservedRanges,a=this._drawRanges,o=this._bounds;if(this._geometryCount!==0)s=r[r.length-1];if(t===-1)i.vertexCount=e.getAttribute("position").count;else i.vertexCount=t;if(s===null)i.vertexStart=0;else i.vertexStart=s.vertexStart+s.vertexCount;let l=e.getIndex(),c=l!==null;if(c){if(n===-1)i.indexCount=l.count;else i.indexCount=n;if(s===null)i.indexStart=0;else i.indexStart=s.indexStart+s.indexCount}if(i.indexStart!==-1&&i.indexStart+i.indexCount>this._maxIndexCount||i.vertexStart+i.vertexCount>this._maxVertexCount)throw Error("BatchedMesh: Reserved space request exceeds the maximum buffer size.");let h=this._visibility,u=this._active,d=this._matricesTexture,f=this._matricesTexture.image.data;h.push(!0),u.push(!0);let g=this._geometryCount;this._geometryCount++,b_.toArray(f,g*16),d.needsUpdate=!0,r.push(i),a.push({start:c?i.indexStart:i.vertexStart,count:-1}),o.push({boxInitialized:!1,box:new Rt,sphereInitialized:!1,sphere:new At});let _=this.geometry.getAttribute(ki);for(let m=0;m<i.vertexCount;m++)_.setX(i.vertexStart+m,g);return _.needsUpdate=!0,this.setGeometryAt(g,e),g}setGeometryAt(e,t){if(e>=this._geometryCount)throw Error("BatchedMesh: Maximum geometry count reached.");this._validateGeometry(t);let n=this.geometry,i=n.getIndex()!==null,s=n.getIndex(),r=t.getIndex(),a=this._reservedRanges[e];if(i&&r.count>a.indexCount||t.attributes.position.count>a.vertexCount)throw Error("BatchedMesh: Reserved space not large enough for provided geometry.");let{vertexStart:o,vertexCount:l}=a;for(let d in n.attributes){if(d===ki)continue;let f=t.getAttribute(d),g=n.getAttribute(d);T_(f,g,o);let _=f.itemSize;for(let m=f.count,p=l;m<p;m++){let x=o+m;for(let v=0;v<_;v++)g.setComponent(x,v,0)}g.needsUpdate=!0}if(i){let d=a.indexStart;for(let f=0;f<r.count;f++)s.setX(d+f,o+r.getX(f));for(let f=r.count,g=a.indexCount;f<g;f++)s.setX(d+f,o);s.needsUpdate=!0}let c=this._bounds[e];if(t.boundingBox!==null)c.box.copy(t.boundingBox),c.boxInitialized=!0;else c.boxInitialized=!1;if(t.boundingSphere!==null)c.sphere.copy(t.boundingSphere),c.sphereInitialized=!0;else c.sphereInitialized=!1;let h=this._drawRanges[e],u=t.getAttribute("position");return h.count=i?r.count:u.count,this._visibilityChanged=!0,e}deleteGeometry(e){let t=this._active;if(e>=t.length||t[e]===!1)return this;return t[e]=!1,this._visibilityChanged=!0,this}getBoundingBoxAt(e,t){if(this._active[e]===!1)return this;let i=this._bounds[e],s=i.box,r=this.geometry;if(i.boxInitialized===!1){s.makeEmpty();let a=r.index,o=r.attributes.position,l=this._drawRanges[e];for(let c=l.start,h=l.start+l.count;c<h;c++){let u=c;if(a)u=a.getX(u);s.expandByPoint(us.fromBufferAttribute(o,u))}i.boxInitialized=!0}return t.copy(s),t}getBoundingSphereAt(e,t){if(this._active[e]===!1)return this;let i=this._bounds[e],s=i.sphere,r=this.geometry;if(i.sphereInitialized===!1){s.makeEmpty(),this.getBoundingBoxAt(e,cr),cr.getCenter(s.center);let a=r.index,o=r.attributes.position,l=this._drawRanges[e],c=0;for(let h=l.start,u=l.start+l.count;h<u;h++){let d=h;if(a)d=a.getX(d);us.fromBufferAttribute(o,d),c=Math.max(c,s.center.distanceToSquared(us))}s.radius=Math.sqrt(c),i.sphereInitialized=!0}return t.copy(s),t}setMatrixAt(e,t){let n=this._active,i=this._matricesTexture,s=this._matricesTexture.image.data,r=this._geometryCount;if(e>=r||n[e]===!1)return this;return t.toArray(s,e*16),i.needsUpdate=!0,this}getMatrixAt(e,t){let n=this._active,i=this._matricesTexture.image.data,s=this._geometryCount;if(e>=s||n[e]===!1)return null;return t.fromArray(i,e*16)}setVisibleAt(e,t){let n=this._visibility,i=this._active,s=this._geometryCount;if(e>=s||i[e]===!1||n[e]===t)return this;return n[e]=t,this._visibilityChanged=!0,this}getVisibleAt(e){let t=this._visibility,n=this._active,i=this._geometryCount;if(e>=i||n[e]===!1)return!1;return t[e]}raycast(e,t){let n=this._visibility,i=this._active,s=this._drawRanges,r=this._geometryCount,a=this.matrixWorld,o=this.geometry;if(Dt.material=this.material,Dt.geometry.index=o.index,Dt.geometry.attributes=o.attributes,Dt.geometry.boundingBox===null)Dt.geometry.boundingBox=new Rt;if(Dt.geometry.boundingSphere===null)Dt.geometry.boundingSphere=new At;for(let l=0;l<r;l++){if(!n[l]||!i[l])continue;let c=s[l];Dt.geometry.setDrawRange(c.start,c.count),this.getMatrixAt(l,Dt.matrixWorld).premultiply(a),this.getBoundingBoxAt(l,Dt.geometry.boundingBox),this.getBoundingSphereAt(l,Dt.geometry.boundingSphere),Dt.raycast(e,hr);for(let h=0,u=hr.length;h<u;h++){let d=hr[h];d.object=this,d.batchId=l,t.push(d)}hr.length=0}Dt.material=null,Dt.geometry.index=null,Dt.geometry.attributes={},Dt.geometry.setDrawRange(0,1/0)}copy(e){return super.copy(e),this.geometry=e.geometry.clone(),this.perObjectFrustumCulled=e.perObjectFrustumCulled,this.sortObjects=e.sortObjects,this.boundingBox=e.boundingBox!==null?e.boundingBox.clone():null,this.boundingSphere=e.boundingSphere!==null?e.boundingSphere.clone():null,this._drawRanges=e._drawRanges.map((t)=>({...t})),this._reservedRanges=e._reservedRanges.map((t)=>({...t})),this._visibility=e._visibility.slice(),this._active=e._active.slice(),this._bounds=e._bounds.map((t)=>({boxInitialized:t.boxInitialized,box:t.box.clone(),sphereInitialized:t.sphereInitialized,sphere:t.sphere.clone()})),this._maxGeometryCount=e._maxGeometryCount,this._maxVertexCount=e._maxVertexCount,this._maxIndexCount=e._maxIndexCount,this._geometryInitialized=e._geometryInitialized,this._geometryCount=e._geometryCount,this._multiDrawCounts=e._multiDrawCounts.slice(),this._multiDrawStarts=e._multiDrawStarts.slice(),this._matricesTexture=e._matricesTexture.clone(),this._matricesTexture.image.data=this._matricesTexture.image.slice(),this}dispose(){return this.geometry.dispose(),this._matricesTexture.dispose(),this._matricesTexture=null,this}onBeforeRender(e,t,n,i,s){if(!this._visibilityChanged&&!this.perObjectFrustumCulled&&!this.sortObjects)return;let r=i.getIndex(),a=r===null?1:r.array.BYTES_PER_ELEMENT,o=this._visibility,l=this._multiDrawStarts,c=this._multiDrawCounts,h=this._drawRanges,u=this.perObjectFrustumCulled;if(u)ec.multiplyMatrices(n.projectionMatrix,n.matrixWorldInverse).multiply(this.matrixWorld),Da.setFromProjectionMatrix(ec,e.isWebGPURenderer?2001:2000);let d=0;if(this.sortObjects){Ql.copy(this.matrixWorld).invert(),us.setFromMatrixPosition(n.matrixWorld).applyMatrix4(Ql);for(let _=0,m=o.length;_<m;_++)if(o[_]){this.getMatrixAt(_,In),this.getBoundingSphereAt(_,Jn).applyMatrix4(In);let p=!1;if(u)p=!Da.intersectsSphere(Jn);if(!p){let x=us.distanceTo(Jn.center);Ua.push(h[_],x)}}let f=Ua.list,g=this.customSort;if(g===null)f.sort(s.transparent?M_:S_);else g.call(this,f,n);for(let _=0,m=f.length;_<m;_++){let p=f[_];l[d]=p.start*a,c[d]=p.count,d++}Ua.reset()}else for(let f=0,g=o.length;f<g;f++)if(o[f]){let _=!1;if(u)this.getMatrixAt(f,In),this.getBoundingSphereAt(f,Jn).applyMatrix4(In),_=!Da.intersectsSphere(Jn);if(!_){let m=h[f];l[d]=m.start*a,c[d]=m.count,d++}}this._multiDrawCount=d,this._visibilityChanged=!1}onBeforeShadow(e,t,n,i,s,r){this.onBeforeRender(e,null,i,s,r)}}class Pt extends xt{constructor(e){super();this.isLineBasicMaterial=!0,this.type="LineBasicMaterial",this.color=new ue(16777215),this.map=null,this.linewidth=1,this.linecap="round",this.linejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.linewidth=e.linewidth,this.linecap=e.linecap,this.linejoin=e.linejoin,this.fog=e.fog,this}}var tc=new T,nc=new T,ic=new De,Fa=new On,ur=new At;class un extends et{constructor(e=new ze,t=new Pt){super();this.isLine=!0,this.type="Line",this.geometry=e,this.material=t,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[0];for(let i=1,s=t.count;i<s;i++)tc.fromBufferAttribute(t,i-1),nc.fromBufferAttribute(t,i),n[i]=n[i-1],n[i]+=tc.distanceTo(nc);e.setAttribute("lineDistance",new Ae(n,1))}else console.warn("THREE.Line.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}raycast(e,t){let n=this.geometry,i=this.matrixWorld,s=e.params.Line.threshold,r=n.drawRange;if(n.boundingSphere===null)n.computeBoundingSphere();if(ur.copy(n.boundingSphere),ur.applyMatrix4(i),ur.radius+=s,e.ray.intersectsSphere(ur)===!1)return;ic.copy(i).invert(),Fa.copy(e.ray).applyMatrix4(ic);let a=s/((this.scale.x+this.scale.y+this.scale.z)/3),o=a*a,l=new T,c=new T,h=new T,u=new T,d=this.isLineSegments?2:1,f=n.index,_=n.attributes.position;if(f!==null){let m=Math.max(0,r.start),p=Math.min(f.count,r.start+r.count);for(let x=m,v=p-1;x<v;x+=d){let b=f.getX(x),R=f.getX(x+1);if(l.fromBufferAttribute(_,b),c.fromBufferAttribute(_,R),Fa.distanceSqToSegment(l,c,u,h)>o)continue;u.applyMatrix4(this.matrixWorld);let C=e.ray.origin.distanceTo(u);if(C<e.near||C>e.far)continue;t.push({distance:C,point:h.clone().applyMatrix4(this.matrixWorld),index:x,face:null,faceIndex:null,object:this})}}else{let m=Math.max(0,r.start),p=Math.min(_.count,r.start+r.count);for(let x=m,v=p-1;x<v;x+=d){if(l.fromBufferAttribute(_,x),c.fromBufferAttribute(_,x+1),Fa.distanceSqToSegment(l,c,u,h)>o)continue;u.applyMatrix4(this.matrixWorld);let R=e.ray.origin.distanceTo(u);if(R<e.near||R>e.far)continue;t.push({distance:R,point:h.clone().applyMatrix4(this.matrixWorld),index:x,face:null,faceIndex:null,object:this})}}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let i=t[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,r=i.length;s<r;s++){let a=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}}var sc=new T,rc=new T;class Kt extends un{constructor(e,t){super(e,t);this.isLineSegments=!0,this.type="LineSegments"}computeLineDistances(){let e=this.geometry;if(e.index===null){let t=e.attributes.position,n=[];for(let i=0,s=t.count;i<s;i+=2)sc.fromBufferAttribute(t,i),rc.fromBufferAttribute(t,i+1),n[i]=i===0?0:n[i-1],n[i+1]=n[i]+sc.distanceTo(rc);e.setAttribute("lineDistance",new Ae(n,1))}else console.warn("THREE.LineSegments.computeLineDistances(): Computation only possible with non-indexed BufferGeometry.");return this}}class Hr extends un{constructor(e,t){super(e,t);this.isLineLoop=!0,this.type="LineLoop"}}class Ps extends xt{constructor(e){super();this.isPointsMaterial=!0,this.type="PointsMaterial",this.color=new ue(16777215),this.map=null,this.alphaMap=null,this.size=1,this.sizeAttenuation=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.alphaMap=e.alphaMap,this.size=e.size,this.sizeAttenuation=e.sizeAttenuation,this.fog=e.fog,this}}var ac=new De,Za=new On,dr=new At,fr=new T;class Wr extends et{constructor(e=new ze,t=new Ps){super();this.isPoints=!0,this.type="Points",this.geometry=e,this.material=t,this.updateMorphTargets()}copy(e,t){return super.copy(e,t),this.material=Array.isArray(e.material)?e.material.slice():e.material,this.geometry=e.geometry,this}raycast(e,t){let n=this.geometry,i=this.matrixWorld,s=e.params.Points.threshold,r=n.drawRange;if(n.boundingSphere===null)n.computeBoundingSphere();if(dr.copy(n.boundingSphere),dr.applyMatrix4(i),dr.radius+=s,e.ray.intersectsSphere(dr)===!1)return;ac.copy(i).invert(),Za.copy(e.ray).applyMatrix4(ac);let a=s/((this.scale.x+this.scale.y+this.scale.z)/3),o=a*a,l=n.index,h=n.attributes.position;if(l!==null){let u=Math.max(0,r.start),d=Math.min(l.count,r.start+r.count);for(let f=u,g=d;f<g;f++){let _=l.getX(f);fr.fromBufferAttribute(h,_),oc(fr,_,o,i,e,t,this)}}else{let u=Math.max(0,r.start),d=Math.min(h.count,r.start+r.count);for(let f=u,g=d;f<g;f++)fr.fromBufferAttribute(h,f),oc(fr,f,o,i,e,t,this)}}updateMorphTargets(){let t=this.geometry.morphAttributes,n=Object.keys(t);if(n.length>0){let i=t[n[0]];if(i!==void 0){this.morphTargetInfluences=[],this.morphTargetDictionary={};for(let s=0,r=i.length;s<r;s++){let a=i[s].name||String(s);this.morphTargetInfluences.push(0),this.morphTargetDictionary[a]=s}}}}}function oc(e,t,n,i,s,r,a){let o=Za.distanceSqToPoint(e);if(o<n){let l=new T;Za.closestPointToPoint(e,l),l.applyMatrix4(i);let c=s.ray.origin.distanceTo(l);if(c<s.near||c>s.far)return;r.push({distance:c,distanceToRay:Math.sqrt(o),point:l,index:t,face:null,object:a})}}class A_ extends ht{constructor(e,t,n,i,s,r,a,o,l){super(e,t,n,i,s,r,a,o,l);this.isVideoTexture=!0,this.minFilter=r!==void 0?r:1006,this.magFilter=s!==void 0?s:1006,this.generateMipmaps=!1;let c=this;function h(){c.needsUpdate=!0,e.requestVideoFrameCallback(h)}if("requestVideoFrameCallback"in e)e.requestVideoFrameCallback(h)}clone(){return new this.constructor(this.image).copy(this)}update(){let e=this.image;if("requestVideoFrameCallback"in e===!1&&e.readyState>=e.HAVE_CURRENT_DATA)this.needsUpdate=!0}}class E_ extends ht{constructor(e,t){super({width:e,height:t});this.isFramebufferTexture=!0,this.magFilter=1003,this.minFilter=1003,this.generateMipmaps=!1,this.needsUpdate=!0}}class Vr extends ht{constructor(e,t,n,i,s,r,a,o,l,c,h,u){super(null,r,a,o,l,c,i,s,h,u);this.isCompressedTexture=!0,this.image={width:t,height:n},this.mipmaps=e,this.flipY=!1,this.generateMipmaps=!1}}class w_ extends Vr{constructor(e,t,n,i,s,r){super(e,t,n,s,r);this.isCompressedArrayTexture=!0,this.image.depth=i,this.wrapR=1001}}class R_ extends Vr{constructor(e,t,n){super(void 0,e[0].width,e[0].height,t,n,301);this.isCompressedCubeTexture=!0,this.isCubeTexture=!0,this.image=e}}class C_ extends ht{constructor(e,t,n,i,s,r,a,o,l){super(e,t,n,i,s,r,a,o,l);this.isCanvasTexture=!0,this.needsUpdate=!0}}class sn{constructor(){this.type="Curve",this.arcLengthDivisions=200}getPoint(){return console.warn("THREE.Curve: .getPoint() not implemented."),null}getPointAt(e,t){let n=this.getUtoTmapping(e);return this.getPoint(n,t)}getPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));return t}getSpacedPoints(e=5){let t=[];for(let n=0;n<=e;n++)t.push(this.getPointAt(n/e));return t}getLength(){let e=this.getLengths();return e[e.length-1]}getLengths(e=this.arcLengthDivisions){if(this.cacheArcLengths&&this.cacheArcLengths.length===e+1&&!this.needsUpdate)return this.cacheArcLengths;this.needsUpdate=!1;let t=[],n,i=this.getPoint(0),s=0;t.push(0);for(let r=1;r<=e;r++)n=this.getPoint(r/e),s+=n.distanceTo(i),t.push(s),i=n;return this.cacheArcLengths=t,t}updateArcLengths(){this.needsUpdate=!0,this.getLengths()}getUtoTmapping(e,t){let n=this.getLengths(),i=0,s=n.length,r;if(t)r=t;else r=e*n[s-1];let a=0,o=s-1,l;while(a<=o)if(i=Math.floor(a+(o-a)/2),l=n[i]-r,l<0)a=i+1;else if(l>0)o=i-1;else{o=i;break}if(i=o,n[i]===r)return i/(s-1);let c=n[i],u=n[i+1]-c,d=(r-c)/u;return(i+d)/(s-1)}getTangent(e,t){let i=e-0.0001,s=e+0.0001;if(i<0)i=0;if(s>1)s=1;let r=this.getPoint(i),a=this.getPoint(s),o=t||(r.isVector2?new W:new T);return o.copy(a).sub(r).normalize(),o}getTangentAt(e,t){let n=this.getUtoTmapping(e);return this.getTangent(n,t)}computeFrenetFrames(e,t){let n=new T,i=[],s=[],r=[],a=new T,o=new De;for(let d=0;d<=e;d++){let f=d/e;i[d]=this.getTangentAt(f,new T)}s[0]=new T,r[0]=new T;let l=Number.MAX_VALUE,c=Math.abs(i[0].x),h=Math.abs(i[0].y),u=Math.abs(i[0].z);if(c<=l)l=c,n.set(1,0,0);if(h<=l)l=h,n.set(0,1,0);if(u<=l)n.set(0,0,1);a.crossVectors(i[0],n).normalize(),s[0].crossVectors(i[0],a),r[0].crossVectors(i[0],s[0]);for(let d=1;d<=e;d++){if(s[d]=s[d-1].clone(),r[d]=r[d-1].clone(),a.crossVectors(i[d-1],i[d]),a.length()>Number.EPSILON){a.normalize();let f=Math.acos(ft(i[d-1].dot(i[d]),-1,1));s[d].applyMatrix4(o.makeRotationAxis(a,f))}r[d].crossVectors(i[d],s[d])}if(t===!0){let d=Math.acos(ft(s[0].dot(s[e]),-1,1));if(d/=e,i[0].dot(a.crossVectors(s[0],s[e]))>0)d=-d;for(let f=1;f<=e;f++)s[f].applyMatrix4(o.makeRotationAxis(i[f],d*f)),r[f].crossVectors(i[f],s[f])}return{tangents:i,normals:s,binormals:r}}clone(){return new this.constructor().copy(this)}copy(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}toJSON(){let e={metadata:{version:4.6,type:"Curve",generator:"Curve.toJSON"}};return e.arcLengthDivisions=this.arcLengthDivisions,e.type=this.type,e}fromJSON(e){return this.arcLengthDivisions=e.arcLengthDivisions,this}}class Xr extends sn{constructor(e=0,t=0,n=1,i=1,s=0,r=Math.PI*2,a=!1,o=0){super();this.isEllipseCurve=!0,this.type="EllipseCurve",this.aX=e,this.aY=t,this.xRadius=n,this.yRadius=i,this.aStartAngle=s,this.aEndAngle=r,this.aClockwise=a,this.aRotation=o}getPoint(e,t){let n=t||new W,i=Math.PI*2,s=this.aEndAngle-this.aStartAngle,r=Math.abs(s)<Number.EPSILON;while(s<0)s+=i;while(s>i)s-=i;if(s<Number.EPSILON)if(r)s=0;else s=i;if(this.aClockwise===!0&&!r)if(s===i)s=-i;else s=s-i;let a=this.aStartAngle+e*s,o=this.aX+this.xRadius*Math.cos(a),l=this.aY+this.yRadius*Math.sin(a);if(this.aRotation!==0){let c=Math.cos(this.aRotation),h=Math.sin(this.aRotation),u=o-this.aX,d=l-this.aY;o=u*c-d*h+this.aX,l=u*h+d*c+this.aY}return n.set(o,l)}copy(e){return super.copy(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}toJSON(){let e=super.toJSON();return e.aX=this.aX,e.aY=this.aY,e.xRadius=this.xRadius,e.yRadius=this.yRadius,e.aStartAngle=this.aStartAngle,e.aEndAngle=this.aEndAngle,e.aClockwise=this.aClockwise,e.aRotation=this.aRotation,e}fromJSON(e){return super.fromJSON(e),this.aX=e.aX,this.aY=e.aY,this.xRadius=e.xRadius,this.yRadius=e.yRadius,this.aStartAngle=e.aStartAngle,this.aEndAngle=e.aEndAngle,this.aClockwise=e.aClockwise,this.aRotation=e.aRotation,this}}class Th extends Xr{constructor(e,t,n,i,s,r){super(e,t,n,n,i,s,r);this.isArcCurve=!0,this.type="ArcCurve"}}function mo(){let e=0,t=0,n=0,i=0;function s(r,a,o,l){e=r,t=o,n=-3*r+3*a-2*o-l,i=2*r-2*a+o+l}return{initCatmullRom:function(r,a,o,l,c){s(a,o,c*(o-r),c*(l-a))},initNonuniformCatmullRom:function(r,a,o,l,c,h,u){let d=(a-r)/c-(o-r)/(c+h)+(o-a)/h,f=(o-a)/h-(l-a)/(h+u)+(l-o)/u;d*=h,f*=h,s(a,o,d,f)},calc:function(r){let a=r*r,o=a*r;return e+t*r+n*a+i*o}}}var pr=new T,Oa=new mo,Ba=new mo,za=new mo;class Ah extends sn{constructor(e=[],t=!1,n="centripetal",i=0.5){super();this.isCatmullRomCurve3=!0,this.type="CatmullRomCurve3",this.points=e,this.closed=t,this.curveType=n,this.tension=i}getPoint(e,t=new T){let n=t,i=this.points,s=i.length,r=(s-(this.closed?0:1))*e,a=Math.floor(r),o=r-a;if(this.closed)a+=a>0?0:(Math.floor(Math.abs(a)/s)+1)*s;else if(o===0&&a===s-1)a=s-2,o=1;let l,c;if(this.closed||a>0)l=i[(a-1)%s];else pr.subVectors(i[0],i[1]).add(i[0]),l=pr;let h=i[a%s],u=i[(a+1)%s];if(this.closed||a+2<s)c=i[(a+2)%s];else pr.subVectors(i[s-1],i[s-2]).add(i[s-1]),c=pr;if(this.curveType==="centripetal"||this.curveType==="chordal"){let d=this.curveType==="chordal"?0.5:0.25,f=Math.pow(l.distanceToSquared(h),d),g=Math.pow(h.distanceToSquared(u),d),_=Math.pow(u.distanceToSquared(c),d);if(g<0.0001)g=1;if(f<0.0001)f=g;if(_<0.0001)_=g;Oa.initNonuniformCatmullRom(l.x,h.x,u.x,c.x,f,g,_),Ba.initNonuniformCatmullRom(l.y,h.y,u.y,c.y,f,g,_),za.initNonuniformCatmullRom(l.z,h.z,u.z,c.z,f,g,_)}else if(this.curveType==="catmullrom")Oa.initCatmullRom(l.x,h.x,u.x,c.x,this.tension),Ba.initCatmullRom(l.y,h.y,u.y,c.y,this.tension),za.initCatmullRom(l.z,h.z,u.z,c.z,this.tension);return n.set(Oa.calc(o),Ba.calc(o),za.calc(o)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let i=e.points[t];this.points.push(i.clone())}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let i=this.points[t];e.points.push(i.toArray())}return e.closed=this.closed,e.curveType=this.curveType,e.tension=this.tension,e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let i=e.points[t];this.points.push(new T().fromArray(i))}return this.closed=e.closed,this.curveType=e.curveType,this.tension=e.tension,this}}function lc(e,t,n,i,s){let r=(i-t)*0.5,a=(s-n)*0.5,o=e*e,l=e*o;return(2*n-2*i+r+a)*l+(-3*n+3*i-2*r-a)*o+r*e+n}function P_(e,t){let n=1-e;return n*n*t}function L_(e,t){return 2*(1-e)*e*t}function I_(e,t){return e*e*t}function _s(e,t,n,i){return P_(e,t)+L_(e,n)+I_(e,i)}function N_(e,t){let n=1-e;return n*n*n*t}function D_(e,t){let n=1-e;return 3*n*n*e*t}function U_(e,t){return 3*(1-e)*e*e*t}function F_(e,t){return e*e*e*t}function xs(e,t,n,i,s){return N_(e,t)+D_(e,n)+U_(e,i)+F_(e,s)}class go extends sn{constructor(e=new W,t=new W,n=new W,i=new W){super();this.isCubicBezierCurve=!0,this.type="CubicBezierCurve",this.v0=e,this.v1=t,this.v2=n,this.v3=i}getPoint(e,t=new W){let n=t,i=this.v0,s=this.v1,r=this.v2,a=this.v3;return n.set(xs(e,i.x,s.x,r.x,a.x),xs(e,i.y,s.y,r.y,a.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}}class Eh extends sn{constructor(e=new T,t=new T,n=new T,i=new T){super();this.isCubicBezierCurve3=!0,this.type="CubicBezierCurve3",this.v0=e,this.v1=t,this.v2=n,this.v3=i}getPoint(e,t=new T){let n=t,i=this.v0,s=this.v1,r=this.v2,a=this.v3;return n.set(xs(e,i.x,s.x,r.x,a.x),xs(e,i.y,s.y,r.y,a.y),xs(e,i.z,s.z,r.z,a.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this.v3.copy(e.v3),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e.v3=this.v3.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this.v3.fromArray(e.v3),this}}class _o extends sn{constructor(e=new W,t=new W){super();this.isLineCurve=!0,this.type="LineCurve",this.v1=e,this.v2=t}getPoint(e,t=new W){let n=t;if(e===1)n.copy(this.v2);else n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1);return n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new W){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}}class wh extends sn{constructor(e=new T,t=new T){super();this.isLineCurve3=!0,this.type="LineCurve3",this.v1=e,this.v2=t}getPoint(e,t=new T){let n=t;if(e===1)n.copy(this.v2);else n.copy(this.v2).sub(this.v1),n.multiplyScalar(e).add(this.v1);return n}getPointAt(e,t){return this.getPoint(e,t)}getTangent(e,t=new T){return t.subVectors(this.v2,this.v1).normalize()}getTangentAt(e,t){return this.getTangent(e,t)}copy(e){return super.copy(e),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}}class xo extends sn{constructor(e=new W,t=new W,n=new W){super();this.isQuadraticBezierCurve=!0,this.type="QuadraticBezierCurve",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new W){let n=t,i=this.v0,s=this.v1,r=this.v2;return n.set(_s(e,i.x,s.x,r.x),_s(e,i.y,s.y,r.y)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}}class vo extends sn{constructor(e=new T,t=new T,n=new T){super();this.isQuadraticBezierCurve3=!0,this.type="QuadraticBezierCurve3",this.v0=e,this.v1=t,this.v2=n}getPoint(e,t=new T){let n=t,i=this.v0,s=this.v1,r=this.v2;return n.set(_s(e,i.x,s.x,r.x),_s(e,i.y,s.y,r.y),_s(e,i.z,s.z,r.z)),n}copy(e){return super.copy(e),this.v0.copy(e.v0),this.v1.copy(e.v1),this.v2.copy(e.v2),this}toJSON(){let e=super.toJSON();return e.v0=this.v0.toArray(),e.v1=this.v1.toArray(),e.v2=this.v2.toArray(),e}fromJSON(e){return super.fromJSON(e),this.v0.fromArray(e.v0),this.v1.fromArray(e.v1),this.v2.fromArray(e.v2),this}}class yo extends sn{constructor(e=[]){super();this.isSplineCurve=!0,this.type="SplineCurve",this.points=e}getPoint(e,t=new W){let n=t,i=this.points,s=(i.length-1)*e,r=Math.floor(s),a=s-r,o=i[r===0?r:r-1],l=i[r],c=i[r>i.length-2?i.length-1:r+1],h=i[r>i.length-3?i.length-1:r+2];return n.set(lc(a,o.x,l.x,c.x,h.x),lc(a,o.y,l.y,c.y,h.y)),n}copy(e){super.copy(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let i=e.points[t];this.points.push(i.clone())}return this}toJSON(){let e=super.toJSON();e.points=[];for(let t=0,n=this.points.length;t<n;t++){let i=this.points[t];e.points.push(i.toArray())}return e}fromJSON(e){super.fromJSON(e),this.points=[];for(let t=0,n=e.points.length;t<n;t++){let i=e.points[t];this.points.push(new W().fromArray(i))}return this}}var Cr=Object.freeze({__proto__:null,ArcCurve:Th,CatmullRomCurve3:Ah,CubicBezierCurve:go,CubicBezierCurve3:Eh,EllipseCurve:Xr,LineCurve:_o,LineCurve3:wh,QuadraticBezierCurve:xo,QuadraticBezierCurve3:vo,SplineCurve:yo});class Rh extends sn{constructor(){super();this.type="CurvePath",this.curves=[],this.autoClose=!1}add(e){this.curves.push(e)}closePath(){let e=this.curves[0].getPoint(0),t=this.curves[this.curves.length-1].getPoint(1);if(!e.equals(t)){let n=e.isVector2===!0?"LineCurve":"LineCurve3";this.curves.push(new Cr[n](t,e))}return this}getPoint(e,t){let n=e*this.getLength(),i=this.getCurveLengths(),s=0;while(s<i.length){if(i[s]>=n){let r=i[s]-n,a=this.curves[s],o=a.getLength(),l=o===0?0:1-r/o;return a.getPointAt(l,t)}s++}return null}getLength(){let e=this.getCurveLengths();return e[e.length-1]}updateArcLengths(){this.needsUpdate=!0,this.cacheLengths=null,this.getCurveLengths()}getCurveLengths(){if(this.cacheLengths&&this.cacheLengths.length===this.curves.length)return this.cacheLengths;let e=[],t=0;for(let n=0,i=this.curves.length;n<i;n++)t+=this.curves[n].getLength(),e.push(t);return this.cacheLengths=e,e}getSpacedPoints(e=40){let t=[];for(let n=0;n<=e;n++)t.push(this.getPoint(n/e));if(this.autoClose)t.push(t[0]);return t}getPoints(e=12){let t=[],n;for(let i=0,s=this.curves;i<s.length;i++){let r=s[i],a=r.isEllipseCurve?e*2:r.isLineCurve||r.isLineCurve3?1:r.isSplineCurve?e*r.points.length:e,o=r.getPoints(a);for(let l=0;l<o.length;l++){let c=o[l];if(n&&n.equals(c))continue;t.push(c),n=c}}if(this.autoClose&&t.length>1&&!t[t.length-1].equals(t[0]))t.push(t[0]);return t}copy(e){super.copy(e),this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let i=e.curves[t];this.curves.push(i.clone())}return this.autoClose=e.autoClose,this}toJSON(){let e=super.toJSON();e.autoClose=this.autoClose,e.curves=[];for(let t=0,n=this.curves.length;t<n;t++){let i=this.curves[t];e.curves.push(i.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.autoClose=e.autoClose,this.curves=[];for(let t=0,n=e.curves.length;t<n;t++){let i=e.curves[t];this.curves.push(new Cr[i.type]().fromJSON(i))}return this}}class ys extends Rh{constructor(e){super();if(this.type="Path",this.currentPoint=new W,e)this.setFromPoints(e)}setFromPoints(e){this.moveTo(e[0].x,e[0].y);for(let t=1,n=e.length;t<n;t++)this.lineTo(e[t].x,e[t].y);return this}moveTo(e,t){return this.currentPoint.set(e,t),this}lineTo(e,t){let n=new _o(this.currentPoint.clone(),new W(e,t));return this.curves.push(n),this.currentPoint.set(e,t),this}quadraticCurveTo(e,t,n,i){let s=new xo(this.currentPoint.clone(),new W(e,t),new W(n,i));return this.curves.push(s),this.currentPoint.set(n,i),this}bezierCurveTo(e,t,n,i,s,r){let a=new go(this.currentPoint.clone(),new W(e,t),new W(n,i),new W(s,r));return this.curves.push(a),this.currentPoint.set(s,r),this}splineThru(e){let t=[this.currentPoint.clone()].concat(e),n=new yo(t);return this.curves.push(n),this.currentPoint.copy(e[e.length-1]),this}arc(e,t,n,i,s,r){let a=this.currentPoint.x,o=this.currentPoint.y;return this.absarc(e+a,t+o,n,i,s,r),this}absarc(e,t,n,i,s,r){return this.absellipse(e,t,n,n,i,s,r),this}ellipse(e,t,n,i,s,r,a,o){let l=this.currentPoint.x,c=this.currentPoint.y;return this.absellipse(e+l,t+c,n,i,s,r,a,o),this}absellipse(e,t,n,i,s,r,a,o){let l=new Xr(e,t,n,i,s,r,a,o);if(this.curves.length>0){let h=l.getPoint(0);if(!h.equals(this.currentPoint))this.lineTo(h.x,h.y)}this.curves.push(l);let c=l.getPoint(1);return this.currentPoint.copy(c),this}copy(e){return super.copy(e),this.currentPoint.copy(e.currentPoint),this}toJSON(){let e=super.toJSON();return e.currentPoint=this.currentPoint.toArray(),e}fromJSON(e){return super.fromJSON(e),this.currentPoint.fromArray(e.currentPoint),this}}class qr extends ze{constructor(e=[new W(0,-0.5),new W(0.5,0),new W(0,0.5)],t=12,n=0,i=Math.PI*2){super();this.type="LatheGeometry",this.parameters={points:e,segments:t,phiStart:n,phiLength:i},t=Math.floor(t),i=ft(i,0,Math.PI*2);let s=[],r=[],a=[],o=[],l=[],c=1/t,h=new T,u=new W,d=new T,f=new T,g=new T,_=0,m=0;for(let p=0;p<=e.length-1;p++)switch(p){case 0:_=e[p+1].x-e[p].x,m=e[p+1].y-e[p].y,d.x=m*1,d.y=-_,d.z=m*0,g.copy(d),d.normalize(),o.push(d.x,d.y,d.z);break;case e.length-1:o.push(g.x,g.y,g.z);break;default:_=e[p+1].x-e[p].x,m=e[p+1].y-e[p].y,d.x=m*1,d.y=-_,d.z=m*0,f.copy(d),d.x+=g.x,d.y+=g.y,d.z+=g.z,d.normalize(),o.push(d.x,d.y,d.z),g.copy(f)}for(let p=0;p<=t;p++){let x=n+p*c*i,v=Math.sin(x),b=Math.cos(x);for(let R=0;R<=e.length-1;R++){h.x=e[R].x*v,h.y=e[R].y,h.z=e[R].x*b,r.push(h.x,h.y,h.z),u.x=p/t,u.y=R/(e.length-1),a.push(u.x,u.y);let M=o[3*R+0]*v,C=o[3*R+1],D=o[3*R+0]*b;l.push(M,C,D)}}for(let p=0;p<t;p++)for(let x=0;x<e.length-1;x++){let v=x+p*e.length,b=v,R=v+e.length,M=v+e.length+1,C=v+1;s.push(b,R,C),s.push(M,C,R)}this.setIndex(s),this.setAttribute("position",new Ae(r,3)),this.setAttribute("uv",new Ae(a,2)),this.setAttribute("normal",new Ae(l,3))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new qr(e.points,e.segments,e.phiStart,e.phiLength)}}class So extends qr{constructor(e=1,t=1,n=4,i=8){let s=new ys;s.absarc(0,-t/2,e,Math.PI*1.5,0),s.absarc(0,t/2,e,0,Math.PI*0.5);super(s.getPoints(n),i);this.type="CapsuleGeometry",this.parameters={radius:e,length:t,capSegments:n,radialSegments:i}}static fromJSON(e){return new So(e.radius,e.length,e.capSegments,e.radialSegments)}}class Mo extends ze{constructor(e=1,t=32,n=0,i=Math.PI*2){super();this.type="CircleGeometry",this.parameters={radius:e,segments:t,thetaStart:n,thetaLength:i},t=Math.max(3,t);let s=[],r=[],a=[],o=[],l=new T,c=new W;r.push(0,0,0),a.push(0,0,1),o.push(0.5,0.5);for(let h=0,u=3;h<=t;h++,u+=3){let d=n+h/t*i;l.x=e*Math.cos(d),l.y=e*Math.sin(d),r.push(l.x,l.y,l.z),a.push(0,0,1),c.x=(r[u]/e+1)/2,c.y=(r[u+1]/e+1)/2,o.push(c.x,c.y)}for(let h=1;h<=t;h++)s.push(h,h+1,0);this.setIndex(s),this.setAttribute("position",new Ae(r,3)),this.setAttribute("normal",new Ae(a,3)),this.setAttribute("uv",new Ae(o,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Mo(e.radius,e.segments,e.thetaStart,e.thetaLength)}}class Ls extends ze{constructor(e=1,t=1,n=1,i=32,s=1,r=!1,a=0,o=Math.PI*2){super();this.type="CylinderGeometry",this.parameters={radiusTop:e,radiusBottom:t,height:n,radialSegments:i,heightSegments:s,openEnded:r,thetaStart:a,thetaLength:o};let l=this;i=Math.floor(i),s=Math.floor(s);let c=[],h=[],u=[],d=[],f=0,g=[],_=n/2,m=0;if(p(),r===!1){if(e>0)x(!0);if(t>0)x(!1)}this.setIndex(c),this.setAttribute("position",new Ae(h,3)),this.setAttribute("normal",new Ae(u,3)),this.setAttribute("uv",new Ae(d,2));function p(){let v=new T,b=new T,R=0,M=(t-e)/n;for(let C=0;C<=s;C++){let D=[],S=C/s,w=S*(t-e)+e;for(let U=0;U<=i;U++){let J=U/i,ae=J*o+a,I=Math.sin(ae),z=Math.cos(ae);b.x=w*I,b.y=-S*n+_,b.z=w*z,h.push(b.x,b.y,b.z),v.set(I,M,z).normalize(),u.push(v.x,v.y,v.z),d.push(J,1-S),D.push(f++)}g.push(D)}for(let C=0;C<i;C++)for(let D=0;D<s;D++){let S=g[D][C],w=g[D+1][C],U=g[D+1][C+1],J=g[D][C+1];c.push(S,w,J),c.push(w,U,J),R+=6}l.addGroup(m,R,0),m+=R}function x(v){let b=f,R=new W,M=new T,C=0,D=v===!0?e:t,S=v===!0?1:-1;for(let U=1;U<=i;U++)h.push(0,_*S,0),u.push(0,S,0),d.push(0.5,0.5),f++;let w=f;for(let U=0;U<=i;U++){let ae=U/i*o+a,I=Math.cos(ae),z=Math.sin(ae);M.x=D*z,M.y=_*S,M.z=D*I,h.push(M.x,M.y,M.z),u.push(0,S,0),R.x=I*0.5+0.5,R.y=z*0.5*S+0.5,d.push(R.x,R.y),f++}for(let U=0;U<i;U++){let J=b+U,ae=w+U;if(v===!0)c.push(ae,ae+1,J);else c.push(ae+1,ae,J);C+=3}l.addGroup(m,C,v===!0?1:2),m+=C}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Ls(e.radiusTop,e.radiusBottom,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}}class bo extends Ls{constructor(e=1,t=1,n=32,i=1,s=!1,r=0,a=Math.PI*2){super(0,e,t,n,i,s,r,a);this.type="ConeGeometry",this.parameters={radius:e,height:t,radialSegments:n,heightSegments:i,openEnded:s,thetaStart:r,thetaLength:a}}static fromJSON(e){return new bo(e.radius,e.height,e.radialSegments,e.heightSegments,e.openEnded,e.thetaStart,e.thetaLength)}}class pi extends ze{constructor(e=[],t=[],n=1,i=0){super();this.type="PolyhedronGeometry",this.parameters={vertices:e,indices:t,radius:n,detail:i};let s=[],r=[];if(a(i),l(n),c(),this.setAttribute("position",new Ae(s,3)),this.setAttribute("normal",new Ae(s.slice(),3)),this.setAttribute("uv",new Ae(r,2)),i===0)this.computeVertexNormals();else this.normalizeNormals();function a(p){let x=new T,v=new T,b=new T;for(let R=0;R<t.length;R+=3)d(t[R+0],x),d(t[R+1],v),d(t[R+2],b),o(x,v,b,p)}function o(p,x,v,b){let R=b+1,M=[];for(let C=0;C<=R;C++){M[C]=[];let D=p.clone().lerp(v,C/R),S=x.clone().lerp(v,C/R),w=R-C;for(let U=0;U<=w;U++)if(U===0&&C===R)M[C][U]=D;else M[C][U]=D.clone().lerp(S,U/w)}for(let C=0;C<R;C++)for(let D=0;D<2*(R-C)-1;D++){let S=Math.floor(D/2);if(D%2===0)u(M[C][S+1]),u(M[C+1][S]),u(M[C][S]);else u(M[C][S+1]),u(M[C+1][S+1]),u(M[C+1][S])}}function l(p){let x=new T;for(let v=0;v<s.length;v+=3)x.x=s[v+0],x.y=s[v+1],x.z=s[v+2],x.normalize().multiplyScalar(p),s[v+0]=x.x,s[v+1]=x.y,s[v+2]=x.z}function c(){let p=new T;for(let x=0;x<s.length;x+=3){p.x=s[x+0],p.y=s[x+1],p.z=s[x+2];let v=_(p)/2/Math.PI+0.5,b=m(p)/Math.PI+0.5;r.push(v,1-b)}f(),h()}function h(){for(let p=0;p<r.length;p+=6){let x=r[p+0],v=r[p+2],b=r[p+4],R=Math.max(x,v,b),M=Math.min(x,v,b);if(R>0.9&&M<0.1){if(x<0.2)r[p+0]+=1;if(v<0.2)r[p+2]+=1;if(b<0.2)r[p+4]+=1}}}function u(p){s.push(p.x,p.y,p.z)}function d(p,x){let v=p*3;x.x=e[v+0],x.y=e[v+1],x.z=e[v+2]}function f(){let p=new T,x=new T,v=new T,b=new T,R=new W,M=new W,C=new W;for(let D=0,S=0;D<s.length;D+=9,S+=6){p.set(s[D+0],s[D+1],s[D+2]),x.set(s[D+3],s[D+4],s[D+5]),v.set(s[D+6],s[D+7],s[D+8]),R.set(r[S+0],r[S+1]),M.set(r[S+2],r[S+3]),C.set(r[S+4],r[S+5]),b.copy(p).add(x).add(v).divideScalar(3);let w=_(b);g(R,S+0,p,w),g(M,S+2,x,w),g(C,S+4,v,w)}}function g(p,x,v,b){if(b<0&&p.x===1)r[x]=p.x-1;if(v.x===0&&v.z===0)r[x]=b/2/Math.PI+0.5}function _(p){return Math.atan2(p.z,-p.x)}function m(p){return Math.atan2(-p.y,Math.sqrt(p.x*p.x+p.z*p.z))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new pi(e.vertices,e.indices,e.radius,e.details)}}class To extends pi{constructor(e=1,t=0){let n=(1+Math.sqrt(5))/2,i=1/n,s=[-1,-1,-1,-1,-1,1,-1,1,-1,-1,1,1,1,-1,-1,1,-1,1,1,1,-1,1,1,1,0,-i,-n,0,-i,n,0,i,-n,0,i,n,-i,-n,0,-i,n,0,i,-n,0,i,n,0,-n,0,-i,n,0,-i,-n,0,i,n,0,i],r=[3,11,7,3,7,15,3,15,13,7,19,17,7,17,6,7,6,15,17,4,8,17,8,10,17,10,6,8,0,16,8,16,2,8,2,10,0,12,1,0,1,18,0,18,16,6,10,2,6,2,13,6,13,15,2,16,18,2,18,3,2,3,13,18,1,9,18,9,11,18,11,3,4,14,12,4,12,0,4,0,8,11,9,5,11,5,19,11,19,7,19,5,14,19,14,4,19,4,17,1,12,14,1,14,5,1,5,9];super(s,r,e,t);this.type="DodecahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new To(e.radius,e.detail)}}var mr=new T,gr=new T,ka=new T,_r=new Vt;class Ch extends ze{constructor(e=null,t=1){super();if(this.type="EdgesGeometry",this.parameters={geometry:e,thresholdAngle:t},e!==null){let i=Math.pow(10,4),s=Math.cos(ai*t),r=e.getIndex(),a=e.getAttribute("position"),o=r?r.count:a.count,l=[0,0,0],c=["a","b","c"],h=[,,,],u={},d=[];for(let f=0;f<o;f+=3){if(r)l[0]=r.getX(f),l[1]=r.getX(f+1),l[2]=r.getX(f+2);else l[0]=f,l[1]=f+1,l[2]=f+2;let{a:g,b:_,c:m}=_r;if(g.fromBufferAttribute(a,l[0]),_.fromBufferAttribute(a,l[1]),m.fromBufferAttribute(a,l[2]),_r.getNormal(ka),h[0]=`${Math.round(g.x*i)},${Math.round(g.y*i)},${Math.round(g.z*i)}`,h[1]=`${Math.round(_.x*i)},${Math.round(_.y*i)},${Math.round(_.z*i)}`,h[2]=`${Math.round(m.x*i)},${Math.round(m.y*i)},${Math.round(m.z*i)}`,h[0]===h[1]||h[1]===h[2]||h[2]===h[0])continue;for(let p=0;p<3;p++){let x=(p+1)%3,v=h[p],b=h[x],R=_r[c[p]],M=_r[c[x]],C=`${v}_${b}`,D=`${b}_${v}`;if(D in u&&u[D]){if(ka.dot(u[D].normal)<=s)d.push(R.x,R.y,R.z),d.push(M.x,M.y,M.z);u[D]=null}else if(!(C in u))u[C]={index0:l[p],index1:l[x],normal:ka.clone()}}}for(let f in u)if(u[f]){let{index0:g,index1:_}=u[f];mr.fromBufferAttribute(a,g),gr.fromBufferAttribute(a,_),d.push(mr.x,mr.y,mr.z),d.push(gr.x,gr.y,gr.z)}this.setAttribute("position",new Ae(d,3))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}}class li extends ys{constructor(e){super(e);this.uuid=Xt(),this.type="Shape",this.holes=[]}getPointsHoles(e){let t=[];for(let n=0,i=this.holes.length;n<i;n++)t[n]=this.holes[n].getPoints(e);return t}extractPoints(e){return{shape:this.getPoints(e),holes:this.getPointsHoles(e)}}copy(e){super.copy(e),this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let i=e.holes[t];this.holes.push(i.clone())}return this}toJSON(){let e=super.toJSON();e.uuid=this.uuid,e.holes=[];for(let t=0,n=this.holes.length;t<n;t++){let i=this.holes[t];e.holes.push(i.toJSON())}return e}fromJSON(e){super.fromJSON(e),this.uuid=e.uuid,this.holes=[];for(let t=0,n=e.holes.length;t<n;t++){let i=e.holes[t];this.holes.push(new ys().fromJSON(i))}return this}}var O_={triangulate:function(e,t,n=2){let i=t&&t.length,s=i?t[0]*n:e.length,r=Ph(e,0,s,n,!0),a=[];if(!r||r.next===r.prev)return a;let o,l,c,h,u,d,f;if(i)r=H_(e,t,r,n);if(e.length>80*n){o=c=e[0],l=h=e[1];for(let g=n;g<s;g+=n){if(u=e[g],d=e[g+1],u<o)o=u;if(d<l)l=d;if(u>c)c=u;if(d>h)h=d}f=Math.max(c-o,h-l),f=f!==0?32767/f:0}return Ss(r,a,n,o,l,f,0),a}};function Ph(e,t,n,i,s){let r,a;if(s===Q_(e,t,n,i)>0)for(r=t;r<n;r+=i)a=cc(r,e[r],e[r+1],a);else for(r=n-i;r>=t;r-=i)a=cc(r,e[r],e[r+1],a);if(a&&Yr(a,a.next))bs(a),a=a.next;return a}function ci(e,t){if(!e)return e;if(!t)t=e;let n=e,i;do if(i=!1,!n.steiner&&(Yr(n,n.next)||ct(n.prev,n,n.next)===0)){if(bs(n),n=t=n.prev,n===n.next)break;i=!0}else n=n.next;while(i||n!==t);return t}function Ss(e,t,n,i,s,r,a){if(!e)return;if(!a&&r)Y_(e,i,s,r);let o=e,l,c;while(e.prev!==e.next){if(l=e.prev,c=e.next,r?z_(e,i,s,r):B_(e)){t.push(l.i/n|0),t.push(e.i/n|0),t.push(c.i/n|0),bs(e),e=c.next,o=c.next;continue}if(e=c,e===o){if(!a)Ss(ci(e),t,n,i,s,r,1);else if(a===1)e=k_(ci(e),t,n),Ss(e,t,n,i,s,r,2);else if(a===2)G_(e,t,n,i,s,r);break}}}function B_(e){let t=e.prev,n=e,i=e.next;if(ct(t,n,i)>=0)return!1;let s=t.x,r=n.x,a=i.x,o=t.y,l=n.y,c=i.y,h=s<r?s<a?s:a:r<a?r:a,u=o<l?o<c?o:c:l<c?l:c,d=s>r?s>a?s:a:r>a?r:a,f=o>l?o>c?o:c:l>c?l:c,g=i.next;while(g!==t){if(g.x>=h&&g.x<=d&&g.y>=u&&g.y<=f&&Vi(s,o,r,l,a,c,g.x,g.y)&&ct(g.prev,g,g.next)>=0)return!1;g=g.next}return!0}function z_(e,t,n,i){let s=e.prev,r=e,a=e.next;if(ct(s,r,a)>=0)return!1;let o=s.x,l=r.x,c=a.x,h=s.y,u=r.y,d=a.y,f=o<l?o<c?o:c:l<c?l:c,g=h<u?h<d?h:d:u<d?u:d,_=o>l?o>c?o:c:l>c?l:c,m=h>u?h>d?h:d:u>d?u:d,p=Ka(f,g,t,n,i),x=Ka(_,m,t,n,i),{prevZ:v,nextZ:b}=e;while(v&&v.z>=p&&b&&b.z<=x){if(v.x>=f&&v.x<=_&&v.y>=g&&v.y<=m&&v!==s&&v!==a&&Vi(o,h,l,u,c,d,v.x,v.y)&&ct(v.prev,v,v.next)>=0)return!1;if(v=v.prevZ,b.x>=f&&b.x<=_&&b.y>=g&&b.y<=m&&b!==s&&b!==a&&Vi(o,h,l,u,c,d,b.x,b.y)&&ct(b.prev,b,b.next)>=0)return!1;b=b.nextZ}while(v&&v.z>=p){if(v.x>=f&&v.x<=_&&v.y>=g&&v.y<=m&&v!==s&&v!==a&&Vi(o,h,l,u,c,d,v.x,v.y)&&ct(v.prev,v,v.next)>=0)return!1;v=v.prevZ}while(b&&b.z<=x){if(b.x>=f&&b.x<=_&&b.y>=g&&b.y<=m&&b!==s&&b!==a&&Vi(o,h,l,u,c,d,b.x,b.y)&&ct(b.prev,b,b.next)>=0)return!1;b=b.nextZ}return!0}function k_(e,t,n){let i=e;do{let s=i.prev,r=i.next.next;if(!Yr(s,r)&&Lh(s,i,i.next,r)&&Ms(s,r)&&Ms(r,s))t.push(s.i/n|0),t.push(i.i/n|0),t.push(r.i/n|0),bs(i),bs(i.next),i=e=r;i=i.next}while(i!==e);return ci(i)}function G_(e,t,n,i,s,r){let a=e;do{let o=a.next.next;while(o!==a.prev){if(a.i!==o.i&&J_(a,o)){let l=Ih(a,o);a=ci(a,a.next),l=ci(l,l.next),Ss(a,t,n,i,s,r,0),Ss(l,t,n,i,s,r,0);return}o=o.next}a=a.next}while(a!==e)}function H_(e,t,n,i){let s=[],r,a,o,l,c;for(r=0,a=t.length;r<a;r++){if(o=t[r]*i,l=r<a-1?t[r+1]*i:e.length,c=Ph(e,o,l,i,!1),c===c.next)c.steiner=!0;s.push(K_(c))}s.sort(W_);for(r=0;r<s.length;r++)n=V_(s[r],n);return n}function W_(e,t){return e.x-t.x}function V_(e,t){let n=X_(e,t);if(!n)return t;let i=Ih(n,e);return ci(i,i.next),ci(n,n.next)}function X_(e,t){let n=t,i=-1/0,s,{x:r,y:a}=e;do{if(a<=n.y&&a>=n.next.y&&n.next.y!==n.y){let d=n.x+(a-n.y)*(n.next.x-n.x)/(n.next.y-n.y);if(d<=r&&d>i){if(i=d,s=n.x<n.next.x?n:n.next,d===r)return s}}n=n.next}while(n!==t);if(!s)return null;let o=s,l=s.x,c=s.y,h=1/0,u;n=s;do{if(r>=n.x&&n.x>=l&&r!==n.x&&Vi(a<c?r:i,a,l,c,a<c?i:r,a,n.x,n.y)){if(u=Math.abs(a-n.y)/(r-n.x),Ms(n,e)&&(u<h||u===h&&(n.x>s.x||n.x===s.x&&q_(s,n))))s=n,h=u}n=n.next}while(n!==o);return s}function q_(e,t){return ct(e.prev,e,t.prev)<0&&ct(t.next,e,e.next)<0}function Y_(e,t,n,i){let s=e;do{if(s.z===0)s.z=Ka(s.x,s.y,t,n,i);s.prevZ=s.prev,s.nextZ=s.next,s=s.next}while(s!==e);s.prevZ.nextZ=null,s.prevZ=null,Z_(s)}function Z_(e){let t,n,i,s,r,a,o,l,c=1;do{n=e,e=null,r=null,a=0;while(n){a++,i=n,o=0;for(t=0;t<c;t++)if(o++,i=i.nextZ,!i)break;l=c;while(o>0||l>0&&i){if(o!==0&&(l===0||!i||n.z<=i.z))s=n,n=n.nextZ,o--;else s=i,i=i.nextZ,l--;if(r)r.nextZ=s;else e=s;s.prevZ=r,r=s}n=i}r.nextZ=null,c*=2}while(a>1);return e}function Ka(e,t,n,i,s){return e=(e-n)*s|0,t=(t-i)*s|0,e=(e|e<<8)&16711935,e=(e|e<<4)&252645135,e=(e|e<<2)&858993459,e=(e|e<<1)&1431655765,t=(t|t<<8)&16711935,t=(t|t<<4)&252645135,t=(t|t<<2)&858993459,t=(t|t<<1)&1431655765,e|t<<1}function K_(e){let t=e,n=e;do{if(t.x<n.x||t.x===n.x&&t.y<n.y)n=t;t=t.next}while(t!==e);return n}function Vi(e,t,n,i,s,r,a,o){return(s-a)*(t-o)>=(e-a)*(r-o)&&(e-a)*(i-o)>=(n-a)*(t-o)&&(n-a)*(r-o)>=(s-a)*(i-o)}function J_(e,t){return e.next.i!==t.i&&e.prev.i!==t.i&&!$_(e,t)&&(Ms(e,t)&&Ms(t,e)&&j_(e,t)&&(ct(e.prev,e,t.prev)||ct(e,t.prev,t))||Yr(e,t)&&ct(e.prev,e,e.next)>0&&ct(t.prev,t,t.next)>0)}function ct(e,t,n){return(t.y-e.y)*(n.x-t.x)-(t.x-e.x)*(n.y-t.y)}function Yr(e,t){return e.x===t.x&&e.y===t.y}function Lh(e,t,n,i){let s=vr(ct(e,t,n)),r=vr(ct(e,t,i)),a=vr(ct(n,i,e)),o=vr(ct(n,i,t));if(s!==r&&a!==o)return!0;if(s===0&&xr(e,n,t))return!0;if(r===0&&xr(e,i,t))return!0;if(a===0&&xr(n,e,i))return!0;if(o===0&&xr(n,t,i))return!0;return!1}function xr(e,t,n){return t.x<=Math.max(e.x,n.x)&&t.x>=Math.min(e.x,n.x)&&t.y<=Math.max(e.y,n.y)&&t.y>=Math.min(e.y,n.y)}function vr(e){return e>0?1:e<0?-1:0}function $_(e,t){let n=e;do{if(n.i!==e.i&&n.next.i!==e.i&&n.i!==t.i&&n.next.i!==t.i&&Lh(n,n.next,e,t))return!0;n=n.next}while(n!==e);return!1}function Ms(e,t){return ct(e.prev,e,e.next)<0?ct(e,t,e.next)>=0&&ct(e,e.prev,t)>=0:ct(e,t,e.prev)<0||ct(e,e.next,t)<0}function j_(e,t){let n=e,i=!1,s=(e.x+t.x)/2,r=(e.y+t.y)/2;do{if(n.y>r!==n.next.y>r&&n.next.y!==n.y&&s<(n.next.x-n.x)*(r-n.y)/(n.next.y-n.y)+n.x)i=!i;n=n.next}while(n!==e);return i}function Ih(e,t){let n=new Ja(e.i,e.x,e.y),i=new Ja(t.i,t.x,t.y),s=e.next,r=t.prev;return e.next=t,t.prev=e,n.next=s,s.prev=n,i.next=n,n.prev=i,r.next=i,i.prev=r,i}function cc(e,t,n,i){let s=new Ja(e,t,n);if(!i)s.prev=s,s.next=s;else s.next=i.next,s.prev=i,i.next.prev=s,i.next=s;return s}function bs(e){if(e.next.prev=e.prev,e.prev.next=e.next,e.prevZ)e.prevZ.nextZ=e.nextZ;if(e.nextZ)e.nextZ.prevZ=e.prevZ}function Ja(e,t,n){this.i=e,this.x=t,this.y=n,this.prev=null,this.next=null,this.z=0,this.prevZ=null,this.nextZ=null,this.steiner=!1}function Q_(e,t,n,i){let s=0;for(let r=t,a=n-i;r<n;r+=i)s+=(e[a]-e[r])*(e[r+1]+e[a+1]),a=r;return s}class Sn{static area(e){let t=e.length,n=0;for(let i=t-1,s=0;s<t;i=s++)n+=e[i].x*e[s].y-e[s].x*e[i].y;return n*0.5}static isClockWise(e){return Sn.area(e)<0}static triangulateShape(e,t){let n=[],i=[],s=[];hc(e),uc(n,e);let r=e.length;t.forEach(hc);for(let o=0;o<t.length;o++)i.push(r),r+=t[o].length,uc(n,t[o]);let a=O_.triangulate(n,i);for(let o=0;o<a.length;o+=3)s.push(a.slice(o,o+3));return s}}function hc(e){let t=e.length;if(t>2&&e[t-1].equals(e[0]))e.pop()}function uc(e,t){for(let n=0;n<t.length;n++)e.push(t[n].x),e.push(t[n].y)}class Ao extends ze{constructor(e=new li([new W(0.5,0.5),new W(-0.5,0.5),new W(-0.5,-0.5),new W(0.5,-0.5)]),t={}){super();this.type="ExtrudeGeometry",this.parameters={shapes:e,options:t},e=Array.isArray(e)?e:[e];let n=this,i=[],s=[];for(let a=0,o=e.length;a<o;a++){let l=e[a];r(l)}this.setAttribute("position",new Ae(i,3)),this.setAttribute("uv",new Ae(s,2)),this.computeVertexNormals();function r(a){let o=[],l=t.curveSegments!==void 0?t.curveSegments:12,c=t.steps!==void 0?t.steps:1,h=t.depth!==void 0?t.depth:1,u=t.bevelEnabled!==void 0?t.bevelEnabled:!0,d=t.bevelThickness!==void 0?t.bevelThickness:0.2,f=t.bevelSize!==void 0?t.bevelSize:d-0.1,g=t.bevelOffset!==void 0?t.bevelOffset:0,_=t.bevelSegments!==void 0?t.bevelSegments:3,m=t.extrudePath,p=t.UVGenerator!==void 0?t.UVGenerator:e0,x,v=!1,b,R,M,C;if(m)x=m.getSpacedPoints(c),v=!0,u=!1,b=m.computeFrenetFrames(c,!1),R=new T,M=new T,C=new T;if(!u)_=0,d=0,f=0,g=0;let D=a.extractPoints(l),{shape:S,holes:w}=D;if(!Sn.isClockWise(S)){S=S.reverse();for(let P=0,ce=w.length;P<ce;P++){let j=w[P];if(Sn.isClockWise(j))w[P]=j.reverse()}}let J=Sn.triangulateShape(S,w),ae=S;for(let P=0,ce=w.length;P<ce;P++){let j=w[P];S=S.concat(j)}function I(P,ce,j){if(!ce)console.error("THREE.ExtrudeGeometry: vec does not exist");return P.clone().addScaledVector(ce,j)}let z=S.length,X=J.length;function ne(P,ce,j){let Q,Z,xe,Se=P.x-ce.x,be=P.y-ce.y,E=j.x-P.x,y=j.y-P.y,B=Se*Se+be*be,ie=Se*y-be*E;if(Math.abs(ie)>Number.EPSILON){let Y=Math.sqrt(B),se=Math.sqrt(E*E+y*y),Le=ce.x-be/Y,pe=ce.y+Se/Y,Te=j.x-y/se,Re=j.y+E/se,Fe=((Te-Le)*y-(Re-pe)*E)/(Se*y-be*E);Q=Le+Se*Fe-P.x,Z=pe+be*Fe-P.y;let K=Q*Q+Z*Z;if(K<=2)return new W(Q,Z);else xe=Math.sqrt(K/2)}else{let Y=!1;if(Se>Number.EPSILON){if(E>Number.EPSILON)Y=!0}else if(Se<-Number.EPSILON){if(E<-Number.EPSILON)Y=!0}else if(Math.sign(be)===Math.sign(y))Y=!0;if(Y)Q=-be,Z=Se,xe=Math.sqrt(B);else Q=Se,Z=be,xe=Math.sqrt(B/2)}return new W(Q/xe,Z/xe)}let V=[];for(let P=0,ce=ae.length,j=ce-1,Q=P+1;P<ce;P++,j++,Q++){if(j===ce)j=0;if(Q===ce)Q=0;V[P]=ne(ae[P],ae[j],ae[Q])}let q=[],ee,oe=V.concat();for(let P=0,ce=w.length;P<ce;P++){let j=w[P];ee=[];for(let Q=0,Z=j.length,xe=Z-1,Se=Q+1;Q<Z;Q++,xe++,Se++){if(xe===Z)xe=0;if(Se===Z)Se=0;ee[Q]=ne(j[Q],j[xe],j[Se])}q.push(ee),oe=oe.concat(ee)}for(let P=0;P<_;P++){let ce=P/_,j=d*Math.cos(ce*Math.PI/2),Q=f*Math.sin(ce*Math.PI/2)+g;for(let Z=0,xe=ae.length;Z<xe;Z++){let Se=I(ae[Z],V[Z],Q);Ee(Se.x,Se.y,-j)}for(let Z=0,xe=w.length;Z<xe;Z++){let Se=w[Z];ee=q[Z];for(let be=0,E=Se.length;be<E;be++){let y=I(Se[be],ee[be],Q);Ee(y.x,y.y,-j)}}}let O=f+g;for(let P=0;P<z;P++){let ce=u?I(S[P],oe[P],O):S[P];if(!v)Ee(ce.x,ce.y,0);else M.copy(b.normals[0]).multiplyScalar(ce.x),R.copy(b.binormals[0]).multiplyScalar(ce.y),C.copy(x[0]).add(M).add(R),Ee(C.x,C.y,C.z)}for(let P=1;P<=c;P++)for(let ce=0;ce<z;ce++){let j=u?I(S[ce],oe[ce],O):S[ce];if(!v)Ee(j.x,j.y,h/c*P);else M.copy(b.normals[P]).multiplyScalar(j.x),R.copy(b.binormals[P]).multiplyScalar(j.y),C.copy(x[P]).add(M).add(R),Ee(C.x,C.y,C.z)}for(let P=_-1;P>=0;P--){let ce=P/_,j=d*Math.cos(ce*Math.PI/2),Q=f*Math.sin(ce*Math.PI/2)+g;for(let Z=0,xe=ae.length;Z<xe;Z++){let Se=I(ae[Z],V[Z],Q);Ee(Se.x,Se.y,h+j)}for(let Z=0,xe=w.length;Z<xe;Z++){let Se=w[Z];ee=q[Z];for(let be=0,E=Se.length;be<E;be++){let y=I(Se[be],ee[be],Q);if(!v)Ee(y.x,y.y,h+j);else Ee(y.x,y.y+x[c-1].y,x[c-1].x+j)}}}te(),ge();function te(){let P=i.length/3;if(u){let ce=0,j=z*ce;for(let Q=0;Q<X;Q++){let Z=J[Q];Ie(Z[2]+j,Z[1]+j,Z[0]+j)}ce=c+_*2,j=z*ce;for(let Q=0;Q<X;Q++){let Z=J[Q];Ie(Z[0]+j,Z[1]+j,Z[2]+j)}}else{for(let ce=0;ce<X;ce++){let j=J[ce];Ie(j[2],j[1],j[0])}for(let ce=0;ce<X;ce++){let j=J[ce];Ie(j[0]+z*c,j[1]+z*c,j[2]+z*c)}}n.addGroup(P,i.length/3-P,0)}function ge(){let P=i.length/3,ce=0;ve(ae,ce),ce+=ae.length;for(let j=0,Q=w.length;j<Q;j++){let Z=w[j];ve(Z,ce),ce+=Z.length}n.addGroup(P,i.length/3-P,1)}function ve(P,ce){let j=P.length;while(--j>=0){let Q=j,Z=j-1;if(Z<0)Z=P.length-1;for(let xe=0,Se=c+_*2;xe<Se;xe++){let be=z*xe,E=z*(xe+1),y=ce+Q+be,B=ce+Z+be,ie=ce+Z+E,Y=ce+Q+E;ke(y,B,ie,Y)}}}function Ee(P,ce,j){o.push(P),o.push(ce),o.push(j)}function Ie(P,ce,j){we(P),we(ce),we(j);let Q=i.length/3,Z=p.generateTopUV(n,i,Q-3,Q-2,Q-1);Ge(Z[0]),Ge(Z[1]),Ge(Z[2])}function ke(P,ce,j,Q){we(P),we(ce),we(Q),we(ce),we(j),we(Q);let Z=i.length/3,xe=p.generateSideWallUV(n,i,Z-6,Z-3,Z-2,Z-1);Ge(xe[0]),Ge(xe[1]),Ge(xe[3]),Ge(xe[1]),Ge(xe[2]),Ge(xe[3])}function we(P){i.push(o[P*3+0]),i.push(o[P*3+1]),i.push(o[P*3+2])}function Ge(P){s.push(P.x),s.push(P.y)}}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON(),t=this.parameters.shapes,n=this.parameters.options;return t0(t,n,e)}static fromJSON(e,t){let n=[];for(let s=0,r=e.shapes.length;s<r;s++){let a=t[e.shapes[s]];n.push(a)}let i=e.options.extrudePath;if(i!==void 0)e.options.extrudePath=new Cr[i.type]().fromJSON(i);return new Ao(n,e.options)}}var e0={generateTopUV:function(e,t,n,i,s){let r=t[n*3],a=t[n*3+1],o=t[i*3],l=t[i*3+1],c=t[s*3],h=t[s*3+1];return[new W(r,a),new W(o,l),new W(c,h)]},generateSideWallUV:function(e,t,n,i,s,r){let a=t[n*3],o=t[n*3+1],l=t[n*3+2],c=t[i*3],h=t[i*3+1],u=t[i*3+2],d=t[s*3],f=t[s*3+1],g=t[s*3+2],_=t[r*3],m=t[r*3+1],p=t[r*3+2];if(Math.abs(o-h)<Math.abs(a-c))return[new W(a,1-l),new W(c,1-u),new W(d,1-g),new W(_,1-p)];else return[new W(o,1-l),new W(h,1-u),new W(f,1-g),new W(m,1-p)]}};function t0(e,t,n){if(n.shapes=[],Array.isArray(e))for(let i=0,s=e.length;i<s;i++){let r=e[i];n.shapes.push(r.uuid)}else n.shapes.push(e.uuid);if(n.options=Object.assign({},t),t.extrudePath!==void 0)n.options.extrudePath=t.extrudePath.toJSON();return n}class Eo extends pi{constructor(e=1,t=0){let n=(1+Math.sqrt(5))/2,i=[-1,n,0,1,n,0,-1,-n,0,1,-n,0,0,-1,n,0,1,n,0,-1,-n,0,1,-n,n,0,-1,n,0,1,-n,0,-1,-n,0,1],s=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];super(i,s,e,t);this.type="IcosahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new Eo(e.radius,e.detail)}}class Zr extends pi{constructor(e=1,t=0){let n=[1,0,0,-1,0,0,0,1,0,0,-1,0,0,0,1,0,0,-1],i=[0,2,4,0,4,3,0,3,5,0,5,2,1,2,5,1,5,3,1,3,4,1,4,2];super(n,i,e,t);this.type="OctahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new Zr(e.radius,e.detail)}}class wo extends ze{constructor(e=0.5,t=1,n=32,i=1,s=0,r=Math.PI*2){super();this.type="RingGeometry",this.parameters={innerRadius:e,outerRadius:t,thetaSegments:n,phiSegments:i,thetaStart:s,thetaLength:r},n=Math.max(3,n),i=Math.max(1,i);let a=[],o=[],l=[],c=[],h=e,u=(t-e)/i,d=new T,f=new W;for(let g=0;g<=i;g++){for(let _=0;_<=n;_++){let m=s+_/n*r;d.x=h*Math.cos(m),d.y=h*Math.sin(m),o.push(d.x,d.y,d.z),l.push(0,0,1),f.x=(d.x/t+1)/2,f.y=(d.y/t+1)/2,c.push(f.x,f.y)}h+=u}for(let g=0;g<i;g++){let _=g*(n+1);for(let m=0;m<n;m++){let p=m+_,x=p,v=p+n+1,b=p+n+2,R=p+1;a.push(x,v,R),a.push(v,b,R)}}this.setIndex(a),this.setAttribute("position",new Ae(o,3)),this.setAttribute("normal",new Ae(l,3)),this.setAttribute("uv",new Ae(c,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new wo(e.innerRadius,e.outerRadius,e.thetaSegments,e.phiSegments,e.thetaStart,e.thetaLength)}}class Ro extends ze{constructor(e=new li([new W(0,0.5),new W(-0.5,-0.5),new W(0.5,-0.5)]),t=12){super();this.type="ShapeGeometry",this.parameters={shapes:e,curveSegments:t};let n=[],i=[],s=[],r=[],a=0,o=0;if(Array.isArray(e)===!1)l(e);else for(let c=0;c<e.length;c++)l(e[c]),this.addGroup(a,o,c),a+=o,o=0;this.setIndex(n),this.setAttribute("position",new Ae(i,3)),this.setAttribute("normal",new Ae(s,3)),this.setAttribute("uv",new Ae(r,2));function l(c){let h=i.length/3,u=c.extractPoints(t),{shape:d,holes:f}=u;if(Sn.isClockWise(d)===!1)d=d.reverse();for(let _=0,m=f.length;_<m;_++){let p=f[_];if(Sn.isClockWise(p)===!0)f[_]=p.reverse()}let g=Sn.triangulateShape(d,f);for(let _=0,m=f.length;_<m;_++){let p=f[_];d=d.concat(p)}for(let _=0,m=d.length;_<m;_++){let p=d[_];i.push(p.x,p.y,0),s.push(0,0,1),r.push(p.x,p.y)}for(let _=0,m=g.length;_<m;_++){let p=g[_],x=p[0]+h,v=p[1]+h,b=p[2]+h;n.push(x,v,b),o+=3}}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON(),t=this.parameters.shapes;return n0(t,e)}static fromJSON(e,t){let n=[];for(let i=0,s=e.shapes.length;i<s;i++){let r=t[e.shapes[i]];n.push(r)}return new Ro(n,e.curveSegments)}}function n0(e,t){if(t.shapes=[],Array.isArray(e))for(let n=0,i=e.length;n<i;n++){let s=e[n];t.shapes.push(s.uuid)}else t.shapes.push(e.uuid);return t}class Kr extends ze{constructor(e=1,t=32,n=16,i=0,s=Math.PI*2,r=0,a=Math.PI){super();this.type="SphereGeometry",this.parameters={radius:e,widthSegments:t,heightSegments:n,phiStart:i,phiLength:s,thetaStart:r,thetaLength:a},t=Math.max(3,Math.floor(t)),n=Math.max(2,Math.floor(n));let o=Math.min(r+a,Math.PI),l=0,c=[],h=new T,u=new T,d=[],f=[],g=[],_=[];for(let m=0;m<=n;m++){let p=[],x=m/n,v=0;if(m===0&&r===0)v=0.5/t;else if(m===n&&o===Math.PI)v=-0.5/t;for(let b=0;b<=t;b++){let R=b/t;h.x=-e*Math.cos(i+R*s)*Math.sin(r+x*a),h.y=e*Math.cos(r+x*a),h.z=e*Math.sin(i+R*s)*Math.sin(r+x*a),f.push(h.x,h.y,h.z),u.copy(h).normalize(),g.push(u.x,u.y,u.z),_.push(R+v,1-x),p.push(l++)}c.push(p)}for(let m=0;m<n;m++)for(let p=0;p<t;p++){let x=c[m][p+1],v=c[m][p],b=c[m+1][p],R=c[m+1][p+1];if(m!==0||r>0)d.push(x,v,R);if(m!==n-1||o<Math.PI)d.push(v,b,R)}this.setIndex(d),this.setAttribute("position",new Ae(f,3)),this.setAttribute("normal",new Ae(g,3)),this.setAttribute("uv",new Ae(_,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Kr(e.radius,e.widthSegments,e.heightSegments,e.phiStart,e.phiLength,e.thetaStart,e.thetaLength)}}class Co extends pi{constructor(e=1,t=0){let n=[1,1,1,-1,-1,1,-1,1,-1,1,-1,-1],i=[2,1,0,0,3,2,1,3,0,2,3,1];super(n,i,e,t);this.type="TetrahedronGeometry",this.parameters={radius:e,detail:t}}static fromJSON(e){return new Co(e.radius,e.detail)}}class Po extends ze{constructor(e=1,t=0.4,n=12,i=48,s=Math.PI*2){super();this.type="TorusGeometry",this.parameters={radius:e,tube:t,radialSegments:n,tubularSegments:i,arc:s},n=Math.floor(n),i=Math.floor(i);let r=[],a=[],o=[],l=[],c=new T,h=new T,u=new T;for(let d=0;d<=n;d++)for(let f=0;f<=i;f++){let g=f/i*s,_=d/n*Math.PI*2;h.x=(e+t*Math.cos(_))*Math.cos(g),h.y=(e+t*Math.cos(_))*Math.sin(g),h.z=t*Math.sin(_),a.push(h.x,h.y,h.z),c.x=e*Math.cos(g),c.y=e*Math.sin(g),u.subVectors(h,c).normalize(),o.push(u.x,u.y,u.z),l.push(f/i),l.push(d/n)}for(let d=1;d<=n;d++)for(let f=1;f<=i;f++){let g=(i+1)*d+f-1,_=(i+1)*(d-1)+f-1,m=(i+1)*(d-1)+f,p=(i+1)*d+f;r.push(g,_,p),r.push(_,m,p)}this.setIndex(r),this.setAttribute("position",new Ae(a,3)),this.setAttribute("normal",new Ae(o,3)),this.setAttribute("uv",new Ae(l,2))}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Po(e.radius,e.tube,e.radialSegments,e.tubularSegments,e.arc)}}class Lo extends ze{constructor(e=1,t=0.4,n=64,i=8,s=2,r=3){super();this.type="TorusKnotGeometry",this.parameters={radius:e,tube:t,tubularSegments:n,radialSegments:i,p:s,q:r},n=Math.floor(n),i=Math.floor(i);let a=[],o=[],l=[],c=[],h=new T,u=new T,d=new T,f=new T,g=new T,_=new T,m=new T;for(let x=0;x<=n;++x){let v=x/n*s*Math.PI*2;p(v,s,r,e,d),p(v+0.01,s,r,e,f),_.subVectors(f,d),m.addVectors(f,d),g.crossVectors(_,m),m.crossVectors(g,_),g.normalize(),m.normalize();for(let b=0;b<=i;++b){let R=b/i*Math.PI*2,M=-t*Math.cos(R),C=t*Math.sin(R);h.x=d.x+(M*m.x+C*g.x),h.y=d.y+(M*m.y+C*g.y),h.z=d.z+(M*m.z+C*g.z),o.push(h.x,h.y,h.z),u.subVectors(h,d).normalize(),l.push(u.x,u.y,u.z),c.push(x/n),c.push(b/i)}}for(let x=1;x<=n;x++)for(let v=1;v<=i;v++){let b=(i+1)*(x-1)+(v-1),R=(i+1)*x+(v-1),M=(i+1)*x+v,C=(i+1)*(x-1)+v;a.push(b,R,C),a.push(R,M,C)}this.setIndex(a),this.setAttribute("position",new Ae(o,3)),this.setAttribute("normal",new Ae(l,3)),this.setAttribute("uv",new Ae(c,2));function p(x,v,b,R,M){let C=Math.cos(x),D=Math.sin(x),S=b/v*x,w=Math.cos(S);M.x=R*(2+w)*0.5*C,M.y=R*(2+w)*D*0.5,M.z=R*Math.sin(S)*0.5}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}static fromJSON(e){return new Lo(e.radius,e.tube,e.tubularSegments,e.radialSegments,e.p,e.q)}}class Io extends ze{constructor(e=new vo(new T(-1,-1,0),new T(-1,1,0),new T(1,1,0)),t=64,n=1,i=8,s=!1){super();this.type="TubeGeometry",this.parameters={path:e,tubularSegments:t,radius:n,radialSegments:i,closed:s};let r=e.computeFrenetFrames(t,s);this.tangents=r.tangents,this.normals=r.normals,this.binormals=r.binormals;let a=new T,o=new T,l=new W,c=new T,h=[],u=[],d=[],f=[];g(),this.setIndex(f),this.setAttribute("position",new Ae(h,3)),this.setAttribute("normal",new Ae(u,3)),this.setAttribute("uv",new Ae(d,2));function g(){for(let x=0;x<t;x++)_(x);_(s===!1?t:0),p(),m()}function _(x){c=e.getPointAt(x/t,c);let v=r.normals[x],b=r.binormals[x];for(let R=0;R<=i;R++){let M=R/i*Math.PI*2,C=Math.sin(M),D=-Math.cos(M);o.x=D*v.x+C*b.x,o.y=D*v.y+C*b.y,o.z=D*v.z+C*b.z,o.normalize(),u.push(o.x,o.y,o.z),a.x=c.x+n*o.x,a.y=c.y+n*o.y,a.z=c.z+n*o.z,h.push(a.x,a.y,a.z)}}function m(){for(let x=1;x<=t;x++)for(let v=1;v<=i;v++){let b=(i+1)*(x-1)+(v-1),R=(i+1)*x+(v-1),M=(i+1)*x+v,C=(i+1)*(x-1)+v;f.push(b,R,C),f.push(R,M,C)}}function p(){for(let x=0;x<=t;x++)for(let v=0;v<=i;v++)l.x=x/t,l.y=v/i,d.push(l.x,l.y)}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}toJSON(){let e=super.toJSON();return e.path=this.parameters.path.toJSON(),e}static fromJSON(e){return new Io(new Cr[e.path.type]().fromJSON(e.path),e.tubularSegments,e.radius,e.radialSegments,e.closed)}}class Nh extends ze{constructor(e=null){super();if(this.type="WireframeGeometry",this.parameters={geometry:e},e!==null){let t=[],n=new Set,i=new T,s=new T;if(e.index!==null){let r=e.attributes.position,{index:a,groups:o}=e;if(o.length===0)o=[{start:0,count:a.count,materialIndex:0}];for(let l=0,c=o.length;l<c;++l){let h=o[l],{start:u,count:d}=h;for(let f=u,g=u+d;f<g;f+=3)for(let _=0;_<3;_++){let m=a.getX(f+_),p=a.getX(f+(_+1)%3);if(i.fromBufferAttribute(r,m),s.fromBufferAttribute(r,p),dc(i,s,n)===!0)t.push(i.x,i.y,i.z),t.push(s.x,s.y,s.z)}}}else{let r=e.attributes.position;for(let a=0,o=r.count/3;a<o;a++)for(let l=0;l<3;l++){let c=3*a+l,h=3*a+(l+1)%3;if(i.fromBufferAttribute(r,c),s.fromBufferAttribute(r,h),dc(i,s,n)===!0)t.push(i.x,i.y,i.z),t.push(s.x,s.y,s.z)}}this.setAttribute("position",new Ae(t,3))}}copy(e){return super.copy(e),this.parameters=Object.assign({},e.parameters),this}}function dc(e,t,n){let i=`${e.x},${e.y},${e.z}-${t.x},${t.y},${t.z}`,s=`${t.x},${t.y},${t.z}-${e.x},${e.y},${e.z}`;if(n.has(i)===!0||n.has(s)===!0)return!1;else return n.add(i),n.add(s),!0}var fc=Object.freeze({__proto__:null,BoxGeometry:Bn,CapsuleGeometry:So,CircleGeometry:Mo,ConeGeometry:bo,CylinderGeometry:Ls,DodecahedronGeometry:To,EdgesGeometry:Ch,ExtrudeGeometry:Ao,IcosahedronGeometry:Eo,LatheGeometry:qr,OctahedronGeometry:Zr,PlaneGeometry:Or,PolyhedronGeometry:pi,RingGeometry:wo,ShapeGeometry:Ro,SphereGeometry:Kr,TetrahedronGeometry:Co,TorusGeometry:Po,TorusKnotGeometry:Lo,TubeGeometry:Io,WireframeGeometry:Nh});class Dh extends xt{constructor(e){super();this.isShadowMaterial=!0,this.type="ShadowMaterial",this.color=new ue(0),this.transparent=!0,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.fog=e.fog,this}}class Jr extends Et{constructor(e){super(e);this.isRawShaderMaterial=!0,this.type="RawShaderMaterial"}}class An extends xt{constructor(e){super();this.isMeshStandardMaterial=!0,this.defines={STANDARD:""},this.type="MeshStandardMaterial",this.color=new ue(16777215),this.roughness=1,this.metalness=0,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new ue(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.roughnessMap=null,this.metalnessMap=null,this.alphaMap=null,this.envMap=null,this.envMapIntensity=1,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.defines={STANDARD:""},this.color.copy(e.color),this.roughness=e.roughness,this.metalness=e.metalness,this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.roughnessMap=e.roughnessMap,this.metalnessMap=e.metalnessMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.envMapIntensity=e.envMapIntensity,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}}class Jt extends An{constructor(e){super();this.isMeshPhysicalMaterial=!0,this.defines={STANDARD:"",PHYSICAL:""},this.type="MeshPhysicalMaterial",this.anisotropyRotation=0,this.anisotropyMap=null,this.clearcoatMap=null,this.clearcoatRoughness=0,this.clearcoatRoughnessMap=null,this.clearcoatNormalScale=new W(1,1),this.clearcoatNormalMap=null,this.ior=1.5,Object.defineProperty(this,"reflectivity",{get:function(){return ft(2.5*(this.ior-1)/(this.ior+1),0,1)},set:function(t){this.ior=(1+0.4*t)/(1-0.4*t)}}),this.iridescenceMap=null,this.iridescenceIOR=1.3,this.iridescenceThicknessRange=[100,400],this.iridescenceThicknessMap=null,this.sheenColor=new ue(0),this.sheenColorMap=null,this.sheenRoughness=1,this.sheenRoughnessMap=null,this.transmissionMap=null,this.thickness=0,this.thicknessMap=null,this.attenuationDistance=1/0,this.attenuationColor=new ue(1,1,1),this.specularIntensity=1,this.specularIntensityMap=null,this.specularColor=new ue(1,1,1),this.specularColorMap=null,this._anisotropy=0,this._clearcoat=0,this._iridescence=0,this._sheen=0,this._transmission=0,this.setValues(e)}get anisotropy(){return this._anisotropy}set anisotropy(e){if(this._anisotropy>0!==e>0)this.version++;this._anisotropy=e}get clearcoat(){return this._clearcoat}set clearcoat(e){if(this._clearcoat>0!==e>0)this.version++;this._clearcoat=e}get iridescence(){return this._iridescence}set iridescence(e){if(this._iridescence>0!==e>0)this.version++;this._iridescence=e}get sheen(){return this._sheen}set sheen(e){if(this._sheen>0!==e>0)this.version++;this._sheen=e}get transmission(){return this._transmission}set transmission(e){if(this._transmission>0!==e>0)this.version++;this._transmission=e}copy(e){return super.copy(e),this.defines={STANDARD:"",PHYSICAL:""},this.anisotropy=e.anisotropy,this.anisotropyRotation=e.anisotropyRotation,this.anisotropyMap=e.anisotropyMap,this.clearcoat=e.clearcoat,this.clearcoatMap=e.clearcoatMap,this.clearcoatRoughness=e.clearcoatRoughness,this.clearcoatRoughnessMap=e.clearcoatRoughnessMap,this.clearcoatNormalMap=e.clearcoatNormalMap,this.clearcoatNormalScale.copy(e.clearcoatNormalScale),this.ior=e.ior,this.iridescence=e.iridescence,this.iridescenceMap=e.iridescenceMap,this.iridescenceIOR=e.iridescenceIOR,this.iridescenceThicknessRange=[...e.iridescenceThicknessRange],this.iridescenceThicknessMap=e.iridescenceThicknessMap,this.sheen=e.sheen,this.sheenColor.copy(e.sheenColor),this.sheenColorMap=e.sheenColorMap,this.sheenRoughness=e.sheenRoughness,this.sheenRoughnessMap=e.sheenRoughnessMap,this.transmission=e.transmission,this.transmissionMap=e.transmissionMap,this.thickness=e.thickness,this.thicknessMap=e.thicknessMap,this.attenuationDistance=e.attenuationDistance,this.attenuationColor.copy(e.attenuationColor),this.specularIntensity=e.specularIntensity,this.specularIntensityMap=e.specularIntensityMap,this.specularColor.copy(e.specularColor),this.specularColorMap=e.specularColorMap,this}}class Uh extends xt{constructor(e){super();this.isMeshPhongMaterial=!0,this.type="MeshPhongMaterial",this.color=new ue(16777215),this.specular=new ue(1118481),this.shininess=30,this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new ue(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=0,this.reflectivity=1,this.refractionRatio=0.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.specular.copy(e.specular),this.shininess=e.shininess,this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}}class Fh extends xt{constructor(e){super();this.isMeshToonMaterial=!0,this.defines={TOON:""},this.type="MeshToonMaterial",this.color=new ue(16777215),this.map=null,this.gradientMap=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new ue(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.gradientMap=e.gradientMap,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.alphaMap=e.alphaMap,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.fog=e.fog,this}}class Oh extends xt{constructor(e){super();this.isMeshNormalMaterial=!0,this.type="MeshNormalMaterial",this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.wireframe=!1,this.wireframeLinewidth=1,this.flatShading=!1,this.setValues(e)}copy(e){return super.copy(e),this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.flatShading=e.flatShading,this}}class Bh extends xt{constructor(e){super();this.isMeshLambertMaterial=!0,this.type="MeshLambertMaterial",this.color=new ue(16777215),this.map=null,this.lightMap=null,this.lightMapIntensity=1,this.aoMap=null,this.aoMapIntensity=1,this.emissive=new ue(0),this.emissiveIntensity=1,this.emissiveMap=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.specularMap=null,this.alphaMap=null,this.envMap=null,this.combine=0,this.reflectivity=1,this.refractionRatio=0.98,this.wireframe=!1,this.wireframeLinewidth=1,this.wireframeLinecap="round",this.wireframeLinejoin="round",this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.color.copy(e.color),this.map=e.map,this.lightMap=e.lightMap,this.lightMapIntensity=e.lightMapIntensity,this.aoMap=e.aoMap,this.aoMapIntensity=e.aoMapIntensity,this.emissive.copy(e.emissive),this.emissiveMap=e.emissiveMap,this.emissiveIntensity=e.emissiveIntensity,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.specularMap=e.specularMap,this.alphaMap=e.alphaMap,this.envMap=e.envMap,this.combine=e.combine,this.reflectivity=e.reflectivity,this.refractionRatio=e.refractionRatio,this.wireframe=e.wireframe,this.wireframeLinewidth=e.wireframeLinewidth,this.wireframeLinecap=e.wireframeLinecap,this.wireframeLinejoin=e.wireframeLinejoin,this.flatShading=e.flatShading,this.fog=e.fog,this}}class zh extends xt{constructor(e){super();this.isMeshMatcapMaterial=!0,this.defines={MATCAP:""},this.type="MeshMatcapMaterial",this.color=new ue(16777215),this.matcap=null,this.map=null,this.bumpMap=null,this.bumpScale=1,this.normalMap=null,this.normalMapType=0,this.normalScale=new W(1,1),this.displacementMap=null,this.displacementScale=1,this.displacementBias=0,this.alphaMap=null,this.flatShading=!1,this.fog=!0,this.setValues(e)}copy(e){return super.copy(e),this.defines={MATCAP:""},this.color.copy(e.color),this.matcap=e.matcap,this.map=e.map,this.bumpMap=e.bumpMap,this.bumpScale=e.bumpScale,this.normalMap=e.normalMap,this.normalMapType=e.normalMapType,this.normalScale.copy(e.normalScale),this.displacementMap=e.displacementMap,this.displacementScale=e.displacementScale,this.displacementBias=e.displacementBias,this.alphaMap=e.alphaMap,this.flatShading=e.flatShading,this.fog=e.fog,this}}class kh extends Pt{constructor(e){super();this.isLineDashedMaterial=!0,this.type="LineDashedMaterial",this.scale=1,this.dashSize=3,this.gapSize=1,this.setValues(e)}copy(e){return super.copy(e),this.scale=e.scale,this.dashSize=e.dashSize,this.gapSize=e.gapSize,this}}function ri(e,t,n){if(!e||!n&&e.constructor===t)return e;if(typeof t.BYTES_PER_ELEMENT==="number")return new t(e);return Array.prototype.slice.call(e)}function Gh(e){return ArrayBuffer.isView(e)&&!(e instanceof DataView)}function Hh(e){function t(s,r){return e[s]-e[r]}let n=e.length,i=Array(n);for(let s=0;s!==n;++s)i[s]=s;return i.sort(t),i}function $a(e,t,n){let i=e.length,s=new e.constructor(i);for(let r=0,a=0;a!==i;++r){let o=n[r]*t;for(let l=0;l!==t;++l)s[a++]=e[o+l]}return s}function No(e,t,n,i){let s=1,r=e[0];while(r!==void 0&&r[i]===void 0)r=e[s++];if(r===void 0)return;let a=r[i];if(a===void 0)return;if(Array.isArray(a))do{if(a=r[i],a!==void 0)t.push(r.time),n.push.apply(n,a);r=e[s++]}while(r!==void 0);else if(a.toArray!==void 0)do{if(a=r[i],a!==void 0)t.push(r.time),a.toArray(n,n.length);r=e[s++]}while(r!==void 0);else do{if(a=r[i],a!==void 0)t.push(r.time),n.push(a);r=e[s++]}while(r!==void 0)}function i0(e,t,n,i,s=30){let r=e.clone();r.name=t;let a=[];for(let l=0;l<r.tracks.length;++l){let c=r.tracks[l],h=c.getValueSize(),u=[],d=[];for(let f=0;f<c.times.length;++f){let g=c.times[f]*s;if(g<n||g>=i)continue;u.push(c.times[f]);for(let _=0;_<h;++_)d.push(c.values[f*h+_])}if(u.length===0)continue;c.times=ri(u,c.times.constructor),c.values=ri(d,c.values.constructor),a.push(c)}r.tracks=a;let o=1/0;for(let l=0;l<r.tracks.length;++l)if(o>r.tracks[l].times[0])o=r.tracks[l].times[0];for(let l=0;l<r.tracks.length;++l)r.tracks[l].shift(-1*o);return r.resetDuration(),r}function s0(e,t=0,n=e,i=30){if(i<=0)i=30;let s=n.tracks.length,r=t/i;for(let a=0;a<s;++a){let o=n.tracks[a],l=o.ValueTypeName;if(l==="bool"||l==="string")continue;let c=e.tracks.find(function(p){return p.name===o.name&&p.ValueTypeName===l});if(c===void 0)continue;let h=0,u=o.getValueSize();if(o.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline)h=u/3;let d=0,f=c.getValueSize();if(c.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline)d=f/3;let g=o.times.length-1,_;if(r<=o.times[0]){let p=h,x=u-h;_=o.values.slice(p,x)}else if(r>=o.times[g]){let p=g*u+h,x=p+u-h;_=o.values.slice(p,x)}else{let p=o.createInterpolant(),x=h,v=u-h;p.evaluate(r),_=p.resultBuffer.slice(x,v)}if(l==="quaternion")new _t().fromArray(_).normalize().conjugate().toArray(_);let m=c.times.length;for(let p=0;p<m;++p){let x=p*f+d;if(l==="quaternion")_t.multiplyQuaternionsFlat(c.values,x,_,0,c.values,x);else{let v=f-d*2;for(let b=0;b<v;++b)c.values[x+b]-=_[b]}}}return e.blendMode=2501,e}var TS={convertArray:ri,isTypedArray:Gh,getKeyframeOrder:Hh,sortedArray:$a,flattenJSON:No,subclip:i0,makeClipAdditive:s0};class mi{constructor(e,t,n,i){this.parameterPositions=e,this._cachedIndex=0,this.resultBuffer=i!==void 0?i:new t.constructor(n),this.sampleValues=t,this.valueSize=n,this.settings=null,this.DefaultSettings_={}}evaluate(e){let t=this.parameterPositions,n=this._cachedIndex,i=t[n],s=t[n-1];e:{t:{let r;n:{i:if(!(e<i)){for(let a=n+2;;){if(i===void 0){if(e<s)break i;return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}if(n===a)break;if(s=i,i=t[++n],e<i)break t}r=t.length;break n}if(!(e>=s)){let a=t[1];if(e<a)n=2,s=a;for(let o=n-2;;){if(s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(n===o)break;if(i=s,s=t[--n-1],e>=s)break t}r=n,n=0;break n}break e}while(n<r){let a=n+r>>>1;if(e<t[a])r=a;else n=a+1}if(i=t[n],s=t[n-1],s===void 0)return this._cachedIndex=0,this.copySampleValue_(0);if(i===void 0)return n=t.length,this._cachedIndex=n,this.copySampleValue_(n-1)}this._cachedIndex=n,this.intervalChanged_(n,s,i)}return this.interpolate_(n,s,e,i)}getSettings_(){return this.settings||this.DefaultSettings_}copySampleValue_(e){let t=this.resultBuffer,n=this.sampleValues,i=this.valueSize,s=e*i;for(let r=0;r!==i;++r)t[r]=n[s+r];return t}interpolate_(){throw Error("call to abstract method")}intervalChanged_(){}}class Wh extends mi{constructor(e,t,n,i){super(e,t,n,i);this._weightPrev=-0,this._offsetPrev=-0,this._weightNext=-0,this._offsetNext=-0,this.DefaultSettings_={endingStart:2400,endingEnd:2400}}intervalChanged_(e,t,n){let i=this.parameterPositions,s=e-2,r=e+1,a=i[s],o=i[r];if(a===void 0)switch(this.getSettings_().endingStart){case 2401:s=e,a=2*t-n;break;case 2402:s=i.length-2,a=t+i[s]-i[s+1];break;default:s=e,a=n}if(o===void 0)switch(this.getSettings_().endingEnd){case 2401:r=e,o=2*n-t;break;case 2402:r=1,o=n+i[1]-i[0];break;default:r=e-1,o=t}let l=(n-t)*0.5,c=this.valueSize;this._weightPrev=l/(t-a),this._weightNext=l/(o-n),this._offsetPrev=s*c,this._offsetNext=r*c}interpolate_(e,t,n,i){let s=this.resultBuffer,r=this.sampleValues,a=this.valueSize,o=e*a,l=o-a,c=this._offsetPrev,h=this._offsetNext,u=this._weightPrev,d=this._weightNext,f=(n-t)/(i-t),g=f*f,_=g*f,m=-u*_+2*u*g-u*f,p=(1+u)*_+(-1.5-2*u)*g+(-0.5+u)*f+1,x=(-1-d)*_+(1.5+d)*g+0.5*f,v=d*_-d*g;for(let b=0;b!==a;++b)s[b]=m*r[c+b]+p*r[l+b]+x*r[o+b]+v*r[h+b];return s}}class Do extends mi{constructor(e,t,n,i){super(e,t,n,i)}interpolate_(e,t,n,i){let s=this.resultBuffer,r=this.sampleValues,a=this.valueSize,o=e*a,l=o-a,c=(n-t)/(i-t),h=1-c;for(let u=0;u!==a;++u)s[u]=r[l+u]*h+r[o+u]*c;return s}}class Vh extends mi{constructor(e,t,n,i){super(e,t,n,i)}interpolate_(e){return this.copySampleValue_(e-1)}}class rn{constructor(e,t,n,i){if(e===void 0)throw Error("THREE.KeyframeTrack: track name is undefined");if(t===void 0||t.length===0)throw Error("THREE.KeyframeTrack: no keyframes in track named "+e);this.name=e,this.times=ri(t,this.TimeBufferType),this.values=ri(n,this.ValueBufferType),this.setInterpolation(i||this.DefaultInterpolation)}static toJSON(e){let t=e.constructor,n;if(t.toJSON!==this.toJSON)n=t.toJSON(e);else{n={name:e.name,times:ri(e.times,Array),values:ri(e.values,Array)};let i=e.getInterpolation();if(i!==e.DefaultInterpolation)n.interpolation=i}return n.type=e.ValueTypeName,n}InterpolantFactoryMethodDiscrete(e){return new Vh(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodLinear(e){return new Do(this.times,this.values,this.getValueSize(),e)}InterpolantFactoryMethodSmooth(e){return new Wh(this.times,this.values,this.getValueSize(),e)}setInterpolation(e){let t;switch(e){case 2300:t=this.InterpolantFactoryMethodDiscrete;break;case 2301:t=this.InterpolantFactoryMethodLinear;break;case 2302:t=this.InterpolantFactoryMethodSmooth;break}if(t===void 0){let n="unsupported interpolation for "+this.ValueTypeName+" keyframe track named "+this.name;if(this.createInterpolant===void 0)if(e!==this.DefaultInterpolation)this.setInterpolation(this.DefaultInterpolation);else throw Error(n);return console.warn("THREE.KeyframeTrack:",n),this}return this.createInterpolant=t,this}getInterpolation(){switch(this.createInterpolant){case this.InterpolantFactoryMethodDiscrete:return 2300;case this.InterpolantFactoryMethodLinear:return 2301;case this.InterpolantFactoryMethodSmooth:return 2302}}getValueSize(){return this.values.length/this.times.length}shift(e){if(e!==0){let t=this.times;for(let n=0,i=t.length;n!==i;++n)t[n]+=e}return this}scale(e){if(e!==1){let t=this.times;for(let n=0,i=t.length;n!==i;++n)t[n]*=e}return this}trim(e,t){let n=this.times,i=n.length,s=0,r=i-1;while(s!==i&&n[s]<e)++s;while(r!==-1&&n[r]>t)--r;if(++r,s!==0||r!==i){if(s>=r)r=Math.max(r,1),s=r-1;let a=this.getValueSize();this.times=n.slice(s,r),this.values=this.values.slice(s*a,r*a)}return this}validate(){let e=!0,t=this.getValueSize();if(t-Math.floor(t)!==0)console.error("THREE.KeyframeTrack: Invalid value size in track.",this),e=!1;let n=this.times,i=this.values,s=n.length;if(s===0)console.error("THREE.KeyframeTrack: Track is empty.",this),e=!1;let r=null;for(let a=0;a!==s;a++){let o=n[a];if(typeof o==="number"&&isNaN(o)){console.error("THREE.KeyframeTrack: Time is not a valid number.",this,a,o),e=!1;break}if(r!==null&&r>o){console.error("THREE.KeyframeTrack: Out of order keys.",this,a,o,r),e=!1;break}r=o}if(i!==void 0){if(Gh(i))for(let a=0,o=i.length;a!==o;++a){let l=i[a];if(isNaN(l)){console.error("THREE.KeyframeTrack: Value is not a valid number.",this,a,l),e=!1;break}}}return e}optimize(){let e=this.times.slice(),t=this.values.slice(),n=this.getValueSize(),i=this.getInterpolation()===2302,s=e.length-1,r=1;for(let a=1;a<s;++a){let o=!1,l=e[a],c=e[a+1];if(l!==c&&(a!==1||l!==e[0]))if(!i){let h=a*n,u=h-n,d=h+n;for(let f=0;f!==n;++f){let g=t[h+f];if(g!==t[u+f]||g!==t[d+f]){o=!0;break}}}else o=!0;if(o){if(a!==r){e[r]=e[a];let h=a*n,u=r*n;for(let d=0;d!==n;++d)t[u+d]=t[h+d]}++r}}if(s>0){e[r]=e[s];for(let a=s*n,o=r*n,l=0;l!==n;++l)t[o+l]=t[a+l];++r}if(r!==e.length)this.times=e.slice(0,r),this.values=t.slice(0,r*n);else this.times=e,this.values=t;return this}clone(){let e=this.times.slice(),t=this.values.slice(),i=new this.constructor(this.name,e,t);return i.createInterpolant=this.createInterpolant,i}}rn.prototype.TimeBufferType=Float32Array;rn.prototype.ValueBufferType=Float32Array;rn.prototype.DefaultInterpolation=2301;class gi extends rn{}gi.prototype.ValueTypeName="bool";gi.prototype.ValueBufferType=Array;gi.prototype.DefaultInterpolation=2300;gi.prototype.InterpolantFactoryMethodLinear=void 0;gi.prototype.InterpolantFactoryMethodSmooth=void 0;class Uo extends rn{}Uo.prototype.ValueTypeName="color";class Un extends rn{}Un.prototype.ValueTypeName="number";class Xh extends mi{constructor(e,t,n,i){super(e,t,n,i)}interpolate_(e,t,n,i){let s=this.resultBuffer,r=this.sampleValues,a=this.valueSize,o=(n-t)/(i-t),l=e*a;for(let c=l+a;l!==c;l+=4)_t.slerpFlat(s,0,r,l-a,r,l,o);return s}}class En extends rn{InterpolantFactoryMethodLinear(e){return new Xh(this.times,this.values,this.getValueSize(),e)}}En.prototype.ValueTypeName="quaternion";En.prototype.DefaultInterpolation=2301;En.prototype.InterpolantFactoryMethodSmooth=void 0;class _i extends rn{}_i.prototype.ValueTypeName="string";_i.prototype.ValueBufferType=Array;_i.prototype.DefaultInterpolation=2300;_i.prototype.InterpolantFactoryMethodLinear=void 0;_i.prototype.InterpolantFactoryMethodSmooth=void 0;class Fn extends rn{}Fn.prototype.ValueTypeName="vector";class hi{constructor(e,t=-1,n,i=2500){if(this.name=e,this.tracks=n,this.duration=t,this.blendMode=i,this.uuid=Xt(),this.duration<0)this.resetDuration()}static parse(e){let t=[],n=e.tracks,i=1/(e.fps||1);for(let r=0,a=n.length;r!==a;++r)t.push(a0(n[r]).scale(i));let s=new this(e.name,e.duration,t,e.blendMode);return s.uuid=e.uuid,s}static toJSON(e){let t=[],n=e.tracks,i={name:e.name,duration:e.duration,tracks:t,uuid:e.uuid,blendMode:e.blendMode};for(let s=0,r=n.length;s!==r;++s)t.push(rn.toJSON(n[s]));return i}static CreateFromMorphTargetSequence(e,t,n,i){let s=t.length,r=[];for(let a=0;a<s;a++){let o=[],l=[];o.push((a+s-1)%s,a,(a+1)%s),l.push(0,1,0);let c=Hh(o);if(o=$a(o,1,c),l=$a(l,1,c),!i&&o[0]===0)o.push(s),l.push(l[0]);r.push(new Un(".morphTargetInfluences["+t[a].name+"]",o,l).scale(1/n))}return new this(e,-1,r)}static findByName(e,t){let n=e;if(!Array.isArray(e)){let i=e;n=i.geometry&&i.geometry.animations||i.animations}for(let i=0;i<n.length;i++)if(n[i].name===t)return n[i];return null}static CreateClipsFromMorphTargetSequences(e,t,n){let i={},s=/^([\w-]*?)([\d]+)$/;for(let a=0,o=e.length;a<o;a++){let l=e[a],c=l.name.match(s);if(c&&c.length>1){let h=c[1],u=i[h];if(!u)i[h]=u=[];u.push(l)}}let r=[];for(let a in i)r.push(this.CreateFromMorphTargetSequence(a,i[a],t,n));return r}static parseAnimation(e,t){if(!e)return console.error("THREE.AnimationClip: No animation in JSONLoader data."),null;let n=function(h,u,d,f,g){if(d.length!==0){let _=[],m=[];if(No(d,_,m,f),_.length!==0)g.push(new h(u,_,m))}},i=[],s=e.name||"default",r=e.fps||30,a=e.blendMode,o=e.length||-1,l=e.hierarchy||[];for(let h=0;h<l.length;h++){let u=l[h].keys;if(!u||u.length===0)continue;if(u[0].morphTargets){let d={},f;for(f=0;f<u.length;f++)if(u[f].morphTargets)for(let g=0;g<u[f].morphTargets.length;g++)d[u[f].morphTargets[g]]=-1;for(let g in d){let _=[],m=[];for(let p=0;p!==u[f].morphTargets.length;++p){let x=u[f];_.push(x.time),m.push(x.morphTarget===g?1:0)}i.push(new Un(".morphTargetInfluence["+g+"]",_,m))}o=d.length*r}else{let d=".bones["+t[h].name+"]";n(Fn,d+".position",u,"pos",i),n(En,d+".quaternion",u,"rot",i),n(Fn,d+".scale",u,"scl",i)}}if(i.length===0)return null;return new this(s,o,i,a)}resetDuration(){let e=this.tracks,t=0;for(let n=0,i=e.length;n!==i;++n){let s=this.tracks[n];t=Math.max(t,s.times[s.times.length-1])}return this.duration=t,this}trim(){for(let e=0;e<this.tracks.length;e++)this.tracks[e].trim(0,this.duration);return this}validate(){let e=!0;for(let t=0;t<this.tracks.length;t++)e=e&&this.tracks[t].validate();return e}optimize(){for(let e=0;e<this.tracks.length;e++)this.tracks[e].optimize();return this}clone(){let e=[];for(let t=0;t<this.tracks.length;t++)e.push(this.tracks[t].clone());return new this.constructor(this.name,this.duration,e,this.blendMode)}toJSON(){return this.constructor.toJSON(this)}}function r0(e){switch(e.toLowerCase()){case"scalar":case"double":case"float":case"number":case"integer":return Un;case"vector":case"vector2":case"vector3":case"vector4":return Fn;case"color":return Uo;case"quaternion":return En;case"bool":case"boolean":return gi;case"string":return _i}throw Error("THREE.KeyframeTrack: Unsupported typeName: "+e)}function a0(e){if(e.type===void 0)throw Error("THREE.KeyframeTrack: track type undefined, can not parse");let t=r0(e.type);if(e.times===void 0){let n=[],i=[];No(e.keys,n,i,"value"),e.times=n,e.values=i}if(t.parse!==void 0)return t.parse(e);else return new t(e.name,e.times,e.values,e.interpolation)}var Dn={enabled:!1,files:{},add:function(e,t){if(this.enabled===!1)return;this.files[e]=t},get:function(e){if(this.enabled===!1)return;return this.files[e]},remove:function(e){delete this.files[e]},clear:function(){this.files={}}};class Fo{constructor(e,t,n){let i=this,s=!1,r=0,a=0,o=void 0,l=[];this.onStart=void 0,this.onLoad=e,this.onProgress=t,this.onError=n,this.itemStart=function(c){if(a++,s===!1){if(i.onStart!==void 0)i.onStart(c,r,a)}s=!0},this.itemEnd=function(c){if(r++,i.onProgress!==void 0)i.onProgress(c,r,a);if(r===a){if(s=!1,i.onLoad!==void 0)i.onLoad()}},this.itemError=function(c){if(i.onError!==void 0)i.onError(c)},this.resolveURL=function(c){if(o)return o(c);return c},this.setURLModifier=function(c){return o=c,this},this.addHandler=function(c,h){return l.push(c,h),this},this.removeHandler=function(c){let h=l.indexOf(c);if(h!==-1)l.splice(h,2);return this},this.getHandler=function(c){for(let h=0,u=l.length;h<u;h+=2){let d=l[h],f=l[h+1];if(d.global)d.lastIndex=0;if(d.test(c))return f}return null}}}var o0=new Fo;class Ut{constructor(e){this.manager=e!==void 0?e:o0,this.crossOrigin="anonymous",this.withCredentials=!1,this.path="",this.resourcePath="",this.requestHeader={}}load(){}loadAsync(e,t){let n=this;return new Promise(function(i,s){n.load(e,i,t,s)})}parse(){}setCrossOrigin(e){return this.crossOrigin=e,this}setWithCredentials(e){return this.withCredentials=e,this}setPath(e){return this.path=e,this}setResourcePath(e){return this.resourcePath=e,this}setRequestHeader(e){return this.requestHeader=e,this}}Ut.DEFAULT_MATERIAL_NAME="__DEFAULT";var vn={};class qh extends Error{constructor(e,t){super(e);this.response=t}}class Zt extends Ut{constructor(e){super(e)}load(e,t,n,i){if(e===void 0)e="";if(this.path!==void 0)e=this.path+e;e=this.manager.resolveURL(e);let s=Dn.get(e);if(s!==void 0)return this.manager.itemStart(e),setTimeout(()=>{if(t)t(s);this.manager.itemEnd(e)},0),s;if(vn[e]!==void 0){vn[e].push({onLoad:t,onProgress:n,onError:i});return}vn[e]=[],vn[e].push({onLoad:t,onProgress:n,onError:i});let r=new Request(e,{headers:new Headers(this.requestHeader),credentials:this.withCredentials?"include":"same-origin"}),a=this.mimeType,o=this.responseType;fetch(r).then((l)=>{if(l.status===200||l.status===0){if(l.status===0)console.warn("THREE.FileLoader: HTTP Status 0 received.");if(typeof ReadableStream>"u"||l.body===void 0||l.body.getReader===void 0)return l;let c=vn[e],h=l.body.getReader(),u=l.headers.get("Content-Length")||l.headers.get("X-File-Size"),d=u?parseInt(u):0,f=d!==0,g=0,_=new ReadableStream({start(m){p();function p(){h.read().then(({done:x,value:v})=>{if(x)m.close();else{g+=v.byteLength;let b=new ProgressEvent("progress",{lengthComputable:f,loaded:g,total:d});for(let R=0,M=c.length;R<M;R++){let C=c[R];if(C.onProgress)C.onProgress(b)}m.enqueue(v),p()}})}}});return new Response(_)}else throw new qh(`fetch for "${l.url}" responded with ${l.status}: ${l.statusText}`,l)}).then((l)=>{switch(o){case"arraybuffer":return l.arrayBuffer();case"blob":return l.blob();case"document":return l.text().then((c)=>new DOMParser().parseFromString(c,a));case"json":return l.json();default:if(a===void 0)return l.text();else{let h=/charset="?([^;"\s]*)"?/i.exec(a),u=h&&h[1]?h[1].toLowerCase():void 0,d=new TextDecoder(u);return l.arrayBuffer().then((f)=>d.decode(f))}}}).then((l)=>{Dn.add(e,l);let c=vn[e];delete vn[e];for(let h=0,u=c.length;h<u;h++){let d=c[h];if(d.onLoad)d.onLoad(l)}}).catch((l)=>{let c=vn[e];if(c===void 0)throw this.manager.itemError(e),l;delete vn[e];for(let h=0,u=c.length;h<u;h++){let d=c[h];if(d.onError)d.onError(l)}this.manager.itemError(e)}).finally(()=>{this.manager.itemEnd(e)}),this.manager.itemStart(e)}setResponseType(e){return this.responseType=e,this}setMimeType(e){return this.mimeType=e,this}}class l0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=new Zt(this.manager);r.setPath(this.path),r.setRequestHeader(this.requestHeader),r.setWithCredentials(this.withCredentials),r.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(o){if(i)i(o);else console.error(o);s.manager.itemError(e)}},n,i)}parse(e){let t=[];for(let n=0;n<e.length;n++){let i=hi.parse(e[n]);t.push(i)}return t}}class c0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=[],a=new Vr,o=new Zt(this.manager);o.setPath(this.path),o.setResponseType("arraybuffer"),o.setRequestHeader(this.requestHeader),o.setWithCredentials(s.withCredentials);let l=0;function c(h){o.load(e[h],function(u){let d=s.parse(u,!0);if(r[h]={width:d.width,height:d.height,format:d.format,mipmaps:d.mipmaps},l+=1,l===6){if(d.mipmapCount===1)a.minFilter=1006;if(a.image=r,a.format=d.format,a.needsUpdate=!0,t)t(a)}},n,i)}if(Array.isArray(e))for(let h=0,u=e.length;h<u;++h)c(h);else o.load(e,function(h){let u=s.parse(h,!0);if(u.isCubemap){let d=u.mipmaps.length/u.mipmapCount;for(let f=0;f<d;f++){r[f]={mipmaps:[]};for(let g=0;g<u.mipmapCount;g++)r[f].mipmaps.push(u.mipmaps[f*u.mipmapCount+g]),r[f].format=u.format,r[f].width=u.width,r[f].height=u.height}a.image=r}else a.image.width=u.width,a.image.height=u.height,a.mipmaps=u.mipmaps;if(u.mipmapCount===1)a.minFilter=1006;if(a.format=u.format,a.needsUpdate=!0,t)t(a)},n,i);return a}}class Ts extends Ut{constructor(e){super(e)}load(e,t,n,i){if(this.path!==void 0)e=this.path+e;e=this.manager.resolveURL(e);let s=this,r=Dn.get(e);if(r!==void 0)return s.manager.itemStart(e),setTimeout(function(){if(t)t(r);s.manager.itemEnd(e)},0),r;let a=vs("img");function o(){if(c(),Dn.add(e,this),t)t(this);s.manager.itemEnd(e)}function l(h){if(c(),i)i(h);s.manager.itemError(e),s.manager.itemEnd(e)}function c(){a.removeEventListener("load",o,!1),a.removeEventListener("error",l,!1)}if(a.addEventListener("load",o,!1),a.addEventListener("error",l,!1),e.slice(0,5)!=="data:"){if(this.crossOrigin!==void 0)a.crossOrigin=this.crossOrigin}return s.manager.itemStart(e),a.src=e,a}}class h0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=new Es;s.colorSpace="srgb";let r=new Ts(this.manager);r.setCrossOrigin(this.crossOrigin),r.setPath(this.path);let a=0;function o(l){r.load(e[l],function(c){if(s.images[l]=c,a++,a===6){if(s.needsUpdate=!0,t)t(s)}},void 0,i)}for(let l=0;l<e.length;++l)o(l);return s}}class u0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=new oi,a=new Zt(this.manager);return a.setResponseType("arraybuffer"),a.setRequestHeader(this.requestHeader),a.setPath(this.path),a.setWithCredentials(s.withCredentials),a.load(e,function(o){let l;try{l=s.parse(o)}catch(c){if(i!==void 0)i(c);else{console.error(c);return}}if(l.image!==void 0)r.image=l.image;else if(l.data!==void 0)r.image.width=l.width,r.image.height=l.height,r.image.data=l.data;if(r.wrapS=l.wrapS!==void 0?l.wrapS:1001,r.wrapT=l.wrapT!==void 0?l.wrapT:1001,r.magFilter=l.magFilter!==void 0?l.magFilter:1006,r.minFilter=l.minFilter!==void 0?l.minFilter:1006,r.anisotropy=l.anisotropy!==void 0?l.anisotropy:1,l.colorSpace!==void 0)r.colorSpace=l.colorSpace;else if(l.encoding!==void 0)r.encoding=l.encoding;if(l.flipY!==void 0)r.flipY=l.flipY;if(l.format!==void 0)r.format=l.format;if(l.type!==void 0)r.type=l.type;if(l.mipmaps!==void 0)r.mipmaps=l.mipmaps,r.minFilter=1008;if(l.mipmapCount===1)r.minFilter=1006;if(l.generateMipmaps!==void 0)r.generateMipmaps=l.generateMipmaps;if(r.needsUpdate=!0,t)t(r,l)},n,i),r}}class Oo extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=new ht,r=new Ts(this.manager);return r.setCrossOrigin(this.crossOrigin),r.setPath(this.path),r.load(e,function(a){if(s.image=a,s.needsUpdate=!0,t!==void 0)t(s)},n,i),s}}class Gn extends et{constructor(e,t=1){super();this.isLight=!0,this.type="Light",this.color=new ue(e),this.intensity=t}dispose(){}copy(e,t){return super.copy(e,t),this.color.copy(e.color),this.intensity=e.intensity,this}toJSON(e){let t=super.toJSON(e);if(t.object.color=this.color.getHex(),t.object.intensity=this.intensity,this.groundColor!==void 0)t.object.groundColor=this.groundColor.getHex();if(this.distance!==void 0)t.object.distance=this.distance;if(this.angle!==void 0)t.object.angle=this.angle;if(this.decay!==void 0)t.object.decay=this.decay;if(this.penumbra!==void 0)t.object.penumbra=this.penumbra;if(this.shadow!==void 0)t.object.shadow=this.shadow.toJSON();return t}}class Yh extends Gn{constructor(e,t,n){super(e,n);this.isHemisphereLight=!0,this.type="HemisphereLight",this.position.copy(et.DEFAULT_UP),this.updateMatrix(),this.groundColor=new ue(t)}copy(e,t){return super.copy(e,t),this.groundColor.copy(e.groundColor),this}}var Ga=new De,pc=new T,mc=new T;class $r{constructor(e){this.camera=e,this.bias=0,this.normalBias=0,this.radius=1,this.blurSamples=8,this.mapSize=new W(512,512),this.map=null,this.mapPass=null,this.matrix=new De,this.autoUpdate=!0,this.needsUpdate=!1,this._frustum=new ws,this._frameExtents=new W(1,1),this._viewportCount=1,this._viewports=[new at(0,0,1,1)]}getViewportCount(){return this._viewportCount}getFrustum(){return this._frustum}updateMatrices(e){let t=this.camera,n=this.matrix;pc.setFromMatrixPosition(e.matrixWorld),t.position.copy(pc),mc.setFromMatrixPosition(e.target.matrixWorld),t.lookAt(mc),t.updateMatrixWorld(),Ga.multiplyMatrices(t.projectionMatrix,t.matrixWorldInverse),this._frustum.setFromProjectionMatrix(Ga),n.set(0.5,0,0,0.5,0,0.5,0,0.5,0,0,0.5,0.5,0,0,0,1),n.multiply(Ga)}getViewport(e){return this._viewports[e]}getFrameExtents(){return this._frameExtents}dispose(){if(this.map)this.map.dispose();if(this.mapPass)this.mapPass.dispose()}copy(e){return this.camera=e.camera.clone(),this.bias=e.bias,this.radius=e.radius,this.mapSize.copy(e.mapSize),this}clone(){return new this.constructor().copy(this)}toJSON(){let e={};if(this.bias!==0)e.bias=this.bias;if(this.normalBias!==0)e.normalBias=this.normalBias;if(this.radius!==1)e.radius=this.radius;if(this.mapSize.x!==512||this.mapSize.y!==512)e.mapSize=this.mapSize.toArray();return e.camera=this.camera.toJSON(!1).object,delete e.camera.matrix,e}}class Zh extends $r{constructor(){super(new yt(50,1,0.5,500));this.isSpotLightShadow=!0,this.focus=1}updateMatrices(e){let t=this.camera,n=qi*2*e.angle*this.focus,i=this.mapSize.width/this.mapSize.height,s=e.distance||t.far;if(n!==t.fov||i!==t.aspect||s!==t.far)t.fov=n,t.aspect=i,t.far=s,t.updateProjectionMatrix();super.updateMatrices(e)}copy(e){return super.copy(e),this.focus=e.focus,this}}class jr extends Gn{constructor(e,t,n=0,i=Math.PI/3,s=0,r=2){super(e,t);this.isSpotLight=!0,this.type="SpotLight",this.position.copy(et.DEFAULT_UP),this.updateMatrix(),this.target=new et,this.distance=n,this.angle=i,this.penumbra=s,this.decay=r,this.map=null,this.shadow=new Zh}get power(){return this.intensity*Math.PI}set power(e){this.intensity=e/Math.PI}dispose(){this.shadow.dispose()}copy(e,t){return super.copy(e,t),this.distance=e.distance,this.angle=e.angle,this.penumbra=e.penumbra,this.decay=e.decay,this.target=e.target.clone(),this.shadow=e.shadow.clone(),this}}var gc=new De,ds=new T,Ha=new T;class Kh extends $r{constructor(){super(new yt(90,1,0.5,500));this.isPointLightShadow=!0,this._frameExtents=new W(4,2),this._viewportCount=6,this._viewports=[new at(2,1,1,1),new at(0,1,1,1),new at(3,1,1,1),new at(1,1,1,1),new at(3,0,1,1),new at(1,0,1,1)],this._cubeDirections=[new T(1,0,0),new T(-1,0,0),new T(0,0,1),new T(0,0,-1),new T(0,1,0),new T(0,-1,0)],this._cubeUps=[new T(0,1,0),new T(0,1,0),new T(0,1,0),new T(0,1,0),new T(0,0,1),new T(0,0,-1)]}updateMatrices(e,t=0){let n=this.camera,i=this.matrix,s=e.distance||n.far;if(s!==n.far)n.far=s,n.updateProjectionMatrix();ds.setFromMatrixPosition(e.matrixWorld),n.position.copy(ds),Ha.copy(n.position),Ha.add(this._cubeDirections[t]),n.up.copy(this._cubeUps[t]),n.lookAt(Ha),n.updateMatrixWorld(),i.makeTranslation(-ds.x,-ds.y,-ds.z),gc.multiplyMatrices(n.projectionMatrix,n.matrixWorldInverse),this._frustum.setFromProjectionMatrix(gc)}}class $i extends Gn{constructor(e,t,n=0,i=2){super(e,t);this.isPointLight=!0,this.type="PointLight",this.distance=n,this.decay=i,this.shadow=new Kh}get power(){return this.intensity*4*Math.PI}set power(e){this.intensity=e/(4*Math.PI)}dispose(){this.shadow.dispose()}copy(e,t){return super.copy(e,t),this.distance=e.distance,this.decay=e.decay,this.shadow=e.shadow.clone(),this}}class Jh extends $r{constructor(){super(new kn(-5,5,5,-5,0.5,500));this.isDirectionalLightShadow=!0}}class Qr extends Gn{constructor(e,t){super(e,t);this.isDirectionalLight=!0,this.type="DirectionalLight",this.position.copy(et.DEFAULT_UP),this.updateMatrix(),this.target=new et,this.shadow=new Jh}dispose(){this.shadow.dispose()}copy(e){return super.copy(e),this.target=e.target.clone(),this.shadow=e.shadow.clone(),this}}class $h extends Gn{constructor(e,t){super(e,t);this.isAmbientLight=!0,this.type="AmbientLight"}}class jh extends Gn{constructor(e,t,n=10,i=10){super(e,t);this.isRectAreaLight=!0,this.type="RectAreaLight",this.width=n,this.height=i}get power(){return this.intensity*this.width*this.height*Math.PI}set power(e){this.intensity=e/(this.width*this.height*Math.PI)}copy(e){return super.copy(e),this.width=e.width,this.height=e.height,this}toJSON(e){let t=super.toJSON(e);return t.object.width=this.width,t.object.height=this.height,t}}class Qh{constructor(){this.isSphericalHarmonics3=!0,this.coefficients=[];for(let e=0;e<9;e++)this.coefficients.push(new T)}set(e){for(let t=0;t<9;t++)this.coefficients[t].copy(e[t]);return this}zero(){for(let e=0;e<9;e++)this.coefficients[e].set(0,0,0);return this}getAt(e,t){let{x:n,y:i,z:s}=e,r=this.coefficients;return t.copy(r[0]).multiplyScalar(0.282095),t.addScaledVector(r[1],0.488603*i),t.addScaledVector(r[2],0.488603*s),t.addScaledVector(r[3],0.488603*n),t.addScaledVector(r[4],1.092548*(n*i)),t.addScaledVector(r[5],1.092548*(i*s)),t.addScaledVector(r[6],0.315392*(3*s*s-1)),t.addScaledVector(r[7],1.092548*(n*s)),t.addScaledVector(r[8],0.546274*(n*n-i*i)),t}getIrradianceAt(e,t){let{x:n,y:i,z:s}=e,r=this.coefficients;return t.copy(r[0]).multiplyScalar(0.886227),t.addScaledVector(r[1],1.023328*i),t.addScaledVector(r[2],1.023328*s),t.addScaledVector(r[3],1.023328*n),t.addScaledVector(r[4],0.858086*n*i),t.addScaledVector(r[5],0.858086*i*s),t.addScaledVector(r[6],0.743125*s*s-0.247708),t.addScaledVector(r[7],0.858086*n*s),t.addScaledVector(r[8],0.429043*(n*n-i*i)),t}add(e){for(let t=0;t<9;t++)this.coefficients[t].add(e.coefficients[t]);return this}addScaledSH(e,t){for(let n=0;n<9;n++)this.coefficients[n].addScaledVector(e.coefficients[n],t);return this}scale(e){for(let t=0;t<9;t++)this.coefficients[t].multiplyScalar(e);return this}lerp(e,t){for(let n=0;n<9;n++)this.coefficients[n].lerp(e.coefficients[n],t);return this}equals(e){for(let t=0;t<9;t++)if(!this.coefficients[t].equals(e.coefficients[t]))return!1;return!0}copy(e){return this.set(e.coefficients)}clone(){return new this.constructor().copy(this)}fromArray(e,t=0){let n=this.coefficients;for(let i=0;i<9;i++)n[i].fromArray(e,t+i*3);return this}toArray(e=[],t=0){let n=this.coefficients;for(let i=0;i<9;i++)n[i].toArray(e,t+i*3);return e}static getBasisAt(e,t){let{x:n,y:i,z:s}=e;t[0]=0.282095,t[1]=0.488603*i,t[2]=0.488603*s,t[3]=0.488603*n,t[4]=1.092548*n*i,t[5]=1.092548*i*s,t[6]=0.315392*(3*s*s-1),t[7]=1.092548*n*s,t[8]=0.546274*(n*n-i*i)}}class eu extends Gn{constructor(e=new Qh,t=1){super(void 0,t);this.isLightProbe=!0,this.sh=e}copy(e){return super.copy(e),this.sh.copy(e.sh),this}fromJSON(e){return this.intensity=e.intensity,this.sh.fromArray(e.sh),this}toJSON(e){let t=super.toJSON(e);return t.object.sh=this.sh.toArray(),t}}class Bo extends Ut{constructor(e){super(e);this.textures={}}load(e,t,n,i){let s=this,r=new Zt(s.manager);r.setPath(s.path),r.setRequestHeader(s.requestHeader),r.setWithCredentials(s.withCredentials),r.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(o){if(i)i(o);else console.error(o);s.manager.itemError(e)}},n,i)}parse(e){let t=this.textures;function n(s){if(t[s]===void 0)console.warn("THREE.MaterialLoader: Undefined texture",s);return t[s]}let i=Bo.createMaterialFromType(e.type);if(e.uuid!==void 0)i.uuid=e.uuid;if(e.name!==void 0)i.name=e.name;if(e.color!==void 0&&i.color!==void 0)i.color.setHex(e.color);if(e.roughness!==void 0)i.roughness=e.roughness;if(e.metalness!==void 0)i.metalness=e.metalness;if(e.sheen!==void 0)i.sheen=e.sheen;if(e.sheenColor!==void 0)i.sheenColor=new ue().setHex(e.sheenColor);if(e.sheenRoughness!==void 0)i.sheenRoughness=e.sheenRoughness;if(e.emissive!==void 0&&i.emissive!==void 0)i.emissive.setHex(e.emissive);if(e.specular!==void 0&&i.specular!==void 0)i.specular.setHex(e.specular);if(e.specularIntensity!==void 0)i.specularIntensity=e.specularIntensity;if(e.specularColor!==void 0&&i.specularColor!==void 0)i.specularColor.setHex(e.specularColor);if(e.shininess!==void 0)i.shininess=e.shininess;if(e.clearcoat!==void 0)i.clearcoat=e.clearcoat;if(e.clearcoatRoughness!==void 0)i.clearcoatRoughness=e.clearcoatRoughness;if(e.iridescence!==void 0)i.iridescence=e.iridescence;if(e.iridescenceIOR!==void 0)i.iridescenceIOR=e.iridescenceIOR;if(e.iridescenceThicknessRange!==void 0)i.iridescenceThicknessRange=e.iridescenceThicknessRange;if(e.transmission!==void 0)i.transmission=e.transmission;if(e.thickness!==void 0)i.thickness=e.thickness;if(e.attenuationDistance!==void 0)i.attenuationDistance=e.attenuationDistance;if(e.attenuationColor!==void 0&&i.attenuationColor!==void 0)i.attenuationColor.setHex(e.attenuationColor);if(e.anisotropy!==void 0)i.anisotropy=e.anisotropy;if(e.anisotropyRotation!==void 0)i.anisotropyRotation=e.anisotropyRotation;if(e.fog!==void 0)i.fog=e.fog;if(e.flatShading!==void 0)i.flatShading=e.flatShading;if(e.blending!==void 0)i.blending=e.blending;if(e.combine!==void 0)i.combine=e.combine;if(e.side!==void 0)i.side=e.side;if(e.shadowSide!==void 0)i.shadowSide=e.shadowSide;if(e.opacity!==void 0)i.opacity=e.opacity;if(e.transparent!==void 0)i.transparent=e.transparent;if(e.alphaTest!==void 0)i.alphaTest=e.alphaTest;if(e.alphaHash!==void 0)i.alphaHash=e.alphaHash;if(e.depthFunc!==void 0)i.depthFunc=e.depthFunc;if(e.depthTest!==void 0)i.depthTest=e.depthTest;if(e.depthWrite!==void 0)i.depthWrite=e.depthWrite;if(e.colorWrite!==void 0)i.colorWrite=e.colorWrite;if(e.blendSrc!==void 0)i.blendSrc=e.blendSrc;if(e.blendDst!==void 0)i.blendDst=e.blendDst;if(e.blendEquation!==void 0)i.blendEquation=e.blendEquation;if(e.blendSrcAlpha!==void 0)i.blendSrcAlpha=e.blendSrcAlpha;if(e.blendDstAlpha!==void 0)i.blendDstAlpha=e.blendDstAlpha;if(e.blendEquationAlpha!==void 0)i.blendEquationAlpha=e.blendEquationAlpha;if(e.blendColor!==void 0&&i.blendColor!==void 0)i.blendColor.setHex(e.blendColor);if(e.blendAlpha!==void 0)i.blendAlpha=e.blendAlpha;if(e.stencilWriteMask!==void 0)i.stencilWriteMask=e.stencilWriteMask;if(e.stencilFunc!==void 0)i.stencilFunc=e.stencilFunc;if(e.stencilRef!==void 0)i.stencilRef=e.stencilRef;if(e.stencilFuncMask!==void 0)i.stencilFuncMask=e.stencilFuncMask;if(e.stencilFail!==void 0)i.stencilFail=e.stencilFail;if(e.stencilZFail!==void 0)i.stencilZFail=e.stencilZFail;if(e.stencilZPass!==void 0)i.stencilZPass=e.stencilZPass;if(e.stencilWrite!==void 0)i.stencilWrite=e.stencilWrite;if(e.wireframe!==void 0)i.wireframe=e.wireframe;if(e.wireframeLinewidth!==void 0)i.wireframeLinewidth=e.wireframeLinewidth;if(e.wireframeLinecap!==void 0)i.wireframeLinecap=e.wireframeLinecap;if(e.wireframeLinejoin!==void 0)i.wireframeLinejoin=e.wireframeLinejoin;if(e.rotation!==void 0)i.rotation=e.rotation;if(e.linewidth!==void 0)i.linewidth=e.linewidth;if(e.dashSize!==void 0)i.dashSize=e.dashSize;if(e.gapSize!==void 0)i.gapSize=e.gapSize;if(e.scale!==void 0)i.scale=e.scale;if(e.polygonOffset!==void 0)i.polygonOffset=e.polygonOffset;if(e.polygonOffsetFactor!==void 0)i.polygonOffsetFactor=e.polygonOffsetFactor;if(e.polygonOffsetUnits!==void 0)i.polygonOffsetUnits=e.polygonOffsetUnits;if(e.dithering!==void 0)i.dithering=e.dithering;if(e.alphaToCoverage!==void 0)i.alphaToCoverage=e.alphaToCoverage;if(e.premultipliedAlpha!==void 0)i.premultipliedAlpha=e.premultipliedAlpha;if(e.forceSinglePass!==void 0)i.forceSinglePass=e.forceSinglePass;if(e.visible!==void 0)i.visible=e.visible;if(e.toneMapped!==void 0)i.toneMapped=e.toneMapped;if(e.userData!==void 0)i.userData=e.userData;if(e.vertexColors!==void 0)if(typeof e.vertexColors==="number")i.vertexColors=e.vertexColors>0?!0:!1;else i.vertexColors=e.vertexColors;if(e.uniforms!==void 0)for(let s in e.uniforms){let r=e.uniforms[s];switch(i.uniforms[s]={},r.type){case"t":i.uniforms[s].value=n(r.value);break;case"c":i.uniforms[s].value=new ue().setHex(r.value);break;case"v2":i.uniforms[s].value=new W().fromArray(r.value);break;case"v3":i.uniforms[s].value=new T().fromArray(r.value);break;case"v4":i.uniforms[s].value=new at().fromArray(r.value);break;case"m3":i.uniforms[s].value=new Ze().fromArray(r.value);break;case"m4":i.uniforms[s].value=new De().fromArray(r.value);break;default:i.uniforms[s].value=r.value}}if(e.defines!==void 0)i.defines=e.defines;if(e.vertexShader!==void 0)i.vertexShader=e.vertexShader;if(e.fragmentShader!==void 0)i.fragmentShader=e.fragmentShader;if(e.glslVersion!==void 0)i.glslVersion=e.glslVersion;if(e.extensions!==void 0)for(let s in e.extensions)i.extensions[s]=e.extensions[s];if(e.lights!==void 0)i.lights=e.lights;if(e.clipping!==void 0)i.clipping=e.clipping;if(e.size!==void 0)i.size=e.size;if(e.sizeAttenuation!==void 0)i.sizeAttenuation=e.sizeAttenuation;if(e.map!==void 0)i.map=n(e.map);if(e.matcap!==void 0)i.matcap=n(e.matcap);if(e.alphaMap!==void 0)i.alphaMap=n(e.alphaMap);if(e.bumpMap!==void 0)i.bumpMap=n(e.bumpMap);if(e.bumpScale!==void 0)i.bumpScale=e.bumpScale;if(e.normalMap!==void 0)i.normalMap=n(e.normalMap);if(e.normalMapType!==void 0)i.normalMapType=e.normalMapType;if(e.normalScale!==void 0){let s=e.normalScale;if(Array.isArray(s)===!1)s=[s,s];i.normalScale=new W().fromArray(s)}if(e.displacementMap!==void 0)i.displacementMap=n(e.displacementMap);if(e.displacementScale!==void 0)i.displacementScale=e.displacementScale;if(e.displacementBias!==void 0)i.displacementBias=e.displacementBias;if(e.roughnessMap!==void 0)i.roughnessMap=n(e.roughnessMap);if(e.metalnessMap!==void 0)i.metalnessMap=n(e.metalnessMap);if(e.emissiveMap!==void 0)i.emissiveMap=n(e.emissiveMap);if(e.emissiveIntensity!==void 0)i.emissiveIntensity=e.emissiveIntensity;if(e.specularMap!==void 0)i.specularMap=n(e.specularMap);if(e.specularIntensityMap!==void 0)i.specularIntensityMap=n(e.specularIntensityMap);if(e.specularColorMap!==void 0)i.specularColorMap=n(e.specularColorMap);if(e.envMap!==void 0)i.envMap=n(e.envMap);if(e.envMapIntensity!==void 0)i.envMapIntensity=e.envMapIntensity;if(e.reflectivity!==void 0)i.reflectivity=e.reflectivity;if(e.refractionRatio!==void 0)i.refractionRatio=e.refractionRatio;if(e.lightMap!==void 0)i.lightMap=n(e.lightMap);if(e.lightMapIntensity!==void 0)i.lightMapIntensity=e.lightMapIntensity;if(e.aoMap!==void 0)i.aoMap=n(e.aoMap);if(e.aoMapIntensity!==void 0)i.aoMapIntensity=e.aoMapIntensity;if(e.gradientMap!==void 0)i.gradientMap=n(e.gradientMap);if(e.clearcoatMap!==void 0)i.clearcoatMap=n(e.clearcoatMap);if(e.clearcoatRoughnessMap!==void 0)i.clearcoatRoughnessMap=n(e.clearcoatRoughnessMap);if(e.clearcoatNormalMap!==void 0)i.clearcoatNormalMap=n(e.clearcoatNormalMap);if(e.clearcoatNormalScale!==void 0)i.clearcoatNormalScale=new W().fromArray(e.clearcoatNormalScale);if(e.iridescenceMap!==void 0)i.iridescenceMap=n(e.iridescenceMap);if(e.iridescenceThicknessMap!==void 0)i.iridescenceThicknessMap=n(e.iridescenceThicknessMap);if(e.transmissionMap!==void 0)i.transmissionMap=n(e.transmissionMap);if(e.thicknessMap!==void 0)i.thicknessMap=n(e.thicknessMap);if(e.anisotropyMap!==void 0)i.anisotropyMap=n(e.anisotropyMap);if(e.sheenColorMap!==void 0)i.sheenColorMap=n(e.sheenColorMap);if(e.sheenRoughnessMap!==void 0)i.sheenRoughnessMap=n(e.sheenRoughnessMap);return i}setTextures(e){return this.textures=e,this}static createMaterialFromType(e){return new{ShadowMaterial:Dh,SpriteMaterial:po,RawShaderMaterial:Jr,ShaderMaterial:Et,PointsMaterial:Ps,MeshPhysicalMaterial:Jt,MeshStandardMaterial:An,MeshPhongMaterial:Uh,MeshToonMaterial:Fh,MeshNormalMaterial:Oh,MeshLambertMaterial:Bh,MeshDepthMaterial:co,MeshDistanceMaterial:ho,MeshBasicMaterial:wt,MeshMatcapMaterial:zh,LineDashedMaterial:kh,LineBasicMaterial:Pt,Material:xt}[e]}}class Tn{static decodeText(e){if(typeof TextDecoder<"u")return new TextDecoder().decode(e);let t="";for(let n=0,i=e.length;n<i;n++)t+=String.fromCharCode(e[n]);try{return decodeURIComponent(escape(t))}catch(n){return t}}static extractUrlBase(e){let t=e.lastIndexOf("/");if(t===-1)return"./";return e.slice(0,t+1)}static resolveURL(e,t){if(typeof e!=="string"||e==="")return"";if(/^https?:\/\//i.test(t)&&/^\//.test(e))t=t.replace(/(^https?:\/\/[^\/]+).*/i,"$1");if(/^(https?:)?\/\//i.test(e))return e;if(/^data:.*,.*$/i.test(e))return e;if(/^blob:.*$/i.test(e))return e;return t+e}}class tu extends ze{constructor(){super();this.isInstancedBufferGeometry=!0,this.type="InstancedBufferGeometry",this.instanceCount=1/0}copy(e){return super.copy(e),this.instanceCount=e.instanceCount,this}toJSON(){let e=super.toJSON();return e.instanceCount=this.instanceCount,e.isInstancedBufferGeometry=!0,e}}class nu extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=new Zt(s.manager);r.setPath(s.path),r.setRequestHeader(s.requestHeader),r.setWithCredentials(s.withCredentials),r.load(e,function(a){try{t(s.parse(JSON.parse(a)))}catch(o){if(i)i(o);else console.error(o);s.manager.itemError(e)}},n,i)}parse(e){let t={},n={};function i(d,f){if(t[f]!==void 0)return t[f];let _=d.interleavedBuffers[f],m=s(d,_.buffer),p=Gi(_.type,m),x=new fi(p,_.stride);return x.uuid=_.uuid,t[f]=x,x}function s(d,f){if(n[f]!==void 0)return n[f];let _=d.arrayBuffers[f],m=new Uint32Array(_).buffer;return n[f]=m,m}let r=e.isInstancedBufferGeometry?new tu:new ze,a=e.data.index;if(a!==void 0){let d=Gi(a.type,a.array);r.setIndex(new tt(d,1))}let o=e.data.attributes;for(let d in o){let f=o[d],g;if(f.isInterleavedBufferAttribute){let _=i(e.data,f.data);g=new Mn(_,f.itemSize,f.offset,f.normalized)}else{let _=Gi(f.type,f.array);g=new(f.isInstancedBufferAttribute?bn:tt)(_,f.itemSize,f.normalized)}if(f.name!==void 0)g.name=f.name;if(f.usage!==void 0)g.setUsage(f.usage);r.setAttribute(d,g)}let l=e.data.morphAttributes;if(l)for(let d in l){let f=l[d],g=[];for(let _=0,m=f.length;_<m;_++){let p=f[_],x;if(p.isInterleavedBufferAttribute){let v=i(e.data,p.data);x=new Mn(v,p.itemSize,p.offset,p.normalized)}else{let v=Gi(p.type,p.array);x=new tt(v,p.itemSize,p.normalized)}if(p.name!==void 0)x.name=p.name;g.push(x)}r.morphAttributes[d]=g}if(e.data.morphTargetsRelative)r.morphTargetsRelative=!0;let h=e.data.groups||e.data.drawcalls||e.data.offsets;if(h!==void 0)for(let d=0,f=h.length;d!==f;++d){let g=h[d];r.addGroup(g.start,g.count,g.materialIndex)}let u=e.data.boundingSphere;if(u!==void 0){let d=new T;if(u.center!==void 0)d.fromArray(u.center);r.boundingSphere=new At(d,u.radius)}if(e.name)r.name=e.name;if(e.userData)r.userData=e.userData;return r}}class d0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=this.path===""?Tn.extractUrlBase(e):this.path;this.resourcePath=this.resourcePath||r;let a=new Zt(this.manager);a.setPath(this.path),a.setRequestHeader(this.requestHeader),a.setWithCredentials(this.withCredentials),a.load(e,function(o){let l=null;try{l=JSON.parse(o)}catch(h){if(i!==void 0)i(h);console.error("THREE:ObjectLoader: Can't parse "+e+".",h.message);return}let c=l.metadata;if(c===void 0||c.type===void 0||c.type.toLowerCase()==="geometry"){if(i!==void 0)i(Error("THREE.ObjectLoader: Can't load "+e));console.error("THREE.ObjectLoader: Can't load "+e);return}s.parse(l,t)},n,i)}async loadAsync(e,t){let n=this,i=this.path===""?Tn.extractUrlBase(e):this.path;this.resourcePath=this.resourcePath||i;let s=new Zt(this.manager);s.setPath(this.path),s.setRequestHeader(this.requestHeader),s.setWithCredentials(this.withCredentials);let r=await s.loadAsync(e,t),a=JSON.parse(r),o=a.metadata;if(o===void 0||o.type===void 0||o.type.toLowerCase()==="geometry")throw Error("THREE.ObjectLoader: Can't load "+e);return await n.parseAsync(a)}parse(e,t){let n=this.parseAnimations(e.animations),i=this.parseShapes(e.shapes),s=this.parseGeometries(e.geometries,i),r=this.parseImages(e.images,function(){if(t!==void 0)t(l)}),a=this.parseTextures(e.textures,r),o=this.parseMaterials(e.materials,a),l=this.parseObject(e.object,s,o,a,n),c=this.parseSkeletons(e.skeletons,l);if(this.bindSkeletons(l,c),t!==void 0){let h=!1;for(let u in r)if(r[u].data instanceof HTMLImageElement){h=!0;break}if(h===!1)t(l)}return l}async parseAsync(e){let t=this.parseAnimations(e.animations),n=this.parseShapes(e.shapes),i=this.parseGeometries(e.geometries,n),s=await this.parseImagesAsync(e.images),r=this.parseTextures(e.textures,s),a=this.parseMaterials(e.materials,r),o=this.parseObject(e.object,i,a,r,t),l=this.parseSkeletons(e.skeletons,o);return this.bindSkeletons(o,l),o}parseShapes(e){let t={};if(e!==void 0)for(let n=0,i=e.length;n<i;n++){let s=new li().fromJSON(e[n]);t[s.uuid]=s}return t}parseSkeletons(e,t){let n={},i={};if(t.traverse(function(s){if(s.isBone)i[s.uuid]=s}),e!==void 0)for(let s=0,r=e.length;s<r;s++){let a=new Cs().fromJSON(e[s],i);n[a.uuid]=a}return n}parseGeometries(e,t){let n={};if(e!==void 0){let i=new nu;for(let s=0,r=e.length;s<r;s++){let a,o=e[s];switch(o.type){case"BufferGeometry":case"InstancedBufferGeometry":a=i.parse(o);break;default:if(o.type in fc)a=fc[o.type].fromJSON(o,t);else console.warn(`THREE.ObjectLoader: Unsupported geometry type "${o.type}"`)}if(a.uuid=o.uuid,o.name!==void 0)a.name=o.name;if(o.userData!==void 0)a.userData=o.userData;n[o.uuid]=a}}return n}parseMaterials(e,t){let n={},i={};if(e!==void 0){let s=new Bo;s.setTextures(t);for(let r=0,a=e.length;r<a;r++){let o=e[r];if(n[o.uuid]===void 0)n[o.uuid]=s.parse(o);i[o.uuid]=n[o.uuid]}}return i}parseAnimations(e){let t={};if(e!==void 0)for(let n=0;n<e.length;n++){let i=e[n],s=hi.parse(i);t[s.uuid]=s}return t}parseImages(e,t){let n=this,i={},s;function r(o){return n.manager.itemStart(o),s.load(o,function(){n.manager.itemEnd(o)},void 0,function(){n.manager.itemError(o),n.manager.itemEnd(o)})}function a(o){if(typeof o==="string"){let l=o,c=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(l)?l:n.resourcePath+l;return r(c)}else if(o.data)return{data:Gi(o.type,o.data),width:o.width,height:o.height};else return null}if(e!==void 0&&e.length>0){let o=new Fo(t);s=new Ts(o),s.setCrossOrigin(this.crossOrigin);for(let l=0,c=e.length;l<c;l++){let h=e[l],u=h.url;if(Array.isArray(u)){let d=[];for(let f=0,g=u.length;f<g;f++){let _=u[f],m=a(_);if(m!==null)if(m instanceof HTMLImageElement)d.push(m);else d.push(new oi(m.data,m.width,m.height))}i[h.uuid]=new si(d)}else{let d=a(h.url);i[h.uuid]=new si(d)}}}return i}async parseImagesAsync(e){let t=this,n={},i;async function s(r){if(typeof r==="string"){let a=r,o=/^(\/\/)|([a-z]+:(\/\/)?)/i.test(a)?a:t.resourcePath+a;return await i.loadAsync(o)}else if(r.data)return{data:Gi(r.type,r.data),width:r.width,height:r.height};else return null}if(e!==void 0&&e.length>0){i=new Ts(this.manager),i.setCrossOrigin(this.crossOrigin);for(let r=0,a=e.length;r<a;r++){let o=e[r],l=o.url;if(Array.isArray(l)){let c=[];for(let h=0,u=l.length;h<u;h++){let d=l[h],f=await s(d);if(f!==null)if(f instanceof HTMLImageElement)c.push(f);else c.push(new oi(f.data,f.width,f.height))}n[o.uuid]=new si(c)}else{let c=await s(o.url);n[o.uuid]=new si(c)}}}return n}parseTextures(e,t){function n(s,r){if(typeof s==="number")return s;return console.warn("THREE.ObjectLoader.parseTexture: Constant should be in numeric form.",s),r[s]}let i={};if(e!==void 0)for(let s=0,r=e.length;s<r;s++){let a=e[s];if(a.image===void 0)console.warn('THREE.ObjectLoader: No "image" specified for',a.uuid);if(t[a.image]===void 0)console.warn("THREE.ObjectLoader: Undefined image",a.image);let o=t[a.image],l=o.data,c;if(Array.isArray(l)){if(c=new Es,l.length===6)c.needsUpdate=!0}else{if(l&&l.data)c=new oi;else c=new ht;if(l)c.needsUpdate=!0}if(c.source=o,c.uuid=a.uuid,a.name!==void 0)c.name=a.name;if(a.mapping!==void 0)c.mapping=n(a.mapping,f0);if(a.channel!==void 0)c.channel=a.channel;if(a.offset!==void 0)c.offset.fromArray(a.offset);if(a.repeat!==void 0)c.repeat.fromArray(a.repeat);if(a.center!==void 0)c.center.fromArray(a.center);if(a.rotation!==void 0)c.rotation=a.rotation;if(a.wrap!==void 0)c.wrapS=n(a.wrap[0],_c),c.wrapT=n(a.wrap[1],_c);if(a.format!==void 0)c.format=a.format;if(a.internalFormat!==void 0)c.internalFormat=a.internalFormat;if(a.type!==void 0)c.type=a.type;if(a.colorSpace!==void 0)c.colorSpace=a.colorSpace;if(a.encoding!==void 0)c.encoding=a.encoding;if(a.minFilter!==void 0)c.minFilter=n(a.minFilter,xc);if(a.magFilter!==void 0)c.magFilter=n(a.magFilter,xc);if(a.anisotropy!==void 0)c.anisotropy=a.anisotropy;if(a.flipY!==void 0)c.flipY=a.flipY;if(a.generateMipmaps!==void 0)c.generateMipmaps=a.generateMipmaps;if(a.premultiplyAlpha!==void 0)c.premultiplyAlpha=a.premultiplyAlpha;if(a.unpackAlignment!==void 0)c.unpackAlignment=a.unpackAlignment;if(a.compareFunction!==void 0)c.compareFunction=a.compareFunction;if(a.userData!==void 0)c.userData=a.userData;i[a.uuid]=c}return i}parseObject(e,t,n,i,s){let r;function a(u){if(t[u]===void 0)console.warn("THREE.ObjectLoader: Undefined geometry",u);return t[u]}function o(u){if(u===void 0)return;if(Array.isArray(u)){let d=[];for(let f=0,g=u.length;f<g;f++){let _=u[f];if(n[_]===void 0)console.warn("THREE.ObjectLoader: Undefined material",_);d.push(n[_])}return d}if(n[u]===void 0)console.warn("THREE.ObjectLoader: Undefined material",u);return n[u]}function l(u){if(i[u]===void 0)console.warn("THREE.ObjectLoader: Undefined texture",u);return i[u]}let c,h;switch(e.type){case"Scene":if(r=new zr,e.background!==void 0)if(Number.isInteger(e.background))r.background=new ue(e.background);else r.background=l(e.background);if(e.environment!==void 0)r.environment=l(e.environment);if(e.fog!==void 0){if(e.fog.type==="Fog")r.fog=new fo(e.fog.color,e.fog.near,e.fog.far);else if(e.fog.type==="FogExp2")r.fog=new uo(e.fog.color,e.fog.density);if(e.fog.name!=="")r.fog.name=e.fog.name}if(e.backgroundBlurriness!==void 0)r.backgroundBlurriness=e.backgroundBlurriness;if(e.backgroundIntensity!==void 0)r.backgroundIntensity=e.backgroundIntensity;break;case"PerspectiveCamera":if(r=new yt(e.fov,e.aspect,e.near,e.far),e.focus!==void 0)r.focus=e.focus;if(e.zoom!==void 0)r.zoom=e.zoom;if(e.filmGauge!==void 0)r.filmGauge=e.filmGauge;if(e.filmOffset!==void 0)r.filmOffset=e.filmOffset;if(e.view!==void 0)r.view=Object.assign({},e.view);break;case"OrthographicCamera":if(r=new kn(e.left,e.right,e.top,e.bottom,e.near,e.far),e.zoom!==void 0)r.zoom=e.zoom;if(e.view!==void 0)r.view=Object.assign({},e.view);break;case"AmbientLight":r=new $h(e.color,e.intensity);break;case"DirectionalLight":r=new Qr(e.color,e.intensity);break;case"PointLight":r=new $i(e.color,e.intensity,e.distance,e.decay);break;case"RectAreaLight":r=new jh(e.color,e.intensity,e.width,e.height);break;case"SpotLight":r=new jr(e.color,e.intensity,e.distance,e.angle,e.penumbra,e.decay);break;case"HemisphereLight":r=new Yh(e.color,e.groundColor,e.intensity);break;case"LightProbe":r=new eu().fromJSON(e);break;case"SkinnedMesh":if(c=a(e.geometry),h=o(e.material),r=new kr(c,h),e.bindMode!==void 0)r.bindMode=e.bindMode;if(e.bindMatrix!==void 0)r.bindMatrix.fromArray(e.bindMatrix);if(e.skeleton!==void 0)r.skeleton=e.skeleton;break;case"Mesh":c=a(e.geometry),h=o(e.material),r=new Je(c,h);break;case"InstancedMesh":c=a(e.geometry),h=o(e.material);let{count:u,instanceMatrix:d,instanceColor:f}=e;if(r=new Gr(c,h,u),r.instanceMatrix=new bn(new Float32Array(d.array),16),f!==void 0)r.instanceColor=new bn(new Float32Array(f.array),f.itemSize);break;case"BatchedMesh":c=a(e.geometry),h=o(e.material),r=new bh(e.maxGeometryCount,e.maxVertexCount,e.maxIndexCount,h),r.geometry=c,r.perObjectFrustumCulled=e.perObjectFrustumCulled,r.sortObjects=e.sortObjects,r._drawRanges=e.drawRanges,r._reservedRanges=e.reservedRanges,r._visibility=e.visibility,r._active=e.active,r._bounds=e.bounds.map((g)=>{let _=new Rt;_.min.fromArray(g.boxMin),_.max.fromArray(g.boxMax);let m=new At;return m.radius=g.sphereRadius,m.center.fromArray(g.sphereCenter),{boxInitialized:g.boxInitialized,box:_,sphereInitialized:g.sphereInitialized,sphere:m}}),r._maxGeometryCount=e.maxGeometryCount,r._maxVertexCount=e.maxVertexCount,r._maxIndexCount=e.maxIndexCount,r._geometryInitialized=e.geometryInitialized,r._geometryCount=e.geometryCount,r._matricesTexture=l(e.matricesTexture.uuid);break;case"LOD":r=new Sh;break;case"Line":r=new un(a(e.geometry),o(e.material));break;case"LineLoop":r=new Hr(a(e.geometry),o(e.material));break;case"LineSegments":r=new Kt(a(e.geometry),o(e.material));break;case"PointCloud":case"Points":r=new Wr(a(e.geometry),o(e.material));break;case"Sprite":r=new yh(o(e.material));break;case"Group":r=new hn;break;case"Bone":r=new Rs;break;default:r=new et}if(r.uuid=e.uuid,e.name!==void 0)r.name=e.name;if(e.matrix!==void 0){if(r.matrix.fromArray(e.matrix),e.matrixAutoUpdate!==void 0)r.matrixAutoUpdate=e.matrixAutoUpdate;if(r.matrixAutoUpdate)r.matrix.decompose(r.position,r.quaternion,r.scale)}else{if(e.position!==void 0)r.position.fromArray(e.position);if(e.rotation!==void 0)r.rotation.fromArray(e.rotation);if(e.quaternion!==void 0)r.quaternion.fromArray(e.quaternion);if(e.scale!==void 0)r.scale.fromArray(e.scale)}if(e.up!==void 0)r.up.fromArray(e.up);if(e.castShadow!==void 0)r.castShadow=e.castShadow;if(e.receiveShadow!==void 0)r.receiveShadow=e.receiveShadow;if(e.shadow){if(e.shadow.bias!==void 0)r.shadow.bias=e.shadow.bias;if(e.shadow.normalBias!==void 0)r.shadow.normalBias=e.shadow.normalBias;if(e.shadow.radius!==void 0)r.shadow.radius=e.shadow.radius;if(e.shadow.mapSize!==void 0)r.shadow.mapSize.fromArray(e.shadow.mapSize);if(e.shadow.camera!==void 0)r.shadow.camera=this.parseObject(e.shadow.camera)}if(e.visible!==void 0)r.visible=e.visible;if(e.frustumCulled!==void 0)r.frustumCulled=e.frustumCulled;if(e.renderOrder!==void 0)r.renderOrder=e.renderOrder;if(e.userData!==void 0)r.userData=e.userData;if(e.layers!==void 0)r.layers.mask=e.layers;if(e.children!==void 0){let u=e.children;for(let d=0;d<u.length;d++)r.add(this.parseObject(u[d],t,n,i,s))}if(e.animations!==void 0){let u=e.animations;for(let d=0;d<u.length;d++){let f=u[d];r.animations.push(s[f])}}if(e.type==="LOD"){if(e.autoUpdate!==void 0)r.autoUpdate=e.autoUpdate;let u=e.levels;for(let d=0;d<u.length;d++){let f=u[d],g=r.getObjectByProperty("uuid",f.object);if(g!==void 0)r.addLevel(g,f.distance,f.hysteresis)}}return r}bindSkeletons(e,t){if(Object.keys(t).length===0)return;e.traverse(function(n){if(n.isSkinnedMesh===!0&&n.skeleton!==void 0){let i=t[n.skeleton];if(i===void 0)console.warn("THREE.ObjectLoader: No skeleton found with UUID:",n.skeleton);else n.bind(i,n.bindMatrix)}})}}var f0={UVMapping:300,CubeReflectionMapping:301,CubeRefractionMapping:302,EquirectangularReflectionMapping:303,EquirectangularRefractionMapping:304,CubeUVReflectionMapping:306},_c={RepeatWrapping:1000,ClampToEdgeWrapping:1001,MirroredRepeatWrapping:1002},xc={NearestFilter:1003,NearestMipmapNearestFilter:1004,NearestMipmapLinearFilter:1005,LinearFilter:1006,LinearMipmapNearestFilter:1007,LinearMipmapLinearFilter:1008};class zo extends Ut{constructor(e){super(e);if(this.isImageBitmapLoader=!0,typeof createImageBitmap>"u")console.warn("THREE.ImageBitmapLoader: createImageBitmap() not supported.");if(typeof fetch>"u")console.warn("THREE.ImageBitmapLoader: fetch() not supported.");this.options={premultiplyAlpha:"none"}}setOptions(e){return this.options=e,this}load(e,t,n,i){if(e===void 0)e="";if(this.path!==void 0)e=this.path+e;e=this.manager.resolveURL(e);let s=this,r=Dn.get(e);if(r!==void 0){if(s.manager.itemStart(e),r.then){r.then((l)=>{if(t)t(l);s.manager.itemEnd(e)}).catch((l)=>{if(i)i(l)});return}return setTimeout(function(){if(t)t(r);s.manager.itemEnd(e)},0),r}let a={};a.credentials=this.crossOrigin==="anonymous"?"same-origin":"include",a.headers=this.requestHeader;let o=fetch(e,a).then(function(l){return l.blob()}).then(function(l){return createImageBitmap(l,Object.assign(s.options,{colorSpaceConversion:"none"}))}).then(function(l){if(Dn.add(e,l),t)t(l);return s.manager.itemEnd(e),l}).catch(function(l){if(i)i(l);Dn.remove(e),s.manager.itemError(e),s.manager.itemEnd(e)});Dn.add(e,o),s.manager.itemStart(e)}}var yr;class ko{static getContext(){if(yr===void 0)yr=new(window.AudioContext||window.webkitAudioContext);return yr}static setContext(e){yr=e}}class p0 extends Ut{constructor(e){super(e)}load(e,t,n,i){let s=this,r=new Zt(this.manager);r.setResponseType("arraybuffer"),r.setPath(this.path),r.setRequestHeader(this.requestHeader),r.setWithCredentials(this.withCredentials),r.load(e,function(o){try{let l=o.slice(0);ko.getContext().decodeAudioData(l,function(h){t(h)}).catch(a)}catch(l){a(l)}},n,i);function a(o){if(i)i(o);else console.error(o);s.manager.itemError(e)}}}var vc=new De,yc=new De,$n=new De;class m0{constructor(){this.type="StereoCamera",this.aspect=1,this.eyeSep=0.064,this.cameraL=new yt,this.cameraL.layers.enable(1),this.cameraL.matrixAutoUpdate=!1,this.cameraR=new yt,this.cameraR.layers.enable(2),this.cameraR.matrixAutoUpdate=!1,this._cache={focus:null,fov:null,aspect:null,near:null,far:null,zoom:null,eyeSep:null}}update(e){let t=this._cache;if(t.focus!==e.focus||t.fov!==e.fov||t.aspect!==e.aspect*this.aspect||t.near!==e.near||t.far!==e.far||t.zoom!==e.zoom||t.eyeSep!==this.eyeSep){t.focus=e.focus,t.fov=e.fov,t.aspect=e.aspect*this.aspect,t.near=e.near,t.far=e.far,t.zoom=e.zoom,t.eyeSep=this.eyeSep,$n.copy(e.projectionMatrix);let i=t.eyeSep/2,s=i*t.near/t.focus,r=t.near*Math.tan(ai*t.fov*0.5)/t.zoom,a,o;yc.elements[12]=-i,vc.elements[12]=i,a=-r*t.aspect+s,o=r*t.aspect+s,$n.elements[0]=2*t.near/(o-a),$n.elements[8]=(o+a)/(o-a),this.cameraL.projectionMatrix.copy($n),a=-r*t.aspect-s,o=r*t.aspect-s,$n.elements[0]=2*t.near/(o-a),$n.elements[8]=(o+a)/(o-a),this.cameraR.projectionMatrix.copy($n)}this.cameraL.matrixWorld.copy(e.matrixWorld).multiply(yc),this.cameraR.matrixWorld.copy(e.matrixWorld).multiply(vc)}}class ea{constructor(e=!0){this.autoStart=e,this.startTime=0,this.oldTime=0,this.elapsedTime=0,this.running=!1}start(){this.startTime=Sc(),this.oldTime=this.startTime,this.elapsedTime=0,this.running=!0}stop(){this.getElapsedTime(),this.running=!1,this.autoStart=!1}getElapsedTime(){return this.getDelta(),this.elapsedTime}getDelta(){let e=0;if(this.autoStart&&!this.running)return this.start(),0;if(this.running){let t=Sc();e=(t-this.oldTime)/1000,this.oldTime=t,this.elapsedTime+=e}return e}}function Sc(){return(typeof performance>"u"?Date:performance).now()}var jn=new T,Mc=new _t,g0=new T,Qn=new T;class _0 extends et{constructor(){super();this.type="AudioListener",this.context=ko.getContext(),this.gain=this.context.createGain(),this.gain.connect(this.context.destination),this.filter=null,this.timeDelta=0,this._clock=new ea}getInput(){return this.gain}removeFilter(){if(this.filter!==null)this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination),this.gain.connect(this.context.destination),this.filter=null;return this}getFilter(){return this.filter}setFilter(e){if(this.filter!==null)this.gain.disconnect(this.filter),this.filter.disconnect(this.context.destination);else this.gain.disconnect(this.context.destination);return this.filter=e,this.gain.connect(this.filter),this.filter.connect(this.context.destination),this}getMasterVolume(){return this.gain.gain.value}setMasterVolume(e){return this.gain.gain.setTargetAtTime(e,this.context.currentTime,0.01),this}updateMatrixWorld(e){super.updateMatrixWorld(e);let t=this.context.listener,n=this.up;if(this.timeDelta=this._clock.getDelta(),this.matrixWorld.decompose(jn,Mc,g0),Qn.set(0,0,-1).applyQuaternion(Mc),t.positionX){let i=this.context.currentTime+this.timeDelta;t.positionX.linearRampToValueAtTime(jn.x,i),t.positionY.linearRampToValueAtTime(jn.y,i),t.positionZ.linearRampToValueAtTime(jn.z,i),t.forwardX.linearRampToValueAtTime(Qn.x,i),t.forwardY.linearRampToValueAtTime(Qn.y,i),t.forwardZ.linearRampToValueAtTime(Qn.z,i),t.upX.linearRampToValueAtTime(n.x,i),t.upY.linearRampToValueAtTime(n.y,i),t.upZ.linearRampToValueAtTime(n.z,i)}else t.setPosition(jn.x,jn.y,jn.z),t.setOrientation(Qn.x,Qn.y,Qn.z,n.x,n.y,n.z)}}class iu extends et{constructor(e){super();this.type="Audio",this.listener=e,this.context=e.context,this.gain=this.context.createGain(),this.gain.connect(e.getInput()),this.autoplay=!1,this.buffer=null,this.detune=0,this.loop=!1,this.loopStart=0,this.loopEnd=0,this.offset=0,this.duration=void 0,this.playbackRate=1,this.isPlaying=!1,this.hasPlaybackControl=!0,this.source=null,this.sourceType="empty",this._startedAt=0,this._progress=0,this._connected=!1,this.filters=[]}getOutput(){return this.gain}setNodeSource(e){return this.hasPlaybackControl=!1,this.sourceType="audioNode",this.source=e,this.connect(),this}setMediaElementSource(e){return this.hasPlaybackControl=!1,this.sourceType="mediaNode",this.source=this.context.createMediaElementSource(e),this.connect(),this}setMediaStreamSource(e){return this.hasPlaybackControl=!1,this.sourceType="mediaStreamNode",this.source=this.context.createMediaStreamSource(e),this.connect(),this}setBuffer(e){if(this.buffer=e,this.sourceType="buffer",this.autoplay)this.play();return this}play(e=0){if(this.isPlaying===!0){console.warn("THREE.Audio: Audio is already playing.");return}if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}this._startedAt=this.context.currentTime+e;let t=this.context.createBufferSource();return t.buffer=this.buffer,t.loop=this.loop,t.loopStart=this.loopStart,t.loopEnd=this.loopEnd,t.onended=this.onEnded.bind(this),t.start(this._startedAt,this._progress+this.offset,this.duration),this.isPlaying=!0,this.source=t,this.setDetune(this.detune),this.setPlaybackRate(this.playbackRate),this.connect()}pause(){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}if(this.isPlaying===!0){if(this._progress+=Math.max(this.context.currentTime-this._startedAt,0)*this.playbackRate,this.loop===!0)this._progress=this._progress%(this.duration||this.buffer.duration);this.source.stop(),this.source.onended=null,this.isPlaying=!1}return this}stop(){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}if(this._progress=0,this.source!==null)this.source.stop(),this.source.onended=null;return this.isPlaying=!1,this}connect(){if(this.filters.length>0){this.source.connect(this.filters[0]);for(let e=1,t=this.filters.length;e<t;e++)this.filters[e-1].connect(this.filters[e]);this.filters[this.filters.length-1].connect(this.getOutput())}else this.source.connect(this.getOutput());return this._connected=!0,this}disconnect(){if(this._connected===!1)return;if(this.filters.length>0){this.source.disconnect(this.filters[0]);for(let e=1,t=this.filters.length;e<t;e++)this.filters[e-1].disconnect(this.filters[e]);this.filters[this.filters.length-1].disconnect(this.getOutput())}else this.source.disconnect(this.getOutput());return this._connected=!1,this}getFilters(){return this.filters}setFilters(e){if(!e)e=[];if(this._connected===!0)this.disconnect(),this.filters=e.slice(),this.connect();else this.filters=e.slice();return this}setDetune(e){if(this.detune=e,this.source.detune===void 0)return;if(this.isPlaying===!0)this.source.detune.setTargetAtTime(this.detune,this.context.currentTime,0.01);return this}getDetune(){return this.detune}getFilter(){return this.getFilters()[0]}setFilter(e){return this.setFilters(e?[e]:[])}setPlaybackRate(e){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}if(this.playbackRate=e,this.isPlaying===!0)this.source.playbackRate.setTargetAtTime(this.playbackRate,this.context.currentTime,0.01);return this}getPlaybackRate(){return this.playbackRate}onEnded(){this.isPlaying=!1}getLoop(){if(this.hasPlaybackControl===!1)return console.warn("THREE.Audio: this Audio has no playback control."),!1;return this.loop}setLoop(e){if(this.hasPlaybackControl===!1){console.warn("THREE.Audio: this Audio has no playback control.");return}if(this.loop=e,this.isPlaying===!0)this.source.loop=this.loop;return this}setLoopStart(e){return this.loopStart=e,this}setLoopEnd(e){return this.loopEnd=e,this}getVolume(){return this.gain.gain.value}setVolume(e){return this.gain.gain.setTargetAtTime(e,this.context.currentTime,0.01),this}}var ei=new T,bc=new _t,x0=new T,ti=new T;class v0 extends iu{constructor(e){super(e);this.panner=this.context.createPanner(),this.panner.panningModel="HRTF",this.panner.connect(this.gain)}connect(){super.connect(),this.panner.connect(this.gain)}disconnect(){super.disconnect(),this.panner.disconnect(this.gain)}getOutput(){return this.panner}getRefDistance(){return this.panner.refDistance}setRefDistance(e){return this.panner.refDistance=e,this}getRolloffFactor(){return this.panner.rolloffFactor}setRolloffFactor(e){return this.panner.rolloffFactor=e,this}getDistanceModel(){return this.panner.distanceModel}setDistanceModel(e){return this.panner.distanceModel=e,this}getMaxDistance(){return this.panner.maxDistance}setMaxDistance(e){return this.panner.maxDistance=e,this}setDirectionalCone(e,t,n){return this.panner.coneInnerAngle=e,this.panner.coneOuterAngle=t,this.panner.coneOuterGain=n,this}updateMatrixWorld(e){if(super.updateMatrixWorld(e),this.hasPlaybackControl===!0&&this.isPlaying===!1)return;this.matrixWorld.decompose(ei,bc,x0),ti.set(0,0,1).applyQuaternion(bc);let t=this.panner;if(t.positionX){let n=this.context.currentTime+this.listener.timeDelta;t.positionX.linearRampToValueAtTime(ei.x,n),t.positionY.linearRampToValueAtTime(ei.y,n),t.positionZ.linearRampToValueAtTime(ei.z,n),t.orientationX.linearRampToValueAtTime(ti.x,n),t.orientationY.linearRampToValueAtTime(ti.y,n),t.orientationZ.linearRampToValueAtTime(ti.z,n)}else t.setPosition(ei.x,ei.y,ei.z),t.setOrientation(ti.x,ti.y,ti.z)}}class y0{constructor(e,t=2048){this.analyser=e.context.createAnalyser(),this.analyser.fftSize=t,this.data=new Uint8Array(this.analyser.frequencyBinCount),e.getOutput().connect(this.analyser)}getFrequencyData(){return this.analyser.getByteFrequencyData(this.data),this.data}getAverageFrequency(){let e=0,t=this.getFrequencyData();for(let n=0;n<t.length;n++)e+=t[n];return e/t.length}}class su{constructor(e,t,n){this.binding=e,this.valueSize=n;let i,s,r;switch(t){case"quaternion":i=this._slerp,s=this._slerpAdditive,r=this._setAdditiveIdentityQuaternion,this.buffer=new Float64Array(n*6),this._workIndex=5;break;case"string":case"bool":i=this._select,s=this._select,r=this._setAdditiveIdentityOther,this.buffer=Array(n*5);break;default:i=this._lerp,s=this._lerpAdditive,r=this._setAdditiveIdentityNumeric,this.buffer=new Float64Array(n*5)}this._mixBufferRegion=i,this._mixBufferRegionAdditive=s,this._setIdentity=r,this._origIndex=3,this._addIndex=4,this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,this.useCount=0,this.referenceCount=0}accumulate(e,t){let n=this.buffer,i=this.valueSize,s=e*i+i,r=this.cumulativeWeight;if(r===0){for(let a=0;a!==i;++a)n[s+a]=n[a];r=t}else{r+=t;let a=t/r;this._mixBufferRegion(n,s,0,a,i)}this.cumulativeWeight=r}accumulateAdditive(e){let t=this.buffer,n=this.valueSize,i=n*this._addIndex;if(this.cumulativeWeightAdditive===0)this._setIdentity();this._mixBufferRegionAdditive(t,i,0,e,n),this.cumulativeWeightAdditive+=e}apply(e){let t=this.valueSize,n=this.buffer,i=e*t+t,s=this.cumulativeWeight,r=this.cumulativeWeightAdditive,a=this.binding;if(this.cumulativeWeight=0,this.cumulativeWeightAdditive=0,s<1){let o=t*this._origIndex;this._mixBufferRegion(n,i,o,1-s,t)}if(r>0)this._mixBufferRegionAdditive(n,i,this._addIndex*t,1,t);for(let o=t,l=t+t;o!==l;++o)if(n[o]!==n[o+t]){a.setValue(n,i);break}}saveOriginalState(){let e=this.binding,t=this.buffer,n=this.valueSize,i=n*this._origIndex;e.getValue(t,i);for(let s=n,r=i;s!==r;++s)t[s]=t[i+s%n];this._setIdentity(),this.cumulativeWeight=0,this.cumulativeWeightAdditive=0}restoreOriginalState(){let e=this.valueSize*3;this.binding.setValue(this.buffer,e)}_setAdditiveIdentityNumeric(){let e=this._addIndex*this.valueSize,t=e+this.valueSize;for(let n=e;n<t;n++)this.buffer[n]=0}_setAdditiveIdentityQuaternion(){this._setAdditiveIdentityNumeric(),this.buffer[this._addIndex*this.valueSize+3]=1}_setAdditiveIdentityOther(){let e=this._origIndex*this.valueSize,t=this._addIndex*this.valueSize;for(let n=0;n<this.valueSize;n++)this.buffer[t+n]=this.buffer[e+n]}_select(e,t,n,i,s){if(i>=0.5)for(let r=0;r!==s;++r)e[t+r]=e[n+r]}_slerp(e,t,n,i){_t.slerpFlat(e,t,e,t,e,n,i)}_slerpAdditive(e,t,n,i,s){let r=this._workIndex*s;_t.multiplyQuaternionsFlat(e,r,e,t,e,n),_t.slerpFlat(e,t,e,t,e,r,i)}_lerp(e,t,n,i,s){let r=1-i;for(let a=0;a!==s;++a){let o=t+a;e[o]=e[o]*r+e[n+a]*i}}_lerpAdditive(e,t,n,i,s){for(let r=0;r!==s;++r){let a=t+r;e[a]=e[a]+e[n+r]*i}}}var Go="\\[\\]\\.:\\/",S0=new RegExp("["+Go+"]","g"),Ho="[^"+Go+"]",M0="[^"+Go.replace("\\.","")+"]",b0=/((?:WC+[\/:])*)/.source.replace("WC",Ho),T0=/(WCOD+)?/.source.replace("WCOD",M0),A0=/(?:\.(WC+)(?:\[(.+)\])?)?/.source.replace("WC",Ho),E0=/\.(WC+)(?:\[(.+)\])?/.source.replace("WC",Ho),w0=new RegExp("^"+b0+T0+A0+E0+"$"),R0=["material","materials","bones","map"];class ru{constructor(e,t,n){let i=n||Qe.parseTrackName(t);this._targetGroup=e,this._bindings=e.subscribe_(t,i)}getValue(e,t){this.bind();let n=this._targetGroup.nCachedObjects_,i=this._bindings[n];if(i!==void 0)i.getValue(e,t)}setValue(e,t){let n=this._bindings;for(let i=this._targetGroup.nCachedObjects_,s=n.length;i!==s;++i)n[i].setValue(e,t)}bind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].bind()}unbind(){let e=this._bindings;for(let t=this._targetGroup.nCachedObjects_,n=e.length;t!==n;++t)e[t].unbind()}}class Qe{constructor(e,t,n){this.path=t,this.parsedPath=n||Qe.parseTrackName(t),this.node=Qe.findNode(e,this.parsedPath.nodeName),this.rootNode=e,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}static create(e,t,n){if(!(e&&e.isAnimationObjectGroup))return new Qe(e,t,n);else return new Qe.Composite(e,t,n)}static sanitizeNodeName(e){return e.replace(/\s/g,"_").replace(S0,"")}static parseTrackName(e){let t=w0.exec(e);if(t===null)throw Error("PropertyBinding: Cannot parse trackName: "+e);let n={nodeName:t[2],objectName:t[3],objectIndex:t[4],propertyName:t[5],propertyIndex:t[6]},i=n.nodeName&&n.nodeName.lastIndexOf(".");if(i!==void 0&&i!==-1){let s=n.nodeName.substring(i+1);if(R0.indexOf(s)!==-1)n.nodeName=n.nodeName.substring(0,i),n.objectName=s}if(n.propertyName===null||n.propertyName.length===0)throw Error("PropertyBinding: can not parse propertyName from trackName: "+e);return n}static findNode(e,t){if(t===void 0||t===""||t==="."||t===-1||t===e.name||t===e.uuid)return e;if(e.skeleton){let n=e.skeleton.getBoneByName(t);if(n!==void 0)return n}if(e.children){let n=function(s){for(let r=0;r<s.length;r++){let a=s[r];if(a.name===t||a.uuid===t)return a;let o=n(a.children);if(o)return o}return null},i=n(e.children);if(i)return i}return null}_getValue_unavailable(){}_setValue_unavailable(){}_getValue_direct(e,t){e[t]=this.targetObject[this.propertyName]}_getValue_array(e,t){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)e[t++]=n[i]}_getValue_arrayElement(e,t){e[t]=this.resolvedProperty[this.propertyIndex]}_getValue_toArray(e,t){this.resolvedProperty.toArray(e,t)}_setValue_direct(e,t){this.targetObject[this.propertyName]=e[t]}_setValue_direct_setNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.needsUpdate=!0}_setValue_direct_setMatrixWorldNeedsUpdate(e,t){this.targetObject[this.propertyName]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_array(e,t){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[t++]}_setValue_array_setNeedsUpdate(e,t){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[t++];this.targetObject.needsUpdate=!0}_setValue_array_setMatrixWorldNeedsUpdate(e,t){let n=this.resolvedProperty;for(let i=0,s=n.length;i!==s;++i)n[i]=e[t++];this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_arrayElement(e,t){this.resolvedProperty[this.propertyIndex]=e[t]}_setValue_arrayElement_setNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.needsUpdate=!0}_setValue_arrayElement_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty[this.propertyIndex]=e[t],this.targetObject.matrixWorldNeedsUpdate=!0}_setValue_fromArray(e,t){this.resolvedProperty.fromArray(e,t)}_setValue_fromArray_setNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.needsUpdate=!0}_setValue_fromArray_setMatrixWorldNeedsUpdate(e,t){this.resolvedProperty.fromArray(e,t),this.targetObject.matrixWorldNeedsUpdate=!0}_getValue_unbound(e,t){this.bind(),this.getValue(e,t)}_setValue_unbound(e,t){this.bind(),this.setValue(e,t)}bind(){let e=this.node,t=this.parsedPath,{objectName:n,propertyName:i,propertyIndex:s}=t;if(!e)e=Qe.findNode(this.rootNode,t.nodeName),this.node=e;if(this.getValue=this._getValue_unavailable,this.setValue=this._setValue_unavailable,!e){console.warn("THREE.PropertyBinding: No target node found for track: "+this.path+".");return}if(n){let l=t.objectIndex;switch(n){case"materials":if(!e.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.materials){console.error("THREE.PropertyBinding: Can not bind to material.materials as node.material does not have a materials array.",this);return}e=e.material.materials;break;case"bones":if(!e.skeleton){console.error("THREE.PropertyBinding: Can not bind to bones as node does not have a skeleton.",this);return}e=e.skeleton.bones;for(let c=0;c<e.length;c++)if(e[c].name===l){l=c;break}break;case"map":if("map"in e){e=e.map;break}if(!e.material){console.error("THREE.PropertyBinding: Can not bind to material as node does not have a material.",this);return}if(!e.material.map){console.error("THREE.PropertyBinding: Can not bind to material.map as node.material does not have a map.",this);return}e=e.material.map;break;default:if(e[n]===void 0){console.error("THREE.PropertyBinding: Can not bind to objectName of node undefined.",this);return}e=e[n]}if(l!==void 0){if(e[l]===void 0){console.error("THREE.PropertyBinding: Trying to bind to objectIndex of objectName, but is undefined.",this,e);return}e=e[l]}}let r=e[i];if(r===void 0){let l=t.nodeName;console.error("THREE.PropertyBinding: Trying to update property for track: "+l+"."+i+" but it wasn't found.",e);return}let a=this.Versioning.None;if(this.targetObject=e,e.needsUpdate!==void 0)a=this.Versioning.NeedsUpdate;else if(e.matrixWorldNeedsUpdate!==void 0)a=this.Versioning.MatrixWorldNeedsUpdate;let o=this.BindingType.Direct;if(s!==void 0){if(i==="morphTargetInfluences"){if(!e.geometry){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.",this);return}if(!e.geometry.morphAttributes){console.error("THREE.PropertyBinding: Can not bind to morphTargetInfluences because node does not have a geometry.morphAttributes.",this);return}if(e.morphTargetDictionary[s]!==void 0)s=e.morphTargetDictionary[s]}o=this.BindingType.ArrayElement,this.resolvedProperty=r,this.propertyIndex=s}else if(r.fromArray!==void 0&&r.toArray!==void 0)o=this.BindingType.HasFromToArray,this.resolvedProperty=r;else if(Array.isArray(r))o=this.BindingType.EntireArray,this.resolvedProperty=r;else this.propertyName=i;this.getValue=this.GetterByBindingType[o],this.setValue=this.SetterByBindingTypeAndVersioning[o][a]}unbind(){this.node=null,this.getValue=this._getValue_unbound,this.setValue=this._setValue_unbound}}Qe.Composite=ru;Qe.prototype.BindingType={Direct:0,EntireArray:1,ArrayElement:2,HasFromToArray:3};Qe.prototype.Versioning={None:0,NeedsUpdate:1,MatrixWorldNeedsUpdate:2};Qe.prototype.GetterByBindingType=[Qe.prototype._getValue_direct,Qe.prototype._getValue_array,Qe.prototype._getValue_arrayElement,Qe.prototype._getValue_toArray];Qe.prototype.SetterByBindingTypeAndVersioning=[[Qe.prototype._setValue_direct,Qe.prototype._setValue_direct_setNeedsUpdate,Qe.prototype._setValue_direct_setMatrixWorldNeedsUpdate],[Qe.prototype._setValue_array,Qe.prototype._setValue_array_setNeedsUpdate,Qe.prototype._setValue_array_setMatrixWorldNeedsUpdate],[Qe.prototype._setValue_arrayElement,Qe.prototype._setValue_arrayElement_setNeedsUpdate,Qe.prototype._setValue_arrayElement_setMatrixWorldNeedsUpdate],[Qe.prototype._setValue_fromArray,Qe.prototype._setValue_fromArray_setNeedsUpdate,Qe.prototype._setValue_fromArray_setMatrixWorldNeedsUpdate]];class C0{constructor(){this.isAnimationObjectGroup=!0,this.uuid=Xt(),this._objects=Array.prototype.slice.call(arguments),this.nCachedObjects_=0;let e={};this._indicesByUUID=e;for(let n=0,i=arguments.length;n!==i;++n)e[arguments[n].uuid]=n;this._paths=[],this._parsedPaths=[],this._bindings=[],this._bindingsIndicesByPath={};let t=this;this.stats={objects:{get total(){return t._objects.length},get inUse(){return this.total-t.nCachedObjects_}},get bindingsPerObject(){return t._bindings.length}}}add(){let e=this._objects,t=this._indicesByUUID,n=this._paths,i=this._parsedPaths,s=this._bindings,r=s.length,a=void 0,o=e.length,l=this.nCachedObjects_;for(let c=0,h=arguments.length;c!==h;++c){let u=arguments[c],d=u.uuid,f=t[d];if(f===void 0){f=o++,t[d]=f,e.push(u);for(let g=0,_=r;g!==_;++g)s[g].push(new Qe(u,n[g],i[g]))}else if(f<l){a=e[f];let g=--l,_=e[g];t[_.uuid]=f,e[f]=_,t[d]=g,e[g]=u;for(let m=0,p=r;m!==p;++m){let x=s[m],v=x[g],b=x[f];if(x[f]=v,b===void 0)b=new Qe(u,n[m],i[m]);x[g]=b}}else if(e[f]!==a)console.error("THREE.AnimationObjectGroup: Different objects with the same UUID detected. Clean the caches or recreate your infrastructure when reloading scenes.")}this.nCachedObjects_=l}remove(){let e=this._objects,t=this._indicesByUUID,n=this._bindings,i=n.length,s=this.nCachedObjects_;for(let r=0,a=arguments.length;r!==a;++r){let o=arguments[r],l=o.uuid,c=t[l];if(c!==void 0&&c>=s){let h=s++,u=e[h];t[u.uuid]=c,e[c]=u,t[l]=h,e[h]=o;for(let d=0,f=i;d!==f;++d){let g=n[d],_=g[h],m=g[c];g[c]=_,g[h]=m}}}this.nCachedObjects_=s}uncache(){let e=this._objects,t=this._indicesByUUID,n=this._bindings,i=n.length,s=this.nCachedObjects_,r=e.length;for(let a=0,o=arguments.length;a!==o;++a){let l=arguments[a],c=l.uuid,h=t[c];if(h!==void 0)if(delete t[c],h<s){let u=--s,d=e[u],f=--r,g=e[f];t[d.uuid]=h,e[h]=d,t[g.uuid]=u,e[u]=g,e.pop();for(let _=0,m=i;_!==m;++_){let p=n[_],x=p[u],v=p[f];p[h]=x,p[u]=v,p.pop()}}else{let u=--r,d=e[u];if(u>0)t[d.uuid]=h;e[h]=d,e.pop();for(let f=0,g=i;f!==g;++f){let _=n[f];_[h]=_[u],_.pop()}}}this.nCachedObjects_=s}subscribe_(e,t){let n=this._bindingsIndicesByPath,i=n[e],s=this._bindings;if(i!==void 0)return s[i];let r=this._paths,a=this._parsedPaths,o=this._objects,l=o.length,c=this.nCachedObjects_,h=Array(l);i=s.length,n[e]=i,r.push(e),a.push(t),s.push(h);for(let u=c,d=o.length;u!==d;++u){let f=o[u];h[u]=new Qe(f,e,t)}return h}unsubscribe_(e){let t=this._bindingsIndicesByPath,n=t[e];if(n!==void 0){let i=this._paths,s=this._parsedPaths,r=this._bindings,a=r.length-1,o=r[a],l=e[a];t[l]=n,r[n]=o,r.pop(),s[n]=s[a],s.pop(),i[n]=i[a],i.pop()}}}class au{constructor(e,t,n=null,i=t.blendMode){this._mixer=e,this._clip=t,this._localRoot=n,this.blendMode=i;let s=t.tracks,r=s.length,a=Array(r),o={endingStart:2400,endingEnd:2400};for(let l=0;l!==r;++l){let c=s[l].createInterpolant(null);a[l]=c,c.settings=o}this._interpolantSettings=o,this._interpolants=a,this._propertyBindings=Array(r),this._cacheIndex=null,this._byClipCacheIndex=null,this._timeScaleInterpolant=null,this._weightInterpolant=null,this.loop=2201,this._loopCount=-1,this._startTime=null,this.time=0,this.timeScale=1,this._effectiveTimeScale=1,this.weight=1,this._effectiveWeight=1,this.repetitions=1/0,this.paused=!1,this.enabled=!0,this.clampWhenFinished=!1,this.zeroSlopeAtStart=!0,this.zeroSlopeAtEnd=!0}play(){return this._mixer._activateAction(this),this}stop(){return this._mixer._deactivateAction(this),this.reset()}reset(){return this.paused=!1,this.enabled=!0,this.time=0,this._loopCount=-1,this._startTime=null,this.stopFading().stopWarping()}isRunning(){return this.enabled&&!this.paused&&this.timeScale!==0&&this._startTime===null&&this._mixer._isActiveAction(this)}isScheduled(){return this._mixer._isActiveAction(this)}startAt(e){return this._startTime=e,this}setLoop(e,t){return this.loop=e,this.repetitions=t,this}setEffectiveWeight(e){return this.weight=e,this._effectiveWeight=this.enabled?e:0,this.stopFading()}getEffectiveWeight(){return this._effectiveWeight}fadeIn(e){return this._scheduleFading(e,0,1)}fadeOut(e){return this._scheduleFading(e,1,0)}crossFadeFrom(e,t,n){if(e.fadeOut(t),this.fadeIn(t),n){let i=this._clip.duration,s=e._clip.duration,r=s/i,a=i/s;e.warp(1,r,t),this.warp(a,1,t)}return this}crossFadeTo(e,t,n){return e.crossFadeFrom(this,t,n)}stopFading(){let e=this._weightInterpolant;if(e!==null)this._weightInterpolant=null,this._mixer._takeBackControlInterpolant(e);return this}setEffectiveTimeScale(e){return this.timeScale=e,this._effectiveTimeScale=this.paused?0:e,this.stopWarping()}getEffectiveTimeScale(){return this._effectiveTimeScale}setDuration(e){return this.timeScale=this._clip.duration/e,this.stopWarping()}syncWith(e){return this.time=e.time,this.timeScale=e.timeScale,this.stopWarping()}halt(e){return this.warp(this._effectiveTimeScale,0,e)}warp(e,t,n){let i=this._mixer,s=i.time,r=this.timeScale,a=this._timeScaleInterpolant;if(a===null)a=i._lendControlInterpolant(),this._timeScaleInterpolant=a;let o=a.parameterPositions,l=a.sampleValues;return o[0]=s,o[1]=s+n,l[0]=e/r,l[1]=t/r,this}stopWarping(){let e=this._timeScaleInterpolant;if(e!==null)this._timeScaleInterpolant=null,this._mixer._takeBackControlInterpolant(e);return this}getMixer(){return this._mixer}getClip(){return this._clip}getRoot(){return this._localRoot||this._mixer._root}_update(e,t,n,i){if(!this.enabled){this._updateWeight(e);return}let s=this._startTime;if(s!==null){let o=(e-s)*n;if(o<0||n===0)t=0;else this._startTime=null,t=n*o}t*=this._updateTimeScale(e);let r=this._updateTime(t),a=this._updateWeight(e);if(a>0){let o=this._interpolants,l=this._propertyBindings;switch(this.blendMode){case 2501:for(let c=0,h=o.length;c!==h;++c)o[c].evaluate(r),l[c].accumulateAdditive(a);break;case 2500:default:for(let c=0,h=o.length;c!==h;++c)o[c].evaluate(r),l[c].accumulate(i,a)}}}_updateWeight(e){let t=0;if(this.enabled){t=this.weight;let n=this._weightInterpolant;if(n!==null){let i=n.evaluate(e)[0];if(t*=i,e>n.parameterPositions[1]){if(this.stopFading(),i===0)this.enabled=!1}}}return this._effectiveWeight=t,t}_updateTimeScale(e){let t=0;if(!this.paused){t=this.timeScale;let n=this._timeScaleInterpolant;if(n!==null){let i=n.evaluate(e)[0];if(t*=i,e>n.parameterPositions[1])if(this.stopWarping(),t===0)this.paused=!0;else this.timeScale=t}}return this._effectiveTimeScale=t,t}_updateTime(e){let t=this._clip.duration,n=this.loop,i=this.time+e,s=this._loopCount,r=n===2202;if(e===0){if(s===-1)return i;return r&&(s&1)===1?t-i:i}if(n===2200){if(s===-1)this._loopCount=0,this._setEndings(!0,!0,!1);e:{if(i>=t)i=t;else if(i<0)i=0;else{this.time=i;break e}if(this.clampWhenFinished)this.paused=!0;else this.enabled=!1;this.time=i,this._mixer.dispatchEvent({type:"finished",action:this,direction:e<0?-1:1})}}else{if(s===-1)if(e>=0)s=0,this._setEndings(!0,this.repetitions===0,r);else this._setEndings(this.repetitions===0,!0,r);if(i>=t||i<0){let a=Math.floor(i/t);i-=t*a,s+=Math.abs(a);let o=this.repetitions-s;if(o<=0){if(this.clampWhenFinished)this.paused=!0;else this.enabled=!1;i=e>0?t:0,this.time=i,this._mixer.dispatchEvent({type:"finished",action:this,direction:e>0?1:-1})}else{if(o===1){let l=e<0;this._setEndings(l,!l,r)}else this._setEndings(!1,!1,r);this._loopCount=s,this.time=i,this._mixer.dispatchEvent({type:"loop",action:this,loopDelta:a})}}else this.time=i;if(r&&(s&1)===1)return t-i}return i}_setEndings(e,t,n){let i=this._interpolantSettings;if(n)i.endingStart=2401,i.endingEnd=2401;else{if(e)i.endingStart=this.zeroSlopeAtStart?2401:2400;else i.endingStart=2402;if(t)i.endingEnd=this.zeroSlopeAtEnd?2401:2400;else i.endingEnd=2402}}_scheduleFading(e,t,n){let i=this._mixer,s=i.time,r=this._weightInterpolant;if(r===null)r=i._lendControlInterpolant(),this._weightInterpolant=r;let a=r.parameterPositions,o=r.sampleValues;return a[0]=s,o[0]=t,a[1]=s+e,o[1]=n,this}}var P0=new Float32Array(1);class L0 extends nn{constructor(e){super();this._root=e,this._initMemoryManager(),this._accuIndex=0,this.time=0,this.timeScale=1}_bindAction(e,t){let n=e._localRoot||this._root,i=e._clip.tracks,s=i.length,{_propertyBindings:r,_interpolants:a}=e,o=n.uuid,l=this._bindingsByRootAndName,c=l[o];if(c===void 0)c={},l[o]=c;for(let h=0;h!==s;++h){let u=i[h],d=u.name,f=c[d];if(f!==void 0)++f.referenceCount,r[h]=f;else{if(f=r[h],f!==void 0){if(f._cacheIndex===null)++f.referenceCount,this._addInactiveBinding(f,o,d);continue}let g=t&&t._propertyBindings[h].binding.parsedPath;f=new su(Qe.create(n,d,g),u.ValueTypeName,u.getValueSize()),++f.referenceCount,this._addInactiveBinding(f,o,d),r[h]=f}a[h].resultBuffer=f.buffer}}_activateAction(e){if(!this._isActiveAction(e)){if(e._cacheIndex===null){let n=(e._localRoot||this._root).uuid,i=e._clip.uuid,s=this._actionsByClip[i];this._bindAction(e,s&&s.knownActions[0]),this._addInactiveAction(e,i,n)}let t=e._propertyBindings;for(let n=0,i=t.length;n!==i;++n){let s=t[n];if(s.useCount++===0)this._lendBinding(s),s.saveOriginalState()}this._lendAction(e)}}_deactivateAction(e){if(this._isActiveAction(e)){let t=e._propertyBindings;for(let n=0,i=t.length;n!==i;++n){let s=t[n];if(--s.useCount===0)s.restoreOriginalState(),this._takeBackBinding(s)}this._takeBackAction(e)}}_initMemoryManager(){this._actions=[],this._nActiveActions=0,this._actionsByClip={},this._bindings=[],this._nActiveBindings=0,this._bindingsByRootAndName={},this._controlInterpolants=[],this._nActiveControlInterpolants=0;let e=this;this.stats={actions:{get total(){return e._actions.length},get inUse(){return e._nActiveActions}},bindings:{get total(){return e._bindings.length},get inUse(){return e._nActiveBindings}},controlInterpolants:{get total(){return e._controlInterpolants.length},get inUse(){return e._nActiveControlInterpolants}}}}_isActiveAction(e){let t=e._cacheIndex;return t!==null&&t<this._nActiveActions}_addInactiveAction(e,t,n){let i=this._actions,s=this._actionsByClip,r=s[t];if(r===void 0)r={knownActions:[e],actionByRoot:{}},e._byClipCacheIndex=0,s[t]=r;else{let a=r.knownActions;e._byClipCacheIndex=a.length,a.push(e)}e._cacheIndex=i.length,i.push(e),r.actionByRoot[n]=e}_removeInactiveAction(e){let t=this._actions,n=t[t.length-1],i=e._cacheIndex;n._cacheIndex=i,t[i]=n,t.pop(),e._cacheIndex=null;let s=e._clip.uuid,r=this._actionsByClip,a=r[s],o=a.knownActions,l=o[o.length-1],c=e._byClipCacheIndex;l._byClipCacheIndex=c,o[c]=l,o.pop(),e._byClipCacheIndex=null;let h=a.actionByRoot,u=(e._localRoot||this._root).uuid;if(delete h[u],o.length===0)delete r[s];this._removeInactiveBindingsForAction(e)}_removeInactiveBindingsForAction(e){let t=e._propertyBindings;for(let n=0,i=t.length;n!==i;++n){let s=t[n];if(--s.referenceCount===0)this._removeInactiveBinding(s)}}_lendAction(e){let t=this._actions,n=e._cacheIndex,i=this._nActiveActions++,s=t[i];e._cacheIndex=i,t[i]=e,s._cacheIndex=n,t[n]=s}_takeBackAction(e){let t=this._actions,n=e._cacheIndex,i=--this._nActiveActions,s=t[i];e._cacheIndex=i,t[i]=e,s._cacheIndex=n,t[n]=s}_addInactiveBinding(e,t,n){let i=this._bindingsByRootAndName,s=this._bindings,r=i[t];if(r===void 0)r={},i[t]=r;r[n]=e,e._cacheIndex=s.length,s.push(e)}_removeInactiveBinding(e){let t=this._bindings,n=e.binding,i=n.rootNode.uuid,s=n.path,r=this._bindingsByRootAndName,a=r[i],o=t[t.length-1],l=e._cacheIndex;if(o._cacheIndex=l,t[l]=o,t.pop(),delete a[s],Object.keys(a).length===0)delete r[i]}_lendBinding(e){let t=this._bindings,n=e._cacheIndex,i=this._nActiveBindings++,s=t[i];e._cacheIndex=i,t[i]=e,s._cacheIndex=n,t[n]=s}_takeBackBinding(e){let t=this._bindings,n=e._cacheIndex,i=--this._nActiveBindings,s=t[i];e._cacheIndex=i,t[i]=e,s._cacheIndex=n,t[n]=s}_lendControlInterpolant(){let e=this._controlInterpolants,t=this._nActiveControlInterpolants++,n=e[t];if(n===void 0)n=new Do(new Float32Array(2),new Float32Array(2),1,P0),n.__cacheIndex=t,e[t]=n;return n}_takeBackControlInterpolant(e){let t=this._controlInterpolants,n=e.__cacheIndex,i=--this._nActiveControlInterpolants,s=t[i];e.__cacheIndex=i,t[i]=e,s.__cacheIndex=n,t[n]=s}clipAction(e,t,n){let i=t||this._root,s=i.uuid,r=typeof e==="string"?hi.findByName(i,e):e,a=r!==null?r.uuid:e,o=this._actionsByClip[a],l=null;if(n===void 0)if(r!==null)n=r.blendMode;else n=2500;if(o!==void 0){let h=o.actionByRoot[s];if(h!==void 0&&h.blendMode===n)return h;if(l=o.knownActions[0],r===null)r=l._clip}if(r===null)return null;let c=new au(this,r,t,n);return this._bindAction(c,l),this._addInactiveAction(c,a,s),c}existingAction(e,t){let n=t||this._root,i=n.uuid,s=typeof e==="string"?hi.findByName(n,e):e,r=s?s.uuid:e,a=this._actionsByClip[r];if(a!==void 0)return a.actionByRoot[i]||null;return null}stopAllAction(){let e=this._actions,t=this._nActiveActions;for(let n=t-1;n>=0;--n)e[n].stop();return this}update(e){e*=this.timeScale;let t=this._actions,n=this._nActiveActions,i=this.time+=e,s=Math.sign(e),r=this._accuIndex^=1;for(let l=0;l!==n;++l)t[l]._update(i,e,s,r);let a=this._bindings,o=this._nActiveBindings;for(let l=0;l!==o;++l)a[l].apply(r);return this}setTime(e){this.time=0;for(let t=0;t<this._actions.length;t++)this._actions[t].time=0;return this.update(e)}getRoot(){return this._root}uncacheClip(e){let t=this._actions,n=e.uuid,i=this._actionsByClip,s=i[n];if(s!==void 0){let r=s.knownActions;for(let a=0,o=r.length;a!==o;++a){let l=r[a];this._deactivateAction(l);let c=l._cacheIndex,h=t[t.length-1];l._cacheIndex=null,l._byClipCacheIndex=null,h._cacheIndex=c,t[c]=h,t.pop(),this._removeInactiveBindingsForAction(l)}delete i[n]}}uncacheRoot(e){let t=e.uuid,n=this._actionsByClip;for(let r in n){let a=n[r].actionByRoot,o=a[t];if(o!==void 0)this._deactivateAction(o),this._removeInactiveAction(o)}let i=this._bindingsByRootAndName,s=i[t];if(s!==void 0)for(let r in s){let a=s[r];a.restoreOriginalState(),this._removeInactiveBinding(a)}}uncacheAction(e,t){let n=this.existingAction(e,t);if(n!==null)this._deactivateAction(n),this._removeInactiveAction(n)}}class ou{constructor(e){this.value=e}clone(){return new ou(this.value.clone===void 0?this.value:this.value.clone())}}var I0=0;class N0 extends nn{constructor(){super();this.isUniformsGroup=!0,Object.defineProperty(this,"id",{value:I0++}),this.name="",this.usage=35044,this.uniforms=[]}add(e){return this.uniforms.push(e),this}remove(e){let t=this.uniforms.indexOf(e);if(t!==-1)this.uniforms.splice(t,1);return this}setName(e){return this.name=e,this}setUsage(e){return this.usage=e,this}dispose(){return this.dispatchEvent({type:"dispose"}),this}copy(e){this.name=e.name,this.usage=e.usage;let t=e.uniforms;this.uniforms.length=0;for(let n=0,i=t.length;n<i;n++){let s=Array.isArray(t[n])?t[n]:[t[n]];for(let r=0;r<s.length;r++)this.uniforms.push(s[r].clone())}return this}clone(){return new this.constructor().copy(this)}}class D0 extends fi{constructor(e,t,n=1){super(e,t);this.isInstancedInterleavedBuffer=!0,this.meshPerAttribute=n}copy(e){return super.copy(e),this.meshPerAttribute=e.meshPerAttribute,this}clone(e){let t=super.clone(e);return t.meshPerAttribute=this.meshPerAttribute,t}toJSON(e){let t=super.toJSON(e);return t.isInstancedInterleavedBuffer=!0,t.meshPerAttribute=this.meshPerAttribute,t}}class U0{constructor(e,t,n,i,s){this.isGLBufferAttribute=!0,this.name="",this.buffer=e,this.type=t,this.itemSize=n,this.elementSize=i,this.count=s,this.version=0}set needsUpdate(e){if(e===!0)this.version++}setBuffer(e){return this.buffer=e,this}setType(e,t){return this.type=e,this.elementSize=t,this}setItemSize(e){return this.itemSize=e,this}setCount(e){return this.count=e,this}}class F0{constructor(e,t,n=0,i=1/0){this.ray=new On(e,t),this.near=n,this.far=i,this.camera=null,this.layers=new Ur,this.params={Mesh:{},Line:{threshold:1},LOD:{},Points:{threshold:1},Sprite:{}}}set(e,t){this.ray.set(e,t)}setFromCamera(e,t){if(t.isPerspectiveCamera)this.ray.origin.setFromMatrixPosition(t.matrixWorld),this.ray.direction.set(e.x,e.y,0.5).unproject(t).sub(this.ray.origin).normalize(),this.camera=t;else if(t.isOrthographicCamera)this.ray.origin.set(e.x,e.y,(t.near+t.far)/(t.near-t.far)).unproject(t),this.ray.direction.set(0,0,-1).transformDirection(t.matrixWorld),this.camera=t;else console.error("THREE.Raycaster: Unsupported camera type: "+t.type)}intersectObject(e,t=!0,n=[]){return ja(e,this,n,t),n.sort(Tc),n}intersectObjects(e,t=!0,n=[]){for(let i=0,s=e.length;i<s;i++)ja(e[i],this,n,t);return n.sort(Tc),n}}function Tc(e,t){return e.distance-t.distance}function ja(e,t,n,i){if(e.layers.test(t.layers))e.raycast(t,n);if(i===!0){let s=e.children;for(let r=0,a=s.length;r<a;r++)ja(s[r],t,n,!0)}}class ta{constructor(e=1,t=0,n=0){return this.radius=e,this.phi=t,this.theta=n,this}set(e,t,n){return this.radius=e,this.phi=t,this.theta=n,this}copy(e){return this.radius=e.radius,this.phi=e.phi,this.theta=e.theta,this}makeSafe(){return this.phi=Math.max(0.000001,Math.min(Math.PI-0.000001,this.phi)),this}setFromVector3(e){return this.setFromCartesianCoords(e.x,e.y,e.z)}setFromCartesianCoords(e,t,n){if(this.radius=Math.sqrt(e*e+t*t+n*n),this.radius===0)this.theta=0,this.phi=0;else this.theta=Math.atan2(e,n),this.phi=Math.acos(ft(t/this.radius,-1,1));return this}clone(){return new this.constructor().copy(this)}}class O0{constructor(e=1,t=0,n=0){return this.radius=e,this.theta=t,this.y=n,this}set(e,t,n){return this.radius=e,this.theta=t,this.y=n,this}copy(e){return this.radius=e.radius,this.theta=e.theta,this.y=e.y,this}setFromVector3(e){return this.setFromCartesianCoords(e.x,e.y,e.z)}setFromCartesianCoords(e,t,n){return this.radius=Math.sqrt(e*e+n*n),this.theta=Math.atan2(e,n),this.y=t,this}clone(){return new this.constructor().copy(this)}}var Ac=new W;class B0{constructor(e=new W(1/0,1/0),t=new W(-1/0,-1/0)){this.isBox2=!0,this.min=e,this.max=t}set(e,t){return this.min.copy(e),this.max.copy(t),this}setFromPoints(e){this.makeEmpty();for(let t=0,n=e.length;t<n;t++)this.expandByPoint(e[t]);return this}setFromCenterAndSize(e,t){let n=Ac.copy(t).multiplyScalar(0.5);return this.min.copy(e).sub(n),this.max.copy(e).add(n),this}clone(){return new this.constructor().copy(this)}copy(e){return this.min.copy(e.min),this.max.copy(e.max),this}makeEmpty(){return this.min.x=this.min.y=1/0,this.max.x=this.max.y=-1/0,this}isEmpty(){return this.max.x<this.min.x||this.max.y<this.min.y}getCenter(e){return this.isEmpty()?e.set(0,0):e.addVectors(this.min,this.max).multiplyScalar(0.5)}getSize(e){return this.isEmpty()?e.set(0,0):e.subVectors(this.max,this.min)}expandByPoint(e){return this.min.min(e),this.max.max(e),this}expandByVector(e){return this.min.sub(e),this.max.add(e),this}expandByScalar(e){return this.min.addScalar(-e),this.max.addScalar(e),this}containsPoint(e){return e.x<this.min.x||e.x>this.max.x||e.y<this.min.y||e.y>this.max.y?!1:!0}containsBox(e){return this.min.x<=e.min.x&&e.max.x<=this.max.x&&this.min.y<=e.min.y&&e.max.y<=this.max.y}getParameter(e,t){return t.set((e.x-this.min.x)/(this.max.x-this.min.x),(e.y-this.min.y)/(this.max.y-this.min.y))}intersectsBox(e){return e.max.x<this.min.x||e.min.x>this.max.x||e.max.y<this.min.y||e.min.y>this.max.y?!1:!0}clampPoint(e,t){return t.copy(e).clamp(this.min,this.max)}distanceToPoint(e){return this.clampPoint(e,Ac).distanceTo(e)}intersect(e){if(this.min.max(e.min),this.max.min(e.max),this.isEmpty())this.makeEmpty();return this}union(e){return this.min.min(e.min),this.max.max(e.max),this}translate(e){return this.min.add(e),this.max.add(e),this}equals(e){return e.min.equals(this.min)&&e.max.equals(this.max)}}var Ec=new T,Sr=new T;class z0{constructor(e=new T,t=new T){this.start=e,this.end=t}set(e,t){return this.start.copy(e),this.end.copy(t),this}copy(e){return this.start.copy(e.start),this.end.copy(e.end),this}getCenter(e){return e.addVectors(this.start,this.end).multiplyScalar(0.5)}delta(e){return e.subVectors(this.end,this.start)}distanceSq(){return this.start.distanceToSquared(this.end)}distance(){return this.start.distanceTo(this.end)}at(e,t){return this.delta(t).multiplyScalar(e).add(this.start)}closestPointToPointParameter(e,t){Ec.subVectors(e,this.start),Sr.subVectors(this.end,this.start);let n=Sr.dot(Sr),s=Sr.dot(Ec)/n;if(t)s=ft(s,0,1);return s}closestPointToPoint(e,t,n){let i=this.closestPointToPointParameter(e,t);return this.delta(n).multiplyScalar(i).add(this.start)}applyMatrix4(e){return this.start.applyMatrix4(e),this.end.applyMatrix4(e),this}equals(e){return e.start.equals(this.start)&&e.end.equals(this.end)}clone(){return new this.constructor().copy(this)}}var wc=new T;class k0 extends et{constructor(e,t){super();this.light=e,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.color=t,this.type="SpotLightHelper";let n=new ze,i=[0,0,0,0,0,1,0,0,0,1,0,1,0,0,0,-1,0,1,0,0,0,0,1,1,0,0,0,0,-1,1];for(let r=0,a=1,o=32;r<o;r++,a++){let l=r/o*Math.PI*2,c=a/o*Math.PI*2;i.push(Math.cos(l),Math.sin(l),1,Math.cos(c),Math.sin(c),1)}n.setAttribute("position",new Ae(i,3));let s=new Pt({fog:!1,toneMapped:!1});this.cone=new Kt(n,s),this.add(this.cone),this.update()}dispose(){this.cone.geometry.dispose(),this.cone.material.dispose()}update(){this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1);let e=this.light.distance?this.light.distance:1000,t=e*Math.tan(this.light.angle);if(this.cone.scale.set(t,t,e),wc.setFromMatrixPosition(this.light.target.matrixWorld),this.cone.lookAt(wc),this.color!==void 0)this.cone.material.color.set(this.color);else this.cone.material.color.copy(this.light.color)}}var Nn=new T,Mr=new De,Wa=new De;class G0 extends Kt{constructor(e){let t=lu(e),n=new ze,i=[],s=[],r=new ue(0,0,1),a=new ue(0,1,0);for(let l=0;l<t.length;l++){let c=t[l];if(c.parent&&c.parent.isBone)i.push(0,0,0),i.push(0,0,0),s.push(r.r,r.g,r.b),s.push(a.r,a.g,a.b)}n.setAttribute("position",new Ae(i,3)),n.setAttribute("color",new Ae(s,3));let o=new Pt({vertexColors:!0,depthTest:!1,depthWrite:!1,toneMapped:!1,transparent:!0});super(n,o);this.isSkeletonHelper=!0,this.type="SkeletonHelper",this.root=e,this.bones=t,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1}updateMatrixWorld(e){let t=this.bones,n=this.geometry,i=n.getAttribute("position");Wa.copy(this.root.matrixWorld).invert();for(let s=0,r=0;s<t.length;s++){let a=t[s];if(a.parent&&a.parent.isBone)Mr.multiplyMatrices(Wa,a.matrixWorld),Nn.setFromMatrixPosition(Mr),i.setXYZ(r,Nn.x,Nn.y,Nn.z),Mr.multiplyMatrices(Wa,a.parent.matrixWorld),Nn.setFromMatrixPosition(Mr),i.setXYZ(r+1,Nn.x,Nn.y,Nn.z),r+=2}n.getAttribute("position").needsUpdate=!0,super.updateMatrixWorld(e)}dispose(){this.geometry.dispose(),this.material.dispose()}}function lu(e){let t=[];if(e.isBone===!0)t.push(e);for(let n=0;n<e.children.length;n++)t.push.apply(t,lu(e.children[n]));return t}class H0 extends Je{constructor(e,t,n){let i=new Kr(t,4,2),s=new wt({wireframe:!0,fog:!1,toneMapped:!1});super(i,s);this.light=e,this.color=n,this.type="PointLightHelper",this.matrix=this.light.matrixWorld,this.matrixAutoUpdate=!1,this.update()}dispose(){this.geometry.dispose(),this.material.dispose()}update(){if(this.light.updateWorldMatrix(!0,!1),this.color!==void 0)this.material.color.set(this.color);else this.material.color.copy(this.light.color)}}var W0=new T,Rc=new ue,Cc=new ue;class V0 extends et{constructor(e,t,n){super();this.light=e,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="HemisphereLightHelper";let i=new Zr(t);if(i.rotateY(Math.PI*0.5),this.material=new wt({wireframe:!0,fog:!1,toneMapped:!1}),this.color===void 0)this.material.vertexColors=!0;let s=i.getAttribute("position"),r=new Float32Array(s.count*3);i.setAttribute("color",new tt(r,3)),this.add(new Je(i,this.material)),this.update()}dispose(){this.children[0].geometry.dispose(),this.children[0].material.dispose()}update(){let e=this.children[0];if(this.color!==void 0)this.material.color.set(this.color);else{let t=e.geometry.getAttribute("color");Rc.copy(this.light.color),Cc.copy(this.light.groundColor);for(let n=0,i=t.count;n<i;n++){let s=n<i/2?Rc:Cc;t.setXYZ(n,s.r,s.g,s.b)}t.needsUpdate=!0}this.light.updateWorldMatrix(!0,!1),e.lookAt(W0.setFromMatrixPosition(this.light.matrixWorld).negate())}}class X0 extends Kt{constructor(e=10,t=10,n=4473924,i=8947848){n=new ue(n),i=new ue(i);let s=t/2,r=e/t,a=e/2,o=[],l=[];for(let u=0,d=0,f=-a;u<=t;u++,f+=r){o.push(-a,0,f,a,0,f),o.push(f,0,-a,f,0,a);let g=u===s?n:i;g.toArray(l,d),d+=3,g.toArray(l,d),d+=3,g.toArray(l,d),d+=3,g.toArray(l,d),d+=3}let c=new ze;c.setAttribute("position",new Ae(o,3)),c.setAttribute("color",new Ae(l,3));let h=new Pt({vertexColors:!0,toneMapped:!1});super(c,h);this.type="GridHelper"}dispose(){this.geometry.dispose(),this.material.dispose()}}class q0 extends Kt{constructor(e=10,t=16,n=8,i=64,s=4473924,r=8947848){s=new ue(s),r=new ue(r);let a=[],o=[];if(t>1)for(let h=0;h<t;h++){let u=h/t*(Math.PI*2),d=Math.sin(u)*e,f=Math.cos(u)*e;a.push(0,0,0),a.push(d,0,f);let g=h&1?s:r;o.push(g.r,g.g,g.b),o.push(g.r,g.g,g.b)}for(let h=0;h<n;h++){let u=h&1?s:r,d=e-e/n*h;for(let f=0;f<i;f++){let g=f/i*(Math.PI*2),_=Math.sin(g)*d,m=Math.cos(g)*d;a.push(_,0,m),o.push(u.r,u.g,u.b),g=(f+1)/i*(Math.PI*2),_=Math.sin(g)*d,m=Math.cos(g)*d,a.push(_,0,m),o.push(u.r,u.g,u.b)}}let l=new ze;l.setAttribute("position",new Ae(a,3)),l.setAttribute("color",new Ae(o,3));let c=new Pt({vertexColors:!0,toneMapped:!1});super(l,c);this.type="PolarGridHelper"}dispose(){this.geometry.dispose(),this.material.dispose()}}var Pc=new T,br=new T,Lc=new T;class Y0 extends et{constructor(e,t,n){super();if(this.light=e,this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.color=n,this.type="DirectionalLightHelper",t===void 0)t=1;let i=new ze;i.setAttribute("position",new Ae([-t,t,0,t,t,0,t,-t,0,-t,-t,0,-t,t,0],3));let s=new Pt({fog:!1,toneMapped:!1});this.lightPlane=new un(i,s),this.add(this.lightPlane),i=new ze,i.setAttribute("position",new Ae([0,0,0,0,0,1],3)),this.targetLine=new un(i,s),this.add(this.targetLine),this.update()}dispose(){this.lightPlane.geometry.dispose(),this.lightPlane.material.dispose(),this.targetLine.geometry.dispose(),this.targetLine.material.dispose()}update(){if(this.light.updateWorldMatrix(!0,!1),this.light.target.updateWorldMatrix(!0,!1),Pc.setFromMatrixPosition(this.light.matrixWorld),br.setFromMatrixPosition(this.light.target.matrixWorld),Lc.subVectors(br,Pc),this.lightPlane.lookAt(br),this.color!==void 0)this.lightPlane.material.color.set(this.color),this.targetLine.material.color.set(this.color);else this.lightPlane.material.color.copy(this.light.color),this.targetLine.material.color.copy(this.light.color);this.targetLine.lookAt(br),this.targetLine.scale.z=Lc.length()}}var Tr=new T,dt=new Fr;class Z0 extends Kt{constructor(e){let t=new ze,n=new Pt({color:16777215,vertexColors:!0,toneMapped:!1}),i=[],s=[],r={};a("n1","n2"),a("n2","n4"),a("n4","n3"),a("n3","n1"),a("f1","f2"),a("f2","f4"),a("f4","f3"),a("f3","f1"),a("n1","f1"),a("n2","f2"),a("n3","f3"),a("n4","f4"),a("p","n1"),a("p","n2"),a("p","n3"),a("p","n4"),a("u1","u2"),a("u2","u3"),a("u3","u1"),a("c","t"),a("p","c"),a("cn1","cn2"),a("cn3","cn4"),a("cf1","cf2"),a("cf3","cf4");function a(f,g){o(f),o(g)}function o(f){if(i.push(0,0,0),s.push(0,0,0),r[f]===void 0)r[f]=[];r[f].push(i.length/3-1)}t.setAttribute("position",new Ae(i,3)),t.setAttribute("color",new Ae(s,3));super(t,n);if(this.type="CameraHelper",this.camera=e,this.camera.updateProjectionMatrix)this.camera.updateProjectionMatrix();this.matrix=e.matrixWorld,this.matrixAutoUpdate=!1,this.pointMap=r,this.update();let l=new ue(16755200),c=new ue(16711680),h=new ue(43775),u=new ue(16777215),d=new ue(3355443);this.setColors(l,c,h,u,d)}setColors(e,t,n,i,s){let a=this.geometry.getAttribute("color");a.setXYZ(0,e.r,e.g,e.b),a.setXYZ(1,e.r,e.g,e.b),a.setXYZ(2,e.r,e.g,e.b),a.setXYZ(3,e.r,e.g,e.b),a.setXYZ(4,e.r,e.g,e.b),a.setXYZ(5,e.r,e.g,e.b),a.setXYZ(6,e.r,e.g,e.b),a.setXYZ(7,e.r,e.g,e.b),a.setXYZ(8,e.r,e.g,e.b),a.setXYZ(9,e.r,e.g,e.b),a.setXYZ(10,e.r,e.g,e.b),a.setXYZ(11,e.r,e.g,e.b),a.setXYZ(12,e.r,e.g,e.b),a.setXYZ(13,e.r,e.g,e.b),a.setXYZ(14,e.r,e.g,e.b),a.setXYZ(15,e.r,e.g,e.b),a.setXYZ(16,e.r,e.g,e.b),a.setXYZ(17,e.r,e.g,e.b),a.setXYZ(18,e.r,e.g,e.b),a.setXYZ(19,e.r,e.g,e.b),a.setXYZ(20,e.r,e.g,e.b),a.setXYZ(21,e.r,e.g,e.b),a.setXYZ(22,e.r,e.g,e.b),a.setXYZ(23,e.r,e.g,e.b),a.setXYZ(24,t.r,t.g,t.b),a.setXYZ(25,t.r,t.g,t.b),a.setXYZ(26,t.r,t.g,t.b),a.setXYZ(27,t.r,t.g,t.b),a.setXYZ(28,t.r,t.g,t.b),a.setXYZ(29,t.r,t.g,t.b),a.setXYZ(30,t.r,t.g,t.b),a.setXYZ(31,t.r,t.g,t.b),a.setXYZ(32,n.r,n.g,n.b),a.setXYZ(33,n.r,n.g,n.b),a.setXYZ(34,n.r,n.g,n.b),a.setXYZ(35,n.r,n.g,n.b),a.setXYZ(36,n.r,n.g,n.b),a.setXYZ(37,n.r,n.g,n.b),a.setXYZ(38,i.r,i.g,i.b),a.setXYZ(39,i.r,i.g,i.b),a.setXYZ(40,s.r,s.g,s.b),a.setXYZ(41,s.r,s.g,s.b),a.setXYZ(42,s.r,s.g,s.b),a.setXYZ(43,s.r,s.g,s.b),a.setXYZ(44,s.r,s.g,s.b),a.setXYZ(45,s.r,s.g,s.b),a.setXYZ(46,s.r,s.g,s.b),a.setXYZ(47,s.r,s.g,s.b),a.setXYZ(48,s.r,s.g,s.b),a.setXYZ(49,s.r,s.g,s.b),a.needsUpdate=!0}update(){let e=this.geometry,t=this.pointMap,n=1,i=1;dt.projectionMatrixInverse.copy(this.camera.projectionMatrixInverse),mt("c",t,e,dt,0,0,-1),mt("t",t,e,dt,0,0,1),mt("n1",t,e,dt,-1,-1,-1),mt("n2",t,e,dt,1,-1,-1),mt("n3",t,e,dt,-1,1,-1),mt("n4",t,e,dt,1,1,-1),mt("f1",t,e,dt,-1,-1,1),mt("f2",t,e,dt,1,-1,1),mt("f3",t,e,dt,-1,1,1),mt("f4",t,e,dt,1,1,1),mt("u1",t,e,dt,0.7,1.1,-1),mt("u2",t,e,dt,-0.7,1.1,-1),mt("u3",t,e,dt,0,2,-1),mt("cf1",t,e,dt,-1,0,1),mt("cf2",t,e,dt,1,0,1),mt("cf3",t,e,dt,0,-1,1),mt("cf4",t,e,dt,0,1,1),mt("cn1",t,e,dt,-1,0,-1),mt("cn2",t,e,dt,1,0,-1),mt("cn3",t,e,dt,0,-1,-1),mt("cn4",t,e,dt,0,1,-1),e.getAttribute("position").needsUpdate=!0}dispose(){this.geometry.dispose(),this.material.dispose()}}function mt(e,t,n,i,s,r,a){Tr.set(s,r,a).unproject(i);let o=t[e];if(o!==void 0){let l=n.getAttribute("position");for(let c=0,h=o.length;c<h;c++)l.setXYZ(o[c],Tr.x,Tr.y,Tr.z)}}var Ar=new Rt;class K0 extends Kt{constructor(e,t=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),i=new Float32Array(24),s=new ze;s.setIndex(new tt(n,1)),s.setAttribute("position",new tt(i,3));super(s,new Pt({color:t,toneMapped:!1}));this.object=e,this.type="BoxHelper",this.matrixAutoUpdate=!1,this.update()}update(e){if(e!==void 0)console.warn("THREE.BoxHelper: .update() has no longer arguments.");if(this.object!==void 0)Ar.setFromObject(this.object);if(Ar.isEmpty())return;let{min:t,max:n}=Ar,i=this.geometry.attributes.position,s=i.array;s[0]=n.x,s[1]=n.y,s[2]=n.z,s[3]=t.x,s[4]=n.y,s[5]=n.z,s[6]=t.x,s[7]=t.y,s[8]=n.z,s[9]=n.x,s[10]=t.y,s[11]=n.z,s[12]=n.x,s[13]=n.y,s[14]=t.z,s[15]=t.x,s[16]=n.y,s[17]=t.z,s[18]=t.x,s[19]=t.y,s[20]=t.z,s[21]=n.x,s[22]=t.y,s[23]=t.z,i.needsUpdate=!0,this.geometry.computeBoundingSphere()}setFromObject(e){return this.object=e,this.update(),this}copy(e,t){return super.copy(e,t),this.object=e.object,this}dispose(){this.geometry.dispose(),this.material.dispose()}}class J0 extends Kt{constructor(e,t=16776960){let n=new Uint16Array([0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7]),i=[1,1,1,-1,1,1,-1,-1,1,1,-1,1,1,1,-1,-1,1,-1,-1,-1,-1,1,-1,-1],s=new ze;s.setIndex(new tt(n,1)),s.setAttribute("position",new Ae(i,3));super(s,new Pt({color:t,toneMapped:!1}));this.box=e,this.type="Box3Helper",this.geometry.computeBoundingSphere()}updateMatrixWorld(e){let t=this.box;if(t.isEmpty())return;t.getCenter(this.position),t.getSize(this.scale),this.scale.multiplyScalar(0.5),super.updateMatrixWorld(e)}dispose(){this.geometry.dispose(),this.material.dispose()}}class $0 extends un{constructor(e,t=1,n=16776960){let i=n,s=[1,-1,0,-1,1,0,-1,-1,0,1,1,0,-1,1,0,-1,-1,0,1,-1,0,1,1,0],r=new ze;r.setAttribute("position",new Ae(s,3)),r.computeBoundingSphere();super(r,new Pt({color:i,toneMapped:!1}));this.type="PlaneHelper",this.plane=e,this.size=t;let a=[1,1,0,-1,1,0,-1,-1,0,1,1,0,-1,-1,0,1,-1,0],o=new ze;o.setAttribute("position",new Ae(a,3)),o.computeBoundingSphere(),this.add(new Je(o,new wt({color:i,opacity:0.2,transparent:!0,depthWrite:!1,toneMapped:!1})))}updateMatrixWorld(e){this.position.set(0,0,0),this.scale.set(0.5*this.size,0.5*this.size,1),this.lookAt(this.plane.normal),this.translateZ(-this.plane.constant),super.updateMatrixWorld(e)}dispose(){this.geometry.dispose(),this.material.dispose(),this.children[0].geometry.dispose(),this.children[0].material.dispose()}}var Ic=new T,Er,Va;class j0 extends et{constructor(e=new T(0,0,1),t=new T(0,0,0),n=1,i=16776960,s=n*0.2,r=s*0.2){super();if(this.type="ArrowHelper",Er===void 0)Er=new ze,Er.setAttribute("position",new Ae([0,0,0,0,1,0],3)),Va=new Ls(0,0.5,1,5,1),Va.translate(0,-0.5,0);this.position.copy(t),this.line=new un(Er,new Pt({color:i,toneMapped:!1})),this.line.matrixAutoUpdate=!1,this.add(this.line),this.cone=new Je(Va,new wt({color:i,toneMapped:!1})),this.cone.matrixAutoUpdate=!1,this.add(this.cone),this.setDirection(e),this.setLength(n,s,r)}setDirection(e){if(e.y>0.99999)this.quaternion.set(0,0,0,1);else if(e.y<-0.99999)this.quaternion.set(1,0,0,0);else{Ic.set(e.z,0,-e.x).normalize();let t=Math.acos(e.y);this.quaternion.setFromAxisAngle(Ic,t)}}setLength(e,t=e*0.2,n=t*0.2){this.line.scale.set(1,Math.max(0.0001,e-t),1),this.line.updateMatrix(),this.cone.scale.set(n,t,n),this.cone.position.y=e,this.cone.updateMatrix()}setColor(e){this.line.material.color.set(e),this.cone.material.color.set(e)}copy(e){return super.copy(e,!1),this.line.copy(e.line),this.cone.copy(e.cone),this}dispose(){this.line.geometry.dispose(),this.line.material.dispose(),this.cone.geometry.dispose(),this.cone.material.dispose()}}class Q0 extends Kt{constructor(e=1){let t=[0,0,0,e,0,0,0,0,0,0,e,0,0,0,0,0,0,e],n=[1,0,0,1,0.6,0,0,1,0,0.6,1,0,0,0,1,0,0.6,1],i=new ze;i.setAttribute("position",new Ae(t,3)),i.setAttribute("color",new Ae(n,3));let s=new Pt({vertexColors:!0,toneMapped:!1});super(i,s);this.type="AxesHelper"}setColors(e,t,n){let i=new ue,s=this.geometry.attributes.color.array;return i.set(e),i.toArray(s,0),i.toArray(s,3),i.set(t),i.toArray(s,6),i.toArray(s,9),i.set(n),i.toArray(s,12),i.toArray(s,15),this.geometry.attributes.color.needsUpdate=!0,this}dispose(){this.geometry.dispose(),this.material.dispose()}}class ex{constructor(){this.type="ShapePath",this.color=new ue,this.subPaths=[],this.currentPath=null}moveTo(e,t){return this.currentPath=new ys,this.subPaths.push(this.currentPath),this.currentPath.moveTo(e,t),this}lineTo(e,t){return this.currentPath.lineTo(e,t),this}quadraticCurveTo(e,t,n,i){return this.currentPath.quadraticCurveTo(e,t,n,i),this}bezierCurveTo(e,t,n,i,s,r){return this.currentPath.bezierCurveTo(e,t,n,i,s,r),this}splineThru(e){return this.currentPath.splineThru(e),this}toShapes(e){function t(m){let p=[];for(let x=0,v=m.length;x<v;x++){let b=m[x],R=new li;R.curves=b.curves,p.push(R)}return p}function n(m,p){let x=p.length,v=!1;for(let b=x-1,R=0;R<x;b=R++){let M=p[b],C=p[R],D=C.x-M.x,S=C.y-M.y;if(Math.abs(S)>Number.EPSILON){if(S<0)M=p[R],D=-D,C=p[b],S=-S;if(m.y<M.y||m.y>C.y)continue;if(m.y===M.y){if(m.x===M.x)return!0}else{let w=S*(m.x-M.x)-D*(m.y-M.y);if(w===0)return!0;if(w<0)continue;v=!v}}else{if(m.y!==M.y)continue;if(C.x<=m.x&&m.x<=M.x||M.x<=m.x&&m.x<=C.x)return!0}}return v}let i=Sn.isClockWise,s=this.subPaths;if(s.length===0)return[];let r,a,o,l=[];if(s.length===1)return a=s[0],o=new li,o.curves=a.curves,l.push(o),l;let c=!i(s[0].getPoints());c=e?!c:c;let h=[],u=[],d=[],f=0,g;u[f]=void 0,d[f]=[];for(let m=0,p=s.length;m<p;m++)if(a=s[m],g=a.getPoints(),r=i(g),r=e?!r:r,r){if(!c&&u[f])f++;if(u[f]={s:new li,p:g},u[f].s.curves=a.curves,c)f++;d[f]=[]}else d[f].push({h:a,p:g[0]});if(!u[0])return t(s);if(u.length>1){let m=!1,p=0;for(let x=0,v=u.length;x<v;x++)h[x]=[];for(let x=0,v=u.length;x<v;x++){let b=d[x];for(let R=0;R<b.length;R++){let M=b[R],C=!0;for(let D=0;D<u.length;D++)if(n(M.p,u[D].p)){if(x!==D)p++;if(C)C=!1,h[D].push(M);else m=!0}if(C)h[x].push(M)}}if(p>0&&m===!1)d=h}let _;for(let m=0,p=u.length;m<p;m++){o=u[m].s,l.push(o),_=d[m];for(let x=0,v=_.length;x<v;x++)o.holes.push(_[x].h)}return l}}if(typeof __THREE_DEVTOOLS__<"u")__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register",{detail:{revision:"160"}}));if(typeof window<"u")if(window.__THREE__)console.warn("WARNING: Multiple instances of Three.js being imported.");else window.__THREE__="160";var cu={type:"change"},Wo={type:"start"},hu={type:"end"},na=new On,uu=new ln,tx=Math.cos(70*Ir.DEG2RAD);class du extends nn{constructor(e,t){super();this.object=e,this.domElement=t,this.domElement.style.touchAction="none",this.enabled=!0,this.target=new T,this.cursor=new T,this.minDistance=0,this.maxDistance=1/0,this.minZoom=0,this.maxZoom=1/0,this.minTargetRadius=0,this.maxTargetRadius=1/0,this.minPolarAngle=0,this.maxPolarAngle=Math.PI,this.minAzimuthAngle=-1/0,this.maxAzimuthAngle=1/0,this.enableDamping=!1,this.dampingFactor=0.05,this.enableZoom=!0,this.zoomSpeed=1,this.enableRotate=!0,this.rotateSpeed=1,this.enablePan=!0,this.panSpeed=1,this.screenSpacePanning=!0,this.keyPanSpeed=7,this.zoomToCursor=!1,this.autoRotate=!1,this.autoRotateSpeed=2,this.keys={LEFT:"ArrowLeft",UP:"ArrowUp",RIGHT:"ArrowRight",BOTTOM:"ArrowDown"},this.mouseButtons={LEFT:ui.ROTATE,MIDDLE:ui.DOLLY,RIGHT:ui.PAN},this.touches={ONE:di.ROTATE,TWO:di.DOLLY_PAN},this.target0=this.target.clone(),this.position0=this.object.position.clone(),this.zoom0=this.object.zoom,this._domElementKeyEvents=null,this.getPolarAngle=function(){return a.phi},this.getAzimuthalAngle=function(){return a.theta},this.getDistance=function(){return this.object.position.distanceTo(this.target)},this.listenToKeyEvents=function(L){L.addEventListener("keydown",Y),this._domElementKeyEvents=L},this.stopListenToKeyEvents=function(){this._domElementKeyEvents.removeEventListener("keydown",Y),this._domElementKeyEvents=null},this.saveState=function(){n.target0.copy(n.target),n.position0.copy(n.object.position),n.zoom0=n.object.zoom},this.reset=function(){n.target.copy(n.target0),n.object.position.copy(n.position0),n.object.zoom=n.zoom0,n.object.updateProjectionMatrix(),n.dispatchEvent(cu),n.update(),s=i.NONE},this.update=function(){let L=new T,re=new _t().setFromUnitVectors(e.up,new T(0,1,0)),ye=re.clone().invert(),le=new T,_e=new _t,Oe=new T,Xe=2*Math.PI;return function(rt=null){let de=n.object.position;if(L.copy(de).sub(n.target),L.applyQuaternion(re),a.setFromVector3(L),n.autoRotate&&s===i.NONE)w(D(rt));if(n.enableDamping)a.theta+=o.theta*n.dampingFactor,a.phi+=o.phi*n.dampingFactor;else a.theta+=o.theta,a.phi+=o.phi;let{minAzimuthAngle:N,maxAzimuthAngle:he}=n;if(isFinite(N)&&isFinite(he)){if(N<-Math.PI)N+=Xe;else if(N>Math.PI)N-=Xe;if(he<-Math.PI)he+=Xe;else if(he>Math.PI)he-=Xe;if(N<=he)a.theta=Math.max(N,Math.min(he,a.theta));else a.theta=a.theta>(N+he)/2?Math.max(N,a.theta):Math.min(he,a.theta)}if(a.phi=Math.max(n.minPolarAngle,Math.min(n.maxPolarAngle,a.phi)),a.makeSafe(),n.enableDamping===!0)n.target.addScaledVector(c,n.dampingFactor);else n.target.add(c);if(n.target.sub(n.cursor),n.target.clampLength(n.minTargetRadius,n.maxTargetRadius),n.target.add(n.cursor),n.zoomToCursor&&R||n.object.isOrthographicCamera)a.radius=V(a.radius);else a.radius=V(a.radius*l);if(L.setFromSpherical(a),L.applyQuaternion(ye),de.copy(n.target).add(L),n.object.lookAt(n.target),n.enableDamping===!0)o.theta*=1-n.dampingFactor,o.phi*=1-n.dampingFactor,c.multiplyScalar(1-n.dampingFactor);else o.set(0,0,0),c.set(0,0,0);let me=!1;if(n.zoomToCursor&&R){let Ne=null;if(n.object.isPerspectiveCamera){let Ce=L.length();Ne=V(Ce*l);let it=Ce-Ne;n.object.position.addScaledVector(v,it),n.object.updateMatrixWorld()}else if(n.object.isOrthographicCamera){let Ce=new T(b.x,b.y,0);Ce.unproject(n.object),n.object.zoom=Math.max(n.minZoom,Math.min(n.maxZoom,n.object.zoom/l)),n.object.updateProjectionMatrix(),me=!0;let it=new T(b.x,b.y,0);it.unproject(n.object),n.object.position.sub(it).add(Ce),n.object.updateMatrixWorld(),Ne=L.length()}else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - zoom to cursor disabled."),n.zoomToCursor=!1;if(Ne!==null)if(this.screenSpacePanning)n.target.set(0,0,-1).transformDirection(n.object.matrix).multiplyScalar(Ne).add(n.object.position);else if(na.origin.copy(n.object.position),na.direction.set(0,0,-1).transformDirection(n.object.matrix),Math.abs(n.object.up.dot(na.direction))<tx)e.lookAt(n.target);else uu.setFromNormalAndCoplanarPoint(n.object.up,n.target),na.intersectPlane(uu,n.target)}else if(n.object.isOrthographicCamera)n.object.zoom=Math.max(n.minZoom,Math.min(n.maxZoom,n.object.zoom/l)),n.object.updateProjectionMatrix(),me=!0;if(l=1,R=!1,me||le.distanceToSquared(n.object.position)>r||8*(1-_e.dot(n.object.quaternion))>r||Oe.distanceToSquared(n.target)>0)return n.dispatchEvent(cu),le.copy(n.object.position),_e.copy(n.object.quaternion),Oe.copy(n.target),!0;return!1}}(),this.dispose=function(){if(n.domElement.removeEventListener("contextmenu",pe),n.domElement.removeEventListener("pointerdown",Se),n.domElement.removeEventListener("pointercancel",E),n.domElement.removeEventListener("wheel",ie),n.domElement.removeEventListener("pointermove",be),n.domElement.removeEventListener("pointerup",E),n._domElementKeyEvents!==null)n._domElementKeyEvents.removeEventListener("keydown",Y),n._domElementKeyEvents=null};let n=this,i={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,TOUCH_ROTATE:3,TOUCH_PAN:4,TOUCH_DOLLY_PAN:5,TOUCH_DOLLY_ROTATE:6},s=i.NONE,r=0.000001,a=new ta,o=new ta,l=1,c=new T,h=new W,u=new W,d=new W,f=new W,g=new W,_=new W,m=new W,p=new W,x=new W,v=new T,b=new W,R=!1,M=[],C={};function D(L){if(L!==null)return 2*Math.PI/60*n.autoRotateSpeed*L;else return 2*Math.PI/60/60*n.autoRotateSpeed}function S(L){let re=Math.abs(L)/(100*(window.devicePixelRatio|0));return Math.pow(0.95,n.zoomSpeed*re)}function w(L){o.theta-=L}function U(L){o.phi-=L}let J=function(){let L=new T;return function(ye,le){L.setFromMatrixColumn(le,0),L.multiplyScalar(-ye),c.add(L)}}(),ae=function(){let L=new T;return function(ye,le){if(n.screenSpacePanning===!0)L.setFromMatrixColumn(le,1);else L.setFromMatrixColumn(le,0),L.crossVectors(n.object.up,L);L.multiplyScalar(ye),c.add(L)}}(),I=function(){let L=new T;return function(ye,le){let _e=n.domElement;if(n.object.isPerspectiveCamera){let Oe=n.object.position;L.copy(Oe).sub(n.target);let Xe=L.length();Xe*=Math.tan(n.object.fov/2*Math.PI/180),J(2*ye*Xe/_e.clientHeight,n.object.matrix),ae(2*le*Xe/_e.clientHeight,n.object.matrix)}else if(n.object.isOrthographicCamera)J(ye*(n.object.right-n.object.left)/n.object.zoom/_e.clientWidth,n.object.matrix),ae(le*(n.object.top-n.object.bottom)/n.object.zoom/_e.clientHeight,n.object.matrix);else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - pan disabled."),n.enablePan=!1}}();function z(L){if(n.object.isPerspectiveCamera||n.object.isOrthographicCamera)l/=L;else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),n.enableZoom=!1}function X(L){if(n.object.isPerspectiveCamera||n.object.isOrthographicCamera)l*=L;else console.warn("WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled."),n.enableZoom=!1}function ne(L,re){if(!n.zoomToCursor)return;R=!0;let ye=n.domElement.getBoundingClientRect(),le=L-ye.left,_e=re-ye.top,{width:Oe,height:Xe}=ye;b.x=le/Oe*2-1,b.y=-(_e/Xe)*2+1,v.set(b.x,b.y,1).unproject(n.object).sub(n.object.position).normalize()}function V(L){return Math.max(n.minDistance,Math.min(n.maxDistance,L))}function q(L){h.set(L.clientX,L.clientY)}function ee(L){ne(L.clientX,L.clientX),m.set(L.clientX,L.clientY)}function oe(L){f.set(L.clientX,L.clientY)}function O(L){u.set(L.clientX,L.clientY),d.subVectors(u,h).multiplyScalar(n.rotateSpeed);let re=n.domElement;w(2*Math.PI*d.x/re.clientHeight),U(2*Math.PI*d.y/re.clientHeight),h.copy(u),n.update()}function te(L){if(p.set(L.clientX,L.clientY),x.subVectors(p,m),x.y>0)z(S(x.y));else if(x.y<0)X(S(x.y));m.copy(p),n.update()}function ge(L){g.set(L.clientX,L.clientY),_.subVectors(g,f).multiplyScalar(n.panSpeed),I(_.x,_.y),f.copy(g),n.update()}function ve(L){if(ne(L.clientX,L.clientY),L.deltaY<0)X(S(L.deltaY));else if(L.deltaY>0)z(S(L.deltaY));n.update()}function Ee(L){let re=!1;switch(L.code){case n.keys.UP:if(L.ctrlKey||L.metaKey||L.shiftKey)U(2*Math.PI*n.rotateSpeed/n.domElement.clientHeight);else I(0,n.keyPanSpeed);re=!0;break;case n.keys.BOTTOM:if(L.ctrlKey||L.metaKey||L.shiftKey)U(-2*Math.PI*n.rotateSpeed/n.domElement.clientHeight);else I(0,-n.keyPanSpeed);re=!0;break;case n.keys.LEFT:if(L.ctrlKey||L.metaKey||L.shiftKey)w(2*Math.PI*n.rotateSpeed/n.domElement.clientHeight);else I(n.keyPanSpeed,0);re=!0;break;case n.keys.RIGHT:if(L.ctrlKey||L.metaKey||L.shiftKey)w(-2*Math.PI*n.rotateSpeed/n.domElement.clientHeight);else I(-n.keyPanSpeed,0);re=!0;break}if(re)L.preventDefault(),n.update()}function Ie(L){if(M.length===1)h.set(L.pageX,L.pageY);else{let re=K(L),ye=0.5*(L.pageX+re.x),le=0.5*(L.pageY+re.y);h.set(ye,le)}}function ke(L){if(M.length===1)f.set(L.pageX,L.pageY);else{let re=K(L),ye=0.5*(L.pageX+re.x),le=0.5*(L.pageY+re.y);f.set(ye,le)}}function we(L){let re=K(L),ye=L.pageX-re.x,le=L.pageY-re.y,_e=Math.sqrt(ye*ye+le*le);m.set(0,_e)}function Ge(L){if(n.enableZoom)we(L);if(n.enablePan)ke(L)}function P(L){if(n.enableZoom)we(L);if(n.enableRotate)Ie(L)}function ce(L){if(M.length==1)u.set(L.pageX,L.pageY);else{let ye=K(L),le=0.5*(L.pageX+ye.x),_e=0.5*(L.pageY+ye.y);u.set(le,_e)}d.subVectors(u,h).multiplyScalar(n.rotateSpeed);let re=n.domElement;w(2*Math.PI*d.x/re.clientHeight),U(2*Math.PI*d.y/re.clientHeight),h.copy(u)}function j(L){if(M.length===1)g.set(L.pageX,L.pageY);else{let re=K(L),ye=0.5*(L.pageX+re.x),le=0.5*(L.pageY+re.y);g.set(ye,le)}_.subVectors(g,f).multiplyScalar(n.panSpeed),I(_.x,_.y),f.copy(g)}function Q(L){let re=K(L),ye=L.pageX-re.x,le=L.pageY-re.y,_e=Math.sqrt(ye*ye+le*le);p.set(0,_e),x.set(0,Math.pow(p.y/m.y,n.zoomSpeed)),z(x.y),m.copy(p);let Oe=(L.pageX+re.x)*0.5,Xe=(L.pageY+re.y)*0.5;ne(Oe,Xe)}function Z(L){if(n.enableZoom)Q(L);if(n.enablePan)j(L)}function xe(L){if(n.enableZoom)Q(L);if(n.enableRotate)ce(L)}function Se(L){if(n.enabled===!1)return;if(M.length===0)n.domElement.setPointerCapture(L.pointerId),n.domElement.addEventListener("pointermove",be),n.domElement.addEventListener("pointerup",E);if(Te(L),L.pointerType==="touch")se(L);else y(L)}function be(L){if(n.enabled===!1)return;if(L.pointerType==="touch")Le(L);else B(L)}function E(L){if(Re(L),M.length===0)n.domElement.releasePointerCapture(L.pointerId),n.domElement.removeEventListener("pointermove",be),n.domElement.removeEventListener("pointerup",E);n.dispatchEvent(hu),s=i.NONE}function y(L){let re;switch(L.button){case 0:re=n.mouseButtons.LEFT;break;case 1:re=n.mouseButtons.MIDDLE;break;case 2:re=n.mouseButtons.RIGHT;break;default:re=-1}switch(re){case ui.DOLLY:if(n.enableZoom===!1)return;ee(L),s=i.DOLLY;break;case ui.ROTATE:if(L.ctrlKey||L.metaKey||L.shiftKey){if(n.enablePan===!1)return;oe(L),s=i.PAN}else{if(n.enableRotate===!1)return;q(L),s=i.ROTATE}break;case ui.PAN:if(L.ctrlKey||L.metaKey||L.shiftKey){if(n.enableRotate===!1)return;q(L),s=i.ROTATE}else{if(n.enablePan===!1)return;oe(L),s=i.PAN}break;default:s=i.NONE}if(s!==i.NONE)n.dispatchEvent(Wo)}function B(L){switch(s){case i.ROTATE:if(n.enableRotate===!1)return;O(L);break;case i.DOLLY:if(n.enableZoom===!1)return;te(L);break;case i.PAN:if(n.enablePan===!1)return;ge(L);break}}function ie(L){if(n.enabled===!1||n.enableZoom===!1||s!==i.NONE)return;L.preventDefault(),n.dispatchEvent(Wo),ve(L),n.dispatchEvent(hu)}function Y(L){if(n.enabled===!1||n.enablePan===!1)return;Ee(L)}function se(L){switch(Fe(L),M.length){case 1:switch(n.touches.ONE){case di.ROTATE:if(n.enableRotate===!1)return;Ie(L),s=i.TOUCH_ROTATE;break;case di.PAN:if(n.enablePan===!1)return;ke(L),s=i.TOUCH_PAN;break;default:s=i.NONE}break;case 2:switch(n.touches.TWO){case di.DOLLY_PAN:if(n.enableZoom===!1&&n.enablePan===!1)return;Ge(L),s=i.TOUCH_DOLLY_PAN;break;case di.DOLLY_ROTATE:if(n.enableZoom===!1&&n.enableRotate===!1)return;P(L),s=i.TOUCH_DOLLY_ROTATE;break;default:s=i.NONE}break;default:s=i.NONE}if(s!==i.NONE)n.dispatchEvent(Wo)}function Le(L){switch(Fe(L),s){case i.TOUCH_ROTATE:if(n.enableRotate===!1)return;ce(L),n.update();break;case i.TOUCH_PAN:if(n.enablePan===!1)return;j(L),n.update();break;case i.TOUCH_DOLLY_PAN:if(n.enableZoom===!1&&n.enablePan===!1)return;Z(L),n.update();break;case i.TOUCH_DOLLY_ROTATE:if(n.enableZoom===!1&&n.enableRotate===!1)return;xe(L),n.update();break;default:s=i.NONE}}function pe(L){if(n.enabled===!1)return;L.preventDefault()}function Te(L){M.push(L.pointerId)}function Re(L){delete C[L.pointerId];for(let re=0;re<M.length;re++)if(M[re]==L.pointerId){M.splice(re,1);return}}function Fe(L){let re=C[L.pointerId];if(re===void 0)re=new W,C[L.pointerId]=re;re.set(L.pageX,L.pageY)}function K(L){let re=L.pointerId===M[0]?M[1]:M[0];return C[re]}n.domElement.addEventListener("contextmenu",pe),n.domElement.addEventListener("pointerdown",Se),n.domElement.addEventListener("pointercancel",E),n.domElement.addEventListener("wheel",ie,{passive:!1}),this.update()}}function Vo(e,t){if(t===Jc)return console.warn("THREE.BufferGeometryUtils.toTrianglesDrawMode(): Geometry already defined as triangles."),e;if(t===As||t===Lr){let n=e.getIndex();if(n===null){let a=[],o=e.getAttribute("position");if(o!==void 0){for(let l=0;l<o.count;l++)a.push(l);e.setIndex(a),n=e.getIndex()}else return console.error("THREE.BufferGeometryUtils.toTrianglesDrawMode(): Undefined position attribute. Processing not possible."),e}let i=n.count-2,s=[];if(t===As)for(let a=1;a<=i;a++)s.push(n.getX(0)),s.push(n.getX(a)),s.push(n.getX(a+1));else for(let a=0;a<i;a++)if(a%2===0)s.push(n.getX(a)),s.push(n.getX(a+1)),s.push(n.getX(a+2));else s.push(n.getX(a+2)),s.push(n.getX(a+1)),s.push(n.getX(a));if(s.length/3!==i)console.error("THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unable to generate correct amount of triangles.");let r=e.clone();return r.setIndex(s),r.clearGroups(),r}else return console.error("THREE.BufferGeometryUtils.toTrianglesDrawMode(): Unknown draw mode:",t),e}class _u extends Ut{constructor(e){super(e);this.dracoLoader=null,this.ktx2Loader=null,this.meshoptDecoder=null,this.pluginCallbacks=[],this.register(function(t){return new Su(t)}),this.register(function(t){return new Pu(t)}),this.register(function(t){return new Lu(t)}),this.register(function(t){return new Iu(t)}),this.register(function(t){return new bu(t)}),this.register(function(t){return new Tu(t)}),this.register(function(t){return new Au(t)}),this.register(function(t){return new Eu(t)}),this.register(function(t){return new yu(t)}),this.register(function(t){return new wu(t)}),this.register(function(t){return new Mu(t)}),this.register(function(t){return new Cu(t)}),this.register(function(t){return new Ru(t)}),this.register(function(t){return new xu(t)}),this.register(function(t){return new Nu(t)}),this.register(function(t){return new Du(t)})}load(e,t,n,i){let s=this,r;if(this.resourcePath!=="")r=this.resourcePath;else if(this.path!==""){let l=Tn.extractUrlBase(e);r=Tn.resolveURL(l,this.path)}else r=Tn.extractUrlBase(e);this.manager.itemStart(e);let a=function(l){if(i)i(l);else console.error(l);s.manager.itemError(e),s.manager.itemEnd(e)},o=new Zt(this.manager);o.setPath(this.path),o.setResponseType("arraybuffer"),o.setRequestHeader(this.requestHeader),o.setWithCredentials(this.withCredentials),o.load(e,function(l){try{s.parse(l,r,function(c){t(c),s.manager.itemEnd(e)},a)}catch(c){a(c)}},n,a)}setDRACOLoader(e){return this.dracoLoader=e,this}setDDSLoader(){throw Error('THREE.GLTFLoader: "MSFT_texture_dds" no longer supported. Please update to "KHR_texture_basisu".')}setKTX2Loader(e){return this.ktx2Loader=e,this}setMeshoptDecoder(e){return this.meshoptDecoder=e,this}register(e){if(this.pluginCallbacks.indexOf(e)===-1)this.pluginCallbacks.push(e);return this}unregister(e){if(this.pluginCallbacks.indexOf(e)!==-1)this.pluginCallbacks.splice(this.pluginCallbacks.indexOf(e),1);return this}parse(e,t,n,i){let s,r={},a={},o=new TextDecoder;if(typeof e==="string")s=JSON.parse(e);else if(e instanceof ArrayBuffer)if(o.decode(new Uint8Array(e,0,4))===Uu){try{r[$e.KHR_BINARY_GLTF]=new Fu(e)}catch(h){if(i)i(h);return}s=JSON.parse(r[$e.KHR_BINARY_GLTF].content)}else s=JSON.parse(o.decode(e));else s=e;if(s.asset===void 0||s.asset.version[0]<2){if(i)i(Error("THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported."));return}let l=new Gu(s,{path:t||this.resourcePath||"",crossOrigin:this.crossOrigin,requestHeader:this.requestHeader,manager:this.manager,ktx2Loader:this.ktx2Loader,meshoptDecoder:this.meshoptDecoder});l.fileLoader.setRequestHeader(this.requestHeader);for(let c=0;c<this.pluginCallbacks.length;c++){let h=this.pluginCallbacks[c](l);if(!h.name)console.error("THREE.GLTFLoader: Invalid plugin found: missing name");a[h.name]=h,r[h.name]=!0}if(s.extensionsUsed)for(let c=0;c<s.extensionsUsed.length;++c){let h=s.extensionsUsed[c],u=s.extensionsRequired||[];switch(h){case $e.KHR_MATERIALS_UNLIT:r[h]=new vu;break;case $e.KHR_DRACO_MESH_COMPRESSION:r[h]=new Ou(s,this.dracoLoader);break;case $e.KHR_TEXTURE_TRANSFORM:r[h]=new Bu;break;case $e.KHR_MESH_QUANTIZATION:r[h]=new zu;break;default:if(u.indexOf(h)>=0&&a[h]===void 0)console.warn('THREE.GLTFLoader: Unknown extension "'+h+'".')}}l.setExtensions(r),l.setPlugins(a),l.parse(n,i)}parseAsync(e,t){let n=this;return new Promise(function(i,s){n.parse(e,t,i,s)})}}function nx(){let e={};return{get:function(t){return e[t]},add:function(t,n){e[t]=n},remove:function(t){delete e[t]},removeAll:function(){e={}}}}var $e={KHR_BINARY_GLTF:"KHR_binary_glTF",KHR_DRACO_MESH_COMPRESSION:"KHR_draco_mesh_compression",KHR_LIGHTS_PUNCTUAL:"KHR_lights_punctual",KHR_MATERIALS_CLEARCOAT:"KHR_materials_clearcoat",KHR_MATERIALS_IOR:"KHR_materials_ior",KHR_MATERIALS_SHEEN:"KHR_materials_sheen",KHR_MATERIALS_SPECULAR:"KHR_materials_specular",KHR_MATERIALS_TRANSMISSION:"KHR_materials_transmission",KHR_MATERIALS_IRIDESCENCE:"KHR_materials_iridescence",KHR_MATERIALS_ANISOTROPY:"KHR_materials_anisotropy",KHR_MATERIALS_UNLIT:"KHR_materials_unlit",KHR_MATERIALS_VOLUME:"KHR_materials_volume",KHR_TEXTURE_BASISU:"KHR_texture_basisu",KHR_TEXTURE_TRANSFORM:"KHR_texture_transform",KHR_MESH_QUANTIZATION:"KHR_mesh_quantization",KHR_MATERIALS_EMISSIVE_STRENGTH:"KHR_materials_emissive_strength",EXT_MATERIALS_BUMP:"EXT_materials_bump",EXT_TEXTURE_WEBP:"EXT_texture_webp",EXT_TEXTURE_AVIF:"EXT_texture_avif",EXT_MESHOPT_COMPRESSION:"EXT_meshopt_compression",EXT_MESH_GPU_INSTANCING:"EXT_mesh_gpu_instancing"};class xu{constructor(e){this.parser=e,this.name=$e.KHR_LIGHTS_PUNCTUAL,this.cache={refs:{},uses:{}}}_markDefs(){let e=this.parser,t=this.parser.json.nodes||[];for(let n=0,i=t.length;n<i;n++){let s=t[n];if(s.extensions&&s.extensions[this.name]&&s.extensions[this.name].light!==void 0)e._addNodeRef(this.cache,s.extensions[this.name].light)}}_loadLight(e){let t=this.parser,n="light:"+e,i=t.cache.get(n);if(i)return i;let s=t.json,o=((s.extensions&&s.extensions[this.name]||{}).lights||[])[e],l,c=new ue(16777215);if(o.color!==void 0)c.setRGB(o.color[0],o.color[1],o.color[2],dn);let h=o.range!==void 0?o.range:0;switch(o.type){case"directional":l=new Qr(c),l.target.position.set(0,0,-1),l.add(l.target);break;case"point":l=new $i(c),l.distance=h;break;case"spot":l=new jr(c),l.distance=h,o.spot=o.spot||{},o.spot.innerConeAngle=o.spot.innerConeAngle!==void 0?o.spot.innerConeAngle:0,o.spot.outerConeAngle=o.spot.outerConeAngle!==void 0?o.spot.outerConeAngle:Math.PI/4,l.angle=o.spot.outerConeAngle,l.penumbra=1-o.spot.innerConeAngle/o.spot.outerConeAngle,l.target.position.set(0,0,-1),l.add(l.target);break;default:throw Error("THREE.GLTFLoader: Unexpected light type: "+o.type)}if(l.position.set(0,0,0),l.decay=2,Wn(l,o),o.intensity!==void 0)l.intensity=o.intensity;return l.name=t.createUniqueName(o.name||"light_"+e),i=Promise.resolve(l),t.cache.add(n,i),i}getDependency(e,t){if(e!=="light")return;return this._loadLight(t)}createNodeAttachment(e){let t=this,n=this.parser,s=n.json.nodes[e],a=(s.extensions&&s.extensions[this.name]||{}).light;if(a===void 0)return null;return this._loadLight(a).then(function(o){return n._getNodeRef(t.cache,a,o)})}}class vu{constructor(){this.name=$e.KHR_MATERIALS_UNLIT}getMaterialType(){return wt}extendParams(e,t,n){let i=[];e.color=new ue(1,1,1),e.opacity=1;let s=t.pbrMetallicRoughness;if(s){if(Array.isArray(s.baseColorFactor)){let r=s.baseColorFactor;e.color.setRGB(r[0],r[1],r[2],dn),e.opacity=r[3]}if(s.baseColorTexture!==void 0)i.push(n.assignTexture(e,"map",s.baseColorTexture,Ki))}return Promise.all(i)}}class yu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_EMISSIVE_STRENGTH}extendMaterialParams(e,t){let i=this.parser.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=i.extensions[this.name].emissiveStrength;if(s!==void 0)t.emissiveIntensity=s;return Promise.resolve()}}class Su{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_CLEARCOAT}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(r.clearcoatFactor!==void 0)t.clearcoat=r.clearcoatFactor;if(r.clearcoatTexture!==void 0)s.push(n.assignTexture(t,"clearcoatMap",r.clearcoatTexture));if(r.clearcoatRoughnessFactor!==void 0)t.clearcoatRoughness=r.clearcoatRoughnessFactor;if(r.clearcoatRoughnessTexture!==void 0)s.push(n.assignTexture(t,"clearcoatRoughnessMap",r.clearcoatRoughnessTexture));if(r.clearcoatNormalTexture!==void 0){if(s.push(n.assignTexture(t,"clearcoatNormalMap",r.clearcoatNormalTexture)),r.clearcoatNormalTexture.scale!==void 0){let a=r.clearcoatNormalTexture.scale;t.clearcoatNormalScale=new W(a,a)}}return Promise.all(s)}}class Mu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_IRIDESCENCE}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(r.iridescenceFactor!==void 0)t.iridescence=r.iridescenceFactor;if(r.iridescenceTexture!==void 0)s.push(n.assignTexture(t,"iridescenceMap",r.iridescenceTexture));if(r.iridescenceIor!==void 0)t.iridescenceIOR=r.iridescenceIor;if(t.iridescenceThicknessRange===void 0)t.iridescenceThicknessRange=[100,400];if(r.iridescenceThicknessMinimum!==void 0)t.iridescenceThicknessRange[0]=r.iridescenceThicknessMinimum;if(r.iridescenceThicknessMaximum!==void 0)t.iridescenceThicknessRange[1]=r.iridescenceThicknessMaximum;if(r.iridescenceThicknessTexture!==void 0)s.push(n.assignTexture(t,"iridescenceThicknessMap",r.iridescenceThicknessTexture));return Promise.all(s)}}class bu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_SHEEN}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[];t.sheenColor=new ue(0,0,0),t.sheenRoughness=0,t.sheen=1;let r=i.extensions[this.name];if(r.sheenColorFactor!==void 0){let a=r.sheenColorFactor;t.sheenColor.setRGB(a[0],a[1],a[2],dn)}if(r.sheenRoughnessFactor!==void 0)t.sheenRoughness=r.sheenRoughnessFactor;if(r.sheenColorTexture!==void 0)s.push(n.assignTexture(t,"sheenColorMap",r.sheenColorTexture,Ki));if(r.sheenRoughnessTexture!==void 0)s.push(n.assignTexture(t,"sheenRoughnessMap",r.sheenRoughnessTexture));return Promise.all(s)}}class Tu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_TRANSMISSION}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(r.transmissionFactor!==void 0)t.transmission=r.transmissionFactor;if(r.transmissionTexture!==void 0)s.push(n.assignTexture(t,"transmissionMap",r.transmissionTexture));return Promise.all(s)}}class Au{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_VOLUME}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(t.thickness=r.thicknessFactor!==void 0?r.thicknessFactor:0,r.thicknessTexture!==void 0)s.push(n.assignTexture(t,"thicknessMap",r.thicknessTexture));t.attenuationDistance=r.attenuationDistance||1/0;let a=r.attenuationColor||[1,1,1];return t.attenuationColor=new ue().setRGB(a[0],a[1],a[2],dn),Promise.all(s)}}class Eu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_IOR}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let i=this.parser.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=i.extensions[this.name];return t.ior=s.ior!==void 0?s.ior:1.5,Promise.resolve()}}class wu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_SPECULAR}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(t.specularIntensity=r.specularFactor!==void 0?r.specularFactor:1,r.specularTexture!==void 0)s.push(n.assignTexture(t,"specularIntensityMap",r.specularTexture));let a=r.specularColorFactor||[1,1,1];if(t.specularColor=new ue().setRGB(a[0],a[1],a[2],dn),r.specularColorTexture!==void 0)s.push(n.assignTexture(t,"specularColorMap",r.specularColorTexture,Ki));return Promise.all(s)}}class Ru{constructor(e){this.parser=e,this.name=$e.EXT_MATERIALS_BUMP}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(t.bumpScale=r.bumpFactor!==void 0?r.bumpFactor:1,r.bumpTexture!==void 0)s.push(n.assignTexture(t,"bumpMap",r.bumpTexture));return Promise.all(s)}}class Cu{constructor(e){this.parser=e,this.name=$e.KHR_MATERIALS_ANISOTROPY}getMaterialType(e){let n=this.parser.json.materials[e];if(!n.extensions||!n.extensions[this.name])return null;return Jt}extendMaterialParams(e,t){let n=this.parser,i=n.json.materials[e];if(!i.extensions||!i.extensions[this.name])return Promise.resolve();let s=[],r=i.extensions[this.name];if(r.anisotropyStrength!==void 0)t.anisotropy=r.anisotropyStrength;if(r.anisotropyRotation!==void 0)t.anisotropyRotation=r.anisotropyRotation;if(r.anisotropyTexture!==void 0)s.push(n.assignTexture(t,"anisotropyMap",r.anisotropyTexture));return Promise.all(s)}}class Pu{constructor(e){this.parser=e,this.name=$e.KHR_TEXTURE_BASISU}loadTexture(e){let t=this.parser,n=t.json,i=n.textures[e];if(!i.extensions||!i.extensions[this.name])return null;let s=i.extensions[this.name],r=t.options.ktx2Loader;if(!r)if(n.extensionsRequired&&n.extensionsRequired.indexOf(this.name)>=0)throw Error("THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures");else return null;return t.loadTextureImage(e,s.source,r)}}class Lu{constructor(e){this.parser=e,this.name=$e.EXT_TEXTURE_WEBP,this.isSupported=null}loadTexture(e){let t=this.name,n=this.parser,i=n.json,s=i.textures[e];if(!s.extensions||!s.extensions[t])return null;let r=s.extensions[t],a=i.images[r.source],o=n.textureLoader;if(a.uri){let l=n.options.manager.getHandler(a.uri);if(l!==null)o=l}return this.detectSupport().then(function(l){if(l)return n.loadTextureImage(e,r.source,o);if(i.extensionsRequired&&i.extensionsRequired.indexOf(t)>=0)throw Error("THREE.GLTFLoader: WebP required by asset but unsupported.");return n.loadTexture(e)})}detectSupport(){if(!this.isSupported)this.isSupported=new Promise(function(e){let t=new Image;t.src="data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",t.onload=t.onerror=function(){e(t.height===1)}});return this.isSupported}}class Iu{constructor(e){this.parser=e,this.name=$e.EXT_TEXTURE_AVIF,this.isSupported=null}loadTexture(e){let t=this.name,n=this.parser,i=n.json,s=i.textures[e];if(!s.extensions||!s.extensions[t])return null;let r=s.extensions[t],a=i.images[r.source],o=n.textureLoader;if(a.uri){let l=n.options.manager.getHandler(a.uri);if(l!==null)o=l}return this.detectSupport().then(function(l){if(l)return n.loadTextureImage(e,r.source,o);if(i.extensionsRequired&&i.extensionsRequired.indexOf(t)>=0)throw Error("THREE.GLTFLoader: AVIF required by asset but unsupported.");return n.loadTexture(e)})}detectSupport(){if(!this.isSupported)this.isSupported=new Promise(function(e){let t=new Image;t.src="data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABcAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKCBgABogQEDQgMgkQAAAAB8dSLfI=",t.onload=t.onerror=function(){e(t.height===1)}});return this.isSupported}}class Nu{constructor(e){this.name=$e.EXT_MESHOPT_COMPRESSION,this.parser=e}loadBufferView(e){let t=this.parser.json,n=t.bufferViews[e];if(n.extensions&&n.extensions[this.name]){let i=n.extensions[this.name],s=this.parser.getDependency("buffer",i.buffer),r=this.parser.options.meshoptDecoder;if(!r||!r.supported)if(t.extensionsRequired&&t.extensionsRequired.indexOf(this.name)>=0)throw Error("THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files");else return null;return s.then(function(a){let o=i.byteOffset||0,l=i.byteLength||0,{count:c,byteStride:h}=i,u=new Uint8Array(a,o,l);if(r.decodeGltfBufferAsync)return r.decodeGltfBufferAsync(c,h,u,i.mode,i.filter).then(function(d){return d.buffer});else return r.ready.then(function(){let d=new ArrayBuffer(c*h);return r.decodeGltfBuffer(new Uint8Array(d),c,h,u,i.mode,i.filter),d})})}else return null}}class Du{constructor(e){this.name=$e.EXT_MESH_GPU_INSTANCING,this.parser=e}createNodeMesh(e){let t=this.parser.json,n=t.nodes[e];if(!n.extensions||!n.extensions[this.name]||n.mesh===void 0)return null;let i=t.meshes[n.mesh];for(let l of i.primitives)if(l.mode!==$t.TRIANGLES&&l.mode!==$t.TRIANGLE_STRIP&&l.mode!==$t.TRIANGLE_FAN&&l.mode!==void 0)return null;let r=n.extensions[this.name].attributes,a=[],o={};for(let l in r)a.push(this.parser.getDependency("accessor",r[l]).then((c)=>(o[l]=c,o[l])));if(a.length<1)return null;return a.push(this.parser.createNodeMesh(e)),Promise.all(a).then((l)=>{let c=l.pop(),h=c.isGroup?c.children:[c],u=l[0].count,d=[];for(let f of h){let g=new De,_=new T,m=new _t,p=new T(1,1,1),x=new Gr(f.geometry,f.material,u);for(let v=0;v<u;v++){if(o.TRANSLATION)_.fromBufferAttribute(o.TRANSLATION,v);if(o.ROTATION)m.fromBufferAttribute(o.ROTATION,v);if(o.SCALE)p.fromBufferAttribute(o.SCALE,v);x.setMatrixAt(v,g.compose(_,m,p))}for(let v in o)if(v==="_COLOR_0"){let b=o[v];x.instanceColor=new bn(b.array,b.itemSize,b.normalized)}else if(v!=="TRANSLATION"&&v!=="ROTATION"&&v!=="SCALE")f.geometry.setAttribute(v,o[v]);et.prototype.copy.call(x,f),this.parser.assignFinalMaterial(x),d.push(x)}if(c.isGroup)return c.clear(),c.add(...d),c;return d[0]})}}var Uu="glTF",Is=12,fu={JSON:1313821514,BIN:5130562};class Fu{constructor(e){this.name=$e.KHR_BINARY_GLTF,this.content=null,this.body=null;let t=new DataView(e,0,Is),n=new TextDecoder;if(this.header={magic:n.decode(new Uint8Array(e.slice(0,4))),version:t.getUint32(4,!0),length:t.getUint32(8,!0)},this.header.magic!==Uu)throw Error("THREE.GLTFLoader: Unsupported glTF-Binary header.");else if(this.header.version<2)throw Error("THREE.GLTFLoader: Legacy binary file detected.");let i=this.header.length-Is,s=new DataView(e,Is),r=0;while(r<i){let a=s.getUint32(r,!0);r+=4;let o=s.getUint32(r,!0);if(r+=4,o===fu.JSON){let l=new Uint8Array(e,Is+r,a);this.content=n.decode(l)}else if(o===fu.BIN){let l=Is+r;this.body=e.slice(l,l+a)}r+=a}if(this.content===null)throw Error("THREE.GLTFLoader: JSON content not found.")}}class Ou{constructor(e,t){if(!t)throw Error("THREE.GLTFLoader: No DRACOLoader instance provided.");this.name=$e.KHR_DRACO_MESH_COMPRESSION,this.json=e,this.dracoLoader=t,this.dracoLoader.preload()}decodePrimitive(e,t){let n=this.json,i=this.dracoLoader,s=e.extensions[this.name].bufferView,r=e.extensions[this.name].attributes,a={},o={},l={};for(let c in r){let h=Zo[c]||c.toLowerCase();a[h]=r[c]}for(let c in e.attributes){let h=Zo[c]||c.toLowerCase();if(r[c]!==void 0){let u=n.accessors[e.attributes[c]],d=ji[u.componentType];l[h]=d.name,o[h]=u.normalized===!0}}return t.getDependency("bufferView",s).then(function(c){return new Promise(function(h,u){i.decodeDracoFile(c,function(d){for(let f in d.attributes){let g=d.attributes[f],_=o[f];if(_!==void 0)g.normalized=_}h(d)},a,l,dn,u)})})}}class Bu{constructor(){this.name=$e.KHR_TEXTURE_TRANSFORM}extendTexture(e,t){if((t.texCoord===void 0||t.texCoord===e.channel)&&t.offset===void 0&&t.rotation===void 0&&t.scale===void 0)return e;if(e=e.clone(),t.texCoord!==void 0)e.channel=t.texCoord;if(t.offset!==void 0)e.offset.fromArray(t.offset);if(t.rotation!==void 0)e.rotation=t.rotation;if(t.scale!==void 0)e.repeat.fromArray(t.scale);return e.needsUpdate=!0,e}}class zu{constructor(){this.name=$e.KHR_MESH_QUANTIZATION}}class Jo extends mi{constructor(e,t,n,i){super(e,t,n,i)}copySampleValue_(e){let t=this.resultBuffer,n=this.sampleValues,i=this.valueSize,s=e*i*3+i;for(let r=0;r!==i;r++)t[r]=n[s+r];return t}interpolate_(e,t,n,i){let s=this.resultBuffer,r=this.sampleValues,a=this.valueSize,o=a*2,l=a*3,c=i-t,h=(n-t)/c,u=h*h,d=u*h,f=e*l,g=f-l,_=-2*d+3*u,m=d-u,p=1-_,x=m-u+h;for(let v=0;v!==a;v++){let b=r[g+v+a],R=r[g+v+o]*c,M=r[f+v+a],C=r[f+v]*c;s[v]=p*b+x*R+_*M+m*C}return s}}var ix=new _t;class ku extends Jo{interpolate_(e,t,n,i){let s=super.interpolate_(e,t,n,i);return ix.fromArray(s).normalize().toArray(s),s}}var $t={FLOAT:5126,FLOAT_MAT3:35675,FLOAT_MAT4:35676,FLOAT_VEC2:35664,FLOAT_VEC3:35665,FLOAT_VEC4:35666,LINEAR:9729,REPEAT:10497,SAMPLER_2D:35678,POINTS:0,LINES:1,LINE_LOOP:2,LINE_STRIP:3,TRIANGLES:4,TRIANGLE_STRIP:5,TRIANGLE_FAN:6,UNSIGNED_BYTE:5121,UNSIGNED_SHORT:5123},ji={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array},pu={9728:Xc,9729:Qa,9984:qc,9985:Zc,9986:Yc,9987:eo},mu={33071:Wc,33648:Vc,10497:Pr},Xo={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16},Zo={POSITION:"position",NORMAL:"normal",TANGENT:"tangent",TEXCOORD_0:"uv",TEXCOORD_1:"uv1",TEXCOORD_2:"uv2",TEXCOORD_3:"uv3",COLOR_0:"color",WEIGHTS_0:"skinWeight",JOINTS_0:"skinIndex"},Hn={scale:"scale",translation:"position",rotation:"quaternion",weights:"morphTargetInfluences"},sx={CUBICSPLINE:void 0,LINEAR:to,STEP:Kc},qo={OPAQUE:"OPAQUE",MASK:"MASK",BLEND:"BLEND"};function rx(e){if(e.DefaultMaterial===void 0)e.DefaultMaterial=new An({color:16777215,emissive:0,metalness:1,roughness:1,transparent:!1,depthTest:!0,side:Nc});return e.DefaultMaterial}function xi(e,t,n){for(let i in n.extensions)if(e[i]===void 0)t.userData.gltfExtensions=t.userData.gltfExtensions||{},t.userData.gltfExtensions[i]=n.extensions[i]}function Wn(e,t){if(t.extras!==void 0)if(typeof t.extras==="object")Object.assign(e.userData,t.extras);else console.warn("THREE.GLTFLoader: Ignoring primitive type .extras, "+t.extras)}function ax(e,t,n){let i=!1,s=!1,r=!1;for(let c=0,h=t.length;c<h;c++){let u=t[c];if(u.POSITION!==void 0)i=!0;if(u.NORMAL!==void 0)s=!0;if(u.COLOR_0!==void 0)r=!0;if(i&&s&&r)break}if(!i&&!s&&!r)return Promise.resolve(e);let a=[],o=[],l=[];for(let c=0,h=t.length;c<h;c++){let u=t[c];if(i){let d=u.POSITION!==void 0?n.getDependency("accessor",u.POSITION):e.attributes.position;a.push(d)}if(s){let d=u.NORMAL!==void 0?n.getDependency("accessor",u.NORMAL):e.attributes.normal;o.push(d)}if(r){let d=u.COLOR_0!==void 0?n.getDependency("accessor",u.COLOR_0):e.attributes.color;l.push(d)}}return Promise.all([Promise.all(a),Promise.all(o),Promise.all(l)]).then(function(c){let h=c[0],u=c[1],d=c[2];if(i)e.morphAttributes.position=h;if(s)e.morphAttributes.normal=u;if(r)e.morphAttributes.color=d;return e.morphTargetsRelative=!0,e})}function ox(e,t){if(e.updateMorphTargets(),t.weights!==void 0)for(let n=0,i=t.weights.length;n<i;n++)e.morphTargetInfluences[n]=t.weights[n];if(t.extras&&Array.isArray(t.extras.targetNames)){let n=t.extras.targetNames;if(e.morphTargetInfluences.length===n.length){e.morphTargetDictionary={};for(let i=0,s=n.length;i<s;i++)e.morphTargetDictionary[n[i]]=i}else console.warn("THREE.GLTFLoader: Invalid extras.targetNames length. Ignoring names.")}}function lx(e){let t,n=e.extensions&&e.extensions[$e.KHR_DRACO_MESH_COMPRESSION];if(n)t="draco:"+n.bufferView+":"+n.indices+":"+Yo(n.attributes);else t=e.indices+":"+Yo(e.attributes)+":"+e.mode;if(e.targets!==void 0)for(let i=0,s=e.targets.length;i<s;i++)t+=":"+Yo(e.targets[i]);return t}function Yo(e){let t="",n=Object.keys(e).sort();for(let i=0,s=n.length;i<s;i++)t+=n[i]+":"+e[n[i]]+";";return t}function Ko(e){switch(e){case Int8Array:return 0.007874015748031496;case Uint8Array:return 0.00392156862745098;case Int16Array:return 0.00003051850947599719;case Uint16Array:return 0.000015259021896696422;default:throw Error("THREE.GLTFLoader: Unsupported normalized accessor component type.")}}function cx(e){if(e.search(/\.jpe?g($|\?)/i)>0||e.search(/^data\:image\/jpeg/)===0)return"image/jpeg";if(e.search(/\.webp($|\?)/i)>0||e.search(/^data\:image\/webp/)===0)return"image/webp";return"image/png"}var hx=new De;class Gu{constructor(e={},t={}){this.json=e,this.extensions={},this.plugins={},this.options=t,this.cache=new nx,this.associations=new Map,this.primitiveCache={},this.nodeCache={},this.meshCache={refs:{},uses:{}},this.cameraCache={refs:{},uses:{}},this.lightCache={refs:{},uses:{}},this.sourceCache={},this.textureCache={},this.nodeNamesUsed={};let n=!1,i=!1,s=-1;if(typeof navigator<"u")n=/^((?!chrome|android).)*safari/i.test(navigator.userAgent)===!0,i=navigator.userAgent.indexOf("Firefox")>-1,s=i?navigator.userAgent.match(/Firefox\/([0-9]+)\./)[1]:-1;if(typeof createImageBitmap>"u"||n||i&&s<98)this.textureLoader=new Oo(this.options.manager);else this.textureLoader=new zo(this.options.manager);if(this.textureLoader.setCrossOrigin(this.options.crossOrigin),this.textureLoader.setRequestHeader(this.options.requestHeader),this.fileLoader=new Zt(this.options.manager),this.fileLoader.setResponseType("arraybuffer"),this.options.crossOrigin==="use-credentials")this.fileLoader.setWithCredentials(!0)}setExtensions(e){this.extensions=e}setPlugins(e){this.plugins=e}parse(e,t){let n=this,i=this.json,s=this.extensions;this.cache.removeAll(),this.nodeCache={},this._invokeAll(function(r){return r._markDefs&&r._markDefs()}),Promise.all(this._invokeAll(function(r){return r.beforeRoot&&r.beforeRoot()})).then(function(){return Promise.all([n.getDependencies("scene"),n.getDependencies("animation"),n.getDependencies("camera")])}).then(function(r){let a={scene:r[0][i.scene||0],scenes:r[0],animations:r[1],cameras:r[2],asset:i.asset,parser:n,userData:{}};return xi(s,a,i),Wn(a,i),Promise.all(n._invokeAll(function(o){return o.afterRoot&&o.afterRoot(a)})).then(function(){e(a)})}).catch(t)}_markDefs(){let e=this.json.nodes||[],t=this.json.skins||[],n=this.json.meshes||[];for(let i=0,s=t.length;i<s;i++){let r=t[i].joints;for(let a=0,o=r.length;a<o;a++)e[r[a]].isBone=!0}for(let i=0,s=e.length;i<s;i++){let r=e[i];if(r.mesh!==void 0){if(this._addNodeRef(this.meshCache,r.mesh),r.skin!==void 0)n[r.mesh].isSkinnedMesh=!0}if(r.camera!==void 0)this._addNodeRef(this.cameraCache,r.camera)}}_addNodeRef(e,t){if(t===void 0)return;if(e.refs[t]===void 0)e.refs[t]=e.uses[t]=0;e.refs[t]++}_getNodeRef(e,t,n){if(e.refs[t]<=1)return n;let i=n.clone(),s=(r,a)=>{let o=this.associations.get(r);if(o!=null)this.associations.set(a,o);for(let[l,c]of r.children.entries())s(c,a.children[l])};return s(n,i),i.name+="_instance_"+e.uses[t]++,i}_invokeOne(e){let t=Object.values(this.plugins);t.push(this);for(let n=0;n<t.length;n++){let i=e(t[n]);if(i)return i}return null}_invokeAll(e){let t=Object.values(this.plugins);t.unshift(this);let n=[];for(let i=0;i<t.length;i++){let s=e(t[i]);if(s)n.push(s)}return n}getDependency(e,t){let n=e+":"+t,i=this.cache.get(n);if(!i){switch(e){case"scene":i=this.loadScene(t);break;case"node":i=this._invokeOne(function(s){return s.loadNode&&s.loadNode(t)});break;case"mesh":i=this._invokeOne(function(s){return s.loadMesh&&s.loadMesh(t)});break;case"accessor":i=this.loadAccessor(t);break;case"bufferView":i=this._invokeOne(function(s){return s.loadBufferView&&s.loadBufferView(t)});break;case"buffer":i=this.loadBuffer(t);break;case"material":i=this._invokeOne(function(s){return s.loadMaterial&&s.loadMaterial(t)});break;case"texture":i=this._invokeOne(function(s){return s.loadTexture&&s.loadTexture(t)});break;case"skin":i=this.loadSkin(t);break;case"animation":i=this._invokeOne(function(s){return s.loadAnimation&&s.loadAnimation(t)});break;case"camera":i=this.loadCamera(t);break;default:if(i=this._invokeOne(function(s){return s!=this&&s.getDependency&&s.getDependency(e,t)}),!i)throw Error("Unknown type: "+e);break}this.cache.add(n,i)}return i}getDependencies(e){let t=this.cache.get(e);if(!t){let n=this,i=this.json[e+(e==="mesh"?"es":"s")]||[];t=Promise.all(i.map(function(s,r){return n.getDependency(e,r)})),this.cache.add(e,t)}return t}loadBuffer(e){let t=this.json.buffers[e],n=this.fileLoader;if(t.type&&t.type!=="arraybuffer")throw Error("THREE.GLTFLoader: "+t.type+" buffer type is not supported.");if(t.uri===void 0&&e===0)return Promise.resolve(this.extensions[$e.KHR_BINARY_GLTF].body);let i=this.options;return new Promise(function(s,r){n.load(Tn.resolveURL(t.uri,i.path),s,void 0,function(){r(Error('THREE.GLTFLoader: Failed to load buffer "'+t.uri+'".'))})})}loadBufferView(e){let t=this.json.bufferViews[e];return this.getDependency("buffer",t.buffer).then(function(n){let i=t.byteLength||0,s=t.byteOffset||0;return n.slice(s,s+i)})}loadAccessor(e){let t=this,n=this.json,i=this.json.accessors[e];if(i.bufferView===void 0&&i.sparse===void 0){let r=Xo[i.type],a=ji[i.componentType],o=i.normalized===!0,l=new a(i.count*r);return Promise.resolve(new tt(l,r,o))}let s=[];if(i.bufferView!==void 0)s.push(this.getDependency("bufferView",i.bufferView));else s.push(null);if(i.sparse!==void 0)s.push(this.getDependency("bufferView",i.sparse.indices.bufferView)),s.push(this.getDependency("bufferView",i.sparse.values.bufferView));return Promise.all(s).then(function(r){let a=r[0],o=Xo[i.type],l=ji[i.componentType],c=l.BYTES_PER_ELEMENT,h=c*o,u=i.byteOffset||0,d=i.bufferView!==void 0?n.bufferViews[i.bufferView].byteStride:void 0,f=i.normalized===!0,g,_;if(d&&d!==h){let m=Math.floor(u/d),p="InterleavedBuffer:"+i.bufferView+":"+i.componentType+":"+m+":"+i.count,x=t.cache.get(p);if(!x)g=new l(a,m*d,i.count*d/c),x=new fi(g,d/c),t.cache.add(p,x);_=new Mn(x,o,u%d/c,f)}else{if(a===null)g=new l(i.count*o);else g=new l(a,u,i.count*o);_=new tt(g,o,f)}if(i.sparse!==void 0){let m=Xo.SCALAR,p=ji[i.sparse.indices.componentType],x=i.sparse.indices.byteOffset||0,v=i.sparse.values.byteOffset||0,b=new p(r[1],x,i.sparse.count*m),R=new l(r[2],v,i.sparse.count*o);if(a!==null)_=new tt(_.array.slice(),_.itemSize,_.normalized);for(let M=0,C=b.length;M<C;M++){let D=b[M];if(_.setX(D,R[M*o]),o>=2)_.setY(D,R[M*o+1]);if(o>=3)_.setZ(D,R[M*o+2]);if(o>=4)_.setW(D,R[M*o+3]);if(o>=5)throw Error("THREE.GLTFLoader: Unsupported itemSize in sparse BufferAttribute.")}}return _})}loadTexture(e){let t=this.json,n=this.options,s=t.textures[e].source,r=t.images[s],a=this.textureLoader;if(r.uri){let o=n.manager.getHandler(r.uri);if(o!==null)a=o}return this.loadTextureImage(e,s,a)}loadTextureImage(e,t,n){let i=this,s=this.json,r=s.textures[e],a=s.images[t],o=(a.uri||a.bufferView)+":"+r.sampler;if(this.textureCache[o])return this.textureCache[o];let l=this.loadImageSource(t,n).then(function(c){if(c.flipY=!1,c.name=r.name||a.name||"",c.name===""&&typeof a.uri==="string"&&a.uri.startsWith("data:image/")===!1)c.name=a.uri;let u=(s.samplers||{})[r.sampler]||{};return c.magFilter=pu[u.magFilter]||Qa,c.minFilter=pu[u.minFilter]||eo,c.wrapS=mu[u.wrapS]||Pr,c.wrapT=mu[u.wrapT]||Pr,i.associations.set(c,{textures:e}),c}).catch(function(){return null});return this.textureCache[o]=l,l}loadImageSource(e,t){let n=this,i=this.json,s=this.options;if(this.sourceCache[e]!==void 0)return this.sourceCache[e].then((h)=>h.clone());let r=i.images[e],a=self.URL||self.webkitURL,o=r.uri||"",l=!1;if(r.bufferView!==void 0)o=n.getDependency("bufferView",r.bufferView).then(function(h){l=!0;let u=new Blob([h],{type:r.mimeType});return o=a.createObjectURL(u),o});else if(r.uri===void 0)throw Error("THREE.GLTFLoader: Image "+e+" is missing URI and bufferView");let c=Promise.resolve(o).then(function(h){return new Promise(function(u,d){let f=u;if(t.isImageBitmapLoader===!0)f=function(g){let _=new ht(g);_.needsUpdate=!0,u(_)};t.load(Tn.resolveURL(h,s.path),f,void 0,d)})}).then(function(h){if(l===!0)a.revokeObjectURL(o);return h.userData.mimeType=r.mimeType||cx(r.uri),h}).catch(function(h){throw console.error("THREE.GLTFLoader: Couldn't load texture",o),h});return this.sourceCache[e]=c,c}assignTexture(e,t,n,i){let s=this;return this.getDependency("texture",n.index).then(function(r){if(!r)return null;if(n.texCoord!==void 0&&n.texCoord>0)r=r.clone(),r.channel=n.texCoord;if(s.extensions[$e.KHR_TEXTURE_TRANSFORM]){let a=n.extensions!==void 0?n.extensions[$e.KHR_TEXTURE_TRANSFORM]:void 0;if(a){let o=s.associations.get(r);r=s.extensions[$e.KHR_TEXTURE_TRANSFORM].extendTexture(r,a),s.associations.set(r,o)}}if(i!==void 0)r.colorSpace=i;return e[t]=r,r})}assignFinalMaterial(e){let{geometry:t,material:n}=e,i=t.attributes.tangent===void 0,s=t.attributes.color!==void 0,r=t.attributes.normal===void 0;if(e.isPoints){let a="PointsMaterial:"+n.uuid,o=this.cache.get(a);if(!o)o=new Ps,xt.prototype.copy.call(o,n),o.color.copy(n.color),o.map=n.map,o.sizeAttenuation=!1,this.cache.add(a,o);n=o}else if(e.isLine){let a="LineBasicMaterial:"+n.uuid,o=this.cache.get(a);if(!o)o=new Pt,xt.prototype.copy.call(o,n),o.color.copy(n.color),o.map=n.map,this.cache.add(a,o);n=o}if(i||s||r){let a="ClonedMaterial:"+n.uuid+":";if(i)a+="derivative-tangents:";if(s)a+="vertex-colors:";if(r)a+="flat-shading:";let o=this.cache.get(a);if(!o){if(o=n.clone(),s)o.vertexColors=!0;if(r)o.flatShading=!0;if(i){if(o.normalScale)o.normalScale.y*=-1;if(o.clearcoatNormalScale)o.clearcoatNormalScale.y*=-1}this.cache.add(a,o),this.associations.set(o,this.associations.get(n))}n=o}e.material=n}getMaterialType(){return An}loadMaterial(e){let t=this,n=this.json,i=this.extensions,s=n.materials[e],r,a={},o=s.extensions||{},l=[];if(o[$e.KHR_MATERIALS_UNLIT]){let h=i[$e.KHR_MATERIALS_UNLIT];r=h.getMaterialType(),l.push(h.extendParams(a,s,t))}else{let h=s.pbrMetallicRoughness||{};if(a.color=new ue(1,1,1),a.opacity=1,Array.isArray(h.baseColorFactor)){let u=h.baseColorFactor;a.color.setRGB(u[0],u[1],u[2],dn),a.opacity=u[3]}if(h.baseColorTexture!==void 0)l.push(t.assignTexture(a,"map",h.baseColorTexture,Ki));if(a.metalness=h.metallicFactor!==void 0?h.metallicFactor:1,a.roughness=h.roughnessFactor!==void 0?h.roughnessFactor:1,h.metallicRoughnessTexture!==void 0)l.push(t.assignTexture(a,"metalnessMap",h.metallicRoughnessTexture)),l.push(t.assignTexture(a,"roughnessMap",h.metallicRoughnessTexture));r=this._invokeOne(function(u){return u.getMaterialType&&u.getMaterialType(e)}),l.push(Promise.all(this._invokeAll(function(u){return u.extendMaterialParams&&u.extendMaterialParams(e,a)})))}if(s.doubleSided===!0)a.side=Uc;let c=s.alphaMode||qo.OPAQUE;if(c===qo.BLEND)a.transparent=!0,a.depthWrite=!1;else if(a.transparent=!1,c===qo.MASK)a.alphaTest=s.alphaCutoff!==void 0?s.alphaCutoff:0.5;if(s.normalTexture!==void 0&&r!==wt){if(l.push(t.assignTexture(a,"normalMap",s.normalTexture)),a.normalScale=new W(1,1),s.normalTexture.scale!==void 0){let h=s.normalTexture.scale;a.normalScale.set(h,h)}}if(s.occlusionTexture!==void 0&&r!==wt){if(l.push(t.assignTexture(a,"aoMap",s.occlusionTexture)),s.occlusionTexture.strength!==void 0)a.aoMapIntensity=s.occlusionTexture.strength}if(s.emissiveFactor!==void 0&&r!==wt){let h=s.emissiveFactor;a.emissive=new ue().setRGB(h[0],h[1],h[2],dn)}if(s.emissiveTexture!==void 0&&r!==wt)l.push(t.assignTexture(a,"emissiveMap",s.emissiveTexture,Ki));return Promise.all(l).then(function(){let h=new r(a);if(s.name)h.name=s.name;if(Wn(h,s),t.associations.set(h,{materials:e}),s.extensions)xi(i,h,s);return h})}createUniqueName(e){let t=Qe.sanitizeNodeName(e||"");if(t in this.nodeNamesUsed)return t+"_"+ ++this.nodeNamesUsed[t];else return this.nodeNamesUsed[t]=0,t}loadGeometries(e){let t=this,n=this.extensions,i=this.primitiveCache;function s(a){return n[$e.KHR_DRACO_MESH_COMPRESSION].decodePrimitive(a,t).then(function(o){return gu(o,a,t)})}let r=[];for(let a=0,o=e.length;a<o;a++){let l=e[a],c=lx(l),h=i[c];if(h)r.push(h.promise);else{let u;if(l.extensions&&l.extensions[$e.KHR_DRACO_MESH_COMPRESSION])u=s(l);else u=gu(new ze,l,t);i[c]={primitive:l,promise:u},r.push(u)}}return Promise.all(r)}loadMesh(e){let t=this,n=this.json,i=this.extensions,s=n.meshes[e],r=s.primitives,a=[];for(let o=0,l=r.length;o<l;o++){let c=r[o].material===void 0?rx(this.cache):this.getDependency("material",r[o].material);a.push(c)}return a.push(t.loadGeometries(r)),Promise.all(a).then(function(o){let l=o.slice(0,o.length-1),c=o[o.length-1],h=[];for(let d=0,f=c.length;d<f;d++){let g=c[d],_=r[d],m,p=l[d];if(_.mode===$t.TRIANGLES||_.mode===$t.TRIANGLE_STRIP||_.mode===$t.TRIANGLE_FAN||_.mode===void 0){if(m=s.isSkinnedMesh===!0?new kr(g,p):new Je(g,p),m.isSkinnedMesh===!0)m.normalizeSkinWeights();if(_.mode===$t.TRIANGLE_STRIP)m.geometry=Vo(m.geometry,Lr);else if(_.mode===$t.TRIANGLE_FAN)m.geometry=Vo(m.geometry,As)}else if(_.mode===$t.LINES)m=new Kt(g,p);else if(_.mode===$t.LINE_STRIP)m=new un(g,p);else if(_.mode===$t.LINE_LOOP)m=new Hr(g,p);else if(_.mode===$t.POINTS)m=new Wr(g,p);else throw Error("THREE.GLTFLoader: Primitive mode unsupported: "+_.mode);if(Object.keys(m.geometry.morphAttributes).length>0)ox(m,s);if(m.name=t.createUniqueName(s.name||"mesh_"+e),Wn(m,s),_.extensions)xi(i,m,_);t.assignFinalMaterial(m),h.push(m)}for(let d=0,f=h.length;d<f;d++)t.associations.set(h[d],{meshes:e,primitives:d});if(h.length===1){if(s.extensions)xi(i,h[0],s);return h[0]}let u=new hn;if(s.extensions)xi(i,u,s);t.associations.set(u,{meshes:e});for(let d=0,f=h.length;d<f;d++)u.add(h[d]);return u})}loadCamera(e){let t,n=this.json.cameras[e],i=n[n.type];if(!i){console.warn("THREE.GLTFLoader: Missing camera parameters.");return}if(n.type==="perspective")t=new yt(Ir.radToDeg(i.yfov),i.aspectRatio||1,i.znear||1,i.zfar||2000000);else if(n.type==="orthographic")t=new kn(-i.xmag,i.xmag,i.ymag,-i.ymag,i.znear,i.zfar);if(n.name)t.name=this.createUniqueName(n.name);return Wn(t,n),Promise.resolve(t)}loadSkin(e){let t=this.json.skins[e],n=[];for(let i=0,s=t.joints.length;i<s;i++)n.push(this._loadNodeShallow(t.joints[i]));if(t.inverseBindMatrices!==void 0)n.push(this.getDependency("accessor",t.inverseBindMatrices));else n.push(null);return Promise.all(n).then(function(i){let s=i.pop(),r=i,a=[],o=[];for(let l=0,c=r.length;l<c;l++){let h=r[l];if(h){a.push(h);let u=new De;if(s!==null)u.fromArray(s.array,l*16);o.push(u)}else console.warn('THREE.GLTFLoader: Joint "%s" could not be found.',t.joints[l])}return new Cs(a,o)})}loadAnimation(e){let t=this.json,n=this,i=t.animations[e],s=i.name?i.name:"animation_"+e,r=[],a=[],o=[],l=[],c=[];for(let h=0,u=i.channels.length;h<u;h++){let d=i.channels[h],f=i.samplers[d.sampler],g=d.target,_=g.node,m=i.parameters!==void 0?i.parameters[f.input]:f.input,p=i.parameters!==void 0?i.parameters[f.output]:f.output;if(g.node===void 0)continue;r.push(this.getDependency("node",_)),a.push(this.getDependency("accessor",m)),o.push(this.getDependency("accessor",p)),l.push(f),c.push(g)}return Promise.all([Promise.all(r),Promise.all(a),Promise.all(o),Promise.all(l),Promise.all(c)]).then(function(h){let u=h[0],d=h[1],f=h[2],g=h[3],_=h[4],m=[];for(let p=0,x=u.length;p<x;p++){let v=u[p],b=d[p],R=f[p],M=g[p],C=_[p];if(v===void 0)continue;if(v.updateMatrix)v.updateMatrix();let D=n._createAnimationTracks(v,b,R,M,C);if(D)for(let S=0;S<D.length;S++)m.push(D[S])}return new hi(s,void 0,m)})}createNodeMesh(e){let t=this.json,n=this,i=t.nodes[e];if(i.mesh===void 0)return null;return n.getDependency("mesh",i.mesh).then(function(s){let r=n._getNodeRef(n.meshCache,i.mesh,s);if(i.weights!==void 0)r.traverse(function(a){if(!a.isMesh)return;for(let o=0,l=i.weights.length;o<l;o++)a.morphTargetInfluences[o]=i.weights[o]});return r})}loadNode(e){let t=this.json,n=this,i=t.nodes[e],s=n._loadNodeShallow(e),r=[],a=i.children||[];for(let l=0,c=a.length;l<c;l++)r.push(n.getDependency("node",a[l]));let o=i.skin===void 0?Promise.resolve(null):n.getDependency("skin",i.skin);return Promise.all([s,Promise.all(r),o]).then(function(l){let c=l[0],h=l[1],u=l[2];if(u!==null)c.traverse(function(d){if(!d.isSkinnedMesh)return;d.bind(u,hx)});for(let d=0,f=h.length;d<f;d++)c.add(h[d]);return c})}_loadNodeShallow(e){let t=this.json,n=this.extensions,i=this;if(this.nodeCache[e]!==void 0)return this.nodeCache[e];let s=t.nodes[e],r=s.name?i.createUniqueName(s.name):"",a=[],o=i._invokeOne(function(l){return l.createNodeMesh&&l.createNodeMesh(e)});if(o)a.push(o);if(s.camera!==void 0)a.push(i.getDependency("camera",s.camera).then(function(l){return i._getNodeRef(i.cameraCache,s.camera,l)}));return i._invokeAll(function(l){return l.createNodeAttachment&&l.createNodeAttachment(e)}).forEach(function(l){a.push(l)}),this.nodeCache[e]=Promise.all(a).then(function(l){let c;if(s.isBone===!0)c=new Rs;else if(l.length>1)c=new hn;else if(l.length===1)c=l[0];else c=new et;if(c!==l[0])for(let h=0,u=l.length;h<u;h++)c.add(l[h]);if(s.name)c.userData.name=s.name,c.name=r;if(Wn(c,s),s.extensions)xi(n,c,s);if(s.matrix!==void 0){let h=new De;h.fromArray(s.matrix),c.applyMatrix4(h)}else{if(s.translation!==void 0)c.position.fromArray(s.translation);if(s.rotation!==void 0)c.quaternion.fromArray(s.rotation);if(s.scale!==void 0)c.scale.fromArray(s.scale)}if(!i.associations.has(c))i.associations.set(c,{});return i.associations.get(c).nodes=e,c}),this.nodeCache[e]}loadScene(e){let t=this.extensions,n=this.json.scenes[e],i=this,s=new hn;if(n.name)s.name=i.createUniqueName(n.name);if(Wn(s,n),n.extensions)xi(t,s,n);let r=n.nodes||[],a=[];for(let o=0,l=r.length;o<l;o++)a.push(i.getDependency("node",r[o]));return Promise.all(a).then(function(o){for(let c=0,h=o.length;c<h;c++)s.add(o[c]);let l=(c)=>{let h=new Map;for(let[u,d]of i.associations)if(u instanceof xt||u instanceof ht)h.set(u,d);return c.traverse((u)=>{let d=i.associations.get(u);if(d!=null)h.set(u,d)}),h};return i.associations=l(s),s})}_createAnimationTracks(e,t,n,i,s){let r=[],a=e.name?e.name:e.uuid,o=[];if(Hn[s.path]===Hn.weights)e.traverse(function(u){if(u.morphTargetInfluences)o.push(u.name?u.name:u.uuid)});else o.push(a);let l;switch(Hn[s.path]){case Hn.weights:l=Un;break;case Hn.rotation:l=En;break;case Hn.position:case Hn.scale:l=Fn;break;default:switch(n.itemSize){case 1:l=Un;break;case 2:case 3:default:l=Fn;break}break}let c=i.interpolation!==void 0?sx[i.interpolation]:to,h=this._getArrayFromAccessor(n);for(let u=0,d=o.length;u<d;u++){let f=new l(o[u]+"."+Hn[s.path],t.array,h,c);if(i.interpolation==="CUBICSPLINE")this._createCubicSplineTrackInterpolant(f);r.push(f)}return r}_getArrayFromAccessor(e){let t=e.array;if(e.normalized){let n=Ko(t.constructor),i=new Float32Array(t.length);for(let s=0,r=t.length;s<r;s++)i[s]=t[s]*n;t=i}return t}_createCubicSplineTrackInterpolant(e){e.createInterpolant=function(n){return new(this instanceof En?ku:Jo)(this.times,this.values,this.getValueSize()/3,n)},e.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline=!0}}function ux(e,t,n){let i=t.attributes,s=new Rt;if(i.POSITION!==void 0){let o=n.json.accessors[i.POSITION],{min:l,max:c}=o;if(l!==void 0&&c!==void 0){if(s.set(new T(l[0],l[1],l[2]),new T(c[0],c[1],c[2])),o.normalized){let h=Ko(ji[o.componentType]);s.min.multiplyScalar(h),s.max.multiplyScalar(h)}}else{console.warn("THREE.GLTFLoader: Missing min/max properties for accessor POSITION.");return}}else return;let r=t.targets;if(r!==void 0){let o=new T,l=new T;for(let c=0,h=r.length;c<h;c++){let u=r[c];if(u.POSITION!==void 0){let d=n.json.accessors[u.POSITION],{min:f,max:g}=d;if(f!==void 0&&g!==void 0){if(l.setX(Math.max(Math.abs(f[0]),Math.abs(g[0]))),l.setY(Math.max(Math.abs(f[1]),Math.abs(g[1]))),l.setZ(Math.max(Math.abs(f[2]),Math.abs(g[2]))),d.normalized){let _=Ko(ji[d.componentType]);l.multiplyScalar(_)}o.max(l)}else console.warn("THREE.GLTFLoader: Missing min/max properties for accessor POSITION.")}}s.expandByVector(o)}e.boundingBox=s;let a=new At;s.getCenter(a.center),a.radius=s.min.distanceTo(s.max)/2,e.boundingSphere=a}function gu(e,t,n){let i=t.attributes,s=[];function r(a,o){return n.getDependency("accessor",a).then(function(l){e.setAttribute(o,l)})}for(let a in i){let o=Zo[a]||a.toLowerCase();if(o in e.attributes)continue;s.push(r(i[a],o))}if(t.indices!==void 0&&!e.index){let a=n.getDependency("accessor",t.indices).then(function(o){e.setIndex(o)});s.push(a)}if(nt.workingColorSpace!==dn&&"COLOR_0"in i)console.warn(`THREE.GLTFLoader: Converting vertex colors from "srgb-linear" to "${nt.workingColorSpace}" not supported.`);return Wn(e,t),ux(e,t,n),Promise.all(s).then(function(){return t.targets!==void 0?ax(e,t.targets,n):e})}var ia={name:"CopyShader",uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`};class jt{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}var dx=new kn(-1,1,1,-1,0,1);class Hu extends ze{constructor(){super();this.setAttribute("position",new Ae([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new Ae([0,2,0,0,2,0],2))}}var fx=new Hu;class vi{constructor(e){this._mesh=new Je(fx,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,dx)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}class $o extends jt{constructor(e,t){super();if(this.textureID=t!==void 0?t:"tDiffuse",e instanceof Et)this.uniforms=e.uniforms,this.material=e;else if(e)this.uniforms=zn.clone(e.uniforms),this.material=new Et({name:e.name!==void 0?e.name:"unspecified",defines:Object.assign({},e.defines),uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader});this.fsQuad=new vi(this.material)}render(e,t,n){if(this.uniforms[this.textureID])this.uniforms[this.textureID].value=n.texture;if(this.fsQuad.material=this.material,this.renderToScreen)e.setRenderTarget(null),this.fsQuad.render(e);else{if(e.setRenderTarget(t),this.clear)e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil);this.fsQuad.render(e)}}dispose(){this.material.dispose(),this.fsQuad.dispose()}}class sa extends jt{constructor(e,t){super();this.scene=e,this.camera=t,this.clear=!0,this.needsSwap=!1,this.inverse=!1}render(e,t,n){let i=e.getContext(),s=e.state;s.buffers.color.setMask(!1),s.buffers.depth.setMask(!1),s.buffers.color.setLocked(!0),s.buffers.depth.setLocked(!0);let r,a;if(this.inverse)r=0,a=1;else r=1,a=0;if(s.buffers.stencil.setTest(!0),s.buffers.stencil.setOp(i.REPLACE,i.REPLACE,i.REPLACE),s.buffers.stencil.setFunc(i.ALWAYS,r,4294967295),s.buffers.stencil.setClear(a),s.buffers.stencil.setLocked(!0),e.setRenderTarget(n),this.clear)e.clear();if(e.render(this.scene,this.camera),e.setRenderTarget(t),this.clear)e.clear();e.render(this.scene,this.camera),s.buffers.color.setLocked(!1),s.buffers.depth.setLocked(!1),s.buffers.color.setMask(!0),s.buffers.depth.setMask(!0),s.buffers.stencil.setLocked(!1),s.buffers.stencil.setFunc(i.EQUAL,1,4294967295),s.buffers.stencil.setOp(i.KEEP,i.KEEP,i.KEEP),s.buffers.stencil.setLocked(!0)}}class jo extends jt{constructor(){super();this.needsSwap=!1}render(e){e.state.buffers.stencil.setLocked(!1),e.state.buffers.stencil.setTest(!1)}}class Wu{constructor(e,t){if(this.renderer=e,this._pixelRatio=e.getPixelRatio(),t===void 0){let n=e.getSize(new W);this._width=n.width,this._height=n.height,t=new Ct(this._width*this._pixelRatio,this._height*this._pixelRatio,{type:Zi}),t.texture.name="EffectComposer.rt1"}else this._width=t.width,this._height=t.height;this.renderTarget1=t,this.renderTarget2=t.clone(),this.renderTarget2.texture.name="EffectComposer.rt2",this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2,this.renderToScreen=!0,this.passes=[],this.copyPass=new $o(ia),this.copyPass.material.blending=Fc,this.clock=new ea}swapBuffers(){let e=this.readBuffer;this.readBuffer=this.writeBuffer,this.writeBuffer=e}addPass(e){this.passes.push(e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}insertPass(e,t){this.passes.splice(t,0,e),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}removePass(e){let t=this.passes.indexOf(e);if(t!==-1)this.passes.splice(t,1)}isLastEnabledPass(e){for(let t=e+1;t<this.passes.length;t++)if(this.passes[t].enabled)return!1;return!0}render(e){if(e===void 0)e=this.clock.getDelta();let t=this.renderer.getRenderTarget(),n=!1;for(let i=0,s=this.passes.length;i<s;i++){let r=this.passes[i];if(r.enabled===!1)continue;if(r.renderToScreen=this.renderToScreen&&this.isLastEnabledPass(i),r.render(this.renderer,this.writeBuffer,this.readBuffer,e,n),r.needsSwap){if(n){let a=this.renderer.getContext(),o=this.renderer.state.buffers.stencil;o.setFunc(a.NOTEQUAL,1,4294967295),this.copyPass.render(this.renderer,this.writeBuffer,this.readBuffer,e),o.setFunc(a.EQUAL,1,4294967295)}this.swapBuffers()}if(sa!==void 0){if(r instanceof sa)n=!0;else if(r instanceof jo)n=!1}}this.renderer.setRenderTarget(t)}reset(e){if(e===void 0){let t=this.renderer.getSize(new W);this._pixelRatio=this.renderer.getPixelRatio(),this._width=t.width,this._height=t.height,e=this.renderTarget1.clone(),e.setSize(this._width*this._pixelRatio,this._height*this._pixelRatio)}this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.renderTarget1=e,this.renderTarget2=e.clone(),this.writeBuffer=this.renderTarget1,this.readBuffer=this.renderTarget2}setSize(e,t){this._width=e,this._height=t;let n=this._width*this._pixelRatio,i=this._height*this._pixelRatio;this.renderTarget1.setSize(n,i),this.renderTarget2.setSize(n,i);for(let s=0;s<this.passes.length;s++)this.passes[s].setSize(n,i)}setPixelRatio(e){this._pixelRatio=e,this.setSize(this._width,this._height)}dispose(){this.renderTarget1.dispose(),this.renderTarget2.dispose(),this.copyPass.dispose()}}class Vu extends jt{constructor(e,t,n=null,i=null,s=null){super();this.scene=e,this.camera=t,this.overrideMaterial=n,this.clearColor=i,this.clearAlpha=s,this.clear=!0,this.clearDepth=!1,this.needsSwap=!1,this._oldClearColor=new ue}render(e,t,n){let i=e.autoClear;e.autoClear=!1;let s,r;if(this.overrideMaterial!==null)r=this.scene.overrideMaterial,this.scene.overrideMaterial=this.overrideMaterial;if(this.clearColor!==null)e.getClearColor(this._oldClearColor),e.setClearColor(this.clearColor);if(this.clearAlpha!==null)s=e.getClearAlpha(),e.setClearAlpha(this.clearAlpha);if(this.clearDepth==!0)e.clearDepth();if(e.setRenderTarget(this.renderToScreen?null:n),this.clear===!0)e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil);if(e.render(this.scene,this.camera),this.clearColor!==null)e.setClearColor(this._oldClearColor);if(this.clearAlpha!==null)e.setClearAlpha(s);if(this.overrideMaterial!==null)this.scene.overrideMaterial=r;e.autoClear=i}}var Xu={name:"LuminosityHighPassShader",shaderID:"luminosityHighPass",uniforms:{tDiffuse:{value:null},luminosityThreshold:{value:1},smoothWidth:{value:1},defaultColor:{value:new ue(0)},defaultOpacity:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			vec3 luma = vec3( 0.299, 0.587, 0.114 );

			float v = dot( texel.xyz, luma );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`};class Qi extends jt{constructor(e,t,n,i){super();this.strength=t!==void 0?t:1,this.radius=n,this.threshold=i,this.resolution=e!==void 0?new W(e.x,e.y):new W(256,256),this.clearColor=new ue(0,0,0),this.renderTargetsHorizontal=[],this.renderTargetsVertical=[],this.nMips=5;let s=Math.round(this.resolution.x/2),r=Math.round(this.resolution.y/2);this.renderTargetBright=new Ct(s,r,{type:Zi}),this.renderTargetBright.texture.name="UnrealBloomPass.bright",this.renderTargetBright.texture.generateMipmaps=!1;for(let h=0;h<this.nMips;h++){let u=new Ct(s,r,{type:Zi});u.texture.name="UnrealBloomPass.h"+h,u.texture.generateMipmaps=!1,this.renderTargetsHorizontal.push(u);let d=new Ct(s,r,{type:Zi});d.texture.name="UnrealBloomPass.v"+h,d.texture.generateMipmaps=!1,this.renderTargetsVertical.push(d),s=Math.round(s/2),r=Math.round(r/2)}let a=Xu;this.highPassUniforms=zn.clone(a.uniforms),this.highPassUniforms.luminosityThreshold.value=i,this.highPassUniforms.smoothWidth.value=0.01,this.materialHighPassFilter=new Et({uniforms:this.highPassUniforms,vertexShader:a.vertexShader,fragmentShader:a.fragmentShader}),this.separableBlurMaterials=[];let o=[3,5,7,9,11];s=Math.round(this.resolution.x/2),r=Math.round(this.resolution.y/2);for(let h=0;h<this.nMips;h++)this.separableBlurMaterials.push(this.getSeperableBlurMaterial(o[h])),this.separableBlurMaterials[h].uniforms.invSize.value=new W(1/s,1/r),s=Math.round(s/2),r=Math.round(r/2);this.compositeMaterial=this.getCompositeMaterial(this.nMips),this.compositeMaterial.uniforms.blurTexture1.value=this.renderTargetsVertical[0].texture,this.compositeMaterial.uniforms.blurTexture2.value=this.renderTargetsVertical[1].texture,this.compositeMaterial.uniforms.blurTexture3.value=this.renderTargetsVertical[2].texture,this.compositeMaterial.uniforms.blurTexture4.value=this.renderTargetsVertical[3].texture,this.compositeMaterial.uniforms.blurTexture5.value=this.renderTargetsVertical[4].texture,this.compositeMaterial.uniforms.bloomStrength.value=t,this.compositeMaterial.uniforms.bloomRadius.value=0.1;let l=[1,0.8,0.6,0.4,0.2];this.compositeMaterial.uniforms.bloomFactors.value=l,this.bloomTintColors=[new T(1,1,1),new T(1,1,1),new T(1,1,1),new T(1,1,1),new T(1,1,1)],this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors;let c=ia;this.copyUniforms=zn.clone(c.uniforms),this.blendMaterial=new Et({uniforms:this.copyUniforms,vertexShader:c.vertexShader,fragmentShader:c.fragmentShader,blending:Oc,depthTest:!1,depthWrite:!1,transparent:!0}),this.enabled=!0,this.needsSwap=!1,this._oldClearColor=new ue,this.oldClearAlpha=1,this.basic=new wt,this.fsQuad=new vi(null)}dispose(){for(let e=0;e<this.renderTargetsHorizontal.length;e++)this.renderTargetsHorizontal[e].dispose();for(let e=0;e<this.renderTargetsVertical.length;e++)this.renderTargetsVertical[e].dispose();this.renderTargetBright.dispose();for(let e=0;e<this.separableBlurMaterials.length;e++)this.separableBlurMaterials[e].dispose();this.compositeMaterial.dispose(),this.blendMaterial.dispose(),this.basic.dispose(),this.fsQuad.dispose()}setSize(e,t){let n=Math.round(e/2),i=Math.round(t/2);this.renderTargetBright.setSize(n,i);for(let s=0;s<this.nMips;s++)this.renderTargetsHorizontal[s].setSize(n,i),this.renderTargetsVertical[s].setSize(n,i),this.separableBlurMaterials[s].uniforms.invSize.value=new W(1/n,1/i),n=Math.round(n/2),i=Math.round(i/2)}render(e,t,n,i,s){e.getClearColor(this._oldClearColor),this.oldClearAlpha=e.getClearAlpha();let r=e.autoClear;if(e.autoClear=!1,e.setClearColor(this.clearColor,0),s)e.state.buffers.stencil.setTest(!1);if(this.renderToScreen)this.fsQuad.material=this.basic,this.basic.map=n.texture,e.setRenderTarget(null),e.clear(),this.fsQuad.render(e);this.highPassUniforms.tDiffuse.value=n.texture,this.highPassUniforms.luminosityThreshold.value=this.threshold,this.fsQuad.material=this.materialHighPassFilter,e.setRenderTarget(this.renderTargetBright),e.clear(),this.fsQuad.render(e);let a=this.renderTargetBright;for(let o=0;o<this.nMips;o++)this.fsQuad.material=this.separableBlurMaterials[o],this.separableBlurMaterials[o].uniforms.colorTexture.value=a.texture,this.separableBlurMaterials[o].uniforms.direction.value=Qi.BlurDirectionX,e.setRenderTarget(this.renderTargetsHorizontal[o]),e.clear(),this.fsQuad.render(e),this.separableBlurMaterials[o].uniforms.colorTexture.value=this.renderTargetsHorizontal[o].texture,this.separableBlurMaterials[o].uniforms.direction.value=Qi.BlurDirectionY,e.setRenderTarget(this.renderTargetsVertical[o]),e.clear(),this.fsQuad.render(e),a=this.renderTargetsVertical[o];if(this.fsQuad.material=this.compositeMaterial,this.compositeMaterial.uniforms.bloomStrength.value=this.strength,this.compositeMaterial.uniforms.bloomRadius.value=this.radius,this.compositeMaterial.uniforms.bloomTintColors.value=this.bloomTintColors,e.setRenderTarget(this.renderTargetsHorizontal[0]),e.clear(),this.fsQuad.render(e),this.fsQuad.material=this.blendMaterial,this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture,s)e.state.buffers.stencil.setTest(!0);if(this.renderToScreen)e.setRenderTarget(null),this.fsQuad.render(e);else e.setRenderTarget(n),this.fsQuad.render(e);e.setClearColor(this._oldClearColor,this.oldClearAlpha),e.autoClear=r}getSeperableBlurMaterial(e){let t=[];for(let n=0;n<e;n++)t.push(0.39894*Math.exp(-0.5*n*n/(e*e))/e);return new Et({defines:{KERNEL_RADIUS:e},uniforms:{colorTexture:{value:null},invSize:{value:new W(0.5,0.5)},direction:{value:new W(0.5,0.5)},gaussianCoefficients:{value:t}},vertexShader:`varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,fragmentShader:`#include <common>
				varying vec2 vUv;
				uniform sampler2D colorTexture;
				uniform vec2 invSize;
				uniform vec2 direction;
				uniform float gaussianCoefficients[KERNEL_RADIUS];

				void main() {
					float weightSum = gaussianCoefficients[0];
					vec3 diffuseSum = texture2D( colorTexture, vUv ).rgb * weightSum;
					for( int i = 1; i < KERNEL_RADIUS; i ++ ) {
						float x = float(i);
						float w = gaussianCoefficients[i];
						vec2 uvOffset = direction * invSize * x;
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset ).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset ).rgb;
						diffuseSum += (sample1 + sample2) * w;
						weightSum += 2.0 * w;
					}
					gl_FragColor = vec4(diffuseSum/weightSum, 1.0);
				}`})}getCompositeMaterial(e){return new Et({defines:{NUM_MIPS:e},uniforms:{blurTexture1:{value:null},blurTexture2:{value:null},blurTexture3:{value:null},blurTexture4:{value:null},blurTexture5:{value:null},bloomStrength:{value:1},bloomFactors:{value:null},bloomTintColors:{value:null},bloomRadius:{value:0}},vertexShader:`varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,fragmentShader:`varying vec2 vUv;
				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor(const in float factor) {
					float mirrorFactor = 1.2 - factor;
					return mix(factor, mirrorFactor, bloomRadius);
				}

				void main() {
					gl_FragColor = bloomStrength * ( lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) +
						lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) +
						lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) +
						lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) +
						lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv) );
				}`})}}Qi.BlurDirectionX=new W(1,0);Qi.BlurDirectionY=new W(0,1);var qu={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`
	
		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = OptimizedCineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class Yu extends jt{constructor(){super();let e=qu;this.uniforms=zn.clone(e.uniforms),this.material=new Jr({name:e.name,uniforms:this.uniforms,vertexShader:e.vertexShader,fragmentShader:e.fragmentShader}),this.fsQuad=new vi(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,t,n){if(this.uniforms.tDiffuse.value=n.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping){if(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},nt.getTransfer(this._outputColorSpace)===$c)this.material.defines.SRGB_TRANSFER="";if(this._toneMapping===Bc)this.material.defines.LINEAR_TONE_MAPPING="";else if(this._toneMapping===zc)this.material.defines.REINHARD_TONE_MAPPING="";else if(this._toneMapping===kc)this.material.defines.CINEON_TONE_MAPPING="";else if(this._toneMapping===Gc)this.material.defines.ACES_FILMIC_TONE_MAPPING="";else if(this._toneMapping===Hc)this.material.defines.AGX_TONE_MAPPING="";this.material.needsUpdate=!0}if(this.renderToScreen===!0)e.setRenderTarget(null),this.fsQuad.render(e);else{if(e.setRenderTarget(t),this.clear)e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil);this.fsQuad.render(e)}}dispose(){this.material.dispose(),this.fsQuad.dispose()}}class Zu extends zr{constructor(e=null){super();let t=new Bn;t.deleteAttribute("uv");let n=new An({side:Dc}),i=new An,s=5;if(e!==null&&e._useLegacyLights===!1)s=900;let r=new $i(16777215,s,28,2);r.position.set(0.418,16.199,0.3),this.add(r);let a=new Je(t,n);a.position.set(-0.757,13.219,0.717),a.scale.set(31.713,28.305,28.591),this.add(a);let o=new Je(t,i);o.position.set(-10.906,2.009,1.846),o.rotation.set(0,-0.195,0),o.scale.set(2.328,7.905,4.651),this.add(o);let l=new Je(t,i);l.position.set(-5.607,-0.754,-0.758),l.rotation.set(0,0.994,0),l.scale.set(1.97,1.534,3.955),this.add(l);let c=new Je(t,i);c.position.set(6.167,0.857,7.803),c.rotation.set(0,0.561,0),c.scale.set(3.927,6.285,3.687),this.add(c);let h=new Je(t,i);h.position.set(-2.017,0.018,6.124),h.rotation.set(0,0.333,0),h.scale.set(2.002,4.566,2.064),this.add(h);let u=new Je(t,i);u.position.set(2.291,-0.756,-2.621),u.rotation.set(0,-0.286,0),u.scale.set(1.546,1.552,1.496),this.add(u);let d=new Je(t,i);d.position.set(-2.193,-0.369,-5.547),d.rotation.set(0,0.516,0),d.scale.set(3.875,3.487,2.986),this.add(d);let f=new Je(t,es(50));f.position.set(-16.116,14.37,8.208),f.scale.set(0.1,2.428,2.739),this.add(f);let g=new Je(t,es(50));g.position.set(-16.109,18.021,-8.207),g.scale.set(0.1,2.425,2.751),this.add(g);let _=new Je(t,es(17));_.position.set(14.904,12.198,-1.832),_.scale.set(0.15,4.265,6.331),this.add(_);let m=new Je(t,es(43));m.position.set(-0.462,8.89,14.52),m.scale.set(4.38,5.441,0.088),this.add(m);let p=new Je(t,es(20));p.position.set(3.235,11.486,-12.541),p.scale.set(2.5,2,0.1),this.add(p);let x=new Je(t,es(100));x.position.set(0,20,0),x.scale.set(1,0.1,1),this.add(x)}dispose(){let e=new Set;this.traverse((t)=>{if(t.isMesh)e.add(t.geometry),e.add(t.material)});for(let t of e)t.dispose()}}function es(e){let t=new wt;return t.color.setScalar(e),t}export{Gc as ACESFilmicToneMapping,Rx as AddEquation,sv as AddOperation,Ey as AdditiveAnimationBlendMode,Oc as AdditiveBlending,Hc as AgXToneMapping,Cv as AlphaFormat,lS as AlwaysCompare,Kx as AlwaysDepth,eS as AlwaysStencilFunc,$h as AmbientLight,au as AnimationAction,hi as AnimationClip,l0 as AnimationLoader,L0 as AnimationMixer,C0 as AnimationObjectGroup,TS as AnimationUtils,Th as ArcCurve,mh as ArrayCamera,j0 as ArrowHelper,ov as AttachedBindMode,iu as Audio,y0 as AudioAnalyser,ko as AudioContext,_0 as AudioListener,p0 as AudioLoader,Q0 as AxesHelper,Dc as BackSide,Cy as BasicDepthPacking,vx as BasicShadowMap,bh as BatchedMesh,Rs as Bone,gi as BooleanKeyframeTrack,B0 as Box2,Rt as Box3,J0 as Box3Helper,Bn as BoxGeometry,K0 as BoxHelper,tt as BufferAttribute,ze as BufferGeometry,nu as BufferGeometryLoader,yv as ByteType,Dn as Cache,Fr as Camera,Z0 as CameraHelper,C_ as CanvasTexture,So as CapsuleGeometry,Ah as CatmullRomCurve3,kc as CineonToneMapping,Mo as CircleGeometry,Wc as ClampToEdgeWrapping,ea as Clock,ue as Color,Uo as ColorKeyframeTrack,nt as ColorManagement,w_ as CompressedArrayTexture,R_ as CompressedCubeTexture,Vr as CompressedTexture,c0 as CompressedTextureLoader,bo as ConeGeometry,qx as ConstantAlphaFactor,Vx as ConstantColorFactor,nh as CubeCamera,hv as CubeReflectionMapping,uv as CubeRefractionMapping,Es as CubeTexture,h0 as CubeTextureLoader,pv as CubeUVReflectionMapping,go as CubicBezierCurve,Eh as CubicBezierCurve3,Wh as CubicInterpolant,gx as CullFaceBack,_x as CullFaceFront,xx as CullFaceFrontBack,mx as CullFaceNone,sn as Curve,Rh as CurvePath,wx as CustomBlending,av as CustomToneMapping,Ls as CylinderGeometry,O0 as Cylindrical,so as Data3DTexture,Nr as DataArrayTexture,oi as DataTexture,u0 as DataTextureLoader,bS as DataUtils,Wy as DecrementStencilOp,Xy as DecrementWrapStencilOp,o0 as DefaultLoadingManager,Nv as DepthFormat,Dv as DepthStencilFormat,lo as DepthTexture,lv as DetachedBindMode,Qr as DirectionalLight,Y0 as DirectionalLightHelper,Vh as DiscreteInterpolant,Dy as DisplayP3ColorSpace,To as DodecahedronGeometry,Uc as DoubleSide,zx as DstAlphaFactor,Gx as DstColorFactor,gS as DynamicCopyUsage,hS as DynamicDrawUsage,fS as DynamicReadUsage,Ch as EdgesGeometry,Wu as EffectComposer,Xr as EllipseCurve,iS as EqualCompare,jx as EqualDepth,Ky as EqualStencilFunc,dv as EquirectangularReflectionMapping,fv as EquirectangularRefractionMapping,Dr as Euler,nn as EventDispatcher,Ao as ExtrudeGeometry,Zt as FileLoader,Od as Float16BufferAttribute,Ae as Float32BufferAttribute,Bd as Float64BufferAttribute,Av as FloatType,fo as Fog,uo as FogExp2,E_ as FramebufferTexture,Nc as FrontSide,ws as Frustum,U0 as GLBufferAttribute,xS as GLSL1,vS as GLSL3,_u as GLTFLoader,rS as GreaterCompare,ev as GreaterDepth,oS as GreaterEqualCompare,Qx as GreaterEqualDepth,Qy as GreaterEqualStencilFunc,$y as GreaterStencilFunc,X0 as GridHelper,hn as Group,Zi as HalfFloatType,Yh as HemisphereLight,V0 as HemisphereLightHelper,Eo as IcosahedronGeometry,zo as ImageBitmapLoader,Ts as ImageLoader,io as ImageUtils,Hy as IncrementStencilOp,Vy as IncrementWrapStencilOp,bn as InstancedBufferAttribute,tu as InstancedBufferGeometry,D0 as InstancedInterleavedBuffer,Gr as InstancedMesh,Ud as Int16BufferAttribute,Fd as Int32BufferAttribute,Id as Int8BufferAttribute,bv as IntType,fi as InterleavedBuffer,Mn as InterleavedBufferAttribute,mi as Interpolant,Kc as InterpolateDiscrete,to as InterpolateLinear,Sy as InterpolateSmooth,qy as InvertStencilOp,ky as KeepStencilOp,rn as KeyframeTrack,Sh as LOD,qr as LatheGeometry,Ur as Layers,nS as LessCompare,Jx as LessDepth,sS as LessEqualCompare,$x as LessEqualDepth,Jy as LessEqualStencilFunc,Zy as LessStencilFunc,Gn as Light,eu as LightProbe,un as Line,z0 as Line3,Pt as LineBasicMaterial,_o as LineCurve,wh as LineCurve3,kh as LineDashedMaterial,Hr as LineLoop,Kt as LineSegments,Uy as LinearDisplayP3ColorSpace,wy as LinearEncoding,Qa as LinearFilter,Do as LinearInterpolant,xv as LinearMipMapLinearFilter,_v as LinearMipMapNearestFilter,eo as LinearMipmapLinearFilter,Zc as LinearMipmapNearestFilter,dn as LinearSRGBColorSpace,Bc as LinearToneMapping,Fy as LinearTransfer,Ut as Loader,Tn as LoaderUtils,Fo as LoadingManager,xy as LoopOnce,yy as LoopPingPong,vy as LoopRepeat,Iv as LuminanceAlphaFormat,Lv as LuminanceFormat,ui as MOUSE,xt as Material,Bo as MaterialLoader,Ir as MathUtils,Ze as Matrix3,De as Matrix4,Ix as MaxEquation,Je as Mesh,wt as MeshBasicMaterial,co as MeshDepthMaterial,ho as MeshDistanceMaterial,Bh as MeshLambertMaterial,zh as MeshMatcapMaterial,Oh as MeshNormalMaterial,Uh as MeshPhongMaterial,Jt as MeshPhysicalMaterial,An as MeshStandardMaterial,Fh as MeshToonMaterial,Lx as MinEquation,Vc as MirroredRepeatWrapping,iv as MixOperation,Ex as MultiplyBlending,nv as MultiplyOperation,Xc as NearestFilter,gv as NearestMipMapLinearFilter,mv as NearestMipMapNearestFilter,Yc as NearestMipmapLinearFilter,qc as NearestMipmapNearestFilter,tS as NeverCompare,Zx as NeverDepth,Yy as NeverStencilFunc,Fc as NoBlending,Ny as NoColorSpace,rv as NoToneMapping,Ay as NormalAnimationBlendMode,Tx as NormalBlending,aS as NotEqualCompare,tv as NotEqualDepth,jy as NotEqualStencilFunc,Un as NumberKeyframeTrack,et as Object3D,d0 as ObjectLoader,Iy as ObjectSpaceNormalMap,Zr as OctahedronGeometry,Dx as OneFactor,Yx as OneMinusConstantAlphaFactor,Xx as OneMinusConstantColorFactor,kx as OneMinusDstAlphaFactor,Hx as OneMinusDstColorFactor,Bx as OneMinusSrcAlphaFactor,Fx as OneMinusSrcColorFactor,du as OrbitControls,kn as OrthographicCamera,Yu as OutputPass,By as P3Primaries,yx as PCFShadowMap,Sx as PCFSoftShadowMap,qa as PMREMGenerator,ys as Path,yt as PerspectiveCamera,ln as Plane,Or as PlaneGeometry,$0 as PlaneHelper,$i as PointLight,H0 as PointLightHelper,Wr as Points,Ps as PointsMaterial,q0 as PolarGridHelper,pi as PolyhedronGeometry,v0 as PositionalAudio,Qe as PropertyBinding,su as PropertyMixer,xo as QuadraticBezierCurve,vo as QuadraticBezierCurve3,_t as Quaternion,En as QuaternionKeyframeTrack,Xh as QuaternionLinearInterpolant,gy as RED_GREEN_RGTC2_Format,py as RED_RGTC1_Format,px as REVISION,Py as RGBADepthPacking,Pv as RGBAFormat,zv as RGBAIntegerFormat,ly as RGBA_ASTC_10x10_Format,ry as RGBA_ASTC_10x5_Format,ay as RGBA_ASTC_10x6_Format,oy as RGBA_ASTC_10x8_Format,cy as RGBA_ASTC_12x10_Format,hy as RGBA_ASTC_12x12_Format,$v as RGBA_ASTC_4x4_Format,jv as RGBA_ASTC_5x4_Format,Qv as RGBA_ASTC_5x5_Format,ey as RGBA_ASTC_6x5_Format,ty as RGBA_ASTC_6x6_Format,ny as RGBA_ASTC_8x5_Format,iy as RGBA_ASTC_8x6_Format,sy as RGBA_ASTC_8x8_Format,uy as RGBA_BPTC_Format,Jv as RGBA_ETC2_EAC_Format,Yv as RGBA_PVRTC_2BPPV1_Format,qv as RGBA_PVRTC_4BPPV1_Format,Gv as RGBA_S3TC_DXT1_Format,Hv as RGBA_S3TC_DXT3_Format,Wv as RGBA_S3TC_DXT5_Format,dy as RGB_BPTC_SIGNED_Format,fy as RGB_BPTC_UNSIGNED_Format,Zv as RGB_ETC1_Format,Kv as RGB_ETC2_Format,Xv as RGB_PVRTC_2BPPV1_Format,Vv as RGB_PVRTC_4BPPV1_Format,kv as RGB_S3TC_DXT1_Format,Ov as RGFormat,Bv as RGIntegerFormat,Jr as RawShaderMaterial,On as Ray,F0 as Raycaster,Oy as Rec709Primaries,jh as RectAreaLight,Uv as RedFormat,Fv as RedIntegerFormat,zc as ReinhardToneMapping,Vu as RenderPass,Qc as RenderTarget,Pr as RepeatWrapping,Gy as ReplaceStencilOp,Px as ReverseSubtractEquation,wo as RingGeometry,Zu as RoomEnvironment,_y as SIGNED_RED_GREEN_RGTC2_Format,my as SIGNED_RED_RGTC1_Format,Ki as SRGBColorSpace,$c as SRGBTransfer,zr as Scene,qe as ShaderChunk,cn as ShaderLib,Et as ShaderMaterial,Dh as ShadowMaterial,li as Shape,Ro as ShapeGeometry,ex as ShapePath,Sn as ShapeUtils,Sv as ShortType,Cs as Skeleton,G0 as SkeletonHelper,kr as SkinnedMesh,si as Source,At as Sphere,Kr as SphereGeometry,ta as Spherical,Qh as SphericalHarmonics3,yo as SplineCurve,jr as SpotLight,k0 as SpotLightHelper,yh as Sprite,po as SpriteMaterial,Ox as SrcAlphaFactor,Wx as SrcAlphaSaturateFactor,Ux as SrcColorFactor,mS as StaticCopyUsage,cS as StaticDrawUsage,dS as StaticReadUsage,m0 as StereoCamera,_S as StreamCopyUsage,uS as StreamDrawUsage,pS as StreamReadUsage,_i as StringKeyframeTrack,Cx as SubtractEquation,Ax as SubtractiveBlending,di as TOUCH,Ly as TangentSpaceNormalMap,Co as TetrahedronGeometry,ht as Texture,Oo as TextureLoader,Po as TorusGeometry,Lo as TorusKnotGeometry,Vt as Triangle,As as TriangleFanDrawMode,Lr as TriangleStripDrawMode,Jc as TrianglesDrawMode,Io as TubeGeometry,bx as TwoPassDoubleSide,cv as UVMapping,ro as Uint16BufferAttribute,ao as Uint32BufferAttribute,Nd as Uint8BufferAttribute,Dd as Uint8ClampedBufferAttribute,ou as Uniform,N0 as UniformsGroup,fe as UniformsLib,zn as UniformsUtils,Qi as UnrealBloomPass,vv as UnsignedByteType,Rv as UnsignedInt248Type,Tv as UnsignedIntType,Ev as UnsignedShort4444Type,wv as UnsignedShort5551Type,Mv as UnsignedShortType,Mx as VSMShadowMap,W as Vector2,T as Vector3,at as Vector4,Fn as VectorKeyframeTrack,A_ as VideoTexture,xh as WebGL1Renderer,yd as WebGL3DRenderTarget,vd as WebGLArrayRenderTarget,SS as WebGLCoordinateSystem,ih as WebGLCubeRenderTarget,Sd as WebGLMultipleRenderTargets,Ct as WebGLRenderTarget,_h as WebGLRenderer,p_ as WebGLUtils,MS as WebGPUCoordinateSystem,Nh as WireframeGeometry,Ty as WrapAroundEnding,My as ZeroCurvatureEnding,Nx as ZeroFactor,by as ZeroSlopeEnding,zy as ZeroStencilOp,yS as _SRGBAFormat,md as createCanvasElement,Ry as sRGBEncoding};
