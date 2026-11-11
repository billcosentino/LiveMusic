// Event extraction strategies. Each returns an array of raw events:
// { title, start, allDay, end, url, description, image, performers, price, locName, locCity, locRegion, via }
import { normalizeDate, toEastern, cleanText, decodeEntities, todayEastern, addDays } from './util.js';

// ---------- JSON-LD (schema.org Event) ----------
const LD_RE = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

function parseLooseJSON(s) {
  s = s.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/^\s*\/\/.*$/gm, '');
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')); } catch {}
  return null;
}
function isEventType(t) {
  const types = [].concat(t || []).map(String);
  return types.some((x) => /(Event|Festival)$/i.test(x) && !/^(EventSeries|EventReservation|EventAttendanceMode.*|EventStatus.*)$/i.test(x));
}
function first(v) { return Array.isArray(v) ? v[0] : v; }
function textOf(v) { v = first(v); return typeof v === 'object' && v ? v.name || v['@value'] || '' : v || ''; }

export function eventsFromJsonLd(html) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (isEventType(node['@type']) && node.startDate && !seen.has(node)) {
      seen.add(node);
      const d = normalizeDate(first(node.startDate));
      if (d) {
        const loc = first(node.location) || {};
        const addr = typeof loc.address === 'object' ? first(loc.address) : {};
        const offers = first(node.offers) || {};
        const perf = [].concat(node.performer || []).map(textOf).filter(Boolean);
        out.push({
          title: cleanText(textOf(node.name), 200),
          start: d.start, allDay: d.allDay,
          end: normalizeDate(first(node.endDate))?.start || null,
          url: typeof node.url === 'string' ? node.url : textOf(node.url) || null,
          description: cleanText(node.description, 400),
          image: typeof first(node.image) === 'string' ? first(node.image) : first(node.image)?.url || null,
          performers: perf,
          price: offers.price != null ? String(offers.price) : offers.lowPrice != null ? String(offers.lowPrice) : null,
          locName: cleanText(loc.name || '', 120),
          locCity: cleanText(addr?.addressLocality || '', 60),
          locRegion: cleanText(addr?.addressRegion || '', 30),
          types: [].concat(node['@type']),
          via: 'json-ld',
        });
      }
    }
    for (const k of Object.keys(node)) if (k !== '@context') walk(node[k], depth + 1);
  };
  for (const m of html.matchAll(LD_RE)) walk(parseLooseJSON(m[1]));
  return out;
}

// ---------- Links on a page ----------
const EVENT_WORDS = /(event|calendar|shows?\b|concert|music|live|gigs?\b|entertainment|lineup|schedule|whats-?on|what-s-on|happenings|performances?|tickets|upcoming|bands?\b)/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|mp3|mp4|zip|docx?)(\?|$)/i;

