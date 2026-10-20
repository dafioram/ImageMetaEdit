// "Save as HEIC/AVIF": metadata edits written into the original file, with
// its image data untouched, instead of converting to JPEG. JPEG stays the
// default, and anything that needs new pixels still saves as JPEG.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, bytesOf, isJpeg, canDecodeAvif, downloadFrom, near, setCompression,
  toastText,
} from "../helpers/app.mjs";

const DESCRIPTION = '.editor-panel .field[data-key="description"] input';

async function keepOriginal(page) {
  await page.locator(".format-row input[value='original']").check();
  await page.waitForFunction(() => Datum.app.getState().records.some((r) => r.keepOriginalFormat));
}

function brand(buf) {
  return buf.subarray(4, 12).toString("latin1");
}

// The output's metadata, read the way the app reads HEIC/AVIF, plus a
// pixel-for-pixel comparison of its decoded image with the original's.
function inspect(page, b64, kind) {
  return page.evaluate(async ({ b64, kind }) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    const r = Datum.app.getState().records[0];
    const decode = kind === "avif" ? Datum.avif.decodeToCanvas : Datum.heic.decodeToCanvas;
    const [a, b] = [await decode(r.bytes), await decode(out)];
    const pa = a.getContext("2d").getImageData(0, 0, a.width, a.height).data;
    const pb = b.getContext("2d").getImageData(0, 0, b.width, b.height).data;
    let identical = a.width === b.width && a.height === b.height;
    for (let k = 0; identical && k < pa.length; k++) if (pa[k] !== pb[k]) identical = false;
    const tiff = Datum.heicBoxReader.extractExifTiff(out);
    const tags = tiff ? await window.exifr.parse(tiff, { tiff: true, ifd0: true, exif: true, gps: true, translateValues: false }) || {} : {};
    return {
      width: b.width, height: b.height, identical,
      description: tags.ImageDescription ? Datum.metadataWriter.exifToText(tags.ImageDescription) : null,
      make: tags.Make || null, latitude: tags.latitude ?? null,
      oldText: new TextDecoder("latin1").decode(out).includes("Fixture photo"),
    };
  }, { b64, kind });
}

appTest("JPEG is the default for HEIC; the original format is offered when it can be written", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  assert.equal(await s.page.locator(".format-row input[value='jpeg']").isChecked(), true);
  assert.equal(await s.page.locator(".format-row input[value='original']").isDisabled(), false);
  assert.match((await records(s.page))[0].notice, /choose it under "Save as"/);
  const out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.equal(out.name, "photo-exif.jpg");
});

appTest("saved as HEIC: same pixels, edited metadata, old text gone", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  await keepOriginal(s.page);
  await s.page.locator(DESCRIPTION).fill("Kept as HEIC, Zoë");
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.heic");
  assert.equal(brand(bytes), "ftypheic");
  const info = await inspect(s.page, bytes.toString("base64"), "heic");
  assert.deepEqual([info.width, info.height], [800, 600]);
  assert.ok(info.identical, "the image data is untouched");
  assert.equal(info.description, "Kept as HEIC, Zoë");
  assert.equal(info.make, "Datum Test Cam");
  assert.ok(near(info.latitude, 37.7749, 1e-4));
  assert.equal(info.oldText, false, "the previous metadata bytes are cleared");
});

appTest("strip all metadata on a kept HEIC removes camera and location", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  await keepOriginal(s.page);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const out = await outputOf(s.page, 0);
  assert.equal(out.mime, "image/heic");
  const info = await inspect(s.page, out.b64, "heic");
  assert.ok(info.identical);
  assert.equal(info.make, null);
  assert.equal(info.latitude, null);
  assert.equal(info.oldText, false);
});

appTest("a rotated HEIC kept as HEIC still displays upright", async (s) => {
  await addFixtures(s, ["photo-rotated.heic"]);
  await keepOriginal(s.page);
  await s.page.locator(DESCRIPTION).fill("Still upright");
  const out = await outputOf(s.page, 0);
  const info = await inspect(s.page, out.b64, "heic");
  assert.deepEqual([info.width, info.height], [300, 200]);
  assert.ok(info.identical);
  assert.equal(info.description, "Still upright");
});

appTest("saved as AVIF: same pixels, edited metadata", async (s, t) => {
  if (!(await canDecodeAvif(s.page))) { t.skip("this browser has no AVIF decoder"); return; }
  await addFixtures(s, ["photo-exif.avif"]);
  await keepOriginal(s.page);
  await s.page.locator(DESCRIPTION).fill("Kept as AVIF");
  const out = await outputOf(s.page, 0);
  assert.equal(out.name, "photo-exif.avif");
  assert.equal(out.mime, "image/avif");
  assert.equal(brand(bytesOf(out.b64)), "ftypavif");
  const info = await inspect(s.page, out.b64, "avif");
  assert.ok(info.identical);
  assert.equal(info.description, "Kept as AVIF");
  assert.equal(info.oldText, false);
});

appTest("a HEIF with no EXIF block can't be kept, and says why", async (s) => {
  await addFixtures(s, ["photo-noexif.heif"]);
  assert.equal(await s.page.locator(".format-row input[value='original']").isDisabled(), true);
  assert.match(await s.page.locator(".format-note").textContent(), /Can't keep this file as HEIC: it has no EXIF block/);
  assert.doesNotMatch((await records(s.page))[0].notice, /Save as/);
});

appTest("crop, compression or a new orientation need new pixels, so they save as JPEG", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  await keepOriginal(s.page);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 40 });
  assert.match(await s.page.locator(".format-note").textContent(), /Reducing the file size needs new pixels/);
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download compressed" }));
  assert.ok(isJpeg(bytes));
  assert.equal(name, "photo-exif.jpg");
  await toastText(s.page, /Compressing/);
  assert.equal(await s.page.locator("#toast .toast", { hasText: "corrected" }).count(), 0, "the editor already explains the .jpg");
  await setCompression(s.page, { enabled: false });
  assert.equal(await s.page.locator(".format-note").textContent(), "");
  await s.page.locator('.field[data-key="orientation"] select').selectOption("3");
  assert.match(await s.page.locator(".format-note").textContent(), /Changing the orientation needs new pixels/);
  let out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
  await s.page.locator('.field[data-key="orientation"] select').selectOption("1");
  await s.page.evaluate(() => {
    const r = Datum.app.getState().records[0];
    Datum.model.setCrop(r, { x: 0, y: 0, width: 400, height: 300 }, null);
    Datum.ui.render(Datum.app.getState());
  });
  assert.match(await s.page.locator(".format-note").textContent(), /Cropping needs new pixels/);
  out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
});

appTest("switching back to JPEG gives a .jpg again", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  await keepOriginal(s.page);
  assert.equal((await records(s.page))[0].outputName, "photo-exif.heic");
  await s.page.locator(".format-row input[value='jpeg']").check();
  const out = await outputOf(s.page, 0);
  assert.equal(out.name, "photo-exif.jpg");
  assert.ok(isJpeg(bytesOf(out.b64)));
});
