/* Per-file state. Each FileRecord tracks the original bytes, the parsed
   metadata (both a "strict" numeric-coded version used to prefill editable
   fields, and a "pretty" translated version used for the raw dump tab),
   the current editable field values, and enough bookkeeping to diff against
   the original and produce output bytes on demand. */
(function (Datum) {
  "use strict";

  let idCounter = 0;

  const EXIFR_BASE = {
    tiff: true, ifd0: true, ifd1: false, exif: true, gps: true, interop: false,
    iptc: false, xmp: false, icc: false, jfif: false, makerNote: false, userComment: false,
    ihdr: true, sanitize: true, mergeOutput: true, silentErrors: true,
    reviveValues: true, translateKeys: true,
  };
  const EXIFR_OPTS_STRICT = Object.assign({}, EXIFR_BASE, { translateValues: false });
  const EXIFR_OPTS_PRETTY = Object.assign({}, EXIFR_BASE, { translateValues: true });

  function detectKind(file) {
    const name = (file.name || "").toLowerCase();
    const type = (file.type || "").toLowerCase();
    if (type === "image/jpeg" || type === "image/jpg" || /\.(jpe?g)$/.test(name)) return "jpeg";
    if (type === "image/png" || /\.png$/.test(name)) return "png";
    if (type === "image/heic" || type === "image/heif" || /\.(heic|heif)$/.test(name)) return "heic";
    return "other";
  }

  // Formats identified from the first bytes of the file. The name and MIME
  // type are only hints; these decide what the file really is. `exts` lists
  // the extensions that match this content, the first being the one to use.
  const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];
  function ascii(bytes, start, end) {
    return String.fromCharCode.apply(null, bytes.subarray(start, end));
  }
  const SIGNATURES = [
    { kind: "jpeg", label: "JPEG", exts: [".jpg", ".jpeg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { kind: "png", label: "PNG", exts: [".png"], test: (b) => ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n" },
    { kind: "heic", label: "HEIC", exts: [".heic", ".heif"], test: (b) => ascii(b, 4, 8) === "ftyp" && HEIF_BRANDS.includes(ascii(b, 8, 12)) },
    { kind: "other", label: "GIF", exts: [".gif"], test: (b) => ascii(b, 0, 4) === "GIF8" },
    { kind: "other", label: "BMP", exts: [".bmp"], test: (b) => ascii(b, 0, 2) === "BM" },
    { kind: "other", label: "WebP", exts: [".webp"], test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
    { kind: "other", label: "TIFF", exts: [".tif", ".tiff"], test: (b) => ascii(b, 0, 4) === "II*\0" || ascii(b, 0, 4) === "MM\0*" },
    { kind: "other", label: "AVIF", exts: [".avif"], test: (b) => ascii(b, 4, 8) === "ftyp" && ascii(b, 8, 12) === "avif" },
  ];

  // Returns the SIGNATURES entry the bytes match, or null if none match.
  function sniffFormat(bytes) {
    return SIGNATURES.find((s) => s.test(bytes)) || null;
  }

  function withExtension(name, ext) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    return base + ext;
  }

  // Errors come back as values rather than being thrown, so the caller can
  // refuse the download with a message.
  function errorMessage(e) {
    return (e && e.message) || String(e);
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const round6 = (n) => Math.round(n * 1e6) / 1e6;

  function fieldsFromParsed(parsed) {
    parsed = parsed || {};
    const fields = {};
    fields.make = parsed.Make || "";
    fields.model = parsed.Model || "";
    fields.lens = parsed.LensModel || "";
    fields.fNumber = (typeof parsed.FNumber === "number") ? round2(parsed.FNumber) : "";
    fields.exposureTime = (typeof parsed.ExposureTime === "number") ? Datum.fieldCodec.formatExposureTime(parsed.ExposureTime) : "";
    fields.iso = (parsed.ISO !== undefined && parsed.ISO !== null) ? parsed.ISO : "";
    fields.focalLength = (typeof parsed.FocalLength === "number") ? round2(parsed.FocalLength) : "";
    fields.description = parsed.ImageDescription || "";
    fields.artist = parsed.Artist || "";
    fields.copyright = parsed.Copyright || "";
    fields.orientation = (parsed.Orientation !== undefined && parsed.Orientation !== null) ? Number(parsed.Orientation) : 1;

    const dateSrc = parsed.DateTimeOriginal || parsed.CreateDate || parsed.ModifyDate;
    fields.dateTaken = dateSrc ? Datum.fieldCodec.exifDateToInput(dateSrc) : "";

    if (typeof parsed.latitude === "number" && typeof parsed.longitude === "number") {
      fields.latitude = round6(parsed.latitude);
      fields.longitude = round6(parsed.longitude);
      let altRef = 0;
      if (parsed.GPSAltitudeRef !== undefined && parsed.GPSAltitudeRef !== null) {
        altRef = (typeof parsed.GPSAltitudeRef.length === "number") ? parsed.GPSAltitudeRef[0] : parsed.GPSAltitudeRef;
      }
      fields.altitude = (typeof parsed.GPSAltitude === "number") ? round2(altRef === 1 ? -parsed.GPSAltitude : parsed.GPSAltitude) : "";
    } else {
      fields.latitude = "";
      fields.longitude = "";
      fields.altitude = "";
    }
    return fields;
  }

  function loadDims(record, file) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        record.dims.width = img.naturalWidth;
        record.dims.height = img.naturalHeight;
        URL.revokeObjectURL(img.src);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = URL.createObjectURL(file);
    });
  }

  // Units for the "reduce file size" target. `default` is the starting value
  // in that unit (5 MB either way), `precision` is how many decimals the
  // UI keeps when converting between units.
  const COMPRESS_UNITS = {
    MB: { bytes: 1024 * 1024, default: 5, precision: 2, step: "0.1", min: "0.1" },
    KB: { bytes: 1024, default: 5120, precision: 0, step: "1", min: "1" },
  };

  function compressUnit(record) {
    return COMPRESS_UNITS[record.compressTargetUnit] || COMPRESS_UNITS.MB;
  }

  function targetBytesFor(record) {
    const unit = compressUnit(record);
    const v = record.compressTarget > 0 ? record.compressTarget : unit.default;
    return Math.round(v * unit.bytes);
  }

  async function createFileRecord(file) {
    const id = "f" + (++idCounter) + "_" + Date.now().toString(36);
    const bytes = await Datum.bin.fileToUint8Array(file);
    const sniffed = sniffFormat(bytes);
    const kind = sniffed ? sniffed.kind : detectKind(file);

    // A file whose name disagrees with its content keeps its data as it is.
    // Only the extension is corrected, and the user is told why.
    const lowerName = (file.name || "").toLowerCase();
    const nameMatches = sniffed ? sniffed.exts.some((ext) => lowerName.endsWith(ext)) : true;
    let mismatchNotice = null;
    if (sniffed && !nameMatches) {
      const how = sniffed.kind === "other" ? "shown as view only" : "handled as " + sniffed.label;
      mismatchNotice = 'This file is named "' + file.name + '" but its contents are ' + sniffed.label + '. It\'s ' + how +
        ' and will download as "' + withExtension(file.name, sniffed.exts[0]) + '" with its data unchanged.';
    }

    const record = {
      id, file, kind, bytes,
      heicJpegBytes: null,
      previewUrl: null,
      rawMetaPretty: {},
      fields: {},
      originalFields: {},
      outputName: mismatchNotice ? withExtension(file.name, sniffed.exts[0]) : file.name,
      supportsEdit: kind === "jpeg" || kind === "png" || kind === "heic",
      stripRequested: false,
      compressEnabled: false,
      compressTarget: COMPRESS_UNITS.MB.default,
      compressTargetUnit: "MB",
      compressMaxDimension: null,
      error: null,
      notice: null,
      dims: { width: null, height: null },
    };

    try {
      if (kind === "heic") {
        record.notice = "HEIC files are converted to JPEG to allow editing \u2014 image quality will be slightly reduced and any depth/HDR data will be dropped. GPS and other EXIF fields carry over. The downloaded file will be a .jpg.";
        const canvas = await Datum.heic.decodeToCanvas(bytes);
        record.dims.width = canvas.width;
        record.dims.height = canvas.height;
        record.heicJpegBytes = await Datum.heic.canvasToJpegBytes(canvas, 0.92);
        record.previewUrl = canvas.toDataURL("image/jpeg", 0.85);
        const base = file.name.replace(/\.[^.]+$/, "");
        record.outputName = (base || "photo") + ".jpg";

        // HEIC metadata goes through our own box reader + piexif rather
        // than exifr -- see heic-box-reader.js for why.
        const tiffBytes = Datum.heicBoxReader.extractExifTiff(bytes);
        if (tiffBytes) {
          const exifObj = Datum.metadataWriter.loadExifObj("Exif\0\0" + Datum.bin.uint8ToBinaryString(tiffBytes));
          record.fields = Datum.metadataWriter.fieldsFromExifObj(exifObj);
          record.rawMetaPretty = Datum.metadataWriter.rawDumpFromExifObj(exifObj);
        } else {
          record.fields = fieldsFromParsed(null);
          record.rawMetaPretty = {};
        }
      } else if (kind === "jpeg" || kind === "png") {
        record.previewUrl = URL.createObjectURL(file);
        const [strict, pretty] = await Promise.all([
          window.exifr.parse(bytes, EXIFR_OPTS_STRICT).catch(() => null),
          window.exifr.parse(bytes, EXIFR_OPTS_PRETTY).catch(() => null),
        ]);
        record.rawMetaPretty = pretty || {};
        record.fields = fieldsFromParsed(strict);
        await loadDims(record, file);
      } else {
        record.previewUrl = URL.createObjectURL(file);
        record.notice = "This format isn't supported for metadata editing here. Showing basic file info only \u2014 it will pass through to the download unchanged.";
        await loadDims(record, file);
      }
    } catch (e) {
      record.error = "Could not read this file: " + (e && e.message ? e.message : String(e));
      record.supportsEdit = false;
    }

    record.notice = [mismatchNotice, record.notice].filter(Boolean).join(" ") || null;
    record.originalFields = Object.assign({}, record.fields);
    return record;
  }

  function normalizeForDiff(key, v) {
    if (v === undefined || v === null || v === "") {
      // Orientation's "no tag" state is conventionally treated as Normal (1)
      // by viewers, and the dropdown displays it that way too -- so an
      // empty value here should count as "1", not as a change from it.
      return key === "orientation" ? "1" : "";
    }
    return String(v);
  }

  function changedKeys(record) {
    const keys = [];
    const all = new Set([...Object.keys(record.fields), ...Object.keys(record.originalFields)]);
    for (const k of all) {
      const an = normalizeForDiff(k, record.fields[k]);
      const bn = normalizeForDiff(k, record.originalFields[k]);
      if (an !== bn) keys.push(k);
    }
    return keys;
  }

  function resetAll(record) {
    record.fields = Object.assign({}, record.originalFields);
    record.stripRequested = false;
  }

  function stripAll(record) {
    const cleared = {};
    for (const k of Object.keys(record.fields)) cleared[k] = "";
    record.fields = cleared;
    record.stripRequested = true;
  }

  function getOutputBytes(record) {
    if (!record.supportsEdit) return record.bytes;
    if (record.kind === "jpeg") return Datum.metadataWriter.writeJpeg(record.bytes, record.fields, !!record.stripRequested);
    if (record.kind === "png") return Datum.metadataWriter.writePng(record.bytes, record.fields, !!record.stripRequested);
    if (record.kind === "heic") return Datum.metadataWriter.writeJpeg(record.heicJpegBytes, record.fields, !!record.stripRequested);
    return record.bytes;
  }

  function getOutputMime(record) {
    if (record.kind === "jpeg" || record.kind === "heic") return "image/jpeg";
    if (record.kind === "png") return "image/png";
    return record.file.type || "application/octet-stream";
  }

  // The bytes that represent "the actual photo" for compression purposes,
  // regardless of source format -- for HEIC that's the already-decoded
  // JPEG we made at load time, not the original container.
  function getPixelSourceBytes(record) {
    if (record.kind === "heic") return record.heicJpegBytes;
    if (record.kind === "jpeg" || record.kind === "png") return record.bytes;
    return null;
  }

  // Full original exifObj (numeric-tag keyed) regardless of source
  // format, reusing each format's existing extraction path. Used so
  // compression can preserve everything a normal export would, not just
  // the curated fields.
  function loadExifObjForRecord(record) {
    const mw = Datum.metadataWriter;
    if (record.kind === "jpeg") {
      return mw.loadExifObj(Datum.bin.uint8ToBinaryString(record.bytes));
    }
    if (record.kind === "png") {
      const tiff = Datum.pngCodec.getExifChunkData(record.bytes);
      return tiff ? mw.loadExifObj("Exif\0\0" + Datum.bin.uint8ToBinaryString(tiff)) : mw.emptyExifObj();
    }
    if (record.kind === "heic") {
      const tiff = Datum.heicBoxReader.extractExifTiff(record.bytes);
      return tiff ? mw.loadExifObj("Exif\0\0" + Datum.bin.uint8ToBinaryString(tiff)) : mw.emptyExifObj();
    }
    return mw.emptyExifObj();
  }

  // Normal export. A failure is returned as { failed: true } and never
  // replaced with the original bytes: those still hold any metadata the user
  // asked to strip, and any edits they made.
  function plainOutput(record) {
    try {
      return { bytes: getOutputBytes(record), compressed: false };
    } catch (e) {
      return { bytes: null, compressed: false, failed: true, error: errorMessage(e) };
    }
  }

  // Compression-aware output. Only actually recompresses when enabled AND
  // the source exceeds the target size -- files already under target are
  // left completely untouched, matching a normal export exactly.
  async function getOutputBytesAsync(record) {
    if (!record.supportsEdit || !record.compressEnabled) {
      return plainOutput(record);
    }
    const pixelSource = getPixelSourceBytes(record);
    const targetBytes = targetBytesFor(record);
    if (!pixelSource || pixelSource.length <= targetBytes) {
      const plain = plainOutput(record);
      return plain.failed ? plain : Object.assign(plain, { skipped: true });
    }
    try {
      const img = await Datum.compress.loadImageFromBytes(pixelSource);
      const canvas = Datum.compress.drawToCanvas(img, record.compressMaxDimension || null);
      const { blob, reachedTarget } = await Datum.compress.compressToTargetSize(canvas, targetBytes);
      const pixelBytes = new Uint8Array(await blob.arrayBuffer());
      const exifObj = loadExifObjForRecord(record);
      const finalBytes = Datum.metadataWriter.insertMergedExif(exifObj, record.fields, pixelBytes, record.stripRequested);
      return { bytes: finalBytes, compressed: true, reachedTarget };
    } catch (e) {
      // Compression failed: fall back to a normal export, which is refused
      // (not sent unstripped) if it fails too.
      const plain = plainOutput(record);
      return plain.failed ? plain : Object.assign(plain, { error: errorMessage(e) });
    }
  }

  Datum.model = {
    detectKind, createFileRecord, changedKeys, resetAll, stripAll,
    getOutputBytes, getOutputMime, fieldsFromParsed,
    getPixelSourceBytes, loadExifObjForRecord, getOutputBytesAsync,
    COMPRESS_UNITS, compressUnit, targetBytesFor,
    EXIFR_OPTS_STRICT, EXIFR_OPTS_PRETTY,
  };
})(window.Datum = window.Datum || {});
