"""把 APP 的 ic_agent_*.xml 转成内联 SVG，写入 src/marks.js（图标与 APP 同源）。"""
import re, sys, pathlib, xml.etree.ElementTree as ET
A = '{http://schemas.android.com/apk/res/android}'; AA = '{http://schemas.android.com/aapt}'
root = pathlib.Path(__file__).resolve().parents[4]; src = root / 'android/app/src/main/res/drawable'
names = dict(claude='claude', codex='codex', deepseek='dsh', kimi='kimi', openclaw='openclaw', hermes='hermes', opencode='opencode_dark', pi='pi')
def col(c):
    if c.upper() in ('#000000', '#FF000000'): return 'currentColor'
    return '#' + c[3:] if len(c) == 9 else c
gid = 0
def conv(el, defs):
    global gid; out = ''
    for e in el:
        if e.tag == 'group':
            t = []
            if e.get(A + 'translateX') or e.get(A + 'translateY'): t.append(f"translate({e.get(A + 'translateX', '0')} {e.get(A + 'translateY', '0')})")
            if e.get(A + 'scaleX'): t.append(f"scale({e.get(A + 'scaleX')} {e.get(A + 'scaleY')})")
            out += f"<g transform=\"{' '.join(t)}\">{conv(e, defs)}</g>"
        elif e.tag == 'path':
            at = {'d': re.sub(r'\s+', ' ', e.get(A + 'pathData')).strip()}
            f = e.get(A + 'fillColor'); at['fill'] = col(f) if f else 'none'
            if e.get(A + 'fillAlpha'): at['fill-opacity'] = e.get(A + 'fillAlpha')
            if e.get(A + 'fillType') == 'evenOdd': at['fill-rule'] = 'evenodd'
            if e.get(A + 'strokeColor'): at['stroke'] = col(e.get(A + 'strokeColor')); at['stroke-width'] = e.get(A + 'strokeWidth'); at['stroke-linecap'] = e.get(A + 'strokeLineCap', 'butt')
            for a in e.findall(AA + 'attr'):
                g = a.find('gradient'); gid += 1; i = f'mk{gid}'; stops = [(x.get(A + 'offset'), x.get(A + 'color')) for x in g.findall('item')] or [('0', g.get(A + 'startColor')), ('1', g.get(A + 'endColor'))]
                st = ''.join(f'<stop offset="{o}" stop-color="{col(c)}"/>' for o, c in stops)
                if g.get(A + 'type') == 'radial': defs.append(f'<radialGradient id="{i}" gradientUnits="userSpaceOnUse" cx="{g.get(A + "centerX")}" cy="{g.get(A + "centerY")}" r="{g.get(A + "gradientRadius")}">{st}</radialGradient>')
                else: defs.append(f'<linearGradient id="{i}" gradientUnits="userSpaceOnUse" x1="{g.get(A + "startX")}" y1="{g.get(A + "startY")}" x2="{g.get(A + "endX")}" y2="{g.get(A + "endY")}">{st}</linearGradient>')
                at['fill' if 'fill' in a.get('name') else 'stroke'] = f'url(#{i})'
            out += '<path ' + ' '.join(f'{k}="{v}"' for k, v in at.items()) + '/>'
    return out
res = []
for k, n in names.items():
    r = ET.parse(src / f'ic_agent_{n}.xml').getroot(); defs = []; body = conv(r, defs)
    svg = f'<svg viewBox="0 0 {r.get(A + "viewportWidth")} {r.get(A + "viewportHeight")}" aria-hidden="true">' + (f'<defs>{"".join(defs)}</defs>' if defs else '') + body + '</svg>'
    print(k, len(svg)); res.append(f'  {k}: {svg!r},')
(root / 'docs/design/fleet/src/marks.js').write_text('// 由 tools/marks.py 从 APP 的 ic_agent_*.xml 生成\nexport const MARKS = {\n' + '\n'.join(res) + '\n};\n')
