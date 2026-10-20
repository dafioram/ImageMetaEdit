// Values that can't be written are caught as they are typed, explained next
// to the field, and block only the download of that file, with the reason.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  appTest, addFixtures, records, setField, setLocationField, toastText, downloadFrom, outputOf, setCompression, ROOT,
} from "../helpers/app.mjs";

const require = createRequire(import.meta.url);
const JSZip = require(path.join(ROOT, "vendor/jszip.min.js"));

function fieldError(page, key) {
  return page.locator(`.editor-panel .field[data-key="${key}"] .field-error`).textContent().catch(() => null);
}

function countDownloads(page) {
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  return downloads;
}

appTest("an impossible ISO is marked, explained, and blocks the download with the reason", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "iso", "-5");
  assert.equal(await s.page.locator('.field[data-key="iso"] input').getAttribute("aria-invalid"), "true");
  assert.match(await fieldError(s.page, "iso"), /ISO must be a whole number from 1 to 65,535/);
  const downloads = countDownloads(s.page);
  await s.page.getByRole("button", { name: "Download", exact: true }).click();
  const message = await toastText(s.page, /Can't download/);
  assert.equal(message, "Can't download photo-exif.jpg yet: ISO must be a whole number from 1 to 65,535.");
  await s.page.waitForTimeout(300);
  assert.equal(downloads.length, 0);
});

appTest("fixing the value clears the mark and the download works", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "iso", "-5");
  await setField(s.page, "iso", "400");
  assert.equal(await s.page.locator('.field[data-key="iso"] .field-error').count(), 0);
  const { name } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.jpg");
});

for (const [key, value, pattern] of [
  ["fNumber", "-2.8", /Aperture must be a number above 0/],
  ["fNumber", "0", /Aperture must be a number above 0/],
  ["focalLength", "1e9", /Focal length must be/],
  ["exposureTime", "0/5", /Shutter speed must be a positive number/],
  ["iso", "70000", /ISO must be a whole number/],
  ["iso", "12.5", /ISO must be a whole number/],
]) {
  appTest(`${key} = ${value} is rejected`, async (s) => {
    await addFixtures(s, ["photo-exif.jpg"]);
    await setField(s.page, key, value);
    assert.match(await fieldError(s.page, key), pattern);
    const out = await outputOf(s.page, 0);
    assert.equal(out.failed, true);
  });
}

appTest("valid camera values are accepted", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  for (const [k, v] of [["fNumber", "2.8"], ["exposureTime", "1/250"], ["iso", "6400"], ["focalLength", "35"]]) await setField(s.page, k, v);
  assert.equal(await s.page.locator(".field-error").count(), 0);
  assert.equal((await outputOf(s.page, 0)).failed, false);
});

appTest("an out-of-range latitude is marked and the readout says so", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setLocationField(s.page, "latitude", 95);
  assert.match(await fieldError(s.page, "latitude"), /Latitude must be between -90 and 90/);
  assert.match(await s.page.locator("#gps-readout").textContent(), /Out of range/);
});

appTest("a latitude without a longitude asks for both", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await s.page.locator('.tab-btn[data-tab="gps"]').click();
  await s.page.locator('.editor-panel .field[data-key="longitude"] input').fill("");
  assert.match(await fieldError(s.page, "longitude"), /Enter both latitude and longitude/);
});

appTest("text too long for the file's metadata is rejected", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "description", "x".repeat(9000));
  assert.match(await fieldError(s.page, "description"), /Description is too long \(9,000 bytes; the limit is 8,000\)/);
});

appTest("strip all metadata clears invalid values so the file can be downloaded", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "iso", "-5");
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  assert.equal((await outputOf(s.page, 0)).failed, false);
});

appTest("a zip leaves out a file with invalid values and gives the reason", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  await setField(s.page, "iso", "-5");
  const { bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  const message = await toastText(s.page, /Left out/);
  assert.match(message, /photo-exif\.jpg \(ISO must be a whole number from 1 to 65,535\)/);
  const zip = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files), ["photo-noexif.png"]);
});

appTest("an invalid compression target is explained and the last valid one stays in use", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 300 });
  await setCompression(s.page, { value: 0 });
  assert.match(await s.page.locator(".compress-hint").textContent(), /above 0\. Still using 300 KB/);
  assert.equal((await records(s.page))[0].compressTarget, 300);
  await s.page.locator(".compress-target-input").blur();
  assert.equal(await s.page.locator(".compress-target-input").inputValue(), "300", "leaving the field shows the value in use");
});

appTest("a max dimension under 50 px is explained; empty means no limit", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true, maxDimension: 800 });
  await setCompression(s.page, { maxDimension: 10 });
  assert.match(await s.page.locator(".compress-hint").textContent(), /50 px or more/);
  assert.equal((await records(s.page))[0].compressMaxDimension, 800);
  await setCompression(s.page, { maxDimension: null });
  assert.equal((await records(s.page))[0].compressMaxDimension, null);
  assert.equal(await s.page.locator(".compress-hint").textContent(), "");
});
