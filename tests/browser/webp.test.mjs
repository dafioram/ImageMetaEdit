// WebP is edited in place, like PNG: the metadata chunks are rewritten and
// the image data is left byte-for-byte as it was. The chunk reader here is
// the test's own, independent of the app's codec.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appTest, addFixtures, records, outputOf, bytesOf, decodedSize, pixelAt, closeColor, isJpeg, near, fixture,
  downloadFrom, setCompression, setLocationField, engineName,
} from "../helpers/app.mjs";

const RED = [220, 30, 30], GREEN = [30, 200, 30];
const DESCRIPTION = '.editor-panel .field[data-key="description"] input';

function chunks(buf) {
  assert.equal(buf.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(buf.subarray(8, 12).toString("latin1"), "WEBP");
  assert.equal(buf.readUInt32LE(4), buf.length - 8, "the RIFF size matches the file");
  const out = [];
  for (let o = 12; o + 8 <= buf.length;) {
    const size = buf.readUInt32LE(o + 4);
    out.push({ type: buf.subarray(o, o + 4).toString("latin1"), data: buf.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  return out;
}

const chunk = (buf, type) => chunks(buf).find((c) => c.type === type);
const imageData = (buf) => chunks(buf).filter((c) => ["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"].includes(c.type));

// The EXIF chunk's tags, read with exifr from its TIFF data.
async function exifOf(page, buf) {
  const c = chunk(buf, "EXIF");
  if (!c) return null;
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    const tags = (await window.exifr.parse(u8, { tiff: true, ifd0: true, exif: true, gps: true, translateValues: false })) || {};
    if (tags.ImageDescription) tags.ImageDescription = Datum.metadataWriter.exifToText(tags.ImageDescription);
    return tags;
  }, Buffer.from(c.data).toString("base64"));
}

function vp8xFlags(buf) {
  const c = chunk(buf, "VP8X");
  return c ? { icc: !!(c.data[0] & 0x20), alpha: !!(c.data[0] & 0x10), exif: !!(c.data[0] & 0x08), xmp: !!(c.data[0] & 0x04),
    width: 1 + c.data.readUIntLE(4, 3), height: 1 + c.data.readUIntLE(7, 3) } : null;
}

appTest("a WebP with EXIF loads as editable, with its camera, date and GPS", async (s) => {
  await addFixtures(s, ["photo-exif.webp"]);
  const [r] = await records(s.page);
  assert.equal(r.kind, "webp");
  assert.equal(r.supportsEdit, true);
  assert.deepEqual([r.width, r.height], [640, 480]);
  assert.equal(r.fields.make, "Datum Test Cam");
  assert.equal(r.fields.description, "Fixture photo");
  assert.match(r.fields.dateTaken, /^2024-05-01T10:30/);
  assert.ok(near(r.fields.latitude, 37.7749, 1e-4));
  assert.ok(near(r.fields.longitude, -122.4194, 1e-4));
});

appTest("editing a WebP rewrites only its metadata; the image data is byte-identical", async (s) => {
  await addFixtures(s, ["photo-exif.webp"]);
  await s.page.locator(DESCRIPTION).fill("Edited WebP, Zoë ✓");
  const original = readFileSync(fixture("photo-exif.webp"));
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.webp");
  assert.deepEqual(imageData(bytes), imageData(original));
  assert.equal(vp8xFlags(bytes).exif, true);
  const tags = await exifOf(s.page, bytes);
  assert.equal(tags.ImageDescription, "Edited WebP, Zoë ✓");
  assert.equal(tags.Make, "Datum Test Cam");
  assert.ok(near(tags.latitude, 37.7749, 1e-4));
  assert.deepEqual(await decodedSize(s.page, bytes.toString("base64"), "image/webp"), { width: 640, height: 480 });
});

appTest("adding metadata to a plain WebP adds the extended header it needs", async (s) => {
  await addFixtures(s, ["sample.webp"]);
  await s.page.locator('.editor-panel .field[data-key="make"] input').fill("Added Cam");
  const out = await outputOf(s.page, 0);
  const buf = bytesOf(out.b64);
  assert.equal(out.mime, "image/webp");
  assert.equal(chunks(buf)[0].type, "VP8X", "the extended header comes first");
  assert.deepEqual(vp8xFlags(buf), { icc: false, alpha: false, exif: true, xmp: false, width: 160, height: 120 });
  assert.deepEqual(imageData(buf), imageData(readFileSync(fixture("sample.webp"))));
  assert.equal((await exifOf(s.page, buf)).Make, "Added Cam");
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 160, height: 120 }, "the browser still decodes it");
});

appTest("a plain lossless WebP with transparency keeps it when metadata is added", async (s) => {
  await addFixtures(s, ["transparent.webp"]);
  await s.page.locator('.editor-panel .field[data-key="artist"] input').fill("A. Person");
  const out = await outputOf(s.page, 0);
  const buf = bytesOf(out.b64);
  const flags = vp8xFlags(buf);
  assert.equal(flags.alpha, true, "the transparency flag is set");
  assert.deepEqual([flags.width, flags.height], [200, 150]);
  assert.deepEqual(imageData(buf), imageData(readFileSync(fixture("transparent.webp"))));
  assert.equal((await pixelAt(s.page, out.b64, out.mime, 5, 75))[3], 0, "the left edge is still transparent");
  assert.deepEqual((await pixelAt(s.page, out.b64, out.mime, 150, 30)).slice(0, 3), GREEN, "lossless: exact colours");
});

appTest("an unedited plain WebP downloads byte-for-byte", async (s) => {
  await addFixtures(s, ["sample.webp"]);
  const out = await outputOf(s.page, 0);
  assert.ok(bytesOf(out.b64).equals(readFileSync(fixture("sample.webp"))));
});

