// Events refresh for candlewoodlakeevents.com  (v2 — web-tool research).
// Run by .github/workflows/daily-events.yml in two modes: the weekly research run (default,
// Thursdays — the only part that costs money) and a free daily `--maintain` pass that rolls the
// guide forward to today without an API call (see rollForward). Claude researches CURRENT events with
// the web_search + web_fetch server tools (so it can reach JS-rendered town/library/
// venue calendars that a plain fetch can't), then rewrites the EVENTS_DATA block in
// index.html between the EVENTS_DATA:START / EVENTS_DATA:END markers.
//
// Guardrails: Claude is told to ground every event in a real source and never invent.
// If the API errors or the model returns invalid JSON, it aborts WITHOUT writing, so
// a bad run never publishes.
//
// Env: ANTHROPIC_API_KEY (required), SLACK_WEBHOOK_URL (optional), EVENTS_MODEL (optional).

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const INDEX = 'index.html';
const START = '/* EVENTS_DATA:START';
const END = '/* EVENTS_DATA:END */';
const MODEL = process.env.EVENTS_MODEL || 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// Spend. Every API call goes through research(), which adds its usage here, so the run summary
// (console + Slack) says what the run actually cost. List prices per million tokens from the
// pricing page (checked 2026-10-27); web search is billed per search, web fetch only through the
// tokens it adds. A model missing from PRICES logs its tokens without a dollar figure.
// ---------------------------------------------------------------------------
const PRICES = {
  'claude-sonnet-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  // Haiku 5.5 is priced by prompt size; these are its over-100K rates, where this job's research
  // context sits for most of a run.
  'claude-haiku-5-5': { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
};
const PER_SEARCH = 0.01;
const spend = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, searches: 0, fetches: 0 };
function addUsage(u) {
  if (!u) return;
  spend.calls++;
  spend.input += u.input_tokens || 0;
  spend.cacheWrite += u.cache_creation_input_tokens || 0;
  spend.cacheRead += u.cache_read_input_tokens || 0;
  spend.output += u.output_tokens || 0;
  spend.searches += u.server_tool_use?.web_search_requests || 0;
  spend.fetches += u.server_tool_use?.web_fetch_requests || 0;
}
function spendLine() {
  if (!spend.calls) return '';
  const p = PRICES[MODEL];
  const cost = p && (spend.input * p.input + spend.cacheWrite * p.cacheWrite + spend.cacheRead * p.cacheRead + spend.output * p.output) / 1e6 + spend.searches * PER_SEARCH;
  const k = (n) => `${Math.round(n / 1000)}K`;
  return `${p ? '~$' + cost.toFixed(2) : 'cost unknown'} (${MODEL}: ${k(spend.input)} in, ${k(spend.cacheWrite)} cache write, `
    + `${k(spend.cacheRead)} cache read, ${k(spend.output)} out; ${spend.searches} searches, ${spend.fetches} fetches)`;
}

// Cap on each fetched page (web_fetch max_content_tokens; longer pages are truncated). Fetched
// calendars are the bulk of what the research loop re-reads; they list in date order, so a cut
// mostly drops dates past the 8-week window. Same cap as refresh-gowanus.mjs.
const FETCH_MAX_TOKENS = 25000;

// Priority calendars to fetch/search. (web_fetch can only fetch URLs present in the
// conversation, so listing them here lets the model pull them directly.)
const SOURCES = [
  ['New Fairfield', 'https://www.newfairfield.org/community/community-event-calendar'],
  ["Daryl's House", 'https://darylshouseclub.com/shows/'],
  ['Caramoor', 'https://caramoor.org/events/concerts'],
  ['Ridgefield Playhouse', 'https://ridgefieldplayhouse.org/events/'],
  ['Levitt Pavilion', 'https://levittpavilion.com/calendar/'],
  ['Sherman CT', 'https://www.shermanct.gov/municipal-calendar-list---community-events'],
  ['New Milford', 'https://www.newmilfordnow.org/events'],
  ['Housatonic River Brewing', 'https://www.housatonicriverbrewing.com/livemusic-events'],
  ['Litchfield', 'https://visitlitchfieldct.com/events/'],
  ['Litchfield Magazine', 'https://litchfieldmagazine.com/things-to-do/'],
  ['A.C.T. of Connecticut', 'https://www.actofct.org/season'],
  ['Palace Danbury', 'https://thepalacedanbury.com/'],
  ['Warner Theatre', 'https://www.warnertheatre.org/events/'],
  ['Danbury (town)', 'https://www.danbury-ct.gov/calendar.aspx'],
  ['Brookfield (town)', 'https://brookfieldct.gov/calendar'],
  ['New Milford Chamber', 'https://newmilford-chamber.com/events/'],
  ['Ridgefield Chamber', 'https://chamber.inridgefield.com/events/'],
  ['The Aldrich Museum', 'https://thealdrich.org/events'],
  ['Ridgefield Library', 'https://ridgefieldlibrary.librarymarket.com/events/upcoming'],
  ['New Milford Library', 'https://newmilford.libcal.com/'],
  ['Sherman Library', 'https://www.shermanlibrary.org/monthly-calendar'],
  // Big one-off festivals and ticketed conventions are usually absent from town and venue
  // calendars — they live on the organizer's site, on Eventbrite, or in the local paper.
  ['News-Times things to do', 'https://www.newstimes.com/things-to-do/'],
  ['Eventbrite (New Milford)', 'https://www.eventbrite.com/d/ct--new-milford/events/'],
  ['Eventbrite (Danbury area)', 'https://www.eventbrite.com/d/ct--danbury/events/'],
];

// Curation overrides: deterministic FunQuality floors for known-strong local acts the
// model tends to under-research (it defaults cover/tribute bands low regardless of
// their real draw). The daily model pass can't be trusted for specific bands, so we
// floor them here. Match = case-insensitive substring of the event title. Add names
// as Vik flags them. Values are FunQuality (0-10), not composite scores — proximity is
// applied once at the end, so the same floor means the same thing in every town.
const BAND_FLOORS = [
  ['the pop rocks', 8.4],   // packs Mohegan Sun Wolf Den; one of CT's most popular party bands
  ['nashville drive', 8.4], // CT's premier top-40 country band; iTunes-charting, opened for nationals
];

function bandFloorFor(e) {
  const title = (e.title || '').toLowerCase();
  for (const [name, floor] of BAND_FLOORS) if (title.includes(name)) return floor;
  return null;
}
function applyBandFloors(events) {
  for (const e of events || []) {
    const floor = bandFloorFor(e);
    if (floor !== null && typeof e.funQuality === 'number' && e.funQuality < floor) e.funQuality = floor;
  }
}

// Proximity by town (0-10). Single source of truth for the score formula:
// score = proximity*0.3 + funQuality*0.7.
const PROX = {
  'sherman': 10, 'new fairfield': 9.5, 'new milford': 9.5, 'brookfield': 8.5,
  'danbury': 8, 'ridgefield': 8, 'kent': 7.5, 'new preston': 7.5, 'washington': 7.5,
  'woodbury': 7.5, 'roxbury': 7.5, 'katonah': 7.5, 'pawling': 7.5, 'litchfield': 7,
  'torrington': 6.5, 'westport': 6.5,
};

