"""把一个漫画风格 .blend 打包成网页用的 .pack（只读源文件，不保存 .blend）。

用法：Blender -b <file.blend> --factory-startup -P export_pack.py -- <out.pack> <ship key> [+Y|-Y] [maxTris]

每个顶点 16 字节、分三段存放：位置 int16x3 + 分区号 uint16；八面体法线 uint8x2 + AO uint8 + 材质号 uint8；UV int16x2。
材质的四阶明暗直接从 Blender 漫画节点的 Color Ramp 采样成一行 128 像素的色带。
"""
import bpy, sys, re, json, struct, math, random, time
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index('--') + 1:]
OUT, KEY = argv[0], argv[1]
BOW = argv[2] if len(argv) > 2 else '+Y'
MAX_TRIS = int(argv[3]) if len(argv) > 3 else 70000
ONLY = argv[4] if len(argv) > 4 else None  # 只导出某个集合
RAMP_W = 128
T0 = time.time()
random.seed(7)
rng = np.random.default_rng(7)

# ---------------------------------------------------------------- 可动部件：名字 → 分组与转轴
RIGS = {
    'station': [('hub', r'^Hub_', None, 'z')],
    'claude': [('turret', r'^Dorsal_QuadTurret(Barrel|Body)', (0, 2.75, 2.3), 'y')],
    'codex': [('turret', r'^Dorsal_Turret(Barrel|Hatch|MainHatch|Mantlet|Muzzle|OpticPod|RadialLug|RimMarker|BearingRing)', (0, 2.65, 2.7), 'y')],
    'kimi': [
        ('gravL', r'(GravPod_TurbineVane|Micro_GravInnerRotor|Micro_GravGimbalSpoke|Micro_GravSpokeNode)_Port', (-4.5, -0.85, -0.45), 'x'),
        ('gravR', r'(GravPod_TurbineVane|Micro_GravInnerRotor|Micro_GravGimbalSpoke|Micro_GravSpokeNode)_Stbd', (4.5, -0.85, -0.45), 'x'),
    ],
    'openclaw': [
        ('clawL', r'^Claw_Port_(?!RootCollar)', (-4.6, 3.5, 0.4), 'y'),
        ('clawR', r'^Claw_Stbd_(?!RootCollar)', (4.6, 3.5, 0.4), 'y'),
    ],
    'opencode': [('portal', r'^Portal_Holo', None, 'y')],
    'deepseek': [
        ('turbL', r'^Turbine_(StatorVane|RimTab|RingBridge)_Port', (-3.5, -2.66, -0.6), 'x'), ('turbR', r'^Turbine_(StatorVane|RimTab|RingBridge)_Stbd', (3.5, -2.66, -0.6), 'x'),
        ('tailL', r'^VTail_.*_Port', (-0.9, -7.6, 1.7), 'z'), ('tailR', r'^VTail_.*_Stbd', (0.9, -7.6, 1.7), 'z'),
    ],
    'hermes': [
        ('wingL', r'^(Wing_|Thruster_|Strut_(?!.*FusCollar)).*Port', (-1.5, -2.0, 0), 'z'), ('wingR', r'^(Wing_|Thruster_|Strut_(?!.*FusCollar)).*Stbd', (1.5, -2.0, 0), 'z'),
    ],
}.get(KEY, [])

ENGINES = {
    'claude': r'^Thruster_.*HotCore', 'codex': r'(NozzleHotCore|ChevronHotCore)', 'kimi': r'^Stern_ThrusterHotCore',
    'deepseek': r'^Stern_(MainIonRing|CenterThrusterGlow|AuxVernierGlow)', 'hermes': r'(NozzleEmber|SternEmberCore)$|NozzleEmber',
    'opencode': r'^Stern_ThrusterPlasmaCore', 'openclaw': r'^Hull_SternSlot_Cavity', 'pi': r'^Red_Rear_Louvers_(Main|Left|Right|\w+)',
}.get(KEY, r'(Engine|Thruster|Nozzle).*(HotCore|PlasmaCore|Core\w*)$')  # 新船按通用命名识别


