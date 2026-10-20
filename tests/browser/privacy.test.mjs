// The app's promise: photos are never uploaded, and it works offline. These
// tests run a full session and audit every network request the page makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appTest, openApp, addFixtures, records, downloadFrom, setField, setLocationField,
  setCompression, selectQueueItem, FIXTURES, isTileUrl,
} from "../helpers/app.mjs";
import { readdirSync } from "node:fs";

// Drives the whole feature set once: upload (including a zip), edit, GPS,
// strip, compress, and both download paths.
async function runFullSession(s) {
  await addFixtures(s, ["photo-exif.jpg", "photo-alpha-exif.png", "photo-exif.heic", "archive.zip"], 7);
  await setField(s.page, "description", "Private caption");
  await setLocationField(s.page, "latitude", 40.7128);
  await setLocationField(s.page, "longitude", -74.006);
  await setCompression(s.page, { enabled: true, unit: "KB", value: 60 });
  await downloadFrom(s.page, s.page.getByRole("button", { name: "Download compressed", exact: true }));
  await selectQueueItem(s.page, 0);
  await s.page.getByRole("button", { name: "Strip all metadata", exact: true }).click();
  await downloadFrom(s.page, s.page.getByRole("button", { name: "Download all as .zip" }));
}

appTest("a full session makes no requests except to localhost and OpenStreetMap tiles", async (s) => {
  await runFullSession(s);
  const hosts = new Set(s.requests.map((r) => new URL(r.url).hostname));
  // blob: URLs are the app's own in-page previews and never leave the browser.
  const external = s.requests.filter((r) => {
    const u = new URL(r.url);
    if (u.protocol === "blob:" || u.protocol === "data:") return false;
    return u.hostname !== "127.0.0.1" && !isTileUrl(r.url);
  });
  assert.deepEqual(external.map((r) => r.url), [], `unexpected requests; hosts seen: ${[...hosts].join(", ")}`);
});

appTest("a full session never sends data in a request body", async (s) => {
  await runFullSession(s);
  const writes = s.requests.filter((r) => !["GET", "HEAD"].includes(r.method));
  assert.deepEqual(writes, [], "the app should only ever read its own files");
});

appTest("file names never appear in any request URL", async (s) => {
  await runFullSession(s);
  const names = readdirSync(FIXTURES).filter((f) => !f.startsWith("generate"));
  for (const r of s.requests) {
    for (const n of names) assert.ok(!r.url.includes(n), `request URL leaked a file name: ${r.url}`);
  }
});

test("the whole workflow works offline once the page has loaded", async () => {
  const s = await openApp();
  try {
    // Cut off everything that is not the app's own server. A plain
    // setOffline() would also block the app's local vendor files, which a
    // real offline user loads from disk.
    await s.context.route("**/*", (route) => {
      const { hostname } = new URL(route.request().url());
      return hostname === "127.0.0.1" ? route.continue() : route.abort("internetdisconnected");
    });
    await runFullSession(s);
    const rs = await records(s.page);
    assert.equal(rs.length, 7);
    assert.deepEqual(s.errors, [], "no errors while offline");
  } finally {
    await s.close();
  }
});

test("the workflow works when index.html is opened straight from disk", async () => {
  // README: "Open index.html directly in a browser (double-click it)".
  const s = await openApp({ fromDisk: true });
  try {
    await s.context.route("**/*", (route) => {
      const url = route.request().url();
      return url.startsWith("file:") ? route.continue() : route.abort("internetdisconnected");
    });
    await runFullSession(s);
    const rs = await records(s.page);
    assert.equal(rs.length, 7);
    assert.deepEqual(s.errors, [], "no errors when run from file://");
  } finally {
    await s.close();
  }
});
