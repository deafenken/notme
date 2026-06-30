/* GeoMirror — background service worker.
 *
 * Responsibilities:
 *  - Detect the exit-IP geolocation (through the user's proxy).
 *  - Pick a nearby residential street as the override coordinate.
 *  - Resolve the exit IP's timezone (already returned by the IP providers) and
 *    infer a matching locale (country code → language, timezone as tie-breaker).
 *  - Store everything so the content scripts can apply it to every page.
 *  - Push an Accept-Language header rule via declarativeNetRequest so the
 *    *outgoing* HTTP header matches the spoofed language, not just navigator.
 *  - Refresh on install / startup and on demand (one-tap re-detect).
 */
importScripts('lib/geo.js', 'lib/providers.js', 'lib/locale.js');

const DEFAULT_SETTINGS = {
  enabled: true,
  accuracyM: 30,          // reported accuracy in meters (GPS-like)
  refreshMinutes: 360,    // re-detect every 6h
  ipToken: '',            // optional ipinfo.io token for better fallback
  tzEnabled: true,        // spoof Date/Intl timezone to match exit IP
  langEnabled: true,      // spoof navigator.language / Intl locale + Accept-Language header
};

const ALARM = 'refresh';
const AL_RULE_ID = 9001; // dynamic declarativeNetRequest rule id for Accept-Language

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function patchState(patch) {
  const { state } = await chrome.storage.local.get('state');
  await chrome.storage.local.set({ state: { ...(state || {}), ...patch } });
}

/** Push / clear the dynamic Accept-Language rule. No-op if DNR is unavailable. */
async function syncHeaderRule(settings, override) {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [AL_RULE_ID],
    });
    if (!(settings && settings.enabled && settings.langEnabled)) return;
    let al = override && override.acceptLanguage;
    if (!al) return; // nothing to enforce yet
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: AL_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'accept-language', operation: 'set', value: al },
          ],
        },
        condition: {
          urlFilter: '*',
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
        },
      }],
    });
  } catch (_) { /* DNR may be unavailable on some builds; fail soft */ }
}

async function refresh() {
  await patchState({ status: 'refreshing', lastError: null });
  const s = await getSettings();
  try {
    const ip = await IPLoc.getIPLocation(s.ipToken);
    if (!ip || ip.lat == null) throw new Error('All IP geolocation providers failed.');

    const pick = await GeoUtil.chooseResidential(ip.lat, ip.lon, {
      radius: 2500, limit: 150, timeoutMs: 12000,
    });
    const addr = await IPLoc.getDisplayAddress(pick.lat, pick.lon);
    const now = Date.now();

    // Timezone: prefer the provider's IANA name; fall back to looking it up is
    // not needed — IP providers already return city-level tz. If a provider
    // omitted it, downstream just keeps the real tz.
    const timezone = ip.timezone || null;
    const loc = Locale.localeFor(ip.countryCode, timezone);

    const override = {
      lat: pick.lat, lon: pick.lon, acc: s.accuracyM,
      source: pick.source, road: pick.road || null,
      enabled: s.enabled, ts: now,
      timezone,
      tzEnabled: s.tzEnabled,
      langEnabled: s.langEnabled,
      locale: loc ? loc.language : null,
      languages: loc ? loc.languages : null,
      acceptLanguage: loc ? loc.acceptLanguage : null,
    };
    const state = {
      status: 'ok',
      ip: ip.ip, ipCity: ip.city, ipRegion: ip.region,
      ipCountry: ip.country, ipCountryCode: ip.countryCode,
      ipLat: ip.lat, ipLon: ip.lon, isp: ip.isp, provider: ip.provider,
      ipTimezone: timezone,
      ipLocale: loc ? loc.language : null,
      overrideLat: pick.lat, overrideLon: pick.lon,
      overrideSource: pick.source, overrideRoad: pick.road || null,
      overrideAddress: addr ? addr.text : '',
      lastUpdated: now, lastError: null,
    };
    await chrome.storage.local.set({ override, state });
    await syncHeaderRule(s, override);
  } catch (e) {
    await patchState({
      status: 'error',
      lastError: String((e && e.message) || e),
      lastUpdated: Date.now(),
    });
  }
}

async function ensureAlarm() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, s.refreshMinutes) });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await ensureAlarm();
  await refresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const { state, override, settings } = await chrome.storage.local.get(['state', 'override', 'settings']);
  // Re-assert the header rule on startup (dynamic rules don't persist a value
  // we control across browser restarts in all cases).
  await syncHeaderRule({ ...DEFAULT_SETTINGS, ...(settings || {}) }, override);
  const s = await getSettings();
  const age = state && state.lastUpdated ? Date.now() - state.lastUpdated : Infinity;
  if (!state || age > s.refreshMinutes * 60000) await refresh();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'REFRESH') {
      await refresh();
    } else if (msg && msg.type === 'SET_SETTINGS') {
      const next = await saveSettings(msg.patch || {});
      const { override } = await chrome.storage.local.get('override');
      if (override) {
        override.enabled = next.enabled;
        override.acc = next.accuracyM;
        override.tzEnabled = next.tzEnabled;
        override.langEnabled = next.langEnabled;
        await chrome.storage.local.set({ override });
      }
      // Toggling language spoofing changes whether the header rule is active.
      await syncHeaderRule(next, override);
      if (msg.patch && 'refreshMinutes' in msg.patch) await ensureAlarm();
    }
    // Return a fresh snapshot for any message (covers GET_STATE too).
    const { state, override, settings } = await chrome.storage.local.get(['state', 'override', 'settings']);
    sendResponse({ state, override, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  })();
  return true; // keep channel open for async sendResponse
});
