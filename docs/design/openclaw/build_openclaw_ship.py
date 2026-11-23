"""Parametric hard-surface 3D model builder for the OpenClaw Orbital Cruiser (V2 Polished).

Built directly from the 3 orthographic reference views in docs/design/openclaw/
plus the hero orbital concept docs/design/ref_image/openclaw.png:
  - Top View:   已粘贴 2026-11-23 22.13.19.png (weathered titanium-silver chamfered hull,
                obsidian forward panel, port 8-slat louver vent, deep glowing molten-amber
                glazed reactor bay, symmetric crimson C-claws w/ twin silver shoulder stripes)
  - Side View:  已粘贴 2026-11-23 22.13.26.png (flat dorsal deck, split-seam crimson claw
                extending aft past hull, deep beveled dark-steel underbelly keel w/ 3 bays)
  - End View:   已粘贴 2026-11-23 22.13.34.png (aft/open-claw end: foreground crimson hook tips,
                trapezoidal recessed horizontal lower exhaust slot, beveled trapezoidal belly)
  - Hero 3/4:   docs/design/ref_image/openclaw.png (bow flush vertical cyan-white LED strips,
                beveled forward docking slot, detailed golden-amber reactor bay under glass)

Coordinate system (Blender Z-up, meters):
  -X = Port, +X = Starboard        -> X in [-9.00, +9.00] (18.00 m total span)
  +Y = Bow (dark panel / claw root) -> Y in [-5.95, +5.95] (11.90 m total length)
  -Y = Stern (amber bay / claw tips)
  -Z = Ventral, +Z = Dorsal        -> Z in [-1.55, +1.55] (3.10 m total height)
"""

import math
import os
import bpy
import bmesh
from mathutils import Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/openclaw"
RENDER_DIR = os.path.join(OUT_DIR, "renders")
os.makedirs(RENDER_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# Safe Scene Reset & Collection Helpers (never unloads Blender add-ons)
# ---------------------------------------------------------------------------

def reset_scene():
    """Clear scene objects/collections/data safely WITHOUT unloading Blender add-ons."""
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
# Aerospace PBR Materials (Blender 5.3 + AgX + GLB compatible)
# ---------------------------------------------------------------------------

def set_bsdf_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return bsdf.inputs[n]
    return None


def make_pbr_mat(
    name,
    base_color,
    dark_color=None,
    metallic=0.55,
    roughness=0.34,
    noise_scale=22.0,
    patina_scale=3.0,
    patina_amount=0.38,
    rough_var=0.08,
    bump_strength=0.012,
    coat=0.0,
    emission_color=None,
    emission_strength=0.0,
    alpha=1.0,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (620, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (240, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    set_bsdf_input(bsdf, ["Base Color"], (*base_color, 1.0))
    set_bsdf_input(bsdf, ["Metallic"], metallic)
    set_bsdf_input(bsdf, ["Roughness"], roughness)
    if coat > 0.0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)
        set_bsdf_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.14)
    if emission_color is not None and emission_strength > 0.0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)
    if alpha < 0.999:
        set_bsdf_input(bsdf, ["Alpha"], alpha)
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"

    if noise_scale > 0 and (rough_var > 0 or bump_strength > 0 or dark_color is not None):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-880, -60)

        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.location = (-600, -40)
        noise.inputs["Scale"].default_value = noise_scale
        noise.inputs["Detail"].default_value = 7.0
        noise.inputs["Roughness"].default_value = 0.62
        nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])

        if dark_color is not None:
            patina = nt.nodes.new("ShaderNodeTexNoise")
            patina.location = (-600, 220)
            patina.inputs["Scale"].default_value = patina_scale
            patina.inputs["Detail"].default_value = 6.0
            patina.inputs["Roughness"].default_value = 0.68
            nt.links.new(tc.outputs["Object"], patina.inputs["Vector"])

            pmap = nt.nodes.new("ShaderNodeMapRange")
            pmap.location = (-360, 220)
            pmap.inputs["From Min"].default_value = 0.30
            pmap.inputs["From Max"].default_value = 0.72
            pmap.inputs["To Min"].default_value = 0.0
            pmap.inputs["To Max"].default_value = patina_amount
            nt.links.new(patina.outputs["Fac"], pmap.inputs["Value"])

            col_mix = nt.nodes.new("ShaderNodeMix")
            col_mix.data_type = "RGBA"
            col_mix.location = (-100, 200)
            col_mix.inputs["A"].default_value = (*base_color, 1.0)
            col_mix.inputs["B"].default_value = (*dark_color, 1.0)
            nt.links.new(pmap.outputs["Result"], col_mix.inputs["Factor"])
            nt.links.new(col_mix.outputs["Result"], bsdf.inputs["Base Color"])

        if rough_var > 0:
            rmap = nt.nodes.new("ShaderNodeMapRange")
            rmap.location = (-160, 0)
            rmap.inputs["From Min"].default_value = 0.25
            rmap.inputs["From Max"].default_value = 0.75
            rmap.inputs["To Min"].default_value = max(0.06, roughness - rough_var)
            rmap.inputs["To Max"].default_value = min(0.92, roughness + rough_var)
            nt.links.new(noise.outputs["Fac"], rmap.inputs["Value"])
            nt.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])

        if bump_strength > 0:
            bump = nt.nodes.new("ShaderNodeBump")
            bump.location = (-140, -210)
            bump.inputs["Strength"].default_value = bump_strength
            bump.inputs["Distance"].default_value = 0.005
            nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def build_materials():
    return {
        # Weathered aerospace brushed titanium-silver central hull (balanced for both ortho & hero!)
        "hull_silver": make_pbr_mat(
            "Mat_OpenClaw_HullSilver",
            base_color=(0.35, 0.38, 0.43),
            dark_color=(0.14, 0.16, 0.20),
            metallic=0.68,
            roughness=0.31,
            noise_scale=18.0,
            patina_scale=2.2,
            patina_amount=0.44,
            rough_var=0.09,
            bump_strength=0.015,
            coat=0.06,
        ),
        # Slightly brighter machined chamfer/trim titanium for hull bevel ribs & vents
        "hull_trim": make_pbr_mat(
            "Mat_OpenClaw_HullTrim",
            base_color=(0.48, 0.52, 0.58),
            dark_color=(0.24, 0.27, 0.32),
            metallic=0.80,
            roughness=0.25,
            noise_scale=26.0,
            patina_scale=3.6,
            patina_amount=0.28,
            rough_var=0.06,
            bump_strength=0.009,
        ),
        # Deep cool steel-blue gunmetal for underbelly keel armor & side recesses (22.13.26/34.png!)
        "underbelly": make_pbr_mat(
            "Mat_OpenClaw_Underbelly",
            base_color=(0.095, 0.120, 0.160),
            dark_color=(0.036, 0.048, 0.068),
            metallic=0.76,
            roughness=0.35,
            noise_scale=20.0,
            patina_scale=2.5,
            patina_amount=0.38,
            rough_var=0.07,
            bump_strength=0.012,
        ),
        # Forward dorsal matte-satin obsidian charcoal hatch panel (deep black-slate!)
        "dark_panel": make_pbr_mat(
            "Mat_OpenClaw_DarkPanel",
            base_color=(0.018, 0.022, 0.029),
            dark_color=(0.008, 0.010, 0.014),
            metallic=0.26,
            roughness=0.46,
            noise_scale=34.0,
            patina_scale=4.2,
            patina_amount=0.35,
            rough_var=0.06,
            bump_strength=0.009,
        ),
        # Deep anodized blood-crimson metallic red for both C-shaped claw arms (never salmon-pink!)
        "claw_red": make_pbr_mat(
            "Mat_OpenClaw_ClawCrimson",
            base_color=(0.30, 0.016, 0.014),
            dark_color=(0.095, 0.004, 0.004),
            metallic=0.62,
            roughness=0.26,
            noise_scale=20.0,
            patina_scale=2.4,
            patina_amount=0.44,
            rough_var=0.08,
            bump_strength=0.014,
            coat=0.28,
        ),
        # Darker recessed oxblood-maroon for claw mid-seam core & side detents
        "claw_seam": make_pbr_mat(
            "Mat_OpenClaw_ClawSeam",
            base_color=(0.065, 0.004, 0.004),
            dark_color=(0.022, 0.002, 0.002),
            metallic=0.58,
            roughness=0.44,
            noise_scale=28.0,
            rough_var=0.05,
            bump_strength=0.008,
        ),
        # Twin metallic silver-white shoulder stripes on the red claws
        "stripe_white": make_pbr_mat(
            "Mat_OpenClaw_StripeWhite",
            base_color=(0.80, 0.83, 0.87),
            dark_color=(0.60, 0.63, 0.68),
            metallic=0.35,
            roughness=0.28,
            noise_scale=28.0,
            rough_var=0.05,
            bump_strength=0.006,
        ),
        # Dark gunmetal for frames, bay bezels, louvers, and recesses
        "gunmetal": make_pbr_mat(
            "Mat_OpenClaw_Gunmetal",
            base_color=(0.048, 0.054, 0.066),
            dark_color=(0.018, 0.021, 0.028),
            metallic=0.82,
            roughness=0.34,
            noise_scale=30.0,
            rough_var=0.05,
            bump_strength=0.008,
        ),
        # Carbon cavity black for deep slots & panel seam channels
        "cavity_black": make_pbr_mat(
            "Mat_OpenClaw_CavityBlack",
            base_color=(0.008, 0.010, 0.013),
            metallic=0.40,
            roughness=0.58,
            noise_scale=36.0,
            rough_var=0.04,
            bump_strength=0.005,
        ),
        # Deep dark burnished bronze-copper reactor blocks inside the bay (gleams gold under internal amber lights!)
        "reactor_bronze": make_pbr_mat(
            "Mat_OpenClaw_ReactorBronze",
            base_color=(0.48, 0.21, 0.025),
            dark_color=(0.12, 0.042, 0.004),
            metallic=0.86,
            roughness=0.22,
            noise_scale=24.0,
            patina_scale=3.2,
            patina_amount=0.48,
            rough_var=0.07,
            bump_strength=0.010,
        ),
        # Darker shadowed bronze structural housing & floor inside the bay
        "reactor_dark": make_pbr_mat(
            "Mat_OpenClaw_ReactorDark",
            base_color=(0.10, 0.036, 0.005),
            dark_color=(0.025, 0.008, 0.001),
            metallic=0.82,
            roughness=0.32,
            noise_scale=24.0,
            rough_var=0.06,
            bump_strength=0.008,
        ),
        # Deep rich molten-amber interior diffuser plates (saturated orange-gold, never white-clipped!)
        "amber_glow": make_pbr_mat(
            "Mat_OpenClaw_AmberGlow",
            base_color=(0.88, 0.30, 0.010),
            metallic=0.05,
            roughness=0.24,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(1.0, 0.32, 0.008),
            emission_strength=4.2,
        ),
        # Hot concentrated molten gold-amber core accents inside deep valleys
        "amber_hot": make_pbr_mat(
            "Mat_OpenClaw_AmberHot",
            base_color=(1.0, 0.52, 0.04),
            metallic=0.0,
            roughness=0.20,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(1.0, 0.48, 0.025),
            emission_strength=6.8,
        ),
        # Crystal-clear smoked-amber optical glass canopy (zero grazing milkiness, vivid 3/4 visibility!)
        "amber_glass": make_pbr_mat(
            "Mat_OpenClaw_AmberGlass",
            base_color=(0.68, 0.25, 0.012),
            metallic=0.0,
            roughness=0.04,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            coat=0.18,
            alpha=0.16,
        ),
        # Bow vertical icy cyan-white navigation LED light bars
        "led_bow": make_pbr_mat(
            "Mat_OpenClaw_BowLED",
            base_color=(0.82, 0.94, 1.0),
            metallic=0.0,
            roughness=0.12,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.74, 0.92, 1.0),
            emission_strength=10.5,
        ),
        # Subtle warm amber-red marker pip on claw bow outer chamfer
        "led_claw": make_pbr_mat(
            "Mat_OpenClaw_ClawMarker",
            base_color=(1.0, 0.30, 0.10),
            metallic=0.0,
            roughness=0.18,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(1.0, 0.28, 0.08),
            emission_strength=4.5,
        ),
    }


