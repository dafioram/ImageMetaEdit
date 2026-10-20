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

  // EXIF text tags hold bytes, and piexif takes one JS char per byte. Text
  // is written as UTF-8, which modern readers (exifr, exiftool, phones,
  // macOS, Windows) decode correctly; writing JS char codes directly would
  // mangle anything outside Latin-1 and store Latin-1 in a way UTF-8 readers
  // show as garbage.
  function textToExif(text) {
    return bin.uint8ToBinaryString(new TextEncoder().encode(String(text)));
  }

  // Reverse of textToExif. Older files can hold Latin-1 bytes, which are not
  // valid UTF-8; those are shown as Latin-1.
  function exifToText(raw) {
    const s = String(raw).replace(/\u0000+$/, "");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bin.binaryStringToUint8(s));
    } catch (e) {
      return s;
    }
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
          ifd[def.tag] = textToExif(value);
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

  // The only tag "Strip all metadata" keeps: without it, a phone photo whose
  // pixels are stored sideways would be displayed sideways. It holds no
  // personal information. Returns the EXIF binary string, or null when the
  // orientation is normal and nothing needs to be written.
  function orientationOnlyExif(fields) {
    const o = Datum.orientation.normalize(fields && fields.orientation);
    if (o === 1) return null;
    return window.piexif.dump({ "0th": { [window.piexif.ImageIFD.Orientation]: o } });
  }

  // When the location was changed or cleared, the XMP copy of the old
  // location must not survive. Returns the XMP text to keep (GPS removed),
  // or null to drop the packet (it could not be parsed or edited).
  function xmpWithoutGps(text) {
    if (text === null || !Datum.xmp.hasGps(text)) return text;
    return Datum.xmp.removeGps(text);
  }

  // originalBytes: Uint8Array of the original JPEG. Returns a new Uint8Array.
  // options.locationChanged: the user changed or cleared the GPS position.
  function writeJpeg(originalBytes, fields, strip, options) {
    if (strip) {
      const bare = Datum.jpegSegments.stripAllMetadata(originalBytes);
      const exif = orientationOnlyExif(fields);
      return exif ? bin.binaryStringToUint8(window.piexif.insert(exif, bin.uint8ToBinaryString(bare))) : bare;
    }
    const binaryStr = bin.uint8ToBinaryString(originalBytes);
    const exifObj = loadExifObj(binaryStr);
    applyFieldsToExifObj(exifObj, fields);
    let out = exifObjIsEmpty(exifObj)
      ? bin.binaryStringToUint8(window.piexif.remove(binaryStr))
      : bin.binaryStringToUint8(window.piexif.insert(window.piexif.dump(exifObj), binaryStr));
    if (options && options.locationChanged) {
      const xmp = Datum.jpegSegments.readXmp(out);
      if (xmp !== null) {
        const kept = xmpWithoutGps(xmp);
        if (kept !== xmp) out = Datum.jpegSegments.replaceXmp(out, kept);
      }
    }
    return out;
  }

  // originalBytes: Uint8Array of the original PNG. Returns a new Uint8Array.
  function writePng(originalBytes, fields, strip, options) {
    if (strip) {
      const exif = orientationOnlyExif(fields);
      return Datum.pngCodec.writeExifChunk(originalBytes, exif ? bin.binaryStringToUint8(exif.slice(6)) : null, true);
    }
    const existingTiff = Datum.pngCodec.getExifChunkData(originalBytes);
    const exifObj = existingTiff
      ? loadExifObj("Exif\0\0" + bin.uint8ToBinaryString(existingTiff))
      : emptyExifObj();
    applyFieldsToExifObj(exifObj, fields);
    let out;
    if (exifObjIsEmpty(exifObj)) {
      out = Datum.pngCodec.writeExifChunk(originalBytes, null, false);
    } else {
      const exifBytesBinary = window.piexif.dump(exifObj);
      out = Datum.pngCodec.writeExifChunk(originalBytes, bin.binaryStringToUint8(exifBytesBinary.slice(6)), false);
    }
    if (options && options.locationChanged) {
      const xmp = Datum.pngCodec.getXmp(out);
      if (xmp && xmp.compressed) {
        // A compressed packet cannot be read or edited here, so it is dropped.
        out = Datum.pngCodec.replaceXmp(out, null);
      } else if (xmp) {
        const kept = xmpWithoutGps(xmp.text);
        if (kept !== xmp.text) out = Datum.pngCodec.replaceXmp(out, kept);
      }
    }
    return out;
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
          fields[def.key] = exifToText(raw);
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
        if (typeof value === "string") value = exifToText(value);
        out[name] = value;
      }
    }
    return out;
  }

  // Same merge logic as writeJpeg, but the exifObj is supplied by the
  // caller (already loaded from wherever the original metadata lives) and
  // gets inserted into separately-supplied pixel bytes -- used by the
  // "reduce file size" pipeline, where the pixels come from a fresh
  // canvas re-encode rather than the original file.
  //
  // The pixels are new, so anything describing the old ones goes: the
  // embedded thumbnail (it would still show the old framing, a known way
  // cropped-out content leaks) and stale pixel dimensions. Orientation is
  // taken from `fields`, which callers set to 1 because re-encoded pixels
  // are stored upright (see orientation.js).
  function prepareExifForNewPixels(exifObj, width, height) {
    exifObj["1st"] = {};
    exifObj.thumbnail = null;
    if (width && height) {
      exifObj["Exif"][window.piexif.ExifIFD.PixelXDimension] = width;
      exifObj["Exif"][window.piexif.ExifIFD.PixelYDimension] = height;
    }
    return exifObj;
  }

  function insertMergedExif(exifObj, fields, jpegPixelBytes, strip, size) {
    const binaryStr = bin.uint8ToBinaryString(jpegPixelBytes);
    if (strip) return jpegPixelBytes;
    prepareExifForNewPixels(exifObj, size && size.width, size && size.height);
    applyFieldsToExifObj(exifObj, fields);
    if (exifObjIsEmpty(exifObj)) return bin.binaryStringToUint8(window.piexif.remove(binaryStr));
    const exifBytes = window.piexif.dump(exifObj);
    const newBinary = window.piexif.insert(exifBytes, binaryStr);
    return bin.binaryStringToUint8(newBinary);
  }

  // PNG counterpart of insertMergedExif, for a cropped PNG re-encoded
  // losslessly by the browser: the merged EXIF goes into an eXIf chunk.
  function insertMergedExifPng(exifObj, fields, pngBytes, strip, size) {
    if (strip) return pngBytes;
    prepareExifForNewPixels(exifObj, size && size.width, size && size.height);
    applyFieldsToExifObj(exifObj, fields);
    if (exifObjIsEmpty(exifObj)) return pngBytes;
    const dumped = window.piexif.dump(exifObj);
    return Datum.pngCodec.writeExifChunk(pngBytes, bin.binaryStringToUint8(dumped.slice(6)), false);
  }

  // Size in bytes of the EXIF segment insertMergedExif would add, so the
  // compression target can leave room for it.
  function mergedExifSize(exifObj, fields, size) {
    const copy = prepareExifForNewPixels(JSON.parse(JSON.stringify(exifObj)), size && size.width, size && size.height);
    applyFieldsToExifObj(copy, fields);
    if (exifObjIsEmpty(copy)) return 0;
    return window.piexif.dump(copy).length + 4;
  }

  Datum.metadataWriter = {
    loadExifObj, applyFieldsToExifObj, exifObjIsEmpty, writeJpeg, writePng, emptyExifObj,
    fieldsFromExifObj, rawDumpFromExifObj, insertMergedExif, insertMergedExifPng, mergedExifSize, textToExif, exifToText,
  };
})(window.Datum = window.Datum || {});
