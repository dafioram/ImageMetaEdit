// Checks that need no browser: the code parses, index.html points at files
// that exist, no unexpected external URLs have crept in, the fixtures are what
// their names say they are, and the test tooling is pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, FIXTURES } from "./helpers/app.mjs";

const JS_DIR = path.join(ROOT, "js");
const html = readFileSync(path.join(ROOT, "index.html"), "utf8");

// Every absolute URL the shipped code may reference. Anything else is a
// potential network dependency the app's privacy claim does not cover.
// The w3.org entry is an XML namespace identifier, not a request.
// Map tiles are the only network use, and only from OpenStreetMap.
const ALLOWED_ORIGIN = /^(http:\/\/www\.w3\.org|https:\/\/[abc]\.tile\.openstreetmap\.org)$/;
const TILE_TEMPLATE = /^https:\/\/\{s\}\.tile\.openstreetmap\.org\//;

// Files that run in the page. README is documentation and vendor/ is
// third-party code that is already vetted and bundled.
function shippedFiles() {
  const files = [path.join(ROOT, "index.html")];
  for (const dir of ["js", "css"]) {
    for (const f of readdirSync(path.join(ROOT, dir))) files.push(path.join(ROOT, dir, f));
  }
  return files;
}

// Clickable links (e.g. the map attribution) only load when a user follows
// them, so they are not network requests and are stripped before scanning.
function withoutAnchorLinks(text) {
  return text.replace(/<a\s[^>]*href="[^"]*"[^>]*>/g, "");
}

test("every app script parses", () => {
  for (const f of readdirSync(JS_DIR).filter((f) => f.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", path.join(JS_DIR, f)], { stdio: "pipe" });
  }
});

test("every js module in js/ is loaded by index.html", () => {
  const scripts = [...html.matchAll(/<script src="(js\/[^"]+)"/g)].map((m) => m[1]);
  for (const f of readdirSync(JS_DIR).filter((f) => f.endsWith(".js"))) {
    assert.ok(scripts.includes(`js/${f}`), `js/${f} exists but index.html does not load it`);
  }
});

test("every local asset referenced by index.html exists", () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((r) => !/^(https?:|data:|#)/.test(r));
  assert.ok(refs.length > 0, "expected local script/style references");
  for (const ref of refs) {
    assert.ok(existsSync(path.join(ROOT, ref)), `index.html references missing file: ${ref}`);
  }
});

test("no third-party script or stylesheet is loaded from a CDN", () => {
  const external = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, [], "all scripts and styles must be vendored in vendor/");
});

test("shipped code only references allowed absolute URLs", () => {
  const unexpected = new Set();
  for (const file of shippedFiles()) {
    const text = withoutAnchorLinks(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
      const raw = m[0];
      if (TILE_TEMPLATE.test(raw)) continue;
      let origin;
      try {
        origin = new URL(raw).origin;
      } catch (e) {
        origin = raw;
      }
      if (!ALLOWED_ORIGIN.test(origin)) unexpected.add(`${path.relative(ROOT, file)}: ${raw}`);
    }
  }
  assert.deepEqual([...unexpected], [], "unexpected external URL(s) in shipped code");
});

// Each fixture must actually be the format its extension claims, so the
// browser tests exercise the real decoders rather than a mislabeled file.
const SIGNATURES = {
  ".jpg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ".png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  ".bmp": (b) => b.subarray(0, 2).toString("latin1") === "BM",
  ".webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  ".tiff": (b) => b.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || b.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])),
  ".heic": (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && ["heic", "heix", "mif1"].includes(b.subarray(8, 12).toString("latin1")),
  ".heif": (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && ["heic", "heix", "mif1"].includes(b.subarray(8, 12).toString("latin1")),
  ".avif": (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && b.subarray(8, 12).toString("latin1") === "avif",
  ".zip": (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
};

// Deliberately damaged fixtures that exist to test error handling. They keep
// their real extension but must not match it.
const DELIBERATELY_INVALID = new Set(["corrupt.zip"]);

test("each fixture's bytes match its file extension", () => {
  for (const f of readdirSync(FIXTURES)) {
    const ext = path.extname(f).toLowerCase();
    if (!SIGNATURES[ext] || DELIBERATELY_INVALID.has(f)) continue;
    const bytes = readFileSync(path.join(FIXTURES, f));
    assert.ok(SIGNATURES[ext](bytes), `${f} does not start with a ${ext} signature`);
  }
});

test("browser-test tooling is pinned to an exact Playwright version", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.devDependencies.playwright;
  assert.match(version, /^\d+\.\d+\.\d+$/, "playwright must be an exact version, not a range");
  assert.ok(existsSync(path.join(ROOT, "package-lock.json")), "package-lock.json must be committed");
});
