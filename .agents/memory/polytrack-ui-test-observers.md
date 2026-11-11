---
name: PolyTrack UI test observers
description: Keep mocked browser observers isolated in site-feature tests.
---

Keep mocked `MutationObserver` support opt-in per test instead of exposing it to every lightweight browser fixture.

**Why:** Enabling it globally starts unrelated map and leaderboard observers, which adds recurring callbacks and changes timer ordering in tests that are not exercising DOM observation.

**How to apply:** Enable a controllable observer only in tests covering mutation-driven UI behavior; keep the default browser mock minimal.
