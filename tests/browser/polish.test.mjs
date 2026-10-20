// Interface behaviour from the review: the open tab survives re-renders,
// toasts don't overwrite each other, lossy re-encoding is announced (and
// transparency becomes white, not black), duplicate names are told apart,
// download names always match the data, and the layout fits a phone.
import assert from "node:assert/strict";
import {
  appTest, addFixtures, records, outputOf, pixelAt, closeColor, setCompression, setLocationField,
  selectQueueItem, downloadFrom, toastText, canDecodeAvif, isJpeg,
} from "../helpers/app.mjs";

const WHITE = [255, 255, 255];

appTest("the Location tab stays open after 'Apply this location to all' and when switching files", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.jpeg"]);
  await setLocationField(s.page, "latitude", 12);
  await s.page.getByRole("button", { name: "Apply this location to all" }).click();
  assert.equal(await s.page.locator(".tab-btn.active").getAttribute("data-tab"), "gps");
  assert.ok(await s.page.locator("#map").isVisible(), "the map is showing");
  await selectQueueItem(s.page, 1);
  assert.equal(await s.page.locator(".tab-btn.active").getAttribute("data-tab"), "gps");
});

appTest("two quick messages are both shown instead of one replacing the other", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-noexif.png"]);
  await s.page.getByRole("button", { name: "Apply compression settings to all" }).click();
  await s.page.getByRole("button", { name: "Strip all metadata (every file)" }).click();
  await toastText(s.page, /Compression settings applied/);
  await toastText(s.page, /Cleared metadata on 2 files/);
});

appTest("a compressed transparent PNG gets a white background and a note saying so", async (s) => {
  await addFixtures(s, ["photo-alpha-exif.png"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 20 });
  assert.match(await s.page.locator(".compress-notes").textContent(), /Transparent areas become white/);
  const out = await outputOf(s.page, 0);
  assert.equal(out.compressed, true);
  // The fixture's left edge is fully transparent.
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 5, 150), WHITE, 12), "transparent became white, not black");
});

appTest("compressing an animated PNG notes that only the first frame is kept", async (s) => {
  await addFixtures(s, ["animated.png"]);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 0.2 });
  assert.match(await s.page.locator(".compress-notes").textContent(), /Only the first frame is kept/);
});

appTest("a transparent AVIF converts with a white background and says so", async (s, t) => {
  if (!(await canDecodeAvif(s.page))) return t.skip("this browser has no AVIF decoder");
  await addFixtures(s, ["transparent.avif"]);
  const [r] = await records(s.page);
  assert.match(r.notice, /Transparent areas become white/);
  const out = await outputOf(s.page, 0);
  assert.ok(closeColor(await pixelAt(s.page, out.b64, out.mime, 140, 60), WHITE, 12), "transparent half is white");
});

appTest("'Download compressed' only shows when the file will really be compressed", async (s) => {
  await addFixtures(s, ["photo-noexif.jpeg"]); // 13 KB
  await setCompression(s.page, { enabled: true, unit: "MB", value: 5 });
  assert.equal(await s.page.locator(".editor-footer .btn-primary").textContent(), "Download");
  assert.match(await s.page.locator(".compress-notes").textContent(), /already under the target size/);
  await setCompression(s.page, { unit: "KB", value: 5 });
  assert.equal(await s.page.locator(".editor-footer .btn-primary").textContent(), "Download compressed");
});

appTest("adding the same name twice shows the second as 'name (2)'", async (s) => {
  await addFixtures(s, ["photo-exif.jpg", "photo-exif.jpg"]);
  const names = await s.page.locator(".queue-item .name").allTextContents();
  assert.deepEqual(names, ["photo-exif.jpg", "photo-exif (2).jpg"]);
});

appTest("a typed name with the wrong extension is corrected at download, with a note", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await s.page.locator(".filename").fill("holiday.png");
  const { name, bytes } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "holiday.jpg");
  assert.ok(isJpeg(bytes));
  assert.match(await toastText(s.page, /Saved as/), /Saved as holiday\.jpg: the file is a JPEG, so the \.png ending was corrected/);
});

appTest("a typed name without an extension gets one", async (s) => {
  await addFixtures(s, ["photo-noexif.png"]);
  await s.page.locator(".filename").fill("diagram");
  const { name } = await downloadFrom(s.page, s.page.getByRole("button", { name: "Download", exact: true }));
  assert.equal(name, "diagram.png");
});

appTest("nothing is wider than a 375px phone screen, even with several files queued", async (s) => {
  await s.page.setViewportSize({ width: 375, height: 812 });
  await addFixtures(s, ["photo-exif.jpg", "photo-alpha-exif.png", "photo-noexif.jpeg"]);
  await setCompression(s.page, { enabled: true });
  const { scrollW, clientW } = await s.page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  assert.ok(scrollW <= clientW, `page is ${scrollW}px wide on a ${clientW}px screen`);
});
