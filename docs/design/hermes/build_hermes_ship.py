"""Parametric ultra-detailed hard-surface 3D model builder for the Hermes Swept-Wing Interceptor (V3 Ligne-Claire Comic Cel-Shaded + Fine Ink LineArt + Hermetic Wing Gold Inscriptions).

Built directly from the hero orbital concept and 5 orthographic turnaround reference views
in docs/design/hermes/:
  - Hero 3/4:     hermes-agent-swept-wing.png (sleek obsidian-black stealth fuselage with
                  recessed warm-gold illuminated flank waist slit, sweeping forward-extended
                  crescent wings with satin cream-ivory ceramic outer panels, brushed
                  champagne-gold inner C-curve ribbons & perimeter blade bevels, recessed
                  triangular louvered wing intakes, twin double-decker fluted struts, quad
                  stacked cylindrical aft wing thrusters with copper-bronze forward turbo rings)
  - Front Ortho:  截屏2026-11-25 19.30.58.png (hexagonal stealth fuselage with sleek continuous
                  faceted dorsal canopy spine, symmetrical top-and-bottom diamond airfoil wings,
                  twin upper/lower horizontal spars, dorsal & ventral triangular intake scoops)
  - Top Ortho:    截屏2026-11-25 19.32.03.png (1.074 span-to-length ratio, forward wingtips
                  extending slightly ahead of chisel bow, sweeping C-curve gold divider ribbon,
                  aft arched fluted strut & forward aft-swept diagonal strut, triangular vents)
  - Side Ortho:   截屏2026-11-25 19.32.17.png (razor-low 6.2:1 length-to-height profile,
                  sleek dorsal canopy ridge, wing gold edge swooping gently down to outer
                  shoulder and splitting aft into upper & lower trailing cowlings over an
                  open hollow rear V-notch revealing the stacked thruster barrels)
  - Rear Ortho:   截屏2026-11-25 19.32.29.png (wide open hollow triangular aft wing bays framed
                  by dark chamfered upper & lower trailing cowlings, quad stacked cylindrical
                  blued-titanium engine nozzles at inner wing corners, central rectangular stern port)
  - Bottom Ortho: 截屏2026-11-25 19.32.53.png (symmetrical ventral ivory/gold/obsidian wing
                  armor & ventral triangular vents, faceted midnight-slate ventral keel plates)

Shaded in refined Ligne-Claire Anime/Comic style:
  - 4-band EEVEE NPR Cel-Shading (Diffuse -> ShaderToRGB -> stepped ColorRamp, crisp comic
    specular catchlights, delicate Fresnel edge rim, clean AO crevice shading)
  - Dual-ramp Wing Inscription Cel Shader separating Cream-Ivory/Obsidian cel bands from
    burnished metallic Comic-Gold Hermetic Greek inscriptions & flowing golden hair scrolls
    (2048x3072 Dual-Half Atlas, 100% upright non-mirrored on all 4 wing surfaces)
  - Selective fine-pen Blender 5.3 Grease Pencil Line Art (thin clean silhouettes & major
    architectural creases only; micro-louvers, nozzle petals & emissives excluded -> zero clutter!)
  - Dual-target Material Output (EEVEE NPR Cel Shader + glTF 2.0 Principled BSDF fallback)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/hermes"
RENDER_DIR = os.path.join(OUT_DIR, "renders")
TEX_DIR = os.path.join(OUT_DIR, "textures")
os.makedirs(RENDER_DIR, exist_ok=True)
os.makedirs(TEX_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# 0. Safe Scene Reset & Collection Helpers (never unloads Blender add-ons)
# ---------------------------------------------------------------------------

def reset_scene():
    """Clear scene objects/collections/data safely without unloading add-ons."""
    scene = bpy.context.scene
    scene.name = "Hermes_Scene"
    scene.world = None
    scene.render.use_freestyle = False
    if hasattr(scene, "use_nodes"):
        scene.use_nodes = False
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for col in list(scene.collection.children):
        scene.collection.children.unlink(col)
    while True:
        removed = False
        for col in list(bpy.data.collections):
            if col.users == 0:
                bpy.data.collections.remove(col)
                removed = True
        if not removed:
            break
    stores = [
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.worlds,
        bpy.data.images,
    ]
    for gp_attr in ("grease_pencils", "grease_pencils_v3"):
        if hasattr(bpy.data, gp_attr):
            stores.append(getattr(bpy.data, gp_attr))
    for block_store in stores:
        for block in list(block_store):
            if block.users == 0:
                block_store.remove(block)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def ensure_collection(name, parent=None):
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    target = bpy.context.scene.collection if parent is None else parent
    if col.name not in target.children:
        target.children.link(col)
    return col


def link_obj(obj, collection):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# 1. Procedural 2048x2048 Luxury-Stealth Aerospace PBR Texture Synthesis
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64), weights=(0.34, 0.26, 0.18, 0.13, 0.09)):
    """Fast vectorized seamless tileable fBM noise using periodic smoothstep interpolation."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((res, res), dtype=np.float32)
    w_sum = 0.0
    coords = np.linspace(0.0, 1.0, res, endpoint=False, dtype=np.float32)
    for freq, w in zip(octaves, weights):
        grid = rng.random((freq, freq), dtype=np.float32)
        u = coords * freq
        i0 = np.floor(u).astype(np.int32) % freq
        i1 = (i0 + 1) % freq
        f = u - np.floor(u)
        s = f * f * (3.0 - 2.0 * f)
        sx = s[None, :]
        sy = s[:, None]
        g00 = grid[i0[:, None], i0[None, :]]
        g10 = grid[i0[:, None], i1[None, :]]
        g01 = grid[i1[:, None], i0[None, :]]
        g11 = grid[i1[:, None], i1[None, :]]
        top = g00 * (1.0 - sx) + g10 * sx
        bot = g01 * (1.0 - sx) + g11 * sx
        acc += (top * (1.0 - sy) + bot * sy) * w
        w_sum += w
    return acc / max(w_sum, 1e-6)