// Towns beyond the ~25 mi lake radius. Events here are dropped entirely: the guide is
// lake-local, and a great act 30-50 min away shouldn't crowd out closer options. Matched
// against the event town (case-insensitive). Westport is a deliberate exception, kept for
// Levitt Pavilion's free outdoor concerts.
const EXCLUDE_TOWNS = /norfolk|hartford|woodbridge|new haven|waterbury|bridgeport|stamford|norwalk/i;
function isExcludedTown(e) {
  const t = (e && e.town) || '';
  if (/westport/i.test(t)) return false; // Levitt Pavilion exception
  return EXCLUDE_TOWNS.test(t);
}
function norm(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function proxOf(town) {
  const t = norm(town);
  for (const k of Object.keys(PROX)) if (t.includes(k)) return PROX[k];
  return 6.5; // default for out-of-area towns
}
const round1 = (x) => Math.round(x * 10) / 10;
const clampFq = (x) => Math.max(0, Math.min(10, x));

// ---------------------------------------------------------------------------
// SCORING INVARIANT: score = proxOf(town)*0.3 + funQuality*0.7, and NOTHING else
// ever writes `score`. Every stage below adjusts `funQuality` (0-10) only; bakeScores()
// applies the formula exactly once, at the end. That is what keeps a score inside its
// town's ceiling: a 10.0 requires both proximity 10 (Sherman) and a perfect 10 quality.
//
// The old pipeline mutated the composite `score` directly and each stage had to
// reverse-engineer quality back out of it, so additive boosts could push a score past
// its ceiling and clamp at 10 — which is how 8 unrelated events all tied at exactly
// 10.0, including a New Fairfield town fair whose true ceiling is 9.85.
// ---------------------------------------------------------------------------

// Normalize incoming events onto the single quality field the pipeline mutates.
// Prefers an explicit funQuality (what the model is now asked for); falls back to
// backing quality out of a composite `score` (legacy blocks, carried events, and any
// run where the model regresses to emitting score). Events carrying neither are left
// untouched — they simply never get a score, exactly as before.
function ingestFq(events) {
  for (const e of events || []) {
    if (typeof e.funQuality === 'number') { e.funQuality = clampFq(e.funQuality); continue; }
    if (typeof e.score === 'number') e.funQuality = clampFq((e.score - proxOf(e.town) * 0.3) / 0.7);
  }
}

// Publish step: apply the formula once, after every quality adjustment has run.
function bakeScores(events) {
  for (const e of events || []) {
    if (typeof e.funQuality !== 'number') continue;
    e.funQuality = round1(clampFq(e.funQuality));
    e.score = round1(proxOf(e.town) * 0.3 + e.funQuality * 0.7);
  }
}

// Match an event to a researched act in band-ratings.json (keyed by normalized act name).
// Longest key wins so specific names beat generic ones.
function ratingKeys(ratings) {
  return Object.keys(ratings).filter((k) => k.length >= 4).sort((a, b) => b.length - a.length);
}
function ratingFor(e, ratings, keys = ratingKeys(ratings)) {
  const nt = norm(e.title);
  const hit = keys.find((k) => nt.includes(k));
  return hit ? ratings[hit] : null;
}

// Deterministic researched-quality override: for any event whose title contains a
// researched act, replace the model's per-run genre guess with the researched funQuality.
// Unmatched acts keep the model's quality (and then face the evidence gate below).
function applyResearchedScores(events, ratings) {
  const keys = ratingKeys(ratings);
  for (const e of events || []) {
    if (typeof e.funQuality !== 'number') continue;
    const rec = ratingFor(e, ratings, keys);
    if (rec && typeof rec.funQuality === 'number') e.funQuality = clampFq(rec.funQuality);
  }
}

// Evidence gate. A 9.0+ FunQuality is a claim that an event is marquee — a major touring
// act or an acclaimed festival. The model makes that claim far too freely for acts it has
// not actually researched (it has rated $10 bar cover bands 9.9), so a claim that high must
// be backed by a band-ratings.json entry with real sources. Everything else caps at 8.5,
// which still reads as "genuinely good" but leaves the top of the guide to evidence.
//
// This runs LAST, after the floors and the value adjustment, so nothing can sneak over the
// line via a boost: a free event the model put at 8.8 would otherwise land at 9.4 with no
// research behind it. A hand-set BAND_FLOORS entry counts as evidence — those are curated
// by hand with a documented rationale, which is the whole point of the list.
const EVIDENCE_MIN = 9.0;      // quality at or above this requires a researched entry
const EVIDENCE_CAP = 8.5;      // where unevidenced claims land instead
const MAX_VALUE_BOOST = 0.6;   // largest lift valueAdj can add; see collectResearchCandidates
function hasEvidence(rec) {
  return !!rec
    && typeof rec.funQuality === 'number'
    && Array.isArray(rec.sources) && rec.sources.length > 0
    && rec.confidence !== 'low';
}
function applyEvidenceGate(events, ratings) {
  const keys = ratingKeys(ratings);
  let capped = 0;
  for (const e of events || []) {
    if (typeof e.funQuality !== 'number' || e.funQuality < EVIDENCE_MIN) continue;
    if (bandFloorFor(e) !== null) continue;                    // hand-curated = evidence
    if (hasEvidence(ratingFor(e, ratings, keys))) continue;
    e.funQuality = EVIDENCE_CAP;
    capped++;
  }
  return capped;
}

// Quality curve: the model (and cache) cluster most FunQuality in 7-9, which flattens
// scores. This deterministically stretches the quality dimension toward the full range
// (gamma>1 pulls the middle down, keeps the top) so standouts separate from filler.
// Applied to every event after research overrides, before Vik's floors.
const GAMMA = 1.0; // curve disabled (identity): the full-range prompt now provides the spread;
                   // stacking the curve on top was double-punishing and cratered good events.
function applyQualityCurve(events) {
  if (GAMMA === 1.0) return;
  for (const e of events || []) {
    if (typeof e.funQuality !== 'number') continue;
    e.funQuality = 10 * Math.pow(clampFq(e.funQuality) / 10, GAMMA);
  }
}

const todayLabel = new Date().toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
});
// Current year/month in ET, for the date-sanity guard.
const _nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const CURRENT_YEAR = _nowET.getFullYear();
const CURRENT_MONTH = _nowET.getMonth();

// Drop events whose stated weekday doesn't match the real weekday of that calendar
// date this year (catches wrong/guessed/stale dates). Only checks entries that carry
// a "Weekday Mon DD" dateLabel; leaves ambiguous ones alone.
const _WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const _MO = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function badWeekday(e) {
  const m = /\b(sun|mon|tue|wed|thu|fri|sat)\w*[\s,]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/i.exec(e.dateLabel || '');
  if (!m) return false;
  const mo = _MO[m[2].slice(0, 3).toLowerCase()];
  const day = parseInt(m[3], 10);
  const yr = mo < CURRENT_MONTH ? CURRENT_YEAR + 1 : CURRENT_YEAR; // handle year rollover
  const actual = new Date(yr, mo, day).getDay();
  return _WD.indexOf(m[1].slice(0, 3).toLowerCase()) !== actual;
}

// Recurring community series whose current-year dates aren't reliably published online,
// so the model tends to reuse a prior-year date. Omit until a real date is confirmed
// (a weekday-consistent stale date can't be caught automatically). Remove a pattern here
// once the town posts the confirmed current-year schedule.
const SUPPRESS_TITLES = [
  /rock the block/i,
];
function suppressed(e) { return SUPPRESS_TITLES.some(re => re.test(e.title || '')); }

function parseMD(label) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/i.exec(label || '');
  if (!m) return null;
  const mo = _MO[m[1].slice(0, 3).toLowerCase()];
  const yr = mo < CURRENT_MONTH ? CURRENT_YEAR + 1 : CURRENT_YEAR;
  return new Date(yr, mo, parseInt(m[2], 10));
}

// Hand-confirmed events the model gets wrong (e.g. recurring series it dates from a prior
// year). Injected into the correct week by date after scoring. SUPPRESS_TITLES catches the
// model's own wrong copy so these are the only version shown. Dates verified against sources.
const PINNED_EVENTS = [
  { score: 8.7, funQuality: 8.4, title: "New Milford Rock the Block — Nashville Drive", url: "https://www.newmilfordnow.org/stories/rock-the-block-to-transform-bank-street", dateLabel: "Thu Jul 16", time: "6:30PM", venue: "Bank Street", venueType: "", town: "New Milford, CT", dist: "~10 mi", type: "Free Block Party / Live Music", priceType: "free", priceLabel: "Free", desc: "Free downtown block party on Bank Street with country cover band Nashville Drive, street games, local eats, and sidewalk sales.", source: "newmilfordnow.org", sourceUrl: "https://www.newmilfordnow.org/stories/rock-the-block-to-transform-bank-street", isTonight: false, isPast: false, isNF: false },
  { score: 8.7, funQuality: 8.4, title: "New Milford Rock the Block — The Pop Rocks", url: "https://www.newmilfordnow.org/stories/rock-the-block-to-transform-bank-street", dateLabel: "Thu Aug 13", time: "6:30PM", venue: "Bank Street", venueType: "", town: "New Milford, CT", dist: "~10 mi", type: "Free Block Party / Live Music", priceType: "free", priceLabel: "Free", desc: "Free downtown block party on Bank Street with Connecticut 80s favorites The Pop Rocks, plus street games, local eats, and sidewalk sales.", source: "newmilfordnow.org", sourceUrl: "https://www.newmilfordnow.org/stories/rock-the-block-to-transform-bank-street", isTonight: false, isPast: false, isNF: false },
  // Gilmore Girls fan convention. The model misses this every run: it is on no town or
  // venue calendar (private convention, organizer site + Eventbrite only) and is
  // deliberately NOT branded "Gilmore Girls" for licensing, so a town search skips it.
  { score: 9.2, funQuality: 9.0, title: "A Weekend in the Life — Gilmore Girls Fan Convention", url: "https://smalltownconvention.com/", dateLabel: "Fri Sep 4 – Sun Sep 6", time: "12PM–10PM", venue: "Downtown New Milford (multiple venues)", venueType: "", town: "New Milford, CT", dist: "~7 mi", type: "Fan Convention / Festival", priceType: "paid", priceLabel: "Ticketed", desc: "Decade Days brings its Gilmore Girls-inspired convention back to New Milford, the town behind Stars Hollow, with cast guests Sean Gunn and Scott Patterson, panels, photo ops, and a vendor marketplace. Ticketed through Eventbrite; much of Friday's downtown programming is open to the public.", source: "smalltownconvention.com", sourceUrl: "https://smalltownconvention.com/", isTonight: false, isPast: false, isNF: false },
];

// A week's declared date span, parsed from its title (e.g. "July 27 – August 2",
// "August 10–16"); falls back to its events' date range.
function weekRange(w) {
  const m = /([a-z]+)\s+(\d{1,2})\s*[–-]\s*(?:([a-z]+)\s+)?(\d{1,2})/i.exec(w.title || '');
  const mo1 = m && _MO[m[1].slice(0, 3).toLowerCase()];
  if (m && mo1 != null) {
    const mo2 = m[3] ? _MO[m[3].slice(0, 3).toLowerCase()] : mo1;
    const y1 = mo1 < CURRENT_MONTH ? CURRENT_YEAR + 1 : CURRENT_YEAR;
    const y2 = mo2 < CURRENT_MONTH ? CURRENT_YEAR + 1 : CURRENT_YEAR;
    return { min: new Date(y1, mo1, +m[2]).getTime(), max: new Date(y2, mo2, +m[4]).getTime() };
  }
  const ds = w.events.map(e => parseMD(e.dateLabel)).filter(Boolean).map(d => d.getTime());
  return ds.length ? { min: Math.min(...ds), max: Math.max(...ds) } : null;
}

