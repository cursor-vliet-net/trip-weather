"""Generate PWA icons (run: python3 icons/make_icons.py). Requires Pillow."""
from PIL import Image, ImageDraw
import os

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024  # draw large, downsample for antialiasing

def draw(maskable=False):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = (15, 118, 110, 255)
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
        k = 0.72  # keep content inside the safe zone
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=bg)
        k = 0.9
    o = (1 - k) * S / 2
    P = lambda x, y: (o + x * k, o + y * k)
    # sun
    cx, cy, r = P(640, 330) + (150 * k,)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(253, 224, 71, 255))
    # cloud
    white = (255, 255, 255, 255)
    for (x, y, rr) in [(400, 420, 130), (540, 380, 160), (680, 440, 120)]:
        X, Y = P(x, y); R = rr * k
        d.ellipse([X - R, Y - R, X + R, Y + R], fill=white)
    d.rounded_rectangle([*P(270, 420), *P(800, 560)], radius=int(70 * k), fill=white)
    # route: dashed path with endpoints
    pts = [P(220, 860), P(380, 720), P(560, 800), P(800, 660)]
    d.line(pts, fill=(255, 255, 255, 220), width=int(34 * k), joint="curve")
    for (x, y), col in [(pts[0], (34, 197, 94, 255)), (pts[-1], (239, 68, 68, 255))]:
        R = 52 * k
        d.ellipse([x - R, y - R, x + R, y + R], fill=col, outline=white, width=int(14 * k))
    return im

def save(im, name, size):
    im.resize((size, size), Image.LANCZOS).save(os.path.join(HERE, name))

std, mask = draw(False), draw(True)
save(std, "icon-192.png", 192)
save(std, "icon-512.png", 512)
save(mask, "icon-maskable-512.png", 512)
# Apple touch icon: opaque, iOS applies its own rounding
save(mask.convert("RGB"), "apple-touch-icon.png", 180)
print("icons written")