# ---------------------------------------------------------------------------
# Hard-Surface BMesh Helpers
# ---------------------------------------------------------------------------

def finalize_mesh(bm, name, mat, collection, bevel_offset=0.0, bevel_segments=2, smooth=False, parent=None):
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

    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()

    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True

    obj = bpy.data.objects.new(name, mesh)
    if mat is not None:
        obj.data.materials.append(mat)
    link_obj(obj, collection)
    if parent is not None:
        obj.parent = parent
    return obj


def add_beveled_box(name, center, size, mat, col, bevel=0.03, segments=2, rot=(0.0, 0.0, 0.0), parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        b_eff = min(bevel, min(sx, sy, sz) * 0.38)
        if b_eff > 0.002:
            bmesh.ops.bevel(
                bm,
                geom=list(bm.edges),
                offset=b_eff,
                offset_type="OFFSET",
                segments=segments,
                profile=0.5,
                affect="EDGES",
                clamp_overlap=True,
            )
    obj = finalize_mesh(bm, name, mat, col, bevel_offset=0.0, parent=parent)
    obj.location = center
    obj.rotation_euler = rot
    return obj


def add_lofted_rings(name, rings_xyz, mat, col, bevel=0.03, segments=2, cap_bot=True, cap_top=True, parent=None):
    bm = bmesh.new()
    vrings = [[bm.verts.new(tuple(p)) for p in ring] for ring in rings_xyz]
    n = len(vrings[0])
    for r in range(len(vrings) - 1):
        r0, r1 = vrings[r], vrings[r + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if cap_bot:
        bm.faces.new(vrings[0][::-1])
    if cap_top:
        bm.faces.new(vrings[-1])
    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, parent=parent)


def make_chamfer_rect(x0, x1, y0, y1, ch_f, ch_a=None):
    if ch_a is None:
        ch_a = ch_f
    cxf, cyf = (ch_f, ch_f) if isinstance(ch_f, (int, float)) else ch_f
    cxa, cya = (ch_a, ch_a) if isinstance(ch_a, (int, float)) else ch_a
    return [
        (x0 + cxa, y0),
        (x1 - cxa, y0),
        (x1, y0 + cya),
        (x1, y1 - cyf),
        (x1 - cxf, y1),
        (x0 + cxf, y1),
        (x0, y1 - cyf),
        (x0, y0 + cya),
    ]


def inset_polygon_2d(pts, dist):
    n = len(pts)
    out = []
    for i in range(n):
        p_prev = Vector(pts[(i - 1) % n])
        p_curr = Vector(pts[i])
        p_next = Vector(pts[(i + 1) % n])
        e1 = (p_curr - p_prev).normalized()
        e2 = (p_next - p_curr).normalized()
        n1 = Vector((-e1.y, e1.x))
        n2 = Vector((-e2.y, e2.x))
        bis = n1 + n2
        if bis.length < 1e-6:
            offset = n1 * dist
        else:
            bis.normalize()
            denom = max(0.35, bis.dot(n1))
            offset = bis * (dist / denom)
        p_new = p_curr + offset
        out.append((p_new.x, p_new.y))
    return out


def add_hollow_ring_loft(name, outer_rings, inner_rings, mat, col, bevel=0.02, segments=2, parent=None):
    bm = bmesh.new()
    vo = [[bm.verts.new(tuple(p)) for p in r] for r in outer_rings]
    vi = [[bm.verts.new(tuple(p)) for p in r] for r in inner_rings]
    k = len(vo)
    n = len(vo[0])

    for s in range(k - 1):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((vo[s][i], vo[s][j], vo[s + 1][j], vo[s + 1][i]))
    for s in range(k - 1):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((vi[s][j], vi[s][i], vi[s + 1][i], vi[s + 1][j]))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((vo[0][j], vo[0][i], vi[0][i], vi[0][j]))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((vo[-1][i], vo[-1][j], vi[-1][j], vi[-1][i]))

    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, parent=parent)


