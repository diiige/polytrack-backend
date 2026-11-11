---
name: PolyTrack map-scoped PB deletion
description: Keep the delete target synchronized with the selected leaderboard panel.
---

The map detail page creates its leaderboard control before its asynchronous leaderboard request runs. Capture the track ID from that page's leaderboard request, clear the prior ID when a new delete control is installed, and keep deletion disabled until the current request supplies an ID.

**Why:** A rapid click can otherwise run before the selected map is known, or reuse the previous map's ID when switching maps.

**How to apply:** Gate the map-page delete control on the current request ID and test both the initial loading race and switching between two maps.

PB deletion verification must check both local storage and the server's own-user entry after a native leaderboard refresh, not just the cleared PB text.

**Why:** The original game retains open-time PB values in its map panel, and DOM-only mocks do not exercise that callback. A blank PB label can coexist with an own-user leaderboard row, so it is not sufficient evidence of complete deletion.

**How to apply:** Use a stable disposable native profile, verify its identity before seeding data, assert the server entry is absent, and then exercise native refresh and map reopening. Scope selectors to the visible track-info panel: hidden track-picker PB elements can remain in the DOM.

The native game's current profile is authoritative for destructive operations once the game has initialized; leftover storage namespaces are not evidence of which profile is active.

**Why:** Multiple release namespaces can coexist, and the live profile can differ from whichever namespace storage enumeration finds first. A successful server deletion for the wrong token does not delete the player's visible PB.

**How to apply:** Use the live game identity and preserve profile-change guards across asynchronous waits. Coordinate deletion with the native record manager's uploads/downloads and cancel older map response callbacks, not only the separate site migration queue.