def classify(name):
    n = name.lower()
    if 'tintglow' in n: return 7
    if re.search(r'thrust|engine|plasma|hotcore', n): return 2
    if re.search(r'beacon|strobe|navlight|rimmarker', n): return 3
    if re.search(r'window', n): return 1
    if re.search(r'portal|holo', n): return 4
    return 5


sc = bpy.data.scenes.get('Scene_Comic') or bpy.context.scene
bpy.context.window.scene = sc
# Line Art 会在每次依赖图更新时重算，打包用不到（只在内存里移除）
for o in list(bpy.data.objects):
    if o.type in {'GREASEPENCIL', 'GPENCIL', 'LIGHT', 'CAMERA'}: bpy.data.objects.remove(o)
for s in list(bpy.data.scenes):
    if s != sc: bpy.data.scenes.remove(s)
dg = bpy.context.evaluated_depsgraph_get()


def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def fac(node):
    for s in node.inputs:
        if s.name == 'Factor' and not s.is_linked:
            try: return float(s.default_value)
            except TypeError: continue
    return 1.0


# ---------------------------------------------------------------- 材质
mats, mat_index = [], {}
extra_ramps, masks = [], {}  # 第二条色带（鎏金等）与铭文遮罩：图像名 → (通道, 数组)


def parse_material(m):
    nt = m.node_tree
    outs = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output] or [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL']
    surf = outs[0].inputs['Surface'].links[0].from_node if outs and outs[0].inputs['Surface'].is_linked else None
    d = dict(name=re.sub(r'(^Mat_|_Comic$)', '', m.name), tex=0, uv=1.0, ao=0.0, spec=0.0, specLo=.6, specHi=.66, rough=.25, rim=0.0, rimCol=[.88, .93, 1], emit=[0, 0, 0], cls=0, alpha=1.0)
    ramp = ramp2 = None
    alpha = 1.0
    if surf and surf.type == 'MIX_SHADER':
        f = surf.inputs[0]
        alpha = 0.5 if f.is_linked else float(f.default_value)
        kids = [i.links[0].from_node for i in surf.inputs[1:] if i.is_linked]
        pick = [k for k in kids if k.type in ('EMISSION', 'BSDF_PRINCIPLED')]
        if len(kids) == 2 and kids[0].type != 'BSDF_TRANSPARENT' and kids[1].type == 'BSDF_TRANSPARENT': alpha = 1 - alpha
        surf = pick[0] if pick else surf
    d['alpha'] = alpha
    if surf and surf.type == 'EMISSION':
        for n in nt.nodes:
            if n.type == 'VALTORGB':
                src = n.inputs[0].links[0].from_node if n.inputs[0].is_linked else None
                if src is None: continue
                if src.type == 'RGBTOBW':
                    s2 = src.inputs[0].links[0].from_node
                    if s2.type == 'SHADERTORGB' and s2.inputs[0].is_linked:
                        k = s2.inputs[0].links[0].from_node.type
                        if k == 'BSDF_DIFFUSE':
                            if any(l.to_node.type in ('MIX', 'MIX_RGB') and getattr(l.to_node, 'blend_type', '') == 'MIX' for l in n.outputs[0].links): ramp2 = n.color_ramp
                            else: ramp = n.color_ramp
                        elif k == 'BSDF_GLOSSY':
                            g = s2.inputs[0].links[0].from_node
                            d['rough'] = float(g.inputs['Roughness'].default_value)
                            e = n.color_ramp.elements
                            d['specLo'], d['specHi'] = e[0].position, e[-1].position
                            for l in n.outputs[0].links:
                                if l.to_node.type in ('MIX', 'MIX_RGB'): d['spec'] = fac(l.to_node)
                elif src.type == 'LAYER_WEIGHT':
                    e = n.color_ramp.elements
                    d['rimCol'] = [float(x) for x in e[-1].color[:3]]
                    d['rimLo'], d['rimHi'] = e[0].position, e[-1].position
                    for l in n.outputs[0].links:
                        if l.to_node.type in ('MIX', 'MIX_RGB'): d['rim'] = fac(l.to_node)
                elif src.type == 'AMBIENT_OCCLUSION':
                    for l in n.outputs[0].links:
                        if l.to_node.type in ('MIX', 'MIX_RGB'): d['ao'] = fac(l.to_node)
            elif n.type == 'TEX_IMAGE' and n.image:
                if 'Albedo' in n.image.name:
                    d['tex'] = 2 if 'Mech' in n.image.name else 1
            elif n.type == 'MAPPING':
                d['uv'] = float(n.inputs['Scale'].default_value[0])
        if ramp2 is not None:
            for n in nt.nodes:
                if n.type == 'MAP_RANGE' and n.inputs['Value'].is_linked:
                    sep = n.inputs['Value'].links[0].from_node; ch = {'Red': 0, 'Green': 1, 'Blue': 2}.get(n.inputs['Value'].links[0].from_socket.name, 2)
                    im = sep.inputs[0].links[0].from_node.image if sep.type == 'SEPARATE_COLOR' and sep.inputs[0].is_linked else None
                    if im is None: continue
                    if im.name not in masks and len(masks) < 3:
                        a = np.empty(im.size[0] * im.size[1] * im.channels, np.float32); im.pixels.foreach_get(a); a = a.reshape(im.size[1], im.size[0], im.channels)[..., ch]
                        lo, hi = float(n.inputs['From Min'].default_value), float(n.inputs['From Max'].default_value); a = np.clip((a - lo) / (hi - lo), 0, 1)
                        h2, w2 = a.shape[0] // 2, a.shape[1] // 2; masks[im.name] = (len(masks), a[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).mean((1, 3)))
                    if im.name in masks:
                        d['tex'] = 3 + masks[im.name][0]; d['uv'] = 1.0; d['ramp2'] = len(extra_ramps); extra_ramps.append(np.array([list(ramp2.evaluate(i / (RAMP_W - 1)))[:3] for i in range(RAMP_W)]))
        if ramp is None:
            c = surf.inputs['Color']
            col = [1, 1, 1] if c.is_linked else list(c.default_value)[:3]
            s = float(surf.inputs['Strength'].default_value)
            d['emit'] = [x * s for x in col]; d['cls'] = classify(m.name)
            row = np.tile(np.array(col), (RAMP_W, 1))
        else:
            row = np.array([list(ramp.evaluate(i / (RAMP_W - 1)))[:3] for i in range(RAMP_W)])
    else:
        p = surf if surf and surf.type == 'BSDF_PRINCIPLED' else next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        base = list(p.inputs['Base Color'].default_value)[:3] if p else [.5, .5, .5]
        es = float(p.inputs['Emission Strength'].default_value) if p else 0
        em = list(p.inputs['Emission Color'].default_value)[:3] if p else [0, 0, 0]
        if p is not None and p.inputs['Alpha'].default_value < .999: d['alpha'] = float(p.inputs['Alpha'].default_value)
        lk = p.inputs['Base Color'] if p else None
        if lk is not None and lk.is_linked:  # 取贴图均色（含正片叠底的染色）
            def mean(sock):
                n = sock.links[0].from_node if sock.is_linked else None
                if n is None: return np.array(list(sock.default_value)[:3])
                if n.type == 'TEX_IMAGE' and n.image:
                    a = np.empty(n.image.size[0] * n.image.size[1] * n.image.channels, np.float32); n.image.pixels.foreach_get(a); c = a.reshape(-1, n.image.channels)[::7, :3].mean(0)
                    return np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4) if n.image.colorspace_settings.name == 'sRGB' else c
                if n.type in ('MIX', 'MIX_RGB'):
                    cs = [mean(i) for i in n.inputs if i.type == 'RGBA'][:2]; f = fac(n)
                    return cs[0] * (1 - f) + cs[0] * cs[1] * f if getattr(n, 'blend_type', '') == 'MULTIPLY' else cs[0] * (1 - f) + cs[1] * f
                return np.array([.5, .5, .5])
            base = [float(x) for x in mean(lk)]
            mp = next((n for n in nt.nodes if n.type == 'MAPPING'), None)
            d['tex'] = 1; d['uv'] = float(mp.inputs['Scale'].default_value[0]) if mp else 1.0
        row = np.tile(np.array(base), (RAMP_W, 1))
        if es <= .5 and d['alpha'] > .9:  # 写实材质按同一套四阶冷阴影换算，风格与漫画材质一致
            b = np.array(base) * 1.12; tones = [b * [.26, .34, .50] + .004, b * [.62, .69, .82] + .004, b * [.97, .985, 1.0], np.minimum(1, b * 1.16 + .02)]
            for i in range(RAMP_W):
                x = i / (RAMP_W - 1); row[i] = tones[0] if x < .165 else tones[1] if x < .445 else tones[2] if x < .795 else tones[3]
            m_ = float(p.inputs['Metallic'].default_value) if not p.inputs['Metallic'].is_linked else .3
            d.update(ao=.34, spec=.12 + .25 * m_, rim=.16, rough=.22); es = 0
        if es > 0:
            d['emit'] = [x * es for x in em]; d['cls'] = classify(m.name)
    if d['cls'] == 0 and 'Tint' in m.name: d['cls'] = 6
    d['_row'] = row
    return d