def add_trapezoid_prism_y(name, y0, y1, w_bot, w_top, z_bot, z_top, mat, col, bevel=0.012, parent=None):
    """Build a trapezoidal prism extruded along Y (used for the exact stern exhaust slot in 22.13.34.png!)."""
    ring0 = [
        (-w_bot * 0.5, y0, z_bot),
        (w_bot * 0.5, y0, z_bot),
        (w_top * 0.5, y0, z_top),
        (-w_top * 0.5, y0, z_top),
    ]
    ring1 = [
        (-w_bot * 0.5, y1, z_bot),
        (w_bot * 0.5, y1, z_bot),
        (w_top * 0.5, y1, z_top),
        (-w_top * 0.5, y1, z_top),
    ]
    return add_lofted_rings(name, [ring0, ring1], mat, col, bevel=bevel, segments=2, parent=parent)


# ---------------------------------------------------------------------------
# 1. CENTRAL ARMORED HULL, UNDERBELLY KEEL & DORSAL DECK (With Real Bay Well!)
# ---------------------------------------------------------------------------

def build_central_hull(mats, col, root):
    hull_full = make_chamfer_rect(-4.50, 4.50, -5.09, 5.95, ch_f=(1.18, 0.80), ch_a=(1.26, 1.16))
    hull_top_inner = inset_polygon_2d(hull_full, 0.30)

    # --- A. LOWER ARMORED UNDERBELLY KEEL (Z: -1.55 -> -0.56) ---
    # Clean linear planar taper matching Side View (22.13.26.png) & End View (22.13.34.png)
    keel_bot = make_chamfer_rect(-3.78, 3.78, -3.77, 3.90, ch_f=(0.82, 0.65), ch_a=(0.88, 0.78))
    keel_top = make_chamfer_rect(-4.48, 4.48, -5.07, 5.93, ch_f=(1.17, 0.79), ch_a=(1.25, 1.15))

    add_lofted_rings(
        "Hull_Underbelly_Keel",
        [
            [(x, y, -1.55) for x, y in keel_bot],
            [(x, y, -0.56) for x, y in keel_top],
        ],
        mats["underbelly"],
        col,
        bevel=0.04,
        segments=2,
        parent=root,
    )

    # Flush underbelly side armor bays & titanium ribs on the planar sloped keel face!
    keel_slope = math.atan2(4.48 - 3.78, 1.55 - 0.56)
    for sx in (-1.0, 1.0):
        bay_specs = [
            (2.22, 2.08),   # Fore underbelly bay
            (-0.22, 2.05),  # Mid underbelly bay
            (-2.45, 1.72),  # Aft underbelly bay
        ]
        for idx, (yc, ylen) in enumerate(bay_specs):
            add_beveled_box(
                f"Hull_KeelBay_{'L' if sx < 0 else 'R'}_{idx}",
                (sx * 4.145, yc, -1.055),
                (0.08, ylen, 0.80),
                mats["cavity_black"],
                col,
                bevel=0.015,
                rot=(0.0, sx * keel_slope, 0.0),
                parent=root,
            )
        for r_idx, yr in enumerate((3.42, 0.98, -1.42, -3.48)):
            add_beveled_box(
                f"Hull_KeelRib_{'L' if sx < 0 else 'R'}_{r_idx}",
                (sx * 4.155, yr, -1.055),
                (0.11, 0.24, 0.92),
                mats["hull_silver"],
                col,
                bevel=0.02,
                rot=(0.0, sx * keel_slope, 0.0),
                parent=root,
            )

    # --- B. SOLID MID-HULL LOWER BAND (Z: -0.58 -> +0.62) ---
    hull_seam_in = inset_polygon_2d(hull_full, 0.045)
    add_lofted_rings(
        "Hull_MidBody_Lower",
        [
            [(x, y, -0.58) for x, y in hull_full],
            [(x, y, 0.14) for x, y in hull_full],
            [(x, y, 0.17) for x, y in hull_seam_in],
            [(x, y, 0.20) for x, y in hull_full],
            [(x, y, 0.62) for x, y in hull_full],
        ],
        mats["hull_silver"],
        col,
        bevel=0.024,
        segments=2,
        parent=root,
    )

    # Subtle recessed cool-slate upper flank channel above the claw line (seen in 22.13.26.png!)
    for sx in (-1.0, 1.0):
        add_beveled_box(
            f"Hull_UpperFlankRecess_{'L' if sx < 0 else 'R'}",
            (sx * 4.48, 0.45, 1.15),
            (0.08, 7.60, 0.24),
            mats["underbelly"],
            col,
            bevel=0.012,
            parent=root,
        )

    # --- C. WATERTIGHT UPPER DORSAL SHELL WITH REAL DEEP AMBER BAY CAVITY (Z: +0.60 -> +1.55) ---
    bay_outer_lip = make_chamfer_rect(-3.72, 3.72, -2.22, -0.38, ch_f=0.40, ch_a=0.40)
    bay_inner_wall = inset_polygon_2d(bay_outer_lip, 0.18)

    outer_rings = [
        [(x, y, 0.60) for x, y in hull_full],
        [(x, y, 1.30) for x, y in hull_full],
        [(x, y, 1.55) for x, y in hull_top_inner],
    ]
    inner_rings = [
        [(x, y, 0.60) for x, y in bay_inner_wall],
        [(x, y, 1.36) for x, y in bay_inner_wall],
        [(x, y, 1.55) for x, y in bay_outer_lip],
    ]
    add_hollow_ring_loft(
        "Hull_UpperDeck_MainShell",
        outer_rings,
        inner_rings,
        mats["hull_silver"],
        col,
        bevel=0.022,
        segments=2,
        parent=root,
    )

    # --- D. FLUSH DORSAL ARMOR PANEL LINES & SUBTLE WAIST SEAM (22.13.19.png!) ---
    # Subtle flush dark panel groove lines (never poking out beyond hull perimeter!)
    seam_bars = [
        # Transverse waist separation groove (flush inside hull width, matching 22.13.19.png!)
        ("Seam_Waist_Main", (0.0, 0.10, 1.546), (8.42, 0.095, 0.022), 0.0),
        ("Seam_Waist_Fore", (0.0, 0.28, 1.546), (8.34, 0.038, 0.020), 0.0),
        # Longitudinal flank panel lines
        ("Seam_Long_L", (-3.58, 0.44, 1.546), (0.042, 9.52, 0.020), 0.0),
        ("Seam_Long_R", (3.58, 0.44, 1.546), (0.042, 9.52, 0.020), 0.0),
        # Inner upper box framing lines around dark panel & vent
        ("Seam_MidLong_L", (-3.28, 1.65, 1.546), (0.034, 2.86, 0.018), 0.0),
        ("Seam_MidLong_R", (3.28, 1.65, 1.546), (0.034, 2.86, 0.018), 0.0),
        # Transverse deck panel seams
        ("Seam_Trans_Bow", (0.0, 5.10, 1.546), (6.92, 0.040, 0.020), 0.0),
        ("Seam_Trans_PrePanel", (0.0, 2.68, 1.546), (6.56, 0.036, 0.018), 0.0),
        ("Seam_Trans_PostBay", (0.0, -2.92, 1.546), (8.26, 0.040, 0.020), 0.0),
        ("Seam_Trans_Stern", (0.0, -4.46, 1.546), (6.36, 0.038, 0.020), 0.0),
        # Aft longitudinal panel dividers
        ("Seam_SternDiv_L", (-1.85, -3.68, 1.546), (0.034, 1.50, 0.018), 0.0),
        ("Seam_SternDiv_R", (1.85, -3.68, 1.546), (0.034, 1.50, 0.018), 0.0),
        # Corner diagonal panel miter seams on the 4 chamfered corners
        ("Seam_Diag_FL", (-3.76, 5.26, 1.48), (0.82, 0.038, 0.022), 0.65),
        ("Seam_Diag_FR", (3.76, 5.26, 1.48), (0.82, 0.038, 0.022), -0.65),
        ("Seam_Diag_AL", (-3.68, -4.34, 1.48), (0.90, 0.038, 0.022), -0.76),
        ("Seam_Diag_AR", (3.68, -4.34, 1.48), (0.90, 0.038, 0.022), 0.76),
    ]
    for sname, loc, sz, rz in seam_bars:
        add_beveled_box(sname, loc, sz, mats["cavity_black"], col, bevel=0.004, rot=(0.0, 0.0, rz), parent=root)

    # Flush vertical flank seams & mechanical hatches on +/-X hull flanks (openclaw.png & 22.13.26.png!)
    for sx in (-1.0, 1.0):
        for idx, ys in enumerate((3.10, 0.10, -2.65)):
            add_beveled_box(
                f"Hull_SideSeam_{'L' if sx < 0 else 'R'}_{idx}",
                (sx * 4.495, ys, 0.42),
                (0.03, 0.042, 1.84),
                mats["cavity_black"],
                col,
                bevel=0.004,
                parent=root,
            )
        # Mechanical access bay flush on the aft hull flank (visible in hero openclaw.png!)
        add_beveled_box(
            f"Hull_FlankHatch_Frame_{'L' if sx < 0 else 'R'}",
            (sx * 4.48, -2.08, 0.38),
            (0.07, 1.28, 0.72),
            mats["gunmetal"],
            col,
            bevel=0.012,
            parent=root,
        )
        add_beveled_box(
            f"Hull_FlankHatch_Recess_{'L' if sx < 0 else 'R'}",
            (sx * 4.49, -2.08, 0.38),
            (0.06, 1.02, 0.48),
            mats["cavity_black"],
            col,
            bevel=0.008,
            parent=root,
        )
        add_beveled_box(
            f"Hull_FlankPort_{'L' if sx < 0 else 'R'}",
            (sx * 4.485, -3.26, 0.62),
            (0.07, 0.40, 0.44),
            mats["cavity_black"],
            col,
            bevel=0.01,
            parent=root,
        )

    # --- E. STERN (-Y) TRAPEZOIDAL HORIZONTAL RECESSED EXHAUST SLOT (Exact match to 22.13.34.png!) ---
    # Flush with -Y wall (Y=-5.09) so nothing pokes out in Top Ortho!
    add_trapezoid_prism_y(
        "Hull_SternSlot_Frame",
        y0=-5.102, y1=-4.95,
        w_bot=5.26, w_top=4.68,
        z_bot=-0.50, z_top=-0.04,
        mat=mats["gunmetal"],
        col=col,
        bevel=0.018,
        parent=root,
    )
    add_trapezoid_prism_y(
        "Hull_SternSlot_Cavity",
        y0=-5.110, y1=-4.96,
        w_bot=4.84, w_top=4.36,
        z_bot=-0.43, z_top=-0.12,
        mat=mats["cavity_black"],
        col=col,
        bevel=0.008,
        parent=root,
    )
    # Crisp thin metallic lower lip inside the stern slot (22.13.34.png!)
    add_beveled_box(
        "Hull_SternSlot_Lip",
        (0.0, -5.098, -0.44),
        (4.82, 0.04, 0.05),
        mats["hull_trim"],
        col,
        bevel=0.008,
        parent=root,
    )
    for sx in (-1.0, 1.0):
        add_beveled_box(
            f"Hull_SternFace_VertSeam_{'L' if sx < 0 else 'R'}",
            (sx * 2.95, -5.088, 0.36),
            (0.042, 0.026, 1.88),
            mats["cavity_black"],
            col,
            bevel=0.004,
            parent=root,
        )

    # --- F. BOW (+Y) TRAPEZOIDAL DOCKING SLOT & FLUSH VERTICAL CYAN-WHITE LED STRIPS (openclaw.png!) ---
    add_trapezoid_prism_y(
        "Hull_BowSlot_Frame",
        y0=5.80, y1=5.962,
        w_bot=4.92, w_top=4.44,
        z_bot=-0.52, z_top=-0.14,
        mat=mats["gunmetal"],
        col=col,
        bevel=0.016,
        parent=root,
    )
    add_trapezoid_prism_y(
        "Hull_BowSlot_Cavity",
        y0=5.82, y1=5.970,
        w_bot=4.56, w_top=4.14,
        z_bot=-0.46, z_top=-0.20,
        mat=mats["cavity_black"],
        col=col,
        bevel=0.008,
        parent=root,
    )
    # Two vertical glowing cyan-white LED strips sitting FLUSH inside the +Y chamfered corner faces!
    # Chamfer plane midpoint = (+/-3.91, +5.55), outward normal = (+/-0.561, +0.828).
    # Embed bezel slightly inside (-0.04m along normal) so it NEVER protrudes in Top/Side Ortho!
    chamfer_angle = math.atan2(0.80, 1.18)
    for sx in (-1.0, 1.0):
        rot_z = -sx * chamfer_angle
        nx, ny = sx * 0.561, 0.828
        bx, by = sx * 3.91 - nx * 0.035, 5.55 - ny * 0.035
        lx, ly = sx * 3.91 - nx * 0.002, 5.55 - ny * 0.002
        add_beveled_box(
            f"Hull_BowLED_Bezel_{'L' if sx < 0 else 'R'}",
            (bx, by, 0.34),
            (0.24, 0.09, 1.24),
            mats["gunmetal"],
            col,
            bevel=0.014,
            rot=(0.0, 0.0, rot_z),
            parent=root,
        )
        add_beveled_box(
            f"Hull_BowLED_BarTop_{'L' if sx < 0 else 'R'}",
            (lx, ly, 0.64),
            (0.12, 0.04, 0.54),
            mats["led_bow"],
            col,
            bevel=0.01,
            rot=(0.0, 0.0, rot_z),
            parent=root,
        )
        add_beveled_box(
            f"Hull_BowLED_BarBot_{'L' if sx < 0 else 'R'}",
            (lx, ly, 0.04),
            (0.12, 0.04, 0.54),
            mats["led_bow"],
            col,
            bevel=0.01,
            rot=(0.0, 0.0, rot_z),
            parent=root,
        )


