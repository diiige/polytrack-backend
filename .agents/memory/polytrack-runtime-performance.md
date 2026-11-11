---
name: PolyTrack runtime performance
description: Preserve bounded high-DPI rendering and efficient per-car simulation callbacks.
---

Keep the renderer's device-pixel ratio capped at 1.5 while preserving the game's render-scale setting and Screen Pixel Density opt-out. For simulation-worker update messages, identify the current car's binary state before decoding it; avoid deserializing every car state separately in each car's callback.

**Why:** High device-pixel ratios increase fragment workload and render-target memory, while each registered car callback receives the same combined state message. Reducing both costs helps on high-DPI screens and during multi-car Watch/multiplayer without changing physics.

**How to apply:** Retain the cap and existing quality controls unless the user chooses another tradeoff. When modifying the worker-state patch, preserve frame normalization and test a real game/replay flow; don't claim a guaranteed FPS because GPU and CPU bottlenecks vary by device.
