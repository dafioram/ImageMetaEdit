// What the user gets back. Editable files must come out as images the browser
// can decode, at the same size, in the format the app promises. View-only
// files must come back byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appTest, addFixtures, records, outputOf, decodedSize, bytesOf, fixture, isJpeg, isPng } from "../helpers/app.mjs";

const CASES = [
  { file: "photo-exif.jpg", expectMime: "image/jpeg", check: isJpeg },
  { file: "photo-noexif.jpeg", expectMime: "image/jpeg", check: isJpeg },
  { file: "photo-alpha-exif.png", expectMime: "image/png", check: isPng },
  { file: "photo-noexif.png", expectMime: "image/png", check: isPng },
  // HEIC/HEIF are converted: the download is a JPEG.
  { file: "photo-exif.heic", expectMime: "image/jpeg", check: isJpeg, outputName: "photo-exif.jpg" },
  { file: "photo-noexif.heif", expectMime: "image/jpeg", check: isJpeg, outputName: "photo-noexif.jpg" },
];

for (const c of CASES) {
  appTest(`${c.file} exports as a decodable ${c.expectMime} of the same size`, async (s) => {
    await addFixtures(s, [c.file]);
    const [r] = await records(s.page);
    const out = await outputOf(s.page, 0);
    const bytes = bytesOf(out.b64);

    assert.equal(out.error, null, "export should not report an error");
    assert.equal(out.mime, c.expectMime, "MIME type reported for download");
    assert.ok(c.check(bytes), `output bytes should carry a ${c.expectMime} signature`);
    const size = await decodedSize(s.page, out.b64, out.mime);
    assert.notEqual(size, null, "browser should decode the output as an image");
    assert.equal(size.width, r.width, "width should match the source");
    assert.equal(size.height, r.height, "height should match the source");
    if (c.outputName) assert.equal(r.outputName, c.outputName, "download name should change extension");
    assert.deepEqual(s.errors, []);
  });
}

// Compressed output is always JPEG, whatever the source (covered further in
// compression.test.mjs); here we only check that an unedited export of a
// PNG stays PNG rather than being silently re-encoded.
appTest("an unedited PNG export stays a PNG", async (s) => {
  await addFixtures(s, ["photo-alpha-exif.png"]);
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, false);
  assert.ok(isPng(bytesOf(out.b64)));
});

for (const file of ["sample.gif", "sample.bmp", "sample.tiff"]) {
  appTest(`${file} passes through byte-for-byte`, async (s) => {
    await addFixtures(s, [file]);
    const out = await outputOf(s.page, 0);
    assert.equal(out.compressed, false);
    assert.ok(bytesOf(out.b64).equals(readFileSync(fixture(file))), "output should match the original file exactly");
  });
}