# ---------------------------------------------------------------------------
# 2. DORSAL DECK FEATURES: DARK PANEL, PORT LOUVER VENT & AFT MICRO-GREEBLES
# ---------------------------------------------------------------------------

def build_dorsal_features(mats, col, root):
    # --- A. FORWARD OBSIDIAN RECESSED HATCH PANEL (Flush w/ dark chamfer surround!) ---
    dp_outer = make_chamfer_rect(-3.26, 3.26, 2.82, 4.80, ch_f=0.38, ch_a=0.38)
    dp_inner = make_chamfer_rect(-3.12, 3.12, 2.92, 4.70, ch_f=0.32, ch_a=0.32)
    add_hollow_ring_loft(
        "Deck_DarkPanel_Bezel",
        [
            [(x, y, 1.52) for x, y in dp_outer],
            [(x, y, 1.562) for x, y in dp_outer],
            [(x, y, 1.568) for x, y in inset_polygon_2d(dp_outer, 0.03)],
        ],
        [
            [(x, y, 1.52) for x, y in dp_inner],
            [(x, y, 1.550) for x, y in dp_inner],
            [(x, y, 1.568) for x, y in dp_inner],
        ],
        mats["gunmetal"],
        col,
        bevel=0.008,
        segments=2,
        parent=root,
    )
    dp_slab = make_chamfer_rect(-3.13, 3.13, 2.91, 4.71, ch_f=0.32, ch_a=0.32)
    add_lofted_rings(
        "Deck_DarkPanel_Surface",
        [
            [(x, y, 1.48) for x, y in dp_slab],
            [(x, y, 1.556) for x, y in dp_slab],
            [(x, y, 1.562) for x, y in inset_polygon_2d(dp_slab, 0.03)],
        ],
        mats["dark_panel"],
        col,
        bevel=0.006,
        segments=2,
        parent=root,
    )
    # Subtle micro-grid seam grooves across dark panel (visible closely in 22.13.19.png!)
    add_beveled_box(
        "Deck_DarkPanel_TopLatch",
        (0.0, 4.86, 1.562),
        (0.66, 0.13, 0.036),
        mats["hull_trim"],
        col,
        bevel=0.008,
        parent=root,
    )

    # --- B. PORT-SIDE (-X) VERTICAL LOUVERED VENT GRILLE (22.13.19.png & openclaw.png!) ---
    vx, vy = -2.38, 1.16
    add_beveled_box(
        "Deck_VentGrille_Frame",
        (vx, vy, 1.548),
        (0.66, 1.48, 0.048),
        mats["gunmetal"],
        col,
        bevel=0.01,
        parent=root,
    )
    add_beveled_box(
        "Deck_VentGrille_Cavity",
        (vx, vy, 1.560),
        (0.52, 1.32, 0.035),
        mats["cavity_black"],
        col,
        bevel=0.004,
        parent=root,
    )
    bm = bmesh.new()
    n_slats = 8
    for i in range(n_slats):
        y_pos = (vy - 0.56) + i * (1.12 / (n_slats - 1))
        m = (
            Matrix.Translation((vx, y_pos, 1.574))
            @ Matrix.Rotation(0.28, 4, "X")
            @ Matrix.Diagonal((0.49, 0.064, 0.024, 1.0))
        )
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    finalize_mesh(bm, "Deck_VentGrille_Slats", mats["hull_trim"], col, bevel_offset=0.004, parent=root)

    # Subtle starboard service notch opposite the vent
    add_beveled_box(
        "Deck_Stbd_ServiceNotch",
        (2.86, 0.62, 1.554),
        (0.09, 0.50, 0.028),
        mats["gunmetal"],
        col,
        bevel=0.006,
        parent=root,
    )

    # --- C. STERN AFT DECK MICRO-GREEBLES (22.13.19.png bottom of hull!) ---
    greebles = [
        ("Deck_SternGreeble_1", (-2.25, -4.22, 1.562), (0.34, 0.22, 0.040)),
        ("Deck_SternGreeble_2", (-1.82, -4.28, 1.558), (0.20, 0.16, 0.034)),
        ("Deck_SternGreeble_3", (-0.38, -4.28, 1.558), (0.46, 0.17, 0.036)),
        ("Deck_SternGreeble_4", (0.25, -4.26, 1.562), (0.20, 0.20, 0.040)),
        ("Deck_SternGreeble_5", (0.88, -4.24, 1.562), (0.18, 0.26, 0.040)),
        ("Deck_SternGreeble_6", (2.30, -4.24, 1.562), (0.40, 0.22, 0.040)),
    ]
    for gname, gloc, gsz in greebles:
        add_beveled_box(gname, gloc, gsz, mats["hull_trim"], col, bevel=0.008, parent=root)


