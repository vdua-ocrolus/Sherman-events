// Daily refresh for the Gowanus Events test page (candlewoodlakeevents.com/gowanusevents/).
// Run by .github/workflows/daily-gowanus.yml. Same approach as scripts/refresh-events.mjs:
// Claude researches CURRENT events with the web_search + web_fetch server tools, grounded only
// on what it found, and this script validates the result before anything is written.
//
// One model call per source group (music, stages, community, press), run in parallel, so one
// slow or failed group can't sink the run: that group's events from the previous run carry
// forward instead. New venues are geocoded with OpenStreetMap (cached in
// scripts/gowanus-venues.json). The page's own pipeline (gowanusevents/pipeline.js) then runs
// over the result as a pre-publish check, and gowanusevents/data.js is rewritten only if it
// passes. Any failure aborts without writing, so a bad run never publishes.
//
// Env: ANTHROPIC_API_KEY (required), SLACK_WEBHOOK_URL (optional), EVENTS_MODEL (optional).
// Flags: --dry-run (do everything except write files).

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const MODEL = process.env.EVENTS_MODEL || 'claude-sonnet-5';
const DIR = 'gowanusevents';
const DATA_PATH = `${DIR}/data.js`;
const VENUE_CACHE_PATH = 'scripts/gowanus-venues.json';
const RESEARCH_PATH = 'scripts/gowanus-research.json';
const HORIZON_DAYS = 56;
const MIN_FEED = 40;               // fewer scored events than this means something broke
const MIN_GROUPS_OK = 2;           // of 4; below this the run is not trustworthy
const MAX_GEOCODES = 60;           // new lookups per run (Nominatim asks for <= 1 request/s)
const MISS_RETRY_DAYS = 7;         // retry an address that failed to geocode after this long
const MAX_RESEARCH_PER_RUN = 10;
// Cap on each fetched page (web_fetch max_content_tokens; longer pages are truncated). The first
// uncapped run cost ~$6.18, nearly all input tokens from fetched pages that get re-read on every
// step of the tool loop. Calendars list in date order, so a cut mostly drops dates past the
// 8-week window; 25K tokens (~100K chars) still holds Freddy's full calendar to the horizon.
const FETCH_MAX_TOKENS = 25000;
const UA = 'gowanus-events-refresh/1.0 (+https://candlewoodlakeevents.com/gowanusevents/)';
const NYC_BBOX = { s: 40.55, n: 40.76, w: -74.1, e: -73.85 };
// For the cost line in the log only (USD): Sonnet 5 list prices, web search billed per search.
const PRICE = { inPerM: 2, outPerM: 10, perSearch: 0.01 };
const DRY_RUN = process.argv.includes('--dry-run');

const GROUPS = {
  music: {
    searchUses: 14, fetchUses: 14,
    focus: `Live music is the heart of this neighborhood: jazz, experimental, indie, folk, global, club nights, classical recitals. List every show at the sources below for the next 8 weeks. Then web_search for live music in Gowanus, Park Slope, Carroll Gardens, Cobble Hill and Boerum Hill at places not listed (bars, breweries, churches, galleries, record stores, parks) and include what you find.`,
  },
  stages: {
    searchUses: 10, fetchUses: 12,
    focus: `Comedy, live podcasts, storytelling, talks, book launches, exhibitions, design events and parties at these stages. Include their music nights too.`,
  },
  community: {
    searchUses: 20, fetchUses: 14,
    focus: `Festivals, street fairs, parades, block parties, markets, community meals (such as The Longest Table), canal clean-ups and plantings, canoe trips, open studios, kids and family events, free outdoor events, volunteer days. These are among the most important listings and the easiest to miss: an outside organizer usually runs them, so they live on Eventbrite, the organizer's own site, or the neighborhood press, not on venue calendars, and they are often branded under a name that doesn't say what they are. Fetch every Eventbrite page below and read the whole listing, not just the first screen. Then web_search "Gowanus", "Park Slope", "Carroll Gardens" and "Cobble Hill" with festival, street fair, parade, block party, market, community dinner, clean-up and holiday event, for the next 8 weeks.`,
  },
  press: {
    searchUses: 14, fetchUses: 10,
    focus: `Neighborhood press and listings. Fetch the pages below, then web_search Brownstoner, Patch (Park Slope, Carroll Gardens), The Gowanaut newsletter, Hoodline, NYC Parks events (Washington Park, Thomas Greene Park, Carroll Park), and the Brooklyn Public Library's Park Slope and Carroll Gardens branches for events in the next 8 weeks.`,
  },
};

