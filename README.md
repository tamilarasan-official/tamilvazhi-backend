# tamilvazhi-api

Backend for the course portal. **Express + TypeScript + MongoDB (Mongoose) + S3-compatible object storage.**

Pairs with [`tamilvazhi-web`](../frontend) — deploy each as its own Dokploy application.

---

## What it does

- Instructor authentication (email + password, signed cookie)
- Course / module / content CRUD
- **Direct-to-storage uploads** — presigned multipart URLs, so file bytes never pass through this process
- Student access codes (no accounts, no passwords)
- Signed playback and download URLs against a **private** bucket

### Why file bytes bypass the API

```
Instructor's browser ──── multipart PUT ────► Object storage (private bucket)
        │                                              ▲
        └─── metadata only ──► this API ─── signs ─────┘
                                   │
Student's browser ◄─ signed URL ───┘   then streams direct from storage
```

| | Proxying through the API | Direct to storage (what this does) |
|---|---|---|
| 3 GB lecture upload | pins container RAM, hits timeouts | streams in 10 MB parts, no server load |
| 40 students watching | 40 streams through one container | zero server bandwidth |
| Seeking in a video | every seek round-trips the API | range requests go straight to storage |

---

## Why Mongoose and not Prisma

**Prisma's MongoDB connector requires a replica set.** A single-node MongoDB — which is what Dokploy's one-click MongoDB service gives you — is not one, and Prisma fails on the first write with a transaction error. You'd have to manually convert the container to a single-node replica set and keep it that way across redeploys.

Mongoose works against standalone MongoDB with no such requirement. For the same reason, the reorder endpoint uses `bulkWrite` instead of a transaction — position updates are independent and idempotent, so a partial apply is harmless.

## Data model

Metadata only — video and document bytes live in object storage.

| Collection | Notes |
|---|---|
| `admin_users` | Usually one document: the instructor |
| `courses` | Modules are **embedded** — a handful per course, always read together |
| `content_items` | **Separate collection** — hundreds per course, edited individually |
| `download_events` | TTL index, auto-expires after 180 days |
| `access_attempts` | Rate-limit ledger, TTL index, auto-expires after 24 hours |

Modules are embedded and items are not, deliberately: embedding hundreds of items would rewrite the entire course document on every single edit and eventually approach MongoDB's 16 MB document ceiling.

### Sizing

A content item document is ~400 bytes. So:

| Catalogue | Database size |
|---|---|
| 50 videos + 100 documents | **< 1 MB** |
| 300 videos + 500 documents | **~5 MB** |
| 2,000 items + 100k download events | **~50 MB** |

**Provision 1 GB for MongoDB and you will never think about it again.** The real space is object storage — for 50–300 videos budget **250 GB**.

**Use Cloudflare R2.** Video portals are egress-heavy: 100 students watching 20 GB each is 2 TB/month. R2 charges **nothing** for egress; AWS S3 would bill ~$180/month for the same traffic. That one line decides the provider.

---

## Local development

```bash
cp .env.example .env          # then set AUTH_SECRET
docker compose up -d          # MongoDB on :27018, MinIO on :9000 (console :9001)
npm install
npm run setup                 # seeds the admin user + creates the bucket
npm run dev                   # http://localhost:4000
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

---

## API reference

Cookie-authenticated. `admin` = instructor session required; `code` = student access cookie required.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Health check (point Dokploy at this) |
| POST | `/api/auth/login` | — | Instructor sign in |
| POST | `/api/auth/logout` | — | Sign out |
| GET | `/api/auth/me` | — | Current session, 401 when signed out |
| POST | `/api/auth/password` | admin | Change own password |
| POST | `/api/access` | — | Redeem a course access code |
| GET | `/api/access/courses` | — | Courses this visitor unlocked |
| POST | `/api/access/reset` | — | Forget unlocked courses on this device |
| GET | `/api/courses/slug/:slug` | code | Full course tree for the student viewer |
| GET | `/api/courses` | admin | Dashboard list + storage totals |
| GET | `/api/courses/:id` | admin | Course detail for the editor |
| POST | `/api/courses` | admin | Create a course |
| PATCH | `/api/courses/:id` | admin | Update / publish / rotate access code |
| DELETE | `/api/courses/:id` | admin | Delete course **and its files** |
| POST | `/api/modules` | admin | Add a module |
| PATCH | `/api/modules/:id` | admin | Rename / reposition |
| DELETE | `/api/modules/:id` | admin | Delete module **and its files** |
| PATCH | `/api/items/:id` | admin | Rename, toggle downloadable, move |
| DELETE | `/api/items/:id` | admin | Delete item **and its file** |
| POST | `/api/items/reorder` | admin | Persist a drag-and-drop reorder |
| POST | `/api/uploads/init` | admin | Open a multipart upload, get part URLs |
| POST | `/api/uploads/parts` | admin | Sign the next batch of parts |
| POST | `/api/uploads/complete` | admin | Seal the upload, create the item |
| POST | `/api/uploads/abort` | admin | Cancel and release partial data |
| GET | `/api/files/:id/url` | code | Signed playback URL |
| GET | `/api/files/:id/download` | code | 307 redirect to a signed download URL |

---

## Deploying to Dokploy

### 1. MongoDB service

**Create → Database → MongoDB.** Name it `tamilvazhi-mongo`, set a strong password, note the internal hostname. 1 GB storage is plenty. **Do not expose it publicly** — the API reaches it over Dokploy's internal network.

### 2. Object storage

Cloudflare R2 → create a **private** bucket → create an API token with *Object Read & Write* → **Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://portal.yoursite.com"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3600
  }
]
```

