// Text fields round-trip any language: accents, Greek, Japanese, emoji.
import assert from "node:assert/strict";
import { appTest, addFixtures, records, outputOf, bytesOf, readTags, setField } from "../helpers/app.mjs";

const TEXT = "Zoë Ω 日本 📷";

for (const file of ["photo-exif.jpg", "photo-alpha-exif.png", "photo-exif.heic"]) {
  appTest(`${file}: non-ASCII text is written as UTF-8 and reads back unchanged`, async (s) => {
    await addFixtures(s, [file]);
    await setField(s.page, "artist", TEXT);
    await setField(s.page, "description", TEXT + " — caption");
    const out = await outputOf(s.page, 0);
    assert.ok(bytesOf(out.b64).includes(Buffer.from(TEXT, "utf8")), "stored as UTF-8 bytes");
    const tags = await readTags(s.page, out.b64, ["Artist", "ImageDescription"]);
    assert.equal(tags.Artist, TEXT);
    assert.equal(tags.ImageDescription, TEXT + " — caption");
  });
}

appTest("an exported file re-opened in the app shows the same text", async (s) => {
  await addFixtures(s, ["photo-exif.jpg"]);
  await setField(s.page, "copyright", "© 2026 Zoë Ω");
  const out = await outputOf(s.page, 0);
  await s.page.setInputFiles("#file-input-more", [{ name: "again.jpg", mimeType: "image/jpeg", buffer: bytesOf(out.b64) }]);
  await s.page.waitForFunction(() => Datum.app.getState().records.length === 2);
  const [, again] = await records(s.page);
  assert.equal(again.fields.copyright, "© 2026 Zoë Ω");
});

appTest("UTF-8 text in a HEIC's own EXIF is read correctly", async (s) => {
  await addFixtures(s, ["utf8-text.heic"]);
  const [r] = await records(s.page);
  assert.equal(r.fields.description, TEXT);
});
