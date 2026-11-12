// Visits each scrapable venue's website and collects upcoming events into data/events-raw.json.
//   node src/scrape.js                     all venues (skips recently-empty ones, see RECHECK_DAYS)
//   node src/scrape.js --state CT          one state
//   node src/scrape.js --limit 50          first N venues (testing)
//   node src/scrape.js --venue "Infinity"  venues whose name contains text
//   node src/scrape.js --full              ignore the skip schedule and try every venue
import path from 'node:path';
import { DATA, arg, readJSON, writeJSON, fetchText, pool, allowedByRobots, log, todayEastern, addDays } from './util.js';
import { eventsFromJsonLd, scanLinks, tribeApiUrl, eventsFromTribe, eventsFromSquarespace, eventsFromIcs, eventFromUrlAndTitle, dateFromUrl } from './extract.js';
import { llmEnabled, extractWithClaude, pageText, looksLikeListing, saveLlmCache, llmCalls } from './llm.js';

const WINDOW_DAYS = 120;      // how far ahead to keep events
const CONCURRENCY = 16;       // venues processed in parallel (one request at a time per venue)
const MAX_LIST_PAGES = 4;     // event-list pages to try per venue
const MAX_DETAIL_PAGES = 60;  // individual event / ticket pages to read when list pages don't carry the full lineup
const RECHECK_DAYS = 7;       // venues that yielded nothing are retried this often instead of nightly
const PAGE_DELAY_MS = 400;    // pause between requests to the same site
const LLM_MAX_CALLS = +arg('llm-max', process.env.GIG_LLM_MAX || 300); // cap on new Claude calls per run (cached pages are free)

const VENUES = path.join(DATA, 'venues.json');
const STATUS = path.join(DATA, 'venue-status.json');
const OUT = path.join(DATA, 'events-raw.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts) {
  if (!(await allowedByRobots(url))) return null;
  await sleep(PAGE_DELAY_MS);
  return fetchText(url, opts);
}

