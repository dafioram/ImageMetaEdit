/* Crop dialog, opened from the editor preview. The crop is a rectangle in
   pixels of the displayed image; it can be drawn, moved and resized with the
   pointer, nudged with the arrow keys, or typed exactly into the X / Y /
   Width / Height boxes. An aspect preset keeps the box at that shape.
   Applying stores the rectangle on the record (see metadata-model.js); the
   pixels are only cut when the file is exported. */
(function (Datum) {
  "use strict";

  const ASPECTS = [
    ["free", "Free"], ["original", "Original"], ["1:1", "Square (1:1)"],
    ["4:3", "4:3"], ["3:4", "3:4"], ["3:2", "3:2"], ["2:3", "2:3"], ["16:9", "16:9"], ["9:16", "9:16"],
  ];
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const MIN_SIZE = 8;
  const PREVIEW_MAX = 1200;

  let current = null;

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function ratioOf(aspect, W, H) {
    if (aspect === "free") return null;
    if (aspect === "original") return W / H;
    const [a, b] = aspect.split(":").map(Number);
    return a / b;
  }

  // Keeps the rectangle inside the image, at least MIN_SIZE, and (with a
  // ratio) at that shape, shrinking it to fit rather than distorting it.
  function fit(r, W, H, ratio) {
    let { x, y, width, height } = r;
    width = Math.max(MIN_SIZE, Math.min(width, W));
    height = Math.max(MIN_SIZE, Math.min(height, H));
    if (ratio) {
      if (width / height > ratio) width = height * ratio; else height = width / ratio;
      if (width > W) { width = W; height = W / ratio; }
      if (height > H) { height = H; width = H * ratio; }
    }
    x = Math.max(0, Math.min(x, W - width));
    y = Math.max(0, Math.min(y, H - height));
    return { x, y, width, height };
  }

  function rounded(r) {
    const x = Math.round(r.x), y = Math.round(r.y);
    return { x, y, width: Math.round(r.x + r.width) - x, height: Math.round(r.y + r.height) - y };
  }

  function open(record, onApply) {
    close();
    const W = record.dims.width, H = record.dims.height;
    if (!W || !H || !record.previewUrl) return;
    const s = {
      record, onApply, W, H, aspect: "free",
      rect: record.crop ? Object.assign({}, record.crop) : { x: 0, y: 0, width: W, height: H },
    };
    current = s;

    const overlay = el("div", "crop-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "crop-title");
    const panel = el("div", "crop-panel");
    overlay.appendChild(panel);
    const title = el("h2", "crop-title", "Crop");
    title.id = "crop-title";
    panel.appendChild(title);

    const stage = el("div", "crop-stage");
    const img = el("img", "crop-image");
    img.alt = "";
    img.draggable = false;
    img.src = record.previewUrl;
    stage.appendChild(img);
    const box = el("div", "crop-box");
    box.tabIndex = 0;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Crop area. Arrow keys move it; hold Shift to move faster.");
    for (const h of HANDLES) {
      const handle = el("div", "crop-handle crop-handle-" + h);
      handle.dataset.handle = h;
      box.appendChild(handle);
    }
    stage.appendChild(box);
    panel.appendChild(stage);

    const controls = el("div", "crop-controls");
    const aspectLabel = el("label", null, "Aspect ");
    const aspect = el("select", "crop-aspect");
    for (const [value, label] of ASPECTS) {
      const o = el("option", null, label);
      o.value = value;
      aspect.appendChild(o);
    }
    aspectLabel.appendChild(aspect);
    controls.appendChild(aspectLabel);
    const inputs = {};
    for (const [key, label] of [["x", "X"], ["y", "Y"], ["width", "Width"], ["height", "Height"]]) {
      const l = el("label", null, label + " ");
      const input = el("input", "crop-" + key);
      input.type = "number";
      input.min = "0";
      input.step = "1";
      l.appendChild(input);
      l.appendChild(document.createTextNode(" px"));
      controls.appendChild(l);
      inputs[key] = input;
    }
    panel.appendChild(controls);
    panel.appendChild(el("p", "crop-note",
      "Cropping re-encodes the image: JPEG at high quality (photos converted from HEIC or AVIF too), PNG without loss. " +
      "EXIF metadata is kept; the embedded thumbnail, which would still show the uncropped picture, is removed."));

    const actions = el("div", "crop-actions");
    const fullBtn = el("button", "btn btn-ghost", "Full image");
    const cancelBtn = el("button", "btn", "Cancel");
    const applyBtn = el("button", "btn btn-primary", "Apply crop");
    for (const b of [fullBtn, cancelBtn, applyBtn]) { b.type = "button"; actions.appendChild(b); }
    panel.appendChild(actions);
    document.body.appendChild(overlay);
    s.overlay = overlay;

    // Display pixels per image pixel. Until the picture has laid out its
    // width is 0; treating that as 1 keeps early input from producing NaN.
    const scale = () => img.clientWidth / W || 1;

    function render() {
      const k = scale();
      box.style.left = s.rect.x * k + "px";
      box.style.top = s.rect.y * k + "px";
      box.style.width = s.rect.width * k + "px";
      box.style.height = s.rect.height * k + "px";
      const r = rounded(s.rect);
      for (const key of Object.keys(inputs)) if (document.activeElement !== inputs[key]) inputs[key].value = r[key];
    }

    function set(r) {
      s.rect = fit(r, W, H, ratioOf(s.aspect, W, H));
      render();
    }

    img.addEventListener("load", render);
    window.addEventListener("resize", render);
    s.cleanup = () => window.removeEventListener("resize", render);

    // ---- Pointer: draw a new box, move it, or drag a handle.
    let drag = null;
    function imagePoint(e) {
      const b = img.getBoundingClientRect();
      const k = scale();
      return { x: Math.max(0, Math.min(W, (e.clientX - b.left) / k)), y: Math.max(0, Math.min(H, (e.clientY - b.top) / k)) };
    }
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const p = imagePoint(e);
      const handle = e.target.dataset && e.target.dataset.handle;
      // A box covering the whole image can't move, so dragging inside it
      // draws a new one; otherwise dragging inside the box moves it.
      const full = s.rect.width >= W && s.rect.height >= H;
      const mode = handle ? "resize" : (e.target === box && !full ? "move" : "draw");
      drag = { start: p, rect: Object.assign({}, s.rect), mode, handle };
      stage.setPointerCapture(e.pointerId);
      box.focus({ preventScroll: true });
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = imagePoint(e);
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      const r0 = drag.rect;
      const ratio = ratioOf(s.aspect, W, H);
      if (drag.mode === "move") {
        set({ x: r0.x + dx, y: r0.y + dy, width: r0.width, height: r0.height });
      } else if (drag.mode === "draw") {
        let width = Math.abs(dx), height = Math.abs(dy);
        if (ratio) height = width / ratio;
        set({ x: dx < 0 ? drag.start.x - width : drag.start.x, y: dy < 0 ? drag.start.y - height : drag.start.y, width, height });
      } else {
        let left = r0.x, top = r0.y, right = r0.x + r0.width, bottom = r0.y + r0.height;
        const h = drag.handle;
        if (h.includes("w")) left = Math.min(r0.x + dx, right - MIN_SIZE);
        if (h.includes("e")) right = Math.max(r0.x + r0.width + dx, left + MIN_SIZE);
        if (h.includes("n")) top = Math.min(r0.y + dy, bottom - MIN_SIZE);
        if (h.includes("s")) bottom = Math.max(r0.y + r0.height + dy, top + MIN_SIZE);
        let width = right - left, height = bottom - top;
        if (ratio) {
          if (h === "n" || h === "s") width = height * ratio; else height = width / ratio;
          // Keep the side opposite the dragged handle where it was.
          if (h.includes("n")) top = bottom - height;
          if (h.includes("w")) left = right - width;
          if (h === "n" || h === "s") left = r0.x + (r0.width - width) / 2;
          if (h === "e" || h === "w") top = r0.y + (r0.height - height) / 2;
        }
        set({ x: left, y: top, width, height });
      }
    });
    const endDrag = () => { drag = null; };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);

    // ---- Keyboard: arrows move the box; Escape cancels; Enter applies.
    box.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      set({ x: s.rect.x + d[0], y: s.rect.y + d[1], width: s.rect.width, height: s.rect.height });
    });
    s.onKeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); apply(); }
    };
    document.addEventListener("keydown", s.onKeydown);

    // ---- Exact values. With an aspect set, the other side follows.
    for (const key of Object.keys(inputs)) {
      inputs[key].addEventListener("change", () => {
        const v = Number(inputs[key].value);
        if (!isFinite(v)) { render(); return; }
        const r = Object.assign({}, s.rect, { [key]: v });
        const ratio = ratioOf(s.aspect, W, H);
        if (ratio && key === "width") r.height = v / ratio;
        if (ratio && key === "height") r.width = v * ratio;
        set(r);
        render();
      });
    }
    aspect.addEventListener("change", () => {
      s.aspect = aspect.value;
      set(s.rect);
    });

    fullBtn.addEventListener("click", () => { s.aspect = "free"; aspect.value = "free"; set({ x: 0, y: 0, width: W, height: H }); });
    cancelBtn.addEventListener("click", close);
    applyBtn.addEventListener("click", apply);

    async function apply() {
      const r = rounded(fit(s.rect, W, H, null));
      const full = r.x === 0 && r.y === 0 && r.width === W && r.height === H;
      let previewUrl = null;
      if (!full) {
        // A reduced copy of the cropped area for the editor, queue and viewer.
        const k = Math.min(1, PREVIEW_MAX / Math.max(r.width, r.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(r.width * k));
        c.height = Math.max(1, Math.round(r.height * k));
        c.getContext("2d").drawImage(img, r.x, r.y, r.width, r.height, 0, 0, c.width, c.height);
        const type = record.kind === "png" ? "image/png" : "image/jpeg";
        const blob = await new Promise((res) => c.toBlob(res, type, 0.9));
        previewUrl = blob ? URL.createObjectURL(blob) : null;
      }
      close();
      onApply(full ? null : r, previewUrl);
    }

    if (img.complete) render();
    box.focus({ preventScroll: true });
  }

  function close() {
    if (!current) return;
    document.removeEventListener("keydown", current.onKeydown);
    if (current.cleanup) current.cleanup();
    if (current.overlay) current.overlay.remove();
    current = null;
  }

  function isOpen() {
    return !!current;
  }

  Datum.crop = { open, close, isOpen };
})(window.Datum = window.Datum || {});
