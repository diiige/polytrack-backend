---
name: PolyTrack FPS layout performance
description: Keep FPS relocation from adding game-frame DOM measurement work.
---

FPS relocation is a screen/control layout event, not game-frame work. Routine HUD text updates and repeated same-value control-attribute writes must not trigger collision scans, and one relocation should read each element's geometry only once. The normal-physics worker path should also skip boost-metadata scans and avoid storing neutral boost settings.

**Why:** The user reported game-wide lag tied to FPS position changes. Removing character-data and inline-style observation was insufficient because replacing HUD text produces child-list mutations, and the game rewrites identical control classes every render frame. Both can cause needless visibility and geometry reads. The simulation worker also handles every output frame, so an unnecessary second pass for neutral runs adds steady CPU work.

**How to apply:** When changing FPS placement, distinguish added/removed controls from text-only updates, ignore attribute mutations whose old and current values match, batch layout measurements before changing the counter's position, and keep the motion compositor-friendly. In the worker, retain frame normalization but run boost annotation only while boosted replay metadata is active. Verify that repeated HUD and no-op attribute updates schedule no relocation work while actual controls still move the counter down and let it return.
