---
name: PolyTrack published asset checks
description: Diagnose UI changes that appear absent from the live PolyTrack app.
---

Before adjusting a UI value repeatedly, compare the deployed HTML and referenced script with the workspace build. A stale deployment can make a correct workspace change appear ineffective.

**Why:** A live screenshot can still show the previous UI simply because the latest workspace build was never published.

**How to apply:** Check deployment status and the live versioned script URL first. If production serves an older build, ask for or suggest publishing before further CSS adjustments.

The development preview also snapshots patched browser scripts when its Vite server starts; it can keep serving old contents after the source file changes.

**Why:** The custom middleware builds its response map once at startup rather than re-reading the source for each request.

**How to apply:** After editing a script served by that middleware, restart the PolyTrack web workflow and verify the actual preview response before asking the user to reload.