// Deterministic sanity floor. The model's per-event quality is volatile (it has cratered a
// jazz festival to 2.3 while scoring the same festival's other night 8.6). If an event made
// the curated guide it is at least decent, and a real live-music/festival event is at least
// good — this bounds the model's worst misses without flattening the top. Real local
// community events (carnivals, fairs, fireworks, parades) get a higher quality floor so a
// hometown happening surfaces instead of sitting at the bottom. Returns FunQuality (0-10);
// proximity is applied later by bakeScores.
function fqFloor(e) {
  const t = (e.type || '').toLowerCase();
  if (/carnival|fair|fireworks|parade|festival|block party|street fair/.test(t)) return 7.0;   // marquee local community event
  if (/market|craft|community/.test(t)) return 6.0;                                            // routine community event
  if (/music|concert|band|jazz|live|singer|songwriter|orchestra|symphon|quartet|tribute|\bdj\b|blues|folk|funk|soul|country|reggae|rock|pops|cappella|choir/.test(t)) return 5.5;
  return 4.5;
}
function applyFqFloor(events) {
  for (const e of events || []) {
    if (typeof e.funQuality === 'number') e.funQuality = Math.max(e.funQuality, fqFloor(e));
  }
}

// Value/cost adjustment: for the same quality, a free or lower-cost event is a better pick
// than a pricey one. Free gets a boost; cheap a small bump; expensive (e.g. $100+ tickets) a
// trim. Parses priceType/priceLabel. Expressed in FunQuality points (not composite points),
// matching personalScore() in index.html, so it lands weighted at 0.7 and can never push an
// event past its town ceiling.
function valueAdj(e) {
  const label = e.priceLabel || '';
  if ((e.priceType || '').toLowerCase() === 'free' || /free/i.test(label + ' ' + (e.type || ''))) return 0.6;
  const m = /\$(\d+)/.exec(label);
  if (!m) return 0;                 // unknown price -> neutral
  const d = parseInt(m[1], 10);
  if (d <= 20) return 0.2;          // e.g. $15 brewery show
  if (d <= 50) return 0;
  if (d <= 90) return -0.4;
  return -0.8;                      // e.g. $106 Daryl's ticket
}
function applyValueAdj(events) {
  for (const e of events || []) {
    if (typeof e.funQuality === 'number') e.funQuality = clampFq(e.funQuality + valueAdj(e));
  }
}

// Regression guard for the scoring invariant. Every published score must sit inside its
// town's ceiling (proximity*0.3 + 10*0.7) — a violation means a stage wrote `score`
// directly or bypassed bakeScores, so the run aborts rather than publishing it.
const SCORE_EPS = 0.051; // one rounding step of slack
function scoreViolations(obj) {
  const bad = [];
  const check = (e) => {
    if (typeof e.score !== 'number') return;
    const ceiling = proxOf(e.town) * 0.3 + 10 * 0.7;
    if (e.score > ceiling + SCORE_EPS || e.score < 0) {
      bad.push(`"${e.title}" (${e.town || 'no town'}): ${e.score} exceeds ceiling ${round1(ceiling)}`);
    }
  };
  for (const w of obj.weeks || []) for (const e of w.events || []) check(e);
  for (const k of ['tonight', 'past']) for (const e of obj[k] || []) check(e);
  return bad;
}

// Inherently free-admission community events (town carnivals, fireworks, parades, block
// parties, street fairs) have no gate fee unless a ticket price is listed. Normalize so they
// read "Free" and get the free-value boost, instead of a stray "paid" tag from the source.
// Match on event TYPE/title keywords only, not org names (Lions/fire-dept also run ticketed
// galas and balls, which must stay paid).
function normalizeCommunityFree(events) {
  const freeType = /carnival|fireworks|parade|block party|street fair/i;
  for (const e of events || []) {
    const hasPrice = /\$\d/.test(e.priceLabel || '');
    if (!hasPrice && (e.priceType || '') !== 'free' && freeType.test((e.type || '') + ' ' + (e.title || ''))) {
      e.priceType = 'free';
      e.priceLabel = 'Free';
    }
  }
}

function injectPinned(obj) {
  const ranges = obj.weeks.map(w => { const r = weekRange(w); return r ? { w, ...r } : null; }).filter(Boolean);
  if (!ranges.length) return;
  const gMin = Math.min(...ranges.map(r => r.min)), gMax = Math.max(...ranges.map(r => r.max));
  for (const p of PINNED_EVENTS) {
    const pd = parseMD(p.dateLabel);
    if (!pd) continue;
    const t = pd.getTime();
    if (t < gMin || t > gMax) continue;                                   // outside current window — appears as it advances
    if (obj.weeks.some(w => w.events.some(e => e.title === p.title))) continue;
    const hit = ranges.find(r => t >= r.min && t <= r.max);
    if (hit) hit.w.events.push(p);
  }
}

async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch { /* non-fatal */ }
}

async function fail(msg) {
  const cost = spendLine();
  console.error('refresh-events: ' + msg + (cost ? ` | spent ${cost}` : ''));
  await notifySlack(`Events refresh FAILED (${todayLabel}): ${msg}${cost ? ` (spent ${cost})` : ''}`);
  process.exit(1);
}

// Created on first use, so `--site-only` runs without the SDK installed or an API key set.
let _client = null;
async function anthropic() {
  if (!_client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _client = new Anthropic({ maxRetries: 5 }); // reads ANTHROPIC_API_KEY; retry 429/5xx/overloaded
  }
  return _client;
}

// Stream (avoids connection timeouts on long web-tool research) and resume on
// pause_turn (server-tool loop hit its iteration cap). Returns the final message.
// Parse the LAST calendar date in a dateLabel ("Fri Jul 18 – Sun Jul 20" -> Jul 20).
function parseEndDate(e) {
  const M = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/gi;
  const found = []; let m;
  while ((m = re.exec(e.dateLabel || ''))) found.push([M[m[1].toLowerCase()], parseInt(m[2], 10)]);
  if (!found.length) return null;
  const [mo, day] = found[found.length - 1];
  const yr = mo < CURRENT_MONTH ? CURRENT_YEAR + 1 : CURRENT_YEAR;
  return new Date(yr, mo, day);
}

// Keep events one extra day: carry any event from the PREVIOUS data whose end date was
// yesterday back into this run (flagged isPast) so "yesterday's events" stay visible today.
// Bounded to a single day, so nothing older accumulates.
function carryYesterday(obj, existingBlock) {
  let prior;
  try { prior = JSON.parse(existingBlock.slice(existingBlock.indexOf('{'), existingBlock.lastIndexOf('}') + 1)); }
  catch { return 0; }
  if (!prior || !Array.isArray(prior.weeks)) return 0;
  const yTs = new Date(_nowET.getFullYear(), _nowET.getMonth(), _nowET.getDate() - 1).getTime();
  const key = (e) => (e.title || '').toLowerCase().trim();
  const have = new Set();
  for (const w of obj.weeks) for (const e of w.events) have.add(key(e));
  const carried = [];
  const scan = (arr) => {
    for (const e of arr || []) {
      const d = parseEndDate(e);
      if (!d) continue;
      if (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() === yTs && !have.has(key(e))) {
        carried.push({ ...e, isPast: true });
        have.add(key(e));
      }
    }
  };
  for (const w of prior.weeks) scan(w.events);
  scan(prior.tonight);
  if (carried.length && obj.weeks[0]) obj.weeks[0].events.push(...carried);
  return carried.length;
}

// ---------------------------------------------------------------------------
// Roll the guide forward to today. Research runs weekly because it is the expensive part; this
// runs every day for free, so the page never lists a finished event as upcoming or tells Google
// about one. Every event is re-bucketed by its own date (Week 1 is today through Sunday, then
// Monday–Sunday weeks), yesterday's events stay one more day tagged Past, older ones are
// dropped, and isTonight / tonight[] are rebuilt. Same data on the same day gives the same output.
// An event whose date can't be parsed keeps its current week slot and flags.
// ---------------------------------------------------------------------------
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86400000;
function rangeLabel(a, b) {
  const ma = MONTH_NAMES[a.getUTCMonth()], mb = MONTH_NAMES[b.getUTCMonth()];
  if (a.getTime() === b.getTime()) return `${ma} ${a.getUTCDate()}`;
  return ma === mb ? `${ma} ${a.getUTCDate()}–${b.getUTCDate()}` : `${ma} ${a.getUTCDate()} – ${mb} ${b.getUTCDate()}`;
}
function rollForward(obj) {
  const ym = dataYearMonth(obj.lastUpdated);
  const today = new Date(Date.UTC(_nowET.getFullYear(), _nowET.getMonth(), _nowET.getDate()));
  const yesterday = new Date(today.getTime() - DAY_MS);
  const week1End = new Date(today.getTime() + ((7 - today.getUTCDay()) % 7) * DAY_MS); // the coming Sunday
  const slotOf = (d) => (d <= week1End ? 0 : 1 + Math.floor((d - week1End - DAY_MS) / (7 * DAY_MS)));

  const buckets = [];
  let dropped = 0;
  (obj.weeks || []).forEach((w, wi) => {
    for (const e of w.events || []) {
      const sch = eventSchedule(e, ym);
      let slot = wi;
      if (sch) {
        if (sch.end < yesterday) { dropped++; continue; }
        e.isPast = sch.end < today;
        e.isTonight = !e.isPast && sch.start <= today;
        slot = slotOf(sch.start > today ? sch.start : today);
      }
      (buckets[slot] = buckets[slot] || []).push(e);
    }
  });
  obj.weeks = Array.from({ length: Math.max(8, buckets.length) }, (_, i) => {
    const start = i === 0 ? today : new Date(week1End.getTime() + (1 + 7 * (i - 1)) * DAY_MS);
    const end = i === 0 ? week1End : new Date(start.getTime() + 6 * DAY_MS);
    return { id: `week${i + 1}`, title: `Week ${i + 1} · ${rangeLabel(start, end)}`, open: i === 0, events: buckets[i] || [] };
  });
  // The banner needs a real name, venue and time for each show ("See website" placeholders don't count).
  const real = (v) => !!v && !/see website/i.test(v);
  obj.tonight = obj.weeks[0].events
    .filter((e) => e.isTonight && real(e.title) && real(e.venue) && real(e.time))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)
    .map((e) => ({ name: e.title, venue: e.venue, time: e.time, price: e.priceType === 'free' ? 'Free' : real(e.priceLabel) ? e.priceLabel : '' }));
  const past = obj.weeks[0].events.filter((e) => e.isPast).length;
  const upcoming = obj.weeks.reduce((n, w) => n + w.events.filter((e) => !e.isPast).length, 0);
  return { dropped, past, upcoming };
}

