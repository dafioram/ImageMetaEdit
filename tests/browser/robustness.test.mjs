// Bad or unusual input must never take the app down or leave it stuck. Where
// the app currently fails to flag a problem, the test is marked `todo` so the
// gap is tracked without failing CI; remove the todo once it is fixed.
import assert from "node:assert/strict";
import { appTest, addFixtures, records, outputOf, selectQueueItem } from "../helpers/app.mjs";

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
