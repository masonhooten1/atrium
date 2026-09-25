# Atrium

A meetings-first web prototype of the Atrium concept: one persistent street, a continuum of
meeting spaces (pods, huddles, boardroom, stage), and the pod invite gesture — built as a
browser surface with 2.5D rendering. See the build spec (artifact `art_GK3oaS4e`) for scope.

## Stack

- **Next.js 15 (App Router) + TypeScript + Tailwind** — web app, served by a **custom Node server**
  (`server.ts`) so one process hosts the app and the realtime layer (Socket.IO) together.
- **Socket.IO** — presence broadcast, room state, and WebRTC signaling relay (contracts arrive
  in their own slices).
- **Prisma + SQLite** — zero-ops persistence for avatars, rooms, bookings, and whiteboard strokes.
- **Vitest** for unit/smoke tests, **Playwright** for e2e (Chromium launched with fake media
  devices so camera/mic flows are testable headlessly).

## Getting started

```bash
npm install
cp .env.example .env   # DATABASE_URL points at prisma/dev.db
npm run db:migrate     # prisma migrate dev
npm run dev            # custom server on http://localhost:3000
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Boot the custom server (app + Socket.IO) in dev mode |
| `npm run build` / `npm run start` | Production build and serve via the custom server |
| `npm run lint` / `npm run typecheck` | ESLint (flat config) and `tsc --noEmit` |
| `npm test` | Vitest suite |
| `npm run test:e2e` | Playwright suite (builds and boots the production server itself) |
| `npm run db:migrate` / `npm run db:deploy` | Apply migrations in dev / in CI-like flows |
| `npm run db:generate` | Regenerate the Prisma client |

## Hosting the demo

The prototype serves itself in production from one process — no external
services, no keys. For a persistent demo (a VM, a container, or the Obvious
project sandbox):

```bash
npm install            # postinstall runs prisma generate
cp .env.example .env   # DATABASE_URL points at prisma/dev.db
npx prisma db push     # create or refresh the SQLite schema
npm run build
PORT=3000 npm run start
```

`GET /api/health` returning 200 is the readiness check. One port carries the
Next app and the Socket.IO realtime layer together, so only that port needs
exposing — WebRTC media flows peer-to-peer between browsers, never through
the server. The demo should always serve the latest merged `main`.

## Layout

```
server.ts            custom Node server: HTTP + Socket.IO on one listener
src/app/             App Router pages and route handlers (/api/health, /api/bookings, /api/profile)
prisma/              schema + migrations (SQLite)
tests/               Vitest smoke tests
e2e/                 Playwright specs
```
