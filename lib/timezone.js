/* GeoMirror — timezone helpers.
 *
 * Shared by the MAIN-world injector and the Node test harness. These helpers
 * are the single source of truth for turning a UTC instant into the wall clock
 * of an arbitrary IANA timezone (DST-aware), so every Date/Intl surface the
 * injector spoofs stays internally consistent.
 */
(function () {
  'use strict';
  const root = (typeof self !== 'undefined') ? self
             : (typeof globalThis !== 'undefined') ? globalThis
             : (typeof global !== 'undefined') ? global : this;

  // Capture the real Date / Intl.DateTimeFormat at load time. This file is the
  // first script in the MAIN-world content_scripts list, so it runs before
  // content-inject.js shadows Date / Intl — the captures below are pristine.
  const RealDate = Date;
  const RealDateTimeFormat = Intl.DateTimeFormat;

  function validDateOrNow(date) {
    if (date instanceof RealDate && Number.isFinite(date.getTime())) return date;
    return new RealDate();
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // Memoize the (stateless) Intl.DateTimeFormat instances so the Date wrappers
  // don't build a fresh formatter on every getHours()/toString() call — that
  // would cause main-thread jank on date-heavy pages.
  const _offsetFmt = new Map();
  const _nameFmt = new Map();
  function offsetFormatter(timeZone) {
    let f = _offsetFmt.get(timeZone);
    if (!f) {
      f = new RealDateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      _offsetFmt.set(timeZone, f);
    }
    return f;
  }
  function nameFormatter(timeZone, style) {
    const key = timeZone + '|' + style;
    let f = _nameFmt.get(key);
    if (!f) {
      f = new RealDateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false, timeZoneName: style });
      _nameFmt.set(key, f);
    }
    return f;
  }

  // JavaScript sign convention: Date#getTimezoneOffset returns UTC - local in
  // minutes. UTC+9 => -540. UTC-7 => +420.
  function tzOffsetMinutes(timeZone, date) {
    try {
      const instant = validDateOrNow(date);
      const parts = offsetFormatter(timeZone).formatToParts(instant).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
      }, {});
      let hour = parts.hour;
      if (hour === '24') hour = '00';
      const wallAsUtc = RealDate.UTC(
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

  // Wall-clock components of `date` as seen in `timeZone`. month is 0-11 and
  // weekday is 0-6 (Sun=0), matching Date's local getters. Returns null for an
  // invalid timezone. Uses the shifted-epoch trick: shift the UTC instant by the
  // (DST-aware) offset, then read the UTC fields — those equal the target zone's
  // wall-clock fields, and milliseconds survive because offsets are whole minutes.
  function wallClock(timeZone, date) {
    const d = validDateOrNow(date);
    const off = tzOffsetMinutes(timeZone, d);
    if (off == null) return null;
    const shifted = new RealDate(d.getTime() - off * 60000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
      ms: shifted.getUTCMilliseconds(),
      weekday: shifted.getUTCDay(),
    };
  }

  // Inverse of wallClock: given wall-clock components interpreted in `timeZone`,
  // return the UTC epoch (ms). Components are normalized via Date.UTC (so month
  // 13 rolls over, etc.). DST transitions are months apart, so sampling the
  // offset a day either side of the naive instant brackets at most one
  // transition; on a transition day we prefer the earlier (pre-transition)
  // offset when it is self-consistent — matching how a browser running in that
  // zone resolves ambiguous (fall-back) and nonexistent (spring-forward) times.
  function localWallToEpoch(timeZone, y, mo, d, h, mi, s, ms) {
    const e0 = RealDate.UTC(y, mo, d, h || 0, mi || 0, s || 0, ms || 0);
    const offBefore = tzOffsetMinutes(timeZone, new RealDate(e0 - 86400000));
    const offAfter = tzOffsetMinutes(timeZone, new RealDate(e0 + 86400000));
    if (offBefore == null && offAfter == null) return e0;
    if (offBefore == null) return e0 + offAfter * 60000;
    if (offAfter == null || offBefore === offAfter) return e0 + offBefore * 60000;
    // Transition within ±1 day: pick the self-consistent candidate, earlier first.
    const candA = e0 + offBefore * 60000;
    if (tzOffsetMinutes(timeZone, new RealDate(candA)) === offBefore) return candA;
    const candB = e0 + offAfter * 60000;
    if (tzOffsetMinutes(timeZone, new RealDate(candB)) === offAfter) return candB;
    return candA; // spring-forward gap: pre-transition offset, shifts forward like V8
  }

  // Localized timezone display name (e.g. "Japan Standard Time" for style
  // 'long', "GMT+9"/"JST" for 'short'). Always resolved in en-US to match the
  // English string Date#toString emits regardless of the page locale.
  function tzName(timeZone, date, style) {
    try {
      const part = nameFormatter(timeZone, style || 'long').formatToParts(validDateOrNow(date))
        .find((p) => p.type === 'timeZoneName');
      return part ? part.value : '';
    } catch (_) {
      return '';
    }
  }

  // Format a getTimezoneOffset() value (UTC-local minutes) as the "GMT+0900"
  // suffix Date#toString uses. offset -540 (UTC+9) => "GMT+0900".
  function formatGMT(offsetMinutes) {
    const real = -offsetMinutes;           // real UTC offset in minutes
    const sign = real >= 0 ? '+' : '-';
    const abs = Math.abs(real);
    return 'GMT' + sign + pad2(Math.floor(abs / 60)) + pad2(abs % 60);
  }

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Reproduce the native Date#toString / toDateString / toTimeString strings for
  // `date` as if the machine were in `timeZone`. Returns { date, time } where
  //   date = "Sun Jul 05 2026"
  //   time = "14:44:13 GMT+0900 (Japan Standard Time)"
  function nativeDateStrings(timeZone, date) {
    const w = wallClock(timeZone, date);
    if (!w) return null;
    const off = tzOffsetMinutes(timeZone, date);
    const datePart = `${WEEKDAYS[w.weekday]} ${MONTHS[w.month]} ${pad2(w.day)} ${w.year}`;
    const timePart = `${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)} `
      + `${formatGMT(off)} (${tzName(timeZone, date, 'long')})`;
    return { date: datePart, time: timePart };
  }

  const GeoMirrorTZ = {
    tzOffsetMinutes, wallClock, localWallToEpoch, tzName, formatGMT,
    nativeDateStrings,
  };
  root.GeoMirrorTZ = GeoMirrorTZ;
  if (typeof module !== 'undefined' && module.exports) module.exports = GeoMirrorTZ;
})();
