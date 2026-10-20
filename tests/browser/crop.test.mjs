// Crop, from the editor preview. The quadrant fixtures display as red
// (top-left), green (top-right), blue (bottom-left), yellow (bottom-right),
// so a crop's pixels show whether the right region, the right way up, was
// kept. Crop rectangles are in pixels of the image as displayed.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, bytesOf, decodedSize, readTags, pixelAt, closeColor, isJpeg, isPng,
  setCompression, thumbnailSize,
} from "../helpers/app.mjs";

const RED = [220, 30, 30], GREEN = [30, 200, 30], YELLOW = [230, 220, 30];

async function openCrop(page) {
  await page.locator(".crop-open").click();
  await page.waitForSelector(".crop-overlay");
  // The picture has to be on screen before it can be dragged on.
  await page.waitForFunction(() => {
    const img = document.querySelector(".crop-image");
    return img && img.complete && img.naturalWidth > 0 && img.clientWidth > 0;
  });
}

// Sets the crop through the dialog's number boxes, then applies it. Width
// and height go first, since X and Y are kept inside what's left.
async function cropTo(page, rect, aspect) {
  await openCrop(page);
  if (aspect) await page.locator(".crop-aspect").selectOption(aspect);
  for (const key of ["width", "height", "x", "y"]) {
    if (rect[key] === undefined) continue;
    await page.locator(".crop-" + key).fill(String(rect[key]));
    await page.locator(".crop-" + key).press("Tab");
  }
  await page.getByRole("button", { name: "Apply crop" }).click();
  await page.waitForFunction(() => !document.querySelector(".crop-overlay"));
}

appTest("cropping a rotated JPEG keeps the chosen region, upright, with its metadata", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  await cropTo(s.page, { x: 0, y: 0, width: 150, height: 100 });
  assert.deepEqual((await records(s.page))[0].fields.make, "Datum Test Cam");
  const out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 150, height: 100 });
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 75, 50), RED), "the top-left quadrant is red");
  const tags = await readTags(s.page, out.b64, ["Orientation", "Make", "PixelXDimension"]);
  assert.ok(!tags.Orientation || tags.Orientation === 1, "cropped pixels are stored upright");
  assert.equal(tags.Make, "Datum Test Cam");
});

appTest("a cropped PNG stays a lossless PNG with exact colours and its EXIF", async (s) => {
  await addFixtures(s, ["quadrants.png"]);
  await cropTo(s.page, { x: 150, y: 100, width: 150, height: 100 });
  const out = await outputOf(s.page, 0);
  assert.equal(out.mime, "image/png");
  assert.ok(isPng(bytesOf(out.b64)));
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 150, height: 100 });
  assert.deepEqual((await pixelAt(s.page, out.b64, out.mime, 75, 50)).slice(0, 3), YELLOW, "lossless: exactly yellow");
  assert.equal((await readTags(s.page, out.b64, ["Make"])).Make, "Datum Test Cam");
});

appTest("cropping a transparent PNG keeps its transparency", async (s) => {
  await addFixtures(s, ["photo-alpha-exif.png"]);
  await cropTo(s.page, { x: 0, y: 0, width: 100, height: 100 });
  const out = await outputOf(s.page, 0);
  assert.equal((await pixelAt(s.page, out.b64, out.mime, 5, 50))[3], 0, "the transparent edge stays transparent");
});

appTest("cropping a rotated HEIC keeps the chosen region, upright", async (s) => {
  await addFixtures(s, ["photo-rotated.heic"]);
  await cropTo(s.page, { x: 150, y: 0, width: 150, height: 100 });
  const out = await outputOf(s.page, 0);
  assert.ok(isJpeg(bytesOf(out.b64)));
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 150, height: 100 });
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 75, 50), GREEN), "the top-right quadrant is green");
});

appTest("crop and compression together produce the crop at the target size", async (s) => {
  await addFixtures(s, ["photo-thumbnail.jpg"]);
  await cropTo(s.page, { x: 300, y: 225, width: 600, height: 450 });
  await setCompression(s.page, { enabled: true, unit: "KB", value: 30 });
  assert.equal(await s.page.locator(".editor-footer .btn-primary").textContent(), "Download compressed");
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 600, height: 450 });
  assert.ok(bytesOf(out.b64).length <= 30 * 1024);
  assert.equal(await thumbnailSize(s.page, out.b64), 0, "the uncropped thumbnail must not survive");
});

appTest("a crop combined with a changed orientation crops what's shown, then turns it", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  await s.page.locator('.field[data-key="orientation"] select').selectOption("1");
  await cropTo(s.page, { x: 0, y: 0, width: 150, height: 100 });
  const out = await outputOf(s.page, 0);
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 100, height: 150 });
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 50, 75), RED));
});

