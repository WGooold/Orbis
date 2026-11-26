"""Parametric ultra-detailed hard-surface 3D model builder for the OpenCode Orbital Portal Carrier (V3 Mecha Comic / Cel-Shaded NPR).

Built from the hero concept & 4 turnaround reference views in docs/design/opencode/,
with all AI-turnaround skew, pitch/yaw tilt, ring twist, and left/right asymmetries
corrected into a strictly 100% bilaterally symmetric, orthogonally aligned spacecraft,
shaded in Ligne-Claire Mecha Anime / Comic Book style:
  - 4-band EEVEE NPR Cel-Shading (ShaderToRGB stepped cool cobalt-slate shadows, clean
    comic white ceramic highlights, AO ink crevice accents & crisp anime specular pops)
  - Dual-weight Blender 5.3 Grease Pencil Line Art ink outlines (bold silhouette/material
    contours + fine mechanical panel crease lines, excluding holographic/emissive FX)
  - 2048x2048 hand-inked comic panel-line Albedo & Normal textures (clean ceramic tones,
    crisp technical ink seams, chamfered Gundam panel cuts, hatches, louvers & rivets)
  - Dual-target Material Output (EEVEE NPR Cel Shader + ALL glTF-compatible Principled BSDF)

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-6.83, +6.83] (13.66 m ring beam; 6.24 m hull beam)
  -Y = Stern, +Y = Bow             -> Y in [-11.00, +11.03] (22.03 m total length)
  -Z = Ventral, +Z = Dorsal        -> Z in [-7.46, +7.46] (14.92 m ring height; centered on Z=0)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/opencode"
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
        bpy.data.grease_pencils,
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
# 1. Procedural 2048x2048 Weathered Aerospace White-Ceramic & Gunmetal PBR Maps
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64, 128), weights=(0.30, 0.25, 0.18, 0.12, 0.09, 0.06)):
    """Fast vectorized seamless tileable fBM noise via periodic smoothstep interpolation."""
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


def _generate_comic_ink_plating(res, seed, grid_x=3, grid_y=3, sub_prob=0.56, seam_px=3):
    """Generate crisp Ligne-Claire mecha manga plating with bold dark ink seams, 45-deg Gundam chamfers, hatches & rivets."""
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    ink = np.zeros((res, res), dtype=np.float32)
    rivet = np.zeros((res, res), dtype=np.float32)
    vent = np.zeros((res, res), dtype=np.float32)

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

    min_sub = max(150, res // 5)

    def draw_diag(arr, x0, y0, length, dx, dy, width=2, val=1.0):
        for st in range(length):
            px = (x0 + st * dx) % res
            py = (y0 + st * dy) % res
            for wy in range(width):
                for wx in range(width):
                    arr[(py + wy) % res, (px + wx) % res] = max(arr[(py + wy) % res, (px + wx) % res], val)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 2 and min(w, h) > min_sub and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.34, 0.66))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.34, 0.66))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        # Clean graphic comic panel color block (subtle anime cool/bright plate alternation)
        tone[y0:y1, x0:x1] = float(rng.choice([-0.055, -0.020, 0.0, 0.025, 0.045]))
        sp = seam_px if depth == 0 else max(2, seam_px - 1)
        ink[y0:min(y0 + sp, y1), x0:x1] = 1.0
        ink[max(y1 - sp, y0):y1, x0:x1] = 1.0
        ink[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        ink[y0:y1, max(x1 - sp, x0):x1] = 1.0

        # Signature 45-deg mecha anime corner chamfer ink lines
        if min(w, h) > 170 and rng.random() < 0.72:
            ch = int(min(w, h) * rng.uniform(0.09, 0.16))
            draw_diag(ink, x0 + ch, y0 + sp, ch, -1, 1, width=max(2, sp - 1), val=0.95)
            draw_diag(ink, x1 - ch - sp, y1 - sp, ch, 1, -1, width=max(2, sp - 1), val=0.95)

        # Clean technical manga fastener rivets along plate edges
        step = max(56, res // 16)
        pad = sp + max(14, res // 90)
        r_sz = max(3, res // 420)
        if w > pad * 4 and h > pad * 4:
            for rx in range(x0 + pad, x1 - pad, step):
                for ry in (y0 + pad, y1 - pad - r_sz):
                    if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                        rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0
            for ry in range(y0 + pad + step, y1 - pad - step, step):
                for rx in (x0 + pad, x1 - pad - r_sz):
                    if 0 <= ry < res - r_sz and 0 <= rx < res - r_sz:
                        rivet[ry:ry + r_sz, rx:rx + r_sz] = 1.0

        # Crisp hand-inked inspection hatch + parallel technical louver strokes
        if w > res // 4 and h > res // 4 and rng.random() < 0.72:
            hw = int(w * rng.uniform(0.18, 0.30))
            hh = int(h * rng.uniform(0.16, 0.28))
            hx0 = x0 + int(w * rng.uniform(0.14, 0.78 - hw / float(w)))
            hy0 = y0 + int(h * rng.uniform(0.14, 0.78 - hh / float(h)))
            hx1 = min(hx0 + hw, x1 - pad)
            hy1 = min(hy0 + hh, y1 - pad)
            if hx1 - hx0 > 48 and hy1 - hy0 > 38:
                tone[hy0:hy1, hx0:hx1] += float(rng.choice([-0.035, 0.032]))
                hsp = 2
                ink[hy0:hy0 + hsp, hx0:hx1] = 0.96
                ink[hy1 - hsp:hy1, hx0:hx1] = 0.96
                ink[hy0:hy1, hx0:hx0 + hsp] = 0.96
                ink[hy0:hy1, hx1 - hsp:hx1] = 0.96
                # Corner ink tick marks on hatch
                if rng.random() < 0.58 and (hy1 - hy0) > 54:
                    sl_x0 = hx0 + int((hx1 - hx0) * 0.18)
                    sl_x1 = hx1 - int((hx1 - hx0) * 0.18)
                    n_sl = 5
                    sl_gap = max(7, (hy1 - hy0) // (n_sl + 2))
                    sl_y = hy0 + sl_gap
                    for _ in range(n_sl):
                        if sl_y + 3 < hy1 - 8:
                            vent[sl_y:sl_y + 3, sl_x0:sl_x1] = 0.95
                            sl_y += sl_gap

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    # Slight crisp anti-alias so comic ink seams stay razor-sharp without jagged pixel stair-stepping
    ink_aa = np.clip(
        ink * 0.76
        + np.roll(ink, 1, axis=0) * 0.08
        + np.roll(ink, -1, axis=0) * 0.08
        + np.roll(ink, 1, axis=1) * 0.08
        + np.roll(ink, -1, axis=1) * 0.08,
        0.0,
        1.0,
    )
    return tone, ink_aa, rivet, vent


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


def generate_opencode_textures():
    """Synthesize 2048x2048 Ligne-Claire Mecha Comic Ink Panel Textures (clean ceramic & anime steel)."""
    res = 2048
    paper_grain = _tileable_fbm(res, seed=131, octaves=(16, 32, 64, 128), weights=(0.30, 0.30, 0.25, 0.15))

    # Set A: 2048x2048 Clean Comic Ceramic Armor w/ Bold Black Technical Ink Seams & Hatch Linework
    tone_w, ink_w, riv_w, vent_w = _generate_comic_ink_plating(res, seed=521, grid_x=3, grid_y=3, sub_prob=0.58, seam_px=4)
    grain_w = (paper_grain - 0.5) * 0.028

    # Crisp clean manga white-porcelain ceramic base (multiplied by cel-shading ramp in EEVEE!)
    wr = np.clip(0.955 + tone_w * 0.92 - grain_w, 0.0, 1.0)
    wg = np.clip(0.965 + tone_w * 0.86 - grain_w, 0.0, 1.0)
    wb = np.clip(0.985 + tone_w * 0.72 - grain_w * 0.8, 0.0, 1.0)
    # Bold dark technical ink panel seams, rivets & louver strokes (Gundam / Moebius Ligne-Claire!)
    ink_mask_w = np.clip(ink_w * 0.95 + riv_w * 0.84 + vent_w * 0.92, 0.0, 0.97)
    ceramic_albedo = np.stack([
        wr * (1.0 - ink_mask_w) + 0.022 * ink_mask_w,
        wg * (1.0 - ink_mask_w) + 0.026 * ink_mask_w,
        wb * (1.0 - ink_mask_w) + 0.048 * ink_mask_w,
    ], axis=-1)

    ceramic_rough = np.clip(0.55 + ink_mask_w * 0.30 + (paper_grain - 0.5) * 0.06, 0.35, 0.92)
    ceramic_rough_rgb = np.stack([ceramic_rough, ceramic_rough, ceramic_rough], axis=-1)
    ceramic_height = np.clip(0.80 - ink_w * 0.42 - riv_w * 0.26 - vent_w * 0.45 + tone_w * 0.18, 0.0, 1.0)
    ceramic_normal = _height_to_normal(ceramic_height, strength=2.20)

    # Set B: 2048x2048 Comic Dark Slate-Navy Mechanical Chassis w/ Crisp Ink Panel Lines
    tone_g, ink_g, riv_g, vent_g = _generate_comic_ink_plating(res, seed=827, grid_x=4, grid_y=4, sub_prob=0.58, seam_px=3)
    gr = np.clip(0.82 + tone_g * 0.95 - grain_w, 0.0, 1.0)
    gg = np.clip(0.85 + tone_g * 0.92 - grain_w, 0.0, 1.0)
    gb = np.clip(0.94 + tone_g * 0.85 - grain_w, 0.0, 1.0)
    ink_mask_g = np.clip(ink_g * 0.85 + riv_g * 0.70 + vent_g * 0.85, 0.0, 0.92)
    gunmetal_albedo = np.stack([
        gr * (1.0 - ink_mask_g) + 0.030 * ink_mask_g,
        gg * (1.0 - ink_mask_g) + 0.036 * ink_mask_g,
        gb * (1.0 - ink_mask_g) + 0.060 * ink_mask_g,
    ], axis=-1)

    gunmetal_rough = np.clip(0.45 + ink_mask_g * 0.35, 0.28, 0.88)
    gunmetal_rough_rgb = np.stack([gunmetal_rough, gunmetal_rough, gunmetal_rough], axis=-1)
    gunmetal_height = np.clip(0.80 - ink_g * 0.44 - riv_g * 0.26 - vent_g * 0.46 + tone_g * 0.20, 0.0, 1.0)
    gunmetal_normal = _height_to_normal(gunmetal_height, strength=2.35)

    return {
        "ceramic_albedo":  _save_and_pack_image("Tex_OpenCodeCeramic_Albedo",  os.path.join(TEX_DIR, "ceramic_armor_albedo.png"),   ceramic_albedo, "sRGB"),
        "ceramic_rough":   _save_and_pack_image("Tex_OpenCodeCeramic_Rough",   os.path.join(TEX_DIR, "ceramic_armor_rough.png"),    ceramic_rough_rgb, "Non-Color"),
        "ceramic_normal":  _save_and_pack_image("Tex_OpenCodeCeramic_Normal",  os.path.join(TEX_DIR, "ceramic_armor_normal.png"),   ceramic_normal, "Non-Color"),
        "gunmetal_albedo": _save_and_pack_image("Tex_OpenCodeGunmetal_Albedo", os.path.join(TEX_DIR, "gunmetal_chassis_albedo.png"), gunmetal_albedo, "sRGB"),
        "gunmetal_rough":  _save_and_pack_image("Tex_OpenCodeGunmetal_Rough",  os.path.join(TEX_DIR, "gunmetal_chassis_rough.png"),  gunmetal_rough_rgb, "Non-Color"),
        "gunmetal_normal": _save_and_pack_image("Tex_OpenCodeGunmetal_Normal", os.path.join(TEX_DIR, "gunmetal_chassis_normal.png"), gunmetal_normal, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. OpenCode Mecha Comic / Cel-Shaded NPR Materials (EEVEE Cel + glTF Fallback)
# ---------------------------------------------------------------------------

def set_bsdf_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return bsdf.inputs[n]
    return None


def make_comic_cel_mat(
    name,
    cel_bands,
    albedo_img=None,
    normal_img=None,
    uv_scale=0.56,
    normal_strength=0.22,
    spec_strength=0.18,
    spec_roughness=0.22,
    spec_threshold=0.70,
    rim_strength=0.16,
    rim_color=(0.88, 0.93, 1.0),
    ao_strength=0.62,
    ao_distance=0.70,
    gltf_base_color=None,
    gltf_metallic=0.15,
    gltf_roughness=0.58,
):
    """Build a dual-output Mecha Comic Cel-Shaded material:
      - EEVEE Output (target='EEVEE'): True 4-band stepped anime cel shading via Diffuse -> ShaderToRGB
        -> stepped ColorRamp, multiplied by hand-inked 2048px panel art & stepped AO crevice ink,
        plus sharp comic specular catchlights and subtle cool Fresnel edge rim!
      - ALL Output (target='ALL'): Clean Principled BSDF with the comic-inked texture for glTF export.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    # --- Output A: EEVEE NPR Comic Cel Output (Active in EEVEE Viewport & Renders!) ---
    out_eevee = nt.nodes.new("ShaderNodeOutputMaterial")
    out_eevee.name = "Comic_EEVEE_Output"
    out_eevee.target = "EEVEE"
    out_eevee.location = (1280, 220)

    # --- Output B: glTF-Compatible Principled Fallback (target='ALL') ---
    out_all = nt.nodes.new("ShaderNodeOutputMaterial")
    out_all.name = "Comic_Export_Output"
    out_all.target = "ALL"
    out_all.location = (1280, -340)

    # Optional UV + Hand-Inked 2048px Texture Nodes (shared cleanly by both EEVEE Cel & glTF BSDF)
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

    # 1. Stepped Diffuse Cel Ramp (Diffuse BSDF -> ShaderToRGB -> RGBToBW -> Stepped ColorRamp)
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

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (280, 480)
    cr = ramp.color_ramp
    cr.interpolation = "LINEAR"
    # Build ultra-crisp anti-aliased stepped cel bands (each band step uses a tight 0.025 transition)
    while len(cr.elements) > 2:
        cr.elements.remove(cr.elements[-1])
    cr.elements[0].position = cel_bands[0][0]
    cr.elements[0].color = (*cel_bands[0][1], 1.0)
    cr.elements[1].position = cel_bands[-1][0]
    cr.elements[1].color = (*cel_bands[-1][1], 1.0)
    for pos, col_rgb in cel_bands[1:-1]:
        el = cr.elements.new(pos)
        el.color = (*col_rgb, 1.0)
    nt.links.new(rgb2bw.outputs["Val"], ramp.inputs["Fac"])

    cel_socket = ramp.outputs["Color"]

    # 2. Multiply Cel Ramp by Hand-Inked 2048px Panel Linework Texture
    if tex_col is not None:
        mix_tex = nt.nodes.new("ShaderNodeMix")
        mix_tex.data_type = "RGBA"
        mix_tex.blend_type = "MULTIPLY"
        mix_tex.location = (560, 360)
        mix_tex.inputs["Factor"].default_value = 1.0
        nt.links.new(cel_socket, mix_tex.inputs["A"])
        nt.links.new(tex_col.outputs["Color"], mix_tex.inputs["B"])
        cel_socket = mix_tex.outputs["Result"]

    # 3. Stepped Ambient Occlusion Ink Crevice Shading (makes mechanical recesses pop like manga ink!)
    if ao_strength > 0.0:
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.location = (80, 120)
        ao.inputs["Distance"].default_value = ao_distance

        ao_ramp = nt.nodes.new("ShaderNodeValToRGB")
        ao_ramp.location = (280, 120)
        ao_cr = ao_ramp.color_ramp
        ao_cr.elements[0].position = 0.22
        ao_cr.elements[0].color = (0.28, 0.32, 0.44, 1.0)
        ao_cr.elements[1].position = 0.56
        ao_cr.elements[1].color = (1.0, 1.0, 1.0, 1.0)
        nt.links.new(ao.outputs["AO"], ao_ramp.inputs["Fac"])

        mix_ao = nt.nodes.new("ShaderNodeMix")
        mix_ao.data_type = "RGBA"
        mix_ao.blend_type = "MULTIPLY"
        mix_ao.location = (740, 300)
        mix_ao.inputs["Factor"].default_value = ao_strength
        nt.links.new(cel_socket, mix_ao.inputs["A"])
        nt.links.new(ao_ramp.outputs["Color"], mix_ao.inputs["B"])
        cel_socket = mix_ao.outputs["Result"]

    # 4. Sharp Stepped Anime Specular Highlight Pop (on beveled armor & metallic trim!)
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

        sramp = nt.nodes.new("ShaderNodeValToRGB")
        sramp.location = (280, -40)
        scr = sramp.color_ramp
        scr.elements[0].position = max(0.05, spec_threshold - 0.03)
        scr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
        scr.elements[1].position = min(0.98, spec_threshold + 0.03)
        scr.elements[1].color = (1.0, 1.0, 1.0, 1.0)
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

    # 5. Subtle Crisp Grazing Anime Fresnel Rim Catchlight
    if rim_strength > 0.0:
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.location = (280, -240)
        lw.inputs["Blend"].default_value = 0.25

        rramp = nt.nodes.new("ShaderNodeValToRGB")
        rramp.location = (500, -240)
        rcr = rramp.color_ramp
        rcr.elements[0].position = 0.64
        rcr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
        rcr.elements[1].position = 0.72
        rcr.elements[1].color = (*rim_color, 1.0)
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

    # Plug final pure Cel color into Emission(1.0) on EEVEE Output (exact graphic anime tones!)
    emis_cel = nt.nodes.new("ShaderNodeEmission")
    emis_cel.location = (1140, 220)
    emis_cel.inputs["Strength"].default_value = 1.0
    nt.links.new(cel_socket, emis_cel.inputs["Color"])
    nt.links.new(emis_cel.outputs["Emission"], out_eevee.inputs["Surface"])

    # --- Build clean Principled BSDF for glTF / Three.js Export Output (target='ALL') ---
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


