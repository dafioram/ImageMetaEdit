// Every input format the app accepts loads through the real file input and
// lands in the right category: editable (JPEG, PNG, HEIC/HEIF) or view-only
// (everything else, passed through unchanged).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, addFixtures, addRenamed, records, toastText, outputOf, readExif, bytesOf, isJpeg, fixture } from "../helpers/app.mjs";

const EDITABLE = [
  { file: "photo-exif.jpg", kind: "jpeg", note: "JPEG with camera, date, GPS EXIF" },
  { file: "photo-noexif.jpeg", kind: "jpeg", note: "JPEG with the .jpeg extension and no EXIF" },
  { file: "photo-alpha-exif.png", kind: "png", note: "RGBA PNG with an eXIf chunk" },
  { file: "photo-noexif.png", kind: "png", note: "PNG with no metadata" },
  { file: "photo-exif.heic", kind: "heic", note: "HEIC with camera, date, GPS EXIF" },
  { file: "photo-noexif.heif", kind: "heic", note: "HEIF with the .heif extension and no EXIF" },
];

const VIEW_ONLY = [
  { file: "sample.gif", note: "GIF" },
  { file: "sample.bmp", note: "BMP" },
  { file: "sample.webp", note: "WebP" },
  { file: "sample.tiff", note: "TIFF (Chromium cannot decode it, so no dimensions)" },
  { file: "sample.avif", note: "AVIF" },
];

for (const { file, kind, note } of EDITABLE) {
  appTest(`editable ${kind}: ${note} (${file})`, async (s) => {
    await addFixtures(s, [file]);
    const [r] = await records(s.page);
    assert.equal(r.kind, kind, "detected kind");
    assert.equal(r.supportsEdit, true, "should be editable");
    assert.equal(r.error, null, "should load without an error");
    assert.ok(r.width > 0 && r.height > 0, `dimensions should be known, got ${r.width}x${r.height}`);
    assert.equal(r.hasPreview, true, "should have a preview");
    assert.deepEqual(s.errors, [], "no page errors while loading");
  });
}

for (const { file, note } of VIEW_ONLY) {
  appTest(`view-only: ${note} (${file})`, async (s) => {
    await addFixtures(s, [file]);
    const [r] = await records(s.page);
    assert.equal(r.kind, "other", "detected kind");
    assert.equal(r.supportsEdit, false, "should not be editable");
    assert.equal(r.error, null, "should load without an error");
    assert.match(r.notice, /isn't supported for metadata editing/, "should explain it is view-only");
    assert.equal(r.hasPreview, true, "should have a preview");
    if (r.width !== null) assert.ok(r.width > 0 && r.height > 0, "dimensions should be positive when known");
    assert.deepEqual(s.errors, [], "no page errors while loading");
  });
}

appTest("a mix of every fixture type loads into one queue", async (s) => {
  const all = [...EDITABLE.map((e) => e.file), ...VIEW_ONLY.map((v) => v.file)];
  await addFixtures(s, all);
  const rs = await records(s.page);
  assert.equal(rs.length, all.length);
  assert.deepEqual(rs.map((r) => r.name), all);
  assert.deepEqual(s.errors, []);
});

appTest("files with an unrecognised extension are treated as view-only", async (s) => {
  await s.page.setInputFiles("#file-input", [
    { name: "mystery.xyz", mimeType: "application/octet-stream", buffer: Buffer.from("not an image at all") },
  ]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1 && document.querySelectorAll(".queue-item").length === 1);
  const [r] = await records(s.page);
  assert.equal(r.kind, "other");
  assert.equal(r.supportsEdit, false);
  assert.match(r.notice, /view only|isn't supported/);
});

appTest("uploading a zip toasts the count and skips non-images", async (s) => {
  await addFixtures(s, ["archive.zip"], 4);
  const message = await toastText(s.page, /Added 4 files/);
  assert.match(message, /Added 4 files/);
  assert.match(message, /2 items skipped/, "notes.txt and nested.zip are skipped; macOS cruft is ignored silently");
});

// The file's contents decide its type, not its name. The data is never
// re-encoded; only a wrong extension is corrected.

appTest("a JPEG named .png is handled as a JPEG, keeps its metadata, and downloads as .jpg", async (s) => {
  await addRenamed(s, { as: "camera.png", mimeType: "image/png", from: "photo-exif.jpg" });
  const [r] = await records(s.page);
  assert.equal(r.kind, "jpeg");
  assert.equal(r.outputName, "camera.jpg");
  assert.match(r.notice, /named "camera\.png" but its contents are JPEG/);
  assert.equal(r.fields.make, "Datum Test Cam", "metadata should still be read");
  const out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)), "export should still be a JPEG");
  assert.equal((await readExif(s.page, out.b64)).Make, "Datum Test Cam");
});

appTest("a PNG named .heic is handled as a PNG and downloads as .png", async (s) => {
  await addRenamed(s, { as: "shot.heic", mimeType: "image/heic", from: "photo-noexif.png" });
  const [r] = await records(s.page);
  assert.equal(r.kind, "png");
  assert.equal(r.outputName, "shot.png");
  assert.equal(r.supportsEdit, true);
});

appTest("a GIF named .jpg is view-only and downloads as .gif", async (s) => {
  await addRenamed(s, { as: "anim.jpg", mimeType: "image/jpeg", from: "sample.gif" });
  const [r] = await records(s.page);
  assert.equal(r.kind, "other");
  assert.equal(r.supportsEdit, false);
  assert.equal(r.outputName, "anim.gif");
  assert.match(r.notice, /contents are GIF.*view only/);
});

appTest("a correctly named file gets no mismatch notice", async (s) => {
  await addFixtures(s, ["photo-noexif.png"]);
  const [r] = await records(s.page);
  assert.equal(r.outputName, "photo-noexif.png");
  assert.equal(r.notice, null);
});