async function research(prompt, opts = {}) {
  const { maxTokens = 48000, searchUses = 40, fetchUses = 20 } = opts;
  let messages = [{ role: 'user', content: prompt }];
  let msg;
  for (let i = 0; i < 8; i++) {
    const req = {
      model: MODEL,
      max_tokens: maxTokens, // headroom for the full events JSON (more sources = more events)
      // Basic tool variants (no code-execution dynamic filtering) so paused turns
      // resume with a plain resend — no container_id juggling.
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: searchUses },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: fetchUses, max_content_tokens: FETCH_MAX_TOKENS },
      ],
      // Prompt caching is the main cost lever here. Each step of the server-side search loop
      // re-reads everything gathered so far; with caching on, the server writes a cache entry
      // after every tool result, so those re-reads bill at the cache-read rate (a tenth of base
      // input) instead of in full. The pause_turn resend below reuses the same prefix and hits it too.
      cache_control: { type: 'ephemeral' },
      messages,
    };
    // Keep thinking OFF for deterministic output. Models 4.6+ (Sonnet 5, Opus) need the
    // explicit disabled flag — omitting it turns adaptive thinking ON. Haiku 4.5 and older
    // don't accept the flag; they're thinking-off by default, so we just omit it.
    if (!/haiku/i.test(MODEL)) req.thinking = { type: 'disabled' };
    const stream = (await anthropic()).messages.stream(req);
    msg = await stream.finalMessage();
    addUsage(msg.usage);
    if (msg.stop_reason === 'pause_turn') {
      messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: msg.content }];
      continue;
    }
    break;
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Act research pass. band-ratings.json is the evidence store behind the gate above.
// It started as a one-off backfill and went stale the moment it was written, so every
// act outside it fell back to the model's per-run guess — which is what produced 9.9s
// for $10 bar bands. This pass makes the cache self-maintaining: each run researches
// only the acts making an unevidenced 9.0+ claim, then writes them back, so the same
// lookup is never paid for twice and the cache grows exactly where scoring needs it.
//
// It runs AFTER the events JSON is parsed, as a separate call. A failure here is
// non-fatal: the events still publish, and the gate simply caps the unresearched
// claims. Nothing on the critical path depends on it.
// ---------------------------------------------------------------------------
const RATINGS_PATH = 'scripts/band-ratings.json';
const MAX_RESEARCH_PER_RUN = 20; // bounds cost/latency; the backlog drains over a few days
const TIERS = new Set(['national-headliner', 'regional-established', 'popular-local-or-tribute', 'local-modest', 'non-music']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);
const todayISO = `${CURRENT_YEAR}-${String(CURRENT_MONTH + 1).padStart(2, '0')}-${String(_nowET.getDate()).padStart(2, '0')}`;

// Events that could end up making an unevidenced 9.0+ claim — the set the gate would cap.
// The threshold sits one value-boost below EVIDENCE_MIN because the gate runs after
// applyValueAdj: an unresearched free event at 8.5 becomes 9.1 and would be capped. If we
// only researched events already at 9.0+, those would be capped every run and never enter
// the cache, so the system would never converge.
function collectResearchCandidates(obj, ratings) {
  const keys = ratingKeys(ratings);
  const threshold = EVIDENCE_MIN - MAX_VALUE_BOOST;
  const seen = new Set();
  const out = [];
  const scan = (events) => {
    for (const e of events || []) {
      if (typeof e.funQuality !== 'number' || e.funQuality < threshold) continue;
      if (bandFloorFor(e) !== null) continue;   // already evidenced by hand
      if (ratingFor(e, ratings, keys)) continue;
      const k = norm(e.title);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ title: e.title, type: e.type || '', venue: e.venue || '', town: e.town || '' });
    }
  };
  for (const w of obj.weeks || []) scan(w.events);
  scan(obj.tonight);
  return out;
}

function validRecord(r) {
  return !!r
    && typeof r.displayName === 'string' && r.displayName.trim().length > 1
    && typeof r.funQuality === 'number' && r.funQuality >= 0 && r.funQuality <= 10
    && typeof r.draw === 'string' && r.draw.trim().length > 20
    && TIERS.has(r.tier) && CONFIDENCES.has(r.confidence)
    && typeof r.isMusicAct === 'boolean'
    && Array.isArray(r.sources) && r.sources.length > 0
    && r.sources.every((s) => typeof s === 'string' && /^https?:\/\//.test(s));
}

// Research the candidates and return validated records keyed by normalized act name.
async function researchActs(candidates) {
  const list = candidates.map((c, i) => `${i + 1}. "${c.title}" — ${c.type} at ${c.venue}, ${c.town}`).join('\n');
  const prompt = `You are grading how much of a DRAW each of these live acts / events genuinely has, for a curated local events guide in the Candlewood Lake area of Connecticut. Today is ${todayLabel}.

For EACH entry below, identify the actual performing act (or, for a non-music event, the event itself) and web_search it before grading. Look for concrete evidence of draw: social following counts, notable venues played (Mohegan Sun / Foxwoods, casino showrooms, theaters, major festivals), national acts they have opened for, chart or press mentions, awards, attendance figures.

ENTRIES:
${list}

Grade each on funQuality 0-10 by what the research actually shows:
- 9-10: national touring headliner, GRAMMY/charting/critically acclaimed artist, or a genuinely major regional festival (large documented attendance, regional press).
- 7.5-8.5: established regional act, or a popular tribute/cover band with a real following (thousands of fans, plays casinos/theaters/large festivals), or a well-established town festival.
- 6-7.5: genuine local bar/pickup band, small community event, or an act with little public profile.
- Below 6: little or no draw, very niche.

Be honest and evidence-driven. Most local bar bands are 6-7.5, and that is the correct answer — do NOT inflate an act to 9+ because it sounds impressive or because the venue is nice. Reserve 9+ for acts where you found real evidence of national or major-regional stature. If you cannot find meaningful evidence for an act, grade it in the 6-7.5 band and set confidence to "low".

Return ONLY a pure JSON array (no prose, no code fences), one object per entry:
[{"displayName":"Act Name","funQuality":7.2,"tier":"local-modest","isMusicAct":true,"draw":"one or two sentences citing the concrete evidence you found","confidence":"high","sources":["https://..."],"exampleTitle":"the entry title this came from"}]

tier must be one of: national-headliner, regional-established, popular-local-or-tribute, local-modest, non-music.
confidence must be one of: high, medium, low.
sources must be real URLs you actually consulted (at least one). Omit any entry you could not research at all rather than inventing sources.`;

  // ~2 searches per act in a full batch, plus headroom for a follow-up on ambiguous names.
  const data = await research(prompt, { maxTokens: 16000, searchUses: 50, fetchUses: 5 });
  if (data.stop_reason === 'refusal') throw new Error('model refused the act-research request');
  let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text.startsWith('[')) {
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    if (a >= 0 && b > a) text = text.slice(a, b + 1);
  }
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('act research did not return a JSON array');

  const records = {};
  let rejected = 0;
  for (const r of arr) {
    if (!validRecord(r)) { rejected++; continue; }
    const key = norm(r.displayName);
    if (key.length < 4) { rejected++; continue; }
    records[key] = {
      displayName: r.displayName.trim(),
      funQuality: round1(clampFq(r.funQuality)),
      tier: r.tier,
      isMusicAct: r.isMusicAct,
      draw: r.draw.trim(),
      confidence: r.confidence,
      sources: r.sources.slice(0, 4),
      exampleTitle: typeof r.exampleTitle === 'string' ? r.exampleTitle : '',
      researchedAt: todayISO, // stamped here, not by the model
    };
  }
  if (rejected) console.log(`Act research: rejected ${rejected} malformed/unsourced record(s).`);
  return records;
}

