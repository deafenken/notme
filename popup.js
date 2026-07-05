/* GeoMirror — popup UI logic. */
const $ = (id) => document.getElementById(id);
let busy = false;

function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleString();
}

function sourceLabel(s) {
  return ({
    overpass: 'Residential street · OpenStreetMap',
    jitter: 'Nearby point · offset fallback',
    ipcenter: 'IP center',
  })[s] || s || '';
}

function render({ state, override, settings }) {
  const st = state || {};
  const ok = st.status === 'ok';
  const dot = $('dot'), txt = $('statusText');

  if (st.status === 'refreshing' || busy) {
    dot.className = 'dot busy';
    txt.textContent = 'Updating…';
  } else if (ok) {
    dot.className = 'dot ok';
    txt.textContent = 'Active';
  } else if (st.status === 'manual') {
    dot.className = 'dot ok';
    txt.textContent = st.mismatch ? 'Active · forced TZ (≠ exit IP)' : 'Active · forced timezone';
  } else {
    dot.className = 'dot err';
    txt.textContent = st.lastError ? ('Error: ' + st.lastError)
      : 'Detection failed — pick a manual timezone below';
  }

  $('ip').textContent = st.ip || '—';
  $('ipLoc').textContent = [st.ipCity, st.ipRegion, st.ipCountry].filter(Boolean).join(', ') || '—';
  $('isp').textContent = st.isp ? st.isp : '';

  const lat = (st.overrideLat != null) ? st.overrideLat : (override ? override.lat : null);
  const lon = (st.overrideLon != null) ? st.overrideLon : (override ? override.lon : null);
  $('addr').textContent = st.overrideAddress ||
    (lat != null ? lat.toFixed(5) + ', ' + lon.toFixed(5) : '—');
  $('coords').textContent = (lat != null) ? lat.toFixed(5) + ', ' + lon.toFixed(5) : '—';
  $('source').textContent = st.overrideSource
    ? sourceLabel(st.overrideSource) + (st.overrideRoad ? ' · ' + st.overrideRoad : '')
    : '';

  const tzSrc = (st.tzSource === 'manual' || st.status === 'manual') ? ' · forced'
    : (st.tzSource === 'ip' ? ' · detected' : '');
  $('tz').textContent = (override && override.timezone) ? override.timezone + tzSrc
    : (st.ipTimezone ? st.ipTimezone + ' (no override)' : '—');
  $('lang').textContent = (override && override.locale) ? override.locale
    : (st.ipLocale ? st.ipLocale + ' (no override)' : '—');

  $('updated').textContent = 'Updated ' + fmtTime(st.lastUpdated);

  $('enabled').checked = settings ? settings.enabled !== false : true;
  $('tzEnabled').checked = settings ? settings.tzEnabled !== false : true;
  $('langEnabled').checked = settings ? settings.langEnabled !== false : true;
  $('webrtcProtect').checked = settings ? settings.webrtcProtect !== false : true;
  $('fontEnabled').checked = settings ? settings.fontEnabled !== false : true;
  $('workerEnabled').checked = settings ? settings.workerEnabled !== false : true;
  if (settings) {
    $('accuracyM').value = settings.accuracyM;
    $('refreshMinutes').value = settings.refreshMinutes;
    $('ipToken').value = settings.ipToken || '';
    $('manualTz').value = settings.manualTz || '';
  }
}

// Populate the manual-timezone dropdown once (from lib/tzdata.js).
(function populateManualTz() {
  const sel = $('manualTz');
  if (!sel || !window.TZData) return;
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'Auto — use exit IP';
  sel.appendChild(none);
  for (const tz of TZData.TZ_ORDER) {
    const o = document.createElement('option');
    o.value = tz; o.textContent = TZData.TZ_PROFILES[tz].label;
    sel.appendChild(o);
  }
})();

function send(msg) {
  return new Promise((res) => chrome.runtime.sendMessage(msg, res));
}

async function load() {
  const snap = await send({ type: 'GET_STATE' });
  render(snap);
}

function bind(id, key, map) {
  $(id).addEventListener('change', async (e) => {
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (map) v = map(v);
    await send({ type: 'SET_SETTINGS', patch: { [key]: v } });
    await load();
  });
}

bind('enabled', 'enabled');
bind('tzEnabled', 'tzEnabled');
bind('langEnabled', 'langEnabled');
bind('webrtcProtect', 'webrtcProtect');
bind('fontEnabled', 'fontEnabled');
bind('workerEnabled', 'workerEnabled');
bind('accuracyM', 'accuracyM', (v) => Math.max(5, Math.min(500, +v || 30)));
bind('refreshMinutes', 'refreshMinutes', (v) => Math.max(30, Math.min(10080, +v || 360)));
bind('ipToken', 'ipToken', (v) => (v || '').trim());

// Manual timezone: save, then re-detect so it applies immediately (IP detection
// still wins when it succeeds; the manual value is the fallback).
$('manualTz').addEventListener('change', async (e) => {
  if (busy) return;
  busy = true;
  $('dot').className = 'dot busy';
  $('statusText').textContent = 'Updating…';
  await send({ type: 'SET_SETTINGS', patch: { manualTz: e.target.value || '' } });
  await send({ type: 'REFRESH' });
  busy = false;
  await load();
});

$('refresh').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  $('dot').className = 'dot busy';
  $('statusText').textContent = 'Updating…';
  await send({ type: 'REFRESH' });
  busy = false;
  $('refresh').disabled = false;
  await load();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.state || changes.override || changes.settings)) load();
});

load();
