"""Builds the sponsor textures in brand/<name>/ from the official logo files in brand/src/.

Run from the site folder:  python3 tools/build_brand.py
Needs Pillow and the Manrope font. Prints the aspect ratio of each texture; js/brand.js uses those numbers.
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
SRC = os.path.join(SITE, 'brand', 'src')
HELVETICA = '/System/Library/Fonts/HelveticaNeue.ttc'


def manrope():
    # Manrope (Google Fonts, OFL) is not kept in the repo; install it or drop Manrope-Bold.ttf into brand/src/
    for d in (SRC, os.path.expanduser('~/Library/Fonts'), '/Library/Fonts'):
        path = os.path.join(d, 'Manrope-Bold.ttf')
        if os.path.exists(path):
            return path
    raise SystemExit('Manrope-Bold.ttf not found: install Manrope from Google Fonts')

BRANDS = {
    'ingenio': {
        'navy': '#222E40', 'accent': '#DEDC00', 'white': '#FFFFFF',
        'font': (manrope(), 0),
        'logo': 'ingenio-logo-white.png',
        'domain': 'ingeniotech.co.uk', 'line': ['IT Support', 'Cyber Security', 'AI Support'],
    },
    'assurix': {
        'navy': '#111F46', 'accent': '#BED95C', 'white': '#FFFFFF',
        'font': (HELVETICA, 1) if os.path.exists(HELVETICA) else (manrope(), 0),
        'logo': 'assurix-logo-white.png',
        'domain': 'assurix.com', 'line': ['Proof, not promises'],
    },
}


def font(b, size):
    path, index = b['font']
    return ImageFont.truetype(path, size, index=index)


def text_img(b, text, size, colour):
    f = font(b, size)
    x0, y0, x1, y1 = f.getbbox(text)
    im = Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((-x0, -y0), text, font=f, fill=colour)
    return im


def logo(b, height):
    im = Image.open(os.path.join(SRC, b['logo'])).convert('RGBA')
    im = im.crop(im.getbbox())
    return im.resize((round(im.width * height / im.height), height), Image.LANCZOS)


def row(parts, gap):
    """Lay images side by side, centred vertically."""
    w = sum(p.width for p in parts) + gap * (len(parts) - 1)
    h = max(p.height for p in parts)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    x = 0
    for p in parts:
        out.alpha_composite(p, (x, (h - p.height) // 2))
        x += p.width + gap
    return out


def save(im, name, b_name, note):
    path = os.path.join(SITE, 'brand', b_name, name)
    im.save(path, optimize=True)
    print(f'{b_name}/{name}: {im.width}x{im.height} aspect {im.width / im.height:.3f}  {note}')


def line_img(b, size):
    """The service line or tagline in white, parts split by a dot in the accent colour."""
    parts = []
    for i, p in enumerate(b['line']):
        if i:
            parts.append(text_img(b, '\u2022', size, b['accent']))
        parts.append(text_img(b, p, size, b['white']))
    return row(parts, round(size * 0.45))


def stack(parts, gap):
    """Stack images, centred horizontally."""
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts) + gap * (len(parts) - 1)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    y = 0
    for p in parts:
        out.alpha_composite(p, ((w - p.width) // 2, y))
        y += p.height + gap
    return out


def fit(im, w, h):
    s = min(w / im.width, h / im.height, 1.0)
    return im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS) if s < 1 else im


def padded(content, padx, pady, bg):
    im = Image.new('RGBA', (content.width + 2 * padx, content.height + 2 * pady), bg)
    im.alpha_composite(content, (padx, pady))
    return im


def build(b_name, b):
    clear = (0, 0, 0, 0)
    # see-through versions sit on dark paint and carbon; the panel versions go on patterned liveries
    t = text_img(b, b['domain'], 120, b['white'])
    save(padded(t, 18, 18, clear), 'domain.png', b_name, 'rear wing, engine cover, halo, endplates')
    save(padded(t, 40, 26, b['navy']), 'domain-panel.png', b_name, 'same, on patterned liveries')
    lg = logo(b, 200)
    save(padded(lg, 30, 30, clear), 'logo.png', b_name, 'endplates, front wing, noses')
    save(padded(lg, 60, 44, b['navy']), 'logo-panel.png', b_name, 'same, on patterned liveries')
    # sidepod: logo over the service line or tagline
    lk = stack([logo(b, 200), line_img(b, 50 if len(b['line']) > 1 else 64)], 30)
    save(padded(lk, 30, 30, clear), 'lockup.png', b_name, 'sidepods')
    save(padded(lk, 60, 44, b['navy']), 'lockup-panel.png', b_name, 'sidepods, on patterned liveries')
    # long banner: bridges and the pit building roof
    W, H = 4096, 256
    im = Image.new('RGBA', (W, H), b['navy'])
    d = ImageDraw.Draw(im)
    d.rectangle([0, H - 12, W, H], fill=b['accent'])
    d.rectangle([0, 0, W, 6], fill=b['accent'])
    content = fit(row([logo(b, 150), line_img(b, 84), text_img(b, b['domain'], 92, b['accent'])], 130), W - 240, H - 60)
    im.alpha_composite(content, ((W - content.width) // 2, (H - 12 - content.height) // 2 + 3))
    save(im, 'banner.png', b_name, 'bridges, pit roof')
    # wall boards: two panels that repeat along the wall, logo and domain, then the line
    W, H = 6144, 512
    im = Image.new('RGBA', (W, H), b['navy'])
    d = ImageDraw.Draw(im)
    d.rectangle([0, H - 16, W, H], fill=b['accent'])
    a = fit(row([logo(b, 290), text_img(b, b['domain'], 150, b['accent'])], 170), W // 2 - 260, H - 120)
    c = fit(line_img(b, 170), W // 2 - 260, H - 160)
    im.alpha_composite(a, ((W // 2 - a.width) // 2, (H - 16 - a.height) // 2))
    im.alpha_composite(c, (W // 2 + (W // 2 - c.width) // 2, (H - 16 - c.height) // 2))
    save(im, 'barrier.png', b_name, 'wall boards')


for name, b in BRANDS.items():
    os.makedirs(os.path.join(SITE, 'brand', name), exist_ok=True)
    build(name, b)
