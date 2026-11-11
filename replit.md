# Polytrack

A browser-based 3D racing game where players drive on colorful low-poly tracks, build custom tracks in the editor, and compete for best times.

## Run & Operate

- `pnpm --filter @workspace/polytrack run dev` — run the PolyTrack web app (port provided by Replit)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- Start both the PolyTrack web and API Server workflows for gameplay and server-backed leaderboards.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Replit's PostgreSQL connection string; the database schema is managed by `@workspace/db`
- Optional TURN relay env: `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) and `TURN_SHARED_SECRET` (the coturn REST-auth shared secret). Set both to enable relays; credentials are signed per response and expire after one hour by default. `TURN_CREDENTIAL_TTL_SECONDS` can be set from 60 to 86400.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
