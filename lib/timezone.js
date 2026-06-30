/* GeoMirror — timezone helpers.
 *
 * Shared by the MAIN-world injector and the Node test harness. The core helper
 * computes the JavaScript Date#getTimezoneOffset value for an arbitrary IANA
 * timezone at a specific UTC instant, including DST.
 */
(function () {
  'use strict';
  const root = (typeof self !== 'undefined') ? self
             : (typeof globalThis !== 'undefined') ? globalThis
             : (typeof global !== 'undefined') ? global : this;

  const RealDateTimeFormat = Intl.DateTimeFormat;

  function validDateOrNow(date) {
    if (date instanceof Date && Number.isFinite(date.getTime())) return date;
    return new Date();
  }

  // JavaScript sign convention: Date#getTimezoneOffset returns UTC - local in
  // minutes. UTC+9 => -540. UTC-7 => +420.
  function tzOffsetMinutes(timeZone, date) {
    try {
      const instant = validDateOrNow(date);
      const dtf = new RealDateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const parts = dtf.formatToParts(instant).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
      let hour = parts.hour;
      if (hour === '24') hour = '00';
      const wallAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(hour),
        Number(parts.minute),
        Number(parts.second)
      );
      const offset = -Math.round((wallAsUtc - instant.getTime()) / 60000);
      return Object.is(offset, -0) ? 0 : offset;
    } catch (_) {
      return null;
    }
  }

  const GeoMirrorTZ = { tzOffsetMinutes };
  root.GeoMirrorTZ = GeoMirrorTZ;
  if (typeof module !== 'undefined' && module.exports) module.exports = GeoMirrorTZ;
})();