appTest("an aspect preset keeps the box at that shape", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await cropTo(s.page, { width: 120 }, "1:1");
  const [r] = await records(s.page);
  assert.equal(r.crop.width, 120);
  assert.equal(r.crop.height, 120);
});

appTest("the preview, facts, counters and viewer show the crop", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await cropTo(s.page, { x: 300, y: 225, width: 600, height: 450 });
  assert.match(await s.page.locator(".facts").textContent(), /600×450 \(cropped from 1200×900\)/);
  assert.equal(await s.page.locator(".queue-item .status").textContent(), "1 change");
  assert.equal(await s.page.locator("#diff-count").textContent(), "Cropped");
  const size = await s.page.locator(".preview-frame img").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  assert.ok(Math.abs(size[0] / size[1] - 600 / 450) < 0.01, "the preview is the cropped area");
  await s.page.locator(".preview-frame").click();
  const viewerSrc = await s.page.locator(".open img").first().getAttribute("src");
  assert.equal(viewerSrc, await s.page.evaluate(() => Datum.app.getState().records[0].cropPreviewUrl));
});

appTest("Remove crop and Reset changes both bring back the full image", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await cropTo(s.page, { x: 0, y: 0, width: 400, height: 300 });
  await s.page.locator(".crop-remove").click();
  assert.equal((await records(s.page))[0].crop, null);
  let out = await outputOf(s.page, 0);
  assert.deepEqual(await decodedSize(s.page, out.b64, out.mime), { width: 1200, height: 900 });
  await cropTo(s.page, { x: 0, y: 0, width: 400, height: 300 });
  await s.page.getByRole("button", { name: "Reset changes", exact: true }).click();
  assert.equal((await records(s.page))[0].crop, null);
});

appTest("strip all metadata and crop together: cropped pixels, no metadata", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg"]);
  await cropTo(s.page, { x: 0, y: 0, width: 150, height: 100 });
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  const out = await outputOf(s.page, 0);
  assert.deepEqual(await readTags(s.page, out.b64, ["Make", "Orientation"]), {});
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 75, 50), RED), "still upright without a tag");
});

appTest("Escape closes the dialog without changing anything", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await openCrop(s.page);
  await s.page.locator(".crop-width").fill("300");
  await s.page.locator(".crop-width").press("Tab");
  await s.page.keyboard.press("Escape");
  await s.page.waitForFunction(() => !document.querySelector(".crop-overlay"));
  assert.equal((await records(s.page))[0].crop, null);
});

appTest("dragging on the image draws the crop", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await openCrop(s.page);
  const b = await s.page.locator(".crop-image").boundingBox();
  await s.page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.25);
  await s.page.mouse.down();
  await s.page.mouse.move(b.x + b.width * 0.75, b.y + b.height * 0.75, { steps: 6 });
  await s.page.mouse.up();
  await s.page.getByRole("button", { name: "Apply crop" }).click();
  // Applying finishes once the cropped preview is made.
  await s.page.waitForFunction(() => !document.querySelector(".crop-overlay"));
  const { crop } = (await records(s.page))[0];
  for (const [key, expected] of [["x", 300], ["y", 225], ["width", 600], ["height", 450]]) {
    assert.ok(Math.abs(crop[key] - expected) <= 4, `${key} ${crop[key]} should be about ${expected}`);
  }
});

appTest("view-only files have no crop button", async (s) => {
  await addFixtures(s, ["sample.gif"]);
  assert.equal(await s.page.locator(".crop-open").count(), 0);
});

appTest("arrow keys nudge the crop box; Shift moves it ten pixels at a time", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await openCrop(s.page);
  // Smaller than the image both ways, so it has room to move.
  for (const [key, value] of [["width", "400"], ["height", "300"]]) {
    await s.page.locator(".crop-" + key).fill(value);
    await s.page.locator(".crop-" + key).press("Tab");
  }
  await s.page.locator(".crop-box").focus();
  await s.page.keyboard.press("Shift+ArrowRight");
  await s.page.keyboard.press("ArrowRight");
  await s.page.keyboard.press("ArrowDown");
  assert.equal(await s.page.locator(".crop-x").inputValue(), "11");
  assert.equal(await s.page.locator(".crop-y").inputValue(), "1");
});

appTest("'Download all as .zip' contains the cropped version", async (s) => {
  await addFixtures(s, ["photo-orient6.jpg", "quadrants.png"]);
  await cropTo(s.page, { x: 0, y: 0, width: 150, height: 100 });
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const { ROOT, downloadFrom } = await import("../helpers/app.mjs");
  const JSZip = createRequire(import.meta.url)(path.join(ROOT, "vendor/jszip.min.js"));
  const { bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
  const zip = await JSZip.loadAsync(bytes);
  const entry = Buffer.from(await zip.file("photo-orient6.jpg").async("uint8array"));
  assert.deepEqual(await decodedSize(s.page, entry.toString("base64"), "image/jpeg"), { width: 150, height: 100 });
});
