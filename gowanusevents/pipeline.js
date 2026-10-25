// Gowanus Events: scoring pipeline. Pure functions over config.js + data.js, shared by the
// page and by scripts/refresh-gowanus.mjs (which runs it as a pre-publish check).
//
// Same invariant as the Candlewood site: every stage adjusts `fq` (0-10) only, and the bake
// derives `score = proximity * 0.3 + fq * 0.7` exactly once at the end.

const VENUES = { ...DATA.venues, ...CURATED_VENUES }; // curated entries win
const RESEARCH = DATA.research || {};
const ONGOING = DATA.ongoing || [];
const RAW = (DATA.raw || []).concat(PINNED);
const SNAPSHOT = DATA.snapshot;

const WALK_M_PER_MIN = 80;      // ~3 mph
const DETOUR = 1.3;             // street grid vs straight line
const MAX_WALK_MIN = 20;        // geofence
const PROX_BANDS = [[5, 10], [10, 9], [15, 8], [20, 6.5]]; // [max minutes, proximity]
const DECAY = { 'one-off': 0, limited: -0.2, monthly: -0.5, '2x-month': -1.0, weekly: -1.5 };
// Lower than Candlewood's 9.0 / 8.5. Nearly every venue here is proximity 10, so score =
// 3 + 0.7 x quality, and an unresearched 8.5 bakes to 8.95, which rounds to a gold 9.0.
// Gating at 8.6 and capping at 8.4 (bakes to 8.9) keeps the 9+ tier evidenced.
const EVIDENCE_MIN = 8.6, EVIDENCE_CAP = 8.4;
const TOP_PER_WEEK = 10, MAX_PER_VENUE_PER_WEEK = 3;
const TRUST = { curated: 4, venue: 3, institution: 2, aggregator: 1 };

const round1 = (x) => Math.round(x * 10) / 10;
const clampFq = (x) => Math.max(0, Math.min(10, x));
const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const srcOf = (k) => SOURCES[k] || SOURCES.web;

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

// Distance from a point to the canal centerline, in meters (local equirectangular projection).
function canalMeters(lat, lon) {
  const kx = 111320 * Math.cos(40.675 * Math.PI / 180), ky = 110540;
  const P = [lon * kx, lat * ky];
  let best = Infinity;
  for (let i = 0; i < CANAL.length - 1; i++) {
    const A = [CANAL[i][1] * kx, CANAL[i][0] * ky], B = [CANAL[i + 1][1] * kx, CANAL[i + 1][0] * ky];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy));
  }
  return best;
}
const walkMinutes = (v) => canalMeters(v.lat, v.lon) * DETOUR / WALK_M_PER_MIN;
function proximity(min) {
  for (const [max, p] of PROX_BANDS) if (min <= max) return p;
  return null;
}

// Display categories. The refresh asks the model for one; hand-extracted and pinned events
// may not carry it, so fall back to the event type.
const CATEGORIES = [
  ['music', 'Music'], ['comedy', 'Comedy'], ['community', 'Community & Festivals'],
  ['arts', 'Arts & Talks'], ['nightlife', 'Nightlife'], ['other', 'Other'],
];
function catOf(e) {
  if (e.cat && CATEGORIES.some(([k]) => k === e.cat)) return e.cat;
  const t = (e.type || '').toLowerCase();
  if (/festival|parade|fair|block party|market|community|volunteer|cleanup|clean-up|tour|longest table|open studios|family|kids/.test(t)) return 'community';
  if (/club|dj|dance party|halloween party/.test(t)) return 'nightlife';
  if (/comedy|storytell|podcast|burlesque|game show|talk show|improv/.test(t)) return 'comedy';
  if (/music|concert|jazz|band|session|listening|orchestra|recital/.test(t)) return 'music';
  if (/talk|book|reading|exhibition|film|screening|workshop|lecture|art/.test(t)) return 'arts';
  return 'other';
}

