"""Parametric hard-surface 3D model builder for the Claude Code Heavy Frigate / Dreadnought (V6 Photoreal PBR).

Built directly from the 4 orthographic reference views + hero orbital concept in
docs/design/claudecode/ with pixel-calibrated PBR textures & AgX lighting:
  - Hero 3/4:    claude-code-spaceship-hero-v2.png (weathered cool titanium-white
                 composite armor w/ panel scribing & scuffing, deep oiled charcoal-black
                 mechanical understructure, razor-thin fiery molten-amber/orange light
                 strips casting warm glow on surrounding black machinery, dramatic 3:1
                 top-to-bottom facet contrast)
  - Side Ortho:  QQ_2026-11-24_06-16-45.png (starboard profile: stern left, bow right;
                 aspect L/H = 2.985 incl. mast)
  - Stern Ortho: QQ_2026-11-24_06-17-15.png (rear profile: aspect W/H = 1.169; iconic
                 5-thruster glowing fiery-amber/peach cluster)
  - Top Ortho:   QQ_2026-11-24_06-18-02.png (dorsal planform: bow top, stern bottom;
                 aspect W/L = 0.393)
  - Bottom Ortho: QQ_1795472348201_thumb.png (ventral planform: aspect W/L = 0.393)

Generates deterministic 1024x1024 tileable aerospace PBR texture maps (Albedo, Roughness,
Bump/Normal) packed into .blend and embedded directly into .glb, with world-scale box UV
mapping on every mesh so Blender and Three.js render identically.

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-4.72, +4.72] (9.44 m max beam)
  -Y = Stern, +Y = Bow             -> Y in [-12.00, +12.00] (24.00 m total length)
  -Z = Ventral, +Z = Dorsal        -> Z in [-3.20, +4.82] (8.02 m total height w/ mast)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/claudecode"
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
# 1. Procedural 1024x1024 Weathered Aerospace PBR Texture Synthesis (NumPy)
#    Saved to disk + packed in .blend + auto-embedded in .glb!
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64, 128), weights=(0.30, 0.26, 0.18, 0.12, 0.08, 0.06)):
    """Fast deterministic seamless tileable fBM noise using periodic bilinear upsampling."""
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
        # Smoothstep
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


def _generate_panel_layout(res, seed, grid_x=8, grid_y=8, sub_prob=0.55, seam_px=3):
    """Generate authentic spacecraft hull plating with varied panel tones, recessed seams, and corner rivets."""
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    seam = np.zeros((res, res), dtype=np.float32)  # 1.0 inside recessed panel seam
    edge_wear = np.zeros((res, res), dtype=np.float32)

    # Non-uniform panel division coordinates
    xs = [0]
    ys = [0]
    step_x = res // grid_x
    step_y = res // grid_y
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * step_x + rng.integers(-step_x // 4, step_x // 4 + 1), 16, res - 16)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * step_y + rng.integers(-step_y // 4, step_y // 4 + 1), 16, res - 16)))
    xs.append(res)
    ys.append(res)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 2 and min(w, h) > 56 and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.32, 0.68))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.32, 0.68))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        # Panel tonal variation (-0.09 .. +0.09)
        t_val = float(rng.uniform(-0.085, 0.085))
        tone[y0:y1, x0:x1] = t_val

        # Crisp recessed seam along border
        sp = seam_px if depth == 0 else max(2, seam_px - 1)
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        # Subtle bright chipped metallic edge-wear halo just inside the seam
        ew = sp + 3
        if y1 - y0 > ew * 2 and x1 - x0 > ew * 2:
            edge_wear[y0 + sp:y0 + ew, x0 + sp:x1 - sp] = np.maximum(edge_wear[y0 + sp:y0 + ew, x0 + sp:x1 - sp], 0.65)
            edge_wear[y1 - ew:y1 - sp, x0 + sp:x1 - sp] = np.maximum(edge_wear[y1 - ew:y1 - sp, x0 + sp:x1 - sp], 0.65)
            edge_wear[y0 + sp:y1 - sp, x0 + sp:x0 + ew] = np.maximum(edge_wear[y0 + sp:y1 - sp, x0 + sp:x0 + ew], 0.65)
            edge_wear[y0 + sp:y1 - sp, x1 - ew:x1 - sp] = np.maximum(edge_wear[y0 + sp:y1 - sp, x1 - ew:x1 - sp], 0.65)

        # Tiny recessed technical hatches or rivet dimples in corners of larger plates
        if w > 72 and h > 72:
            pad = sp + 6
            for ry in (y0 + pad, y1 - pad - 2):
                for rx in (x0 + pad, x1 - pad - 2):
                    if 0 <= ry < res - 3 and 0 <= rx < res - 3:
                        seam[ry:ry + 3, rx:rx + 3] = 0.72

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    # Soften seam slightly for anti-aliased normal/bump transitions
    seam_blur = (
        seam * 0.50
        + np.roll(seam, 1, axis=0) * 0.125
        + np.roll(seam, -1, axis=0) * 0.125
        + np.roll(seam, 1, axis=1) * 0.125
        + np.roll(seam, -1, axis=1) * 0.125
    )
    return tone, np.clip(seam_blur, 0.0, 1.0), edge_wear


def _height_to_normal(height, strength=2.4):
    """Convert seamless 2D heightfield [0..1] to OpenGL tangent-space normal map [0..1] RGB."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    nx = -dx
    ny = -dy
    nz = np.ones_like(height)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    r = (nx * inv_len) * 0.5 + 0.5
    g = (ny * inv_len) * 0.5 + 0.5
    b = (nz * inv_len) * 0.5 + 0.5
    return np.stack([r, g, b], axis=-1)


def _write_png_rgb(filepath, rgb_float):
    """Write an exact 8-bit RGB PNG directly from a (H, W, 3) float32 array in [0..1]."""
    arr = np.ascontiguousarray(np.clip(np.round(rgb_float * 255.0), 0, 255).astype(np.uint8))
    h, w, _ = arr.shape
    # Prepend filter byte 0 to each scanline
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
    """Write deterministic RGB PNG to disk, load into Blender with exact colorspace, and pack."""
    _write_png_rgb(filepath, rgb_float)
    img = bpy.data.images.load(filepath, check_existing=False)
    img.name = name
    img.colorspace_settings.name = colorspace
    img.pack()
    return img


