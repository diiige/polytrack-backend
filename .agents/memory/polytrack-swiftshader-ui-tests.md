---
name: Polytrack SwiftShader UI tests
description: Choosing a browser path for WebGL-backed game UI verification
---

The regular app-preview screenshot browser may fail to create a WebGL context, while headless Chromium launched with the project's SwiftShader/CDP setup can render the real game UI. For in-game navigation, use the available DOM buttons via CDP rather than screenshot coordinates; visual captures can be scaled relative to the page viewport.

**Why:** The preview capture browser does not use the same SwiftShader launch flags as the integration harness, so its WebGL error does not establish that the game itself is broken. In UI checks, DOM clicks opened the game menu reliably while pixel-based clicks did not.

When checking replay loading, DOM polling may miss the indicator during fast headless playback; the displayed percentage is derived from replay frames loaded versus the recorded frame count, so sample those worker frames as the progress source.

**Why:** SwiftShader/CDP can advance through a replay between UI polls, and the loading indicator may not be exposed in the observed document. Worker-frame sampling observes the underlying progress source reliably.

**How to apply:** Verify interactive game flows with isolated SwiftShader/CDP browser profiles, use DOM clicks when controls are available, and assert the resulting UI state in the browser. For replay loading, sample emitted replay frames and normalize against the saved record length, while separately checking replay states and saved-record preservation. Keep local UI results separate from cross-network TURN/relay claims.

Replay-status browser checks use an in-memory leaderboard API fixture while still exercising the actual app, Watch controls, and WebGL worker.

**Why:** The workspace API's legacy leaderboard import can fail before browser assertions run, so database health should not block UI-state verification.

**How to apply:** Keep upload and replay-lookup routes local to replay-label UI checks; use the real API when the test is specifically about backend persistence or database behavior.

For native button activation through CDP, a `keyDown`/`keyUp` Enter sequence did not synthesize a click in headless Chromium; Space did when sent as `keyDown`/`char`/`keyUp` with text.

**Why:** CDP's key-event sequence can differ from an actual user's native key activation, so a missing click in the test does not by itself show a keyboard-accessibility defect.

**How to apply:** In headless keyboard tests, assert the control receives focus and use the full Space event sequence to verify native button activation. If testing Enter specifically, first confirm the CDP sequence produces a click in that browser.