def _generate_stealth_plating(res, seed, grid_x=2, grid_y=3, sub_prob=0.38, seam_px=2, with_rivets=True):
    """Generate clean aerospace panel lines, subtle per-plate tonal shift, and fine flush fasteners."""
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    seam = np.zeros((res, res), dtype=np.float32)
    rivet = np.zeros((res, res), dtype=np.float32)
    edge_hi = np.zeros((res, res), dtype=np.float32)

    xs = [0]
    ys = [0]
    sx = res // grid_x
    sy = res // grid_y
    margin = max(72, res // 14)
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * sx + rng.integers(-sx // 7, sx // 7 + 1), margin, res - margin)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * sy + rng.integers(-sy // 7, sy // 7 + 1), margin, res - margin)))
    xs.append(res)
    ys.append(res)

    min_sub = max(260, res // 4)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 1 and min(w, h) > min_sub and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.36, 0.64))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.36, 0.64))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        tone[y0:y1, x0:x1] = float(rng.uniform(-0.016, 0.016))
        sp = seam_px
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        ew = sp + max(2, res // 400)
        if y1 - y0 > ew * 3 and x1 - x0 > ew * 3:
            edge_hi[y0 + sp:y0 + ew, x0 + sp:x1 - sp] = 0.45
            edge_hi[y0 + sp:y1 - sp, x0 + sp:x0 + ew] = 0.36

        if with_rivets:
            step = max(84, res // 14)
            pad = sp + max(18, res // 86)
            r_sz = max(2, res // 680)
            if w > pad * 4 and h > pad * 4:
                for rx in range(x0 + pad, x1 - pad, step):
                    for ry in (y0 + pad, y1 - pad - r_sz):
                        if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                            rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0
                for ry in range(y0 + pad + step, y1 - pad - step, step):
                    for rx in (x0 + pad, x1 - pad - r_sz):
                        if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                            rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    seam_blur = (
        seam * 0.56
        + np.roll(seam, 1, axis=0) * 0.11
        + np.roll(seam, -1, axis=0) * 0.11
        + np.roll(seam, 1, axis=1) * 0.11
        + np.roll(seam, -1, axis=1) * 0.11
    )
    rivet_blur = (
        rivet * 0.60
        + np.roll(rivet, 1, axis=0) * 0.10
        + np.roll(rivet, -1, axis=0) * 0.10
        + np.roll(rivet, 1, axis=1) * 0.10
        + np.roll(rivet, -1, axis=1) * 0.10
    )
    return tone, np.clip(seam_blur, 0.0, 1.0), edge_hi, np.clip(rivet_blur, 0.0, 1.0)


def _height_to_normal(height, strength=1.8):
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    nx, ny, nz = -dx, -dy, np.ones_like(height)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    return np.stack([nx * inv_len * 0.5 + 0.5, ny * inv_len * 0.5 + 0.5, nz * inv_len * 0.5 + 0.5], axis=-1)


def _write_png_rgb(filepath, rgb_float):
    arr = np.ascontiguousarray(np.clip(np.round(rgb_float * 255.0), 0, 255).astype(np.uint8))
    h, w, _ = arr.shape
    rows = np.concatenate([np.zeros((h, 1), dtype=np.uint8), arr.reshape(h, w * 3)], axis=1)
    compressed = zlib.compress(rows.tobytes(), level=6)

    def chunk(ctype, data):
        crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png_bytes = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    with open(filepath, "wb") as f:
        f.write(png_bytes)


def _save_and_pack_image(name, filepath, rgb_float, colorspace="sRGB"):
    _write_png_rgb(filepath, rgb_float)
    img = bpy.data.images.load(filepath, check_existing=False)
    img.name = name
    img.colorspace_settings.name = colorspace
    img.pack()
    return img


# ---------------------------------------------------------------------------
# 1B. Wing-Space Dual-Half Vector SDF Gold-Hairline Hermetic Inscription Engine (2048x3072)
# ---------------------------------------------------------------------------
# Dual-half UV atlas (u in [0.0, 0.5] = Half 0: Dorsal-Stbd & Ventral-Port;
# u in [0.5, 1.0] = Half 1: Dorsal-Port & Ventral-Stbd) guarantees 100% upright,
# left-to-right, non-mirrored classical Greek & Hermetic inscriptions on ALL 4 wing faces!

WING_UV_X0, WING_UV_XW = 4.0, 7.0    # u_local = (abs(x) - 4.0) / 7.0 -> covers X in [4.0, 11.0] m
WING_UV_Y0, WING_UV_YH = -10.2, 20.4 # v       = (y + 10.2) / 20.4     -> covers Y in [-10.2, +10.2] m


class _WingInscriptionCanvas:
    """Sub-pixel anti-aliased world-meter SDF rasterizer for hairline gold Hermetic inscriptions."""

    def __init__(self, width=1024, height=3072):
        self.w = width
        self.h = height
        self.dist = np.full((height, width), 1.0, dtype=np.float32)
        self.dx_m = WING_UV_XW / float(width - 1)
        self.dy_m = WING_UV_YH / float(height - 1)
        self.aa_m = max(self.dx_m, self.dy_m) * 0.92
        self.xs = WING_UV_X0 + np.arange(width, dtype=np.float32) * self.dx_m
        # Row 0 = top of PNG = v=1.0 = Y_max (+10.2); Row H-1 = bottom = v=0.0 = Y_min (-10.2)
        self.ys = (WING_UV_Y0 + WING_UV_YH) - np.arange(height, dtype=np.float32) * self.dy_m

    def _bbox_idx(self, x0, x1, y0, y1, pad):
        c0 = max(0, int(math.floor((min(x0, x1) - pad - WING_UV_X0) / self.dx_m)))
        c1 = min(self.w, int(math.ceil((max(x0, x1) + pad - WING_UV_X0) / self.dx_m)) + 1)
        r0 = max(0, int(math.floor(((WING_UV_Y0 + WING_UV_YH) - (max(y0, y1) + pad)) / self.dy_m)))
        r1 = min(self.h, int(math.ceil(((WING_UV_Y0 + WING_UV_YH) - (min(y0, y1) - pad)) / self.dy_m)) + 1)
        return r0, r1, c0, c1

    def segment(self, p0, p1, half_w):
        ax, ay = float(p0[0]), float(p0[1])
        bx, by = float(p1[0]), float(p1[1])
        pad = half_w + self.aa_m * 3.0
        r0, r1, c0, c1 = self._bbox_idx(ax, bx, ay, by, pad)
        if r0 >= r1 or c0 >= c1:
            return
        px = self.xs[c0:c1][None, :]
        py = self.ys[r0:r1][:, None]
        vx, vy = bx - ax, by - ay
        l2 = vx * vx + vy * vy
        if l2 < 1e-10:
            d = np.hypot(px - ax, py - ay) - half_w
        else:
            t = np.clip(((px - ax) * vx + (py - ay) * vy) / l2, 0.0, 1.0)
            d = np.hypot(px - (ax + t * vx), py - (ay + t * vy)) - half_w
        sub = self.dist[r0:r1, c0:c1]
        np.minimum(sub, d, out=sub)

    def dot(self, cx, cy, radius):
        self.segment((cx, cy), (cx, cy), radius)

    def polyline(self, pts, half_w, taper_ends=False, taper_start=False, taper_end=False):
        n = len(pts)
        if n < 2:
            return
        do_s = taper_ends or taper_start
        do_e = taper_ends or taper_end
        for i in range(n - 1):
            hw = half_w
            if (do_s or do_e) and n >= 5:
                f = (i + 0.5) / float(n - 1)
                ts = min(1.0, f / 0.18) if do_s else 1.0
                te = min(1.0, (1.0 - f) / 0.18) if do_e else 1.0
                hw = half_w * (0.24 + 0.76 * min(ts, te))
            self.segment(pts[i], pts[i + 1], hw)

    def arc(self, cx, cy, radius, a0, a1, half_w, steps=48):
        pts = [
            (cx + radius * math.cos(a0 + (a1 - a0) * k / float(steps)),
             cy + radius * math.sin(a0 + (a1 - a0) * k / float(steps)))
            for k in range(steps + 1)
        ]
        self.polyline(pts, half_w)

    def hair_scroll(self, sx, sy, tx, ty, nx, ny, scale=0.34, turns=1.15, half_w=0.0056, steps=34):
        """Draw a silky tapered logarithmic golden hair-strand curl flowing smoothly out of (sx, sy)
        along tangent (tx, ty) and curling gently toward normal (nx, ny)."""
        # Starting radius & center so spiral leaves (sx, sy) C1-tangent to (tx, ty)
        r0 = scale * 0.52
        cx = sx + nx * r0
        cy = sy + ny * r0
        # Angle in local (tx, ty) / (nx, ny) frame: at theta=0 point is at -r0 * N -> tangent = +T!
        pts = []
        for k in range(steps + 1):
            f = k / float(steps)
            th = f * turns * 2.0 * math.pi
            rad = r0 * math.exp(-0.92 * f * turns)
            # Local coords along T and N
            lt = rad * math.sin(th)
            ln = -rad * math.cos(th)
            pts.append((cx + lt * tx + ln * nx, cy + lt * ty + ln * ny))
        self.polyline(pts, half_w, taper_end=True)

    def draw_glyph_basis(self, ch, cx, cy, tx, ty, nx, ny, height, hw):
        """Render a classical Greek or Hermetic epigraphic rune at (cx, cy) using explicit
        orthonormal reading-direction basis (tx, ty) = +u (left->right) and (nx, ny) = +v (up)."""
        sx = height * 0.66
        sy = height

        def xform(u, v):
            lx = u * sx
            ly = v * sy
            return (cx + lx * tx + ly * nx, cy + lx * ty + ly * ny)

        def seg(u0, v0, u1, v1, w_mult=1.0):
            self.segment(xform(u0, v0), xform(u1, v1), hw * w_mult)

        def curve(uv_pts, w_mult=1.0):
            self.polyline([xform(u, v) for (u, v) in uv_pts], hw * w_mult)

        def oval(uc, vc, ru, rv, a0=0.0, a1=2.0 * math.pi, steps=28, w_mult=1.0):
            pts = [
                xform(uc + ru * math.cos(a0 + (a1 - a0) * k / float(steps)),
                      vc + rv * math.sin(a0 + (a1 - a0) * k / float(steps)))
                for k in range(steps + 1)
            ]
            self.polyline(pts, hw * w_mult)

        sf = 0.10  # Classical chiseled epigraphic serif half-width

        if ch == "·":
            self.dot(cx, cy, hw * 2.0)
        elif ch == "◇":
            curve([(0.0, 0.34), (0.30, 0.0), (0.0, -0.34), (-0.30, 0.0), (0.0, 0.34)], 0.92)
        elif ch == "✦":
            for sgn_x in (-1.0, 1.0):
                for sgn_y in (-1.0, 1.0):
                    pts = []
                    for k in range(9):
                        t = k / 8.0
                        u = sgn_x * (0.44 * (1.0 - t) ** 2 + 0.08 * 2 * (1.0 - t) * t)
                        v = sgn_y * (0.08 * 2 * (1.0 - t) * t + 0.44 * t ** 2)
                        pts.append((u, v))
                    curve(pts, 0.85)
        elif ch == "☿":
            oval(0.0, 0.08, 0.25, 0.22, 0.0, 2.0 * math.pi, steps=28, w_mult=1.05)
            oval(0.0, 0.44, 0.26, 0.16, math.pi * 1.12, math.pi * 1.88, steps=18, w_mult=1.0)
            seg(0.0, -0.14, 0.0, -0.50, 1.05)
            seg(-0.22, -0.32, 0.22, -0.32, 1.0)
            seg(-sf, -0.50, sf, -0.50, 0.78)
        elif ch == "☉":
            oval(0.0, 0.0, 0.36, 0.32, 0.0, 2.0 * math.pi, steps=28, w_mult=1.0)
            self.dot(cx, cy, hw * 2.2)
        elif ch == "◬":
            curve([(-0.40, -0.42), (0.0, 0.46), (0.40, -0.42), (-0.40, -0.42)], 0.96)
            seg(-0.34, 0.06, 0.34, 0.06, 0.88)
        elif ch == "⛉":
            curve([(-0.40, 0.42), (0.0, -0.46), (0.40, 0.42), (-0.40, 0.42)], 0.96)
            seg(-0.34, -0.06, 0.34, -0.06, 0.88)
        elif ch == "Α":
            seg(-0.40, -0.48, 0.0, 0.48)
            seg(0.40, -0.48, 0.0, 0.48)
            seg(-0.23, -0.10, 0.23, -0.10, 0.88)
            seg(-0.48, -0.48, -0.30, -0.48, 0.75)
            seg(0.30, -0.48, 0.48, -0.48, 0.75)
        elif ch == "Γ":
            seg(-0.34, -0.48, -0.34, 0.48)
            seg(-0.42, 0.48, 0.38, 0.48)
            seg(0.38, 0.48, 0.38, 0.34, 0.76)
            seg(-0.44, -0.48, -0.22, -0.48, 0.76)
        elif ch == "Δ":
            curve([(-0.42, -0.46), (0.0, 0.48), (0.42, -0.46), (-0.42, -0.46)])
            seg(-0.48, -0.46, -0.34, -0.46, 0.75)
            seg(0.34, -0.46, 0.48, -0.46, 0.75)
        elif ch == "Ε":
            seg(-0.34, -0.48, -0.34, 0.48)
            seg(-0.42, 0.48, 0.38, 0.48)
            seg(-0.34, 0.02, 0.26, 0.02, 0.92)
            seg(-0.42, -0.48, 0.38, -0.48)
            seg(0.38, 0.48, 0.38, 0.36, 0.76)
            seg(0.38, -0.48, 0.38, -0.36, 0.76)
        elif ch == "Η":
            seg(-0.36, -0.48, -0.36, 0.48)
            seg(0.36, -0.48, 0.36, 0.48)
            seg(-0.36, 0.02, 0.36, 0.02, 0.90)
            for sx_s in (-0.36, 0.36):
                for sy_s in (-0.48, 0.48):
                    seg(sx_s - sf, sy_s, sx_s + sf, sy_s, 0.75)
        elif ch == "Θ":
            oval(0.0, 0.0, 0.40, 0.47, 0.0, 2.0 * math.pi, steps=30)
            seg(-0.28, 0.0, 0.28, 0.0, 0.88)
            seg(-0.28, -0.07, -0.28, 0.07, 0.72)
            seg(0.28, -0.07, 0.28, 0.07, 0.72)
        elif ch == "Ι":
            seg(0.0, -0.48, 0.0, 0.48)
            seg(-0.15, 0.48, 0.15, 0.48, 0.78)
            seg(-0.15, -0.48, 0.15, -0.48, 0.78)
        elif ch == "Κ":
            seg(-0.34, -0.48, -0.34, 0.48)
            seg(-0.34, -0.02, 0.36, 0.48, 0.96)
            seg(-0.12, 0.14, 0.38, -0.48, 0.96)
            for sy_s in (-0.48, 0.48):
                seg(-0.44, sy_s, -0.22, sy_s, 0.76)
            seg(0.26, 0.48, 0.44, 0.48, 0.74)
            seg(0.28, -0.48, 0.46, -0.48, 0.74)
        elif ch == "Λ":
            seg(-0.40, -0.48, 0.0, 0.48)
            seg(0.40, -0.48, 0.0, 0.48)
            seg(-0.48, -0.48, -0.30, -0.48, 0.75)
            seg(0.30, -0.48, 0.48, -0.48, 0.75)
        elif ch == "Μ":
            seg(-0.42, -0.48, -0.36, 0.48)
            seg(0.42, -0.48, 0.36, 0.48)
            seg(-0.36, 0.48, 0.0, -0.12, 0.94)
            seg(0.36, 0.48, 0.0, -0.12, 0.94)
            for sx_s in (-0.42, 0.42):
                seg(sx_s - sf, -0.48, sx_s + sf, -0.48, 0.75)
        elif ch == "Ν":
            seg(-0.36, -0.48, -0.36, 0.48)
            seg(0.36, -0.48, 0.36, 0.48)
            seg(-0.36, 0.46, 0.36, -0.46, 0.96)
            for sx_s in (-0.36, 0.36):
                for sy_s in (-0.48, 0.48):
                    seg(sx_s - sf, sy_s, sx_s + sf, sy_s, 0.75)
        elif ch == "Ξ":
            seg(-0.38, 0.46, 0.38, 0.46)
            seg(-0.26, 0.00, 0.26, 0.00, 0.92)
            seg(-0.38, -0.46, 0.38, -0.46)
            for sx_s in (-0.38, 0.38):
                seg(sx_s, 0.46, sx_s, 0.36, 0.72)
                seg(sx_s, -0.46, sx_s, -0.36, 0.72)
        elif ch == "Ο":
            oval(0.0, 0.0, 0.40, 0.47, 0.0, 2.0 * math.pi, steps=30)
        elif ch == "Π":
            seg(-0.36, -0.48, -0.36, 0.48)
            seg(0.36, -0.48, 0.36, 0.48)
            seg(-0.44, 0.48, 0.44, 0.48)
            for sx_s in (-0.36, 0.36):
                seg(sx_s - sf, -0.48, sx_s + sf, -0.48, 0.75)
        elif ch == "Ρ":
            seg(-0.32, -0.48, -0.32, 0.48)
            seg(-0.40, 0.48, 0.08, 0.48)
            seg(-0.32, -0.02, 0.08, -0.02)
            oval(0.08, 0.23, 0.28, 0.25, -0.5 * math.pi, 0.5 * math.pi, steps=20)
            seg(-0.42, -0.48, -0.20, -0.48, 0.76)
        elif ch == "Σ":
            seg(-0.38, 0.48, 0.38, 0.48)
            seg(-0.38, -0.48, 0.38, -0.48)
            seg(-0.38, 0.48, 0.14, 0.00, 0.96)
            seg(0.14, 0.00, -0.38, -0.48, 0.96)
            seg(0.38, 0.48, 0.38, 0.35, 0.76)
            seg(0.38, -0.48, 0.38, -0.35, 0.76)
        elif ch == "Τ":
            seg(0.0, -0.48, 0.0, 0.48)
            seg(-0.42, 0.48, 0.42, 0.48)
            seg(-0.42, 0.48, -0.42, 0.36, 0.74)
            seg(0.42, 0.48, 0.42, 0.36, 0.74)
            seg(-0.14, -0.48, 0.14, -0.48, 0.76)
        elif ch == "Υ":
            seg(0.0, -0.48, 0.0, 0.02)
            curve([(-0.40, 0.48), (-0.20, 0.16), (0.0, 0.02)])
            curve([(0.40, 0.48), (0.20, 0.16), (0.0, 0.02)])
            seg(-0.14, -0.48, 0.14, -0.48, 0.75)
            seg(-0.46, 0.48, -0.32, 0.48, 0.72)
            seg(0.32, 0.48, 0.46, 0.48, 0.72)
        elif ch == "Φ":
            seg(0.0, -0.48, 0.0, 0.48)
            oval(0.0, 0.0, 0.34, 0.28, 0.0, 2.0 * math.pi, steps=26, w_mult=0.95)
            seg(-0.14, 0.48, 0.14, 0.48, 0.76)
            seg(-0.14, -0.48, 0.14, -0.48, 0.76)
        elif ch == "Χ":
            seg(-0.38, -0.48, 0.38, 0.48)
            seg(-0.38, 0.48, 0.38, -0.48)
            for sx_s in (-0.38, 0.38):
                for sy_s in (-0.48, 0.48):
                    seg(sx_s - sf, sy_s, sx_s + sf, sy_s, 0.72)
        elif ch == "Ψ":
            seg(0.0, -0.48, 0.0, 0.48)
            oval(0.0, 0.22, 0.36, 0.30, math.pi, 2.0 * math.pi, steps=22, w_mult=0.96)
            seg(-0.36, 0.22, -0.36, 0.44, 0.96)
            seg(0.36, 0.22, 0.36, 0.44, 0.96)
            seg(-0.14, -0.48, 0.14, -0.48, 0.76)
            seg(-0.12, 0.48, 0.12, 0.48, 0.76)
        elif ch == "Ω":
            oval(0.0, 0.06, 0.39, 0.41, -0.34 * math.pi, 1.34 * math.pi, steps=28)
            seg(-0.44, -0.44, -0.17, -0.44)
            seg(0.17, -0.44, 0.44, -0.44)
            seg(-0.44, -0.44, -0.44, -0.32, 0.75)
            seg(0.44, -0.44, 0.44, -0.32, 0.75)

    def to_masks(self):
        """Return (gold_alpha, groove_shadow_alpha, etch_height) in [0, 1]."""
        aa = self.aa_m
        t = np.clip((aa - self.dist) / (2.0 * aa), 0.0, 1.0)
        gold = t * t * (3.0 - 2.0 * t)
        g_out = np.clip((self.aa_m * 2.5 - self.dist) / (2.0 * self.aa_m), 0.0, 1.0)
        groove = np.clip(g_out - gold, 0.0, 1.0)
        etch = np.clip((self.aa_m * 1.5 - self.dist) / (2.5 * self.aa_m), 0.0, 1.0)
        return gold, groove, etch


def _render_hermes_wing_half(w_half=1024, h=3072, port_handed=False):
    """Compose one half (1024x3072) of the Hermes Wing Gold-Hairline Inscription Atlas.
    - port_handed=False -> Half 0 (Dorsal-Starboard + Ventral-Port): reads left-to-right from stern->bow.
    - port_handed=True  -> Half 1 (Dorsal-Port + Ventral-Starboard): reads left-to-right from bow->stern
      with flipped local X handedness so Port's X-reflection restores 100% non-mirrored Greek text!"""
    iv = _WingInscriptionCanvas(w_half, h)
    ob = _WingInscriptionCanvas(w_half, h)

    # Astrolabe medallion center & clear breathing halo (zero overlap with Zone A!)
    acx, acy = 8.98, -3.72
    r_out, r_mid, r_in = 0.85, 0.74, 0.48
    astro_clear_r = r_out + 0.16

    def _curve_pts(y0, y1, offset_x, n=110, wave_amp=0.0, wave_freq=1.0, wave_phase=0.0):
        pts = []
        for k in range(n):
            f = k / float(n - 1)
            yy = y0 + (y1 - y0) * f
            w_dx = wave_amp * math.sin(2.0 * math.pi * wave_freq * f + wave_phase) * math.sin(math.pi * f)
            pts.append((wing_x_gold(yy) + offset_x + w_dx, yy))
        return pts

    def _draw_polyline_avoid_circle(canvas, pts, cx, cy, r_avoid, half_w, taper_ends=True):
        """Split a curve into clean segments outside circle (cx, cy, r_avoid) so hairlines
        never collide with the astrolabe medallion."""
        seg_cur = []
        for p in pts:
            if math.hypot(p[0] - cx, p[1] - cy) >= r_avoid:
                seg_cur.append(p)
            else:
                if len(seg_cur) >= 2:
                    canvas.polyline(seg_cur, half_w=half_w, taper_ends=taper_ends)
                seg_cur = []
        if len(seg_cur) >= 2:
            canvas.polyline(seg_cur, half_w=half_w, taper_ends=taper_ends)

    def _inboard_basis(p_prev, p_next):
        """Compute unit reading tangent (tx, ty) and unit INBOARD up-normal (nx, ny) with nx < 0."""
        dx = p_next[0] - p_prev[0]
        dy = p_next[1] - p_prev[1]
        ln = max(math.hypot(dx, dy), 1e-8)
        tx, ty = dx / ln, dy / ln
        # Choose perpendicular pointing inboard (-x_abs)
        nx, ny = -ty, tx
        if nx > 0.0:
            nx, ny = -nx, -ny
        return tx, ty, nx, ny

    # ------------------------------------------------------------------
    # ZONE A: Sweeping Curvilinear Classical Greek Epigraphy + Flowing Golden Hair-Strands
    # ------------------------------------------------------------------
    inner_rail = _curve_pts(-7.65, 7.25, 0.34, n=120)
    outer_rail = _curve_pts(-7.35, 6.85, 0.92, n=120)
    # Companion flowing gossamer golden hair-strand weaving gently along the outer rail!
    braid_hair = _curve_pts(-7.55, 7.15, 0.99, n=130, wave_amp=0.048, wave_freq=3.5, wave_phase=0.4)
    inner_wisp = _curve_pts(-7.40, 7.00, 0.27, n=130, wave_amp=0.032, wave_freq=4.0, wave_phase=1.2)

    iv.polyline(inner_rail, half_w=0.0068, taper_ends=True)
    _draw_polyline_avoid_circle(iv, outer_rail, acx, acy, astro_clear_r, half_w=0.0064, taper_ends=True)
    _draw_polyline_avoid_circle(iv, braid_hair, acx, acy, astro_clear_r, half_w=0.0040, taper_ends=True)
    iv.polyline(inner_wisp, half_w=0.0038, taper_ends=True)

    # Silky logarithmic golden hair-strand scrolls curling gracefully out of BOTH ends of the verse!
    # Bow (+Y) hair-scroll pair
    p_b0, p_b1 = inner_rail[-3], inner_rail[-1]
    tbx, tby = p_b1[0] - p_b0[0], p_b1[1] - p_b0[1]
    bln = max(math.hypot(tbx, tby), 1e-8)
    tbx, tby = tbx / bln, tby / bln
    nbx, nby = -tby, tbx  # outward (+x_abs) normal for scrolling into ivory tip
    if nbx < 0.0:
        nbx, nby = -nbx, -nby
    iv.hair_scroll(p_b1[0], p_b1[1], tbx, tby, nbx, nby, scale=0.38, turns=1.18, half_w=0.0062, steps=36)
    iv.hair_scroll(outer_rail[-1][0], outer_rail[-1][1], tbx, tby, -nbx, -nby, scale=0.26, turns=0.95, half_w=0.0048, steps=28)
    # Stern (-Y) hair-scroll pair
    p_s0, p_s1 = inner_rail[2], inner_rail[0]
    tsx, tsy = p_s1[0] - p_s0[0], p_s1[1] - p_s0[1]
    sln = max(math.hypot(tsx, tsy), 1e-8)
    tsx, tsy = tsx / sln, tsy / sln
    nsx, nsy = -tsy, tsx
    if nsx < 0.0:
        nsx, nsy = -nsx, -nsy
    iv.hair_scroll(p_s1[0], p_s1[1], tsx, tsy, nsx, nsy, scale=0.40, turns=1.18, half_w=0.0062, steps=36)
    iv.hair_scroll(outer_rail[0][0], outer_rail[0][1], tsx, tsy, -nsx, -nsy, scale=0.28, turns=0.95, half_w=0.0048, steps=28)

    # Main curved classical Greek Hermetic epigraphic verse!
    # Half 0 (Stbd Top): runs stern -> bow (-7.15 -> +6.65)
    # Half 1 (Port Top, Hero_34 foreground!): runs bow -> stern (+6.65 -> -7.15) so it reads LEFT->RIGHT!
    arc_pts = _curve_pts(-7.15, 6.65, 0.63, n=260)
    if port_handed:
        arc_pts = list(reversed(arc_pts))

    arc_s = [0.0]
    for i in range(1, len(arc_pts)):
        arc_s.append(arc_s[-1] + math.hypot(arc_pts[i][0] - arc_pts[i - 1][0], arc_pts[i][1] - arc_pts[i - 1][1]))
    total_len = arc_s[-1]

    def _sample_arc(s_val):
        s_c = max(0.0, min(total_len, s_val))
        lo, hi = 0, len(arc_s) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if arc_s[mid] <= s_c:
                lo = mid
            else:
                hi = mid
        f = (s_c - arc_s[lo]) / max(arc_s[hi] - arc_s[lo], 1e-8)
        px = arc_pts[lo][0] * (1.0 - f) + arc_pts[hi][0] * f
        py = arc_pts[lo][1] * (1.0 - f) + arc_pts[hi][1] * f
        i0 = max(0, lo - 2)
        i1 = min(len(arc_pts) - 1, hi + 2)
        tx, ty, nx, ny = _inboard_basis(arc_pts[i0], arc_pts[i1])
        return px, py, tx, ty, nx, ny

    # Authentic Classical Greek Hermetic Verse:
    # HERMES · HERALD · LOGOS · NOUS · AETHER · METIS · LIGHT · PSYCHE
    main_verse = [
        "✦", "☿", "·",
        "Ε", "Ρ", "Μ", "Η", "Σ", "·",
        "Κ", "Η", "Ρ", "Υ", "Ξ", "·",
        "Λ", "Ο", "Γ", "Ο", "Σ", "·",
        "Ν", "Ο", "Υ", "Σ", "·",
        "Α", "Ι", "Θ", "Η", "Ρ", "·",
        "Μ", "Η", "Τ", "Ι", "Σ", "·",
        "Φ", "Ω", "Σ", "·",
        "Ψ", "Υ", "Χ", "Η", "·",
        "☿", "✦",
    ]
    adv = []
    for ch in main_verse:
        if ch == "·":
            adv.append(0.22)
        elif ch == "Ι":
            adv.append(0.20)
        elif ch in ("☿", "✦", "Ω", "Ψ", "Μ", "Φ"):
            adv.append(0.38)
        else:
            adv.append(0.33)
    scale_s = (total_len - 0.44) / max(sum(adv), 1e-6)
    cur_s = 0.22
    for ch, a_w in zip(main_verse, adv):
        s_mid = cur_s + 0.5 * a_w * scale_s
        px, py, tx, ty, nx, ny = _sample_arc(s_mid)
        iv.draw_glyph_basis(ch, px, py, tx, ty, nx, ny, height=0.33, hw=0.0110)
        if ch == "·":
            # Fine radial divider tick on outer rail (skipped if inside astrolabe halo)
            ox, oy = px - nx * 0.28, py - ny * 0.28
            if math.hypot(ox - acx, oy - acy) >= astro_clear_r:
                iv.segment((px - nx * 0.24, py - ny * 0.24), (px - nx * 0.35, py - ny * 0.35), 0.0058)
        cur_s += a_w * scale_s

    # Secondary micro-epigraphy line along the forward outer mid-wing (cleanly forward of astrolabe: Y in [-2.4, +3.6])
    sub_pts = _curve_pts(-2.35, 3.65, 1.18, n=110)
    if port_handed:
        sub_pts = list(reversed(sub_pts))
    sub_verse = ["◇", "◬", "·", "Ε", "·", "Ν", "·", "Λ", "·", "☉", "·", "Φ", "·", "Ψ", "·", "Ω", "·", "⛉", "◇"]
    for idx, ch in enumerate(sub_verse):
        k = int(idx * (len(sub_pts) - 1) / float(len(sub_verse) - 1))
        px, py = sub_pts[k]
        if math.hypot(px - acx, py - acy) < astro_clear_r + 0.08:
            continue
        k0 = max(0, k - 2)
        k1 = min(len(sub_pts) - 1, k + 2)
        tx, ty, nx, ny = _inboard_basis(sub_pts[k0], sub_pts[k1])
        iv.draw_glyph_basis(ch, px, py, tx, ty, nx, ny, height=0.16, hw=0.0068)

    # ------------------------------------------------------------------
    # ZONE B: Broad Ivory Wing Shoulder Hermetic Astrolabe & Winged Caduceus Emblem
    # Centered cleanly at (8.98, -3.72) with zero overlap against Zone A!
    # ------------------------------------------------------------------
    x_flip = -1.0 if port_handed else 1.0  # Flips local emblem X on Port so X-mirror restores right-handed text!

    def _ap(lx, ly):
        return (acx + lx * x_flip, acy + ly)

    iv.arc(acx, acy, r_out, 0.0, 2.0 * math.pi, half_w=0.0080, steps=96)
    iv.arc(acx, acy, r_mid, 0.0, 2.0 * math.pi, half_w=0.0060, steps=96)
    iv.arc(acx, acy, r_in,  0.0, 2.0 * math.pi, half_w=0.0065, steps=72)
    # Offset eccentric celestial hair-orbit arcs
    iv.arc(acx - 0.12 * x_flip, acy + 0.09, 0.65, -0.45 * math.pi, 0.72 * math.pi, half_w=0.0052, steps=56)
    iv.arc(acx + 0.10 * x_flip, acy - 0.09, 0.61,  0.55 * math.pi, 1.65 * math.pi, half_w=0.0052, steps=56)

    # 36 fine radial degree tick marks + 4 cardinal diamond pointers
    for ti in range(36):
        a = 2.0 * math.pi * ti / 36.0
        is_card = (ti % 9 == 0)
        is_maj = (ti % 3 == 0)
        r0_t = r_mid if is_maj else (r_mid + 0.035)
        r1_t = (r_out + 0.10) if is_card else r_out
        iv.segment(
            (acx + r0_t * math.cos(a), acy + r0_t * math.sin(a)),
            (acx + r1_t * math.cos(a), acy + r1_t * math.sin(a)),
            0.0072 if is_card else 0.0052,
        )
        if is_card:
            dx_c, dy_c = math.cos(a), math.sin(a)
            iv.draw_glyph_basis(
                "◇", acx + (r_out + 0.155) * dx_c, acy + (r_out + 0.155) * dy_c,
                dx_c, dy_c, -dy_c, dx_c, 0.11, 0.0055,
            )

    # Center Hermes Winged Caduceus (vertical staff + twin intertwined hair-coils + 5-feather swept wings + ☿)
    iv.segment(_ap(0.0, -0.40), _ap(0.0, 0.32), 0.0085)
    for sgn in (-1.0, 1.0):
        coil = []
        for k in range(44):
            f = k / 43.0
            ly = -0.35 + f * 0.60
            amp = 0.14 * math.sin(math.pi * f) ** 0.55
            lx = sgn * amp * math.sin(2.5 * math.pi * f)
            coil.append(_ap(lx, ly))
        iv.polyline(coil, half_w=0.0066, taper_ends=True)
    # 5 graceful curved hairline wing feathers per side!
    for sgn in (-1.0, 1.0):
        for fi, (span_f, lift_f, drop_f) in enumerate([
            (0.43, 0.24,  0.06),
            (0.41, 0.17,  0.00),
            (0.36, 0.10, -0.06),
            (0.29, 0.02, -0.11),
            (0.21, -0.04, -0.15),
        ]):
            wing_f = []
            for k in range(13):
                t = k / 12.0
                # Quadratic Bezier feather curve sweeping outward and gently drooping at tip
                p0x, p0y = sgn * 0.04, 0.16 - fi * 0.036
                p1x, p1y = sgn * (span_f * 0.54), 0.19 + lift_f * 0.58 - fi * 0.012
                p2x, p2y = sgn * span_f, 0.11 + drop_f
                u_b = (1.0 - t) ** 2 * p0x + 2.0 * (1.0 - t) * t * p1x + t ** 2 * p2x
                v_b = (1.0 - t) ** 2 * p0y + 2.0 * (1.0 - t) * t * p1y + t ** 2 * p2y
                wing_f.append(_ap(u_b, v_b))
            iv.polyline(wing_f, half_w=0.0062 - fi * 0.0005, taper_end=True)

    # Crown ☿ & alchemical flanking runes (strictly non-mirrored!)
    iv.draw_glyph_basis("☿", *_ap(0.0, 0.38), x_flip, 0.0, 0.0, 1.0, height=0.18, hw=0.0072)
    iv.draw_glyph_basis("◬", *_ap(-0.32, -0.15), x_flip, 0.0, 0.0, 1.0, height=0.13, hw=0.0058)
    iv.draw_glyph_basis("⛉", *_ap(0.32, -0.15), x_flip, 0.0, 0.0, 1.0, height=0.13, hw=0.0058)

    # Perfectly spaced arched Greek micro-epigraphy inside the astrolabe ring band (R = 0.61 m)
    # Bow arc (top when nose=+Y is up): "✦ Ε Ρ Μ Η Σ ✦"
    r_text = 0.61
    top_ring_glyphs = ["✦", "Ε", "Ρ", "Μ", "Η", "Σ", "✦"]
    for k, ch in enumerate(top_ring_glyphs):
        a = math.radians(144.0 - k * (108.0 / float(len(top_ring_glyphs) - 1)))
        lx, ly = r_text * math.cos(a), r_text * math.sin(a)
        # Tangent clockwise around top arc in unflipped frame: (+sin a, -cos a); radial outward up: (+cos a, +sin a)
        tx_l, ty_l = math.sin(a) * x_flip, -math.cos(a)
        nx_l, ny_l = math.cos(a) * x_flip, math.sin(a)
        iv.draw_glyph_basis(ch, *_ap(lx, ly), tx_l, ty_l, nx_l, ny_l, height=0.135, hw=0.0060)

    # Stern arc (bottom when nose=+Y is up): "✦ Λ Ο Γ Ο Σ ✦"
    bot_ring_glyphs = ["✦", "Λ", "Ο", "Γ", "Ο", "Σ", "✦"]
    for k, ch in enumerate(bot_ring_glyphs):
        a = math.radians(216.0 + k * (108.0 / float(len(bot_ring_glyphs) - 1)))
        lx, ly = r_text * math.cos(a), r_text * math.sin(a)
        # Tangent counter-clockwise (left->right on bottom arc): (-sin a, +cos a); inward up: (-cos a, -sin a)
        tx_l, ty_l = -math.sin(a) * x_flip, math.cos(a)
        nx_l, ny_l = -math.cos(a) * x_flip, -math.sin(a)
        iv.draw_glyph_basis(ch, *_ap(lx, ly), tx_l, ty_l, nx_l, ny_l, height=0.135, hw=0.0060)

    # Flowing 3-Strand "Golden Hair" Plumes sweeping gracefully forward from the Astrolabe toward the bow tip!
    # Unmistakably evokes Hermes's windswept golden hair filaments cradling celestial rune waypoints!
    hair_plume_specs = [
        (0.52,  0.00, 0.0056, 2.2, 0.0,  -2.68, 6.75),
        (0.62,  0.09, 0.0042, 2.8, 1.1,  -2.75, 5.40),
        (0.42, -0.07, 0.0038, 3.2, 2.3,  -2.72, 4.10),
    ]
    primary_ray_pts = []
    for p_idx, (blend_hi, wave_amp, hw_p, w_freq, w_ph, y_s, y_e) in enumerate(hair_plume_specs):
        pts_h = []
        n_h = 84
        for k in range(n_h):
            f = k / float(n_h - 1)
            yy = y_s + f * (y_e - y_s)
            x_lo = wing_x_gold(yy) + 1.08
            x_hi = wing_x_out(yy) - 0.42
            base_x = x_lo * (1.0 - blend_hi) + x_hi * blend_hi
            env = math.sin(math.pi * f) ** 0.75
            wx = wave_amp * math.sin(2.0 * math.pi * w_freq * f + w_ph) * env
            px_h = max(x_lo, min(x_hi, base_x + wx))
            pts_h.append((px_h, yy))
        _draw_polyline_avoid_circle(iv, pts_h, acx, acy, astro_clear_r - 0.04, half_w=hw_p, taper_ends=True)
        if p_idx == 0:
            primary_ray_pts = pts_h

    # Subtle Hermetic rune waypoints drifting along the primary golden hair plume
    wp_list = [(0.20, "◇"), (0.38, "Α"), (0.56, "☉"), (0.74, "Ν"), (0.90, "✦")]
    for frac_wp, ch_wp in wp_list:
        idx_wp = int(frac_wp * (len(primary_ray_pts) - 1))
        px, py = primary_ray_pts[idx_wp]
        i0 = max(0, idx_wp - 2)
        i1 = min(len(primary_ray_pts) - 1, idx_wp + 2)
        p_a, p_b = (primary_ray_pts[i1], primary_ray_pts[i0]) if port_handed else (primary_ray_pts[i0], primary_ray_pts[i1])
        tx, ty, nx, ny = _inboard_basis(p_a, p_b)
        iv.draw_glyph_basis(ch_wp, px + 0.18, py, tx, ty, nx, ny, height=0.16, hw=0.0062)

    # ------------------------------------------------------------------
    # ZONE C: Matte-Obsidian Inner Wing Engraved Luminous Gold Hermetic Cartouche & Hair-Trail
    # ------------------------------------------------------------------
    def _obs_mid_pts(y0, y1, frac_x=0.52, n=72, wave_amp=0.0, wave_freq=2.0, wave_ph=0.0):
        pts = []
        for k in range(n):
            f = k / float(n - 1)
            yy = y0 + (y1 - y0) * f
            xi = wing_x_in(yy)
            xg = wing_x_gold(yy)
            wx = wave_amp * math.sin(2.0 * math.pi * wave_freq * f + wave_ph) * math.sin(math.pi * f)
            pts.append((xi + (xg - xi) * frac_x + wx, yy))
        return pts

    # Aft obsidian calligraphic cartouche with delicate tapered hair-scroll corner flourishes!
    obs_r_in  = _obs_mid_pts(-7.55, -2.55, frac_x=0.28, n=56)
    obs_r_out = _obs_mid_pts(-7.55, -2.55, frac_x=0.76, n=56)
    ob.polyline(obs_r_in,  half_w=0.0066, taper_ends=True)
    ob.polyline(obs_r_out, half_w=0.0066, taper_ends=True)
    # Companion ultra-fine flowing hair filament along the outer obsidian cartouche rail
    ob.polyline(_obs_mid_pts(-7.45, -2.65, frac_x=0.81, n=64, wave_amp=0.025, wave_freq=2.5), half_w=0.0038, taper_ends=True)
    # Refined corner end-ticks with subtle inward diamond punctuation
    for y_end in (-7.55, -2.55):
        xi, xg = wing_x_in(y_end), wing_x_gold(y_end)
        ob.segment((xi + (xg - xi) * 0.28, y_end), (xi + (xg - xi) * 0.45, y_end), 0.0064)
        ob.segment((xi + (xg - xi) * 0.59, y_end), (xi + (xg - xi) * 0.76, y_end), 0.0064)
        ob.dot(xi + (xg - xi) * 0.52, y_end, 0.016)

    aft_obs_pts = _obs_mid_pts(-7.25, -2.85, frac_x=0.52, n=100)
    if port_handed:
        aft_obs_pts = list(reversed(aft_obs_pts))
    aft_obs_glyphs = ["✦", "☿", "·", "Ε", "Ρ", "Μ", "Η", "Σ", "·", "Ν", "Ο", "Υ", "Σ", "·", "☉", "✦"]
    for idx, ch in enumerate(aft_obs_glyphs):
        k = int(idx * (len(aft_obs_pts) - 1) / float(len(aft_obs_glyphs) - 1))
        px, py = aft_obs_pts[k]
        k0 = max(0, k - 2)
        k1 = min(len(aft_obs_pts) - 1, k + 2)
        tx, ty, nx, ny = _inboard_basis(aft_obs_pts[k0], aft_obs_pts[k1])
        ob.draw_glyph_basis(ch, px, py, tx, ty, nx, ny, height=0.23, hw=0.0092)

    # Forward obsidian twin braided golden hair-strands + Hermetic runes ahead of the triangular vent!
    fwd_obs_pts = _obs_mid_pts(1.85, 6.55, frac_x=0.47, n=72)
    fwd_obs_wisp = _obs_mid_pts(2.05, 6.35, frac_x=0.51, n=72, wave_amp=0.036, wave_freq=2.5, wave_ph=0.6)
    ob.polyline(fwd_obs_pts, half_w=0.0060, taper_ends=True)
    ob.polyline(fwd_obs_wisp, half_w=0.0038, taper_ends=True)
    fwd_seq = list(reversed(fwd_obs_pts)) if port_handed else fwd_obs_pts
    fwd_obs_glyphs = [(0.12, "◬"), (0.30, "Ε"), (0.50, "☿"), (0.70, "Σ"), (0.88, "Ω")]
    for frac_f, ch in fwd_obs_glyphs:
        k = int(frac_f * (len(fwd_seq) - 1))
        px, py = fwd_seq[k]
        k0 = max(0, k - 2)
        k1 = min(len(fwd_seq) - 1, k + 2)
        tx, ty, nx, ny = _inboard_basis(fwd_seq[k0], fwd_seq[k1])
        ob.draw_glyph_basis(ch, px + 0.14, py, tx, ty, nx, ny, height=0.17, hw=0.0076)

    return iv.to_masks(), ob.to_masks()


def _render_hermes_wing_inscriptions(w_total=2048, h=3072):
    """Synthesize the 2048x3072 Dual-Half Wing Inscription Atlas:
    - Left half  (cols 0..1023,    u in [0.0, 0.5]): Half 0 (Dorsal-Stbd & Ventral-Port)
    - Right half (cols 1024..2047, u in [0.5, 1.0]): Half 1 (Dorsal-Port & Ventral-Stbd)"""
    w_half = w_total // 2
    (iv0_g, iv0_s, iv0_e), (ob0_g, ob0_s, ob0_e) = _render_hermes_wing_half(w_half, h, port_handed=False)
    (iv1_g, iv1_s, iv1_e), (ob1_g, ob1_s, ob1_e) = _render_hermes_wing_half(w_half, h, port_handed=True)
    iv_masks = (
        np.concatenate([iv0_g, iv1_g], axis=1),
        np.concatenate([iv0_s, iv1_s], axis=1),
        np.concatenate([iv0_e, iv1_e], axis=1),
    )
    ob_masks = (
        np.concatenate([ob0_g, ob1_g], axis=1),
        np.concatenate([ob0_s, ob1_s], axis=1),
        np.concatenate([ob0_e, ob1_e], axis=1),
    )
    return iv_masks, ob_masks


def generate_hermes_textures():
    """Synthesize clean Ligne-Claire 2048x2048 comic panel maps + 2048x3072 Dual-Half Wing-Space
    Gold-Hairline Hermetic Inscription maps (zero gritty noise — silky anime cel graphic finish!)."""
    res = 2048
    paper = _tileable_fbm(res, seed=117, octaves=(16, 32, 64), weights=(0.45, 0.35, 0.20))
    grain = (paper - 0.5) * 0.012

    # Set A: 2048x2048 Clean Comic Cream-Ivory Ceramic Panel Base (minimal crisp seams, zero wear clutter!)
    tone_i, seam_i, _, _ = _generate_stealth_plating(
        res, seed=503, grid_x=2, grid_y=2, sub_prob=0.25, seam_px=2, with_rivets=False
    )
    ir = np.clip(0.955 + tone_i * 0.14 - grain * 0.5, 0.0, 1.0)
    ig = np.clip(0.922 + tone_i * 0.13 - grain * 0.5, 0.0, 1.0)
    ib = np.clip(0.842 + tone_i * 0.11 - grain * 0.5, 0.0, 1.0)
    i_dark = 1.0 - seam_i * 0.14
    ivory_albedo = np.stack([ir * i_dark, ig * i_dark, ib * i_dark], axis=-1)

    ivory_rough = np.clip(0.52 + seam_i * 0.22 + grain, 0.38, 0.85)
    ivory_rough_rgb = np.stack([ivory_rough, ivory_rough, ivory_rough], axis=-1)
    ivory_height = np.clip(0.80 - seam_i * 0.22 + tone_i * 0.06, 0.0, 1.0)
    ivory_normal = _height_to_normal(ivory_height, strength=1.15)

    # Set B: 2048x2048 Clean High-Value Neutral Ligne-Claire Panel Overlay for Cel-Shaded Obsidian Hull
    # (Subtle, minimal architectural seams so fuselage facets stay silky-clean & uncluttered!)
    tone_o, seam_o, _, _ = _generate_stealth_plating(
        res, seed=709, grid_x=2, grid_y=2, sub_prob=0.14, seam_px=2, with_rivets=False
    )
    or_ = np.clip(0.97 + tone_o * 0.28 - grain * 0.4, 0.88, 1.0)
    og_ = np.clip(0.98 + tone_o * 0.28 - grain * 0.4, 0.89, 1.0)
    ob_ = np.clip(0.99 + tone_o * 0.24 - grain * 0.3, 0.90, 1.0)
    o_ink = np.clip(seam_o * 0.18, 0.0, 0.22)
    obsidian_albedo = np.stack([
        or_ * (1.0 - o_ink) + 0.10 * o_ink,
        og_ * (1.0 - o_ink) + 0.11 * o_ink,
        ob_ * (1.0 - o_ink) + 0.14 * o_ink,
    ], axis=-1)

    obsidian_rough = np.clip(0.50 + seam_o * 0.20 + grain, 0.36, 0.86)
    obsidian_rough_rgb = np.stack([obsidian_rough, obsidian_rough, obsidian_rough], axis=-1)
    obsidian_height = np.clip(0.80 - seam_o * 0.18 + tone_o * 0.05, 0.0, 1.0)
    obsidian_normal = _height_to_normal(obsidian_height, strength=1.05)

    # Set C: 1024x1024 Clean High-Value Neutral Ligne-Claire Panel Overlay for Anodized Titanium Struts & Engines
    res_m = 1024
    grain_m = grain[::2, ::2]
    tone_m, seam_m, _, _ = _generate_stealth_plating(
        res_m, seed=919, grid_x=2, grid_y=2, sub_prob=0.18, seam_px=2, with_rivets=False
    )
    mr = np.clip(0.96 + tone_m * 0.32 - grain_m * 0.4, 0.86, 1.0)
    mg = np.clip(0.97 + tone_m * 0.32 - grain_m * 0.4, 0.87, 1.0)
    mb = np.clip(0.99 + tone_m * 0.28 - grain_m * 0.3, 0.89, 1.0)
    m_ink = np.clip(seam_m * 0.26, 0.0, 0.32)
    titanium_albedo = np.stack([
        mr * (1.0 - m_ink) + 0.08 * m_ink,
        mg * (1.0 - m_ink) + 0.09 * m_ink,
        mb * (1.0 - m_ink) + 0.12 * m_ink,
    ], axis=-1)

    titanium_rough = np.clip(0.46 + seam_m * 0.26, 0.32, 0.86)
    titanium_rough_rgb = np.stack([titanium_rough, titanium_rough, titanium_rough], axis=-1)
    titanium_height = np.clip(0.80 - seam_m * 0.26 + tone_m * 0.08, 0.0, 1.0)
    titanium_normal = _height_to_normal(titanium_height, strength=1.35)

    # Set D & E: 2048x3072 Dual-Half Wing-Space Gold-Hairline Inscription Maps (Ivory & Obsidian Wings!)
    ww, wh = 2048, 3072
    (iv_gold, iv_groove, iv_etch), (ob_gold, ob_groove, ob_etch) = _render_hermes_wing_inscriptions(ww, wh)

    iy = (np.arange(wh) * 2) % res
    ix_half = (np.arange(ww // 2) * 3) % res
    ix = np.concatenate([ix_half, ix_half])

    # Ivory Wing Inscribed Maps: clean comic cream-ivory + crisp 22K comic gold + AO groove in ORM.Red!
    wi_seam = seam_i[np.ix_(iy, ix)]
    wi_alb = ivory_albedo[np.ix_(iy, ix)].copy()
    wi_rgh = ivory_rough[np.ix_(iy, ix)].copy()
    wi_hgt = ivory_height[np.ix_(iy, ix)].copy()
    gold_iv_col = np.array([0.68, 0.45, 0.11], dtype=np.float32)
    wi_alb *= (1.0 - iv_groove[..., None] * 0.36)
    wi_alb = wi_alb * (1.0 - iv_gold[..., None]) + gold_iv_col * iv_gold[..., None]
    wi_rgh = wi_rgh * (1.0 - iv_gold) + 0.22 * iv_gold + iv_groove * 0.12
    wi_met = 0.05 * (1.0 - iv_gold) + 0.94 * iv_gold
    # ORM.Red stores clean comic panel seam + micro-chiseled gold groove AO (glTF standard R=Occlusion!)
    wi_ao = np.clip(1.0 - wi_seam * 0.08 - iv_groove * 0.36, 0.45, 1.0)
    wi_orm = np.stack([wi_ao, np.clip(wi_rgh, 0.10, 0.92), np.clip(wi_met, 0.0, 1.0)], axis=-1)
    wi_hgt = np.clip(wi_hgt - iv_etch * 0.34 + iv_gold * 0.14, 0.0, 1.0)
    wi_nrm = _height_to_normal(wi_hgt, strength=2.20)

    # Obsidian Wing Inscribed Maps: clean deep stealth charcoal base for glTF + luminous spun-gold runes!
    wo_seam = seam_o[np.ix_(iy, ix)]
    wo_tone = tone_o[np.ix_(iy, ix)]
    wo_base = np.stack([
        np.clip((0.044 + wo_tone * 0.04) * (1.0 - wo_seam * 0.16), 0.02, 0.12),
        np.clip((0.050 + wo_tone * 0.05) * (1.0 - wo_seam * 0.16), 0.02, 0.14),
        np.clip((0.062 + wo_tone * 0.06) * (1.0 - wo_seam * 0.16), 0.03, 0.16),
    ], axis=-1)
    wo_rgh = obsidian_rough[np.ix_(iy, ix)].copy()
    wo_hgt = obsidian_height[np.ix_(iy, ix)].copy()
    gold_ob_col = np.array([0.94, 0.74, 0.28], dtype=np.float32)
    wo_alb = wo_base * (1.0 - ob_groove[..., None] * 0.28)
    wo_alb = wo_alb * (1.0 - ob_gold[..., None]) + gold_ob_col * ob_gold[..., None]
    wo_rgh = wo_rgh * (1.0 - ob_gold) + 0.20 * ob_gold
    wo_met = 0.24 * (1.0 - ob_gold) + 0.95 * ob_gold
    wo_ao = np.clip(1.0 - wo_seam * 0.22 - ob_groove * 0.28, 0.45, 1.0)
    wo_orm = np.stack([wo_ao, np.clip(wo_rgh, 0.10, 0.92), np.clip(wo_met, 0.0, 1.0)], axis=-1)
    wo_hgt = np.clip(wo_hgt - ob_etch * 0.30 + ob_gold * 0.14, 0.0, 1.0)
    wo_nrm = _height_to_normal(wo_hgt, strength=2.10)
    wo_emi = np.stack([ob_gold * 0.98, ob_gold * 0.75, ob_gold * 0.26], axis=-1)

    return {
        "ivory_albedo":       _save_and_pack_image("Tex_HermesIvory_Albedo",       os.path.join(TEX_DIR, "ivory_ceramic_albedo.png"),       ivory_albedo, "sRGB"),
        "ivory_rough":        _save_and_pack_image("Tex_HermesIvory_Rough",        os.path.join(TEX_DIR, "ivory_ceramic_rough.png"),        ivory_rough_rgb, "Non-Color"),
        "ivory_normal":       _save_and_pack_image("Tex_HermesIvory_Normal",       os.path.join(TEX_DIR, "ivory_ceramic_normal.png"),       ivory_normal, "Non-Color"),
        "obsidian_albedo":    _save_and_pack_image("Tex_HermesObsidian_Albedo",    os.path.join(TEX_DIR, "obsidian_stealth_albedo.png"),    obsidian_albedo, "sRGB"),
        "obsidian_rough":     _save_and_pack_image("Tex_HermesObsidian_Rough",     os.path.join(TEX_DIR, "obsidian_stealth_rough.png"),     obsidian_rough_rgb, "Non-Color"),
        "obsidian_normal":    _save_and_pack_image("Tex_HermesObsidian_Normal",    os.path.join(TEX_DIR, "obsidian_stealth_normal.png"),    obsidian_normal, "Non-Color"),
        "titanium_albedo":    _save_and_pack_image("Tex_HermesTitanium_Albedo",    os.path.join(TEX_DIR, "titanium_struct_albedo.png"),     titanium_albedo, "sRGB"),
        "titanium_rough":     _save_and_pack_image("Tex_HermesTitanium_Rough",     os.path.join(TEX_DIR, "titanium_struct_rough.png"),      titanium_rough_rgb, "Non-Color"),
        "titanium_normal":    _save_and_pack_image("Tex_HermesTitanium_Normal",    os.path.join(TEX_DIR, "titanium_struct_normal.png"),     titanium_normal, "Non-Color"),
        "wing_ivory_albedo":  _save_and_pack_image("Tex_HermesWingIvory_Albedo",   os.path.join(TEX_DIR, "wing_ivory_inscribed_albedo.png"), wi_alb, "sRGB"),
        "wing_ivory_orm":     _save_and_pack_image("Tex_HermesWingIvory_ORM",      os.path.join(TEX_DIR, "wing_ivory_inscribed_orm.png"),    wi_orm, "Non-Color"),
        "wing_ivory_normal":  _save_and_pack_image("Tex_HermesWingIvory_Normal",   os.path.join(TEX_DIR, "wing_ivory_inscribed_normal.png"), wi_nrm, "Non-Color"),
        "wing_obs_albedo":    _save_and_pack_image("Tex_HermesWingObs_Albedo",     os.path.join(TEX_DIR, "wing_obs_inscribed_albedo.png"),   wo_alb, "sRGB"),
        "wing_obs_orm":       _save_and_pack_image("Tex_HermesWingObs_ORM",        os.path.join(TEX_DIR, "wing_obs_inscribed_orm.png"),      wo_orm, "Non-Color"),
        "wing_obs_normal":    _save_and_pack_image("Tex_HermesWingObs_Normal",     os.path.join(TEX_DIR, "wing_obs_inscribed_normal.png"),   wo_nrm, "Non-Color"),
        "wing_obs_emissive":  _save_and_pack_image("Tex_HermesWingObs_Emissive",   os.path.join(TEX_DIR, "wing_obs_inscribed_emissive.png"), wo_emi, "sRGB"),
    }


# ---------------------------------------------------------------------------
# 2. Hermes V3 Ligne-Claire Comic Cel-Shaded Materials (EEVEE NPR + glTF Fallback)
# ---------------------------------------------------------------------------

def set_bsdf_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return bsdf.inputs[n]
    return None


def _build_color_ramp(nt, bands, loc):
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = loc
    cr = ramp.color_ramp
    cr.interpolation = "LINEAR"
    while len(cr.elements) > 2:
        cr.elements.remove(cr.elements[-1])
    cr.elements[0].position = bands[0][0]
    cr.elements[0].color = (*bands[0][1], 1.0)
    cr.elements[1].position = bands[-1][0]
    cr.elements[1].color = (*bands[-1][1], 1.0)
    for pos, col_rgb in bands[1:-1]:
        el = cr.elements.new(pos)
        el.color = (*col_rgb, 1.0)
    return ramp


def make_comic_cel_mat(
    name,
    cel_bands,
    albedo_img=None,
    normal_img=None,
    uv_scale=0.48,
    normal_strength=0.14,
    spec_strength=0.20,
    spec_roughness=0.18,
    spec_threshold=0.70,
    spec_color=(1.0, 0.98, 0.94),
    rim_strength=0.18,
    rim_color=(0.78, 0.84, 0.96),
    ao_strength=0.45,
    ao_distance=0.65,
    ao_tint=(0.18, 0.20, 0.26),
    gltf_base_color=None,
    gltf_metallic=0.20,
    gltf_roughness=0.52,
):
    """Dual-output Ligne-Claire Comic Cel-Shaded material:
      - EEVEE Output (target='EEVEE'): Clean 4-band stepped cel shading via Diffuse -> ShaderToRGB
        -> stepped ColorRamp, multiplied by minimal crisp comic panel art & restrained AO ink,
        plus sharp anime specular catchlights and subtle grazing Fresnel rim!
      - ALL Output (target='ALL'): Clean glTF 2.0 Principled BSDF fallback for Three.js viewer.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out_eevee = nt.nodes.new("ShaderNodeOutputMaterial")
    out_eevee.name = "Comic_EEVEE_Output"
    out_eevee.target = "EEVEE"
    out_eevee.location = (1280, 220)

    out_all = nt.nodes.new("ShaderNodeOutputMaterial")
    out_all.name = "Comic_Export_Output"
    out_all.target = "ALL"
    out_all.location = (1280, -340)

    tex_col = None
    nrm_node = None
    if albedo_img is not None or normal_img is not None:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-1080, -60)
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.location = (-860, -60)
        mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, uv_scale)
        nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])

        if albedo_img is not None:
            tex_col = nt.nodes.new("ShaderNodeTexImage")
            tex_col.location = (-560, 220)
            tex_col.image = albedo_img
            nt.links.new(mapping.outputs["Vector"], tex_col.inputs["Vector"])

        if normal_img is not None and normal_strength > 0.0:
            tex_nrm = nt.nodes.new("ShaderNodeTexImage")
            tex_nrm.location = (-600, -300)
            tex_nrm.image = normal_img
            nt.links.new(mapping.outputs["Vector"], tex_nrm.inputs["Vector"])

            nrm_node = nt.nodes.new("ShaderNodeNormalMap")
            nrm_node.location = (-320, -280)
            nrm_node.uv_map = "UVMap"
            nrm_node.inputs["Strength"].default_value = normal_strength
            nt.links.new(tex_nrm.outputs["Color"], nrm_node.inputs["Color"])

    # 1. Stepped Comic Diffuse Cel Ramp
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diff.location = (-340, 460)
    diff.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    if nrm_node is not None:
        nt.links.new(nrm_node.outputs["Normal"], diff.inputs["Normal"])

    s2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    s2rgb.location = (-120, 460)
    nt.links.new(diff.outputs["BSDF"], s2rgb.inputs["Shader"])

    rgb2bw = nt.nodes.new("ShaderNodeRGBToBW")
    rgb2bw.location = (80, 460)
    nt.links.new(s2rgb.outputs["Color"], rgb2bw.inputs["Color"])

    ramp = _build_color_ramp(nt, cel_bands, (280, 480))
    nt.links.new(rgb2bw.outputs["Val"], ramp.inputs["Fac"])
    cel_socket = ramp.outputs["Color"]

    # 2. Multiply Cel Ramp by Clean Minimal Comic Panel Overlay
    if tex_col is not None:
        mix_tex = nt.nodes.new("ShaderNodeMix")
        mix_tex.data_type = "RGBA"
        mix_tex.blend_type = "MULTIPLY"
        mix_tex.location = (560, 360)
        mix_tex.inputs["Factor"].default_value = 1.0
        nt.links.new(cel_socket, mix_tex.inputs["A"])
        nt.links.new(tex_col.outputs["Color"], mix_tex.inputs["B"])
        cel_socket = mix_tex.outputs["Result"]

    # 3. Clean Stepped Ambient Occlusion Crevice Shading
    if ao_strength > 0.0:
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.location = (80, 120)
        ao.inputs["Distance"].default_value = ao_distance

        ao_ramp = _build_color_ramp(nt, [(0.20, ao_tint), (0.52, (1.0, 1.0, 1.0))], (280, 120))
        nt.links.new(ao.outputs["AO"], ao_ramp.inputs["Fac"])

        mix_ao = nt.nodes.new("ShaderNodeMix")
        mix_ao.data_type = "RGBA"
        mix_ao.blend_type = "MULTIPLY"
        mix_ao.location = (740, 300)
        mix_ao.inputs["Factor"].default_value = ao_strength
        nt.links.new(cel_socket, mix_ao.inputs["A"])
        nt.links.new(ao_ramp.outputs["Color"], mix_ao.inputs["B"])
        cel_socket = mix_ao.outputs["Result"]

    # 4. Crisp Stepped Comic Specular Highlight Slash
    if spec_strength > 0.0:
        gloss = nt.nodes.new("ShaderNodeBsdfGlossy")
        gloss.location = (-340, -40)
        gloss.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        gloss.inputs["Roughness"].default_value = spec_roughness
        if nrm_node is not None:
            nt.links.new(nrm_node.outputs["Normal"], gloss.inputs["Normal"])

        gs2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
        gs2rgb.location = (-120, -40)
        nt.links.new(gloss.outputs["BSDF"], gs2rgb.inputs["Shader"])

        gbw = nt.nodes.new("ShaderNodeRGBToBW")
        gbw.location = (80, -40)
        nt.links.new(gs2rgb.outputs["Color"], gbw.inputs["Color"])

        sramp = _build_color_ramp(
            nt,
            [(max(0.05, spec_threshold - 0.025), (0.0, 0.0, 0.0)),
             (min(0.98, spec_threshold + 0.025), spec_color)],
            (280, -40),
        )
        nt.links.new(gbw.outputs["Val"], sramp.inputs["Fac"])

        mix_spec = nt.nodes.new("ShaderNodeMix")
        mix_spec.data_type = "RGBA"
        mix_spec.blend_type = "ADD"
        mix_spec.clamp_result = True
        mix_spec.location = (900, 260)
        mix_spec.inputs["Factor"].default_value = spec_strength
        nt.links.new(cel_socket, mix_spec.inputs["A"])
        nt.links.new(sramp.outputs["Color"], mix_spec.inputs["B"])
        cel_socket = mix_spec.outputs["Result"]

    # 5. Subtle Crisp Grazing Comic Fresnel Rim Light
    if rim_strength > 0.0:
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.location = (280, -240)
        lw.inputs["Blend"].default_value = 0.25

        rramp = _build_color_ramp(nt, [(0.64, (0.0, 0.0, 0.0)), (0.72, rim_color)], (500, -240))
        nt.links.new(lw.outputs["Facing"], rramp.inputs["Fac"])

        mix_rim = nt.nodes.new("ShaderNodeMix")
        mix_rim.data_type = "RGBA"
        mix_rim.blend_type = "ADD"
        mix_rim.clamp_result = True
        mix_rim.location = (1040, 240)
        mix_rim.inputs["Factor"].default_value = rim_strength
        nt.links.new(cel_socket, mix_rim.inputs["A"])
        nt.links.new(rramp.outputs["Color"], mix_rim.inputs["B"])
        cel_socket = mix_rim.outputs["Result"]

    emis_cel = nt.nodes.new("ShaderNodeEmission")
    emis_cel.location = (1140, 220)
    emis_cel.inputs["Strength"].default_value = 1.0
    nt.links.new(cel_socket, emis_cel.inputs["Color"])
    nt.links.new(emis_cel.outputs["Emission"], out_eevee.inputs["Surface"])

    # Clean Principled BSDF fallback for glTF / Three.js Export (target='ALL')
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (820, -340)
    base_col = gltf_base_color if gltf_base_color is not None else cel_bands[-2][1]
    set_bsdf_input(bsdf, ["Metallic"], gltf_metallic)
    set_bsdf_input(bsdf, ["Roughness"], gltf_roughness)
    if tex_col is not None:
        mix_g = nt.nodes.new("ShaderNodeMix")
        mix_g.data_type = "RGBA"
        mix_g.blend_type = "MULTIPLY"
        mix_g.location = (560, -380)
        mix_g.inputs["Factor"].default_value = 1.0
        mix_g.inputs["B"].default_value = (*base_col, 1.0)
        nt.links.new(tex_col.outputs["Color"], mix_g.inputs["A"])
        nt.links.new(mix_g.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        set_bsdf_input(bsdf, ["Base Color"], (*base_col, 1.0))
    if nrm_node is not None:
        nt.links.new(nrm_node.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out_all.inputs["Surface"])

    return mat


def make_wing_inscribed_comic_mat(
    name,
    albedo_img,
    orm_img,
    normal_img,
    base_cel_bands,
    gold_cel_bands,
    gold_mask_lo=0.18,
    gold_mask_hi=0.82,
    emissive_img=None,
    emission_strength=0.0,
    normal_strength=0.22,
    spec_strength=0.18,
    spec_roughness=0.20,
    spec_threshold=0.72,
    rim_strength=0.15,
    rim_color=(1.0, 0.95, 0.84),
    ao_strength=0.42,
    ao_tint=(0.30, 0.27, 0.24),
    color_tint=None,
):
    """Dual-output Dual-Ramp Comic Cel Shader for 2048x3072 Wing-Space Gold-Hairline Inscriptions:
      - EEVEE Output: Separates base wing armor cel bands from burnished Comic-Gold inscription cel bands
        via ORM.Blue metallic mask (keeping gold crisp & luminous in shadow!), applies micro-chiseled
        groove AO from ORM.Red, plus stepped comic specular catchlight & Fresnel rim!
      - ALL Output: glTF-native ORM Principled BSDF preserving exact gold maps & emission for Three.js.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out_eevee = nt.nodes.new("ShaderNodeOutputMaterial")
    out_eevee.name = "WingComic_EEVEE_Output"
    out_eevee.target = "EEVEE"
    out_eevee.location = (1380, 260)

    out_all = nt.nodes.new("ShaderNodeOutputMaterial")
    out_all.name = "WingComic_Export_Output"
    out_all.target = "ALL"
    out_all.location = (1380, -360)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-1040, 0)

    tex_col = nt.nodes.new("ShaderNodeTexImage")
    tex_col.location = (-660, -280)
    tex_col.image = albedo_img
    tex_col.extension = "EXTEND"
    nt.links.new(tc.outputs["UV"], tex_col.inputs["Vector"])

    tex_orm = nt.nodes.new("ShaderNodeTexImage")
    tex_orm.location = (-660, 40)
    tex_orm.image = orm_img
    tex_orm.extension = "EXTEND"
    nt.links.new(tc.outputs["UV"], tex_orm.inputs["Vector"])

    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.location = (-360, 40)
    nt.links.new(tex_orm.outputs["Color"], sep.inputs["Color"])

    tex_nrm = nt.nodes.new("ShaderNodeTexImage")
    tex_nrm.location = (-660, -560)
    tex_nrm.image = normal_img
    tex_nrm.extension = "EXTEND"
    nt.links.new(tc.outputs["UV"], tex_nrm.inputs["Vector"])

    nrm_node = nt.nodes.new("ShaderNodeNormalMap")
    nrm_node.location = (-340, -540)
    nrm_node.uv_map = "UVMap"
    nrm_node.inputs["Strength"].default_value = normal_strength
    nt.links.new(tex_nrm.outputs["Color"], nrm_node.inputs["Color"])

    # Extract clean [0, 1] gold-hairline mask from ORM.Blue (Metallic channel)
    gold_mask = nt.nodes.new("ShaderNodeMapRange")
    gold_mask.location = (-120, 140)
    gold_mask.clamp = True
    gold_mask.inputs["From Min"].default_value = gold_mask_lo
    gold_mask.inputs["From Max"].default_value = gold_mask_hi
    nt.links.new(sep.outputs["Blue"], gold_mask.inputs["Value"])

    # Scalar diffuse lighting driver (clean, normal-subtle so cel bands stay graphic!)
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diff.location = (-360, 480)
    diff.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    nt.links.new(nrm_node.outputs["Normal"], diff.inputs["Normal"])

    s2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    s2rgb.location = (-140, 480)
    nt.links.new(diff.outputs["BSDF"], s2rgb.inputs["Shader"])

    bw = nt.nodes.new("ShaderNodeRGBToBW")
    bw.location = (60, 480)
    nt.links.new(s2rgb.outputs["Color"], bw.inputs["Color"])

    ramp_base = _build_color_ramp(nt, base_cel_bands, (260, 560))
    nt.links.new(bw.outputs["Val"], ramp_base.inputs["Fac"])

    ramp_gold = _build_color_ramp(nt, gold_cel_bands, (260, 300))
    nt.links.new(bw.outputs["Val"], ramp_gold.inputs["Fac"])

    # Multiply base wing cel color by ORM.Red (subtle comic panel seam + micro-chiseled gold groove shadow!)
    comb_ao = nt.nodes.new("ShaderNodeCombineColor")
    comb_ao.location = (260, 80)
    nt.links.new(sep.outputs["Red"], comb_ao.inputs["Red"])
    nt.links.new(sep.outputs["Red"], comb_ao.inputs["Green"])
    nt.links.new(sep.outputs["Red"], comb_ao.inputs["Blue"])

    mix_groove = nt.nodes.new("ShaderNodeMix")
    mix_groove.data_type = "RGBA"
    mix_groove.blend_type = "MULTIPLY"
    mix_groove.location = (540, 520)
    mix_groove.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp_base.outputs["Color"], mix_groove.inputs["A"])
    nt.links.new(comb_ao.outputs["Color"], mix_groove.inputs["B"])

    # Composite crisp Comic-Gold Inscriptions directly over the cel-shaded wing base!
    mix_inscr = nt.nodes.new("ShaderNodeMix")
    mix_inscr.data_type = "RGBA"
    mix_inscr.blend_type = "MIX"
    mix_inscr.location = (740, 420)
    nt.links.new(gold_mask.outputs["Result"], mix_inscr.inputs["Factor"])
    nt.links.new(mix_groove.outputs["Result"], mix_inscr.inputs["A"])
    nt.links.new(ramp_gold.outputs["Color"], mix_inscr.inputs["B"])
    cel_socket = mix_inscr.outputs["Result"]

    # Restrained Ambient Occlusion crevice shading
    if ao_strength > 0.0:
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.location = (520, 140)
        ao.inputs["Distance"].default_value = 0.65

        ao_ramp = _build_color_ramp(nt, [(0.20, ao_tint), (0.52, (1.0, 1.0, 1.0))], (700, 140))
        nt.links.new(ao.outputs["AO"], ao_ramp.inputs["Fac"])

        mix_ao = nt.nodes.new("ShaderNodeMix")
        mix_ao.data_type = "RGBA"
        mix_ao.blend_type = "MULTIPLY"
        mix_ao.location = (920, 360)
        mix_ao.inputs["Factor"].default_value = ao_strength
        nt.links.new(cel_socket, mix_ao.inputs["A"])
        nt.links.new(ao_ramp.outputs["Color"], mix_ao.inputs["B"])
        cel_socket = mix_ao.outputs["Result"]

    # Crisp Stepped Comic Specular Pop
    if spec_strength > 0.0:
        gloss = nt.nodes.new("ShaderNodeBsdfGlossy")
        gloss.location = (-360, -160)
        gloss.inputs["Roughness"].default_value = spec_roughness
        nt.links.new(nrm_node.outputs["Normal"], gloss.inputs["Normal"])
        gs2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
        gs2rgb.location = (-140, -160)
        nt.links.new(gloss.outputs["BSDF"], gs2rgb.inputs["Shader"])
        gbw = nt.nodes.new("ShaderNodeRGBToBW")
        gbw.location = (60, -160)
        nt.links.new(gs2rgb.outputs["Color"], gbw.inputs["Color"])
        sramp = _build_color_ramp(
            nt,
            [(max(0.05, spec_threshold - 0.025), (0.0, 0.0, 0.0)),
             (min(0.98, spec_threshold + 0.025), (1.0, 0.98, 0.92))],
            (260, -160),
        )
        nt.links.new(gbw.outputs["Val"], sramp.inputs["Fac"])
        mix_sp = nt.nodes.new("ShaderNodeMix")
        mix_sp.data_type = "RGBA"
        mix_sp.blend_type = "ADD"
        mix_sp.clamp_result = True
        mix_sp.location = (1060, 320)
        mix_sp.inputs["Factor"].default_value = spec_strength
        nt.links.new(cel_socket, mix_sp.inputs["A"])
        nt.links.new(sramp.outputs["Color"], mix_sp.inputs["B"])
        cel_socket = mix_sp.outputs["Result"]

    # Subtle Grazing Fresnel Rim Catchlight
    if rim_strength > 0.0:
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.location = (520, -120)
        lw.inputs["Blend"].default_value = 0.25
        rramp = _build_color_ramp(nt, [(0.65, (0.0, 0.0, 0.0)), (0.73, rim_color)], (700, -120))
        nt.links.new(lw.outputs["Facing"], rramp.inputs["Fac"])
        mix_rm = nt.nodes.new("ShaderNodeMix")
        mix_rm.data_type = "RGBA"
        mix_rm.blend_type = "ADD"
        mix_rm.clamp_result = True
        mix_rm.location = (1180, 290)
        mix_rm.inputs["Factor"].default_value = rim_strength
        nt.links.new(cel_socket, mix_rm.inputs["A"])
        nt.links.new(rramp.outputs["Color"], mix_rm.inputs["B"])
        cel_socket = mix_rm.outputs["Result"]

    emis_cel = nt.nodes.new("ShaderNodeEmission")
    emis_cel.location = (1260, 260)
    emis_cel.inputs["Strength"].default_value = 1.0
    nt.links.new(cel_socket, emis_cel.inputs["Color"])
    nt.links.new(emis_cel.outputs["Emission"], out_eevee.inputs["Surface"])

    # glTF 2.0 Native ORM Principled BSDF Export Fallback (target='ALL')
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (860, -360)
    if color_tint is not None:
        mix_t = nt.nodes.new("ShaderNodeMix")
        mix_t.data_type = "RGBA"
        mix_t.blend_type = "MULTIPLY"
        mix_t.location = (480, -320)
        mix_t.inputs["Factor"].default_value = 1.0
        mix_t.inputs["B"].default_value = (*color_tint, 1.0)
        nt.links.new(tex_col.outputs["Color"], mix_t.inputs["A"])
        nt.links.new(mix_t.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(tex_col.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(nrm_node.outputs["Normal"], bsdf.inputs["Normal"])

    if emissive_img is not None and emission_strength > 0.0:
        tex_emi = nt.nodes.new("ShaderNodeTexImage")
        tex_emi.location = (-360, -760)
        tex_emi.image = emissive_img
        tex_emi.extension = "EXTEND"
        nt.links.new(tc.outputs["UV"], tex_emi.inputs["Vector"])
        emi_in = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if emi_in is not None:
            nt.links.new(tex_emi.outputs["Color"], emi_in)
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)

    nt.links.new(bsdf.outputs["BSDF"], out_all.inputs["Surface"])
    return mat


def make_solid_emissive_mat(name, base_color, emission_color, emission_strength=2.2):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (520, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (180, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    set_bsdf_input(bsdf, ["Base Color"], (*base_color, 1.0))
    set_bsdf_input(bsdf, ["Metallic"], 0.0)
    set_bsdf_input(bsdf, ["Roughness"], 0.18)
    set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
    set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    return {
        # Cream-Ivory Outer Wing Armor + Burnished Comic-Gold Hermetic Inscriptions (Gamma-Calibrated Standard Cel!)
        "wing_ivory_inscribed": make_wing_inscribed_comic_mat(
            "Mat_Hermes_WingIvoryInscribed",
            tex["wing_ivory_albedo"],
            tex["wing_ivory_orm"],
            tex["wing_ivory_normal"],
            base_cel_bands=[
                (0.00, (0.28, 0.24, 0.19)),
                (0.16, (0.28, 0.24, 0.19)),
                (0.19, (0.50, 0.45, 0.37)),
                (0.46, (0.50, 0.45, 0.37)),
                (0.49, (0.76, 0.70, 0.58)),
                (0.80, (0.76, 0.70, 0.58)),
                (0.83, (0.90, 0.85, 0.74)),
                (1.00, (0.90, 0.85, 0.74)),
            ],
            gold_cel_bands=[
                (0.00, (0.28, 0.16, 0.024)),
                (0.18, (0.28, 0.16, 0.024)),
                (0.21, (0.44, 0.27, 0.042)),
                (0.48, (0.44, 0.27, 0.042)),
                (0.51, (0.60, 0.38, 0.068)),
                (0.82, (0.60, 0.38, 0.068)),
                (0.85, (0.78, 0.54, 0.120)),
                (1.00, (0.78, 0.54, 0.120)),
            ],
            gold_mask_lo=0.18,
            gold_mask_hi=0.82,
            normal_strength=0.18,
            spec_strength=0.06,
            spec_roughness=0.22,
            spec_threshold=0.76,
            rim_strength=0.06,
            rim_color=(1.0, 0.95, 0.82),
            ao_strength=0.38,
            ao_tint=(0.30, 0.26, 0.22),
        ),
        # Dorsal Matte-Obsidian Inner Wing Armor + Luminous Comic-Gold Hermetic Runes (True Deep Stealth Ink-Black!)
        "wing_obs_inscribed_top": make_wing_inscribed_comic_mat(
            "Mat_Hermes_WingObsInscribedTop",
            tex["wing_obs_albedo"],
            tex["wing_obs_orm"],
            tex["wing_obs_normal"],
            base_cel_bands=[
                (0.00, (0.006, 0.007, 0.011)),
                (0.17, (0.006, 0.007, 0.011)),
                (0.20, (0.016, 0.019, 0.026)),
                (0.46, (0.016, 0.019, 0.026)),
                (0.49, (0.036, 0.041, 0.052)),
                (0.79, (0.036, 0.041, 0.052)),
                (0.82, (0.074, 0.082, 0.102)),
                (1.00, (0.074, 0.082, 0.102)),
            ],
            gold_cel_bands=[
                (0.00, (0.62, 0.40, 0.08)),
                (0.22, (0.62, 0.40, 0.08)),
                (0.26, (0.82, 0.58, 0.14)),
                (0.58, (0.82, 0.58, 0.14)),
                (0.62, (0.98, 0.76, 0.24)),
                (1.00, (0.98, 0.76, 0.24)),
            ],
            gold_mask_lo=0.45,
            gold_mask_hi=0.86,
            emissive_img=tex["wing_obs_emissive"],
            emission_strength=0.52,
            normal_strength=0.16,
            spec_strength=0.22,
            spec_roughness=0.16,
            spec_threshold=0.70,
            rim_strength=0.14,
            rim_color=(0.68, 0.76, 0.90),
            ao_strength=0.42,
            ao_tint=(0.08, 0.10, 0.15),
        ),
        # Ventral Midnight-Slate Obsidian Inner Wing Armor + Luminous Comic-Gold Hermetic Runes
        "wing_obs_inscribed_bot": make_wing_inscribed_comic_mat(
            "Mat_Hermes_WingObsInscribedBot",
            tex["wing_obs_albedo"],
            tex["wing_obs_orm"],
            tex["wing_obs_normal"],
            base_cel_bands=[
                (0.00, (0.006, 0.010, 0.022)),
                (0.17, (0.006, 0.010, 0.022)),
                (0.20, (0.016, 0.026, 0.048)),
                (0.46, (0.016, 0.026, 0.048)),
                (0.49, (0.036, 0.054, 0.090)),
                (0.79, (0.036, 0.054, 0.090)),
                (0.82, (0.074, 0.102, 0.156)),
                (1.00, (0.074, 0.102, 0.156)),
            ],
            gold_cel_bands=[
                (0.00, (0.60, 0.40, 0.10)),
                (0.24, (0.60, 0.40, 0.10)),
                (0.28, (0.80, 0.56, 0.14)),
                (0.60, (0.80, 0.56, 0.14)),
                (0.64, (0.96, 0.74, 0.24)),
                (1.00, (0.96, 0.74, 0.24)),
            ],
            gold_mask_lo=0.45,
            gold_mask_hi=0.86,
            emissive_img=tex["wing_obs_emissive"],
            emission_strength=0.44,
            normal_strength=0.16,
            spec_strength=0.16,
            spec_roughness=0.20,
            spec_threshold=0.72,
            rim_strength=0.12,
            rim_color=(0.64, 0.76, 0.94),
            ao_strength=0.40,
            ao_tint=(0.08, 0.12, 0.22),
            color_tint=(0.86, 0.96, 1.24),
        ),
        # Clean Comic Cream-Ivory Base (fallback)
        "ivory_ceramic": make_comic_cel_mat(
            "Mat_Hermes_IvoryCeramic",
            cel_bands=[
                (0.00, (0.28, 0.24, 0.19)),
                (0.18, (0.28, 0.24, 0.19)),
                (0.21, (0.50, 0.45, 0.37)),
                (0.47, (0.50, 0.45, 0.37)),
                (0.50, (0.76, 0.70, 0.58)),
                (0.80, (0.76, 0.70, 0.58)),
                (0.83, (0.90, 0.85, 0.74)),
                (1.00, (0.90, 0.85, 0.74)),
            ],
            albedo_img=tex["ivory_albedo"],
            normal_img=tex["ivory_normal"],
            uv_scale=0.38,
            normal_strength=0.10,
            spec_strength=0.08,
            rim_strength=0.08,
            rim_color=(1.0, 0.96, 0.88),
            gltf_base_color=(0.86, 0.81, 0.70),
            gltf_metallic=0.05,
            gltf_roughness=0.52,
        ),
        # Central Fuselage Matte-Obsidian Stealth Armor (Rich Sleek Charcoal-Black Comic Facets!)
        "obsidian_armor": make_comic_cel_mat(
            "Mat_Hermes_ObsidianArmor",
            cel_bands=[
                (0.00, (0.006, 0.007, 0.011)),
                (0.17, (0.006, 0.007, 0.011)),
                (0.20, (0.016, 0.019, 0.026)),
                (0.46, (0.016, 0.019, 0.026)),
                (0.49, (0.036, 0.041, 0.052)),
                (0.78, (0.036, 0.041, 0.052)),
                (0.81, (0.076, 0.084, 0.104)),
                (1.00, (0.076, 0.084, 0.104)),
            ],
            albedo_img=tex["obsidian_albedo"],
            normal_img=tex["obsidian_normal"],
            uv_scale=0.44,
            normal_strength=0.10,
            spec_strength=0.22,
            spec_roughness=0.15,
            spec_threshold=0.68,
            spec_color=(0.90, 0.93, 1.0),
            rim_strength=0.16,
            rim_color=(0.68, 0.76, 0.92),
            ao_strength=0.44,
            ao_distance=0.68,
            ao_tint=(0.06, 0.08, 0.12),
            gltf_base_color=(0.052, 0.058, 0.074),
            gltf_metallic=0.26,
            gltf_roughness=0.50,
        ),
        # Ventral Keel & Belly Midnight-Slate Obsidian (Rich Deep Midnight-Navy Underbody!)
        "obsidian_ventral": make_comic_cel_mat(
            "Mat_Hermes_ObsidianVentral",
            cel_bands=[
                (0.00, (0.006, 0.010, 0.022)),
                (0.17, (0.006, 0.010, 0.022)),
                (0.20, (0.016, 0.026, 0.048)),
                (0.46, (0.016, 0.026, 0.048)),
                (0.49, (0.036, 0.054, 0.090)),
                (0.78, (0.036, 0.054, 0.090)),
                (0.81, (0.076, 0.104, 0.160)),
                (1.00, (0.076, 0.104, 0.160)),
            ],
            albedo_img=tex["obsidian_albedo"],
            normal_img=tex["obsidian_normal"],
            uv_scale=0.48,
            normal_strength=0.10,
            spec_strength=0.16,
            spec_roughness=0.18,
            spec_threshold=0.72,
            rim_strength=0.14,
            rim_color=(0.64, 0.76, 0.94),
            ao_strength=0.42,
            ao_tint=(0.06, 0.10, 0.18),
            gltf_base_color=(0.048, 0.070, 0.114),
            gltf_metallic=0.24,
            gltf_roughness=0.54,
        ),
        # Dorsal Canopy Core, Vent Bezels & Trailing Cowlings (Deep Velvet Ink-Obsidian)
        "obsidian_dark": make_comic_cel_mat(
            "Mat_Hermes_ObsidianDark",
            cel_bands=[
                (0.00, (0.004, 0.005, 0.008)),
                (0.18, (0.004, 0.005, 0.008)),
                (0.21, (0.011, 0.013, 0.018)),
                (0.48, (0.011, 0.013, 0.018)),
                (0.51, (0.024, 0.028, 0.036)),
                (0.80, (0.024, 0.028, 0.036)),
                (0.83, (0.052, 0.058, 0.072)),
                (1.00, (0.052, 0.058, 0.072)),
            ],
            albedo_img=tex["obsidian_albedo"],
            normal_img=tex["obsidian_normal"],
            uv_scale=0.54,
            normal_strength=0.08,
            spec_strength=0.24,
            spec_roughness=0.14,
            spec_threshold=0.66,
            rim_strength=0.16,
            rim_color=(0.72, 0.80, 0.94),
            ao_strength=0.42,
            ao_tint=(0.05, 0.06, 0.10),
            gltf_base_color=(0.032, 0.038, 0.048),
            gltf_metallic=0.30,
            gltf_roughness=0.46,
        ),
        # Fluted Struts & Thruster Chamber Barrels (Sleek Dark Anime Gunmetal-Titanium)
        "titanium_struct": make_comic_cel_mat(
            "Mat_Hermes_TitaniumStruct",
            cel_bands=[
                (0.00, (0.018, 0.022, 0.030)),
                (0.18, (0.018, 0.022, 0.030)),
                (0.21, (0.046, 0.054, 0.068)),
                (0.48, (0.046, 0.054, 0.068)),
                (0.51, (0.098, 0.112, 0.136)),
                (0.80, (0.098, 0.112, 0.136)),
                (0.83, (0.195, 0.218, 0.260)),
                (1.00, (0.195, 0.218, 0.260)),
            ],
            albedo_img=tex["titanium_albedo"],
            normal_img=tex["titanium_normal"],
            uv_scale=0.68,
            normal_strength=0.12,
            spec_strength=0.24,
            spec_roughness=0.17,
            spec_threshold=0.68,
            rim_strength=0.16,
            rim_color=(0.74, 0.84, 0.98),
            ao_strength=0.48,
            ao_distance=0.55,
            ao_tint=(0.08, 0.10, 0.15),
            gltf_base_color=(0.105, 0.120, 0.148),
            gltf_metallic=0.44,
            gltf_roughness=0.44,
        ),
        # Blued-Steel Tapered Vector Exhaust Nozzles (Sleek Anime Blued-Steel Cel!)
        "steel_nozzle": make_comic_cel_mat(
            "Mat_Hermes_SteelNozzle",
            cel_bands=[
                (0.00, (0.016, 0.024, 0.042)),
                (0.20, (0.016, 0.024, 0.042)),
                (0.23, (0.048, 0.066, 0.102)),
                (0.52, (0.048, 0.066, 0.102)),
                (0.55, (0.115, 0.148, 0.212)),
                (0.82, (0.115, 0.148, 0.212)),
                (0.85, (0.265, 0.320, 0.430)),
                (1.00, (0.265, 0.320, 0.430)),
            ],
            spec_strength=0.32,
            spec_roughness=0.14,
            spec_threshold=0.64,
            rim_strength=0.20,
            rim_color=(0.74, 0.86, 1.0),
            ao_strength=0.42,
            gltf_base_color=(0.115, 0.148, 0.210),
            gltf_metallic=0.54,
            gltf_roughness=0.38,
        ),
        # Signature Satin Champagne-Gold Accent Ribbon & Outer Wing Blade Edge (Rich Burnished Comic Gold!)
        "champagne_gold": make_comic_cel_mat(
            "Mat_Hermes_ChampagneGold",
            cel_bands=[
                (0.00, (0.18, 0.10, 0.020)),
                (0.18, (0.18, 0.10, 0.020)),
                (0.21, (0.40, 0.25, 0.055)),
                (0.48, (0.40, 0.25, 0.055)),
                (0.51, (0.68, 0.48, 0.145)),
                (0.80, (0.68, 0.48, 0.145)),
                (0.83, (0.94, 0.76, 0.340)),
                (1.00, (0.94, 0.76, 0.340)),
            ],
            spec_strength=0.30,
            spec_roughness=0.14,
            spec_threshold=0.64,
            spec_color=(1.0, 0.95, 0.78),
            rim_strength=0.18,
            rim_color=(1.0, 0.90, 0.62),
            ao_strength=0.34,
            ao_tint=(0.24, 0.16, 0.06),
            gltf_base_color=(0.70, 0.50, 0.18),
            gltf_metallic=0.60,
            gltf_roughness=0.32,
        ),
        # Warm Copper-Bronze Turbine Compressor Manifolds (Vivid Anime Copper Cel!)
        "copper_turbine": make_comic_cel_mat(
            "Mat_Hermes_CopperTurbine",
            cel_bands=[
                (0.00, (0.16, 0.045, 0.010)),
                (0.20, (0.16, 0.045, 0.010)),
                (0.23, (0.38, 0.125, 0.028)),
                (0.50, (0.38, 0.125, 0.028)),
                (0.53, (0.68, 0.280, 0.072)),
                (0.80, (0.68, 0.280, 0.072)),
                (0.83, (0.96, 0.540, 0.200)),
                (1.00, (0.96, 0.540, 0.200)),
            ],
            spec_strength=0.32,
            spec_roughness=0.15,
            spec_threshold=0.64,
            spec_color=(1.0, 0.86, 0.66),
            rim_strength=0.18,
            rim_color=(1.0, 0.74, 0.46),
            ao_strength=0.38,
            gltf_base_color=(0.66, 0.28, 0.08),
            gltf_metallic=0.58,
            gltf_roughness=0.34,
        ),
        # Dark Anodized Louver Slats & Nozzle Petals (Clean Crisp Dark Cel — No LineArt needed!)
        "louver_metal": make_comic_cel_mat(
            "Mat_Hermes_LouverMetal",
            cel_bands=[
                (0.00, (0.006, 0.008, 0.012)),
                (0.24, (0.006, 0.008, 0.012)),
                (0.28, (0.020, 0.024, 0.032)),
                (0.64, (0.020, 0.024, 0.032)),
                (0.68, (0.056, 0.064, 0.080)),
                (1.00, (0.056, 0.064, 0.080)),
            ],
            spec_strength=0.16,
            spec_roughness=0.22,
            spec_threshold=0.72,
            rim_strength=0.08,
            ao_strength=0.46,
            gltf_base_color=(0.028, 0.034, 0.044),
            gltf_metallic=0.42,
            gltf_roughness=0.48,
        ),
        # Deep Pitch-Dark Shadow Cavities, Aft Hollow Wing Bays & Intake Throats
        "cavity_dark": make_comic_cel_mat(
            "Mat_Hermes_CavityDark",
            cel_bands=[
                (0.00, (0.005, 0.006, 0.009)),
                (0.70, (0.005, 0.006, 0.009)),
                (0.75, (0.016, 0.018, 0.024)),
                (1.00, (0.016, 0.018, 0.024)),
            ],
            spec_strength=0.0,
            rim_strength=0.0,
            ao_strength=0.0,
            gltf_base_color=(0.008, 0.010, 0.014),
            gltf_metallic=0.10,
            gltf_roughness=0.80,
        ),
        # Vivid Anime Warm-Gold Illuminated Fuselage Waist Seam Strip
        "gold_emissive": make_solid_emissive_mat(
            "Mat_Hermes_GoldEmissive",
            base_color=(1.0, 0.76, 0.24),
            emission_color=(1.0, 0.66, 0.14),
            emission_strength=2.6,
        ),
        # Subtle Deep Amber Internal Thruster Ember
        "thruster_ember": make_solid_emissive_mat(
            "Mat_Hermes_ThrusterEmber",
            base_color=(1.0, 0.46, 0.08),
            emission_color=(1.0, 0.36, 0.05),
            emission_strength=1.8,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Spline / Interpolation, Mirroring & Hard-Surface BMesh Helpers
# ---------------------------------------------------------------------------

def interp_pw_smooth(t, knots):
    """Smooth monotone-preserving cubic Hermite interpolation over sorted (t_i, v_i)."""
    if t <= knots[0][0]:
        return knots[0][1]
    if t >= knots[-1][0]:
        return knots[-1][1]
    n = len(knots)
    idx = 0
    for i in range(n - 1):
        if knots[i][0] <= t <= knots[i + 1][0]:
            idx = i
            break
    t0, v0 = knots[idx]
    t1, v1 = knots[idx + 1]
    dt = max(t1 - t0, 1e-8)
    s = (t - t0) / dt

    def secant(i):
        return (knots[i + 1][1] - knots[i][1]) / max(knots[i + 1][0] - knots[i][0], 1e-8)

    d = secant(idx)
    if idx == 0:
        m0 = d
    else:
        dp = secant(idx - 1)
        m0 = 0.0 if dp * d <= 0.0 else 2.0 * dp * d / (dp + d)
    if idx == n - 2:
        m1 = d
    else:
        dn = secant(idx + 1)
        m1 = 0.0 if d * dn <= 0.0 else 2.0 * d * dn / (d + dn)

    s2 = s * s
    s3 = s2 * s
    return (
        (2.0 * s3 - 3.0 * s2 + 1.0) * v0
        + (s3 - 2.0 * s2 + s) * dt * m0
        + (-2.0 * s3 + 3.0 * s2) * v1
        + (s3 - s2) * dt * m1
    )


def apply_world_box_uv(bm, tile_meters=6.0):
    uv_layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    inv = 1.0 / tile_meters
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        if az >= ax and az >= ay:
            for loop in face.loops:
                co = loop.vert.co
                loop[uv_layer].uv = (co.x * inv, co.y * inv)
        elif ax >= ay and ax >= az:
            for loop in face.loops:
                co = loop.vert.co
                loop[uv_layer].uv = (co.y * inv, co.z * inv)
        else:
            for loop in face.loops:
                co = loop.vert.co
                loop[uv_layer].uv = (co.x * inv, co.z * inv)


def apply_wing_planar_uv(bm, half_idx=0):
    """Map wing-space planar UVs 1:1 to Half 0 (u in [0, 0.5]) or Half 1 (u in [0.5, 1.0])
    of our 2048x3072 Dual-Half Gold-Hairline Inscription Atlas."""
    uv_layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    u_base = 0.5 * float(half_idx)
    for face in bm.faces:
        for loop in face.loops:
            co = loop.vert.co
            u_loc = max(0.002, min(0.998, (abs(co.x) - WING_UV_X0) / WING_UV_XW))
            u = u_base + 0.5 * u_loc
            v = (co.y - WING_UV_Y0) / WING_UV_YH
            loop[uv_layer].uv = (u, v)


def finalize_mesh(
    bm,
    name,
    mats_list,
    collection,
    bevel_offset=0.0,
    bevel_segments=2,
    smooth=True,
    sharp_angle_deg=36.0,
    parent=None,
    uv_tile_m=6.0,
    uv_mode="box",
):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel_offset > 0.0 and len(bm.edges) > 0:
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=bevel_offset,
            offset_type="OFFSET",
            segments=bevel_segments,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    if smooth and sharp_angle_deg is not None and sharp_angle_deg < 179.0:
        rad = math.radians(sharp_angle_deg)
        sharp_edges = [
            e for e in bm.edges
            if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > rad
        ]
        if sharp_edges:
            bmesh.ops.split_edges(bm, edges=sharp_edges)

    if uv_mode == "wing_planar_h0":
        apply_wing_planar_uv(bm, half_idx=0)
    elif uv_mode == "wing_planar_h1":
        apply_wing_planar_uv(bm, half_idx=1)
    else:
        apply_world_box_uv(bm, tile_meters=uv_tile_m)

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    if mats_list is not None:
        if isinstance(mats_list, (list, tuple)):
            for m in mats_list:
                if m is not None:
                    mesh.materials.append(m)
        else:
            mesh.materials.append(mats_list)

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, collection)
    if parent is not None:
        obj.parent = parent
    return obj


def mirror_stbd_to_port(stbd_objs, col, parent=None):
    """Mathematically reflect every Starboard (+X) object across X=0 with reversed face winding.
    Guarantees 100.0000% exact bilateral symmetry and identical outward normals on Port (-X)!"""
    mirrored = []
    for src in stbd_objs:
        port_name = src.name.replace("_Stbd", "_Port")
        if port_name == src.name:
            port_name = src.name + "_Port"
        bm = bmesh.new()
        bm.from_mesh(src.data)
        for v in bm.verts:
            v.co.x = -v.co.x
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        # Swap Dual-Half wing inscription UV atlas half (h0 <-> h1) so Port inscriptions read 100% forward!
        if any(m is not None and "Inscribed" in m.name for m in src.data.materials):
            uv_layer = bm.loops.layers.uv.get("UVMap")
            if uv_layer is not None:
                for face in bm.faces:
                    for loop in face.loops:
                        uv = loop[uv_layer].uv
                        uv.x = (uv.x + 0.5) % 1.0
        mesh = bpy.data.meshes.new(port_name)
        bm.to_mesh(mesh)
        bm.free()
        for p in mesh.polygons:
            p.use_smooth = True
        for m in src.data.materials:
            mesh.materials.append(m)
        dst = bpy.data.objects.new(port_name, mesh)
        link_obj(dst, col)
        if parent is not None:
            dst.parent = parent
        mirrored.append(dst)
    return mirrored


def add_lofted_sections(
    name,
    sections,
    mat,
    col,
    bevel=0.0,
    bevel_segments=1,
    cap_start=True,
    cap_end=True,
    closed_loop=False,
    smooth=True,
    sharp_angle_deg=34.0,
    parent=None,
    uv_tile_m=6.0,
):
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in sec] for sec in sections]
    n = len(rings[0])
    num_rings = len(rings)
    span = num_rings if closed_loop else num_rings - 1
    for r_idx in range(span):
        r0 = rings[r_idx]
        r1 = rings[(r_idx + 1) % num_rings]
        for i in range(n):
            ni = (i + 1) % n
            v0, v1, v2, v3 = r0[i], r0[ni], r1[ni], r1[i]
            if len({v0, v1, v2, v3}) == 4:
                try:
                    bm.faces.new((v0, v1, v2, v3))
                except ValueError:
                    pass
    if not closed_loop:
        if cap_start:
            try:
                bm.faces.new(list(reversed(rings[0])))
            except ValueError:
                pass
        if cap_end:
            try:
                bm.faces.new(rings[-1])
            except ValueError:
                pass
    return finalize_mesh(
        bm, name, mat, col,
        bevel_offset=bevel, bevel_segments=bevel_segments,
        smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent, uv_tile_m=uv_tile_m,
    )


def add_beveled_box(
    name, center, size, mat, col,
    bevel=0.02, bevel_segments=2, rot=(0.0, 0.0, 0.0),
    smooth=True, sharp_angle_deg=36.0, parent=None, uv_tile_m=6.0,
):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    if bevel > 0.0:
        b = min(bevel, min(sx, sy, sz) * 0.40)
        bmesh.ops.bevel(
            bm, geom=list(bm.edges), offset=b, offset_type="OFFSET",
            segments=bevel_segments, profile=0.5, affect="EDGES", clamp_overlap=True,
        )
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent, uv_tile_m=uv_tile_m)


def add_cylinder(
    name, center, radius, depth, mat, col,
    segments=28, rot=(0.0, 0.0, 0.0), bevel=0.010,
    radius2=None, smooth=True, sharp_angle_deg=36.0, parent=None, uv_tile_m=6.0,
):
    bm = bmesh.new()
    r2 = radius if radius2 is None else radius2
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=r2, depth=depth,
    )
    if bevel > 0.0:
        b = min(bevel, min(radius, r2) * 0.28, depth * 0.28)
        if b > 1e-4:
            bmesh.ops.bevel(
                bm, geom=list(bm.edges), offset=b, offset_type="OFFSET",
                segments=2, profile=0.5, affect="EDGES", clamp_overlap=True,
            )
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent, uv_tile_m=uv_tile_m)


def add_revolved_y(
    name, center, profile_yr, mat, col,
    segments=36, smooth=True, sharp_angle_deg=34.0, parent=None, uv_tile_m=5.0,
):
    cx, cy, cz = center
    sections = []
    for s in range(segments):
        ang = 2.0 * math.pi * s / segments
        ca, sa = math.cos(ang), math.sin(ang)
        ring = [(cx + r * ca, cy + dy, cz + r * sa) for (dy, r) in profile_yr]
        sections.append(ring)
    return add_lofted_sections(
        name, sections, mat, col,
        closed_loop=True, smooth=smooth, sharp_angle_deg=sharp_angle_deg,
        parent=parent, uv_tile_m=uv_tile_m,
    )


def add_swept_beam(
    name, path_pts, profile_uv, mat, col,
    up_hint=(0.0, 0.0, 1.0), scale_fn=None,
    cap_start=True, cap_end=True, smooth=True, sharp_angle_deg=34.0, parent=None, uv_tile_m=5.0,
):
    pts = [Vector(p) for p in path_pts]
    n_pts = len(pts)
    up_v = Vector(up_hint).normalized()
    sections = []
    for i, p in enumerate(pts):
        if i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == n_pts - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = (pts[i + 1] - pts[i - 1]).normalized()
        ref = up_v
        if abs(t.dot(ref)) > 0.96:
            ref = Vector((0.0, 1.0, 0.0))
        u_ax = t.cross(ref).normalized()
        v_ax = u_ax.cross(t).normalized()
        frac = i / float(max(n_pts - 1, 1))
        su, sv = scale_fn(frac) if scale_fn is not None else (1.0, 1.0)
        sections.append([tuple(p + u_ax * (u * su) + v_ax * (v * sv)) for (u, v) in profile_uv])
    return add_lofted_sections(
        name, sections, mat, col,
        cap_start=cap_start, cap_end=cap_end, smooth=smooth,
        sharp_angle_deg=sharp_angle_deg, parent=parent, uv_tile_m=uv_tile_m,
    )


def add_hollow_frame_y(
    name, outer_xz, inner_xz, y_back, y_front, mat, col,
    bevel=0.016, bevel_segments=1, smooth=True, parent=None,
):
    bm = bmesh.new()
    n = len(outer_xz)
    ob = [bm.verts.new((x, y_back, z)) for x, z in outer_xz]
    of = [bm.verts.new((x, y_front, z)) for x, z in outer_xz]
    ib = [bm.verts.new((x, y_back, z)) for x, z in inner_xz]
    if_ = [bm.verts.new((x, y_front, z)) for x, z in inner_xz]
    for i in range(n):
        ni = (i + 1) % n
        bm.faces.new((ob[i], ob[ni], of[ni], of[i]))
        bm.faces.new((if_[i], if_[ni], ib[ni], ib[i]))
        bm.faces.new((ob[i], ib[i], ib[ni], ob[ni]))
        bm.faces.new((of[i], of[ni], if_[ni], if_[i]))
    return finalize_mesh(
        bm, name, mat, col,
        bevel_offset=bevel, bevel_segments=bevel_segments,
        smooth=smooth, sharp_angle_deg=34.0, parent=parent,
    )


def build_grid_shell(
    name, top_grid, bot_grid, outer_mat, col,
    inner_mat=None, outer_is_top=True,
    close_u0=True, close_u1=True, close_v0=True, close_v1=True,
    smooth=True, sharp_angle_deg=36.0, parent=None, uv_tile_m=6.4, uv_mode="box",
):
    """Build a watertight thickened surface shell from two matching (nu x nv) grids.
    When `inner_mat` is provided, the exterior skin gets material 0 (`outer_mat`) while
    the cavity-facing underside & rim get material 1 (`inner_mat`) — giving pitch-dark
    stealth interiors inside the open hollow rear wing bay!"""
    nu = len(top_grid)
    nv = len(top_grid[0])
    bm = bmesh.new()
    tv = [[bm.verts.new(top_grid[i][j]) for j in range(nv)] for i in range(nu)]
    bv = [[bm.verts.new(bot_grid[i][j]) for j in range(nv)] for i in range(nu)]

    use_dual = inner_mat is not None
    top_mi = 0 if (not use_dual or outer_is_top) else 1
    bot_mi = 0 if (not use_dual or not outer_is_top) else 1
    rim_mi = 1 if use_dual else 0

    for i in range(nu - 1):
        for j in range(nv - 1):
            try:
                f = bm.faces.new((tv[i][j], tv[i + 1][j], tv[i + 1][j + 1], tv[i][j + 1]))
                f.material_index = top_mi
            except ValueError:
                pass
            try:
                f = bm.faces.new((bv[i][j], bv[i][j + 1], bv[i + 1][j + 1], bv[i + 1][j]))
                f.material_index = bot_mi
            except ValueError:
                pass

    if close_u0:
        for j in range(nv - 1):
            try:
                f = bm.faces.new((bv[0][j], tv[0][j], tv[0][j + 1], bv[0][j + 1]))
                f.material_index = rim_mi
            except ValueError:
                pass
    if close_u1:
        for j in range(nv - 1):
            try:
                f = bm.faces.new((tv[-1][j], bv[-1][j], bv[-1][j + 1], tv[-1][j + 1]))
                f.material_index = rim_mi
            except ValueError:
                pass
    if close_v0:
        for i in range(nu - 1):
            try:
                f = bm.faces.new((tv[i][0], bv[i][0], bv[i + 1][0], tv[i + 1][0]))
                f.material_index = rim_mi
            except ValueError:
                pass
    if close_v1:
        for i in range(nu - 1):
            try:
                f = bm.faces.new((bv[i][-1], tv[i][-1], tv[i + 1][-1], bv[i + 1][-1]))
                f.material_index = rim_mi
            except ValueError:
                pass

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    mats_list = [outer_mat, inner_mat] if use_dual else outer_mat
    return finalize_mesh(
        bm, name, mats_list, col,
        smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent, uv_tile_m=uv_tile_m, uv_mode=uv_mode,
    )


# ---------------------------------------------------------------------------
# 4. Exact Digitized Hermes Wing & Fuselage Parametric Curves (from 5 Orthos)
# ---------------------------------------------------------------------------

WING_IN_KNOTS = [
    (-10.00, 4.18),
    ( -8.50, 4.26),
    ( -6.50, 4.36),
    ( -4.50, 4.44),
    ( -2.00, 4.52),
    (  0.00, 4.58),
    (  2.50, 4.68),
    (  5.00, 4.80),
    (  7.50, 4.91),
    (  9.20, 4.99),
    ( 10.00, 5.08),
]

WING_GOLD_KNOTS = [
    (-10.00, 4.26),
    ( -9.50, 4.78),
    ( -8.60, 5.45),
    ( -7.40, 6.08),
    ( -6.00, 6.60),
    ( -4.60, 6.89),
    ( -3.20, 6.95),
    ( -1.80, 6.84),
    ( -0.40, 6.62),
    (  1.20, 6.33),
    (  2.80, 6.03),
    (  4.40, 5.79),
    (  6.00, 5.58),
    (  7.60, 5.41),
    (  9.00, 5.26),
    ( 10.00, 5.14),
]

WING_OUT_KNOTS = [
    (-10.00,  4.36),
    ( -9.20,  5.66),
    ( -8.35,  6.94),
    ( -7.40,  8.24),
    ( -6.40,  9.58),
    ( -5.60, 10.42),
    ( -5.00, 10.74),
    ( -4.30, 10.72),
    ( -3.40, 10.63),
    ( -2.40, 10.48),
    ( -1.20, 10.20),
    (  0.00,  9.78),
    (  1.40,  9.24),
    (  3.00,  8.60),
    (  4.80,  7.90),
    (  6.60,  7.20),
    (  8.00,  6.62),
    (  9.00,  6.08),
    (  9.65,  5.58),
    ( 10.00,  5.18),
]

# Forward & Mid outer knife edge Z (Y >= -5.00); aft of -5.00, upper & lower edges SPLIT apart
# to create the iconic open hollow triangular rear bay (Rear Ortho 19.32.29 & Side Ortho 19.32.17)!
WING_FWD_EDGE_Z_KNOTS = [
    ( -5.00, -0.16),
    ( -3.20, -0.14),
    ( -1.00, -0.10),
    (  2.00, -0.06),
    (  5.50, -0.02),
    (  8.50,  0.00),
    ( 10.00,  0.02),
]

WING_INNER_TOP_Z_KNOTS = [
    (-10.00,  0.66),
    ( -8.50,  0.90),
    ( -6.00,  1.00),
    ( -3.20,  1.04),
    ( -0.60,  1.00),
    (  2.00,  0.88),
    (  4.80,  0.70),
    (  7.20,  0.48),
    (  8.90,  0.24),
    ( 10.00,  0.05),
]

WING_INNER_BOT_Z_KNOTS = [
    (-10.00, -0.84),
    ( -8.50, -1.00),
    ( -6.00, -1.08),
    ( -3.20, -1.06),
    ( -0.60, -0.98),
    (  2.00, -0.84),
    (  4.80, -0.66),
    (  7.20, -0.45),
    (  8.90, -0.22),
    ( 10.00, -0.03),
]

WING_REAR_Y_OF_X_KNOTS = [
    ( 4.18, -10.00),
    ( 4.36, -10.00),
    ( 5.66,  -9.20),
    ( 6.94,  -8.35),
    ( 8.24,  -7.40),
    ( 9.58,  -6.40),
    (10.42,  -5.60),
    (10.74,  -5.00),
]


def wing_x_in(y):
    return interp_pw_smooth(y, WING_IN_KNOTS)


def wing_x_gold(y):
    return interp_pw_smooth(y, WING_GOLD_KNOTS)


def wing_x_out(y):
    return interp_pw_smooth(y, WING_OUT_KNOTS)


def wing_outer_edge_z(y, is_top=True):
    """Outer edge height Z(Y): single razor knife-edge for Y >= -5.0, then cleanly splits
    into upper roof (+0.62 at Y=-10) and lower floor (-0.82 at Y=-10) over the hollow rear bay!"""
    if y >= -5.00:
        return interp_pw_smooth(y, WING_FWD_EDGE_Z_KNOTS)
    aft_f = max(0.0, min(1.0, (-5.00 - y) / 5.00))
    if is_top:
        return -0.16 + 0.78 * (aft_f ** 0.86)
    return -0.16 - 0.66 * (aft_f ** 0.86)


def wing_z_surface(ax, y, is_top=True):
    """Exact smooth 3D airfoil height Z(abs_x, y) for dorsal (is_top=True) and ventral (is_top=False) wing skins."""
    xi = wing_x_in(y)
    xo = wing_x_out(y)
    xg = wing_x_gold(y)
    ze = wing_outer_edge_z(y, is_top=is_top)
    z_in = interp_pw_smooth(y, WING_INNER_TOP_Z_KNOTS if is_top else WING_INNER_BOT_Z_KNOTS)

    span = max(xo - xi, 0.08)
    s = max(0.0, min(1.0, (ax - xi) / span))
    sg = max(0.05, min(0.95, (xg - xi) / span))
    z_sign = 1.0 if is_top else -1.0

    # Slight smooth aerospace crown across the obsidian shoulder -> gold ridge -> razor outer edge
    z_gold = ze + (z_in - ze) * (1.0 - 0.36 * sg)
    tip_fade = 1.0 - max(0.0, (y - 6.0) / 4.5)
    aft_fade = 1.0 - max(0.0, (-6.2 - y) / 4.2)
    bump_amp = 0.055 * tip_fade * aft_fade

    if s <= sg:
        u = s / sg
        return z_in * (1.0 - u) + z_gold * u + z_sign * bump_amp * math.sin(math.pi * u)
    u = (s - sg) / max(1.0 - sg, 1e-5)
    # Taut slightly convex outer ivory wing taper
    w_lin = (1.0 - u) ** 0.92
    return z_gold * w_lin + ze * (1.0 - w_lin)


# Central Fuselage planform curves (matches Top, Bottom, Front, Side & Rear Orthos!)
FUS_WIDTH_KNOTS = [
    (-9.10, 0.78),
    (-7.80, 1.02),
    (-6.00, 1.34),
    (-4.00, 1.68),
    (-2.00, 2.04),
    (-0.55, 2.28),
    ( 0.25, 2.22),
    ( 2.00, 1.90),
    ( 4.00, 1.50),
    ( 6.00, 1.06),
    ( 7.60, 0.68),
    ( 8.65, 0.42),
    ( 9.15, 0.28),
]

FUS_KEEL_Z_KNOTS = [
    (-9.10, -0.58),
    (-7.20, -0.90),
    (-4.50, -1.22),
    (-1.80, -1.40),
    (-0.40, -1.42),
    ( 1.80, -1.30),
    ( 4.20, -1.04),
    ( 6.50, -0.74),
    ( 8.20, -0.46),
    ( 9.15, -0.24),
]

FUS_CHINE_Z_KNOTS = [
    (-9.10,  0.14),
    (-6.50,  0.12),
    (-3.00,  0.08),
    (-0.55,  0.06),
    ( 2.50,  0.02),
    ( 5.50, -0.04),
    ( 7.80, -0.08),
    ( 9.15, -0.10),
]

FUS_DECK_Z_KNOTS = [
    (-9.10,  0.54),
    (-6.80,  0.74),
    (-3.50,  0.96),
    (-0.60,  1.06),
    ( 2.20,  0.96),
    ( 5.00,  0.72),
    ( 7.20,  0.46),
    ( 8.55,  0.24),
    ( 9.15,  0.06),
]

FUS_SPINE_Z_KNOTS = [
    (-9.05,  0.60),
    (-6.80,  0.86),
    (-4.20,  1.20),
    (-2.00,  1.52),
    (-0.40,  1.62),  # Sleek continuous faceted canopy crest!
    ( 1.15,  1.56),
    ( 2.60,  1.24),
    ( 4.80,  0.86),
    ( 6.80,  0.54),
    ( 8.40,  0.26),
    ( 9.10,  0.08),
]


# ---------------------------------------------------------------------------
# 5. Collection 01: Central Stealth Faceted Fuselage & Recessed Gold Seam
# ---------------------------------------------------------------------------

def build_central_fuselage(mats, col, root):
    ys = [
        -9.10, -8.65, -7.80, -6.50, -5.00, -3.50, -2.00, -1.10,
        -0.55, -0.05,  0.80,  2.00,  3.40,  4.80,  6.20,  7.40,
         8.35,  8.85,  9.15,
    ]

    # 1A. Lower Stealth Boat-Hull / Ventral Belly (midnight-slate obsidian)
    lower_secs = []
    for y in ys:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS)
        zk = interp_pw_smooth(y, FUS_KEEL_Z_KNOTS)
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS) - 0.085
        wk = w * (0.48 if y > -5.0 else 0.56)
        w_mid = w * 0.86
        z_mid = zk * 0.36 + zc * 0.64
        w_trench = max(w - 0.075, 0.18)
        lower_secs.append([
            (-wk,       y, zk),
            ( wk,       y, zk),
            ( w_mid,    y, z_mid),
            ( w_trench, y, zc),
            ( w * 0.72, y, zc + 0.095),
            (-w * 0.72, y, zc + 0.095),
            (-w_trench, y, zc),
            (-w_mid,    y, z_mid),
        ])
    add_lofted_sections(
        "Fuselage_LowerVentralHull", lower_secs, mats["obsidian_ventral"], col,
        bevel=0.022, bevel_segments=2, sharp_angle_deg=26.0, parent=root,
    )

    # 1B. Recessed Dark Chassis Core inside the Waist Seam Trench
    core_secs = []
    for y in ys[1:-1]:
        w = max(interp_pw_smooth(y, FUS_WIDTH_KNOTS) - 0.18, 0.14)
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS)
        core_secs.append([
            (-w, y, zc - 0.12),
            ( w, y, zc - 0.12),
            ( w, y, zc + 0.09),
            (-w, y, zc + 0.09),
        ])
    add_lofted_sections(
        "Fuselage_WaistTrenchCore", core_secs, mats["cavity_dark"], col,
        bevel=0.01, sharp_angle_deg=36.0, parent=root,
    )

    # 1C. Upper Stealth Faceted Carapace (overhangs waist slit slightly so Top/Bottom Ortho stay dark obsidian!)
    upper_secs = []
    for y in ys:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS)
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS) + 0.015
        zd = interp_pw_smooth(y, FUS_DECK_Z_KNOTS)
        w_hip = w * 1.01
        w_sh = w * 0.56
        z_sh = zc * 0.25 + zd * 0.75
        w_top = max(w * 0.34, 0.16)
        upper_secs.append([
            (-w_hip,        y, zc),
            ( w_hip,        y, zc),
            ( w_hip * 0.96, y, zc + 0.12),
            ( w_sh,         y, z_sh),
            ( w_top,        y, zd),
            (-w_top,        y, zd),
            (-w_sh,         y, z_sh),
            (-w_hip * 0.96, y, zc + 0.12),
        ])
    add_lofted_sections(
        "Fuselage_UpperStealthCarapace", upper_secs, mats["obsidian_armor"], col,
        bevel=0.022, bevel_segments=2, sharp_angle_deg=24.0, parent=root,
    )

    # 1D. Sleek Continuous Sculpted Dorsal Canopy & Spine Ridge (zero staircase steps!)
    spine_ys = [
        -8.98, -7.80, -6.20, -4.40, -2.80, -1.80, -0.80,
         0.00,  0.80,  1.50,  2.30,  3.50,  5.00,  6.60,  7.85,  8.75,
    ]
    spine_secs = []
    for y in spine_ys:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS)
        zd = interp_pw_smooth(y, FUS_DECK_Z_KNOTS) - 0.10
        zs = interp_pw_smooth(y, FUS_SPINE_Z_KNOTS)
        canopy_bulge = math.exp(-((y + 0.25) / 2.55) ** 2)
        w_base = min(w * 0.54, 0.52 + 0.44 * canopy_bulge)
        w_mid  = w_base * 0.70
        w_top  = 0.16 + 0.17 * canopy_bulge
        z_mid  = zd * 0.36 + zs * 0.64
        spine_secs.append([
            (-w_base, y, zd),
            ( w_base, y, zd),
            ( w_mid,  y, z_mid),
            ( w_top,  y, zs),
            (-w_top,  y, zs),
            (-w_mid,  y, z_mid),
        ])
    add_lofted_sections(
        "Fuselage_DorsalCanopySpine", spine_secs, mats["obsidian_dark"], col,
        bevel=0.020, bevel_segments=2, sharp_angle_deg=26.0, parent=root,
    )

    # Single ultra-flush armored cockpit brow hatch (matches Top & Side Ortho cleanly!)
    hatch_secs = []
    for yy, ww, dz in [
        (-1.45, 0.30, 0.018),
        (-0.30, 0.33, 0.026),
        ( 0.95, 0.31, 0.024),
        ( 1.85, 0.24, 0.012),
    ]:
        zs = interp_pw_smooth(yy, FUS_SPINE_Z_KNOTS)
        hatch_secs.append([
            (-ww,        yy, zs - 0.04),
            ( ww,        yy, zs - 0.04),
            ( ww * 0.78, yy, zs + dz),
            (-ww * 0.78, yy, zs + dz),
        ])
    add_lofted_sections(
        "Fuselage_CanopyFlushHatch", hatch_secs, mats["obsidian_armor"], col,
        bevel=0.010, sharp_angle_deg=30.0, parent=root,
    )

    # Crisp Chisel Bow Nose Cap (matches Front, Top & Hero Views!)
    bow_secs = []
    for yy, ww, zb, zt in [
        (7.10, 0.38,  0.30, 0.49),
        (8.10, 0.31,  0.16, 0.31),
        (8.90, 0.25,  0.00, 0.14),
        (9.18, 0.22, -0.15, 0.03),
    ]:
        bow_secs.append([
            (-ww,        yy, zb),
            ( ww,        yy, zb),
            ( ww * 0.74, yy, zt),
            (-ww * 0.74, yy, zt),
        ])
    add_lofted_sections(
        "Fuselage_BowNoseChiselCap", bow_secs, mats["obsidian_dark"], col,
        bevel=0.015, sharp_angle_deg=26.0, parent=root,
    )

    # 1E. Starboard Side Details (recessed gold illumination slit, subtle gold hip bevel, shoulder plate)
    # Built cleanly on Starboard (+X) then mirrored mathematically to Port (-X)!
    stbd_fus_parts = []

    # Recessed warm-gold flank waist illumination strip (tucked cleanly inside mid-forward waist overhang;
    # glows richly in Hero 3/4 without peeking into Stern Ortho or Top/Bottom Ortho!)
    glow_path = []
    for y in [-2.60, -1.60, -0.55, 0.40, 1.60, 2.80, 3.80]:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS) - 0.095
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS) - 0.042
        glow_path.append((w, y, zc))
    glow_prof = [(-0.020, -0.024), (0.022, -0.020), (0.022, 0.020), (-0.020, 0.024)]
    stbd_fus_parts.append(add_swept_beam(
        "Fuselage_WaistGlowStrip_Stbd", glow_path, glow_prof,
        mats["gold_emissive"], col, sharp_angle_deg=40.0, parent=root,
    ))

    # Subtle brushed champagne-gold bevel accent tucked right under the hip chine (mid-aft only!)
    gold_path = []
    for y in [-8.75, -6.80, -4.60, -2.60, -1.10, -0.55, 0.40, 2.00, 3.60]:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS) - 0.045
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS) - 0.010
        gold_path.append((w, y, zc))
    gold_prof = [(-0.022, -0.016), (0.018, -0.013), (0.020, 0.014), (-0.022, 0.016)]
    stbd_fus_parts.append(add_swept_beam(
        "Fuselage_ShoulderGoldBevel_Stbd", gold_path, gold_prof,
        mats["champagne_gold"], col, sharp_angle_deg=36.0, parent=root,
    ))

    # Upper dorsal shoulder facet plate
    ridge_secs = []
    for y in [-8.40, -6.00, -3.20, -0.80, 1.60, 4.40, 6.80]:
        w = interp_pw_smooth(y, FUS_WIDTH_KNOTS)
        zd = interp_pw_smooth(y, FUS_DECK_Z_KNOTS)
        zc = interp_pw_smooth(y, FUS_CHINE_Z_KNOTS)
        x_out = w * 0.72
        x_in  = w * 0.46
        z_lo  = zc * 0.36 + zd * 0.64
        z_hi  = zd - 0.03
        ridge_secs.append([
            (x_in,  y, z_hi - 0.09),
            (x_out, y, z_lo - 0.05),
            (x_out, y, z_lo + 0.05),
            (x_in,  y, z_hi + 0.04),
        ])
    stbd_fus_parts.append(add_lofted_sections(
        "Fuselage_DorsalShoulderPlate_Stbd", ridge_secs, mats["obsidian_armor"], col,
        bevel=0.015, sharp_angle_deg=26.0, parent=root,
    ))

    mirror_stbd_to_port(stbd_fus_parts, col, parent=root)

    # 1F. Ventral Stepped Keel Armor Plates (matches Bottom Ortho 19.32.53.png!)
    for idx, (y0, y1, w0, w1) in enumerate([
        ( 1.20,  5.60, 0.62, 0.36),
        (-5.60,  0.80, 0.56, 0.72),
    ]):
        k_secs = []
        for yy, ww in [(y0, w0), (0.5 * (y0 + y1), 0.5 * (w0 + w1)), (y1, w1)]:
            zk = interp_pw_smooth(yy, FUS_KEEL_Z_KNOTS)
            k_secs.append([
                (-ww,        yy, zk + 0.05),
                ( ww,        yy, zk + 0.05),
                ( ww * 0.88, yy, zk - 0.032),
                (-ww * 0.88, yy, zk - 0.032),
            ])
        add_lofted_sections(
            f"Fuselage_VentralKeelPlate_{idx}", k_secs, mats["obsidian_dark"], col,
            bevel=0.012, sharp_angle_deg=30.0, parent=root,
        )

    # 1G. Central Recessed Stern Impulse Thruster Housing (matches Rear Ortho 19.32.29.png!)
    out_stern = [
        (-0.82,  0.44), ( 0.82,  0.44),
        ( 1.00,  0.14), ( 0.90, -0.32),
        ( 0.66, -0.54), (-0.66, -0.54),
        (-0.90, -0.32), (-1.00,  0.14),
    ]
    in_stern = [
        (-0.62,  0.20), ( 0.62,  0.20),
        ( 0.68,  0.04), ( 0.62, -0.22),
        ( 0.48, -0.30), (-0.48, -0.30),
        (-0.62, -0.22), (-0.68,  0.04),
    ]
    add_hollow_frame_y(
        "Fuselage_SternExhaustBezel", out_stern, in_stern,
        y_back=-9.24, y_front=-8.72, mat=mats["obsidian_dark"], col=col,
        bevel=0.020, bevel_segments=2, parent=root,
    )
    add_beveled_box(
        "Fuselage_SternExhaustThroat", (0.0, -8.84, -0.05), (1.28, 0.36, 0.46),
        mats["cavity_dark"], col, bevel=0.01, parent=root,
    )
    add_beveled_box(
        "Fuselage_SternEmberCore", (0.0, -8.92, -0.05), (1.02, 0.08, 0.16),
        mats["thruster_ember"], col, bevel=0.008, parent=root,
    )
    for vx in (-0.42, -0.21, 0.0, 0.21, 0.42):
        add_beveled_box(
            f"Fuselage_SternVane_{vx:+.2f}", (vx, -9.06, -0.05), (0.032, 0.28, 0.42),
            mats["louver_metal"], col, bevel=0.004, parent=root,
        )
    add_beveled_box(
        "Fuselage_SternTopGoldLip", (0.0, -9.16, 0.39), (1.46, 0.14, 0.045),
        mats["champagne_gold"], col, bevel=0.010, parent=root,
    )


