/* Minimal HEIF/ISOBMFF box walker, used only to locate the 'Exif' item's
   raw TIFF bytes inside a HEIC/HEIF file.

   Note: the bundled exifr build's HEIC parser reads an item's iloc extent
   offset but never adds the item's base_offset field to it (it advances
   the cursor past those bytes without reading them). That's correct only
   when base_offset happens to be 0. libheif -- which is what produced our
   own HEIC test fixture, and is also what many real encoders are built
   on -- commonly writes items with a non-zero base_offset and a
   zero-relative extent, which makes exifr land on the wrong file offset
   and throw "Malformed EXIF data". We do our own minimal walk here,
   adding base_offset correctly, and hand the extracted TIFF bytes to
   piexif instead of relying on exifr for HEIC. */
(function (Datum) {
  "use strict";

  function u32(view, o) { return view.getUint32(o); }
  function u16(view, o) { return view.getUint16(o); }
  function u8(view, o) { return view.getUint8(o); }

  function getUintBytes(view, offset, size) {
    if (size === 0) return 0;
    if (size === 1) return view.getUint8(offset);
    if (size === 2) return view.getUint16(offset);
    if (size === 4) return view.getUint32(offset);
    if (size === 8) {
      const hi = view.getUint32(offset), lo = view.getUint32(offset + 4);
      return hi * 4294967296 + lo;
    }
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + view.getUint8(offset + i);
    return v;
  }

  function parseBoxHead(view, offset) {
    let length = u32(view, offset);
    const kind = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    let start = offset + 8;
    if (length === 1) {
      length = getUintBytes(view, offset + 8, 8);
      start += 8;
    }
    return { offset, length, kind, start };
  }

  function parseBoxes(view, offset, end) {
    const boxes = [];
    while (offset < end - 4) {
      const b = parseBoxHead(view, offset);
      boxes.push(b);
      if (b.length === 0) break;
      offset += b.length;
    }
    return boxes;
  }

  function readFullBoxHeader(view, box) {
    if (box.version !== undefined) return;
    const vflags = u32(view, box.start);
    box.version = vflags >>> 24;
    box.flags = vflags & 0xffffff;
    box.start += 4;
  }

  function findMeta(view, bytes) {
    let nextOffset = u32(view, 0);
    let meta = parseBoxHead(view, nextOffset);
    let guard = 0;
    while (meta.kind !== "meta") {
      nextOffset += meta.length;
      if (nextOffset >= bytes.length - 8 || meta.length === 0 || guard++ > 64) return null;
      meta = parseBoxHead(view, nextOffset);
    }
    readFullBoxHeader(view, meta);
    return meta;
  }

  // HEIF display transforms as EXIF orientation values, so they can be
  // composed and drawn with orientation.js. irot rotates anticlockwise in
  // quarter turns; imir mirrors about a vertical (0) or horizontal (1) axis.
  const IROT_TO_ORIENTATION = { 1: 8, 2: 3, 3: 6 };
  const IMIR_TO_ORIENTATION = { 0: 2, 1: 4 };

  // The primary image's stored size (ispe) and the orientation its display
  // transforms (irot, imir) add up to, applied in association order.
  // Returns null if the container can't be read.
  function readPrimaryTransforms(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const meta = findMeta(view, bytes);
      if (!meta) return null;
      const subBoxes = parseBoxes(view, meta.start, meta.offset + meta.length);
      const pitm = subBoxes.find((b) => b.kind === "pitm");
      const iprp = subBoxes.find((b) => b.kind === "iprp");
      if (!pitm || !iprp) return null;
      readFullBoxHeader(view, pitm);
      const primaryId = pitm.version === 0 ? u16(view, pitm.start) : u32(view, pitm.start);
      const iprpChildren = parseBoxes(view, iprp.start, iprp.offset + iprp.length);
      const ipco = iprpChildren.find((b) => b.kind === "ipco");
      if (!ipco) return null;
      const props = parseBoxes(view, ipco.start, ipco.offset + ipco.length);

      const indices = [];
      for (const ipma of iprpChildren.filter((b) => b.kind === "ipma")) {
        readFullBoxHeader(view, ipma);
        let offset = ipma.start;
        const entries = u32(view, offset); offset += 4;
        for (let i = 0; i < entries; i++) {
          const itemId = ipma.version < 1 ? u16(view, offset) : u32(view, offset);
          offset += ipma.version < 1 ? 2 : 4;
          const count = u8(view, offset); offset += 1;
          for (let k = 0; k < count; k++) {
            const index = (ipma.flags & 1) ? (u16(view, offset) & 0x7fff) : (u8(view, offset) & 0x7f);
            offset += (ipma.flags & 1) ? 2 : 1;
            if (itemId === primaryId) indices.push(index);
          }
        }
      }

      const result = { width: null, height: null, orientation: 1 };
      for (const index of indices) {
        const prop = props[index - 1];
        if (!prop) continue;
        if (prop.kind === "ispe") {
          result.width = u32(view, prop.start + 4);
          result.height = u32(view, prop.start + 8);
        } else if (prop.kind === "irot") {
          const o = IROT_TO_ORIENTATION[u8(view, prop.start) & 3];
          if (o) result.orientation = Datum.orientation.compose(result.orientation, o);
        } else if (prop.kind === "imir") {
          result.orientation = Datum.orientation.compose(result.orientation, IMIR_TO_ORIENTATION[u8(view, prop.start) & 1]);
        }
      }
      return result;
    } catch (e) {
      return null;
    }
  }

  // Returns raw TIFF-formatted bytes (Uint8Array, no "Exif\0\0" prefix) for
  // the file's Exif item, or null if none is found or on any parse error.
  function extractExifTiff(bytes) {
    try {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      const meta = findMeta(view, bytes);
      if (!meta) return null;
      const subBoxes = parseBoxes(view, meta.start, meta.offset + meta.length);
      const iinf = subBoxes.find((b) => b.kind === "iinf");
      const iloc = subBoxes.find((b) => b.kind === "iloc");
      if (!iinf || !iloc) return null;

      readFullBoxHeader(view, iinf);
      let offset = iinf.start;
      const count = u16(view, offset); offset += 2;
      let exifItemId = null;
      for (let i = 0; i < count; i++) {
        const infe = parseBoxHead(view, offset);
        readFullBoxHeader(view, infe);
        if (infe.version >= 2) {
          const idSize = infe.version === 3 ? 4 : 2;
          const nameOffset = infe.start + idSize + 2;
          const name = String.fromCharCode(
            view.getUint8(nameOffset), view.getUint8(nameOffset + 1),
            view.getUint8(nameOffset + 2), view.getUint8(nameOffset + 3)
          );
          if (name === "Exif") exifItemId = getUintBytes(view, infe.start, idSize);
        }
        offset += infe.length;
      }
      if (exifItemId === null) return null;

      readFullBoxHeader(view, iloc);
      offset = iloc.start;
      const b0 = u8(view, offset); offset += 1;
      const offsetSize = b0 >> 4, lengthSize = b0 & 0xF;
      const b1 = u8(view, offset); offset += 1;
      const baseOffsetSize = b1 >> 4, indexSize = b1 & 0xF;
      const itemIdSize = iloc.version === 2 ? 4 : 2;
      const constMethodSize = (iloc.version === 1 || iloc.version === 2) ? 2 : 0;
      const itemCountSize = iloc.version === 2 ? 4 : 2;
      const itemCount = getUintBytes(view, offset, itemCountSize); offset += itemCountSize;

      let foundOffset = null, foundLength = null;
      for (let i = 0; i < itemCount; i++) {
        const itemId = getUintBytes(view, offset, itemIdSize); offset += itemIdSize;
        offset += constMethodSize;
        offset += 2; // data_reference_index
        const baseOffset = getUintBytes(view, offset, baseOffsetSize); offset += baseOffsetSize;
        const extentCount = u16(view, offset); offset += 2;
        for (let e = 0; e < extentCount; e++) {
          const extOffset = getUintBytes(view, offset + indexSize, offsetSize);
          const extLength = getUintBytes(view, offset + indexSize + offsetSize, lengthSize);
          if (itemId === exifItemId && foundOffset === null) {
            foundOffset = baseOffset + extOffset;
            foundLength = extLength;
          }
          offset += indexSize + offsetSize + lengthSize;
        }
      }
      if (foundOffset === null || foundLength === null) return null;

      // Item payload: 4-byte "name size" + that many bytes (typically the
      // literal "Exif\0\0" marker) + the actual TIFF header and IFDs.
      const nameSize = u32(view, foundOffset);
      const shift = 4 + nameSize;
      const tiffStart = foundOffset + shift;
      const tiffLength = foundLength - shift;
      if (tiffLength <= 0 || tiffStart + tiffLength > bytes.length) return null;
      return bytes.slice(tiffStart, tiffStart + tiffLength);
    } catch (e) {
      return null;
    }
  }

  Datum.heicBoxReader = { extractExifTiff, readPrimaryTransforms };
})(window.Datum = window.Datum || {});
