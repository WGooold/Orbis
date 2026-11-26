"""Parametric sculpted hard-surface 3D model builder for the DeepSeek Orbital Explorer (V8 Anime Cel-Shaded Cartoon + Dual-Weight Ink LineArt).

Built from the DeepSeek concept & 4 orthographic reference views with refined
DeepSeek whale-icon hydrodynamic streamlining, signature DeepSeek royal-azure blue,
sculpted whale feature lines across the flanks & V-tail flukes, and a unified
fluid whale-spine dorsal carapace, shaded in Ligne-Claire Anime Cartoon style:
  - 4-band EEVEE NPR Cel-Shading (ShaderToRGB stepped cool anime shadows, crisp
    porcelain-white & DeepSeek royal-azure highlights, stepped AO crevice ink,
    anime specular catchlights & cool grazing Fresnel rim)
  - Stylized Anime Cel-Shaded Sapphire Canopy Glass with stepped sky-cyan cel bands
    and sharp glossy anime reflection slashes (zero spiderweb, zero moire)
  - Dual-weight Blender 5.3 Grease Pencil Line Art deep-indigo ink outlines
    (bold silhouette contours + crisp technical crease/material/intersection lines)
  - Dual-target Material Output (EEVEE NPR Cel Shader + glTF-compatible Principled BSDF)
  - Clean 2048x2048 hand-inked Ligne-Claire anime panel-line textures

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-3.84, +3.84] (7.68 m max beam)
  -Y = Stern, +Y = Bow             -> Y in [-10.12, +10.00] (20.12 m total length)
  -Z = Ventral, +Z = Dorsal        -> Z in [-2.41, +4.45] (6.86 m total height)
"""

import math
import os
import struct
import zlib
import bpy
import bmesh
import numpy as np
from mathutils import Euler, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/deepseek"
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
# 1. Procedural 2048x2048 Oceanic Aerospace Composite PBR Texture Synthesis
# ---------------------------------------------------------------------------

def _tileable_fbm(res, seed, octaves=(4, 8, 16, 32, 64, 128), weights=(0.30, 0.25, 0.18, 0.12, 0.09, 0.06)):
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


