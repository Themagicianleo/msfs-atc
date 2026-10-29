"""Draw the app icons (a simple radar scope) without any image library."""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"


def png(size: int) -> bytes:
    bg, ring, sweep, dot = (11, 14, 18), (60, 207, 122), (79, 179, 255), (230, 233, 237)
    c = (size - 1) / 2
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - c, y - c
            r = math.hypot(dx, dy) / (size / 2)
            ang = (math.degrees(math.atan2(dy, dx)) + 360) % 360
            px = bg
            if r < 0.86:
                px = (16, 24, 30)
                if 300 <= ang <= 350:
                    k = (ang - 300) / 50
                    px = tuple(int(b + (s - b) * k * 0.7) for b, s in zip(px, sweep))
                for rr in (0.3, 0.55, 0.8):
                    if abs(r - rr) < 0.018:
                        px = ring
                if abs(dx) < size * 0.008 or abs(dy) < size * 0.008:
                    px = tuple(int(a * 0.6 + b * 0.4) for a, b in zip(px, ring))
            if math.hypot(dx - size * 0.16, dy + size * 0.12) < size * 0.035:
                px = dot
            row.extend(px)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (180, 512):
        (OUT / f"icon-{s}.png").write_bytes(png(s))
    print("icons written to", OUT)
