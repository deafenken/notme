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
importScripts('lib/geo.js', 'lib/providers.js', 'lib/locale.js', 'lib/tzdata.js');

const DEFAULT_SETTINGS = {
  enabled: true,
  accuracyM: 30,          // reported accuracy in meters (GPS-like)
  refreshMinutes: 360,    // re-detect every 6h
  ipToken: '',            // optional ipinfo.io token for better fallback
  tzEnabled: true,        // spoof Date/Intl timezone to match exit IP
  langEnabled: true,      // spoof navigator.language / Intl locale + Accept-Language header
  webrtcProtect: true,    // force WebRTC through the proxy so it can't leak the real IP
  fontEnabled: true,      // hide OS/region-revealing CJK fonts from width probing
  workerEnabled: false,   // (experimental) spoof inside Web Workers — off by default:
                          // rewriting a worker through a blob can break WASM/bundled
                          // workers that rely on self.location. Opt in if you need it.
  manualTz: '',           // fallback IANA timezone used when exit-IP detection fails
                          // (or a provider returns no timezone). Empty = auto only.
};

const ALARM = 'refresh';
const AL_RULE_ID = 9001;           // global Accept-Language rule (when langEnabled)
const AL_ANTHROPIC_RULE_ID = 9002; // always-on Accept-Language rule for Anthropic
// Anthropic properties always get the spoofed Accept-Language regardless of the
// language toggle (requestDomains matches these domains and their subdomains).
const ANTHROPIC_DOMAINS = ['anthropic.com', 'claude.ai', 'claude.com'];

// Apply the Accept-Language override to every request type. Omitting resource
// types (or listing only a subset) leaves images/scripts/fonts/beacons sending
// the real host Accept-Language, which contradicts the spoofed navigator.language.
const AL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'other',
];

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
      removeRuleIds: [AL_RULE_ID, AL_ANTHROPIC_RULE_ID],
    });
    const al = override && override.acceptLanguage;
    if (!al) return; // nothing to enforce yet
    const action = {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'accept-language', operation: 'set', value: al }],
    };
    const rules = [];
    // Global rule, gated by the language toggle.
    if (settings && settings.langEnabled) {
      rules.push({ id: AL_RULE_ID, priority: 1, action, condition: { urlFilter: '*', resourceTypes: AL_RESOURCE_TYPES } });
    }
    // Always-on rule for Anthropic domains, independent of the toggle.
    rules.push({ id: AL_ANTHROPIC_RULE_ID, priority: 2, action, condition: { requestDomains: ANTHROPIC_DOMAINS, resourceTypes: AL_RESOURCE_TYPES } });
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  } catch (_) { /* DNR may be unavailable on some builds; fail soft */ }
}

/**
 * Force WebRTC through the proxy so ICE candidates can't leak the machine's real
 * (proxy-bypassing) public/LAN IP — which would geolocate to the host city and
 * blow the whole "match the exit IP" premise. Extension-controlled privacy
 * settings auto-revert when GeoMirror is disabled or removed. Fails soft where
 * the privacy API is unavailable.
 */
async function syncWebRTC(settings) {
  try {
    if (!(chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy)) return;
    const on = !!(settings && settings.webrtcProtect);
    if (on) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    } else {
      // Relinquish control rather than pinning 'default' under this extension.
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    }
  } catch (_) { /* privacy API may be restricted; fail soft */ }
}

/** Build an override from the user's manual timezone (fallback when the exit-IP
 *  path can't confirm a timezone). Coordinates come from the timezone's profile
 *  city (jittered) so geolocation stays consistent; locale is inferred the same
 *  way as the auto path. */
