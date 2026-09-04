/* GPS coordinate helpers: decimal <-> DMS, EXIF rational encoding, validation. */
(function (Datum) {
  "use strict";

  function clampLat(v) { return Math.max(-90, Math.min(90, v)); }
  function clampLon(v) { return Math.max(-180, Math.min(180, v)); }

  function isValidLat(v) { return typeof v === "number" && isFinite(v) && v >= -90 && v <= 90; }
  function isValidLon(v) { return typeof v === "number" && isFinite(v) && v >= -180 && v <= 180; }

  // decimal degrees -> {deg, min, sec} (unsigned magnitude)
  function toDMSParts(decimalDeg) {
    const abs = Math.abs(decimalDeg);
    const deg = Math.floor(abs);
    const minFloat = (abs - deg) * 60;
    const min = Math.floor(minFloat);
    const sec = (minFloat - min) * 60;
    return { deg, min, sec };
  }

  function formatDMS(decimalDeg, isLat) {
    if (typeof decimalDeg !== "number" || !isFinite(decimalDeg)) return "—";
    const { deg, min, sec } = toDMSParts(decimalDeg);
    const hemi = isLat ? (decimalDeg >= 0 ? "N" : "S") : (decimalDeg >= 0 ? "E" : "W");
    return deg + "\u00B0 " + min + "' " + sec.toFixed(2) + '" ' + hemi;
  }

  // decimal degrees -> EXIF rational triple [[d,1],[m,1],[s*100,100]]
  function toExifRational(decimalDeg) {
    const { deg, min, sec } = toDMSParts(decimalDeg);
    const secNum = Math.round(sec * 1000);
    return [[deg, 1], [min, 1], [secNum, 1000]];
  }

  // EXIF GPS rational triple + ref -> signed decimal degrees
  function fromExifRational(ref, rational) {
    if (!rational || rational.length < 3) return null;
    const part = (pair) => {
      if (!pair) return 0;
      const num = pair[0], den = pair[1] || 1;
      return den === 0 ? 0 : num / den;
    };
    const deg = part(rational[0]);
    const min = part(rational[1]);
    const sec = part(rational[2]);
    let value = deg + min / 60 + sec / 3600;
    if (ref === "S" || ref === "W") value = -value;
    return value;
  }

  function altitudeToExif(meters) {
    const abs = Math.abs(meters);
    return [Math.round(abs * 100), 100];
  }

  function altitudeFromExif(ref, rational) {
    if (!rational) return null;
    const num = rational[0], den = rational[1] || 1;
    let val = den === 0 ? 0 : num / den;
    if (ref === 1) val = -val;
    return val;
  }

  Datum.gps = {
    clampLat, clampLon, isValidLat, isValidLon,
    toDMSParts, formatDMS,
    toExifRational, fromExifRational,
    altitudeToExif, altitudeFromExif
  };
})(window.Datum = window.Datum || {});
