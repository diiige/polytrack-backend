---
name: Leaderboard persistence
description: Storage decision for PBs on published Autoscale instances.
---

Use persistent database storage for the shared leaderboard. Retain browser-local PBs and retry uploads independently of the server.

**Why:** Autoscale instances can restart or move; a JSON file written inside one instance is not durable shared state. The published build can lag the workspace until the user publishes again.

**How to apply:** Keep new leaderboard writes in persistent storage and avoid reintroducing server-local files as the authoritative store. Treat files only as legacy import sources.