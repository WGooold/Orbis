"""场景小件（漫画风格）：穿梭机 shuttle、工程无人机 drone、货柜 crate、船体板 tile、中继卫星 relay、审批闸门段 gateseg、碎石 rock。
在 Blender 里执行即可重建；材质名带 Tint 的部位由网页按 Agent 颜色着色。"""
import bpy, bmesh, math, random, os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else bpy.path.abspath('//')
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for c in list(bpy.data.collections): bpy.data.collections.remove(c)
for m in list(bpy.data.materials): bpy.data.materials.remove(m)
sc = bpy.context.scene; sc.name = 'Scene_Comic'


def comic(name, deep, shadow, mid, light, spec=.16, rim=.16, rough=.22, ao=.34):
    m = bpy.data.materials.new('Mat_' + name + '_Comic'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear(); N, L = nt.nodes.new, nt.links.new
    out = N('ShaderNodeOutputMaterial'); dif = N('ShaderNodeBsdfDiffuse'); dif.inputs[0].default_value = (1, 1, 1, 1)
    s2 = N('ShaderNodeShaderToRGB'); bw = N('ShaderNodeRGBToBW'); rp = N('ShaderNodeValToRGB'); L(dif.outputs[0], s2.inputs[0]); L(s2.outputs[0], bw.inputs[0]); L(bw.outputs[0], rp.inputs[0])
    cr = rp.color_ramp; pts = [(0, deep), (.15, deep), (.18, shadow), (.43, shadow), (.46, mid), (.78, mid), (.81, light), (1, light)]
    while len(cr.elements) < 8: cr.elements.new(.5)
    for i, (p, c) in enumerate(pts): cr.elements[i].position = p; cr.elements[i].color = (*c, 1)
    cur = rp.outputs[0]
    def mix(mode, f, a, b):
        x = N('ShaderNodeMix'); x.data_type = 'RGBA'; x.blend_type = mode; x.inputs['Factor'].default_value = f; ins = [i for i in x.inputs if i.type == 'RGBA']; L(a, ins[0]); L(b, ins[1]); return [o for o in x.outputs if o.type == 'RGBA'][0]
    an = N('ShaderNodeAmbientOcclusion'); an.inputs['Distance'].default_value = .25; ar = N('ShaderNodeValToRGB'); ar.color_ramp.elements[0].position = .22; ar.color_ramp.elements[0].color = (.5, .57, .72, 1); ar.color_ramp.elements[1].position = .56; ar.color_ramp.elements[1].color = (1, 1, 1, 1); L(an.outputs['AO'], ar.inputs[0]); cur = mix('MULTIPLY', ao, cur, ar.outputs[0])
    gl = N('ShaderNodeBsdfGlossy'); gl.inputs['Roughness'].default_value = rough; g2 = N('ShaderNodeShaderToRGB'); gb = N('ShaderNodeRGBToBW'); gr = N('ShaderNodeValToRGB'); gr.color_ramp.elements[0].position = .66; gr.color_ramp.elements[0].color = (0, 0, 0, 1); gr.color_ramp.elements[1].position = .72; gr.color_ramp.elements[1].color = (1, 1, 1, 1); L(gl.outputs[0], g2.inputs[0]); L(g2.outputs[0], gb.inputs[0]); L(gb.outputs[0], gr.inputs[0]); cur = mix('ADD', spec, cur, gr.outputs[0])
    lw = N('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = .25; rr = N('ShaderNodeValToRGB'); rr.color_ramp.elements[0].position = .64; rr.color_ramp.elements[0].color = (0, 0, 0, 1); rr.color_ramp.elements[1].position = .72; rr.color_ramp.elements[1].color = (.88, .93, 1, 1); L(lw.outputs['Facing'], rr.inputs[0]); cur = mix('ADD', rim, cur, rr.outputs[0])
    em = N('ShaderNodeEmission'); L(cur, em.inputs[0]); L(em.outputs[0], out.inputs[0]); return m


def glow(name, col, e=1.6):
    m = bpy.data.materials.new('Mat_' + name + '_Comic'); m.use_nodes = True; p = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value = (*col, 1); p.inputs['Emission Color'].default_value = (*col, 1); p.inputs['Emission Strength'].default_value = e; return m


WHITE = comic('Prop_White', (.24, .32, .48), (.56, .64, .78), (.88, .91, .96), (.995, .998, 1))
GREY = comic('Prop_Grey', (.12, .15, .22), (.28, .33, .42), (.5, .56, .66), (.74, .79, .86), spec=.2)
DARK = comic('Prop_Dark', (.024, .032, .056), (.05, .062, .1), (.09, .11, .16), (.16, .19, .26), spec=.2, rim=.3)
STEEL = comic('Prop_Steel', (.2, .27, .4), (.46, .54, .68), (.76, .82, .9), (1, 1, 1), spec=.4, rim=.24, rough=.15)
TINT = comic('Prop_TintPaint', (.18, .18, .22), (.46, .46, .5), (.86, .86, .88), (1, 1, 1))
ROCK = comic('Prop_Rock', (.07, .07, .1), (.2, .19, .21), (.4, .37, .36), (.62, .58, .54), spec=.02, rim=.05)
FOIL = comic('Prop_Foil', (.3, .17, .04), (.62, .38, .1), (.92, .66, .24), (1, .88, .56), spec=.35)
GLASS = comic('Prop_Glass', (.01, .02, .05), (.03, .06, .12), (.06, .12, .22), (.2, .34, .5), spec=.6, rim=.5, rough=.1)
TGLOW = glow('Prop_TintGlow', (1, 1, 1), 1.5)
ENGINE = glow('Prop_EngineTintGlow', (1, 1, 1), 1.7)
LAMP = glow('Prop_BeaconLamp', (1, .95, .85), 1.6)

COL = None
def coll(name):
    global COL
    COL = bpy.data.collections.new(name); sc.collection.children.link(COL)
def uv(me, k=.5):
    u = me.uv_layers.new(name='UVMap')
    for p in me.polygons:
        ax = max(range(3), key=lambda i: abs(p.normal[i])); a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for li in p.loop_indices:
            c = me.vertices[me.loops[li].vertex_index].co; u.data[li].uv = (c[a] * k, c[b] * k)
def put(name, bm, mat, bevel=.02, seg=1, smooth=False):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces); me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = smooth
    if smooth: me.set_sharp_from_angle(angle=math.radians(40))
    uv(me); o = bpy.data.objects.new(COL.name + '_' + name, me); COL.objects.link(o); me.materials.append(mat)
    if bevel: b = o.modifiers.new('Bevel', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'; b.angle_limit = math.radians(32)
    return o
def box(name, c, s, mat, bevel=.02, rot=None, taper=None, seg=1):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        t = v.co.y + .5; x, y, z = v.co
        if taper: x *= 1 + (taper[0] - 1) * t; z *= 1 + (taper[1] - 1) * t
        v.co = (x * s[0], y * s[1], z * s[2])
    bm.transform(Matrix.Translation(c) @ (rot or Matrix())); return put(name, bm, mat, bevel, seg)
def cyl(name, c, r, h, ax, mat, r2=None, n=24, bevel=.012, smooth=True):
    bm = bmesh.new(); bmesh.ops.create_cone(bm, cap_ends=True, segments=n, radius1=r, radius2=r if r2 is None else r2, depth=h)
    R = {'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(-math.pi / 2, 4, 'X'), 'z': Matrix()}[ax]; bm.transform(Matrix.Translation(c) @ R); return put(name, bm, mat, bevel, 1, smooth)
def ring(name, c, r0, r1, h, ax, mat, n=32, bevel=.012):
    bm = bmesh.new(); pr = [(r0, -h / 2), (r1, -h / 2), (r1, h / 2), (r0, h / 2)]; rows = [[bm.verts.new((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z)) for r, z in pr] for i in range(n)]
    for i in range(n):
        for j in range(4): bm.faces.new((rows[i][j], rows[(i + 1) % n][j], rows[(i + 1) % n][(j + 1) % 4], rows[i][(j + 1) % 4]))
    R = {'x': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'y': Matrix.Rotation(-math.pi / 2, 4, 'X'), 'z': Matrix()}[ax]; bm.transform(Matrix.Translation(c) @ R); return put(name, bm, mat, bevel, 1, True)
def prism(name, pts, z0, z1, mat, bevel=.02, top=0.0, plane='xy'):
    bm = bmesh.new(); n = len(pts); cx, cy = sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n; sh = lambda p, k: (cx + (p[0] - cx) * (1 - k), cy + (p[1] - cy) * (1 - k))
    P = {'xy': lambda x, y, z: (x, y, z), 'yz': lambda x, y, z: (z, x, y), 'xz': lambda x, y, z: (x, z, y)}[plane]
    A = [bm.verts.new(P(*p, z0)) for p in pts]; B = [bm.verts.new(P(*sh(p, top), z1)) for p in pts]; bm.faces.new(A); bm.faces.new(B)
    for i in range(n): bm.faces.new((A[i], A[(i + 1) % n], B[(i + 1) % n], B[i]))
    return put(name, bm, mat, bevel, 1)
def mir(o):
    me = o.data.copy(); me.transform(Matrix.Scale(-1, 4, (1, 0, 0))); me.flip_normals(); c = bpy.data.objects.new(o.name + '_M', me); COL.objects.link(c)
    for m in o.modifiers: b = c.modifiers.new('Bevel', 'BEVEL'); b.width, b.segments, b.limit_method, b.angle_limit = m.width, m.segments, m.limit_method, m.angle_limit
    return c
def tube(name, pts, r, mat, n=8):
    bm = bmesh.new(); P = [Vector(p) for p in pts]; rows = []
    for i, p in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized(); u = t.orthogonal().normalized(); v = t.cross(u); rows.append([bm.verts.new(p + (u * math.cos(a) + v * math.sin(a)) * r) for a in [2 * math.pi * j / n for j in range(n)]])
    for a, b in zip(rows, rows[1:]):
        for j in range(n): bm.faces.new((a[j], a[(j + 1) % n], b[(j + 1) % n], b[j]))
    bm.faces.new(rows[0][::-1]); bm.faces.new(rows[-1]); return put(name, bm, mat, 0, 1, True)

# ================================================================ 穿梭机（会话）：机头 +Y
coll('shuttle')
prism('Hull', [(0, 1.35), (.2, 1.2), (.44, .2), (.5, -.7), (.36, -1.0), (-.36, -1.0), (-.5, -.7), (-.44, .2), (-.2, 1.2)], -.16, .1, WHITE, .03, .06)
prism('Belly', [(0, 1.15), (.16, 1.0), (.34, .1), (.36, -.8), (-.36, -.8), (-.34, .1), (-.16, 1.0)], -.28, -.16, DARK, .02, 0)
prism('Deck', [(0, .62), (.17, .46), (.27, -.2), (.25, -.86), (-.25, -.86), (-.27, -.2), (-.17, .46)], .1, .25, WHITE, .03, .12)
prism('Canopy', [(0, .98), (.13, .8), (.2, .28), (.12, .1), (-.12, .1), (-.2, .28), (-.13, .8)], .09, .27, GLASS, .03, .3)
prism('StripeTint', [(.04, .02), (.115, .02), (.15, -.82), (.05, -.82)], .245, .268, TINT, .004); mir(bpy.data.objects['shuttle_StripeTint'])
w = prism('Wing', [(.42, .34), (.95, -.35), (1.02, -.95), (.86, -1.0), (.46, -.62)], -.09, .02, WHITE, .02, .03); mir(w)
w = prism('WingTint', [(.66, -.1), (.88, -.38), (.94, -.82), (.8, -.84), (.66, -.5)], .018, .04, TINT, .004); mir(w)
p = cyl('Nacelle', (.62, -.62, -.05), .17, .86, 'y', GREY, .15, 18); mir(p)
p = ring('NacelleLip', (.62, -1.06, -.05), .115, .185, .1, 'y', DARK, 20); mir(p)
p = cyl('Engine_Core', (.62, -1.05, -.05), .115, .04, 'y', ENGINE, n=18, bevel=0); mir(p)
p = cyl('NacelleIntake', (.62, -.16, -.05), .13, .08, 'y', DARK, n=18, bevel=0); mir(p)
f = prism('Fin', [(-.55, .2), (-.86, .2), (-1.18, .66), (-1.0, .66)], .16, .2, WHITE, .012, 0, 'yz'); mir(f)
f = prism('FinTint', [(-.9, .42), (-1.02, .42), (-1.16, .645), (-1.02, .645)], .155, .205, TINT, .004, 0, 'yz'); mir(f)
box('SternBlock', (0, -.98, 0), (.6, .16, .28), DARK, .02)
box('SternTintGlow', (0, -1.07, .02), (.34, .03, .06), TGLOW, .006)
box('NoseLamp', (0, 1.28, -.1), (.1, .06, .05), LAMP, .008)
for i in range(4): box('Vent%d' % i, (0, -.36 - i * .11, .262), (.06, .05, .02), DARK, .004)

# ================================================================ 工程无人机：前方 +Y
coll('drone')
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=.34); bm.transform(Matrix.Diagonal((1.0, .95, .86, 1))); put('Body', bm, WHITE, 0, 1, True)
ring('Belt', (0, 0, 0), .33, .4, .12, 'z', GREY, 24)
ring('EyeRim', (0, .3, .02), .12, .2, .1, 'y', DARK, 20)
cyl('EyeTintGlow', (0, .335, .02), .12, .05, 'y', TGLOW, n=18, bevel=.008)
box('CapTint', (0, -.02, .28), (.2, .3, .08), TINT, .02, taper=(.7, .8))
for sx in (-1, 1):
    n = 'L' if sx < 0 else 'R'
    cyl('Shoulder' + n, (sx * .42, .06, -.02), .09, .12, 'x', GREY, n=14)
    tube('ArmA' + n, [(sx * .46, .06, -.04), (sx * .56, .2, -.16), (sx * .5, .42, -.2)], .045, STEEL, 8)
    tube('ArmB' + n, [(sx * .5, .42, -.2), (sx * .36, .62, -.12), (sx * .24, .78, -.06)], .036, GREY, 8)
    cyl('Wrist' + n, (sx * .5, .42, -.2), .07, .1, 'z', DARK, n=12)
    box('Claw1' + n, (sx * .2, .84, -.03), (.03, .14, .05), DARK, .006, Matrix.Rotation(sx * .3, 4, 'Z')); box('Claw2' + n, (sx * .26, .85, -.09), (.03, .13, .05), DARK, .006, Matrix.Rotation(-sx * .1, 4, 'Z'))
    cyl('Pod' + n, (sx * .34, -.3, .06), .1, .26, 'y', GREY, .08, 14); cyl('Engine_Core' + n, (sx * .34, -.44, .06), .07, .03, 'y', ENGINE, n=14, bevel=0)
cyl('PodC', (0, -.34, -.14), .1, .22, 'y', GREY, .08, 14); cyl('Engine_CoreC', (0, -.46, -.14), .07, .03, 'y', ENGINE, n=14, bevel=0)
tube('Aerial', [(.1, -.12, .3), (.14, -.2, .52)], .014, DARK, 6); bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=.035); bm.transform(Matrix.Translation((.14, -.2, .54))); put('AerialLamp', bm, LAMP, 0)

# ================================================================ 货柜：长轴 Y
coll('crate')
box('Core', (0, 0, 0), (1.12, 2.3, 1.12), GREY, .03)
for sx in (-1, 1):
    for sz in (-1, 1): box('Post%d%d' % (sx, sz), (sx * .58, 0, sz * .58), (.15, 2.52, .15), WHITE, .025)
for y in (-1.2, 1.2):
    for sx in (-1, 1): box('EndV%d%d' % (y > 0, sx), (sx * .58, y, 0), (.15, .13, 1.2), WHITE, .025)
    for sz in (-1, 1): box('EndH%d%d' % (y > 0, sz), (0, y, sz * .58), (1.2, .13, .15), WHITE, .025)
    box('DoorTint%d' % (y > 0), (0, y * .985, 0), (.96, .06, .96), TINT, .02); box('DoorBar%d' % (y > 0), (0, y * 1.02, 0), (.06, .05, .8), DARK, .01); box('DoorLampTintGlow%d' % (y > 0), (.3, y * 1.02, .34), (.16, .04, .07), TGLOW, .006)
for i, y in enumerate([-.84, -.42, 0, .42, .84]):
    for sx in (-1, 1): box('RibS%d%d' % (i, sx), (sx * .575, y, 0), (.07, .12, 1.06), WHITE, .015)
    for sz in (-1, 1): box('RibT%d%d' % (i, sz), (0, y, sz * .575), (1.06, .12, .07), WHITE, .015)
for sx in (-1, 1):
    for y in (-.63, .63): box('PanelTint%d%d' % (sx, y > 0), (sx * .565, y, 0), (.04, .28, .9), TINT, .01)
    box('Slit%d' % sx, (sx * .585, -.21, .3), (.03, .24, .08), DARK, .006)

# ================================================================ 船体板（六边）
coll('tile')
hexa = [(math.cos(a) * .92, math.sin(a) * .92) for a in [math.pi / 6 + i * math.pi / 3 for i in range(6)]]; ins = lambda k: [(x * k, y * k) for x, y in hexa]
prism('Base', hexa, -.1, .06, WHITE, .03, .03); prism('InsetTint', ins(.62), .05, .1, TINT, .015, .05); prism('CoreTintGlow', ins(.2), .09, .13, TGLOW, .01, .1)
for i, (x, y) in enumerate(ins(.8)): cyl('Bolt%d' % i, (x, y, .07), .05, .05, 'z', DARK, n=10, bevel=.006)
prism('Back', ins(.8), -.2, -.1, DARK, .02, 0)

# ================================================================ 中继卫星：天线朝 +Y
coll('relay')
prism('Bus', [(math.cos(a) * .62, math.sin(a) * .62) for a in [math.pi / 8 + i * math.pi / 4 for i in range(8)]], -.7, .7, WHITE, .04, .04)
prism('Foil', [(math.cos(a) * .58, math.sin(a) * .58) for a in [math.pi / 8 + i * math.pi / 4 for i in range(8)]], -.98, -.7, FOIL, .03, 0)
for i in range(4):
    a = math.pi / 4 + i * math.pi / 2; box('BusPanel%d' % i, (math.cos(a) * .6, math.sin(a) * .6, 0), (.06, .3, .8), DARK if i % 2 else TINT, .015, Matrix.Rotation(a, 4, 'Z'))
for sx in (-1, 1):
    tube('Mast%d' % sx, [(sx * .55, 0, 0), (sx * 1.15, 0, 0)], .05, STEEL, 8)
    for k in range(3):
        x = sx * (1.62 + k * .98); box('PanelFrame%d%d' % (sx, k), (x, 0, 0), (.9, .05, 1.5), WHITE, .015); box('PanelCell%d%d' % (sx, k), (x, .03, 0), (.8, .04, 1.4), GLASS, .008); box('PanelBar%d%d' % (sx, k), (x, .055, 0), (.8, .02, .04), STEEL, 0); box('PanelBarV%d%d' % (sx, k), (x, .055, 0), (.04, .02, 1.4), STEEL, 0)
bm = bmesh.new(); rows = []
for r, y in [(.0, .62), (.3, .66), (.62, .8), (.9, 1.02), (.94, 1.02), (.64, .74), (.3, .58), (.0, .54)]: rows.append([bm.verts.new((r * math.cos(a), y, r * math.sin(a))) for a in [2 * math.pi * j / 28 for j in range(28)]])
for a, b in zip(rows, rows[1:]):
    for j in range(28):
        try: bm.faces.new((a[j], a[(j + 1) % 28], b[(j + 1) % 28], b[j]))
        except ValueError: pass
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=.002); put('Dish', bm, WHITE, 0, 1, True)
for i in range(3):
    a = i * 2 * math.pi / 3 + .4; tube('DishLeg%d' % i, [(math.cos(a) * .72, .9, math.sin(a) * .72), (0, 1.38, 0)], .018, DARK, 6)
