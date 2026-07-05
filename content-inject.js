/* GeoMirror — MAIN-world injector.
 *
 * Runs in the page's main world at document_start, before page scripts, so every
 * override is visible to them. It makes the page see a single consistent "user"
 * matching the exit IP by spoofing, coherently:
 *
 *   1. navigator.geolocation            — residential coordinate near exit IP
 *   2. the ENTIRE Date local-time surface in the exit-IP timezone:
 *        getTimezoneOffset, the local getters (getHours/getDate/getDay/getMonth/
 *        getFullYear/…), the local setters, toString/toDateString/toTimeString,
 *        toLocaleString/…, the numeric multi-arg constructor, offset-less
 *        Date.parse, and Date() called as a function — so no Date method
 *        contradicts getTimezoneOffset().
 *   3. Intl timezone + locale            — Asia/Tokyo / ja-JP across DateTimeFormat,
 *        NumberFormat, Collator, RelativeTimeFormat, PluralRules, ListFormat,
 *        DisplayNames, Segmenter, DurationFormat, plus Number/Array/BigInt
 *        toLocaleString.
 *   4. navigator.language / languages    — ja-JP etc.
 *
 * Design: every override is installed ONCE and consults the live override state
 * (`cache` + tzActive()/langActive()) on each call. When a surface's feature is
 * toggled off it transparently delegates to the captured native behavior, so
 * enabling/disabling in the popup takes effect live with no page reload and no
 * risk of stacking wrappers.
 *
 * Anti-detection: wrapper methods are built with method-definition semantics so
 * they carry no own `prototype`/`toString` property and report the correct
 * `.length`; the intrinsic Function.prototype.toString maps them to native
 * source; replaced constructors get a non-writable `prototype`. The override is
 * delivered by window.postMessage (not a DOM attribute a page could observe).
 *
 * Data arrives from content-bridge.js (isolated world) via window.postMessage
 * (a CustomEvent's `detail` does not cross the isolated→MAIN boundary). The
 * outgoing Accept-Language header is handled in the background worker.
 */