// ---------------------------------------------------------------------------
// Shared helpers (norm matches gowanusevents/pipeline.js)
// ---------------------------------------------------------------------------
const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(new Date(s + 'T12:00:00Z').getTime());
const isURL = (s) => /^https?:\/\/\S+$/i.test(s || '');

// config.js, data.js and pipeline.js are plain browser scripts that share one global scope;
// run them the same way here so the refresh checks exactly what the page will compute.
async function pageContext(dataJs) {
  const ctx = vm.createContext({});
  vm.runInContext(await readFile(`${DIR}/config.js`, 'utf8'), ctx, { filename: 'config.js' });
  if (dataJs !== undefined) {
    vm.runInContext(dataJs, ctx, { filename: 'data.js' });
    vm.runInContext(await readFile(`${DIR}/pipeline.js`, 'utf8'), ctx, { filename: 'pipeline.js' });
  }
  return ctx;
}
const renderData = (data) => `/* Generated by scripts/refresh-gowanus.mjs. Do not edit by hand; the next run overwrites it. */\nconst DATA = ${JSON.stringify(data, null, 1)};\n`;

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch { /* non-fatal */ }
}

async function fail(msg) {
  console.error('refresh-gowanus: ' + msg);
  await notifySlack(`Gowanus events refresh FAILED (${todayISO()}): ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------
let _client = null;
async function anthropic() {
  if (!_client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _client = new Anthropic({ maxRetries: 5 }); // reads ANTHROPIC_API_KEY; retries 429/5xx/overloaded
  }
  return _client;
}

// Stream (avoids connection timeouts on long web-tool research) and resume on pause_turn
// (the server-tool loop hit its iteration cap). Returns the final message plus usage summed
// across every request the call took.
async function research(prompt, { maxTokens = 64000, searchUses = 12, fetchUses = 12 } = {}) {
  let messages = [{ role: 'user', content: prompt }];
  const usage = { input: 0, output: 0, searches: 0, fetches: 0 };
  const pages = []; // { url, chars } per fetched page, for the log
  let msg;
  for (let i = 0; i < 8; i++) {
    const req = {
      model: MODEL,
      max_tokens: maxTokens,
      // Basic tool variants, as in refresh-events.mjs, so a paused turn resumes with a plain resend.
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: searchUses },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: fetchUses, max_content_tokens: FETCH_MAX_TOKENS },
      ].filter((t) => t.max_uses > 0), // the API rejects max_uses: 0
      messages,
    };
    // Thinking off for deterministic output, as in refresh-events.mjs. Sonnet 5 / Opus 5 /
    // Opus 4.6-4.8 accept the explicit flag; Haiku is off by default; the 5.5 and Fable models
    // reject it, so they run with their default.
    if (/^claude-(sonnet-5|opus-5|opus-4-[678]|sonnet-4-6)$/.test(MODEL)) req.thinking = { type: 'disabled' };
    msg = await (await anthropic()).messages.stream(req).finalMessage();
    usage.input += msg.usage?.input_tokens || 0;
    usage.output += msg.usage?.output_tokens || 0;
    usage.searches += msg.usage?.server_tool_use?.web_search_requests || 0;
    usage.fetches += msg.usage?.server_tool_use?.web_fetch_requests || 0;
    for (const b of msg.content || []) {
      const r = b.type === 'web_fetch_tool_result' && b.content?.type === 'web_fetch_result' ? b.content : null;
      if (r) pages.push({ url: r.url, chars: String(r.content?.source?.data || '').length });
    }
    if (msg.stop_reason === 'pause_turn') {
      messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: msg.content }];
      continue;
    }
    break;
  }
  return { msg, usage, pages };
}

function parseJSON(msg, open = '{', close = '}') {
  if (msg.stop_reason === 'refusal') throw new Error('model refused the request');
  let text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text.startsWith(open)) {
    const a = text.indexOf(open), b = text.lastIndexOf(close);
    if (a >= 0 && b > a) text = text.slice(a, b + 1);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`model did not return valid JSON (stop_reason=${msg.stop_reason}, len=${text.length}): ${e.message}`);
  }
}

const costOf = (u) => (u.input * PRICE.inPerM + u.output * PRICE.outPerM) / 1e6 + u.searches * PRICE.perSearch;

function groupPrompt(grp, sources, today, horizon) {
  const dayLabel = new Date(today + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const list = Object.entries(sources)
    .filter(([, s]) => s.group === grp)
    .map(([k, s]) => `- ${k}: ${s.name} — ${s.url || '(no calendar URL: web_search for it)'}${s.note ? ` [${s.note}]` : ''}`)
    .join('\n');
  return `Today is ${dayLabel} (${today}), America/New_York. Find events from today through ${horizon} for a local events guide to the Gowanus neighborhood of Brooklyn.

Area: within about a 20-minute walk of the Gowanus Canal: Gowanus, Park Slope (roughly west of 8th Ave), Carroll Gardens, Cobble Hill, Boerum Hill, the Columbia Street waterfront. Skip anything clearly elsewhere (Manhattan, Williamsburg, Bushwick, Crown Heights, Bed-Stuy). When unsure, include it with its address; the script measures the distance itself.

${GROUPS[grp].focus}

Sources to check first:
${list}

Rules:
- Ground every event in a page you actually fetched or a search result you saw. Never invent or guess an event, date, time, venue or price. If a calendar shows a month and day with no year, use the year that makes it upcoming; skip it if you can't tell.
- One entry per date. For a series, list each date the source shows, and set "recurring" only when the source states a cadence ("every Monday", "1st & 3rd Sun").
- Skip private events, cancelled or postponed events, and anything before today.
- "venue" and "address": the venue name and its street address or cross streets as the source gives them. Always include the address when it's shown; the script geocodes it.
- "source": the key from the list above where you found the event, or "web" for anything found by search.
- "url": the event's own page when there is one, else the listing page.
- "quality" (0-10, one decimal): how worth-it the event is on its own merits, ignoring distance and price. Use the full range: 9-10 standout or marquee (a major or legendary act, an acclaimed festival, a neighborhood event thousands attend); 7.5-8.5 genuinely good; 6-7 solid and worth going to (most established acts at real venues, a well-run street fair or community dinner); 5-6 ordinary (open mics, bar bands, routine meetups); below 5 weak or narrow (civic meetings, sales pitches). For music and comedy headliners you don't already know, web_search them before grading.
- "category": one of music, comedy, community, arts, nightlife, other. Use "community" for festivals, parades, street fairs, markets, community meals, clean-ups, canal and park events, family and volunteer events; "nightlife" for club and DJ nights and dance parties; "arts" for exhibitions, talks, readings, film and workshops.
- "act": the headliner's name for music or comedy; otherwise null.
- "price": "free", "$N" (the lowest listed price), or null if not shown. Never guess.
- Art exhibitions: one entry with "date" = opening day (or today if already open), "endDate" = closing day, "exhibition": true. Multi-day festivals: "date" = first day and "endDate" = last day.

Output ONLY a JSON object, with no prose and no code fence:
{"events":[{"title":"","date":"YYYY-MM-DD","time":"7:30 PM","endDate":null,"venue":"","address":"","category":"music","type":"Live music","act":null,"quality":7.2,"price":null,"url":"https://...","source":"pr","recurring":null,"recurringLabel":null,"series":null,"blurb":"One factual sentence from the source, or null","soldOut":false,"exhibition":false}],
 "sources":{"pr":{"status":"ok","note":"one short line: what was usable and what wasn't"}}}
"recurring" is one of "weekly", "2x-month", "monthly", or null. Report every listed source under "sources" with status "ok", "partial", "empty" (no upcoming events shown), "js" (the calendar didn't load), or "unreachable".`;
}

// ---------------------------------------------------------------------------
// Geocoding: curated names first, then the cache, then OpenStreetMap
// ---------------------------------------------------------------------------
function curatedKey(name, curated) {
  const n = norm(name);
  if (!n) return null;
  for (const [k, v] of Object.entries(curated)) if ((v.aliases || [norm(v.name)]).some((a) => n.includes(a))) return k;
  return null;
}
const inNYC = (p) => p && p.lat > NYC_BBOX.s && p.lat < NYC_BBOX.n && p.lon > NYC_BBOX.w && p.lon < NYC_BBOX.e;

// Area-level matches are worse than no match: "Brooklyn, NY" resolves to the borough's
// center (a 70-minute walk), and a bare street name to the middle of a road miles long.
const AREA_TYPES = new Set(['country', 'state', 'county', 'city', 'borough', 'town', 'village', 'city_district', 'suburb', 'neighbourhood', 'quarter', 'postcode', 'road']);
async function nominatim(q) {
  // Bounded to a box around the neighborhood: a same-named place in Queens is a wrong answer.
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&viewbox=-74.035,40.71,-73.94,40.625&bounded=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  await sleep(1100);
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit || AREA_TYPES.has(hit.addresstype)) return null;
  return { lat: +hit.lat, lon: +hit.lon };
}

// "7th Ave & 14th St" style addresses: find the node two named streets share.
const ORDINALS = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th', eleventh: '11th', twelfth: '12th' };
function streetName(s) {
  return s.trim().replace(/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/i, (w) => ORDINALS[w.toLowerCase()])
    .replace(/\bSt\b\.?$/i, 'Street').replace(/\bAve?\b\.?$/i, 'Avenue').replace(/\bPl\b\.?$/i, 'Place')
    .replace(/\bBlvd\b\.?$/i, 'Boulevard').replace(/\bPkwy\b\.?$/i, 'Parkway').replace(/\bRd\b\.?$/i, 'Road')
    .replace(/\s+/g, ' ');
}
async function intersection(address) {
  const m = /^([^,&]+?)\s+(?:&|and|at)\s+([^,]+?)(?:,|$)/i.exec(address || '')
    || /^([^,]+?),\s*(?:between\s+|from\s+)?([^,]+?)\s+(?:to|and)\s+[^,]+/i.exec(address || ''); // "5th Ave, Union St to 4th St"
  if (!m) return null;
  const a = streetName(m[1]).replace(/"/g, ''), b = streetName(m[2]).replace(/"/g, '');
  const bbox = '40.64,-74.03,40.70,-73.95';
  const q = `[out:json][timeout:25];way["name"="${a}"](${bbox})->.a;way["name"="${b}"](${bbox})->.b;node(w.a)(w.b);out 1;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const node = (await res.json()).elements?.[0];
  return node ? { lat: node.lat, lon: node.lon } : null;
}

// "In Gowanus" with no address is a place on the canal; the neighborhood is the canal corridor.
const GOWANUS_FALLBACK = { lat: 40.6779, lon: -73.9891 };

// Returns { p, transient }: transient is true when a lookup errored (HTTP 5xx, network), so the
// caller doesn't cache the miss for a week over a temporary outage.
async function geocode(name, address) {
  const tries = [];
  let transient = false;
  const hasStreet = /\d|\b(st|street|ave|avenue|pl|place|blvd|rd|road|park|pier)\b/i.test(address || '');
  if (address && hasStreet) tries.push(() => nominatim(/brooklyn|\bny\b|new york/i.test(address) ? address : `${address}, Brooklyn, NY`));
  if (address) tries.push(() => intersection(address));
  if (name) tries.push(() => nominatim(`${name}, Brooklyn, NY`));
  for (const t of tries) {
    try {
      const p = await t();
      if (inNYC(p)) return { p, transient: false };
    } catch (e) {
      transient = true;
      console.log(`Geocode: ${e.message} for "${name}" / "${address}"`);
    }
  }
  if (/gowanus/i.test(`${name} ${address}`)) return { p: GOWANUS_FALLBACK, transient: false };
  return { p: null, transient };
}

const slug = (s) => norm(s).replace(/ /g, '-').slice(0, 40) || 'venue';

// Resolves each {venue, address} to a venue key. Mutates `cache`; returns geocode stats.
async function resolveVenues(items, cache, curated, today) {
  const keys = new Map(), stats = { curated: 0, cached: 0, geocoded: 0, missed: 0, skipped: 0 };
  const taken = new Set([...Object.keys(curated), ...Object.values(cache).filter((c) => c.key).map((c) => c.key)]);
  let lookups = 0;
  for (const { venue, address } of items) {
    const id = norm(venue) + '|' + norm(address);
    if (keys.has(id)) continue;
    const ck = curatedKey(venue, curated);
    if (ck) { keys.set(id, ck); stats.curated++; continue; }
    const hit = cache[id];
    if (hit?.key) { keys.set(id, hit.key); stats.cached++; continue; }
    if (hit?.miss && hit.miss > addDays(today, -MISS_RETRY_DAYS)) { keys.set(id, null); stats.missed++; continue; }
    if (lookups >= MAX_GEOCODES) { keys.set(id, null); stats.skipped++; continue; }
    lookups++;
    const { p, transient } = await geocode(venue, address);
    if (!p) { if (!transient) cache[id] = { miss: today }; keys.set(id, null); stats.missed++; continue; }
    // Two names for one building (a venue and its room) share a key.
    const same = Object.values(cache).find((c) => c.key && Math.abs(c.lat - p.lat) < 0.0002 && Math.abs(c.lon - p.lon) < 0.0002 && norm(c.name) === norm(venue));
    let key = same?.key;
    if (!key) {
      key = slug(venue);
      for (let i = 2; taken.has(key); i++) key = `${slug(venue)}-${i}`;
      taken.add(key);
    }
    cache[id] = { key, name: venue, addr: address || '', lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) };
    keys.set(id, key);
    stats.geocoded++;
  }
  return { keys, stats };
}

// ---------------------------------------------------------------------------
// Normalizing model output into data.js events
// ---------------------------------------------------------------------------
const CADENCES = new Set(['weekly', '2x-month', 'monthly']);
const CATS = new Set(['music', 'comedy', 'community', 'arts', 'nightlife', 'other']);

// Returns { events, ongoing, rejected } for one group's model output.
function normalize(out, grp, sources, today, horizon) {
  const events = [], ongoing = [], rejected = [];
  for (const ev of Array.isArray(out?.events) ? out.events : []) {
    const title = String(ev?.title || '').trim();
    const d = String(ev?.date || '');
    if (!title || !isISODate(d)) { rejected.push(`${title || '(untitled)'}: bad date "${d}"`); continue; }
    if (d < today || d > horizon) { rejected.push(`${title}: ${d} outside ${today}..${horizon}`); continue; }
    if (!isURL(ev.url)) { rejected.push(`${title}: no source URL`); continue; }
    const src = sources[ev.source] && ev.source !== 'pin' ? ev.source : 'web';
    const end = isISODate(ev.endDate) && ev.endDate > d ? ev.endDate : null;
    const base = {
      venueName: String(ev.venue || '').trim(), address: String(ev.address || '').trim(),
      t: String(ev.time || '').trim(), title, type: String(ev.type || '').trim() || 'Event',
      cat: CATS.has(ev.category) ? ev.category : null, act: ev.act ? String(ev.act).trim() : null,
      fq: Math.max(0, Math.min(10, Number(ev.quality) || 0)),
      price: ev.price === 'free' || /^\$\d+/.test(ev.price || '') ? ev.price : null,
      url: ev.url, src, grp,
      cadence: CADENCES.has(ev.recurring) ? ev.recurring : null,
      cadenceLabel: CADENCES.has(ev.recurring) && ev.recurringLabel ? String(ev.recurringLabel) : null,
      series: ev.series ? String(ev.series) : null,
      blurb: ev.blurb ? String(ev.blurb).trim() : null,
      soldOut: ev.soldOut === true,
    };
    if (ev.exhibition === true && end) {
      ongoing.push({ ...base, start: d, end, when: base.t });
      // Its closing weekend competes in the feed like a one-off (the spec's "last chance" rule).
      if (end <= horizon) {
        const closing = addDays(end, -2) > today ? addDays(end, -2) : today;
        events.push({ ...base, d: closing, t: `Closes ${new Date(end + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`, title: `Last weekend: ${title}`, type: 'Exhibition', cat: 'arts' });
      }
      continue;
    }
    events.push({ ...base, d, end });
  }
  return { events, ongoing, rejected };
}

// ---------------------------------------------------------------------------
// Act research (the evidence behind the 8.6+ gate), as in refresh-events.mjs
// ---------------------------------------------------------------------------
async function researchActs(names) {
  const list = names.map((n) => `- ${n}`).join('\n');
  const prompt = `You are grading how strong a draw each of these acts or events is, for a neighborhood events guide in Gowanus, Brooklyn. For EACH entry, web_search it and look for concrete evidence: press coverage, notable venues and festivals played, chart or award history, audience size, how long it has run and how many people attend.

${list}

Grade each on quality 0-10 by what the research shows: 9-10 marquee (widely known, acclaimed, or a neighborhood event thousands attend); 7.5-8.5 genuinely notable; 6-7 solid working act or well-run local event; below 6 little evidence of draw. Set "confidence" to "high" only with multiple independent sources, "medium" with one good source, "low" when you found little. Include the URLs you actually used.

Output ONLY a JSON array, no prose:
[{"name":"exactly as listed","quality":8.8,"confidence":"high","basis":"one sentence citing the concrete evidence","sources":["https://..."]}]`;
  const { msg, usage } = await research(prompt, { maxTokens: 16000, searchUses: Math.min(30, names.length * 3), fetchUses: 0 });
  const arr = parseJSON(msg, '[', ']');
  if (!Array.isArray(arr)) throw new Error('research output is not an array');
  const records = {};
  for (const r of arr) {
    const key = norm(r?.name);
    if (!key || typeof r.quality !== 'number' || r.quality < 0 || r.quality > 10) continue;
    if (!['high', 'medium', 'low'].includes(r.confidence)) continue;
    const srcs = (Array.isArray(r.sources) ? r.sources : []).filter(isURL);
    if (!srcs.length) continue;
    records[key] = { fq: Math.round(r.quality * 10) / 10, confidence: r.confidence, basis: String(r.basis || '').trim(), sources: srcs, researchedAt: todayISO() };
  }
  return { records, usage };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const today = todayISO(), horizon = addDays(today, HORIZON_DAYS);
  const cfg = await pageContext();
  const SOURCES = vm.runInContext('SOURCES', cfg), CURATED = vm.runInContext('CURATED_VENUES', cfg);

  const prevJs = await readFile(DATA_PATH, 'utf8');
  const prev = vm.runInContext('DATA', await pageContext(prevJs));
  let cache = {};
  try { cache = JSON.parse(await readFile(VENUE_CACHE_PATH, 'utf8')); } catch { /* first run */ }
  let ratings = {};
  try { ratings = JSON.parse(await readFile(RESEARCH_PATH, 'utf8')); } catch { /* first run */ }

  // 1. One research call per group, in parallel.
  const grpNames = Object.keys(GROUPS);
  console.log(`Gowanus refresh ${today} → ${horizon}, model ${MODEL}, groups: ${grpNames.join(', ')}`);
  const results = await Promise.all(grpNames.map(async (grp) => {
    const t0 = Date.now();
    try {
      const { msg, usage, pages } = await research(groupPrompt(grp, SOURCES, today, horizon), GROUPS[grp]);
      const out = parseJSON(msg);
      console.log(`[${grp}] ${out.events?.length ?? 0} events in ${Math.round((Date.now() - t0) / 1000)}s · ${usage.input} in / ${usage.output} out tokens · ${usage.searches} searches, ${usage.fetches} fetches · ~$${costOf(usage).toFixed(2)}`);
      for (const pg of pages.sort((a, b) => b.chars - a.chars)) {
        console.log(`[${grp}]   fetched ${String(pg.chars).padStart(7)} chars${pg.chars >= FETCH_MAX_TOKENS * 3.5 ? ' (at cap, truncated)' : ''}  ${pg.url}`);
      }
      return { grp, ok: true, out, usage };
    } catch (e) {
      console.error(`[${grp}] FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${e.message}`);
      return { grp, ok: false, error: e.message, usage: { input: 0, output: 0, searches: 0, fetches: 0 } };
    }
  }));
  const okGroups = results.filter((r) => r.ok);
  if (okGroups.length < MIN_GROUPS_OK) {
    return fail(`only ${okGroups.length} of ${grpNames.length} source groups succeeded (${results.filter((r) => !r.ok).map((r) => `${r.grp}: ${r.error}`).join('; ')})`);
  }

  // 2. Normalize, and carry forward the previous run's events for any group that failed.
  let events = [], ongoing = [], rejected = 0;
  const sourceStatus = {};
  for (const r of results) {
    if (r.ok) {
      const n = normalize(r.out, r.grp, SOURCES, today, horizon);
      events.push(...n.events); ongoing.push(...n.ongoing); rejected += n.rejected.length;
      if (n.rejected.length) console.log(`[${r.grp}] rejected ${n.rejected.length}: ${n.rejected.slice(0, 5).join(' | ')}`);
      for (const [k, s] of Object.entries(r.out.sources || {})) {
        if (SOURCES[k]?.group === r.grp) sourceStatus[k] = { status: String(s?.status || 'ok'), note: String(s?.note || '') };
      }
    } else {
      const carried = (prev.raw || []).filter((e) => e.grp === r.grp && e.d >= today).map((e) => ({ ...e, carried: true }));
      events.push(...carried);
      ongoing.push(...(prev.ongoing || []).filter((o) => o.grp === r.grp && o.end >= today));
      for (const [k, s] of Object.entries(SOURCES)) {
        if (s.group === r.grp) sourceStatus[k] = { status: 'carried', note: `Today's check failed (${r.error.slice(0, 120)}); showing the previous run's listings.` };
      }
      console.log(`[${r.grp}] carried forward ${carried.length} event(s) from ${prev.snapshot}`);
    }
  }
  for (const k of Object.keys(SOURCES)) {
    if (SOURCES[k].group && !sourceStatus[k]) sourceStatus[k] = { status: 'empty', note: 'Not reported by the model.' };
  }
  for (const k of Object.keys(sourceStatus)) {
    sourceStatus[k].count = events.filter((e) => e.src === k).length;
  }

  // 3. Venues.
  const needVenue = [...events, ...ongoing].filter((e) => !e.v);
  const { keys, stats } = await resolveVenues(needVenue.map((e) => ({ venue: e.venueName, address: e.address })), cache, CURATED, today);
  for (const e of needVenue) {
    e.v = keys.get(norm(e.venueName) + '|' + norm(e.address)) || null;
  }
  console.log(`Venues: ${stats.curated} curated, ${stats.cached} cached, ${stats.geocoded} newly geocoded, ${stats.missed} unresolved, ${stats.skipped} over the per-run lookup cap.`);
  const usedKeys = new Set([...events, ...ongoing].map((e) => e.v).filter(Boolean));
  const venues = {};
  for (const c of Object.values(cache)) {
    if (c.key && usedKeys.has(c.key) && !CURATED[c.key]) venues[c.key] = { name: c.name, addr: c.addr, lat: c.lat, lon: c.lon };
  }
  // Keep only the fields the page needs.
  const slim = (e) => {
    const { address, ...rest } = e;
    if (rest.v) delete rest.venueName;
    for (const k of Object.keys(rest)) if (rest[k] === null || rest[k] === false || rest[k] === '') delete rest[k];
    return rest;
  };
  events = events.map(slim);
  ongoing = ongoing.map(slim).filter((o) => o.v);

  const usage = results.reduce((a, r) => ({ input: a.input + r.usage.input, output: a.output + r.usage.output, searches: a.searches + r.usage.searches, fetches: a.fetches + r.usage.fetches }), { input: 0, output: 0, searches: 0, fetches: 0 });
  const data = {
    generatedAt: new Date().toISOString(), snapshot: today, model: MODEL,
    groups: Object.fromEntries(results.map((r) => [r.grp, r.ok ? 'ok' : 'carried'])),
    groupUsage: Object.fromEntries(results.map((r) => [r.grp, { events: r.ok ? (r.out.events || []).length : 0, ...r.usage, costUSD: Math.round(costOf(r.usage) * 100) / 100 }])),
    fetchCap: FETCH_MAX_TOKENS,
    venues, sources: sourceStatus, research: ratings, ongoing, raw: events, usage: null,
  };

  // 4. Research acts that claim 8.6+ without evidence (non-fatal; the gate caps them otherwise).
  let added = 0;
  try {
    const check = await pageContext(renderData(data));
    const R = vm.runInContext(`runPipeline(${JSON.stringify(today)})`, check);
    const want = [...new Set(R.events.filter((e) => e.fq0 >= 8.6 && !e.research && e.src !== 'pin').map((e) => (e.act || e.title).trim()))];
    const batch = want.slice(0, MAX_RESEARCH_PER_RUN);
    if (batch.length) {
      console.log(`Act research: ${want.length} unresearched 8.6+ claim(s), researching ${batch.length}.`);
      const { records, usage: ru } = await researchActs(batch);
      for (const [k, rec] of Object.entries(records)) if (!ratings[k]) { ratings[k] = rec; added++; }
      for (const f of Object.keys(usage)) usage[f] += ru[f];
      console.log(`Act research: added ${added} record(s) (cache now ${Object.keys(ratings).length}) · ~$${costOf(ru).toFixed(2)}`);
    }
  } catch (e) {
    console.error(`Act research failed (non-fatal, claims stay capped): ${e.message}`);
  }
  data.research = ratings;
  data.usage = { ...usage, costUSD: Math.round(costOf(usage) * 100) / 100 };

  // 5. Pre-publish check: run the page's own pipeline over exactly what will be written.
  const js = renderData(data);
  const R = vm.runInContext(`runPipeline(${JSON.stringify(today)})`, await pageContext(js));
  const cats = {};
  for (const e of R.feed) cats[e.cat] = (cats[e.cat] || 0) + 1;
  console.log(`Pipeline: ${R.raw} raw → ${R.afterFilter} after filters → ${R.afterDedupe} after dedupe → ${R.feed.length} in the feed. ${R.dropped.length} dropped, ${R.merges.length} merged, ${R.gated.length} gated. By category: ${JSON.stringify(cats)}`);
  if (R.violations.length) return fail(`${R.violations.length} event(s) break the scoring invariant, e.g. "${R.violations[0].title}"`);
  if (R.feed.length < MIN_FEED) return fail(`only ${R.feed.length} events would be published (minimum ${MIN_FEED}); refusing to publish a thin guide`);

  const summary = `Gowanus events refresh (${today}): ${R.feed.length} events in the feed (${Object.entries(cats).map(([k, n]) => `${k} ${n}`).join(', ')}), ${rejected} rejected, groups ${Object.entries(data.groups).map(([g, s]) => `${g} ${s}`).join(' · ')}, +${added} researched, ~$${data.usage.costUSD}.`;
  if (DRY_RUN) { console.log('Dry run, nothing written. ' + summary); return; }
  await writeFile(DATA_PATH, js);
  await writeFile(VENUE_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  await writeFile(RESEARCH_PATH, JSON.stringify(ratings, null, 2) + '\n');
  console.log(summary);
  await notifySlack(summary);
}

export { normalize, resolveVenues, geocode, curatedKey, groupPrompt, pageContext, renderData };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e.stack || e.message));
}
