# LeadForge — standalone lead generation & web scraping SaaS

No n8n / Zapier / Make. Own frontend + backend + DB + job engine + Excel export.

## Quick start (no install required)
```powershell
cd leadforge
copy .env.example .env
# set SESSION_SECRET + ENCRYPTION_MASTER_KEY in .env
node src/server.js
# open http://localhost:3000 → Create first admin account → log in
```
Node 20+ only. Zero required npm dependencies; `cheerio`/`playwright`/`zod` are optional enhancements auto-detected at runtime.

## Features
- Dashboard (real stats, empty states), New Collection, Maps leads, Website scraping, Job details + live SSE progress, preview table (search/sort/paginate/select/export), History, Downloads, API & Integrations (encrypted, masked, tested), Profile/audit, Help.
- Google Places API (New) provider with pagination, field mask, filters, dedupe, short-result warning. No invented data.
- Scraper: SSRF-guarded fetch, redirects revalidated, robots.txt, canonicalization, scope allow/deny, retries, concurrency ≤5, Cheerio if installed else regex engine; Firecrawl optional.
- Jobs: pending→queued→running→completed/partial/failed/cancelled, retry, cancel, per-job Excel.
- Excel: genuine `.xlsx` (ZIP + XML, frozen header, autofilter, widths, types, UTF-8 incl. Bangla, formula-injection guard `'=...`).
- Security: scrypt passwords, HttpOnly SameSite sessions, AES-256-GCM credentials, per-user isolation, rate limiting, security headers, SSRF blocks (localhost/loopback/private/link-local/metadata, userinfo, non-http schemes).

## API keys per feature
| Feature | Key | Where |
|---|---|---|
| Maps leads | Google Maps Platform key, Places API (New) enabled + billing | Settings → Google Maps → Save → Test |
| Built-in scraping | none | works immediately |
| Firecrawl scraping | Firecrawl key | Settings → Firecrawl → Save → Test |
| Apify | Apify token | Settings (adapter ready) |
| AI extraction | OpenAI key + model | Settings (optional only) |

## Testing integrations
- Settings → provider → Test runs a lightweight live call (1 Place lookup / /v1/scrape example.com / users/me / models). Success stamps “last test”; failure shows actionable error, never “connected” falsely.
- Maps without key → job fails fast with setup instructions (no fake leads).

## Docker / Postgres / Redis
```powershell
docker compose up --build
```
`db`/`redis` are for production scale. App runs standalone without them (file DB `data/leadforge.db.json`, in-process queue with BullMQ-compatible statuses). Prisma schema in `prisma/schema.prisma` mirrors the file DB for Postgres migration.

## Troubleshooting
See TROUBLESHOOTING.md. Providers/limits in PROVIDERS.md.

## Run tests
```powershell
npm test
```
node:test suite with mocked providers — no paid calls.