def generate_aerospace_textures(res=1024):
    """Synthesize two matched 1024x1024 monolithic aerospace PBR sets: weathered titanium-white & dark gunmetal."""
    # Multi-scale organic weathering, brushed metal micro-grain & subtle directional atmospheric streaking
    grime_macro = _tileable_fbm(res, seed=101, octaves=(4, 8, 16, 32), weights=(0.38, 0.30, 0.20, 0.12))
    grime_micro = _tileable_fbm(res, seed=202, octaves=(32, 64, 128, 256), weights=(0.32, 0.30, 0.22, 0.16))
    # Brushed directional titanium grain (anisotropic-feeling fine horizontal micro-scratches)
    brush_raw = _tileable_fbm(res, seed=303, octaves=(16, 32, 64, 128), weights=(0.25, 0.25, 0.25, 0.25))
    brush = (
        brush_raw
        + np.roll(brush_raw, 2, axis=1) + np.roll(brush_raw, -2, axis=1)
        + np.roll(brush_raw, 5, axis=1) + np.roll(brush_raw, -5, axis=1)
        + np.roll(brush_raw, 9, axis=1) + np.roll(brush_raw, -9, axis=1)
    ) / 7.0

    # -----------------------------------------------------------------------
    # Set A: Monolithic Weathered Aerospace Titanium-White Armor (matches hero-v2 & QQ_06-16-45!)
    # Large clean hull plates, HAIRLINE subtle seams (NOT heavy black bathroom-tile lines!),
    # rich subtle weathering patina, fine brushed grain, cool battleship titanium tint!
    # -----------------------------------------------------------------------
    tone_w, seam_w, wear_w = _generate_panel_layout(res, seed=404, grid_x=3, grid_y=3, sub_prob=0.45, seam_px=1)
    # Soften panel-to-panel tonal shift to realistic subtle aerospace paint variation (±0.026)
    tone_w_subtle = tone_w * 0.30

    # Base cool aerospace off-white titanium (renders ~#a6aab2 lit, ~#585c64 lower shaded facet!)
    base_r = np.full((res, res), 0.70, dtype=np.float32)
    base_g = np.full((res, res), 0.71, dtype=np.float32)
    base_b = np.full((res, res), 0.74, dtype=np.float32)

    # Organic weathered metallic mottling + subtle directional streaking + micro scuffing
    patina = (grime_macro - 0.5) * 0.14 + (brush - 0.5) * 0.08 + (grime_micro - 0.5) * 0.055
    # Subtle soft grime near hairline panel seams
    seam_halo = (
        np.roll(seam_w, 3, axis=0) + np.roll(seam_w, -3, axis=0)
        + np.roll(seam_w, 3, axis=1) + np.roll(seam_w, -3, axis=1)
    ) * 0.25
    soot = np.clip(seam_halo * grime_macro * 0.14, 0.0, 0.09)

    wr = base_r + tone_w_subtle - patina * 0.92 - soot + wear_w * (grime_micro * 0.03)
    wg = base_g + tone_w_subtle - patina * 0.92 - soot + wear_w * (grime_micro * 0.03)
    wb = base_b + tone_w_subtle - patina * 0.86 - soot * 0.92 + wear_w * (grime_micro * 0.03)
    # Subtle hairline panel scribe (0.28 darkening, NOT 0.78 black marker!)
    seam_dark = 1.0 - seam_w * 0.28
    white_albedo = np.stack([wr * seam_dark, wg * seam_dark, wb * seam_dark], axis=-1)

    # Tactile roughness map: satin weathered paint (0.34..0.54) with subtle metallic sheen streaks
    white_rough = np.clip(
        0.40 + (grime_macro - 0.5) * 0.22 + (brush - 0.5) * 0.14 + (grime_micro - 0.5) * 0.08 - wear_w * 0.06 + seam_w * 0.22,
        0.22,
        0.74,
    )
    white_rough_rgb = np.stack([white_rough, white_rough, white_rough], axis=-1)

    # Crisp hairline normal map + subtle brushed metal grain
    white_height = np.clip(0.75 - seam_w * 0.34 + tone_w_subtle * 0.30 + (brush - 0.5) * 0.06 + (grime_micro - 0.5) * 0.05, 0.0, 1.0)
    white_normal = _height_to_normal(white_height, strength=2.2)

    # -----------------------------------------------------------------------
    # Set B: Weathered Dark Oiled Gunmetal-Steel Mechanical Hull & Belly
    # Calibrated to read cleanly as rich dark steel (#2a2d35 .. #3e424c), NEVER crushed pure black!
    # -----------------------------------------------------------------------
    tone_d, seam_d, wear_d = _generate_panel_layout(res, seed=707, grid_x=5, grid_y=5, sub_prob=0.50, seam_px=2)
    tone_d_subtle = tone_d * 0.45
    dr = 0.265 + tone_d_subtle - (grime_macro - 0.5) * 0.09 + (brush - 0.5) * 0.05 + wear_d * (grime_micro * 0.05)
    dg = 0.275 + tone_d_subtle - (grime_macro - 0.5) * 0.09 + (brush - 0.5) * 0.05 + wear_d * (grime_micro * 0.05)
    db = 0.300 + tone_d_subtle - (grime_macro - 0.5) * 0.08 + (brush - 0.5) * 0.05 + wear_d * (grime_micro * 0.05)
    d_seam = 1.0 - seam_d * 0.44
    dark_albedo = np.stack([dr * d_seam, dg * d_seam, db * d_seam], axis=-1)

    dark_rough = np.clip(
        0.38 + (grime_macro - 0.5) * 0.22 + (brush - 0.5) * 0.14 - wear_d * 0.10 + seam_d * 0.28,
        0.20,
        0.78,
    )
    dark_rough_rgb = np.stack([dark_rough, dark_rough, dark_rough], axis=-1)

    dark_height = np.clip(0.75 - seam_d * 0.46 + tone_d_subtle * 0.35 + (brush - 0.5) * 0.07 + (grime_micro - 0.5) * 0.06, 0.0, 1.0)
    dark_normal = _height_to_normal(dark_height, strength=2.6)

    return {
        "white_albedo": _save_and_pack_image("Tex_ArmorWhite_Albedo", os.path.join(TEX_DIR, "armor_white_albedo.png"), white_albedo, "sRGB"),
        "white_rough":  _save_and_pack_image("Tex_ArmorWhite_Rough",  os.path.join(TEX_DIR, "armor_white_rough.png"),  white_rough_rgb, "Non-Color"),
        "white_normal": _save_and_pack_image("Tex_ArmorWhite_Normal", os.path.join(TEX_DIR, "armor_white_normal.png"), white_normal, "Non-Color"),
        "dark_albedo":  _save_and_pack_image("Tex_ChassisDark_Albedo", os.path.join(TEX_DIR, "chassis_dark_albedo.png"), dark_albedo, "sRGB"),
        "dark_rough":   _save_and_pack_image("Tex_ChassisDark_Rough",  os.path.join(TEX_DIR, "chassis_dark_rough.png"),  dark_rough_rgb, "Non-Color"),
        "dark_normal":  _save_and_pack_image("Tex_ChassisDark_Normal", os.path.join(TEX_DIR, "chassis_dark_normal.png"), dark_normal, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. Aerospace PBR Materials (Blender 5.3 + AgX + glTF 2.0 Embedded Textures)
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
    metallic=0.42,
    normal_strength=0.65,
    coat=0.0,
    uv_scale=1.0,
):
    """Create glTF-native textured PBR material (Image -> Principled BSDF directly, 100% GLB faithful!)."""
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
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.16)

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-780, 0)
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-560, 0)
    mapping.inputs["Scale"].default_value = (uv_scale, uv_scale, uv_scale)
    nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])

    # Direct Base Color Image -> exports cleanly as glTF baseColorTexture!
    tex_col = nt.nodes.new("ShaderNodeTexImage")
    tex_col.location = (-220, 260)
    tex_col.image = albedo_img
    nt.links.new(mapping.outputs["Vector"], tex_col.inputs["Vector"])
    nt.links.new(tex_col.outputs["Color"], bsdf.inputs["Base Color"])

    # Direct Roughness Image -> exports cleanly as glTF metallicRoughnessTexture!
    tex_rgh = nt.nodes.new("ShaderNodeTexImage")
    tex_rgh.location = (-220, -20)
    tex_rgh.image = rough_img
    nt.links.new(mapping.outputs["Vector"], tex_rgh.inputs["Vector"])
    nt.links.new(tex_rgh.outputs["Color"], bsdf.inputs["Roughness"])

    # Direct Normal Map -> exports cleanly as glTF normalTexture!
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
    roughness=0.38,
    coat=0.0,
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
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.12)
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    # Primary Weathered Aerospace Titanium-White Plating (monolithic satin composite, NOT tiled grid!)
    return {
        "armor_white": make_textured_pbr_mat(
            "Mat_ClaudeCode_ArmorTitaniumWhite",
            tex["white_albedo"],
            tex["white_rough"],
            tex["white_normal"],
            metallic=0.28,
            normal_strength=0.32,
            coat=0.04,
            uv_scale=0.62,
        ),
        # Secondary Finer-Scale Weathered Titanium-White for Dorsal Spine & Bridge Superstructure
        "armor_light": make_textured_pbr_mat(
            "Mat_ClaudeCode_ArmorTitaniumDeck",
            tex["white_albedo"],
            tex["white_rough"],
            tex["white_normal"],
            metallic=0.30,
            normal_strength=0.28,
            coat=0.05,
            uv_scale=0.82,
        ),
        # Dark Oiled Gunmetal-Steel for Mid-Recessed Bays, Chin Skirts & Turret Housings
        "armor_mid": make_textured_pbr_mat(
            "Mat_ClaudeCode_GunmetalArmor",
            tex["dark_albedo"],
            tex["dark_rough"],
            tex["dark_normal"],
            metallic=0.54,
            normal_strength=0.38,
            uv_scale=0.95,
        ),
        # Deep Weathered Carbon-Graphite Mechanical Core, Belly & Thruster Shrouds (readable dark steel!)
        "chassis_dark": make_textured_pbr_mat(
            "Mat_ClaudeCode_ChassisSteel",
            tex["dark_albedo"],
            tex["dark_rough"],
            tex["dark_normal"],
            metallic=0.58,
            normal_strength=0.42,
            uv_scale=1.10,
        ),
        # Heavy Dark Anodized Gunmetal for Ribs, Thruster Louvers, Mast & Turret Barrels
        "gunmetal": make_solid_pbr_mat(
            "Mat_ClaudeCode_DarkMachinery",
            base_color=(0.042, 0.046, 0.054),
            metallic=0.72,
            roughness=0.38,
        ),
        # Deep Pitch-Black Recess Cavities & Shadow Slots
        "cavity_black": make_solid_pbr_mat(
            "Mat_ClaudeCode_CavityBlack",
            base_color=(0.005, 0.006, 0.008),
            metallic=0.30,
            roughness=0.62,
        ),
        # Smoked Mirror-Dark Command Bridge Windows
        "bridge_glass": make_solid_pbr_mat(
            "Mat_ClaudeCode_BridgeGlass",
            base_color=(0.008, 0.010, 0.014),
            metallic=0.22,
            roughness=0.06,
            coat=0.90,
        ),
        # FIERY MOLTEN AMBER-ORANGE (AgX-calibrated: low G/B so it stays rich #E86A1A S=85%!)
        "thruster_glow": make_solid_pbr_mat(
            "Mat_ClaudeCode_ThrusterEmber",
            base_color=(1.0, 0.18, 0.01),
            metallic=0.0,
            roughness=0.22,
            emission_color=(1.0, 0.11, 0.003),
            emission_strength=3.8,
        ),
        # Fiery Incandescent Orange-Gold Thruster Inner Core (no pale beige washout!)
        "thruster_hot": make_solid_pbr_mat(
            "Mat_ClaudeCode_ThrusterCore",
            base_color=(1.0, 0.38, 0.04),
            metallic=0.0,
            roughness=0.16,
            emission_color=(1.0, 0.22, 0.012),
            emission_strength=6.0,
        ),
        # Signature Deep Molten-Amber / Fiery Orange Light Strips (hero-v2.png #C7581C -> #FA8422!)
        "amber_vent": make_solid_pbr_mat(
            "Mat_ClaudeCode_AmberEmberStrip",
            base_color=(1.0, 0.22, 0.012),
            metallic=0.0,
            roughness=0.16,
            emission_color=(1.0, 0.14, 0.003),
            emission_strength=5.4,
        ),
        # Warm Amber Interior Bridge Window Glow & Dorsal Pips
        "bridge_pip": make_solid_pbr_mat(
            "Mat_ClaudeCode_BridgeAmberPip",
            base_color=(1.0, 0.26, 0.02),
            metallic=0.0,
            roughness=0.18,
            emission_color=(1.0, 0.17, 0.006),
            emission_strength=4.6,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Hard-Surface BMesh Geometry Helpers w/ World-Scale Box UV Mapping
# ---------------------------------------------------------------------------

def apply_world_box_uv(bm, tile_meters=5.2):
    """Apply distortion-free world-space triplanar/box UVs so panel scales match across all 280+ parts."""
    uv_layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    inv = 1.0 / tile_meters
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        if az >= ax and az >= ay:
            # Dorsal / Ventral face -> project (X, Y)
            for loop in face.loops:
                co = loop.vert.co
                loop[uv_layer].uv = (co.x * inv, co.y * inv)
        elif ax >= ay and ax >= az:
            # Port / Starboard flank face -> project (Y, Z)
            for loop in face.loops:
                co = loop.vert.co
                loop[uv_layer].uv = (co.y * inv, co.z * inv)
        else:
            # Bow / Stern face -> project (X, Z)
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
    smooth=False,
    parent=None,
    uv_tile_m=5.2,
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
    name,
    center,
    size,
    mat,
    col,
    bevel=0.025,
    bevel_segments=2,
    rot=(0.0, 0.0, 0.0),
    parent=None,
):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    if bevel > 0.0:
        max_b = min(sx, sy, sz) * 0.42
        b = min(bevel, max_b)
        bmesh.ops.bevel(
            bm,
            geom=list(bm.edges),
            offset=b,
            offset_type="OFFSET",
            segments=bevel_segments,
            profile=0.5,
            affect="EDGES",
            clamp_overlap=True,
        )
    if any(abs(a) > 1e-6 for a in rot):
        mat_r = Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.transform(bm, matrix=mat_r, verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, bevel_offset=0.0, parent=parent)


def add_lofted_sections(
    name,
    sections,
    mat,
    col,
    bevel=0.03,
    bevel_segments=1,
    cap_start=True,
    cap_end=True,
    parent=None,
):
    bm = bmesh.new()
    rings = []
    for sec in sections:
        ring = [bm.verts.new(p) for p in sec]
        rings.append(ring)

    n = len(rings[0])
    for r_idx in range(len(rings) - 1):
        r0 = rings[r_idx]
        r1 = rings[r_idx + 1]
        for i in range(n):
            ni = (i + 1) % n
            bm.faces.new((r0[i], r0[ni], r1[ni], r1[i]))

    if cap_start:
        bm.faces.new(list(reversed(rings[0])))
    if cap_end:
        bm.faces.new(rings[-1])

    return finalize_mesh(
        bm,
        name,
        mat,
        col,
        bevel_offset=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )


def add_extruded_poly_z(
    name,
    pts_xy,
    z0,
    z1,
    mat,
    col,
    bevel=0.025,
    bevel_segments=2,
    taper_top=1.0,
    taper_bot=1.0,
    parent=None,
):
    cx = sum(p[0] for p in pts_xy) / len(pts_xy)
    cy = sum(p[1] for p in pts_xy) / len(pts_xy)
    ring_b = [(cx + (x - cx) * taper_bot, cy + (y - cy) * taper_bot, z0) for x, y in pts_xy]
    ring_t = [(cx + (x - cx) * taper_top, cy + (y - cy) * taper_top, z1) for x, y in pts_xy]
    return add_lofted_sections(
        name,
        [ring_b, ring_t],
        mat,
        col,
        bevel=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )


def add_extruded_poly_y(
    name,
    pts_xz,
    y0,
    y1,
    mat,
    col,
    bevel=0.02,
    bevel_segments=2,
    scale_y0=1.0,
    scale_y1=1.0,
    parent=None,
):
    cx = sum(p[0] for p in pts_xz) / len(pts_xz)
    cz = sum(p[1] for p in pts_xz) / len(pts_xz)
    ring0 = [(cx + (x - cx) * scale_y0, y0, cz + (z - cz) * scale_y0) for x, z in pts_xz]
    ring1 = [(cx + (x - cx) * scale_y1, y1, cz + (z - cz) * scale_y1) for x, z in pts_xz]
    return add_lofted_sections(
        name,
        [ring0, ring1],
        mat,
        col,
        bevel=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )


def add_hollow_shroud_y(
    name,
    outer_xz,
    inner_xz,
    y_back,
    y_front,
    mat,
    col,
    bevel=0.022,
    bevel_segments=2,
    outer_scale_back=0.96,
    outer_scale_front=1.04,
    inner_scale_back=1.03,
    inner_scale_front=0.92,
    parent=None,
):
    n = len(outer_xz)
    assert len(inner_xz) == n
    cx = sum(p[0] for p in outer_xz) / n
    cz = sum(p[1] for p in outer_xz) / n

    def scale_ring(pts, y_val, sc):
        return [(cx + (x - cx) * sc, y_val, cz + (z - cz) * sc) for x, z in pts]

    ob = scale_ring(outer_xz, y_back, outer_scale_back)
    of = scale_ring(outer_xz, y_front, outer_scale_front)
    ib = scale_ring(inner_xz, y_back, inner_scale_back)
    if_ = scale_ring(inner_xz, y_front, inner_scale_front)

    bm = bmesh.new()
    v_ob = [bm.verts.new(p) for p in ob]
    v_of = [bm.verts.new(p) for p in of]
    v_ib = [bm.verts.new(p) for p in ib]
    v_if = [bm.verts.new(p) for p in if_]

    for i in range(n):
        ni = (i + 1) % n
        bm.faces.new((v_ob[i], v_ob[ni], v_of[ni], v_of[i]))
        bm.faces.new((v_if[i], v_if[ni], v_ib[ni], v_ib[i]))
        bm.faces.new((v_ib[i], v_ib[ni], v_ob[ni], v_ob[i]))
        bm.faces.new((v_of[i], v_of[ni], v_if[ni], v_if[i]))

    return finalize_mesh(
        bm,
        name,
        mat,
        col,
        bevel_offset=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )


def add_cylinder(
    name,
    center,
    radius,
    depth,
    mat,
    col,
    segments=16,
    rot=(0.0, 0.0, 0.0),
    bevel=0.008,
    parent=None,
):
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=radius,
        radius2=radius,
        depth=depth,
    )
    if any(abs(a) > 1e-6 for a in rot):
        bmesh.ops.transform(bm, matrix=Euler(rot, "XYZ").to_matrix().to_4x4(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=1, smooth=True, parent=parent)


def oct_ring_y(y, w_mid, w_top, w_bot, z_top, z_upper, z_lower, z_bot):
    return [
        (-w_top, y, z_top),
        ( w_top, y, z_top),
        ( w_mid, y, z_upper),
        ( w_mid, y, z_lower),
        ( w_bot, y, z_bot),
        (-w_bot, y, z_bot),
        (-w_mid, y, z_lower),
        (-w_mid, y, z_upper),
    ]


def mirror_ring_x(ring):
    return [(-x, y, z) for (x, y, z) in reversed(ring)]


def build_symmetric_loft(name_base, stbd_sections, mat, col, bevel=0.03, bevel_segments=2, parent=None):
    add_lofted_sections(
        f"{name_base}_Stbd",
        stbd_sections,
        mat,
        col,
        bevel=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )
    port_sections = [mirror_ring_x(ring) for ring in stbd_sections]
    add_lofted_sections(
        f"{name_base}_Port",
        port_sections,
        mat,
        col,
        bevel=bevel,
        bevel_segments=bevel_segments,
        parent=parent,
    )


def chamfered_rect_xz(cx, cz, hw, hh, ch):
    return [
        (cx - hw + ch, cz + hh),
        (cx + hw - ch, cz + hh),
        (cx + hw,      cz + hh - ch),
        (cx + hw,      cz - hh + ch),
        (cx + hw - ch, cz - hh),
        (cx - hw + ch, cz - hh),
        (cx - hw,      cz - hh + ch),
        (cx - hw,      cz + hh - ch),
    ]


# ---------------------------------------------------------------------------
# 4. Module 1: Internal Dark Mechanical Core Chassis & Ventral Belly
# ---------------------------------------------------------------------------

def build_internal_chassis(mats, col, root):
    core_stations = [
        (-11.55,  3.56,  3.08,  2.42,  1.88,  1.26,   -1.35,   -1.76),
        (-10.10,  3.88,  3.35,  2.72,  1.96,  1.42,   -1.50,   -2.15),
        ( -7.80,  3.98,  3.42,  2.95,  2.02,  1.52,   -1.60,   -2.34),
        ( -4.20,  4.04,  3.42,  2.98,  2.06,  1.56,   -1.65,   -2.42),
        ( -1.80,  4.06,  3.20,  3.02,  1.92,  1.45,   -1.68,   -2.50),
        (  1.60,  3.68,  2.88,  2.66,  1.62,  1.22,   -1.48,   -2.22),
        (  3.10,  2.92,  2.30,  2.20,  1.34,  0.96,   -1.08,   -1.72),
        (  6.20,  2.54,  2.00,  1.88,  0.98,  0.64,   -0.96,   -1.46),
        (  9.20,  2.08,  1.62,  1.48,  0.56,  0.28,   -0.84,   -1.18),
        ( 11.15,  1.36,  1.06,  1.02,  0.32,  0.14,   -0.54,   -0.78),
        ( 11.92,  0.92,  0.72,  0.72,  0.18,  0.06,   -0.28,   -0.44),
    ]
    add_lofted_sections(
        "Chassis_MainCoreHull",
        [oct_ring_y(*st) for st in core_stations],
        mats["chassis_dark"],
        col,
        bevel=0.04,
        bevel_segments=1,
        parent=root,
    )

    keel_stations = [
        (-10.85,  2.12,  2.35,  1.52, -1.55, -1.72,   -2.18,   -2.40),
        ( -8.60,  2.42,  2.60,  1.74, -1.85, -2.05,   -2.55,   -2.84),
        ( -6.80,  2.48,  2.68,  1.64, -2.00, -2.20,   -2.88,   -3.16),
        ( -4.35,  2.45,  2.65,  1.60, -2.00, -2.20,   -2.90,   -3.18),
        ( -3.20,  2.32,  2.52,  1.56, -1.95, -2.15,   -2.62,   -2.84),
        ( -0.60,  2.22,  2.42,  1.50, -1.85, -2.05,   -2.52,   -2.74),
        (  1.65,  1.95,  2.18,  1.36, -1.65, -1.85,   -2.30,   -2.52),
        (  2.65,  1.52,  1.74,  1.04, -1.45, -1.58,   -1.84,   -2.02),
    ]
    add_lofted_sections(
        "Chassis_VentralKeelPod",
        [oct_ring_y(*st) for st in keel_stations],
        mats["chassis_dark"],
        col,
        bevel=0.04,
        bevel_segments=1,
        parent=root,
    )

    # Lower Midship Dark Oiled Steel Chin Skirts (same cohesive dark gunmetal family as belly!)
    mid_chin_stbd = [
        [
            (2.18, -3.55, -1.42),
            (3.72, -3.55, -1.42),
            (3.46, -3.55, -2.06),
            (2.74, -3.55, -2.68),
            (1.65, -3.55, -2.74),
            (1.65, -3.55, -1.42),
        ],
        [
            (2.18,  0.40, -1.42),
            (3.85,  0.40, -1.42),
            (3.52,  0.40, -2.02),
            (2.82,  0.40, -2.58),
            (1.65,  0.40, -2.64),
            (1.65,  0.40, -1.42),
        ],
        [
            (1.88,  2.12, -1.26),
            (3.36,  2.12, -1.26),
            (3.04,  2.12, -1.78),
            (2.38,  2.12, -2.24),
            (1.45,  2.12, -2.30),
            (1.45,  2.12, -1.26),
        ],
    ]
    build_symmetric_loft(
        "Chassis_MidshipChinSkirt",
        mid_chin_stbd,
        mats["chassis_dark"],
        col,
        bevel=0.035,
        bevel_segments=2,
        parent=root,
    )

    ventral_plates = [
        ("Belly_AftPodCore",     (0.0, -5.60, -3.02), (2.42, 3.60, 0.34),  0.00),
        ("Belly_AftBayFrame",    (0.0, -8.55, -2.60), (2.78, 2.35, 0.42), -0.14),
        ("Belly_MidCenterBay",   (0.0, -1.10, -2.68), (2.88, 4.35, 0.34),  0.04),
        ("Belly_MidHatchPlate",  (0.0, -0.45, -2.82), (1.72, 2.02, 0.16),  0.04),
        ("Belly_FwdWedgeBay",    (0.0,  3.15, -1.92), (2.75, 3.10, 0.38),  0.22),
        ("Belly_FwdHatchSquare", (0.0,  5.55, -1.52), (2.05, 2.15, 0.22),  0.10),
        ("Belly_BowKeelSpine",   (0.0,  8.35, -1.24), (1.68, 3.30, 0.24),  0.11),
        ("Belly_BowNoseBlock",   (0.0, 10.65, -0.78), (0.88, 1.50, 0.34),  0.22),
    ]
    for bname, bloc, bsz, brx in ventral_plates:
        add_beveled_box(
            bname,
            bloc,
            bsz,
            mats["chassis_dark"],
            col,
            bevel=0.035,
            rot=(brx, 0.0, 0.0),
            parent=root,
        )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Belly_AftRail_{tag}",
            (side * 2.16, -7.85, -2.30),
            (0.86, 5.15, 0.46),
            mats["chassis_dark"],
            col,
            bevel=0.03,
            rot=(-0.06, 0.0, 0.0),
            parent=root,
        )
        add_beveled_box(
            f"Belly_FwdStrake_{tag}",
            (side * 1.54, 5.65, -1.42),
            (0.60, 5.15, 0.24),
            mats["chassis_dark"],
            col,
            bevel=0.022,
            rot=(0.11, 0.0, side * 0.14),
            parent=root,
        )
        add_beveled_box(
            f"Bow_ChinIntakeBox_{tag}",
            (side * 0.80, 10.42, -0.82),
            (0.70, 1.05, 0.30),
            mats["gunmetal"],
            col,
            bevel=0.022,
            rot=(0.20, 0.0, side * 0.16),
            parent=root,
        )
        add_beveled_box(
            f"Bow_ChinIntakeCavity_{tag}",
            (side * 0.80, 10.48, -0.94),
            (0.52, 0.68, 0.14),
            mats["cavity_black"],
            col,
            bevel=0.01,
            rot=(0.20, 0.0, side * 0.16),
            parent=root,
        )
        # Razor-crisp fiery molten-amber forward chin glow slits (hero-v2 underside bow glow!)
        add_beveled_box(
            f"Bow_ChinGlow_{tag}",
            (side * 0.80, 10.52, -0.97),
            (0.44, 0.09, 0.045),
            mats["amber_vent"],
            col,
            bevel=0.005,
            rot=(0.20, 0.0, side * 0.16),
            parent=root,
        )
        add_beveled_box(
            f"Bow_ProwBumper_{tag}",
            (side * 0.60, 11.68, -0.14),
            (0.56, 0.64, 0.40),
            mats["gunmetal"],
            col,
            bevel=0.028,
            rot=(0.0, 0.0, side * 0.18),
            parent=root,
        )
        add_beveled_box(
            f"Bow_ProwSensorGlow_{tag}",
            (side * 0.60, 11.96, -0.10),
            (0.22, 0.05, 0.042),
            mats["amber_vent"],
            col,
            bevel=0.005,
            parent=root,
        )

    add_beveled_box(
        "Bow_ProwCenterCap",
        (0.0, 11.62, 0.06),
        (1.32, 0.78, 0.34),
        mats["armor_mid"],
        col,
        bevel=0.04,
        parent=root,
    )
    add_beveled_box(
        "Bow_ProwCenterNotch",
        (0.0, 11.88, -0.16),
        (0.44, 0.44, 0.40),
        mats["cavity_black"],
        col,
        bevel=0.02,
        parent=root,
    )


