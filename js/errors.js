/* Turns errors from the bundled libraries into sentences a person can act
   on. Library messages ("'pack' error.", "Given data is not jpeg.") name an
   internal step, not the problem; the original text is kept in brackets
   only when nothing better is known. */
(function (Datum) {
  "use strict";

  const KNOWN = [
    [/'pack' error/i, "a metadata value is out of the range a file can store"],
    [/Given data is not jpeg|Not a JPEG file/i, "the file's data isn't a valid JPEG"],
    [/Not a PNG file/i, "the file's data isn't a valid PNG"],
    [/Corrupt JPEG: (.*)/i, (m) => "the JPEG is damaged: " + m[1]],
    [/HEIC decoder failed to load/i, "the HEIC decoder couldn't start in this browser"],
    [/No image found in this HEIC/i, "the HEIC file contains no image"],
    [/Could not decode/i, "the image data couldn't be decoded"],
  ];

  function trimSentence(text) {
    return String(text).trim().replace(/[.\s]+$/, "");
  }

  // A clause, without a trailing period, describing what went wrong.
  function describe(err) {
    const message = trimSentence((err && err.message) || err || "unknown error");
    for (const [pattern, text] of KNOWN) {
      const m = message.match(pattern);
      if (m) return typeof text === "function" ? trimSentence(text(m)) : text;
    }
    if (err && err.userFacing) return message;
    return "an unexpected error (" + message + ")";
  }

  // An Error whose message is already written for people.
  function userError(message) {
    const e = new Error(trimSentence(message));
    e.userFacing = true;
    return e;
  }

  // Ensures exactly one period at the end.
  function sentence(text) {
    const t = trimSentence(text);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) + "." : "";
  }

  Datum.errors = { describe, userError, sentence, trimSentence };
})(window.Datum = window.Datum || {});
