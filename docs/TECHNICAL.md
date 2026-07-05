# GeoMirror technical notes

## Purpose

GeoMirror aligns the browser-visible profile with the current proxy/VPN exit IP. It does not change the network IP itself; it changes browser surfaces that otherwise commonly contradict the proxy location.

The extension currently spoofs:

- HTML5 geolocation (`navigator.geolocation`), returning a real `GeolocationPosition`
- geolocation permission query result (a real `PermissionStatus` reporting `granted`)
- the entire `Date` local-time surface in the spoofed IANA zone:
  - `getTimezoneOffset`
  - local getters: `getFullYear`/`getMonth`/`getDate`/`getDay`/`getHours`/`getMinutes`/`getSeconds`/`getMilliseconds`/`getYear`
  - local setters: `setFullYear`/`setMonth`/`setDate`/`setHours`/`setMinutes`/`setSeconds`/`setMilliseconds`/`setYear`
  - `toString`/`toDateString`/`toTimeString`
  - `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`
  - the numeric multi-arg constructor, offset-less `Date.parse` / `new Date(string)`, and `Date()` called as a function
- default `Intl.DateTimeFormat` timezone (injected even when a locale is supplied)
- `navigator.language` and `navigator.languages`
- default locale for `Intl.DateTimeFormat`, `NumberFormat`, `Collator`, `RelativeTimeFormat`, `PluralRules`, `ListFormat`, `DisplayNames`, `Segmenter`, `DurationFormat`
- `Number`/`Array`/`BigInt.prototype.toLocaleString`
- outgoing `Accept-Language` header on all resource types via Chrome `declarativeNetRequest`
- WebRTC IP-handling policy (optional, via `chrome.privacy`) so ICE candidates can't bypass the proxy
- timezone + locale inside dedicated Web Workers (optional; see below)
- CJK font width probing on canvas `measureText` and DOM `getBoundingClientRect`/`getClientRects`/`offsetWidth`/`offsetHeight` (optional; see below)
- `Function.prototype.toString` (so spoofed functions read as native)

## Runtime flow

1. `background.js` detects the visible exit IP location using multiple IP providers.
2. `lib/providers.js` normalizes provider responses and preserves IANA timezone IDs when providers return them.
3. `lib/geo.js` chooses a nearby residential-looking coordinate using Overpass/OpenStreetMap, with fallback logic when Overpass is unavailable.
4. `lib/locale.js` infers a plausible locale bundle from country code and timezone.
5. `background.js` stores the computed override and status in `chrome.storage.local`.
6. `content-bridge.js` runs in the isolated extension world, reads storage, and posts the payload to the MAIN world via `window.postMessage` (with a request/response handshake so delivery is robust regardless of script order).
7. `content-inject.js` runs in the page MAIN world at `document_start`, reads that payload, and patches browser APIs before normal page scripts run.
8. `background.js` installs a dynamic DNR rule to set the outgoing `Accept-Language` request header when language spoofing is enabled.

## Why there are two content scripts

Chrome extension isolated-world scripts can access `chrome.storage`, but page scripts cannot see their JavaScript objects. MAIN-world scripts can patch page-visible browser APIs, but cannot use extension APIs.

The bridge solves this split:

- `content-bridge.js`: isolated world, has `chrome.storage`, posts JSON to the MAIN world via `window.postMessage`.
- `content-inject.js`: MAIN world, receives that message, patches page-visible APIs.

`window.postMessage` is used rather than a shared DOM attribute or a `CustomEvent`: an attribute is observable by a generic `MutationObserver`, and a `CustomEvent`'s `detail` does not cross the isolated→MAIN world boundary in Chromium (it arrives as `null`). `postMessage` structured-clones the payload reliably across worlds and leaves no DOM mutation.

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

## Date virtualization

The wrappers share one source of truth in `lib/timezone.js`:

- `tzOffsetMinutes(tz, date)` — DST-aware `getTimezoneOffset` value.
- `wallClock(tz, date)` — the target-zone wall-clock components (shift the UTC instant by the offset, read UTC fields).
- `localWallToEpoch(tz, y, mo, …)` — the inverse, used by setters, the numeric constructor, and offset-less parsing, with a single DST re-check.
- `nativeDateStrings(tz, date)` / `tzName` / `formatGMT` — reproduce the native `toString` layout, including the localized zone long name.

