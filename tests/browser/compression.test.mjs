// "Reduce file size": recompression must hit the target when it can, always
// produce a valid JPEG, leave files under the target untouched, honour the
// max dimension, and keep the metadata.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, readExif, bytesOf, decodedSize,
  isJpeg, setCompression, setField, selectQueueItem,
} from "../helpers/app.mjs";

const KB = 1024;

appTest("a large JPEG is compressed to fit under the target and stays a decodable JPEG", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  const [src] = await records(s.page);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 50 });
  const out = await outputOf(s.page, 0);
  const bytes = bytesOf(out.b64);

  assert.equal(out.error, null);
  assert.equal(out.compressed, true, "should have recompressed");
  assert.equal(out.reachedTarget, true, "should reach a 50 KB target for this photo");
  assert.ok(bytes.length <= 50 * KB, `output ${bytes.length} bytes should be within 50 KB`);
  assert.ok(bytes.length < src.width * src.height, "output should be much smaller than the raw pixels");
  assert.ok(isJpeg(bytes));
  const size = await decodedSize(s.page, out.b64, out.mime);
  assert.deepEqual(size, { width: src.width, height: src.height });
});

appTest("a PNG over the target is compressed to a JPEG", async (s) => {
  await addFixtures(s, ["photo-alpha-exif.png"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 40 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.equal(out.mime, "image/jpeg", "compressed output is always JPEG");
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.notEqual(await decodedSize(s.page, out.b64, out.mime), null);
});

appTest("a HEIC over the target is compressed from its decoded JPEG", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 20 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.notEqual(await decodedSize(s.page, out.b64, out.mime), null);
});

for (const file of ["photo-noexif.jpeg", "photo-noexif.png"]) {
  appTest(`${file} already under the target is left untouched`, async (s) => {
    await addFixtures(s, [file]);
    await setCompression(s.page, { enabled: true, unit: "MB", value: 10 });
    const compressedOn = await outputOf(s.page, 0);
    await setCompression(s.page, { enabled: false });
    const normal = await outputOf(s.page, 0);
    assert.equal(compressedOn.compressed, false, "should not recompress a file under target");
    assert.ok(bytesOf(compressedOn.b64).equals(bytesOf(normal.b64)), "output should match a normal export exactly");
  });
}

appTest("max dimension caps the longest side of the compressed output", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  // The source (~141 KB) must be over the target, or the app skips
  // recompression and the cap is never applied.
  await setCompression(s.page, { enabled: true, unit: "KB", value: 50, maxDimension: 400 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  const size = await decodedSize(s.page, out.b64, out.mime);
  assert.deepEqual(size, { width: 400, height: 300 }, "1200x900 capped at 400 px keeps the 4:3 ratio");
});

appTest("an unreachable target still returns a valid JPEG and reports that it fell short", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 1 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.equal(out.reachedTarget, false, "1 KB is not reachable for a 1200x900 photo");
  assert.ok(isJpeg(bytesOf(out.b64)), "should still return a JPEG, the smallest one found");
  assert.notEqual(await decodedSize(s.page, out.b64, out.mime), null);
});

appTest("compressed output keeps the metadata, including edits", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "description", "Survives compression");
  await setCompression(s.page, { enabled: true, unit: "KB", value: 50 });
  const out = await outputOf(s.page, 0);
  const exif = (await readExif(s.page, out.b64)) || {};
  assert.equal(out.compressed, true);
  assert.equal(exif.ImageDescription, "Survives compression");
  assert.equal(exif.Make, "Datum Test Cam");
  assert.ok(Math.abs(exif.latitude - 37.7749) < 1e-4, "GPS should survive compression");
});

appTest("'Apply compression settings to all' copies the target to other compressible files", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 60 });
  await s.page.getByRole("button", { name: "Apply compression settings to all" }).click();
  await selectQueueItem(s.page, 1);
  const [, other] = await records(s.page);
  assert.equal(other.compressEnabled, true);
  assert.equal(other.compressTargetUnit, "KB");
  assert.equal(other.compressTarget, 60);
});
