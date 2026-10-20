/* Writes new EXIF (and XMP) into a HEIC or AVIF file without re-encoding
   the image, so it keeps its format and quality.

   HEIF files list every item's bytes by absolute file offset in the 'iloc'
   box. Growing or shrinking the metadata in place would shift every offset
   after it, so instead the new payload is appended in a new 'mdat' box at
   the end of the file and only that item's iloc entry is repointed: its
   fields keep their size, so nothing else moves. The old payload is then
   overwritten with zeros, so the previous metadata (an old GPS position)
   does not remain in the file.

   This is done only when it is plainly safe: the item exists, is stored as
   one piece at a file offset, its iloc fields can hold the new offset and
   length, and no other item shares its bytes. Otherwise the reason is
   reported and the caller converts to JPEG instead. */
(function (Datum) {
  "use strict";

  const EMPTY_TIFF = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const EMPTY_XMP = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/><?xpacket end="w"?>';

  function unsupported(reason) {
    const e = new Error(reason);
    e.userFacing = true;
    e.unsupported = true;
    return e;
  }

  function readUint(view, offset, size) {
    if (size === 0) return 0;
    if (size === 4) return view.getUint32(offset);
    if (size === 8) return view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4);
    if (size === 2) return view.getUint16(offset);
    throw unsupported("its item table uses a field size this app doesn't handle (" + size + " bytes)");
  }

  function writeUint(view, offset, size, value) {
    if (size === 4) {
      if (value > 0xffffffff) throw unsupported("the new metadata would sit beyond what its item table can address");
      view.setUint32(offset, value);
    } else if (size === 8) {
      view.setUint32(offset, Math.floor(value / 4294967296));
      view.setUint32(offset + 4, value >>> 0);
    } else {
      throw unsupported("its item table can't hold a new position for the metadata");
    }
  }

  function boxes(view, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = view.getUint32(o);
      const kind = String.fromCharCode(view.getUint8(o + 4), view.getUint8(o + 5), view.getUint8(o + 6), view.getUint8(o + 7));
      let header = 8;
      if (size === 1) { size = readUint(view, o + 8, 8); header = 16; }
      if (size === 0) size = end - o;
      if (size < header) break;
      out.push({ kind, start: o, end: o + size, body: o + header });
      o += size;
    }
    return out;
  }

  function cString(bytes, start, end) {
    let i = start;
    while (i < end && bytes[i] !== 0) i++;
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(start, i)), next: i + 1 };
  }

  // Item IDs for the EXIF and XMP items, and every item's location with the
  // byte positions of its iloc fields, so they can be patched in place.
  function parse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const meta = boxes(view, 0, bytes.length).find((b) => b.kind === "meta");
    if (!meta) throw unsupported("it has no metadata header");
    const inside = boxes(view, meta.body + 4, meta.end);
    const iinf = inside.find((b) => b.kind === "iinf");
    const iloc = inside.find((b) => b.kind === "iloc");
    if (!iinf || !iloc) throw unsupported("it has no item table");

    let exifId = null, xmpId = null;
    const iinfVersion = bytes[iinf.body];
    const entriesStart = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
    for (const infe of boxes(view, entriesStart, iinf.end)) {
      if (infe.kind !== "infe") continue;
      const version = bytes[infe.body];
      if (version < 2) continue;
      let o = infe.body + 4;
      const id = version === 2 ? view.getUint16(o) : view.getUint32(o);
      o += (version === 2 ? 2 : 4) + 2;
      const type = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
      o += 4;
      const name = cString(bytes, o, infe.end);
      if (type === "Exif") exifId = id;
      if (type === "mime" && cString(bytes, name.next, infe.end).text === "application/rdf+xml") xmpId = id;
    }

    const version = bytes[iloc.body];
    let o = iloc.body + 4;
    const offsetSize = bytes[o] >> 4, lengthSize = bytes[o] & 15;
    const baseOffsetSize = bytes[o + 1] >> 4;
    const indexSize = version === 1 || version === 2 ? bytes[o + 1] & 15 : 0;
    o += 2;
    const count = version < 2 ? view.getUint16(o) : view.getUint32(o);
    o += version < 2 ? 2 : 4;
    const items = [];
    for (let i = 0; i < count; i++) {
      const item = { id: version < 2 ? view.getUint16(o) : view.getUint32(o) };
      o += version < 2 ? 2 : 4;
      item.constructionMethod = version === 1 || version === 2 ? view.getUint16(o) & 15 : 0;
      if (version === 1 || version === 2) o += 2;
      item.dataReferenceIndex = view.getUint16(o);
      o += 2;
      item.baseOffsetPos = o;
      item.baseOffset = readUint(view, o, baseOffsetSize);
      o += baseOffsetSize;
      const extentCount = view.getUint16(o);
      o += 2;
      item.extents = [];
      for (let e = 0; e < extentCount; e++) {
        o += indexSize;
        const ext = { offsetPos: o, offset: readUint(view, o, offsetSize) };
        o += offsetSize;
        ext.lengthPos = o;
        ext.length = readUint(view, o, lengthSize);
        o += lengthSize;
        item.extents.push(ext);
      }
      items.push(item);
    }
    return { view, exifId, xmpId, items, sizes: { offsetSize, lengthSize, baseOffsetSize } };
  }

  // Throws with the reason if this item's bytes can't be safely relocated.
  function checkRelocatable(parsed, id, label) {
    const item = parsed.items.find((it) => it.id === id);
    if (!item) throw unsupported("its " + label + " item has no location");
    if (item.constructionMethod !== 0) throw unsupported("its " + label + " is stored inside the header rather than as file data");
    if (item.dataReferenceIndex !== 0) throw unsupported("its " + label + " refers to data outside the file");
    if (item.extents.length !== 1) throw unsupported("its " + label + " is split into " + item.extents.length + " pieces");
    const { offsetSize, lengthSize, baseOffsetSize } = parsed.sizes;
    if (lengthSize !== 4 && lengthSize !== 8) throw unsupported("its item table has no room for a new " + label + " length");
    if (offsetSize === 0 && baseOffsetSize === 0) throw unsupported("its item table has no room for a new " + label + " position");
    const start = item.baseOffset + item.extents[0].offset, end = start + item.extents[0].length;
    for (const other of parsed.items) {
      if (other === item) continue;
      for (const ext of other.extents) {
        const s = other.baseOffset + ext.offset, e = s + ext.length;
        if (s < end && start < e) throw unsupported("its " + label + " shares bytes with other data");
      }
    }
    return { item, start, end };
  }

  // { ok: true } if the file's EXIF can be rewritten in place, else
  // { ok: false, reason }.
  function canRewrite(bytes) {
    try {
      const parsed = parse(bytes);
      if (parsed.exifId === null) return { ok: false, reason: "it has no EXIF block to update, and adding one would mean moving the image data" };
      checkRelocatable(parsed, parsed.exifId, "EXIF");
      if (parsed.xmpId !== null) checkRelocatable(parsed, parsed.xmpId, "XMP");
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.unsupported ? e.message : "its structure couldn't be read" };
    }
  }

  function payloadOf(bytes, parsed, id) {
    const { start, end } = checkRelocatable(parsed, id, "metadata");
    return bytes.subarray(start, end);
  }

  // The current XMP packet text, or null.
  function readXmp(bytes) {
    try {
      const parsed = parse(bytes);
      if (parsed.xmpId === null) return null;
      return new TextDecoder("utf-8").decode(payloadOf(bytes, parsed, parsed.xmpId)).replace(/\u0000+$/, "");
    } catch (e) {
      return null;
    }
  }

  // Returns new file bytes with the EXIF item's TIFF replaced by `tiff`
  // (null: an empty TIFF) and, when `xmp` is a string, the XMP item's packet
  // replaced by it (null: an empty packet; undefined: left alone).
  function rewrite(bytes, { tiff, xmp }) {
    let out = bytes;
    const parsed = parse(out);
    if (parsed.exifId === null) throw unsupported("it has no EXIF block to update");
    // EXIF payload: 4-byte offset N, then N bytes (usually "Exif\0\0"), then TIFF.
    const oldExif = payloadOf(out, parsed, parsed.exifId);
    const prefixLength = Math.min(new DataView(oldExif.buffer, oldExif.byteOffset).getUint32(0), Math.max(0, oldExif.length - 4));
    const newTiff = tiff || EMPTY_TIFF;
    const exifPayload = new Uint8Array(4 + prefixLength + newTiff.length);
    exifPayload.set(oldExif.subarray(0, 4 + prefixLength), 0);
    exifPayload.set(newTiff, 4 + prefixLength);
    out = relocate(out, parsed.exifId, exifPayload);
    if (xmp !== undefined && parsed.xmpId !== null) {
      out = relocate(out, parsed.xmpId, new TextEncoder().encode(xmp === null ? EMPTY_XMP : xmp));
    }
    return out;
  }

  // Appends `payload` in a new mdat box, points the item at it, and zeroes
  // the item's old bytes.
  function relocate(bytes, id, payload) {
    const parsed = parse(bytes);
    const { item, start, end } = checkRelocatable(parsed, id, "metadata");
    const out = new Uint8Array(bytes.length + 8 + payload.length);
    out.set(bytes, 0);
    out.fill(0, start, end);
    const view = new DataView(out.buffer);
    view.setUint32(bytes.length, 8 + payload.length);
    out.set([0x6d, 0x64, 0x61, 0x74], bytes.length + 4); // "mdat"
    out.set(payload, bytes.length + 8);
    const newStart = bytes.length + 8;
    const { offsetSize, lengthSize, baseOffsetSize } = parsed.sizes;
    const ext = item.extents[0];
    if (offsetSize > 0) {
      if (newStart < item.baseOffset) throw unsupported("its item table can't point at the new metadata");
      writeUint(view, ext.offsetPos, offsetSize, newStart - item.baseOffset);
    } else {
      writeUint(view, item.baseOffsetPos, baseOffsetSize, newStart);
    }
    writeUint(view, ext.lengthPos, lengthSize, payload.length);
    return out;
  }

  Datum.heifWriter = { canRewrite, rewrite, readXmp, EMPTY_TIFF };
})(window.Datum = window.Datum || {});
