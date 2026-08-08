#!/usr/bin/env python3
"""Draw the tray-menu glyphs, in a light-appearance and a dark-appearance set.

muda hands the PNG straight to NSMenuItem.setImage without marking it a template image, so the
bitmap is shown exactly as drawn: it neither inverts with the system appearance nor turns white
over a highlighted row. Two sets are therefore drawn — near-black and near-white — and `lib.rs`
picks one at menu-build time, swapping when the system appearance changes.

The 0.88 alpha matches macOS `labelColor`, which is what the menu text beside these is drawn in.
A fully opaque glyph sits visibly heavier than the label next to it.

Drawn at 4x and downsampled, which is where the antialiasing comes from — PIL has no native
stroke antialiasing.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
FINAL = 36          # 18pt at 2x, the height muda scales menu icons to
S = 4               # supersample factor
N = FINAL * S       # working canvas
A = 224             # ~0.88, macOS labelColor
SETS = {"light": (0, 0, 0, A), "dark": (255, 255, 255, A)}
C = SETS["light"]   # rebound per set below
OUT = ROOT
W = 9 * S // 4      # stroke width in working pixels


def canvas():
    im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def save(im, name):
    im.resize((FINAL, FINAL), Image.LANCZOS).save(os.path.join(OUT, name + ".png"))


def u(v):
    """Convert a 0..100 design-space coordinate to working pixels."""
    return v * N / 100.0


def cap(d, x, y, r=None):
    """Round off a stroke end — PIL draws butt caps only."""
    r = r or W / 2
    d.ellipse([x - r, y - r, x + r, y + r], fill=C)


def area():
    """Crop marks: the corners of a selection, which is what the tool draws."""
    im, d = canvas()
    a, b, arm = u(16), u(84), u(24)
    for (cx, cy, sx, sy) in ((a, a, 1, 1), (b, a, -1, 1), (a, b, 1, -1), (b, b, -1, -1)):
        d.line([cx, cy, cx + arm * sx, cy], fill=C, width=W)
        d.line([cx, cy, cx, cy + arm * sy], fill=C, width=W)
        cap(d, cx, cy)
    return im


def screen():
    """A display on a stand."""
    im, d = canvas()
    d.rounded_rectangle([u(10), u(20), u(90), u(70)], radius=u(9), outline=C, width=W)
    d.line([u(35), u(83), u(65), u(83)], fill=C, width=W)
    d.line([u(50), u(70), u(50), u(83)], fill=C, width=W)
    return im


def window():
    """A window: frame plus the title bar that distinguishes it from a plain rectangle."""
    im, d = canvas()
    d.rounded_rectangle([u(12), u(18), u(88), u(82)], radius=u(10), outline=C, width=W)
    d.line([u(12), u(37), u(88), u(37)], fill=C, width=W)
    r = u(3.5)
    for cx in (u(23), u(34), u(45)):
        d.ellipse([cx - r, u(27.5) - r, cx + r, u(27.5) + r], fill=C)
    return im


def scroll():
    """A window of content with a chevron below it: the capture keeps going past the frame.

    The arrow is kept clear of the frame rather than crossing it — at 18pt an overlap reads as
    a drawing mistake rather than as motion.
    """
    im, d = canvas()
    d.rounded_rectangle([u(14), u(6), u(86), u(58)], radius=u(9), outline=C, width=W)
    for y in (u(24), u(38)):
        d.line([u(28), y, u(72), y], fill=C, width=W)
    d.line([u(32), u(74), u(50), u(92), u(68), u(74)], fill=C, width=W, joint="curve")
    cap(d, u(32), u(74))
    cap(d, u(68), u(74))
    return im


def text():
    """A serif T inside viewfinder brackets: recognising text within a region."""
    im, d = canvas()
    arm = u(20)
    for (cx, cy, sx, sy) in ((u(12), u(12), 1, 1), (u(88), u(12), -1, 1),
                             (u(12), u(88), 1, -1), (u(88), u(88), -1, -1)):
        d.line([cx, cy, cx + arm * sx, cy], fill=C, width=W)
        d.line([cx, cy, cx, cy + arm * sy], fill=C, width=W)
        cap(d, cx, cy)
    d.line([u(31), u(35), u(69), u(35)], fill=C, width=W)
    d.line([u(50), u(35), u(50), u(69)], fill=C, width=W)
    return im


def record():
    """The universal record dot, ringed so it reads at 18pt."""
    im, d = canvas()
    d.ellipse([u(12), u(12), u(88), u(88)], outline=C, width=W)
    d.ellipse([u(33), u(33), u(67), u(67)], fill=C)
    return im


def delayed():
    """A clock — the delay is the whole point of the item."""
    im, d = canvas()
    d.ellipse([u(13), u(13), u(87), u(87)], outline=C, width=W)
    d.line([u(50), u(50), u(50), u(29)], fill=C, width=W)
    d.line([u(50), u(50), u(68), u(58)], fill=C, width=W)
    cap(d, u(50), u(50), W * 0.7)
    return im


def openfile():
    """A folder."""
    im, d = canvas()
    d.line([u(11), u(78), u(11), u(24), u(41), u(24), u(50), u(36), u(89), u(36), u(89), u(78), u(11), u(78)],
           fill=C, width=W, joint="curve")
    return im


def clipboard():
    """A clipboard with its clip."""
    im, d = canvas()
    d.rounded_rectangle([u(20), u(20), u(80), u(90)], radius=u(9), outline=C, width=W)
    d.rounded_rectangle([u(37), u(8), u(63), u(28)], radius=u(6), fill=C)
    return im


def settings():
    """Sliders rather than a gear: a gear's teeth turn to mush at this size."""
    im, d = canvas()
    for y, knob in ((u(26), u(66)), (u(50), u(38)), (u(74), u(58))):
        d.line([u(14), y, u(86), y], fill=C, width=W)
        d.ellipse([knob - u(9), y - u(9), knob + u(9), y + u(9)], fill=(0, 0, 0, 0))
        d.ellipse([knob - u(9), y - u(9), knob + u(9), y + u(9)], outline=C, width=W)
    return im


def quit_():
    """The power glyph."""
    im, d = canvas()
    d.arc([u(16), u(20), u(84), u(88)], start=-60, end=240, fill=C, width=W)
    d.line([u(50), u(10), u(50), u(46)], fill=C, width=W)
    cap(d, u(50), u(12))
    return im


def app():
    """A camera, standing in for the app itself on the "Open" item."""
    im, d = canvas()
    d.rounded_rectangle([u(8), u(26), u(92), u(84)], radius=u(11), outline=C, width=W)
    d.line([u(34), u(26), u(41), u(14), u(59), u(14), u(66), u(26)], fill=C, width=W, joint="curve")
    d.ellipse([u(36), u(40), u(64), u(68)], outline=C, width=W)
    return im


ICONS = {
    "app": app, "area": area, "screen": screen, "window": window, "scroll": scroll,
    "text": text, "record": record, "delayed": delayed, "openfile": openfile,
    "clipboard": clipboard, "settings": settings, "quit": quit_,
}

for appearance, colour in SETS.items():
    C = colour                                  # noqa: F811 — read as a global by the drawers
    OUT = os.path.join(ROOT, appearance)
    os.makedirs(OUT, exist_ok=True)
    for name, fn in ICONS.items():
        save(fn(), name)
    print(f"wrote {len(ICONS)} {appearance} icons to {OUT}")
