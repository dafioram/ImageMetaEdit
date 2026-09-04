/* piexifjs works with "binary strings" (one JS char per byte), the old
   browser convention from readAsBinaryString/atob. These helpers convert
   to/from that representation in chunks so large photos don't blow the
   call stack or choke on a single huge String.fromCharCode call. */
(function (Datum) {
  "use strict";

  const CHUNK = 0x8000;

  function uint8ToBinaryString(bytes) {
    let result = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
      result += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return result;
  }

  function binaryStringToUint8(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
  }

  async function fileToUint8Array(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  Datum.bin = { uint8ToBinaryString, binaryStringToUint8, fileToUint8Array };
})(window.Datum = window.Datum || {});