# ---------------------------------------------------------------------------
# 5. Module 2: Layered Faceted Weathered Titanium-White Armor Shell
# ---------------------------------------------------------------------------

def build_primary_white_armor(mats, col, root):
    bow_cheek_stbd = [
        [
            (1.78,  1.95,  1.92),
            (3.15,  1.95,  1.66),
            (3.64,  1.95,  0.44),
            (3.48,  1.95, -0.22),
            (2.85,  1.95, -0.26),
            (1.78,  1.95,  1.15),
        ],
        [
            (1.38,  4.40,  1.60),
            (2.78,  4.40,  1.36),
            (3.34,  4.40,  0.34),
            (3.16,  4.40, -0.26),
            (2.58,  4.40, -0.30),
            (1.38,  4.40,  0.88),
        ],
        [
            (1.08,  6.15,  1.36),
            (2.48,  6.15,  1.14),
            (3.06,  6.15,  0.26),
            (2.88,  6.15, -0.30),
            (2.34,  6.15, -0.34),
            (1.08,  6.15,  0.66),
        ],
        [
            (1.04,  7.10,  1.22),
            (2.34,  7.10,  1.00),
            (2.90,  7.10,  0.20),
            (2.68,  7.10, -0.96),
            (2.00,  7.10, -1.04),
            (1.04,  7.10,  0.44),
        ],
        [
            (1.16,  9.45,  0.84),
            (1.98,  9.45,  0.68),
            (2.46,  9.45,  0.08),
            (2.26,  9.45, -0.78),
            (1.62,  9.45, -0.84),
            (1.16,  9.45,  0.14),
        ],
        [
            (0.92, 10.95,  0.54),
            (1.56, 10.95,  0.44),
            (1.98, 10.95,  0.04),
            (1.76, 10.95, -0.52),
            (1.22, 10.95, -0.56),
            (0.92, 10.95, -0.06),
        ],
        [
            (0.68, 11.78,  0.28),
            (1.10, 11.78,  0.22),
            (1.36, 11.78,  0.02),
            (1.22, 11.78, -0.18),
            (0.84, 11.78, -0.20),
            (0.68, 11.78, -0.04),
        ],
    ]
    build_symmetric_loft(
        "Armor_BowCheekWing",
        bow_cheek_stbd,
        mats["armor_white"],
        col,
        bevel=0.042,
        bevel_segments=2,
        parent=root,
    )

    # Recessed Bow Side Sensor/Thruster Pockets flush along cheeks w/ fine row of fiery amber micro-dots!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        yaw = side * 0.298
        add_beveled_box(
            f"Bow_NosePocketFrame_{tag}",
            (side * 2.01, 10.22, -0.24),
            (0.22, 1.92, 0.30),
            mats["gunmetal"],
            col,
            bevel=0.016,
            rot=(0.08, 0.0, yaw),
            parent=root,
        )
        add_beveled_box(
            f"Bow_NosePocketCavity_{tag}",
            (side * 2.08, 10.22, -0.24),
            (0.16, 1.66, 0.17),
            mats["cavity_black"],
            col,
            bevel=0.01,
            rot=(0.08, 0.0, yaw),
            parent=root,
        )
        for k in range(7):
            yk = 9.52 + k * 0.23
            xk = side * (2.31 - (yk - 9.45) * 0.307)
            zk = -0.27 + k * 0.015
            add_beveled_box(
                f"Bow_NoseSensorPip_{tag}_{k}",
                (xk, yk, zk),
                (0.035, 0.07, 0.028),
                mats["amber_vent"],
                col,
                bevel=0.003,
                rot=(0.08, 0.0, yaw),
                parent=root,
            )

    foredeck_sections = [
        ( 6.80, 1.56, 1.68, 1.24, 0.72),
        ( 7.60, 1.46, 1.58, 1.12, 0.64),
        (10.35, 1.24, 1.34, 0.68, 0.28),
        (11.48, 0.96, 1.08, 0.42, 0.10),
    ]
    fd_rings = [
        [(-wt, y, zt), (wt, y, zt), (wb, y, zb), (-wb, y, zb)]
        for (y, wt, wb, zt, zb) in foredeck_sections
    ]
    add_lofted_sections(
        "Armor_BowForedeckCenter",
        fd_rings,
        mats["armor_light"],
        col,
        bevel=0.03,
        bevel_segments=2,
        parent=root,
    )

    add_lofted_sections(
        "Armor_BowIntakeDividerSpine",
        [
            [(-0.48,  7.42, 1.20), (0.48,  7.42, 1.20), (0.52,  7.42, 0.88), (-0.52,  7.42, 0.88)],
            [(-0.44, 10.55, 0.72), (0.44, 10.55, 0.72), (0.48, 10.55, 0.42), (-0.48, 10.55, 0.42)],
        ],
        mats["armor_white"],
        col,
        bevel=0.025,
        bevel_segments=2,
        parent=root,
    )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bow_DorsalIntakeFrame_{tag}",
            (side * 0.88, 8.95, 0.94),
            (0.68, 2.75, 0.28),
            mats["gunmetal"],
            col,
            bevel=0.02,
            rot=(-0.155, 0.0, 0.0),
            parent=root,
        )
        add_beveled_box(
            f"Bow_DorsalIntakeCavity_{tag}",
            (side * 0.88, 8.95, 0.99),
            (0.52, 2.45, 0.22),
            mats["cavity_black"],
            col,
            bevel=0.01,
            rot=(-0.155, 0.0, 0.0),
            parent=root,
        )
        add_cylinder(
            f"Bow_DorsalIntakeDuct_{tag}",
            (side * 0.88, 8.95, 0.93),
            radius=0.22,
            depth=2.25,
            mat=mats["armor_mid"],
            col=col,
            segments=14,
            rot=(math.pi / 2.0 - 0.155, 0.0, 0.0),
            bevel=0.008,
            parent=root,
        )
        for b_i in range(4):
            yb = 8.05 + b_i * 0.58
            zb = 1.11 - b_i * 0.09
            add_beveled_box(
                f"Bow_DorsalIntakeBaffle_{tag}_{b_i}",
                (side * 0.88, yb, zb),
                (0.54, 0.07, 0.10),
                mats["gunmetal"],
                col,
                bevel=0.008,
                rot=(-0.155, 0.0, 0.0),
                parent=root,
            )

    trench_rings = [
        [(-1.84, 1.55, 1.74), (1.84, 1.55, 1.74), (1.84, 1.55, 1.25), (-1.84, 1.55, 1.25)],
        [(-1.06, 7.35, 1.08), (1.06, 7.35, 1.08), (1.06, 7.35, 0.74), (-1.06, 7.35, 0.74)],
    ]
    add_lofted_sections(
        "Armor_FwdDorsalVTrenchBed",
        trench_rings,
        mats["cavity_black"],
        col,
        bevel=0.015,
        bevel_segments=1,
        parent=root,
    )

    spine_rings = [
        [(-1.54, 1.55, 2.38), (1.54, 1.55, 2.38), (1.68, 1.55, 1.78), (-1.68, 1.55, 1.78)],
        [(-1.16, 4.10, 1.98), (1.16, 4.10, 1.98), (1.28, 4.10, 1.48), (-1.28, 4.10, 1.48)],
        [(-0.74, 7.20, 1.38), (0.74, 7.20, 1.38), (0.86, 7.20, 1.00), (-0.86, 7.20, 1.00)],
    ]
    add_lofted_sections(
        "Armor_FwdDorsalSpineRamp",
        spine_rings,
        mats["armor_light"],
        col,
        bevel=0.035,
        bevel_segments=2,
        parent=root,
    )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_lofted_sections(
            f"Armor_FwdTrenchCoaming_{tag}",
            [
                [(side * 1.38, 1.65, 2.46), (side * 1.56, 1.65, 2.44), (side * 1.58, 1.65, 2.28), (side * 1.36, 1.65, 2.28)],
                [(side * 0.62, 7.15, 1.45), (side * 0.78, 7.15, 1.43), (side * 0.80, 7.15, 1.28), (side * 0.60, 7.15, 1.28)],
            ],
            mats["armor_white"],
            col,
            bevel=0.015,
            bevel_segments=1,
            parent=root,
        )

    add_beveled_box(
        "Dorsal_QuadTurretWell",
        (0.0, 2.80, 2.16),
        (1.16, 1.42, 0.16),
        mats["gunmetal"],
        col,
        bevel=0.02,
        rot=(-0.155, 0.0, 0.0),
        parent=root,
    )
    add_beveled_box(
        "Dorsal_QuadTurretBody",
        (0.0, 2.65, 2.28),
        (0.86, 0.76, 0.22),
        mats["armor_mid"],
        col,
        bevel=0.025,
        rot=(-0.155, 0.0, 0.0),
        parent=root,
    )
    for b_idx, bx in enumerate((-0.28, -0.09, 0.09, 0.28)):
        add_cylinder(
            f"Dorsal_QuadTurretBarrel_{b_idx}",
            (bx, 3.22, 2.24),
            radius=0.046,
            depth=0.90,
            mat=mats["gunmetal"],
            col=col,
            segments=10,
            rot=(math.pi / 2.0 - 0.155, 0.0, 0.0),
            bevel=0.004,
            parent=root,
        )

    # ICONIC GIANT MIDSHIP FLANK ARMOR SHIELDS
    mid_shield_stbd = [
        [
            (1.92, -2.68,  2.24),
            (3.92, -2.68,  1.96),
            (4.52, -2.62,  0.48),
            (4.22, -1.92, -1.42),
            (3.40, -1.85, -1.58),
            (1.92, -2.35, -0.75),
        ],
        [
            (1.86, -1.50,  2.20),
            (3.96, -1.50,  1.88),
            (4.70, -1.50,  0.45),
            (4.36, -1.50, -1.46),
            (3.38, -1.50, -1.62),
            (1.86, -1.50, -0.75),
        ],
        [
            (1.78,  1.45,  2.06),
            (3.84,  1.45,  1.76),
            (4.72,  1.45,  0.42),
            (4.24,  1.32, -1.44),
            (3.30,  1.28, -1.58),
            (1.78,  1.35, -0.72),
        ],
        [
            (1.76,  2.42,  1.96),
            (3.55,  2.62,  1.66),
            (4.28,  2.82,  0.54),
            (3.80,  1.72, -1.25),
            (3.10,  1.62, -1.36),
            (1.76,  1.95, -0.64),
        ],
    ]
    build_symmetric_loft(
        "Armor_MidshipFlankShield",
        mid_shield_stbd,
        mats["armor_white"],
        col,
        bevel=0.055,
        bevel_segments=2,
        parent=root,
    )

    # Razor-thin fiery molten-amber diagonal undercut slash on Midship Shield (hero-v2.png!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Midship_FrontUndercutCavity_{tag}",
            (side * 3.80, 2.08, -0.35),
            (0.42, 0.56, 1.40),
            mats["cavity_black"],
            col,
            bevel=0.015,
            rot=(0.48, 0.0, side * 0.24),
            parent=root,
        )
        add_beveled_box(
            f"Midship_FrontAmberSlash_{tag}",
            (side * 3.98, 2.22, -0.32),
            (0.055, 0.055, 1.05),
            mats["amber_vent"],
            col,
            bevel=0.006,
            rot=(0.48, 0.0, side * 0.24),
            parent=root,
        )
        add_beveled_box(
            f"Midship_RearDorsalHingePocket_{tag}",
            (side * 2.28, -2.18, 2.20),
            (0.56, 0.78, 0.14),
            mats["gunmetal"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"Midship_SideDetent_{tag}",
            (side * 4.50, -1.55, -0.56),
            (0.20, 0.58, 0.14),
            mats["gunmetal"],
            col,
            bevel=0.01,
            rot=(0.0, side * 0.16, 0.0),
            parent=root,
        )

    # Aft Upper & Lower Flank Armor Slabs
    aft_upper_stbd = [
        [
            (3.74, -8.68,  1.62),
            (4.26, -8.68,  1.54),
            (4.38, -9.36,  0.50),
            (4.20, -9.36,  0.38),
            (3.70, -9.16,  0.42),
        ],
        [
            (3.76, -3.65,  1.70),
            (4.30, -3.65,  1.62),
            (4.42, -4.35,  0.56),
            (4.24, -4.35,  0.44),
            (3.74, -4.15,  0.48),
        ],
    ]
    build_symmetric_loft(
        "Armor_AftUpperFlankSlab",
        aft_upper_stbd,
        mats["armor_white"],
        col,
        bevel=0.04,
        bevel_segments=2,
        parent=root,
    )

    aft_lower_stbd = [
        [
            (3.52, -8.12, -0.44),
            (4.12, -8.12, -0.50),
            (3.86, -7.36, -1.62),
            (3.30, -7.36, -1.66),
        ],
        [
            (3.56, -4.98, -0.44),
            (4.16, -4.98, -0.50),
            (3.90, -4.32, -1.62),
            (3.34, -4.32, -1.66),
        ],
    ]
    build_symmetric_loft(
        "Armor_AftLowerFlankTab",
        aft_lower_stbd,
        mats["armor_white"],
        col,
        bevel=0.038,
        bevel_segments=2,
        parent=root,
    )

    mid_aft_shoulder_stbd = [
        [
            (1.68, -6.95, 2.74),
            (3.38, -6.95, 2.66),
            (3.70, -6.95, 2.18),
            (3.54, -6.95, 2.02),
            (1.68, -6.95, 2.05),
        ],
        [
            (1.92, -2.55, 2.84),
            (3.46, -2.55, 2.72),
            (3.84, -2.55, 2.22),
            (3.64, -2.55, 2.06),
            (1.92, -2.55, 2.12),
        ],
    ]
    build_symmetric_loft(
        "Armor_MidAftDorsalShoulder",
        mid_aft_shoulder_stbd,
        mats["armor_white"],
        col,
        bevel=0.045,
        bevel_segments=2,
        parent=root,
    )

    stern_lip_rings = [
        [
            (-2.88, -11.88, 2.52), ( 2.88, -11.88, 2.52),
            ( 3.46, -11.88, 2.10), ( 3.28, -11.88, 1.94),
            (-3.28, -11.88, 1.94), (-3.46, -11.88, 2.10),
        ],
        [
            (-3.12, -10.80, 2.62), ( 3.12, -10.80, 2.62),
            ( 3.68, -10.80, 2.18), ( 3.48, -10.80, 1.98),
            (-3.48, -10.80, 1.98), (-3.68, -10.80, 2.18),
        ],
        [
            (-3.26,  -7.25, 2.68), ( 3.26,  -7.25, 2.68),
            ( 3.74,  -7.25, 2.22), ( 3.56,  -7.25, 2.02),
            (-3.56,  -7.25, 2.02), (-3.74,  -7.25, 2.22),
        ],
    ]
    add_lofted_sections(
        "Armor_SternDorsalCanopyBase",
        stern_lip_rings,
        mats["armor_white"],
        col,
        bevel=0.045,
        bevel_segments=2,
        parent=root,
    )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_lofted_sections(
            f"Armor_SternDorsalWing_{tag}",
            [
                [(side * 1.12, -11.62, 2.75), (side * 2.80, -11.62, 2.71), (side * 3.04, -11.62, 2.54), (side * 1.12, -11.62, 2.54)],
                [(side * 1.12,  -7.40, 2.83), (side * 3.16,  -7.40, 2.79), (side * 3.44,  -7.40, 2.60), (side * 1.12,  -7.40, 2.60)],
            ],
            mats["armor_light"],
            col,
            bevel=0.032,
            bevel_segments=2,
            parent=root,
        )
        add_beveled_box(
            f"Stern_DorsalMechPocket_{tag}",
            (side * 1.95, -8.82, 2.77),
            (1.18, 1.52, 0.14),
            mats["armor_mid"],
            col,
            bevel=0.02,
            parent=root,
        )
        add_beveled_box(
            f"Stern_DorsalMechCore_{tag}",
            (side * 1.95, -8.82, 2.82),
            (0.84, 1.12, 0.12),
            mats["gunmetal"],
            col,
            bevel=0.015,
            parent=root,
        )
        for c_i, dx in enumerate((-0.24, 0.24)):
            add_cylinder(
                f"Stern_DorsalMechValve_{tag}_{c_i}",
                (side * 1.95 + dx, -8.82, 2.86),
                radius=0.14,
                depth=0.20,
                mat=mats["chassis_dark"],
                col=col,
                segments=12,
                bevel=0.008,
                parent=root,
            )
        add_beveled_box(
            f"Stern_DorsalVentSlit_{tag}",
            (side * 1.38, -10.35, 2.75),
            (0.16, 1.35, 0.12),
            mats["cavity_black"],
            col,
            bevel=0.008,
            parent=root,
        )
        add_beveled_box(
            f"Stern_DorsalCornerHatch_{tag}",
            (side * 2.42, -11.20, 2.72),
            (0.42, 0.42, 0.04),
            mats["armor_mid"],
            col,
            bevel=0.01,
            parent=root,
        )

    add_beveled_box(
        "Stern_DorsalCenterChannel",
        (0.0, -9.55, 2.65),
        (1.62, 3.85, 0.18),
        mats["armor_mid"],
        col,
        bevel=0.025,
        parent=root,
    )
    add_beveled_box(
        "Stern_DorsalCenterBridge",
        (0.0, -9.85, 2.74),
        (1.08, 2.55, 0.12),
        mats["armor_white"],
        col,
        bevel=0.02,
        parent=root,
    )


# ---------------------------------------------------------------------------
# 6. Module 3: Tiered Dorsal Command Bridge Superstructure & Comms Mast
# ---------------------------------------------------------------------------

def build_dorsal_bridge(mats, col, root):
    t1_poly = [
        (-1.75, -0.35),
        ( 1.75, -0.35),
        ( 2.65, -1.65),
        ( 2.65, -5.85),
        ( 1.55, -6.90),
        (-1.55, -6.90),
        (-2.65, -5.85),
        (-2.65, -1.65),
    ]
    add_extruded_poly_z(
        "Bridge_Tier1_Platform",
        t1_poly,
        z0=2.12,
        z1=2.76,
        mat=mats["armor_white"],
        col=col,
        bevel=0.05,
        bevel_segments=2,
        taper_top=0.94,
        parent=root,
    )

    glacis_rings = [
        [(-1.72, -1.05, 2.74), (1.72, -1.05, 2.74), (1.92, -1.05, 2.25), (-1.92, -1.05, 2.25)],
        [(-1.54,  1.62, 2.38), (1.54,  1.62, 2.38), (1.70,  1.62, 2.02), (-1.70,  1.62, 2.02)],
    ]
    add_lofted_sections(
        "Bridge_ForwardGlacisDeck",
        glacis_rings,
        mats["armor_light"],
        col,
        bevel=0.035,
        bevel_segments=2,
        parent=root,
    )

    add_beveled_box(
        "Bridge_AftVentHousing",
        (0.0, -5.85, 2.78),
        (1.22, 0.88, 0.16),
        mats["armor_mid"],
        col,
        bevel=0.02,
        parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_AftVentWell_{tag}",
            (side * 0.28, -5.85, 2.85),
            (0.36, 0.56, 0.08),
            mats["cavity_black"],
            col,
            bevel=0.008,
            parent=root,
        )
        add_beveled_box(
            f"Bridge_AftVentGlow_{tag}",
            (side * 0.28, -5.85, 2.87),
            (0.16, 0.20, 0.05),
            mats["bridge_pip"],
            col,
            bevel=0.005,
            parent=root,
        )

    t2_poly = [
        (-1.18, -1.10),
        ( 1.18, -1.10),
        ( 2.02, -2.05),
        ( 2.02, -4.35),
        ( 1.20, -5.22),
        (-1.20, -5.22),
        (-2.02, -4.35),
        (-2.02, -2.05),
    ]
    add_extruded_poly_z(
        "Bridge_Tier2_CitadelLower",
        t2_poly,
        z0=2.68,
        z1=3.02,
        mat=mats["armor_light"],
        col=col,
        bevel=0.04,
        bevel_segments=2,
        taper_top=0.92,
        parent=root,
    )

    win_poly = [
        (-1.04, -1.28),
        ( 1.04, -1.28),
        ( 1.74, -2.12),
        ( 1.74, -4.25),
        ( 1.04, -5.02),
        (-1.04, -5.02),
        (-1.74, -4.25),
        (-1.74, -2.12),
    ]
    add_extruded_poly_z(
        "Bridge_PanoramicGlassBand",
        win_poly,
        z0=2.98,
        z1=3.19,
        mat=mats["bridge_glass"],
        col=col,
        bevel=0.015,
        bevel_segments=1,
        taper_top=0.96,
        parent=root,
    )

    # Fine fiery amber command bridge slit lights behind mullions (subtle, like hero-v2!)
    for m_i, (mx, my, myaw) in enumerate([
        ( 0.00, -1.24,  0.00),
        (-0.56, -1.26,  0.00),
        ( 0.56, -1.26,  0.00),
        (-1.38, -1.72, -0.78),
        ( 1.38, -1.72,  0.78),
    ]):
        add_beveled_box(
            f"Bridge_WindowGlowSlit_{m_i}",
            (mx, my, 3.08),
            (0.28, 0.04, 0.028),
            mats["bridge_pip"],
            col,
            bevel=0.004,
            rot=(0.0, 0.0, myaw),
            parent=root,
        )

    mullion_coords = [
        (-0.84, -1.24), (-0.28, -1.24), (0.28, -1.24), (0.84, -1.24),
        (-1.45, -1.68), ( 1.45, -1.68),
        (-1.74, -2.40), ( 1.74, -2.40),
        (-1.74, -3.20), ( 1.74, -3.20),
        (-1.74, -4.00), ( 1.74, -4.00),
    ]
    for idx, (mx, my) in enumerate(mullion_coords):
        add_beveled_box(
            f"Bridge_WindowMullion_{idx}",
            (mx, my, 3.08),
            (0.08, 0.08, 0.22),
            mats["gunmetal"],
            col,
            bevel=0.008,
            parent=root,
        )

    t3_poly = [
        (-1.06, -1.28),
        ( 1.06, -1.28),
        ( 1.80, -2.12),
        ( 1.80, -4.25),
        ( 1.06, -5.02),
        (-1.06, -5.02),
        (-1.80, -4.25),
        (-1.80, -2.12),
    ]
    add_extruded_poly_z(
        "Bridge_Tier3_RoofCrown",
        t3_poly,
        z0=3.17,
        z1=3.48,
        mat=mats["armor_light"],
        col=col,
        bevel=0.04,
        bevel_segments=2,
        taper_top=0.78,
        parent=root,
    )

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bridge_WingPod_{tag}",
            (side * 2.18, -4.15, 2.84),
            (0.46, 1.35, 0.24),
            mats["armor_mid"],
            col,
            bevel=0.025,
            parent=root,
        )
        add_beveled_box(
            f"Bridge_WingNavPip_{tag}",
            (side * 2.22, -4.15, 2.97),
            (0.10, 0.14, 0.035),
            mats["bridge_pip"],
            col,
            bevel=0.004,
            parent=root,
        )
        add_beveled_box(
            f"Bridge_RoofOpticsBox_{tag}",
            (side * 0.62, -2.75, 3.56),
            (0.54, 0.70, 0.18),
            mats["armor_white"],
            col,
            bevel=0.02,
            parent=root,
        )
        add_beveled_box(
            f"Bridge_RoofOpticsLens_{tag}",
            (side * 0.26, -3.22, 3.58),
            (0.26, 0.28, 0.16),
            mats["gunmetal"],
            col,
            bevel=0.015,
            parent=root,
        )

    add_beveled_box(
        "Bridge_RoofCenterSpine",
        (0.0, -3.25, 3.54),
        (0.46, 2.10, 0.16),
        mats["armor_mid"],
        col,
        bevel=0.02,
        parent=root,
    )

    mast_base_rings = [
        [(-0.12, -4.82, 3.44), (0.12, -4.82, 3.44), (0.10, -4.28, 3.44), (-0.10, -4.28, 3.44)],
        [(-0.075, -4.72, 3.92), (0.075, -4.72, 3.92), (0.065, -4.44, 3.92), (-0.065, -4.44, 3.92)],
        [(-0.036, -4.66, 4.38), (0.036, -4.66, 4.38), (0.030, -4.55, 4.38), (-0.030, -4.55, 4.38)],
        [(-0.020, -4.63, 4.82), (0.020, -4.63, 4.82), (0.018, -4.58, 4.82), (-0.018, -4.58, 4.82)],
    ]
    add_lofted_sections(
        "Bridge_MainCommsMast",
        mast_base_rings,
        mats["gunmetal"],
        col,
        bevel=0.006,
        bevel_segments=1,
        parent=root,
    )

    sensor_stubs = [
        ("Bridge_SensorStub_Aft",   ( 0.00, -4.08, 3.74), (0.12, 0.20, 0.34), (-0.12, 0.0, 0.0)),
        ("Bridge_SensorStub_Port",  (-0.32, -3.72, 3.72), (0.09, 0.14, 0.30), ( 0.08, 0.0, 0.0)),
        ("Bridge_SensorStub_Stbd",  ( 0.32, -3.72, 3.72), (0.09, 0.14, 0.30), ( 0.08, 0.0, 0.0)),
        ("Bridge_SensorWhip_Port",  (-0.20, -4.28, 3.94), (0.038, 0.038, 0.54), (0.0, 0.0, 0.0)),
        ("Bridge_SensorWhip_Stbd",  ( 0.24, -3.45, 3.82), (0.035, 0.035, 0.40), (0.0, 0.0, 0.0)),
    ]
    for sname, sloc, ssz, srot in sensor_stubs:
        add_beveled_box(
            sname,
            sloc,
            ssz,
            mats["gunmetal"],
            col,
            bevel=0.006,
            rot=srot,
            parent=root,
        )


