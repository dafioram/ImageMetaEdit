/* Thin wrapper around the Leaflet map used in the GPS panel. One map
   instance is reused across file switches; the tab panel is re-created in
   the DOM each time (see ui.js), so init() re-attaches to the fresh #map
   container. */
(function (Datum) {
  "use strict";

  let map = null;
  let marker = null;
  let clickHandler = null;

  function init(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    if (map) {
      map.remove();
      map = null;
      marker = null;
    }
    map = L.map(containerId, { zoomControl: true, attributionControl: true }).setView([20, 0], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '\u00A9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on("click", (e) => {
      if (clickHandler) clickHandler(e.latlng.lat, e.latlng.lng);
    });
    setTimeout(() => map && map.invalidateSize(), 30);
    return map;
  }

  function onClick(fn) { clickHandler = fn; }

  function setPosition(lat, lon, opts) {
    if (!map) return;
    opts = opts || {};
    const noPos = lat === null || lat === undefined || lat === "" || !isFinite(lat) ||
      lon === null || lon === undefined || lon === "" || !isFinite(lon);
    if (noPos) {
      if (marker) { map.removeLayer(marker); marker = null; }
      return;
    }
    const latlng = [Number(lat), Number(lon)];
    if (!marker) {
      marker = L.marker(latlng, { draggable: true }).addTo(map);
      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        if (clickHandler) clickHandler(pos.lat, pos.lng);
      });
    } else {
      marker.setLatLng(latlng);
    }
    if (opts.recenter !== false) {
      map.setView(latlng, opts.zoom || Math.max(map.getZoom(), 11));
    }
  }

  function invalidateSize() {
    if (map) setTimeout(() => map.invalidateSize(), 60);
  }

  Datum.mapWidget = { init, onClick, setPosition, invalidateSize };
})(window.Datum = window.Datum || {});
