---
name: Polytrack leaderboard pagination tests
description: Isolate leaderboard paging checks from real gameplay recording prerequisites.
---

Use a focused browser test with seeded leaderboard API records to verify totals and later-page results. Keep real-driving and replay-integrity prerequisites in their own integration tests. Do not restore the removed public boost filter.

**Why:** A gameplay integration can stop on simulation or replay-metadata setup before reaching leaderboard assertions, obscuring unrelated pagination failures.

**How to apply:** For totals and page navigation, seed controlled records through the browser test API; use actual gameplay when the assertion concerns driving, saved replays, or entering the native Watch view.
