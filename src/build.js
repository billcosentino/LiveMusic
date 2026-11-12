// Cleans data/events-raw.json → site/data.js (for the calendar page) and site/all.ics.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, SITE, STATES, readJSON, norm, todayEastern, log } from './util.js';

const REGION = { CT: 'CT', CONNECTICUT: 'CT', NY: 'NY', 'NEW YORK': 'NY', MA: 'MA', MASSACHUSETTS: 'MA', NJ: 'NJ', 'NEW JERSEY': 'NJ', RI: 'RI', 'RHODE ISLAND': 'RI', VT: 'VT', VERMONT: 'VT' };

const NON_MUSIC = /\b(trivia|bingo|quiz|paint(ing)?\b|sip\s*(&|and|n)\s*paint|yoga|pilates|brunch|class(es)?\b|workshop|seminar|meeting|market|craft fair|vendor|comedy|comedian|stand-?up|improv|film|movie|screening|book club|story ?time|kids?\b|closed|private (event|party)|run club|lecture|tour\b|auction|fundraiser gala|game night|board games?|drag brunch|magic show|play\b|musical\b|cinema|webinar|camp\b|lessons?\b)\b/i;
const MUSIC = /\b(live|music|band|concert|acoustic|jazz|blues|rock|duo|trio|quartet|dj|open mic|orchestra|symphony|philharmonic|tribute|country|bluegrass|folk|funk|reggae|hip[- ]?hop|singer|songwriter|unplugged|jam\b|session|choir|chorale|soul|punk|metal|americana|ensemble|recital|piano|guitar|fiddle|celtic|irish music|motown|r&b|tour)\b/i;

function classify(e, venue) {
  const types = (e.types || []).join(' ');
  const text = `${e.title} ${types}`;
  if (types.includes('Event:other')) return 'other'; // Claude said not music
  if (/MusicEvent|Festival/i.test(types) || e.performers?.length) return NON_MUSIC.test(e.title) && !MUSIC.test(e.title) ? 'other' : 'music';
  if (MUSIC.test(text) && !/\b(trivia|bingo|comedy|paint)\b/i.test(e.title)) return 'music';
  if (NON_MUSIC.test(text)) return 'other';
  if (/TheaterEvent|ComedyEvent|ScreeningEvent|EducationEvent|SportsEvent|FoodEvent|ChildrensEvent/i.test(types)) return 'other';
  // Bars, breweries and music venues mostly list band names as bare titles; theaters mostly don't.
  return ['theater', 'restaurant', 'event space', 'comedy'].includes(venue.category) ? 'other' : 'music';
}

function overlaps(a, b) {
  const A = norm(a), B = norm(b);
  return !A || !B || A.includes(B) || B.includes(A) || A.slice(0, 8) === B.slice(0, 8);
}

