"""Rebuild the approved Orbis B icon kit. Requires Pillow, NumPy and SciPy.

The image-model output is the material source; every deliverable shares the
same extracted silhouette, spacing and Android adaptive-icon safe zone.
"""
from pathlib import Path
import json
import shutil
import math
import zipfile
import numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
RES = REPO / 'android/app/src/main/res'
BG = (16, 33, 61)
LANCZOS = Image.Resampling.LANCZOS


def save(im, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def simplify(points, eps=0.7):
    if len(points) < 3:
        return points
    a, b = np.array(points[0]), np.array(points[-1])
    p = np.array(points)
    v = b - a
    if not np.any(v):
        d = np.linalg.norm(p-a, axis=1)
    else:
        d = np.abs(v[0]*(p[:, 1]-a[1])-v[1]*(p[:, 0]-a[0]))/np.linalg.norm(v)
    k = int(d.argmax())
    if d[k] <= eps:
        return [points[0], points[-1]]
    return simplify(points[:k+1], eps)[:-1] + simplify(points[k:], eps)


def contours(mask):
    # Trace exact pixel boundaries, then simplify sub-pixel stair steps.
    edges = {}
    h, w = mask.shape
    for y, x in zip(*np.nonzero(mask)):
        if y == 0 or not mask[y-1, x]: edges[(x, y)] = (x+1, y)
        if x == w-1 or not mask[y, x+1]: edges[(x+1, y)] = (x+1, y+1)
        if y == h-1 or not mask[y+1, x]: edges[(x+1, y+1)] = (x, y+1)
        if x == 0 or not mask[y, x-1]: edges[(x, y+1)] = (x, y)
    loops = []
    while edges:
        start = next(iter(edges))
        path = [start]
        p = edges.pop(start)
        while p != start:
            path.append(p)
            p = edges.pop(p)
        if len(path) < 30:
            continue
        mid = len(path)//2
        loops.append(simplify(path[:mid+1])[:-1] + simplify(path[mid:]+[start])[:-1])
    return loops


def main():
    rgb = np.array(Image.open(ROOT/'source-generated.png').convert('RGB'))
    raw = rgb.max(axis=2) > 100
    labels, count = ndimage.label(raw)
    sizes = np.bincount(labels.ravel()); sizes[0] = 0
    ids = np.argsort(sizes)[-2:]
    small, large = sorted(ids, key=lambda i: sizes[i])
    assert sizes[small] > 1000 and sizes[large] > sizes[small]*3
    body, block = labels == large, labels == small
    side = math.sqrt(int(block.sum()))
    distance = ndimage.distance_transform_edt(~body)
    offset = 0
    while True:
        shifted = ndimage.shift(block.astype(np.uint8), (-offset, offset), order=0) > 0
        gap = float(distance[shifted].min())
        if gap >= side * 0.90:
            break
        offset += 1
    assert offset < 100
    layers = []
    for m, delta in [(body, (0, 0)), (block, (offset, -offset))]:
        # Tiny antialiasing only: preserve the generated interior material.
        alpha = ndimage.gaussian_filter(m.astype(float), .38)
        layer = Image.fromarray(np.dstack((rgb, (alpha*255).astype('uint8'))), 'RGBA')
        canvas = Image.new('RGBA', layer.size)
        canvas.alpha_composite(layer, delta)
        layers.append(canvas)
    symbol = Image.alpha_composite(*layers)
    combined = body | shifted
    ys, xs = np.nonzero(combined)
    cx, cy = (xs.min()+xs.max()+1)/2, (ys.min()+ys.max()+1)/2
    radius = float(np.sqrt((xs-cx)**2+(ys-cy)**2).max())
    # 31.5dp radius, inside Android's guaranteed 33dp safe circle.
    scale = 315/radius
    full = Image.new('RGBA', (1080, 1080))
    resized = symbol.resize((round(symbol.width*scale), round(symbol.height*scale)), LANCZOS)
    px, py = round(540-cx*scale), round(540-cy*scale)
    full.alpha_composite(resized, (px, py))
    save(full, ROOT/'android/adaptive-foreground-1080.png')
    save(Image.new('RGB', (1080,1080), BG), ROOT/'android/adaptive-background-1080.png')
    # Visible launcher region is the central 72dp of a 108dp adaptive canvas.
    visible = full.crop((180,180,900,900))
    master = Image.new('RGBA', (1024,1024), BG+(255,))
    master.alpha_composite(visible.resize((1024,1024), LANCZOS))
    save(master.convert('RGB'), ROOT/'master/orbis-app-1024.png')
    save(visible.resize((2048,2048), LANCZOS), ROOT/'master/orbis-symbol-transparent-2048.png')
    save(master.resize((512,512), LANCZOS).convert('RGB'), ROOT/'store/google-play-512.png')
    save(master.convert('RGB'), ROOT/'store/app-store-1024.png')
    # The exact same outline is used for themed icons and notifications.
    loops = contours(combined)
    paths = []
    for loop in loops:
        pts = [((x*scale+px)/10, (y*scale+py)/10) for x,y in loop]
        paths.append('M '+' L '.join(f'{x:.3f},{y:.3f}' for x,y in pts)+' Z')
    path = ' '.join(paths)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72"><path fill="#10213d" fill-rule="evenodd" d="{path}"/></svg>\n'
    (ROOT/'master/orbis-symbol-mono.svg').write_text(svg, encoding='utf-8')
    def vector(dp, notification=False):
        group = '<group android:pivotX="54" android:pivotY="54" android:scaleX="1.18" android:scaleY="1.18">' if notification else '<group>'
        return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="{dp}dp" android:height="{dp}dp" android:viewportWidth="108" android:viewportHeight="108">
    {group}
        <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="{path}" />
    </group>
</vector>
'''
    export = ROOT/'android/res'
    for name, dp, notification in [('ic_launcher_monochrome',108,False), ('ic_stat_orbis',24,True)]:
        p = export/f'drawable/{name}.xml'; p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text(vector(dp,notification),encoding='utf-8')
    save(full.resize((432,432),LANCZOS), export/'drawable-nodpi/orbis_launcher_foreground.png')
    colors = export/'values/orbis_icon_colors.xml'; colors.parent.mkdir(parents=True,exist_ok=True)
    colors.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="orbis_icon_background">#10213D</color></resources>\n',encoding='utf-8')
    for version in [26,33]:
        for name in ['ic_launcher','ic_launcher_round']:
            p=export/f'mipmap-anydpi-v{version}/{name}.xml'; p.parent.mkdir(parents=True,exist_ok=True)
            mono='\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />' if version==33 else ''
            p.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/orbis_icon_background" />
    <foreground android:drawable="@drawable/orbis_launcher_foreground" />{mono}
</adaptive-icon>
''',encoding='utf-8')
    for density, size in [('mdpi',48),('hdpi',72),('xhdpi',96),('xxhdpi',144),('xxxhdpi',192)]:
        square=master.resize((size,size),LANCZOS)
        mask=Image.new('L',(1024,1024)); ImageDraw.Draw(mask).rounded_rectangle((0,0,1023,1023),radius=225,fill=255)
        square.putalpha(mask.resize((size,size),LANCZOS))
        save(square, export/f'mipmap-{density}/ic_launcher.png')
        ImageDraw.Draw(mask).rectangle((0,0,1023,1023),fill=0)
        ImageDraw.Draw(mask).ellipse((0,0,1023,1023),fill=255)
        circle=master.resize((size,size),LANCZOS); circle.putalpha(mask.resize((size,size),LANCZOS))
        save(circle, export/f'mipmap-{density}/ic_launcher_round.png')
    for p in export.rglob('*'):
        if p.is_file():
            dest=RES/p.relative_to(export); dest.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,dest)
    # A real downsampling contact sheet, not an independently generated mockup.
    sheet=Image.new('RGB',(1400,940),(236,239,243)); d=ImageDraw.Draw(sheet)
    font_path='C:/Windows/Fonts/segoeui.ttf'
    font=ImageFont.truetype(font_path,24); title=ImageFont.truetype(font_path,38)
    d.text((48,30),'Orbis / final B',font=title,fill=BG)
    d.text((48,88),'Easy Agents EveryWhere',font=font,fill=BG)
    for i, shape in enumerate(['rounded','circle','squircle']):
        tile=master.resize((320,320),LANCZOS)
        mask=Image.new('L',(1280,1280)); md=ImageDraw.Draw(mask)
        if shape=='circle': md.ellipse((0,0,1279,1279),fill=255)
        elif shape=='squircle':
            yy,xx=np.mgrid[:1280,:1280]; a=((abs((xx-639.5)/640)**4+abs((yy-639.5)/640)**4)<=1)*255
            mask=Image.fromarray(a.astype('uint8'))
        else: md.rounded_rectangle((0,0,1279,1279),radius=275,fill=255)
        tile.putalpha(mask.resize((320,320),LANCZOS)); sheet.paste(tile,(48+i*455,165),tile)
        d.text((48+i*455,505),shape,font=font,fill=BG)
    x=48
    for size in [192,96,72,48,32]:
        tile=master.resize((size,size),LANCZOS)
        sheet.paste(tile,(x,600))
        d.text((x,810),f'{size}px',font=font,fill=BG)
        x+=size+45
    mono=Image.new('RGBA',visible.size,(197,218,255,255)); mono.putalpha(visible.getchannel('A'))
    theme=Image.new('RGBA',visible.size,(41,57,80,255));theme.alpha_composite(mono)
    sheet.paste(theme.resize((160,160),LANCZOS),(1175,600))
    d.text((1170,810),'themed',font=font,fill=BG)
    save(sheet,ROOT/'preview.png')
    metrics={'background':'#10213D','block_shift_source_px':[offset,-offset], 'source_gap_px':gap,'block_equivalent_side_px':side,'gap_ratio':gap/side,'adaptive_safe_radius_dp':31.5,'adaptive_canvas_dp':108,'launcher_visible_dp':72,'foreground_count':2}
    (ROOT/'geometry.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
    assert gap/side >= .9
    assert full.getchannel('A').getbbox()
    print(json.dumps(metrics,indent=2))


if __name__=='__main__':
    main()
