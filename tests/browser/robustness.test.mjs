// Bad or unusual input must never take the app down or leave it stuck. Where
// the app currently fails to flag a problem, the test is marked `todo` so the
// gap is tracked without failing CI; remove the todo once it is fixed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { appTest, addFixtures, records, outputOf, selectQueueItem, toastText, downloadFrom, ROOT } from "../helpers/app.mjs";

const require = createRequire(import.meta.url);
const JSZip = require(path.join(ROOT, "vendor/jszip.min.js"));

appTest("an empty file does not crash the app and the rest of the queue still works", async (s) => {
  await s.page.setInputFiles("#file-input", [{ name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1);
  await addFixtures(s, ["photo-noexif.png"]);
  await selectQueueItem(s.page, 1);
  assert.equal(await s.page.locator(".filename").inputValue(), "photo-noexif.png");
  assert.deepEqual(s.errors, []);
});

appTest("a truncated JPEG is flagged in the editor", async (s) => {
  await addFixtures(s, ["broken-truncated.jpg"]);
  const [r] = await records(s.page);
  assert.ok(r.error || r.notice, "the damaged file should be flagged, not accepted silently");
}, {
  todo: "Known gap: a truncated JPEG loads with no error, and its export is not a decodable image. Expected: an error or notice on the file.",
});

appTest("an empty JPEG is flagged in the editor", async (s) => {
  await s.page.setInputFiles("#file-input", [{ name: "empty.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(0) }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1);
  const [r] = await records(s.page);
  assert.ok(r.error || r.notice, "a zero-byte file should be flagged, not accepted silently");
}, {
  todo: "Known gap: a zero-byte .jpg loads as an editable JPEG with no dimensions and no error. Expected: an error or notice on the file.",
});

appTest("a large batch of files is queued in order without errors", async (s) => {
  const batch = Array.from({ length: 10 }, () => "photo-noexif.png");
  await addFixtures(s, batch);
  const rs = await records(s.page);
  assert.equal(rs.length, 10);
  assert.ok(rs.every((r) => r.supportsEdit && r.error === null));
  assert.deepEqual(s.errors, []);
});

appTest("removing a file mid-edit does not leave the editor pointing at it", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  await s.page.locator(".queue-item").nth(0).locator(".remove-x").click();
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1);
  const active = await s.page.evaluate(() => Datum.app.getActive().file.name);
  assert.equal(active, "photo-noexif.png");
  const out = await outputOf(s.page, 0);
  assert.equal(out.error, null);
  assert.deepEqual(s.errors, []);
});

// Export failures: forced by replacing the JPEG writer with one that throws.
// The app must refuse with a message, never save a file it could not write,
// and never fall back to the original bytes.

function failJpegWrites(page) {
  return page.evaluate(() => {
    Datum.metadataWriter.writeJpeg = () => { throw new Error("simulated write failure"); };
  });
}

function countDownloads(page) {
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  return downloads;
}

appTest("a failed export is refused with a message and nothing is downloaded", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await failJpegWrites(s.page);
  const downloads = countDownloads(s.page);
  await s.page.getByRole("button", { name: "Download", exact: true }).click();
  const message = await toastText(s.page, /Couldn't export/);
  assert.match(message, /simulated write failure/);
  assert.match(message, /Nothing was downloaded/);
  await s.page.waitForTimeout(500);
  assert.equal(downloads.length, 0, "no file should be saved");
});

appTest("with strip requested, a failed export does not fall back to the original file", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  await failJpegWrites(s.page);
  const downloads = countDownloads(s.page);
  await s.page.getByRole("button", { name: "Download", exact: true }).click();
  await toastText(s.page, /Couldn't export/);
  await s.page.waitForTimeout(500);
  assert.equal(downloads.length, 0, "the original still has GPS and camera data; it must not be sent");
});

appTest("a zip leaves out only the file that failed and names it", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-alpha-exif.png"]);
  await failJpegWrites(s.page);
  const { bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  const message = await toastText(s.page, /Left out/);
  assert.match(message, /Left out 1 file that couldn't be exported: photo-exif\.jpg/);
  const zip = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files), ["photo-alpha-exif.png"]);
});

appTest("when every file fails, no empty zip is downloaded", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.jpeg"]);
  await failJpegWrites(s.page);
  const downloads = countDownloads(s.page);
  await s.page.getByRole("button", { name: "Download all as .zip" }).click();
  await toastText(s.page, /Nothing could be exported/);
  await s.page.waitForTimeout(500);
  assert.equal(downloads.length, 0);
});