/** Collect events for one venue. Returns { events, hint } where hint records what worked, to try first next time. */
async function scrapeVenue(venue, hint) {
  const events = [];
  const tried = new Set();
  const from = todayEastern(), to = addDays(from, WINDOW_DAYS);
  const add = (list, where) => {
    for (const e of list) if (e.title && e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= to) events.push({ ...e, foundOn: where });
  };
  const worked = new Set();

  // 1) Whatever worked last time.
  for (const h of hint?.sources || []) {
    // Single-show pages go stale; only list-level sources are worth remembering.
    if (h.startsWith('details:') || (h.startsWith('page:') && (dateFromUrl(h.slice(5)) || /\/(events?|shows?|calendar|concerts?)\/[^/]+/i.test(h)))) continue;
    const n = events.length;
    await trySource(h, venue, add, tried);
    if (events.length > n) worked.add(h);
  }
  if (events.length) return { events, sources: [...worked] };

  // 2) Home page: JSON-LD, links, platform detection.
  const home = await get(venue.website);
  if (!home) return { events, sources: [], error: 'home page unreachable or disallowed' };
  tried.add(home.url);
  const fetched = [home];
  add(eventsFromJsonLd(home.text), home.url);
  if (events.length) worked.add('page:' + home.url);
  const origin = new URL(home.url).origin;
  const links = scanLinks(home.text, home.url);
  const isWP = /wp-content|wp-json/i.test(home.text);
  const isSquarespace = /squarespace/i.test(home.text);

  // 3) iCal feeds and Google Calendar embeds (published for calendar clients, so fetched directly).
  for (const feed of [...links.ics, ...links.gcal].slice(0, 3)) {
    const n = events.length;
    await trySource('ics:' + feed, venue, add, tried);
    if (events.length > n) worked.add('ics:' + feed);
  }

  // 4) WordPress The Events Calendar API.
  if (isWP) {
    const n = events.length;
    await trySource('tribe:' + origin, venue, add, tried);
    if (events.length > n) worked.add('tribe:' + origin);
  }

  // 5) Event list pages linked from the home page.
  const detailCandidates = new Map(); // event/ticket URL -> list page it was linked from
  const note = (l, from) => { for (const u of [...l.details, ...l.tickets]) if (!detailCandidates.has(u)) detailCandidates.set(u, from); };
  note(links, home.url);
  for (const pageUrl of links.pages.slice(0, MAX_LIST_PAGES)) {
    if (tried.has(pageUrl)) continue;
    tried.add(pageUrl);
    const page = await get(pageUrl);
    if (!page) continue;
    fetched.unshift(page);
    const n = events.length;
    add(eventsFromJsonLd(page.text), page.url);
    const sub = scanLinks(page.text, page.url);
    note(sub, page.url);
    for (const feed of [...sub.ics, ...sub.gcal].slice(0, 2)) await trySource('ics:' + feed, venue, add, tried) && worked.add('ics:' + feed);
    if (isSquarespace && events.length === n) await trySource('sqs:' + page.url, venue, add, tried);
    if (events.length > n) worked.add((events.at(-1).via === 'squarespace' ? 'sqs:' : 'page:') + page.url);
  }

  // 6) Individual event pages and ticket-seller pages, when the lists link to more shows than we've found.
  const n6 = events.length;
  await followDetails(detailCandidates, events.length, add, tried);
  if (events.length > n6) for (const from of new Set(detailCandidates.values())) worked.add('links:' + from);

  // 7) Claude reads the most promising unstructured page (optional, needs an API key).
  if (!events.length && llmEnabled() && llmCalls() < LLM_MAX_CALLS) {
    const page = fetched.find((p) => looksLikeListing(pageText(p.text)));
    if (page) {
      add(await extractWithClaude({ url: page.url, html: page.text, venue, windowDays: WINDOW_DAYS }), page.url);
      worked.add('claude:' + page.url);  // remembered even if empty today, so the page is re-read next run
    }
  }
  return { events, sources: [...worked] };
}

async function followDetails(candidates, found, add, tried) {
  const urls = [...candidates.keys()].filter((u) => !tried.has(u));
  if (!urls.length || urls.length <= found) return; // the lists' structured data already covers them
  for (const u of urls.slice(0, MAX_DETAIL_PAGES)) {
    tried.add(u);
    const page = await get(u);
    if (!page) continue;
    const ld = eventsFromJsonLd(page.text);
    add(ld.length ? ld : eventFromUrlAndTitle(page.text, page.url), page.url);
  }
}

/** Fetch a remembered/derived source. Returns true if it produced events. */
async function trySource(source, venue, add, tried) {
  const i = source.indexOf(':');
  const kind = source.slice(0, i), target = source.slice(i + 1);
  if (tried.has(source)) return false;
  tried.add(source);
  let list = [];
  if (kind === 'ics') {
    const r = await fetchText(target, { accept: 'text/calendar,*/*' });
    if (r) list = eventsFromIcs(r.text, WINDOW_DAYS);
  } else if (kind === 'tribe') {
    const r = await get(tribeApiUrl(target, WINDOW_DAYS), { accept: 'application/json' });
    if (r) list = eventsFromTribe(r.text);
  } else if (kind === 'sqs') {
    const u = new URL(target);
    u.searchParams.set('format', 'json');
    const r = await get(u.href, { accept: 'application/json' });
    if (r) list = eventsFromSquarespace(r.text, u.origin);
  } else if (kind === 'page') {
    const r = await get(target);
    if (r) list = eventsFromJsonLd(r.text);
  } else if (kind === 'claude') {
    if (!llmEnabled()) return false;
    const r = await get(target);
    if (r) list = await extractWithClaude({ url: r.url, html: r.text, venue, windowDays: WINDOW_DAYS });
  } else if (kind === 'links') {
    // Re-scan a list page for event/ticket links and follow them (the links change as shows are added).
    const r = await get(target);
    if (r) {
      const ld = eventsFromJsonLd(r.text);
      add(ld, target);
      const l = scanLinks(r.text, r.url);
      const n = { count: 0 };
      await followDetails(new Map([...l.details, ...l.tickets].map((u) => [u, target])), ld.length, (evs, where) => { n.count += evs.length; add(evs, where); }, tried);
      return ld.length + n.count > 0;
    }
  } else if (kind === 'details') {
    for (const u of target.split('|')) {
      const r = await get(u);
      if (r) list.push(...eventsFromJsonLd(r.text));
    }
  }
  add(list, target);
  return list.length > 0;
}

