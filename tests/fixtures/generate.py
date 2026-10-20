#!/usr/bin/env python3
"""Regenerates the sample files in this folder.

The committed fixtures are the source of truth for the test suite; this
script exists so they can be rebuilt or extended. Nothing here runs in CI.

    python3 -m venv .venv && . .venv/bin/activate
    pip install pillow pillow-heif piexif
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

import piexif
import pillow_heif
from PIL import ImageCms

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


def quadrants(width=300, height=200):
    """Displayed image for orientation tests: red, green / blue, yellow."""
    img = Image.new("RGB", (width, height))
    d = ImageDraw.Draw(img)
    w2, h2 = width // 2, height // 2
    d.rectangle([0, 0, w2 - 1, h2 - 1], fill=(220, 30, 30))
    d.rectangle([w2, 0, width - 1, h2 - 1], fill=(30, 200, 30))
    d.rectangle([0, h2, w2 - 1, height - 1], fill=(30, 30, 220))
    d.rectangle([w2, h2, width - 1, height - 1], fill=(230, 220, 30))
    return img


XMP_GPS = (
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
    ' exif:GPSLatitude="37,46.494N" exif:GPSLongitude="122,25.164W" xmp:Rating="4">'
    '<exif:GPSAltitude>12/1</exif:GPSAltitude>'
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def insert_segment(jpeg, marker, payload):
    """Inserts a JPEG marker segment right after SOI."""
    seg = bytes([0xFF, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload
    return jpeg[:2] + seg + jpeg[2:]


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


    # Every kind of metadata a JPEG can hide, for "Strip all metadata":
    # EXIF with GPS, XMP with GPS and a rating, a comment, IPTC (APP13) with
    # a city, an ICC profile (kept by strip), and bytes after end-of-image.
    buf = io.BytesIO()
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    scene(320, 240, seed=8).save(buf, format="JPEG", quality=85, exif=camera_exif().tobytes(),
                                 xmp=XMP_GPS.encode("utf-8"), comment=b"secret comment: 12 Home Street",
                                 icc_profile=srgb)
    iptc_city = b"\x1c\x02\x5a" + len(b"Paris").to_bytes(2, "big") + b"Paris"
    irb = b"8BIM" + (0x0404).to_bytes(2, "big") + b"\x00\x00" + len(iptc_city).to_bytes(4, "big") + iptc_city + b"\x00"
    data = insert_segment(buf.getvalue(), 0xED, b"Photoshop 3.0\x00" + irb) + b"TRAILING-SECRET-DATA"
    with open(os.path.join(HERE, "privacy-extras.jpg"), "wb") as f:
        f.write(data)
    print("wrote privacy-extras.jpg")

    # A location only in XMP: the editor cannot show it, so it warns.
    scene(200, 150, seed=9).save(os.path.join(HERE, "xmp-only-gps.jpg"), format="JPEG", quality=85,
                                 xmp=XMP_GPS.encode("utf-8"))
    print("wrote xmp-only-gps.jpg")

    # PNG with the location in both EXIF and XMP (uncompressed iTXt).
    from PIL import PngImagePlugin
    info = PngImagePlugin.PngInfo()
    info.add_itxt("XML:com.adobe.xmp", XMP_GPS, zip=False)
    save(scene(200, 150, seed=10), "png-xmp-gps.png", format="PNG", exif=camera_exif().tobytes(), pnginfo=info)

    # Orientation: pixels stored sideways and tagged "rotate 90 CW", so the
    # displayed image is quadrants() with red at the top left.
    upright = quadrants()
    stored = upright.transpose(Image.Transpose.ROTATE_90)  # 90 CCW
    e6 = camera_exif()
    e6[0x0112] = 6
    save(stored, "photo-orient6.jpg", format="JPEG", quality=92, exif=e6.tobytes())
    # HEIC stores the same rotation as a container transform (irot), which
    # decoders apply; its EXIF tag says 6 as well, like phone photos.
    save(stored, "photo-rotated.heic", format="HEIF", quality=90, exif=e6.tobytes())

    # AVIF, converted to JPEG for editing like HEIC: one with camera and GPS
    # EXIF, and the sideways quadrant image whose rotation is stored as the
    # container transform (irot), as AVIF encoders do.
    save(scene(640, 480, seed=13), "photo-exif.avif", format="AVIF", quality=70, exif=camera_exif().tobytes())
    save(stored, "photo-rotated.avif", format="AVIF", quality=80, exif=e6.tobytes())

    # Re-encoding to JPEG loses transparency and animation; the app says so.
    # Distinct frames: Pillow merges identical ones into a still image.
    frames = [quadrants(120, 80).rotate(180 * i).convert("RGBA") for i in range(3)]
    frames[0].save(os.path.join(HERE, "animated.png"), format="PNG", save_all=True,
                   append_images=frames[1:], duration=200, loop=0)
    print("wrote animated.png")
    see_through = Image.new("RGBA", (160, 120), (0, 0, 0, 0))
    ImageDraw.Draw(see_through).rectangle([0, 0, 79, 119], fill=(220, 30, 30, 255))
    save(see_through, "transparent.avif", format="AVIF", quality=90)

    # Non-ASCII EXIF text written as UTF-8, for the HEIC read path.
    utf8 = piexif.dump({"0th": {piexif.ImageIFD.ImageDescription: "Zoë Ω 日本 📷".encode("utf-8"),
                                piexif.ImageIFD.Make: b"Datum Test Cam"}})
    save(scene(200, 150, seed=11), "utf8-text.heic", format="HEIF", quality=85, exif=utf8)

    # EXIF thumbnail that shows a different picture from the main image,
    # like a photo edited without updating its thumbnail. Re-encoded output
    # must drop it: it would reveal the old framing.
    thumb = io.BytesIO()
    Image.new("RGB", (160, 120), (250, 0, 250)).save(thumb, format="JPEG", quality=80)
    with_thumb = piexif.dump({"0th": {piexif.ImageIFD.Make: b"Datum Test Cam"},
                              "1st": {piexif.ImageIFD.Compression: 6}, "thumbnail": thumb.getvalue()})
    save(scene(1200, 900, seed=12), "photo-thumbnail.jpg", format="JPEG", quality=92, exif=with_thumb)

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
