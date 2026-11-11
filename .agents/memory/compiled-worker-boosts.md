---
name: Compiled worker boosts
description: How to make physics changes in the migrated Polytrack worker take effect.
---

For physics cheats in the migrated Polytrack build, changing the control message alone is insufficient because the compiled worker only consumes boolean controls. Patch the worker's update loop before evaluation and carry an explicit boost field into its realtime controls. The compiled worker also installs its message handler once at boot and again asynchronously after its physics engine loads; a wrapper must preserve routing across both assignments.

The packed car state counts native physics updates as frames, including extra boost updates; the browser uses those returned frames for the visible timer and records. When boost adds physics calls, serialize the player's logical worker frame and logical finish frame instead of the accelerated native counts. Keep the frame, finish-frame, and speed fields distinct.

When patching return logic in the minified worker, replace the full return expression and closing brace. Replacing only through the `return` keyword can append the original expression to the new return and make the worker fail to parse; compile the transformed real bundle in a test.

The compiled worker exposes model creation and update calls, but no JavaScript setter for the vehicle's physical top-speed cap. Scaling the packed speed value changes the reported speed only; label it clearly unless native physics support is added.

**Why:** The first implementation only altered throttle timing and produced no noticeable acceleration change during play. A wrapper that only intercepts the initial message handler can be silently replaced when the compiled physics engine finishes loading, and uncorrected extra physics calls make the race timer count faster. A partial return replacement caused a syntax error that prevented the game from starting. The current worker interface also does not expose the vehicle's physical speed cap.

**How to apply:** Keep the original compiled worker as the source asset, use the site worker wrapper to patch its known targets, and fail loudly if a target changes. Compile-test the fully patched bundle, test messages sent before initialization and after readiness, verify race and finish frames stay logical, keep other simulated cars unboosted, and distinguish displayed speed from actual physics limits. The real-time loop batches several frame/control pairs before producing buffers, so carry each pair's own frame number through the update rather than using the car's final batch count; keep normalization active after extra physics updates stop.

Also enforce frame monotonicity at the outgoing packed-state boundary for every car state, including states from the isolated ghost worker. Use separate cursors for the parent and ghost output streams; only frame metadata should change on ghosts.

**Why:** The client rejects duplicate or backward frames when recording a run. Per-update logical correction and normalizing only tracked player cars did not cover every state-output path; decoding only the first matching car state in a worker batch also drops intervening frames.

**How to apply:** Track emitted frames for all parent-worker states and separately for ghost-worker states. At the game receiver, decode every buffer matching the requested car ID before recorder delivery. Preserve native frames when they advance normally, increment only when an output would repeat or move backward (or when a boosted player's logical frame must advance), and keep ordinary ghosts unmodified. Keep a final per-car monotonic check at the game receiver before decoded states reach the recorder, so a missed worker route cannot crash recording.

Boosted recordings need the physics multipliers used during the run, not the player's current settings. Replay each marked boosted ghost in its own physics world; extra update calls for one car can advance every car sharing that world. Old recordings without saved multipliers cannot be reconstructed reliably from their controls alone, so do not silently boost them. If saved values are wrong, repair only the selected local record after the player explicitly supplies the intended settings; allow clearing its metadata to restore normal physics. Never change other records or apply a global replay fallback.

**Why:** Replaying only the recorded controls through the unmodified ghost worker produces a different trajectory after boosted acceleration or braking. Applying one current setting to all ghosts would corrupt ordinary recordings and could also mismatch runs made with other settings.

**How to apply:** Persist replay settings with each new boosted personal best, pass them through the recording-to-worker path, and use boosted physics only for that specific replay. Preserve already-saved metadata when the same recording is rewritten during sync; do not attach pending settings to an unrelated same-time personal best. Preserve the original unmodified path for recordings without metadata. Repair actions may replace or clear boost metadata for one opened local PB, but must not run automatically or inherit current settings during ordinary saves.

Do not show replay boost labels or a replay boost filter on the public leaderboard. Show boost status only inside the cheat menu during active Watch. Missing or legacy metadata remains UNKNOWN.

**Why:** The user repeatedly asked to delete the public filter because everyone could see it. Subsequent task merges restored the unwanted UI; the user's current requirement overrides earlier public-label work.

**How to apply:** Preserve replay metadata for playback, but do not restore public badges, dropdowns, or API leaderboard classifications. Tie private visibility to the native replay-view lifecycle, not a particular Watch button or worker lifetime: post-race Watch and worker replacement must keep the status visible until the viewer exits.

Do not end the active Watch session when a simulation worker with no tracked replay cars terminates. Only a worker that actually carried watched replay cars may affect replay-status lifecycle on termination.

**Why:** The game can terminate unrelated simulation workers while Watch is starting. Treating any worker termination plus an empty replay map as an exit disabled later replay messages intermittently.

**How to apply:** In worker termination handling, check whether that worker was tracked before changing Watch status. Keep explicit Play, track-change, and Exit actions as session-ending transitions, with a regression test for unrelated worker termination.

Leaderboard metadata backfill for an existing PB should only update an equal-time entry when its recorded controls are identical and it is still unmarked. A time alone does not prove that two recordings used the same physics settings.

**Why:** Old leaderboard entries can be missing boost settings even when a local PB has them, but equal finish frames can also belong to a different run. Attaching multipliers to the wrong controls makes the replay less accurate rather than fixing it.

**How to apply:** Preserve metadata alongside each recording, allow a same-recording backfill, and keep legacy unmarked recordings on normal physics when matching metadata is unavailable.

Headless Chromium with SwiftShader can create a real WebGL context, but its simulation output may advance far more logical frames per wall-clock second than a visible browser. Timed keyboard macros therefore cannot be assumed to represent a fixed number of race frames.

**Why:** A fixed-duration drive sequence on a WebGL-enabled headless run emitted thousands of simulation frames without reaching its first checkpoint; wall-clock delays alone did not make the route reproducible.

**How to apply:** Track logical worker frames while driving, calibrate any browser-specific route, and keep finish/checkpoint assertions tied to actual emitted state. Do not fabricate a finish when a route fails.

Synthetic keyboard input used to unlock cheats must release every key before driving. Cheat phrases can contain real controls such as throttle or steering, and an unreleased key changes the supposedly straight test route.

**Why:** The unlock phrase includes control keys; leaving its key-down events active made the car steer into a barrier even though the test sent no steering input.

**How to apply:** Send the unlock key-down sequence, then matching key-up events before the first simulation frame used for the run.

When a WebGL test substitutes fixture data for a registered community track, the registry still queries the original track ID while the fixture has a different content hash. Never upload that fixture run under the real community ID.

**Why:** Using the registered ID makes the fake geometry appear as a real track result and can overwrite a user's leaderboard record.

**How to apply:** Give each test run a unique fixture ID and rewrite only that browser profile's leaderboard queries to the same ID used for upload; leave production and application track metadata unchanged.

Compare checkpoint positions at the first worker state after checkpoint progress changes, not at the last checkpoint-marked state. Later samples reflect how far the car has driven since crossing.

**Why:** Two matching runs can have different last checkpoint-marked positions simply because their state arrays were sampled at different later moments.

**How to apply:** Compare the first checkpoint state and its frame, plus the independently reported finish frame.
