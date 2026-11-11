# Live Music Calendar: CT · NY · MA

Finds music venues, bars, breweries and theaters across Connecticut, New York and Massachusetts, collects upcoming shows from their websites, and builds a filterable calendar with `.ics` export. It runs nightly on this PC.

## Quick start

```bat
run.cmd                 :: refresh venues (weekly), scrape events, build the calendar
npm run serve           :: then open http://localhost:8080
```

You can also open `site\index.html` directly. The data is embedded in `site\data.js`, so it works without a server.

## How it works

| Step | Script | What it does |
|---|---|---|
| 1. Venues | `src/venues.js` | Queries OpenStreetMap (Overpass API) for music venues, theaters, breweries, wineries, and bars or pubs that list a website. Fills in missing cities from the nearest town. Writes `data/venues.json`. Re-runs only when the list is over 7 days old. |
| 2. Events | `src/scrape.js` | For each venue website, tries these in order: what worked last time; schema.org Event data (JSON-LD) on the home page; iCal feeds and embedded Google Calendars; the WordPress *The Events Calendar* API; linked event or calendar pages; individual event pages; and, if enabled, **Claude reading the page**. Respects robots.txt and waits between requests to the same site. Writes `data/events-raw.json`. |
| 3. Build | `src/build.js` | Removes duplicates (same day, venue and title), reassigns shows listed at other venues, tags music versus other events (trivia, comedy, classes), and writes `site/data.js` and `site/all.ics`. |

Venues that turn up no events are re-checked weekly instead of nightly, which keeps nightly runs short.

## Turning on Claude page reading (recommended)

Most small bars and breweries post their lineup as plain text or images, not structured data. Without Claude, those venues are skipped. To turn it on, create a `.env` file in this folder:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Optional settings:

```
GIG_CLAUDE_MODEL=claude-opus-5-5     # default; claude-haiku-5-5 is ~40x cheaper per token
GIG_LLM_MAX=300                      # max new Claude calls per nightly run
GIG_LLM=off                          # disable without removing the key
```

Each page's text is hashed, so Claude is only called again when a venue's page actually changes. Cached results live in `data/llm-cache.json`.

## Adding venues by hand

OpenStreetMap misses some places. Add them to `data/venues-manual.json`:

```json
[
  { "name": "Example Music Hall", "city": "Kent", "state": "CT", "website": "https://example.com/events", "category": "music venue" }
]
```

Point `website` at the venue's events page if it has one. Then run `node src/venues.js` and `run.cmd`.

## Useful commands

```bat
node src/scrape.js --state CT            :: one state
node src/scrape.js --venue "Infinity"    :: venues whose name matches
node src/scrape.js --limit 50            :: quick test
node src/scrape.js --full                :: ignore the weekly re-check schedule
node src/venues.js --state MA            :: rebuild one state's venue list
schedule.cmd                             :: install the nightly 3:00 AM task
schedule.cmd remove                      :: remove it
```

Logs are in `logs\run-YYYY-MM-DD.log` (the last 30 are kept). Per-venue results, including errors, are in `data/venue-status.json`.

## Coverage limits

- Venues that post only on Facebook or Instagram aren't scraped. Those sites block scraping and prohibit it in their terms.
- Sites that block automated requests (Cloudflare challenges, robots.txt) are skipped, not worked around.
- Wix and other JavaScript-only calendars often have no readable text in the HTML, so even Claude can't see them.
- The scraper keeps events up to 120 days ahead.
