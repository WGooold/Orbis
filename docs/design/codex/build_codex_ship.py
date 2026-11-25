"""Parametric ultra-detailed hard-surface 3D model builder for the Codex Heavy Orbital Frigate (V3 Hero-Asset PBR).

Built directly from the hero concept & 5 orthographic reference views in docs/design/codex/:
  - Hero 3/4:     codex-spaceship-hero.png (weathered military olive-slate composite armor
                  with layered hull plates, micro-rivets, chipped metallic edge wear, oiled
                  gunmetal machinery, muted khaki-olive upper rear cowlings, smoked angled
                  bridge glass w/ subtle cockpit interior & recessed brow lights, fiery
                  molten-amber stern propulsion)
  - Front Ortho:  QQ_2026-11-25_01-24-49.png (overhanging faceted bridge brow, translucent
                  panoramic canopy w/ armored mullions, under-bridge intake manifold, twin
                  bezelled chin headlights, sculpted hydraulic ventral docking cradle,
                  elongated vertical hexagonal pods w/ twin statored nozzles & wall lugs)
  - Top Ortho:    QQ_2026-11-25_01-25-13.png (layered tapered bow glacis, louvered bow air
                  brakes, 25+ part circular dorsal turret/airlock w/ 12 radial lugs & twin
                  barrels, twin 8-arch piped radiator trenches, clamped spine conduit booms)
  - Side Ortho:   QQ_2026-11-25_01-25-44.png (stepped dorsal armor w/ mid-aft fairing ridge,
                  ribbed forward landing sled, chamfered front pod w/ seam latches, deeply
                  packed industrial waist w/ hydraulic rams & pipes, layered monolithic side
                  sponson, dark gunmetal rear nacelle w/ 3 louvered slots & vernier nozzle)
  - Rear Ortho:   QQ_2026-11-25_01-26-06.png (bolted central reactor door, iconic triple-
                  stepped '>' '<' chevron armored thruster frames w/ 14 conformal thrust
                  vanes & recessed molten-amber cores, outer vertical hex dual-slit nacelles)
  - Bottom Ortho: QQ_2026-11-25_01-26-39.png (interlocking stepped keel plates, umbilical
                  docking bay, flanking cylindrical-ram actuator bays, 12-cleat forward sled)

Generates deterministic 2048x2048 (olive armor, gunmetal chassis) & 1024x1024 (khaki-olive
nacelle) seamless military aerospace PBR maps (Albedo, Roughness, Normal) in textures/,
packed into .blend and embedded into .glb with distortion-free world-scale box UVs.

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-4.98, +4.98] (9.96 m max beam)
  -Y = Stern, +Y = Bow             -> Y in [-11.00, +11.00] (22.00 m total length)
  -Z = Ventral, +Z = Dorsal        -> Z in [-3.64, +3.20] (6.84 m total height)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/codex"
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
    scene.world = None
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
    for block_store in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.worlds,
        bpy.data.images,
    ):
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
# 1. Procedural 2048x2048 Hero-Grade Military Aerospace PBR Texture Synthesis
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64, 128), weights=(0.30, 0.25, 0.18, 0.12, 0.09, 0.06)):
    """Fast vectorized seamless tileable fBM noise using periodic bilinear interpolation."""
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


def _generate_hero_naval_plating(res, seed, grid_x=2, grid_y=2, sub_prob=0.42, seam_px=2):
    """Generate monolithic aerospace hull plating with inset service hatches, rivets & chipped edge wear."""
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    seam = np.zeros((res, res), dtype=np.float32)
    edge_wear = np.zeros((res, res), dtype=np.float32)
    rivet = np.zeros((res, res), dtype=np.float32)
    hatch_vent = np.zeros((res, res), dtype=np.float32)

    xs = [0]
    ys = [0]
    sx = res // grid_x
    sy = res // grid_y
    margin = max(48, res // 16)
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * sx + rng.integers(-sx // 6, sx // 6 + 1), margin, res - margin)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * sy + rng.integers(-sy // 6, sy // 6 + 1), margin, res - margin)))
    xs.append(res)
    ys.append(res)

    min_sub = max(160, res // 5)

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

        tone[y0:y1, x0:x1] = float(rng.uniform(-0.036, 0.036))
        sp = seam_px
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        # Metallic chipped-paint catchlight band right along armor panel edges
        ew = sp + max(3, res // 256)
        if y1 - y0 > ew * 3 and x1 - x0 > ew * 3:
            edge_wear[y0 + sp:y0 + ew, x0 + sp:x1 - sp] = 0.72
            edge_wear[y0 + sp:y1 - sp, x0 + sp:x0 + ew] = 0.64
            edge_wear[max(y1 - ew, y0 + sp):y1 - sp, x0 + sp:x1 - sp] = 0.45

        # Crisp spaced perimeter countersunk rivets along large hull plates
        step = max(44, res // 18)
        pad = sp + max(12, res // 96)
        r_sz = max(2, res // 512)
        if w > pad * 4 and h > pad * 4:
            for rx in range(x0 + pad, x1 - pad, step):
                for ry in (y0 + pad, y1 - pad - r_sz):
                    if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                        rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0
            for ry in range(y0 + pad + step, y1 - pad - step, step):
                for rx in (x0 + pad, x1 - pad - r_sz):
                    if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                        rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0

        # Organic inset rectangular service access hatch + subtle louver slots inside large plates
        if w > res // 4 and h > res // 4 and rng.random() < 0.72:
            hw = int(w * rng.uniform(0.16, 0.28))
            hh = int(h * rng.uniform(0.14, 0.24))
            hx0 = x0 + int(w * rng.uniform(0.14, 0.80 - hw / float(w)))
            hy0 = y0 + int(h * rng.uniform(0.14, 0.80 - hh / float(h)))
            hx1 = min(hx0 + hw, x1 - pad)
            hy1 = min(hy0 + hh, y1 - pad)
            if hx1 - hx0 > 40 and hy1 - hy0 > 32:
                tone[hy0:hy1, hx0:hx1] += float(rng.uniform(-0.025, 0.028))
                hsp = max(1, sp)
                seam[hy0:hy0 + hsp, hx0:hx1] = 0.92
                seam[hy1 - hsp:hy1, hx0:hx1] = 0.92
                seam[hy0:hy1, hx0:hx0 + hsp] = 0.92
                seam[hy0:hy1, hx1 - hsp:hx1] = 0.92
                edge_wear[hy0 + hsp:hy0 + hsp + 3, hx0 + hsp:hx1 - hsp] = 0.58
                # Corner fastener bolts on service hatch
                bp = hsp + 6
                for bry in (hy0 + bp, hy1 - bp - r_sz):
                    for brx in (hx0 + bp, hx1 - bp - r_sz):
                        if 0 <= bry < res - r_sz and 0 <= brx < res - r_sz:
                            rivet[bry:bry + r_sz, brx:brx + r_sz] = 1.0
                # Tiny louvered intake slots inside half of service hatches
                if rng.random() < 0.55 and (hy1 - hy0) > 56:
                    sl_x0 = hx0 + int((hx1 - hx0) * 0.22)
                    sl_x1 = hx1 - int((hx1 - hx0) * 0.22)
                    n_sl = 4
                    sl_gap = max(6, (hy1 - hy0) // (n_sl + 3))
                    sl_y = hy0 + sl_gap * 2
                    for _ in range(n_sl):
                        if sl_y + 3 < hy1 - 8:
                            hatch_vent[sl_y:sl_y + 3, sl_x0:sl_x1] = 0.85
                            sl_y += sl_gap

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    seam_blur = (
        seam * 0.50
        + np.roll(seam, 1, axis=0) * 0.125
        + np.roll(seam, -1, axis=0) * 0.125
        + np.roll(seam, 1, axis=1) * 0.125
        + np.roll(seam, -1, axis=1) * 0.125
    )
    rivet_blur = (
        rivet * 0.56
        + np.roll(rivet, 1, axis=0) * 0.11
        + np.roll(rivet, -1, axis=0) * 0.11
        + np.roll(rivet, 1, axis=1) * 0.11
        + np.roll(rivet, -1, axis=1) * 0.11
    )
    return tone, np.clip(seam_blur, 0.0, 1.0), edge_wear, np.clip(rivet_blur, 0.0, 1.0), hatch_vent


def _height_to_normal(height, strength=2.2):
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


def generate_codex_textures():
    """Synthesize 2048x2048 Hero-Grade Military Olive & Gunmetal + 1024x1024 Khaki-Olive PBR maps."""
    # High-res 2048x2048 primary noise fields for olive armor & gunmetal chassis
    res = 2048
    macro = _tileable_fbm(res, seed=101, octaves=(4, 8, 16, 32), weights=(0.40, 0.28, 0.20, 0.12))
    camo = _tileable_fbm(res, seed=147, octaves=(4, 8, 16, 32), weights=(0.46, 0.30, 0.16, 0.08))
    micro = _tileable_fbm(res, seed=202, octaves=(64, 128, 256), weights=(0.38, 0.34, 0.28))
    streak_raw = _tileable_fbm(res, seed=303, octaves=(16, 32, 64, 128), weights=(0.25, 0.25, 0.25, 0.25))
    # Directional orbital flight abrasion streaks
    streak = (
        streak_raw
        + np.roll(streak_raw, 3, axis=1) + np.roll(streak_raw, -3, axis=1)
        + np.roll(streak_raw, 7, axis=1) + np.roll(streak_raw, -7, axis=1)
        + np.roll(streak_raw, 13, axis=1) + np.roll(streak_raw, -13, axis=1)
    ) / 7.0

    mottle = np.clip((camo - 0.48) * 2.4, -0.5, 0.5)

    # Set A: 2048x2048 Tactical Military Olive-Slate Armor (monolithic plates + inset hatches + rivets + edge chips!)
    tone_o, seam_o, wear_o, riv_o, vent_o = _generate_hero_naval_plating(res, seed=404, grid_x=2, grid_y=2, sub_prob=0.42, seam_px=2)
    chip_o = wear_o * np.clip((micro - 0.36) * 2.4, 0.0, 1.0)
    grime_o = (macro - 0.5) * 0.095 + mottle * 0.072 + (streak - 0.5) * 0.048 + (micro - 0.5) * 0.042

    or_ = 0.238 + tone_o * 0.46 - grime_o * 0.80 + chip_o * 0.135
    og_ = 0.342 + tone_o * 0.52 - grime_o * 0.86 + chip_o * 0.145
    ob_ = 0.272 + tone_o * 0.44 - grime_o * 0.78 + chip_o * 0.132
    o_dark = (1.0 - seam_o * 0.34) * (1.0 - riv_o * 0.36) * (1.0 - vent_o * 0.58)
    olive_albedo = np.stack([or_ * o_dark, og_ * o_dark, ob_ * o_dark], axis=-1)

    olive_rough = np.clip(
        0.44 + (macro - 0.5) * 0.22 + mottle * 0.14 + (streak - 0.5) * 0.11
        + (micro - 0.5) * 0.07 + seam_o * 0.26 + vent_o * 0.30 - chip_o * 0.24,
        0.18,
        0.82,
    )
    olive_rough_rgb = np.stack([olive_rough, olive_rough, olive_rough], axis=-1)
    olive_height = np.clip(
        0.74 - seam_o * 0.36 - riv_o * 0.26 - vent_o * 0.42 + tone_o * 0.20 + (streak - 0.5) * 0.065 + (micro - 0.5) * 0.055,
        0.0,
        1.0,
    )
    olive_normal = _height_to_normal(olive_height, strength=2.35)

    # Set C: 2048x2048 Oiled Gunmetal Mechanical Core, Outboard Nacelles & Underbelly
    tone_g, seam_g, wear_g, riv_g, vent_g = _generate_hero_naval_plating(res, seed=808, grid_x=3, grid_y=3, sub_prob=0.48, seam_px=2)
    chip_g = wear_g * np.clip((micro - 0.34) * 2.5, 0.0, 1.0)
    grime_g = (macro - 0.5) * 0.078 + mottle * 0.058 + (streak - 0.5) * 0.050

    gr_ = 0.178 + tone_g * 0.38 - grime_g * 0.72 + chip_g * 0.14
    gg_ = 0.196 + tone_g * 0.40 - grime_g * 0.72 + chip_g * 0.148
    gb_ = 0.190 + tone_g * 0.38 - grime_g * 0.72 + chip_g * 0.142
    g_dark = (1.0 - seam_g * 0.42) * (1.0 - riv_g * 0.38) * (1.0 - vent_g * 0.62)
    gunmetal_albedo = np.stack([gr_ * g_dark, gg_ * g_dark, gb_ * g_dark], axis=-1)

    gunmetal_rough = np.clip(
        0.37 + (macro - 0.5) * 0.20 + (streak - 0.5) * 0.12 + seam_g * 0.28 + vent_g * 0.28 - chip_g * 0.22,
        0.16,
        0.78,
    )
    gunmetal_rough_rgb = np.stack([gunmetal_rough, gunmetal_rough, gunmetal_rough], axis=-1)
    gunmetal_height = np.clip(
        0.75 - seam_g * 0.42 - riv_g * 0.28 - vent_g * 0.46 + tone_g * 0.24 + (streak - 0.5) * 0.065,
        0.0,
        1.0,
    )
    gunmetal_normal = _height_to_normal(gunmetal_height, strength=2.55)

    # Set B: 1024x1024 Muted Weathered Khaki-Olive Upper Rear Nacelle Caps
    res_t = 1024
    macro_t = macro[::2, ::2]
    mottle_t = mottle[::2, ::2]
    micro_t = micro[::2, ::2]
    streak_t = streak[::2, ::2]
    tone_t, seam_t, wear_t, riv_t, vent_t = _generate_hero_naval_plating(res_t, seed=606, grid_x=2, grid_y=2, sub_prob=0.38, seam_px=1)
    chip_t = wear_t * np.clip((micro_t - 0.36) * 2.3, 0.0, 1.0)
    grime_t = (macro_t - 0.5) * 0.095 + mottle_t * 0.068 + (streak_t - 0.5) * 0.045

    tr_ = 0.375 + tone_t * 0.46 - grime_t * 0.80 + chip_t * 0.11
    tg_ = 0.358 + tone_t * 0.46 - grime_t * 0.80 + chip_t * 0.105
    tb_ = 0.254 + tone_t * 0.36 - grime_t * 0.68 + chip_t * 0.085
    t_dark = (1.0 - seam_t * 0.34) * (1.0 - riv_t * 0.34) * (1.0 - vent_t * 0.52)
    tan_albedo = np.stack([tr_ * t_dark, tg_ * t_dark, tb_ * t_dark], axis=-1)

    tan_rough = np.clip(
        0.47 + (macro_t - 0.5) * 0.20 + mottle_t * 0.12 + (streak_t - 0.5) * 0.09 + seam_t * 0.25 - chip_t * 0.18,
        0.22,
        0.82,
    )
    tan_rough_rgb = np.stack([tan_rough, tan_rough, tan_rough], axis=-1)
    tan_height = np.clip(0.74 - seam_t * 0.34 - riv_t * 0.24 - vent_t * 0.38 + tone_t * 0.20 + (micro_t - 0.5) * 0.05, 0.0, 1.0)
    tan_normal = _height_to_normal(tan_height, strength=2.20)

    return {
        "olive_albedo":    _save_and_pack_image("Tex_CodexOlive_Albedo",    os.path.join(TEX_DIR, "olive_armor_albedo.png"),      olive_albedo, "sRGB"),
        "olive_rough":     _save_and_pack_image("Tex_CodexOlive_Rough",     os.path.join(TEX_DIR, "olive_armor_rough.png"),       olive_rough_rgb, "Non-Color"),
        "olive_normal":    _save_and_pack_image("Tex_CodexOlive_Normal",    os.path.join(TEX_DIR, "olive_armor_normal.png"),      olive_normal, "Non-Color"),
        "tan_albedo":      _save_and_pack_image("Tex_CodexTan_Albedo",      os.path.join(TEX_DIR, "tan_nacelle_albedo.png"),      tan_albedo, "sRGB"),
        "tan_rough":       _save_and_pack_image("Tex_CodexTan_Rough",       os.path.join(TEX_DIR, "tan_nacelle_rough.png"),       tan_rough_rgb, "Non-Color"),
        "tan_normal":      _save_and_pack_image("Tex_CodexTan_Normal",      os.path.join(TEX_DIR, "tan_nacelle_normal.png"),      tan_normal, "Non-Color"),
        "gunmetal_albedo": _save_and_pack_image("Tex_CodexGunmetal_Albedo", os.path.join(TEX_DIR, "gunmetal_chassis_albedo.png"), gunmetal_albedo, "sRGB"),
        "gunmetal_rough":  _save_and_pack_image("Tex_CodexGunmetal_Rough",  os.path.join(TEX_DIR, "gunmetal_chassis_rough.png"),  gunmetal_rough_rgb, "Non-Color"),
        "gunmetal_normal": _save_and_pack_image("Tex_CodexGunmetal_Normal", os.path.join(TEX_DIR, "gunmetal_chassis_normal.png"), gunmetal_normal, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. Codex Frigate PBR Materials (AgX-Calibrated Military Olive & Molten Amber)
# ---------------------------------------------------------------------------

def set_bsdf_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return bsdf.inputs[n]
    return None


def make_textured_pbr_mat(
    name,
    albedo_img,
    rough_img,
    normal_img,
    metallic=0.36,
    normal_strength=0.48,
    coat=0.09,
    coat_rough=0.24,
    uv_scale=0.52,
    color_tint=None,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (680, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (280, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    set_bsdf_input(bsdf, ["Metallic"], metallic)
    if coat > 0.0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], coat_rough)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-820, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-600, 0)
    mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, uv_scale)
    nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])

    tex_col = nt.nodes.new("ShaderNodeTexImage")
    tex_col.location = (-260, 260)
    tex_col.image = albedo_img
    nt.links.new(mapping.outputs["Vector"], tex_col.inputs["Vector"])

    if color_tint is not None:
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.location = (20, 260)
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (*color_tint, 1.0)
        nt.links.new(tex_col.outputs["Color"], mix.inputs["A"])
        nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(tex_col.outputs["Color"], bsdf.inputs["Base Color"])

    tex_rgh = nt.nodes.new("ShaderNodeTexImage")
    tex_rgh.location = (-260, -20)
    tex_rgh.image = rough_img
    nt.links.new(mapping.outputs["Vector"], tex_rgh.inputs["Vector"])
    nt.links.new(tex_rgh.outputs["Color"], bsdf.inputs["Roughness"])

    tex_nrm = nt.nodes.new("ShaderNodeTexImage")
    tex_nrm.location = (-360, -320)
    tex_nrm.image = normal_img
    nt.links.new(mapping.outputs["Vector"], tex_nrm.inputs["Vector"])

    nrm_node = nt.nodes.new("ShaderNodeNormalMap")
    nrm_node.location = (-20, -300)
    nrm_node.uv_map = "UVMap"
    nrm_node.inputs["Strength"].default_value = normal_strength
    nt.links.new(tex_nrm.outputs["Color"], nrm_node.inputs["Color"])
    nt.links.new(nrm_node.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def make_solid_pbr_mat(
    name,
    base_color,
    metallic=0.35,
    roughness=0.35,
    coat=0.0,
    coat_rough=0.10,
    alpha=1.0,
    emission_color=None,
    emission_strength=0.0,
):
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
    set_bsdf_input(bsdf, ["Metallic"], metallic)
    set_bsdf_input(bsdf, ["Roughness"], roughness)
    if coat > 0.0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], coat_rough)
    if alpha < 0.999:
        set_bsdf_input(bsdf, ["Alpha"], alpha)
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    return {
        # Primary Weathered Military Olive-Slate Armor (2048 PBR)
        "olive_armor": make_textured_pbr_mat(
            "Mat_Codex_OliveArmor",
            tex["olive_albedo"],
            tex["olive_rough"],
            tex["olive_normal"],
            metallic=0.36,
            normal_strength=0.48,
            coat=0.09,
            coat_rough=0.24,
            uv_scale=0.52,
        ),
        # Subtle Lighter Sage-Olive Secondary Armor Overlay Plates (adds rich multi-plate tonal depth!)
        "olive_light": make_textured_pbr_mat(
            "Mat_Codex_OliveLightArmor",
            tex["olive_albedo"],
            tex["olive_rough"],
            tex["olive_normal"],
            metallic=0.34,
            normal_strength=0.45,
            coat=0.10,
            coat_rough=0.22,
            uv_scale=0.60,
            color_tint=(1.12, 1.14, 1.10),
        ),
        # Darker Olive-Slate Armor Trim for Chevron Frames, Hex Bezels & Rear Cowls
        "olive_dark": make_textured_pbr_mat(
            "Mat_Codex_OliveDarkArmor",
            tex["olive_albedo"],
            tex["olive_rough"],
            tex["olive_normal"],
            metallic=0.48,
            normal_strength=0.50,
            coat=0.08,
            coat_rough=0.25,
            uv_scale=0.68,
            color_tint=(0.64, 0.70, 0.67),
        ),
        # Muted Weathered Military Khaki-Olive Rear Upper Engine Nacelle Cap (Hero Accent!)
        "khaki_tan": make_textured_pbr_mat(
            "Mat_Codex_KhakiTanArmor",
            tex["tan_albedo"],
            tex["tan_rough"],
            tex["tan_normal"],
            metallic=0.32,
            normal_strength=0.46,
            coat=0.07,
            coat_rough=0.26,
            uv_scale=0.62,
        ),
        # Heavy Oiled Gunmetal Structural Core, Outboard Nacelles & Ventral Underbelly (2048 PBR)
        "gunmetal_chassis": make_textured_pbr_mat(
            "Mat_Codex_GunmetalChassis",
            tex["gunmetal_albedo"],
            tex["gunmetal_rough"],
            tex["gunmetal_normal"],
            metallic=0.74,
            normal_strength=0.54,
            coat=0.12,
            coat_rough=0.24,
            uv_scale=0.76,
        ),
        # Dark Anodized Titanium-Steel for Nozzles, Clamps, Barrels & Actuator Housing
        "steel_trim": make_solid_pbr_mat(
            "Mat_Codex_SteelTrim",
            base_color=(0.095, 0.108, 0.104),
            metallic=0.86,
            roughness=0.32,
            coat=0.15,
        ),
        # Polished Chrome-Steel Hydraulic Piston Rods, Couplers & Muzzle Rings
        "chrome_piston": make_solid_pbr_mat(
            "Mat_Codex_ChromePiston",
            base_color=(0.36, 0.39, 0.38),
            metallic=0.95,
            roughness=0.18,
            coat=0.22,
        ),
        # Dark Carbon-Steel Ribs, Vanes, Radiator Louvers & Exhaust Baffles
        "dark_machinery": make_solid_pbr_mat(
            "Mat_Codex_DarkMachinery",
            base_color=(0.032, 0.038, 0.036),
            metallic=0.80,
            roughness=0.38,
        ),
        # Deep Pitch-Dark Shadow Cavities, Intake Throats & Seam Trenches
        "cavity_dark": make_solid_pbr_mat(
            "Mat_Codex_CavityDark",
            base_color=(0.006, 0.008, 0.008),
            metallic=0.35,
            roughness=0.66,
        ),
        # Smoked Translucent Armored Panoramic Bridge Canopy Glass (reveals subtle interior console!)
        "bridge_glass": make_solid_pbr_mat(
            "Mat_Codex_BridgeGlass",
            base_color=(0.010, 0.016, 0.018),
            metallic=0.24,
            roughness=0.045,
            coat=1.00,
            coat_rough=0.02,
            alpha=0.80,
            emission_color=(0.008, 0.018, 0.016),
            emission_strength=0.03,
        ),
        # Subtle Stencil Marking Paint (muted warm off-white hull identification bars)
        "stencil_paint": make_solid_pbr_mat(
            "Mat_Codex_StencilPaint",
            base_color=(0.56, 0.58, 0.54),
            metallic=0.15,
            roughness=0.52,
        ),
        # Tactical Warm-White Hull Running Slits & Bridge Brow Lights
        "warm_light": make_solid_pbr_mat(
            "Mat_Codex_WarmTacticalLight",
            base_color=(1.0, 0.92, 0.78),
            metallic=0.0,
            roughness=0.16,
            emission_color=(1.0, 0.86, 0.64),
            emission_strength=3.6,
        ),
        # Subtle Soft-Teal Cockpit Console Instrument Pip (visible faintly behind smoked glass!)
        "cockpit_hud": make_solid_pbr_mat(
            "Mat_Codex_CockpitHUD",
            base_color=(0.18, 0.72, 0.62),
            metallic=0.0,
            roughness=0.20,
            emission_color=(0.12, 0.68, 0.58),
            emission_strength=1.8,
        ),
        # AgX-Calibrated Deep Fiery Amber-Orange Stern Thruster Chamber Glow
        "amber_glow": make_solid_pbr_mat(
            "Mat_Codex_EngineAmberGlow",
            base_color=(1.0, 0.22, 0.015),
            metallic=0.0,
            roughness=0.18,
            emission_color=(1.0, 0.18, 0.01),
            emission_strength=2.6,
        ),
        # AgX-Calibrated Incandescent Molten-Orange Inner Thruster Core
        "amber_core": make_solid_pbr_mat(
            "Mat_Codex_EngineHotCore",
            base_color=(1.0, 0.42, 0.04),
            metallic=0.0,
            roughness=0.12,
            emission_color=(1.0, 0.34, 0.025),
            emission_strength=3.8,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Hard-Surface BMesh Modeling Helpers
# ---------------------------------------------------------------------------

def apply_world_box_uv(bm, tile_meters=6.2):
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


def finalize_mesh(
    bm,
    name,
    mat,
    collection,
    bevel_offset=0.0,
    bevel_segments=2,
    smooth=True,
    sharp_angle_deg=35.0,
    parent=None,
    uv_tile_m=6.2,
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

    apply_world_box_uv(bm, tile_meters=uv_tile_m)

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    if mat is not None:
        mesh.materials.append(mat)

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, collection)
    if parent is not None:
        obj.parent = parent
    return obj


def add_beveled_box(
    name, center, size, mat, col,
    bevel=0.025, bevel_segments=2, rot=(0.0, 0.0, 0.0),
    smooth=True, sharp_angle_deg=36.0, parent=None,
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
    return finalize_mesh(bm, name, mat, col, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent)


def add_cylinder(
    name, center, radius, depth, mat, col,
    segments=24, rot=(0.0, 0.0, 0.0), bevel=0.012,
    radius2=None, smooth=True, sharp_angle_deg=36.0, parent=None,
):
    bm = bmesh.new()
    r2 = radius if radius2 is None else radius2
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=r2, depth=depth,
    )
    if bevel > 0.0:
        b = min(bevel, min(radius, r2) * 0.30, depth * 0.30)
        if b > 1e-4:
            bmesh.ops.bevel(
                bm, geom=list(bm.edges), offset=b, offset_type="OFFSET",
                segments=2, profile=0.5, affect="EDGES", clamp_overlap=True,
            )
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent)


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
        smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


def add_extruded_poly_y(
    name, pts_xz, y0, y1, mat, col,
    bevel=0.025, bevel_segments=2, scale0=1.0, scale1=1.0,
    offset0=(0.0, 0.0), offset1=(0.0, 0.0), smooth=True, parent=None,
):
    cx = sum(p[0] for p in pts_xz) / len(pts_xz)
    cz = sum(p[1] for p in pts_xz) / len(pts_xz)
    r0 = [(cx + (x - cx) * scale0 + offset0[0], y0, cz + (z - cz) * scale0 + offset0[1]) for x, z in pts_xz]
    r1 = [(cx + (x - cx) * scale1 + offset1[0], y1, cz + (z - cz) * scale1 + offset1[1]) for x, z in pts_xz]
    return add_lofted_sections(
        name, [r0, r1], mat, col,
        bevel=bevel, bevel_segments=bevel_segments, smooth=smooth, parent=parent,
    )


def add_extruded_poly_z(
    name, pts_xy, z0, z1, mat, col,
    bevel=0.025, bevel_segments=2, scale0=1.0, scale1=1.0,
    smooth=True, parent=None,
):
    cx = sum(p[0] for p in pts_xy) / len(pts_xy)
    cy = sum(p[1] for p in pts_xy) / len(pts_xy)
    r0 = [(cx + (x - cx) * scale0, cy + (y - cy) * scale0, z0) for x, y in pts_xy]
    r1 = [(cx + (x - cx) * scale1, cy + (y - cy) * scale1, z1) for x, y in pts_xy]
    return add_lofted_sections(
        name, [r0, r1], mat, col,
        bevel=bevel, bevel_segments=bevel_segments, smooth=smooth, parent=parent,
    )


def add_extruded_poly_x(
    name, pts_yz, x0, x1, mat, col,
    bevel=0.025, bevel_segments=2, smooth=True, parent=None,
):
    r0 = [(x0, y, z) for y, z in pts_yz]
    r1 = [(x1, y, z) for y, z in pts_yz]
    return add_lofted_sections(
        name, [r0, r1], mat, col,
        bevel=bevel, bevel_segments=bevel_segments, smooth=smooth, parent=parent,
    )


def add_hollow_frame_y(
    name, outer_xz, inner_xz, y_back, y_front, mat, col,
    bevel=0.018, bevel_segments=1, smooth=True, parent=None,
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


def add_hollow_ring_z(
    name, cx, cy, z0, z1, r_out, r_in, mat, col,
    segments=48, bevel=0.015, smooth=True, parent=None,
):
    bm = bmesh.new()
    ob, ot, ib, it = [], [], [], []
    for s in range(segments):
        a = 2.0 * math.pi * s / segments
        ca, sa = math.cos(a), math.sin(a)
        ob.append(bm.verts.new((cx + r_out * ca, cy + r_out * sa, z0)))
        ot.append(bm.verts.new((cx + r_out * ca, cy + r_out * sa, z1)))
        ib.append(bm.verts.new((cx + r_in * ca, cy + r_in * sa, z0)))
        it.append(bm.verts.new((cx + r_in * ca, cy + r_in * sa, z1)))
    for i in range(segments):
        ni = (i + 1) % segments
        bm.faces.new((ob[i], ob[ni], ot[ni], ot[i]))
        bm.faces.new((it[i], it[ni], ib[ni], ib[i]))
        bm.faces.new((ot[i], ot[ni], it[ni], it[i]))
        bm.faces.new((ob[i], ib[i], ib[ni], ob[ni]))
    return finalize_mesh(
        bm, name, mat, col,
        bevel_offset=bevel, bevel_segments=1,
        smooth=smooth, sharp_angle_deg=36.0, parent=parent,
    )


def add_bezelled_light(name, center, size, mats, col, normal_axis="+X", parent=None):
    """Add a recessed dark metallic bezel housing with a crisp warm-white tactical LED slit inside."""
    cx, cy, cz = center
    sx, sy, sz = size
    pad = 0.032
    bx, by, bz = sx + pad, sy + pad, sz + pad
    dx = dy = dz = 0.0
    if normal_axis == "+X":
        dx, bx = -0.015, sx + 0.02
    elif normal_axis == "-X":
        dx, bx =  0.015, sx + 0.02
    elif normal_axis == "+Y":
        dy, by = -0.015, sy + 0.02
    elif normal_axis == "-Y":
        dy, by =  0.015, sy + 0.02
    elif normal_axis == "+Z":
        dz, bz = -0.015, sz + 0.02
    elif normal_axis == "-Z":
        dz, bz =  0.015, sz + 0.02

    add_beveled_box(
        f"{name}_Bezel", (cx + dx, cy + dy, cz + dz), (bx, by, bz),
        mats["cavity_dark"], col, bevel=0.005, bevel_segments=1, parent=parent,
    )
    add_beveled_box(
        name, center, size,
        mats["warm_light"], col, bevel=0.004, bevel_segments=1, parent=parent,
    )


def add_rcs_cluster(name, center, mats, col, rot=(0.0, 0.0, 0.0), scale=1.0, parent=None):
    """Add a compact 4-nozzle recessed military RCS maneuvering thruster block."""
    bm = bmesh.new()
    # Outer beveled armored housing block
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= 0.24 * scale
        v.co.y *= 0.34 * scale
        v.co.z *= 0.12 * scale
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=0.018 * scale, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES", clamp_overlap=True)
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    finalize_mesh(bm, f"{name}_Housing", mats["steel_trim"], col, parent=parent)

    # 2 dark recessed thruster cups on face
    mat_r = Euler(rot, "XYZ").to_matrix()
    for dy_local in (-0.075 * scale, 0.075 * scale):
        offset_w = mat_r @ Vector((0.0, dy_local, 0.052 * scale))
        add_cylinder(
            f"{name}_Noz_{dy_local:+.2f}", tuple(Vector(center) + offset_w),
            0.036 * scale, 0.045 * scale, mats["cavity_dark"], col,
            segments=10, rot=rot, bevel=0.005, radius2=0.022 * scale, parent=parent,
        )


def ensure_ccw_2d(pts):
    area = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        area += x0 * y1 - x1 * y0
    return pts if area >= 0.0 else list(reversed(pts))


def chamfered_rect_xz(cx, cz, hw, hh, ch):
    return [
        (cx - hw + ch, cz + hh),
        (cx + hw - ch, cz + hh),
        (cx + hw, cz + hh - ch),
        (cx + hw, cz - hh + ch),
        (cx + hw - ch, cz - hh),
        (cx - hw + ch, cz - hh),
        (cx - hw, cz - hh + ch),
        (cx - hw, cz + hh - ch),
    ]


def vertical_hex8_xz(cx, cz, hw, hh, cap_w, shoulder_h):
    """Blunt-tipped vertical 8-sided military hexagon (flat narrow peak top & bottom)."""
    return [
        (cx - cap_w, cz + hh),
        (cx + cap_w, cz + hh),
        (cx + hw,    cz + shoulder_h),
        (cx + hw,    cz - shoulder_h),
        (cx + cap_w, cz - hh),
        (cx - cap_w, cz - hh),
        (cx - hw,    cz - shoulder_h),
        (cx - hw,    cz + shoulder_h),
    ]


# ---------------------------------------------------------------------------
# 4. Collection 01: Core Gunmetal Chassis, Deep Industrial Waists & Ventral Keel
# ---------------------------------------------------------------------------

def build_core_chassis_and_keel(mats, col, root):
    # 1A. Watertight Octagonal Structural Core Spine (Stern Y=-9.95 to Bow Y=+9.55)
    core_stations = [
        (-9.95, 2.25,  2.15, -2.05, 0.35),
        (-6.20, 2.55,  2.25, -2.12, 0.38),
        (-4.60, 2.82,  2.20, -2.16, 0.38),
        ( 1.90, 2.82,  2.20, -2.16, 0.38),
        ( 3.70, 2.42,  2.08, -2.02, 0.34),
        ( 6.80, 2.08,  1.96, -1.88, 0.30),
        ( 8.80, 1.66,  1.88, -1.62, 0.25),
        ( 9.55, 1.46,  1.72, -1.20, 0.22),
    ]
    core_secs = []
    for y, hw, zt, zb, ch in core_stations:
        cz = 0.5 * (zt + zb)
        hh = 0.5 * (zt - zb)
        pts = chamfered_rect_xz(0.0, cz, hw, hh, ch)
        core_secs.append([(x, y, z) for x, z in pts])
    add_lofted_sections(
        "Chassis_MainCoreSpine", core_secs, mats["gunmetal_chassis"], col,
        bevel=0.03, bevel_segments=1, smooth=True, parent=root,
    )

    # 1B. Deep Industrial Forward Mechanical Waist Bays (Y = +2.10 .. +3.95)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Waist_FwdRecessCore_{tag}", (side * 2.55, 3.02, -0.55), (1.35, 1.88, 2.78),
            mats["cavity_dark"], col, bevel=0.02, parent=root,
        )
        # 4 sculpted horizontal armored manifold drums with recessed louver slots & chrome collars
        for idx, zc in enumerate((-1.72, -0.96, -0.14, 0.58)):
            add_beveled_box(
                f"Waist_FwdBlock_{tag}_{idx}", (side * 2.94, 3.04, zc), (0.76, 1.50, 0.58),
                mats["gunmetal_chassis"], col, bevel=0.032, parent=root,
            )
            add_beveled_box(
                f"Waist_FwdCollar_{tag}_{idx}", (side * 3.24, 3.04, zc), (0.28, 0.78, 0.38),
                mats["steel_trim"], col, bevel=0.02, parent=root,
            )
            # Horizontal cooling vane rib inside each waist manifold bay
            add_beveled_box(
                f"Waist_FwdRib_{tag}_{idx}", (side * 3.32, 3.04, zc + 0.10), (0.14, 1.32, 0.06),
                mats["dark_machinery"], col, bevel=0.008, parent=root,
            )
            add_beveled_box(
                f"Waist_FwdRibB_{tag}_{idx}", (side * 3.32, 3.04, zc - 0.10), (0.14, 1.32, 0.06),
                mats["dark_machinery"], col, bevel=0.008, parent=root,
            )
        # Heavy structural vertical spine bulkhead + twin chrome hydraulic shock rams w/ clevis mounts!
        add_beveled_box(
            f"Waist_FwdPillar_{tag}", (side * 3.10, 2.48, -0.52), (0.62, 0.32, 2.70),
            mats["dark_machinery"], col, bevel=0.02, parent=root,
        )
        add_beveled_box(
            f"Waist_FwdRearPillar_{tag}", (side * 3.10, 3.60, -0.52), (0.58, 0.28, 2.66),
            mats["dark_machinery"], col, bevel=0.02, parent=root,
        )
        for py in (2.78, 3.34):
            # Outer sleeve (upper half) + exposed chrome piston rod (lower half) + end clevis collars
            add_cylinder(
                f"Waist_FwdSleeve_{tag}_{py:.2f}", (side * 3.24, py, 0.02), 0.115, 1.28,
                mats["steel_trim"], col, segments=16, bevel=0.012, parent=root,
            )
            add_cylinder(
                f"Waist_FwdRod_{tag}_{py:.2f}", (side * 3.24, py, -1.12), 0.072, 1.35,
                mats["chrome_piston"], col, segments=16, bevel=0.008, parent=root,
            )
            for cz_c in (-1.78, -0.58, 0.64):
                add_cylinder(
                    f"Waist_FwdCoupler_{tag}_{py:.2f}_{cz_c:+.1f}", (side * 3.24, py, cz_c), 0.14, 0.14,
                    mats["dark_machinery"], col, segments=16, bevel=0.01, parent=root,
                )
        # Upper waist manifold beam + horizontal coolant pipe bundle
        add_beveled_box(
            f"Waist_FwdUpperHeader_{tag}", (side * 2.92, 3.05, 1.05), (0.94, 1.96, 0.56),
            mats["dark_machinery"], col, bevel=0.025, parent=root,
        )
        for zp in (0.94, 1.14):
            add_cylinder(
                f"Waist_FwdPipe_{tag}_{zp:.2f}", (side * 3.36, 3.04, zp), 0.065, 1.88,
                mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
            )

    # 1C. Aft Mechanical Waist / Engine Feed Conduit Bays (Y = -6.30 .. -4.95)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Waist_AftBridgeCore_{tag}", (side * 2.88, -5.60, -0.45), (1.75, 1.50, 3.10),
            mats["gunmetal_chassis"], col, bevel=0.03, parent=root,
        )
        add_beveled_box(
            f"Waist_AftDarkRecess_{tag}", (side * 3.68, -5.62, 0.42), (0.60, 1.20, 1.62),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for r_i in range(6):
            zr = -0.25 + r_i * 0.27
            add_beveled_box(
                f"Waist_AftFin_{tag}_{r_i}", (side * 3.84, -5.62, zr), (0.36, 1.12, 0.095),
                mats["steel_trim"], col, bevel=0.01, parent=root,
            )
        # Bundled metallic propellant feed pipes bridging from mid-pod into outboard nacelle!
        for z_pipe in (-1.65, -1.32, -0.98):
            add_cylinder(
                f"Waist_AftFuelPipe_{tag}_{z_pipe:+.2f}", (side * 3.92, -5.62, z_pipe), 0.11, 1.38,
                mats["steel_trim"], col, segments=14, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.01, parent=root,
            )
            add_cylinder(
                f"Waist_AftFuelClamp_{tag}_{z_pipe:+.2f}", (side * 3.92, -5.62, z_pipe), 0.145, 0.22,
                mats["dark_machinery"], col, segments=14, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.01, parent=root,
            )
        add_beveled_box(
            f"Waist_AftLowerPylon_{tag}", (side * 3.55, -5.65, -1.62), (0.85, 1.34, 1.24),
            mats["olive_dark"], col, bevel=0.03, parent=root,
        )

    # 1D. High-Detail Dorsal Lateral Radiator Trenches (Y = -4.85 .. +1.25, 8 Arched Bays + Twin Pipes!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Dorsal_RadiatorTrough_{tag}", (side * 3.12, -1.80, 1.08), (1.08, 6.24, 0.62),
            mats["cavity_dark"], col, bevel=0.02, parent=root,
        )
        # Twin continuous longitudinal coolant rails running full length of trench
        for dx_p in (2.82, 3.38):
            add_cylinder(
                f"Dorsal_TrenchLongPipe_{tag}_{dx_p:.2f}", (side * dx_p, -1.80, 1.40), 0.075, 5.95,
                mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
            )
        # 8 sculpted T-section radiator arches + intermediate louver grilles
        for k in range(8):
            yk = -4.38 + k * 0.73
            add_beveled_box(
                f"Dorsal_RadiatorArch_{tag}_{k}", (side * 3.14, yk, 1.32), (0.98, 0.26, 0.34),
                mats["gunmetal_chassis"], col, bevel=0.02, parent=root,
            )
            add_beveled_box(
                f"Dorsal_RadiatorCap_{tag}_{k}", (side * 3.14, yk, 1.48), (0.84, 0.14, 0.10),
                mats["olive_dark"], col, bevel=0.012, parent=root,
            )
            if k < 7:
                # Slatted dark heat-exchanger grating between structural arches
                for sub_y in (-0.14, 0.0, 0.14):
                    add_beveled_box(
                        f"Dorsal_RadiatorGrate_{tag}_{k}_{sub_y:+.2f}", (side * 3.12, yk + 0.365 + sub_y, 1.24),
                        (0.86, 0.055, 0.08), mats["dark_machinery"], col, bevel=0.006, parent=root,
                    )

    # 1E. Ultra-Detailed Ventral Armored Keel, Umbilical Bay & Cylindrical-Ram Actuator Underbelly
    add_beveled_box(
        "Ventral_CentralSpineAft", (0.0, -7.25, -2.18), (2.26, 4.75, 0.72),
        mats["gunmetal_chassis"], col, bevel=0.04, parent=root,
    )
    add_beveled_box(
        "Ventral_CentralSpineAftPlate", (0.0, -7.65, -2.52), (1.44, 3.70, 0.24),
        mats["olive_dark"], col, bevel=0.028, parent=root,
    )
    add_beveled_box(
        "Ventral_CentralSpineMid", (0.0, -1.65, -2.42), (1.94, 6.75, 0.86),
        mats["gunmetal_chassis"], col, bevel=0.045, parent=root,
    )
    add_beveled_box(
        "Ventral_CentralSpineRidge", (0.0, -2.05, -2.62), (1.28, 5.20, 0.52),
        mats["olive_dark"], col, bevel=0.035, parent=root,
    )
    add_beveled_box(
        "Ventral_CentralSpineFwdPlate", (0.0, 3.25, -2.26), (2.68, 3.65, 0.72),
        mats["gunmetal_chassis"], col, bevel=0.04, parent=root,
    )
    # Recessed ventral cargo/docking umbilical hatches with armored latch bars!
    for idx, (yc, ly, lx) in enumerate(((-5.25, 1.75, 1.36), (-1.45, 2.20, 1.08), (0.95, 1.48, 1.28))):
        add_beveled_box(
            f"Ventral_KeelHatch_{idx}", (0.0, yc, -2.76), (lx, ly, 0.22),
            mats["steel_trim"], col, bevel=0.025, parent=root,
        )
        add_beveled_box(
            f"Ventral_KeelHatchRecess_{idx}", (0.0, yc, -2.84), (lx * 0.68, ly * 0.72, 0.12),
            mats["dark_machinery"], col, bevel=0.015, parent=root,
        )
        for dy_l in (-ly * 0.34, ly * 0.34):
            add_beveled_box(
                f"Ventral_KeelLatch_{idx}_{dy_l:+.2f}", (0.0, yc + dy_l, -2.86), (lx * 0.84, 0.14, 0.10),
                mats["olive_dark"], col, bevel=0.01, parent=root,
            )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Longitudinal ventral armored power conduits flanking central keel
        add_cylinder(
            f"Ventral_SpineConduit_{tag}", (side * 0.88, -2.85, -2.64), 0.085, 11.4,
            mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
        )
        add_beveled_box(
            f"Ventral_BayFrameFwd_{tag}", (side * 2.18, 0.55, -2.35), (1.68, 1.65, 0.62),
            mats["gunmetal_chassis"], col, bevel=0.035, parent=root,
        )
        add_beveled_box(
            f"Ventral_BayFrameAft_{tag}", (side * 2.18, -3.75, -2.35), (1.68, 1.65, 0.62),
            mats["gunmetal_chassis"], col, bevel=0.035, parent=root,
        )
        add_beveled_box(
            f"Ventral_BayRecess_{tag}", (side * 2.18, -1.60, -2.14), (1.62, 2.85, 0.36),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        # 3 detailed cylindrical hydraulic actuator rams + armored sleeves in each ventral bay!
        for k, yk in enumerate((-2.45, -1.60, -0.75)):
            add_cylinder(
                f"Ventral_ActuatorSleeve_{tag}_{k}", (side * 2.48, yk, -2.40), 0.15, 0.72,
                mats["gunmetal_chassis"], col, segments=16, rot=(0.0, math.pi * 0.5, 0.0), bevel=0.015, parent=root,
            )
            add_cylinder(
                f"Ventral_ActuatorRod_{tag}_{k}", (side * 1.82, yk, -2.40), 0.095, 0.85,
                mats["chrome_piston"], col, segments=16, rot=(0.0, math.pi * 0.5, 0.0), bevel=0.01, parent=root,
            )
            add_beveled_box(
                f"Ventral_ActuatorBracketIn_{tag}_{k}", (side * 1.46, yk, -2.38), (0.28, 0.36, 0.34),
                mats["steel_trim"], col, bevel=0.018, parent=root,
            )
            add_beveled_box(
                f"Ventral_ActuatorBracketOut_{tag}_{k}", (side * 2.86, yk, -2.38), (0.30, 0.40, 0.36),
                mats["dark_machinery"], col, bevel=0.018, parent=root,
            )
        # Aft ventral transverse structural cross-ribs & landing pads
        for k, yk in enumerate((-5.85, -7.15, -8.45)):
            add_beveled_box(
                f"Ventral_AftRib_{tag}_{k}", (side * 1.56, yk, -2.38), (0.94, 0.34, 0.28),
                mats["steel_trim"], col, bevel=0.02, parent=root,
            )
            add_beveled_box(
                f"Ventral_AftRibClamp_{tag}_{k}", (side * 1.56, yk, -2.50), (0.44, 0.42, 0.12),
                mats["dark_machinery"], col, bevel=0.012, parent=root,
            )
        add_beveled_box(
            f"Ventral_WaistSkid_{tag}", (side * 2.02, 3.05, -2.28), (1.36, 1.56, 0.58),
            mats["gunmetal_chassis"], col, bevel=0.03, parent=root,
        )


# ---------------------------------------------------------------------------
# 5. Collection 02: Hero Forward Bridge Canopy, Cockpit Interior & Chin Cradle
# ---------------------------------------------------------------------------

def build_forward_bridge_and_chin(mats, col, root):
    # 2A. Faceted Multi-Layered Overhanging Upper Bridge Brow (Y = +8.50 .. +11.00)
    brow_secs = [
        ( 8.50, 2.08, 2.24, 2.34, 1.82),
        ( 9.85, 1.84, 1.98, 2.26, 1.80),
        (10.75, 1.62, 1.72, 2.18, 1.76),
        (11.00, 1.46, 1.50, 2.08, 1.82),
    ]
    rings = [
        [(-hwt, y, zt), (hwt, y, zt), (hwb, y, zb), (-hwb, y, zb)]
        for y, hwt, hwb, zt, zb in brow_secs
    ]
    add_lofted_sections(
        "Bridge_UpperArmorBrow", rings, mats["olive_armor"], col,
        bevel=0.035, bevel_segments=2, smooth=True, parent=root,
    )

    # Stepped brow top recessed deck well + louvered breather vents + corner eyebrow armor plates
    add_beveled_box(
        "Bridge_TopDeckRecess", (0.0, 10.18, 2.20), (1.88, 1.18, 0.14),
        mats["olive_dark"], col, bevel=0.02, parent=root,
    )
    add_beveled_box(
        "Bridge_TopFrontRim", (0.0, 10.72, 2.20), (2.74, 0.24, 0.16),
        mats["olive_light"], col, bevel=0.022, parent=root,
    )
    # Recessed micro louvers inside bow top well
    for k in range(4):
        add_beveled_box(
            f"Bridge_TopWellLouver_{k}", (0.0, 9.86 + k * 0.20, 2.26), (1.24, 0.08, 0.06),
            mats["dark_machinery"], col, bevel=0.008, parent=root,
        )
    # Subtle off-white tactical bow stencil stripe (matches Hero bow edge marking!)
    add_beveled_box(
        "Bridge_BowStencilBar", (-1.18, 10.74, 2.12), (0.34, 0.06, 0.04),
        mats["stencil_paint"], col, bevel=0.004, parent=root,
    )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_BrowSensorRail_{tag}", (side * 0.96, 9.95, 2.35), (0.26, 1.28, 0.18),
            mats["olive_armor"], col, bevel=0.02, parent=root,
        )
        add_beveled_box(
            f"Bridge_BrowSensorOptic_{tag}", (side * 0.96, 10.60, 2.34), (0.16, 0.10, 0.12),
            mats["steel_trim"], col, bevel=0.01, parent=root,
        )
        # Layered corner armored eyebrow plates overhanging bridge A-pillars
        add_beveled_box(
            f"Bridge_BrowCornerPlate_{tag}", (side * 1.46, 10.35, 1.78), (0.50, 0.78, 0.16),
            mats["olive_dark"], col, bevel=0.02, parent=root,
        )

    # 2B. Translucent Smoked Panoramic Bridge Canopy w/ Interior Deck, Consoles & Heavy Mullions!
    add_beveled_box(
        "Bridge_InteriorBulkhead", (0.0, 9.52, 1.32), (2.78, 0.85, 0.96),
        mats["cavity_dark"], col, bevel=0.02, parent=root,
    )
    add_beveled_box(
        "Bridge_InteriorFloor", (0.0, 10.02, 0.92), (2.46, 0.92, 0.12),
        mats["dark_machinery"], col, bevel=0.01, parent=root,
    )
    # Interior cockpit helm console + twin pilot seat silhouettes + subtle HUD instrument glow!
    add_beveled_box(
        "Bridge_HelmConsole", (0.0, 10.16, 1.08), (2.06, 0.36, 0.24),
        mats["gunmetal_chassis"], col, bevel=0.018, parent=root,
    )
    for sx_h in (-0.68, 0.0, 0.68):
        add_beveled_box(
            f"Bridge_ConsoleHUD_{sx_h:+.2f}", (sx_h, 10.12, 1.21), (0.42, 0.08, 0.05),
            mats["cockpit_hud"], col, bevel=0.005, rot=(-0.45, 0.0, 0.0), parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_PilotSeat_{tag}", (side * 0.64, 9.76, 1.26), (0.36, 0.24, 0.48),
            mats["dark_machinery"], col, bevel=0.02, parent=root,
        )

    # Clean flat-faceted smoked panoramic glass panes
    canopy_top = [
        (-1.58,  9.20, 1.80),
        (-1.68, 10.32, 1.78),
        (-1.38, 10.78, 1.76),
        ( 1.38, 10.78, 1.76),
        ( 1.68, 10.32, 1.78),
        ( 1.58,  9.20, 1.80),
    ]
    canopy_bot = [
        (-1.42,  9.20, 0.88),
        (-1.48, 10.00, 0.88),
        (-1.18, 10.32, 0.88),
        ( 1.18, 10.32, 0.88),
        ( 1.48, 10.00, 0.88),
        ( 1.42,  9.20, 0.88),
    ]
    add_lofted_sections(
        "Bridge_CanopyGlassShell", [canopy_bot, canopy_top], mats["bridge_glass"], col,
        bevel=0.0, smooth=False, sharp_angle_deg=18.0, parent=root,
    )

    # Recessed upper dark light-trough & armored window frame mullions (A-pillars + center-flank struts!)
    add_beveled_box(
        "Bridge_BrowLightTrough", (0.0, 10.66, 1.755), (2.74, 0.14, 0.075),
        mats["cavity_dark"], col, bevel=0.008, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Primary heavy corner A-pillar
        p0 = Vector((side * 1.22, 10.33, 0.86))
        p1 = Vector((side * 1.42, 10.78, 1.80))
        mid = (p0 + p1) * 0.5
        diff = p1 - p0
        pitch = math.atan2(diff.y, diff.z)
        add_beveled_box(
            f"Bridge_APillar_{tag}", tuple(mid), (0.14, 0.14, diff.length + 0.06),
            mats["dark_machinery"], col, bevel=0.015, rot=(-pitch, side * 0.18, 0.0), parent=root,
        )
        # Secondary thin inner windscreen structural divider strut
        q0 = Vector((side * 0.64, 10.33, 0.86))
        q1 = Vector((side * 0.72, 10.78, 1.78))
        qmid = (q0 + q1) * 0.5
        qdiff = q1 - q0
        qpitch = math.atan2(qdiff.y, qdiff.z)
        add_beveled_box(
            f"Bridge_InnerMullion_{tag}", tuple(qmid), (0.065, 0.08, qdiff.length + 0.04),
            mats["steel_trim"], col, bevel=0.008, rot=(-qpitch, side * 0.08, 0.0), parent=root,
        )
        # Side quarter-glass rear cheek & angled armor frame
        add_beveled_box(
            f"Bridge_RearCheekFrame_{tag}", (side * 1.68, 9.02, 1.32), (0.38, 0.68, 1.12),
            mats["olive_armor"], col, bevel=0.03, parent=root,
        )
        add_beveled_box(
            f"Bridge_SideMullion_{tag}", (side * 1.59, 9.65, 1.33), (0.08, 0.10, 0.94),
            mats["dark_machinery"], col, bevel=0.01, rot=(0.0, -side * 0.16, 0.0), parent=root,
        )

    # 8 ultra-crisp micro warm-white overhead brow slits clearly visible under brow lip (Hero signature!)
    for i in range(8):
        lx = -1.16 + i * 0.33
        add_beveled_box(
            f"Bridge_BrowLight_{i}", (lx, 10.77, 1.735), (0.21, 0.055, 0.036),
            mats["warm_light"], col, bevel=0.004, parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_SideBrowLight_{tag}", (side * 1.68, 9.88, 1.735), (0.048, 0.66, 0.036),
            mats["warm_light"], col, bevel=0.004, parent=root,
        )

    # 2C. Heavy Armored Lower Bridge Chin Sill & Side Guard
    sill_secs = [
        ( 8.10, 2.02, 1.88, 0.92, 0.36),
        ( 9.55, 1.78, 1.64, 0.92, 0.38),
        (10.35, 1.54, 1.36, 0.92, 0.42),
        (10.55, 1.28, 1.14, 0.84, 0.48),
    ]
    sill_rings = [
        [(-hwt, y, zt), (hwt, y, zt), (hwb, y, zb), (-hwb, y, zb)]
        for y, hwt, hwb, zt, zb in sill_secs
    ]
    add_lofted_sections(
        "Bridge_LowerArmorSill", sill_rings, mats["olive_armor"], col,
        bevel=0.035, bevel_segments=2, smooth=True, parent=root,
    )
    # Recessed dark center plate + twin square sensor bezels on front bridge sill (Front Ortho!)
    add_beveled_box(
        "Bridge_SillCenterRecess", (0.0, 10.48, 0.64), (1.14, 0.14, 0.24),
        mats["olive_dark"], col, bevel=0.015, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_SillTab_{tag}", (side * 0.86, 10.48, 0.64), (0.28, 0.16, 0.22),
            mats["olive_light"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"Bridge_SillTabCore_{tag}", (side * 0.86, 10.56, 0.64), (0.14, 0.06, 0.10),
            mats["cavity_dark"], col, bevel=0.008, parent=root,
        )
        add_beveled_box(
            f"Bridge_SideGuardRail_{tag}", (side * 1.92, 8.65, 0.66), (0.40, 1.48, 0.56),
            mats["olive_armor"], col, bevel=0.03, parent=root,
        )
        add_beveled_box(
            f"Bridge_SideGuardClamp_{tag}", (side * 2.10, 8.65, 0.66), (0.12, 0.42, 0.34),
            mats["olive_dark"], col, bevel=0.015, parent=root,
        )

    # 2D. Under-Bridge Mechanical Intake Bay & Bezelled Headlight Crossbeam
    add_beveled_box(
        "Chin_UpperMechBay", (0.0, 8.65, -0.15), (2.72, 2.25, 1.05),
        mats["cavity_dark"], col, bevel=0.02, parent=root,
    )
    add_beveled_box(
        "Chin_InnerIntakeCenter", (0.0, 9.44, -0.18), (1.84, 0.72, 0.78),
        mats["gunmetal_chassis"], col, bevel=0.03, parent=root,
    )
    # Recessed horizontal radiator louvers + twin armored sensor optics under bridge sill (Front Ortho!)
    for lv_z in (-0.42, -0.22, -0.02, 0.18):
        add_beveled_box(
            f"Chin_UpperLouver_{lv_z:+.2f}", (0.0, 9.74, lv_z), (1.46, 0.18, 0.06),
            mats["steel_trim"], col, bevel=0.008, parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Chin_InnerSensorBox_{tag}", (side * 0.60, 9.70, -0.32), (0.58, 0.40, 0.48),
            mats["dark_machinery"], col, bevel=0.025, parent=root,
        )
        add_cylinder(
            f"Chin_InnerSensorOptic_{tag}", (side * 0.60, 9.90, -0.32), 0.11, 0.10,
            mats["steel_trim"], col, segments=16, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.01, parent=root,
        )
        add_cylinder(
            f"Chin_InnerHydraulic_{tag}", (side * 1.18, 9.52, -0.16), 0.08, 0.96,
            mats["chrome_piston"], col, segments=12, bevel=0.008, parent=root,
        )
        add_beveled_box(
            f"Chin_SideWallGuard_{tag}", (side * 1.46, 8.92, -0.30), (0.34, 1.65, 1.38),
            mats["olive_dark"], col, bevel=0.025, parent=root,
        )

    # Green Horizontal Chin Crossbeam w/ Recessed Twin Headlights & Corner Tow Shackles
    add_beveled_box(
        "Chin_HeadlightCrossbeam", (0.0, 9.25, -0.92), (3.14, 1.26, 0.52),
        mats["olive_armor"], col, bevel=0.035, parent=root,
    )
    add_beveled_box(
        "Chin_HeadlightCenterPlate", (0.0, 9.86, -0.92), (0.34, 0.14, 0.44),
        mats["olive_dark"], col, bevel=0.015, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Chin_HeadlightHousing_{tag}", (side * 0.68, 9.86, -0.92), (0.82, 0.12, 0.18),
            mats["cavity_dark"], col, bevel=0.01, parent=root,
        )
        add_beveled_box(
            f"Chin_HeadlightBar_{tag}", (side * 0.68, 9.90, -0.92), (0.70, 0.055, 0.092),
            mats["warm_light"], col, bevel=0.006, parent=root,
        )
        # Micro protective grille bars across headlights + corner tow shackles
        for dx_g in (-0.18, 0.18):
            add_beveled_box(
                f"Chin_HeadlightBarGuard_{tag}_{dx_g:+.2f}", (side * 0.68 + dx_g, 9.93, -0.92), (0.028, 0.04, 0.14),
                mats["dark_machinery"], col, bevel=0.003, parent=root,
            )
        add_beveled_box(
            f"Chin_CrossbeamShackle_{tag}", (side * 1.38, 9.86, -0.92), (0.18, 0.18, 0.28),
            mats["steel_trim"], col, bevel=0.015, parent=root,
        )

    # 2E. Ultra-Detailed Multi-Tiered Dark Gunmetal Ventral Chin Docking / Sensor Cradle
    add_beveled_box(
        "Chin_VentralUpperBlock", (0.0, 8.20, -1.68), (2.78, 2.95, 1.05),
        mats["gunmetal_chassis"], col, bevel=0.045, parent=root,
    )
    chin_sled_pts_yz = [
        ( 4.95, -2.08),
        ( 9.25, -2.02),
        ( 9.62, -2.42),
        ( 9.20, -3.12),
        ( 8.65, -3.56),
        ( 5.85, -3.50),
        ( 5.05, -2.85),
    ]
    add_extruded_poly_x(
        "Chin_VentralLowerSled", chin_sled_pts_yz, -1.12, 1.12,
        mats["gunmetal_chassis"], col, bevel=0.045, bevel_segments=2, parent=root,
    )
    # Sculpted mechanical front sensor/clamp head (Front Ortho focal centerpiece!)
    add_beveled_box(
        "Chin_FrontClampBase", (0.0, 9.42, -1.86), (2.28, 0.52, 0.62),
        mats["gunmetal_chassis"], col, bevel=0.035, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Chin_FrontClampCheek_{tag}", (side * 0.72, 9.62, -1.86), (0.76, 0.30, 0.50),
            mats["steel_trim"], col, bevel=0.025, parent=root,
        )
        add_cylinder(
            f"Chin_FrontSensorLens_{tag}", (side * 0.72, 9.77, -1.86), 0.11, 0.08,
            mats["cavity_dark"], col, segments=16, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
        )
        # Flanking diagonal hydraulic shock arms supporting chin jaw
        add_cylinder(
            f"Chin_ClampStrut_{tag}", (side * 1.24, 9.18, -1.88), 0.075, 0.92,
            mats["chrome_piston"], col, segments=12, rot=(0.25, side * 0.32, 0.0), bevel=0.008, parent=root,
        )
    add_beveled_box(
        "Chin_FrontClampCenterNotch", (0.0, 9.68, -1.86), (0.48, 0.22, 0.34),
        mats["cavity_dark"], col, bevel=0.015, parent=root,
    )
    # Lower front armored docking shield w/ recessed channels & bolts
    add_beveled_box(
        "Chin_FrontClampLower", (0.0, 9.26, -2.66), (1.74, 0.72, 0.86),
        mats["gunmetal_chassis"], col, bevel=0.04, parent=root,
    )
    add_beveled_box(
        "Chin_FrontLowerPlate", (0.0, 9.60, -2.66), (1.18, 0.16, 0.68),
        mats["steel_trim"], col, bevel=0.025, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Chin_FrontLowerRib_{tag}", (side * 0.24, 9.68, -2.66), (0.10, 0.08, 0.58),
            mats["dark_machinery"], col, bevel=0.01, parent=root,
        )
        add_beveled_box(
            f"Chin_FrontLowerBolt_{tag}", (side * 0.48, 9.69, -2.42), (0.10, 0.08, 0.10),
            mats["dark_machinery"], col, bevel=0.01, parent=root,
        )
    add_beveled_box(
        "Chin_FrontSkidBumper", (0.0, 8.75, -3.36), (1.26, 0.94, 0.52),
        mats["steel_trim"], col, bevel=0.035, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Chin_VentralJaw_{tag}", (side * 1.28, 8.15, -2.42), (0.48, 2.35, 1.18),
            mats["dark_machinery"], col, bevel=0.035, rot=(0.0, side * 0.14, 0.0), parent=root,
        )
        # 6 sculpted heavy structural sled cleats per side (Bottom & Side Ortho!)
        for k in range(6):
            yk = 5.25 + k * 0.64
            add_beveled_box(
                f"Chin_VentralCleat_{tag}_{k}", (side * 1.26, yk, -3.02), (0.44, 0.38, 0.56),
                mats["dark_machinery"], col, bevel=0.022, parent=root,
            )
            add_beveled_box(
                f"Chin_VentralCleatCap_{tag}_{k}", (side * 1.46, yk, -3.02), (0.10, 0.24, 0.36),
                mats["steel_trim"], col, bevel=0.012, parent=root,
            )
    add_beveled_box(
        "Chin_BottomGratePit", (0.0, 7.62, -3.46), (1.00, 1.72, 0.22),
        mats["cavity_dark"], col, bevel=0.015, parent=root,
    )
    for k in range(5):
        yk = 6.96 + k * 0.32
        add_beveled_box(
            f"Chin_BottomGrateBar_{k}", (0.0, yk, -3.55), (0.88, 0.12, 0.10),
            mats["steel_trim"], col, bevel=0.01, parent=root,
        )


# ---------------------------------------------------------------------------
# 6. Collection 03: Layered Dorsal Hull Armor, Hero Circular Turret & Spine
# ---------------------------------------------------------------------------

def build_dorsal_hull_and_turret(mats, col, root):
    # 3A. Forward Tapered Angular Military Glacis Deck (Y = +1.70 .. +9.75)
    fwd_stations = [
        ( 1.70, 2.86, 3.44, 3.32, 2.52, 2.02, 1.28),
        ( 3.20, 2.62, 3.20, 3.08, 2.48, 1.98, 1.32),
        ( 5.00, 2.28, 2.82, 2.70, 2.44, 1.94, 1.38),
        ( 6.80, 1.98, 2.46, 2.34, 2.38, 1.90, 1.44),
        ( 8.40, 1.74, 2.18, 2.06, 2.34, 1.88, 1.56),
        ( 9.75, 1.54, 1.96, 1.86, 2.28, 1.86, 1.74),
    ]
    glacis_secs = [
        [
            (-hwt, y, zt), (hwt, y, zt), (hwm, y, zm),
            (hwb, y, zb), (-hwb, y, zb), (-hwm, y, zm),
        ]
        for y, hwt, hwm, hwb, zt, zm, zb in fwd_stations
    ]
    add_lofted_sections(
        "Dorsal_ForwardGlacisHull", glacis_secs, mats["olive_armor"], col,
        bevel=0.04, bevel_segments=2, smooth=True, parent=root,
    )

    # Multi-segment layered central glacis armor plates separated by crisp dark shadow channels!
    for seg_i, (sy, slen, sw, sz, smat) in enumerate((
        (4.78, 1.48, 1.38, 2.52, "olive_light"),
        (6.48, 1.74, 1.30, 2.48, "olive_armor"),
        (8.18, 1.44, 1.18, 2.43, "olive_dark"),
    )):
        add_beveled_box(
            f"Dorsal_FwdCenterPlate_{seg_i}", (0.0, sy, sz), (sw, slen, 0.16),
            mats[smat], col, bevel=0.024, rot=(-0.024, 0.0, 0.0), parent=root,
        )
        # Shadow expansion joint seam between central plates
        if seg_i < 2:
            add_beveled_box(
                f"Dorsal_FwdCenterSeam_{seg_i}", (0.0, sy + slen * 0.5 + 0.05, sz - 0.02), (sw * 0.96, 0.09, 0.14),
                mats["cavity_dark"], col, bevel=0.008, rot=(-0.024, 0.0, 0.0), parent=root,
            )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Layered composite flanking glacis armor slabs (2-tier stepped ERA-style overlap!)
        add_beveled_box(
            f"Dorsal_FwdFlankPanelAft_{tag}", (side * 1.62, 4.90, 2.49), (1.00, 1.88, 0.14),
            mats["olive_armor"], col, bevel=0.024, rot=(-0.024, side * 0.05, side * 0.14), parent=root,
        )
        add_beveled_box(
            f"Dorsal_FwdFlankPanelFwd_{tag}", (side * 1.38, 6.72, 2.44), (0.86, 1.56, 0.13),
            mats["olive_light"], col, bevel=0.022, rot=(-0.024, side * 0.05, side * 0.14), parent=root,
        )
        # Flush stepped side cheek armor tiles hugging the angled glacis bevel (Hero & Front View!)
        for ch_i, (cy, cx, cz) in enumerate(((4.20, 2.78, 1.88), (6.30, 2.40, 1.90), (8.25, 2.04, 1.92))):
            add_beveled_box(
                f"Dorsal_GlacisCheekPlate_{tag}_{ch_i}", (side * cx, cy, cz), (0.12, 1.56, 0.46),
                mats["olive_armor" if ch_i != 1 else "olive_dark"], col, bevel=0.016,
                rot=(0.0, side * 0.48, side * 0.16), parent=root,
            )
        # Deep louvered bow maneuvering/air-brake vents (5 louvers + collar!)
        add_beveled_box(
            f"Dorsal_BowVentFrame_{tag}", (side * 1.62, 7.65, 2.28), (0.50, 1.14, 0.24),
            mats["olive_dark"], col, bevel=0.02, rot=(0.0, side * 0.18, side * 0.17), parent=root,
        )
        add_beveled_box(
            f"Dorsal_BowVentCavity_{tag}", (side * 1.64, 7.65, 2.32), (0.36, 0.92, 0.22),
            mats["cavity_dark"], col, bevel=0.01, rot=(0.0, side * 0.18, side * 0.17), parent=root,
        )
        for v_i in range(5):
            add_beveled_box(
                f"Dorsal_BowVentLouver_{tag}_{v_i}", (side * 1.64, 7.28 + v_i * 0.185, 2.35), (0.30, 0.055, 0.15),
                mats["steel_trim"], col, bevel=0.006, rot=(0.24, side * 0.18, side * 0.17), parent=root,
            )

    # 3B. 25+ Part Hero Dorsal Circular Airlock / Turret Assembly (Center Y=+2.65, R=1.62 m)
    ty = 2.65
    # Outer beveled armored base collar
    add_hollow_ring_z(
        "Dorsal_TurretOuterCollar", 0.0, ty, 2.36, 2.68, 1.62, 1.30,
        mats["olive_dark"], col, segments=48, bevel=0.024, parent=root,
    )
    # 12 radial armor bolt-lugs / locking clamps around outer turret ring!
    for idx in range(12):
        ang = 2.0 * math.pi * idx / 12.0
        lx = 1.48 * math.cos(ang)
        ly = ty + 1.48 * math.sin(ang)
        add_beveled_box(
            f"Dorsal_TurretRadialLug_{idx}", (lx, ly, 2.68), (0.22, 0.14, 0.12),
            mats["olive_armor"], col, bevel=0.014, rot=(0.0, 0.0, ang), parent=root,
        )
    # Stepped gunmetal bearing race + dark recessed slewing track
    add_hollow_ring_z(
        "Dorsal_TurretBearingRing", 0.0, ty, 2.48, 2.76, 1.32, 1.04,
        mats["gunmetal_chassis"], col, segments=48, bevel=0.018, parent=root,
    )
    add_hollow_ring_z(
        "Dorsal_TurretSlewGroove", 0.0, ty, 2.64, 2.77, 1.12, 1.00,
        mats["cavity_dark"], col, segments=48, bevel=0.008, parent=root,
    )
    # Recessed circular floor + multi-panel asymmetric pressure hatch lid (Top View!)
    add_cylinder(
        "Dorsal_TurretBaseDisk", (0.0, ty, 2.58), 1.16, 0.26,
        mats["dark_machinery"], col, segments=48, bevel=0.02, parent=root,
    )
    add_cylinder(
        "Dorsal_TurretMainHatch", (0.0, ty, 2.72), 0.98, 0.18,
        mats["gunmetal_chassis"], col, segments=40, bevel=0.024, parent=root,
    )
    # Front/aft split hatch armor panels + central hinge bar + grab bar
    add_beveled_box(
        "Dorsal_TurretHatchRib", (0.0, ty + 0.08, 2.82), (1.82, 0.16, 0.12),
        mats["olive_dark"], col, bevel=0.015, parent=root,
    )
    add_beveled_box(
        "Dorsal_TurretHatchFrontPlate", (0.0, ty + 0.44, 2.81), (1.36, 0.56, 0.10),
        mats["steel_trim"], col, bevel=0.018, parent=root,
    )
    add_beveled_box(
        "Dorsal_TurretHatchAftPlate", (0.0, ty - 0.42, 2.81), (1.28, 0.54, 0.10),
        mats["olive_dark"], col, bevel=0.018, parent=root,
    )
    # Compact armored coaxial point-defense turret mantlet + twin precision barrels w/ muzzle brakes!
    add_beveled_box(
        "Dorsal_TurretMantlet", (-0.06, ty + 0.34, 2.92), (0.86, 0.52, 0.24),
        mats["olive_dark"], col, bevel=0.024, parent=root,
    )
    add_beveled_box(
        "Dorsal_TurretOpticPod", (-0.42, ty + 0.34, 2.98), (0.28, 0.30, 0.18),
        mats["steel_trim"], col, bevel=0.015, parent=root,
    )
    for dz_b, dy_b in ((0.03, 0.08), (-0.03, -0.08)):
        add_cylinder(
            f"Dorsal_TurretBarrel_{dy_b:+.2f}", (0.58, ty + 0.34 + dy_b, 2.94 + dz_b), 0.055, 0.78,
            mats["steel_trim"], col, segments=14, rot=(0.0, math.pi * 0.5, 0.0), bevel=0.008, parent=root,
        )
        add_cylinder(
            f"Dorsal_TurretMuzzle_{dy_b:+.2f}", (0.98, ty + 0.34 + dy_b, 2.94 + dz_b), 0.072, 0.14,
            mats["dark_machinery"], col, segments=14, rot=(0.0, math.pi * 0.5, 0.0), bevel=0.008, parent=root,
        )
    add_bezelled_light(
        "Dorsal_TurretRimMarker", (0.0, ty - 1.28, 2.75), (0.28, 0.09, 0.045),
        mats, col, normal_axis="+Z", parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Dorsal_TurretClamp_{tag}", (side * 1.64, ty, 2.58), (0.38, 0.90, 0.24),
            mats["olive_armor"], col, bevel=0.02, parent=root,
        )

    # 3C. Mid-Ship Stepped Dorsal Armor Shoulders, Reactor Spine Bay & Clamped Conduit Booms
    mid_deck_pts = [
        (-2.78, -5.60),
        ( 2.78, -5.60),
        ( 3.22, -4.40),
        ( 3.30,  1.25),
        ( 3.46,  2.15),
        (-3.46,  2.15),
        (-3.30,  1.25),
        (-3.22, -4.40),
    ]
    add_extruded_poly_z(
        "Dorsal_MidDeckPlatform", mid_deck_pts, 1.48, 2.48,
        mats["olive_armor"], col, bevel=0.045, bevel_segments=2, parent=root,
    )

    # Detailed central recessed spine bay behind circular turret (radiator louvers + cables + hatches!)
    add_beveled_box(
        "Dorsal_MidSpineRecess", (0.0, -1.05, 2.46), (1.76, 4.55, 0.26),
        mats["gunmetal_chassis"], col, bevel=0.025, parent=root,
    )
    add_beveled_box(
        "Dorsal_MidSpineDarkInsert", (0.0, -0.95, 2.56), (1.02, 3.88, 0.16),
        mats["cavity_dark"], col, bevel=0.02, parent=root,
    )
    for k in range(6):
        add_beveled_box(
            f"Dorsal_MidSpineShuttter_{k}", (0.0, -0.35 + k * 0.26, 2.63), (0.86, 0.12, 0.08),
            mats["steel_trim"], col, bevel=0.008, parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_cylinder(
            f"Dorsal_MidSpineCable_{tag}", (side * 0.64, -0.95, 2.62), 0.055, 3.70,
            mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.006, parent=root,
        )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        shoulder_pts = ensure_ccw_2d([
            (side * 1.05, -2.85),
            (side * 2.52, -2.85),
            (side * 2.72,  0.45),
            (side * 2.26,  1.65),
            (side * 1.45,  1.65),
            (side * 1.05,  0.65),
        ])
        add_extruded_poly_z(
            f"Dorsal_MidShoulderArmor_{tag}", shoulder_pts, 2.38, 2.76,
            mats["olive_armor"], col, bevel=0.035, bevel_segments=2, parent=root,
        )
        # Raised stepped armor overlay panels & inspection hatches on mid-deck shoulders
        add_beveled_box(
            f"Dorsal_MidShoulderOverlay_{tag}", (side * 1.84, -0.82, 2.77), (1.08, 2.15, 0.09),
            mats["olive_light"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"Dorsal_OuterEdgeRail_{tag}", (side * 2.86, -1.65, 2.22), (0.64, 5.90, 0.56),
            mats["olive_armor"], col, bevel=0.035, parent=root,
        )
        # Segmented side-trim blocks along outer mid-hull edge (Hero View silhouette rhythm!)
        for k in range(4):
            yk = -3.80 + k * 1.48
            add_beveled_box(
                f"Dorsal_OuterEdgeBlock_{tag}_{k}", (side * 3.20, yk, 2.24), (0.14, 1.18, 0.42),
                mats["olive_dark" if k % 2 == 0 else "olive_armor"], col, bevel=0.016, parent=root,
            )
        # Parallel dorsal conduit boom w/ 6 segmented clamp collars & metallic pipe!
        add_beveled_box(
            f"Dorsal_SpineConduitBoom_{tag}", (side * 1.88, -4.15, 2.62), (0.42, 6.20, 0.34),
            mats["olive_dark"], col, bevel=0.028, parent=root,
        )
        add_cylinder(
            f"Dorsal_SpinePipe_{tag}", (side * 1.88, -4.45, 2.80), 0.095, 5.55,
            mats["steel_trim"], col, segments=16, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.01, parent=root,
        )
        for c_i in range(6):
            yc = -6.75 + c_i * 0.96
            add_beveled_box(
                f"Dorsal_SpinePipeClamp_{tag}_{c_i}", (side * 1.88, yc, 2.80), (0.30, 0.20, 0.24),
                mats["dark_machinery"], col, bevel=0.014, parent=root,
            )

    # 3D. Aft Raised Dorsal Reactor Superstructure Spine + Mid-Aft Sensor Ridge
    aft_spine_yz = [
        (-9.95, 2.18),
        (-9.95, 2.94),
        (-4.05, 2.98),
        (-3.20, 2.92),
        (-2.55, 2.52),
        (-2.55, 2.18),
    ]
    add_extruded_poly_x(
        "Dorsal_AftReactorSpine", aft_spine_yz, -1.36, 1.36,
        mats["olive_armor"], col, bevel=0.04, bevel_segments=2, parent=root,
    )
    peak_yz = [
        (-3.85, 2.82),
        (-2.15, 3.18),
        (-1.45, 2.98),
        (-1.15, 2.68),
        (-3.85, 2.68),
    ]
    add_extruded_poly_x(
        "Dorsal_MidAftSensorRidge", peak_yz, -0.78, 0.78,
        mats["olive_armor"], col, bevel=0.03, bevel_segments=2, parent=root,
    )
    # Recessed dark front optical slit on the mid-aft dorsal fairing peak
    add_beveled_box(
        "Dorsal_MidAftRidgeOptic", (0.0, -1.46, 2.96), (0.96, 0.14, 0.14),
        mats["cavity_dark"], col, bevel=0.01, parent=root,
    )
    # Layered modular aft spine top armor caps + heat-exhaust pit w/ 5 vanes
    add_beveled_box(
        "Dorsal_AftSpineCapMid", (0.0, -5.65, 2.99), (2.28, 2.76, 0.20),
        mats["olive_light"], col, bevel=0.028, parent=root,
    )
    add_beveled_box(
        "Dorsal_AftSpineCapRear", (0.0, -8.35, 2.95), (2.08, 2.36, 0.22),
        mats["olive_armor"], col, bevel=0.028, parent=root,
    )
    add_beveled_box(
        "Dorsal_AftVentPit", (0.0, -8.75, 2.99), (0.72, 1.10, 0.18),
        mats["cavity_dark"], col, bevel=0.015, parent=root,
    )
    for k in range(5):
        add_beveled_box(
            f"Dorsal_AftVentVane_{k}", (0.0, -9.15 + k * 0.20, 3.03), (0.60, 0.065, 0.10),
            mats["steel_trim"], col, bevel=0.006, rot=(0.25, 0.0, 0.0), parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Dorsal_AftSpineFlank_{tag}", (side * 1.48, -7.25, 2.48), (0.56, 4.95, 0.62),
            mats["olive_dark"], col, bevel=0.03, parent=root,
        )
        # Lateral reactor exhaust louver strip along raised aft spine sides
        for k in range(4):
            add_beveled_box(
                f"Dorsal_AftSideVent_{tag}_{k}", (side * 1.38, -5.10 - k * 0.52, 2.84), (0.08, 0.34, 0.14),
                mats["cavity_dark"], col, bevel=0.008, parent=root,
            )


# ---------------------------------------------------------------------------
# 7. Collection 04: Ultra-Detailed Forward Hexagonal Intake / Thruster Pods
# ---------------------------------------------------------------------------

def build_forward_hex_intake_pods(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        cx = side * 2.48
        cz = -0.92

        # 4A. Chamfered Hexagonal-Shouldered Pod Hull w/ Layered Side Armor Plates & Seam Latches
        pod_body_xz = vertical_hex8_xz(cx, cz, hw=0.84, hh=1.68, cap_w=0.38, shoulder_h=1.18)
        add_extruded_poly_y(
            f"FwdPod_BodyRear_{tag}", pod_body_xz, y0=3.82, y1=5.44,
            mat=mats["olive_armor"], col=col, bevel=0.04, bevel_segments=2, parent=root,
        )
        add_extruded_poly_y(
            f"FwdPod_BodyFront_{tag}", pod_body_xz, y0=5.60, y1=7.26,
            mat=mats["olive_armor"], col=col, bevel=0.04, bevel_segments=2, parent=root,
        )
        seam_xz = vertical_hex8_xz(cx, cz, hw=0.78, hh=1.60, cap_w=0.34, shoulder_h=1.12)
        add_extruded_poly_y(
            f"FwdPod_SeamCore_{tag}", seam_xz, y0=5.38, y1=5.66,
            mat=mats["cavity_dark"], col=col, bevel=0.015, parent=root,
        )
        # Exposed heavy structural hinge-latches spanning the dark vertical pod seam!
        for zl in (-1.68, -0.92, -0.16):
            add_beveled_box(
                f"FwdPod_SeamLatch_{tag}_{zl:+.2f}", (side * 3.30, 5.52, zl), (0.12, 0.34, 0.16),
                mats["olive_dark"], col, bevel=0.012, parent=root,
            )
        # Layered outboard armor relief plate + recessed side service vent on forward pod!
        add_beveled_box(
            f"FwdPod_SideArmorPlate_{tag}", (side * 3.31, 6.44, -0.68), (0.06, 1.38, 1.56),
            mats["olive_light"], col, bevel=0.016, parent=root,
        )
        add_beveled_box(
            f"FwdPod_SideLowerVent_{tag}", (side * 3.32, 6.44, -1.78), (0.08, 0.72, 0.28),
            mats["cavity_dark"], col, bevel=0.01, parent=root,
        )
        for v_i in range(4):
            add_beveled_box(
                f"FwdPod_SideLowerVane_{tag}_{v_i}", (side * 3.34, 6.18 + v_i * 0.17, -1.78), (0.05, 0.05, 0.22),
                mats["steel_trim"], col, bevel=0.005, parent=root,
            )

        # Top mounting collar + articulated hydraulic lower landing-skid truss!
        add_beveled_box(
            f"FwdPod_TopCollar_{tag}", (side * 2.18, 5.55, 0.68), (1.16, 3.10, 0.56),
            mats["olive_dark"], col, bevel=0.035, parent=root,
        )
        add_beveled_box(
            f"FwdPod_LowerSkidBeam_{tag}", (side * 2.12, 5.52, -2.58), (1.20, 3.30, 0.48),
            mats["gunmetal_chassis"], col, bevel=0.03, parent=root,
        )
        add_beveled_box(
            f"FwdPod_LowerSkidClamp_{tag}", (side * 2.28, 6.45, -2.52), (0.94, 1.18, 0.44),
            mats["dark_machinery"], col, bevel=0.025, parent=root,
        )
        for k in range(3):
            add_beveled_box(
                f"FwdPod_LowerSkidRib_{tag}_{k}", (side * 2.66, 4.45 + k * 0.95, -2.56), (0.30, 0.46, 0.38),
                mats["steel_trim"], col, bevel=0.018, parent=root,
            )
            add_cylinder(
                f"FwdPod_LowerShock_{tag}_{k}", (side * 2.74, 4.45 + k * 0.95, -2.26), 0.065, 0.46,
                mats["chrome_piston"], col, segments=12, bevel=0.006, parent=root,
            )

        # 4B. Signature Front Double-Stepped Elongated Vertical Hexagonal Shroud (Front Ortho!)
        outer_hex = vertical_hex8_xz(cx, cz, hw=0.84, hh=1.74, cap_w=0.16, shoulder_h=1.08)
        inner_hex = vertical_hex8_xz(cx, cz, hw=0.62, hh=1.42, cap_w=0.11, shoulder_h=0.86)
        add_hollow_frame_y(
            f"FwdPod_HexFrame_{tag}", outer_hex, inner_hex,
            y_back=7.18, y_front=7.72, mat=mats["olive_armor"], col=col,
            bevel=0.024, bevel_segments=2, parent=root,
        )
        mid_hex = vertical_hex8_xz(cx, cz, hw=0.56, hh=1.32, cap_w=0.09, shoulder_h=0.78)
        add_hollow_frame_y(
            f"FwdPod_HexInnerBezel_{tag}", inner_hex, mid_hex,
            y_back=7.08, y_front=7.62, mat=mats["olive_dark"], col=col,
            bevel=0.012, bevel_segments=1, parent=root,
        )
        add_extruded_poly_y(
            f"FwdPod_HexCavityBack_{tag}", inner_hex, y0=6.92, y1=7.20,
            mat=mats["cavity_dark"], col=col, bevel=0.01, parent=root,
        )

        # 6 Flanking Mechanical Clamp Lugs along inner & outer walls of each hex intake (Front Ortho!)
        for dz in (-0.82, 0.0, 0.82):
            for dx_lug in (-0.52, 0.52):
                add_cylinder(
                    f"FwdPod_HexWallLug_{tag}_{dx_lug:+.2f}_{dz:+.2f}", (cx + dx_lug, 7.48, cz + dz),
                    0.075, 0.24, mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
                )

        # 4C. Twin Stacked Vertical Statored Intake Nozzles (Outer Collar + Inner Lip + 4 Stator Vanes + Hub!)
        for n_idx, nz in enumerate((cz + 0.52, cz - 0.50)):
            noz_out = chamfered_rect_xz(cx, nz, hw=0.39, hh=0.46, ch=0.13)
            noz_mid = chamfered_rect_xz(cx, nz, hw=0.28, hh=0.34, ch=0.09)
            noz_in  = chamfered_rect_xz(cx, nz, hw=0.20, hh=0.26, ch=0.06)
            add_hollow_frame_y(
                f"FwdPod_NozzleOuterCollar_{tag}_{n_idx}", noz_out, noz_mid,
                y_back=7.14, y_front=7.60, mat=mats["steel_trim"], col=col,
                bevel=0.016, bevel_segments=2, parent=root,
            )
            add_hollow_frame_y(
                f"FwdPod_NozzleInnerLip_{tag}_{n_idx}", noz_mid, noz_in,
                y_back=7.12, y_front=7.52, mat=mats["dark_machinery"], col=col,
                bevel=0.01, bevel_segments=1, parent=root,
            )
            add_extruded_poly_y(
                f"FwdPod_NozzleThroat_{tag}_{n_idx}", noz_in, y0=7.02, y1=7.28,
                mat=mats["cavity_dark"], col=col, bevel=0.008, parent=root,
            )
            # 3 horizontal intake stator vanes + central turbine cone hub deep inside each nozzle!
            for v_z in (-0.12, 0.0, 0.12):
                add_beveled_box(
                    f"FwdPod_NozVane_{tag}_{n_idx}_{v_z:+.2f}", (cx, 7.36, nz + v_z), (0.36, 0.14, 0.032),
                    mats["steel_trim"], col, bevel=0.004, parent=root,
                )
            add_cylinder(
                f"FwdPod_NozHub_{tag}_{n_idx}", (cx, 7.38, nz), 0.075, 0.18,
                mats["chrome_piston"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, radius2=0.045, parent=root,
            )

        for dz in (-1.02, 0.02, 1.04):
            add_cylinder(
                f"FwdPod_HexBoss_{tag}_{dz:+.1f}", (cx, 7.46, cz + dz), 0.08, 0.24,
                mats["dark_machinery"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.01, parent=root,
            )

        # Recessed tactical lights
        add_bezelled_light(
            f"FwdPod_HexBottomLight_{tag}", (cx, 7.64, cz - 1.24), (0.16, 0.055, 0.060),
            mats, col, normal_axis="+Y", parent=root,
        )
        add_bezelled_light(
            f"FwdPod_SideLightSlit_{tag}", (side * 3.34, 7.05, -1.48), (0.035, 0.052, 0.76),
            mats, col, normal_axis="+X" if side > 0 else "-X", parent=root,
        )
        add_bezelled_light(
            f"FwdPod_TopLightSlit_{tag}", (side * 3.12, 5.15, 0.52), (0.06, 0.44, 0.032),
            mats, col, normal_axis="+Z", parent=root,
        )


# ---------------------------------------------------------------------------
# 8. Collection 05: Multi-Layered Mid-Ship Heavy Armor Sponson Pods
# ---------------------------------------------------------------------------

def build_main_side_armor_pods(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # 5A. Broad Monolithic Slab-Sided Armor Sponson (Y = -3.84 .. +1.78)
        pod_profile_xz = ensure_ccw_2d([
            (side * 3.28,  1.26),
            (side * 4.52,  1.34),
            (side * 4.88,  0.96),
            (side * 4.88, -2.02),
            (side * 4.52, -2.40),
            (side * 3.28, -2.32),
        ])
        add_extruded_poly_y(
            f"SidePod_MainArmorSlab_{tag}", pod_profile_xz, y0=-3.84, y1=1.78,
            mat=mats["olive_armor"], col=col, bevel=0.052, bevel_segments=2, parent=root,
        )

        # Forward Chamfered Intake Shroud + Deep Multi-Bank Louvered Scoop Mouth!
        mouth_out = ensure_ccw_2d([
            (side * 3.36,  1.18),
            (side * 4.46,  1.26),
            (side * 4.80,  0.88),
            (side * 4.80, -1.96),
            (side * 4.46, -2.32),
            (side * 3.36, -2.24),
        ])
        mouth_in = ensure_ccw_2d([
            (side * 3.58,  0.92),
            (side * 4.30,  0.96),
            (side * 4.52,  0.68),
            (side * 4.52, -1.72),
            (side * 4.30, -2.00),
            (side * 3.58, -1.96),
        ])
        add_hollow_frame_y(
            f"SidePod_FrontIntakeFrame_{tag}", mouth_out, mouth_in,
            y_back=1.72, y_front=2.26, mat=mats["olive_armor"], col=col,
            bevel=0.032, bevel_segments=2, parent=root,
        )
        # Inner dark bevel rim inside forward scoop mouth
        mouth_inner2 = ensure_ccw_2d([
            (side * 3.66,  0.82),
            (side * 4.24,  0.86),
            (side * 4.42,  0.60),
            (side * 4.42, -1.64),
            (side * 4.24, -1.88),
            (side * 3.66, -1.84),
        ])
        add_hollow_frame_y(
            f"SidePod_FrontIntakeInnerLip_{tag}", mouth_in, mouth_inner2,
            y_back=1.64, y_front=2.14, mat=mats["olive_dark"], col=col,
            bevel=0.012, bevel_segments=1, parent=root,
        )
        add_extruded_poly_y(
            f"SidePod_FrontIntakeCavity_{tag}", mouth_in, y0=1.42, y1=1.84,
            mat=mats["cavity_dark"], col=col, bevel=0.01, parent=root,
        )
        # Horizontal intake splitter + upper vertical intake vanes + lower bank of 5 angled turbine louvers!
        add_beveled_box(
            f"SidePod_IntakeDivider_{tag}", (side * 4.02, 2.02, 0.24), (0.96, 0.40, 0.18),
            mats["olive_dark"], col, bevel=0.018, parent=root,
        )
        for v_i in range(4):
            add_beveled_box(
                f"SidePod_IntakeUpperVane_{tag}_{v_i}", (side * 3.74 + side * v_i * 0.19, 2.02, 0.56),
                (0.065, 0.30, 0.48), mats["steel_trim"], col, bevel=0.006, parent=root,
            )
        add_beveled_box(
            f"SidePod_IntakeLowerBaffle_{tag}", (side * 4.02, 1.88, -0.84), (0.86, 0.24, 1.66),
            mats["gunmetal_chassis"], col, bevel=0.02, parent=root,
        )
        for l_i in range(5):
            lz = -1.52 + l_i * 0.34
            add_beveled_box(
                f"SidePod_IntakeLowerLouver_{tag}_{l_i}", (side * 4.04, 2.04, lz), (0.78, 0.24, 0.085),
                mats["dark_machinery"], col, bevel=0.008, rot=(-0.22, 0.0, 0.0), parent=root,
            )

        # 5B. Precision Multi-Layer Architectural Plating on Outboard Monolithic Wall (Hero & Side Views!)
        # Upper beveled armor strip + lower skirt armor strip + subtle forward L-hatch plate!
        add_beveled_box(
            f"SidePod_OuterUpperPlate_{tag}", (side * 4.88, -0.86, 0.72), (0.06, 5.04, 0.62),
            mats["olive_light"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"SidePod_OuterLowerPlate_{tag}", (side * 4.88, -0.86, -1.72), (0.06, 5.04, 0.60),
            mats["olive_armor"], col, bevel=0.018, parent=root,
        )
        # Forward upper recessed access hatch & vertical seam groove on broad side face (Side Ortho!)
        add_beveled_box(
            f"SidePod_OuterFwdPanel_{tag}", (side * 4.89, 0.76, -0.52), (0.05, 1.48, 1.72),
            mats["olive_armor"], col, bevel=0.016, parent=root,
        )
        add_beveled_box(
            f"SidePod_OuterAftRecess_{tag}", (side * 4.88, -2.55, -1.42), (0.08, 0.92, 0.56),
            mats["olive_dark"], col, bevel=0.014, parent=root,
        )
        add_beveled_box(
            f"SidePod_OuterAftVentSlot_{tag}", (side * 4.91, -2.55, -1.42), (0.04, 0.62, 0.18),
            mats["cavity_dark"], col, bevel=0.006, parent=root,
        )
        # Lower edge notched step cutout w/ visible recessed dark hydraulic lock bar!
        add_beveled_box(
            f"SidePod_LowerNotchBlock_{tag}", (side * 4.55, -1.45, -2.30), (0.68, 1.18, 0.34),
            mats["olive_dark"], col, bevel=0.025, parent=root,
        )
        add_cylinder(
            f"SidePod_LowerNotchPin_{tag}", (side * 4.78, -1.45, -2.30), 0.065, 0.92,
            mats["steel_trim"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.006, parent=root,
        )
        # Top deck recessed breather vents & hoist tie-down loops (Top & Hero Views!)
        for yv in (-2.45, 0.25):
            add_beveled_box(
                f"SidePod_TopVentPit_{tag}_{yv:+.2f}", (side * 4.02, yv, 1.32), (0.68, 0.88, 0.10),
                mats["cavity_dark"], col, bevel=0.01, parent=root,
            )
            for s_k in range(3):
                add_beveled_box(
                    f"SidePod_TopVentBar_{tag}_{yv:+.2f}_{s_k}", (side * 4.02, yv - 0.22 + s_k * 0.22, 1.36),
                    (0.56, 0.065, 0.05), mats["steel_trim"], col, bevel=0.005, parent=root,
                )

        # 5C. Aft Stepped Armored End-Collar Block w/ Seam Latches & Heat-Dissipation Grille
        add_beveled_box(
            f"SidePod_AftSeamRecess_{tag}", (side * 4.04, -3.94, -0.52), (1.50, 0.24, 3.55),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for zl in (-1.45, -0.52, 0.42):
            add_beveled_box(
                f"SidePod_AftSeamLatch_{tag}_{zl:+.2f}", (side * 4.78, -3.94, zl), (0.14, 0.32, 0.16),
                mats["steel_trim"], col, bevel=0.012, parent=root,
            )
        aft_collar_xz = ensure_ccw_2d([
            (side * 3.24,  1.28),
            (side * 4.38,  1.38),
            (side * 4.74,  1.02),
            (side * 4.74, -1.96),
            (side * 4.38, -2.32),
            (side * 3.24, -2.24),
        ])
        add_extruded_poly_y(
            f"SidePod_AftCollarBlock_{tag}", aft_collar_xz, y0=-5.12, y1=-4.02,
            mat=mats["olive_armor"], col=col, bevel=0.045, bevel_segments=2, parent=root,
        )
        add_beveled_box(
            f"SidePod_AftCollarRib_{tag}", (side * 4.75, -4.56, -0.52), (0.08, 0.72, 2.38),
            mats["olive_dark"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"SidePod_AftTopCap_{tag}", (side * 4.02, -4.55, 1.38), (1.36, 1.05, 0.28),
            mats["olive_light"], col, bevel=0.03, parent=root,
        )

        # 5D. Slim Bezelled Tactical Warm-White Marker Slits
        add_bezelled_light(
            f"SidePod_LowerFwdSlit_{tag}", (side * 4.91, 1.42, -1.78), (0.03, 0.36, 0.038),
            mats, col, normal_axis="+X" if side > 0 else "-X", parent=root,
        )
        add_bezelled_light(
            f"SidePod_UpperEdgeSlit_{tag}", (side * 4.64, -0.35, 1.33), (0.042, 0.44, 0.032),
            mats, col, normal_axis="+Z", parent=root,
        )


# ---------------------------------------------------------------------------
# 9. Collection 06: Stern Bulkhead, Triple-Stepped '>' '<' Chevrons & Tan Cowls
# ---------------------------------------------------------------------------

def _chevron_polygon_xz(side, x_knee, x_outer, z_top, z_mid, z_bot, arm_w):
    """Build exact 8-point inward-pointing chevron polygon ('>' on Port, '<' on Starboard)."""
    s = float(side)
    pts = [
        (s * x_outer,                  z_top),
        (s * (x_outer + arm_w),        z_top - 0.22),
        (s * (x_knee + arm_w),         z_mid),
        (s * (x_outer + arm_w - 0.10), z_bot + 0.22),
        (s * (x_outer - 0.12),         z_bot),
        (s * (x_outer - 0.44),         z_bot + 0.18),
        (s * x_knee,                   z_mid),
        (s * (x_outer - 0.34),         z_top - 0.16),
    ]
    return ensure_ccw_2d(pts)


def _chevron_arm_band_xz(side, t0, t1, x_knee, x_outer, z_mid, z_end, arm_w, inset=0.05):
    """Build an exact quad lying strictly INSIDE a chevron arm between parameter t0 and t1 in [0, 1]."""
    s = float(side)
    def lerp(a, b, t):
        return a + (b - a) * t

    xi0 = lerp(x_knee, x_outer - 0.36, t0) + inset
    xo0 = lerp(x_knee + arm_w, x_outer + arm_w - 0.04, t0) - inset
    z0  = lerp(z_mid, z_end, t0)

    xi1 = lerp(x_knee, x_outer - 0.36, t1) + inset
    xo1 = lerp(x_knee + arm_w, x_outer + arm_w - 0.04, t1) - inset
    z1  = lerp(z_mid, z_end, t1)

    return ensure_ccw_2d([
        (s * xi0, z0),
        (s * xo0, z0),
        (s * xo1, z1),
        (s * xi1, z1),
    ])


def build_stern_chevron_engines(mats, col, root):
    # 6A. Bolted Central Rear Reactor Bulkhead (exact REAR ORTHO detail!)
    add_beveled_box(
        "Stern_CentralBulkheadMain", (0.0, -8.35, 0.15), (3.65, 3.35, 4.45),
        mats["gunmetal_chassis"], col, bevel=0.045, parent=root,
    )
    add_beveled_box(
        "Stern_CenterArmorDoor", (0.0, -10.02, 0.38), (2.24, 0.36, 2.78),
        mats["olive_dark"], col, bevel=0.035, parent=root,
    )
    add_beveled_box(
        "Stern_CenterDoorInnerPlate", (0.0, -10.14, 0.38), (1.88, 0.18, 2.42),
        mats["gunmetal_chassis"], col, bevel=0.025, parent=root,
    )
    # Perimeter bolt lugs + top/bottom hydraulic latches on central reactor door!
    for bx in (-0.82, 0.82):
        for bz in (-0.68, 0.38, 1.44):
            add_beveled_box(
                f"Stern_DoorBolt_{bx:+.2f}_{bz:+.2f}", (bx, -10.24, bz), (0.12, 0.08, 0.12),
                mats["steel_trim"], col, bevel=0.01, parent=root,
            )
    for bz_l in (-0.98, 1.74):
        add_beveled_box(
            f"Stern_DoorLatch_{bz_l:+.2f}", (0.0, -10.22, bz_l), (0.64, 0.12, 0.16),
            mats["steel_trim"], col, bevel=0.012, parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Stern_CenterVertSlot_{tag}", (side * 0.56, -10.22, 0.62), (0.14, 0.12, 1.38),
            mats["cavity_dark"], col, bevel=0.01, parent=root,
        )
        add_beveled_box(
            f"Stern_CenterVertSlotLip_{tag}", (side * 0.56, -10.20, 0.62), (0.24, 0.08, 1.48),
            mats["steel_trim"], col, bevel=0.012, parent=root,
        )
        add_beveled_box(
            f"Stern_UpperCornerLug_{tag}", (side * 1.24, -10.06, 2.08), (0.60, 0.38, 0.46),
            mats["olive_dark"], col, bevel=0.03, parent=root,
        )
        add_beveled_box(
            f"Stern_UpperCornerPad_{tag}", (side * 1.24, -10.25, 2.08), (0.36, 0.08, 0.24),
            mats["steel_trim"], col, bevel=0.012, parent=root,
        )
    # Lower centered armored exhaust bay w/ recessed louvers!
    add_beveled_box(
        "Stern_LowerCenterVentBox", (0.0, -10.08, -1.62), (1.70, 0.38, 1.04),
        mats["gunmetal_chassis"], col, bevel=0.035, parent=root,
    )
    add_beveled_box(
        "Stern_LowerCenterVentPit", (0.0, -10.24, -1.62), (1.36, 0.14, 0.74),
        mats["cavity_dark"], col, bevel=0.015, parent=root,
    )
    for lv_i in range(4):
        add_beveled_box(
            f"Stern_LowerCenterLouver_{lv_i}", (0.0, -10.28, -1.86 + lv_i * 0.16), (1.26, 0.08, 0.055),
            mats["steel_trim"], col, bevel=0.006, rot=(0.22, 0.0, 0.0), parent=root,
        )

    # 6B. Iconic Triple-Stepped Twin '>' '<' Chevron Main Thruster Housings (14 Conformal Vanes Each!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        outer_chev = _chevron_polygon_xz(
            side, x_knee=1.42, x_outer=2.66, z_top=2.76, z_mid=-0.10, z_bot=-3.02, arm_w=1.22,
        )
        mid_chev = _chevron_polygon_xz(
            side, x_knee=1.66, x_outer=2.74, z_top=2.48, z_mid=-0.10, z_bot=-2.72, arm_w=0.76,
        )
        inner_chev = _chevron_polygon_xz(
            side, x_knee=1.76, x_outer=2.78, z_top=2.36, z_mid=-0.10, z_bot=-2.60, arm_w=0.56,
        )

        # Layer 1: Thick outer beveled olive-dark armored chevron duct shroud
        add_hollow_frame_y(
            f"Stern_ChevronArmorFrame_{tag}", outer_chev, mid_chev,
            y_back=-10.76, y_front=-9.55, mat=mats["olive_dark"], col=col,
            bevel=0.032, bevel_segments=2, parent=root,
        )
        # Layer 2: Stepped anodized titanium inner vectoring lip
        add_hollow_frame_y(
            f"Stern_ChevronInnerBezel_{tag}", mid_chev, inner_chev,
            y_back=-10.64, y_front=-9.55, mat=mats["steel_trim"], col=col,
            bevel=0.014, bevel_segments=1, parent=root,
        )
        # Armored reinforcement corner clamp brackets flush at Top Tip, Mid Knee & Bottom Heel!
        for c_name, cx_b, cz_b, bw_b in (
            ("TopCap", side * 3.12, 2.66, 0.44),
            ("KneeCap", side * 1.64, -0.10, 0.34),
            ("BotCap", side * 3.04, -2.90, 0.44),
        ):
            add_beveled_box(
                f"Stern_ChevronBracket_{c_name}_{tag}", (cx_b, -10.58, cz_b), (bw_b, 0.44, 0.24),
                mats["olive_armor"], col, bevel=0.02, parent=root,
            )

        # Tapered forward structural housing (never pokes through upper cowl outer wall!)
        add_extruded_poly_y(
            f"Stern_ChevronHousingBody_{tag}", outer_chev, y0=-9.60, y1=-7.40,
            mat=mats["gunmetal_chassis"], col=col, bevel=0.03, bevel_segments=1,
            scale0=0.96, scale1=0.88, parent=root,
        )
        add_extruded_poly_y(
            f"Stern_ChevronCavity_{tag}", mid_chev, y0=-10.12, y1=-9.25,
            mat=mats["cavity_dark"], col=col, bevel=0.01, parent=root,
        )

        # Exact Conformal Fiery Molten-Amber Exhaust Combustor Chamber
        glow_chev = _chevron_polygon_xz(
            side, x_knee=1.82, x_outer=2.80, z_top=2.26, z_mid=-0.10, z_bot=-2.48, arm_w=0.44,
        )
        core_chev = _chevron_polygon_xz(
            side, x_knee=1.90, x_outer=2.83, z_top=2.12, z_mid=-0.10, z_bot=-2.34, arm_w=0.26,
        )
        add_extruded_poly_y(
            f"Stern_ChevronAmberChamber_{tag}", glow_chev, y0=-10.18, y1=-10.04,
            mat=mats["amber_glow"], col=col, bevel=0.01, parent=root,
        )
        add_extruded_poly_y(
            f"Stern_ChevronHotCore_{tag}", core_chev, y0=-10.22, y1=-10.10,
            mat=mats["amber_core"], col=col, bevel=0.008, parent=root,
        )

        # 7 Precision Conformal Dark Metallic Thrust-Vectoring Louver Vanes per Arm (14 per Chevron!)
        for arm_name, z_end in (("Upper", 2.34), ("Lower", -2.56)):
            for b_i in range(7):
                t0 = 0.09 + b_i * 0.128
                t1 = t0 + 0.042
                slat_xz = _chevron_arm_band_xz(
                    side, t0, t1, x_knee=1.74, x_outer=2.76, z_mid=-0.10, z_end=z_end, arm_w=0.60, inset=0.01,
                )
                add_extruded_poly_y(
                    f"Stern_Chevron{arm_name}Baffle_{tag}_{b_i}", slat_xz,
                    y0=-10.46, y1=-10.14, mat=mats["dark_machinery"], col=col,
                    bevel=0.008, bevel_segments=1, parent=root,
                )
        # Sculpted central knee divider strut bridging chevron elbow
        knee_bar_xz = ensure_ccw_2d([
            (side * 1.72,  0.05),
            (side * 2.38,  0.05),
            (side * 2.38, -0.25),
            (side * 1.72, -0.25),
        ])
        add_extruded_poly_y(
            f"Stern_ChevronKneeStrut_{tag}", knee_bar_xz, y0=-10.54, y1=-10.05,
            mat=mats["steel_trim"], col=col, bevel=0.014, parent=root,
        )

        # 6C. Sculpted Multi-Panel Upper Rear Engine Cowlings (Olive Forward + Muted Khaki-Olive Aft Cap)
        add_beveled_box(
            f"Stern_UpperCowlFwd_{tag}", (side * 2.90, -6.58, 1.92), (1.72, 1.96, 1.42),
            mats["olive_armor"], col, bevel=0.045, parent=root,
        )
        # Deep recessed forward intake scoop w/ 4 vertical armored intake splitter vanes!
        add_beveled_box(
            f"Stern_UpperCowlIntake_{tag}", (side * 3.00, -5.58, 1.92), (1.18, 0.24, 0.96),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for v_i in range(4):
            add_beveled_box(
                f"Stern_UpperCowlVane_{tag}_{v_i}", (side * (2.60 + v_i * 0.27), -5.54, 1.92), (0.06, 0.22, 0.86),
                mats["steel_trim"], col, bevel=0.006, parent=root,
            )
        add_beveled_box(
            f"Stern_UpperCowlAftBase_{tag}", (side * 2.94, -8.56, 1.62), (1.72, 2.02, 0.88),
            mats["olive_dark"], col, bevel=0.04, parent=root,
        )
        # Sculpted chamfered muted khaki-olive upper nacelle armor cap (flush, zero clipping!)
        tan_cap_xz = ensure_ccw_2d([
            (side * 2.12, 1.96),
            (side * 3.82, 1.96),
            (side * 3.82, 2.48),
            (side * 3.48, 2.74),
            (side * 2.34, 2.74),
            (side * 2.12, 2.50),
        ])
        add_extruded_poly_y(
            f"Stern_UpperCowlTanCap_{tag}", tan_cap_xz, y0=-9.56, y1=-7.52,
            mat=mats["khaki_tan"], col=col, bevel=0.042, bevel_segments=2, parent=root,
        )
        # Side & dorsal armored detail hatches on khaki-olive nacelle cap
        add_beveled_box(
            f"Stern_UpperCowlSeamBand_{tag}", (side * 2.96, -7.54, 2.06), (1.78, 0.22, 1.24),
            mats["olive_dark"], col, bevel=0.025, parent=root,
        )
        add_beveled_box(
            f"Stern_UpperCowlVent_{tag}", (side * 2.86, -8.45, 2.74), (0.58, 0.78, 0.12),
            mats["cavity_dark"], col, bevel=0.012, parent=root,
        )
        for v_k in range(3):
            add_beveled_box(
                f"Stern_UpperCowlVentBar_{tag}_{v_k}", (side * 2.86, -8.68 + v_k * 0.23, 2.78), (0.48, 0.06, 0.05),
                mats["steel_trim"], col, bevel=0.005, parent=root,
            )

        # 6D. Sculpted Lower Rear Engine Undercarriage & Landing Footpads
        add_beveled_box(
            f"Stern_LowerEngineMount_{tag}", (side * 2.68, -8.25, -2.28), (1.68, 3.85, 1.32),
            mats["gunmetal_chassis"], col, bevel=0.04, parent=root,
        )
        add_beveled_box(
            f"Stern_LowerSkidShoe_{tag}", (side * 2.76, -7.20, -2.92), (1.42, 1.72, 0.56),
            mats["olive_dark"], col, bevel=0.035, parent=root,
        )
        add_beveled_box(
            f"Stern_LowerAftBlock_{tag}", (side * 2.78, -9.12, -2.92), (1.34, 1.56, 0.56),
            mats["dark_machinery"], col, bevel=0.035, parent=root,
        )
        # Exposed chrome landing strut linkages under stern skids
        add_cylinder(
            f"Stern_LowerShockStrut_{tag}", (side * 2.76, -8.15, -2.76), 0.085, 0.96,
            mats["chrome_piston"], col, segments=12, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
        )


# ---------------------------------------------------------------------------
# 10. Collection 07: Ultra-Detailed Outboard Hexagonal Auxiliary Engine Nacelles
# ---------------------------------------------------------------------------

def build_outboard_stern_nacelles(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        nx = side * 4.18
        nz = -0.68

        # 7A. Heavy Cross-Braced Bridge Pylon
        add_beveled_box(
            f"OutNacelle_Pylon_{tag}", (side * 3.42, -8.25, nz), (1.15, 3.65, 2.10),
            mats["dark_machinery"], col, bevel=0.035, parent=root,
        )

        # 7B. Main Chunky Oiled-Gunmetal Armored Nacelle Body (Side, Hero & Rear Views!)
        nac_prof_xz = ensure_ccw_2d([
            (side * 3.46,  0.76),
            (side * 4.58,  0.86),
            (side * 4.88,  0.54),
            (side * 4.88, -1.92),
            (side * 4.58, -2.24),
            (side * 3.46, -2.14),
        ])
        add_extruded_poly_y(
            f"OutNacelle_MainBody_{tag}", nac_prof_xz, y0=-10.48, y1=-6.35,
            mat=mats["gunmetal_chassis"], col=col, bevel=0.045, bevel_segments=2, parent=root,
        )

        # Forward armored intake collar w/ dark recessed front vent slats
        add_beveled_box(
            f"OutNacelle_FwdCollar_{tag}", (nx, -6.18, nz), (1.34, 0.58, 2.88),
            mats["olive_dark"], col, bevel=0.04, parent=root,
        )
        add_beveled_box(
            f"OutNacelle_FwdIntakePit_{tag}", (nx, -5.88, nz), (0.88, 0.14, 2.18),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for v_i in range(6):
            add_beveled_box(
                f"OutNacelle_FwdIntakeVane_{tag}_{v_i}", (nx, -5.84, -1.56 + v_i * 0.35), (0.78, 0.08, 0.08),
                mats["steel_trim"], col, bevel=0.008, parent=root,
            )

        # Layered outboard horizontal armor bands + vertical expansion ribs + 3 louvered vent pockets (Side View!)
        add_beveled_box(
            f"OutNacelle_SideBandUpper_{tag}", (side * 4.89, -8.45, 0.14), (0.14, 3.78, 0.90),
            mats["gunmetal_chassis"], col, bevel=0.025, parent=root,
        )
        add_beveled_box(
            f"OutNacelle_SideBandLower_{tag}", (side * 4.89, -8.45, -1.52), (0.14, 3.78, 0.90),
            mats["gunmetal_chassis"], col, bevel=0.025, parent=root,
        )
        # Vertical armored stiffening ribs framing the nacelle body
        for yr in (-9.92, -6.92):
            add_beveled_box(
                f"OutNacelle_SideVertRib_{tag}_{yr:+.2f}", (side * 4.92, yr, nz), (0.12, 0.24, 2.66),
                mats["steel_trim"], col, bevel=0.016, parent=root,
            )
        add_beveled_box(
            f"OutNacelle_SideCenterGroove_{tag}", (side * 4.85, -8.45, nz), (0.16, 3.65, 0.56),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for k, yk in enumerate((-9.35, -8.42, -7.48)):
            add_beveled_box(
                f"OutNacelle_SideSlotBezel_{tag}_{k}", (side * 4.91, yk, nz), (0.10, 0.68, 0.32),
                mats["steel_trim"], col, bevel=0.018, parent=root,
            )
            add_beveled_box(
                f"OutNacelle_SideSlotHole_{tag}_{k}", (side * 4.95, yk, nz), (0.06, 0.48, 0.16),
                mats["cavity_dark"], col, bevel=0.008, parent=root,
            )
            add_beveled_box(
                f"OutNacelle_SideSlotBar_{tag}_{k}", (side * 4.96, yk, nz), (0.04, 0.44, 0.04),
                mats["steel_trim"], col, bevel=0.004, parent=root,
            )

        # Lower auxiliary vernier thruster manifold + stepped bell nozzle w/ warm inner glow!
        add_beveled_box(
            f"OutNacelle_LowerManifold_{tag}", (side * 4.02, -8.75, -2.62), (1.02, 3.55, 0.64),
            mats["gunmetal_chassis"], col, bevel=0.03, parent=root,
        )
        for yc_m in (-9.65, -8.05):
            add_beveled_box(
                f"OutNacelle_LowerClamp_{tag}_{yc_m:+.2f}", (side * 4.04, yc_m, -2.62), (1.10, 0.26, 0.70),
                mats["steel_trim"], col, bevel=0.018, parent=root,
            )
        add_cylinder(
            f"OutNacelle_LowerBellOuter_{tag}", (side * 4.08, -10.58, -2.62), 0.25, 0.62,
            mats["steel_trim"], col, segments=20, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.015, radius2=0.20, parent=root,
        )
        add_cylinder(
            f"OutNacelle_LowerBellCore_{tag}", (side * 4.08, -10.84, -2.62), 0.16, 0.14,
            mats["cavity_dark"], col, segments=16, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.008, parent=root,
        )

        # 7C. Signature Rear Vertical Elongated Hexagonal Dual-Slit Nozzle Frame (REAR ORTHO!)
        out_hex = vertical_hex8_xz(nx, nz, hw=0.72, hh=1.60, cap_w=0.14, shoulder_h=0.98)
        in_hex  = vertical_hex8_xz(nx, nz, hw=0.50, hh=1.30, cap_w=0.09, shoulder_h=0.78)
        add_hollow_frame_y(
            f"OutNacelle_RearHexFrame_{tag}", out_hex, in_hex,
            y_back=-11.00, y_front=-10.42, mat=mats["olive_dark"], col=col,
            bevel=0.024, bevel_segments=2, parent=root,
        )
        inner2_hex = vertical_hex8_xz(nx, nz, hw=0.38, hh=1.12, cap_w=0.07, shoulder_h=0.66)
        add_hollow_frame_y(
            f"OutNacelle_RearInnerBezel_{tag}", in_hex, inner2_hex,
            y_back=-10.88, y_front=-10.38, mat=mats["steel_trim"], col=col,
            bevel=0.012, bevel_segments=1, parent=root,
        )
        add_extruded_poly_y(
            f"OutNacelle_RearCavity_{tag}", inner2_hex, y0=-10.58, y1=-10.00,
            mat=mats["cavity_dark"], col=col, bevel=0.01, parent=root,
        )
        # Corner clamp brackets at top & bottom of outer hex nozzle
        for z_cl in (nz + 1.54, nz - 1.54):
            add_beveled_box(
                f"OutNacelle_HexTipClamp_{tag}_{z_cl:+.2f}", (nx, -10.74, z_cl), (0.34, 0.42, 0.18),
                mats["steel_trim"], col, bevel=0.014, parent=root,
            )
        # Central armored horizontal crossbar splitting nozzle into upper + lower vertical slits
        add_beveled_box(
            f"OutNacelle_RearCrossbar_{tag}", (nx, -10.74, nz), (1.08, 0.44, 0.22),
            mats["steel_trim"], col, bevel=0.02, parent=root,
        )
        for s_idx, sz in enumerate((nz + 0.56, nz - 0.56)):
            add_beveled_box(
                f"OutNacelle_NozzleGlow_{tag}_{s_idx}", (nx, -10.52, sz), (0.38, 0.12, 0.70),
                mats["amber_glow"], col, bevel=0.012, parent=root,
            )
            add_beveled_box(
                f"OutNacelle_NozzleHotCore_{tag}_{s_idx}", (nx, -10.46, sz), (0.20, 0.14, 0.48),
                mats["amber_core"], col, bevel=0.01, parent=root,
            )
            # Twin dark vectoring slats inside each vertical nozzle slot
            for dz_f in (-0.18, 0.18):
                add_beveled_box(
                    f"OutNacelle_NozzleFin_{tag}_{s_idx}_{dz_f:+.2f}", (nx, -10.68, sz + dz_f), (0.50, 0.16, 0.065),
                    mats["dark_machinery"], col, bevel=0.006, parent=root,
                )


# ---------------------------------------------------------------------------
# 11. Collection 08: Hero Micro-Greebles, RCS Clusters, Antennae & Micro-Lights
# ---------------------------------------------------------------------------

def build_greebles_and_tactical_lights(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Slim bezel-recessed warm-white tactical seam lights along hull shoulder (Hero View!)
        for k, (yk, xk, zk) in enumerate((
            ( 6.45, 2.48, 1.46),
            ( 3.15, 3.04, 1.42),
            ( 0.45, 3.32, 1.56),
            (-2.65, 3.30, 1.58),
            (-6.55, 3.74, 1.72),
        )):
            add_bezelled_light(
                f"Detail_HullSeamLight_{tag}_{k}", (side * xk, yk, zk), (0.036, 0.36, 0.030),
                mats, col, normal_axis="+X" if side > 0 else "-X", parent=root,
            )

        # Recessed 2-nozzle military RCS maneuvering thruster pods at bow cheeks & aft shoulders!
        add_rcs_cluster(
            f"Detail_RCS_BowCheek_{tag}", (side * 2.02, 8.85, 2.04), mats, col,
            rot=(0.0, side * 0.65, side * 0.16), scale=1.0, parent=root,
        )
        add_rcs_cluster(
            f"Detail_RCS_SidePodFwd_{tag}", (side * 4.78, 1.38, 1.18), mats, col,
            rot=(0.0, side * 0.78, 0.0), scale=1.05, parent=root,
        )
        add_rcs_cluster(
            f"Detail_RCS_AftCowl_{tag}", (side * 3.76, -6.52, 2.52), mats, col,
            rot=(0.0, side * 0.60, 0.0), scale=1.0, parent=root,
        )

        # Raised armor inspection hatches, hoist tie-down bars & tactical stencils
        add_beveled_box(
            f"Detail_FwdArmorLug_{tag}", (side * 1.18, 9.15, 2.38), (0.42, 0.56, 0.12),
            mats["olive_dark"], col, bevel=0.015, parent=root,
        )
        add_beveled_box(
            f"Detail_MidDeckHatch_{tag}", (side * 1.78, -0.85, 2.81), (0.58, 0.92, 0.08),
            mats["olive_dark"], col, bevel=0.015, parent=root,
        )
        # Hoist / EVA tie-down grab bars along dorsal flanks
        for hy in (-6.15, -3.20, 4.95):
            hx = 2.02 if hy > 0 else 2.68
            hz = 2.48 if hy > 0 else 2.56
            add_cylinder(
                f"Detail_HoistBar_{tag}_{hy:+.1f}", (side * hx, hy, hz), 0.032, 0.42,
                mats["steel_trim"], col, segments=10, rot=(math.pi * 0.5, 0.0, 0.0), bevel=0.005, parent=root,
            )

        # Recessed waist & ventral skid micro inspection lights
        add_bezelled_light(
            f"Detail_WaistMicroLight_{tag}", (side * 3.36, 2.96, -1.62), (0.036, 0.22, 0.032),
            mats, col, normal_axis="+X" if side > 0 else "-X", parent=root,
        )
        add_bezelled_light(
            f"Detail_VentralSkidLight_{tag}", (side * 1.38, 6.95, -3.14), (0.036, 0.42, 0.032),
            mats, col, normal_axis="+X" if side > 0 else "-X", parent=root,
        )

    # Low-profile bow roof sensor turret + twin precision blade antennae (Hero & Side Ortho!)
    add_beveled_box(
        "Detail_BowRoofSensorMast", (0.0, 9.05, 2.48), (0.74, 0.36, 0.24),
        mats["olive_dark"], col, bevel=0.02, parent=root,
    )
    add_beveled_box(
        "Detail_BowRoofSensorAperture", (0.0, 9.24, 2.48), (0.48, 0.06, 0.12),
        mats["cavity_dark"], col, bevel=0.008, parent=root,
    )
    add_beveled_box(
        "Detail_BowRoofBladeMain", (-0.52, 8.95, 2.68), (0.065, 0.44, 0.22),
        mats["steel_trim"], col, bevel=0.01, rot=(0.18, 0.0, 0.0), parent=root,
    )
    add_beveled_box(
        "Detail_BowRoofBladeAux", (0.56, 8.82, 2.62), (0.055, 0.28, 0.16),
        mats["steel_trim"], col, bevel=0.008, rot=(0.22, 0.0, 0.0), parent=root,
    )
    # Low-profile rear dorsal IFF / comms fin on aft reactor spine
    add_beveled_box(
        "Detail_AftCommsFinPort", (-0.82, -7.25, 3.12), (0.06, 0.56, 0.22),
        mats["steel_trim"], col, bevel=0.01, rot=(0.26, 0.0, 0.0), parent=root,
    )
    add_beveled_box(
        "Detail_AftCommsFinStbd", (0.82, -7.25, 3.12), (0.06, 0.56, 0.22),
        mats["steel_trim"], col, bevel=0.01, rot=(0.26, 0.0, 0.0), parent=root,
    )


# ---------------------------------------------------------------------------
# 12. Studio Orbital Lighting, Subtle Amber Exhaust Bounce & 7 Matched Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Codex_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.038, 0.044, 0.050, 1.0)
        bg.inputs["Strength"].default_value = 0.78

    def add_light(name, ltype, loc, target, energy, color, size=14.0, size_y=None, angle=0.032, radius=0.5):
        ldata = bpy.data.lights.new(name=name, type=ltype)
        ldata.energy = energy
        ldata.color = color
        if ltype == "SUN":
            ldata.angle = angle
        elif ltype == "AREA":
            if size_y is not None:
                ldata.shape = "RECTANGLE"
                ldata.size = size
                ldata.size_y = size_y
            else:
                ldata.size = size
        elif ltype == "POINT":
            ldata.shadow_soft_size = radius
        lobj = bpy.data.objects.new(name, ldata)
        lobj.location = loc
        link_obj(lobj, col_stage)
        if target is not None:
            aim_object_at(lobj, target)
        return lobj

    # 1. Crisp High-Angle Orbital Sun Key (Port-Bow-Dorsal)
    add_light("Key_Sun_Orbital", "SUN", (-16.0, 18.0, 26.0), (0.0, 0.0, 0.0), energy=4.6, color=(1.0, 0.98, 0.94), angle=0.026)

    # 2. Starboard Raking Studio Rim
    add_light("Rim_Area_Starboard", "AREA", (26.0, 2.0, 12.0), (0.0, -1.5, -0.4), energy=5200.0, color=(0.90, 0.95, 1.0), size=20.0)

    # 3. Port Front Fill
    add_light("Fill_Area_PortBow", "AREA", (-18.0, 24.0, 5.0), (0.0, 4.0, -0.6), energy=3000.0, color=(0.88, 0.94, 1.0), size=16.0)

    # 4. Stern Architectural Rim
    add_light("Rim_Area_Stern", "AREA", (6.0, -26.0, 9.0), (0.0, -9.5, -0.2), energy=4200.0, color=(0.92, 0.95, 1.0), size=18.0)

    # 5. Cool Planetary-Horizon Underbelly Bounce (Bow & Aft pair)
    add_light("Bounce_Area_EarthHorizonFwd", "AREA", (-6.0, 6.0, -24.0), (0.0, 2.5, -2.2), energy=3600.0, color=(0.76, 0.88, 1.0), size=22.0)
    add_light("Bounce_Area_EarthHorizonAft", "AREA", (6.0, -9.5, -24.0), (0.0, -5.5, -2.2), energy=3400.0, color=(0.76, 0.88, 1.0), size=22.0)

    # 6. Local Fiery Amber-Orange Exhaust Bounce Lights tucked behind stern nozzles
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_light(
            f"AmberBounce_Chevron_{tag}", "POINT",
            (side * 2.55, -11.35, -0.10), None,
            energy=210.0, color=(1.0, 0.40, 0.06), radius=0.85,
        )
        add_light(
            f"AmberBounce_Outboard_{tag}", "POINT",
            (side * 4.18, -11.45, -0.68), None,
            energy=140.0, color=(1.0, 0.36, 0.05), radius=0.60,
        )


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=36.0, ortho_scale=24.0):
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

    make_cam("Cam_Hero_34", (-18.2, 18.8, 4.4), (0.0, -0.7, -0.30), cam_type="PERSP", lens=38.0)

    c_side = make_cam("Cam_Side_Ortho", (32.0, 0.0, -0.22), (0.0, 0.0, -0.22), cam_type="ORTHO", ortho_scale=24.2)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

    c_front = make_cam("Cam_Front_Ortho", (0.0, 32.0, -0.28), (0.0, 0.0, -0.28), cam_type="ORTHO", ortho_scale=12.6)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -32.0, -0.18), (0.0, 0.0, -0.18), cam_type="ORTHO", ortho_scale=12.6)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 36.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=35.5)
    c_top.rotation_euler = (0.0, 0.0, math.pi)

    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -36.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=35.5)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    make_cam("Cam_Rear_34", (16.5, -19.5, 6.4), (0.0, -1.0, -0.15), cam_type="PERSP", lens=36.0)

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
            scene.eevee.gtao_distance = 1.6

    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.08

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.clip_end = 500.0


# ---------------------------------------------------------------------------
# 13. Main Build Entrypoint
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root = ensure_collection("Codex_HeavyFrigate")
    col_chassis = ensure_collection("01_Core_Chassis_And_Keel", col_root)
    col_bridge = ensure_collection("02_Forward_Bridge_And_Chin", col_root)
    col_dorsal = ensure_collection("03_Upper_Dorsal_Hull_And_Turret", col_root)
    col_fwdpods = ensure_collection("04_Forward_Hex_Intake_Pods", col_root)
    col_sidepods = ensure_collection("05_Main_Side_Armor_Pods", col_root)
    col_chevron = ensure_collection("06_Stern_Chevron_Engines", col_root)
    col_outboard = ensure_collection("07_Outboard_Stern_Nacelles", col_root)
    col_detail = ensure_collection("08_Greebles_And_Tactical_Lights", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("Codex_Frigate_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_codex_textures()
    mats = build_materials(tex)

    build_core_chassis_and_keel(mats, col_chassis, root)
    build_forward_bridge_and_chin(mats, col_bridge, root)
    build_dorsal_hull_and_turret(mats, col_dorsal, root)
    build_forward_hex_intake_pods(mats, col_fwdpods, root)
    build_main_side_armor_pods(mats, col_sidepods, root)
    build_stern_chevron_engines(mats, col_chevron, root)
    build_outboard_stern_nacelles(mats, col_outboard, root)
    build_greebles_and_tactical_lights(mats, col_detail, root)

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
        f"BUILT Codex_HeavyFrigate V3 (Hero-Asset Ultra-Detail + 2048 PBR): "
        f"{len(mesh_objs)} meshes, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
