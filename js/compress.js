/* Re-encoding pixels for the "reduce file size" feature. This only ever
   touches pixel data (via <canvas>) -- metadata is stitched back on
   afterward by metadata-model.js's compression pipeline, which loads the
   *original* file's full EXIF, merges the user's edits on top exactly
   like a normal export, and inserts that into these newly-compressed
   bytes. Nothing here knows or cares about EXIF. */
(function (Datum) {
  "use strict";

  function loadImageFromBytes(bytes) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes]);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode image for compression.")); };
      img.dataset._objectUrl = url;
      img.src = url;
    });
  }

  // maxDimension: longest side, in pixels; null/0/NaN means no resize.
  // crop: optional { x, y, width, height } region of the source to keep.
  // keepAlpha: leave transparency alone (for PNG output).
  function drawToCanvas(img, maxDimension, crop, keepAlpha) {
    // An <img> reports naturalWidth; a canvas or ImageBitmap reports width.
    const fullW = img.naturalWidth || img.width, fullH = img.naturalHeight || img.height;
    const src = crop || { x: 0, y: 0, width: fullW, height: fullH };
    let w = src.width, h = src.height;
    if (maxDimension && isFinite(maxDimension) && maxDimension >= 50 && Math.max(w, h) > maxDimension) {
      const scale = maxDimension / Math.max(w, h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // JPEG has no transparency: paint white first, or transparent areas
    // would encode as black.
    if (!keepAlpha) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, w, h);
    if (typeof img.src === "string" && img.src.indexOf("blob:") === 0) URL.revokeObjectURL(img.src);
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("Could not encode the image.")); return; }
        resolve(blob);
      }, mime, quality);
    });
  }

  function canvasToJpegBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("JPEG encoding failed.")); return; }
        resolve(blob);
      }, "image/jpeg", quality);
    });
  }

  // Binary-searches JPEG quality for the highest value whose encoded size
  // is still <= targetBytes. Returns { blob, quality, reachedTarget }.
  // If even the quality floor doesn't fit, returns the smallest blob found
  // with reachedTarget:false rather than failing outright.
  async function compressToTargetSize(canvas, targetBytes, opts) {
    opts = opts || {};
    const minQ = opts.minQuality !== undefined ? opts.minQuality : 0.1;
    const maxQ = opts.maxQuality !== undefined ? opts.maxQuality : 0.95;
    const maxIterations = opts.maxIterations || 7;

    let lo = minQ, hi = maxQ;
    let best = null;
    let smallest = null;

    for (let i = 0; i < maxIterations; i++) {
      const mid = (lo + hi) / 2;
      const blob = await canvasToJpegBlob(canvas, mid);
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, quality: mid };
      if (blob.size <= targetBytes) {
        best = { blob, quality: mid };
        lo = mid;
      } else {
        hi = mid;
      }
    }

    if (best) return { blob: best.blob, quality: best.quality, reachedTarget: true };
    return { blob: smallest.blob, quality: smallest.quality, reachedTarget: false };
  }

  Datum.compress = { loadImageFromBytes, drawToCanvas, canvasToBlob, canvasToJpegBlob, compressToTargetSize };
})(window.Datum = window.Datum || {});
