---
name: PolyTrack worker track-part parity
description: Keep community map part registrations consistent between the main game and simulation worker.
---

When adding track-part IDs beyond the upstream game bundle, update both the main track registry and the compiled physics worker's enum and collision-geometry registry.

**Why:** The main parser can accept and render an imported map while the worker still rejects its serialized track data, leaving the car unable to move.

**How to apply:** Mirror each new ID and its collision descriptor in both bundle paths. Test a community map that uses the new part and validate the transformed worker source.

Ordinary replay workers must also use the patched wrapper, not the raw compiled bundle. The wrapper adds project-specific track-part IDs, while absent replay boost metadata keeps physics neutral.

**Why:** An unmarked replay on a newer community map can fail to load even when the main game renders and drives the track. Marking it for repair may hide the routing gap by sending it through the patched worker.

**How to apply:** Route unmarked replays through the wrapper without adding boost settings. Test that the patched registry is used and that these replays remain on normal physics.