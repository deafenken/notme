# GeoMirror

> Make your browser profile match your visible IP: geolocation, timezone, language, and `Accept-Language` — automatically, on every page.

GeoMirror is a Chrome Manifest V3 extension for people who use proxies, VPNs, remote desktops, or regional network exits and want the browser-visible environment to be internally consistent.

[中文说明](./README.zh-CN.md) · [Privacy policy](./PRIVACY.md) · [Technical notes](./docs/TECHNICAL.md)

---

## Motivation: IP alone is not enough

Recent Claude / Anthropic account-ban controversies made one thing very clear: location-based risk controls can become brutal when they are applied mechanically. Many users reported that simply changing IPs, traveling, using VPNs, or having inconsistent regional signals could trigger account restrictions or bans. When a company such as Anthropic turns coarse address/location heuristics into account loss, the result is infuriating — but anger does not solve the operational problem.

The practical problem is this:

Most people only change their **IP address**. Their browser still exposes signals from somewhere else:

- `navigator.geolocation` may reveal the real physical location.
- `Date.prototype.getTimezoneOffset()` may reveal the local machine timezone.
- `Intl.DateTimeFormat().resolvedOptions().timeZone` may reveal the system timezone.
- `navigator.language` / `navigator.languages` may reveal the host language.
- the HTTP `Accept-Language` header may reveal another locale.

That mismatch is exactly the kind of thing automated risk systems can use as a proxy/VPN/fraud signal. GeoMirror exists to close that gap.

## What GeoMirror does

GeoMirror detects your visible **exit IP**, derives a plausible browser profile from that IP, and applies it locally inside Chrome:

| Surface | What GeoMirror changes |
| --- | --- |
| HTML5 geolocation | Spoofs `navigator.geolocation` to a residential-looking coordinate near the exit IP, and returns a genuine `GeolocationPosition`. |
| Geolocation permission | Reports geolocation permission as `granted` via a real `PermissionStatus`, to avoid permission-state mismatch. |
| **Whole `Date` local-time surface** | DST-aware IANA logic drives `getTimezoneOffset()` **and** every local getter (`getHours`/`getDate`/`getDay`/`getMonth`/`getFullYear`/…), the local setters, `toString`/`toDateString`/`toTimeString`, `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString`, the numeric multi-arg constructor, offset-less `Date.parse`, and `Date()` called as a function — so no `Date` method contradicts the spoofed offset. |
| Intl timezone | Spoofs default `Intl.DateTimeFormat` timezone and `resolvedOptions().timeZone` (even when a locale is passed). |
| Browser language | Spoofs `navigator.language` and `navigator.languages`. |
| Intl locale | Spoofs the default locale for `DateTimeFormat`, `NumberFormat`, `Collator`, `RelativeTimeFormat`, `PluralRules`, `ListFormat`, `DisplayNames`, `Segmenter`, `DurationFormat`, plus `Number`/`Array`/`BigInt.prototype.toLocaleString`. |
| Request language | Sets the outgoing `Accept-Language` header on **all** request types via Chrome `declarativeNetRequest`. |
| WebRTC IP leak | Optionally forces WebRTC through the proxy (`chrome.privacy` → `disable_non_proxied_udp`) so ICE candidates can't reveal the real, proxy-bypassing IP. |
| Anti-detection | Spoofed functions report native to both `fn.toString()` and the intrinsic `Function.prototype.toString.call(fn)`; the override payload is not left in the DOM. |

The goal is simple: if your IP looks like Tokyo, the browser should not still look like Shanghai, Los Angeles, or Berlin — and no single `Date` or `Intl` call should quietly give it away.

## Privacy model

GeoMirror is local-first and auditable:

- No account.
- No telemetry.
- No analytics.
- No page-content reading.
- No remote configuration.
- Computed overrides and settings are stored in `chrome.storage.local`.

Important accuracy note: GeoMirror is not a zero-network extension. To match your current exit IP automatically, it must call explicitly listed public IP/geolocation/map APIs through Chrome’s network stack. These requests are limited to:

- detecting the exit IP location,
- finding nearby residential roads,
- reverse-geocoding a display address for the popup.

It does not upload page content or browsing history. See [PRIVACY.md](./PRIVACY.md) and [docs/TECHNICAL.md](./docs/TECHNICAL.md) for the exact data flow.

## How it works

```
   proxy / VPN / remote exit          Chrome + GeoMirror
              │                              │
              ▼                              ▼
        visible exit IP ───────► background service worker
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
          IP geolocation      residential roads      reverse geocode
          + timezone          near exit IP            for popup display
                 │                    │                    │
                 └──────────────► computed override ◄──────┘
                                      │
                         stored in chrome.storage.local
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
          isolated-world bridge              MAIN-world injector
          reads extension storage            patches page-visible APIs
                    │                                   │
                    └────────────► page sees a coherent browser profile
```

