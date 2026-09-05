/* Turning FileRecords into downloadable files: a single blob-and-click for
   one file, or a JSZip archive for the whole queue. Both go through the
   compression-aware async pipeline in metadata-model.js, which only
   actually recompresses a file when that's turned on for it and it's
   over its target size. */
(function (Datum) {
  "use strict";

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function withJpegExtension(name) {
    if (/\.jpe?g$/i.test(name)) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > -1 ? name.slice(0, dot) : name;
    return base + ".jpg";
  }

  // Compression always outputs JPEG regardless of source format, so the
  // filename/MIME need to reflect that only when it actually happened --
  // never mutates record.outputName itself, so turning compression back
  // off gives you your original name back.
  function resolveNameAndMime(record, result) {
    let name = record.outputName || record.file.name;
    let mime = Datum.model.getOutputMime(record);
    if (result.compressed) {
      name = withJpegExtension(name);
      mime = "image/jpeg";
    }
    return { name, mime };
  }

  async function downloadSingle(record) {
    if (record.supportsEdit && record.compressEnabled) {
      Datum.ui.showToast("Compressing\u2026");
    }
    const result = await Datum.model.getOutputBytesAsync(record);
    const { name, mime } = resolveNameAndMime(record, result);
    const blob = new Blob([result.bytes], { type: mime });
    triggerDownload(blob, name);

    if (result.error) {
      Datum.ui.showToast("Couldn't compress " + name + " -- downloaded at original quality instead.");
    } else if (result.compressed && result.reachedTarget === false) {
      Datum.ui.showToast("Couldn't reach your target size even at low quality \u2014 saved as small as it would go. Try a smaller max dimension.");
    }
    return result;
  }

  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const base = dot > -1 ? name.slice(0, dot) : name;
    const ext = dot > -1 ? name.slice(dot) : "";
    let counter = 2;
    let candidate = `${base} (${counter})${ext}`;
    while (used.has(candidate)) { counter++; candidate = `${base} (${counter})${ext}`; }
    used.add(candidate);
    return candidate;
  }

  async function downloadAllAsZip(records, zipName) {
    const zip = new JSZip();
    const used = new Set();
    let compressedCount = 0;
    let missedTargetCount = 0;

    for (const record of records) {
      const result = await Datum.model.getOutputBytesAsync(record);
      const { name } = resolveNameAndMime(record, result);
      const finalName = uniqueName(name, used);
      zip.file(finalName, result.bytes);
      if (result.compressed) compressedCount++;
      if (result.compressed && result.reachedTarget === false) missedTargetCount++;
    }

    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, zipName || "datum-export.zip");

    if (compressedCount > 0) {
      let msg = "Compressed " + compressedCount + (compressedCount === 1 ? " file" : " files") + " in this export.";
      if (missedTargetCount > 0) msg += " " + missedTargetCount + " couldn't fully reach target size.";
      Datum.ui.showToast(msg);
    }
  }

  Datum.batch = { downloadSingle, downloadAllAsZip, triggerDownload };
})(window.Datum = window.Datum || {});
