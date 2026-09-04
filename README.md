# Datum — photo metadata & GPS editor

A static, entirely client-side tool for viewing and editing the metadata
embedded in your photos — camera settings, timestamps, and especially GPS
location — then downloading the result. Nothing is ever uploaded anywhere;
every read and write happens in your browser.

## Running it

There's no build step. Either:

- Open `index.html` directly in a browser (double-click it), or
- Serve the folder with any static file server, e.g. `python3 -m http.server`
  in this directory, then visit `http://localhost:8000`.

Hosting it (GitHub Pages, Netlify, S3, etc.) works the same way — it's a
plain static site.

The only feature that needs an internet connection is the map tile imagery
in the Location tab (tiles come from OpenStreetMap). Everything else —
reading, editing, and writing metadata — works completely offline.

## What it does

| Format | Editing |
|---|---|
| JPEG | Full read/write. Only the EXIF segment is touched — pixel data is never re-encoded, so there's no quality loss. |
| PNG | Full read/write via the `eXIf` chunk (part of the PNG spec since 2017). Same no-recompression guarantee. |
| HEIC/HEIF | Read + preview natively. Editing requires converting to JPEG first (see below) — you'll see an explicit notice before this happens. |
| Anything else | Basic file info only (name, size, dimensions). Passed through unchanged on download. |

Editable fields: camera make/model/lens, aperture, shutter speed, ISO,
focal length, date taken, description, photographer, copyright,
orientation, and GPS latitude/longitude/altitude (via manual entry or an
interactive map).

**Merge, don't replace.** Editing only touches the specific fields you
change. Everything else your camera wrote — MakerNote, color profile,
lens calibration data, whatever — is preserved untouched. "Strip all
metadata" is a separate, explicit action for when you actually want
everything gone.

**Batch mode.** Upload multiple files, apply one GPS location to all of
them at once, strip metadata from the whole batch, or download everything
as a single `.zip`.

**Zip archives.** Drop in a `.zip` and it's unpacked automatically — every
image inside is added to the batch queue just as if you'd selected them
individually. Non-image entries, nested zips, and macOS resource-fork
cruft (`__MACOSX/`, `.DS_Store`) are skipped, with a summary of how many
items were skipped. Other archive formats (`.tar.gz`, etc.) aren't
supported — not a common way photos get shared, and would add real
dependency weight for little real-world benefit.

## Design notes and known limitations

**Why HEIC converts to JPEG instead of editing in place.** JPEG's EXIF
lives in one self-contained segment — swap it out, update one length
field, done. HEIC stores everything (image data, thumbnail, EXIF) as
separate "items" in a box structure with explicit byte offsets; changing
the EXIF item's size means recalculating every offset after it. There's no
mature library for this, so rather than write fragile from-scratch binary
surgery, HEIC files are decoded and re-encoded as JPEG for editing. This
does mean a small quality loss (HEVC→JPEG is lossy-to-lossy) and any
depth-map/HDR gain-map data is dropped — you're shown this before it
happens, not after.

**HEIC metadata reads through a custom parser, not exifr.** While building
this, I found that the bundled `exifr` library's HEIC/HEIF parser has a
real bug: it reads an item's `iloc` extent offset but never adds the
item's `base_offset` field to it. That's only correct when `base_offset`
happens to be zero. Files from `libheif` (and likely other real-world
encoders) commonly use a non-zero `base_offset` with a zero-relative
extent, which makes exifr land on the wrong bytes and throw. `js/heic-box-reader.js`
is a small standalone ISOBMFF box walker that reads the same structure
correctly; HEIC metadata is extracted through that plus `piexifjs`
instead of through exifr. (JPEG and PNG metadata still use exifr for
reading, which works correctly for those formats.)

**"Strip all metadata" limitations.** For JPEG this removes the entire
EXIF segment (`piexif.remove`). For PNG it removes the `eXIf` chunk plus
`tEXt`/`zTXt`/`iTXt`/`tIME` chunks. It does *not* currently remove other
embedded blocks some JPEGs carry, like XMP or Photoshop IRB segments —
these are rare in typical camera/phone photos but can exist in
Photoshop-edited files.

**Orientation is metadata-only.** Editing orientation changes the EXIF
tag, not the pixels — consistent with the no-recompression guarantee for
JPEG/PNG. Viewers that respect EXIF orientation (most modern ones) will
display the photo correctly; a few older/simpler viewers may not.

## Third-party libraries (all bundled locally in `vendor/`, no CDN)

- [exifr](https://github.com/MikeKovarik/exifr) — reading EXIF/GPS from JPEG and PNG
- [piexifjs](https://github.com/hMatoba/piexifjs) — writing EXIF into JPEG, and the TIFF codec reused for PNG/HEIC
- [libheif.js](https://github.com/catdad-experiments/libheif-js) — HEIC/HEIF decoding (WASM)
- [Leaflet](https://leafletjs.com/) — the GPS map
- [JSZip](https://stuk.github.io/jszip/) — batch `.zip` export

Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