Technical sequence:

1. `background.js` detects the visible exit IP using multiple providers.
2. `lib/providers.js` normalizes IP geolocation data and preserves provider timezone fields such as `Asia/Tokyo`.
3. `lib/geo.js` chooses a nearby residential-looking coordinate using OpenStreetMap / Overpass.
4. `lib/locale.js` infers a plausible locale bundle from country code + timezone.
5. `background.js` stores the override locally and installs a dynamic `Accept-Language` header rule.
6. `content-bridge.js` runs in Chrome’s isolated extension world, reads local storage, and posts the payload to the MAIN world via `window.postMessage`.
7. `content-inject.js` runs in the page’s MAIN world at `document_start` and patches the browser APIs before page scripts run.

## Install

### Option A — load unpacked (Chrome / Brave / any Chromium)

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `geomirror` folder.
6. Pin GeoMirror and click **Refresh** in the popup.

### Option B — load unpacked (Microsoft Edge)

GeoMirror is a standard Chromium MV3 extension, so Edge loads it the same way:

1. Download or clone this repository.
2. Open `edge://extensions` (type it into the address bar).
3. Toggle **Developer mode** on (bottom-left).
4. Click **Load unpacked**.
5. Select the `geomirror` folder (the one containing `manifest.json`).
6. Pin GeoMirror from the puzzle-piece menu, open it, and click **Refresh**.

Edge honors the same `chrome.*` APIs GeoMirror uses (`declarativeNetRequest`, `alarms`, `privacy`), so all features work unchanged. If the popup shows an error, click **Refresh** once your proxy/VPN is connected.

### Option C — Chrome Web Store / Edge Add-ons

Store listings are planned. Until then, use the unpacked extension.

## Verify it works

Open a fingerprint/location test page and check these values:

```js
navigator.language
navigator.languages
Intl.DateTimeFormat().resolvedOptions()
new Date().getTimezoneOffset()
navigator.geolocation.getCurrentPosition(console.log, console.error)
```

Also check DevTools → Network → request headers and confirm `Accept-Language` matches the spoofed locale.

Useful public checks:

- https://browserleaks.com/geo
- https://browserleaks.com/javascript
- https://browserleaks.com/headers

## Settings

- **Location spoof** — enable/disable geolocation override.
- **Timezone spoof** — enable/disable the `Date` and `Intl` timezone override.
- **Language spoof** — enable/disable `navigator.language(s)`, Intl locale, and `Accept-Language` header override.
- **Block WebRTC IP leak** — force WebRTC through the proxy so ICE candidates can't expose the real IP. Default on. Turn it off if you use WebRTC calls (e.g. video chat) over a proxy that has no UDP relay — with it on, such calls may fail to connect rather than leak.
- **Reported accuracy (m)** — reported GPS accuracy, default 30 m.
- **Auto-refresh interval (minutes)** — how often GeoMirror re-detects the exit IP.
- **ipinfo.io token (optional)** — improves fallback reliability if you have a token.

## Why each permission

| Permission | Why |
| --- | --- |
| `storage` | Save settings and computed overrides locally. |
| `alarms` | Schedule periodic exit-IP refresh. |
| `declarativeNetRequest` | Set the outgoing `Accept-Language` header without reading page traffic. |
| `privacy` | Set the WebRTC IP-handling policy so WebRTC can't leak the real IP. Optional — controlled by the "Block WebRTC IP leak" toggle. |
| `<all_urls>` content script | Patch browser APIs on normal web pages before page scripts run. |
| `host_permissions: <all_urls>` | Required for two reasons: `declarativeNetRequest` `modifyHeaders` only applies to sites the extension has host access to (without it the `Accept-Language` rule is silently skipped on the sites you actually visit), and the IP/geolocation/Overpass/reverse-geocode providers must be reachable. |

## If you do not want to install this extension

You can ask your own coding agent to build a local version. Copy this prompt:

