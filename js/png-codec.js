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

  Datum.pngCodec = { isPNG, parse, serialize, getExifChunkData, writeExifChunk };
})(window.Datum = window.Datum || {});
