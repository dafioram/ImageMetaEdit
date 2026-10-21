/* Minimal WebP container codec. A WebP file is a RIFF list of chunks, each
   a four-letter type, a little-endian length and the data (padded to an
   even length). Only the RIFF header's total size refers to anything else,
   so metadata chunks can be added, replaced or removed without touching the
   image data, which stays byte-identical.

   Files with metadata need the extended header (VP8X), which says which
   extras are present and gives the canvas size. A plain file (a lone VP8 or
   VP8L chunk) gets one, with the size and transparency read from the image
   data's own header. */
(function (Datum) {
  "use strict";

  const FLAG = { icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 };
  const IMAGE_TYPES = ["VP8 ", "VP8L", "ANIM"];

  function fourcc(bytes, o) {
    return String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  }

  function isWebp(bytes) {
    return bytes.length >= 12 && fourcc(bytes, 0) === "RIFF" && fourcc(bytes, 8) === "WEBP";
  }

  // Chunks in file order, as { type, data } with data a view into `bytes`.
  // Throws, in words, on a file whose chunks run past its end.
  function parse(bytes) {
    if (!isWebp(bytes)) throw new Error("it doesn't start with the WebP signature");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
    const chunks = [];
    let o = 12;
    while (o + 8 <= end) {
      const type = fourcc(bytes, o);
      const length = view.getUint32(o + 4, true);
      if (o + 8 + length > bytes.length) {
        throw new Error("it's cut off: its " + type.trim() + " chunk should hold " + length.toLocaleString("en-US") +
          " bytes but the file ends " + (bytes.length - o - 8).toLocaleString("en-US") + " bytes in");
      }
      chunks.push({ type, data: bytes.subarray(o + 8, o + 8 + length) });
      o += 8 + length + (length & 1);
    }
    return chunks;
  }

  function serialize(chunks) {
    let size = 4;
    for (const c of chunks) size += 8 + c.data.length + (c.data.length & 1);
    const out = new Uint8Array(8 + size);
    const view = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, size, true);
    out.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    let o = 12;
    for (const c of chunks) {
      for (let k = 0; k < 4; k++) out[o + k] = c.type.charCodeAt(k);
      view.setUint32(o + 4, c.data.length, true);
      out.set(c.data, o + 8);
      o += 8 + c.data.length + (c.data.length & 1);
    }
    return out;
  }

  // Size, transparency, animation and lossless-ness, from the extended
  // header when there is one, else from the image data's own header.
  function info(bytes) {
    const chunks = parse(bytes);
    const types = chunks.map((c) => c.type);
    const vp8x = chunks.find((c) => c.type === "VP8X");
    const vp8l = chunks.find((c) => c.type === "VP8L");
    const vp8 = chunks.find((c) => c.type === "VP8 ");
    const result = { width: null, height: null, hasAlpha: false, animated: types.includes("ANIM"), lossless: !!vp8l && !vp8 };
    if (vp8x && vp8x.data.length >= 10) {
      const d = vp8x.data;
      result.width = 1 + (d[4] | (d[5] << 8) | (d[6] << 16));
      result.height = 1 + (d[7] | (d[8] << 8) | (d[9] << 16));
      result.hasAlpha = !!(d[0] & FLAG.alpha);
      result.animated = result.animated || !!(d[0] & FLAG.animation);
    } else if (vp8l && vp8l.data.length >= 5 && vp8l.data[0] === 0x2f) {
      const d = vp8l.data;
      const bits = (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
      result.width = (bits & 0x3fff) + 1;
      result.height = ((bits >>> 14) & 0x3fff) + 1;
      result.hasAlpha = !!((bits >>> 28) & 1);
    } else if (vp8 && vp8.data.length >= 10 && vp8.data[3] === 0x9d && vp8.data[4] === 0x01 && vp8.data[5] === 0x2a) {
      const d = vp8.data;
      result.width = (d[6] | (d[7] << 8)) & 0x3fff;
      result.height = (d[8] | (d[9] << 8)) & 0x3fff;
    }
    return result;
  }

  // The EXIF chunk's TIFF data, or null. Some writers put the JPEG-style
  // "Exif\0\0" in front, which the WebP spec doesn't; both are accepted.
  function getExif(bytes) {
    const chunk = parse(bytes).find((c) => c.type === "EXIF");
    if (!chunk) return null;
    const d = chunk.data;
    return fourcc(d, 0) === "Exif" && d[4] === 0 && d[5] === 0 ? d.subarray(6) : d;
  }

  function getXmp(bytes) {
    const chunk = parse(bytes).find((c) => c.type === "XMP ");
    return chunk ? new TextDecoder("utf-8").decode(chunk.data).replace(/\u0000+$/, "") : null;
  }

  // New file bytes with the EXIF chunk set to `tiff` (null removes it) and,
  // when `xmp` is given, the XMP chunk set to it (null removes it;
  // undefined leaves it alone). The extended header is added or updated to
  // match.
  function write(bytes, { tiff, xmp }) {
    const chunks = parse(bytes);
    const meta = { exif: tiff && tiff.length ? tiff : null, xmp: null };
    const oldXmp = chunks.find((c) => c.type === "XMP ");
    if (xmp === undefined) meta.xmp = oldXmp ? oldXmp.data : null;
    else if (xmp !== null) meta.xmp = new TextEncoder().encode(xmp);
    let rest = chunks.filter((c) => c.type !== "EXIF" && c.type !== "XMP ");

    let vp8x = rest.find((c) => c.type === "VP8X");
    if (!vp8x && (meta.exif || meta.xmp)) {
      const i = info(bytes);
      if (!i.width || !i.height) throw new Error("its image header couldn't be read, so metadata can't be added");
      const d = new Uint8Array(10);
      if (i.hasAlpha) d[0] |= FLAG.alpha;
      d[4] = (i.width - 1) & 0xff; d[5] = ((i.width - 1) >> 8) & 0xff; d[6] = ((i.width - 1) >> 16) & 0xff;
      d[7] = (i.height - 1) & 0xff; d[8] = ((i.height - 1) >> 8) & 0xff; d[9] = ((i.height - 1) >> 16) & 0xff;
      vp8x = { type: "VP8X", data: d };
      rest = [vp8x].concat(rest);
    }
    if (vp8x) {
      const d = new Uint8Array(vp8x.data);
      d[0] = (d[0] & ~(FLAG.exif | FLAG.xmp)) | (meta.exif ? FLAG.exif : 0) | (meta.xmp ? FLAG.xmp : 0);
      vp8x.data = d;
    }
    // The spec puts EXIF, then XMP, after the image data.
    if (meta.exif) rest.push({ type: "EXIF", data: meta.exif });
    if (meta.xmp) rest.push({ type: "XMP ", data: meta.xmp });
    return serialize(rest);
  }

  // Structural check for load-time warnings: the first problem, in words.
  function inspect(bytes) {
    let chunks;
    try {
      chunks = parse(bytes);
    } catch (e) {
      return { problem: e.message };
    }
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
    if (declared > bytes.length) {
      return { problem: "it's cut off: its header says " + declared.toLocaleString("en-US") + " bytes but the file has " + bytes.length.toLocaleString("en-US") };
    }
    if (!chunks.some((c) => IMAGE_TYPES.includes(c.type))) return { problem: "it has no image data" };
    return {};
  }

  Datum.webpCodec = { isWebp, parse, info, getExif, getXmp, write, inspect };
})(window.Datum = window.Datum || {});