# ---------------------------------------------------------------------------
# 3. GLOWING MOLTEN-AMBER REACTOR BAY (Rich Layered Architecture + Smoked Amber Glass!)
# ---------------------------------------------------------------------------

def build_amber_reactor_bay(mats, col, root):
    """Build the iconic aft dorsal glowing molten-amber reactor bay (X:[-3.72,+3.72], Y:[-2.22,-0.38]):
      - Flush dark gunmetal beveled chamfer bezel frame
      - Deep dark-bronze bay floor with recessed molten-amber glowing light valleys (NO pale washout!)
      - Asymmetric multi-height industrial bronze reactor monoliths, recessed vertical glowing baffles,
        structural cross-ribs, and golden light slots matching 22.13.19.png & ref_image/openclaw.png!
      - Smoked-amber translucent beveled optical glass canopy.
    """
    # --- A. FLUSH DARK OCTAGONAL BAY BEZEL FRAME ---
    bezel_out = make_chamfer_rect(-3.82, 3.82, -2.30, -0.30, ch_f=0.44, ch_a=0.44)
    bezel_in = make_chamfer_rect(-3.52, 3.52, -2.06, -0.54, ch_f=0.30, ch_a=0.30)
    add_hollow_ring_loft(
        "AmberBay_OuterBezel",
        [
            [(x, y, 1.46) for x, y in bezel_out],
            [(x, y, 1.564) for x, y in bezel_out],
            [(x, y, 1.572) for x, y in inset_polygon_2d(bezel_out, 0.06)],
        ],
        [
            [(x, y, 1.24) for x, y in bezel_in],
            [(x, y, 1.46) for x, y in bezel_in],
            [(x, y, 1.572) for x, y in inset_polygon_2d(bezel_in, -0.05)],
        ],
        mats["gunmetal"],
        col,
        bevel=0.01,
        segments=2,
        parent=root,
    )

    # --- B. DEEP SHADOWED BAY FLOOR + CONCENTRATED MOLTEN-AMBER GLOW VALLEYS ---
    bay_floor_poly = make_chamfer_rect(-3.55, 3.55, -2.08, -0.52, ch_f=0.30, ch_a=0.30)
    add_lofted_rings(
        "AmberBay_DarkFloor",
        [
            [(x, y, 0.62) for x, y in bay_floor_poly],
            [(x, y, 0.72) for x, y in bay_floor_poly],
        ],
        mats["reactor_dark"],
        col,
        bevel=0.01,
        parent=root,
    )

    # Recessed glowing molten-amber light channels nestled in the deep floor valleys
    bm_glow = bmesh.new()
    bm_hot = bmesh.new()
    bm_bronze = bmesh.new()
    bm_dark = bmesh.new()

    def add_bm_box(bm, cx, cy, cz, sx, sy, sz):
        m = Matrix.Translation((cx, cy, cz)) @ Matrix.Diagonal((sx, sy, sz, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)

    # Longitudinal glowing molten-amber troughs deep in the bay floor (between structural columns!)
    for y_trough in (-1.68, -1.30, -0.92):
        add_bm_box(bm_glow, 0.0, y_trough, 0.76, 6.20, 0.16, 0.06)

    # Asymmetric multi-scale reactor monoliths matching the layered glowing amber machinery in 22.13.19.png!
    # Columns have varied widths, depths, heights, and hot-amber backlit slots between them
    col_specs = [
        # (xc, width, [(y_center, y_len, height, has_hot_edge), ...])
        (-3.04, 0.52, [(-1.66, 0.58, 0.44, False), (-0.98, 0.62, 0.52, True)]),
        (-2.36, 0.64, [(-1.74, 0.42, 0.58, True),  (-1.26, 0.46, 0.40, True),  (-0.82, 0.36, 0.54, False)]),
        (-1.64, 0.56, [(-1.58, 0.68, 0.48, True),  (-0.92, 0.54, 0.62, True)]),
        (-0.96, 0.62, [(-1.76, 0.38, 0.52, False), (-1.28, 0.50, 0.64, True),  (-0.80, 0.38, 0.46, True)]),
        (-0.24, 0.66, [(-1.62, 0.56, 0.60, True),  (-1.00, 0.58, 0.50, True)]),
        (0.48,  0.58, [(-1.74, 0.44, 0.46, True),  (-1.26, 0.46, 0.62, True),  (-0.80, 0.38, 0.56, True)]),
        (1.18,  0.64, [(-1.56, 0.66, 0.58, True),  (-0.92, 0.52, 0.48, False)]),
        (1.88,  0.56, [(-1.74, 0.42, 0.52, True),  (-1.26, 0.48, 0.44, True),  (-0.82, 0.38, 0.60, True)]),
        (2.54,  0.58, [(-1.64, 0.58, 0.56, True),  (-0.96, 0.56, 0.46, True)]),
        (3.12,  0.42, [(-1.56, 0.52, 0.42, False), (-1.02, 0.48, 0.48, False)]),
    ]

    for c_idx, (xc, cw, blocks) in enumerate(col_specs):
        for b_idx, (yc, yd, ch, hot) in enumerate(blocks):
            # Main dark burnished bronze monolith
            add_bm_box(bm_bronze, xc, yc, 0.72 + ch * 0.5, cw * 0.84, yd * 0.86, ch)
            # Stepped top mechanical cap (adds crisp architectural silhouette under glass!)
            cap_x = xc + (0.05 if (c_idx + b_idx) % 2 == 0 else -0.05)
            add_bm_box(bm_dark, cap_x, yc, 0.72 + ch + 0.045, cw * 0.54, yd * 0.56, 0.09)
            # Soft molten-amber under-glow pads tucked deeply at the base of key monoliths (illuminates bronze faces naturally!)
            if hot:
                add_bm_box(bm_hot, xc + cw * 0.42, yc, 0.80, 0.08, yd * 0.54, 0.14)
                add_bm_box(bm_glow, xc, yc + yd * 0.44, 0.78, cw * 0.64, 0.08, 0.10)

        # Tall dark-bronze vertical structural rib between columns (iconic vertical striations in 22.13.19.png!)
        if c_idx < len(col_specs) - 1:
            x_next = col_specs[c_idx + 1][0]
            x_rib = (xc + x_next) * 0.5
            add_bm_box(bm_dark, x_rib, -1.30, 1.06, 0.055, 1.48, 0.68)
            # Thin gleaming bronze top edge along the rib
            add_bm_box(bm_bronze, x_rib, -1.30, 1.38, 0.068, 1.44, 0.045)

    # Transverse recessed structural bus bars crossing the interior
    for y_rail in (-1.54, -1.04):
        add_bm_box(bm_dark, 0.0, y_rail, 1.18, 6.72, 0.055, 0.18)
        add_bm_box(bm_bronze, 0.0, y_rail, 1.29, 6.68, 0.068, 0.05)

    # Perimeter inner bay wall dark cooling fins + warm amber under-glow
    for sx in (-1.0, 1.0):
        add_bm_box(bm_dark, sx * 3.38, -1.30, 1.08, 0.14, 1.16, 0.66)
        add_bm_box(bm_glow, sx * 3.28, -1.30, 0.88, 0.05, 0.96, 0.20)

    finalize_mesh(bm_bronze, "AmberBay_ReactorBlocks", mats["reactor_bronze"], col, bevel_offset=0.010, bevel_segments=1, parent=root)
    finalize_mesh(bm_dark, "AmberBay_StructMullions", mats["reactor_dark"], col, bevel_offset=0.006, bevel_segments=1, parent=root)
    finalize_mesh(bm_glow, "AmberBay_GlowTroughs", mats["amber_glow"], col, bevel_offset=0.004, bevel_segments=1, parent=root)
    finalize_mesh(bm_hot, "AmberBay_HotCores", mats["amber_hot"], col, bevel_offset=0.004, bevel_segments=1, parent=root)

    # --- C. RECESSED SMOKED-AMBER BEVELED OPTICAL GLASS CANOPY ---
    glass_poly = make_chamfer_rect(-3.54, 3.54, -2.08, -0.52, ch_f=0.31, ch_a=0.31)
    glass_top = inset_polygon_2d(glass_poly, 0.05)
    add_lofted_rings(
        "AmberBay_GlassCanopy",
        [
            [(x, y, 1.46) for x, y in glass_poly],
            [(x, y, 1.515) for x, y in glass_poly],
            [(x, y, 1.535) for x, y in glass_top],
        ],
        mats["amber_glass"],
        col,
        bevel=0.006,
        segments=1,
        parent=root,
    )

    # Warm saturated molten-amber interior lighting array (illuminates golden bronze monoliths richly from inside!)
    ldata = bpy.data.lights.new(name="AmberBay_InternalLight", type="AREA")
    ldata.shape = "RECTANGLE"
    ldata.size = 6.2
    ldata.size_y = 1.2
    ldata.energy = 680.0
    ldata.color = (1.0, 0.42, 0.03)
    lobj = bpy.data.objects.new("AmberBay_InternalLight", ldata)
    lobj.location = (0.0, -1.30, 1.42)
    lobj.rotation_euler = (0.0, 0.0, 0.0)
    link_obj(lobj, col)
    lobj.parent = root

    for p_idx, (px, py, pe) in enumerate(((-2.2, -1.35, 320.0), (0.0, -1.25, 420.0), (2.2, -1.35, 320.0))):
        pdata = bpy.data.lights.new(name=f"AmberBay_CorePoint_{p_idx}", type="POINT")
        pdata.energy = pe
        pdata.color = (1.0, 0.48, 0.04)
        pdata.shadow_soft_size = 0.35
        pobj = bpy.data.objects.new(f"AmberBay_CorePoint_{p_idx}", pdata)
        pobj.location = (px, py, 1.18)
        link_obj(pobj, col)
        pobj.parent = root


# ---------------------------------------------------------------------------
# 4. SYMMETRIC CRIMSON-RED C-SHAPED CLAW ARMS (Port -X & Starboard +X)
# ---------------------------------------------------------------------------

def build_claw_half_shell(name, side, z0, z1, bevel_top, bevel_bot, mat, col, parent):
    """Build ONE clean monolithic upper or lower half-shell of a C-shaped claw arm.
    Uses 6 matched outer/inner stations -> 100% pure convex quads with ZERO concave n-gons!
    """
    outer_pts = [
        (-4.22, 5.17),
        (-7.52, 5.17),
        (-9.00, 3.83),
        (-9.00, -4.60),
        (-7.63, -5.95),
        (-5.25, -5.95),
    ]
    inner_pts = [
        (-4.22, 1.75),
        (-6.97, 1.75),
        (-7.07, 1.65),
        (-7.07, -4.29),
        (-6.97, -4.39),
        (-5.25, -4.39),
    ]

    poly_ccw = outer_pts + inner_pts[::-1]
    if side > 0:
        poly_ccw = [(-x, y) for x, y in poly_ccw][::-1]

    p_bot_in = inset_polygon_2d(poly_ccw, bevel_bot) if bevel_bot > 0 else poly_ccw
    p_top_in = inset_polygon_2d(poly_ccw, bevel_top) if bevel_top > 0 else poly_ccw

    def clamp_root(in_loop, orig_loop):
        return [(ox, iy) if abs(ox) < 4.35 else (ix, iy) for (ix, iy), (ox, oy) in zip(in_loop, orig_loop)]

    p_bot_in = clamp_root(p_bot_in, poly_ccw)
    p_top_in = clamp_root(p_top_in, poly_ccw)

    levels = [
        (z0, p_bot_in),
        (z0 + bevel_bot, poly_ccw),
        (z1 - bevel_top, poly_ccw),
        (z1, p_top_in),
    ]

    bm = bmesh.new()
    vrings = [[bm.verts.new((x, y, z)) for (x, y) in loop] for (z, loop) in levels]

    n = 12
    for r in range(len(vrings) - 1):
        r0, r1 = vrings[r], vrings[r + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))

    def cap_strip(ring, flip=False):
        if side < 0:
            o = ring[:6]
            inn = ring[6:][::-1]
        else:
            rev = ring[::-1]
            o = rev[:6]
            inn = rev[6:][::-1]
        for k in range(5):
            quad = (o[k], o[k + 1], inn[k + 1], inn[k])
            if (side > 0) ^ flip:
                quad = quad[::-1]
            bm.faces.new(quad)

    cap_strip(vrings[0], flip=True)
    cap_strip(vrings[-1], flip=False)

    return finalize_mesh(bm, name, mat, col, bevel_offset=0.014, bevel_segments=2, parent=parent)


