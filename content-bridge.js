/* GeoMirror — isolated-world bridge.
 *
 * Runs in the isolated world (has chrome.* access) at document_start. It reads
 * the chosen override from storage and hands it to the MAIN-world injector.
 * MAIN-world scripts cannot access chrome.storage, so this bridge is the only
 * way to pass the payload across.
 *
 * The handoff uses window.postMessage — structured clone reliably crosses the
 * isolated↔MAIN world boundary (a CustomEvent's `detail` does NOT), and it
 * leaves no page-observable mutation on the document. A request/response
 * handshake makes delivery robust regardless of which world's script runs
 * first: the injector asks ('req') and the bridge also publishes proactively.
 *
 * It re-publishes on storage changes, so open pages pick up refreshes and
 * enable/disable toggles live.
 */
(function () {
  const MARK = '__geomirror__';

  function publish() {
    chrome.storage.local.get(['override', 'settings'], (data) => {
      const s = data.settings || {};
      const o = data.override;
      const payload = {
        enabled: s.enabled !== false,
        lat: o ? o.lat : null,
        lon: o ? o.lon : null,
        acc: o ? o.acc : (s.accuracyM || 30),
        ts: o ? o.ts : 0,
        timezone: o ? o.timezone : null,
        tzEnabled: s.tzEnabled !== false,
        langEnabled: s.langEnabled !== false,
        fontEnabled: s.fontEnabled !== false,
        workerEnabled: s.workerEnabled !== false,
        locale: o ? o.locale : null,
        languages: o ? o.languages : null,
      };
      try { window.postMessage({ [MARK]: 'data', payload }, '*'); } catch (_) {}
    });
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data[MARK] === 'req') publish();
  });
  publish();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.override || changes.settings)) publish();
  });
})();