def make_solid_pbr_mat(
    name,
    base_color,
    metallic=0.0,
    roughness=0.25,
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
        if hasattr(mat, "shadow_method"):
            try:
                mat.shadow_method = "NONE"
            except Exception:
                pass
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    return {
        # Primary Mecha Comic White-Ceramic Hull Armor (Crisp white lit -> Periwinkle mid -> Cool Anime Cobalt shadow!)
        "armor_white": make_comic_cel_mat(
            "Mat_OpenCode_WhiteCeramic",
            cel_bands=[
                (0.00, (0.17, 0.24, 0.39)),
                (0.16, (0.17, 0.24, 0.39)),
                (0.19, (0.44, 0.53, 0.69)),
                (0.45, (0.44, 0.53, 0.69)),
                (0.48, (0.84, 0.88, 0.94)),
                (0.80, (0.84, 0.88, 0.94)),
                (0.83, (0.99, 0.995, 1.00)),
                (1.00, (0.99, 0.995, 1.00)),
            ],
            albedo_img=tex["ceramic_albedo"],
            normal_img=tex["ceramic_normal"],
            uv_scale=0.54,
            normal_strength=0.18,
            spec_strength=0.16,
            spec_roughness=0.22,
            spec_threshold=0.72,
            rim_strength=0.14,
            ao_strength=0.78,
            ao_distance=0.80,
            gltf_base_color=(0.88, 0.91, 0.96),
            gltf_metallic=0.12,
            gltf_roughness=0.56,
        ),
        # Bright Comic Porcelain Overlay Armor Plates (multi-layered plate contrast)
        "armor_bright": make_comic_cel_mat(
            "Mat_OpenCode_BrightCeramic",
            cel_bands=[
                (0.00, (0.26, 0.34, 0.50)),
                (0.14, (0.26, 0.34, 0.50)),
                (0.17, (0.58, 0.65, 0.79)),
                (0.41, (0.58, 0.65, 0.79)),
                (0.44, (0.91, 0.94, 0.98)),
                (0.78, (0.91, 0.94, 0.98)),
                (0.81, (1.00, 1.00, 1.00)),
                (1.00, (1.00, 1.00, 1.00)),
            ],
            albedo_img=tex["ceramic_albedo"],
            normal_img=tex["ceramic_normal"],
            uv_scale=0.62,
            normal_strength=0.16,
            spec_strength=0.20,
            spec_roughness=0.20,
            spec_threshold=0.70,
            rim_strength=0.16,
            ao_strength=0.60,
            ao_distance=0.65,
            gltf_base_color=(0.95, 0.97, 1.00),
            gltf_metallic=0.10,
            gltf_roughness=0.50,
        ),
        # Cool Anime Periwinkle-Slate Secondary Hull Plating, Spine Plates & Ring Clamps
        "armor_slate": make_comic_cel_mat(
            "Mat_OpenCode_SlateCeramic",
            cel_bands=[
                (0.00, (0.14, 0.19, 0.32)),
                (0.15, (0.14, 0.19, 0.32)),
                (0.18, (0.34, 0.42, 0.57)),
                (0.43, (0.34, 0.42, 0.57)),
                (0.46, (0.64, 0.71, 0.82)),
                (0.79, (0.64, 0.71, 0.82)),
                (0.82, (0.82, 0.87, 0.95)),
                (1.00, (0.82, 0.87, 0.95)),
            ],
            albedo_img=tex["ceramic_albedo"],
            normal_img=tex["ceramic_normal"],
            uv_scale=0.64,
            normal_strength=0.20,
            spec_strength=0.18,
            spec_roughness=0.24,
            spec_threshold=0.72,
            rim_strength=0.14,
            ao_strength=0.68,
            ao_distance=0.70,
            gltf_base_color=(0.66, 0.73, 0.84),
            gltf_metallic=0.18,
            gltf_roughness=0.58,
        ),
        # Readable Anime Dark Steel-Navy Mechanical Core, Truss Inner Ring & Machinery Bays
        "gunmetal_chassis": make_comic_cel_mat(
            "Mat_OpenCode_GunmetalChassis",
            cel_bands=[
                (0.00, (0.055, 0.072, 0.125)),
                (0.16, (0.055, 0.072, 0.125)),
                (0.19, (0.140, 0.175, 0.270)),
                (0.46, (0.140, 0.175, 0.270)),
                (0.49, (0.280, 0.335, 0.460)),
                (0.80, (0.280, 0.335, 0.460)),
                (0.83, (0.440, 0.510, 0.640)),
                (1.00, (0.440, 0.510, 0.640)),
            ],
            albedo_img=tex["gunmetal_albedo"],
            normal_img=tex["gunmetal_normal"],
            uv_scale=0.76,
            normal_strength=0.22,
            spec_strength=0.26,
            spec_roughness=0.20,
            spec_threshold=0.68,
            rim_strength=0.18,
            rim_color=(0.74, 0.82, 1.0),
            ao_strength=0.72,
            ao_distance=0.75,
            gltf_base_color=(0.28, 0.33, 0.45),
            gltf_metallic=0.35,
            gltf_roughness=0.52,
        ),
        # Crisp Anime Anodized Steel for Warren-Truss Girders, Clamps, Barrels & Thruster Shrouds
        "steel_trim": make_comic_cel_mat(
            "Mat_OpenCode_SteelTrim",
            cel_bands=[
                (0.00, (0.045, 0.058, 0.098)),
                (0.16, (0.045, 0.058, 0.098)),
                (0.19, (0.125, 0.152, 0.225)),
                (0.46, (0.125, 0.152, 0.225)),
                (0.49, (0.255, 0.298, 0.395)),
                (0.80, (0.255, 0.298, 0.395)),
                (0.83, (0.480, 0.540, 0.660)),
                (1.00, (0.480, 0.540, 0.660)),
            ],
            spec_strength=0.34,
            spec_roughness=0.18,
            spec_threshold=0.66,
            rim_strength=0.20,
            rim_color=(0.76, 0.84, 1.0),
            ao_strength=0.70,
            ao_distance=0.60,
            gltf_base_color=(0.24, 0.28, 0.38),
            gltf_metallic=0.45,
            gltf_roughness=0.44,
        ),
        # Classic Anime Brushed Chrome Hydraulic Rods, Pipes & Couplers
        "chrome_pipe": make_comic_cel_mat(
            "Mat_OpenCode_ChromePipe",
            cel_bands=[
                (0.00, (0.14, 0.19, 0.30)),
                (0.20, (0.14, 0.19, 0.30)),
                (0.23, (0.38, 0.45, 0.58)),
                (0.52, (0.38, 0.45, 0.58)),
                (0.55, (0.76, 0.82, 0.92)),
                (0.82, (0.76, 0.82, 0.92)),
                (0.85, (1.00, 1.00, 1.00)),
                (1.00, (1.00, 1.00, 1.00)),
            ],
            spec_strength=0.52,
            spec_roughness=0.14,
            spec_threshold=0.62,
            rim_strength=0.24,
            ao_strength=0.55,
            ao_distance=0.50,
            gltf_base_color=(0.74, 0.80, 0.90),
            gltf_metallic=0.68,
            gltf_roughness=0.28,
        ),
        # Dark Ink-Slate Mechanical Ribs, Vanes & Louvers
        "dark_machinery": make_comic_cel_mat(
            "Mat_OpenCode_DarkMachinery",
            cel_bands=[
                (0.00, (0.030, 0.038, 0.065)),
                (0.22, (0.030, 0.038, 0.065)),
                (0.25, (0.088, 0.106, 0.160)),
                (0.56, (0.088, 0.106, 0.160)),
                (0.59, (0.175, 0.208, 0.285)),
                (1.00, (0.175, 0.208, 0.285)),
            ],
            spec_strength=0.22,
            spec_roughness=0.24,
            spec_threshold=0.70,
            rim_strength=0.14,
            ao_strength=0.65,
            ao_distance=0.50,
            gltf_base_color=(0.12, 0.14, 0.21),
            gltf_metallic=0.35,
            gltf_roughness=0.55,
        ),
        # Deep Comic Shadow Ink Cavities, Jaw Throat & Portal Deck Recesses
        "cavity_dark": make_comic_cel_mat(
            "Mat_OpenCode_CavityDark",
            cel_bands=[
                (0.00, (0.016, 0.020, 0.036)),
                (0.45, (0.016, 0.020, 0.036)),
                (0.50, (0.042, 0.052, 0.085)),
                (1.00, (0.042, 0.052, 0.085)),
            ],
            spec_strength=0.0,
            rim_strength=0.0,
            ao_strength=0.50,
            gltf_base_color=(0.03, 0.036, 0.06),
            gltf_metallic=0.10,
            gltf_roughness=0.80,
        ),
        # Comic Indigo-Violet Stern Reactor Canyon Bulkhead
        "stern_indigo": make_comic_cel_mat(
            "Mat_OpenCode_SternIndigoCore",
            cel_bands=[
                (0.00, (0.09, 0.06, 0.22)),
                (0.26, (0.09, 0.06, 0.22)),
                (0.29, (0.20, 0.12, 0.44)),
                (0.62, (0.20, 0.12, 0.44)),
                (0.65, (0.34, 0.20, 0.64)),
                (1.00, (0.34, 0.20, 0.64)),
            ],
            spec_strength=0.20,
            rim_strength=0.22,
            rim_color=(0.72, 0.48, 1.0),
            ao_strength=0.55,
            gltf_base_color=(0.20, 0.12, 0.44),
            gltf_metallic=0.30,
            gltf_roughness=0.46,
        ),
        # Graphic Anime Electric Royal-Violet Perimeter LED Strips (zero pink shift under Standard CM!)
        "violet_neon": make_solid_pbr_mat(
            "Mat_OpenCode_VioletNeonTrim",
            base_color=(0.44, 0.16, 1.0),
            metallic=0.0,
            roughness=0.20,
            emission_color=(0.42, 0.14, 1.0),
            emission_strength=1.42,
        ),
        # Crisp Graphic Electric-Violet 3D Wireframe Lattice Grid Bars
        "violet_grid": make_solid_pbr_mat(
            "Mat_OpenCode_PortalHoloGrid",
            base_color=(0.50, 0.22, 1.0),
            metallic=0.0,
            roughness=0.18,
            emission_color=(0.48, 0.18, 1.0),
            emission_strength=1.55,
        ),
        # Sheer Graphic Comic Violet Forcefield Membrane
        "violet_field": make_solid_pbr_mat(
            "Mat_OpenCode_PortalHoloField",
            base_color=(0.34, 0.10, 0.96),
            metallic=0.0,
            roughness=0.12,
            alpha=0.18,
            emission_color=(0.34, 0.10, 0.98),
            emission_strength=0.98,
        ),
        # Graphic Violet Accent Strip for Ring Stabilizer Slits & Stern Canyon Slits
        "violet_accent": make_solid_pbr_mat(
            "Mat_OpenCode_VioletAccentStrip",
            base_color=(0.42, 0.14, 1.0),
            metallic=0.0,
            roughness=0.22,
            emission_color=(0.40, 0.12, 1.0),
            emission_strength=1.35,
        ),
        # Anime Blazing Royal-Violet Stern Thruster Chamber Glow
        "thruster_violet": make_solid_pbr_mat(
            "Mat_OpenCode_ThrusterVioletGlow",
            base_color=(0.40, 0.10, 1.0),
            metallic=0.0,
            roughness=0.18,
            emission_color=(0.38, 0.08, 1.0),
            emission_strength=1.65,
        ),
        # Crisp Anime Cool Lavender-White Hot Stern Thruster Core
        "thruster_core": make_solid_pbr_mat(
            "Mat_OpenCode_ThrusterHotCore",
            base_color=(0.88, 0.80, 1.0),
            metallic=0.0,
            roughness=0.12,
            emission_color=(0.82, 0.70, 1.0),
            emission_strength=1.95,
        ),
        # Vibrant Comic Warm Amber-Gold Portal Gallery Windows!
        "amber_window": make_solid_pbr_mat(
            "Mat_OpenCode_PortalAmberWindow",
            base_color=(1.0, 0.78, 0.24),
            metallic=0.0,
            roughness=0.20,
            emission_color=(1.0, 0.74, 0.18),
            emission_strength=1.70,
        ),
        # Crisp Cool Ice-Lavender Micro Status Pips
        "cool_micro_light": make_solid_pbr_mat(
            "Mat_OpenCode_CoolMicroLight",
            base_color=(0.86, 0.80, 1.0),
            metallic=0.0,
            roughness=0.18,
            emission_color=(0.80, 0.72, 1.0),
            emission_strength=1.50,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Precision Hard-Surface BMesh Geometry Helpers
# ---------------------------------------------------------------------------

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
    uv_tile_m=6.0,
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

    # Preserve watertight manifold topology (essential for dual-weight LineArt Silhouette vs Creases!)
    # and mark sharp shading edges via Blender 5.3 native `sharp_edge` attribute instead of splitting!
    sharp_flags = None
    if smooth and sharp_angle_deg is not None and sharp_angle_deg < 179.0:
        rad = math.radians(sharp_angle_deg)
        bm.edges.ensure_lookup_table()
        sharp_flags = [
            (len(e.link_faces) == 2 and e.calc_face_angle(0.0) > rad)
            for e in bm.edges
        ]

    apply_world_box_uv(bm, tile_meters=uv_tile_m)

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    if sharp_flags is not None and any(sharp_flags) and len(sharp_flags) == len(mesh.edges):
        attr = mesh.attributes.get("sharp_edge") or mesh.attributes.new(
            name="sharp_edge", type="BOOLEAN", domain="EDGE"
        )
        attr.data.foreach_set("value", sharp_flags)
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
        if b > 1e-4:
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
    segments=20, rot=(0.0, 0.0, 0.0), bevel=0.010,
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


def add_beam_between(name, p0, p1, width_x, width_y, mat, col, bevel=0.014, parent=None):
    """Create a beveled structural beam spanning cleanly from 3D point p0 to p1."""
    v0 = Vector(p0)
    v1 = Vector(p1)
    diff = v1 - v0
    length = diff.length
    if length < 1e-5:
        return None
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

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= width_x
        v.co.y *= width_y
        v.co.z *= length
    if bevel > 0.0:
        b = min(bevel, min(width_x, width_y, length) * 0.35)
        if b > 1e-4:
            bmesh.ops.bevel(
                bm, geom=list(bm.edges), offset=b, offset_type="OFFSET",
                segments=1, profile=0.5, affect="EDGES", clamp_overlap=True,
            )
    bmesh.ops.transform(bm, matrix=rot_mat, verts=bm.verts)
    bmesh.ops.translate(bm, vec=mid, verts=bm.verts)
    return finalize_mesh(bm, name, mat, col, smooth=True, sharp_angle_deg=38.0, parent=parent)


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


def add_extruded_poly_x(name, poly_yz, x0, x1, mat, col, bevel=0.03, bevel_segments=2, parent=None, uv_tile_m=6.0):
    """Extrude a 2D (y, z) polygon along X from x0 to x1 with clean edge bevels."""
    sec0 = [(x0, y, z) for (y, z) in poly_yz]
    sec1 = [(x1, y, z) for (y, z) in poly_yz]
    return add_lofted_sections(
        name, [sec0, sec1], mat, col,
        bevel=bevel, bevel_segments=bevel_segments,
        cap_start=True, cap_end=True, smooth=True, sharp_angle_deg=34.0, parent=parent, uv_tile_m=uv_tile_m,
    )


def add_hollow_ring_y(name, outer_xz, inner_xz, y_back, y_front, mat, col, bevel=0.03, bevel_segments=2, parent=None):
    """Build a crisp closed hollow polygonal ring extruded along Y from y_back to y_front."""
    bm = bmesh.new()
    n = len(outer_xz)
    o_b = [bm.verts.new((x, y_back, z)) for (x, z) in outer_xz]
    o_f = [bm.verts.new((x, y_front, z)) for (x, z) in outer_xz]
    i_b = [bm.verts.new((x, y_back, z)) for (x, z) in inner_xz]
    i_f = [bm.verts.new((x, y_front, z)) for (x, z) in inner_xz]

    for k in range(n):
        nk = (k + 1) % n
        bm.faces.new((o_b[k], o_b[nk], o_f[nk], o_f[k]))
        bm.faces.new((i_f[k], i_f[nk], i_b[nk], i_b[k]))
        bm.faces.new((o_f[k], o_f[nk], i_f[nk], i_f[k]))
        bm.faces.new((i_b[k], i_b[nk], o_b[nk], o_b[k]))

    return finalize_mesh(
        bm, name, mat, col,
        bevel_offset=bevel, bevel_segments=bevel_segments,
        smooth=True, sharp_angle_deg=34.0, parent=parent,
    )


def add_polyline_strip(name, pts, width_x, thickness_yz, mat, col, bevel=0.008, parent=None):
    """Build a continuous connected neon/trim strip following a 3D polyline seamlessly at every joint."""
    for idx in range(len(pts) - 1):
        p0 = Vector(pts[idx])
        p1 = Vector(pts[idx + 1])
        d = p1 - p0
        if d.length < 1e-4:
            continue
        dir_n = d.normalized()
        pad = min(thickness_yz * 0.48, d.length * 0.25)
        add_beam_between(
            f"{name}_Seg{idx:02d}",
            p0 - dir_n * pad,
            p1 + dir_n * pad,
            width_x,
            thickness_yz,
            mat,
            col,
            bevel=bevel,
            parent=parent,
        )


def make_sym_oct_xz(hw, hh, chamfer):
    """Exact 100% X- and Z-symmetric octagon vertices in CCW order in XZ plane."""
    wx = hw - chamfer
    hz = hh - chamfer
    return [
        ( wx,  hh),
        (-wx,  hh),
        (-hw,  hz),
        (-hw, -hz),
        (-wx, -hh),
        ( wx, -hh),
        ( hw, -hz),
        ( hw,  hz),
    ]


def inset_oct_xz(hw, hh, chamfer, inset):
    """Exact uniform normal inward offset of a 45-deg symmetric octagon."""
    k = 2.0 - math.sqrt(2.0)
    return make_sym_oct_xz(hw - inset, hh - inset, max(0.05, chamfer - inset * k))


def add_rcs_cluster(name, center, mats, col, rot=(0.0, 0.0, 0.0), scale=1.0, parent=None):
    """Twin-nozzle recessed military aerospace RCS maneuvering thruster block."""
    bm_frame = bmesh.new()
    bmesh.ops.create_cube(bm_frame, size=1.0)
    for v in bm_frame.verts:
        v.co.x *= 0.26 * scale
        v.co.y *= 0.44 * scale
        v.co.z *= 0.16 * scale
    bmesh.ops.bevel(bm_frame, geom=list(bm_frame.edges), offset=0.015 * scale, segments=2, affect="EDGES", clamp_overlap=True)
    rmat = Euler(rot, "XYZ").to_matrix().to_4x4()
    bmesh.ops.transform(bm_frame, matrix=rmat, verts=bm_frame.verts)
    bmesh.ops.translate(bm_frame, vec=Vector(center), verts=bm_frame.verts)
    finalize_mesh(bm_frame, f"{name}_Frame", mats["steel_trim"], col, parent=parent)

    for j, dy in enumerate((-0.10 * scale, 0.10 * scale)):
        local_off = rmat @ Vector((0.0, dy, 0.06 * scale))
        add_cylinder(
            f"{name}_Nozzle_{j}",
            Vector(center) + local_off,
            0.052 * scale,
            0.09 * scale,
            mats["cavity_dark"],
            col,
            segments=12,
            rot=rot,
            bevel=0.006 * scale,
            parent=parent,
        )


# ---------------------------------------------------------------------------
# 4. Collection 01: Main Upper & Lower Armored Gate-Hull Beams (100% Symmetric!)
# ---------------------------------------------------------------------------

def build_main_gate_hull(mats, col, root):
    """Construct the iconic OpenCode hollow-frame white-ceramic composite upper & lower hull beams."""

    # --- 4A. UPPER DORSAL ARMOR BEAM (Y in [-9.90, +10.85], Z in [+2.55, +4.45], bow slopes to +1.15) ---
    # Each station: (y, z_bot, z_mid_bot, z_mid_top, z_top, x_bot, x_max, x_top)
    upper_stations = [
        (-9.90,  2.55,  2.78,  3.82,  4.18,  2.10,  2.52,  1.50),
        (-9.10,  2.55,  2.82,  3.95,  4.36,  2.28,  2.74,  1.65),
        (-6.20,  2.55,  2.82,  3.98,  4.42,  2.42,  2.96,  1.72),
        (-5.10,  2.55,  2.84,  4.00,  4.45,  2.48,  3.08,  1.76),
        (-2.85,  2.55,  2.84,  4.00,  4.45,  2.48,  3.08,  1.76),
        (-2.20,  2.62,  2.92,  4.02,  4.45,  2.22,  2.56,  1.66),
        ( 0.65,  2.62,  2.92,  4.02,  4.45,  2.22,  2.56,  1.66),
        ( 1.30,  2.55,  2.84,  4.00,  4.45,  2.48,  3.10,  1.78),
        ( 4.10,  2.55,  2.84,  4.00,  4.45,  2.48,  3.10,  1.78),
        ( 5.35,  1.92,  2.40,  3.92,  4.42,  2.44,  3.06,  1.74),
        ( 6.75,  1.15,  1.65,  3.35,  3.88,  2.36,  2.96,  1.64),
        ( 8.60,  1.15,  1.52,  2.56,  2.98,  2.22,  2.66,  1.48),
        (10.20,  1.15,  1.42,  1.92,  2.22,  1.96,  2.26,  1.32),
        (10.85,  1.15,  1.34,  1.68,  1.90,  1.74,  1.96,  1.18),
    ]

    def make_upper_ring(st):
        y, zb, zmb, zmt, zt, xb, xm, xt = st
        return [
            (-xt, y, zt),
            ( xt, y, zt),
            ( xm, y, zmt),
            ( xm, y, zmb),
            ( xb, y, zb),
            (-xb, y, zb),
            (-xm, y, zmb),
            (-xm, y, zmt),
        ]

    add_lofted_sections(
        "Hull_UpperArmorBeam_Main",
        [make_upper_ring(s) for s in upper_stations],
        mats["armor_white"],
        col,
        bevel=0.045,
        bevel_segments=2,
        parent=root,
        uv_tile_m=6.2,
    )

    # Conformal tapered layered ceramic armor cheek overlays (HUGS bow taper cleanly — ZERO overhang!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Forward upper conformal cheek slab (lofted across Y so X follows exact hull taper!)
        # Stations: (y, x_inner, x_outer, z_bot, z_top)
        u_cheek_st = [
            ( 1.45, 2.94, 3.16, 2.78, 3.96),
            ( 4.10, 2.94, 3.16, 2.78, 3.96),
            ( 5.35, 2.90, 3.12, 2.34, 3.88),
            ( 6.75, 2.80, 3.02, 1.56, 3.28),
            ( 8.60, 2.50, 2.72, 1.46, 2.50),
            (10.15, 2.12, 2.31, 1.38, 1.88),
        ]
        u_cheek_secs = []
        for (y, xi, xo, zb, zt) in u_cheek_st:
            ring = [
                (side * xi, y, zt),
                (side * xo, y, zt - 0.08),
                (side * xo, y, zb + 0.08),
                (side * xi, y, zb),
            ]
            if side < 0:
                ring.reverse()
            u_cheek_secs.append(ring)
        add_lofted_sections(
            f"Hull_UpperFwdCheekPlate_{tag}",
            u_cheek_secs,
            mats["armor_bright"],
            col,
            bevel=0.032,
            bevel_segments=2,
            parent=root,
        )

        # Forward upper sloped glacis stepped armor tiles (3 crisp overlapping ceramic steps!)
        for k, (y0, y1, z0, z1, hw0, hw1) in enumerate((
            (5.45, 7.10, 4.38, 3.68, 1.62, 1.54),
            (7.22, 8.75, 3.60, 2.92, 1.52, 1.42),
            (8.88, 10.22, 2.84, 2.22, 1.40, 1.28),
        )):
            secs = [
                [
                    (side * 0.68, y0, z0 + 0.06),
                    (side * hw0, y0, z0 + 0.03),
                    (side * (hw0 + 0.84), y0, z0 - 0.40),
                    (side * (hw0 + 0.76), y0, z0 - 0.54),
                    (side * 0.68, y0, z0 - 0.14),
                ],
                [
                    (side * 0.68, y1, z1 + 0.06),
                    (side * hw1, y1, z1 + 0.03),
                    (side * (hw1 + 0.74), y1, z1 - 0.34),
                    (side * (hw1 + 0.66), y1, z1 - 0.48),
                    (side * 0.68, y1, z1 - 0.14),
                ],
            ]
            if side < 0:
                secs = [list(reversed(r)) for r in secs]
            add_lofted_sections(
                f"Hull_UpperBowGlacisTile_{tag}_{k}",
                secs,
                mats["armor_bright"] if k % 2 == 0 else mats["armor_white"],
                col,
                bevel=0.022,
                bevel_segments=2,
                parent=root,
            )

        # Aft upper flank armor rib behind the mid-hull notch (Y in [-6.05, -2.90])
        aft_cheek_yz = [
            (-6.05, 2.76),
            (-2.90, 2.76),
            (-2.90, 3.98),
            (-6.05, 3.94),
        ]
        add_extruded_poly_x(
            f"Hull_UpperAftCheekPlate_{tag}",
            aft_cheek_yz,
            side * 2.94 if side > 0 else side * 3.14,
            side * 3.14 if side > 0 else side * 2.94,
            mats["armor_bright"],
            col,
            bevel=0.034,
            bevel_segments=2,
            parent=root,
        )

        # Crisp 45-deg armored corner gusset blocks framing the upper mid-hull notch (TOP view signature!)
        for ny, sgn in ((-2.52, -1), (0.98, 1)):
            add_beveled_box(
                f"Hull_UpperNotchGusset_{tag}_{sgn:+d}",
                (side * 2.78, ny, 3.44),
                (0.56, 0.78, 1.18),
                mats["armor_slate"],
                col,
                bevel=0.032,
                rot=(0.0, 0.0, side * sgn * 0.52),
                parent=root,
            )

        # Mid-hull recessed dorsal bridge gallery dark recess + subtle violet micro-bar (SIDE & Hero!)
        add_beveled_box(
            f"Hull_UpperNotchRecess_{tag}",
            (side * 2.54, -0.78, 3.38),
            (0.18, 2.72, 0.74),
            mats["cavity_dark"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"Hull_UpperNotchTrimBar_{tag}",
            (side * 2.60, -0.78, 3.14),
            (0.08, 2.48, 0.10),
            mats["steel_trim"],
            col,
            bevel=0.012,
            parent=root,
        )
        add_beveled_box(
            f"Hull_UpperNotchGlow_{tag}",
            (side * 2.61, -0.78, 3.52),
            (0.05, 2.30, 0.055),
            mats["violet_accent"],
            col,
            bevel=0.008,
            parent=root,
        )
        for my in (-1.75, -1.10, -0.45, 0.20):
            add_beveled_box(
                f"Hull_UpperNotchMullion_{tag}_{my:+.2f}",
                (side * 2.62, my, 3.38),
                (0.08, 0.09, 0.70),
                mats["steel_trim"],
                col,
                bevel=0.008,
                parent=root,
            )

    # --- 4B. CENTRAL DORSAL SPINE CHANNEL & STEPPED ARMOR DECK (TOP View Signature!) ---
    # Subtle slate-armored recessed spine track down exact centerline X=0 (matches TOP ref clean ceramic look!)
    add_beveled_box(
        "Hull_DorsalSpineTrench",
        (0.0, 0.20, 4.41),
        (1.32, 11.90, 0.16),
        mats["armor_slate"],
        col,
        bevel=0.02,
        parent=root,
    )
    # 10 cleanly spaced stepped armor deck tiles along exact X=0 centerline (zero wobble!)
    for idx in range(10):
        yc = -5.20 + idx * 1.12
        dz = 0.025 if idx % 2 == 0 else 0.0
        add_beveled_box(
            f"Hull_DorsalSpineTile_{idx:02d}",
            (0.0, yc, 4.49 + dz),
            (1.12, 0.98, 0.11),
            mats["armor_bright"] if idx % 2 == 0 else mats["armor_white"],
            col,
            bevel=0.018,
            parent=root,
        )
    # Flanking long dorsal deck armor runners along X = ±1.18
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Hull_DorsalDeckRunner_{tag}",
            (side * 1.18, -0.25, 4.49),
            (0.86, 11.40, 0.12),
            mats["armor_white"],
            col,
            bevel=0.024,
            parent=root,
        )
        # Aft twin dorsal buttress shoulder blocks behind the ring (seen in TOP & REAR!)
        add_beveled_box(
            f"Hull_DorsalAftButtress_{tag}",
            (side * 1.78, -8.95, 3.88),
            (1.12, 2.75, 1.24),
            mats["armor_bright"],
            col,
            bevel=0.04,
            parent=root,
        )
        add_beveled_box(
            f"Hull_DorsalAftButtressCap_{tag}",
            (side * 1.78, -9.85, 3.74),
            (1.02, 0.95, 1.05),
            mats["armor_slate"],
            col,
            bevel=0.03,
            parent=root,
        )

    # Flush-seated forward sloped dorsal radiator louver bed + raised bow sensor pod!
    # Exact dorsal bow glacis slope: (y=5.35, z=4.42) -> (y=10.20, z=2.22), pitch = -atan2(2.20, 4.85) = -0.4259 rad
    dorsal_pitch = -math.atan2(2.20, 4.85)
    add_beveled_box(
        "Hull_BowDorsalLouverBed",
        (0.0, 6.90, 3.66),
        (1.22, 2.05, 0.22),
        mats["gunmetal_chassis"],
        col,
        bevel=0.02,
        rot=(dorsal_pitch, 0.0, 0.0),
        parent=root,
    )
    for lv in range(8):
        t = lv / 7.0
        yl = 6.08 + t * 1.64
        zl = 4.42 - 0.4536 * (yl - 5.35) + 0.04
        add_beveled_box(
            f"Hull_BowDorsalLouverFin_{lv:02d}",
            (0.0, yl, zl),
            (1.04, 0.10, 0.12),
            mats["steel_trim"],
            col,
            bevel=0.01,
            rot=(dorsal_pitch, 0.0, 0.0),
            parent=root,
        )
    # Raised flush-seated armored forward bow dorsal sensor pod (FRONT & TOP views!)
    z_pod = 4.42 - 0.4536 * (8.85 - 5.35) + 0.06
    add_beveled_box(
        "Hull_BowDorsalPodBase",
        (0.0, 8.85, z_pod),
        (1.66, 1.62, 0.44),
        mats["armor_bright"],
        col,
        bevel=0.036,
        rot=(dorsal_pitch, 0.0, 0.0),
        parent=root,
    )
    add_beveled_box(
        "Hull_BowDorsalPodCap",
        (0.0, 8.95, z_pod + 0.18),
        (1.16, 1.06, 0.22),
        mats["armor_white"],
        col,
        bevel=0.026,
        rot=(dorsal_pitch, 0.0, 0.0),
        parent=root,
    )

    # --- 4C. LOWER VENTRAL ARMOR BEAM & ARMORED PROW KEEL (Y in [-9.90, +10.85]) ---
    lower_stations = [
        (-9.90, -2.55, -2.78, -3.82, -4.18,  2.10,  2.52,  1.50),
        (-9.10, -2.55, -2.82, -3.95, -4.36,  2.28,  2.74,  1.65),
        (-6.20, -2.55, -2.82, -3.98, -4.42,  2.42,  2.96,  1.72),
        (-5.10, -2.55, -2.84, -4.00, -4.45,  2.48,  3.08,  1.76),
        (-2.85, -2.55, -2.84, -4.00, -4.45,  2.48,  3.08,  1.76),
        (-2.20, -2.62, -2.92, -4.02, -4.45,  2.28,  2.76,  1.72),
        ( 0.65, -2.62, -2.92, -4.02, -4.45,  2.28,  2.76,  1.72),
        ( 1.55, -2.55, -2.84, -4.05, -4.55,  2.48,  3.10,  1.74),
        ( 3.20, -2.55, -2.84, -4.42, -5.05,  2.48,  3.10,  1.58),
        ( 4.10, -2.55, -2.84, -4.56, -5.28,  2.48,  3.10,  1.42),
        ( 5.45, -1.92, -2.40, -4.52, -5.32,  2.44,  3.06,  1.26),
        ( 6.75, -1.15, -1.65, -3.86, -4.64,  2.36,  2.96,  1.16),
        ( 8.60, -1.15, -1.52, -2.88, -3.52,  2.22,  2.66,  1.08),
        (10.20, -1.15, -1.42, -2.02, -2.38,  1.96,  2.26,  1.04),
        (10.85, -1.15, -1.34, -1.68, -1.90,  1.74,  1.96,  1.02),
    ]

    def make_lower_ring(st):
        y, zt, zmt, zmb, zb, xt, xm, xb = st
        return [
            (-xt, y, zt),
            ( xt, y, zt),
            ( xm, y, zmt),
            ( xm, y, zmb),
            ( xb, y, zb),
            (-xb, y, zb),
            (-xm, y, zmb),
            (-xm, y, zmt),
        ]

    add_lofted_sections(
        "Hull_LowerArmorBeam_Main",
        [make_lower_ring(s) for s in lower_stations],
        mats["armor_white"],
        col,
        bevel=0.045,
        bevel_segments=2,
        parent=root,
        uv_tile_m=6.2,
    )

    # Conformal tapered lower prow cheeks + FLUSH-RECESSED Symmetric Industrial Machinery Bays!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Forward lower conformal cheek slab (follows exact tapered X profile — ZERO overhang!)
        l_cheek_st = [
            ( 2.10, 2.94, 3.16, -4.24, -2.78),
            ( 4.10, 2.94, 3.16, -4.50, -2.78),
            ( 5.45, 2.90, 3.12, -4.46, -2.34),
            ( 6.75, 2.80, 3.02, -3.78, -1.56),
            ( 8.60, 2.50, 2.72, -2.80, -1.46),
            (10.15, 2.12, 2.31, -1.94, -1.38),
        ]
        l_cheek_secs = []
        for (y, xi, xo, zb, zt) in l_cheek_st:
            ring = [
                (side * xi, y, zt),
                (side * xo, y, zt - 0.08),
                (side * xo, y, zb + 0.08),
                (side * xi, y, zb),
            ]
            if side < 0:
                ring.reverse()
            l_cheek_secs.append(ring)
        add_lofted_sections(
            f"Hull_LowerFwdCheekPlate_{tag}",
            l_cheek_secs,
            mats["armor_bright"],
            col,
            bevel=0.032,
            bevel_segments=2,
            parent=root,
        )

        # Lower aft cheek armor collar behind machinery bay (Y in [-6.10, -4.50])
        aft_low_yz = [
            (-6.10, -2.76),
            (-4.50, -2.76),
            (-4.50, -4.16),
            (-6.10, -4.00),
        ]
        add_extruded_poly_x(
            f"Hull_LowerAftCheekPlate_{tag}",
            aft_low_yz,
            side * 2.92 if side > 0 else side * 3.14,
            side * 3.14 if side > 0 else side * 2.92,
            mats["armor_bright"],
            col,
            bevel=0.034,
            bevel_segments=2,
            parent=root,
        )

        # Lower aft twin buttress shoulder blocks (exact vertical mirror of upper aft buttresses!)
        add_beveled_box(
            f"Hull_VentralAftButtress_{tag}",
            (side * 1.78, -8.95, -3.88),
            (1.12, 2.75, 1.24),
            mats["armor_bright"],
            col,
            bevel=0.04,
            parent=root,
        )
        add_beveled_box(
            f"Hull_VentralAftButtressCap_{tag}",
            (side * 1.78, -9.85, -3.74),
            (1.02, 0.95, 1.05),
            mats["armor_slate"],
            col,
            bevel=0.03,
            parent=root,
        )

        # Recessed Lower Mid-Portal Notch Bezel (Y in [-2.40, +0.85], Z in [-2.98, -2.58])
        add_beveled_box(
            f"Hull_LowerNotchRecess_{tag}",
            (side * 2.72, -0.78, -2.82),
            (0.24, 3.05, 0.42),
            mats["cavity_dark"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"Hull_LowerNotchFrame_{tag}",
            (side * 2.82, -0.78, -2.88),
            (0.10, 2.80, 0.16),
            mats["steel_trim"],
            col,
            bevel=0.012,
            parent=root,
        )

        # --- FLUSH-FRAMED LOWER FLANK INDUSTRIAL MACHINERY BAYS (Hero & SIDE Signature!) ---
        # Cleanly integrated inside the smooth X=±3.08 lower flank envelope (no bulky protruding rails!)
        bay_y0, bay_y1 = -4.45, 2.00
        bay_yc = 0.5 * (bay_y0 + bay_y1)
        bay_len = bay_y1 - bay_y0
        add_beveled_box(
            f"MechBay_BackWall_{tag}",
            (side * 2.74, bay_yc, -3.68),
            (0.46, bay_len, 1.18),
            mats["cavity_dark"],
            col,
            bevel=0.015,
            parent=root,
        )
        add_beveled_box(
            f"MechBay_TopBezel_{tag}",
            (side * 2.90, bay_yc, -3.05),
            (0.46, bay_len + 0.20, 0.18),
            mats["armor_slate"],
            col,
            bevel=0.02,
            parent=root,
        )
        add_beveled_box(
            f"MechBay_BotBezel_{tag}",
            (side * 2.68, bay_yc, -4.30),
            (0.56, bay_len + 0.20, 0.18),
            mats["armor_slate"],
            col,
            bevel=0.02,
            parent=root,
        )
        # 4 flush vertical dividing armor bulkheads (3 crisp industrial bays!)
        for pi, py in enumerate((-4.42, -2.26, -0.10, 1.98)):
            add_beveled_box(
                f"MechBay_PillarArmor_{tag}_{pi}",
                (side * 2.94, py, -3.68),
                (0.32, 0.26, 1.24),
                mats["armor_slate"],
                col,
                bevel=0.02,
                parent=root,
            )
            add_beveled_box(
                f"MechBay_PillarRib_{tag}_{pi}",
                (side * 2.86, py, -3.68),
                (0.42, 0.12, 1.16),
                mats["steel_trim"],
                col,
                bevel=0.012,
                parent=root,
            )
        # Dense interior coolant pipes, hydraulic actuators, valve housings & radiator fins
        for z_pipe, r_pipe, m_key in ((-3.36, 0.10, "steel_trim"), (-3.64, 0.08, "chrome_pipe"), (-3.96, 0.11, "gunmetal_chassis")):
            add_cylinder(
                f"MechBay_MainPipe_{tag}_{z_pipe:+.2f}",
                (side * 2.90, bay_yc, z_pipe),
                r_pipe,
                bay_len - 0.18,
                mats[m_key],
                col,
                segments=14,
                rot=(math.pi * 0.5, 0.0, 0.0),
                bevel=0.008,
                parent=root,
            )
        for ci, (cy0, cy1) in enumerate(((-4.20, -2.45), (-2.06, -0.32), (0.10, 1.78))):
            cmid = 0.5 * (cy0 + cy1)
            add_beveled_box(
                f"MechBay_ManifoldBox_{tag}_{ci}",
                (side * 2.84, cmid, -3.55),
                (0.28, 0.72, 0.62),
                mats["gunmetal_chassis"],
                col,
                bevel=0.02,
                parent=root,
            )
            for k_fin in range(5):
                fy = cy0 + 0.18 + k_fin * 0.34
                add_beveled_box(
                    f"MechBay_ClampRib_{tag}_{ci}_{k_fin}",
                    (side * 2.92, fy, -3.68),
                    (0.20, 0.085, 1.00),
                    mats["dark_machinery"],
                    col,
                    bevel=0.01,
                    parent=root,
                )
            add_beam_between(
                f"MechBay_Actuator_{tag}_{ci}",
                (side * 2.94, cy0 + 0.18, -3.28),
                (side * 2.94, cy1 - 0.18, -4.06),
                0.075,
                0.075,
                mats["chrome_pipe"],
                col,
                bevel=0.008,
                parent=root,
            )

    # --- 4D. SYMMETRIC VENTRAL KEEL SPINE, FLUSH PROW INTAKE BLOCK & TWIN VENTRAL CANNONS ---
    add_beveled_box(
        "Hull_VentralKeelSpine",
        (0.0, -1.60, -4.46),
        (1.42, 9.60, 0.22),
        mats["armor_slate"],
        col,
        bevel=0.03,
        parent=root,
    )
    for k in range(7):
        yk = -5.60 + k * 1.25
        add_beveled_box(
            f"Hull_VentralKeelPlate_{k:02d}",
            (0.0, yk, -4.55),
            (1.10, 0.96, 0.11),
            mats["armor_white"] if k % 2 == 0 else mats["armor_slate"],
            col,
            bevel=0.018,
            parent=root,
        )

    # Flush-seated armored forward ventral docking/intake block & lower grille!
    # Exact ventral bow slope: (y=5.45, z=-5.32) -> (y=10.20, z=-2.38), slope = +2.94 / 4.75 = +0.6189, pitch = +0.5542 rad!
    ventral_pitch = math.atan2(2.94, 4.75)

    y_dock = 8.65
    z_dock = -5.32 + 0.6189 * (y_dock - 5.45) + 0.12
    add_beveled_box(
        "Hull_FrontVentralDockHousing",
        (0.0, y_dock, z_dock),
        (1.68, 1.56, 0.44),
        mats["gunmetal_chassis"],
        col,
        bevel=0.036,
        rot=(ventral_pitch, 0.0, 0.0),
        parent=root,
    )
    for dt in (-0.42, 0.0, 0.42):
        ys = y_dock + dt * math.cos(ventral_pitch) + 0.12 * math.sin(ventral_pitch)
        zs = z_dock + dt * math.sin(ventral_pitch) - 0.12 * math.cos(ventral_pitch)
        add_beveled_box(
            f"Hull_FrontVentralDockSlot_{dt:+.2f}",
            (0.0, ys, zs),
            (1.24, 0.20, 0.18),
            mats["cavity_dark"],
            col,
            bevel=0.012,
            rot=(ventral_pitch, 0.0, 0.0),
            parent=root,
        )

    # Lower flush-seated ventral radiator grille recessed cleanly along the prow slope!
    y_gr = 6.72
    z_gr = -5.32 + 0.6189 * (y_gr - 5.45) + 0.10
    add_beveled_box(
        "Hull_FrontVentralGrilleFrame",
        (0.0, y_gr, z_gr),
        (1.32, 1.24, 0.34),
        mats["steel_trim"],
        col,
        bevel=0.024,
        rot=(ventral_pitch, 0.0, 0.0),
        parent=root,
    )
    add_beveled_box(
        "Hull_FrontVentralGrilleCore",
        (0.0, y_gr + 0.04, z_gr - 0.06),
        (1.06, 0.94, 0.24),
        mats["cavity_dark"],
        col,
        bevel=0.012,
        rot=(ventral_pitch, 0.0, 0.0),
        parent=root,
    )

    # Twin Symmetric Forward Ventral Cannon / Sensor Barrels (Hero, SIDE & FRONT Views!)
    add_beveled_box(
        "Hull_VentralTurretMount",
        (0.0, 4.90, -5.36),
        (1.18, 2.15, 0.42),
        mats["gunmetal_chassis"],
        col,
        bevel=0.03,
        parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Hull_VentralCannonBreech_{tag}",
            (side * 0.34, 5.60, -5.56),
            (0.26, 1.38, 0.24),
            mats["steel_trim"],
            col,
            bevel=0.02,
            parent=root,
        )
        add_cylinder(
            f"Hull_VentralCannonBarrelMain_{tag}",
            (side * 0.34, 7.10, -5.58),
            0.068,
            2.12,
            mats["steel_trim"],
            col,
            segments=16,
            rot=(math.pi * 0.5, 0.0, 0.0),
            bevel=0.008,
            parent=root,
        )
        add_cylinder(
            f"Hull_VentralCannonBarrelTip_{tag}",
            (side * 0.34, 8.42, -5.58),
            0.046,
            0.66,
            mats["chrome_pipe"],
            col,
            segments=14,
            rot=(math.pi * 0.5, 0.0, 0.0),
            bevel=0.006,
            parent=root,
        )
        add_cylinder(
            f"Hull_VentralCannonMuzzle_{tag}",
            (side * 0.34, 8.72, -5.58),
            0.064,
            0.16,
            mats["dark_machinery"],
            col,
            segments=14,
            rot=(math.pi * 0.5, 0.0, 0.0),
            bevel=0.006,
            parent=root,
        )


# ---------------------------------------------------------------------------
# 5. Collection 02: Forward Split-Jaw Cleft, Hex Aperture & Industrial Conduits
# ---------------------------------------------------------------------------

def build_forward_jaw_and_cleft(mats, col, root):
    """Build the symmetric split-jaw bow cleft, faceted hexagonal mouth & heavy corner piping."""

    # --- 5A. SOLID FORWARD PORTAL BULKHEAD & TAPERED JAW CHASSIS CORE ---
    add_beveled_box(
        "Jaw_ForwardPortalBulkhead",
        (0.0, 4.78, 0.0),
        (3.84, 1.36, 5.14),
        mats["gunmetal_chassis"],
        col,
        bevel=0.04,
        parent=root,
    )
    add_beveled_box(
        "Jaw_ForwardPortalBulkheadRecess",
        (0.0, 4.14, 0.0),
        (2.85, 0.18, 4.56),
        mats["cavity_dark"],
        col,
        bevel=0.015,
        parent=root,
    )
    for rx in (-1.35, -0.45, 0.45, 1.35):
        add_beveled_box(
            f"Jaw_PortalWallRib_{rx:+.2f}",
            (rx, 4.18, 0.0),
            (0.18, 0.24, 4.78),
            mats["steel_trim"],
            col,
            bevel=0.016,
            parent=root,
        )

    # Tapered recessed horizontal split-jaw core running forward to bow mouth
    jaw_core_secs = [
        [(-1.92, 5.10,  1.20), (1.92, 5.10,  1.20), (1.92, 5.10, -1.20), (-1.92, 5.10, -1.20)],
        [(-1.74, 8.20,  1.16), (1.74, 8.20,  1.16), (1.74, 8.20, -1.16), (-1.74, 8.20, -1.16)],
        [(-1.42, 10.10, 1.12), (1.42, 10.10, 1.12), (1.42, 10.10, -1.12), (-1.42, 10.10, -1.12)],
    ]
    add_lofted_sections(
        "Jaw_CenterCoreChassis",
        jaw_core_secs,
        mats["gunmetal_chassis"],
        col,
        bevel=0.03,
        bevel_segments=2,
        parent=root,
    )

    # --- 5B. SYMMETRIC HEXAGONAL SPLIT-BOW JAW LIPS (FRONT View Signature!) ---
    for z_sgn, z_tag in ((1, "Upper"), (-1, "Lower")):
        for side, tag in ((-1, "Port"), (1, "Stbd")):
            add_beveled_box(
                f"Jaw_NoseCheek_{z_tag}_{tag}",
                (side * 1.48, 10.66, z_sgn * 1.46),
                (0.96, 0.68, 0.62),
                mats["armor_bright"],
                col,
                bevel=0.032,
                parent=root,
            )
            add_beveled_box(
                f"Jaw_NotchBevel_{z_tag}_{tag}",
                (side * 0.90, 10.62, z_sgn * 1.62),
                (0.46, 0.64, 0.44),
                mats["armor_white"],
                col,
                bevel=0.024,
                rot=(0.0, side * z_sgn * (-0.72), 0.0),
                parent=root,
            )
        add_beveled_box(
            f"Jaw_NotchCenterBrow_{z_tag}",
            (0.0, 10.56, z_sgn * 1.78),
            (1.62, 0.72, 0.34),
            mats["armor_white"],
            col,
            bevel=0.028,
            parent=root,
        )
        add_beveled_box(
            f"Jaw_MouthInnerShelf_{z_tag}",
            (0.0, 9.85, z_sgn * 1.14),
            (2.80, 1.72, 0.16),
            mats["cavity_dark"],
            col,
            bevel=0.012,
            parent=root,
        )
        # Delicate pinpoint micro-lights inside the front jaw lip
        for lx in (-1.28, -0.92, -0.56, 0.56, 0.92, 1.28):
            add_beveled_box(
                f"Jaw_MouthMicroLight_{z_tag}_{lx:+.2f}",
                (lx, 10.42, z_sgn * 1.07),
                (0.075, 0.06, 0.032),
                mats["cool_micro_light"],
                col,
                bevel=0.005,
                parent=root,
            )

    # --- 5C. DEEP CENTRAL FRONT SENSOR / DOCKING CAVITY (FRONT View!) ---
    add_beveled_box(
        "Jaw_FrontCavity",
        (0.0, 10.12, 0.0),
        (1.74, 0.60, 1.78),
        mats["cavity_dark"],
        col,
        bevel=0.02,
        parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Jaw_FrontInnerPillar_{tag}",
            (side * 0.74, 10.18, 0.0),
            (0.24, 0.76, 1.92),
            mats["steel_trim"],
            col,
            bevel=0.018,
            parent=root,
        )
        for z_bar in (-0.58, 0.0, 0.58):
            add_beveled_box(
                f"Jaw_FrontSideStrut_{tag}_{z_bar:+.2f}",
                (side * 1.18, 10.10, z_bar),
                (0.62, 0.52, 0.16),
                mats["dark_machinery"],
                col,
                bevel=0.012,
                parent=root,
            )
    add_beveled_box(
        "Jaw_FrontCoreBox",
        (0.0, 9.88, 0.0),
        (0.84, 0.42, 0.92),
        mats["steel_trim"],
        col,
        bevel=0.02,
        parent=root,
    )
    for sgn in (-1, 1):
        add_beam_between(
            f"Jaw_FrontCoreXBrace_{sgn:+d}",
            (-0.34, 10.12, -0.36 * sgn),
            ( 0.34, 10.12,  0.36 * sgn),
            0.09,
            0.09,
            mats["chrome_pipe"],
            col,
            bevel=0.008,
            parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Jaw_FrontSensorGlow_{tag}",
            (side * 0.30, 10.16, 0.0),
            (0.11, 0.05, 0.20),
            mats["violet_accent"],
            col,
            bevel=0.008,
            parent=root,
        )

    # --- 5D. ARCHITECTURAL SIDE CLEFT ARMOR GALLERY, CONDUIT PIPES & DELICATE PINPOINT LIGHTS ---
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Upper & lower heavy tapered armored cleft wall slabs with deep dark center intake channel!
        for z_sgn, z_tag in ((1, "Top"), (-1, "Bot")):
            cleft_secs = [
                [(side * 1.88, 5.55, z_sgn * 0.34), (side * 2.08, 5.55, z_sgn * 0.34), (side * 2.08, 5.55, z_sgn * 0.96), (side * 1.88, 5.55, z_sgn * 0.96)],
                [(side * 1.72, 8.20, z_sgn * 0.34), (side * 1.94, 8.20, z_sgn * 0.34), (side * 1.94, 8.20, z_sgn * 0.96), (side * 1.72, 8.20, z_sgn * 0.96)],
                [(side * 1.46, 9.95, z_sgn * 0.34), (side * 1.66, 9.95, z_sgn * 0.34), (side * 1.66, 9.95, z_sgn * 0.96), (side * 1.46, 9.95, z_sgn * 0.96)],
            ]
            if side * z_sgn < 0:
                cleft_secs = [list(reversed(r)) for r in cleft_secs]
            add_lofted_sections(
                f"Jaw_CleftArmorBand_{tag}_{z_tag}",
                cleft_secs,
                mats["gunmetal_chassis"],
                col,
                bevel=0.02,
                bevel_segments=1,
                parent=root,
            )
            # Subtle twin longitudinal chrome hydraulic conduit lines tucked inside the jaw cleft!
            add_beam_between(
                f"Jaw_CleftConduit_{tag}_{z_tag}",
                (side * 2.04, 5.60, z_sgn * 0.62),
                (side * 1.68, 9.80, z_sgn * 0.62),
                0.068,
                0.068,
                mats["chrome_pipe"],
                col,
                bevel=0.006,
                parent=root,
            )

            # Delicate, tiny pinpoint micro-lights along the recessed upper & lower jaw shelves (Hero ref!)
            for k_dot in range(11):
                t = k_dot / 10.0
                yd = 6.00 + t * 3.70
                xd = side * (2.06 - t * 0.36)
                add_beveled_box(
                    f"Jaw_CleftPinpoint_{tag}_{z_tag}_{k_dot:02d}",
                    (xd, yd, z_sgn * 1.00),
                    (0.036, 0.068, 0.026),
                    mats["cool_micro_light"],
                    col,
                    bevel=0.004,
                    parent=root,
                )

        # Center recessed dark intake trough + spaced heavy armored vertical bulkhead clamps
        add_beveled_box(
            f"Jaw_CleftCenterTrench_{tag}",
            (side * 1.72, 7.75, 0.0),
            (0.32, 4.30, 0.54),
            mats["cavity_dark"],
            col,
            bevel=0.012,
            parent=root,
        )
        for idx_r, (y_rib, x_rib) in enumerate(((5.95, 2.04), (7.15, 1.94), (8.35, 1.82), (9.45, 1.68))):
            add_beveled_box(
                f"Jaw_CleftVertClamp_{tag}_{idx_r}",
                (side * x_rib, y_rib, 0.0),
                (0.20, 0.22, 1.96),
                mats["steel_trim"],
                col,
                bevel=0.014,
                parent=root,
            )

        # Iconic twin vertical-to-horizontal heavy coolant conduits right where jaw meets portal (Hero!)
        for pi, (dy_p, dx_p, r_p, m_key) in enumerate((
            (0.00, 0.00, 0.102, "steel_trim"),
            (0.28, 0.08, 0.082, "chrome_pipe"),
            (0.54, 0.14, 0.072, "gunmetal_chassis"),
        )):
            py = 4.55 + dy_p
            px = side * (2.04 + dx_p)
            add_cylinder(
                f"Jaw_CornerPipeVert_{tag}_{pi}",
                (px, py, 0.0),
                r_p,
                3.60 - pi * 0.42,
                mats[m_key],
                col,
                segments=14,
                bevel=0.008,
                parent=root,
            )
            for z_sgn, z_tag in ((1, "U"), (-1, "L")):
                z_elb = z_sgn * (1.72 - pi * 0.22)
                add_cylinder(
                    f"Jaw_CornerPipeHoriz_{tag}_{z_tag}_{pi}",
                    (px - side * 0.12, py + 0.72, z_elb),
                    r_p * 0.95,
                    1.45,
                    mats[m_key],
                    col,
                    segments=14,
                    rot=(math.pi * 0.5, 0.0, 0.0),
                    bevel=0.008,
                    parent=root,
                )
                add_beveled_box(
                    f"Jaw_CornerPipeClamp_{tag}_{z_tag}_{pi}",
                    (px, py, z_elb),
                    (r_p * 2.4, r_p * 2.4, r_p * 2.4),
                    mats["dark_machinery"],
                    col,
                    bevel=0.014,
                    parent=root,
                )


# ---------------------------------------------------------------------------
# 6. Collection 03: Giant Open Portal Bay, Multi-Deck Amber Galleries & Holo Grids
# ---------------------------------------------------------------------------

def build_open_portal_bay_and_holograms(mats, col, col_fx, root):
    """Build the signature hollow pass-through rectangular bay with ultra-fine deck windows & 4 crisp violet curtains."""
    bay_y0, bay_y1 = -5.10, 4.10
    bay_yc = 0.5 * (bay_y0 + bay_y1)
    bay_len = bay_y1 - bay_y0

    for z_sgn, z_tag in ((1, "Ceiling"), (-1, "Floor")):
        # Deep dark recessed interior gallery backing slab inside ceiling/floor of open portal
        add_beveled_box(
            f"Portal_GalleryCore_{z_tag}",
            (0.0, bay_yc, z_sgn * 2.58),
            (4.76, bay_len, 0.34),
            mats["cavity_dark"],
            col,
            bevel=0.018,
            parent=root,
        )
        # Architectural transverse ceiling/floor structural girders spanning Port-to-Starboard!
        for gi in range(11):
            gy = bay_y0 + 0.40 + gi * 0.84
            add_beveled_box(
                f"Portal_TransverseGirder_{z_tag}_{gi:02d}",
                (0.0, gy, z_sgn * 2.46),
                (4.86, 0.14, 0.14),
                mats["steel_trim"],
                col,
                bevel=0.012,
                parent=root,
            )
        # Fine dark steel horizontal gallery deck dividers + ULTRA-DENSE miniature warm-amber capital-ship windows!
        for side, s_tag in ((-1, "Port"), (1, "Stbd")):
            add_beveled_box(
                f"Portal_GalleryLipOuter_{z_tag}_{s_tag}",
                (side * 2.38, bay_yc, z_sgn * 2.48),
                (0.22, bay_len, 0.18),
                mats["gunmetal_chassis"],
                col,
                bevel=0.014,
                parent=root,
            )
            add_beveled_box(
                f"Portal_GalleryDeckRail_{z_tag}_{s_tag}",
                (side * 2.26, bay_yc, z_sgn * 2.41),
                (0.08, bay_len - 0.16, 0.045),
                mats["steel_trim"],
                col,
                bevel=0.006,
                parent=root,
            )

            # Pack all 3 tiers of ultra-fine miniature warm-amber capital-ship windows into ONE fast BMesh per side!
            bm_win = bmesh.new()
            tier_specs = [
                (2.30, 2.34, 42),
                (2.26, 2.45, 38),
                (2.20, 2.54, 34),
            ]
            for t_idx, (x_off, z_off, count) in enumerate(tier_specs):
                span_y = bay_len - 0.86
                for wi in range(count):
                    # Deterministic capital-ship lighting rhythm (clusters & dark bays, 100% X-symmetric!)
                    if ((wi * 7 + t_idx * 13) % 11) in (2, 7):
                        continue
                    wy = bay_y0 + 0.43 + (wi + 0.5) * (span_y / count)
                    w_len = 0.095 if (wi + t_idx) % 2 == 0 else 0.055
                    res = bmesh.ops.create_cube(bm_win, size=1.0)
                    verts = res["verts"]
                    for v in verts:
                        v.co.x *= 0.035
                        v.co.y *= w_len
                        v.co.z *= 0.024
                    bmesh.ops.translate(bm_win, vec=Vector((side * x_off, wy, z_sgn * z_off)), verts=verts)

            finalize_mesh(
                bm_win,
                f"Portal_AmberWindowCluster_{z_tag}_{s_tag}",
                mats["amber_window"],
                col_fx,
                smooth=False,
                parent=root,
            )

    # --- 6B. 4 RAZOR-SHARP ELECTRIC-VIOLET WIREFRAME ENERGY CURTAIN GATES (Placed in FX col so LineArt stays clean!) ---
    z_bot, z_top = -2.44, 2.44
    n_horiz = 16
    n_vert = 7

    for y_end_tag, y_wall, y_tip in (("Fwd", 4.02, 2.84), ("Aft", -5.02, -3.84)):
        for side, s_tag in ((-1, "Port"), (1, "Stbd")):
            x_in = side * 1.40
            x_out = side * 2.34
            p_in_bot = Vector((x_in, y_wall, z_bot))
            p_in_top = Vector((x_in, y_wall, z_top))
            p_out_bot = Vector((x_out, y_tip, z_bot))
            p_out_top = Vector((x_out, y_tip, z_top))

            for z_em, em_tag in ((z_top + 0.06, "Top"), (z_bot - 0.06, "Bot")):
                add_beam_between(
                    f"Portal_HoloEmitter_{y_end_tag}_{s_tag}_{em_tag}",
                    (x_in, y_wall, z_em),
                    (x_out, y_tip, z_em),
                    0.16,
                    0.14,
                    mats["steel_trim"],
                    col,
                    bevel=0.014,
                    parent=root,
                )

            bm_sheet = bmesh.new()
            v0 = bm_sheet.verts.new(p_in_bot)
            v1 = bm_sheet.verts.new(p_out_bot)
            v2 = bm_sheet.verts.new(p_out_top)
            v3 = bm_sheet.verts.new(p_in_top)
            bm_sheet.faces.new((v0, v1, v2, v3))
            bmesh.ops.solidify(bm_sheet, geom=list(bm_sheet.faces), thickness=0.014)
            finalize_mesh(
                bm_sheet,
                f"Portal_HoloSheet_{y_end_tag}_{s_tag}",
                mats["violet_field"],
                col_fx,
                smooth=False,
                parent=root,
            )

            border_r = 0.036
            add_beam_between(f"Portal_HoloFrameBot_{y_end_tag}_{s_tag}", p_in_bot, p_out_bot, border_r, border_r, mats["violet_grid"], col_fx, bevel=0.006, parent=root)
            add_beam_between(f"Portal_HoloFrameTop_{y_end_tag}_{s_tag}", p_in_top, p_out_top, border_r, border_r, mats["violet_grid"], col_fx, bevel=0.006, parent=root)
            add_beam_between(f"Portal_HoloFrameIn_{y_end_tag}_{s_tag}",  p_in_bot, p_in_top,  border_r, border_r, mats["violet_grid"], col_fx, bevel=0.006, parent=root)
            add_beam_between(f"Portal_HoloFrameOut_{y_end_tag}_{s_tag}", p_out_bot, p_out_top, border_r, border_r, mats["violet_grid"], col_fx, bevel=0.006, parent=root)

            bm_grid = bmesh.new()

            def _add_bar(a, b, rad):
                diff = b - a
                ln = diff.length
                if ln < 1e-4:
                    return
                mid = (a + b) * 0.5
                za = diff.normalized()
                ref = Vector((0.0, 1.0, 0.0)) if abs(za.y) < 0.9 else Vector((1.0, 0.0, 0.0))
                xa = ref.cross(za).normalized()
                ya = za.cross(xa).normalized()
                rm = Matrix((
                    (xa.x, ya.x, za.x, 0.0),
                    (xa.y, ya.y, za.y, 0.0),
                    (xa.z, ya.z, za.z, 0.0),
                    (0.0, 0.0, 0.0, 1.0),
                ))
                res = bmesh.ops.create_cube(bm_grid, size=1.0)
                verts = res["verts"]
                for v in verts:
                    v.co.x *= rad
                    v.co.y *= rad
                    v.co.z *= ln
                bmesh.ops.transform(bm_grid, matrix=rm, verts=verts)
                bmesh.ops.translate(bm_grid, vec=mid, verts=verts)

            for hi in range(1, n_horiz):
                fz = hi / float(n_horiz)
                z_cur = z_bot + fz * (z_top - z_bot)
                _add_bar(Vector((x_in, y_wall, z_cur)), Vector((x_out, y_tip, z_cur)), 0.015)

            for vi in range(1, n_vert):
                fu = vi / float(n_vert)
                pb = p_in_bot.lerp(p_out_bot, fu)
                pt = p_in_top.lerp(p_out_top, fu)
                _add_bar(pb, pt, 0.015)

            finalize_mesh(
                bm_grid,
                f"Portal_HoloWireGrid_{y_end_tag}_{s_tag}",
                mats["violet_grid"],
                col_fx,
                smooth=False,
                parent=root,
            )


# ---------------------------------------------------------------------------
# 7. Collection 04: Continuous Signature Deep Electric-Violet Perimeter LED Trim
# ---------------------------------------------------------------------------

def build_violet_perimeter_trim(mats, col, col_fx, root):
    """Build the continuous symmetric royal-violet glowing neon rim framing jaw lips & open portal."""
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        upper_pts = [
            (side * 1.94, 10.96, 1.24),
            (side * 2.34,  9.85, 1.24),
            (side * 2.94,  6.78, 1.24),
            (side * 3.12,  4.18, 2.66),
            (side * 3.12,  1.25, 2.66),
            (side * 2.60,  0.65, 2.98),
            (side * 2.60, -2.20, 2.98),
            (side * 3.12, -2.85, 2.66),
            (side * 3.12, -5.25, 2.66),
            (side * 2.86, -6.70, 2.66),
        ]
        add_polyline_strip(
            f"Trim_UpperChannel_{tag}",
            [(x - side * 0.04, y, z) for (x, y, z) in upper_pts],
            0.11,
            0.12,
            mats["cavity_dark"],
            col,
            bevel=0.01,
            parent=root,
        )
        add_polyline_strip(
            f"Trim_UpperVioletNeon_{tag}",
            [(x + side * 0.025, y, z) for (x, y, z) in upper_pts],
            0.058,
            0.062,
            mats["violet_neon"],
            col_fx,
            bevel=0.008,
            parent=root,
        )

        lower_pts = [
            (side * 1.94, 10.96, -1.24),
            (side * 2.34,  9.85, -1.24),
            (side * 2.94,  6.78, -1.24),
            (side * 3.12,  4.18, -2.66),
            (side * 3.12,  1.25, -2.66),
            (side * 2.84,  0.65, -2.96),
            (side * 2.84, -2.20, -2.96),
            (side * 3.12, -2.85, -2.66),
            (side * 3.12, -5.25, -2.66),
            (side * 2.86, -6.70, -2.66),
        ]
        add_polyline_strip(
            f"Trim_LowerChannel_{tag}",
            [(x - side * 0.04, y, z) for (x, y, z) in lower_pts],
            0.11,
            0.12,
            mats["cavity_dark"],
            col,
            bevel=0.01,
            parent=root,
        )
        add_polyline_strip(
            f"Trim_LowerVioletNeon_{tag}",
            [(x + side * 0.025, y, z) for (x, y, z) in lower_pts],
            0.058,
            0.062,
            mats["violet_neon"],
            col_fx,
            bevel=0.008,
            parent=root,
        )

    for z_sgn, z_tag in ((1, "Upper"), (-1, "Lower")):
        front_jaw_pts = [
            (-1.94, 10.98, z_sgn * 1.24),
            (-1.04, 10.98, z_sgn * 1.24),
            (-0.76, 10.94, z_sgn * 1.62),
            ( 0.76, 10.94, z_sgn * 1.62),
            ( 1.04, 10.98, z_sgn * 1.24),
            ( 1.94, 10.98, z_sgn * 1.24),
        ]
        add_polyline_strip(
            f"Trim_FrontJawChannel_{z_tag}",
            [(x, y - 0.04, z) for (x, y, z) in front_jaw_pts],
            0.10,
            0.10,
            mats["cavity_dark"],
            col,
            bevel=0.008,
            parent=root,
        )
        add_polyline_strip(
            f"Trim_FrontJawVioletNeon_{z_tag}",
            front_jaw_pts,
            0.058,
            0.058,
            mats["violet_neon"],
            col_fx,
            bevel=0.008,
            parent=root,
        )


# ---------------------------------------------------------------------------
# 8. Collection 05: Monumental Centered Rear Octagonal Warren-Truss Ring
# ---------------------------------------------------------------------------

def build_rear_octagonal_truss_ring(mats, col, root):
    """Build the 100% centered, orthogonal, bilaterally & vertically symmetric rear octagonal truss ring."""
    y_ring = -7.80
    hw_out = 6.65   # Matches REAR ortho W/H = 0.917 cleanly!
    hh_out = 7.25
    chamfer = 2.65

    oct_outer      = make_sym_oct_xz(hw_out, hh_out, chamfer)
    oct_shroud_in  = inset_oct_xz(hw_out, hh_out, chamfer, 0.84)
    oct_truss_out  = inset_oct_xz(hw_out, hh_out, chamfer, 0.88)
    oct_truss_in   = inset_oct_xz(hw_out, hh_out, chamfer, 1.98)
    oct_inner_out  = inset_oct_xz(hw_out, hh_out, chamfer, 1.94)
    oct_inner_in   = inset_oct_xz(hw_out, hh_out, chamfer, 2.34)

    # 8A. Primary Thick Weathered White-Ceramic Outer Armored Octagonal Shroud
    add_hollow_ring_y(
        "Ring_OuterArmorShroud_Main",
        oct_outer,
        oct_shroud_in,
        y_back=y_ring - 0.80,
        y_front=y_ring + 0.80,
        mat=mats["armor_white"],
        col=col,
        bevel=0.058,
        bevel_segments=2,
        parent=root,
    )

    # Raised stepped mid-band armor rib circling the outer rim
    oct_rib_out = inset_oct_xz(hw_out, hh_out, chamfer, -0.09)
    oct_rib_in  = inset_oct_xz(hw_out, hh_out, chamfer, 0.34)
    add_hollow_ring_y(
        "Ring_OuterArmorCenterBand",
        oct_rib_out,
        oct_rib_in,
        y_back=y_ring - 0.44,
        y_front=y_ring + 0.44,
        mat=mats["armor_bright"],
        col=col,
        bevel=0.034,
        bevel_segments=2,
        parent=root,
    )

    # Chamfered inner gunmetal lining lip on the inner rim of the outer shroud
    oct_lip_out = inset_oct_xz(hw_out, hh_out, chamfer, 0.72)
    oct_lip_in  = inset_oct_xz(hw_out, hh_out, chamfer, 0.92)
    add_hollow_ring_y(
        "Ring_OuterShroudInnerLip",
        oct_lip_out,
        oct_lip_in,
        y_back=y_ring - 0.68,
        y_front=y_ring + 0.68,
        mat=mats["gunmetal_chassis"],
        col=col,
        bevel=0.025,
        bevel_segments=1,
        parent=root,
    )

    # 8B. Top & Bottom Centered Keystone Armor Blocks + 8 Corner Seam Clamps
    for z_sgn, z_tag in ((1, "Top"), (-1, "Bot")):
        add_beveled_box(
            f"Ring_KeystoneArmor_{z_tag}",
            (0.0, y_ring, z_sgn * (hh_out + 0.04)),
            (2.96, 1.74, 0.34),
            mats["armor_bright"],
            col,
            bevel=0.036,
            parent=root,
        )
        add_beveled_box(
            f"Ring_KeystoneClamp_{z_tag}",
            (0.0, y_ring, z_sgn * (hh_out - 0.40)),
            (1.72, 1.78, 0.42),
            mats["armor_slate"],
            col,
            bevel=0.028,
            parent=root,
        )

    for vi, (vx, vz) in enumerate(oct_outer):
        v_in = oct_shroud_in[vi]
        mx = 0.5 * (vx + v_in[0])
        mz = 0.5 * (vz + v_in[1])
        ang = math.atan2(vz - v_in[1], vx - v_in[0])
        add_beveled_box(
            f"Ring_CornerClamp_{vi:02d}",
            (mx, y_ring, mz),
            (0.94, 1.70, 0.26),
            mats["armor_slate"],
            col,
            bevel=0.024,
            rot=(0.0, -ang, 0.0),
            parent=root,
        )

    # 8C. Sculpted Recessed Armored Side Mechanical Stabilizer Channels (NO flat neon billboards!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        for z_sgn, z_tag in ((1, "U"), (-1, "L")):
            add_beveled_box(
                f"Ring_SideClampBlock_{tag}_{z_tag}",
                (side * (hw_out - 0.36), y_ring, z_sgn * 2.10),
                (0.96, 1.74, 0.68),
                mats["armor_bright"],
                col,
                bevel=0.032,
                parent=root,
            )
        # Recessed armored slate-ceramic channel pocket along the vertical ring flank
        add_beveled_box(
            f"Ring_SideRecessFrame_{tag}",
            (side * (hw_out - 0.02), y_ring, 0.0),
            (0.32, 1.18, 3.30),
            mats["armor_slate"],
            col,
            bevel=0.024,
            parent=root,
        )
        add_beveled_box(
            f"Ring_SideRecessCavity_{tag}",
            (side * (hw_out + 0.06), y_ring, 0.0),
            (0.18, 0.72, 2.94),
            mats["gunmetal_chassis"],
            col,
            bevel=0.016,
            parent=root,
        )
        # Horizontal structural ribs + razor-thin deep-violet stabilizer hairline inside recess!
        for z_rib in (-1.05, -0.35, 0.35, 1.05):
            add_beveled_box(
                f"Ring_SideRecessRib_{tag}_{z_rib:+.2f}",
                (side * (hw_out + 0.11), y_ring, z_rib),
                (0.14, 0.78, 0.14),
                mats["steel_trim"],
                col,
                bevel=0.012,
                parent=root,
            )
        add_beveled_box(
            f"Ring_SideVioletHairline_{tag}",
            (side * (hw_out + 0.14), y_ring, 0.0),
            (0.05, 0.14, 2.74),
            mats["violet_accent"],
            col,
            bevel=0.008,
            parent=root,
        )
        # Subtle recessed slate face channel on front & rear of vertical ring arms
        for y_off, f_tag in ((-0.78, "Back"), (0.78, "Front")):
            add_beveled_box(
                f"Ring_SideFacePocket_{tag}_{f_tag}",
                (side * (hw_out - 0.42), y_ring + y_off, 0.0),
                (0.46, 0.14, 2.86),
                mats["armor_slate"],
                col,
                bevel=0.018,
                parent=root,
            )
            add_beveled_box(
                f"Ring_SideFaceSlit_{tag}_{f_tag}",
                (side * (hw_out - 0.42), y_ring + y_off + (0.06 if y_off > 0 else -0.06), 0.0),
                (0.08, 0.05, 2.48),
                mats["violet_accent"],
                col,
                bevel=0.006,
                parent=root,
            )

    # 8D. Inner Heavy Dark-Gunmetal Octagonal Structural Truss Ring
    add_hollow_ring_y(
        "Ring_InnerSteelRing_Main",
        oct_inner_out,
        oct_inner_in,
        y_back=y_ring - 0.64,
        y_front=y_ring + 0.64,
        mat=mats["gunmetal_chassis"],
        col=col,
        bevel=0.028,
        bevel_segments=2,
        parent=root,
    )
    oct_flange_out = inset_oct_xz(hw_out, hh_out, chamfer, 1.88)
    oct_flange_in  = inset_oct_xz(hw_out, hh_out, chamfer, 2.40)
    for y_fl, fl_tag in ((-0.54, "Back"), (0.54, "Front")):
        add_hollow_ring_y(
            f"Ring_InnerSteelFlange_{fl_tag}",
            oct_flange_out,
            oct_flange_in,
            y_back=y_ring + y_fl - 0.11,
            y_front=y_ring + y_fl + 0.11,
            mat=mats["steel_trim"],
            col=col,
            bevel=0.016,
            bevel_segments=1,
            parent=root,
        )

    # 8E. BOLD MONUMENTAL 360-DEGREE WARREN-TRUSS STEEL GIRDERS (Hero & REAR Signature!)
    # Bold aerospace I-beam proportions: 4 bays top/bottom, 3 bays on 45-deg diagonals, 6 bays on vertical sides!
    side_bays = [4, 3, 6, 3, 4, 3, 6, 3]
    y_planes = (y_ring - 0.45, y_ring + 0.45)

    for edge_i in range(8):
        ni = (edge_i + 1) % 8
        o0 = Vector((oct_truss_out[edge_i][0], 0.0, oct_truss_out[edge_i][1]))
        o1 = Vector((oct_truss_out[ni][0],     0.0, oct_truss_out[ni][1]))
        i0 = Vector((oct_truss_in[edge_i][0],  0.0, oct_truss_in[edge_i][1]))
        i1 = Vector((oct_truss_in[ni][0],      0.0, oct_truss_in[ni][1]))

        # Heavy radial corner post at every octagon vertex
        for p_idx, yp in enumerate(y_planes):
            add_beam_between(
                f"Ring_TrussCornerPost_E{edge_i}_P{p_idx}",
                (i0.x, yp, i0.z),
                (o0.x, yp, o0.z),
                0.18,
                0.19,
                mats["steel_trim"],
                col,
                bevel=0.016,
                parent=root,
            )

        nb = side_bays[edge_i]
        for b in range(nb):
            t_in_a = b / float(nb)
            t_in_b = (b + 1) / float(nb)
            t_out_m = (b + 0.5) / float(nb)

            p_ia = i0.lerp(i1, t_in_a)
            p_ib = i0.lerp(i1, t_in_b)
            p_om = o0.lerp(o1, t_out_m)

            for p_idx, yp in enumerate(y_planes):
                add_beam_between(
                    f"Ring_TrussDiagA_E{edge_i}_B{b}_P{p_idx}",
                    (p_ia.x, yp, p_ia.z),
                    (p_om.x, yp, p_om.z),
                    0.165,
                    0.180,
                    mats["steel_trim"],
                    col,
                    bevel=0.014,
                    parent=root,
                )
                add_beam_between(
                    f"Ring_TrussDiagB_E{edge_i}_B{b}_P{p_idx}",
                    (p_om.x, yp, p_om.z),
                    (p_ib.x, yp, p_ib.z),
                    0.165,
                    0.180,
                    mats["steel_trim"],
                    col,
                    bevel=0.014,
                    parent=root,
                )
            # Transverse tie bar linking front & back truss planes at outer node
            add_beam_between(
                f"Ring_TrussTieOuter_E{edge_i}_B{b}",
                (p_om.x, y_planes[0], p_om.z),
                (p_om.x, y_planes[1], p_om.z),
                0.13,
                0.13,
                mats["dark_machinery"],
                col,
                bevel=0.012,
                parent=root,
            )

    # 8F. HEAVY STRUCTURAL MOUNTING PYLONS ANCHORING RING RIGIDLY TO THE HULL
    for z_sgn, z_tag in ((1, "Dorsal"), (-1, "Ventral")):
        add_beveled_box(
            f"Ring_MountPylonCore_{z_tag}",
            (0.0, y_ring, z_sgn * 4.70),
            (1.96, 1.32, 1.18),
            mats["gunmetal_chassis"],
            col,
            bevel=0.032,
            parent=root,
        )
        add_beveled_box(
            f"Ring_MountPylonArmor_{z_tag}",
            (0.0, y_ring + 0.12, z_sgn * 4.54),
            (1.42, 1.56, 0.90),
            mats["armor_slate"],
            col,
            bevel=0.028,
            parent=root,
        )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        for z_br, br_tag in ((2.75, "Upper"), (0.0, "Mid"), (-2.75, "Lower")):
            add_beveled_box(
                f"Ring_LateralBridge_{tag}_{br_tag}",
                (side * 3.50, y_ring, z_br),
                (2.05, 1.02, 0.56 if br_tag != "Mid" else 0.72),
                mats["gunmetal_chassis"],
                col,
                bevel=0.026,
                parent=root,
            )
            for dz_s in (-0.65, 0.65):
                add_beam_between(
                    f"Ring_LateralBrace_{tag}_{br_tag}_{dz_s:+.2f}",
                    (side * 2.65, y_ring, z_br + dz_s),
                    (side * 4.42, y_ring, z_br),
                    0.15,
                    0.22,
                    mats["steel_trim"],
                    col,
                    bevel=0.014,
                    parent=root,
                )


# ---------------------------------------------------------------------------
# 9. Collection 06: Aft Portal Bulkhead & Blazing 6-Nozzle Violet Plasma Drives
# ---------------------------------------------------------------------------

def build_stern_propulsion_complex(mats, col, root):
    """Build the symmetric aft portal bulkhead, deep indigo reactor canyon & 6 blazing violet plasma thrusters."""

    # --- 9A. AFT PORTAL BULKHEAD (closes the rear of the hollow through-bay, Y in [-6.15, -5.10]) ---
    add_beveled_box(
        "Stern_AftPortalBulkhead",
        (0.0, -5.62, 0.0),
        (4.10, 1.06, 5.14),
        mats["gunmetal_chassis"],
        col,
        bevel=0.04,
        parent=root,
    )
    add_beveled_box(
        "Stern_AftPortalWallRecess",
        (0.0, -5.12, 0.0),
        (2.86, 0.18, 4.56),
        mats["cavity_dark"],
        col,
        bevel=0.015,
        parent=root,
    )
    for rx in (-1.35, -0.45, 0.45, 1.35):
        add_beveled_box(
            f"Stern_AftPortalWallRib_{rx:+.2f}",
            (rx, -5.14, 0.0),
            (0.18, 0.24, 4.78),
            mats["steel_trim"],
            col,
            bevel=0.016,
            parent=root,
        )

    # --- 9B. DEEP CENTRAL STERN PROPULSION CANYON (Y in [-10.30, -6.10], matching REAR view!) ---
    add_beveled_box(
        "Stern_CentralCanyonCore",
        (0.0, -7.85, 0.0),
        (2.46, 3.60, 5.16),
        mats["stern_indigo"],
        col,
        bevel=0.035,
        parent=root,
    )
    add_beveled_box(
        "Stern_CentralReactorCavity",
        (0.0, -9.80, 0.0),
        (1.62, 0.56, 4.82),
        mats["cavity_dark"],
        col,
        bevel=0.02,
        parent=root,
    )
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Stern_CenterCanyonRib_{tag}",
            (side * 0.24, -9.88, 0.0),
            (0.16, 0.40, 4.78),
            mats["steel_trim"],
            col,
            bevel=0.014,
            parent=root,
        )
        add_beveled_box(
            f"Stern_CenterIonSlit_{tag}",
            (side * 0.56, -10.02, 0.0),
            (0.11, 0.12, 4.24),
            mats["violet_accent"],
            col,
            bevel=0.01,
            parent=root,
        )
    for z_sgn, z_tag in ((1, "Upper"), (-1, "Lower")):
        add_beveled_box(
            f"Stern_CenterCap_{z_tag}",
            (0.0, -8.35, z_sgn * 3.36),
            (2.26, 3.60, 1.38),
            mats["armor_white"],
            col,
            bevel=0.04,
            parent=root,
        )
        add_beveled_box(
            f"Stern_CenterCapRearStep_{z_tag}",
            (0.0, -9.88, z_sgn * 3.16),
            (1.96, 0.85, 1.05),
            mats["armor_slate"],
            col,
            bevel=0.03,
            parent=root,
        )

    # --- 9C. TWIN PORT & STARBOARD 3-TIER BLAZING VIOLET PLASMA THRUSTER COLUMNS ---
    # Engine body stops CLEANLY at Y = -10.22 so ALL 6 recessed plasma emitters shine unobstructed!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Body spans Y in [-10.22, -5.82] -> center = -8.02, len = 4.40 (ZERO overlap with exhaust chamber!)
        add_beveled_box(
            f"Stern_EngineColumnBody_{tag}",
            (side * 1.86, -8.02, 0.0),
            (1.62, 4.40, 5.18),
            mats["gunmetal_chassis"],
            col,
            bevel=0.04,
            parent=root,
        )
        add_beveled_box(
            f"Stern_AftSideArmorUpper_{tag}",
            (side * 2.52, -9.45, 2.38),
            (0.46, 2.05, 0.96),
            mats["armor_slate"],
            col,
            bevel=0.03,
            parent=root,
        )
        add_beveled_box(
            f"Stern_AftSideArmorLower_{tag}",
            (side * 2.52, -9.45, -2.38),
            (0.46, 2.05, 0.96),
            mats["armor_slate"],
            col,
            bevel=0.03,
            parent=root,
        )
        for k_lv in range(9):
            zl = -1.80 + k_lv * 0.45
            add_beveled_box(
                f"Stern_AftSideLouver_{tag}_{k_lv:02d}",
                (side * 2.66, -9.42, zl),
                (0.24, 1.88, 0.16),
                mats["steel_trim"],
                col,
                bevel=0.012,
                parent=root,
            )

        # 3 Vertical Stacked Main Vectored Violet-Plasma Thruster Nacelles per Column!
        for t_idx, zc in enumerate((1.72, 0.0, -1.72)):
            tx = side * 1.66
            out_rect = [
                (tx - 0.68, zc + 0.72),
                (tx + 0.68, zc + 0.72),
                (tx + 0.78, zc + 0.56),
                (tx + 0.78, zc - 0.56),
                (tx + 0.68, zc - 0.72),
                (tx - 0.68, zc - 0.72),
                (tx - 0.78, zc - 0.56),
                (tx - 0.78, zc + 0.56),
            ]
            in_rect = [
                (tx - 0.46, zc + 0.52),
                (tx + 0.46, zc + 0.52),
                (tx + 0.56, zc + 0.38),
                (tx + 0.56, zc - 0.38),
                (tx + 0.46, zc - 0.52),
                (tx - 0.46, zc - 0.52),
                (tx - 0.56, zc - 0.38),
                (tx - 0.56, zc + 0.38),
            ]
            add_hollow_ring_y(
                f"Stern_ThrusterShroud_{tag}_T{t_idx}",
                out_rect,
                in_rect,
                y_back=-11.00,
                y_front=-10.22,
                mat=mats["steel_trim"],
                col=col,
                bevel=0.022,
                bevel_segments=2,
                parent=root,
            )
            # Horizontal ribbed cooling vanes along outer flank of thruster shroud
            for dz_r in (-0.52, -0.26, 0.26, 0.52):
                add_beveled_box(
                    f"Stern_ThrusterSideRib_{tag}_T{t_idx}_{dz_r:+.2f}",
                    (tx + side * 0.76, -10.56, zc + dz_r),
                    (0.18, 0.74, 0.11),
                    mats["dark_machinery"],
                    col,
                    bevel=0.01,
                    parent=root,
                )
            # Recessed dark exhaust backing plate (Y in [-10.42, -10.20])
            add_beveled_box(
                f"Stern_ThrusterThroat_{tag}_T{t_idx}",
                (tx, -10.31, zc),
                (1.12, 0.22, 1.04),
                mats["cavity_dark"],
                col,
                bevel=0.012,
                parent=root,
            )
            # Blazing deep electric-violet outer plasma emitter chamber (unobstructed at Y = -10.50!)
            add_beveled_box(
                f"Stern_ThrusterPlasmaOuter_{tag}_T{t_idx}",
                (tx, -10.50, zc),
                (0.96, 0.16, 0.88),
                mats["thruster_violet"],
                col,
                bevel=0.018,
                parent=root,
            )
            # Incandescent lavender-white inner plasma accelerator core (Y = -10.62!)
            add_beveled_box(
                f"Stern_ThrusterPlasmaCore_{tag}_T{t_idx}",
                (tx, -10.62, zc),
                (0.58, 0.14, 0.50),
                mats["thruster_core"],
                col,
                bevel=0.014,
                parent=root,
            )
            # Twin dark horizontal vectoring baffle vanes silhouetted crisply across the glowing core!
            for dz_v in (-0.24, 0.24):
                add_beveled_box(
                    f"Stern_ThrusterVane_{tag}_T{t_idx}_{dz_v:+.2f}",
                    (tx, -10.86, zc + dz_v),
                    (1.04, 0.18, 0.062),
                    mats["dark_machinery"],
                    col,
                    bevel=0.008,
                    parent=root,
                )


# ---------------------------------------------------------------------------
# 10. Collection 07: Symmetric Hero Greebles, RCS Pods, Antennae & Hull Accents
# ---------------------------------------------------------------------------

def build_greebles_and_surface_details(mats, col, root):
    """Add crisp bilateral surface armor blocks, RCS pods, tie-down rails & antennae."""
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Recessed military RCS maneuvering thruster clusters at bow cheeks, dorsal & ventral aft
        add_rcs_cluster(
            f"Detail_RCS_BowUpper_{tag}",
            (side * 2.52, 8.20, 2.38),
            mats, col,
            rot=(0.0, side * 0.65, side * 0.20),
            scale=1.15,
            parent=root,
        )
        add_rcs_cluster(
            f"Detail_RCS_BowLower_{tag}",
            (side * 2.52, 8.20, -2.58),
            mats, col,
            rot=(0.0, side * (math.pi - 0.65), side * 0.20),
            scale=1.15,
            parent=root,
        )
        add_rcs_cluster(
            f"Detail_RCS_AftDorsal_{tag}",
            (side * 2.68, -4.40, 4.02),
            mats, col,
            rot=(0.0, side * 0.58, 0.0),
            scale=1.10,
            parent=root,
        )
        add_rcs_cluster(
            f"Detail_RCS_AftVentral_{tag}",
            (side * 2.68, -4.40, -4.02),
            mats, col,
            rot=(0.0, side * (math.pi - 0.58), 0.0),
            scale=1.10,
            parent=root,
        )

        # Raised stepped armor service hatches on upper flank shoulders
        for y_h in (-4.80, -3.55, 2.25, 3.65):
            add_beveled_box(
                f"Detail_UpperHatch_{tag}_{y_h:+.2f}",
                (side * 2.48, y_h, 4.18),
                (0.76, 0.92, 0.14),
                mats["armor_slate"],
                col,
                bevel=0.018,
                rot=(0.0, side * 0.58, 0.0),
                parent=root,
            )

        # Structural hoist/EVA grab rails along dorsal flanks
        for y_bar in (-4.20, 2.85, 4.85):
            add_cylinder(
                f"Detail_DorsalGrabBar_{tag}_{y_bar:+.2f}",
                (side * 1.98, y_bar, 4.46),
                0.036,
                0.62,
                mats["steel_trim"],
                col,
                segments=10,
                rot=(math.pi * 0.5, 0.0, 0.0),
                bevel=0.006,
                parent=root,
            )

        # Symmetric low-profile dorsal comms fins near aft bridge deck
        add_beveled_box(
            f"Detail_AftCommsFin_{tag}",
            (side * 1.38, -5.65, 4.68),
            (0.075, 0.72, 0.34),
            mats["steel_trim"],
            col,
            bevel=0.012,
            rot=(0.24, 0.0, 0.0),
            parent=root,
        )

        # Subtle cool-violet tactical running seam pips along forward & aft armor flanks
        for k_pip, (yp, xp, zp) in enumerate((
            ( 8.95, 2.48,  2.08),
            ( 6.10, 3.04,  3.44),
            ( 3.20, 3.16,  3.52),
            (-4.20, 3.14,  3.52),
            ( 6.10, 3.04, -3.50),
            ( 3.20, 3.16, -3.55),
        )):
            add_beveled_box(
                f"Detail_HullLightBezel_{tag}_{k_pip}",
                (side * xp, yp, zp),
                (0.07, 0.38, 0.075),
                mats["cavity_dark"],
                col,
                bevel=0.008,
                parent=root,
            )
            add_beveled_box(
                f"Detail_HullLightPip_{tag}_{k_pip}",
                (side * (xp + 0.025), yp, zp),
                (0.036, 0.26, 0.036),
                mats["cool_micro_light"],
                col,
                bevel=0.005,
                parent=root,
            )


# ---------------------------------------------------------------------------
# 11. Studio Orbital Lighting, Violet Plasma/Portal Bounce & 7 Matched Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_comic_lineart(col_lineart_src, col_ink):
    """Build dual-weight Grease Pencil Line Art ink contours & mechanical crease lines (Blender 5.3)."""
    gp_data = bpy.data.grease_pencils.new("OpenCode_ComicInk_GP")
    gp_data.stroke_depth_order = "3D"

    layer_sil = gp_data.layers.new("Silhouette_Ink")
    layer_sil.frames.new(1)
    layer_sil.use_lights = False
    layer_sil.opacity = 1.0

    layer_cre = gp_data.layers.new("Crease_Ink")
    layer_cre.frames.new(1)
    layer_cre.use_lights = False
    layer_cre.opacity = 0.92

    ink_mat = bpy.data.materials.new("Mat_OpenCode_ComicInk")
    bpy.data.materials.create_gpencil_data(ink_mat)
    ink_mat.grease_pencil.color = (0.010, 0.013, 0.024, 1.0)
    gp_data.materials.append(ink_mat)

    gp_obj = bpy.data.objects.new("OpenCode_ComicInk_Lines", gp_data)
    link_obj(gp_obj, col_ink)

    # Pass 1: Bold Outer Silhouette Contours (world-meter GP v3 radius calibrated for 22m vessel!)
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
    mod_sil.radius = 0.068
    mod_sil.opacity = 1.0
    mod_sil.stroke_depth_offset = 0.08
    mod_sil.overscan = 0.14

    # Pass 2: Crisp Technical Pen Interior Mechanical Creases, Material Borders & Intersections!
    mod_cre = gp_obj.modifiers.new(name="LineArt_Creases", type="LINEART")
    mod_cre.source_type = "COLLECTION"
    mod_cre.source_collection = col_lineart_src
    mod_cre.target_layer = "Crease_Ink"
    mod_cre.target_material = ink_mat
    mod_cre.use_custom_camera = False
    mod_cre.use_contour = False
    mod_cre.use_crease = True
    mod_cre.use_crease_on_smooth = True
    mod_cre.use_crease_on_sharp = True
    mod_cre.crease_threshold = math.radians(150.0)
    mod_cre.use_material = True
    mod_cre.use_intersection = True
    mod_cre.use_edge_mark = False
    mod_cre.use_loose = False
    mod_cre.radius = 0.032
    mod_cre.opacity = 0.94
    mod_cre.stroke_depth_offset = 0.05
    mod_cre.overscan = 0.14

    return gp_obj


def setup_world_and_lighting(col_stage):
    """Calibrate crisp Mecha Comic chiaroscuro studio lighting & neutral dark charcoal backdrop."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("OpenCode_Comic_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        # Clean neutral charcoal-slate studio backdrop so BOTH black ink outlines & white armor pop!
        bg.inputs["Color"].default_value = (0.072, 0.080, 0.096, 1.0)
        bg.inputs["Strength"].default_value = 0.42

    def add_light(name, ltype, loc, target, energy, color, size=16.0, size_y=None, angle=0.020, radius=0.6):
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

    # 1. Strong Graphic Directional Sun Key (carves razor-sharp anime 4-band cel shadow planes!)
    add_light("Key_Sun_Comic", "SUN", (-20.0, 22.0, 28.0), (0.0, 0.0, 0.0), energy=3.15, color=(1.0, 1.0, 1.0), angle=0.014)

    # 2. Restrained Cool Rim Fill (keeps shadow bands dramatic & cool-toned without washing them out!)
    add_light("Rim_Area_Starboard", "AREA", (28.0, 4.0, 14.0), (0.0, -1.5, 0.0), energy=1450.0, color=(0.82, 0.90, 1.0), size=22.0)

    # 3. Gentle Front-Port Fill (reveals bow cleft & jaw planes cleanly)
    add_light("Fill_Area_PortBow", "AREA", (-22.0, 24.0, 4.0), (0.0, 3.0, -0.4), energy=900.0, color=(0.88, 0.93, 1.0), size=18.0)

    # 4. Stern Key Rim (keeps rear orthographic & rear 3/4 views crisp and dimensional!)
    add_light("Rim_Area_Stern", "AREA", (12.0, -32.0, 14.0), (0.0, -8.5, 0.0), energy=2200.0, color=(0.94, 0.96, 1.0), size=20.0)

    # 5. Subtle Cool Underbelly Bounce (preserves cel mid-shadow step on bottom ortho!)
    add_light("Bounce_Area_Underbelly", "AREA", (-6.0, 2.0, -30.0), (0.0, 0.0, -3.5), energy=1650.0, color=(0.76, 0.86, 1.0), size=26.0)


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

    make_cam("Cam_Hero_34", (-21.8, 21.2, 4.2), (0.0, -1.0, 0.0), cam_type="PERSP", lens=38.0)

    c_side = make_cam("Cam_Side_Ortho", (-38.0, 0.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=25.5)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, -math.pi / 2.0)

    c_front = make_cam("Cam_Front_Ortho", (0.0, 38.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=24.0)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -38.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=24.0)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 42.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=36.0)
    c_top.rotation_euler = (0.0, 0.0, math.pi)

    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -42.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=36.0)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    make_cam("Cam_Rear_34", (20.2, -23.8, 7.2), (0.0, -1.8, 0.0), cam_type="PERSP", lens=36.0)

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

    # Standard color transform preserves pure anime cel whites, crisp ink black & vibrant violet!
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
# 12. Main Build Entrypoint + Strict Bilateral Symmetry Verification
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root     = ensure_collection("OpenCode_PortalCarrier")
    col_solid    = ensure_collection("OpenCode_Solid_LineArt_Source", col_root)
    col_hull     = ensure_collection("01_Main_Gate_Hull_Beams", col_solid)
    col_jaw      = ensure_collection("02_Forward_Jaw_And_Cleft", col_solid)
    col_portal   = ensure_collection("03_Central_Portal_Frame", col_solid)
    col_trim     = ensure_collection("04_Perimeter_Trim_Channels", col_solid)
    col_ring     = ensure_collection("05_Rear_Octagonal_Truss_Ring", col_solid)
    col_stern    = ensure_collection("06_Stern_Violet_Plasma_Drives", col_solid)
    col_detail   = ensure_collection("07_Greebles_RCS_And_Details", col_solid)
    col_fx       = ensure_collection("08_Comic_Emissive_And_Holo_FX", col_root)
    col_ink      = ensure_collection("98_Comic_Ink_LineArt")
    col_stage    = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("OpenCode_Carrier_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_opencode_textures()
    mats = build_materials(tex)

    build_main_gate_hull(mats, col_hull, root)
    build_forward_jaw_and_cleft(mats, col_jaw, root)
    build_open_portal_bay_and_holograms(mats, col_portal, col_fx, root)
    build_violet_perimeter_trim(mats, col_trim, col_fx, root)
    build_rear_octagonal_truss_ring(mats, col_ring, root)
    build_stern_propulsion_complex(mats, col_stern, root)
    build_greebles_and_surface_details(mats, col_detail, root)

    setup_comic_lineart(col_solid, col_ink)
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

    x_sym_err = abs(min(xs) + max(xs))
    z_ring_sym_err = abs(min(zs) + max(zs))

    print(
        f"BUILT OpenCode_PortalCarrier V3 (Mecha Comic Cel-Shaded + Dual-Weight Ink LineArt): "
        f"{len(mesh_objs)} meshes, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.3f},{max(xs):.3f}] ({max(xs)-min(xs):.2f}m, X-sym-err={x_sym_err:.5f}m) "
        f"Y=[{min(ys):.3f},{max(ys):.3f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.3f},{max(zs):.3f}] ({max(zs)-min(zs):.2f}m, Z-sym-err={z_ring_sym_err:.5f}m)"
    )
    return cameras


build_all()