def build_crimson_claws(mats, col, root):
    for side in (-1.0, 1.0):
        tag = "Port" if side < 0 else "Stbd"

        # 1. Upper Armor Half-Shell (Z: +0.435 -> +1.14, razor-crisp horizontal split seam!)
        build_claw_half_shell(
            f"Claw_{tag}_UpperShell",
            side,
            z0=0.435,
            z1=1.14,
            bevel_top=0.12,
            bevel_bot=0.032,
            mat=mats["claw_red"],
            col=col,
            parent=root,
        )

        # 2. Lower Armor Half-Shell (Z: -0.30 -> +0.405)
        build_claw_half_shell(
            f"Claw_{tag}_LowerShell",
            side,
            z0=-0.30,
            z1=0.405,
            bevel_top=0.032,
            bevel_bot=0.12,
            mat=mats["claw_red"],
            col=col,
            parent=root,
        )

        # 3. Recessed Horizontal Mid-Seam Core Spine (Z: +0.37 -> +0.47, inset 0.08m inside outer walls!)
        outer_pts = [
            (-4.22, 5.10), (-7.48, 5.10), (-8.92, 3.80),
            (-8.92, -4.56), (-7.59, -5.88), (-5.32, -5.88),
        ]
        inner_pts = [
            (-4.22, 1.82), (-7.04, 1.82), (-7.14, 1.72),
            (-7.14, -4.22), (-7.04, -4.32), (-5.32, -4.32),
        ]
        bm_core = bmesh.new()
        o_pts = outer_pts if side < 0 else [(-x, y) for x, y in outer_pts]
        i_pts = inner_pts if side < 0 else [(-x, y) for x, y in inner_pts]
        vo_b = [bm_core.verts.new((x, y, 0.37)) for x, y in o_pts]
        vo_t = [bm_core.verts.new((x, y, 0.47)) for x, y in o_pts]
        vi_b = [bm_core.verts.new((x, y, 0.37)) for x, y in i_pts]
        vi_t = [bm_core.verts.new((x, y, 0.47)) for x, y in i_pts]
        for k in range(5):
            f1 = (vo_b[k], vo_b[k + 1], vo_t[k + 1], vo_t[k])
            f2 = (vi_b[k + 1], vi_b[k], vi_t[k], vi_t[k + 1])
            if side > 0:
                f1 = f1[::-1]
                f2 = f2[::-1]
            bm_core.faces.new(f1)
            bm_core.faces.new(f2)
        f_end = (vo_b[5], vi_b[5], vi_t[5], vo_t[5])
        if side > 0:
            f_end = f_end[::-1]
        bm_core.faces.new(f_end)
        finalize_mesh(bm_core, f"Claw_{tag}_MidSeamCore", mats["claw_seam"], col, bevel_offset=0.0, parent=root)

        # 4. Recessed Hull-Root Mounting Collar (dark shadow ring where claw joins hull!)
        add_beveled_box(
            f"Claw_{tag}_RootCollar",
            (side * 4.51, 3.46, 0.42),
            (0.10, 3.46, 1.46),
            mats["gunmetal"],
            col,
            bevel=0.018,
            parent=root,
        )
        # Subtle recessed dark shadow strip along inner root aft wall (makes gap pop cleanly in End View 22.13.34!)
        add_beveled_box(
            f"Claw_{tag}_RootAftShadow",
            (side * 5.05, 1.755, 0.42),
            (1.10, 0.05, 1.12),
            mats["claw_seam"],
            col,
            bevel=0.01,
            parent=root,
        )

        # 5. Twin Parallel Metallic Silver-White Shoulder Stripes on Top (22.13.19.png & openclaw.png!)
        for s_idx, x_abs in enumerate((8.48, 8.66)):
            add_beveled_box(
                f"Claw_{tag}_Stripe_{s_idx}",
                (side * x_abs, 2.96, 1.144),
                (0.080, 1.30, 0.014),
                mats["stripe_white"],
                col,
                bevel=0.003,
                parent=root,
            )

        # 6. Crisp Recessed Square Side Detent Notches on Outer Corner Elbows (22.13.26.png & 22.13.34.png!)
        for n_idx, y_notch in enumerate((3.62, -4.38)):
            add_beveled_box(
                f"Claw_{tag}_SideDetentFrame_{n_idx}",
                (side * 8.975, y_notch, 0.42),
                (0.08, 0.30, 0.30),
                mats["claw_seam"],
                col,
                bevel=0.012,
                parent=root,
            )
            add_beveled_box(
                f"Claw_{tag}_SideDetentCavity_{n_idx}",
                (side * 8.995, y_notch, 0.42),
                (0.05, 0.18, 0.18),
                mats["cavity_black"],
                col,
                bevel=0.005,
                parent=root,
            )
        # Matching recessed square detent on aft-facing hook elbow corner (End View 22.13.34.png!)
        add_beveled_box(
            f"Claw_{tag}_AftDetentFrame",
            (side * 7.58, -5.925, 0.42),
            (0.24, 0.08, 0.30),
            mats["claw_seam"],
            col,
            bevel=0.012,
            parent=root,
        )
        add_beveled_box(
            f"Claw_{tag}_AftDetentCavity",
            (side * 7.58, -5.945, 0.42),
            (0.14, 0.05, 0.18),
            mats["cavity_black"],
            col,
            bevel=0.005,
            parent=root,
        )

        # Flush glowing warm orange-red marker pips on the bow outer chamfer (hero openclaw.png!)
        bow_ch_angle = math.atan2(5.17 - 3.83, 9.00 - 7.52)
        # Outward normal of bow chamfer edge from (-7.52, 5.17) to (-9.00, 3.83): (-0.671, +0.741)
        nx, ny = side * 0.671, 0.741
        mx, my = side * 8.26 - nx * 0.005, 4.50 - ny * 0.005
        for m_idx, z_pip in enumerate((0.63, 0.21)):
            add_beveled_box(
                f"Claw_{tag}_BowMarker_{m_idx}",
                (mx, my, z_pip),
                (0.08, 0.032, 0.18),
                mats["led_claw"],
                col,
                bevel=0.006,
                rot=(0.0, 0.0, -side * bow_ch_angle),
                parent=root,
            )

        # 7. Crisp Structural Armor Panel Seams across the Claw Dorsal Surface
        claw_seams = [
            (f"Claw_{tag}_Seam_RootElbow", (side * 7.15, 3.45, 1.141), (0.034, 3.16, 0.012), 0.0),
            (f"Claw_{tag}_Seam_ArmTop", (side * 8.03, 1.78, 1.141), (1.72, 0.034, 0.012), 0.0),
            (f"Claw_{tag}_Seam_ArmBot", (side * 8.03, -4.36, 1.141), (1.72, 0.034, 0.012), 0.0),
            (f"Claw_{tag}_Seam_HookJoint", (side * 7.10, -5.15, 1.141), (0.034, 1.32, 0.012), 0.0),
        ]
        for sname, sloc, ssz, srz in claw_seams:
            add_beveled_box(sname, sloc, ssz, mats["claw_seam"], col, bevel=0.003, rot=(0.0, 0.0, srz), parent=root)