# ---------------------------------------------------------------------------
# 7. Module 4: Iconic Stern 5-Thruster Propulsion Bay (HOLLOW NOZZLES!)
# ---------------------------------------------------------------------------

def build_stern_propulsion_bay(mats, col, root):
    add_extruded_poly_y(
        "Stern_TransomBulkhead",
        [
            (-3.26,  1.92), ( 3.26,  1.92),
            ( 3.92,  0.92), ( 3.84, -0.58),
            ( 2.98, -1.66), (-2.98, -1.66),
            (-3.84, -0.58), (-3.92,  0.92),
        ],
        y0=-11.48,
        y1=-10.65,
        mat=mats["chassis_dark"],
        col=col,
        bevel=0.05,
        scale_y0=0.97,
        scale_y1=1.03,
        parent=root,
    )

    # Center Vertical Louvered Thruster
    c_outer = chamfered_rect_xz(0.0, -0.02, hw=0.94, hh=1.32, ch=0.24)
    c_inner = chamfered_rect_xz(0.0, -0.02, hw=0.62, hh=1.00, ch=0.14)
    add_hollow_shroud_y(
        "Thruster_Center_HollowShroud",
        c_outer,
        c_inner,
        y_back=-11.98,
        y_front=-11.30,
        mat=mats["chassis_dark"],
        col=col,
        bevel=0.025,
        outer_scale_back=0.96,
        outer_scale_front=1.03,
        inner_scale_back=1.04,
        inner_scale_front=0.94,
        parent=root,
    )
    c_mid_out = chamfered_rect_xz(0.0, -0.02, hw=0.68, hh=1.06, ch=0.15)
    c_mid_in  = chamfered_rect_xz(0.0, -0.02, hw=0.55, hh=0.92, ch=0.12)
    add_hollow_shroud_y(
        "Thruster_Center_InnerCollar",
        c_mid_out,
        c_mid_in,
        y_back=-11.86,
        y_front=-11.45,
        mat=mats["gunmetal"],
        col=col,
        bevel=0.014,
        outer_scale_back=1.0,
        outer_scale_front=1.0,
        inner_scale_back=1.0,
        inner_scale_front=0.95,
        parent=root,
    )
    c_glow = chamfered_rect_xz(0.0, -0.02, hw=0.60, hh=0.96, ch=0.13)
    add_extruded_poly_y(
        "Thruster_Center_GlowChamber",
        c_glow,
        y0=-11.72,
        y1=-11.46,
        mat=mats["thruster_glow"],
        col=col,
        bevel=0.01,
        parent=root,
    )
    c_hot = chamfered_rect_xz(0.0, -0.02, hw=0.40, hh=0.72, ch=0.09)
    add_extruded_poly_y(
        "Thruster_Center_HotCore",
        c_hot,
        y0=-11.77,
        y1=-11.65,
        mat=mats["thruster_hot"],
        col=col,
        bevel=0.008,
        parent=root,
    )
    for l_i in range(7):
        zl = -0.78 + l_i * 0.25
        add_beveled_box(
            f"Thruster_Center_LouverSlat_{l_i}",
            (0.0, -11.87, zl),
            (1.12, 0.12, 0.056),
            mats["gunmetal"],
            col,
            bevel=0.008,
            parent=root,
        )

    # Twin Upper & Lower Thrusters
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        u_outer = [
            (side * 1.14,  1.52),
            (side * 3.04,  1.44),
            (side * 3.46,  1.00),
            (side * 3.52, -0.08),
            (side * 3.16, -0.36),
            (side * 1.20, -0.36),
            (side * 1.06, -0.14),
            (side * 1.06,  1.34),
        ]
        u_inner = [
            (side * 1.48,  1.14),
            (side * 2.74,  1.08),
            (side * 2.98,  0.76),
            (side * 3.02,  0.08),
            (side * 2.80, -0.08),
            (side * 1.52, -0.08),
            (side * 1.42,  0.08),
            (side * 1.42,  0.98),
        ]
        if side < 0:
            u_outer = list(reversed(u_outer))
            u_inner = list(reversed(u_inner))

        add_hollow_shroud_y(
            f"Thruster_Upper_{tag}_HollowShroud",
            u_outer,
            u_inner,
            y_back=-11.94,
            y_front=-11.24,
            mat=mats["chassis_dark"],
            col=col,
            bevel=0.028,
            outer_scale_back=0.96,
            outer_scale_front=1.03,
            inner_scale_back=1.05,
            inner_scale_front=0.94,
            parent=root,
        )
        u_mid_out = [
            (side * 1.40,  1.22),
            (side * 2.82,  1.16),
            (side * 3.08,  0.84),
            (side * 3.12,  0.04),
            (side * 2.88, -0.14),
            (side * 1.44, -0.14),
            (side * 1.34,  0.04),
            (side * 1.34,  1.06),
        ]
        if side < 0:
            u_mid_out = list(reversed(u_mid_out))
        add_hollow_shroud_y(
            f"Thruster_Upper_{tag}_InnerCollar",
            u_mid_out,
            u_inner,
            y_back=-11.82,
            y_front=-11.42,
            mat=mats["gunmetal"],
            col=col,
            bevel=0.014,
            outer_scale_back=1.0,
            outer_scale_front=1.0,
            inner_scale_back=1.0,
            inner_scale_front=0.95,
            parent=root,
        )
        add_extruded_poly_y(
            f"Thruster_Upper_{tag}_GlowChamber",
            u_inner,
            y0=-11.68,
            y1=-11.42,
            mat=mats["thruster_glow"],
            col=col,
            bevel=0.01,
            scale_y0=1.04,
            scale_y1=1.04,
            parent=root,
        )
        u_hot = [
            (side * 1.64,  0.90),
            (side * 2.58,  0.86),
            (side * 2.76,  0.62),
            (side * 2.78,  0.18),
            (side * 2.60,  0.06),
            (side * 1.64,  0.06),
            (side * 1.56,  0.18),
            (side * 1.56,  0.78),
        ]
        if side < 0:
            u_hot = list(reversed(u_hot))
        add_extruded_poly_y(
            f"Thruster_Upper_{tag}_HotCore",
            u_hot,
            y0=-11.73,
            y1=-11.60,
            mat=mats["thruster_hot"],
            col=col,
            bevel=0.008,
            parent=root,
        )
        add_beveled_box(
            f"Thruster_Upper_{tag}_SplitterVane",
            (side * 2.20, -11.83, 0.50),
            (1.38, 0.12, 0.052),
            mats["gunmetal"],
            col,
            bevel=0.008,
            parent=root,
        )

        l_outer = [
            (side * 1.08, -0.48),
            (side * 2.56, -0.48),
            (side * 3.40, -0.88),
            (side * 2.90, -1.46),
            (side * 1.18, -1.46),
            (side * 1.04, -1.24),
        ]
        l_inner = [
            (side * 1.34, -0.72),
            (side * 2.42, -0.72),
            (side * 3.00, -0.96),
            (side * 2.70, -1.20),
            (side * 1.38, -1.20),
            (side * 1.30, -1.04),
        ]
        if side < 0:
            l_outer = list(reversed(l_outer))
            l_inner = list(reversed(l_inner))

        add_hollow_shroud_y(
            f"Thruster_Lower_{tag}_HollowShroud",
            l_outer,
            l_inner,
            y_back=-11.90,
            y_front=-11.22,
            mat=mats["chassis_dark"],
            col=col,
            bevel=0.025,
            outer_scale_back=0.96,
            outer_scale_front=1.03,
            inner_scale_back=1.06,
            inner_scale_front=0.94,
            parent=root,
        )
        add_extruded_poly_y(
            f"Thruster_Lower_{tag}_GlowChamber",
            l_inner,
            y0=-11.68,
            y1=-11.44,
            mat=mats["thruster_glow"],
            col=col,
            bevel=0.008,
            scale_y0=1.05,
            scale_y1=1.05,
            parent=root,
        )
        add_extruded_poly_y(
            f"Thruster_Lower_{tag}_HotCore",
            l_inner,
            y0=-11.73,
            y1=-11.60,
            mat=mats["thruster_hot"],
            col=col,
            bevel=0.006,
            scale_y0=0.80,
            scale_y1=0.80,
            parent=root,
        )

    add_extruded_poly_y(
        "Stern_VentralKeelUpperStep",
        [
            (-2.08, -1.62), ( 2.08, -1.62),
            ( 1.76, -2.26), (-1.76, -2.26),
        ],
        y0=-11.32,
        y1=-9.45,
        mat=mats["chassis_dark"],
        col=col,
        bevel=0.035,
        parent=root,
    )
    add_extruded_poly_y(
        "Stern_VentralKeelLowerStep",
        [
            (-1.54, -2.18), ( 1.54, -2.18),
            ( 1.14, -2.74), (-1.14, -2.74),
        ],
        y0=-10.92,
        y1=-8.40,
        mat=mats["gunmetal"],
        col=col,
        bevel=0.03,
        parent=root,
    )


