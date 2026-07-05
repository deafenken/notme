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
  } else {
    dot.className = 'dot err';
    txt.textContent = st.lastError ? ('Error: ' + st.lastError) : 'Error';
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

  $('tz').textContent = (override && override.timezone) ? override.timezone
    : (st.ipTimezone ? st.ipTimezone + ' (no override)' : '—');
  $('lang').textContent = (override && override.locale) ? override.locale
    : (st.ipLocale ? st.ipLocale + ' (no override)' : '—');

  $('updated').textContent = 'Updated ' + fmtTime(st.lastUpdated);

  $('enabled').checked = settings ? settings.enabled !== false : true;
  $('tzEnabled').checked = settings ? settings.tzEnabled !== false : true;
  $('langEnabled').checked = settings ? settings.langEnabled !== false : true;
  $('webrtcProtect').checked = settings ? settings.webrtcProtect !== false : true;
  if (settings) {
    $('accuracyM').value = settings.accuracyM;
    $('refreshMinutes').value = settings.refreshMinutes;
    $('ipToken').value = settings.ipToken || '';
  }
}

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
bind('accuracyM', 'accuracyM', (v) => Math.max(5, Math.min(500, +v || 30)));
bind('refreshMinutes', 'refreshMinutes', (v) => Math.max(30, Math.min(10080, +v || 360)));
bind('ipToken', 'ipToken', (v) => (v || '').trim());

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