# ---------------------------------------------------------------------------
# 6. Collection 02: Swept Crescent Wings (Built on Starboard +X, Exact Mirror to Port -X)
# ---------------------------------------------------------------------------

def _vent_tri_outline(n_per_edge=10):
    """Return a dense CCW rounded-triangle polyline in (x > 0, y) for the Starboard wing intake vent."""
    verts = [
        Vector((4.78, -1.70)),
        Vector((6.24, -0.44)),
        Vector((4.88,  0.84)),
    ]
    r_fillet = 0.22
    pts = []
    for i in range(3):
        p_prev = verts[(i - 1) % 3]
        p_curr = verts[i]
        p_next = verts[(i + 1) % 3]
        d0 = (p_prev - p_curr).normalized()
        d1 = (p_next - p_curr).normalized()
        c_in = p_curr + d0 * r_fillet
        c_out = p_curr + d1 * r_fillet
        for k in range(n_per_edge):
            t = k / float(n_per_edge)
            q = (1.0 - t) ** 2 * c_in + 2.0 * (1.0 - t) * t * p_curr + (t ** 2) * c_out
            pts.append((q.x, q.y))
    return pts


def _ray_intersect_convex_poly(cx, cy, dx, dy, poly):
    """Intersect ray (cx, cy) + t*(dx, dy) (t > 0) with closed CCW 2D polygon `poly`."""
    best_t = None
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        ex, ey = x2 - x1, y2 - y1
        denom = dx * ey - dy * ex
        if abs(denom) < 1e-10:
            continue
        rx, ry = x1 - cx, y1 - cy
        t = (rx * ey - ry * ex) / denom
        u = (rx * dy - ry * dx) / denom
        if t > 1e-6 and -1e-4 <= u <= 1.0 + 1e-4:
            if best_t is None or t < best_t:
                best_t = t
    if best_t is None:
        return (cx + dx * 0.5, cy + dy * 0.5)
    return (cx + dx * best_t, cy + dy * best_t)