> **`ExposeHeaders` must include `ETag`, and `AllowedOrigins` is the FRONTEND's domain, not this API's.** The browser uploads directly to the bucket, so the bucket sees the frontend as the origin. Without `ETag` exposed, uploads reach 100% and then fail at the final step — this is the single most common misconfiguration.

### 3. This application

**Create → Application → Dockerfile**, pointed at the backend repo.

Environment tab:

```
NODE_ENV=production
PORT=4000
MONGODB_URI=mongodb://tamilvazhi:PASSWORD@tamilvazhi-mongo:27017/tamilvazhi?authSource=admin
AUTH_SECRET=<48+ random bytes>
ADMIN_EMAIL=instructor@yoursite.com
ADMIN_PASSWORD=<a strong password>
ADMIN_NAME=Instructor Name

CORS_ORIGINS=https://portal.yoursite.com
FRONTEND_URL=https://portal.yoursite.com

COOKIE_DOMAIN=.yoursite.com
COOKIE_SAMESITE=lax
COOKIE_SECURE=true

S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=tamilvazhi
S3_ACCESS_KEY_ID=<r2 key id>
S3_SECRET_ACCESS_KEY=<r2 secret>
S3_FORCE_PATH_STYLE=false
SIGNED_URL_TTL=21600
```

> **`COOKIE_DOMAIN` needs the leading dot.** `.yoursite.com` lets a cookie set by `api.yoursite.com` be sent by `portal.yoursite.com`. Without it the instructor appears signed out the instant they navigate.

**Domains:** `api.yoursite.com`, port `4000`, HTTPS enabled.
**Health check:** path `/health`, port `4000`.

The admin account is seeded on every boot, so `ADMIN_PASSWORD` in this environment **is** the live password — change it there and redeploy.

---

## Operational notes

**Upload limits.** Files up to 20 GB in 10 MB parts, 3 in flight, 3 retries per part with a freshly signed URL. A dropped connection recovers instead of restarting. Cancelling aborts the multipart upload so partial data doesn't accrue cost.

**Access codes are share tokens, not passwords.** Stored in plain text because the instructor must read one back to share it. Rate-limited to 10 failures per 10 minutes per visitor, and rotating a code locks out everyone holding the old one.

**Unpublishing revokes access.** The published flag is checked on every request, not just at code redemption.

**Streaming-only files.** Un-tick *Downloadable* and the download endpoint returns 403 while playback still works. This is a deterrent, not DRM — a determined student can still capture a stream. If that matters commercially, the next step is encrypted HLS with signed segment URLs.

**Privacy.** No raw client IPs are stored. Rate limiting and download counts use a salted hash of IP + user-agent, truncated to 32 characters.

**Rate limiting is database-backed** rather than in-memory, so it still holds if Dokploy runs more than one replica and survives redeploys.

---

## Verified behaviour

47 end-to-end checks against real MongoDB and S3-compatible storage, all passing:

- multipart upload reassembles **byte-identical** to source
- storage honours **HTTP range requests** (video seeking)
- downloads carry `Content-Disposition: attachment` with the original filename
- no code → 403; invalid code → 404; codes are case-insensitive
- unpublishing revokes an already-redeemed code; instructor can still preview
- rotating a code invalidates the old one immediately
- the streaming-only flag blocks downloads while leaving playback working
- course/module/item deletion removes the corresponding objects from storage
- malformed ObjectIds return 404, blocked origins 403, oversized bodies 413