def _generate_aerospace_panels(res, seed, grid_x=2, grid_y=3, sub_prob=0.45, seam_px=3, add_blue_trace=False):
    """Synthesize clean Ligne-Claire anime mecha panel lines (crisp ink seams, clean tone blocks, zero gritty clutter)."""
    rng = np.random.default_rng(seed)
    tone = np.zeros((res, res), dtype=np.float32)
    seam = np.zeros((res, res), dtype=np.float32)
    accent = np.zeros((res, res), dtype=np.float32)
    rivet = np.zeros((res, res), dtype=np.float32)
    trace = np.zeros((res, res), dtype=np.float32)

    xs = [0]
    ys = [0]
    sx = res // grid_x
    sy = res // grid_y
    margin = max(64, res // 14)
    for i in range(1, grid_x):
        xs.append(int(np.clip(i * sx + rng.integers(-sx // 7, sx // 7 + 1), margin, res - margin)))
    for j in range(1, grid_y):
        ys.append(int(np.clip(j * sy + rng.integers(-sy // 7, sy // 7 + 1), margin, res - margin)))
    xs.append(res)
    ys.append(res)

    def draw_diag(arr, x0, y0, length, dx, dy, width=2, val=1.0):
        for step in range(length):
            px = (x0 + step * dx) % res
            py = (y0 + step * dy) % res
            for wy in range(width):
                for wx in range(width):
                    arr[(py + wy) % res, (px + wx) % res] = max(arr[(py + wy) % res, (px + wx) % res], val)

    def paint_rect(x0, y0, x1, y1, depth=0):
        w = x1 - x0
        h = y1 - y0
        if depth < 1 and min(w, h) > max(220, res // 5) and rng.random() < sub_prob:
            if w >= h:
                xm = x0 + int(w * rng.uniform(0.36, 0.64))
                paint_rect(x0, y0, xm, y1, depth + 1)
                paint_rect(xm, y0, x1, y1, depth + 1)
            else:
                ym = y0 + int(h * rng.uniform(0.36, 0.64))
                paint_rect(x0, y0, x1, ym, depth + 1)
                paint_rect(x0, ym, x1, y1, depth + 1)
            return

        # Clean graphic anime cel plate tonal step (subtle crisp cool/bright alternation)
        tone[y0:y1, x0:x1] = float(rng.choice([-0.032, -0.012, 0.0, 0.016, 0.028]))
        sp = seam_px if depth == 0 else max(2, seam_px - 1)
        seam[y0:min(y0 + sp, y1), x0:x1] = 1.0
        seam[max(y1 - sp, y0):y1, x0:x1] = 1.0
        seam[y0:y1, x0:min(x0 + sp, x1)] = 1.0
        seam[y0:y1, max(x1 - sp, x0):x1] = 1.0

        # Signature 45-deg anime mecha panel corner chamfer ink lines
        if min(w, h) > res // 8 and rng.random() < 0.65:
            ch = int(min(w, h) * rng.uniform(0.08, 0.14))
            draw_diag(seam, x0 + ch, y0 + sp, ch, -1, 1, width=max(2, sp - 1), val=0.95)
            draw_diag(seam, x1 - ch - sp, y1 - sp, ch, 1, -1, width=max(2, sp - 1), val=0.95)
            if add_blue_trace and rng.random() < 0.42:
                draw_diag(trace, x0 + ch + 10, y0 + sp + 10, max(16, ch - 10), -1, 1, width=3, val=0.75)

        # Clean sparse anime inspection hatch + crisp comic vent strokes
        if w > res // 4 and h > res // 4 and rng.random() < 0.48:
            hw = int(w * rng.uniform(0.18, 0.28))
            hh = int(h * rng.uniform(0.16, 0.24))
            hx0 = x0 + int(w * rng.uniform(0.16, 0.72 - hw / float(w)))
            hy0 = y0 + int(h * rng.uniform(0.16, 0.72 - hh / float(h)))
            hx1 = min(hx0 + hw, x1 - 32)
            hy1 = min(hy0 + hh, y1 - 32)
            if hx1 - hx0 > 64 and hy1 - hy0 > 48:
                tone[hy0:hy1, hx0:hx1] += float(rng.choice([-0.022, 0.020]))
                seam[hy0:hy0 + 2, hx0:hx1] = 0.92
                seam[hy1 - 2:hy1, hx0:hx1] = 0.92
                seam[hy0:hy1, hx0:hx0 + 2] = 0.92
                seam[hy0:hy1, hx1 - 2:hx1] = 0.92
                if rng.random() < 0.45 and (hy1 - hy0) > 60:
                    for sl in range(3):
                        sy_p = hy0 + 14 + int((hy1 - hy0 - 28) * sl / 2.0)
                        seam[sy_p:sy_p + 3, hx0 + 14:hx1 - 14] = 0.88

        # Sparse clean manga technical corner fastener dots (4 corners only — silky uncluttered whale hull!)
        pad = sp + max(18, res // 80)
        rsz = max(3, res // 440)
        if w > pad * 4 and h > pad * 4:
            for rx in (x0 + pad, x1 - pad - rsz):
                for ry in (y0 + pad, y1 - pad - rsz):
                    if 0 <= ry < res - rsz and 0 <= rx < res - rsz:
                        rivet[ry:ry + rsz, rx:rx + rsz] = 0.85

        if add_blue_trace and w > res // 5 and h > res // 6 and rng.random() < 0.32:
            ly = y0 + sp + 22
            lx0 = x0 + int(w * 0.16)
            lx1 = x0 + int(w * 0.52)
            if ly < y1 - 16 and lx1 > lx0 + 24:
                trace[ly:ly + 3, lx0:lx1] = 0.72
                trace[ly - 2:ly + 5, lx1:min(lx1 + 8, x1 - 10)] = 0.88

    for j in range(len(ys) - 1):
        for i in range(len(xs) - 1):
            paint_rect(xs[i], ys[j], xs[i + 1], ys[j + 1], depth=0)

    seam_aa = np.clip(
        seam * 0.74
        + np.roll(seam, 1, axis=0) * 0.08
        + np.roll(seam, -1, axis=0) * 0.08
        + np.roll(seam, 1, axis=1) * 0.08
        + np.roll(seam, -1, axis=1) * 0.08,
        0.0,
        1.0,
    )
    rivet_aa = np.clip(
        rivet * 0.70
        + np.roll(rivet, 1, axis=0) * 0.08
        + np.roll(rivet, -1, axis=0) * 0.08
        + np.roll(rivet, 1, axis=1) * 0.08
        + np.roll(rivet, -1, axis=1) * 0.08,
        0.0,
        1.0,
    )
    return tone, seam_aa, accent, rivet_aa, trace


def _height_to_normal(height, strength=2.0):
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


def generate_deepseek_textures(res=1024):
    """Synthesize ultra-clean, silky stylized anime cel-ceramic textures (ZERO messy UV grid lines!)."""
    # Subtle micro-silk variation only — lets the real 3D sculpted whale curves & cel bands shine cleanly!
    silk = _tileable_fbm(res, seed=131, octaves=(4, 8, 16), weights=(0.45, 0.35, 0.20))
    soft = (silk - 0.5) * 0.014

    # Set A: Pure Silky Anime Porcelain-White Ceramic (multiplied cleanly over cel ramp)
    white_albedo = np.stack([
        np.clip(0.985 + soft, 0.0, 1.0),
        np.clip(0.990 + soft, 0.0, 1.0),
        np.clip(1.000 + soft * 0.5, 0.0, 1.0),
    ], axis=-1)
    white_rough = np.clip(0.42 + soft * 2.0, 0.30, 0.58)
    white_rough_rgb = np.stack([white_rough, white_rough, white_rough], axis=-1)
    flat_nrm = np.zeros((res, res, 3), dtype=np.float32)
    flat_nrm[..., 0] = 0.5
    flat_nrm[..., 1] = 0.5
    flat_nrm[..., 2] = 1.0

    # Set B: Pure Silky Anime Whale-Blue Glossy Lacquer Base
    blue_albedo = np.stack([
        np.clip(0.980 + soft, 0.0, 1.0),
        np.clip(0.988 + soft, 0.0, 1.0),
        np.clip(1.000 + soft * 0.5, 0.0, 1.0),
    ], axis=-1)
    blue_rough = np.clip(0.36 + soft * 2.0, 0.24, 0.52)
    blue_rough_rgb = np.stack([blue_rough, blue_rough, blue_rough], axis=-1)

    # Set C: Pure Clean Anime Satin Slate-Navy Machinery Base
    titanium_albedo = np.stack([
        np.clip(0.960 + soft, 0.0, 1.0),
        np.clip(0.970 + soft, 0.0, 1.0),
        np.clip(0.995 + soft * 0.5, 0.0, 1.0),
    ], axis=-1)
    titanium_rough = np.clip(0.44 + soft * 2.0, 0.30, 0.62)
    titanium_rough_rgb = np.stack([titanium_rough, titanium_rough, titanium_rough], axis=-1)

    return {
        "white_albedo":    _save_and_pack_image("Tex_DeepSeekWhite_Albedo",    os.path.join(TEX_DIR, "pearl_white_albedo.png"),   white_albedo, "sRGB"),
        "white_rough":     _save_and_pack_image("Tex_DeepSeekWhite_Rough",     os.path.join(TEX_DIR, "pearl_white_rough.png"),    white_rough_rgb, "Non-Color"),
        "white_normal":    _save_and_pack_image("Tex_DeepSeekWhite_Normal",    os.path.join(TEX_DIR, "pearl_white_normal.png"),   flat_nrm, "Non-Color"),
        "blue_albedo":     _save_and_pack_image("Tex_DeepSeekBlue_Albedo",     os.path.join(TEX_DIR, "ocean_blue_albedo.png"),    blue_albedo, "sRGB"),
        "blue_rough":      _save_and_pack_image("Tex_DeepSeekBlue_Rough",      os.path.join(TEX_DIR, "ocean_blue_rough.png"),     blue_rough_rgb, "Non-Color"),
        "blue_normal":     _save_and_pack_image("Tex_DeepSeekBlue_Normal",     os.path.join(TEX_DIR, "ocean_blue_normal.png"),    flat_nrm, "Non-Color"),
        "titanium_albedo": _save_and_pack_image("Tex_DeepSeekTitanium_Albedo", os.path.join(TEX_DIR, "dark_titanium_albedo.png"), titanium_albedo, "sRGB"),
        "titanium_rough":  _save_and_pack_image("Tex_DeepSeekTitanium_Rough",  os.path.join(TEX_DIR, "dark_titanium_rough.png"),  titanium_rough_rgb, "Non-Color"),
        "titanium_normal": _save_and_pack_image("Tex_DeepSeekTitanium_Normal", os.path.join(TEX_DIR, "dark_titanium_normal.png"), flat_nrm, "Non-Color"),
    }


# ---------------------------------------------------------------------------
# 2. DeepSeek V8 Anime Cel-Shaded Cartoon Materials (EEVEE NPR + glTF Fallback)
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
    uv_scale=0.46,
    normal_strength=0.14,
    spec_strength=0.22,
    spec_roughness=0.20,
    spec_threshold=0.68,
    rim_strength=0.20,
    rim_color=(0.76, 0.90, 1.0),
    ao_strength=0.58,
    ao_distance=0.68,
    gltf_base_color=None,
    gltf_metallic=0.10,
    gltf_roughness=0.55,
):
    """Build a dual-output Ligne-Claire Anime Cel-Shaded Cartoon material:
      - EEVEE Output (target='EEVEE'): True 4-band stepped cel shading via Diffuse -> ShaderToRGB
        -> stepped ColorRamp, multiplied by hand-inked 2048px comic panel art & stepped AO ink,
        plus sharp anime specular catchlights and crisp cool Fresnel edge rim!
      - ALL Output (target='ALL'): Clean Principled BSDF with comic panel texture for glTF/Three.js.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out_eevee = nt.nodes.new("ShaderNodeOutputMaterial")
    out_eevee.name = "Cartoon_EEVEE_Output"
    out_eevee.target = "EEVEE"
    out_eevee.location = (1280, 220)

    out_all = nt.nodes.new("ShaderNodeOutputMaterial")
    out_all.name = "Cartoon_Export_Output"
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

    # 1. Stepped Anime Diffuse Cel Ramp
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

    # 2. Multiply Cel Ramp by Clean Hand-Inked Panel Linework Texture
    if tex_col is not None:
        mix_tex = nt.nodes.new("ShaderNodeMix")
        mix_tex.data_type = "RGBA"
        mix_tex.blend_type = "MULTIPLY"
        mix_tex.location = (560, 360)
        mix_tex.inputs["Factor"].default_value = 1.0
        nt.links.new(cel_socket, mix_tex.inputs["A"])
        nt.links.new(tex_col.outputs["Color"], mix_tex.inputs["B"])
        cel_socket = mix_tex.outputs["Result"]

    # 3. Stepped Ambient Occlusion Indigo Crevice Shading
    if ao_strength > 0.0:
        ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.location = (80, 120)
        ao.inputs["Distance"].default_value = ao_distance

        ao_ramp = nt.nodes.new("ShaderNodeValToRGB")
        ao_ramp.location = (280, 120)
        ao_cr = ao_ramp.color_ramp
        ao_cr.elements[0].position = 0.22
        ao_cr.elements[0].color = (0.26, 0.34, 0.56, 1.0)
        ao_cr.elements[1].position = 0.54
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

    # 4. Sharp Stepped Anime Specular Highlight Pop
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
        scr.elements[0].position = max(0.05, spec_threshold - 0.025)
        scr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
        scr.elements[1].position = min(0.98, spec_threshold + 0.025)
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

    # 5. Crisp Grazing Anime Sky-Cyan Fresnel Rim Catchlight
    if rim_strength > 0.0:
        lw = nt.nodes.new("ShaderNodeLayerWeight")
        lw.location = (280, -240)
        lw.inputs["Blend"].default_value = 0.26

        rramp = nt.nodes.new("ShaderNodeValToRGB")
        rramp.location = (500, -240)
        rcr = rramp.color_ramp
        rcr.elements[0].position = 0.63
        rcr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
        rcr.elements[1].position = 0.71
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


def make_anime_cel_glass_mat(name, base_alpha=0.68):
    """Build a stylized translucent Anime Cel-Shaded Sapphire Canopy Glass shader (zero moire!).
      - EEVEE Output: Stepped oceanic-sapphire cel bands + razor-sharp white anime specular reflection
        slash + luminous sky-cyan Fresnel edge rim, blended cleanly over Transparent BSDF!
      - ALL Output: Clean translucent sapphire Principled BSDF for glTF / Three.js.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    if hasattr(mat, "blend_method"):
        mat.blend_method = "BLEND"
    if hasattr(mat, "use_backface_culling"):
        mat.use_backface_culling = True
    nt = mat.node_tree
    nt.nodes.clear()

    out_eevee = nt.nodes.new("ShaderNodeOutputMaterial")
    out_eevee.name = "CartoonGlass_EEVEE_Output"
    out_eevee.target = "EEVEE"
    out_eevee.location = (1240, 220)

    out_all = nt.nodes.new("ShaderNodeOutputMaterial")
    out_all.name = "CartoonGlass_Export_Output"
    out_all.target = "ALL"
    out_all.location = (1240, -260)

    # 1. Stepped sapphire tint gradient from light direction
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diff.location = (-360, 420)
    s2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    s2rgb.location = (-140, 420)
    nt.links.new(diff.outputs["BSDF"], s2rgb.inputs["Shader"])
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    bw.location = (60, 420)
    nt.links.new(s2rgb.outputs["Color"], bw.inputs["Color"])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.location = (260, 440)
    cr = ramp.color_ramp
    cr.interpolation = "LINEAR"
    glass_bands = [
        (0.00, (0.014, 0.062, 0.260)),
        (0.24, (0.014, 0.062, 0.260)),
        (0.28, (0.036, 0.145, 0.560)),
        (0.62, (0.036, 0.145, 0.560)),
        (0.66, (0.095, 0.310, 0.880)),
        (0.84, (0.095, 0.310, 0.880)),
        (0.88, (0.340, 0.680, 1.000)),
        (1.00, (0.340, 0.680, 1.000)),
    ]
    cr.elements[0].position = glass_bands[0][0]
    cr.elements[0].color = (*glass_bands[0][1], 1.0)
    cr.elements[1].position = glass_bands[-1][0]
    cr.elements[1].color = (*glass_bands[-1][1], 1.0)
    for pos, rgb in glass_bands[1:-1]:
        el = cr.elements.new(pos)
        el.color = (*rgb, 1.0)
    nt.links.new(bw.outputs["Val"], ramp.inputs["Fac"])

    # 2. Razor-crisp Anime White Specular Slash across the curved whale glass dome!
    gloss = nt.nodes.new("ShaderNodeBsdfGlossy")
    gloss.location = (-360, 60)
    gloss.inputs["Roughness"].default_value = 0.09
    gs2rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    gs2rgb.location = (-140, 60)
    nt.links.new(gloss.outputs["BSDF"], gs2rgb.inputs["Shader"])
    gbw = nt.nodes.new("ShaderNodeRGBToBW")
    gbw.location = (60, 60)
    nt.links.new(gs2rgb.outputs["Color"], gbw.inputs["Color"])

    sramp = nt.nodes.new("ShaderNodeValToRGB")
    sramp.location = (260, 60)
    scr = sramp.color_ramp
    scr.elements[0].position = 0.52
    scr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    scr.elements[1].position = 0.56
    scr.elements[1].color = (0.94, 0.98, 1.0, 1.0)
    nt.links.new(gbw.outputs["Val"], sramp.inputs["Fac"])

    mix_spec = nt.nodes.new("ShaderNodeMix")
    mix_spec.data_type = "RGBA"
    mix_spec.blend_type = "ADD"
    mix_spec.clamp_result = True
    mix_spec.location = (600, 300)
    mix_spec.inputs["Factor"].default_value = 0.78
    nt.links.new(ramp.outputs["Color"], mix_spec.inputs["A"])
    nt.links.new(sramp.outputs["Color"], mix_spec.inputs["B"])

    # 3. Crisp Electric Sky-Cyan Fresnel Rim on glass silhouette edges
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.location = (260, -140)
    lw.inputs["Blend"].default_value = 0.30
    rramp = nt.nodes.new("ShaderNodeValToRGB")
    rramp.location = (460, -140)
    rcr = rramp.color_ramp
    rcr.elements[0].position = 0.58
    rcr.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    rcr.elements[1].position = 0.66
    rcr.elements[1].color = (0.45, 0.85, 1.0, 1.0)
    nt.links.new(lw.outputs["Facing"], rramp.inputs["Fac"])

    mix_rim = nt.nodes.new("ShaderNodeMix")
    mix_rim.data_type = "RGBA"
    mix_rim.blend_type = "ADD"
    mix_rim.clamp_result = True
    mix_rim.location = (780, 260)
    mix_rim.inputs["Factor"].default_value = 0.42
    nt.links.new(mix_spec.outputs["Result"], mix_rim.inputs["A"])
    nt.links.new(rramp.outputs["Color"], mix_rim.inputs["B"])

    # Blend Anime Cel Glass Emission over Transparent BSDF (specular slash becomes nearly opaque white!)
    emis = nt.nodes.new("ShaderNodeEmission")
    emis.location = (940, 260)
    emis.inputs["Strength"].default_value = 1.0
    nt.links.new(mix_rim.outputs["Result"], emis.inputs["Color"])

    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    transp.location = (940, 100)

    # Boost opacity cleanly on specular highlights so anime white glare pops vividly!
    alpha_math = nt.nodes.new("ShaderNodeMath")
    alpha_math.operation = "ADD"
    alpha_math.use_clamp = True
    alpha_math.location = (780, 40)
    alpha_math.inputs[0].default_value = base_alpha
    alpha_mul = nt.nodes.new("ShaderNodeMath")
    alpha_mul.operation = "MULTIPLY"
    alpha_mul.location = (600, 40)
    alpha_mul.inputs[1].default_value = 0.30
    nt.links.new(sramp.outputs["Color"], alpha_mul.inputs[0])
    nt.links.new(alpha_mul.outputs["Value"], alpha_math.inputs[1])

    mix_sh = nt.nodes.new("ShaderNodeMixShader")
    mix_sh.location = (1100, 220)
    nt.links.new(alpha_math.outputs["Value"], mix_sh.inputs["Fac"])
    nt.links.new(transp.outputs["BSDF"], mix_sh.inputs[1])
    nt.links.new(emis.outputs["Emission"], mix_sh.inputs[2])
    nt.links.new(mix_sh.outputs["Shader"], out_eevee.inputs["Surface"])

    # glTF / Three.js Export Fallback
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (860, -260)
    set_bsdf_input(bsdf, ["Base Color"], (0.10, 0.34, 0.78, 1.0))
    set_bsdf_input(bsdf, ["Metallic"], 0.15)
    set_bsdf_input(bsdf, ["Roughness"], 0.08)
    set_bsdf_input(bsdf, ["Alpha"], base_alpha)
    set_bsdf_input(bsdf, ["Emission Color", "Emission"], (0.06, 0.22, 0.54, 1.0))
    set_bsdf_input(bsdf, ["Emission Strength"], 0.18)
    nt.links.new(bsdf.outputs["BSDF"], out_all.inputs["Surface"])
    return mat


def make_solid_pbr_mat(
    name,
    base_color,
    metallic=0.0,
    roughness=0.22,
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
        if hasattr(mat, "use_backface_culling"):
            mat.use_backface_culling = True
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    return mat


def build_materials(tex):
    return {
        # Primary Cartoon Porcelain-White Whale Armor (Crisp Snow Highlight -> Clean White -> Periwinkle Shadow!)
        "pearl_white": make_comic_cel_mat(
            "Mat_DeepSeek_PearlWhite",
            cel_bands=[
                (0.00, (0.18, 0.27, 0.48)),
                (0.16, (0.18, 0.27, 0.48)),
                (0.19, (0.48, 0.59, 0.78)),
                (0.45, (0.48, 0.59, 0.78)),
                (0.48, (0.88, 0.93, 0.99)),
                (0.80, (0.88, 0.93, 0.99)),
                (0.83, (1.00, 1.00, 1.00)),
                (1.00, (1.00, 1.00, 1.00)),
            ],
            albedo_img=tex["white_albedo"],
            normal_img=tex["white_normal"],
            uv_scale=0.44,
            normal_strength=0.14,
            spec_strength=0.16,
            spec_roughness=0.20,
            spec_threshold=0.72,
            rim_strength=0.14,
            rim_color=(0.82, 0.94, 1.0),
            ao_strength=0.40,
            ao_distance=0.58,
            gltf_base_color=(0.90, 0.94, 0.99),
            gltf_metallic=0.06,
            gltf_roughness=0.52,
        ),
        # Cool Anime Ice-Silver Dorsal Spine Ribs & Accent Hardware
        "ice_silver": make_comic_cel_mat(
            "Mat_DeepSeek_IceSilver",
            cel_bands=[
                (0.00, (0.14, 0.24, 0.44)),
                (0.16, (0.14, 0.24, 0.44)),
                (0.19, (0.38, 0.50, 0.72)),
                (0.45, (0.38, 0.50, 0.72)),
                (0.48, (0.72, 0.82, 0.95)),
                (0.80, (0.72, 0.82, 0.95)),
                (0.83, (0.94, 0.98, 1.00)),
                (1.00, (0.94, 0.98, 1.00)),
            ],
            albedo_img=tex["white_albedo"],
            normal_img=tex["white_normal"],
            uv_scale=0.56,
            normal_strength=0.14,
            spec_strength=0.22,
            spec_roughness=0.18,
            spec_threshold=0.68,
            rim_strength=0.16,
            rim_color=(0.80, 0.92, 1.0),
            ao_strength=0.58,
            ao_distance=0.60,
            gltf_base_color=(0.72, 0.82, 0.95),
            gltf_metallic=0.18,
            gltf_roughness=0.48,
        ),
        # Deep Anime Oceanic-Indigo Structural Underbody & Waist Contrast (gamma-calibrated linear RGB!)
        "ocean_blue": make_comic_cel_mat(
            "Mat_DeepSeek_OceanBlue",
            cel_bands=[
                (0.00, (0.012, 0.032, 0.145)),
                (0.18, (0.012, 0.032, 0.145)),
                (0.21, (0.028, 0.080, 0.340)),
                (0.48, (0.028, 0.080, 0.340)),
                (0.51, (0.055, 0.155, 0.560)),
                (0.80, (0.055, 0.155, 0.560)),
                (0.83, (0.125, 0.295, 0.820)),
                (1.00, (0.125, 0.295, 0.820)),
            ],
            albedo_img=tex["blue_albedo"],
            normal_img=tex["blue_normal"],
            uv_scale=0.50,
            normal_strength=0.14,
            spec_strength=0.18,
            spec_roughness=0.20,
            spec_threshold=0.70,
            rim_strength=0.16,
            rim_color=(0.42, 0.72, 1.0),
            ao_strength=0.62,
            ao_distance=0.72,
            gltf_base_color=(0.055, 0.155, 0.560),
            gltf_metallic=0.16,
            gltf_roughness=0.50,
        ),
        # Signature DeepSeek Icon Whale Royal-Azure Blue (exact linear RGB for vivid sRGB #4D6BFE!)
        "deepseek_blue": make_comic_cel_mat(
            "Mat_DeepSeek_WhaleBlue",
            cel_bands=[
                (0.00, (0.018, 0.048, 0.290)),
                (0.16, (0.018, 0.048, 0.290)),
                (0.19, (0.040, 0.105, 0.620)),
                (0.44, (0.040, 0.105, 0.620)),
                (0.47, (0.078, 0.185, 0.990)),
                (0.80, (0.078, 0.185, 0.990)),
                (0.83, (0.190, 0.390, 1.000)),
                (1.00, (0.190, 0.390, 1.000)),
            ],
            albedo_img=tex["blue_albedo"],
            normal_img=tex["blue_normal"],
            uv_scale=0.48,
            normal_strength=0.12,
            spec_strength=0.22,
            spec_roughness=0.16,
            spec_threshold=0.68,
            rim_strength=0.16,
            rim_color=(0.50, 0.78, 1.0),
            ao_strength=0.54,
            ao_distance=0.65,
            gltf_base_color=(0.078, 0.185, 0.990),
            gltf_metallic=0.10,
            gltf_roughness=0.46,
        ),
        # Saturated Anime Cobalt Accent Trim (Stern Housing, Exhaust Trough & Fluke Echo)
        "cobalt_trim": make_comic_cel_mat(
            "Mat_DeepSeek_CobaltTrim",
            cel_bands=[
                (0.00, (0.014, 0.038, 0.220)),
                (0.17, (0.014, 0.038, 0.220)),
                (0.20, (0.032, 0.088, 0.480)),
                (0.46, (0.032, 0.088, 0.480)),
                (0.49, (0.062, 0.155, 0.800)),
                (0.80, (0.062, 0.155, 0.800)),
                (0.83, (0.145, 0.320, 0.980)),
                (1.00, (0.145, 0.320, 0.980)),
            ],
            albedo_img=tex["blue_albedo"],
            normal_img=tex["blue_normal"],
            uv_scale=0.54,
            normal_strength=0.14,
            spec_strength=0.20,
            spec_roughness=0.18,
            spec_threshold=0.69,
            rim_strength=0.16,
            rim_color=(0.45, 0.76, 1.0),
            ao_strength=0.58,
            ao_distance=0.65,
            gltf_base_color=(0.062, 0.155, 0.800),
            gltf_metallic=0.14,
            gltf_roughness=0.48,
        ),
        # Readable Anime Dark Slate-Navy Machinery, Intakes, Louvers & Turbine Barrels
        "dark_titanium": make_comic_cel_mat(
            "Mat_DeepSeek_DarkTitanium",
            cel_bands=[
                (0.00, (0.048, 0.070, 0.145)),
                (0.17, (0.048, 0.070, 0.145)),
                (0.20, (0.120, 0.168, 0.295)),
                (0.47, (0.120, 0.168, 0.295)),
                (0.50, (0.235, 0.305, 0.475)),
                (0.80, (0.235, 0.305, 0.475)),
                (0.83, (0.395, 0.485, 0.675)),
                (1.00, (0.395, 0.485, 0.675)),
            ],
            albedo_img=tex["titanium_albedo"],
            normal_img=tex["titanium_normal"],
            uv_scale=0.68,
            normal_strength=0.16,
            spec_strength=0.28,
            spec_roughness=0.18,
            spec_threshold=0.66,
            rim_strength=0.20,
            rim_color=(0.66, 0.82, 1.0),
            ao_strength=0.66,
            ao_distance=0.65,
            gltf_base_color=(0.235, 0.305, 0.475),
            gltf_metallic=0.28,
            gltf_roughness=0.50,
        ),
        # Sleek Deep-Sapphire Anime Metallic Canopy Streamline Ribs & Atrium Frame
        "canopy_rib": make_comic_cel_mat(
            "Mat_DeepSeek_CanopyStreamlineRib",
            cel_bands=[
                (0.00, (0.035, 0.088, 0.270)),
                (0.18, (0.035, 0.088, 0.270)),
                (0.21, (0.100, 0.225, 0.560)),
                (0.50, (0.100, 0.225, 0.560)),
                (0.53, (0.205, 0.400, 0.820)),
                (0.82, (0.205, 0.400, 0.820)),
                (0.85, (0.480, 0.720, 1.000)),
                (1.00, (0.480, 0.720, 1.000)),
            ],
            spec_strength=0.36,
            spec_roughness=0.14,
            spec_threshold=0.62,
            rim_strength=0.26,
            rim_color=(0.62, 0.88, 1.0),
            ao_strength=0.52,
            gltf_base_color=(0.18, 0.36, 0.76),
            gltf_metallic=0.30,
            gltf_roughness=0.38,
        ),
        # Classic Anime Cel Chrome Rings & Precision Hardware
        "chrome_alloy": make_comic_cel_mat(
            "Mat_DeepSeek_ChromeAlloy",
            cel_bands=[
                (0.00, (0.16, 0.24, 0.42)),
                (0.20, (0.16, 0.24, 0.42)),
                (0.23, (0.44, 0.56, 0.76)),
                (0.52, (0.44, 0.56, 0.76)),
                (0.55, (0.78, 0.88, 0.98)),
                (0.82, (0.78, 0.88, 0.98)),
                (0.85, (1.00, 1.00, 1.00)),
                (1.00, (1.00, 1.00, 1.00)),
            ],
            spec_strength=0.50,
            spec_roughness=0.12,
            spec_threshold=0.60,
            rim_strength=0.26,
            ao_strength=0.50,
            gltf_base_color=(0.76, 0.86, 0.96),
            gltf_metallic=0.55,
            gltf_roughness=0.28,
        ),
        # Crisp Dark Ink-Navy Internal Vanes & Louvers
        "dark_machinery": make_comic_cel_mat(
            "Mat_DeepSeek_DarkMachinery",
            cel_bands=[
                (0.00, (0.030, 0.045, 0.092)),
                (0.24, (0.030, 0.045, 0.092)),
                (0.27, (0.088, 0.122, 0.215)),
                (0.58, (0.088, 0.122, 0.215)),
                (0.61, (0.175, 0.228, 0.360)),
                (1.00, (0.175, 0.228, 0.360)),
            ],
            spec_strength=0.22,
            spec_roughness=0.22,
            spec_threshold=0.70,
            rim_strength=0.14,
            ao_strength=0.62,
            gltf_base_color=(0.12, 0.16, 0.26),
            gltf_metallic=0.28,
            gltf_roughness=0.54,
        ),
        # Deep Comic Shadow Ink Recesses & Throat Cavities
        "cavity_dark": make_comic_cel_mat(
            "Mat_DeepSeek_CavityDark",
            cel_bands=[
                (0.00, (0.016, 0.024, 0.052)),
                (0.45, (0.016, 0.024, 0.052)),
                (0.50, (0.044, 0.062, 0.120)),
                (1.00, (0.044, 0.062, 0.120)),
            ],
            spec_strength=0.0,
            rim_strength=0.0,
            ao_strength=0.45,
            gltf_base_color=(0.030, 0.042, 0.085),
            gltf_metallic=0.08,
            gltf_roughness=0.82,
        ),
        # Stylized Anime Cel-Shaded Sapphire Whale Canopy Glass (stepped blue bands + glossy white cel slash!)
        "canopy_glass": make_anime_cel_glass_mat("Mat_DeepSeek_CanopyGlass", base_alpha=0.68),
        # Graphic Anime Electric Sky-Blue Glow (calibrated for Standard view transform!)
        "cyan_glow": make_solid_pbr_mat(
            "Mat_DeepSeek_CyanGlow",
            base_color=(0.12, 0.68, 1.0),
            metallic=0.0,
            roughness=0.16,
            emission_color=(0.10, 0.64, 1.0),
            emission_strength=1.28,
        ),
        # Graphic Anime Luminous Aqua-Cyan Core Filament
        "cyan_core": make_solid_pbr_mat(
            "Mat_DeepSeek_CyanHotCore",
            base_color=(0.38, 0.88, 1.0),
            metallic=0.0,
            roughness=0.12,
            emission_color=(0.34, 0.86, 1.0),
            emission_strength=1.45,
        ),
        # Crisp Anime Cockpit Holographic HUD Instruments
        "cockpit_hud": make_solid_pbr_mat(
            "Mat_DeepSeek_CockpitHUD",
            base_color=(0.25, 0.84, 1.0),
            metallic=0.0,
            roughness=0.18,
            emission_color=(0.22, 0.80, 1.0),
            emission_strength=1.35,
        ),
    }


# ---------------------------------------------------------------------------
# 3. Hard-Surface BMesh Modeling & Curve Helpers
# ---------------------------------------------------------------------------

def apply_world_box_uv(bm, tile_meters=5.0):
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
    uv_tile_m=5.0,
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


def add_thick_surface_grid(
    name,
    grid_outer,
    grid_inner,
    mat,
    col,
    smooth=True,
    sharp_angle_deg=30.0,
    parent=None,
):
    """Build a watertight 3D shell between two (nu x nv) point grids."""
    bm = bmesh.new()
    nu = len(grid_outer)
    nv = len(grid_outer[0])
    vo = [[bm.verts.new(p) for p in row] for row in grid_outer]
    vi = [[bm.verts.new(p) for p in row] for row in grid_inner]

    for i in range(nu - 1):
        for j in range(nv - 1):
            try:
                bm.faces.new((vo[i][j], vo[i + 1][j], vo[i + 1][j + 1], vo[i][j + 1]))
            except ValueError:
                pass
            try:
                bm.faces.new((vi[i][j], vi[i][j + 1], vi[i + 1][j + 1], vi[i + 1][j]))
            except ValueError:
                pass

    for i in range(nu - 1):
        for a, b, c, d in (
            (vo[i][0], vi[i][0], vi[i + 1][0], vo[i + 1][0]),
            (vo[i][nv - 1], vo[i + 1][nv - 1], vi[i + 1][nv - 1], vi[i][nv - 1]),
        ):
            try:
                bm.faces.new((a, b, c, d))
            except ValueError:
                pass
    for j in range(nv - 1):
        for a, b, c, d in (
            (vo[0][j], vo[0][j + 1], vi[0][j + 1], vi[0][j]),
            (vo[nu - 1][j], vi[nu - 1][j], vi[nu - 1][j + 1], vo[nu - 1][j + 1]),
        ):
            try:
                bm.faces.new((a, b, c, d))
            except ValueError:
                pass

    return finalize_mesh(
        bm, name, mat, col,
        smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


def add_beveled_box(
    name, center, size, mat, col,
    bevel=0.02, bevel_segments=2, rot=(0.0, 0.0, 0.0),
    smooth=True, sharp_angle_deg=38.0, parent=None,
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
    segments=32, rot=(0.0, 0.0, 0.0), bevel=0.012,
    radius2=None, smooth=True, sharp_angle_deg=38.0, parent=None,
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


def add_revolved_x(
    name, center, profile_xr, mat, col,
    segments=64, side=1, smooth=True, sharp_angle_deg=34.0, parent=None,
):
    cx, cy, cz = center
    sections = []
    for s in range(segments):
        ang = 2.0 * math.pi * s / segments
        ca, sa = math.cos(ang), math.sin(ang)
        ring = [(cx + side * dx, cy + r * ca, cz + r * sa) for dx, r in profile_xr]
        sections.append(ring)
    return add_lofted_sections(
        name, sections, mat, col,
        closed_loop=True, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


def add_extruded_poly_y(
    name, pts_xz, y0, y1, mat, col,
    bevel=0.02, bevel_segments=2, scale0=1.0, scale1=1.0,
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


def add_swept_strut(
    name,
    path_pts,
    width,
    height,
    mat,
    col,
    chamfer=0.25,
    up_hint=(0.0, 0.0, 1.0),
    smooth=True,
    sharp_angle_deg=36.0,
    parent=None,
):
    pts = [Vector(p) for p in path_pts]
    n_pts = len(pts)
    up_vec = Vector(up_hint).normalized()
    hw, hh = width * 0.5, height * 0.5
    c = min(hw, hh) * chamfer
    profile = [
        ( hw - c,  hh),
        (-hw + c,  hh),
        (-hw,      hh - c),
        (-hw,     -hh + c),
        (-hw + c, -hh),
        ( hw - c, -hh),
        ( hw,     -hh + c),
        ( hw,      hh - c),
    ]
    sections = []
    for i, p in enumerate(pts):
        if i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == n_pts - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = (pts[i + 1] - pts[i - 1]).normalized()
        ref = up_vec
        if abs(t.dot(ref)) > 0.94:
            ref = Vector((0.0, 1.0, 0.0)) if abs(t.y) < 0.8 else Vector((1.0, 0.0, 0.0))
        u_axis = t.cross(ref).normalized()
        v_axis = u_axis.cross(t).normalized()
        ring = [tuple(p + u_axis * u + v_axis * v) for u, v in profile]
        sections.append(ring)
    return add_lofted_sections(
        name, sections, mat, col,
        cap_start=True, cap_end=True, smooth=smooth, sharp_angle_deg=sharp_angle_deg, parent=parent,
    )


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


def stadium_xz(cx, cz, hw, hh, n_arc=6):
    pts = []
    r = min(hh, hw * 0.85)
    straight = max(0.0, hw - r)
    for k in range(n_arc + 1):
        a = -math.pi * 0.5 + math.pi * k / float(n_arc)
        pts.append((cx + straight + r * math.cos(a), cz + r * math.sin(a)))
    for k in range(n_arc + 1):
        a = math.pi * 0.5 + math.pi * k / float(n_arc)
        pts.append((cx - straight + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def lerp(a, b, t):
    return a + (b - a) * t


def sample_piecewise(table, y):
    if table[0][0] > table[-1][0]:
        table = list(reversed(table))
    if y <= table[0][0]:
        return table[0][1:]
    if y >= table[-1][0]:
        return table[-1][1:]
    for i in range(len(table) - 1):
        y0 = table[i][0]
        y1 = table[i + 1][0]
        if y0 <= y <= y1:
            t = (y - y0) / max(y1 - y0, 1e-6)
            return tuple(lerp(a, b, t) for a, b in zip(table[i][1:], table[i + 1][1:]))
    return table[-1][1:]


# ---------------------------------------------------------------------------
# 4. Shared Parametric Whale-Hull & Canopy Surface Equations (V2 Precision)
# ---------------------------------------------------------------------------
# (y, half_w_core, z_top_spine, z_shoulder, z_chine, z_keel, spine_hw, keel_hw)
# Notice the sleek continuous bow taper & core tuck under the bow prow cap so ZERO clipping occurs!

HULL_TABLE = [
    (-9.42, 1.66,  1.24,  0.88, -0.18, -0.76, 0.90, 0.82),
    (-8.40, 1.98,  1.60,  1.18, -0.34, -0.94, 1.04, 0.92),
    (-7.20, 2.26,  1.96,  1.46, -0.50, -1.14, 1.16, 1.00),
    (-5.80, 2.58,  2.30,  1.72, -0.66, -1.32, 1.30, 1.12),
    (-4.20, 2.94,  2.60,  1.92, -0.80, -1.50, 1.44, 1.24),
    (-2.65, 3.04,  2.74,  1.98, -0.90, -1.66, 1.52, 1.34),
    (-1.00, 3.16,  2.82,  2.04, -0.94, -1.84, 1.56, 1.44),
    ( 0.85, 3.24,  2.88,  2.06, -0.90, -2.04, 1.58, 1.50),
    ( 2.45, 3.06,  2.68,  1.92, -0.84, -2.18, 1.50, 1.48),
    ( 3.80, 2.86,  2.10,  1.62, -0.82, -2.30, 1.36, 1.42),
    ( 5.20, 2.64,  1.52,  1.20, -0.82, -2.38, 1.20, 1.30),
    ( 6.60, 2.28,  0.90,  0.68, -0.88, -2.30, 1.04, 1.12),
    ( 7.85, 1.84,  0.22,  0.10, -0.96, -2.10, 0.88, 0.90),
    ( 8.85, 1.38, -0.44, -0.52, -1.04, -1.78, 0.72, 0.68),
    ( 9.50, 0.96, -0.86, -0.90, -1.10, -1.46, 0.50, 0.46),
    ( 9.82, 0.56, -1.08, -1.10, -1.16, -1.24, 0.32, 0.30),
]


def eval_hull_station(y):
    return sample_piecewise(HULL_TABLE, y)


def faceted_whale_ring(y, dip_canopy=True):
    """Build a crisp 16-vertex bilaterally symmetric faceted cetacean core cross-section."""
    hw, z_top, z_sh, z_ch, z_keel, sp_hw, kl_hw = eval_hull_station(y)
    z_center_top = z_top
    z_sp_edge = z_top - 0.13 * max(0.25, (z_top - z_keel) / 4.5)

    # Depress core top cleanly under the canopy tub AND under the white bow prow cap (ZERO z-clipping!)
    if dip_canopy and y > 2.55:
        if y < 8.45:
            f_rear = min(1.0, (y - 2.55) / 0.75)
            f_fwd = min(1.0, (8.45 - y) / 0.55)
            dep = f_rear * f_fwd * 0.78
            z_center_top -= dep
            z_sp_edge -= dep * 0.65
        else:
            # Under the white bow prow cap (Y >= 8.45), tuck top cleanly below the white prow shell
            z_center_top -= 0.16
            z_sp_edge -= 0.16

    z_mid_low = lerp(z_ch, z_keel, 0.54)
    z_mid_up = lerp(z_ch, z_sh, 0.55)

    pts_xz = [
        ( 0.0,                   z_center_top),
        ( sp_hw * 0.62,          lerp(z_center_top, z_sp_edge, 0.45)),
        ( sp_hw,                 z_sp_edge),
        ( lerp(sp_hw, hw, 0.56), z_sh),
        ( hw * 0.96,             z_mid_up),
        ( hw,                    z_ch),
        ( lerp(kl_hw, hw, 0.62), z_mid_low),
        ( kl_hw,                 lerp(z_mid_low, z_keel, 0.65)),
        ( 0.0,                   z_keel),
        (-kl_hw,                 lerp(z_mid_low, z_keel, 0.65)),
        (-lerp(kl_hw, hw, 0.62), z_mid_low),
        (-hw,                    z_ch),
        (-hw * 0.96,             z_mid_up),
        (-lerp(sp_hw, hw, 0.56), z_sh),
        (-sp_hw,                 z_sp_edge),
        (-sp_hw * 0.62,          lerp(z_center_top, z_sp_edge, 0.45)),
    ]
    return [(x, y, z) for x, z in pts_xz]


def canopy_surface_pt(u, v, normal_offset=0.0):
    """Evaluate 3D point on the sleek FLUSH vaulted DeepSeek geodesic panoramic canopy.

    u in [0.0, 1.0]: 0.0 = forward windshield base (Y=+8.55), 1.0 = rear brow crown (Y=+2.60)
    v in [-1.0, 1.0]: -1.0 = port sill, 0.0 = centerline crest, +1.0 = starboard sill
    """
    y = lerp(8.55, 2.60, u)
    # Flush whale-forehead roofline matching Side Ortho 17.18.19.png!
    # u=0 -> Z=-0.28, u=0.5 -> Z=+1.36, u=1.0 -> Z=+2.62
    z_crest = -0.28 + 2.90 * (1.0 - (1.0 - u) ** 1.52)

    # Canopy sill half-width (matching Top & Front Orthos cleanly!)
    hw = 0.96 + 0.96 * math.sin(min(1.0, u * 1.12) * math.pi * 0.62)
    if u > 0.78:
        t_back = (u - 0.78) / 0.22
        hw = lerp(hw, 1.62, t_back * t_back)

    drop = lerp(0.46, 0.96, math.sin(min(1.0, u * 1.15) * math.pi * 0.65))
    if u > 0.82:
        drop = lerp(drop, 0.74, (u - 0.82) / 0.18)

    av = abs(v)
    x = v * hw
    arch = 1.0 - (av ** 2.25)
    z = (z_crest - drop) + drop * arch

    if abs(normal_offset) > 1e-6:
        du = 0.01
        dv = 0.02
        p_ua = Vector(canopy_surface_pt(max(0.0, u - du), v, 0.0))
        p_ub = Vector(canopy_surface_pt(min(1.0, u + du), v, 0.0))
        p_va = Vector(canopy_surface_pt(u, max(-1.0, v - dv), 0.0))
        p_vb = Vector(canopy_surface_pt(u, min(1.0, v + dv), 0.0))
        n = (p_ub - p_ua).cross(p_vb - p_va)
        if n.length > 1e-6:
            n.normalize()
            if n.z < 0.0:
                n = -n
            p = Vector((x, y, z)) + n * normal_offset
            return (p.x, p.y, p.z)
    return (x, y, z)


# ---------------------------------------------------------------------------
# 5. Collection 01: Core Oceanic-Blue Hull, Sleek Belly, Chin Mouth & Keel Skeg
# ---------------------------------------------------------------------------

def build_core_chassis(mats, col, root):
    # 1A. Primary Sculpted Deep Midnight-Ocean Fuselage Body (Y = -9.42 .. +9.82)
    ys = [
        -9.42, -8.85, -8.10, -7.20, -6.20, -5.20, -4.20, -3.35, -2.65,
        -1.85, -1.00, -0.05,  0.85,  1.70,  2.45,  3.15,  3.85,  4.55,
         5.25,  6.00,  6.70,  7.40,  8.05,  8.65,  9.15,  9.52,  9.82,
    ]
    core_secs = [faceted_whale_ring(y, dip_canopy=True) for y in ys]
    add_lofted_sections(
        "Core_OceanBlue_Fuselage", core_secs, mats["ocean_blue"], col,
        smooth=True, sharp_angle_deg=34.0, parent=root,
    )

    # 1B. Sleek Flush Ventral Keel Underbelly Spine (NO sawtooth strakes poking out!)
    keel_stations = [
        (-7.40, 0.56, -1.06, -1.16),
        (-5.80, 0.74, -1.24, -1.36),
        (-4.00, 0.94, -1.44, -1.58),
        (-2.20, 1.06, -1.62, -1.78),
        (-0.20, 1.18, -1.84, -2.02),
        ( 2.00, 1.24, -2.04, -2.24),
        ( 4.40, 1.16, -2.20, -2.40),
        ( 6.00, 0.98, -2.18, -2.38),
        ( 7.40, 0.74, -2.00, -2.16),
        ( 8.60, 0.52, -1.74, -1.86),
    ]
    keel_secs = []
    for y, hw, zt, zb in keel_stations:
        keel_secs.append([
            (-hw,        y, zt),
            ( hw,        y, zt),
            ( hw * 0.70, y, zb),
            (-hw * 0.70, y, zb),
        ])
    add_lofted_sections(
        "Core_Ventral_KeelSpine", keel_secs, mats["dark_titanium"], col,
        bevel=0.025, smooth=True, sharp_angle_deg=34.0, parent=root,
    )

    # Flush stepped ventral maintenance plates along belly centerline (Bottom Ortho detail!)
    for idx, y_p in enumerate((-4.8, -2.8, -0.8, 1.2, 3.2, 5.2)):
        _, _, _, _, zk, _, kl_hw = eval_hull_station(y_p)
        add_beveled_box(
            f"Core_VentralAccessPlate_{idx}", (0.0, y_p, zk + 0.01), (kl_hw * 0.86, 1.35, 0.08),
            mats["ocean_blue"], col, bevel=0.02, parent=root,
        )

    # 1C. Sculpted Rear Ventral Keel Skeg / Stabilizer Tongue (Rear Ortho & Side Ortho!)
    skeg_secs = [
        [(-0.48, -9.05, -0.66), (0.48, -9.05, -0.66), (0.30, -9.05, -1.16), (0.0, -9.05, -1.32), (-0.30, -9.05, -1.16)],
        [(-0.58, -8.35, -0.74), (0.58, -8.35, -0.74), (0.42, -8.35, -1.34), (0.0, -8.35, -1.48), (-0.42, -8.35, -1.34)],
        [(-0.62, -7.25, -0.92), (0.62, -7.25, -0.92), (0.44, -7.25, -1.40), (0.0, -7.25, -1.48), (-0.44, -7.25, -1.40)],
        [(-0.50, -6.10, -1.08), (0.50, -6.10, -1.08), (0.30, -6.10, -1.30), (0.0, -6.10, -1.34), (-0.30, -6.10, -1.30)],
    ]
    add_lofted_sections(
        "Core_RearVentralKeelSkeg", skeg_secs, mats["cobalt_trim"], col,
        bevel=0.024, smooth=True, sharp_angle_deg=34.0, parent=root,
    )
    add_beveled_box(
        "Core_SkegCenterRidge", (0.0, -8.98, -1.06), (0.26, 0.38, 0.44),
        mats["ocean_blue"], col, bevel=0.024, rot=(0.24, 0.0, 0.0), parent=root,
    )

    # 1D. Iconic Bow Chin Recessed Sensor Mouth & Vivid Electric-Blue Core (Front Ortho & Hero!)
    mouth_outer = stadium_xz(0.0, -1.56, hw=0.80, hh=0.26, n_arc=6)
    mouth_inner = stadium_xz(0.0, -1.56, hw=0.60, hh=0.16, n_arc=6)
    add_hollow_frame_y(
        "Bow_ChinIntakeCollar", mouth_outer, mouth_inner,
        y_back=8.82, y_front=9.54, mat=mats["dark_titanium"], col=col,
        bevel=0.018, parent=root,
    )
    add_extruded_poly_y(
        "Bow_ChinIntakeCavity", mouth_inner, y0=8.60, y1=9.30,
        mat=mats["cavity_dark"], col=col, bevel=0.01, parent=root,
    )
    glow_ring = stadium_xz(0.0, -1.56, hw=0.50, hh=0.12, n_arc=6)
    add_extruded_poly_y(
        "Bow_ChinSensorGlowOuter", glow_ring, y0=9.24, y1=9.40,
        mat=mats["cyan_glow"], col=col, bevel=0.012, parent=root,
    )
    glow_core = stadium_xz(0.0, -1.56, hw=0.36, hh=0.062, n_arc=6)
    add_extruded_poly_y(
        "Bow_ChinSensorGlowCore", glow_core, y0=9.34, y1=9.44,
        mat=mats["cyan_core"], col=col, bevel=0.008, parent=root,
    )

    # Flanking Lower-Bow Corner Intake Vents with Electric-Blue Glow (cleanly tucked into lower bow cheeks!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Bow_CornerChinVentBezel_{tag}", (side * 1.12, 8.78, -1.46), (0.44, 0.54, 0.20),
            mats["ocean_blue"], col, bevel=0.02, rot=(0.10, -side * 0.16, -side * 0.44), parent=root,
        )
        add_beveled_box(
            f"Bow_CornerChinVentGlow_{tag}", (side * 1.18, 8.92, -1.46), (0.30, 0.18, 0.095),
            mats["cyan_glow"], col, bevel=0.01, rot=(0.10, -side * 0.16, -side * 0.44), parent=root,
        )


# ---------------------------------------------------------------------------
# 6. Collection 02: Unified Sculpted Pearl-White Faceted Aerospace Armor Shells
# ---------------------------------------------------------------------------

def build_pearl_white_armor(mats, col, root):
    # 2A. Fluid Cetacean-Streamlined Bow Prow Cap (organic curved whale nose + crisp aerospace bevels!)
    prow_stations = [
        # (y, hw_top, hw_mid, hw_bot, z_top, z_mid, z_bot)
        ( 8.30, 1.16, 1.72, 1.40, -0.14, -0.62, -1.04),
        ( 8.70, 1.08, 1.60, 1.28, -0.28, -0.71, -1.08),
        ( 9.08, 0.98, 1.42, 1.12, -0.44, -0.80, -1.11),
        ( 9.44, 0.86, 1.20, 0.94, -0.60, -0.88, -1.12),
        ( 9.76, 0.72, 0.92, 0.72, -0.80, -0.96, -1.10),
        ( 9.96, 0.56, 0.66, 0.52, -0.95, -1.02, -1.07),
        (10.02, 0.42, 0.48, 0.38, -1.00, -1.03, -1.06),
    ]
    prow_secs = []
    for y, hwt, hwm, hwb, zt, zm, zb in prow_stations:
        prow_secs.append([
            (-hwt * 0.48, y, zt + 0.03),
            ( hwt * 0.48, y, zt + 0.03),
            ( hwt,        y, lerp(zt, zm, 0.34)),
            ( hwm,        y, zm),
            ( hwb,        y, zb),
            ( hwb * 0.48, y, zb - 0.05),
            (-hwb * 0.48, y, zb - 0.05),
            (-hwb,        y, zb),
            (-hwm,        y, zm),
            (-hwt,        y, lerp(zt, zm, 0.34)),
        ])
    add_lofted_sections(
        "Armor_BowChiselProwCap", prow_secs, mats["pearl_white"], col,
        bevel=0.020, smooth=True, sharp_angle_deg=48.0, parent=root,
    )

    # Signature DeepSeek Whale-Blue Curved Forehead Wave Hood cleanly proud above prow cap (ZERO clipping!)
    brow_wave_secs = []
    for k in range(13):
        t = k / 12.0
        y = lerp(8.22, 9.48, t)
        # Match prow cap's exact upper Z curve and sit cleanly +0.06m proud with smooth droplet taper!
        zt_prow = lerp(-0.14, -0.62, t)
        hw = lerp(1.06, 0.34, t ** 1.15)
        zt = zt_prow + lerp(0.11, 0.055, t)
        zb = zt_prow - 0.04
        brow_wave_secs.append([
            (-hw,        y, zb),
            (-hw * 0.78, y, zt - 0.015),
            ( 0.0,       y, zt + 0.042),
            ( hw * 0.78, y, zt - 0.015),
            ( hw,        y, zb),
        ])
    add_lofted_sections(
        "Armor_BowWhaleBlueForeheadWave", brow_wave_secs, mats["deepseek_blue"], col,
        bevel=0.014, smooth=True, sharp_angle_deg=50.0, parent=root,
    )

    # Graceful DeepSeek Whale-Blue Curved Smile / Chin Wave Band wrapping across lower bow prow!
    smile_pts = []
    for k in range(15):
        s = lerp(-1.0, 1.0, k / 14.0)
        as_ = abs(s)
        x = s * 1.48
        y = 9.86 - 1.15 * (as_ ** 1.65)
        z = -1.10 + 0.14 * (as_ ** 1.5)
        smile_pts.append((x, y, z))
    add_swept_strut(
        "Armor_BowWhaleBlueSmileWave", smile_pts, width=0.14, height=0.16,
        mat=mats["deepseek_blue"], col=col, chamfer=0.35, sharp_angle_deg=48.0, parent=root,
    )

    # 2B. UNIFIED Fluid Cetacean-Streamlined Pearl-White Flank Shell (Port & Starboard)
    # Catmull-Rom longitudinal smoothing creates unbroken, silky whale-inspired hydrodynamic curves!
    def smooth_flank_rows(raw_spec, subdiv=2):
        # Catmull-Rom interpolation across 9-tuple stations
        arr = [list(r) for r in raw_spec]
        n = len(arr)
        padded = [arr[0]] + arr + [arr[-1]]
        out = []
        for i in range(1, n):
            p0, p1, p2, p3 = padded[i - 1], padded[i], padded[i + 1], padded[i + 2]
            steps = subdiv if i < n - 1 else subdiv
            for s in range(steps):
                t = s / float(steps)
                t2, t3 = t * t, t * t * t
                row = []
                for c in range(len(p1)):
                    v = 0.5 * (
                        (2.0 * p1[c])
                        + (-p0[c] + p2[c]) * t
                        + (2.0 * p0[c] - 5.0 * p1[c] + 4.0 * p2[c] - p3[c]) * t2
                        + (-p0[c] + 3.0 * p1[c] - 3.0 * p2[c] + p3[c]) * t3
                    )
                    row.append(v)
                out.append(tuple(row))
        out.append(tuple(arr[-1]))
        return out

    for side, tag in ((-1, "Port"), (1, "Stbd")):
        flank_ctrl = [
            # (y, x_in, z_in, x_sh, z_sh, x_flank, z_flank, x_low, z_low)
            ( 9.42, 0.86, -0.56, 1.16, -0.60, 1.36, -0.82, 1.26, -1.04),
            ( 8.55, 1.04, -0.14, 1.54, -0.22, 1.90, -0.58, 1.78, -0.96),
            ( 7.50, 1.32,  0.28, 1.96,  0.14, 2.34, -0.34, 2.18, -0.92),
            ( 6.30, 1.56,  0.80, 2.32,  0.60, 2.74, -0.02, 2.58, -0.84),
            ( 5.00, 1.76,  1.34, 2.62,  1.08, 3.04,  0.34, 2.86, -0.52),
            ( 3.70, 1.84,  1.88, 2.80,  1.52, 3.20,  0.82, 2.98,  0.14),
            ( 2.55, 1.74,  2.42, 2.84,  1.88, 3.24,  1.22, 3.06,  0.64),
            ( 1.55, 1.62,  2.72, 2.90,  2.06, 3.38,  1.22, 3.26,  0.46),
            ( 0.85, 1.62,  2.84, 2.96,  2.14, 3.54,  1.06, 3.80,  0.14),
            ( 0.05, 1.60,  2.82, 2.92,  2.12, 3.46,  1.06, 3.50,  0.20),
            (-0.75, 1.58,  2.78, 2.90,  2.10, 3.40,  1.08, 3.34,  0.24),
            (-1.45, 1.56,  2.74, 2.90,  2.08, 3.44,  1.16, 3.40,  0.44),
            (-2.05, 1.55,  2.72, 2.95,  2.06, 3.52,  1.28, 3.52,  0.72),
            (-2.65, 1.54,  2.70, 2.98,  2.04, 3.58,  1.34, 3.58,  0.80),
            (-3.25, 1.52,  2.66, 2.95,  2.00, 3.52,  1.26, 3.50,  0.68),
            (-3.95, 1.48,  2.58, 2.86,  1.92, 3.38,  1.02, 3.26,  0.18),
            (-4.75, 1.40,  2.44, 2.72,  1.78, 3.12,  0.68, 2.92, -0.58),
            (-5.95, 1.28,  2.22, 2.50,  1.58, 2.82,  0.54, 2.60, -0.68),
            (-7.20, 1.16,  1.92, 2.26,  1.34, 2.52,  0.44, 2.34, -0.56),
            (-8.40, 1.04,  1.56, 1.94,  1.08, 2.16,  0.32, 2.00, -0.32),
        ]
        flank_spec = smooth_flank_rows(flank_ctrl, subdiv=2)
        go, gi = [], []
        th = 0.16
        for (y, xi, zi, xsh, zsh, xf, zf, xl, zl) in flank_spec:
            go.append([(side * xi, y, zi), (side * xsh, y, zsh), (side * xf, y, zf), (side * xl, y, zl)])
            gi.append([
                (side * (xi - th * 0.65), y, zi - th * 0.72),
                (side * (xsh - th * 0.90), y, zsh - th * 0.60),
                (side * (xf - th * 1.00), y, zf - th * 0.15),
                (side * (xl - th * 0.92), y, zl + th * 0.12),
            ])
        add_thick_surface_grid(
            f"Armor_UnifiedWhiteFlank_{tag}", go, gi, mats["pearl_white"], col,
            smooth=True, sharp_angle_deg=44.0, parent=root,
        )

        # Exact conformal evaluator on the flank_spec mesh surface (monotonically decreasing Y)
        def eval_flank_surface(y_q, u_q, off):
            if y_q >= flank_spec[0][0]:
                row = flank_spec[0]
            elif y_q <= flank_spec[-1][0]:
                row = flank_spec[-1]
            else:
                row = flank_spec[-1]
                for ri in range(len(flank_spec) - 1):
                    y0 = flank_spec[ri][0]
                    y1 = flank_spec[ri + 1][0]
                    if y0 >= y_q >= y1:
                        tf = (y0 - y_q) / max(y0 - y1, 1e-6)
                        row = tuple(lerp(a, b, tf) for a, b in zip(flank_spec[ri], flank_spec[ri + 1]))
                        break
            _, xi, zi, xsh, zsh, xf, zf, xl, zl = row
            pts = [(xi, zi), (xsh, zsh), (xf, zf), (xl, zl)]
            # Smooth vertex-averaged outward normals across the 4 cross-section control points
            seg_n = []
            for si in range(3):
                dx = pts[si + 1][0] - pts[si][0]
                dz = pts[si + 1][1] - pts[si][1]
                nx_s, nz_s = -dz, dx
                ln = math.hypot(nx_s, nz_s) + 1e-6
                seg_n.append((nx_s / ln, nz_s / ln))
            vert_n = [
                seg_n[0],
                ((seg_n[0][0] + seg_n[1][0]) * 0.5, (seg_n[0][1] + seg_n[1][1]) * 0.5),
                ((seg_n[1][0] + seg_n[2][0]) * 0.5, (seg_n[1][1] + seg_n[2][1]) * 0.5),
                seg_n[2],
            ]
            vert_n = [(nx / (math.hypot(nx, nz) + 1e-6), nz / (math.hypot(nx, nz) + 1e-6)) for nx, nz in vert_n]

            u_c = max(0.0, min(1.0, u_q))
            s_u = u_c * 3.0
            i0 = min(2, max(0, int(s_u)))
            f = s_u - i0
            px = lerp(pts[i0][0], pts[i0 + 1][0], f)
            pz = lerp(pts[i0][1], pts[i0 + 1][1], f)
            nx = lerp(vert_n[i0][0], vert_n[i0 + 1][0], f)
            nz = lerp(vert_n[i0][1], vert_n[i0 + 1][1], f)
            ln = math.hypot(nx, nz) + 1e-6
            nx /= ln
            nz /= ln
            return (side * (px + nx * off), y_q, pz + nz * off)

        def add_conformal_flank_ribbon(name, samples, mat, n_across=5, out_base=0.036, out_crown=0.016, in_off=-0.025, sharp_deg=50.0):
            """Build a zero-clipping sculpted conformal ribbon from [(y, u_lo, u_hi), ...]."""
            go_r, gi_r = [], []
            for y_s, u_lo, u_hi in samples:
                row_o, row_i = [], []
                for k in range(n_across):
                    fk = k / float(n_across - 1)
                    uv = lerp(u_lo, u_hi, fk)
                    bell = math.sin(fk * math.pi)
                    row_o.append(eval_flank_surface(y_s, uv, out_base + out_crown * bell))
                    row_i.append(eval_flank_surface(y_s, uv, in_off))
                go_r.append(row_o)
                gi_r.append(row_i)
            return add_thick_surface_grid(
                name, go_r, gi_r, mat, col, smooth=True, sharp_angle_deg=sharp_deg, parent=root,
            )

        # Signature DeepSeek Whale-Blue Flowing Cheek & Shoulder Streamline Ribbon (7-pt conformal, ZERO clipping!)
        wave_samples = []
        waterline_samples = []
        for (y, xi, zi, xsh, zsh, xf, zf, xl, zl) in flank_spec:
            if y > 8.75 or y < -8.20:
                continue
            if y >= 2.5:
                t_f = (y - 2.5) / 6.25
                u0 = lerp(0.10, 0.03, t_f)
                u1 = lerp(0.40, 0.25, t_f)
            else:
                t_a = (2.5 - y) / 10.70
                wave_shift = 0.20 * math.sin(t_a * math.pi)
                u0 = 0.10 + wave_shift
                u1 = u0 + lerp(0.28, 0.18, t_a)
            wave_samples.append((y, u0, u1))
            if -8.10 <= y <= 8.50:
                t_wl = (y - (-8.10)) / 16.60
                taper = math.sin(max(0.0, min(1.0, t_wl)) * math.pi) ** 0.45
                du_wl = 0.024 * max(0.20, taper)
                waterline_samples.append((y, u1 + 0.018, u1 + 0.018 + du_wl))

        add_conformal_flank_ribbon(
            f"Armor_DeepSeekBlueWhaleWave_{tag}", wave_samples, mats["deepseek_blue"],
            n_across=7, out_base=0.042, out_crown=0.018, in_off=-0.025, sharp_deg=50.0,
        )
        # Luminous Electric-Cyan Whale Waterline Pinstripe tracing the lower contour of the upper whale wave!
        add_conformal_flank_ribbon(
            f"Flank_WhaleCyanWaterline_{tag}", waterline_samples, mats["cyan_core"],
            n_across=3, out_base=0.046, out_crown=0.010, in_off=-0.015, sharp_deg=52.0,
        )

        # V6 Feature B: Forward Cheek Sweeping Whale Gill-Wave / Pectoral Streamline Blades (3 progressive arcs!)
        gill_specs = [
            # (y_fwd, y_aft, u_fwd, u_aft, u_arch, du_max, add_cyan)
            (7.70, 4.45, 0.50, 0.56, -0.055, 0.068, True),
            (6.95, 4.05, 0.67, 0.71, -0.048, 0.060, False),
            (6.10, 3.70, 0.83, 0.85, -0.040, 0.048, False),
        ]
        for g_idx, (yf, ya, uf, ua, u_arch, du_max, add_cyan) in enumerate(gill_specs):
            n_gs = 16
            g_samp = []
            c_samp = []
            for k in range(n_gs + 1):
                t = k / float(n_gs)
                yk = lerp(yf, ya, t)
                uc = lerp(uf, ua, t) + u_arch * math.sin(t * math.pi)
                hw_u = 0.5 * du_max * max(0.08, math.sin(t * math.pi) ** 0.65)
                g_samp.append((yk, uc - hw_u, uc + hw_u))
                if add_cyan and 0.12 <= t <= 0.86:
                    tc = (t - 0.12) / 0.74
                    cw = 0.018 * max(0.18, math.sin(tc * math.pi) ** 0.55)
                    c_samp.append((yk, uc - hw_u - 0.010 - cw, uc - hw_u - 0.010))
            add_conformal_flank_ribbon(
                f"Flank_CheekGillWave_{tag}_{g_idx}", g_samp, mats["deepseek_blue"],
                n_across=5, out_base=0.036, out_crown=0.016, in_off=-0.024, sharp_deg=50.0,
            )
            if c_samp:
                add_conformal_flank_ribbon(
                    f"Flank_CheekGillCyanAccent_{tag}", c_samp, mats["cyan_core"],
                    n_across=3, out_base=0.042, out_crown=0.008, in_off=-0.014, sharp_deg=52.0,
                )

        # V6 Feature C: Aft Quarter Sweeping Whale-Tail Transition Swoosh (links circular turbine arch -> V-tail!)
        swoosh_main = []
        swoosh_cyan = []
        swoosh_echo = []
        n_sw = 24
        for k in range(n_sw + 1):
            t = k / float(n_sw)
            yk = lerp(-4.22, -8.18, t)
            # Graceful S-curve sweeping low past the whale crest pocket then surging UP into V-tail root!
            s_rise = t * t * (3.0 - 2.0 * t)
            uc = lerp(0.92, 0.48, s_rise ** 1.18)
            hw_u = 0.5 * 0.115 * max(0.12, math.sin(t * math.pi) ** 0.58)
            swoosh_main.append((yk, min(0.99, uc - hw_u), min(0.995, uc + hw_u)))
            if 0.05 <= t <= 0.96:
                tc = (t - 0.05) / 0.91
                cw = 0.022 * max(0.20, math.sin(tc * math.pi) ** 0.50)
                swoosh_cyan.append((yk, max(0.42, uc - hw_u - 0.016 - cw), max(0.44, uc - hw_u - 0.016)))
            if 0.18 <= t <= 0.94:
                te = (t - 0.18) / 0.76
                ew = 0.042 * max(0.14, math.sin(te * math.pi) ** 0.65)
                ue = min(0.97, uc + hw_u + 0.036 + 0.5 * ew)
                swoosh_echo.append((yk, max(0.50, ue - 0.5 * ew), min(0.995, ue + 0.5 * ew)))

        add_conformal_flank_ribbon(
            f"Flank_AftWhaleSwoosh_{tag}", swoosh_main, mats["deepseek_blue"],
            n_across=7, out_base=0.042, out_crown=0.018, in_off=-0.026, sharp_deg=50.0,
        )
        add_conformal_flank_ribbon(
            f"Flank_AftWhaleCyanNeedle_{tag}", swoosh_cyan, mats["cyan_core"],
            n_across=3, out_base=0.046, out_crown=0.010, in_off=-0.015, sharp_deg=52.0,
        )
        add_conformal_flank_ribbon(
            f"Flank_AftWhaleEchoRibbon_{tag}", swoosh_echo, mats["cobalt_trim"],
            n_across=5, out_base=0.036, out_crown=0.014, in_off=-0.022, sharp_deg=50.0,
        )

        # V7 Feature D: Sleek Upper-Aft Tapered Whale-Fin Speed Streak (pure hydrodynamic harmony, zero overlap!)
        upper_aft_blade = []
        n_ua = 18
        for k in range(n_ua + 1):
            t = k / float(n_ua)
            yk = lerp(-4.45, -7.55, t)
            uc = lerp(0.69, 0.50, t ** 0.90) - 0.032 * math.sin(t * math.pi)
            hw_u = 0.5 * 0.056 * max(0.10, math.sin(t * math.pi) ** 0.65)
            upper_aft_blade.append((yk, max(0.46, uc - hw_u), min(0.84, uc + hw_u)))
        add_conformal_flank_ribbon(
            f"Flank_AftUpperWhaleBlade_{tag}", upper_aft_blade, mats["deepseek_blue"],
            n_across=5, out_base=0.038, out_crown=0.014, in_off=-0.022, sharp_deg=50.0,
        )

        # Sleek DeepSeek-Blue pectoral underside fairing (blends chine cleanly into blue waist!)
        pec_under = [
            ( 1.55, 3.24,  0.44, 3.04, -0.08),
            ( 0.85, 3.78,  0.12, 3.16, -0.22),
            ( 0.05, 3.46,  0.18, 3.12, -0.18),
            (-0.65, 3.30,  0.22, 3.08, -0.14),
        ]
        pu_o, pu_i = [], []
        for (y, xo, zo, xi, zi) in pec_under:
            pu_o.append([(side * xo, y, zo), (side * lerp(xo, xi, 0.5), y, lerp(zo, zi, 0.65)), (side * xi, y, zi)])
            pu_i.append([(side * (xo - 0.14), y, zo + 0.14), (side * lerp(xo, xi, 0.5), y, lerp(zo, zi, 0.65) + 0.14), (side * (xi - 0.10), y, zi + 0.14)])
        add_thick_surface_grid(
            f"Armor_PectoralUnderFairing_{tag}", pu_o, pu_i, mats["deepseek_blue"], col,
            smooth=True, sharp_angle_deg=40.0, parent=root,
        )

        # 2C. Sculpted Circular Pearl-White Wheel-Arch Hood Hugging Upper 210° of Turbine Pod
        arch_secs = []
        n_arch = 24
        for k in range(n_arch + 1):
            ang = math.radians(-18.0 + 216.0 * k / float(n_arch))
            ca, sa = math.cos(ang), math.sin(ang)
            y_in = -2.65 + 1.22 * ca
            z_in = -0.58 + 1.22 * sa
            y_out = -2.65 + 1.46 * ca
            z_out = -0.58 + 1.46 * sa
            bulge = 3.52 + 0.10 * max(0.0, sa)
            arch_secs.append([
                (side * 2.98, y_out, z_out),
                (side * bulge, y_out, z_out),
                (side * (bulge + 0.06), lerp(y_in, y_out, 0.35), lerp(z_in, z_out, 0.35)),
                (side * (bulge + 0.03), y_in, z_in),
                (side * 2.98, y_in, z_in),
            ])
        add_lofted_sections(
            f"Armor_TurbineWheelArch_{tag}", arch_secs, mats["pearl_white"], col,
            bevel=0.018, smooth=True, sharp_angle_deg=32.0, parent=root,
        )

        # 2D. Forward Lower White Jaw/Cheek Plate (leaves a crisp 0.22m dark-blue slit channel under bow nose!)
        jaw_spec = [
            (9.10, 1.32, -1.24, 1.24, -1.46, 1.02, -1.68),
            (7.85, 1.82, -1.24, 1.74, -1.52, 1.44, -1.90),
            (6.45, 2.22, -1.16, 2.14, -1.48, 1.78, -1.98),
            (5.10, 2.48, -0.96, 2.38, -1.34, 2.00, -1.86),
            (3.95, 2.58, -0.78, 2.42, -1.14, 2.06, -1.60),
        ]
        jo, ji = [], []
        for (y, xt, zt, xm, zm, xb, zb) in jaw_spec:
            jo.append([(side * xt, y, zt), (side * xm, y, zm), (side * xb, y, zb)])
            ji.append([(side * (xt - 0.15), y, zt + 0.04), (side * (xm - 0.15), y, zm + 0.04), (side * (xb - 0.14), y, zb + 0.08)])
        add_thick_surface_grid(
            f"Armor_FwdJawPlate_{tag}", jo, ji, mats["pearl_white"], col,
            smooth=True, sharp_angle_deg=30.0, parent=root,
        )

        # 2E. Lower Aft Swept White Belly Strake (behind turbine pod -> stern)
        aft_low_spec = [
            (-4.20, 2.96, -0.78, 2.72, -1.26, 2.24, -1.56),
            (-5.45, 2.68, -0.78, 2.46, -1.18, 2.00, -1.42),
            (-6.80, 2.36, -0.66, 2.14, -1.02, 1.74, -1.20),
            (-8.05, 2.02, -0.42, 1.84, -0.76, 1.50, -0.94),
        ]
        ao, ai = [], []
        for (y, xt, zt, xm, zm, xb, zb) in aft_low_spec:
            ao.append([(side * xt, y, zt), (side * xm, y, zm), (side * xb, y, zb)])
            ai.append([(side * (xt - 0.14), y, zt + 0.04), (side * (xm - 0.14), y, zm + 0.04), (side * (xb - 0.12), y, zb + 0.08)])
        add_thick_surface_grid(
            f"Armor_LowerAftStrake_{tag}", ao, ai, mats["pearl_white"], col,
            smooth=True, sharp_angle_deg=30.0, parent=root,
        )

        # 2F. Sleek Tapered Lower Mid-Waist Hydrodynamic Fairing (gracefully tapered BOTH front & rear!)
        mid_low_spec = [
            (-1.45, 2.86, -1.52, 2.64, -1.72, 2.18, -1.84),
            (-0.75, 3.04, -1.40, 2.74, -1.70, 2.22, -1.88),
            ( 0.35, 3.02, -1.44, 2.72, -1.80, 2.18, -2.00),
            ( 1.50, 2.82, -1.50, 2.54, -1.88, 2.06, -2.08),
            ( 2.35, 2.48, -1.62, 2.28, -1.94, 1.88, -2.12),
        ]
        mlo, mli = [], []
        for (y, xt, zt, xm, zm, xb, zb) in mid_low_spec:
            mlo.append([(side * xt, y, zt), (side * xm, y, zm), (side * xb, y, zb)])
            mli.append([(side * (xt - 0.14), y, zt + 0.04), (side * (xm - 0.14), y, zm + 0.06), (side * (xb - 0.12), y, zb + 0.08)])
        add_thick_surface_grid(
            f"Armor_MidWaistLowerFairing_{tag}", mlo, mli, mats["pearl_white"], col,
            smooth=True, sharp_angle_deg=32.0, parent=root,
        )


# ---------------------------------------------------------------------------
# 7. Collection 03: Sleek Whale-Streamline Panoramic Canopy & Cockpit Interior
# ---------------------------------------------------------------------------

def build_geodesic_canopy_and_cockpit(mats, col, root):
    # 3A. Glossy DeepSeek Whale-Blue Streamlined Canopy Coaming Rim (frames the entire panoramic glass smoothly!)
    rim_pts = []
    for k in range(14):
        rim_pts.append(canopy_surface_pt(0.0, lerp(-1.0, 1.0, k / 14.0), 0.015))
    for k in range(22):
        rim_pts.append(canopy_surface_pt(k / 22.0, 1.0, 0.015))
    for k in range(16):
        rim_pts.append(canopy_surface_pt(1.0, lerp(1.0, -1.0, k / 16.0), 0.015))
    for k in range(22):
        rim_pts.append(canopy_surface_pt(1.0 - k / 22.0, -1.0, 0.015))
    pts_vec = [Vector(p) for p in rim_pts]
    n_p = len(pts_vec)
    coam_prof = [(0.14, 0.068), (-0.14, 0.068), (-0.17, -0.10), (0.17, -0.10)]
    coam_secs = []
    for i, p in enumerate(pts_vec):
        t = (pts_vec[(i + 1) % n_p] - pts_vec[(i - 1) % n_p]).normalized()
        up = Vector((0.0, 0.0, 1.0))
        if abs(t.dot(up)) > 0.92:
            up = Vector((0.0, 1.0, 0.0))
        u_ax = t.cross(up).normalized()
        v_ax = u_ax.cross(t).normalized()
        coam_secs.append([tuple(p + u_ax * u + v_ax * v) for u, v in coam_prof])
    add_lofted_sections(
        "Canopy_DeepSeekBlue_CoamingRim", coam_secs, mats["deepseek_blue"], col,
        closed_loop=True, smooth=True, sharp_angle_deg=48.0, parent=root,
    )

    # 3B. Uninterrupted Crystal-Clear DeepSeek Sapphire-Blue Panoramic Whale-Brow Glass Dome (36x36, zero moire!)
    nu, nv = 36, 36
    glass_o = []
    glass_i = []
    for i in range(nu + 1):
        u = i / float(nu)
        ro, ri = [], []
        for j in range(nv + 1):
            v = lerp(-1.0, 1.0, j / float(nv))
            ro.append(canopy_surface_pt(u, v, 0.0))
            ri.append(canopy_surface_pt(u, v, -0.042))
        glass_o.append(ro)
        glass_i.append(ri)
    add_thick_surface_grid(
        "Canopy_SapphireWhaleGlass", glass_o, glass_i, mats["canopy_glass"], col,
        smooth=True, sharp_angle_deg=72.0, parent=root,
    )

    # 3C. Ultra-Clean Hydrodynamic Whale-Streamline Canopy Framing (ZERO spiderweb clutter!)
    # Only 2 graceful sweeping sapphire-metallic A-pillar flow ribs + 1 slim rear roof arch
    # + 1 luminous DeepSeek-cyan curved whale-brow accent line hugging the lower glass edge!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # Sweeping organic whale-streamline rib curving gracefully from lower nose sill up into dorsal crown!
        rib_pts = []
        for k in range(25):
            u = k / 24.0
            # Teardrop streamline lateral curve: gracefully widens mid-canopy then converges cleanly into rear spine!
            v_curve = side * (0.44 + 0.18 * math.sin(u * math.pi * 0.92))
            rib_pts.append(canopy_surface_pt(u, v_curve, 0.014))
        add_swept_strut(
            f"Canopy_WhaleStreamlineRib_{tag}", rib_pts, width=0.068, height=0.032,
            mat=mats["canopy_rib"], col=col, chamfer=0.38, sharp_angle_deg=50.0, parent=root,
        )
        # Subtle recessed luminous cyan streamline highlight tracing the outer sill edge (front half)
        sill_glow = [canopy_surface_pt(lerp(0.03, 0.74, k / 18.0), side * 0.95, 0.014) for k in range(19)]
        add_swept_strut(
            f"Canopy_SideCyanFlowLine_{tag}", sill_glow, width=0.028, height=0.020,
            mat=mats["cyan_glow"], col=col, chamfer=0.40, sharp_angle_deg=50.0, parent=root,
        )

    # Single graceful curved rear-cabin panoramic halo arch (frames rear skylight cleanly without blocking front view!)
    arch_pts = [canopy_surface_pt(0.76 - 0.05 * (v * v), v, 0.014) for v in [lerp(-0.98, 0.98, k / 24.0) for k in range(25)]]
    add_swept_strut(
        "Canopy_RearHaloArch", arch_pts, width=0.072, height=0.032,
        mat=mats["canopy_rib"], col=col, chamfer=0.38, sharp_angle_deg=50.0, parent=root,
    )

    # Sleek curved DeepSeek-cyan luminous whale-brow smile arc clearly visible across lower windshield!
    brow_glow_pts = [canopy_surface_pt(0.086 + 0.036 * (v * v), v, 0.024) for v in [lerp(-0.88, 0.88, k / 24.0) for k in range(25)]]
    add_swept_strut(
        "Canopy_FrontBrowCyanArc", brow_glow_pts, width=0.042, height=0.026,
        mat=mats["cyan_core"], col=col, chamfer=0.40, sharp_angle_deg=50.0, parent=root,
    )

    # 3D. Multi-Tiered Cockpit Interior (clearly visible & super sleek through uninterrupted sapphire whale glass!)
    add_beveled_box("Cockpit_CabinFloor", (0.0, 5.45, -0.36), (2.68, 4.90, 0.22), mats["dark_machinery"], col, bevel=0.03, parent=root)
    add_beveled_box("Cockpit_RearBulkhead", (0.0, 2.95, 0.98), (2.78, 0.26, 2.45), mats["dark_titanium"], col, bevel=0.03, parent=root)
    dash_secs = [
        [(-1.24, 6.75, -0.18), (1.24, 6.75, -0.18), (1.12, 6.75, 0.36), (-1.12, 6.75, 0.36)],
        [(-0.98, 7.65, -0.28), (0.98, 7.65, -0.28), (0.84, 7.65, 0.16), (-0.84, 7.65, 0.16)],
        [(-0.74, 8.20, -0.38), (0.74, 8.20, -0.38), (0.58, 8.20, -0.12), (-0.58, 8.20, -0.12)],
    ]
    add_lofted_sections("Cockpit_ConsoleGlareShield", dash_secs, mats["dark_titanium"], col, bevel=0.02, parent=root)
    # Graceful curved holographic whale-arc cockpit HUD console
    hud_arc_pts = [(lerp(-1.02, 1.02, k / 16.0), 6.82 + 0.28 * math.cos(lerp(-1.0, 1.0, k / 16.0) * math.pi * 0.5), 0.28) for k in range(17)]
    add_swept_strut("Cockpit_CurvedHoloHUD", hud_arc_pts, width=0.05, height=0.15, mat=mats["cockpit_hud"], col=col, parent=root)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        add_beveled_box(
            f"Cockpit_SeatBase_{tag}", (side * 0.60, 5.55, 0.04), (0.56, 0.60, 0.26),
            mats["deepseek_blue"], col, bevel=0.04, parent=root,
        )
        add_beveled_box(
            f"Cockpit_SeatBack_{tag}", (side * 0.60, 5.22, 0.56), (0.52, 0.18, 0.88),
            mats["deepseek_blue"], col, bevel=0.04, rot=(-0.22, 0.0, 0.0), parent=root,
        )
        add_beveled_box(
            f"Cockpit_SeatHeadrest_{tag}", (side * 0.60, 5.10, 1.08), (0.34, 0.14, 0.24),
            mats["ice_silver"], col, bevel=0.03, rot=(-0.15, 0.0, 0.0), parent=root,
        )
    add_beveled_box("Cockpit_AftPlatform", (0.0, 4.05, 0.18), (2.14, 1.80, 0.32), mats["dark_titanium"], col, bevel=0.03, parent=root)
    add_beveled_box("Cockpit_AftSeatBack", (0.0, 3.68, 0.96), (0.60, 0.18, 0.92), mats["deepseek_blue"], col, bevel=0.04, rot=(-0.18, 0.0, 0.0), parent=root)
    add_beveled_box("Cockpit_AftHoloBar", (0.0, 4.52, 0.66), (1.06, 0.10, 0.15), mats["cockpit_hud"], col, bevel=0.01, rot=(-0.35, 0.0, 0.0), parent=root)


# ---------------------------------------------------------------------------
# 8. Collection 04: V7 Sculpted Hydrodynamic Whale-Spine Dorsal Carapace
# ---------------------------------------------------------------------------

def build_dorsal_spine_systems(mats, col, root):
    """Build a fluid, luxury cetacean-streamlined dorsal carapace (zero boxy blocks or barcode bars!)."""
    # Smooth parametric evaluator for the crowned dorsal whale-back surface between Port/Stbd white flanks
    def eval_dorsal_pt(y_q, s_q, off=0.0):
        # s_q in [-1.0, +1.0] spans [-sp_hw, +sp_hw] smoothly with a gentle convex cetacean dome
        _, z_top, _, _, _, sp_hw, _ = eval_hull_station(y_q)
        x = s_q * (sp_hw * 1.03)
        z = (z_top + 0.065) - 0.145 * (s_q * s_q) + off
        return (x, y_q, z)

    def mantle_half_s(y_q):
        """Sensual organic whale-back S-curve half-width for the DeepSeek-blue dorsal mantle."""
        # Flows seamlessly from curved canopy crown (Y=+2.55) -> sleek mid-spine -> narrows -> embraces V-tail!
        t = max(0.0, min(1.0, (2.55 - y_q) / 11.15))
        base = lerp(0.92, 0.56, t ** 0.72)
        swell = 0.10 * math.sin(t * math.pi * 1.15) - 0.06 * math.sin(t * math.pi * 2.10)
        return max(0.38, min(0.95, base + swell))

    def atrium_half_s(y_q):
        """Elongated teardrop half-width for the glossy dark-sapphire center spine atrium (Y=+2.20..-3.55)."""
        if y_q > 2.25 or y_q < -3.60:
            return 0.0
        t = (2.25 - y_q) / 5.85
        return 0.46 * (math.sin(t * math.pi) ** 0.62) * lerp(1.08, 0.72, t)

    # 4A. Continuous Smoothly Crowned Pearl-White Dorsal Base Carapace (tucks seamlessly under canopy rim!)
    n_y_base = 28
    n_s_base = 14
    car_o, car_i = [], []
    for iy in range(n_y_base + 1):
        t_y = iy / float(n_y_base)
        ro, ri = [], []
        for is_ in range(n_s_base + 1):
            sk = lerp(-1.02, 1.02, is_ / float(n_s_base))
            y_front_c = 2.74 - 0.14 * (sk * sk)
            yk = lerp(y_front_c, -8.62, t_y)
            ro.append(eval_dorsal_pt(yk, sk, 0.0))
            ri.append(eval_dorsal_pt(yk, sk, -0.14))
        car_o.append(ro)
        car_i.append(ri)
    add_thick_surface_grid(
        "Dorsal_PearlWhite_BaseCarapace", car_o, car_i, mats["pearl_white"], col,
        smooth=True, sharp_angle_deg=48.0, parent=root,
    )

    # 4B. Sculpted Tapered Teardrop DeepSeek Whale-Blue Dorsal Mantle (curves seamlessly into canopy coaming!)
    n_y_m = 32
    n_s_m = 14
    man_o, man_i = [], []
    for iy in range(n_y_m + 1):
        t_y = iy / float(n_y_m)
        ro, ri = [], []
        for is_ in range(n_s_m + 1):
            fk = is_ / float(n_s_m)
            s_unit = lerp(-1.0, 1.0, fk)
            y_front_m = 2.72 - 0.14 * (s_unit * s_unit)
            yk = lerp(y_front_m, -8.56, t_y)
            hs = mantle_half_s(yk)
            sk = s_unit * hs
            bell = math.sin(fk * math.pi) ** 0.55
            ro.append(eval_dorsal_pt(yk, sk, 0.022 + 0.024 * bell))
            ri.append(eval_dorsal_pt(yk, sk, -0.04))
        man_o.append(ro)
        man_i.append(ri)
    add_thick_surface_grid(
        "Dorsal_DeepSeekBlue_WhaleMantle", man_o, man_i, mats["deepseek_blue"], col,
        smooth=True, sharp_angle_deg=50.0, parent=root,
    )

    # Razor-slim Luminous Electric-Cyan Dorsal Spine Contour Traces hugging BOTH sides of the blue mantle!
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        tr_o, tr_i = [], []
        for iy in range(30):
            t = iy / 29.0
            yk = lerp(2.56, -8.38, t)
            hs = mantle_half_s(yk) + 0.022
            w_s = 0.032 * max(0.22, math.sin(t * math.pi) ** 0.45)
            ro, ri = [], []
            for k in range(3):
                fk = k / 2.0
                sk = side * (hs + fk * w_s)
                bell = math.sin(fk * math.pi)
                ro.append(eval_dorsal_pt(yk, sk, 0.028 + 0.010 * bell))
                ri.append(eval_dorsal_pt(yk, sk, -0.02))
            tr_o.append(ro)
            tr_i.append(ri)
        add_thick_surface_grid(
            f"Dorsal_SpineCyanTrace_{tag}", tr_o, tr_i, mats["cyan_core"], col,
            smooth=True, sharp_angle_deg=52.0, parent=root,
        )

    # 4C. Glossy Dark-Sapphire Panoramic Dorsal Spine Atrium (flows organically right out of canopy!)
    n_y_a = 24
    n_s_a = 10
    atr_o, atr_i = [], []
    rim_o, rim_i = [], []
    for iy in range(n_y_a + 1):
        t = iy / float(n_y_a)
        yk = lerp(2.22, -3.55, t)
        hs = max(0.035, atrium_half_s(yk))
        ro, ri = [], []
        r_ro, r_ri = [], []
        for is_ in range(n_s_a + 1):
            fk = is_ / float(n_s_a)
            sk = lerp(-hs, hs, fk)
            bell = math.sin(fk * math.pi)
            # Sleek glossy dark-sapphire spine core recessed slightly beneath sculpted metallic surround
            ro.append(eval_dorsal_pt(yk, sk, 0.052 + 0.018 * bell))
            ri.append(eval_dorsal_pt(yk, sk, 0.005))
            sk_r = lerp(-(hs + 0.075), hs + 0.075, fk)
            r_ro.append(eval_dorsal_pt(yk, sk_r, 0.044 + 0.012 * bell))
            r_ri.append(eval_dorsal_pt(yk, sk_r, -0.01))
        atr_o.append(ro)
        atr_i.append(ri)
        rim_o.append(r_ro)
        rim_i.append(r_ri)
    add_thick_surface_grid(
        "Dorsal_AtriumMetallicFrame", rim_o, rim_i, mats["canopy_rib"], col,
        smooth=True, sharp_angle_deg=48.0, parent=root,
    )
    add_thick_surface_grid(
        "Dorsal_SapphireSpineAtrium", atr_o, atr_i, mats["canopy_glass"], col,
        smooth=True, sharp_angle_deg=60.0, parent=root,
    )

    # 5 Swept-Back V-Chevron Brushed Ice-Silver Hydrodynamic Spine Ribs across the Sapphire Atrium!
    for idx_r, y_apex in enumerate((1.55, 0.55, -0.45, -1.45, -2.42)):
        hs_rib = max(0.14, atrium_half_s(y_apex) + 0.05)
        rib_pts = []
        for k in range(13):
            fk = lerp(-1.0, 1.0, k / 12.0)
            sk = fk * hs_rib
            # Sleek forward-pointing hydrodynamic V-chevron curve sweeping smoothly aft toward edges!
            yk = y_apex - 0.36 * (abs(fk) ** 1.35)
            rib_pts.append(eval_dorsal_pt(yk, sk, 0.072 - 0.010 * (fk * fk)))
        add_swept_strut(
            f"Dorsal_SweptChevronRib_{idx_r}", rib_pts, width=0.072, height=0.028,
            mat=mats["ice_silver"], col=col, chamfer=0.38, sharp_angle_deg=48.0, parent=root,
        )

    # 3 Progressive Bioluminescent Electric-Cyan Centerline Spine Energy Veins inside the Sapphire Atrium!
    for idx_v, (y0, y1, w_v) in enumerate(((1.22, 0.72, 0.068), (0.22, -0.32, 0.058), (-0.82, -1.32, 0.048), (-1.82, -2.28, 0.040))):
        v_pts = [eval_dorsal_pt(lerp(y0, y1, k / 6.0), 0.0, 0.076) for k in range(7)]
        add_swept_strut(
            f"Dorsal_CyanEnergyVein_{idx_v}", v_pts, width=w_v, height=0.022,
            mat=mats["cyan_core"], col=col, chamfer=0.40, sharp_angle_deg=50.0, parent=root,
        )

    # 4D. Ultra-Low-Profile Flush Swept Teardrop Shoulder Vent Pods (replaces clunky octagonal Lego blocks!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        pod_secs = []
        # Tapered teardrop contour hugging the whale shoulder seamlessly right aft of canopy!
        for k in range(11):
            t = k / 10.0
            yk = lerp(2.26, 0.96, t)
            # Rounded front lip -> sleek swept pointed aft tail!
            w_s = max(0.014, 0.16 * (math.sin(t * math.pi) ** 0.58) * lerp(1.15, 0.45, t))
            h_p = 0.048 * (math.sin(t * math.pi) ** 0.65)
            sc = side * lerp(0.66, 0.72, t)
            pod_secs.append([
                eval_dorsal_pt(yk, sc - w_s, -0.01),
                eval_dorsal_pt(yk, sc - w_s * 0.62, 0.028 + h_p),
                eval_dorsal_pt(yk, sc + w_s * 0.62, 0.028 + h_p),
                eval_dorsal_pt(yk, sc + w_s, -0.01),
            ])
        add_lofted_sections(
            f"Dorsal_TeardropVentPod_{tag}", pod_secs, mats["dark_titanium"], col,
            bevel=0.010, smooth=True, sharp_angle_deg=48.0, parent=root,
        )
        # Subtle glowing cyan slit nested flush inside the teardrop scoop nose!
        slit_pts = [eval_dorsal_pt(lerp(2.12, 1.56, k / 6.0), side * lerp(0.66, 0.69, k / 6.0), 0.078) for k in range(7)]
        add_swept_strut(
            f"Dorsal_TeardropVentGlow_{tag}", slit_pts, width=0.036, height=0.018,
            mat=mats["cyan_glow"], col=col, chamfer=0.38, sharp_angle_deg=50.0, parent=root,
        )

    # 4E. Sleek Sculpted Knife-Edge Whale Dorsal Fin-Ridge Fairing (Y = -3.05 .. -6.45, replaces boxy soap-bar!)
    fin_secs = []
    for k in range(15):
        t = k / 14.0
        yk = lerp(-3.05, -6.45, t)
        # Smooth teardrop whale-dorsal crest: sleek intake hood -> gently arched fin crest -> razor spine taper!
        hs_f = max(0.022, 0.34 * ((1.0 - t) ** 0.78) * (0.45 + 0.55 * math.sin(min(1.0, t * 2.2) * math.pi * 0.5)))
        h_crest = 0.21 * (math.sin(t * math.pi) ** 0.70) * lerp(1.15, 0.45, t)
        fin_secs.append([
            eval_dorsal_pt(yk, -hs_f, 0.01),
            eval_dorsal_pt(yk, -hs_f * 0.55, 0.055 + h_crest * 0.82),
            eval_dorsal_pt(yk,  0.0,         0.068 + h_crest),
            eval_dorsal_pt(yk,  hs_f * 0.55, 0.055 + h_crest * 0.82),
            eval_dorsal_pt(yk,  hs_f,        0.01),
        ])
    add_lofted_sections(
        "Dorsal_WhaleFinRidgeFairing", fin_secs, mats["deepseek_blue"], col,
        bevel=0.014, smooth=True, sharp_angle_deg=50.0, parent=root,
    )
    # Brushed ice-silver aerodynamic spine blade crowning the dorsal ridge fairing!
    crest_pts = [
        eval_dorsal_pt(
            lerp(-3.25, -6.20, k / 12.0),
            0.0,
            0.072 + 0.21 * (math.sin((k / 12.0 * 0.86 + 0.06) * math.pi) ** 0.70) * lerp(1.10, 0.50, k / 12.0),
        )
        for k in range(13)
    ]
    add_swept_strut(
        "Dorsal_WhaleFinSilverCrest", crest_pts, width=0.075, height=0.036,
        mat=mats["ice_silver"], col=col, chamfer=0.40, sharp_angle_deg=50.0, parent=root,
    )
    # Recessed dark intake throat + slim glowing electric-cyan intake lip at nose of dorsal ridge fairing!
    mouth_pts = [eval_dorsal_pt(-3.12, lerp(-0.22, 0.22, k / 8.0), 0.105 - 0.018 * (lerp(-1.0, 1.0, k / 8.0) ** 2)) for k in range(9)]
    add_swept_strut(
        "Dorsal_WhaleFinIntakeDark", mouth_pts, width=0.14, height=0.065,
        mat=mats["cavity_dark"], col=col, chamfer=0.30, sharp_angle_deg=44.0, parent=root,
    )
    mouth_glow = [eval_dorsal_pt(-3.06, lerp(-0.18, 0.18, k / 8.0), 0.118 - 0.014 * (lerp(-1.0, 1.0, k / 8.0) ** 2)) for k in range(9)]
    add_swept_strut(
        "Dorsal_WhaleFinIntakeCyanLip", mouth_glow, width=0.042, height=0.022,
        mat=mats["cyan_core"], col=col, chamfer=0.38, sharp_angle_deg=50.0, parent=root,
    )

    # Twin Sculpted Swept Aft Dorsal Aero-Strakes curving gracefully into V-tail roots (replaces grey dots/sticks!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        strake_pts = [
            eval_dorsal_pt(lerp(-3.75, -6.60, k / 10.0), side * lerp(0.56, 0.80, (k / 10.0) ** 1.15), 0.052 + 0.035 * math.sin((k / 10.0) * math.pi))
            for k in range(11)
        ]
        add_swept_strut(
            f"Dorsal_AftAeroStrake_{tag}", strake_pts, width=0.095, height=0.055,
            mat=mats["dark_titanium"], col=col, chamfer=0.36, sharp_angle_deg=46.0, parent=root,
        )

    # 4F. Swept V-Chevron Aft Thermal Exhaust Gills in Recessed Cobalt Trough (Y = -6.25 .. -8.50, replaces barcode!)
    trough_secs = []
    for k in range(9):
        t = k / 8.0
        yk = lerp(-6.15, -8.55, t)
        hs_t = lerp(0.46, 0.36, t)
        trough_secs.append([
            eval_dorsal_pt(yk, -hs_t, 0.005),
            eval_dorsal_pt(yk, -hs_t * 0.84, 0.055),
            eval_dorsal_pt(yk,  hs_t * 0.84, 0.055),
            eval_dorsal_pt(yk,  hs_t, 0.005),
        ])
    add_lofted_sections(
        "Dorsal_AftExhaustTrough", trough_secs, mats["cobalt_trim"], col,
        bevel=0.014, smooth=True, sharp_angle_deg=44.0, parent=root,
    )
    # Recessed dark shadow channel inside trough
    slot_pts = [eval_dorsal_pt(lerp(-6.35, -8.35, k / 8.0), 0.0, 0.060) for k in range(9)]
    add_swept_strut(
        "Dorsal_AftExhaustCavity", slot_pts, width=0.58, height=0.026,
        mat=mats["cavity_dark"], col=col, chamfer=0.25, sharp_angle_deg=40.0, parent=root,
    )
    # 4 Sleek Swept-Back V-Chevron Titanium Thermal Louvers echoing the swept V-tail angle!
    for k, y_ap in enumerate((-6.48, -6.98, -7.48, -7.98)):
        hs_l = lerp(0.42, 0.34, k / 3.0)
        chev_pts = []
        for j in range(11):
            fj = lerp(-1.0, 1.0, j / 10.0)
            sk = fj * hs_l
            yk = y_ap - 0.34 * abs(fj)
            chev_pts.append(eval_dorsal_pt(yk, sk, 0.076))
        add_swept_strut(
            f"Dorsal_AftChevronLouver_{k}", chev_pts, width=0.088, height=0.032,
            mat=mats["dark_titanium"], col=col, chamfer=0.35, sharp_angle_deg=44.0, parent=root,
        )
    # Subtle glowing electric-cyan spine thermal pulse running down the aft chevron centerline!
    aft_glow_pts = [eval_dorsal_pt(lerp(-6.50, -8.35, k / 8.0), 0.0, 0.086) for k in range(9)]
    add_swept_strut(
        "Dorsal_AftCenterCyanVein", aft_glow_pts, width=0.044, height=0.022,
        mat=mats["cyan_core"], col=col, chamfer=0.40, sharp_angle_deg=50.0, parent=root,
    )


# ---------------------------------------------------------------------------
# 9. Collection 05: Flush Armored Side Intakes, Recessed Waist & Dorsal Ports
# ---------------------------------------------------------------------------

def build_side_intakes_and_waist(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # 5A. Bold Sculpted Upper-Forward Armored Side Intake Scoop (CLEANLY VISIBLE on flank in Hero & Side!)
        # Sits right along the white-to-blue shoulder crease at Y = +1.35..+3.35, Z = +0.58..+1.16, X = ±3.10..±3.44
        hood_secs = [
            [(side * 2.96, 1.35, 0.58), (side * 3.38, 1.35, 0.64), (side * 3.40, 1.35, 1.00), (side * 3.02, 1.35, 1.12)],
            [(side * 2.92, 2.30, 0.56), (side * 3.44, 2.30, 0.64), (side * 3.44, 2.30, 1.04), (side * 2.98, 2.30, 1.16)],
            [(side * 2.82, 3.25, 0.64), (side * 3.24, 3.25, 0.70), (side * 3.24, 3.25, 0.98), (side * 2.88, 3.25, 1.08)],
        ]
        add_lofted_sections(f"Intake_UpperSideBezel_{tag}", hood_secs, mats["dark_titanium"], col, bevel=0.022, parent=root)
        # Recessed dark intake mouth + horizontal flow splitter vane
        cav_secs = [
            [(side * 3.16, 1.55, 0.64), (side * 3.42, 1.55, 0.68), (side * 3.42, 1.55, 0.92), (side * 3.16, 1.55, 0.94)],
            [(side * 3.12, 2.35, 0.62), (side * 3.46, 2.35, 0.68), (side * 3.46, 2.35, 0.94), (side * 3.12, 2.35, 0.96)],
            [(side * 3.00, 3.12, 0.68), (side * 3.27, 3.12, 0.72), (side * 3.27, 3.12, 0.92), (side * 3.00, 3.12, 0.94)],
        ]
        add_lofted_sections(f"Intake_UpperSideCavity_{tag}", cav_secs, mats["cavity_dark"], col, bevel=0.008, parent=root)
        # Sculpted upper oval sensor/actuator blister perched atop the intake hood (Hero & Side Ortho!)
        add_beveled_box(
            f"Intake_UpperPod_{tag}", (side * 3.28, 2.26, 1.04), (0.28, 0.92, 0.16),
            mats["dark_titanium"], col, bevel=0.04, rot=(0.0, side * 0.24, -side * 0.08), parent=root,
        )
        add_cylinder(
            f"Intake_UpperPodRing_{tag}", (side * 3.38, 2.42, 1.04), 0.07, 0.09,
            mats["chrome_alloy"], col, segments=16, rot=(0.0, math.pi * 0.5, -side * 0.08), bevel=0.008, parent=root,
        )

        # 5B. Hull-Conformal Recessed Mid-Hull Mechanical Waist Bay (tapers flush with blue hull — ZERO poking corners!)
        bay_ys = [1.15, 1.95, 2.75, 3.45]
        bay_secs = []
        cav_b_secs = []
        for y in bay_ys:
            hw, _, _, _, _, _, _ = eval_hull_station(y)
            x_out = hw - 0.02
            x_in = hw - 0.24
            bay_secs.append([(side * x_in, y, -1.16), (side * (x_out + 0.05), y, -1.12), (side * (x_out + 0.05), y, -0.52), (side * x_in, y, -0.48)])
            cav_b_secs.append([(side * (x_in + 0.04), y, -1.06), (side * (x_out + 0.07), y, -1.04), (side * (x_out + 0.07), y, -0.60), (side * (x_in + 0.04), y, -0.58)])
        add_lofted_sections(f"Waist_MechBayFrame_{tag}", bay_secs, mats["dark_titanium"], col, bevel=0.018, parent=root)
        add_lofted_sections(f"Waist_MechBayCavity_{tag}", cav_b_secs, mats["cavity_dark"], col, bevel=0.008, parent=root)
        # Conformal horizontal pipes & clamp ribs curving cleanly along the blue waist bay!
        for p_i, (zp, rad, mkey) in enumerate(((-0.70, 0.048, "dark_machinery"), (-0.82, 0.040, "chrome_alloy"), (-0.95, 0.054, "dark_titanium"))):
            p_pts = [(side * (eval_hull_station(y)[0] + 0.02), y, zp) for y in (1.30, 1.95, 2.60, 3.25)]
            add_swept_strut(
                f"Waist_MechPipe_{tag}_{p_i}", p_pts, width=rad * 2.0, height=rad * 1.8,
                mat=mats[mkey], col=col, parent=root,
            )
        for r_i, yr in enumerate((1.55, 2.05, 2.55, 3.05)):
            xh = eval_hull_station(yr)[0] + 0.04
            add_beveled_box(
                f"Waist_MechClamp_{tag}_{r_i}", (side * xh, yr, -0.82), (0.08, 0.09, 0.44),
                mats["dark_titanium"], col, bevel=0.008, rot=(0.0, 0.0, -side * 0.14), parent=root,
            )

        # 5C. Pre-Turbine Slotted Radiator Louver Grille (flush ahead of turbine pod!)
        add_beveled_box(
            f"Waist_PreTurbineGrilleFrame_{tag}", (side * 3.12, -0.72, -0.64), (0.24, 1.18, 0.48),
            mats["dark_titanium"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"Waist_PreTurbineGrilleCavity_{tag}", (side * 3.18, -0.72, -0.64), (0.14, 1.02, 0.36),
            mats["cavity_dark"], col, bevel=0.008, parent=root,
        )
        for lv in range(6):
            add_beveled_box(
                f"Waist_PreTurbineLouver_{tag}_{lv}", (side * 3.22, -0.72, -0.78 + lv * 0.056), (0.08, 0.98, 0.022),
                mats["dark_machinery"], col, bevel=0.004, parent=root,
            )

        # 5D. Flush Dorsal Cheek Dual-Nozzle Sensor Bays (Top Ortho!)
        add_beveled_box(
            f"Cheek_DorsalBayFrame_{tag}", (side * 2.56, 2.38, 1.98), (0.58, 1.44, 0.14),
            mats["ocean_blue"], col, bevel=0.018, rot=(-0.10, side * 0.48, side * 0.06), parent=root,
        )
        add_beveled_box(
            f"Cheek_DorsalBayRecess_{tag}", (side * 2.59, 2.38, 2.02), (0.44, 1.24, 0.08),
            mats["ice_silver"], col, bevel=0.012, rot=(-0.10, side * 0.48, side * 0.06), parent=root,
        )
        for n_i, (yn, zn) in enumerate(((2.08, 2.07), (2.66, 1.98))):
            add_cylinder(
                f"Cheek_DorsalNozzle_{tag}_{n_i}", (side * 2.62, yn, zn), 0.13, 0.08,
                mats["dark_titanium"], col, segments=18, rot=(-0.10, side * 0.48, 0.0), bevel=0.01, parent=root,
            )


# ---------------------------------------------------------------------------
# 10. Collection 06: Twin Circular Lateral Grav-Turbine Pods (V2 Crisp Electric Blue)
# ---------------------------------------------------------------------------

def build_lateral_grav_turbines(mats, col, root):
    cy, cz = -2.65, -0.58
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        cx = side * 2.98  # Tucked organically inside the sculpted wheel arch!

        # 6A. Outer Chamfered Deep Midnight-Blue / Dark-Titanium Cylindrical Turbine Barrel
        shroud_prof = [
            (-0.16, 1.22),
            ( 0.54, 1.22),
            ( 0.68, 1.14),
            ( 0.70, 1.04),
            ( 0.56, 1.00),
            ( 0.22, 1.00),
            ( 0.22, 0.00),
            (-0.16, 0.00),
        ]
        add_revolved_x(
            f"Turbine_OuterBarrel_{tag}", (cx, cy, cz), shroud_prof,
            mats["dark_titanium"], col, segments=64, side=side, sharp_angle_deg=34.0, parent=root,
        )

        # 6B. Sleek Dark-Ocean Outer Bezel Collar + Subtle Precision Chamfer Tabs
        rim_prof = [
            (0.44, 1.25),
            (0.62, 1.22),
            (0.64, 1.13),
            (0.44, 1.14),
        ]
        add_revolved_x(
            f"Turbine_OceanCollar_{tag}", (cx, cy, cz), rim_prof,
            mats["ocean_blue"], col, segments=64, side=side, sharp_angle_deg=32.0, parent=root,
        )
        for k in range(8):
            ang = k * math.pi * 0.25 + math.pi * 0.125
            ly = cy + 1.12 * math.cos(ang)
            lz = cz + 1.12 * math.sin(ang)
            add_beveled_box(
                f"Turbine_RimTab_{tag}_{k}", (cx + side * 0.65, ly, lz), (0.07, 0.12, 0.08),
                mats["dark_titanium"], col, bevel=0.01, rot=(ang, 0.0, 0.0), parent=root,
            )

        # 6C. Pitch-Dark Recessed Turbine Throat Backing + 24 Angled Stator Blades
        add_cylinder(
            f"Turbine_BackCavity_{tag}", (cx + side * 0.24, cy, cz), 1.02, 0.10,
            mats["cavity_dark"], col, segments=48, rot=(0.0, math.pi * 0.5, 0.0), bevel=0.0, parent=root,
        )
        for v_i in range(24):
            ang = 2.0 * math.pi * v_i / 24.0
            vy = cy + 0.76 * math.cos(ang)
            vz = cz + 0.76 * math.sin(ang)
            add_beveled_box(
                f"Turbine_StatorVane_{tag}_{v_i}", (cx + side * 0.40, vy, vz), (0.18, 0.36, 0.028),
                mats["dark_machinery"], col, bevel=0.004, rot=(ang + 0.34, 0.0, 0.0), parent=root,
            )

        # 6D. Razor-Crisp Outer Electric Cerulean-Blue Energy Ring (Hero & Side Ortho!)
        outer_halo_prof = [
            (0.46, 0.94),
            (0.58, 0.93),
            (0.60, 0.84),
            (0.46, 0.83),
        ]
        add_revolved_x(
            f"Turbine_OuterBlueHalo_{tag}", (cx, cy, cz), outer_halo_prof,
            mats["cyan_glow"], col, segments=64, side=side, sharp_angle_deg=45.0, parent=root,
        )
        outer_line_prof = [
            (0.58, 0.90),
            (0.63, 0.895),
            (0.63, 0.865),
            (0.58, 0.86),
        ]
        add_revolved_x(
            f"Turbine_OuterBlueFilament_{tag}", (cx, cy, cz), outer_line_prof,
            mats["cyan_core"], col, segments=64, side=side, sharp_angle_deg=45.0, parent=root,
        )
        # 4 Slim Cardinal Structural Bridge Clips across outer ring
        for k in range(4):
            ang = k * math.pi * 0.5 + math.pi * 0.25
            by = cy + 0.88 * math.cos(ang)
            bz = cz + 0.88 * math.sin(ang)
            add_beveled_box(
                f"Turbine_RingBridge_{tag}_{k}", (cx + side * 0.62, by, bz), (0.07, 0.18, 0.095),
                mats["dark_titanium"], col, bevel=0.01, rot=(ang, 0.0, 0.0), parent=root,
            )

        # 6E. Deep Dark-Ocean Machined Mid-Stator Ring (R = 0.58 .. 0.80 m)
        mid_ring_prof = [
            (0.42, 0.80),
            (0.62, 0.78),
            (0.63, 0.61),
            (0.42, 0.59),
        ]
        add_revolved_x(
            f"Turbine_MidStatorRing_{tag}", (cx, cy, cz), mid_ring_prof,
            mats["ocean_blue"], col, segments=64, side=side, sharp_angle_deg=34.0, parent=root,
        )

        # 6F. Razor-Crisp Inner Electric-Cyan Core Ring (R = 0.50 .. 0.57 m)
        inner_glow_prof = [
            (0.48, 0.57),
            (0.64, 0.56),
            (0.65, 0.50),
            (0.48, 0.49),
        ]
        add_revolved_x(
            f"Turbine_InnerCyanCoreRing_{tag}", (cx, cy, cz), inner_glow_prof,
            mats["cyan_core"], col, segments=64, side=side, sharp_angle_deg=45.0, parent=root,
        )

        # 6G. Central Domed Deep-Ocean Rotor Hub Cap (R = 0.46 m)
        hub_prof = [
            (0.34, 0.46),
            (0.62, 0.44),
            (0.71, 0.34),
            (0.72, 0.22),
            (0.67, 0.18),
            (0.67, 0.00),
            (0.34, 0.00),
        ]
        add_revolved_x(
            f"Turbine_CentralHub_{tag}", (cx, cy, cz), hub_prof,
            mats["ocean_blue"], col, segments=48, side=side, sharp_angle_deg=36.0, parent=root,
        )
        chrome_prof = [
            (0.67, 0.25),
            (0.71, 0.24),
            (0.71, 0.20),
            (0.67, 0.19),
        ]
        add_revolved_x(
            f"Turbine_HubChromeRing_{tag}", (cx, cy, cz), chrome_prof,
            mats["chrome_alloy"], col, segments=48, side=side, sharp_angle_deg=36.0, parent=root,
        )


# ---------------------------------------------------------------------------
# 11. Collection 07: Broad Swept V-Tail Whale-Fluke Stabilizers (V2 Sculpted)
# ---------------------------------------------------------------------------

def build_vtail_whale_flukes(mats, col, root):
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        # 7A. Sleek Sculpted Cobalt-Blue & Dark-Titanium Hinge Knuckle Fairing (replaces bulky cylinders!)
        knuckle_secs = [
            [(side * 0.72, -6.55, 1.82), (side * 1.10, -6.55, 1.72), (side * 1.16, -6.55, 2.02), (side * 0.80, -6.55, 2.08)],
            [(side * 0.70, -7.65, 1.62), (side * 1.14, -7.65, 1.54), (side * 1.22, -7.65, 1.98), (side * 0.78, -7.65, 2.04)],
            [(side * 0.68, -8.75, 1.38), (side * 1.06, -8.75, 1.34), (side * 1.12, -8.75, 1.72), (side * 0.74, -8.75, 1.78)],
        ]
        add_lofted_sections(
            f"VTail_RootHingeFairing_{tag}", knuckle_secs, mats["dark_titanium"], col,
            bevel=0.025, smooth=True, sharp_angle_deg=34.0, parent=root,
        )

        # 7B. Graceful Curved Swept Whale-Fluke V-Tail Blade (organic whale-tail sweep + smooth aerodynamics!)
        fin_stations = [
            # (t_span, x_le, y_le, z_le, chord_y, drop_z, thick_n)
            (0.00, 0.94, -6.62, 1.88, 2.36, -0.34, 0.19),
            (0.20, 1.44, -7.12, 2.42, 2.24, -0.28, 0.17),
            (0.42, 1.98, -7.68, 3.00, 2.02, -0.22, 0.15),
            (0.65, 2.54, -8.32, 3.60, 1.66, -0.15, 0.125),
            (0.84, 2.98, -8.94, 4.10, 1.18, -0.08, 0.092),
            (0.95, 3.22, -9.38, 4.35, 0.72, -0.03, 0.062),
            (1.00, 3.32, -9.66, 4.44, 0.36, -0.02, 0.042),
        ]
        nx = -side * 0.68
        nz = 0.73
        nvec = Vector((nx, 0.0, nz))
        fin_secs = []
        for (_, xle, yle, zle, chord, dz, th) in fin_stations:
            p_le = Vector((side * xle, yle, zle))
            p_te = Vector((side * (xle + 0.18), yle - chord, zle + dz))
            p_m1 = p_le.lerp(p_te, 0.28)
            p_m2 = p_le.lerp(p_te, 0.68)
            fin_secs.append([
                tuple(p_le),
                tuple(p_m1 + nvec * th),
                tuple(p_m2 + nvec * (th * 0.72)),
                tuple(p_te),
                tuple(p_m2 - nvec * (th * 0.72)),
                tuple(p_m1 - nvec * th),
            ])
        add_lofted_sections(
            f"VTail_MainWhiteBlade_{tag}", fin_secs, mats["pearl_white"], col,
            bevel=0.016, smooth=True, sharp_angle_deg=44.0, parent=root,
        )

        # Exact conformal evaluator for V-tail blade outer (-1) & inner (+1) airfoil surfaces!
        def eval_vtail_pt(ts, c_frac, face_sign, extra_off=0.0):
            ts_c = max(0.0, min(1.0, ts))
            st = fin_stations[-1]
            for si in range(len(fin_stations) - 1):
                t0 = fin_stations[si][0]
                t1 = fin_stations[si + 1][0]
                if t0 <= ts_c <= t1:
                    tf = (ts_c - t0) / max(t1 - t0, 1e-6)
                    st = tuple(lerp(a, b, tf) for a, b in zip(fin_stations[si], fin_stations[si + 1]))
                    break
            _, xle, yle, zle, chord, dz, th = st
            p_le = Vector((side * xle, yle, zle))
            p_te = Vector((side * (xle + 0.18), yle - chord, zle + dz))
            cf = max(0.0, min(1.0, c_frac))
            if cf <= 0.28:
                half_th = th * (cf / 0.28)
            elif cf <= 0.68:
                half_th = lerp(th, th * 0.72, (cf - 0.28) / 0.40)
            else:
                half_th = lerp(th * 0.72, 0.0, (cf - 0.68) / 0.32)
            p = p_le.lerp(p_te, cf) + nvec * (face_sign * (half_th + extra_off))
            return (p.x, p.y, p.z)

        def add_vtail_conformal_ribbon(name, samples, face_sign, mat, n_across=5, out_off=0.022, crown_off=0.010, in_off=-0.018):
            """Build a conformal whale-fluke feature stripe on either inner (+1) or outer (-1) V-tail blade face."""
            go_v, gi_v = [], []
            for ts_s, c_lo, c_hi in samples:
                row_o, row_i = [], []
                for k in range(n_across):
                    fk = k / float(n_across - 1)
                    cf = lerp(c_lo, c_hi, fk)
                    bell = math.sin(fk * math.pi)
                    row_o.append(eval_vtail_pt(ts_s, cf, face_sign, out_off + crown_off * bell))
                    row_i.append(eval_vtail_pt(ts_s, cf, face_sign, in_off))
                go_v.append(row_o)
                gi_v.append(row_i)
            return add_thick_surface_grid(
                name, go_v, gi_v, mat, col, smooth=True, sharp_angle_deg=48.0, parent=root,
            )

        # 7C. Sweeping DeepSeek Whale-Blue Leading + Hooked Tip Fluke Wrap (wraps ALL the way over tip!)
        def leading_frac(ts):
            # Sleek whale-fluke curve: narrows gracefully mid-span then hooks wider around the curved fluke tip!
            if ts <= 0.78:
                return lerp(0.45, 0.33, ts / 0.78)
            t_tip = (ts - 0.78) / 0.22
            return lerp(0.33, 0.92, t_tip ** 1.45)

        le_secs = []
        for (ts, xle, yle, zle, chord, dz, th) in fin_stations:
            p_le = Vector((side * xle, yle + 0.034, zle + 0.015))
            frac = leading_frac(ts)
            p_in = p_le.lerp(Vector((side * (xle + 0.18), yle - chord, zle + dz)), frac)
            p_mid = p_le.lerp(p_in, 0.50)
            le_secs.append([
                tuple(p_le),
                tuple(p_mid + nvec * (th * 1.12 + 0.012)),
                tuple(p_in + nvec * (th * 1.10 + 0.012)),
                tuple(p_in - nvec * (th * 1.10 + 0.012)),
                tuple(p_mid - nvec * (th * 1.12 + 0.012)),
            ])
        add_lofted_sections(
            f"VTail_DeepSeekBlueLeadingSweep_{tag}", le_secs, mats["deepseek_blue"], col,
            bevel=0.012, smooth=True, sharp_angle_deg=48.0, parent=root,
        )

        # 7C-2. Crisp DeepSeek-Blue Trailing-Edge Whale-Fluke Rim Accent!
        te_secs = []
        for (ts, xle, yle, zle, chord, dz, th) in fin_stations:
            if ts < 0.03:
                continue
            p_le = Vector((side * xle, yle, zle))
            p_te = Vector((side * (xle + 0.18), yle - chord - 0.028, zle + dz - 0.008))
            p_fwd = p_le.lerp(p_te, lerp(0.91, 0.84, ts))
            te_secs.append([
                tuple(p_te),
                tuple(p_fwd + nvec * (th * 0.42 + 0.016)),
                tuple(p_fwd - nvec * (th * 0.42 + 0.016)),
            ])
        add_lofted_sections(
            f"VTail_TrailingBlueAccent_{tag}", te_secs, mats["deepseek_blue"], col,
            bevel=0.008, smooth=True, sharp_angle_deg=48.0, parent=root,
        )

        # 7C-3. Dual-Face Conformal Whale-Fluke Feature Lines (Cyan Contour Spine + Twin Curved Blue Fluke Ribbons!)
        for f_sign, f_tag in ((-1, "Out"), (1, "In")):
            # Luminous electric-cyan streamline tracing the curved leading-blue boundary up into the tip!
            cyan_spine = []
            for k in range(21):
                ts_k = lerp(0.04, 0.86, k / 20.0)
                t_c = k / 20.0
                c_b = leading_frac(ts_k) + 0.022
                dc = 0.032 * max(0.25, math.sin(t_c * math.pi) ** 0.45)
                cyan_spine.append((ts_k, c_b, min(0.96, c_b + dc)))
            add_vtail_conformal_ribbon(
                f"VTail_CyanFlukeSpine_{tag}_{f_tag}", cyan_spine, f_sign, mats["cyan_core"],
                n_across=3, out_off=0.022, crown_off=0.008, in_off=-0.012,
            )

            # Primary sweeping curved DeepSeek-blue whale-fluke rib arc across the white blade!
            fluke_arc_0 = []
            for k in range(19):
                t = k / 18.0
                ts_k = lerp(0.14, 0.74, t)
                # Sweeps gracefully from leading blue boundary across the white fluke to kiss the upper trailing rim!
                c_start = leading_frac(0.14) + 0.04
                c_mid = lerp(c_start, 0.93, t ** 0.82) - 0.075 * math.sin(t * math.pi)
                hw_c = 0.5 * 0.115 * max(0.15, math.sin(t * math.pi) ** 0.55)
                fluke_arc_0.append((ts_k, max(0.35, c_mid - hw_c), min(0.96, c_mid + hw_c)))
            add_vtail_conformal_ribbon(
                f"VTail_FlukeWaveRibbon_{tag}_{f_tag}_0", fluke_arc_0, f_sign, mats["deepseek_blue"],
                n_across=5, out_off=0.020, crown_off=0.010, in_off=-0.016,
            )

            # Secondary parallel DeepSeek-blue whale-fluke echo arc sweeping from lower root to mid trailing edge!
            fluke_arc_1 = []
            for k in range(17):
                t = k / 16.0
                ts_k = lerp(0.05, 0.50, t)
                c_mid = lerp(0.56, 0.93, t ** 0.88) - 0.055 * math.sin(t * math.pi)
                hw_c = 0.5 * 0.072 * max(0.16, math.sin(t * math.pi) ** 0.55)
                fluke_arc_1.append((ts_k, max(0.46, c_mid - hw_c), min(0.96, c_mid + hw_c)))
            add_vtail_conformal_ribbon(
                f"VTail_FlukeWaveRibbon_{tag}_{f_tag}_1", fluke_arc_1, f_sign, mats["cobalt_trim"],
                n_across=5, out_off=0.018, crown_off=0.008, in_off=-0.016,
            )

        # 7D. Flush Glowing Electric-Cyan Teardrop Emitter Lens Near Upper Leading Edge (Front, Top, Hero!)
        p0 = Vector((side * 2.46, -8.40, 3.54))
        p1 = Vector((side * 2.86, -8.90, 3.98))
        pmid = p0.lerp(p1, 0.5)
        add_swept_strut(
            f"VTail_CyanEmitterBezel_{tag}",
            [tuple(p0 + nvec * 0.088), tuple(pmid + nvec * 0.098), tuple(p1 + nvec * 0.078)],
            width=0.22, height=0.052, mat=mats["dark_titanium"], col=col, up_hint=(nx, 0.0, nz), parent=root,
        )
        add_swept_strut(
            f"VTail_CyanEmitterLens_{tag}",
            [tuple(p0.lerp(p1, 0.14) + nvec * 0.106), tuple(pmid + nvec * 0.114), tuple(p0.lerp(p1, 0.86) + nvec * 0.096)],
            width=0.14, height=0.036, mat=mats["cyan_core"], col=col, up_hint=(nx, 0.0, nz), parent=root,
        )


# ---------------------------------------------------------------------------
# 12. Collection 08: Triple-Chamber Stern Drive, Sleek Slit Lights & Details
# ---------------------------------------------------------------------------

def build_stern_thrusters_and_lights(mats, col, root):
    # 8A. Faceted Cobalt-Blue Armored Stern Propulsion Housing (Rear Ortho 17.18.28.png!)
    stern_outer = [
        (-1.24,  0.86),
        ( 1.24,  0.86),
        ( 1.84,  0.34),
        ( 1.82, -0.44),
        ( 1.36, -0.78),
        (-1.36, -0.78),
        (-1.82, -0.44),
        (-1.84,  0.34),
    ]
    add_extruded_poly_y(
        "Stern_ArmoredHousingBlock", stern_outer, y0=-9.14, y1=-8.25,
        mat=mats["cobalt_trim"], col=col, bevel=0.034, scale0=0.97, scale1=1.06, parent=root,
    )
    # Upper stern brow hood overhanging above the triple nozzles (Y = -9.46 .. -9.06, Z = +0.36 .. +0.86)
    stern_brow = [(-1.22, 0.85), (1.22, 0.85), (1.74, 0.42), (-1.74, 0.42)]
    add_extruded_poly_y(
        "Stern_UpperBrowHood", stern_brow, y0=-9.42, y1=-9.04,
        mat=mats["cobalt_trim"], col=col, bevel=0.024, scale0=0.96, scale1=1.02, parent=root,
    )
    # Lower stern chin lip below the triple nozzles (Y = -9.44 .. -9.06, Z = -0.78 .. -0.50)
    stern_lip = [(-1.72, -0.46), (1.72, -0.46), (1.32, -0.78), (-1.32, -0.78)]
    add_extruded_poly_y(
        "Stern_LowerChinLip", stern_lip, y0=-9.42, y1=-9.04,
        mat=mats["cobalt_trim"], col=col, bevel=0.024, scale0=0.96, scale1=1.02, parent=root,
    )

    # Wide Horizontal Vivid Electric-Cyan Trapezoidal Stern Status Strip (Rear Ortho!)
    add_beveled_box(
        "Stern_UpperLightBezel", (0.0, -9.36, 0.56), (1.94, 0.22, 0.20),
        mats["dark_titanium"], col, bevel=0.016, rot=(0.24, 0.0, 0.0), parent=root,
    )
    bar_pts = [(-0.88, 0.49), (0.88, 0.49), (0.76, 0.63), (-0.76, 0.63)]
    add_extruded_poly_y(
        "Stern_UpperCyanLightStrip", bar_pts, y0=-9.47, y1=-9.34,
        mat=mats["cyan_core"], col=col, bevel=0.01, parent=root,
    )

    # 8B. Deep Dark Recessed Twin Main Hexagonal/Octagonal Thruster Chambers (Rear Ortho!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        tx, tz = side * 0.96, -0.08
        out_oct = octagon_xz(tx, tz, hw=0.52, hh=0.46, ch=0.14)
        mid_oct = octagon_xz(tx, tz, hw=0.38, hh=0.33, ch=0.10)
        in_oct  = octagon_xz(tx, tz, hw=0.31, hh=0.26, ch=0.08)

        # Heavy chamfered cobalt-blue outer thruster nozzle frame
        add_hollow_frame_y(
            f"Stern_MainThrusterShroud_{tag}", out_oct, mid_oct,
            y_back=-9.62, y_front=-9.12, mat=mats["cobalt_trim"], col=col, bevel=0.022, parent=root,
        )
        # Stepped dark-titanium inner nozzle throat sleeve (deep recess!)
        add_hollow_frame_y(
            f"Stern_MainThrusterLiner_{tag}", mid_oct, in_oct,
            y_back=-9.54, y_front=-8.88, mat=mats["dark_titanium"], col=col, bevel=0.012, parent=root,
        )
        # Deep pitch-dark thruster chamber core (unoccluded inside open nozzle!)
        add_extruded_poly_y(
            f"Stern_MainThrusterCavity_{tag}", in_oct, y0=-9.20, y1=-8.85,
            mat=mats["cavity_dark"], col=col, bevel=0.008, parent=root,
        )
        # Subtle recessed deep-blue plasma ring tucked DEEP inside the dark chamber
        bm_r = bmesh.new()
        n_s = 28
        r_out, r_in = 0.21, 0.15
        y_b, y_f = -9.24, -9.18
        ob = [bm_r.verts.new((tx + r_out * math.cos(2 * math.pi * i / n_s), y_b, tz + r_out * math.sin(2 * math.pi * i / n_s))) for i in range(n_s)]
        of = [bm_r.verts.new((tx + r_out * math.cos(2 * math.pi * i / n_s), y_f, tz + r_out * math.sin(2 * math.pi * i / n_s))) for i in range(n_s)]
        ib = [bm_r.verts.new((tx + r_in  * math.cos(2 * math.pi * i / n_s), y_b, tz + r_in  * math.sin(2 * math.pi * i / n_s))) for i in range(n_s)]
        if_ = [bm_r.verts.new((tx + r_in  * math.cos(2 * math.pi * i / n_s), y_f, tz + r_in  * math.sin(2 * math.pi * i / n_s))) for i in range(n_s)]
        for i in range(n_s):
            ni = (i + 1) % n_s
            bm_r.faces.new((ob[i], ob[ni], of[ni], of[i]))
            bm_r.faces.new((if_[i], if_[ni], ib[ni], ib[i]))
            bm_r.faces.new((ob[i], ib[i], ib[ni], ob[ni]))
            bm_r.faces.new((of[i], of[ni], if_[ni], if_[i]))
        finalize_mesh(bm_r, f"Stern_MainIonRing_{tag}", mats["cyan_glow"], col, smooth=True, parent=root)

        # 8 Radial Dark Exhaust Baffle Vanes inside nozzle throat
        for v_i in range(8):
            ang = v_i * math.pi * 0.25
            vy = tz + 0.17 * math.sin(ang)
            vx = tx + 0.17 * math.cos(ang)
            add_beveled_box(
                f"Stern_MainVane_{tag}_{v_i}", (vx, -9.28, vy), (0.14, 0.24, 0.024),
                mats["dark_machinery"], col, bevel=0.003, rot=(0.0, ang, 0.0), parent=root,
            )

        # Outboard Auxiliary Vernier Chambers on outer stern bevel cheeks (Rear Ortho!)
        add_beveled_box(
            f"Stern_AuxVernierFrame_{tag}", (side * 1.62, -9.32, -0.06), (0.32, 0.36, 0.42),
            mats["dark_titanium"], col, bevel=0.018, parent=root,
        )
        add_beveled_box(
            f"Stern_AuxVernierCavity_{tag}", (side * 1.62, -9.46, -0.06), (0.20, 0.16, 0.26),
            mats["cavity_dark"], col, bevel=0.008, parent=root,
        )
        add_beveled_box(
            f"Stern_AuxVernierGlow_{tag}", (side * 1.62, -9.36, -0.06), (0.12, 0.06, 0.12),
            mats["cyan_glow"], col, bevel=0.005, parent=root,
        )

    # 8C. Deep Dark Recessed Central Vectoring Thruster Chamber (X = 0.0, Rear Ortho!)
    ctr_out = octagon_xz(0.0, -0.08, hw=0.42, hh=0.45, ch=0.06)
    ctr_in  = octagon_xz(0.0, -0.08, hw=0.30, hh=0.33, ch=0.05)
    add_hollow_frame_y(
        "Stern_CenterThrusterFrame", ctr_out, ctr_in,
        y_back=-9.58, y_front=-9.08, mat=mats["cobalt_trim"], col=col, bevel=0.02, parent=root,
    )
    add_extruded_poly_y(
        "Stern_CenterThrusterCavity", ctr_in, y0=-9.20, y1=-8.85,
        mat=mats["cavity_dark"], col=col, bevel=0.008, parent=root,
    )
    add_beveled_box(
        "Stern_CenterThrusterGlow", (0.0, -9.23, -0.08), (0.24, 0.06, 0.24),
        mats["cyan_glow"], col, bevel=0.010, parent=root,
    )
    for lv in range(3):
        add_beveled_box(
            f"Stern_CenterVectorVane_{lv}", (0.0, -9.38, -0.22 + lv * 0.14), (0.48, 0.20, 0.036),
            mats["dark_machinery"], col, bevel=0.005, parent=root,
        )

    # 8D. Bold Flush Electric-Blue Tactical Running Slit Lights (Hero & Side Ortho!)
    for side, tag in ((-1, "Port"), (1, "Stbd")):
        slit_specs = [
            # Forward bow cheek sleek angled blue light strip nestled cleanly flush in bow chine!
            ("FwdBowSlit",    (side * 1.62,  8.16, -1.12), (0.16, 1.48, 0.20), (0.06, -side * 0.16, -side * 0.34)),
            # Secondary forward mid-cheek slit (Hero!)
            ("FwdCheekSlit",  (side * 2.50,  5.18, -1.04), (0.18, 1.24, 0.20), (0.02, -side * 0.14, -side * 0.16)),
            # Pre-turbine waist bar right below radiator grille (Side & Hero!)
            ("PreTurbineBar", (side * 3.12, -0.72, -1.10), (0.16, 1.06, 0.15), (0.00, -side * 0.08,  0.00)),
            # Aft flank micro slit behind turbine (Side & Hero!)
            ("AftFlankSlit",  (side * 2.70, -5.45, -0.80), (0.14, 0.90, 0.12), (-0.06, -side * 0.12, side * 0.20)),
        ]
        for lbl, loc, sz, rot in slit_specs:
            add_beveled_box(
                f"Light_Bezel_{lbl}_{tag}", loc, (sz[0], sz[1], sz[2]),
                mats["ocean_blue"], col, bevel=0.018, rot=rot, parent=root,
            )
            add_beveled_box(
                f"Light_Recess_{lbl}_{tag}", (loc[0] + side * sz[0] * 0.26, loc[1], loc[2]),
                (sz[0] * 0.50, sz[1] * 0.84, sz[2] * 0.56),
                mats["cavity_dark"], col, bevel=0.008, rot=rot, parent=root,
            )
            add_beveled_box(
                f"Light_Core_{lbl}_{tag}", (loc[0] + side * sz[0] * 0.38, loc[1], loc[2]),
                (sz[0] * 0.36, sz[1] * 0.74, sz[2] * 0.32),
                mats["cyan_core"], col, bevel=0.006, rot=rot, parent=root,
            )

        # Recessed aft flank dark mechanical exhaust grille tucked into stern side (Side Ortho!)
        add_beveled_box(
            f"Detail_AftFlankExhaustBay_{tag}", (side * 2.08, -8.38, -0.02), (0.22, 1.24, 0.38),
            mats["dark_titanium"], col, bevel=0.016, rot=(0.0, 0.0, side * 0.22), parent=root,
        )
        for k in range(3):
            add_beveled_box(
                f"Detail_AftFlankSlit_{tag}_{k}", (side * 2.16, -8.08 - k * 0.28, -0.02), (0.08, 0.15, 0.18),
                mats["cavity_dark"], col, bevel=0.005, rot=(0.0, 0.0, side * 0.22), parent=root,
            )


# ---------------------------------------------------------------------------
# 13. Studio Orbital Lighting, Subtle Electric-Blue Bounce & 7 Calibrated Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_comic_lineart(col_lineart_src, col_ink):
    """Build ONE whisper-thin, clean modern anime outer silhouette contour ONLY (ZERO messy/thick interior scribbles!)."""
    gp_data = bpy.data.grease_pencils.new("DeepSeek_CartoonInk_GP")
    gp_data.stroke_depth_order = "3D"

    layer_sil = gp_data.layers.new("Silhouette_Ink")
    layer_sil.frames.new(1)
    layer_sil.use_lights = False
    layer_sil.opacity = 0.72

    ink_mat = bpy.data.materials.new("Mat_DeepSeek_CartoonInk")
    bpy.data.materials.create_gpencil_data(ink_mat)
    # Soft deep oceanic-navy cartoon contour line (harmonizes delicately, never harsh thick black!)
    ink_mat.grease_pencil.color = (0.024, 0.058, 0.175, 1.0)
    gp_data.materials.append(ink_mat)

    gp_obj = bpy.data.objects.new("DeepSeek_CartoonInk_Lines", gp_data)
    link_obj(gp_obj, col_ink)

    # Single delicate outer silhouette contour ONLY — zero intersection/crease scribbles!
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
    mod_sil.radius = 0.014
    mod_sil.opacity = 0.68
    mod_sil.stroke_depth_offset = 0.025
    mod_sil.overscan = 0.14

    return gp_obj


def setup_world_and_lighting(col_stage):
    """Calibrate crisp Anime Cel-Shading studio chiaroscuro lighting & cool twilight backdrop."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("DeepSeek_Cartoon_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        # Clean cool twilight-navy studio backdrop so BOTH deep-indigo ink outlines & porcelain armor pop!
        bg.inputs["Color"].default_value = (0.068, 0.088, 0.132, 1.0)
        bg.inputs["Strength"].default_value = 0.44

    def add_light(name, ltype, loc, target, energy, color, size=14.0, angle=0.015, radius=0.6):
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

    # 1. Strong Graphic Directional Sun Key (carves crisp anime 4-band cel shadow planes!)
    add_light("Key_Sun_Cartoon", "SUN", (-16.0, 20.0, 26.0), (0.0, 0.5, 0.2), energy=3.15, color=(1.0, 1.0, 1.0), angle=0.012)

    # 2. Restrained Cool Starboard Rim Fill (preserves clean cel shadow steps without washing out!)
    add_light("Rim_Area_Starboard", "AREA", (24.0, 2.0, 12.0), (0.0, -1.0, 0.2), energy=1550.0, color=(0.84, 0.92, 1.0), size=20.0)

    # 3. Gentle Port-Bow Canopy Fill
    add_light("Fill_Area_PortBow", "AREA", (-16.0, 22.0, 5.0), (0.0, 4.5, 0.4), energy=950.0, color=(0.88, 0.94, 1.0), size=16.0)

    # 4. Stern Key Rim (keeps rear & rear 3/4 cel planes dimensional!)
    add_light("Rim_Area_Stern", "AREA", (10.0, -26.0, 12.0), (0.0, -8.5, 0.4), energy=2200.0, color=(0.92, 0.96, 1.0), size=18.0)

    # 5. Subtle Cool Underbelly Bounce (preserves cel mid-shadow step on bottom ortho!)
    add_light("Bounce_Area_HorizonFwd", "AREA", (-4.0, 4.0, -24.0), (0.0, 1.0, -1.8), energy=1650.0, color=(0.74, 0.88, 1.0), size=24.0)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=38.0, ortho_scale=22.0):
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

    make_cam("Cam_Hero_34", (-15.8, 16.4, 3.6), (0.0, -0.5, 0.32), cam_type="PERSP", lens=38.0)

    c_side = make_cam("Cam_Side_Ortho", (30.0, 0.0, 0.90), (0.0, 0.0, 0.90), cam_type="ORTHO", ortho_scale=22.5)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

    c_front = make_cam("Cam_Front_Ortho", (0.0, 30.0, 0.85), (0.0, 0.0, 0.85), cam_type="ORTHO", ortho_scale=11.6)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    c_stern = make_cam("Cam_Stern_Ortho", (0.0, -30.0, 1.05), (0.0, 0.0, 1.05), cam_type="ORTHO", ortho_scale=11.6)
    c_stern.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 34.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=32.5)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    c_bot = make_cam("Cam_Bottom_Ortho", (0.0, 0.0, -34.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=32.5)
    c_bot.rotation_euler = (math.pi, 0.0, 0.0)

    make_cam("Cam_Rear_34", (14.5, -17.5, 6.0), (0.0, -1.0, 0.45), cam_type="PERSP", lens=36.0)

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

    # Standard color transform preserves pure anime cel whites, deep indigo ink & vivid DeepSeek blue!
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
# 14. Main Build Entrypoint
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root    = ensure_collection("DeepSeek_OrbitalExplorer")
    col_solid   = ensure_collection("DeepSeek_Solid_LineArt_Source", col_root)
    col_core    = ensure_collection("01_Core_OceanBlue_Chassis", col_solid)
    col_armor   = ensure_collection("02_PearlWhite_Faceted_HullShells", col_solid)
    col_canopy  = ensure_collection("03_Geodesic_Canopy_And_Cockpit", col_solid)
    col_dorsal  = ensure_collection("04_Dorsal_Spine_And_DeckSystems", col_solid)
    col_waist   = ensure_collection("05_Side_Intakes_And_MechanicalWaist", col_solid)
    col_turbine = ensure_collection("06_Lateral_GravTurbine_Pods", col_solid)
    col_vtail   = ensure_collection("07_Swept_VTail_WhaleFlukes", col_solid)
    col_stern   = ensure_collection("08_Triple_Stern_Thrusters_And_Lights", col_solid)
    col_fx      = ensure_collection("09_Cartoon_Glass_And_EmissiveFX", col_root)
    col_ink     = ensure_collection("98_Cartoon_Ink_LineArt")
    col_stage   = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("DeepSeek_Explorer_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.5
    link_obj(root, col_root)

    tex = generate_deepseek_textures(res=1024)
    mats = build_materials(tex)

    build_core_chassis(mats, col_core, root)
    build_pearl_white_armor(mats, col_armor, root)
    build_geodesic_canopy_and_cockpit(mats, col_canopy, root)
    build_dorsal_spine_systems(mats, col_dorsal, root)
    build_side_intakes_and_waist(mats, col_waist, root)
    build_lateral_grav_turbines(mats, col_turbine, root)
    build_vtail_whale_flukes(mats, col_vtail, root)
    build_stern_thrusters_and_lights(mats, col_stern, root)

    # Keep ONLY the clean primary outer silhouette shells in col_solid for the whisper-thin outer contour!
    # Route glass, cockpit, glowing accents AND surface-inlaid stripes/decals to col_fx so ZERO messy
    # double-lines or broken interior strokes ever appear across the curved whale body or V-tail!
    fx_mats = {mats["canopy_glass"], mats["cyan_glow"], mats["cyan_core"], mats["cockpit_hud"]}
    inlay_prefixes = (
        "Cockpit_",
        "Armor_BowWhaleBlue",
        "Armor_DeepSeekBlueWhaleWave",
        "Flank_",
        "Dorsal_",
        "Canopy_WhaleStreamlineRib",
        "Canopy_RearHaloArch",
        "Canopy_DeepSeekBlue_CoamingRim",
        "VTail_FlukeWaveRibbon",
        "VTail_TrailingBlueAccent",
        "VTail_DeepSeekBlueLeadingSweep",
        "VTail_CyanEmitter",
        "Turbine_StatorVane",
        "Turbine_RimTab",
        "Turbine_RingBridge",
        "Turbine_HubChromeRing",
        "Light_",
        "Detail_",
        "Waist_MechPipe",
        "Waist_MechClamp",
        "Waist_PreTurbineLouver",
        "Stern_MainVane",
        "Stern_CenterVectorVane",
    )
    for obj in list(bpy.data.objects):
        if obj.type != "MESH":
            continue
        is_inlay = obj.name.startswith(inlay_prefixes)
        uses_fx_mat = bool(obj.data.materials) and (obj.data.materials[0] in fx_mats)
        if is_inlay or uses_fx_mat:
            link_obj(obj, col_fx)

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

    print(
        f"BUILT DeepSeek_OrbitalExplorer V9 (Clean Silky Anime Cel-Shaded Cartoon): "
        f"{len(mesh_objs)} meshes, {total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
