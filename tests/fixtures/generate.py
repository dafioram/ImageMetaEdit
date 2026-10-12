#!/usr/bin/env python3
"""Regenerates the sample files in this folder.

The committed fixtures are the source of truth for the test suite; this
script exists so they can be rebuilt or extended. Nothing here runs in CI.

    python3 -m venv .venv && . .venv/bin/activate
    pip install pillow pillow-heif
    python3 tests/fixtures/generate.py

Every photo is a synthetic scene with a fixed seed, so the output is stable
across runs with the same Pillow / pillow-heif versions.
"""
import io
import os
import random
import zipfile

from PIL import Image, ImageDraw, ImageFilter
from PIL.ExifTags import IFD

import pillow_heif

pillow_heif.register_heif_opener()

HERE = os.path.dirname(os.path.abspath(__file__))


def scene(width, height, seed, alpha=False):
    """A photo-like test scene: gradient sky, shapes, and light grain.

    The grain keeps JPEG output large enough that compression tests have
    something real to shrink."""
    rng = random.Random(seed)
    mode = "RGBA" if alpha else "RGB"
    img = Image.new(mode, (width, height))
    draw = ImageDraw.Draw(img)
    top, bottom = (70, 120, 200), (240, 200, 140)
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color + ((255,) if alpha else ()))
    for _ in range(40):
        x, y = rng.randrange(width), rng.randrange(height)
        r = rng.randrange(8, max(9, width // 8))
        fill = tuple(rng.randrange(256) for _ in range(3)) + ((255,) if alpha else ())
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)
    if alpha:
        # Transparent band on the left edge so alpha survives the round trip.
        draw.rectangle([0, 0, width // 10, height], fill=(0, 0, 0, 0))
    grain = Image.new("L", (width, height))
    grain.putdata([rng.randrange(0, 40) for _ in range(width * height)])
    noise = Image.merge("RGB", (grain, grain, grain))
    if alpha:
        base = img.convert("RGB")
        blended = Image.blend(base, noise.filter(ImageFilter.GaussianBlur(0.5)), 0.15)
        return Image.merge("RGBA", (*blended.split(), img.split()[3]))
    return Image.blend(img, noise.filter(ImageFilter.GaussianBlur(0.5)), 0.15)


def camera_exif():
    """EXIF covering the fields the editor shows: camera, date, description,
    orientation, and a GPS fix (San Francisco, 37.7749 N 122.4194 W)."""
    exif = Image.Exif()
    exif[0x010F] = "Datum Test Cam"   # Make
    exif[0x0110] = "TC-1"             # Model
    exif[0x010E] = "Fixture photo"    # ImageDescription
    exif[0x0112] = 1                  # Orientation: normal
    exif.get_ifd(IFD.Exif)[0x9003] = "2024:05:01 10:30:00"  # DateTimeOriginal
    gps = exif.get_ifd(IFD.GPSInfo)
    gps[1] = "N"
    gps[2] = (37.0, 46.0, 29.64)
    gps[3] = "W"
    gps[4] = (122.0, 25.0, 9.84)
    return exif


def save(img, name, **kwargs):
    path = os.path.join(HERE, name)
    fmt = kwargs.pop("format", None)
    img.save(path, format=fmt, **kwargs)
    print(f"wrote {name} ({os.path.getsize(path)} bytes)")
    return path


def main():
    # Input formats the app edits (JPEG, PNG, HEIC/HEIF).
    big = scene(1200, 900, seed=1)
    save(big, "photo-exif.jpg", format="JPEG", quality=92, exif=camera_exif().tobytes())
    save(scene(320, 240, seed=2), "photo-noexif.jpeg", format="JPEG", quality=85)

    alpha = scene(400, 300, seed=3, alpha=True)
    save(alpha, "photo-alpha-exif.png", format="PNG", exif=camera_exif().tobytes())
    save(scene(200, 150, seed=4), "photo-noexif.png", format="PNG")

    save(big.resize((800, 600)), "photo-exif.heic", format="HEIF", quality=85,
         exif=camera_exif().tobytes())
    save(scene(320, 240, seed=5), "photo-noexif.heif", format="HEIF", quality=85)

    # Formats the app only shows (view-only, passed through unchanged).
    small = scene(160, 120, seed=6)
    save(small, "sample.gif", format="GIF")
    save(small, "sample.bmp", format="BMP")
    save(small, "sample.webp", format="WEBP", quality=90)
    save(small, "sample.tiff", format="TIFF")
    save(small, "sample.avif", format="AVIF", quality=60)

    # Damaged input: a real JPEG cut off partway through.
    full = open(os.path.join(HERE, "photo-exif.jpg"), "rb").read()
    with open(os.path.join(HERE, "broken-truncated.jpg"), "wb") as f:
        f.write(full[: len(full) // 4])
    print("wrote broken-truncated.jpg")

    # Zip archive with the things the importer must handle: images in folders,
    # macOS cruft (skipped silently), a text file and a nested zip (skipped
    # and counted), and an image wrapped in a folder.
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("readme.txt", "not an image")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(HERE, "photo-exif.jpg"), "trip/photo-exif.jpg")
        z.write(os.path.join(HERE, "photo-alpha-exif.png"), "trip/photo-alpha-exif.png")
        z.write(os.path.join(HERE, "photo-exif.heic"), "trip/photo-exif.heic")
        z.write(os.path.join(HERE, "sample.gif"), "trip/sample.gif")
        z.writestr("trip/notes.txt", "not an image")
        z.writestr("trip/nested.zip", inner.getvalue())
        z.writestr("__MACOSX/trip/._photo-exif.jpg", b"\x00\x05\x16\x07")
        z.writestr("trip/.DS_Store", b"\x00\x00\x00\x01Bud1")
    with open(os.path.join(HERE, "archive.zip"), "wb") as f:
        f.write(buf.getvalue())
    print("wrote archive.zip")

    with open(os.path.join(HERE, "corrupt.zip"), "wb") as f:
        f.write(b"this is not a zip file" * 20)
    print("wrote corrupt.zip")


if __name__ == "__main__":
    main()
