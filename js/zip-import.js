/* Lets a .zip full of photos be dropped/selected just like individual
   files. Each image entry inside becomes a normal File object and flows
   through the exact same pipeline as anything else -- no changes needed
   anywhere else in the app. Non-image entries (docs, folders, OS cruft)
   are skipped and counted; a nested .zip is skipped rather than recursed
   into. */
(function (Datum) {
  "use strict";

  const IMAGE_EXTENSIONS = /\.(jpe?g|png|heic|heif|gif|bmp|webp|tiff?|avif)$/i;
  const EXT_MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    heic: "image/heic", heif: "image/heif", gif: "image/gif",
    bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff",
    avif: "image/avif",
  };

  function isZipFile(name) { return /\.zip$/i.test(name || ""); }

  // macOS zip cruft: __MACOSX/ resource-fork copies and .DS_Store -- pure
  // noise, silently ignored rather than counted as "skipped".
  function isJunkPath(path) {
    return path.indexOf("__MACOSX/") === 0 || /(^|\/)\.DS_Store$/.test(path) || /(^|\/)\._/.test(path);
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  async function expandZip(zipFile) {
    let zip;
    try {
      zip = await JSZip.loadAsync(zipFile);
    } catch (e) {
      return { files: [], skipped: 0, error: "Could not open " + zipFile.name + " as a zip." };
    }
    const files = [];
    let skipped = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || isJunkPath(entry.name)) continue;
      const baseName = entry.name.split("/").pop();
      if (!baseName) continue;
      if (isZipFile(baseName) || !IMAGE_EXTENSIONS.test(baseName)) { skipped++; continue; }
      try {
        const blob = await entry.async("blob");
        const mime = EXT_MIME[extOf(baseName)] || "";
        files.push(new File([blob], baseName, { type: mime }));
      } catch (e) {
        skipped++;
      }
    }
    return { files, skipped };
  }

  // Given the raw list from a drop or file picker, expands any .zip
  // entries into the images inside them; everything else passes through
  // untouched. Returns the flattened file list plus counts for the toast.
  async function expandFiles(rawFiles) {
    const out = [];
    let skipped = 0;
    let zipsProcessed = 0;
    const zipErrors = [];
    for (const file of rawFiles) {
      if (isZipFile(file.name)) {
        zipsProcessed++;
        const result = await expandZip(file);
        if (result.error) zipErrors.push(result.error);
        out.push(...result.files);
        skipped += result.skipped;
      } else {
        out.push(file);
      }
    }
    return { files: out, skipped, zipsProcessed, zipErrors };
  }

  Datum.zipImport = { expandFiles };
})(window.Datum = window.Datum || {});
