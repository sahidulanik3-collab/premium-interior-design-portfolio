'use strict';
/* Google Places API (New) provider. Uses official endpoints only; no page scraping.
   Requires GOOGLE_MAPS_API_KEY configured in Settings. Never fabricates results. */
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.types,places.addressComponents,places.location';

async function textSearch({ apiKey, keyword, location, maxResults, pageSize = 20, fetchFn }) {
  const fetchImpl = fetchFn || fetch;
  const leads = [];
  let nextPageToken = null;
  let pages = 0;
  const errors = [];
  // New Places API textSearch: POST https://places.googleapis.com/v1/places:searchText
  // Fallback to legacy if new API disabled: use find-place? We implement New + legacy textsearch JSON.
  const target = Math.min(maxResults, 500);
  while (leads.length < target && pages < 25) {
    const body = { textQuery: `${keyword} in ${location}`, pageSize: Math.min(pageSize, target - leads.length) };
    if (nextPageToken) body.pageToken = nextPageToken;
    let res;
    try {
      res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) { errors.push(`Network error: ${e.message}`); break; }
    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => '');
      throw Object.assign(new Error('Invalid Google API key or API not enabled/billed. Enable Places API (New) and billing.'), { status: 401, code: 'GOOGLE_AUTH', detail: t.slice(0, 300) });
    }
    if (res.status === 429) { errors.push('Google rate limit hit; stopping with collected results'); break; }
    if (!res.ok) { errors.push(`Google API error ${res.status}`); break; }
    const data = await res.json().catch(() => ({}));
    const places = data.places || [];
    if (!places.length) break;
    for (const p of places) {
      leads.push(normalizePlace(p));
      if (leads.length >= target) break;
    }
    nextPageToken = data.nextPageToken || null;
    if (!nextPageToken) break;
    pages += 1;
    // New API tokens need a short delay before reuse
    await new Promise(r => setTimeout(r, 2000));
  }
  return { leads, errors, provider: 'google-places' };
}

function normalizePlace(p) {
  const comp = {};
  for (const c of p.addressComponents || []) {
    const t = (c.types || [])[0];
    if (t && c.longText) comp[t] = c.longText;
  }
  const pid = p.id ? String(p.id).replace(/^places\//, '') : null;
  return {
    businessName: p.displayName?.text || null,
    businessCategory: (p.types || [])[0] || null,
    phone: p.internationalPhoneNumber || null,
    email: null, // Places API does not provide email; left blank, never invented
    website: p.websiteUri || null,
    fullAddress: p.formattedAddress || null,
    city: comp.locality || comp.administrative_area_level_3 || null,
    region: comp.administrative_area_level_1 || null,
    country: comp.country || null,
    postalCode: comp.postal_code || null,
    mapsUrl: pid ? `https://www.google.com/maps/place/?q=place_id:${pid}` : null,
    placeId: pid,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus || null,
    dataSource: 'google-places',
    collectedAt: new Date().toISOString(),
  };
}

function applyFilters(leads, opts = {}) {
  return leads.filter(l => {
    if (opts.minRating != null && (l.rating == null || l.rating < opts.minRating)) return false;
    if (opts.onlyWebsite && !l.website) return false;
    if (opts.onlyPhone && !l.phone) return false;
    if (opts.onlyEmail && !l.email) return false;
    if (opts.category && l.businessCategory !== opts.category && !(l.businessCategory || '').includes(opts.category)) return false;
    return true;
  });
}

function dedupe(leads) {
  const seen = new Set(); const out = []; let dupes = 0;
  for (const l of leads) {
    const key = (l.placeId && `pid:${l.placeId}`) || `n:${(l.businessName || '').toLowerCase()}|${(l.fullAddress || '').toLowerCase()}|${(l.phone || '').toLowerCase()}`;
    if (seen.has(key)) { dupes += 1; continue; }
    seen.add(key); out.push(l);
  }
  return { out, dupes };
}

async function testConnection(apiKey, fetchFn) {
  const fetchImpl = fetchFn || fetch;
  const res = await fetchImpl('https://places.googleapis.com/v1/places/ChIJN1t_tDeuEmsRUsoyG83frY4?fields=id,displayName', {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'id,displayName' },
    signal: AbortSignal.timeout(12000),
  }).catch(e => { throw Object.assign(new Error(`Connection failed: ${e.message}`), { status: 502 }); });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Invalid key or Places API (New) not enabled'), { status: 401 });
  if (res.status === 404) return true; // reachable, key accepted
  if (!res.ok) throw Object.assign(new Error(`Google returned HTTP ${res.status}`), { status: 502 });
  return true;
}

module.exports = { textSearch, normalizePlace, applyFilters, dedupe, testConnection };
