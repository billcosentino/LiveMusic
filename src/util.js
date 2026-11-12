import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const SITE = path.join(ROOT, 'site');
export const STATES = ['CT', 'NY', 'MA', 'NJ', 'RI', 'VT'];
export const TZ = 'America/New_York';
export const UA = 'GigCalendarBot/1.0 (+local live-music calendar; respects robots.txt)';

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MAX_BYTES = 3 * 1024 * 1024;

/** GET a URL as text with a timeout and a size cap. Returns null on any failure. */
export async function fetchText(url, { timeout = 15000, accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: accept || 'text/html,application/xhtml+xml,application/json,text/calendar;q=0.9,*/*;q=0.5' },
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
      chunks.push(value);
    }
    return { url: res.url || url, text: Buffer.concat(chunks).toString('utf8'), type: res.headers.get('content-type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run fn over items with a fixed number of concurrent workers. */
export async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx], idx); } catch (e) { /* keep going */ }
    }
  });
  await Promise.all(workers);
}

// ---------- robots.txt ----------
const robotsCache = new Map();
export async function allowedByRobots(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!robotsCache.has(u.origin)) {
    robotsCache.set(u.origin, (async () => {
      const r = await fetchText(u.origin + '/robots.txt', { timeout: 8000, accept: 'text/plain' });
      return r && !/<html/i.test(r.text) ? parseRobots(r.text) : [];
    })());
  }
  const rules = await robotsCache.get(u.origin);
  const p = u.pathname + u.search;
  let best = null;
  for (const rule of rules) {
    if (rule.re.test(p) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) best = rule;
  }
  return !best || best.allow;
}
/** robots.txt path pattern → RegExp ("*" = any run of characters, trailing "$" = end of URL). */
function robotsPattern(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}
function parseRobots(text) {
  const rules = [];
  let applies = false, inGroup = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!inGroup) applies = false;
      inGroup = true;
      if (val === '*' || /gigcalendarbot/i.test(val)) applies = true;
    } else {
      inGroup = false;
      if (!applies) continue;
      if ((key === 'disallow' || key === 'allow') && val) rules.push({ path: val, allow: key === 'allow', re: robotsPattern(val) });
    }
  }
  return rules;
}

// ---------- dates ----------
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** Format a Date as local Eastern "YYYY-MM-DDTHH:MM". */
export function toEastern(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/**
 * Normalize a date string from JSON-LD / APIs to { start: "YYYY-MM-DDTHH:MM" | "YYYY-MM-DD", allDay }.
 * Strings without an offset are treated as already-local Eastern time.
 */
export function normalizeDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return { start: toEastern(new Date(value)), allDay: false };
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { start: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    if (m[6]) {
      const d = new Date(s.replace(' ', 'T'));
      return isNaN(d) ? null : { start: toEastern(d), allDay: false };
    }
    return { start: `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}`, allDay: false };
  }
  const d = new Date(s);
  return isNaN(d) ? null : { start: toEastern(d), allDay: false };
}
export function todayEastern() { return toEastern(new Date()).slice(0, 10); }
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- text ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z0-9#]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
}
export function cleanText(s, max = 300) {
  const t = decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
export function norm(s) {
  return decodeEntities(String(s ?? '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
}
export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
export function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
