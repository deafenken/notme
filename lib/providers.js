/* GeoMirror — IP geolocation & reverse-geocoding providers.
 *
 * Multi-provider chain with graceful fallback, so the extension keeps working
 * even when one provider rate-limits or is blocked by a particular proxy node.
 * All requests go through Chrome's network stack (i.e. the user's proxy), so
 * the location returned is that of the *exit* IP — exactly what websites see.
 *
 * Each parse() now also surfaces `timezone` (an IANA name like "Asia/Tokyo")
 * when the provider returns one. We never throw it away: timezone + language
 * spoofing read it downstream, and it costs zero extra requests.
 */
(function () {
  'use strict';
  const root = (typeof self !== 'undefined') ? self
             : (typeof global !== 'undefined') ? global : this;

  function fetchWithTimeout(url, opts = {}, ms = 9000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
  }

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  // Coerce whatever a provider gives us into an IANA timezone id string, or null.
  // ipwho.is:  d.timezone.id  (e.g. "Asia/Tokyo")
  // ipinfo.io: d.timezone     (e.g. "Asia/Tokyo")
  // ipapi.co:  d.timezone     (e.g. "Asia/Tokyo")
  const tz = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return /^[A-Za-z_/.+-]+$/.test(v) ? v : null;
    if (typeof v === 'object') {
      const id = v.id || v.name || v.timeZone;
      if (typeof id === 'string') return id;
    }
    return null;
  };

  // Each provider: name, url(token), parse(json) -> normalized {ip,city,region,
  // country, countryCode, lat, lon, isp, timezone}. Order matters — most
  // reliable first.
  const IP_PROVIDERS = [
    {
      name: 'reallyfreegeoip',
      url: () => 'https://reallyfreegeoip.org/json/',
      parse: (d) => ({
        ip: d.ip, city: d.city, region: d.region_name, country: d.country_name,
        countryCode: d.country_code, lat: num(d.latitude), lon: num(d.longitude),
        isp: null, timezone: null,
      }),
    },
    {
      name: 'ipwho.is',
      url: () => 'https://ipwho.is/',
      parse: (d) => ({
        ip: d.ip, city: d.city, region: d.region, country: d.country,
        countryCode: d.country_code, lat: num(d.latitude), lon: num(d.longitude),
        isp: (d.connection && d.connection.isp) || null,
        timezone: tz(d.timezone && d.timezone.id ? d.timezone.id : d.timezone),
      }),
    },
    {
      name: 'ipapi.co',
      url: () => 'https://ipapi.co/json/',
      parse: (d) => ({
        ip: d.ip, city: d.city, region: d.region, country: d.country_name,
        countryCode: d.country_code, lat: num(d.latitude), lon: num(d.longitude),
        isp: d.org || null, timezone: tz(d.timezone),
      }),
    },
    {
      name: 'ipinfo.io',
      url: (token) => 'https://ipinfo.io/json' + (token ? ('?token=' + encodeURIComponent(token)) : ''),
      parse: (d) => {
        let lat = null, lon = null;
        if (typeof d.loc === 'string') {
          const [a, b] = d.loc.split(',');
          lat = num(a); lon = num(b);
        }
        return {
          ip: d.ip, city: d.city, region: d.region, country: d.country,
          countryCode: d.country, lat, lon, isp: d.org || null,
          timezone: tz(d.timezone),
        };
      },
    },
  ];

  /** Try providers in order; return the first that yields a usable location. */
  async function getIPLocation(token) {
    for (const p of IP_PROVIDERS) {
      try {
        const res = await fetchWithTimeout(p.url(token), { headers: { Accept: 'application/json' } });
        if (!res.ok) continue;
        const d = await res.json();
        if (!d || d.success === false) continue; // ipwho.is error flag
        const norm = p.parse(d);
        if (norm.ip && norm.lat != null && norm.lon != null) {
          return { ...norm, provider: p.name };
        }
      } catch (_) { /* next provider */ }
    }
    return null;
  }

  /** Best-effort reverse geocode for display only (free, no key, CORS-enabled). */
  async function getDisplayAddress(lat, lon) {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
      const res = await fetchWithTimeout(url, {}, 9000);
      if (!res.ok) return null;
      const d = await res.json();
      const parts = [d.locality, d.city, d.principalSubdivision, d.countryName].filter(Boolean);
      return {
        text: [...new Set(parts)].join(', '),
        city: d.city || d.locality || null,
        region: d.principalSubdivision || null,
        country: d.countryName || null,
        postcode: d.postcode || null,
      };
    } catch (_) {
      return null;
    }
  }

  const IPLoc = { getIPLocation, getDisplayAddress, IP_PROVIDERS, fetchWithTimeout };
  root.IPLoc = IPLoc;
  if (typeof module !== 'undefined' && module.exports) module.exports = IPLoc;
})();