def mat_id(m):
    if m is None: m = bpy.data.materials[0]
    if m.name not in mat_index:
        mat_index[m.name] = len(mats)
        mats.append(parse_material(m))
    return mat_index[m.name]


# ---------------------------------------------------------------- 取网格
SWAP = np.array([[-1, 0, 0], [0, 0, 1], [0, 1, 0]], float) if BOW == '+Y' else np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float)

objs = [o for o in sc.objects if o.type == 'MESH' and not o.hide_render]
if ONLY: objs = [o for o in bpy.data.collections[ONLY].objects if o.type == 'MESH']
if not objs: raise SystemExit('no meshes')
wmin = np.array([1e9] * 3); wmax = -wmin
for o in objs:
    for c in o.bound_box:
        w = np.array(o.matrix_world @ Vector(c)); wmin = np.minimum(wmin, w); wmax = np.maximum(wmax, w)
SIZE = float((wmax - wmin).max())


def rig_of(name):
    for i, (n, rx, piv, ax) in enumerate(RIGS):
        if re.search(rx, name): return i + 1
    return 0


def read_object(o, ratio=1.0, dissolve=None):
    """返回 (tri corner arrays)。ratio<1 时先减面。"""
    mods = []
    if dissolve:
        md = o.modifiers.new('_dis', 'DECIMATE'); md.decimate_type = 'DISSOLVE'; md.angle_limit = math.radians(dissolve); md.delimit = {'MATERIAL'}; mods.append(md)
    if ratio < .999:
        md = o.modifiers.new('_col', 'DECIMATE'); md.decimate_type = 'COLLAPSE'; md.ratio = max(.02, ratio); md.use_collapse_triangulate = True; mods.append(md)
    if mods: bpy.context.view_layer.update()
    dgx = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dgx)
    me = ev.to_mesh()
    if me is None or len(me.polygons) == 0:
        for md in mods: o.modifiers.remove(md)
        return None
    me.calc_loop_triangles()
    nl, nt, nv = len(me.loops), len(me.loop_triangles), len(me.vertices)
    co = np.empty(nv * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    lv = np.empty(nl, np.int32); me.loops.foreach_get('vertex_index', lv)
    cn = np.empty(nl * 3); me.corner_normals.foreach_get('vector', cn); cn = cn.reshape(-1, 3)
    tl = np.empty(nt * 3, np.int32); me.loop_triangles.foreach_get('loops', tl); tl = tl.reshape(-1, 3)
    tm = np.empty(nt, np.int32); me.loop_triangles.foreach_get('material_index', tm)
    if me.uv_layers.active:
        uv = np.empty(nl * 2); me.uv_layers.active.uv.foreach_get('vector', uv); uv = uv.reshape(-1, 2)
    else: uv = np.zeros((nl, 2))
    M = np.array(o.matrix_world)
    w = co @ M[:3, :3].T + M[:3, 3]
    N3 = np.linalg.inv(M[:3, :3]).T
    n = cn @ N3.T
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    flip = np.linalg.det(M[:3, :3]) < 0
    # 连通块 → 墨线分区
    parent = np.arange(nv)
    ed = np.empty(len(me.edges) * 2, np.int32); me.edges.foreach_get('vertices', ed); ed = ed.reshape(-1, 2)
    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for a, b in ed:
        ra, rb = find(a), find(b)
        if ra != rb: parent[ra] = rb
    root = np.array([find(i) for i in range(nv)])
    slots = [s.material for s in o.material_slots] or [None]
    mid = np.array([mat_id(s) for s in slots], np.int32)
    tm = mid[np.clip(tm, 0, len(mid) - 1)]
    if flip: tl = tl[:, ::-1]
    ev.to_mesh_clear()
    for md in mods: o.modifiers.remove(md)
    c = tl.reshape(-1)
    return dict(pos=w[lv[c]] @ SWAP.T, nrm=n[c] @ SWAP.T, uv=uv[c], comp=root[lv[c]], mat=np.repeat(tm, 3))


def collect(mode):
    """mode 0 精细，1 远景。"""
    out = []
    raw = {}
    for o in objs:
        bb = np.array([o.matrix_world @ Vector(c) for c in o.bound_box]); diag = float(np.linalg.norm(bb.max(0) - bb.min(0)))
        raw[o.name] = (diag, len(o.data.polygons))
    total = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    for o in objs:
        diag, npoly = raw[o.name]
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        rel = diag / SIZE
        if mode == 0:
            need = total > MAX_TRIS
            ratio, dis = 1.0, (1.5 if need else None)
            if need and tris > 40:
                k = min(1.0, MAX_TRIS / total)
                # 小零件多减，大外壳少减
                ratio = min(1.0, max(.22, k * (.75 if rel < .06 else 1.15 if rel < .25 else 1.5)))
                if KEY == 'station': ratio = min(1.0, max(.3, k * 1.0))
            r = read_object(o, ratio, dis)
        else:
            if rel < (.02 if KEY == 'station' else .035): continue
            r = read_object(o, 1.0 if tris < 30 else (.42 if KEY == 'station' else .3), 6.0)
        if r is None or not len(r['pos']): continue
        r['rig'] = rig_of(o.name); r['name'] = o.name
        out.append(r)
    return out


def oct_encode(n):
    n = n / np.maximum(np.abs(n).sum(1, keepdims=True), 1e-9)
    o = n[:, :2].copy()
    neg = n[:, 2] < 0
    o[neg] = (1 - np.abs(n[neg][:, [1, 0]])) * np.where(n[neg][:, :2] >= 0, 1, -1)
    return np.clip(np.round((o * .5 + .5) * 255), 0, 255).astype(np.uint8)


HEMI = []
for i in range(28):
    u, v = (i + .5) / 28, (i * 0.61803398875) % 1
    r = math.sqrt(u); th = 2 * math.pi * v
    HEMI.append((r * math.cos(th), r * math.sin(th), math.sqrt(max(0, 1 - u))))
HEMI = np.array(HEMI)


def bake_ao(bvh, pos, nrm):
    key = np.round(np.concatenate([pos / SIZE * 4000, nrm * 12], 1)).astype(np.int32)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    ao = np.ones(len(first))
    reach = SIZE * .05
    eps = SIZE * .0006
    rc = bvh.ray_cast
    for k, i in enumerate(first):
        n = nrm[i]; p = pos[i] + n * eps
        t = np.cross(n, [0, 0, 1] if abs(n[2]) < .9 else [1, 0, 0]); t /= np.linalg.norm(t); b = np.cross(n, t)
        dirs = HEMI[:, :1] * t + HEMI[:, 1:2] * b + HEMI[:, 2:] * n
        pv = Vector(p); occ = 0.0
        for d in dirs:
            h = rc(pv, Vector(d), reach)
            if h[0] is not None: occ += 1 - (h[3] / reach) ** .7
        ao[k] = 1 - occ / len(dirs)
    return ao[inv]


def pack_lod(recs, bvh):
    groups = {}
    for r in recs: groups.setdefault(r['rig'], []).append(r)
    res = []
    for gi in sorted(groups):
        rs = groups[gi]
        pos = np.concatenate([r['pos'] for r in rs]); nrm = np.concatenate([r['nrm'] for r in rs]); uv = np.concatenate([r['uv'] for r in rs]); mat = np.concatenate([r['mat'] for r in rs])
        pid = []
        base = 0
        for r in rs:
            _, inv = np.unique(r['comp'], return_inverse=True)
            pid.append(inv.reshape(-1) + base); base += inv.max() + 1
        pid = np.concatenate(pid)
        table = rng.integers(1, 65535, base)
        pid = table[pid]
        res.append((gi, pos, nrm, uv, mat, pid))
    return res


lod0 = collect(0); lod1 = collect(1)
tri0 = sum(len(r['pos']) for r in lod0) // 3; tri1 = sum(len(r['pos']) for r in lod1) // 3
print('tris lod0', tri0, 'lod1', tri1, 'mats', len(mats), round(time.time() - T0, 1), 's')

glass_ids = [i for i, m in enumerate(mats) if m['alpha'] < .99]
allp = np.concatenate([r['pos'][~np.isin(r['mat'], glass_ids)] for r in lod0])
bvh = BVHTree.FromPolygons([tuple(p) for p in allp], [(i, i + 1, i + 2) for i in range(0, len(allp), 3)], all_triangles=True)
pmin, pmax = allp.min(0), allp.max(0)
center = (pmin + pmax) / 2
half = float((pmax - pmin).max() / 2) * 1.002
print('size', pmax - pmin, 'center', center)

blob = bytearray()
def put(arr):
    while len(blob) % 4: blob.append(0)
    off = len(blob); blob.extend(arr.tobytes()); return off


# LOD1 的遮蔽直接取 LOD0 的最近值
lods_json = []
UVQ = 64.0
for li, recs in enumerate((lod0, lod1)):
    parts = []
    for gi, pos, nrm, uv, mat, pid in pack_lod(recs, bvh):
        ao = bake_ao(bvh, pos, nrm)
        piv = np.zeros(3)
        if gi:
            name, rx, pv, ax = RIGS[gi - 1]
            if pv is not None: piv = np.array(pv, float) @ SWAP.T
            else:
                e = next((o for o in bpy.data.objects if o.name.startswith('Pivot_' + name)), None)
                if e: piv = np.array(e.matrix_world.translation) @ SWAP.T
        for glass in (False, True):
            sel = np.isin(mat, glass_ids) == glass
            if not sel.any(): continue
            P, N, U, A, Mt, I = pos[sel], nrm[sel], uv[sel], ao[sel], mat[sel], pid[sel]
            q = np.clip(np.round((P - center) / half * 32767), -32767, 32767).astype(np.int16)
            o2 = oct_encode(N)
            au = np.clip(np.round(A * 255), 0, 255).astype(np.uint8)
            uvs = U * np.array([mats[m]['uv'] for m in range(len(mats))])[Mt][:, None]
            uvs = uvs - np.floor(uvs.reshape(-1, 3, 2).min(1)).repeat(3, 0)
            raw_uv = np.array([mats[m]['tex'] >= 3 for m in range(len(mats))])[Mt]  # 铭文用原始 0..1 UV，精度更高
            uq = np.clip(np.round(np.where(raw_uv[:, None], np.mod(U, 1.0000001) * 32767, uvs * 32767 / UVQ)), -32767, 32767).astype(np.int16)
            rec = np.zeros(len(q), dtype=[('p', '<i2', 3), ('id', '<u2'), ('n', 'u1', 2), ('ao', 'u1'), ('m', 'u1'), ('uv', '<i2', 2)])
            rec['p'] = q; rec['id'] = I; rec['n'] = o2; rec['ao'] = au; rec['m'] = Mt; rec['uv'] = uq
            raw = rec.view(np.uint8).reshape(len(rec), 16)
            uniq, inv = np.unique(raw, axis=0, return_inverse=True)
            inv = inv.reshape(-1)
            # 重排成首次出现的顺序，利于压缩与缓存
            _, firsts = np.unique(inv, return_index=True)
            order = np.argsort(firsts); remap = np.empty(len(order), np.int64); remap[order] = np.arange(len(order))
            uniq = uniq[order]; idx = remap[inv]
            t = idx.reshape(-1, 3); good = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2]); idx = t[good].reshape(-1)
            big = len(uniq) > 65535
            ub = uniq.astype(np.uint8)
            vo = put(ub[:, 0:8]); xo = put(ub[:, 8:12]); to = put(ub[:, 12:16]); io = put(idx.astype(np.uint32 if big else np.uint16))
            parts.append(dict(rig=RIGS[gi - 1][0] if gi else 'static', axis=RIGS[gi - 1][3] if gi else '', pivot=[round(float(x), 4) for x in piv], glass=glass, nv=len(uniq), ni=len(idx), v=vo, x=xo, t=to, i=io, u32=big))
    lods_json.append(parts)