function main() {
  const { venues = [] } = readJSON(path.join(DATA, 'venues.json'), {});
  const raw = readJSON(path.join(DATA, 'events-raw.json'), { events: [] }).events;
  const byId = new Map(venues.map((v) => [v.id, v]));
  const today = todayEastern();
  const seen = new Map();
  let dropped = 0;

  for (const e of raw) {
    const v = byId.get(e.venueId);
    if (!v || !e.title || e.start.slice(0, 10) < today) { dropped++; continue; }
    let venueName = v.name, city = v.city, state = v.state, venueId = v.id;
    // Event pages sometimes list shows at other locations (promoters, touring acts, multi-venue groups).
    if (e.locName && !overlaps(e.locName, v.name) && (e.locCity || e.locRegion)) {
      const region = REGION[String(e.locRegion).toUpperCase().trim()];
      if (e.locRegion && !region) { dropped++; continue; } // outside the covered states
      const match = venues.find((x) => (!region || x.state === region) && overlaps(x.name, e.locName) && (!e.locCity || norm(x.city) === norm(e.locCity)));
      if (match) ({ name: venueName, city, state, id: venueId } = match);
      else { venueName = e.locName; city = e.locCity || city; state = region || state; venueId = `${v.id}:${norm(e.locName)}`; }
    }
    if (!STATES.includes(state)) { dropped++; continue; }
    e.title = trimVenueSuffix(e.title, venueName, city).replace(/^Get\s+(.+?)\s+Tickets$/i, '$1');
    const key = `${e.start.slice(0, 10)}|${norm(venueName).slice(0, 20)}|${norm(e.title).slice(0, 30)}`;
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (!prev.description && e.description) prev.description = e.description;
      if (!prev.image && e.image) prev.image = e.image;
      if (prev.allDay && !e.allDay) { prev.start = e.start; prev.allDay = false; }
      continue;
    }
    seen.set(key, {
      id: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12),
      title: e.title,
      start: e.start,
      end: e.end || null,
      allDay: !!e.allDay,
      venue: venueName, venueId, city: city || 'Unknown', state,
      kind: classify(e, v),
      url: absolutize(e.url, e.foundOn) || e.foundOn || v.website,
      description: e.description || '',
      image: e.image || null,
      price: e.price || null,
      source: e.via,
    });
  }

  const events = [...seen.values()].sort((a, b) => a.start.localeCompare(b.start) || a.venue.localeCompare(b.venue));
  const counts = { venues: venues.length, scrapable: venues.filter((v) => v.scrapable).length, venuesWithEvents: new Set(events.map((e) => e.venueId)).size };
  const payload = { updated: new Date().toISOString(), counts, events };
  fs.mkdirSync(SITE, { recursive: true });
  fs.writeFileSync(path.join(SITE, 'data.js'), 'window.GIG_DATA = ' + JSON.stringify(payload) + ';\n');
  fs.writeFileSync(path.join(SITE, 'all.ics'), toIcs(events));
  log(`built ${events.length} events at ${counts.venuesWithEvents} venues (${raw.length} raw, ${dropped} dropped, ${raw.length - dropped - events.length} duplicates) → site/data.js, site/all.ics`);
}

/** "Pokey LaFarge — Assembly - Kingston, NY" -> "Pokey LaFarge" (drops a trailing venue/city part). */
function trimVenueSuffix(title, venueName, city) {
  const parts = title.split(/\s+(?:[|–—•@]|-|at)\s+/i);
  if (parts.length < 2) return title;
  const v = norm(venueName), c = norm(city);
  for (let i = 1; i < parts.length; i++) {
    const p = norm(parts[i]);
    if (p && ((v.length >= 4 && (p.includes(v) || v.includes(p))) || (c && p.startsWith(c)))) {
      const kept = title.slice(0, title.indexOf(parts[i])).replace(/\s+(?:[|–—•@]|-|at)\s*$/i, '').replace(/\s*[-–—]\s*live$/i, '').trim();
      return kept.length >= 2 ? kept : title;
    }
  }
  return title;
}

function absolutize(u, base) {
  if (!u) return null;
  try { return new URL(u, base).href; } catch { return null; }
}

// ---------- iCalendar export (same format the page uses for filtered exports) ----------
function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n'); }
function fold(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); }
function icsStamp(s, allDay) {
  const d = s.replace(/[-:]/g, '');
  return allDay ? `;VALUE=DATE:${d.slice(0, 8)}` : `;TZID=America/New_York:${d.slice(0, 13)}00`;
}
export function toIcs(events) {
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//gig-calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Live Music – CT/NY/MA/NJ/RI/VT', 'X-WR-TIMEZONE:America/New_York'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@gig-calendar`, `DTSTAMP:${now}`, 'DTSTART' + icsStamp(e.start, e.allDay));
    if (!e.allDay) {
      const [d, t] = e.start.split('T');
      const end = e.end && e.end.length > 10 && e.end > e.start ? e.end : addHours(d, t, 3); // default 3h set
      lines.push('DTEND' + icsStamp(end, false));
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`, `LOCATION:${icsEscape(`${e.venue}, ${e.city}, ${e.state}`)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push(`DESCRIPTION:${icsEscape([e.description, e.url].filter(Boolean).join('\n\n'))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
function addHours(d, t, h) {
  const dt = new Date(`${d}T${t}:00Z`);
  dt.setUTCHours(dt.getUTCHours() + h);
  return dt.toISOString().slice(0, 16);
}

main();
