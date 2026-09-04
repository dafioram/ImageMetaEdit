/* Merge-based metadata writer.
   Design principle: we load whatever EXIF already exists in the file, and
   only touch the specific tags that correspond to curated fields the editor
   exposes. Everything else the camera wrote (MakerNote, lens calibration,
   thumbnail IFD, color space, etc.) is preserved untouched. Clearing a field
   in the UI removes that specific tag; it does not wipe the rest of EXIF.
   "Strip all metadata" is a separate explicit action that removes the whole
   block instead of going through this merge. */
(function (Datum) {
  "use strict";

  const { bin, gps, fieldCodec } = Datum;

  function emptyExifObj() {
    return { "0th": {}, "Exif": {}, "GPS": {}, "Interop": {}, "1st": {}, thumbnail: null };
  }

  // binaryString: either a full JPEG binary string, or "Exif\0\0" + raw TIFF
  // bytes (used for PNG's eXIf chunk payload). Returns a safe default on
  // any parse failure rather than throwing.
  function loadExifObj(binaryString) {
    if (!binaryString) return emptyExifObj();
    try {
      const loaded = window.piexif.load(binaryString);
      return Object.assign(emptyExifObj(), loaded);
    } catch (e) {
      return emptyExifObj();
    }
  }

  function isEmptyValue(v) {
    return v === null || v === undefined || v === "" || (typeof v === "number" && isNaN(v));
  }

  // Applies `fields` (the curated model, see metadata-model.js) onto an
  // existing exifObj in place. Returns the same object for convenience.
  function applyFieldsToExifObj(exifObj, fields) {
    const px = window.piexif;
    const schema = Datum.examifSchema();

    for (const def of schema) {
      if (def.ifd === "multi-date") continue; // handled below
      const value = fields[def.key];
      const ifd = exifObj[def.ifd];
      if (isEmptyValue(value)) {
        delete ifd[def.tag];
        continue;
      }
      switch (def.type) {
        case "ascii":
          ifd[def.tag] = String(value);
          break;
        case "int":
          ifd[def.tag] = Math.round(Number(value));
          break;
        case "rational":
          ifd[def.tag] = fieldCodec.decimalToRational(Number(value), 1000);
          break;
        case "rationalFraction": {
          const parsed = fieldCodec.parseExposureInput(value);
          if (parsed) ifd[def.tag] = parsed; else delete ifd[def.tag];
          break;
        }
        case "orientation":
          ifd[def.tag] = Math.round(Number(value));
          break;
        default:
          ifd[def.tag] = value;
      }
    }

    // Date taken -> mirrors across the three standard date tags
    const dt = fields.dateTaken;
    if (isEmptyValue(dt)) {
      delete exifObj["0th"][px.ImageIFD.DateTime];
      delete exifObj["Exif"][px.ExifIFD.DateTimeOriginal];
      delete exifObj["Exif"][px.ExifIFD.DateTimeDigitized];
    } else {
      const exifStr = fieldCodec.dateInputToExif(dt);
      if (exifStr) {
        exifObj["0th"][px.ImageIFD.DateTime] = exifStr;
        exifObj["Exif"][px.ExifIFD.DateTimeOriginal] = exifStr;
        exifObj["Exif"][px.ExifIFD.DateTimeDigitized] = exifStr;
      }
    }

    // GPS: latitude/longitude define presence; clearing either wipes the
    // whole GPS block (a stray altitude with no position is meaningless).
    const lat = fields.latitude, lon = fields.longitude;
    if (isEmptyValue(lat) || isEmptyValue(lon)) {
      exifObj["GPS"] = {};
    } else {
      const g = {};
      g[px.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
      g[px.GPSIFD.GPSLatitudeRef] = lat >= 0 ? "N" : "S";
      g[px.GPSIFD.GPSLatitude] = gps.toExifRational(lat);
      g[px.GPSIFD.GPSLongitudeRef] = lon >= 0 ? "E" : "W";
      g[px.GPSIFD.GPSLongitude] = gps.toExifRational(lon);
      if (!isEmptyValue(fields.altitude)) {
        g[px.GPSIFD.GPSAltitudeRef] = Number(fields.altitude) < 0 ? 1 : 0;
        g[px.GPSIFD.GPSAltitude] = gps.altitudeToExif(Number(fields.altitude));
      }
      exifObj["GPS"] = g;
    }

    return exifObj;
  }

  function exifObjIsEmpty(exifObj) {
    return Object.keys(exifObj["0th"]).length === 0 &&
      Object.keys(exifObj["Exif"]).length === 0 &&
      Object.keys(exifObj["GPS"]).length === 0;
  }

  // originalBytes: Uint8Array of the original JPEG. Returns a new Uint8Array.
  function writeJpeg(originalBytes, fields, strip) {
    const binaryStr = bin.uint8ToBinaryString(originalBytes);
    if (strip) {
      const stripped = window.piexif.remove(binaryStr);
      return bin.binaryStringToUint8(stripped);
    }
    const exifObj = loadExifObj(binaryStr);
    applyFieldsToExifObj(exifObj, fields);
    if (exifObjIsEmpty(exifObj)) {
      const stripped = window.piexif.remove(binaryStr);
      return bin.binaryStringToUint8(stripped);
    }
    const exifBytes = window.piexif.dump(exifObj);
    const newBinary = window.piexif.insert(exifBytes, binaryStr);
    return bin.binaryStringToUint8(newBinary);
  }

  // originalBytes: Uint8Array of the original PNG. Returns a new Uint8Array.
  function writePng(originalBytes, fields, strip) {
    if (strip) {
      return Datum.pngCodec.writeExifChunk(originalBytes, null, true);
    }
    const existingTiff = Datum.pngCodec.getExifChunkData(originalBytes);
    const exifObj = existingTiff
      ? loadExifObj("Exif\0\0" + bin.uint8ToBinaryString(existingTiff))
      : emptyExifObj();
    applyFieldsToExifObj(exifObj, fields);
    if (exifObjIsEmpty(exifObj)) {
      return Datum.pngCodec.writeExifChunk(originalBytes, null, false);
    }
    const exifBytesBinary = window.piexif.dump(exifObj);
    const tiffOnly = bin.binaryStringToUint8(exifBytesBinary.slice(6));
    return Datum.pngCodec.writeExifChunk(originalBytes, tiffOnly, false);
  }

  // Inverse of applyFieldsToExifObj: given a loaded exifObj (numeric-tag
  // keyed, as produced by piexif.load), populate our curated `fields`
  // model. Used for HEIC, where metadata is read via heic-box-reader.js +
  // piexif rather than exifr (see that file for why).
  function fieldsFromExifObj(exifObj) {
    const px = window.piexif;
    const schema = Datum.examifSchema();
    const fields = {};
    const stripNulls = (s) => String(s).replace(/\u0000+$/, "");

    for (const def of schema) {
      if (def.ifd === "multi-date") continue;
      const ifd = exifObj[def.ifd] || {};
      const raw = ifd[def.tag];
      if (raw === undefined || raw === null) { fields[def.key] = ""; continue; }
      switch (def.type) {
        case "ascii":
          fields[def.key] = stripNulls(raw);
          break;
        case "int":
          fields[def.key] = Number(raw);
          break;
        case "rational":
          fields[def.key] = Math.round(fieldCodec.rationalToDecimal(raw) * 100) / 100;
          break;
        case "rationalFraction":
          fields[def.key] = fieldCodec.formatExposureTime(fieldCodec.rationalToDecimal(raw));
          break;
        case "orientation":
          fields[def.key] = Number(raw);
          break;
        default:
          fields[def.key] = raw;
      }
    }

    const dt = (exifObj["Exif"] || {})[px.ExifIFD.DateTimeOriginal] || (exifObj["0th"] || {})[px.ImageIFD.DateTime];
    fields.dateTaken = dt ? fieldCodec.exifDateToInput(stripNulls(dt)) : "";

    const g = exifObj["GPS"] || {};
    const latRat = g[px.GPSIFD.GPSLatitude], lonRat = g[px.GPSIFD.GPSLongitude];
    if (latRat && lonRat) {
      fields.latitude = Math.round(gps.fromExifRational(g[px.GPSIFD.GPSLatitudeRef], latRat) * 1e6) / 1e6;
      fields.longitude = Math.round(gps.fromExifRational(g[px.GPSIFD.GPSLongitudeRef], lonRat) * 1e6) / 1e6;
      const altRef = g[px.GPSIFD.GPSAltitudeRef];
      const altRefNum = (altRef && altRef.length !== undefined) ? altRef[0] : (altRef || 0);
      fields.altitude = g[px.GPSIFD.GPSAltitude] !== undefined
        ? Math.round(gps.altitudeFromExif(altRefNum, g[px.GPSIFD.GPSAltitude]) * 100) / 100
        : "";
    } else {
      fields.latitude = "";
      fields.longitude = "";
      fields.altitude = "";
    }
    return fields;
  }

  // Flat "tag name -> value" dump of a loaded exifObj, for the raw-metadata
  // reference tab when exifr isn't in the picture (HEIC).
  // Internal offset pointers (0th IFD -> Exif/GPS/Interop sub-IFDs) --
  // meaningful to a parser, meaningless to a person reading a tag list.
  const POINTER_TAGS = new Set([
    window.piexif.ImageIFD.ExifTag,
    window.piexif.ImageIFD.GPSTag,
  ]);

  function rawDumpFromExifObj(exifObj) {
    const px = window.piexif;
    const out = {};
    for (const ifdName of ["0th", "Exif", "GPS", "Interop", "1st"]) {
      const ifd = exifObj[ifdName];
      if (!ifd) continue;
      for (const tagStr of Object.keys(ifd)) {
        const tagNum = Number(tagStr);
        if (ifdName === "0th" && POINTER_TAGS.has(tagNum)) continue;
        const tagInfo = (px.TAGS[ifdName === "1st" ? "0th" : ifdName] || {})[tagNum];
        const name = tagInfo ? tagInfo.name : (ifdName + ":" + tagNum);
        let value = ifd[tagNum];
        if (typeof value === "string") value = value.replace(/\u0000+$/, "");
        out[name] = value;
      }
    }
    return out;
  }

  Datum.metadataWriter = {
    loadExifObj, applyFieldsToExifObj, exifObjIsEmpty, writeJpeg, writePng, emptyExifObj,
    fieldsFromExifObj, rawDumpFromExifObj,
  };
})(window.Datum = window.Datum || {});
