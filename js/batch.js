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

  // Compression always outputs JPEG regardless of source format, so the
  // name and MIME type follow the bytes actually produced. record.outputName
  // itself is never changed, so turning compression back off gives the
  // original name back.
  const EXTENSIONS_FOR_MIME = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] };
  const IMAGE_EXTENSION = /\.(jpe?g|png|heic|heif|avif|gif|webp|bmp|tiff?)$/i;

  // The download name always matches the data: a JPEG is never saved as
  // ".png" just because that's what was typed. A wrong image extension is
  // replaced; a missing one is added. `corrected` names the typed extension
  // that was replaced, so the person can be told.
  function resolveNameAndMime(record, result) {
    const typed = record.outputName || record.file.name;
    const mime = result.compressed ? "image/jpeg" : Datum.model.getOutputMime(record);
    const exts = EXTENSIONS_FOR_MIME[mime];
    if (!exts || exts.some((e) => typed.toLowerCase().endsWith(e))) return { name: typed, mime, corrected: null };
    const wrong = IMAGE_EXTENSION.exec(typed);
    const base = wrong ? typed.slice(0, wrong.index) : typed;
    return { name: (base || "photo") + exts[0], mime, corrected: wrong ? wrong[0] : null };
  }

  async function downloadSingle(record) {
    if (record.supportsEdit && record.compressEnabled) {
      Datum.ui.showToast("Compressing\u2026");
    }
    const result = await Datum.model.getOutputBytesAsync(record);
    if (result.failed) {
      const name = record.outputName || record.file.name;
      Datum.ui.showToast(result.invalid
        ? "Can't download " + name + " yet: " + Datum.errors.trimSentence(result.error) + "."
        : "Couldn't export " + name + ": " + Datum.errors.trimSentence(result.error) + ". Nothing was downloaded.");
      return result;
    }
    const { name, mime, corrected } = resolveNameAndMime(record, result);
    const blob = new Blob([result.bytes], { type: mime });
    triggerDownload(blob, name);
    if (corrected) {
      Datum.ui.showToast("Saved as " + name + ": the file is a " + (mime === "image/png" ? "PNG" : "JPEG") + ", so the " + corrected + " ending was corrected.");
    }

    if (result.error) {
      Datum.ui.showToast("Couldn't compress " + name + " (" + Datum.errors.trimSentence(result.error) + "), so it was downloaded at its original quality.");
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
    const failedNames = [];

    for (const record of records) {
      const result = await Datum.model.getOutputBytesAsync(record);
      if (result.failed) {
        // Leave out only the file that failed; the rest of the archive is fine.
        failedNames.push((record.outputName || record.file.name) + " (" + Datum.errors.trimSentence(result.error) + ")");
        continue;
      }
      const { name } = resolveNameAndMime(record, result);
      const finalName = uniqueName(name, used);
      zip.file(finalName, result.bytes);
      if (result.compressed) compressedCount++;
      if (result.compressed && result.reachedTarget === false) missedTargetCount++;
    }

    if (failedNames.length === records.length) {
      Datum.ui.showToast("Nothing could be exported, so no zip was downloaded.");
      return;
    }

    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, zipName || "datum-export.zip");

    const parts = [];
    if (compressedCount > 0) {
      let msg = "Compressed " + compressedCount + (compressedCount === 1 ? " file" : " files") + " in this export.";
      if (missedTargetCount > 0) msg += " " + missedTargetCount + " couldn't fully reach target size.";
      parts.push(msg);
    }
    if (failedNames.length > 0) {
      parts.push("Left out " + failedNames.length + (failedNames.length === 1 ? " file" : " files") +
        " that couldn't be exported: " + failedNames.join(", ") + ".");
    }
    if (parts.length > 0) Datum.ui.showToast(parts.join(" "));
  }

  Datum.batch = { downloadSingle, downloadAllAsZip, triggerDownload, resolveNameAndMime };
})(window.Datum = window.Datum || {});