function buildManualOverride(s, now, note) {
  const prof = TZData.profileForTz(s.manualTz);
  const j = (prof.lat != null) ? GeoUtil.jitterCoord(prof.lat, prof.lon, 300, 1500) : null;
  const loc = Locale.localeFor(prof.cc, s.manualTz);
  const override = {
    lat: j ? j.lat : null, lon: j ? j.lon : null, acc: s.accuracyM,
    source: 'manual', road: null, enabled: s.enabled, ts: now,
    timezone: s.manualTz, tzEnabled: s.tzEnabled, langEnabled: s.langEnabled,
    locale: loc ? loc.language : null,
    languages: loc ? loc.languages : null,
    acceptLanguage: loc ? loc.acceptLanguage : null,
  };
  const state = {
    status: 'manual',
    ip: null, ipCity: null, ipRegion: null, ipCountry: null, ipCountryCode: prof.cc,
    ipLat: null, ipLon: null, isp: null, provider: null,
    ipTimezone: s.manualTz, tzSource: 'manual', ipLocale: loc ? loc.language : null,
    overrideLat: override.lat, overrideLon: override.lon,
    overrideSource: 'manual', overrideRoad: null,
    overrideAddress: prof.label || s.manualTz,
    lastUpdated: now, lastError: note || null,
  };
  return { override, state };
}

async function refresh() {
  await patchState({ status: 'refreshing', lastError: null });
  const s = await getSettings();
  const now = Date.now();
  try {
    // Exit-IP detection is the priority — it confirms the real proxy timezone.
    const ip = await IPLoc.getIPLocation(s.ipToken);
    if (!ip || ip.lat == null) throw new Error('All IP geolocation providers failed.');

    const pick = await GeoUtil.chooseResidential(ip.lat, ip.lon, {
      radius: 2500, limit: 150, timeoutMs: 12000,
    });
    const addr = await IPLoc.getDisplayAddress(pick.lat, pick.lon);

    // Prefer the provider's IANA timezone. If the provider omitted it, fall back
    // to the user's manual timezone rather than leaking the real one.
    const timezone = ip.timezone || s.manualTz || null;
    const tzSource = ip.timezone ? 'ip' : (s.manualTz ? 'manual' : 'none');
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
      ipTimezone: timezone, tzSource,
      ipLocale: loc ? loc.language : null,
      overrideLat: pick.lat, overrideLon: pick.lon,
      overrideSource: pick.source, overrideRoad: pick.road || null,
      overrideAddress: addr ? addr.text : '',
      lastUpdated: now, lastError: null,
    };
    await chrome.storage.local.set({ override, state });
    await syncHeaderRule(s, override);
    await syncWebRTC(s);
  } catch (e) {
    const err = String((e && e.message) || e);
    if (s.manualTz) {
      // Detection failed but the user set a manual timezone — use it.
      const { override, state } = buildManualOverride(s, now, 'Exit-IP detection failed; using manual timezone. (' + err + ')');
      await chrome.storage.local.set({ override, state });
      await syncHeaderRule(s, override);
      await syncWebRTC(s);
    } else {
      await patchState({ status: 'error', lastError: err, lastUpdated: now });
    }
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
  await syncWebRTC(await getSettings());
  await refresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  const { state, override, settings } = await chrome.storage.local.get(['state', 'override', 'settings']);
  // Re-assert the header rule + WebRTC policy on startup (extension-controlled
  // settings and dynamic rules aren't guaranteed to persist across restarts).
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  await syncHeaderRule(merged, override);
  await syncWebRTC(merged);
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
      // Toggling language spoofing changes whether the header rule is active;
      // toggling location/WebRTC protection changes the WebRTC policy.
      await syncHeaderRule(next, override);
      await syncWebRTC(next);
      if (msg.patch && 'refreshMinutes' in msg.patch) await ensureAlarm();
    }
    // Return a fresh snapshot for any message (covers GET_STATE too).
    const { state, override, settings } = await chrome.storage.local.get(['state', 'override', 'settings']);
    sendResponse({ state, override, settings: { ...DEFAULT_SETTINGS, ...(settings || {}) } });
  })();
  return true; // keep channel open for async sendResponse
});
