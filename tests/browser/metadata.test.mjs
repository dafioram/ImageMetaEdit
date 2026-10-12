// Metadata in and out: what the editor shows for each format, that edits are
// written into the exported file, that unrelated fields survive an edit, and
// that stripping removes what it promises to.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, readExif, decodedSize,
  setField, setLocationField, selectQueueItem, near,
} from "../helpers/app.mjs";

const SOURCE = { make: "Datum Test Cam", model: "TC-1", description: "Fixture photo", lat: 37.7749, lon: -122.4194 };

async function exifOf(page, index) {
  const out = await outputOf(page, index);
  assert.equal(out.error, null, "export should not report an error");
  const exif = (await readExif(page, out.b64)) || {};
  return { exif, out };
}

for (const [file, kind] of [["photo-exif.jpg", "JPEG"], ["photo-alpha-exif.png", "PNG"], ["photo-exif.heic", "HEIC"]]) {
  appTest(`${kind} editor shows the camera, description and GPS from ${file}`, async (s) => {
    await addFixtures(s, [file]);
    const [r] = await records(s.page);
    assert.equal(r.fields.make, SOURCE.make);
    assert.equal(r.fields.model, SOURCE.model);
    assert.equal(r.fields.description, SOURCE.description);
    assert.ok(near(r.fields.latitude, SOURCE.lat, 1e-4), `latitude ${r.fields.latitude}`);
    assert.ok(near(r.fields.longitude, SOURCE.lon, 1e-4), `longitude ${r.fields.longitude}`);
  });
}

for (const [file, kind] of [["photo-exif.jpg", "JPEG"], ["photo-alpha-exif.png", "PNG"], ["photo-exif.heic", "HEIC"]]) {
  appTest(`${kind} export carries an edited description and keeps the camera make`, async (s) => {
    await addFixtures(s, [file]);
    await setField(s.page, "description", "Edited caption");
    const { exif } = await exifOf(s.page, 0);
    assert.equal(exif.ImageDescription, "Edited caption", "edit should be written to the file");
    assert.equal(exif.Make, SOURCE.make, "untouched fields should survive the edit");
    assert.equal(exif.Model, SOURCE.model, "untouched fields should survive the edit");
  });
}

appTest("JPEG export carries an edited GPS location", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setLocationField(s.page, "latitude", 48.8584);
  await setLocationField(s.page, "longitude", 2.2945);
  const { exif } = await exifOf(s.page, 0);
  assert.ok(near(exif.latitude, 48.8584, 1e-4), `latitude ${exif.latitude}`);
  assert.ok(near(exif.longitude, 2.2945, 1e-4), `longitude ${exif.longitude}`);
});

appTest("a JPEG with no EXIF gains metadata when edited", async (s) => {
  await addFixtures(s, ["photo-noexif.jpeg"]);
  const before = (await exifOf(s.page, 0)).exif;
  assert.equal(before.ImageDescription, undefined, "starts with no description");
  await setField(s.page, "description", "Added later");
  const { exif, out } = await exifOf(s.page, 0);
  assert.equal(exif.ImageDescription, "Added later");
  assert.equal(out.mime, "image/jpeg");
});

appTest("a HEIC export carries the GPS fix and camera from the source", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  const { exif, out } = await exifOf(s.page, 0);
  assert.equal(out.mime, "image/jpeg", "HEIC downloads are JPEG");
  assert.equal(exif.Make, SOURCE.make);
  assert.ok(near(exif.latitude, SOURCE.lat, 1e-4));
  assert.ok(near(exif.longitude, SOURCE.lon, 1e-4));
});

for (const [file, kind] of [["photo-exif.jpg", "JPEG"], ["photo-alpha-exif.png", "PNG"], ["photo-exif.heic", "HEIC"]]) {
  appTest(`${kind} strip-all removes every EXIF field and still exports an image`, async (s) => {
    await addFixtures(s, [file]);
    await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
    const { exif, out } = await exifOf(s.page, 0);
    for (const key of ["Make", "Model", "ImageDescription", "latitude", "longitude"]) {
      assert.equal(exif[key], undefined, `${key} should be gone after stripping`);
    }
    const size = await decodedSize(s.page, out.b64, out.mime);
    assert.notEqual(size, null, "stripped output should still be a decodable image");
  });
}

appTest("reset changes restores the original metadata in the export", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "description", "Temporary");
  await s.page.getByRole("button", { name: "Reset changes", exact: true }).click();
  const { exif } = await exifOf(s.page, 0);
  assert.equal(exif.ImageDescription, SOURCE.description);
});

appTest("'Apply this location to all' writes the GPS fix into other files", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.jpeg"]);
  await setLocationField(s.page, "latitude", 51.5007);
  await setLocationField(s.page, "longitude", -0.1246);
  await s.page.getByRole("button", { name: "Apply this location to all" }).click();
  await selectQueueItem(s.page, 1);
  const { exif } = await exifOf(s.page, 1);
  assert.ok(near(exif.latitude, 51.5007, 1e-4), `latitude ${exif.latitude}`);
  assert.ok(near(exif.longitude, -0.1246, 1e-4), `longitude ${exif.longitude}`);
});

appTest("view-only files are not offered for editing", async (s) => {
  await addFixtures(s, ["sample.gif"]);
  const count = await s.page.locator(".field[data-key]").count();
  assert.equal(count, 0, "view-only files should show no editable fields");
  assert.ok(await s.page.getByRole("button", { name: "Download file", exact: true }).isVisible());
});