// Merge new records in without touching existing ones — previously researched entries
// (and any Vik has hand-tuned) win over a fresh guess.
function mergeRatings(ratings, records) {
  let added = 0;
  for (const [k, v] of Object.entries(records)) {
    if (ratings[k]) continue;
    ratings[k] = v;
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// SITE GENERATION — search/social surface built from the final EVENTS_DATA:
//   * schema.org Event JSON-LD in index.html <head> (EVENTS_JSONLD markers), so events are
//     eligible for Google's event results instead of living only inside a JS object;
//   * one crawlable, server-rendered page per core town at /towns/<slug>/ ("things to do in
//     New Milford" can't rank off a single URL), linked from index.html (TOWN_NAV markers);
//   * sitemap.xml listing the home page and every town page.
// Everything is built in memory and validated BEFORE any file is written, so a generation
// bug fails the run instead of publishing a half-written site. The town list is fixed (the
// PROX towns) so URLs stay stable for search engines — a town with nothing on renders an
// empty-state page rather than disappearing. Run `node scripts/refresh-events.mjs --site-only`
// to rebuild these from the current data without calling the API.
// ---------------------------------------------------------------------------
const SITE = 'https://candlewoodlakeevents.com';
const OG_IMAGE = `${SITE}/og-image.png`;
const JSONLD_START = '<!-- EVENTS_JSONLD:START';
const JSONLD_END = '<!-- EVENTS_JSONLD:END -->';
const TOWNNAV_START = '<!-- TOWN_NAV:START';
const TOWNNAV_END = '<!-- TOWN_NAV:END -->';
const TOWN_PAGES = [
  ['sherman', 'Sherman', 'CT'], ['new fairfield', 'New Fairfield', 'CT'], ['new milford', 'New Milford', 'CT'],
  ['brookfield', 'Brookfield', 'CT'], ['danbury', 'Danbury', 'CT'], ['ridgefield', 'Ridgefield', 'CT'],
  ['kent', 'Kent', 'CT'], ['new preston', 'New Preston', 'CT'], ['washington', 'Washington', 'CT'],
  ['woodbury', 'Woodbury', 'CT'], ['roxbury', 'Roxbury', 'CT'], ['litchfield', 'Litchfield', 'CT'],
  ['torrington', 'Torrington', 'CT'], ['westport', 'Westport', 'CT'], ['katonah', 'Katonah', 'NY'],
  ['pawling', 'Pawling', 'NY'],
].map(([key, name, state]) => ({ key, name, state, slug: key.replace(/\s+/g, '-') }));

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');
const plain = (v) => String(v ?? '').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim();
const favKey = (e) => ((e.title || '') + '|' + (e.dateLabel || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const townKey = (t) => (t || '').replace(/,\s*(ct|ny|ma|connecticut|new york)\s*$/i, '').replace(/\s+/g, ' ').trim();
const stateOf = (t) => (/,\s*(ny|new york)\s*$/i.test(t || '') ? 'NY' : 'CT');
// Which core town page an event belongs to (longest key wins: "New Fairfield" before "Fairfield").
// County-level towns ("Litchfield County, CT") stay off town pages; they could be anywhere.
function townPageFor(e) {
  const t = norm(e.town);
  if (!t || /\bcounty\b/.test(t)) return null;
  let best = null;
  for (const tp of TOWN_PAGES) if (t.includes(tp.key) && (!best || tp.key.length > best.key.length)) best = tp;
  return best;
}

// Date/time parsing. Mirrors eventSchedule() in index.html (which builds the calendar buttons);
// keep the two in step. Wall-clock America/New_York; the year comes from lastUpdated so a
// December guide listing January events rolls over.
const MO = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function dataYearMonth(lastUpdated) {
  const m = /([A-Za-z]{3})\w*\s+\d{1,2},\s*(\d{4})/.exec(lastUpdated || '');
  return m ? { year: parseInt(m[2], 10), month: MO[m[1].toLowerCase()] } : { year: CURRENT_YEAR, month: CURRENT_MONTH };
}
function clock(h, m, mer) {
  h = parseInt(h, 10); m = m ? parseInt(m, 10) : 0;
  if (h > 12 || m > 59) return null;
  mer = (mer || '').toLowerCase().replace(/\./g, '');
  if (mer.startsWith('p') && h !== 12) h += 12;
  if (mer.startsWith('a') && h === 12) h = 0;
  return [h, m];
}
function parseTimes(t) {
  t = (t || '').replace(/\bnoon\b/i, '12:00PM');
  const R = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*[–—-]\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(t);
  if (R) {
    const endMer = R[6];
    let startMer = R[3];
    if (!startMer) startMer = (parseInt(R[1], 10) > parseInt(R[4], 10) && /^p/i.test(endMer)) ? 'am' : endMer;
    const start = clock(R[1], R[2], startMer), end = clock(R[4], R[5], endMer);
    if (start && end) return { start, end };
  }
  const S = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(t);
  if (S) { const start = clock(S[1], S[2], S[3]); if (start) return { start, end: null }; }
  return null;
}
function eventSchedule(e, ym) {
  const found = [...(e.dateLabel || '').matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})\b/gi)]
    .map((m) => [MO[m[1].slice(0, 3).toLowerCase()], parseInt(m[2], 10)]);
  if (!found.length) return null;
  const yr = found[0][0] < ym.month - 6 ? ym.year + 1 : ym.year;
  const start = new Date(Date.UTC(yr, found[0][0], found[0][1]));
  if (start.getUTCDate() !== found[0][1]) return null; // "Feb 31"
  let end = start;
  if (found.length > 1 && /[–—-]/.test(e.dateLabel)) {
    end = new Date(Date.UTC(yr, found[1][0], found[1][1]));
    if (end < start) end = new Date(Date.UTC(yr + 1, found[1][0], found[1][1]));
  }
  const multiDay = end.getTime() !== start.getTime();
  return { start, end, times: multiDay ? null : parseTimes(e.time) };
}
const p2 = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
// UTC offset of America/New_York on a given calendar day ("-04:00" in summer, "-05:00" in winter).
function nyOffset(d) {
  const noon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16));
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
    .formatToParts(noon).find((x) => x.type === 'timeZoneName').value; // "GMT-04:00"
  const m = /GMT([+-]\d{2}:\d{2})/.exec(tz);
  if (!m) throw new Error(`unexpected tz offset format: ${tz}`);
  return m[1];
}
const isoAt = (d, [h, m]) => `${isoDay(d)}T${p2(h)}:${p2(m)}:00${nyOffset(d)}`;

function eventJsonLd(e, ym) {
  const sc = eventSchedule(e, ym);
  if (!sc || !e.title) return null; // never guess a date
  const url = safeUrl(e.url) || safeUrl(e.sourceUrl);
  const town = townKey(e.town);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: plain(e.title),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: plain(e.venue) || town || 'Candlewood Lake area',
      address: { '@type': 'PostalAddress', addressLocality: town || undefined, addressRegion: stateOf(e.town), addressCountry: 'US' },
    },
    image: [OG_IMAGE],
  };
  if (sc.times) {
    ld.startDate = isoAt(sc.start, sc.times.start);
    if (sc.times.end) {
      const endDay = (sc.times.end[0] * 60 + sc.times.end[1] <= sc.times.start[0] * 60 + sc.times.start[1])
        ? new Date(sc.start.getTime() + 86400000) : sc.start; // 9PM–1AM ends the next day
      ld.endDate = isoAt(endDay, sc.times.end);
    }
  } else {
    ld.startDate = isoDay(sc.start);
    ld.endDate = isoDay(sc.end);
  }
  const desc = plain(e.desc);
  if (desc) ld.description = desc;
  if (url) ld.url = url;
  const label = e.priceLabel || '';
  const free = (e.priceType || '').toLowerCase() === 'free' || /\bfree\b/i.test(label);
  const dollars = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(label);
  const soldOut = (e.priceType || '').toLowerCase() === 'soldout' || /sold\s*out/i.test(label);
  if (free) {
    ld.isAccessibleForFree = true;
    ld.offers = { '@type': 'Offer', price: 0, priceCurrency: 'USD', availability: 'https://schema.org/InStock', ...(url && { url }) };
  } else if (dollars) {
    ld.offers = { '@type': 'Offer', price: Number(dollars[1]), priceCurrency: 'USD',
      availability: soldOut ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock', ...(url && { url }) };
  }
  return JSON.parse(JSON.stringify(ld)); // drops undefined fields
}
// JSON inside <script> must not be able to close the tag.
const ldScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

const scoreClass = (s) => (s >= 9 ? 'must' : s >= 7 ? 'great' : s >= 5 ? 'good' : 'ok');
function googleCalUrl(e, ym) {
  const sc = eventSchedule(e, ym);
  if (!sc) return '';
  const ymd = (d) => isoDay(d).replace(/-/g, '');
  let dates, timed = false;
  if (!sc.times) {
    dates = `${ymd(sc.start)}/${ymd(new Date(sc.end.getTime() + 86400000))}`;
  } else {
    timed = true;
    const [sh, sm] = sc.times.start;
    let endDay = sc.start, eh, em;
    if (sc.times.end) {
      [eh, em] = sc.times.end;
      if (eh * 60 + em <= sh * 60 + sm) endDay = new Date(sc.start.getTime() + 86400000);
    } else {
      const mins = sh * 60 + sm + 120;
      eh = Math.floor(mins / 60) % 24; em = mins % 60;
      if (mins >= 1440) endDay = new Date(sc.start.getTime() + 86400000);
    }
    dates = `${ymd(sc.start)}T${p2(sh)}${p2(sm)}00/${ymd(endDay)}T${p2(eh)}${p2(em)}00`;
  }
  const q = new URLSearchParams({ action: 'TEMPLATE', text: plain(e.title), dates,
    details: [plain(e.desc), safeUrl(e.url) || safeUrl(e.sourceUrl), `Found on Candlewood Lake Events · ${SITE}/`].filter(Boolean).join('\n\n'),
    location: [e.venue, e.town].filter(Boolean).join(', ') });
  if (timed) q.set('ctz', 'America/New_York');
  return `https://calendar.google.com/calendar/render?${q}`;
}

