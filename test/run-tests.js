#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const TZ = require(path.join(__dirname, '..', 'lib', 'timezone.js'));
const Locale = require(path.join(__dirname, '..', 'lib', 'locale.js'));
const IPLoc = require(path.join(__dirname, '..', 'lib', 'providers.js'));
const TZData = require(path.join(__dirname, '..', 'lib', 'tzdata.js'));

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

function eq(actual, expected) {
  assert.deepStrictEqual(actual, expected);
}

test('timezone offsets are DST-aware and use the supplied Date instance', () => {
  eq(TZ.tzOffsetMinutes('America/Los_Angeles', new Date('2026-06-15T12:00:00Z')), 420);
  eq(TZ.tzOffsetMinutes('America/Los_Angeles', new Date('2026-01-15T12:00:00Z')), 480);
  eq(TZ.tzOffsetMinutes('Europe/London', new Date('2026-06-15T12:00:00Z')), -60);
  eq(TZ.tzOffsetMinutes('Europe/London', new Date('2026-01-15T12:00:00Z')), 0);
  eq(TZ.tzOffsetMinutes('Asia/Tokyo', new Date('2026-06-15T12:00:00Z')), -540);
  eq(TZ.tzOffsetMinutes('Asia/Shanghai', new Date('2026-06-15T12:00:00Z')), -480);
});

test('timezone helper returns null for invalid IANA timezone', () => {
  eq(TZ.tzOffsetMinutes('Not/A_Zone', new Date('2026-06-15T12:00:00Z')), null);
});

test('wallClock returns the target zone wall-clock components (DST + weekday)', () => {
  // 2026-06-15 03:00 UTC -> Tokyo (UTC+9) 12:00, and 2026-06-15 is a Monday.
  eq(TZ.wallClock('Asia/Tokyo', new Date('2026-06-15T03:00:00Z')), {
    year: 2026, month: 5, day: 15, hour: 12, minute: 0, second: 0, ms: 0, weekday: 1,
  });
  // 2026-01-15 00:00 UTC -> LA (PST, UTC-8) 2026-01-14 16:00, a Wednesday.
  eq(TZ.wallClock('America/Los_Angeles', new Date('2026-01-15T00:00:00Z')), {
    year: 2026, month: 0, day: 14, hour: 16, minute: 0, second: 0, ms: 0, weekday: 3,
  });
  // Half-hour zone keeps the :30 and preserves milliseconds.
  const k = TZ.wallClock('Asia/Kolkata', new Date('2026-06-15T06:15:00.123Z'));
  eq([k.hour, k.minute, k.ms], [11, 45, 123]);
});

test('localWallToEpoch round-trips through wallClock across zones and DST', () => {
  const cases = [
    ['Asia/Tokyo', 2026, 5, 15, 12, 30, 45, 0],
    ['America/Los_Angeles', 2026, 6, 4, 23, 59, 0, 0],   // PDT
    ['America/Los_Angeles', 2026, 0, 4, 8, 15, 0, 0],    // PST
    ['Asia/Kolkata', 2026, 2, 1, 5, 30, 0, 0],
    ['Europe/London', 2026, 11, 25, 0, 0, 0, 0],
  ];
  for (const [tz, y, mo, d, h, mi, s, ms] of cases) {
    const epoch = TZ.localWallToEpoch(tz, y, mo, d, h, mi, s, ms);
    const w = TZ.wallClock(tz, new Date(epoch));
    eq([w.year, w.month, w.day, w.hour, w.minute, w.second, w.ms],
       [y, mo, d, h, mi, s, ms]);
  }
});

