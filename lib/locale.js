/* GeoMirror — country/timezone → locale mapping (offline).
 *
 * No IP service returns the user's *language*, so we infer it from the exit
 * IP's country code, with the IANA timezone as a tie-breaker for multilingual
 * countries (e.g. Canada, Belgium, Switzerland). Returns a {language, languages,
 * acceptLanguage} bundle consumed by both the JS-side overrides
 * (navigator.language / Intl default locale) and the Accept-Language header rule.
 *
 * `languages` is ordered best-effort (regional first, then base, then English
 * fallback so pages still render if the spoofed locale isn't shipped).
 * `acceptLanguage` is the matching q-weighted string for the HTTP header.
 */
(function () {
  'use strict';
  const root = (typeof self !== 'undefined') ? self
             : (typeof global !== 'undefined') ? global : this;

  // Build a locale bundle from an ordered list of tags.
  // tags e.g. ['ja-JP','ja','en-US','en'] -> { language:'ja-JP', languages:[...], acceptLanguage:'ja-JP,ja;q=0.9,...' }
  function bundle(tags) {
    const langs = [];
    for (const t of tags) {
      if (t && !langs.includes(t)) langs.push(t);
    }
    if (!langs.length) return null;
    const q = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
    const accept = langs.map((t, i) =>
      i === 0 ? t : `${t};q=${q[Math.min(i, q.length - 1)]}`
    ).join(',');
    return { language: langs[0], languages: langs, acceptLanguage: accept };
  }

  // countryCode (ISO 3166-1 alpha-2, uppercase) -> ordered tag list.
  // Regional variant first where it matters (zh-HK, zh-TW, pt-BR, en-GB).
  const BY_COUNTRY = {
    US: ['en-US', 'en'], GB: ['en-GB', 'en'], AU: ['en-AU', 'en'],
    NZ: ['en-NZ', 'en'], IE: ['en-IE', 'en'], SG: ['en-SG', 'zh-SG', 'en', 'zh'],
    JP: ['ja-JP', 'ja', 'en-US', 'en'],
    KR: ['ko-KR', 'ko', 'en-US', 'en'],
    HK: ['zh-HK', 'zh', 'en-HK', 'en'],
    TW: ['zh-TW', 'zh', 'en-US', 'en'],
    DE: ['de-DE', 'de', 'en-US', 'en'], AT: ['de-AT', 'de', 'en', 'en'],
    CH: ['de-CH', 'de', 'fr-CH', 'fr', 'en', 'en'],
    FR: ['fr-FR', 'fr', 'en-US', 'en'], BE: ['nl-BE', 'nl', 'fr-BE', 'fr', 'en'],
    NL: ['nl-NL', 'nl', 'en', 'en'],
    ES: ['es-ES', 'es', 'en', 'en'], MX: ['es-MX', 'es', 'en', 'en'],
    IT: ['it-IT', 'it', 'en', 'en'],
    PT: ['pt-PT', 'pt', 'en', 'en'], BR: ['pt-BR', 'pt', 'en', 'en'],
    RU: ['ru-RU', 'ru', 'en', 'en'],
    SE: ['sv-SE', 'sv', 'en', 'en'], NO: ['nb-NO', 'no', 'en', 'en'],
    DK: ['da-DK', 'da', 'en', 'en'], FI: ['fi-FI', 'fi', 'sv-FI', 'sv', 'en'],
    PL: ['pl-PL', 'pl', 'en', 'en'], TR: ['tr-TR', 'tr', 'en', 'en'],
    IN: ['en-IN', 'en', 'hi-IN', 'hi'],
    ID: ['id-ID', 'id', 'en', 'en'], TH: ['th-TH', 'th', 'en', 'en'],
    VN: ['vi-VN', 'vi', 'en', 'en'], MY: ['ms-MY', 'ms', 'en-MY', 'en'],
    PH: ['en-PH', 'en', 'fil'],
    CA: ['en-CA', 'en', 'fr-CA', 'fr'],
    IL: ['he-IL', 'he', 'en', 'en'], AE: ['ar-AE', 'ar', 'en', 'en'],
    SA: ['ar-SA', 'ar', 'en', 'en'],
  };

  // Timezone overrides for multilingual countries: a timezone is a stronger
  // signal than the country code alone (e.g. America/Montreal → fr-CA).
  const BY_TIMEZONE = {
    'America/Montreal': ['fr-CA', 'fr', 'en-CA', 'en'],
    'America/Toronto': ['en-CA', 'en', 'fr-CA', 'fr'],
    'America/Vancouver': ['en-CA', 'en', 'fr-CA', 'fr'],
    'Europe/Brussels': ['nl-BE', 'nl', 'fr-BE', 'fr', 'en'],
    'Europe/Zurich': ['de-CH', 'de', 'fr-CH', 'fr', 'en'],
    'Europe/Berlin': ['de-DE', 'de', 'en-US', 'en'],
    'Asia/Kolkata': ['en-IN', 'en', 'hi-IN', 'hi'],
    'Asia/Singapore': ['en-SG', 'zh-SG', 'en', 'zh'],
  };

  function localeFor(countryCode, timezone) {
    if (timezone && BY_TIMEZONE[timezone]) {
      const b = bundle(BY_TIMEZONE[timezone]);
      if (b) return b;
    }
    const cc = (countryCode || '').toUpperCase();
    if (cc && BY_COUNTRY[cc]) return bundle(BY_COUNTRY[cc]);
    // Unknown country — fall back to a neutral English bundle rather than null,
    // so the header rule + JS overrides always have something consistent to use.
    return bundle(['en-US', 'en']);
  }

  const Locale = { localeFor, bundle };
  root.Locale = Locale;
  if (typeof module !== 'undefined' && module.exports) module.exports = Locale;
})();
