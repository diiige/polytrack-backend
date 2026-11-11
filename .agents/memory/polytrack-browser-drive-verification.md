---
name: Polytrack browser drive verification
description: Interpreting player motion from SwiftShader browser tests on community tracks
---

In WebGL drive checks, a negative scalar vehicle speed can still represent real motion under throttle on a community map. Confirm movement with both the absolute speed and a measurable position change rather than requiring positive speed.

**Why:** Rolling Hills Racer moved several world units during throttle input while reporting negative speed; treating that value as stationary caused a false test failure.

**How to apply:** For browser tests that validate throttle, accept either speed sign and require a non-trivial position delta. Always release the throttle key in a `finally` block.