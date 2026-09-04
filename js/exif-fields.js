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

  Datum.examifSchema = schema;
  Datum.ORIENTATION_OPTIONS = ORIENTATION_OPTIONS;
  Datum.CATEGORY_LABELS = CATEGORY_LABELS;
  Datum.EXIFR_KEY_MAP = EXIFR_KEY_MAP;
})(window.Datum = window.Datum || {});
