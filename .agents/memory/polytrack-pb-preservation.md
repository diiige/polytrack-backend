---
name: Polytrack PB preservation
description: Why local personal bests must survive startup registry cleanup and upload retries.
---

Preserve locally saved records when startup cleanup considers a track unknown; explicit user-initiated deletion must still work. Upload each current PB only after matching its owning profile, and retain it locally if uploading fails.

**Why:** Official and custom track registries load asynchronously, so an early cleanup pass can mistake a valid map for an unknown one. An upload failure must not cost a player their only copy of a run.

**How to apply:** For future leaderboard or storage changes, distinguish startup cleanup from intentional deletion, and keep local record persistence independent of server availability.

Preserve a record's own replay settings when updating its upload status; never overwrite them with the boost settings of a race currently in progress.

**Why:** Background leaderboard sync can rewrite a saved personal best while another run is active. The current race's multipliers belong to that race, not the older record.

**How to apply:** Treat existing replay metadata as part of the saved PB when updating ancillary fields. Only attach active race settings when writing a newly created recording that has no replay metadata yet.