# ---------------------------------------------------------------------------
# 5. Sculptural Studio Lighting, World & 6 Verification Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("OpenClaw_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        # Neutral charcoal studio backdrop matching the 3 orthographic references!
        bg.inputs["Color"].default_value = (0.040, 0.042, 0.046, 1.0)
        bg.inputs["Strength"].default_value = 0.72

    def add_light(name, ltype, loc, target, energy, color, size=10.0, angle=0.04):
        ldata = bpy.data.lights.new(name=name, type=ltype)
        ldata.energy = energy
        ldata.color = color
        if ltype == "SUN":
            ldata.angle = angle
        elif ltype == "AREA":
            ldata.size = size
        lobj = bpy.data.objects.new(name, ldata)
        lobj.location = loc
        link_obj(lobj, col_stage)
        if target is not None:
            aim_object_at(lobj, target)
        return lobj

    # Raking 40-deg grazing key sun (produces bright metallic bevel rim highlights WITHOUT washing out flat crimson/obsidian!)
    add_light("Key_Sun_BowStbd", "SUN", (16.0, 14.0, 14.0), (0.0, 0.0, 0.0), energy=3.8, color=(1.0, 0.98, 0.96), angle=0.04)

    # Secondary opposite raking rim light (sculpts port crimson claw bevels & brushed titanium hull edge!)
    add_light("Rim_Area_PortBow", "AREA", (-18.0, 14.0, 12.0), (0.0, 0.0, 0.0), energy=3400.0, color=(0.86, 0.92, 1.0), size=14.0)

    # Stern raking rim light (catches foreground crimson claw hooks & stern hull chamfers in End Ortho 22.13.34!)
    add_light("Rim_Area_Stern", "AREA", (12.0, -20.0, 11.0), (0.0, -2.0, 0.0), energy=3600.0, color=(0.90, 0.94, 1.0), size=14.0)

    # Subtle grazing Port-Stern fill (highlights crimson claw mid-seam & recessed detents in Side Ortho 22.13.26!)
    add_light("Rim_Area_PortStern", "AREA", (-18.0, -14.0, 5.0), (-4.0, 0.0, 0.0), energy=2600.0, color=(0.92, 0.95, 1.0), size=12.0)

    # Cool Orbital Albedo Bounce from BELOW (illuminates beveled dark-steel underbelly keel & 3 bays!)
    add_light("Underbelly_Bounce", "AREA", (-5.0, -3.0, -16.0), (0.0, 0.0, -0.6), energy=4800.0, color=(0.70, 0.82, 1.0), size=20.0)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=36.0, ortho_scale=21.0):
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

    # 1. Hero 3/4 View matching docs/design/ref_image/openclaw.png
    make_cam("Cam_Hero_34", (-11.8, 18.2, 8.0), (0.0, -0.15, -0.15), cam_type="PERSP", lens=36.0)

    # 2. Top Ortho matching 22.13.19.png (+Y up = bow dark panel, -Y down = stern amber bay & claw tips)
    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 28.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=20.4)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    # 3. Side Ortho matching 22.13.26.png (Port -X looking +X: +Y bow LEFT, -Y stern/claw-tip RIGHT)
    c_side = make_cam("Cam_Side_Ortho", (-24.0, 0.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=14.6)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, -math.pi / 2.0)

    # 4. Front/End Ortho matching 22.13.34.png (Looking from -Y toward +Y: foreground hook tips + aft slot)
    c_front = make_cam("Cam_Front_Ortho", (0.0, -24.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=20.0)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    # 5. Bow End Ortho (Looking from +Y toward -Y: bow LEDs + bow docking slot)
    c_back = make_cam("Cam_Back_Ortho", (0.0, 24.0, 0.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=20.0)
    c_back.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    # 6. Rear 3/4 View (showcasing open crimson claw hooks & glowing molten-amber reactor bay)
    make_cam("Cam_Rear_34", (13.8, -16.8, 7.6), (0.0, 0.2, -0.1), cam_type="PERSP", lens=36.0)

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
# Main Build Entrypoint
# ---------------------------------------------------------------------------

def build_all():
    reset_scene()

    col_root = ensure_collection("OpenClaw_Cruiser")
    col_hull = ensure_collection("01_Central_Hull", col_root)
    col_deck = ensure_collection("02_Dorsal_Features", col_root)
    col_bay = ensure_collection("03_Amber_Reactor_Bay", col_root)
    col_claws = ensure_collection("04_Crimson_Claw_Arms", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("OpenClaw_Cruiser_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.0
    link_obj(root, col_root)

    mats = build_materials()

    build_central_hull(mats, col_hull, root)
    build_dorsal_features(mats, col_deck, root)
    build_amber_reactor_bay(mats, col_bay, root)
    build_crimson_claws(mats, col_claws, root)

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
        f"BUILT OpenClaw_Cruiser V2: {len(mesh_objs)} meshes, "
        f"{total_verts} verts, {total_faces} faces, "
        f"bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
