"""Rebuild the selected Orbis B icon kit. Requires Pillow, NumPy and SciPy.

The B artwork supplies the mark shape and contact shadow. The app icon redraws
the mark in the MARK ink colour on the porcelain SURFACE gradient;
in-app, web and tray marks keep the porcelain-white mark so they stay visible in
light and dark wells. Both are tuned here without image generation.
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
# Warm porcelain surface lit from the top-left, matching the mark's contact
# shadow. Colours are blended in OKLab; lift/settle values are OKLab lightness
# offsets.
SURFACE = {
    'top_left': '#FBFBF9',
    'bottom_right': '#E4E6EA',
    'angle_deg': 20,
    'sheen': 0.0,
    'halo': 0.0,
    'vignette': 0.01,
}
# App-icon mark: ring and small square both in ink. light_falloff darkens the
# ink towards the bottom-right, following the surface light. Each shadow is
# (offset_x, offset_y, blur_sigma, opacity) in master pixels, cast in the ink
# colour away from the top-left light.
MARK = {
    'ink': '#151E33',
    'light_falloff': 0.10,
    'edge_smooth_px': 2.0,
    'shadows': [(2, 3, 3.5, 0.14), (8, 14, 18, 0.10)],
}
# Share of the porcelain mark's contact-shadow alpha kept; the full shadow reads
# as a thick plastic emboss, so it is softened rather than removed.
SHADOW_KEEP = 0.45
LANCZOS = Image.Resampling.LANCZOS


def _hex(value):
    return np.array([int(value[i:i+2], 16) for i in (1, 3, 5)], float)


def _to_oklab(rgb):
    c = rgb/255
    lin = np.where(c <= .04045, c/12.92, ((c+.055)/1.055)**2.4)
    m1 = np.array([[.4122214708, .5363325363, .0514459929],
                   [.2119034982, .6806995451, .1073969566],
                   [.0883024619, .2817188376, .6299787005]])
    m2 = np.array([[.2104542553, .7936177850, -.0040720468],
                   [1.9779984951, -2.4285922050, .4505937099],
                   [.0259040371, .7827717662, -.8086757660]])
    return np.cbrt(lin @ m1.T) @ m2.T


def _from_oklab(lab):
    m2 = np.array([[1, .3963377774, .2158037573],
                   [1, -.1055613458, -.0638541728],
                   [1, -.0894841775, -1.2914855480]])
    m1 = np.array([[4.0767416621, -3.3077115913, .2309699292],
                   [-1.2684380046, 2.6097574011, -.3413193965],
                   [-.0041960863, -.7034186147, 1.7076147010]])
    lin = np.clip(((lab @ m2.T)**3) @ m1.T, 0, 1)
    return np.where(lin <= .0031308, lin*12.92, 1.055*lin**(1/2.4)-.055)*255


def surface(size, span=(0.0, 1.0)):
    """Render the icon surface; span maps the square master onto (0, 1)."""
    s = SURFACE
    t = (np.arange(size)+.5)/size*(span[1]-span[0]) + span[0]
    u, v = np.meshgrid(t, t)
    angle = np.radians(s['angle_deg'])
    dx, dy = np.sin(angle), np.cos(angle)
    k = np.clip(((u-.5)*dx + (v-.5)*dy)/(dx+dy) + .5, 0, 1)
    k = k*k*(3-2*k)*.35 + k*.65
    lab = _to_oklab(_hex(s['top_left']))*(1-k[..., None]) + _to_oklab(_hex(s['bottom_right']))*k[..., None]
    # Soft key light at the top-left, a faint lift behind the mark, and
    # slightly settled corners give the tile depth without a visible effect.
    lab[..., 0] += s['sheen']*np.exp(-2.2*(np.hypot(u-.22, v-.05)/.85)**2)
    lab[..., 0] += s['halo']*np.exp(-2.0*(np.hypot(u-.5, v-.52)/.42)**2)
    lab[..., 0] -= s['vignette']*np.clip(np.hypot(u-.5, v-.45)/.75, 0, 1.4)**2.2
    rgb = _from_oklab(lab)
    # Fixed-seed triangular dither keeps the 8-bit gradient free of banding.
    rng = np.random.default_rng(7)
    rgb += rng.random(rgb.shape) - rng.random(rgb.shape)
    return Image.fromarray(np.clip(np.round(rgb), 0, 255).astype('uint8'), 'RGB')


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


def soften_shadow(symbol):
    # Pure-black pixels with alpha are the contact shadow written by
    # extract_symbol; the white body keeps its colour and full alpha.
    arr = np.array(symbol)
    shadow = (arr[..., :3].sum(axis=2) == 0) & (arr[..., 3] > 0)
    arr[shadow, 3] = (arr[shadow, 3]*SHADOW_KEEP).astype('uint8')
    return Image.fromarray(arr, 'RGBA')


def ink_symbol(mask):
    # Redraw the mark from its mask: the porcelain body's bright rim and the
    # source shadow would leave a light gap around a dark mark, and the binary
    # mask alone shows stair steps at 1024px.
    height, width = mask.shape
    sigma = MARK['edge_smooth_px']
    # Blurring the mask and re-ramping its 0.5 level gives a smooth contour
    # with a one-pixel anti-aliased edge (Gaussian slope at the edge).
    slope = 1/(np.sqrt(2*np.pi)*sigma)
    alpha = np.clip((ndimage.gaussian_filter(mask.astype(float), sigma)-.5)/slope+.5, 0, 1)
    yy, xx = np.mgrid[:height, :width]
    light = 1 - MARK['light_falloff']*(xx+yy)/(width+height-2)
    ink = _hex(MARK['ink'])
    clear = np.ones((height, width))
    for dx, dy, blur, opacity in MARK['shadows']:
        cast = ndimage.gaussian_filter(ndimage.shift(alpha, (dy, dx), order=1), blur)
        clear *= 1 - cast*opacity
    shadow = np.dstack((np.broadcast_to(ink, (height, width, 3)), (1-clear)*255))
    body = np.dstack((ink*light[..., None], alpha*255))
    out = Image.fromarray(np.clip(np.round(shadow), 0, 255).astype('uint8'), 'RGBA')
    out.alpha_composite(Image.fromarray(np.clip(np.round(body), 0, 255).astype('uint8'), 'RGBA'))
    return out


def place_adaptive(symbol, cx, cy, scale):
    # 108dp adaptive canvas at 10x; the shadow fades at the guaranteed 33dp
    # safe circle while the solid mark stays within its 31.5dp radius.
    full = Image.new('RGBA', (1080, 1080))
    resized = symbol.resize((round(symbol.width*scale), round(symbol.height*scale)), LANCZOS)
    px, py = round(540-cx*scale), round(540-cy*scale)
    full.alpha_composite(resized, (px, py))
    fy, fx = np.mgrid[:1080, :1080]
    safe_fade = np.clip((330-np.hypot(fx-540, fy-540))/5, 0, 1)
    full.putalpha(Image.fromarray((np.array(full.getchannel('A'))*safe_fade).astype('uint8')))
    return full, resized.size, (px, py)


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
    extracted = extract_symbol(rgb.astype(float), combined)
    symbol = soften_shadow(extracted)
    icon_symbol = ink_symbol(combined)

    # The app icon uses the ink mark on the porcelain surface.
    master = surface(symbol.width).convert('RGBA')
    master.alpha_composite(icon_symbol)
    master = master.convert('RGB')
    save(master, ROOT/'master/orbis-app-1024.png')
    save(master.resize((512,512), LANCZOS), ROOT/'store/google-play-512.png')
    save(master, ROOT/'store/app-store-1024.png')

    ys, xs = np.nonzero(combined)
    cx, cy = (xs.min()+xs.max()+1)/2, (ys.min()+ys.max()+1)/2
    radius = float(np.sqrt((xs-cx)**2+(ys-cy)**2).max())
    # 31.5dp radius, inside Android's guaranteed 33dp safe circle.
    scale = 315/radius
    # Launcher foreground carries the ink mark; in-app wells use the porcelain
    # mark, which reads in both light and dark themes.
    full, resized_size, (px, py) = place_adaptive(icon_symbol, cx, cy, scale)
    in_app, _, _ = place_adaptive(symbol, cx, cy, scale)
    save(full, ROOT/'android/adaptive-foreground-1080.png')
    # The master spans the visible 72dp; the 108dp layer extends it by 18dp
    # per side so launcher masks and parallax see the same lighting.
    adaptive_background = surface(1080, span=(-.25, 1.25))
    save(adaptive_background, ROOT/'android/adaptive-background-1080.png')
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
    save(adaptive_background.resize((432,432),LANCZOS), export/'drawable-nodpi/orbis_launcher_background.png')
    save(in_app.resize((432,432),LANCZOS), export/'drawable-nodpi/orbis_mark.png')
    # The gradient drawable replaces the former solid colour resource.
    for base in (export, RES):
        (base/'values/orbis_icon_colors.xml').unlink(missing_ok=True)
    for version in [26,33]:
        for name in ['ic_launcher','ic_launcher_round']:
            p=export/f'mipmap-anydpi-v{version}/{name}.xml'; p.parent.mkdir(parents=True,exist_ok=True)
            mono='\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />' if version==33 else ''
            p.write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/orbis_launcher_background" />
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
    save(in_app.resize((432,432), LANCZOS), ios/'OrbisMark.imageset/OrbisMark.png')
    host_assets = REPO/'packages/windows-host/src/assets'
    save(symbol.resize((2048,2048), LANCZOS), host_assets/'orbis.png')
    master.save(host_assets/'orbis.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    relay = REPO/'packages/relay/src/web'
    save(symbol.resize((2048,2048), LANCZOS), relay/'orbis.png')
    save(symbol.resize((512,512), LANCZOS), relay/'promo/orbis-symbol-2048.png')
    save(in_app.resize((432,432), LANCZOS), relay/'promo/orbis-mark-ios.png')

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
    d.text((48,30),'Orbis / porcelain',font=title,fill=ink)
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
    monochrome.paste(source_mask.resize(resized_size, LANCZOS), (px,py))
    mono=Image.new('RGBA',visible.size,(197,218,255,255)); mono.putalpha(monochrome.crop((180,180,900,900)))
    theme=Image.new('RGBA',visible.size,(41,57,80,255));theme.alpha_composite(mono)
    sheet.paste(theme.resize((160,160),LANCZOS),(1175,600))
    d.text((1170,810),'themed',font=font,fill=ink)
    save(sheet,ROOT/'preview.png')
    metrics={'background':{'type':'oklab-gradient',**SURFACE},'app_icon_mark':MARK,'source_mask_threshold_mean_rgb':threshold,'source_foreground_bbox_px':[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)],'adaptive_safe_radius_dp':31.5,'adaptive_canvas_dp':108,'launcher_visible_dp':72,'foreground_count':len(selected)}
    (ROOT/'geometry.json').write_text(json.dumps(metrics,indent=2),encoding='utf-8')
    assert full.getchannel('A').getbbox()
    print(json.dumps(metrics,indent=2))


if __name__=='__main__':
    main()