def _build_stbd_obsidian_vent_panel(is_top, mats, col, root):
    """Build Starboard mid-wing obsidian bay (Y in [-2.25, +1.30]) with exact 4-corner coverage
    matching Wing_ObsidianAft & Wing_ObsidianFwd vertex-for-vertex (ZERO corner holes, ZERO seams!)."""
    s_tag = "Top" if is_top else "Bot"
    z_sign = 1.0 if is_top else -1.0
    parts = []

    y_min, y_max = -2.25, 1.30
    cx_v, cy_v = 5.26, -0.44
    tri_dense = _vent_tri_outline(n_per_edge=12)  # 36 smooth CCW polyline verts

    # Build exact 24-vertex CCW outer boundary matching nu_obs=7 (6 segments per side!) including ALL 4 corners!
    n_side = 6
    outer_ring = []
    # Side 0: aft edge y = y_min, x from X_in -> X_gold (matches Wing_ObsidianAft front edge!)
    xi0, xg0 = wing_x_in(y_min), wing_x_gold(y_min) - 0.04
    for k in range(n_side):
        f = k / float(n_side)
        outer_ring.append((xi0 + (xg0 - xi0) * f, y_min))
    # Side 1: outer gold edge y from y_min -> y_max along X_gold(y) - 0.04
    for k in range(n_side):
        f = k / float(n_side)
        yy = y_min + (y_max - y_min) * f
        outer_ring.append((wing_x_gold(yy) - 0.04, yy))
    # Side 2: fwd edge y = y_max, x from X_gold -> X_in (matches Wing_ObsidianFwd back edge!)
    xi1, xg1 = wing_x_in(y_max), wing_x_gold(y_max) - 0.04
    for k in range(n_side):
        f = k / float(n_side)
        outer_ring.append((xg1 + (xi1 - xg1) * f, y_max))
    # Side 3: inner root edge y from y_max -> y_min along X_in(y)
    for k in range(n_side):
        f = k / float(n_side)
        yy = y_max + (y_min - y_max) * f
        outer_ring.append((wing_x_in(yy), yy))

    # Raycast each of the 24 outer vertices inward to the exact rounded-triangle perimeter (zero twist!)
    tri_pts = [
        _ray_intersect_convex_poly(cx_v, cy_v, ox - cx_v, oy - cy_v, tri_dense)
        for (ox, oy) in outer_ring
    ]
    n_ring = len(outer_ring)

    def lerp_pt(p0, p1, f):
        return (p0[0] * (1.0 - f) + p1[0] * f, p0[1] * (1.0 - f) + p1[1] * f)

    ring0 = outer_ring
    ring1 = [lerp_pt((cx_v, cy_v), p, 1.12) for p in tri_pts]
    ring05 = [lerp_pt(o_pt, r1_pt, 0.55) for (o_pt, r1_pt) in zip(ring0, ring1)]
    ring2 = tri_pts
    ring3 = [lerp_pt((cx_v, cy_v), p, 0.90) for p in tri_pts]

    bm = bmesh.new()
    v0  = [bm.verts.new((x, y, wing_z_surface(x, y, is_top))) for (x, y) in ring0]
    v05 = [bm.verts.new((x, y, wing_z_surface(x, y, is_top))) for (x, y) in ring05]
    v1  = [bm.verts.new((x, y, wing_z_surface(x, y, is_top) + z_sign * 0.004)) for (x, y) in ring1]
    v2  = [bm.verts.new((x, y, wing_z_surface(x, y, is_top) - z_sign * 0.040)) for (x, y) in ring2]
    v3  = [bm.verts.new((x, y, wing_z_surface(x, y, is_top) - z_sign * 0.36)) for (x, y) in ring3]

    for i in range(n_ring):
        ni = (i + 1) % n_ring
        if is_top:
            bm.faces.new((v0[i], v0[ni], v05[ni], v05[i]))
            bm.faces.new((v05[i], v05[ni], v1[ni], v1[i]))
            bm.faces.new((v1[i], v1[ni], v2[ni], v2[i]))
            bm.faces.new((v2[i], v2[ni], v3[ni], v3[i]))
        else:
            bm.faces.new((v0[ni], v0[i], v05[i], v05[ni]))
            bm.faces.new((v05[ni], v05[i], v1[i], v1[ni]))
            bm.faces.new((v1[ni], v1[i], v2[i], v2[ni]))
            bm.faces.new((v2[ni], v2[i], v3[i], v3[ni]))
    bm.faces.new(v3 if is_top else list(reversed(v3)))

    bm.faces.ensure_lookup_table()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    outer_avg_z = sum(f.normal.z for f in bm.faces[:n_ring]) / float(max(n_ring, 1))
    if outer_avg_z * z_sign < 0.0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)

    rad = math.radians(34.0)
    sharp_edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > rad]
    if sharp_edges:
        bmesh.ops.split_edges(bm, edges=sharp_edges)
    apply_wing_planar_uv(bm, half_idx=0 if is_top else 1)
    mesh = bpy.data.meshes.new(f"Wing_ObsidianVentBay_Stbd_{s_tag}")
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = True
    mesh.materials.append(mats["wing_obs_inscribed_top"] if is_top else mats["wing_obs_inscribed_bot"])
    vb_obj = bpy.data.objects.new(f"Wing_ObsidianVentBay_Stbd_{s_tag}", mesh)
    link_obj(vb_obj, col)
    vb_obj.parent = root
    parts.append(vb_obj)

    # Molded dark matte-obsidian perimeter bezel lip (matches Hero & Top Ortho seamlessly!)
    bm_bez = bmesh.new()
    bo_top, bi_top, bo_bot, bi_bot = [], [], [], []
    for (x, y) in tri_pts:
        x_o = cx_v + (x - cx_v) * 1.11
        y_o = cy_v + (y - cy_v) * 1.11
        x_i = cx_v + (x - cx_v) * 0.96
        y_i = cy_v + (y - cy_v) * 0.96
        zo = wing_z_surface(x_o, y_o, is_top)
        zi = wing_z_surface(x_i, y_i, is_top)
        bo_top.append(bm_bez.verts.new((x_o, y_o, zo + z_sign * 0.022)))
        bi_top.append(bm_bez.verts.new((x_i, y_i, zi + z_sign * 0.028)))
        bo_bot.append(bm_bez.verts.new((x_o, y_o, zo - z_sign * 0.05)))
        bi_bot.append(bm_bez.verts.new((x_i, y_i, zi - z_sign * 0.18)))
    for i in range(n_ring):
        ni = (i + 1) % n_ring
        bm_bez.faces.new((bo_top[i], bo_top[ni], bi_top[ni], bi_top[i]))
        bm_bez.faces.new((bi_top[i], bi_top[ni], bi_bot[ni], bi_bot[i]))
        bm_bez.faces.new((bo_bot[i], bo_top[i], bo_top[ni], bo_bot[ni]))
        bm_bez.faces.new((bo_bot[i], bo_bot[ni], bi_bot[ni], bi_bot[i]))
    parts.append(finalize_mesh(
        bm_bez, f"Wing_VentBezel_Stbd_{s_tag}", mats["obsidian_dark"], col,
        bevel_offset=0.008, bevel_segments=1, smooth=True, sharp_angle_deg=34.0, parent=root,
    ))

    # Dark cavity floor insert inside the recessed triangular pocket
    bm_cav = bmesh.new()
    vc = [
        bm_cav.verts.new((
            cx_v + (x - cx_v) * 0.93,
            cy_v + (y - cy_v) * 0.93,
            wing_z_surface(x, y, is_top) - z_sign * 0.30,
        ))
        for (x, y) in tri_pts
    ]
    vc_b = [bm_cav.verts.new((v.co.x, v.co.y, v.co.z - z_sign * 0.06)) for v in vc]
    bm_cav.faces.new(vc)
    bm_cav.faces.new(list(reversed(vc_b)))
    for i in range(n_ring):
        ni = (i + 1) % n_ring
        bm_cav.faces.new((vc[i], vc[ni], vc_b[ni], vc_b[i]))
    parts.append(finalize_mesh(
        bm_cav, f"Wing_VentCavityFloor_Stbd_{s_tag}", mats["cavity_dark"], col,
        smooth=False, parent=root,
    ))

    # 18 Ultra-Crisp Slanted Dark Radiator Louver Slats inside the Triangular Intake Vent!
    n_slats = 18
    for k in range(n_slats):
        frac = (k + 0.5) / float(n_slats)
        yy = -1.50 + frac * 2.12
        if yy <= -0.44:
            t_edge = (yy - (-1.70)) / (-0.44 - (-1.70))
            x_outer = 4.78 + t_edge * (6.24 - 4.78)
        else:
            t_edge = (0.84 - yy) / (0.84 - (-0.44))
            x_outer = 4.88 + t_edge * (6.24 - 4.88)
        x_inner = 4.78 + (yy - (-1.70)) / (0.84 - (-1.70)) * (4.88 - 4.78)
        x0 = x_inner + 0.06
        x1 = x_outer - 0.09
        if x1 - x0 < 0.14:
            continue
        xm = 0.5 * (x0 + x1)
        z0 = wing_z_surface(x0, yy, is_top) - z_sign * 0.15
        z1 = wing_z_surface(x1, yy, is_top) - z_sign * 0.15
        zm = 0.5 * (z0 + z1)
        slope_angle = math.atan2(z1 - z0, x1 - x0)
        parts.append(add_beveled_box(
            f"Wing_VentLouver_Stbd_{s_tag}_{k:02d}",
            (xm, yy, zm),
            (x1 - x0, 0.032, 0.15),
            mats["louver_metal"], col,
            bevel=0.004, bevel_segments=1,
            rot=(z_sign * 0.42, -slope_angle, 0.0),
            parent=root,
        ))

    # Dark Anodized Circular Turbo-Intake Duct tucked inside the aft corner of the vent (Hero & Front!)
    xt_duct, yt_duct = 5.10, -1.10
    zt_duct = wing_z_surface(xt_duct, yt_duct, is_top) - z_sign * 0.18
    parts.append(add_cylinder(
        f"Wing_VentTurboRing_Stbd_{s_tag}",
        (xt_duct, yt_duct, zt_duct),
        radius=0.18, depth=0.22, mat=mats["titanium_struct"], col=col,
        segments=24, rot=(math.pi * 0.42 * z_sign, 0.0, 0.12),
        bevel=0.010, radius2=0.15, parent=root,
    ))
    parts.append(add_cylinder(
        f"Wing_VentTurboCore_Stbd_{s_tag}",
        (xt_duct, yt_duct + 0.04, zt_duct + z_sign * 0.02),
        radius=0.115, depth=0.18, mat=mats["cavity_dark"], col=col,
        segments=20, rot=(math.pi * 0.42 * z_sign, 0.0, 0.12),
        bevel=0.006, parent=root,
    ))
    return parts


