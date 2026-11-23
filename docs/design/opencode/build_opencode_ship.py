"""Parametric hard-surface 3D model builder for the OpenCode Orbital Carrier (V2 Polished).

Coordinate system (Blender Z-up, meters):
  -X = Bow (forward), +X = Stern (aft)      -> total length ~20.4 m
  -Y = Starboard,     +Y = Port             -> total width  ~11.2 m
  -Z = Ventral,       +Z = Dorsal           -> total height ~5.8 m

Derived directly from:
  - docs/design/ref_image/opencode.png (hero low-angle 3/4 underside reference)
  - docs/design/opencode/opencode-three-views.png (generated orthographic three-views)
"""

import math
import os
import bpy
import bmesh
from mathutils import Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/opencode"
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
# Procedural PBR & Calibrated AgX Holographic Materials (Blender 5.3 + GLB)
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
    metallic=0.18,
    roughness=0.34,
    noise_scale=22.0,
    rough_var=0.05,
    bump_strength=0.012,
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
    if coat > 0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)

    if emission_color is not None and emission_strength > 0:
        set_bsdf_input(bsdf, ["Emission Color", "Emission"], (*emission_color, 1.0))
        set_bsdf_input(bsdf, ["Emission Strength"], emission_strength)

    if noise_scale > 0 and (rough_var > 0 or bump_strength > 0):
        tex_coord = nt.nodes.new("ShaderNodeTexCoord")
        tex_coord.location = (-740, -120)

        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.location = (-480, -80)
        noise.inputs["Scale"].default_value = noise_scale
        noise.inputs["Detail"].default_value = 5.0
        noise.inputs["Roughness"].default_value = 0.55
        nt.links.new(tex_coord.outputs["Object"], noise.inputs["Vector"])

        if rough_var > 0:
            rmap = nt.nodes.new("ShaderNodeMapRange")
            rmap.location = (-180, 40)
            rmap.inputs["From Min"].default_value = 0.25
            rmap.inputs["From Max"].default_value = 0.75
            rmap.inputs["To Min"].default_value = max(0.06, roughness - rough_var)
            rmap.inputs["To Max"].default_value = min(0.92, roughness + rough_var)
            nt.links.new(noise.outputs["Fac"], rmap.inputs["Value"])
            nt.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])

        if bump_strength > 0:
            bump = nt.nodes.new("ShaderNodeBump")
            bump.location = (-160, -220)
            bump.inputs["Strength"].default_value = bump_strength
            bump.inputs["Distance"].default_value = 0.005
            nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def make_holo_grid_mat(name="Mat_Holo_Grid"):
    """Rich translucent electric-violet holographic grid calibrated for AgX (no white blowout)."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    if hasattr(mat, "use_backface_culling"):
        mat.use_backface_culling = False

    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (1020, 0)

    mix_trans = nt.nodes.new("ShaderNodeMixShader")
    mix_trans.location = (760, 0)

    trans = nt.nodes.new("ShaderNodeBsdfTransparent")
    trans.location = (500, 150)

    emit = nt.nodes.new("ShaderNodeEmission")
    emit.location = (500, -80)

    nt.links.new(trans.outputs["BSDF"], mix_trans.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix_trans.inputs[2])
    nt.links.new(mix_trans.outputs["Shader"], out.inputs["Surface"])

    # Fine 3D holographic grid in local object coordinates (pitch ~0.16 m)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-980, 40)

    vec_scale = nt.nodes.new("ShaderNodeVectorMath")
    vec_scale.operation = "SCALE"
    vec_scale.location = (-760, 80)
    vec_scale.inputs["Scale"].default_value = 6.2
    nt.links.new(tc.outputs["Object"], vec_scale.inputs[0])

    vec_frac = nt.nodes.new("ShaderNodeVectorMath")
    vec_frac.operation = "FRACTION"
    vec_frac.location = (-560, 80)
    nt.links.new(vec_scale.outputs["Vector"], vec_frac.inputs[0])

    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-360, 80)
    nt.links.new(vec_frac.outputs["Vector"], sep.inputs["Vector"])

    # Object-space normal masking: suppress the grid axis parallel to a face's normal
    # so horizontal/vertical faces never turn solid when a face lies on an integer grid plane!
    sep_n = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep_n.location = (-360, -240)
    nt.links.new(tc.outputs["Normal"], sep_n.inputs["Vector"])

    def axis_line(sock, norm_sock, y_off, thickness=0.052):
        sub = nt.nodes.new("ShaderNodeMath")
        sub.operation = "SUBTRACT"
        sub.location = (-160, y_off)
        sub.inputs[1].default_value = 0.5
        nt.links.new(sock, sub.inputs[0])

        ab = nt.nodes.new("ShaderNodeMath")
        ab.operation = "ABSOLUTE"
        ab.location = (10, y_off)
        nt.links.new(sub.outputs["Value"], ab.inputs[0])

        gt = nt.nodes.new("ShaderNodeMath")
        gt.operation = "GREATER_THAN"
        gt.location = (170, y_off)
        gt.inputs[1].default_value = 0.5 - thickness
        nt.links.new(ab.outputs["Value"], gt.inputs[0])

        # Mask out when |Normal.axis| > 0.82 (i.e. face is perpendicular to this axis)
        nab = nt.nodes.new("ShaderNodeMath")
        nab.operation = "ABSOLUTE"
        nab.location = (10, y_off - 70)
        nt.links.new(norm_sock, nab.inputs[0])

        nlt = nt.nodes.new("ShaderNodeMath")
        nlt.operation = "LESS_THAN"
        nlt.location = (170, y_off - 70)
        nlt.inputs[1].default_value = 0.82
        nt.links.new(nab.outputs["Value"], nlt.inputs[0])

        masked = nt.nodes.new("ShaderNodeMath")
        masked.operation = "MULTIPLY"
        masked.location = (300, y_off)
        nt.links.new(gt.outputs["Value"], masked.inputs[0])
        nt.links.new(nlt.outputs["Value"], masked.inputs[1])
        return masked.outputs["Value"]

    lx = axis_line(sep.outputs["X"], sep_n.outputs["X"], 260, 0.052)
    ly = axis_line(sep.outputs["Y"], sep_n.outputs["Y"], 40, 0.052)
    lz = axis_line(sep.outputs["Z"], sep_n.outputs["Z"], -180, 0.052)

    m1 = nt.nodes.new("ShaderNodeMath")
    m1.operation = "MAXIMUM"
    m1.location = (330, 140)
    nt.links.new(lx, m1.inputs[0])
    nt.links.new(ly, m1.inputs[1])

    grid = nt.nodes.new("ShaderNodeMath")
    grid.operation = "MAXIMUM"
    grid.location = (470, 260)
    nt.links.new(m1.outputs["Value"], grid.inputs[0])
    nt.links.new(lz, grid.inputs[1])

    # Subtle Fresnel holographic edge glow
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.location = (-120, -340)
    lw.inputs["Blend"].default_value = 0.30

    fres_mul = nt.nodes.new("ShaderNodeMath")
    fres_mul.operation = "MULTIPLY"
    fres_mul.location = (80, -340)
    fres_mul.inputs[1].default_value = 0.28
    nt.links.new(lw.outputs["Facing"], fres_mul.inputs[0])

    base_add = nt.nodes.new("ShaderNodeMath")
    base_add.operation = "ADD"
    base_add.location = (260, -320)
    base_add.inputs[1].default_value = 0.14
    nt.links.new(fres_mul.outputs["Value"], base_add.inputs[0])

    grid_mul = nt.nodes.new("ShaderNodeMath")
    grid_mul.operation = "MULTIPLY"
    grid_mul.location = (300, -180)
    grid_mul.inputs[1].default_value = 0.64
    nt.links.new(grid.outputs["Value"], grid_mul.inputs[0])

    alpha_sum = nt.nodes.new("ShaderNodeMath")
    alpha_sum.operation = "ADD"
    alpha_sum.use_clamp = True
    alpha_sum.location = (520, -240)
    nt.links.new(base_add.outputs["Value"], alpha_sum.inputs[0])
    nt.links.new(grid_mul.outputs["Value"], alpha_sum.inputs[1])
    nt.links.new(alpha_sum.outputs["Value"], mix_trans.inputs["Fac"])

    # Deep saturated violet panel fill -> vibrant electric-violet gridlines (AgX safe!)
    col_mix = nt.nodes.new("ShaderNodeMix")
    col_mix.data_type = "RGBA"
    col_mix.location = (240, -60)
    col_mix.inputs["A"].default_value = (0.30, 0.04, 0.96, 1.0)
    col_mix.inputs["B"].default_value = (0.64, 0.24, 1.00, 1.0)
    nt.links.new(grid.outputs["Value"], col_mix.inputs["Factor"])
    nt.links.new(col_mix.outputs["Result"], emit.inputs["Color"])

    # Calibrated AgX emission strengths: 1.4 panel, 3.8 gridlines (rich purple, never white!)
    str_map = nt.nodes.new("ShaderNodeMapRange")
    str_map.location = (240, 80)
    str_map.inputs["From Min"].default_value = 0.0
    str_map.inputs["From Max"].default_value = 1.0
    str_map.inputs["To Min"].default_value = 1.35
    str_map.inputs["To Max"].default_value = 3.85
    nt.links.new(grid.outputs["Value"], str_map.inputs["Value"])
    nt.links.new(str_map.outputs["Result"], emit.inputs["Strength"])

    return mat


def make_plume_mat(name="Mat_Exhaust_Plume", color=(0.48, 0.14, 1.0), strength=3.4, max_alpha=0.42):
    """Soft volumetric-style translucent violet exhaust plume with radial & axial feathering."""
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "BLENDED"
    if hasattr(mat, "use_backface_culling"):
        mat.use_backface_culling = False

    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (840, 0)
    mix_s = nt.nodes.new("ShaderNodeMixShader")
    mix_s.location = (600, 0)
    trans = nt.nodes.new("ShaderNodeBsdfTransparent")
    trans.location = (360, 120)
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.location = (360, -80)
    emit.inputs["Color"].default_value = (*color, 1.0)
    emit.inputs["Strength"].default_value = strength

    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.location = (-620, 40)
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-420, 40)
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])

    # Axial fade along local Generated X (0 at nozzle -> 1 at tail)
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.location = (-220, 80)
    inv.inputs[0].default_value = 1.0
    nt.links.new(sep.outputs["X"], inv.inputs[1])

    pw = nt.nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    pw.location = (-40, 80)
    pw.inputs[1].default_value = 2.6
    nt.links.new(inv.outputs["Value"], pw.inputs[0])

    # Strong grazing-angle fade so plume cone silhouette dissolves smoothly with zero hard edges!
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.location = (-260, -160)
    lw.inputs["Blend"].default_value = 0.55

    inv_f = nt.nodes.new("ShaderNodeMath")
    inv_f.operation = "SUBTRACT"
    inv_f.location = (-80, -160)
    inv_f.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], inv_f.inputs[1])

    edge_pw = nt.nodes.new("ShaderNodeMath")
    edge_pw.operation = "POWER"
    edge_pw.location = (100, -160)
    edge_pw.inputs[1].default_value = 2.2
    nt.links.new(inv_f.outputs["Value"], edge_pw.inputs[0])

    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.location = (260, 160)
    nt.links.new(pw.outputs["Value"], mul.inputs[0])
    nt.links.new(edge_pw.outputs["Value"], mul.inputs[1])

    scale = nt.nodes.new("ShaderNodeMath")
    scale.operation = "MULTIPLY"
    scale.use_clamp = True
    scale.location = (420, 160)
    scale.inputs[1].default_value = max_alpha
    nt.links.new(mul.outputs["Value"], scale.inputs[0])

    nt.links.new(scale.outputs["Value"], mix_s.inputs["Fac"])
    nt.links.new(trans.outputs["BSDF"], mix_s.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix_s.inputs[2])
    nt.links.new(mix_s.outputs["Shader"], out.inputs["Surface"])
    return mat


def build_materials():
    return {
        "armor_white": make_pbr_mat(
            "Mat_Armor_White",
            (0.66, 0.64, 0.72),
            metallic=0.14,
            roughness=0.34,
            noise_scale=24.0,
            rough_var=0.045,
            bump_strength=0.010,
            coat=0.08,
        ),
        "armor_light": make_pbr_mat(
            "Mat_Armor_Light",
            (0.76, 0.74, 0.81),
            metallic=0.10,
            roughness=0.29,
            noise_scale=26.0,
            rough_var=0.04,
            bump_strength=0.008,
            coat=0.12,
        ),
        "armor_grey": make_pbr_mat(
            "Mat_Armor_Grey",
            (0.30, 0.29, 0.36),
            metallic=0.42,
            roughness=0.38,
            noise_scale=28.0,
            rough_var=0.05,
            bump_strength=0.012,
        ),
        "chassis_dark": make_pbr_mat(
            "Mat_Chassis_Dark",
            (0.052, 0.058, 0.082),
            metallic=0.78,
            roughness=0.36,
            noise_scale=32.0,
            rough_var=0.04,
            bump_strength=0.010,
        ),
        "core_black": make_pbr_mat(
            "Mat_Core_Black",
            (0.018, 0.020, 0.030),
            metallic=0.58,
            roughness=0.46,
            noise_scale=34.0,
            rough_var=0.04,
            bump_strength=0.008,
        ),
        "trim_metal": make_pbr_mat(
            "Mat_Trim_Metal",
            (0.16, 0.17, 0.22),
            metallic=0.86,
            roughness=0.28,
            noise_scale=28.0,
            rough_var=0.04,
            bump_strength=0.008,
        ),
        "glass": make_pbr_mat(
            "Mat_Gallery_Glass",
            (0.015, 0.02, 0.035),
            metallic=0.22,
            roughness=0.06,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            coat=0.65,
        ),
        "holo_grid": make_holo_grid_mat("Mat_Holo_Grid"),
        "holo_rail": make_pbr_mat(
            "Mat_Holo_Rail",
            (0.45, 0.12, 1.0),
            metallic=0.05,
            roughness=0.2,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.54, 0.14, 1.0),
            emission_strength=3.2,
        ),
        "emissive_violet": make_pbr_mat(
            "Mat_Emissive_Violet",
            (0.48, 0.12, 1.0),
            metallic=0.05,
            roughness=0.2,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.52, 0.12, 1.0),
            emission_strength=3.6,
        ),
        "emissive_led": make_pbr_mat(
            "Mat_Emissive_LED",
            (0.68, 0.42, 1.0),
            metallic=0.05,
            roughness=0.15,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.64, 0.30, 1.0),
            emission_strength=4.6,
        ),
        "emissive_trim_cool": make_pbr_mat(
            "Mat_Emissive_TrimCool",
            (0.76, 0.64, 1.0),
            metallic=0.05,
            roughness=0.18,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.66, 0.44, 1.0),
            emission_strength=3.2,
        ),
        "emissive_warm": make_pbr_mat(
            "Mat_Emissive_Warm",
            (1.0, 0.72, 0.34),
            metallic=0.0,
            roughness=0.25,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(1.0, 0.66, 0.24),
            emission_strength=3.6,
        ),
        "emissive_thruster": make_pbr_mat(
            "Mat_Emissive_Thruster",
            (0.76, 0.48, 1.0),
            metallic=0.0,
            roughness=0.12,
            noise_scale=0.0,
            rough_var=0.0,
            bump_strength=0.0,
            emission_color=(0.62, 0.24, 1.0),
            emission_strength=6.8,
        ),
        "plume_outer": make_plume_mat("Mat_Exhaust_Plume_Outer", (0.42, 0.08, 1.0), strength=3.0, max_alpha=0.38),
        "plume_inner": make_plume_mat("Mat_Exhaust_Plume_Inner", (0.72, 0.40, 1.0), strength=5.0, max_alpha=0.45),
    }


# ---------------------------------------------------------------------------
# Hard-Surface BMesh Primitives & Sculpting Helpers
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


def add_beveled_box(
    name,
    center,
    size,
    mat,
    col,
    bevel=0.05,
    segments=2,
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
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        max_b = min(sx, sy, sz) * 0.40
        b_eff = min(bevel, max_b)
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
    obj = finalize_mesh(bm, name, mat, col, bevel_offset=0.0, smooth=False, parent=parent)
    obj.location = center
    obj.rotation_euler = rot
    return obj


def add_extruded_poly(
    name,
    pts_2d,
    depth_min,
    depth_max,
    mat,
    col,
    axis="Z",
    bevel=0.08,
    segments=2,
    parent=None,
):
    bm = bmesh.new()
    verts_a, verts_b = [], []
    for u, v in pts_2d:
        if axis == "Z":
            va = bm.verts.new((u, v, depth_min))
            vb = bm.verts.new((u, v, depth_max))
        elif axis == "Y":
            va = bm.verts.new((u, depth_min, v))
            vb = bm.verts.new((u, depth_max, v))
        else:
            va = bm.verts.new((depth_min, u, v))
            vb = bm.verts.new((depth_max, u, v))
        verts_a.append(va)
        verts_b.append(vb)

    bm.faces.new(verts_a[::-1])
    bm.faces.new(verts_b)
    n = len(pts_2d)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((verts_a[i], verts_a[j], verts_b[j], verts_b[i]))

    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, parent=parent)


def add_lofted_sections(
    name,
    sections,
    mat,
    col,
    bevel=0.08,
    segments=2,
    cap_ends=True,
    smooth=False,
    parent=None,
):
    bm = bmesh.new()
    rings = [[bm.verts.new(tuple(p)) for p in sec] for sec in sections]
    n = len(rings[0])
    for r in range(len(rings) - 1):
        r0, r1 = rings[r], rings[r + 1]
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))

    if cap_ends:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])

    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, smooth=smooth, parent=parent)


def add_cylinder(
    name,
    center,
    radius1,
    radius2,
    depth,
    mat,
    col,
    segments=20,
    rot=(0.0, 0.0, 0.0),
    cap_ends=True,
    smooth=True,
    parent=None,
):
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=cap_ends,
        cap_tris=False,
        segments=segments,
        radius1=radius1,
        radius2=radius2,
        depth=depth,
    )
    obj = finalize_mesh(bm, name, mat, col, bevel_offset=0.0, smooth=smooth, parent=parent)
    obj.location = center
    obj.rotation_euler = rot
    return obj


def chamfer_rect(x0, x1, y0, y1, c=0.32):
    c = min(c, abs(x1 - x0) * 0.35, abs(y1 - y0) * 0.35)
    return [
        (x0 + c, y0),
        (x1 - c, y0),
        (x1, y0 + c),
        (x1, y1 - c),
        (x1 - c, y1),
        (x0 + c, y1),
        (x0, y1 - c),
        (x0, y0 + c),
    ]


# ---------------------------------------------------------------------------
# 1. BOW ASSEMBLY (Sculpted White Ceramic Carapace + Twin Shoulders + Galleries)
# ---------------------------------------------------------------------------

def build_bow(mats, col, root):
    # Inner dark structural skeleton strictly INSIDE the white armor envelope (never pokes through!)
    bow_core_pts = [
        (-7.70, -1.60), (-6.80, -3.45), (-4.35, -4.45), (-3.65, -4.45),
        (-3.65, -2.50), (-4.05, -2.15), (-4.05, 2.15), (-3.65, 2.50),
        (-3.65, 4.45), (-4.35, 4.45), (-6.80, 3.45), (-7.70, 1.60),
    ]
    add_extruded_poly("Bow_Inner_Chassis", bow_core_pts, -0.42, 0.85, mats["chassis_dark"], col, axis="Z", bevel=0.04, parent=root)

    # Full-width sculpted Central Bow Upper Carapace (rich off-white ceramic armor matching Top View!)
    # Sweeps gracefully forward to the prow nose (X=-10.0) and bridges between twin shoulders.
    c_sec0 = [
        (-10.05, -1.70, 0.20), (-10.05, 1.70, 0.20),
        (-9.85, 1.85, 0.95), (-9.85, -1.85, 0.95),
    ]
    c_sec1 = [
        (-7.60, -2.15, 0.18), (-7.60, 2.15, 0.18),
        (-7.50, 2.20, 1.52), (-7.50, -2.20, 1.52),
    ]
    c_sec2 = [
        (-3.75, -2.35, 0.22), (-3.75, 2.35, 0.22),
        (-3.75, 2.35, 1.68), (-3.75, -2.35, 1.68),
    ]
    add_lofted_sections(
        "Bow_Center_Upper_Armor",
        [c_sec0, c_sec1, c_sec2],
        mats["armor_white"],
        col,
        bevel=0.11,
        segments=3,
        parent=root,
    )

    # Stepped multi-panel dorsal ceramic plating on Bow Center (gives crisp sci-fi seam lines in Top View!)
    plate_fwd = [
        (-9.72, -1.48), (-6.85, -1.85), (-6.85, 1.85), (-9.72, 1.48),
    ]
    add_extruded_poly("Bow_Dorsal_Plate_Fwd", plate_fwd, 1.20, 1.56, mats["armor_light"], col, axis="Z", bevel=0.07, parent=root)
    plate_aft = [
        (-6.72, -1.92), (-3.95, -2.05), (-3.95, 2.05), (-6.72, 1.92),
    ]
    add_extruded_poly("Bow_Dorsal_Plate_Aft", plate_aft, 1.44, 1.78, mats["armor_light"], col, axis="Z", bevel=0.07, parent=root)

    # Subtle recessed longitudinal seam grooves & hatch detailing across the central bow roof
    for sy in (-0.82, 0.82):
        add_beveled_box(f"Bow_Roof_Seam_{sy:.2f}", (-6.80, sy, 1.78), (5.20, 0.05, 0.04), mats["chassis_dark"], col, bevel=0.008, parent=root)
    add_beveled_box("Bow_Center_AccessHatch", (-5.25, 0.0, 1.81), (1.35, 1.15, 0.07), mats["armor_grey"], col, bevel=0.02, parent=root)
    for k in range(4):
        add_beveled_box(f"Bow_Center_Vent_{k}", (-5.65 + k * 0.26, 0.0, 1.85), (0.11, 0.72, 0.03), mats["chassis_dark"], col, bevel=0.005, parent=root)

    # Central Forward Recessed Observation Visor & Warm Deck Lights (right under bow nose brow)
    add_beveled_box("Bow_Nose_Visor_Recess", (-9.70, 0.0, -0.04), (0.75, 3.25, 0.44), mats["core_black"], col, bevel=0.02, parent=root)
    add_beveled_box("Bow_Nose_Visor_Glass", (-9.95, 0.0, -0.04), (0.22, 3.05, 0.34), mats["glass"], col, bevel=0.015, parent=root)
    add_beveled_box("Bow_Nose_Visor_WarmBar", (-9.98, 0.0, -0.03), (0.08, 2.75, 0.07), mats["emissive_warm"], col, bevel=0.005, parent=root)
    for i in range(9):
        yy = -1.25 + i * 0.3125
        add_beveled_box(f"Bow_Nose_Mullion_{i}", (-10.04, yy, -0.04), (0.09, 0.045, 0.36), mats["trim_metal"], col, bevel=0.005, parent=root)

    # Central Bow Underside Sculpted White Belly Armor (replaces the old exposed black belly!)
    belly_s0 = [
        (-9.65, -1.65, -0.52), (-9.65, 1.65, -0.52),
        (-9.65, 1.80, -0.22), (-9.65, -1.80, -0.22),
    ]
    belly_s1 = [
        (-6.90, -2.05, -1.22), (-6.90, 2.05, -1.22),
        (-6.90, 2.15, -0.35), (-6.90, -2.15, -0.35),
    ]
    belly_s2 = [
        (-3.75, -2.25, -1.48), (-3.75, 2.25, -1.48),
        (-3.75, 2.25, -0.55), (-3.75, -2.25, -0.55),
    ]
    add_lofted_sections("Bow_Center_Belly_Armor", [belly_s0, belly_s1, belly_s2], mats["armor_white"], col, bevel=0.10, segments=2, parent=root)

    # Recessed dark utility/intake bay inlaid smoothly into the white bow belly
    add_beveled_box("Bow_Belly_Recess", (-6.25, 0.0, -1.36), (2.85, 2.15, 0.16), mats["core_black"], col, bevel=0.03, parent=root)
    for i in range(6):
        yy = -0.82 + i * 0.328
        add_beveled_box(f"Bow_Belly_Rib_{i}", (-6.25, yy, -1.42), (2.55, 0.08, 0.10), mats["trim_metal"], col, bevel=0.01, parent=root)

    # Twin Massive Flanking Bow Armor Shoulders (Port +Y & Starboard -Y)
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        # Upper Cheek Shoulder Carapace (sweeping out smoothly from bow sides)
        sec0 = [
            (-9.35, s * 1.75, 0.25), (-9.35, s * 3.25, 0.18),
            (-9.20, s * 3.55, 0.68), (-9.10, s * 2.95, 1.38),
            (-9.15, s * 1.80, 1.42),
        ]
        sec1 = [
            (-7.10, s * 1.92, 0.32), (-7.10, s * 4.65, 0.18),
            (-7.00, s * 5.05, 0.86), (-6.90, s * 4.10, 1.95),
            (-6.95, s * 2.02, 2.04),
        ]
        sec2 = [
            (-3.60, s * 2.15, 0.36), (-3.60, s * 5.05, 0.18),
            (-3.60, s * 5.25, 0.92), (-3.60, s * 4.35, 2.10),
            (-3.60, s * 2.22, 2.14),
        ]
        secs = [sec0, sec1, sec2] if s == 1 else [sec0[::-1], sec1[::-1], sec2[::-1]]
        add_lofted_sections(f"Bow_Shoulder_{tag}", secs, mats["armor_light"], col, bevel=0.11, segments=3, parent=root)

        # Stepped Dorsal Relief Plate on each Shoulder
        cap_pts = [
            (-8.55, s * 2.15), (-7.15, s * 3.92), (-4.00, s * 4.30),
            (-4.00, s * 2.38), (-7.15, s * 2.20),
        ]
        if s == -1:
            cap_pts = cap_pts[::-1]
        add_extruded_poly(f"Bow_Shoulder_Cap_{tag}", cap_pts, 1.92, 2.24, mats["armor_white"], col, axis="Z", bevel=0.06, parent=root)

        # Recessed dark cheek gallery band directly below shoulder lip
        gal_pts = [
            (-9.20, s * 1.85), (-7.20, s * 4.55), (-3.62, s * 4.98),
            (-3.62, s * 2.20), (-7.15, s * 2.00),
        ]
        if s == -1:
            gal_pts = gal_pts[::-1]
        add_extruded_poly(f"Bow_Shoulder_Gallery_{tag}", gal_pts, -0.22, 0.36, mats["core_black"], col, axis="Z", bevel=0.03, parent=root)

        # Warm glowing multi-deck cheek windows
        for k in range(7):
            t = k / 6.0
            wx = -8.90 + t * 4.85
            wy = s * (2.68 + min(t * 2.15, 1.0) * 2.15)
            add_beveled_box(
                f"Bow_Cheek_Win_{tag}_{k}",
                (wx, wy, 0.14),
                (0.42, 0.09, 0.085),
                mats["emissive_warm"],
                col,
                bevel=0.008,
                rot=(0.0, 0.0, s * (0.45 if k < 3 else 0.06)),
                parent=root,
            )

        # Signature Calibrated Rich Violet Mid-Belt Accent Strip seated flush inside the bow cheek slot!
        belt_segs = [
            ((-9.15, s * 2.38, -0.02), (-7.20, s * 4.62, -0.02)),
            ((-7.20, s * 4.62, -0.02), (-3.62, s * 4.98, -0.02)),
        ]
        for idx, (p0, p1) in enumerate(belt_segs):
            v0, v1 = Vector(p0), Vector(p1)
            mid = (v0 + v1) * 0.5
            d = v1 - v0
            ang = math.atan2(d.y, d.x)
            add_beveled_box(
                f"Bow_Violet_Belt_{tag}_{idx}",
                mid,
                (d.length, 0.09, 0.075),
                mats["emissive_violet"],
                col,
                bevel=0.01,
                rot=(0.0, 0.0, ang),
                parent=root,
            )

        # Lower Bow Flanking Chin Armor Sponson (sculpted sweeping upward toward nose!)
        chin_s0 = [
            (-9.25, s * 1.65, -0.58), (-9.25, s * 3.18, -0.45),
            (-9.25, s * 3.48, -0.14), (-9.25, s * 1.70, -0.14),
        ]
        chin_s1 = [
            (-6.80, s * 1.95, -1.35), (-6.80, s * 4.55, -1.12),
            (-6.80, s * 5.02, -0.24), (-6.80, s * 2.02, -0.22),
        ]
        chin_s2 = [
            (-3.45, s * 2.15, -1.82), (-3.45, s * 4.78, -1.58),
            (-3.45, s * 5.18, -0.48), (-3.45, s * 2.22, -0.48),
        ]
        c_secs = [chin_s0, chin_s1, chin_s2] if s == 1 else [chin_s0[::-1], chin_s1[::-1], chin_s2[::-1]]
        add_lofted_sections(f"Bow_Lower_Chin_{tag}", c_secs, mats["armor_white"], col, bevel=0.10, segments=2, parent=root)

        # Sleek dark side bumper frame & vertical reinforcement ribs
        add_beveled_box(f"Bow_Outer_Rail_{tag}", (-5.45, s * 5.18, -0.40), (3.40, 0.20, 0.52), mats["armor_grey"], col, bevel=0.035, parent=root)
        for r in range(6):
            rx = -6.85 + r * 0.56
            add_beveled_box(f"Bow_Side_Rib_{tag}_{r}", (rx, s * 5.26, -0.40), (0.12, 0.12, 0.58), mats["trim_metal"], col, bevel=0.015, parent=root)

    # Crisp Bow Nose Bumper Tabs (matching Top View front nose articulation)
    for sy in (-1.05, 1.05):
        add_beveled_box(f"Bow_Nose_Bumper_{sy:.2f}", (-10.04, sy, 0.58), (0.34, 0.72, 0.42), mats["armor_light"], col, bevel=0.045, parent=root)


# ---------------------------------------------------------------------------
# 2. UPPER SIDE BOOMS (Port & Starboard Suspended Modular Armor Pods)
# ---------------------------------------------------------------------------

def build_upper_side_booms(mats, col, root):
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        cy = s * 3.88

        # Forward industrial neck truss joining Bow Shoulder (X=-3.60) to Boom (X=-2.55)
        add_beveled_box(f"Boom_Neck_Core_{tag}", (-3.08, cy, 1.62), (1.28, 1.48, 1.24), mats["chassis_dark"], col, bevel=0.04, parent=root)
        for k in range(4):
            kx = -3.52 + k * 0.30
            add_beveled_box(f"Boom_Neck_Rib_{tag}_{k}", (kx, cy, 1.62), (0.10, 1.72, 1.42), mats["trim_metal"], col, bevel=0.018, parent=root)
        add_beveled_box(f"Boom_Neck_WarmBay_{tag}", (-3.08, s * 3.10, 1.40), (0.72, 0.08, 0.28), mats["emissive_warm"], col, bevel=0.01, parent=root)

        # Main White Ceramic Upper Boom Carapace (X: -2.65 -> +1.50, Z: +1.42 -> +2.56)
        boom_pts = chamfer_rect(-2.65, 1.50, cy - 0.98, cy + 0.98, c=0.22)
        add_extruded_poly(f"Boom_Upper_Armor_{tag}", boom_pts, 1.42, 2.54, mats["armor_light"], col, axis="Z", bevel=0.11, segments=3, parent=root)

        # Stepped Dorsal Armor Cap & Panel Clamps
        dorsal_pts = chamfer_rect(-2.32, 1.18, cy - 0.72, cy + 0.72, c=0.18)
        add_extruded_poly(f"Boom_Dorsal_Cap_{tag}", dorsal_pts, 2.48, 2.72, mats["armor_white"], col, axis="Z", bevel=0.06, parent=root)
        add_beveled_box(f"Boom_Outer_Seam_{tag}", (-0.55, cy + s * 0.96, 2.00), (3.45, 0.07, 0.08), mats["chassis_dark"], col, bevel=0.01, parent=root)
        for rx in (-2.00, -0.55, 0.90):
            add_beveled_box(f"Boom_Armor_Clamp_{tag}_{rx:.1f}", (rx, cy, 2.66), (0.26, 1.60, 0.12), mats["armor_grey"], col, bevel=0.02, parent=root)

        # Underside Recessed Glazed Observation Gallery (multi-deck warm lit strip seen in opencode.png!)
        add_beveled_box(f"Boom_Gallery_Core_{tag}", (-0.58, cy, 1.15), (3.95, 1.40, 0.56), mats["core_black"], col, bevel=0.03, parent=root)
        add_beveled_box(f"Boom_Gallery_Glass_{tag}", (-0.58, cy, 1.16), (3.85, 1.58, 0.44), mats["glass"], col, bevel=0.012, parent=root)
        # Dual horizontal warm deck light strips for multi-floor carrier scale!
        add_beveled_box(f"Boom_Gallery_WarmHi_{tag}", (-0.58, cy, 1.24), (3.68, 1.52, 0.065), mats["emissive_warm"], col, bevel=0.008, parent=root)
        add_beveled_box(f"Boom_Gallery_WarmLo_{tag}", (-0.58, cy, 1.07), (3.68, 1.52, 0.055), mats["emissive_warm"], col, bevel=0.008, parent=root)
        for i in range(12):
            mx = -2.42 + i * 0.335
            add_beveled_box(f"Boom_Gallery_Mullion_{tag}_{i}", (mx, cy, 1.15), (0.058, 1.66, 0.52), mats["trim_metal"], col, bevel=0.008, parent=root)

        # Cantilevered Lower Chin Lip under Boom Gallery
        lip_pts = chamfer_rect(-2.62, 1.48, cy - 0.88, cy + 0.88, c=0.16)
        add_extruded_poly(f"Boom_Lower_Lip_{tag}", lip_pts, 0.74, 0.94, mats["armor_white"], col, axis="Z", bevel=0.05, parent=root)

        # Aft Holo-Bridge Emitter Socket on Rear Face of Boom
        add_beveled_box(f"Boom_Holo_Socket_{tag}", (1.53, cy, 1.66), (0.24, 1.14, 0.92), mats["chassis_dark"], col, bevel=0.03, parent=root)
        add_beveled_box(f"Boom_Holo_EmitterRim_{tag}", (1.63, cy, 1.66), (0.07, 0.92, 0.70), mats["emissive_violet"], col, bevel=0.012, parent=root)


# ---------------------------------------------------------------------------
# 3. LOWER VENTRAL CHASSIS (Stepped Swept Keel, Cantilevered Sponsons & 6 LED Pods)
# ---------------------------------------------------------------------------

def add_ventral_thruster_pod(name, center, size_xy, mats, col, parent):
    """Sculpted dark ventral thruster housing with glowing violet rim + 3x4 lavender-violet LED matrix."""
    cx, cy, cz = center
    sx, sy = size_xy
    pts_top = chamfer_rect(cx - sx * 0.56, cx + sx * 0.56, cy - sy * 0.56, cy + sy * 0.56, c=0.16)
    pts_bot = chamfer_rect(cx - sx * 0.45, cx + sx * 0.45, cy - sy * 0.45, cy + sy * 0.45, c=0.13)
    sec0 = [(x, y, cz + 0.36) for x, y in pts_top]
    sec1 = [(x, y, cz - 0.26) for x, y in pts_bot]
    add_lofted_sections(f"{name}_Housing", [sec0, sec1], mats["chassis_dark"], col, bevel=0.045, parent=parent)

    # Metallic outer guard + recessed violet ambient lip
    add_beveled_box(f"{name}_Guard", (cx, cy, cz - 0.25), (sx * 0.84, sy * 0.84, 0.08), mats["trim_metal"], col, bevel=0.015, parent=parent)
    add_beveled_box(f"{name}_Bed", (cx, cy, cz - 0.27), (sx * 0.72, sy * 0.72, 0.06), mats["core_black"], col, bevel=0.01, parent=parent)
    add_beveled_box(f"{name}_VioletRim", (cx, cy, cz - 0.265), (sx * 0.76, sy * 0.76, 0.03), mats["emissive_violet"], col, bevel=0.005, parent=parent)

    # 3x4 glowing lavender-violet LED emitter matrix!
    nx, ny = 4, 3
    for ix in range(nx):
        for iy in range(ny):
            ex = cx + (ix - (nx - 1) / 2.0) * (sx * 0.16)
            ey = cy + (iy - (ny - 1) / 2.0) * (sy * 0.19)
            add_beveled_box(
                f"{name}_LED_{ix}_{iy}",
                (ex, ey, cz - 0.30),
                (sx * 0.095, sy * 0.105, 0.035),
                mats["emissive_led"],
                col,
                bevel=0.005,
                parent=parent,
            )


def build_lower_ventral_chassis(mats, col, root):
    """Sculpted stepped ventral hull keels flanking the open central bay (matches Side View & opencode.png!)."""
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        cy = s * 3.72

        # Stepped Ventral Keel Spine (slopes deeper toward mid-aft, never ruler-flat!)
        k_s0 = [(-5.40, cy - 0.85, -1.92), (-5.40, cy + 0.85, -1.92), (-5.40, cy + 0.92, -1.25), (-5.40, cy - 0.92, -1.25)]
        k_s1 = [(-1.40, cy - 0.92, -2.42), (-1.40, cy + 0.92, -2.42), (-1.40, cy + 0.98, -1.48), (-1.40, cy - 0.98, -1.48)]
        k_s2 = [(3.40, cy - 0.95, -2.56), (3.40, cy + 0.95, -2.56), (3.40, cy + 1.00, -1.52), (3.40, cy - 1.00, -1.52)]
        k_s3 = [(5.90, cy - 0.88, -2.28), (5.90, cy + 0.88, -2.28), (5.90, cy + 0.92, -1.45), (5.90, cy - 0.92, -1.45)]
        add_lofted_sections(f"Ventral_Stepped_Keel_{tag}", [k_s0, k_s1, k_s2, k_s3], mats["chassis_dark"], col, bevel=0.06, parent=root)

        # Forward Cantilevered Lower Armor Sponson (angles smoothly down from bow chin to midship!)
        y_in, y_out = (2.52, 4.96) if s == 1 else (-4.96, -2.52)
        f_s0 = [(-5.45, y_in, -1.86), (-5.45, y_out, -1.72), (-5.45, y_out, -1.18), (-5.45, y_in, -1.25)]
        f_s1 = [(-0.55, y_in, -2.28), (-0.55, y_out, -2.12), (-0.55, y_out, -1.48), (-0.55, y_in, -1.52)]
        add_lofted_sections(
            f"Ventral_Sponson_Fwd_{tag}",
            [f_s0, f_s1] if s == 1 else [f_s0[::-1], f_s1[::-1]],
            mats["armor_white"],
            col,
            bevel=0.09,
            segments=2,
            parent=root,
        )

        # Recessed mechanical bay inlaid on underside of forward sponson
        add_beveled_box(f"Ventral_Fwd_MachBay_{tag}", (-2.95, cy, -2.06), (2.70, 1.12, 0.18), mats["core_black"], col, bevel=0.02, rot=(0.0, 0.085, 0.0), parent=root)
        for i in range(7):
            rx = -4.05 + i * 0.36
            rz = -1.96 - (i / 6.0) * 0.24
            add_beveled_box(f"Ventral_Fwd_Rib_{tag}_{i}", (rx, cy, rz - 0.08), (0.085, 1.06, 0.12), mats["trim_metal"], col, bevel=0.01, parent=root)

        # Aft Cantilevered Lower Armor Sponson (X: +0.30 -> +5.25, deep armored lower wing slab!)
        aft_pts = chamfer_rect(0.30, 5.25, min(y_in, y_out), max(y_in, y_out), c=0.28)
        add_extruded_poly(f"Ventral_Sponson_Aft_{tag}", aft_pts, -2.36, -1.56, mats["armor_light"], col, axis="Z", bevel=0.09, segments=2, parent=root)

        # Stepped Armored Belly Skirt underneath the mid-aft keel (gives the stepped profile in Side View!)
        skirt_pts = chamfer_rect(-2.25, 4.45, cy - 0.72, cy + 0.72, c=0.20)
        add_extruded_poly(f"Ventral_Keel_ArmorSkirt_{tag}", skirt_pts, -2.62, -2.28, mats["armor_grey"], col, axis="Z", bevel=0.05, parent=root)

        # Crisp calibrated lavender-white accent rim along outer bottom edge of sponsons
        add_beveled_box(f"Ventral_Fwd_GlowRim_{tag}", (-3.00, s * 4.96, -1.86), (4.10, 0.07, 0.055), mats["emissive_trim_cool"], col, bevel=0.008, rot=(0.0, 0.082, 0.0), parent=root)
        add_beveled_box(f"Ventral_Aft_GlowRim_{tag}", (2.78, s * 4.97, -2.22), (4.35, 0.07, 0.055), mats["emissive_trim_cool"], col, bevel=0.008, parent=root)

        # Aft Lower Recessed Observation Gallery right above the aft sponson & below lower purple bridge!
        add_beveled_box(f"Ventral_Aft_Gallery_Core_{tag}", (2.25, cy, -1.16), (3.65, 1.85, 0.68), mats["core_black"], col, bevel=0.03, parent=root)
        add_beveled_box(f"Ventral_Aft_Gallery_Glass_{tag}", (2.25, cy, -1.16), (3.55, 2.02, 0.50), mats["glass"], col, bevel=0.01, parent=root)
        add_beveled_box(f"Ventral_Aft_Gallery_WarmHi_{tag}", (2.25, cy, -1.07), (3.42, 1.94, 0.065), mats["emissive_warm"], col, bevel=0.008, parent=root)
        add_beveled_box(f"Ventral_Aft_Gallery_WarmLo_{tag}", (2.25, cy, -1.25), (3.42, 1.94, 0.055), mats["emissive_warm"], col, bevel=0.008, parent=root)
        for i in range(10):
            mx = 0.58 + i * 0.37
            add_beveled_box(f"Ventral_Aft_Mullion_{tag}_{i}", (mx, cy, -1.16), (0.06, 2.08, 0.62), mats["trim_metal"], col, bevel=0.008, parent=root)

        # Midship Armored Coupling Bulkhead bridging Forward & Aft Sponsons
        add_beveled_box(f"Ventral_Mid_Coupling_{tag}", (-0.12, cy, -1.94), (1.12, 2.20, 0.92), mats["armor_grey"], col, bevel=0.05, parent=root)

        # Heavy under-keel coolant/power conduits
        for py in (cy - 0.52, cy + 0.52):
            add_cylinder(
                f"Ventral_Pipe_{tag}_{py:.2f}",
                (0.65, py, -2.44),
                0.08, 0.08, 7.6,
                mats["trim_metal"], col,
                segments=12, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
            )

        # 3 Integrated Ventral Thruster Pods per Side with 3x4 Violet LED Matrices (stepped Z!)
        add_ventral_thruster_pod(f"Ventral_Pod_Bow_{tag}", (-6.05, s * 3.10, -1.78), (1.42, 1.04), mats, col, root)
        add_ventral_thruster_pod(f"Ventral_Pod_Mid_{tag}", (-1.35, s * 3.65, -2.52), (1.40, 1.08), mats, col, root)
        add_ventral_thruster_pod(f"Ventral_Pod_Aft_{tag}", (3.40, s * 3.72, -2.62), (1.68, 1.24), mats, col, root)


# ---------------------------------------------------------------------------
# 4. MASSIVE STERN SUPERSTRUCTURE, CONNECTED EXOSKELETON & EXPOSED ENGINE BAY
# ---------------------------------------------------------------------------

def build_stern_superstructure(mats, col, root):
    """Monumental sculpted stern collar + connected open exoskeleton + densely greebled exposed engine bay."""
    # 4A. Monumental Vertical Forward Stern Armor Collar (X: +3.55 -> +5.85)
    collar_core = chamfer_rect(3.65, 5.80, -4.75, 4.75, c=0.45)
    add_extruded_poly("Stern_Collar_InnerCore", collar_core, -2.18, 2.25, mats["chassis_dark"], col, axis="Z", bevel=0.08, parent=root)

    # Sculpted Chamfered Top Cross-Beam (tapers sleekly toward crown so Front View looks aerospace, not a fridge!)
    top_s0 = [(3.55, -5.25, 1.98), (5.85, -5.25, 1.98), (5.85, 5.25, 1.98), (3.55, 5.25, 1.98)]
    top_s1 = [(3.70, -4.65, 2.74), (5.70, -4.65, 2.74), (5.70, 4.65, 2.74), (3.70, 4.65, 2.74)]
    add_lofted_sections("Stern_Collar_TopArmor", [top_s0, top_s1], mats["armor_light"], col, bevel=0.13, segments=3, parent=root)

    # Stepped Dorsal Crown Plate & Low-Profile Armored Sensor Housing (replaces thin antennas!)
    ridge_pts = chamfer_rect(3.90, 5.45, -3.10, 3.10, c=0.35)
    add_extruded_poly("Stern_Collar_TopRidge", ridge_pts, 2.68, 2.94, mats["armor_white"], col, axis="Z", bevel=0.06, parent=root)
    add_beveled_box("Stern_Comms_Block", (4.68, 0.0, 3.04), (0.88, 2.15, 0.22), mats["armor_grey"], col, bevel=0.04, parent=root)
    for k in range(5):
        yy = -0.80 + k * 0.40
        add_beveled_box(f"Stern_Comms_Vent_{k}", (4.68, yy, 3.16), (0.58, 0.12, 0.05), mats["chassis_dark"], col, bevel=0.01, parent=root)

    # Sculpted Bottom Cross-Beam (tapered chamfered keel matching Side & Front views!)
    bot_s0 = [(3.65, -4.75, -2.48), (5.75, -4.75, -2.48), (5.75, 4.75, -2.48), (3.65, 4.75, -2.48)]
    bot_s1 = [(3.55, -5.20, -1.76), (5.85, -5.20, -1.76), (5.85, 5.20, -1.76), (3.55, 5.20, -1.76)]
    add_lofted_sections("Stern_Collar_BotArmor", [bot_s0, bot_s1], mats["armor_white"], col, bevel=0.12, segments=2, parent=root)

    # Port & Starboard Massive Vertical Stern Armor Walls (X: +3.55 -> +5.85, Y: ±4.22 -> ±5.56)
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        wall_pts = [
            (3.55, -2.22), (5.85, -2.22), (6.05, -1.72), (6.05, 1.98),
            (5.72, 2.58), (3.78, 2.58), (3.55, 2.08),
        ]
        y0, y1 = (4.22, 5.54) if s == 1 else (-5.54, -4.22)
        add_extruded_poly(f"Stern_Wall_Armor_{tag}", wall_pts, y0, y1, mats["armor_light"], col, axis="Y", bevel=0.13, segments=3, parent=root)

        outer_y0, outer_y1 = (5.38, 5.68) if s == 1 else (-5.68, -5.38)
        sub_wall_pts = [
            (3.85, -1.60), (5.55, -1.60), (5.72, -1.15), (5.72, 1.48),
            (5.42, 2.02), (4.05, 2.02), (3.85, 1.58),
        ]
        add_extruded_poly(f"Stern_Wall_OuterCap_{tag}", sub_wall_pts, outer_y0, outer_y1, mats["armor_white"], col, axis="Y", bevel=0.07, parent=root)

        # Front vertical recessed machinery shaft (faces -X into central bay & receives upper purple bridge!)
        add_beveled_box(f"Stern_Front_Shaft_{tag}", (3.58, s * 3.85, 0.20), (0.50, 1.52, 3.60), mats["core_black"], col, bevel=0.03, parent=root)
        for rz in range(8):
            zz = -1.42 + rz * 0.46
            add_beveled_box(f"Stern_Front_Rib_{tag}_{rz}", (3.44, s * 3.85, zz), (0.34, 1.62, 0.085), mats["trim_metal"], col, bevel=0.012, parent=root)
        add_beveled_box(f"Stern_Front_WarmBay_{tag}", (3.50, s * 3.85, 0.20), (0.12, 0.34, 2.75), mats["emissive_warm"], col, bevel=0.008, parent=root)

        # Upper Holo-Bridge Receiver Socket
        add_beveled_box(f"Stern_Upper_HoloSocket_{tag}", (3.52, s * 3.85, 1.66), (0.28, 1.14, 0.92), mats["chassis_dark"], col, bevel=0.03, parent=root)
        add_beveled_box(f"Stern_Upper_HoloRim_{tag}", (3.40, s * 3.85, 1.66), (0.07, 0.92, 0.70), mats["emissive_violet"], col, bevel=0.012, parent=root)

    # Central Recessed Stern Bulkhead Facing the Open Courtyard
    add_beveled_box("Stern_Bay_Backwall", (3.70, 0.0, 0.12), (0.45, 5.15, 3.55), mats["core_black"], col, bevel=0.04, parent=root)
    for i in range(9):
        yy = -2.20 + i * 0.55
        add_beveled_box(f"Stern_Bay_VertRib_{i}", (3.48, yy, 0.12), (0.24, 0.09, 3.40), mats["trim_metal"], col, bevel=0.012, parent=root)
    for j in range(5):
        zz = -1.20 + j * 0.65
        add_beveled_box(f"Stern_Bay_HorizBar_{j}", (3.52, 0.0, zz), (0.18, 5.05, 0.11), mats["armor_grey"], col, bevel=0.012, parent=root)
    for s in (-1, 1):
        add_beveled_box(f"Stern_Bay_VioletSlit_{s}", (3.46, s * 2.55, 0.12), (0.09, 0.08, 2.55), mats["emissive_violet"], col, bevel=0.008, parent=root)

    # 4B. EXPOSED DENSELY-GREEBLED REACTOR & TURBINE ENGINE BAY (X: +5.80 -> +8.90)
    # Compact central inner core ONLY — leaves huge open 3D mechanical depth visible from Top, Side & Rear 3/4!
    add_beveled_box("Stern_Reactor_InnerCore", (7.35, 0.0, 0.08), (2.75, 2.80, 1.85), mats["core_black"], col, bevel=0.06, parent=root)

    # Stacked open-gap horizontal radiator heatsink louvers visible through side & top exoskeleton cutouts!
    for i in range(11):
        zz = -1.35 + i * 0.28
        add_beveled_box(f"Stern_Radiator_Fin_{i}", (7.32, 0.0, zz), (2.55, 8.35, 0.065), mats["chassis_dark"], col, bevel=0.008, parent=root)
    # Vertical structural bulkhead frames slicing across the open engine bay
    for rx in (6.45, 7.35, 8.20):
        add_beveled_box(f"Stern_Engine_Bulkhead_{rx:.2f}", (rx, 0.0, 0.08), (0.18, 8.20, 3.35), mats["armor_grey"], col, bevel=0.02, parent=root)

    # Exposed heavy cylindrical turbine drums & pressure rings visible from top, side & rear!
    for sy in (-3.25, -1.75, 1.75, 3.25):
        for sz in (-0.82, 0.88):
            add_cylinder(
                f"Stern_Turbine_{sy:.2f}_{sz:.2f}",
                (7.35, sy, sz),
                0.44, 0.44, 2.95,
                mats["trim_metal"], col,
                segments=18, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
            )
            # Ribbed clamping collars around each turbine drum
            for cx in (6.45, 7.35, 8.20):
                add_cylinder(
                    f"Stern_TurbineRing_{sy:.2f}_{sz:.2f}_{cx:.1f}",
                    (cx, sy, sz),
                    0.52, 0.52, 0.14,
                    mats["chassis_dark"], col,
                    segments=18, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
                )

    # Exposed side radiator pipes & vertical structural conduits visible cleanly inside side exoskeleton windows!
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        for sz in (-1.05, -0.35, 0.35, 1.05):
            add_cylinder(
                f"Stern_Side_Conduit_{tag}_{sz:.2f}",
                (7.35, s * 4.18, sz),
                0.11, 0.11, 2.95,
                mats["trim_metal"], col,
                segments=12, rot=(0.0, math.pi / 2.0, 0.0), parent=root,
            )
        # Subtle warm interior maintenance lights & violet plasma slits deep inside the side engine bay!
        add_beveled_box(f"Stern_Side_ReactorGlow_{tag}", (7.35, s * 3.72, 0.08), (2.25, 0.12, 0.16), mats["emissive_violet"], col, bevel=0.015, parent=root)
        add_beveled_box(f"Stern_Side_WarmBay_{tag}", (7.35, s * 3.92, -0.58), (1.95, 0.10, 0.09), mats["emissive_warm"], col, bevel=0.01, parent=root)

    # Top-visible violet reactor cooling channels flanking the dorsal spine
    for sy in (-1.20, 1.20):
        add_beveled_box(f"Stern_Top_ReactorGlow_{sy:.1f}", (7.35, sy, 1.62), (2.15, 0.14, 0.12), mats["emissive_violet"], col, bevel=0.015, parent=root)

    # 4C. CONNECTED SCULPTED WHITE OPEN EXOSKELETON ARMOR FRAMES (Top, Bottom, Port & Starboard!)
    # Every arm, diagonal truss, central spine & aft transom now joins SOLIDLY with zero floating ends!
    for sz_sign, ztag in ((1, "Top"), (-1, "Bot")):
        z_lo = 1.88 if sz_sign == 1 else -2.32
        z_hi = 2.46 if sz_sign == 1 else -1.74
        # Central dorsal/ventral armor spine connecting Stern Collar (X=5.70) all the way to Aft Bar (X=8.95)!
        spine_pts = chamfer_rect(5.70, 8.95, -0.82, 0.82, c=0.18)
        add_extruded_poly(f"Stern_Exo_{ztag}_Spine", spine_pts, z_lo + 0.04, z_hi + (0.08 if sz_sign == 1 else -0.08), mats["armor_light"], col, axis="Z", bevel=0.07, parent=root)

        # Aft transverse transom bar closing the open exoskeleton frame
        bar_pts = chamfer_rect(8.18, 8.98, -4.45, 4.45, c=0.20)
        add_extruded_poly(f"Stern_Exo_{ztag}_AftBar", bar_pts, z_lo + 0.03, z_hi - 0.03, mats["armor_white"], col, axis="Z", bevel=0.08, parent=root)

        for s, ytag in ((1, "Port"), (-1, "Stbd")):
            # Sweeping outer exoskeleton arm connecting Stern Collar (X=5.70) to Aft Bar (X=8.98)
            arm_pts = [
                (5.70, s * 4.92), (8.95, s * 4.38), (8.98, s * 3.55),
                (6.15, s * 3.85), (5.70, s * 3.72),
            ]
            if s == -1:
                arm_pts = arm_pts[::-1]
            add_extruded_poly(f"Stern_Exo_{ztag}_Arm_{ytag}", arm_pts, z_lo, z_hi, mats["armor_light"], col, axis="Z", bevel=0.09, segments=2, parent=root)

            # Diagonal truss brace solidly connecting Forward Outer Corner (6.0, ±3.9) -> Aft Spine Junction (8.35, ±0.65)!
            diag_pts = [
                (5.95, s * 3.95), (6.52, s * 3.95),
                (8.42, s * 0.65), (7.85, s * 0.65),
            ]
            if s == -1:
                diag_pts = diag_pts[::-1]
            add_extruded_poly(f"Stern_Exo_{ztag}_Diag_{ytag}", diag_pts, z_lo + 0.06, z_hi - 0.05, mats["armor_white"], col, axis="Z", bevel=0.055, parent=root)

    # Port & Starboard OPEN Exoskeleton Side Frames (NO solid box wall blocking the window!)
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        y0, y1 = (4.26, 4.92) if s == 1 else (-4.92, -4.26)
        u_pts = [(5.75, 1.44), (8.98, 1.28), (8.98, 2.12), (5.75, 2.34)]
        add_extruded_poly(f"Stern_SideExo_Top_{tag}", u_pts, y0, y1, mats["armor_light"], col, axis="Y", bevel=0.08, parent=root)
        l_pts = [(5.75, -2.14), (8.98, -1.86), (8.98, -1.12), (5.75, -1.28)]
        add_extruded_poly(f"Stern_SideExo_Bot_{tag}", l_pts, y0, y1, mats["armor_white"], col, axis="Y", bevel=0.08, parent=root)
        p_pts = [(8.24, -1.88), (8.98, -1.72), (8.98, 1.92), (8.24, 2.08)]
        add_extruded_poly(f"Stern_SideExo_AftPillar_{tag}", p_pts, y0 + 0.03, y1 - 0.03, mats["armor_white"], col, axis="Y", bevel=0.07, parent=root)
        # Thin beveled recessed metal window border bars (open center so full 3D engine bay shines through!)
        add_beveled_box(f"Stern_SideExo_MidStrut_{tag}", (7.28, s * 4.52, 0.08), (0.28, 0.34, 2.75), mats["armor_grey"], col, bevel=0.03, parent=root)


# ---------------------------------------------------------------------------
# 5. AFT PROPULSION ARRAY (Quad Main Thrusters + Core Drive + Feathered Plumes)
# ---------------------------------------------------------------------------

def add_feathered_plume(name, center_base, radius_y, radius_z, length, mats, col, parent):
    """Smooth high-segment double-shell feathered exhaust plume (zero polygonal box edges!)."""
    cx, cy, cz = center_base
    for layer, scale_r, scale_l, mat_key in (
        ("Outer", 1.00, 1.00, "plume_outer"),
        ("Inner", 0.56, 0.72, "plume_inner"),
    ):
        segs = 32
        rings = []
        # 4 axial rings tapering softly into space
        axial_profile = [
            (0.0, 0.92),
            (0.22, 1.04),
            (0.62, 0.74),
            (1.00, 0.16),
        ]
        for t, r_mul in axial_profile:
            x = cx + t * length * scale_l
            ring = []
            for k in range(segs):
                a = (2.0 * math.pi * k) / segs
                y = cy + math.cos(a) * radius_y * scale_r * r_mul
                z = cz + math.sin(a) * radius_z * scale_r * r_mul
                ring.append((x, y, z))
            rings.append(ring)

        obj = add_lofted_sections(
            f"{name}_Plume_{layer}",
            rings,
            mats[mat_key],
            col,
            bevel=0.0,
            cap_ends=False,
            smooth=True,
            parent=parent,
        )
        obj.visible_shadow = False


def add_main_thruster(name, center, size_yz, mats, col, parent, plume_len=2.1):
    cx, cy, cz = center
    sy, sz = size_yz

    p0 = chamfer_rect(cy - sy * 0.56, cy + sy * 0.56, cz - sz * 0.56, cz + sz * 0.56, c=0.22)
    p1 = chamfer_rect(cy - sy * 0.46, cy + sy * 0.46, cz - sz * 0.46, cz + sz * 0.46, c=0.18)
    s0 = [(cx - 0.55, y, z) for y, z in p0]
    s1 = [(cx + 0.52, y, z) for y, z in p1]
    add_lofted_sections(f"{name}_Cowling", [s0, s1], mats["chassis_dark"], col, bevel=0.05, parent=parent)

    add_beveled_box(f"{name}_Flap_Top", (cx + 0.48, cy, cz + sz * 0.48), (0.46, sy * 0.72, 0.10), mats["armor_grey"], col, bevel=0.02, rot=(0.0, 0.14, 0.0), parent=parent)
    add_beveled_box(f"{name}_Flap_Bot", (cx + 0.48, cy, cz - sz * 0.48), (0.46, sy * 0.72, 0.10), mats["armor_grey"], col, bevel=0.02, rot=(0.0, -0.14, 0.0), parent=parent)
    add_beveled_box(f"{name}_Flap_L", (cx + 0.48, cy + sy * 0.48, cz), (0.46, 0.10, sz * 0.72), mats["trim_metal"], col, bevel=0.02, rot=(0.0, 0.0, -0.14), parent=parent)
    add_beveled_box(f"{name}_Flap_R", (cx + 0.48, cy - sy * 0.48, cz), (0.46, 0.10, sz * 0.72), mats["trim_metal"], col, bevel=0.02, rot=(0.0, 0.0, 0.14), parent=parent)

    # Recessed glowing purple-lavender plasma nozzle core
    core_pts = chamfer_rect(cy - sy * 0.34, cy + sy * 0.34, cz - sz * 0.34, cz + sz * 0.34, c=0.14)
    add_extruded_poly(f"{name}_PlasmaCore", core_pts, cx + 0.32, cx + 0.46, mats["emissive_thruster"], col, axis="X", bevel=0.02, parent=parent)

    add_beveled_box(f"{name}_Baffle_H", (cx + 0.49, cy, cz), (0.06, sy * 0.68, 0.065), mats["trim_metal"], col, bevel=0.01, parent=parent)
    add_beveled_box(f"{name}_Baffle_V", (cx + 0.49, cy, cz), (0.06, 0.065, sz * 0.68), mats["trim_metal"], col, bevel=0.01, parent=parent)

    if plume_len > 0:
        add_feathered_plume(name, (cx + 0.46, cy, cz), sy * 0.35, sz * 0.35, plume_len, mats, col, parent)


def build_propulsion_array(mats, col, root):
    add_beveled_box("Drive_Aft_Manifold", (8.95, 0.0, 0.08), (0.62, 7.20, 3.55), mats["chassis_dark"], col, bevel=0.06, parent=root)

    quad_positions = [
        ("Thruster_Upper_Port", (9.42, 2.85, 1.15), (1.82, 1.28), 2.15),
        ("Thruster_Upper_Stbd", (9.42, -2.85, 1.15), (1.82, 1.28), 2.15),
        ("Thruster_Lower_Port", (9.42, 2.85, -1.08), (1.82, 1.28), 2.15),
        ("Thruster_Lower_Stbd", (9.42, -2.85, -1.08), (1.82, 1.28), 2.15),
    ]
    for name, pos, sz, plen in quad_positions:
        add_main_thruster(name, pos, sz, mats, col, root, plume_len=plen)

    add_main_thruster("Thruster_Core_Center", (9.55, 0.0, 0.04), (1.92, 1.44), mats, col, root, plume_len=1.75)

    for s, tag in ((1, "Port"), (-1, "Stbd")):
        add_beveled_box(f"Drive_Outer_Shroud_{tag}", (9.16, s * 4.28, 0.04), (0.82, 0.40, 2.80), mats["armor_white"], col, bevel=0.06, parent=root)
        add_beveled_box(f"Drive_Outer_Glow_{tag}", (9.60, s * 4.28, 0.04), (0.07, 0.12, 1.90), mats["emissive_violet"], col, bevel=0.012, parent=root)


# ---------------------------------------------------------------------------
# 6. SLEEK TRANSLUCENT PURPLE HOLOGRAPHIC GRID ENERGY BRIDGES
# ---------------------------------------------------------------------------

def add_holo_beam(name, p0, p1, width, height, mats, col, parent):
    """Sleek translucent purple holographic grid plane/box + ultra-slim glowing corner rails.
    No chunky cage hoops — relies on the crisp procedural holographic grid shader!
    """
    v0 = Vector(p0)
    v1 = Vector(p1)
    mid = (v0 + v1) * 0.5
    diff = v1 - v0
    length = diff.length
    if length < 0.01:
        return

    x_ax = diff.normalized()
    up = Vector((0, 0, 1))
    if abs(x_ax.dot(up)) > 0.96:
        up = Vector((1, 0, 0))
    y_ax = up.cross(x_ax).normalized()
    z_ax = x_ax.cross(y_ax).normalized()
    rot_mat = Matrix((
        (x_ax.x, y_ax.x, z_ax.x),
        (x_ax.y, y_ax.y, z_ax.y),
        (x_ax.z, y_ax.z, z_ax.z),
    )).to_euler()

    # Layer 1: Translucent procedural glowing violet holographic grid volume
    shell = add_beveled_box(
        f"{name}_GridShell",
        mid,
        (length, width, height),
        mats["holo_grid"],
        col,
        bevel=0.015,
        segments=1,
        rot=rot_mat,
        parent=parent,
    )
    shell.visible_shadow = False

    # Layer 2: Ultra-slim glowing corner edge rails (just the 4 silhouette edges + end caps!)
    bm = bmesh.new()
    rail_t = 0.014
    hw, hh, hl = width * 0.5, height * 0.5, length * 0.5

    def append_box(c_local, dims):
        m = Matrix.Translation(c_local) @ Matrix.Diagonal((dims[0], dims[1], dims[2], 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)

    for sy in (-1, 1):
        for sz in (-1, 1):
            append_box((0.0, sy * hw, sz * hh), (length, rail_t, rail_t))
    for ex in (-hl + 0.02, hl - 0.02):
        append_box((ex, 0.0, hh), (rail_t * 1.4, width, rail_t * 1.4))
        append_box((ex, 0.0, -hh), (rail_t * 1.4, width, rail_t * 1.4))
        append_box((ex, hw, 0.0), (rail_t * 1.4, rail_t * 1.4, height))
        append_box((ex, -hw, 0.0), (rail_t * 1.4, rail_t * 1.4, height))

    frame_obj = finalize_mesh(bm, f"{name}_EdgeRails", mats["holo_rail"], col, bevel_offset=0.0, parent=parent)
    frame_obj.location = mid
    frame_obj.rotation_euler = rot_mat
    frame_obj.visible_shadow = False


def build_holo_bridges(mats, col, root):
    # 1) Upper-Aft Suspended Holographic Energy Bridges (Boom rear -> Stern tower front)
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        add_holo_beam(
            f"Holo_UpperAft_{tag}",
            (1.56, s * 3.85, 1.66),
            (3.52, s * 3.85, 1.66),
            width=0.88,
            height=0.64,
            mats=mats,
            col=col,
            parent=root,
        )

    # 2) Lower-Mid Inner Containment Ring around the Central Open Courtyard (Z = -0.66)
    z_low = -0.66
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        add_holo_beam(
            f"Holo_LowerSide_{tag}",
            (-2.65, s * 3.04, z_low),
            (2.85, s * 3.04, z_low),
            width=0.52,
            height=0.52,
            mats=mats,
            col=col,
            parent=root,
        )
        add_holo_beam(
            f"Holo_CornerFwd_{tag}",
            (-3.42, s * 2.15, z_low),
            (-2.55, s * 3.06, z_low),
            width=0.50,
            height=0.52,
            mats=mats,
            col=col,
            parent=root,
        )
        add_holo_beam(
            f"Holo_CornerAft_{tag}",
            (2.75, s * 3.06, z_low),
            (3.52, s * 2.18, z_low),
            width=0.50,
            height=0.52,
            mats=mats,
            col=col,
            parent=root,
        )
        # Forward sloped holo pylon linking lower corner up to underside of Upper Boom
        add_holo_beam(
            f"Holo_FwdRiser_{tag}",
            (-3.16, s * 3.12, -0.48),
            (-2.64, s * 3.45, 0.90),
            width=0.46,
            height=0.42,
            mats=mats,
            col=col,
            parent=root,
        )

    # Forward & Aft Transverse Inner Energy Rails
    add_holo_beam("Holo_Fwd_Transverse", (-3.48, -2.28, z_low), (-3.48, 2.28, z_low), width=0.50, height=0.48, mats=mats, col=col, parent=root)
    add_holo_beam("Holo_Aft_Transverse", (3.44, -2.28, z_low), (3.44, 2.28, z_low), width=0.44, height=0.44, mats=mats, col=col, parent=root)


# ---------------------------------------------------------------------------
# 7. INDUSTRIAL CARRIER DETAILS & ARMORED SENSORS (no lollipop antennas!)
# ---------------------------------------------------------------------------

def build_greebles(mats, col, root):
    for s, tag in ((1, "Port"), (-1, "Stbd")):
        # Low-profile swept armored dorsal sensor blade on Stern Collar
        fin_pts = [(4.20, 2.86), (5.05, 2.86), (4.92, 3.22), (4.45, 3.22)]
        y0, y1 = (s * 2.76, s * 2.90) if s == 1 else (s * 2.90, s * 2.76)
        add_extruded_poly(f"Stern_Sensor_Fin_{tag}", fin_pts, y0, y1, mats["armor_grey"], col, axis="Y", bevel=0.02, parent=root)

        # Recessed service hatches on Bow Shoulders
        add_beveled_box(f"Bow_Hatch_{tag}", (-6.05, s * 3.22, 2.23), (1.05, 0.62, 0.07), mats["armor_grey"], col, bevel=0.02, parent=root)
        for h in range(3):
            add_beveled_box(f"Bow_Hatch_Slot_{tag}_{h}", (-6.30 + h * 0.25, s * 3.22, 2.27), (0.11, 0.40, 0.025), mats["chassis_dark"], col, bevel=0.005, parent=root)

        # Crisp violet navigation marker slits on Boom & Stern outer armor
        add_beveled_box(f"Boom_NavMarker_{tag}", (1.32, s * 4.86, 2.34), (0.30, 0.045, 0.055), mats["emissive_violet"], col, bevel=0.008, parent=root)
        add_beveled_box(f"Stern_NavMarker_{tag}", (4.68, s * 5.69, 1.76), (0.82, 0.045, 0.065), mats["emissive_violet"], col, bevel=0.008, parent=root)


# ---------------------------------------------------------------------------
# Space Lighting, World & Properly Oriented Multi-View Cameras
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Space_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.012, 0.015, 0.026, 1.0)
        bg.inputs["Strength"].default_value = 0.72

    def add_light(name, ltype, loc, target, energy, color, size=4.0, angle=0.08):
        ldata = bpy.data.lights.new(name=name, type=ltype)
        ldata.energy = energy
        ldata.color = color
        if ltype == "SUN":
            ldata.angle = angle
        elif ltype == "AREA":
            ldata.size = size
        elif ltype == "POINT":
            ldata.shadow_soft_size = size
        lobj = bpy.data.objects.new(name, ldata)
        lobj.location = loc
        link_obj(lobj, col_stage)
        if target is not None:
            aim_object_at(lobj, target)
        return lobj

    # Primary Space Key Sun (sculpts the crisp white beveled armor from upper-front-starboard)
    add_light("Key_Sun", "SUN", (-16, -18, 22), (0, 0, 0), energy=4.4, color=(0.95, 0.96, 1.0), angle=0.05)

    # Planetary Atmosphere Limb Rim Light (cool sky-blue light from lower-right-aft matching opencode.png!)
    add_light("Planet_Rim_Area", "AREA", (16, -14, -15), (0, 0, 0), energy=7200.0, color=(0.48, 0.70, 1.0), size=16.0)

    # Dorsal Architectural Fill (keeps Top View crisp & sculptural)
    add_light("Fill_Top_Area", "AREA", (-3, 5, 24), (0, 0, 0), energy=3000.0, color=(0.82, 0.86, 1.0), size=20.0)

    # Ventral Soft Cool Fill (reveals underside detail in Hero 3/4 view without flattening shadows)
    add_light("Fill_Ventral_Area", "AREA", (-14, -12, -16), (0, 0, -0.8), energy=2600.0, color=(0.74, 0.78, 0.96), size=14.0)

    # Rich Saturated Violet Holographic & Thruster Bounce Lights (casts subtle purple sheen onto white hull!)
    for s in (-1, 1):
        add_light(f"Holo_Glow_Upper_{s}", "POINT", (2.55, s * 3.85, 1.66), None, energy=240.0, color=(0.56, 0.16, 1.0), size=1.0)
        add_light(f"Holo_Glow_Lower_{s}", "POINT", (0.10, s * 3.05, -0.66), None, energy=200.0, color=(0.52, 0.14, 1.0), size=1.3)
    add_light("Thruster_Bounce", "POINT", (11.5, 0.0, 0.05), None, energy=850.0, color=(0.58, 0.22, 1.0), size=2.2)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=42.0, ortho_scale=24.0):
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

    # 1. Hero Low-Angle 3/4 Underside View matching opencode.png handedness & open-courtyard reveal!
    # Placed on -Y side so Bow (-X) is LEFT and Massive Stern (+X) is RIGHT!
    make_cam("Cam_Hero_34", (-14.5, -21.5, -7.8), (0.4, 0.0, -0.1), cam_type="PERSP", lens=38.0)

    # 2. Top Orthographic View (+Z looking down; Bow left -X, Stern right +X)
    c_top = make_cam("Cam_Top_Ortho", (0.4, 0.0, 26.0), (0.4, 0.0, 0.0), cam_type="ORTHO", ortho_scale=25.5)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    # 3. Front Orthographic View (-X looking toward +X)
    c_front = make_cam("Cam_Front_Ortho", (-24.0, 0.0, 0.1), (0.0, 0.0, 0.1), cam_type="ORTHO", ortho_scale=15.0)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, -math.pi / 2.0)

    # 4. Side Orthographic View (-Y looking toward +Y; Bow left -X, Stern right +X)
    c_side = make_cam("Cam_Side_Ortho", (0.5, -24.0, 0.1), (0.5, 0.0, 0.1), cam_type="ORTHO", ortho_scale=25.5)
    c_side.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    # 5. Upper Rear 3/4 Showcase View (generous framing showing full exoskeleton + plumes + open bay)
    make_cam("Cam_Rear_34", (22.0, -19.5, 13.8), (0.2, 0.0, -0.2), cam_type="PERSP", lens=40.0)

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
    scene.view_settings.exposure = 0.15

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

    col_root = ensure_collection("OpenCode_Carrier")
    col_bow = ensure_collection("01_Bow_Assembly", col_root)
    col_booms = ensure_collection("02_Upper_Side_Booms", col_root)
    col_ventral = ensure_collection("03_Lower_Ventral_Chassis", col_root)
    col_stern = ensure_collection("04_Stern_Superstructure", col_root)
    col_drive = ensure_collection("05_Propulsion_Array", col_root)
    col_holo = ensure_collection("06_Holo_Energy_Bridges", col_root)
    col_greeble = ensure_collection("07_Greebles_And_Details", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("OpenCode_Carrier_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.0
    link_obj(root, col_root)

    mats = build_materials()

    build_bow(mats, col_bow, root)
    build_upper_side_booms(mats, col_booms, root)
    build_lower_ventral_chassis(mats, col_ventral, root)
    build_stern_superstructure(mats, col_stern, root)
    build_propulsion_array(mats, col_drive, root)
    build_holo_bridges(mats, col_holo, root)
    build_greebles(mats, col_greeble, root)

    setup_world_and_lighting(col_stage)
    cameras = setup_cameras(col_stage)
    setup_render_settings()

    bpy.context.view_layer.update()

    mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
    total_verts = sum(len(o.data.vertices) for o in mesh_objs)
    total_faces = sum(len(o.data.polygons) for o in mesh_objs)

    hull_objs = [o for o in mesh_objs if "Plume" not in o.name]
    xs, ys, zs = [], [], []
    for o in hull_objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            xs.append(w.x)
            ys.append(w.y)
            zs.append(w.z)

    print(
        f"BUILT OpenCode_Carrier V2: {len(mesh_objs)} meshes, "
        f"{total_verts} verts, {total_faces} faces, "
        f"hull bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
