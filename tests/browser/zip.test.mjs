// Zip archives in both directions: a zip of photos is unpacked into the queue
// (ignoring macOS cruft, counting real skips), and "Download all as .zip"
// produces a zip whose entries are valid files with unique names.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  appTest, addFixtures, records, toastText, downloadFrom, outputOf, bytesOf, isJpeg, isPng,
  fixture, ROOT,
} from "../helpers/app.mjs";
import { readFileSync } from "node:fs";

// JSZip ships as a browser script; its UMD wrapper also exports to Node.
const require = createRequire(import.meta.url);
const JSZip = require(path.join(ROOT, "vendor/jszip.min.js"));

const ARCHIVE_IMAGES = ["photo-exif.jpg", "photo-alpha-exif.png", "photo-exif.heic", "sample.gif"];

appTest("archive.zip unpacks its four images and nothing else", async (s) => {
  await addFixtures(s, ["archive.zip"], 4);
  const names = (await records(s.page)).map((r) => r.name).sort();
  assert.deepEqual(names, [...ARCHIVE_IMAGES].sort(), "folders are flattened, junk and text are dropped");
  assert.deepEqual(s.errors, []);
});

appTest("zip import ignores macOS cruft silently but reports real skips", async (s) => {
  await addFixtures(s, ["archive.zip"], 4);
  const message = await toastText(s.page, /Added 4 files/);
  // __MACOSX and .DS_Store are not counted; notes.txt and nested.zip are.
  assert.match(message, /2 items skipped/);
});

appTest("'Download all as .zip' produces a zip with unique, valid entries", async (s) => {
  await addFixtures(s, ["archive.zip"], 4);
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  assert.equal(name, "datum-export.zip");

  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  const entryNames = entries.map((f) => f.name).sort();
  // The HEIC converts to photo-exif.jpg, which collides with the JPEG already
  // in the archive, so it gets a numbered name.
  assert.deepEqual(entryNames, ["photo-alpha-exif.png", "photo-exif (2).jpg", "photo-exif.jpg", "sample.gif"]);

  const byName = Object.fromEntries(await Promise.all(entries.map(async (f) => [f.name, Buffer.from(await f.async("uint8array"))])));
  assert.ok(isJpeg(byName["photo-exif.jpg"]));
  assert.ok(isJpeg(byName["photo-exif (2).jpg"]), "converted HEIC is a JPEG");
  assert.ok(isPng(byName["photo-alpha-exif.png"]));
  assert.ok(byName["sample.gif"].equals(readFileSync(fixture("sample.gif"))), "view-only file passes through unchanged");
});

appTest("adding the same photo twice gives unique names in the exported zip", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-exif.jpg"]);
  const { bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  const zip = await JSZip.loadAsync(bytes);
  const entryNames = Object.keys(zip.files).sort();
  assert.deepEqual(entryNames, ["photo-exif (2).jpg", "photo-exif.jpg"]);
});

appTest("a damaged zip is refused with a message and adds nothing", async (s) => {
  await s.page.setInputFiles("#file-input", [fixture("corrupt.zip")]);
  const message = await toastText(s.page, /Could not open/);
  assert.match(message, /corrupt\.zip/);
  assert.equal((await records(s.page)).length, 0, "no files should be added from a damaged zip");
  assert.deepEqual(s.errors, []);
});

appTest("a zip exported from the app round-trips back into the queue", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  const { bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  await s.page.reload();
  await s.page.waitForFunction(() => window.Datum && Datum.app);
  await s.page.setInputFiles("#file-input", [{ name: "export.zip", mimeType: "application/zip", buffer: bytes }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 2);
  const names = (await records(s.page)).map((r) => r.name).sort();
  assert.deepEqual(names, ["photo-exif.jpg", "photo-noexif.png"]);
  const out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
});
