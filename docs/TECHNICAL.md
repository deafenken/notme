# GeoMirror technical notes

## Purpose

GeoMirror aligns the browser-visible profile with the current proxy/VPN exit IP. It does not change the network IP itself; it changes browser surfaces that otherwise commonly contradict the proxy location.

The extension currently spoofs:

- HTML5 geolocation (`navigator.geolocation`)
- geolocation permission query result
- JavaScript timezone offset (`Date.prototype.getTimezoneOffset`)
- default `Intl.DateTimeFormat` timezone
- `navigator.language`
- `navigator.languages`
- default `Intl.NumberFormat`, `Intl.Collator`, and `Intl.DateTimeFormat` locale
- outgoing `Accept-Language` header via Chrome `declarativeNetRequest`

## Runtime flow

1. `background.js` detects the visible exit IP location using multiple IP providers.
2. `lib/providers.js` normalizes provider responses and preserves IANA timezone IDs when providers return them.
3. `lib/geo.js` chooses a nearby residential-looking coordinate using Overpass/OpenStreetMap, with fallback logic when Overpass is unavailable.
4. `lib/locale.js` infers a plausible locale bundle from country code and timezone.
5. `background.js` stores the computed override and status in `chrome.storage.local`.
6. `content-bridge.js` runs in the isolated extension world, reads storage, and publishes the payload to `<html data-geomirror="...">`.
7. `content-inject.js` runs in the page MAIN world at `document_start`, reads that payload, and patches browser APIs before normal page scripts run.
8. `background.js` installs a dynamic DNR rule to set the outgoing `Accept-Language` request header when language spoofing is enabled.

## Why there are two content scripts

Chrome extension isolated-world scripts can access `chrome.storage`, but page scripts cannot see their JavaScript objects. MAIN-world scripts can patch page-visible browser APIs, but cannot use extension APIs.

The bridge solves this split:

- `content-bridge.js`: isolated world, has `chrome.storage`, writes JSON into a DOM attribute.
- `content-inject.js`: MAIN world, reads that DOM attribute, patches page-visible APIs.

## Timezone implementation

`lib/timezone.js` computes the JavaScript `getTimezoneOffset` value for an IANA timezone at a specific `Date` instance. It uses `Intl.DateTimeFormat(..., { timeZone })` to format the same UTC instant as local wall time, then converts the difference back to the JavaScript sign convention:

- UTC+9 returns `-540`
- UTC-7 returns `+420`
- UTC-8 returns `+480`

This is DST-aware. The patched `Date.prototype.getTimezoneOffset` passes `this`, so historical/future dates use the correct offset for that date instead of the current offset.

## Language implementation

IP providers generally do not return a real user language. `lib/locale.js` uses deterministic offline inference:

- country code provides the default locale
- timezone refines multilingual countries where useful
- fallback is `en-US,en`

The resulting bundle is used for both JS-visible locale values and the HTTP `Accept-Language` header.

## Limitations

- This is browser-surface alignment, not a full anti-fingerprinting system.
- Locale inference is heuristic.
- Provider timezone quality depends on the IP geolocation provider.
- Some pages can use high-entropy fingerprinting surfaces not covered here.
- Extensions cannot modify every possible low-level browser/network signal.

## Testing

Run:

```bash
node test/run-tests.js
node --check background.js
node --check content-inject.js
node --check content-bridge.js
node --check lib/providers.js
node --check lib/locale.js
node --check lib/timezone.js
node --check popup.js
```

Manual browser verification:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load this directory as an unpacked extension.
4. Trigger refresh in the popup.
5. On a test page, verify:
   - `navigator.geolocation.getCurrentPosition(...)`
   - `navigator.language`
   - `navigator.languages`
   - `Intl.DateTimeFormat().resolvedOptions()`
   - `new Date().getTimezoneOffset()`
   - Network request `Accept-Language` header in DevTools.