def build_swept_wings(mats, col, root):
    """Build complete Starboard (+X) swept wing with open hollow triangular aft bay,
    then mathematically mirror every mesh to Port (-X) for 100.0000% exact symmetry!"""
    stbd_parts = []
    ny_full = 58
    ys_full = [-10.00 + 20.00 * i / float(ny_full - 1) for i in range(ny_full)]

    # 2A. Outer Cream-Ivory Aerospace Ceramic Wing Armor (Upper & Lower Shells with dark cavity undersides!)
    nu_iv = 10
    for is_top, s_tag in ((True, "Top"), (False, "Bot")):
        top_g, bot_g = [], []
        for y in ys_full:
            xg = wing_x_gold(y) + 0.055
            xo = wing_x_out(y) - 0.035
            if xo <= xg + 0.015:
                xo = xg + 0.015
            row_t, row_b = [], []
            for j in range(nu_iv):
                frac = j / float(nu_iv - 1)
                ax = xg + (xo - xg) * frac
                z_surf = wing_z_surface(ax, y, is_top)
                # Taper shell thickness gracefully to razor blade at bow tip & outer rim
                tip_fade = max(0.24, min(1.0, (10.0 - y) / 2.2))
                aft_tip_fade = max(0.32, min(1.0, (y + 10.0) / 1.4))
                edge_fade = max(0.28, 1.0 - 0.66 * frac)
                th = 0.095 * tip_fade * aft_tip_fade * edge_fade
                if is_top:
                    row_t.append((ax, y, z_surf))
                    row_b.append((ax, y, z_surf - th))
                else:
                    row_t.append((ax, y, z_surf + th))
                    row_b.append((ax, y, z_surf))
            top_g.append(row_t)
            bot_g.append(row_b)
        stbd_parts.append(build_grid_shell(
            f"Wing_IvoryArmor_Stbd_{s_tag}", top_g, bot_g,
            outer_mat=mats["wing_ivory_inscribed"], col=col,
            inner_mat=mats["obsidian_dark"], outer_is_top=is_top,
            smooth=True, sharp_angle_deg=38.0, parent=root,
            uv_mode="wing_planar_h0" if is_top else "wing_planar_h1",
        ))

    # 2B. Curved Brushed Champagne-Gold Divider Ribbon (Dorsal & Ventral, C-curve from aft tip to bow tip!)
    for is_top, s_tag in ((True, "Top"), (False, "Bot")):
        z_sign = 1.0 if is_top else -1.0
        top_g, bot_g = [], []
        for y in ys_full:
            xg = wing_x_gold(y)
            end_taper = max(0.32, math.sin(math.pi * (y + 10.0) / 20.0) ** 0.45)
            hw = 0.130 * end_taper
            row_t, row_b = [], []
            for k, dx in enumerate((-hw, -hw * 0.45, hw * 0.45, hw)):
                ax = max(wing_x_in(y) + 0.008, min(wing_x_out(y) - 0.008, xg + dx))
                z_surf = wing_z_surface(ax, y, is_top) + z_sign * (0.012 if k in (1, 2) else 0.002)
                th = 0.085 * max(0.35, min(1.0, (y + 10.0) / 1.4))
                if is_top:
                    row_t.append((ax, y, z_surf))
                    row_b.append((ax, y, z_surf - th))
                else:
                    row_t.append((ax, y, z_surf + th))
                    row_b.append((ax, y, z_surf))
            top_g.append(row_t)
            bot_g.append(row_b)
        stbd_parts.append(build_grid_shell(
            f"Wing_GoldDividerRibbon_Stbd_{s_tag}", top_g, bot_g,
            outer_mat=mats["champagne_gold"], col=col,
            inner_mat=mats["obsidian_dark"], outer_is_top=is_top,
            smooth=True, sharp_angle_deg=34.0, parent=root,
        ))

    # 2C. Continuous Brushed Champagne-Gold Outer Leading-Edge Blade Trim (smoothly tapered at both ends!)
    edge_ys = [y for y in ys_full if -5.02 <= y <= 9.98]
    if edge_ys[-1] < 9.98:
        edge_ys.append(9.98)
    edge_path = []
    for y in edge_ys:
        ax = wing_x_out(y)
        ze = wing_outer_edge_z(y, is_top=True)
        edge_path.append((ax, y, ze))
    edge_prof = [
        (-0.10, -0.044),
        ( 0.032,  0.000),
        (-0.10,  0.044),
        (-0.16,  0.020),
        (-0.16, -0.020),
    ]
    def _outer_gold_scale(f):
        aft_taper = min(1.0, 0.35 + 0.65 * (f / 0.08)) if f < 0.08 else 1.0
        bow_taper = max(0.10, 1.0 - 0.90 * (f ** 2.4))
        s = aft_taper * bow_taper
        return (s, max(0.12, s * 0.96))

    stbd_parts.append(add_swept_beam(
        "Wing_OuterGoldBladeEdge_Stbd", edge_path, edge_prof,
        mats["champagne_gold"], col,
        scale_fn=_outer_gold_scale,
        sharp_angle_deg=34.0, parent=root,
    ))

    # 2D. Inner Matte-Obsidian Wing Carapace (3 stitched sections per face: Aft, Mid-Vent, Fwd)
    for is_top, s_tag in ((True, "Top"), (False, "Bot")):
        ys_aft = [-10.00 + (-2.25 - (-10.00)) * i / 22.0 for i in range(23)]
        ys_fwd = [1.30 + (10.00 - 1.30) * i / 22.0 for i in range(23)]
        for seg_name, seg_ys in (("Aft", ys_aft), ("Fwd", ys_fwd)):
            top_g, bot_g = [], []
            nu_obs = 7
            for y in seg_ys:
                xi = wing_x_in(y)
                xg = wing_x_gold(y) - 0.04
                if xg <= xi + 0.025:
                    xg = xi + 0.025
                row_t, row_b = [], []
                for j in range(nu_obs):
                    frac = j / float(nu_obs - 1)
                    ax = xi + (xg - xi) * frac
                    z_surf = wing_z_surface(ax, y, is_top)
                    th = 0.11 * max(0.32, min(1.0, (10.0 - y) / 2.2)) * max(0.38, min(1.0, (y + 10.0) / 1.4))
                    if is_top:
                        row_t.append((ax, y, z_surf))
                        row_b.append((ax, y, z_surf - th))
                    else:
                        row_t.append((ax, y, z_surf + th))
                        row_b.append((ax, y, z_surf))
                top_g.append(row_t)
                bot_g.append(row_b)
            stbd_parts.append(build_grid_shell(
                f"Wing_Obsidian{seg_name}_Stbd_{s_tag}", top_g, bot_g,
                outer_mat=mats["wing_obs_inscribed_top"] if is_top else mats["wing_obs_inscribed_bot"], col=col,
                inner_mat=mats["obsidian_dark"], outer_is_top=is_top,
                smooth=True, sharp_angle_deg=36.0, parent=root,
                uv_mode="wing_planar_h0" if is_top else "wing_planar_h1",
            ))

        stbd_parts.extend(_build_stbd_obsidian_vent_panel(is_top, mats, col, root))

    # 2E. Solid Wing Inner Structural Wall (seals inboard vertical wall cleanly from Y=-9.92 to Y=+9.92)
    ys_wall = [-9.88 + (9.90 - (-9.88)) * i / 36.0 for i in range(37)]
    wall_secs = []
    for y in ys_wall:
        xi = wing_x_in(y)
        zt = wing_z_surface(xi, y, True) - 0.025
        zb = wing_z_surface(xi, y, False) + 0.025
        # Keep inboard wall thin near aft open bay (0.28m) so hollow bay stays super wide!
        w_thick = 0.24 if y < -5.5 else 0.44
        x_oc = xi + w_thick
        zt_o = wing_z_surface(x_oc, y, True) - 0.04
        zb_o = wing_z_surface(x_oc, y, False) + 0.04
        wall_secs.append([
            (xi,   y, zb),
            (x_oc, y, zb_o),
            (x_oc, y, zt_o),
            (xi,   y, zt),
        ])
    stbd_parts.append(add_lofted_sections(
        "Wing_InnerRootCoreWall_Stbd", wall_secs, mats["obsidian_dark"], col,
        bevel=0.014, sharp_angle_deg=32.0, parent=root,
    ))

    # 2F. Forward Solid Structural Core Fill (ONLY forward of Y=-4.85 so aft bay stays 100% hollow & open!)
    ys_fill = [-4.85 + (9.80 - (-4.85)) * i / 22.0 for i in range(23)]
    fill_secs = []
    for y in ys_fill:
        xi = wing_x_in(y) + 0.16
        xo = wing_x_out(y) - 0.16
        if xo <= xi + 0.05:
            xo = xi + 0.05
        xm = 0.5 * (xi + xo)
        zt_i = wing_z_surface(xi, y, True) - 0.08
        zb_i = wing_z_surface(xi, y, False) + 0.08
        zt_m = wing_z_surface(xm, y, True) - 0.08
        zb_m = wing_z_surface(xm, y, False) + 0.08
        ze = wing_outer_edge_z(y, True)
        fill_secs.append([
            (xi, y, zb_i),
            (xm, y, zb_m),
            (xo, y, ze),
            (xm, y, zt_m),
            (xi, y, zt_i),
        ])
    stbd_parts.append(add_lofted_sections(
        "Wing_InternalStructuralCore_Stbd", fill_secs, mats["cavity_dark"], col,
        smooth=False, parent=root,
    ))

    # 2G. Iconic Hollow Aft Triangular Exhaust Bay & Chamfered Dark Trailing Cowling Lips (Rear & Side Orthos!)
    nx_rear = 24
    rear_xs = [4.38 + (10.74 - 4.38) * i / float(nx_rear - 1) for i in range(nx_rear)]
    for is_top, s_tag in ((True, "Top"), (False, "Bot")):
        z_sign = 1.0 if is_top else -1.0
        lip_path = []
        for ax in rear_xs:
            yr = interp_pw_smooth(ax, WING_REAR_Y_OF_X_KNOTS)
            zr = wing_outer_edge_z(yr, is_top=is_top) - z_sign * 0.025
            lip_path.append((ax, yr - 0.02, zr))
        lip_prof = [
            (-0.10, -0.052),
            ( 0.06, -0.042),
            ( 0.06,  0.042),
            (-0.10,  0.052),
        ]
        stbd_parts.append(add_swept_beam(
            f"Wing_AftBayTrailingLip_Stbd_{s_tag}", lip_path, lip_prof,
            mats["obsidian_dark"], col,
            scale_fn=lambda f: (max(0.45, 1.0 - 0.45 * f), max(0.38, 1.0 - 0.56 * f)),
            sharp_angle_deg=30.0, parent=root,
        ))

    # Recessed Pitch-Dark Angled Rear Bay Bulkhead (sits deep inside the open triangular mouth!)
    bm_bulk = bmesh.new()
    v_top, v_bot = [], []
    for ax in rear_xs:
        frac_x = (ax - 4.38) / (10.74 - 4.38)
        yr = interp_pw_smooth(ax, WING_REAR_Y_OF_X_KNOTS) + 2.85 * (1.0 - 0.85 * frac_x)
        yr = min(yr, -4.88)
        zt = wing_z_surface(ax, yr, True) - 0.07
        zb = wing_z_surface(ax, yr, False) + 0.07
        if zt < zb + 0.03:
            zm = 0.5 * (zt + zb)
            zt, zb = zm + 0.015, zm - 0.015
        v_top.append(bm_bulk.verts.new((ax, yr, zt)))
        v_bot.append(bm_bulk.verts.new((ax, yr, zb)))
    v_top_f = [bm_bulk.verts.new((v.co.x, v.co.y + 0.22, v.co.z)) for v in v_top]
    v_bot_f = [bm_bulk.verts.new((v.co.x, v.co.y + 0.22, v.co.z)) for v in v_bot]
    for i in range(nx_rear - 1):
        bm_bulk.faces.new((v_bot[i], v_bot[i + 1], v_top[i + 1], v_top[i]))
        bm_bulk.faces.new((v_top_f[i], v_top_f[i + 1], v_bot_f[i + 1], v_bot_f[i]))
        bm_bulk.faces.new((v_top[i], v_top[i + 1], v_top_f[i + 1], v_top_f[i]))
        bm_bulk.faces.new((v_bot_f[i], v_bot_f[i + 1], v_bot[i + 1], v_bot[i]))
    stbd_parts.append(finalize_mesh(
        bm_bulk, "Wing_AftBayBulkhead_Stbd", mats["cavity_dark"], col,
        smooth=False, parent=root,
    ))

    # Subtle deeply recessed dark vertical baffle ribs inside the hollow triangular rear bay
    for r_idx, ax_rib in enumerate((5.25, 6.20, 7.20, 8.20)):
        frac_x = (ax_rib - 4.38) / (10.74 - 4.38)
        yr = interp_pw_smooth(ax_rib, WING_REAR_Y_OF_X_KNOTS) + 2.55 * (1.0 - 0.80 * frac_x)
        yr = min(yr, -4.95)
        zt = wing_z_surface(ax_rib, yr, True) - 0.14
        zb = wing_z_surface(ax_rib, yr, False) + 0.14
        h_rib = max(0.18, zt - zb)
        stbd_parts.append(add_beveled_box(
            f"Wing_AftBayRib_Stbd_{r_idx}", (ax_rib, yr, 0.5 * (zt + zb)),
            (0.055, 0.52, h_rib), mats["cavity_dark"], col, bevel=0.006, parent=root,
        ))

    # Mirror ALL Starboard wing meshes mathematically to Port (-X)!
    mirror_stbd_to_port(stbd_parts, col, parent=root)


