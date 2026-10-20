// Shared harness for the browser tests: serves the repo over localhost, opens
// the app in a real browser, records page errors and network requests, and
// gives helpers that drive the app the way a user would (file inputs, tabs,
// buttons) plus helpers that inspect the results.
//
// Engine selection: BROWSER=chromium|firefox|webkit (default chromium).
// CHROMIUM_PATH optionally points at an installed Chromium binary.
//
// Each test file starts one server and one browser, shared by its tests.
// Every test still gets its own browser context (fresh storage, downloads,
// permissions), so tests stay isolated without paying for a browser launch.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES = path.join(ROOT, "tests/fixtures");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export function fixture(name) {
  return path.join(FIXTURES, name);
}

// Serves the repo root so index.html and its relative script paths work
// exactly as they do when opened from disk or a static host.
export async function startServer() {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep) || !existsSync(abs)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(abs)] || "application/octet-stream" });
    res.end(await readFile(abs));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function engineName() {
  return process.env.BROWSER || "chromium";
}

export async function launchBrowser() {
  const engines = { chromium, firefox, webkit };
  const engine = engines[engineName()];
  if (!engine) throw new Error(`Unknown BROWSER=${engineName()}`);
  const isChromium = engineName() === "chromium";
  return engine.launch({
    headless: true,
    executablePath: isChromium && process.env.CHROMIUM_PATH ? process.env.CHROMIUM_PATH : undefined,
    // Containers and CI runners often lack the user namespaces Chromium's
    // sandbox needs. The page under test is our own code, so this is fine.
    args: isChromium ? ["--no-sandbox"] : [],
  });
}

// OpenStreetMap tile hosts are the only network destination the app is
// allowed to use, and only for map tiles in the Location tab.
const TILE_HOST = /(^|\.)tile\.openstreetmap\.org$/;

