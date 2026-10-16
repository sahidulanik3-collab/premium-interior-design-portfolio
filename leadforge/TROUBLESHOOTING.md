# Troubleshooting
- `Google key invalid / API not enabled` → enable **Places API (New)**, attach billing, wait 5 min, Settings → Test.
- `No results found` → broaden keyword/location, lower minRating, uncheck filters.
- `Only N results available` → provider limit reached; partial status + Excel still generated.
- `Scrape: no pages extracted` → target may block bots/need JS → reduce pages, check URL publicly reachable, or configure Firecrawl.
- `Blocked private IP / hostname` → SSRF guard working; only public http(s) allowed (no localhost/metadata).
- `Export file missing` → `data/exports` volume not persisted; re-run job.
- `Stored key unreadable` → ENCRYPTION_MASTER_KEY changed; re-save keys.
- Port in use → set PORT in .env.
