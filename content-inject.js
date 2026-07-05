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
  // Font hiding is IP-independent, so it defaults on before override data arrives.
  function fontActive() { return !cache || cache.fontEnabled !== false; }
  function workerActive() { return !!(cache && cache.workerEnabled !== false && (tzActive() || langActive())); }

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
  // Font hiding — stop canvas/DOM width probes from detecting the OS/region-
  // revealing CJK fonts (Microsoft YaHei / PingFang / SimSun / …). A width probe
  // renders text in "'TestFont', <generic>" and compares against the generic
  // baseline; if we strip the blacklisted family before measuring, the probe
  // sees the baseline width and concludes the font is not installed.
  // ---------------------------------------------------------------------------
  const FONT_BLACKLIST = [
    '微软雅黑', 'microsoft yahei', 'msyh', '微软正黑体', '微軟正黑體', 'microsoft jhenghei', 'msjh',
    '苹方', '蘋方', 'pingfang sc', 'pingfang tc', 'pingfang hk', 'pingfang',
    '宋体', '宋體', 'simsun', 'nsimsun', 'songti sc', 'songti tc', 'songti', '新宋体', '新宋體',
    '黑体', '黑體', 'simhei', 'heiti sc', 'heiti tc', 'heiti',
    '楷体', '楷體', 'kaiti', 'kaiti sc', 'kaiti tc', '标楷体', '標楷體', 'dfkai-sb', 'kaiu',
    '仿宋', 'fangsong', 'stfangsong', '等线', 'dengxian',
    '细明体', '細明體', 'mingliu', '新细明体', '新細明體', 'pmingliu',
    '华文黑体', '华文宋体', '华文楷体', '华文细黑', '华文仿宋', 'stheiti', 'stsong', 'stkaiti', 'stxihei',
    '思源黑体', '思源宋体', 'source han sans', 'source han serif',
    'noto sans cjk', 'noto serif cjk', 'noto sans sc', 'noto serif sc', 'noto sans tc', 'noto serif tc',
    'wenquanyi', '文泉驿', 'hiragino sans gb', '幼圆', 'youyuan',
    // Domestic vendor / software fonts (MiSans, HarmonyOS, OPPO, vivo, HONOR,
    // Alibaba, HanYi, Founder/方正) — a strong "China" signal on their own.
    'misans', 'miui', '小米兰亭', 'mi lanting',
    'harmonyos sans', 'harmonyos', '鸿蒙', 'honor sans',
    'oppo sans', 'vivo sans',
    'alibaba puhuiti', 'alibaba sans', '阿里巴巴普惠体', 'dingtalk', '钉钉进步体',
    'hyqihei', '汉仪', '方正', 'fzhei', 'fzsong', 'fzkai', 'fzlanting',
  ];
  const SIZE_RE = /^(.*?\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%|cm|mm|in|q)\b)\s*(.*)$/i;
  // Return the font string with any WHOLE family that names a blacklisted CJK /
  // vendor font removed (keeping the size prefix and the surviving families), or
  // null when none is present. Whole-family matching avoids leaving fragments
  // (e.g. "HarmonyOS Sans SC" -> "SC") and avoids false positives from tokens
  // embedded in unrelated names (e.g. "Founders Grotesk").
  function stripCJK(fontStr) {
    if (!fontStr) return null;
    const s = '' + fontStr;
    const lower = s.toLowerCase();
    let hit = false;
    for (let i = 0; i < FONT_BLACKLIST.length; i++) { if (lower.indexOf(FONT_BLACKLIST[i]) >= 0) { hit = true; break; } }
    if (!hit) return null;
    const m = s.match(SIZE_RE);
    const prefix = m ? m[1] : '';
    const familyStr = m ? m[2] : s;
    const kept = familyStr.split(',').map((f) => f.trim()).filter(Boolean).filter((f) => {
      const fl = f.replace(/^['"]|['"]$/g, '').toLowerCase();
      return !FONT_BLACKLIST.some((x) => fl.indexOf(x) >= 0);
    });
    const fam = kept.length ? kept.join(', ') : 'sans-serif';
    return (prefix ? prefix + ' ' : '') + fam;
  }

  // Set ctx.font, retrying with an appended generic if a family-less strip result
  // was rejected (so "72px SimSun" -> "72px" -> "72px sans-serif" still measures
  // as a fallback instead of silently keeping the CJK font).
  function trySetCanvasFont(ctx, stripped, saved) {
    ctx.font = stripped;
    if (ctx.font !== saved) return true;
    ctx.font = (stripped + ' sans-serif').trim();
    return ctx.font !== saved;
  }
  const realGBCRforProbe = (typeof Element !== 'undefined') ? Element.prototype.getBoundingClientRect : null;
  // A font-detection probe renders its sample off-screen; real content the user
  // sees is on-screen. Only strip for elements that don't intersect the viewport,
  // so legitimate visible CJK text keeps its true geometry.
  function looksLikeProbe(el) {
    try {
      if (!el.isConnected) return true;
      if (!realGBCRforProbe) return false;
      const r = realGBCRforProbe.call(el);
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      return r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh;
    } catch (_) { return false; }
  }

  function installFontProtection() {
    // Canvas measureText (2D + offscreen): measure with CJK families stripped.
    function patchMeasure(proto) {
      if (!proto || typeof proto.measureText !== 'function') return;
      const real = proto.measureText;
      try {
        proto.measureText = makeMethod('measureText', 1, function (text) {
          if (fontActive()) {
            try {
              const stripped = stripCJK(this.font);
              if (stripped != null && stripped !== this.font) {
                const saved = this.font;
                if (trySetCanvasFont(this, stripped, saved)) { const m = real.call(this, text); this.font = saved; return m; }
                this.font = saved;
              }
            } catch (_) {}
          }
          return real.call(this, text);
        });
      } catch (_) {}
    }
    if (typeof CanvasRenderingContext2D !== 'undefined') patchMeasure(CanvasRenderingContext2D.prototype);
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') patchMeasure(OffscreenCanvasRenderingContext2D.prototype);

    // DOM width probes set an inline CJK font-family on an off-screen sample and
    // read its geometry. Strip the CJK family only for such off-screen probe
    // elements, preserving any !important priority, and never touch visible
    // content. Normal on-screen elements return their real geometry unchanged.
    function withStrippedFont(el, read) {
      if (fontActive() && el && el.style && typeof el.style.fontFamily === 'string') {
        const fam = el.style.fontFamily;
        const stripped = stripCJK(fam);
        if (stripped != null && stripped !== fam && looksLikeProbe(el)) {
          const prio = el.style.getPropertyPriority('font-family');
          try {
            if (stripped) el.style.setProperty('font-family', stripped, prio);
            else el.style.removeProperty('font-family');
            const r = read();
            el.style.setProperty('font-family', fam, prio);
            return { hit: true, value: r };
          } catch (_) { try { el.style.setProperty('font-family', fam, prio); } catch (__) {} }
        }
      }
      return { hit: false };
    }
    function patchRectMethod(proto, name) {
      if (!proto || typeof proto[name] !== 'function') return;
      const real = proto[name];
      try {
        proto[name] = makeMethod(name, 0, function () {
          const res = withStrippedFont(this, () => real.call(this));
          return res.hit ? res.value : real.call(this);
        });
      } catch (_) {}
    }
    if (typeof Element !== 'undefined') {
      patchRectMethod(Element.prototype, 'getBoundingClientRect');
      patchRectMethod(Element.prototype, 'getClientRects');
    }
    function patchOffsetGetter(proto, name) {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || !desc.get) return;
      const realGet = desc.get;
      try {
        Object.defineProperty(proto, name, {
          configurable: true, enumerable: desc.enumerable,
          get: makeMethod('get ' + name, 0, function () {
            const res = withStrippedFont(this, () => realGet.call(this));
            return res.hit ? res.value : realGet.call(this);
          }),
        });
      } catch (_) {}
    }
    if (typeof HTMLElement !== 'undefined') {
      patchOffsetGetter(HTMLElement.prototype, 'offsetWidth');
      patchOffsetGetter(HTMLElement.prototype, 'offsetHeight');
    }
  }

  // ---------------------------------------------------------------------------
  // Web Worker timezone/locale spoofing. Content scripts don't run in worker
  // scopes, so a fingerprinter reads the real timezone/locale from inside a
  // Worker. We wrap the Worker constructor and load a small bootstrap (via a
  // blob) that patches Date/Intl/navigator in worker scope, then importScripts
  // the original code. Any failure falls back to a normal, unpatched worker so
  // pages never break; module workers are passed through untouched.
  // ---------------------------------------------------------------------------
  function GM_WORKER_PATCH(cfg) {
    try {
      var RDTF = Intl.DateTimeFormat, Dp = Date.prototype, TZ = cfg.tz, LOC = cfg.locale, LANGS = cfg.languages;
      function pad(n) { return ('0' + n).slice(-2); }
      function off(d) {
        try {
          var p = new RDTF('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
            .formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
          var h = p.hour === '24' ? '00' : p.hour;
          var w = Date.UTC(+p.year, +p.month - 1, +p.day, +h, +p.minute, +p.second);
          return -Math.round((w - d.getTime()) / 60000);
        } catch (e) { return null; }
      }
      function wall(d) { var o = off(d); if (o == null) return null; return new Date(d.getTime() - o * 60000); }
      function nds(d) {
        try {
          var p = new RDTF('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'long' })
            .formatToParts(d).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
          var r = -off(d), sign = r >= 0 ? '+' : '-', ab = Math.abs(r);
          var gmt = 'GMT' + sign + pad(Math.floor(ab / 60)) + pad(ab % 60);
          return { date: p.weekday + ' ' + p.month + ' ' + p.day + ' ' + p.year, time: p.hour + ':' + p.minute + ':' + p.second + ' ' + gmt + ' (' + p.timeZoneName + ')' };
        } catch (e) { return null; }
      }
      if (TZ) {
        var rTZO = Dp.getTimezoneOffset;
        Dp.getTimezoneOffset = function getTimezoneOffset() { if (isFinite(this.getTime())) { var o = off(this); if (o != null) return o; } return rTZO.call(this); };
        var G = { getFullYear: 'getUTCFullYear', getMonth: 'getUTCMonth', getDate: 'getUTCDate', getDay: 'getUTCDay', getHours: 'getUTCHours', getMinutes: 'getUTCMinutes', getSeconds: 'getUTCSeconds', getMilliseconds: 'getUTCMilliseconds' };
        Object.keys(G).forEach(function (k) { var r = Dp[k], u = G[k]; Dp[k] = function () { if (isFinite(this.getTime())) { var w = wall(this); if (w) return w[u](); } return r.call(this); }; });
        var strs = { toString: function (s) { return s.date + ' ' + s.time; }, toDateString: function (s) { return s.date; }, toTimeString: function (s) { return s.time; } };
        Object.keys(strs).forEach(function (k) { var r = Dp[k], pick = strs[k]; Dp[k] = function () { if (isFinite(this.getTime())) { var s = nds(this); if (s) return pick(s); } return r.call(this); }; });
        var wDTF = function DateTimeFormat() {
          var l = arguments[0], o = arguments[1];
          var opts = (o && typeof o === 'object') ? Object.create(o) : {};
          if (opts.timeZone === undefined) opts.timeZone = TZ;
          if (l === undefined && LOC) l = LOC;
          if (new.target) return Reflect.construct(RDTF, [l, opts], new.target);
          return RDTF(l, opts);
        };
        wDTF.prototype = RDTF.prototype;
        if (RDTF.supportedLocalesOf) wDTF.supportedLocalesOf = RDTF.supportedLocalesOf.bind(RDTF);
        Intl.DateTimeFormat = wDTF;
      }
      if (TZ || LOC) {
        ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].forEach(function (n) {
          var r = Dp[n];
          Dp[n] = function (loc, opt) {
            if (!isFinite(this.getTime())) return r.call(this, loc, opt);
            var o = (opt && typeof opt === 'object') ? Object.create(opt) : {};
            if (TZ && o.timeZone === undefined) o.timeZone = TZ;
            if (LOC && loc === undefined) loc = LOC;
            return r.call(this, loc, o);
          };
        });
      }
      if (LOC) {
        ['NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter'].forEach(function (n) {
          var rc = Intl[n]; if (typeof rc !== 'function') return;
          var w = function () {
            var inj = (arguments.length === 0 || arguments[0] === undefined);
            var a = inj ? [LOC].concat([].slice.call(arguments, 1)) : [].slice.call(arguments);
            if (new.target) return Reflect.construct(rc, a, new.target);
            return rc.apply(this, a);
          };
          w.prototype = rc.prototype; if (rc.supportedLocalesOf) w.supportedLocalesOf = rc.supportedLocalesOf.bind(rc);
          Intl[n] = w;
        });
        try {
          var np = Object.getPrototypeOf(navigator);
          Object.defineProperty(np, 'language', { configurable: true, get: function () { return LOC; } });
          Object.defineProperty(np, 'languages', { configurable: true, get: function () { return Object.freeze((LANGS && LANGS.length ? LANGS : [LOC]).slice()); } });
        } catch (e) {}
      }
    } catch (e) {}
  }

  function installWorkerPatch() {
    if (typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL || typeof Blob === 'undefined') return;
    const RealWorker = Worker;
    const patchSrc = realFnToString.call(GM_WORKER_PATCH);
    // A CSP that omits blob: (e.g. `script-src 'self'`) blocks a blob worker
    // ASYNCHRONOUSLY — the constructor doesn't throw, so a try/catch can't catch
    // it and the worker would silently die. So we never take the blob path until
    // a one-shot probe worker has CONFIRMED blob workers run here; until then (and
    // forever, on CSP sites) workers pass through natively — unspoofed but working.
    let blobAllowed = null; // null unknown, true/false known
    let probed = false;
    function probe() {
      probed = true;
      try {
        const u = URL.createObjectURL(new Blob(['self.postMessage(1)'], { type: 'text/javascript' }));
        const w = new RealWorker(u);
        const done = (ok) => { blobAllowed = ok; try { w.terminate(); } catch (_) {} try { URL.revokeObjectURL(u); } catch (_) {} };
        w.onmessage = () => done(true);
        w.onerror = () => done(false);
      } catch (_) { blobAllowed = false; }
    }
    const wrapped = function Worker(scriptURL, options) {
      if (!new.target) return RealWorker.apply(this, arguments); // throws like native
      try {
        const active = workerActive() && !(options && options.type === 'module');
        if (active && !probed) probe();
        if (!active || blobAllowed !== true) return Reflect.construct(RealWorker, arguments, new.target);
        const cfg = {
          tz: tzActive() ? cache.timezone : null,
          locale: langActive() ? cache.locale : null,
          languages: langActive() ? cache.languages : null,
        };
        if (!cfg.tz && !cfg.locale) return Reflect.construct(RealWorker, arguments, new.target);
        const base = (typeof document !== 'undefined' && document.baseURI) || location.href;
        const abs = new URL(String(scriptURL), base).href;
        // Re-base relative importScripts/fetch/XHR against the original script URL
        // (self.location is the blob URL). self.location reads and dynamic import()
        // still can't be rebased — hence this feature is opt-in/experimental.
        const boot =
          '(' + patchSrc + ')(' + JSON.stringify(cfg) + ');\n' +
          '(function(){var b=' + JSON.stringify(abs) + ';' +
          'var i=self.importScripts;if(i){self.importScripts=function(){var a=[].map.call(arguments,function(u){try{return new URL(u,b).href}catch(e){return u}});return i.apply(self,a);};}' +
          'if(self.fetch){var f=self.fetch;self.fetch=function(u,o){try{if(typeof u==="string")u=new URL(u,b).href;}catch(e){}return f.call(self,u,o);};}' +
          'if(self.XMLHttpRequest){var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{if(typeof u==="string")u=new URL(u,b).href;}catch(e){}return xo.apply(this,[m,u].concat([].slice.call(arguments,2)));};}' +
          '})();\n' +
          'importScripts(' + JSON.stringify(abs) + ');';
        const url = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
        const w = Reflect.construct(RealWorker, [url, options], new.target);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
        return w;
      } catch (_) {
        try { return Reflect.construct(RealWorker, arguments, new.target); } catch (__) { return new RealWorker(scriptURL, options); }
      }
    };
    finishCtor(wrapped, 'Worker', 1, RealWorker.prototype);
    try { Object.defineProperty(RealWorker.prototype, 'constructor', { value: wrapped, configurable: true, writable: true }); } catch (_) {}
    try { Worker = wrapped; } catch (_) {}
    try { window.Worker = wrapped; } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Install once. Wrappers are inert until override data (`cache`) arrives and
  // the relevant toggle is on, so installing at document_start is safe.
  // ---------------------------------------------------------------------------
  installTimezone();
  installLocale();
  installFontProtection();
  if (typeof Reflect !== 'undefined' && Reflect.construct) { installDateConstructor(); installWorkerPatch(); }

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
