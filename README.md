# TalentStage — global talent-sharing MVP

A mobile-first web app where anyone can showcase any talent: singing, dance, art,
comedy, cooking, sports, teaching, coding, repairs, gardening, crafts and everyday
practical skills.

Temporary name: **TalentStage**. Everything runs on free / open-source software —
no paid APIs, no domain, no external services.

## What works in v1

- **Feed** — vertical, thumb-friendly video feed with autoplay on scroll-friendly cards, "For you" and "Following" tabs.
- **Categories & search** — 12 talent categories plus title/creator search.
- **Creator profiles** — handle, bio, follower/following counts, video grid, follow button.
- **Upload** — pick a video on your phone, add a title, description and category; uploads are validated (type, size) and stored on disk.
- **Playback** — full-screen player with likes, author link, and HTTP range requests so seeking works.
- **Likes & follows** — toggle endpoints with live counts.
- **Report & block** — report a video or a creator with a reason; block a creator to hide them from your feed.
- **Moderation workflow** — the first account (or `ADMIN_EMAIL`) becomes the moderator: an admin screen lists open reports, with hide video / restore video / suspend creator / dismiss actions.
- **Auth** — email + password signup/login, bcrypt hashes, JWT sessions (30 days), clear sign-in and sign-up screens.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Server | Node 20 + Express 4 | already available in the sandbox, zero cost |
| Storage | JSON snapshot (`db.json`) + files on disk | no database bill for an MVP |
| Auth | `bcryptjs` + `jsonwebtoken` | pure JS, no native build steps |
| Uploads | `multer` disk storage | simple, streams to disk, 80 MB cap |
| Frontend | vanilla JS SPA, no build step | fast on low-end Android phones |

Data lives in `/data` (a persistent disk is mounted there) — `db.json`, `uploads/`,
and a generated `jwt.secret`. Set `DATA_DIR` to override.

## Run locally

```bash
npm install
npm start          # http://localhost:80
npm test           # end-to-end smoke test (real HTTP, throwaway data dir)
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `80` | HTTP port; the server binds `0.0.0.0` |
| `DATA_DIR` | `/data` if present, else `./data` | where `db.json`, `uploads/` and `jwt.secret` live |
| `JWT_SECRET` | generated and stored in `DATA_DIR/jwt.secret` | session signing key |
| `ADMIN_EMAIL` | – | optional: this email gets the moderator role on signup |

No secret is committed to the repo. The signing key is generated on first boot
with `0600` permissions.

## First moderator

The **first account that signs up becomes the moderator** (or whichever account
matches `ADMIN_EMAIL`). Open the app → sign up → the account menu shows
**Moderation**, with the open report queue.

## API surface

```
GET    /api/health
GET    /api/meta
POST   /api/auth/signup            { email, password, name }
POST   /api/auth/login             { email, password }
GET    /api/me
PATCH  /api/me                     { name, bio, avatarColor }

GET    /api/videos?category=&q=&feed=following&sort=liked&page=
GET    /api/videos/:id
POST   /api/videos                 multipart: video, title, category, description
DELETE /api/videos/:id

POST   /api/videos/:id/like
POST   /api/users/:id/follow
POST   /api/users/:id/block
GET    /api/blocks
GET    /api/users/:handle
GET    /api/creators?q=

POST   /api/reports                { videoId | userId, reason, details }

GET    /api/admin/reports?status=open|resolved|dismissed|all
POST   /api/admin/reports/:id/resolve   { action: dismiss|hide_video|restore_video|ban_user, note }
POST   /api/admin/videos/:id/hide
POST   /api/admin/videos/:id/restore
GET    /api/admin/stats

GET    /media/<file>               byte-range streaming of uploaded videos
```

## Verification

`npm test` boots the real server on a random port with a temporary data directory
and runs 44 HTTP assertions covering: static shell + SPA deep links, signup/login
(including wrong password and duplicate email), `/api/me`, upload validation,
a real multipart video upload, playback with correct content-type and byte-range
206 responses, feed/category/search, profiles, like toggles, follow toggles,
reporting and duplicate-report de-duplication, admin-only access, hide/restore
moderation, blocking/unblocking, and deletion removing the file from disk.

## Known limitations (MVP scope)

- Single Node process with an in-memory store flushed to `db.json` — correct for
  one instance, not for horizontal scaling. Swap in Postgres/Supabase later.
- Videos upload to local disk. An 80 MB cap and phone playback depend on the
  device's codec support; H.264 MP4 is the safest format. No transcoding yet.
- No email verification, password reset, or OAuth — the ₹0 budget rules out a
  transactional email provider without adding a paid dependency.
- Moderation is reactive (reports → hide/ban) and trusts the first account as admin.
- Storage is bounded by the persistent disk size; no CDN, so large audiences will
  load video from a single origin.
