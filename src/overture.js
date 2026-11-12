// Venues from Overture Maps Places (free, open data built from Meta, Microsoft and other business listings).
// Much better than OpenStreetMap for bars, clubs and small music venues. Queried straight from Overture's public
// S3 bucket with DuckDB, which reads only the CT/NY/MA slice of the files.
import { DATA, STATES, readJSON, writeJSON, log } from './util.js';
import path from 'node:path';

const CACHE = path.join(DATA, 'overture-venues.json');
const STAC = 'https://stac.overturemaps.org/catalog.json';
const MIN_CONFIDENCE = 0.5;

// Overture basic_category -> our category. Anything else is ignored.
const CATEGORY = {
  music_venue: 'music venue',
  theatre_venue: 'theater', performing_arts_venue: 'theater', cultural_center: 'theater',
  brewery: 'brewery', winery: 'winery', distillery: 'distillery',
  bar: 'bar', lounge: 'bar', alcoholic_beverage_venue: 'bar',
  dance_club: 'club',
  comedy_club: 'comedy',
};

async function latestRelease() {
  const res = await fetch(STAC, { signal: AbortSignal.timeout(30000) });
  const j = await res.json();
  if (!j.latest) throw new Error('no latest release in Overture catalog');
  return j.latest;
}

/** Returns { CT: [...], NY: [...], MA: [...] } of venue records. Cached per Overture release. */
export async function overtureVenues() {
  const release = await latestRelease();
  const cached = readJSON(CACHE, null);
  if (cached?.release === release) { log(`overture: using cached ${release}`); return cached.byState; }

  log(`overture: querying release ${release} (takes a minute)…`);
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();
  await c.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
  const cats = Object.keys(CATEGORY).map((k) => `'${k}'`).join(',');
  const rows = (await c.runAndReadAll(`
    SELECT id, names.primary AS name, confidence, websites[1] AS website,
           addresses[1].locality AS city, addresses[1].region AS region, addresses[1].freeform AS address,
           basic_category AS cat, bbox.xmin AS lon, bbox.ymin AS lat
    FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*', hive_partitioning=1)
    WHERE bbox.xmin BETWEEN -79.8 AND -69.9 AND bbox.ymin BETWEEN 40.49 AND 45.02
      AND addresses[1].region IN (${STATES.map((s) => `'${s}'`).join(',')})
      AND basic_category IN (${cats})
      AND coalesce(operating_status, 'open') = 'open'
      AND confidence >= ${MIN_CONFIDENCE}
      AND names.primary IS NOT NULL`)).getRowObjectsJson();

  const byState = Object.fromEntries(STATES.map((s) => [s, []]));
  for (const r of rows) {
    byState[r.region].push({
      id: 'ov-' + r.id, name: r.name, category: CATEGORY[r.cat], city: r.city || '', state: r.region,
      address: r.address || '', lat: +(+r.lat).toFixed(5), lon: +(+r.lon).toFixed(5),
      website: r.website || null, source: 'overture',
    });
  }
  writeJSON(CACHE, { release, byState });
  log(`overture: ${rows.length} venues (${STATES.map((s) => `${s} ${byState[s].length}`).join(', ')})`);
  return byState;
}
