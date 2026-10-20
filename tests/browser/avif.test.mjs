// AVIF is decoded by the browser and converted to JPEG for editing, like
// HEIC. Browsers can't encode AVIF, so edited files are saved as JPEG.
// Tests skip on a browser with no AVIF decoder; one test checks the app's
// fallback for that case directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appTest, addFixtures, records, outputOf, bytesOf, decodedSize, readTags, pixelAt, closeColor, isJpeg,
  setCompression, canDecodeAvif, downloadFrom, near, fixture,
} from "../helpers/app.mjs";

const RED = [220, 30, 30], GREEN = [30, 200, 30];

async function needsAvif(s, t) {
  if (await canDecodeAvif(s.page)) return true;
  t.skip("this browser has no AVIF decoder");
  return false;
}

appTest("an AVIF loads as editable, with its camera and GPS metadata", async (s, t) => {
  if (!(await needsAvif(s, t))) return;
  await addFixtures(s, ["photo-exif.avif"]);
  const [r] = await records(s.page);
  assert.equal(r.kind, "avif");
  assert.equal(r.supportsEdit, true);
  assert.deepEqual([r.width, r.height], [640, 480]);
  assert.match(r.notice, /AVIF files are converted to JPEG/);
  assert.equal(r.fields.make, "Datum Test Cam");
  assert.ok(near(r.fields.latitude, 37.7749, 1e-4));
  assert.equal(r.outputName, "photo-exif.jpg");
});

appTest("an AVIF downloads as a JPEG that keeps its metadata and any edits", async (s, t) => {
  if (!(await needsAvif(s, t))) return;
  await addFixtures(s, ["photo-exif.avif"]);
  await s.page.locator('.editor-panel .field[data-key="description"] input').fill("Edited from AVIF");
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.jpg");
  assert.ok(isJpeg(bytes));
  const b64 = bytes.toString("base64");
  assert.deepEqual(await decodedSize(s.page, b64, "image/jpeg"), { width: 640, height: 480 });
  const tags = await readTags(s.page, b64, ["Make", "ImageDescription", "latitude"]);
  assert.equal(tags.Make, "Datum Test Cam");
  assert.equal(tags.ImageDescription, "Edited from AVIF");
  assert.ok(near(tags.latitude, 37.7749, 1e-4));
});

appTest("a rotated AVIF converts to an upright JPEG", async (s, t) => {
  if (!(await needsAvif(s, t))) return;
  await addFixtures(s, ["photo-rotated.avif"]);
  const [r] = await records(s.page);
  assert.deepEqual([r.width, r.height], [300, 200]);
  assert.equal(r.fields.orientation, 1);
  const out = await outputOf(s.page, 0);
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 300, height: 200 });
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 20, 20), RED), "top-left red");
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 280, 20), GREEN), "top-right green");
  const tags = await readTags(s.page, out.b64, ["Orientation"]);
  assert.ok(!tags.Orientation || tags.Orientation === 1);
});

appTest("a browser whose decoder ignores AVIF rotation still gets an upright JPEG", async (s, t) => {
  if (!(await needsAvif(s, t))) return;
  // Imitate WebKit on Linux: AVIF decodes come back as stored, without the
  // container's rotation, and the app's probe sees that. On a browser that
  // really does this (WebKit itself), the real decoder is tested as it is.
  await s.page.evaluate(async () => {
    if (!(await Datum.avif.browserAppliesContainerTransforms())) return;
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (source, ...rest) => {
      const bitmap = await decode(source, ...rest);
      if (!(source instanceof Blob) || source.type !== "image/avif") return bitmap;
      const t = Datum.heicBoxReader.readPrimaryTransforms(new Uint8Array(await source.arrayBuffer()));
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d").drawImage(bitmap, 0, 0);
      return decode(Datum.orientation.applyToCanvas(c, Datum.orientation.inverse(t.orientation)));
    };
    Datum.avif.browserAppliesContainerTransforms = async () => false;
  });
  await addFixtures(s, ["photo-rotated.avif"]);
  const [r] = await records(s.page);
  assert.deepEqual([r.width, r.height], [300, 200]);
  const out = await outputOf(s.page, 0);
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 20, 20), RED), "top-left red");
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 280, 20), GREEN), "top-right green");
});

appTest("the AVIF container's rotation is read from irot", async (s) => {
  const read = (file) => s.page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    return Datum.heicBoxReader.readPrimaryTransforms(u8);
  }, readFileSync(fixture(file)).toString("base64"));
  assert.deepEqual(await read("photo-rotated.avif"), { width: 200, height: 300, orientation: 6 });
  assert.deepEqual(await read("photo-exif.avif"), { width: 640, height: 480, orientation: 1 });
});

appTest("strip and compression work on an AVIF", async (s, t) => {
  if (!(await needsAvif(s, t))) return;
  await addFixtures(s, ["photo-exif.avif"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 8 });
  const compressed = await outputOf(s.page, 0);
  assert.equal(compressed.compressed, true);
  assert.ok(bytesOf(compressed.b64).length <= 8 * 1024);
  assert.equal((await readTags(s.page, compressed.b64, ["Make"])).Make, "Datum Test Cam");
  await setCompression(s.page, { enabled: false });
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const stripped = await outputOf(s.page, 0);
  assert.deepEqual(await readTags(s.page, stripped.b64, ["Make", "latitude"]), {});
});

appTest("without an AVIF decoder, the file is kept as is with an explanation", async (s) => {
  await s.page.evaluate(() => {
    Datum.avif.decodeToCanvas = async () => {
      const e = new Error("This browser can't decode AVIF images");
      e.unsupported = true;
      throw e;
    };
  });
  await addFixtures(s, ["photo-exif.avif"]);
  const [r] = await records(s.page);
  assert.equal(r.supportsEdit, false);
  assert.equal(r.error, null);
  assert.match(r.notice, /This browser can't decode AVIF images, so this file is shown as a file only/);
  const { name } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download file", exact: true }));
  assert.equal(name, "photo-exif.avif", "downloads unchanged");
});
