# Privacy Policy

notme is designed to be minimal and auditable. This page describes exactly
what data the extension touches, where it goes, and where it does **not** go.

## The short version

notme makes **no requests to any server it does not need**, sends **no
telemetry**, collects **no analytics**, and shares data with **no third party
other than the four geolocation services listed below** — which it contacts only
to do its job, and only with the minimum information required.

## What the extension does

1. On startup, on a schedule, and when you click *Refresh*, the background
   service worker asks a geolocation service for the location of your current
   **outbound IP**. Because the request travels through Chrome's normal network
   stack, it sees the same IP that websites see (i.e. through your proxy/VPN if
   you use one).
2. It then queries the OpenStreetMap Overpass API for residential roads near
   that location and picks a point on one of them as the override coordinate.
3. It optionally asks BigDataCloud for a human-readable address of that point,
   purely so the popup can display it.
4. A content script injects the chosen coordinate into `navigator.geolocation`
   on the pages you visit, so pages receive a location consistent with your IP.

## Network requests (the complete list)

| Host | Purpose | Data sent |
| --- | --- | --- |
| `reallyfreegeoip.org` | Primary IP geolocation | GET request only — your exit IP is visible to the service as the source address |
| `ipwho.is` | Fallback IP geolocation | GET only |
| `ipapi.co` | Fallback IP geolocation | GET only |
| `ipinfo.io` | Fallback IP geolocation; optional token if you provide one | GET; your token if entered |
| `overpass-api.de`, `overpass.kumi.systems`, `maps.mail.ru/osm/tools/overpass` | Find nearby residential roads (OpenStreetMap) | The exit-IP latitude/longitude |
| `api.bigdatacloud.net` | Reverse-geocode the chosen point for display | The chosen override latitude/longitude |

These are the **only** outbound connections the extension ever makes. They are
declared in `manifest.json` under `host_permissions`, so you can verify them
yourself and Chrome will warn you before granting them.

## What is stored, and where

- The detected IP, the chosen override coordinate, and your settings are stored
  **locally** in Chrome's extension storage (`chrome.storage.local`). They never
  leave your machine.
- Nothing is written to disk outside Chrome's own storage.

## What the extension does NOT do

- No analytics, no telemetry, no crash reporting, no tracking pixels.
- No reading of page content, cookies, credentials, or form data. The content
  script only overrides `navigator.geolocation` and the geolocation permission
  query — nothing else.
- No background data resale or "SDK" of any kind.
- No account, no sign-up, no login.

## A note on trust

This extension requests the permission "read and change all your data on all
websites". That permission is **required** because it must run a content script
on every site to override the geolocation API — there is no narrower way to do
this in Chrome. It is also the kind of permission a malicious extension could
abuse, so you are right to scrutinize it. The source code is short and fully
auditable; in particular, `content-inject.js` only touches `navigator.geolocation`
and `navigator.permissions`, and the content scripts never read page content.

If you are privacy-conscious, you can run it unpacked from source so you can
read and rebuild it yourself at any time.

## Changes

Any future change to this policy will be reflected in this file and noted in the
changelog.