appTest("strip all metadata removes a WebP's EXIF and XMP and leaves the image", async (s) => {
  await addFixtures(s, ["photo-exif.webp"]);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const buf = bytesOf((await outputOf(s.page, 0)).b64);
  assert.equal(chunk(buf, "EXIF"), undefined);
  assert.equal(chunk(buf, "XMP "), undefined);
  assert.equal(buf.includes("Datum Test Cam"), false);
  assert.equal(buf.includes("GPSLatitude"), false);
  const flags = vp8xFlags(buf);
  assert.equal(flags.exif || flags.xmp, false, "the header no longer claims metadata");
  assert.deepEqual(imageData(buf), imageData(readFileSync(fixture("photo-exif.webp"))));
});

appTest("strip keeps a WebP's orientation, so a sideways-stored image still shows upright", async (s) => {
  await addFixtures(s, ["photo-orient6.webp"]);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const buf = bytesOf((await outputOf(s.page, 0)).b64);
  const tags = await exifOf(s.page, buf);
  assert.equal(tags.Orientation, 6);
  assert.equal(tags.Make, undefined);
});

appTest("changing a WebP's location also removes the old one from its XMP", async (s) => {
  await addFixtures(s, ["photo-exif.webp"]);
  await setLocationField(s.page, "latitude", "48.8584");
  await setLocationField(s.page, "longitude", "2.2945");
  const buf = bytesOf((await outputOf(s.page, 0)).b64);
  const xmp = chunk(buf, "XMP ").data.toString("utf8");
  assert.doesNotMatch(xmp, /GPSLatitude|GPSLongitude|GPSAltitude/);
  assert.match(xmp, /xmp:Rating="4"/, "the rest of the XMP is kept");
  assert.ok(near((await exifOf(s.page, buf)).latitude, 48.8584, 1e-4));
});

appTest("an animated WebP keeps every frame when its metadata is edited", async (s) => {
  await addFixtures(s, ["animated.webp"]);
  const [r] = await records(s.page);
  // Its EXIF chunk starts with "Exif\0\0", as some writers do.
  assert.equal(r.fields.make, "Datum Test Cam");
  assert.match(r.notice, /keep the animation; cropping or reducing the file size keeps only the first frame/);
  await s.page.locator(DESCRIPTION).fill("Still animated");
  const buf = bytesOf((await outputOf(s.page, 0)).b64);
  const original = readFileSync(fixture("animated.webp"));
  assert.equal(chunks(buf).filter((c) => c.type === "ANMF").length, 3);
  assert.deepEqual(imageData(buf), imageData(original));
  assert.equal((await exifOf(s.page, buf)).ImageDescription, "Still animated");
});

appTest("cropping a rotated WebP keeps the region shown, upright, as a WebP where the browser can write one", async (s) => {
  await addFixtures(s, ["photo-orient6.webp"]);
  await s.page.locator(".crop-open").click();
  await s.page.waitForFunction(() => {
    const img = document.querySelector(".crop-image");
    return img && img.complete && img.naturalWidth > 0;
  });
  for (const [key, value] of [["width", 150], ["height", 100], ["x", 0], ["y", 0]]) {
    await s.page.locator(".crop-" + key).fill(String(value));
    await s.page.locator(".crop-" + key).press("Tab");
  }
  await s.page.getByRole("button", { name: "Apply crop" }).click();
  await s.page.waitForFunction(() => !document.querySelector(".crop-overlay"));
  const out = await outputOf(s.page, 0);
  const canWebp = await s.page.evaluate(() => Datum.compress.canEncode("image/webp"));
  const buf = bytesOf(out.b64);
  if (canWebp) {
    assert.equal(out.mime, "image/webp");
    assert.equal(out.name, "photo-orient6.webp");
    assert.equal(chunks(buf)[0].type, "VP8X");
    const tags = await exifOf(s.page, buf);
    assert.ok(!tags.Orientation || tags.Orientation === 1, "cropped pixels are stored upright");
    assert.equal(tags.Make, "Datum Test Cam");
    if (engineName() === "chromium") assert.ok(chunk(buf, "VP8L"), "a lossless source stays lossless");
  } else {
    assert.equal(out.mime, "image/jpeg");
    assert.equal(out.name, "photo-orient6.jpg");
    assert.ok(isJpeg(buf));
  }
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 150, height: 100 });
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 75, 50), RED), "the top-left quadrant is red");
});

appTest("reducing a WebP's file size saves an upright JPEG, named .jpg without a 'corrected' note", async (s) => {
  await addFixtures(s, ["photo-exif.webp"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 10 });
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download compressed" }));
  assert.equal(name, "photo-exif.jpg");
  assert.ok(isJpeg(bytes));
  assert.ok(bytes.length <= 10 * 1024);
  assert.equal(await s.page.locator("#toast .toast", { hasText: "corrected" }).count(), 0);
});

appTest("a cut-off WebP says so, and saving refuses rather than writing a broken file", async (s) => {
  const full = readFileSync(fixture("photo-exif.webp"));
  await s.page.setInputFiles("#file-input", [{ name: "cut.webp", mimeType: "image/webp", buffer: full.subarray(0, 4000) }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1);
  const [r] = await records(s.page);
  assert.equal(r.kind, "webp");
  assert.match(r.warning, /This WebP is damaged: it's cut off: its VP8 chunk should hold 19,144 bytes but the file ends 3,962 bytes in/);
  const out = await outputOf(s.page, 0);
  assert.equal(out.failed, true);
});