# ---------------------------------------------------------------------------
# 7. Collection 03: Twin Double-Decker Fluted Wing-Connecting Struts
# ---------------------------------------------------------------------------

def _fluted_strut_profile(width, thick, n_flutes=3):
    """Aerospace fluted girder section with recessed longitudinal channels."""
    hw = width * 0.5
    ht = thick * 0.5
    ch = 0.028
    pts = [(-hw, ht - ch), (-hw + ch, ht)]
    slot_span = width - 2.0 * ch
    step = slot_span / float(n_flutes * 2 + 1)
    for k in range(n_flutes):
        x0 = -hw + ch + (2 * k + 1) * step
        x1 = x0 + step
        pts.extend([(x0, ht), (x0 + 0.016, ht - 0.042), (x1 - 0.016, ht - 0.042), (x1, ht)])
    pts.extend([(hw - ch, ht), (hw, ht - ch), (hw, -ht + ch), (hw - ch, -ht)])
    for k in range(n_flutes - 1, -1, -1):
        x0 = -hw + ch + (2 * k + 1) * step
        x1 = x0 + step
        pts.extend([(x1, -ht), (x1 - 0.016, -ht + 0.042), (x0 + 0.016, -ht + 0.042), (x0, -ht)])
    pts.extend([(-hw + ch, -ht), (-hw, -ht + ch)])
    return pts


