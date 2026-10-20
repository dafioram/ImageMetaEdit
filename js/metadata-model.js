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
    if (type === "image/avif" || /\.avif$/.test(name)) return "avif";
    return "other";
  }

  // Formats edited by converting to JPEG: the browser can show and write
  // JPEG, but can't write these containers. Both are HEIF-family files, so
  // their EXIF is read with the same box reader.
  const CONVERTED = {
    heic: { label: "HEIC", decode: (bytes) => Datum.heic.decodeToCanvas(bytes) },
    avif: { label: "AVIF", decode: (bytes) => Datum.avif.decodeToCanvas(bytes) },
  };

  function isConverted(kind) {
    return Object.prototype.hasOwnProperty.call(CONVERTED, kind);
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
    { kind: "avif", label: "AVIF", exts: [".avif"], test: (b) => ascii(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 12)) },
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
    return Datum.errors.describe(e);
  }

  function hexStart(bytes) {
    return Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }

  // Load-time structural check, as specific as the file allows. `fatal`
  // means the file can't be used as an image; `warning` means it loads but
  // is damaged, and the person should know before relying on the result.
  function inspectStructure(kind, bytes) {
    if (kind === "jpeg") {
      let parsed;
      try {
        parsed = Datum.jpegSegments.parse(bytes);
      } catch (e) {
        return { warning: "This JPEG's header is damaged (" + Datum.errors.describe(e).replace(/^the JPEG is damaged: /, "") + "). It may still display, but saving changes can fail." };
      }
      if (!parsed.hasScan) {
        return { fatal: "This JPEG has no image data: the file ends after its header, " + bytes.length.toLocaleString("en-US") + " bytes in." };
      }
      if (parsed.eoiEnd === null) {
        return {
          warning: "This JPEG is cut off: its image data stops before the end-of-image marker, " + bytes.length.toLocaleString("en-US") +
            " bytes in. The part that arrived is shown and the rest of the picture (usually the bottom) is missing or grey. " +
            "Downloads keep it as it is, and some apps won't open it; turn on \"Reduce file size\" to save a re-encoded copy that opens everywhere.",
        };
      }
      return {};
    }
    if (kind === "png") {
      const { problem } = Datum.pngCodec.inspect(bytes);
      return problem ? { warning: "This PNG is damaged: " + problem + ". What can be decoded is shown." } : {};
    }
    return {};
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
        resolve(true);
      };
      img.onerror = () => { URL.revokeObjectURL(img.src); resolve(false); };
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
      convertedJpegBytes: null,
      previewUrl: null,
      rawMetaPretty: {},
      fields: {},
      originalFields: {},
      outputName: mismatchNotice ? withExtension(file.name, sniffed.exts[0]) : file.name,
      supportsEdit: kind === "jpeg" || kind === "png" || isConverted(kind),
      stripRequested: false,
      compressEnabled: false,
      compressTarget: COMPRESS_UNITS.MB.default,
      compressTargetUnit: "MB",
      compressMaxDimension: null,
      error: null,
      notice: null,
      warning: null,
      dims: { width: null, height: null },
    };

    // Files that can't be an image at all are flagged now, with what is
    // known, rather than failing later at download.
    const claimed = detectKind(file);
    let unusable = null;
    if (bytes.length === 0) {
      unusable = "This file is empty (0 bytes).";
    } else if (!sniffed && claimed !== "other") {
      unusable = 'This file is named "' + file.name + '" but its contents aren\'t a ' + claimed.toUpperCase() +
        " image or any format this app recognizes (it starts with the bytes " + hexStart(bytes) + ").";
    }
    if (unusable) {
      record.kind = "other";
      record.supportsEdit = false;
      record.error = unusable;
      record.originalFields = {};
      return record;
    }

    const structure = inspectStructure(kind, bytes);
    if (structure.fatal) {
      record.kind = "other";
      record.supportsEdit = false;
      record.error = structure.fatal;
      record.previewUrl = URL.createObjectURL(file);
      record.originalFields = {};
      return record;
    }
    record.warning = structure.warning || null;

    try {
      if (isConverted(kind)) {
        const label = CONVERTED[kind].label;
        let canvas;
        try {
          canvas = await CONVERTED[kind].decode(bytes);
        } catch (e) {
          if (!e.unsupported) throw e;
          // No decoder in this browser: the file can still be kept as is.
          record.kind = "other";
          record.supportsEdit = false;
          record.notice = e.message + ", so this file is shown as a file only. It will download unchanged.";
          record.originalFields = {};
          return record;
        }
        record.notice = label + " files are converted to JPEG to allow editing \u2014 image quality will be slightly reduced and any depth/HDR data will be dropped. GPS and other EXIF fields carry over. The downloaded file will be a .jpg.";
        record.dims.width = canvas.width;
        record.dims.height = canvas.height;
        record.convertedJpegBytes = await Datum.heic.canvasToJpegBytes(canvas, 0.92);
        // The converted JPEG doubles as the preview, so no second
        // full-size copy (a base64 data URL) is kept in memory.
        record.previewUrl = URL.createObjectURL(new Blob([record.convertedJpegBytes], { type: "image/jpeg" }));
        const base = file.name.replace(/\.[^.]+$/, "");
        record.outputName = (base || "photo") + ".jpg";

        // EXIF goes through our own box reader + piexif rather than exifr --
        // see heic-box-reader.js for why. AVIF uses the same container.
        const tiffBytes = Datum.heicBoxReader.extractExifTiff(bytes);
        if (tiffBytes) {
          const exifObj = Datum.metadataWriter.loadExifObj("Exif\0\0" + Datum.bin.uint8ToBinaryString(tiffBytes));
          record.fields = Datum.metadataWriter.fieldsFromExifObj(exifObj);
          record.rawMetaPretty = Datum.metadataWriter.rawDumpFromExifObj(exifObj);
          // The decoder already applied the container's rotation, and the
          // HEIF/AVIF specs say the EXIF tag is not applied on top. The
          // converted pixels are the displayed image, so they are upright.
          record.fields.orientation = 1;
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
        const decoded = await loadDims(record, file);
        if (!decoded && !record.warning) {
          record.warning = "The browser couldn't display this image, so its data may be damaged. Its metadata can still be edited.";
        }
        if (record.fields.latitude === "" && Datum.xmp.hasGps(readXmpText(kind, bytes))) {
          record.notice = "This file also stores a location in its XMP metadata, which the editor can't show. \"Strip all metadata\" removes it.";
        }
      } else {
        record.previewUrl = URL.createObjectURL(file);
        record.notice = "This format isn't supported for metadata editing here. Showing basic file info only \u2014 it will pass through to the download unchanged.";
        await loadDims(record, file);
      }
    } catch (e) {
      record.error = Datum.errors.sentence("Couldn't read this file: " + Datum.errors.describe(e));
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

  // Clears every field except orientation: that tag only says which way up
  // the stored pixels go, and dropping it would display photos sideways.
  function stripAll(record) {
    const cleared = {};
    for (const k of Object.keys(record.fields)) cleared[k] = k === "orientation" ? record.fields.orientation : "";
    record.fields = cleared;
    record.stripRequested = true;
  }

  function readXmpText(kind, bytes) {
    try {
      if (kind === "jpeg") return Datum.jpegSegments.readXmp(bytes);
      if (kind === "png") {
        const x = Datum.pngCodec.getXmp(bytes);
        return x ? x.text : null;
      }
    } catch (e) { /* not readable: nothing to report */ }
    return null;
  }

  function locationChanged(record) {
    const changed = changedKeys(record);
    return changed.includes("latitude") || changed.includes("longitude") || changed.includes("altitude");
  }

  function getOutputBytes(record) {
    if (!record.supportsEdit) return record.bytes;
    const options = { locationChanged: locationChanged(record) };
    if (record.kind === "jpeg") return Datum.metadataWriter.writeJpeg(record.bytes, record.fields, !!record.stripRequested, options);
    if (record.kind === "png") return Datum.metadataWriter.writePng(record.bytes, record.fields, !!record.stripRequested, options);
    if (isConverted(record.kind)) return Datum.metadataWriter.writeJpeg(record.convertedJpegBytes, record.fields, !!record.stripRequested);
    return record.bytes;
  }

  function getOutputMime(record) {
    if (record.kind === "jpeg" || isConverted(record.kind)) return "image/jpeg";
    if (record.kind === "png") return "image/png";
    return record.file.type || "application/octet-stream";
  }

  // The bytes that represent "the actual photo" for compression purposes,
  // regardless of source format -- for HEIC that's the already-decoded
  // JPEG we made at load time, not the original container.
  function getPixelSourceBytes(record) {
    if (isConverted(record.kind)) return record.convertedJpegBytes;
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
    if (isConverted(record.kind)) {
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

  // Decodes the record's pixels and returns a canvas in the orientation the
  // user wants displayed (their orientation field applied), optionally
  // capped to maxDimension on the longest side. Used by every path that
  // re-encodes pixels; the output is then written with orientation 1.
  async function uprightCanvas(record, pixelSource, exifObj, maxDimension) {
    if (isConverted(record.kind)) {
      // Decode the original again rather than the converted JPEG, so the
      // pixels are lossy-encoded once, not twice. The decoded image is
      // already the displayed one; only the user's orientation is applied.
      const decoded = await CONVERTED[record.kind].decode(record.bytes);
      const canvas = Datum.compress.drawToCanvas(decoded, maxDimension);
      return Datum.orientation.applyToCanvas(canvas, Datum.orientation.normalize(record.fields.orientation || 1));
    }
    const img = await Datum.compress.loadImageFromBytes(pixelSource);
    const canvas = Datum.compress.drawToCanvas(img, maxDimension);
    const sourceKind = record.kind === "png" ? "png" : "jpeg";
    const sourceTag = exifObj["0th"][window.piexif.ImageIFD.Orientation] || 1;
    const remaining = await Datum.orientation.remainingTransform(sourceKind, sourceTag, record.fields.orientation || 1);
    return Datum.orientation.applyToCanvas(canvas, remaining);
  }

  // Compression-aware output. Only actually recompresses when enabled AND
  // the source exceeds the target size -- files already under target are
  // left completely untouched, matching a normal export exactly.
  // What has to be fixed before this record can be written, as one
  // clause ("ISO must be ...; Latitude must be ..."), or null.
  function validationError(record) {
    if (!record.supportsEdit) return null;
    const problems = Datum.validateFields(record.fields);
    if (!problems.length) return null;
    return problems.map((p) => Datum.errors.trimSentence(p.message)).join("; ");
  }

  async function getOutputBytesAsync(record) {
    const invalid = validationError(record);
    if (invalid) return { bytes: null, compressed: false, failed: true, invalid: true, error: invalid };
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
      const exifObj = loadExifObjForRecord(record);
      const canvas = await uprightCanvas(record, pixelSource, exifObj, record.compressMaxDimension || null);
      const fields = Datum.orientation.fieldsForUprightPixels(record.fields);
      const size = { width: canvas.width, height: canvas.height };
      // The metadata is added after encoding, so the pixels get the target
      // minus the metadata's size; otherwise output would overshoot.
      const exifSize = record.stripRequested ? 0 : Datum.metadataWriter.mergedExifSize(exifObj, fields, size);
      const { blob, reachedTarget } = await Datum.compress.compressToTargetSize(canvas, Math.max(1, targetBytes - exifSize));
      const pixelBytes = new Uint8Array(await blob.arrayBuffer());
      const finalBytes = Datum.metadataWriter.insertMergedExif(exifObj, fields, pixelBytes, record.stripRequested, size);
      return { bytes: finalBytes, compressed: true, reachedTarget: reachedTarget && finalBytes.length <= targetBytes };
    } catch (e) {
      // Compression failed: fall back to a normal export, which is refused
      // (not sent unstripped) if it fails too.
      const plain = plainOutput(record);
      return plain.failed ? plain : Object.assign(plain, { error: errorMessage(e) });
    }
  }

  Datum.model = {
    detectKind, isConverted, createFileRecord, changedKeys, resetAll, stripAll,
    getOutputBytes, getOutputMime, fieldsFromParsed,
    getPixelSourceBytes, loadExifObjForRecord, getOutputBytesAsync, uprightCanvas, validationError,
    COMPRESS_UNITS, compressUnit, targetBytesFor,
    EXIFR_OPTS_STRICT, EXIFR_OPTS_PRETTY,
  };
})(window.Datum = window.Datum || {});