# ---------------------------------------------------------------- 插槽
sockets = dict(engines=[], beacons=[])
def obj_center(o):
    bb = np.array([o.matrix_world @ Vector(c) for c in o.bound_box]) @ SWAP.T
    return (bb.min(0) + bb.max(0)) / 2, bb.max(0) - bb.min(0)
if ENGINES:
    for o in objs:
        if re.search(ENGINES, re.sub(r'_Comic(\.\d+)?$', '', o.name)):
            c, s = obj_center(o)
            sockets['engines'].append(dict(p=[round(float(x), 3) for x in c], w=round(float(s[0]), 3), h=round(float(s[1]), 3), z=round(float(c[2] - s[2] / 2), 3), n=re.sub('_Comic$', '', o.name)))
for o in objs:
    if o.material_slots and o.material_slots[0].material and re.search(r'Beacon|Strobe|NavPip|NavLight|ClawMarker|SensorGlow|WarmTacticalLight|BowLED', o.material_slots[0].material.name + o.name):
        c, s = obj_center(o)
        if s.max() < SIZE * .12: sockets['beacons'].append([round(float(x), 3) for x in c])
random.shuffle(sockets['beacons']); sockets['beacons'] = sockets['beacons'][:10]

ramp = np.stack([m.pop('_row') for m in mats] + extra_ramps)
ramp8 = np.round(lin2srgb(ramp) * 255).astype(np.uint8)
ro = put(np.concatenate([ramp8, np.full(ramp8.shape[:2] + (1,), 255, np.uint8)], 2))
for m in mats:
    for k, v in list(m.items()):
        if isinstance(v, float): m[k] = round(v, 4)
        elif isinstance(v, list): m[k] = [round(float(x), 4) for x in v]
