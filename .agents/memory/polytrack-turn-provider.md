---
name: Polytrack TURN provider
description: Selected relay provider and Cloudflare credential distinctions.
---

The user requires a TURN option that does not ask them for a credit card and selected Metered Open Relay's public static-auth mode.

**Why:** The user rejected account-based provider setup that asks for billing details and wants a no-card route.

**How to apply:** Use the documented public static-auth host and generate temporary browser credentials on Polytrack's backend. Do not request Metered account details for this path. This selection does not establish that a reported join failure was caused by NAT traversal; actual failed-join evidence is still needed to confirm that diagnosis.

Open Relay's static-auth option publishes a shared authentication secret. It needs no account API key, but it is not a dedicated relay allocation and may be subject to shared capacity, abuse, or availability changes.

**Why:** The user needs a no-card setup; the published static credential avoids asking them to register or provide billing details.

**How to apply:** State the shared-service reliability trade-off, do not describe the published credential as a private secret, and verify a real peer relay separately from ICE-config generation. Reference: https://www.metered.ca/tools/openrelay/

On 2026-10-02, the Replit workspace resolved Open Relay's public hostname, but outbound TCP connections to ports 80 and 443 timed out. A relay-only Chromium check restricted to TCP/TLS TURN URLs reported ICE error 701 and gathered no relay candidates. The normal relay-only browser check and a separate Replit app-preview capture also reported ICE error 701 for both peers, with no relay candidates, selected pair, or open data channel.

**Why:** The workspace runner and app-preview browser did not provide a network route to the TURN provider; their failures do not establish that players' networks cannot reach it.

**How to apply:** Use the documented public static-auth host and generate temporary browser credentials on Polytrack's backend; do not request Metered account details or describe the shared credential as private. Do not infer NAT traversal failure from invite signaling alone. Report invite/signaling success separately from relay reachability, and confirm a selected relay pair plus an open data channel from a browser network that can reach the provider. Do not count app-preview screenshots as external TURN validation unless they show both selected relay candidates and an open data channel. Keep relay diagnostics free of credentials and player identifiers.
