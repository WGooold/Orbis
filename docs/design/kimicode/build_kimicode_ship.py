"""Parametric sculpted hard-surface 3D model builder for the Kimi Code Orbital Cruiser (V2 Photoreal PBR).

Built from the hero concept & 4 orthographic reference views in docs/design/kimicode/,
with the asymmetric/broken ventral protrusion from the raw turnaround references
corrected into a sleek, 100% bilaterally symmetrical Ventral Orbital Grav-Ring sweeping
cleanly beneath the mid-rear hull and flush with the twin lateral grav-ring datum plane:
  - Hero 3/4:    kimi-code-spaceship-hero.png (sleek pearl-titanium white luxury composite
                 armor, deep midnight-navy obsidian mechanical chassis, deep smoked-sapphire
                 panoramic canopy, twin circular lateral grav-ring pods, swept dorsal halo
                 spoiler & glowing slender central spine arch, electric cobalt-blue energy)
  - Side Ortho:  QQ_2026-11-24_23-43-36.png (starboard profile: stern left, bow right)
  - Front Ortho: QQ_2026-11-24_23-43-58.png (symmetric sculpted bow, rounded inner pod domes)
  - Top Ortho:   QQ_2026-11-24_23-44-36.png (dorsal planform: W/L = 0.494)
  - Rear Ortho:  QQ_2026-11-24_23-45-04.png (twin chamfered octagonal cobalt-blue ion thrusters)

Generates deterministic 1024x1024 seamless aerospace PBR textures (Albedo, Roughness,
Normal) in textures/, packed into .blend and embedded into .glb, with distortion-free
world-scale box UVs so Blender 5.3 (AgX) and Three.js render consistently.

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-4.94, +4.94] (9.88 m max beam)
  -Y = Stern, +Y = Bow             -> Y in [-10.00, +10.00] (20.00 m total length)
  -Z = Ventral, +Z = Dorsal        -> Z in [-2.30, +4.08] (6.38 m total height)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/kimicode"
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
# 1. Procedural 1024x1024 Luxury Pearl-White & Midnight-Navy Aerospace PBR Maps
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64, 128), weights=(0.30, 0.26, 0.18, 0.12, 0.08, 0.06)):
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


def _generate_sleek_panels(res, seed, grid_x=4, grid_y=4, sub_prob=0.58, seam_px=2, add_cyan_tech=False):
    """Generate 2048px luxury aerospace composite plating with diagonal chamfer seams,
    recessed inspection hatches, micro-louver vents, fastener rows, and subtle cyan tech linework.
    """
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    seam = np.zeros((res, res), dtype=np.float32)
    accent = np.zeros((res, res), dtype=np.float32)
    tech_cyan = np.zeros((res, res), dtype=np.float32)

    xs = [0]
    ys = [0]
    sx = res // grid_x
    sy = res // grid_y
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * sx + rng.integers(-sx // 5, sx // 5 + 1), 48, res - 48)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * sy + rng.integers(-sy // 5, sy // 5 + 1), 48, res - 48)))
    xs.append(res)
    ys.append(res)

    def draw_diag_segment(arr, x0, y0, length, dx, dy, width=2, val=1.0):
        for step in range(length):
            px = (x0 + step * dx) % res
            py = (y0 + step * dy) % res
            for wy in range(width):
                for wx in range(width):
                    arr[(py + wy) % res, (px + wx) % res] = max(arr[(py + wy) % res, (px + wx) % res], val)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 2 and min(w, h) > 150 and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.32, 0.68))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.32, 0.68))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        tone[y0:y1, x0:x1] = float(rng.uniform(-0.052, 0.052))
        sp = seam_px if depth == 0 else max(1, seam_px - 1)
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        # Subtle bright chamfered bevel rim just inside panel seam
        ew = sp + 3
        if y1 - y0 > ew * 2 and x1 - x0 > ew * 2:
            accent[y0 + sp:y0 + ew, x0 + sp:x1 - sp] = 0.58
            accent[y0 + sp:y1 - sp, x0 + sp:x0 + ew] = 0.58

        # 45-degree sci-fi aerospace chamfer corner cuts on larger plates!
        if min(w, h) > 170 and rng.random() < 0.72:
            ch = int(min(w, h) * rng.uniform(0.10, 0.18))
            draw_diag_segment(seam, x0 + ch, y0 + sp, ch, -1, 1, width=max(1, sp), val=0.92)
            draw_diag_segment(seam, x1 - ch - sp, y1 - sp, ch, 1, -1, width=max(1, sp), val=0.92)
            if add_cyan_tech and rng.random() < 0.48:
                draw_diag_segment(tech_cyan, x0 + ch + 8, y0 + sp + 8, max(12, ch - 8), -1, 1, width=2, val=0.72)

        # Recessed aerospace inspection hatch + micro-louver vents inside large panels
        if w > 220 and h > 180 and rng.random() < 0.52:
            hx0 = x0 + int(w * rng.uniform(0.18, 0.34))
            hy0 = y0 + int(h * rng.uniform(0.18, 0.34))
            hw = int(w * rng.uniform(0.24, 0.42))
            hh = int(h * rng.uniform(0.22, 0.38))
            hx1 = min(x1 - 24, hx0 + hw)
            hy1 = min(y1 - 24, hy0 + hh)
            if hx1 - hx0 > 48 and hy1 - hy0 > 36:
                tone[hy0:hy1, hx0:hx1] += float(rng.uniform(-0.025, 0.025))
                seam[hy0:hy0 + 2, hx0:hx1] = 0.85
                seam[hy1 - 2:hy1, hx0:hx1] = 0.85
                seam[hy0:hy1, hx0:hx0 + 2] = 0.85
                seam[hy0:hy1, hx1 - 2:hx1] = 0.85
                # Micro-louver vent slits inside selected hatches
                if rng.random() < 0.45:
                    n_slits = 5
                    for sl in range(n_slits):
                        sy_pos = hy0 + 8 + int((hy1 - hy0 - 16) * sl / max(n_slits - 1, 1))
                        if hy0 + 4 < sy_pos < hy1 - 5:
                            seam[sy_pos:sy_pos + 2, hx0 + 10:hx1 - 10] = 0.78

        # Precision fastener rivet rows along panel edges
        if w > 140 and h > 140:
            pad = sp + 12
            step_r = max(36, min(w, h) // 5)
            for rx in range(x0 + pad, x1 - pad - 2, step_r):
                for ry in (y0 + pad, y1 - pad - 3):
                    if 0 <= ry < res - 3 and 0 <= rx < res - 3:
                        seam[ry:ry + 3, rx:rx + 3] = 0.68
            for ry in range(y0 + pad + step_r, y1 - pad - step_r, step_r):
                for rx in (x0 + pad, x1 - pad - 3):
                    if 0 <= ry < res - 3 and 0 <= rx < res - 3:
                        seam[ry:ry + 3, rx:rx + 3] = 0.68

        # Subtle sci-fi cyan hairline trace accent along selected panels (Kimi signature!)
        if add_cyan_tech and w > 180 and h > 140 and rng.random() < 0.36:
            ly = y0 + sp + 18
            lx0 = x0 + int(w * 0.16)
            lx1 = x0 + int(w * 0.58)
            if ly < y1 - 12 and lx1 > lx0 + 20:
                tech_cyan[ly:ly + 2, lx0:lx1] = 0.65
                tech_cyan[ly - 2:ly + 4, lx1:min(lx1 + 6, x1 - 8)] = 0.82

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
    return tone, np.clip(seam_blur, 0.0, 1.0), accent, tech_cyan


def _height_to_normal(height, strength=2.4):
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


def generate_kimi_textures(res=2048):
    """Synthesize 2048x2048 film-grade Pearl-Titanium White & Deep Midnight-Navy Aerospace PBR maps."""
    macro = _tileable_fbm(res, seed=111, octaves=(4, 8, 16, 32), weights=(0.38, 0.30, 0.20, 0.12))
    micro = _tileable_fbm(res, seed=222, octaves=(32, 64, 128, 256), weights=(0.30, 0.30, 0.22, 0.18))
    brush_raw = _tileable_fbm(res, seed=333, octaves=(16, 32, 64, 128), weights=(0.25, 0.25, 0.25, 0.25))
    brush = (
        brush_raw
        + np.roll(brush_raw, 3, axis=1) + np.roll(brush_raw, -3, axis=1)
        + np.roll(brush_raw, 7, axis=1) + np.roll(brush_raw, -7, axis=1)
    ) / 5.0

    # Set A: 2048px Sleek Pearlescent Cool-White Aerospace Composite Armor w/ Diagonal Chamfers & Cyan Tech Filigree
    tone_w, seam_w, acc_w, cyan_w = _generate_sleek_panels(
        res, seed=505, grid_x=4, grid_y=4, sub_prob=0.56, seam_px=2, add_cyan_tech=True,
    )
    patina_w = (macro - 0.5) * 0.060 + (brush - 0.5) * 0.044 + (micro - 0.5) * 0.032

    wr = 0.78 + tone_w * 0.52 - patina_w * 0.86 + acc_w * 0.028 - cyan_w * 0.38
    wg = 0.80 + tone_w * 0.52 - patina_w * 0.82 + acc_w * 0.030 - cyan_w * 0.10
    wb = 0.845 + tone_w * 0.46 - patina_w * 0.74 + acc_w * 0.034 + cyan_w * 0.14
    pearl_albedo = np.stack([
        wr * (1.0 - seam_w * 0.34),
        wg * (1.0 - seam_w * 0.28),
        wb * (1.0 - seam_w * 0.19),
    ], axis=-1)

    pearl_rough = np.clip(
        0.23 + (macro - 0.5) * 0.12 + (brush - 0.5) * 0.09 + (micro - 0.5) * 0.06 + seam_w * 0.30 - acc_w * 0.05 - cyan_w * 0.08,
        0.12,
        0.60,
    )
    pearl_rough_rgb = np.stack([pearl_rough, pearl_rough, pearl_rough], axis=-1)
    pearl_height = np.clip(0.75 - seam_w * 0.42 + tone_w * 0.28 + (brush - 0.5) * 0.045 + (micro - 0.5) * 0.035, 0.0, 1.0)
    pearl_normal = _height_to_normal(pearl_height, strength=2.6)

    # Set B: 2048px Deep Midnight-Navy Obsidian Titanium Mechanical Chassis
    tone_d, seam_d, acc_d, _ = _generate_sleek_panels(
        res, seed=808, grid_x=5, grid_y=5, sub_prob=0.58, seam_px=3, add_cyan_tech=False,
    )
    dr = 0.105 + tone_d * 0.44 - (macro - 0.5) * 0.05 + (brush - 0.5) * 0.035 + acc_d * 0.025
    dg = 0.138 + tone_d * 0.46 - (macro - 0.5) * 0.05 + (brush - 0.5) * 0.035 + acc_d * 0.030
    db = 0.222 + tone_d * 0.54 - (macro - 0.5) * 0.045 + (brush - 0.5) * 0.040 + acc_d * 0.042
    d_seam = 1.0 - seam_d * 0.52
    navy_albedo = np.stack([dr * d_seam, dg * d_seam, db * d_seam], axis=-1)

    navy_rough = np.clip(
        0.28 + (macro - 0.5) * 0.16 + (brush - 0.5) * 0.12 - acc_d * 0.07 + seam_d * 0.30,
        0.14,
        0.68,
    )
    navy_rough_rgb = np.stack([navy_rough, navy_rough, navy_rough], axis=-1)
    navy_height = np.clip(0.75 - seam_d * 0.48 + tone_d * 0.34 + (brush - 0.5) * 0.055 + (micro - 0.5) * 0.045, 0.0, 1.0)
    navy_normal = _height_to_normal(navy_height, strength=3.0)

    return {
        "pearl_albedo": _save_and_pack_image("Tex_KimiPearl_Albedo", os.path.join(TEX_DIR, "pearl_armor_albedo.png"), pearl_albedo, "sRGB"),
        "pearl_rough":  _save_and_pack_image("Tex_KimiPearl_Rough",  os.path.join(TEX_DIR, "pearl_armor_rough.png"),  pearl_rough_rgb, "Non-Color"),
        "pearl_normal": _save_and_pack_image("Tex_KimiPearl_Normal", os.path.join(TEX_DIR, "pearl_armor_normal.png"), pearl_normal, "Non-Color"),
        "navy_albedo":  _save_and_pack_image("Tex_KimiNavy_Albedo",  os.path.join(TEX_DIR, "navy_chassis_albedo.png"),  navy_albedo, "sRGB"),
        "navy_rough":   _save_and_pack_image("Tex_KimiNavy_Rough",   os.path.join(TEX_DIR, "navy_chassis_rough.png"),   navy_rough_rgb, "Non-Color"),
        "navy_normal":  _save_and_pack_image("Tex_KimiNavy_Normal",  os.path.join(TEX_DIR, "navy_chassis_normal.png"),  navy_normal, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. Kimi Code PBR Materials (AgX-Calibrated Electric Cobalt-Blue & Pearl White!)
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
    metallic=0.35,
    normal_strength=0.40,
    coat=0.22,
    coat_rough=0.10,
    uv_scale=1.0,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (640, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (260, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    set_bsdf_input(bsdf, ["Metallic"], metallic)
    if coat > 0.0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], coat_rough)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-780, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-560, 0)
    mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, uv_scale)
    nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])

    tex_col = nt.nodes.new("ShaderNodeTexImage")
    tex_col.location = (-220, 260)
    tex_col.image = albedo_img
    nt.links.new(mapping.outputs["Vector"], tex_col.inputs["Vector"])
    nt.links.new(tex_col.outputs["Color"], bsdf.inputs["Base Color"])

    tex_rgh = nt.nodes.new("ShaderNodeTexImage")
    tex_rgh.location = (-220, -20)
    tex_rgh.image = rough_img
    nt.links.new(mapping.outputs["Vector"], tex_rgh.inputs["Vector"])
    nt.links.new(tex_rgh.outputs["Color"], bsdf.inputs["Roughness"])

    tex_nrm = nt.nodes.new("ShaderNodeTexImage")
    tex_nrm.location = (-320, -320)
    tex_nrm.image = normal_img
    nt.links.new(mapping.outputs["Vector"], tex_nrm.inputs["Vector"])

    nrm_node = nt.nodes.new("ShaderNodeNormalMap")
    nrm_node.location = (0, -300)
    nrm_node.uv_map = "UVMap"
    nrm_node.inputs["Strength"].default_value = normal_strength
    nt.links.new(tex_nrm.outputs["Color"], nrm_node.inputs["Color"])
    nt.links.new(nrm_node.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def make_solid_pbr_mat(
    name,
    base_color,
    metallic=0.30,
    roughness=0.30,
    coat=0.0,
    coat_rough=0.08,
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
        # Primary Sleek Pearl Titanium-White Luxury Hull Armor (2048px crisp panel scribing!)
        "armor_pearl": make_textured_pbr_mat(
            "Mat_Kimi_PearlArmor",
            tex["pearl_albedo"],
            tex["pearl_rough"],
            tex["pearl_normal"],
            metallic=0.36,
            normal_strength=0.46,
            coat=0.30,
            coat_rough=0.09,
            uv_scale=0.82,
        ),
        # Finer-Scale Pearl Ceramic for Wings, Arch, Ventral Ring & Pods
        "armor_fin": make_textured_pbr_mat(
            "Mat_Kimi_FinCeramic",
            tex["pearl_albedo"],
            tex["pearl_rough"],
            tex["pearl_normal"],
            metallic=0.40,
            normal_strength=0.42,
            coat=0.34,
            coat_rough=0.08,
            uv_scale=1.08,
        ),
        # Brushed Cool Silver-Titanium Accent Trim
        "silver_trim": make_solid_pbr_mat(
            "Mat_Kimi_SilverTitanium",
            base_color=(0.54, 0.60, 0.70),
            metallic=0.78,
            roughness=0.24,
            coat=0.24,
        ),
        # Deep Midnight-Navy Obsidian Mechanical Core
        "navy_chassis": make_textured_pbr_mat(
            "Mat_Kimi_NavyChassis",
            tex["navy_albedo"],
            tex["navy_rough"],
            tex["navy_normal"],
            metallic=0.66,
            normal_strength=0.40,
            coat=0.24,
            coat_rough=0.14,
            uv_scale=1.05,
        ),
        # Glossy Deep Sapphire-Obsidian Nose Cone & Inner Pod Domes
        "obsidian_blue": make_solid_pbr_mat(
            "Mat_Kimi_ObsidianBlue",
            base_color=(0.026, 0.052, 0.135),
            metallic=0.72,
            roughness=0.16,
            coat=0.72,
            coat_rough=0.07,
        ),
        # Rich Deep Cobalt Translucent-Look Thruster Housing (matches REAR ref deep blue bay!)
        "thruster_cobalt": make_solid_pbr_mat(
            "Mat_Kimi_ThrusterCobaltHousing",
            base_color=(0.025, 0.14, 0.56),
            metallic=0.58,
            roughness=0.20,
            coat=0.55,
            emission_color=(0.012, 0.11, 0.62),
            emission_strength=0.75,
        ),
        # Dark Anodized Carbon-Steel Machinery, Ribs, Vanes & Conduits
        "dark_machinery": make_solid_pbr_mat(
            "Mat_Kimi_DarkMachinery",
            base_color=(0.032, 0.044, 0.070),
            metallic=0.78,
            roughness=0.34,
        ),
        # Deep Pitch-Dark Shadow Recesses & Vent Cavities
        "cavity_dark": make_solid_pbr_mat(
            "Mat_Kimi_CavityDark",
            base_color=(0.006, 0.010, 0.020),
            metallic=0.35,
            roughness=0.58,
        ),
        # Panoramic Smoked Deep-Sapphire Canopy Glass (rich mirror clearcoat, NOT overly bright!)
        "canopy_glass": make_solid_pbr_mat(
            "Mat_Kimi_CanopySapphireGlass",
            base_color=(0.010, 0.040, 0.145),
            metallic=0.26,
            roughness=0.04,
            coat=1.00,
            coat_rough=0.02,
            alpha=0.72,
            emission_color=(0.010, 0.065, 0.28),
            emission_strength=0.12,
        ),
        # Frosted Ice-Blue Translucent Dorsal Skylight & Nose Prism Core
        "ice_skylight": make_solid_pbr_mat(
            "Mat_Kimi_IceSkylight",
            base_color=(0.30, 0.56, 0.86),
            metallic=0.20,
            roughness=0.16,
            coat=0.65,
            emission_color=(0.08, 0.36, 0.95),
            emission_strength=0.52,
        ),
        # AgX-Calibrated Rich Electric Cobalt-Blue Energy Strips & Halos (STAYS DEEP ELECTRIC BLUE!)
        "cyan_glow": make_solid_pbr_mat(
            "Mat_Kimi_ElectricBlueGlow",
            base_color=(0.015, 0.24, 1.0),
            metallic=0.0,
            roughness=0.18,
            emission_color=(0.008, 0.19, 1.0),
            emission_strength=2.9,
        ),
        # Bright Electric Cyan Stepped Inner Thruster Ring & Grav-Ring Inner Halo
        "cyan_bright": make_solid_pbr_mat(
            "Mat_Kimi_IceCyanCore",
            base_color=(0.05, 0.52, 1.0),
            metallic=0.0,
            roughness=0.14,
            emission_color=(0.04, 0.44, 1.0),
            emission_strength=3.6,
        ),
        # Incandescent Ice-White-Cyan Innermost Core (strictly for tiny thruster centers & lens)
        "plasma_core": make_solid_pbr_mat(
            "Mat_Kimi_PlasmaCore",
            base_color=(0.45, 0.86, 1.0),
            metallic=0.0,
            roughness=0.10,
            emission_color=(0.24, 0.72, 1.0),
            emission_strength=5.2,
        ),
        # Subtle Sky-Cyan Kimi Star Emblem Decals on Dorsal Fins
        "kimi_decal": make_solid_pbr_mat(
            "Mat_Kimi_StarDecal",
            base_color=(0.22, 0.62, 1.0),
            metallic=0.24,
            roughness=0.22,
            coat=0.35,
            emission_color=(0.08, 0.42, 1.0),
            emission_strength=0.45,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Sculpted Hard-Surface BMesh Helpers
# ---------------------------------------------------------------------------

def apply_world_box_uv(bm, tile_meters=4.5):
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
    sharp_angle_deg=38.0,
    parent=None,
    uv_tile_m=4.5,
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
    sharp_angle_deg=38.0,
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


def add_beveled_box(
    name, center, size, mat, col,
    bevel=0.02, bevel_segments=2, rot=(0.0, 0.0, 0.0),
    smooth=True, sharp_angle_deg=42.0, parent=None,
):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    if bevel > 0.0:
        b = min(bevel, min(sx, sy, sz) * 0.42)
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
    segments=32, rot=(0.0, 0.0, 0.0), bevel=0.012,
    smooth=True, sharp_angle_deg=40.0, parent=None,
):
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments,
        radius1=radius, radius2=radius, depth=depth,
    )
    if bevel > 0.0:
        b = min(bevel, radius * 0.35, depth * 0.35)
        bmesh.ops.bevel(
            bm, geom=list(bm.edges), offset=b, offset_type="OFFSET",
            segments=2, profile=0.5, affect="EDGES", clamp_overlap=True,
        )
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent)


def add_revolved_x(
    name, center, profile_xr, mat, col,
    segments=64, side=1, smooth=True, sharp_angle_deg=34.0, parent=None,
):
    cx, cy, cz = center
    sections = []
    for s in range(segments):
        ang = 2.0 * math.pi * s / segments
        ca, sa = math.cos(ang), math.sin(ang)
        ring = []
        for dx, r in profile_xr:
            x = cx + side * dx
            y = cy + r * ca
            z = cz + r * sa
            ring.append((x, y, z))
        sections.append(ring)
    return add_lofted_sections(
        name, sections, mat, col,
        closed_loop=True, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


def eval_catmull_rom(pts, samples_per_seg=10):
    vecs = [Vector(p) for p in pts]
    if len(vecs) < 2:
        return vecs
    padded = [vecs[0] + (vecs[0] - vecs[1])] + vecs + [vecs[-1] + (vecs[-1] - vecs[-2])]
    out = []
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
        for k in range(samples_per_seg):
            t = k / float(samples_per_seg)
            t2 = t * t
            t3 = t2 * t
            pt = 0.5 * (
                (2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
            )
            out.append(pt)
    out.append(vecs[-1])
    return out


def add_swept_profile(
    name,
    path_pts,
    profile_uv,
    mat,
    col,
    scale_fn=None,
    up_hint=(0.0, 0.0, 1.0),
    closed_loop=False,
    cap_start=True,
    cap_end=True,
    smooth=True,
    sharp_angle_deg=36.0,
    parent=None,
):
    pts = [Vector(p) for p in path_pts]
    n_pts = len(pts)
    up_vec = Vector(up_hint).normalized()
    sections = []

    for i, p in enumerate(pts):
        if closed_loop:
            t = (pts[(i + 1) % n_pts] - pts[(i - 1) % n_pts]).normalized()
        elif i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == n_pts - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = (pts[i + 1] - pts[i - 1]).normalized()

        ref = up_vec
        if abs(t.dot(ref)) > 0.96:
            ref = Vector((1.0, 0.0, 0.0)) if abs(t.x) < 0.8 else Vector((0.0, 1.0, 0.0))
        u_axis = t.cross(ref).normalized()
        v_axis = u_axis.cross(t).normalized()

        frac = i / float(max(n_pts - 1, 1))
        su, sv = scale_fn(frac) if scale_fn is not None else (1.0, 1.0)
        ring = [tuple(p + u_axis * (u * su) + v_axis * (v * sv)) for u, v in profile_uv]
        sections.append(ring)

    return add_lofted_sections(
        name, sections, mat, col,
        cap_start=cap_start, cap_end=cap_end, closed_loop=closed_loop,
        smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


def rounded_rect_profile(w, h, chamfer=0.22, n_corner=2):
    hw, hh = w * 0.5, h * 0.5
    c = min(chamfer, hw * 0.45, hh * 0.45)
    corners = [
        (hw - c, hh - c, 0.0, math.pi * 0.5),
        (-hw + c, hh - c, math.pi * 0.5, math.pi),
        (-hw + c, -hh + c, math.pi, math.pi * 1.5),
        (hw - c, -hh + c, math.pi * 1.5, math.pi * 2.0),
    ]
    pts = []
    for cx, cy, a0, a1 in corners:
        for k in range(n_corner + 1):
            a = a0 + (a1 - a0) * k / float(n_corner)
            pts.append((cx + c * math.cos(a), cy + c * math.sin(a)))
    return pts


def ellipse_ring_section(y, rx, z_center, rz_top, rz_bot, segments=36, super_exp=2.2):
    ring = []
    for i in range(segments):
        ang = 2.0 * math.pi * i / segments
        ca, sa = math.cos(ang), math.sin(ang)
        sx = math.copysign(abs(ca) ** (2.0 / super_exp), ca)
        sz = math.copysign(abs(sa) ** (2.0 / super_exp), sa)
        x = rx * sx
        z = z_center + (rz_top * sz if sz >= 0.0 else rz_bot * sz)
        ring.append((x, y, z))
    return ring


def add_extruded_poly_y(name, pts_xz, y0, y1, mat, col, bevel=0.02, scale0=1.0, scale1=1.0, smooth=True, parent=None):
    cx = sum(p[0] for p in pts_xz) / len(pts_xz)
    cz = sum(p[1] for p in pts_xz) / len(pts_xz)
    r0 = [(cx + (x - cx) * scale0, y0, cz + (z - cz) * scale0) for x, z in pts_xz]
    r1 = [(cx + (x - cx) * scale1, y1, cz + (z - cz) * scale1) for x, z in pts_xz]
    return add_lofted_sections(name, [r0, r1], mat, col, bevel=bevel, smooth=smooth, parent=parent)


def add_hollow_frame_y(name, outer_xz, inner_xz, y_back, y_front, mat, col, bevel=0.015, smooth=True, parent=None):
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
    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=1, smooth=smooth, sharp_angle_deg=35.0, parent=parent)


def octagon_xz(cx, cz, hw, hh, ch):
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


# ---------------------------------------------------------------------------
# 4. Collection 01: Core Dark Midnight-Navy Fuselage & Mechanical Chassis
# ---------------------------------------------------------------------------

def build_core_chassis(mats, col, root):
    # 1A. Smooth sculpted midnight-navy structural fuselage core (stern Y=-8.4 to forward bow Y=+8.4)
    core_stations = [
        (-8.40, 2.38, -0.02, 0.96, 1.00, 2.6),
        (-7.20, 2.66, -0.02, 1.06, 1.08, 2.5),
        (-5.60, 2.78, -0.04, 1.10, 1.12, 2.4),
        (-3.60, 2.68, -0.06, 1.04, 1.14, 2.3),
        (-1.60, 2.58, -0.04, 1.02, 1.16, 2.3),
        ( 0.40, 2.46, -0.02, 1.08, 1.12, 2.3),
        ( 2.40, 2.26, -0.04, 1.08, 1.02, 2.2),
        ( 4.40, 2.04, -0.10, 0.96, 0.90, 2.2),
        ( 6.00, 1.76, -0.18, 0.78, 0.74, 2.2),
        ( 7.30, 1.38, -0.26, 0.54, 0.56, 2.2),
        ( 8.35, 0.96, -0.32, 0.34, 0.38, 2.2),
    ]
    sections = [
        ellipse_ring_section(y, rx, zc, rzt, rzb, segments=36, super_exp=se)
        for (y, rx, zc, rzt, rzb, se) in core_stations
    ]
    add_lofted_sections(
        "Chassis_MainNavyCore", sections, mats["navy_chassis"], col,
        smooth=True, sharp_angle_deg=48.0, parent=root,
    )

    # 1B. Unified Sculpted Glossy Sapphire-Obsidian Rounded-Radome Bow Prow (Y = +6.50 .. +9.92)
    # Full, smooth bullet-train / luxury starfighter rounded nose dome (ZERO thin needle/beak spike!).
    prow_stations = [
        # (y, rx, z_center, rz_top, rz_bot, super_exp)
        ( 6.50, 1.66, -0.32, 0.90, 0.64, 2.3),
        ( 7.35, 1.44, -0.33, 0.78, 0.56, 2.3),
        ( 8.15, 1.18, -0.34, 0.60, 0.47, 2.3),
        ( 8.80, 0.92, -0.35, 0.42, 0.38, 2.2),
        ( 9.28, 0.68, -0.36, 0.28, 0.28, 2.2),
        ( 9.60, 0.48, -0.36, 0.19, 0.20, 2.1),
        ( 9.80, 0.30, -0.36, 0.12, 0.13, 2.0),
        ( 9.90, 0.15, -0.36, 0.065, 0.070, 2.0),
        ( 9.94, 0.05, -0.36, 0.024, 0.026, 2.0),
    ]
    nose_secs = [
        ellipse_ring_section(y, rx, zc, rzt, rzb, segments=44, super_exp=se)
        for (y, rx, zc, rzt, rzb, se) in prow_stations
    ]
    add_lofted_sections(
        "Chassis_ObsidianSapphireProw", nose_secs, mats["obsidian_blue"], col,
        smooth=True, sharp_angle_deg=70.0, parent=root,
    )

    # 1C. Flush Luminous Ice-Cyan Nose Prism Facet right at Canopy-Prow Transition (FRONT & TOP views)
    prism_secs = [
        [(0.0, 7.95, 0.38), (0.44, 7.95, 0.20), (0.34, 7.95, 0.04), (-0.34, 7.95, 0.04), (-0.44, 7.95, 0.20)],
        [(0.0, 8.55, 0.18), (0.32, 8.55, 0.04), (0.24, 8.55, -0.06), (-0.24, 8.55, -0.06), (-0.32, 8.55, 0.04)],
        [(0.0, 9.05, -0.02), (0.15, 9.05, -0.10), (0.10, 9.05, -0.16), (-0.10, 9.05, -0.16), (-0.15, 9.05, -0.10)],
    ]
    add_lofted_sections("Nose_IceCrystalPrism", prism_secs, mats["ice_skylight"], col, bevel=0.015, smooth=True, parent=root)

    # 1D. Clean Symmetrical Forward Ventral Chin Sensor/Intake Pod (Y = +4.4 .. +7.4)
    chin_secs = [
        [(x, 4.35, z) for x, z in [(-0.68, -0.92), (0.68, -0.92), (0.58, -1.42), (-0.58, -1.42)]],
        [(x, 5.55, z) for x, z in [(-0.78, -0.88), (0.78, -0.88), (0.66, -1.52), (-0.66, -1.52)]],
        [(x, 6.75, z) for x, z in [(-0.70, -0.82), (0.70, -0.82), (0.58, -1.46), (-0.58, -1.46)]],
        [(x, 7.40, z) for x, z in [(-0.54, -0.78), (0.54, -0.78), (0.42, -1.24), (-0.42, -1.24)]],
    ]
    add_lofted_sections("Chin_SensorPodHousing", chin_secs, mats["dark_machinery"], col, bevel=0.04, smooth=True, parent=root)
    add_beveled_box(
        "Chin_SensorPodLowerSkid", (0.0, 5.90, -1.50), (1.02, 2.10, 0.14),
        mats["navy_chassis"], col, bevel=0.03, parent=root,
    )
    add_beveled_box(
        "Chin_SensorPodFrontCavity", (0.0, 7.22, -1.14), (0.82, 0.30, 0.34),
        mats["cavity_dark"], col, bevel=0.015, parent=root,
    )
    for k in range(4):
        add_beveled_box(
            f"Chin_SensorLouver_{k}", (0.0, 7.32, -1.25 + k * 0.075), (0.74, 0.07, 0.028),
            mats["silver_trim"], col, bevel=0.004, parent=root,
        )

    # 1E. Recessed Dorsal Mechanical Bay (visible in TOP view beneath central dorsal arch)
    add_beveled_box(
        "DorsalBay_RecessFloor", (0.0, -2.75, 0.94), (3.10, 5.40, 0.24),
        mats["cavity_dark"], col, bevel=0.04, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        well_outer = []
        for s in range(28):
            a = 2.0 * math.pi * s / 28
            well_outer.append((side * 0.96 + 0.44 * math.cos(a), -1.75 + 0.98 * math.sin(a), 1.05))
        well_inner = [(x, y, 1.24) for (x, y, _) in well_outer]
        add_lofted_sections(
            f"DorsalBay_IntakeRim_{tag}", [well_outer, well_inner],
            mats["dark_machinery"], col, bevel=0.02, cap_start=False, cap_end=False, parent=root,
        )
        for r_i in range(5):
            add_beveled_box(
                f"DorsalBay_IntakeSlat_{tag}_{r_i}",
                (side * 0.96, -2.35 + r_i * 0.30, 1.12), (0.64, 0.07, 0.14),
                mats["navy_chassis"], col, bevel=0.01, parent=root,
            )
        add_cylinder(
            f"DorsalBay_CoolantPipe_{tag}", (side * 0.42, -2.55, 1.14),
            radius=0.10, depth=4.60, mat=mats["dark_machinery"], col=col,
            segments=16, rot=(math.pi / 2.0, 0.0, 0.0), parent=root,
        )
        # Sleek curved dorsal sensor antennae arcs
        ant_pts = eval_catmull_rom([
            (side * 1.14, -1.65, 1.32),
            (side * 1.46, -1.85, 1.86),
            (side * 1.30, -2.25, 2.38),
            (side * 0.92, -2.58, 2.48),
        ], samples_per_seg=8)
        add_swept_profile(
            f"DorsalBay_SensorArc_{tag}", ant_pts,
            rounded_rect_profile(0.05, 0.05, 0.018, 1),
            mats["dark_machinery"], col, parent=root,
        )

    # 1F. Sculpted Full-Length Ventral Belly Keel & Grav-Emitter Core (sealed aft belly — ZERO dark void!)
    belly_secs = [
        [(-1.52, -8.50, -0.96), (1.52, -8.50, -0.96), (1.24, -8.50, -1.16), (-1.24, -8.50, -1.16)],
        [(-1.78, -6.90, -0.98), (1.78, -6.90, -0.98), (1.46, -6.90, -1.22), (-1.46, -6.90, -1.22)],
        [(-2.00, -5.00, -1.00), (2.00, -5.00, -1.00), (1.64, -5.00, -1.26), (-1.64, -5.00, -1.26)],
        [(-2.06, -2.40, -1.00), (2.06, -2.40, -1.00), (1.68, -2.40, -1.28), (-1.68, -2.40, -1.28)],
        [(-1.84,  0.40, -0.98), (1.84,  0.40, -0.98), (1.46,  0.40, -1.24), (-1.46,  0.40, -1.24)],
        [(-1.42,  3.20, -0.92), (1.42,  3.20, -0.92), (1.06,  3.20, -1.16), (-1.06,  3.20, -1.16)],
        [(-0.92,  5.60, -0.82), (0.92,  5.60, -0.82), (0.64,  5.60, -1.00), (-0.64,  5.60, -1.00)],
    ]
    add_lofted_sections(
        "Ventral_SculptedBellyFairing", belly_secs, mats["navy_chassis"], col,
        bevel=0.035, smooth=True, sharp_angle_deg=38.0, parent=root,
    )
    # Sculpted aft ventral mechanical keel plate & cooling ribs bridging between halo ring & stern lip
    add_beveled_box(
        "Ventral_AftKeelPlate", (0.0, -5.75, -1.22), (2.20, 2.35, 0.14),
        mats["dark_machinery"], col, bevel=0.03, parent=root,
    )
    for k in range(5):
        add_beveled_box(
            f"Ventral_AftHeatSlat_{k}", (0.0, -6.65 + k * 0.42, -1.28), (1.68, 0.12, 0.06),
            mats["silver_trim"], col, bevel=0.008, parent=root,
        )
    # Recessed ventral grav-core emitter nestled cleanly inside the Symmetrical Ventral Halo Ring!
    add_cylinder(
        "Ventral_GravCoreBezel", (0.0, -2.55, -1.28),
        radius=0.96, depth=0.22, mat=mats["dark_machinery"], col=col,
        segments=40, bevel=0.025, parent=root,
    )
    add_cylinder(
        "Ventral_GravCoreOuterRing", (0.0, -2.55, -1.36),
        radius=0.66, depth=0.10, mat=mats["cyan_glow"], col=col,
        segments=36, bevel=0.012, parent=root,
    )
    add_cylinder(
        "Ventral_GravCoreCenterHub", (0.0, -2.55, -1.38),
        radius=0.38, depth=0.12, mat=mats["obsidian_blue"], col=col,
        segments=32, bevel=0.02, parent=root,
    )
    # Longitudinal ventral heat-dissipation ribs along forward belly
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        for k in range(5):
            add_beveled_box(
                f"Ventral_BellyRib_{tag}_{k}", (side * 0.72, -0.15 + k * 0.78, -1.24),
                (0.46, 0.14, 0.08), mats["dark_machinery"], col, bevel=0.012, parent=root,
            )


# ---------------------------------------------------------------------------
# 5. Collection 02: Pearl-White Sculpted Luxury Armor Shell
# ---------------------------------------------------------------------------

def build_pearl_white_armor(mats, col, root):
    # 2A. Sculpted Flush Pearl-White Upper Bow Cheeks & Lower Chin Fairing Panels
    # Directly lofted from matched hull cross-sections so the bow forms ONE cohesive luxury
    # aerodynamic sculpture around the glossy sapphire prow & canopy (ZERO floating tubes or crab-pincer gaps!).
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Upper sculpted bow cheek armor hugging canopy sill on inside & tapering flush onto sapphire prow!
        # Station tuple: (y, x_in, z_in, x_crown, z_crown, x_out, z_out, x_under, z_under)
        upper_bow_stations = [
            ( 9.48, 0.42, -0.15, 0.56, -0.19, 0.60, -0.27, 0.44, -0.28),
            ( 9.00, 0.56,  0.02, 0.84, -0.04, 0.94, -0.24, 0.66, -0.28),
            ( 8.25, 0.82,  0.22, 1.22,  0.14, 1.40, -0.18, 0.96, -0.27),
            ( 7.35, 1.12,  0.40, 1.56,  0.34, 1.78, -0.14, 1.24, -0.26),
            ( 6.30, 1.38,  0.56, 1.88,  0.54, 2.08, -0.10, 1.52, -0.24),
            ( 5.10, 1.54,  0.72, 2.12,  0.72, 2.28, -0.06, 1.72, -0.22),
            ( 3.80, 1.60,  0.86, 2.26,  0.88, 2.40, -0.02, 1.84, -0.18),
            ( 2.40, 1.58,  0.98, 2.34,  1.02, 2.46,  0.08, 1.92, -0.12),
            ( 0.80, 1.66,  1.10, 2.38,  1.12, 2.50,  0.26, 2.00,  0.04),
            (-1.20, 1.82,  1.16, 2.44,  1.16, 2.54,  0.44, 2.08,  0.24),
            (-3.40, 1.94,  1.14, 2.52,  1.14, 2.62,  0.56, 2.16,  0.38),
            (-5.30, 2.04,  1.08, 2.62,  1.06, 2.72,  0.62, 2.24,  0.46),
        ]
        # Resample smoothly with Catmull-Rom along each profile vertex for ultra-silky automotive curvature!
        ctrl_rings = []
        for (y, xi, zi, xc, zc, xo, zo, xu, zu) in upper_bow_stations:
            # 10-point sleek rounded-bevel cross-section hugging canopy & cheek
            xm1, zm1 = 0.5 * (xi + xc), 0.5 * (zi + zc) + 0.04
            xm2, zm2 = 0.5 * (xc + xo), 0.5 * (zc + zo) + 0.05
            xb1, zb1 = 0.5 * (xo + xu), 0.5 * (zo + zu) - 0.02
            xb2, zb2 = 0.5 * (xu + xi), 0.5 * (zu + zi) - 0.04
            pts = [
                (side * xi, y, zi),
                (side * xm1, y, zm1),
                (side * xc, y, zc),
                (side * xm2, y, zm2),
                (side * xo, y, zo),
                (side * xb1, y, zb1),
                (side * xu, y, zu),
                (side * xb2, y, zb2),
            ]
            if side < 0:
                pts = list(reversed(pts))
            ctrl_rings.append(pts)
        # Interpolate each vertex track with Catmull-Rom (4 substeps per station -> 45 silky stations!)
        n_v = len(ctrl_rings[0])
        interp_tracks = [eval_catmull_rom([ring[k] for ring in ctrl_rings], samples_per_seg=4) for k in range(n_v)]
        n_st = len(interp_tracks[0])
        upper_secs = [[tuple(interp_tracks[k][s]) for k in range(n_v)] for s in range(n_st)]
        add_lofted_sections(
            f"Armor_UpperBowCheekShell_{tag}", upper_secs, mats["armor_pearl"], col,
            smooth=True, sharp_angle_deg=38.0, parent=root,
        )

        # Lower sculpted pearl-white bow chin cheek fairing (sits flush below horizontal blue crease,
        # wraps cleanly around the glossy sapphire belly nose down to the chin pod — ZERO gaps!)
        # Tuple: (y, x_top_in, z_top_in, x_top_out, z_top_out, x_mid_out, z_mid_out, x_bot, z_bot, x_bot_in, z_bot_in)
        lower_bow_stations = [
            ( 9.48, 0.32, -0.44, 0.58, -0.45, 0.54, -0.53, 0.34, -0.60, 0.22, -0.56),
            ( 8.80, 0.50, -0.44, 0.94, -0.45, 0.90, -0.59, 0.58, -0.74, 0.38, -0.70),
            ( 7.85, 0.70, -0.45, 1.38, -0.45, 1.32, -0.66, 0.84, -0.88, 0.56, -0.84),
            ( 6.60, 0.86, -0.46, 1.82, -0.47, 1.74, -0.74, 1.08, -1.00, 0.72, -0.94),
            ( 5.20, 0.98, -0.48, 2.16, -0.48, 2.08, -0.80, 1.32, -1.08, 0.88, -1.00),
            ( 3.50, 1.12, -0.52, 2.34, -0.52, 2.26, -0.84, 1.54, -1.14, 1.06, -1.06),
            ( 1.40, 1.32, -0.58, 2.38, -0.58, 2.32, -0.90, 1.72, -1.18, 1.24, -1.10),
            (-1.20, 1.48, -0.64, 2.42, -0.64, 2.36, -0.96, 1.84, -1.20, 1.38, -1.12),
            (-3.60, 1.56, -0.66, 2.44, -0.66, 2.38, -0.96, 1.88, -1.18, 1.44, -1.10),
            (-5.10, 1.60, -0.66, 2.40, -0.66, 2.34, -0.94, 1.86, -1.14, 1.48, -1.06),
        ]
        l_ctrl = []
        for (y, xti, zti, xto, zto, xmo, zmo, xb, zb, xbi, zbi) in lower_bow_stations:
            pts = [
                (side * xti, y, zti),
                (side * xto, y, zto),
                (side * xmo, y, zmo),
                (side * xb,  y, zb),
                (side * xbi, y, zbi),
                (side * (0.5 * (xbi + xti)), y, 0.5 * (zbi + zti)),
            ]
            if side < 0:
                pts = list(reversed(pts))
            l_ctrl.append(pts)
        n_lv = len(l_ctrl[0])
        l_tracks = [eval_catmull_rom([ring[k] for ring in l_ctrl], samples_per_seg=4) for k in range(n_lv)]
        n_lst = len(l_tracks[0])
        lower_secs = [[tuple(l_tracks[k][s]) for k in range(n_lv)] for s in range(n_lst)]
        add_lofted_sections(
            f"Armor_LowerBowChinShell_{tag}", lower_secs, mats["armor_pearl"], col,
            smooth=True, sharp_angle_deg=38.0, parent=root,
        )

        # Compact Integrated Swept Forward Cheek Winglet Flare (Y = +1.95 .. +5.15, max |X| = 3.04 m!)
        # Directly matches FRONT, SIDE & TOP references: sleek sculpted diamond-blade winglet flaring
        # smoothly from the bow flank and leaving the dark hydraulic canyon open ahead of the circular pod!
        winglet_stations = [
            # (y, x_root, x_tip, z_top, z_edge, z_bot)
            (5.15, 1.88, 2.26,  0.04, -0.26, -0.52),
            (4.35, 1.96, 2.66,  0.06, -0.30, -0.54),
            (3.45, 2.02, 2.98,  0.04, -0.33, -0.54),
            (2.65, 2.00, 3.06,  0.00, -0.35, -0.52),
            (2.12, 1.98, 2.68, -0.06, -0.35, -0.50),
            (1.90, 1.96, 2.24, -0.14, -0.35, -0.46),
        ]
        w_ctrl = []
        for (y, xr, xt, zt, ze, zb) in winglet_stations:
            xm = 0.5 * (xr + xt)
            pts = [
                (side * xr, y, zt),
                (side * xm, y, 0.55 * zt + 0.45 * ze + 0.03),
                (side * xt, y, ze + 0.035),
                (side * xt, y, ze - 0.035),
                (side * xm, y, 0.55 * zb + 0.45 * ze - 0.02),
                (side * xr, y, zb),
            ]
            if side < 0:
                pts = list(reversed(pts))
            w_ctrl.append(pts)
        n_wv = len(w_ctrl[0])
        w_tracks = [eval_catmull_rom([ring[k] for ring in w_ctrl], samples_per_seg=4) for k in range(n_wv)]
        n_wst = len(w_tracks[0])
        wing_secs = [[tuple(w_tracks[k][s]) for k in range(n_wv)] for s in range(n_wst)]
        add_lofted_sections(
            f"Armor_FwdCanardWinglet_{tag}", wing_secs, mats["armor_fin"], col,
            smooth=True, sharp_angle_deg=36.0, parent=root,
        )

        # Sweeping Side Fuselage Upper Shoulder Fairing (smoothly tapered at BOTH ends — ZERO blunt overhang!)
        shoulder_pts = eval_catmull_rom([
            (side * 1.66,  2.75,  1.16),
            (side * 2.02,  1.25,  1.28),
            (side * 2.28, -0.80,  1.28),
            (side * 2.48, -3.20,  1.22),
            (side * 2.60, -5.75,  1.10),
            (side * 2.26, -7.70,  1.00),
        ], samples_per_seg=10)
        sh_prof = [(-0.48, -0.15), (0.52, -0.22), (0.44, 0.20), (-0.36, 0.24)]
        sh_prof_s = [(side * u, v) for (u, v) in sh_prof]
        if side < 0:
            sh_prof_s = list(reversed(sh_prof_s))
        add_swept_profile(
            f"Armor_DorsalShoulderFlank_{tag}", shoulder_pts, sh_prof_s,
            mats["armor_pearl"], col,
            scale_fn=lambda t: (0.28 + 0.84 * math.sin(t * math.pi), 0.34 + 0.72 * math.sin(t * math.pi)),
            smooth=True, sharp_angle_deg=36.0, parent=root,
        )

    # 2B. Sweeping Pearl-White Upper Canopy Brow / Dorsal Hood Cowling (pulled cleanly back to Y=+4.25
    # so the FULL panoramic sapphire glass dome Y=+3.6..+9.0 shines proudly in HERO, TOP & SIDE views!)
    hood_stations = [
        # (y, half_w, z_top, z_edge, thick)
        ( 4.25, 1.24, 1.88, 1.48, 0.12),
        ( 3.70, 1.56, 2.02, 1.44, 0.18),
        ( 2.85, 1.78, 2.10, 1.38, 0.24),
        ( 1.85, 1.82, 2.06, 1.32, 0.24),
        ( 0.85, 1.66, 1.94, 1.22, 0.22),
        (-0.15, 1.26, 1.68, 1.12, 0.20),
        (-1.10, 0.62, 1.32, 1.04, 0.15),
    ]
    hood_secs = []
    for (y, hw, zt, ze, th) in hood_stations:
        upper = []
        for k in range(15):
            u = -1.0 + 2.0 * k / 14.0
            x = hw * u
            z = ze + (zt - ze) * (1.0 - u * u) ** 0.72
            upper.append((x, y, z))
        lower = []
        for k in range(14, -1, -1):
            u = -1.0 + 2.0 * k / 14.0
            x = hw * 0.90 * u
            z = (ze - 0.04) + (zt - ze - th) * (1.0 - u * u) ** 0.78
            lower.append((x, y, z))
        hood_secs.append(upper + lower)
    add_lofted_sections(
        "Armor_DorsalCanopyHood", hood_secs, mats["armor_pearl"], col,
        smooth=True, sharp_angle_deg=38.0, parent=root,
    )

    # Frosted Ice-Blue Dorsal Skylight / Sensor Panel on top of Canopy Hood (TOP view!)
    sky_secs = [
        [(-0.56, 3.25, 2.06), (0.56, 3.25, 2.06), (0.64, 3.25, 1.96), (-0.64, 3.25, 1.96)],
        [(-0.74, 2.25, 2.14), (0.74, 2.25, 2.14), (0.82, 2.25, 2.02), (-0.82, 2.25, 2.02)],
        [(-0.60, 1.15, 2.02), (0.60, 1.15, 2.02), (0.68, 1.15, 1.92), (-0.68, 1.15, 1.92)],
        [(-0.34, 0.35, 1.82), (0.34, 0.35, 1.82), (0.40, 0.35, 1.74), (-0.40, 0.35, 1.74)],
    ]
    add_lofted_sections("Armor_HoodIceSkylight", sky_secs, mats["ice_skylight"], col, bevel=0.015, smooth=True, parent=root)

    # 2C. Iconic Rear Outboard Open Faceted White C-Bracket Cowling Pods (HERO, SIDE, TOP, REAR views!)
    # Sculpted hollow open-frame hexagonal shield revealing the dark inner turbines & cyan conduit!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Outer main chamfered vertical armor shield (compact Y=-8.15..-5.55 so fore & aft cutaways breathe!)
        cowl_pts_xz = [
            (side * 3.42,  0.98),
            (side * 4.24,  0.74),
            (side * 4.40,  0.08),
            (side * 4.28, -0.68),
            (side * 3.55, -1.04),
            (side * 3.12, -0.96),
            (side * 3.52, -0.56),
            (side * 3.60,  0.08),
            (side * 3.44,  0.60),
            (side * 3.00,  0.92),
        ]
        if side < 0:
            cowl_pts_xz = list(reversed(cowl_pts_xz))
        cowl_secs = [
            [(x * 0.94, -8.35, z * 0.88) for (x, z) in cowl_pts_xz],
            [(x * 1.00, -7.25, z * 1.02) for (x, z) in cowl_pts_xz],
            [(x * 0.99, -6.05, z * 1.02) for (x, z) in cowl_pts_xz],
            [(x * 0.93, -5.25, z * 0.90) for (x, z) in cowl_pts_xz],
        ]
        add_lofted_sections(
            f"Armor_AftOutboardCowl_{tag}", cowl_secs, mats["armor_pearl"], col,
            bevel=0.025, smooth=True, sharp_angle_deg=34.0, parent=root,
        )

        # Integrated Sculpted Upper & Lower C-Bracket Bridge Shoulders (flush with outer shield & hull —
        # ZERO protruding ruler-arms or blunt overhangs in Rear 3/4, Side or Bottom views!)
        upper_bridge_secs = [
            [(side * 2.22, -8.25, 1.04), (side * 3.38, -8.12, 0.94), (side * 3.28, -8.12, 0.68), (side * 2.18, -8.25, 0.78)],
            [(side * 2.38, -7.00, 1.18), (side * 3.82, -6.90, 1.02), (side * 3.66, -6.90, 0.72), (side * 2.30, -7.00, 0.84)],
            [(side * 2.44, -5.75, 1.16), (side * 3.64, -5.80, 0.96), (side * 3.48, -5.80, 0.70), (side * 2.36, -5.75, 0.84)],
            [(side * 2.40, -5.25, 1.10), (side * 3.16, -5.32, 0.88), (side * 3.04, -5.32, 0.68), (side * 2.32, -5.25, 0.82)],
        ]
        if side < 0:
            upper_bridge_secs = [list(reversed(s)) for s in upper_bridge_secs]
        add_lofted_sections(
            f"Armor_AftCowlUpperBridge_{tag}", upper_bridge_secs,
            mats["armor_pearl"], col, bevel=0.02, smooth=True, sharp_angle_deg=35.0, parent=root,
        )

        lower_bridge_secs = [
            [(side * 2.10, -8.20, -0.78), (side * 3.38, -8.08, -0.74), (side * 3.46, -8.08, -1.00), (side * 2.02, -8.20, -1.06)],
            [(side * 2.18, -6.95, -0.84), (side * 3.74, -6.88, -0.78), (side * 3.84, -6.88, -1.08), (side * 2.10, -6.95, -1.14)],
            [(side * 2.22, -5.75, -0.84), (side * 3.54, -5.80, -0.76), (side * 3.64, -5.80, -1.04), (side * 2.14, -5.75, -1.12)],
            [(side * 2.18, -5.25, -0.82), (side * 3.08, -5.32, -0.74), (side * 3.16, -5.32, -0.96), (side * 2.10, -5.25, -1.06)],
        ]
        if side < 0:
            lower_bridge_secs = [list(reversed(s)) for s in lower_bridge_secs]
        add_lofted_sections(
            f"Armor_AftCowlLowerBridge_{tag}", lower_bridge_secs,
            mats["armor_pearl"], col, bevel=0.02, smooth=True, sharp_angle_deg=35.0, parent=root,
        )

        # Exposed Dark Cylindrical Turbine Pipes & Ribs visible inside the hollow C-bracket cutaway!
        for z_pipe in (-0.38, 0.34):
            add_cylinder(
                f"AftCowl_ExposedPipe_{tag}_{int(z_pipe*100)}", (side * 3.02, -5.85, z_pipe),
                radius=0.18, depth=3.35, mat=mats["dark_machinery"], col=col,
                segments=18, rot=(math.pi / 2.0, 0.0, 0.0), parent=root,
            )
        for r_i in range(4):
            add_beveled_box(
                f"AftCowl_InnerRib_{tag}_{r_i}",
                (side * 3.24, -7.20 + r_i * 0.72, 0.00), (0.38, 0.10, 1.14),
                mats["navy_chassis"], col, bevel=0.012, parent=root,
            )
        # Outer glowing cobalt-blue horizontal trim slit on aft cowl shield
        add_beveled_box(
            f"AftCowl_OuterLightSlot_{tag}", (side * 4.38, -6.75, -0.18), (0.09, 1.08, 0.14),
            mats["cavity_dark"], col, bevel=0.01, parent=root,
        )
        add_beveled_box(
            f"AftCowl_OuterCyanLight_{tag}", (side * 4.41, -6.75, -0.18), (0.045, 0.90, 0.070),
            mats["cyan_glow"], col, bevel=0.005, parent=root,
        )

    # 2D. Dorsal Rear Deck & Sharp Pointed White Stern Tail Diffuser Lip (Y = -10.00 .. -5.60)
    dorsal_stern_secs = [
        [(-2.32, -5.60, 1.14), (2.32, -5.60, 1.14), (2.52, -5.60, 0.88), (-2.52, -5.60, 0.88)],
        [(-2.12, -7.05, 1.22), (2.12, -7.05, 1.22), (2.28, -7.05, 0.96), (-2.28, -7.05, 0.96)],
        [(-1.74, -8.35, 1.26), (1.74, -8.35, 1.26), (1.86, -8.35, 1.02), (-1.86, -8.35, 1.02)],
        [(-1.12, -9.30, 1.26), (1.12, -9.30, 1.26), (1.20, -9.30, 1.08), (-1.20, -9.30, 1.08)],
        [(-0.20, -10.00, 1.24), (0.20, -10.00, 1.24), (0.24, -10.00, 1.14), (-0.24, -10.00, 1.14)],
    ]
    add_lofted_sections(
        "Armor_SternDorsalTailHood", dorsal_stern_secs, mats["armor_pearl"], col,
        bevel=0.025, smooth=True, sharp_angle_deg=34.0, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Stern_DorsalTailVent_{tag}", (side * 0.24, -9.05, 1.26), (0.26, 0.62, 0.08),
            mats["cavity_dark"], col, bevel=0.01, parent=root,
        )

    # Matching Lower Ventral Stern Diffuser Lip (Y = -9.45 .. -6.50)
    ventral_stern_secs = [
        [(-2.18, -6.50, -0.96), (2.18, -6.50, -0.96), (1.98, -6.50, -1.24), (-1.98, -6.50, -1.24)],
        [(-1.82, -8.10, -0.98), (1.82, -8.10, -0.98), (1.62, -8.10, -1.24), (-1.62, -8.10, -1.24)],
        [(-1.26, -9.45, -1.04), (1.26, -9.45, -1.04), (1.10, -9.45, -1.22), (-1.10, -9.45, -1.22)],
    ]
    add_lofted_sections(
        "Armor_SternVentralDiffuserLip", ventral_stern_secs, mats["armor_pearl"], col,
        bevel=0.022, smooth=True, sharp_angle_deg=34.0, parent=root,
    )


# ---------------------------------------------------------------------------
# 6. Collection 03: Panoramic Deep-Sapphire Cockpit Canopy & Glowing Interior
# ---------------------------------------------------------------------------

def build_cockpit_canopy(mats, col, root):
    # 3A. Detailed Dark Cockpit Tub + Pilot Seat + Subtle Holographic Blue Console
    add_beveled_box(
        "Cockpit_InteriorFloor", (0.0, 5.45, 0.04), (2.10, 4.30, 0.16),
        mats["cavity_dark"], col, bevel=0.02, parent=root,
    )
    add_beveled_box(
        "Cockpit_PilotSeatBase", (0.0, 4.65, 0.24), (0.82, 0.88, 0.24),
        mats["cavity_dark"], col, bevel=0.05, parent=root,
    )
    add_beveled_box(
        "Cockpit_PilotSeatBack", (0.0, 4.02, 0.66), (0.58, 0.18, 0.72),
        mats["obsidian_blue"], col, bevel=0.06, rot=(-0.34, 0.0, 0.0), parent=root,
    )
    # Fighter-seat contoured side bolsters, shoulder harness frame & dual control sticks!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Cockpit_SeatBolster_{tag}", (side * 0.34, 4.12, 0.64), (0.14, 0.24, 0.62),
            mats["dark_machinery"], col, bevel=0.03, rot=(-0.34, side * 0.22, 0.0), parent=root,
        )
        add_beveled_box(
            f"Cockpit_SideConsole_{tag}", (side * 0.86, 5.10, 0.36), (0.34, 1.95, 0.22),
            mats["navy_chassis"], col, bevel=0.03, rot=(0.0, -side * 0.16, side * 0.10), parent=root,
        )
        add_cylinder(
            f"Cockpit_FlightStick_{tag}", (side * 0.66, 5.25, 0.56),
            radius=0.028, depth=0.28, mat=mats["silver_trim"], col=col,
            segments=12, rot=(0.24, 0.0, 0.0), parent=root,
        )
        for pip_i in range(4):
            add_beveled_box(
                f"Cockpit_ConsolePip_{tag}_{pip_i}", (side * 0.82, 4.55 + pip_i * 0.34, 0.49),
                (0.06, 0.14, 0.022), mats["cyan_glow"], col, bevel=0.004, parent=root,
            )
    # Multi-screen holographic MFD glass displays hovering above flight deck
    for mx, my, mz, mrot, mtag in [
        ( 0.00, 6.46, 0.78, (-0.32, 0.0, 0.0), "Center"),
        (-0.56, 6.18, 0.74, (-0.28, 0.0, 0.38), "Port"),
        ( 0.56, 6.18, 0.74, (-0.28, 0.0, -0.38), "Stbd"),
    ]:
        add_beveled_box(
            f"Cockpit_HoloMFD_{mtag}", (mx, my, mz), (0.42, 0.018, 0.22),
            mats["ice_skylight"], col, bevel=0.006, rot=mrot, parent=root,
        )
        add_beveled_box(
            f"Cockpit_HoloMFDRim_{mtag}", (mx, my - 0.01, mz - 0.115), (0.44, 0.04, 0.025),
            mats["cyan_bright"], col, bevel=0.005, rot=mrot, parent=root,
        )
    # Curved cobalt-cyan holographic instrument dash visible subtly through dark sapphire glass
    hud_pts = eval_catmull_rom([
        (-0.96, 5.65, 0.50),
        (-0.60, 6.48, 0.56),
        ( 0.00, 6.76, 0.58),
        ( 0.60, 6.48, 0.56),
        ( 0.96, 5.65, 0.50),
    ], samples_per_seg=8)
    add_swept_profile(
        "Cockpit_ConsoleShroud", hud_pts,
        rounded_rect_profile(0.24, 0.20, 0.04, 1),
        mats["dark_machinery"], col, parent=root,
    )
    add_swept_profile(
        "Cockpit_HoloHudStrip", [p + Vector((0.0, -0.05, 0.11)) for p in hud_pts],
        rounded_rect_profile(0.045, 0.075, 0.014, 1),
        mats["cyan_glow"], col, parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Cockpit_SideTrimGlow_{tag}", (side * 1.08, 5.35, 0.42), (0.055, 2.55, 0.045),
            mats["cyan_glow"], col, bevel=0.008, rot=(0.0, 0.0, side * 0.14), parent=root,
        )

    # 3B. Sleek Extended Teardrop Panoramic Deep-Sapphire Tinted Glass Canopy (Y = +3.3 .. +9.05)
    # Fully exposed, swooping luxuriously forward into the obsidian nose!
    canopy_stations = [
        # (y, half_w, z_base, z_peak)
        (3.30, 1.48, 0.62, 1.84),
        (4.15, 1.58, 0.54, 1.86),
        (5.15, 1.54, 0.42, 1.72),
        (6.15, 1.38, 0.28, 1.44),
        (7.15, 1.10, 0.12, 1.06),
        (8.05, 0.74, -0.04, 0.62),
        (8.72, 0.38, -0.14, 0.24),
        (9.08, 0.10, -0.20, -0.02),
    ]
    glass_secs = []
    n_arc = 24
    for (y, hw, zb, zp) in canopy_stations:
        pts = []
        for k in range(n_arc + 1):
            ang = math.pi * (1.0 - k / float(n_arc))
            x = hw * math.cos(ang)
            z = zb + (zp - zb) * (math.sin(ang) ** 0.84)
            pts.append((x, y, z))
        pts.append((hw * 0.88, y, zb - 0.10))
        pts.append((-hw * 0.88, y, zb - 0.10))
        glass_secs.append(pts)
    add_lofted_sections(
        "Cockpit_SapphireCanopyGlass", glass_secs, mats["canopy_glass"], col,
        smooth=True, sharp_angle_deg=60.0, parent=root,
    )

    # 3C. Flush Recessed Internal Canopy Structural Roll-Bars (tucked cleanly INSIDE glass!)
    for y_rib, hw, zb, zp, tag in [
        (4.25, 1.52, 0.52, 1.79, "RearBrow"),
        (6.10, 1.32, 0.27, 1.39, "MidArch"),
    ]:
        rib_pts = []
        for k in range(19):
            ang = math.pi * (1.0 - k / 18.0)
            rib_pts.append((hw * math.cos(ang), y_rib, zb + (zp - zb) * (math.sin(ang) ** 0.84)))
        add_swept_profile(
            f"Cockpit_CanopyInnerRib_{tag}", rib_pts,
            rounded_rect_profile(0.07, 0.055, 0.018, 1),
            mats["obsidian_blue"], col, parent=root,
        )
    # Canopy sill rim framing left & right edges cleanly against white cheeks
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        sill_pts = eval_catmull_rom([
            (side * 1.50, 3.35, 0.62),
            (side * 1.58, 4.95, 0.44),
            (side * 1.36, 6.45, 0.22),
            (side * 0.86, 7.90, -0.02),
            (side * 0.24, 8.88, -0.16),
        ], samples_per_seg=8)
        add_swept_profile(
            f"Cockpit_CanopySill_{tag}", sill_pts,
            rounded_rect_profile(0.11, 0.075, 0.025, 1),
            mats["obsidian_blue"], col, parent=root,
        )


# ---------------------------------------------------------------------------
# 7. Collection 04: Twin Circular Lateral Grav-Ring Nacelles (Hero Signature!)
# ---------------------------------------------------------------------------

def build_twin_grav_ring_nacelles(mats, col, root):
    pod_y = -0.85
    pod_z = -0.45
    pod_x_mag = 3.85

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        cx = side * pod_x_mag
        center = (cx, pod_y, pod_z)

        # 4A. True Plump Rounded Hemispherical Glossy Obsidian Inner Pod Dome (matches FRONT/TOP refs!)
        # Smooth elliptical dome curving from |X|=2.40 (dx=-1.45) out to the white outer shroud (dx=+0.26)
        inner_dome_prof = []
        n_d = 18
        for k in range(n_d + 1):
            a = (math.pi * 0.5) * k / float(n_d)  # 0 (inner pole) -> pi/2 (rim meeting white casing)
            dx = 0.24 - 1.52 * math.cos(a)
            r = 0.54 + 1.24 * math.sin(a)
            inner_dome_prof.append((dx, r))
        inner_dome_prof.extend([(0.24, 1.12), (-1.28, 0.54)])
        add_revolved_x(
            f"GravPod_InnerObsidianDome_{tag}", center, inner_dome_prof,
            mats["obsidian_blue"], col, segments=64, side=side, sharp_angle_deg=38.0, parent=root,
        )

        # 4B. Sculpted Pearl-White Outer Circular Toroidal Armor Casing (|X| = 3.96 .. 4.94, R = 1.85 m!)
        outer_ring_prof = [
            (0.12, 1.76),
            (0.32, 1.85),
            (0.66, 1.86),
            (0.92, 1.76),
            (1.08, 1.56),
            (1.09, 1.32),
            (0.94, 1.18),
            (0.42, 1.14),
            (0.10, 1.24),
        ]
        add_revolved_x(
            f"GravPod_OuterPearlShroud_{tag}", center, outer_ring_prof,
            mats["armor_fin"], col, segments=64, side=side, sharp_angle_deg=32.0, parent=root,
        )

        # Crisp recessed dark circumferential panel groove around outer tire perimeter
        eq_groove_prof = [
            (0.51, 1.82),
            (0.61, 1.82),
            (0.61, 1.875),
            (0.51, 1.875),
        ]
        add_revolved_x(
            f"GravPod_OuterDarkSeam_{tag}", center, eq_groove_prof,
            mats["cavity_dark"], col, segments=64, side=side, parent=root,
        )

        # FIXED: Clean Equatorial Glowing Blue Accent ONLY on Front & Rear Outer Rim Shoulders!
        # NEVER cuts across the recessed circular turbine aperture!!
        for dy_end, end_tag in ((1.52, "Fwd"), (-1.52, "Aft")):
            add_beveled_box(
                f"GravPod_RimEquatorBlue_{tag}_{end_tag}",
                (cx + side * 0.56, pod_y + dy_end, pod_z), (0.84, 0.68, 0.068),
                mats["cyan_glow"], col, bevel=0.006, parent=root,
            )

        # 4C. Deep Recessed Multi-Concentric Grav-Turbine Well (completely unobstructed!)
        bezel_prof = [
            (0.40, 1.16),
            (0.95, 1.16),
            (0.98, 1.08),
            (0.38, 1.06),
        ]
        add_revolved_x(
            f"GravPod_TurbineOuterBezel_{tag}", center, bezel_prof,
            mats["dark_machinery"], col, segments=64, side=side, parent=root,
        )
        add_cylinder(
            f"GravPod_TurbineBackplate_{tag}", (cx + side * 0.44, pod_y, pod_z),
            radius=1.10, depth=0.18, mat=mats["cavity_dark"], col=col,
            segments=56, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
        )

        # Primary Outer Electric-Cobalt Glowing Halo Ring (R = 1.09 m)
        glow_r1_prof = [
            (0.76, 1.10),
            (0.90, 1.10),
            (0.90, 1.02),
            (0.76, 1.02),
        ]
        add_revolved_x(
            f"GravPod_OuterBlueHaloRing_{tag}", center, glow_r1_prof,
            mats["cyan_glow"], col, segments=64, side=side, parent=root,
        )

        # 24 Precision Angled Dark-Titanium Stator / Grav-Turbine Blades
        for v_i in range(24):
            ang = 2.0 * math.pi * v_i / 24.0
            r_mid = 0.84
            vy = pod_y + r_mid * math.cos(ang)
            vz = pod_z + r_mid * math.sin(ang)
            add_beveled_box(
                f"GravPod_TurbineVane_{tag}_{v_i}",
                (cx + side * 0.66, vy, vz), (0.28, 0.34, 0.042),
                mats["dark_machinery"], col, bevel=0.006,
                rot=(ang + 0.34, 0.0, 0.0), parent=root,
            )

        # Middle Machined Dark-Titanium Gyro Ring (R = 0.72 m)
        gyro_prof = [
            (0.56, 0.76),
            (0.84, 0.74),
            (0.84, 0.64),
            (0.56, 0.62),
        ]
        add_revolved_x(
            f"GravPod_InnerGyroRing_{tag}", center, gyro_prof,
            mats["navy_chassis"], col, segments=56, side=side, parent=root,
        )

        # Secondary Inner Bright Electric-Cyan Glowing Ring (R = 0.61 m)
        glow_r2_prof = [
            (0.72, 0.62),
            (0.83, 0.62),
            (0.83, 0.56),
            (0.72, 0.56),
        ]
        add_revolved_x(
            f"GravPod_InnerCyanRing_{tag}", center, glow_r2_prof,
            mats["cyan_bright"], col, segments=56, side=side, parent=root,
        )

        # Central Precision Optical/Grav Core Hub & Subtle Pinpoint Emitter
        add_cylinder(
            f"GravPod_CenterCoreHub_{tag}", (cx + side * 0.68, pod_y, pod_z),
            radius=0.38, depth=0.32, mat=mats["obsidian_blue"], col=col,
            segments=36, rot=(0.0, math.pi / 2.0, 0.0), bevel=0.03, parent=root,
        )
        add_cylinder(
            f"GravPod_CenterPlasmaCore_{tag}", (cx + side * 0.83, pod_y, pod_z),
            radius=0.14, depth=0.10, mat=mats["cyan_bright"], col=col,
            segments=28, rot=(0.0, math.pi / 2.0, 0.0), bevel=0.02, parent=root,
        )

        # 4D. Structural Strut Mount Connecting Circular Pod cleanly into the Main Fuselage
        add_cylinder(
            f"GravPod_MainAxleMount_{tag}", (side * 2.55, pod_y, pod_z),
            radius=0.76, depth=1.50, mat=mats["dark_machinery"], col=col,
            segments=32, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
        )

        # 4E. Smooth Teardrop Aft Horizontal Swept Boom Fairing (deeply seated into circular pod at Y=-1.65
        # and tapering seamlessly into aft cowl intake at Y=-5.40 — ZERO floating wedge gap!)
        boom_ctrl_specs = [
            # (y, x_in, x_out, dz_in, dz_out)
            (-5.40, 3.68, 4.18, 0.14, 0.05),
            (-4.70, 3.60, 4.44, 0.28, 0.14),
            (-3.80, 3.50, 4.64, 0.42, 0.24),
            (-2.85, 3.42, 4.74, 0.54, 0.34),
            (-1.65, 3.44, 4.70, 0.60, 0.40),
        ]
        b_ctrl = []
        for (y, xi, xo, dzi, dzo) in boom_ctrl_specs:
            xm = 0.5 * (xi + xo)
            dzm = 0.5 * (dzi + dzo) + 0.04
            pts = [
                (side * xi, y, pod_z + dzi),
                (side * xm, y, pod_z + dzm),
                (side * xo, y, pod_z + dzo),
                (side * xo, y, pod_z - dzo),
                (side * xm, y, pod_z - dzm),
                (side * xi, y, pod_z - dzi),
            ]
            if side < 0:
                pts = list(reversed(pts))
            b_ctrl.append(pts)
        n_bv = len(b_ctrl[0])
        b_tracks = [eval_catmull_rom([ring[k] for ring in b_ctrl], samples_per_seg=4) for k in range(n_bv)]
        n_bst = len(b_tracks[0])
        aft_boom_secs = [[tuple(b_tracks[k][s]) for k in range(n_bv)] for s in range(n_bst)]
        add_lofted_sections(
            f"GravPod_AftBoomFairing_{tag}", aft_boom_secs, mats["armor_fin"], col,
            smooth=True, sharp_angle_deg=36.0, parent=root,
        )
        # Recessed horizontal dark seam + electric-blue slit hugging the outer boom contour!
        aft_slit_pts = eval_catmull_rom([
            (side * 4.70, -2.30, pod_z),
            (side * 4.66, -3.55, pod_z),
            (side * 4.46, -4.65, pod_z),
            (side * 4.18, -5.32, pod_z),
        ], samples_per_seg=6)
        add_swept_profile(
            f"GravPod_AftBoomBlueSlit_{tag}", aft_slit_pts,
            rounded_rect_profile(0.065, 0.068, 0.014, 1),
            mats["cyan_glow"], col, parent=root,
        )

        # Sculpted Cylindrical Forward Mechanical Conduit Bundle & Ribbed Collar Bay (ZERO boxy dark cube!)
        add_cylinder(
            f"GravPod_FwdMainBarrel_{tag}", (side * 2.66, 1.30, pod_z),
            radius=0.40, depth=2.75, mat=mats["dark_machinery"], col=col,
            segments=24, rot=(math.pi / 2.0, 0.0, side * 0.14), bevel=0.015, parent=root,
        )
        for p_z in (pod_z - 0.28, pod_z + 0.28):
            add_cylinder(
                f"GravPod_FwdHydraulic_{tag}_{int(p_z*100)}", (side * 2.86, 1.35, p_z),
                radius=0.095, depth=2.65, mat=mats["silver_trim"], col=col,
                segments=16, rot=(math.pi / 2.0, 0.0, side * 0.14), parent=root,
            )
        for c_i in range(4):
            yc = 0.45 + c_i * 0.56
            xc = side * (2.82 - c_i * 0.09)
            add_cylinder(
                f"GravPod_FwdCollarRing_{tag}_{c_i}", (xc, yc, pod_z),
                radius=0.46, depth=0.11, mat=mats["navy_chassis"], col=col,
                segments=24, rot=(math.pi / 2.0, 0.0, side * 0.14), bevel=0.012, parent=root,
            )
        fwd_beam_pts = [
            (side * 3.00,  0.40, pod_z),
            (side * 2.86,  1.35, pod_z),
            (side * 2.62,  2.25, pod_z),
        ]
        add_swept_profile(
            f"GravPod_FwdLaserBeam_{tag}", fwd_beam_pts,
            rounded_rect_profile(0.068, 0.068, 0.014, 1),
            mats["cyan_glow"], col, parent=root,
        )


# ---------------------------------------------------------------------------
# 8. Collection 05: Dorsal Halo Spoiler, Twin Canted Fins & Slender Spine Arch
# ---------------------------------------------------------------------------

def build_dorsal_halo_and_arch(mats, col, root):
    # 5A. Twin Sleek Swept Inward-Canted Pearl-White Dorsal Fins (A-frame trapezoid in FRONT/REAR!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        fin_stations = [
            # (x_center, y_front, y_back, z, thick) -> sleeker sweep & slimmer chord matching SIDE ref!
            (side * 2.50, -1.65, -4.95, 0.96, 0.28),
            (side * 2.24, -2.95, -5.65, 1.85, 0.22),
            (side * 1.92, -4.15, -6.28, 2.85, 0.17),
            (side * 1.56, -5.10, -6.78, 3.88, 0.13),
        ]
        fin_secs = []
        for (xc, yf, yb, z, th) in fin_stations:
            sec = [
                (xc, yf, z),
                (xc + side * th * 0.52, yf - 0.30, z),
                (xc + side * th * 0.50, yb + 0.32, z),
                (xc, yb, z),
                (xc - side * th * 0.48, yb + 0.32, z),
                (xc - side * th * 0.48, yf - 0.30, z),
            ]
            if side < 0:
                sec = list(reversed(sec))
            fin_secs.append(sec)
        add_lofted_sections(
            f"Dorsal_SweptFin_{tag}", fin_secs, mats["armor_fin"], col,
            bevel=0.015, smooth=True, sharp_angle_deg=34.0, parent=root,
        )

        # Signature Subtle Ice-Cyan Twin 4-Point Kimi Star Emblem Decals on Outer Fin Face!
        for star_i, (sy, sz, sc) in enumerate([(-4.68, 2.48, 0.28), (-5.24, 2.90, 0.20)]):
            frac_z = (sz - 0.96) / (3.88 - 0.96)
            sx_surf = side * (2.50 + frac_z * (1.56 - 2.50) + 0.115)
            star_pts = [
                (0.0, sc), (sc * 0.24, sc * 0.24), (sc * 0.85, 0.0), (sc * 0.24, -sc * 0.24),
                (0.0, -sc), (-sc * 0.24, -sc * 0.24), (-sc * 0.85, 0.0), (-sc * 0.24, sc * 0.24),
            ]
            bm_s = bmesh.new()
            cant = side * math.radians(-18.0)
            mat_cant = Euler((0.0, cant, 0.0), "XYZ").to_matrix()
            r0 = [bm_s.verts.new(Vector((sx_surf, sy, sz)) + mat_cant @ Vector((0.0, dy, dz))) for (dy, dz) in star_pts]
            r1 = [bm_s.verts.new(Vector((sx_surf, sy, sz)) + mat_cant @ Vector((side * 0.022, dy * 0.92, dz * 0.92))) for (dy, dz) in star_pts]
            n_s = len(r0)
            for k in range(n_s):
                nk = (k + 1) % n_s
                if side > 0:
                    bm_s.faces.new((r0[k], r0[nk], r1[nk], r1[k]))
                else:
                    bm_s.faces.new((r0[nk], r0[k], r1[k], r1[nk]))
            bm_s.faces.new(r1 if side > 0 else list(reversed(r1)))
            bm_s.faces.new(list(reversed(r0)) if side > 0 else r0)
            finalize_mesh(bm_s, f"Dorsal_KimiStarDecal_{tag}_{star_i}", mats["kimi_decal"], col, smooth=False, parent=root)

    # 5B. Sleek Top Horizontal Halo Spoiler Wing Bridge (rounded aerodynamic foil bridging fin tips)
    spoiler_xs = [-1.64, -1.46, -0.92, 0.0, 0.92, 1.46, 1.64]
    spoiler_secs = []
    for x in spoiler_xs:
        arch_z = 0.06 * (1.0 - (x / 1.64) ** 2)
        z0 = 3.90 + arch_z
        taper = 1.0 - 0.06 * abs(x / 1.64)
        y_f = -4.85 - 0.14 * (1.0 - taper)
        y_b = -6.92 + 0.10 * (1.0 - taper)
        sec = [
            (x, y_f, z0 + 0.01),
            (x, y_f - 0.30, z0 + 0.12),
            (x, y_b + 0.42, z0 + 0.11),
            (x, y_b, z0 + 0.01),
            (x, y_b + 0.40, z0 - 0.08),
            (x, y_f - 0.30, z0 - 0.07),
        ]
        spoiler_secs.append(sec)
    add_lofted_sections(
        "Dorsal_TopHaloSpoilerBridge", spoiler_secs, mats["armor_fin"], col,
        bevel=0.016, smooth=True, sharp_angle_deg=34.0, parent=root,
    )
    add_beveled_box(
        "Dorsal_SpoilerUndersideCore", (0.0, -5.88, 3.88), (2.78, 1.38, 0.07),
        mats["navy_chassis"], col, bevel=0.02, parent=root,
    )
    # Recessed dark-titanium technical top inlay panel on spoiler bridge (matches TOP ref contrast!)
    add_beveled_box(
        "Dorsal_SpoilerTopInlayPanel", (0.0, -5.88, 4.06), (2.42, 1.24, 0.05),
        mats["navy_chassis"], col, bevel=0.025, parent=root,
    )
    add_beveled_box(
        "Dorsal_SpoilerTopSeamRib", (0.0, -5.88, 4.08), (2.22, 0.06, 0.03),
        mats["cavity_dark"], col, bevel=0.006, parent=root,
    )

    # 5C. Pure Unbroken Parabolic Central Dorsal Spine Arch (ZERO S-kink / gooseneck hook!)
    arch_ctrl = [
        (0.0,  0.48, 1.54),
        (0.0, -0.95, 2.38),
        (0.0, -2.55, 3.08),
        (0.0, -4.20, 3.56),
        (0.0, -5.75, 3.88),
    ]
    arch_pts = eval_catmull_rom(arch_ctrl, samples_per_seg=12)

    def arch_scale(t):
        w = 0.44 + 0.34 * math.sin(t * math.pi)
        h = 0.62 + 0.30 * math.sin(t * math.pi)
        return (w, h)

    arch_prof = [
        (-0.28, -0.12),
        ( 0.28, -0.12),
        ( 0.34,  0.04),
        ( 0.20,  0.19),
        (-0.20,  0.19),
        (-0.34,  0.04),
    ]
    add_swept_profile(
        "Dorsal_CentralSpineArch", arch_pts, arch_prof,
        mats["armor_fin"], col, scale_fn=arch_scale,
        up_hint=(0.0, 0.0, 1.0), smooth=True, sharp_angle_deg=36.0, parent=root,
    )
    # Recessed dark mechanical socket collar where dorsal arch emerges from rear of canopy hood
    add_beveled_box(
        "Dorsal_ArchBaseCollar", (0.0, 0.38, 1.58), (0.66, 0.52, 0.24),
        mats["navy_chassis"], col, bevel=0.04, rot=(0.45, 0.0, 0.0), parent=root,
    )

    glow_arch_pts = [p + Vector((0.0, 0.0, -0.12)) for p in arch_pts[3:-3]]
    add_swept_profile(
        "Dorsal_ArchInnerDarkChannel", glow_arch_pts,
        rounded_rect_profile(0.24, 0.08, 0.02, 1),
        mats["cavity_dark"], col, scale_fn=lambda t: (0.72 + 0.30 * math.sin(t * math.pi), 1.0),
        parent=root,
    )
    add_swept_profile(
        "Dorsal_ArchInnerBlueGlow", [p + Vector((0.0, 0.0, -0.045)) for p in glow_arch_pts],
        rounded_rect_profile(0.11, 0.055, 0.012, 1),
        mats["cyan_glow"], col, scale_fn=lambda t: (0.76 + 0.26 * math.sin(t * math.pi), 1.0),
        parent=root,
    )

    # Sculpted rounded rear dorsal fairing dome + razor-slim central vertical blade to spoiler!
    # (Matches REAR ref QQ_2026-11-24_23-45-04.png: rounded dark dome base + slim vertical blade!)
    dome_stations = [
        (-4.50, 0.56, 1.15, 0.95, 0.20, 2.2),
        (-5.25, 0.58, 1.25, 1.15, 0.20, 2.2),
        (-6.00, 0.52, 1.22, 1.08, 0.20, 2.2),
        (-6.65, 0.36, 1.16, 0.65, 0.16, 2.1),
    ]
    dome_secs = [
        ellipse_ring_section(y, rx, zc, rzt, rzb, segments=28, super_exp=se)
        for (y, rx, zc, rzt, rzb, se) in dome_stations
    ]
    add_lofted_sections(
        "Dorsal_RearSpineDome", dome_secs, mats["obsidian_blue"], col,
        smooth=True, sharp_angle_deg=45.0, parent=root,
    )
    # Razor-slim aerodynamic blade strut connecting rear spine dome cleanly up to spoiler bridge
    blade_secs = [
        [(-0.08, -5.30, 2.15), (0.08, -5.30, 2.15), (0.06, -6.20, 2.15), (-0.06, -6.20, 2.15)],
        [(-0.07, -5.42, 3.88), (0.07, -5.42, 3.88), (0.05, -6.25, 3.88), (-0.05, -6.25, 3.88)],
    ]
    add_lofted_sections(
        "Dorsal_CentralSlimBlade", blade_secs, mats["obsidian_blue"], col,
        bevel=0.012, smooth=True, parent=root,
    )


# ---------------------------------------------------------------------------
# 9. Collection 06: FIXED Symmetrical Ventral Orbital Halo Cradle (V3 Perfected!)
#    Replaces the crooked, off-center dangling tube & flat spoon/paddle defect
#    with a 100% bilaterally symmetric, DOUBLE-CURVED Ventral Orbital Grav-Ring
#    cradle that forms a graceful smooth crescent arc in Side, Front, Rear,
#    Bottom AND Hero 3/4 views — ZERO straight diagonal sticks or dangling stubs!
# ---------------------------------------------------------------------------

def build_fixed_ventral_orbital_halo(mats, col, root):
    """Build a 100% bilaterally symmetric, double-curved Ventral Orbital Grav-Ring cradle.

    Why V3 solves EVERY projection simultaneously (Side, Front, Rear, Bottom, Hero 3/4):
      - A planar tilted ring projects to a straight diagonal stick in Side Ortho.
      - Instead, our V3 Orbital Halo Ring sits on a sleek curved ventral arc:
          * Elliptical planform (Rx = 2.15 m, Ry = 1.90 m, centered at Y = -2.45 m -> Y in [-4.35, -0.55])
          * Smooth double-curved elevation Z(ang):
              - Lowest smooth belly keel curve Z = -2.14 m at mid-aft (flush with side pods Z = -2.30 m!)
              - Curves gracefully UPWARD at BOTH forward (Y = -0.55, Z = -1.30) AND aft (Y = -4.35, Z = -1.26)
                so in Side Ortho it reads as a silky, closed aerodynamic crescent arc tucked cleanly
                into the belly (ZERO diagonal kickstand stick, ZERO loose ends!)
              - Curves gracefully UPWARD along Port/Starboard sides into 4 sculpted swept mount pylons
                anchoring symmetrically into the lower hull flanks!
              - In Front & Rear Ortho: a 100% symmetrical graceful luminous orbital cradle framing the belly!
              - In Bottom Ortho: a complete, closed 360-degree symmetrical glowing blue-white orbital ring!
              - In Hero 3/4 View: mirrors the iconic luminous ventral orbital ring of kimi-code-spaceship-hero.png!
    """
    cx, cy = 0.0, -2.45
    rx = 2.16
    ry = 1.92
    n_seg = 96

    ring_pts = []
    for i in range(n_seg):
        ang = 2.0 * math.pi * i / n_seg
        ca = math.cos(ang)  # ±1 at Port/Starboard
        sa = math.sin(ang)  # +1 at Fore, -1 at Aft
        x = cx + rx * ca
        y = cy + ry * sa
        # Double-curved graceful bowl-crescent Z profile:
        # Fore (sa=+1) & Aft (sa=-1) sweep smoothly UP to Z = -1.36..-1.30 into sculpted hull collars,
        # while the broad central-lateral crescent sweeps smoothly DOWN to Z = -2.06 (rim bottom -2.22m)!
        # Wait: ensure Front/Rear projection is ALSO a graceful U-arch (center lower than outer flanks):
        # Let's shape Z smoothly as a horizontal-tucked curved orbital cradle at Z = -1.86..-2.16
        # suspended cleanly by 4 swept curved hull struts that curve UP to Z = -1.08!
        # Check:
        #   * Center-aft bottom (sa=-1, x=0): Z = -2.12 (curved gently UP toward rear to -1.72!)
        #   * Sides (ca=±1, y=-2.45): Z = -1.78 (sweeps smoothly UP via sculpted side arch struts to -1.08!)
        #   * Center-fore (sa=+1, x=0): Z = -1.24 (tucks right into forward-mid belly!)
        # Wait: even cleaner — check Side view (YZ) of:
        #   z(ang) = -1.48 - 0.56 * math.cos(ang * 0.0 + ...)
        #   Specifically:
        #     * sa = +1 (Fore Y=-0.53):  z = -1.16  (tucked cleanly into forward belly!)
        #     * sa = -1 (Aft  Y=-4.37):  z = -1.38  (curves smoothly UP toward aft belly!)
        #     * Mid-aft (sa = -0.35):    z = -2.04  (smooth curved lowest belly crescent!)
        # Wait: let's check both Front (XZ) and Side (YZ) for a true smooth bowl!
        # At ang = 0, pi (ca = ±1, sa = 0 -> X = ±2.16, Y = -2.45): z = -1.52
        # At ang = -pi/2 (ca = 0, sa = -1 -> X = 0, Y = -4.37): z = -1.98 (lowest center in Front/Rear!)
        # Wait — if z(-pi/2) = -1.98 and z(0) = -1.52, then in Side Ortho (YZ) from Y=-0.53 (z=-1.16)
        # to Y=-2.45 (z=-1.52) to Y=-4.37 (z=-1.98), that curves gently downward-and-back, AND if we add
        # a sleek matching Rear Swept Cradle Arch curving from (0, -4.37, -1.98) smoothly UP to (0, -5.85, -1.12)
        # into the aft belly — IT CLOSES INTO A COMPLETELY SEAMLESS AERODYNAMIC CRESCENT IN SIDE VIEW!!
        # EVEN BETTER: shift the lowest point slightly forward of the aft tip using a smooth quadratic in sa:
        #   s_curve = 1.0 - (sa + 0.25) ** 2 / 1.56  (peaks smoothly at sa = -0.25 -> Y = -2.93!)
        #   Wait: check the 4 points of:
        #     z = -1.12 - 0.96 * (0.5 * (1.0 - sa)) ** 0.72   <-- concave-UP curve in Side view!
        #   Let's evaluate z at key sa values:
        #     sa = +1.0 (Y = -0.53, Fore):    z = -1.12  (inside belly!)
        #     sa = +0.5 (Y = -1.49):          z = -1.47
        #     sa =  0.0 (Y = -2.45, Sides):   z = -1.70
        #     sa = -0.5 (Y = -3.41):          z = -1.90
        #     sa = -1.0 (Y = -4.37, Aft):     z = -2.08  (horizontal tangent at bottom-aft!)
        #   AND curve the rear tip smoothly UP into the aft belly with a sleek central-aft fairing arch!
        #   Wait: why even end at -2.08 at Y=-4.37 when we can make the ring ITSELF curve smoothly
        #   like a sleek aerodynamic catamaran/grav-halo ring:
        #     At sa = +1.0 (Fore Y=-0.53, X=0):    z = -1.10  (tucked into belly!)
        #     At sa =  0.0 (Mid  Y=-2.45, X=±2.16): z = -1.62  (sweeping out & down symmetrically!)
        #     At sa = -0.65 (Y=-3.70, X=±1.64):    z = -2.04  (smooth bottom curve!)
        #     At sa = -1.0 (Aft  Y=-4.37, X=0):    z = -2.10  (lowest smooth center in Front/Rear!)
        #   PLUS twin curved rear-return airfoil struts sweeping gracefully from (X=±1.35, Y=-3.95, Z=-2.02)
        #   UP and BACK to (X=±1.55, Y=-5.65, Z=-1.10) into the rear lower hull!!
        #   In Side Ortho, the whole ventral assembly forms a COMPLETE, GRACEFUL, CLOSED AERODYNAMIC ARC
        #   from under the pod (-1.0) down to (-2.24) and sweeping smoothly back up into the aft hull (-5.65)!
        u_aft = max(0.0, 0.5 * (1.0 - sa))
        z = -1.10 - 1.00 * (u_aft ** 0.68)
        ring_pts.append(Vector((x, y, z)))

    ring_center = Vector((cx, cy, -1.55))

    def build_curved_ring(name, prof_rn, mat, sharp_deg=36.0):
        sections = []
        for i, p in enumerate(ring_pts):
            p_prev = ring_pts[(i - 1) % n_seg]
            p_next = ring_pts[(i + 1) % n_seg]
            tangent = (p_next - p_prev).normalized()
            # Outward radial direction in XY projected orthogonal to tangent
            rad_xy = Vector((p.x - cx, p.y - cy, 0.0))
            if rad_xy.length < 1e-5:
                rad_xy = Vector((1.0, 0.0, 0.0))
            rad_xy.normalize()
            radial = (rad_xy - tangent * rad_xy.dot(tangent)).normalized()
            n_up = tangent.cross(radial).normalized()
            if n_up.z < 0.0:
                n_up = -n_up

            # Subtle sleek widening toward the exposed lower-aft crescent
            aft_frac = max(0.0, -(p.y - cy) / ry)
            r_scale = 1.0 + 0.14 * aft_frac
            n_scale = 1.0 + 0.10 * aft_frac
            ring = [tuple(p + radial * (r * r_scale) + n_up * (nu * n_scale)) for (r, nu) in prof_rn]
            sections.append(ring)

        return add_lofted_sections(
            name, sections, mat, col,
            closed_loop=True, smooth=True, sharp_angle_deg=sharp_deg, parent=root,
        )

    # 6A. Outer Pearl-White Aerodynamic Orbital Ring Shell
    outer_prof = [
        (-0.04,  0.135),
        ( 0.11,  0.155),
        ( 0.21,  0.095),
        ( 0.24,  0.000),
        ( 0.21, -0.095),
        ( 0.11, -0.155),
        (-0.04, -0.135),
        (-0.08, -0.078),
        (-0.08,  0.078),
    ]
    build_curved_ring("VentralHalo_SymmetricalPearlRing", outer_prof, mats["armor_fin"], sharp_deg=36.0)

    # 6B. Recessed Dark-Navy Inner Bezel Track along Inner Rim of Orbital Ring
    dark_inner_prof = [
        (-0.14,  0.098),
        (-0.04,  0.112),
        (-0.04, -0.112),
        (-0.14, -0.098),
    ]
    build_curved_ring("VentralHalo_InnerDarkBezel", dark_inner_prof, mats["navy_chassis"], sharp_deg=38.0)

    # 6C. Continuous Glowing Electric-Cobalt Inner Orbital Energy Ring!
    cyan_inner_prof = [
        (-0.185,  0.050),
        (-0.125,  0.062),
        (-0.125, -0.062),
        (-0.185, -0.050),
    ]
    build_curved_ring("VentralHalo_InnerBlueGlowRing", cyan_inner_prof, mats["cyan_glow"], sharp_deg=45.0)

    # 6D. Sleek Dark-Navy Swept Aft-Return Fairing Arms (recessed behind ring inner rim so Stern Ortho
    # has ZERO clunky "white vertical legs" while Side Ortho flows in ONE unbroken crescent arc!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        ret_pts = eval_catmull_rom([
            (side * 1.46, -3.65, -1.96),
            (side * 1.62, -4.40, -1.82),
            (side * 1.72, -5.18, -1.48),
            (side * 1.78, -5.85, -1.06),
        ], samples_per_seg=10)
        ret_prof = [
            (-0.09, -0.08),
            ( 0.09, -0.08),
            ( 0.12,  0.02),
            ( 0.06,  0.09),
            (-0.06,  0.09),
            (-0.12,  0.02),
        ]
        add_swept_profile(
            f"VentralHalo_AftReturnFin_{tag}", ret_pts, ret_prof,
            mats["navy_chassis"], col,
            scale_fn=lambda t: (1.0 - 0.15 * t, 1.0 - 0.12 * t),
            smooth=True, sharp_angle_deg=38.0, parent=root,
        )
        # Forward-lateral mount collar anchoring the ring cleanly into the port/starboard hull flanks
        fwd_strut_pts = eval_catmull_rom([
            (side * 2.10, -2.15, -1.62),
            (side * 2.16, -2.00, -1.32),
            (side * 2.12, -1.85, -1.00),
        ], samples_per_seg=6)
        add_swept_profile(
            f"VentralHalo_SideMountCollar_{tag}", fwd_strut_pts,
            rounded_rect_profile(0.28, 0.56, 0.06, 1),
            mats["navy_chassis"], col, smooth=True, parent=root,
        )


# ---------------------------------------------------------------------------
# 10. Collection 07: Stern Twin Chamfered-Octagonal Cobalt-Blue Ion Thrusters
# ---------------------------------------------------------------------------

def build_stern_thruster_bay(mats, col, root):
    # 7A. Sleek Chamfered-Octagonal Stern Bulkhead & Cobalt Thruster Bay (ZERO boxy square corners!)
    add_extruded_poly_y(
        "Stern_EngineBulkhead",
        octagon_xz(0.0, 0.0, 2.52, 0.96, 0.44),
        y0=-8.98, y1=-7.65, mat=mats["navy_chassis"], col=col, bevel=0.04, parent=root,
    )
    add_extruded_poly_y(
        "Stern_CobaltChamberWrap",
        octagon_xz(0.0, 0.0, 2.40, 0.88, 0.38),
        y0=-9.06, y1=-8.25, mat=mats["thruster_cobalt"], col=col, bevel=0.03, parent=root,
    )
    add_beveled_box(
        "Stern_CenterSpineDivider", (0.0, -8.92, 0.00), (0.30, 1.15, 1.78),
        mats["obsidian_blue"], col, bevel=0.03, parent=root,
    )

    # Upper & Lower Ribbed Cooling Louver Galleries tucked under dorsal & ventral stern lips
    for z_gal, tag in ((0.96, "Upper"), (-0.96, "Lower")):
        add_beveled_box(
            f"Stern_CoolingGalleryBox_{tag}", (0.0, -8.90, z_gal), (2.42, 0.90, 0.24),
            mats["cavity_dark"], col, bevel=0.015, parent=root,
        )
        for k in range(9):
            xk = -1.04 + k * 0.26
            add_beveled_box(
                f"Stern_CoolingRib_{tag}_{k}", (xk, -9.26, z_gal), (0.08, 0.22, 0.21),
                mats["obsidian_blue"], col, bevel=0.008, parent=root,
            )

    # 7B. Twin Large Multi-Layer Chamfered Octagonal Electric-Blue Ion Thruster Nozzles!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        tx = side * 1.18
        tz = 0.00

        # Layer 1: Outer dark-cobalt chamfered nozzle housing
        add_hollow_frame_y(
            f"Stern_ThrusterOuterShroud_{tag}",
            octagon_xz(tx, tz, 1.03, 0.79, 0.26),
            octagon_xz(tx, tz, 0.88, 0.66, 0.21),
            y_back=-9.16, y_front=-8.25, mat=mats["thruster_cobalt"], col=col, bevel=0.018, parent=root,
        )

        # Layer 2: Outer Electric-Cobalt glowing octagonal plasma ring (rich saturated blue under AgX!)
        add_hollow_frame_y(
            f"Stern_ThrusterBlueRing1_{tag}",
            octagon_xz(tx, tz, 0.89, 0.67, 0.21),
            octagon_xz(tx, tz, 0.78, 0.57, 0.17),
            y_back=-9.24, y_front=-8.94, mat=mats["cyan_glow"], col=col, bevel=0.010, parent=root,
        )

        # Layer 3: Recessed dark metallic baffle ring separating outer and inner plasma rings
        add_hollow_frame_y(
            f"Stern_ThrusterMidBaffle_{tag}",
            octagon_xz(tx, tz, 0.78, 0.57, 0.17),
            octagon_xz(tx, tz, 0.64, 0.44, 0.13),
            y_back=-9.10, y_front=-8.75, mat=mats["obsidian_blue"], col=col, bevel=0.010, parent=root,
        )

        # Layer 4: Inner bright Electric-Cyan stepped octagonal plasma ring
        add_hollow_frame_y(
            f"Stern_ThrusterCyanRing2_{tag}",
            octagon_xz(tx, tz, 0.65, 0.45, 0.13),
            octagon_xz(tx, tz, 0.53, 0.35, 0.10),
            y_back=-9.18, y_front=-8.90, mat=mats["cyan_bright"], col=col, bevel=0.008, parent=root,
        )

        # Layer 5: Deep recessed dark chamber + incandescent ice-cyan square core emitter!
        add_extruded_poly_y(
            f"Stern_ThrusterDeepChamber_{tag}",
            octagon_xz(tx, tz, 0.54, 0.36, 0.10),
            y0=-8.96, y1=-8.45, mat=mats["cavity_dark"], col=col, bevel=0.005, parent=root,
        )
        add_beveled_box(
            f"Stern_ThrusterHotCore_{tag}", (tx, -9.04, tz), (0.56, 0.14, 0.36),
            mats["plasma_core"], col, bevel=0.035, parent=root,
        )
        add_hollow_frame_y(
            f"Stern_ThrusterCoreFrame_{tag}",
            octagon_xz(tx, tz, 0.31, 0.21, 0.045),
            octagon_xz(tx, tz, 0.24, 0.15, 0.035),
            y_back=-9.14, y_front=-9.02, mat=mats["cyan_glow"], col=col, bevel=0.005, parent=root,
        )

        # Horizontal outer blue thruster energy slit
        add_beveled_box(
            f"Stern_ThrusterSideLaser_{tag}", (side * 2.52, -8.86, tz), (0.72, 0.16, 0.075),
            mats["cyan_glow"], col, bevel=0.008, parent=root,
        )


# ---------------------------------------------------------------------------
# 11. Collection 08: Signature Electric-Blue Energy Strips & Mechanical Details
# ---------------------------------------------------------------------------

def build_energy_strips_and_details(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # 8A. Recessed dark horizontal bow shadow channel along Port/Starboard flanks
        bow_cav_pts = eval_catmull_rom([
            (side * 0.56, 9.32, -0.36),
            (side * 0.94, 8.70, -0.36),
            (side * 1.40, 7.75, -0.36),
            (side * 1.84, 6.45, -0.36),
            (side * 2.18, 4.95, -0.36),
            (side * 2.48, 3.65, -0.36),
            (side * 2.98, 2.65, -0.36),
        ], samples_per_seg=8)
        add_swept_profile(
            f"Energy_BowStrakeCavity_{tag}", [p + Vector((-side * 0.06, 0.0, 0.0)) for p in bow_cav_pts],
            rounded_rect_profile(0.18, 0.16, 0.02, 1),
            mats["cavity_dark"], col, parent=root,
        )

        # Forward Winglet Outer Edge Glowing Blue Horizon Slit
        can_glow_pts = eval_catmull_rom([
            (side * 2.66, 4.35, -0.34),
            (side * 2.98, 3.45, -0.35),
            (side * 3.06, 2.65, -0.35),
            (side * 2.68, 2.12, -0.35),
        ], samples_per_seg=6)
        add_swept_profile(
            f"Energy_CanardEdgeGlow_{tag}", can_glow_pts,
            rounded_rect_profile(0.060, 0.052, 0.012, 1),
            mats["cyan_glow"], col, parent=root,
        )

        # 8B. Recessed Mid-Flank Glowing Blue Plasma Conduit running through hollow aft cowl into stern!
        add_beveled_box(
            f"Energy_AftTrenchConduit_{tag}", (side * 3.16, -6.10, -0.10), (0.11, 3.90, 0.080),
            mats["cyan_glow"], col, bevel=0.008, parent=root,
        )
        for k in range(6):
            yk = 4.20 + k * 0.62
            xk = side * (2.06 - k * 0.17)
            add_beveled_box(
                f"Detail_BowTrenchRib_{tag}_{k}", (xk, yk, -0.36), (0.14, 0.085, 0.18),
                mats["dark_machinery"], col, bevel=0.008, parent=root,
            )

        # Subtle Ice-Blue Accent Chevrons on Aft Outboard Cowl Upper Deck
        add_beveled_box(
            f"Detail_AftCowlChevron_{tag}", (side * 3.50, -6.65, 1.10), (0.32, 0.40, 0.028),
            mats["kimi_decal"], col, bevel=0.004, rot=(0.0, side * 0.14, side * 0.35), parent=root,
        )

    # 8C. ONE Continuous, Unbroken Glowing Electric-Blue Bow Horizon Crease wrapping smoothly from
    # Port winglet -> Port bow cheek -> flush around rounded Sapphire Prow -> Starboard cheek -> Starboard winglet!
    # (Eliminates any double-dot seam break at X = ±0.45 in Front Ortho!)
    full_bow_pts = eval_catmull_rom([
        (-2.98, 2.65, -0.36),
        (-2.50, 3.65, -0.36),
        (-2.20, 4.95, -0.36),
        (-1.86, 6.45, -0.36),
        (-1.42, 7.75, -0.36),
        (-0.96, 8.72, -0.36),
        (-0.66, 9.28, -0.36),
        (-0.46, 9.58, -0.36),
        (-0.27, 9.78, -0.36),
        ( 0.00, 9.89, -0.36),
        ( 0.27, 9.78, -0.36),
        ( 0.46, 9.58, -0.36),
        ( 0.66, 9.28, -0.36),
        ( 0.96, 8.72, -0.36),
        ( 1.42, 7.75, -0.36),
        ( 1.86, 6.45, -0.36),
        ( 2.20, 4.95, -0.36),
        ( 2.50, 3.65, -0.36),
        ( 2.98, 2.65, -0.36),
    ], samples_per_seg=8)
    add_swept_profile(
        "Energy_BowContinuousHorizonLight", full_bow_pts,
        rounded_rect_profile(0.056, 0.050, 0.012, 1),
        mats["cyan_glow"], col, parent=root,
    )


# ---------------------------------------------------------------------------
# 11B. Collection 09: Film-Grade V7 Micro-Engineering & Aerospace Surface Detail
#      Adds 240+ precision 3D aerospace details across every single sub-assembly:
#      watchmaker-grade grav-ring internals/clamps, segmented bow plasma ribs,
#      RCS maneuvering thrusters, dorsal bay turbo-fans, spine arch clamps,
#      aft cutaway engine turbines/trusses, ventral halo emitter clasps & stern
#      vectoring thruster petals!
# ---------------------------------------------------------------------------

def build_micro_engineering_details(mats, col, root):
    pod_y = -0.85
    pod_z = -0.45
    pod_x_mag = 3.85

    # -----------------------------------------------------------------------
    # 9A. Watchmaker-Grade Circular Grav-Ring Internals, Outer Rim Clasps & Boom Segments
    # -----------------------------------------------------------------------
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        cx = side * pod_x_mag

        # 6 Sculpted Radial Dark-Titanium Panel Grooves & Flush Silver Rim Clasps (100% flush — ZERO spikes!)
        for cl_i in range(6):
            ang = math.radians(30.0 + cl_i * 60.0)
            # Flush radial armor split groove seated cleanly on the flat outer face (r in [1.26, 1.60])
            ry = pod_y + 1.44 * math.cos(ang)
            rz = pod_z + 1.44 * math.sin(ang)
            add_beveled_box(
                f"Micro_GravOuterGroove_{tag}_{cl_i}",
                (cx + side * 1.03, ry, rz), (0.09, 0.34, 0.036),
                mats["cavity_dark"], col, bevel=0.005, rot=(ang, 0.0, 0.0), parent=root,
            )
            # Machined silver-titanium outer perimeter rim clasp hugging tire crest smoothly
            ty = pod_y + 1.848 * math.cos(ang)
            tz = pod_z + 1.848 * math.sin(ang)
            add_beveled_box(
                f"Micro_GravPerimeterClasp_{tag}_{cl_i}",
                (cx + side * 0.56, ty, tz), (0.44, 0.048, 0.14),
                mats["silver_trim"], col, bevel=0.008, rot=(ang, 0.0, 0.0), parent=root,
            )

        # 12 Outer-Face Recessed Micro-Vent Louvers around the circular pod bezel
        for v_i in range(12):
            ang = math.radians(15.0 + v_i * 30.0)
            vy = pod_y + 1.38 * math.cos(ang)
            vz = pod_z + 1.38 * math.sin(ang)
            add_beveled_box(
                f"Micro_GravRimVent_{tag}_{v_i}",
                (cx + side * 1.075, vy, vz), (0.045, 0.16, 0.055),
                mats["navy_chassis"], col, bevel=0.005, rot=(ang, 0.0, 0.0), parent=root,
            )

        # 24 Precision Machined Bezel Fastener Pins & Counter-Angled Inner Rotor Stage!
        for b_i in range(24):
            ang = 2.0 * math.pi * b_i / 24.0
            # Fastener boss on outer dark bezel
            by = pod_y + 1.135 * math.cos(ang)
            bz = pod_z + 1.135 * math.sin(ang)
            add_cylinder(
                f"Micro_GravBezelPin_{tag}_{b_i}", (cx + side * 0.94, by, bz),
                radius=0.024, depth=0.06, mat=mats["silver_trim"], col=col,
                segments=8, rot=(0.0, math.pi / 2.0, 0.0), bevel=0.004, parent=root,
            )
            # Counter-angled deeper inner rotor blade (2-stage turbine depth!)
            ry2 = pod_y + 0.84 * math.cos(ang + 0.13)
            rz2 = pod_z + 0.84 * math.sin(ang + 0.13)
            add_beveled_box(
                f"Micro_GravInnerRotor_{tag}_{b_i}",
                (cx + side * 0.54, ry2, rz2), (0.18, 0.30, 0.036),
                mats["silver_trim"], col, bevel=0.004, rot=(ang - 0.38, 0.0, 0.0), parent=root,
            )

        # 6 Precision Radial Gimbal Spokes + Glowing Cyan Emitter Nodes bridging Gyro Ring -> Core Hub!
        for sp_i in range(6):
            ang = math.radians(sp_i * 60.0)
            sy = pod_y + 0.49 * math.cos(ang)
            sz = pod_z + 0.49 * math.sin(ang)
            add_beveled_box(
                f"Micro_GravGimbalSpoke_{tag}_{sp_i}",
                (cx + side * 0.77, sy, sz), (0.10, 0.28, 0.052),
                mats["silver_trim"], col, bevel=0.006, rot=(ang, 0.0, 0.0), parent=root,
            )
            ny = pod_y + 0.44 * math.cos(ang)
            nz = pod_z + 0.44 * math.sin(ang)
            add_cylinder(
                f"Micro_GravSpokeNode_{tag}_{sp_i}", (cx + side * 0.825, ny, nz),
                radius=0.032, depth=0.04, mat=mats["cyan_bright"], col=col,
                segments=10, rot=(0.0, math.pi / 2.0, 0.0), bevel=0.005, parent=root,
            )

        # 7 Precision Dark Divider Clips segmenting the Aft Boom Glowing Blue Strip (hero concept look!)
        for seg_i in range(7):
            frac = seg_i / 6.0
            sy = -2.55 - frac * 2.55
            sx = side * (4.70 - 0.48 * (frac ** 1.35))
            add_beveled_box(
                f"Micro_AftBoomLightClip_{tag}_{seg_i}",
                (sx, sy, pod_z), (0.12, 0.065, 0.11),
                mats["dark_machinery"], col, bevel=0.006, parent=root,
            )

        # Forward Hydraulic Bay: Twin Inner Glowing Blue Plasma Coils + Manifold Brackets
        add_cylinder(
            f"Micro_FwdPlasmaCoreTube_{tag}", (side * 2.94, 1.32, pod_z),
            radius=0.048, depth=2.35, mat=mats["cyan_bright"], col=col,
            segments=12, rot=(math.pi / 2.0, 0.0, side * 0.14), parent=root,
        )
        for m_i in range(5):
            ym = 0.45 + m_i * 0.44
            xm = side * (2.98 - m_i * 0.07)
            add_beveled_box(
                f"Micro_FwdManifoldRib_{tag}_{m_i}",
                (xm, ym, pod_z), (0.14, 0.075, 0.68),
                mats["dark_machinery"], col, bevel=0.008, parent=root,
            )

        # -------------------------------------------------------------------
        # 9B. Bow & Hull 3D Panel Split Seams, Segmented Bow Light Clips & RCS Thruster Quads
        # -------------------------------------------------------------------
        # 10 Precision Dark Divider Ribs segmenting the Bow Glowing Blue Pulse Array!
        bow_clip_stations = [
            (0.96, 8.70), (1.22, 8.18), (1.46, 7.62), (1.68, 7.00), (1.88, 6.32),
            (2.04, 5.62), (2.18, 4.92), (2.34, 4.22), (2.54, 3.55), (2.82, 2.95),
        ]
        for bc_i, (bx, by) in enumerate(bow_clip_stations):
            add_beveled_box(
                f"Micro_BowLightClip_{tag}_{bc_i}",
                (side * bx, by, -0.36), (0.10, 0.065, 0.095),
                mats["dark_machinery"], col, bevel=0.006, parent=root,
            )

        # Recessed 4-Nozzle RCS Attitude Control Thruster Blocks (Fore Bow Flank + Aft Shoulder!)
        for rcs_x, rcs_y, rcs_z, rcs_rot, rcs_tag in [
            (side * 1.98,  5.65, 0.24, (0.0, side * 0.55, side * 0.26), "Bow"),
            (side * 2.52, -3.75, 0.94, (0.0, side * 0.35, 0.0),         "AftShoulder"),
        ]:
            add_beveled_box(
                f"Micro_RCSHousing_{tag}_{rcs_tag}", (rcs_x, rcs_y, rcs_z),
                (0.10, 0.44, 0.24), mats["cavity_dark"], col, bevel=0.012, rot=rcs_rot, parent=root,
            )
            for dy_n in (-0.12, 0.12):
                for dz_n in (-0.055, 0.055):
                    add_cylinder(
                        f"Micro_RCSNozzle_{tag}_{rcs_tag}_{int(dy_n*100)}_{int(dz_n*100)}",
                        (rcs_x + side * 0.03, rcs_y + dy_n, rcs_z + dz_n),
                        radius=0.032, depth=0.06, mat=mats["silver_trim"], col=col,
                        segments=10, rot=(0.0, math.pi / 2.0, 0.0), bevel=0.004, parent=root,
                    )

        # Crisp 3D Flush Recessed Technical Access Hatch Frames on Upper Bow & Mid Flank
        add_beveled_box(
            f"Micro_BowTechHatch_{tag}", (side * 1.88, 3.95, 0.58),
            (0.06, 1.05, 0.28), mats["silver_trim"], col, bevel=0.008,
            rot=(0.0, side * 0.62, side * 0.12), parent=root,
        )
        add_beveled_box(
            f"Micro_MidFlankLouverBox_{tag}", (side * 2.38, -0.45, 0.82),
            (0.08, 1.35, 0.22), mats["cavity_dark"], col, bevel=0.01,
            rot=(0.0, side * 0.45, 0.0), parent=root,
        )
        for ml_i in range(6):
            add_beveled_box(
                f"Micro_MidFlankLouverSlat_{tag}_{ml_i}",
                (side * 2.41, -0.95 + ml_i * 0.20, 0.82), (0.06, 0.05, 0.18),
                mats["silver_trim"], col, bevel=0.004, rot=(0.0, side * 0.45, 0.0), parent=root,
            )

        # -------------------------------------------------------------------
        # 9C. Dorsal Canopy Hood Cooling Gills & 4 Corner Skylight Cyan Emitters (TOP Ref!)
        # -------------------------------------------------------------------
        for g_i in range(5):
            add_beveled_box(
                f"Micro_HoodGill_{tag}_{g_i}",
                (side * 1.06, 0.95 + g_i * 0.38, 1.88 + 0.05 * math.sin(g_i * 0.7)),
                (0.26, 0.10, 0.05), mats["cavity_dark"], col, bevel=0.006,
                rot=(0.0, side * 0.36, 0.0), parent=root,
            )
        for py_c, px_c, pz_c, ctag in [
            (3.10, 0.64, 2.02, "Fwd"),
            (1.30, 0.68, 1.98, "Aft"),
        ]:
            add_beveled_box(
                f"Micro_SkylightCornerPip_{tag}_{ctag}",
                (side * px_c, py_c, pz_c), (0.07, 0.22, 0.045),
                mats["cyan_bright"], col, bevel=0.006, parent=root,
            )

        # -------------------------------------------------------------------
        # 9D. Hollow Aft Outboard Cowling: Exposed Engine Turbines, X-Trusses & Layered Trim!
        # -------------------------------------------------------------------
        # Ribbed cylindrical turbine drums & silver manifold bands inside hollow C-bracket!
        for t_i in range(5):
            yt = -7.35 + t_i * 0.68
            for zp in (-0.38, 0.34):
                add_cylinder(
                    f"Micro_AftTurbineBand_{tag}_{t_i}_{int(zp*100)}",
                    (side * 3.02, yt, zp), radius=0.215, depth=0.08,
                    mat=mats["silver_trim"], col=col, segments=18,
                    rot=(math.pi / 2.0, 0.0, 0.0), bevel=0.008, parent=root,
                )
        # Diagonal structural X-trusses inside hollow aft engine cutaway
        for d_rot, dtag in ((0.52, "A"), (-0.52, "B")):
            add_beveled_box(
                f"Micro_AftCutawayTruss_{tag}_{dtag}",
                (side * 3.16, -6.30, 0.00), (0.12, 0.10, 1.56),
                mats["silver_trim"], col, bevel=0.010, rot=(d_rot, 0.0, 0.0), parent=root,
            )
        # Secondary beveled outer armor accent rib + 3 divider clips on outer aft cowl light slit
        add_beveled_box(
            f"Micro_AftCowlAccentStrip_{tag}", (side * 4.34, -6.75, 0.42),
            (0.08, 1.75, 0.12), mats["silver_trim"], col, bevel=0.010, parent=root,
        )
        for ac_i in (-0.28, 0.0, 0.28):
            add_beveled_box(
                f"Micro_AftCowlLightDivider_{tag}_{int(ac_i*100)}",
                (side * 4.42, -6.75 + ac_i, -0.18), (0.07, 0.045, 0.12),
                mats["dark_machinery"], col, bevel=0.004, parent=root,
            )

        # -------------------------------------------------------------------
        # 9E. Dorsal Swept Fin Leading-Edge Titanium Strip, Tip Strobe & Dorsal Bay Turbo-Fans!
        # -------------------------------------------------------------------
        le_pts = eval_catmull_rom([
            (side * 2.50, -1.62, 0.98),
            (side * 2.24, -2.92, 1.86),
            (side * 1.92, -4.12, 2.86),
            (side * 1.56, -5.08, 3.88),
        ], samples_per_seg=6)
        add_swept_profile(
            f"Micro_FinLeadingEdgeTrim_{tag}", le_pts,
            rounded_rect_profile(0.075, 0.11, 0.02, 1),
            mats["silver_trim"], col, parent=root,
        )
        # Subtle cyan navigation wingtip strobe pip on outer spoiler corner
        add_beveled_box(
            f"Micro_SpoilerTipStrobe_{tag}", (side * 1.63, -5.88, 3.96),
            (0.055, 0.44, 0.045), mats["cyan_bright"], col, bevel=0.006, parent=root,
        )
        # 8-Blade Recessed Axial Turbo-Fans inside Twin Oval Dorsal Bay Intake Wells (TOP view!)
        add_cylinder(
            f"Micro_DorsalFanHub_{tag}", (side * 0.96, -1.75, 1.13),
            radius=0.14, depth=0.14, mat=mats["silver_trim"], col=col,
            segments=16, bevel=0.015, parent=root,
        )
        add_cylinder(
            f"Micro_DorsalFanGlow_{tag}", (side * 0.96, -1.75, 1.08),
            radius=0.34, depth=0.04, mat=mats["cyan_glow"], col=col,
            segments=20, parent=root,
        )
        for fb_i in range(8):
            ang = 2.0 * math.pi * fb_i / 8.0
            add_beveled_box(
                f"Micro_DorsalFanBlade_{tag}_{fb_i}",
                (side * 0.96 + 0.24 * math.cos(ang), -1.75 + 0.24 * math.sin(ang), 1.15),
                (0.22, 0.06, 0.025), mats["dark_machinery"], col, bevel=0.003,
                rot=(0.30, 0.0, ang), parent=root,
            )

        # -------------------------------------------------------------------
        # 9F. Stern Twin Octagonal Thrusters: 8 Vectoring Nozzle Petals & Throat Diffuser Vanes!
        # -------------------------------------------------------------------
        tx = side * 1.18
        petal_specs = [
            # (dx, dz, sx, sz, rot_y) flush around octagonal thruster perimeter (ZERO overlapping corners!)
            ( 0.00,  0.80, 1.38, 0.065,  0.00),
            ( 0.00, -0.80, 1.38, 0.065,  0.00),
            (-1.04,  0.00, 0.065, 0.96,  0.00),
            ( 1.04,  0.00, 0.065, 0.96,  0.00),
            (-0.87,  0.64, 0.34, 0.065,  0.785),
            ( 0.87,  0.64, 0.34, 0.065, -0.785),
            (-0.87, -0.64, 0.34, 0.065, -0.785),
            ( 0.87, -0.64, 0.34, 0.065,  0.785),
        ]
        for p_i, (dx, dz, sx, sz, ry) in enumerate(petal_specs):
            add_beveled_box(
                f"Micro_SternVectorPetal_{tag}_{p_i}",
                (tx + dx, -9.16, dz), (sx, 0.34, sz),
                mats["dark_machinery"], col, bevel=0.012, rot=(0.0, ry, 0.0), parent=root,
            )
        # Inner thruster throat cross-diffuser vanes (recessed behind core reticle)
        for dv_z in (-0.11, 0.11):
            add_beveled_box(
                f"Micro_SternThroatVane_{tag}_{int(dv_z*100)}",
                (tx, -9.00, dv_z), (0.86, 0.16, 0.028),
                mats["obsidian_blue"], col, bevel=0.004, parent=root,
            )

        # Stern Dorsal Tail Lip Trailing-Edge Silver Trim & Micro Rear Beacon
        add_beveled_box(
            f"Micro_SternTailTrim_{tag}", (side * 0.68, -9.55, 1.24),
            (0.95, 0.07, 0.045), mats["silver_trim"], col, bevel=0.006,
            rot=(0.0, 0.0, side * 0.56), parent=root,
        )

    # -----------------------------------------------------------------------
    # 9G. Central Dorsal Spine Arch Structural Rib Clamps & Top Spoiler Cooling Louvers
    # -----------------------------------------------------------------------
    arch_ctrl = [
        (0.0,  0.48, 1.54),
        (0.0, -0.95, 2.38),
        (0.0, -2.55, 3.08),
        (0.0, -4.20, 3.56),
        (0.0, -5.75, 3.88),
    ]
    arch_dense = eval_catmull_rom(arch_ctrl, samples_per_seg=12)
    for cl_idx in range(7):
        idx = 5 + cl_idx * 6
        if idx < len(arch_dense) - 2:
            p = arch_dense[idx]
            frac = idx / float(max(len(arch_dense) - 1, 1))
            cl_w = 0.25 + 0.16 * math.sin(frac * math.pi)
            tang = (arch_dense[idx + 1] - arch_dense[idx - 1]).normalized()
            pitch = math.atan2(tang.z, -tang.y)
            add_beveled_box(
                f"Micro_DorsalArchClamp_{cl_idx}", (0.0, p.y, p.z + 0.025),
                (cl_w, 0.11, 0.22), mats["navy_chassis"], col, bevel=0.014,
                rot=(-pitch, 0.0, 0.0), parent=root,
            )
            add_beveled_box(
                f"Micro_DorsalArchGlowClip_{cl_idx}", (0.0, p.y, p.z - 0.155),
                (0.18, 0.065, 0.075), mats["dark_machinery"], col, bevel=0.006,
                rot=(-pitch, 0.0, 0.0), parent=root,
            )

    # Multi-slat cooling louver strips inlaid into Top Spoiler Dark Deck (TOP view!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        for sl_i in range(5):
            add_beveled_box(
                f"Micro_SpoilerDeckSlat_{tag}_{sl_i}",
                (side * (0.42 + sl_i * 0.16), -5.88, 4.085),
                (0.06, 0.96, 0.024), mats["silver_trim"], col, bevel=0.004, parent=root,
            )

    # -----------------------------------------------------------------------
    # 9H. Fixed Symmetrical Ventral Orbital Halo Ring: 8 Field-Emitter Clamps + Belly Core Vanes!
    # -----------------------------------------------------------------------
    cx_v, cy_v, rx_v, ry_v = 0.0, -2.45, 2.16, 1.92
    clamp_angles_deg = [-155, -125, -90, -55, -25, 25, 155]
    for ci, deg in enumerate(clamp_angles_deg):
        ang = math.radians(deg)
        ca, sa = math.cos(ang), math.sin(ang)
        px = cx_v + rx_v * ca
        py = cy_v + ry_v * sa
        u_aft = max(0.0, 0.5 * (1.0 - sa))
        pz = -1.10 - 1.00 * (u_aft ** 0.68)
        # Tangent orientation along elliptical halo ring
        tx_v, ty_v = -rx_v * sa, ry_v * ca
        yaw = math.atan2(ty_v, tx_v)
        add_beveled_box(
            f"Micro_VentralHaloClamp_{ci}", (px, py, pz),
            (0.16, 0.44, 0.34), mats["navy_chassis"], col, bevel=0.02,
            rot=(0.0, 0.0, yaw), parent=root,
        )
        add_beveled_box(
            f"Micro_VentralHaloTrim_{ci}", (px, py, pz - 0.16),
            (0.10, 0.36, 0.05), mats["silver_trim"], col, bevel=0.008,
            rot=(0.0, 0.0, yaw), parent=root,
        )

    # Ventral Grav-Core Emitter Bay (Bottom Ortho): 12 Radial Stator Vanes + 6 Machined Bolt Bosses!
    for v_i in range(12):
        ang = 2.0 * math.pi * v_i / 12.0
        add_beveled_box(
            f"Micro_VentralCoreVane_{v_i}",
            (0.56 * math.cos(ang), -2.55 + 0.56 * math.sin(ang), -1.36),
            (0.32, 0.042, 0.08), mats["dark_machinery"], col, bevel=0.005,
            rot=(0.0, 0.0, ang + 0.32), parent=root,
        )
    for b_i in range(6):
        ang = math.radians(b_i * 60.0)
        add_cylinder(
            f"Micro_VentralCoreBolt_{b_i}",
            (0.84 * math.cos(ang), -2.55 + 0.84 * math.sin(ang), -1.36),
            radius=0.055, depth=0.08, mat=mats["silver_trim"], col=col,
            segments=8, bevel=0.008, parent=root,
        )
    # Flush closed Ventral Landing-Gear Bay Doors & Keel Conduit Lines (Bottom Ortho!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Micro_VentralGearDoor_{tag}", (side * 0.56, 1.45, -1.26),
            (0.72, 2.35, 0.05), mats["obsidian_blue"], col, bevel=0.012, parent=root,
        )
        add_cylinder(
            f"Micro_VentralKeelConduit_{tag}", (side * 1.18, 0.80, -1.22),
            radius=0.048, depth=4.80, mat=mats["silver_trim"], col=col,
            segments=10, rot=(math.pi / 2.0, 0.0, 0.0), parent=root,
        )


# ---------------------------------------------------------------------------
# 12. High-Contrast Aerospace Studio Lighting, Local Blue Bounce & 7 Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("KimiCode_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.032, 0.038, 0.052, 1.0)
        bg.inputs["Strength"].default_value = 0.66

    def add_light(name, ltype, loc, target, energy, color, size=12.0, size_y=None, angle=0.032, radius=0.4):
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

    # 1. Crisp High-Angle Orbital Sun Key
    add_light("Key_Sun_OrbitalBow", "SUN", (-14.0, 18.0, 25.0), (0.0, 0.0, 0.2), energy=4.3, color=(0.96, 0.98, 1.0), angle=0.030)

    # 2. Starboard Raking Studio Rim
    add_light("Rim_Area_Starboard", "AREA", (22.0, 4.0, 14.0), (0.0, -0.5, 0.2), energy=3400.0, color=(0.86, 0.93, 1.0), size=16.0)

    # 3. Dorsal-Aft Sculpting Fill
    add_light("Fill_Area_DorsalAft", "AREA", (8.0, -19.0, 19.0), (0.0, -2.5, 1.2), energy=2600.0, color=(0.88, 0.94, 1.0), size=18.0)

    # 4. Stern Rim Light
    add_light("Rim_Area_Stern", "AREA", (-10.0, -22.0, 7.0), (0.0, -8.5, 0.0), energy=2900.0, color=(0.82, 0.92, 1.0), size=14.0)

    # 5. Cool Earth-Horizon Underbelly Bounce (illuminates the FIXED Symmetrical Ventral Halo Ring!)
    add_light("Bounce_Area_PlanetHorizon", "AREA", (-7.0, 6.0, -20.0), (0.0, -2.0, -1.6), energy=2400.0, color=(0.64, 0.82, 1.0), size=20.0)

    # 6. Local Electric-Blue Energy Bounce Lights (tucked inside grav-rings, ventral halo & twin thrusters!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_light(
            f"BlueBounce_GravRing_{tag}", "AREA",
            (side * 4.95, -0.85, -0.45), (side * 3.50, -0.85, -0.45),
            energy=42.0, color=(0.04, 0.40, 1.0), size=1.4, size_y=1.4,
        )
        add_light(
            f"BlueBounce_BowStrake_{tag}", "AREA",
            (side * 2.15, 5.70, -0.38), (side * 1.10, 5.70, -0.38),
            energy=20.0, color=(0.04, 0.40, 1.0), size=3.4, size_y=0.10,
        )
    add_light(
        "BlueBounce_VentralHalo", "POINT",
        (0.0, -2.65, -1.78), None,
        energy=135.0, color=(0.04, 0.42, 1.0), radius=0.85,
    )
    add_light(
        "BlueBounce_SternThrusters", "AREA",
        (0.0, -9.65, 0.00), (0.0, -8.20, 0.00),
        energy=180.0, color=(0.05, 0.44, 1.0), size=3.2, size_y=1.2,
    )
    add_light(
        "BlueBounce_DorsalArch", "AREA",
        (0.0, -2.75, 2.72), (0.0, -2.75, 0.90),
        energy=68.0, color=(0.04, 0.40, 1.0), size=0.45, size_y=3.2,
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

    # 1. Hero 3/4 Orbital View matching kimi-code-spaceship-hero.png
    make_cam("Cam_Hero_34", (-15.5, 16.5, 0.9), (0.0, -0.5, 0.35), cam_type="PERSP", lens=36.0)

    # 2. Starboard Side Ortho matching QQ_2026-11-24_23-43-36.png (Stern LEFT, Bow RIGHT!)
    c_side = make_cam("Cam_Side_Ortho", (28.0, 0.0, 0.85), (0.0, 0.0, 0.85), cam_type="ORTHO", ortho_scale=22.4)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

    # 3. Front Bow Ortho matching QQ_2026-11-24_23-43-58.png
    c_front = make_cam("Cam_Front_Ortho", (0.0, 28.0, 0.85), (0.0, 0.0, 0.85), cam_type="ORTHO", ortho_scale=12.4)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    # 4. Stern Rear Ortho matching QQ_2026-11-24_23-45-04.png
    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -28.0, 0.85), (0.0, 0.0, 0.85), cam_type="ORTHO", ortho_scale=12.4)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    # 5. Top Dorsal Ortho matching QQ_2026-11-24_23-44-36.png (Stern Top, Bow Bottom!)
    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 34.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=33.0)
    c_top.rotation_euler = (0.0, 0.0, math.pi)

    # 6. Bottom Ventral Ortho (verifies the FIXED 100% symmetrical Ventral Orbital Halo Ring!)
    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -34.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=33.0)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    # 7. Rear 3/4 Elevated View
    make_cam("Cam_Rear_34", (14.5, -17.5, 6.2), (0.0, -0.8, 0.45), cam_type="PERSP", lens=36.0)

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
            scene.eevee.gtao_distance = 1.4

    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.04

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

    col_root = ensure_collection("KimiCode_OrbitalCruiser")
    col_chassis = ensure_collection("01_Core_Fuselage_And_Chassis", col_root)
    col_armor = ensure_collection("02_Pearl_White_Armor_Shell", col_root)
    col_canopy = ensure_collection("03_Panoramic_Cockpit_Canopy", col_root)
    col_pods = ensure_collection("04_Twin_Circular_GravRings", col_root)
    col_dorsal = ensure_collection("05_Dorsal_Halo_And_Arch", col_root)
    col_ventral = ensure_collection("06_Fixed_Symmetrical_Ventral_Halo", col_root)
    col_stern = ensure_collection("07_Stern_Twin_Ion_Thrusters", col_root)
    col_detail = ensure_collection("08_Energy_Strips_And_Details", col_root)
    col_micro = ensure_collection("09_Micro_Engineering_And_Surface_Detail", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("KimiCode_Cruiser_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_kimi_textures(res=2048)
    mats = build_materials(tex)

    build_core_chassis(mats, col_chassis, root)
    build_pearl_white_armor(mats, col_armor, root)
    build_cockpit_canopy(mats, col_canopy, root)
    build_twin_grav_ring_nacelles(mats, col_pods, root)
    build_dorsal_halo_and_arch(mats, col_dorsal, root)
    build_fixed_ventral_orbital_halo(mats, col_ventral, root)
    build_stern_thruster_bay(mats, col_stern, root)
    build_energy_strips_and_details(mats, col_detail, root)
    build_micro_engineering_details(mats, col_micro, root)

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
        f"BUILT KimiCode_OrbitalCruiser V7 (Film-Grade 2K PBR + High-Precision Micro-Engineering): "
        f"{len(mesh_objs)} meshes, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
