---
name: Polytrack startup readiness
description: Distinguish a secondary startup TDZ error from a failed headless WebGL initialization.
---

Polytrack's startup completion callback references the local personal-record store, which is constructed after the renderer. The headless preview cannot create WebGL, so renderer construction can abort before the store exists; a later completion callback can then report a misleading temporal-dead-zone error.

**Why:** The `E` initialization error persisted when the callback was merely deferred. A readiness guard removed it while the underlying headless WebGL failure remained, showing that the TDZ was secondary to renderer setup.

Restarting the Vite workflow may leave an already-open preview page's worker running with previously loaded code. Its console errors can continue after the updated assets are being served.

**Why:** In a live preview, frame errors continued after restart while direct asset requests returned the updated worker wrapper; the headless screenshot opened a separate page and could not exercise gameplay because WebGL was unavailable.

The app-preview screenshot browser still cannot create WebGL, but direct headless Chromium with ANGLE SwiftShader flags can. The app's startup-ready flag may become true before car-pattern assets are loaded; wait until the visible “Loading...” indicator clears before starting a track.

**Why:** A SwiftShader browser session successfully exercised Eldritch Estate, while starting before the loading indicator cleared produced “Car patterns are not loaded yet.”

The built-in FPS shortcut may register after `DOMContentLoaded` in production, even when development registers it sooner. A single synthetic `=` event can be silently ignored; retry only until the FPS element appears, with a bound.

**Why:** The published page dispatched its startup key event without creating the counter; two later retries succeeded, while the same one-shot worked in development.

**How to apply:** When auto-triggering PolyTrack's built-in keyboard shortcuts, do not treat `DOMContentLoaded` as proof that the game has registered its handlers. Retry idempotently and verify on the published page.

Returning browsers can still show the prior lowercase FPS overlay while fresh profiles use the built-in counter. No service worker or persisted FPS setting was found; version the manually loaded feature script and make the HTML revalidate.

**Why:** `fps:5` matched the removed custom script exactly, while the current source and fresh production sessions used the built-in `FPS:` counter.

**How to apply:** Bump the query string on the `site-features.js` reference when changing it, and have returning users reload once after publishing.

**How to apply:** Set the startup-ready flag only after the store is constructed, and make the completion callback check it before accessing the store. Treat WebGL context creation failures separately. For gameplay verification, use headless Chromium with `--use-gl=angle --use-angle=swiftshader --enable-webgl --enable-unsafe-swiftshader --ignore-gpu-blocklist --disable-gpu-sandbox`, wait for “Loading...” to clear, and reload the preview before using existing browser logs to judge a worker fix.