/* GeoMirror — isolated-world bridge.
 *
 * Runs in the isolated world (has chrome.* access) at document_start. It reads
 * the chosen override from storage and publishes it onto <html data-geomirror>,
 * where the MAIN-world injector can read it. MAIN-world scripts cannot access
 * chrome.storage, so this bridge is the only way to pass the coordinate across.
 *
 * It now also publishes timezone + locale fields so the injector can spoof the
 * Date timezone offset and navigator.language / Intl locale, not just coords.
 *
 * It re-publishes on storage changes, so open pages pick up refreshes and
 * enable/disable toggles live.
 */
(function () {
  const root = document.documentElement;
  if (!root) return;

  function publish() {
    chrome.storage.local.get(['override', 'settings'], (data) => {
      const s = data.settings || {};
      const o = data.override;
      const enabled = s.enabled !== false;
      const payload = {
        enabled,
        lat: o ? o.lat : null,
        lon: o ? o.lon : null,
        acc: o ? o.acc : (s.accuracyM || 30),
        ts: o ? o.ts : 0,
        timezone: o ? o.timezone : null,
        tzEnabled: s.tzEnabled !== false,
        langEnabled: s.langEnabled !== false,
        locale: o ? o.locale : null,
        languages: o ? o.languages : null,
      };
      root.setAttribute('data-geomirror', JSON.stringify(payload));
    });
  }

  publish();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.override || changes.settings)) publish();
  });
})();
