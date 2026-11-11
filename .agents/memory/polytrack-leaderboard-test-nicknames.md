---
name: Polytrack leaderboard test nicknames
description: Keep generated leaderboard names consistent between saved profiles, uploads, and replay UI checks.
---

Synthetic leaderboard tests should generate nicknames within the server's 32-character limit. Longer values can be accepted but normalized, so the leaderboard shows a different name from the one retained in local profile data.

**Why:** A replay test waited for its full local nickname after upload, even though the API had successfully stored the record under a shortened nickname.

**How to apply:** Keep generated test names at or below 32 characters, or compare against the API-normalized value.