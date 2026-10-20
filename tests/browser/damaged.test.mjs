// Damaged and mislabeled files are flagged when they are added, with what
// exactly is wrong, instead of failing later. A cut-off JPEG still loads,
// with a warning, and can be repaired by re-encoding.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appTest, addFixtures, records, fixture, outputOf, bytesOf, decodedSize, isJpeg, setCompression, toastText,
} from "../helpers/app.mjs";

async function addBytes(s, name, mimeType, buffer) {
  await s.page.setInputFiles("#file-input", [{ name, mimeType, buffer }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1 && document.querySelectorAll(".queue-item").length === 1);
  return (await records(s.page))[0];
}

// Offset of the first start-of-scan marker, found by walking the segments.
function sosOffset(jpeg) {
  let o = 2;
  while (o < jpeg.length) {
    const marker = jpeg[o + 1];
    if (marker === 0xda) return o;
    o += 2 + jpeg.readUInt16BE(o + 2);
  }
  throw new Error("no SOS");
}

appTest("a cut-off JPEG loads with a specific warning", async (s) => {
  await addFixtures(s, ["broken-truncated.jpg"]);
  const [r] = await records(s.page);
  assert.equal(r.supportsEdit, true, "it still loads and can be edited");
  assert.match(r.warning, /This JPEG is cut off: its image data stops before the end-of-image marker, 35,427 bytes in/);
  assert.match(await s.page.locator(".queue-item .status").textContent(), /^Damaged/);
  assert.match(await s.page.locator(".notice.warn").textContent(), /cut off/);
});

appTest("turning on compression saves a cut-off JPEG as a complete, decodable copy", async (s) => {
  await addFixtures(s, ["broken-truncated.jpg"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 20 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 1200, height: 900 });
});

appTest("an empty file is flagged as empty", async (s) => {
  const r = await addBytes(s, "empty.jpg", "image/jpeg", Buffer.alloc(0));
  assert.equal(r.error, "This file is empty (0 bytes).");
  assert.equal(r.supportsEdit, false);
});

appTest("a file named .jpg whose contents aren't an image says what it starts with", async (s) => {
  const r = await addBytes(s, "notes.jpg", "image/jpeg", Buffer.from("PK\x03\x04 really a zip"));
  assert.equal(r.error, 'This file is named "notes.jpg" but its contents aren\'t a JPEG image or any format this app recognizes (it starts with the bytes 50 4B 03 04).');
  assert.equal(r.supportsEdit, false);
});

appTest("a JPEG with a header but no image data is flagged", async (s) => {
  const full = readFileSync(fixture("photo-exif.jpg"));
  const headerOnly = full.subarray(0, sosOffset(full));
  const r = await addBytes(s, "header-only.jpg", "image/jpeg", headerOnly);
  assert.match(r.error, /This JPEG has no image data: the file ends after its header/);
  assert.equal(r.supportsEdit, false);
});

appTest("a cut-off PNG is flagged with where it ends", async (s) => {
  const full = readFileSync(fixture("photo-noexif.png"));
  const r = await addBytes(s, "half.png", "image/png", full.subarray(0, Math.floor(full.length / 2)));
  assert.match(r.warning, /This PNG is damaged: it's cut off: its IDAT chunk should hold/);
});

appTest("a PNG with a corrupted byte is flagged by its checksum", async (s) => {
  const bad = Buffer.from(readFileSync(fixture("photo-noexif.png")));
  bad[bad.indexOf("IDAT") + 20] ^= 0xff;
  const r = await addBytes(s, "flipped.png", "image/png", bad);
  assert.match(r.warning, /1 of its chunks \(IDAT\) fail their checksum/);
});

appTest("library errors are explained in plain words, with one period", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await s.page.evaluate(() => { Datum.metadataWriter.writeJpeg = () => { throw new Error("'pack' error."); }; });
  await s.page.getByRole("button", { name: "Download", exact: true }).click();
  const message = await toastText(s.page, /Couldn't export/);
  assert.equal(message, "Couldn't export photo-exif.jpg: a metadata value is out of the range a file can store. Nothing was downloaded.");
});
