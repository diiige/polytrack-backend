---
name: Polytrack community imports
description: Deriving correct community registry metadata and IDs from imported track codes
---

Polytrack import codes embed the display name and author, while the track payload carries its environment. A community registry ID is the SHA-256 of canonicalized track data after deserialization, not the visible import string or compressed payload. The loader rejects registry entries whose ID, name, or author differs from the decoded track.

**Why:** Hashing the pasted code directly can produce a syntactically valid registry entry that the game refuses to load.

**How to apply:** Decode the import to confirm metadata and environment, then derive the ID through the game's canonical track-data serialization before registering the map. Check this against an existing community map when validating the method.

When an archive import has the same title and author as an existing entry but a newer release group, show only the newer revision. Remove only the older registry row; never delete or migrate PB storage.

**Why:** The older entry duplicates the display name but has a distinct track ID, while saved PBs are keyed to that ID and should remain intact.

**How to apply:** When adding archived community maps, compare title and author against the base registry, retain the newest revision, and regression-test that the older row is hidden, the newest remains, and storage is untouched.

Keep community-map updates additive: do not replace the original PolyTrack bundle or remove or overwrite existing tracks.

**Why:** The user requires the original game content and existing tracks to remain intact while archived maps are added.

**How to apply:** Treat new community maps, release groups, and thumbnails as additions; preserve the original bundle and existing tracks.