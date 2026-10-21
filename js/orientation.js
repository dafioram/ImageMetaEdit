/* EXIF orientation for any path that re-encodes pixels (compression, HEIC
   conversion, crop). The rule: re-encoded pixels are stored upright, exactly
   as the image should be displayed, and the written Orientation tag is 1.
   Keeping the source's tag on already-upright pixels would rotate the image
   a second time in every viewer.

   Orientation values are the 8 EXIF ones. Each is a transform from stored
   pixels to the displayed image; they are composed as 2x2 matrices acting
   on (x, y) with y pointing down. */
(function (Datum) {
  "use strict";

  // Matrix [a, b, c, d] maps (x, y) to (a*x + b*y, c*x + d*y).
  const MATRICES = {
    1: [1, 0, 0, 1],    // normal
    2: [-1, 0, 0, 1],   // mirror horizontal
    3: [-1, 0, 0, -1],  // rotate 180
    4: [1, 0, 0, -1],   // mirror vertical
    5: [0, 1, 1, 0],    // transpose
    6: [0, -1, 1, 0],   // rotate 90 CW
    7: [0, -1, -1, 0],  // transverse
    8: [0, 1, -1, 0],   // rotate 90 CCW
  };

  function normalize(o) {
    const n = Math.round(Number(o));
    return MATRICES[n] ? n : 1;
  }

  function multiply(m, n) {
    // m * n: apply n first, then m.
    return [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3]];
  }

  function fromMatrix(m) {
    for (const o of Object.keys(MATRICES)) {
      const k = MATRICES[o];
      if (k[0] === m[0] && k[1] === m[1] && k[2] === m[2] && k[3] === m[3]) return Number(o);
    }
    return 1;
  }

  // The orientation equivalent to applying `first`, then `second`.
  function compose(first, second) {
    return fromMatrix(multiply(MATRICES[normalize(second)], MATRICES[normalize(first)]));
  }

  function inverse(o) {
    const m = MATRICES[normalize(o)];
    // Every one of these matrices is orthogonal, so its inverse is its transpose.
    return fromMatrix([m[0], m[2], m[1], m[3]]);
  }

  function swapsAxes(o) {
    return normalize(o) >= 5;
  }

  // Returns a new canvas holding `source` with orientation `o` applied, i.e.
  // what a viewer would display for pixels `source` tagged with `o`.
  function applyToCanvas(source, o) {
    o = normalize(o);
    const w = source.width, h = source.height;
    if (o === 1) return source;
    const out = document.createElement("canvas");
    out.width = swapsAxes(o) ? h : w;
    out.height = swapsAxes(o) ? w : h;
    const ctx = out.getContext("2d");
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    }
    ctx.drawImage(source, 0, 0);
    return out;
  }

  // Whether this browser applies a file's EXIF orientation when decoding it
  // as an image, per format. Every current browser does for JPEG; PNG eXIf
  // and WebP support varies. Measured once with a 2x1 image tagged
  // "rotate 90".
  // 2x1 lossless WebP with EXIF orientation 6, made with Pillow. Browsers
  // can't all encode WebP, so it can't be made on the fly like the others.
  const WEBP_PROBE = "UklGRk4AAABXRUJQVlA4WAoAAAAIAAAAAQAAAAAAVlA4TA4AAAAvAQAAAAcQEf0PRET/A0VYSUYaAAAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAA=";
  const appliesCache = {};
  function browserAppliesOrientation(kind) {
    if (kind !== "jpeg" && kind !== "png" && kind !== "webp") return Promise.resolve(false);
    if (!appliesCache[kind]) {
      appliesCache[kind] = (async () => {
        try {
          if (kind === "webp") {
            const bytes = Datum.bin.binaryStringToUint8(atob(WEBP_PROBE));
            const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
            const applied = bmp.width === 1;
            bmp.close();
            return applied;
          }
          const c = document.createElement("canvas");
          c.width = 2; c.height = 1;
          c.getContext("2d").fillRect(0, 0, 2, 1);
          const mime = kind === "jpeg" ? "image/jpeg" : "image/png";
          const blob = await new Promise((res) => c.toBlob(res, mime));
          let bytes = new Uint8Array(await blob.arrayBuffer());
          const exif = window.piexif.dump({ "0th": { [window.piexif.ImageIFD.Orientation]: 6 } });
          if (kind === "jpeg") {
            bytes = Datum.bin.binaryStringToUint8(window.piexif.insert(exif, Datum.bin.uint8ToBinaryString(bytes)));
          } else {
            bytes = Datum.pngCodec.writeExifChunk(bytes, Datum.bin.binaryStringToUint8(exif.slice(6)), false);
          }
          const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
          const applied = bmp.width === 1;
          bmp.close();
          return applied;
        } catch (e) {
          return kind === "jpeg";
        }
      })();
    }
    return appliesCache[kind];
  }

  // The transform still needed to turn browser-decoded pixels into the
  // image the user wants displayed. `sourceTag` is the tag in the bytes that
  // were decoded; `wanted` is the orientation field the user has (or kept).
  async function remainingTransform(kind, sourceTag, wanted) {
    const applied = (await browserAppliesOrientation(kind)) ? normalize(sourceTag) : 1;
    return compose(inverse(applied), normalize(wanted));
  }

  // Fields to write alongside upright, re-encoded pixels.
  function fieldsForUprightPixels(fields) {
    return Object.assign({}, fields, { orientation: 1 });
  }

  Datum.orientation = {
    normalize, compose, inverse, swapsAxes, applyToCanvas,
    browserAppliesOrientation, remainingTransform, fieldsForUprightPixels,
  };
})(window.Datum = window.Datum || {});