cyl('DishFeed', (0, 1.4, 0), .08, .16, 'y', GREY, n=12); cyl('DishTintGlow', (0, 1.5, 0), .05, .05, 'y', TGLOW, n=12, bevel=0)
tube('Boom', [(0, 0, .7), (0, 0, 1.5)], .03, STEEL, 6); box('BoomHead', (0, 0, 1.55), (.14, .14, .14), DARK, .02); cyl('BoomLamp', (0, 0, 1.66), .04, .06, 'z', LAMP, n=10, bevel=0)

# ================================================================ 审批闸门段：圆环面朝 Y，占 60° 减缝
coll('gateseg')
def arc(name, r0, r1, y0, y1, a0, a1, mat, n=14, bevel=.03, teeth=None):
    bm = bmesh.new(); rows = []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n; ri = r0
        if teeth and (i % 4) in (1, 2): ri = r0 - teeth
        rows.append([bm.verts.new((math.cos(a) * r, y, math.sin(a) * r)) for r, y in [(ri, y0), (r1, y0), (r1, y1), (ri, y1)]])
    for a, b in zip(rows, rows[1:]):
        for j in range(4): bm.faces.new((a[j], a[(j + 1) % 4], b[(j + 1) % 4], b[j]))
    bm.faces.new(rows[0]); bm.faces.new(rows[-1][::-1]); return put(name, bm, mat, bevel)
