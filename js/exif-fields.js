/* Schema of the curated, editable metadata fields. Each field knows which
   IFD/tag it lives in (via piexif's constants) and how to encode/decode its
   value. GPS fields are handled separately in gps-utils.js + the GPS panel,
   since they need paired lat/lon/altitude handling and the map widget. */
(function (Datum) {
  "use strict";

  function schema() {
    const px = window.piexif;
    return [
      // -- Camera --
      { key: "make", label: "Camera make", category: "camera", ifd: "0th", tag: px.ImageIFD.Make, type: "ascii", placeholder: "e.g. Canon" },
      { key: "model", label: "Camera model", category: "camera", ifd: "0th", tag: px.ImageIFD.Model, type: "ascii", placeholder: "e.g. EOS R5" },
      { key: "lens", label: "Lens", category: "camera", ifd: "Exif", tag: px.ExifIFD.LensModel, type: "ascii", placeholder: "e.g. RF 24-70mm F2.8L" },
      { key: "fNumber", label: "Aperture (f-number)", category: "camera", ifd: "Exif", tag: px.ExifIFD.FNumber, type: "rational", placeholder: "e.g. 2.8" },
      { key: "exposureTime", label: "Shutter speed (seconds)", category: "camera", ifd: "Exif", tag: px.ExifIFD.ExposureTime, type: "rationalFraction", placeholder: "e.g. 0.004 for 1/250" },
      { key: "iso", label: "ISO", category: "camera", ifd: "Exif", tag: px.ExifIFD.ISOSpeedRatings, type: "int", placeholder: "e.g. 400" },
      { key: "focalLength", label: "Focal length (mm)", category: "camera", ifd: "Exif", tag: px.ExifIFD.FocalLength, type: "rational", placeholder: "e.g. 50" },

      // -- Date & time --
      { key: "dateTaken", label: "Date taken", category: "datetime", ifd: "multi-date", tag: null, type: "datetime" },

      // -- Description & credit --
      { key: "description", label: "Description", category: "description", ifd: "0th", tag: px.ImageIFD.ImageDescription, type: "ascii", placeholder: "What's in this photo" },
      { key: "artist", label: "Photographer", category: "description", ifd: "0th", tag: px.ImageIFD.Artist, type: "ascii", placeholder: "e.g. Jane Doe" },
      { key: "copyright", label: "Copyright", category: "description", ifd: "0th", tag: px.ImageIFD.Copyright, type: "ascii", placeholder: "e.g. \u00A9 2026 Jane Doe" },

      // -- Technical (metadata-only, no pixel re-encode) --
      { key: "orientation", label: "Orientation", category: "technical", ifd: "0th", tag: px.ImageIFD.Orientation, type: "orientation" },
    ];
  }

  const ORIENTATION_OPTIONS = [
    { value: 1, label: "Normal" },
    { value: 3, label: "Rotate 180\u00B0" },
    { value: 6, label: "Rotate 90\u00B0 CW" },
    { value: 8, label: "Rotate 90\u00B0 CCW" },
    { value: 2, label: "Mirror horizontal" },
    { value: 4, label: "Mirror vertical" },
    { value: 5, label: "Mirror + rotate 90\u00B0 CCW" },
    { value: 7, label: "Mirror + rotate 90\u00B0 CW" },
  ];

  const CATEGORY_LABELS = {
    camera: "Camera",
    datetime: "Date & time",
    location: "Location (GPS)",
    description: "Description & credit",
    technical: "Technical",
  };

  // Map exifr's human-readable output keys back onto our field keys, for
  // populating the edit form when a file is first loaded.
  const EXIFR_KEY_MAP = {
    make: "Make",
    model: "Model",
    lens: "LensModel",
    fNumber: "FNumber",
    exposureTime: "ExposureTime",
    iso: "ISO",
    focalLength: "FocalLength",
    description: "ImageDescription",
    artist: "Artist",
    copyright: "Copyright",
    orientation: "Orientation",
  };

  // ---- Validation. Each rule describes what a field may hold, in words a
  // person can act on. The ranges also keep values inside what EXIF can
  // store (ISO is a 16-bit number; apertures and lengths are 32-bit
  // fractions), which is what used to fail exports with "'pack' error."

  // Each text field's limit. Together they stay well inside the 64 KB a
  // JPEG metadata segment can hold.
  const TEXT_LIMIT_BYTES = 8000;

  function isBlank(v) {
    return v === "" || v === undefined || v === null;
  }

  function utf8Length(s) {
    return new TextEncoder().encode(String(s)).length;
  }

  function between(v, min, max) {
    const n = Number(v);
    return typeof v !== "boolean" && String(v).trim() !== "" && isFinite(n) && n >= min && n <= max;
  }

  const NUMBER_RULES = {
    fNumber: { ok: (v) => between(v, 0.01, 1000) && Number(v) > 0, message: "Aperture must be a number above 0, like 2.8." },
    exposureTime: {
      ok: (v) => {
        const r = Datum.fieldCodec.parseExposureInput(v);
        return !!r && r[1] > 0 && r[0] > 0 && r[0] / r[1] <= 86400;
      },
      message: "Shutter speed must be a positive number of seconds, like 0.004 or 1/250.",
    },
    iso: { ok: (v) => between(v, 1, 65535) && Number.isInteger(Number(v)), message: "ISO must be a whole number from 1 to 65,535." },
    focalLength: { ok: (v) => between(v, 0.01, 10000) && Number(v) > 0, message: "Focal length must be a number of millimetres above 0, like 50." },
  };

  // Returns [{ key, message }] for every field that can't be written.
  function validateFields(fields) {
    const problems = [];
    const add = (key, message) => problems.push({ key, message });
    for (const def of schema()) {
      const v = fields[def.key];
      if (isBlank(v)) continue;
      if (def.type === "ascii") {
        const n = utf8Length(v);
        if (n > TEXT_LIMIT_BYTES) add(def.key, def.label + " is too long (" + n.toLocaleString("en-US") + " bytes; the limit is " + TEXT_LIMIT_BYTES.toLocaleString("en-US") + ").");
      } else if (NUMBER_RULES[def.key] && !NUMBER_RULES[def.key].ok(v)) {
        add(def.key, NUMBER_RULES[def.key].message);
      }
    }
    const lat = fields.latitude, lon = fields.longitude, alt = fields.altitude;
    if (isBlank(lat) !== isBlank(lon)) {
      add(isBlank(lat) ? "latitude" : "longitude", "Enter both latitude and longitude, or clear both.");
    }
    if (!isBlank(lat) && !between(lat, -90, 90)) add("latitude", "Latitude must be between -90 and 90.");
    if (!isBlank(lon) && !between(lon, -180, 180)) add("longitude", "Longitude must be between -180 and 180.");
    if (!isBlank(alt)) {
      if (isBlank(lat) || isBlank(lon)) add("altitude", "Altitude needs a latitude and longitude.");
      else if (!between(alt, -12000, 100000)) add("altitude", "Altitude must be between -12,000 and 100,000 metres.");
    }
    return problems;
  }

  Datum.examifSchema = schema;
  Datum.validateFields = validateFields;
  Datum.ORIENTATION_OPTIONS = ORIENTATION_OPTIONS;
  Datum.CATEGORY_LABELS = CATEGORY_LABELS;
  Datum.EXIFR_KEY_MAP = EXIFR_KEY_MAP;
})(window.Datum = window.Datum || {});
