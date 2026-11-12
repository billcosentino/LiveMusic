// Builds data/venues.json from OpenStreetMap (Overpass API) plus data/venues-manual.json.
//   node src/venues.js              rebuild for all states
//   node src/venues.js --if-stale   only rebuild if venues.json is older than 7 days
//   node src/venues.js --state CT   rebuild one state (others kept)
import fs from 'node:fs';
import path from 'node:path';
import { DATA, STATES, UA, arg, readJSON, writeJSON, log, slug } from './util.js';
import { overtureVenues } from './overture.js';

let overture = null; // filled in main()

const OUT = path.join(DATA, 'venues.json');
const MANUAL = path.join(DATA, 'venues-manual.json');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const STALE_DAYS = 7;

// Sites that block scraping or forbid it in their terms; venues whose only site is one of these are kept but not scraped.
const BLOCKED_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|yelp\.com|tripadvisor\.com|linktr\.ee|clicklinkin\.bio|linkin\.bio|lnk\.bio|beacons\.ai|campsite\.bio|solo\.to)$/i;

function venueQuery(st) {
  return `[out:json][timeout:300];
area["ISO3166-2"="US-${st}"][admin_level=4]->.a;
(
  nwr["amenity"="music_venue"](area.a);
  nwr["amenity"~"^(bar|pub|nightclub|restaurant|cafe|biergarten|community_centre|events_venue)$"]["live_music"~"^(yes|weekly|regular)$"](area.a);
  nwr["amenity"~"^(theatre|arts_centre|concert_hall|nightclub)$"](area.a);
  nwr["amenity"~"^(bar|pub|biergarten)$"]["website"](area.a);
  nwr["amenity"~"^(bar|pub|biergarten)$"]["contact:website"](area.a);
  nwr["craft"~"^(brewery|winery|distillery)$"](area.a);
  nwr["microbrewery"="yes"](area.a);
  nwr["leisure"="bandstand"]["website"](area.a);
  nwr["amenity"="events_venue"](area.a);
  nwr["amenity"~"^(community_centre|social_club|social_centre)$"]["website"](area.a);
  nwr["amenity"~"^(restaurant|cafe)$"]["website"](area.a);
  nwr["amenity"~"^(restaurant|cafe)$"]["contact:website"](area.a);
  nwr["club"~"^(music|social|veterans|sport)$"]["website"](area.a);
);
out center tags;`;
}
function placeQuery(st) {
  return `[out:json][timeout:180];
area["ISO3166-2"="US-${st}"][admin_level=4]->.a;
node["place"~"^(city|town|village|hamlet|suburb)$"]["name"](area.a);
out;`;
}