A0, A1 = math.radians(62), math.radians(118)
arc('Shell', 2.9, 3.5, -.42, .42, A0, A1, WHITE, 14, .05); arc('Inner', 2.62, 2.95, -.26, .26, A0 + .02, A1 - .02, DARK, 24, .015, .14)
arc('RailF', 3.02, 3.3, .42, .52, A0 + .05, A1 - .05, GREY, 14, .02); arc('RailB', 3.02, 3.3, -.52, -.42, A0 + .05, A1 - .05, GREY, 14, .02)
arc('LightFTintGlow', 3.1, 3.22, .52, .56, A0 + .12, A1 - .12, TGLOW, 14, .008); arc('LightBTintGlow', 3.1, 3.22, -.56, -.52, A0 + .12, A1 - .12, TGLOW, 14, .008)
arc('CrownTint', 3.5, 3.62, -.22, .22, A0 + .16, A1 - .16, TINT, 12, .02)
for s in (-1, 1):
    a = math.pi / 2 + s * .40; box('Clamp%d' % s, (math.cos(a) * 3.36, 0, math.sin(a) * 3.36), (.34, 1.16, .5), GREY, .04, Matrix.Rotation(-(a - math.pi / 2), 4, 'Y')); cyl('ClampBolt%d' % s, (math.cos(a) * 3.36, .62, math.sin(a) * 3.36), .1, .06, 'y', DARK, n=14)

