/* Shared 3D iPhone body for the Orbis film (CSS 3D, deterministic).
 *
 *   OrbisPhone.build(phoneEl, { screen: screenEl, thickness: 46, screenZ: 0.6, islandZ: 3, glareZ: 4.5 })
 *
 * phoneEl: a preserve-3d box of 413 x 872 (iOS points, scaled by the scene).
 * screenEl: the scene's own 393 x 852 screen content, placed at (10, 10) on the glass.
 * Adds: titanium side wall (continuous faceted band, shaded per facet), black bezel,
 * glass glare (tween its backgroundPosition), Dynamic Island, side buttons,
 * and a frosted-glass back with a three-lens camera plateau.
 * Returns { glare, back, power }.
 */
(function () {
  const W = 413;
  const H = 872;
  const R = 62;
  function div(cls, parent, before) {
    const d = document.createElement("div");
    d.className = cls;
    if (before) parent.insertBefore(d, before);
    else parent.appendChild(d);
    return d;
  }
  function build(phone, opts) {
    const T = (opts && opts.thickness) || 46;
    // Layers that overlap on the glass stay at least ~1.5 px apart in depth, so the 3D sort never
    // has to choose between near-coplanar planes (that choice can flip between frames and flicker).
    const screenZ = (opts && opts.screenZ) ?? 0.6;
    const islandZ = (opts && opts.islandZ) ?? 3;
    const glareZ = (opts && opts.glareZ) ?? 4.5;
    const screen = opts && opts.screen;
    const first = phone.firstChild;
    // back
    const back = div("ph3-plate ph3-back", phone, first);
    back.style.transform = `translateZ(${-T}px) rotateY(180deg)`;
    const plateau = div("ph3-plateau", back);
    [[16, 14], [16, 92], [90, 53]].forEach(([x, y]) => {
      const l = div("ph3-lens", plateau);
      l.style.left = x + "px";
      l.style.top = y + "px";
    });
    const fl = div("ph3-flash", plateau);
    fl.style.left = "122px";
    fl.style.top = "22px";
    const li = div("ph3-flash", plateau);
    li.style.left = "126px";
    li.style.top = "124px";
    li.style.background = "radial-gradient(circle, #20242c 0 45%, #3a414c 70%, #9aa1ab 100%)";
    // Titanium side wall: one continuous band around the outline (4 straight sides + 12 facets per
    // corner), each facet shaded once from its outward normal against a soft key light from the upper
    // left. Satin grey across the thickness, slightly darker toward the back, with a thin polished
    // chamfer where it meets the front glass. No stacked rings, so no stripes.
    const segs = [];
    const C = [[R, R], [W - R, R], [W - R, H - R], [R, H - R]];
    const arc = (cx, cy, a0) => {
      const N = 12;
      for (let i = 0; i < N; i++) {
        const t0 = a0 + (i / N) * 90, t1 = a0 + ((i + 1) / N) * 90;
        const p0 = [cx + R * Math.cos((t0 * Math.PI) / 180), cy + R * Math.sin((t0 * Math.PI) / 180)];
        const p1 = [cx + R * Math.cos((t1 * Math.PI) / 180), cy + R * Math.sin((t1 * Math.PI) / 180)];
        segs.push([p0, p1]);
      }
    };
    segs.push([[R, 0], [W - R, 0]]);
    arc(C[1][0], C[1][1], -90);
    segs.push([[W, R], [W, H - R]]);
    arc(C[2][0], C[2][1], 0);
    segs.push([[W - R, H], [R, H]]);
    arc(C[3][0], C[3][1], 90);
    segs.push([[0, H - R], [0, R]]);
    arc(C[0][0], C[0][1], 180);
    const L = [-0.42, -0.78]; // key light direction in the phone's plane (screen y points down)
    const ln = Math.hypot(L[0], L[1]);
    const shade = (rgb, k) => `rgb(${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(",")})`;
    const BASE = [160, 166, 174];
    segs.forEach(([p0, p1]) => {
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy);
      const theta = (Math.atan2(dy, dx) * 180) / Math.PI;
      const nx = dy / len, ny = -dx / len; // outward normal for a clockwise outline
      const lit = (nx * L[0] + ny * L[1]) / ln; // -1 .. 1
      const k = 0.9 + 0.2 * lit;
      const f = div("ph3-side", phone, first);
      const w = len + 0.8;
      f.style.width = w + "px";
      f.style.height = T + "px";
      f.style.left = (p0[0] + p1[0]) / 2 - w / 2 + "px";
      f.style.top = (p0[1] + p1[1]) / 2 - T / 2 + "px";
      // top of the element = back of the phone, bottom = front edge at the glass
      f.style.background = `linear-gradient(180deg, ${shade(BASE, k * 0.8)} 0%, ${shade(BASE, k * 0.92)} 14%, ${shade(BASE, k)} 45%, ${shade(BASE, k * 1.04)} 78%, ${shade(BASE, k * 1.18)} 92%, ${shade([236, 239, 242], Math.min(1, k * 1.02))} 97%, ${shade(BASE, k * 0.9)} 100%)`;
      f.style.transform = `translateZ(${-T / 2}px) rotateZ(${theta}deg) rotateX(90deg)`;
    });
    // front: black glass bezel, then the scene's screen, then island and glare
    const bezel = div("ph3-bezel", phone, first);
    bezel.style.transform = "translateZ(0.3px)";
    if (screen) {
      screen.style.transform = `translateZ(${screenZ}px)`;
      phone.appendChild(screen);
    }
    const island = div("ph3-island", phone);
    island.style.transform = `translateZ(${islandZ}px)`;
    const glare = div("ph3-glare", phone);
    glare.style.transform = `translateZ(${glareZ}px)`;
    // side buttons (planes facing +x / -x at mid-thickness)
    const side = (x, y, h, face) => {
      const b = div("ph3-btn", phone, first);
      b.style.height = h + "px";
      b.style.transform = `translate3d(${x}px, ${y}px, ${-T / 2 + 7}px) rotateY(${face}deg)`;
      return b;
    };
    side(-9, 150, 34, -90); // action button
    side(-9, 214, 62, -90); // volume up
    side(-9, 290, 62, -90); // volume down
    const power = side(W - 5, 250, 100, 90);
    return { glare, back, power };
  }
  window.OrbisPhone = { build, W, H };
})();
