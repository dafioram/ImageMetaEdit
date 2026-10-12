// The controls a person uses: the dropzone, the queue, the editor tabs, the
// size dropdown, strip and reset, and the actual files the download buttons save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appTest, openApp, addFixtures, records, downloadFrom, selectQueueItem, setField,
  setCompression, fixture, isJpeg, isPng, addRenamed, decodedSize,
} from "../helpers/app.mjs";

appTest("first load shows the dropzone and accepts every supported type", async (s) => {
  const heading = await s.page.locator("#dropzone h2").textContent();
  assert.equal(heading, "Drop a photo here");
  const accept = await s.page.locator("#file-input").getAttribute("accept");
  for (const type of [".heic", ".heif", "image/jpeg", "image/png", ".zip"]) {
    assert.ok(accept.includes(type), `file input should accept ${type}`);
  }
  assert.equal(await s.page.locator(".queue-item").count(), 0);
});

appTest("selecting a file in the queue switches the editor to it", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-alpha-exif.png"]);
  assert.equal(await s.page.locator(".filename").inputValue(), "photo-exif.jpg");
  await selectQueueItem(s.page, 1);
  assert.equal(await s.page.locator(".filename").inputValue(), "photo-alpha-exif.png");
});

appTest("removing a file drops it from the queue and selects a remaining one", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  await s.page.locator(".queue-item").nth(0).locator(".remove-x").click();
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 1);
  const [remaining] = await records(s.page);
  assert.equal(remaining.name, "photo-noexif.png");
  assert.equal(await s.page.locator(".filename").inputValue(), "photo-noexif.png");
});

appTest("removing the last file returns to the dropzone", async (s) => {
  await addFixtures(s, ["photo-noexif.png"]);
  await s.page.locator(".queue-item").nth(0).locator(".remove-x").click();
  await s.page.waitForSelector("#dropzone");
  assert.equal(await s.page.locator("#dropzone").count(), 1);
});

appTest("an editable file shows its tabs and an edit counter that tracks changes", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  for (const label of ["Common fields", "Location", "All fields"]) {
    assert.ok(await s.page.getByRole("button", { name: label, exact: true }).isVisible(), `${label} tab`);
  }
  assert.equal(await s.page.locator("#diff-count").textContent(), "No changes yet");
  await setField(s.page, "description", "Changed");
  assert.equal(await s.page.locator("#diff-count").textContent(), "1 field changed");
});

appTest("the Location tab shows the map and a readout", async (s) => {
  await addFixtures(s, ["photo-noexif.jpeg"]);
  await s.page.locator('.tab-btn[data-tab="gps"]').click();
  assert.equal(await s.page.locator("#map").count(), 1);
  assert.equal(await s.page.locator("#gps-readout").textContent(), "No location set");
});

appTest("'Strip all metadata (every file)' clears every editable file", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-alpha-exif.png", "sample.gif"]);
  await s.page.getByRole("button", { name: "Strip all metadata (every file)" }).click();
  const rs = await records(s.page);
  for (const r of rs.filter((x) => x.supportsEdit)) {
    assert.equal(r.fields.make, "", `${r.name} should have no camera make`);
    assert.equal(r.fields.latitude, "", `${r.name} should have no GPS`);
  }
});

// ---- Download buttons: what the user actually receives.

appTest("Download saves an edited JPEG as a JPEG named after the source", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.jpg");
  assert.ok(isJpeg(bytes));
});

appTest("Download of a HEIC saves a JPEG with a .jpg name", async (s) => {
  await addFixtures(s, ["photo-exif.heic"]);
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "photo-exif.jpg");
  assert.ok(isJpeg(bytes));
});

appTest("Download compressed saves a JPEG even when the source is a PNG", async (s) => {
  await addFixtures(s, ["photo-alpha-exif.png"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 40 });
  assert.equal(await s.page.getByRole("button", { name: "Download compressed", exact: true }).count(), 1, "button label should change");
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download compressed", exact: true }));
  assert.equal(name, "photo-alpha-exif.jpg");
  assert.ok(isJpeg(bytes));
});

appTest("Download of a view-only file saves the original bytes", async (s) => {
  await addFixtures(s, ["sample.webp"]);
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download file", exact: true }));
  assert.equal(name, "sample.webp");
  assert.ok(bytes.equals(readFileSync(fixture("sample.webp"))));
});

appTest("a PNG saved with a .jpg name downloads as a PNG with its image unchanged", async (s) => {
  await addRenamed(s, { as: "renamed.jpg", mimeType: "image/jpeg", from: "photo-noexif.png" });
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "renamed.png", "extension should follow the real format");
  assert.ok(isPng(bytes), "the download should still be a PNG");
  const size = await decodedSize(s.page, bytes.toString("base64"), "image/png");
  assert.deepEqual(size, { width: 200, height: 150 });
  const [r] = await records(s.page);
  assert.match(r.notice, /named "renamed\.jpg" but its contents are PNG/);
});

// ---- Size dropdown.

appTest("the size dropdown defaults to 5 MB and converts the value when switched", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true });
  const unit = s.page.locator(".compress-unit-select");
  const input = s.page.locator(".compress-target-input");
  assert.equal(await unit.inputValue(), "MB");
  assert.equal(await input.inputValue(), "5");

  await unit.selectOption("KB");
  assert.equal(await input.inputValue(), "5120", "5 MB should become 5120 KB, not 5 KB");

  await input.fill("300");
  assert.equal(await input.inputValue(), "300");
  await unit.selectOption("MB");
  assert.equal(await input.inputValue(), "0.29", "300 KB rounds to 2 decimals in MB");
});

appTest("1 MB and 1024 KB set the same byte limit", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true, unit: "MB", value: 1 });
  const mbBytes = await s.page.evaluate(() => Datum.model.targetBytesFor(Datum.app.getState().records[0]));
  await setCompression(s.page, { unit: "KB", value: 1024 });
  const kbBytes = await s.page.evaluate(() => Datum.model.targetBytesFor(Datum.app.getState().records[0]));
  assert.equal(mbBytes, 1024 * 1024);
  assert.equal(kbBytes, mbBytes);
});

appTest("Reset changes restores metadata but keeps compression settings", async (s) => {
  // Reset only restores metadata fields. Compression settings are per-file
  // choices and should survive it.
  await addFixtures(s, ["photo-exif.jpg"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 128 });
  await setField(s.page, "description", "Temp");
  await s.page.getByRole("button", { name: "Reset changes", exact: true }).click();
  const [r] = await records(s.page);
  assert.equal(r.compressEnabled, true);
  assert.equal(r.compressTargetUnit, "KB");
  assert.equal(r.compressTarget, 128);
});

test("the app opens with no records and no page errors", async () => {
  const s = await openApp();
  try {
    const rs = await records(s.page);
    assert.equal(rs.length, 0);
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
