// "Strip all metadata" must remove everything that can identify a person or
// place, not only EXIF: XMP, IPTC, comments, and data hidden after the end
// of the image. Changing or clearing the location must not leave the old
// position behind in XMP either.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, bytesOf, decodedSize, readTags, setLocationField,
} from "../helpers/app.mjs";

const has = (bytes, text) => bytes.includes(Buffer.from(text));

appTest("strip removes XMP, IPTC, comments and data after the image, and keeps the colour profile", async (s) => {
  await addFixtures(s, ["privacy-extras.jpg"]);
  const before = bytesOf((await outputOf(s.page, 0)).b64);
  for (const secret of ["GPSLatitude", "Home Street", "Paris", "TRAILING-SECRET", "Datum Test Cam"]) {
    assert.ok(has(before, secret), `fixture should contain ${secret} before stripping`);
  }
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const out = await outputOf(s.page, 0);
  const bytes = bytesOf(out.b64);
  for (const secret of ["GPSLatitude", "Home Street", "Paris", "TRAILING-SECRET", "Datum Test Cam", "http://ns.adobe.com/xap"]) {
    assert.ok(!has(bytes, secret), `"${secret}" should be gone after stripping`);
  }
  assert.ok(has(bytes, "ICC_PROFILE"), "the colour profile is needed to display the image correctly");
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 320, height: 240 });
});

appTest("strip keeps the orientation tag so a sideways-stored photo still displays upright", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const out = await outputOf(s.page, 0);
  assert.deepEqual(await readTags(s.page, out.b64, ["Orientation", "Make", "Model"]), { Orientation: 6 });
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 300, height: 200 });
});

appTest("clearing the location also removes the XMP copy and keeps the rest of the XMP", async (s) => {
  await addFixtures(s, ["privacy-extras.jpg"]);
  await s.page.locator('.tab-btn[data-tab="gps"]').click();
  await s.page.getByRole("button", { name: "Clear location" }).click();
  const bytes = bytesOf((await outputOf(s.page, 0)).b64);
  assert.ok(!has(bytes, "GPSLatitude") && !has(bytes, "GPSAltitude"), "XMP location should be removed");
  assert.ok(has(bytes, 'Rating="4"'), "unrelated XMP (the rating) should be kept");
});

appTest("moving the location removes the stale XMP copy", async (s) => {
  await addFixtures(s, ["privacy-extras.jpg"]);
  await setLocationField(s.page, "latitude", 10.5);
  const out = await outputOf(s.page, 0);
  assert.ok(!has(bytesOf(out.b64), "37,46.494N"), "the old XMP position must not survive");
  const tags = await readTags(s.page, out.b64, ["latitude"]);
  assert.ok(Math.abs(tags.latitude - 10.5) < 1e-4, "EXIF has the new position");
});

appTest("editing something else leaves the XMP untouched", async (s) => {
  await addFixtures(s, ["privacy-extras.jpg"]);
  await s.page.locator('.editor-panel .field[data-key="description"] input').fill("New caption");
  const bytes = bytesOf((await outputOf(s.page, 0)).b64);
  assert.ok(has(bytes, "37,46.494N") && has(bytes, 'Rating="4"'), "XMP is only changed when the location changes");
});

appTest("a location stored only in XMP is pointed out", async (s) => {
  await addFixtures(s, ["xmp-only-gps.jpg"]);
  const [r] = await records(s.page);
  assert.equal(r.fields.latitude, "", "the editor reads EXIF, which has no location");
  assert.match(r.notice, /location in its XMP metadata/);
});

appTest("PNG: clearing the location removes the XMP copy; strip removes the XMP chunk", async (s) => {
  await addFixtures(s, ["png-xmp-gps.png"]);
  await s.page.locator('.tab-btn[data-tab="gps"]').click();
  await s.page.getByRole("button", { name: "Clear location" }).click();
  let bytes = bytesOf((await outputOf(s.page, 0)).b64);
  assert.ok(!has(bytes, "GPSLatitude"), "XMP location should be removed");
  assert.ok(has(bytes, 'Rating="4"'), "unrelated XMP should be kept");
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  bytes = bytesOf((await outputOf(s.page, 0)).b64);
  assert.ok(!has(bytes, "XML:com.adobe.xmp"), "strip removes the XMP chunk");
});
