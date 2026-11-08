"""Rebuild the selected Orbis B icon kit. Requires Pillow, NumPy and SciPy.

The B artwork supplies the foreground and contact shadow. The square master
composites them on BG, which can be changed directly without image generation.
"""
from pathlib import Path
import json
import shutil
import numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
RES = REPO / 'android/app/src/main/res'
BG = (97, 127, 163)
LANCZOS = Image.Resampling.LANCZOS


def save(im, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def extract_symbol(rgb, mask):
    # Fit the unobstructed blue surface, then retain its actual contact shadow
    # as transparency so adaptive icons keep the shallow, raised UI effect.
    height, width = mask.shape
    yy, xx = np.mgrid[:height, :width]
    x, y = xx/(width-1), yy/(height-1)
    distance = ndimage.distance_transform_edt(~mask)
    features = np.stack((np.ones_like(x), x, y, x*x, x*y, y*y), axis=-1)
    samples = (distance > 70) & ((xx+yy) % 13 == 0)
    coefficients = np.linalg.lstsq(features[samples], rgb[samples], rcond=None)[0]
    background = features @ coefficients
    alpha = ndimage.gaussian_filter(mask.astype(float), .45)
    foreground = np.clip(
        (rgb-background*(1-alpha[:, :, None])) / np.maximum(alpha[:, :, None], .001),
        0, 255,
    )
    body = Image.fromarray(np.dstack((foreground, alpha*255)).astype('uint8'))
    darkness = ndimage.gaussian_filter(np.maximum((background-rgb).mean(axis=2)-1.5, 0), 1)
    shade_alpha = np.clip(darkness/background.mean(axis=2), 0, .45)
    shade_alpha *= np.clip((80-distance)/25, 0, 1)
    shade_alpha[mask] = 0
    shadow = Image.fromarray(np.dstack((np.zeros_like(rgb), shade_alpha*255)).astype('uint8'))
    return Image.alpha_composite(shadow, body)


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
    assert rgb.shape == (1024, 1024, 3)
    corner = np.concatenate((rgb[:24,:24], rgb[:24,-24:], rgb[-24:,:24], rgb[-24:,-24:]), axis=0)
    background = tuple(int(round(x)) for x in np.median(corner.reshape(-1, 3), axis=0))
    # The selected artwork is baked. Separate its bright body from the pale
    # background only when a target format requires transparent layers.
    threshold = float(np.mean(background)) + 3.5
    labels, _ = ndimage.label(rgb.mean(axis=2) > threshold)
    sizes = np.bincount(labels.ravel()); sizes[0] = 0
    ids = np.argsort(sizes)[-2:]
    selected = sorted((int(i) for i in ids if sizes[i] > 1000), key=lambda i: sizes[i], reverse=True)
    assert len(selected) == 2 and sizes[selected[0]] > sizes[selected[1]] * 3
    combined = np.isin(labels, selected)
    combined = ndimage.binary_fill_holes(combined)
    assert int(combined.sum()) > 100_000
    symbol = extract_symbol(rgb.astype(float), combined)

    # Keep the approved mark and shallow shadow; recolor only the surface.
    master = Image.new('RGBA', symbol.size, BG+(255,))
    master.alpha_composite(symbol)
    master = master.convert('RGB')
    save(master, ROOT/'master/orbis-app-1024.png')
    save(master.resize((512,512), LANCZOS), ROOT/'store/google-play-512.png')
    save(master, ROOT/'store/app-store-1024.png')

    ys, xs = np.nonzero(combined)
    cx, cy = (xs.min()+xs.max()+1)/2, (ys.min()+ys.max()+1)/2
    radius = float(np.sqrt((xs-cx)**2+(ys-cy)**2).max())
    # 31.5dp radius, inside Android's guaranteed 33dp safe circle.
    scale = 315/radius
    full = Image.new('RGBA', (1080, 1080))
    resized = symbol.resize((round(symbol.width*scale), round(symbol.height*scale)), LANCZOS)
    px, py = round(540-cx*scale), round(540-cy*scale)
    full.alpha_composite(resized, (px, py))
    # Fade only the shadow at the guaranteed safe circle; the solid mark is
    # contained within its original 31.5dp radius.
    fy, fx = np.mgrid[:1080, :1080]
    safe_fade = np.clip((330-np.hypot(fx-540, fy-540))/5, 0, 1)
    full.putalpha(Image.fromarray((np.array(full.getchannel('A'))*safe_fade).astype('uint8')))
    save(full, ROOT/'android/adaptive-foreground-1080.png')
    save(Image.new('RGB', (1080,1080), BG), ROOT/'android/adaptive-background-1080.png')
    # Visible launcher region is the central 72dp of a 108dp adaptive canvas.
    visible = full.crop((180,180,900,900))
    save(symbol.resize((2048,2048), LANCZOS), ROOT/'master/orbis-symbol-transparent-2048.png')

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
    colors.write_text(f'<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="orbis_icon_background">#{BG[0]:02X}{BG[1]:02X}{BG[2]:02X}</color></resources>\n',encoding='utf-8')
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

    # Native assets use either the unchanged square master or the extracted
    # transparent mark, depending on the platform's expected format.
    ios = REPO/'ios/Orbis/Orbis/Assets.xcassets'
    save(master, ios/'AppIcon.appiconset/AppIcon-1024.png')
    save(full.resize((432,432), LANCZOS), ios/'OrbisMark.imageset/OrbisMark.png')
    host_assets = REPO/'packages/windows-host/src/assets'
    save(symbol.resize((2048,2048), LANCZOS), host_assets/'orbis.png')
    master.save(host_assets/'orbis.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    relay = REPO/'packages/relay/src/web'
    save(symbol.resize((2048,2048), LANCZOS), relay/'orbis.png')
    save(symbol.resize((512,512), LANCZOS), relay/'promo/orbis-symbol-2048.png')
    save(full.resize((432,432), LANCZOS), relay/'promo/orbis-mark-ios.png')

    # A real downsampling contact sheet, not an independently generated mockup.
    sheet=Image.new('RGB',(1400,940),(236,239,243)); d=ImageDraw.Draw(sheet)
    font_path = next((p for p in [
        Path('C:/Windows/Fonts/segoeui.ttf'),
        Path('/System/Library/Fonts/Supplemental/Arial.ttf'),
        Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
    ] if p.is_file()), None)
    if font_path:
        font=ImageFont.truetype(str(font_path),24); title=ImageFont.truetype(str(font_path),38)
    else:
        font=ImageFont.load_default(); title=ImageFont.load_default()
    ink = (16, 33, 61)
    d.text((48,30),'Orbis / final B',font=title,fill=ink)
    d.text((48,88),'Easy Agents Everywhere',font=font,fill=ink)
    for i, shape in enumerate(['rounded','circle','squircle']):
        tile=master.resize((320,320),LANCZOS)
        mask=Image.new('L',(1280,1280)); md=ImageDraw.Draw(mask)
        if shape=='circle': md.ellipse((0,0,1279,1279),fill=255)
        elif shape=='squircle':
            yy,xx=np.mgrid[:1280,:1280]; a=((abs((xx-639.5)/640)**4+abs((yy-639.5)/640)**4)<=1)*255
            mask=Image.fromarray(a.astype('uint8'))
        else: md.rounded_rectangle((0,0,1279,1279),radius=275,fill=255)
        tile.putalpha(mask.resize((320,320),LANCZOS)); sheet.paste(tile,(48+i*455,165),tile)
        d.text((48+i*455,505),shape,font=font,fill=ink)
    x=48
    for size in [192,96,72,48,32]:
        tile=master.resize((size,size),LANCZOS)
        sheet.paste(tile,(x,600))
        d.text((x,810),f'{size}px',font=font,fill=ink)
        x+=size+45
    monochrome = Image.new('L', (1080,1080))
    source_mask = Image.fromarray((combined*255).astype('uint8'))
    monochrome.paste(source_mask.resize(resized.size, LANCZOS), (px,py))
    mono=Image.new('RGBA',visible.size,(197,218,255,255)); mono.putalpha(monochrome.crop((180,180,900,900)))
    theme=Image.new('RGBA',visible.size,(41,57,80,255));theme.alpha_composite(mono)
    sheet.paste(theme.resize((160,160),LANCZOS),(1175,600))
    d.text((1170,810),'themed',font=font,fill=ink)
    save(sheet,ROOT/'preview.png')
    metrics={'background':f'#{BG[0]:02X}{BG[1]:02X}{BG[2]:02X}','source_mask_threshold_mean_rgb':threshold,'source_foreground_bbox_px':[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)],'adaptive_safe_radius_dp':31.5,'adaptive_canvas_dp':108,'launcher_visible_dp':72,'foreground_count':len(selected)}
    (ROOT/'geometry.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
    assert full.getchannel('A').getbbox()
    print(json.dumps(metrics,indent=2))


if __name__=='__main__':
    main()
