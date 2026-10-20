// Re-encoded pixels are stored upright and tagged orientation 1, so photos
// keep their displayed orientation through compression and HEIC conversion.
// The fixtures display as four quadrants: red top-left, green top-right.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, bytesOf, decodedSize, readTags, pixelAt, closeColor,
  setCompression, thumbnailSize,
} from "../helpers/app.mjs";

const RED = [220, 30, 30], GREEN = [30, 200, 30];

async function assertQuadrants(page, out, label) {
  assert.deepEqual(await decodedSize(page, out.b64, out.mime), { width: 300, height: 200 }, `${label}: displayed size`);
  assert.ok(closeColor(await pixelAt(page, out.b64, out.mime, 20, 20), RED), `${label}: top-left should be red`);
  assert.ok(closeColor(await pixelAt(page, out.b64, out.mime, 280, 20), GREEN), `${label}: top-right should be green`);
}

appTest("a rotated JPEG displays the same before and after compression", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  await assertQuadrants(s.page, await outputOf(s.page, 0), "unedited");
  await setCompression(s.page, { enabled: true, unit: "KB", value: 1 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  await assertQuadrants(s.page, out, "compressed");
  const tags = await readTags(s.page, out.b64, ["Orientation"]);
  assert.ok(!tags.Orientation || tags.Orientation === 1, "upright pixels are tagged normal");
});

appTest("an orientation the user picks is kept through compression", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  // "Normal" shows the pixels as stored: sideways, 200x300, green top-left.
  await s.page.locator('.field[data-key="orientation"] select').selectOption("1");
  const plain = await outputOf(s.page, 0);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 1 });
  const out = await outputOf(s.page, 0);
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), await decodedSize(s.page, plain.b64, plain.mime));
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 20, 20), GREEN), "same pixel as the uncompressed export");
});

appTest("a HEIC with a rotation converts to an upright JPEG", async (s) => {
  await addFixtures(s, ["photo-rotated.heic"]);
  const [r] = await records(s.page);
  assert.deepEqual([r.width, r.height], [300, 200]);
  assert.equal(r.fields.orientation, 1, "converted pixels are already upright");
  const out = await outputOf(s.page, 0);
  await assertQuadrants(s.page, out, "converted HEIC");
  const tags = await readTags(s.page, out.b64, ["Orientation"]);
  assert.ok(!tags.Orientation || tags.Orientation === 1);
});

appTest("a rotated HEIC stays upright when compressed", async (s) => {
  await addFixtures(s, ["photo-rotated.heic"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 1 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  await assertQuadrants(s.page, out, "compressed HEIC");
});

appTest("compression drops a stale embedded thumbnail and counts metadata toward the target", async (s) => {
  await addFixtures(s, ["photo-thumbnail.jpg"]);
  const plain = await outputOf(s.page, 0);
  assert.ok((await thumbnailSize(s.page, plain.b64)) > 0, "fixture has an embedded thumbnail");
  await setCompression(s.page, { enabled: true, unit: "KB", value: 60 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.equal(await thumbnailSize(s.page, out.b64), 0, "the old thumbnail no longer matches the pixels");
  assert.ok(bytesOf(out.b64).length <= 60 * 1024, "the whole file, metadata included, fits the target");
  assert.equal((await readTags(s.page, out.b64, ["Make"])).Make, "Datum Test Cam", "other metadata is kept");
});
