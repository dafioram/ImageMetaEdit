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

## Running the tests

The suite runs the real app in a headless browser (Playwright). It needs
Node 22 or newer.

    npm ci
    npx playwright install chromium    # once, or point CHROMIUM_PATH at an install
    npm test

- `npm run test:static` checks syntax, that every referenced file exists,
  that no unexpected external URLs appear, that the sample files match their
  extensions, and that the test tooling is pinned. No browser needed.
- `npm run test:browser` drives the app the way a person would. It covers
  every input format, checks that each export is still a decodable image of
  the same size, checks metadata reads and writes, compression, zip import
  and export, the UI controls, and audits every network request.
- `BROWSER=firefox` or `BROWSER=webkit` runs the browser tests in another
  engine (after `npx playwright install firefox` or `webkit`).

Sample files live in `tests/fixtures/`. `tests/fixtures/generate.py` rebuilds
them (it needs Pillow and pillow-heif). Tests marked TODO are known gaps: a
truncated or zero-byte file is not flagged, and a PNG saved with a `.jpg`
name cannot be downloaded. They run and report without failing the build
until they are fixed.

## What it does

| Format | Editing |
|---|---|
| JPEG | Full read/write. Only the EXIF segment is touched — pixel data is never re-encoded, so there's no quality loss. |
| PNG | Full read/write via the `eXIf` chunk (part of the PNG spec since 2017). Same no-recompression guarantee. |
| HEIC/HEIF | Read + preview natively. Editing requires converting to JPEG first (see below) — you'll see an explicit notice before this happens. |
| AVIF | Read + preview through the browser's own decoder, converted to JPEG for editing like HEIC. Browsers can't write AVIF, so edited files are saved as `.jpg`; without an AVIF decoder (some older browsers) the file is kept as is. |
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

**Checks as you type, and on load.** Values a file can't store (a negative
ISO, latitude 95, a description too long for the metadata block) are
marked next to the field with the reason, and that file can't be
downloaded until they're fixed; the rest of a batch still exports. Files
are checked when added: an empty file, or one whose contents aren't an
image, is flagged straight away, and a damaged JPEG or PNG still loads
with a warning that says what's wrong (for example, where a cut-off JPEG
ends). Turning on "Reduce file size" saves a cut-off JPEG as a complete
re-encoded copy.

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

**Reduce file size.** An opt-in control (per file, with a "apply to all"
bulk button for batches) that recompresses to a target size in MB or KB
(pick the unit from the dropdown; switching units keeps the same size
limit), with an optional max-dimension cap. It binary-searches JPEG quality to find
the highest quality that still fits your target — typically 5-8 encode
passes, all client-side. Files already under the target are left
completely untouched, not needlessly re-encoded. The output is always
JPEG regardless of source format (PNG/HEIC included), since that's the
only format here with a reliable native browser encode path — see
"Design notes" below for why WebP/AVIF aren't included. Compressing still
carries your metadata: it loads the original file's full EXIF, merges
your edits on top exactly like a normal export, and inserts that into the
newly-compressed pixel data.

**Fullscreen viewer.** Click the main preview image to open a gallery
view — left/right arrows or arrow keys move between every file in the
queue, wrapping at the ends. It's a plain overlay outside the normal
document flow, so it never touches the thumbnail/queue layout. Navigating
just swaps the displayed image; the "active" file for editing only syncs
once, when you close the viewer, so browsing quickly through a batch
doesn't repeatedly rebuild the editor panel.

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

**Converted formats keep one generation of loss.** HEIC and AVIF are
decoded once to show and convert them. When "Reduce file size" is on, the
compressed file is encoded from a fresh decode of the original, not from
the converted JPEG, so the image is lossy-encoded once rather than twice.

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

**What "Strip all metadata" removes.** For JPEG it keeps only what is
needed to display the image exactly as before — the JFIF header, the ICC
color profile and Adobe's color-transform flag — and removes everything
else: EXIF, XMP (where Lightroom, Photoshop and Google Photos store their
own copy of the location), IPTC/Photoshop blocks, comments, other
vendor segments, and any data after the end of the image (such as HDR
gain maps or depth images appended by some phones). For PNG it removes the
`eXIf` chunk plus `tEXt`/`zTXt`/`iTXt`/`tIME` chunks. The one tag it keeps is
the orientation: without it, a photo whose pixels are stored sideways (most
phone photos) would display sideways. It holds no personal information.

**XMP location stays in step with EXIF.** The editor shows the EXIF
location. When you change or clear it, any copy of the location in XMP is
removed too, so it can't contradict the new position or leak the old one;
the rest of the XMP is kept. If a file has a location only in XMP, the
editor says so.

**Orientation.** Editing orientation changes the EXIF tag, not the pixels —
consistent with the no-recompression guarantee for JPEG/PNG. Paths that
re-encode pixels (compression, HEIC conversion) store them upright, already
turned the way they should display, and write orientation "Normal", so the
photo isn't rotated twice. HEIC conversion follows the HEIF rule that the
container's own rotation applies and the EXIF tag does not.

**Text in any language.** Text fields are stored as UTF-8, which current
readers (phones, macOS, Windows, exiftool) display correctly.

**Why compression always outputs JPEG, not WebP/AVIF.** PNG is lossless
and a poor fit for photographic content size-wise; WebP and AVIF compress
better than JPEG per byte, but JPEG is the one format with a reliable,
dependency-free encode path via the browser's native `canvas.toBlob()`.
WebP encoding via that same API works in Chrome/Firefox/Edge but has
historically lagged in Safari; AVIF has no reliable native browser encode
path at all and would need a much heavier WASM encoder. Given this tool's
core job is metadata precision rather than image optimization, JPEG's
universal support won out over marginally better compression ratios.

**Compression and full metadata preservation.** Recompressing decodes to
a `<canvas>`, which only holds pixels — so the pipeline separately loads
the *original* file's complete EXIF (not just the curated fields), merges
your edits on top exactly like a normal export, and inserts that into the
newly-encoded bytes. Nothing beyond the curated fields is lost, unlike a
naive "just recompress the pixels" approach would.

## Third-party libraries (all bundled locally in `vendor/`, no CDN)

- [exifr](https://github.com/MikeKovarik/exifr) — reading EXIF/GPS from JPEG and PNG
- [piexifjs](https://github.com/hMatoba/piexifjs) — writing EXIF into JPEG, and the TIFF codec reused for PNG/HEIC
- [libheif.js](https://github.com/catdad-experiments/libheif-js) — HEIC/HEIF decoding (WASM)
- [Leaflet](https://leafletjs.com/) — the GPS map
- [JSZip](https://stuk.github.io/jszip/) — batch `.zip` export

Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