def build_connecting_struts(mats, col, root):
    """Build Starboard (+X) twin double-decker fluted struts, then mirror exactly to Port (-X)."""
    stbd_parts = []
    n_seg = 12

    # 3A. Aft Main Double-Decker Gently Arched Fluted Strut Assembly
    aft_upper_path, aft_lower_path = [], []
    for i in range(n_seg):
        t = i / float(n_seg - 1)
        x = 1.05 + t * (4.72 - 1.05)
        y = -4.22 + 0.14 * t - 0.22 * math.sin(math.pi * t)
        aft_upper_path.append((x, y,  0.22))
        aft_lower_path.append((x, y, -0.38))

    stbd_parts.append(add_swept_beam(
        "Strut_AftUpperGirder_Stbd", aft_upper_path,
        _fluted_strut_profile(width=1.64, thick=0.23, n_flutes=3),
        mats["titanium_struct"], col, sharp_angle_deg=28.0, parent=root,
    ))
    stbd_parts.append(add_swept_beam(
        "Strut_AftLowerGirder_Stbd", aft_lower_path,
        _fluted_strut_profile(width=1.32, thick=0.19, n_flutes=2),
        mats["titanium_struct"], col, sharp_angle_deg=28.0, parent=root,
    ))
    # Subtle dark anodized structural spine ribs inside the Aft Upper Girder channels (no bright white bars!)
    for dy_r in (-0.42, 0.0, 0.42):
        rail_pts = [(p[0], p[1] + dy_r, p[2] + 0.065) for p in aft_upper_path]
        stbd_parts.append(add_swept_beam(
            f"Strut_AftUpperRib_Stbd_{dy_r:+.2f}", rail_pts,
            [(-0.042, -0.020), (0.042, -0.020), (0.042, 0.020), (-0.042, 0.020)],
            mats["obsidian_dark"], col, sharp_angle_deg=34.0, parent=root,
        ))

    # Recessed flush root sockets for Aft Strut
    stbd_parts.append(add_beveled_box(
        "Strut_AftFusCollar_Stbd", (1.42, -4.20, -0.08), (0.48, 1.88, 0.88),
        mats["obsidian_dark"], col, bevel=0.028, parent=root,
    ))
    stbd_parts.append(add_beveled_box(
        "Strut_AftWingCollar_Stbd", (4.54, -4.10, -0.08), (0.44, 1.86, 0.92),
        mats["obsidian_dark"], col, bevel=0.028, parent=root,
    ))

    # 3B. Forward Diagonal Aft-Swept Double-Decker Strut Assembly!
    fwd_upper_path, fwd_lower_path = [], []
    for i in range(n_seg):
        t = i / float(n_seg - 1)
        x = 1.65 + t * (4.72 - 1.65)
        y = 0.46 + t * (-1.46 - 0.46)
        fwd_upper_path.append((x, y,  0.19))
        fwd_lower_path.append((x, y, -0.34))

    stbd_parts.append(add_swept_beam(
        "Strut_FwdUpperGirder_Stbd", fwd_upper_path,
        _fluted_strut_profile(width=0.78, thick=0.18, n_flutes=2),
        mats["titanium_struct"], col, sharp_angle_deg=28.0, parent=root,
    ))
    stbd_parts.append(add_swept_beam(
        "Strut_FwdLowerGirder_Stbd", fwd_lower_path,
        _fluted_strut_profile(width=0.68, thick=0.16, n_flutes=2),
        mats["titanium_struct"], col, sharp_angle_deg=28.0, parent=root,
    ))
    for dy_r in (-0.20, 0.20):
        rail_pts = [(p[0], p[1] + dy_r, p[2] + 0.045) for p in fwd_upper_path]
        stbd_parts.append(add_swept_beam(
            f"Strut_FwdUpperRib_Stbd_{dy_r:+.2f}", rail_pts,
            [(-0.032, -0.018), (0.032, -0.018), (0.032, 0.018), (-0.032, 0.018)],
            mats["obsidian_dark"], col, sharp_angle_deg=34.0, parent=root,
        ))

    # Tucked flush root collars for Forward Strut (no bulky overhang beyond fuselage hip!)
    stbd_parts.append(add_beveled_box(
        "Strut_FwdFusCollar_Stbd", (1.84, 0.34, -0.08), (0.42, 0.96, 0.72),
        mats["obsidian_dark"], col, bevel=0.024, rot=(0.0, 0.0, -0.52), parent=root,
    ))
    stbd_parts.append(add_beveled_box(
        "Strut_FwdWingCollar_Stbd", (4.58, -1.36, -0.08), (0.42, 1.04, 0.82),
        mats["obsidian_dark"], col, bevel=0.024, rot=(0.0, 0.0, -0.52), parent=root,
    ))

    mirror_stbd_to_port(stbd_parts, col, parent=root)


