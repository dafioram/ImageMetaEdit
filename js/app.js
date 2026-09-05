/* Top-level app state: the list of FileRecords and which one is active.
   Everything here is thin glue between metadata-model.js (data) and
   ui.js (DOM); no rendering logic lives in this file. */
(function (Datum) {
  "use strict";

  const state = {
    records: [],
    activeId: null,
  };

  function getState() { return state; }
  function getActive() { return state.records.find((r) => r.id === state.activeId) || null; }

  async function addFiles(fileList) {
    const rawFiles = Array.from(fileList);
    const hasZip = rawFiles.some((f) => /\.zip$/i.test(f.name || ""));
    if (hasZip) Datum.ui.showToast("Reading zip file\u2026");

    const { files, skipped, zipsProcessed, zipErrors } = await Datum.zipImport.expandFiles(rawFiles);

    let successCount = 0;
    for (const file of files) {
      try {
        const record = await Datum.model.createFileRecord(file);
        state.records.push(record);
        if (!state.activeId) state.activeId = record.id;
        successCount++;
      } catch (e) {
        Datum.ui.showToast("Could not add " + file.name);
      }
    }
    Datum.ui.render(state);

    if (zipErrors.length > 0) {
      Datum.ui.showToast(zipErrors[0]);
    } else if (successCount > 0) {
      let msg = successCount === 1 ? "Added 1 file" : "Added " + successCount + " files";
      if (skipped > 0) msg += " \u2014 " + skipped + (skipped === 1 ? " item skipped" : " items skipped");
      Datum.ui.showToast(msg);
    } else if (zipsProcessed > 0) {
      Datum.ui.showToast("No images found in that zip file.");
    }
  }

  function removeFile(id) {
    const idx = state.records.findIndex((r) => r.id === id);
    if (idx === -1) return;
    const [removed] = state.records.splice(idx, 1);
    if (removed.previewUrl && removed.previewUrl.indexOf("blob:") === 0) {
      URL.revokeObjectURL(removed.previewUrl);
    }
    if (state.activeId === id) {
      state.activeId = state.records.length ? state.records[0].id : null;
    }
    Datum.ui.render(state);
  }

  function selectFile(id) {
    state.activeId = id;
    Datum.ui.render(state);
  }

  function applyGpsToAll() {
    const active = getActive();
    if (!active || active.fields.latitude === "" || active.fields.longitude === "" || active.fields.latitude === undefined) {
      Datum.ui.showToast("Set a location on the current file first.");
      return;
    }
    let count = 0;
    for (const r of state.records) {
      if (r.id === active.id || !r.supportsEdit) continue;
      r.fields.latitude = active.fields.latitude;
      r.fields.longitude = active.fields.longitude;
      r.fields.altitude = active.fields.altitude;
      r.stripRequested = false;
      count++;
    }
    Datum.ui.render(state);
    Datum.ui.showToast(count > 0 ? "Location applied to " + count + " other file" + (count === 1 ? "" : "s") : "No other editable files to apply to.");
  }

  function applyCompressionToAll() {
    const active = getActive();
    if (!active) return;
    let count = 0;
    for (const r of state.records) {
      if (r.id === active.id || !r.supportsEdit || Datum.model.getPixelSourceBytes(r) === null) continue;
      r.compressEnabled = active.compressEnabled;
      r.compressTargetMB = active.compressTargetMB;
      r.compressMaxDimension = active.compressMaxDimension;
      count++;
    }
    Datum.ui.render(state);
    Datum.ui.showToast(count > 0 ? "Compression settings applied to " + count + " other file" + (count === 1 ? "" : "s") : "No other compressible files to apply to.");
  }

  function stripAllFiles() {
    let count = 0;
    for (const r of state.records) {
      if (!r.supportsEdit) continue;
      Datum.model.stripAll(r);
      count++;
    }
    Datum.ui.render(state);
    Datum.ui.showToast("Cleared metadata on " + count + " file" + (count === 1 ? "" : "s") + ".");
  }

  async function downloadAllZip() {
    Datum.ui.showToast("Building zip\u2026");
    try {
      await Datum.batch.downloadAllAsZip(state.records, "datum-export.zip");
    } catch (e) {
      Datum.ui.showToast("Could not build zip: " + (e && e.message ? e.message : String(e)));
    }
  }

  Datum.app = {
    getState, getActive, addFiles, removeFile, selectFile,
    applyGpsToAll, applyCompressionToAll, stripAllFiles, downloadAllZip,
  };

  document.addEventListener("DOMContentLoaded", () => {
    Datum.ui.render(state);
  });
})(window.Datum = window.Datum || {});
