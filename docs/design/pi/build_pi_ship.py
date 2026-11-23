"""Parametric hard-surface 3D model builder for the true asymmetric Pi Orbital Ship.

Rebuilt directly from the 5 user-supplied multi-view references in docs/design/pi/
plus the hero orbital reference docs/design/ref_image/pi.png:
  - Top View:   已粘贴 2026-11-23 22.01.18.png (asymmetric pi-planform w/ open triangular hole)
  - Front View: 已粘贴 2026-11-23 22.01.09.png (gaping louver mouths + swept blue wing + right red bar)
  - Back View:  已粘贴 2026-11-23 22.01.53.png (full-width red rear radiator + blue rear radiator)
  - Left Side:  已粘贴 2026-11-23 22.00.56.png (ultra-sleek profile, blue side cooler, red left trench)
  - Right Side: 已粘贴 2026-11-23 22.02.04.png (two-tone yellow cheek bay + red right vent mouth)

Coordinate system (Blender Z-up, meters):
  -X = Port (Cerulean Blue L-wing & long prong)   -> X in [-8.75, +8.65] (~17.4 m span)
  +X = Starboard (Two-tone Yellow prong + Red bar)
  -Y = Bow (Forward Blue & Yellow prongs)         -> Y in [-8.85, +8.70] (~17.55 m length)
  +Y = Stern (Flat Coral-Red rear radiator bar)
  -Z/+Z = Ventral / Dorsal                        -> Z in [-1.10, +1.42] (~2.52 m sleek height)
"""

import math
import os
import bpy
import bmesh
from mathutils import Matrix, Vector


OUT_DIR = "/Volumes/WD1TB/Orbis/orbis/docs/design/pi"
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
# Matte Weathered Aerospace Materials (Blender 5.3 + GLB PBR compatible)
# ---------------------------------------------------------------------------

