/* Fullscreen image viewer. Lives entirely in its own overlay appended to
   <body> -- it never touches the existing workspace/queue DOM, so the
   thumbnail layout is completely unaffected whether this is open or not.

   Navigating left/right while open just swaps the displayed image (cheap,
   no re-render of the underlying editor/map). The active file in the main
   UI only gets synced once, when the viewer closes -- so browsing quickly
   through a batch doesn't repeatedly rebuild the editor panel or
   reinitialize the map. */
(function (Datum) {
  "use strict";

  let overlayEl = null, imgEl = null, captionEl = null, prevBtn = null, nextBtn = null, noPreviewEl = null;
  let records = [];
  let index = 0;
  let keydownHandler = null;

  function ensureOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement("div");
    overlayEl.className = "gallery-overlay";
    overlayEl.setAttribute("role", "dialog");
    overlayEl.setAttribute("aria-modal", "true");
    overlayEl.setAttribute("aria-label", "Image viewer");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "gallery-close";
    closeBtn.setAttribute("aria-label", "Close viewer");
    closeBtn.textContent = "\u00D7";
    closeBtn.addEventListener("click", close);

    prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "gallery-nav gallery-prev";
    prevBtn.setAttribute("aria-label", "Previous image");
    prevBtn.textContent = "\u2039";
    prevBtn.addEventListener("click", () => step(-1));

    nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "gallery-nav gallery-next";
    nextBtn.setAttribute("aria-label", "Next image");
    nextBtn.textContent = "\u203A";
    nextBtn.addEventListener("click", () => step(1));

    const stage = document.createElement("div");
    stage.className = "gallery-stage";
    imgEl = document.createElement("img");
    imgEl.className = "gallery-image";
    imgEl.alt = "";
    noPreviewEl = document.createElement("div");
    noPreviewEl.className = "gallery-no-preview";
    noPreviewEl.textContent = "No preview available";
    stage.appendChild(imgEl);
    stage.appendChild(noPreviewEl);

    captionEl = document.createElement("div");
    captionEl.className = "gallery-caption";

    overlayEl.appendChild(closeBtn);
    overlayEl.appendChild(prevBtn);
    overlayEl.appendChild(stage);
    overlayEl.appendChild(nextBtn);
    overlayEl.appendChild(captionEl);

    // Click on the dark backdrop (not the image/buttons/caption) closes it.
    overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) close(); });

    document.body.appendChild(overlayEl);
  }

  function render() {
    const record = records[index];
    if (!record) return;
    if (Datum.model.displayUrl(record)) {
      imgEl.src = Datum.model.displayUrl(record);
      imgEl.style.display = "";
      noPreviewEl.style.display = "none";
    } else {
      imgEl.removeAttribute("src");
      imgEl.style.display = "none";
      noPreviewEl.style.display = "";
    }
    const name = record.outputName || record.file.name;
    captionEl.textContent = records.length > 1
      ? name + "   \u00B7   " + (index + 1) + " of " + records.length
      : name;
    const multi = records.length > 1;
    prevBtn.style.display = multi ? "" : "none";
    nextBtn.style.display = multi ? "" : "none";
  }

  function step(delta) {
    if (records.length === 0) return;
    index = (index + delta + records.length) % records.length;
    render();
  }

  function onKeydown(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  }

  function open(state, startId) {
    ensureOverlay();
    records = state.records.slice();
    const found = records.findIndex((r) => r.id === startId);
    index = found >= 0 ? found : 0;
    render();
    overlayEl.classList.add("open");
    keydownHandler = onKeydown;
    document.addEventListener("keydown", keydownHandler);
  }

  function close() {
    if (!overlayEl || !overlayEl.classList.contains("open")) return;
    overlayEl.classList.remove("open");
    if (keydownHandler) {
      document.removeEventListener("keydown", keydownHandler);
      keydownHandler = null;
    }
    const record = records[index];
    if (record) Datum.app.selectFile(record.id);
  }

  Datum.gallery = { open, close };
})(window.Datum = window.Datum || {});
