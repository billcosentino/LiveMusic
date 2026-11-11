// Optional: ask Claude to read an event page that has no structured data.
// Enabled only when Anthropic credentials are available (ANTHROPIC_API_KEY in the environment or in .env).
// Results are cached per URL and reused while the page text is unchanged, so a nightly run only pays for pages that changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, readJSON, writeJSON, decodeEntities, todayEastern, addDays, normalizeDate, cleanText, log } from './util.js';

const CACHE_FILE = path.join(DATA, 'llm-cache.json');
const MODEL = process.env.GIG_CLAUDE_MODEL || 'claude-opus-5-5';
const MAX_CHARS = 40000;

// Load .env (KEY=value lines) without a dependency.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

export const llmEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && process.env.GIG_LLM !== 'off';

let client = null;
let cache = null;
let calls = 0;
export const llmCalls = () => calls;

async function getClient() {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ maxRetries: 3, timeout: 120000 });
  }
  return client;
}
export function saveLlmCache() { if (cache) writeJSON(CACHE_FILE, cache); }

/** Visible text of an HTML page, with line breaks kept between blocks so dates stay next to their acts. */
export function pageText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Does this text plausibly contain a dated event listing? Saves calls on pages with nothing to find. */
export function looksLikeListing(text) {
  const dates = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b/gi) || [];
  return dates.length >= 3;
}

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Performer/band name or event title as listed' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: 'Start time as HH:MM 24-hour, or empty string if not listed' },
          is_music: { type: 'boolean', description: 'true for live music, DJs, open mics, concerts; false for trivia, comedy, classes, etc.' },
          price: { type: 'string', description: 'Price/cover as listed, or empty string' },
        },
        required: ['title', 'date', 'time', 'is_music', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
};

/**
 * Extract upcoming events from page text. Returns raw events in the same shape as src/extract.js, or [] on failure.
 */
export async function extractWithClaude({ url, html, venue, windowDays }) {
  cache ??= readJSON(CACHE_FILE, {});
  let text = pageText(html);
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS); // event listings come first on nearly every page; the tail is footer/archives
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  const today = todayEastern(), until = addDays(today, windowDays);

  let items;
  const hit = cache[url];
  if (hit && hit.hash === hash) {
    items = hit.items;
  } else {
    const prompt = `Below is the text of a web page from ${venue.name}, a ${venue.category} in ${venue.city}, ${venue.state}. Today is ${today}.

List every event on this page that happens at this venue between ${today} and ${until}. Infer the year from today's date when the page omits it (a month earlier than the current month means next year). If an act repeats on several dates, list each date separately. If a recurring weekly event is described without specific dates (e.g. "Trivia every Tuesday"), skip it. Do not invent events, and return an empty list if the page has no dated events.

Page URL: ${url}
---
${text}`;
    try {
      const api = await getClient();
      calls++;
      const res = await api.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      });
      if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
        log(`  claude: ${res.stop_reason} for ${url}`);
        return [];
      }
      const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      items = JSON.parse(out).events || [];
      cache[url] = { hash, items, at: new Date().toISOString() };
    } catch (e) {
      log(`  claude error for ${url}: ${e?.status ? `HTTP ${e.status} ` : ''}${e.message}`);
      return [];
    }
  }

  return items.map((i) => {
    const d = normalizeDate(/^\d{2}:\d{2}$/.test(i.time) ? `${i.date}T${i.time}` : i.date);
    if (!d || !i.title) return null;
    return {
      title: cleanText(i.title, 200), start: d.start, allDay: d.allDay, end: null, url,
      description: '', image: null, performers: [], price: i.price || null,
      locName: '', locCity: '', locRegion: '',
      types: i.is_music ? ['MusicEvent'] : ['Event:other'],
      via: 'claude',
    };
  }).filter(Boolean);
}
