# Provider notes & limitations
- **Google Places API (New)** `POST /v1/places:searchText` with `X-Goog-FieldMask`. Needs API key + Places API (New) enabled + billing. Pagination via `nextPageToken` (2s delay). Max ~500/job (env). Returns no emails — column stays blank by design. Ratings/reviews/websites only when Google has them.
- **Built-in scraper** honors robots.txt, same-origin scope, 3MB/page, 5 redirects, 15s timeout, ≤5 concurrency. Static HTML fully; heavy JS sites may yield thin results → use Firecrawl/Playwright.
- **Firecrawl** optional `POST /v1/scrape`. Select provider per job only when configured; no silent paid fallback.
- **Apify** token validated via `GET /v2/users/me`; actor wiring via documented adapter in `src/providers/optional.js`.
- **OpenAI** validates via `GET /v1/models`; used only for custom-field AI assist when explicitly enabled. Never required.
- Costs: app surfaces quota/budget notes and large-job confirmations; exact charges come from provider consoles — never invented.
