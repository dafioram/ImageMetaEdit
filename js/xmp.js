/* XMP location handling. XMP (Adobe's XML metadata, written by Lightroom,
   Photoshop, Google Photos and many phones) can carry its own copy of the
   GPS position, separate from EXIF. The editor only shows EXIF, so when the
   user changes or clears the location, the XMP copy is removed too:
   otherwise it would contradict the new location or leak the old one. */
(function (Datum) {
  "use strict";

  const EXIF_NS = "http://ns.adobe.com/exif/1.0/";

  function isGpsName(localName) {
    return /^GPS/.test(localName);
  }

  function parseXml(text) {
    // Some writers pad the packet with NUL or whitespace after the end.
    const clean = text.replace(/\u0000+$/, "");
    const doc = new DOMParser().parseFromString(clean, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  }

  function hasGps(text) {
    if (!text) return false;
    const doc = parseXml(text);
    if (!doc) return /GPS(Latitude|Longitude)/.test(text);
    for (const el of doc.getElementsByTagNameNS(EXIF_NS, "*")) if (isGpsName(el.localName)) return true;
    for (const el of doc.getElementsByTagName("*")) {
      for (const attr of el.attributes) if (attr.namespaceURI === EXIF_NS && isGpsName(attr.localName)) return true;
    }
    return false;
  }

  // Returns the packet with every exif:GPS* property removed, or null if
  // the XML cannot be parsed (the caller then drops the whole packet).
  function removeGps(text) {
    const doc = parseXml(text);
    if (!doc) return null;
    for (const el of Array.from(doc.getElementsByTagNameNS(EXIF_NS, "*"))) {
      if (isGpsName(el.localName) && el.parentNode) el.parentNode.removeChild(el);
    }
    for (const el of Array.from(doc.getElementsByTagName("*"))) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.namespaceURI === EXIF_NS && isGpsName(attr.localName)) el.removeAttributeNode(attr);
      }
    }
    return new XMLSerializer().serializeToString(doc);
  }

  Datum.xmp = { hasGps, removeGps };
})(window.Datum = window.Datum || {});
