'use strict';
/* HTML extraction without hard dependency on cheerio (uses cheerio if installed, else regex fallback).
   Never invents data: missing fields stay null/empty. */
let cheerio = null;
try { cheerio = require('cheerio'); } catch { cheerio = null; }

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{3,6}/g;

function stripTags(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractWithRegex(html, url) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || null;
  const meta = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
    || /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] || null;
  const h = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => stripTags(m[2]).slice(0, 200)).filter(Boolean).slice(0, 50);
  const bodyText = stripTags(html).slice(0, 20000);
  const emails = [...new Set((stripTags(html).match(EMAIL_RE) || []).map(e => e.toLowerCase()))].filter(e => !e.endsWith('.png') && !e.endsWith('.jpg')).slice(0, 20);
  const phones = [...new Set((stripTags(html).match(PHONE_RE) || []).map(p => p.trim()))].filter(p => p.replace(/\D/g, '').length >= 7).slice(0, 20);
  const links = [...new Set([...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map(m => m[1]).filter(v => /^https?:\/\//i.test(v)))].slice(0, 100);
  const socialLinks = links.filter(l => /facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|whatsapp/i.test(l));
  const images = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map(m => ({ src: m[1], alt: /alt=["']([^"']*)["']/i.exec(m[0])?.[1] || '' })).slice(0, 100);
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].slice(0, 10).map(t => stripTags(t[0]).slice(0, 2000));
  const lists = [...html.matchAll(/<(ul|ol)[\s\S]*?<\/\1>/gi)].slice(0, 10).map(l => stripTags(l[0]).slice(0, 2000));
  const jsonLd = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim().slice(0, 5000)).slice(0, 5);
  const og = {};
  for (const m of html.matchAll(/<meta[^>]+property=["']og:([^"']+)["'][^>]*content=["']([^"']*)["']/gi)) og[m[1]] = m[2];
  return { title, metaDescription: meta, headings: h, mainText: bodyText, emails, phones, links, socialLinks, tables, lists, images: images.map(i => i.src), imageAlts: images, jsonLd, openGraph: og };
}

function extract(html, url) {
  if (cheerio) {
    try {
      const $ = cheerio.load(String(html || ''));
      const title = $('title').first().text().trim() || null;
      const metaDescription = $('meta[name="description"]').attr('content') || null;
      const headings = $('h1,h2,h3').map((_, el) => $(el).text().trim().slice(0, 200)).get().filter(Boolean).slice(0, 50);
      const mainText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);
      const text = $.text();
      const emails = [...new Set((text.match(EMAIL_RE) || []).map(e => e.toLowerCase()))].slice(0, 20);
      const phones = [...new Set((text.match(PHONE_RE) || []).map(p => p.trim()))].filter(p => p.replace(/\D/g, '').length >= 7).slice(0, 20);
      const links = [...new Set($('a[href]').map((_, el) => $(el).attr('href')).get().filter(v => /^https?:\/\//i.test(v || '')))].slice(0, 100);
      const socialLinks = links.filter(l => /facebook|instagram|linkedin|twitter|x\.com|youtube|tiktok|whatsapp/i.test(l));
      const images = $('img[src]').map((_, el) => $(el).attr('src')).get().slice(0, 100);
      const imageAlts = $('img').map((_, el) => ({ src: $(el).attr('src') || '', alt: $(el).attr('alt') || '' })).get().slice(0, 100);
      const tables = $('table').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim().slice(0, 2000)).get().slice(0, 10);
      const lists = $('ul,ol').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim().slice(0, 2000)).get().slice(0, 10);
      const jsonLd = $('script[type="application/ld+json"]').map((_, el) => $(el).text().trim().slice(0, 5000)).get().slice(0, 5);
      const openGraph = {};
      $('meta[property^="og:"]').each((_, el) => { openGraph[$(el).attr('property').slice(3)] = $(el).attr('content') || ''; });
      return { title, metaDescription, headings, mainText, emails, phones, links, socialLinks, tables, lists, images, imageAlts, jsonLd, openGraph };
    } catch { return extractWithRegex(html, url); }
  }
  return extractWithRegex(html, url);
}

function discoverLinks(html, baseUrl) {
  const out = new Set();
  for (const m of String(html || '').matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) continue;
      u.hash = '';
      out.add(u.toString());
    } catch {}
  }
  return [...out];
}

function pickFields(full, wanted = []) {
  const o = {};
  for (const f of wanted) {
    if (f in full) o[f] = full[f];
  }
  o.url = full.url; o.status = full.status; o.crawledAt = full.crawledAt;
  return o;
}

module.exports = { extract, discoverLinks, pickFields, EMAIL_RE };