export function scanLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const host = base.hostname.replace(/^www\./, '');
  const pages = new Map();
  const details = new Set();
  const ics = new Set();
  const gcal = new Set();
  const tickets = new Set();

  // Match opening <a> tags only; the link text is whatever follows, up to </a> (some anchors wrap whole cards).
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,300})/gi)) {
    m[2] = m[2].split(/<\/a>/i)[0];
    const raw = decodeEntities(m[1]).trim();
    if (/^(mailto|tel|javascript):/i.test(raw)) continue;
    if (/^webcal:/i.test(raw)) { ics.add(raw.replace(/^webcal:/i, 'https:')); continue; }
    let u;
    try { u = new URL(raw, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname)) continue;
    if (/\.ics$/i.test(u.pathname) || /[?&](ical|outlook-ical)=1/i.test(u.search)) { ics.add(u.href); continue; }
    if (/calendar\.google\.com/i.test(u.hostname)) { addGcal(u, gcal); continue; }
    if (TICKET_HOSTS.test(u.hostname) && u.pathname.length > 3) { u.hash = ''; tickets.add(u.href); continue; }
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    u.hash = '';
    const text = cleanText(m[2], 80);
    const p = u.pathname.toLowerCase();
    const segs = p.split('/').filter(Boolean);
    // Detail pages: /event/slug, /events/slug, /shows/2026-11-14-band, etc.
    if (segs.length >= 2 && /^(events?|shows?|concerts?|calendar|gigs?|performances?|music|whats-on|tickets)$/.test(segs[0]) && !/^(page|category|tag|list|month|week|day|today|photo|feed)$/.test(segs[1])) {
      details.add(u.href);
      continue; // a single event, not a list page
    }
    if (dateFromUrl(u.href)) { details.add(u.href); continue; }
    let score = 0;
    if (EVENT_WORDS.test(p)) score += 2;
    if (EVENT_WORDS.test(text)) score += 2;
    if (segs.length <= 2) score += 1;
    if (/^(events?|calendar|shows?|live-music|music|concerts|entertainment|upcoming-events|whats-on)$/.test(segs[segs.length - 1] || '')) score += 3;
    if (score >= 3) pages.set(u.href, Math.max(score, pages.get(u.href) || 0));
  }
  for (const m of html.matchAll(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), base);
      if (/calendar\.google\.com/i.test(u.hostname)) addGcal(u, gcal);
    } catch {}
  }
  for (const m of html.matchAll(/https:\\?\/\\?\/calendar\.google\.com\\?\/calendar\\?\/(?:embed|ical)[^"'\s<>]*/gi)) {
    try { addGcal(new URL(m[0].replace(/\\\//g, '/')), gcal); } catch {}
  }
  return {
    pages: [...pages.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]),
    details: [...details],
    ics: [...ics],
    gcal: [...gcal],
    tickets: [...tickets],
  };
}

// Ticket sellers whose per-event pages a venue links to. Their event pages usually carry schema.org Event data.
export const TICKET_HOSTS = /(^|\.)(venuepilot\.com|etix\.com|eventbrite\.com|ticketweb\.com|seetickets\.us|dice\.fm|tixr\.com|showclix\.com|prekindle\.com|ticketmaster\.com|livenation\.com|axs\.com|ludus\.com|showare\.com|thundertix\.com|simpletix\.com|stubwire\.com|holdmyticket\.com|opendate\.io|universe\.com|eventim\.us|ovationtix\.com|purplepass\.com|vbotickets\.com|brownpapertickets\.com|ticketleap\.com|humanitix\.com|freshtix\.com|tickettailor\.com)$/i;

/** A date embedded in an event URL: /2026-11-14-band, /band-11-14-2026/. Returns YYYY-MM-DD or null. */
export function dateFromUrl(url) {
  let p;
  try { p = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  const valid = (y, mo, d) => (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  // Try every candidate: "...11-11-2026-8-00-pm" also contains "2026-8-00", which isn't a date.
  for (const m of p.matchAll(/(?=(?:^|\D)(20\d{2})[-_/](\d{1,2})[-_/](\d{1,2})(?:\D|$))/g)) { const d = valid(m[1], m[2], m[3]); if (d) return d; }
  for (const m of p.matchAll(/(?=(?:^|\D)(\d{1,2})[-_](\d{1,2})[-_](20\d{2})(?:\D|$))/g)) { const d = valid(m[3], m[1], m[2]); if (d) return d; }
  return null;
}

/** Fallback for event pages without structured data: date from the URL, title from og:title / <h1> / <title>. */
export function eventFromUrlAndTitle(html, url) {
  const date = dateFromUrl(url);
  if (!date) return [];
  const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
  let title = meta('og:title') || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  title = cleanText(title, 200).split(/\s+[|–—]\s+/)[0].trim();
  if (title.length < 2) {
    title = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\d{1,4}[-_]\d{1,2}[-_]\d{1,4}/g, '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (!title) return [];
  // Start time from the title or URL, e.g. "8:00 PM" or "...-8-00-pm-...".
  const tm = `${title} ${decodeURIComponent(new URL(url).pathname)}`.match(/(?:^|[^\d])(\d{1,2})(?:[:-](\d{2}))?\s*-?\s*(am|pm)\b/i);
  let start = date, allDay = true;
  if (tm) {
    let h = +tm[1] % 12 + (/pm/i.test(tm[3]) ? 12 : 0);
    if (h < 24) { start = `${date}T${String(h).padStart(2, '0')}:${tm[2] || '00'}`; allDay = false; }
  }
  // Drop a trailing " - Wednesday 11/11/2026 - 8:00 PM EDT" style suffix from the title.
  title = title.replace(/\s+-\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*$/i, '').trim() || title;
  return [{
    title, start, allDay, end: null, url,
    description: cleanText(meta('og:description') || meta('description') || '', 400),
    image: meta('og:image') || null, performers: [], price: null,
    locName: '', locCity: '', locRegion: '', types: [], via: 'url-date',
  }];
}
function addGcal(u, set) {
  for (const src of u.searchParams.getAll('src').concat(u.searchParams.getAll('cid'))) {
    let id = src;
    if (u.searchParams.has('cid') && !id.includes('@')) { try { id = Buffer.from(id, 'base64').toString('utf8'); } catch {} }
    if (id.includes('@') || id.includes('.')) set.add(`https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`);
  }
  const m = u.pathname.match(/\/calendar\/ical\/([^/]+)\/public\//);
  if (m) set.add(`https://calendar.google.com/calendar/ical/${m[1]}/public/basic.ics`);
}

// ---------- WordPress "The Events Calendar" REST API ----------
export function tribeApiUrl(origin, days) {
  const s = todayEastern();
  return `${origin}/wp-json/tribe/events/v1/events?per_page=50&start_date=${s}&end_date=${addDays(s, days)}`;
}
export function eventsFromTribe(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  return (j.events || []).map((e) => {
    const d = normalizeDate(e.all_day ? String(e.start_date).slice(0, 10) : e.start_date);
    if (!d) return null;
    const v = (Array.isArray(e.venue) ? e.venue[0] : e.venue) || {};
    return {
      title: cleanText(e.title, 200), start: d.start, allDay: d.allDay,
      end: normalizeDate(e.end_date)?.start || null,
      url: e.url || null, description: cleanText(e.description, 400),
      image: e.image?.url || null, performers: [], price: e.cost || null,
      locName: cleanText(v.venue || '', 120), locCity: v.city || '', locRegion: v.stateprovince || v.state || '',
      types: (e.categories || []).map((c) => c.name),
      via: 'wp-tribe',
    };
  }).filter(Boolean);
}

// ---------- Squarespace events collection (?format=json) ----------
export function eventsFromSquarespace(text, origin) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  const items = [].concat(j.upcoming || [], j.items || []).filter((i) => i && i.startDate);
  return items.map((i) => ({
    title: cleanText(i.title, 200), start: toEastern(new Date(i.startDate)), allDay: false,
    end: i.endDate ? toEastern(new Date(i.endDate)) : null,
    url: i.fullUrl ? new URL(i.fullUrl, origin).href : null,
    description: cleanText(i.excerpt || i.body, 400), image: i.assetUrl || null, performers: [], price: null,
    locName: cleanText(i.location?.addressTitle || '', 120), locCity: '', locRegion: '',
    types: [], via: 'squarespace',
  }));
}

// ---------- iCalendar feeds ----------
function icsUnescape(s) { return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
function icsDate(prop) {
  // prop: { params, value }
  const v = prop.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE(;|$)/i.test(prop.params) && (m = v.match(/^(\d{4})(\d{2})(\d{2})/))) return { start: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  if (m[7]) return { start: toEastern(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]))), allDay: false };
  return { start: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, allDay: false }; // floating / TZID: assume Eastern
}
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Expand simple DAILY/WEEKLY RRULEs into start strings within [from, to]. */
function expandRRule(rrule, start, from, to, exdates) {
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')));
  const freq = r.FREQ, interval = +(r.INTERVAL || 1), count = r.COUNT ? +r.COUNT : Infinity;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return start.slice(0, 10) >= from && start.slice(0, 10) <= to ? [start] : [];
  const until = r.UNTIL ? icsDate({ params: '', value: r.UNTIL })?.start.slice(0, 10) : null;
  const time = start.slice(10);
  const startDay = start.slice(0, 10);
  const byday = freq === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]) : null;
  const out = [];
  let n = 0;
  for (let i = 0; i < 800; i++) {
    const day = addDays(startDay, i);
    if (day > to || (until && day > until) || n >= count) break;
    const diff = i;
    let hit;
    if (freq === 'DAILY') hit = diff % interval === 0;
    else {
      const wd = new Date(day + 'T12:00:00Z').getUTCDay();
      const week = Math.floor(diff / 7);
      hit = week % interval === 0 && (byday ? byday.includes(wd) : wd === new Date(startDay + 'T12:00:00Z').getUTCDay());
    }
    if (!hit) continue;
    n++;
    if (day >= from && !exdates.has(day)) out.push(day + time);
  }
  return out;
}

export function eventsFromIcs(text, windowDays) {
  if (!/BEGIN:VCALENDAR/i.test(text)) return [];
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const from = todayEastern(), to = addDays(from, windowDays);
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { exdates: new Set() }; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur?.DTSTART && cur.SUMMARY && !/CANCELLED/i.test(cur.STATUS?.value || '')) {
        const d = icsDate(cur.DTSTART);
        if (d) {
          const starts = cur.RRULE ? expandRRule(cur.RRULE.value, d.start, from, to, cur.exdates) : [d.start];
          for (const s of starts) {
            out.push({
              title: cleanText(icsUnescape(cur.SUMMARY.value), 200), start: s, allDay: d.allDay, end: null,
              url: cur.URL ? cur.URL.value.trim() : null,
              description: cleanText(icsUnescape(cur.DESCRIPTION?.value || ''), 400),
              image: null, performers: [], price: null,
              locName: cleanText(icsUnescape(cur.LOCATION?.value || '').split(',')[0], 120), locCity: '', locRegion: '',
              types: [], via: 'ics',
            });
          }
        }
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/i);
    if (!m) continue;
    const key = m[1].toUpperCase();
    if (key === 'EXDATE') { for (const v of m[3].split(',')) { const d = icsDate({ params: m[2], value: v }); if (d) cur.exdates.add(d.start.slice(0, 10)); } continue; }
    if (!cur[key]) cur[key] = { params: m[2], value: m[3] };
  }
  return out;
}
