"""Parametric film-grade hard-surface 3D model builder for the Orbis Orbital Ring Station (V3 High-Fidelity Overhaul).

Precision-matched to 2x zoomed forensic inspection of all 3 reference views in docs/design/station/:
  - Front Elevation: QQ_2026-11-25_03-50-17.png
  - Rear Elevation:  QQ_2026-11-25_03-50-44.png
  - Edge-On Profile: QQ_2026-11-25_03-51-03.png

Key V3 structural & detail fidelity upgrades:
  1. Exact Asymmetric Stepped Inner Core Hub (R_out=3.58m, variable stepped inner bore R_in=2.26m..2.62m
     with sharp 12:00 & 6:00 architectural step notches, pale-silver left inner flange, recessed upper-right
     multi-deck amber gallery, 3:00 raised docking lug, matte-satin cool blue-steel outer concentric rings,
     and slimmer axial depth Y in [-1.62, +1.62]m).
  2. Exact 16 Cardinal + 45-deg Radial Tension Spokes (th = 0, 22.5, 45, ..., 337.5 deg) with slender crisp
     structural struts anchoring directly into all 4 diagonal collar pods and horizontal/vertical cardinal axes.
  3. Sleek sweeping off-white aerospace ceramic outer hull with hairline panel seams, varied asymmetric plate
     rhythm, micro-hatches/pipes/greebles, and luminous light-grey multi-tiered concave inner cathedral wall.
  4. Reference-faithful recessed bays using satin ochre-gold thermal panels & deep shadowed multi-pipe interiors
     (eliminating uniform glowing checkerboard windows).
  5. Sculpted 4-way diagonal collar cradles with inward-projecting louvered docking claw pods, dense curved
     hydraulic pipe bundles, A-frame Spire turret + open rounded U-arch sensor shroud, ultra-greebled Twin
     Parallel Booms, and sculpted rounded-octagonal chin blister.
  6. Exact Edge-On Rim profile: smooth unbroken recessed central hatch flanked by twin terminating conduit
     rails with upper/lower bracket hoods, compact recessed eyebrow-shaded amber shoulder windows, smooth
     belly shield, 11-fin vertical radiator grille with flanking curved U-pipe loops & twin hanging rods.

Coordinate system (Blender Z-up, meters):
  Ring lies in X-Z plane; central axis is Y.
  -Y = Front face (Image 1), +Y = Rear face (Image 2), +X/+10deg = Edge-On profile (Image 3).
  Outer ring hull: R in [6.05, 10.05] m (20.1 m diameter), Y in [-3.90, +3.90] m (7.8 m thickness).
  Inner core hub:  R in [2.26, 3.58] m  (7.16 m diameter), Y in [-1.62, +1.62] m (3.24 m thickness).
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/station"
RENDER_DIR = os.path.join(OUT_DIR, "renders")
TEX_DIR = os.path.join(OUT_DIR, "textures")
os.makedirs(RENDER_DIR, exist_ok=True)
os.makedirs(TEX_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# 0. Safe Scene Reset & Collection Helpers
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
# 1. Procedural 2048x2048 Seamless Fine-Panel Aerospace PBR Maps
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64), weights=(0.34, 0.26, 0.20, 0.12, 0.08)):
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


def _generate_station_plating(res, seed, grid_x=6, grid_y=4, sub_prob=0.62, seam_px=2):
    """High-density aerospace hairline panel seams, micro-hatches, rivets & micro-vents."""
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
    margin = max(40, res // 22)
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * sx + rng.integers(-sx // 5, sx // 5 + 1), margin, res - margin)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * sy + rng.integers(-sy // 5, sy // 5 + 1), margin, res - margin)))
    xs.append(res)
    ys.append(res)

    min_sub = max(96, res // 8)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 2 and min(w, h) > min_sub and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.30, 0.70))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.30, 0.70))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        tone[y0:y1, x0:x1] = float(rng.uniform(-0.032, 0.032))
        sp = seam_px if depth == 0 else max(1, seam_px - 1)
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        ew = sp + max(4, res // 260)
        if y1 - y0 > ew * 3 and x1 - x0 > ew * 3:
            edge_wear[y0 + sp:y0 + ew, x0 + sp:x1 - sp] = 0.62
            edge_wear[y0 + sp:y1 - sp, x0 + sp:x0 + ew] = 0.56
            edge_wear[max(y1 - ew, y0 + sp):y1 - sp, x0 + sp:x1 - sp] = 0.44

        step = max(34, res // 28)
        pad = sp + max(8, res // 140)
        r_sz = max(2, res // 640)
        if w > pad * 4 and h > pad * 4:
            for rx in range(x0 + pad, x1 - pad, step):
                for ry in (y0 + pad, y1 - pad - r_sz):
                    if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                        rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0

        if w > res // 7 and h > res // 7 and rng.random() < 0.70:
            hw = int(w * rng.uniform(0.20, 0.38))
            hh = int(h * rng.uniform(0.18, 0.34))
            hx0 = x0 + int(w * rng.uniform(0.12, 0.84 - hw / float(w)))
            hy0 = y0 + int(h * rng.uniform(0.12, 0.84 - hh / float(h)))
            hx1 = min(hx0 + hw, x1 - pad)
            hy1 = min(hy0 + hh, y1 - pad)
            if hx1 - hx0 > 32 and hy1 - hy0 > 24:
                tone[hy0:hy1, hx0:hx1] += float(rng.uniform(-0.022, 0.022))
                hsp = 1
                seam[hy0:hy0 + hsp, hx0:hx1] = 0.88
                seam[hy1 - hsp:hy1, hx0:hx1] = 0.88
                seam[hy0:hy1, hx0:hx0 + hsp] = 0.88
                seam[hy0:hy1, hx1 - hsp:hx1] = 0.88
                if rng.random() < 0.45 and (hy1 - hy0) > 40:
                    sl_x0 = hx0 + int((hx1 - hx0) * 0.16)
                    sl_x1 = hx1 - int((hx1 - hx0) * 0.16)
                    n_sl = 4
                    sl_gap = max(5, (hy1 - hy0) // (n_sl + 3))
                    sl_y = hy0 + sl_gap * 2
                    for _ in range(n_sl):
                        if sl_y + 2 < hy1 - 6:
                            hatch_vent[sl_y:sl_y + 2, sl_x0:sl_x1] = 0.80
                            sl_y += sl_gap

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    seam_blur = (
        seam * 0.60
        + np.roll(seam, 1, axis=0) * 0.10
        + np.roll(seam, -1, axis=0) * 0.10
        + np.roll(seam, 1, axis=1) * 0.10
        + np.roll(seam, -1, axis=1) * 0.10
    )
    rivet_blur = (
        rivet * 0.62
        + np.roll(rivet, 1, axis=0) * 0.095
        + np.roll(rivet, -1, axis=0) * 0.095
        + np.roll(rivet, 1, axis=1) * 0.095
        + np.roll(rivet, -1, axis=1) * 0.095
    )
    return tone, np.clip(seam_blur, 0.0, 1.0), edge_wear, np.clip(rivet_blur, 0.0, 1.0), hatch_vent


def _height_to_normal(height, strength=2.6):
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


def generate_station_textures():
    """Synthesize crisp high-density 2048x2048 ceramic & gunmetal PBR maps."""
    res = 2048
    macro = _tileable_fbm(res, seed=101, octaves=(4, 8, 16, 32), weights=(0.38, 0.28, 0.22, 0.12))
    scuff = _tileable_fbm(res, seed=211, octaves=(8, 16, 32, 64), weights=(0.34, 0.30, 0.22, 0.14))
    micro = _tileable_fbm(res, seed=307, octaves=(64, 128, 256), weights=(0.38, 0.34, 0.28))
    streak_raw = _tileable_fbm(res, seed=409, octaves=(16, 32, 64, 128), weights=(0.25, 0.25, 0.25, 0.25))
    streak = (
        streak_raw
        + np.roll(streak_raw, 3, axis=1) + np.roll(streak_raw, -3, axis=1)
        + np.roll(streak_raw, 7, axis=1) + np.roll(streak_raw, -7, axis=1)
    ) / 5.0

    weather_patch = np.clip((scuff - 0.58) * 2.6, 0.0, 1.0) * (0.38 + 0.62 * macro)

    # Set A: High-Density Clean Aerospace Off-White Ceramic Hull (fine crisp architectural seams!)
    tone_w, seam_w, wear_w, riv_w, vent_w = _generate_station_plating(res, seed=503, grid_x=6, grid_y=4, sub_prob=0.62, seam_px=2)
    edge_grime = wear_w * np.clip((micro - 0.40) * 2.0, 0.0, 1.0)
    grime_w = (macro - 0.5) * 0.055 + weather_patch * 0.090 + (streak - 0.5) * 0.036 + (micro - 0.5) * 0.022

    wr = 0.850 + tone_w * 0.52 - grime_w * 0.72 - edge_grime * 0.10
    wg = 0.860 + tone_w * 0.52 - grime_w * 0.70 - edge_grime * 0.098
    wb = 0.878 + tone_w * 0.48 - grime_w * 0.64 - edge_grime * 0.092
    w_dark = (1.0 - seam_w * 0.42) * (1.0 - riv_w * 0.28) * (1.0 - vent_w * 0.48)
    ceramic_albedo = np.stack([wr * w_dark, wg * w_dark, wb * w_dark], axis=-1)

    ceramic_rough = np.clip(
        0.38 + (macro - 0.5) * 0.16 + weather_patch * 0.18 + (streak - 0.5) * 0.09
        + (micro - 0.5) * 0.06 + seam_w * 0.28 + vent_w * 0.26 + edge_grime * 0.12,
        0.20,
        0.84,
    )
    ceramic_rough_rgb = np.stack([ceramic_rough, ceramic_rough, ceramic_rough], axis=-1)
    ceramic_height = np.clip(
        0.78 - seam_w * 0.46 - riv_w * 0.24 - vent_w * 0.38 + tone_w * 0.22
        + (streak - 0.5) * 0.045 + (micro - 0.5) * 0.035,
        0.0,
        1.0,
    )
    ceramic_normal = _height_to_normal(ceramic_height, strength=2.6)

    # Set B: Aerospace Dark Gunmetal & Structural Machinery Core
    tone_g, seam_g, wear_g, riv_g, vent_g = _generate_station_plating(res, seed=709, grid_x=5, grid_y=5, sub_prob=0.58, seam_px=2)
    chip_g = wear_g * np.clip((micro - 0.35) * 2.4, 0.0, 1.0)
    grime_g = (macro - 0.5) * 0.065 + (streak - 0.5) * 0.042

    gr = 0.220 + tone_g * 0.38 - grime_g * 0.65 + chip_g * 0.130
    gg = 0.236 + tone_g * 0.38 - grime_g * 0.65 + chip_g * 0.135
    gb = 0.268 + tone_g * 0.42 - grime_g * 0.60 + chip_g * 0.148
    g_dark = (1.0 - seam_g * 0.45) * (1.0 - riv_g * 0.35) * (1.0 - vent_g * 0.58)
    gunmetal_albedo = np.stack([gr * g_dark, gg * g_dark, gb * g_dark], axis=-1)

    gunmetal_rough = np.clip(
        0.38 + (macro - 0.5) * 0.18 + (streak - 0.5) * 0.10 + seam_g * 0.28 + vent_g * 0.26 - chip_g * 0.16,
        0.18,
        0.82,
    )
    gunmetal_rough_rgb = np.stack([gunmetal_rough, gunmetal_rough, gunmetal_rough], axis=-1)
    gunmetal_height = np.clip(
        0.76 - seam_g * 0.46 - riv_g * 0.26 - vent_g * 0.44 + tone_g * 0.22 + (streak - 0.5) * 0.055,
        0.0,
        1.0,
    )
    gunmetal_normal = _height_to_normal(gunmetal_height, strength=2.7)

    return {
        "ceramic_albedo":  _save_and_pack_image("Tex_StationCeramic_Albedo",  os.path.join(TEX_DIR, "station_ceramic_albedo.png"),  ceramic_albedo, "sRGB"),
        "ceramic_rough":   _save_and_pack_image("Tex_StationCeramic_Rough",   os.path.join(TEX_DIR, "station_ceramic_rough.png"),   ceramic_rough_rgb, "Non-Color"),
        "ceramic_normal":  _save_and_pack_image("Tex_StationCeramic_Normal",  os.path.join(TEX_DIR, "station_ceramic_normal.png"),  ceramic_normal, "Non-Color"),
        "gunmetal_albedo": _save_and_pack_image("Tex_StationGunmetal_Albedo", os.path.join(TEX_DIR, "station_gunmetal_albedo.png"), gunmetal_albedo, "sRGB"),
        "gunmetal_rough":  _save_and_pack_image("Tex_StationGunmetal_Rough",  os.path.join(TEX_DIR, "station_gunmetal_rough.png"),  gunmetal_rough_rgb, "Non-Color"),
        "gunmetal_normal": _save_and_pack_image("Tex_StationGunmetal_Normal", os.path.join(TEX_DIR, "station_gunmetal_normal.png"), gunmetal_normal, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. Station PBR Material Library (Reference-Matched Palette)
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
    metallic=0.14,
    normal_strength=0.55,
    coat=0.12,
    coat_rough=0.22,
    uv_scale=0.46,
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
    coat_rough=0.14,
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
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    return {
        # Primary aerospace white ceramic composite plating (outer ring)
        "armor_white": make_textured_pbr_mat(
            "Mat_Station_WhiteCeramic",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.12, normal_strength=0.58, coat=0.14, coat_rough=0.22, uv_scale=0.48,
        ),
        # Crisp bright titanium-white smooth central rim panel, spire & overlay shields
        "armor_bright": make_textured_pbr_mat(
            "Mat_Station_BrightCeramic",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.10, normal_strength=0.45, coat=0.18, coat_rough=0.18, uv_scale=0.42,
            color_tint=(1.05, 1.06, 1.08),
        ),
        # Luminous cool light-grey inner wall decks, collar sub-frames & stepped ledges
        "inner_grey": make_textured_pbr_mat(
            "Mat_Station_InnerDeckGrey",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.24, normal_strength=0.55, coat=0.10, coat_rough=0.28, uv_scale=0.62,
            color_tint=(0.74, 0.77, 0.83),
        ),
        # Cool medium blue-slate armor for twin booms, collar machinery & outer ribs
        "armor_slate": make_textured_pbr_mat(
            "Mat_Station_SlateArmor",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.34, normal_strength=0.56, coat=0.12, coat_rough=0.26, uv_scale=0.65,
            color_tint=(0.56, 0.62, 0.72),
        ),
        # Inner Core Hub: Signature cool matte-satin steel-blue outer/upper ring (exact ref1_hub.png match!)
        "hub_blue_steel": make_textured_pbr_mat(
            "Mat_Station_HubBlueSteel",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.28, normal_strength=0.52, coat=0.08, coat_rough=0.32, uv_scale=0.66,
            color_tint=(0.50, 0.62, 0.80),
        ),
        # Inner Core Hub: Deeper slate-blue shadowed recesses & ribs
        "hub_blue_dark": make_textured_pbr_mat(
            "Mat_Station_HubBlueDark",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.38, normal_strength=0.54, coat=0.08, coat_rough=0.34, uv_scale=0.78,
            color_tint=(0.34, 0.44, 0.60),
        ),
        # Inner Core Hub: Luminous pale ice-silver left inner stepped crescent flange (seen in ref1_hub.png!)
        "hub_pale_silver": make_textured_pbr_mat(
            "Mat_Station_HubPaleSilver",
            tex["ceramic_albedo"], tex["ceramic_rough"], tex["ceramic_normal"],
            metallic=0.18, normal_strength=0.45, coat=0.12, coat_rough=0.26, uv_scale=0.60,
            color_tint=(0.86, 0.90, 0.96),
        ),
        # Aerospace gunmetal for mechanical trenches, exposed trusses & collar internals
        "gunmetal": make_textured_pbr_mat(
            "Mat_Station_Gunmetal",
            tex["gunmetal_albedo"], tex["gunmetal_rough"], tex["gunmetal_normal"],
            metallic=0.68, normal_strength=0.58, coat=0.10, coat_rough=0.28, uv_scale=0.80,
        ),
        # Satin anodized medium-dark steel for spokes, louver fins, frames & couplers
        "steel_trim": make_solid_pbr_mat(
            "Mat_Station_SteelTrim",
            base_color=(0.20, 0.23, 0.27), metallic=0.76, roughness=0.34, coat=0.12,
        ),
        # Crisp cool pale-grey steel specifically for the 16 radial tension spokes (matches ref1_hub.png!)
        "spoke_steel": make_solid_pbr_mat(
            "Mat_Station_SpokeSteel",
            base_color=(0.36, 0.40, 0.46), metallic=0.62, roughness=0.36, coat=0.10,
        ),
        # Satin silver-white alloy for twin rim conduit rails, inner pipe bundles & antennae
        "alloy_pipe": make_solid_pbr_mat(
            "Mat_Station_AlloyPipe",
            base_color=(0.74, 0.77, 0.81), metallic=0.58, roughness=0.26, coat=0.18,
        ),
        # Deep dark carbon machinery for deep radiator slits & louver mullions
        "dark_machinery": make_solid_pbr_mat(
            "Mat_Station_DarkMachinery",
            base_color=(0.08, 0.09, 0.11), metallic=0.70, roughness=0.42,
        ),
        # Deep recessed shadow cavity backing
        "cavity_dark": make_solid_pbr_mat(
            "Mat_Station_CavityDark",
            base_color=(0.018, 0.022, 0.028), metallic=0.22, roughness=0.70,
        ),
        # Matte-satin industrial golden-ochre thermal panels / bumper blocks (NOT neon yellow!)
        "amber_foil": make_solid_pbr_mat(
            "Mat_Station_AmberFoil",
            base_color=(0.82, 0.54, 0.15), metallic=0.28, roughness=0.40, coat=0.10,
            emission_color=(0.85, 0.50, 0.10), emission_strength=0.16,
        ),
        # Subtle recessed warm golden-amber interior window / slit illumination
        "amber_window": make_solid_pbr_mat(
            "Mat_Station_AmberWindow",
            base_color=(0.94, 0.66, 0.22), metallic=0.06, roughness=0.24,
            emission_color=(1.0, 0.58, 0.14), emission_strength=1.45,
        ),
        # Crisp micro navigation beacon pip
        "beacon_white": make_solid_pbr_mat(
            "Mat_Station_BeaconWhite",
            base_color=(0.94, 0.97, 1.0), metallic=0.0, roughness=0.15,
            emission_color=(0.86, 0.92, 1.0), emission_strength=2.2,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Polar Hard-Surface BMesh Geometry Toolkit
# ---------------------------------------------------------------------------

def polar_pt(r, th, y):
    return Vector((r * math.cos(th), y, r * math.sin(th)))


def polar_frame(th):
    """Orthonormal basis at angle th: local X=radial(+r), Y=axial(+y), Z=tangential(+th)."""
    c, s = math.cos(th), math.sin(th)
    return Matrix((
        (c, 0.0, -s, 0.0),
        (0.0, 1.0, 0.0, 0.0),
        (s, 0.0, c, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))


def apply_polar_ring_uv(bm, tile_meters=7.2):
    """Curvature-aligned polar UV projection so panel lines wrap concentrically & radially."""
    uv_layer = bm.loops.layers.uv.get("UVMap") or bm.loops.layers.uv.new("UVMap")
    inv = 1.0 / tile_meters
    two_pi = 2.0 * math.pi
    for face in bm.faces:
        n = face.normal
        fc = face.calc_center_median()
        r_c = max(math.hypot(fc.x, fc.z), 0.25)
        th_c = math.atan2(fc.z, fc.x)
        rad_x, rad_z = fc.x / r_c, fc.z / r_c
        nr = abs(n.x * rad_x + n.z * rad_z)
        ny = abs(n.y)
        nt = abs(-n.x * rad_z + n.z * rad_x)

        if ny >= nr and ny >= nt:
            for loop in face.loops:
                co = loop.vert.co
                r_v = math.hypot(co.x, co.z)
                dth = math.atan2(co.z, co.x) - th_c
                if dth > math.pi:
                    dth -= two_pi
                elif dth < -math.pi:
                    dth += two_pi
                loop[uv_layer].uv = ((th_c + dth) * r_c * inv + 0.19, r_v * inv + 0.27)
        elif nr >= nt:
            for loop in face.loops:
                co = loop.vert.co
                dth = math.atan2(co.z, co.x) - th_c
                if dth > math.pi:
                    dth -= two_pi
                elif dth < -math.pi:
                    dth += two_pi
                loop[uv_layer].uv = ((th_c + dth) * r_c * inv + 0.19, (co.y + 3.17) * inv)
        else:
            for loop in face.loops:
                co = loop.vert.co
                r_v = math.hypot(co.x, co.z)
                loop[uv_layer].uv = (r_v * inv + 0.27, (co.y + 3.17) * inv)


def finalize_bmesh(
    bm, name, mat, col, smooth=True, sharp_angle_deg=34.0, parent=None, uv_tile_m=7.2,
):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if smooth and sharp_angle_deg is not None and sharp_angle_deg < 179.0:
        rad = math.radians(sharp_angle_deg)
        sharp_edges = [
            e for e in bm.edges
            if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > rad
        ]
        if sharp_edges:
            bmesh.ops.split_edges(bm, edges=sharp_edges)

    apply_polar_ring_uv(bm, tile_meters=uv_tile_m)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    if mat is not None:
        mesh.materials.append(mat)

    obj = bpy.data.objects.new(name, mesh)
    link_obj(obj, col)
    if parent is not None:
        obj.parent = parent
    return obj


class MeshBatcher:
    """High-speed BMesh batcher keeping draw-calls crisp while enabling thousands of micro-details."""

    def __init__(self, col, root, mats):
        self.col = col
        self.root = root
        self.mats = mats
        self.buckets = {}

    def _get_bm(self, group_name, mat_key, uv_tile_m=7.2):
        key = (group_name, mat_key)
        if key not in self.buckets:
            self.buckets[key] = (bmesh.new(), mat_key, uv_tile_m)
        return self.buckets[key][0]

    def _merge_temp(self, dst_bm, src_bm):
        bmesh.ops.recalc_face_normals(src_bm, faces=src_bm.faces)
        vmap = {v: dst_bm.verts.new(v.co) for v in src_bm.verts}
        for f in src_bm.faces:
            try:
                dst_bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                pass
        src_bm.free()

    def add_arc_profile(
        self, group_name, mat_key, profile_ry, th0_deg, th1_deg,
        segs=16, closed_loop=False, bevel=0.0, bevel_segs=1, uv_tile_m=7.2,
    ):
        dst = self._get_bm(group_name, mat_key, uv_tile_m)
        tmp = bmesh.new()
        th0 = math.radians(th0_deg)
        th1 = math.radians(th1_deg)
        n_rings = segs if closed_loop else segs + 1
        rings = []
        for i in range(n_rings):
            t = i / float(segs)
            th = th0 + (th1 - th0) * t
            rings.append([tmp.verts.new(polar_pt(r, th, y)) for (r, y) in profile_ry])
        n_p = len(profile_ry)
        span = n_rings if closed_loop else n_rings - 1
        for r_idx in range(span):
            r0 = rings[r_idx]
            r1 = rings[(r_idx + 1) % n_rings]
            for j in range(n_p):
                nj = (j + 1) % n_p
                try:
                    tmp.faces.new((r0[j], r0[nj], r1[nj], r1[j]))
                except ValueError:
                    pass
        if not closed_loop:
            try:
                tmp.faces.new(list(reversed(rings[0])))
            except ValueError:
                pass
            try:
                tmp.faces.new(rings[-1])
            except ValueError:
                pass
        bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
        if bevel > 0.0:
            sharp = [e for e in tmp.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > 0.42]
            if sharp:
                bmesh.ops.bevel(
                    tmp, geom=sharp, offset=bevel, offset_type="OFFSET",
                    segments=bevel_segs, profile=0.5, affect="EDGES", clamp_overlap=True,
                )
        self._merge_temp(dst, tmp)

    def add_ring_plate(
        self, group_name, mat_key, r_in, r_out, y_min, y_max, th0_deg, th1_deg,
        segs=None, bevel=0.02, chamfer_out=0.0, chamfer_in=0.0, closed_loop=False, uv_tile_m=7.2,
    ):
        arc = abs(th1_deg - th0_deg)
        if segs is None:
            segs = max(2, int(round(arc / 3.5)))
        if chamfer_out > 0.0 or chamfer_in > 0.0:
            co = min(chamfer_out, (r_out - r_in) * 0.42, (y_max - y_min) * 0.42)
            ci = min(chamfer_in, (r_out - r_in) * 0.42, (y_max - y_min) * 0.42)
            prof = []
            if ci > 1e-4:
                prof.extend([(r_in, y_min + ci), (r_in + ci, y_min)])
            else:
                prof.append((r_in, y_min))
            if co > 1e-4:
                prof.extend([(r_out - co, y_min), (r_out, y_min + co), (r_out, y_max - co), (r_out - co, y_max)])
            else:
                prof.extend([(r_out, y_min), (r_out, y_max)])
            if ci > 1e-4:
                prof.extend([(r_in + ci, y_max), (r_in, y_max - ci)])
            else:
                prof.append((r_in, y_max))
        else:
            prof = [(r_in, y_min), (r_out, y_min), (r_out, y_max), (r_in, y_max)]
        b = min(bevel, (r_out - r_in) * 0.28, (y_max - y_min) * 0.28) if bevel > 0.0 else 0.0
        self.add_arc_profile(
            group_name, mat_key, prof, th0_deg, th1_deg,
            segs=segs, closed_loop=closed_loop, bevel=b, bevel_segs=1, uv_tile_m=uv_tile_m,
        )

    def add_arc_tube(
        self, group_name, mat_key, r_center, y_center, tube_r, th0_deg, th1_deg,
        segs_arc=32, segs_tube=10, closed_loop=False, uv_tile_m=4.0,
    ):
        prof = [
            (
                r_center + tube_r * math.cos(2.0 * math.pi * k / segs_tube),
                y_center + tube_r * math.sin(2.0 * math.pi * k / segs_tube),
            )
            for k in range(segs_tube)
        ]
        self.add_arc_profile(
            group_name, mat_key, prof, th0_deg, th1_deg,
            segs=segs_arc, closed_loop=closed_loop, bevel=0.0, uv_tile_m=uv_tile_m,
        )

    def add_polar_box(
        self, group_name, mat_key, r, th_deg, y, size_rty,
        rot_local=(0.0, 0.0, 0.0), bevel=0.018, bevel_segs=1, uv_tile_m=7.2,
    ):
        dst = self._get_bm(group_name, mat_key, uv_tile_m)
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=1.0)
        sr, st, sy = size_rty
        for v in tmp.verts:
            v.co.x *= sr
            v.co.y *= sy
            v.co.z *= st
        if bevel > 0.0:
            b = min(bevel, min(sr, sy, st) * 0.35)
            if b > 1e-4:
                bmesh.ops.bevel(
                    tmp, geom=list(tmp.edges), offset=b, offset_type="OFFSET",
                    segments=bevel_segs, profile=0.5, affect="EDGES", clamp_overlap=True,
                )
        if any(abs(a) > 1e-6 for a in rot_local):
            bmesh.ops.transform(tmp, matrix=Euler(rot_local, "XYZ").to_matrix().to_4x4(), verts=tmp.verts)
        th = math.radians(th_deg)
        bmesh.ops.transform(tmp, matrix=polar_frame(th), verts=tmp.verts)
        bmesh.ops.translate(tmp, vec=polar_pt(r, th, y), verts=tmp.verts)
        self._merge_temp(dst, tmp)

    def add_polar_cylinder(
        self, group_name, mat_key, r, th_deg, y, radius1, depth,
        radius2=None, axis="R", segments=14, rot_local=(0.0, 0.0, 0.0), bevel=0.008, uv_tile_m=7.2,
    ):
        dst = self._get_bm(group_name, mat_key, uv_tile_m)
        tmp = bmesh.new()
        r2 = radius1 if radius2 is None else radius2
        bmesh.ops.create_cone(
            tmp, cap_ends=True, cap_tris=False, segments=segments,
            radius1=radius1, radius2=r2, depth=depth,
        )
        if bevel > 0.0 and radius1 > 1e-3 and r2 > 1e-3:
            b = min(bevel, min(radius1, r2) * 0.26, depth * 0.26)
            if b > 1e-4:
                sharp = [e for e in tmp.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > 0.60]
                if sharp:
                    bmesh.ops.bevel(
                        tmp, geom=sharp, offset=b, offset_type="OFFSET",
                        segments=1, profile=0.5, affect="EDGES", clamp_overlap=True,
                    )
        if axis == "R":
            bmesh.ops.transform(tmp, matrix=Euler((0.0, math.pi * 0.5, 0.0), "XYZ").to_matrix().to_4x4(), verts=tmp.verts)
        elif axis == "Y":
            bmesh.ops.transform(tmp, matrix=Euler((-math.pi * 0.5, 0.0, 0.0), "XYZ").to_matrix().to_4x4(), verts=tmp.verts)
        if any(abs(a) > 1e-6 for a in rot_local):
            bmesh.ops.transform(tmp, matrix=Euler(rot_local, "XYZ").to_matrix().to_4x4(), verts=tmp.verts)
        th = math.radians(th_deg)
        bmesh.ops.transform(tmp, matrix=polar_frame(th), verts=tmp.verts)
        bmesh.ops.translate(tmp, vec=polar_pt(r, th, y), verts=tmp.verts)
        self._merge_temp(dst, tmp)

    def add_beam_between(
        self, group_name, mat_key, p0, p1, wx, wy,
        bevel=0.008, cylindrical=False, segments=10, uv_tile_m=5.0,
    ):
        v0 = Vector(p0)
        v1 = Vector(p1)
        diff = v1 - v0
        length = diff.length
        if length < 1e-5:
            return
        mid = (v0 + v1) * 0.5
        z_axis = diff.normalized()
        ref = Vector((0.0, 1.0, 0.0)) if abs(z_axis.y) < 0.9 else Vector((1.0, 0.0, 0.0))
        x_axis = ref.cross(z_axis).normalized()
        y_axis = z_axis.cross(x_axis).normalized()
        rot_mat = Matrix((
            (x_axis.x, y_axis.x, z_axis.x, 0.0),
            (x_axis.y, y_axis.y, z_axis.y, 0.0),
            (x_axis.z, y_axis.z, z_axis.z, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ))
        dst = self._get_bm(group_name, mat_key, uv_tile_m)
        tmp = bmesh.new()
        if cylindrical:
            bmesh.ops.create_cone(
                tmp, cap_ends=True, cap_tris=False, segments=segments,
                radius1=wx, radius2=wy, depth=length,
            )
        else:
            bmesh.ops.create_cube(tmp, size=1.0)
            for v in tmp.verts:
                v.co.x *= wx
                v.co.y *= wy
                v.co.z *= length
            if bevel > 0.0:
                b = min(bevel, min(wx, wy, length) * 0.30)
                if b > 1e-4:
                    bmesh.ops.bevel(
                        tmp, geom=list(tmp.edges), offset=b, offset_type="OFFSET",
                        segments=1, profile=0.5, affect="EDGES", clamp_overlap=True,
                    )
        bmesh.ops.transform(tmp, matrix=rot_mat, verts=tmp.verts)
        bmesh.ops.translate(tmp, vec=mid, verts=tmp.verts)
        self._merge_temp(dst, tmp)

    def flush(self):
        created = []
        for (group_name, mat_key), (bm, mk, uv_tile_m) in self.buckets.items():
            if len(bm.verts) == 0:
                bm.free()
                continue
            obj = finalize_bmesh(
                bm, f"{group_name}__{mk}", self.mats[mk], self.col,
                smooth=True, sharp_angle_deg=34.0, parent=self.root, uv_tile_m=uv_tile_m,
            )
            created.append(obj)
        self.buckets.clear()
        return created


# ---------------------------------------------------------------------------
# 4. Collection 01: Outer Ring Structural Core & Luminous Multi-Tier Inner Cathedral Wall
# ---------------------------------------------------------------------------

def build_outer_ring_chassis(mats, col, root):
    """Monumental outer ring core & luminous light-grey concave inner cathedral wall (R_in = 5.48 m)."""
    b = MeshBatcher(col, root, mats)

    # Internal dark structural core backing (spans R = 6.08..9.68 m matching true monumental ring width!)
    core_profile = [
        (6.08, -2.35), (6.85, -3.12), (8.05, -3.52), (9.22, -3.38), (9.68, -2.55),
        (9.68,  2.55), (9.22,  3.38), (8.05,  3.52), (6.85,  3.12), (6.08,  2.35),
    ]
    b.add_arc_profile("Core_InternalBacking", "gunmetal", core_profile, 0.0, 360.0, segs=108, closed_loop=True)

    # Luminous aerospace-grey concave inner structural hull wall (R = 5.56..6.18 m!)
    inner_hull_prof = [
        (5.58, -2.12), (5.92, -2.56), (6.22, -2.42), (6.22, 2.42), (5.92, 2.56), (5.58, 2.12),
    ]
    b.add_arc_profile("InnerWall_PrimaryHull", "inner_grey", inner_hull_prof, 0.0, 360.0, segs=108, closed_loop=True)

    # Stepped inner deck terraces & concentric structural girders (R = 5.44..6.16 m)
    for y_g, h_g, r0, r1, mk in (
        (-2.34, 0.28, 5.66, 6.20, "armor_white"),
        (-1.82, 0.22, 5.54, 5.88, "inner_grey"),
        (-1.26, 0.18, 5.48, 5.80, "armor_slate"),
        (-0.62, 0.24, 5.50, 5.84, "inner_grey"),
        ( 0.00, 0.30, 5.44, 5.82, "armor_slate"),
        ( 0.62, 0.24, 5.50, 5.84, "inner_grey"),
        ( 1.26, 0.18, 5.48, 5.80, "armor_slate"),
        ( 1.82, 0.22, 5.54, 5.88, "inner_grey"),
        ( 2.34, 0.28, 5.66, 6.20, "armor_white"),
    ):
        b.add_ring_plate(
            "InnerWall_RingDecks", mk,
            r0, r1, y_g - h_g * 0.5, y_g + h_g * 0.5,
            0.0, 360.0, segs=96, bevel=0.012, closed_loop=True,
        )

    # Dense 10-pipe circumferential industrial conduit bundles wrapping the entire concave inner wall!
    for y_p, r_p, tr, mk in (
        (-2.06, 5.62, 0.055, "alloy_pipe"),  (2.06, 5.62, 0.055, "alloy_pipe"),
        (-1.54, 5.54, 0.048, "alloy_pipe"),  (1.54, 5.54, 0.048, "alloy_pipe"),
        (-1.42, 5.58, 0.032, "steel_trim"),  (1.42, 5.58, 0.032, "steel_trim"),
        (-0.92, 5.52, 0.052, "alloy_pipe"),  (0.92, 5.52, 0.052, "alloy_pipe"),
        (-0.30, 5.48, 0.045, "alloy_pipe"),  (0.30, 5.48, 0.045, "alloy_pipe"),
    ):
        b.add_arc_tube("InnerWall_PipeBundles", mk, r_p, y_p, tr, 0.0, 360.0, segs_arc=96, segs_tube=8, closed_loop=True)

    # 64 crisp architectural bulkhead rib frames + stepped inner knee buttresses
    for k in range(64):
        th = k * (360.0 / 64.0)
        if any(abs(((th - c + 180) % 360) - 180) < 6.5 for c in (45, 135, 225, 315)):
            continue
        is_major = (k % 4 == 0)
        w_t = 0.22 if is_major else 0.11
        r_ext = 5.42 if is_major else 5.50
        mk = "armor_white" if is_major else "inner_grey"
        b.add_polar_box("InnerWall_BulkheadRibs", mk, (r_ext + 5.98) * 0.5, th, 0.0, (5.98 - r_ext, w_t, 4.42), bevel=0.015)
        if is_major:
            for sy in (-1.0, 1.0):
                b.add_polar_box("InnerWall_DeckBrackets", "armor_white", 5.96, th, sy * 2.48, (0.64, 0.28, 0.54), bevel=0.018)
                b.add_polar_box("InnerWall_DeckBrackets", "gunmetal",    5.66, th, sy * 1.65, (0.28, 0.18, 0.42), bevel=0.012)

    # Segmented recessed cargo/hangar pockets & subtle golden-amber gallery lining tucked along concave inner wall
    for th0, th1, y_c, has_amber in (
        ( 58.0,  86.0, -1.15, True),   ( 58.0,  86.0,  1.15, True),
        ( 96.0, 124.0, -1.15, True),   ( 96.0, 124.0,  1.15, True),
        (152.0, 178.0,  0.00, False),
        (190.0, 214.0, -1.10, True),   (190.0, 214.0,  1.10, True),
        (242.0, 266.0, -1.15, True),   (242.0, 266.0,  1.15, True),
        (282.0, 304.0,  0.00, False),
        (328.0, 358.0, -1.10, True),   (328.0, 358.0,  1.10, True),
        ( 12.0,  34.0,  0.00, False),
    ):
        b.add_ring_plate("InnerWall_Alcoves", "cavity_dark", 5.58, 5.66, y_c - 0.34, y_c + 0.34, th0, th1, bevel=0.0)
        if has_amber:
            b.add_ring_plate("InnerWall_AmberLiners", "amber_foil",   5.56, 5.62, y_c - 0.22, y_c + 0.22, th0 + 1.5, th1 - 1.5, bevel=0.008)
            b.add_ring_plate("InnerWall_AmberLiners", "amber_window", 5.54, 5.59, y_c - 0.08, y_c + 0.08, th0 + 2.5, th1 - 2.5, bevel=0.005)
        n_div = max(3, int((th1 - th0) / 4.5))
        for i in range(1, n_div):
            ths = th0 + (th1 - th0) * (i / float(n_div))
            b.add_polar_box("InnerWall_Alcoves", "inner_grey", 5.56, ths, y_c, (0.14, 0.08, 0.72), bevel=0.006)

    b.flush()


# ---------------------------------------------------------------------------
# 5. Collection 02: Sweeping Off-White Aerospace Ceramic Outer Ring Armor Shell
# ---------------------------------------------------------------------------

def build_outer_ring_armor(mats, col, root):
    """Sculpted curved white ceramic hull plates with hairline seams & varied asymmetric rhythm."""
    b = MeshBatcher(col, root, mats)

    quadrants = [
        ("Top",    53.0, 127.0, [11.0, 15.0, 9.0, 16.0, 12.0, 11.0]),
        ("Left",  143.0, 217.0, [12.0, 14.0, 10.0, 16.0, 11.0, 11.0]),
        ("Bot",   233.0, 307.0, [10.0, 15.0, 13.0, 14.0, 12.0, 10.0]),
        ("Right", 323.0, 397.0, [13.0, 11.0, 16.0, 12.0, 10.0, 12.0]),
    ]

    # Exact architectural recessed openings (carefully placed to match ref1_tr.png & ref1_bl.png!)
    face_cutouts = [
        # Top quadrant (53..127)
        ("outer",  62.0,  73.0),   # 1:00 4-slat crisp white-ribbed cooling vent
        ("outer",  95.0, 110.0),   # 11:30 sleek angled dark hangar bay
        ("inner",  58.0,  89.0),   # 12:30-1:20 sleek long piped trench with golden lower trim
        ("inner", 104.0, 122.0),   # 11:00 inner recessed amber thermal bay
        # Left quadrant (143..217)
        ("outer", 147.0, 156.0),   # 10:00 small recessed dark vent
        ("outer", 191.0, 213.0),   # 8:00-8:40 deep vertical hangar bay with ochre-gold top/bottom beams!
        ("inner", 158.0, 174.0),   # 9:30 recessed machinery bay
        ("inner", 194.0, 214.0),   # 8:15 inner deck gallery
        # Bottom quadrant (233..307)
        ("outer", 244.0, 261.0),   # 6:30 iconic golden-louvered outer bay above dark intake
        ("outer", 264.0, 272.0),   # 6:00 small recessed intake
        ("inner", 242.0, 262.0),   # 6:30 piped inner bay with copper-amber ribbing
        ("inner", 278.0, 298.0),   # 5:30 recessed shadow trench
        # Right quadrant (323..397)
        ("outer", 334.0, 343.0),   # 4:00 crisp dark rectangular bay
        ("outer", 352.0, 359.0),   # 3:15 small recessed amber pocket (ref1_tr.png bottom right!)
        ("outer", 370.0, 378.0),   # 2:35 sharp dark rectangular port (ref1_tr.png right!)
        ("inner", 328.0, 358.0),   # 3:15-4:15 inner concave amber/machinery gallery
        ("inner", 374.0, 392.0),   # 2:00 inner trench
    ]

    def _split_spans(a0, a1, band_id):
        spans = [(a0, a1)]
        for bid, c0, c1 in face_cutouts:
            if bid != band_id:
                continue
            nxt = []
            for s0, s1 in spans:
                if c1 <= s0 or c0 >= s1:
                    nxt.append((s0, s1))
                else:
                    if s0 < c0:
                        nxt.append((s0, c0))
                    if c1 < s1:
                        nxt.append((c1, s1))
            spans = nxt
        return [(s0, s1) for (s0, s1) in spans if s1 - s0 > 2.0]

    for q_idx, (q_name, q0, q1, widths) in enumerate(quadrants):
        g_name = f"Armor_Quad_{q_name}"

        for sy in (-1.0, 1.0):
            # --- Tier 0: Inner Concave Lip Ring Terrace (R = 5.92..6.64 m, matching monumental Ref 1/2 ring thickness!) ---
            n_t0 = 6
            step_0 = (q1 - q0) / n_t0
            for i in range(n_t0):
                a0 = q0 + i * step_0 + 0.14
                a1 = q0 + (i + 1) * step_0 - 0.14
                mk = "inner_grey" if (i + q_idx) % 2 == 0 else "armor_white"
                prof0 = [
                    (5.90, sy * 2.38), (6.64, sy * 2.86), (6.64, sy * 3.16),
                    (6.28, sy * 2.94), (5.90, sy * 2.66),
                ]
                if sy < 0:
                    prof0 = list(reversed(prof0))
                b.add_arc_profile(g_name, mk, prof0, a0, a1, segs=max(3, int((a1 - a0) / 3.2)), bevel=0.020)

            # --- Tier 1: Mid-Inner Sculpted Beveled Terrace (R = 6.62..7.38 m) ---
            for s0, s1 in _split_spans(q0, q1, "inner"):
                n_sub = max(1, int(round((s1 - s0) / 14.0)))
                step = (s1 - s0) / n_sub
                for i in range(n_sub):
                    a0 = s0 + i * step + 0.14
                    a1 = s0 + (i + 1) * step - 0.14
                    if a1 <= a0 + 1.0:
                        continue
                    mk = "armor_white" if (i + q_idx) % 3 != 0 else "inner_grey"
                    prof = [
                        (6.62, sy * 2.84), (7.38, sy * 3.16), (7.38, sy * 3.52),
                        (6.98, sy * 3.36), (6.62, sy * 3.12),
                    ]
                    if sy < 0:
                        prof = list(reversed(prof))
                    b.add_arc_profile(g_name, mk, prof, a0, a1, segs=max(3, int((a1 - a0) / 3.0)), bevel=0.022)

            # --- Tier 2: Sweeping Main Crown Ceramic Hull (R = 7.36..9.02, asymmetric panel rhythm, hairline 0.12 deg seams!) ---
            cur = q0
            for i, w_deg in enumerate(widths):
                a0 = cur + 0.12
                a1 = min(cur + w_deg, q1) - 0.12
                cur += w_deg
                if a1 <= a0 + 1.0:
                    continue
                bump = 0.045 if (i % 2 == 0) else 0.0
                mk = "armor_bright" if (i % 3 == 1) else "armor_white"
                # Smoothly arched 6-point cross-section for sculpted orbital ring curvature
                prof = [
                    (7.36, sy * 3.18), (9.02, sy * 3.18),
                    (9.02, sy * (3.66 + bump)), (8.54, sy * (3.82 + bump)),
                    (7.82, sy * (3.80 + bump)), (7.36, sy * (3.48 + bump * 0.5)),
                ]
                if sy < 0:
                    prof = list(reversed(prof))
                b.add_arc_profile(g_name, mk, prof, a0, a1, segs=max(3, int((a1 - a0) / 2.8)), bevel=0.024)

                # Subtle overlapping raised composite shingle & micro-ribs on select plates
                if i in (0, 2, 4):
                    sa0, sa1 = a0 + 1.4, a1 - 1.4
                    if sa1 > sa0 + 2.5:
                        b.add_ring_plate(
                            g_name, "armor_bright" if i == 2 else "armor_white",
                            7.74, 8.64,
                            sy * (3.72 + bump) if sy > 0 else sy * (3.88 + bump),
                            sy * (3.88 + bump) if sy > 0 else sy * (3.72 + bump),
                            sa0, sa1, bevel=0.018, chamfer_out=0.04, chamfer_in=0.04,
                        )

            # --- Tier 3: Outer Chamfered Shoulder Armor (R = 9.00..9.98, hairline seams!) ---
            for s0, s1 in _split_spans(q0, q1, "outer"):
                n_sub = max(1, int(round((s1 - s0) / 14.0)))
                step = (s1 - s0) / n_sub
                for i in range(n_sub):
                    a0 = s0 + i * step + 0.14
                    a1 = s0 + (i + 1) * step - 0.14
                    if a1 <= a0 + 1.0:
                        continue
                    bump = 0.035 if (i % 2 == 1) else 0.0
                    mk = "armor_white" if (i % 3 != 2) else "armor_bright"
                    prof = [
                        (9.00, sy * 3.10), (9.68, sy * 2.50),
                        (9.98 + bump, sy * 2.50), (9.94 + bump, sy * 3.00),
                        (9.46 + bump * 0.5, sy * 3.56), (9.00, sy * 3.64),
                    ]
                    if sy < 0:
                        prof = list(reversed(prof))
                    b.add_arc_profile(g_name, mk, prof, a0, a1, segs=max(3, int((a1 - a0) / 3.0)), bevel=0.024)

        # --- Tier 4: Outer Equatorial Rim Barrel Shell (R = 9.66..10.06, Y in [-2.54, +2.54]) ---
        # Explicit cutouts matching ref3_top.png & ref3_bot.png:
        #   - Radiator grille center cutouts at 322..333 deg (-38..-27) & 150..161 deg
        #   - Compact recessed shoulder amber window alcoves at 344..351 deg (-16..-9) & 171..178 deg & 97..104 deg & 247..254 deg
        def _split_rim(a0, a1, cuts):
            spans = [(a0, a1)]
            for c0, c1 in cuts:
                nxt = []
                for s0, s1 in spans:
                    if c1 <= s0 or c0 >= s1:
                        nxt.append((s0, s1))
                    else:
                        if s0 < c0:
                            nxt.append((s0, c0))
                        if c1 < s1:
                            nxt.append((c1, s1))
                spans = nxt
            return [(s0, s1) for (s0, s1) in spans if s1 - s0 > 1.5]

        # Center track (Y in [-0.90, +0.90]): LONG smooth unbroken central hatch panel in Image 3 zone (344..386 deg = -16..+26)!
        center_cuts = [(322.0, 333.0), (150.0, 161.0)]
        for s0, s1 in _split_rim(q0, q1, center_cuts):
            if q_name == "Right" and s0 >= 332.5:
                # Exact Image 3 smooth belly shield (333..344) + iconic long smooth central panel (344..385) + upper cap (385..397)!
                for pa0, pa1, r_top, mk in (
                    (333.2, 343.5, 10.06, "armor_bright"),  # smooth curved lower belly shield above grille!
                    (343.8, 385.5, 10.02, "armor_bright"),  # long sleek recessed smooth central hatch between twin rails!
                    (385.8, 396.8, 10.10, "armor_white"),   # upper transition fairing into spire base!
                ):
                    b.add_ring_plate(g_name, mk, 9.66, r_top, -0.88, 0.88, pa0, pa1, bevel=0.026, chamfer_out=0.05)
            else:
                n_sub = max(1, int(round((s1 - s0) / 18.0)))
                step = (s1 - s0) / n_sub
                for i in range(n_sub):
                    a0 = s0 + i * step + 0.14
                    a1 = s0 + (i + 1) * step - 0.14
                    if a1 <= a0 + 1.0:
                        continue
                    b.add_ring_plate(
                        g_name, "armor_bright" if i % 2 == 0 else "armor_white",
                        9.66, 10.03 if i % 2 == 0 else 9.99, -0.88, 0.88, a0, a1,
                        bevel=0.024, chamfer_out=0.05,
                    )

        # Flanking shoulder belts (Y in [-2.52, -1.04] and [+1.04, +2.52])
        shoulder_cuts = [(344.0, 351.0), (171.0, 178.0), (97.0, 104.0), (247.0, 254.0)]
        for sy in (-1.0, 1.0):
            y0, y1 = (1.04, 2.52) if sy > 0 else (-2.52, -1.04)
            for s0, s1 in _split_rim(q0, q1, shoulder_cuts):
                n_sub = max(1, int(round((s1 - s0) / 16.0)))
                step = (s1 - s0) / n_sub
                for i in range(n_sub):
                    a0 = s0 + i * step + 0.14
                    a1 = s0 + (i + 1) * step - 0.14
                    if a1 <= a0 + 1.0:
                        continue
                    b.add_ring_plate(
                        g_name, "armor_white", 9.66, 10.04 if (i + q_idx) % 2 == 0 else 9.99,
                        y0, y1, a0, a1, bevel=0.022, chamfer_out=0.07,
                    )

    # Extra crisp face-mounted micro-details matching ref1_tr.png & ref1_bl.png:
    # 1. Twin recessed rectangular roof hatches right at 12:00 (78..88 deg)
    for sy in (-1.0, 1.0):
        for th_h in (80.5, 86.2):
            b.add_polar_box("Detail_CrownHatches", "inner_grey",   9.18, th_h, sy * 3.60, (0.76, 0.68, 0.16), bevel=0.016)
            b.add_polar_box("Detail_CrownHatches", "armor_bright", 9.18, th_h, sy * 3.66, (0.58, 0.50, 0.10), bevel=0.014)
        # Small raised horizontal ridge bar at 2:10 (30 deg, clearly visible in ref1_tr.png!)
        b.add_polar_box("Detail_FaceGreebles", "inner_grey", 8.65, 29.0, sy * 3.84, (0.18, 1.05, 0.14), bevel=0.012)
        # Signature 9:30 recessed square machinery window (163 deg, ref1_bl.png top-mid!)
        b.add_polar_box("Detail_LeftWindow", "cavity_dark", 8.20, 163.5, sy * 3.74, (0.98, 1.05, 0.16), bevel=0.012)
        b.add_polar_box("Detail_LeftWindow", "inner_grey",  8.20, 163.5, sy * 3.78, (0.86, 0.92, 0.10), bevel=0.01)
        for k_v in (-0.30, -0.10, 0.10, 0.30):
            b.add_polar_box("Detail_LeftWindow", "steel_trim", 8.20 + k_v, 163.5, sy * 3.82, (0.06, 0.86, 0.08), bevel=0.005)
        b.add_polar_box("Detail_LeftWindow", "gunmetal", 8.20, 163.5, sy * 3.83, (0.88, 0.12, 0.08), bevel=0.006)
        # Fine micro grab-rails, sensor blisters & surface conduit runs across the white flanks!
        for th_g, r_g in ((118.0, 8.35), (178.0, 8.10), (284.0, 8.25), (300.0, 8.40), (8.0, 8.35), (364.0, 8.55)):
            b.add_polar_box("Detail_FaceGreebles", "inner_grey", r_g, th_g, sy * 3.84, (0.34, 0.85, 0.12), bevel=0.012)
            b.add_polar_box("Detail_FaceGreebles", "cavity_dark", r_g, th_g, sy * 3.87, (0.14, 0.56, 0.07), bevel=0.006)

    b.flush()


# ---------------------------------------------------------------------------
# 6. Collection 03: Four Monumental Diagonal Structural Collar Cradles
# ---------------------------------------------------------------------------

def build_diagonal_collar_nodes(mats, col, root):
    """Build the 4 sculpted mechanical bridge-cradles at 45, 135, 225, 315 deg (from ref1_hub/tr/bl)."""
    b = MeshBatcher(col, root, mats)

    for c_name, th_c in (
        ("SpireCollar_45",   45.0),
        ("Machinery_135",   135.0),
        ("BoomCollar_225",  225.0),
        ("PodCollar_315",   315.0),
    ):
        # 1. Deep sunken industrial core cradle spanning the collar gap (R = 5.56..9.84 m)
        core_prof = [
            (5.56, -2.24), (6.85, -3.18), (8.35, -3.48), (9.52, -3.12), (9.84, -2.35),
            (9.84,  2.35), (9.52,  3.12), (8.35,  3.48), (6.85,  3.18), (5.56,  2.24),
        ]
        b.add_arc_profile(c_name, "gunmetal", core_prof, th_c - 8.2, th_c + 8.2, segs=4, bevel=0.018)

        # 2. Heavy chamfered white bulkhead framing walls bounding both sides of the collar (th_c +/- 7.2 deg)
        flange_prof = [
            (5.60, -2.40), (6.95, -3.44), (8.45, -3.90), (9.65, -3.52), (10.18, -2.56),
            (10.18, 2.56), (9.65,  3.52), (8.45,  3.90), (6.95,  3.44), (5.60,   2.40),
        ]
        for s_th in (-1.0, 1.0):
            t_mid = th_c + s_th * 7.1
            b.add_arc_profile(c_name, "armor_bright", flange_prof, t_mid - 1.35, t_mid + 1.35, segs=2, bevel=0.028)

        # 3. Sculpted INWARD-PROJECTING WHITE DOCKING CLAW POD with recessed rectangular radiator grille!
        #    Positioned cleanly at R = 5.15..6.05 m to match the tightened monumental inner opening!
        for sy in (-1.0, 1.0):
            b.add_polar_box(c_name, "armor_bright", 5.62, th_c, sy * 1.56, (1.12, 1.72, 1.08), bevel=0.032)
            for dt_ck in (-4.8, 4.8):
                b.add_polar_box(c_name, "armor_white", 5.56, th_c + dt_ck, sy * 1.62, (1.18, 0.36, 1.16), bevel=0.024)
            b.add_polar_box(c_name, "cavity_dark",  5.58, th_c, sy * 2.08, (0.64, 1.08, 0.14), bevel=0.01)
            for k_l in range(-2, 3):
                b.add_polar_box(c_name, "inner_grey", 5.58, th_c + k_l * 1.25, sy * 2.11, (0.56, 0.08, 0.12), bevel=0.005)
            b.add_polar_box(c_name, "armor_slate", 5.08, th_c, sy * 1.05, (0.34, 1.12, 0.72), bevel=0.018)
            b.add_polar_box(c_name, "gunmetal",    5.02, th_c, 0.0,       (0.42, 0.96, 1.32), bevel=0.018)

            # 4. Sunken Mid-Ring Mechanical Trench (R = 6.20..9.55): Layered multi-scale industrial machinery
            b.add_ring_plate(c_name, "cavity_dark", 6.20, 9.45,
                             sy * 3.12 if sy > 0 else sy * 3.40,
                             sy * 3.40 if sy > 0 else sy * 3.12,
                             th_c - 5.6, th_c + 5.6, segs=3, bevel=0.0)
            b.add_polar_box(c_name, "armor_bright", 9.15, th_c, sy * 3.48, (0.95, 1.38, 0.36), bevel=0.024)
            b.add_polar_box(c_name, "inner_grey",   8.10, th_c - 1.8, sy * 3.52, (1.02, 0.56, 0.34), bevel=0.02)
            b.add_polar_box(c_name, "armor_white",  8.10, th_c + 1.8, sy * 3.54, (0.88, 0.48, 0.38), bevel=0.02)
            b.add_polar_box(c_name, "armor_slate",  6.88, th_c, sy * 3.32, (0.84, 1.48, 0.32), bevel=0.02)
            for r_act, y_act in ((7.48, 3.44), (8.62, 3.48)):
                b.add_polar_cylinder(c_name, "alloy_pipe", r_act, th_c, sy * y_act, 0.145, 1.85, axis="T", segments=12, bevel=0.012)
                for d_ring in (-2.2, 0.0, 2.2):
                    b.add_polar_cylinder(c_name, "gunmetal", r_act, th_c + d_ring, sy * y_act, 0.195, 0.22, axis="T", segments=12, bevel=0.012)
            for r_rod, y_off, tr in (
                (6.48, 3.18, 0.055), (7.15, 3.36, 0.045), (7.95, 3.42, 0.048),
                (8.26, 3.44, 0.040), (8.94, 3.36, 0.052), (9.32, 3.22, 0.045),
            ):
                b.add_arc_tube(c_name, "alloy_pipe" if tr > 0.046 else "steel_trim", r_rod, sy * y_off, tr, th_c - 6.2, th_c + 6.2, segs_arc=6, segs_tube=8)
            for k_hx in range(5):
                b.add_polar_box(c_name, "steel_trim", 7.75 + k_hx * 0.14, th_c, sy * 3.48, (0.06, 0.88, 0.16), bevel=0.004)

            b.add_polar_box(c_name, "amber_foil", 6.32, th_c - 4.0, sy * 2.86, (0.38, 0.48, 0.18), bevel=0.01)

        # 5. Equatorial outer rim bridge ribs & pipes across the collar
        for d_th in (-2.8, 0.0, 2.8):
            b.add_polar_box(c_name, "armor_white" if d_th == 0 else "inner_grey", 9.94, th_c + d_th, 0.0, (0.52, 0.38, 5.10), bevel=0.024)
        for y_rib in (-2.00, -1.20, 0.0, 1.20, 2.00):
            b.add_arc_tube(c_name, "alloy_pipe", 9.88, y_rib, 0.075, th_c - 6.2, th_c + 6.2, segs_arc=6, segs_tube=8)

        # 6. Extra exposed louvered cooling grill inside 135 deg collar (prominent in Image 1 top-left!)
        if th_c == 135.0:
            for sy in (-1.0, 1.0):
                for k_sl in range(6):
                    r_sl = 7.25 + k_sl * 0.36
                    b.add_polar_box(c_name, "inner_grey", r_sl, th_c, sy * 3.56, (0.11, 1.45, 0.16), bevel=0.008)
                b.add_polar_box(c_name, "amber_foil", 7.12, th_c + 3.2, sy * 3.22, (0.32, 0.56, 0.14), bevel=0.01)

    b.flush()


# ---------------------------------------------------------------------------
# 7. Collection 04: Exact Edge-On Rim Architecture (from ref3_top.png & ref3_bot.png)
# ---------------------------------------------------------------------------

def build_equatorial_rim_details(mats, col, root):
    """Precision match to Image 3 (ref3_top.png & ref3_bot.png) equatorial rim architecture."""
    b = MeshBatcher(col, root, mats)

    # 1. Twin Longitudinal Conduit Rails on Image 3 Face (342..386 deg = -18..+26 deg):
    #    TERMINATE CLEANLY into sculpted rounded white bracket hoods at top (+26 deg) and bottom (-18 deg)!
    for sy in (-1.0, 1.0):
        # Iconic smooth uninterrupted twin rails flanking the clean central recessed hatch (Image 3!)
        b.add_arc_tube("Rim_HeroTwinRails", "armor_bright", 10.08, sy * 0.96, 0.105, 342.0, 386.5, segs_arc=28, segs_tube=12)
        # Upper rounded-chamfer rail termination shoulder brackets + flush white deck fill (zero black gap slit!)
        b.add_polar_box("Rim_HeroTwinRails", "armor_bright", 10.12, 386.5, sy * 0.96, (0.34, 0.56, 0.40), bevel=0.04)
        b.add_ring_plate("Rim_HeroTwinRails", "armor_white", 9.72, 10.06, sy * 0.84 if sy > 0 else sy * 1.12, sy * 1.12 if sy > 0 else sy * 0.84, 385.0, 396.5, segs=4, bevel=0.016)
        # Lower rounded-chamfer rail termination socket shoes (just below shoulder windows in ref3_bot.png!)
        b.add_polar_box("Rim_HeroTwinRails", "armor_bright", 10.10, 342.0, sy * 0.96, (0.32, 0.46, 0.38), bevel=0.035)
        b.add_polar_box("Rim_HeroTwinRails", "inner_grey",   10.06, 341.2, sy * 0.96, (0.22, 0.24, 0.44), bevel=0.02)
    # Sculpted rounded-bevel top bridge hood spanning between the twin rail caps (exact ref3_top.png landmark!)
    b.add_ring_plate("Rim_HeroTwinRails", "armor_bright", 9.96, 10.22, -0.96, 0.96, 385.5, 390.5, segs=3, bevel=0.04, chamfer_out=0.08)

    # Secondary structural conduit rails on the OTHER three quadrants (Top, Left, Bottom)
    for a0, a1 in ((54.0, 126.0), (144.0, 216.0), (234.0, 306.0)):
        for sy in (-1.0, 1.0):
            b.add_arc_tube("Rim_QuadrantRails", "alloy_pipe", 10.07, sy * 0.96, 0.095, a0, a1, segs_arc=32, segs_tube=10)
            for th_cl in (a0 + 8.0, 0.5 * (a0 + a1), a1 - 8.0):
                b.add_polar_box("Rim_QuadrantRails", "armor_bright", 10.08, th_cl, sy * 0.96, (0.26, 0.32, 0.28), bevel=0.02)

    # 2. COMPACT SLEEK DEEP-RECESSED AMBER SHOULDER WINDOW ALCOVES (exact ref3_bot.png proportions!)
    # Placed at 347.5 deg (-12.5 deg, right below central smooth panel in ref3_bot.png!), plus 174.5, 100.5, 250.5 deg
    for th_w in (347.5, 174.5, 100.5, 250.5):
        for sy in (-1.0, 1.0):
            yc = sy * 1.72
            # Deep dark shadow pocket backplate (r_outer = 9.72)
            b.add_polar_box("Rim_ShoulderAlcoves", "cavity_dark", 9.64, th_w, yc, (0.16, 1.18, 1.38), bevel=0.01)
            # Outer shadowed cheek recess (dark outer corner like ref3_bot.png!)
            b.add_polar_box("Rim_ShoulderAlcoves", "dark_machinery", 9.76, th_w, yc + sy * 0.38, (0.18, 1.06, 0.42), bevel=0.01)
            # Compact recessed warm golden-amber twin glass panes tucked cleanly toward the inner edge!
            for dy_p in (-0.18, 0.14):
                b.add_polar_box("Rim_ShoulderWindows", "amber_window", 9.79, th_w, yc - sy * 0.20 + dy_p, (0.10, 0.72, 0.24), bevel=0.008)
            # Thin crisp dark vertical mullion splitting the twin panes
            b.add_polar_box("Rim_ShoulderAlcoves", "steel_trim", 9.83, th_w, yc - sy * 0.22, (0.12, 0.78, 0.055), bevel=0.005)
            # 4-sided hollow beveled armor frame + prominent overhanging sculpted white brow hood!
            b.add_polar_box("Rim_ShoulderHoods", "armor_bright", 10.04, th_w + 3.8, yc, (0.36, 0.28, 1.48), bevel=0.026)
            b.add_polar_box("Rim_ShoulderHoods", "inner_grey",   9.94,  th_w - 3.6, yc, (0.28, 0.24, 1.46), bevel=0.022)
            b.add_polar_box("Rim_ShoulderHoods", "gunmetal",     9.88,  th_w, yc + sy * 0.66, (0.26, 1.18, 0.14), bevel=0.012)

    # 3. EXACT LOWER RADIATOR LOUVER GRILLE WITH CURVED U-PIPE LOOPS & ASYMMETRIC HANGING RODS (ref3_bot.png!)
    for th_g in (327.5, 155.5):
        # Deep shadow housing
        b.add_polar_box("Rim_RadiatorGrilles", "cavity_dark", 9.58, th_g, 0.0, (0.48, 1.80, 1.72), bevel=0.012)
        # Upper & lower sculpted white cowl lips framing the grille
        b.add_polar_box("Rim_RadiatorGrilles", "armor_bright", 10.02, th_g + 5.2, 0.0, (0.46, 0.36, 2.05), bevel=0.028)
        b.add_polar_box("Rim_RadiatorGrilles", "armor_bright", 10.00, th_g - 5.2, 0.0, (0.44, 0.34, 2.05), bevel=0.026)
        # 11 razor-crisp vertical dark steel radiator fins
        for i_fin in range(-5, 6):
            b.add_polar_box("Rim_RadiatorGrilles", "steel_trim", 9.82, th_g, i_fin * 0.132, (0.34, 1.42, 0.038), bevel=0.005)
        # Distinctive flanking twin curved horizontal U-pipe manifold loops on left & right of the grille (ref3_bot.png!)
        for sy in (-1.0, 1.0):
            # Inner vertical manifold bar
            b.add_polar_cylinder("Rim_RadiatorPipes", "alloy_pipe", 9.96, th_g, sy * 0.88, 0.062, 1.48, axis="T", segments=10, bevel=0.006)
            # Twin horizontal manifold tubes extending outward to Y = +/- 1.55
            for d_th in (-2.0, 2.0):
                b.add_polar_cylinder("Rim_RadiatorPipes", "alloy_pipe", 9.98, th_g + d_th, sy * 1.24, 0.056, 0.78, axis="Y", segments=10, bevel=0.006)
            # Outer curved vertical U-loop bridge connecting upper & lower horizontal pipes
            b.add_polar_cylinder("Rim_RadiatorPipes", "alloy_pipe", 9.98, th_g, sy * 1.60, 0.058, 0.80, axis="T", segments=10, bevel=0.006)
            # Small recessed dark flank vent port on outer left & right shoulders (exact ref3_bot.png detail!)
            b.add_polar_box("Rim_RadiatorGrilles", "cavity_dark", 9.94, th_g - 1.5, sy * 2.18, (0.28, 0.72, 0.56), bevel=0.012)
            b.add_polar_box("Rim_RadiatorGrilles", "inner_grey",  9.99, th_g + 0.8, sy * 2.18, (0.14, 0.16, 0.62), bevel=0.01)
        # Signature asymmetric pair of vertical manifold probe rods overhanging the grille edge (ref3_bot.png!)
        b.add_polar_cylinder("Rim_RadiatorPipes", "armor_bright", 10.08, th_g - 2.6, -0.46, 0.052, 1.45, axis="T", segments=10, bevel=0.006)
        b.add_polar_cylinder("Rim_RadiatorPipes", "armor_bright", 10.08, th_g - 1.6,  0.34, 0.048, 1.02, axis="T", segments=10, bevel=0.006)

    # 4. Crisp recessed dark side port windows along outer shoulder edges (visible along left/right margins of ref3_top.png!)
    for th_p in (360.0, 372.0, 384.0, 62.0, 74.0, 114.0, 190.0, 204.0, 276.0, 290.0):
        for sy in (-1.0, 1.0):
            b.add_polar_box("Rim_SidePorts", "cavity_dark", 9.96, th_p, sy * 2.48, (0.24, 0.92, 0.24), bevel=0.01)
            b.add_polar_box("Rim_SidePorts", "inner_grey",  9.98, th_p, sy * 2.48, (0.14, 0.96, 0.06), bevel=0.006)

    b.flush()


# ---------------------------------------------------------------------------
# 8. Collection 05: Reference-Faithful Recessed Technical Bays & Thermal Panels
# ---------------------------------------------------------------------------

def build_recessed_bays_and_amber_galleries(mats, col, root):
    """Authentic shadowed recessed mechanical bays, crisp white louver vents & matte ochre-gold panels."""
    b = MeshBatcher(col, root, mats)

    def add_face_bay(th0, th1, r_in, r_out, y_depth, style="machinery", n_slats=5):
        r_mid = 0.5 * (r_in + r_out)
        r_span = r_out - r_in
        for sy in (-1.0, 1.0):
            y0, y1 = (y_depth - 0.16, y_depth) if sy > 0 else (-y_depth, -(y_depth - 0.16))
            b.add_ring_plate("Bays_ShadowBacking", "cavity_dark", r_in, r_out, y0, y1, th0, th1, bevel=0.0)
            for th_lip in (th0 + 0.3, th1 - 0.3):
                b.add_polar_box("Bays_Frames", "inner_grey", r_mid, th_lip, sy * (y_depth + 0.06), (r_span + 0.06, 0.12, 0.20), bevel=0.01)

            if style == "white_louver":
                # 1:00 4-slat crisp white-ribbed cooling vent over recessed grey shadow slots (ref1_tr.png!)
                for i in range(n_slats):
                    rr = r_in + (i + 0.5) * (r_span / float(n_slats))
                    ya0, ya1 = (y_depth + 0.04, y_depth + 0.22) if sy > 0 else (-(y_depth + 0.22), -(y_depth + 0.04))
                    b.add_ring_plate("Bays_WhiteLouvers", "armor_white", rr - 0.065, rr + 0.065, ya0, ya1, th0 + 0.6, th1 - 0.6, bevel=0.01)
                b.add_polar_box("Bays_Frames", "inner_grey", r_mid, 0.5 * (th0 + th1), sy * (y_depth + 0.12), (r_span, 0.14, 0.18), bevel=0.01)

            elif style == "vertical_amber_hangar":
                # 8:00-8:40 iconic deep dark vertical hangar bay framed by warm ochre-gold top/bottom beams (ref1_bl.png!)
                # Deep shadowed blue-grey interior wall + internal ribs
                ya0, ya1 = (y_depth - 0.02, y_depth + 0.08) if sy > 0 else (-(y_depth + 0.08), -(y_depth - 0.02))
                b.add_ring_plate("Bays_HangarBack", "hub_blue_dark", r_in + 0.08, r_out - 0.08, ya0, ya1, th0 + 0.8, th1 - 0.8, bevel=0.0)
                # Ochre-gold structural header & sill beams framing the bay (exact ref1_bl.png look!)
                for th_b in (th0 + 1.2, 0.5 * (th0 + th1), th1 - 1.2):
                    b.add_polar_box("Bays_AmberBeams", "amber_foil", r_mid, th_b, sy * (y_depth + 0.18), (r_span - 0.06, 0.26, 0.22), bevel=0.012)
                b.add_arc_tube("Bays_Pipes", "alloy_pipe", r_in + r_span * 0.35, sy * (y_depth + 0.10), 0.045, th0 + 0.8, th1 - 0.8, segs_arc=8, segs_tube=8)
                b.add_arc_tube("Bays_Pipes", "steel_trim", r_in + r_span * 0.68, sy * (y_depth + 0.10), 0.042, th0 + 0.8, th1 - 0.8, segs_arc=8, segs_tube=8)

            elif style == "amber_louver_bay":
                # 6:30 prominent ochre-gold louvered top header over deep shadowed dark intake slot (ref1_bl.png bottom!)
                ya0, ya1 = (y_depth + 0.04, y_depth + 0.18) if sy > 0 else (-(y_depth + 0.18), -(y_depth + 0.04))
                # Upper half: ochre-gold ribbed thermal panel; lower half: deep recessed dark slot!
                b.add_ring_plate("Bays_AmberPanels", "amber_foil", r_in + r_span * 0.48, r_out - 0.08, ya0, ya1, th0 + 0.7, th1 - 0.7, bevel=0.012)
                for i in range(1, n_slats):
                    th_s = th0 + (th1 - th0) * (i / float(n_slats))
                    b.add_polar_box("Bays_Frames", "steel_trim", r_mid + r_span * 0.20, th_s, sy * (y_depth + 0.19), (r_span * 0.48, 0.08, 0.12), bevel=0.006)
                b.add_arc_tube("Bays_Pipes", "alloy_pipe", r_in + r_span * 0.25, sy * (y_depth + 0.08), 0.045, th0 + 0.7, th1 - 0.7, segs_arc=8, segs_tube=8)

            elif style == "piped_trench":
                # 12:30-1:20 & 6:30 sleek long recessed inner deck trench with silver pipes & thin golden lip (ref1_tr.png!)
                for r_f, mk, tr in ((0.30, "alloy_pipe", 0.048), (0.55, "steel_trim", 0.040), (0.76, "alloy_pipe", 0.036)):
                    b.add_arc_tube("Bays_Pipes", mk, r_in + r_span * r_f, sy * (y_depth + 0.10), tr, th0 + 0.6, th1 - 0.6, segs_arc=12, segs_tube=8)
                # Thin golden-ochre deck edge trim strip
                ya0, ya1 = (y_depth + 0.06, y_depth + 0.15) if sy > 0 else (-(y_depth + 0.15), -(y_depth + 0.06))
                b.add_ring_plate("Bays_AmberPanels", "amber_foil", r_in + 0.06, r_in + 0.20, ya0, ya1, th0 + 1.5, th1 - 1.5, bevel=0.006)
                for i in range(1, n_slats):
                    th_s = th0 + (th1 - th0) * (i / float(n_slats))
                    b.add_polar_box("Bays_Frames", "inner_grey", r_mid, th_s, sy * (y_depth + 0.14), (r_span - 0.06, 0.12, 0.16), bevel=0.008)

            elif style == "amber_pocket":
                # 3:15 deeply recessed warm ochre observation bay with dark brow hood & horizontal mullion (ref1_tr.png!)
                ya0, ya1 = (y_depth - 0.04, y_depth + 0.06) if sy > 0 else (-(y_depth + 0.06), -(y_depth - 0.04))
                b.add_ring_plate("Bays_AmberPanels", "amber_foil", r_in + 0.14, r_out - 0.14, ya0, ya1, th0 + 1.1, th1 - 1.1, bevel=0.008)
                yw0, yw1 = (y_depth + 0.03, y_depth + 0.09) if sy > 0 else (-(y_depth + 0.09), -(y_depth + 0.03))
                b.add_ring_plate("Bays_AmberPanels", "amber_window", r_in + 0.22, r_mid + 0.04, yw0, yw1, th0 + 1.6, th1 - 1.6, bevel=0.005)
                b.add_polar_box("Bays_Frames", "steel_trim", r_mid, 0.5 * (th0 + th1), sy * (y_depth + 0.13), (r_span - 0.04, 0.09, 0.14), bevel=0.005)
                b.add_arc_tube("Bays_Frames", "dark_machinery", r_mid, sy * (y_depth + 0.14), 0.045, th0 + 0.6, th1 - 0.6, segs_arc=6, segs_tube=6)

            else:  # "machinery"
                for r_f, mk in ((0.28, "alloy_pipe"), (0.54, "steel_trim"), (0.78, "alloy_pipe")):
                    b.add_arc_tube("Bays_Pipes", mk, r_in + r_span * r_f, sy * (y_depth + 0.09), 0.048, th0 + 0.6, th1 - 0.6, segs_arc=8, segs_tube=8)
                for i in range(n_slats):
                    th_s = th0 + (th1 - th0) * ((i + 0.5) / float(n_slats))
                    b.add_polar_box("Bays_Machinery", "gunmetal", r_mid, th_s, sy * (y_depth + 0.12), (r_span * 0.68, 0.18, 0.18), bevel=0.012)

    # Outer shoulder face cutouts
    add_face_bay( 62.0,  73.0, 9.02, 9.84, 3.06, style="white_louver",          n_slats=4)  # 1:00 4-slat white vent
    add_face_bay( 95.0, 110.0, 9.02, 9.84, 3.06, style="machinery",             n_slats=4)  # 11:30 dark bay
    add_face_bay(147.0, 156.0, 9.02, 9.84, 3.06, style="machinery",             n_slats=3)  # 10:00 dark recess
    add_face_bay(191.0, 213.0, 9.02, 9.84, 3.06, style="vertical_amber_hangar", n_slats=4)  # 8:00-8:40 hangar bay
    add_face_bay(244.0, 261.0, 9.02, 9.84, 3.06, style="amber_louver_bay",      n_slats=6)  # 6:30 golden-louver bay
    add_face_bay(264.0, 272.0, 9.02, 9.84, 3.06, style="machinery",             n_slats=3)  # 6:00 dark bay
    add_face_bay(334.0, 343.0, 9.02, 9.84, 3.06, style="machinery",             n_slats=3)  # 4:00 dark bay
    add_face_bay(352.0, 359.0, 9.02, 9.84, 3.06, style="amber_pocket",          n_slats=2)  # 3:15 amber pocket
    add_face_bay(370.0, 378.0, 9.02, 9.84, 3.06, style="machinery",             n_slats=3)  # 2:35 sharp dark port

    # Inner terrace cutouts (placed cleanly at R = 6.64..7.36 m above the new Tier 0 inner lip!)
    add_face_bay( 58.0,  89.0, 6.64, 7.36, 2.98, style="piped_trench", n_slats=6)      # 12:30-1:20 piped trench
    add_face_bay(104.0, 122.0, 6.64, 7.36, 2.98, style="amber_louver_bay", n_slats=5)  # 11:00 inner amber bay
    add_face_bay(158.0, 174.0, 6.64, 7.36, 2.98, style="machinery",    n_slats=5)      # 9:30 inner machinery
    add_face_bay(194.0, 214.0, 6.64, 7.36, 2.98, style="piped_trench", n_slats=5)      # 8:15 inner piped gallery
    add_face_bay(242.0, 262.0, 6.64, 7.36, 2.98, style="piped_trench", n_slats=5)      # 6:30 inner piped bay
    add_face_bay(278.0, 298.0, 6.64, 7.36, 2.98, style="machinery",    n_slats=5)      # 5:30 inner shadow trench
    add_face_bay(328.0, 358.0, 6.64, 7.36, 2.98, style="piped_trench", n_slats=7)      # 3:15-4:15 long inner gallery
    add_face_bay(374.0, 392.0, 6.64, 7.36, 2.98, style="machinery",    n_slats=5)      # 2:00 inner trench

    # Signature solid golden-ochre thermal bumper block right beside 7:30 collar (234 deg) & 11:00 inner lip (108 deg)
    for sy in (-1.0, 1.0):
        b.add_polar_box("Bays_SignatureGoldBlock", "amber_foil",  9.52, 234.5, sy * 3.16, (0.86, 1.18, 0.44), bevel=0.028)
        b.add_polar_box("Bays_SignatureGoldBlock", "gunmetal",    9.52, 234.5, sy * 3.38, (0.82, 0.14, 0.10), bevel=0.008)
        b.add_polar_box("Bays_SignatureGoldBlock", "amber_foil",  6.15, 108.5, sy * 2.52, (0.48, 1.28, 0.34), bevel=0.02)

    b.flush()


# ---------------------------------------------------------------------------
# 9. Collection 06: Sculpted Hero Spire, Ultra-Greebled Twin Booms & Blister Pod
# ---------------------------------------------------------------------------

def build_external_modules_and_spire(mats, col, root):
    """High-detail external protrusions precision-matched to ref1_tr, ref1_bl, ref3_top, ref3_bot."""
    b = MeshBatcher(col, root, mats)

    # =========================================================================
    # A. HERO COMMUNICATION / DOCKING SPIRE MAST AT 45 deg (ref1_tr.png & ref3_top.png!)
    # =========================================================================
    th_sp = 45.0
    # Tier 1: Wide sculpted terraced base platform + twin rounded-chamfer lateral shoulder pontoons (ref3_top.png!)
    b.add_polar_box("Hero_SpireBase", "armor_bright", 10.22, th_sp, 0.0, (0.98, 2.35, 3.85), bevel=0.048)
    for sy in (-1.0, 1.0):
        # Prominent rounded lateral white pontoon pods hugging the spire base left & right (exact ref3_top.png!)
        b.add_polar_box("Hero_SpireBase", "armor_bright", 10.20, th_sp, sy * 2.48, (0.86, 1.85, 1.38), bevel=0.075)
        b.add_polar_box("Hero_SpireBase", "inner_grey",   10.20, th_sp, sy * 2.98, (0.42, 1.32, 0.24), bevel=0.03)
        b.add_polar_box("Hero_SpireBase", "armor_white",  10.52, th_sp, sy * 1.48, (0.68, 1.62, 0.62), bevel=0.035)
        b.add_polar_cylinder("Hero_SpireBase", "gunmetal", 10.65, th_sp, sy * 1.18, 0.22, 1.42, axis="R", segments=14, bevel=0.015)

    # Tier 2: Sculpted A-Frame Twin-Ribbed Turret Cradle & Dense Multi-Ring Mechanical Waist (R = 10.65..12.35)
    # Prominent stepped horizontal armored chin shelf across turret base (clearly visible in ref3_top.png!)
    b.add_polar_box("Hero_SpireTurret", "armor_bright", 10.88, th_sp, 0.0, (0.68, 1.56, 2.48), bevel=0.04)
    b.add_polar_box("Hero_SpireTurret", "inner_grey",   11.24, th_sp, 0.0, (0.88, 1.66, 1.98), bevel=0.032)
    # Sculpted A-frame twin flanking saddle ribs cradling the spire mast (exact ref3_top.png signature!)
    for sy in (-1.0, 1.0):
        b.add_polar_box("Hero_SpireTurret", "armor_bright", 11.48, th_sp, sy * 0.68, (1.42, 0.96, 0.36), rot_local=(0.0, 0.0, -sy * 0.22), bevel=0.028)
        b.add_polar_box("Hero_SpireTurret", "armor_white",  10.95, th_sp, sy * 1.18, (0.76, 1.18, 0.44), bevel=0.025)
        b.add_polar_cylinder("Hero_SpireTurret", "alloy_pipe", 11.45, th_sp + sy * 2.4, sy * 0.82, 0.068, 1.55, axis="R", segments=10, bevel=0.005)
    # 5 dense stacked flanged mechanical waist rings + micro cooling ribs & side valve pods (ref1_tr.png!)
    for r_ring, rad_r, mk in (
        (11.12, 0.88, "armor_white"), (11.40, 0.82, "gunmetal"),
        (11.68, 0.80, "inner_grey"),  (11.96, 0.74, "armor_white"),
        (12.22, 0.68, "armor_slate"),
    ):
        b.add_polar_cylinder("Hero_SpireTurret", mk, r_ring, th_sp, 0.0, rad_r, 0.20, axis="R", segments=16, bevel=0.016)
    for k_g in range(8):
        ang = k_g * (math.pi * 0.25)
        b.add_polar_box("Hero_SpireTurret", "inner_grey" if k_g % 2 == 0 else "steel_trim",
                        11.68, th_sp + math.degrees(0.068 * math.cos(ang)), 0.72 * math.sin(ang), (0.72, 0.16, 0.16), bevel=0.01)

    # Tier 3: TRUE HOLLOW OPEN U-ARCH SENSOR SHROUD (R = 12.35..14.05, exact ref1_tr.png silhouette!)
    # Open front (-Y) and rear (+Y) faces expose deep recessed sensor bay + twin detailed metallic sensor tubes!
    b.add_polar_box("Hero_SpireShroud", "cavity_dark",  13.10, th_sp, 0.0, (1.28, 0.56, 0.34), bevel=0.01)
    for dt_s in (-1.0, 1.0):
        # Twin sculpted beveled outer U-arch arms (left/right in Front view)
        b.add_polar_box("Hero_SpireShroud", "armor_bright", 13.06, th_sp + dt_s * 2.10, 0.0, (1.56, 0.28, 0.96), bevel=0.032)
        b.add_polar_box("Hero_SpireShroud", "inner_grey",   13.06, th_sp + dt_s * 1.45, 0.0, (1.32, 0.12, 0.72), bevel=0.014)
    # Recessed twin metallic cylindrical sensor emitters + machined cross-collars clearly visible inside the open U-arch!
    for sy in (-1.0, 1.0):
        b.add_polar_cylinder("Hero_SpireShroud", "alloy_pipe", 13.14, th_sp, sy * 0.19, 0.125, 1.38, axis="R", segments=12, bevel=0.01)
        b.add_polar_cylinder("Hero_SpireShroud", "gunmetal",   12.88, th_sp, sy * 0.19, 0.16,  0.22, axis="R", segments=12, bevel=0.008)
        b.add_polar_cylinder("Hero_SpireShroud", "gunmetal",   13.38, th_sp, sy * 0.19, 0.15,  0.18, axis="R", segments=12, bevel=0.008)
    # Sculpted rounded U-arch top nose bridge closing the tip cleanly!
    b.add_polar_box("Hero_SpireShroud", "armor_bright", 13.84, th_sp, 0.0, (0.34, 1.04, 0.96), bevel=0.055)
    b.add_polar_cylinder("Hero_SpireShroud", "armor_bright", 14.04, th_sp, 0.0, 0.44, 0.34, radius2=0.22, axis="R", segments=18, bevel=0.02)
    b.add_polar_cylinder("Hero_SpireShroud", "inner_grey",   14.28, th_sp, 0.0, 0.24, 0.22, radius2=0.15, axis="R", segments=14, bevel=0.01)

    # Tier 4: Razor-Sleek Multi-Stage Tapered Communication Lance (R = 14.25..17.25)
    b.add_polar_cylinder("Hero_SpireLance", "armor_bright", 15.25, th_sp, 0.0, 0.115, 1.95, radius2=0.062, axis="R", segments=12, bevel=0.005)
    b.add_polar_cylinder("Hero_SpireLance", "alloy_pipe",   16.65, th_sp, 0.0, 0.056, 1.15, radius2=0.020, axis="R", segments=10, bevel=0.004)
    for r_c, rad_c in ((14.55, 0.155), (15.48, 0.105), (16.22, 0.078)):
        b.add_polar_cylinder("Hero_SpireLance", "steel_trim", r_c, th_sp, 0.0, rad_c, 0.09, axis="R", segments=12, bevel=0.006)
    b.add_polar_cylinder("Hero_SpireLance", "beacon_white", 17.26, th_sp, 0.0, 0.034, 0.07, axis="R", segments=10, bevel=0.004)

    # =========================================================================
    # B. ULTRA-GREEBLED TWIN PARALLEL INDUSTRIAL BOOMS AT 225 deg (exact ref1_bl.png bottom-left!)
    # =========================================================================
    th_bm = 225.0
    frame_bm = polar_frame(math.radians(th_bm))
    for idx_b, (t_off, length_b) in enumerate(((-0.84, 3.25), (0.86, 2.60))):
        g_bm = f"Hero_TwinBoom_{idx_b}"
        p_base_th = th_bm + math.degrees(t_off / 10.2)
        # Heavy dark recessed square mounting socket on the outer collar (ref1_bl.png!)
        b.add_polar_box(g_bm, "armor_slate", 10.24, p_base_th, 0.0, (0.95, 1.24, 1.38), bevel=0.026)
        b.add_polar_box(g_bm, "cavity_dark", 10.48, p_base_th, 0.0, (0.42, 0.88, 0.96), bevel=0.012)

        p0 = polar_pt(10.08, math.radians(th_bm), 0.0) + frame_bm @ Vector((0.0, 0.0, t_off))
        p1 = polar_pt(10.08 + length_b, math.radians(th_bm), 0.0) + frame_bm @ Vector((0.0, 0.0, t_off))
        dir_r = (p1 - p0).normalized()
        dir_t = (frame_bm @ Vector((0.0, 0.0, 1.0))).normalized()
        dir_y = Vector((0.0, 1.0, 0.0))

        # Solid octagonal mechanical central spine + stepped heavy flanged shrouds
        b.add_beam_between(g_bm, "gunmetal", p0, p1, 0.48, 0.52, bevel=0.016)
        for f0, f1, wx, wy, mk in (
            (0.00, 0.24, 0.94, 0.98, "armor_slate"),
            (0.24, 0.36, 0.72, 0.78, "hub_blue_dark"),
            (0.36, 0.58, 0.84, 0.88, "hub_blue_steel"),
            (0.58, 0.72, 0.64, 0.68, "gunmetal"),
            (0.72, 0.88, 0.68, 0.72, "armor_slate"),
            (0.88, 1.00, 0.44, 0.48, "inner_grey"),
        ):
            b.add_beam_between(g_bm, mk, p0 + dir_r * (length_b * f0), p0 + dir_r * (length_b * f1), wx, wy, bevel=0.02)
        # 6 stacked flanged cooling collar rings along each boom!
        for frac in (0.12, 0.28, 0.44, 0.56, 0.70, 0.84):
            pc = p0 + dir_r * (length_b * frac)
            b.add_beam_between(g_bm, "inner_grey", pc - dir_r * 0.06, pc + dir_r * 0.06, 0.98, 1.02, bevel=0.014)
        # 4 longitudinal external hydraulic pipes & truss rails hugging all 4 sides of each boom!
        for st, sy in ((-0.44, -0.44), (0.44, -0.44), (-0.44, 0.44), (0.44, 0.44)):
            off = dir_t * st + dir_y * sy
            b.add_beam_between(g_bm, "alloy_pipe", p0 + off + dir_r * 0.2, p1 + off - dir_r * 0.35, 0.045, 0.045, cylindrical=True, segments=8)
        # Flanking mechanical side pods + clustered nozzle/sensor claw tip (ref1_bl.png!)
        for st in (-0.52, 0.52):
            pm = p0 + dir_r * (length_b * 0.48) + dir_t * st
            b.add_beam_between(g_bm, "armor_slate", pm - dir_r * 0.45, pm + dir_r * 0.45, 0.26, 0.42, bevel=0.014)
        for st, sy in ((-0.16, -0.14), (0.16, 0.14), (0.0, 0.0)):
            pn0 = p1 - dir_r * 0.10 + dir_t * st + dir_y * sy
            ln_n = (0.58 if (st == 0 and idx_b == 0) else 0.34)
            b.add_beam_between(g_bm, "alloy_pipe" if st == 0 else "steel_trim", pn0, pn0 + dir_r * ln_n, 0.052 if st == 0 else 0.036, 0.024, cylindrical=True, segments=8)

    pb_a = polar_pt(10.85, math.radians(th_bm), 0.0) + frame_bm @ Vector((0.0, 0.0, -0.84))
    pb_b = polar_pt(10.85, math.radians(th_bm), 0.0) + frame_bm @ Vector((0.0, 0.0,  0.86))
    b.add_beam_between("Hero_TwinBoom_Bridge", "gunmetal", pb_a, pb_b, 0.48, 0.64, bevel=0.02)

    # =========================================================================
    # C. SCULPTED ROUNDED-OCTAGONAL LAYERED CHIN BLISTER POD AT 312 deg (ref3_bot.png bottom!)
    # =========================================================================
    th_pod = 312.0
    # Dark recessed collar ring
    b.add_ring_plate("Hero_BlisterPod", "gunmetal",     9.82, 10.22, -2.22, 2.22, th_pod - 9.8, th_pod + 9.8, segs=6, bevel=0.02)
    # Sculpted curved lower cheek bumper shell cradling a recessed shadow groove (exact ref3_bot.png bottom!)
    b.add_ring_plate("Hero_BlisterPod", "armor_white",  10.16, 10.92, -2.06, 2.06, th_pod - 8.8, th_pod + 8.8, segs=8, bevel=0.045, chamfer_out=0.38)
    b.add_ring_plate("Hero_BlisterPod", "cavity_dark",  10.86, 11.02, -1.68, 1.68, th_pod - 7.0, th_pod + 7.0, segs=6, bevel=0.01)
    # Upper sculpted dome cowl cap with rounded-chamfer corners
    b.add_ring_plate("Hero_BlisterPod", "armor_bright", 10.94, 11.42, -1.48, 1.48, th_pod - 6.2, th_pod + 6.2, segs=6, bevel=0.048, chamfer_out=0.32)
    b.add_ring_plate("Hero_BlisterPod", "armor_bright", 11.34, 11.58, -0.92, 0.92, th_pod - 3.8, th_pod + 3.8, segs=4, bevel=0.036, chamfer_out=0.16)
    # Twin curved flanking bumper ribs wrapping around the bottom chin corners (visible in ref3_bot.png!)
    for sy in (-1.0, 1.0):
        b.add_polar_box("Hero_BlisterPod", "armor_bright", 10.98, th_pod - 4.2, sy * 1.42, (0.58, 0.95, 0.46), rot_local=(0.0, 0.0, sy * 0.35), bevel=0.035)
        b.add_polar_box("Hero_BlisterPod", "cavity_dark",  10.56, th_pod,       sy * 2.08, (0.42, 1.72, 0.14), bevel=0.01)
        b.add_polar_box("Hero_BlisterPod", "amber_foil",   10.56, th_pod,       sy * 2.12, (0.20, 0.78, 0.08), bevel=0.008)

    # =========================================================================
    # D. TOP CROWN TWIN VERTICAL ANTENNAE + CROWN MODULE (12:00)
    # =========================================================================
    b.add_ring_plate("Hero_CrownModules", "armor_bright", 9.96, 10.48, -1.68, 1.68, 78.5, 86.5, segs=4, bevel=0.028, chamfer_out=0.10)
    b.add_polar_box("Hero_CrownModules",  "inner_grey",   10.42, 82.5, 0.0, (0.26, 0.86, 2.25), bevel=0.018)
    b.add_polar_box("Hero_CrownAntennae", "armor_slate",  10.16, 92.8, 0.0, (0.42, 0.82, 0.68), bevel=0.02)
    b.add_polar_cylinder("Hero_CrownAntennae", "armor_bright", 10.98, 93.8, -0.14, 0.068, 1.82, radius2=0.026, axis="R", segments=10, bevel=0.004)
    b.add_polar_cylinder("Hero_CrownAntennae", "armor_bright", 10.72, 91.2,  0.16, 0.062, 1.28, radius2=0.024, axis="R", segments=10, bevel=0.004)
    b.add_polar_cylinder("Hero_CrownAntennae", "beacon_white", 11.90, 93.8, -0.14, 0.032, 0.06, axis="R", segments=8, bevel=0.004)

    # =========================================================================
    # E. LEFT 3-PRONGED HORIZONTAL PROBE ARRAY AT 192 deg (ref1_bl.png left!)
    # =========================================================================
    th_p3 = 192.0
    b.add_polar_box("Hero_LeftProbeArray", "armor_white", 10.24, th_p3, 0.0, (0.76, 1.38, 1.58), bevel=0.028)
    b.add_polar_box("Hero_LeftProbeArray", "armor_slate", 10.58, th_p3, 0.0, (0.38, 0.98, 1.14), bevel=0.018)
    for d_th, dy_p, ln_p in ((-2.1, -0.24, 1.58), (0.0, 0.0, 1.92), (2.1, 0.24, 1.42)):
        b.add_polar_cylinder("Hero_LeftProbeArray", "alloy_pipe", 10.64 + ln_p * 0.5, th_p3 + d_th, dy_p, 0.060, ln_p, radius2=0.024, axis="R", segments=10, bevel=0.004)
        b.add_polar_cylinder("Hero_LeftProbeArray", "steel_trim", 10.76, th_p3 + d_th, dy_p, 0.098, 0.22, axis="R", segments=10, bevel=0.006)
    # Small thin curved antenna mast flanking above the 3-prong array (visible in ref1_bl.png!)
    b.add_polar_box("Hero_LeftProbeArray", "amber_foil", 10.12, 187.5, -1.65, (0.28, 1.35, 0.24), bevel=0.014)
    b.add_polar_box("Hero_LeftProbeArray", "amber_foil", 10.12, 187.5,  1.65, (0.28, 1.35, 0.24), bevel=0.014)

    # =========================================================================
    # F. RIGHT ANGLED SENSOR NEEDLE (340 deg) + VENTRAL PINS (266..282 deg) + MINOR STUBS
    # =========================================================================
    b.add_polar_box("Hero_RightNeedle",      "armor_slate",  10.12, 340.0, 0.0, (0.36, 0.58, 0.54), bevel=0.016)
    b.add_polar_cylinder("Hero_RightNeedle", "armor_bright", 11.12, 340.0, 0.0, 0.064, 1.85, radius2=0.020, axis="R", segments=10, bevel=0.004)
    b.add_polar_cylinder("Hero_RightNeedle", "steel_trim",   10.52, 340.0, 0.0, 0.095, 0.20, axis="R", segments=10, bevel=0.005)
    b.add_polar_cylinder("Hero_RightNeedle", "alloy_pipe",   10.55, 336.8, 0.20, 0.042, 0.80, radius2=0.020, axis="R", segments=8, bevel=0.004)

    b.add_ring_plate("Hero_VentralSensor", "armor_white", 9.96, 10.34, -1.15, 1.15, 267.0, 281.0, segs=4, bevel=0.024)
    b.add_polar_box("Hero_VentralSensor",  "amber_foil",  10.30, 276.5, 0.0, (0.22, 0.88, 0.78), bevel=0.014)
    for th_vp, ln_vp in ((266.5, 0.92), (271.5, 1.22), (282.0, 0.70)):
        b.add_polar_cylinder("Hero_VentralSensor", "alloy_pipe", 10.15 + ln_vp * 0.5, th_vp, 0.0, 0.044, ln_vp, radius2=0.018, axis="R", segments=8, bevel=0.004)

    b.add_ring_plate("Hero_OuterSponsons", "armor_bright", 9.96, 10.54, -1.72, 1.72, 134.0, 141.0, segs=3, bevel=0.028, chamfer_out=0.10)
    # Keep clean Image 3 central panel (344..385 deg) unbroken! Place minor flank sponson on shoulders only (Y = +/- 1.95)
    for sy in (-1.0, 1.0):
        b.add_polar_box("Hero_OuterSponsons", "armor_white", 10.08, 22.0, sy * 1.92, (0.28, 0.86, 0.82), bevel=0.02)

    b.flush()


def build_megastructure_micro_details(mats, col, root):
    """High-density kilometer-scale architectural micro-greebles across outer ring & inner hub."""
    b = MeshBatcher(col, root, mats)

    # 1. Scattered subtle proud ceramic access tiles, recessed micro-thruster slits & fine hull conduits
    rng = np.random.default_rng(202611)
    for q0, q1 in ((55.0, 125.0), (145.0, 215.0), (235.0, 305.0), (325.0, 395.0)):
        # 18 crisp micro surface details per quadrant on BOTH Front & Rear faces
        for i in range(18):
            th = q0 + (i + 0.5) * ((q1 - q0) / 18.0) + float(rng.uniform(-1.0, 1.0))
            r_pos = float(rng.uniform(7.55, 8.85))
            w_r = float(rng.uniform(0.24, 0.54))
            w_t = float(rng.uniform(0.32, 0.92))
            kind = i % 4
            for sy in (-1.0, 1.0):
                if kind == 0:
                    # Subtle proud beveled ceramic maintenance panel (0.04m relief!)
                    b.add_polar_box("Micro_HullTiles", "armor_bright", r_pos, th, sy * 3.84, (w_r, w_t, 0.08), bevel=0.012)
                elif kind == 1:
                    # Pair of crisp miniature dark RCS / viewport slits framed by thin grey bezel
                    b.add_polar_box("Micro_Slits", "inner_grey",  r_pos, th, sy * 3.82, (0.20, 0.58, 0.08), bevel=0.008)
                    for dt_s in (-0.8, 0.8):
                        b.add_polar_box("Micro_Slits", "cavity_dark", r_pos, th + dt_s, sy * 3.85, (0.09, 0.20, 0.06), bevel=0.004)
                elif kind == 2:
                    # Thin tangential surface conduit pipe hugging the hull seam with twin clamp clips
                    b.add_arc_tube("Micro_Conduits", "alloy_pipe", r_pos, sy * 3.84, 0.026, th - 2.2, th + 2.2, segs_arc=4, segs_tube=6)
                    for d_cl in (-1.4, 1.4):
                        b.add_polar_box("Micro_Conduits", "inner_grey", r_pos, th + d_cl, sy * 3.84, (0.09, 0.12, 0.08), bevel=0.006)
                else:
                    # Low-profile stepped slate sensor blister
                    b.add_polar_box("Micro_Blisters", "inner_grey", r_pos, th, sy * 3.84, (w_r * 0.7, w_t * 0.7, 0.10), bevel=0.012)

    # 2. Outer perimeter stepped rim flange ticks & micro attitude-control thruster pods around the 360 rim
    for k in range(48):
        th = k * 7.5 + 3.75
        if any(abs(((th - c + 180) % 360) - 180) < 7.0 for c in (45, 135, 225, 315)):
            continue
        # Keep Image 3 clean center track (343..386) clear of random center ticks!
        for sy in (-1.0, 1.0):
            if k % 2 == 0:
                b.add_polar_box("Micro_ShoulderTicks", "inner_grey", 9.86, th, sy * 2.86, (0.16, 0.42, 0.28), bevel=0.012)
            else:
                b.add_polar_box("Micro_ShoulderTicks", "armor_bright", 9.52, th, sy * 3.44, (0.28, 0.52, 0.12), bevel=0.012)

    b.flush()


# ---------------------------------------------------------------------------
# 10. Collection 08: SCULPTED CURVED TOROIDAL INNER CORE HUB RING (V6 True Rounded Torus Profile!)
# ---------------------------------------------------------------------------

def build_inner_core_hub(mats, col, root):
    """True curved toroidal/rounded-oval inner core hub (R = 2.24..3.48 m, curved axial crown Y in [-0.96, +0.96]).

    Every layer — core hull, outermost rim armor, front/rear curved dome plates, concentric channels,
    clamp ribs, docking blister, and recessed warm-amber galleries — strictly conforms to a smooth
    curved superellipse torus cross-section (r(phi), y(phi)) with ZERO flat planar ring faces!
    """
    b = MeshBatcher(col, root, mats)

    R_MAJ = 2.86
    A_R = 0.62   # R spans [2.24, 3.48] m (exact 22.5% .. 35% concentric match!)
    A_Y = 0.94   # Smoothly arched toroidal dome Y in [-0.94, +0.94] m (1.88 m sleek curved torus!)
    EXP = 2.0 / 2.25  # Rounded superellipse exponent (smooth organic aerospace curvature, never flat!)

    def torus_ry(phi_deg, dr=0.0, dy=0.0):
        ph = math.radians(phi_deg)
        c, s = math.cos(ph), math.sin(ph)
        r = R_MAJ + (A_R + dr) * math.copysign(abs(c) ** EXP, c)
        y = (A_Y + dy) * math.copysign(abs(s) ** EXP, s)
        return (r, y)

    def add_torus_shell(group_name, mat_key, phi0, phi1, th0, th1, off_in, off_out, n_phi=8, n_th=None, closed_th=False, bevel=0.012):
        """Curved toroidal armor plate spanning minor angle [phi0..phi1], major arc [th0..th1], radial offset [off_in..off_out]."""
        if n_th is None:
            n_th = max(3, int(round(abs(th1 - th0) / 4.5)))
        outer_pts = [torus_ry(phi0 + (phi1 - phi0) * (i / float(n_phi)), off_out, off_out) for i in range(n_phi + 1)]
        inner_pts = [torus_ry(phi1 - (phi1 - phi0) * (i / float(n_phi)), off_in, off_in) for i in range(n_phi + 1)]
        prof = outer_pts + inner_pts
        b.add_arc_profile(group_name, mat_key, prof, th0, th1, segs=n_th, closed_loop=closed_th, bevel=bevel)

    # 1. TRUE 360-DEG SMOOTH CURVED TOROIDAL STRUCTURAL CORE (32-point smooth cross-section!)
    core_prof = [torus_ry(k * (360.0 / 32.0), -0.04, -0.04) for k in range(32)]
    b.add_arc_profile("Hub_CurvedTorusCore", "hub_blue_dark", core_prof, 0.0, 360.0, segs=96, closed_loop=True, bevel=0.0)

    # Smooth curved inner bore lining (phi in [145..215] deg, R_min = 2.24 m — perfectly circular rounded tunnel!)
    add_torus_shell("Hub_CurvedInnerBore", "hub_blue_steel", 142.0, 218.0, 0.0, 360.0, -0.03, 0.015, n_phi=10, n_th=96, closed_th=True, bevel=0.0)
    for phi_r in (158.0, 173.0, 187.0, 202.0):
        rr, yy = torus_ry(phi_r, -0.025, -0.025)
        b.add_arc_tube("Hub_TunnelRails", "hub_blue_dark", rr, yy, 0.024, 0.0, 360.0, segs_arc=84, segs_tube=8, closed_loop=True)

    # 2. CURVED OUTERMOST TOROIDAL PERIMETER ARMOR BELT (phi in [-46..+46] deg — ROUNDED BARREL CURVE, NEVER FLAT!)
    # Segmented organically around 360 deg with hairline panel breaks & gentle proud curvature!
    outer_arcs = [
        (  0.3,  44.6, 0.042, "hub_blue_steel"),
        ( 45.4,  91.6, 0.048, "hub_blue_steel"),
        ( 92.4, 134.6, 0.042, "hub_blue_steel"),
        (135.4, 179.6, 0.048, "hub_pale_silver"),
        (180.4, 224.6, 0.044, "hub_pale_silver"),
        (225.4, 269.6, 0.048, "hub_pale_silver"),
        (270.4, 314.6, 0.042, "hub_blue_steel"),
        (315.4, 359.6, 0.046, "hub_blue_steel"),
    ]
    for a0, a1, thick, mk in outer_arcs:
        # Curved outer barrel shell wrapping smoothly from front shoulder (-44 deg) over curved equator (0 deg) to rear shoulder (+44 deg)!
        add_torus_shell("Hub_CurvedOuterBelt", mk, -44.0, 44.0, a0, a1, -0.01, thick, n_phi=10, bevel=0.014)

    # 3. CURVED FRONT (-Y, phi in [-142..-48]) & REAR (+Y, phi in [48..142]) DOMED ARMOR BANDS!
    #    Every face panel curves smoothly along the toroidal arch instead of lying on a flat plane!
    for sy in (-1.0, 1.0):
        # Outer-crown curved band (phi = 48..98 deg on rear, -98..-48 deg on front)
        p_out0, p_out1 = (48.0, 98.0) if sy > 0 else (-98.0, -48.0)
        for a0, a1, thick, mk in outer_arcs:
            add_torus_shell("Hub_CurvedCrownArmor", mk, p_out0, p_out1, a0, a1, -0.01, thick + 0.012, n_phi=8, bevel=0.014)

        # Inner-crown curved collar band (phi = 102..144 deg on rear, -144..-102 deg on front)
        p_in0, p_in1 = (102.0, 144.0) if sy > 0 else (-144.0, -102.0)
        inner_collar_arcs = [
            (108.0, 148.0, 0.046, "hub_blue_steel"),
            (148.5, 212.0, 0.056, "hub_pale_silver"),
            (212.5, 267.5, 0.050, "hub_pale_silver"),
            (268.5, 307.5, 0.030, "hub_pale_silver"),
            (308.5, 366.0, 0.044, "hub_blue_steel"),
            (  6.8,  91.8, 0.018, "hub_blue_dark"),   # subtly recessed curved upper-right gallery!
            ( 92.4, 107.5, 0.044, "hub_blue_steel"),
        ]
        for a0, a1, thick, mk in inner_collar_arcs:
            add_torus_shell("Hub_CurvedInnerDome", mk, p_in0, p_in1, a0, a1, -0.01, thick, n_phi=7, bevel=0.012)

        # Curved recessed warm-amber gallery strips conforming smoothly to the curved torus dome!
        # Upper-right recessed inner dome gallery (22..80 deg)
        pa0, pa1 = (105.0, 130.0) if sy > 0 else (-130.0, -105.0)
        add_torus_shell("Hub_AmberDetails", "amber_foil",   pa0, pa1, 22.0, 80.0, 0.005, 0.032, n_phi=4, n_th=16, bevel=0.005)
        pa2, pa3 = (111.0, 124.0) if sy > 0 else (-124.0, -111.0)
        add_torus_shell("Hub_AmberDetails", "amber_window", pa2, pa3, 28.0, 74.0, 0.012, 0.038, n_phi=3, n_th=14, bevel=0.004)
        # Fine curved mullions bridging the upper-right curved gallery
        for k_w in range(9):
            th_w = 24.0 + k_w * 6.5
            add_torus_shell("Hub_CurvedMullions", "hub_blue_dark", pa0 - 2.0, pa1 + 2.0, th_w - 0.7, th_w + 0.7, 0.01, 0.046, n_phi=4, n_th=1, bevel=0.004)

        # Bottom curved golden inner sill (270..302 deg) + outer curved ochre accent strip (272..298 deg)
        add_torus_shell("Hub_AmberDetails", "amber_foil",   pa0, pa1, 270.0, 302.0, 0.010, 0.042, n_phi=4, n_th=10, bevel=0.005)
        add_torus_shell("Hub_AmberDetails", "amber_window", pa2, pa3, 274.0, 298.0, 0.020, 0.048, n_phi=3, n_th=8,  bevel=0.004)
        pb0, pb1 = (46.0, 62.0) if sy > 0 else (-62.0, -46.0)
        add_torus_shell("Hub_AmberDetails", "amber_foil",   pb0, pb1, 272.0, 298.0, 0.020, 0.060, n_phi=3, n_th=8,  bevel=0.006)
        # Small curved 8:30 golden accent plate
        pc0, pc1 = (72.0, 92.0) if sy > 0 else (-92.0, -72.0)
        add_torus_shell("Hub_AmberDetails", "amber_foil",   pc0, pc1, 183.0, 189.0, 0.025, 0.068, n_phi=3, n_th=2,  bevel=0.006)

    # 4. CONCENTRIC CURVED CONDUIT PIPES HUGGING THE TOROIDAL SURFACE GROOVES
    for phi_p, off_p, tr, mk in (
        (-100.0, 0.025, 0.028, "alloy_pipe"),  (100.0, 0.025, 0.028, "alloy_pipe"),
        ( -46.0, 0.030, 0.032, "hub_blue_dark"), (46.0, 0.030, 0.032, "hub_blue_dark"),
        (   0.0, 0.044, 0.040, "steel_trim"),
    ):
        rr, yy = torus_ry(phi_p, off_p, off_p)
        b.add_arc_tube("Hub_ConcentricPipes", mk, rr, yy, tr, 0.0, 360.0, segs_arc=96, segs_tube=8, closed_loop=True)

    # 5. CURVED WRAP-AROUND STRUCTURAL CLAMP COLLARS & LANDMARK MODULES (all strictly curved along the torus!)
    # 16 sleek curved toroidal clamp ribs wrapping over the outer curved surface (phi in [-64..+64])
    for k in range(16):
        th_c = k * 22.5
        add_torus_shell("Hub_CurvedClampRibs", "hub_blue_dark" if k % 2 else "hub_blue_steel", -62.0, 62.0, th_c - 1.1, th_c + 1.1, 0.01, 0.072, n_phi=10, n_th=1, bevel=0.008)

    # A) Curved low-profile docking module wrapping smoothly around 18 deg outer arc (phi in [-36..+36])
    add_torus_shell("Hub_LandmarkMods", "hub_blue_steel", -38.0, 38.0, 11.0, 25.0, 0.02, 0.145, n_phi=8, n_th=4, bevel=0.016)
    add_torus_shell("Hub_LandmarkMods", "hub_blue_dark",  -24.0, 24.0, 15.0, 21.0, 0.08, 0.175, n_phi=6, n_th=2, bevel=0.012)

    # B) Curved multi-part ribbed manifold inset at 136 deg (10:30)
    for sy in (-1.0, 1.0):
        pm0, pm1 = (62.0, 96.0) if sy > 0 else (-96.0, -62.0)
        add_torus_shell("Hub_LandmarkMods", "hub_blue_dark", pm0, pm1, 132.0, 140.0, 0.02, 0.075, n_phi=5, n_th=3, bevel=0.008)
        for p_rb in (pm0 + 6.0, 0.5 * (pm0 + pm1), pm1 - 6.0):
            add_torus_shell("Hub_LandmarkMods", "hub_blue_steel", p_rb - 3.0, p_rb + 3.0, 132.5, 139.5, 0.04, 0.095, n_phi=2, n_th=2, bevel=0.005)
        # C) Curved 3-rib expansion seam at 224 deg (7:30)
        add_torus_shell("Hub_LandmarkMods", "hub_blue_dark", pm0 - 8.0, pm1 + 8.0, 221.5, 226.5, 0.02, 0.072, n_phi=6, n_th=2, bevel=0.008)
        for d_th in (-1.6, 0.0, 1.6):
            add_torus_shell("Hub_LandmarkMods", "alloy_pipe" if d_th == 0 else "steel_trim", pm0 - 10.0, pm1 + 10.0, 224.0 + d_th - 0.45, 224.0 + d_th + 0.45, 0.03, 0.092, n_phi=6, n_th=1, bevel=0.004)
        # D) Curved raised micro-armor overlay hatches scattered smoothly along the toroidal crown!
        for th_hg in (38.0, 74.0, 114.0, 162.0, 204.0, 246.0, 336.0):
            mk_g = "hub_blue_steel" if (th_hg < 130 or th_hg > 275) else "hub_pale_silver"
            ph_a, ph_b = (68.0, 92.0) if sy > 0 else (-92.0, -68.0)
            add_torus_shell("Hub_CurvedMicroPlates", mk_g, ph_a, ph_b, th_hg - 4.0, th_hg + 4.0, 0.03, 0.082, n_phi=4, n_th=2, bevel=0.008)

    b.flush()


# ---------------------------------------------------------------------------
# 11. Collection 09: Exact Reference-Aligned Radial Tension Spokes (Dead-Centered on Origin!)
# ---------------------------------------------------------------------------

def build_radial_spokes(mats, col, root):
    """15 exact reference-matched radial tension spokes (Ref 1 & Ref 2 Flipped!) radiating dead-center from (0,0,0)."""
    b = MeshBatcher(col, root, mats)

    # Exact spoke clock angles verified from align_diag.png Bottom-Left & Bottom-Middle:
    #   Horizontal left/right (0, 180), 4 diagonal collar spokes (45, 135, 225, 315),
    #   Top triad (68, 91, 114), Bottom pair flanking 6:00 (251, 289 — NO spoke at 270!),
    #   Flank pairs (22, 158, 202, 338)!
    spoke_angles = [
        0.0, 22.0, 45.0, 68.0, 91.0, 114.0, 135.0, 158.0,
        180.0, 202.0, 225.0, 251.0, 289.0, 315.0, 338.0,
    ]
    for k, th_deg in enumerate(spoke_angles):
        th = math.radians(th_deg)
        is_diag = (th_deg in (45.0, 135.0, 225.0, 315.0))
        r_out = 5.10 if is_diag else 5.56

        # Primary sleek structural tension strut dead-centered near Y=0 (subtle +/-0.08m depth parallax)
        y_main = 0.08 if (k % 2 == 0) else -0.08
        p_in = polar_pt(3.42, th, y_main)
        p_out = polar_pt(r_out, th, y_main)
        b.add_beam_between("Spokes_PrimaryRods", "spoke_steel", p_in, p_out, 0.044, 0.044, cylindrical=True, segments=10)

        # Delicate parallel secondary tension cable tucked behind in Y (visible in 3/4 views)
        y_sec = -y_main * 3.5
        b.add_beam_between("Spokes_SecondaryWires", "steel_trim", polar_pt(3.42, th, y_sec), polar_pt(r_out, th, y_sec), 0.020, 0.020, cylindrical=True, segments=8)

        # Sleek flush machined anchor sockets gripping both rings
        b.add_polar_cylinder("Spokes_Anchors", "hub_blue_dark", 3.50, th_deg, y_main, 0.088, 0.22, radius2=0.062, axis="R", segments=10, bevel=0.008)
        b.add_polar_cylinder("Spokes_Anchors", "inner_grey",    r_out - 0.10, th_deg, y_main, 0.068, 0.26, radius2=0.105, axis="R", segments=10, bevel=0.008)

    b.flush()


# ---------------------------------------------------------------------------
# 12. Studio Lighting, World & 8 Reference-Matched Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Station_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.048, 0.050, 0.056, 1.0)
        bg.inputs["Strength"].default_value = 0.90

    def add_light(name, ltype, loc, target, energy, color, size=24.0, angle=0.036, radius=1.4):
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

    # 1. Soft Studio Sun Key from Front-Upper-Right (bright crisp white ceramic modeling like Image 1!)
    add_light("Key_Sun_Front", "SUN", (20.0, -28.0, 22.0), (0.0, 0.0, 0.0), energy=3.6, color=(1.0, 0.99, 0.98), angle=0.04)
    # 2. Rear Balanced Area Key (clean Image 2 elevation lighting)
    add_light("Key_Area_Rear", "AREA", (-16.0, 32.0, 18.0), (0.0, 0.0, 0.0), energy=12000.0, color=(0.95, 0.97, 1.0), size=28.0)
    # 3. Soft Front-Left Fill (keeps shadowed ceramic panels luminous grey-white, never muddy black!)
    add_light("Fill_Area_FrontLeft", "AREA", (-28.0, -24.0, -6.0), (0.0, 0.0, 0.0), energy=5600.0, color=(0.88, 0.93, 1.0), size=28.0)
    # 4. Crisp Rim Light along +X Equatorial Edge (accentuates Image 3 twin rails, turret, louvers & blister!)
    add_light("Rim_Area_Equatorial", "AREA", (32.0, -10.0, 14.0), (8.0, 0.0, 0.0), energy=7800.0, color=(0.97, 0.98, 1.0), size=24.0)
    # 5. Ventral Soft Bounce
    add_light("Bounce_Area_Ventral", "AREA", (4.0, -16.0, -30.0), (0.0, 0.0, -4.0), energy=4600.0, color=(0.85, 0.90, 1.0), size=28.0)
    # 6. Subtle Cool Steel-Blue Hub Accent Bounce
    for sy in (-1.0, 1.0):
        add_light(f"CoolHub_Bounce_{'F' if sy < 0 else 'R'}", "POINT", (0.0, sy * 3.6, 0.0), None, energy=240.0, color=(0.56, 0.76, 1.0), radius=2.0)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=45.0, ortho_scale=28.5):
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

    make_cam("Cam_Front_Ortho", (0.5, -42.0, 0.5), (0.5, 0.0, 0.5), cam_type="ORTHO", ortho_scale=28.5)
    make_cam("Cam_Rear_Ortho",  (0.5,  42.0, 0.5), (0.5, 0.0, 0.5), cam_type="ORTHO", ortho_scale=28.5)
    make_cam("Cam_Edge_Ortho",  (42.0 * math.cos(math.radians(9.0)), 0.0, 42.0 * math.sin(math.radians(9.0))), (0.0, 0.0, 0.4), cam_type="ORTHO", ortho_scale=26.5)
    make_cam("Cam_Hero_34",     (-23.5, -32.5, 13.5), (0.6, 0.0, 0.7), cam_type="PERSP", lens=45.0)
    make_cam("Cam_Rear_34",     (25.5,  34.0, -9.0),  (0.6, 0.0, 1.1), cam_type="PERSP", lens=44.0)
    make_cam("Cam_Closeup_Hub", (0.0, -24.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=14.2)
    make_cam("Cam_Closeup_Spire", (13.0, -20.5, 12.0), (5.5, 0.0, 5.2), cam_type="PERSP", lens=48.0)
    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 44.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=28.5)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    bpy.context.scene.camera = cameras["Cam_Front_Ortho"]
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
    scene.render.resolution_y = 1200
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"

    if hasattr(scene, "eevee"):
        if hasattr(scene.eevee, "taa_render_samples"):
            scene.eevee.taa_render_samples = 64
        if hasattr(scene.eevee, "use_gtao"):
            scene.eevee.use_gtao = True
        if hasattr(scene.eevee, "gtao_distance"):
            scene.eevee.gtao_distance = 1.8

    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.05

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

    col_root    = ensure_collection("Orbis_Orbital_Station")
    col_core    = ensure_collection("01_Outer_Ring_Core_Chassis", col_root)
    col_armor   = ensure_collection("02_Outer_Ring_Armor_Shell", col_root)
    col_collars = ensure_collection("03_Four_Diagonal_Collar_Nodes", col_root)
    col_rim     = ensure_collection("04_Equatorial_Rim_Rails_And_Bays", col_root)
    col_bays    = ensure_collection("05_Inner_Gallery_And_Amber_Bays", col_root)
    col_ext     = ensure_collection("06_Hero_External_Modules_And_Spire", col_root)
    col_micro   = ensure_collection("07_Megastructure_Micro_Details", col_root)
    col_hub     = ensure_collection("08_Inner_Core_Hub_Ring", col_root)
    col_spokes  = ensure_collection("09_Radial_Tension_Spokes", col_root)
    col_stage   = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("Orbital_Station_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_station_textures()
    mats = build_materials(tex)

    build_outer_ring_chassis(mats, col_core, root)
    build_outer_ring_armor(mats, col_armor, root)
    build_diagonal_collar_nodes(mats, col_collars, root)
    build_equatorial_rim_details(mats, col_rim, root)
    build_recessed_bays_and_amber_galleries(mats, col_bays, root)
    build_external_modules_and_spire(mats, col_ext, root)
    build_megastructure_micro_details(mats, col_micro, root)
    build_inner_core_hub(mats, col_hub, root)
    build_radial_spokes(mats, col_spokes, root)

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
        f"BUILT Orbis_Orbital_Station V6 (Curved Toroidal Inner Hub + Exact 0.548 Ring Ratio + 2048 PBR): "
        f"{len(mesh_objs)} mesh groups, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
