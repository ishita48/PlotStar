# Database: Postgres on Neon (since 2026-11-15)

The web app's Prisma database moved from a local SQLite file to **Postgres on Neon**, added to the Vercel project
through the Marketplace. The live site saves and loads projects, deployed facilities and their HAVEN state there,
so nothing depends on anyone's laptop being on.

## What changed
- `prisma/schema.prisma`: provider `postgresql`; `DATABASE_URL` (pooled, used by the app) and
  `DATABASE_URL_UNPOOLED` (direct, used by migrations).
- `prisma/migrations/`: the first migration creates every table (Project, Sensor, Incident, Message, Simulation,
  AmenityCache, ProtectionWorkspace). Schema changes now go through `prisma migrate dev`, not `db push`.
- `ProtectionWorkspace` is a normal Prisma model; the hand-written SQLite SQL is gone.
- Vercel builds run `prisma generate && prisma migrate deploy && next build` (`vercel.json`).

## Running locally
1. In Vercel: geostar > Storage > Neon > `.env.local` tab > Show secret. Copy `DATABASE_URL` and
   `DATABASE_URL_UNPOOLED` into your `.env`. (`vercel env pull` cannot copy them: they are stored as sensitive.)
   Better for experiments: create your own Neon branch and use its two URLs, so you never touch live data.
2. `npm run setup` (generate the client, apply migrations, seed), then `npm run dev`.

## Tests
- `npm test`, `npx tsc --noEmit` and `npx next build` need no database.
- The Playwright suite applies migrations to `TEST_DATABASE_URL` (falls back to `DATABASE_URL`). Point it at a
  throwaway Neon branch, never the production one.