```text
Build a Chrome Manifest V3 extension that aligns browser-visible location signals with the current visible exit IP.

Requirements:
1. Detect the browser's visible exit IP location through Chrome's network stack using multiple fallback IP geolocation providers.
2. Preserve provider fields for country code, city/region/country, latitude/longitude, ISP, and IANA timezone.
3. Pick a nearby residential-looking coordinate instead of the raw IP centroid. Use OpenStreetMap Overpass highway=residential results when available, and a safe jitter fallback otherwise.
4. Infer a plausible locale bundle from country code + timezone: navigator.language, navigator.languages, and Accept-Language.
5. Store settings and computed overrides only in chrome.storage.local. Do not add telemetry, analytics, accounts, remote config, or page-content collection.
6. Use two content scripts:
   - an isolated-world bridge that can read chrome.storage and publish a JSON payload to the DOM;
   - a MAIN-world injector at document_start that patches page-visible APIs.
7. Patch:
   - navigator.geolocation.getCurrentPosition / watchPosition / clearWatch
   - navigator.permissions.query for geolocation
   - Date.prototype.getTimezoneOffset with DST-aware IANA timezone logic using the receiver Date instance
   - Intl.DateTimeFormat default timezone and resolvedOptions().timeZone
   - navigator.language and navigator.languages
   - Intl.DateTimeFormat / Intl.NumberFormat / Intl.Collator default locale
8. Use chrome.declarativeNetRequest to set the outgoing Accept-Language header when language spoofing is enabled.
9. Add a popup with toggles for location, timezone, language, accuracy, refresh interval, optional ipinfo token, and manual refresh.
10. Add tests for timezone DST offsets, locale inference, provider parsing, and manifest injection order.
11. Document the privacy model clearly: no telemetry, no page-content reading, local storage only, and explicit provider requests only for exit-IP/location matching.
```

## What v1.2 fixed

These were real gaps in earlier versions and are now closed:

- **`Date` self-contradiction.** Previously only `getTimezoneOffset()` and `Intl.DateTimeFormat` were spoofed, so `new Date().getHours()`, `.toString()` (`… GMT+0800 (China Standard Time)`), `.toLocaleString()`, `Number.prototype.toLocaleString`, and most of the `Intl.*` family still leaked the host machine's timezone/locale — a one-line cross-check unmasked the spoof. The whole `Date` local-time surface and every locale-aware `Intl` constructor are now virtualized in the exit-IP zone.
- **`Accept-Language` was silently not applied.** `declarativeNetRequest` `modifyHeaders` needs host access to the visited site; the old manifest only listed the IP-API domains, so the header rule was skipped on real sites. `host_permissions` is now `<all_urls>`, and the rule covers **all** resource types (previously only main-frame/sub-frame/XHR — images, fonts, scripts, and beacons leaked the real language).
- **`Intl.DateTimeFormat` dropped the timezone** in the no-locale path (a positional-argument bug), leaking the host timezone whenever timezone spoofing ran with language spoofing off. Fixed.
- **WebRTC could leak the real IP** around the proxy. Now optionally forced through the proxy.
- **Spoof detection.** `Function.prototype.toString.call(fn)` used to return the wrapper source; the override payload sat readable in `<html data-geomirror>`; `permissions.query` returned a plain object. All fixed.
- **Opaque-origin frames.** `about:blank` / `srcdoc` / `data:` / `blob:` child frames are now patched (`match_origin_as_fallback`).

## Remaining limitations (honest list)

- GeoMirror improves consistency of location/timezone/locale signals. It is **not** a complete anti-fingerprinting system (it does not touch canvas, WebGL, fonts, audio, screen, or User-Agent — deliberately, since spoofing those inconsistently is often *more* detectable).
- IP geolocation is approximate; the residential coordinate is a plausible nearby point, not your real address.
- Locale inference is heuristic — IP providers do not know your real language, so it is derived from country code + timezone.
- **Web Workers, Service Workers, and Worklets keep the real timezone/locale.** A content script cannot patch worker global scopes, and rewriting worker source would break cross-origin and relative-import workers. Code that reads `Date`/`Intl` **inside** a worker can still see the host zone. This is a hard platform limit for extensions.
- Browser extensions cannot inject into `chrome://` / `edge://`, the extension stores, or other privileged pages.
- Some platforms use additional risk signals outside browser JavaScript and headers (TLS/HTTP fingerprints, account history, behavioral signals) that no browser extension can change.

## Development

Project layout:

```
geomirror/
├── manifest.json
├── background.js
├── content-bridge.js
├── content-inject.js
├── docs/
│   └── TECHNICAL.md
├── lib/
│   ├── geo.js
│   ├── locale.js
│   ├── providers.js
│   └── timezone.js
├── popup.html
├── popup.css
├── popup.js
├── test/
│   └── run-tests.js
└── icons/
```

Checks:

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

After changing files, reload the extension in `chrome://extensions`.

## Contributing

Pull requests welcome. Keep the permission surface minimal and preserve the no-telemetry, no-page-content-reading guarantees.

## License

[MIT](./LICENSE)
