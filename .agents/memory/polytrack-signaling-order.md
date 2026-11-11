---
name: PolyTrack signaling order
description: Preserve offer-to-session ordering when the browser trickles ICE candidates.
---

A joining client can send ICE candidates immediately after its offer. Since the offer asynchronously reserves a room slot and assigns the session, handling WebSocket messages concurrently can make a candidate arrive before the join connection has session state.

**Why:** An early candidate can then be rejected as an invalid first request, making an otherwise valid invite fail during connection setup.

**How to apply:** Keep messages from each signaling connection in receive order across asynchronous state changes, and test by sending a candidate immediately after the offer.