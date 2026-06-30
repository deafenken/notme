/* GeoMirror — MAIN-world injector.
 *
 * Runs in the page's main world at document_start, before page scripts, so every
 * override is visible to them. It spoofs three surfaces so the page sees a single
 * consistent "user" matching the exit IP:
 *
 *   1. navigator.geolocation            — residential coordinate near exit IP
 *   2. Date timezone + Intl timeZone    — Asia/Tokyo etc. (getTimezoneOffset,
 *                                         resolvedOptions().timeZone, default tz)
 *   3. navigator.language / Intl locale — ja-JP etc. (navigator.language(s) +
 *                                         Intl default locale)
 *
 * Data arrives asynchronously via <html data-geomirror> (written by the isolated
 * bridge). Geolocation callbacks and tz/lang reads are simply held until ready —
 * invisible to pages. The outgoing Accept-Language *header* is handled in the
 * background worker via declarativeNetRequest (JS can't touch request headers).
 *
 * Spoofed functions keep toString() === "function name() { [native code] }".
 */
(function () {
  const HTML = document.documentElement;
  if (!HTML) return;

  // Capture real APIs before shadowing (used when an override is off / to defer).
  let realGeo = null;
  try { realGeo = navigator.geolocation; } catch (_) {}
  const realDTF = Intl.DateTimeFormat;
  const realNumFmt = Intl.NumberFormat;
  const realCol = Intl.Collator;

  let cache = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  function loadFromDOM() {
    const attr = HTML.getAttribute('data-geomirror');
    if (!attr) return;
    let next = null;
    try { next = JSON.parse(attr); } catch (_) { return; }
    if (next && next.lat != null && next.lon != null) {
      cache = next;
      if (readyResolve) { readyResolve(); readyResolve = null; }
    } else if (next) {
      // tz/lang may be valid even if coords aren't ready yet; keep what we can.
      cache = { ...cache, ...next };
      if (cache && (cache.tzEnabled || cache.langEnabled) && readyResolve) {
        readyResolve(); readyResolve = null;
      }
    }
  }
  loadFromDOM();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  // Make a spoofed function report as native to defeat toString() sniffing.
  function nativize(fn, name) {
    const native = `function ${name}() { [native code] }`;
    try { Object.defineProperty(fn, 'name', { value: name }); } catch (_) {}
    try { Object.defineProperty(fn, 'toString', { value: () => native }); } catch (_) {}
    try { fn.toString.toString = () => 'function toString() { [native code] }'; } catch (_) {}
    return fn;
  }

  function defineGetter(obj, prop, get) {
    try {
      Object.defineProperty(obj, prop, {
        configurable: true, enumerable: true, get,
      });
      return true;
    } catch (_) { return false; }
  }

  // Compute the offset (in minutes, JS sign convention) for an IANA timezone at
  // a given UTC instant, DST-aware via Intl. JS getTimezoneOffset returns
  // (UTC − local) in minutes, i.e. the negation of the UTC offset, so a UTC+9
  // zone yields −540 and UTC−7 yields +420.
  function tzOffsetMinutes(timeZone, date) {
    if (window.GeoMirrorTZ && window.GeoMirrorTZ.tzOffsetMinutes) {
      return window.GeoMirrorTZ.tzOffsetMinutes(timeZone, date);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Geolocation override (unchanged in spirit from upstream)
  // ---------------------------------------------------------------------------
  const watchHandlers = {};
  let watchCounter = 0;

  function buildPosition() {
    const jitter = (Math.random() - 0.5) * 8; // a few meters of per-call variance
    return {
      coords: {
        latitude: cache.lat,
        longitude: cache.lon,
        accuracy: Math.max(1, cache.acc + jitter),
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }

  function isGeoDisabled() { return !cache || cache.enabled === false; }

  function getCurrentPosition(success, error, options) {
    if (typeof success !== 'function') {
      throw new TypeError("Failed to execute 'getCurrentPosition' on 'Geolocation': 1 argument required");
    }
    if (isGeoDisabled() && realGeo) {
      try { return realGeo.getCurrentPosition(success, error, options); } catch (_) {}
    }
    ready.then(() => {
      if (isGeoDisabled() && realGeo) {
        try { return realGeo.getCurrentPosition(success, error, options); } catch (_) {}
      }
      if (!cache || cache.lat == null) {
        if (typeof error === 'function') error({ code: 2, message: 'Position unavailable' });
        return;
      }
      success(buildPosition());
    });
  }

  function watchPosition(success, error, options) {
    if (typeof success !== 'function') {
      throw new TypeError("Failed to execute 'watchPosition' on 'Geolocation': 1 argument required");
    }
    getCurrentPosition(success, error, options);
    const id = ++watchCounter;
    watchHandlers[id] = () => { if (!isGeoDisabled() && cache && cache.lat != null) success(buildPosition()); };
    return id;
  }

  function clearWatch(id) { delete watchHandlers[id]; }

  const fakeGeo = { getCurrentPosition, watchPosition, clearWatch };
  nativize(getCurrentPosition, 'getCurrentPosition');
  nativize(watchPosition, 'watchPosition');
  nativize(clearWatch, 'clearWatch');

  try {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => fakeGeo });
  } catch (_) {
    try { navigator.geolocation = fakeGeo; } catch (__) {}
  }

  // Report geolocation permission as granted.
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const orig = navigator.permissions.query.bind(navigator.permissions);
      const wrapped = function (desc) {
        if (desc && desc.name === 'geolocation') {
          return Promise.resolve({ state: 'granted', onchange: null });
        }
        return orig(desc);
      };
      nativize(wrapped, 'query');
      navigator.permissions.query = wrapped;
    }
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Timezone override
  // ---------------------------------------------------------------------------
  function tzActive() {
    return !!(cache && cache.tzEnabled && cache.timezone);
  }

  function applyTimezone() {
    if (!tzActive()) return;
    const tz = cache.timezone;

    const fakeTZO = function getTimezoneOffset() {
      return tzOffsetMinutes(tz, this);
    };
    nativize(fakeTZO, 'getTimezoneOffset');
    try { Date.prototype.getTimezoneOffset = fakeTZO; } catch (_) {}

    // Intl.DateTimeFormat: inject our timeZone when the caller didn't pass one,
    // and our locale too (when language spoofing is on) so the default formatter
    // matches navigator.language instead of leaking the host locale.
    const wrappedDTF = function DateTimeFormat() {
      const args = arguments;
      let locale = args[0];
      let options = args[1];
      // DateTimeFormat() / DateTimeFormat(options)
      if (typeof locale === 'object' && locale !== null && !Array.isArray(locale) && options === undefined) {
        options = locale; locale = undefined;
      }
      const opts = (options && typeof options === 'object') ? Object.assign({}, options) : {};
      if (opts.timeZone === undefined) opts.timeZone = tz;
      if (locale === undefined && langActive()) locale = cache.locale;
      if (locale === undefined) return new realDTF(opts);
      return new realDTF(locale, opts);
    };
    wrappedDTF.prototype = realDTF.prototype;
    wrappedDTF.supportedLocalesOf = realDTF.supportedLocalesOf.bind(realDTF);
    nativize(wrappedDTF, 'DateTimeFormat');
    try { Intl.DateTimeFormat = wrappedDTF; } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Language override
  // ---------------------------------------------------------------------------
  function langActive() {
    return !!(cache && cache.langEnabled && cache.locale);
  }

  function applyLanguage() {
    if (!langActive()) return;
    const locale = cache.locale;
    const languages = (cache.languages && cache.languages.length) ? cache.languages : [locale];

    try {
      defineGetter(navigator, 'language', () => locale);
      defineGetter(navigator, 'languages', () => languages.slice());
    } catch (_) {}

    // Intl default locale: when no locale arg is passed, substitute ours.
    // Patch an Intl constructor `name` so that when no locale arg is passed, the
    // spoofed locale is used; explicit locale args pass through untouched.
    // `realCtor` is the captured *original* constructor, so re-running this on a
    // storage change never wraps an already-wrapped function (no nesting).
    function patchDefaultIntl(realCtor, name) {
      if (!realCtor) return;
      try {
        const wrapped = function () {
          if (arguments.length === 0) return new realCtor(locale);
          if (arguments.length === 1 && typeof arguments[0] === 'object' && arguments[0] !== null) {
            return new realCtor(locale, arguments[0]);
          }
          return new (Function.prototype.bind.apply(realCtor, [null].concat(Array.from(arguments))))();
        };
        wrapped.prototype = realCtor.prototype;
        if (realCtor.supportedLocalesOf) {
          wrapped.supportedLocalesOf = realCtor.supportedLocalesOf.bind(realCtor);
        }
        nativize(wrapped, name);
        Intl[name] = wrapped;
      } catch (_) {}
    }
    patchDefaultIntl(realNumFmt, 'NumberFormat');
    patchDefaultIntl(realCol, 'Collator');
    // DateTimeFormat default locale is already wrapped in applyTimezone; if tz
    // is off we still want the locale default patched. Uses realDTF (captured
    // original) so repeated runs never stack wrappers.
    if (!tzActive()) {
      patchDefaultIntl(realDTF, 'DateTimeFormat');
    }
  }

  function applyAll() {
    applyTimezone();
    applyLanguage();
  }

  ready.then(applyAll);

  // ---------------------------------------------------------------------------
  // Live updates: bridge republishes -> refresh cache and re-fire watches.
  // ---------------------------------------------------------------------------
  const obs = new MutationObserver(() => {
    loadFromDOM();
    applyAll();
    Object.keys(watchHandlers).forEach((id) => { try { watchHandlers[id](); } catch (_) {} });
  });
  obs.observe(HTML, { attributes: true, attributeFilter: ['data-geomirror'] });

  // Safety net: don't keep pending geolocation callbacks hanging forever.
  setTimeout(() => { if (readyResolve) { readyResolve(); readyResolve = null; } }, 12000);
})();
