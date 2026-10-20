/* JPEG marker-segment walker, used for "Strip all metadata" and for keeping
   XMP location data in step with EXIF. piexif only knows about the EXIF
   APP1 segment; this sees everything else a JPEG can carry: XMP (APP1),
   IPTC / Photoshop (APP13), comments (COM), maker blocks (APP3-APP15), and
   extra images appended after the end-of-image marker (MPF gain maps,
   depth maps), any of which can hold location or identifying data. */
(function (Datum) {
  "use strict";

  const SOS = 0xda, EOI = 0xd9, COM = 0xfe;
  const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

  function ascii(bytes, start, length) {
    return String.fromCharCode.apply(null, bytes.subarray(start, Math.min(bytes.length, start + length)));
  }

  // Splits a JPEG into its header segments (everything before the first
  // start-of-scan), the image data (first SOS through EOI), and anything
  // after EOI. Throws if the file is not a JPEG.
  function parse(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG file");
    const segments = [];
    let offset = 2;
    let hasScan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error("Corrupt JPEG: expected a marker at byte " + offset);
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset++; continue; } // fill byte
      if (marker === SOS) { hasScan = true; break; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.length) throw new Error("Corrupt JPEG: segment runs past the end of the file");
      segments.push({ marker, start: offset, end: offset + 2 + length });
      offset += 2 + length;
    }
    const scanStart = offset;
    // In entropy-coded data 0xFF is always followed by 0x00 (stuffing),
    // a restart marker (D0-D7) or a real marker, so the first FF D9 is the
    // end of the main image.
    let eoiEnd = null;
    if (hasScan) {
      for (let i = scanStart + 2; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === EOI) { eoiEnd = i + 2; break; }
      }
    }
    return { segments, scanStart, eoiEnd, hasScan };
  }

  function isXmp(bytes, seg) {
    return seg.marker === 0xe1 && ascii(bytes, seg.start + 4, XMP_HEADER.length) === XMP_HEADER;
  }

  // Segments needed to display the image exactly as before: JFIF (APP0),
  // the ICC color profile (APP2 "ICC_PROFILE"), and Adobe's color
  // transform flag (APP14). Plus every non-APP marker (tables, frame).
  function keepWhenStripping(bytes, seg) {
    const m = seg.marker;
    if (m === COM) return false;
    if (m < 0xe0 || m > 0xef) return true;
    if (m === 0xe0) return true;
    if (m === 0xe2) return ascii(bytes, seg.start + 4, 12) === "ICC_PROFILE\0";
    if (m === 0xee) return ascii(bytes, seg.start + 4, 5) === "Adobe";
    return false;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // Everything except the segments needed to display the image, and
  // nothing after the end-of-image marker.
  function stripAllMetadata(bytes) {
    const { segments, scanStart, eoiEnd } = parse(bytes);
    const parts = [bytes.subarray(0, 2)];
    for (const seg of segments) if (keepWhenStripping(bytes, seg)) parts.push(bytes.subarray(seg.start, seg.end));
    parts.push(bytes.subarray(scanStart, eoiEnd === null ? bytes.length : eoiEnd));
    return concat(parts);
  }

  // XMP packet text from the main XMP segment, or null.
  function readXmp(bytes) {
    let parsed;
    try { parsed = parse(bytes); } catch (e) { return null; }
    const seg = parsed.segments.find((s) => isXmp(bytes, s));
    if (!seg) return null;
    return new TextDecoder("utf-8").decode(bytes.subarray(seg.start + 4 + XMP_HEADER.length, seg.end));
  }

  // Replaces the main XMP segment's packet with `xmpText`, or removes the
  // segment when `xmpText` is null. Returns the bytes unchanged if there is
  // no XMP segment.
  function replaceXmp(bytes, xmpText) {
    const { segments } = parse(bytes);
    const seg = segments.find((s) => isXmp(bytes, s));
    if (!seg) return bytes;
    if (xmpText === null) return concat([bytes.subarray(0, seg.start), bytes.subarray(seg.end)]);
    const header = new TextEncoder().encode(XMP_HEADER);
    const body = new TextEncoder().encode(xmpText);
    const length = 2 + header.length + body.length;
    if (length > 0xffff) return concat([bytes.subarray(0, seg.start), bytes.subarray(seg.end)]);
    const head = new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]);
    return concat([bytes.subarray(0, seg.start), head, header, body, bytes.subarray(seg.end)]);
  }

  Datum.jpegSegments = { parse, stripAllMetadata, readXmp, replaceXmp };
})(window.Datum = window.Datum || {});
