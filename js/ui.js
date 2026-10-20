/* All DOM building lives here. Full re-renders happen only on file
   add/remove/select or a bulk action; individual keystrokes in a field
   update the model directly and patch just the affected DOM bits (changed
   dots, diff counter, queue status) so focus/cursor position is never
   lost. File-derived text (filenames, EXIF string values) is always set
   via .textContent or the .value property -- never innerHTML -- since
   EXIF fields can contain attacker-controlled strings. */
(function (Datum) {
  "use strict";

  // The editor tab stays open across re-renders (batch actions, switching
  // files), so applying a location to all files doesn't bounce the person
  // back to "Common fields".
  let activeTab = "common";

  // Toasts stack, newest last, so one message never replaces another before
  // it can be read. A "working" message (ending in an ellipsis) is replaced
  // by whatever comes next. At most four are shown at once.
  function showToast(message) {
    let stack = document.getElementById("toast");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "toast";
      stack.className = "toast-stack";
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    const last = stack.lastElementChild;
    if (last && last.dataset.working === "true") last.remove();
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    if (/\u2026$/.test(message)) item.dataset.working = "true";
    stack.appendChild(item);
    while (stack.children.length > 4) stack.firstElementChild.remove();
    requestAnimationFrame(() => item.classList.add("show"));
    setTimeout(() => {
      item.classList.remove("show");
      setTimeout(() => item.remove(), 200);
    }, message.length > 90 ? 7000 : 4000);
  }

  function makeButton(text, className, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  function factSpan(label, value) {
    const span = document.createElement("span");
    span.appendChild(document.createTextNode(label + ": "));
    const b = document.createElement("b");
    b.textContent = value;
    span.appendChild(b);
    return span;
  }

  function formatBytes(n) {
    if (n === null || n === undefined) return "\u2014";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
  }

  function statusTextFor(record) {
    if (record.error) return "Couldn't read file";
    if (!record.supportsEdit) return "View only";
    const n = Datum.model.changeCount(record);
    const changes = n > 0 ? (n + (n === 1 ? " change" : " changes")) : "No changes";
    return record.warning ? "Damaged \u00B7 " + changes : changes;
  }

  function formatRawValue(v) {
    if (v === null || v === undefined) return "\u2014";
    if (v instanceof Date) return isNaN(v.getTime()) ? "\u2014" : v.toLocaleString();
    if (ArrayBuffer.isView(v)) return "[binary data, " + v.length + " bytes]";
    if (Array.isArray(v)) return v.map(formatRawValue).join(", ");
    if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return "[object]"; } }
    let s = String(v);
    if (s.length > 300) s = s.slice(0, 300) + "\u2026";
    return s;
  }

  // ---------- Dropzone (empty state) ----------

  function dropzoneMarkup() {
    return (
      '<div class="dropzone" id="dropzone">' +
      '<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>' +
      "<h2>Drop a photo here</h2>" +
      "<p>See its metadata, edit GPS and camera details, then download \u2014 nothing leaves your browser.</p>" +
      '<label class="btn btn-primary" for="file-input">Choose files</label>' +
      '<input type="file" id="file-input" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif,image/avif,.avif,image/gif,image/webp,image/bmp,image/tiff,.tif,.tiff,.zip,application/zip" multiple />' +
      '<div class="formats-line">JPEG &amp; PNG: full editing &middot; HEIC &amp; AVIF: preview + convert to edit &middot; GIF, WebP, BMP, TIFF: view only &middot; .zip: unpacked automatically</div>' +
      "</div>"
    );
  }

  function wireDropzone() {
    const dz = document.getElementById("dropzone");
    const input = document.getElementById("file-input");
    input.addEventListener("change", () => { if (input.files.length) Datum.app.addFiles(input.files); });
    ["dragenter", "dragover"].forEach((evt) => dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add("drag-over"); }));
    ["dragleave", "drop"].forEach((evt) => dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove("drag-over"); }));
    dz.addEventListener("drop", (e) => {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) Datum.app.addFiles(e.dataTransfer.files);
    });
  }

  // ---------- Queue rail ----------

  function buildQueueItem(record, state) {
    const li = document.createElement("li");
    const item = document.createElement("div");
    item.className = "queue-item" + (record.id === state.activeId ? " active" : "");
    item.setAttribute("data-id", record.id);
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");

    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.alt = "";
    if (Datum.model.displayUrl(record)) thumb.src = Datum.model.displayUrl(record);
    item.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameDiv = document.createElement("div");
    nameDiv.className = "name";
    nameDiv.textContent = record.outputName || record.file.name;
    const statusDiv = document.createElement("div");
    statusDiv.className = "status" + (Datum.model.changedKeys(record).length > 0 ? " changed" : "");
    statusDiv.textContent = statusTextFor(record);
    meta.appendChild(nameDiv);
    meta.appendChild(statusDiv);
    item.appendChild(meta);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-x";
    removeBtn.setAttribute("aria-label", "Remove file");
    removeBtn.textContent = "\u00D7";
    removeBtn.addEventListener("click", (e) => { e.stopPropagation(); Datum.app.removeFile(record.id); });
    item.appendChild(removeBtn);

    item.addEventListener("click", () => Datum.app.selectFile(record.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); Datum.app.selectFile(record.id); }
    });

    li.appendChild(item);
    return li;
  }

  function renderQueue(state) {
    const panel = document.getElementById("queue-panel");
    panel.innerHTML = "";

    const h3 = document.createElement("h3");
    h3.textContent = "Files (" + state.records.length + ")";
    panel.appendChild(h3);

    const ul = document.createElement("ul");
    ul.className = "queue-list";
    for (const record of state.records) ul.appendChild(buildQueueItem(record, state));
    panel.appendChild(ul);

    const actions = document.createElement("div");
    actions.className = "queue-actions";

    const addLabel = document.createElement("label");
    addLabel.className = "add-more-label btn btn-ghost";
    addLabel.setAttribute("for", "file-input-more");
    addLabel.appendChild(document.createTextNode("+ Add more files"));
    const addInput = document.createElement("input");
    addInput.type = "file";
    addInput.id = "file-input-more";
    addInput.multiple = true;
    addInput.accept = "image/jpeg,image/png,image/heic,image/heif,.heic,.heif,image/avif,.avif,image/gif,image/webp,image/bmp,image/tiff,.tif,.tiff,.zip,application/zip";
    addInput.addEventListener("change", () => { if (addInput.files.length) Datum.app.addFiles(addInput.files); });
    addLabel.appendChild(addInput);
    actions.appendChild(addLabel);

    if (state.records.length > 1) {
      actions.appendChild(makeButton("Apply this location to all", "btn btn-sm", () => Datum.app.applyGpsToAll()));
      actions.appendChild(makeButton("Apply compression settings to all", "btn btn-sm", () => Datum.app.applyCompressionToAll()));
      actions.appendChild(makeButton("Strip all metadata (every file)", "btn btn-sm btn-danger", () => Datum.app.stripAllFiles()));
      actions.appendChild(makeButton("Download all as .zip", "btn btn-primary", () => Datum.app.downloadAllZip()));
    }
    panel.appendChild(actions);
  }

  // ---------- Editor: common fields ----------

  function refreshChangedIndicators(record) {
    const changed = new Set(Datum.model.changedKeys(record));
    document.querySelectorAll(".field[data-key]").forEach((fieldEl) => {
      const key = fieldEl.getAttribute("data-key");
      fieldEl.classList.toggle("is-changed", changed.has(key));
    });
    const diffCountEl = document.getElementById("diff-count");
    if (diffCountEl) updateDiffCountEl(diffCountEl, record);
    updateQueueItemStatus(record);
    refreshValidity(record);
    updateFormatNote(record);
  }

  // Marks every field that can't be written, with the reason underneath.
  // Recomputed as a whole because some rules span fields (latitude needs
  // longitude, altitude needs both).
  function refreshValidity(record) {
    const byKey = {};
    if (record.supportsEdit) {
      for (const p of Datum.validateFields(record.fields)) if (!byKey[p.key]) byKey[p.key] = p.message;
    }
    document.querySelectorAll(".editor-panel .field[data-key]").forEach((fieldEl) => {
      const key = fieldEl.getAttribute("data-key");
      const input = fieldEl.querySelector("input, select");
      if (!input) return;
      let msg = fieldEl.querySelector(".field-error");
      if (byKey[key]) {
        if (!msg) {
          msg = document.createElement("div");
          msg.className = "field-error";
          msg.id = "field-error-" + key;
          fieldEl.appendChild(msg);
        }
        msg.textContent = byKey[key];
        input.classList.add("invalid");
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", msg.id);
      } else {
        if (msg) msg.remove();
        input.classList.remove("invalid");
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    });
  }

  function inRange(lat, lon) {
    return lat !== "" && lon !== "" && lat !== undefined && lon !== undefined &&
      isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  function updateDiffCountEl(el, record) {
    const n = Datum.model.changedKeys(record).length;
    el.innerHTML = "";
    if (n === 0 && !record.crop) { el.textContent = "No changes yet"; return; }
    if (n > 0) {
      const b = document.createElement("b");
      b.textContent = String(n);
      el.appendChild(b);
      el.appendChild(document.createTextNode(n === 1 ? " field changed" : " fields changed"));
    }
    if (record.crop) {
      const b = document.createElement("b");
      b.textContent = n > 0 ? " \u00B7 cropped" : "Cropped";
      el.appendChild(b);
    }
  }

  function updateQueueItemName(record) {
    const item = document.querySelector('.queue-item[data-id="' + record.id + '"]');
    if (!item) return;
    const nameDiv = item.querySelector(".name");
    if (nameDiv) nameDiv.textContent = record.outputName;
  }

  function updateQueueItemStatus(record) {
    const item = document.querySelector('.queue-item[data-id="' + record.id + '"]');
    if (!item) return;
    const statusDiv = item.querySelector(".status");
    if (!statusDiv) return;
    statusDiv.textContent = statusTextFor(record);
    statusDiv.classList.toggle("changed", Datum.model.changedKeys(record).length > 0);
  }

  function buildFieldEl(def, record) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.dataset.key = def.key;

    const label = document.createElement("label");
    label.appendChild(document.createTextNode(def.label + " "));
    const dot = document.createElement("span");
    dot.className = "changed-dot";
    label.appendChild(dot);
    wrap.appendChild(label);

    let input;
    if (def.type === "orientation") {
      input = document.createElement("select");
      for (const opt of Datum.ORIENTATION_OPTIONS) {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.value = String(record.fields[def.key] === undefined || record.fields[def.key] === "" ? 1 : record.fields[def.key]);
    } else if (def.key === "dateTaken") {
      input = document.createElement("input");
      input.type = "datetime-local";
      input.step = "1";
      input.value = record.fields[def.key] || "";
    } else if (def.type === "int" || def.type === "rational") {
      input = document.createElement("input");
      input.type = "number";
      input.step = def.type === "rational" ? "0.1" : "1";
      input.value = (record.fields[def.key] === "" || record.fields[def.key] === undefined) ? "" : record.fields[def.key];
      if (def.placeholder) input.placeholder = def.placeholder;
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = record.fields[def.key] || "";
      if (def.placeholder) input.placeholder = def.placeholder;
    }

    input.addEventListener("input", () => {
      record.fields[def.key] = input.value;
      if (input.value !== "") record.stripRequested = false;
      refreshChangedIndicators(record);
    });
    input.addEventListener("change", () => {
      record.fields[def.key] = input.value;
      refreshChangedIndicators(record);
    });

    wrap.appendChild(input);
    if (def.hint) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = def.hint;
      wrap.appendChild(hint);
    }
    return wrap;
  }

  function buildCommonFields(container, record) {
    const schema = Datum.examifSchema();
    const order = ["camera", "datetime", "description", "technical"];
    for (const cat of order) {
      const defs = schema.filter((d) => d.category === cat);
      if (!defs.length) continue;
      const group = document.createElement("div");
      group.className = "field-group";
      const h4 = document.createElement("h4");
      h4.textContent = Datum.CATEGORY_LABELS[cat];
      group.appendChild(h4);
      const grid = document.createElement("div");
      grid.className = "field-grid";
      for (const def of defs) grid.appendChild(buildFieldEl(def, record));
      group.appendChild(grid);
      container.appendChild(group);
    }
  }

  // ---------- Editor: GPS panel ----------

  function buildGpsNumberField(key, label, record, min, max) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    wrap.dataset.key = key;
    const labelEl = document.createElement("label");
    labelEl.appendChild(document.createTextNode(label + " "));
    const dot = document.createElement("span");
    dot.className = "changed-dot";
    labelEl.appendChild(dot);
    wrap.appendChild(labelEl);

    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.min = String(min);
    input.max = String(max);
    input.value = (record.fields[key] === "" || record.fields[key] === undefined || record.fields[key] === null) ? "" : record.fields[key];

    input.addEventListener("input", () => {
      const raw = input.value;
      record.fields[key] = raw === "" ? "" : parseFloat(raw);
      if (raw !== "") record.stripRequested = false;
      if (key === "latitude" || key === "longitude") {
        const lat = record.fields.latitude, lon = record.fields.longitude;
        if (inRange(lat, lon)) {
          Datum.mapWidget.setPosition(lat, lon, { recenter: true, zoom: 12 });
        } else {
          Datum.mapWidget.setPosition(null, null);
        }
      }
      updateGpsReadout(record);
      refreshChangedIndicators(record);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function updateGpsReadout(record) {
    const el = document.getElementById("gps-readout");
    if (!el) return;
    const lat = record.fields.latitude, lon = record.fields.longitude;
    if (lat === "" || lon === "" || lat === undefined || lon === undefined || !isFinite(lat) || !isFinite(lon)) {
      el.textContent = "No location set";
      return;
    }
    if (!inRange(lat, lon)) {
      el.textContent = "Out of range: latitude must be within \u00B190 and longitude within \u00B1180";
      return;
    }
    el.textContent = Datum.gps.formatDMS(Number(lat), true) + "   \u00B7   " + Datum.gps.formatDMS(Number(lon), false);
  }

  function setGpsFieldsFromMap(record, lat, lon) {
    record.fields.latitude = Math.round(lat * 1e6) / 1e6;
    record.fields.longitude = Math.round(lon * 1e6) / 1e6;
    record.stripRequested = false;
    const latInput = document.querySelector('.field[data-key="latitude"] input');
    const lonInput = document.querySelector('.field[data-key="longitude"] input');
    if (latInput) latInput.value = record.fields.latitude;
    if (lonInput) lonInput.value = record.fields.longitude;
    Datum.mapWidget.setPosition(record.fields.latitude, record.fields.longitude, { recenter: false });
    updateGpsReadout(record);
    refreshChangedIndicators(record);
  }

  function useMyLocation(record) {
    if (!navigator.geolocation) { showToast("Your browser doesn't support location."); return; }
    showToast("Requesting your location\u2026");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsFieldsFromMap(record, pos.coords.latitude, pos.coords.longitude);
        Datum.mapWidget.setPosition(record.fields.latitude, record.fields.longitude, { recenter: true, zoom: 13 });
        showToast("Location set from your device.");
      },
      (err) => showToast("Couldn't get your location: " + (err && err.message ? err.message : "permission denied")),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function clearGps(record) {
    record.fields.latitude = "";
    record.fields.longitude = "";
    record.fields.altitude = "";
    const latInput = document.querySelector('.field[data-key="latitude"] input');
    const lonInput = document.querySelector('.field[data-key="longitude"] input');
    const altInput = document.querySelector('.field[data-key="altitude"] input');
    if (latInput) latInput.value = "";
    if (lonInput) lonInput.value = "";
    if (altInput) altInput.value = "";
    Datum.mapWidget.setPosition(null, null);
    updateGpsReadout(record);
    refreshChangedIndicators(record);
  }

  function buildGpsPanel(container, record) {
    const layout = document.createElement("div");
    layout.className = "gps-layout";

    const left = document.createElement("div");
    const mapWrap = document.createElement("div");
    mapWrap.className = "map-wrap";
    const mapDiv = document.createElement("div");
    mapDiv.id = "map";
    mapWrap.appendChild(mapDiv);
    left.appendChild(mapWrap);
    const readout = document.createElement("div");
    readout.className = "gps-readout";
    readout.id = "gps-readout";
    left.appendChild(readout);
    layout.appendChild(left);

    const right = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "field-grid";
    grid.appendChild(buildGpsNumberField("latitude", "Latitude", record, -90, 90));
    grid.appendChild(buildGpsNumberField("longitude", "Longitude", record, -180, 180));
    grid.appendChild(buildGpsNumberField("altitude", "Altitude (meters)", record, -12000, 100000));
    right.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "gps-actions";
    actions.appendChild(makeButton("Use my current location", "btn btn-sm", () => useMyLocation(record)));
    actions.appendChild(makeButton("Clear location", "btn btn-sm btn-danger", () => clearGps(record)));
    right.appendChild(actions);

    layout.appendChild(right);
    container.appendChild(layout);
  }

  // ---------- Editor: raw metadata table ----------

  function buildRawTable(container, record) {
    const entries = Object.entries(record.rawMetaPretty || {}).filter(([k]) => k !== "errors");
    if (!entries.length) {
      const p = document.createElement("div");
      p.className = "empty-note";
      p.textContent = "No additional metadata found in this file.";
      container.appendChild(p);
      return;
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const wrap = document.createElement("div");
    wrap.className = "raw-table-wrap";
    const table = document.createElement("table");
    table.className = "raw-table";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    const th1 = document.createElement("th"); th1.textContent = "Tag";
    const th2 = document.createElement("th"); th2.textContent = "Value";
    trh.appendChild(th1); trh.appendChild(th2);
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const [key, value] of entries) {
      const tr = document.createElement("tr");
      const tdKey = document.createElement("td"); tdKey.className = "key"; tdKey.textContent = key;
      const tdVal = document.createElement("td"); tdVal.className = "val"; tdVal.textContent = formatRawValue(value);
      tr.appendChild(tdKey); tr.appendChild(tdVal);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  // ---------- Editor: output format (HEIC/AVIF) ----------

  // HEIC and AVIF are saved as JPEG unless the person picks the original
  // format, which keeps the image data untouched (see heif-writer.js).
  function buildFormatRow(record) {
    const row = document.createElement("div");
    row.className = "format-row";
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "Save as");
    row.appendChild(document.createTextNode("Save as"));
    const label = record.kind === "avif" ? "AVIF" : "HEIC";
    const choices = [
      ["jpeg", "JPEG (opens everywhere)"],
      ["original", label + " (original format, no quality loss)"],
    ];
    for (const [value, text] of choices) {
      const l = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "save-format-" + record.id;
      radio.value = value;
      radio.checked = (value === "original") === !!record.keepOriginalFormat;
      if (value === "original" && !record.inPlace.ok) radio.disabled = true;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        Datum.model.setKeepOriginalFormat(record, value === "original");
        Datum.ui.render(Datum.app.getState());
      });
      l.appendChild(radio);
      l.appendChild(document.createTextNode(" " + text));
      row.appendChild(l);
    }
    const note = document.createElement("div");
    note.className = "format-note";
    note.setAttribute("role", "status");
    row.appendChild(note);
    return row;
  }

  // Why the original format isn't available, or why this export will be a
  // JPEG anyway.
  function updateFormatNote(record) {
    const note = document.querySelector(".format-note");
    if (!note) return;
    const label = record.kind === "avif" ? "AVIF" : "HEIC";
    let text = "";
    if (!record.inPlace.ok) {
      text = "Can't keep this file as " + label + ": " + (record.inPlace.reason || "its structure couldn't be read") + ".";
    } else if (record.keepOriginalFormat) {
      const reason = Datum.model.needsNewPixels(record);
      if (reason) text = reason + " needs new pixels, so this file will be saved as JPEG.";
    }
    note.textContent = text;
  }

  // ---------- Editor: compression controls ----------

  function buildCompressRow(record, onChange) {
    const row = document.createElement("div");
    row.className = "compress-row";

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "compress-toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !!record.compressEnabled;
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(document.createTextNode(" Reduce file size"));
    row.appendChild(toggleLabel);

    const targetLabel = document.createElement("label");
    targetLabel.appendChild(document.createTextNode("Target "));
    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.className = "compress-target-input";
    targetLabel.appendChild(targetInput);
    const unitSelect = document.createElement("select");
    unitSelect.className = "compress-unit-select";
    unitSelect.setAttribute("aria-label", "Target size unit");
    for (const unitKey of Object.keys(Datum.model.COMPRESS_UNITS)) {
      const o = document.createElement("option");
      o.value = unitKey;
      o.textContent = unitKey;
      unitSelect.appendChild(o);
    }
    targetLabel.appendChild(unitSelect);
    row.appendChild(targetLabel);

    // Shows the record's target in its current unit, with the input's
    // step/min matching that unit (0.1 MB vs whole KB).
    function syncTargetInput() {
      const unit = Datum.model.compressUnit(record);
      unitSelect.value = record.compressTargetUnit in Datum.model.COMPRESS_UNITS ? record.compressTargetUnit : "MB";
      targetInput.min = unit.min;
      targetInput.step = unit.step;
      targetInput.value = record.compressTarget;
    }
    syncTargetInput();

    const dimLabel = document.createElement("label");
    dimLabel.appendChild(document.createTextNode("Max dimension "));
    const dimInput = document.createElement("input");
    dimInput.type = "number";
    dimInput.min = "50";
    dimInput.step = "50";
    dimInput.placeholder = "no limit";
    dimInput.className = "compress-maxdim-input";
    dimInput.value = record.compressMaxDimension || "";
    dimLabel.appendChild(dimInput);
    dimLabel.appendChild(document.createTextNode(" px"));
    row.appendChild(dimLabel);

    const hint = document.createElement("div");
    hint.className = "compress-hint";
    hint.setAttribute("role", "status");
    row.appendChild(hint);

    // What the compressed copy will lose, or that nothing gets compressed.
    const notes = document.createElement("div");
    notes.className = "compress-notes";
    row.appendChild(notes);
    function changed() {
      notes.textContent = Datum.model.compressionNotes(record).join(" ");
      if (onChange) onChange();
    }
    changed();

    // An invalid entry is marked and explained, and the setting in use
    // stays the last valid one; leaving the field puts that value back.
    function markInvalid(input, message) {
      input.classList.toggle("invalid", !!message);
      if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      const other = input === targetInput ? dimInput : targetInput;
      hint.textContent = message || (other.classList.contains("invalid") ? hint.textContent : "");
    }

    toggle.addEventListener("change", () => {
      record.compressEnabled = toggle.checked;
      changed();
    });
    targetInput.addEventListener("input", () => {
      const v = parseFloat(targetInput.value);
      if (isFinite(v) && v > 0) {
        record.compressTarget = v;
        markInvalid(targetInput, null);
        changed();
      } else {
        markInvalid(targetInput, "Enter a target size above 0. Still using " + record.compressTarget + " " + record.compressTargetUnit + ".");
      }
    });
    targetInput.addEventListener("change", () => {
      if (targetInput.classList.contains("invalid")) { syncTargetInput(); markInvalid(targetInput, null); }
    });
    unitSelect.addEventListener("change", () => {
      // Convert the current target so the actual size limit stays the same
      // when switching units (5 MB becomes 5120 KB, not 5 KB).
      const bytes = Datum.model.targetBytesFor(record);
      const next = Datum.model.COMPRESS_UNITS[unitSelect.value];
      const factor = Math.pow(10, next.precision);
      record.compressTargetUnit = unitSelect.value;
      record.compressTarget = Math.round((bytes / next.bytes) * factor) / factor;
      syncTargetInput();
      changed();
    });
    dimInput.addEventListener("input", () => {
      if (dimInput.value.trim() === "") {
        record.compressMaxDimension = null;
        markInvalid(dimInput, null);
        return;
      }
      const v = parseFloat(dimInput.value);
      if (isFinite(v) && v >= 50) {
        record.compressMaxDimension = v;
        markInvalid(dimInput, null);
      } else {
        markInvalid(dimInput, "Use 50 px or more, or leave max dimension empty for no limit.");
      }
    });
    dimInput.addEventListener("change", () => {
      if (dimInput.classList.contains("invalid")) { dimInput.value = record.compressMaxDimension || ""; markInvalid(dimInput, null); }
    });

    return row;
  }

  // ---------- Editor shell ----------

  function renderEditor(state) {
    const panel = document.getElementById("editor-panel");
    const record = state.records.find((r) => r.id === state.activeId);
    panel.innerHTML = "";
    if (!record) return;

    const top = document.createElement("div");
    top.className = "editor-top";

    const previewFrame = document.createElement("div");
    previewFrame.className = "preview-frame";
    if (record.previewUrl) {
      const img = document.createElement("img");
      img.src = Datum.model.displayUrl(record);
      img.alt = "";
      previewFrame.appendChild(img);

      const hint = document.createElement("div");
      hint.className = "expand-hint";
      hint.innerHTML = '<svg width="26" height="26" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<path d="M2 8V2h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M26 8V2h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M2 20v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M26 20v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
        "</svg>";
      previewFrame.appendChild(hint);

      previewFrame.classList.add("clickable");
      previewFrame.setAttribute("role", "button");
      previewFrame.setAttribute("tabindex", "0");
      previewFrame.setAttribute("aria-label", "View full size");
      const openGallery = () => Datum.gallery.open(Datum.app.getState(), record.id);
      previewFrame.addEventListener("click", openGallery);
      previewFrame.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openGallery(); }
      });
    } else {
      const span = document.createElement("div");
      span.className = "no-preview";
      span.textContent = "No preview available";
      previewFrame.appendChild(span);
    }
    const previewColumn = document.createElement("div");
    previewColumn.className = "preview-column";
    previewColumn.appendChild(previewFrame);
    if (record.supportsEdit && record.previewUrl && record.dims.width) {
      const cropRow = document.createElement("div");
      cropRow.className = "preview-actions";
      const openCrop = () => Datum.crop.open(record, (rect, url) => {
        Datum.model.setCrop(record, rect, url);
        Datum.ui.render(Datum.app.getState());
      });
      cropRow.appendChild(makeButton(record.crop ? "Edit crop" : "Crop", "btn btn-sm crop-open", openCrop));
      if (record.crop) {
        cropRow.appendChild(makeButton("Remove crop", "btn btn-sm btn-ghost crop-remove", () => {
          Datum.model.setCrop(record, null, null);
          Datum.ui.render(Datum.app.getState());
        }));
      }
      previewColumn.appendChild(cropRow);
    }
    top.appendChild(previewColumn);

    const summary = document.createElement("div");
    summary.className = "file-summary";
    const nameRow = document.createElement("div");
    nameRow.className = "filename-row";
    const nameInput = document.createElement("input");
    nameInput.className = "filename";
    nameInput.type = "text";
    nameInput.value = record.outputName;
    nameInput.setAttribute("aria-label", "Output filename");
    nameInput.addEventListener("input", () => { record.outputName = nameInput.value; updateQueueItemName(record); });
    nameRow.appendChild(nameInput);
    summary.appendChild(nameRow);

    const facts = document.createElement("div");
    facts.className = "facts";
    facts.appendChild(factSpan("Type", record.kind.toUpperCase()));
    facts.appendChild(factSpan("Size", formatBytes(record.file.size)));
    if (record.crop) {
      facts.appendChild(factSpan("Dimensions", record.crop.width + "\u00D7" + record.crop.height +
        " (cropped from " + record.dims.width + "\u00D7" + record.dims.height + ")"));
    } else if (record.dims.width) {
      facts.appendChild(factSpan("Dimensions", record.dims.width + "\u00D7" + record.dims.height));
    }
    summary.appendChild(facts);

    if (record.notice) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.textContent = record.notice;
      summary.appendChild(notice);
    }
    if (record.error) {
      const notice = document.createElement("div");
      notice.className = "notice warn";
      notice.textContent = record.error;
      summary.appendChild(notice);
    }
    if (record.warning) {
      const warning = document.createElement("div");
      warning.className = "notice warn";
      warning.textContent = record.warning;
      summary.appendChild(warning);
    }
    top.appendChild(summary);
    panel.appendChild(top);

    if (!record.supportsEdit) {
      const footer = document.createElement("div");
      footer.className = "editor-footer";
      footer.appendChild(document.createElement("div"));
      footer.appendChild(makeButton("Download file", "btn btn-primary", () => Datum.batch.downloadSingle(record)));
      panel.appendChild(footer);
      return;
    }

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const tabDefs = [["common", "Common fields"], ["gps", "Location"], ["raw", "All fields"]];
    const tabButtons = {};
    for (const [key, label] of tabDefs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-btn" + (key === activeTab ? " active" : "");
      btn.textContent = label;
      btn.setAttribute("data-tab", key);
      tabButtons[key] = btn;
      tabs.appendChild(btn);
    }
    panel.appendChild(tabs);

    const commonPanel = document.createElement("div");
    commonPanel.className = "tab-panel active";
    buildCommonFields(commonPanel, record);

    const gpsPanel = document.createElement("div");
    gpsPanel.className = "tab-panel";
    buildGpsPanel(gpsPanel, record);

    const rawPanel = document.createElement("div");
    rawPanel.className = "tab-panel";
    buildRawTable(rawPanel, record);

    panel.appendChild(commonPanel);
    panel.appendChild(gpsPanel);
    panel.appendChild(rawPanel);

    const panels = { common: commonPanel, gps: gpsPanel, raw: rawPanel };
    function switchTab(key) {
      activeTab = key;
      Object.keys(tabButtons).forEach((k) => tabButtons[k].classList.toggle("active", k === key));
      Object.keys(panels).forEach((k) => panels[k].classList.toggle("active", k === key));
      if (key === "gps") Datum.mapWidget.invalidateSize();
    }
    for (const [key] of tabDefs) tabButtons[key].addEventListener("click", () => switchTab(key));
    if (!panels[activeTab]) activeTab = "common";
    Object.keys(panels).forEach((k) => panels[k].classList.toggle("active", k === activeTab));

    const footer = document.createElement("div");
    footer.className = "editor-footer";

    const hasPixelSource = Datum.model.getPixelSourceBytes(record) !== null;
    let downloadBtn = null;
    if (Datum.model.isConverted(record.kind) && record.supportsEdit) {
      footer.appendChild(buildFormatRow(record));
    }
    if (hasPixelSource) {
      footer.appendChild(buildCompressRow(record, () => { updateDownloadLabel(); updateFormatNote(record); }));
    }

    const diffCount = document.createElement("div");
    diffCount.className = "diff-count";
    diffCount.id = "diff-count";
    updateDiffCountEl(diffCount, record);
    footer.appendChild(diffCount);

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";
    btnRow.appendChild(makeButton("Reset changes", "btn btn-ghost", () => { Datum.model.resetAll(record); Datum.ui.render(Datum.app.getState()); }));
    btnRow.appendChild(makeButton("Strip all metadata", "btn btn-danger", () => { Datum.model.stripAll(record); Datum.ui.render(Datum.app.getState()); }));
    downloadBtn = makeButton(Datum.model.willCompress(record) ? "Download compressed" : "Download", "btn btn-primary", () => Datum.batch.downloadSingle(record));
    btnRow.appendChild(downloadBtn);
    footer.appendChild(btnRow);
    panel.appendChild(footer);

    function updateDownloadLabel() {
      if (downloadBtn) downloadBtn.textContent = Datum.model.willCompress(record) ? "Download compressed" : "Download";
    }

    Datum.mapWidget.init("map");
    if (activeTab === "gps") Datum.mapWidget.invalidateSize();
    Datum.mapWidget.onClick((lat, lon) => setGpsFieldsFromMap(record, lat, lon));
    if (inRange(record.fields.latitude, record.fields.longitude)) {
      Datum.mapWidget.setPosition(record.fields.latitude, record.fields.longitude, { recenter: true, zoom: 12 });
    } else {
      Datum.mapWidget.setPosition(null, null);
    }
    updateGpsReadout(record);
    refreshValidity(record);
    updateFormatNote(record);
  }

  // ---------- Top-level render ----------

  function render(state) {
    const root = document.getElementById("app-root");
    if (!state.records.length) {
      root.innerHTML = dropzoneMarkup();
      wireDropzone();
      return;
    }
    root.innerHTML = '<div class="workspace"><div class="queue-panel" id="queue-panel"></div><div class="editor-panel" id="editor-panel"></div></div>';
    renderQueue(state);
    renderEditor(state);
  }

  Datum.ui = { render, showToast };
})(window.Datum = window.Datum || {});
