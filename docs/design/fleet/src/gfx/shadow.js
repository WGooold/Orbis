// 两张阴影图：A 覆盖空间站与近处舰队，B 贴合当前主角
import * as THREE from 'three';
import { env } from './cel.js';

export class Shadows {
  constructor(renderer, q) {
    this.r = renderer;
    this.A = this.make(q.shadowA); this.B = this.make(q.shadowB);
    env.uShadowA.value = this.A.rt.depthTexture; env.uShadowB.value = this.B.rt.depthTexture;
    env.uShadowTexel.value.set(1 / q.shadowA, 1 / q.shadowB);
    for (const S of [this.A, this.B]) { renderer.setRenderTarget(S.rt); renderer.clear(true, true, false); }
    renderer.setRenderTarget(null);
    this.frame = 0; this.every = q.shadowEvery || 1;
  }
  make(size) {
    const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    rt.depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    rt.depthTexture.compareFunction = THREE.LessEqualCompare; rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
    return { rt, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100), size };
  }
  fit(S, center, radius, m) {
    const c = S.cam, sun = env.uSun.value;
    c.left = c.bottom = -radius; c.right = c.top = radius; c.near = 1; c.far = radius * 4 + 2;
    c.up.set(0, 1, 0); if (Math.abs(sun.y) > .97) c.up.set(0, 0, 1);
    c.position.copy(center).addScaledVector(sun, radius * 2); c.lookAt(center); c.updateMatrixWorld(); c.updateProjectionMatrix();
    // 贴齐像素，避免晃动
    const t = radius * 2 / S.size; const v = center.clone().applyMatrix4(c.matrixWorldInverse);
    const dx = v.x - Math.round(v.x / t) * t, dy = v.y - Math.round(v.y / t) * t;
    c.left += dx; c.right += dx; c.top += dy; c.bottom += dy; c.updateProjectionMatrix();
    m.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
  }
  render(list, S) {
    const r = this.r; const prev = r.getRenderTarget();
    r.setRenderTarget(S.rt); r.clear(true, true, false);
    for (const root of list) { if (!root.visible) continue; this.draw(root, S.cam); }
    r.setRenderTarget(prev);
  }
  draw(root, cam) {
    // 用深度材质替换后只渲染这一棵树
    const swap = [];
    root.traverseVisible((o) => { if (o.isMesh && o.userData.depthMat) { if (!o.userData.cast) { swap.push([o, null]); o.visible = false; } else { swap.push([o, o.material]); o.material = o.userData.depthMat; } } });
    this.r.render(root, cam);
    for (const [o, m] of swap) { if (m) o.material = m; else o.visible = true; }
  }
}
