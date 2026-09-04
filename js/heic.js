/* HEIC/HEIF decoding using the bundled libheif WASM build. Produces a
   <canvas> of the decoded pixels, which is then re-encoded as JPEG so it
   can go through the same EXIF-writing path as any other JPEG. We do not
   attempt to write metadata back into the HEIC container itself -- see
   the design notes in README.md for why. */
(function (Datum) {
  "use strict";

  let libheifPromise = null;

  function getLibheif() {
    if (!libheifPromise) {
      libheifPromise = Promise.resolve().then(async () => {
        let mod = window.libheif;
        if (typeof mod === "function") mod = await mod();
        if (!mod || !mod.HeifDecoder) throw new Error("HEIC decoder failed to load.");
        return mod;
      });
    }
    return libheifPromise;
  }

  async function decodeToCanvas(uint8Array) {
    const libheif = await getLibheif();
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(uint8Array);
    if (!images || images.length === 0) throw new Error("No image found in this HEIC file.");
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    if (!width || !height) throw new Error("Could not read this HEIC file's dimensions.");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    await new Promise((resolve, reject) => {
      image.display(imageData, (displayData) => {
        if (!displayData) { reject(new Error("Could not decode this HEIC image.")); return; }
        resolve();
      });
    });
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  function canvasToJpegBytes(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("Could not encode JPEG from decoded HEIC image.")); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, "image/jpeg", quality || 0.92);
    });
  }

  Datum.heic = { decodeToCanvas, canvasToJpegBytes };
})(window.Datum = window.Datum || {});