mask_info = None
if masks:
    import tempfile, os
    h_, w_ = next(iter(masks.values()))[1].shape; px = np.zeros((h_, w_, 4), np.float32); px[..., 3] = 1
    for c_, a_ in masks.values(): px[..., c_] = a_
    im = bpy.data.images.new('_mask', w_, h_, is_data=True); im.pixels.foreach_set(px.ravel()); fp = os.path.join(tempfile.mkdtemp(), 'm.png'); im.filepath_raw = fp; im.file_format = 'PNG'; im.save()
    raw = open(fp, 'rb').read(); mask_info = [put(np.frombuffer(raw, np.uint8)), len(raw)]; print('mask', w_, h_, len(raw) // 1024, 'KB')
head = dict(mask=mask_info, rampRows=len(ramp), key=KEY, half=half, center=[float(x) for x in center], min=[float(x) for x in pmin], max=[float(x) for x in pmax], uvq=UVQ, rampW=RAMP_W, ramp=ro, mats=mats, lods=lods_json, sockets=sockets, tris=[tri0, tri1])
js = json.dumps(head, separators=(',', ':')).encode()
while (len(js) + 8) % 4: js += b' '
with open(OUT, 'wb') as f:
    f.write(b'OFP1'); f.write(struct.pack('<I', len(js))); f.write(js); f.write(blob)
print('PACK', KEY, OUT, 'KB', (len(blob) + len(js)) // 1024, 'verts', [sum(p['nv'] for p in l) for l in lods_json], 'tris', [sum(p['ni'] for p in l) // 3 for l in lods_json], 'engines', len(sockets['engines']), 'beacons', len(sockets['beacons']), round(time.time() - T0, 1), 's')
