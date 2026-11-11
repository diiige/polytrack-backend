---
name: PolyTrack Cloudflare deployment
description: The published Cloudflare Pages site is separate from the Replit workspace deployment.
---

PolyTrack's public Cloudflare Pages URL is `https://polytrack-6bd.pages.dev`. Replit workspace edits and Replit publishing do not automatically update that Pages deployment.

**Why:** The user asked for the published Cloudflare site to be verified, and its served JavaScript differed from the current workspace build.

**How to apply:** When changing or checking production PolyTrack behavior, distinguish the Replit preview from Cloudflare Pages. Verify the Cloudflare-served HTML and asset versions after its own deployment; do not claim a workspace fix is live there before checking.