# ---------------------------------------------------------------------------
# 8. Collection 04: Quad Stacked Cylindrical Aft Wing Thruster Pods
# ---------------------------------------------------------------------------

def build_wing_thruster_pods(mats, col, root):
    """Build Starboard (+X) stacked pair of multi-stage cylindrical aft thrusters, then mirror to Port (-X)."""
    stbd_parts = []

    # Structural mounting pylon tying both stacked engines flush into the wing inner wall
    stbd_parts.append(add_beveled_box(
        "Thruster_WingPylonMount_Stbd", (4.30, -7.25, -0.10), (0.42, 2.55, 1.32),
        mats["obsidian_dark"], col, bevel=0.022, parent=root,
    ))

    for lvl, zc in (("Upper", 0.24), ("Lower", -0.44)):
        xc = 4.00
        yc_base = -7.40
        pfx = f"Thruster_Stbd_{lvl}"

        # 4A. Forward Compressor Cap & Warm Copper-Bronze Turbo Manifold Collar (Hero View!)
        stbd_parts.append(add_cylinder(
            f"{pfx}_FwdCap", (xc, -5.88, zc), 0.24, 0.36,
            mats["titanium_struct"], col, segments=28,
            rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.012, radius2=0.30, parent=root,
        ))
        stbd_parts.append(add_cylinder(
            f"{pfx}_CopperManifold", (xc, -6.30, zc), 0.32, 0.50,
            mats["copper_turbine"], col, segments=32,
            rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.010, radius2=0.32, parent=root,
        ))
        for fi in range(10):
            ang = 2.0 * math.pi * fi / 10.0
            fx = xc + 0.325 * math.cos(ang)
            fz = zc + 0.325 * math.sin(ang)
            stbd_parts.append(add_beveled_box(
                f"{pfx}_ManifoldFin_{fi:02d}", (fx, -6.30, fz), (0.040, 0.44, 0.046),
                mats["obsidian_dark"], col, bevel=0.004, rot=(0.0, ang, 0.0), parent=root,
            ))

        # 4B. Main Stepped Dark-Titanium Pressure Chamber Barrel
        barrel_prof = [
            ( 0.86, 0.30),
            ( 0.84, 0.34),
            ( 0.60, 0.34),
            ( 0.56, 0.305),
            ( 0.22, 0.305),
            ( 0.18, 0.345),
            (-0.18, 0.345),
            (-0.22, 0.31),
            (-0.62, 0.31),
            (-0.66, 0.34),
            (-0.92, 0.34),
            (-0.96, 0.29),
            (-0.96, 0.20),
            ( 0.86, 0.20),
        ]
        stbd_parts.append(add_revolved_y(
            f"{pfx}_MainBarrel", (xc, yc_base, zc), barrel_prof,
            mats["titanium_struct"], col, segments=32, parent=root,
        ))

        # 4C. Blued-Steel Tapered Conical Vectoring Exhaust Nozzle (Rear Ortho 19.32.29.png!)
        nozzle_prof = [
            ( 0.00, 0.305),
            (-0.16, 0.325),
            (-0.56, 0.275),
            (-1.02, 0.200),
            (-1.14, 0.175),
            (-1.14, 0.145),
            (-0.85, 0.165),
            (-0.25, 0.215),
            ( 0.00, 0.215),
        ]
        stbd_parts.append(add_revolved_y(
            f"{pfx}_VectorNozzle", (xc, -8.36, zc), nozzle_prof,
            mats["steel_nozzle"], col, segments=32, parent=root,
        ))

        for pi in range(12):
            ang = 2.0 * math.pi * pi / 12.0
            px = xc + 0.265 * math.cos(ang)
            pz = zc + 0.265 * math.sin(ang)
            stbd_parts.append(add_beveled_box(
                f"{pfx}_NozzlePetal_{pi:02d}", (px, -8.92, pz), (0.044, 0.86, 0.022),
                mats["louver_metal"], col, bevel=0.004,
                rot=(-0.10 * math.sin(ang), ang + math.pi * 0.5, 0.10 * math.cos(ang)),
                parent=root,
            ))

        stbd_parts.append(add_cylinder(
            f"{pfx}_NozzleThroat", (xc, -9.12, zc), 0.155, 0.55,
            mats["cavity_dark"], col, segments=24,
            rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.006, parent=root,
        ))
        stbd_parts.append(add_cylinder(
            f"{pfx}_NozzleEmber", (xc, -8.98, zc), 0.105, 0.08,
            mats["thruster_ember"], col, segments=20,
            rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.004, parent=root,
        ))

        for y_cl in (-6.68, -7.82):
            stbd_parts.append(add_cylinder(
                f"{pfx}_ClampRing_{y_cl:+.2f}", (xc, y_cl, zc), 0.355, 0.10,
                mats["steel_nozzle"], col, segments=32,
                rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
            ))
        stbd_parts.append(add_cylinder(
            f"{pfx}_FuelConduit", (xc - 0.33, -7.25, zc + 0.05), 0.032, 2.15,
            mats["steel_nozzle"], col, segments=12,
            rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.004, parent=root,
        ))

    mirror_stbd_to_port(stbd_parts, col, parent=root)


# ---------------------------------------------------------------------------
# 9. Collection 05: Wing Inner-Wall Louvered Intakes & Subtle Stealth Details
# ---------------------------------------------------------------------------

def build_wing_intakes_and_details(mats, col, root):
    stbd_parts = []

    # 5A. Long Recessed Inner-Wall Louvered Cooling Intake Channel (Hero View far wing!)
    ny_in = 14
    in_ys = [0.75 + (6.65 - 0.75) * i / float(ny_in - 1) for i in range(ny_in)]
    bezel_secs = []
    for y in in_ys:
        xi = wing_x_in(y) - 0.02
        zt = wing_z_surface(xi, y, True) * 0.54
        zb = wing_z_surface(xi, y, False) * 0.54
        bezel_secs.append([
            (xi,        y, zb),
            (xi + 0.22, y, zb),
            (xi + 0.22, y, zt),
            (xi,        y, zt),
        ])
    stbd_parts.append(add_lofted_sections(
        "Wing_InnerWallIntakeThroat_Stbd", bezel_secs, mats["cavity_dark"], col,
        smooth=False, parent=root,
    ))

    for lz_frac in (-0.32, -0.10, 0.12, 0.34):
        strake_path = []
        for y in in_ys:
            xi = wing_x_in(y) - 0.015
            zt = wing_z_surface(xi, y, True)
            zb = wing_z_surface(xi, y, False)
            zm = 0.5 * (zt + zb) + lz_frac * 0.5 * (zt - zb)
            strake_path.append((xi, y, zm))
        stbd_parts.append(add_swept_beam(
            f"Wing_InnerWallLouver_Stbd_{lz_frac:+.2f}", strake_path,
            [(-0.042, -0.018), (0.042, -0.018), (0.042, 0.018), (-0.042, 0.018)],
            mats["titanium_struct"], col, sharp_angle_deg=34.0, parent=root,
        ))

    # Mirror Starboard intake details to Port (-X)
    mirror_stbd_to_port(stbd_parts, col, parent=root)

    # Flush Subtle Dorsal Sensor Slot on Forward Bow Spine (matches Top Ortho!)
    add_beveled_box(
        "Detail_BowSensorAperture", (0.0, 6.95, 0.52), (0.30, 0.38, 0.045),
        mats["obsidian_dark"], col, bevel=0.010, rot=(-0.15, 0.0, 0.0), parent=root,
    )


# ---------------------------------------------------------------------------
# 10. Restrained Fine-Pen Comic LineArt, Chiaroscuro Lighting & 7 Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_comic_lineart(col_lineart_src, col_ink):
    """Build ultra-clean, fine-pen Grease Pencil Line Art (Blender 5.3):
    Thin crisp outer contours + whisper-fine major architectural creases ONLY,
    with zero micro-greeble clutter, zero intersections, and zero heavy blobs!"""
    gp_data = bpy.data.grease_pencils.new("Hermes_ComicInk_GP")
    gp_data.stroke_depth_order = "3D"

    layer_sil = gp_data.layers.new("Silhouette_Ink")
    layer_sil.frames.new(1)
    layer_sil.use_lights = False
    layer_sil.opacity = 0.88

    layer_cre = gp_data.layers.new("Crease_Ink")
    layer_cre.frames.new(1)
    layer_cre.use_lights = False
    layer_cre.opacity = 0.62

    ink_mat = bpy.data.materials.new("Mat_Hermes_ComicInk")
    bpy.data.materials.create_gpencil_data(ink_mat)
    # Precision deep obsidian-ink (ultra-clean 0.25mm technical pen weight!)
    ink_mat.grease_pencil.color = (0.008, 0.009, 0.013, 1.0)
    gp_data.materials.append(ink_mat)

    gp_obj = bpy.data.objects.new("Hermes_ComicInk_Lines", gp_data)
    link_obj(gp_obj, col_ink)

    # Pass 1: Fine Architectural Outer Silhouette Contours (thin & crisp, never thick!)
    mod_sil = gp_obj.modifiers.new(name="LineArt_Silhouette", type="LINEART")
    mod_sil.source_type = "COLLECTION"
    mod_sil.source_collection = col_lineart_src
    mod_sil.target_layer = "Silhouette_Ink"
    mod_sil.target_material = ink_mat
    mod_sil.use_custom_camera = False
    mod_sil.use_contour = True
    mod_sil.use_crease = False
    mod_sil.use_material = False
    mod_sil.use_intersection = False
    mod_sil.use_edge_mark = False
    mod_sil.use_loose = False
    mod_sil.radius = 0.020
    mod_sil.opacity = 0.86
    mod_sil.stroke_depth_offset = 0.04
    mod_sil.overscan = 0.14

    # Pass 2: Whisper-Fine Major Dihedral Creases ONLY (no sharp-split spam, no noisy intersections!)
    mod_cre = gp_obj.modifiers.new(name="LineArt_Creases", type="LINEART")
    mod_cre.source_type = "COLLECTION"
    mod_cre.source_collection = col_lineart_src
    mod_cre.target_layer = "Crease_Ink"
    mod_cre.target_material = ink_mat
    mod_cre.use_custom_camera = False
    mod_cre.use_contour = False
    mod_cre.use_crease = True
    mod_cre.use_crease_on_smooth = False
    mod_cre.use_crease_on_sharp = False
    mod_cre.crease_threshold = math.radians(144.0)
    mod_cre.use_material = False
    mod_cre.use_intersection = False
    mod_cre.use_edge_mark = False
    mod_cre.use_loose = False
    mod_cre.radius = 0.009
    mod_cre.opacity = 0.56
    mod_cre.stroke_depth_offset = 0.03
    mod_cre.overscan = 0.14

    return gp_obj


def setup_world_and_lighting(col_stage):
    """Calibrate crisp Ligne-Claire Comic chiaroscuro studio lighting & slate backdrop."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Hermes_Comic_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        # Refined deep slate-graphite studio backdrop so rich obsidian, fine ink & cream ivory ALL pop!
        bg.inputs["Color"].default_value = (0.068, 0.074, 0.088, 1.0)
        bg.inputs["Strength"].default_value = 0.48

    def add_light(name, ltype, loc, target, energy, color, size=18.0, angle=0.014, radius=0.6):
        ldata = bpy.data.lights.new(name=name, type=ltype)
        ldata.energy = energy
        ldata.color = color
        if ltype == "SUN":
            ldata.angle = angle
        elif ltype == "AREA":
            ldata.size = size
        elif ltype == "POINT":
            ldata.shadow_soft_size = radius
        lobj = bpy.data.objects.new(name, ldata)
        lobj.location = loc
        link_obj(lobj, col_stage)
        if target is not None:
            aim_object_at(lobj, target)
        return lobj

    # 1. Graphic Directional Sun Key (carves crisp 4-band comic shadow planes across fuselage & wings!)
    add_light("Key_Sun_Comic", "SUN", (-16.0, 18.0, 26.0), (0.0, 0.0, 0.0), energy=3.20, color=(1.0, 0.99, 0.97), angle=0.012)

    # 2. Controlled Overhead Softbox (keeps Top Ortho crisp & cel-stepped without flattening shadows!)
    add_light("Softbox_Area_Top", "AREA", (2.0, 2.0, 28.0), (0.0, 0.0, 0.0), energy=2200.0, color=(0.98, 0.99, 1.0), size=24.0)

    # 3. Starboard & Port Raking Rims (sculpts crisp comic facets on dark obsidian fuselage!)
    add_light("Rim_Area_Starboard", "AREA", (28.0, 8.0, 10.0), (0.0, 0.0, 0.0), energy=2100.0, color=(0.92, 0.96, 1.0), size=20.0)
    add_light("Fill_Area_PortBow",  "AREA", (-26.0, 14.0, 10.0), (0.0, 0.0, 0.0), energy=1400.0, color=(0.96, 0.98, 1.0), size=20.0)

    # 4. Centered Bow Soft Fill (clean Front Ortho cel planes!)
    add_light("Fill_Area_BowCenter", "AREA", (0.0, 32.0, 6.0), (0.0, 2.0, 0.0), energy=1500.0, color=(0.96, 0.98, 1.0), size=22.0)

    # 5. Stern Architectural Rim (illuminates Rear 3/4 & Stern quad thrusters cleanly!)
    add_light("Rim_Area_Stern", "AREA", (6.0, -28.0, 8.0), (0.0, -8.5, -0.1), energy=2400.0, color=(0.94, 0.97, 1.0), size=20.0)

    # 6. Controlled Cool Ventral Underbelly Bounce (preserves clean cel shadow steps on Bottom Ortho!)
    add_light("Bounce_Area_Ventral", "AREA", (-2.0, 0.0, -28.0), (0.0, -1.0, -0.5), energy=2300.0, color=(0.86, 0.93, 1.0), size=26.0)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=38.0, ortho_scale=24.0):
        cdata = bpy.data.cameras.new(name=name)
        cdata.type = cam_type
        cdata.clip_start = 0.1
        cdata.clip_end = 500.0
        if cam_type == "PERSP":
            cdata.lens = lens
        else:
            cdata.ortho_scale = ortho_scale
        cobj = bpy.data.objects.new(name, cdata)
        cobj.location = loc
        link_obj(cobj, col_stage)
        aim_object_at(cobj, target)
        cameras[name] = cobj
        return cobj

    make_cam("Cam_Hero_34", (-17.5, 19.2, 12.8), (0.0, -0.4, -0.1), cam_type="PERSP", lens=40.0)

    c_side = make_cam("Cam_Side_Ortho", (32.0, 0.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=22.4)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

    c_front = make_cam("Cam_Front_Ortho", (0.0, 32.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=23.6)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -32.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=23.6)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 36.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=32.5)
    c_top.rotation_euler = (0.0, 0.0, math.pi)

    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -36.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=32.5)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    make_cam("Cam_Rear_34", (16.8, -19.8, 8.6), (0.0, -1.2, -0.1), cam_type="PERSP", lens=38.0)

    bpy.context.scene.camera = cameras["Cam_Hero_34"]
    return cameras


def setup_render_settings():
    scene = bpy.context.scene
    available_engines = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
    if "BLENDER_EEVEE" in available_engines:
        scene.render.engine = "BLENDER_EEVEE"
    elif "BLENDER_EEVEE_NEXT" in available_engines:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    else:
        scene.render.engine = "CYCLES"

    scene.render.resolution_x = 1280
    scene.render.resolution_y = 854
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    if hasattr(scene, "eevee"):
        if hasattr(scene.eevee, "taa_render_samples"):
            scene.eevee.taa_render_samples = 64
        if hasattr(scene.eevee, "use_gtao"):
            scene.eevee.use_gtao = True
        if hasattr(scene.eevee, "gtao_distance"):
            scene.eevee.gtao_distance = 1.8

    # Standard color transform keeps Ligne-Claire comic cel bands crisp, vivid & true to palette!
    scene.view_settings.view_transform = "Standard"
    try:
        scene.view_settings.look = "None"
    except Exception:
        pass
    scene.view_settings.exposure = 0.0

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.clip_end = 500.0


# ---------------------------------------------------------------------------
# 11. Main Build Entrypoint
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root     = ensure_collection("Hermes_SweptWing")
    col_lineart  = ensure_collection("Hermes_Primary_LineArt_Source", col_root)
    col_fuselage = ensure_collection("01_Central_Fuselage", col_lineart)
    col_wings    = ensure_collection("02_Swept_Crescent_Wings", col_lineart)
    col_struts   = ensure_collection("03_Connecting_Struts", col_lineart)
    col_engines  = ensure_collection("04_Wing_Thruster_Pods", col_lineart)
    col_details  = ensure_collection("05_Wing_Intakes_And_Details", col_lineart)
    col_noline   = ensure_collection("06_MicroDetail_And_FX_NoLineArt", col_root)
    col_ink      = ensure_collection("98_Comic_Ink_LineArt")
    col_stage    = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("Hermes_SweptWing_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_hermes_textures()
    mats = build_materials(tex)

    build_central_fuselage(mats, col_fuselage, root)
    build_swept_wings(mats, col_wings, root)
    build_connecting_struts(mats, col_struts, root)
    build_wing_thruster_pods(mats, col_engines, root)
    build_wing_intakes_and_details(mats, col_details, root)

    # Route dense micro-greebles (72 vent louvers, 48 nozzle petals, 40 manifold fins, inner ribs,
    # conduits, cavities & emissive strips) OUTSIDE LineArt source so comic ink stays ultra-clean
    # and never bunches into thick messy black tangles!
    no_lineart_tokens = (
        "VentLouver", "VentTurbo", "VentCavityFloor",
        "InnerWallLouver", "InnerWallIntakeThroat",
        "AftBayRib", "AftBayBulkhead", "InternalStructuralCore",
        "SternVane", "SternExhaustThroat", "SternEmberCore", "SternTopGoldLip",
        "WaistTrenchCore", "WaistGlowStrip", "ShoulderGoldBevel",
        "UpperRib", "ManifoldFin", "NozzlePetal", "ClampRing",
        "FuelConduit", "NozzleThroat", "NozzleEmber", "BowSensorAperture",
    )
    for obj in list(bpy.data.objects):
        if obj.type != "MESH":
            continue
        if any(tok in obj.name for tok in no_lineart_tokens):
            link_obj(obj, col_noline)

    setup_comic_lineart(col_lineart, col_ink)
    setup_world_and_lighting(col_stage)
    cameras = setup_cameras(col_stage)
    setup_render_settings()

    bpy.context.view_layer.update()

    mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
    total_verts = sum(len(o.data.vertices) for o in mesh_objs)
    total_faces = sum(len(o.data.polygons) for o in mesh_objs)

    xs, ys, zs = [], [], []
    for o in mesh_objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            xs.append(w.x)
            ys.append(w.y)
            zs.append(w.z)

    print(
        f"BUILT Hermes_SweptWing V3 (Ligne-Claire Comic Cel-Shaded + Fine Ink LineArt): "
        f"{len(mesh_objs)} meshes, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.4f},{max(xs):.4f}] ({max(xs)-min(xs):.4f}m) "
        f"Y=[{min(ys):.4f},{max(ys):.4f}] ({max(ys)-min(ys):.4f}m) "
        f"Z=[{min(zs):.4f},{max(zs):.4f}] ({max(zs)-min(zs):.4f}m)"
    )
    return cameras


build_all()
