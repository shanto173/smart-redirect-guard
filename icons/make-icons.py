"""Generate SRG extension icons as PNGs with no third-party dependencies.

Design: rounded-square badge with an indigo->blue vertical gradient, a white shield,
and a diagonal "blocked" slash cut out of the shield. Rendered with 4x supersampling
for clean edges at 16px.
"""
import struct
import zlib
import os
import sys

SS = 4  # supersampling factor


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect(x, y, w, h, r):
    """Signed-ish containment test for a rounded rectangle in [0,w]x[0,h]."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    return (dx * dx + dy * dy) <= r * r


def point_in_poly(px, py, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > py) != (yj > py):
            xint = xj + (py - yj) * (xi - xj) / (yi - yj)
            if px < xint:
                inside = not inside
        j = i
    return inside


def shield_contains(px, py, size):
    """Classic shield: flat top with rounded shoulders, sides tapering to a rounded point."""
    w = 0.52 * size
    h = 0.66 * size
    x0 = (size - w) / 2.0
    y0 = 0.19 * size
    u = px - x0
    v = py - y0
    if u < 0 or u > w or v < 0 or v > h:
        return False
    body_h = 0.44 * h          # straight-sided upper body
    r = 0.22 * w               # shoulder radius
    if v <= body_h:
        if v >= r:
            return True
        cu = min(max(u, r), w - r)
        du, dv = u - cu, v - r
        return du * du + dv * dv <= r * r
    t = (v - body_h) / (h - body_h)
    t = min(1.0, t)
    half = (w / 2.0) * ((1.0 - t) ** 0.52)
    return abs(u - w / 2.0) <= half


def slash_contains(px, py, size):
    """Diagonal bar from upper-left to lower-right across the shield."""
    # line through center at -45 degrees; keep points within a band
    cx = cy = 0.5 * size
    # rotate point by 45deg
    dx = px - cx
    dy = py - cy
    d = (dx - dy) / (2 ** 0.5)
    e = (dx + dy) / (2 ** 0.5)
    half_w = 0.062 * size
    half_len = 0.295 * size
    return abs(d) <= half_w and abs(e) <= half_len


def render(size):
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    radius = size * 0.22
    for yy in range(size):
        for xx in range(size):
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = xx + (sx + 0.5) / SS
                    fy = yy + (sy + 0.5) / SS
                    if not rounded_rect(fx, fy, size, size, radius):
                        continue
                    t = fy / size
                    # background gradient: indigo -> blue
                    br = lerp(79, 37, t)
                    bg = lerp(70, 99, t)
                    bb = lerp(229, 235, t)
                    r, g, b = br, bg, bb
                    in_shield = shield_contains(fx, fy, size)
                    if slash_contains(fx, fy, size):
                        r, g, b = (225, 29, 72) if in_shield else (248, 113, 133)
                    elif in_shield:
                        r, g, b = 255, 255, 255
                    ar += r
                    ag += g
                    ab += b
                    aa += 255
            n = SS * SS
            if aa == 0:
                px[yy][xx] = (0, 0, 0, 0)
            else:
                cov = aa / (255 * n)
                px[yy][xx] = (
                    int(round(ar / (aa / 255))),
                    int(round(ag / (aa / 255))),
                    int(round(ab / (aa / 255))),
                    int(round(cov * 255)),
                )
    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((max(0, min(255, r)), max(0, min(255, g)),
                          max(0, min(255, b)), max(0, min(255, a))))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)
    return len(out)


if __name__ == '__main__':
    dest = sys.argv[1]
    os.makedirs(dest, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(dest, 'icon%d.png' % s)
        n = write_png(p, render(s))
        print('wrote %s (%d bytes)' % (p, n))