// Quality floors (guard against the model's volatile lows). Applied before recurrence decay
// so the decay still bites: an open mic floored to 5.0 still drops 1.5 for being weekly.
function typeFloor(e) {
  const t = (e.type || '').toLowerCase();
  if (/festival|parade|street fair|block party|open studios|longest table/.test(t)) return 7.0; // marquee neighborhood events
  if (/market|fair|community dinner|canoe|boat/.test(t)) return 6.0;
  if (catOf(e) === 'music' || /music|concert|club|dj|jazz|band|dance|listening/.test(t)) return 5.5;
  if (/comedy|storytell|podcast|talk|book|reading|film|screening|burlesque|exhibition/.test(t)) return 5.0;
  return 4.5;
}
// Inherently free neighborhood events (parades, street fairs, block parties, community
// dinners) read as Free unless the source names a price, so they get the free-value boost.
function normalizeCommunityFree(e) {
  if (!e.price && /parade|street fair|block party|longest table|community dinner|clean-?up/i.test(`${e.type} ${e.title}`)) e.price = 'free';
}
// NYC price bands, in quality points. Unknown price is neutral.
function valueAdj(e) {
  if (e.price === 'free') return 0.6;
  const m = /\$(\d+)/.exec(e.price || '');
  if (!m) return 0;
  const d = +m[1];
  if (d <= 20) return 0.3;
  if (d <= 40) return 0;
  if (d <= 75) return -0.3;
  return -0.7;
}
function researchFor(e) {
  const act = norm(e.act);
  if (act && RESEARCH[act]) return { key: act, ...RESEARCH[act] };
  const t = norm(e.title);
  for (const [k, rec] of Object.entries(RESEARCH)) if (t.includes(k)) return { key: k, ...rec };
  return null;
}
const hasEvidence = (rec) => !!rec && Array.isArray(rec.sources) && rec.sources.length > 0 && rec.confidence !== 'low';

// Dedupe: same date + venue, and the smaller title's significant words are (nearly) all
// in the larger one. Aggregators decorate titles ("– Brooklyn", "New York Comedy Festival:").
const STOP = new Set('the a an and w with presents present brooklyn nyc new york comedy festival live of at in ft feat lpr'.split(' '));
const sigWords = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
function sameEvent(a, b) {
  if (a.d !== b.d || a.v !== b.v) return false;
  const A = sigWords(a.title), B = sigWords(b.title);
  const [s, l] = A.size <= B.size ? [A, B] : [B, A];
  if (!s.size) return false;
  let hit = 0; for (const w of s) if (l.has(w)) hit++;
  return hit / s.size >= 0.85;
}

function seriesKey(e) {
  return e.v + '|' + norm(e.series || e.title.replace(/\b\d+(st|nd|rd|th)?\b/gi, ''));
}