export function isTileUrl(url) {
  try {
    return TILE_HOST.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// Started on first use and shut down after the file's last test. The hook is
// registered here, at import time, so it belongs to the file rather than to
// whichever test happened to start the browser.
let shared = null;
function sharedServerAndBrowser() {
  if (!shared) shared = Promise.all([startServer(), launchBrowser()]).then(([server, browser]) => ({ server, browser }));
  return shared;
}
after(async () => {
  if (!shared) return;
  const { server, browser } = await shared;
  await browser.close();
  await server.close();
});

// Opens the app in a fresh browser context. With fromDisk, the page is loaded
// from a file:// URL, the way someone who double-clicks index.html runs it.
export async function openApp({ acceptDownloads = true, fromDisk = false } = {}) {
  const { server, browser } = await sharedServerAndBrowser();
  const context = await browser.newContext({ acceptDownloads, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const session = {
    server,
    browser,
    context,
    page,
    errors: [],
    requests: [],
    async close() {
      await context.close();
    },
  };
  page.on("pageerror", (e) => session.errors.push(e.message));
  page.on("console", (m) => {
    // Failed-resource messages carry no URL, so they are judged by the
    // requestfailed listener below, which does see the URL.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) session.errors.push("console: " + m.text());
  });
  page.on("request", (r) => session.requests.push({ url: r.url(), method: r.method() }));
  page.on("requestfailed", (r) => {
    // Map tiles fail when offline; that is expected. Anything else is an error.
    if (!isTileUrl(r.url()) && !r.url().startsWith("blob:")) session.errors.push("request failed: " + r.url());
  });
  await page.goto(fromDisk ? pathToFileURL(path.join(ROOT, "index.html")).href : server.url);
  await page.waitForFunction(() => window.Datum && Datum.app && Datum.ui);
  return session;
}

// Runs fn with a fresh app session, saving a screenshot if the test fails.
export function appTest(name, fn, options) {
  test(name, options || {}, async () => {
    const session = await openApp();
    try {
      await fn(session);
    } catch (e) {
      const dir = path.join(ROOT, "test-results");
      mkdirSync(dir, { recursive: true });
      const shot = path.join(dir, name.replace(/[^a-z0-9]+/gi, "-") + ".png");
      await session.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw e;
    } finally {
      await session.close();
    }
  });
}

// Uploads fixtures through the same file input a user would use. Returns once
// the queue shows the expected number of rows.
export async function addFixtures(session, names, expectedCount) {
  const { page } = session;
  const before = await page.evaluate(() => Datum.app.getState().records.length);
  const selector = before === 0 ? "#file-input" : "#file-input-more";
  await page.setInputFiles(selector, names.map(fixture));
  const target = expectedCount === undefined ? before + names.length : expectedCount;
  // HEIC is decoded by libheif, which loads on first use and is the slowest
  // step on a busy runner, so it gets a longer wait.
  const timeout = names.some((n) => /\.(heic|heif)$/i.test(n)) ? 60000 : 30000;
  try {
    await page.waitForFunction(
      (n) => Datum.app.getState().records.length === n && document.querySelectorAll(".queue-item").length === n,
      target,
      { timeout }
    );
  } catch (e) {
    // Say what the app was doing, so a failure shows whether a decode failed
    // (an error toast, or a record with an error) or simply never finished.
    const state = await page
      .evaluate(() => ({
        records: Datum.app.getState().records.map((r) => ({ name: r.file.name, kind: r.kind, error: r.error })),
        queueItems: document.querySelectorAll(".queue-item").length,
        toast: document.getElementById("toast") ? document.getElementById("toast").textContent : null,
      }))
      .catch(() => "page unavailable");
    throw new Error(
      `Waited ${timeout}ms for ${target} record(s) from [${names.join(", ")}]. App state: ${JSON.stringify(state)}`
    );
  }
}

// Plain-data view of every record, safe to serialize out of the page.
export function records(page) {
  return page.evaluate(() =>
    Datum.app.getState().records.map((r) => ({
      name: r.file.name,
      kind: r.kind,
      supportsEdit: r.supportsEdit,
      width: r.dims.width,
      height: r.dims.height,
      error: r.error,
      notice: r.notice,
      outputName: r.outputName,
      hasPreview: !!r.previewUrl,
      fields: Object.assign({}, r.fields),
      compressEnabled: r.compressEnabled,
      compressTarget: r.compressTarget,
      compressTargetUnit: r.compressTargetUnit,
      compressMaxDimension: r.compressMaxDimension,
    }))
  );
}

// Output the app would download for record `index`, with the compression
// pipeline applied when enabled. Bytes come back as base64.
export function outputOf(page, index) {
  return page.evaluate(async (i) => {
    const toBase64 = (u8) => {
      let s = "";
      for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
      return btoa(s);
    };
    const r = Datum.app.getState().records[i];
    const result = await Datum.model.getOutputBytesAsync(r);
    if (result.failed) return { b64: null, failed: true, error: result.error, compressed: false };
    // The same name and MIME type the download buttons use.
    const { name, mime } = Datum.batch.resolveNameAndMime(r, result);
    return {
      b64: toBase64(result.bytes),
      failed: false,
      compressed: !!result.compressed,
      reachedTarget: result.reachedTarget,
      error: result.error || null,
      name,
      mime,
    };
  }, index);
}

// Decodes bytes in the browser's own image pipeline. Returns the pixel size,
// or null if the browser cannot decode them as an image.
export function decodedSize(page, base64, mime) {
  return page.evaluate(
    async ({ b64, mime }) => {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
        const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
        const size = { width: bmp.width, height: bmp.height };
        bmp.close();
        return size;
      } catch (e) {
        return null;
      }
    },
    { b64: base64, mime }
  );
}

// Reads metadata from bytes with exifr, the same library the app uses for
// JPEG and PNG. Used as the oracle for what a saved file actually contains.
export function readExif(page, base64) {
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
    const parsed = await window.exifr.parse(u8, { tiff: true, exif: true, gps: true, ifd0: true, translateValues: false, reviveValues: true });
    if (!parsed) return null;
    const out = {};
    for (const key of ["Make", "Model", "ImageDescription", "Artist", "Copyright", "latitude", "longitude", "GPSLatitude", "GPSLongitude"]) {
      if (parsed[key] !== undefined) out[key] = parsed[key];
    }
    return out;
  }, base64);
}

export function bytesOf(base64) {
  return Buffer.from(base64, "base64");
}

export function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

export function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

// ---- User-level actions. These go through the same controls a person uses,
// so the tests cover the wiring between the DOM and the model, not just the model.

export async function selectQueueItem(page, index) {
  await page.locator(".queue-item").nth(index).click();
  await page.waitForFunction((i) => Datum.app.getState().activeId === Datum.app.getState().records[i].id, index);
}

export async function setField(page, key, value) {
  await page.locator(`.editor-panel .field[data-key="${key}"] input`).first().fill(value);
}

export async function setLocationField(page, key, value) {
  await page.locator('.tab-btn[data-tab="gps"]').click();
  await page.locator(`.editor-panel .field[data-key="${key}"] input`).first().fill(String(value));
}

// Turns "reduce file size" on or off and sets its controls. Unit is applied
// before the value, matching the order a person would use it.
export async function setCompression(page, { enabled, unit, value, maxDimension } = {}) {
  const row = page.locator(".compress-row");
  const toggle = row.locator(".compress-toggle input");
  if (enabled !== undefined && (await toggle.isChecked()) !== enabled) await toggle.setChecked(enabled);
  if (unit !== undefined) await row.locator(".compress-unit-select").selectOption(unit);
  if (value !== undefined) await row.locator(".compress-target-input").fill(String(value));
  if (maxDimension !== undefined) {
    await row.locator(".compress-maxdim-input").fill(maxDimension === null ? "" : String(maxDimension));
  }
}

// Clicks something that starts a download and returns the file the browser
// saved, so tests can check the name and the bytes the user actually gets.
export async function downloadFrom(page, trigger, timeout = 30000) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout }), trigger.click()]);
  const saved = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(saved) };
}

// Waits for a toast whose text matches `pattern` (the first toast is often a
// "working on it" message, so waiting for any text would race).
export async function toastText(page, pattern = /./) {
  await page.waitForFunction(
    (source) => {
      const el = document.getElementById("toast");
      return !!el && new RegExp(source).test(el.textContent);
    },
    pattern.source,
    { timeout: 30000 }
  );
  return page.locator("#toast").textContent();
}

// Uploads a fixture under a different name, as if the person had renamed it.
export async function addRenamed(session, { as, mimeType, from }) {
  const { page } = session;
  const before = await page.evaluate(() => Datum.app.getState().records.length);
  const selector = before === 0 ? "#file-input" : "#file-input-more";
  await page.setInputFiles(selector, [{ name: as, mimeType, buffer: readFileSync(fixture(from)) }]);
  await page.waitForFunction(
    (n) => Datum.app.getState().records.length === n && document.querySelectorAll(".queue-item").length === n,
    before + 1,
    { timeout: 30000 }
  );
}