async function overpass(query) {
  for (const ep of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(330000),
        });
        if (res.ok) return (await res.json()).elements || [];
        log(`  overpass ${ep} → HTTP ${res.status}`);
      } catch (e) {
        log(`  overpass ${ep} → ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  throw new Error('All Overpass endpoints failed');
}

function category(t) {
  if (t.amenity === 'music_venue' || t.amenity === 'concert_hall') return 'music venue';
  if (t.amenity === 'theatre' || t.amenity === 'arts_centre') return 'theater';
  if (t.craft || t.microbrewery === 'yes') return t.craft === 'winery' ? 'winery' : t.craft === 'distillery' ? 'distillery' : 'brewery';
  if (t.amenity === 'nightclub') return 'club';
  if (/^(restaurant|cafe)$/.test(t.amenity) && !/^(yes|weekly|regular)$/.test(t.live_music || '')) return 'restaurant';
  if (t.amenity === 'events_venue' || t.amenity === 'community_centre' || t.amenity === 'social_club' || t.club) return 'event space';
  return 'bar';
}

function cleanUrl(u) {
  if (!u) return null;
  u = u.split(';')[0].trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { return new URL(u).href; } catch { return null; }
}

function nearestPlace(lat, lon, places) {
  let best = null, bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const p of places) {
    const d = (p.lat - lat) ** 2 + ((p.lon - lon) * k) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best?.name || '';
}

async function buildState(st) {
  log(`${st}: querying venues…`);
  const els = await overpass(venueQuery(st));
  log(`${st}: ${els.length} raw elements; querying places…`);
  const places = (await overpass(placeQuery(st))).map((p) => ({ name: p.tags.name, lat: p.lat, lon: p.lon }));
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    if (!t.name) continue;
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const website = cleanUrl(t.website || t['contact:website'] || t.url);
    const city = t['addr:city'] || nearestPlace(lat, lon, places);
    out.push({
      id: `osm-${el.type[0]}${el.id}`,
      name: t.name,
      category: category(t),
      city,
      state: st,
      address: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
      lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      website,
      scrapable: !!website && !BLOCKED_HOSTS.test(new URL(website).hostname),
      liveMusic: /^(yes|weekly|regular)$/.test(t.live_music || '') || t.amenity === 'music_venue',
      wikidata: t.wikidata || undefined,
      source: 'osm',
    });
  }
  await fillFromWikidataTags(out);
  out.push(...(await wikidataVenues(st, out, places)));
  if (overture?.[st]) mergeOverture(out, overture[st]);
  log(`${st}: ${out.length} named venues, ${out.filter((v) => v.scrapable).length} with a scrapable website`);
  return out;
}

/** Add Overture venues, matching ones OSM already has (same website, or same name within ~250 m) to fill gaps. */
function mergeOverture(out, list) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };
  const cell = (lat, lon) => `${Math.round(lat * 200)}:${Math.round(lon * 200)}`; // ~500 m cells
  const byHost = new Map(), grid = new Map();
  const index = (v) => {
    const h = v.website && host(v.website);
    if (h && !BLOCKED_HOSTS.test(h)) byHost.set(h, v);
    const k = cell(v.lat, v.lon);
    (grid.get(k) || grid.set(k, []).get(k)).push(v);
  };
  out.forEach(index);
  let added = 0, filled = 0;
  for (const o of list) {
    const website = cleanUrl(o.website);
    const h = website && host(website);
    let match = h && !BLOCKED_HOSTS.test(h) ? byHost.get(h) : null;
    if (!match) {
      const [a, b] = cell(o.lat, o.lon).split(':').map(Number);
      const k = Math.cos((o.lat * Math.PI) / 180);
      outer: for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const v of grid.get(`${a + i}:${b + j}`) || []) {
          if ((v.lat - o.lat) ** 2 + ((v.lon - o.lon) * k) ** 2 < 0.0000056 && namesMatch(v.name, o.name)) { match = v; break outer; }
        }
      }
    }
    if (match) {
      if (!match.website && website) { match.website = website; match.scrapable = !BLOCKED_HOSTS.test(h); filled++; }
      if (o.category === 'music venue') { match.category = 'music venue'; match.liveMusic = true; }
      if (!match.address && o.address) match.address = o.address;
      continue;
    }
    const v = { ...o, website, scrapable: !!website && !BLOCKED_HOSTS.test(h), liveMusic: o.category === 'music venue' };
    out.push(v);
    index(v);
    added++;
  }
  log(`  overture: ${added} venues added, ${filled} websites filled`);
}

// ---------- Wikidata ----------
const WD_STATE = { CT: 'Q779', NY: 'Q1384', MA: 'Q771' };
// music venue, concert hall, theatre (building), performing arts center, nightclub, amphitheatre, opera house, brewery, winery
const WD_TYPES = ['Q8719053', 'Q1060829', 'Q24354', 'Q57660343', 'Q622425', 'Q181956', 'Q153562', 'Q131734', 'Q156362'];

async function wikidataGet(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(120000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** OSM elements often carry a wikidata=Q... tag even when they have no website; Wikidata's "official website" fills the gap. */
async function fillFromWikidataTags(venues) {
  const need = venues.filter((v) => !v.website && /^Qd+$/.test(v.wikidata || ''));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const j = await wikidataGet('https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=' + batch.map((v) => v.wikidata).join('|'));
    for (const v of batch) {
      const url = j?.entities?.[v.wikidata]?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      const website = cleanUrl(url);
      if (website) { v.website = website; v.scrapable = !BLOCKED_HOSTS.test(new URL(website).hostname); }
    }
  }
  if (need.length) log(`  wikidata tags: filled ${need.filter((v) => v.website).length}/${need.length} missing websites`);
}

/** Venues listed in Wikidata (theaters, music halls, opera houses...) that OSM is missing, or websites OSM lacks. */
async function wikidataVenues(st, existing, places) {
  const q = `SELECT ?item ?itemLabel ?website ?coord WHERE {
  VALUES ?type { ${WD_TYPES.map((t) => 'wd:' + t).join(' ')} }
  ?item wdt:P31/wdt:P279* ?type ; wdt:P131+ wd:${WD_STATE[st]} ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P856 ?website }
  FILTER NOT EXISTS { ?item wdt:P576 ?closed }
  FILTER NOT EXISTS { ?item wdt:P582 ?ended }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
  const j = await wikidataGet('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q));
  if (!j) { log(`  wikidata query failed for ${st}; skipping`); return []; }
  const added = [];
  let filled = 0;
  const seen = new Set();
  for (const b of j.results.bindings) {
    const id = b.item.value.split('/').pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const name = b.itemLabel?.value;
    const m = b.coord?.value.match(/Point(([-d.]+) ([-d.]+))/);
    if (!name || /^Qd+$/.test(name) || !m) continue;
    const lon = +m[1], lat = +m[2];
    const website = cleanUrl(b.website?.value);
    const k = Math.cos((lat * Math.PI) / 180);
    const near = existing.find((v) => v.wikidata === id || (((v.lat - lat) ** 2 + ((v.lon - lon) * k) ** 2) < 0.0000081 /* ~300 m */ && namesMatch(v.name, name)));
    if (near) {
      if (!near.website && website) { near.website = website; near.scrapable = !BLOCKED_HOSTS.test(new URL(website).hostname); filled++; }
      continue;
    }
    added.push({
      id: 'wd-' + id, name, category: 'theater', city: nearestPlace(lat, lon, places), state: st, address: '',
      lat: +lat.toFixed(5), lon: +lon.toFixed(5), website,
      scrapable: !!website && !BLOCKED_HOSTS.test(new URL(website).hostname), wikidata: id, source: 'wikidata',
    });
  }
  log(`  wikidata: ${added.length} venues not in OSM, ${filled} websites filled`);
  return added;
}
function namesMatch(a, b) {
  const n = (s) => s.toLowerCase().replace(/^thes+/, '').replace(/[^a-z0-9]/g, '');
  const A = n(a), B = n(b);
  return A.includes(B) || B.includes(A) || A.slice(0, 6) === B.slice(0, 6);
}

async function main() {
  if (arg('if-stale') && fs.existsSync(OUT)) {
    const ageDays = (Date.now() - fs.statSync(OUT).mtimeMs) / 86400000;
    if (ageDays < STALE_DAYS) { log(`venues.json is ${ageDays.toFixed(1)} days old; skipping refresh`); return; }
  }
  const only = arg('state');
  const states = only ? [String(only).toUpperCase()] : STATES;
  const previous = readJSON(OUT, { venues: [] }).venues;
  let venues = previous.filter((v) => v.source !== 'manual' && !states.includes(v.state));
  try { overture = await overtureVenues(); } catch (e) { log(`overture: FAILED (${e.message}); continuing with OSM + Wikidata only`); }
  for (const st of states) {
    try {
      venues.push(...(await buildState(st)));
    } catch (e) {
      log(`${st}: FAILED (${e.message}); keeping previous list for this state`);
      venues.push(...previous.filter((v) => v.source !== 'manual' && v.state === st));
    }
  }

  // Manual venues override/add. Format: [{ name, city, state, website, category? }]
  const manual = readJSON(MANUAL, []);
  for (const m of manual) {
    const id = m.id || `manual-${slug(m.state)}-${slug(m.city)}-${slug(m.name)}`;
    venues = venues.filter((v) => v.id !== id);
    const website = cleanUrl(m.website);
    venues.push({ category: 'music venue', address: '', ...m, id, website, scrapable: !!website && !BLOCKED_HOSTS.test(new URL(website).hostname), source: 'manual' });
  }

  // Collapse duplicates (same website, or same name in same city), preferring manual entries and ones with a website.
  const seen = new Map();
  for (const v of venues.sort((a, b) => (a.source === 'manual' ? -1 : 0) - (b.source === 'manual' ? -1 : 0) || !!b.website - !!a.website)) {
    const keys = [`n:${v.state}:${v.city}:${v.name}`.toLowerCase()];
    if (v.website) keys.push('w:' + v.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase());
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.set(k, v));
  }
  venues = [...new Set(seen.values())].sort((a, b) => a.state.localeCompare(b.state) || a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  writeJSON(OUT, { updated: new Date().toISOString(), venues });
  log(`wrote ${venues.length} venues (${venues.filter((v) => v.scrapable).length} scrapable) → data/venues.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