test('localWallToEpoch resolves DST transition-day wall times like a local browser', () => {
  // America/New_York spring-forward: 2026-03-08 02:00 EST -> 03:00 EDT.
  // The nonexistent 02:30 shifts forward to 03:30 EDT = 07:30 UTC.
  eq(TZ.localWallToEpoch('America/New_York', 2026, 2, 8, 2, 30, 0, 0),
     Date.parse('2026-03-08T07:30:00Z'));
  // Fall-back: 2026-11-01 02:00 EDT -> 01:00 EST. Ambiguous 01:30 takes the
  // earlier (EDT) occurrence = 05:30 UTC.
  eq(TZ.localWallToEpoch('America/New_York', 2026, 10, 1, 1, 30, 0, 0),
     Date.parse('2026-11-01T05:30:00Z'));
  // A plain, non-transition day is unaffected.
  eq(TZ.localWallToEpoch('America/New_York', 2026, 5, 1, 12, 0, 0, 0),
     Date.parse('2026-06-01T16:00:00Z')); // noon EDT = 16:00 UTC
});

test('formatGMT matches the native GMT offset suffix', () => {
  eq(TZ.formatGMT(-540), 'GMT+0900'); // UTC+9
  eq(TZ.formatGMT(420), 'GMT-0700');  // UTC-7
  eq(TZ.formatGMT(480), 'GMT-0800');  // UTC-8
  eq(TZ.formatGMT(0), 'GMT+0000');
  eq(TZ.formatGMT(-330), 'GMT+0530'); // UTC+5:30
});

test('nativeDateStrings reproduces the native toString layout in the spoofed zone', () => {
  const s = TZ.nativeDateStrings('Asia/Tokyo', new Date('2026-06-15T03:00:00Z'));
  eq(s.date, 'Mon Jun 15 2026');
  eq(s.time, '12:00:00 GMT+0900 (Japan Standard Time)');
});

test('locale inference handles country defaults', () => {
  eq(Locale.localeFor('JP', 'Asia/Tokyo'), {
    language: 'ja-JP',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
    acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  });
  eq(Locale.localeFor('BR', 'America/Sao_Paulo').language, 'pt-BR');
  eq(Locale.localeFor('US', 'America/New_York').language, 'en-US');
});

test('locale inference uses timezone tie-breakers', () => {
  eq(Locale.localeFor('CA', 'America/Montreal').language, 'fr-CA');
  eq(Locale.localeFor('CA', 'America/Toronto').language, 'en-CA');
  eq(Locale.localeFor('BE', 'Europe/Brussels').languages, ['nl-BE', 'nl', 'fr-BE', 'fr', 'en']);
});

test('manual timezone fallback: profiles derive country, coords, and a locale', () => {
  const jp = TZData.profileForTz('Asia/Tokyo');
  eq([jp.cc, typeof jp.lat, typeof jp.lon], ['JP', 'number', 'number']);
  eq(Locale.localeFor(jp.cc, 'Asia/Tokyo').language, 'ja-JP');
  eq(Locale.localeFor(TZData.profileForTz('America/Los_Angeles').cc, 'America/Los_Angeles').language, 'en-US');
  eq(TZ.tzOffsetMinutes('Asia/Tokyo', new Date('2026-06-15T00:00:00Z')), -540);
  // every dropdown entry has a valid profile with a real IANA offset
  for (const tz of TZData.TZ_ORDER) {
    const p = TZData.profileForTz(tz);
    assert(p.cc && p.lat != null && p.label, 'incomplete profile for ' + tz);
    assert(TZ.tzOffsetMinutes(tz, new Date('2026-06-15T00:00:00Z')) !== null, 'bad tz ' + tz);
  }
  // unknown timezone still round-trips (tz kept, no coords)
  const u = TZData.profileForTz('Pacific/Chatham');
  eq([u.tz, u.lat, u.cc], ['Pacific/Chatham', null, null]);
  // China zones are intentionally excluded from the picker
  assert(!TZData.TZ_ORDER.includes('Asia/Shanghai'), 'China zones must not be offered');
});

test('locale inference falls back to neutral English', () => {
  eq(Locale.localeFor('ZZ', null), {
    language: 'en-US',
    languages: ['en-US', 'en'],
    acceptLanguage: 'en-US,en;q=0.9',
  });
});