function townCard(e, ym) {
  const url = safeUrl(e.url), src = safeUrl(e.sourceUrl), cal = googleCalUrl(e, ym);
  const title = url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(plain(e.title))}</a>` : escHtml(plain(e.title));
  const when = [e.dateLabel, e.time, e.venue].filter(Boolean).map(plain).join(' · ');
  const price = (e.priceType === 'free' || /\bfree\b/i.test(e.priceLabel || '')) ? 'Free'
    : e.priceType === 'soldout' ? (e.priceLabel || 'Sold out') : (e.priceLabel || (e.priceType === 'paid' ? 'Ticketed' : ''));
  const tags = [e.type, price].filter(Boolean).map((t) => `<span>${escHtml(plain(t))}</span>`).join('');
  const links = [src ? `<a href="${escHtml(src)}" target="_blank" rel="noopener">${escHtml(plain(e.source) || 'Source')}</a>` : '',
    cal ? `<a href="${escHtml(cal)}" target="_blank" rel="noopener">Add to Google Calendar</a>` : ''].filter(Boolean).join('<span class="dot">·</span>');
  return `<article class="card" id="ev-${favKey(e)}">
      <div class="score s-${scoreClass(e.score)}">${Number(e.score).toFixed(1)}</div>
      <div class="body">
        <h3>${title}</h3>
        <p class="when">${escHtml(when)}</p>
        ${tags ? `<p class="tags">${tags}</p>` : ''}
        ${e.desc ? `<p class="desc">${escHtml(plain(e.desc))}</p>` : ''}
        ${links ? `<p class="links">${links}</p>` : ''}
      </div>
    </article>`;
}

const TOWN_CSS = `:root{color-scheme:dark;--bg:#0a1424;--surface:#13233d;--border:#26385a;--text:#f4ecdb;--soft:#cdd7e6;--muted:#93a4bd;--gold:#d4a24a;--gold-b:#e7c988;--aqua:#67d3c9}
*{box-sizing:border-box;margin:0;padding:0}
body{background:linear-gradient(180deg,#0a1424,#0f1d35) fixed;color:var(--text);font-family:Inter,-apple-system,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--gold)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:760px;margin:0 auto;padding:18px 16px;border-bottom:1px solid var(--border)}
.brand{font-family:'Playfair Display',serif;font-weight:700;font-size:18px;color:var(--text);text-decoration:none}
.back{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;text-decoration:none;white-space:nowrap}
main{max-width:760px;margin:0 auto;padding:30px 16px 20px}
.kicker{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--gold);font-weight:600}
h1{font-family:'Playfair Display',serif;font-size:clamp(30px,6vw,42px);line-height:1.12;font-weight:800;margin:8px 0 10px}
.sub{color:var(--muted);font-size:14px}
.rule{width:64px;height:2px;background:var(--gold);margin:22px 0 8px}
section{margin-top:26px}
section h2{font-family:'Playfair Display',serif;font-size:19px;font-weight:700;padding-bottom:8px;border-bottom:1px solid var(--border)}
.card{display:flex;gap:14px;padding:14px 2px;border-bottom:1px solid var(--border)}
.card:last-child{border-bottom:0}
.score{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#0b1424}
.s-must{background:linear-gradient(180deg,#e7c988,#d4a24a)}.s-great{background:var(--aqua)}.s-good{background:#93a4bd}.s-ok{background:#5c6f8a}
.body{min-width:0}
.card h3{font-size:16px;line-height:1.35;font-weight:600}
.card h3 a{color:var(--text);text-decoration:none}.card h3 a:hover{color:var(--gold-b)}
.when{font-size:13px;color:var(--muted);margin-top:2px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:7px 0 4px}
.tags span{font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:20px;color:var(--soft)}
.desc{font-size:13.5px;color:var(--soft);line-height:1.5;margin-top:4px}
.links{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;margin-top:6px}
.links a{text-decoration:none;font-weight:600}.links a:hover{text-decoration:underline}
.dot{color:var(--muted);margin:0 8px}
.empty{margin-top:24px;color:var(--soft)}
.cta{margin-top:34px;padding:22px;border:1px solid rgba(212,162,74,.38);border-radius:4px;background:linear-gradient(180deg,rgba(212,162,74,.10),rgba(212,162,74,.03))}
.cta h2{font-family:'Playfair Display',serif;font-size:21px;line-height:1.25;margin-bottom:14px}
.btn{display:inline-block;padding:11px 22px;background:linear-gradient(180deg,#e7c988,#d4a24a);color:#0b1424;text-decoration:none;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border-radius:2px}
.towns{margin-top:30px}
.towns h2{font-family:'Playfair Display',serif;font-size:16px;margin-bottom:8px}
.towns div{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px}
.towns a{text-decoration:none}.towns a:hover{text-decoration:underline}
footer{max-width:760px;margin:30px auto 0;padding:28px 16px 60px;border-top:1px solid var(--border);text-align:center;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted)}`;

function analyticsSnippet(gaId) {
  if (!/^G-[A-Z0-9]+$/.test(gaId || '')) return '';
  // Same self-exclude switch as the home page (?me=1 once per device).
  return `<script>try{if(localStorage.getItem('cle_exclude')!=='1'){var s=document.createElement('script');s.async=1;s.src='https://www.googletagmanager.com/gtag/js?id=${gaId}';document.head.appendChild(s);window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments)};gtag('js',new Date());gtag('config','${gaId}')}}catch(e){}</script>`;
}

function renderTownPage(tp, weeks, counts, obj, ym, gaId) {
  const total = weeks.reduce((a, w) => a + w.events.length, 0);
  const label = `${tp.name}, ${tp.state}`;
  const url = `${SITE}/towns/${tp.slug}/`;
  const top = weeks.flatMap((w) => w.events).sort((a, b) => b.score - a.score).slice(0, 3).map((e) => plain(e.title));
  const title = `Things to Do in ${label} This Weekend · Candlewood Lake Events`;
  let description = total
    ? `${total} upcoming event${total === 1 ? '' : 's'} in ${label}${top.length ? ': ' + top.join(', ') : ''}. Curated and updated daily.`
    : `Live music, festivals and things to do in ${label}, near Candlewood Lake. Curated and updated daily.`;
  if (description.length > 158) description = description.slice(0, 155).replace(/[\s,:;]+\S*$/, '') + '…';
  const events = weeks.flatMap((w) => w.events).map((e) => eventJsonLd(e, ym)).filter(Boolean);
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Candlewood Lake Events', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: label, item: url }] };
  const body = total
    ? weeks.map((w) => `<section>
    <h2>${escHtml(plain(w.title))}</h2>
    ${w.events.map((e) => townCard(e, ym)).join('\n    ')}
  </section>`).join('\n  ')
    : `<p class="empty">Nothing is listed in ${escHtml(tp.name)} right now. <a href="/">See everything happening around the lake →</a></p>`;
  const others = TOWN_PAGES.filter((t) => t.slug !== tp.slug)
    .map((t) => `<a href="/towns/${t.slug}/">${escHtml(t.name)}${counts[t.slug] ? ` (${counts[t.slug]})` : ''}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Candlewood Lake Events">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${escHtml(`Things to do in ${label}`)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${OG_IMAGE}">
<meta name="theme-color" content="#0a1424">
${ldScript([...events, breadcrumb])}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
<style>
${TOWN_CSS}
</style>
${analyticsSnippet(gaId)}
</head>
<body>
<header class="top"><a class="brand" href="/">Candlewood Lake Events</a><a class="back" href="/">Full guide →</a></header>
<main>
  <p class="kicker">Candlewood Lake · ${escHtml(tp.state === 'NY' ? 'New York' : 'Connecticut')}</p>
  <h1>Things to do in ${escHtml(label)}</h1>
  <p class="sub">${total ? `${total} upcoming event${total === 1 ? '' : 's'}` : 'Nothing listed right now'} · Updated ${escHtml(obj.lastUpdated)} · Scored for quality and distance from the lake</p>
  <div class="rule"></div>
  ${body}
  <aside class="cta">
    <h2>The week's best around the lake, in your inbox every Thursday.</h2>
    <a class="btn" href="/#subscribe">Get the weekly picks</a>
  </aside>
  <nav class="towns" aria-label="Events by town">
    <h2>More towns around the lake</h2>
    <div><a href="/">All towns</a>${others}</div>
  </nav>
</main>
<footer>Candlewood Lake Events · A curated local guide · <a href="/privacy.html">Privacy</a></footer>
</body>
</html>
`;
}

function renderTownNav(counts) {
  const links = TOWN_PAGES.map((t) => `<a href="/towns/${t.slug}/">${escHtml(t.name)}${counts[t.slug] ? ` (${counts[t.slug]})` : ''}</a>`).join('\n      ');
  return `<nav class="town-nav" aria-label="Events by town">
    <h2>Events by town</h2>
    <div class="town-nav-links">
      ${links}
    </div>
  </nav>`;
}

function renderSitemap(lastmod) {
  const urls = [`${SITE}/`, ...TOWN_PAGES.map((t) => `${SITE}/towns/${t.slug}/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${lastmod}</lastmod><changefreq>daily</changefreq></url>`).join('\n')}
</urlset>
`;
}

// Replace the content between a start marker (an HTML comment, through the end of its line)
// and an end marker. Throws if either is missing so a broken template fails the run.
function replaceRegion(file, startMarker, endMarker, inner) {
  const a = file.indexOf(startMarker);
  const b = file.indexOf(endMarker);
  if (a === -1 || b === -1 || b < a) throw new Error(`markers not found: ${startMarker.trim()}`);
  const from = file.indexOf('\n', a) + 1;
  const indent = (/^[ \t]*/.exec(file.slice(file.lastIndexOf('\n', b) + 1, b)) || [''])[0];
  return file.slice(0, from) + inner + '\n' + indent + file.slice(b);
}

// Build every generated artifact from the final data. Pure: returns strings, writes nothing.
function buildSite(obj, gaId) {
  const ym = dataYearMonth(obj.lastUpdated);
  const upcoming = (obj.weeks || []).map((w) => ({ title: w.title, events: (w.events || []).filter((e) => !e.isPast && typeof e.score === 'number') }));
  const all = upcoming.flatMap((w) => w.events);

  const homeLd = all.map((e) => eventJsonLd(e, ym)).filter(Boolean);
  const counts = {};
  for (const e of all) { const tp = townPageFor(e); if (tp) counts[tp.slug] = (counts[tp.slug] || 0) + 1; }

  const pages = TOWN_PAGES.map((tp) => {
    const weeks = upcoming
      .map((w) => ({ title: w.title, events: w.events.filter((e) => townPageFor(e) === tp).sort((a, b) => b.score - a.score) }))
      .filter((w) => w.events.length);
    return { slug: tp.slug, html: renderTownPage(tp, weeks, counts, obj, ym, gaId) };
  });

  // Validate before anyone writes: every JSON-LD block must parse, every page must be whole.
  const checkLd = (html, where) => {
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const parsed = JSON.parse(m[1]);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const ev of list.filter((x) => x['@type'] === 'Event')) {
        if (!ev.name || !ev.startDate || !ev.location || !ev.location.address) throw new Error(`incomplete Event in ${where}: ${ev.name}`);
      }
    }
  };
  const jsonld = ldScript(homeLd);
  checkLd(jsonld, 'home');
  for (const p of pages) {
    if (!/<title>[^<]+<\/title>/.test(p.html) || !p.html.trimEnd().endsWith('</html>')) throw new Error(`malformed town page ${p.slug}`);
    checkLd(p.html, p.slug);
  }
  const skipped = all.length - homeLd.length;
  return { jsonld, townNav: renderTownNav(counts), pages, sitemap: renderSitemap(todayISO), skipped, counts };
}

// Apply a built site: splice the generated regions into index.html's text, then write the
// town pages and sitemap. Returns the updated index.html text (the caller writes it).
function spliceSite(fileText, site) {
  let out = replaceRegion(fileText, JSONLD_START, JSONLD_END, site.jsonld);
  out = replaceRegion(out, TOWNNAV_START, TOWNNAV_END, '  ' + site.townNav);
  return out;
}
async function writeSitePages(site) {
  for (const p of site.pages) {
    await mkdir(`towns/${p.slug}`, { recursive: true });
    await writeFile(`towns/${p.slug}/index.html`, p.html);
  }
  await writeFile('sitemap.xml', site.sitemap);
}
const gaIdFrom = (fileText) => (/GA_MEASUREMENT_ID:\s*'([^']*)'/.exec(fileText) || [])[1] || '';

