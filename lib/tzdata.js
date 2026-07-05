/* notme — timezone profiles for the manual fallback.
 *
 * When exit-IP detection fails (or a provider returns no timezone), the user can
 * pick a timezone in the popup. Each profile carries the country code (so the
 * locale can be inferred the same way as the auto path) and a representative
 * city coordinate (so geolocation stays consistent with the chosen zone).
 *
 * China zones are intentionally omitted — the point of a manual override is to
 * present a plausible NON-China environment when auto-detection can't.
 */
(function () {
  'use strict';
  const root = (typeof self !== 'undefined') ? self
             : (typeof global !== 'undefined') ? global : this;

  // IANA timezone -> { cc: ISO 3166-1 alpha-2, lat, lon, label }
  const TZ_PROFILES = {
    'America/Los_Angeles': { cc: 'US', lat: 34.0522, lon: -118.2437, label: 'Los Angeles · US (UTC-8/-7)' },
    'America/Denver':      { cc: 'US', lat: 39.7392, lon: -104.9903, label: 'Denver · US (UTC-7/-6)' },
    'America/Chicago':     { cc: 'US', lat: 41.8781, lon: -87.6298,  label: 'Chicago · US (UTC-6/-5)' },
    'America/New_York':    { cc: 'US', lat: 40.7128, lon: -74.0060,  label: 'New York · US (UTC-5/-4)' },
    'America/Toronto':     { cc: 'CA', lat: 43.6532, lon: -79.3832,  label: 'Toronto · CA (UTC-5/-4)' },
    'America/Sao_Paulo':   { cc: 'BR', lat: -23.5505, lon: -46.6333, label: 'São Paulo · BR (UTC-3)' },
    'Europe/London':       { cc: 'GB', lat: 51.5074, lon: -0.1278,   label: 'London · GB (UTC+0/+1)' },
    'Europe/Paris':        { cc: 'FR', lat: 48.8566, lon: 2.3522,    label: 'Paris · FR (UTC+1/+2)' },
    'Europe/Berlin':       { cc: 'DE', lat: 52.5200, lon: 13.4050,   label: 'Berlin · DE (UTC+1/+2)' },
    'Europe/Amsterdam':    { cc: 'NL', lat: 52.3676, lon: 4.9041,    label: 'Amsterdam · NL (UTC+1/+2)' },
    'Europe/Madrid':       { cc: 'ES', lat: 40.4168, lon: -3.7038,   label: 'Madrid · ES (UTC+1/+2)' },
    'Europe/Moscow':       { cc: 'RU', lat: 55.7558, lon: 37.6173,   label: 'Moscow · RU (UTC+3)' },
    'Asia/Dubai':          { cc: 'AE', lat: 25.2048, lon: 55.2708,   label: 'Dubai · AE (UTC+4)' },
    'Asia/Kolkata':        { cc: 'IN', lat: 19.0760, lon: 72.8777,   label: 'Mumbai · IN (UTC+5:30)' },
    'Asia/Bangkok':        { cc: 'TH', lat: 13.7563, lon: 100.5018,  label: 'Bangkok · TH (UTC+7)' },
    'Asia/Singapore':      { cc: 'SG', lat: 1.3521,  lon: 103.8198,  label: 'Singapore · SG (UTC+8)' },
    'Asia/Hong_Kong':      { cc: 'HK', lat: 22.3193, lon: 114.1694,  label: 'Hong Kong · HK (UTC+8)' },
    'Asia/Taipei':         { cc: 'TW', lat: 25.0330, lon: 121.5654,  label: 'Taipei · TW (UTC+8)' },
    'Asia/Tokyo':          { cc: 'JP', lat: 35.6762, lon: 139.6503,  label: 'Tokyo · JP (UTC+9)' },
    'Asia/Seoul':          { cc: 'KR', lat: 37.5665, lon: 126.9780,  label: 'Seoul · KR (UTC+9)' },
    'Australia/Sydney':    { cc: 'AU', lat: -33.8688, lon: 151.2093, label: 'Sydney · AU (UTC+10/+11)' },
  };

  // Ordered list for the popup dropdown (west-to-east feel).
  const TZ_ORDER = [
    'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
    'America/Toronto', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
    'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Madrid', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong',
    'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney',
  ];

  // Return { tz, cc, lat, lon, label } for a timezone. Unknown zones still get
  // a profile with the tz preserved (no coords, unknown country -> locale falls
  // back to en-US downstream).
  function profileForTz(tz) {
    const p = tz && TZ_PROFILES[tz];
    if (p) return { tz, cc: p.cc, lat: p.lat, lon: p.lon, label: p.label };
    return { tz: tz || null, cc: null, lat: null, lon: null, label: tz || '' };
  }

  const TZData = { TZ_PROFILES, TZ_ORDER, profileForTz };
  root.TZData = TZData;
  if (typeof module !== 'undefined' && module.exports) module.exports = TZData;
})();