test('IP providers parse timezone fields without discarding location fields', () => {
  const providers = Object.fromEntries(IPLoc.IP_PROVIDERS.map((provider) => [provider.name, provider]));

  eq(providers['ipwho.is'].parse({
    ip: '203.0.113.1',
    city: 'Tokyo',
    region: 'Tokyo',
    country: 'Japan',
    country_code: 'JP',
    latitude: 35.6895,
    longitude: 139.6917,
    connection: { isp: 'Example ISP' },
    timezone: { id: 'Asia/Tokyo' },
  }), {
    ip: '203.0.113.1',
    city: 'Tokyo',
    region: 'Tokyo',
    country: 'Japan',
    countryCode: 'JP',
    lat: 35.6895,
    lon: 139.6917,
    isp: 'Example ISP',
    timezone: 'Asia/Tokyo',
  });

  eq(providers['ipapi.co'].parse({
    ip: '203.0.113.2',
    city: 'Los Angeles',
    region: 'California',
    country_name: 'United States',
    country_code: 'US',
    latitude: '34.05',
    longitude: '-118.24',
    org: 'Example Org',
    timezone: 'America/Los_Angeles',
  }).timezone, 'America/Los_Angeles');

  eq(providers['ipinfo.io'].parse({
    ip: '203.0.113.3',
    city: 'London',
    region: 'England',
    country: 'GB',
    loc: '51.5072,-0.1276',
    org: 'Example Org',
    timezone: 'Europe/London',
  }).timezone, 'Europe/London');
});

test('manifest includes timezone helper before MAIN-world injector', () => {
  const manifest = require(path.join(__dirname, '..', 'manifest.json'));
  const mainScript = manifest.content_scripts.find((script) => script.world === 'MAIN');
  assert(mainScript, 'MAIN world content script is missing');
  eq(mainScript.js, ['lib/timezone.js', 'content-inject.js']);
  assert(manifest.permissions.includes('declarativeNetRequest'), 'DNR permission is required for Accept-Language');
});

test('manifest grants the host access DNR needs + covers about:blank/srcdoc frames', () => {
  const manifest = require(path.join(__dirname, '..', 'manifest.json'));
  // DNR modifyHeaders needs host access for the visited site, not just the API domains.
  assert(manifest.host_permissions.includes('<all_urls>'),
    'host_permissions must cover visited sites so the Accept-Language rule applies');
  // WebRTC IP-leak protection needs the privacy API.
  assert(manifest.permissions.includes('privacy'), 'privacy permission is required for WebRTC protection');
  // Both content scripts must reach about:blank / srcdoc / data: / blob: child frames.
  for (const cs of manifest.content_scripts) {
    assert(cs.match_origin_as_fallback === true,
      'content scripts must set match_origin_as_fallback to patch opaque-origin frames');
  }
});

test('background applies Accept-Language to all resource types and blocks WebRTC leaks', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  for (const t of ['script', 'image', 'font', 'media', 'ping', 'stylesheet', 'object']) {
    assert(src.includes(`'${t}'`), `Accept-Language rule must cover the ${t} resource type`);
  }
  assert(src.includes('disable_non_proxied_udp'), 'WebRTC policy must force non-proxied UDP off');
  assert(/webrtcProtect:\s*true/.test(src), 'webrtcProtect should default on');
});

test('Anthropic domains get always-on protection', () => {
  const fs = require('fs');
  const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert(/anthropic\.com/.test(bg) && /claude\.ai/.test(bg) && /claude\.com/.test(bg), 'Anthropic domains must be listed');
  assert(bg.includes('AL_ANTHROPIC_RULE_ID') && bg.includes('requestDomains'), 'always-on Anthropic Accept-Language rule required');
  const inj = fs.readFileSync(path.join(__dirname, '..', 'content-inject.js'), 'utf8');
  assert(/ON_ANTHROPIC/.test(inj), 'injector must force protection on Anthropic domains');
  assert(/delete window\.GeoMirrorTZ/.test(inj), 'the shared global must be deleted after capture');
});

if (process.exitCode) {
  console.error('\nTests failed.');
  process.exit(process.exitCode);
} else {
  console.log(`\n${passed} tests passed.`);
}