// `--maintain`: the free daily pass on days research doesn't run. No API call and no rescoring:
// roll the current EVENTS_DATA forward to today, then rebuild the generated site from it.
async function maintain() {
  const file = await readFile(INDEX, 'utf8');
  const s = file.indexOf(START), e = file.indexOf(END);
  if (s === -1 || e === -1) return fail('EVENTS_DATA markers not found in index.html');
  const blockStart = file.indexOf('\n', s) + 1;
  const block = file.slice(blockStart, e);
  const obj = JSON.parse(block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1));
  const { dropped, past, upcoming } = rollForward(obj);
  let site;
  try { site = buildSite(obj, gaIdFrom(file)); } catch (err) { return fail(`site generation failed: ${err.message}`); }
  const newBlock = `const EVENTS_DATA = ${JSON.stringify(obj, null, 2)};`;
  await writeSitePages(site);
  await writeFile(INDEX, spliceSite(file.slice(0, blockStart) + newBlock + '\n' + file.slice(e), site));
  console.log(`Maintenance (${todayLabel}): ${upcoming} upcoming, ${past} from yesterday kept as Past, ${dropped} finished dropped, ${obj.tonight.length} tonight.`);
  // A guide that is running dry means the weekly research has been failing; say so.
  if (upcoming < 15) await notifySlack(`Events maintenance (${todayLabel}): only ${upcoming} upcoming events left (research last ran ${obj.lastUpdated}).`);
}

