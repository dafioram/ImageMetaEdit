/* Turning FileRecords into downloadable files: a single blob-and-click for
   one file, or a JSZip archive for the whole queue. */
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

  function downloadSingle(record) {
    const bytes = Datum.model.getOutputBytes(record);
    const mime = Datum.model.getOutputMime(record);
    const blob = new Blob([bytes], { type: mime });
    triggerDownload(blob, record.outputName || record.file.name);
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
    for (const record of records) {
      const name = uniqueName(record.outputName || record.file.name, used);
      const bytes = Datum.model.getOutputBytes(record);
      zip.file(name, bytes);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    triggerDownload(blob, zipName || "datum-export.zip");
  }

  Datum.batch = { downloadSingle, downloadAllAsZip, triggerDownload };
})(window.Datum = window.Datum || {});
