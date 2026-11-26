// 生成可平铺的面板纹理：R 装甲、G 机械。两级分格 + 细线 + 铆点 + 小舱口
import * as THREE from 'three';
export function panelTexture(size = 1024, aniso = 8) {
  let s = 20261125; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const draw = (mode) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = size; const g = cv.getContext('2d', { willReadFrequently: true });
    const base = mode ? 238 : 250; g.fillStyle = `rgb(${base},${base},${base})`; g.fillRect(0, 0, size, size);
    const cells = [];
    const split = (x, y, w, h, d) => {
      if (d <= 0 || (w < size * .13 && h < size * .13) || (d < 3 && rnd() < .22)) { cells.push([x, y, w, h]); return; }
      const t = .3 + rnd() * .4;
      if (w > h * (.7 + rnd() * .6)) { split(x, y, w * t, h, d - 1); split(x + w * t, y, w * (1 - t), h, d - 1); } else { split(x, y, w, h * t, d - 1); split(x, y + h * t, w, h * (1 - t), d - 1); }
    };
    split(0, 0, size, size, mode ? 6 : 5);
    cells.forEach(([x, y, w, h]) => { const v = base - (rnd() < .35 ? rnd() * (mode ? 30 : 16) : rnd() * 4); g.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`; g.fillRect(x, y, w, h); });
    const ink = mode ? 168 : 182; g.strokeStyle = `rgb(${ink},${ink},${ink})`; g.lineWidth = size / 560;
    cells.forEach(([x, y, w, h]) => g.strokeRect(x + .5, y + .5, w, h));
    // 细节
    cells.forEach(([x, y, w, h]) => {
      const r = rnd(); const soft = base - (mode ? 46 : 34); g.fillStyle = g.strokeStyle = `rgb(${soft},${soft},${soft})`; g.lineWidth = size / 900;
      const m = Math.min(w, h);
      if (r < .28 && m > size * .07) { const i = m * .13; g.strokeRect(x + i, y + i, w - 2 * i, h - 2 * i); }
      else if (r < .46) { const n = 3 + (rnd() * 4 | 0); const lw = m * .34; for (let k = 0; k < n; k++) g.fillRect(x + w * .14 + k * lw * .24, y + h * .16, lw * .1, lw * .6); }
      else if (r < .62) { const rr = size / 460; for (const [a, b] of [[.08, .08], [.92, .08], [.08, .92], [.92, .92]]) { g.beginPath(); g.arc(x + w * a, y + h * b, rr, 0, 7); g.fill(); } }
      else if (r < .72 && m > size * .06) { g.beginPath(); g.arc(x + w * .5, y + h * .5, m * .18, 0, 7); g.stroke(); }
      else if (r < .82) { g.beginPath(); g.moveTo(x + w * .1, y + h * .5); g.lineTo(x + w * .55, y + h * .5); g.lineTo(x + w * .7, y + h * .3); g.lineTo(x + w, y + h * .3); g.stroke(); }
    });
    return g.getImageData(0, 0, size, size).data;
  };
  const a = draw(0), b = draw(1); const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { out[i * 4] = a[i * 4]; out[i * 4 + 1] = b[i * 4]; out[i * 4 + 2] = 0; out[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(out, size, size); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = aniso; t.needsUpdate = true;
  return t;
}
