'use strict';
/* Optional-provider adapters: Firecrawl, Apify, OpenAI. All use lightweight validation,
   never claim connected without success, and basic scraping works without them. */
async function testFirecrawl(apiKey, fetchFn = fetch) {
  const res = await fetchFn('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
    signal: AbortSignal.timeout(15000),
  }).catch(e => { throw Object.assign(new Error(`Firecrawl unreachable: ${e.message}`), { status: 502 }); });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Invalid Firecrawl API key'), { status: 401 });
  if (!res.ok && res.status !== 402) { const t = await res.text().catch(() => ''); throw Object.assign(new Error(`Firecrawl error ${res.status}: ${t.slice(0, 200)}`), { status: 502 }); }
  return true;
}
async function scrapeViaFirecrawl(apiKey, url, fetchFn = fetch) {
  const res = await fetchFn('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, formats: ['markdown', 'html'] }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape failed: HTTP ${res.status}`);
  const data = await res.json();
  return { html: data?.data?.html || '', text: data?.data?.markdown || '', raw: data };
}
async function testApify(token, fetchFn = fetch) {
  const res = await fetchFn('https://api.apify.com/v2/users/me', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  }).catch(e => { throw Object.assign(new Error(`Apify unreachable: ${e.message}`), { status: 502 }); });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Invalid Apify token'), { status: 401 });
  if (!res.ok) throw Object.assign(new Error(`Apify error ${res.status}`), { status: 502 });
  return true;
}
async function testOpenAI(apiKey, model = 'gpt-4o-mini', fetchFn = fetch) {
  const res = await fetchFn('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
  }).catch(e => { throw Object.assign(new Error(`OpenAI unreachable: ${e.message}`), { status: 502 }); });
  if (res.status === 401) throw Object.assign(new Error('Invalid OpenAI API key'), { status: 401 });
  if (!res.ok) throw Object.assign(new Error(`OpenAI error ${res.status}`), { status: 502 });
  return true;
}
async function aiExtractFields(apiKey, model, html, instructions, fetchFn = fetch) {
  const res = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages: [{ role: 'user', content: `Extract JSON per instructions: ${instructions}\n\nHTML (truncated):\n${String(html).slice(0, 8000)}` }], response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`OpenAI extraction failed: HTTP ${res.status}`);
  const data = await res.json();
  try { return JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { return {}; }
}
module.exports = { testFirecrawl, scrapeViaFirecrawl, testApify, testOpenAI, aiExtractFields };