function runPipeline(today) {
  const R = { today, raw: RAW.length, dropped: [], nearby: [], merges: [], gated: [], past: 0, violations: [] };
  const trace = (e, stage, to, note) => { e.trace.push({ stage, from: e.fq, to, note }); e.fq = to; };

  // Hard filters.
  const kept = [];
  for (const r of RAW) {
    const e = { ...r, venue: r.v ? VENUES[r.v] : null, trace: [], alsoOn: [] };
    if (e.d < today) { R.past++; continue; }
    if (e.private) { R.dropped.push({ e, reason: 'Private event' }); continue; }
    if (e.umbrella) { R.dropped.push({ e, reason: 'Festival pass listing, not a discrete event' }); continue; }
    if (e.dateUnconfirmed) { R.dropped.push({ e, reason: 'Source shows no year. Dropped rather than guessed' }); continue; }
    if (!e.venue) { R.dropped.push({ e, reason: `Venue address unknown (${e.venueName || 'unnamed'}), so distance can't be computed` }); continue; }
    e.walk = walkMinutes(e.venue);
    if (e.walk > MAX_WALK_MIN) { R.dropped.push({ e, reason: `Outside the ${MAX_WALK_MIN}-minute walk (${Math.ceil(e.walk)} min)` }); continue; }
    if (e.venue.mega) { R.nearby.push(e); continue; }
    if (e.soldOut) { R.dropped.push({ e, reason: 'Sold out' }); continue; }
    e.cat = catOf(e);
    kept.push(e);
  }
  R.afterFilter = kept.length;

  // Dedupe. The higher-trust source is canonical; time conflicts are recorded.
  const evs = [];
  for (const e of kept) {
    const twin = evs.find((x) => sameEvent(x, e));
    if (!twin) { evs.push(e); continue; }
    const [keep, drop] = TRUST[srcOf(e.src).kind] > TRUST[srcOf(twin.src).kind] ? [e, twin] : [twin, e];
    if (keep !== twin) evs[evs.indexOf(twin)] = keep;
    keep.alsoOn.push(drop.src, ...drop.alsoOn);
    if (!keep.blurb && drop.blurb) keep.blurb = drop.blurb;
    if (!keep.price && drop.price) keep.price = drop.price;
    R.merges.push({ keep, drop, conflict: keep.t && drop.t && keep.t !== drop.t ? `Time differs: ${srcOf(keep.src).name} says ${keep.t}, ${srcOf(drop.src).name} says ${drop.t}. ${srcOf(keep.src).name} wins.` : '' });
  }
  R.afterDedupe = evs.length;

  // Recurrence: the source's stated cadence wins; otherwise count the series.
  const groups = new Map();
  for (const e of evs) { const k = seriesKey(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  for (const g of groups.values()) {
    g.sort((a, b) => a.d.localeCompare(b.d));
    for (const e of g) {
      if (e.cadence) e.pattern = e.cadence;
      else if (g.length === 1) e.pattern = 'one-off';
      else if (g.length <= 3) e.pattern = 'limited';
      else {
        const gap = (new Date(g[g.length - 1].d) - new Date(g[0].d)) / 864e5 / (g.length - 1);
        e.pattern = gap <= 8 ? 'weekly' : gap <= 20 ? '2x-month' : 'monthly';
      }
      e.seriesCount = g.length;
    }
  }

  // Scoring.
  for (const e of evs) {
    e.fq0 = e.fq = clampFq(+e.fq || 0);
    const rec = researchFor(e);
    if (rec) { e.research = rec; trace(e, 'Researched act', rec.fq, rec.basis); }
    if (e.venue.tier && e.fq < e.venue.tier) trace(e, 'Venue floor', e.venue.tier, `${e.venue.name} books reliably`);
    const tf = typeFloor(e);
    if (e.fq < tf) trace(e, 'Type floor', tf, `Minimum for "${e.type}"`);
    const dec = DECAY[e.pattern] || 0;
    if (dec) trace(e, 'Recurrence', clampFq(e.fq + dec), patternLabel(e));
    normalizeCommunityFree(e);
    const va = valueAdj(e);
    if (va) trace(e, 'Value', clampFq(e.fq + va), e.price === 'free' ? 'Free' : e.price);
    // Hand-added events count as evidence, like Candlewood's BAND_FLOORS: curated with a reason.
    if (e.fq >= EVIDENCE_MIN && !hasEvidence(e.research) && srcOf(e.src).kind !== 'curated') {
      R.gated.push({ e, claimed: e.fq });
      trace(e, 'Evidence gate', EVIDENCE_CAP, `A ${EVIDENCE_MIN}+ claim with no research record`);
    }
    e.fq = round1(e.fq);
    e.prox = proximity(e.walk);
    e.score = round1(e.prox * 0.3 + e.fq * 0.7);
    if (e.score > e.prox * 0.3 + 7 + 0.051) R.violations.push(e);
  }

  // Display rule: a weekly series shows in the feed once per calendar month (first date);
  // the rest live on the Every Week tab.
  const seenMonth = new Set();
  for (const e of [...evs].sort((a, b) => a.d.localeCompare(b.d))) {
    if (e.pattern !== 'weekly') continue;
    const k = seriesKey(e) + '|' + e.d.slice(0, 7);
    if (seenMonth.has(k)) e.collapsed = true; else seenMonth.add(k);
  }

  R.events = evs;
  R.feed = evs.filter((e) => !e.collapsed);
  R.series = [...groups.values()].filter((g) => g[0].pattern === 'weekly');
  return R;
}

function patternLabel(e) {
  if (e.pattern === 'limited') return `${e.seriesCount}-date run`;
  if (e.cadenceLabel) return `Recurring (${e.cadenceLabel})`;
  return { weekly: 'Weekly', '2x-month': 'Twice a month', monthly: 'Monthly' }[e.pattern] || '';
}
