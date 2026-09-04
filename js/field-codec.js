/* Value codecs for the curated editable fields: rationals (aperture, focal
   length), exposure time (supports "1/250" fraction entry), and EXIF date
   strings <-> the <input type="datetime-local"> format. */
(function (Datum) {
  "use strict";

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }

  function decimalToRational(value, maxDen) {
    maxDen = maxDen || 10000;
    if (!isFinite(value)) return [0, 1];
    let num = Math.round(value * maxDen);
    let den = maxDen;
    const g = gcd(num, den);
    if (g > 1) { num /= g; den /= g; }
    if (den === 0) den = 1;
    return [num, den];
  }

  function rationalToDecimal(pair) {
    if (!pair) return null;
    const num = Array.isArray(pair) ? pair[0] : pair;
    const den = Array.isArray(pair) ? (pair[1] || 1) : 1;
    return den === 0 ? 0 : num / den;
  }

  // Accepts "1/250", "250" (treated as 1/250 shutter-speed shorthand is NOT
  // assumed -- a bare number is treated as whole seconds), or "0.004".
  function parseExposureInput(str) {
    str = String(str).trim();
    if (/^\d+\s*\/\s*\d+$/.test(str)) {
      const [n, d] = str.split("/").map((s) => parseInt(s.trim(), 10));
      return [n, d || 1];
    }
    const val = parseFloat(str);
    if (!isFinite(val) || val <= 0) return null;
    return decimalToRational(val, val < 1 ? 1000000 : 1000);
  }

  function formatExposureTime(pair) {
    const val = rationalToDecimal(pair);
    if (val === null || !isFinite(val)) return "";
    if (val > 0 && val < 1) {
      const denom = Math.round(1 / val);
      return "1/" + denom;
    }
    // trim trailing zeros
    return String(Math.round(val * 1000) / 1000);
  }

  // "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS" -> "YYYY:MM:DD HH:MM:SS"
  function dateInputToExif(value) {
    if (!value) return null;
    const [datePart, timePart] = value.split("T");
    if (!datePart || !timePart) return null;
    const time = timePart.length === 5 ? timePart + ":00" : timePart;
    return datePart.replace(/-/g, ":") + " " + time;
  }

  // "YYYY:MM:DD HH:MM:SS" (or Date object from exifr's reviveValues) ->
  // "YYYY-MM-DDTHH:MM:SS" for a datetime-local input's value attribute.
  function exifDateToInput(value) {
    if (!value) return "";
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return "";
      const pad = (n) => String(n).padStart(2, "0");
      return value.getFullYear() + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate()) +
        "T" + pad(value.getHours()) + ":" + pad(value.getMinutes()) + ":" + pad(value.getSeconds());
    }
    const str = String(value).trim();
    const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return "";
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }

  Datum.fieldCodec = {
    decimalToRational, rationalToDecimal,
    parseExposureInput, formatExposureTime,
    dateInputToExif, exifDateToInput,
  };
})(window.Datum = window.Datum || {});
