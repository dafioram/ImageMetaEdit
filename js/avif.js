/* AVIF decoding through the browser's own decoder (current Chrome, Edge,
   Firefox and Safari all ship one), so no WASM library is needed. Produces
   a canvas of the displayed image -- the browser applies the container's
   rotation -- which is then converted to JPEG for editing, like HEIC.
   Browsers can't encode AVIF (canvas.toBlob("image/avif") quietly returns
   a PNG), so edited AVIF files are saved as JPEG. */
(function (Datum) {
  "use strict";

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
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  Datum.avif = { decodeToCanvas };
})(window.Datum = window.Datum || {});
