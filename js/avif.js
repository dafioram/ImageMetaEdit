/* AVIF decoding through the browser's own decoder (current Chrome, Edge,
   Firefox and Safari all ship one), so no WASM library is needed. Produces
   a canvas of the displayed image, which is then converted to JPEG for
   editing, like HEIC. Browsers can't encode AVIF (canvas.toBlob("image/avif")
   quietly returns a PNG), so edited AVIF files are saved as JPEG.

   AVIF stores rotation and mirroring as container properties (irot, imir).
   Chrome and Firefox apply them when decoding; some decoders (WebKit on
   Linux) don't. Which one this browser does is measured once with a tiny
   rotated file, and the transforms are applied here when the decoder
   didn't, so the converted image is upright either way. */
(function (Datum) {
  "use strict";

  // 4x2 pixels stored, with irot = 90 degrees anticlockwise: it displays as
  // 2x4. Made with Pillow (an RGB image saved as AVIF with EXIF orientation
  // 8, which Pillow writes as irot).
  const ROTATED_PROBE =
    "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAEdAAAAJwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAAB0aXBycAAAAFRpcGNvAAAAFGlzcGUAAAAAAAAABAAAAAIAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAAAlpcm90AQAAABhpcG1hAAAAAAAAAAEAAQUBAoMEhQAAAC9tZGF0EgAKCBgEO0QENBoQMhkZR4eGIYeeeeaAAACQQMkcYUoJwY4EzRGM";

  let appliesPromise = null;
  function browserAppliesContainerTransforms() {
    if (!appliesPromise) {
      appliesPromise = (async () => {
        try {
          const bytes = Datum.bin.binaryStringToUint8(atob(ROTATED_PROBE));
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/avif" }));
          const applied = bitmap.width === 2 && bitmap.height === 4;
          bitmap.close();
          return applied;
        } catch (e) {
          return true; // no decoder at all: nothing to correct
        }
      })();
    }
    return appliesPromise;
  }

  async function decodeToCanvas(bytes) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], { type: "image/avif" }));
    } catch (e) {
      const err = new Error("This browser can't decode AVIF images");
      err.userFacing = true;
      err.unsupported = true;
      throw err;
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    // Converted to JPEG, which has no transparency: white, not black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (await Datum.avif.browserAppliesContainerTransforms()) return canvas;
    const transforms = Datum.heicBoxReader.readPrimaryTransforms(bytes);
    return transforms ? Datum.orientation.applyToCanvas(canvas, transforms.orientation) : canvas;
  }

  Datum.avif = { decodeToCanvas, browserAppliesContainerTransforms };
})(window.Datum = window.Datum || {});
