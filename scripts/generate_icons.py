#!/usr/bin/env python3
"""Generate the four PNG icons required by fnpack and the desktop entry.

No third-party dependencies. Output:
  ICON.PNG              64x64
  ICON_256.PNG          256x256
  app/ui/images/icon_64.png
  app/ui/images/icon_256.png
"""
from __future__ import annotations

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def clamp(value: float) -> int:
    return max(0, min(255, int(value)))


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def aurora_pixel(x: int, y: int, size: int) -> tuple[int, int, int]:
    nx = x / (size - 1)
    ny = y / (size - 1)

    # Deep blue -> violet diagonal base.
    r = 14 + 62 * nx + 14 * ny
    g = 22 + 18 * nx + 30 * ny
    b = 68 + 76 * nx + 10 * ny

    # Aurora ribbons.
    ribbons = [
        (0.24, 0.10, 0.07, (68, 226, 196)),
        (0.44, -0.12, 0.08, (92, 158, 255)),
        (0.64, 0.09, 0.06, (196, 120, 246)),
    ]
    for center_y, phase, thickness, color in ribbons:
        center = center_y + 0.07 * math.sin(nx * math.pi * 2 + phase)
        dist = abs(ny - center)
        if dist < thickness:
            alpha = (1.0 - dist / thickness) ** 1.4 * 0.72
            r = r * (1 - alpha) + color[0] * alpha
            g = g * (1 - alpha) + color[1] * alpha
            b = b * (1 - alpha) + color[2] * alpha

    # Stylised "A" mark: two sloping strokes plus a crossbar.
    left = 0.35 + (0.74 - ny) * 0.17
    right = 0.65 - (0.74 - ny) * 0.17
    stroke = 0.026
    on_slope = abs(nx - left) < stroke or abs(nx - right) < stroke
    on_bar = 0.58 < ny < 0.625 and 0.44 < nx < 0.56
    if 0.26 < ny < 0.76 and (on_slope or on_bar):
        r, g, b = 246, 250, 255

    return clamp(r), clamp(g), clamp(b)


def write_png(path: str, size: int) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(aurora_pixel(x, y, size))

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"sRGB", b"\x00")
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(png)
    print(f"generated {path} ({size}x{size})")


def main() -> None:
    targets = [
        (os.path.join(ROOT, "ICON.PNG"), 64),
        (os.path.join(ROOT, "ICON_256.PNG"), 256),
        (os.path.join(ROOT, "app/ui/images/icon_64.png"), 64),
        (os.path.join(ROOT, "app/ui/images/icon_256.png"), 256),
    ]
    for path, size in targets:
        write_png(path, size)


if __name__ == "__main__":
    main()