(function () {
  const TZ = window.GeoMirrorTZ || null;
  const MARK = '__geomirror__'; // window.postMessage marker (CustomEvent detail
                                // does not cross the isolated→MAIN world boundary)

  // ---------------------------------------------------------------------------
  // Capture pristine natives BEFORE shadowing anything.
  // ---------------------------------------------------------------------------
  let realGeo = null;
  try { realGeo = navigator.geolocation; } catch (_) {}

  const realDTF = Intl.DateTimeFormat;
  const realNumFmt = Intl.NumberFormat;
  const realCol = Intl.Collator;

  const RealDate = Date;
  const D = Date.prototype;
  const realGetTime = D.getTime;
  const realSetTime = D.setTime;
  const realParse = Date.parse;
  const realDateToString = D.toString;
  const realDateToDateString = D.toDateString;
  const realDateToTimeString = D.toTimeString;
  const realDateToLocaleString = D.toLocaleString;
  const realDateToLocaleDateString = D.toLocaleDateString;
  const realDateToLocaleTimeString = D.toLocaleTimeString;
  const realGetTZO = D.getTimezoneOffset;
  const realLocalGetters = {
    getFullYear: D.getFullYear, getMonth: D.getMonth, getDate: D.getDate,
    getDay: D.getDay, getHours: D.getHours, getMinutes: D.getMinutes,
    getSeconds: D.getSeconds, getMilliseconds: D.getMilliseconds, getYear: D.getYear,
  };
  const realLocalSetters = {
    setFullYear: D.setFullYear, setMonth: D.setMonth, setDate: D.setDate,
    setHours: D.setHours, setMinutes: D.setMinutes, setSeconds: D.setSeconds,
    setMilliseconds: D.setMilliseconds, setYear: D.setYear,
  };

  const realNumberToLocale = Number.prototype.toLocaleString;
  const realArrayToLocale = Array.prototype.toLocaleString;
  const realBigIntToLocale = (typeof BigInt !== 'undefined') ? BigInt.prototype.toLocaleString : null;
  const realFnToString = Function.prototype.toString;

  // ---------------------------------------------------------------------------
  // Override state (published by the isolated bridge).
  // ---------------------------------------------------------------------------
  let cache = null;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  // The three surfaces are independent toggles (Location / Timezone / Language),
  // matching the popup — timezone and language don't depend on the geolocation
  // ("Location spoof") switch.
  function tzActive() { return !!(cache && cache.tzEnabled && cache.timezone && TZ); }
  function langActive() { return !!(cache && cache.langEnabled && cache.locale); }

  // ---------------------------------------------------------------------------
  // Native-identity helpers.
  // ---------------------------------------------------------------------------
  const spoofedNames = new WeakMap();
  const nativeStr = (name) => `function ${name}() { [native code] }`;

  // Build a wrapper with method-definition semantics: NO own `prototype` and NO
  // own `toString` property (native methods/getters have neither), the correct
  // `.name` and `.length`, and registration so Function.prototype.toString
  // reports it as native. `impl` runs with the original receiver and arguments.
  function makeMethod(name, length, impl) {
    const holder = { [name](...args) { return impl.apply(this, args); } };
    const fn = holder[name];
    if (typeof length === 'number') {
      try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (_) {}
    }
    spoofedNames.set(fn, nativeStr(name));
    return fn;
  }

  // Finish a replacement constructor so it matches native shape: correct name +
  // length, a NON-writable `prototype` (native constructor prototypes are
  // non-writable), and native-looking toString. Returns fn.
  function finishCtor(fn, name, length, proto) {
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
    try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (_) {}
    fn.prototype = proto;
    try { Object.defineProperty(fn, 'prototype', { writable: false }); } catch (_) {}
    spoofedNames.set(fn, nativeStr(name));
    return fn;
  }

  function defineOn(obj, prop, getter) {
    try {
      Object.defineProperty(obj, prop, { configurable: true, enumerable: true, get: getter });
      return true;
    } catch (_) { return false; }
  }

  // Replace the intrinsic Function.prototype.toString so that
  // Function.prototype.toString.call(spoofedFn) — the canonical one-line spoof
  // check — returns "[native code]" for every wrapper. All other functions
  // delegate unchanged, preserving the correct TypeError on bad receivers.
  (function patchFunctionToString() {
    const fake = makeMethod('toString', 0, function () {
      const canned = spoofedNames.get(this);
      if (canned !== undefined) return canned;
      return realFnToString.apply(this, arguments);
    });
    try { Function.prototype.toString = fake; } catch (_) {}
  })();

  // ---------------------------------------------------------------------------
  // Geolocation override — patch Geolocation.prototype so navigator.geolocation
  // stays the real object (correct instanceof / no own properties / no fake
  // accessor). Methods delegate to native when location spoofing is off.
  // ---------------------------------------------------------------------------
  const watchHandlers = {};
  let watchCounter = 0;

  function buildPosition() {
    const jitter = (Math.random() - 0.5) * 8; // a few meters of per-call variance
    const coords = {
      latitude: cache.lat, longitude: cache.lon,
      accuracy: Math.max(1, cache.acc + jitter),
      altitude: null, altitudeAccuracy: null, heading: null, speed: null,
    };
    const pos = { coords, timestamp: Date.now() };
    // Give the objects the right prototypes so `pos instanceof GeolocationPosition`
    // and Object.prototype.toString.call(pos) match a real fix. The own data
    // properties above shadow the prototype's internal-slot getters.
    try {
      if (typeof GeolocationCoordinates !== 'undefined') Object.setPrototypeOf(coords, GeolocationCoordinates.prototype);
      if (typeof GeolocationPosition !== 'undefined') Object.setPrototypeOf(pos, GeolocationPosition.prototype);
    } catch (_) {}
    return pos;
  }

  function isGeoDisabled() { return !cache || cache.enabled === false; }

  (function installGeolocation() {
    const proto = realGeo && Object.getPrototypeOf(realGeo);
    if (!proto || typeof proto.getCurrentPosition !== 'function') return;
    const realGetCurrent = proto.getCurrentPosition;
    const realWatch = proto.watchPosition;
    const realClear = proto.clearWatch;

    const getCurrentPosition = makeMethod('getCurrentPosition', 1, function (success, error, options) {
      if (typeof success !== 'function') {
        throw new TypeError("Failed to execute 'getCurrentPosition' on 'Geolocation': 1 argument required, but only 0 present.");
      }
      const self = this;
      if (isGeoDisabled()) { try { return realGetCurrent.call(self, success, error, options); } catch (_) {} }
      ready.then(() => {
        if (isGeoDisabled()) { try { return realGetCurrent.call(self, success, error, options); } catch (_) {} }
        if (!cache || cache.lat == null) {
          if (typeof error === 'function') error({ code: 2, message: 'Position unavailable' });
          return;
        }
        success(buildPosition());
      });
    });

    const watchPosition = makeMethod('watchPosition', 1, function (success, error, options) {
      if (typeof success !== 'function') {
        throw new TypeError("Failed to execute 'watchPosition' on 'Geolocation': 1 argument required, but only 0 present.");
      }
      if (isGeoDisabled()) { try { return realWatch.call(this, success, error, options); } catch (_) {} }
      getCurrentPosition.call(this, success, error, options);
      const id = ++watchCounter;
      watchHandlers[id] = () => { if (!isGeoDisabled() && cache && cache.lat != null) success(buildPosition()); };
      return id;
    });

    const clearWatch = makeMethod('clearWatch', 1, function (id) {
      if (watchHandlers[id]) { delete watchHandlers[id]; return; }
      try { return realClear.call(this, id); } catch (_) {}
    });

    try { proto.getCurrentPosition = getCurrentPosition; } catch (_) {}
    try { proto.watchPosition = watchPosition; } catch (_) {}
    try { proto.clearWatch = clearWatch; } catch (_) {}
  })();

  // Report geolocation permission as granted (consistent with a silent fix), but
  // return a GENUINE PermissionStatus by delegating to native query and only
  // shadowing its `state`. Patched on Permissions.prototype (native location).
  (function installPermissions() {
    try {
      const perms = navigator.permissions;
      const proto = perms && Object.getPrototypeOf(perms);
      if (!proto || typeof proto.query !== 'function') return;
      const realQuery = proto.query;
      const wrapped = makeMethod('query', 1, function (desc) {
        if (isGeoDisabled() || !desc || desc.name !== 'geolocation') return realQuery.call(this, desc);
        return realQuery.call(this, desc).then((status) => {
          try { Object.defineProperty(status, 'state', { configurable: true, enumerable: true, get: () => 'granted' }); } catch (_) {}
          return status;
        }).catch(() => ({ state: 'granted', onchange: null }));
      });
      proto.query = wrapped;
    } catch (_) {}
  })();

  // ---------------------------------------------------------------------------
  // Timezone override — full Date local-time surface + Intl timezone.
  // ---------------------------------------------------------------------------
  function installTimezone() {
    // getTimezoneOffset — with the Invalid-Date guard every wrapper needs.
    try {
      D.getTimezoneOffset = makeMethod('getTimezoneOffset', 0, function () {
        if (tzActive() && Number.isFinite(realGetTime.call(this))) {
          const off = TZ.tzOffsetMinutes(cache.timezone, this);
          if (off != null) return off;
        }
        return realGetTZO.call(this);
      });
    } catch (_) {}

    // Local getters → wall clock in the spoofed zone.
    const getterField = {
      getFullYear: 'year', getMonth: 'month', getDate: 'day', getDay: 'weekday',
      getHours: 'hour', getMinutes: 'minute', getSeconds: 'second', getMilliseconds: 'ms',
    };
    Object.keys(getterField).forEach((name) => {
      const field = getterField[name];
      const real = realLocalGetters[name];
      try {
        D[name] = makeMethod(name, 0, function () {
          if (tzActive() && Number.isFinite(realGetTime.call(this))) {
            const w = TZ.wallClock(cache.timezone, this);
            if (w) return w[field];
          }
          return real.call(this);
        });
      } catch (_) {}
    });
    try {
      D.getYear = makeMethod('getYear', 0, function () { // deprecated: getFullYear() - 1900
        if (tzActive() && Number.isFinite(realGetTime.call(this))) {
          const w = TZ.wallClock(cache.timezone, this);
          if (w) return w.year - 1900;
        }
        return realLocalGetters.getYear.call(this);
      });
    } catch (_) {}

    // Local setters → interpret arguments as wall clock in the spoofed zone.
    function makeSetter(name, apply) {
      const real = realLocalSetters[name];
      try {
        D[name] = makeMethod(name, real.length, function () {
          if (!tzActive() || !Number.isFinite(realGetTime.call(this))) return real.apply(this, arguments);
          const w = TZ.wallClock(cache.timezone, this);
          if (!w) return real.apply(this, arguments);
          apply(w, arguments);
          const epoch = TZ.localWallToEpoch(cache.timezone, w.year, w.month, w.day, w.hour, w.minute, w.second, w.ms);
          return realSetTime.call(this, epoch);
        });
      } catch (_) {}
    }
    makeSetter('setFullYear', (w, a) => { w.year = +a[0]; if (a.length > 1) w.month = +a[1]; if (a.length > 2) w.day = +a[2]; });
    makeSetter('setMonth', (w, a) => { w.month = +a[0]; if (a.length > 1) w.day = +a[1]; });
    makeSetter('setDate', (w, a) => { w.day = +a[0]; });
    makeSetter('setHours', (w, a) => { w.hour = +a[0]; if (a.length > 1) w.minute = +a[1]; if (a.length > 2) w.second = +a[2]; if (a.length > 3) w.ms = +a[3]; });
    makeSetter('setMinutes', (w, a) => { w.minute = +a[0]; if (a.length > 1) w.second = +a[1]; if (a.length > 2) w.ms = +a[2]; });
    makeSetter('setSeconds', (w, a) => { w.second = +a[0]; if (a.length > 1) w.ms = +a[1]; });
    makeSetter('setMilliseconds', (w, a) => { w.ms = +a[0]; });
    makeSetter('setYear', (w, a) => { let y = +a[0]; if (y >= 0 && y <= 99) y += 1900; w.year = y; });

    // toString / toDateString / toTimeString rebuilt in the spoofed zone.
    function dateStringWrapper(name, real, pick) {
      try {
        D[name] = makeMethod(name, 0, function () {
          if (tzActive() && Number.isFinite(realGetTime.call(this))) {
            const s = TZ.nativeDateStrings(cache.timezone, this);
            if (s) return pick(s);
          }
          return real.call(this);
        });
      } catch (_) {}
    }
    dateStringWrapper('toString', realDateToString, (s) => s.date + ' ' + s.time);
    dateStringWrapper('toDateString', realDateToDateString, (s) => s.date);
    dateStringWrapper('toTimeString', realDateToTimeString, (s) => s.time);

    // Date#toLocale* depend on BOTH the timezone and the locale; inject whichever
    // is active into the real method. Options are inherited-safe (Object.create).
    function makeDateToLocale(real, name) {
      try {
        D[name] = makeMethod(name, 0, function (locales, options) {
          if ((!tzActive() && !langActive()) || !Number.isFinite(realGetTime.call(this))) {
            return real.call(this, locales, options);
          }
          const opts = (options && typeof options === 'object') ? Object.create(options) : {};
          if (tzActive() && opts.timeZone === undefined) opts.timeZone = cache.timezone;
          let loc = locales;
          if (langActive() && loc === undefined) loc = cache.locale;
          return real.call(this, loc, opts);
        });
      } catch (_) {}
    }
    makeDateToLocale(realDateToLocaleString, 'toLocaleString');
    makeDateToLocale(realDateToLocaleDateString, 'toLocaleDateString');
    makeDateToLocale(realDateToLocaleTimeString, 'toLocaleTimeString');
  }

  // Replace the global Date constructor so the numeric multi-arg form,
  // offset-less string parsing, and Date() called as a function all interpret
  // wall time in the spoofed zone. Everything else passes straight through, and
  // any unexpected input falls back to the native construction.
  function installDateConstructor() {
    function parseOffsetlessLocal(str) {
      const m = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*$/.exec(str);
      if (!m) return null; // date-only (UTC per spec) and offset-bearing forms pass through
      const mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +(m[6] || 0);
      // Reject fields native would treat as Invalid Date (no rollover for strings).
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
      const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
      return TZ.localWallToEpoch(cache.timezone, +m[1], mo - 1, d, h, mi, se, ms);
    }
    function adjustArgs(args) {
      if (!tzActive()) return args;
      try {
        if (args.length >= 2) {
          let y = +args[0];
          if (y >= 0 && y <= 99) y += 1900;
          const epoch = TZ.localWallToEpoch(cache.timezone, y, +args[1], args.length > 2 ? +args[2] : 1,
            args.length > 3 ? +args[3] : 0, args.length > 4 ? +args[4] : 0,
            args.length > 5 ? +args[5] : 0, args.length > 6 ? +args[6] : 0);
          return [epoch];
        }
        if (args.length === 1 && typeof args[0] === 'string') {
          const epoch = parseOffsetlessLocal(args[0]);
          if (epoch != null) return [epoch];
        }
      } catch (_) {}
      return args;
    }

    const DateProxy = function Date() {
      if (!new.target) {
        // Date(...) as a function returns the current time as a string, ignoring args.
        if (tzActive()) { const s = TZ.nativeDateStrings(cache.timezone, new RealDate()); if (s) return s.date + ' ' + s.time; }
        return realDateToString.call(new RealDate());
      }
      return Reflect.construct(RealDate, adjustArgs(arguments), new.target);
    };
    DateProxy.now = RealDate.now;   // genuine natives — leave untouched
    DateProxy.UTC = RealDate.UTC;
    DateProxy.parse = makeMethod('parse', 1, function (str) {
      if (tzActive() && typeof str === 'string') {
        try { const e = parseOffsetlessLocal(str); if (e != null) return e; } catch (_) {}
      }
      return realParse.call(RealDate, str);
    });
    finishCtor(DateProxy, 'Date', 7, RealDate.prototype);
    try { Object.defineProperty(RealDate.prototype, 'constructor', { value: DateProxy, configurable: true, writable: true }); } catch (_) {}
    try { Date = DateProxy; } catch (_) {}
    try { window.Date = DateProxy; } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Locale override — navigator.language(s), Intl defaults, *.toLocaleString.
  // ---------------------------------------------------------------------------
  function installLocale() {
    // navigator.language / languages on Navigator.prototype (native location).
    let navProto = null;
    try { navProto = Object.getPrototypeOf(navigator); } catch (_) {}
    // Capture the ORIGINAL accessors before we overwrite them, so the "spoof off"
    // path delegates to the real value instead of recursing into our own getter.
    const origLangDesc = navProto && Object.getOwnPropertyDescriptor(navProto, 'language');
    const origLangsDesc = navProto && Object.getOwnPropertyDescriptor(navProto, 'languages');
    function realNavGet(prop) {
      try {
        const desc = prop === 'languages' ? origLangsDesc : origLangDesc;
        if (desc && desc.get) return desc.get.call(navigator);
      } catch (_) {}
      return prop === 'languages' ? [] : 'en-US';
    }
    const langGetter = makeMethod('get language', 0, () => (langActive() ? cache.locale : realNavGet('language')));
    const langsGetter = makeMethod('get languages', 0, () => {
      if (langActive()) {
        const arr = (cache.languages && cache.languages.length) ? cache.languages : [cache.locale];
        return Object.freeze(arr.slice());
      }
      return realNavGet('languages');
    });
    if (!(navProto && defineOn(navProto, 'language', langGetter))) defineOn(navigator, 'language', langGetter);
    if (!(navProto && defineOn(navProto, 'languages', langsGetter))) defineOn(navigator, 'languages', langsGetter);

    // Intl.DateTimeFormat: inject our timeZone (whenever the caller didn't set
    // one) and our default locale (only when the caller passed no locale).
    const wrappedDTF = function DateTimeFormat() {
      const locale = arguments[0];
      const options = arguments[1];
      const opts = (options && typeof options === 'object') ? Object.create(options) : {};
      if (tzActive() && opts.timeZone === undefined) opts.timeZone = cache.timezone;
      let loc = locale;
      if (loc === undefined && langActive()) loc = cache.locale;
      if (new.target) return Reflect.construct(realDTF, [loc, opts], new.target);
      return realDTF(loc, opts);
    };
    finishCtor(wrappedDTF, 'DateTimeFormat', 0, realDTF.prototype);
    try { Object.defineProperty(realDTF.prototype, 'constructor', { value: wrappedDTF, configurable: true, writable: true }); } catch (_) {}
    wrappedDTF.supportedLocalesOf = bindSupported(realDTF);
    try { Intl.DateTimeFormat = wrappedDTF; } catch (_) {}

    function bindSupported(realCtor) {
      const slo = realCtor.supportedLocalesOf.bind(realCtor);
      try { Object.defineProperty(slo, 'name', { value: 'supportedLocalesOf', configurable: true }); } catch (_) {}
      spoofedNames.set(slo, nativeStr('supportedLocalesOf'));
      return slo;
    }

    // Other Intl constructors: inject the default locale when the caller passed
    // none. new.target is preserved so the legacy call-without-new behavior
    // (NumberFormat/Collator return an instance; the newer class-style ctors
    // throw) matches native exactly.
    function wrapIntlLocale(realCtor, name) {
      if (typeof realCtor !== 'function') return;
      const wrapped = function () {
        const inject = langActive() && (arguments.length === 0 || arguments[0] === undefined);
        const args = inject
          ? [cache.locale].concat(Array.prototype.slice.call(arguments, 1))
          : Array.prototype.slice.call(arguments);
        if (new.target) return Reflect.construct(realCtor, args, new.target);
        return realCtor.apply(this, args);
      };
      finishCtor(wrapped, name, realCtor.length, realCtor.prototype);
      try { Object.defineProperty(realCtor.prototype, 'constructor', { value: wrapped, configurable: true, writable: true }); } catch (_) {}
      if (realCtor.supportedLocalesOf) wrapped.supportedLocalesOf = bindSupported(realCtor);
      try { Intl[name] = wrapped; } catch (_) {}
    }
    wrapIntlLocale(realNumFmt, 'NumberFormat');
    wrapIntlLocale(realCol, 'Collator');
    wrapIntlLocale(Intl.RelativeTimeFormat, 'RelativeTimeFormat');
    wrapIntlLocale(Intl.PluralRules, 'PluralRules');
    wrapIntlLocale(Intl.ListFormat, 'ListFormat');
    wrapIntlLocale(Intl.DisplayNames, 'DisplayNames');
    wrapIntlLocale(Intl.Segmenter, 'Segmenter');
    wrapIntlLocale(Intl.DurationFormat, 'DurationFormat');

    // Number / Array / BigInt toLocaleString default to the spoofed locale.
    function wrapToLocale(proto, real) {
      try {
        proto.toLocaleString = makeMethod('toLocaleString', 0, function (locales, options) {
          let loc = locales;
          if (langActive() && loc === undefined) loc = cache.locale;
          return real.call(this, loc, options);
        });
      } catch (_) {}
    }
    wrapToLocale(Number.prototype, realNumberToLocale);
    wrapToLocale(Array.prototype, realArrayToLocale);
    if (realBigIntToLocale) wrapToLocale(BigInt.prototype, realBigIntToLocale);
  }

  // ---------------------------------------------------------------------------
  // Install once. Wrappers are inert until override data (`cache`) arrives and
  // the relevant toggle is on, so installing at document_start is safe.
  // ---------------------------------------------------------------------------
  installTimezone();
  installLocale();
  if (typeof Reflect !== 'undefined' && Reflect.construct) installDateConstructor();

  // ---------------------------------------------------------------------------
  // Data channel with the isolated bridge via window.postMessage (structured
  // clone reliably crosses worlds; no page-observable DOM mutation). A
  // request/response handshake makes it robust to either script loading first.
  // Everything reads `cache` live on each call.
  // ---------------------------------------------------------------------------
  function ingest(next) {
    if (!next) return;
    if (next.lat != null && next.lon != null) {
      cache = next;
      if (readyResolve) { readyResolve(); readyResolve = null; }
    } else {
      cache = { ...cache, ...next };
      if (cache && (cache.tzEnabled || cache.langEnabled) && readyResolve) { readyResolve(); readyResolve = null; }
    }
    Object.keys(watchHandlers).forEach((id) => { try { watchHandlers[id](); } catch (_) {} });
  }
  // A self-postMessage only reaches this frame's own listeners, so the MARK tag
  // is a sufficient filter (a page feeding fake data would only spoof its own
  // view). No source check — its identity isn't reliable across every context.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d[MARK] !== 'data') return;
    ingest(d.payload);
  });
  try { window.postMessage({ [MARK]: 'req' }, '*'); } catch (_) {}

  // Safety net: don't keep pending geolocation callbacks hanging forever.
  setTimeout(() => { if (readyResolve) { readyResolve(); readyResolve = null; } }, 12000);
})();