# ---------------------------------------------------------------------------
# 8. Module 5: Exposed Mechanical Side Trenches & Razor-Slim Fiery Ember Slits
# ---------------------------------------------------------------------------

def build_trenches_greebles_and_lighting(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # 5A. Forward-Mid Exposed Mechanical Canyon: razor-thin fiery orange slits behind dark ribs!
        add_beveled_box(
            f"Trench_FwdAmberStrip_{tag}",
            (side * 2.74, 4.35, -0.44),
            (0.08, 4.20, 0.055),
            mats["amber_vent"],
            col,
            bevel=0.005,
            rot=(0.0, 0.0, side * 0.12),
            parent=root,
        )
        add_beveled_box(
            f"Trench_FwdAmberStripSub_{tag}",
            (side * 2.66, 4.45, -0.76),
            (0.07, 3.20, 0.032),
            mats["amber_vent"],
            col,
            bevel=0.004,
            rot=(0.0, 0.0, side * 0.12),
            parent=root,
        )
        for r_i in range(9):
            yr = 2.40 + r_i * 0.48
            xr = side * (3.00 - r_i * 0.056)
            add_beveled_box(
                f"Trench_FwdRib_{tag}_{r_i}",
                (xr, yr, -0.60),
                (0.22, 0.095, 0.86),
                mats["gunmetal"],
                col,
                bevel=0.01,
                parent=root,
            )
        add_cylinder(
            f"Trench_FwdPipe_{tag}",
            (side * 2.78, 4.45, -0.94),
            radius=0.072,
            depth=4.45,
            mat=mats["armor_mid"],
            col=col,
            segments=10,
            rot=(math.pi / 2.0, 0.0, side * 0.12),
            bevel=0.004,
            parent=root,
        )

        # 5B. Aft Side Mechanical Trenches & Razor-Slim Fiery Orange Aft Vent Slits!
        # 1. Aft Rear-Mid Horizontal Fiery Orange Vent Slit (Y = -10.55 .. -8.15, Z = -0.66)
        add_beveled_box(
            f"Trench_AftRearGlowHousing_{tag}",
            (side * 3.74, -9.35, -0.66),
            (0.32, 2.55, 0.28),
            mats["cavity_black"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"Trench_AftRearAmberGlow_{tag}",
            (side * 3.86, -9.35, -0.66),
            (0.08, 2.25, 0.068),
            mats["amber_vent"],
            col,
            bevel=0.005,
            parent=root,
        )
        # 2. Aft Ventral Lower Trench Fiery Orange Segmented Vent Strip (clearly visible in hero-v2!)
        add_beveled_box(
            f"Trench_AftVentralGlowHousing_{tag}",
            (side * 3.24, -6.90, -2.00),
            (0.30, 3.85, 0.26),
            mats["cavity_black"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"Trench_AftVentralAmberGlow_{tag}",
            (side * 3.34, -6.90, -2.00),
            (0.09, 3.45, 0.068),
            mats["amber_vent"],
            col,
            bevel=0.005,
            parent=root,
        )
        for v_i in range(7):
            yv = -8.40 + v_i * 0.50
            add_beveled_box(
                f"Trench_AftVentralRib_{tag}_{v_i}",
                (side * 3.40, yv, -2.00),
                (0.09, 0.08, 0.22),
                mats["gunmetal"],
                col,
                bevel=0.006,
                parent=root,
            )
        # 3. Aft Upper Rear Horizon Ember Slit under stern canopy (hero-v2 top-right glow!)
        add_beveled_box(
            f"Trench_AftUpperYellowLight_{tag}",
            (side * 3.82, -10.15, 1.82),
            (0.09, 1.55, 0.055),
            mats["amber_vent"],
            col,
            bevel=0.004,
            parent=root,
        )

        # Continuous sleek dark steel structural beams & conduits along Aft Mid Trench
        add_beveled_box(
            f"Trench_AftMidSpineBeam_{tag}",
            (side * 3.92, -7.25, 0.08),
            (0.28, 7.60, 0.28),
            mats["gunmetal"],
            col,
            bevel=0.02,
            parent=root,
        )
        add_beveled_box(
            f"Trench_AftMidLowerBeam_{tag}",
            (side * 3.88, -7.10, -0.24),
            (0.24, 7.20, 0.18),
            mats["chassis_dark"],
            col,
            bevel=0.015,
            parent=root,
        )
        for m_i in range(8):
            ym = -10.55 + m_i * 0.92
            add_beveled_box(
                f"Trench_AftMidRib_{tag}_{m_i}",
                (side * 3.98, ym, -0.02),
                (0.12, 0.14, 0.64),
                mats["gunmetal"],
                col,
                bevel=0.01,
                parent=root,
            )
        add_beveled_box(
            f"Trench_AftUpperBeam_{tag}",
            (side * 3.74, -7.30, 1.82),
            (0.32, 7.80, 0.28),
            mats["gunmetal"],
            col,
            bevel=0.02,
            parent=root,
        )
        for u_i in range(9):
            yu = -10.85 + u_i * 0.88
            add_beveled_box(
                f"Trench_AftUpperRib_{tag}_{u_i}",
                (side * 3.84, yu, 1.82),
                (0.14, 0.12, 0.30),
                mats["chassis_dark"],
                col,
                bevel=0.008,
                parent=root,
            )
        for s_i in range(8):
            zs = -1.10 + s_i * 0.34
            add_beveled_box(
                f"Trench_MidAftRadiatorSlat_{tag}_{s_i}",
                (side * 3.92, -3.28, zs),
                (0.36, 1.12, 0.11),
                mats["gunmetal"],
                col,
                bevel=0.01,
                parent=root,
            )

        # Clean recessed mechanical vents & crisp panel seam lines (surface micro-plating driven by 1024px PBR!)
        add_beveled_box(
            f"Midship_TopRecessVent_{tag}",
            (side * 3.25, 0.55, 1.94),
            (0.44, 0.96, 0.05),
            mats["armor_mid"],
            col,
            bevel=0.01,
            rot=(-0.04, side * 0.14, 0.0),
            parent=root,
        )
        add_beveled_box(
            f"Midship_FlankPanelSeam_{tag}",
            (side * 4.31, -0.58, 1.16),
            (0.028, 0.030, 1.50),
            mats["cavity_black"],
            col,
            bevel=0.003,
            rot=(0.0, -side * 0.525, 0.0),
            parent=root,
        )
        add_beveled_box(
            f"Midship_LowerPanelSeam_{tag}",
            (side * 4.46, -0.58, -0.52),
            (0.028, 0.030, 1.74),
            mats["cavity_black"],
            col,
            bevel=0.003,
            rot=(0.0, side * 0.21, 0.0),
            parent=root,
        )
        add_beveled_box(
            f"Bow_CheekPanelSeam_{tag}",
            (side * 2.77, 6.18, 0.67),
            (0.032, 0.028, 0.96),
            mats["cavity_black"],
            col,
            bevel=0.003,
            rot=(-0.08, -side * 0.515, side * 0.165),
            parent=root,
        )
        add_beveled_box(
            f"AftSlab_VerticalSeam_{tag}",
            (side * 4.34, -6.55, 1.04),
            (0.036, 0.030, 1.06),
            mats["cavity_black"],
            col,
            bevel=0.003,
            rot=(-0.48, -side * 0.115, 0.0),
            parent=root,
        )

    add_beveled_box(
        "Dorsal_SpineHatchSeam",
        (0.0, 4.45, 1.93),
        (1.65, 0.030, 0.035),
        mats["cavity_black"],
        col,
        bevel=0.003,
        rot=(-0.17, 0.0, 0.0),
        parent=root,
    )


# ---------------------------------------------------------------------------
# 9. High-Contrast Aerospace Studio Lighting, Local Ember Bounce & 7 Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("ClaudeCode_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        # Neutral charcoal orbital studio backdrop (balanced so dark gunmetal ribs stay legible!)
        bg.inputs["Color"].default_value = (0.036, 0.038, 0.044, 1.0)
        bg.inputs["Strength"].default_value = 0.62

    def add_light(name, ltype, loc, target, energy, color, size=12.0, size_y=None, angle=0.03, radius=0.4):
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

    # 1. Strong High-Angle Space Key Sun (dramatic 2.5:1 top-vs-bottom bevel shading matching hero-v2!)
    add_light("Key_Sun_HighBow", "SUN", (-14.0, 18.0, 26.0), (0.0, 0.0, 0.0), energy=4.4, color=(0.98, 0.99, 1.0), angle=0.032)

    # 2. Balanced Starboard Raking Rim (reveals dark gunmetal aft structure cleanly in Side Ortho!)
    add_light("Rim_Area_Stbd", "AREA", (24.0, 5.0, 15.0), (0.0, 0.0, 0.2), energy=3600.0, color=(0.88, 0.93, 1.0), size=16.0)

    # 3. Dorsal-Aft Sculpting Fill (defines bridge tiers, dorsal V-trench & stern deck)
    add_light("Fill_Area_DorsalAft", "AREA", (8.0, -20.0, 20.0), (0.0, -2.0, 1.0), energy=2600.0, color=(0.90, 0.94, 1.0), size=18.0)

    # 4. Stern Metallic Rim (reveals chamfered dark steel 5-thruster shrouds cleanly!)
    add_light("Rim_Area_Stern", "AREA", (-10.0, -24.0, 8.0), (0.0, -10.5, -0.2), energy=3200.0, color=(0.88, 0.93, 1.0), size=14.0)

    # 5. Restrained Cool Planet-Horizon Underbelly Bounce (dark steel belly readable, lower white bevel shaded!)
    add_light("Bounce_Area_Underbelly", "AREA", (-8.0, 5.0, -22.0), (0.0, 0.0, -1.6), energy=1900.0, color=(0.74, 0.84, 1.0), size=22.0)

    # 6. Linear Recessed Strip Area Lights tucked INSIDE the glowing mechanical trenches!
    # Casting uniform warm molten-amber bounce onto the inner black ribs WITHOUT round lightbulb spots on white armor!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_light(
            f"EmberStrip_FwdCanyon_{tag}", "AREA",
            (side * 2.86, 4.35, -0.50), (side * 4.5, 4.35, -0.58),
            energy=42.0, color=(1.0, 0.24, 0.015), size=3.8, size_y=0.08,
        )
        add_light(
            f"EmberStrip_MidSlash_{tag}", "AREA",
            (side * 3.92, 2.24, -0.34), (side * 5.2, 2.6, -0.45),
            energy=20.0, color=(1.0, 0.24, 0.015), size=0.10, size_y=0.90,
        )
        add_light(
            f"EmberStrip_AftRear_{tag}", "AREA",
            (side * 3.90, -9.35, -0.66), (side * 5.5, -9.35, -0.66),
            energy=24.0, color=(1.0, 0.24, 0.015), size=2.1, size_y=0.08,
        )
        add_light(
            f"EmberStrip_AftVentral_{tag}", "AREA",
            (side * 3.38, -6.90, -2.00), (side * 5.0, -6.90, -2.05),
            energy=34.0, color=(1.0, 0.24, 0.015), size=3.2, size_y=0.08,
        )


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=36.0, ortho_scale=26.0):
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

    # 1. Hero 3/4 View matching claude-code-spaceship-hero-v2.png (dramatic eye-level bow-port 3/4!)
    make_cam("Cam_Hero_34", (-17.2, 20.8, 1.8), (0.0, -0.6, 0.2), cam_type="PERSP", lens=35.0)

    # 2. Starboard Side Ortho matching QQ_2026-11-24_06-16-45.png (Stern LEFT, Bow RIGHT!)
    c_side = make_cam("Cam_Side_Ortho", (32.0, 0.0, 0.65), (0.0, 0.0, 0.65), cam_type="ORTHO", ortho_scale=26.2)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

    # 3. Stern Rear Ortho matching QQ_2026-11-24_06-17-15.png
    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -32.0, 0.65), (0.0, 0.0, 0.65), cam_type="ORTHO", ortho_scale=12.6)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    # 4. Top Dorsal Ortho matching QQ_2026-11-24_06-18-02.png
    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 38.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=39.6)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    # 5. Bottom Ventral Ortho matching QQ_1795472348201_thumb.png
    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -38.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=39.6)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    # 6. Front Bow Ortho
    c_front = make_cam("Cam_Front_Ortho", (0.0, 32.0, 0.65), (0.0, 0.0, 0.65), cam_type="ORTHO", ortho_scale=12.6)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    # 7. Rear 3/4 Elevated View
    make_cam("Cam_Rear_34", (16.5, -20.5, 8.8), (0.0, -0.5, 0.3), cam_type="PERSP", lens=36.0)

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
    scene.view_settings.exposure = 0.02

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.clip_end = 500.0


# ---------------------------------------------------------------------------
# 10. Main Build Entrypoint
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root = ensure_collection("ClaudeCode_Dreadnought")
    col_chassis = ensure_collection("01_Internal_Dark_Chassis", col_root)
    col_armor = ensure_collection("02_Primary_White_Armor_Plates", col_root)
    col_bridge = ensure_collection("03_Dorsal_Bridge_Superstructure", col_root)
    col_stern = ensure_collection("04_Stern_5Thruster_Propulsion_Bay", col_root)
    col_detail = ensure_collection("05_Trench_Greebles_And_Lighting", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("ClaudeCode_Dreadnought_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_aerospace_textures(res=1024)
    mats = build_materials(tex)

    build_internal_chassis(mats, col_chassis, root)
    build_primary_white_armor(mats, col_armor, root)
    build_dorsal_bridge(mats, col_bridge, root)
    build_stern_propulsion_bay(mats, col_stern, root)
    build_trenches_greebles_and_lighting(mats, col_detail, root)

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
        f"BUILT ClaudeCode_Dreadnought V7 (Monolithic Photoreal PBR): {len(mesh_objs)} meshes, "
        f"{total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
