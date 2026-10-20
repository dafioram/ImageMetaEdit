/* Minimal PNG chunk codec: parse a PNG into its chunk list, and re-serialize
   with the eXIf chunk (and optionally text/time chunks) added, replaced, or
   removed. Never touches IHDR/PLTE/IDAT/IEND or color-management chunks, so
   pixel data is always byte-identical. */
(function (Datum) {
  "use strict";

  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function isPNG(bytes) {
    if (bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return false;
    return true;
  }

  function parse(bytes) {
    if (!isPNG(bytes)) throw new Error("Not a PNG file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    const chunks = [];
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
      );
      const data = bytes.slice(offset + 8, offset + 8 + length);
      chunks.push({ type, data });
      offset += 12 + length;
      if (type === "IEND") break;
    }
    return chunks;
  }

  function buildChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcInput));
    return out;
  }

  function serialize(chunks) {
    let total = 8;
    for (const c of chunks) total += 12 + c.data.length;
    const out = new Uint8Array(total);
    out.set(SIGNATURE, 0);
    let offset = 8;
    for (const c of chunks) {
      const built = buildChunk(c.type, c.data);
      out.set(built, offset);
      offset += built.length;
    }
    return out;
  }

  // Get raw eXIf chunk payload (TIFF bytes, no "Exif\0\0" prefix), or null.
  function getExifChunkData(bytes) {
    const chunks = parse(bytes);
    const chunk = chunks.find((c) => c.type === "eXIf");
    return chunk ? chunk.data : null;
  }

  // tiffBytes: Uint8Array of raw TIFF-formatted exif data (no "Exif\0\0" prefix),
  // or null/empty to strip the eXIf chunk entirely.
  // stripTextChunks: also drop tEXt/zTXt/iTXt/tIME for a full metadata scrub.
  function writeExifChunk(bytes, tiffBytes, stripTextChunks) {
    let chunks = parse(bytes).filter((c) => c.type !== "eXIf");
    if (stripTextChunks) {
      chunks = chunks.filter((c) => !["tEXt", "zTXt", "iTXt", "tIME"].includes(c.type));
    }
    if (tiffBytes && tiffBytes.length > 0) {
      const ihdrIdx = chunks.findIndex((c) => c.type === "IHDR");
      chunks.splice(ihdrIdx + 1, 0, { type: "eXIf", data: tiffBytes });
    }
    return serialize(chunks);
  }

  // Structural check for load-time warnings. Reports the first problem
  // found, in words: a chunk running past the end of the file, a missing
  // end marker, or chunks whose checksums don't match their data.
  function inspect(bytes) {
    if (!isPNG(bytes)) return { problem: "it doesn't start with the PNG signature" };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    const badCrc = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) {
        return { problem: "it's cut off: the file ends " + (bytes.length - offset) + " bytes into a chunk header, before the end marker (IEND)" };
      }
      const length = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (offset + 12 + length > bytes.length) {
        return { problem: "it's cut off: its " + type + " chunk should hold " + length.toLocaleString("en-US") + " bytes but the file ends " + (bytes.length - offset - 8).toLocaleString("en-US") + " bytes in" };
      }
      const stored = view.getUint32(offset + 8 + length);
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== stored) badCrc.push(type);
      offset += 12 + length;
      if (type === "IEND") {
        return badCrc.length ? { problem: badCrc.length + " of its chunks (" + Array.from(new Set(badCrc)).join(", ") + ") fail their checksum, so the data may be damaged" } : {};
      }
    }
    return { problem: "it's cut off before its end marker (IEND)" };
  }

  // XMP lives in an iTXt chunk with this keyword. Layout: keyword \0,
  // compression flag, compression method, language \0, translated keyword
  // \0, then the text (UTF-8, or zlib when the flag is 1).
  const XMP_KEYWORD = "XML:com.adobe.xmp";

  function isXmpChunk(c) {
    if (c.type !== "iTXt") return false;
    const n = XMP_KEYWORD.length;
    if (c.data.length <= n || c.data[n] !== 0) return false;
    return String.fromCharCode.apply(null, c.data.subarray(0, n)) === XMP_KEYWORD;
  }

  // { text, compressed } for the XMP chunk, or null if there is none.
  // Compressed packets are reported without text.
  function getXmp(bytes) {
    const chunk = parse(bytes).find(isXmpChunk);
    if (!chunk) return null;
    const d = chunk.data;
    let i = XMP_KEYWORD.length + 1;
    const compressed = d[i] === 1;
    i += 2;
    while (i < d.length && d[i] !== 0) i++; // language tag
    i++;
    while (i < d.length && d[i] !== 0) i++; // translated keyword
    i++;
    return { text: compressed ? null : new TextDecoder("utf-8").decode(d.subarray(i)), compressed };
  }

  // Replaces the XMP chunk's text, or removes the chunk when text is null.
  function replaceXmp(bytes, text) {
    const chunks = parse(bytes);
    const idx = chunks.findIndex(isXmpChunk);
    if (idx === -1) return bytes;
    if (text === null) {
      chunks.splice(idx, 1);
    } else {
      const head = new TextEncoder().encode(XMP_KEYWORD);
      const body = new TextEncoder().encode(text);
      const data = new Uint8Array(head.length + 5 + body.length);
      data.set(head, 0);
      // keyword \0, uncompressed, method 0, empty language \0, empty translation \0
      data.set(body, head.length + 5);
      chunks[idx] = { type: "iTXt", data };
    }
    return serialize(chunks);
  }

  Datum.pngCodec = { isPNG, parse, serialize, getExifChunkData, writeExifChunk, getXmp, replaceXmp, inspect };
})(window.Datum = window.Datum || {});