Each Date wrapper is installed once and consults the live override state on every call, so toggling a switch in the popup takes effect without reloading the page and wrappers never stack. When a toggle is off (or override data hasn't arrived) every wrapper delegates to the captured native method.

## WebRTC

When "Block WebRTC IP leak" is on, the service worker sets
`chrome.privacy.network.webRTCIPHandlingPolicy` to `disable_non_proxied_udp`.
This forces WebRTC to use the proxy path; if the proxy has no UDP relay, WebRTC
media fails to connect rather than leaking the real IP. Extension-controlled
privacy settings revert automatically when GeoMirror is disabled or removed.

## Web Worker spoofing ("Spoof in Web Workers" toggle — experimental, default OFF)

Content scripts don't run inside worker scopes, so a fingerprinter can read the
real timezone/locale from a `new Worker(...)`. When enabled, GeoMirror wraps the
`Worker` constructor: for a classic dedicated worker it builds a small blob whose
body (1) runs a self-contained patch of `Date` (offset, local getters, string
methods, `toLocale*`) / `Intl` / `navigator` for the spoofed zone/locale,
(2) rewrites `importScripts`, `fetch`, and `XMLHttpRequest.open` to resolve
relative URLs against the original script URL, then (3) `importScripts` the
original script.

This is **off by default and experimental** because rewriting a worker through a
blob has boundaries a shim can't fully paper over:

- **CSP.** A policy that omits `blob:` (e.g. `script-src 'self'`) blocks the blob
  worker *asynchronously* — the constructor doesn't throw, so a try/catch can't
  catch it. To avoid silently killing the worker, GeoMirror runs a one-shot probe
  worker and only takes the blob path once blob workers are **confirmed** to run
  on the page; until then (and permanently on CSP-restricted pages) workers pass
  through natively (unspoofed but working).
- **`self.location`.** Inside the blob worker it is the blob URL. Workers that
  derive resource URLs from `self.location`, or use dynamic `import()`, can
  misbehave — this can't be rebased, which is why the feature is opt-in.
- Module workers (`{type:'module'}`), `SharedWorker`, `ServiceWorker`, and
  Worklets are passed through / not wrapped.
- The in-worker patch spoofs the timezone/locale *values*; it does not fully
  harden native-identity (`Function.prototype.toString`) inside the worker.

Any failure falls back to a normal, unpatched worker, so pages don't break — but
if a specific site's worker misbehaves, turn the toggle off.

## Font hiding ("Hide CJK fonts" toggle)

Width-based font probes render a string in `"'TestFont', <generic>"` and compare
the measured width against the generic baseline; an installed font shifts the
width. GeoMirror patches `CanvasRenderingContext2D.measureText` (and the
offscreen variant) plus `Element.getBoundingClientRect`/`getClientRects` and
`HTMLElement.offsetWidth`/`offsetHeight`: when the measured font-family names a
blacklisted CJK font (Microsoft YaHei, PingFang, SimSun, SimHei, KaiTi, MingLiU,
Source Han / Noto CJK, …, both Simplified and Traditional), those families are
stripped before measuring, so the probe reads the generic baseline and concludes
the font is not installed. This hides the OS/region signal (a Windows/macOS
Chinese font set contradicting, say, a Los Angeles exit IP). The DOM path only
acts on elements that declare a CJK font inline, so normal layout is untouched.

## Limitations

- This is browser-surface alignment, not a full anti-fingerprinting system (canvas image/WebGL/audio/UA are intentionally untouched; only CJK-font width probing is addressed).
- Locale inference is heuristic; provider timezone quality depends on the IP geolocation provider.
- Worker coverage is limited to classic dedicated workers (see above); Shared/Service Workers and Worklets still read the host zone.
- Font hiding targets width probes; it does not alter canvas *pixel* readback (`toDataURL`/`getImageData`) fingerprints, and DOM probes that set the font via a CSS class rather than inline style are not covered.
- Extensions cannot inject into `chrome://` / `edge://`, the extension stores, or other privileged pages.
- Some platforms use high-entropy or non-browser signals (TLS/HTTP fingerprints, account history) that an extension cannot modify.

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
