---
name: PolyTrack cross-instance signaling checks
description: Diagnose real-browser failures in the separate API-instance signaling path.
---

A connected join WebSocket does not prove its offer reached the signaling queue. Check the sanitized offer outcome and rejection reason before diagnosing a missing database delivery.

**Why:** A browser can keep retrying offers after a protocol validation failure, making the failure look like a queue or cross-instance transport issue.

**How to apply:** In cross-instance multiplayer tests, verify that the join offer was accepted, then confirm enqueue and host delivery using safe log fields only. Never include invite codes or player-identifying values in diagnostics.