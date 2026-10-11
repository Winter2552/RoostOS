#!/usr/bin/env python3
"""Draws src/email-header.gif: the Roost header that types "roost" and pops up
the bird, once. Needs Pillow (a one-off for whoever edits the header; Roost
itself ships the finished GIF and needs nothing). Run: python3 scripts/make-email-header.py"""
import os
from PIL import Image, ImageDraw, ImageFont

S, W, H = 3, 560, 96
BG, INK = (10, 10, 10), (242, 239, 233)
FONT = os.environ.get('MONO_BOLD', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf')
font = ImageFont.truetype(FONT, 44 * S)


def frame(chev, letters, bird, eye=True):
    im = Image.new('RGB', (W * S, H * S), BG)
    d = ImageDraw.Draw(im)
    x0, y0 = 28 * S, 18 * S
    if chev:
        d.line([(x0, y0 + 8 * S), (x0 + 20 * S, y0 + 30 * S), (x0, y0 + 52 * S)], fill=INK, width=8 * S, joint='curve')
    d.text((x0 + 44 * S, y0 - 2 * S), 'roost'[:letters], font=font, fill=INK)
    bx = x0 + 44 * S + int(font.getlength('roost')) + 12 * S
    if bird:
        w, h, bot = 28 * S, bird * S, y0 + 56 * S
        r, top = min(w, h) // 2, bot - h
        d.rectangle([bx, top + r, bx + w, bot], fill=INK)
        d.rectangle([bx, top, bx + w - r, top + r], fill=INK)
        d.pieslice([bx + w - 2 * r, top, bx + w, top + 2 * r], 270, 360, fill=INK)
        if eye and bird >= 56:
            d.ellipse([bx + 17 * S, y0 + 14 * S, bx + 23 * S, y0 + 20 * S], fill=BG)
    return im.resize((W, H), Image.LANCZOS)


frames, times = [], []


def add(im, ms):
    frames.append(im)
    times.append(ms)


add(frame(0, 0, 0), 250)
add(frame(1, 0, 0), 200)
for n in range(1, 6):
    add(frame(1, n, 0), 110)
for h in (14, 30, 46, 56):
    add(frame(1, 5, h), 70)
add(frame(1, 5, 56, False), 140)
add(frame(1, 5, 56), 4000)  # the last frame stays; the GIF plays once

out = os.path.join(os.path.dirname(__file__), '..', 'src', 'email-header.gif')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=times, optimize=True)
print('wrote', os.path.normpath(out))