// `--site-only`: rebuild the generated site from the CURRENT EVENTS_DATA, no API call, no
// rescoring. For template changes and for seeding the pages the first time.
async function siteOnly() {
  const file = await readFile(INDEX, 'utf8');
  const s = file.indexOf(START), e = file.indexOf(END);
  if (s === -1 || e === -1) return fail('EVENTS_DATA markers not found in index.html');
  const block = file.slice(file.indexOf('\n', s) + 1, e);
  const obj = JSON.parse(block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1));
  let site;
  try { site = buildSite(obj, gaIdFrom(file)); } catch (err) { return fail(`site generation failed: ${err.message}`); }
  const updated = spliceSite(file, site);
  await writeSitePages(site);
  await writeFile(INDEX, updated);
  console.log(`Site rebuilt: ${site.pages.length} town pages, ${JSON.parse(site.jsonld.replace(/^<script[^>]*>|<\/script>$/g, '')).length} events in JSON-LD (${site.skipped} skipped: unparseable dates).`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) return fail('ANTHROPIC_API_KEY not set');

  const file = await readFile(INDEX, 'utf8');
  const startIdx = file.indexOf(START);
  const endIdx = file.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return fail('EVENTS_DATA markers not found in index.html');
  const blockStart = file.indexOf('\n', startIdx) + 1; // content begins after the START comment line
  const existingBlock = file.slice(blockStart, endIdx).trim();

  const sourceList = SOURCES.map(([name, url]) => `- ${name}: ${url}`).join('\n');

  const prompt = `You maintain a curated local events guide for the Candlewood Lake area (Fairfield & Litchfield Counties, Connecticut). Today is ${todayLabel} (America/New_York).

Use the web_search and web_fetch tools to research CURRENT upcoming events (today through about 8 weeks out) around Candlewood Lake. First fetch and check these priority source calendars, then web_search each town and venue for current concerts, festivals, markets, and family events:
${sourceList}

Also search the towns directly: Sherman, New Fairfield, New Milford, Danbury, Brookfield, Ridgefield, Kent, Washington, Woodbury, Roxbury.

From Litchfield Magazine (litchfieldmagazine.com/things-to-do), include the BEST standout weekend picks even when they are a bit farther out in Litchfield County (e.g., Woodbury, Roxbury, Washington, Kent, New Milford, Litchfield, Torrington). Open the individual event pages as needed to confirm the venue, town, date, and time; omit any you cannot confirm.

RULES:
- Ground every event in a real source and set a real sourceUrl. Do NOT invent events, dates, times, or prices. Accuracy over volume — omit anything you cannot confirm.
- Quality over quantity — this is a curated guide, not a full calendar. SKIP routine no-draw filler: open-mic nights, generic recurring bar/restaurant background music with no following, tiny library storytimes, and similar. Include an event only if a discerning local would actually consider going.
- DO NOT MISS BIG ONE-OFF FESTIVALS, CONVENTIONS, AND FAN EVENTS. These are among the most valuable listings in the guide and the easiest to miss: they are usually absent from every town and venue calendar because an outside organizer runs them, so they live only on that organizer's own site, on Eventbrite, or in the local paper. They are also frequently branded under a name that does NOT contain the thing people know them by (a Gilmore Girls fan convention officially titled "A Weekend in the Life", for instance). For EACH town, web_search specifically for named festivals, conventions, fan events, fairs, and expos in the next 8 weeks - not just "events in <town>". A ticket price is NEVER a reason to skip an event with real draw.
- Every event must be today (${todayLabel}) or later; set isPast to false and leave the past[] array empty ([]).
- STAY LOCAL: this is a Candlewood Lake guide, roughly a 25-mile radius. Do NOT include events in Norfolk, Hartford, Woodbridge, New Haven, Waterbury, Bridgeport, Stamford, Norwalk, or anywhere ~30+ minutes away, no matter how good the act. Farthest acceptable towns: Litchfield, Torrington, Woodbury, Kent, Katonah/Caramoor, Pawling, plus Levitt Pavilion in Westport (free outdoor concerts) as a deliberate exception.
- HOMETOWN COVERAGE IS A PRIORITY: Sherman and New Fairfield are the closest towns and matter most. ALWAYS fetch their community calendars (shermanct.gov community-events page, newfairfield.org community calendar) and the Sherman Playhouse / Sherman Players, and include every qualifying event you find there (live music, theater, comedy, festivals, markets, carnivals). Do not skip a town just because it's small. Tag each event with the town it physically takes place in — the Sherman Players / Sherman Playhouse is "Sherman, CT", not the venue's mailing town.
- DATES ARE CRITICAL — do not guess. Only include an event on a date you can confirm from a source for THIS year (${CURRENT_YEAR}). Its dateLabel weekday MUST match the real weekday of that calendar date in ${CURRENT_YEAR} (e.g., if unsure, omit rather than guess).
- Do NOT carry a recurring series' PRIOR-YEAR date forward (e.g. a summer concert series, "Rock the Block," farmers markets). If only last year's schedule is published and this year's specific date isn't confirmed, OMIT the event. Never reuse a ${CURRENT_YEAR - 1} date and relabel it ${CURRENT_YEAR}.
- Recompute isTonight and rebuild tonight[]; every tonight[] entry MUST have a real name, venue, and time (omit any you cannot fill completely).
- Set "lastUpdated" to "${todayLabel}".
- Rate each event with a "funQuality" number from 0 to 10, rounded to one decimal. Do NOT emit a "score" field and do NOT do any proximity arithmetic — this script computes score = Proximity*0.3 + funQuality*0.7 itself from the event's town. Your only job is the quality judgement. FunQuality (0-10) is how good/worth-it the event is on its own merits, independent of how close it is. Use a sensible spread — do not cluster everything at 7+, but do NOT bury good events either. Guide: 9-10 standout/marquee (major touring act, acclaimed festival); 7.5-8.5 genuinely good; 6-7 solid and worth-it (most established local concerts, town festivals, and markets with real draw — many vendors, live music, food — belong here); 5-6 ordinary; below 5 ONLY for weak or very niche events with little general appeal. A jazz/music festival, a well-attended community festival, or a popular market is NOT a 2-4.
- Live music is the heart of this guide. When you find a live-music act, web_search the artist/band BEFORE scoring and look hard for concrete signals of their DRAW: social following (Facebook/Instagram likes), notable venues played (Mohegan Sun / Foxwoods, casino showrooms, theaters, major festivals), national acts they have opened for, chart or press mentions, and review sentiment. Then set FunQuality by tier based on what the research shows:
    - National touring headliner, GRAMMY/charting/critically acclaimed artist: 9-10
    - Established regional act OR a popular tribute/cover band with a real following — e.g. thousands of fans, plays casinos/theaters/large festivals, has opened for or charted alongside national acts, or is a recognized local favorite: 7.5-8.5
    - Genuine local bar/pickup band, open mic, or an act with little or no public profile: 6-7.5
  IMPORTANT: a band being a "cover" or "tribute" act does NOT by itself put it in the bottom tier — judge it by its draw. Many Connecticut tribute/cover bands pack casino venues or headline town concerts and belong at 7.5-8.5. Do NOT underrate a popular regional band, and do NOT underrate a nationally known act just because the room is small. Only drop an act to 6-7.5 if the research genuinely turns up little following. Live music is a priority, so a well-regarded act should surface near the top.
- Keep the daryls[] quick-reference list current from the Daryl's House content.
- COVER A FULL 8 WEEKS: build about 8 consecutive weekly buckets in weeks[] (Week 1 = this week, through ~8 weeks out). Do NOT stop at 5 weeks just because the current block below has fewer. The later weeks (6-8) will be sparser and that is fine, but create them and include every confirmed event you find that far out; an under-populated late week is OK, a missing one is not.

Reproduce the EXACT schema and field names of the CURRENT block below (but extend weeks[] to ~8 weeks as above), with ONE deliberate change: replace each event's "score" field with "funQuality" as described above. If the current block still shows "score" on its events, that is the old format — emit "funQuality" instead, never both.

CURRENT BLOCK:
${existingBlock}

When you have finished researching, your FINAL message must be ONLY the updated EVENTS_DATA as a single pure JSON object (double-quoted keys, no JS, no comments, no code fences, no commentary).`;

  let data;
  try {
    data = await research(prompt);
  } catch (e) {
    return fail(`Anthropic request failed: ${e.message}`);
  }
  if (data.stop_reason === 'refusal') return fail('model refused the request');

  let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text.startsWith('{')) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) text = text.slice(a, b + 1);
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    console.error('parse failure — stop_reason:', data.stop_reason, '| len:', text.length, '| head:', text.slice(0, 200), '| tail:', text.slice(-200));
    return fail(`model did not return valid JSON (stop_reason=${data.stop_reason}, len=${text.length}): ${e.message}`);
  }
  if (!obj || !Array.isArray(obj.weeks) || typeof obj.lastUpdated !== 'string') {
    return fail('generated JSON missing required shape (weeks[], lastUpdated)');
  }
  for (const k of ['tonight', 'past', 'daryls']) if (!Array.isArray(obj[k])) obj[k] = [];

  // Drop events that: (a) have a stated weekday that doesn't match the real weekday of that
  // date this year (guards guessed/stale prior-year dates), (b) are suppressed titles, or
  // (c) are outside the ~25 mi lake radius (Norfolk, Hartford, Westport, etc.).
  let droppedDates = 0, droppedFar = 0;
  const drop = e => {
    if (isExcludedTown(e)) { droppedFar++; return true; }
    return badWeekday(e) || suppressed(e);
  };
  for (const w of obj.weeks) { const n = w.events.length; w.events = w.events.filter(e => !drop(e)); droppedDates += n - w.events.length; }
  obj.tonight = obj.tonight.filter(e => !drop(e));
  if (droppedDates) console.log(`Dropped ${droppedDates} event(s): ${droppedFar} out-of-radius, rest mismatched/unconfirmed dates.`);

  // ---- Scoring. Every stage here adjusts funQuality ONLY; bakeScores applies the
  // formula once at the end. See the SCORING INVARIANT note above before adding a stage.
  let ratings = {};
  try { ratings = JSON.parse(await readFile(RATINGS_PATH, 'utf8')); } catch { /* no cache yet */ }
  const scored = [...obj.weeks.map(w => w.events), obj.tonight];

  for (const evs of scored) {
    ingestFq(evs);                        // normalize onto funQuality (accepts legacy score)
    applyResearchedScores(evs, ratings);  // researched quality beats the model's guess
  }

  // Research anything still claiming 9.0+ without evidence, then fold the results in so
  // this run already benefits. Non-fatal: on failure the gate below caps those claims.
  let ratingsAdded = 0;
  const candidates = collectResearchCandidates(obj, ratings);
  if (candidates.length) {
    const batch = candidates.slice(0, MAX_RESEARCH_PER_RUN);
    if (candidates.length > batch.length) {
      console.log(`Act research: ${candidates.length} unresearched 9.0+ claims, researching ${batch.length} this run (rest next run).`);
    }
    try {
      const records = await researchActs(batch);
      ratingsAdded = mergeRatings(ratings, records);
      if (ratingsAdded) {
        await writeFile(RATINGS_PATH, JSON.stringify(ratings, null, 2) + '\n');
        console.log(`Act research: added ${ratingsAdded} act(s) to ${RATINGS_PATH} (cache now ${Object.keys(ratings).length}).`);
      }
      for (const evs of scored) applyResearchedScores(evs, ratings); // apply the fresh research
    } catch (err) {
      console.error(`Act research failed (non-fatal, claims will be capped): ${err.message}`);
    }
  }

  let capped = 0;
  for (const evs of scored) {
    applyQualityCurve(evs);               // spread (disabled at GAMMA=1.0)
    applyBandFloors(evs);                 // Vik's hard floors for known-strong acts
    applyFqFloor(evs);                    // sanity floor against the model's volatile lows
    normalizeCommunityFree(evs);          // tag inherently-free community events before valuing
    applyValueAdj(evs);                   // free/cheap lifts quality, pricey trims it
    capped += applyEvidenceGate(evs, ratings); // LAST: 9.0+ without sources drops to 8.5
    bakeScores(evs);                      // score = prox*0.3 + funQuality*0.7, exactly once
  }
  if (capped) console.log(`Evidence gate: capped ${capped} unevidenced 9.0+ claim(s) at ${EVIDENCE_CAP}.`);

  injectPinned(obj); // add hand-confirmed events (correct dates) after scoring
  const carried = carryYesterday(obj, existingBlock); // keep yesterday's events one more day
  if (carried) console.log(`Carried ${carried} event(s) from yesterday (visible one more day, tagged Past).`);
  rollForward(obj); // same week buckets, Past tags and tonight[] as the daily --maintain pass
  const count = obj.weeks.reduce((a, w) => a + (Array.isArray(w.events) ? w.events.length : 0), 0);
  if (count === 0) return fail('generated JSON has zero events — refusing to publish an empty guide');

  // Fail closed on a broken invariant rather than publishing an out-of-range score.
  const violations = scoreViolations(obj);
  if (violations.length) {
    return fail(`${violations.length} event(s) violate the scoring invariant — ${violations.slice(0, 3).join('; ')}`);
  }

  const researchNote = ratingsAdded ? ` +${ratingsAdded} act(s) researched` : '';
  const gated = capped ? `, ${capped} unevidenced claim(s) capped` : '';

  // Build (and validate) the generated site before writing anything — fail closed.
  let site;
  try { site = buildSite(obj, gaIdFrom(file)); } catch (err) { return fail(`site generation failed: ${err.message}`); }
  if (site.skipped) console.log(`JSON-LD: skipped ${site.skipped} event(s) with unparseable dates.`);

  const newBlock = `const EVENTS_DATA = ${JSON.stringify(obj, null, 2)};`;
  if (newBlock.trim() === existingBlock) {
    console.log(`No changes. Spent ${spendLine()}`);
    await notifySlack(`Weekly events research (${todayLabel}): no changes.${researchNote} Spent ${spendLine()}.`);
    return;
  }

  const updated = spliceSite(file.slice(0, blockStart) + newBlock + '\n' + file.slice(endIdx), site);
  await writeSitePages(site);
  await writeFile(INDEX, updated);

  console.log(`Updated: ${count} events across ${obj.weeks.length} weeks. Spent ${spendLine()}`);
  await notifySlack(`Weekly events research (${todayLabel}): ${count} events across ${obj.weeks.length} weeks published${researchNote}${gated}. Spent ${spendLine()}.`);
}

const mode = process.argv.includes('--site-only') ? siteOnly : process.argv.includes('--maintain') ? maintain : main;
mode().catch((e) => fail(e.message));