async function main() {
  const { venues = [] } = readJSON(VENUES, {});
  if (!venues.length) { console.error('No venues yet. Run: node src/venues.js'); process.exit(1); }
  const status = readJSON(STATUS, {});
  const previous = readJSON(OUT, { events: [] }).events;

  const st = arg('state'), name = arg('venue'), limit = +arg('limit', 0), full = !!arg('full');
  let targets = venues.filter((v) => v.scrapable);
  if (st) targets = targets.filter((v) => v.state === String(st).toUpperCase());
  if (name) targets = targets.filter((v) => v.name.toLowerCase().includes(String(name).toLowerCase()));
  const now = Date.now();
  const due = full || name ? targets : targets.filter((v) => {
    const s = status[v.id];
    if (s && now - Date.parse(s.checked) < 12 * 3600000) return false; // already done in this run window (resume after a crash)
    return !s || s.count > 0 || now - Date.parse(s.checked) > RECHECK_DAYS * 86400000;
  });
  const run = limit ? due.slice(0, limit) : due;
  log(`${targets.length} scrapable venues, ${run.length} due this run; Claude page reading ${llmEnabled() ? 'ON (max ' + LLM_MAX_CALLS + ' new calls)' : 'off (no ANTHROPIC_API_KEY)'}`);

  const results = new Map();
  const byId = new Map(venues.map((v) => [v.id, v]));
  const today = todayEastern();
  // Saved every 100 venues so a crash keeps the work done so far; a re-run then skips venues checked in the last 12h.
  const saveProgress = () => {
    const kept = previous.filter((e) => !results.has(e.venueId) && e.start.slice(0, 10) >= today);
    const fresh = [];
    for (const [id, evs] of results) for (const e of evs) fresh.push({ ...e, venueId: id, venueName: byId.get(id).name });
    writeJSON(OUT, { updated: new Date().toISOString(), events: [...kept, ...fresh] });
    return { kept, fresh };
  };
  let done = 0, withEvents = 0, total = 0;
  await pool(run, CONCURRENCY, async (v) => {
    let r;
    try {
      r = await Promise.race([scrapeVenue(v, status[v.id]), sleep(180000).then(() => ({ events: [], sources: [], error: 'timed out' }))]);
    } catch (e) {
      r = { events: [], sources: [], error: e.message };
    }
    results.set(v.id, r.events);
    status[v.id] = { checked: new Date().toISOString(), count: r.events.length, sources: r.sources, ...(r.error ? { error: r.error } : {}) };
    done++;
    if (r.events.length) { withEvents++; total += r.events.length; }
    if (r.events.length || done % 50 === 0) log(`[${done}/${run.length}] ${v.name} (${v.city}, ${v.state}): ${r.events.length} events${r.error ? ' — ' + r.error : ''}`);
    if (done % 25 === 0) { writeJSON(STATUS, status); saveProgress(); }
  });

  writeJSON(STATUS, status);
  saveLlmCache();
  const { kept } = saveProgress();
  log(`claude calls this run: ${llmCalls()}`);
  log(`done: ${withEvents}/${run.length} venues had events, ${total} new events; ${kept.length} carried over → data/events-raw.json`);
}

// Exit explicitly: aborted fetches can leave sockets open that keep Node alive for minutes.
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