# ================================================================ 碎石
coll('rock')
random.seed(5); bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1)
for v in bm.verts:
    d = v.co.normalized(); k = .78 + .26 * math.sin(d.x * 3.1 + 1.2) * math.cos(d.y * 2.7) + .16 * math.sin(d.z * 6 + d.x * 4) + random.uniform(-.05, .05); v.co = d * k * 1.0; v.co.x *= 1.2; v.co.z *= .86
put('Rock', bm, ROCK, 0)
for i in range(3):
    d = Vector((random.uniform(-1, 1), random.uniform(-1, 1), random.uniform(-1, 1))).normalized(); bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=.2 + i * .05); bm.transform(Matrix.Translation(d * .86)); put('Chip%d' % i, bm, ROCK, 0)

# 展示灯光与相机
w = bpy.data.worlds[0] if bpy.data.worlds else bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[0].default_value = (.072, .08, .096, 1); w.node_tree.nodes['Background'].inputs[1].default_value = .42
d = bpy.data.lights.new('Key', 'SUN'); d.energy = 3.15; lo = bpy.data.objects.new('Key', d); sc.collection.objects.link(lo); lo.rotation_euler = (.8, 0, 2.4)
d = bpy.data.lights.new('Rim', 'SUN'); d.energy = .9; lo = bpy.data.objects.new('Rim', d); sc.collection.objects.link(lo); lo.rotation_euler = (1.0, 0, -.9)
cams = {}
for n, dist in dict(shuttle=5.2, drone=2.9, crate=7, tile=4.2, relay=13, gateseg=10, rock=5).items():
    cd = bpy.data.cameras.new('Cam_' + n); c = bpy.data.objects.new('Cam_' + n, cd); sc.collection.objects.link(c); cd.lens = 50; t = Vector((0, 0, 3.1 if n == 'gateseg' else 0)); c.location = t + Vector((.55, .95, .5)).normalized() * dist; c.rotation_euler = (t - c.location).to_track_quat('-Z', 'Y').to_euler(); cams[n] = c
sc.render.engine = 'BLENDER_EEVEE'; sc.view_settings.view_transform = 'Standard'; sc.render.resolution_x = sc.render.resolution_y = 640; sc.render.resolution_percentage = 100
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'props.blend'))
print('props saved', [(c.name, len(c.objects)) for c in bpy.data.collections])