def set_bsdf_input(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return bsdf.inputs[n]
    return None


def make_aerospace_mat(
    name,
    base_color,
    dark_color=None,
    metallic=0.14,
    roughness=0.38,
    noise_scale=22.0,
    rough_var=0.07,
    bump_strength=0.008,
    coat=0.06,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (560, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (220, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    set_bsdf_input(bsdf, ["Base Color"], (*base_color, 1.0))
    set_bsdf_input(bsdf, ["Metallic"], metallic)
    set_bsdf_input(bsdf, ["Roughness"], roughness)
    if coat > 0:
        set_bsdf_input(bsdf, ["Coat Weight", "Clearcoat"], coat)

    if noise_scale > 0 and (rough_var > 0 or bump_strength > 0 or dark_color is not None):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-860, -80)

        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.location = (-600, -40)
        noise.inputs["Scale"].default_value = noise_scale
        noise.inputs["Detail"].default_value = 6.0
        noise.inputs["Roughness"].default_value = 0.60
        nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])

        if dark_color is not None:
            patina = nt.nodes.new("ShaderNodeTexNoise")
            patina.location = (-600, 200)
            patina.inputs["Scale"].default_value = 2.8
            patina.inputs["Detail"].default_value = 5.0
            patina.inputs["Roughness"].default_value = 0.65
            nt.links.new(tc.outputs["Object"], patina.inputs["Vector"])

            pmap = nt.nodes.new("ShaderNodeMapRange")
            pmap.location = (-360, 200)
            pmap.inputs["From Min"].default_value = 0.34
            pmap.inputs["From Max"].default_value = 0.74
            pmap.inputs["To Min"].default_value = 0.0
            pmap.inputs["To Max"].default_value = 0.30
            nt.links.new(patina.outputs["Fac"], pmap.inputs["Value"])

            col_mix = nt.nodes.new("ShaderNodeMix")
            col_mix.data_type = "RGBA"
            col_mix.location = (-100, 180)
            col_mix.inputs["A"].default_value = (*base_color, 1.0)
            col_mix.inputs["B"].default_value = (*dark_color, 1.0)
            nt.links.new(pmap.outputs["Result"], col_mix.inputs["Factor"])
            nt.links.new(col_mix.outputs["Result"], bsdf.inputs["Base Color"])

        if rough_var > 0:
            rmap = nt.nodes.new("ShaderNodeMapRange")
            rmap.location = (-160, 0)
            rmap.inputs["From Min"].default_value = 0.25
            rmap.inputs["From Max"].default_value = 0.75
            rmap.inputs["To Min"].default_value = max(0.08, roughness - rough_var)
            rmap.inputs["To Max"].default_value = min(0.92, roughness + rough_var)
            nt.links.new(noise.outputs["Fac"], rmap.inputs["Value"])
            nt.links.new(rmap.outputs["Result"], bsdf.inputs["Roughness"])

        if bump_strength > 0:
            bump = nt.nodes.new("ShaderNodeBump")
            bump.location = (-140, -210)
            bump.inputs["Strength"].default_value = bump_strength
            bump.inputs["Distance"].default_value = 0.004
            nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
            nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def build_materials():
    return {
        # Cerulean aerospace steel-blue (Port L-wing & prong)
        "blue": make_aerospace_mat(
            "Mat_Pi_Blue",
            base_color=(0.11, 0.37, 0.56),
            dark_color=(0.06, 0.23, 0.38),
            metallic=0.14,
            roughness=0.36,
            noise_scale=22.0,
            rough_var=0.07,
            bump_strength=0.008,
            coat=0.08,
        ),
        # Coral-salmon terracotta red (Asymmetric top crossbar + diagonal strut)
        "red": make_aerospace_mat(
            "Mat_Pi_Red",
            base_color=(0.64, 0.22, 0.19),
            dark_color=(0.42, 0.12, 0.11),
            metallic=0.12,
            roughness=0.38,
            noise_scale=22.0,
            rough_var=0.07,
            bump_strength=0.008,
            coat=0.06,
        ),
        # Deeper warm ochre-gold (Starboard forward nose prong)
        "yellow_gold": make_aerospace_mat(
            "Mat_Pi_YellowGold",
            base_color=(0.62, 0.38, 0.09),
            dark_color=(0.44, 0.25, 0.04),
            metallic=0.15,
            roughness=0.36,
            noise_scale=22.0,
            rough_var=0.07,
            bump_strength=0.008,
            coat=0.08,
        ),
        # Pale muted sand-ochre (Starboard aft shoulder — distinct two-tone in 22.01.18 & 22.02.04!)
        "yellow_sand": make_aerospace_mat(
            "Mat_Pi_YellowSand",
            base_color=(0.68, 0.54, 0.28),
            dark_color=(0.50, 0.39, 0.18),
            metallic=0.12,
            roughness=0.38,
            noise_scale=22.0,
            rough_var=0.07,
            bump_strength=0.008,
            coat=0.06,
        ),
        # Matte ceramic off-white (Central asymmetric bridge + blue tip stripe)
        "white": make_aerospace_mat(
            "Mat_Pi_White",
            base_color=(0.75, 0.76, 0.79),
            dark_color=(0.58, 0.60, 0.64),
            metallic=0.10,
            roughness=0.34,
            noise_scale=24.0,
            rough_var=0.06,
            bump_strength=0.007,
            coat=0.10,
        ),
        # Brushed bare aluminum-titanium (mouth bezels, intake cowlings, elbow trim)
        "titanium": make_aerospace_mat(
            "Mat_Bare_Titanium",
            base_color=(0.44, 0.46, 0.50),
            dark_color=(0.28, 0.30, 0.34),
            metallic=0.84,
            roughness=0.28,
            noise_scale=30.0,
            rough_var=0.06,
            bump_strength=0.007,
            coat=0.0,
        ),
        # Dark slate metal (vent frames, mechanical brackets, structural lips)
        "slate": make_aerospace_mat(
            "Mat_Armor_Slate",
            base_color=(0.17, 0.18, 0.21),
            dark_color=(0.10, 0.11, 0.13),
            metallic=0.68,
            roughness=0.36,
            noise_scale=28.0,
            rough_var=0.05,
            bump_strength=0.007,
            coat=0.0,
        ),
        # Heavy dark gunmetal (radiator louvers, side drums, shafts, trusses)
        "gunmetal": make_aerospace_mat(
            "Mat_Gunmetal_Dark",
            base_color=(0.068, 0.073, 0.084),
            metallic=0.84,
            roughness=0.34,
            noise_scale=32.0,
            rough_var=0.05,
            bump_strength=0.008,
            coat=0.0,
        ),
        # Machined steel (hydraulic rods, ribs, louver edges)
        "steel": make_aerospace_mat(
            "Mat_Trim_Steel",
            base_color=(0.25, 0.27, 0.31),
            metallic=0.90,
            roughness=0.25,
            noise_scale=30.0,
            rough_var=0.04,
            bump_strength=0.006,
            coat=0.0,
        ),
        # Deep cavity carbon-black (recessed intake & radiator backwalls)
        "cavity_black": make_aerospace_mat(
            "Mat_Cavity_Black",
            base_color=(0.015, 0.017, 0.022),
            metallic=0.50,
            roughness=0.52,
            noise_scale=36.0,
            rough_var=0.04,
            bump_strength=0.005,
            coat=0.0,
        ),
    }


# ---------------------------------------------------------------------------
# Hard-Surface BMesh Sculpting Helpers
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


def add_beveled_box(name, center, size, mat, col, bevel=0.035, segments=2, rot=(0.0, 0.0, 0.0), parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        b_eff = min(bevel, min(sx, sy, sz) * 0.36)
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


def add_extruded_poly(name, pts_2d, depth_min, depth_max, mat, col, axis="Z", bevel=0.06, segments=2, parent=None):
    bm = bmesh.new()
    va_list, vb_list = [], []
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
        va_list.append(va)
        vb_list.append(vb)
    bm.faces.new(va_list[::-1])
    bm.faces.new(vb_list)
    n = len(pts_2d)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((va_list[i], va_list[j], vb_list[j], vb_list[i]))
    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, parent=parent)


def add_tapered_prism(name, pts_bot, pts_top, mat, col, bevel=0.06, segments=2, parent=None):
    """Create a sleek faceted armor shell between a bottom 3D polygon loop and a top 3D polygon loop."""
    bm = bmesh.new()
    vb = [bm.verts.new(tuple(p)) for p in pts_bot]
    vt = [bm.verts.new(tuple(p)) for p in pts_top]
    bm.faces.new(vb[::-1])
    bm.faces.new(vt)
    n = len(vb)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((vb[i], vb[j], vt[j], vt[i]))
    return finalize_mesh(bm, name, mat, col, bevel_offset=bevel, bevel_segments=segments, parent=parent)


def add_lofted_sections(name, sections, mat, col, bevel=0.06, segments=2, cap_ends=True, smooth=False, parent=None):
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


def add_cylinder(name, center, r1, r2, depth, mat, col, segments=18, rot=(0.0, 0.0, 0.0), smooth=True, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r1, radius2=r2, depth=depth)
    obj = finalize_mesh(bm, name, mat, col, bevel_offset=0.0, smooth=smooth, parent=parent)
    obj.location = center
    obj.rotation_euler = rot
    return obj


def add_oriented_beam(name, p0, p1, width, height, mat, col, bevel=0.015, parent=None):
    """Create a beveled rectangular trim/lip bar aligned mathematically between two 3D points."""
    v0, v1 = Vector(p0), Vector(p1)
    diff = v1 - v0
    length = diff.length
    if length < 0.01:
        return None
    mid = (v0 + v1) * 0.5
    x_ax = diff.normalized()
    up = Vector((0, 0, 1))
    if abs(x_ax.dot(up)) > 0.96:
        up = Vector((1, 0, 0))
    y_ax = up.cross(x_ax).normalized()
    z_ax = x_ax.cross(y_ax).normalized()
    rot = Matrix((
        (x_ax.x, y_ax.x, z_ax.x),
        (x_ax.y, y_ax.y, z_ax.y),
        (x_ax.z, y_ax.z, z_ax.z),
    )).to_euler()
    return add_beveled_box(name, mid, (length, width, height), mat, col, bevel=bevel, rot=rot, parent=parent)


def add_louver_bank(name, p0, p1, depth_vec, height_p0, height_p1, count, mat, col, parent, fin_thickness=0.045):
    """Build an entire dense radiator heatsink louver bank as ONE clean combined BMesh (fast & ultra-crisp!)."""
    v0, v1 = Vector(p0), Vector(p1)
    dvec = Vector(depth_vec)
    span = v1 - v0
    if span.length < 0.05 or count < 1:
        return None
    tangent = span.normalized()
    depth_dir = dvec.normalized()
    up = Vector((0, 0, 1))
    # Build local basis for each vertical fin: local X = tangent (thickness), local Y = depth_dir, local Z = up
    # Orthonormalize depth_dir against tangent & up
    depth_perp = up.cross(tangent).normalized()
    if depth_perp.dot(depth_dir) < 0:
        depth_perp = -depth_perp
    rot_m = Matrix((
        (tangent.x, depth_perp.x, up.x, 0.0),
        (tangent.y, depth_perp.y, up.y, 0.0),
        (tangent.z, depth_perp.z, up.z, 0.0),
        (0.0, 0.0, 0.0, 1.0),
    ))

    bm = bmesh.new()
    fin_depth = dvec.length
    for i in range(count):
        t = (i + 0.5) / count
        pos = v0.lerp(v1, t)
        h = height_p0 * (1.0 - t) + height_p1 * t
        m = Matrix.Translation(pos) @ rot_m @ Matrix.Diagonal((fin_thickness, fin_depth, h, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    return finalize_mesh(bm, name, mat, col, bevel_offset=0.0, parent=parent)


def add_vent_grille(name, center, size_xy, z_top, mats, col, parent, rot_z=0.0, slats=6):
    """Flush recessed dark slatted vent grille set neatly into a dorsal armor surface."""
    cx, cy = center
    sx, sy = size_xy
    add_beveled_box(f"{name}_Frame", (cx, cy, z_top - 0.015), (sx, sy, 0.055), mats["slate"], col, bevel=0.012, rot=(0.0, 0.0, rot_z), parent=parent)
    add_beveled_box(f"{name}_Cavity", (cx, cy, z_top + 0.002), (sx * 0.84, sy * 0.84, 0.03), mats["cavity_black"], col, bevel=0.004, rot=(0.0, 0.0, rot_z), parent=parent)
    bm = bmesh.new()
    rot_m = Matrix.Rotation(rot_z, 4, "Z")
    for k in range(slats):
        t = -0.36 + (k / max(1, slats - 1)) * 0.72
        if sy >= sx:
            loc = Vector((0.0, t * sy, 0.015))
            dims = (sx * 0.80, sy * 0.045, 0.025)
        else:
            loc = Vector((t * sx, 0.0, 0.015))
            dims = (sx * 0.045, sy * 0.80, 0.025)
        m = Matrix.Translation((cx, cy, z_top)) @ rot_m @ Matrix.Translation(loc) @ Matrix.Diagonal((*dims, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    finalize_mesh(bm, f"{name}_Slats", mats["steel"], col, bevel_offset=0.0, parent=parent)


# ---------------------------------------------------------------------------
# 1. CORAL-RED ASYMMETRIC TOP CROSSBAR & DIAGONAL STRUT (+Y, shifted right!)
# ---------------------------------------------------------------------------

def build_red_crossbar(mats, col, root):
    """Asymmetric Coral-Red top bar (X in [-2.75, +8.60], Y in [+4.3, +8.68]) + diagonal strut
    enclosing the iconic OPEN TRIANGULAR APERTURE (X in [+0.4, +3.5], Y in [+1.5, +4.3])!
    """
    # Main Red Bar Upper Sleek Beveled Armor Skin (Z: +0.34 -> +0.96, gently sloping toward edges!)
    red_outer_2d = [
        (-2.72, 8.65),
        (7.45, 8.68),
        (8.55, 5.95),
        (5.45, 4.30),
        (0.95, 4.30),
        (0.85, 6.65),
        (-1.55, 6.65),
        (-2.00, 4.50),
    ]
    # Note: slight inset on top loop creates crisp aerospace chamfered bevels!
    red_top_pts = [
        (-2.58, 8.52, 0.94),
        (7.28, 8.54, 0.96),
        (8.30, 5.98, 0.88),
        (5.38, 4.44, 0.96),
        (1.08, 4.44, 0.98),
        (0.96, 6.72, 1.02),
        (-1.46, 6.72, 1.00),
        (-1.90, 4.62, 0.94),
    ]
    red_mid_top = [(x, y, 0.36) for (x, y) in red_outer_2d]
    add_tapered_prism("Red_Bar_UpperShell", red_mid_top, red_top_pts, mats["red"], col, bevel=0.055, segments=2, parent=root)

    # Main Red Bar Lower Sleek Beveled Armor Skin (Z: -0.94 -> -0.36, mirror sleek profile!)
    red_bot_pts = [
        (-2.58, 8.52, -0.90),
        (7.28, 8.54, -0.92),
        (8.30, 5.98, -0.82),
        (5.38, 4.44, -0.92),
        (1.08, 4.44, -0.94),
        (0.96, 6.72, -0.96),
        (-1.46, 6.72, -0.94),
        (-1.90, 4.62, -0.90),
    ]
    red_mid_bot = [(x, y, -0.36) for (x, y) in red_outer_2d]
    add_tapered_prism("Red_Bar_LowerShell", red_bot_pts, red_mid_bot, mats["red"], col, bevel=0.055, segments=2, parent=root)

    # Recessed Dark Structural Core sandwiched inside Red Bar (recessed inward from back, left & right edges!)
    red_core_2d = [
        (-2.22, 8.15),
        (7.15, 8.18),
        (7.85, 6.02),
        (5.25, 4.62),
        (1.22, 4.62),
        (1.08, 6.82),
        (-1.58, 6.82),
        (-1.72, 4.78),
    ]
    add_extruded_poly("Red_Bar_InnerCore", red_core_2d, -0.44, 0.44, mats["cavity_black"], col, axis="Z", bevel=0.02, parent=root)

    # FULL-WIDTH REAR RADIATOR EXHAUST TRENCH along Y = +8.65 (signature hero detail of 22.01.53 Back View!)
    # Sleek gunmetal framing rails top & bottom + 56 ultra-dense vertical dark cooling fins!
    add_beveled_box("Red_Rear_FrameTop", (2.38, 8.58, 0.36), (9.95, 0.24, 0.08), mats["slate"], col, bevel=0.015, parent=root)
    add_beveled_box("Red_Rear_FrameBot", (2.38, 8.58, -0.36), (9.95, 0.24, 0.08), mats["slate"], col, bevel=0.015, parent=root)
    add_beveled_box("Red_Rear_MidDivider", (-1.15, 8.52, 0.0), (0.38, 0.32, 0.72), mats["slate"], col, bevel=0.02, parent=root)
    add_louver_bank(
        "Red_Rear_Louvers_Main",
        (-0.85, 8.42, 0.0),
        (7.15, 8.44, 0.0),
        (0.0, 0.36, 0.0),
        0.64,
        0.64,
        52,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.055,
    )
    add_louver_bank(
        "Red_Rear_Louvers_Left",
        (-2.45, 8.40, 0.0),
        (-1.42, 8.42, 0.0),
        (0.0, 0.34, 0.0),
        0.60,
        0.62,
        9,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.055,
    )

    # Angled Outer-Right Recessed Vent Mouth on Red Bar (seated flush inside right bevel — 22.02.04 & 22.01.18!)
    add_beveled_box("Red_RightMouth_Rim", (7.86, 7.22, 0.0), (0.48, 2.15, 0.78), mats["slate"], col, bevel=0.035, rot=(0.0, 0.0, 0.39), parent=root)
    add_beveled_box("Red_RightMouth_Cavity", (7.98, 7.18, 0.0), (0.36, 1.72, 0.52), mats["cavity_black"], col, bevel=0.015, rot=(0.0, 0.0, 0.39), parent=root)
    add_beveled_box("Red_RightMouth_Baffle", (7.90, 7.20, 0.0), (0.42, 0.12, 0.46), mats["steel"], col, bevel=0.01, rot=(0.0, 0.0, 0.39), parent=root)

    # Exposed Mechanical Left Flank Trench on Red Bar (prominent left half of 22.00.56 Left Side View!)
    add_beveled_box("Red_LeftFlank_Cavity", (-2.28, 6.55, 0.0), (0.42, 3.75, 0.72), mats["cavity_black"], col, bevel=0.02, rot=(0.0, 0.0, 0.19), parent=root)
    add_cylinder(
        "Red_LeftFlank_MainShaft",
        (-2.42, 6.60, 0.04),
        0.13, 0.13, 3.55,
        mats["gunmetal"], col, segments=14, rot=(math.pi / 2.0, 0.0, 0.19), parent=root,
    )
    for ry in (5.30, 6.15, 7.00, 7.85):
        rx = -2.02 - (ry - 4.50) * 0.18
        add_beveled_box(f"Red_LeftFlank_Bracket_{ry:.2f}", (rx, ry, 0.04), (0.28, 0.24, 0.34), mats["steel"], col, bevel=0.015, rot=(0.0, 0.0, 0.19), parent=root)
    add_louver_bank(
        "Red_LeftFlank_LowerFins",
        (-1.95, 4.95, -0.22),
        (-2.55, 8.15, -0.22),
        (-0.24, 0.0, 0.0),
        0.24,
        0.24,
        22,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.045,
    )

    # SIGNATURE CORAL-RED DIAGONAL STRUT (encloses the open triangular hole cleanly!)
    # Sweeps from Red Bar front (+3.65..+5.35, +4.45) diagonally down-left to White/Yellow junction (+2.55..+3.72, +0.35)!
    strut_2d = [
        (3.62, 4.55),
        (5.32, 4.55),
        (3.74, 0.30),
        (2.58, 0.45),
    ]
    strut_top = [
        (3.72, 4.52, 0.94),
        (5.20, 4.52, 0.92),
        (3.66, 0.38, 0.86),
        (2.68, 0.50, 0.88),
    ]
    strut_bot = [
        (3.72, 4.52, -0.84),
        (5.20, 4.52, -0.82),
        (3.66, 0.38, -0.78),
        (2.68, 0.50, -0.80),
    ]
    add_tapered_prism("Red_DiagonalStrut_Upper", [(x, y, 0.22) for x, y in strut_2d], strut_top, mats["red"], col, bevel=0.05, segments=2, parent=root)
    add_tapered_prism("Red_DiagonalStrut_Lower", strut_bot, [(x, y, -0.22) for x, y in strut_2d], mats["red"], col, bevel=0.05, segments=2, parent=root)
    # Dark inner core connecting upper & lower strut skins (visible inside triangular hole!)
    strut_core_2d = [(3.78, 4.45), (5.14, 4.45), (3.62, 0.45), (2.74, 0.55)]
    add_extruded_poly("Red_DiagonalStrut_Core", strut_core_2d, -0.35, 0.35, mats["gunmetal"], col, axis="Z", bevel=0.02, parent=root)
    # Crisp dark bevel accent crease seated flush along outer right cheek of the diagonal red strut (22.02.04!)
    add_oriented_beam("Red_OuterCrease_Trim", (5.24, 4.46, 0.30), (3.70, 0.42, 0.28), 0.12, 0.12, mats["slate"], col, bevel=0.015, parent=root)

    # Recessed Dark Inner Pocket on Top-Left of the Open Triangular Hole (+0.55..+1.35, +4.45..+5.95)
    add_beveled_box("Red_HoleCorner_Intake", (0.78, 5.15, 0.52), (0.85, 1.45, 0.72), mats["cavity_black"], col, bevel=0.02, rot=(0.0, 0.0, -0.18), parent=root)
    add_louver_bank(
        "Red_HoleCorner_Fins",
        (0.55, 4.65, 0.42),
        (1.05, 5.65, 0.42),
        (0.32, 0.0, 0.0),
        0.55,
        0.55,
        9,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.04,
    )

    # Flush Dorsal Detail Ports on Coral-Red Bar (matching 22.01.18 Top View!)
    add_vent_grille("Red_TopPort_Left", (-1.35, 7.65), (0.36, 0.62), 0.99, mats, col, root, slats=4)
    add_vent_grille("Red_TopPort_Mid", (1.85, 7.68), (0.62, 0.58), 0.98, mats, col, root, slats=5)
    add_beveled_box("Red_TopPort_Right", (5.92, 6.75, 0.94), (0.38, 1.05, 0.05), mats["slate"], col, bevel=0.01, parent=root)
    add_beveled_box("Red_TopSeam_Right", (6.75, 6.80, 0.94), (0.04, 3.25, 0.02), mats["cavity_black"], col, bevel=0.004, rot=(0.0, 0.0, 0.22), parent=root)


# ---------------------------------------------------------------------------
# 2. MATTE OFF-WHITE ASYMMETRIC CENTRAL Y-BRIDGE
# ---------------------------------------------------------------------------

def build_white_central_bridge(mats, col, root):
    """Iconic matte off-white asymmetric central bridge connecting Red Bar, Blue Wing & Yellow Prong."""
    # Upper Vertical White Spine extending into the Red Bar notch (X in [-1.55, +0.90], Y in [+1.5, +6.65])
    spine_2d = [
        (-1.62, 1.60),
        (0.88, 1.60),
        (0.82, 4.60),
        (1.05, 5.95),
        (0.95, 6.68),
        (-1.42, 6.68),
        (-1.95, 4.55),
    ]
    spine_top = [
        (-1.52, 1.65, 0.96),
        (0.78, 1.65, 0.96),
        (0.72, 4.55, 1.04),
        (0.95, 5.88, 1.04),
        (0.88, 6.60, 1.02),
        (-1.35, 6.60, 1.02),
        (-1.82, 4.55, 0.98),
    ]
    spine_bot = [
        (-1.52, 1.65, -0.92),
        (0.78, 1.65, -0.92),
        (0.72, 4.55, -0.94),
        (0.95, 5.88, -0.94),
        (0.88, 6.60, -0.94),
        (-1.35, 6.60, -0.94),
        (-1.82, 4.55, -0.92),
    ]
    add_tapered_prism("White_Spine_Upper", [(x, y, 0.24) for x, y in spine_2d], spine_top, mats["white"], col, bevel=0.055, segments=2, parent=root)
    add_tapered_prism("White_Spine_Lower", spine_bot, [(x, y, -0.24) for x, y in spine_2d], mats["white"], col, bevel=0.055, segments=2, parent=root)
    add_extruded_poly("White_Spine_Core", spine_2d, -0.35, 0.35, mats["slate"], col, axis="Z", bevel=0.02, parent=root)

    # Low-profile sleek sculpted Central Dorsal Ridge Crest (matches ultra-sleek 22.00.56 & 22.01.09 profile!)
    cr0 = [(-0.92, 0.55, 0.88), (0.38, 0.55, 0.88), (0.20, 0.55, 1.12), (-0.72, 0.55, 1.12)]
    cr1 = [(-1.08, 3.15, 0.94), (0.40, 3.15, 0.94), (0.18, 3.15, 1.20), (-0.84, 3.15, 1.20)]
    cr2 = [(-1.25, 5.65, 0.96), (0.28, 5.65, 0.96), (0.05, 5.65, 1.18), (-0.98, 5.65, 1.18)]
    cr3 = [(-1.18, 6.55, 0.98), (0.10, 6.55, 0.98), (-0.10, 6.55, 1.06), (-0.95, 6.55, 1.06)]
    add_lofted_sections("White_Spine_Crest", [cr0, cr1, cr2, cr3], mats["white"], col, bevel=0.05, segments=2, parent=root)

    # Swept Asymmetric Lower White Cross-Bridge (slants downward-right toward Yellow prong — 22.01.18!)
    bridge_2d = [
        (-3.12, 2.05),
        (-1.60, 2.38),
        (0.95, 2.25),
        (3.30, 1.25),
        (3.45, -2.55),
        (2.45, -2.95),
        (0.68, -0.78),
        (-1.98, -0.32),
        (-3.12, -1.62),
    ]
    bridge_top = [
        (-3.04, 1.98, 0.88),
        (-1.58, 2.28, 0.96),
        (0.90, 2.15, 0.95),
        (3.18, 1.18, 0.86),
        (3.32, -2.45, 0.82),
        (2.44, -2.82, 0.80),
        (0.70, -0.68, 0.86),
        (-1.94, -0.22, 0.88),
        (-3.04, -1.52, 0.86),
    ]
    bridge_bot = [
        (-3.04, 1.98, -0.88),
        (-1.58, 2.28, -0.92),
        (0.90, 2.15, -0.92),
        (3.18, 1.18, -0.84),
        (3.32, -2.45, -0.82),
        (2.44, -2.82, -0.80),
        (0.70, -0.68, -0.86),
        (-1.94, -0.22, -0.88),
        (-3.04, -1.52, -0.86),
    ]
    add_tapered_prism("White_Bridge_Upper", [(x, y, 0.34) for x, y in bridge_2d], bridge_top, mats["white"], col, bevel=0.055, segments=2, parent=root)
    add_tapered_prism("White_Bridge_Lower", bridge_bot, [(x, y, -0.34) for x, y in bridge_2d], mats["white"], col, bevel=0.055, segments=2, parent=root)

    # Recessed Dark Structural Core inside White Bridge (inset back from front edge so front trench is deeply recessed!)
    bridge_core_2d = [
        (-2.95, 1.85),
        (0.85, 2.05),
        (3.05, 1.05),
        (3.15, -2.15),
        (2.55, -2.35),
        (0.85, -0.35),
        (-1.90, 0.08),
        (-2.95, -1.15),
    ]
    add_extruded_poly("White_Bridge_Core", bridge_core_2d, -0.40, 0.40, mats["cavity_black"], col, axis="Z", bevel=0.02, parent=root)

    # FRONT RECESSED MECHANICAL TRENCH UNDER WHITE BRIDGE (exact match to 22.01.09 Front View center!)
    # Central silver-framed ribbed intake module + left & right recessed mechanical conduit channels!
    add_beveled_box("Bridge_Front_CenterFrame", (-0.52, -0.42, -0.02), (1.75, 0.42, 0.68), mats["slate"], col, bevel=0.025, rot=(0.0, 0.0, -0.16), parent=root)
    add_beveled_box("Bridge_Front_CenterCavity", (-0.54, -0.54, -0.02), (1.42, 0.24, 0.48), mats["cavity_black"], col, bevel=0.015, rot=(0.0, 0.0, -0.16), parent=root)
    add_louver_bank(
        "Bridge_Front_CenterLouvers",
        (-1.18, -0.44, -0.02),
        (0.10, -0.64, -0.02),
        (0.0, -0.22, 0.0),
        0.44,
        0.44,
        14,
        mats["steel"],
        col,
        root,
        fin_thickness=0.038,
    )
    # Brushed steel horizontal trim rails framing the top & bottom of the front bridge trench
    add_beveled_box("Bridge_Front_TopTrim", (-0.55, -0.50, 0.34), (2.75, 0.24, 0.08), mats["titanium"], col, bevel=0.015, rot=(0.0, 0.0, -0.16), parent=root)
    add_beveled_box("Bridge_Front_BotTrim", (-0.55, -0.50, -0.36), (2.75, 0.24, 0.08), mats["titanium"], col, bevel=0.015, rot=(0.0, 0.0, -0.16), parent=root)
    # Right angled mechanical channel running diagonally from center bridge down to Yellow prong root
    add_beveled_box("Bridge_Diag_Frame", (1.65, -1.70, -0.02), (2.45, 0.38, 0.66), mats["slate"], col, bevel=0.02, rot=(0.0, 0.0, -0.84), parent=root)
    add_louver_bank(
        "Bridge_Diag_Louvers",
        (0.85, -0.92, -0.02),
        (2.35, -2.55, -0.02),
        (-0.22, -0.20, 0.0),
        0.46,
        0.46,
        16,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.04,
    )
    # Left angled mechanical channel linking center bridge to Blue prong root
    add_beveled_box("Bridge_Left_Channel", (-2.50, -0.90, -0.02), (1.35, 0.36, 0.64), mats["slate"], col, bevel=0.02, rot=(0.0, 0.0, 0.78), parent=root)
    add_louver_bank(
        "Bridge_Left_Louvers",
        (-2.02, -0.45, -0.02),
        (-2.92, -1.35, -0.02),
        (0.18, -0.18, 0.0),
        0.46,
        0.46,
        10,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.04,
    )

    # Dark Mechanical Junction Bay at White/Red-Strut/Yellow intersection (Top View +1.7..+2.9, +0.2..+2.1!)
    add_beveled_box("Bridge_Junction_Bay", (2.18, 1.15, 0.62), (1.12, 1.85, 0.68), mats["cavity_black"], col, bevel=0.025, rot=(0.0, 0.0, -0.14), parent=root)
    add_beveled_box("Bridge_Junction_Rim", (2.18, 1.15, 0.90), (1.24, 1.98, 0.08), mats["slate"], col, bevel=0.015, rot=(0.0, 0.0, -0.14), parent=root)
    add_louver_bank(
        "Bridge_Junction_Fins",
        (2.26, 0.38, 0.82),
        (2.08, 1.88, 0.82),
        (0.75, 0.0, 0.0),
        0.22,
        0.22,
        12,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.045,
    )


# ---------------------------------------------------------------------------
# 3. CERULEAN-BLUE PORT L-WING & LONG ANGLED PRONG (-X)
# ---------------------------------------------------------------------------

def build_blue_port_wing_prong(mats, col, root):
    """Iconic Cerulean-Blue Port L-wing (extending to X=-8.7) & long forward prong (Y=-8.85)
    with front & rear radiator wings, white tip stripe, side cooler drum & gaping louver mouth!
    """
    # --- A. OUTBOARD SWEPT BLUE WING (X in [-8.70, -3.05], Y in [-2.25, +2.45]) ---
    wing_2d = [
        (-3.05, 2.45),
        (-8.45, 1.48),
        (-8.72, 0.62),
        (-8.42, -0.68),
        (-5.52, -2.18),
        (-3.05, -2.18),
    ]
    # Sleek tapered height: thicker at root (-3.05 -> ±0.92), tapering razor-thin at wingtip (-8.6 -> ±0.36)!
    def wing_z(x, sign):
        t = max(0.0, min(1.0, (-x - 3.05) / (8.72 - 3.05)))
        return sign * (0.94 * (1.0 - t) + 0.38 * t)

    wing_top = [(x + (0.10 if x < -7.5 else 0.0), y, wing_z(x, 1.0)) for x, y in wing_2d]
    wing_bot = [(x + (0.10 if x < -7.5 else 0.0), y, wing_z(x, -1.0)) for x, y in wing_2d]
    wing_mid_hi = [(x, y, wing_z(x, 0.34)) for x, y in wing_2d]
    wing_mid_lo = [(x, y, wing_z(x, -0.34)) for x, y in wing_2d]

    add_tapered_prism("Blue_Wing_UpperShell", wing_mid_hi, wing_top, mats["blue"], col, bevel=0.055, segments=2, parent=root)
    add_tapered_prism("Blue_Wing_LowerShell", wing_bot, wing_mid_lo, mats["blue"], col, bevel=0.055, segments=2, parent=root)

    # Recessed dark wing core tapered cleanly inside the wingtip (NEVER pokes through thin outer tip!)
    wcore_2d = [
        (-3.18, 2.02),
        (-7.75, 1.22),
        (-7.90, 0.55),
        (-7.72, -0.46),
        (-5.42, -1.78),
        (-3.18, -1.78),
    ]
    add_extruded_poly("Blue_Wing_Core", wcore_2d, -0.26, 0.26, mats["cavity_black"], col, axis="Z", bevel=0.015, parent=root)

    # 1) FRONT SWEPT WEDGE RADIATOR INTAKE BAY (exact 3D-endpoint brushed titanium lips — zero sticking out!)
    add_oriented_beam("Blue_FrontIntake_LipTop", (-8.34, -0.68, 0.16), (-5.50, -2.14, 0.36), 0.18, 0.075, mats["titanium"], col, bevel=0.014, parent=root)
    add_oriented_beam("Blue_FrontIntake_LipBot", (-8.34, -0.68, -0.16), (-5.50, -2.14, -0.36), 0.18, 0.075, mats["titanium"], col, bevel=0.014, parent=root)
    add_louver_bank(
        "Blue_FrontIntake_Louvers",
        (-8.16, -0.72, 0.0),
        (-5.55, -2.02, 0.0),
        (0.18, 0.34, 0.0),
        0.26,
        0.66,
        28,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.042,
    )

    # 2) REAR SWEPT WEDGE RADIATOR EXHAUST BAY (exact 3D-endpoint slate lips — 22.01.53 Back View!)
    add_oriented_beam("Blue_RearIntake_LipTop", (-8.36, 1.46, 0.17), (-3.12, 2.42, 0.40), 0.20, 0.075, mats["slate"], col, bevel=0.014, parent=root)
    add_oriented_beam("Blue_RearIntake_LipBot", (-8.36, 1.46, -0.17), (-3.12, 2.42, -0.40), 0.20, 0.075, mats["slate"], col, bevel=0.014, parent=root)
    add_beveled_box("Blue_RearIntake_Pillar", (-5.65, 1.92, 0.0), (0.36, 0.26, 0.56), mats["slate"], col, bevel=0.02, rot=(0.0, 0.0, 0.18), parent=root)
    add_louver_bank(
        "Blue_RearIntake_LouversIn",
        (-3.32, 2.34, 0.0),
        (-5.42, 1.96, 0.0),
        (0.05, -0.34, 0.0),
        0.72,
        0.54,
        18,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.045,
    )
    add_louver_bank(
        "Blue_RearIntake_LouversOut",
        (-5.88, 1.88, 0.0),
        (-8.18, 1.46, 0.0),
        (0.05, -0.32, 0.0),
        0.52,
        0.26,
        18,
        mats["gunmetal"],
        col,
        root,
        fin_thickness=0.042,
    )

    # 3) OUTER WINGTIP RECESSED MECHANICAL PORT (seen dead-center in 22.00.56 Left Side View!)
    add_beveled_box("Blue_Tip_Frame", (-8.55, 0.36, 0.0), (0.38, 1.65, 0.56), mats["titanium"], col, bevel=0.03, parent=root)
    add_beveled_box("Blue_Tip_Cavity", (-8.64, 0.36, 0.0), (0.28, 1.25, 0.34), mats["cavity_black"], col, bevel=0.015, parent=root)
    add_cylinder("Blue_Tip_Pipe", (-8.58, 0.36, 0.0), 0.11, 0.11, 1.15, mats["gunmetal"], col, segments=12, rot=(math.pi / 2.0, 0.0, 0.0), parent=root)

    # Dorsal Recessed Slatted Vent Grilles on Blue Wing (exact match to 22.01.18 Top View!)
    add_vent_grille("Blue_DorsalVent_Back", (-3.85, 1.92), (1.15, 0.62), 0.88, mats, col, root, rot_z=0.14, slats=7)
    add_vent_grille("Blue_DorsalVent_Mid", (-3.55, 0.82), (0.68, 1.02), 0.90, mats, col, root, slats=6)
    add_vent_grille("Blue_DorsalVent_Tip", (-7.68, 0.05), (0.28, 0.62), 0.49, mats, col, root, slats=4)

    # --- B. LONG FORWARD BLUE PRONG (Y: -2.0 -> -8.85, angled tip w/ WHITE STRIPE & HOLLOW MOUTH!) ---
    # Rear solid armored body (Y: -1.95 -> -6.10)
    bp0 = [
        (-5.52, -1.95, -0.82), (-3.05, -1.95, -0.88),
        (-2.90, -1.95, 0.0), (-3.05, -1.95, 0.88),
        (-5.52, -1.95, 0.82), (-5.68, -1.95, 0.0),
    ]
    bp1 = [
        (-5.34, -6.10, -0.80), (-3.12, -6.10, -0.84),
        (-2.98, -6.10, 0.0), (-3.12, -6.10, 0.84),
        (-5.34, -6.10, 0.80), (-5.48, -6.10, 0.0),
    ]
    add_lofted_sections("Blue_Prong_Body", [bp0, bp1], mats["blue"], col, bevel=0.06, segments=2, parent=root)

    # Sleek White-Trimmed Side Recessed Cylindrical Cooler Bay along Outer Blue Cheek (22.00.56 mid-right!)
    add_beveled_box("Blue_SideCooler_WhiteTrim", (-5.44, -3.55, -0.44), (0.24, 2.35, 0.34), mats["white"], col, bevel=0.025, parent=root)
    add_beveled_box("Blue_SideCooler_Cavity", (-5.50, -3.65, -0.44), (0.22, 1.55, 0.26), mats["cavity_black"], col, bevel=0.01, parent=root)
    add_cylinder("Blue_SideCooler_Drum", (-5.52, -3.65, -0.44), 0.11, 0.11, 1.42, mats["gunmetal"], col, segments=14, rot=(math.pi / 2.0, 0.0, 0.0), parent=root)
    for ry in (-4.18, -3.92, -3.65, -3.38, -3.12):
        add_cylinder(f"Blue_SideCooler_Ring_{ry:.2f}", (-5.52, ry, -0.44), 0.125, 0.125, 0.05, mats["steel"], col, segments=14, rot=(math.pi / 2.0, 0.0, 0.0), parent=root)

    # Forward Hollow Blue Prong Shroud (Y: -6.05 -> -8.85 angled front cut!)
    # 1) Upper Blue Hood (Y: -6.05 -> angled split line at Y = -7.65 outer / -8.05 inner)
    bh0 = [(-5.34, -6.05, 0.42), (-3.12, -6.05, 0.42), (-3.12, -6.05, 0.84), (-5.34, -6.05, 0.80)]
    bh1 = [(-5.26, -7.62, 0.36), (-3.22, -8.02, 0.36), (-3.22, -8.02, 0.72), (-5.26, -7.62, 0.70)]
    add_lofted_sections("Blue_Prong_UpperHood", [bh0, bh1], mats["blue"], col, bevel=0.045, segments=2, parent=root)

    # 2) Signature Angled Crisp Off-White Tip Stripe (22.01.18 bottom-left & pi.png foreground!)
    ws0 = [(-5.26, -7.60, 0.36), (-3.22, -8.00, 0.36), (-3.22, -8.00, 0.72), (-5.26, -7.60, 0.70)]
    ws1 = [(-5.18, -8.38, 0.32), (-3.32, -8.84, 0.32), (-3.32, -8.84, 0.64), (-5.18, -8.38, 0.62)]
    add_lofted_sections("Blue_Prong_WhiteTip", [ws0, ws1], mats["white"], col, bevel=0.04, segments=2, parent=root)

    # 3) Lower Blue/Titanium Chin Jaw extending to angled tip
    bj0 = [(-5.34, -6.05, -0.80), (-3.12, -6.05, -0.84), (-3.12, -6.05, -0.44), (-5.34, -6.05, -0.42)]
    bj1 = [(-5.18, -8.38, -0.72), (-3.32, -8.84, -0.76), (-3.32, -8.84, -0.42), (-5.18, -8.38, -0.40)]
    add_lofted_sections("Blue_Prong_LowerJaw", [bj0, bj1], mats["blue"], col, bevel=0.04, segments=2, parent=root)

    # 4) Outer Blue Side Wall (sweeps smoothly to Y=-8.38 w/ crisp vertical side notch at tip like 22.00.56!)
    bo0 = [(-5.34, -6.05, -0.78), (-5.14, -6.05, -0.42), (-5.14, -6.05, 0.42), (-5.34, -6.05, 0.78), (-5.48, -6.05, 0.0)]
    bo1 = [(-5.22, -7.85, -0.72), (-5.02, -7.85, -0.40), (-5.02, -7.85, 0.36), (-5.22, -7.85, 0.68), (-5.36, -7.85, 0.0)]
    add_lofted_sections("Blue_Prong_OuterWall", [bo0, bo1], mats["blue"], col, bevel=0.04, segments=2, parent=root)

    # 5) Inner Blue/White Side Wall (notched open near tip to reveal brushed silver mouth & piston like 22.01.09!)
    bi0 = [(-3.12, -6.05, 0.82), (-3.32, -6.05, 0.42), (-3.32, -6.05, -0.42), (-3.12, -6.05, -0.82), (-2.98, -6.05, 0.0)]
    bi1 = [(-3.26, -7.95, 0.72), (-3.44, -7.95, 0.36), (-3.44, -7.95, -0.40), (-3.26, -7.95, -0.76), (-3.12, -7.95, 0.0)]
    add_lofted_sections("Blue_Prong_InnerWall", [bi0, bi1], mats["blue"], col, bevel=0.04, segments=2, parent=root)

    # Thick Brushed Silver-Titanium Mouth Bezel Collar & Open Inner Side Piston (22.01.09 left foreground!)
    add_beveled_box("Blue_Mouth_BezelTop", (-4.25, -8.42, 0.34), (1.76, 0.56, 0.09), mats["titanium"], col, bevel=0.02, rot=(0.0, 0.0, -0.23), parent=root)
    add_beveled_box("Blue_Mouth_BezelBot", (-4.25, -8.42, -0.42), (1.76, 0.56, 0.09), mats["titanium"], col, bevel=0.02, rot=(0.0, 0.0, -0.23), parent=root)
    add_beveled_box("Blue_Mouth_BezelOut", (-5.12, -8.12, -0.04), (0.14, 0.62, 0.84), mats["titanium"], col, bevel=0.02, parent=root)
    add_beveled_box("Blue_Mouth_BezelIn", (-3.38, -8.52, -0.04), (0.14, 0.58, 0.84), mats["titanium"], col, bevel=0.02, parent=root)
    # Inner side hydraulic joint exposed right beside the silver mouth lip (22.01.09!)
    add_cylinder("Blue_Mouth_InnerPiston", (-3.18, -8.25, -0.22), 0.11, 0.11, 0.72, mats["steel"], col, segments=12, rot=(math.pi / 2.0, 0.0, 0.0), parent=root)

    # DEEP HOLLOW BLUE MOUTH INTERIOR: Two stacked horizontal banks of ultra-dense vertical radiator louvers (22.01.09!)
    add_beveled_box("Blue_Mouth_DeepBack", (-4.25, -6.25, -0.02), (1.88, 0.32, 0.92), mats["cavity_black"], col, bevel=0.02, parent=root)
    add_beveled_box("Blue_Mouth_MidShelf", (-4.25, -7.55, -0.04), (1.66, 1.45, 0.07), mats["slate"], col, bevel=0.012, rot=(0.0, 0.0, -0.20), parent=root)
    add_louver_bank("Blue_Mouth_LouversTop", (-5.02, -7.65, 0.16), (-3.48, -7.96, 0.16), (0.0, 0.78, 0.0), 0.32, 0.32, 22, mats["gunmetal"], col, root, fin_thickness=0.036)
    add_louver_bank("Blue_Mouth_LouversBot", (-5.02, -7.65, -0.22), (-3.48, -7.96, -0.22), (0.0, 0.78, 0.0), 0.34, 0.34, 22, mats["gunmetal"], col, root, fin_thickness=0.036)

    # Crisp Flush Transverse Panel Seam on Blue Prong Top (22.01.18!)
    add_beveled_box("Blue_Prong_Seam", (-4.24, -5.95, 0.83), (2.15, 0.035, 0.02), mats["cavity_black"], col, bevel=0.004, rot=(0.0, 0.0, -0.10), parent=root)


# ---------------------------------------------------------------------------
# 4. TWO-TONE OCHRE/SAND-YELLOW STARBOARD PRONG & STUBBY CHEEK (+X)
# ---------------------------------------------------------------------------

def build_yellow_stbd_wing_prong(mats, col, root):
    """Asymmetric Two-Tone Starboard Prong: pale sand-yellow stubby shoulder (Y in [-3.4, +0.4])
    with dual dorsal vents & side intake drum + deeper golden-ochre forward nose prong (Y in [-8.9, -3.3])!
    """
    # --- A. PALE SAND-YELLOW STUBBY SHOULDER & CHEEK (X in [+2.85, +7.35], Y in [-3.45, +0.45]) ---
    sh_2d = [
        (3.25, 0.45),
        (5.55, -0.20),
        (7.32, -1.25),
        (5.85, -3.45),
        (2.85, -3.45),
        (2.85, -1.40),
    ]
    def sh_z(x, sign):
        t = max(0.0, min(1.0, (x - 3.10) / (7.32 - 3.10)))
        return sign * (0.86 * (1.0 - t) + 0.46 * t)

    sh_top = [(x - (0.08 if x > 6.5 else 0.0), y, sh_z(x, 1.0)) for x, y in sh_2d]
    sh_bot = [(x - (0.08 if x > 6.5 else 0.0), y, sh_z(x, -1.0)) for x, y in sh_2d]
    sh_mid_hi = [(x, y, sh_z(x, 0.34)) for x, y in sh_2d]
    sh_mid_lo = [(x, y, sh_z(x, -0.34)) for x, y in sh_2d]

    add_tapered_prism("Yellow_Shoulder_Upper", sh_mid_hi, sh_top, mats["yellow_sand"], col, bevel=0.05, segments=2, parent=root)
    add_tapered_prism("Yellow_Shoulder_Lower", sh_bot, sh_mid_lo, mats["yellow_sand"], col, bevel=0.05, segments=2, parent=root)
    sh_core = [(3.35, 0.22), (5.35, -0.35), (6.68, -1.28), (5.58, -3.22), (3.05, -3.22), (3.05, -1.45)]
    add_extruded_poly("Yellow_Shoulder_Core", sh_core, -0.45, 0.45, mats["cavity_black"], col, axis="Z", bevel=0.02, parent=root)

    # Outer Cheek Recessed Intake Cavern & Horizontal Ribbed Drum (aligned FLUSH along cheek edge — 22.02.04 & 22.01.18!)
    # Cheek edge runs from (7.32, -1.25) -> (5.85, -3.45): local Y axis rotated by -0.59 rad points along (+0.56, +0.83)!
    add_beveled_box("Yellow_SideCheek_Bezel", (6.46, -2.26, 0.0), (0.48, 2.02, 0.60), mats["titanium"], col, bevel=0.03, rot=(0.0, 0.0, -0.59), parent=root)
    add_beveled_box("Yellow_SideCheek_Cavity", (6.52, -2.30, 0.0), (0.38, 1.62, 0.42), mats["cavity_black"], col, bevel=0.015, rot=(0.0, 0.0, -0.59), parent=root)
    add_cylinder("Yellow_SideCheek_Drum", (6.50, -2.28, -0.02), 0.13, 0.13, 1.32, mats["gunmetal"], col, segments=14, rot=(math.pi / 2.0, 0.0, -0.59), parent=root)
    for k in range(5):
        t = -0.44 + k * 0.22
        add_cylinder(
            f"Yellow_SideCheek_Ring_{k}",
            (6.50 + t * 0.55, -2.28 + t * 0.83, -0.02),
            0.15, 0.15, 0.05,
            mats["steel"], col, segments=14, rot=(math.pi / 2.0, 0.0, -0.59), parent=root,
        )

    # Two Prominent Dark Slatted Dorsal Vent Grilles strictly inside the Sand-Yellow Shoulder (22.01.18 Top View!)
    add_vent_grille("Yellow_ShoulderVent_Top", (4.35, -0.52), (1.28, 0.72), 0.78, mats, col, root, rot_z=-0.22, slats=8)
    add_vent_grille("Yellow_ShoulderVent_Mid", (4.76, -1.78), (0.56, 1.12), 0.74, mats, col, root, rot_z=-0.08, slats=7)

    # --- B. DEEPER GOLDEN-OCHRE FORWARD PRONG (Y: -3.35 -> -8.88, stepped cheek + HOLLOW HEX MOUTH!) ---
    # Rear solid body (Y: -3.35 -> -6.10; notice subtle inner step at Y=-3.35 seen in 22.01.18!)
    yp0 = [
        (2.48, -3.35, -0.82), (5.72, -3.35, -0.78),
        (5.88, -3.35, 0.0), (5.68, -3.35, 0.76),
        (2.58, -3.35, 0.80), (2.38, -3.35, 0.0),
    ]
    yp1 = [
        (2.75, -6.10, -0.82), (5.42, -6.10, -0.78),
        (5.58, -6.10, 0.0), (5.36, -6.10, 0.74),
        (2.84, -6.10, 0.78), (2.64, -6.10, 0.0),
    ]
    add_lofted_sections("Yellow_Prong_Body", [yp0, yp1], mats["yellow_gold"], col, bevel=0.055, segments=2, parent=root)

    # Small recessed dark lower flank vent mid-prong (seen on bottom-left of 22.02.04 Right Side View!)
    add_beveled_box("Yellow_Flank_LowerVent", (5.58, -4.95, -0.58), (0.28, 1.25, 0.24), mats["cavity_black"], col, bevel=0.015, parent=root)
    add_louver_bank("Yellow_Flank_VentFins", (5.66, -5.45, -0.58), (5.66, -4.45, -0.58), (-0.18, 0.0, 0.0), 0.20, 0.20, 8, mats["gunmetal"], col, root, fin_thickness=0.04)

    # Forward Hollow Yellow Prong Shroud (Y: -6.05 -> -8.88) — 4 beveled armor walls around deep open mouth!
    yh0 = [(2.84, -6.05, 0.40), (5.36, -6.05, 0.40), (5.36, -6.05, 0.74), (2.84, -6.05, 0.78)]
    yh1 = [(3.06, -8.84, 0.30), (5.06, -8.62, 0.30), (5.02, -8.62, 0.62), (3.12, -8.84, 0.64)]
    add_lofted_sections("Yellow_Prong_UpperHood", [yh0, yh1], mats["yellow_gold"], col, bevel=0.045, segments=2, parent=root)

    yj0 = [(2.75, -6.05, -0.82), (5.42, -6.05, -0.78), (5.34, -6.05, -0.42), (2.84, -6.05, -0.44)]
    yj1 = [(3.06, -8.84, -0.76), (5.04, -8.62, -0.72), (4.98, -8.62, -0.40), (3.12, -8.84, -0.42)]
    add_lofted_sections("Yellow_Prong_LowerJaw", [yj0, yj1], mats["yellow_gold"], col, bevel=0.04, segments=2, parent=root)

    yo0 = [(5.36, -6.05, 0.72), (5.16, -6.05, 0.40), (5.18, -6.05, -0.42), (5.40, -6.05, -0.76), (5.56, -6.05, 0.0)]
    yo1 = [(5.08, -8.08, 0.64), (4.92, -8.08, 0.32), (4.92, -8.08, -0.40), (5.10, -8.08, -0.72), (5.24, -8.08, 0.0)]
    add_lofted_sections("Yellow_Prong_OuterWall", [yo0, yo1], mats["yellow_gold"], col, bevel=0.04, segments=2, parent=root)

    yi0 = [(2.84, -6.05, 0.76), (2.64, -6.05, 0.0), (2.75, -6.05, -0.80), (2.98, -6.05, -0.42), (2.98, -6.05, 0.40)]
    yi1 = [(3.08, -8.25, 0.66), (2.88, -8.25, 0.0), (2.98, -8.25, -0.76), (3.20, -8.25, -0.40), (3.20, -8.25, 0.34)]
    add_lofted_sections("Yellow_Prong_InnerWall", [yi0, yi1], mats["yellow_gold"], col, bevel=0.04, segments=2, parent=root)

    # Brushed Titanium/Ochre Front Mouth Bezel & Exposed Inner Piston (22.01.09 right foreground!)
    add_beveled_box("Yellow_Mouth_BezelTop", (4.06, -8.68, 0.32), (1.88, 0.48, 0.085), mats["titanium"], col, bevel=0.018, rot=(0.0, 0.0, 0.11), parent=root)
    add_beveled_box("Yellow_Mouth_BezelBot", (4.06, -8.68, -0.42), (1.88, 0.48, 0.085), mats["titanium"], col, bevel=0.018, rot=(0.0, 0.0, 0.11), parent=root)
    add_beveled_box("Yellow_Mouth_BezelOut", (5.00, -8.46, -0.05), (0.14, 0.54, 0.80), mats["titanium"], col, bevel=0.018, parent=root)
    add_beveled_box("Yellow_Mouth_BezelIn", (3.12, -8.72, -0.05), (0.14, 0.54, 0.80), mats["titanium"], col, bevel=0.018, parent=root)
    add_cylinder("Yellow_Mouth_InnerPiston", (2.94, -8.35, -0.18), 0.11, 0.11, 0.72, mats["steel"], col, segments=12, rot=(math.pi / 2.0, 0.0, 0.0), parent=root)

    # DEEP HOLLOW YELLOW MOUTH INTERIOR: Two stacked horizontal banks of ultra-dense vertical radiator louvers!
    add_beveled_box("Yellow_Mouth_DeepBack", (4.06, -6.25, -0.04), (2.05, 0.32, 0.90), mats["cavity_black"], col, bevel=0.02, parent=root)
    add_beveled_box("Yellow_Mouth_MidShelf", (4.06, -7.65, -0.06), (1.76, 1.55, 0.07), mats["slate"], col, bevel=0.012, rot=(0.0, 0.0, 0.11), parent=root)
    add_louver_bank("Yellow_Mouth_LouversTop", (3.24, -7.95, 0.14), (4.88, -7.76, 0.14), (0.0, 0.78, 0.0), 0.32, 0.32, 22, mats["gunmetal"], col, root, fin_thickness=0.036)
    add_louver_bank("Yellow_Mouth_LouversBot", (3.24, -7.95, -0.24), (4.88, -7.76, -0.24), (0.0, 0.78, 0.0), 0.34, 0.34, 22, mats["gunmetal"], col, root, fin_thickness=0.036)

    # Crisp Flush Panel Seam & Small Light Accent Square strictly inside Yellow Prong Top (22.01.18!)
    add_beveled_box("Yellow_Prong_Seam", (4.06, -4.35, 0.782), (2.25, 0.032, 0.02), mats["cavity_black"], col, bevel=0.004, rot=(0.0, 0.0, -0.22), parent=root)
    add_beveled_box("Yellow_Prong_SmallLatch", (3.22, -4.18, 0.802), (0.34, 0.44, 0.03), mats["titanium"], col, bevel=0.008, parent=root)


# ---------------------------------------------------------------------------
# Studio/Orbital Lighting, World & 6 Verification Cameras (All 5 Ref Views + Hero)
# ---------------------------------------------------------------------------

def aim_object_at(obj, target):
    direction = Vector(target) - obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = rot_quat.to_euler()


def setup_world_and_lighting(col_stage):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Pi_Studio_World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is not None:
        bg.inputs["Color"].default_value = (0.032, 0.036, 0.044, 1.0)
        bg.inputs["Strength"].default_value = 0.85

    def add_light(name, ltype, loc, target, energy, color, size=8.0, angle=0.04):
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

    # Primary Orbital Key Sun from upper-right-front (sculpts clean aerospace highlights!)
    add_light("Orbital_Sun_Key", "SUN", (16, -12, 20), (0, 0, 0), energy=4.5, color=(1.0, 0.98, 0.95), angle=0.04)

    # Earth Cloud-Deck Cool Albedo Bounce from BELOW (illuminates underside & radiator cavities!)
    add_light("Earth_Albedo_Bounce", "AREA", (-4, -6, -18), (0, 0, 0), energy=9000.0, color=(0.76, 0.86, 1.0), size=26.0)

    # Rear-Left Cool Rim Light (separates Coral-Red rear radiator & Blue wingtip cleanly!)
    add_light("Rear_Rim_Fill", "AREA", (-14, 18, 12), (0, 2, 0), energy=4800.0, color=(0.80, 0.86, 1.0), size=20.0)

    # Front Soft Fill (keeps Front Ortho louver mouths & central bridge trench crystal-clear!)
    add_light("Front_Mouth_Fill", "AREA", (0, -24, 3), (0, -4, 0), energy=3600.0, color=(0.90, 0.94, 1.0), size=18.0)


def setup_cameras(col_stage):
    cameras = {}

    def make_cam(name, loc, target, cam_type="PERSP", lens=39.0, ortho_scale=22.0):
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

    # 1. Hero 3/4 View matching pi.png exact perspective & composition!
    make_cam("Cam_Hero_34", (-15.2, -17.5, 5.4), (0.3, -0.3, 0.0), cam_type="PERSP", lens=38.0)

    # 2. Top Ortho View matching 22.01.18.png (Red bar top-right, Blue wing left, Yellow prong bottom-right!)
    c_top = make_cam("Cam_Top_Ortho", (0.0, 0.0, 28.0), (0.0, 0.0, 0.0), cam_type="ORTHO", ortho_scale=29.5)
    c_top.rotation_euler = (0.0, 0.0, 0.0)

    # 3. Front Ortho View matching 22.01.09.png (Blue mouth left, White trench center, Yellow mouth right!)
    c_front = make_cam("Cam_Front_Ortho", (0.0, -24.0, 0.05), (0.0, 0.0, 0.05), cam_type="ORTHO", ortho_scale=20.5)
    c_front.rotation_euler = (math.pi / 2.0, 0.0, 0.0)

    # 4. Back Ortho View matching 22.01.53.png (Full-width Coral-Red rear radiator left, Blue rear radiator right!)
    c_back = make_cam("Cam_Back_Ortho", (0.0, 24.0, 0.05), (0.0, 0.0, 0.05), cam_type="ORTHO", ortho_scale=20.5)
    c_back.rotation_euler = (math.pi / 2.0, 0.0, math.pi)

    # 5. Left (Port) Ortho View matching 22.00.56.png (Red left trench on left, Blue wing/cooler/prong on right!)
    c_left = make_cam("Cam_Left_Ortho", (-24.0, 0.0, 0.05), (0.0, 0.0, 0.05), cam_type="ORTHO", ortho_scale=21.0)
    c_left.rotation_euler = (math.pi / 2.0, 0.0, -math.pi / 2.0)

    # 6. Right (Starboard) Ortho View matching 22.02.04.png (Yellow prong/cheek on left, Red bar/mouth on right!)
    c_right = make_cam("Cam_Right_Ortho", (24.0, 0.0, 0.05), (0.0, 0.0, 0.05), cam_type="ORTHO", ortho_scale=21.0)
    c_right.rotation_euler = (math.pi / 2.0, 0.0, math.pi / 2.0)

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

    col_root = ensure_collection("Pi_Ship")
    col_red = ensure_collection("01_Red_Crossbar_And_Strut", col_root)
    col_white = ensure_collection("02_White_Central_Bridge", col_root)
    col_blue = ensure_collection("03_Blue_Port_Wing_Prong", col_root)
    col_yellow = ensure_collection("04_Yellow_Stbd_Wing_Prong", col_root)
    col_stage = ensure_collection("99_Stage_Lights_Cameras")

    root = bpy.data.objects.new("Pi_Ship_Root", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 2.0
    link_obj(root, col_root)

    mats = build_materials()

    build_red_crossbar(mats, col_red, root)
    build_white_central_bridge(mats, col_white, root)
    build_blue_port_wing_prong(mats, col_blue, root)
    build_yellow_stbd_wing_prong(mats, col_yellow, root)

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
        f"BUILT Asymmetric Pi_Ship: {len(mesh_objs)} meshes, "
        f"{total_verts} verts, {total_faces} faces, "
        f"hull bounds X=[{min(xs):.2f},{max(xs):.2f}] ({max(xs)-min(xs):.2f}m) "
        f"Y=[{min(ys):.2f},{max(ys):.2f}] ({max(ys)-min(ys):.2f}m) "
        f"Z=[{min(zs):.2f},{max(zs):.2f}] ({max(zs)-min(zs):.2f}m)"
    )
    return cameras


build_all()
